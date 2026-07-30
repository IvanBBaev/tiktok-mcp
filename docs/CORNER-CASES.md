# Corner-case catalog

Systematic enumeration of the edge cases the implementation must handle, decided
at design time so tests can be written first. Sources: the spec (`docs/`), the
round-1 reviews (`docs/reviews/`), and TikTok platform behavior as verified
there.

- **ID scheme:** `CC-<domain><n>`. IDs are referenced from
  `docs/IMPLEMENTATION-PLAN.md` (which work package owns each case) and should be
  reused in test names (`cc-a1 rotation persisted before first use`).
- **Status:** every case is **decided** (behavior stated here). Round 2
  (`docs/reviews/round2/SYNTHESIS.md`) closed the last OPEN items — see the
  table at the end; two upstream facts stay empirically verified by sandbox
  probes (P-1, P-2) without blocking the design.

---

## A. OAuth & token lifecycle

- **CC-A1 — refresh rotation lost on crash.** TikTok rotates the refresh token
  on every refresh. The new refresh token is **persisted to the env file before
  the new access token is used** for any request; a crash between receipt and
  persist must be the only loss window, and it is closed by writing both tokens
  in one atomic env-file write.
- **CC-A2 — concurrent refresh across processes.** Two MCP server processes
  refresh the same profile; last-write-wins would drop the newer rotated
  refresh token and brick the profile. All env-file writes go through the
  cross-process lock manager (lock file + read-merge-write; see round-2
  architecture review). Inside one process, refresh is single-flight per
  profile.
- **CC-A3 — access token expires mid-chunked-upload.** Chunk PUTs authenticate
  via the `upload_token` in the `upload_url`, not the bearer, so a running
  upload survives access-token expiry; the **status/fetch after** the upload
  triggers a normal refresh. No mid-upload refresh coupling.
- **CC-A4 — local clock skew.** Expiry is computed as `received_at +
  expires_in`; both are stored. If the stored expiry is in the past at load
  time but a request still succeeds, trust the API, not the clock. Proactive
  refresh uses the skew window (`TT_TOKEN_REFRESH_SKEW_S`) against wall clock;
  a 401 fallback path exists regardless (one forced refresh + one replay,
  idempotent requests only).
- **CC-A5 — refresh token near/at 365-day expiry.** `tiktok_get_auth_status` and
  `doctor` warn when `refresh_expires_at` is within 30 days; an expired refresh
  token is a **terminal** error naming the `login` command — never a retry
  loop.
- **CC-A6 — user revokes app access in TikTok settings.** API calls fail with
  an invalid-token code and refresh fails with `invalid_grant`; both map to the
  same terminal "re-run `tiktok-mcp-ai login`" error.
- **CC-A7 — re-login grants fewer scopes.** Scope set shrinks while the server
  runs. Tools already registered stay registered; a call missing its scope
  returns the scope error with the login remediation. The credential-store
  watch + `tools/list_changed` lifecycle (round-2 AI/DX review) upgrades this
  to dynamic re-registration; until then the `[UNAVAILABLE]` marker is computed
  at startup only.
- **CC-A8 — login loopback port strategy.** RESOLVED (SYNTHESIS § 2.11): the
  registered redirect is the wildcard-port form `http://127.0.0.1:*/callback/`
  (trailing slash mandatory; the `redirect_uri` sent must be byte-identical to
  the effective URL), and the default bind is `127.0.0.1:0` — an ephemeral
  port, so "port busy" is a non-event by default. `TT_REDIRECT_PORT` remains an
  optional pin; if the pinned port is occupied, fail with a message naming the
  variable and offer the manual-paste fallback. Never silently bind a port
  shape that is not registered.
- **CC-A9 — callback hit twice / state mismatch.** The loopback server accepts
  exactly one authorization response: `state` must match (constant-time), a
  second hit (browser prefetch, reload) gets a static "already handled" page
  and is not exchanged. A failed exchange consumes the attempt — the user
  restarts `login`.
