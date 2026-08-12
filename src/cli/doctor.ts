/**
 * `tiktok-mcp-ai doctor` — the offline + online health check (README § "Verify
 * your setup", ARCHITECTURE.md § 2, TASK-BREAKDOWN TC-3).
 *
 * This module owns **the check-list**: {@link DOCTOR_CHECKS} is the ordered set
 * of health checks, and a later task that wants to add one registers a
 * {@link Check} here instead of rewriting the runner. Every check answers with
 * {@link Finding}s rather than printing, so the rendering, the tally and the
 * exit code are decided in exactly one place.
 *
 * Design notes:
 *
 * - **Only a `fail` is fatal.** README documents `doctor` as a CI/readiness
 *   gate, and a gate that trips on "TT_MEDIA_ROOT is not set" is a gate nobody
 *   keeps. Warnings are for what works today and will not tomorrow.
 * - **One check never aborts the rest.** A check that throws becomes a `fail`
 *   row of its own and the remaining checks still run — the whole value of this
 *   command is the *complete* picture, especially when something is broken.
 * - **Findings print as each check finishes**, so the CC-F3 "fix it now?"
 *   prompt appears under the row that motivated it rather than after the report.
 * - **Nothing secret is printed.** Only a masked `open_id`, scope names,
 *   expiries and paths ever reach a row — and `cliIo` redacts on top of that.
 * - **The scope matrix is derived from the live manifest** (`allTools()` and the
 *   `scopes` each spec declares) instead of from a third copy of the package →
 *   scope table: doctor reports which *registered tools* the profile cannot run,
 *   which stays honest while packages are still filling in.
 */

