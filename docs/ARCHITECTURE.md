# Architecture

TypeScript ESM MCP server, Node **`engines >= 22`** (`.nvmrc` pins **24**), built to
`build/` with `tsc`. Three runtime dependencies: `@modelcontextprotocol/sdk`, `zod`
(v3), `dotenv`. CI runs a blocking matrix of ubuntu×{22,24}, macos×24, and
**windows×24** (advisory ubuntu×26). The structure is a direct port of the proven
`servicenow-mcp-ai` architecture with TikTok-specific internals and a clean `TT_` env
prefix from day one.

## 1. Layered structure (enforced by ESLint)

```
src/
  index.ts          # entry: node-version guard (>= 22), CLI dispatch, server bootstrap
  cli/              # login.ts, doctor.ts, index.ts — subcommands dispatched before server start
  core/             # Layer 0 — imports nothing from the other layers
    errors.ts       #   TikTokError taxonomy (§ 11)
    log.ts          #   stderr-only structured JSON logger
    redact.ts       #   allowlist redaction — sits BELOW every sink (§ 10)
    json.ts         #   canonicalJson() + sha256Hex() — THE single canonicalization (§ 8)
    clock.ts        #   injectable Clock (now/sleep); every time-dependent module takes it
    settings.ts     #   zod-validated TT_ knobs, one field per CONFIGURATION.md variable
    config.ts       #   env-file store: path resolution, read, atomic profile persist (§ 7)
    env-lock.ts     #   cross-process mkdir lock around the env file (§ 7)
    http.ts         #   ttRequest / oauthRequest / putChunk, egress allowlist, retry classes (§ 6)
    oauth.ts        #   PKCE (hex challenge), code exchange, single-flight refresh (§ 7)
  api/              # Layer 1 — TikTok domain functions; may import core only
    context.ts      #   ApiContext (profile, settings, log, clock, getAccessToken)
    user.ts  video.ts  publish.ts
    upload.ts       #   planChunks() (pure decimal algorithm) + streamed chunk-PUT orchestration
  mcp/              # Layer 2 — MCP glue; may import core and api
    define.ts       #   ToolSpec contract (§ 4)
    result.ts       #   ToolResult envelope, hints, valid-JSON truncation (§ 9)
    plan-store.ts   #   plan_id mint / store / consume (§ 8)
    plan.ts         #   digest glue: payload resolution → canonicalJson → sha256Hex (§ 8)
    journal.ts      #   write-ahead journal: append, rotation, duplicate guard, reader (§ 8)
    server.ts       #   registration from the PACKAGES manifest + transport (§ 3, § 5)
    lifecycle.ts    #   credential watch → scope markers + tools/list_changed (lands after Phase 1)
  tools/            # Layer 3 — declarative ToolSpec files
    index.ts        #   PACKAGES manifest-in-code — the ONE tool-surface source (§ 5)
    auth.ts  user.ts  video.ts  publish.ts  publish-write.ts
```

Import rule **`core ← api ← mcp ← tools`**, enforced via `no-restricted-imports`:

- `core` imports nothing from the other layers.
- `api` may import `core` only.
- `mcp` may import `core` and `api`.
- `tools` may import `api` and `mcp`, **never** `core/http*` or `core/oauth*` —
  all network access flows through `api/`.
- `cli/` is entry-point code beside the layers; it consumes the same public
  contracts and obeys the same "network only through `api/`" rule.

Rationale: tool files stay declarative and reviewable; HTTP, auth, retries, and
redaction are implemented exactly once. Redaction lives in **`core/redact`** — below
every sink (stderr logs, doctor output, journal, tool results) — not in the mcp
layer, so nothing can serialize a secret before the scrubber sees it. There is no
`mcp/redact` module.

## 2. Bootstrap (`src/index.ts`)

1. **Node version guard** (`>= 22`) before any ESM import of the app graph (the
   published `bin/tiktok-mcp-ai.cjs` launcher performs the same guard in CommonJS so
   ancient Node prints a clear message instead of a parse error).
