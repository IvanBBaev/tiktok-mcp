# TikTok API landscape reference

> Upstream facts this design is built on. Verified against developers.tiktok.com
> during the round-2 platform review (2026-07-22) and reconciled to the binding
> round-2 synthesis. This document is **standalone-normative**: every platform
> fact below is either a binding statement or carries a named sandbox probe
> (**P-1..P-16**, indexed in Appendix A) that verifies it empirically before the
> affected freeze point. No unresolved "(verify at implementation time)" markers
> remain; new upstream observations change this doc by spec edit, never by
> runtime improvisation.

All API hosts:

| Host | Used for |
|---|---|
| `https://www.tiktok.com/v2/auth/authorize/` | Browser-facing OAuth authorization page (user consent) |
| `https://open.tiktokapis.com` | Token exchange/refresh/revoke, Display API, Content Posting API |
| `https://open-upload.tiktokapis.com` | FILE_UPLOAD chunk PUTs (default `upload_url` host) |
| `https://upload.<region>.tiktokapis.com` | FILE_UPLOAD chunk PUTs (regional `upload_url` host, e.g. `upload.us.tiktokapis.com`) |

The upload hosts are never called directly — they only ever appear inside the
`upload_url` returned by an init call, and that URL is validated against the
egress allowlist in § 4.7.

Headers:

- All `open.tiktokapis.com` endpoints expect
  `Authorization: Bearer <user access token>`.
  **Exception:** chunk PUTs to the `upload_url` carry **no** `Authorization`
  header — the `upload_token` embedded in the URL is the credential (§ 4.7).
- OAuth token endpoints expect `Content-Type: application/x-www-form-urlencoded`;
  data endpoints expect `Content-Type: application/json; charset=UTF-8`; chunk
  PUTs send the media MIME type (§ 4.6).

---

## 1. Error shapes — a trichotomy, selected by endpoint class

Three distinct error shapes exist. The client selects the parser by endpoint
class, never by guessing (rationale: SYNTHESIS § 3 SYN-17).

### 1.1 Shape 1 — the `{data, error}` envelope (all Display + Content Posting endpoints)

Every v2 data endpoint responds with:

```json
{
  "data": { /* endpoint-specific payload */ },
  "error": {
    "code": "ok",            // anything else means FAILURE, even on HTTP 200
    "message": "",
    "log_id": "20260721093747010204046050060A1B2C3"
  }
}
```

**Rule for the client layer:** a response is successful only when
`error.code === "ok"`. HTTP status alone is not sufficient. `log_id` must be
preserved in error objects — TikTok support asks for it (its absence is
tolerated: CC-B9).

**Display API error codes** (documented set):

| `error.code` | HTTP | Client action |
|---|---|---|
| `ok` | 200 | Success |
| `invalid_params` (**plural**) | 400 | Non-retryable validation error; prevented by client-side validation |
| `access_token_invalid` | 401 | One token refresh + one replay; still failing → terminal auth error, re-login |
| `scope_not_authorized` | 401 | Non-retryable; user did not grant the scope → re-consent flow |
| `scope_permission_missed` | 400 | Non-retryable; scope missing on the request → re-consent flow |
| `invalid_file_upload` | 400 | Non-retryable; report the file problem |
| `rate_limit_exceeded` | 429 | Retryable with backoff (reads only — § 5) |
| `internal_error` | 500 | Retryable with exponential backoff + jitter, bounded attempts |

**Content Posting API error codes** (same envelope, different codes):

| `error.code` | HTTP | Endpoint(s) | Client action |
|---|---|---|---|
| `invalid_param` (**singular**) | 400 | all CPA | Non-retryable validation error ("Check error message for details.") |
| `app_version_check_failed` | 400 | photo init | Non-retryable; the user's TikTok mobile app must be ≥ 31.8 for MEDIA_UPLOAD — tell the user to update the app |
| `spam_risk_too_many_posts` | 403 | init | Non-retryable today: daily post cap reached (~15/day per creator — § 5); suggest retry tomorrow; never auto-retry |
| `spam_risk_user_banned_from_posting` | 403 | init | Non-retryable, terminal for this account |
| `spam_risk_too_many_pending_share` | 403 | photo/inbox init | Non-retryable now: max 5 pending shares per 24 h — advise completing pending drafts in-app |
| `reached_active_user_cap` | 403 | init | Non-retryable now: unaudited 5-users/24 h app cap (§ 7), not a user error |
| `unaudited_client_can_only_post_to_private_accounts` | 403 | init | Non-retryable: account must be private while the client is unaudited (§ 7) |
| `url_ownership_unverified` | 403 | PULL_FROM_URL init | Non-retryable: domain/prefix not verified → § 4.9 workflow |
| `privacy_level_option_mismatch` | 403 | init | Non-retryable: chosen `privacy_level` not in this creator's `privacy_level_options` → re-query creator_info |
| `invalid_publish_id` | 400 | status/fetch | Non-retryable; if the journal knows the ID → "status no longer available — see journal" (§ 4.5) |
| `token_not_authorized_for_specified_publish_id` | 400 | status/fetch | Non-retryable: publish_id belongs to a different user token — check journal/account mapping |
| `access_token_invalid` | 401 | all | One refresh + one replay of the *request* — never assume side effects on inits (whether a 401 init can leave a created task behind is **probe P-5**) |
| `scope_not_authorized` | 401 | all | Re-consent with `video.publish` / `video.upload` as needed |
| `rate_limit_exceeded` | 429 | all | Reads: backoff + retry. **Publish inits: terminal** (§ 5) |
| `internal_error` | 5xx | all | Retryable with backoff — reads only; inits are never retried (§ 4.8) |

