# Module contracts (frozen interfaces for parallel development)

This document exists so that independent agents can implement modules **in
parallel** against each other's public surfaces without waiting for the code.
It freezes exported names, signatures, and error codes; bodies are the owning
task's business (`docs/TASK-BREAKDOWN.md` maps every file to exactly one task).

**Binding force.**

- Everything shown as a TypeScript signature is **normative**: exported names,
  parameter shapes, return shapes, error codes, and stated invariants.
  Doc comments are abbreviated here; full behavior lives in the spec docs
  (ARCHITECTURE.md, TOOLS.md, …) and `docs/reviews/round2/SYNTHESIS.md`.
- Contracts are **frozen at the end of Wave B** (foundation). Before that,
  the owning task may refine its own contract *together with* this file in
  the same change. After the freeze, any change goes through the
  **integrator**: propose → integrator approves → one commit that updates
  CONTRACTS.md and notifies every consuming task.
- Layering is the house rule and is enforced by ESLint:
  `core/` ← `api/` ← `mcp/` ← `tools/`. A contract may only reference types
  from its own layer or lower.
- Language: TypeScript, ESM, `NodeNext` resolution, `zod` for schemas.
  Types named here but not defined (`UserInfo`, `CreatorInfo`, …) are owned
  by the module that exports them and mirror the platform shapes in
  TIKTOK-API.md.

**What this file does NOT cover.** The inventory is *cross-task surface*, not
every module in `src/`. A module is absent on purpose when nothing another
task depends on crosses its boundary — it exports only into its own layer's
composition root, so its owner designs the surface when the task runs.
`src/mcp/lifecycle.ts` (TE-6 / WP-3.5 — credential-store watch and
`tools/list_changed`) was the deliberate case: it lands in Wave E, consumes
contracts already frozen here, and exported nothing a Wave B–D task compiled
against, so freezing a speculative signature for it would have pinned a design
that had not been done. Its § below was written when the task ran — an
addition, not a contract change, which is exactly what such a module's arrival
is meant to be.

---

## core/errors.ts

```ts
export type ErrorKind =
  | "config"      // startup/env problems
  | "auth"        // token/scope problems (incl. terminal re-login)
  | "api"         // upstream { error.code !== "ok" }
  | "network"     // transport failures
  | "validation"  // local input rejection (no network spent)
  | "policy"      // local write-safety rejection (plan, duplicate, rate)
  | "internal";

export class TikTokError extends Error {
  readonly kind: ErrorKind;
  /** Stable machine code, e.g. "local_rate_limited", "plan_not_found",
   *  "env_file_busy", "network_unsent". Catalog + normative user texts:
   *  TOOLS.md error catalog (substring-tested). */
  readonly code: string;
  readonly apiCode?: string;   // upstream error.code, when kind === "api"
  readonly logId?: string;     // upstream log_id, when present (CC-B9: optional)
  readonly retryable: boolean;
  readonly remediation?: string;
  constructor(opts: {
    kind: ErrorKind; code: string; message: string;
    apiCode?: string; logId?: string; retryable?: boolean;
    remediation?: string; cause?: unknown;
  });
}

export function isTikTokError(e: unknown): e is TikTokError;
```

## core/log.ts

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** JSON lines on stderr ONLY (stdout purity, CC-G3). Every field value
 *  passes through core/redact before serialization. `clock` is the time seam
 *  for the record `ts` (defaults to systemClock) so log output is
 *  byte-deterministic under mockClock — CC-H4. */
export function createLogger(opts?: { level?: LogLevel; clock?: Clock }): Logger;

/** The fallback for every optional `logger?` option in core/*: writes nowhere,
 *  at any level, so importing a module never touches a stream its embedder did
 *  not open (CC-G3). `child()` returns the same instance. */
export const silentLogger: Logger;
```

## core/redact.ts

```ts
/** Allowlist-based deep redaction — unknown keys are redacted by default. */
export function redactValue(value: unknown): unknown;
/** `redactValue` for a plain record, typed record-in, record-out: the same
 *  walk (nested default-deny, depth limit, cycle marking, key rules), so
 *  `redactRecord(r)` deep-equals `redactValue(r)` for every plain object `r`.
 *  What `core/log` applies to a record's fields. */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown>;

/** Register an exact secret value (tokens, client_secret, upload_token —
 *  upload_token is a secret sink per SYNTHESIS § 2.5). */
export function registerSecret(secret: string): void;

/** Scrub every registered secret out of free text (error messages, body
 *  snippets). */
export function redactText(text: string): string;
```

**Which function applies where.** `redactValue` is default-deny, so it is for
*structured diagnostics only* — log fields, journal records, error details.
It must **never** be applied to `ToolResult.data`: an allowlist would gut every
upstream payload (video ids, cover URLs, …). `mcp/result` scrubs the serialized
result with **`redactText`** before truncation instead. A consumer that needs
default-deny over tool data would be a contract change, not a local decision.

**The field allowlist is a shared resource.** It lives inside
`src/core/redact.ts`. A task that logs a *new* structured field name must add
that name to the allowlist, or its value silently becomes `[REDACTED]`. Because
`redact.ts` is owned by TB-4, later tasks request the addition through the
integrator (same process as a contract change) rather than editing the file.

## core/json.ts

```ts
/** THE single canonicalization in the codebase (SYNTHESIS § 2.8):
 *  recursively key-sorted objects, no whitespace, UTF-8;
 *  absent ≡ undefined ≡ omitted. Used by plan digests and title hashes;
 *  a second implementation must not exist. */
export function canonicalJson(value: unknown): string;

export function sha256Hex(data: string | Uint8Array): string;
```

**`canonicalJson` is a wire format, not an implementation detail.** Its output
feeds the plan digest that makes `plan_id` single-use and the journal duplicate
guard's title hash, so *any* behavior change silently invalidates every
`plan_id` already issued to a user. The decisions below are therefore part of
the frozen contract, not local choices of the owning task:

| Case | Behavior |
|---|---|
| Key ordering | ascending **UTF-16 code-unit** order; `localeCompare` and `Intl` are banned (environment-dependent) |
| Own property `=== undefined` | dropped — *absent ≡ undefined ≡ omitted* |
| `null` | a value, emitted as `null` — `{a:null}` ≠ `{}` |
| `undefined` at root or as an array element | **rejected** (mapping it to `null` would conflate it with a real `null`) |
| Array hole | **rejected** |
| `NaN`, `±Infinity` | **rejected** (`JSON.stringify` collapses all three to `null`) |
| `-0` | normalized to `0` — one number, one digest |
| Number form | ECMAScript `Number::toString` (shortest round-tripping decimal) |
| `bigint` | **rejected** — no lossless JSON number; quoting collides with the string |
| `Date` | **rejected**; `toJSON` is deliberately *not* consulted (would collide with its own ISO string). Timestamps are already ISO-8601 strings, CC-H2 |
| `Map`/`Set`/typed array/`RegExp`/`Error`/class instance/boxed primitive | **rejected** — `JSON.stringify` renders most as `{}`, making them all digest-identical |
| "Plain object" | prototype is `Object.prototype` **or** `null`; anything else is rejected |
| Function or symbol value | **rejected** |
| Own symbol-keyed property | rejects the **whole object** — nothing is silently dropped except contract-mandated `undefined` properties |
| Cycle | **rejected**, detected on the ancestor chain; a repeated *acyclic* reference is legal and serialized twice |
| Unicode | **never normalized** — NFC/NFD variants are distinct payloads upstream and stay distinct here |
| `__proto__`, `constructor` as keys | ordinary own keys, no special meaning |
| String escaping | `JSON.stringify`'s ES2019 well-formed escaping — output is always UTF-8-encodable |
| Depth | unbounded by design; an adversarially deep structure throws `RangeError` (a rejection, never a corrupted digest) |
| Getters | read **exactly once** |
| Rejection type | plain `TypeError` (`RangeError` for depth) — *not* `TikTokError`; core/json sits below the error taxonomy. Messages carry the JSON path (keys and indices only, never values) |

## core/clock.ts

```ts
export interface Clock {
  now(): number;                                        // epoch ms
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock;
```

Every time-dependent module takes an injectable `Clock` (CC-H4 — tests never
sleep).

## core/net.ts

```ts
/** `AddressInfo.port` when the server bound one; `fallback` for the string and
 *  `null` arms `Server.address()` is typed for but a host:port bind never yields. */
export function boundPortOf(
  address: AddressInfo | string | null, fallback: number,
): number;
```

The one listener-side helper both servers this package binds share — the MCP
HTTP transport (`mcp/http`) and the login loopback callback (`cli/login`). It
lives in `core/` because `mcp/` may not import `cli/`: until 2026-09-18 the same
one-liner existed in both layers (`mcp/http`'s `boundPortOf`, `cli/login`'s
`effectivePort`). Each caller binds a `host:port` and reads the address after
the awaited bind, so only the `AddressInfo` arm is ever taken in practice; the
type cannot say so, and the other two arms answer with the asked-for port
rather than with a port nothing is listening on. Split out as an ordinary
function so all three arms are decided by `test/net.test.ts` rather than
excluded from coverage.

## core/settings.ts

```ts
/** One field per TT_ variable in CONFIGURATION.md (that table is the
 *  authoritative list). Naming rule: strip `TT_`, camelCase —
 *  TT_PLAN_TTL_S → planTtlS, TT_ENV_LOCK_WAIT_MS → envLockWaitMs, … */
export interface Settings {
  envFile?: string;            // TT_ENV_FILE
  activeProfile: string;       // TT_ACTIVE_PROFILE (default "DEFAULT")
  writeMode: "plan" | "apply" | "deny";   // TT_WRITE_MODE, default "plan"
  timeoutMs: number;           // TT_TIMEOUT_MS
  uploadTimeoutMs: number;     // TT_UPLOAD_TIMEOUT_MS (per chunk PUT, CC-D7)
  statusPollTimeoutMs: number; // TT_STATUS_POLL_TIMEOUT_MS
  tokenRefreshSkewS: number;   // TT_TOKEN_REFRESH_SKEW_S
  planTtlS: number;            // TT_PLAN_TTL_S, default 600
  planMaxOutstanding: number;  // TT_PLAN_MAX_OUTSTANDING, default 32
  envLockHeartbeatMs: number;  // default 2_000
  envLockStaleMs: number;      // default 15_000
  envLockWaitMs: number;       // default 30_000
  journalMaxBytes: number;     // TT_JOURNAL_MAX_BYTES, default 5_242_880
  chunkRetries: number;        // TT_CHUNK_RETRIES, default 3
  mediaRoot?: string;          // TT_MEDIA_ROOT (fail-closed for FILE_UPLOAD)
  redirectPort?: number;       // TT_REDIRECT_PORT (optional pin, CC-A8)
  // …one field per remaining TT_ var; keep in lockstep with CONFIGURATION.md
}

/** Zod-validated; ALL problems aggregated into one startup error (CC-F6).
 *  Presence-based, not truthiness-based (CC-F2); values trimmed; numbers are
 *  plain decimal digits only; a secret is reported as `<redacted>`, never by
 *  value. Error code: "invalid_configuration" (kind "config"). */
export function loadSettings(env?: NodeJS.ProcessEnv): Settings;

/** The TT_ variable a Settings field came from — the inverse of the naming
 *  rule above. Consumed by `doctor` and by the CONFIGURATION.md drift test. */
export function settingVarName(field: string): string;

/** Every TT_ name this build understands, for "did you mean" diagnostics. */
export function knownSettingVars(): ReadonlySet<string>;

/** A bare host name in the form the WHATWG URL parser gives it — lowercased,
 *  IPv6 compressed and unbracketed, numeric IPv4 shorthands expanded
 *  (`127.1` → `127.0.0.1`). `undefined` for anything that is not a bare host:
 *  a port, a path, userinfo, an IPv6 zone id (`fe80::1%eth0`), or a name the
 *  parser rejects. TT_HTTP_ALLOWED_HOSTS entries are stored in this form, and
 *  mcp/http canonicalizes the `Host` hostname through it before comparing. */
export function canonicalHostName(value: string): string | undefined;
```

## core/config.ts (env file + profiles)

```ts
export interface ProfileCredentials {
  clientKey: string;
  clientSecret: string;
  accessToken?: string;
  accessExpiresAt?: string;    // ISO-8601 UTC (CC-H2)
  refreshToken?: string;
  refreshExpiresAt?: string;
  openId?: string;
  scopes?: string[];
}

/** The env file is a *document*, not a key-value store: one entry per physical
 *  line, so comments, blank lines, CRLF and unknown TT_* survive a rewrite
 *  byte-for-byte (CC-F1). Inline comments are not a thing — a `#` inside a
 *  value is part of the value. */
export interface EnvLine {
  readonly text: string;      // verbatim, without the EOL
  readonly eol: string;       // "" on a last line with no trailing newline
  readonly key?: string;      // set iff this line assigns a TT_ key
  readonly prefix?: string;   // "KEY=" — everything the rewrite must preserve
}

/** A snapshot: reads never observe a later write (CC-F2 overlay applies on
 *  top of it, not inside it). Discriminated on `exists`: `readEnvFile` builds
 *  exactly two literals, and each either has a mode or cannot have one, so a
 *  caller that wants `mode` narrows on `exists` first — the one question that
 *  decides whether a mode exists at all. (An optional `mode?` on a single shape
 *  only ever manufactured guards nothing could reach — TESTING.md § What to do
 *  with an uncovered branch, verdict 5.) */
export type EnvFileSnapshot = ExistingEnvFile | MissingEnvFile;

/** The file was there and was read; `mode` came off the SAME handle as the
 *  bytes (one `open`, not `readFile` + `stat`), so it describes the file those
 *  bytes came from and is never absent. */
export interface ExistingEnvFile extends EnvFileSnapshotBase {
  readonly exists: true;
  readonly mode: number;                // st_mode & 0o777 — meaningful on POSIX only (CC-F3)
}

/** No file yet — legal, not an error: the process environment may carry
 *  everything (CC-F1). No mode, so this arm declares none. */
export interface MissingEnvFile extends EnvFileSnapshotBase {
  readonly exists: false;
}

/** What both arms carry (not exported). */
interface EnvFileSnapshotBase {
  readonly path: string;
  readonly values: ReadonlyMap<string, string>;
  readonly declaredSchema?: number;     // as written in the file, if present
  readonly schema: number;              // effective (defaults to 1)
  readonly warnings: readonly string[]; // duplicate keys, unknown TT_* keys, …
  readonly lines: readonly EnvLine[];
  readonly eol: "\n" | "\r\n";          // the file's own dominant EOL
}

export const CONFIG_SCHEMA_VERSION = 1;

/** The env key a profile's field lives under: the DEFAULT profile uses the bare
 *  sextet (TT_ACCESS_TOKEN, …), any other profile the TT_PROFILE_<NAME>_* form. */
export function envKeyFor(profile: string, field: string): string;

/** Resolution order (SYNTHESIS § 2.1): TT_ENV_FILE → XDG config dir on
 *  POSIX → %LOCALAPPDATA%\tiktok-mcp-ai\.env on win32 (never %APPDATA% —
 *  roaming profiles replicate, and tokens must not roam).
 *  `platform` is injected so the resolver is testable on every OS leg. */
export function resolveEnvFilePath(
  env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
): string;

/** Comment/CRLF-preserving parse (CC-F1); duplicate key: last wins + warn.
 *  Error codes: "env_file_malformed", "env_file_unreadable" (cause = the errno
 *  error), "config_schema_too_new". */
export function readEnvFile(path: string): Promise<EnvFileSnapshot>;

/** The spelling a caller-given `account` is compared by: trimmed and
 *  upper-cased, not validated — so `work`, ` Work ` and `WORK` name one
 *  profile. */
export function canonicalProfileName(name: string): string;

/** Upper-cased, validated profile name; the sole gate on what may become part
 *  of an env key. Error code: "invalid_profile_name". */
export function normalizeProfileName(name: string): string;

/** Every profile the snapshot + process env declare, DEFAULT always included
 *  and always first-class; an explicit TT_PROFILE_DEFAULT_* key is an error
 *  (CC-F4). */
export function listProfiles(
  snapshot: EnvFileSnapshot, env?: NodeJS.ProcessEnv,
): readonly string[];

/** Read profile after presence-based process-env overlay (CC-F2). A per-profile
 *  key is found in any case, as listProfiles declares it (TT_PROFILE_work_* is
 *  profile WORK): in each source the exact spelling wins, and process env still
 *  wins over the file. Error codes: "unknown_profile" (listing the ones that
 *  exist), "missing_credentials", "invalid_timestamp" (CC-H2). */
export function readProfile(
  name: string, snapshot: EnvFileSnapshot, env?: NodeJS.ProcessEnv,
): ProfileCredentials;

/** Every option is a test seam; all four are additive and optional. */
export interface PersistOptions {
  clock?: Clock;
  logger?: Logger;
  rename?: (from: string, to: string) => Promise<void>;  // CC-H3 ladder on POSIX
  platform?: NodeJS.Platform;
}

/** Atomic write (temp + rename), fs.chmod(0o600) unconditionally (no-op on
 *  win32, asserted POSIX-only). A symlinked env file is written through to its
 *  canonicalPath target (the link is kept, not replaced by a regular file); a
 *  dangling link, or a chain of them, is followed too — the final target's
 *  parent directory is created and the file lands where the chain ends, with
 *  every link in it kept. The
 *  temp file is opened exclusively ('wx') so nothing pre-existing at the temp
 *  name is followed or reused; EPERM/EBUSY/EACCES rename retried ×3
 *  (50/100/200 ms) then degrade to in-memory + warn (CC-H3). The *read* half of
 *  read-merge-write degrades identically: a document this process cannot read is
 *  one it must not overwrite. Callers MUST hold withEnvLock — this function does
 *  not take the lock itself.
 *  @throws only when the file declares a newer schema — a refusal to write,
 *    not a failure to write. */
export function persistProfilePatch(
  path: string, profile: string, patch: Partial<ProfileCredentials>,
  opts?: PersistOptions,
): Promise<{ persisted: boolean }>;   // persisted:false = degraded in-memory
```

## core/env-lock.ts

```ts
export interface EnvLockOptions {
  waitMs?: number;       // default settings.envLockWaitMs (30_000), ±jitter
  staleMs?: number;      // default 15_000 — stale ⇒ remove + re-acquire + warn
  heartbeatMs?: number;  // default 2_000 — mtime touch on the lock dir
  clock?: Clock;
  logger?: Logger;       // where the stale-break warning goes; no global sink
  random?: () => number; // [0,1) jitter seam; out-of-range values are clamped
  /** What the messages call the lock and the file it guards; default the env
   *  file's wording ("env-file" lock, "the credential file"). Journal rotation
   *  passes { lock: "journal rotation", guards: "the publish journal" }. */
  label?: { lock: string; guards: string };
}

/** The lock directory for an env file: `<envfile>.lock`, a sibling so it
 *  shares the file system and the parent's permissions. Exported for
 *  `doctor`, which reports stale locks. */
export function envLockDir(envFilePath: string): string;

/** The one spelling of a file every writer agrees on: symlinks resolved
 *  (realpath), a dangling chain followed hop by hop (a relative target read
 *  against the link's real directory) to the path it will create, and a file
 *  that does not exist yet placed under its parent's real directory. Up to
 *  MAX_LINK_HOPS (40, Linux's SYMLOOP_MAX) links are followed; a loop has no
 *  end, so the path is returned as given (resolved) and the read that follows
 *  reports the loop. Every link in a chain therefore resolves to the same
 *  spelling — one lock, and no link mid-chain is replaced by a regular file. withEnvLock
 *  keys the lock directory on it, core/config's atomic write targets it, and
 *  doctor reports the lock at envLockDir(canonicalPath(file)) — so a symlink
 *  and its target share ONE lock (two names would exclude nothing while
 *  writing the same bytes). */
export function canonicalPath(path: string): Promise<string>;

/** Cross-process mutex around the env file (SYNTHESIS § 2.2):
 *  fs.mkdir("<canonicalPath(envfile)>.lock") acquisition (atomic on every platform/FS);
 *  a JSON {pid,hostname,createdAt} file inside is diagnostic only —
 *  liveness is mtime-only. Timeout ⇒ TikTokError code "env_file_busy".
 *  Caller obligation (oauth): on timeout re-read the env once and adopt a
 *  rotated token before surfacing the error. Journal appends do NOT take
 *  this lock (O_APPEND); journal rotation uses the same mutex keyed on the
 *  journal path (journal.ndjson.lock), never the env file's.
 *
 *  Degradation (CC-H3 — lock trouble never costs a valid token):
 *   - a duration option that is not a usable number ⇒ documented default +
 *     an "invalid_env_lock_duration" warning, never a throw;
 *   - heartbeatMs >= staleMs ⇒ "env_lock_heartbeat_too_slow" warning
 *     (core/settings rejects the combination outright for TT_ENV_LOCK_*);
 *   - a lock directory that cannot be created at all ⇒ non-retryable
 *     "env_lock_unusable"; fn never runs;
 *   - at most 3 stale reclaims per call, so a crash-looping competitor
 *     cannot spin one acquisition forever;
 *   - a lock lost while held (heartbeat sees ENOENT) is reported and NOT
 *     deleted on release — it belongs to whoever holds it now;
 *   - release failures are warnings: fn's value or error is what surfaces. */
export function withEnvLock<T>(
  envFilePath: string, fn: () => Promise<T>, opts?: EnvLockOptions,
): Promise<T>;
```

**`settings.envFile` and `resolveEnvFilePath(env)` are the same answer, by
construction.** Two call sites reach the credential file two ways —
`api/context.ts` uses `ctx.settings.envFile ?? resolveEnvFilePath(env)`, while
`core/oauth`'s refresh path calls `resolveEnvFilePath(env)` outright — and that
asymmetry is deliberate, not drift. `core/settings` defines `envFile` as
`resolve(expandTilde(TT_ENV_FILE))`, which is character-for-character what
`resolveEnvFilePath` does with the same key, so the two agree for every env that
sets it and the `??` picks up the identical platform default for every env that
does not. `core/oauth` therefore does not need a `Settings` it would only use to
re-derive a path it can compute, and `api/context` does not need to drop a
`Settings` it already holds.

The invariant this rests on: **a caller builds `Settings` from the same env it
later passes down.** The composition roots do (`cli/index.ts`, `mcp/server.ts`
each load settings from one `env` object and thread that object onward). Anything
that mixes them — settings from a captured env, calls with `process.env` — makes
the two resolve differently, and the refresh then writes to a file the reader is
not watching. That is the bug to look for before "fixing" either side to match
the other.

## core/http.ts

```ts
export type RetryClass = "read" | "init" | "chunk";
// read:  retry 429/5xx/network with backoff + Retry-After (CC-B3)
// init:  NEVER retried (CC-B4/B5); upstream 429 on init is terminal (CC-B8);
//        a 2xx/5xx without a readable envelope, or a 5xx without error.code,
//        is "network_ambiguous" like a timeout (CC-B2/B5)
// chunk: 1 + settings.chunkRetries attempts, identical Content-Range (CC-B7).
//        In-call only for a replayable (Uint8Array) body; a streamed body
//        cannot be re-read, so putChunk makes ONE attempt and api/upload owns
//        the loop, re-opening the file range per attempt. Same total either way.

export type LookupFn = typeof import("node:dns").lookup;

export interface TtRequestOptions {
  method: "GET" | "POST";
  url: string;                    // must pass assertAllowedUrl(url, "api")
  body?: unknown;                 // JSON payload; POST only
  retryClass: RetryClass;
  bearer?: string;                // absent on OAuth + upload calls
  timeoutMs?: number;             // per attempt, default 30_000 (TT_TIMEOUT_MS)
  signal?: AbortSignal;
  clock?: Clock;
  lookup?: LookupFn;              // injectable DNS seam (SYNTHESIS § 2.6)
  // ---- additive options (Wave-B approved deviation) ----
  maxAttempts?: number;           // read class only, default 3; clamped to >= 1
  budgetMs?: number;              // whole call incl. backoff, default timeoutMs * maxAttempts
  logger?: Logger;                // default: silent — core has no global sink
  random?: () => number;          // jitter seam, default Math.random
}

/** Options oauthRequest accepts. OAuth is never retried, so there is no class
 *  to pass; named because it is part of two public signatures. */
export type OauthRequestOptions = Omit<TtRequestOptions, "retryClass">;

/** {data,error} envelope decoder; error.code !== "ok" ⇒ TikTokError kind:"api"
 *  (CC-B1); non-JSON tolerated (CC-B2) — for the init class it is
 *  "network_ambiguous" on a 2xx/5xx; an "ok" envelope whose `data` is null,
 *  a scalar or an array ⇒ "network_ambiguous" for the init class,
 *  "upstream_error" (not retried) otherwise (CC-B2); redirect:"error" (CC-B6). */
export function ttRequest<T>(opts: TtRequestOptions): Promise<T>;

/** Flat OAuth-shape decoder (error/error_description/log_id) — the envelope
 *  decoder must NOT be applied (CC-A12). Body may be a record, a string or a
 *  URLSearchParams and is sent form-encoded; anything else ⇒ "invalid_params".
 *  Never sets Authorization. */
export function oauthRequest<T>(opts: OauthRequestOptions): Promise<T>;

/** Egress allowlist (SYNTHESIS § 2.5): host accepted iff exactly
 *  open.tiktokapis.com, exactly open-upload.tiktokapis.com, or matches
 *  /^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$/. WHATWG-parsed, https-only,
 *  no userinfo, port 443 only. Bare endsWith is banned. Widening = spec edit.
 *  @throws TikTokError code "egress_blocked" before any socket is opened. */
export function assertAllowedUrl(url: string, kind: "api" | "upload"): URL;

export interface ChunkPutResult { status: number; uploadedBytes?: number }

export interface PutChunkOptions {
  uploadUrl: string;              // must pass assertAllowedUrl(url, "upload")
  contentRange: string;           // byte-identical across retries (CC-D6)
  contentType: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
  timeoutMs: number;              // per attempt; TT_UPLOAD_TIMEOUT_MS lives in settings
  signal?: AbortSignal;
  // ---- additive options (Wave-B approved deviation) ----
  clock?: Clock;
  lookup?: LookupFn;
  chunkRetries?: number;          // retries after attempt 1, default 3
  budgetMs?: number;              // whole chunk incl. backoff, default timeoutMs * attempts
  logger?: Logger;
  random?: () => number;
  contentLength?: number;         // required for a stream body (TIKTOK-API § 4.6)
}

/** No Authorization header ever (upload_token in URL is the credential and a
 *  registered secret). 4xx terminal; 403 = expired URL; 416 ⇒ caller resyncs
 *  from uploadedBytes. A non-replayable (stream) body forces a single attempt:
 *  the bytes cannot be re-sent, so a retry would put a truncated range on the
 *  wire. 5xx ⇒ retryable "upstream_error"; every other status resolves. */
export function putChunk(opts: PutChunkOptions): Promise<ChunkPutResult>;
```

**Failure codes (contract — callers and `mcp/result` branch on them).**
`egress_blocked` (kind `validation`, never retryable — also raised when a
redirect is refused, CC-B6); `network_ambiguous` (an `init` whose transport
failed or timed out — CC-B4/B5 — or that was answered without TikTok's
envelope: a `2xx`/`5xx` whose body is not JSON or not a JSON object, or a `5xx`
envelope without `error.code` — CC-B2/B5 — or an `ok` envelope whose `data`
is `null`, a scalar or an array — CC-B2; terminal, remediation points at the
publish journal, and the tool layer journals it `send_ambiguous`; a `4xx` and
an explicit `error.code` keep their normal mapping); `network_error` and `timeout` (retryable, `read`/`chunk` only);
`rate_limited` (CC-B8, carries the wait hint); `upstream_error` (a 5xx on a
chunk PUT; an `ok` envelope whose `data` is not an object on a non-init call,
CC-B2 — not retried); `invalid_params` (a non-positive duration option, a `GET` with a
body, an unencodable OAuth body).

**Retry ladder.** A failure that never produced a response — a blocked DNS
answer, a socket error, a per-attempt timeout — reaches the ladder as an
*outcome*, not as a throw, so the class decision governs it: `read` and `chunk`
retry it, `init` does not. A caller abort is never an outcome and unwinds
verbatim. Backoff is `min(500 · 2^(n-1), 8000)` plus up to 25 % jitter from
`random`; `Retry-After` (delta-seconds or HTTP-date) overrides it, capped at
30 s **and** at the remaining budget.

## core/oauth.ts

```ts
export interface TokenSet {
  accessToken: string; accessExpiresAt: string;
  refreshToken: string; refreshExpiresAt: string;
  openId: string; scopes: string[];
}

/** PKCE challenge = LOWERCASE HEX SHA-256 of the verifier (CC-A13 CONFIRMED;
 *  TikTok deviation from RFC 7636). Pinned test vector in AUTH.md. The only
 *  place the encoding exists. */
export function pkceChallenge(verifier: string): string;

/** Seams every network-facing entry point shares; all optional, all additive. */
interface CallSeams {
  clock?: Clock; logger?: Logger; signal?: AbortSignal;
  timeoutMs?: number; lookup?: LookupFn; settings?: Settings;
}

export interface BuildAuthUrlOptions {
  clientKey: string; scopes: string[]; redirectUri: string;
  randomBytes?: (size: number) => Uint8Array;   // entropy seam
  settings?: Settings;
}
export function buildAuthUrl(
  opts: BuildAuthUrlOptions,
): { url: string; state: string; verifier: string };

export interface ExchangeCodeOptions extends CallSeams {
  clientKey: string; clientSecret: string; code: string;
  verifier: string; redirectUri: string;
}
export function exchangeCode(opts: ExchangeCodeOptions): Promise<TokenSet>;

export interface RefreshDeps extends CallSeams {
  /** Refresh even when the cached token is still fresh — the 401 replay's one
   *  forced refresh (ARCHITECTURE § 6). Under `force`, a token found on disk is
   *  adopted only when it DIFFERS from the one this process already holds:
   *  the caller is here because TikTok rejected that one. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;                        // overrides process.env
  rename?: (from: string, to: string) => Promise<void>;   // CC-H3 write seam
}
export type RevokeDeps = CallSeams & {
  env?: NodeJS.ProcessEnv;
  rename?: (from: string, to: string) => Promise<void>;
};

/** Single-flight per profile in-process + withEnvLock across processes.
 *  Rotated refresh token persisted BEFORE first use of the new access token
 *  (CC-A1/A2). invalid_grant: re-read env once under the lock, adopt + retry
 *  once, else terminal re-login error (SYNTHESIS § 2.2). No refresh token on
 *  file and none in the process env (another process ran `login --revoke`):
 *  the in-memory one is NOT spent — that would resurrect the profile — the
 *  adopted set is dropped and `auth_expired` is thrown. */
export function ensureFreshAccessToken(
  profile: string, deps?: RefreshDeps,
): Promise<string>;

/** Revocation KEEPS the journal (SYNTHESIS § 2.10); purge is a separate,
 *  explicit CLI flag. Clears the six token keys and the in-process cache. The
 *  access token is registered as a secret before the revoke request is sent.
 *  Under the env lock the profile is re-read; an access token a concurrent
 *  refresh rotated in since the first read is revoked as well (with the
 *  re-read client credentials), and `upstream` reports that second call.
 *  A failed local clear is returned (`cleared: false`), not thrown, so the CLI
 *  can still say what happened upstream (AUTH.md § 4). */
export interface RevokeOutcome {
  readonly profile: string;
  readonly envFilePath: string;
  readonly upstream: 'none' | 'revoked' | 'unconfirmed';
  readonly cleared: boolean;
}
export function revokeToken(profile: string, deps?: RevokeDeps): Promise<RevokeOutcome>;

/** Drops the in-process credential cache (adopted set + spent-token memo).
 *  Test seam: module state is per-process by design. */
export function resetTokenCache(): void;
```

Two pieces of per-process state sit behind these functions. The **adopted set** is
the credential cache single-flight hands out. The **spent-token memo** records
every refresh token each profile has sent to TikTok: CC-F2 makes a
`TT_REFRESH_TOKEN` pinned in the MCP client's config win over the file forever, so
without the memo every refresh after the first would spend the same dead token
(every value, not only the last — after two rotations the pinned token is no
longer the latest spend, yet still dead). `revokeToken`
clears both — a memo left next to no credentials would make the next login's
first refresh look like a replay.

## api/* (shared context)

```ts
// api/context.ts
export interface AccessTokenOptions {
  /** Refresh before answering. Only the 401 replay below sets it. */
  force?: boolean;
}
export interface ApiContext {
  profile: string;
  settings: Settings;
  log: Logger;
  clock: Clock;
  getAccessToken(opts?: AccessTokenOptions): Promise<string>;  // wraps ensureFreshAccessToken
}

export interface CreateApiContextOptions {
  profile: string;
  settings: Settings;
  log: Logger;                 // the factory binds `profile` onto it
  clock?: Clock;
  env?: NodeJS.ProcessEnv;     // test seam for the credential read
  /** Token resolver; defaults to `ensureFreshAccessToken`. Test seam. */
  refresh?: (profile: string, deps: RefreshDeps) => Promise<string>;
}
export function createApiContext(opts: CreateApiContextOptions): ApiContext;

/** Every Display call goes through this, so the 401 rule has one home. */
export interface ApiRequestOptions {
  method: "GET" | "POST";
  path: string;                    // absolute path on the TikTok origin
  fields?: readonly string[];      // joined unescaped — values come from frozen enums;
                                   // absent or empty ⇒ no `?fields=` at all (a publish
                                   // endpoint takes none, and `?fields=` reads as malformed)
  retryClass?: RetryClass;         // defaults to "read"; a publish init passes "init"
  body?: unknown;                  // a GET must not have one (core/http rejects it)
  signal?: AbortSignal;
}
export function apiRequest<T>(ctx: ApiContext, opts: ApiRequestOptions): Promise<T>;

/** A 200 whose payload is not the documented shape. `upstream_error`, not retryable. */
export function malformedPayload(endpoint: string, expected: string): TikTokError;

export interface ProfileCredentialSummary {
  name: string;
  isDefault: boolean;              // the profile a call with no `account` resolves to
  openId?: string;
  scopes: readonly string[];       // what TikTok granted — a partial grant is normal (CC-A7)
  tokenExpiresAt?: string;         // ISO-8601 UTC (CC-H2)
  refreshExpiresAt?: string;
}
/** Re-read on EVERY call by contract (TOOLS.md § 6.2) — a `login` in another
 *  terminal changes the answer, and a cached snapshot would let a stale
 *  `[UNAVAILABLE]` outlive the grant that fixed it. */
export function readCredentialSnapshot(
  ctx: ApiContext, env?: NodeJS.ProcessEnv,
): Promise<readonly ProfileCredentialSummary[]>;
export function grantedScopes(
  ctx: ApiContext, env?: NodeJS.ProcessEnv,
): Promise<readonly string[]>;

/** `open_id` for a result: `abcd…wxyz`, or `…` when too short to halve. */
export function maskOpenId(openId: string): string;
```

**The 401-refresh-and-replay lives here**, in `apiRequest` — not in `core/http`
and not in `core/oauth`, both of which ARCHITECTURE § 6 could be read as naming.
`core/http` classifies transport and upstream failures but knows nothing about
credentials; `core/oauth` owns the token but never sees a Display response. Only
this function sees both. A rejected access token buys **exactly one** forced
refresh and **exactly one** replay, for the `read` class only; a second rejection
is terminal.

```ts
// api/user.ts
export const USER_FIELDS: readonly UserField[];              // the documented vocabulary
export type UserField = (typeof USER_FIELDS)[number];
export const USER_FIELD_SCOPES: Readonly<Record<UserField, string>>;  // field → scope
/** A payload whose `user` is absent or `null` is `malformedPayload` (`upstream_error`). */
export function getUserInfo(
  ctx: ApiContext, fields: string[], opts?: { signal?: AbortSignal },
): Promise<UserInfo>;

// api/video.ts
// A `videos` value that is not an array, or an entry that is not an object
// with a string `id`, is `malformedPayload(<endpoint>, …)` (`upstream_error`)
// on both endpoints — `id` is what pagination and CC-C7 key on.
export const VIDEO_FIELDS: readonly VideoField[];
export type VideoField = (typeof VIDEO_FIELDS)[number];
export const DEFAULT_VIDEO_FIELDS: readonly VideoField[];
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 20;
export const MAX_QUERY_IDS = 20;

export interface ListVideosOptions {
  cursor?: string;                  // absent means "from the start" (CC-C1)
  maxCount?: number;                // re-clamped to MIN/MAX_PAGE_SIZE here (CC-C5)
  fields?: readonly string[];       // DEFAULT_VIDEO_FIELDS when absent
  signal?: AbortSignal;
}
export function listVideos(
  ctx: ApiContext, opts: ListVideosOptions,
): Promise<{ videos: Video[]; cursor: string; hasMore: boolean }>;

export interface QueryVideosOptions {
  fields?: readonly string[];
  signal?: AbortSignal;
}
export function queryVideos(
  ctx: ApiContext, ids: string[],                       // >20 rejected locally (CC-C6)
  opts?: QueryVideosOptions,
): Promise<{ videos: Video[]; missingIds: string[] }>;  // CC-C7

// api/publish.ts
export const PRIVACY_LEVELS: readonly PrivacyLevel[];   // the four documented values
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];
export const VIDEO_TITLE_MAX = 2200;                    // UTF-16 code units (CC-E3)
export const PHOTO_TITLE_MAX = 90;
export const PHOTO_DESCRIPTION_MAX = 4000;
export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 35;                           // CC-E9
export const PUBLISH_STATUSES: readonly PublishStatusValue[];
export type PublishStatusValue = (typeof PUBLISH_STATUSES)[number];

/** Unknown values are NON-terminal — a new status is far likelier to be a new
 *  processing stage than a new outcome, and polling on is the safe error. */
export function isTerminalStatus(status: string): boolean;

export interface CreatorInfo {
  nickname: string; username: string; avatarUrl?: string;
  privacyLevelOptions: readonly string[];   // the ONE member a shape change cannot survive
  commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean;
  maxVideoPostDurationSec?: number;
}
export function getCreatorInfo(
  ctx: ApiContext, opts?: { signal?: AbortSignal },
): Promise<CreatorInfo>;
/** Audit mode: the options list is exactly ["SELF_ONLY"] (TIKTOK-API.md § 4.1). */
export function auditRestrictionsActive(creator: CreatorInfo): boolean;

/** Resolution is PURE and separate from the network: the preview digests the
 *  resolved payload and the apply step must reproduce it byte for byte. */
export interface DerivedField { field: string; value: unknown; reason: string }
export interface ResolvedPostInfo {
  postInfo: Record<string, unknown>;        // wire-shaped, snake_case
  derived: readonly DerivedField[];         // env defaults + creator-forced values only
}
export interface PostDefaults { isAigc: boolean }       // from TT_DEFAULT_AIGC_LABEL
export function resolveVideoPostInfo(
  input: VideoPostInput, creator: CreatorInfo, defaults: PostDefaults,
): ResolvedPostInfo;                        // CC-E1–E4
export function resolvePhotoPostInfo(
  input: PhotoPostInput, creator: CreatorInfo, defaults: PostDefaults,
): ResolvedPostInfo;                        // CC-E1–E4
/** The photo DRAFT `post_info` (TOOLS.md § 3.11) — title + description only,
 *  `derived: []`. Not `resolvePhotoPostInfo` with optional arguments: a draft
 *  carries no privacy level and no toggles (the user picks those in the app),
 *  and must not grow defaults. It takes no `CreatorInfo` because the draft
 *  tools hold `video.upload` only and never run the creator_info pre-flight;
 *  it lives here anyway because it shares PHOTO_TITLE_MAX / PHOTO_DESCRIPTION_MAX
 *  and a second copy of those limits is a second place for them to drift. */
export function resolvePhotoDraftPostInfo(
  input: { title?: string; description?: string },
): ResolvedPostInfo;
export function validatePhotoSource(
  photoUrls: readonly string[], photoCoverIndex: number,
): void;                                    // CC-E9

/** How TikTok gets the video: it pulls it from a verified URL, or the client
 *  PUTs the bytes to the `upload_url` the init returns. */
export interface PullFromUrlSource { source: "PULL_FROM_URL"; videoUrl: string }
export interface FileUploadSource {
  source: "FILE_UPLOAD"; videoSize: number; chunkSize: number; totalChunkCount: number;
}
export type VideoSource = PullFromUrlSource | FileUploadSource;
/** `S` is the source the init is asked for, and it decides the result shape:
 *  a call site that hands over a FILE_UPLOAD gets an `uploadUrl` it does not
 *  have to check for. Left unspecified, the union over both kinds. */
export interface VideoPostInit<S extends VideoSource = VideoSource> {
  postInfo: Record<string, unknown>; source: S; signal?: AbortSignal;
}
export interface DraftUploadInit<S extends VideoSource = VideoSource> {
  source: S; signal?: AbortSignal;
}
export interface PublishInitResults {
  PULL_FROM_URL: { publishId: string; uploadUrl?: string };   // passed through if sent anyway
  FILE_UPLOAD:   { publishId: string; uploadUrl: string };    // carries the upload_token
}
export type PublishInitResult<S extends VideoSource = VideoSource> =
  PublishInitResults[S["source"]];
/** All three inits use retryClass "init": a publish attempt is spent on the
 *  first call, so a retry could duplicate a post. `uploadUrl` never leaves the
 *  api layer, and its `upload_token` is registered as a secret on the way out.
 *  A FILE_UPLOAD init (`req.source.source === "FILE_UPLOAD"`) MUST come back
 *  with an `upload_url`; a payload without one throws `malformedPayload(<init
 *  endpoint>, "upload_url string for a FILE_UPLOAD init")` rather than
 *  returning a result whose caller would only discover the hole one layer up,
 *  after the publish attempt was already spent. A PULL_FROM_URL init has no
 *  upload URL and is not checked. The result type says the same thing: a
 *  FILE_UPLOAD caller's `PublishInitResult` carries `uploadUrl: string`.
 *  A 2xx payload without a non-empty string `publish_id` (all three inits)
 *  throws `network_ambiguous` (kind "network", `cause` = the malformedPayload
 *  error), not `upstream_error`: the init may have been accepted, so it is
 *  journaled send_ambiguous and the duplicate guard holds (CC-G4). */
export function initVideoPost<S extends VideoSource>(
  ctx: ApiContext, req: VideoPostInit<S>,
): Promise<PublishInitResult<S>>;
export function initDraftUpload<S extends VideoSource>(
  ctx: ApiContext, req: DraftUploadInit<S>,
): Promise<PublishInitResult<S>>;
export function initPhotoPost(ctx: ApiContext, req: PhotoPostInit):
  Promise<{ publishId: string }>;
export function getPublishStatus(
  ctx: ApiContext, publishId: string, opts?: { signal?: AbortSignal },
): Promise<PublishStatus>;                  // raw `failReason`; CC-E5 prose is the tool layer's
```

```ts
// api/upload.ts
export const MIN_WHOLE_BYTES = 5_000_000;
export const CHUNK_SIZE_BYTES = 64_000_000;
export const MAX_FILE_BYTES = 4_294_967_296;            // 4 GiB
export const MAX_CHUNK_COUNT = 1000;
export const MAX_FINAL_CHUNK_BYTES = 127_999_999;

export interface ChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  chunks: Array<{ index: number; start: number; end: number; size: number }>;  // end inclusive
}

