/**
 * Settings — the validated, typed view of every `TT_` variable.
 *
 * Spec: CONFIGURATION.md (§ Variables is the authoritative list — this module
 * carries **exactly one field per row**, naming rule "strip `TT_`, camelCase"),
 * CONTRACTS.md § core/settings, CORNER-CASES.md CC-F2 (presence-based
 * resolution: `TT_X=""` counts as *set*), CC-F4 (profile-name shape), CC-F6
 * (every numeric variable zod-validated at startup, all problems aggregated
 * into one error) and CC-G6 (`TT_HTTP_TOKEN` is mandatory whenever the HTTP
 * transport is selected — loopback included).
 *
 * Design notes:
 *
 * - **One error, every problem.** A misconfigured server must not be fixed one
 *   variable per restart, so `loadSettings` never throws on the first bad value:
 *   it collects, then throws a single `config` error listing all of them
 *   (CC-F6). A variable that failed falls back to its documented default for the
 *   remainder of the pass, which only ever *hides* a follow-on problem — it can
 *   never invent one.
 * - **Presence-based, not truthiness-based** (CC-F2). Absent means "use the
 *   default". Present means "the operator said something", so an empty string is
 *   validated like any other value and is rejected wherever a value is required.
 *   The exception is the optional string-valued variables (`TT_ENV_FILE`,
 *   `TT_MEDIA_ROOT`, `TT_LOCK_PROFILE`, `TT_HTTP_TOKEN`, `TT_LOGIN_SCOPES`,
 *   `TT_REDIRECT_PORT`, `TT_OAUTH_BASE_URL`): for those, "empty" and "unset" are
 *   the same documented state (no pin / fail-closed / ephemeral port), so an
 *   empty value reads as absent rather than as an error.
 * - **Values are trimmed.** MCP client configuration files are hand-edited JSON;
 *   a trailing space in `"TT_TIMEOUT_MS": "30000 "` is a typo, not a
 *   configuration choice.
 * - **Numbers are plain decimal digits only.** `Number("0x10")` is 16 and
 *   `Number("1e3")` is 1000; accepting either would make a typo silently mean
 *   something. A strict `^\d+$` gate plus `Number.isSafeInteger` is what keeps
 *   garbage from becoming NaN behaviour at call time (CC-F6).
 * - **Credentials are not settings.** `TT_CLIENT_KEY`/`TT_CLIENT_SECRET` and the
 *   token sextet (plus `TT_PROFILE_<NAME>_*`) are read through `core/config`'s
 *   `ProfileCredentials`, per CONFIGURATION.md's explicit carve-out — a secret
 *   that lives in exactly one place cannot be leaked from the other.
 * - **A secret is never echoed.** Problem lines quote the offending value so the
 *   operator can find it, except for `TT_HTTP_TOKEN`, which is reported as
 *   `<redacted>`. `TikTokError` additionally scrubs registered secrets from the
 *   message (`core/redact`), but a value that failed validation was never
 *   registered, so this module does its own suppression.
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import { TikTokError } from './errors.js';
import type { LogLevel } from './log.js';

// ---------------------------------------------------------------------------
// closed vocabularies
// ---------------------------------------------------------------------------

/** `TT_WRITE_MODE` (CONFIGURATION.md § Tool surface & write policy). */
export const WRITE_MODES = ['plan', 'apply', 'deny'] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