import { chmod, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { createApiContext, maskOpenId } from '../api/context.js';
import { getUserInfo } from '../api/user.js';
import { systemClock, type Clock } from '../core/clock.js';
import {
  CONFIG_SCHEMA_VERSION,
  listProfiles,
  normalizeProfileName,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
  type EnvFileSnapshot,
  type ProfileCredentials,
} from '../core/config.js';
import { envLockDir } from '../core/env-lock.js';
import { isTikTokError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import {
  DEFAULT_PROFILE,
  loadSettings,
  resolveEnabledPackages,
  type Settings,
} from '../core/settings.js';
import { allTools } from '../tools/index.js';
import {
  cliIo,
  CLI_NAME,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  overlayEnvFile,
  type CliDeps,
  type CliIo,
} from './index.js';

// ---------------------------------------------------------------------------
// findings
// ---------------------------------------------------------------------------

/**
 * How much a finding matters. Only `fail` changes the exit code: `warn` is for
 * something that works now and will stop working, `info` for a fact worth
 * stating, `ok` for a check that passed.
 */
export type Severity = 'ok' | 'info' | 'warn' | 'fail';

export interface Finding {
  readonly severity: Severity;
  /** One line of prose; the renderer prefixes it with the check's title. */
  readonly text: string;
  /** The command or edit that resolves it, printed under the row. */
  readonly remediation?: string;
}

function finding(severity: Severity, text: string, remediation?: string): Finding {
  return remediation === undefined ? { severity, text } : { severity, text, remediation };
}

const ok = (text: string, remediation?: string): Finding =>
  finding('ok', text, remediation);
const info = (text: string, remediation?: string): Finding =>
  finding('info', text, remediation);
const warn = (text: string, remediation?: string): Finding =>
  finding('warn', text, remediation);
const fail = (text: string, remediation?: string): Finding =>
  finding('fail', text, remediation);

/** A thrown `TikTokError` already carries its own remediation; anything else does not. */
function findingFromError(err: unknown): Finding {
  if (isTikTokError(err)) {
    return err.remediation === undefined
      ? fail(err.message)
      : fail(err.message, err.remediation);
  }
  return fail(err instanceof Error ? err.message : String(err));
}

function hasCode(err: unknown, code: string): boolean {
  return isTikTokError(err) && err.code === code;
}

// ---------------------------------------------------------------------------
// the check contract
// ---------------------------------------------------------------------------

/** Everything the checks read, resolved once before the first one runs. */
export interface DoctorContext {
  readonly deps: CliDeps;
  readonly io: CliIo;
  readonly platform: NodeJS.Platform;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The resolved env-file path — the read source and the write target. */
  readonly envFilePath: string;
  readonly snapshot: EnvFileSnapshot;
  /** Env file first, process environment on top (CC-F2) — what everything reads. */
  readonly env: NodeJS.ProcessEnv;
  /** `undefined` when `loadSettings` rejected the environment (CC-F6). */
  readonly settings?: Settings;
  readonly settingsError?: unknown;
  /** The profile every per-profile check reports on. */
  readonly profile: string;
  /** {@link profile}'s record, or the reason it could not be read. */
  readonly credentials?: ProfileCredentials;
  readonly credentialsError?: unknown;
  /** `--offline`: no check may touch the network. */
  readonly offline: boolean;
}

/**
 * One health check. `id` is stable — it is what a bug report quotes — and
 * `title` prefixes every row the check produces.
 */
export interface Check {
  readonly id: string;
  readonly title: string;
  run(ctx: DoctorContext): Promise<readonly Finding[]>;
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** CC-A5: the horizon at which a still-valid refresh token becomes a warning. */
const REFRESH_WARN_MS = 30 * DAY;

function unit(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= DAY) return unit(Math.round(abs / DAY), 'day', 'days');
  if (abs >= HOUR) return unit(Math.round(abs / HOUR), 'hour', 'hours');
  if (abs >= MINUTE) return unit(Math.round(abs / MINUTE), 'minute', 'minutes');
  return unit(Math.round(abs / SECOND), 'second', 'seconds');
}

/** `in 12 days` / `3 hours ago`, from a signed delta against now. */
function relative(deltaMs: number): string {
  return deltaMs >= 0 ? `in ${humanDuration(deltaMs)}` : `${humanDuration(deltaMs)} ago`;
}

/** A POSIX mode as the four octal digits `chmod` speaks. */
function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/** Paths are quoted so a copy-pasted remediation survives a space in the path. */
function quote(path: string): string {
  return JSON.stringify(path);
}

function describeError(error: unknown): string {
  if (isTikTokError(error)) {
    return error.remediation === undefined
      ? error.message
      : `${error.message}\n${error.remediation}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The command every remediation tells the user to run for `profile`. */
function loginCommand(profile: string): string {
  return `npx ${CLI_NAME} login --profile ${profile}`;
}

// ---------------------------------------------------------------------------
// the check-list (TC-3 owns this; contribute by appending a Check)
// ---------------------------------------------------------------------------

const envFileCheck: Check = {
  id: 'env-file',
  title: 'env file',
  run: async (ctx) => {
    const findings: Finding[] = [
      ctx.snapshot.exists
        ? ok(`found at ${ctx.envFilePath}`)
        : // CC-F1: a missing file is legal — the process environment may carry
          // everything. It is still the first thing to know when nothing works.
          info(
            `no file at ${ctx.envFilePath}; configuration comes from the process environment only`,
            `Run ${loginCommand(ctx.profile)} to create it.`,
          ),
    ];
    // Duplicate keys, unknown `TT_*` keys, an unparseable TT_CONFIG_SCHEMA (CC-F1).
    for (const warning of ctx.snapshot.warnings) findings.push(warn(warning));
    return await Promise.resolve(findings);
  },
};

/**
 * CC-F3 — permissions drift.
 *
 * On POSIX any mode other than `0600` is a warning with a `chmod` remediation,
 * and on a terminal doctor offers to apply it. On Windows the mode is
 * meaningless (`chmod` is a no-op there), so the row is an info line carrying
 * the optional hardening command as **text**: the server never runs `icacls`
 * (CONFIGURATION.md § Permissions).
 */
const permissionsCheck: Check = {
  id: 'permissions',
  title: 'permissions',
  run: async (ctx) => {
    if (!ctx.snapshot.exists) return [];

    if (ctx.platform === 'win32') {
      return [
        info(
          'not checked on Windows; the file inherits the ACLs of your user profile',
          `Optional hardening: icacls ${quote(ctx.envFilePath)} /inheritance:r /grant:r "%USERNAME%":F`,
        ),
      ];
    }

    const mode = ctx.snapshot.mode;
    if (mode === undefined) return [];
    if ((mode & 0o777) === 0o600) return [ok(`mode ${octal(mode)}`)];

    const chmodLine = `chmod 600 ${quote(ctx.envFilePath)}`;
    const problem =
      `mode ${octal(mode)} — this file holds refresh tokens and is readable by ` +
      'other accounts on this machine';

    if (!ctx.io.isTTY) return [warn(problem, chmodLine)];

    const answer = await ask(ctx.deps, `${problem}\nFix it now with chmod 600? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) return [warn(problem, chmodLine)];
    try {
      await chmod(ctx.envFilePath, 0o600);
      return [ok(`mode fixed to 0600 (was ${octal(mode)})`)];
    } catch (err) {
      return [warn(`${problem}; the fix failed: ${describeError(err)}`, chmodLine)];
    }
  },
};

const schemaCheck: Check = {
  id: 'config-schema',
  title: 'config schema',
  run: async (ctx) => {
    const findings: Finding[] = [];
    const declared = ctx.snapshot.declaredSchema;
    if (declared !== undefined && declared > CONFIG_SCHEMA_VERSION) {
      // Reads stay best-effort, writes are refused (CONFIGURATION.md § Schema).
      findings.push(
        warn(
          `TT_CONFIG_SCHEMA=${String(declared)} was written by a newer version of this tool ` +
            `(this build understands ${String(CONFIG_SCHEMA_VERSION)}); reads still work, ` +
            'writes are refused',
          `npm install -g ${CLI_NAME}@latest`,
        ),
      );
    } else {
      findings.push(ok(`version ${String(ctx.snapshot.schema)}`));
    }

    const backups = await schemaBackups(ctx.envFilePath);
    if (backups.length > 0) {
      findings.push(
        info(
          `leftover pre-migration backup(s): ${backups.join(', ')}`,
          'They hold credentials from before a schema migration — delete them once you no longer need them.',
        ),
      );
    }
    return findings;
  },
};

/** `<envfile>.pre-schema<N>` siblings left behind by a migrating write. */
async function schemaBackups(envFilePath: string): Promise<string[]> {
  const prefix = `${basename(envFilePath)}.pre-schema`;
  try {
    const entries = await readdir(dirname(envFilePath));
    return entries.filter((entry) => entry.startsWith(prefix)).sort();
  } catch {
    // No directory, or no permission to list it — the env-file row already said
    // everything worth saying about that.
    return [];
  }
}

const settingsCheck: Check = {
  id: 'settings',
  title: 'settings',
  run: async (ctx) => {
    // CC-F6: `loadSettings` aggregates every bad `TT_*` variable into one error,
    // so this single row lists them all.
    if (ctx.settings === undefined) return [findingFromError(ctx.settingsError)];
    const settings = ctx.settings;
    const packages = resolveEnabledPackages(settings);
    if (packages.length === 0) {
      return [
        warn(
          'no tool package is enabled, so the server would expose no tools at all',
          'Widen TT_TOOL_PACKAGES (default: core), or shorten TT_PACKAGES_DENY.',
        ),
      ];
    }
    return await Promise.resolve([
      ok(
        `write mode ${settings.writeMode}, log level ${settings.logLevel}, ` +
          `packages ${packages.join(', ')}`,
      ),
    ]);
  },
};

/**
 * CC-F5 — a lock left behind by a crashed writer. `doctor` only reports it: the
 * next writer breaks a stale lock by itself, so there is nothing to repair here
 * and no reason to race that writer for the right to do it.
 */
const envLockCheck: Check = {
  id: 'env-lock',
  title: 'env lock',
  run: async (ctx) => {
    const lockDir = envLockDir(ctx.envFilePath);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(lockDir)).mtimeMs;
    } catch {
      return [ok('not held')];
    }
    // Liveness is mtime-only, never a PID (`core/env-lock`): a heartbeat that
    // stopped is the whole signal, and the holder file stays private to it.
    const staleMs = ctx.settings?.envLockStaleMs ?? 15_000;
    const age = ctx.clock.now() - mtimeMs;
    if (age > staleMs) {
      return [
        warn(
          `a stale lock has been held for ${humanDuration(age)} at ${lockDir}; its writer is ` +
            'gone and the next writer will break it',
          `If nothing is writing right now you may remove it: rm -rf ${quote(lockDir)}`,
        ),
      ];
    }
    return [
      info(
        `held right now (${humanDuration(age)} old) — a login or token refresh is running`,
      ),
    ];
  },
};

