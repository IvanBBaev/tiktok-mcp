# TOOLS.md — MCP tool surface v1.1 (normative)

This document is the normative specification of the MCP tool surface: tool names,
packages, annotations, input schemas, result shapes, error codes and texts, hints,
and the write-safety contract. It states the round-2 synthesis outcomes directly;
implementation and tests follow this document, not the reviews. Error `message`
texts and `.describe()` strings below are **normative and substring-tested**.
Sparse `rationale:` cross-references point at `docs/reviews/round2/` for the
reasoning only — no normative statement requires reading them.

Related documents: `CONTRACTS.md` (module interfaces), `CORNER-CASES.md` (CC-*
decisions referenced below), `CONFIGURATION.md` (every `TT_*` variable),
`TIKTOK-API.md` (upstream behavior), `SECURITY.md`, `TESTING.md`.

Conventions:

- Tool names follow `tiktok_<verb>_<noun>`.
- All input schemas are zod `.strict()` — unknown keys are rejected by name
  before any network activity (CC-G1).
- "Direct-post tools" = `tiktok_post_video`, `tiktok_post_photos`.
  "Draft tools" = `tiktok_upload_video_draft`, `tiktok_upload_photos_draft`.
  "Write tools" = all four.
- All lengths for user text are counted in **UTF-16 code units** (the way TikTok
  counts; an emoji counts as 2).
- All timestamps in results, hints, and error texts are **absolute ISO-8601 UTC**.

---

## 1. Surface at a glance

**11 tools, 5 packages.** (rationale: SYNTHESIS § 2.9)

| # | Tool | Package | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Required scope |
|---|---|---|---|---|---|---|---|
| 1 | `tiktok_get_auth_status` | auth | true | false | true | true | — |
| 2 | `tiktok_get_user_info` | user | true | false | true | true | `user.info.basic` (+ optional `user.info.profile`, `user.info.stats`) |
| 3 | `tiktok_list_videos` | video | true | false | true | true | `video.list` |
| 4 | `tiktok_query_videos` | video | true | false | true | true | `video.list` |
| 5 | `tiktok_get_creator_info` | publish | true | false | true | true | `video.publish` |
| 6 | `tiktok_get_publish_status` | publish | true | false | true | true | `video.publish` or `video.upload` |
| 7 | `tiktok_list_publish_journal` | publish | true | false | true | **false** | — |
| 8 | `tiktok_post_video` | publish-write | false | **true** | false | true | `video.publish` |
| 9 | `tiktok_upload_video_draft` | publish-write | false | **true** | false | true | `video.upload` |
| 10 | `tiktok_post_photos` | publish-write | false | **true** | false | true | `video.publish` |
| 11 | `tiktok_upload_photos_draft` | publish-write | false | **true** | false | true | `video.upload` |

**Packages.** `auth`, `user`, `video`, `publish` (read-only publishing context:
creator info, publish status, journal), `publish-write` (the four destructive
writes). Package profiles: `core` = auth + user + video + publish (no
writes); `all` = everything. `TT_WRITE_MODE=deny` unregisters
`publish-write` and wins over any profile setting (see § 2.6.4 and
CONFIGURATION.md).

**Annotation justifications** (all four MCP annotation hints are required on
every tool):

- Read tools: `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true` (repeat calls observe, never mutate),
  `openWorldHint: true` (they consult the upstream API) — except
  `tiktok_list_publish_journal`, the one closed-world tool
  (`openWorldHint: false`): it reads a local file only, and its results are
  fully determined by prior local writes.
- Write tools: `destructiveHint: true` because a published post (or delivered
  draft) **cannot be edited or deleted through this server** — an irreversible
  external effect, which is exactly what the hint exists to signal;
  `idempotentHint: false` because re-invocation creates a new publish attempt.

**Manifest in code.** `src/tools/index.ts` exports one `PACKAGES` structure —
the single source consumed by (1) server registration, (2) the manifest
snapshot test, (3) README tool-table generation, (4) `server.json` generation.
The table above is what that snapshot is checked against; doc and code must not
drift.

---

## 2. Common contract (applies to every tool)

### 2.1 Result envelope

Every tool returns:

```jsonc
{
  "ok": boolean,
  "data": { ... },                    // present when ok: true
  "error": {                          // present when ok: false
    "code": string,                   // stable machine code from § 3.0
    "message": string,                // normative catalog text (substring-tested)
    "retryable": boolean,
    "log_id": string,                 // optional; upstream log id when one exists
    "details": { ... }                // optional; e.g. details.api_code (§ 3.0 notes)
  },
  "hints": Hint[],                    // optional; § 5, max 3
  "journal": "unavailable"            // optional; § 2.9 — journal append failed
}
```

- Delivered as `structuredContent` with a declared `outputSchema`; a
  human/model-readable text block mirrors it and is authoritative when they
  diverge.
- `ok: false` ⇒ MCP `isError: true`.
- `data.meta.account` echoes the resolved profile name on every call.
- Output is always valid JSON, whatever gets truncated (CC-G2); truncation
  never removes `ok`, `error`, or `hints` (CC-G7).

### 2.2 The `account` parameter

Auto-injected into every tool schema:

- Type: `string`, optional.
- `.describe()` (normative): *"Profile name from the server configuration. Omit
  to use the default profile. Unknown names fail locally without contacting
  TikTok."*
- Unknown value ⇒ local error `unknown_account` (§ 3.0). When
  `TT_LOCK_PROFILE` is set, any explicit `account` other than the locked
  profile fails the same way.
- Exception: on `tiktok_list_publish_journal` the parameter is a **filter**,
  not a profile resolution — see § 3.7.

### 2.3 Validation before network

Every locally checkable constraint — schema shape, lengths in UTF-16 code
units, enum membership, URL prefixes, media-root containment, toggle
conflicts — fails **before any fetch**, with `invalid_params` or a more
specific local code from § 3.0. Local validation failures never consume rate
budget, never mint a `plan_id`, and never touch the network.

### 2.4 Truncation

Oversized results are shaped by dropping trailing items, never fields
mid-item. `data.meta.truncation = { truncated: true, reason: "char_budget" |
"item_cap", returned, resume_cursor? }`, plus a cause-specific `note` hint.
Truncation runs after redaction, never splits a UTF-16 surrogate pair, and
never removes `ok`/`error`/`hints` (CC-G7).

### 2.5 Token discipline

No access token, refresh token, `upload_url`, or `upload_token` ever appears
in any result, hint, error message, progress notification, or journal line.

### 2.6 Write safety — the plan/execute contract

One mechanism gates all four write tools. (rationale: SYNTHESIS § 2.8)

**There is no `apply` parameter.** The `apply` boolean is deleted from the
surface. The presence of `plan_id` alone selects the step:

- Call **without `plan_id`** ⇒ **preview**. Nothing is posted.
- Call **with `plan_id`** ⇒ **execute** the previously previewed payload.

#### 2.6.1 Preview (no `plan_id`)

1. Full local validation (§ 2.3).
2. Conditional pre-flight: **direct-post tools** run `creator_info` upstream
   and embed the result (live `privacy_level_options`, forced toggles, max
   duration). **Draft tools skip the pre-flight entirely** — they require only
   `video.upload`, and the draft endpoints take no privacy/toggle fields.
3. For `source: "file"`: the file is stat'ed (existence, regular file,
   media-root containment, size, chunk plan).