**Spelling rule (binding):** `invalid_params` (Display) and `invalid_param`
(Content Posting) both exist, on different API surfaces. The error mapper must
recognize **both** spellings and normalize them to the same internal
validation-error class; never switch on exact string equality against only one
variant.

### 1.2 Shape 2 — OAuth endpoints: flat object, NOT the envelope

`/v2/oauth/token/` and `/v2/oauth/revoke/` return flat OAuth-style JSON
(CC-A12):

```json
{ "error": "invalid_request", "error_description": "...", "log_id": "..." }
```

| `error` value | Meaning | Client action |
|---|---|---|
| `invalid_request` | Malformed params, bad/expired/reused `code`, `redirect_uri` mismatch, wrong PKCE | Non-retryable auth error; during login, restart authorization |
| `invalid_grant` / `invalid_client` / `unauthorized_client` / `invalid_scope` | Standard OAuth2 semantics (not individually documented by TikTok) | Same class; parse defensively — treat any non-empty `error` as failure |

The envelope decoder must never be applied to these endpoints; they get a
dedicated decoder.

### 1.3 Shape 3 — upload PUT responses: raw HTTP, no JSON envelope

Chunk PUTs to the `upload_url` answer with bare HTTP status codes
(206/201/400/403/404/416/5xx) and no `{data, error}` body. The full response
table and retry semantics are in § 4.8. Raw response fixtures are recorded by
**probe P-11**.

## 2. OAuth 2.0 (Login Kit)

- **Authorize URL**: `https://www.tiktok.com/v2/auth/authorize/` with
  `client_key`, `response_type=code`, `scope` (comma-separated), `redirect_uri`,
  `state`, and PKCE `code_challenge` + `code_challenge_method=S256` (PKCE is
  required for desktop/native apps, which is what this server is).
- **PKCE deviation (binding):** TikTok's `code_challenge` is the
  **lowercase-hex** SHA-256 of the verifier — *not* RFC 7636 base64url. A
  standard PKCE library silently produces base64url and every exchange fails.
  The verifier itself stays RFC-conformant (unreserved chars, 43–128 length).
  The pinned test vector and flow details live in AUTH.md (CC-A13).
- **Loopback redirect**: registered as the wildcard-port form
  `http://127.0.0.1:*/callback/` — trailing slash mandatory, the `redirect_uri`
  sent must be byte-identical in the authorize request and the token exchange,
  the returned `code` must be URL-decoded before exchange, prefer `127.0.0.1`
  (never `::1`). Normative flow spec: AUTH.md.
- **Token exchange**: `POST https://open.tiktokapis.com/v2/oauth/token/` with
  `client_key`, `client_secret`, `code`, `grant_type=authorization_code`,
  `redirect_uri`, `code_verifier`.
- **Refresh**: same endpoint, `grant_type=refresh_token`. The response may
  contain a **new refresh token** (rotation) — always persist the returned one
  before first use (CC-A1). The rotation **grace window is unknown upstream**
  (whether the old refresh token survives briefly after rotation) — **probe
  P-3**. Until P-3 proves a generous grace, two concurrent refreshes with the
  same refresh token are assumed to brick one of them, which is why refresh
  runs under the cross-process env-file lock (AUTH.md; rationale:
  SYNTHESIS § 2.2).
- **Revoke**: `POST https://open.tiktokapis.com/v2/oauth/revoke/` with
  `client_key`, `client_secret`, `token` (the access token); empty body on
  success.
- **Token lifetimes**: access token **86 400 s (24 h)**; refresh token
  **31 536 000 s (365 days)** (`expires_in` / `refresh_expires_in` in the
  response). Recommended practice: refresh proactively 10–30 minutes before
  expiry.
- **Client access token** (`grant_type=client_credentials`) exists but is only
  useful for the Research/Commercial Content APIs — out of scope for v1.
- Token responses also carry `open_id` (stable per user × app) and the granted
  `scope` (comma-separated) — persist both.
- Error shape: **flat OAuth object (§ 1.2), not the envelope.**

### Scopes used by this server

| Scope | Grants | Needed by |
|---|---|---|
| `user.info.basic` | open_id, union_id, avatar, display name | `tiktok_get_user_info` |
| `user.info.profile` | bio, profile deep link, verification status | `tiktok_get_user_info` (extended fields) |
| `user.info.stats` | follower/following/likes/video counts | `tiktok_get_user_info` (stats fields) |
| `video.list` | read the user's **public** videos | `tiktok_list_videos`, `tiktok_query_videos` |
| `video.publish` | direct-post content on the user's behalf | `tiktok_post_video`, `tiktok_post_photos` (both DIRECT_POST); `tiktok_get_creator_info`; `tiktok_get_publish_status` (either publish scope suffices) |
| `video.upload` | send content to the user's inbox as a draft | `tiktok_upload_video_draft`, `tiktok_upload_photos_draft` (both MEDIA_UPLOAD); `tiktok_get_publish_status` (either publish scope suffices) |

Scopes must be enabled for the app in the developer portal *and* granted by the
user at consent time. A granted-scope mismatch surfaces as
`scope_not_authorized`.

