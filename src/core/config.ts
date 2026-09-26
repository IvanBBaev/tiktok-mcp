/**
 * core/config.ts — the env file: where it lives, how it parses, how it is
 * rewritten without losing anything, and how a profile's credentials are read.
 *
 * Spec: CONTRACTS.md § core/config, CONFIGURATION.md (§ Location, § Profiles,
 * § Writes, § Schema versioning), CORNER-CASES.md CC-F1 (parse edge cases),
 * CC-F2 (presence-based overlay), CC-F3 (`0600`), CC-F4 (profile names),
 * CC-H2 (ISO-8601 UTC persisted, epoch compared) and CC-H3 (win32 rename
 * ladder + degrade).
 *
 * Design notes:
 *
 * - **The file is a document, not a key-value store.** An operator's comments,
 *   blank lines, CRLF endings and unknown `TT_*` keys survive a rewrite
 *   byte-for-byte: only the lines whose keys we actually change are re-rendered
 *   (CONFIGURATION.md § Writes). That is why the snapshot keeps the raw lines
 *   rather than just a map.
 * - **No inline comments.** Everything after the first `=` is the value, `#`
 *   included. A `#` inside a token is far more likely than a comment on a
 *   generated credential line, and guessing wrong would silently truncate a
 *   secret. Comments must be on their own line.
 * - **Reads are snapshots.** `readEnvFile` takes one file handle and reads both
 *   the text and the mode through it, and every write lands via `rename`, so a
 *   reader either sees the whole old file or the whole new one — a torn read,
 *   or a snapshot whose two halves came from two different inodes, is not
 *   representable (TESTING.md § core/config).
 * - **A failed write never fails a tool call** (CC-H3). Persisting is
 *   best-effort: EPERM/EBUSY on `rename` (a virus scanner or an editor holding
 *   the file open on Windows) is retried three times, and any other I/O failure
 *   degrades to `{ persisted: false }` plus a warning. The caller keeps the
 *   perfectly valid token it already has in memory. The one exception is a
 *   schema marker from the future, which is a deliberate refusal to write rather
 *   than a failure to write, and must be visible.
 * - **The lock is the caller's job.** `persistProfilePatch` is read-merge-write,
 *   so concurrent callers would lose updates; every caller must already hold
 *   `withEnvLock` (CONTRACTS.md § core/config, CC-A2/CC-F5).
 */

import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { canonicalPath } from './env-lock.js';
import { TikTokError } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { registerSecret } from './redact.js';
import { DEFAULT_PROFILE, knownSettingVars } from './settings.js';

/** The directory name used under the platform's config root. */
const APP_DIR = 'tiktok-mcp-ai';

/** The env-file schema this build writes; an absent marker reads as `1`. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Modes are documented in CONFIGURATION.md § Location and asserted POSIX-only (CC-F3). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** CC-H3: `rename` retried ×3 at these delays before degrading. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200] as const;

/** Errno values that mean "someone else is holding the file right now". */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Valid env-file key shape; also what an `.env` parser can round-trip. */
const KEY_LINE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** CC-F4: profile names match `[A-Z0-9_]+` and are upper-cased on read. */
const PROFILE_NAME = /^[A-Z0-9_]+$/;

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

export interface ProfileCredentials {
  clientKey: string;
  clientSecret: string;
  accessToken?: string;
  accessExpiresAt?: string; // ISO-8601 UTC (CC-H2)
  refreshToken?: string;
  refreshExpiresAt?: string;
  openId?: string;
  scopes?: string[];
}

/** The per-profile token sextet (CONFIGURATION.md § Profiles). */
const TOKEN_KEY_SUFFIX = {
  accessToken: 'ACCESS_TOKEN',
  accessExpiresAt: 'TOKEN_EXPIRES_AT',
  refreshToken: 'REFRESH_TOKEN',
  refreshExpiresAt: 'REFRESH_EXPIRES_AT',
  openId: 'OPEN_ID',
  scopes: 'SCOPES',
} as const satisfies Record<string, string>;

type TokenField = keyof typeof TOKEN_KEY_SUFFIX;

/** The app credentials are per *installation*, never per profile — one app, many accounts. */
const APP_KEY_NAME = {
  clientKey: 'TT_CLIENT_KEY',
  clientSecret: 'TT_CLIENT_SECRET',
} as const satisfies Record<string, string>;

