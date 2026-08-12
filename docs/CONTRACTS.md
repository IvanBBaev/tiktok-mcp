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
`tools/list_changed`) is the deliberate case: it lands in Wave E, consumes
contracts already frozen here, and exports nothing a Wave B–D task compiles
against. Freezing a speculative signature for it now would pin a design that
has not been done. Its absence is not an oversight, and adding it later is an
addition, not a contract change.

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
 *  top of it, not inside it). */
export interface EnvFileSnapshot {
  readonly path: string;
  readonly exists: boolean;             // false ⇒ "no file yet", not an error
  readonly values: ReadonlyMap<string, string>;
  readonly declaredSchema?: number;     // as written in the file, if present
  readonly schema: number;              // effective (defaults to 1)
  readonly mode?: number;               // POSIX permission bits, if statable
  readonly warnings: readonly string[]; // duplicate keys, loose mode, …
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

/** Upper-cased, validated profile name; the sole gate on what may become part
 *  of an env key. Error code: "invalid_profile_name". */
export function normalizeProfileName(name: string): string;

/** Every profile the snapshot + process env declare, DEFAULT always included
 *  and always first-class; an explicit TT_PROFILE_DEFAULT_* key is an error
 *  (CC-F4). */
export function listProfiles(
  snapshot: EnvFileSnapshot, env?: NodeJS.ProcessEnv,
): readonly string[];

/** Read profile after presence-based process-env overlay (CC-F2). Error codes:
 *  "unknown_profile" (listing the ones that exist), "missing_credentials",
 *  "invalid_timestamp" (CC-H2). */
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
 *  win32, asserted POSIX-only); EPERM/EBUSY/EACCES rename retried ×3
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
}

/** The lock directory for an env file: `<envfile>.lock`, a sibling so it
 *  shares the file system and the parent's permissions. Exported for
 *  `doctor`, which reports stale locks. */
export function envLockDir(envFilePath: string): string;