4. **`privacy_level` missing on a direct-post tool** ⇒ the preview returns
   `mode: "plan_incomplete"`, **no `plan_id` is minted**, and the result lists
   the live `privacy_level_options` plus `missing: ["privacy_level"]`. There
   is no default privacy level; no execution token can exist until the user
   has chosen one.
5. Otherwise the preview returns `mode: "plan"` with: `plan_id`, `expires_at`
   (now + `TT_PLAN_TTL_S`, default 600 s), the resolved target account
   (`profile`, `nickname`, `open_id_masked`), the `action`, the exact
   `payload` to be sent, `derived: [{ field, value, reason }]` for every value
   the server forced or defaulted, the embedded `creator` block and
   `audit_restrictions_active` (direct-post tools only), a `consent_line`
   ("Music Usage Confirmation", or "Branded Content Policy" when a brand
   toggle is set), and an `approval_required` hint (§ 5).
6. A preview makes **no publish/init/upload request**. The `creator_info`
   pre-flight is the only network call a preview may perform, and only on
   direct-post tools. A preview always succeeds regardless of the local rate
   bucket and reports current bucket occupancy in
   `data.meta.rate_bucket = { tokens_available, next_token_at }` (§ 2.8).

#### 2.6.2 The plan token and store

- **Token format:** `plan_` + 32 lowercase hex characters (16 bytes from
  `crypto.randomBytes`). Random, never derived from the payload. Digest
  comparisons use `timingSafeEqual`.
- **Digest:** SHA-256 over the **fully resolved upstream payload** —
  `post_info` + source info (canonical absolute file path, file size,
  chunk-plan summary, or validated `video_url` / photo URL list) + resolved
  `post_mode` — serialized by the single exported `canonicalJson()`
  (`core/json.ts`: recursively sorted keys, no whitespace, UTF-8, absent ≡
  undefined ≡ omitted). Control fields (`plan_id`, `force`,
  `wait_for_completion`) are not payload and never enter the digest. The
  duplicate guard (§ 2.6.5) reuses the same function.
- **Store:** in-process memory only, never persisted — a server restart
  invalidates all plans, and re-preview is the *designed* recovery.
  `Map<plan_id, { digest, profile, open_id, tool, created_at, used }>`; cap
  `TT_PLAN_MAX_OUTSTANDING` = 32 (oldest evicted); TTL `TT_PLAN_TTL_S` = 600.

#### 2.6.3 Execute (`plan_id` present) — pipeline order is normative

1. Full local validation (§ 2.3), as in the preview.
2. Local rate bucket check (§ 2.8): an empty bucket rejects with
   `local_rate_limited` — zero network, nothing consumed, the plan is **not**
   consumed.