2. **CLI subcommands** dispatched before server start, each lazily imported from
   `src/cli/`:
   - `login` — interactive OAuth authorization-code + PKCE flow (see AUTH.md),
     persists tokens, exits. `--revoke` revokes tokens but **keeps the journal**;
     purging is the explicit `--purge-journal` flag.
   - `doctor` — offline + online health check: env file located, client key
     present, token validity/expiry, one `user/info` probe, granted scopes vs.
     configured packages, journal reconciliation listing. Exits non-zero on hard
     failures.
3. **Server construction**:

```ts
const server = new McpServer(
  { name: "tiktok-mcp-ai", version: pkg.version },
  { capabilities: { logging: {} } },
);
registerAllTools(server, PACKAGES);  // manifest from src/tools/index.ts
setServer(server);                   // for log mirroring to the client
await connectTransport(server);
```

4. Graceful shutdown on SIGINT/SIGTERM; `unhandledRejection`/`uncaughtException`
   handlers log to stderr and exit cleanly. **stdout is reserved for the MCP stdio
   protocol; all logging is stderr-only structured JSON.** The env file is read via
   `fs.readFile` + `dotenv.parse()` — never the side-effectful `dotenv/config`
   import — so no library can print to stdout before transport connect.

## 3. Transport (`src/mcp/server.ts`)

- Default **stdio**.
- `TT_TRANSPORT=http` starts Streamable HTTP (`StreamableHTTPServerTransport`,
  `randomUUID` session ids), binding `TT_HTTP_HOST` (default `127.0.0.1`) on
  `TT_PORT` (default 3000). **`TT_HTTP_TOKEN` is mandatory whenever
  `TT_TRANSPORT=http`** — the server refuses to start without it; the bearer is
  checked with `crypto.timingSafeEqual`. `Origin`/`Host` are validated even on
  loopback binds (DNS-rebinding defense, CC-G6); binding beyond loopback requires
  TLS termination in front or an explicit insecure flag.

## 4. Tool definition pattern (`src/mcp/define.ts`)

Tools are data. The contract (normative signatures in CONTRACTS.md § mcp/define):

```ts
export type PackageName = "auth" | "user" | "video" | "publish" | "publish-write";

export interface ToolCtx {
  api: ApiContext;
  log: Logger;
  signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
}

export interface ToolSpec<In, Out> {
  name: `tiktok_${string}`;      // v1.1 surface: 11 tools
  title: string;
  description: string;           // model-facing; includes constraints & failure modes
  package: PackageName;
  scopes: string[];              // OAuth scopes this tool needs
  annotations: {                 // ALL FOUR required on every tool —
    readOnlyHint: boolean;       // an undecided annotation is a compile error,
    destructiveHint: boolean;    // not an MCP-default surprise
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: z.ZodType<In>;          // registered as .strict(); every field .describe()d
  handler(args: In, ctx: ToolCtx): Promise<ToolResult<Out>>;
}

export function defineTool<In, Out>(spec: ToolSpec<In, Out>): ToolSpec<In, Out>;
```

The registration wrapper adds structured start/done/error logs, uniform error
mapping (`TikTokError` → readable message + upstream `error.code` + `log_id`), and
an `AsyncLocalStorage` context carrying the per-request **account profile** (§ 7).
Log fields are allowlist-only and never carry secrets; `core/redact` is the backstop.

## 5. Manifest & registration (`src/tools/index.ts` + `src/mcp/server.ts`)

The **PACKAGES manifest lives in `src/tools/index.ts`** (manifest-in-code): each
tool file exports its specs array; `index.ts` assembles the ordered manifest. The
mcp layer never imports tool files — the entry point wires them via
`registerAllTools(server, PACKAGES)`. One source, four consumers: (1) server
registration, (2) the manifest snapshot test, (3) README tool-table generation,
(4) `server.json` generation — any tool-surface change appears in diffs.

```ts
const PACKAGES = [
  { name: "auth",          tools: authSpecs },
  { name: "user",          tools: userSpecs },
  { name: "video",         tools: videoSpecs },
  { name: "publish",       tools: publishSpecs },       // reads: creator info, status, journal
  { name: "publish-write", tools: publishWriteSpecs },  // the four write tools
];
```