type AppField = keyof typeof APP_KEY_NAME;

/** Matches a per-profile token key case-insensitively; the name is upper-cased (CC-F4). */
const PROFILE_KEY = new RegExp(
  `^TT_PROFILE_([A-Za-z0-9_]+)_(${Object.values(TOKEN_KEY_SUFFIX).join('|')})$`,
  'i',
);

/**
 * A successful `PROFILE_KEY.exec`. Group 1 is `[A-Za-z0-9_]+` — mandatory, not
 * optional and not inside an alternation — so a match always carries the profile
 * name, exactly as the standard library declares `0` present on every
 * `RegExpExecArray`. Declaring it is what keeps `noUncheckedIndexedAccess` from
 * widening the name to `string | undefined` and inventing a guard for it.
 */
interface ProfileKeyMatch extends RegExpExecArray {
  1: string;
}

/**
 * The same trick for {@link KEY_LINE}. Groups 2 and 3 — the key and the raw
 * value — are not optional: a match means the line assigned something, so the
 * guard `noUncheckedIndexedAccess` would otherwise demand for them is a branch
 * nothing can reach. Group 1 (`export `) *is* optional and stays widened to
 * `string | undefined`, which is exactly what the rewrite needs to know.
 */
interface KeyLineMatch extends RegExpExecArray {
  2: string;
  3: string;
}

/** The `TT_` key a field maps to for a given profile. */
export function envKeyFor(profile: string, field: TokenField | AppField): string {
  if (field === 'clientKey' || field === 'clientSecret') return APP_KEY_NAME[field];
  const suffix = TOKEN_KEY_SUFFIX[field];
  return profile === DEFAULT_PROFILE ? `TT_${suffix}` : `TT_PROFILE_${profile}_${suffix}`;
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

/**
 * One parsed line. `key` is set only for assignment lines; comments, blank lines
 * and the file's final unterminated line all round-trip through `text` + `eol`.
 */
export interface EnvLine {
  readonly text: string;
  /** `"\n"`, `"\r\n"`, or `""` for a last line without a terminator. */
  readonly eol: string;
  readonly key?: string;
  /** The `export ` prefix, preserved when the line is rewritten. */
  readonly prefix?: string;
}

/** What both arms of {@link EnvFileSnapshot} carry, file or no file. */
interface EnvFileSnapshotBase {
  /** The absolute path this snapshot was read from. */
  readonly path: string;
  /** Effective key → value, duplicates resolved last-wins (CC-F1). */
  readonly values: ReadonlyMap<string, string>;
  /** `TT_CONFIG_SCHEMA` as literally present, `undefined` when absent. */
  readonly declaredSchema?: number;
  /** The effective schema — `declaredSchema` or `1` (CONFIGURATION.md § Schema versioning). */
  readonly schema: number;
  /** Non-fatal findings: duplicate keys, unknown `TT_*` keys (CC-F1). */
  readonly warnings: readonly string[];
  /** The raw document, for a byte-exact rewrite. Consumed by `persistProfilePatch`. */
  readonly lines: readonly EnvLine[];
  /** The dominant line ending, used for lines appended to the file. */
  readonly eol: '\n' | '\r\n';
}

/**
 * The file was there and was read. `mode` came off the *same* handle as the
 * bytes, so it describes the file those bytes came from and is never absent.
 */
export interface ExistingEnvFile extends EnvFileSnapshotBase {
  readonly exists: true;
  /** `st_mode & 0o777`. Meaningful on POSIX only (CC-F3). */
  readonly mode: number;
}

/**
 * No file yet — legal, not an error: the process environment may carry
 * everything (CC-F1). There is no mode, so this arm does not declare one: a
 * caller that wants `mode` has to narrow on `exists` first, which is the only
 * question that decides whether a mode exists at all.
 */
export interface MissingEnvFile extends EnvFileSnapshotBase {
  readonly exists: false;
}

/**
 * An immutable view of the env file at one instant, discriminated on `exists`.
 *
 * A union rather than one shape with an optional `mode`: `readEnvFile` builds
 * exactly two literals and each of them either has a mode or cannot have one,
 * so the optional field only ever manufactured guards that nothing could reach
 * (TESTING.md § What to do with an uncovered branch — "type artifact").
 */
export type EnvFileSnapshot = ExistingEnvFile | MissingEnvFile;

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------

function expandTilde(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\'))
    return resolve(homedir(), value.slice(2));
  return value;
}

/**
 * Where the env file lives (CONFIGURATION.md § Location, SYNTHESIS § 2.1).
 *
 * `TT_ENV_FILE` verbatim → `$XDG_CONFIG_HOME/tiktok-mcp-ai/.env` (falling back
 * to `~/.config/...`) on POSIX → `%LOCALAPPDATA%\tiktok-mcp-ai\.env` on win32.
 * `%APPDATA%` is deliberately **not** used: roaming profiles replicate to other
 * machines and tokens must not roam.
 *
 * @param platform Injected so the resolver is testable on every OS leg
 *   (TESTING.md § core/config — "platform injected").
 */
export function resolveEnvFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env['TT_ENV_FILE']?.trim();
  if (override !== undefined && override !== '') return resolve(expandTilde(override));

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim();
    const root =
      localAppData !== undefined && localAppData !== ''
        ? localAppData
        : join(homedir(), 'AppData', 'Local');
    return join(root, APP_DIR, '.env');
  }

  const xdg = env['XDG_CONFIG_HOME']?.trim();
  // The XDG spec says a relative $XDG_CONFIG_HOME must be ignored.
  const root = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(root, APP_DIR, '.env');
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Split while remembering each line's own terminator, so mixed endings survive. */
function splitLines(text: string): { text: string; eol: string }[] {
  const out: { text: string; eol: string }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    const crlf = i > start && text[i - 1] === '\r';
    out.push({ text: text.slice(start, crlf ? i - 1 : i), eol: crlf ? '\r\n' : '\n' });
    start = i + 1;
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: '' });
  return out;
}

