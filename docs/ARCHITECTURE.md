# Architecture

TypeScript ESM MCP server, Node **`engines >= 22`** (`.nvmrc` pins **24**), built to
`build/` with `tsc`. Two runtime dependencies: `@modelcontextprotocol/sdk` and `zod`
(v4, whose `z.toJSONSchema` produces the advertised input schemas). CI runs a blocking matrix of ubuntu×{22,24}, macos×24, and
**windows×24** (advisory ubuntu×26). The structure is a direct port of the proven
`servicenow-mcp-ai` architecture with TikTok-specific internals and a clean `TT_` env
prefix from day one.

## 1. Layered structure (enforced by ESLint)

```
src/
  index.ts          # entry: node-version guard (>= 22), CLI dispatch, server bootstrap
  cli/              # login.ts, doctor.ts, index.ts — subcommands dispatched before server start;
                    #   prompt.ts is the interactive-prompt seam both commands share
  core/             # Layer 0 — imports nothing from the other layers
    errors.ts       #   TikTokError taxonomy (§ 11)
    log.ts          #   stderr-only structured JSON logger
    redact.ts       #   allowlist redaction — sits BELOW every sink (§ 10)
    json.ts         #   canonicalJson() + sha256Hex() — THE single canonicalization (§ 8)
    clock.ts        #   injectable Clock (now/sleep); every time-dependent module takes it
    net.ts          #   boundPortOf(): the port a bound Server actually got — shared by both listeners
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
    prompts.ts      #   PromptSpec contract: definePrompt / describePrompt / getPrompt (§ 5.1)
    resources.ts    #   ResourceSpec contract: a read tool at a tiktok:// URI (§ 5.1)
    completions.ts  #   CompletionSource + complete(): the completion/complete sources (§ 5.1)
    lifecycle.ts    #   credential watch → scope markers + tools/ + resources/list_changed
  tools/            # Layer 3 — declarative ToolSpec files
    index.ts        #   PACKAGES manifest-in-code — the ONE tool-surface source (§ 5)
    auth.ts  user.ts  video.ts  publish.ts  publish-write.ts
    prompts.ts      #   PROMPTS manifest — the three guided write flows (§ 5.1)
    resources.ts    #   RESOURCES manifest — six read snapshots at tiktok:// URIs, one a template (§ 5.1)
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

4. Graceful shutdown on SIGINT/SIGTERM, and on stdio also when the client
   closes stdin (the MCP stdio disconnect); a signal that lands while the
   transport is still starting tears it down once it is up instead of leaving
   it running. On stdio a signal first waits up to 10 s for the calls in
   flight to answer (or be cancelled), like the HTTP transport's drain —
   closing the server aborts every handler, and a publish cut mid-upload is
   an ambiguous attempt. Once that drain starts, a new request is refused
   with JSON-RPC `-32000` `Service Unavailable: the server is shutting down`
   (the stdio counterpart of HTTP's `503`) instead of started. stdin EOF
   closes at once, since nobody is left to read an answer — before the signal
   it skips the drain, and during it it ends the drain there and then. An `unhandledRejection` is
   logged to stderr and sets `process.exitCode = 1`, and the process keeps
   serving; an `uncaughtException` is logged, sets `process.exitCode = 1` and
   runs the same shutdown as `SIGINT`/`SIGTERM`. **stdout is reserved for the MCP stdio
   protocol; all logging is stderr-only structured JSON.** The env file is read via
   `fs.readFile` + `core/config`'s own parser — never a side-effectful
   `dotenv/config` import — so no library can print to stdout before transport connect.

## 3. Transport (`src/mcp/server.ts`)

- One low-level `Server` carries the tool, prompt, resource and completion
  handlers (`tools/list`, `tools/call`, `prompts/list`, `prompts/get`,
  `resources/list`, `resources/templates/list`, `resources/read`,
  `completion/complete`) and advertises `{ tools: { listChanged }, prompts: {},
  resources: { listChanged }, completions: {}, logging }`.
- Default **stdio**. `connectStdio` returns a `StdioSession` whose `drain`
  counts JSON-RPC requests from arrival to answer (`trackStdioCalls`, wrapped
  around the transport's `onmessage`/`send` after `connect`). The count is per
  request id, so a client that reuses an id still in flight cannot end the
  drain under the second call with the first answer; a
  `notifications/cancelled` settles every request under its id. On
  SIGINT/SIGTERM the shutdown awaits the drain for up to 10 s
  (`STDIO_DRAIN_MS`) before `server.close()`; from the moment it starts, every
  new request is answered `-32000` `Service Unavailable: the server is
  shutting down` rather than run. stdin EOF (the client is gone) aborts the
  drain's `signal`: before the drain it is skipped, during it it ends at once
  (§ 2 step 4).
- `TT_TRANSPORT=http` starts Streamable HTTP (`StreamableHTTPServerTransport`,
  `randomUUID` session ids), binding `TT_HTTP_HOST` (default `127.0.0.1`) on
  `TT_PORT` (default 3000). **`TT_HTTP_TOKEN` is mandatory whenever
  `TT_TRANSPORT=http`** — the server refuses to start without it; the bearer is
  checked with `crypto.timingSafeEqual`. `Origin`/`Host` are validated even on
  loopback binds (DNS-rebinding defense, CC-G6); binding beyond loopback requires
  TLS termination in front or an explicit insecure flag. The optional
  `TT_HTTP_ALLOWED_HOSTS` list (`OriginPolicy.allowedHosts`) additionally
  refuses a `Host`, or an `Origin` host, it does not name — what stops
  rebinding past loopback, where the bind alone cannot say which names are
  ours. Both sides are compared in the WHATWG URL canonical form
  (`core/settings` `canonicalHostName` for the entries, `mcp/http`
  `parseAuthority` for `Host`; zone ids refused in the list). `src/index.ts` and
  `doctor` warn when `TT_HTTP_INSECURE=1` runs off loopback, and again when it
  runs there without the allowlist; on a loopback bind neither warns.
- Each HTTP session gets its own `McpServerHandle`. When a session's transport
  closes — `DELETE`, shutdown, or a non-`initialize` POST that never became a
  session — `releaseHandle` drops that handle from the credential-watch set
  (§ 7.1), so the set holds live sessions only. Once shutdown begins, every
  new request, including an `initialize` that raced it, gets `503` / JSON-RPC
  `-32000` `Service Unavailable: the server is shutting down`. Shutdown then
  drains: in-flight non-`GET` requests (`POST`, `DELETE`) and every JSON-RPC
  request whose handler has not answered yet (`trackCalls`, wrapped around the
  transport's `onmessage`/`send` after `connect`) get up to 10 s
  (`DEFAULT_DRAIN_MS`) to finish — a request accepted before the shutdown may
  complete during it, and a client that hung up mid tool call no longer lets
  shutdown abort its running handler. A `notifications/cancelled` for the id,
  or the transport closing, settles it; such a cancel for an existing session
  is still delivered during the drain (the one request exempt from the `503`),
  so it can end the drain early. A `POST` whose body completes after the drain
  began gets the same `503`, not `404` `Session not found`. `GET` SSE streams, which have no end,
  are not waited for. On timeout a warning is logged and what is still in
  flight is aborted; then the sessions are closed and the server is closed. A
  session whose `initialize` completes after the teardown emptied the map is
  closed at once rather than registered (no leak), and a `connect` failure
  releases the handle itself, since no `onclose` will run. `close()` is
  idempotent and returns the same promise.
- Fixed transport bounds: 4 MiB request bodies (`413`), `400` / `-32700` for
  unparsable JSON, 128 live sessions (`503` `too many open sessions`; an `initialize` still
  opening already holds its slot, so concurrent ones cannot overshoot), and a
  lazy 30-minute idle close run when the next session opens (no timer); a
  session with a request in flight, an open stream or an unanswered JSON-RPC
  call is never idle. A `Host` whose port is not a decimal 1–65535 is refused
  `403` by the Origin/Host gate, not a bare SDK `400`.

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
the per-request **account profile** (§ 7), resolved from the tool's own `account`
argument and handed to the handler inside that call's context — an explicit
parameter, never ambient state.
Log fields are allowlist-only and never carry secrets; `core/redact` is the backstop.

## 5. Manifest & registration (`src/tools/index.ts` + `src/mcp/server.ts`)

The **PACKAGES manifest lives in `src/tools/index.ts`** (manifest-in-code): each
tool file exports its specs array; `index.ts` assembles the ordered manifest. The
mcp layer never imports tool files — the entry point wires them via
`registerAllTools(server, PACKAGES)`. One source, four consumers: (1) server
registration, (2) the manifest snapshot test, (3) README tool-table generation,
(4) the `server.json` sync check (its "N tools" claim; the file itself is
hand-curated, never generated) — any tool-surface change appears in diffs.

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

### 5.1 Prompts, resources and completion (`src/mcp/prompts.ts`, `src/mcp/resources.ts`, `src/mcp/completions.ts`)

The same manifest-in-code split, one layer up from tools (TOOLS.md § 7):
`mcp/prompts.ts`, `mcp/resources.ts` and `mcp/completions.ts` are the
**mechanism** (spec contracts, `define*` validation at module load, `describe*`
for the list requests, URI parsing, envelope → `contents`, completion sources),
`tools/prompts.ts` and `tools/resources.ts` are the **data** (`PROMPTS`,
`RESOURCES`, and the completion source an argument declares), and `src/index.ts`
hands both manifests to `createServer` next to `PACKAGES`. None of the three
adds surface of its own:

- A **prompt** is a pure `render(args) → PromptMessage[]` gated with the package
  of the tools it steers to. Its arguments are validated at the protocol layer
  (unknown name, missing required ⇒ `McpError` `InvalidParams`) — `prompts/get`
  has no envelope to answer with, so CC-G1's stance lands as a protocol error.
- A **resource** is a read-only `ToolSpec` bound to a `tiktok://` URI with fixed
  arguments; `defineResource` refuses a tool without `readOnlyHint` and an
  `account` in the fixed arguments (the profile rides in `?account=`, which is
  the only query key). A `{name}` path segment is the one other variable: a
  tool argument the read cannot default (`tiktok://publish/{publish_id}/status`),
  which makes the spec a *template* — listed by `resources/templates/list`
  only, matched by `matchResource` (concrete equality first, then the
  templates, manifest order; one non-empty percent-decoded segment per
  parameter) and bound into the arguments. `resources/read` is `callTool` on
  the bound tool — one pipeline (§ 2.2 account resolution, scope check,
  redaction, truncation) — followed by `resourceContents`, which mirrors the
  envelope as one `application/json` text content under the URI as
  requested. `ok: false` is still a read; only a URI no spec matches, or a
  malformed one, is a protocol error.