const credentialsCheck: Check = {
  id: 'app-credentials',
  title: 'app credentials',
  run: async (ctx) => {
    if (hasCode(ctx.credentialsError, 'missing_credentials')) {
      return [findingFromError(ctx.credentialsError)];
    }
    // Any other read failure belongs to the profiles or tokens row.
    if (ctx.credentials === undefined) return [];
    return await Promise.resolve([ok('TT_CLIENT_KEY and TT_CLIENT_SECRET are set')]);
  },
};

const profilesCheck: Check = {
  id: 'profiles',
  title: 'profiles',
  run: async (ctx) => {
    // CC-F4: TT_ACTIVE_PROFILE pointing at a profile that does not exist is a
    // hard error, and its message already lists the ones that do.
    if (hasCode(ctx.credentialsError, 'unknown_profile')) {
      return [findingFromError(ctx.credentialsError)];
    }
    const names = listProfiles(ctx.snapshot, ctx.env);
    const rows = names.map((name) => (name === ctx.profile ? `${name} (active)` : name));
    return await Promise.resolve([ok(rows.join(', '))]);
  },
};

const tokensCheck: Check = {
  id: 'tokens',
  title: 'tokens',
  run: async (ctx) => {
    // The credentials / profiles rows already carry the reason it is missing.
    if (ctx.credentials === undefined) return [];
    const credentials = ctx.credentials;
    if (credentials.refreshToken === undefined) {
      return [
        fail(
          `profile ${ctx.profile} has no stored token — it has never completed a login`,
          loginCommand(ctx.profile),
        ),
      ];
    }

    const findings: Finding[] = [];
    if (credentials.openId !== undefined) {
      findings.push(ok(`open_id ${maskOpenId(credentials.openId)}`));
    }

    const nowMs = ctx.clock.now();
    const refreshExpiresAt = credentials.refreshExpiresAt;
    if (refreshExpiresAt === undefined) {
      findings.push(
        warn(
          'no refresh-token expiry on record, so its remaining life is unknown',
          `Re-run ${loginCommand(ctx.profile)} to store one.`,
        ),
      );
    } else {
      // CC-A5: an expired refresh token is terminal and names the login command
      // — never a retry loop. Inside 30 days it is a warning, because a server
      // that stops working next month should say so this month.
      const delta = Date.parse(refreshExpiresAt) - nowMs;
      if (Number.isNaN(delta)) {
        findings.push(
          fail(
            `the stored refresh expiry ${refreshExpiresAt} is not a valid timestamp`,
            loginCommand(ctx.profile),
          ),
        );
      } else if (delta <= 0) {
        findings.push(
          fail(
            `the refresh token expired ${relative(delta)} (${refreshExpiresAt}); this server ` +
              'cannot renew it on its own',
            loginCommand(ctx.profile),
          ),
        );
      } else if (delta <= REFRESH_WARN_MS) {
        findings.push(
          warn(
            `the refresh token expires ${relative(delta)} (${refreshExpiresAt})`,
            `Re-run ${loginCommand(ctx.profile)} before then.`,
          ),
        );
      } else {
        findings.push(ok(`refresh token valid until ${refreshExpiresAt}`));
      }
    }

    const accessExpiresAt = credentials.accessExpiresAt;
    if (accessExpiresAt !== undefined) {
      const delta = Date.parse(accessExpiresAt) - nowMs;
      findings.push(
        Number.isNaN(delta) || delta > 0
          ? ok(`access token valid until ${accessExpiresAt}`)
          : // Not a problem: renewing it is exactly what the refresh flow does.
            info(
              `the access token expired ${relative(delta)}; it is renewed automatically on the next call`,
            ),
      );
    }
    return await Promise.resolve(findings);
  },
};