/** Cross-process mutex around the env file (SYNTHESIS § 2.2):
 *  fs.mkdir("<envfile>.lock") acquisition (atomic on every platform/FS);
 *  a JSON {pid,hostname,createdAt} file inside is diagnostic only —
 *  liveness is mtime-only. Timeout ⇒ TikTokError code "env_file_busy".
 *  Caller obligation (oauth): on timeout re-read the env once and adopt a
 *  rotated token before surfacing the error. The journal does NOT use this
 *  lock (O_APPEND).
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
// init:  NEVER retried (CC-B4/B5); upstream 429 on init is terminal (CC-B8)
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
 *  (CC-B1); non-JSON tolerated (CC-B2); redirect:"error" (CC-B6). */
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
failed or timed out — CC-B4/B5, terminal, remediation points at the publish
journal); `network_error` and `timeout` (retryable, `read`/`chunk` only);
`rate_limited` (CC-B8, carries the wait hint); `upstream_error` (a 5xx on a
chunk PUT); `invalid_params` (a non-positive duration option, a `GET` with a
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
 *  once, else terminal re-login error (SYNTHESIS § 2.2). */
export function ensureFreshAccessToken(
  profile: string, deps?: RefreshDeps,
): Promise<string>;

/** Revocation KEEPS the journal (SYNTHESIS § 2.10); purge is a separate,
 *  explicit CLI flag. Clears the six token keys and the in-process cache. */
export function revokeToken(profile: string, deps?: RevokeDeps): Promise<void>;

/** Drops the in-process credential cache (adopted set + spent-token memo).
 *  Test seam: module state is per-process by design. */
export function resetTokenCache(): void;
```

Two pieces of per-process state sit behind these functions. The **adopted set** is
the credential cache single-flight hands out. The **spent-token memo** records the
refresh token each profile last sent to TikTok: CC-F2 makes a `TT_REFRESH_TOKEN`
pinned in the MCP client's config win over the file forever, so without the memo
every refresh after the first would spend the same dead token. `revokeToken`
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
export function getUserInfo(
  ctx: ApiContext, fields: string[], opts?: { signal?: AbortSignal },
): Promise<UserInfo>;

// api/video.ts
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

export interface PublishInitResult { publishId: string; uploadUrl?: string }
/** All three inits use retryClass "init": a publish attempt is spent on the
 *  first call, so a retry could duplicate a post. `uploadUrl` never leaves the
 *  api layer, and its `upload_token` is registered as a secret on the way out.
 *  A FILE_UPLOAD init (`req.source.source === "FILE_UPLOAD"`) MUST come back
 *  with an `upload_url`; a payload without one throws `malformedPayload(<init
 *  endpoint>, "upload_url string for a FILE_UPLOAD init")` rather than
 *  returning a result whose caller would only discover the hole one layer up,
 *  after the publish attempt was already spent. A PULL_FROM_URL init has no
 *  upload URL and is not checked. */
export function initVideoPost(ctx: ApiContext, req: VideoPostInit):
  Promise<PublishInitResult>;
export function initDraftUpload(ctx: ApiContext, req: DraftUploadInit):
  Promise<PublishInitResult>;
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

/** Streams each chunk with `fs.createReadStream(path, { start, end })` and owns
 *  the 1 + TT_CHUNK_RETRIES loop itself, passing `chunkRetries: 0`: `putChunk`
 *  disables its in-call retries for a stream body it cannot replay and defers
 *  to "the caller re-reads the byte range and calls again". Every attempt opens
 *  a fresh stream over a byte-identical `Content-Range`, which is what keeps
 *  RSS bounded on a 128 MB final chunk while still honouring CC-B7/CC-D6.
 *  `contentType` overrides the extension map (.mp4/.m4v ⇒ video/mp4,
 *  .mov/.qt ⇒ video/quicktime, .webm ⇒ video/webm, anything else video/mp4):
 *  no doc prescribes one, and TikTok validates the container by content (CC-D9)
 *  and reports a mismatch asynchronously as fail_reason
 *  file_format_check_failed, so refusing locally would invent a catalog code
 *  that does not exist. `onProgress` fires once per chunk AFTER TikTok accepts
 *  it, with a 0-based `chunkIndex` — `ToolCtx.progress` is (done, total), so
 *  the tool layer passes `(i, n) => progress(i + 1, n)`. */
export function uploadFile(ctx: ApiContext, opts: {
  filePath: string; plan: ChunkPlan; uploadUrl: string;
  contentType?: string;
  signal?: AbortSignal;
  onProgress?: (chunkIndex: number, totalChunks: number) => void;
  random?: () => number;            // backoff jitter seam (TESTING determinism rule 4)
}): Promise<void>;
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
): z.ZodObject<Shape & { account: typeof accountArg }, "strict">;
```

`defineTool` rejects at import time: a name outside lowercase-snake
`tiktok_*`, an empty title/description, a package outside the five, duplicate or
empty scopes, an input schema that accepts unknown keys (CC-G1), and
`readOnlyHint && destructiveHint`.

`src/tools/index.ts` is the manifest-in-code: the ordered `PACKAGES` array is
the ONE source consumed by (1) server registration, (2) the manifest snapshot
test, (3) README generation, (4) `server.json` generation.

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
  action?:                       // user_action
    | "login" | "open_tiktok_app" | "move_file"
    | "host_media" | "configure_server" | "wait_for_audit";
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
  reason: "char_budget" | "item_cap" | "cursor_stuck";
  returned: number;                     // items still present in the elided array
  resume_cursor?: string;               // only when the tool supplied one
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
 *  ok/error/hints/journal floor (CC-G7). Every rung is valid JSON (CC-G2) and
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
export const RESULT_JSON_SCHEMA: Readonly<Record<string, unknown>>;  // outputSchema
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
error). `zod-to-json-schema` converts `ToolSpec.input` for advertisement.

```ts
/** A configured profile as the server sees it at call time. */
export interface ProfileInfo { name: string; scopes: readonly string[] }

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
  runtime: ServerRuntime;
}

export interface McpServerHandle {
  server: Server;
  /** Recompute descriptions and tell connected clients (§ 6.3). */
  notifyToolListChanged(): Promise<void>;
}

export function createServer(opts: ServerOptions): McpServerHandle;

/** stdout carries JSON-RPC frames and nothing else (CC-G3). */
export async function connectStdio(handle: McpServerHandle): Promise<StdioServerTransport>;
```

Call-pipeline rules that are contract, not implementation detail:

- The profile comes from the **parsed** `account`, not the raw arguments — a
  schema may trim or default it.
- An unknown `account` fails locally with `unknown_account`; no request is sent.
- `TT_LOCK_PROFILE` is both the fallback profile and the only accepted one.
- The scope check runs **before** `createContext`, so a denied call never
  touches the credential store.
- `data.meta.account` is stamped with the profile actually used, and a value the
  handler already set is never overwritten.