/** PURE. Decimal algorithm (SYNTHESIS § 2.4, normative in TIKTOK-API.md):
 *  MIN_WHOLE=5_000_000, CHUNK_SIZE=64_000_000; <5 MB ⇒ one whole chunk;
 *  else chunk_size=min(size, 64_000_000), count=floor(size/chunk_size),
 *  final chunk absorbs the remainder (≤127_999_999). 1≤count≤1000, and the
 *  4 GiB cap is rejected HERE, not by the caller: TIKTOK-API.md § 4.6 puts it
 *  inside plan() and TESTING.md pins 4,294,967,297 as a planChunks boundary.
 *  The tool layer still checks earlier, so `file_too_large` can name the real
 *  size. `chunkSizeOverride` exists only so V3 (50,000,123 ⇒ 10,000,000, five
 *  chunks) — TikTok's own worked example, unreachable from min(size,
 *  64_000_000), which yields one chunk — is expressible for the byte-exact
 *  vector assertions; it is validated like any other chunk size and the
 *  production call site passes one argument.
 *  Vectors V1–V8 are the shared test fixture. */
export function planChunks(fileSize: number, chunkSizeOverride?: number): ChunkPlan;

export interface MediaFile {
  path: string;                     // resolved, canonical, absolute
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** CC-D8 containment. Resolves `filePath` against `mediaRoot` (a relative path
 *  resolves against the root, never CWD), canonicalizes both sides with
 *  `fs.realpath`, and rejects anything that is not a regular non-empty file
 *  inside the root — a 0-byte file is `file_empty` (CC-D1), which the § 3.0
 *  catalog gained because `file_not_found`'s text is untrue for it. Lives here,
 *  where the file-system knowledge already is; in the tool layer it would be
 *  duplicated across `tiktok_post_video` and `tiktok_upload_video_draft`. */
export function resolveMediaFile(
  filePath: string, mediaRoot: string | undefined,
): Promise<MediaFile>;
/** CC-D3/CC-D4 re-stat at apply time: re-resolves and rejects unless
 *  (size, mtimeMs, dev, ino) still match `previous` — the chunk plan and the
 *  preview the human approved are otherwise stale. */
export function verifyMediaFile(
  previous: MediaFile, mediaRoot: string | undefined,
): Promise<MediaFile>;

/** Opens the media file ONCE (`pinFile`) and streams each chunk from that
 *  descriptor as a `ReadableStream` fed by positional `handle.read` calls in
 *  1 MiB slices — not `handle.createReadStream`, whose destroy/cancel closes
 *  the handle even with `autoClose: false` (breaking every later retry) and
 *  which leaves a `close` listener per stream. A file truncated mid-chunk
 *  fails the body; the re-stat after it skips the retries and reports
 *  `upload_interrupted` ("modified during the upload"). Owns the
 *  1 + TT_CHUNK_RETRIES loop itself, passing `chunkRetries: 0`: `putChunk`
 *  disables its in-call retries for a stream body it cannot replay and defers
 *  to "the caller re-reads the byte range and calls again". Every attempt opens
 *  a fresh stream on the pinned descriptor over a byte-identical
 *  `Content-Range`, which is what keeps RSS bounded on a 128 MB final chunk
 *  while still honouring CC-B7/CC-D6 — and a rename/replace of the path
 *  mid-upload cannot splice another file's bytes in. The pinned file's size
 *  must equal the plan total and, when `identity` is given, its (size,
 *  mtimeMs, dev, ino) must equal what `verifyMediaFile` confirmed, else
 *  `plan_mismatch` before any PUT. Before each chunk the descriptor is
 *  re-stat'ed; a size or mtime change (an in-place rewrite) fails with
 *  `upload_interrupted` ("the media file was modified during the upload").
 *  `contentType` overrides the extension map (.mp4/.m4v ⇒ video/mp4,
 *  .mov/.qt ⇒ video/quicktime, .webm ⇒ video/webm, anything else video/mp4):
 *  no doc prescribes one, and TikTok validates the container by content (CC-D9)
 *  and reports a mismatch asynchronously as fail_reason
 *  file_format_check_failed, so refusing locally would invent a catalog code
 *  that does not exist. `onProgress` fires once per chunk AFTER TikTok accepts
 *  it, with a 0-based `chunkIndex` — `ToolCtx.progress` is (done, total), so
 *  the tool layer passes `(i, n) => progress(i + 1, n)`. A 416 resyncs the
 *  cursor to where TikTok says progress is and, whenever the position moved,
 *  calls `onProgress(index - 1, n)` for the chunks it says it holds — also
 *  backwards, so the position a later failure reports is the right chunk; the
 *  tool layer drops a value that does not exceed the last one it notified, so
 *  MCP progress never decreases. A resync to the end of the file (progress ≥
 *  total) completes the upload — that 416 is the lost 201. A FINAL-chunk 416
 *  whose progress equals the last byte index (total − 1) throws
 *  `network_ambiguous`: until probe P-11 pins the unit it is every byte or all
 *  but one. A transport failure (`network_error` / `timeout`) on the FINAL
 *  chunk throws `network_ambiguous` rather than `upload_interrupted`: its
 *  arrival is what completes the upload, so the bytes may have landed with
 *  only the answer lost (CC-G4). Once such an attempt was replayed, any later
 *  failure of the final chunk — `5xx` retries exhausted, or a terminal
 *  403/404/400 — is `network_ambiguous` too, never `upload_interrupted`. */
export function uploadFile(ctx: ApiContext, opts: {
  filePath: string; plan: ChunkPlan; uploadUrl: string;
  contentType?: string;
  signal?: AbortSignal;
  onProgress?: (chunkIndex: number, totalChunks: number) => void;
  random?: () => number;            // backoff jitter seam (TESTING determinism rule 4)
  identity?: FileIdentity;          // what verifyMediaFile confirmed; the descriptor must be that file
}): Promise<void>;

/** What a file is pinned by: the fields `verifyMediaFile` compares. */
export type FileIdentity = Pick<MediaFile, 'size' | 'mtimeMs' | 'dev' | 'ino'>;
```

## mcp/define.ts (tools-as-data)

```ts
export type PackageName = "auth" | "user" | "video" | "publish" | "publish-write";

export interface ToolCtx {
  api: ApiContext;
  log: Logger;
  signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
}

export interface ToolSpec<In, Out> {
  name: `tiktok_${string}`;      // v1.1 surface: 11 tools (SYNTHESIS § 2.9)
  title: string;
  description: string;
  package: PackageName;
  scopes: string[];              // AND — every one of these must be granted
  /** Scopes of which ANY ONE suffices, checked on top of `scopes`. Omit unless
   *  the upstream really accepts alternatives (`video.publish` OR
   *  `video.upload` for /publish/status/fetch/, TOOLS.md § 3.6); fewer than two
   *  entries is a spec error, because that is an AND in the wrong field. */
  scopesAnyOf?: readonly string[];
  annotations: {                 // ALL FOUR required on every tool
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: z.ZodType<In>;          // .strict() (CC-G1)
  handler(args: In, ctx: ToolCtx): Promise<ToolResult<Out>>;
}

export type AnyToolSpec = ToolSpec<unknown, unknown>;

/** Import-time assertions; returns the (frozen) spec unchanged. */
export function defineTool<In, Out>(spec: ToolSpec<In, Out>): ToolSpec<In, Out>;

/** The normative describe() text of the injected `account` argument (§ 2.2). */
export const ACCOUNT_DESCRIPTION: string;
export const accountArg: z.ZodOptional<z.ZodString>;

/** `.strict()` object schema with `account` injected unless the tool redefines
 *  it (the § 2.2 filter exception, e.g. `tiktok_list_publish_journal`). */
export function toolInput<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<{ account: typeof accountArg } & Shape, z.core.$strict>;
```

`defineTool` rejects at import time: a name outside lowercase-snake
`tiktok_*`, an empty title/description, a package outside the five, duplicate or
empty scopes, an input schema that accepts unknown keys (CC-G1), and
`readOnlyHint && destructiveHint`.

`src/tools/index.ts` is the manifest-in-code: the ordered `PACKAGES` array is
the ONE source consumed by (1) server registration, (2) the manifest snapshot
test, (3) README generation, (4) the `server.json` sync check (the file is
hand-curated; only its "N tools" claim is compared).

```ts
export interface ToolPackageSpec { name: PackageName; tools: readonly AnyToolSpec[] }
export const PACKAGES: readonly ToolPackageSpec[];   // frozen, all five packages
/** Every tool of every package, in manifest order. */
export function allTools(packages?: readonly ToolPackageSpec[]): readonly AnyToolSpec[];

export interface ManifestEntry {
  package: PackageName;
  scopes: readonly string[];
  scopesAnyOf?: readonly string[];  // omitted when the tool has none
  tool: Tool; // the MCP SDK's advertised shape, as ListTools would return it
}
/** The manifest as the generators see it: every tool described against a
 *  synthetic fully-authorized profile, so the snapshot, README table and
 *  server.json describe the server rather than the machine that ran the
 *  generator (no ambient credentials, no [UNAVAILABLE …] markers). */
export function describeAllTools(
  packages?: readonly ToolPackageSpec[],
): readonly ManifestEntry[];
```

## mcp/result.ts

```ts
/** Closed vocabulary — six hint types, no upstream text interpolation.
 *  Semantics, structured fields, and grammar per type: TOOLS.md § 5
 *  (hints specification). */
export type HintType =
  | "wait"
  | "poll"
  | "approval_required"
  | "user_action"
  | "reauth"
  | "note";

/** Closed vocabulary — the operator-side steps a `user_action` hint may name,
 *  derived from the frozen `USER_ACTIONS` below so the list is enumerable at
 *  runtime. Membership answers TOOLS.md § 5.1's question — a step only the
 *  human/operator can take *next, before this call can proceed*. The
 *  unaudited-app case is NOT here: it is a standing condition of the
 *  installation, reported alongside a flow that continues, and TOOLS.md § 4
 *  (flow 2) and § 5.1 both report it as `note`. `move_file` and `host_media`
 *  are: they ride on non-retryable refusals that end the call with nothing
 *  created, and only past an init are they withheld (the attempt exists
 *  upstream, CC-B4, so the next step is a status poll). */
export type UserAction =
  | "login" | "open_tiktok_app" | "move_file"
  | "host_media" | "configure_server";

export interface Hint {
  type: HintType;
  text: string;                  // model-facing sentence(s), ≤ 300 chars (TOOLS.md § 5.2)
  // Structured fields per type (TOOLS.md § 5.1); each is present only for the
  // hint types that declare it, and absent otherwise.
  retry_after_s?: number;        // wait
  retry_at?: string;             // wait — absolute ISO-8601 UTC
  tool?: string;                 // poll — exact tool name, e.g. "tiktok_get_publish_status"
  publish_id?: string;           // poll
  poll_after?: string;           // poll — absolute ISO-8601 UTC (SYNTHESIS § 2.3)
  plan_id?: string;              // approval_required
  expires_at?: string;           // approval_required — absolute ISO-8601 UTC
  action?: UserAction;           // user_action
  command?: string;              // reauth — exact CLI line
  profile?: string;              // reauth
}

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;                // stable machine code from the TOOLS.md catalog
    message: string;             // normative catalog text (substring-tested)
    retryable: boolean;          // mirrors TikTokError.retryable / catalog column
    log_id?: string;             // upstream log_id, when present
    // Open extension bag. The upstream error code lives at `details.api_code`
    // when kind === "api" (CC-B9) — TOOLS.md § 2.1 is authoritative for this
    // envelope because it is the wire shape a client sees, frozen under semver.
    details?: Record<string, unknown>;
  };
  hints?: Hint[];
  journal?: "unavailable";       // journal append failed — never a publish failure
}

/** `data.meta.truncation` (TOOLS.md § 2.4). */
export interface TruncationInfo {
  truncated: true;
  // char_budget is stamped by the truncator; the other two by the tool itself —
  // item_cap = its own ceiling (resumable), cursor_stuck = upstream stopped
  // paginating (CC-C3), which is why that one never carries a resume_cursor.
  // char_budget never carries one either: it replaces the tool's marker and
  // drops meta.next_cursor, since any cursor points past the whole fetched
  // page and would skip the elided items (the note says to narrow instead).
  reason: "char_budget" | "item_cap" | "cursor_stuck";
  returned: number;                     // items still present in the elided array
  resume_cursor?: string;               // item_cap only, when the tool supplied one
}

export interface TruncateOptions { pretty?: boolean }   // TT_PRETTY_JSON=1

/** The envelope and the text that mirrors it — the two never drift. */
export interface TruncatedResult {
  result: ToolResult<unknown>;   // redacted, possibly elided → structuredContent
  text: string;                  // JSON.stringify(result) → the text block
  truncated: boolean;
}

/** Redact → serialize → fit. Every string value goes through `redactText`
 *  first (§ 2.5); the ladder then elides the largest top-level array in `data`
 *  item by item, falls back to `data.meta` alone, and finally to the
 *  ok/error/hints/journal floor (CC-G7). The first two rungs stamp a
 *  `char_budget` marker with no `resume_cursor` and delete `meta.next_cursor`. Every rung is valid JSON (CC-G2) and
 *  never cuts a surrogate pair. Throws `result_not_serializable` when the
 *  envelope cannot be stringified at all. */
export function truncateResult(
  result: ToolResult<unknown>,
  budgetChars: number,
  opts?: TruncateOptions,
): TruncatedResult;

/** `truncateResult(...).text` — the mirroring text block on its own. */
export function toToolContent(
  result: ToolResult<unknown>,
  budgetChars: number,
  opts?: TruncateOptions,
): string;

export const HINT_TYPES: readonly HintType[];                    // frozen, six entries
export const USER_ACTIONS: readonly UserAction[];                // frozen, five entries
export const RESULT_JSON_SCHEMA: Readonly<Record<string, unknown>>;  // outputSchema

export const MAX_HINTS = 3;               // TOOLS.md § 5.2 rule 4
/** TOOLS.md § 5.2 rule 1, measured on `text` alone. Enforced at *runtime* in
 *  exactly one place — the pagination-cursor note, whose resume cursor is the
 *  only value reaching a hint that is neither a fixed template nor bounded by
 *  `hintToken`/`hintEnum`. Everywhere else an over-long hint is a bug in this
 *  server rather than upstream data, so `test/result.test.ts` walks the
 *  constructors for it instead. A general runtime clamp was declined: the clip
 *  lands on the end of the sentence, which is where the negative imperative
 *  lives ("Do not re-post."). */
export const MAX_HINT_CHARS = 300;
export const MAX_HINT_TOKEN_CHARS = 64;   // § 5.2 rule 3 — longest inlinable identifier

/** § 5.2 rule 3 (the trust boundary) in code, so that no constructor
 *  interpolates an upstream-originated value on its own terms.
 *  `hintToken` returns the value only while it still looks like an opaque
 *  identifier — 1..MAX_HINT_TOKEN_CHARS chars, leading alphanumeric, then
 *  `[A-Za-z0-9._~-]`. It never truncates and never escapes: `undefined` means
 *  "do not name it in the text".
 *  `hintEnum` returns the member of a *server-owned* vocabulary that an
 *  upstream string selects, so what reaches the text is this server's literal.
 *  It validates nothing upstream — `api/publish` still reports an unrecognized
 *  status rather than rejecting it.
 *  `quotedHintToken` is the rendering the three `poll` hints share:
 *  `publish_id "…"` on a pass, `this hint's publish_id` on a refusal, with the
 *  unfiltered value one field away in the hint's own `publish_id` or in
 *  `data`.
 *  The three guard the *error* channel too, not only hints: TOOLS.md § 3.0
 *  "Upstream values in error and recovery text" holds `error.message` and
 *  `data.fail_recovery` to the same two classes, because both are prose a model
 *  reads as instruction. Same helpers, same refuse-don't-truncate remedy. */
export function hintToken(value: string | undefined): string | undefined;
export function hintEnum<T extends string>(
  value: string | undefined,
  vocabulary: readonly T[],
): T | undefined;
export function quotedHintToken(label: string, value: string | undefined): string;
```

## mcp/errors.ts

The catalog entries produced by the *registration wrapper* rather than by a
tool, plus the one `TikTokError` → envelope mapping (TOOLS.md § 3.0). Texts are
normative and substring-tested; nothing upstream is interpolated into a message
(trust boundary, § 5) — upstream detail lives in `log_id` / `details.api_code`.

```ts
/** `<field>: <reason>` for the first zod issue; unknown keys name themselves (CC-G1). */
export function describeZodError(error: z.ZodError): string;

export function invalidParamsError(detail: string): ToolError;
export function unknownAccountError(
  name: string,
  configured: readonly string[],
  defaultProfile: string,
): ToolError;
export function missingScopeError(profile: string, scope: string): ToolError;
/** `missing_scope` for a profile with NO stored credentials — not listed at
 *  all, or `ProfileInfo.authorized === false` (DEFAULT before the first login,
 *  a profile holding only app keys): "authorized without scope X" would
 *  be false, and `--scopes X` would grant X alone, so the text asks for a plain
 *  login. `details: { profile, missing_scope, configured: false }`; the server
 *  pairs it with a `reauth` hint whose command carries no `--scopes`. */
