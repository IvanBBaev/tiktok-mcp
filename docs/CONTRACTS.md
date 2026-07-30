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
}

/** Cross-process mutex around the env file (SYNTHESIS § 2.2):
 *  fs.mkdir("<envfile>.lock") acquisition (atomic on every platform/FS);
 *  a JSON {pid,hostname,createdAt} file inside is diagnostic only —
 *  liveness is mtime-only. Timeout ⇒ TikTokError code "env_file_busy".
 *  Caller obligation (oauth): on timeout re-read the env once and adopt a
 *  rotated token before surfacing the error. The journal does NOT use this
 *  lock (O_APPEND). */
export function withEnvLock<T>(
  envFilePath: string, fn: () => Promise<T>, opts?: EnvLockOptions,
): Promise<T>;
```

## core/http.ts

```ts
export type RetryClass = "read" | "init" | "chunk";
// read:  retry 429/5xx/network with backoff + Retry-After (CC-B3)
// init:  NEVER retried (CC-B4/B5); upstream 429 on init is terminal (CC-B8)
// chunk: in-call 1 + settings.chunkRetries, identical Content-Range (CC-B7)

export type LookupFn = typeof import("node:dns").lookup;

export interface TtRequestOptions {
  method: "GET" | "POST";
  url: string;                    // must pass assertAllowedUrl(url, "api")
  body?: unknown;
  retryClass: RetryClass;
  bearer?: string;                // absent on OAuth + upload calls
  timeoutMs?: number;
  signal?: AbortSignal;
  clock?: Clock;
  lookup?: LookupFn;              // injectable DNS seam (SYNTHESIS § 2.6)
}

/** {data,error} envelope decoder; error.code !== "ok" ⇒ TikTokError kind:"api"
 *  (CC-B1); non-JSON tolerated (CC-B2); redirect:"error" (CC-B6). */
export function ttRequest<T>(opts: TtRequestOptions): Promise<T>;

/** Flat OAuth-shape decoder (error/error_description/log_id) — the envelope
 *  decoder must NOT be applied (CC-A12). */
export function oauthRequest<T>(opts: Omit<TtRequestOptions, "retryClass">): Promise<T>;

/** Egress allowlist (SYNTHESIS § 2.5): host accepted iff exactly
 *  open.tiktokapis.com, exactly open-upload.tiktokapis.com, or matches
 *  /^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$/. WHATWG-parsed, https-only,
 *  no userinfo, port 443 only. Bare endsWith is banned. Widening = spec edit. */
export function assertAllowedUrl(url: string, kind: "api" | "upload"): URL;

export interface ChunkPutResult { status: number; uploadedBytes?: number }

/** No Authorization header ever (upload_token in URL is the credential and a
 *  registered secret). 4xx terminal; 403 = expired URL; 416 ⇒ caller resyncs
 *  from uploadedBytes. */
export function putChunk(opts: {
  uploadUrl: string; contentRange: string; contentType: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
  timeoutMs: number; signal?: AbortSignal;
}): Promise<ChunkPutResult>;
```

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

export function buildAuthUrl(opts: {
  clientKey: string; scopes: string[]; redirectUri: string;
}): { url: string; state: string; verifier: string };

export function exchangeCode(opts: {
  clientKey: string; clientSecret: string; code: string;
  verifier: string; redirectUri: string;
}): Promise<TokenSet>;

/** Single-flight per profile in-process + withEnvLock across processes.
 *  Rotated refresh token persisted BEFORE first use of the new access token
 *  (CC-A1/A2). invalid_grant: re-read env once under the lock, adopt + retry
 *  once, else terminal re-login error (SYNTHESIS § 2.2). */
export function ensureFreshAccessToken(
  profile: string, deps: { clock?: Clock },
): Promise<string>;

/** Revocation KEEPS the journal (SYNTHESIS § 2.10); purge is a separate,
 *  explicit CLI flag. */
export function revokeToken(profile: string): Promise<void>;
```

## api/* (shared context)

```ts
// api/context.ts
export interface ApiContext {
  profile: string;
  settings: Settings;
  log: Logger;
  clock: Clock;
  getAccessToken(): Promise<string>;   // wraps ensureFreshAccessToken
}
```

```ts
// api/user.ts
export function getUserInfo(ctx: ApiContext, fields: string[]): Promise<UserInfo>;

// api/video.ts
export function listVideos(
  ctx: ApiContext, opts: { cursor?: string; maxCount?: number },
): Promise<{ videos: Video[]; cursor: string; hasMore: boolean }>;
export function queryVideos(
  ctx: ApiContext, ids: string[],                       // >20 rejected locally (CC-C6)
): Promise<{ videos: Video[]; missingIds: string[] }>;  // CC-C7

// api/publish.ts
export function getCreatorInfo(ctx: ApiContext): Promise<CreatorInfo>;
export function initVideoPost(ctx: ApiContext, req: VideoPostInit):
  Promise<{ publishId: string; uploadUrl?: string }>;
export function initDraftUpload(ctx: ApiContext, req: DraftUploadInit):
  Promise<{ publishId: string; uploadUrl?: string }>;
export function initPhotoPost(ctx: ApiContext, req: PhotoPostInit):
  Promise<{ publishId: string }>;
export function getPublishStatus(ctx: ApiContext, publishId: string):
  Promise<PublishStatus>;
```