/** Strip one layer of matching quotes. No escape processing — see the module docstring. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first))
    return value.slice(1, -1);
  return value;
}

function configError(opts: {
  code: string;
  message: string;
  remediation?: string;
  cause?: unknown;
}): TikTokError {
  return new TikTokError({ kind: 'config', ...opts });
}

/**
 * The errno of a thrown value, when it carries one.
 *
 * Every rejection `node:fs/promises` produces carries a string `code` — a
 * `SystemError` for an I/O failure, an argument `TypeError`/`RangeError`
 * otherwise — so at a site whose only source of errors is `fs`, this never
 * answers `undefined`. Callers that need a code to put in a message or a log
 * field go through {@link errnoFor}, which turns that "never" into a type.
 */
function errnoOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * The code to report for a thrown value: its cause's errno, else its own, else
 * `'unknown'`.
 *
 * The cause comes first because the errors this module raises are wrapping
 * errors: a `TikTokError` from `readEnvFile` carries `env_file_unreadable` in
 * its own `code` and the errno that caused it one level down, and the operator
 * wants the errno. A parse failure has no errno cause, so it reports its own
 * code (`env_file_malformed`) instead, and an `fs` rejection — which has no
 * `cause` at all — reports the errno it carries.
 *
 * This exists as one function rather than as a `?? 'unknown'` written out at
 * each warning site because only one of those sites can reach the fallback: an
 * `fs` rejection always carries an errno, while the injected `rename` seam can
 * reject with anything, including a codeless `Error` or a value that is not an
 * `Error` at all (CC-H3). Repeating the chain per site put five unreachable
 * fallbacks in the file and excluded five whole lines from coverage to hide
 * them — including the two arms here that tests do drive. Written once, every
 * arm is on a path some test takes.
 */
function errnoFor(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  return errnoOf(cause) ?? errnoOf(err) ?? 'unknown';
}

/** Is this key one this build understands? Unknown ones are kept, not dropped. */
function isKnownKey(key: string): boolean {
  if (!key.startsWith('TT_')) return false;
  if (knownSettingVars().has(key)) return true;
  if (key === APP_KEY_NAME.clientKey || key === APP_KEY_NAME.clientSecret) return true;
  for (const suffix of Object.values(TOKEN_KEY_SUFFIX)) {
    if (key === `TT_${suffix}`) return true;
  }
  return PROFILE_KEY.test(key);
}