- **Argument completion** (TOOLS.md § 7.3) offers values for the arguments of
  both, and adds no surface either. `mcp/completions.ts` holds the
  `CompletionSource` union — `profiles`, `values`, `publish_ids` — the
  structural `CompletionRuntime` it resolves against (`settings`, `log`,
  `profiles()`), and the single `complete(source, runtime, request)`: a
  case-insensitive prefix match kept in the source's own order, cut at
  `COMPLETION_MAX` (100) with `total` still counting every match. Which source
  an argument has is **data** — `PromptArgumentSpec.completion`,
  `ResourceSpec.completions` — validated by `definePrompt` / `defineResource` at
  module load through `completionSourceProblem`, so `tools/prompts.ts` declares
  `{ kind: 'values', values: PRIVACY_LEVELS }` for `privacy_level` and
  `tools/resources.ts` declares `{ kind: 'publish_ids' }` for the status
  template's `publish_id`. `account` is the one variable the server owns on the
  resource side: `defineResource` *refuses* a spec that names it, because
  `resourceCompletion` answers the `{?account}` variable of **every** template
  from the profiles; a prompt's `account` argument declares that same
  `{ kind: 'profiles' }` source for itself. `server.ts` resolves the ref with
  `promptCompletion` for `ref/prompt`, and with `matchResourceRef` — the
  concrete `spec.uri` or the `{?account}` template `describeResourceTemplate`
  advertises — plus `resourceCompletion` for `ref/resource`; an unmatched ref is
  the same `-32602` as an unknown prompt or resource, while an argument with no
  source completes to an empty list rather than an error. Every source is local:
  the credential store, a frozen vocabulary, and the journal read through
  `journalOptionsFor` (§ 8.3) — the very wiring the publish tools append with,
  so the ids offered and the attempts recorded can never come from different
  files. The journal fold goes through `foldedAttemptsCached`, reused while a
  `stat` signature of both generations (size, mtime, inode) is unchanged, so a
  keystroke costs two `stat` calls rather than a re-read. Nothing here calls TikTok, which is what makes a completion safe at
  keystroke rate. Layering holds because `mcp/completions.ts` imports `core/`
  types and `mcp/journal.ts` only, leaving `mcp/prompts.ts` and
  `mcp/resources.ts` free to take the source type without a cycle.