```ts
// api/upload.ts
export interface ChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  chunks: Array<{ index: number; start: number; end: number; size: number }>;
}

/** PURE. Decimal algorithm (SYNTHESIS § 2.4, normative in TIKTOK-API.md):
 *  MIN_WHOLE=5_000_000, CHUNK_SIZE=64_000_000; <5 MB ⇒ one whole chunk;
 *  else chunk_size=min(size, 64_000_000), count=floor(size/chunk_size),
 *  final chunk absorbs the remainder (≤127_999_999). 1≤count≤1000; 4 GiB cap
 *  enforced by the caller. Vectors V1–V8 are the shared test fixture. */
export function planChunks(fileSize: number): ChunkPlan;

export function uploadFile(ctx: ApiContext, opts: {
  filePath: string; plan: ChunkPlan; uploadUrl: string;
  signal?: AbortSignal;
  onProgress?: (chunkIndex: number, totalChunks: number) => void;
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
  scopes: string[];
  annotations: {                 // ALL FOUR required on every tool
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: z.ZodType<In>;          // .strict() (CC-G1)
  handler(args: In, ctx: ToolCtx): Promise<ToolResult<Out>>;
}

export function defineTool<In, Out>(spec: ToolSpec<In, Out>): ToolSpec<In, Out>;
```

`src/tools/index.ts` is the manifest-in-code: the ordered `PACKAGES` array is
the ONE source consumed by (1) server registration, (2) the manifest snapshot
test, (3) README generation, (4) `server.json` generation.

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

/** Char-budget truncation that always yields VALID JSON (item-level elision +
 *  `truncated` marker, CC-G2); never drops ok/error/hints (CC-G7). */
export function toToolContent(result: ToolResult<unknown>, budgetChars: number): string;
```

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
export function mintPlanId(): string;

/** In-process Map only — NEVER persisted; restart ⇒ re-plan is the designed
 *  recovery. Cap settings.planMaxOutstanding (oldest evicted); TTL
 *  settings.planTtlS. */
export function storePlan(id: string, rec: PlanRecord): void;

export type ConsumeFailure =
  | "unknown" | "expired" | "already_used"
  | "payload_mismatch" | "account_mismatch" | "tool_mismatch";
// Surfaced to callers as exactly two codes: "plan_not_found"
// (unknown/expired/already_used) and "plan_mismatch" (the rest).

/** timingSafeEqual over digests. Consumption is atomic and happens BEFORE
 *  the journal intent append and init dispatch (SYNTHESIS § 2.8). */
export function consumePlan(
  id: string,
  expect: { digest: string; profile: string; openId: string; tool: string },
  clock: Clock,
): { ok: true } | { ok: false; reason: ConsumeFailure };
```

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

/** journal.ndjson, 0600 in a 0700 dir beside the resolved env file;
 *  O_APPEND (no env lock). Intent append is fsync'd and happens BEFORE init
 *  dispatch; rotation (settings.journalMaxBytes, one .1 generation) is
 *  checked only before intent appends. Append failure ⇒ warn + mark the tool
 *  result journal:"unavailable" — never fail the publish. */
export function appendIntent(rec: IntentRecord): Promise<{ ok: boolean }>;
export function appendOutcome(rec: OutcomeRecord): Promise<{ ok: boolean }>;

/** Duplicate guard (SYNTHESIS § 2.7): bounded tail of the active generation;
 *  same digest with ok or unknown (incl. send_ambiguous) outcome within
 *  10 minutes ⇒ duplicate, unless force. error/upload_failed are exempt. */
export function checkDuplicate(
  payloadDigest: string, clock: Clock,
): Promise<{ duplicate: boolean; matchedAttemptId?: string }>;

/** Merges both generations; torn tail lines are skipped and counted.
 *  Public contract v:1 is additive-only once the journal tool ships. */
export function readMerged(opts?: { limit?: number }): Promise<{
  records: JournalRecord[]; skippedLines: number;
}>;
```

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
| 2026-07-30 | `core/settings`: added `settingVarName` and `knownSettingVars` (consumed by `doctor` and by the CONFIGURATION.md drift test) and documented that a secret is reported as `<redacted>`. `TT_HTTP_TOKEN` gained a shape — ≥16 chars of printable ASCII, no spaces: it was `z.string()`, which accepts everything, so the `<redacted>` branch was unreachable and a 1-char token failed at the first request instead of at startup. `docs/CONFIGURATION.md` updated in the same change (raised by TB-7) | integrator (Wave-B approved deviation) |