- Packages group by **risk class**: `publish` holds the three read tools
  (`tiktok_get_creator_info`, `tiktok_get_publish_status`, the journal read tool);
  `publish-write` holds the four write tools. Profiles: `core` =
  `auth,user,video,publish` (all reads), `all` = `core` + `publish-write`.
  Enabled packages resolve from `TT_TOOL_PACKAGES`, minus `TT_PACKAGES_DENY`;
  `TT_PACKAGES_READONLY` forces `publish-write` off (package-granular policy —
  registration is never filtered by annotation hints).
- Every input schema is registered as a **`.strict()`** zod object — unknown
  arguments are validation errors, not silently dropped (CC-G1).
- An `account` parameter (optional string, selects a token profile) is
  auto-injected into every tool unless the spec defines one.

## 6. HTTP client (`src/core/http.ts`)

Three entry points: `ttRequest<T>` (the `{data, error}` envelope decoder — an
`error.code !== "ok"` becomes a `TikTokError` regardless of HTTP status, CC-B1),
`oauthRequest<T>` (the flat OAuth shape — `error`/`error_description`/`log_id`;
the envelope decoder is never applied, CC-A12), and `putChunk` (raw chunk PUT —
non-envelope 206/201 responses).

1. **Egress allowlist** (SYNTHESIS § 2.5): the only permitted API origin is
   `https://open.tiktokapis.com` — no override env exists for data calls. An
   `upload_url` host is accepted iff it is exactly `open.tiktokapis.com`, exactly
   `open-upload.tiktokapis.com`, or matches
   `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$` (anchored regional pattern). All
   matching is dot-anchored on the full WHATWG-parsed hostname; **bare `endsWith`
   is banned**. https only, port 443 only, no userinfo, `redirect: "error"`
   (CC-B6). Widening the grammar is a spec edit, never a runtime relaxation.
   Chunk PUTs carry **no `Authorization` header** — the `upload_token` in the URL
   is the credential and a registered secret. DNS resolve-and-pin is deferred out
   of v1 (rationale: SYNTHESIS § 2.6); `core/http` exposes an injectable `lookup`
   seam so a future flip is a contained change.
2. **Auth injection** (`core/oauth.ts`): resolves the active profile's access
   token; if it expires within the skew window (`TT_TOKEN_REFRESH_SKEW_S`) a refresh
   is performed first under the § 7 protocol. A 401 or `access_token_invalid`
   triggers **exactly one** forced refresh + replay — for the `read` class only.
3. **Retry matrix** — **three classes** (CC-B7), classified by a **path
   allowlist** in `core/http.ts`, never by HTTP method alone:

| Class | Membership | 429 | 5xx / network error | Attempts |
|---|---|---|---|---|
| **read** | GET + read POSTs: `user/info`, `video/list`, `video/query`, `creator_info/query`, `status/fetch` | retry with backoff, `Retry-After` honored | retry | 3 |
| **init** | publish inits: `video/init`, `inbox/video/init`, `content/init` | **terminal** + wait guidance (CC-B8) | **never retried** — a transport failure after the request may have been sent is terminal, journaled as `send_ambiguous` (CC-B4/B5) | 1 |
| **chunk** | PUTs to the validated `upload_url` | retry | retry **per chunk** with an **identical `Content-Range`** (replay-safe by byte range, CC-D6); in-call 1 + `TT_CHUNK_RETRIES` (3) | 1 + 3 per chunk |

   Chunk-PUT specifics: 4xx is terminal; **403 = expired upload URL → no
   auto-re-init** (CC-D5 — an auto-re-init would spend the init budget and orphan
   a pending publish); **416 → resync from `uploaded_bytes`**. Backoff
   `min(500·2^n, 8000) + jitter`; `Retry-After` honored in retryable classes,
   capped at `min(30 s, remaining budget)` (CC-B3). Token-endpoint calls go
   through `oauthRequest`, are never auto-retried, and never queue behind the data
   semaphore; `invalid_grant` recovery is the § 7 lock-guarded re-read path.