- Both lists follow the tool packages, so `TT_TOOL_PACKAGES` and the deny /
  read-only knobs need no second configuration; the credential watch (§ 7.1)
  emits `resources/list_changed` together with `tools/list_changed` because a
  resource is exactly as available as its tool. A completion ref is matched
  against those same enabled lists, so a disabled package's prompt or resource
  is unknown there too.

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
   seam so a future flip is a contained change. With a `lookup` injected, a
   pre-flight refuses any non-routable answer (normalized IPv6, embedded IPv4
   classified — the range list is SECURITY.md § DNS resolve-and-pin).
2. **Auth injection** (`core/oauth.ts`): resolves the active profile's access
   token; if it expires within the skew window (`TT_TOKEN_REFRESH_SKEW_S`) a refresh
   is performed first under the § 7 protocol. A 401 or `access_token_invalid`
   triggers **exactly one** forced refresh + replay — for the `read` class only.
3. **Retry matrix** — **three classes** (CC-B7), classified by a **path
   allowlist** in `core/http.ts`, never by HTTP method alone:

| Class | Membership | 429 | 5xx / network error | Attempts |
|---|---|---|---|---|
| **read** | GET + read POSTs: `user/info`, `video/list`, `video/query`, `creator_info/query`, `status/fetch` | retry with backoff, `Retry-After` honored | retry | 1 + `TT_MAX_RETRIES` (3) |
| **init** | publish inits: `video/init`, `inbox/video/init`, `content/init` | **terminal** + wait guidance (CC-B8) | **never retried** — a transport failure or timeout after the request may have been sent is terminal `network_ambiguous`, journaled as `send_ambiguous` (CC-B4/B5); so is a `2xx`/`5xx` whose body is not JSON or not a JSON object, or a `5xx` envelope without `error.code` — a gateway's answer, which says nothing about whether the task was created (CC-B2/B5). A `4xx` or an explicit `error.code` maps as usual | 1 |
| **chunk** | PUTs to the validated `upload_url` | retry | retry **per chunk** with an **identical `Content-Range`** (replay-safe by byte range, CC-D6); in-call 1 + `TT_CHUNK_RETRIES` (3) | 1 + 3 per chunk |

   Chunk-PUT specifics: 4xx is terminal; **403 = expired upload URL → no
   auto-re-init** (CC-D5 — an auto-re-init would spend the init budget and orphan
   a pending publish); **416 → resync from `uploaded_bytes`** (a backward resync
   moves the reported chunk position back, so a later failure names the right
   chunk; MCP progress notifications never decrease). Backoff
   `min(500·2^n, 8000) + jitter`; `Retry-After` honored in retryable classes,
   capped at `min(30 s, remaining budget)` (CC-B3). Token-endpoint calls go
   through `oauthRequest`, are never auto-retried, and draw on none of the
   data-path buckets in (5); `invalid_grant` recovery is the § 7 lock-guarded
   re-read path.