function parseSnapshot(path: string, text: string, mode: number): ExistingEnvFile {
  const rawLines = splitLines(text);
  const lines: EnvLine[] = [];
  const values = new Map<string, string>();
  const warnings: string[] = [];
  const duplicates = new Set<string>();
  const unknown: string[] = [];
  let crlf = 0;

  rawLines.forEach((raw, index) => {
    if (raw.eol === '\r\n') crlf += 1;
    const trimmed = raw.text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      lines.push({ text: raw.text, eol: raw.eol });
      return;
    }

    const match = KEY_LINE.exec(raw.text.trim()) as KeyLineMatch | null;
    if (match === null) {
      // CC-F1: a malformed line is an error that names the line number.
      throw configError({
        code: 'env_file_malformed',
        message: `${path}: line ${String(index + 1)} is not a comment and not a KEY=value assignment`,
        remediation:
          'Fix or remove that line. Comments must start with # on their own line; values may not span lines.',
      });
    }

    const [, prefix, key, rawValue] = match;

    if (values.has(key)) duplicates.add(key);
    values.set(key, unquote(rawValue)); // CC-F1: last wins.
    if (!isKnownKey(key) && key.startsWith('TT_')) unknown.push(key);

    lines.push(
      prefix === undefined
        ? { text: raw.text, eol: raw.eol, key }
        : { text: raw.text, eol: raw.eol, key, prefix },
    );
  });

  if (duplicates.size > 0) {
    warnings.push(
      `${path}: duplicate keys, last occurrence wins: ${[...duplicates].sort().join(', ')}`,
    );
  }
  if (unknown.length > 0) {
    warnings.push(
      `${path}: unknown TT_ keys ignored (kept on rewrite): ${[...new Set(unknown)].sort().join(', ')}`,
    );
  }

  const declared = values.get('TT_CONFIG_SCHEMA');
  const declaredSchema =
    declared !== undefined && /^\d+$/.test(declared.trim())
      ? Number(declared.trim())
      : undefined;
  if (declared !== undefined && declaredSchema === undefined) {
    warnings.push(
      `${path}: TT_CONFIG_SCHEMA is not a number, reading as ${String(CONFIG_SCHEMA_VERSION)}`,
    );
  }

  const snapshot: ExistingEnvFile = {
    path,
    exists: true,
    values,
    schema: declaredSchema ?? CONFIG_SCHEMA_VERSION,
    warnings,
    lines,
    eol: crlf > 0 && crlf * 2 >= rawLines.length ? '\r\n' : '\n',
    ...(declaredSchema === undefined ? {} : { declaredSchema }),
    mode,
  };
  return snapshot;
}

/**
 * Read and parse the env file (CC-F1).
 *
 * A missing file is not an error — the process environment may carry everything.
 * An unreadable file *is* one: silently continuing would look exactly like "you
 * are not logged in" while the tokens sit right there.
 *
 * Warnings (duplicate keys, unknown `TT_*` keys) are returned on the snapshot
 * rather than logged, so this function stays pure and the composition root
 * decides when and how loudly to report them.
 */