4. **Concurrency**: per-host semaphore, `TT_MAX_CONCURRENT` default 4; an upload
   holds one slot for the whole transfer, not per chunk.
5. **Local rate limiting** (SYNTHESIS § 2.12): publish inits draw from a local
   token bucket, 6/min per profile with continuous refill (1 token / 10 s). An
   empty bucket **rejects locally** with `local_rate_limited` + `retry_after_s` +
   an absolute `retry_at` — zero network spent, never a sleep; the *preview* still
   succeeds and shows bucket occupancy. Read buckets (`creator_info` 20/min,
   `status` 30/min) briefly delay instead — `creator_info` waits up to
   `TT_TIMEOUT_MS`, then `local_rate_limited`. Buckets are per-profile,
   ALS-scoped, on the injected clock. The local bucket is a courtesy, not the
   enforcement point: an upstream 429 on an init remains terminal (CC-B8).
6. **Telemetry**: per-endpoint counters (calls, retries, 4xx/5xx) exposed via
   `doctor`.

## 7. Configuration, credential store & cross-process concurrency

### 7.1 Env file & profiles (`src/core/config.ts`)

- `dotenv` semantics with `override: false` — process env (from the MCP client)
  beats the file. Resolution: `TT_ENV_FILE` → `$XDG_CONFIG_HOME`/
  `~/.config/tiktok-mcp-ai/.env` on POSIX → `%LOCALAPPDATA%\tiktok-mcp-ai\.env`
  on win32 (never Roaming). Writes always target the resolved path: atomic
  temp-file (0600, `O_EXCL`) + fsync + rename, comment- and CRLF-preserving
  (CC-F1), **read-merge-write** so concurrent edits to other profiles/keys
  survive.
- **Platform semantics** (SYNTHESIS § 2.1): `fs.chmod(path, 0o600)` is called
  **unconditionally on all platforms** (a harmless no-op on win32); the mode is
  *asserted* only when `process.platform !== "win32"`. Directory `0o700` on
  POSIX; inherited per-user profile ACLs on win32. `icacls` is **never** spawned
  automatically — doctor prints the profile-ACL info line and the optional
  `icacls` command as remediation text only. A rename onto an open handle
  (EPERM/EBUSY) is retried ×3 (50/100/200 ms), then the write **degrades to the
  in-memory token + a warning** — a persist failure never loses a valid token
  (CC-H3). The Windows CI leg is blocking from the first CI landing.
- **App credentials**: `TT_CLIENT_KEY`, `TT_CLIENT_SECRET` (one TikTok app per
  server instance).
- **Account profiles** (multi-account): the default profile lives in
  `TT_ACCESS_TOKEN` / `TT_REFRESH_TOKEN` / `TT_OPEN_ID` / `TT_SCOPES` /
  `TT_TOKEN_EXPIRES_AT`; additional accounts under
  `TT_PROFILE_<NAME>_ACCESS_TOKEN` etc. `TT_ACTIVE_PROFILE` selects the default;
  the auto-injected `account` tool argument selects per request via
  `AsyncLocalStorage`.
- In-memory credential snapshot swapped atomically (single assignment) so a torn
  read across refresh is impossible. There is **one snapshot-reload path** with
  three triggers — env-file mtime change, a `tiktok_get_auth_status` call, any
  auth-shaped error — whose subscribers adopt rotated tokens and re-evaluate
  scope markers (emitting `tools/list_changed`). One mechanism serves both
  rotation pickup and marker freshness.
- All numeric/behavioral knobs live in `core/settings.ts`, zod-validated at
  startup with all problems aggregated into one error (CC-F6); the variable
  table in CONFIGURATION.md is the authoritative list.

### 7.2 Env-file lock (`src/core/env-lock.ts`)

Cross-process mutex around the env file (SYNTHESIS § 2.2). Every env-file writer
— `login`, refresh, doctor — goes through `withEnvLock` (CC-A2, CC-F5).