4. **Concurrency**: nothing bounds in-flight requests, deliberately. No request
   path fans out — chunk PUTs run sequentially and no code path awaits requests
   in parallel — but under the HTTP transport two sessions can still have calls
   in flight at once, so the concurrency is reachable rather than impossible.
   What protects the upstream is the per-profile token bucket in (5), not a
   connection limit. The per-host semaphore this item once specified was never
   built; `TT_MAX_CONCURRENT` named it, governed nothing, and was removed on
   2026-09-01 (CONTRACTS.md § Change log) rather than left as a knob an
   operator could believe in.
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

- `dotenv`-compatible semantics with `override: false` — process env (from the
  MCP client) beats the file — implemented by `core/config`'s **own** parser, so
  the round-trip writer and the reader share one grammar and the package ships
  no `dotenv` dependency. Precedence is presence-based (CC-F2): an exported
  empty value still wins. Resolution: `TT_ENV_FILE` → `$XDG_CONFIG_HOME`/
  `~/.config/tiktok-mcp-ai/.env` on POSIX → `%LOCALAPPDATA%\tiktok-mcp-ai\.env`
  on win32 (never Roaming). Writes always target the resolved path — a
  symlinked env file is written through to its target, keeping the link (a
  dangling link — or a chain of them — is followed to its end and the final
  target's directory created, so no link in the chain is replaced by a
  regular file):
  atomic temp-file (0600, `O_EXCL`) + fsync + rename, comment- and CRLF-preserving
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
  the auto-injected `account` tool argument selects per request, and the
  resolved name is passed explicitly into that call's `ApiContext`
  (`src/api/context.ts`) rather than kept in ambient per-request state.