3. **Re-resolve** the payload through the same code path as the preview:
   re-stat the file (size/mtime/dev/ino must match the preview's resolution),
   re-run the `creator_info` pre-flight on direct-post tools.
4. Compute digest′ over the re-resolved payload.
5. **Verify the plan**: exists ∧ not used ∧ not expired ∧ tool matches ∧
   digest matches ∧ open_id matches. The internal failure enum {unknown,
   expired, already_used, payload_mismatch, account_mismatch, tool_mismatch}
   is surfaced as **exactly two** error codes: `plan_not_found`
   (unknown/expired/already_used) and `plan_mismatch`
   (payload/account/tool), with the § 3.0 texts.
6. **Duplicate guard** (§ 2.6.5), unless `force: true`. A
   `possible_duplicate` rejection happens **before** consumption, so the same
   `plan_id` may be re-applied with `force` within its TTL after the user
   verifies.
7. **Consume the plan atomically** (mark used) — *before* the init request is
   dispatched (CC-E7). A failed apply after this point always requires a
   fresh preview; a consumed plan is never revived.
8. Journal intent append, fsync'd (§ 2.9).
9. Init dispatch (and chunk PUTs for `source: "file"`), then journal outcome
   append.

`force: true` overrides **only the duplicate guard**. It never bypasses
validation, the plan verification, the rate bucket, or the write mode.

#### 2.6.4 `TT_WRITE_MODE`

| Value | Behavior |
|---|---|
| `plan` (default) | The contract above: preview without `plan_id`, execute with it. |
| `apply` | `plan_id` becomes optional: a call without it executes immediately (validation, pre-flight, duplicate guard, rate bucket, and journal still apply). Trusted automation only: this mode has no injection resistance. |
| `deny` | The `publish-write` package is not registered. No runtime error path exists because the tools do not exist. `deny` wins over any package profile. |

#### 2.6.5 Duplicate guard

The guard scans a bounded tail of the journal's active generation. A prior
attempt with the **same payload digest** within the last **10 minutes** whose
outcome is `ok` or `unknown` (including `send_ambiguous`, § 2.9) trips
`possible_duplicate` unless `force: true`. Outcomes `error` and
`upload_failed` never trip the guard — clean failures are freely retryable
with a fresh preview.

### 2.7 `wait_for_completion` policy

(rationale: SYNTHESIS § 2.3)

- **Default `false` on all four write tools; default `true` on
  `tiktok_get_publish_status`.**
- A write apply returns `publish_id` **immediately**, plus a `poll` hint
  carrying the exact tool name (`tiktok_get_publish_status`), the
  `publish_id`, and an **absolute** `poll_after` timestamp.
- `tiktok_get_publish_status` performs the bounded wait internally: it polls
  on a backoff schedule (2 s, then 5 s, then every 10 s, with jitter) up to
  ~60 s (`TT_STATUS_POLL_TIMEOUT_MS`).
  - **Terminal-beats-deadline:** a terminal status (`PUBLISH_COMPLETE`,
    `SEND_TO_USER_INBOX`, `FAILED`) observed before the deadline returns
    immediately.
  - **Timeout-is-not-error:** hitting the deadline returns `ok: true` with
    the last observed status, `publish_id`, and a fresh `poll` hint. A
    timeout is never surfaced as a failure.
- `wait_for_completion: true` remains an explicit opt-in on write tools; its
  `.describe()` warns that long calls risk client timeouts and that a
  timed-out write call must never be re-run blindly.
- During chunked uploads the server emits per-chunk MCP progress
  notifications (when the client supplied a `progressToken`), regardless of
  `wait_for_completion`.

### 2.8 Local rate limiting

(rationale: SYNTHESIS § 2.12)

- **Publish inits:** a local token bucket per profile — capacity 6/min,
  continuous refill (1 token per 10 s). An empty bucket rejects the execute
  step **locally** with `local_rate_limited`, carrying `retry_after_s` and an
  absolute `retry_at`, plus a `wait` hint. Zero network; the server never
  sleeps a write call.
- A **preview always succeeds** regardless of the bucket and reports
  occupancy in `data.meta.rate_bucket` (§ 2.6.1).
- **Reads delay instead of rejecting:** status polls are bounded by the poll
  budget (§ 2.7); `tiktok_get_creator_info` waits for a token up to
  `TT_TIMEOUT_MS`, then fails with `local_rate_limited`.
- Buckets are per-profile and run on the injected clock.
- The local bucket is a **courtesy, not the enforcement point** (CC-B8): an
  upstream 429 on an init is terminal for that attempt and is surfaced as
  `rate_limited`.

### 2.9 Journal write-ahead (surface view)

(rationale: SYNTHESIS § 2.7; full mechanics in ARCHITECTURE.md)

- Every execute appends a fsync'd **intent** record *before* the init request,
  and an **outcome** record after the response (or terminal upload failure).
- Persisted outcome vocabulary: `ok` (init accepted, `publish_id` recorded) ·
  `error` (clean failure; known-unsent transport failures carry
  `error_code: "network_unsent"`) · `upload_failed` (init ok, chunk upload
  aborted) · `send_ambiguous` (transport failure after the request may have
  been sent). `unknown` is **derived at read time** (an intent with no
  outcome record — e.g. a crash mid-publish) and is never persisted.
- A journal append failure is a warning, never a publish failure: the result
  then carries top-level `journal: "unavailable"` plus a `note` hint telling
  the model the attempt was not recorded.
- The journal record shape is a **public contract** from the moment
  `tiktok_list_publish_journal` ships: fields are **additive-only under
  `v:1`**; any incompatible shape change requires a version bump.

---

## 3. Per-tool reference

### 3.0 Shared error catalog

Stable machine codes with **normative message texts** (`<...>` are
server-filled placeholders; texts are asserted by substring in the test
suite). Write tools inherit the entire catalog; read tools inherit the first
seven. Per-tool sections list only additions.

**All tools:**

| Code | Retryable | Message text (normative) |
|---|---|---|
| `invalid_params` | no | "Invalid arguments: <field>: <local validation reason>. Fix the arguments and call again. No request was sent to TikTok." |
| `unknown_account` | no | "Unknown account '<name>'. Configured profiles: <list>. Omit account to use the default profile ('<default>')." |
| `missing_scope` | no | "Account '<profile>' was authorized without scope <scope>, which this tool requires. Ask the user to run: npx tiktok-mcp-ai login --profile <profile> --scopes <scope> — then verify with tiktok_get_auth_status." |
| `auth_expired` | no | "TikTok rejected the token for account '<profile>' and automatic refresh failed. Ask the user to run: npx tiktok-mcp-ai login --profile <profile>. Do not retry this call until re-login completes." |
| `rate_limited` | yes | "TikTok rate limit reached for this endpoint. Wait until <retry_at> (<retry_after_s> s) and call again. Do not retry earlier." |
| `upstream_error` | varies | "TikTok returned an error: <mapped taxonomy category — never raw upstream text>. log_id <log_id> (quote this when contacting TikTok support). <recovery action per taxonomy class>." |
| `env_file_busy` | yes | "Another tiktok-mcp-ai process is updating the credential file for account '<profile>' and did not finish within <wait_s> s. No request was sent to TikTok. Wait a few seconds and call again. If this repeats, ask the user to run: npx tiktok-mcp-ai doctor — it reports stale locks and how to clear them." |

**Write tools only:**

| Code | Retryable | Message text (normative) |
|---|---|---|
| `local_rate_limited` | yes | "This server's publish limiter (6/min) rejected the call to protect the account from TikTok's spam systems. Wait until <retry_at> (<retry_after_s> s), then apply again with a fresh preview." |
| `daily_post_cap` | no | "TikTok reports this account reached its daily posting limit (~15 posts/24 h, shared across ALL apps posting via the API, not only this server). Do not retry today. Tell the user; posting resumes as the 24 h window rolls." |
| `active_user_cap` | no | "This app is unaudited and already served its maximum of 5 posting users in the last 24 h (reached_active_user_cap). Do not retry today. The permanent fix is the developer passing TikTok's app audit." |
| `pending_share_cap` | no | "TikTok blocked this draft: the account already has 5 unpublished API drafts from the last 24 h (spam_risk_too_many_pending_share). Ask the user to open TikTok's inbox notifications and publish or discard pending drafts, then try again." |
| `plan_not_found` | no | "This plan_id is unknown, already used, or expired (plans are single-use and expire <ttl> minutes after the preview). Call the tool again WITHOUT plan_id to generate a fresh preview, show it to the user, and apply with the new plan_id only after the user approves." |
| `plan_mismatch` | no | "The arguments (or the target account) differ from what this plan_id previewed. A plan applies only the exact previewed payload. Call the tool again WITHOUT plan_id to preview the changed arguments, show the new preview to the user, then apply with the new plan_id." |
| `possible_duplicate` | no | "A publish attempt with this title on account '<profile>' was journaled at <ts> with outcome '<ok\|unknown>'<, publish_id <id>>. Verify with tiktok_get_publish_status and tiktok_list_publish_journal that no post was created. Only if confirmed, re-preview and apply with force: true." |
| `network_unsent` | no | "The network failed before the publish request was sent — TikTok received nothing and no post was created (journal outcome 'error'). When the connection recovers, generate a fresh preview and apply with the new plan_id." |
| `network_ambiguous` | no | "The network failed after the publish request may already have been sent — the post MAY exist upstream. Do NOT apply again. Check tiktok_list_publish_journal (the latest entry will show outcome 'unknown') and tiktok_get_publish_status or tiktok_list_videos first; retry only if no post exists, with a fresh preview." |
| `media_root_not_configured` | no | "source \"file\" is disabled: the operator has not set TT_MEDIA_ROOT (the only directory this server may read media from). Ask the user to set TT_MEDIA_ROOT in the server configuration and restart, or host the media on a verified URL and use source \"url\"." |
| `file_outside_media_root` | no | "file_path resolves to <resolved_abs_path>, which is outside the configured media root <TT_MEDIA_ROOT>. This server only reads media inside that directory (operator policy). Ask the user to move the file there or to change TT_MEDIA_ROOT. Do not attempt alternative paths." |
| `file_not_found` | no | "file_path <resolved_abs_path> does not exist or is not a regular file. Ask the user for the correct path under <TT_MEDIA_ROOT>." |
| `file_too_large` | no | "The file is <size> bytes; TikTok's maximum is <cap>. The user must shorten or re-encode the video." |
| `url_prefix_unverified` | no | "<field> does not match any verified URL prefix configured in TT_VERIFIED_URL_PREFIXES. TikTok only pulls media from domains its developer verified in the TikTok developer portal — this is a platform rule, not a server setting. Use source \"file\" for local video files, or ask the user to host the media under a verified prefix. No request was sent." |
| `upload_interrupted` | no | "Upload failed at chunk <i>/<n> after automatic retries (publish_id <publish_id>). The upload cannot be resumed; TikTok will expire this attempt on its own. Check tiktok_get_publish_status for <publish_id>; if the user still wants the post, generate a fresh preview and apply again — that creates a NEW publish attempt." |
| `privacy_level_unavailable` | no | "privacy_level '<value>' is not available for this account right now. Available options: <comma-separated enum values from creator_info>. Re-preview with one of these. (Unaudited apps allow only SELF_ONLY.)" |
| `branded_content_privacy_conflict` | no | "brand_content_toggle: true cannot be combined with privacy_level SELF_ONLY — TikTok rejects branded content on private-visibility posts. While this app is unaudited, only SELF_ONLY is available, so branded-content posting is not possible at all. Either drop the brand toggle or wait until the app passes TikTok's audit." |

**Per-tool additions** (defined in their sections): `publish_not_found`
(§ 3.6), `journal_unreadable` (§ 3.7).

Notes:

- `upstream_error` message composition never interpolates upstream free text
  (trust boundary, § 5); it names the mapped taxonomy class and preserves
  `log_id` in the structured field.
- Upstream cap/verification codes are remapped: `spam_risk_too_many_posts` →
  `daily_post_cap`, `reached_active_user_cap` → `active_user_cap`,
  `spam_risk_too_many_pending_share` → `pending_share_cap`,
  `url_ownership_unverified` → `url_prefix_unverified`. The original upstream
  code is preserved in `error.details.api_code`.
- `env_file_busy` is surfaced only after the lock-wait fallback (wait up to
  the lock timeout, re-read the env file once, adopt a token rotated by the
  other process if one appeared) has failed to make progress
  (rationale: SYNTHESIS § 2.2).
- Scope failures: a call whose resolved profile lacks a required scope fails
  with `missing_scope` at call time — authoritative regardless of any
  `[UNAVAILABLE: ...]` description marker (§ 6).

### 3.1 `tiktok_get_auth_status`

- **Package:** `auth`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`
  (network only when `probe: true`; the tuple describes capability, not the
  common case).
- **Scopes:** none.
- **Description** (normative):

  > Report authentication status for the configured TikTok profile(s): granted
  > scopes, token expiry, and which tool packages are usable per profile.
  > Local and instant by default; set probe: true to additionally verify the
  > token against TikTok with a single user-info call. Call this first when
  > any tool reports an auth or scope error, and again after the user re-runs
  > the login CLI. Never returns token material.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | configured profile | (common, § 2.2) |
  | `probe` | boolean | no | default `false` | "true = make one live user-info request to confirm the token works. false (default) = report from local state only, no network." |

- **Output:** `{ profiles: [{ name, is_default, open_id_masked,
  scopes: string[], token_expires_at, refresh_expires_at, packages: { auth:
  "ok", video: "ok" | "missing_scope:video.list", publish: ...,
  "publish-write": ... }, probe?: { ok, checked_at } }] }` — the per-profile ×
  per-package availability matrix (§ 6, item 4).
- **Errors:** shared catalog only (`probe: true` can surface `auth_expired`).
- **Hints:** `reauth` when any profile's token is expired/rejected;
  `user_action` when a package is unavailable for every profile (text mirrors
  the § 6 marker).

### 3.2 `tiktok_get_user_info`

- **Package:** `user`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- **Scopes:** `user.info.basic`; fields covered by `user.info.profile` /
  `user.info.stats` are included only when those scopes are granted.
- **Description** (normative):

  > Fetch the authenticated TikTok user's profile: display name, avatar, bio,
  > and counts (followers, following, likes, videos). With the
  > user.info.profile scope it also returns the @username and profile link.
  > Read-only. Requested fields not covered by the granted scopes are omitted
  > and listed in meta.omitted_fields — that is not an error. Avatar URLs are
  > TikTok CDN links that expire after roughly 6 hours; do not store them
  > long-term.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `fields` | string[] | no | enum of documented user fields; default = all grantable | "Profile fields to return. Omit for all fields your scopes allow. Unknown field names fail locally." |

- **Output:** `{ user: { open_id_masked, display_name, avatar_url?,
  bio_description?, username?, profile_web_link?, follower_count?,
  following_count?, likes_count?, video_count? }, meta:
  { omitted_fields: string[] } }`.
- **Errors:** shared catalog only.

### 3.3 `tiktok_list_videos`

- **Package:** `video`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- **Scopes:** `video.list`.
- **Description** (normative):

  > List the authenticated user's PUBLIC videos, newest first, up to 20 per
  > page. Pass cursor from the previous result to get the next page, or set
  > fetch_all: true to auto-paginate up to the server cap. Read-only. TikTok's
  > Display API never returns private or friends-only videos — an
  > incomplete-looking list is usually privacy, not an error. share_url is the
  > stable link to give the user; media/cover URLs expire in about 6 hours.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `cursor` | string | no | opaque (CC-C1) | "Opaque pagination token from the previous result's meta.next_cursor. Pass it back unchanged. Do not construct this value yourself." |
  | `max_count` | integer | no | 1–20, default 20; out-of-range values are clamped locally and noted in the result (CC-C5) | "Videos per page (1–20)." |
  | `fetch_all` | boolean | no | default `false` | "true = follow pagination automatically until done or the server cap (default 200 items) is hit; the result then reports truncation with a resume cursor." |
  | `fields` | string[] | no | enum; default set excludes `cover_image_url` | "Video fields to return. Omit for the default set (id, title, create_time, duration, stats, share_url)." |

- **Output:** `{ videos: [...], meta: { has_more, next_cursor?,
  truncation? } }`.
- **Errors:** shared catalog only. Cursor-loop guard (CC-C2): a non-advancing
  upstream cursor terminates the fetch with `truncated: true` and a `note`
  hint.

### 3.4 `tiktok_query_videos`

- **Package:** `video`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- **Scopes:** `video.list`.
- **Description** (normative):

  > Fetch full details for up to 20 specific videos by id. Ids come from
  > tiktok_list_videos or from the user. Read-only. Ids that do not belong to
  > the authenticated user are silently absent from the response — TikTok does
  > not report them as errors — so compare the returned ids against the
  > requested ones.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `video_ids` | string[] | yes | 1–20 items, non-empty strings; more than 20 fails locally (CC-C6) | "TikTok video ids to fetch (max 20 per call). More than 20 fails locally — split into batches." |
  | `fields` | string[] | no | as § 3.3 | (as § 3.3) |

- **Output:** `{ videos: [...], meta: { requested, returned,
  missing_ids: [...] } }` (CC-C7).
- **Errors:** shared catalog only.

### 3.5 `tiktok_get_creator_info`

- **Package:** `publish`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- **Scopes:** `video.publish`.
- **Description** (normative):

  > Fetch the creator's live posting state: nickname, the privacy_level
  > options currently available, whether comments/duets/stitch are disabled
  > account-wide, and the maximum allowed video duration. Requires scope
  > video.publish; TikTok limit 20 requests/min. You do NOT need to call this
  > before posting — the preview step of tiktok_post_video and
  > tiktok_post_photos runs it automatically and embeds the result. Call it
  > directly only to answer user questions about posting capabilities. If
  > privacy_level_options contains only SELF_ONLY, the app is unaudited:
  > every post will be visible to the account owner only, regardless of
  > arguments.

- **Input schema:** `account` only.
- **Output:** `{ creator: { nickname, privacy_level_options: string[],
  comment_disabled, duet_disabled, stitch_disabled,
  max_video_post_duration_sec }, audit_restrictions_active: boolean }` — the
  derived flag is `true` when the options are exactly `["SELF_ONLY"]`, with an
  explanatory `note` hint.
- **Errors:** shared catalog (notably `missing_scope` on draft-only
  profiles — the draft tools' descriptions tell the model it never needs this
  call). Under local rate pressure this tool waits for a bucket token up to
  `TT_TIMEOUT_MS`, then fails with `local_rate_limited` (§ 2.8).

### 3.6 `tiktok_get_publish_status`

- **Package:** `publish`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- **Scopes:** `video.publish` **or** `video.upload` (either suffices).
- **Description** (normative):

  > Check — and by default briefly wait on — the status of a publish attempt
  > by publish_id. Read-only, idempotent, safe to repeat; TikTok limit 30
  > requests/min. Statuses: PROCESSING_DOWNLOAD (pulling from URL),
  > PROCESSING_UPLOAD (checking the uploaded file), SEND_TO_USER_INBOX (draft
  > delivered — the user must open the TikTok app notification to finish),
  > PUBLISH_COMPLETE (live; public_post_id present when TikTok exposes it),
  > FAILED (fail_reason mapped to a recovery action in the result). With
  > wait_for_completion: true (the default) the call polls on a backoff
  > schedule (2 s, then 5 s, then every 10 s, with jitter) up to ~60 s and
  > returns the last observed status; a timeout is NOT a failure — call again
  > with the same publish_id. Never re-run a posting tool just because
  > processing is slow.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `publish_id` | string | yes | non-empty | "The publish_id returned by a posting tool (or found in tiktok_list_publish_journal)." |
  | `wait_for_completion` | boolean | no | **default `true`** | "true (default) = poll internally until a terminal status or ~60 s, then return the last observed status. false = one status request, return immediately." |

- **Output:** `{ status, fail_reason?, fail_recovery?, public_post_id?,
  uploaded_bytes?, downloaded_bytes?, checked_at }`. `publish_id` is always
  present in the result, including on a poll timeout. `public_post_id` is
  normalized from upstream's misspelled `publicaly_available_post_id` (both
  spellings accepted). `fail_recovery` carries the normative text from
  Appendix A for the reported `fail_reason`.
- **Wait semantics:** terminal-beats-deadline; timeout-is-not-error (§ 2.7).
  On timeout the result carries a `poll` hint with a fresh absolute
  `poll_after`.
- **Errors:** shared catalog; plus:

  | Code | Retryable | Message text (normative) |
  |---|---|---|
  | `publish_not_found` | no | "TikTok has no record of this publish_id — it may be expired (status is retained only for a limited window) or from another app. Check tiktok_list_publish_journal for the attempt and tiktok_list_videos for the result." |

  The wording is deliberately hedged: the upstream retention window for
  publish status is not documented (probe P-1); the tool must not claim more
  than TikTok guarantees.

### 3.7 `tiktok_list_publish_journal`

- **Package:** `publish`. **Annotations:** `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`, **`openWorldHint: false`**
  — the one closed-world tool: a local file read; no external system is
  consulted, and results are fully determined by prior local writes.
- **Scopes:** none. No network.
- **Description** (normative):

  > Read this server's local, append-only journal of publish attempts:
  > timestamp, account, tool, title excerpt, publish_id, and outcome.
  > Outcomes: "ok" (upstream accepted the request), "error" (clean failure),
  > "upload_failed" (init succeeded, upload aborted), "unknown" (the request
  > was sent but no response was recorded — the post MAY exist; verify with
  > tiktok_get_publish_status or tiktok_list_videos before retrying
  > anything). Local file read; no network, no scopes required. Check this
  > first before re-trying any failed or ambiguous publish. The journal only
  > covers posts made through this server on this machine.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | "Filter to one profile. Omit for all profiles." (a filter, not a profile resolution — no default profile is applied) |
  | `limit` | integer | no | 1–100, default 20 | "Newest entries to return." |
  | `since` | string | no | ISO-8601 | "Only entries at or after this UTC timestamp." |

- **Output:** `{ entries: [{ ts, account, tool, title_excerpt, publish_id?,
  outcome, error_code? }], meta: { journal_path, total_matching,
  skipped_lines } }` — `skipped_lines` counts torn-tail or
  unknown-version lines the reader ignored.
- **Outcome presentation (normative):** entries are folded from
  intent/outcome record pairs by `attempt_id`. The read-side outcome
  vocabulary is exactly `ok` · `error` · `upload_failed` · `unknown`. The
  persisted `send_ambiguous` outcome **is presented as `unknown`** — the
  operational meaning is identical (the post MAY exist; verify before
  retrying); only the doctor CLI keeps the distinction. `unknown` also covers
  an intent with no outcome record (crash mid-publish, CC-E10).
- **Contract stability:** the journal record shape is a public contract from
  the moment this tool ships — additive-only under `v:1`; incompatible
  changes require a version bump (§ 2.9).
- **Errors:**

  | Code | Retryable | Message text (normative) |
  |---|---|---|
  | `journal_unreadable` | no | "The journal file at <path> is missing or unreadable. Publishes may still have happened — verify with tiktok_list_videos. Ask the user to check the file if an audit trail is required." |

### 3.8 `tiktok_post_video`

- **Package:** `publish-write`. **Annotations:** `readOnlyHint: false`,
  **`destructiveHint: true`**, `idempotentHint: false`, `openWorldHint: true`.
  Justification: publishes irreversibly to a live account; re-invocation
  creates a new post.
- **Scopes:** `video.publish`.
- **Description** (normative, full):

  > Post a video DIRECTLY to the authenticated account's TikTok profile — it
  > goes live without further user action once TikTok finishes processing.
  > Requires scope video.publish. Use when the user says "post/publish this
  > video". NOT for "send it to my drafts" — use tiktok_upload_video_draft
  > for that. Posts cannot be edited or deleted through this server; removal
  > requires the TikTok app.
  >
  > Two-step contract: calling WITHOUT plan_id validates everything (file or
  > URL, title, toggles, live creator settings) and returns a preview plus a
  > single-use plan_id valid for 10 minutes — no post is created. Show the
  > preview to the user, including the consent line it contains. After the
  > user explicitly approves, call again with identical arguments plus
  > plan_id to execute. privacy_level has NO default: the user must pick one
  > of the options listed in the preview (unaudited apps: SELF_ONLY only —
  > the post will be private).
  >
  > Rate limits: 6 posts/min (enforced locally) and roughly 15 posts/24 h per
  > account shared across ALL apps using TikTok's API. On success the call
  > returns publish_id immediately; processing continues asynchronously —
  > follow the returned poll hint to tiktok_get_publish_status.

- **Input schema** (zod `.strict()`, discriminated on `source`):

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `source` | `"file" \| "url"` | yes | discriminator | "Where the video bytes come from. \"file\": a local file under the operator-configured TT_MEDIA_ROOT, uploaded in chunks. \"url\": TikTok pulls from an HTTPS URL that must match a verified prefix in TT_VERIFIED_URL_PREFIXES." |
  | `file_path` | string | iff `source: "file"` | resolves inside `TT_MEDIA_ROOT`; MP4/WebM/MOV | "Path to the video file (absolute, or relative to TT_MEDIA_ROOT). Must resolve inside TT_MEDIA_ROOT; checked at preview and re-checked at apply. Mutually exclusive with video_url." |
  | `video_url` | string | iff `source: "url"` | https, matches a verified prefix | "HTTPS URL of the video. Must start with one of the verified URL prefixes; TikTok refuses pulls from unverified domains. Must serve the bytes without redirects and stay reachable for about 1 hour. Mutually exclusive with file_path." |
  | `title` | string | no | ≤ 2200 UTF-16 code units | "Caption. Up to 2200 UTF-16 code units (emoji count as 2, the way TikTok counts). #hashtags and @mentions are parsed by TikTok. Omit for an untitled post." |
  | `privacy_level` | enum `PUBLIC_TO_EVERYONE \| MUTUAL_FOLLOW_FRIENDS \| FOLLOWER_OF_CREATOR \| SELF_ONLY` | for execution | must be in the creator's live options | "Who can see the post. NO default — the user must choose from the options in the preview (they depend on account type and app audit status; unaudited apps allow only SELF_ONLY). A preview without this field returns the options and no plan_id." |
  | `disable_comment` | boolean | no | default `false` | "true disables comments on this post. Leave false unless the user asks." |
  | `disable_duet` | boolean | no | default `false` | "true disables duets. If the creator's account already disables duets, the server forces true and flags it in the preview — a false here cannot override it." |
  | `disable_stitch` | boolean | no | default `false` | "true disables stitch. Forced true when the creator's account disables stitch, flagged in the preview." |
  | `video_cover_timestamp_ms` | integer | no | ≥ 0 | "Video frame to use as the cover, in milliseconds from the start. Omit for TikTok's default." |
  | `brand_content_toggle` | boolean | no | default `false` | "true ONLY when the user states this is paid partnership / branded content for a third party. Incompatible with privacy_level SELF_ONLY — and therefore unavailable while the app is unaudited. Adds the Branded Content consent line to the preview." |
  | `brand_organic_toggle` | boolean | no | default `false` | "true when the post promotes the user's OWN business (organic branded content)." |
  | `is_aigc` | boolean | no | default from `TT_DEFAULT_AIGC_LABEL` (ships as `true`) | "Label the post as AI-generated content on TikTok. Defaults to true because posts made through an AI assistant usually are. Set false only if the user confirms the content is not AI-generated." |
  | `wait_for_completion` | boolean | no | **default `false`** | "After a successful apply, keep polling publish status inside this call (up to ~60 s) before returning. Default false: return publish_id immediately with a poll hint — prefer that; long calls risk client timeouts, and a timed-out write call must never be re-run blindly." |
  | `plan_id` | string | no | `plan_` + 32 lowercase hex characters | "Execution token from this tool's own preview. Present = execute the previewed post. Single-use, expires 10 minutes after the preview, bound to the exact previewed payload and this account. Never invent or reuse one." |
  | `force` | boolean | no | default `false` | "Override the duplicate guard. Set true only after verifying via tiktok_list_publish_journal and tiktok_get_publish_status that the earlier identical attempt did not create a post." |

- **Preview output** (`mode: "plan"`): `{ mode, plan_id, expires_at, account:
  { profile, nickname, open_id_masked }, action: "DIRECT_POST video",
  payload: { post_info: { ...exact fields to be sent... }, source: { type,
  resolved_path?, url?, file_size?, chunk_summary?: { file_size, chunk_size,
  chunks } } }, derived: [{ field, value, reason }], creator:
  { privacy_level_options, max_video_post_duration_sec, ... },
  audit_restrictions_active, consent_line }` + `approval_required` hint.
  `mode: "plan_incomplete"` when `privacy_level` is absent: same shape minus
  `plan_id`/`expires_at`, plus `missing: ["privacy_level"]` (§ 2.6.1).
- **Apply output** (`mode: "applied"`): `{ mode, publish_id, status:
  "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD", journal: "recorded" |
  "unavailable" }` + `poll` hint. With `wait_for_completion: true`,
  additionally the final observed `status` (+ `public_post_id` when
  complete) — and on poll timeout a `poll` hint with the graceful wording:
  *"Still PROCESSING_UPLOAD after 60 s — normal for large videos. Call
  tiktok_get_publish_status with publish_id <id>; do not re-post."*
- **Errors:** full shared catalog. Most load-bearing here: `plan_not_found`,
  `plan_mismatch`, `possible_duplicate`, `network_unsent`,
  `network_ambiguous`, `upload_interrupted`, `privacy_level_unavailable`,
  `branded_content_privacy_conflict`, `media_root_not_configured`,
  `file_outside_media_root`, `url_prefix_unverified`, `local_rate_limited`,
  `daily_post_cap`, `active_user_cap`.

### 3.9 `tiktok_upload_video_draft`

- **Package:** `publish-write`. **Annotations:** `readOnlyHint: false`,
  **`destructiveHint: true`**, `idempotentHint: false`, `openWorldHint: true`.
  Justification: sends content into the user's TikTok inbox (an external,
  non-retractable-through-this-server effect) and consumes the pending-share
  quota; destructive is the honest tuple even though nothing goes live.
- **Scopes:** `video.upload`.
- **Description** (normative):

  > Upload a video to the user's TikTok INBOX as a draft — the user must open
  > the TikTok app notification, edit, and publish it themselves; nothing
  > goes live from this call. Requires scope video.upload (NOT
  > video.publish — this tool works on draft-only authorizations). Use when
  > the user says "send it to my drafts / I'll finish it in the app". NOT for
  > direct publishing — use tiktok_post_video. Drafts carry no caption,
  > privacy, or toggles — the user sets those in the app — so this tool takes
  > only the video source. Same preview/plan_id contract as
  > tiktok_post_video. TikTok allows at most 5 unpublished API drafts per
  > account per 24 h; unopened drafts expire on their own. After success,
  > tell the user to open the TikTok app inbox notification to finish the
  > post.

- **Input schema:** `account`, `source`, `file_path`, `video_url` (rows as
  § 3.8), `wait_for_completion` (default `false`; the terminal status here is
  `SEND_TO_USER_INBOX`), `plan_id`, `force`. **No title/privacy/toggle
  fields** — the upstream inbox init accepts none, and offering dead fields
  teaches the model false affordances. The schema omission is itself the
  contract.
- **Preview/apply output:** as § 3.8 with `action: "MEDIA_UPLOAD video
  draft"`; **no `creator` block and no `consent_line`** (no `creator_info`
  pre-flight — draft tools need only `video.upload`); apply success carries a
  `user_action` hint: *"Tell the user: open the TikTok app notification to
  edit and publish the draft. Unfinished drafts expire."*
