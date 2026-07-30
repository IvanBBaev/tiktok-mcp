# Round-2 Deep Design Review — Principal Software Architect

## 1. Reviewer & scope

- **Role**: Principal Software Architect — TypeScript/Node, MCP servers. Round 2:
  adversarial cross-examination of round-1 findings, resolution of the four cross-role
  consensus items, and conversion of open questions into concrete, implementable design
  decisions.
- **Date**: 2026-07-21.
- **Inputs read in full**:
  - Spec: `README.md`, `docs/ARCHITECTURE.md`, `docs/TIKTOK-API.md`, `docs/TOOLS.md`,
    `docs/AUTH.md`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`, `docs/TESTING.md`,
    `docs/ROADMAP.md`.
  - Round-1 reviews: `docs/reviews/architecture-review.md` (predecessor, same role),
    `docs/reviews/security-review.md`, `docs/reviews/tiktok-platform-review.md`,
    `docs/reviews/qa-review.md`, `docs/reviews/devops-release-review.md`,
    `docs/reviews/ai-dx-review.md`.
  - House baseline: `servicenow-mcp-ai` architecture reference map
    (`facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md`).
- **Referencing convention**: round-1 findings are cited as `Arch F<n>` (predecessor
  architecture review), `Sec F<n>`, `Plat F<n>`, `QA F-<n>`, `DevOps F<n>`, `AI/DX F<n>`.
  Round-1 prose is not repeated; this document builds on it.
- **Structure**: § 2 cross-examines other roles' findings that touch architecture;
  § 3 delivers the four consensus resolutions plus the mandated design deliverables;
  § 4 lists new/deepened findings; § 5 gives ordered spec amendments; § 6 lists
  remaining unknowns.

## 2. Cross-examination

Verdicts: **CONFIRM** (adopt as stated), **REFINE** (adopt with a material design
correction), **REFUTE** (do not adopt; reasoning given). Findings with no architectural
consequence (pure release mechanics, doc wording, test inventory) are marked *noted* and
not re-argued.

### 2.1 Security review

| Finding | Verdict | Reasoning |
|---|---|---|
| Sec F1 (redaction must be core-level) | **CONFIRM** | This is consensus item (d). Resolved in § 3.4: single `core/redact.ts`; `mcp/redact.ts` is deleted from the spec. |
| Sec F2 (OAuth allowlist logging; scrub `code`, callback URL) | **CONFIRM** | Folded into the § 3.4 scrub set. The callback URL requirement generalizes: `scrubUrl()` strips query strings from *every* logged URL, which also covers `upload_url` (Plat F4). |
| Sec F3 (`file_path` exfiltration → `TT_MEDIA_ROOT`) | **CONFIRM** | Placement decision: path canonicalization + root containment live in `core/media-root.ts` (pure, no HTTP); the api layer calls it before any file open. Resolved-path + size echo belongs in the plan preview and is part of the § 3.1 resolved payload — so the hash binds the *actual file*, not the argument string. |
| Sec F4 (confirmation token "derived from a hash of the resolved payload") | **REFINE** | The intent is right; the derivation is a design flaw. A token deterministically derived from the payload is computable by anyone who knows the payload — including an injected instruction that supplies the exact post content. That would let a single message fabricate a "confirmation" without any plan call, defeating AI/DX F1's forced two-call shape. Resolution (§ 3.1): the token is **random** (128-bit, unguessable); the payload hash is **stored server-side** and compared on apply. Comparison over SHA-256 digests via `timingSafeEqual` per Sec F14. |
| Sec F5 (Origin/DNS-rebinding checks on loopback callback) | **CONFIRM** | Login CLI HTTP handler: reject requests whose `Host` is not `127.0.0.1:<port>`; the callback is a top-level navigation so Origin is typically absent — Host check + single-use `state` + PKCE is the effective control set. No architectural conflict. |
| Sec F7 (0700 dir, O_EXCL 0600 temp, fsync, journal 0600) | **CONFIRM** | Adopted as the file-creation contract for `core/config-store.ts` and `core/journal.ts`. Interacts with § 3.2: the lock file inherits the same directory and mode rules. |
| Sec F8 (upload_url validation: registrable domain, 443, public-IP resolve, pin) | **REFINE** | Registrable-domain + scheme/port checks: adopt in `core/host-guard.ts`. Full connect-time IP pinning requires a custom undici dispatcher with a pinned `lookup`; that is proportionate to defer to a hardening pass — v1 ships domain+scheme validation plus one-time DNS resolution with private-range rejection, and the spec notes the TOCTOU residual explicitly instead of claiming pinning it doesn't do. |
| Sec F11 (`TT_LOCK_PROFILE`) | *noted* | Compatible with § 3.2; no change to the lock design. |
| Sec F13 (fixed-port contradiction) | **REFINE** | Resolved by Plat F5: TikTok registers wildcard-port loopback redirects (`http://127.0.0.1:*/callback/`). Therefore the default becomes an **ephemeral port** (`listen(0)`), eliminating the port-squatting concern structurally; `TT_REDIRECT_PORT` remains as an optional pin for firewalled setups. Sec F13's PKCE argument stands as defense-in-depth, not as the reason to keep a fixed port. |
| Sec F14 (timingSafeEqual over sha256 digests) | **CONFIRM** | Used verbatim in the § 3.1 `consume()` comparison. |
| Sec F15 (journal retention / revoke purge) | **REFINE** | Retention: covered by rotation (§ 3.6, DevOps F9). Purge-on-revoke: rejected as automatic behavior — the journal is the audit trail precisely for post-revocation questions ("what did this thing post?"). Offer `doctor --purge-journal` as an explicit user action instead. |

### 2.2 Platform review