/** `TT_TRANSPORT`. */
export const TRANSPORTS = ['stdio', 'http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

/** The five tool packages (TOOLS.md § 1 — 11 tools / 5 packages). */
export const TOOL_PACKAGES = [
  'auth',
  'user',
  'video',
  'publish',
  'publish-write',
] as const;
export type ToolPackage = (typeof TOOL_PACKAGES)[number];

/**
 * `TT_TOOL_PACKAGES` also accepts the two named profiles; the vocabulary is
 * pinned here so a typo fails at startup instead of silently registering
 * nothing, and {@link resolveEnabledPackages} expands them.
 */
export const PACKAGE_SELECTORS = [...TOOL_PACKAGES, 'core', 'all'] as const;
export type PackageSelector = (typeof PACKAGE_SELECTORS)[number];

/** `core` = everything except the writes; `all` = every package. */
const PACKAGE_PROFILES: Readonly<Record<'core' | 'all', readonly ToolPackage[]>> =
  Object.freeze({
    core: Object.freeze(['auth', 'user', 'video', 'publish'] as const),
    all: TOOL_PACKAGES,
  });

/**
 * Which packages this installation serves.
 *
 * `TT_TOOL_PACKAGES` selects (with the two named profiles expanded),
 * `TT_PACKAGES_DENY` subtracts, and the two safety switches — `TT_WRITE_MODE=deny`
 * and `TT_PACKAGES_READONLY=1` — drop `publish-write` outright and win over any
 * profile setting (TOOLS.md § 1, CONFIGURATION.md). The result keeps manifest
 * order, never selector order, so `tools/list` is stable.
 *
 * It lives in `core` rather than in the mcp layer that consumes it because the
 * `login` command needs the same answer to derive its least-privilege scope set
 * (AUTH.md § 2) and must reach it without loading the MCP SDK. Two copies of
 * this reduction would be two things that have to stay equal; `mcp/server`
 * re-exports this one under its contracted name.
 */
export function resolveEnabledPackages(settings: Settings): readonly ToolPackage[] {
  const selected = new Set<ToolPackage>();
  for (const selector of settings.toolPackages) {
    if (selector === 'core' || selector === 'all') {
      for (const pkg of PACKAGE_PROFILES[selector]) selected.add(pkg);
    } else {
      selected.add(selector);
    }
  }
  for (const denied of settings.packagesDeny) selected.delete(denied);
  if (settings.writeMode === 'deny' || settings.packagesReadonly) {
    selected.delete('publish-write');
  }
  return TOOL_PACKAGES.filter((pkg) => selected.has(pkg));
}

/** `TT_LOG_LEVEL` — `satisfies` keeps this in lockstep with `core/log`. */
const LOG_LEVELS = [
  'debug',
  'info',
  'warn',
  'error',
] as const satisfies readonly LogLevel[];

/** Profile names match `[A-Z0-9_]+` and are upper-cased on read (CC-F4). */
const PROFILE_NAME = /^[A-Z0-9_]+$/;

/** The implicit default profile — the bare token sextet. */
export const DEFAULT_PROFILE = 'DEFAULT';

/** Reported as `<redacted>` instead of by value when validation fails. */
const SECRET_VARS: ReadonlySet<string> = new Set(['TT_HTTP_TOKEN']);

/**
 * A guessing floor, not a strength claim: the bearer token is the whole of the
 * HTTP transport's authentication (CC-G6), and `TT_HTTP_TOKEN=x` reads as
 * configured while being no protection at all.
 */
const HTTP_TOKEN_MIN_LENGTH = 16;

// ---------------------------------------------------------------------------
// the settings shape
// ---------------------------------------------------------------------------

/**
 * One field per `TT_` variable in CONFIGURATION.md § Variables, except the
 * credential keys (see the module docstring). The `env-docs-sync` test asserts
 * that correspondence against the document itself, so a variable added to the
 * table without a field here fails the suite.
 */
export interface Settings {
  // Env file & profiles
  envFile?: string;
  configSchema: number;
  activeProfile: string;
  lockProfile?: string;

  // OAuth / login
  redirectPort?: number;
  loginScopes?: readonly string[];
  tokenRefreshSkewS: number;

  // Tool surface & write policy
  toolPackages: readonly PackageSelector[];
  packagesDeny: readonly ToolPackage[];
  packagesReadonly: boolean;
  writeMode: WriteMode;
  planTtlS: number;
  planMaxOutstanding: number;
  defaultAigcLabel: boolean;

  // Media & URL sources
  mediaRoot?: string;
  verifiedUrlPrefixes: readonly string[];

  // Journal
  journalMaxBytes: number;

  // Env-file lock
  envLockHeartbeatMs: number;
  envLockStaleMs: number;
  envLockWaitMs: number;

  // HTTP / limits / output
  timeoutMs: number;
  uploadTimeoutMs: number;
  maxRetries: number;
  chunkRetries: number;
  maxConcurrent: number;
  publishRpm: number;
  fetchAllCap: number;
  resultCharBudget: number;
  prettyJson: boolean;
  statusPollIntervalMs: number;
  statusPollTimeoutMs: number;
  logLevel: LogLevel;

  // Transport
  transport: Transport;
  httpHost: string;
  port: number;
  httpToken?: string;
  httpInsecure: boolean;

  // Internal / test-only (CONFIGURATION.md § Internal / test-only)
  oauthBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// value schemas
// ---------------------------------------------------------------------------

type StringSchema<T> = z.ZodType<T, z.ZodTypeDef, string>;

function decimalInt(opts: {
  min: number;
  max?: number;
  unit?: string;
}): StringSchema<number> {
  const noun =
    opts.unit === undefined ? 'a whole number' : `a whole number of ${opts.unit}`;
  const range =
    opts.max === undefined
      ? `>= ${String(opts.min)}`
      : `${String(opts.min)}–${String(opts.max)}`;
  return z
    .string()
    .regex(/^\d+$/, `expected ${noun} in plain decimal digits`)
    .transform((raw) => Number(raw))
    .refine((n) => Number.isSafeInteger(n), 'value is too large to represent exactly')
    .refine(
      (n) => n >= opts.min && (opts.max === undefined || n <= opts.max),
      `expected ${noun} ${range}`,
    );
}

const TRUTHY: ReadonlySet<string> = new Set(['1', 'true']);
const FALSY: ReadonlySet<string> = new Set(['0', 'false']);

/**
 * `0`/`1` per the documentation; `true`/`false` accepted as a superset because
 * MCP client configs are JSON and operators type booleans there.
 */
function flag(): StringSchema<boolean> {
  return z
    .string()
    .transform((raw) => raw.toLowerCase())
    .refine(
      (raw) => TRUTHY.has(raw) || FALSY.has(raw),
      'expected 0 or 1 (true/false accepted)',
    )
    .transform((raw) => TRUTHY.has(raw));
}

function oneOf<T extends string>(values: readonly [T, ...T[]]): StringSchema<T> {
  return z.string().pipe(z.enum(values));
}

/** Comma-separated, whitespace-tolerant, empty entries dropped. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function listOf<T extends string>(
  values: readonly [T, ...T[]],
  what: string,
): StringSchema<readonly T[]> {
  return z
    .string()
    .transform(splitList)
    .pipe(z.array(z.enum(values)).nonempty(`expected at least one ${what}`));
}

function stringList(what: string): StringSchema<readonly string[]> {
  return z
    .string()
    .transform(splitList)
    .pipe(z.array(z.string()).nonempty(`expected at least one ${what}`));
}

/**
 * `~` is expanded by the server, not the shell: these values usually arrive from
 * an MCP client's JSON config, where no shell ever touched them, and a literal
 * `~` would create a directory named `~` next to the user's home.
 */
function expandTilde(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

/** The env-file override is used as given, only `~`-expanded and made absolute. */
function envFilePath(): StringSchema<string> {
  return z.string().transform((raw) => resolve(expandTilde(raw)));
}

/** `TT_MEDIA_ROOT` must be an absolute path — the containment check (CC-D8) has no CWD to lean on. */
function absolutePath(): StringSchema<string> {
  return z
    .string()
    .transform(expandTilde)
    .refine(isAbsolute, 'expected an absolute path');
}

function profileName(): StringSchema<string> {
  return z
    .string()
    .transform((raw) => raw.toUpperCase())
    .refine(
      (name) => PROFILE_NAME.test(name),
      'expected a profile name matching [A-Z0-9_]+',
    );
}

/**
 * The token travels verbatim in an `Authorization: Bearer` header, so a value
 * carrying a space or a control character is not a weak token but an unsendable
 * one — rejected at startup rather than at the first request. Printable ASCII is
 * a deliberate superset of RFC 7235 `token68`: strict enough that the header is
 * always well-formed, loose enough not to reject a token some other tool minted.
 * The value itself never reaches the error message (see `SECRET_VARS`).
 */
function bearerToken(): StringSchema<string> {
  return z
    .string()
    .min(
      HTTP_TOKEN_MIN_LENGTH,
      `expected at least ${String(HTTP_TOKEN_MIN_LENGTH)} characters`,
    )
    .regex(/^[!-~]+$/, 'expected printable ASCII with no spaces');
}

function httpsPrefix(): z.ZodType<string, z.ZodTypeDef, string> {
  return z.string().refine((value) => {
    if (!value.startsWith('https://')) return false;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, 'expected an https:// URL prefix');
}

function httpsPrefixList(): StringSchema<readonly string[]> {
  return z
    .string()
    .transform(splitList)
    .pipe(z.array(httpsPrefix()).nonempty('expected at least one https:// prefix'));
}

function httpsOrigin(): StringSchema<string> {
  return z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'expected an absolute http(s) URL');
}

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

/**
 * Reads variables and accumulates problems instead of throwing, so one pass over
 * the environment reports everything wrong with it (CC-F6).
 */
class Collector {
  readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  /** Absent *or empty* ⇒ `undefined` (see the module docstring on CC-F2). */
  optional<T>(name: string, schema: StringSchema<T>): T | undefined {
    const raw = this.env[name];
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (value === '') return undefined;
    return this.parse(name, schema, value);
  }

  /** Absent ⇒ `fallback`. Present — including empty — is validated (CC-F2). */
  withDefault<T>(name: string, schema: StringSchema<T>, fallback: T): T {
    const raw = this.env[name];
    if (raw === undefined) return fallback;
    return this.parse(name, schema, raw.trim()) ?? fallback;
  }

  /** A cross-field problem, phrased the same way as a per-variable one. */
  reject(name: string, reason: string): void {
    this.problems.push(`${name}: ${reason}`);
  }

  private parse<T>(name: string, schema: StringSchema<T>, value: string): T | undefined {
    const result = schema.safeParse(value);
    if (result.success) return result.data;

    const shown = SECRET_VARS.has(name) ? '<redacted>' : JSON.stringify(value);
    for (const issue of result.error.issues) {
      const path = issue.path.map((segment) => `[${String(segment)}]`).join('');
      this.problems.push(`${name}${path}: ${issue.message} (got ${shown})`);
    }
    return undefined;
  }
}

/** Loopback covers only what actually stays on the machine. `0.0.0.0` does not. */
function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare.toLowerCase() === 'localhost') return true;
  if (bare === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * Constraints that only make sense once every variable has a value. Each one is
 * a startup error in the same aggregate, never a runtime surprise.
 */
function checkCombinations(settings: Settings, collector: Collector): void {
  if (settings.transport === 'http') {
    // CC-G6: no unauthenticated HTTP transport, loopback included (SYN-31).
    if (settings.httpToken === undefined) {
      collector.reject(
        'TT_HTTP_TOKEN',
        'required whenever TT_TRANSPORT=http, including a loopback bind',
      );
    }
    if (!isLoopbackHost(settings.httpHost) && !settings.httpInsecure) {
      collector.reject(
        'TT_HTTP_HOST',
        `binding ${settings.httpHost} exposes the server beyond loopback: put TLS termination in front and set TT_HTTP_INSECURE=1 to acknowledge it`,
      );
    }
  }

  // A heartbeat slower than the stale threshold would let a *live* holder be
  // declared stale and its lock stolen mid-write (CC-F5).
  if (settings.envLockHeartbeatMs >= settings.envLockStaleMs) {
    collector.reject(
      'TT_ENV_LOCK_HEARTBEAT_MS',
      `must be smaller than TT_ENV_LOCK_STALE_MS (${String(settings.envLockStaleMs)}), otherwise a live lock holder looks stale`,
    );
  }
}

function configError(problems: readonly string[]): TikTokError {
  const count = problems.length;
  const list = problems.map((problem) => `  - ${problem}`).join('\n');
  return new TikTokError({
    kind: 'config',
    code: 'invalid_configuration',
    message: `Invalid server configuration (${String(count)} problem${count === 1 ? '' : 's'}):\n${list}`,
    remediation:
      'Fix these variables in the MCP client configuration (or the env file) and restart the server. Reference: docs/CONFIGURATION.md.',
  });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Read and validate the whole `TT_` surface.
 *
 * @param env Defaults to `process.env`. The composition root passes the process
 *   env already overlaid on the env file (`core/config` owns that merge), so
 *   per-key precedence is decided before this function sees anything.
 * @throws TikTokError `kind: "config"`, `code: "invalid_configuration"` — one
 *   error listing **every** problem found (CC-F6).
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const c = new Collector(env);

  const settings: Settings = {
    // Env file & profiles
    envFile: c.optional('TT_ENV_FILE', envFilePath()),
    configSchema: c.withDefault('TT_CONFIG_SCHEMA', decimalInt({ min: 1 }), 1),
    activeProfile: c.withDefault('TT_ACTIVE_PROFILE', profileName(), DEFAULT_PROFILE),
    lockProfile: c.optional('TT_LOCK_PROFILE', profileName()),

    // OAuth / login
    redirectPort: c.optional('TT_REDIRECT_PORT', decimalInt({ min: 1, max: 65_535 })),
    loginScopes: c.optional('TT_LOGIN_SCOPES', stringList('scope')),
    tokenRefreshSkewS: c.withDefault(
      'TT_TOKEN_REFRESH_SKEW_S',
      decimalInt({ min: 0, unit: 'seconds' }),
      1_800,
    ),

    // Tool surface & write policy
    toolPackages: c.withDefault(
      'TT_TOOL_PACKAGES',
      listOf(PACKAGE_SELECTORS, 'package'),
      ['core'],
    ),
    packagesDeny: c.withDefault('TT_PACKAGES_DENY', listOf(TOOL_PACKAGES, 'package'), []),
    packagesReadonly: c.withDefault('TT_PACKAGES_READONLY', flag(), false),
    writeMode: c.withDefault('TT_WRITE_MODE', oneOf(WRITE_MODES), 'plan'),
    planTtlS: c.withDefault(
      'TT_PLAN_TTL_S',
      decimalInt({ min: 1, unit: 'seconds' }),
      600,
    ),
    planMaxOutstanding: c.withDefault(
      'TT_PLAN_MAX_OUTSTANDING',
      decimalInt({ min: 1 }),
      32,
    ),
    defaultAigcLabel: c.withDefault('TT_DEFAULT_AIGC_LABEL', flag(), true),

    // Media & URL sources
    mediaRoot: c.optional('TT_MEDIA_ROOT', absolutePath()),
    verifiedUrlPrefixes: c.withDefault('TT_VERIFIED_URL_PREFIXES', httpsPrefixList(), []),

    // Journal
    journalMaxBytes: c.withDefault(
      'TT_JOURNAL_MAX_BYTES',
      decimalInt({ min: 1, unit: 'bytes' }),
      5_242_880,
    ),

    // Env-file lock
    envLockHeartbeatMs: c.withDefault(
      'TT_ENV_LOCK_HEARTBEAT_MS',
      decimalInt({ min: 1, unit: 'milliseconds' }),
      2_000,
    ),
    envLockStaleMs: c.withDefault(
      'TT_ENV_LOCK_STALE_MS',
      decimalInt({ min: 1, unit: 'milliseconds' }),
      15_000,
    ),
    envLockWaitMs: c.withDefault(
      'TT_ENV_LOCK_WAIT_MS',
      decimalInt({ min: 0, unit: 'milliseconds' }),
      30_000,
    ),

    // HTTP / limits / output
    timeoutMs: c.withDefault(
      'TT_TIMEOUT_MS',
      decimalInt({ min: 1, unit: 'milliseconds' }),
      30_000,
    ),
    uploadTimeoutMs: c.withDefault(
      'TT_UPLOAD_TIMEOUT_MS',
      decimalInt({ min: 1, unit: 'milliseconds' }),
      120_000,
    ),
    maxRetries: c.withDefault('TT_MAX_RETRIES', decimalInt({ min: 0 }), 3),
    chunkRetries: c.withDefault('TT_CHUNK_RETRIES', decimalInt({ min: 0 }), 3),
    maxConcurrent: c.withDefault('TT_MAX_CONCURRENT', decimalInt({ min: 1 }), 4),
    publishRpm: c.withDefault('TT_PUBLISH_RPM', decimalInt({ min: 1 }), 6),
    fetchAllCap: c.withDefault('TT_FETCH_ALL_CAP', decimalInt({ min: 1 }), 200),
    resultCharBudget: c.withDefault(
      'TT_RESULT_CHAR_BUDGET',
      decimalInt({ min: 1, unit: 'characters' }),
      25_000,
    ),
    prettyJson: c.withDefault('TT_PRETTY_JSON', flag(), false),
    statusPollIntervalMs: c.withDefault(
      'TT_STATUS_POLL_INTERVAL_MS',
      decimalInt({ min: 1, unit: 'milliseconds' }),
      5_000,
    ),
    statusPollTimeoutMs: c.withDefault(
      'TT_STATUS_POLL_TIMEOUT_MS',
      decimalInt({ min: 0, unit: 'milliseconds' }),
      60_000,
    ),
    logLevel: c.withDefault('TT_LOG_LEVEL', oneOf(LOG_LEVELS), 'info'),

    // Transport
    transport: c.withDefault('TT_TRANSPORT', oneOf(TRANSPORTS), 'stdio'),
    httpHost: c.withDefault(
      'TT_HTTP_HOST',
      z.string().min(1, 'expected a host name or IP address'),
      '127.0.0.1',
    ),
    port: c.withDefault('TT_PORT', decimalInt({ min: 1, max: 65_535 }), 3_000),
    httpToken: c.optional('TT_HTTP_TOKEN', bearerToken()),
    httpInsecure: c.withDefault('TT_HTTP_INSECURE', flag(), false),

    // Internal / test-only
    oauthBaseUrl: c.optional('TT_OAUTH_BASE_URL', httpsOrigin()),
  };

  checkCombinations(settings, c);

  if (c.problems.length > 0) throw configError(c.problems);
  return settings;
}

/**
 * The `TT_` variable a `Settings` field was read from — the documented naming
 * rule ("strip `TT_`, camelCase") applied in reverse.
 */
export function settingVarName(field: string): string {
  return `TT_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

let knownVars: ReadonlySet<string> | undefined;

/**
 * Every non-credential `TT_` variable this build understands.
 *
 * Derived from a defaults-only load rather than from a second hand-written list:
 * `loadSettings` assigns every field of `Settings`, including the optional ones,
 * so its keys *are* the variable surface and cannot drift from it. `core/config`
 * uses this to tell an unknown key (warn, keep, round-trip) from a known one.
 */
export function knownSettingVars(): ReadonlySet<string> {
  knownVars ??= new Set(Object.keys(loadSettings({})).map(settingVarName));
  return knownVars;
}