- **Errors:** shared catalog; `pending_share_cap` is the signature error
  here. No `privacy_level_unavailable` / `branded_content_privacy_conflict`
  (the fields do not exist on this tool).

### 3.10 `tiktok_post_photos`

- **Package:** `publish-write`. **Annotations:** `readOnlyHint: false`,
  **`destructiveHint: true`**, `idempotentHint: false`, `openWorldHint: true`.
- **Scopes:** `video.publish`.
- **Description** (normative):

  > Post a photo carousel DIRECTLY to the user's TikTok profile — it goes
  > live once processing completes. Requires scope video.publish. Use for
  > "post these photos". NOT for "send photos to my drafts" — use
  > tiktok_upload_photos_draft. Posts cannot be edited or deleted through
  > this server.
  >
  > Photos can only be pulled by TikTok from verified URLs (prefixes
  > configured in TT_VERIFIED_URL_PREFIXES) — the photo API has no local-file
  > upload. For photos on disk, the user must first host them under a
  > verified prefix. Title is much shorter than for videos: max 90 UTF-16
  > code units; the longer text belongs in description (max 4000). Same
  > preview/plan_id contract and the same rate limits (6/min local, ~15
  > posts/24 h shared) as tiktok_post_video.

- **Input schema:**

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `photo_urls` | string[] | yes | 1–35 items; each https + verified prefix; JPEG/WebP ≤ 20 MB, ≤ 1080p (CC-E9) | "HTTPS URLs of the photos, in carousel order (1–35). Every URL must start with a verified prefix from TT_VERIFIED_URL_PREFIXES — TikTok refuses unverified domains. JPEG or WebP, up to 20 MB and 1080p each." |
  | `photo_cover_index` | integer | no | 0 ≤ i < `photo_urls.length`; default 0 | "Zero-based index of the cover photo. Must be a valid index into photo_urls." |
  | `title` | string | no | ≤ 90 UTF-16 code units | "Photo post title — max 90 UTF-16 code units (NOT 2200; photos differ from videos). Longer text goes in description." |
  | `description` | string | no | ≤ 4000 UTF-16 code units | "Photo post description, up to 4000 UTF-16 code units. #hashtags and @mentions are parsed here." |
  | `privacy_level` | enum | for execution | as § 3.8 | (as § 3.8) |
  | `disable_comment` | boolean | no | default `false` | "true disables comments on this post." |
  | `auto_add_music` | boolean | no | default `false` | "true lets TikTok add recommended music to the carousel. Ask the user; photo posts without music play silent." |
  | `brand_content_toggle` | boolean | no | default `false` | (as § 3.8) |
  | `brand_organic_toggle` | boolean | no | default `false` | (as § 3.8) |
  | `is_aigc` | boolean | no | default from `TT_DEFAULT_AIGC_LABEL` | (as § 3.8) |
  | `wait_for_completion` | boolean | no | **default `false`** | (as § 3.8) |
  | `plan_id` | string | no | `plan_` + 32 lowercase hex characters | (as § 3.8) |
  | `force` | boolean | no | default `false` | (as § 3.8) |