## 3. Display API (read side)

### 3.1 `GET /v2/user/info/?fields=…` — user profile

- `fields` is a **required query parameter** (comma-separated allowlist), e.g.
  `open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,
  is_verified,follower_count,following_count,likes_count,video_count`.
- Field availability maps to the three `user.info.*` scopes above.
  **Working assumption (safe design):** requesting a field whose scope wasn't
  granted is a hard 400 (`scope_permission_missed` strongly suggests error, not
  silent omission — upstream does not document it). The tool layer therefore
  filters requested fields by the token's granted scopes so the error path is
  never exercised in normal operation. Actual upstream behavior (hard error vs
  silent omit) is **probe P-4**.

### 3.2 `POST /v2/video/list/?fields=…` — recent videos

- `fields` in the **query string**; JSON body `{ "cursor": <int64 ms>, "max_count": 1–20 }`.
- Returns `videos[]`, `cursor` (for the next page), `has_more`. Sorted by
  `create_time` descending. Only **public** videos of the authorized user.
- Video fields, and the exact vocabulary this server accepts (`VIDEO_FIELDS` in
  `src/api/video.ts`): `id`, `create_time`, `title`, `video_description`,
  `duration`, `height`, `width`, `cover_image_url`, `share_url`, `embed_html`,
  `embed_link`, `like_count`, `comment_count`, `share_count`, `view_count`.
  A name outside this list is rejected locally, before the round trip.
- `cover_image_url` and similar CDN URLs are **short-lived (~6 h)** — results
  must be treated as ephemeral, not stored long-term. `share_url` is the one
  durable link and is therefore in the default set (TOOLS.md § 3.3), while the
  three long, expiring fields are not.

### 3.3 `POST /v2/video/query/?fields=…` — videos by id

- Body `{ "filters": { "video_ids": ["…", …] } }`, max **20** ids per call.
- Same field set and scope (`video.list`) as `/v2/video/list/`.

## 4. Content Posting API (write side)

### 4.1 Pre-flight: `POST /v2/post/publish/creator_info/query/`

Returns the creator's current posting capabilities. **Binding call policy:**

- **Mandatory before every direct post** (video and photo DIRECT_POST) —
  TikTok's integration guidelines require rendering the posting page from "the
  latest creator information returned", and the audit checks this.
- **Skipped for inbox/draft tools** (no `post_info` is sent, and a
  `video.upload`-only token may lack the scope for this endpoint; rationale:
  SYNTHESIS § 2.9).
- The result may be cached for at most a few minutes for validation reuse, but
  **must be re-queried when rendering a posting plan/preview**.
  `creator_avatar_url` has a documented TTL of 2 h. How volatile
  `privacy_level_options` are across hours/days — and whether the 600 s plan
  TTL sits comfortably inside that volatility — is **probe P-16**.

Fields:

- `privacy_level_options` — e.g. `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`,
  `FOLLOWER_OF_CREATOR`, `SELF_ONLY`. **The privacy level sent in a post must
  be one of these.** For unaudited clients only `SELF_ONLY` is returned (§ 7).
  Private accounts get `FOLLOWER_OF_CREATOR` instead of `PUBLIC_TO_EVERYONE`.
- `comment_disabled`, `duet_disabled`, `stitch_disabled` — creator-level
  switches (`duet`/`stitch` are `true` for private accounts).
- `max_video_post_duration_sec` — per-creator upload duration cap.
- `creator_username`, `creator_nickname`, `creator_avatar_url`.

The server never hardcodes privacy options — it always offers exactly what the
fresh creator_info returned (this also handles minor/restricted accounts with
no age logic on our side).

### 4.2 Direct post video: `POST /v2/post/publish/video/init/`

Body has two objects:

- `post_info`: `title` (max 2 200 UTF-16 code units; `#hashtag` and `@mention`
  are parsed), `privacy_level` (required, from creator_info),
  `disable_comment`, `disable_duet`, `disable_stitch`,
  `video_cover_timestamp_ms`, `brand_content_toggle`, `brand_organic_toggle`
  (commercial-content disclosure), `is_aigc` (AI-generated-content label —
  this server exposes it and defaults it to a configurable value, since
  MCP-driven posts are often AI-assisted).
- `source_info`:
  - `source: "PULL_FROM_URL"` + `video_url` — TikTok downloads the video
    itself. The URL's domain/prefix must be **verified in the developer
    portal** (§ 4.9); https only, redirects are not followed, the URL must stay
    reachable for the 1-hour download window.
  - `source: "FILE_UPLOAD"` + `video_size`, `chunk_size`, `total_chunk_count`
    per the **normative chunk algorithm in § 4.6** — the response returns an
    `upload_url` (valid **1 hour**) to which the client PUTs the bytes (§ 4.7,
    § 4.8).

Response: `{ "publish_id": "v_pub_file~v2.…", "upload_url": "…" }`.

**Branded content × private visibility (binding, client-side rule):**
`brand_content_toggle: true` with `privacy_level: SELF_ONLY` is rejected at
validation time with TikTok's own tooltip wording — "Branded content
visibility cannot be set to private." This is a mandatory UX rule from the
content-sharing guidelines (an audit checklist item); **no API error code for
the combination is documented** — actual API-level behavior is **probe P-6**.