| Finding | Verdict | Reasoning |
|---|---|---|
| Plat F1 (PKCE challenge is HEX(SHA256), not base64url) | **CONFIRM** | Contained in `core/oauth.ts`; a contract-fixture test pins the encoding. No structural impact. |
| Plat F4 (`open-upload.tiktokapis.com`; `upload_token` is a credential in the URL query) | **CONFIRM** | Two architectural consequences adopted: (1) host-guard allowlist gains the upload host, scoped to the `chunk_put` request class only (§ 3.3); (2) `upload_url` must never be logged or journaled un-scrubbed — covered by `scrubUrl()` in § 3.4. README egress list must be amended (§ 5, A11). |
| Plat F5 (wildcard-port loopback redirect registrable) | **CONFIRM** | Drives the Sec F13 refinement above: ephemeral port by default. |
| Plat F6 (`creator_info` requires `video.publish`) | **CONFIRM** | The plan step's pre-flight becomes conditional on granted scope: draft-only (`video.upload`) flows skip `creator_info` and their resolved payload simply contains no creator-derived fields. The § 3.1 hash mechanism is indifferent to this — it binds whatever payload will actually be sent. |
| Plat F7 (status 30/min, creator_info 20/min buckets) | **CONFIRM** | The limiter grows from one bucket to a keyed bucket set (§ 3.3 table, "Local bucket" column). Same reject-with-`retry_at` semantics as QA F-17 for the publish bucket; read buckets may *briefly* delay instead (≤ 2 s) since reads are cheap to hold. |
| Plat F8 (error/fail_reason catalogs incomplete) | *noted* | Taxonomy data, not architecture. |
| Plat F9 (PULL_FROM_URL requires developer-verified domains; `TT_VERIFIED_URL_PREFIXES`) | **REFINE** | Adopt the knob as **advisory pre-validation only**: when set, a non-matching `video_url` fails locally with an explanatory error; when unset, the URL passes through and the upstream `url_ownership_unverified` error is mapped in the taxonomy. Do not make the knob mandatory — the source of truth is TikTok's console, and a stale local list must not block a valid post. |
| Plat F12 + chunk deep dive (fixed 64 MiB chunk size is always valid) | **CONFIRM** | Adopted as the whole strategy: `planChunks()` hard-codes 64 MiB (§ 3.5). No `TT_CHUNK_SIZE` knob is introduced — configurability here only creates invalid-combination surface that TikTok's `floor()` math punishes. |

### 2.3 QA review

| Finding | Verdict | Reasoning |
|---|---|---|
| QA F-1 (upload execution semantics; no resume in v1) | **CONFIRM** | § 3.5: in-call per-chunk retry, no cross-call resume, `upload_url` never persisted; unrecoverable failure returns `publish_id` + failed byte offset + status/journal hints. |
| QA F-2 (init-failure decision table; ambiguous send is terminal) | **CONFIRM** | Becomes row 2 of the § 3.3 decision table and the `send_ambiguous` journal outcome (§ 3.6). The uncertainty wording requirement is folded into the amendment A3 hint text. |
| QA F-3 (rotation persist-failure + cross-process race) | **CONFIRM** | Consensus item (b), resolved in § 3.2 including the persist-failure ordering: adopt-in-memory first, persist under lock second, and a persist failure degrades to a logged warning + `doctor` finding — never a lost token. |
| QA F-5 (deterministic time) | **CONFIRM** | `core/clock.ts` (injectable `now()`/`sleep()`) is consumed by the plan store TTL, lock heartbeat/staleness, token buckets, backoff, and poll loops. One seam, all timing testable. |
| QA F-7 (token-endpoint requests must bypass the data semaphore) | **CONFIRM** | § 3.3 introduces explicit **lanes**: the `auth` lane (token endpoints) never queues behind the `data` lane's per-host semaphore. This kills the refresh-under-saturation deadlock class. |
| QA F-8 (stdout purity; dotenv tip line) | **CONFIRM** | Architectural consequence: `core/config-store.ts` reads the env file with `fs.readFileSync` + `dotenv.parse()` — never the side-effectful `dotenv/config` import — so no library can print to stdout before transport connect. |
| QA F-10 (journal appends: single `write()` of a full line; append failure never blocks publish) | **REFINE** | Adopted, with the WAJ split (§ 3.6): an **outcome**-append failure is a warning + hint as QA specified; an **intent**-append failure additionally forces the warning into the result (`journal: "unavailable"`) because it silently disables the duplicate-post warning for that attempt. Availability still wins — the publish proceeds. |
| QA F-12 (redact-before-truncate; surrogate-safe truncation) | **CONFIRM** | Ordering is now structurally guaranteed: `mcp/result.ts` calls `core/redact` first, then shapes/truncates (§ 3.4). |
| QA F-17 (bucket exhaustion rejects with wait hint, never sleeps) | **CONFIRM** | Adopted for the publish bucket; and extended for uniformity — an upstream 429 on an init is treated identically (terminal + `retry_at`), so the model sees one behavior for "too fast" regardless of which limiter fired (§ 3.3 row 2). |
| QA F-18 (fetch_all cursor-loop guard) | **CONFIRM** | api-layer pagination: abort when the cursor does not advance; cap by `TT_FETCH_ALL_CAP`. |
| QA F-11/F-13/F-19..F-25 | *noted* | Test-plan material; the § 3 designs were checked against them (notably F-15 contract fixtures for the chunk-PUT 206/201 non-envelope responses). |

### 2.4 DevOps / release review

| Finding | Verdict | Reasoning |
|---|---|---|
| DevOps F1 (Windows undesigned: XDG, chmod 0600) | **REFINE** (scope: architecture) | The § 3.2 lock is win32-compatible by construction (`O_CREAT|O_EXCL` maps to `CREATE_NEW`; stale detection is mtime-based, not signal-based, so it works cross-host and cross-platform; release order is close-then-unlink for win32). The data-dir resolver and chmod-skip policy are DevOps territory — endorsed, no conflict. |
| DevOps F5 (`server.json` generated, `--check` gated) | **CONFIRM** + tie-in | With the § 3.7 manifest move, `tools/index.ts` becomes the single source for registration, snapshot test, README table, *and* `server.json` env/tool facts — one generator input, four consumers. This strengthens the F5 recommendation rather than changing it. |
| DevOps F8 (cross-process refresh race; advisory lock + re-read) | **CONFIRM**, superseded by fuller protocol | DevOps' sketch (re-read before refresh + lockfile) is necessary but not sufficient: a fixed stale-TTL shorter than the refresh network timeout lets a waiter steal the lock mid-refresh and reintroduce the exact race. § 3.2 adds heartbeat-based staleness and the `invalid_grant` re-read recovery. The `doctor` multi-process check is adopted. |
| DevOps F9 (journal rotation, failure semantics) | **REFINE** | Adopted with two WAJ-specific rules: rotation may only occur immediately **before an intent append** (never between an intent and its first outcome from the same process), and the journal reader merges the active file plus one rotated generation so late outcomes still correlate (§ 3.6). |
| DevOps F2–F4, F6, F7, F10–F16 | *noted* | Release engineering; no architectural interaction beyond F5 above. One remark: F13's "zero repository secrets" invariant is worth cross-referencing from SECURITY.md as recommended — it is the operational twin of the design's "tokens never leave the machine" claim. |