export function unconfiguredProfileScopeError(profile: string, scope: string): ToolError;

/** The single catch-site mapping. A `TikTokError` keeps its code, kind,
 *  retryability, `log_id` and `api_code`, with `remediation` appended to the
 *  message once. Anything else is a server bug: `internal_error` with a fixed
 *  text, the thrown string kept only in `details.reason`, redacted. */
export function toolErrorFrom(error: unknown): ToolError;

/** `toolErrorFrom` plus the five `/post/publish/*` remaps, which only that
 *  endpoint family ever returns: spam_risk_too_many_posts → `daily_post_cap`,
 *  reached_active_user_cap → `active_user_cap`,
 *  spam_risk_too_many_pending_share → `pending_share_cap`,
 *  url_ownership_unverified → `url_prefix_unverified` (the upstream twin of the
 *  local pre-flight, same code so the caller reads one story), and
 *  invalid_publish_id → `publish_not_found`. `log_id` and `details.api_code`
 *  survive the remap. Every publish tool funnels its catch sites through this;
 *  every other tool keeps the plain mapping. */
export function publishToolError(error: unknown): ToolError;
```

## mcp/server.ts

Tool registration, the call pipeline and the transports. The tool handlers are
installed on the **low-level `Server`**, not on `McpServer.registerTool`: the
latter installs its own argument validator that renders a schema failure as an
`McpError` with no `structuredContent`, which contradicts TOOLS.md §§ 2.1/2.3/3.0
(a rejected argument is a normal envelope with `ok: false`, not a protocol
error). zod's own `z.toJSONSchema(input, { target: 'draft-7', io: 'input' })`
converts `ToolSpec.input` for advertisement (`$schema` dropped; `io: 'input'`
describes what a caller sends, so defaulted fields are optional). The
prompt and resource handlers (TOOLS.md § 7) sit beside the tool handlers on the
same `Server`, look their specs up by name or URI through the same package gate,
and — for a read — run the bound tool through `callTool` below.

```ts
/** A configured profile as the server sees it at call time. */
export interface ProfileInfo {
  name: string;
  scopes: readonly string[];
  /** false ⇔ the profile stores neither an access nor a refresh token, or its
   *  record cannot be read. Absent ⇒ unknown, treated as authorized. A scoped
   *  tool on an unlisted OR `authorized: false` profile gets the unconfigured
   *  `missing_scope` form (`unconfiguredProfileScopeError`). */
  authorized?: boolean;
}

/** Everything the handlers need from the outside world, behind one seam. */
export interface ServerRuntime {
  settings: Settings;
  log: Logger;
  profiles(): Promise<readonly ProfileInfo[]>;   // re-read per call, never cached
  createContext(profile: string): Promise<ApiContext>;
}

export interface ToolPackageLike { name: ToolPackage; tools: readonly AnyToolSpec[] }

/** TT_TOOL_PACKAGES selects (core/all expanded), TT_PACKAGES_DENY subtracts,
 *  TT_WRITE_MODE=deny and TT_PACKAGES_READONLY=1 drop publish-write and win
 *  over any selection. Result keeps manifest order, never selector order. */
export function resolveEnabledPackages(settings: Settings): readonly ToolPackage[];
export function enabledTools(
  packages: readonly ToolPackageLike[],
  settings: Settings,
): readonly AnyToolSpec[];

/** The enabled prompts, manifest order: a prompt is kept only when its
 *  `package` **and** every package in its `requires` are enabled — so
 *  `prompts/list`, `prompts/get` and prompt completion all see the same set. */
export function enabledPrompts(
  prompts: readonly PromptSpec[],
  settings: Settings,
): readonly PromptSpec[];

/** The enabled resources, manifest order: a resource follows its tool, so it
 *  is listed exactly when `tools/list` lists the tool it reads through.
 *  Membership is by tool *name*, the key `tools/call` resolves. */
export function enabledResources(
  resources: readonly ResourceSpec[],
  tools: readonly AnyToolSpec[],
): readonly ResourceSpec[];

/** The `[UNAVAILABLE: ...]` description prefix (§ 6.1), or undefined when at
 *  least one profile covers the scopes. Advisory — callTool decides. */
export function unavailableMarker(
  spec: AnyToolSpec,
  profiles: readonly ProfileInfo[],
): string | undefined;

/** The `tools/list` entry for one spec, marker included. */
export function describeTool(spec: AnyToolSpec, profiles: readonly ProfileInfo[]): Tool;

export interface CallOptions { signal?: AbortSignal; progress?: ToolCtx["progress"] }

/** One tool end to end: parse → resolve account → check scopes → context →
 *  handler → envelope. Exported apart from the request handler so tests and a
 *  future HTTP transport exercise the pipeline without a transport. */
export async function callTool(
  spec: AnyToolSpec,
  args: unknown,
  runtime: ServerRuntime,
  opts?: CallOptions,
): Promise<ToolResult<unknown>>;

/** Envelope → MCP result: mirrored text block, structuredContent, isError. */
export function toCallToolResult(
  result: ToolResult<unknown>,
  settings: Settings,
): CallToolResult;

export interface ServerOptions {
  name: string;
  version: string;
  packages: readonly ToolPackageLike[];
  /** TOOLS.md § 7 — default `[]` for both. Listed through the package gate. */
  prompts?: readonly PromptSpec[];
  resources?: readonly ResourceSpec[];
  runtime: ServerRuntime;
}

export interface McpServerHandle {
  server: Server;
  /** Tell connected clients the tool and resource lists may have moved
   *  (§ 6.3): `tools/list_changed` and `resources/list_changed`. Both are
   *  attempted even when the first fails; the first failure is then rethrown.
   *  Descriptions are recomputed per list request, so there is nothing to
   *  refresh here. */
  notifyListChanged(): Promise<void>;
}

export function createServer(opts: ServerOptions): McpServerHandle;

/** stdout carries JSON-RPC frames and nothing else (CC-G3). */
export async function connectStdio(handle: McpServerHandle): Promise<StdioSession>;

/** A connected stdio transport and the drain its shutdown awaits. */
export interface StdioSession {
  readonly transport: StdioServerTransport;
  /** Resolves once every request received so far has been answered (or
   *  cancelled via notifications/cancelled), once budgetMs has passed on
   *  clock, or once signal aborts (the client went away) — whichever is
   *  first. Requests are counted per id, so a reused id still in flight keeps
   *  the drain open until its last answer; a cancel settles every request
   *  under its id. From the first call on, a new request is refused with
   *  JSON-RPC -32000 "Service Unavailable: the server is shutting down"
   *  instead of started (the HTTP transport answers 503). src/index.ts calls
   *  it with 10 s (STDIO_DRAIN_MS, like the HTTP transport's DEFAULT_DRAIN_MS)
   *  on SIGINT/SIGTERM before server.close(), which aborts every handler, and
   *  passes a signal that stdin EOF aborts: an EOF before the drain makes it
   *  return at once, one during the drain ends it at once — nobody is left to
   *  receive an answer. */
  drain(budgetMs: number, clock: Clock, signal?: AbortSignal): Promise<void>;
}
```

Call-pipeline rules that are contract, not implementation detail:

- The profile comes from the **parsed** `account`, not the raw arguments — a
  schema may trim or default it.
- `account` is compared as `canonicalProfileName(account)` (trim + upper-case),
  so `work` resolves profile `WORK`; the same rule applies to the
  `TT_LOCK_PROFILE` comparison, the `tiktok_list_publish_journal` filter and the
  `publish_id` completion's account context.
- An unknown `account` fails locally with `unknown_account`, echoing the
  caller's spelling as given; no request is sent.
- `TT_LOCK_PROFILE` is both the fallback profile and the only accepted one.
  The `account` argument stays in every schema; any other name answers
  `unknown_account`. The locked profile also bounds the two journal readers
  that take `account` as a filter — `tiktok_list_publish_journal` (and so
  `tiktok://publish/journal`) and the `publish_id` completion — to its own
  attempts; another filter value narrows them to nothing.
- `ServerRuntime.profiles()` failing is not a protocol fault on the listing
  surface: `src/index.ts` wraps the store read (`listingProfiles`) so an env
  file that cannot be read or parsed yields **no profiles** — every scoped tool
  and resource lists `[UNAVAILABLE: …]` and a scoped call answers the
  unconfigured `missing_scope` — instead of `tools/list` failing with `-32603`
  and the absolute env-file path. The credential watch keeps reading the store
  itself, so the failure is still what it logs.
- `completion/complete`: once the ref and argument are validated (those stay
  `-32602`), any failure computing candidates is logged as a
  `completion failed` warning and answered with the empty completion — never a
  JSON-RPC error carrying a local path.
- The scope check runs **before** `createContext`, so a denied call never
  touches the credential store.
- `data.meta.account` is stamped with the profile actually used, and a value the
  handler already set is never overwritten.
- An unknown tool name is a protocol error (`McpError`), not an envelope. So
  are an unknown prompt name (`Unknown prompt: <name>`), an invalid prompt
  argument, an unknown or malformed resource URI (`Unknown resource:
  <uri as sent>`), and a `completion/complete` ref that names none of the
  enabled prompts or resources, or an argument the ref does not declare —
  all `InvalidParams`, TOOLS.md § 7.
- `completion/complete` (TOOLS.md § 7.3) resolves the ref to a
  `CompletionSource` — `promptCompletion(enabledPrompt, argument.name)` for
  `ref/prompt`, `resourceCompletion(matchResourceRef(enabled, ref.uri),
  argument.name)` for `ref/resource` — and answers
  `complete(source, runtime, { value: argument.value, context:
  context?.arguments })`. The enabled lists are the same the list handlers
  serve, so a prompt or resource gated out with its package is unknown here
  too. Nothing is called and nothing is sent: every source is local.
- `resources/list` carries the enabled *concrete* specs; `resources/templates/list`
  carries every enabled spec (a `{name}` path parameter makes a spec a
  template, `mcp/resources.ts`). `resources/read` is `matchResource(enabled,
  parsed.uri)` — concrete equality first, then the templates, both in manifest
  order — then `callTool(match.spec.tool, resourceArgs(match, parsed), runtime,
  { signal })` followed by `resourceContents` — no second pipeline. A path no
  spec matches is `Unknown resource`. Capabilities are `{ tools: { listChanged:
  true }, prompts: {}, resources: { listChanged: true }, completions: {},
  logging: {} }` — `completions` because the SDK refuses a
  `completion/complete` handler without it.

## mcp/http.ts

The Streamable HTTP transport (CC-G6, SECURITY.md § Transport, CONFIGURATION.md
§ Transport) — the second of the two transports `createServer` can be put on.
stdio stays the default because it opens no listening socket; this module is for
the deployments that need one, and almost all of it is about the two ways such a
socket is abused: an unauthenticated caller, and a page in the operator's browser
that found the port. It never learns which tools exist — the per-session
`McpServerHandle` comes from an injected factory.

```ts
/** The single path served. Anything else is 404, with a valid token or not. */
export const MCP_PATH = "/mcp";

/** What the Host/Origin check compares against. `loopbackOnly` is true only
 *  when the bind stays on the machine — past loopback the name in `Host`
 *  belongs to the TLS terminator in front, not to us. `allowedHosts` is
 *  `TT_HTTP_ALLOWED_HOSTS` (bare host names in WHATWG URL canonical form —
 *  lowercased, IPv6 compressed and unbracketed, numeric IPv4 expanded; see
 *  core/settings `canonicalHostName`): when present, a `Host` hostname or an
 *  `Origin` hostname not in it is rejected — on any bind, before the loopback
 *  rules run. The `Host` hostname is canonicalized the same way before the
 *  comparison (an `Origin` already is, by the URL parser). */
export interface OriginPolicy {
  loopbackOnly: boolean;
  port: number;
  allowedHosts?: ReadonlySet<string>;
}

/** Which header failed the DNS-rebinding check, or undefined when neither did.
 *  Exported so the off-box policy is testable without binding off-box. */
export function dnsRebindingRejection(
  headers: { host?: string; origin?: string },
  policy: OriginPolicy,
): "Host" | "Origin" | undefined;

export interface HttpTransportOptions {
  settings: Settings;
  log: Logger;
  /** One runtime per session: an SDK `Server` binds exactly one transport. */
  createHandle: (sessionId: string) => McpServerHandle | Promise<McpServerHandle>;
  /** Called exactly once per handle createHandle returned, when its transport
   *  closes — DELETE, close(), or a non-initialize POST that never became a
   *  session. The owner drops the handle from whatever it keeps them in. */
  releaseHandle?: (handle: McpServerHandle) => void;
  /** Live-session cap, default 128. A test seam, not a setting. */
  maxSessions?: number;
  /** Idle age after which a session is closed, default 30 min. A test seam. */
  sessionIdleMs?: number;
  /** How long close() waits for requests in flight, default 10 s
   *  (DEFAULT_DRAIN_MS). A test seam. */
  drainMs?: number;
  clock?: Clock;                       // default systemClock (CC-H4)
}

export interface HttpTransportHandle {
  host: string;                        // as it goes into a URL (IPv6 bracketed)
  port: number;                        // differs from TT_PORT only when it was 0
  url: string;                         // where a client points its transport
  sessions(): number;                  // a diagnostic, never a protocol input
  /** Refuses new requests, drains the ones in flight (up to drainMs), then
   *  ends every session and releases the port. Idempotent: a second call
   *  returns the first call's promise. */
  close(): Promise<void>;
}

/** Binds TT_HTTP_HOST:TT_PORT and serves MCP on it. Resolves once the socket is
 *  listening, so the caller may log a URL that is already reachable; rejects
 *  with the listen error (EADDRINUSE) rather than resolving on a socket it
 *  never got. Throws TikTokError { kind: "config", code: "http_token_required" }
 *  when settings carry no TT_HTTP_TOKEN. */
export async function startHttpTransport(
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle>;
```

Rules that are contract, not implementation detail:

- **The bearer is mandatory, loopback included** (SYN-31). `core/settings`
  refuses the configuration first; this module refuses again rather than trust
  that its caller validated it. The comparison runs over fixed-length SHA-256
  digests — `===` on the raw strings leaks the shared prefix through timing, and
  `timingSafeEqual` on raw bytes throws `RangeError` on a length mismatch, which
  is a length oracle with extra steps. A missing credential and a wrong one
  produce **byte-identical** 401s (`WWW-Authenticate: Bearer`), so probing cannot
  tell "no token" from "not that token". The token is passed to `registerSecret`
  at startup and reports as `<redacted>`.
- **Check order is part of the answer**: `Host`/`Origin` (403) → bearer (401) →
  path (404) → method (405, with `Allow: GET, POST, DELETE`) → the session. An
  unauthenticated prober therefore cannot map the surface — every path is 401
  until it holds the credential — and a rebound name is refused before the
  credential is even read.
- **`Host` is mandatory and `Origin` is not.** A request that names no authority
  cannot be checked against one; a request with no `Origin` is every non-browser
  MCP client. When `Origin` *is* present a browser is speaking and it must name
  this very server: a loopback bind pins the whole authority (hostname *and*
  bound port), a proxied bind pins the hostname only, since the port a browser
  sees is the proxy's.
- **One session, one runtime.** `sessionIdGenerator` mints a `randomUUID`, and
  `createHandle` is called once per accepted session: per-connection state
  (initialization, pending requests, progress tokens) is exactly what must not
  leak between callers. `DELETE` ends one session, `close()` ends all of them,
  and a POST that never completes initialization leaves no session behind.
  Every created handle is handed to `releaseHandle` exactly once when its
  transport closes, whichever of those three paths closed it; `src/index.ts`
  uses it to drop the handle from the credential-watch set, so that set tracks
  live sessions instead of growing with every dead one.
- **Once `close()` begins, nothing new is accepted.** Any request that
  arrives after it — including one for an existing session — is answered
  `503` with JSON-RPC `-32000` `Service Unavailable: the server is shutting
  down`.
- **`close()` drains, then tears down.** In-flight non-`GET` requests (`POST`,
  `DELETE`), and every JSON-RPC request whose handler has not yet sent its
  result or error, get up to `drainMs` (default 10 s) to finish; a request
  accepted before the shutdown — an `initialize` whose handle was still being
  created included — may complete during the drain. Counting requests, not
  only open responses, is what keeps a client that disconnected mid tool call
  from letting shutdown abort a running publish. A request stops being waited
  for when it is answered, when the client sends `notifications/cancelled` for
  its id, or when its transport closes. `GET` SSE streams are not waited
  for: they have no end. When the budget runs out a warning is logged
  (`pending`, `drain_ms`) and whatever is still in flight is aborted with its
  transport. Then the sessions are closed and the server is closed; a session
  whose creation finished after the teardown is closed again and answered
  `503`, and one whose `initialize` completes after the teardown emptied the
  session map is closed right away instead of registered. A `connect` failure
  releases the handle (no `onclose` runs for a transport that never
  connected), so `releaseHandle` still sees every handle exactly once.
  `close()` is idempotent and returns the same promise.
- **Bounded input and state** (module constants, not settings). A POST body
  is read here, capped at **4 MiB**: past it — or when a declared
  `content-length` already exceeds it, before any byte is read — the answer is
  `413` JSON-RPC `-32000` `Payload Too Large` with `connection: close`. A body
  that is not JSON is `400` `-32700` `Parse error: Invalid JSON`. At most
  **128** sessions are live; one more `initialize` is `503` `-32000`
  `Service Unavailable: too many open sessions`, refused, not queued. A
  session counts against the cap from the moment its `initialize` is admitted
  (`openSession` reserves the slot before `openReservedSession` awaits the
  handle and `connect`), so concurrent `initialize` requests cannot together
  open more than `maxSessions`. The reservation is released exactly once: as
  soon as the session is registered in the live map (from
  `onsessioninitialized`, before the `initialize` response is written — from
  then on the map counts it, so it is never counted twice), or on any earlier
  exit. A session
  with no request in flight and no open stream for **30 minutes** is closed
  lazily — when the next session is opened, with no timer — and its handle is
  released like any other close.
- **Known limits.** Without `allowedHosts`, off loopback the `Origin` check
  pins only the hostname to `Host`, and a rebound name makes both agree, so it
  does not stop DNS rebinding there — the bearer is the remaining layer. With
  `TT_HTTP_ALLOWED_HOSTS` set, a rebound name is not on the list and its
  `Host` is refused; `src/index.ts` warns at startup, and `doctor`'s
  `transport` check warns, when `TT_HTTP_INSECURE=1` runs without it on a
  non-loopback bind (on loopback neither `TT_HTTP_INSECURE=1` warning fires:
  the flag is redundant there). A request still in flight when the drain
  budget runs out is aborted.
- Session ids are **never logged as fields** — they are capability-bearing for
  the life of the session, and `core/redact`'s default-deny allowlist has no
  entry for them. The listening URL carries no credential and is safe to log.
- Refusals answer in the SDK's own shape (`{"jsonrpc":"2.0","error":{…},"id":null}`,
  code `-32000`, `-32001` for an unknown session), so a client needs no special
  case for this server.
- Nothing writes to stdout (CC-G3), and every time-dependent value (a session's
  `duration_ms`) comes from the injected `Clock`.

## mcp/plan-store.ts

```ts
export interface PlanRecord {
  digest: string;       // sha256Hex(canonicalJson(fully resolved payload))
  profile: string;
  openId: string;
  tool: string;
  createdAt: number;    // clock.now()
  used: boolean;
  /** CC-D3: the local file's identity at preview time (`size:mtimeMs:dev:ino`,
   *  one opaque string), absent for a payload with no local file. Bound to the
   *  plan, NOT folded into `digest` — the digest is also the duplicate guard's
   *  key, and a re-copied file with the same bytes is the same post — and
   *  never sent upstream. */
  fileIdentity?: string;
}

/** "plan_" + 32 lowercase hex chars (16 crypto.randomBytes). */
export const PLAN_ID_PATTERN: RegExp;
export function mintPlanId(): string;

/** TTL and cap are passed in, not read from process.env — the store stays a
 *  pure data structure. Omitting `options` uses the DEFAULT_* below, which a
 *  test asserts equal to loadSettings(baselineEnv()).planTtlS /
 *  .planMaxOutstanding. */
export interface PlanLimits { planTtlS: number; planMaxOutstanding: number }
export interface PlanStoreOptions { limits?: PlanLimits }
export const DEFAULT_PLAN_TTL_S: 600;
export const DEFAULT_PLAN_MAX_OUTSTANDING: 32;

/** In-process Map only — NEVER persisted; restart ⇒ re-plan is the designed
 *  recovery. Bounded on both axes: expired entries are swept first (using
 *  rec.createdAt as "now", so no clock is needed), then the oldest survivor is
 *  evicted until the cap has room — the oldest *used* plan first (it can only
 *  answer plan_not_found), a live one only when none is used. Re-storing a known id replaces it. The
 *  record is copied — the caller cannot reach in later and flip `used`. */
export function storePlan(id: string, rec: PlanRecord, options?: PlanStoreOptions): void;

export type ConsumeFailure =
  | "unknown" | "expired" | "already_used"
  | "payload_mismatch" | "account_mismatch" | "tool_mismatch"
  | "file_changed";
// Surfaced to callers as exactly two codes: "plan_not_found"
// (unknown/expired/already_used) and "plan_mismatch" (the rest);
// "file_changed" keeps the code but gets its own text (`fileChangedError`).

/** What the apply call claims the plan approved. */
export interface PlanExpectation {
  digest: string; profile: string; openId: string; tool: string;
  fileIdentity?: string;  // re-resolved at apply, compared verbatim
}
export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

/** Everything `consumePlan` checks, WITHOUT marking the plan used. The execute
 *  pipeline verifies at step 5 but consumes at step 7 (TOOLS.md § 2.6.3), so a
 *  `possible_duplicate` refusal in between leaves the plan appliable with
 *  `force: true`. Check order: unknown → expired (drops the record) →
 *  already_used → tool → account → digest → file identity (last, because a
 *  changed digest already says more; both absent is equal). */
export function verifyPlan(
  id: string, expect: PlanExpectation, clock: Clock, options?: PlanStoreOptions,
): ConsumeResult;

/** timingSafeEqual over digests. Re-runs the whole verification — a verdict is
 *  never carried across the duplicate guard's file read — then marks the plan
 *  used, atomically (no `await` between check and mark). Happens BEFORE the
 *  journal intent append and init dispatch (SYNTHESIS § 2.8). */
export function consumePlan(
  id: string, expect: PlanExpectation, clock: Clock, options?: PlanStoreOptions,
): ConsumeResult;

/** Diagnostics only (`outstanding` is on the redaction allowlist); never a
 *  control input. Counts consumed-but-unexpired plans too. */
export function outstandingPlans(): number;

/** Test seam — the process-wide Map is the store's whole identity. */
export function resetPlanStore(): void;
```

**A plan is applicable on `[createdAt, createdAt + planTtlS·1000)`.** The bound is
exclusive at the top and shared by three call sites — `consumePlan`, the sweep in
`storePlan`, and `planExpiresAt()` in `mcp/plan.ts` — so the instant printed in the
`approval_required` hint is exactly the first instant the apply is refused. Age is
computed as `now - createdAt`, which a backwards clock (CC-H1) makes negative:
never expired, never a crash.

## mcp/plan.ts

The glue around the store: digests, `TT_WRITE_MODE` step resolution, the local
publish bucket, and the normative texts. Pure or clock-driven — no network, no
filesystem, no `Date.now()`.

```ts
/** Call-shaping args that are NOT payload and never enter the digest. */
export const CONTROL_FIELDS: readonly string[]; // plan_id, force, wait_for_completion

/** sha256Hex(canonicalJson(fully resolved upstream payload)).
 *  @throws TypeError if a top-level control field leaked in — a server bug,
 *  never caller input, since the payload is built by the tool, not parsed. */
export function payloadDigest(payload: unknown): string;

/** Absolute ISO-8601 UTC (CC-H2) — the first instant the plan is refused. */
export function planExpiresAt(createdAtMs: number, ttlS: number): string;

/** No `apply` boolean: absence of plan_id is the preview, presence is the
 *  execution. `deny` throws — the write package is not registered, so reaching
 *  here means the package gate leaked. */
export type WriteStep = "preview" | "execute";
export interface WriteStepDecision { step: WriteStep; planId?: string }
export function resolveWriteStep(planId: string | undefined, mode: WriteMode): WriteStepDecision;

/** Per-profile token bucket, `TT_PUBLISH_RPM` inits per minute (default 6),
 *  one token per `60_000 / rpm` ms (default 10 s). Integer arithmetic only —
 *  the interval is rounded UP to whole ms so a rate that does not divide
 *  60 000 lands just under what was configured, the remainder is banked in the
 *  bucket's own timestamp, a full bucket banks nothing, a backwards clock
 *  accrues nothing. */
export interface PublishRateLimits { publishRpm: number }
export interface RateBucketOptions { limits?: PublishRateLimits }
export const DEFAULT_PUBLISH_RPM: 6;
export interface PublishBucketRate { capacity: number; refillMs: number }
export function resolvePublishBucket(options?: RateBucketOptions): PublishBucketRate;
export function publishRateLimits(settings: Settings): RateBucketOptions;
export interface RateBucketSnapshot { tokens_available: number; next_token_at?: string }
export interface RateLimitRefusal { retry_after_s: number; retry_at: string }
export type RateBucketTake =
  | { ok: true; bucket: RateBucketSnapshot }
  | { ok: false; refusal: RateLimitRefusal };

/** A preview always succeeds regardless of the bucket and just reports it. */
export function peekPublishBucket(
  profile: string, clock: Clock, options?: RateBucketOptions,
): RateBucketSnapshot;
/** Immediate refusal — the server NEVER sleeps a write call (TOOLS.md § 2.8). */
export function takePublishToken(
  profile: string, clock: Clock, options?: RateBucketOptions,
): RateBucketTake;
export function resetRateBuckets(): void;

/** The catalog texts. planFailureError maps six internal reasons onto the two
 *  codes callers see; the internal reason is deliberately absent from
 *  `details`, since a model that can tell "expired" from "already used" is
 *  tempted to retry one of them and neither is retryable. */
export function planFailureError(reason: ConsumeFailure, ttlS: number): ToolError;
/** The rate in the text is the configured one, not the default. */
export function localRateLimitedError(
  refusal: RateLimitRefusal, options?: RateBucketOptions,
): ToolError;
export function localRateLimitedHint(refusal: RateLimitRefusal): Hint;
export function approvalRequiredHint(planId: string, expiresAt: string): Hint;
```

`next_token_at` and `retry_at` are absolute instants because § 5.2 forbids handing
a model relative arithmetic to carry across turns; `retry_after_s` accompanies it
for callers that want the number. Both are computed on the **bucket's** timeline
(`updatedAt + refill`), not from `now`, so under a backwards clock the two fields
still agree with each other.

## mcp/journal.ts

```ts
export interface IntentRecord {
  v: 1; type: "intent";
  attempt_id: string;          // ULID
  ts: string;                  // ISO-8601 UTC
  tool: string; profile: string; open_id: string;
  plan_id: string;
  payload_digest: string;
  title_excerpt: string;       // ≤ 48 chars
  source: "FILE_UPLOAD" | "PULL_FROM_URL";
  mode: string;
}

export interface OutcomeRecord {
  v: 1; type: "outcome";
  attempt_id: string; ts: string;
  result: "ok" | "error" | "upload_failed" | "send_ambiguous";
  // known-unsent network failure ⇒ result:"error" + error_code:"network_unsent";
  // "unknown" is NEVER persisted — it is derived at read time as
  // intent-without-outcome.
  publish_id?: string; error_code?: string; fail_reason?: string;
  chunk?: number;
}

export type JournalRecord = IntentRecord | OutcomeRecord
  | { v: 1; type: "header"; created_by: string };

/** One intent folded together with its outcome — the read-side view every
 *  consumer (the journal tool, the duplicate guard) works in. `outcome` is
 *  `"unknown"` for an intent no outcome ever followed, and only then is
 *  `outcome_ts` absent. */
export interface JournalAttempt {
  attempt_id: string; ts: string;
  tool: string; profile: string; open_id: string;
  plan_id: string; payload_digest: string; title_excerpt: string;
  source: IntentSource; mode: string;
  outcome: "ok" | "error" | "upload_failed" | "send_ambiguous" | "unknown";
  outcome_ts?: string;
  publish_id?: string; error_code?: string; fail_reason?: string; chunk?: number;
}
// `chunk` is written by `classifyDispatch` onto every post-init failure outcome
// (`upload_interrupted` and the rest: only a chunked sender ever reports, and it
// reports its `position`) and survives the fold onto `JournalAttempt`. It is deliberately
// NOT projected into the `JournalEntry` that `tiktok_list_publish_journal`
// returns: it is a forensic field for a direct read of the journal file, not
// part of that tool's output contract (TOOLS.md § 3.7). Adding it there widens
// published surface and needs its own decision.

/** Every entry point takes the same options bag; each field defaults to what
 *  the resolved env file / settings say, so tests inject a sandbox path and
 *  production passes `settings`. */
export interface JournalOptions {
  path?: string;                 // absolute journal.ndjson; else derived from envFile
  maxBytes?: number;             // settings.journalMaxBytes
  envFile?: string;              // settings.envFile, when already resolved
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  createdBy?: string;            // "tiktok-mcp-ai@X.Y.Z", stamped into a fresh header
}
export function resolveJournalPath(opts?: JournalOptions): string;

/** The one journal wiring every reader and writer shares: `settings.envFile`
 *  (when set), `settings.journalMaxBytes`, `logger`. `tools/publish.ts`'s
 *  `journalOptions(ctx)` and `mcp/completions.ts` both call it, so the tool
 *  that appends an intent, the tool that lists it and the completion that
 *  offers its id can never read different files. */
export function journalOptionsFor(settings: Settings, logger: Logger): JournalOptions;

/** journal.ndjson, 0600 in a 0700 dir beside the resolved env file;
 *  O_APPEND (no env lock). Intent append is fsync'd and happens BEFORE init
 *  dispatch; rotation (settings.journalMaxBytes, one .1 generation) is
 *  checked only before intent appends, lock-free while under the cap. Over
 *  it, rotation takes journal.ndjson.lock (withEnvLock keyed on the journal
 *  path — distinct from the env-file lock; 2 s wait, ROTATE_LOCK_WAIT_MS;
 *  env-lock stale rules, 15 s) and re-checks the size under it, so two
 *  processes cannot both rotate and discard a generation. Wait exceeded or
 *  lock unusable ⇒ warn "could not rotate the publish journal; it keeps
 *  growing", skip the rotation, append anyway. The directory is fsync'd after a
 *  rotation's rename and after an fsync'd append that created the file —
 *  best-effort, skipped with a debug log where the platform cannot (win32).
 *  Append failure — including a short write (bytesWritten < line length) —
 *  ⇒ warn + mark the tool result journal:"unavailable" — never fail the
 *  publish. An append to a file whose last byte is not "\n" (a torn line)
 *  first writes "\n", so the fragment cannot swallow the new record. */
export function appendIntent(rec: IntentRecord, opts?: JournalOptions): Promise<{ ok: boolean }>;
export function appendOutcome(rec: OutcomeRecord, opts?: JournalOptions): Promise<{ ok: boolean }>;

/** Duplicate guard (SYNTHESIS § 2.7): bounded 256 KiB tail of the active
 *  generation, extended into the newest part of `.1` within the remaining
 *  budget when the whole active file fits (a rotated intent still counts);
 *  same digest with ok or unknown (incl. send_ambiguous) outcome within
 *  10 minutes ⇒ duplicate, unless force. error/upload_failed are exempt.
 *  Per profile: only attempts whose profile equals `profile` in canonical
 *  spelling (CC-F4) count — the same video on two accounts is two posts.
 *  The whole matched attempt travels with the verdict, because
 *  `possible_duplicate` (TOOLS.md § 3.0) has to name the profile, timestamp,
 *  outcome and publish_id — none of which an attempt id carries. */
export interface DuplicateCheck {
  duplicate: boolean;
  matchedAttemptId?: string;     // set iff `duplicate`
  matched?: JournalAttempt;      // set iff `duplicate`
}
export function checkDuplicate(
  payloadDigest: string, profile: string, clock: Clock, opts?: JournalOptions,
): Promise<DuplicateCheck>;

/** Merges both generations; torn tail lines are skipped and counted.
 *  Public contract v:1 is additive-only once the journal tool ships. */
export function readMerged(opts?: JournalOptions & { limit?: number }): Promise<{
  records: JournalRecord[]; skippedLines: number;
}>;

/** `foldAttempts(readMerged(opts).records)`, reused per resolved journal path
 *  while a `stat` signature of both generations (size, mtime, inode; `-` for
 *  an absent file) is unchanged — an append from any process or a rotation
 *  changes it and forces a re-read. The result is shared between callers and
 *  frozen (Object.freeze), not just typed readonly. The `publish_ids`
 *  completion source reads through it. */
export function foldedAttemptsCached(opts?: JournalOptions): Promise<readonly JournalAttempt[]>;
```