- In-memory credential snapshot swapped atomically (single assignment) so a torn
  read across refresh is impossible. There is **one snapshot-reload path** with
  three triggers — env-file mtime change, a `tiktok_get_auth_status` call, any
  auth-shaped error — whose subscribers adopt rotated tokens and re-evaluate
  scope markers (emitting `tools/list_changed` and `resources/list_changed`).
  One mechanism serves both rotation pickup and marker freshness.
- All numeric/behavioral knobs live in `core/settings.ts`, zod-validated at
  startup with all problems aggregated into one error (CC-F6); the variable
  table in CONFIGURATION.md is the authoritative list.

### 7.2 Env-file lock (`src/core/env-lock.ts`)

Cross-process mutex around the env file (SYNTHESIS § 2.2). Every env-file writer
— `login`, refresh, doctor — goes through `withEnvLock` (CC-A2, CC-F5).

- **Acquisition**: `fs.mkdir("<envfile>.lock")` — atomic on every platform and
  network filesystem. `<envfile>` is the **canonical path** (`canonicalPath`:
  symlinks resolved, a dangling chain followed hop by hop — up to 40 links,
  Linux's `SYMLOOP_MAX` — to the file it will create; a loop leaves the path
  as given and the read that follows reports it), the same spelling the atomic
  write targets, so a symlinked env file, its target and every link between
  them share one lock; `doctor` reports the lock at that path too. A JSON file inside (`{pid, hostname, createdAt}`) is
  **diagnostic only**; liveness is judged by **mtime, never PID** (PID checks
  fail across containers/hosts and on PID reuse).
- **Heartbeat**: while held, the holder touches the lock dir's mtime every
  `TT_ENV_LOCK_HEARTBEAT_MS` (2000). This is what makes it legal to hold the
  lock across a token-refresh network call: staleness is decoupled from
  critical-section length.
- **Staleness**: `now − mtime > TT_ENV_LOCK_STALE_MS` (15000) ⇒ the holder is
  presumed dead — rename the lock dir to a unique `<lock>.stale-<uuid>`
  tombstone, verify it is the directory whose age was measured (inode, birth
  time and the measured mtime — the mtime keeps the check sound where the file
  system reports no birth time and a successor could reuse the inode), put it
  back on a mismatch only onto a free path (a POSIX `rename` would replace a
  third process's fresh, still empty lock directory), otherwise delete it, re-acquire, log a warning.
- **Contention**: wait with 50–150 ms jitter up to `TT_ENV_LOCK_WAIT_MS`
  (30000). On timeout, **re-read the env file once** — if a rotated token
  appeared (the other process finished), adopt it and proceed; only otherwise
  surface `env_file_busy`.
- **Release**: delete the lock dir. **Journal appends do not take this lock**
  — append-only `O_APPEND` writes need none (§ 8.3). Journal *rotation* uses the
  same mutex keyed on `journal.ndjson` (`journal.ndjson.lock`); the `label`
  option makes its messages read "journal rotation lock … the publish journal"
  rather than naming the credential file.

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
5. **No refresh token on file ⇒ logged out, not a fallback.** When the re-read
   finds no refresh token in the file (and none pinned in the process
   environment), another process ran `login --revoke` or the key was removed by
   hand. The in-memory refresh token is then **not** spent — refreshing with it
   would persist a fresh token set and resurrect the profile the user logged
   out of. The cached token set is dropped, so its access token stops being
   served too, and the call fails with `auth_expired`.

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
  re-plan). Cap `TT_PLAN_MAX_OUTSTANDING` (32), oldest-evicted — used plans before live
  ones, since a used plan can only answer `plan_not_found` — lazy eviction on
  access + sweep on plan creation; TTL `TT_PLAN_TTL_S` (600).