/**
 * Granted scopes vs. the tools the enabled packages actually register.
 *
 * Reported per *tool* rather than per package on purpose. The package → scope
 * table already exists twice (the login CLI asks for a wider set than the tools
 * require), so a third copy here would be a third thing to keep equal; and
 * reading the live manifest keeps the answer honest while packages are still
 * filling in — a package with no tools yet is reported as exactly that, never
 * as "ok".
 */
const scopesCheck: Check = {
  id: 'scopes',
  title: 'scopes',
  run: async (ctx) => {
    if (ctx.settings === undefined || ctx.credentials === undefined) return [];
    const granted = ctx.credentials.scopes ?? [];
    const enabled = new Set(resolveEnabledPackages(ctx.settings));
    const findings: Finding[] = [
      granted.length === 0
        ? warn(
            `profile ${ctx.profile} has no granted scopes on record`,
            loginCommand(ctx.profile),
          )
        : ok(`granted: ${granted.join(', ')}`),
    ];

    const tools = allTools().filter((spec) => enabled.has(spec.package));
    const blocked = tools.filter((spec) =>
      spec.scopes.some((scope) => !granted.includes(scope)),
    );
    if (blocked.length > 0) {
      const missing = [
        ...new Set(
          blocked.flatMap((spec) => spec.scopes.filter((s) => !granted.includes(s))),
        ),
      ];
      findings.push(
        warn(
          `${unit(blocked.length, 'tool stays', 'tools stay')} unavailable for want of ` +
            `${missing.join(', ')}: ${blocked.map((spec) => spec.name).join(', ')}`,
          `${loginCommand(ctx.profile)} --scopes ${[...granted, ...missing].join(',')}`,
        ),
      );
    } else if (tools.length > 0) {
      findings.push(
        ok(
          `all ${unit(tools.length, 'tool', 'tools')} of the enabled packages are usable`,
        ),
      );
    }

    // An enabled package that ships no tools in this build is a roadmap hole,
    // not a configuration mistake — but silence would read as "it works".
    const empty = [...enabled].filter(
      (pkg) => !tools.some((spec) => spec.package === pkg),
    );
    if (empty.length > 0) {
      findings.push(
        info(`enabled but not implemented in this build: ${empty.join(', ')}`),
      );
    }
    return await Promise.resolve(findings);
  },
};