## mcp/lifecycle.ts

The credential-store watch behind `notifications/tools/list_changed` (CC-A7,
TOOLS.md § 6.3). `tools/list` already rebuilds every description from the store
on every request, so an `[UNAVAILABLE: …]` marker is never stale *when asked* —
but nothing asks, so a `login` in a second terminal stays invisible to a running
client. This module notices, and hands the verdict to a plain callback: it never
touches a `Server`, and the composition root is what turns a change into
`McpServerHandle.notifyListChanged()` (which also covers the resource list,
TOOLS.md § 7.2 — a resource is only ever as available as its tool).

```ts
/** TOOLS.md § 6.3's debounce floor, and the default poll period. */
export const MIN_WATCH_INTERVAL_MS = 500;
export const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** Canonical fingerprint of everything the tool list reads out of the store:
 *  every profile name with its sorted, de-duplicated scope set. Equal
 *  signatures mean equal tool descriptions. */
export function profileSignature(profiles: readonly ProfileInfo[]): string;

/** Why the signature moved, by profile name. Sorted; never used to decide
 *  whether to notify — the signature already did that. */
export interface ProfileDiff {
  added: readonly string[]; removed: readonly string[]; rescoped: readonly string[];
}
export function diffProfiles(
  previous: readonly ProfileInfo[],
  next: readonly ProfileInfo[],
): ProfileDiff;

export interface CredentialSource { envFilePath: string; env?: NodeJS.ProcessEnv }

/** The picture `tools/list` is built from: every configured profile with the
 *  scopes it currently holds (env file + presence-based process-env overlay,
 *  CC-F2). One unreadable profile is scopeless; an unreadable *file* throws. */
export function readCredentialProfiles(
  source: CredentialSource,
): Promise<readonly ProfileInfo[]>;

export interface CredentialChange extends ProfileDiff {
  profiles: readonly ProfileInfo[];   // as of this poll
  previous: readonly ProfileInfo[];   // what the last notification was taken from
}

export interface CredentialWatchOptions {
  envFilePath: string;
  clock: Clock;
  onChange: (change: CredentialChange) => void | Promise<void>;
  profiles?: () => Promise<readonly ProfileInfo[]>;  // default: readCredentialProfiles
  baseline?: readonly ProfileInfo[];
  intervalMs?: number;                               // default DEFAULT_WATCH_INTERVAL_MS
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export interface CredentialWatcher {
  /** Reads once, now. `true` iff this poll notified. Concurrent calls share
   *  one read, so a change can never be reported twice. */
  poll(): Promise<boolean>;
  /** Idempotent; awaits a poll already in flight — the loop's or one started
   *  through `poll()` — and leaves no pending timer. A `poll()` after `stop()`
   *  resolves `false` without reading. */
  stop(): Promise<void>;
}

export function startCredentialWatch(opts: CredentialWatchOptions): CredentialWatcher;
```

Rules that are contract, not implementation detail:

- The signal is **derived and compared**, never raw file activity. A token
  refresh rewrites the env file on its own schedule; a write that leaves the
  profile/scope picture identical must not notify.
- Availability is a **union across profiles** (§ 6.1), so the signature covers
  every profile, not only the active one.
- **Polling through the injected `Clock`** is the floor, not an optimisation:
  `fs.watch` misses the rename-replacement `persistProfilePatch` writes with, is
  unreliable on network homes (CC-H3) and cannot be driven by `mockClock`
  (CC-H4). The interval is also the debounce, and an unusable one falls back to
  the default with an `invalid_watch_interval` warning — same trade as
  `core/env-lock`'s `invalid_env_lock_duration`.
- **Nothing here throws into the server loop.** An unreadable or vanished store
  is a warning (once per transition into the degraded state) plus "no profiles";
  a rejecting `onChange` is a warning and the baseline still advances, so a lost
  notification is never retried forever. Markers are advisory and the call-time
  scope check remains authoritative.
- Wiring order is part of the contract: start **after** `connectStdio`
  (`sendToolListChanged()` throws `Not connected` without a transport) and stop
  **before** `server.close()`.

## mcp/completions.ts

The mechanism behind `completion/complete` (TOOLS.md § 7.3): the sources a
prompt argument or a resource path parameter can complete from, and the one
function that turns a source and a typed prefix into the protocol's answer. A
source is **data on the spec** (`PromptArgumentSpec.completion`,
`ResourceSpec.completions`), so `tools/` declares what completes and never
codes how; the three kinds are all local — the credential store's profile
names, a fixed vocabulary, the write-ahead journal — and none reaches TikTok.
`account` splits the two sides: a prompt's `account` argument declares the
`profiles` source like any other argument, while on a resource the server owns
it — `defineResource` refuses a spec that names it and `resourceCompletion`
answers the `{?account}` variable of every resource from the profiles itself.
Nothing here touches a `Server`; `mcp/server` resolves the ref through
`promptCompletion` / `resourceCompletion` and calls `complete`. Imports
`core/` types and `mcp/journal.ts` only, so `mcp/prompts.ts` and
`mcp/resources.ts` can import the source type without a cycle.

```ts
/** The protocol's cap on `values`. */
export const COMPLETION_MAX = 100;

export type CompletionSource =
  | { readonly kind: 'profiles' }                              // the configured profile names, store order
  | { readonly kind: 'values'; readonly values: readonly string[] }  // a fixed vocabulary, declared order
  | { readonly kind: 'publish_ids' };                          // journal ids, newest first, each once

/** The structural subset of ServerRuntime the sources need. */
export interface CompletionRuntime {
  readonly settings: Settings;
  readonly log: Logger;
  profiles(): Promise<readonly { readonly name: string }[]>;
}

export interface CompletionRequest {
  readonly value: string;                                       // the typed prefix; '' offers everything
  readonly context?: Readonly<Record<string, string>> | undefined;  // `context.arguments` of the request
}

/** Exactly the wire shape; all three always set. */
export interface Completion {
  readonly values: readonly string[];   // at most COMPLETION_MAX
  readonly total: number;               // every match, capped or not
  readonly hasMore: boolean;            // total > values.length
}

/** Why a `values` source is unusable — `a "values" completion lists no values`,
 *  `a "values" completion repeats "<value>"` — or undefined; the other kinds
 *  have nothing to check. definePrompt / defineResource throw it in their
 *  spec errors. */
export function completionSourceProblem(source: CompletionSource): string | undefined;

/** The candidates of `source`, filtered by case-insensitive prefix of
 *  `request.value`, in the source's own order, cut at COMPLETION_MAX.
 *  `undefined` (an argument declaring no source) ⇒ `{ values: [], total: 0,
 *  hasMore: false }` — never an error. `profiles` under `settings.lockProfile`
 *  is the locked name alone (the only name a call would accept, § 2.2).
 *  `publish_ids` takes the folded attempts from
 *  `foldedAttemptsCached(journalOptionsFor(settings, log))`, walks them newest first, skips attempts without a
 *  `publish_id`, keeps each id once and — when `context.account` is present
 *  and not blank — only attempts whose `profile` equals
 *  `canonicalProfileName(account)` (the filter of
 *  `tiktok_list_publish_journal`); under `settings.lockProfile` only the
 *  locked profile's attempts; a missing journal is no ids. The fold is reused
 *  while neither generation's size, mtime or inode changed. */
export function complete(
  source: CompletionSource | undefined,
  runtime: CompletionRuntime,
  request: CompletionRequest,
): Promise<Completion>;
```

## mcp/prompts.ts

The mechanism behind `prompts/list` and `prompts/get` (TOOLS.md § 7.1). A prompt
is data the same way a tool is: a frozen spec with a pure `render`, gated with
the package of the tools it steers to, advertised through `describePrompt` and
answered through `getPrompt`. Nothing here touches a `Server`; `mcp/server`
installs the two handlers and looks the spec up by name. The specs themselves
live in `tools/prompts.ts` — `mcp/` must not import `tools/`.

```ts
export interface PromptArgumentSpec {
  readonly name: string;          // snake_case, unique within the prompt
  readonly description: string;
  readonly required: boolean;
  /** What `completion/complete` offers for this argument (mcp/completions.ts);
   *  absent ⇒ it completes to nothing. Never sent by describePrompt. */
  readonly completion?: CompletionSource;
}

/** Validated arguments: trimmed, blank optionals dropped, every key declared. */
export type PromptArgs = Readonly<Record<string, string>>;

export interface PromptSpec {
  readonly name: `tiktok_${string}`;      // snake_case; shares the tool prefix
  readonly title: string;
  readonly description: string;
  readonly package: ToolPackage;          // the package the flow steers to
  /** Packages whose tools the flow's steps also name. Listed, served and
   *  completed only while `package` and every one of these are enabled. */
  readonly requires?: readonly ToolPackage[];
  readonly arguments: readonly PromptArgumentSpec[];
  /** Pure. Called only with the output of validatePromptArgs. */
  render(args: PromptArgs): readonly PromptMessage[];
}

/** Validates and freezes (spec and `arguments`). A bad name, blank title or
 *  description, unknown package or `requires` entry, a non-snake-case / duplicate / undescribed
 *  argument, or a `values` completion that lists nothing or repeats a value
 *  (`completionSourceProblem`) throws TikTokError `invalid_prompt_spec` (kind
 *  `internal`) — a server bug, thrown at module load, never at request time. */
export function definePrompt(spec: PromptSpec): PromptSpec;

/** The `prompts/list` entry: name, title, description, arguments. */
export function describePrompt(spec: PromptSpec): Prompt;

/** Unknown argument name, or a required argument missing or blank after trim,
 *  throws McpError(InvalidParams, `Invalid arguments for prompt <name>: …`) —
 *  a protocol error, mirroring the SDK's own McpServer. */
export function validatePromptArgs(
  spec: PromptSpec,
  raw: Readonly<Record<string, string>> | undefined,
): PromptArgs;

/** The declared argument's `completion` (undefined when it declares none);
 *  an undeclared name throws the same McpError(InvalidParams,
 *  `Invalid arguments for prompt <name>: unknown argument "<argument>"`) as
 *  validatePromptArgs. */
export function promptCompletion(spec: PromptSpec, argument: string): CompletionSource | undefined;

/** `{ description, messages: spec.render(validatePromptArgs(spec, raw)) }`. */
export function getPrompt(
  spec: PromptSpec,
  raw: Readonly<Record<string, string>> | undefined,
): GetPromptResult;
```

## mcp/resources.ts

The mechanism behind `resources/list`, `resources/templates/list` and
`resources/read` (TOOLS.md § 7.2). A resource is a **read-only tool exposed at a
URI** with a fixed argument set; the account rides in the query (`?account=`),
which is the only query key. A URI may also carry **path parameters** —
`{name}` segments after the host segment, `tiktok://publish/{publish_id}/status`
— and each one is a tool argument the read cannot default: a spec with one is a
*template*, listed by `resources/templates/list` only, and `resources/read`
binds the matching segment of the requested path to the argument of that name.
Nothing here calls anything: `mcp/server` parses the URI, matches it against the
enabled specs, runs the bound tool through `callTool` — the same pipeline as
`tools/call`, so gating, account resolution, scope check, redaction and
truncation are not duplicated — and hands the envelope to `resourceContents`.
The specs live in `tools/resources.ts`.

```ts
export const RESOURCE_SCHEME = 'tiktok://';
export const RESOURCE_MIME_TYPE = 'application/json';

export interface ResourceSpec {
  readonly uri: `tiktok://${string}`;     // lowercase segments, `{name}` after the host; no query, no trailing slash
  readonly name: string;                  // `tiktok_` snake_case
  readonly title: string;
  readonly description: string;
  readonly tool: AnyToolSpec;             // must be readOnlyHint: true
  readonly args: Readonly<Record<string, unknown>>;   // fixed; may not name `account` or a path parameter
  /** Completion sources by path parameter (mcp/completions.ts); never
   *  `account`, which the server completes from the profiles on every
   *  resource; only names the URI carries. Absent ⇒ a parameter completes
   *  to nothing. Never sent by describeResource / describeResourceTemplate. */
  readonly completions?: Readonly<Record<string, CompletionSource>>;
}

/** What `resources/read` resolved a requested path to. */
export interface ResourceMatch {
  readonly spec: ResourceSpec;
  /** Path-parameter values by name, percent-decoded; `{}` for a concrete URI. */
  readonly params: Readonly<Record<string, string>>;
}

export interface ParsedResourceUri {
  readonly uri: string;                   // canonical `tiktok://host/path`, query stripped
  readonly account?: string;
}

/** Validates and freezes (spec, `args` and `completions`); a violation throws
 *  TikTokError `invalid_resource_spec` (kind `internal`) at module load. A
 *  `{name}` segment must be a valid argument name
 *  (`[a-z][a-z0-9]*(_[a-z0-9]+)*`), may not sit in the host segment, may not
 *  repeat, may not be `account`, and may not be fixed by `args` too. A
 *  `completions` key must be a `{name}` of the URI and not `account`, and a
 *  `values` source must list something and repeat nothing
 *  (`completionSourceProblem`). */
export function defineResource(spec: ResourceSpec): ResourceSpec;

/** The `{name}` segments of `spec.uri`, in path order; `[]` for a concrete URI. */
export function resourceParams(spec: ResourceSpec): readonly string[];

/** `resourceParams(spec).length > 0` — listed by `resources/templates/list` only. */
export function isResourceTemplate(spec: ResourceSpec): boolean;

/** The `resources/list` entry; `marker` (§ 6.1's `[UNAVAILABLE: …]`, from
 *  unavailableMarker(spec.tool, profiles)) is prefixed to the description. */
export function describeResource(spec: ResourceSpec, marker?: string): Resource;

/** The `resources/templates/list` entry: `uriTemplate` = `${uri}{?account}` —
 *  RFC 6570 as it stands, `tiktok://publish/{publish_id}/status{?account}` for
 *  a template. */
export function describeResourceTemplate(
  spec: ResourceSpec,
  marker?: string,
): ResourceTemplate;

/** The spec a `completion/complete` resource ref names: `uri` equal to
 *  `spec.uri` or to `describeResourceTemplate(spec).uriTemplate` — the
 *  resource as either list advertises it, with or without `{?account}`; a
 *  read URI with a bound value, a query, or a spec not in `specs` is
 *  undefined. Manifest order; no percent-decoding. */
export function matchResourceRef(
  specs: readonly ResourceSpec[],
  uri: string,
): ResourceSpec | undefined;

/** `{ kind: 'profiles' }` for `account` on every spec; the declared source
 *  (or undefined) for a `{name}` of the URI; any other name — a fixed
 *  argument, a tool input the URI does not carry — throws
 *  McpError(InvalidParams, `Invalid arguments for resource <spec.uri>: unknown
 *  argument "<argument>"`). */
export function resourceCompletion(
  spec: ResourceSpec,
  argument: string,
): CompletionSource | undefined;

/** undefined for anything that is not `tiktok://…` with at most one non-blank
 *  `account` query parameter and no `#` at all (an empty trailing fragment,
 *  which `URL` reports as none, included) — and for anything `URL` would
 *  repair: userinfo, a port, a tab/CR/LF, a `.`/`..` segment (plain or
 *  `%2e`), a query key not literally `account`, `account` without `=`, an
 *  empty pair. The value is percent-decoded only (`+` stays a plus). A
 *  trailing slash survives into `uri` and therefore misses the lookup — one
 *  canonical spelling per resource. */
export function parseResourceUri(raw: string): ParsedResourceUri | undefined;

/** The spec `parsed.uri` names, or undefined. A concrete `uri` equal to the
 *  path wins, in manifest order; then the templates, in manifest order — a
 *  template matches when every `{name}` segment is one non-empty path segment
 *  and every other segment is equal; each value is percent-decoded, and a
 *  malformed escape is no match. `tiktok://publish//status` matches nothing;
 *  the template read verbatim matches itself, with `publish_id: '{publish_id}'`
 *  (the URL parser percent-encodes the braces) — the tool answers for it. */
export function matchResource(
  specs: readonly ResourceSpec[],
  uri: string,
): ResourceMatch | undefined;

/** `{ ...match.spec.args, ...match.params, account? }` — the arguments callTool
 *  is given. */
export function resourceArgs(
  match: ResourceMatch,
  parsed: ParsedResourceUri,
): Record<string, unknown>;

/** Envelope → one text content under the *requested* uri: the same
 *  truncateResult(result, settings.resultCharBudget, { pretty }) text that
 *  toCallToolResult mirrors (CC-G2/CC-G7). `ok: false` is still a read, never a
 *  protocol error. */
export function resourceContents(
  uri: string,
  result: ToolResult<unknown>,
  settings: Settings,
): ReadResourceResult;
```

## tools/publish-common.ts

Everything the four write tools do identically. `tiktok_post_video`,
`tiktok_upload_video_draft`, `tiktok_post_photos` and
`tiktok_upload_photos_draft` differ only in the payload they resolve and the
endpoint they hit; the result envelope, the write-only half of the § 3.0
catalog, the § 2.6.3 pipeline, the journal records and the failure
classification are one contract stated four times. Four copies would be four
places for the guarantee a refused duplicate rests on to drift, so they live
here and the tool modules read as payload plus glue.

```ts
export interface AccountBlock {
  profile: string;
  /** From `creator_info`. Absent on the draft tools, which never run that
   *  pre-flight — a `video.upload`-only grant may not even carry the scope
   *  (TOOLS.md § 3.9), so there is no honest value to put here. */
  nickname?: string;
  open_id_masked: string;                  // `maskOpenId` (TOOLS.md § 2.5)
}

export interface CreatorBlock {
  privacy_level_options: readonly string[];
  comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
}

/** What a `source: "file"` preview tells the user before they approve bytes. */
export interface ChunkSummary { file_size: number; chunk_size: number; chunks: number }

export type SourceBlock =
  | { type: "url"; url: string }                                  // video, PULL_FROM_URL
  | { type: "file"; resolved_path: string; file_size: number;     // video, FILE_UPLOAD
      chunk_summary: ChunkSummary }
  | { type: "url"; urls: readonly string[]; photo_cover_index: number };  // carousel

/** `mode: "applied"` — the post or draft exists (or is processing) upstream. */
export interface AppliedData {
  mode: "applied";
  publish_id: string;
  status: string;                          // `initialStatus(source)` before any poll
  public_post_id?: string;                 // only once published, public posts only;
                                           // exact decimal (int64 past 2^53 kept as source digits)
  journal: "recorded" | "unavailable";
}

/** What the two posting tools return before anything is sent (TOOLS.md
 *  § 2.6.1): the whole of what the user is asked to approve, in one object.
 *  `mode: "plan_incomplete"` is the same shape minus the plan — § 2.6.1 step 4
 *  refuses to mint one while `privacy_level` is unchosen and answers with the
 *  live options instead of a token. */
export interface WritePreview {
  mode: "plan" | "plan_incomplete";
  plan_id?: string;              // absent exactly when mode is "plan_incomplete"
  expires_at?: string;           // absolute ISO-8601 UTC (CC-H2)
  missing?: readonly string[];   // what kept a plan from being minted; ["privacy_level"] today
  account: AccountBlock;
  action: string;                // what is being approved, e.g. "DIRECT_POST video"
  // `post_info` is absent while `privacy_level` is — it cannot be resolved yet.
  payload: { post_info?: Record<string, unknown>; source: SourceBlock };
  derived?: readonly DerivedField[];
  creator: CreatorBlock;
  audit_restrictions_active: boolean;
  consent_line: string;
  meta: { rate_bucket: RateBucketSnapshot };
}

/** The draft preview: `WritePreview` minus everything `creator_info` feeds.
 *  The omission is the contract, not an economy — without the pre-flight there
 *  is no nickname, no privacy options and no consent line to state, and
 *  echoing empty ones would suggest the draft carries settings it does not.
 *  There is no `plan_incomplete` twin either: no field is left for the user to
 *  choose, so a draft preview is either a plan or an error. `post_info` is
 *  present for the photo draft (title + description) and absent for the video
 *  draft, whose inbox init accepts none. */
export interface DraftPreview {
  mode: "plan";
  plan_id: string;
  expires_at: string;
  account: AccountBlock;
  action: string;
  payload: { post_info?: Record<string, unknown>; source: SourceBlock };
  meta: { rate_bucket: RateBucketSnapshot };
}

/** FILE_UPLOAD ⇒ "PROCESSING_UPLOAD", PULL_FROM_URL ⇒ "PROCESSING_DOWNLOAD":
 *  a pull has not moved the bytes yet, an upload has. */
export function initialStatus(source: IntentSource): string;

// --- write-only catalog entries (TOOLS.md § 3.0) ---------------------------

/** `url_prefix_unverified`. Carries the field name because the photo tools
 *  raise the same code for `photo_urls[i]`. `fileAlternative: false` drops the
 *  'use source "file"' sentence — the photo endpoints have no upload at all,
 *  so pointing a caller at a branch that does not exist costs a round of wrong
 *  advice. */
export function urlPrefixUnverifiedError(field: string, fileAlternative?: boolean): ToolError;
/** `network_unsent`. `core/http` never mints this: under `retryClass: "init"`
 *  it cannot tell an unsent request from a delivered one and always errs
 *  toward `network_ambiguous`. This is for failures the tools can prove never
 *  left the process. */
export function networkUnsentError(): ToolError;
/** `network_ambiguous` — the post MAY exist. Never auto-retry through this.
 *  `publishId` is set only for a caller abort that landed after the init
 *  (CC-G4): it rides in `details.publish_id`; the message is unchanged. */
export function networkAmbiguousError(publishId?: string): ToolError;
/** `plan_mismatch` with `details.reason: "file_changed"` (CC-D3): the file at
 *  `file_path` no longer matches the identity bound to the plan. Message,
 *  verbatim: "The file changed since plan: the file at file_path no longer
 *  matches the size, modification time and identity captured when the preview
 *  was generated. Generate a fresh preview and apply again." */
export function fileChangedError(): ToolError;
/** `upload_interrupted` (CC-D5). The init succeeded, so the caller must be told
 *  which `publish_id` to check; recovery is a NEW attempt, never a resume.
 *  The id is upstream-originated and the message instructs, so it reaches both
 *  of its grammatical slots through `hintToken` (§ 3.0): a refused id is
 *  dropped from the sentence, which then points at `details.publish_id` — the
 *  field carries the raw value either way. `detail` is the transport cause and
 *  never enters the sentence; it lives in `details.reason`. */
export function uploadInterruptedError(
  publishId: string, chunk: number, total: number, detail: string,
): ToolError;
/** `possible_duplicate`. Takes the whole matched attempt because the normative
 *  text names the profile, timestamp, outcome and publish_id. `profile` is
 *  server configuration and `matched.ts` a timestamp this server wrote;
 *  `matched.publish_id` is upstream, replayed out of the journal, so it reaches
 *  the message through `hintToken` (§ 3.0) and a refused id drops the clause
 *  exactly as an absent one already does. `details.publish_id` still carries
 *  it. */
export function possibleDuplicateError(profile: string, matched: JournalAttempt): ToolError;

// --- hints (TOOLS.md § 5) --------------------------------------------------

export function pollHint(publishId: string, pollAfter: string): Hint;
/** Carries `poll_after` like every other `poll` hint (§ 2.7): a caller told to
 *  poll with no instant to poll at is a caller that will poll too soon. */
export function stillProcessingAfterApplyHint(
  publishId: string, status: string, timeoutS: number, pollAfter: string,
): Hint;
export function journalUnavailableNote(publishId: string | undefined): Hint;
export function choosePrivacyHint(toolName: string, options: readonly string[]): Hint;
/** Every successful draft apply (§ 3.9, § 3.11). Verbatim from TOOLS.md § 5.3,
 *  which is the normative rendering: "Unopened drafts expire." */
export function draftInboxHint(): Hint;
/** The two normative § 2.6.1 consent lines, branded and plain. */
export function consentLine(brandContent: boolean, brandOrganic: boolean): string;

// --- context helpers -------------------------------------------------------

export function planLimits(ctx: ToolCtx): PlanStoreOptions;
export function signalOpt(ctx: ToolCtx): { signal?: AbortSignal };
export function creatorBlock(info: CreatorInfo): CreatorBlock;
/** The `open_id` a plan is bound to. Re-read on every call rather than cached:
 *  a re-login can change the account behind a profile name between preview and
 *  apply, which is exactly the `plan_mismatch` this binding exists to catch. */
export function resolveOpenId(ctx: ToolCtx): Promise<string>;
export function accountBlock(profile: string, openId: string, nickname?: string): AccountBlock;
/** Local, pre-network URL validation for both `video_url` and `photo_urls[i]`:
 *  absolute, `https:`, no embedded credentials (CC-D10), then verified prefix.
 *  An unverified prefix must never become a TikTok round-trip — TikTok's own
 *  refusal arrives as an opaque upstream code. */
export function checkMediaUrl(
  url: string, field: string, prefixes: readonly string[], fileAlternative?: boolean,
): ToolError | undefined;

// --- plan lifecycle (TOOLS.md § 2.6) ---------------------------------------

/** Step 2 of § 2.6.3, as a result rather than a throw. A *peek*: it reads the
 *  bucket and refuses early, but spends nothing — the token is taken at step 7,
 *  once the call is known to be a real publish. */
export function checkWriteBucket(ctx: ToolCtx): ToolResult<never> | undefined;
/** Mint and store the preview's token; returns what the preview must echo. */
export function mintPlan(
  ctx: ToolCtx, toolName: string, digest: string, openId: string,
): { planId: string; expiresAt: string; hint: Hint };
/** Steps 5, 6 and 7 of § 2.6.3, in the one order that is safe. Returns a whole
 *  `ToolResult`, not a bare `ToolError`: taking the rate token lives here now,
 *  and a rate refusal has to carry a hint. */
export function runPlanGuards(
  ctx: ToolCtx, planId: string | undefined, expectation: PlanExpectation, force: boolean,
): Promise<ToolResult<never> | undefined>;

// --- dispatch (TOOLS.md § 2.6.3 steps 8–9) ---------------------------------

/** Where the bytes stand when a dispatch fails — for `upload_interrupted`. */
export interface ChunkPosition { chunk: number; total: number }

/** What a sender reports once its init has returned and more can still fail:
 *  the `publish_id` TikTok minted, and where the bytes stand at any later moment. */
export interface InitialisedUpload { publishId: string; position: () => ChunkPosition }

export interface DispatchOptions {
  toolName: string;
  mode: string;                  // journalled `mode` = the upstream post_mode (§ 2.6.2)
  source: IntentSource;
  title: string;                 // what the journal's title_excerpt is cut from — a human
                                 // reading it, not the guard, which matches on digest;
                                 // "" for the video draft, which has no title; the
                                 // photo tools pass title and description joined
  digest: string;
  planId: string;                // "" only under TT_WRITE_MODE=apply with no token
  openId: string;
  /** The upstream half. Calls `report` the moment an init returns a
   *  `publish_id` a later step can still fail behind (the chunk upload): that
   *  call is the whole failure classification. A sender whose init is its last
   *  throwable step (URL video, photos) never reports — its publish_id is the
   *  resolved value, and every failure it can raise is honestly pre-init. */
  send: (report: (started: InitialisedUpload) => void) => Promise<string>;
}

/** Everything after the plan is consumed: journal intent (fsync'd) → dispatch
 *  → journal outcome. Split out because from here on a failure is no longer
 *  "nothing happened", and the record on disk is the only thing that can tell
 *  a user which. An outcome whose intent never reached the disk is not
 *  written — the reader drops such orphans anyway — and the result is marked
 *  `journal: "unavailable"` with a note hint instead of failing the publish. */