- **CC-A10 — manual-paste fallback input.** Accept either the full redirect URL
  or the bare `code`; parse, validate `state` when present in the pasted URL;
  reject with a clear message otherwise.
- **CC-A11 — login over an existing profile.** `login` into a profile that
  already has tokens prompts for confirmation (TTY) or requires
  `--force` (non-TTY) before overwriting; it prints which TikTok account
  (open_id/display name) is being replaced.
- **CC-A12 — OAuth endpoints do not speak the `{data,error}` envelope.** Token
  and revoke endpoints return flat OAuth-style JSON (`error`,
  `error_description`, `log_id`). They get a dedicated decoder — the envelope
  decoder must not be applied (round-1 platform finding).
- **CC-A13 — PKCE encoding.** CONFIRMED (round 2): `code_challenge` is the
  **lowercase-hex** SHA-256 of the verifier (TikTok deviation from RFC 7636
  base64url); a pinned test vector lives in AUTH.md. The code isolates the
  encoding in one function so a flip is a one-line change if TikTok ever
  aligns with the RFC.

## B. HTTP, envelope & retry

- **CC-B1 — HTTP 200 + `error.code !== "ok"`.** Canonical TikTok failure shape:
  raise `TikTokError` with `apiCode` and `log_id`; never treat HTTP status
  alone as success.
- **CC-B2 — non-JSON body.** 5xx (or even 200) with an HTML/empty/truncated
  body from a gateway: wrap as `TikTokError` with the HTTP status and a body
  snippet (redacted, length-capped); never crash on `JSON.parse`.
- **CC-B3 — `Retry-After` variants.** Honor both seconds and HTTP-date forms;
  cap at `min(30s, remaining budget)`; absent header → exponential backoff with
  jitter.
- **CC-B4 — connection reset before vs after request write.** For
  non-idempotent calls (publish inits) a reset after the request may mean the
  server processed it: **never retried**, surfaced as outcome-unknown with the
  journal-based reconciliation hint. Idempotent reads retry normally.
- **CC-B5 — client-side timeout on a publish init.** Same as CC-B4: the init
  may have succeeded. The journal records intent before the init fires, so the
  reconciliation tool can list recent intents without confirmed outcomes
  (round-2 architecture/AI-DX design).
- **CC-B6 — redirects.** API fetches run with `redirect: "error"` — a redirect
  off the pinned origin is an egress violation, not something to follow.
- **CC-B7 — retry matrix classes.** Three classes, not two: idempotent
  reads (retry 429/5xx/network), publish inits (no retry, ever), **chunk PUTs**
  (retryable per-chunk with an identical `Content-Range` — TikTok's docs
  officially instruct retrying a chunk on 5xx, and the byte range makes the
  re-PUT safe; in-call retries capped by `TT_CHUNK_RETRIES`; 4xx terminal,
  403 = expired upload URL → no auto-re-init, 416 → resync via
  `uploaded_bytes`). `Retry-After` respected in all retryable classes.
- **CC-B8 — rate-limit collision across processes.** The 6/min init budget is
  per user token, but the local token bucket is per-process. A second process
  can consume TikTok's budget; the resulting API spam/rate error on init is
  surfaced as non-retryable with a wait hint — the local bucket is a courtesy,
  not the enforcement point.
- **CC-B9 — missing `log_id`.** Tolerated everywhere it is normally expected;
  error formatting must not assume its presence.

## C. Pagination & data reads

- **CC-C1 — cursor is opaque.** Pass through verbatim (round-1 finding: do not
  type it as a unix timestamp). Empty string / `0` / absent are distinct;
  absent means "from the start".
- **CC-C2 — `has_more: true` with an empty page.** Legal; `fetch_all` continues
  as long as the cursor advances.
- **CC-C3 — cursor loop guard.** If a page returns the same cursor it was
  called with, break with `truncated: true` and a hint — never loop forever.
