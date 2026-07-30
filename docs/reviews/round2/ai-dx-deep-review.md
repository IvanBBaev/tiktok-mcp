# Round-2 Deep Review — Principal AI/DX Engineer: Finalized Tool Surface v1.1

## 1. Reviewer & scope

- **Role**: Principal AI/DX Engineer — MCP tool-surface design for LLM consumption.
- **Date**: 2026-07-22.
- **Mandate**: cross-examine the round-1 proposals (especially `docs/reviews/ai-dx-review.md`,
  my predecessor's) against the other five round-1 reviews, converge the competing
  `plan_id` designs into one final contract, settle the disputed defaults, and produce
  the **normative v1.1 tool-surface specification** — the actual text, schemas, and error
  messages the model will see — ready to replace the per-tool content of `docs/TOOLS.md`.
- **Inputs**: `README.md`; all 8 documents in `docs/`; all 6 round-1 reviews in
  `docs/reviews/` (ai-dx, tiktok-platform, architecture, security, qa, devops-release).
- **Convention**: round-1 findings are cited as `AIDX-F1`, `ARCH-F2`, `SEC-F3`, `PLAT §n`,
  `QA-F5`, `DEVOPS-F9`. Round-1 prose is not repeated; this document builds on it.
- **Verdict on the round-1 AI-DX review**: sound in direction; adopted with refinements.
  The largest refinement is structural: the `apply: true` boolean is **removed** and
  `plan_id` becomes the sole execution switch (§ 2.1). Final surface: **11 tools in
  5 packages** (§ 3.0).

---

## 2. Cross-examination

### 2.0 Quick verdicts on round-1 proposals

| Round-1 proposal | Verdict | Disposition in v1.1 |
|---|---|---|
| AIDX-F1 / SEC-F4 / ARCH-F2 — plan token + payload hash + journal dedup | **REFINE** | Converged into one contract; `apply` boolean removed; `plan_id` is the switch; `force` added (§ 2.1) |
| AIDX-F2 — `destructiveHint: true` + "cannot be edited or deleted" sentence on all write tools | **CONFIRM** | In every write-tool description and annotation tuple (§ 3) |
| AIDX-F3 — split `tiktok_post_photos` into direct + draft tools | **CONFIRM** | `tiktok_post_photos` + `tiktok_upload_photos_draft` (§ 3.10, § 3.11) |
| AIDX-F4 — `tiktok_list_publish_journal` + write-ahead journaling | **CONFIRM + REFINE** | outcome `"unknown"` semantics pinned; journal failure never fails a publish (§ 2.2) |
| AIDX-F5 — call-time scope fail-fast, `tools/list_changed` | **CONFIRM** | Full lifecycle contract in § 6 |
| AIDX-F6/F7 — renames `tiktok_get_auth_status`, `tiktok_get_creator_info`; unified `wait_for_completion` | **CONFIRM** | Applied (§ 3) |
| AIDX-F8 — contrastive "Use / NOT for" on post vs. draft | **CONFIRM** | In all four write-tool descriptions |
| AIDX-F9 — creator_info "you do not need to call this first" | **CONFIRM + REFINE** | Pre-flight is **conditional**: skipped for draft tools (PLAT §6 — `creator_info` needs `video.publish`, which draft-only profiles lack) |
| AIDX-F10 / SEC-F11 — unknown account = local error; account bound into plan | **CONFIRM** | § 3 common contract; `TT_LOCK_PROFILE` noted in § 7 |
| AIDX-F11 / ARCH-F4 / QA-F1 — in-call chunk retry, no cross-call resume | **CONFIRM** | § 2.3; error always carries `publish_id` |
| AIDX-F12 — drop `cover_image_url` from default field set | **CONFIRM** | § 3.3 |
| AIDX-F13 — truncation meta + cause-specific hints | **CONFIRM** | Common contract + `note` hint type (§ 5) |
| AIDX-F14 vs. ARCH deep-dive C — `wait_for_completion` default true vs. false | **SETTLED: false on write tools, true on the status tool** | § 2.3 |
| AIDX-F15 — `retry_after_s` + absolute `retry_at`; daily caps "do not retry today" | **CONFIRM** | `wait` hint type (§ 5); cap errors in § 3 catalogs |
| AIDX-F16 — discriminated union on `source`; privacy options listed in mismatch error | **CONFIRM** | § 3.8 schema; `privacy_level_unavailable` error |
| AIDX-F17 / ARCH-F18 — cursor fully opaque | **CONFIRM** | `.describe()` text in § 3.3 |
| AIDX-F18 — `ok:false` ⇒ MCP `isError: true`; `structuredContent` + `outputSchema` | **CONFIRM** | Common contract |
| AIDX-F19 — hints grammar, no upstream interpolation | **CONFIRM + EXTENDED** | Closed vocabulary of 6 types (§ 5) |
| AIDX-F20 — chunk plan summary `{file_size, chunk_size, chunks}`; derived-value flags | **CONFIRM** | Plan preview shape (§ 3.8) |
| AIDX elicitation as defense-in-depth | **REFINE (demoted)** | Optional post-v1: client support is inconsistent; `plan_id` alone closes the hole. Not part of the v1.1 contract |
| ARCH-F7 — split `publish` package for the `core` profile | **CONFIRM** | Packages `publish` (RO) / `publish-write` (§ 3.0) |
| SEC-F3 — `TT_MEDIA_ROOT` confinement | **CONFIRM + REFINE** | Required for `source:"file"`; error texts in § 2.4 |
| PLAT §9 — `TT_VERIFIED_URL_PREFIXES` local pre-flight | **CONFIRM** | All `*_url` fields validated locally before network |
| QA-F17 — token bucket: reject with wait hint, never delay | **CONFIRM** | `local_rate_limited` error (§ 3 catalog) |
| QA-F2 — ambiguous init failure is terminal, uncertainty-worded | **CONFIRM** | `network_ambiguous` error text (§ 3 catalog) + journal `"unknown"` |
| DEVOPS-F9 — journal append failure = warning, never publish failure | **CONFIRM** | `journal: "unavailable"` field + `note` hint |

### 2.1 The plan mechanism — final contract (converging AIDX-F1, SEC-F4, ARCH-F2/F3)

Three round-1 variants were on the table:

- **AIDX-F1**: keep `apply: boolean`, add a required `plan_id` when `apply: true`; server
  stores SHA-256 of canonicalized args + account + TTL.
- **SEC-F4**: confirmation token *derived from* the hash of the resolved payload; apply
  echoes the exact token; reject non-matching payloads.
- **ARCH-F2/F3**: journal-backed duplicate guard on apply with a `force` override; apply
  must re-run `creator_info` and re-validate before init.

**REFINE — the final contract takes the strictest element of each and removes one field.**

The `apply` boolean is **deleted from the surface**. With both `apply` and `plan_id`,
two illegal states exist (`apply:true` without `plan_id`; `plan_id` with `apply:false`)
that need refinement rules and error texts. With `plan_id` alone, the wrong path is not
merely discouraged — it is unrepresentable: **absence of `plan_id` is a preview; presence
of a valid `plan_id` is execution; and a valid `plan_id` cannot exist unless a preview
was produced first**, because the token is random and single-use, not derivable from the
arguments (this is the one place SEC-F4's "derive from hash" loses to AIDX-F1's random
token: a derivable token could be fabricated by a prompt-injected model that knows the
scheme; a random token cannot).

**Normative contract** (applies identically to all four write tools):

1. **Preview call** — write tool invoked without `plan_id`:
   - Full local validation (schema, media-root/URL-prefix checks, title length in UTF-16
     code units, toggle conflicts), then the conditional upstream pre-flight
     (`creator_info` for direct-post tools only), then file stat for `source:"file"`.
   - If a required-for-execution field is missing (`privacy_level` on direct-post tools),
     the result is `mode: "plan_incomplete"` — **no `plan_id` is issued**. The preview
     lists the live `privacy_level` options and instructs a re-plan. A plan that cannot
     be executed never mints an execution token.
   - Otherwise the result is `mode: "plan"` with:
     - `plan_id` — `"plan_"` + 16 lowercase hex chars, cryptographically random;
     - `expires_at` — ISO-8601 UTC, `now + TT_PLAN_TTL_S` (default 600 s);
     - the exact payload that apply will send (`post_info` / source summary), with every
       derived or forced value flagged (`derived: [{field, value, reason}]`);
     - the resolved target: profile name + display name + masked `open_id`;
     - `consent_line` — the exact UX-guideline consent sentence the user must be shown
       ("Music Usage Confirmation", or "Branded Content Policy" when a brand toggle is
       set — PLAT §3);
     - an `approval_required` hint (§ 5).
   - Server-side, the plan record stores: SHA-256 over the canonicalized argument object
     (JSON, keys sorted, schema defaults materialized, `plan_id`/`force`/
     `wait_for_completion` excluded), the resolved profile's `open_id`, tool name,
     `created_at`, `used: false`. Plans live in process memory only — they are
     capability-bearing and are never persisted (same rule as `upload_url`, ARCH deep
     dive C).
   - **No init/upload/publish request is made. Ever.** (`creator_info` is the only
     permitted network call, and only for direct-post tools.)

2. **Apply call** — same tool, same arguments, plus `plan_id`:
   - Verification order, all local, before any network: token exists ∧ not used ∧ not
     expired ∧ tool name matches ∧ argument hash matches ∧ resolved `open_id` matches.
     Failures produce `plan_not_found` or `plan_mismatch` (exact texts in § 3 catalog).
   - **Duplicate guard** (ARCH-F2): the journal is scanned for an entry with the same
     profile + tool + title-hash within the last 10 minutes whose outcome is `ok`,
     `pending`, or `unknown`. Hit ⇒ `possible_duplicate` error unless `force: true`.
     Outcome `error` entries do not trigger the guard (a cleanly failed attempt may be
     retried without ceremony).
   - The plan is **consumed now** — before the init request is dispatched, not after it
     succeeds. A failed apply therefore always requires a fresh preview. This is the
     strictest reading and it is deliberate: after any failure the world may have changed
     (rate windows, creator settings, the file on disk), and the re-preview re-validates
     all of it (ARCH-F3).
   - Apply re-runs the same validation and pre-flight as the preview (creator settings
     may have changed within the TTL); the previewed payload and the applied payload are
     produced by one code path (QA deep dive 6.3.2 — what-you-preview-is-what-you-post
     is a machine-checked invariant, not a convention).
   - Journal write-ahead entry, then init, then (for `source:"file"`) chunk PUTs.

3. **`TT_WRITE_MODE` interaction**:
   - `plan` (default): as above.
   - `apply`: `plan_id` becomes optional — a call without it executes immediately, still
     with full validation, pre-flight, and the duplicate guard. Documented as
     **trusted-automation only: this mode has no injection resistance** (SEC-F4 wording,
     verbatim in CONFIGURATION.md).
   - `deny`: the `publish-write` package is not registered; there is no runtime error to
     specify because the tools do not exist.

### 2.2 Journal write-ahead and `outcome: "unknown"` (AIDX-F4, ARCH-F2, QA-F2/F-10, DEVOPS-F9)

**CONFIRM the write-ahead design; the refinement is how "unknown" is surfaced.**

- Before the init request is dispatched, the server appends
  `{ts, profile, tool, action, title_excerpt (≤48 chars), args_hash, outcome: "pending"}`
  as one atomic NDJSON line. After the response (or terminal upload failure), it appends
  a completion line: `outcome: "ok"` + `publish_id`, or `outcome: "error"` + error code,
  or `outcome: "upload_failed"` + `publish_id` + failed chunk.
- A `pending` line with no completion line — process crash, kill mid-flight, lost
  response — is **presented by `tiktok_list_publish_journal` as `outcome: "unknown"`**
  (derived at read time; nothing rewrites history). The tool's description and the
  `network_ambiguous` error text both teach the same rule: *unknown means the post MAY
  exist upstream; verify with `tiktok_get_publish_status` / `tiktok_list_videos` before
  any retry* (QA-F2's uncertainty wording).
- The duplicate guard (§ 2.1) treats `pending` and `unknown` identically to `ok` — the
  dangerous case is precisely the one where we do not know.
- Journal append failure is a **logged warning, never a publish failure** (DEVOPS-F9).
  The apply result then carries `journal: "unavailable"` in `data` plus a `note` hint:
  *"The local journal could not be written; this publish will not appear in
  tiktok_list_publish_journal. Rely on tiktok_get_publish_status for verification."*

### 2.3 Chunk-PUT retries, long uploads, and the `wait_for_completion` default (AIDX-F11/F14, ARCH-F4 + deep dive C, QA-F1/F-5)

**Chunk retries — CONFIRM the converged round-1 position, now normative:**

- Each chunk PUT (fixed 64 MB chunk size, PLAT §11; sequential; `Content-Range` per the
  floor-formula chunk plan) is retried **in-call** up to 3 times with backoff on network
  errors and 5xx — a byte-range PUT is idempotent per range (ARCH-F4). 4xx is terminal.
- **No cross-call resume.** `upload_url` is capability-bearing and is never persisted or
  returned (ARCH deep dive C, SEC). On exhaustion the tool returns `upload_interrupted`
  (§ 3 catalog) which **always carries `publish_id`** and the failed chunk index
  (QA-F1), journals `outcome: "upload_failed"`, and directs the model to the status tool
  — never to an automatic re-post.
- MCP progress notifications are emitted per completed chunk (ARCH deep dive C), which
  is where AIDX-F14's per-poll-tick progress idea actually pays off — upload progress is
  minutes-long; poll progress is not.

**`wait_for_completion` default — SETTLED: `false` on all four write tools; `true` on
`tiktok_get_publish_status`.**

My predecessor (AIDX-F14) kept `true` ("one bounded call beats an N-turn poll loop");
the architect flipped it to `false` at least for `source:"file"`. The architect wins,
and uniformly, for three reasons:

1. **The failure asymmetry is extreme.** A post-tool call killed by a client timeout
   mid-poll invites the model to re-invoke a *destructive, non-idempotent* tool — the
   duplicate-post scenario every reviewer independently flagged as the worst outcome.
   A status-tool call killed mid-poll is retried for free (read-only, idempotent). The
   default should put the long-blocking behavior on the tool where retrying is safe.
2. **A per-source default (`true` for URL, `false` for file) is schema cleverness the
   model pays for.** One uniform rule — *"write tools return fast with a poll hint; the
   status tool waits"* — is memorizable and appears verbatim in the descriptions.
3. **The DX cost of `false` is one guided step, not a loop.** Every successful apply
   returns a `poll` hint with the exact tool name, the `publish_id`, and an absolute
   `poll_after` timestamp; the status tool then does the bounded 60 s wait internally.
   Typical flows still complete in two calls.

`wait_for_completion: true` remains available on write tools as an explicit opt-in for
callers that know their client's timeout budget; its `.describe()` text warns about the
timeout risk. On the status tool the graceful-timeout contract is pinned per QA-F5: a
terminal state observed before returning always wins over the timeout; a timeout returns
the last observed status with a `poll` hint and is **not** an error.

### 2.4 `TT_MEDIA_ROOT` — how path errors read to the model (SEC-F3, QA-F21)

**CONFIRM the confinement; the refinement is making the errors self-explanatory and
actionable without leaking anything.**

- `source: "file"` **requires** `TT_MEDIA_ROOT` to be configured. This is stricter than
  "default to home directory" and is deliberate: file access breadth is operator policy,
  not model policy (SEC-F3). Unset ⇒ `media_root_not_configured`.
- `file_path` accepts an absolute path or a path relative to `TT_MEDIA_ROOT`. It is
  canonicalized (symlinks resolved) **before** the containment check; escapes ⇒
  `file_outside_media_root`. The error names the configured root (a path the operator
  already chose to expose) and the *resolved* offending path — but never directory
  listings or "did you mean" suggestions (no filesystem oracle).
- Not found / not a regular file / over size cap are distinct local errors; all fire
  before any network call, and all are re-checked at apply time (plan-time validation
  may be stale — QA-F21 TOCTOU note). The preview renders the resolved absolute path and
  byte size so the human confirms the actual file (SEC-F3).
- Exact texts in the § 3 error catalog. All carry a `user_action` hint — the model
  cannot fix an operator-policy problem and must not try to path-guess its way around
  it; the texts say so explicitly.

---

## 3. Finalized tool surface v1.1

### 3.0 Surface at a glance

**11 tools, 5 packages.** Round 1 proposed 9 + photo split + journal = 11; cross-
examination found nothing to add or merge. Explicitly considered and rejected: merging
`tiktok_list_videos` + `tiktok_query_videos` (different upstream endpoints, different
input shapes — predecessor's rejection stands); a separate `tiktok_cancel_publish` tool
(the upstream cancel endpoint is unverified — Remaining unknowns, § 8); folding the
journal into `tiktok_get_auth_status` (different concern, different package).

| # | Tool | Package | RO | Destr. | Idem. | OpenWorld | Scope |
|---|---|---|---|---|---|---|---|
| 1 | `tiktok_get_auth_status` | auth | yes | no | yes | yes | — |
| 2 | `tiktok_get_user_info` | user | yes | no | yes | yes | `user.info.basic` (+optional `user.info.profile`, `user.info.stats`) |
| 3 | `tiktok_list_videos` | video | yes | no | yes | yes | `video.list` |
| 4 | `tiktok_query_videos` | video | yes | no | yes | yes | `video.list` |
| 5 | `tiktok_get_creator_info` | publish | yes | no | yes | yes | `video.publish` |
| 6 | `tiktok_get_publish_status` | publish | yes | no | yes | yes | `video.publish` or `video.upload` |
| 7 | `tiktok_list_publish_journal` | publish | yes | no | yes | **no** | — |
| 8 | `tiktok_post_video` | publish-write | no | **yes** | no | yes | `video.publish` |
| 9 | `tiktok_upload_video_draft` | publish-write | no | **yes** | no | yes | `video.upload` |
| 10 | `tiktok_post_photos` | publish-write | no | **yes** | no | yes | `video.publish` |
| 11 | `tiktok_upload_photos_draft` | publish-write | no | **yes** | no | yes | `video.upload` |

Packages (ARCH-F7 adopted): `auth`, `user`, `video`, `publish` (read-only publishing
context), `publish-write` (the four destructive tools). Profiles: `reader` = auth +
user + video + publish; `core` = reader (no writes); `publisher`/`all` = everything.
`TT_WRITE_MODE=deny` and `TT_PACKAGES_READONLY=1` both unregister `publish-write`
(deny wins over any profile).

**Annotation justifications** (uniform, per tuple): read tools are `readOnlyHint: true`,
`idempotentHint: true` (repeat calls observe, never mutate), `openWorldHint: true`
(upstream API) — except the journal tool, `openWorldHint: false` (local file only).
Write tools are `destructiveHint: true` because a published post **cannot be edited or
deleted through this server** (AIDX-F2) — an irreversible external effect, which is what
the hint exists to signal; `idempotentHint: false` because re-invocation creates a new
publish attempt.

### Common contract (normative, applies to every tool)

- **Result envelope**: every tool returns `{ ok: boolean, data?: object, error?:
  { code, message, retryable, log_id?, details? }, hints?: Hint[] }` as
  `structuredContent` with a declared `outputSchema`; a human/model-readable text block
  mirrors it and is authoritative when they diverge (AIDX-F18). `ok: false` ⇒ MCP
  `isError: true`. `data.meta.account` echoes the resolved profile name on every call
  (AIDX-F10).
- **`account` parameter** (auto-injected into every schema):
  - Type: `string`, optional.
  - `.describe()`: *"Profile name from the server configuration. Omit to use the default
    profile. Unknown names fail locally without contacting TikTok."*
  - Unknown value ⇒ local error `unknown_account` (catalog below). When
    `TT_LOCK_PROFILE` is set, any explicit `account` other than the locked one fails the
    same way (SEC-F11).
- **Validation before network**: every locally checkable constraint (schema, lengths in
  UTF-16 code units, enum membership, URL prefixes, media-root containment, toggle
  conflicts) fails before any fetch. Schemas are zod `.strict()` — unknown keys are
  rejected by name.
- **Scope gate**: per § 6 — call-time check against the live credential snapshot is
  authoritative; description markers are advisory.
- **Truncation** (AIDX-F13): oversized results are shaped by dropping trailing items,
  never fields mid-item; `data.meta.truncation = { truncated: true, reason:
  "char_budget" | "item_cap", returned, resume_cursor? }` plus a cause-specific `note`
  hint. Truncation runs after redaction and never splits a UTF-16 surrogate pair
  (QA-F12).
- **Token discipline**: no access/refresh token, `upload_url`, or `upload_token` ever
  appears in any result, hint, error, or journal line.
- **Rate-limit self-report**: upstream 429 and local bucket rejections both produce
  errors with `retry_after_s` and absolute `retry_at` plus a `wait` hint (AIDX-F15).

### Shared error catalog (exact texts; `<...>` are server-filled placeholders)

Every write tool inherits all of these; read tools inherit the first six. Per-tool
catalogs below list only additions.

| Code | Retryable | Message text (normative) |
|---|---|---|
| `invalid_params` | no | "Invalid arguments: <field>: <local validation reason>. Fix the arguments and call again. No request was sent to TikTok." |
| `unknown_account` | no | "Unknown account '<name>'. Configured profiles: <list>. Omit account to use the default profile ('<default>')." |
| `missing_scope` | no | "Account '<profile>' was authorized without scope <scope>, which this tool requires. Ask the user to run: npx tiktok-mcp-ai login --profile <profile> --scopes <scope> — then verify with tiktok_get_auth_status." |
| `auth_expired` | no | "TikTok rejected the token for account '<profile>' and automatic refresh failed. Ask the user to run: npx tiktok-mcp-ai login --profile <profile>. Do not retry this call until re-login completes." |
| `rate_limited` | yes | "TikTok rate limit reached for this endpoint. Wait until <retry_at> (<retry_after_s> s) and call again. Do not retry earlier." |
| `upstream_error` | varies | "TikTok returned an error: <mapped taxonomy category — never raw upstream text>. log_id <log_id> (quote this when contacting TikTok support). <recovery action per taxonomy class>." |
| `local_rate_limited` | yes | "This server's publish limiter (6/min) rejected the call to protect the account from TikTok's spam systems. Wait until <retry_at> (<retry_after_s> s), then apply again with a fresh preview." |
| `daily_post_cap` | no | "TikTok reports this account reached its daily posting limit (~15 posts/24 h, shared across ALL apps posting via the API, not only this server). Do not retry today. Tell the user; posting resumes as the 24 h window rolls." |
| `active_user_cap` | no | "This app is unaudited and already served its maximum of 5 posting users in the last 24 h (reached_active_user_cap). Do not retry today. The permanent fix is the developer passing TikTok's app audit." |
| `pending_share_cap` | no | "TikTok blocked this draft: the account already has 5 unpublished API drafts from the last 24 h (spam_risk_too_many_pending_share). Ask the user to open TikTok's inbox notifications and publish or discard pending drafts, then try again." |
| `plan_not_found` | no | "This plan_id is unknown, already used, or expired (plans are single-use and expire <ttl> minutes after the preview). Call the tool again WITHOUT plan_id to generate a fresh preview, show it to the user, and apply with the new plan_id only after the user approves." |
| `plan_mismatch` | no | "The arguments (or the target account) differ from what this plan_id previewed. A plan applies only the exact previewed payload. Call the tool again WITHOUT plan_id to preview the changed arguments, show the new preview to the user, then apply with the new plan_id." |
| `possible_duplicate` | no | "A publish attempt with this title on account '<profile>' was journaled at <ts> with outcome '<ok\|unknown\|pending>'<, publish_id <id>>. Verify with tiktok_get_publish_status and tiktok_list_publish_journal that no post was created. Only if confirmed, re-preview and apply with force: true." |
| `network_ambiguous` | no | "The network failed after the publish request may already have been sent — the post MAY exist upstream. Do NOT apply again. Check tiktok_list_publish_journal (the latest entry will show outcome 'unknown') and tiktok_get_publish_status or tiktok_list_videos first; retry only if no post exists, with a fresh preview." |
| `media_root_not_configured` | no | "source \"file\" is disabled: the operator has not set TT_MEDIA_ROOT (the only directory this server may read media from). Ask the user to set TT_MEDIA_ROOT in the server configuration and restart, or host the media on a verified URL and use source \"url\"." |
| `file_outside_media_root` | no | "file_path resolves to <resolved_abs_path>, which is outside the configured media root <TT_MEDIA_ROOT>. This server only reads media inside that directory (operator policy). Ask the user to move the file there or to change TT_MEDIA_ROOT. Do not attempt alternative paths." |
| `file_not_found` | no | "file_path <resolved_abs_path> does not exist or is not a regular file. Ask the user for the correct path under <TT_MEDIA_ROOT>." |
| `file_too_large` | no | "The file is <size> bytes; TikTok's maximum is <cap>. The user must shorten or re-encode the video." |
| `url_prefix_unverified` | no | "<field> does not match any verified URL prefix configured in TT_VERIFIED_URL_PREFIXES. TikTok only pulls media from domains its developer verified in the TikTok developer portal — this is a platform rule, not a server setting. Use source \"file\" for local video files, or ask the user to host the media under a verified prefix. No request was sent." |
| `upload_interrupted` | no | "Upload failed at chunk <i>/<n> after automatic retries (publish_id <publish_id>). The upload cannot be resumed; TikTok will expire this attempt on its own. Check tiktok_get_publish_status for <publish_id>; if the user still wants the post, generate a fresh preview and apply again — that creates a NEW publish attempt." |
| `privacy_level_unavailable` | no | "privacy_level '<value>' is not available for this account right now. Available options: <comma-separated enum values from creator_info>. Re-preview with one of these. (Unaudited apps allow only SELF_ONLY.)" |
| `branded_content_privacy_conflict` | no | "brand_content_toggle: true cannot be combined with privacy_level SELF_ONLY — TikTok rejects branded content on private-visibility posts. While this app is unaudited, only SELF_ONLY is available, so branded-content posting is not possible at all. Either drop the brand toggle or wait until the app passes TikTok's audit." |

Notes: `upstream_error` message composition never interpolates upstream free text (trust
boundary, § 5); it names the mapped taxonomy class and preserves `log_id` in the
structured field. Error codes `spam_risk_too_many_posts` → `daily_post_cap`,
`reached_active_user_cap` → `active_user_cap`, `spam_risk_too_many_pending_share` →
`pending_share_cap`, `url_ownership_unverified` → `url_prefix_unverified`: the upstream
code is preserved in `error.details.api_code`.

---

### 3.1 `tiktok_get_auth_status`

- **Package**: `auth`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓,
  openWorld ✓ (network only when `probe: true`, but the tuple describes capability, not
  the common case).
- **Description** (normative):

  > Report authentication status for the configured TikTok profile(s): granted scopes,
  > token expiry, and which tool packages are usable per profile. Local and instant by
  > default; set probe: true to additionally verify the token against TikTok with a
  > single user-info call. Call this first when any tool reports an auth or scope error,
  > and again after the user re-runs the login CLI. Never returns token material.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | configured profile | (common contract) |
  | `probe` | boolean | no | default `false` | "true = make one live user-info request to confirm the token works. false (default) = report from local state only, no network." |

- **Output shape**: `{ profiles: [{ name, is_default, open_id_masked, scopes: string[],
  token_expires_at, refresh_expires_at, packages: { auth: "ok", video: "ok"|"missing_scope:video.list", publish: ..., "publish-write": ... },
  probe?: { ok, checked_at } }] }`.
- **Errors**: shared catalog only (`probe: true` can surface `auth_expired`).
- **Hints emitted**: `reauth` when any profile's token is expired/rejected; `user_action`
  when a package is unavailable for every profile (text mirrors the § 6 marker).

### 3.2 `tiktok_get_user_info`

- **Package**: `user`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓, openWorld ✓.
- **Description**:

  > Fetch the authenticated TikTok user's profile: display name, avatar, bio, and counts
  > (followers, following, likes, videos). With the user.info.profile scope it also
  > returns the @username and profile link. Read-only. Requested fields not covered by
  > the granted scopes are omitted and listed in meta.omitted_fields — that is not an
  > error. Avatar URLs are TikTok CDN links that expire after roughly 6 hours; do not
  > store them long-term.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `fields` | string[] | no | enum of documented user fields; default = all grantable | "Profile fields to return. Omit for all fields your scopes allow. Unknown field names fail locally." |

- **Output**: `{ user: { open_id_masked, display_name, avatar_url?, bio_description?,
  username?, profile_web_link?, follower_count?, following_count?, likes_count?,
  video_count? }, meta: { omitted_fields: string[] } }`.
- **Errors**: shared catalog only.

### 3.3 `tiktok_list_videos`

- **Package**: `video`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓, openWorld ✓.
- **Description**:

  > List the authenticated user's PUBLIC videos, newest first, up to 20 per page. Pass
  > cursor from the previous result to get the next page, or set fetch_all: true to
  > auto-paginate up to the server cap. Read-only. TikTok's Display API never returns
  > private or friends-only videos — an incomplete-looking list is usually privacy, not
  > an error. share_url is the stable link to give the user; media/cover URLs expire in
  > about 6 hours.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `cursor` | string | no | opaque | "Opaque pagination token from the previous result's meta.next_cursor. Pass it back unchanged. Do not construct this value yourself." |
  | `max_count` | integer | no | 1–20, default 20 | "Videos per page (1–20)." |
  | `fetch_all` | boolean | no | default `false` | "true = follow pagination automatically until done or the server cap (default 200 items) is hit; the result then reports truncation with a resume cursor." |
  | `fields` | string[] | no | enum; default set excludes `cover_image_url` (AIDX-F12) | "Video fields to return. Omit for the default set (id, title, create_time, duration, stats, share_url)." |

- **Output**: `{ videos: [...], meta: { has_more, next_cursor?, truncation? } }`.
- **Errors**: shared catalog only. Cursor-loop guard (QA-F18): a non-advancing upstream
  cursor terminates the fetch with `truncated: true` and a `note` hint.

### 3.4 `tiktok_query_videos`

- **Package**: `video`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓, openWorld ✓.
- **Description**:

  > Fetch full details for up to 20 specific videos by id. Ids come from
  > tiktok_list_videos or from the user. Read-only. Ids that do not belong to the
  > authenticated user are silently absent from the response — TikTok does not report
  > them as errors — so compare the returned ids against the requested ones.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `video_ids` | string[] | yes | 1–20 items, non-empty strings | "TikTok video ids to fetch (max 20 per call). More than 20 fails locally — split into batches." |
  | `fields` | string[] | no | as § 3.3 | (as § 3.3) |

- **Output**: `{ videos: [...], meta: { requested: n, returned: m, missing_ids: [...] } }`.
- **Errors**: shared catalog only.

### 3.5 `tiktok_get_creator_info`

- **Package**: `publish`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓, openWorld ✓.
- **Description** (AIDX-F9 + PLAT §6/§7):

  > Fetch the creator's live posting state: nickname, the privacy_level options
  > currently available, whether comments/duets/stitch are disabled account-wide, and
  > the maximum allowed video duration. Requires scope video.publish; TikTok limit 20
  > requests/min. You do NOT need to call this before posting — the preview step of
  > tiktok_post_video and tiktok_post_photos runs it automatically and embeds the result.
  > Call it directly only to answer user questions about posting capabilities. If
  > privacy_level_options contains only SELF_ONLY, the app is unaudited: every post will
  > be visible to the account owner only, regardless of arguments.

- **Input schema**: `account` only.
- **Output**: `{ creator: { nickname, privacy_level_options: string[], comment_disabled,
  duet_disabled, stitch_disabled, max_video_post_duration_sec },
  audit_restrictions_active: boolean }` — the derived flag is true when the options are
  exactly `["SELF_ONLY"]` (AIDX-F9), with an explanatory `note` hint.
- **Errors**: shared catalog (notably `missing_scope` for draft-only profiles — the
  description of the draft tools tells the model it never needs this call).

### 3.6 `tiktok_get_publish_status`

- **Package**: `publish`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓, openWorld ✓.
- **Description**:

  > Check — and by default briefly wait on — the status of a publish attempt by
  > publish_id. Read-only, idempotent, safe to repeat; TikTok limit 30 requests/min.
  > Statuses: PROCESSING_DOWNLOAD (pulling from URL), PROCESSING_UPLOAD (checking the
  > uploaded file), SEND_TO_USER_INBOX (draft delivered — the user must open the TikTok
  > app notification to finish), PUBLISH_COMPLETE (live; public_post_id present when
  > TikTok exposes it), FAILED (fail_reason mapped to a recovery action in the result).
  > With wait_for_completion: true (the default) the call polls about every 5 s up to
  > ~60 s and returns the last observed status; a timeout is NOT a failure — call again
  > with the same publish_id. Never re-run a posting tool just because processing is
  > slow.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `publish_id` | string | yes | non-empty | "The publish_id returned by a posting tool (or found in tiktok_list_publish_journal)." |
  | `wait_for_completion` | boolean | no | default `true` | "true (default) = poll internally until a terminal status or ~60 s, then return the last observed status. false = one status request, return immediately." |

- **Output**: `{ status, fail_reason?, fail_recovery?, public_post_id?, uploaded_bytes?,
  downloaded_bytes?, checked_at }`. `public_post_id` is normalized from upstream's
  misspelled `publicaly_available_post_id` (both spellings accepted — QA-F9).
- **`fail_reason` → recovery mapping** (normative `fail_recovery` texts):

  | fail_reason | Recovery text |
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

- **Errors**: shared catalog; plus `publish_not_found` (no retry): "TikTok has no record
  of this publish_id — it may be expired (status is retained only for a limited window)
  or from another app. Check tiktok_list_publish_journal for the attempt and
  tiktok_list_videos for the result."

### 3.7 `tiktok_list_publish_journal`

- **Package**: `publish`. **Annotations**: readOnly ✓, destructive ✗, idempotent ✓,
  **openWorld ✗** (local file only — the one closed-world tool; justification: no
  external system is consulted, results are fully determined by prior local writes).
- **Description**:

  > Read this server's local, append-only journal of publish attempts: timestamp,
  > account, tool, title excerpt, publish_id, and outcome. Outcomes: "ok" (upstream
  > accepted the request), "error" (clean failure), "upload_failed" (init succeeded,
  > upload aborted), "unknown" (the request was sent but no response was recorded — the
  > post MAY exist; verify with tiktok_get_publish_status or tiktok_list_videos before
  > retrying anything). Local file read; no network, no scopes required. Check this
  > first before re-trying any failed or ambiguous publish. The journal only covers
  > posts made through this server on this machine.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | "Filter to one profile. Omit for all profiles." (note: filter, not resolution — no default applied) |
  | `limit` | integer | no | 1–100, default 20 | "Newest entries to return." |
  | `since` | string | no | ISO-8601 | "Only entries at or after this UTC timestamp." |

- **Output**: `{ entries: [{ ts, account, tool, title_excerpt, publish_id?, outcome,
  error_code? }], meta: { journal_path, total_matching } }`.
- **Errors**: `journal_unreadable` (no retry): "The journal file at <path> is missing or
  unreadable. Publishes may still have happened — verify with tiktok_list_videos. Ask
  the user to check the file if an audit trail is required."

### 3.8 `tiktok_post_video`

- **Package**: `publish-write`. **Annotations**: readOnly ✗, **destructive ✓**,
  idempotent ✗, openWorld ✓. Justification: publishes irreversibly to a live account;
  re-invocation creates a new post.
- **Description** (normative, full):

  > Post a video DIRECTLY to the authenticated account's TikTok profile — it goes live
  > without further user action once TikTok finishes processing. Requires scope
  > video.publish. Use when the user says "post/publish this video". NOT for "send it to
  > my drafts" — use tiktok_upload_video_draft for that. Posts cannot be edited or
  > deleted through this server; removal requires the TikTok app.
  >
  > Two-step contract: calling WITHOUT plan_id validates everything (file or URL, title,
  > toggles, live creator settings) and returns a preview plus a single-use plan_id
  > valid for 10 minutes — no post is created. Show the preview to the user, including
  > the consent line it contains. After the user explicitly approves, call again with
  > identical arguments plus plan_id to execute. privacy_level has NO default: the user
  > must pick one of the options listed in the preview (unaudited apps: SELF_ONLY only —
  > the post will be private).
  >
  > Rate limits: 6 posts/min (enforced locally) and roughly 15 posts/24 h per account
  > shared across ALL apps using TikTok's API. On success the call returns publish_id
  > immediately; processing continues asynchronously — follow the returned poll hint to
  > tiktok_get_publish_status.

- **Input schema** (zod `.strict()`, discriminated on `source` — AIDX-F16):

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `source` | `"file" \| "url"` | yes | discriminator | "Where the video bytes come from. \"file\": a local file under the operator-configured TT_MEDIA_ROOT, uploaded in chunks. \"url\": TikTok pulls from an HTTPS URL that must match a verified prefix in TT_VERIFIED_URL_PREFIXES." |
  | `file_path` | string | iff `source:"file"` | resolves inside `TT_MEDIA_ROOT`; MP4/WebM/MOV | "Path to the video file (absolute, or relative to TT_MEDIA_ROOT). Must resolve inside TT_MEDIA_ROOT; checked at preview and re-checked at apply. Mutually exclusive with video_url." |
  | `video_url` | string | iff `source:"url"` | https, matches a verified prefix | "HTTPS URL of the video. Must start with one of the verified URL prefixes; TikTok refuses pulls from unverified domains. Must serve the bytes without redirects and stay reachable for about 1 hour. Mutually exclusive with file_path." |
  | `title` | string | no | ≤ 2200 UTF-16 code units | "Caption. Up to 2200 UTF-16 code units (emoji count as 2, the way TikTok counts). #hashtags and @mentions are parsed by TikTok. Omit for an untitled post." |
  | `privacy_level` | enum `PUBLIC_TO_EVERYONE \| MUTUAL_FOLLOW_FRIENDS \| FOLLOWER_OF_CREATOR \| SELF_ONLY` | for execution | must be in creator's live options | "Who can see the post. NO default — the user must choose from the options in the preview (they depend on account type and app audit status; unaudited apps allow only SELF_ONLY). A preview without this field returns the options and no plan_id." |
  | `disable_comment` | boolean | no | default `false` | "true disables comments on this post. Leave false unless the user asks." |
  | `disable_duet` | boolean | no | default `false` | "true disables duets. If the creator's account already disables duets, the server forces true and flags it in the preview — a false here cannot override it." |
  | `disable_stitch` | boolean | no | default `false` | "true disables stitch. Forced true when the creator's account disables stitch, flagged in the preview." |
  | `video_cover_timestamp_ms` | integer | no | ≥ 0 | "Video frame to use as the cover, in milliseconds from the start. Omit for TikTok's default." |
  | `brand_content_toggle` | boolean | no | default `false` | "true ONLY when the user states this is paid partnership / branded content for a third party. Incompatible with privacy_level SELF_ONLY — and therefore unavailable while the app is unaudited. Adds the Branded Content consent line to the preview." |
  | `brand_organic_toggle` | boolean | no | default `false` | "true when the post promotes the user's OWN business (organic branded content)." |
  | `is_aigc` | boolean | no | default from `TT_DEFAULT_AIGC_LABEL` (ships as `true`) | "Label the post as AI-generated content on TikTok. Defaults to true because posts made through an AI assistant usually are. Set false only if the user confirms the content is not AI-generated." |
  | `wait_for_completion` | boolean | no | default `false` | "After a successful apply, keep polling publish status inside this call (up to ~60 s) before returning. Default false: return publish_id immediately with a poll hint — prefer that; long calls risk client timeouts, and a timed-out write call must never be re-run blindly." |
  | `plan_id` | string | no | `plan_` + 16 hex | "Execution token from this tool's own preview. Present = execute the previewed post. Single-use, expires 10 minutes after the preview, bound to these exact arguments and this account. Never invent or reuse one." |
  | `force` | boolean | no | default `false` | "Override the duplicate guard. Set true only after verifying via tiktok_list_publish_journal and tiktok_get_publish_status that the earlier identical attempt did not create a post." |

- **Preview output** (`mode: "plan"`): `{ mode, plan_id, expires_at, account:
  { profile, nickname, open_id_masked }, action: "DIRECT_POST video", payload:
  { post_info: {...exact fields to be sent...}, source: { type, resolved_path?, url?,
  file_size?, chunk_summary?: { file_size, chunk_size, chunks } } }, derived:
  [{ field, value, reason }], creator: { privacy_level_options,
  max_video_post_duration_sec, ... }, audit_restrictions_active, consent_line }` +
  `approval_required` hint. `mode: "plan_incomplete"` when `privacy_level` is absent:
  same shape minus `plan_id`/`expires_at`, plus `missing: ["privacy_level"]`.
- **Apply output** (`mode: "applied"`): `{ mode, publish_id, status:
  "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD", journal: "recorded" | "unavailable" }` +
  `poll` hint. With `wait_for_completion: true`, additionally the final observed
  `status` (+ `public_post_id` when complete) — and on poll timeout a `poll` hint with
  the AIDX-F14 graceful wording: *"Still PROCESSING_UPLOAD after 60 s — normal for large
  videos. Call tiktok_get_publish_status with publish_id <id>; do not re-post."*
- **Errors**: full shared catalog. Most load-bearing here: `plan_not_found`,
  `plan_mismatch`, `possible_duplicate`, `network_ambiguous`, `upload_interrupted`,
  `privacy_level_unavailable`, `branded_content_privacy_conflict`,
  `media_root_not_configured`, `file_outside_media_root`, `url_prefix_unverified`,
  `local_rate_limited`, `daily_post_cap`, `active_user_cap`.

### 3.9 `tiktok_upload_video_draft`

- **Package**: `publish-write`. **Annotations**: readOnly ✗, **destructive ✓**,
  idempotent ✗, openWorld ✓. Justification: sends content into the user's TikTok inbox
  (an external, non-retractable-through-this-server effect) and consumes the pending-
  share quota; destructive is the honest tuple even though nothing goes live.
- **Description**:

  > Upload a video to the user's TikTok INBOX as a draft — the user must open the TikTok
  > app notification, edit, and publish it themselves; nothing goes live from this call.
  > Requires scope video.upload (NOT video.publish — this tool works on draft-only
  > authorizations). Use when the user says "send it to my drafts / I'll finish it in
  > the app". NOT for direct publishing — use tiktok_post_video. Drafts carry no
  > caption, privacy, or toggles — the user sets those in the app — so this tool takes
  > only the video source. Same preview/plan_id contract as tiktok_post_video. TikTok
  > allows at most 5 unpublished API drafts per account per 24 h; unopened drafts
  > expire on their own. After success, tell the user to open the TikTok app inbox
  > notification to finish the post.

- **Input schema**: `account`, `source`, `file_path`, `video_url` (same rows as § 3.8),
  `wait_for_completion` (default `false`; terminal status here is
  `SEND_TO_USER_INBOX`), `plan_id`, `force`. No title/privacy/toggle fields — the
  upstream inbox init accepts none, and offering dead fields teaches the model false
  affordances.
- **Preview/apply output**: as § 3.8 with `action: "MEDIA_UPLOAD video draft"`; no
  `creator` block and no `consent_line` (no pre-flight — PLAT §6); apply success carries
  a `user_action` hint: *"Tell the user: open the TikTok app notification to edit and
  publish the draft. Unfinished drafts expire."*
- **Errors**: shared catalog; `pending_share_cap` is the signature error here. No
  `privacy_level_unavailable` / `branded_content_privacy_conflict` (fields don't exist).

### 3.10 `tiktok_post_photos`

- **Package**: `publish-write`. **Annotations**: readOnly ✗, **destructive ✓**,
  idempotent ✗, openWorld ✓.
- **Description**:

  > Post a photo carousel DIRECTLY to the user's TikTok profile — it goes live once
  > processing completes. Requires scope video.publish. Use for "post these photos".
  > NOT for "send photos to my drafts" — use tiktok_upload_photos_draft. Posts cannot
  > be edited or deleted through this server.
  >
  > Photos can only be pulled by TikTok from verified URLs (prefixes configured in
  > TT_VERIFIED_URL_PREFIXES) — the photo API has no local-file upload. For photos on
  > disk, the user must first host them under a verified prefix. Title is much shorter
  > than for videos: max 90 UTF-16 code units; the longer text belongs in description
  > (max 4000). Same preview/plan_id contract and the same rate limits (6/min local,
  > ~15 posts/24 h shared) as tiktok_post_video.

- **Input schema**:

  | Field | Type | Req | Constraints | `.describe()` |
  |---|---|---|---|---|
  | `account` | string | no | | (common) |
  | `photo_urls` | string[] | yes | 1–35 items; each https + verified prefix; JPEG/WebP ≤ 20 MB, ≤ 1080p | "HTTPS URLs of the photos, in carousel order (1–35). Every URL must start with a verified prefix from TT_VERIFIED_URL_PREFIXES — TikTok refuses unverified domains. JPEG or WebP, up to 20 MB and 1080p each." |
  | `photo_cover_index` | integer | no | 0 ≤ i < `photo_urls.length`; default 0 | "Zero-based index of the cover photo. Must be a valid index into photo_urls." |
  | `title` | string | no | ≤ 90 UTF-16 code units | "Photo post title — max 90 UTF-16 code units (NOT 2200; photos differ from videos). Longer text goes in description." |
  | `description` | string | no | ≤ 4000 UTF-16 code units | "Photo post description, up to 4000 UTF-16 code units. #hashtags and @mentions are parsed here." |
  | `privacy_level` | enum | for execution | as § 3.8 | (as § 3.8) |
  | `disable_comment` | boolean | no | default `false` | "true disables comments on this post." |
  | `auto_add_music` | boolean | no | default `false` | "true lets TikTok add recommended music to the carousel. Ask the user; photo posts without music play silent." |
  | `brand_content_toggle` | boolean | no | default `false` | (as § 3.8) |
  | `brand_organic_toggle` | boolean | no | default `false` | (as § 3.8) |
  | `is_aigc` | boolean | no | default from `TT_DEFAULT_AIGC_LABEL` | (as § 3.8) |
  | `wait_for_completion` | boolean | no | default `false` | (as § 3.8) |
  | `plan_id` | string | no | | (as § 3.8) |
  | `force` | boolean | no | default `false` | (as § 3.8) |

- **Preview/apply output**: as § 3.8 with `action: "DIRECT_POST photos"`; source block
  lists the URLs and the cover index; duplicate-guard title-hash uses title +
  description.
- **Errors**: shared catalog; `url_prefix_unverified` (per URL, names the first
  offending URL), `privacy_level_unavailable`, `branded_content_privacy_conflict`,
  `daily_post_cap`, `active_user_cap`. No duet/stitch fields exist for photos — the
  schema omission is itself the contract.

### 3.11 `tiktok_upload_photos_draft`

- **Package**: `publish-write`. **Annotations**: readOnly ✗, **destructive ✓**,
  idempotent ✗, openWorld ✓ (same justification as § 3.9).
- **Description**:

  > Send a photo carousel to the user's TikTok INBOX as a draft — the user finishes and
  > publishes it in the TikTok app; nothing goes live from this call. Requires scope
  > video.upload. Use for "send these photos to my drafts". NOT for direct posting —
  > use tiktok_post_photos. Same verified-URL-only rule as tiktok_post_photos (no local
  > photo files — the platform has no photo upload endpoint). Same preview/plan_id
  > contract. Counts toward TikTok's cap of 5 unpublished API drafts per 24 h. After
  > success, tell the user to open the TikTok app inbox notification.

- **Input schema**: `account`, `photo_urls`, `photo_cover_index`, `title`,
  `description` (rows as § 3.10 — title/description are accepted by the photo draft
  endpoint and prefill the app editor, marked *(verify at implementation time)*, § 8),
  `wait_for_completion` (default `false`), `plan_id`, `force`. No privacy, toggles, or
  brand fields.
- **Errors**: shared catalog; `pending_share_cap`, `url_prefix_unverified`. No
  creator_info pre-flight (scope reasons, § 2.0 / AIDX-F9-refined).

---

## 4. Normative interaction flows

Each flow lists the calls the model is expected to make. **[impossible]** marks a wrong
path the design makes unrepresentable; **[discouraged]** marks one that is merely
steered against (with the steering named).

### 4.1 First post, local file (audited app)

1. `tiktok_post_video { source: "file", file_path: "clips/a.mp4", title: "..." }`
   → `mode: "plan_incomplete"`, live `privacy_level_options`, no `plan_id`.
   **[impossible]** Posting without an explicit privacy choice — no default exists and
   no token is minted without the field (PLAT §12).
2. Model asks the user to choose privacy; re-calls with `privacy_level` →
   `mode: "plan"` + `plan_id` + preview (resolved path, byte size, chunk summary,
   forced toggles flagged, consent line) + `approval_required` hint.
   **[impossible]** Executing without a preview having existed — `plan_id` is random,
   single-use, unforgeable. **[discouraged]** Skipping the human approval itself — the
   server cannot verify a conversation happened; steering = the `approval_required`
   hint's imperative text and the preview's consent line (and `TT_WRITE_MODE=plan`
   being the default).
3. User approves → same call + `plan_id` → validation re-run, duplicate guard, journal
   write-ahead, init, chunk PUTs with progress notifications → `{ publish_id, status:
   "PROCESSING_UPLOAD", journal: "recorded" }` + `poll` hint.
   **[impossible]** Applying with silently changed args (hash mismatch ⇒
   `plan_mismatch`), against a different account (open_id binding), after 10 min
   (TTL), or twice (single-use).
4. `tiktok_get_publish_status { publish_id }` (waits by default) →
   `PUBLISH_COMPLETE` + `public_post_id` → model reports the share URL.

### 4.2 Unaudited app

1. Preview call as above → `creator` block shows `privacy_level_options:
   ["SELF_ONLY"]`, `audit_restrictions_active: true`, and a `note` hint: *"This app has
   not passed TikTok's audit: the post can only be SELF_ONLY (visible to the account
   owner alone) and the app can serve at most 5 posting users per 24 h. Tell the user
   before applying."*
2. `brand_content_toggle: true` in the same call ⇒ local
   `branded_content_privacy_conflict` — **[impossible]** posting branded content
   unaudited; the error explains why, before any network call (PLAT §3).
3. Apply proceeds as § 4.1 with `privacy_level: "SELF_ONLY"`. A sixth distinct user in
   24 h gets `active_user_cap` ("do not retry today" — AIDX-F15 class).
   **[discouraged]** Retry-looping on cap errors — steering = `retryable: false` +
   explicit "Do not retry today" text; nothing stops a client from calling again, but
   every response repeats the same instruction.

### 4.3 Interrupted upload recovery

1. Apply as § 4.1; chunk 3/5 PUT fails; in-call retries (3×, backoff) exhaust →
   `upload_interrupted` error with `publish_id`, chunk index, and the § 3 recovery
   text; journal gains `outcome: "upload_failed"`.
   **[impossible]** Resuming a half-upload in a later call — `upload_url` is never
   persisted or returned (capability containment beats resume convenience).
2. `tiktok_get_publish_status { publish_id }` → typically `FAILED` (or stuck
   `PROCESSING_UPLOAD` until TikTok expires it) — the model reports honestly.
3. If the user still wants the post: fresh preview (the old plan was consumed at
   apply), fresh `plan_id`, apply. Journal `upload_failed` does **not** trip the
   duplicate guard, so no `force` is needed.
   **[impossible]** The lost-response variant: if the failure was ambiguous
   (`network_ambiguous`, journal `unknown`), the guard DOES trip and a blind re-apply
   is refused — the model must verify via status/journal/list and then use `force`
   deliberately.

### 4.4 Re-auth flow

1. Any tool call → single-flight refresh fails terminally → `auth_expired` + `reauth`
   hint naming the exact command: `npx tiktok-mcp-ai login --profile <name>`.
   **[impossible]** The model re-authenticating by itself — login is a CLI/browser
   flow (hex-PKCE, loopback listener) with no tool-surface path to it; the only move
   is asking the user.
2. User runs login; the credential-store watcher reloads the profile, recomputes
   availability, updates descriptions, emits `notifications/tools/list_changed` (§ 6).
3. Model calls `tiktok_get_auth_status` (fresh scopes/expiry confirm) and retries the
   original call. **[discouraged]** Retrying before the user confirms login — steering
   = "Do not retry this call until re-login completes" in the `auth_expired` text.

---

## 5. Hints specification

Hints are the server's only channel for next-step guidance. They are **server-authored
text with typed structure**; content blocks and `data` carry facts, hints carry
imperatives.

### Closed vocabulary (six types — clients and tests reject anything else)

| `type` | Structured fields | Emitted when |
|---|---|---|
| `wait` | `retry_after_s: number`, `retry_at: ISO-8601 UTC` | Rate limits (upstream 429, local bucket), transient upstream throttles |
| `poll` | `tool: string`, `publish_id: string`, `poll_after: ISO-8601 UTC` | After apply (default no-wait), after a status-poll timeout |
| `approval_required` | `plan_id: string`, `expires_at: ISO-8601 UTC` | Every `mode: "plan"` preview |
| `user_action` | `action: "login" \| "open_tiktok_app" \| "move_file" \| "host_media" \| "configure_server" \| "wait_for_audit"` | Anything only the human/operator can do |
| `reauth` | `command: string` (exact CLI line), `profile: string` | `auth_expired`, `auth_removed`, revocation |
| `note` | — | Informational: truncation cause, draft-inbox reminder, `journal: "unavailable"`, unaudited explanation |

Every hint additionally has `text: string` — the model-facing sentence(s).

### Grammar rules (normative)

1. `text` is 1–3 short imperative sentences, ≤ 300 characters total. Concrete values
   (tool names, profile names, timestamps, commands) are inlined; vague references
   ("try later", "the relevant tool") are forbidden.
2. Times are always **absolute ISO-8601 UTC in the text**, with relative seconds only
   in structured fields. Models cannot reliably do "in 37 s" arithmetic across turns;
   they can compare clocks.
3. **Trust boundary — no upstream interpolation.** Hint text is composed exclusively
   from server-owned templates plus a whitelist of interpolants: configured profile
   names, tool names, enum values, numbers, ISO timestamps, and the server's own CLI
   command strings. TikTok-supplied strings (error messages, titles, nicknames, any
   user content) never enter a hint. Upstream text lives only in clearly-labeled data
   fields — a hint is an instruction channel, and instructions must have exactly one
   author.
4. At most 3 hints per result, ordered most-actionable-first. A result that needs more
   than 3 is a design smell — fold the rest into `data`.
5. Hints never contradict the error text; the error states cause + recovery, the hint
   operationalizes the recovery (exact call, exact time, exact command).

### Examples (normative renderings)

- `wait`: `{ type: "wait", retry_after_s: 42, retry_at: "2026-07-22T09:31:07Z",
  text: "Rate limit: wait until 2026-07-22T09:31:07Z, then apply again with a fresh
  preview. Do not retry earlier." }`
- `poll`: `{ type: "poll", tool: "tiktok_get_publish_status", publish_id:
  "v_pub_abc123", poll_after: "2026-07-22T09:30:40Z", text: "Call
  tiktok_get_publish_status with publish_id \"v_pub_abc123\" after
  2026-07-22T09:30:40Z to confirm the post went live. Do not re-post." }`
- `approval_required`: `{ type: "approval_required", plan_id: "plan_9f3ac2d47b01e5aa",
  expires_at: "2026-07-22T09:40:00Z", text: "Show this preview to the user, including
  the consent line. Only after explicit approval, call the tool again with the same
  arguments plus plan_id \"plan_9f3ac2d47b01e5aa\" (valid until
  2026-07-22T09:40:00Z)." }`
- `user_action` (draft): `{ type: "user_action", action: "open_tiktok_app", text:
  "Tell the user: open the TikTok app notification to edit and publish the draft.
  Unopened drafts expire." }`
- `reauth`: `{ type: "reauth", profile: "brand", command: "npx tiktok-mcp-ai login
  --profile brand", text: "Ask the user to run: npx tiktok-mcp-ai login --profile
  brand — then verify with tiktok_get_auth_status before retrying." }`

---

## 6. Scope / UNAVAILABLE lifecycle — the concrete contract

Four moments, one rule: **markers are advisory, the call-time check is authoritative.**

1. **Startup marker.** For each tool with required scopes, availability = ∃ a configured
   profile whose granted scopes cover them (union across profiles — ARCH-F8; a tool
   usable by *any* profile is not "unavailable"). When no profile qualifies, the
   description is prefixed:
   `[UNAVAILABLE: requires scope video.publish; no configured profile grants it. Fix:
   npx tiktok-mcp-ai login --scopes video.publish]`
   The tool stays registered and callable — hiding it would strand clients that cache
   tool lists, and the marker text is itself the recovery documentation.
2. **Call time (authoritative).** The handler re-reads the credential snapshot on every
   call, resolves the profile, and checks that profile's scopes. Missing ⇒ structured
   `missing_scope` error with per-profile phrasing (§ 3 catalog) + `reauth`/`user_action`
   hint — even if the description carried no marker (multi-profile case: the union may
   be fine while the *chosen* profile is not), and conversely a stale marker never
   blocks a call that would now succeed.
3. **Credential-store watch.** The env file(s) are watched (debounced ≥ 500 ms; plus an
   unconditional re-read before each refresh — DEVOPS-F8). On a change that alters any
   tool's availability or marker text: recompute descriptions, update the registry, and
   emit `notifications/tools/list_changed`. The server declares
   `capabilities.tools.listChanged: true` at initialize — without the declaration the
   notification is dead letter (AIDX-F5).
4. **Self-description.** `tiktok_get_auth_status` reports the per-profile ×
   per-package availability matrix (§ 3.1) so the model can diagnose scope problems
   without parsing description prefixes. The login CLI prints the same matrix after
   granting, closing the loop: marker → error → auth-status → login → list_changed →
   clean call.

---

## 7. Spec amendments — restructuring `docs/TOOLS.md`

Replace the current TOOLS.md body with this structure (content from § 3–6 above):

1. **Surface at a glance** — the § 3.0 table (tools × package × annotations × scope).
   This table is the *source* the README tool table and the manifest-snapshot fixture
   are generated from/checked against (QA-F13: snapshot computed under a full-scopes
   baseline env; marker injection tested separately).
2. **Common contract** — envelope, `account` injection, validation-before-network,
   truncation, token discipline, and the **plan lifecycle** (§ 2.1 verbatim: preview →
   plan_id → apply; TT_WRITE_MODE matrix; duplicate guard; consumed-on-apply rule).
   The current TOOLS.md preamble's `apply: true` wording is superseded.
3. **Shared error catalog** — the § 3 table, single source; per-tool sections reference
   it and list only additions. Message texts are normative: tests assert substrings
   against this file (QA-F22's table-driven mapping tests point here).
4. **Hints specification** — § 5 verbatim (closed vocabulary + grammar). New hint types
   require editing this section first — the vocabulary is closed by construction.
5. **Scope/UNAVAILABLE lifecycle** — § 6 verbatim.
6. **Per-tool reference** — §§ 3.1–3.11, one fixed template per tool: Name / Package /
   Annotations (with justification) / Description (normative text) / Input schema table
   (field, type, required, constraints, `.describe()` text) / Output shape / Errors /
   Hints emitted. The `.describe()` texts in this document are the strings that go into
   the zod schemas — TOOLS.md and the code must not drift (the manifest snapshot is the
   gate).
7. **Appendices** — A: `fail_reason` → recovery table (§ 3.6); B: platform limits
   quick-sheet (title 2200/90/4000 UTF-16; 6/min, 20/min, 30/min, ~15/day shared;
   5 drafts/24 h; 5 users/24 h unaudited; chunk rules; media formats) with *(verify)*
   markers carried over from TIKTOK-API.md.

Ripples into other docs (list, not prose): CONFIGURATION.md gains `TT_MEDIA_ROOT`,
`TT_VERIFIED_URL_PREFIXES`, `TT_PLAN_TTL_S` (default 600), `TT_LOCK_PROFILE`,
`TT_JOURNAL_MAX_BYTES`, and rewrites `TT_WRITE_MODE` semantics per § 2.1 (including the
"apply = trusted automation only, no injection resistance" sentence). ARCHITECTURE.md
§ 8 adopts the § 2.2 journal entry shape and the plan-store (in-memory, never
persisted). TESTING.md picks up the QA round-1 items that this contract makes testable:
the registry-wide plan sweep and preview/apply payload-equality invariants (QA deep
dive 6.3) now have exact field names to assert against.

---

## 8. Remaining unknowns

Carried forward with owners; none block Phase 0, all block their Phase-2 features.

1. **Photo-draft `post_info`** — does `content/init` with `post_mode: MEDIA_UPLOAD`
   accept `title`/`description` (prefilling the app editor)? § 3.11 assumes yes,
   marked *(verify)*. If no: drop both fields from the schema before implementation —
   do not ship dead fields.
2. **Draft expiry window** — how long an unopened inbox draft lives (affects the
   § 3.9/3.11 `user_action` hint wording; currently "unopened drafts expire" with no
   number). Verify in sandbox.
3. **Status retention window** — how long `status/fetch` remembers a `publish_id`
   (drives the `publish_not_found` wording and journal-vs-status guidance).
4. **Intermediate chunk-PUT response codes** — 206-per-chunk/201-final is assumed for
   the retry classifier; must be recorded from a real sandbox run (QA deep dive 6.1.2)
   before the in-call retry matrix is frozen.
5. **`reached_active_user_cap` post-audit behavior** — PLAT reports it persists after
   audit in some form; and whether MEDIA_UPLOAD drafts are exempt from the DAU cap.
   Affects only error-text nuance, but verify before hard-coding "unaudited" into the
   `active_user_cap` message (current text hedges correctly).
6. **`auto_add_music` on photo DIRECT_POST** — field accepted upstream? *(verify)*;
   same dead-field rule as #1.
7. **Upstream cancel endpoint** — TikTok documents a publish-cancel route; if verified
   usable, a `tiktok_cancel_publish` tool (12th) is the natural v1.2 addition — it
   would soften `destructiveHint` on nothing (posts stay irreversible) but would give
   `upload_interrupted` a cleanup step. Out of v1.1 scope.
8. **Exact file-size cap for video uploads** — `file_too_large` currently
   parameterizes `<cap>`; pin the number (and the ≤ 128 MB merged-final-chunk rule's
   interaction with it) during sandbox verification.

---

*End of round-2 review. The tool surface in § 3 is final for v1.1: 11 tools, 5
packages, plan_id-only write gating, wait-on-the-reader defaults. Supersedes the
per-tool content of `docs/TOOLS.md` as specified in § 7.*