export function dispatchWrite(
  ctx: ToolCtx, opts: DispatchOptions,
): Promise<DispatchResult>;

/** A dispatch that reached TikTok, as a type that says so. The pair exists so
 *  that `ok` and the presence of `data` are one fact rather than two: the
 *  success arm carries `data` non-optionally, the failure arm forbids it, and
 *  `waitIfAsked` reads the discriminant instead of testing `data === undefined`
 *  and excluding the impossible half from coverage. */
export type AppliedResult = ToolResult<AppliedData> & { ok: true; data: AppliedData };
export type FailedDispatch = ToolResult<AppliedData> & { ok: false; data?: undefined };
export type DispatchResult = AppliedResult | FailedDispatch;

/** What `waitIfAsked` returns: a success arm whose `hints` are guaranteed
 *  present (it always attaches at least the `poll` hint), and the failure arm
 *  passed through untouched. */
export type WaitedResult = (AppliedResult & { hints: Hint[] }) | FailedDispatch;

/** Attach the `poll` hint, optionally after waiting for a terminal status
 *  (TOOLS.md § 2.7). An accepted post stays accepted: a poll timeout and a
 *  status read that throws are both non-errors and neither downgrades `ok` —
 *  both fall back to the exact hint an immediate return would have carried. */
export function waitIfAsked(
  ctx: ToolCtx, result: DispatchResult, waitForCompletion: boolean,
): Promise<WaitedResult>;
```

**The apply path's step order is contract, not implementation detail**
(TOOLS.md § 2.6.3): validate locally → **read** the local rate bucket without
spending (before any network, § 2.8) → re-resolve through the preview's own code
path against live `creator_info` → recompute the payload digest → `verifyPlan` →
duplicate guard → **peek** the rate token again → `consumePlan` → **take** the
rate token → journal the intent (fsync'd) → dispatch → journal the outcome. The
three calls of step 7 run with no `await` between them: the peek refuses an
emptied bucket with the plan still unspent, the consume comes before the take so
a plan lost to a concurrent apply during the duplicate guard's file read costs
no token, and the take cannot refuse what the peek allowed. The bucket is read early and spent
late on purpose: it exists to protect the *account* from too many real publishes,
and a call refused for a stale `plan_id`, a changed payload or a suspected
duplicate never reaches TikTok — burning a token on it would let a caller retrying
a bad `plan_id` lock itself out of publishing. There is no give-back path, because
`refill` banks the sub-interval remainder in `updatedAt` and returning a token
would return accrued time with it. `peekPublishToken` and `takePublishToken` share
one verdict function so the early read and the late take cannot disagree.
Verification and consumption are two calls into `mcp/plan-store` on purpose: the
duplicate guard's file read sits between them, so a `possible_duplicate` refusal
leaves the same `plan_id` appliable with `force: true`, while the plan is still
spent atomically before anything reaches the wire (CC-E7). `runPlanGuards` owns
steps 5–7 and `dispatchWrite` owns 8–9; a tool module that wrote its own order
would be re-deciding this.

**The dividing line inside a dispatch is `report`.** Before an init returns a
`publish_id`, `retryClass: "init"` has already turned every ambiguous transport
failure into `network_ambiguous` (journal `send_ambiguous`), and any remaining
`network` failure provably never left the process, so it is `network_unsent`
(journal `error`). After `report`, the attempt exists upstream whatever happened
to the bytes: the outcome is `upload_failed`, never `error`, which a reader would
take as "nothing was created" (CC-B4). A **caller cancellation** is the exception
on both sides (CC-G4): when the signal fires while the send is in flight — the
init or mid-upload — the init or the last chunk may have completed anyway, so it
is `network_ambiguous`, journaled `send_ambiguous` (after `report` with the
`publish_id` and `chunk`, and `details.publish_id` on the error), which the
duplicate guard counts and so blocks a blind retry. A signal that had already
fired before the send began carried no live request and stays `error`. The
second exception after `report` is a `network_ambiguous` thrown by
`uploadFile` — a transport failure on the final chunk, any later failure of a
final chunk one of whose attempts lost its answer, or a final-chunk `416`
reporting progress of exactly `total − 1` bytes, each of which may have
completed the upload: `classifyDispatch` records it as `send_ambiguous` with
`error_code: "network_ambiguous"`, the `publish_id` and the chunk, never
`upload_failed`.

## tools/publish-write.ts

The video half of the write surface: `tiktok_post_video` (TOOLS.md § 3.8) and
`tiktok_upload_video_draft` (§ 3.9). Both sources ship — `"url"`
(`PULL_FROM_URL`) and `"file"` (`FILE_UPLOAD` through `api/upload.ts` under
`TT_MEDIA_ROOT`) — and one `resolveSource` serves four consumers: what the
preview shows, what the init sends, what the digest binds and what the journal
records.

```ts
/** The two result modes of § 3.8, from `tools/publish-common.ts`. */
export type PostVideoData = WritePreview | AppliedData;
/** § 3.9: a draft has no `creator` block, no `consent_line` and no
 *  `plan_incomplete` mode, so its preview is the narrower `DraftPreview`. */
export type UploadDraftData = DraftPreview | AppliedData;

/** package "publish-write", scopes ["video.publish"], annotations
 *  destructive + non-idempotent + open-world. The input type is inferred from
 *  the tool's own `toolInput({...})` schema. */
export const postVideoTool: ToolSpec<PostVideoInput, PostVideoData>;
/** package "publish-write", **scopes ["video.upload"]** — deliberately not
 *  `video.publish`: this tool must work on a draft-only authorization, which
 *  is also why it runs no `creator_info` pre-flight. Same annotations. */
export const uploadVideoDraftTool: ToolSpec<UploadDraftInput, UploadDraftData>;
```

**The `source` union is a flat strict object, not a `z.discriminatedUnion`.**
Both schemas expose `source: z.enum(["file","url"])` plus optional `file_path`
and optional `video_url`, and the mutual exclusion is an imperative check in the
handler that answers `invalid_params` for a missing or a mismatched field. A
discriminated union produces a JSON Schema with no top-level object shape, which
both `mcp/define`'s strictness contract and every model reading the manifest
depend on; the flat object plus the check is the same contract with a schema a
client can actually render. `plan_id` is validated the same way, against
`PLAN_ID_PATTERN` in the handler, because a `.refine()` would make the schema a
`ZodEffects` and cost the same shape. TOOLS.md § 3.8 records both.

**What the digest binds** (`mcp/plan`, § 2.6.2). Post:
`{ post_info, post_mode: "DIRECT_POST", source_info }`. Draft:
`{ post_mode: "MEDIA_UPLOAD", source_info }` — no `post_info`, because the inbox
init accepts none. For `source: "url"` the `source_info` is
`{ source: "PULL_FROM_URL", video_url }`; for `source: "file"` it is
`{ source: "FILE_UPLOAD", video_size, chunk_size, total_chunk_count,
resolved_path }`. `resolved_path` is digested although it is never sent
upstream: the user approved *this* file, and two different files of identical
size would otherwise share a digest and be interchangeable under one plan.

**The file path's two file-system checkpoints are both contract.**
`resolveMediaFile` + `planChunks` run at preview time, before the rate token is
spent, so the approved preview names the real resolved path, size and chunk
count; `verifyMediaFile` re-stats immediately before the first PUT, after the
init and after `report`, so a file swapped between preview and apply surfaces as
a rejection rather than as a silent upload of different bytes (CC-D3/CC-D4).
`position()` reports `chunk: done + 1` — `done` counts *accepted* chunks, so the
one that failed is the next one.

## tools/publish-photos.ts

The carousel half: `tiktok_post_photos` (TOOLS.md § 3.10) and
`tiktok_upload_photos_draft` (§ 3.11). There is no `source` field and no
`"file"` branch — the photo endpoints pull from URLs only — so both tools are
`PULL_FROM_URL` and both go through `initPhotoPost`, which returns a
`publish_id` and no upload URL.

```ts
export type PostPhotosData = WritePreview | AppliedData;
export type UploadPhotosDraftData = DraftPreview | AppliedData;

/** package "publish-write", scopes ["video.publish"], annotations
 *  destructive + non-idempotent + open-world. */
export const postPhotosTool: ToolSpec<PostPhotosInput, PostPhotosData>;
/** package "publish-write", scopes ["video.upload"]. Unlike the video draft,
 *  this one DOES carry a `post_info`: `resolvePhotoDraftPostInfo` resolves
 *  title + description, which the photo draft endpoint accepts and the app
 *  editor prefills. No `creator_info` pre-flight either way. */
export const uploadPhotosDraftTool: ToolSpec<UploadPhotosDraftInput, UploadPhotosDraftData>;
```

**Both cross-field rules are enforced before any network call**, on the preview
call and again on the apply call, ahead of `creator_info` and ahead of the init:
a `photo_cover_index` at or past `photo_urls.length` is `invalid_params` (zod
bounds the array, nothing in a flat schema can bound an index against it), and
every entry is put through `checkMediaUrl(url, "photo_urls[<i>]", prefixes,
false)`. Offenders are reported **one at a time, by index** — a model told which
entry is wrong fixes that entry, where a list of every offender invites a blind
re-send — and with `fileAlternative: false`, since photos have no `source:
"file"` to fall back to.

**What the digest binds:** `{ media_type: "PHOTO", post_mode, post_info,
source_info: { source: "PULL_FROM_URL", photo_images, photo_cover_index } }`,
built by the same function on both the preview and the apply path so the two
digests can differ only if the payload really did. The journal's
`title_excerpt` is cut from title **and** description joined: a carousel is
frequently untitled with all its text in the description, and excerpting only
the title would make every such journal line look identical to the person
reading it. (The duplicate guard matches on `payload_digest`, not the title.)

## tools/prompts.ts

The prompt manifest (TOOLS.md § 7.1): the three write flows, each one `user`
text message, package `publish-write`; the array is what `src/index.ts` hands
to `createServer`. The sentences the flows share — approval, the plan's life,
the poll, the failure discipline — are module constants the three compose, so
they cannot drift apart. Every `tiktok_*` name in the text is checked against
`allTools()` by `test/tool-prompts.test.ts`.

```ts
/** `tiktok_post_video_guided`. Arguments: `video` (required — local path or
 *  https URL), `title`, `privacy_level`, `account`. The § 4 item 1 flow with
 *  § 3.8's failure discipline, arguments interpolated as sentences. All three
 *  prompts declare `requires: ['publish']` and render every user value
 *  JSON-quoted, so a quote or newline in it cannot inject a step. */
export const postVideoGuidedPrompt: PromptSpec;

/** `tiktok_post_photos_guided`. Arguments: `photo_urls` (required — one string,
 *  split on commas and whitespace, blanks dropped), `title`, `description`,
 *  `privacy_level`, `account`. The § 3.10 flow: creator info, preview with the
 *  urls as an array and `photo_cover_index` 0 unless told otherwise, approval,
 *  apply, poll to PUBLISH_COMPLETE; `url_prefix_unverified` names
 *  `photo_urls[<i>]`. A value that names no URL renders a request for them and
 *  no steps. */
export const postPhotosGuidedPrompt: PromptSpec;

/** `tiktok_upload_draft_guided`. Arguments, all optional: `video`,
 *  `photo_urls`, `title`, `description`, `account` — exactly one of the two
 *  media. Four renders: a video ⇒ the § 3.9 flow (`tiktok_upload_video_draft`;
 *  a `title` and/or a `description` is stated as not sent — one sentence for
 *  either or both); photos ⇒ the § 3.11 flow (`tiktok_upload_photos_draft`,
 *  title and description passed when given); both ⇒ ask which one, no steps;
 *  neither ⇒ ask for one, no steps. The valid flows say not to call
 *  `tiktok_get_creator_info`, preview (always `mode: "plan"`), approval, apply,
 *  poll to SEND_TO_USER_INBOX; `pending_share_cap` stops. */
export const uploadDraftGuidedPrompt: PromptSpec;

/** Frozen, in listing order: video, photos, draft. Each render stays under
 *  2,500 characters for up to three URLs of realistic length. */
export const PROMPTS: readonly PromptSpec[];
```

Completion sources (TOOLS.md § 7.3) are declared on the shared argument
constants, never per prompt: every `account` argument carries
`{ kind: 'profiles' }` and every `privacy_level` argument
`{ kind: 'values', values: PRIVACY_LEVELS }` — the `api/publish.ts` tuple the
write tools' schema is built from, so the completion and the schema cannot
disagree. Every other argument is free text and declares nothing. The listed
shape on the wire stays `name`, `description`, `required`.

## tools/resources.ts

The resource manifest (TOOLS.md § 7.2): six read tools, each exposed at a URI
as its *default* answer — `args: {}` — except where the default would block:
the status resource fixes `wait_for_completion: false`, because the tool's
default polls for up to ~60 s and a snapshot must return at once. The one
tool argument a read cannot default, `publish_id`, is a `{publish_id}` path
parameter, which makes that entry the manifest's one template.

```ts
export const authStatusResource: ResourceSpec;     // tiktok://auth/status    → tiktok_get_auth_status
export const userInfoResource: ResourceSpec;       // tiktok://user/info      → tiktok_get_user_info
export const recentVideosResource: ResourceSpec;   // tiktok://videos/recent  → tiktok_list_videos (one default page)
export const creatorInfoResource: ResourceSpec;    // tiktok://creator/info   → tiktok_get_creator_info
export const publishJournalResource: ResourceSpec; // tiktok://publish/journal → tiktok_list_publish_journal; `?account=` is the tool's filter (§ 2.2)
export const publishStatusResource: ResourceSpec;  // tiktok://publish/{publish_id}/status → tiktok_get_publish_status, args { wait_for_completion: false }, completions { publish_id: { kind: 'publish_ids' } }; a template

/** Frozen, in that order — the template last; every uri and name unique. */
export const RESOURCES: readonly ResourceSpec[];
```

## cli/index.ts (dispatch + process seams)

The CLI is the one layer allowed to import from anywhere, and the one place a
human — not a model — reads the output. Two rules make it testable and keep it
honest, and both are contract rather than style:

1. **`runCli` returns the exit code; it never calls `process.exit`.** Only
   `src/index.ts` touches `process`. A subcommand that exits by itself cannot be
   asserted on, and it takes any pending write on stdout/stderr with it.
2. **Everything a subcommand needs from the outside world arrives through
   `CliDeps`** — argv, env, both streams, TTY-ness, clock, logger, prompt,
   browser, the loopback listener, entropy, `rename`. A test drives the whole
   login flow without a terminal, a socket, a browser, or `process.env`.

```ts
export const EXIT_OK = 0;        // did what it was asked
export const EXIT_FAILURE = 1;   // ran and failed (network, refusal, denied consent)
export const EXIT_USAGE = 2;     // invoked wrongly (unknown subcommand, bad flag, no TTY)
export const CLI_NAME = "tiktok-mcp-ai";

/** One inbound request to the loopback callback server (CC-A8/CC-A9). */
export interface CallbackRequest { readonly method: string; readonly url: string }
export interface CallbackReply { readonly status: number; readonly body: string }
/** Synchronous on purpose: the single-accept decision must not interleave. */
export type CallbackHandler = (req: CallbackRequest) => CallbackReply;
export interface LoopbackServer { readonly port: number; close(): Promise<void> }
export type ListenFn = (
  handler: CallbackHandler, opts: { host: string; port: number },
) => Promise<LoopbackServer>;

export interface CliDeps {
  argv?: readonly string[];       // args AFTER the subcommand
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;     // overrides process.platform (CC-F3); see below
  modulePath?: string;            // overrides where this build reports being loaded from
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  isTTY?: boolean;                // default: stdin AND stdout are terminals
  clock?: Clock;
  logger?: Logger;
  prompt?: (question: string) => Promise<string>;
  openBrowser?: (url: string) => Promise<void>;
  listen?: ListenFn;
  randomBytes?: (size: number) => Uint8Array;
  rename?: (from: string, to: string) => Promise<void>;
}

export interface CliIo {
  out(text: string): void;     // redacted
  err(text: string): void;     // redacted
  errRaw(text: string): void;  // NOT redacted — see below
  readonly isTTY: boolean;
}
export function cliIo(deps: CliDeps): CliIo;

/** env file first, process environment on top (presence-based, CC-F2). */
export function overlayEnvFile(
  env: NodeJS.ProcessEnv, snapshot: EnvFileSnapshot,
): NodeJS.ProcessEnv;

export function isCliInvocation(argv: readonly string[]): boolean;
export function usageText(): string;
/** The version declared by the `package.json` at `url`, else `'0.0.0-unknown'`:
 *  a missing file, non-JSON, a non-object, or a `version` that is absent, empty
 *  or not a string all degrade the same way — `--version` never crashes the CLI. */
export function versionAt(url: URL): Promise<string>;
/** `versionAt` of this build's own `package.json`, cached after the first read. */
export function packageVersion(): Promise<string>;

/** Subcommands are reached through `await import(...)` so the server path pays
 *  for neither. Returns the intended exit code. */
export function runCli(argv: readonly string[], deps?: CliDeps): Promise<number>;

// cli/login.ts, cli/doctor.ts — one entry point each, same deps type:
export function runLogin(deps?: CliDeps): Promise<number>;
export function runDoctor(deps?: CliDeps): Promise<number>;

// cli/login.ts — the scope tables, exported for the drift gate in
// test/manifest.test.ts (TOOLS.md § 2, scope column):
/** Scopes `login` requests per enabled package. A superset of what the
 *  registered tools declare is legal and intended — `user` asks for the
 *  profile/stats scopes that gate optional fields — but a scope a tool needs
 *  and this table omits is an authorization failure nobody can act on. */
export const PACKAGE_SCOPES: Readonly<Record<PackageName, readonly string[]>>;
/** The closed set of scopes this server knows, in TikTok's own consent order.
 *  Also the typo gate: a requested scope outside it comes back from TikTok as a
 *  generic authorization failure. */
export const SCOPE_ORDER: readonly string[];

// cli/prompt.ts — the interactive prompt seam, shared by `login` (CC-A10,
// CC-A11) and `doctor` (CC-F3). The split separates the decision a test can
// make from the process binding it cannot: `readLine` is the reading over any
// two streams, `promptOf` answers *which* prompt is in force and is asserted by
// identity, and `defaultPrompt` binds the real `process.stdin`/`process.stderr`
// and is the only line excluded from coverage. `ask` is the call both commands
// make.
export async function readLine(
  question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
): Promise<string>;
export const defaultPrompt: (question: string) => Promise<string>;
export function promptOf(deps: CliDeps): (question: string) => Promise<string>;
export async function ask(deps: CliDeps, question: string): Promise<string>;

// cli/login.ts — the browser seam, split the same way: `browserCommand` and
// `spawnDetached` are the testable halves, `openBrowserOf` the observable
// choice, `defaultOpenBrowser` the one excluded binding of `process.platform`.
export function browserCommand(
  url: string, platform: NodeJS.Platform,
): { command: string; args: string[] };
export async function spawnDetached(
  opener: { readonly command: string; readonly args: readonly string[] },
): Promise<void>;
export const defaultOpenBrowser: (url: string) => Promise<void>;
export function openBrowserOf(deps: CliDeps): (url: string) => Promise<void>;

// cli/login.ts — the loopback listener's undecidable request line, split out of
// the listener so it is an ordinary function rather than an excluded branch
// (the listener's port comes from core/net's `boundPortOf`, § core/net.ts):
export function callbackRequest(
  method: string | undefined, url: string | undefined,
): CallbackRequest;

/** The journal and its single rotation, both siblings of the resolved env file.
 *  A fixed pair, not a list — `--purge-journal` needs exactly these two. */
export function journalPaths(envFilePath: string): readonly [string, string];
```

**`CliIo.errRaw` is a deliberate, single-call-site hole in redaction.**
`redactText` masks `client_key`, `state` and `code_challenge` by parameter name,
which is correct for a *logged* URL and fatal for one the operator has to open:
the masked form is not an authorization request. `errRaw` writes the consent URL
and nothing else. Adding a second call site is a contract change, not a local
decision — and the URL it prints carries no secret by construction (client key,
scopes, redirect URI, the CSRF `state` the browser is about to send anyway, and
the PKCE challenge, which is public by design; the verifier and the client
secret never enter it).

## cli/doctor.ts (the check registry)

`doctor` is the one command that runs when nothing else works, so its contract
is not `runDoctor` — it is the **shape of a check**. TASK-BREAKDOWN gives TC-3
the ordered check-list; a later task contributes a health check by adding a
`Check` to `DOCTOR_CHECKS`, never by editing another task's check or the runner.

```ts
export type Severity = "ok" | "info" | "warn" | "fail";

export interface Finding {
  readonly severity: Severity;
  readonly text: string;          // one line; the renderer prefixes the title
  readonly remediation?: string;  // the command or edit that resolves it
}

/** Everything the checks read, resolved once before the first one runs. */
export interface DoctorContext {
  readonly deps: CliDeps;
  readonly io: CliIo;
  readonly platform: NodeJS.Platform;
  readonly modulePath: string;              // where this build is loaded from (npx cache?)
  readonly clock: Clock;
  readonly logger: Logger;
  readonly envFilePath: string;             // read source AND write target
  readonly snapshot: EnvFileSnapshot;
  readonly env: NodeJS.ProcessEnv;          // env file first, process env on top (CC-F2)
  readonly settings?: Settings;             // absent when loadSettings rejected it (CC-F6)
  readonly settingsError?: unknown;
  readonly profile: string;
  readonly credentials?: ProfileCredentials;
  readonly credentialsError?: unknown;
  readonly offline: boolean;
}

export interface Check {
  readonly id: string;    // stable — it is what a bug report quotes
  readonly title: string; // prefixes every row the check produces
  run(ctx: DoctorContext): Promise<readonly Finding[]>;
}

export const DOCTOR_CHECKS: readonly Check[];   // frozen, in report order
export function doctorUsage(): string;
export function parseDoctorArgs(argv: readonly string[]):
  | { readonly ok: true;
      readonly flags: { profile?: string; offline: boolean; json: boolean; help: boolean } }
  | { readonly ok: false; readonly message: string };

export type Tally = Record<Severity, number>;
export function renderFinding(check: Check, found: Finding): string;
export function renderSummary(tally: Tally): string;

/** One check's contribution to the `--json` document. */
export interface DoctorReportCheck {
  readonly id: string;
  readonly title: string;
  readonly findings: readonly Finding[];   // empty when the check had nothing to say
}

/** What `--json` prints: one schema-tagged, versioned document. `version` rises
 *  when a field changes meaning or disappears — a new field does not, so a
 *  consumer ignores what it does not recognize. Nothing in it is timed or
 *  hashed: two runs of one configuration produce identical bytes. */
export interface DoctorReport {
  readonly schema: "tiktok-mcp-ai/doctor-report";
  readonly version: 1;
  readonly profile: string | null;                // null when none was resolved
  readonly offline: boolean;
  readonly checks: readonly DoctorReportCheck[];  // DOCTOR_CHECKS order, every check
  readonly tally: Tally;
  readonly exit_code: number;                     // the code this document belongs to
}
export function renderJsonReport(report: DoctorReport): string;
```

Four rules bind:

1. **A check reports; it does not abort the report.** `runDoctor` wraps every
   `run` in its own `try`/`catch`, so a check that throws becomes one `fail` row
   and the remaining checks still run. Doctor's whole value is that it keeps
   reporting when things are broken.
2. **Only `fail` decides the exit code** (`fail > 0 → EXIT_FAILURE`). `warn` and
   `info` are readiness commentary — a gate that trips on "`TT_MEDIA_ROOT` is not
   set" is a gate nobody keeps.
3. **`DoctorContext.platform` is the seam, not `process.platform`.** CC-F3's two
   halves — the POSIX `chmod` offer and the Windows `icacls` remediation *text*,
   which is printed and never executed — must both be reachable on every CI leg.
   That is why `CliDeps` carries `platform`. `modulePath` is on the context for
   the same reason: the install check's npx-cache branch would otherwise be
   reachable only from a real `npx` run, and `import.meta.url` is not overridable.
4. **`--json` puts one document on stdout and nothing else.** No header, no rows,
   no summary — including on the path where the configuration could not be read,
   which reports the reason as the single finding of a synthetic `configuration`
   check rather than leaving a consumer to interpret an empty stream. The two
   exceptions are a usage error (stderr, exit 2) and `--help`, which still prints
   the usage text. `--json` also implies non-interactive: the CC-F3 offer is
   closed off exactly the way a non-TTY run closes it, because a machine consumer
   cannot answer a prompt. The flag changes the rendering, never the exit code.

## Test harness (test/helpers.ts — consumed by every task)

```ts
/** The injectable fetch shape (api/http.ts's `fetch` seam). A stub either
 *  implements this signature directly or is built by `scriptFetch` below from
 *  an ordered list of canned Responses (one per expected upstream call). */
export type FetchStub = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** One observed call, for assertions. Header names are lower-cased and a
 *  repeated header is joined with ", " — the wire form, not the input form. */
export interface RecordedCall {
  readonly url: string;
  readonly method: string;                            // upper-cased, GET default
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;                             // verbatim init.body
  text(): string;                                     // UTF-8 decode, '' when none
  json(): unknown;
}
export interface RecordingFetchStub extends FetchStub {
  readonly calls: readonly RecordedCall[];
}
export class ScriptFetchExhaustedError extends Error {}

/** Build a FetchStub that returns the given Responses in order; a call past the
 *  end throws (an unexpected extra request is a test failure, not a hang).
 *  Each Response is handed out as a `clone()`, so the same object may appear
 *  several times — `scriptFetch([boom, boom, ok])` is a retry script. */
export function scriptFetch(responses: Response[]): RecordingFetchStub;

export function baselineEnv(): NodeJS.ProcessEnv;       // minimal valid TT_ set
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T;
export function withFetch<T>(stub: FetchStub, fn: () => Promise<T>): Promise<T>;
export function ttEnvelope(data: unknown, error?: { code: string; message: string }): Response;
export interface MockClock extends Clock {
  advance(ms: number): Promise<void>;   // runs due sleeps deterministically
  pending(): number;                    // waiters still asleep
  setNow(epochMs: number): void;        // the only backwards-step seam
}
export function mockClock(startEpochMs?: number): MockClock;
export function fsSandbox(): Promise<{ dir: string; cleanup(): Promise<void> }>;

/** Frozen baselines, so unrelated suites agree on "now" and on credentials
 *  whose expiries are coherent with it (access +24 h, refresh +1 y). */
export const BASELINE_NOW_MS: number;                   // 2026-01-01T00:00:00.000Z
export const BASELINE_TOKEN_EXPIRES_AT: string;
export const BASELINE_REFRESH_EXPIRES_AT: string;
export const BASELINE_SCOPES: string;
export const TEST_LOG_ID: string;
```

Importing `test/helpers.ts` deletes every ambient `TT_` variable, so a developer
with `TT_ACCESS_TOKEN` exported runs the same suite CI does. The only opt-out is
`TIKTOK_MCP_TEST_INHERIT_ENV=1`, which the multi-process harness sets for its
children; it lives outside the `TT_` namespace on purpose, so it cannot be
mistaken for a product setting or stripped by its own loop.

## Extended harness (test/harness/*.ts)

```ts
// rng.ts — determinism rule 4. mulberry32; the sequence is pinned by a test.
export interface Rng {
  (): number;
  readonly seed: number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bytes(n: number): Uint8Array;
}
export function makeRng(seed: number): Rng;

// deferred.ts — for asserting in-flight states (single-flight proofs).
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
  readonly settled: boolean;
}
export function deferred<T = void>(): Deferred<T>;
export function flush(turns?: number): Promise<void>;   // turn the loop, never sleep

// upload-simulator.ts — chunked PUT protocol (TIKTOK-API § 1.3).
export type InjectedOutcome = { readonly status: number } | { readonly hang: true };
export function uploadSimulator(opts: {
  readonly source: Uint8Array;
  readonly uploadUrl: string;
  readonly inject?: Readonly<Record<number, InjectedOutcome>>;   // 1-based PUT ordinal
}): UploadSimulator;                    // .fetch, .puts, .accepted, .assertComplete()

// token-stub.ts — a real node:http server on port 0 for cross-process tests.
// Answers the FLAT OAuth shape (CC-A12), rotating both tokens with a serial.
export function startTokenStub(opts?: TokenStubOptions): Promise<TokenStub>;
                                        // .baseUrl, .served, .refreshCount, .serial,
                                        // .unexpected, .close()

// multi-process.ts + lock-child.ts — the one real race (CC-F5/A2).
export function runContendingChildren(opts: {
  readonly childModule: string | URL;   // compiled worker, default-exports (ctx) => unknown
  readonly count: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly args?: unknown;
  readonly signal?: AbortSignal;        // deadlock canary — always pass one
}): Promise<ChildOutcome[]>;            // { index, ok, payload?, error? }, index order
```

A worker that *throws* is a reported `ChildOutcome` with `ok: false`, not a
harness error — "the loser sees `env_file_busy`" is the expected result of a
contention test. `runContendingChildren` rejects only if the barrier itself fails
or the canary fires.

```ts
// fixtures.ts — replaying a recorded sandbox interaction (TESTING.md § Recorded
// sandbox fixtures). The format, sanitizer and discovery live in
// scripts/lib/fixtures.ts; this is only the seam back into production code.
export const REPLAY_ORIGIN: string;                 // 'https://open.tiktokapis.com'
export const REPLAY_ACCESS_TOKEN: string;           // what replayContext() carries
export function replayContext(): ApiContext;
export function describeFixture(fixture: Fixture): string;

// Areas whose interactions are recorded and secret-scanned but not replayed,
// each with the reason. Ask before replaying; an unrouted endpoint inside a
// *replayable* area still throws.
export const NON_REPLAYABLE_AREAS: ReadonlyMap<FixtureArea, string>;
export function nonReplayableReason(fixture: Fixture): string | undefined;
export function routedEndpoints(): string[];

export function responseFor(fixture: Fixture): Response;
export interface ReplayOutcome {
  readonly call: RecordedCall;      // what our client actually sent
  readonly value?: unknown;         // what the api function returned
  readonly error?: unknown;         // a TikTokError is a legitimate outcome
}
export function replayFixture(fixture: Fixture): Promise<ReplayOutcome>;

