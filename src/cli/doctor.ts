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
 * - **Findings print as each check finishes**, so the report is readable while
 *   it is still being produced. The CC-F3 "fix it now?" prompt is therefore
 *   asked with the env-file row above it and its own permissions row not yet
 *   printed — which is why the question restates the mode it is about instead of
 *   pointing at a row that only exists once the answer is in.
 * - **`--json` prints one document and nothing else** — the rows, the header and
 *   the summary are only the human rendering of the same report, so a consumer
 *   parses stdout whole instead of scraping lines.
 * - **Nothing secret is printed.** Only a masked `open_id`, scope names,
 *   expiries and paths ever reach a row — and `cliIo` redacts on top of that.
 * - **The scope matrix is derived from the live manifest** (`allTools()` and the
 *   `scopes` each spec declares) instead of from a third copy of the package →
 *   scope table: doctor reports which *registered tools* the profile cannot run,
 *   which stays honest while packages are still filling in.
 */

import { chmod, readdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { DEFAULT_STALE_MS, canonicalPath, envLockDir } from '../core/env-lock.js';
import { isTikTokError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/log.js';
import {
  DEFAULT_PROFILE,
  isLoopbackHost,
  loadSettings,
  resolveEnabledPackages,
  type Settings,
} from '../core/settings.js';
import {
  foldAttempts,
  journalExists,
  readMerged,
  resolveJournalPath,
  type JournalOptions,
} from '../mcp/journal.js';
import { allTools, type ToolPackageSpec } from '../tools/index.js';
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
import { ask } from './prompt.js';

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
  /**
   * Where this build is loaded from. A seam for the same reason
   * {@link platform} is one: the install check must be assertable on both
   * platforms from one test run, and `import.meta.url` is not overridable.
   */
  readonly modulePath: string;
  /**
   * The tool manifest the scope matrix is read from; defaults to the live one
   * (`allTools()`). A seam for the same reason {@link modulePath} is one: the
   * "enabled but not implemented" row is about a package that ships no tools,
   * which today's manifest cannot produce and a future one can, so the only way
   * to hold the row honest is to hand the check a manifest that has such a gap.
   */
  readonly packages?: readonly ToolPackageSpec[];
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

/**
 * An error as one block of prose: the message, then its remediation on its own
 * line.
 *
 * The prose form of what {@link findingFromError} already decides, so the two
 * renderings of one failure cannot disagree: `--json` reports an unreadable
 * configuration as a `fail` finding, and this is that same finding written out
 * for a human. Classifying in one place also means the shapes only the `unknown`
 * in the signature admits — a `TikTokError` carrying no remediation, a thrown
 * non-`Error` — are handled where the tests that break a check already drive
 * them, instead of a second copy here that no caller can reach.
 */
function describeError(error: unknown): string {
  const { text, remediation } = findingFromError(error);
  return remediation === undefined ? text : `${text}\n${remediation}`;
}

/**
 * A profile `readProfile` refused, as the tokens row's `fail`. The error code is
 * kept in the text because it is the stable half of the message — what a bug
 * report or a `--json` consumer can match on. A throw that carries no
 * remediation of its own still gets one, since a `fail` row with nothing to do
 * about it is a dead end.
 */
function profileReadFailure(ctx: DoctorContext, err: unknown): Finding {
  const base = findingFromError(err);
  const code = isTikTokError(err) ? ` (${err.code})` : '';
  return fail(
    `profile ${ctx.profile} could not be read${code}: ${base.text}`,
    base.remediation ??
      `Check ${quote(ctx.envFilePath)} for a damaged value, then re-run ${loginCommand(ctx.profile)}.`,
  );
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

    // `EnvFileSnapshot` is discriminated on `exists`, so the guard above has
    // already narrowed this to the arm that read a real file and `mode` is a
    // `number` — there is no "no mode" case left to defend against.
    const mode = ctx.snapshot.mode;
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
    const lockDir = envLockDir(await canonicalPath(ctx.envFilePath));
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(lockDir)).mtimeMs;
    } catch {
      return [ok('not held')];
    }
    // Liveness is mtime-only, never a PID (`core/env-lock`): a heartbeat that
    // stopped is the whole signal, and the holder file stays private to it.
    const staleMs = ctx.settings?.envLockStaleMs ?? DEFAULT_STALE_MS;
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

/** `readProfile` failures another row already reports; see the tokens row. */
const REPORTED_ELSEWHERE: readonly string[] = [
  'missing_credentials',
  'unknown_profile',
  'invalid_profile_name',
];

const tokensCheck: Check = {
  id: 'tokens',
  title: 'tokens',
  run: async (ctx) => {
    if (ctx.credentials === undefined) {
      // The credentials / profiles rows already carry these reasons — the last
      // one because the profiles row's own `listProfiles` throws it again and
      // the runner turns that throw into its row.
      if (REPORTED_ELSEWHERE.some((code) => hasCode(ctx.credentialsError, code))) {
        return [];
      }
      // Every other read failure — a damaged expiry (`invalid_timestamp`,
      // CC-H2), or anything that is not a `TikTokError` at all — has no other
      // row to land in. Returning nothing here would print a clean report and
      // exit 0 over a profile the server cannot even load, so it fails here.
      return [profileReadFailure(ctx, ctx.credentialsError)];
    }
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

    const tools = allTools(ctx.packages).filter((spec) => enabled.has(spec.package));
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
    // not a configuration mistake — but silence would read as "it works". The
    // row is here for the next package that is declared before it is written
    // (ROADMAP.md:68, "Optional: Research API package (`research`)"); today's
    // manifest gives all five at least one tool, which is why the manifest is a
    // seam ({@link DoctorContext.packages}) rather than an excluded branch.
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
 * Rotation's own lock, `journal.ndjson.lock` (`mcp/journal`). A leftover one
 * costs nothing but the rotation — appends never take it — and the next
 * rotation breaks it once stale, so like the env-lock row this only reports.
 * Rotation passes no `staleMs`, so the module default applies here, not
 * `TT_ENV_LOCK_STALE_MS`.
 */
async function journalLockFinding(
  ctx: DoctorContext,
  journalPath: string,
): Promise<Finding | undefined> {
  const lockDir = envLockDir(await canonicalPath(journalPath));
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockDir)).mtimeMs;
  } catch {
    return undefined;
  }
  const age = ctx.clock.now() - mtimeMs;
  if (age > DEFAULT_STALE_MS) {
    return warn(
      `a stale rotation lock has been held for ${humanDuration(age)} at ${lockDir}; ` +
        'the journal is not rotated until the next rotation breaks it',
      `If no server is running you may remove it: rm -rf ${quote(lockDir)}`,
    );
  }
  return info(`rotation lock held right now (${humanDuration(age)} old)`);
}