export async function readEnvFile(path: string): Promise<EnvFileSnapshot> {
  let text: string;
  let mode: number;
  try {
    // One `open`, not a `readFile` plus a `stat`: two lookups can land on two
    // different inodes, and a file removed between them would be reported as
    // "no file yet" — the "you are not logged in" answer this function exists to
    // avoid — with the tokens it had just read in hand.
    const handle = await open(path, 'r');
    try {
      text = await handle.readFile('utf8');
      mode = (await handle.stat()).mode & 0o777;
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = errnoFor(err);
    if (code === 'ENOENT') {
      return {
        path,
        exists: false,
        values: new Map(),
        schema: CONFIG_SCHEMA_VERSION,
        warnings: [],
        lines: [],
        eol: '\n',
      };
    }
    throw configError({
      code: 'env_file_unreadable',
      message: `${path}: cannot be read (${code})`,
      remediation:
        code === 'EACCES'
          ? 'Fix the file permissions (it should be readable by you and mode 0600), or point TT_ENV_FILE at a readable path.'
          : 'Check TT_ENV_FILE and the file itself, then retry.',
      cause: err,
    });
  }

  return parseSnapshot(path, text, mode);
}

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

/**
 * The canonical spelling of a profile name, unvalidated: what a caller-given
 * `account` is compared by, so `work`, ` Work ` and `WORK` name one profile.
 */
export function canonicalProfileName(name: string): string {
  return name.trim().toUpperCase();
}

/** Upper-case and validate a profile name (CC-F4). */
export function normalizeProfileName(name: string): string {
  const normalized = canonicalProfileName(name);
  if (!PROFILE_NAME.test(normalized)) {
    throw configError({
      code: 'invalid_profile_name',
      message: `invalid profile name ${JSON.stringify(name)}: expected [A-Z0-9_]+`,
      remediation:
        'Use letters, digits and underscores only, e.g. TT_PROFILE_WORK_ACCESS_TOKEN.',
    });
  }
  return normalized;
}

/**
 * Every profile that exists: the implicit `DEFAULT` plus each `TT_PROFILE_<NAME>_*`
 * declaration, from the env file and the process environment alike.
 *
 * @throws TikTokError when a profile is literally named `DEFAULT` — it collides
 *   with the implicit default sextet, so half its keys would be read from the
 *   bare names and half from the prefixed ones (CC-F4).
 */
export function listProfiles(
  snapshot: EnvFileSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const found = new Set<string>([DEFAULT_PROFILE]);
  const keys = [...snapshot.values.keys(), ...Object.keys(env)];
  for (const key of keys) {
    const match = PROFILE_KEY.exec(key) as ProfileKeyMatch | null;
    if (match === null) continue;
    const name = match[1].toUpperCase();
    if (name === DEFAULT_PROFILE) {
      throw configError({
        code: 'invalid_profile_name',
        message: `${key} declares a profile named ${DEFAULT_PROFILE}, which collides with the implicit default profile`,
        remediation: `Remove the TT_PROFILE_${DEFAULT_PROFILE}_* keys and use the bare TT_ACCESS_TOKEN/TT_REFRESH_TOKEN/… sextet, or rename the profile.`,
      });
    }
    found.add(name);
  }
  return [...found].sort();
}

/**
 * The value of `key` in one source, `undefined` when the source lacks it.
 *
 * `listProfiles` declares a profile from a `TT_PROFILE_<NAME>_*` key in any
 * case (CC-F4), so the read has to find that same key: an exact match wins,
 * and a per-profile key otherwise matches its canonical upper-case spelling.
 * The shared app keys stay exact — they declare nothing.
 */
function presentValue(
  key: string,
  keys: Iterable<string>,
  get: (key: string) => string | undefined,
): string | undefined {
  const exact = get(key);
  if (exact !== undefined || !PROFILE_KEY.test(key)) return exact;
  for (const candidate of keys) {
    if (candidate.toUpperCase() === key) return get(candidate);
  }
  return undefined;
}

/**
 * Read one profile's credentials.
 *
 * Per-key precedence is presence-based (CC-F2): a key that exists in the process
 * environment wins over the env file even when its value is empty, because
 * "exported empty" is a deliberate statement. An empty value then reads as
 * *absent* for the optional token fields (there is no such thing as an empty
 * token) and is rejected for the required app credentials.
 *
 * @param env Injected for tests; defaults to `process.env`.
 * @throws TikTokError `kind: "config"` — unknown profile (listing the ones that
 *   do exist, CC-F4), missing app credentials, or a non-ISO-8601 expiry (CC-H2).
 */
export function readProfile(
  name: string,
  snapshot: EnvFileSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): ProfileCredentials {
  const profile = normalizeProfileName(name);
  const profiles = listProfiles(snapshot, env);
  if (!profiles.includes(profile)) {
    throw configError({
      code: 'unknown_profile',
      message: `unknown profile ${profile}; profiles that exist: ${profiles.join(', ')}`,
      remediation: `Set TT_ACTIVE_PROFILE to one of those, or run "tiktok-mcp-ai login --profile ${profile}" to create it.`,
    });
  }

  /** Presence-based per-key overlay: process env first, then the file (CC-F2). */
  const lookup = (key: string): string | undefined => {
    const raw =
      presentValue(key, Object.keys(env), (k) => env[k]) ??
      presentValue(key, snapshot.values.keys(), (k) => snapshot.values.get(k));
    if (raw === undefined) return undefined;
    const value = raw.trim();
    return value === '' ? undefined : value;
  };

  const problems: string[] = [];
  const clientKey = lookup(envKeyFor(profile, 'clientKey'));
  const clientSecret = lookup(envKeyFor(profile, 'clientSecret'));
  if (clientKey === undefined) problems.push(APP_KEY_NAME.clientKey);
  if (clientSecret === undefined) problems.push(APP_KEY_NAME.clientSecret);
  if (clientKey === undefined || clientSecret === undefined) {
    throw configError({
      code: 'missing_credentials',
      message: `missing TikTok app credentials: ${problems.join(', ')}`,
      remediation:
        'Create an app at developers.tiktok.com, then set TT_CLIENT_KEY and TT_CLIENT_SECRET in the MCP client configuration or the env file.',
    });
  }
  // Every path to the app secret runs through here, so this is where it becomes a
  // secret: a later stack trace or echoed form body must come out masked.
  registerSecret(clientSecret);

  /** CC-H2: persisted times are ISO-8601 UTC; a value that cannot be parsed would become NaN at comparison time. */
  const timestamp = (
    field: 'accessExpiresAt' | 'refreshExpiresAt',
  ): string | undefined => {
    const key = envKeyFor(profile, field);
    const value = lookup(key);
    if (value === undefined) return undefined;
    if (!Number.isFinite(Date.parse(value))) {
      throw configError({
        code: 'invalid_timestamp',
        message: `${key}: expected an ISO-8601 UTC timestamp, got ${JSON.stringify(value)}`,
        remediation:
          'Remove that key and re-run login; expiries are written by login/refresh.',
      });
    }
    return value;
  };

  const accessToken = lookup(envKeyFor(profile, 'accessToken'));
  const refreshToken = lookup(envKeyFor(profile, 'refreshToken'));
  const openId = lookup(envKeyFor(profile, 'openId'));
  const scopes = lookup(envKeyFor(profile, 'scopes'));
  const accessExpiresAt = timestamp('accessExpiresAt');
  const refreshExpiresAt = timestamp('refreshExpiresAt');

  return {
    clientKey,
    clientSecret,
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }),
    ...(openId === undefined ? {} : { openId }),
    ...(scopes === undefined
      ? {}
      : {
          scopes: scopes
            .split(',')
            .map((scope) => scope.trim())
            .filter((scope) => scope !== ''),
        }),
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** Options are additive to the contract signature; every one of them is a test seam. */
export interface PersistOptions {
  clock?: Clock;
  logger?: Logger;
  /** Injected to exercise the CC-H3 EPERM/EBUSY ladder on a POSIX CI leg. */
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

let fallbackLogger: Logger | undefined;
function defaultLogger(): Logger {
  fallbackLogger ??= createLogger();
  return fallbackLogger;
}

/** Distinct temp names without a clock or a random source (both are banned/seamed). */
let tempCounter = 0;

/** Render a value so that parsing it back yields exactly what was passed in. */
function formatValue(key: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new TikTokError({
      kind: 'internal',
      code: 'invalid_env_value',
      message: `${key}: value contains a line break and cannot be stored in the env file`,
    });
  }
  const quoted = value !== value.trim();
  const first = value[0];
  const looksQuoted =
    value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first);
  return quoted || looksQuoted ? `"${value}"` : value;
}