/**
 * The one online check: a single `user/info` call with the cheapest field set.
 *
 * An auth-class rejection is the answer the user came for and fails the run.
 * A transport failure or a temporary upstream error is a warning instead — a
 * flaky network is not a broken installation, and failing CI over it would be.
 */
const probeCheck: Check = {
  id: 'api-probe',
  title: 'api probe',
  run: async (ctx) => {
    if (ctx.offline) return [info('skipped (--offline)')];
    if (ctx.settings === undefined || ctx.credentials === undefined) {
      return [info('skipped — the local configuration has to be fixed first')];
    }
    const granted = ctx.credentials.scopes ?? [];
    if (!granted.includes('user.info.basic')) {
      return [
        info(
          `skipped — profile ${ctx.profile} has not granted user.info.basic, so there is no ` +
            'read to probe with',
        ),
      ];
    }

    const api = createApiContext({
      profile: ctx.profile,
      settings: ctx.settings,
      log: ctx.logger,
      clock: ctx.clock,
      env: ctx.env,
    });
    try {
      const user = await getUserInfo(api, ['open_id', 'display_name']);
      const whose =
        user.display_name === undefined
          ? 'the stored token'
          : `${user.display_name}'s token`;
      return [ok(`TikTok accepted ${whose}`)];
    } catch (err) {
      if (isTikTokError(err) && err.kind === 'network') {
        return [
          warn(
            `could not reach TikTok: ${err.message}`,
            'This is a connectivity problem, not a credential one — try again.',
          ),
        ];
      }
      if (isTikTokError(err) && err.retryable) {
        return [
          warn(
            `TikTok answered with a temporary error: ${err.message}`,
            'Try again later.',
          ),
        ];
      }
      if (isTikTokError(err) && err.kind === 'auth') {
        return [fail(err.message, loginCommand(ctx.profile))];
      }
      return [findingFromError(err)];
    }
  },
};

const mediaRootCheck: Check = {
  id: 'media-root',
  title: 'media root',
  run: async (ctx) => {
    const root = ctx.settings?.mediaRoot;
    if (root === undefined) {
      return [
        info(
          'TT_MEDIA_ROOT is not set — file uploads stay disabled until it is',
          'Point it at a dedicated media folder (never at your home directory).',
        ),
      ];
    }
    try {
      const stats = await stat(root);
      if (!stats.isDirectory()) return [fail(`TT_MEDIA_ROOT=${root} is not a directory`)];
      return [ok(root)];
    } catch (err) {
      return [
        fail(
          `TT_MEDIA_ROOT=${root} cannot be read: ${describeError(err)}`,
          'Create the directory, or unset TT_MEDIA_ROOT to disable file uploads.',
        ),
      ];
    }
  },
};