**Retry discipline:** publish inits are **never retried** and upstream 429 on
an init is **terminal** (§ 4.8, § 5). Whether two byte-identical inits are
deduplicated upstream is **probe P-12** — until answered, assume they create
two posts.

### 4.3 Upload draft to inbox: `POST /v2/post/publish/inbox/video/init/`

Same `source_info` shapes, **no** `post_info` — the user finishes editing and
publishing inside the TikTok app (an inbox notification). Scope `video.upload`.
The status tool reports `SEND_TO_USER_INBOX` as this flow's terminal success
state.

- **Draft TTL is undocumented upstream** — **probe P-7** measures it. Until
  answered, the draft tool's output tells the user to open TikTok and complete
  the draft promptly, and the journal records the share as complete at
  `SEND_TO_USER_INBOX` without claiming anything about draft longevity.
- At most **5 pending shares per 24 h** per creator
  (`spam_risk_too_many_pending_share`) — "pending" means shared to the inbox
  but not yet completed in-app. Heavy draft use hits this fast; the server
  counts inbox shares per account per rolling 24 h in the journal and warns
  at 4.
- Whether inbox drafts consume the unaudited 5-users/24 h app cap the same way
  direct posts do is **probe P-10**.

### 4.4 Photos: `POST /v2/post/publish/content/init/`

- `media_type: "PHOTO"`, `post_mode: "DIRECT_POST" | "MEDIA_UPLOAD"`.
- `source_info`: `source: "PULL_FROM_URL"`, `photo_images[]` (max **35** URLs,
  verified-domain rule § 4.9 applies), `photo_cover_index`.
- `post_info`: `title` (max **90** UTF-16 code units), `description` (max
  **4 000** UTF-16 code units), `privacy_level`, `auto_add_music`,
  `disable_comment`, `brand_content_toggle`, `brand_organic_toggle`.
- **Photos are PULL_FROM_URL only (binding, re-verified round 2)** — there is
  no FILE_UPLOAD path for photos, so local photo files are impossible in v1;
  the tool description says so and points at the § 4.9 hosting remediation.
- MEDIA_UPLOAD requires the user's TikTok mobile app ≥ 31.8
  (`app_version_check_failed`).
- Which `post_info` fields are actually honored per `post_mode` (e.g.
  `title`/`description` on MEDIA_UPLOAD, `auto_add_music` on DIRECT_POST) is
  **probe P-13** — the tool schemas freeze after it.

### 4.5 Status polling: `POST /v2/post/publish/status/fetch/`

Body `{ "publish_id": "…" }`. Returns:

- `status`: `PROCESSING_DOWNLOAD` / `PROCESSING_UPLOAD` / `SEND_TO_USER_INBOX`
  / `PUBLISH_COMPLETE` / `FAILED`.
- `fail_reason` on `FAILED` — see the recovery table below.
- `publicaly_available_post_id[]` (list of int64) — returned only if the post
  is published for public viewership. **Spelling warning (binding):** the
  field is spelled exactly `publicaly_available_post_id` — TikTok's own
  misspelling. Copy it exactly or the field reads as absent.
- `uploaded_bytes` (FILE_UPLOAD) and `downloaded_bytes` (PULL_FROM_URL)
  progress counters. `uploaded_bytes` is the out-of-band resync source for
  chunk-PUT 416 recovery (§ 4.8).

**Retention window (open upstream — probe P-1):** how long a `publish_id`
stays queryable after its terminal state is undocumented. Binding design
consequences until P-1 answers: never build a feature that depends on querying
a publish_id days later; the journal persists the terminal status (and
`publicaly_available_post_id` when present) immediately upon observation — the
journal, not TikTok, is the system of record for post history;
`invalid_publish_id` for an ID the journal knows maps to "status no longer
available — see journal", and the `publish_not_found` error text hedges
("retained only for a limited window").

**Polling schedule:** the endpoint's 30 req/min budget (§ 5) allows a 2 s
minimum interval; the normative schedule is 2 s → 5 s → 10 s with jitter, well
inside budget.

`fail_reason` → recovery mapping:

| `fail_reason` | Action |
|---|---|
| `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed` | Non-retryable media validation failure → report the specific constraint (§ 6) so the user can transcode |
| `internal` | **Officially retryable** ("This is a retryable error.") → the server may offer a re-publish (new init, new publish_id) |
| `video_pull_failed`, `photo_pull_failed` | Source URL unreachable/expired during the 1-hour pull window → check URL availability, re-init |
| `publish_cancelled` | User cancelled in-app → informational |
| `auth_removed` | User revoked app access mid-publish → terminal auth error, re-login required |
| `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk` | Non-retryable moderation outcomes; `spam_risk_text` → suggest editing the caption; never auto-retry |

### 4.6 FILE_UPLOAD chunk algorithm (normative)

Upstream rules (verbatim from the media transfer guide):

> "Each chunk must be at least 5 MB but no greater than 64 MB, except for the
> final chunk, which can be greater than chunk_size (up to 128 MB)."
> "Videos with a total size less than 5 MB must be uploaded as a whole, with
> chunk_size equal to the entire video's byte size."
> "Videos with a total size greater than 64 MB must be uploaded in multiple
> chunks."
> "There must be a minimum of 1 chunk and a maximum of 1000 chunks."
> "total_chunk_count should be equal to video_size divided by chunk_size,
> rounded down to the nearest integer."
> "File chunks must be uploaded sequentially."