/**
 * The update a document key receives, by the key it is filed under. A
 * per-profile key is the one `presentValue` reads in any case (CC-F4), so it
 * is written in any case too — as its canonical spelling, or a hand-written
 * `TT_PROFILE_work_REFRESH_TOKEN` would outlive the revoke meant to clear it.
 */
function updateKey(
  key: string,
  updates: ReadonlyMap<string, string>,
): string | undefined {
  if (updates.has(key)) return key;
  const canonical = key.toUpperCase();
  return PROFILE_KEY.test(key) && updates.has(canonical) ? canonical : undefined;
}

/**
 * Merge `updates` into the document: rewrite each key's last occurrence in
 * place, drop its earlier duplicates (a stale secret must not linger), append
 * whatever is new. Untouched lines are copied verbatim.
 */
function applyUpdates(
  snapshot: EnvFileSnapshot,
  updates: ReadonlyMap<string, string>,
): string {
  const lines: (EnvLine | undefined)[] = [...snapshot.lines];
  const pending = new Map(updates);
  const rewritten = new Set<string>();

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.key === undefined) continue;
    const key = updateKey(line.key, pending);
    if (key === undefined) continue;

    if (rewritten.has(key)) {
      lines[i] = undefined; // an earlier duplicate of a key we just rewrote
      continue;
    }
    lines[i] = {
      text: `${line.prefix ?? ''}${key}=${formatValue(key, pending.get(key) as string)}`,
      eol: line.eol === '' ? snapshot.eol : line.eol,
      key,
      ...(line.prefix === undefined ? {} : { prefix: line.prefix }),
    };
    rewritten.add(key);
  }
  for (const key of rewritten) pending.delete(key);

  const kept = lines.filter((line): line is EnvLine => line !== undefined);
  if (pending.size > 0) {
    // Terminate the previous last line before appending to it.
    const last = kept.at(-1);
    if (last !== undefined && last.eol === '') {
      kept[kept.length - 1] = { ...last, eol: snapshot.eol };
    }
    for (const [key, value] of pending) {
      kept.push({ text: `${key}=${formatValue(key, value)}`, eol: snapshot.eol, key });
    }
  }

  return kept.map((line) => `${line.text}${line.eol}`).join('');
}