### 2.5 AI/DX review

| Finding | Verdict | Reasoning |
|---|---|---|
| AI/DX F1 (plan_id binding; blocking) | **CONFIRM** | Consensus item (a); § 3.1 is the concrete contract. Two refinements: (i) schema shape stays **flat** — `apply?: boolean` plus `plan_id?: string` with a registry-level refinement ("`plan_id` required when `apply` is true in plan mode"), rather than the nested `apply: { plan_id }` object; flat fields with a named-rule error are easier for models than a nested union, and keep `.strict()` shapes uniform. (ii) The token is random, not payload-derived (see Sec F4 refinement). Elicitation-on-apply is endorsed as feature-detected defense-in-depth, not a v1 gate. |
| AI/DX F2 (destructiveHint explicit) | **CONFIRM** + structural fix | Make the annotation tuple **required** in `ToolSpec`: all four hints, non-optional, so "undecided annotation" becomes a compile error rather than an MCP-default surprise (§ 3.7 interface). |
| AI/DX F3 (split `tiktok_post_photos` by mode) | **CONFIRM** | Restores 1 tool ≈ 1 scope ≈ 1 marker. Both photo tools land in `publish-write` (§ 3.8) — packages group by risk class; scopes gate availability via markers. |
| AI/DX F4 (journal read tool; journal the attempt before init; title excerpt) | **CONFIRM** | This is exactly the WAJ (§ 3.6). Title excerpt (48 chars) is stored — it is destined-public content, not a secret; the redaction primitive is *not* applied to it, and the journal never stores tokens or URLs with query strings. |
| AI/DX F5 (marker lifecycle: call-time re-check, listChanged, reload triggers) | **CONFIRM** + synthesis | The env-file **mtime watch** AI/DX proposes for marker freshness is the same primitive § 3.2 needs for cross-process rotation pickup. Resolution: one snapshot-reload path in `core/config-store.ts` with defined triggers (mtime change, `tiktok_get_auth_status` call, any auth-shaped error); consumers subscribe — the registry re-evaluates markers and emits `tools/list_changed`; the auth layer adopts rotated tokens. Two round-1 problems, one mechanism. |
| AI/DX F6/F7 (annotation consistency; naming) | **CONFIRM** | Renames (`tiktok_get_auth_status`, `tiktok_get_creator_info`, unified `wait_for_completion`) must land before the manifest snapshot freezes them. No structural impact. |
| AI/DX F10 (account guardrails; `meta.account` echo; plan binding) | **CONFIRM** | Account binding is native to the § 3.1 record (`profile` + `openId`). `meta.account` echo is emitted by `mcp/result.ts`. Unknown-profile local validation error adopted. |
| AI/DX F11 (internal chunk retry; no resume; re-call = new publish) | **CONFIRM** | Identical to QA F-1 / Arch F4 consensus; § 3.3 row 3 and § 3.5. |
| AI/DX F13 (truncation meta contract) | **CONFIRM** | `meta.truncated/reason/returned/resume_cursor` emitted by `mcp/result.ts`; shaping drops trailing items only; `cursor`/`has_more`/`meta` survive shaping. |
| AI/DX F14 (60 s blocking waits; progress notifications) | **REFINE** — and this settles the long-call question | See § 3.9. AI/DX's position (keep `wait_for_completion: true`, add progress notifications) is adopted **over** the predecessor's round-1 lean (default `false` for `source:"file"` — Arch F2/deep-dive C). Reason: for file uploads the upload itself dominates wall time, so flipping the wait default does not solve client timeouts, while it *does* guarantee a dangling non-terminal state on every file post. |
| AI/DX F16 (discriminated union on `source`) | **REFINE** | Keep the *validation semantics* (contradictory input rejected, discriminator named in the error) but implement via `superRefine` on the flat `.strict()` shape rather than `z.discriminatedUnion`. Rationale: JSON-Schema rendering of zod discriminated unions (`anyOf`) is markedly harder for models to read than a flat property list, and the MCP surface is the schema, not the zod source. The refinement gives the same "impossible combinations rejected, error names the rule" outcome with a better model-facing schema. |
| AI/DX F18 (`ok:false` ⇒ `isError`; structuredContent + outputSchema) | **CONFIRM** | Mapping specified in `mcp/result.ts`; text block stays authoritative. |
| AI/DX F19/F20 (hints grammar/injection-free; preview verbosity) | **CONFIRM** | Hints are server-authored only — this also constrains § 3.6: journal-derived warnings in previews must render counts/timestamps, never stored titles, inside `hints`. Chunk plan renders as the three-field summary. |

## 3. Resolutions

### 3.1 (a) Plan token: issuance, hashing, storage, TTL, single-use, journal & multi-account interaction

**Module**: `src/mcp/plan-store.ts` (mcp layer — it is write-safety glue used by
`mcp/write-mode.ts`; it imports only `core/clock` and node `crypto`).

**What is hashed.** The **resolved upstream payload**, not the tool arguments: the exact
`post_info` + `source_info` bodies the apply would send, plus resolved local facts —
canonical absolute file path, file size, chunk-plan summary (or the validated
`video_url`), photo list, and the resolved `post_mode`. Hashing the resolved payload
(rather than raw args) means: (i) what the human approved is what executes, including
server-derived coercions; (ii) creator-state drift between plan and apply (privacy
options changed, duration cap changed) re-resolves to a *different* payload at apply
time and fails the hash check naturally — the Arch F3 "re-run creator_info on apply"
requirement is thereby subsumed: apply always re-resolves, and the hash is the drift
detector. Canonicalization: `canonicalJson()` in `core/json.ts` — recursively sorted
keys, no insignificant whitespace, UTF-8; digest = SHA-256.

**Token**: `plan_id = "plan_" + base64url(randomBytes(16))`. Random, never derived from
the payload (see § 2.1 Sec F4 refinement).