- **Acquisition**: `fs.mkdir("<envfile>.lock")` — atomic on every platform and
  network filesystem. A JSON file inside (`{pid, hostname, createdAt}`) is
  **diagnostic only**; liveness is judged by **mtime, never PID** (PID checks
  fail across containers/hosts and on PID reuse).
- **Heartbeat**: while held, the holder touches the lock dir's mtime every
  `TT_ENV_LOCK_HEARTBEAT_MS` (2000). This is what makes it legal to hold the
  lock across a token-refresh network call: staleness is decoupled from
  critical-section length.
- **Staleness**: `now − mtime > TT_ENV_LOCK_STALE_MS` (15000) ⇒ the holder is
  presumed dead — remove the lock dir, re-acquire, log a warning.
- **Contention**: wait with 50–150 ms jitter up to `TT_ENV_LOCK_WAIT_MS`
  (30000). On timeout, **re-read the env file once** — if a rotated token
  appeared (the other process finished), adopt it and proceed; only otherwise
  surface `env_file_busy`.
- **Release**: delete the lock dir. The **journal does not take this lock** —
  append-only `O_APPEND` writes need none (§ 8.3).

### 7.3 Refresh protocol (under the lock)

The lock **scope covers the full refresh critical section** — not just the file
mutation — because TikTok rotates refresh tokens on use and the rotation grace
window is unknown (probe P-3): two concurrent refreshes with the same refresh
token must be assumed to brick one of them. All steps run inside the per-profile
in-process single-flight mutex, then `withEnvLock`:

1. **Re-read** the env file. If its refresh token differs from the in-memory
   one, another process rotated: adopt the file's tokens (atomic snapshot swap).
   If the adopted access token is still fresh, return it — no network at all.
2. Otherwise call the token endpoint **while holding the lock** (heartbeat
   running).
3. On success: adopt in memory first, then persist via the § 7.1 atomic
   read-merge-write. The rotated refresh token is persisted **before** the new
   access token is used for any request (CC-A1). A lock or persist failure is a
   logged warning + doctor finding — it **never discards a valid in-memory
   token**, the session keeps working.
4. On `invalid_grant`: **re-read the env file once more under the lock** — if it
   now holds a different refresh token, a sibling process won a race predating
   our acquisition; adopt and retry once. Only if the file token matches the
   failed one is the profile declared re-login-required.

## 8. Write safety (`src/mcp/plan-store.ts`, `src/mcp/plan.ts`, `src/mcp/journal.ts`)

Publish tools are **plan-then-execute**. There is no `apply` boolean: absence of
`plan_id` = preview, presence = execute — the two illegal states are
unrepresentable (rationale: SYNTHESIS § 2.8).

### 8.1 Plan (preview) step

The handler runs all *read* steps for real — the conditional `creator_info`
pre-flight (skipped for draft tools, whose scope does not grant it), media
validation (file exists, size/duration/type checks, `TT_MEDIA_ROOT` confinement,
URL-domain sanity) — and returns a structured **preview**: creator
nickname/avatar, resolved privacy level, all flags, chunk plan for uploads, the
exact upstream request that would be sent, and a fresh `plan_id`. No init call is
made. When `privacy_level` is missing on a direct-post tool, the result is
`mode: "plan_incomplete"` and **no token is minted**.

- **Token**: `plan_id` = `"plan_"` + 32 lowercase hex chars (16
  `crypto.randomBytes`). Random, **never payload-derived** — a derivable token
  could be fabricated by a prompt-injected model that knows the scheme.
- **Digest**: SHA-256 over the **fully resolved upstream payload** — `post_info`
  + source info (canonical absolute file path, file size, chunk-plan summary, or
  the validated `video_url`/photo list) + resolved `post_mode` — serialized by
  the single exported `canonicalJson()` in `core/json.ts` (recursively sorted
  keys, no whitespace, UTF-8, absent ≡ undefined ≡ omitted). The payload
  includes every creator-derived coercion (resolved privacy level, forced
  interaction toggles, duration constraints), so creator-state drift between
  plan and execute re-resolves to a different payload and fails the digest check
  naturally. Control fields (`plan_id`, `force`, `wait_for_completion`) are not
  payload and **never enter the digest**. The duplicate guard's title hash
  reuses the same `canonicalJson()` — a second canonicalization must not exist.