/**
 * CC-E10 — a journal holding an intent without an outcome means a publish whose
 * fate is unknown, and reconciling those is doctor's job.
 *
 * The record schema lands with `mcp/journal.ts` (TD-3); until then this check
 * reports what it can see without inventing a format — that the file exists and
 * how large it is. TD-3 replaces this body; it does not add a second check.
 */
const journalCheck: Check = {
  id: 'publish-journal',
  title: 'publish journal',
  run: async (ctx) => {
    const path = join(dirname(ctx.envFilePath), 'journal.ndjson');
    try {
      const stats = await stat(path);
      return [
        info(
          `${path} — ${unit(stats.size, 'byte', 'bytes')}; intent/outcome reconciliation ` +
            'arrives with the publish tools',
        ),
      ];
    } catch {
      return [ok('no publish has been recorded yet')];
    }
  },
};

const transportCheck: Check = {
  id: 'transport',
  title: 'transport',
  run: async (ctx) => {
    const transport = ctx.settings?.transport;
    if (transport === undefined) return [];
    if (transport !== 'stdio') {
      // The bootstrap refuses to start on it (`src/index.ts`), so a report that
      // said nothing here would be a report that missed the actual problem.
      return [
        fail(
          `TT_TRANSPORT=${transport} is not implemented in this build, so the server would ` +
            'refuse to start',
          'Unset TT_TRANSPORT, or set it to stdio.',
        ),
      ];
    }
    return await Promise.resolve([ok('stdio')]);
  },
};

/**
 * The ordered check-list. Infrastructure first (where configuration comes from,
 * whether it is readable, whether it is valid), then identity, then the one
 * online call, then the runtime surface — so the first `fail` a reader hits is
 * the one that explains the rows below it.
 */
export const DOCTOR_CHECKS: readonly Check[] = Object.freeze([
  envFileCheck,
  permissionsCheck,
  schemaCheck,
  settingsCheck,
  envLockCheck,
  credentialsCheck,
  profilesCheck,
  tokensCheck,
  scopesCheck,
  probeCheck,
  mediaRootCheck,
  journalCheck,
  transportCheck,
]);

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

interface DoctorFlags {
  profile?: string;
  offline: boolean;
  help: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly flags: DoctorFlags }
  | { readonly ok: false; readonly message: string };

export function doctorUsage(): string {
  return [
    `Usage: ${CLI_NAME} doctor [options]`,
    '',
    'Options:',
    '  --profile <name>   profile to check (default: TT_ACTIVE_PROFILE, else DEFAULT)',
    '  --offline          skip the live TikTok probe and run the local checks only',
    '  -h, --help         show this help',
    '',
    'Exit codes: 0 = healthy (warnings allowed), 1 = a check failed, 2 = usage error.',
    '',
  ].join('\n');
}