/**
 * CC-E10 — an intent with no outcome is a publish whose fate nobody knows, and
 * reconciling those is what this row is for.
 *
 * The reconciliation is `mcp/journal.ts`'s own — `readMerged` then
 * `foldAttempts`, the pair `tiktok_list_publish_journal` folds with, where
 * `"unknown"` is that module's derived outcome and not a second definition of
 * one. A parser here would be a second reader of the format, and the two would
 * part company on the first schema change. Unlike `mcp/http.ts` (see the
 * transport check) the import costs nothing at startup: `mcp/journal.ts` reaches
 * for `core/` only, all of which this command has already loaded.
 *
 * Both generations are read whole rather than tailed. A tail can cut an intent
 * away from its outcome and turn a finished attempt into a false `"unknown"` —
 * the one alarm this row must not raise.
 *
 * Deliberately not implemented: a grace period for an outcome that has not
 * landed *yet*. A publish running while doctor reads is counted as unresolved,
 * the conservative direction the duplicate guard also takes (CC-H1) — the false
 * alarm costs one `tiktok_get_publish_status` call, and the silence it would buy
 * costs a post nobody knows about.
 *
 * Nothing out of a record reaches the row: no `open_id`, no `publish_id`, no
 * title excerpt. Counts, and the path — the category the env-file, env-lock and
 * media-root rows already print, and the one CONTRIBUTING § "Reporting a bug"
 * tells the user to expect in shareable output.
 */