- **Store**: in-process `Map<plan_id, {digest, profile, open_id, tool,
  created_at, used}>` — **never persisted**; a server restart invalidating all
  plans is the *designed* recovery (the preview the human saw is gone —
  re-plan). Cap `TT_PLAN_MAX_OUTSTANDING` (32), oldest-evicted, lazy eviction on
  access + sweep on plan creation; TTL `TT_PLAN_TTL_S` (600).

### 8.2 Execute step — normative pipeline order

When `plan_id` is present, the order is **normative**:

1. **Re-resolve the payload through the same code path as the preview** —
   re-stat the file (size/mtime/dev/ino must match, CC-D3/D4), re-run the
   `creator_info` pre-flight on direct-post tools.
2. Compute **digest′** over the re-resolved payload.
3. **Verify**: plan exists ∧ not used ∧ not expired ∧ tool match ∧ digest match
   (`timingSafeEqual`) ∧ open_id match. The internal failure enum is
   `{unknown, expired, already_used, payload_mismatch, account_mismatch,
   tool_mismatch}`, surfaced as **exactly two** error codes: `plan_not_found`
   (unknown/expired/already_used) and `plan_mismatch`
   (payload/account/tool mismatch).
4. **Duplicate guard** (§ 8.4) — unless `force: true`. A `possible_duplicate`
   rejection happens *before* consumption, so the same `plan_id` may be
   re-executed with `force` within its TTL after the user verifies.
5. **Consume atomically** (mark used) — **before** the init is dispatched, so an
   MCP-client retry of the execute call fails with `plan_not_found` instead of
   double-posting (CC-E7). A consumed plan is never revived; a failed execute
   always requires a fresh preview.
6. **Journal intent append**, fsync'd (§ 8.3).
7. **Init dispatch** → upload (if FILE_UPLOAD) → the result returns
   `publish_id` immediately with a poll hint (`wait_for_completion` defaults to
   `false` on write tools; the status tool does the bounded wait —
   SYNTHESIS § 2.3).

### 8.3 Write-ahead journal (`src/mcp/journal.ts`)

Append-only two-record NDJSON (SYNTHESIS § 2.7) — `journal.ndjson`, 0600 in a
0700 dir **beside the resolved env file**; appends are one `write()` of one
complete line on an `O_APPEND` fd. The journal **does not take the env lock**.

- **Intent record** — fsync'd **before** the init request, appended at the same
  instant the plan is consumed: `{v:1, type:"intent", attempt_id (ULID), ts,
  tool, profile, open_id, plan_id, payload_digest, title_excerpt (≤48 chars),
  source, mode}`.
- **Outcome record** — appended on response or terminal upload failure, **no
  fsync**: `{v:1, type:"outcome", attempt_id, ts, result, publish_id?,
  error_code?, fail_reason?, chunk?}`.