**Storage**: in-memory `Map` in the server process. Not persisted — an MCP session is
one client on one process, and a plan surviving a server restart is a *bug*, not a
feature (the preview the human saw is gone). Restart ⇒ re-plan, fail-safe. Bounded:
`TT_PLAN_MAX_OUTSTANDING` (default 32), oldest-evicted. The journal stores the
`plan_id` string for correlation only; tokens are never written anywhere.

**TTL**: `TT_PLAN_TTL_S` (default 600). Long enough for a human deliberation turn,
short enough that creator-state drift is bounded.

**Single-use semantics**: the plan is **consumed atomically at apply-verification time,
before the init request is sent** — the same instant the WAJ intent record is appended.
A consumed plan is never revived: if the init then fails (even cleanly), the model must
re-plan, which re-resolves creator state. This is deliberate and aligns with the
no-retry-init doctrine — "retry apply with the same plan" is exactly the replay we must
not allow.

```ts
// src/mcp/plan-store.ts
export interface PlanRecord {
  planId: string;          // "plan_" + base64url(16 random bytes)
  tool: string;            // ToolSpec.name
  profile: string;         // resolved profile name at plan time
  openId: string;          // account identity at plan time
  payloadDigest: Buffer;   // sha256(canonicalJson(resolvedPayload))
  createdAt: number;
  expiresAt: number;       // createdAt + TT_PLAN_TTL_S * 1000
  consumed: boolean;
}

export type PlanConsumeFailure =
  | "unknown" | "expired" | "already_used"
  | "payload_mismatch" | "account_mismatch" | "tool_mismatch";

export interface PlanTokenStore {
  issue(input: Pick<PlanRecord, "tool" | "profile" | "openId" | "payloadDigest">): PlanRecord;
  /** Atomic verify-and-consume; digest compared via timingSafeEqual. Never throws. */
  consume(
    planId: string,
    expected: Pick<PlanRecord, "tool" | "profile" | "openId" | "payloadDigest">,
  ): { ok: true } | { ok: false; reason: PlanConsumeFailure };
}
```

**Sequence (plan mode)**:

```
model                                server
  │ post_video {args}                  │
  │───────────────────────────────────▶│ validate → scope-conditional creator_info
  │                                    │ resolve payload (file/url/photos, coercions)
  │                                    │ digest = sha256(canonicalJson(payload))
  │                                    │ planStore.issue(...) → plan_id
  │◀───────────────────────────────────│ preview + plan_id + directive hints
  │  (human approves in own message)   │
  │ post_video {args, apply:true,      │
  │             plan_id}               │
  │───────────────────────────────────▶│ re-resolve payload → digest'
  │                                    │ planStore.consume(plan_id, {digest', profile, openId, tool})
  │                                    │   fail ⇒ "plan_invalid" + re-plan hint (terminal, no network)
  │                                    │ journal.append(intent{attempt_id, plan_id, ...})
  │                                    │ init → upload → poll   (see § 3.6 state machine)
```

**Multi-account**: `profile` and `openId` are captured at plan time from the resolved
account context (auto-injected `account` arg or default). `consume()` compares both;
an apply routed to a different profile fails with `account_mismatch` and an explicit
message (AI/DX F10). **Write modes**: `plan` (default) — contract above; `apply` —
plan store bypassed entirely, documented as trusted-automation mode; `deny` — write
tools unregistered (unchanged).

### 3.2 (b) Cross-process env-file locking for refresh rotation

**Module**: `src/core/env-lock.ts` (core layer — a config-store dependency).

**Lock file**: `<envfile>.lock` in the same directory as the env file (same filesystem,
same ACL story; e.g. `~/.config/tiktok-mcp-ai/.env.lock`). Content: one JSON line
`{ pid, hostname, createdAt }` — diagnostic only; **liveness is judged by mtime, not
pid** (pid checks fail across containers/hosts and on pid reuse; mtime heartbeats do
not).

**Semantics** — advisory, heartbeat-based:

1. **Acquire**: `fs.open(path, "wx")` (`O_CREAT|O_EXCL` — atomic on POSIX and win32).
   On `EEXIST`: `stat` the lock; if `now − mtime > TT_ENV_LOCK_STALE_MS` (default
   15 000) the holder is presumed dead → unlink and retry acquisition (the unlink race
   between two reclaimers is benign: `O_EXCL` guarantees at most one winner). Otherwise
   wait 50–150 ms (jittered) and retry, up to `TT_ENV_LOCK_WAIT_MS` (default 30 000),
   then fail with a designed retryable error (`env_file_busy`).
2. **Heartbeat**: while held, the holder touches the lock's mtime every
   `TT_ENV_LOCK_HEARTBEAT_MS` (default 2 000). This is what makes it legal to hold the
   lock across a token-refresh network call: staleness (15 s) is decoupled from
   critical-section duration (up to `TT_TIMEOUT_MS`). A fixed stale-TTL without
   heartbeat would let a waiter steal the lock mid-refresh — reintroducing the race the
   lock exists to prevent (see § 4, N2).
3. **Release**: close the fd, then unlink (win32-safe order). Crash without release is
   recovered by rule 1.

```ts
// src/core/env-lock.ts
export interface EnvLockOptions {
  staleMs?: number;      // default 15_000 — mtime age after which the lock is stealable
  heartbeatMs?: number;  // default 2_000
  waitMs?: number;       // default 30_000 — max acquisition wait
}
export function withEnvFileLock<T>(
  envFilePath: string,
  fn: () => Promise<T>,
  opts?: EnvLockOptions,
): Promise<T>;
```

**Refresh protocol** (fixes Arch F1, QA F-3, DevOps F8) — all inside the per-profile
in-process single-flight mutex, then `withEnvFileLock`:

1. **Re-read** the env file. If its refresh token differs from the in-memory one,
   another process rotated: adopt the file's tokens (atomic snapshot swap). If the
   adopted access token is still fresh (`expires_at − TT_TOKEN_REFRESH_SKEW > now`),
   return it — no network at all.
2. Otherwise call the token endpoint (auth lane, § 3.3 row 4) **while holding the
   lock** (heartbeat running).
3. On success: adopt in memory first, then **read-merge-write** the env file — re-parse
   the current file content and replace only this profile's token keys, preserving any
   concurrent edits to other profiles/keys; write via the existing atomic contract
   (O_EXCL 0600 temp, fsync, rename; brief EPERM retry loop on win32). A persist
   failure is a logged warning + `doctor` finding — the in-memory adoption already
   happened, so the session keeps working (QA F-3).