/**
 * Write `contents` to `path` atomically: a fresh `0600` temp file in the same
 * directory, fsync'd, then `rename`d over the target (CONFIGURATION.md § Writes).
 *
 * @returns `false` when the write had to be abandoned — the caller degrades to
 *   in-memory state (CC-H3), it never throws for an I/O failure.
 */
async function atomicWrite(
  path: string,
  contents: string,
  opts: Required<Pick<PersistOptions, 'clock' | 'logger' | 'platform'>> &
    Pick<PersistOptions, 'rename'>,
): Promise<boolean> {
  // A symlinked env file (a dotfiles repo, a mounted secret) is written through
  // to its target: renaming onto the link itself would replace it with a
  // regular file and silently fork the credentials. A dangling link is followed
  // too — its target directory is created below — and the spelling matches the
  // one `withEnvLock` keys its lock on.
  const target = await canonicalPath(path);
  const dir = dirname(target);
  const doRename = opts.rename ?? rename;
  tempCounter += 1;
  const temp = join(dir, `.env.tmp-${String(process.pid)}-${String(tempCounter)}`);

  try {
    const created = await mkdir(dir, { recursive: true, mode: DIR_MODE });
    // Only the directory we just created is ours to harden — never a parent
    // like ~/.config that other tools share.
    if (created !== undefined && opts.platform !== 'win32') await chmod(dir, DIR_MODE);

    // Exclusive: never follow or reuse whatever already sits at the temp name —
    // a planted symlink there would otherwise receive the tokens.
    const handle = await open(temp, 'wx', FILE_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    opts.logger.warn('env file write failed, keeping state in memory only', {
      path,
      code: errnoFor(err),
    });
    await rm(temp, { force: true }).catch(() => undefined);
    return false;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(temp, target);
      // Unconditional per CC-H3: a no-op on win32, the real guarantee on POSIX.
      await chmod(target, FILE_MODE).catch((err: unknown) => {
        opts.logger.warn('could not set env file mode', {
          path,
          code: errnoFor(err),
        });
      });
      return true;
    } catch (err) {
      const code = errnoFor(err);
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RENAME_RETRY_CODES.has(code)) {
        opts.logger.warn('env file rename failed, keeping state in memory only', {
          path,
          code,
          attempts: attempt + 1,
        });
        await rm(temp, { force: true }).catch(() => undefined);
        return false;
      }
      // CC-H3: on Windows a scanner or an open editor holds the file for a few
      // hundred milliseconds; three bounded retries outlive that.
      await opts.clock.sleep(delay);
    }
  }
}