const journalCheck: Check = {
  id: 'publish-journal',
  title: 'publish journal',
  run: async (ctx) => {
    const opts: JournalOptions = { envFile: ctx.envFilePath };
    const path = resolveJournalPath(opts);

    // An audit file this command cannot open is not a broken installation — the
    // server publishes fine without one — so this is a `warn` and not the `fail`
    // an uncaught throw would become. The thrown message is written for the
    // model ("Ask the user to check the file"); doctor is talking to that user
    // already, so the row says it in doctor's own voice.
    const read = await readMerged(opts).catch(() => undefined);
    if (read === undefined) {
      return [
        warn(
          `${path} exists but cannot be read, so no attempt in it could be reconciled`,
          'Check its owner and mode — the journal is written 0600 by the account that publishes.',
        ),
      ];
    }

    const attempts = foldAttempts(read.records);
    const unresolved = attempts.filter((attempt) => attempt.outcome === 'unknown').length;
    const findings: Finding[] = [];
    if (attempts.length === 0) {
      // A journal with no attempt in it is either a fresh install or a file
      // whose every line was unreadable; only `journalExists` tells those apart,
      // and neither is a check that passed — nothing was verified.
      findings.push(
        (await journalExists(opts))
          ? info(`${path} — no attempt is recorded in it yet`)
          : info('no publish has been recorded yet'),
      );
    } else if (unresolved === 0) {
      findings.push(
        ok(
          `${path} — ${unit(attempts.length, 'attempt', 'attempts')} recorded, ` +
            'every one with an outcome',
        ),
      );
    } else {
      findings.push(
        warn(
          `${path} — ${unit(attempts.length, 'attempt', 'attempts')} recorded, ` +
            `${String(unresolved)} without an outcome: the request may have been sent and ` +
            'no answer was recorded, so the post may exist',
          'Reconcile them with tiktok_list_publish_journal, then confirm each one with ' +
            'tiktok_get_publish_status or tiktok_list_videos.',
        ),
      );
    }
    const lock = await journalLockFinding(ctx, path);
    if (lock !== undefined) findings.push(lock);
    if (read.skippedLines > 0) {
      // Damage, not doubt: the attempts counted above are intact and a torn last
      // line is what a crash mid-append leaves. Nothing can repair it, which is
      // why this row carries no remediation and stays informational.
      findings.push(
        info(
          `${unit(read.skippedLines, 'unreadable line', 'unreadable lines')} skipped — ` +
            'usually a truncated last write after a crash',
        ),
      );
    }
    return findings;
  },
};

const transportCheck: Check = {
  id: 'transport',
  title: 'transport',
  run: async (ctx) => {
    const settings = ctx.settings;
    if (settings === undefined) return [];
    if (settings.transport !== 'http') return await Promise.resolve([ok('stdio')]);

    // Getting this far means the schema check passed, and `core/settings`
    // refuses an http transport with no `TT_HTTP_TOKEN`, or a bind past
    // loopback without the `TT_HTTP_INSECURE=1` acknowledgement (CC-G6). So the
    // work left here is not validation — it is telling the operator what this
    // configuration actually exposes, which is the one thing `doctor` can say
    // that a startup log line said only once, hours ago.
    // The path is written out rather than imported from `mcp/http.ts`: pulling
    // that module in would load the whole Streamable HTTP stack on every
    // `doctor` run, for one string that is also documented literally.
    //
    // Neither sentence says "bearer <word>": `core/redact` masks that shape
    // wherever it appears, so a report that used the phrase would render its own
    // prose as `bearer ***` (ARCHITECTURE § 10).
    const findings: Finding[] = [
      ok(
        `http on ${settings.httpHost}:${String(settings.port)}/mcp, ` +
          'TT_HTTP_TOKEN required on every request',
      ),
    ];
    // On loopback the flag is redundant (nothing needs acknowledging there), and
    // the bind is neither reachable off-box nor exposed to rebinding past the
    // pinned Host check, so neither warning would be true.
    if (settings.httpInsecure && !isLoopbackHost(settings.httpHost)) {
      findings.push(
        warn(
          `TT_HTTP_INSECURE=1: this bind is reachable off-box, and this server speaks ` +
            'plaintext http — TT_HTTP_TOKEN is only as private as whatever fronts it',
          'Terminate TLS in front of the server, or bind TT_HTTP_HOST to 127.0.0.1.',
        ),
      );
      if (settings.httpAllowedHosts === undefined) {
        findings.push(
          warn(
            'TT_HTTP_ALLOWED_HOSTS is unset: past loopback the Host/Origin check ' +
              'cannot stop DNS rebinding, so TT_HTTP_TOKEN is the only layer left',
            'Set TT_HTTP_ALLOWED_HOSTS to the host names clients use to reach this server.',
          ),
        );
      }
    }
    return await Promise.resolve(findings);
  },
};