- **Preview/apply output:** as § 3.8 with `action: "DIRECT_POST photos"`; the
  source block lists the URLs and the cover index; the duplicate-guard title
  hash uses title + description.
- **Errors:** shared catalog; `url_prefix_unverified` (checked per URL, the
  message names the first offending URL), `privacy_level_unavailable`,
  `branded_content_privacy_conflict`, `daily_post_cap`, `active_user_cap`.
  **No duet/stitch fields exist for photos** — the schema omission is itself
  the contract.

### 3.11 `tiktok_upload_photos_draft`

- **Package:** `publish-write`. **Annotations:** `readOnlyHint: false`,
  **`destructiveHint: true`**, `idempotentHint: false`, `openWorldHint: true`
  (same justification as § 3.9).
- **Scopes:** `video.upload`.
- **Description** (normative):

  > Send a photo carousel to the user's TikTok INBOX as a draft — the user
  > finishes and publishes it in the TikTok app; nothing goes live from this
  > call. Requires scope video.upload. Use for "send these photos to my
  > drafts". NOT for direct posting — use tiktok_post_photos. Same
  > verified-URL-only rule as tiktok_post_photos (no local photo files — the
  > platform has no photo upload endpoint). Same preview/plan_id contract.
  > Counts toward TikTok's cap of 5 unpublished API drafts per 24 h. After
  > success, tell the user to open the TikTok app inbox notification.