- **CC-C4 — `fetch_all` cap boundary.** Cap hit exactly at a page boundary with
  `has_more: false` → not truncated; cap cuts items mid-stream → `truncated:
  true` plus the cursor to resume from.
- **CC-C5 — `max_count` clamping.** Video list `max_count` is 1–20; out-of-range
  input is clamped locally with a note in the result rather than round-tripping
  a validation error from TikTok.
- **CC-C6 — `video.query` id limits.** More than 20 ids requested → split is
  **not** silent: reject locally, tell the model to batch (predictability over
  magic).
- **CC-C7 — deleted/private video ids in query.** Response simply omits them;
  the result includes a `missing_ids` list so the model does not re-request
  forever.

## D. FILE_UPLOAD & media handling

- **CC-D1 — zero-byte / missing / unreadable file.** Rejected locally at plan
  time (stat + open check) with the file path in the error; no init is spent.
- **CC-D2 — chunk plan boundaries.** Decimal algorithm (SYNTHESIS § 2.4,
  normative in TIKTOK-API.md): `MIN_WHOLE = 5_000_000`,
  `CHUNK_SIZE = 64_000_000` — decimal bytes, not MiB. Files below 5,000,000
  bytes upload as one whole chunk; otherwise
  `chunk_size = min(size, 64_000_000)`,
  `total_chunk_count = floor(size / chunk_size)`, and the **final chunk absorbs
  the remainder** (may reach 127,999,999 bytes). Count bounds 1–1000; size cap
  4 GiB. Worked vectors V1–V8 are the shared property-test fixture; property
  tests assert chunks are in-bounds, contiguous, and sum to the file size.
- **CC-D3 — file changed between plan and apply.** Plan records size + mtime;
  apply re-stats and aborts on mismatch ("file changed since plan") — the chunk
  plan and the preview the human approved are otherwise stale.
- **CC-D4 — file deleted between plan and apply.** Same re-stat catches it;
  clean local error, no init spent.
- **CC-D5 — upload_url TTL (1 h) expires mid-upload.** PUTs start failing;
  do **not** auto-re-init (spends the 6/min budget and creates an orphaned
  pending publish). Surface the failure with the publish_id and the
  re-plan remediation.
- **CC-D6 — re-PUT of an already-accepted range.** Needed for CC-B7 chunk
  retries. Design closed (SYNTHESIS § 2.13): retry with an **identical**
  `Content-Range`; a 416 means the server is ahead → resync from
  `uploaded_bytes`; accepted-range tolerance is confirmed empirically by
  **probe P-2** before the Phase-2 retry-matrix freeze.
- **CC-D7 — per-chunk vs whole-transfer timeout.** `TT_UPLOAD_TIMEOUT_MS` is
  per chunk PUT; the whole transfer has no separate wall-clock cap (a 4 GB
  upload legitimately takes long). Progress is reported via MCP progress
  notifications when the client supports them.
- **CC-D8 — path confinement.** `file_path` resolves inside `TT_MEDIA_ROOT`
  (realpath after symlink resolution, prefix check on the resolved path);
  traversal, symlinks escaping the root, directories, and device files are
  rejected. Relative paths resolve against `TT_MEDIA_ROOT`, not CWD.
- **CC-D9 — wrong container/codec.** The server does not probe media; format
  errors surface asynchronously as `FAILED` + `fail_reason` from status/fetch.
  Tool descriptions state the accepted formats so the model can pre-check by
  extension.
- **CC-D10 — PULL_FROM_URL constraints.** `https:` only, no credentials-in-URL,
  and the domain-verification requirement stated up front; the
  `url_ownership_unverified` error maps to a remediation explaining portal
  domain verification. Photos are PULL_FROM_URL-only, so local photo files are
  impossible in v1 — the tool description says so explicitly (round-1 platform
  finding).

## E. Publish flow & platform policy

- **CC-E1 — requested privacy level not offered.** Validate against
  `creator_info.privacy_level_options` at plan time; `SELF_ONLY`-only lists
  (unaudited app) produce a plan preview that says why. The apply path
  **re-queries** creator_info (options may have changed since the plan).