4. On `invalid_grant`: **re-read the env file once more under the lock** — if the file
   now holds a different refresh token, a sibling process won a race that predates our
   lock acquisition; adopt and retry once. Only if the file token matches the failed one
   is the profile declared re-login-required.

**Other writers**: `login` (CLI) and any `persistEnv()` config write use the same
`withEnvFileLock`. The **journal does not use this lock** — it relies on `O_APPEND`
single-write atomicity (QA F-10). The env-file **mtime watch** (AI/DX F5 synthesis,
§ 2.5) lets a *non-refreshing* process adopt rotated tokens promptly, shrinking the
window in which step 1's re-read is needed at all.

### 3.3 (c) Definitive idempotency / retry decision table

Classification is by **path allowlist** in `core/http.ts` (`classifyRequest(url,
method) → RequestClass`), never by HTTP method. Shared backoff:
`min(500·2^n, 8000) + full jitter`; `Retry-After` honored and capped at 60 s (read
classes only). Lanes: `data` = per-host semaphore (`TT_MAX_CONCURRENT`); `auth` =
separate unbounded-small lane, never queued behind data traffic (QA F-7); `upload` =
sequential within one upload, one data-semaphore slot held for the whole upload, not
per chunk.

| # | Class | Match | Lane | Local bucket | 429 (response received) | 5xx (response received) | Transport error / timeout (ambiguous send) | Max attempts |
|---|---|---|---|---|---|---|---|---|
| 1 | **Read** | `open.tiktokapis.com`: `/v2/user/info/`, `/v2/video/list/`, `/v2/video/query/`, `/v2/post/publish/creator_info/query/`, `/v2/post/publish/status/fetch/` | data | creator_info 20/min; status 30/min (keyed buckets) | retry (Retry-After ≤ 60 s) | retry on 502/503/504 | retry | 3 |
| 2 | **Publish init** | `/v2/post/publish/video/init/`, `/v2/post/publish/inbox/video/init/`, `/v2/post/publish/content/init/` | data | publish 6/min — **reject with `retry_at`, never sleep** (QA F-17) | **terminal** + `retry_at` hint (uniform with local bucket) | **terminal** | **terminal**; journal outcome `send_ambiguous`; hints: check `tiktok_get_publish_status` / journal before any re-plan | 1 |
| 3 | **Chunk PUT** | exact `upload_url` on `open-upload.tiktokapis.com`, method PUT | upload | none | retry (rejected request, fixed byte range ⇒ replay-safe) | retry | retry — **idempotent by construction** (same `Content-Range`) | 1 + `TT_CHUNK_RETRIES` (3) per chunk |
| 4 | **Token refresh** | `/v2/oauth/token/`, `grant_type=refresh_token` | auth | none | terminal (surface retryable auth error) | terminal | **terminal — rotation may have occurred**; recovery is the § 3.2 lock-guarded re-read, plus one forced re-read on `invalid_grant` | 1 |
| 5 | **Code exchange** | `/v2/oauth/token/`, `grant_type=authorization_code` | auth | none | terminal | terminal | terminal — the code is single-use; user restarts `login` | 1 |
| 6 | **Revoke** | `/v2/oauth/revoke/` | auth | none | retry once | retry once | retry once — idempotent in effect | 2 |

The round-1 two-column matrix conflated rows 2 and 3 (Arch F4, QA F-1, AI/DX F11);
rows 4–6 were previously absent entirely (Arch F5, deep dive A). This table is the
normative replacement (amendment A1).

### 3.4 (d) Redaction as a core primitive

**Module**: `src/core/redact.ts`. `mcp/redact.ts` is removed from the spec. Layering:
`core/log.ts` redacts at emission (fixes Sec F1 — logs are safe at the source, not at
the MCP boundary); `core/errors.ts` scrubs URLs/messages at construction;
`mcp/result.ts` calls `redactDeep` **before** shaping/truncation (QA F-12). The mcp
layer imports core — the dependency direction is legal and now single-sourced.

```ts
// src/core/redact.ts
export const SECRET_KEYS: ReadonlySet<string>;
// access_token, refresh_token, client_secret, code, code_verifier, state,
// upload_token, authorization (header), token, plan-internal digests
export function scrubUrl(url: string): string;   // strips query string + userinfo — covers
                                                 // OAuth callback URLs (Sec F2) and upload_url (Plat F4)
export function scrubText(text: string): string; // pattern pass for free text (error messages, log lines)
export function redactDeep<T>(value: T, opts?: { maxDepth?: number }): T; // key-based masking, depth-limited (QA F-23)
```

Value-pattern scrubbing for TikTok token prefixes (`act.`/`rft.`) is added iff the
prefixes are confirmed at implementation time (§ 6, U6). `logFields` remains allowlist-
only; redaction is the backstop, not the policy.

### 3.5 Chunk uploader

**Pure math** — `src/core/upload-chunks.ts`, property-tested (TESTING.md already plans
this):

```ts
// src/core/upload-chunks.ts
export interface Chunk { index: number; start: number; endInclusive: number; }
export interface ChunkPlan { chunkSize: number; totalChunkCount: number; chunks: Chunk[]; }
/** Fixed 64 MiB strategy (Plat deep dive): size ≤ 64 MiB ⇒ one chunk of the full size;
 *  else chunkSize = 64 MiB, totalChunkCount = floor(size / chunkSize), the final chunk
 *  absorbs the remainder (≤ 128 MiB by construction). Throws on size > 4 GiB. */
export function planChunks(fileSize: number): ChunkPlan;
```

**Orchestration** — `src/api/upload.ts` (api layer; per-chunk retry lives in
`core/http.ts` under class `chunk_put`):

```ts
// src/api/upload.ts
export interface UploadProgress { chunkIndex: number; totalChunks: number; sentBytes: number; totalBytes: number; }
export async function uploadFileChunks(opts: {
  filePath: string;        // already media-root-validated, canonical absolute path
  uploadUrl: string;       // already host-guard validated (registrable domain, https:443)
  plan: ChunkPlan;
  onProgress?: (p: UploadProgress) => void;  // tool layer wires this to MCP progress notifications
  signal?: AbortSignal;
}): Promise<{ sentBytes: number }>;
```