- **Input schema:** `account`, `photo_urls`, `photo_cover_index`, `title`,
  `description` (rows as § 3.10 — title/description are accepted by the photo
  draft endpoint and prefill the app editor; *(verify at implementation
  time — probe P-13)*), `wait_for_completion` (default `false`), `plan_id`,
  `force`. No privacy, toggle, or brand fields.
- **Preview/apply output:** as § 3.9 with `action: "MEDIA_UPLOAD photos
  draft"`; no `creator` block, no `consent_line`; apply success carries the
  same `user_action` hint as § 3.9.
- **Errors:** shared catalog; `pending_share_cap`, `url_prefix_unverified`.
  No `creator_info` pre-flight (scope reality: draft authorizations lack
  `video.publish`).

---

## 4. Canonical flows (normative steering)

**[impossible]** marks a wrong path the design makes unrepresentable;
**[discouraged]** marks one that is steered against.

1. **First post, local file.** Preview without `privacy_level` ⇒
   `plan_incomplete`, live options, no token — **[impossible]** posting
   without an explicit privacy choice. Re-preview with `privacy_level` ⇒
   `plan` + `plan_id` + `approval_required` hint — **[impossible]** executing
   without a preview having existed (the token is random, single-use,
   unforgeable); **[discouraged]** skipping the human approval (steering: the
   hint's imperative text, the consent line, `TT_WRITE_MODE=plan` default).
   Apply with `plan_id` ⇒ `publish_id` + `poll` hint — **[impossible]**
   applying with silently changed arguments (`plan_mismatch`), against a
   different account (open_id binding), after 10 min (TTL), or twice
   (single-use). Then `tiktok_get_publish_status` (waits by default) ⇒
   `PUBLISH_COMPLETE` + `public_post_id`.
2. **Unaudited app.** Preview shows `privacy_level_options: ["SELF_ONLY"]`,
   `audit_restrictions_active: true`, and a `note` hint; a brand toggle ⇒
   local `branded_content_privacy_conflict` before any network call.
   Cap errors (`active_user_cap`, `daily_post_cap`) say "Do not retry
   today" — **[discouraged]** retry-looping on caps (steering:
   `retryable: false` + the explicit text).