PUT headers per chunk: `Content-Type: {MIME_TYPE}`,
`Content-Length: {BYTE_SIZE_OF_THIS_CHUNK}`,
`Content-Range: bytes {FIRST_BYTE}-{LAST_BYTE}/{TOTAL_BYTE_LENGTH}`.

**MB convention (binding):** TikTok's own worked example uses
`chunk_size: 10000000` for a `video_size: 50000123` file — **decimal**
megabytes, not MiB. To be safe under *either* reading (5 MB = 5,000,000 or
5,242,880; 64 MB = 64,000,000 or 67,108,864), the constants below use decimal
for the minimum bound check and decimal for the chosen chunk size, which
satisfies both interpretations of the maximum (64,000,000 < 67,108,864).

**Algorithm (normative — rationale: SYNTHESIS § 2.4):**

```
CHUNK_SIZE   = 64_000_000        // constant; safe under decimal and binary readings
MIN_WHOLE    = 5_000_000         // below this, whole-file upload is mandatory
MAX_FILE     = 4 * 1024**3       // 4 GiB = 4_294_967_296 bytes, hard cap (S4);
                                 // reject larger locally, before init

plan(video_size):
  if video_size > MAX_FILE: reject VALIDATION_ERROR
  if video_size < MIN_WHOLE:
      chunk_size = video_size            // whole-file rule
  else:
      chunk_size = min(video_size, CHUNK_SIZE)
  total_chunk_count = floor(video_size / chunk_size)   // floor-merge: remainder
                                                       // folds into the FINAL chunk
  // Emit chunks:
  for i in 0 .. total_chunk_count - 1:
      first = i * chunk_size
      last  = (i == total_chunk_count - 1)
                ? video_size - 1          // final chunk absorbs the remainder
                : first + chunk_size - 1
      PUT Content-Range: bytes {first}-{last}/{video_size}
      Content-Length: last - first + 1
  // Invariants (assert in code + tests):
  //   1 <= total_chunk_count <= 1000
  //   every non-final chunk length == chunk_size
  //   final chunk length in [chunk_size, min(chunk_size + chunk_size - 1, 128_000_000)]
  //   sum of chunk lengths == video_size
```

With `CHUNK_SIZE = 64,000,000` the final merged chunk is at most
`64,000,000 + 63,999,999 = 127,999,999 < 128 MB` under the decimal reading, so
the 128 MB final-chunk cap can never be violated. Max file 4 GiB
(4,294,967,296 bytes) / 64,000,000 → at most 67 chunks, far below the
1000-chunk cap. Expected responses: `206` per intermediate chunk, `201` after
the final chunk (full code table in § 4.8).

**Test vectors** (all byte values exact; `/TOTAL` denominator = video_size).
These eight vectors are the **shared property-test fixture** — the mandatory
table-driven unit test for `planChunks()` and the basis of the
bounds/contiguity/sum property tests (CC-D2, TESTING.md):

| # | video_size (bytes) | chunk_size | total_chunk_count | Content-Range sequence | Rule exercised |
|---|---|---|---|---|---|
| V1 | 3,145,728 | 3,145,728 | 1 | `bytes 0-3145727/3145728` | < 5 MB → whole-file mandatory |
| V2 | 5,000,000 | 5,000,000 | 1 | `bytes 0-4999999/5000000` | exactly 5 MB, single chunk |
| V3 (official worked example) | 50,000,123 | 10,000,000 | 5 | `bytes 0-9999999/50000123` · `10000000-19999999` · `20000000-29999999` · `30000000-39999999` · `40000000-50000122` | floor(50,000,123/10⁷)=5; final chunk 10,000,123 bytes (merged remainder) — matches TikTok's own example |
| V4 | 64,000,000 | 64,000,000 | 1 | `bytes 0-63999999/64000000` | exactly 64 MB, single chunk |
| V5 | 64,000,001 | 64,000,000 | 1 | `bytes 0-64000000/64000001` | floor = 1 → ONE chunk whose actual length (64,000,001) **exceeds declared chunk_size** — the key floor-merge subtlety |
| V6 | 150,000,000 | 64,000,000 | 2 | `bytes 0-63999999/150000000` · `bytes 64000000-149999999/150000000` | final chunk 86,000,000 ≤ 128 MB |
| V7 | 256,000,000 | 64,000,000 | 4 | `0-63999999` · `64000000-127999999` · `128000000-191999999` · `192000000-255999999` (all `/256000000`) | exact multiple — final chunk exactly chunk_size |
| V8 | 4,294,967,296 (4 GiB) | 64,000,000 | 67 | chunks 1–66: 64,000,000 bytes each (chunk 66 ends at 4,223,999,999); final: `bytes 4224000000-4294967295/4294967296` (70,967,296 bytes) | max file size; 67 ≤ 1000 chunks; final merge ≤ 128 MB |

### 4.7 `upload_url` and the egress allowlist (normative)