/** Same grammar as `login`: `--flag value` and `--flag=value`; unknown is an error. */
export function parseDoctorArgs(argv: readonly string[]): ParseResult {
  const flags: DoctorFlags = { offline: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    let value: string | undefined;
    if (name === '--profile') {
      if (inline !== undefined) value = inline;
      else {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '') {
        return { ok: false, message: `${name} needs a value.` };
      }
    } else if (inline !== undefined) {
      return { ok: false, message: `${name} does not take a value.` };
    }

    switch (name) {
      case '--profile':
        flags.profile = value;
        break;
      case '--offline':
        flags.offline = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      default:
        return { ok: false, message: `Unknown option ${JSON.stringify(arg)}.` };
    }
  }
  return { ok: true, flags };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** All four labels are the same width, so the text column lines up. */
const LABEL: Readonly<Record<Severity, string>> = Object.freeze({
  ok: '[ ok ]',
  info: '[info]',
  warn: '[warn]',
  fail: '[FAIL]',
});

/** The indent that puts a remediation arrow under the text column. */
const INDENT = ' '.repeat(LABEL.ok.length + 1);

export function renderFinding(check: Check, found: Finding): string {
  const head = `${LABEL[found.severity]} ${check.title}: ${found.text}\n`;
  return found.remediation === undefined
    ? head
    : `${head}${INDENT}→ ${found.remediation}\n`;
}

type Tally = Record<Severity, number>;

export function renderSummary(tally: Tally): string {
  return (
    `${unit(tally.ok, 'check passed', 'checks passed')}, ` +
    `${String(tally.info)} informational, ` +
    `${unit(tally.warn, 'warning', 'warnings')}, ` +
    `${unit(tally.fail, 'failure', 'failures')}\n`
  );
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/** The default prompt: one line from stdin, asked on stderr — never on stdout. */
async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function ask(deps: CliDeps, question: string): Promise<string> {
  return await (deps.prompt ?? defaultPrompt)(question);
}

/**
 * Resolve everything the checks share.
 *
 * Only the env-file read may fail the whole command: without a snapshot there is
 * no configuration to check. A rejected *settings* environment and an unreadable
 * *profile* are carried into the context instead, because those are findings —
 * and reporting the other twelve checks around them is the entire point.
 */
async function createContext(
  deps: CliDeps,
  io: CliIo,
  flags: DoctorFlags,
): Promise<DoctorContext> {
  const platform = deps.platform ?? process.platform;
  const processEnv = deps.env ?? process.env;
  const envFilePath = resolveEnvFilePath(processEnv, platform);
  const snapshot = await readEnvFile(envFilePath);
  const env = overlayEnvFile(processEnv, snapshot);
  const clock = deps.clock ?? systemClock;

  let settings: Settings | undefined;
  let settingsError: unknown;
  try {
    settings = loadSettings(env);
  } catch (err) {
    settingsError = err;
  }

  const logger =
    deps.logger ?? createLogger({ level: settings?.logLevel ?? 'warn', clock });
  const profile = normalizeProfileName(
    flags.profile ?? settings?.lockProfile ?? settings?.activeProfile ?? DEFAULT_PROFILE,
  );

  let credentials: ProfileCredentials | undefined;
  let credentialsError: unknown;
  try {
    credentials = readProfile(profile, snapshot, env);
  } catch (err) {
    credentialsError = err;
  }

  return {
    deps,
    io,
    platform,
    clock,
    logger,
    envFilePath,
    snapshot,
    env,
    ...(settings === undefined ? {} : { settings }),
    ...(settingsError === undefined ? {} : { settingsError }),
    profile,
    ...(credentials === undefined ? {} : { credentials }),
    ...(credentialsError === undefined ? {} : { credentialsError }),
    offline: flags.offline,
  };
}

/**
 * Run `doctor`.
 *
 * @returns The exit code the process should adopt: 0 when nothing failed
 *   (warnings are allowed — README documents this as a readiness gate), 2 for a
 *   usage error, 1 when a check failed or the configuration was unreadable.
 */
export async function runDoctor(deps: CliDeps = {}): Promise<number> {
  const io = cliIo(deps);
  const parsed = parseDoctorArgs(deps.argv ?? []);
  if (!parsed.ok) {
    io.err(`${parsed.message}\n\n${doctorUsage()}`);
    return EXIT_USAGE;
  }
  if (parsed.flags.help) {
    io.out(doctorUsage());
    return EXIT_OK;
  }

  let ctx: DoctorContext;
  try {
    ctx = await createContext(deps, io, parsed.flags);
  } catch (err) {
    // A run that produced no report says so on stderr, so a failed run is
    // distinguishable from a report by more than its exit code.
    io.err(`${describeError(err)}\n`);
    return EXIT_FAILURE;
  }

  io.out(`${CLI_NAME} doctor — profile ${ctx.profile}\n\n`);

  const tally: Tally = { ok: 0, info: 0, warn: 0, fail: 0 };
  for (const check of DOCTOR_CHECKS) {
    let findings: readonly Finding[];
    try {
      findings = await check.run(ctx);
    } catch (err) {
      // One broken check must not cost the whole report: it becomes a row like
      // any other finding, and the remaining checks still run.
      findings = [findingFromError(err)];
    }
    for (const found of findings) {
      tally[found.severity] += 1;
      io.out(renderFinding(check, found));
    }
  }

  io.out(`\n${renderSummary(tally)}`);
  return tally.fail > 0 ? EXIT_FAILURE : EXIT_OK;
}