- **CC-E2 — `brand_content_toggle` × `SELF_ONLY`.** Invalid combination —
  rejected locally with the platform's rule quoted (round-1 platform
  correction).
- **CC-E3 — title/description length in UTF-16 code units.** Photo title cap
  90, description 4000; video caption cap per platform docs. Measured in UTF-16
  code units (`String.prototype.length`), matching TikTok — documented so emoji
  counting surprises are explainable.
- **CC-E4 — creator has interactions disabled.** `comment_disabled` etc. from
  creator_info gate the request flags at plan time instead of failing at
  publish.
- **CC-E5 — duration cap.** `max_video_post_duration_sec` cannot be checked
  locally (no media probing); the plan preview includes the cap so the human
  sees it, and the async `FAILED` maps to a clear message.
- **CC-E6 — pending-share cap.** `spam_risk_too_many_pending_share` (5 pending
  inbox drafts / 24 h) maps to "open the TikTok app and publish or discard
  pending drafts".
- **CC-E7 — duplicate post after MCP-client retry.** A client-side timeout may
  cause the model (or client middleware) to re-call the execute step. The
  `plan_id` is single-use and is **consumed atomically before the init is
  dispatched** (SYNTHESIS § 2.8), so a second call with the same plan_id fails
  with `plan_not_found` instead of double-posting. The journal duplicate guard
  (same payload digest with an ok/unknown outcome within 10 minutes) is the
  independent second layer, overridable only with `force: true`.
- **CC-E8 — publish status polling.** `wait_for_completion` polls until
  terminal status or `TT_STATUS_POLL_TIMEOUT_MS`; timeout is **not** failure —
  the result says "still processing" with the publish_id and a poll-again hint.
  Unknown/expired publish_id maps to a hedged `publish_not_found` message
  (retention window unknown upstream — probe P-1; the journal is the durable
  record either way).
- **CC-E9 — photo-specific bounds.** 0 photos, > 35 photos,
  `photo_cover_index` out of range — all rejected locally.
- **CC-E10 — journal outcome unknown.** Server crash between init and status:
  journal holds an intent without an outcome; `doctor` and the journal-listing
  tool surface these for reconciliation.

## F. Config & env file

- **CC-F1 — env-file parse edge cases.** Missing file (fine — process env may
  suffice), unreadable file (explicit error), malformed line (error naming the
  line number), duplicate key (**last wins**, warning logged), CRLF endings
  (tolerated, preserved on rewrite).
- **CC-F2 — empty string vs unset.** `TT_X=""` counts as **set** (overrides the
  env file with "empty") — resolution is presence-based; validation then
  rejects empties where a value is required.
- **CC-F3 — permissions drift.** Env file not `0600` → `doctor` warns and
  offers to fix; runtime writes always (re)apply `0600` (asserted on POSIX
  only; on Windows `chmod` is a no-op and `doctor` prints the `icacls`
  remediation instead — see CC-H3).
- **CC-F4 — profile-name edge cases.** Profile names are validated
  (`[A-Z0-9_]+`, upper-cased on read); a profile literally named `DEFAULT`
  collides with the implicit default sextet and is rejected;
  `TT_ACTIVE_PROFILE` pointing at a nonexistent profile is a startup
  configuration error listing the profiles that do exist.
- **CC-F5 — writer collision.** `login`/refresh/doctor writing concurrently is
  serialized by the same cross-process lock as CC-A2; a stale lock (holder
  crashed) is broken after a bounded age with a warning.
- **CC-F6 — numeric env validation.** Every numeric TT_ var is zod-validated at
  startup: garbage → one aggregated startup error, not NaN behavior at call
  time.

## G. MCP layer & transport

- **CC-G1 — unknown arguments.** `.strict()` schemas reject unknown keys with
  the offending key named (catches model hallucinated params early).