Rules (ratifying Arch deep-dive C + QA F-1): chunks sent sequentially; each chunk body
streamed via `fs.createReadStream(start, end)`; per-chunk in-call retry per § 3.3
row 3; **no cross-call resume** — `upload_url` is never persisted or returned; on
unrecoverable failure the tool result carries `publish_id`, the failed byte offset, and
the status/journal hints, and the journal gets outcome `upload_failed`. The upload-host
allowlist entry in `core/host-guard.ts` is scoped to class `chunk_put` so no other code
path can reach `open-upload.tiktokapis.com`.

### 3.6 Write-ahead journal (closing the duplicate-post window)

**Module**: `src/core/journal.ts` (append + read); orchestrated by
`mcp/write-mode.ts`. File: `journal.ndjson`, 0600 in the 0700 data dir; appends are one
`write()` of one complete line on an `O_APPEND` fd (QA F-10).

**Two record types**, correlated by `attempt_id` (ULID, generated before init):

```jsonc
// intent — appended AFTER plan consumption, BEFORE the init request is sent
{ "v": 1, "type": "intent", "attempt_id": "01J...", "ts": "2026-07-21T14:31:02Z",
  "tool": "tiktok_post_video", "profile": "default", "open_id": "…",
  "plan_id": "plan_8f3a…", "payload_digest": "sha256:…",
  "title_excerpt": "First 48 chars of the title", "source": "file", "mode": "plan" }

// outcome — appended at each state transition; reader takes the latest per attempt_id
{ "v": 1, "type": "outcome", "attempt_id": "01J...", "ts": "…",
  "result": "initiated" | "init_failed" | "send_ambiguous" | "upload_failed"
          | "published" | "failed" | "timeout",
  "publish_id": "v_pub_file~…", "error_code": "…", "fail_reason": "…" }
```

**Attempt state machine** (journal outcomes annotate the transitions):

```
PLAN_CONSUMED ─ append intent ─▶ INIT_SENT ─┬─ response ok ──▶ INITIATED(publish_id)
                                            ├─ error resp ───▶ INIT_FAILED   (terminal, clean — nothing posted)
                                            └─ transport ────▶ SEND_AMBIGUOUS (terminal, may have posted)
INITIATED ─▶ [UPLOADING ─▶ UPLOADED]file ─▶ POLLING ─▶ PUBLISHED | FAILED | TIMEOUT
```

**How the window closes**: an `intent` with no `outcome`, or a `send_ambiguous`
outcome, is exactly the "did it post?" ambiguity (Arch F2, QA F-2, AI/DX F4). Two
consumers: (1) `tiktok_list_publish_journal` (AI/DX F4 — adopted; package `publish`,
`openWorldHint: false`) renders these as `outcome: "unknown"`; (2) the **plan step
warns**: when an unresolved intent exists for the same profile within the last 10
minutes, the preview's hints include a server-authored warning ("A publish attempt at
14:31Z has unknown outcome — check the journal/status before applying."). Warn-at-plan,
**never hard-block** — a local file cannot prove upstream state, and a stale
unresolved row must not brick posting.

**Failure & retention**: intent-append failure ⇒ proceed, but force
`journal: "unavailable"` into the result (§ 2.3 QA F-10 refinement); outcome-append
failure ⇒ warning + hint. Rotation at `TT_JOURNAL_MAX_BYTES` (default 5 MiB) →
`journal.ndjson.1`, one generation kept; rotation only immediately before an intent
append; the reader merges both generations (DevOps F9 refinement).

### 3.7 PACKAGES manifest layer violation (Arch F6) — resolved

Ratify the predecessor's preferred option (a), with the concrete contract:

- `src/tools/index.ts` owns the manifest: it imports each tool file's `specs` array and
  exports `PACKAGES: PackageManifest[]`. The `mcp` layer **stops importing tools**;
  the entry point wires them: `registerAllTools(server, PACKAGES)`.
- Types flow downward (tools → mcp is a legal import direction):

```ts
// src/mcp/define.ts
export interface ToolAnnotations {           // all four REQUIRED — no MCP-default surprises (AI/DX F2)
  readOnlyHint: boolean; destructiveHint: boolean;
  idempotentHint: boolean; openWorldHint: boolean;
}
export interface PackageManifest { name: string; specs: AnyToolSpec[]; }

// src/mcp/registry.ts
export function registerAllTools(server: McpServer, packages: PackageManifest[]): void;
export function describeTools(packages: PackageManifest[]): ToolSurfaceSnapshot;
```

- The existing invariant loop (spec.package must match its manifest entry) moves into
  `registerAllTools`. Snapshot test, README generator, and `server.json` generator all
  consume `describeTools(PACKAGES)` — one source, four consumers (ties DevOps F5).

### 3.8 `core` profile implementability (Arch F7) — resolved by package split

Ratify option (a): split the `publish` package by risk class —
**`publish`** (reads: `tiktok_get_creator_info`, `tiktok_get_publish_status`,
`tiktok_list_publish_journal`) and **`publish-write`**
(`tiktok_post_video`, `tiktok_upload_video_draft`, `tiktok_post_photos`,
`tiktok_upload_photos_draft` after the AI/DX F3 split). Profiles: `core` =
`auth,user,video,publish` (now exactly implementable at package granularity); `all` =
`core` + `publish-write`. **Intra-package read/write filtering is rejected** as a
mechanism: filtering registration by annotation would couple the registry to hint
correctness (hints are advisory metadata, not policy), and package-granular policy is
what `TT_TOOL_PACKAGES` / `TT_PACKAGES_READONLY` / `TT_PACKAGES_DENY` already mean.
`TT_PACKAGES_READONLY` simply forces `publish-write` off.

### 3.9 Upload long-call handling — recommendation

**Decision: keep `wait_for_completion: true` as the default on both posting tools, and
make MCP progress notifications mandatory implementation behavior** (per chunk PUT
during upload; per poll tick during the status wait) whenever the client supplied a
`progressToken`. This adopts AI/DX F14 and **revises the predecessor's round-1 lean**
(default `false` for `source:"file"`). Justification:

1. For `source:"file"`, the upload itself *is* the call — a 4 GB file at typical uplink
   speeds takes minutes regardless of the wait flag. Flipping the default saves at most
   the 60 s poll out of a possibly multi-minute call: it does not solve client
   timeouts, but it *does* guarantee a dangling `PROCESSING` state on every file post,
   forcing a second call 100 % of the time and doubling the model's chances to do
   something wrong (AI/DX deep-dive C's argument, which I find decisive).
2. Progress notifications are the mechanism MCP provides for exactly this; clients
   that enforce per-call timeouts generally reset them on progress, and clients that
   ignore progress are no worse off than under any default.
3. The failure tail is already covered structurally: the WAJ records the attempt
   before init and the `publish_id` at init success, so even a transport-level client
   timeout is recoverable via `tiktok_list_publish_journal` +
   `tiktok_get_publish_status`. The graceful-timeout result remains the designed
   "instruction sheet" (publish_id, reassurance, exact follow-up call).
4. Uniform defaults (`true` for both file and URL sources) keep the contract learnable;
   a per-source default is a trap for the model and for docs.

Bounding: total in-call time is bounded by `chunks × TT_UPLOAD_TIMEOUT_MS` (per-chunk
timeout) plus `TT_STATUS_POLL_TIMEOUT_MS`; TOOLS.md must state that a timeout result is
normal for large videos and is not a failure.

## 4. New and deepened findings

### N1 — Deterministic confirmation tokens are forgeable by construction

- **Severity: High** (design-phase; would be Critical in code)
- Sec F4's "token derived from a hash of the resolved payload" makes the token a pure
  function of content an attacker controls: an injected instruction that dictates the
  post content can also dictate (and thus precompute) the token, silently converting
  the two-call contract back into one call. Resolution in § 3.1: random token, stored
  digest, timing-safe compare. This interaction was not visible to any single round-1
  review — Sec F4 and AI/DX F1 are individually sound and jointly unsafe.

### N2 — Fixed stale-TTL lock stealing reintroduces the rotation race

- **Severity: High**
- DevOps F8's lockfile sketch with a simple "stale after N seconds" rule fails when
  N < token-endpoint worst-case latency (`TT_TIMEOUT_MS` = 30 s): a waiter declares the
  refreshing holder dead at N seconds, steals the lock, and refreshes concurrently with
  the same soon-to-be-rotated token — the exact lost-update the lock exists to prevent.
  Resolution in § 3.2: heartbeat-refreshed mtime (2 s) with a 15 s staleness horizon
  decouples liveness from critical-section length. Test hook: QA should add a
  "holder alive but slow" scenario alongside the crash-recovery scenario.

### N3 — Plan-hash re-resolution subsumes the apply-time creator_info re-query only if the resolved payload embeds creator-derived fields

- **Severity: Medium**
- Arch F3 required apply to re-run `creator_info`. Under § 3.1 this happens implicitly
  (apply re-resolves the payload), but the drift *detection* only works if every
  creator-derived coercion (privacy level validity, interaction toggles forced off,
  duration cap) is part of the canonicalized payload. The spec must state this
  inclusion rule explicitly, or a future refactor could hash only user args and
  silently reopen the TOCTOU. Amendment A3 carries the normative sentence.

### N4 — One snapshot-reload primitive must serve both marker freshness and rotation pickup

- **Severity: Medium**
- AI/DX F5 (marker staleness) and Arch F1/DevOps F8 (rotation pickup) each imply an
  env-file re-read trigger. Implemented separately they *will* drift (different
  triggers, different consumers, double reads). Resolution: `core/config-store.ts`
  owns one reload path with three triggers (env-file mtime change, `get_auth_status`
  call, auth-shaped error); registry marker re-evaluation + `tools/list_changed`
  emission and token adoption are subscribers. This is now a named design element, not
  an emergent property.

### N5 — Journal is a public contract the moment `tiktok_list_publish_journal` ships

- **Severity: Medium**
- With a read tool over it (AI/DX F4), `journal.ndjson` stops being an internal log:
  its schema needs a version field from the first written line (`"v": 1`), documented
  field semantics, and additive-only evolution rules — otherwise the first schema
  change breaks the tool over users' existing files. § 3.6 includes `v` from day one;
  TOOLS.md must document that unknown-version lines render as `outcome: "unrecognized"`
  rather than erroring.

### N6 — Registry refinement layer for conditional requiredness

- **Severity: Low**
- The § 3.1 flat `apply`/`plan_id` contract and the § 2.5 AI/DX F16 refinement both
  need per-tool `superRefine` logic attached at registration. `ToolSpec` gains an
  optional `refine?: (schema) => schema` hook so refinements live with the spec (data),
  not in the registry (glue). One-line interface addition; prevents refinement logic
  from accreting in `registry.ts`.

### N7 — Plan-store eviction must not be silent for the model

- **Severity: Low**
- With `TT_PLAN_MAX_OUTSTANDING` eviction, a long multi-post planning session can
  invalidate an early plan before its TTL. The `consume()` failure already returns
  `unknown`; the error text must include the re-plan recovery hint identical to the
  `expired` case so the model's recovery path is uniform.

## 5. Spec amendments (ordered)

**A1 — `docs/ARCHITECTURE.md` § 6**: replace the two-column retry matrix with the
§ 3.3 six-row table verbatim (including the lane definitions and the shared-backoff
paragraph). Add: *"Request classification is by path allowlist in `core/http.ts`;
classes 4–6 run on the `auth` lane, which is never queued behind the per-host data
semaphore."*

**A2 — `docs/ARCHITECTURE.md` § 5**: move the PACKAGES manifest to
`src/tools/index.ts`; change the registry contract to
`registerAllTools(server, PACKAGES)` / `describeTools(PACKAGES)` (§ 3.7 interfaces);
state the single-source rule: *"The manifest feeds registration, the snapshot test, the
README tool table, and `server.json` generation."* Record the package split (§ 3.8):
packages `auth`, `user`, `video`, `publish` (reads), `publish-write`; profile
`core = auth,user,video,publish`; `all = core + publish-write`.

**A3 — `docs/ARCHITECTURE.md` § 8**: rewrite plan-and-apply around the § 3.1 contract
(plan_id issuance, TTL, single-use-at-consume, account binding) and the § 3.6 WAJ
(intent before init, outcome per transition, state machine, warn-at-plan rule,
journal-failure semantics, rotation rules). Include the normative sentence from N3:
*"The canonicalized payload hashed into the plan record includes every creator-derived
coercion (resolved privacy level, forced interaction toggles, duration constraints) and
every resolved local fact (canonical file path, file size, chunk plan); apply re-derives
this payload and a digest mismatch is a `plan_invalid` error."*

**A4 — `docs/ARCHITECTURE.md` § 10 + `docs/SECURITY.md` (Redaction)**: redaction moves
to `core/redact.ts` (§ 3.4 interface); delete `mcp/redact.ts` from the module list;
scrub set gains `code`, `code_verifier`, `state`, `upload_token`; add the rules
*"`scrubUrl` strips query strings from every logged or journaled URL"* and *"results
are redacted before truncation."*

**A5 — `docs/AUTH.md` § 2 and § 4**: insert the § 3.2 lock protocol (lock path,
O_EXCL, heartbeat mtime, stale horizon, wait cap), the 4-step refresh sequence
(re-read → refresh under lock → adopt-then-persist read-merge-write → `invalid_grant`
single re-read recovery), and the note that `login` and all `persistEnv` writers use
the same lock. Replace the fixed-port default: *"The callback server binds
`127.0.0.1:0` (ephemeral port; TikTok redirect URIs registered with a wildcard port —
see TIKTOK-API.md); `TT_REDIRECT_PORT` pins a port when needed."*

**A6 — `docs/CONFIGURATION.md`**: add rows — `TT_PLAN_TTL_S=600`,
`TT_PLAN_MAX_OUTSTANDING=32`, `TT_ENV_LOCK_STALE_MS=15000`,
`TT_ENV_LOCK_HEARTBEAT_MS=2000`, `TT_ENV_LOCK_WAIT_MS=30000`,
`TT_JOURNAL_MAX_BYTES=5242880`, `TT_CHUNK_RETRIES=3`, `TT_MEDIA_ROOT` (Sec F3),
optional `TT_VERIFIED_URL_PREFIXES` (advisory, § 2.2). Change `TT_REDIRECT_PORT`
default from `43110` to *(unset — ephemeral)*.

**A7 — `docs/TOOLS.md`**: (i) write tools gain `plan_id` (string, optional; required
when `apply` is true in plan mode — with the exact re-plan error text from AI/DX F1.3);
(ii) add `tiktok_list_publish_journal` (package `publish`; RO; `openWorldHint: false`;
`limit`/`since` inputs; rows per § 3.6 including `outcome: "unknown"`); (iii) split
`tiktok_post_photos` / add `tiktok_upload_photos_draft` (AI/DX F3); (iv) state the full
four-hint tuple for every tool, publish tools `destructiveHint: true` (AI/DX F2);
(v) `wait_for_completion` stays default `true` on both tools with the § 3.9 progress
and timeout-is-normal language; (vi) apply the F7 renames before the manifest freezes.

**A8 — `docs/SECURITY.md`, prompt-injection paragraph**: replace with: *"In `plan` mode
a single injected instruction cannot cause a post: an apply call must present a
`plan_id` that exists only in a prior plan response, the apply payload must
digest-match the previewed payload, and the plan is bound to the account it was issued
for and consumed on first use. An injected message can still lure the model into
initiating a plan, so the preview turn remains the human veto point; where the client
supports MCP elicitation the server additionally requests interactive confirmation on
apply. `TT_WRITE_MODE=apply` disables this mechanism entirely and is intended for
trusted automation, not conversational use."*

**A9 — `docs/TIKTOK-API.md` § 4.2 + `docs/ARCHITECTURE.md`**: record the fixed-chunk
strategy: *"The client always uses `chunk_size` = 64 MiB; files ≤ 64 MiB upload as a
single chunk of the full size; the final chunk absorbs the remainder"* — with the
Plat-review derivation cited. `planChunks()` (§ 3.5) is the only chunk-math authority.

**A10 — `README.md`**: egress list becomes exactly two hosts —
`open.tiktokapis.com` and `open-upload.tiktokapis.com` — plus the loopback callback
during `login` (fixes the "nothing else" claim; Plat F4).

**A11 — `docs/TESTING.md`**: add test areas — env-lock (contention, crash recovery,
*slow-holder heartbeat* per N2, win32 close-then-unlink), plan store (TTL, single-use,
digest mismatch, account mismatch, eviction per N7), WAJ (intent/outcome correlation,
rotation at intent boundary, two-generation reads, append-failure semantics), chunk
uploader (per-chunk retry byte-equality — extends QA deep dive 6.1), request-class
classification table (one test per row of § 3.3).

**A12 — `docs/AUTH.md` § 5 / `docs/TOOLS.md` cross-cutting**: define the marker
lifecycle per AI/DX F5 with the N4 single-reload rule: reload triggers, call-time
scope re-check in handlers, `tools.listChanged` declaration and emission.

## 6. Remaining unknowns

1. **U1 — Rotation grace window**: whether TikTok invalidates the previous refresh
   token immediately on rotation or allows brief overlap. The § 3.2 design assumes the
   worst (immediate); if a grace window exists, the `invalid_grant` re-read path will
   simply fire less often. Verify empirically in Phase 1.
2. **U2 — Init idempotency**: whether re-sending a byte-identical init after an
   ambiguous failure creates a second `publish_id`. No idempotency key is documented;
   the design assumes duplication is possible (hence `send_ambiguous` is terminal).
3. **U3 — Chunk-PUT replay tolerance**: assumed idempotent for an identical
   `Content-Range` (basis of § 3.3 row 3). Verify the 206/201 behavior on a re-sent
   range during Phase 1 contract-fixture recording (QA F-15).
4. **U4 — Client behavior matrix**: which target MCP clients reset per-call timeouts on
   progress notifications, and which support elicitation. Determines how much § 3.9's
   mitigation delivers in practice; `doctor` should report client capabilities when
   detectable.
5. **U5 — creator_info volatility**: how quickly privacy options / duration caps change
   in practice; informs whether `TT_PLAN_TTL_S=600` is too generous. Tunable, not
   structural.
6. **U6 — Token value prefixes** (`act.` / `rft.`): confirm before enabling
   value-pattern scrubbing in `core/redact.ts`.
7. **U7 — Windows support decision** (DevOps F1): the § 3.2 lock and § 3.6 journal are
   win32-compatible by design, but the platform decision (supported with ACL-based
   protection vs. unsupported) is still open and owned by the DevOps track.
8. **U8 — `upload_url` structural stability**: whether the URL's host is always
   `open-upload.tiktokapis.com` or region-variant; affects how strict the `chunk_put`
   host allowlist can be. Record at contract-fixture time.