### 8.2 Execute step — normative pipeline order

When `plan_id` is present, the order is **normative**:

1. **Re-resolve the payload through the same code path as the preview** —
   re-stat the file (size/mtime/dev/ino must match, CC-D3/D4), re-run the
   `creator_info` pre-flight on direct-post tools. The upload later opens the
   file once and reads every chunk and retry from that descriptor, whose
   identity must equal the one confirmed here (`plan_mismatch`); an in-place
   modification between chunks fails with `upload_interrupted`. The file
   identity (`size:mtimeMs:dev:ino`) is bound to the plan
   (`PlanRecord.fileIdentity`) — never sent upstream and never in the digest —
   so applying after the file changed fails verification with `plan_mismatch`,
   `details.reason: "file_changed"` (`fileChangedError`).
2. Compute **digest′** over the re-resolved payload.
3. **Verify**: plan exists ∧ not used ∧ not expired ∧ tool match ∧ digest match
   (`timingSafeEqual`) ∧ open_id match. The internal failure enum is
   `{unknown, expired, already_used, payload_mismatch, account_mismatch,
   tool_mismatch}`, surfaced as **exactly two** error codes: `plan_not_found`
   (unknown/expired/already_used) and `plan_mismatch`
   (payload/account/tool mismatch).
4. **Duplicate guard** (§ 8.4: journal and in-flight) — unless `force: true`.
   A `possible_duplicate` rejection happens *before* consumption, so the same
   `plan_id` may be re-executed with `force` within its TTL after the user
   verifies.
5. **Peek the rate token → consume atomically** (mark used) **→ take the
   token** — no `await` between them, all **before** the init is dispatched,
   so an MCP-client retry of the execute call fails with `plan_not_found`
   instead of double-posting (CC-E7). An empty bucket refuses with the plan
   still unspent; a plan lost to a concurrent apply during the duplicate
   guard's file read is refused before the take and costs no token; the take
   cannot refuse what the peek allowed. A consumed plan is never revived; a
   failed execute always requires a fresh preview.
6. **Journal intent append**, fsync'd (§ 8.3).
7. **Init dispatch** → upload (if FILE_UPLOAD) → the result returns
   `publish_id` immediately with a poll hint (`wait_for_completion` defaults to
   `false` on write tools; the status tool does the bounded wait —
   SYNTHESIS § 2.3). A caller cancellation that lands while the send is in
   flight (init or mid-upload) is `network_ambiguous`, journaled
   `send_ambiguous` — mid-upload keeping `publish_id` and `chunk` — so the
   duplicate guard blocks a blind retry (CC-G4); a cancel before the send
   began stays `error`. The same holds for a transport failure
   (`network_error` / `timeout`) on the **final** chunk: its arrival is what
   completes the upload, and TikTok posts what completes, so the bytes may
   have landed with only the `201` lost — `uploadFile` throws
   `network_ambiguous` and it is journaled `send_ambiguous` with the
   `publish_id` and chunk, never `upload_failed`. Once an attempt at the final
   chunk lost its answer and was replayed, any later failure of that chunk —
   `5xx` retries exhausted, or a terminal `403` / `404` / `400` — is
   `network_ambiguous` as well, since the lost attempt may have completed the
   upload; so is a final-chunk `416` whose reported progress equals the last
   byte index (`total − 1`), which is every byte or all but one until probe
   P-11 pins the unit (progress ≥ `total` completes). A transport failure on
   an earlier chunk stays `upload_interrupted` / `upload_failed`.

### 8.3 Write-ahead journal (`src/mcp/journal.ts`)