/**
 * Merge `patch` into `profile`'s keys and rewrite the env file.
 *
 * The caller **must** hold `withEnvLock(path, …)`: this is read-merge-write and
 * two unsynchronized writers would lose one of the updates (CC-A2/CC-F5).
 *
 * Only fields present in `patch` are written; a patch never deletes keys.
 *
 * @returns `{ persisted: false }` when the file could not be read or updated. The
 *   caller keeps using the in-memory value and the failure is a warning, never a
 *   failed tool call (CC-H3).
 * @throws TikTokError when the file declares a schema newer than this build
 *   understands — a refusal to write, not a failure to write.
 */
export async function persistProfilePatch(
  path: string,
  profile: string,
  patch: Partial<ProfileCredentials>,
  opts: PersistOptions = {},
): Promise<{ persisted: boolean }> {
  const name = normalizeProfileName(profile);
  const logger = opts.logger ?? defaultLogger();
  const platform = opts.platform ?? process.platform;

  // CC-H3 covers the read half of read-merge-write too: a path component that is
  // really a file (ENOTDIR), or a file this process may not read (EACCES), must
  // degrade to a warning exactly as a failed rename does. Returning here is also
  // the safe answer on its own merits — a document we cannot read is one we must
  // not overwrite with a fresh one. Startup callers still read through
  // `readEnvFile` directly and still get the error.
  let snapshot: EnvFileSnapshot;
  try {
    snapshot = await readEnvFile(path);
  } catch (err) {
    logger.warn('env file could not be read, keeping state in memory only', {
      path,
      code: errnoFor(err),
    });
    return { persisted: false };
  }

  if (snapshot.schema > CONFIG_SCHEMA_VERSION) {
    throw configError({
      code: 'config_schema_too_new',
      message: `${path}: TT_CONFIG_SCHEMA=${String(snapshot.schema)} was written by a newer version of tiktok-mcp-ai (this build understands ${String(CONFIG_SCHEMA_VERSION)}); refusing to write`,
      remediation:
        'This config was written by a newer version — update: `npx tiktok-mcp-ai@latest`.',
    });
  }

  const updates = new Map<string, string>();
  for (const field of Object.keys(TOKEN_KEY_SUFFIX) as TokenField[]) {
    const value = patch[field];
    if (value === undefined) continue;
    updates.set(envKeyFor(name, field), Array.isArray(value) ? value.join(',') : value);
  }
  for (const field of Object.keys(APP_KEY_NAME) as AppField[]) {
    const value = patch[field];
    if (value !== undefined) updates.set(envKeyFor(name, field), value);
  }
  if (updates.size === 0) return { persisted: true };

  // Written on every save (CONFIGURATION.md § Schema versioning).
  updates.set('TT_CONFIG_SCHEMA', String(CONFIG_SCHEMA_VERSION));

  // The first save that moves the marker keeps one copy of the old file, so an
  // upgrade is recoverable. Never migrate on read.
  if (
    snapshot.exists &&
    snapshot.declaredSchema !== undefined &&
    snapshot.declaredSchema !== CONFIG_SCHEMA_VERSION
  ) {
    const backup = `${path}.pre-schema${String(snapshot.declaredSchema)}`;
    try {
      // Created owner-only by the `open` itself, never copied and then
      // tightened: `copyFile` makes the copy at the umask's mode, and for the
      // moment before a `chmod` a file of tokens would be readable by other
      // accounts. `'wx'` keeps COPYFILE_EXCL's promise — an existing copy is
      // never overwritten (EEXIST below). The source is read first, so a read
      // failure cannot leave an empty backup behind that EEXIST would later
      // mistake for a kept copy.
      const bytes = await readFile(path);
      const handle = await open(backup, 'wx', FILE_MODE);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      // The umask can only have narrowed 0600; this pins it to exactly 0600.
      if (platform !== 'win32') await chmod(backup, FILE_MODE);
    } catch (err) {
      // EEXIST means the copy is already there from an earlier attempt, which is
      // the outcome this wanted; anything else is worth a word to the operator.
      const code = errnoFor(err);
      if (code !== 'EEXIST') {
        logger.warn('could not keep a pre-upgrade copy of the env file', {
          path: backup,
          code,
        });
      }
    }
  }

  const contents = applyUpdates(snapshot, updates);
  const persisted = await atomicWrite(path, contents, {
    clock: opts.clock ?? systemClock,
    logger,
    platform,
    ...(opts.rename === undefined ? {} : { rename: opts.rename }),
  });
  return { persisted };
}