Observed `upload_url` anatomy (both from TikTok's own documentation examples):

```
https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123
https://upload.us.tiktokapis.com/video/?upload_id=67890&upload_token=chunkexample
```

The upload host is **not** a single fixed hostname — TikTok issues regional
variants. Binding rules (rationale: SYNTHESIS § 2.5):

1. **`upload_url` is opaque.** It is used verbatim as returned — never parsed
   and reconstructed, never persisted beyond the in-memory upload session.
   Parsing happens only to *validate* it, per rule 2.
2. **Host acceptance rule.** The URL is parsed with the WHATWG URL parser and
   its host is accepted **iff** it is exactly `open.tiktokapis.com`, exactly
   `open-upload.tiktokapis.com`, or matches
   `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$`. All matching is dot-anchored
   on the full hostname; **bare `endsWith` matching is banned** (mandatory
   negative tests include `eviltiktokapis.com` and
   `open.tiktokapis.com.attacker.tld`).
3. **Transport constraints**: `https:` only; no userinfo in the URL; port 443
   only (explicit `:443` or default); fetches run with `redirect: "error"`.
4. **Credential rule**: chunk PUTs carry **no** `Authorization` header — the
   `upload_token` query parameter inside the URL **is** the credential. It is
   a bearer-equivalent secret and a registered redaction sink: it must never
   appear in logs, error messages, journal records, or MCP tool outputs.
   (Consequence: a running upload survives access-token expiry — CC-A3.)
5. **Widening the list is a spec edit**, never a runtime relaxation and never
   a loosening to a blanket `*.tiktokapis.com` suffix. Observed upload hosts
   across runs (including EEA accounts) are recorded by **probe P-9**; the
   full `upload_url` anatomy — host, `upload_token` parameter shape, observed
   TTL — by **probe P-14**. New observed shapes widen the pattern here first.

The `upload_url` is valid for **1 hour** from init. Expiry surfaces as HTTP
403 on a PUT — see § 4.8 for the (non-)recovery rule.

### 4.8 Chunk-PUT responses and retry semantics (normative)

Raw HTTP responses on chunk PUTs (no JSON envelope — § 1.3):

| HTTP | Meaning (verbatim gist) | Action |
|---|---|---|
| 201 | "All parts are uploaded. TikTok will start the posting process." | Upload complete → begin status polling |
| 206 | "The current chunk has been successfully processed. There are additional chunks yet to be uploaded." | Continue with the next sequential chunk |
| 400 | "Malformated request headers, or BYTE_SIZE_OF_THIS_CHUNK does not reflect the true byte size" | Terminal → bug in the chunk planner; abort, report |
| 403 | "The upload_url has expired" | Terminal on this URL → **never auto-re-init** (CC-D5): a new init spends the 6/min budget and creates an orphaned pending publish. Surface the failure with the publish_id and the re-plan remediation |
| 404 | "TikTok cannot find a valid upload task" | Terminal on this URL → same rule as 403: recovery is a fresh plan + init, initiated by the user, never automatic |
| 416 | "Content-Range does not reflect the actual upload progress" | Resynchronize: consult the last successful response's `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}` header and/or status/fetch `uploaded_bytes`, then resume from the correct offset |
| 5xx | "Gateway connection error or TikTok Internal error. **You should retry submitting this chunk**" | **Officially retryable** → bounded same-chunk retries with backoff |

Binding retry rules (rationale: SYNTHESIS § 2.13):

- **Chunk PUTs are a retryable request class** — distinct from both idempotent
  reads and publish inits (CC-B7). A 5xx on a chunk PUT is retried in-call
  with an **identical `Content-Range`**, bounded by `TT_CHUNK_RETRIES`
  (default **3**) with backoff; the byte range is what makes the re-PUT safe.
- **4xx is terminal** for the in-flight upload. 403 means the upload URL
  expired — never auto-re-init. 416 means the server is ahead — resync from
  `uploaded_bytes` and advance (CC-D6).
- Chunks are uploaded **sequentially** — no parallel PUTs.
- **Resume algorithm after an ambiguous outcome** (timeout / connection reset
  mid-PUT):
  1. Query status/fetch → read `uploaded_bytes`.
  2. If `uploaded_bytes` covers the chunk just sent → it was accepted;
     continue with the next chunk.
  3. If not → re-PUT the same chunk (officially sanctioned for 5xx-class
     failures).
  4. If the re-PUT returns 416 → the range was already recorded; re-read
     progress and advance.
- What a re-PUT of a *fully accepted* range returns (416 vs idempotent 206 vs
  other) is **probe P-2** — it must run before the Phase-2 retry-matrix
  freeze; **probe P-11** records the raw response fixtures (206/201 bodies,
  416 body + headers, 5xx shape) in the same session.
- **Publish inits are NEVER retried** — not on 5xx, not on timeout, not on
  connection reset. A transport failure after the request may have been sent
  is a terminal ambiguous outcome (journal + status/fetch are the recovery
  path, CC-B4/B5). **Upstream 429 on an init is terminal** (§ 5). Upstream
  init idempotency is unverified (**probe P-12**); whether a 401 init can
  leave a created task behind is **probe P-5**.

### 4.9 PULL_FROM_URL domain verification (workflow)

Every URL given to `PULL_FROM_URL` (video or photo) must be under a domain or
URL prefix verified for the app:

1. Developer portal → app page → **"URL properties"**.
2. Switch to **Production mode** first — properties verified in sandbox do not
   carry over.
3. Property types:
   - **Domain** (recommended, covers all URLs on the domain/subdomain): add
     the signature string as a DNS TXT record, then Verify. Subject to DNS
     propagation delay (minutes to 48 h; no SLA documented).
   - **URL prefix**: must be `https://` + host + path + trailing `/`. Download
     the signature file, serve it under that prefix, then Verify.
4. Prefix matching is path-segment-exact: verified
   `https://example.com/videos/user/` covers
   `https://example.com/videos/user/123/example.mp4` but **not**
   `https://example.com/videos/2023/user/123/example.mp4`. Query strings do
   not affect prefix matching, so signed query params are fine on a verified
   host.
5. The requirement applies to **all** apps using Content Posting upload URLs,
   regardless of app age.
6. Runtime constraints on the pulled URL: HTTPS only; **redirects are not
   followed**; the URL must remain accessible for the entire download window,
   which times out **1 hour** after the download task is initiated.
7. Unverified sources fail with `url_ownership_unverified` (403). Practical
   consequences: arbitrary third-party URLs can never work (you cannot verify
   a domain you don't control); shared cloud hostnames (e.g.
   `bucket.s3.amazonaws.com`) normally cannot be verified — use a CNAME'd
   custom domain; CDN URLs that 30x-redirect to origin fail (redirects not
   followed). For photos this means operator-owned, verified hosting is the
   only path (§ 4.4).

## 5. Rate limits & business caps

Endpoint rate limits (upstream-documented):

| Endpoint | Limit | Dimension |
|---|---|---|
| `POST /v2/post/publish/video/init/` (direct post) | 6 req/min | per user access token |
| `POST /v2/post/publish/inbox/video/init/` | 6 req/min | per user access token |
| `POST /v2/post/publish/content/init/` (photo) | 6 req/min | per user access token |
| `POST /v2/post/publish/creator_info/query/` | 20 req/min | per user access token |
| `POST /v2/post/publish/status/fetch/` | 30 req/min | per user access token |
| `GET /v2/user/info/` | 600 req/min | sliding 1-min window; dimension not stated — assumed per app until **probe P-8** answers |
| `POST /v2/video/list/` | 600 req/min | same |
| `POST /v2/video/query/` | 600 req/min | same |
| Chunk PUT to `upload_url` | no documented limit | — |

Request-rate calculation is a one-minute sliding window; exceeding it returns
HTTP 429 + `rate_limit_exceeded`; higher limits are by request via the support
page.

Business-level caps that behave like rate limits but surface as 403 error
codes, not 429s:

| Cap | Value | Dimension |
|---|---|---|
| Active publishing users (`reached_active_user_cap`) | 5 users / 24 h (unaudited — § 7) | per API client (app) |
| Daily posts per creator (`spam_risk_too_many_posts`) | typically ~15 posts/day, shared across ALL API clients posting for that creator | per creator account |
| Pending inbox shares (`spam_risk_too_many_pending_share`) | max 5 pending within any 24-hour period | per creator account |

**Client-side policy (binding — rationale: SYNTHESIS § 2.12):**

- Publish inits: a local token bucket of 6/min per profile with continuous
  refill (1 token / 10 s). An empty bucket rejects locally with
  `local_rate_limited` + `retry_after_s` + an absolute `retry_at` — zero
  network, never a sleep. The *preview* still succeeds and shows bucket
  occupancy.
- **The local bucket is a courtesy, not the enforcement point** (CC-B8): the
  6/min budget is per user token and another process can consume it. Upstream
  is authoritative — **an upstream 429 on an init is terminal** (surfaced
  non-retryable with a wait hint), because an init must never be auto-retried
  (§ 4.8).
- Reads: short bounded delay instead of rejection; 429 on reads maps to
  backoff + retry. Status polls stay inside the poll budget (§ 4.5).
- Transport-level policy (per-host concurrency semaphore, `Retry-After`
  honored and capped, exponential backoff with jitter): ARCHITECTURE.md
  § retry.

## 6. Media constraints (enforced client-side before upload)

- **Video**: MP4 (recommended) / WebM / MOV; codecs H.264 (recommended) /
  H.265 / VP8 / VP9; 23–60 FPS; 360–4096 px on both dimensions; duration up to
  `max_video_post_duration_sec` from creator_info (platform max 10 minutes);
  size cap **4 GiB** (4,294,967,296 bytes — enforced by the § 4.6 planner
  before init; V8 is the boundary vector).
- **Photos**: WebP / JPEG; max resolution 1080p; per-image size cap **20 MB**;
  ≤ **35** images per post; PULL_FROM_URL only (§ 4.4).
- **Captions, in UTF-16 code units** (JavaScript `String.prototype.length` —
  exactly TikTok's unit, so plain `.length` checks are correct; do not count
  code points): video `title` ≤ 2 200; photo `title` ≤ 90; photo `description`
  ≤ 4 000.
- The server does not probe media content (CC-D9): container/codec/FPS/
  resolution problems surface asynchronously as `FAILED` + `fail_reason`
  (§ 4.5); tool descriptions state the accepted formats so the model can
  pre-check by extension.

## 7. Unaudited-client restrictions (the audit gate)

Until the TikTok app passes TikTok's content-sharing audit:

1. `creator_info.privacy_level_options` returns **only `SELF_ONLY`** — every
   post is visible to the author alone — and the posting account **must itself
   be private**: posting to a public account fails with
   `unaudited_client_can_only_post_to_private_accounts` (403).
2. At most **5 distinct users** may post through the app per 24-hour window
   (`reached_active_user_cap`, 403 — an app-level cap, not a user error).
   Whether inbox drafts count against it is **probe P-10**.
3. **Sandbox never posts publicly**: sandbox mode does not offer Content
   Posting for public videos, so all sandbox probes run with `SELF_ONLY`
   against sandbox target-user accounts; the audit demo is shot on unaudited
   **production** with a private account.
4. After a successful audit these restrictions lift; already-posted
   `SELF_ONLY` content stays private until the user changes it manually in the
   app.

**Design consequence**: the server never hard-codes privacy levels; it always
offers exactly what creator_info returned, and its documentation/tool
descriptions explain the audit gate so the model can explain it to the user
instead of retrying a doomed `PUBLIC_TO_EVERYONE` post.

## 8. UX/integration guidelines that are audit-relevant

TikTok's audit checks integration behavior, not just code. The MCP tool
contracts are designed so a compliant UX is the natural path:

- Show the creator's nickname/avatar (from creator_info) before posting; the
  publish preview (plan mode) includes them.
- Ask for explicit consent before sending content — plan-and-apply provides
  this.
- Privacy level is **manually chosen from the returned options with no default
  value**; interaction toggles (comment/duet/stitch) and the
  commercial-content toggle default to **off**.
- Surface commercial-content disclosure (`brand_content_toggle`,
  `brand_organic_toggle`) and music-usage confirmation for photo posts
  (`auto_add_music`) as first-class tool inputs, not hidden defaults; the
  branded-content-cannot-be-private rule is enforced with TikTok's tooltip
  wording (§ 4.2).
- Do not cache/store TikTok CDN URLs beyond their TTL.

## 9. Adjacent APIs — deliberately out of v1 scope

- **Research API** (`/v2/research/…`, client-credentials auth): US/EU academic
  access only, separate application process. Planned as an optional package —
  see ROADMAP Phase 3. Not scaffolded in v1 (no dark code).
- **Commercial Content API**, **Business/Marketing API** (ads), **Webhooks**
  (`portability.*` events), **Comments** (no public comment-management API for
  normal apps): out of scope; revisit on demand.

## Appendix A — sandbox probe index

Every empirical unknown referenced above resolves to one of these probes.
Probes run in sandbox with `SELF_ONLY` against target-user accounts (§ 7);
results are recorded in `docs/probes/PROBE-LOG.md` when executed (Wave D) and
fold back into this doc by spec edit. Definitions and freeze-point mapping:
SYNTHESIS § 6.

| # | Question it answers | Referenced in |
|---|---|---|
| P-1 | status/fetch retention window for a publish_id | § 4.5 |
| P-2 | Re-PUT tolerance of an already-accepted chunk range | § 4.8 |
| P-3 | Refresh-token rotation grace window | § 2 |
| P-4 | Out-of-scope read field: hard error vs silent omission | § 3.1 |
| P-5 | Can a 401 init leave a created task behind (side effect before auth failure) | § 1.1, § 4.8 |
| P-6 | API-level behavior of `brand_content_toggle` + `SELF_ONLY` | § 4.2 |
| P-7 | Inbox draft TTL | § 4.3 |
| P-8 | Dimension of the 600/min Display quota (per app vs per token) | § 5 |
| P-9 | Regional upload hosts actually issued (incl. EEA) | § 4.7 |
| P-10 | Do inbox drafts consume the unaudited 5-users/24 h cap | § 4.3, § 7 |
| P-11 | Raw chunk-PUT response fixtures (206/201, 416 body, 5xx shape) | § 1.3, § 4.8 |
| P-12 | Upstream dedup of two byte-identical inits | § 4.2, § 4.8 |
| P-13 | Photo `post_info` field reality per post_mode | § 4.4 |
| P-14 | `upload_url` anatomy: host, `upload_token` shape, observed TTL | § 4.7 |
| P-15 | *(engineering spike, not sandbox)* DNS resolve-and-pin feasibility for v1.x | SECURITY.md |
| P-16 | creator_info volatility vs the 600 s plan TTL | § 4.1 |

## Sources

- [Content Posting API — Direct Post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [Content Posting API — Get started](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [Content Posting API — Media transfer guide (chunk rules, upload hosts)](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide)
- [Content Posting API — Upload (inbox) content](https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content/)
- [Content Posting API — Photo post reference](https://developers.tiktok.com/doc/content-posting-api-reference-photo-post)
- [Content Posting API — Get post status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status)
- [Content Posting API — Query creator info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info)
- [Content sharing guidelines (audit, SELF_ONLY, caps, UX rules)](https://developers.tiktok.com/doc/content-sharing-guidelines)
- [Display API overview](https://developers.tiktok.com/doc/display-api-overview)
- [Display API v2 — Error handling](https://developers.tiktok.com/doc/tiktok-api-v2-error-handling)
- [Display API v2 — Rate limits](https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit)
- [Video List / Video Query / User Info API references](https://developers.tiktok.com/doc/tiktok-api-v2-video-list)
- [Scopes overview](https://developers.tiktok.com/doc/scopes-overview)
- [Login Kit for Desktop (loopback redirect, hex PKCE)](https://developers.tiktok.com/doc/login-kit-desktop)
- [OAuth user access token management](https://developers.tiktok.com/doc/oauth-user-access-token-management)
- [Manage user access tokens (Login Kit)](https://developers.tiktok.com/doc/login-kit-manage-user-access-tokens/)
- [Add a sandbox](https://developers.tiktok.com/doc/add-a-sandbox/)
- [App review guidelines](https://developers.tiktok.com/doc/app-review-guidelines)