Append-only two-record NDJSON (SYNTHESIS § 2.7) — `journal.ndjson`, 0600 in a
0700 dir **beside the resolved env file**; appends are one `write()` of one
complete line on an `O_APPEND` fd. The journal **does not take the env lock**
(rotation takes a lock of its own, below).

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
  skipped and counted; unknown `v` is ignored and counted. Rotation takes its
  own cross-process lock, `journal.ndjson.lock` — the env-lock mutex (§ 7.2)
  keyed on the journal path, distinct from the env-file lock, so a publish
  never queues behind a token refresh. The unlocked size check stays a
  lock-free fast path; under the lock the size is re-checked, so a process
  that waited while another rotated does not rotate the fresh generation
  again (two concurrent rotations can no longer discard a rotated
  generation). The wait is 2 s (`ROTATE_LOCK_WAIT_MS`); past it, or when the
  lock is unusable, the rotation is skipped with the warning `could not
  rotate the publish journal; it keeps growing` and the append proceeds. A
  crashed holder is reclaimed after the env lock's 15 s stale timeout
  (mtime). Appends themselves take no lock. The journal directory is fsync'd
  after a rotation's rename and after an fsync'd append that created the
  file, so a crash right after one keeps the rename or the new directory
  entry; best-effort — where the platform cannot sync a
  directory (Windows) it is skipped with a debug log.
- **Cached fold**: `foldedAttemptsCached` keeps the folded attempts per journal
  path with a signature of both generations (size, mtime, inode, `-` when
  absent) and reuses them while it is unchanged; the `publish_id` completion
  reads through it. An append from any process, or a rotation, changes the
  signature and forces a re-read. The cached array is shared between callers
  and frozen (`Object.freeze`), so one caller's in-place `.reverse()` cannot
  reorder another's view.
- **One wiring**: `journalOptionsFor(settings, log)` resolves the env file, the
  size cap and the call-bound logger in one place. `tools/publish.ts`'s
  `journalOptions(ctx)` delegates to it and `mcp/completions.ts` calls it for
  the `publish_ids` source (§ 5.1), so the tool that appends an intent, the
  tool that lists attempts and the completion that offers their ids can never
  resolve a different file.
- **Failure semantics**: an append failure is a **warning** — the tool result
  carries `journal: "unavailable"`, and the publish proceeds; the journal is
  never a publish failure. A **short write** (fewer bytes written than the
  line, e.g. a full disk) counts as a failed append, not a recorded one: an
  intent the duplicate guard cannot read is no intent at all.
- **Torn tail on append**: when the file does not end in a newline (a crash or
  a short write left a partial last line), the next append starts with one, so
  the fragment stays a line of its own — skipped and counted by readers —
  instead of swallowing the record appended after it.
- The record shape is a **public contract** from the moment the journal read
  tool ships: additive-only under `v:1`, version bump only for incompatible
  changes.

### 8.4 Duplicate guard

Reads a **bounded tail** (256 KiB) of the active generation and — when the
whole active file fits in that budget (decided on the raw bytes read versus
the same descriptor's size, never on decoded text length) — the newest part
of `.1` within the remaining budget, so an intent rotated into `.1` (by this process on its next
publish, or by another process at any time) still counts. The guard is **per
profile** — attempts are compared by canonical profile name (CC-F4), so the
same payload on another account never trips it, and `possible_duplicate`
names the matched attempt's profile. A matching payload
digest with an `ok` or `unknown` (incl. `send_ambiguous`) outcome within the
last **10 minutes** trips `possible_duplicate` unless `force: true`. `error` and
`upload_failed` outcomes are exempt — a cleanly failed attempt must not block
the retry. Unresolved intents also surface as a server-authored warning in plan
previews (warn, never hard-block — a local file cannot prove upstream state).

Beside the journal scan, an in-process **in-flight guard** keyed by (profile,
payload digest) refuses an unforced apply while another call in the same
process is dispatching that payload (`possible_duplicate`,
`details.in_flight: true`). It closes the window in which two applies of
different plans for one payload both pass the journal check before either has
appended its intent. The entry is registered **before** the journal read, not
after it — otherwise a dispatch for the same payload that appended its intent,
posted and settled while that read was pending would be invisible to both
checks, and two concurrent identical applies could both pass. It is registered
under `force: true` too (a forced apply is still a dispatch an unforced one
must not race), even though `force` skips the check itself; every refusal after
the registration (journal duplicate, rate bucket, plan consume) releases it,
so does any exception the guards throw after it (else the payload would stay
"in flight" — refused as `possible_duplicate` — for the life of the process),
and otherwise it is released when the dispatch settles.

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