/**
 * `npx tiktok-mcp-ai` re-runs a *cached* copy, and `npm cache clean` does not
 * touch that cache — so an operator can spend an afternoon on a bug the
 * published version fixed weeks ago (devops-deep-review § 5.3). Doctor cannot
 * know which version the cache holds without going online, so it reports the
 * situation rather than a verdict: a `warn`, because the install works today and
 * has quietly stopped tracking releases.
 *
 * The match is on a path *segment*, not a substring: a project directory named
 * `my_npx_tools` is nobody's npx cache.
 */
const installCheck: Check = {
  id: 'install',
  title: 'install',
  run: async (ctx) => {
    const segments = ctx.modulePath.split(/[/\\]+/);
    if (!segments.includes('_npx')) {
      // An `ok` row rather than silence: silence in this file means a check with
      // no subject (no env file, so no permissions row), and "where is this
      // running from" is the first thing a stale-install report has to answer.
      return await Promise.resolve([ok('not running from the npx cache')]);
    }
    // Spelled out per platform because the paths are not derivable from each
    // other and `npm cache clean --force` leaves both untouched.
    const clear =
      ctx.platform === 'win32'
        ? 'rd /s /q "%LOCALAPPDATA%\\npm-cache\\_npx"'
        : 'rm -rf ~/.npm/_npx';
    return await Promise.resolve([
      warn(
        'running from the npx cache — npx keeps its own copy of this package and ' +
          'will not fetch a newer release while that copy is there',
        `Clear it before reporting a bug: ${clear} — then re-run with ` +
          `npx ${CLI_NAME}@latest.`,
      ),
    ]);
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
  installCheck,
]);

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

interface DoctorFlags {
  profile?: string;
  offline: boolean;
  /** Print one {@link DoctorReport} instead of rows — and nothing else. */
  json: boolean;
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
    '  --json             print the report as one JSON document, nothing else',
    '  -h, --help         show this help',
    '',
    'Exit codes: 0 = healthy (warnings allowed), 1 = a check failed, 2 = usage error.',
    '',
  ].join('\n');
}