- An unknown tool name is a protocol error (`McpError`), not an envelope.

## mcp/plan-store.ts

```ts
export interface PlanRecord {
  digest: string;       // sha256Hex(canonicalJson(fully resolved payload))
  profile: string;
  openId: string;
  tool: string;
  createdAt: number;    // clock.now()
  used: boolean;
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
 *  evicted until the cap has room. Re-storing a known id replaces it. The
 *  record is copied — the caller cannot reach in later and flip `used`. */
export function storePlan(id: string, rec: PlanRecord, options?: PlanStoreOptions): void;

export type ConsumeFailure =
  | "unknown" | "expired" | "already_used"
  | "payload_mismatch" | "account_mismatch" | "tool_mismatch";
// Surfaced to callers as exactly two codes: "plan_not_found"
// (unknown/expired/already_used) and "plan_mismatch" (the rest).

/** What the apply call claims the plan approved. */
export interface PlanExpectation {
  digest: string; profile: string; openId: string; tool: string;
}
export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

/** Everything `consumePlan` checks, WITHOUT marking the plan used. The execute
 *  pipeline verifies at step 5 but consumes at step 7 (TOOLS.md § 2.6.3), so a
 *  `possible_duplicate` refusal in between leaves the plan appliable with
 *  `force: true`. Check order: unknown → expired (drops the record) →
 *  already_used → tool → account → digest. */
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

/** Per-profile token bucket, 6 inits per minute, one token per 10 s. Integer
 *  arithmetic only — the remainder is banked in the bucket's own timestamp, a
 *  full bucket banks nothing, a backwards clock accrues nothing. */
export const PUBLISH_BUCKET_CAPACITY: 6;
export const PUBLISH_BUCKET_REFILL_MS: 10_000;
export interface RateBucketSnapshot { tokens_available: number; next_token_at?: string }
export interface RateLimitRefusal { retry_after_s: number; retry_at: string }
export type RateBucketTake =
  | { ok: true; bucket: RateBucketSnapshot }
  | { ok: false; refusal: RateLimitRefusal };

/** A preview always succeeds regardless of the bucket and just reports it. */
export function peekPublishBucket(profile: string, clock: Clock): RateBucketSnapshot;
/** Immediate refusal — the server NEVER sleeps a write call (TOOLS.md § 2.8). */
export function takePublishToken(profile: string, clock: Clock): RateBucketTake;
export function resetRateBuckets(): void;

/** The catalog texts. planFailureError maps six internal reasons onto the two
 *  codes callers see; the internal reason is deliberately absent from
 *  `details`, since a model that can tell "expired" from "already used" is
 *  tempted to retry one of them and neither is retryable. */
export function planFailureError(reason: ConsumeFailure, ttlS: number): ToolError;
export function localRateLimitedError(refusal: RateLimitRefusal): ToolError;
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

/** journal.ndjson, 0600 in a 0700 dir beside the resolved env file;
 *  O_APPEND (no env lock). Intent append is fsync'd and happens BEFORE init
 *  dispatch; rotation (settings.journalMaxBytes, one .1 generation) is
 *  checked only before intent appends. Append failure ⇒ warn + mark the tool
 *  result journal:"unavailable" — never fail the publish. */
export function appendIntent(rec: IntentRecord, opts?: JournalOptions): Promise<{ ok: boolean }>;
export function appendOutcome(rec: OutcomeRecord, opts?: JournalOptions): Promise<{ ok: boolean }>;

/** Duplicate guard (SYNTHESIS § 2.7): bounded tail of the active generation;
 *  same digest with ok or unknown (incl. send_ambiguous) outcome within
 *  10 minutes ⇒ duplicate, unless force. error/upload_failed are exempt.
 *  The whole matched attempt travels with the verdict, because
 *  `possible_duplicate` (TOOLS.md § 3.0) has to name the profile, timestamp,
 *  outcome and publish_id — none of which an attempt id carries. */
export interface DuplicateCheck {
  duplicate: boolean;
  matchedAttemptId?: string;     // set iff `duplicate`
  matched?: JournalAttempt;      // set iff `duplicate`
}
export function checkDuplicate(
  payloadDigest: string, clock: Clock, opts?: JournalOptions,
): Promise<DuplicateCheck>;

/** Merges both generations; torn tail lines are skipped and counted.
 *  Public contract v:1 is additive-only once the journal tool ships. */
export function readMerged(opts?: JournalOptions & { limit?: number }): Promise<{
  records: JournalRecord[]; skippedLines: number;
}>;
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
  public_post_id?: string;                 // only once published, public posts only
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
/** `network_ambiguous` — the post MAY exist. Never auto-retry through this. */
export function networkAmbiguousError(): ToolError;
/** `upload_interrupted` (CC-D5). The init succeeded, so the caller must be told
 *  which `publish_id` to check; recovery is a NEW attempt, never a resume. */
export function uploadInterruptedError(
  publishId: string, chunk: number, total: number, detail: string,
): ToolError;
/** `possible_duplicate`. Takes the whole matched attempt because the normative
 *  text names the profile, timestamp, outcome and publish_id. */
export function possibleDuplicateError(profile: string, matched: JournalAttempt): ToolError;

// --- hints (TOOLS.md § 5) --------------------------------------------------

export function pollHint(publishId: string, pollAfter: string): Hint;
export function stillProcessingAfterApplyHint(
  publishId: string, status: string, timeoutS: number,
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

/** Step 2 of § 2.6.3, as a result rather than a throw. */
export function takeWriteToken(ctx: ToolCtx): ToolResult<never> | undefined;
/** Mint and store the preview's token; returns what the preview must echo. */
export function mintPlan(
  ctx: ToolCtx, toolName: string, digest: string, openId: string,
): { planId: string; expiresAt: string; hint: Hint };
/** Steps 5, 6 and 7 of § 2.6.3, in the one order that is safe. */
export function runPlanGuards(
  ctx: ToolCtx, planId: string | undefined, expectation: PlanExpectation, force: boolean,
): Promise<ToolError | undefined>;

// --- dispatch (TOOLS.md § 2.6.3 steps 8–9) ---------------------------------

/** Where the bytes stand when a dispatch fails — for `upload_interrupted`. */
export interface ChunkPosition { chunk: number; total: number }

export interface DispatchOptions {
  toolName: string;
  mode: string;                  // journalled `mode` = the upstream post_mode (§ 2.6.2)
  source: IntentSource;
  title: string;                 // what the duplicate guard excerpts; "" when a tool has none
  digest: string;
  planId: string;                // "" only under TT_WRITE_MODE=apply with no token
  openId: string;
  /** The upstream half. MUST call `report` the moment an init returns a
   *  `publish_id`: that call is the whole failure classification. */
  send: (report: (publishId: string) => void) => Promise<string>;
  /** Consulted only when an `upload_interrupted` has to name its chunk. */
  position?: () => ChunkPosition;
}

/** Everything after the plan is consumed: journal intent (fsync'd) → dispatch
 *  → journal outcome. Split out because from here on a failure is no longer
 *  "nothing happened", and the record on disk is the only thing that can tell
 *  a user which. An outcome whose intent never reached the disk is not
 *  written — the reader drops such orphans anyway — and the result is marked
 *  `journal: "unavailable"` with a note hint instead of failing the publish. */
export function dispatchWrite(
  ctx: ToolCtx, opts: DispatchOptions,
): Promise<ToolResult<AppliedData>>;

/** Attach the `poll` hint, optionally after waiting for a terminal status
 *  (TOOLS.md § 2.7). An accepted post stays accepted: a poll timeout and a
 *  status read that throws are both non-errors and neither downgrades `ok` —
 *  both fall back to the exact hint an immediate return would have carried. */
export function waitIfAsked(
  ctx: ToolCtx, result: ToolResult<AppliedData>, waitForCompletion: boolean,
): Promise<ToolResult<AppliedData>>;
```

**The apply path's step order is contract, not implementation detail**
(TOOLS.md § 2.6.3): validate locally → take the local rate token (before any
network, § 2.8) → re-resolve through the preview's own code path against live
`creator_info` → recompute the payload digest → `verifyPlan` → duplicate guard →
`consumePlan` → journal the intent (fsync'd) → dispatch → journal the outcome.
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
take as "nothing was created" (CC-B4).

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
digests can differ only if the payload really did. The duplicate guard's
`title` is title **and** description joined: a carousel is frequently untitled
with all its text in the description, and excerpting only the title would make
every such post look identical to the guard.

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
  | { readonly ok: true; readonly flags: { profile?: string; offline: boolean; help: boolean } }
  | { readonly ok: false; readonly message: string };
export function renderFinding(check: Check, found: Finding): string;
export function renderSummary(tally: Tally): string;
```

Three rules bind:

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
   That is why `CliDeps` carries `platform`.

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