- **Result vocabulary** (persisted): `ok` (init accepted, `publish_id`
  recorded) · `error` (clean failure; a known-unsent transport error uses
  `error_code: "network_unsent"`, CC-B4's before-write case) · `upload_failed`
  (init ok, chunk upload aborted; carries `publish_id` + chunk index) ·
  `send_ambiguous` (transport failure after the request may have been sent).
  **`unknown` is never written** — it is derived at read time as
  intent-without-outcome (the truthful crash state, CC-E10). The journal read
  tool presents `send_ambiguous` as `unknown` (same operational meaning: the
  post MAY exist — verify before retrying); doctor keeps the distinction.
- **Lifecycle**: first line after creation/rotation is
  `{v:1, type:"header", created_by:"tiktok-mcp-ai@X.Y.Z"}`. Rotation at
  `TT_JOURNAL_MAX_BYTES` (5 242 880) is checked **only immediately before an
  intent append** (never between an intent and its outcome from the same
  process); one `.1` generation kept; readers merge both. Torn tail lines are
  skipped and counted; unknown `v` is ignored and counted.
- **Failure semantics**: an append failure is a **warning** — the tool result
  carries `journal: "unavailable"`, and the publish proceeds; the journal is
  never a publish failure.
- The record shape is a **public contract** from the moment the journal read
  tool ships: additive-only under `v:1`, version bump only for incompatible
  changes.

### 8.4 Duplicate guard

Reads a **bounded tail of the active generation only**: a matching payload
digest with an `ok` or `unknown` (incl. `send_ambiguous`) outcome within the
last **10 minutes** trips `possible_duplicate` unless `force: true`. `error` and
`upload_failed` outcomes are exempt — a cleanly failed attempt must not block
the retry. Unresolved intents also surface as a server-authored warning in plan
previews (warn, never hard-block — a local file cannot prove upstream state).

### 8.5 Write modes

`TT_WRITE_MODE`:

- **`plan`** (default) — the § 8.1/8.2 contract above.
- **`apply`** — `plan_id` becomes optional; documented verbatim as
  "trusted automation only: this mode has no injection resistance".
- **`deny`** — the `publish-write` package is not registered.

## 9. Pagination & result shaping (`src/mcp/result.ts`)

- Every tool returns the `ToolResult` envelope: `{ok, data?, error?, hints?,
  journal?}` — hints use the closed six-type vocabulary with absolute UTC
  timestamps and no upstream text interpolation (server-authored only; the
  member list is normative in TOOLS.md).
- `tiktok_list_videos` returns one page by default (`cursor`/`has_more` passed
  through). `fetch_all: true` pages up to `TT_FETCH_ALL_CAP` (default 200 items)
  and always surfaces `truncated: true` when the cap stopped it — a capped read
  is never presented as complete. The cursor loop aborts when the cursor does
  not advance.
- Results serialize as **compact JSON** (pretty only with `TT_PRETTY_JSON=1`);
  a character budget (default 25 000) truncates oversized payloads by
  item-level elision to **valid JSON** with an explicit `truncated` marker
  (CC-G2); truncation never removes `ok`, `error`, or `hints` (CC-G7).
- CDN URLs (avatars, covers) are passed through with a note in tool descriptions
  that they expire in ~6 h.

## 10. Redaction & logging (`src/core/redact.ts`, `src/core/log.ts`)

- Structured JSON logs to **stderr only** (CC-G3); mirrored to the MCP client
  via the `logging` capability at `TT_LOG_LEVEL`.
- Redaction is a **core primitive below every sink** — logger, error
  construction, doctor output, journal appends, and tool results all pass
  through `core/redact` before serialization; `mcp/result` redacts **before**
  truncation. Contract: `redactValue()` (allowlist-based deep redaction —
  unknown keys are redacted by default), `registerSecret()` (exact values:
  access/refresh tokens, client secret, `code`, `code_verifier`, `state`, and
  `upload_token` — a bearer secret carried in the `upload_url` query string),
  `redactText()` (scrubs every registered secret out of free text, including
  error messages and echoed request dumps in plan previews — `Authorization`
  headers render as `Bearer ***`).
- `logFields` are allowlist-only by policy; redaction is the backstop, not the
  policy.
- `open_id` is treated as pseudonymous, logged in truncated form (`abc…xyz`).

## 11. Error taxonomy (`src/core/errors.ts`)

Single `TikTokError` with `kind` (`config` | `auth` | `api` | `network` |
`validation` | `policy` | `internal`), a stable machine `code` (e.g.
`local_rate_limited`, `plan_not_found`, `plan_mismatch`, `possible_duplicate`,
`env_file_busy`, `network_unsent` — catalog + normative texts in TOOLS.md,
substring-tested), optional upstream `apiCode`/`logId`, a `retryable` flag, and
optional `remediation`. The mapping preserves all fields so the model can
distinguish: invalid token (re-login) vs. missing scope (re-consent) vs. rate
limit (wait) vs. audit restriction (explain to user) vs. validation (fix
arguments). Messages are written for the model: state the cause, then the
recovery action.