export interface RequestMismatch { readonly what: string; readonly expected: string;
                                   readonly actual: string; }
export function compareRequest(fixture: Fixture, call: RecordedCall): RequestMismatch[];
export function renderMismatches(mismatches: readonly RequestMismatch[]): string;

// Synthetic fixtures — how the suite proves itself while the tree is empty.
export interface SyntheticOverrides { /* url, method, area, responseBody, … */ }
export function envelopeBody(data: unknown, error?: unknown): unknown;
export function syntheticFixture(overrides?: SyntheticOverrides): Fixture;
```

`replayFixture` returns *both* directions from one call, which is not a
convenience: `core/http.ts` reads `globalThis.fetch` off the global at call time
and `src/api/*` exports no standalone response parser, so driving the api
function against a scripted stub is the only seam there is — and it is the seam
that makes the request assertion available in the same breath. A fixture that
records an upstream rejection is a legitimate recording, so an outcome with
`error` set is a pass; only a crash on *shape* is a failure.

---

## Change log

| Date | Change | Approved by |
|---|---|---|
| 2026-07-22 | Initial contracts derived from SYNTHESIS.md | design phase (pre-freeze) |
| 2026-07-23 | HintType narrowed by TA-1 | integrator (Wave-A sanctioned edit) |
| 2026-07-23 | `Hint` expanded with the TOOLS.md § 5.1 structured fields (wait/poll/approval/user_action/reauth); `ToolResult.error` gained `retryable`, `api_code`, `log_id` (CC-B9) | integrator (Wave-A sanctioned edit) |
| 2026-07-23 | Test harness: defined `FetchStub` (was referenced but undefined) + added `scriptFetch` builder | integrator (Wave-A sanctioned edit) |
| 2026-07-29 | `core/redact`: documented that `redactValue` is for structured diagnostics only and that `mcp/result` scrubs tool data with `redactText`; recorded the field allowlist as an integrator-mediated shared resource. No signature change (raised by TB-4) | integrator (Wave-B clarification) |
| 2026-07-29 | `createLogger` gained an optional `clock?: Clock` — additive, so every frozen call form still compiles; required because `Date.now` is lint-banned outside `core/clock.ts` and CC-H4 wants deterministic `ts` (raised by TB-3) | integrator (Wave-B approved deviation) |
| 2026-07-29 | `ToolResult.error`: replaced the top-level `api_code` with `details?: Record<string, unknown>` carrying `details.api_code`, resolving a direct conflict with TOOLS.md § 2.1. TOOLS.md wins — it is the client-visible wire shape frozen under semver (raised by TB-3) | integrator (Wave-B spec reconciliation) |
| 2026-07-29 | `canonicalJson`: pinned the 20 edge cases (key-order collation, `undefined`/`null`/hole handling, non-finite and `-0` numbers, bigint/`Date`/exotic-object rejection, cycles, Unicode, depth, rejection types) as contract rather than owner's choice. No signature change; digests depend on all of it (raised by TB-5) | integrator (Wave-B clarification) |
| 2026-07-29 | `scriptFetch` returns `RecordingFetchStub` (a `FetchStub` plus `.calls`) — additive, since it is still a `FetchStub` everywhere one is taken. TESTING.md requires a *recording* stub and `withFetch` returns the callback's value, so the recording had nowhere else to live. Added `RecordedCall` and `ScriptFetchExhaustedError` (raised by TB-6) | integrator (Wave-B approved deviation) |
| 2026-07-29 | `mockClock` returns the named `MockClock`, adding `pending()` and `setNow()` — additive. `pending()` is how a test asserts *nothing* is waiting; `setNow()` is the only seam that can step time backwards, which `core/clock.ts` documents as something deadline logic must tolerate and which `advance()` cannot express (raised by TB-6) | integrator (Wave-B approved deviation) |
| 2026-07-29 | Documented the frozen `BASELINE_*` constants, `TEST_LOG_ID`, the import-time `TT_` sanitizer and its `TIKTOK_MCP_TEST_INHERIT_ENV=1` opt-out, and added the § Extended harness block (`rng`, `deferred`, `upload-simulator`, `token-stub`, `multi-process`) as shared contract (raised by TB-6) | integrator (Wave-B sanctioned edit) |
| 2026-07-30 | `core/config`: defined `EnvFileSnapshot` and `EnvLine` (referenced throughout but never declared), plus the surface the CLI and OAuth already needed — `CONFIG_SCHEMA_VERSION`, `envKeyFor`, `normalizeProfileName`, `listProfiles`, `PersistOptions`. Recorded the nine error codes as contract, since callers branch on them (raised by TB-7) | integrator (Wave-B sanctioned edit) |
| 2026-07-30 | `core/config`: additive optional params on three frozen signatures — `resolveEnvFilePath(env?, platform?)`, `readProfile(name, snapshot, env?)`, `persistProfilePatch(path, profile, patch, opts?)`. Every previously frozen call form still compiles. `platform` and `env` are the only way to test OS-specific resolution and the CC-F2 overlay on a single CI leg; `opts` is where the `rename` seam for the CC-H3 ladder lives (raised by TB-7) | integrator (Wave-B approved deviation) |
| 2026-07-30 | `core/config`: CC-H3 extended to the *read* half of read–merge–write. `persistProfilePatch` degraded only on a failed write, so an unreadable path (ENOTDIR/EACCES) threw and failed the tool call it was supposed to survive. A document that cannot be read must also not be overwritten. Startup callers still go through `readEnvFile` and still get the hard error (raised by TB-7) | integrator (Wave-B approved deviation) |
| 2026-07-30 | `core/env-lock`: `EnvLockOptions` gained `logger?: Logger` and `random?: () => number` — additive, so every frozen call form still compiles. The contract *requires* a warning when a stale lock is broken, and a `core` module may not reach for a global sink; `random` is the seam that makes the 50–150 ms contention jitter deterministic (TESTING.md determinism rule 4). Exported `envLockDir(envFilePath)` so `doctor` can report a stale lock without duplicating the `<envfile>.lock` naming rule (raised by TB-8) | integrator (Wave-B approved deviation) |
| 2026-07-30 | `core/env-lock`: recorded two behaviours the prose left open — an unusable duration option (`NaN`, negative, below the floor) falls back to the documented default with an `invalid_env_lock_duration` warning instead of throwing (CC-H3: lock trouble never costs a valid token), and one call may reclaim at most 3 stale locks before it waits like everyone else, which bounds a break-and-retry spin against a pathological `staleMs` with a live competitor. Error codes `env_file_busy`, `env_lock_unusable` and the `env_lock_heartbeat_too_slow` warning are contract — callers and `doctor` branch on them (raised by TB-8) | integrator (Wave-B sanctioned edit) |
| 2026-07-30 | `core/http`: `TtRequestOptions` gained `maxAttempts?`, `budgetMs?`, `logger?` and `random?`, and `PutChunkOptions` gained `clock?`, `lookup?`, `chunkRetries?`, `budgetMs?`, `logger?`, `random?` and `contentLength?` — all additive, so every frozen call form still compiles. The retry ladder is contract (CC-B3/B7) but was untestable without a deterministic jitter seam and a bounded attempt count (TESTING.md determinism rule 4); `budgetMs` is what `Retry-After` is capped against; a `core` module may not reach for a global sink; `contentLength` is mandated by TIKTOK-API § 4.6 and cannot be derived from a stream. `putChunk`'s inline options object was named `PutChunkOptions` and `Omit<TtRequestOptions,"retryClass">` was named `OauthRequestOptions` — same types, now referenceable (raised by TB-9) | integrator (Wave-B approved deviation) |
| 2026-07-30 | `core/http`: recorded as contract what the prose left open — the failure codes callers branch on (`egress_blocked`, `network_ambiguous`, `network_error`, `timeout`, `rate_limited`, `upstream_error`, `invalid_params`), and that a non-replayable (stream) body forces a single chunk attempt, since re-sending an already-consumed stream would put a truncated range on the wire under a `Content-Range` that promises the full one (raised by TB-9) | integrator (Wave-B sanctioned edit) |
| 2026-07-30 | `core/http`: a transport failure, a blocked DNS answer and a per-attempt timeout now reach the retry ladder as outcomes instead of unwinding past it. They were thrown from inside the attempt callback, so `read` and `chunk` never retried them despite carrying `retryable: true` — CC-B3 and CC-B7 were unimplemented for exactly the failures they exist for. A caller abort still unwinds verbatim; `init` is unchanged and stays terminal (CC-B4/B5) (raised by TB-9) | integrator (Wave-B approved deviation) |
| 2026-07-30 | `mcp/define`: recorded `AnyToolSpec`, `toolInput`, `accountArg`, `ACCOUNT_DESCRIPTION` and the `defineTool` rejection list; `src/tools/index.ts` gained the declared `ToolPackageSpec` / `PACKAGES` / `allTools` surface it was already described in prose. Additive — every frozen call form still compiles (raised by TC-4) | integrator (Wave-C sanctioned edit) |
| 2026-07-30 | `mcp/result`: `toToolContent` gained an optional third parameter (`TruncateOptions`, i.e. `TT_PRETTY_JSON`), and the module's real surface was recorded — `truncateResult` (the envelope *and* the mirroring text, so `structuredContent` and the text block cannot drift), `TruncationInfo`, `TruncatedResult`, `HINT_TYPES`, `RESULT_JSON_SCHEMA`, `ToolError`. The frozen `toToolContent(result, budget)` form still compiles (raised by TC-4) | integrator (Wave-C approved deviation) |
| 2026-07-30 | Added § `mcp/errors.ts` and § `mcp/server.ts` — new modules, no contract changed. `mcp/server` installs its handlers on the **low-level `Server`** instead of `McpServer.registerTool`, because the SDK's private validator renders a schema failure as an `McpError` without `structuredContent`, which contradicts TOOLS.md §§ 2.1/2.3/3.0 (`invalid_params` is a normal `ok: false` envelope). That adds a fourth runtime dependency, `zod-to-json-schema`, for schema advertisement (raised by TC-4) | integrator (Wave-C sanctioned edit) |
| 2026-07-30 | `core/settings`: added `settingVarName` and `knownSettingVars` (consumed by `doctor` and by the CONFIGURATION.md drift test) and documented that a secret is reported as `<redacted>`. `TT_HTTP_TOKEN` gained a shape — ≥16 chars of printable ASCII, no spaces: it was `z.string()`, which accepts everything, so the `<redacted>` branch was unreachable and a 1-char token failed at the first request instead of at startup. `docs/CONFIGURATION.md` updated in the same change (raised by TB-7) | integrator (Wave-B approved deviation) |
| 2026-07-30 | `core/oauth`: recorded the real surface — `CallSeams` (`logger`, `signal`, `timeoutMs`, `lookup`, `settings` next to the frozen `clock`), `BuildAuthUrlOptions.randomBytes`, `RefreshDeps` (`force`, `env`, `rename`), `RevokeDeps`, the second parameter on `revokeToken`, and `resetTokenCache`. All additive: every frozen call form still compiles. `randomBytes` and `rename` are the only seams that make a reproducible authorize URL and the CC-H3 degradation testable; `settings` carries the loopback `TT_OAUTH_BASE_URL` override the cross-process tests point at their stub (raised by TC-1) | integrator (Wave-C approved deviation) |
| 2026-07-30 | `core/oauth`: `force` now means "do not adopt the token this process already holds". A forced refresh is the 401 replay, so returning the same token the re-read under the lock found — which is what the file holds whenever no sibling has rotated — replayed exactly the token TikTok had just rejected. A *different* token on disk is still adopted for free, and a forced refresh that finds only its own gets the retryable `env_file_busy` instead. Also documented the per-process spent-token memo (CC-F2) and that `revokeToken` clears it (raised by TC-1) | integrator (Wave-C approved deviation) |
| 2026-07-31 | `cli/*`: added § `cli/index.ts` — `runCli`/`CliDeps`/`CliIo`/`ListenFn`, the 0/1/2 exit codes, `overlayEnvFile`, and the `runLogin`/`runDoctor` entry points. The layer had no contract at all; TC-3 compiles against this one without touching TC-2's files. Includes the `CliIo.errRaw` single-call-site redaction hole (raised by TC-2) | integrator (Wave-C approved deviation) |
| 2026-07-31 | `core/settings`: added `resolveEnabledPackages(settings)`, moved verbatim out of `mcp/server` (which now re-exports it under its contracted name — no consumer moves). `login` derives its least-privilege scope set from the same reduction and must reach it without loading the MCP SDK; two copies would be two things that have to stay equal (raised by TC-2) | integrator (Wave-C approved deviation) |
| 2026-08-02 | `api/*`: recorded the real read surface. `ApiContext.getAccessToken` gained `opts?: AccessTokenOptions` (`force`), `getUserInfo` and `queryVideos` gained a trailing `opts?`, and `ListVideosOptions` gained `fields`/`signal` — all additive, so every frozen call form still compiles. `force` exists because the 401 replay must not re-send the token TikTok just rejected; `signal` is how a cancelled tool call stops at the transport; `fields` is what lets the tool layer drop ungrantable fields before the request (CC-A7) instead of eating a scope error. Declared what was already exported but unrecorded: `createApiContext`/`CreateApiContextOptions`, `apiRequest`/`ApiRequestOptions`, `malformedPayload`, `readCredentialSnapshot`/`ProfileCredentialSummary`, `grantedScopes`, `maskOpenId`, and the frozen field/limit constants (`USER_FIELDS`, `USER_FIELD_SCOPES`, `VIDEO_FIELDS`, `DEFAULT_VIDEO_FIELDS`, `MIN_PAGE_SIZE`, `MAX_PAGE_SIZE`, `MAX_QUERY_IDS`) (raised by TC-5) | integrator (Wave-C approved deviation) |
| 2026-08-02 | `api/context`: recorded that ARCHITECTURE § 6's 401-refresh-and-replay is implemented in `apiRequest`, not in `core/http` or `core/oauth`. Neither of those can own it — `core/http` never sees a credential and `core/oauth` never sees a Display response — so the rule was documented in two places that could not enforce it. No signature change (raised by TC-5) | integrator (Wave-C clarification) |
| 2026-08-02 | `cli/index.ts`: `CliDeps` gained `platform?: NodeJS.Platform` — additive. CC-F3 has two halves (the POSIX `chmod` fix offer and the Windows `icacls` remediation *text*, which is printed and never executed); without the seam each half is reachable on one CI leg only, and a branch only one leg can reach is a branch only one leg tests. `core/config`'s `resolveEnvFilePath` already took the same seam (raised by TC-3) | integrator (Wave-C approved deviation) |
| 2026-08-02 | Added § `cli/doctor.ts` — `Severity`, `Finding`, `DoctorContext`, `Check`, `DOCTOR_CHECKS`, `parseDoctorArgs`, `renderFinding`, `renderSummary`. New module, no contract changed. The cross-task surface is the *check registry*: TASK-BREAKDOWN gives TC-3 the ordered list and lets a later task contribute a check by registering one, which only works if the `Check` shape, the report-don't-abort rule and the `fail`-only exit code are frozen (raised by TC-3) | integrator (Wave-C sanctioned edit) |
| 2026-08-02 | `core/config`: recorded that `settings.envFile` and `resolveEnvFilePath(env)` are the same expression (`resolve(expandTilde(TT_ENV_FILE))`) and therefore the same answer, so `api/context` holding a `Settings` and `core/oauth` not holding one is not drift. The invariant they both rest on — a caller builds `Settings` from the same env it passes down — is now written where either "fix" would be attempted. No signature change (raised by TC-5) | integrator (Wave-C clarification) |
| 2026-08-07 | `mcp/plan-store`: `storePlan` and `consumePlan` gained a trailing `options?: PlanStoreOptions` (`{ limits?: PlanLimits }`) — additive, so both frozen call forms still compile. The contract named `settings.planTtlS` / `settings.planMaxOutstanding` as governing TTL and cap but gave the functions no way to receive them, which left the store either reading `process.env` (it is a data structure, not a settings consumer) or hard-coding the defaults. Also recorded `PLAN_ID_PATTERN`, `DEFAULT_PLAN_TTL_S`, `DEFAULT_PLAN_MAX_OUTSTANDING`, `outstandingPlans`, `resetPlanStore`, the check order, and that the applicable window is half-open (raised by TD-2) | integrator (Wave-D approved deviation) |
| 2026-08-07 | Added § `mcp/plan.ts` — new module, no contract changed. It is where the digest rules, the `TT_WRITE_MODE` step resolution, the local publish bucket and the four normative catalog texts live, so that the one expression the apply step's security rests on (`sha256Hex(canonicalJson(resolved payload))`) exists once. `consumePlan`'s expiry boundary and `planExpiresAt`'s rendered instant are the same instant by construction (raised by TD-2) | integrator (Wave-D sanctioned edit) |
| 2026-08-07 | `api/context`: `ApiRequestOptions.fields` became optional and `retryClass?: RetryClass` was added; the 401-refresh-and-replay is now gated to the `read` class. Additive — every frozen call form still compiles. A publish endpoint takes no `fields` at all, and a request the contract said must always carry them would have sent `?fields=`, which TIKTOK-API.md § 3.1 calls malformed. `retryClass` is how a publish init opts out of the retry ladder (CC-B4/B5): a retried init can duplicate a post. The replay is gated for the same reason — an init that failed *after* spending a publish attempt must not be re-sent, even for a token TikTok rejected (raised by TD-1) | integrator (Wave-D approved deviation) |
| 2026-08-07 | `api/publish`: recorded the implemented surface. `getCreatorInfo` and `getPublishStatus` gained a trailing `opts?: { signal?: AbortSignal }` (additive, both frozen call forms still compile) and the three inits now return the named `PublishInitResult`. Declared what the frozen block left to the implementation but two later tasks must agree on: the pure resolvers `resolveVideoPostInfo` / `resolvePhotoPostInfo` returning `{ postInfo, derived }`, `validatePhotoSource`, `auditRestrictionsActive`, `isTerminalStatus`, and the `PRIVACY_LEVELS` / title-cap / photo-bound constants. Resolution is pure and separate from the network because the preview digests the resolved payload and the apply step must reproduce it byte for byte (`mcp/plan`); a resolver that could reach the network could not be re-run at apply time. `derived` carries env defaults and creator-forced values only — padding it with schema defaults buries the entries a human approver actually needs to read. The `fail_reason` → recovery prose of CC-E5 is deliberately absent: it belongs to the tool layer (raised by TD-1) | integrator (Wave-D sanctioned edit) |
| 2026-08-02 | `mcp/result`: `TruncationInfo.reason` widened to `"char_budget" \| "item_cap" \| "cursor_stuck"`. A `fetch_all` walk stops for two unrelated reasons and both were stamped `item_cap`, so the one machine-readable field said "resume for more" in the CC-C3 case where resuming returns the same page forever. The distinction was already in the prose hint and in the *absence* of `resume_cursor`; a caller had to infer it from a missing field. `docs/TOOLS.md` § 2.4 updated in the same change (raised by TC-5) | integrator (Wave-C approved deviation) |
| 2026-08-07 | `src/tools/index.ts`: added `describeAllTools(packages?)` and `ManifestEntry` — additive, `PACKAGES` and `allTools` are untouched. The generated artifacts (manifest snapshot, README table, later `server.json`) need the *described* tool, not the spec, and describing it required a profile; reading the ambient one would have made the snapshot a property of the machine that ran the generator. It therefore describes against a synthetic profile holding every declared scope, which is also why a generated description can never carry an `[UNAVAILABLE …]` marker (raised by TC-6) | integrator (Wave-C sanctioned edit) |
| 2026-08-07 | `cli/login.ts`: `PACKAGE_SCOPES` and `SCOPE_ORDER` became exports — additive, values unchanged. The scope column of TOOLS.md § 2 is asserted in two directions by `test/manifest.test.ts` (every scope a registered tool declares is requested by its package; every requested scope is one this server knows), and a gate that cannot read the table can only re-implement it. Deliberately *not* an equality gate: `user` requests the profile and stats scopes although `tiktok_get_user_info` declares only `user.info.basic`, because those gate optional fields and narrowing them would cost a re-login (raised by TC-6) | integrator (Wave-C sanctioned edit) |
| 2026-08-07 | `core/log.ts`: added `silentLogger`, the fallback behind every optional `logger?` in `core/*`. It was a private constant in `core/http.ts`, unreachable from any test and therefore an untestable default in the module the coverage floors treat as security-relevant; a level filter cannot replace it, since `createLogger({level:"error"})` still writes. Additive — no signature changed and `core/http` is the only current caller (raised by TC-6) | integrator (Wave-C sanctioned edit) |
| 2026-08-09 | Added § `tools/publish-write.ts` — new module, no contract changed. `PostVideoPreview`, `PostVideoApplied`, `PostVideoData` and the `postVideoTool` spec are frozen because the preview/apply envelope is cross-task surface: TD-6's draft and photo tools answer in the same two modes, and `doctor`'s journal reconciliation reads the same `journal: "recorded" \| "unavailable"` field. The § 2.6.3 step order is recorded with them — `verifyPlan` at step 5, the duplicate guard at 6, `consumePlan` at 7 — because the guarantee a refused duplicate rests on lives in that order rather than in any one signature. `PACKAGES` gains its first `publish-write` entry, which is an addition, not a change (raised by TD-4) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `mcp/plan-store`: added `verifyPlan(id, expect, clock, options?)` — everything `consumePlan` checks, *without* marking the plan used. Additive, and `consumePlan` is now its only caller, so the check order and the two codes callers see are unchanged. The execute pipeline verifies at step 5 but consumes at step 7 with the duplicate guard in between (TOOLS.md § 2.6.3); a `possible_duplicate` refusal has to leave the same `plan_id` appliable with `force: true`, which it cannot if verification spends it. A caller that verified still honours `consumePlan`'s verdict — a concurrent apply can win in the window the guard's file read opens. `PlanExpectation` and `ConsumeResult` name the shapes the two functions share (raised by TD-4) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `tools/publish.ts`: `journalOptions(ctx)` and `auditRestrictionsNote()` became exports — additive, values unchanged. Both are shared by the read and the write half of the publish package: the journal wiring (env file, `journalMaxBytes`, the call-bound logger) must be identical for the tool that appends an intent and the tool that lists it, and the SELF_ONLY warning is one normative text, not two. A copy in `publish-write.ts` would be a second thing that has to stay equal (raised by TD-4) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `mcp/define`: `ToolSpec` gained `scopesAnyOf?: readonly string[]`, checked *in addition to* `scopes`, which stays an AND — additive, every existing spec still compiles. TikTok grants `video.publish` and `video.upload` separately but answers `/publish/status/fetch/` for either, so `tiktok_get_publish_status` declares `scopes: []` plus the alternation instead of claiming to need both, which would mark it `[UNAVAILABLE]` on a draft-only installation (TOOLS.md § 3.6). `defineTool` rejects fewer than two alternatives (one alternative is an AND and belongs in `scopes`), duplicates, empty entries, and an overlap with `scopes` that would make the alternation vacuous; `unavailableMarker` and the call-time scope check require any one member and name the first as the remediation, so the suggested `login --scopes` line is always satisfiable; `ManifestEntry` carries it through to the generated artifacts (raised by TD-4) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `mcp/journal`: `checkDuplicate`'s return became the named `DuplicateCheck`, which gained `matched?: JournalAttempt` beside `matchedAttemptId` — additive, so the frozen return shape still destructures. The `possible_duplicate` refusal (TOOLS.md § 3.0) must name the profile, the timestamp, the outcome and the `publish_id` of the attempt it blocks on, none of which can be recovered from an attempt id without re-reading the file the guard has just read (raised by TD-4) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `mcp/journal`: added `JournalOptions` and a trailing `opts?: JournalOptions` on `appendIntent`, `appendOutcome` and `checkDuplicate`, with `readMerged` taking it intersected with its own `limit?` — additive, so every frozen call form still compiles. Same precedent as `PlanStoreOptions` in `mcp/plan-store`: the contract names the resolved env file, `settings.journalMaxBytes` and the package version as governing this module but gave the functions no way to receive them, which left them reading `process.env` themselves — a module the write path depends on deciding where it writes from ambient state (raised by TD-3) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `mcp/journal`: an absent journal file is not an error. A generation that does not exist (`ENOENT`) reads as "no records", so `journal_unreadable` is raised only for a file that exists and cannot be read — a fresh install answers the journal tool and the duplicate guard normally instead of failing every publish path until the first append. `journalExists()` is how a caller tells "empty" from "never used" for the two different empty-state messages. No signature change (raised by TD-3) | integrator (Wave-D clarification) |
| 2026-08-09 | `mcp/errors`: added `publishToolError(error)` — `toolErrorFrom` plus five remaps that only `/post/publish/*` can produce (`spam_risk_too_many_posts` → `daily_post_cap`, `reached_active_user_cap` → `active_user_cap`, `spam_risk_too_many_pending_share` → `pending_share_cap`, `url_ownership_unverified` → `url_prefix_unverified`, `invalid_publish_id` → `publish_not_found`). Additive: every non-publish tool keeps the plain mapping, and `log_id` / `details.api_code` survive the remap, so nothing upstream is lost by presenting the catalog code. Mapping these inside `toolErrorFrom` would have let an unrelated endpoint that happens to reuse a code inherit a publish-specific remediation (raised by TD-3) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | Signature blocks brought in line with the code they describe — no behaviour changed, nothing new decided. `ToolSpec.scopesAnyOf` and `ManifestEntry.scopesAnyOf`, `mcp/plan-store`'s `PlanExpectation` / `ConsumeResult` / `verifyPlan`, `mcp/journal`'s `JournalOptions` / `DuplicateCheck` / `JournalAttempt` / `resolveJournalPath` and the `opts?` parameters, and `mcp/errors`' `publishToolError` were all already ratified in the rows above but were still missing from the frozen listings. The blocks are what a later wave reads first, so a listing that omits a ratified member reads as a contract violation the next time someone uses it (raised by TD-4) | integrator (Wave-D clarification) |
| 2026-08-09 | `api/upload`: the 4 GiB cap is enforced by `planChunks`, not "by the caller" as this block said. TIKTOK-API.md § 4.6's normative pseudocode puts `if video_size > MAX_FILE: reject VALIDATION_ERROR` inside `plan()` and TESTING.md pins 4,294,967,297 as a `planChunks` boundary case, so the doc-comment was the only text that disagreed — and the one a caller reads first. The tool layer still checks before it plans, because that is where the real byte count is in hand for `file_too_large`'s normative text; nothing moved, a second gate was added under the first (raised by TD-5) | integrator (Wave-D spec reconciliation) |
| 2026-08-09 | `api/upload`: `planChunks` gained an optional `chunkSizeOverride` — additive, so the frozen call form still compiles and the production call site passes one argument. Vector V3 (50,000,123 bytes → `chunk_size` 10,000,000, five chunks) is TikTok's own worked example and is unreachable from `chunk_size = min(size, 64_000_000)`, which yields one chunk at that size; TESTING.md nevertheless requires V1–V8 asserted byte-exactly *against `planChunks`*, so without the parameter one of the eight canonical vectors could only be checked against a re-implementation of the planner. The override is validated like any other chunk size (bounds, 1–1000 count) (raised by TD-5) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `api/upload`: `uploadFile` owns the per-chunk retry loop, and gained `contentType?` and `random?` — additive. `core/http`'s `putChunk` disables its in-call retries for a `ReadableStream` body it cannot replay and defers to the caller re-reading the byte range, so the `1 + TT_CHUNK_RETRIES` ladder CC-B7/CC-D6 require had no owner. `uploadFile` streams each chunk with `fs.createReadStream(path, { start, end })`, passes `chunkRetries: 0`, and opens a fresh stream per attempt under a byte-identical `Content-Range`; buffering the range instead would satisfy the same contract but put a 128 MB final chunk in RSS. `contentType` overrides an extension→MIME map no document prescribes, falling back to `video/mp4` — TikTok validates the container by content (CC-D9) and reports a mismatch asynchronously as `fail_reason: file_format_check_failed`, so refusing locally would invent a catalog code § 3.0 does not have (raised by TD-5) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `api/upload`: added `resolveMediaFile`, `verifyMediaFile`, the `MediaFile` shape and the five byte constants (`MIN_WHOLE_BYTES`, `CHUNK_SIZE_BYTES`, `MAX_FILE_BYTES`, `MAX_CHUNK_COUNT`, `MAX_FINAL_CHUNK_BYTES`) — new exports beyond the frozen block, no contract changed. The CC-D8 containment check (realpath on both sides, a relative path resolved against `TT_MEDIA_ROOT` and never CWD) and the CC-D3/CC-D4 apply-time re-stat (size, mtimeMs, dev, ino) were mandated but homeless; `api/upload.ts` is where the file-system knowledge already lives, and in the tool layer both would exist twice, once in `tiktok_post_video` and once in `tiktok_upload_video_draft` (raised by TD-5) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `docs/TOOLS.md` § 3.0: added the write-tool code `file_empty` (not retryable) immediately after `file_not_found`. CC-D1 mandates that a zero-byte file be rejected locally at plan time, and no existing code's normative text is true for one — `file_not_found` says the path "does not exist or is not a regular file", which an empty file is. `resolveMediaFile` raises it; no signature changed (raised by TD-5) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | Added § `tools/publish-common.ts` — new module, no contract changed. `AccountBlock`, `CreatorBlock`, `ChunkSummary`, `SourceBlock`, `AppliedData`, `WritePreview`, `DraftPreview`, `ChunkPosition`, `DispatchOptions`, the write-only catalog constructors, the § 5 hints, `takeWriteToken`/`mintPlan`/`runPlanGuards`, `dispatchWrite` and `waitIfAsked`. The four write tools differ only in the payload they resolve and the endpoint they hit; the § 2.6.3 ordering, the journal records and the failure classification are one contract stated four times, and four copies would be four places for the guarantee a refused duplicate rests on to drift. `report` inside `DispatchOptions.send` is the whole classification — before it a failure is `network_unsent`/`network_ambiguous`, after it the attempt exists upstream and the outcome is `upload_failed`, never `error` (CC-B4) (raised by TD-6) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `tools/publish-write.ts`: `source: "file"` ships. The block said `"url"` only and pointed at "the draft tools" for the chunked upload; both video tools now take `file_path` under `TT_MEDIA_ROOT`, plan chunks at preview time and re-stat immediately before the first PUT (CC-D3/CC-D4). `PostVideoPreview` / `PostVideoApplied` are folded into `WritePreview` / `AppliedData` in `tools/publish-common.ts` — same members, one definition, because the three other write tools answer in them too; `PostVideoData` is unchanged as a name and as a shape. Added `UploadDraftData` and `uploadVideoDraftTool` (scopes `["video.upload"]`, so a draft-only authorization works and no `creator_info` pre-flight runs). `WritePreview.payload.source` widened from `{ type: "url"; url }` to the three-armed `SourceBlock`, and `AccountBlock.nickname` became optional — it comes from `creator_info`, which the draft tools never call (raised by TD-6) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `tools/publish-write.ts` / `tools/publish-photos.ts`: the `source` union is a **flat strict object**, not a `z.discriminatedUnion` — `source` enum plus optional `file_path` plus optional `video_url`, with the mutual exclusion checked imperatively in the handler. TOOLS.md § 3.8 said "discriminated on `source`" and the contract is unchanged, but a discriminated union produces a JSON Schema with no top-level object shape, which `mcp/define`'s import-time strictness probe and every manifest reader depend on. `plan_id` is checked against `PLAN_ID_PATTERN` in the handler for the same reason: a `.refine()` makes the schema a `ZodEffects` and costs the same shape. TOOLS.md §§ 3.8/3.9 updated in the same change to describe what ships (raised by TD-6) | integrator (Wave-D approved deviation) |
| 2026-08-09 | Added § `tools/publish-photos.ts` — new module, no contract changed. `PostPhotosData`, `UploadPhotosDraftData`, `postPhotosTool` (`video.publish`), `uploadPhotosDraftTool` (`video.upload`); `PACKAGES`' `publish-write` entry is now the four tools of TOOLS.md § 2, in § 3.8–3.11 order. Both carousel rules are enforced in the handler **before any network call**, on the preview and again on the apply: an out-of-range `photo_cover_index` (zod bounds the array, nothing in a flat schema bounds an index against it) and every `photo_urls[i]`, reported one at a time by index and without the `source: "file"` sentence, which would point at a branch the photo endpoints do not have. The photo draft carries a `post_info` where the video draft carries none (raised by TD-6) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `api/publish`: added `resolvePhotoDraftPostInfo({ title?, description? })` — the photo draft `post_info`, `derived: []`, no `CreatorInfo`. Not `resolvePhotoPostInfo` with optional arguments: a draft carries no privacy level and no toggles and must not grow defaults. It lives in `api/` anyway because it shares `PHOTO_TITLE_MAX` / `PHOTO_DESCRIPTION_MAX`, and a second copy of those limits is a second place for them to drift. Additive — no existing signature changed (raised by TD-6) | integrator (Wave-D sanctioned edit) |
| 2026-08-09 | `api/publish`: a `FILE_UPLOAD` init whose payload carries no `upload_url` now throws `malformedPayload(<init endpoint>, "upload_url string for a FILE_UPLOAD init")` instead of returning a `PublishInitResult` with the field absent. `uploadUrl` was optional for the honest reason that `PULL_FROM_URL` has none, which made the one case that cannot proceed without it indistinguishable from the one that never wants it — and the tool layer would only discover the hole after the publish attempt was already spent. `PULL_FROM_URL` is unchecked and unchanged (raised by TD-6) | integrator (Wave-D approved deviation) |
| 2026-08-09 | `docs/TOOLS.md` § 3.9: the draft `user_action` hint says "**Unopened** drafts expire", not "Unfinished". § 5.3's rendering and the tool description both already said "unopened", and the claim matters: TikTok expires a draft the user never opened, not one they opened and left unfinished, so the wrong word tells a user their in-progress edit is on a timer. § 5.3 is the normative rendering and two of the three sites already agreed. `docs/TIKTOK-API.md`'s scope table updated in the same change — `video.upload` listed `tiktok_post_photos` (MEDIA_UPLOAD), a tool that does not exist, where `tiktok_upload_photos_draft` does (raised by TD-6) | integrator (Wave-D spec reconciliation) |
| 2026-08-09 | Added § `mcp/lifecycle.ts` — new module, no contract changed; the preamble's note that it is deliberately absent now points at the § the task wrote. It exports a watcher and a plain `onChange`, not a `Server` call: the notification is the composition root's to send, and `mcp/lifecycle` importing `mcp/server` to send it would make an untestable module out of a decision that is one line at the call site. The signal is the *derived* `profileSignature`, never file activity — a token refresh rewrites the env file on its own schedule and firing `tools/list_changed` on every refresh would be a bug, not a feature. Polling through the injected `Clock` is the floor rather than an `fs.watch` optimisation: `persistProfilePatch` writes by rename-replacement (which `fs.watch` reports inconsistently), network homes do not deliver events at all, and a watch no `mockClock` can drive cannot be tested to CC-H4. The interval doubles as § 6.3's debounce, so it is floored at 500 ms and an unusable value warns and falls back like `core/env-lock`'s duration (raised by TE-6) | integrator (Wave-E sanctioned edit) |
| 2026-08-13 | Added § `mcp/http.ts` — new module, no contract changed. `TT_TRANSPORT=http` was documented as shipped (README § env table, CONFIGURATION.md § transport, SECURITY.md § Transport) while `src/index.ts` refused to start, so the § records the surface that closes the gap: `startHttpTransport`/`HttpTransportOptions`/`HttpTransportHandle`, `MCP_PATH`, and the exported `dnsRebindingRejection`/`OriginPolicy`. The refusal predicate is exported because the off-box branch of the `Host`/`Origin` policy is otherwise reachable only by binding off-box, which a test suite may not do. The check order (403 → 401 → 404 → 405), the byte-identical 401 for a missing and a wrong credential, and one `McpServerHandle` per session are contract rather than implementation: the first is what stops an unauthenticated caller from mapping the surface, the second is what stops it probing, and the third is what keeps two clients' initialization state apart (raised by TE-7) | integrator (Wave-E sanctioned edit) |
| 2026-08-13 | `mcp/plan`: `peekPublishBucket`, `takePublishToken` and `localRateLimitedError` gained a trailing `options?: RateBucketOptions` (`{ limits?: PublishRateLimits }`) — additive, so every frozen call form still compiles; `PUBLISH_BUCKET_CAPACITY` / `PUBLISH_BUCKET_REFILL_MS` are replaced by `DEFAULT_PUBLISH_RPM` plus `resolvePublishBucket(options)`, since the two numbers are derived from one setting and only ever meaningful together. Same precedent as `PlanStoreOptions`: CONFIGURATION.md advertises `TT_PUBLISH_RPM` and `core/settings` parses it, but the bucket had no way to receive it and hard-coded the default, so the setting silently did nothing. `capacity = rpm`, `refillMs = ceil(60_000 / rpm)` — whole milliseconds because `refill` banks the remainder *in* `updatedAt` (a fractional interval would drift over a session and put `retry_at` on instants `Date` truncates), rounded up so a non-divisor lands just under the configured rate rather than just over. The default 6 still resolves to capacity 6 / 10 000 ms, which a test asserts equals `loadSettings(baselineEnv()).publishRpm`. `refill` also clamps a bucket down to the current capacity, because the bucket map is process-wide while the rate arrives per call (raised by the TT_PUBLISH_RPM defect fix) | integrator (Wave-E approved deviation) |
| 2026-08-13 | § `cli/doctor.ts`: `parseDoctorArgs`'s flags gained `json: boolean`, and the module gained `DoctorReport`, `DoctorReportCheck` and `renderJsonReport` — plus `export` on `Tally`, which `renderSummary`'s frozen signature already named without declaring. All additive: every frozen call form still compiles and the human rendering is byte-identical. `--json` is what makes doctor a readiness gate for something other than a human, so a fourth rule now binds it: stdout carries exactly one document on every path that reaches it, including the path where the configuration could not be read, which reports the reason as a synthetic `configuration` check instead of pairing a non-zero exit with an empty stream. The document is snake_case (`exit_code`) to match the wire shape the tools already speak, and carries no timestamp or duration, so two runs of one configuration diff clean in CI. `--json` also implies non-interactive — the CC-F3 chmod offer would block a consumer with no way to answer it (raised by SYN-26) | integrator (round-2 finding) |
| 2026-08-13 | § `cli/doctor.ts` and § `cli/index.ts`: `DoctorContext` gained `readonly modulePath: string` and `CliDeps` an optional `modulePath?: string` (additive), carrying a 14th check — `install` — at the end of the runtime-surface group. It warns when the CLI is running out of the npx cache, because npx re-runs its own cached copy and `npm cache clean` does not touch it, so an operator can chase a bug the published version fixed weeks ago; the remediation spells out the cache-clear command for `ctx.platform` verbatim (`rm -rf ~/.npm/_npx`, `rd /s /q "%LOCALAPPDATA%\npm-cache\_npx"`) since neither path is derivable from the other. `modulePath` is a seam for rule 3's reason — `import.meta.url` is not overridable, so both branches would otherwise be reachable only from a real `npx` run on the matching platform. The match is on a path *segment*, so a project directory named `my_npx_tools` is not the cache, and a non-npx install answers `ok` rather than silently: "where is this running from" is the first thing a stale-install bug report has to establish (raised by SYN-38) | integrator (round-2 finding) |
| 2026-08-22 | Added § Extended harness `fixtures.ts` and recorded two deviations from TESTING.md's original fixture sketch, both in `scripts/lib/fixtures.ts`. **`response.headers` is part of the on-disk format**, which the sketch (status + body) did not call for: the chunked-upload path answers with a bare status, a `Content-Range` and no body at all, so a body-only fixture cannot express the one interaction most worth recording, and `Retry-After` is the same story on the retry path. **Replay goes through `globalThis.fetch`, not "the `api/` parsers"** — no standalone parser is exported and `core/http` reads the global at call time, so driving the api function against a scripted stub is the only seam; it is also what makes the request half of the contract free, which the sketch wanted as a separate mechanism. Two areas are exempt from replay by name with a reason (`auth`: form-encoded and outside the `{data,error}` envelope; `upload`: a pre-signed PUT on another origin) and still recorded, sanitized and secret-scanned — an unrouted endpoint inside a replayable area remains a loud failure, since a recorded interaction nobody replays looks exactly like a verified one (raised by the recorded-fixtures spine) | integrator (approved deviation) |
| 2026-08-22 | `core/redact`: `SENSITIVE_PARAM_RE`'s prefix class gained `"` and `'`. It required `?`, `&`, whitespace or `;` before the parameter name, so in the position a form body actually reaches a log line — quoted, as a JSON string or interpolated into a message — the *first* parameter was the one place the rule could not see, and a serialized OAuth body puts `client_key` and `code` exactly there. No signature change; the replacement still preserves the prefix, so `"access_token=…` stays well-formed. Found by the fixtures leak detector, which had the same gap and the same fix (raised by the recorded-fixtures spine) | integrator (defect fix) |
| 2026-08-31 | `mcp/result`: `wait_for_audit` removed from the `user_action` action vocabulary, which is now the runtime-enumerable `USER_ACTIONS` with `UserAction` derived from it (`Hint.action?: UserAction`, same five remaining members — every emitter and every existing call form still compiles). No code path ever emitted the member and none was meant to: the case it named is an unaudited app, and TOOLS.md § 4 (flow 2) already says that preview shows `privacy_level_options: ["SELF_ONLY"]`, `audit_restrictions_active: true` **and a `note` hint**, while § 5.1's `note` row lists "unaudited explanation" among what a note carries. `auditRestrictionsNote()` is therefore right as it stands, and retyping it to `user_action` would have been wrong twice over: it rides *alongside* the `approval_required` hint of a preview and next to a successful post, so a `user_action` there would tell a model to halt a flow that should continue, and passing TikTok's audit is a developer process of weeks rather than the next step in the call at hand. The package has never been published, so no client held the union. § 5.1's `user_action` row is reworded in the same change to state what separates the two types, and `test/result.test.ts` now walks `USER_ACTIONS` and fails on a member no `src/` path emits — the check whose absence let this survive. It exempts two members by name, `move_file` and `host_media`, which are the same shape of gap and are left as they are: unwired, but their cases are live in the § 3.0 catalog (`file_outside_media_root`, `url_prefix_unverified`), whose normative texts already say "move the file there" and "host the media under a verified prefix", so wiring or dropping them is a separate decision with its own evidence | integrator (defect fix) |
| 2026-09-01 | `tools/publish-common`: `move_file` and `host_media` are **wired**, not dropped — the two members the row above left exempt. New exports `moveFileHint(toolName)`, `hostMediaHint(toolName)`, `userActionHint(error, toolName)` and `localRefusal(error, toolName)`; no existing signature changed, `USER_ACTIONS` is unchanged in all three copies, and `test/result.test.ts` now walks it with an **empty** exemption map. Two adjacent rows reach opposite outcomes because § 5.1's test — "a step only the human/operator can take *next*, before this call can proceed" — is asked of the **flow the hint rides on**, not of how human the step sounds. `wait_for_audit` failed it: an unaudited app rides alongside a preview or a successful post, a flow that continues, and a `user_action` there tells a model to halt. These two pass it: `file_outside_media_root` and `url_prefix_unverified` are `retryable: false` refusals that end the call with nothing created, and neither moving a file nor re-hosting media is a branch the model can take for itself. That the catalog message already states the step is not an argument against the hint — § 5.2 rule 5 defines exactly that division of labour ("the error states cause + recovery, the hint operationalizes the recovery"), § 6 point 2 already mandates a `reauth`/`user_action` hint beside a `missing_scope` message that carries the whole recovery command, and the hint adds the machine-readable `action` a model branches on without parsing prose. The same test draws the boundary: the hint is attached at every tool-layer site where such a refusal becomes a result — the four `resolveSource` consumers and the two `checkSourceArgs` handlers in `tools/publish-write`, the two `checkCarousel` handlers in `tools/publish-photos`, and `dispatchWrite`'s **pre-init** branch, where an upstream `url_ownership_unverified` remaps to `url_prefix_unverified` — and deliberately **not** past an init, where the attempt exists upstream, the journal says `upload_failed` (CC-B4) and the next step is `tiktok_get_publish_status`, not a human. Layering forced the placement: `file_outside_media_root` is raised in `api/upload.ts`, which `import-x/no-restricted-paths` forbids from importing `Hint` at all, so the hint is keyed off the stable catalog code where the `ToolError` becomes a `ToolResult` — no error moved layers. Hint text names `TT_MEDIA_ROOT` and `TT_VERIFIED_URL_PREFIXES` but never the resolved path or the URL: § 5.2 rule 3 whitelists env-var names as server-owned template text and whitelists neither of those, which stay in `error.message`. TOOLS.md § 5.3 gains both renderings | integrator (contract decision) |
| 2026-09-01 | `core/settings`: `Settings.maxConcurrent` and the `TT_MAX_CONCURRENT` variable are **removed**. Breaking on the settings shape, observable to nobody: the field was parsed, defaulted to 4, type-checked and documented in four places (README env table, CONFIGURATION.md, `.env.example` via `scripts/gen-env-example.ts`, ARCHITECTURE.md § Transport item 4) as a "per-host concurrency semaphore" that was never built, and read by no line of `src/`. There is no `Promise.all`/`allSettled`/`race`/`any` anywhere in `src/api/` or `src/core/`, chunk PUTs run sequentially, and the only two in `src/` are shutdown paths (`index.ts`, `mcp/http.ts`) — so wiring the knob would have meant inventing a subsystem to justify a default, which is the wrong direction for a v1 contract. The knob goes; the truth stays. What actually bounds upstream pressure is the per-profile publish token bucket (`mcp/plan`, `TT_PUBLISH_RPM`), and ARCHITECTURE.md item 4 now says so — including the sentence a semaphore row let the document avoid: on the HTTP transport two sessions can have calls in flight at once, and v1 leaves that unbounded on purpose. `test/settings.test.ts` drops the field from the full-defaults object and substitutes `TT_PUBLISH_RPM` (also `decimalInt({ min: 1 })`, so `'0'` still fails) into the `cc-f6` aggregate, keeping four distinct invalid variables behind the `4 problems` assertion. | integrator (contract decision) |
| 2026-09-01 | Documentation brought in line with the parsers it describes, in the two places a reader would have been misled into a wrong call. (a) `TT_TOOL_PACKAGES` is **comma-separated**: `splitList` in `core/settings` splits on `,` and trims, so the "comma/space list" README stated in two places (env table and the packages section) promises a space-separated value that parses as one nonexistent package name and fails the whole config. CONFIGURATION.md already said "comma list"; README now agrees with it and with the code. (b) AUTH.md § Flow listed six default scopes including `video.upload`. The request is derived, not fixed: `PACKAGE_SCOPES` in `cli/login` unions the enabled packages' scopes in `SCOPE_ORDER`, and the default `TT_TOOL_PACKAGES=core` (`auth,user,video,publish`) yields **five** — `video.upload` arrives only with `publish-write`. `test/login.test.ts` has pinned the derived five since the scope selection landed, so the six-scope line was the only text in the repository that disagreed — and the one an operator reads before creating the app, which would have had them asking a sandbox for a scope its enabled packages cannot use. Both are wording fixes: no signature, no default and no code path changed. | integrator (contract decision) |
| 2026-09-02 | `mcp/result`: added `MAX_HINT_TOKEN_CHARS`, `hintToken`, `hintEnum` and `quotedHintToken`, and recorded `MAX_HINTS` / `MAX_HINT_CHARS`, which were exported but never declared here. Additive — no existing signature changed. TOOLS.md § 5.2 rule 3 forbade upstream interpolation absolutely while § 5.3's normative `poll` rendering inlines an upstream `publish_id`, and five hint constructors interpolated upstream-controlled values (`publish_id`, a deliberately unvalidated `status`, the whole `privacy_level_options` array) with nothing bounding their length: `MAX_HINT_CHARS` bound at exactly one runtime site, the pagination note, so the 300-character rule held only for fixtures that happened to be short. Rule 3 now states the two admissible classes and the condition on each — an opaque identifier that passes a shape check and is re-emitted as a structured field, and a member of a vocabulary this server owns *selected by* the upstream value — and these helpers are the single place both are enforced. `api/publish`'s "report an unrecognized status, never reject it" posture is untouched; the narrowing happens at the hint boundary. `docs/TOOLS.md` § 5.2 updated in the same change | integrator (post-0.7.0 defect fix) |
| 2026-09-02 | The § 5.2 rule 3 trust boundary is **extended past `hint.text`** to the two other channels a model reads as instruction: `error.message` and `data.fail_recovery`. No new admissible class, no new helper, no signature change — `tools/publish`'s `failRecovery`, and `tools/publish-common`'s `uploadInterruptedError` and `possibleDuplicateError`, now pass their upstream-originated values through `hintToken` exactly as a hint does. The defect was not that the rule was missing: § 3.0's Notes and `mcp/errors.ts`'s module docblock already claimed the boundary for `error.message`, and three tool-layer constructors quietly did not honour it — `failRecovery`'s *(unknown value)* branch quoted an unrecognized `fail_reason` into recovery prose, `uploadInterruptedError` inlined `publish_id` in two slots, `possibleDuplicateError` inlined `matched.publish_id` — with nothing that could notice. Extending it rather than leaving the error channel alone survives the strongest counter-argument, that an error is diagnostic and one which refuses to name the failure it complains about is worse: § 5.2 rule 5's division of labour ("the error states cause + recovery, the hint operationalizes the recovery") is about *content*, not trust, and all three values are name-shaped — an id, a failure code — never free prose, so nothing diagnostic is lost by dropping a value that is not name-shaped while the raw one stays one field away in `details.publish_id` or `data.fail_reason`, which the sanctioned variant points at by name. Refusal, not truncation, on this channel too: a clipped `publish_id` quoted back yields `invalid_publish_id`, and a clipped `fail_reason` would still render injected prose *inside* the server's own recovery sentence, which is the whole failure mode. The rule is written where a reader of the error catalog finds it — a new § 3.0 subsection "Upstream values in error and recovery text" with the three sanctioned variants, cross-referenced from § 5.2 rules 3 and 5 and from Appendix A — not smuggled into § 5.2, which governs § 5 only. `test/result.test.ts` gains a source walk over the `src/tools/` catalog messages that fails on an interpolated value no allow-list entry vouches for; `test/hint-guard.test.ts` gains poisoned-value sweeps for all three sites. The walk is scoped to `src/tools/` on purpose: two sites below the tool layer diverge — `core/http` appends up to `UPSTREAM_TEXT_MAX` (200) characters of upstream text to `upstream_error`/`oauth_error`, and `api/publish` joins the upstream privacy-option list into `privacy_level_unavailable` — and a repo-wide walk would have had to allow-list them, i.e. bless them. They are recorded as divergences in § 3.0 and in the walk's own docblock, and left as they are | integrator (post-0.7.0 defect fix) |
| 2026-09-02 | `mcp/result`: `MAX_HINT_CHARS` stays enforced at **one** runtime site — `elisionNote`, the pagination-cursor hint — and nowhere else; a general runtime clamp on `Hint.text` was considered and declined. Now that every hint text is a server template plus `hintToken`/`hintEnum`-admitted values, the resume cursor is the only unbounded value that reaches a hint, so an over-long hint anywhere else is a bug in *this server* rather than a length upstream chose, and CI can see it: `test/result.test.ts` walks the constructors and holds each under the cap. The counter-argument — nothing structurally stops a future constructor — was weighed against what a clamp would have to do with the over-long hint, and every answer is worse than the bug it prevents. Truncation cuts the *end* of the sentence, which is exactly where the negative imperative lives ("Do not re-post.", "Do not post again."), so a clamped hint reads as permission to do the one thing it was written to forbid; dropping the hint silently strands a model that was about to be told to poll; throwing turns an already-succeeded post into an error result. The decision and its reason are recorded on the constant's docblock and in TOOLS.md § 5.2 rule 1. The one real gap the question exposed is closed instead: `stillProcessingHint` was absent from the "widest hint" test, so `test/hint-guard.test.ts` now builds it end-to-end at `MAX_HINT_TOKEN_CHARS` and asserts the fit | integrator (contract decision) |
| 2026-09-09 | `tools/publish-common`: new exported types `AppliedResult`, `FailedDispatch`, `DispatchResult` and `WaitedResult`; `dispatchWrite` returns `DispatchResult` and `waitIfAsked` now takes one and returns `WaitedResult`. Additive at every call site — both were already `ToolResult<AppliedData>` and the new types are subtypes of it — so no caller changed and no test was rewritten. The change is a **coverage honesty** fix, not a feature: `ok` and the presence of `data` were two independent facts the type system could not relate, so `waitIfAsked` had to test `data === undefined` on a value that always had one, and the resulting dead arm was excluded with a `c8 ignore` rather than tested. Four exclusions across `tools/publish-write` and `tools/publish-photos` came from the same shape (`?? ''` and `?? []` on values a check upstream had already proved present) and are removed by the same reasoning; `checkSourceArgs` returns the narrowed `CheckedSource` (module-private, so not listed above) for the two `resolveSource` sites. **A branch that cannot be taken is a claim about the type, and the fix is to make the type say it** — an exclusion moves the branch out of the denominator and leaves the wrong type in place, which is how a 100% report and an untested line coexist. No zod schema, no `docs/tool-manifest.json` entry and no error text changed; error strings are byte-identical (raised by the ignore-hint census) | integrator (contract decision) |
| 2026-09-10 | `core/config`: added a private `errnoFor(err: unknown): string` beside `errnoOf`, and routed every warning and message site through it. **No exported signature changes** and no test was rewritten. The six sites each wrote the same `errnoOf(...) ?? 'unknown'` chain out by hand, and five of the six could not reach the fallback — `fs` always answers with an errno — so five whole lines were excluded from coverage with `c8 ignore`. The exclusions were wider than the claim: the line at the `saveEnvFile` catch also carried `errnoOf(cause) ?? errnoOf(err)`, and **both of those arms are driven by tests** (`cc-h3` ENOTDIR takes the cause arm, `cc-h3` `env_file_malformed` takes the own-code arm) — the hint was hiding covered code alongside the uncovered fallback. Written once, the chain has exactly one fallback and every arm sits on a path a test takes: the injected `rename` seam can reject with anything (CC-H3), and `test/login.test.ts:1414` already rejects with a codeless `Error`. The one arm nothing reached — a rejection that is not an `Error` at all — is now a test rather than an exclusion (`cc-h3 a rejection with no errno at all still warns with a code`), using the house `prefer-promise-reject-errors` disable that six other test files already use for the same reason. `config.ts` goes from six `c8 ignore` hints to **zero** at 100% branch coverage. The only behavioural difference is in text that was previously unreachable: the `env_file_unreadable` message's fallback reads `(unknown)` rather than `(unknown error)`, and it is now reachable. Same principle as the 2026-09-09 row: **a branch that cannot be taken is a claim about the code's shape, and the fix is to change the shape** — an exclusion moves the branch out of the denominator and leaves the duplication in place. | integrator (coverage honesty) |
| 2026-09-10 | `cli/login`: the § above gains the seam-split exports — `readLine`, `defaultPrompt`, `promptOf`, `spawnDetached`, `defaultOpenBrowser`, `openBrowserOf`, `callbackRequest`, `effectivePort` — and `journalPaths`, whose return type is now the tuple `readonly [string, string]` rather than `readonly string[]`. All additive except the tuple, which narrows a type nobody could widen: the function has always returned exactly the journal and its one rotation, and `--purge-journal` indexes both. The exports exist for the same reason `PACKAGE_SCOPES` does (2026-08-07 row) — a property a test cannot otherwise observe. Specifically: `deps.prompt ?? defaultPrompt` written inline has a fallback arm reachable only by *entering* it, which means reading the test runner's own stdin; returned by `promptOf` it is an identity `assert.equal` settles, and the exclusion shrinks from the whole `??` to the one line that binds `process.stdin`. Same split for the browser opener against `process.platform`. `cli/login.ts` goes from four `c8 ignore` hints to **two**, both correctly verdict-4 (`production seam default, replaced by injection in every test`), each naming its injection point in `test/login.test.ts`. No behaviour, no error text and no exit code changed. | integrator (coverage honesty) |
| 2026-09-18 | § `cli/index.ts`: new § entry `cli/prompt.ts` — `readLine`, `defaultPrompt`, `promptOf` move there from `cli/login.ts` and gain `ask`. Not a contract change for any caller: `login` and `doctor` still reach the prompt through `CliDeps.prompt`, and the three moved exports had existed for eight days. What changed is that the 2026-09-10 rows were written by two workers with exclusive file ownership, and each reduced the same seam the same way — `cli/doctor.ts` ended up with a byte-identical `readLine`, `defaultPrompt` and `ask`, its own excluded line, and its own copy of the `readLine` test. One seam, one home: `cli/doctor.ts` goes from two `c8 ignore` hints to **none**, `cli/login.ts` from two to **one** (the browser binding), and the prompt's single exclusion lives in the module that owns it. `test/prompt.test.ts` is the suite for the seam; the duplicate tests left `login.test.ts` and `doctor.test.ts`. | integrator (coverage honesty) |
| 2026-09-18 | § `cli/index.ts`: `packageVersion` gains its testable half, `versionAt(url)`. The last `c8 ignore start`/`stop` block in `src/` sat over `packageVersion`'s `catch`, with a docblock arguing — correctly — that the fallback is unreachable in a checked-out or an installed tree. The argument was right and the exclusion was still the wrong tool: what made the `catch` unreachable was not the code but the *choice of file*, which was fixed to `import.meta.url` inside the same function. With the URL as a parameter the read-and-parse is ordinary code, and `test/cli.test.ts` drives every degrading shape (missing file, not JSON, an array, `null`, no `version`, an empty one, a number) plus the one that carries a version. Same principle as the 2026-09-10 `core/config` row: a branch that cannot be taken is a claim about the code's shape, and the fix is to change the shape. `src/` now carries **15** hints and **0** block lines, down from 47 and 74 at the start of the round; `--version`'s output, cache and fallback value are unchanged. | integrator (coverage honesty) |
| 2026-09-18 | `api/publish` + `tools/publish-common`: the init result is now keyed on the source kind — `PublishInitResult<S extends VideoSource>` resolves to `{ publishId; uploadUrl: string }` for a FILE_UPLOAD and to `{ publishId; uploadUrl?: string }` for a PULL_FROM_URL, with `VideoPostInit<S>` / `DraftUploadInit<S>` and `initVideoPost<S>` / `initDraftUpload<S>` generic over the same `S` (`VideoSource` is unchanged as the union `PullFromUrlSource | FileUploadSource`, both now exported). Every existing call site compiles unchanged: the type parameter is inferred from `req.source`. The 2026-08-09 row made a FILE_UPLOAD init *throw* without an `upload_url`; the type now says so too, so the file branch of `videoSender` reads `started.uploadUrl` instead of `?? ''` behind an exclusion. In `DispatchOptions`, `send`'s `report` takes an `InitialisedUpload { publishId; position }` and the optional `position?` is gone: only a sender with chunks still to send ever reports (the URL video branch and `photoSender` resolve straight out of their init, which is their last throwable step), so an initialised failure always has a position to name and `classifyDispatch` no longer carries an unreachable `{ chunk: 0, total: 0 }` default. Journal records are unchanged (`chunk` was written on every real post-init path before). One test added, pinning behaviour that existed unpinned: an unwritable journal after an interrupted upload names the `publish_id` in its note (CC-B4). | integrator (coverage honesty) |
| 2026-09-18 | `core/redact`: additive export `redactRecord(record: Record<string, unknown>): Record<string, unknown>` — `redactValue`'s walk entered at the plain-object step, so it is the same nested default-deny, depth limit, cycle marking and key rules, and `redactRecord(r)` deep-equals `redactValue(r)` for every plain object `r` (pinned by an explicit fixture and a fast-check property). `core/log` applies it to a record's fields; the `else` arm that assigned a non-record result to `record.fields` was a backstop for a return type of `unknown`, not for any value the walk can produce, and is gone with its exclusion. `redactValue` is untouched. | integrator (coverage honesty) |
| 2026-09-18 | `core/oauth`: `isFresh`'s `Number.isFinite` guard removed as dead, not as unreachable. `Date.parse` yields a finite number or `NaN`, and `NaN - nowMs > skewS * 1_000` is already `false` — the guard's own answer — so input → output was identical with and without it, and the old docblock's claim that the bare subtraction "would say fresh for ever" was wrong. The invariant it guarded (every `TokenSet` expiry parses: `toTokenSet` renders with `toISOString`, `toCachedSet` copies a value `readProfile`'s `timestamp` guard has already parsed, CC-H2; no exported entry point takes a `TokenSet` from outside) is now stated in the docblock and pinned at the oauth boundary by a test that a stored `'tomorrow'` is `invalid_timestamp` before any request. `TokenSet` is unchanged. | integrator (coverage honesty) |
| 2026-09-18 | `mcp/http`: new export `boundPortOf(address: AddressInfo \| string \| null, fallback: number): number` — the bound-port narrowing split out of the bind so its two type-only arms (a pipe path, `null`) are decided by an ordinary function and tested directly, the same shape as `cli/login.ts`'s `effectivePort` (2026-09-10 row); the two are the same one-liner in two layers because `mcp/` may not import `cli/`, and a `core/` home for both is a later, separate move. Rejected: a `createServer?` injection on `HttpTransportOptions`, which nothing but that one arm would use. `requestPath` now takes `String(req.url)` under the same comment as `String(req.method)` five lines below. `core/http`: `assertAllowedUrl` keeps its signature over a module-private `checkAllowedUrl(url, kind): URL \| TikTokError`, so the egress logging wrapper narrows on `isTikTokError` instead of on a `catch (error: unknown)`; `withRetries` is a `while` over a failed outcome with `return outcome.value` after it. `mcp/journal`'s two readers and `core/http`'s fetch attempt nest `try { try … catch … } finally` — V8 leaves an uncovered continuation on a single-statement `try/catch/finally` whose catch always throws, and the nesting has the same semantics. No behaviour, log line, error or record changed anywhere in this row. `src/` now carries **2** hints (both `production seam default`) and **0** block lines. | integrator (coverage honesty) |
| 2026-09-18 | `core/config`: § above brought back into line with the code — `EnvFileSnapshot` has been `ExistingEnvFile \| MissingEnvFile`, discriminated on `exists`, since 2026-09-10 (`src/core/config.ts:161-207`, pinned by `test/config.test.ts:261`), and this document still showed the flat shape with `exists: boolean` and `mode?: number`. **The type is the change, recorded late**: `readEnvFile` builds exactly two literals and each either has a mode or cannot have one, so the optional field only ever manufactured the guard at `cli/doctor.ts`'s permissions check that nothing could reach (TESTING.md verdict 5 — fix the type, not the coverage). For a caller the difference is that `snapshot.mode` is a `number` once `snapshot.exists` has been narrowed and does not exist on the other arm; nobody read `mode` without checking `exists` first, so no call site changed. The two worklog notes that still listed this as an open verdict-2 item were stale. | integrator (docs drift) |
| 2026-09-18 | `core/net`: new module with one export, `boundPortOf(address: AddressInfo \| string \| null, fallback: number): number` — the bound-port narrowing that `mcp/http` (its 2026-09-18 row above) and `cli/login` (2026-09-10 row, as `effectivePort`) each carried as its own copy with its own docblock and its own three-arm test. **`mcp/http.boundPortOf` and `cli/login.effectivePort` are removed**: breaking on the export surface, observable to nobody but the two test files, which now leave the three-arm assertions to `test/net.test.ts` and keep their surface tests (an ephemeral bind advertises the OS-assigned port; `cc-a8` is still named by nine `login` tests). Body, both call sites and behaviour unchanged. The duplicate existed only because `mcp/` may not import `cli/`; `core/` is the layer both may import. `src/` still carries 2 hints. | integrator (dedup) |
| 2026-09-19 | `mcp/prompts`: new module (TOOLS.md § 7.1) — `PromptArgumentSpec`, `PromptArgs`, `PromptSpec` (a `tiktok_`-prefixed `name`, `package: ToolPackage`, `arguments`, `render(args): readonly PromptMessage[]`), `definePrompt` (rejects a malformed spec with `TikTokError` code `invalid_prompt_spec` at module load, like `defineTool`), `describePrompt` (the `prompts/list` entry), `validatePromptArgs` (an unknown or missing-required argument is `McpError` / `InvalidParams`, `Invalid arguments for prompt <name>: …`) and `getPrompt` (validate, then render). Mechanism only: no prompt is defined here. | integrator (Phase 4 slice 1) |
| 2026-09-19 | `mcp/resources`: new module (TOOLS.md § 7.2) — `RESOURCE_SCHEME` (`tiktok`), `RESOURCE_MIME_TYPE` (`application/json`), `ResourceSpec` (a `tiktok://` URI bound to one read-only `AnyToolSpec` plus fixed `args`), `ParsedResourceUri`, `defineResource` (`invalid_resource_spec`), `describeResource(spec, marker?)` / `describeResourceTemplate` (`${uri}{?account}`), `parseResourceUri` (`undefined` for any other scheme or query key), `resourceArgs` (the spec's `args` plus the optional `account`) and `resourceContents(uri, result, settings)` (the tool envelope, redacted and truncated by the same `truncateResult` as `tools/call`, as one JSON text content). A resource is a tool read through the unchanged `callTool` pipeline, never a second one. | integrator (Phase 4 slice 1) |
| 2026-09-19 | `tools/prompts` and `tools/resources`: new data modules — `postVideoGuidedPrompt` + `PROMPTS`, and `authStatusResource` / `userInfoResource` / `recentVideosResource` / `creatorInfoResource` + `RESOURCES`. Both frozen arrays are the one ordered source for `prompts/list`, `resources/list` and the TOOLS.md § 7 tables; entries are appended, never re-sorted. `tools/` depends on `mcp/`, never the reverse (layer map unchanged). | integrator (Phase 4 slice 1) |
| 2026-09-19 | `mcp/server`: additive `ServerOptions.prompts?` / `resources?` (default `[]`), new exports `enabledPrompts(prompts, settings)` and `enabledResources(resources, tools)` (the package gate applied to the two manifests, membership by tool *name*), the five `prompts/*` and `resources/*` handlers on the same low-level `Server`, and capabilities `{ tools: { listChanged: true }, prompts: {}, resources: { listChanged: true }, logging: {} }`. **`McpServerHandle.notifyToolListChanged()` is renamed `notifyListChanged()`** — breaking on the handle surface, observable to `src/index.ts` and the `server` / `lifecycle` tests only: one cause (a credential change) moves both lists, because a resource description carries its tool's `[UNAVAILABLE: …]` marker, so the handle emits `tools/list_changed` then `resources/list_changed` from one call. `mcp/lifecycle` is unchanged in code; its docblock names the new method. `src/` still carries 2 hints. | integrator (Phase 4 slice 1) |
| 2026-09-19 | `mcp/resources`: path parameters (TOOLS.md § 7.2, Phase 4 slice 2) — `ResourceSpec.uri` may carry `{name}` segments after the host segment, each a tool argument the read cannot default; `defineResource` rejects a `{name}` outside the argument-name grammar, in the host, repeated, named `account`, or fixed by `args` too (all `invalid_resource_spec`). New exports `ResourceMatch`, `resourceParams(spec)`, `isResourceTemplate(spec)` and `matchResource(specs, uri)` (concrete equality first, then the templates, both in manifest order; a `{name}` binds one non-empty segment, percent-decoded, a malformed escape is no match). **Signature change:** `resourceArgs(match: ResourceMatch, parsed)` replaces `resourceArgs(spec, parsed)` — `{ ...spec.args, ...params, account? }`. `describeResourceTemplate` is unchanged in code and now yields RFC 6570 proper for a template (`tiktok://publish/{publish_id}/status{?account}`). The braces of a template read verbatim are percent-encoded by the URL parser and decoded back, so that read reaches the tool with `publish_id: '{publish_id}'` — the tool, not the router, answers for an id TikTok does not know; pinned by a test rather than special-cased | integrator (Phase 4 slice 2) |
| 2026-09-19 | `mcp/server`: `resources/list` lists the enabled *concrete* specs only; `resources/templates/list` lists every enabled spec; `resources/read` resolves through `matchResource` over the enabled specs (kept as the ordered list `enabledResources` returns, not a map, because a template is matched, not looked up) and hands `resourceArgs(match, parsed)` to `callTool`. A path no spec matches — an empty segment, a malformed escape — is `Unknown resource: <uri as sent>` like any other unknown URI. No new option, no new export | integrator (Phase 4 slice 2) |
| 2026-09-19 | `tools/prompts` and `tools/resources`: two prompts and two resources appended — `postPhotosGuidedPrompt` (`tiktok_post_photos_guided`: `photo_urls` required as one comma/whitespace-separated string, `title`, `description`, `privacy_level`, `account`) and `uploadDraftGuidedPrompt` (`tiktok_upload_draft_guided`: `video`, `photo_urls`, `title`, `account`, all optional — exactly one of the two media, the other two situations render a question and no steps); `publishJournalResource` (`tiktok://publish/journal`, `args: {}`, where `?account=` is the tool's filter per § 2.2) and `publishStatusResource` (`tiktok://publish/{publish_id}/status`, the manifest's one template, `args: { wait_for_completion: false }` because the tool's default polls ~60 s). The shared sentences of the three flows are module constants; `PROMPTS` is video, photos, draft and `RESOURCES` ends with the template | Workers P2 and R2 (Phase 4 slice 2) |
| 2026-09-19 | `mcp/completions`: new module (TOOLS.md § 7.3, Phase 4 slice 3) — `COMPLETION_MAX` (100), `CompletionSource` (`profiles` \| `values` \| `publish_ids`), `CompletionRuntime` (the structural subset of `ServerRuntime`: `settings`, `log`, `profiles()`), `CompletionRequest`, `Completion` (`values`, `total`, `hasMore`, all three always), `completionSourceProblem(source)` and `complete(source, runtime, request)` — case-insensitive prefix, source order, cut at 100, `undefined` source ⇒ empty, locked profile alone under `TT_LOCK_PROFILE`, journal ids newest first and once, filtered by `context.account` exact-case. Every source is local; no TikTok call. Imports `core/` types and `mcp/journal` only | integrator (Phase 4 slice 3) |
| 2026-09-19 | `mcp/journal`: additive `journalOptionsFor(settings, logger)` — the one journal wiring (`envFile` when set, `journalMaxBytes`, the logger). `tools/publish.ts`'s exported `journalOptions(ctx)` now delegates to it with `ctx.api.settings` / `ctx.log` (values unchanged) and `mcp/completions` calls it for `publish_ids`, keeping the 2026-08-09 rule — the wiring "must be identical" for every reader and writer — true with a third consumer | integrator (Phase 4 slice 3) |
| 2026-09-19 | `mcp/prompts`: additive `PromptArgumentSpec.completion?: CompletionSource` (never on the wire); `definePrompt` also rejects a `values` source that lists nothing or repeats a value (`invalid_prompt_spec`); new export `promptCompletion(spec, argument)` — the declared source or `undefined`, an undeclared name throwing the `Invalid arguments for prompt <name>: unknown argument "…"` McpError of `validatePromptArgs` | integrator (Phase 4 slice 3) |
| 2026-09-19 | `mcp/resources`: additive `ResourceSpec.completions?: Record<string, CompletionSource>` (frozen by `defineResource`; a key must be a `{name}` of the URI and not `account`; a `values` source must list something and repeat nothing — all `invalid_resource_spec`); new exports `matchResourceRef(specs, uri)` (the spec whose `uri` or `${uri}{?account}` template equals the ref — a read URI, a query or an unlisted spec is `undefined`) and `resourceCompletion(spec, argument)` (`{ kind: 'profiles' }` for `account` on every spec, the declared source for a `{name}`, any other name ⇒ McpError `Invalid arguments for resource <spec.uri>: unknown argument "…"`). | integrator (Phase 4 slice 3) |
| 2026-09-19 | `mcp/server`: the `completion/complete` handler on the same low-level `Server` — `ref/prompt` through `promptCompletion` over the enabled prompts, `ref/resource` through `matchResourceRef` + `resourceCompletion` over the enabled resource specs, then `complete(source, runtime, { value, context: context?.arguments })`; an unknown or gated-out prompt is `Unknown prompt: <name>`, an unmatched ref uri `Unknown resource: <uri>`. Capabilities gained `completions: {}` (the SDK refuses the handler without it). No new option, no new export; `prompts/get` shares the prompt lookup | integrator (Phase 4 slice 3) |
| 2026-09-19 | `tools/prompts` and `tools/resources`: the shared `ACCOUNT_ARGUMENT` declares `{ kind: 'profiles' }` and `PRIVACY_ARGUMENT` `{ kind: 'values', values: PRIVACY_LEVELS }` (`tools/prompts` now imports `api/publish` for the tuple — allowed by the layer map); `uploadDraftGuidedPrompt` gained an optional `description` after `title` (photo draft: stated and passed when given; video draft: stated as not sent, one sentence for title, description or both); `publishStatusResource` declares `completions: { publish_id: { kind: 'publish_ids' } }`. `PROMPTS` / `RESOURCES` order unchanged | Worker P3 and integrator (Phase 4 slice 3) |
| 2026-09-23 | zod 3 → zod 4 (`^4.4.3`); `zod-to-json-schema` dropped (runtime dependencies 3 → 2). `mcp/server` advertises through zod's own `z.toJSONSchema(…, { target: 'draft-7', io: 'input' })`; `toolInput` now returns `z.ZodObject<…, z.core.$strict>` (the zod 4 spelling of the same strict object). No contract changed except two observable details: integer arguments now also advertise the safe-integer bound (`minimum`/`maximum` ±9007199254740991 in `docs/tool-manifest.json`), and the `invalid_params` detail reasons use zod 4's default wording, except a missing argument, which `mcp/errors`' `argumentErrorMap` renders as `required argument is missing` (was `Required`; zod 4's default `Invalid input: expected string, received undefined` read as a type mistake); the unknown-argument text is ours and unchanged. | integrator |
| 2026-09-23 | `api/context`: `TT_MAX_RETRIES` semantics — the read-class HTTP client is now built with `maxAttempts: 1 + settings.maxRetries`, so each idempotent read is tried once plus up to `TT_MAX_RETRIES` retries, like `TT_CHUNK_RETRIES`. It was applied as an attempt cap (the default `3` meant 3 attempts, 2 retries); the default `3` now allows up to 4 attempts and `0` disables retries. `core/http`'s own `maxAttempts` option and its default are unchanged; publish inits are still never retried | integrator |
| 2026-09-23 | `mcp/errors`: additive `unconfiguredProfileScopeError(profile, scope)` — the `missing_scope` a scoped tool returns when the profile has no stored credentials at all; `mcp/server`'s `checkScopes` uses it (with a `reauth` hint without `--scopes`) instead of `missingScopeError`, whose "authorized without scope" wording is false for a profile that was never authorized. Same code, not retryable; `details` gains `configured: false`. TOOLS.md § 3.0 gains the variant | integrator (round 4) |
| 2026-09-23 | `api/upload`: `uploadFile` gains the additive `identity?: FileIdentity` and pins the media file — one descriptor for every chunk and retry, identity checked against the verified one (`plan_mismatch`), in-place modification between chunks ⇒ `upload_interrupted`. `mcp/journal`: `checkDuplicate` extends its 256 KiB scan into the newest part of `.1` when the whole active generation fits the budget. No existing parameter changed | integrator (round 4) |
| 2026-09-23 | `mcp/server`: `ProfileInfo` gains the additive `authorized?: boolean` — `false` when the profile stores neither an access nor a refresh token or its record cannot be read; absent is treated as authorized. `checkScopes` now returns the unconfigured `missing_scope` form (plain `login --profile <p>`, `details.configured: false`) for such a profile too — DEFAULT before the first login, a profile with only app keys — not only for a name missing from the list. `api/upload`: chunk bodies are positional 1 MiB reads on the pinned descriptor instead of a FileHandle read stream (a destroyed stream closed the shared handle and broke retries; each stream leaked a `close` listener). `mcp/journal`: the `.1` extension of the duplicate scan is decided on raw bytes read versus the same descriptor's fstat size, not decoded text length, which failed open on invalid UTF-8 in a cut tail. No existing signature changed | integrator (round 4b) |
| 2026-09-24 | `core/config`: additive `canonicalProfileName(name)` (trim + upper-case, no validation); `normalizeProfileName` is built on it. `mcp/server`'s `resolveAccount` (incl. the `TT_LOCK_PROFILE` check), the `tiktok_list_publish_journal` filter and the `publish_id` completion now compare a caller-given `account` through it, so matching is case-insensitive; `unknown_account` echoes the caller's spelling. `core/http`: `isPrivateAddress` also refuses `192.88.99.0/24`, SIIT `::ffff:0:0:0/96` (by embedded IPv4), the rest of `0000::/8`, `2001::/23`, `3fff::/20` and `5f00::/16`. No existing signature changed | integrator (round 5) |
| 2026-09-24 | `mcp/prompts`: `PromptSpec` gains the additive `requires?: readonly ToolPackage[]`, validated by `definePrompt` (`invalid_prompt_spec`); `mcp/server`'s `enabledPrompts` keeps a prompt only when its `package` and every `requires` entry are enabled. `tools/prompts`: all three guided prompts declare `requires: ['publish']` and JSON-quote every rendered user value. `mcp/resources`: `parseResourceUri` also refuses userinfo, a port, tab/CR/LF, dot segments (plain or `%2e`), a non-literal query key, `account` without `=` and an empty pair; the value is percent-decoded only. `mcp/server`: `notifyListChanged` attempts both notifications and rethrows the first failure; a completion whose source fails is a warning plus the empty completion; `TT_LOCK_PROFILE` also bounds the journal filter and the `publish_id` completion. `mcp/http`: additive `HttpTransportOptions.maxSessions` / `sessionIdleMs` (test seams); 4 MiB body cap (413), `400 -32700` on unparsable JSON, 128-session cap (503), lazy 30-minute idle close. `mcp/lifecycle`: `stop()` also awaits a `poll()`-started read, and `poll()` after `stop()` resolves `false` — the documented contract now holds. `src/index.ts`: an unreadable env file lists as no profiles. No existing signature changed | integrator (round 5b) |
| 2026-09-24 | `core/settings`: additive `Settings.httpAllowedHosts?: readonly string[]` (`TT_HTTP_ALLOWED_HOSTS` — comma-separated bare host names, lowercased; no scheme, port or wildcard). `mcp/http`: `OriginPolicy` gains the additive `allowedHosts?: ReadonlySet<string>`, and `dnsRebindingRejection` refuses a `Host` or `Origin` hostname outside it; `HttpTransportOptions` gains the additive `drainMs?` (test seam, default 10 s), and `close()` now drains — new requests `503`, in-flight non-`GET` requests get the budget, `GET` streams are not waited for, the rest is aborted with a warning — before tearing the sessions down; still idempotent, same promise. `mcp/journal`: additive `foldedAttemptsCached(opts?)` (fold reused under a size/mtime/inode signature of both generations), which the `publish_ids` completion now reads through; the directory is fsync'd best-effort after a rotation and after a creating fsync'd append. No existing signature changed | integrator (round 6) |
| 2026-09-24 | `mcp/journal`: rotation now takes a cross-process lock of its own, `journal.ndjson.lock` — `withEnvLock` keyed on the journal path, so it never contends with the env-file lock and a publish never queues behind a token refresh. The unlocked size check stays the lock-free fast path; under the lock the size is re-checked, so a process that waited while another rotated does not rotate the fresh generation again. The wait is 2 s (`ROTATE_LOCK_WAIT_MS`); past it, or when the lock is unusable, the rotation is skipped with the existing `could not rotate the publish journal; it keeps growing` warning and the append proceeds. A crashed holder is reclaimed by env-lock's stale rule (15 s, mtime). Intent and outcome appends still take no lock. Closes the documented known limit that two processes rotating concurrently could discard one rotated generation. No signature changed | integrator (round 7) |
| 2026-09-24 | `mcp/http`: the drain now also counts JSON-RPC requests from arrival to answer (`trackCalls`, wrapped around the transport after `connect`), so a client that disconnected mid tool call no longer lets `close()` abort its running handler; an answer, a `notifications/cancelled` for the id, or the transport closing settles it, and the whole drain stays bounded by `drainMs` (`DEFAULT_DRAIN_MS`, 10 s). A session initialized after the teardown emptied the map is closed at once, and a `connect` failure releases the handle. `core/settings`: additive `canonicalHostName(value)` — `TT_HTTP_ALLOWED_HOSTS` entries are stored in WHATWG URL canonical form (lowercase, IPv6 compressed, `127.1` → `127.0.0.1`), IPv6 zone ids rejected; `mcp/http`'s `parseAuthority` canonicalizes the `Host` hostname the same way. `src/index.ts` / `doctor`: both `TT_HTTP_INSECURE=1` warnings fire only on a non-loopback bind. `core/env-lock`: additive `EnvLockOptions.label?: { lock, guards }` for the messages; journal rotation reports as the "journal rotation" lock guarding "the publish journal". `mcp/journal`: `foldedAttemptsCached` returns a frozen array. No existing signature changed | integrator (round 7) |
| 2026-09-25 | Round 8 fixes. **`mcp/plan-store`**: `PlanRecord` and `PlanExpectation` gain the additive `fileIdentity?: string` (`size:mtimeMs:dev:ino`, CC-D3) and `ConsumeFailure` gains `"file_changed"`, checked last — the identity is bound to the plan, never folded into the digest (the duplicate guard's key) and never sent upstream; `tools/publish-common` adds `fileChangedError()` (`plan_mismatch`, `details.reason: "file_changed"`, its own text). **`tools/publish-common`**: a caller cancellation that lands while the send is in flight — init or mid-upload — is `network_ambiguous` journaled `send_ambiguous` (mid-upload with `publish_id` and `chunk`; `networkAmbiguousError(publishId?)` is additive), so the duplicate guard blocks a blind retry (CC-G4); a cancel before the send began stays `error`. `runPlanGuards` step 7 is now peek the rate token → `consumePlan` → take the token, so a plan lost during the duplicate guard's file read costs no token. **`mcp/journal`**: `checkDuplicate(payloadDigest, profile, clock, opts?)` — the guard is per profile in canonical spelling (CC-F4) and `possible_duplicate` names the matched attempt's profile. **`mcp/server`**: `resolveAccount` treats a whitespace-only `account` as absent (the active or locked profile); `tiktok_list_publish_journal` with a blank `account` filters nothing. **`core/env-lock`**: breaking a stale lock renames it to a unique tombstone and deletes it only after verifying the tombstone is the directory whose age was measured, so a breaker that lost the race no longer deletes a successor's fresh lock. **`core/http`**: IPv6 egress refuses every address outside global unicast `2000::/3`. **`src/index.ts`**: the server's `createContext` reads the live `process.env` plus the env file for credentials instead of the startup overlay, so a rotated or revoked refresh token is never reused. **`cli/login`**: `login --revoke` exits 1 when the local clear fails. **`cli/doctor`**: reports the journal rotation lock (`journal.ndjson.lock`) and fails on an unreadable profile. **`core/config`**: the `.pre-schema<N>` backup is created 0600 (`open(…, 'wx', 0o600)`), never copied at the umask's mode then tightened. No frozen call form breaks | integrator (round 8) |
| 2026-09-25 | Round 9 fixes. **`tools/publish-common`**: `runPlanGuards` registers the in-flight entry before the duplicate-journal read (also under `force`) and releases it on every later refusal — journal duplicate, rate bucket, plan consume — so two concurrent identical publishes can no longer both pass the journal check. **`api/upload`**: a transport failure (`network_error` / `timeout`) on the final chunk throws `network_ambiguous`, since TikTok may have received the whole file; `classifyDispatch` records it as `send_ambiguous` with `error_code: network_ambiguous` (CC-G4) instead of `upload_failed`. On a `416` resync, `onProgress` fires only when the position advanced, and a resync to the end completes the upload. **`core/config`**: `applyUpdates` rewrites an existing case-variant line of a per-profile key in place, in the canonical upper-case spelling, and drops the other variants (CC-F4). **`core/redact`** callers: `client_secret` is registered for exact-value redaction in `readProfile` and `exchangeCode`, and `revokeToken` registers the access token before the request; `revokeToken` returns `RevokeOutcome`. **`core/oauth`**: with no refresh token on file or in the environment, `ensureFreshAccessToken` does not spend the in-memory one — it drops the cached set and throws `auth_expired`, so a server process never resurrects a profile another process revoked. **`core/env-lock`**: the stale-lock identity also compares the measured mtime, so inode reuse on a file system without birth time cannot make the breaker delete a live lock. **`mcp/http`**: the idle sweep skips a session with unanswered calls; a `Host` with an invalid port is `403`, not a bare `400`; during the drain a `notifications/cancelled` for an existing session is still delivered; a `POST` whose body completes after the drain began is `503`, not `404`. No frozen call form breaks | integrator (round 9) |
| 2026-09-25 | Round 10 fixes. **`api/upload`**: once an attempt at the final chunk lost its answer (`network_error` / `timeout`) and was replayed, any later failure of that chunk — `5xx` retries exhausted, or a terminal `403` / `404` / `400` — throws `network_ambiguous`, not `upload_interrupted` (CC-G4). A final-chunk `416` whose progress equals the last byte index (`total − 1`) throws `network_ambiguous` — until probe P-11 pins the unit it is every byte or all but one; progress ≥ `total` still completes. A `416` resync that moves the position calls `onProgress` for it even backwards, so a later failure names the right chunk; `tools/publish-write` keeps MCP progress monotonic. **`tools/publish-common`**: an exception thrown by the guards after the in-flight registration releases the entry. **`core/env-lock`**: a successor's lock moved aside by the stale-lock breaker is renamed back only onto a free path. **`mcp/http`**: a `Host` port with leading zeros is re-spelled canonically before the bound-port comparison. **`cli/login`**: the default profile is `TT_LOCK_PROFILE`, then `TT_ACTIVE_PROFILE`; a flag-looking separated value is a missing value; an invalid `--profile` is a usage error (exit 2) and the name is upper-cased; existing credentials with no TTY and no `--force` exit 2, a "no" at the prompt exits 1. **`core/config`**: the `unknown_profile` remediation names `tiktok-mcp-ai login --profile <name>`. **`core/settings`**: `TT_MAX_RETRIES` / `TT_CHUNK_RETRIES` max 10, `TT_TOKEN_REFRESH_SKEW_S` max 86400. **`api/user`**: `user: null` is a malformed payload. No signature changed | integrator (round 10) |
| 2026-09-26 | Round 11 fixes. **`mcp/journal`**: `appendLine` treats a short write (`bytesWritten` below the line's byte length) as a failed append — warn, `journal: "unavailable"`, the publish proceeds; an append to a file whose last byte is not `\n` (a torn line) first writes `\n`, so the fragment stays its own skipped line instead of swallowing the next record. **`mcp/plan-store`**: at the `TT_PLAN_MAX_OUTSTANDING` cap the oldest *used* plan is evicted before any live one. **`api/publish`**: a `2xx` init (video, inbox or photo) without a readable `publish_id` throws `network_ambiguous` (kind `network`, `cause` = the `malformedPayload` error) instead of `upstream_error`, so it is journaled `send_ambiguous` and the duplicate guard holds (CC-G4). **`core/oauth`**: `revokeToken` re-reads the profile under the env lock and also revokes an access token a concurrent refresh rotated in since the first read; `RevokeOutcome.upstream` reports that second call. No signature changed | integrator (round 11) |
| 2026-09-26 | Round 12 fixes. **`core/http`**: a publish init (retry class `init`) answered with a `2xx` or `5xx` whose body is not JSON or not a JSON object, or a `5xx` envelope without `error.code`, throws `network_ambiguous` (journaled `send_ambiguous`, like an init timeout); a `4xx` or an explicit error code keeps its mapping. **`api/video`**: a `videos[]` entry that is not an object with a string `id` is a malformed payload (`upstream_error`). **`core/settings`**: `TT_TOKEN_REFRESH_SKEW_S` max 43200. **`core/env-lock`**: new export `canonicalPath(path)`; the lock directory and the atomic write key on it, so a symlink and its target share one lock and a dangling link is written to its target (parent created, link kept); `doctor` reports the lock at the canonical path. **`mcp/server`**: `connectStdio` returns a `StdioSession` (`transport`, `drain(budgetMs, clock)`); `src/index` drains stdio calls in flight for up to 10 s on `SIGINT`/`SIGTERM` and closes at once on stdin EOF. **`cli/login`**: `--manual` with stdin ending before a paste exits 1. **`cli/doctor`**: `--profile` followed by a flag, or an invalid profile name, is a usage error (exit 2). **`tools/publish`**: `tiktok_list_publish_journal` `since` must be a date or a date-time with `Z` or an offset, else `invalid_params`. Signatures: `connectStdio` now returns `Promise<StdioSession>`; `canonicalPath` is a new, additive export | integrator (round 12) |
| 2026-09-26 | Round 13 fixes. **`mcp/server`**: `StdioSession.drain` gains the additive `signal?: AbortSignal` — it resolves at once when the signal is already aborted and as soon as it aborts mid-drain; `src/index.ts` passes one that stdin EOF aborts. From the first `drain` call on, a new JSON-RPC request is answered `-32000` `Service Unavailable: the server is shutting down` instead of started (the HTTP transport's `503`). `trackStdioCalls` counts requests per id, so a reused id still in flight keeps the drain open until its last answer; a `notifications/cancelled` settles every request under its id. **`mcp/http`**: `openSession` reserves a slot before the handle and `connect` are awaited, so concurrent `initialize` requests cannot together exceed `maxSessions`. **`core/env-lock`**: `canonicalPath` follows a dangling symlink chain hop by hop to its end (up to 40 links), so every link in the chain shares one lock and none is replaced by a regular file; a loop returns the path as given. **`core/http`**: a `429` whose body is empty, not JSON, or JSON that is not an object is `rate_limited` with the wait hint (CC-B8), not `upstream_error`. **`core/oauth`**: a refresh that settles after `resetTokenCache` removes its in-flight entry only if it is still its own. No other exported signature changes. | integrator (round 13) |