/** Same grammar as `login`: `--flag value` and `--flag=value`; unknown is an error. */
export function parseDoctorArgs(argv: readonly string[]): ParseResult {
  const flags: DoctorFlags = { offline: false, json: false, help: false };

  // Iterated through `entries()` rather than by index: `argv[i]` under
  // `noUncheckedIndexedAccess` is `string | undefined` however tightly the loop
  // bounds it, and guarding that would be a branch nothing can ever take.
  // `consumed` is the index a `--flag value` pair ate — the one lookahead where
  // the `| undefined` is real, because the value may be past the end.
  let consumed = -1;
  for (const [i, arg] of argv.entries()) {
    if (i === consumed) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    let value: string | undefined;
    if (name === '--profile') {
      if (inline !== undefined) value = inline;
      else {
        consumed = i + 1;
        value = argv[consumed];
      }
      // `--profile --json` is a missing value, not a profile named "--json".
      const flagLike = inline === undefined && value?.startsWith('-') === true;
      if (value === undefined || value === '' || flagLike) {
        return { ok: false, message: `${name} needs a value.` };
      }
      try {
        value = normalizeProfileName(value);
      } catch (error) {
        // `normalizeProfileName` throws only a `configError`.
        return { ok: false, message: (error as Error).message };
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
      case '--json':
        flags.json = true;
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

export type Tally = Record<Severity, number>;

export function renderSummary(tally: Tally): string {
  return (
    `${unit(tally.ok, 'check passed', 'checks passed')}, ` +
    `${String(tally.info)} informational, ` +
    `${unit(tally.warn, 'warning', 'warnings')}, ` +
    `${unit(tally.fail, 'failure', 'failures')}\n`
  );
}

// ---------------------------------------------------------------------------
// the --json report
// ---------------------------------------------------------------------------

/** One check's contribution to a {@link DoctorReport}. */
export interface DoctorReportCheck {
  /** The stable {@link Check.id} — what a consumer keys on. */
  readonly id: string;
  readonly title: string;
  /** Empty when the check had nothing to report (see {@link DoctorReport}). */
  readonly findings: readonly Finding[];
}

/**
 * The document `--json` prints — the same report the rows carry, in one object:
 *
 * ```json
 * {
 *   "schema": "tiktok-mcp-ai/doctor-report",
 *   "version": 1,
 *   "profile": "DEFAULT",
 *   "offline": true,
 *   "checks": [
 *     {
 *       "id": "env-file",
 *       "title": "env file",
 *       "findings": [
 *         { "severity": "warn", "text": "…", "remediation": "…" }
 *       ]
 *     }
 *   ],
 *   "tally": { "ok": 12, "info": 2, "warn": 1, "fail": 0 },
 *   "exit_code": 0
 * }
 * ```
 *
 * `checks` is in {@link DOCTOR_CHECKS} order and holds an entry for every check
 * that ran, including the ones that answered with no finding — so "the check had
 * nothing to say" stays distinguishable from "the check never ran". `severity`
 * is a {@link Severity}; `remediation` appears only when the finding carries one.
 *
 * `version` rises when a field changes meaning or disappears. A *new* field is
 * not a version bump, so a consumer must ignore what it does not recognize.
 *
 * Every run that reaches stdout prints exactly one of these and nothing else —
 * including the run whose configuration was unreadable, which reports the reason
 * as the single finding of a synthetic `configuration` check, so a consumer never
 * has to read an empty stdout to learn what happened. The two exceptions are a
 * usage error (stderr, exit 2) and `--help`, which still prints the usage text.
 *
 * Nothing in here is timed or hashed *against the run*: no start time, no
 * duration, no ordering by wall clock. Two runs of one configuration on one
 * clock produce byte-identical documents.
 *
 * The document is not independent of the clock, though, and CI should not be
 * told that it is: the rows that exist to warn about time say how much time is
 * left (`expires in 21 days`, CC-A5) or how long something has been held (a
 * stale env lock, CC-F5). A profile doctor is happy with carries none of those
 * rows and diffs clean indefinitely; a profile doctor is warning about diffs
 * clean only against a run of the same age — which is the warning doing its job,
 * not a defect in the schema.
 */
export interface DoctorReport {
  readonly schema: 'tiktok-mcp-ai/doctor-report';
  readonly version: 1;
  /** The profile reported on; `null` when the run never resolved one. */
  readonly profile: string | null;
  readonly offline: boolean;
  readonly checks: readonly DoctorReportCheck[];
  readonly tally: Tally;
  /** The process exit code this document belongs to. */
  readonly exit_code: number;
}

/** The single place a tally becomes an exit code, so the two cannot disagree. */
function exitCodeFor(tally: Tally): number {
  return tally.fail > 0 ? EXIT_FAILURE : EXIT_OK;
}

function doctorReport(
  profile: string | null,
  offline: boolean,
  checks: readonly DoctorReportCheck[],
  tally: Tally,
): DoctorReport {
  return {
    schema: 'tiktok-mcp-ai/doctor-report',
    version: 1,
    profile,
    offline,
    checks,
    tally,
    exit_code: exitCodeFor(tally),
  };
}

/**
 * Indented, because the first reader of a `--json` run is a human checking what
 * the flag prints; every parser is indifferent. The trailing newline is for the
 * same reason — a shell prompt should not land on the closing brace.
 */
export function renderJsonReport(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

/**
 * The default for {@link DoctorContext.modulePath}.
 *
 * A module URL that is not a `file:` one (never true of a published install, but
 * possible under an experimental loader) yields an empty path rather than failing
 * the whole run over a diagnostic. The install check then finds no `_npx` segment
 * and reports "not running from the npx cache" — the same answer an ordinary
 * global install gets, which is the safe direction to be wrong about a hint.
 *
 * @param url The module URL to resolve. Defaults to this module's own, which is
 *   what production wants and what `import.meta.url` cannot be made to say
 *   otherwise; it is a parameter so the non-`file:` arm is reachable from a test
 *   through the real function instead of being excluded from coverage.
 */
export function resolveModulePath(url: string = import.meta.url): string {
  try {
    return fileURLToPath(url);
  } catch {
    return '';
  }
}

/**
 * Resolve everything the checks share.
 *
 * Only the env-file read may fail the whole command: without a snapshot there is
 * no configuration to check. A rejected *settings* environment and an unreadable
 * *profile* are carried into the context instead, because those are findings —
 * and reporting the other thirteen checks around them is the entire point.
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
    modulePath: deps.modulePath ?? resolveModulePath(),
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
 *   usage error, 1 when a check failed or the configuration was unreadable. The
 *   code does not depend on `--json`: the flag changes the rendering, not the
 *   verdict.
 */
export async function runDoctor(deps: CliDeps = {}): Promise<number> {
  const io = cliIo(deps);
  const parsed = parseDoctorArgs(deps.argv ?? []);
  if (!parsed.ok) {
    io.err(`${parsed.message}\n\n${doctorUsage()}`);
    return EXIT_USAGE;
  }
  const flags = parsed.flags;
  if (flags.help) {
    io.out(doctorUsage());
    return EXIT_OK;
  }

  let ctx: DoctorContext;
  try {
    // `--json` is a machine mode, and the CC-F3 "fix it now?" prompt would block
    // a consumer that has no way to answer it — so it is closed off exactly the
    // way a non-terminal run closes it, at the seam the check reads.
    const ctxIo: CliIo = flags.json ? { ...io, isTTY: false } : io;
    ctx = await createContext(deps, ctxIo, flags);
  } catch (err) {
    // A run that produced no report says so: on stderr for a human, and as a
    // document of the ordinary shape for `--json` — one report, one channel,
    // never both.
    if (flags.json) {
      io.out(
        renderJsonReport(
          // `profile` is null because resolving it is one of the steps that just
          // failed (an invalid `TT_ACTIVE_PROFILE` or `TT_LOCK_PROFILE`; `--profile` is
          // refused earlier, by `parseDoctorArgs`).
          doctorReport(
            null,
            flags.offline,
            [
              {
                id: 'configuration',
                title: 'configuration',
                findings: [findingFromError(err)],
              },
            ],
            { ok: 0, info: 0, warn: 0, fail: 1 },
          ),
        ),
      );
    } else {
      io.err(`${describeError(err)}\n`);
    }
    return EXIT_FAILURE;
  }

  if (!flags.json) io.out(`${CLI_NAME} doctor — profile ${ctx.profile}\n\n`);

  const tally: Tally = { ok: 0, info: 0, warn: 0, fail: 0 };
  const checks: DoctorReportCheck[] = [];
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
      if (!flags.json) io.out(renderFinding(check, found));
    }
    checks.push({ id: check.id, title: check.title, findings });
  }

  if (flags.json) {
    io.out(renderJsonReport(doctorReport(ctx.profile, ctx.offline, checks, tally)));
  } else {
    io.out(`\n${renderSummary(tally)}`);
  }
  return exitCodeFor(tally);
}