3. **Interrupted upload.** `upload_interrupted` + journal
   `outcome: "upload_failed"`. **[impossible]** resuming a half-upload later
   (`upload_url` is never persisted or returned). Recovery: fresh preview,
   fresh `plan_id`, apply — `upload_failed` does **not** trip the duplicate
   guard, so no `force` is needed. The ambiguous variant
   (`network_ambiguous`, journal `unknown`) DOES trip the guard: verify via
   status/journal/list, then use `force` deliberately.
4. **Re-auth.** `auth_expired` + `reauth` hint with the exact CLI command —
   **[impossible]** the model re-authenticating by itself (login is a
   CLI/browser flow with no tool-surface path). After the user logs in, the
   credential watcher emits `tools/list_changed` (§ 6);
   **[discouraged]** retrying before the user confirms login (steering: "Do
   not retry this call until re-login completes").

---

## 5. Hints specification

Hints are the server's only channel for next-step guidance: **server-authored
text with typed structure**. Content blocks and `data` carry facts; hints
carry imperatives.

### 5.1 Closed vocabulary — six types

Clients and tests reject anything else. This union is mirrored as `HintType`
in CONTRACTS.md § mcp/result.ts.

| `type` | Structured fields | Emitted when |
|---|---|---|
| `wait` | `retry_after_s: number`, `retry_at: ISO-8601 UTC` | Rate limits (upstream 429, local bucket), transient upstream throttles |
| `poll` | `tool: string`, `publish_id: string`, `poll_after: ISO-8601 UTC` | After apply (default no-wait), after a status-poll timeout |
| `approval_required` | `plan_id: string`, `expires_at: ISO-8601 UTC` | Every `mode: "plan"` preview |
| `user_action` | `action: "login" \| "open_tiktok_app" \| "move_file" \| "host_media" \| "configure_server" \| "wait_for_audit"` | Anything only the human/operator can do |
| `reauth` | `command: string` (exact CLI line), `profile: string` | `auth_expired`, `auth_removed`, revocation |
| `note` | — | Informational: truncation cause, draft-inbox reminder, `journal: "unavailable"`, unaudited explanation |

Every hint additionally has `text: string` — the model-facing sentence(s).

### 5.2 Grammar rules (normative)

1. `text` is 1–3 short imperative sentences, ≤ 300 characters total.
   Concrete values (tool names, profile names, timestamps, commands) are
   inlined; vague references ("try later", "the relevant tool") are
   forbidden.
2. Times are always **absolute ISO-8601 UTC in the text**, with relative
   seconds only in structured fields. Models cannot reliably do "in 37 s"
   arithmetic across turns; they can compare clocks.
3. **Trust boundary — no upstream interpolation.** Hint text is composed
   exclusively from server-owned templates plus a whitelist of interpolants:
   configured profile names, tool names, enum values, numbers, ISO
   timestamps, and the server's own CLI command strings. TikTok-supplied
   strings (error messages, titles, nicknames, any user content) never enter
   a hint. Upstream text lives only in clearly-labeled data fields — a hint
   is an instruction channel, and instructions must have exactly one author.
4. At most 3 hints per result, ordered most-actionable-first. A result that
   needs more than 3 is a design smell — fold the rest into `data`.
5. Hints never contradict the error text; the error states cause + recovery,
   the hint operationalizes the recovery (exact call, exact time, exact
   command).

### 5.3 Examples (normative renderings)

- `wait`: `{ type: "wait", retry_after_s: 42, retry_at:
  "2026-07-22T09:31:07Z", text: "Rate limit: wait until 2026-07-22T09:31:07Z,
  then apply again with a fresh preview. Do not retry earlier." }`
- `poll`: `{ type: "poll", tool: "tiktok_get_publish_status", publish_id:
  "v_pub_abc123", poll_after: "2026-07-22T09:30:40Z", text: "Call
  tiktok_get_publish_status with publish_id \"v_pub_abc123\" after
  2026-07-22T09:30:40Z to confirm the post went live. Do not re-post." }`
- `approval_required`: `{ type: "approval_required", plan_id:
  "plan_9f3ac2d47b01e5aa4c8d21e07b53f6a2", expires_at:
  "2026-07-22T09:40:00Z", text: "Show this preview to the user, including the
  consent line. Only after explicit approval, call the tool again with the
  same arguments plus plan_id \"plan_9f3ac2d47b01e5aa4c8d21e07b53f6a2\"
  (valid until 2026-07-22T09:40:00Z)." }`
- `user_action` (draft): `{ type: "user_action", action: "open_tiktok_app",
  text: "Tell the user: open the TikTok app notification to edit and publish
  the draft. Unopened drafts expire." }`
- `reauth`: `{ type: "reauth", profile: "brand", command: "npx tiktok-mcp-ai
  login --profile brand", text: "Ask the user to run: npx tiktok-mcp-ai login
  --profile brand — then verify with tiktok_get_auth_status before
  retrying." }`

---

## 6. Scope / UNAVAILABLE lifecycle

Four moments, one rule: **markers are advisory, the call-time check is
authoritative.**

1. **Startup marker.** For each tool with required scopes, availability =
   ∃ a configured profile whose granted scopes cover them (union across
   profiles — a tool usable by *any* profile is not "unavailable"). When no
   profile qualifies, the description is prefixed:
   `[UNAVAILABLE: requires scope video.publish; no configured profile grants
   it. Fix: npx tiktok-mcp-ai login --scopes video.publish]`
   The tool stays registered and callable — hiding it would strand clients
   that cache tool lists, and the marker text is itself the recovery
   documentation.
2. **Call time (authoritative).** The handler re-reads the credential
   snapshot on every call, resolves the profile, and checks that profile's
   scopes. Missing ⇒ structured `missing_scope` error with per-profile
   phrasing (§ 3.0) + `reauth`/`user_action` hint — even if the description
   carried no marker (multi-profile case: the union may be fine while the
   *chosen* profile is not), and conversely a stale marker never blocks a
   call that would now succeed.
3. **Credential-store watch.** The env file(s) are watched (debounced
   ≥ 500 ms; plus an unconditional re-read before each refresh). On a change
   that alters any tool's availability or marker text: recompute
   descriptions, update the registry, and emit
   `notifications/tools/list_changed`. The server declares
   `capabilities.tools.listChanged: true` at initialize — without the
   declaration the notification is dead letter.
4. **Self-description.** `tiktok_get_auth_status` reports the per-profile ×
   per-package availability matrix (§ 3.1) so the model can diagnose scope
   problems without parsing description prefixes. The login CLI prints the
   same matrix after granting, closing the loop: marker → error →
   auth-status → login → list_changed → clean call.

---

## Appendix A — `fail_reason` → recovery mapping

Normative `fail_recovery` texts returned by `tiktok_get_publish_status`
(§ 3.6) when `status: "FAILED"`:

| `fail_reason` | Recovery text (normative) |
|---|---|
| `file_format_check_failed` | "The file is not a format TikTok accepts (MP4/WebM/MOV). Re-encode and post again with a fresh preview." |
| `duration_check_failed` | "Video duration is outside this account's allowed range (max <max_video_post_duration_sec> s per creator info). Trim or re-encode." |
| `frame_rate_check_failed` | "Frame rate is outside TikTok's 23–60 FPS range. Re-encode." |
| `picture_size_check_failed` | "Dimensions are outside TikTok's limits (videos 360–4096 px; photos up to 1080p). Resize." |
| `video_pull_failed` / `photo_pull_failed` | "TikTok could not download the media URL. It must be HTTPS, serve the bytes without redirects, and stay reachable for about an hour. Fix the hosting and post again." |
| `publish_cancelled` | "The user cancelled this post in the TikTok app. Nothing to retry." |
| `auth_removed` | "The user revoked this app's access in TikTok settings. Ask the user to run the login CLI again." |
| `spam_risk_text` | "TikTok's spam filter rejected the title or description wording. Change the text and post again." |
| `spam_risk` / `spam_risk_too_many_posts` | "TikTok applied an account-level posting throttle. Do not retry today." |
| `internal` | "TikTok internal error. A later retry with a fresh preview may succeed. Quote log_id <log_id> if the user contacts TikTok support." |
| *(unknown value)* | "TikTok reported an unrecognized failure code '<value>'. Treat the post as not published; verify with tiktok_list_videos before retrying." |

---

## Appendix B — platform limits quick-sheet

Numbers the schemas and validators enforce (details in TIKTOK-API.md;
*(verify)* marks values pending an implementation-time probe):

| Limit | Value |
|---|---|
| Video caption (`title`, direct post) | ≤ 2200 UTF-16 code units |
| Photo `title` | ≤ 90 UTF-16 code units |
| Photo `description` | ≤ 4000 UTF-16 code units |
| Photos per carousel | 1–35 URLs, `PULL_FROM_URL` only |
| Photo format/size | JPEG or WebP, ≤ 20 MB, ≤ 1080p each |
| Video formats | MP4 / WebM / MOV |
| `privacy_level` enum | `PUBLIC_TO_EVERYONE` \| `MUTUAL_FOLLOW_FRIENDS` \| `FOLLOWER_OF_CREATOR` \| `SELF_ONLY` — no default, ever |
| Posts per account per 24 h | ~15, shared across ALL apps using the API |
| Unpublished API drafts per 24 h | 5 per account; unopened drafts expire on their own *(expiry window: verify, probe P-7)* |
| Posting users per 24 h (unaudited app) | 5 |
| `creator_info` upstream limit | 20 requests/min |
| Publish-status upstream limit | 30 requests/min |
| Local publish bucket | 6 inits/min per profile, refill 1 token/10 s |
| Chunk rules (decimal, not KiB/MiB) | files < 5 000 000 B upload as one whole chunk; `chunk_size` 64 000 000 B; final chunk absorbs the remainder, ≤ 127 999 999 B; 1–1000 chunks; total ≤ 4 GiB (CC-D2) |
| Publish statuses | `PROCESSING_DOWNLOAD` · `PROCESSING_UPLOAD` · `SEND_TO_USER_INBOX` · `PUBLISH_COMPLETE` · `FAILED` |
| Status retention upstream | undocumented — `publish_not_found` wording stays hedged *(verify, probe P-1)* |
| Media URL reachability (`PULL_FROM_URL`) | HTTPS, no redirects, reachable ~1 h |
| CDN URLs in read results (avatar/cover/media) | expire in ~6 h — never store long-term |