- **CC-G2 — truncation correctness.** Over-budget results are truncated to
  **valid JSON** (item-level elision with a `truncated` marker), never a
  mid-string byte cut; multibyte characters cannot be split.
- **CC-G3 — stdout purity.** Nothing but protocol frames on stdout — enforced
  by a lint ban on `console.log` and a test that boots the server and asserts
  stdout emptiness around a tool call (round-1 QA finding).
- **CC-G4 — request cancellation.** MCP cancel mid-upload aborts the in-flight
  chunk PUT via `AbortSignal`; the journal keeps the intent with outcome
  unknown (CC-E10 path).
- **CC-G5 — concurrent calls on one profile.** Parallel reads share the
  single-flight refresh; parallel applies queue on the per-profile token
  bucket; two applies with the same plan_id — first wins, second gets CC-E7.
- **CC-G6 — HTTP transport hardening.** `TT_HTTP_TOKEN` is required whenever
  `TT_TRANSPORT=http`, including a loopback bind (SYN-31) — the server refuses
  to start without it. Loopback bind still validates `Origin`/`Host`
  (DNS-rebinding defense, round-1 security finding); a non-loopback bind
  additionally requires TLS termination or an explicit `TT_HTTP_INSECURE=1`
  acknowledgement.
- **CC-G7 — result char budget vs hints.** Truncation never removes the `ok`,
  `error`, or `hints` fields — only data payloads shrink.

## H. Time & platform environment

- **CC-H1 — sleep/suspend.** Laptop sleep across a poll or bucket window:
  intervals use wall-clock deadlines re-checked on wake (not accumulated
  `setInterval` ticks); token expiry always re-derived from stored absolute
  timestamps.
- **CC-H2 — timestamps.** All persisted times are ISO-8601 UTC; all
  comparisons are numeric epoch — no locale/DST sensitivity anywhere.
- **CC-H3 — Windows.** `chmod 0600` is a near-no-op; paths differ; CRLF.
  **RESOLVED (SYNTHESIS § 2.1): full Windows support.** Write target
  `%LOCALAPPDATA%\tiktok-mcp-ai\.env`; `fs.chmod(0o600)` called
  unconditionally (no-op on win32), mode asserted only on POSIX; never spawn
  `icacls` automatically — doctor prints it as remediation text; EPERM/EBUSY
  rename retried ×3 then degrade to in-memory token + warn; Windows CI leg
  blocking from Phase 0.
- **CC-H4 — deterministic tests.** Every time-dependent behavior above
  (skew refresh, bucket, poll, lock staleness) is driven through an injectable
  clock so tests never sleep (round-1 QA finding; harness in the round-2 QA
  review).

---

## Open items — closed by round 2 (SYNTHESIS.md § 5)

All five items were adjudicated by `docs/reviews/round2/SYNTHESIS.md`; two
carry sandbox probes for empirical confirmation (probe list: SYNTHESIS § 6).

| ID | Question | Resolution |
|---|---|---|
| CC-A13 | Hex PKCE encoding | **CLOSED — CONFIRMED.** `code_challenge` = lowercase-hex SHA-256 of the verifier; pinned test vector in AUTH.md; encoding isolated in one function. |
| CC-D6 | Re-PUT of an accepted chunk range | **Design closed:** chunk PUTs are a retryable class (identical `Content-Range`; 416 → resync via `uploaded_bytes`; 4xx terminal; 403 = expired URL, no auto-re-init). Accepted-range tolerance verified by **probe P-2** before the Phase-2 retry-matrix freeze. |
| CC-E8 | publish_id/status retention window | **Open upstream — probe P-1.** Until answered: `publish_not_found` text hedges, journal is the durable record. |
| CC-H3 | Windows support level | **CLOSED — full support** per SYNTHESIS § 2.1 (see CC-H3 above). |
| — | Regional upload host in egress allowlist | **CLOSED.** Enumerated apexes + anchored `^upload\.<region>\.tiktokapis\.com$` pattern; bare `endsWith` banned; observed hosts recorded by **probe P-9**. |
