# Design Review — Senior TikTok Platform Integration Engineer

## 1. Reviewer & scope

- **Role**: Senior integration engineer, TikTok for Developers platform (Login Kit,
  Display API, Content Posting API). Focus of this review: **factual platform
  correctness** of the design's claims about TikTok's API — not architecture style,
  not code quality.
- **Date**: 2026-07-21.
- **Docs reviewed**: `README.md`, `docs/TIKTOK-API.md`, `docs/TOOLS.md`,
  `docs/AUTH.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`,
  `docs/SECURITY.md`, `docs/TESTING.md`, `docs/ROADMAP.md`.
- **Sources consulted** (fetched 2026-07-21):
  - https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
  - https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
  - https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
  - https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
  - https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
  - https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
  - https://developers.tiktok.com/doc/content-posting-api-get-started
  - https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content
  - https://developers.tiktok.com/doc/content-sharing-guidelines
  - https://developers.tiktok.com/doc/oauth-user-access-token-management
  - https://developers.tiktok.com/doc/login-kit-desktop
  - https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
  - https://developers.tiktok.com/doc/tiktok-api-v2-video-list
  - https://developers.tiktok.com/doc/tiktok-api-v2-video-query
  - https://developers.tiktok.com/doc/tiktok-api-v2-video-object
  - https://developers.tiktok.com/doc/tiktok-api-scopes
  - https://developers.tiktok.com/doc/display-api-overview
  - Secondary/corroborating (integration guides, treated as non-authoritative):
    https://postproxy.dev/blog/how-to-post-to-tiktok-via-api/,
    https://www.postpeer.dev/blog/tiktok-direct-posting-api-tutorial,
    https://docs.upload-post.com/guides/reached-active-user-cap-error/,
    https://www.ayrshare.com/blog/tiktok-api-how-to-post-and-get-analytics/

## 2. Executive summary

The platform picture painted by `TIKTOK-API.md` is **substantially accurate**. Of
~45 material platform claims, I could confirm the large majority verbatim against
developers.tiktok.com, including several the design had prudently hedged with
*(verify at implementation time)*: the loopback HTTP redirect is officially
supported for desktop apps, the FILE_UPLOAD chunk envelope (5–64 MB, final chunk
up to 128 MB, `total_chunk_count = floor(video_size / chunk_size)`), the 1-hour
`upload_url` TTL, the 4 GB video cap, the 20 MB per-photo cap, the 4 000-char
photo description, the 6-hour CDN URL TTL, the `publicaly_available_post_id`
(sic) spelling, the 6/min init rate limit, and the unaudited SELF_ONLY + 5-user
cap.

Three gaps matter and would each cause runtime failures if implemented from the
spec as written:

1. **TikTok's PKCE `code_challenge` is the hex encoding of SHA-256, not RFC 7636
   base64url.** The design mandates PKCE but never states the encoding; a
   standard-library PKCE implementation will produce a challenge TikTok rejects.
2. **Photo post titles are capped at 90 UTF-16 runes** (descriptions at 4 000).
   The design's blanket "title ≤ 2 200" applies only to video posts.
3. **Branded content (`brand_content_toggle: true`) cannot be `SELF_ONLY`** —
   which also means an unaudited app (SELF_ONLY-only) cannot post branded
   content at all. The design has no validation or messaging for this.

Additionally, the egress allowlist as stated in `README.md` omits the actual
upload host (`open-upload.tiktokapis.com`), and the `upload_url` carries an
`upload_token` credential in its query string that the redaction layer must
cover. None of these require architectural rework; all are spec-level fixes.

### Verdict: **Approve with changes**

The design may proceed to implementation once the findings in § 4 (severity High
and Medium) are folded back into `TIKTOK-API.md`, `TOOLS.md`, and `AUTH.md`.

## 3. Claim-by-claim verification table

Status legend: **CONFIRMED** (matches official docs), **INCORRECT** (with the
correct fact), **UNVERIFIED** (not found in official docs; what to check).

### 3.1 Hosts, envelope, error codes (`TIKTOK-API.md` intro, § 1)

| # | Claim | Status | Notes / correction |
|---|---|---|---|
| 1 | Authorize page at `https://www.tiktok.com/v2/auth/authorize/` | **CONFIRMED** | login-kit-desktop reference. |
| 2 | "Everything else" on `https://open.tiktokapis.com` | **INCORRECT (incomplete)** | FILE_UPLOAD PUTs go to a third host, `open-upload.tiktokapis.com` (shown in TikTok's own get-started examples: `https://open-upload.tiktokapis.com/video/?upload_id=…&upload_token=…`). `README.md`'s egress claim "nothing else" is wrong as written; ARCHITECTURE § 6's `*.tiktokapis.com` suffix guard is the correct posture. |
| 3 | OAuth endpoints form-encoded; data endpoints `application/json; charset=UTF-8` | **CONFIRMED** | oauth-user-access-token-management; all Content Posting references. |
| 4 | Success iff `error.code === "ok"`, even on HTTP 200 | **CONFIRMED** | Uniform across all v2 references; creator_info documents `spam_risk_*` codes on HTTP 200. |
| 5 | `log_id` present in error object, needed for support | **CONFIRMED** | Shown in every v2 response example. |
| 6 | Error codes `access_token_invalid`, `scope_not_authorized`, `rate_limit_exceeded`, `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap` | **CONFIRMED** | All six appear on creator_info / direct-post references. `reached_active_user_cap`: "The daily quota for active publishing users from your client is reached." |
| 7 | Error code `invalid_params` | **UNVERIFIED** | Not seen on the pages fetched; likely exists on Display API references. Check each endpoint's error table at implementation time. |
| 8 | (implicit) error-code list completeness | **INCORRECT (incomplete)** | Also documented: `url_ownership_unverified`, `privacy_level_option_mismatch`, `unaudited_client_can_only_post_to_private_accounts` (direct post), `spam_risk_too_many_pending_share` (inbox/photo: max 5 pending shares per 24 h). See Finding 8. |

### 3.2 OAuth / Login Kit (`TIKTOK-API.md` § 2, `AUTH.md`)

| # | Claim | Status | Notes / correction |
|---|---|---|---|
| 9 | Authorize params: `client_key`, `response_type=code`, comma-separated `scope`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256` | **CONFIRMED** | login-kit-desktop. Scope separator is a comma, confirmed in both authorize and token-response docs. |
| 10 | PKCE required for desktop/native apps | **CONFIRMED** | Token doc: `code_verifier` "Required for mobile and desktop app only". **But see Finding 1**: `code_challenge` is the **hex** encoding of SHA-256(code_verifier), per TikTok's own desktop doc — not RFC 7636 base64url. Verifier charset `[A-Za-z0-9-._~]`, length 43–128. |
| 11 | Loopback HTTP redirect acceptance for desktop apps (flagged *verify*) | **CONFIRMED** — resolved in the design's favor | Desktop redirect URIs: "must be absolute and begin with `https` or `http`"; "Only `localhost` or loopback IP `127.0.0.1` are allowed host names"; "URIs must have a port number, and wildcard port number (`*`) is supported"; must be static (no params/fragment), pre-registered, ≤ 10 URIs per app, ≤ 512 chars each. Valid example: `http://127.0.0.1:*/callback/`. The manual copy-paste fallback in AUTH.md § 1 is no longer needed as a contingency (keep it as convenience if desired). Fixed port `43110` works but is unnecessary — a wildcard-port registration restores the random-port pattern. Mind exact-match semantics incl. trailing slash. |
| 12 | Token exchange `POST /v2/oauth/token/` with `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier` | **CONFIRMED** | oauth-user-access-token-management. |
| 13 | Refresh via same endpoint, `grant_type=refresh_token`; rotation possible | **CONFIRMED** | "The returned `refresh_token` may be different than the one passed in the payload. You must use the newly-returned token if the value is different." |
| 14 | Revoke `POST /v2/oauth/revoke/` | **CONFIRMED** | Params: `client_key`, `client_secret`, `token` (the access token). AUTH.md § 2 should name the params. |
| 15 | Access token 86 400 s; refresh token 31 536 000 s | **CONFIRMED** | `expires_in: 86400`, `refresh_expires_in: 31536000` verbatim. |
| 16 | Token response carries `open_id` and granted `scope` | **CONFIRMED** | `scope`: "A comma-separated list of the scopes the user has agreed to authorize" — which also confirms AUTH.md's partial-grant expectation. |
| 17 | Client access token (`client_credentials`) only useful for Research/Commercial APIs | **CONFIRMED** | Research scopes require vetted access (scopes reference); client token has no user-data reach in v1's scope set. |
| 18 | Scope names & grants: `user.info.basic` / `user.info.profile` / `user.info.stats` / `video.list` / `video.publish` / `video.upload` | **CONFIRMED** | tiktok-api-scopes. Refinement: `user.info.profile` also grants **`username`** and `profile_web_link`, which the design's table omits. |

### 3.3 Display API (`TIKTOK-API.md` § 3, `TOOLS.md`)

| # | Claim | Status | Notes / correction |
|---|---|---|---|
| 19 | `GET /v2/user/info/` — `fields` is a required query parameter | **CONFIRMED** | tiktok-api-v2-get-user-info. |
| 20 | Field-to-scope mapping (basic → ids/avatar/display name; profile → bio/deep link/is_verified; stats → counts) | **CONFIRMED** | Exact mapping: basic → `open_id`, `union_id`, `avatar_url`, `avatar_url_100`, `avatar_large_url`, `display_name`; profile → `bio_description`, `profile_deep_link`, `is_verified`, `username` (+ `profile_web_link` per scopes page); stats → `follower_count`, `following_count`, `likes_count`, `video_count`. |
| 21 | Requesting a field outside granted scopes is a hard error | **UNVERIFIED** | Consistent with the scope-gated field model and `scope_not_authorized`, but the exact behavior (error vs. omission) is not spelled out. Test empirically in Phase 1; keep the client-side filter either way. |
| 22 | `POST /v2/video/list/` — `fields` in query string; body `{cursor, max_count 1–20}` | **CONFIRMED** | `max_count`: "Default is 10. Maximum is 20." `cursor` is an int64 **UTC Unix timestamp in milliseconds**. |
| 23 | Returns `videos[]`, `cursor`, `has_more`; sorted `create_time` desc; public videos only | **CONFIRMED** | Verbatim in the reference. |
| 24 | Video field list (id, create_time, title, video_description, duration, height, width, cover_image_url, embed_html, embed_link, like/comment/share/view counts) | **CONFIRMED** | Video-object reference; `share_url` (used as a TOOLS.md default field) also exists. Note: read-side `title` and `video_description` are documented at max **150 chars** (display metadata), and `create_time` is epoch **seconds**. |
| 25 | CDN URLs short-lived ~6 h | **CONFIRMED (exact)** | `cover_image_url`: "TTL of 6 hours" (trust & safety). `/v2/video/query/` is documented as the way to refresh a cover URL's TTL. Separate fact: `creator_avatar_url` from creator_info has a **2-hour** TTL. |
| 26 | `POST /v2/video/query/` — `filters.video_ids`, max 20 ids, scope `video.list`, same field set | **CONFIRMED** | "Up to 20 video IDs can be included per request." |
| 27 | Display API per-endpoint QPS not publicly fixed; treat 429 as authoritative | **CONFIRMED (as stated)** | No published numbers on the overview or references fetched. |

### 3.4 Content Posting API (`TIKTOK-API.md` § 4, `TOOLS.md`)

| # | Claim | Status | Notes / correction |
|---|---|---|---|
| 28 | `POST /v2/post/publish/creator_info/query/` must be called before posting; latest options must be shown | **CONFIRMED** | "your app must invoke the API and use the latest creator information returned." Empty request body. **Additional facts the design omits**: rate limit **20 req/min** per user token; required scope is **`video.publish`** (impacts draft-only profiles — Finding 6). |
| 29 | `privacy_level_options` values incl. all four enum members; unaudited → only `SELF_ONLY` | **CONFIRMED (refine)** | The set depends on account type: **public** accounts → `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`; **private** accounts → `FOLLOWER_OF_CREATOR`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`. `FOLLOWER_OF_CREATOR` and `PUBLIC_TO_EVERYONE` never co-occur. Unaudited → `SELF_ONLY` only, confirmed. |
| 30 | `comment_disabled` / `duet_disabled` / `stitch_disabled`, `max_video_post_duration_sec`, creator identity fields | **CONFIRMED** | `duet_disabled`/`stitch_disabled` are also forced `true` for private accounts. |
| 31 | Direct post `POST /v2/post/publish/video/init/`; `post_info` fields incl. `title`, `privacy_level` (required), toggles, `video_cover_timestamp_ms`, `brand_content_toggle`, `brand_organic_toggle`, `is_aigc` | **CONFIRMED** | All fields present verbatim, including `is_aigc` ("Creator labeled as AI-generated"). Scope `video.publish`. |
| 32 | Video `title` max 2 200 chars, hashtags/mentions parsed | **CONFIRMED** | "The maximum length is 2200 in UTF-16 runes" — for **video** posts only (photos: 90; see #40). |
| 33 | PULL_FROM_URL: URL's domain must be verified in the portal | **CONFIRMED (refine)** | "the developer must verify the ownership of the URL prefix **or** domain." Also: URL must be `https`, must **not redirect**, and must stay accessible for **one hour** after the download task starts. Error: `url_ownership_unverified`. |
| 34 | FILE_UPLOAD: `video_size`, `chunk_size`, `total_chunk_count`; response `publish_id` + `upload_url` valid **1 hour**; PUT with `Content-Range: bytes {first}-{last}/{total}` | **CONFIRMED** | "valid for one hour after issuance"; Content-Range format verbatim. `publish_id` ≤ 64 chars, `upload_url` ≤ 256 chars. |
| 35 | Chunk rules: 5–64 MB; < 5 MB single whole-file chunk; final chunk may exceed nominal size up to a cap *(verify)* | **CONFIRMED (exact)** | Min 5 MB, max 64 MB per chunk; final chunk may be **up to 128 MB**; `total_chunk_count = floor(video_size / chunk_size)`; 1–1000 chunks; chunks upload **sequentially**; per-chunk PUT returns **206 Partial Content**, final returns **201 Created**. See deep dive § 6.1. |
| 36 | Init rate limit: **6 requests/minute per user access token** | **CONFIRMED** | Verbatim on direct-post, inbox-upload, and photo (content/init) references. |
| 37 | Inbox upload `POST /v2/post/publish/inbox/video/init/`, same `source_info`, **no** `post_info`, scope `video.upload`, terminal `SEND_TO_USER_INBOX`, user finishes in-app | **CONFIRMED** | "You should inform users that they must click on inbox notifications to continue the editing flow in TikTok and complete the post." **Additional fact**: `spam_risk_too_many_pending_share` — max **5 pending shares** per 24 h. |
| 38 | Photos `POST /v2/post/publish/content/init/`, `media_type: "PHOTO"`, `post_mode: DIRECT_POST \| MEDIA_UPLOAD` | **CONFIRMED** | DIRECT_POST → `video.publish`; MEDIA_UPLOAD → `video.upload` — matches TOOLS.md. |
| 39 | Photo `source_info`: PULL_FROM_URL, `photo_images[]` ≤ 35, `photo_cover_index`; FILE_UPLOAD not available *(verify)* | **CONFIRMED** | "array containing up to 35 photo content URLs"; only PULL_FROM_URL documented — FILE_UPLOAD still absent for photos as of 2026-07-21. Verified-domain rule applies (Finding 9). |
| 40 | Photo `post_info`: `title`, `description`, `privacy_level`, `auto_add_music`, `disable_comment`, brand toggles | **CONFIRMED (refine)** | **`title` max 90 UTF-16 runes; `description` max 4 000 UTF-16 runes** (the design capped only the description and left title uncapped — Finding 2). `privacy_level`, `disable_comment`, `auto_add_music`, brand toggles are **DIRECT_POST-only**. No `is_aigc` field for photos (TOOLS.md correctly omits it). |
| 41 | Status `POST /v2/post/publish/status/fetch/` → `PROCESSING_DOWNLOAD` / `PROCESSING_UPLOAD` / `SEND_TO_USER_INBOX` / `PUBLISH_COMPLETE` / `FAILED`, `fail_reason`, `publicaly_available_post_id[]`, `uploaded_bytes` | **CONFIRMED** | Spelling `publicaly_available_post_id` is indeed TikTok's (sic), list of int64. `PROCESSING_UPLOAD` is FILE_UPLOAD-only, `PROCESSING_DOWNLOAD` PULL_FROM_URL-only. **Additional facts**: `downloaded_bytes` also exists; endpoint rate limit **30 req/min** per user token; documented `fail_reason` values: `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed`, `internal`, `video_pull_failed`, `photo_pull_failed`, `publish_cancelled`, `auth_removed`, `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk`. |
| 42 | "TikTok recommends ≥ 5 s intervals; status retained for a limited window" | **UNVERIFIED / misattributed** | Neither a recommended polling interval nor a retention window is documented. 5 s is a fine **client** policy (and fits the 30/min limit) but should not be attributed to TikTok. Determine retention empirically in the Phase 2 sandbox pass. |

### 3.5 Rate limits, media constraints, audit (`TIKTOK-API.md` § 5–8, `README.md`)

| # | Claim | Status | Notes / correction |
|---|---|---|---|
| 43 | 6/min publish inits per user token | **CONFIRMED** | See #36. |
| 44 | Unaudited app: at most 5 distinct users may post per 24 h | **CONFIRMED** | "Unaudited API Clients can allow up to 5 users to post in a 24 hour window" (`reached_active_user_cap`). |
| 45 | Daily post cap platform-managed (`spam_risk_too_many_posts`) | **CONFIRMED (refine)** | Guidelines cite ≈ **15 posts/day per creator**, varies by creator, and is **shared across all API clients** using Direct Post. A 24-hour active-creator cap (sized from the audit application's estimates) applies **even to audited clients**. |
| 46 | Video formats MP4 (H.264) recommended, WebM/MOV; platform max ~10 min; 4 GB cap *(verify)* | **CONFIRMED** | Formats MP4/WebM/MOV; codecs H.264 (recommended), H.265, VP8, VP9; standard 3 min, "developers can send up to 10 minutes" (actual per-creator cap = `max_video_post_duration_sec`); max **4 GB**. **Missing from design**: framerate 23–60 FPS, dimensions 360–4096 px per side — both are `fail_reason` triggers (`frame_rate_check_failed`, `picture_size_check_failed`) and belong in pre-flight validation. |
| 47 | Photos JPG/JPEG/WebP, ≤ 35 images, ≤ 20 MB per image *(verify)* | **CONFIRMED (refine)** | Formats **JPEG and WebP**; max **20 MB** each; **max resolution 1080p** (missing from the design's constraint list). |
| 48 | Title ≤ 2 200; photo description ≤ 4 000 *(verify)* | **CONFIRMED / INCOMPLETE** | Video title 2 200 confirmed; photo description 4 000 confirmed; **photo title 90** missing (Finding 2). |
| 49 | Unaudited: only `SELF_ONLY`; posting account must itself be private *(verify)* | **CONFIRMED** | Guidelines: unaudited clients post SELF_ONLY only; to make such content public later the account owner switches the account public and edits each post's privacy manually in-app. |
| 50 | After audit, restrictions lift; prior SELF_ONLY posts stay private | **CONFIRMED** | Per content-sharing guidelines. Note other caps (active-creator, per-creator daily) remain post-audit. |
| 51 | Audit-relevant UX: show creator nickname, explicit consent, disclosure toggles, music confirmation, no CDN caching | **CONFIRMED (refine)** | Guidelines additionally require: privacy selected **manually with no default value** (the plan-and-apply "privacy_level required on apply" satisfies this — keep it; never default it), interaction toggles **unchecked by default** (design: default false — compliant), and the exact music-consent wording ("By posting, you agree to TikTok's Music Usage Confirmation"; with branded content, also the Branded Content Policy). **Missing rule**: branded content cannot be private — Finding 3. |

## 4. Findings

### Finding 1 — PKCE `code_challenge` must be hex-encoded SHA-256, not base64url
- **Severity: High** (login is dead-on-arrival if implemented per RFC 7636)
- **Issue**: TikTok's desktop Login Kit documents `code_challenge = SHA256(code_verifier)`
  with **hex encoding** of the digest — a deliberate deviation from RFC 7636's
  base64url. `AUTH.md` § 1 and `TIKTOK-API.md` § 2 specify `S256` but never state
  the encoding; any off-the-shelf PKCE helper (Node `crypto` + base64url, oauth
  libraries) will produce challenges TikTok rejects at the consent page or token
  exchange.
- **Impact**: complete failure of the `login` CLI; hard to diagnose (TikTok's error
  will not say "wrong encoding").
- **Recommendation**: state explicitly in AUTH.md: verifier = 43–128 chars from
  `[A-Za-z0-9-._~]`, challenge = `createHash('sha256').update(verifier).digest('hex')`,
  `code_challenge_method=S256`. Add a unit test pinning a known verifier→challenge
  vector. Re-check the doc at implementation time in case TikTok migrates to RFC
  behavior.
- **Doc refs**: `docs/AUTH.md` § 1, `docs/TIKTOK-API.md` § 2.
  Source: https://developers.tiktok.com/doc/login-kit-desktop

### Finding 2 — Photo post title cap is 90 chars, not 2 200
- **Severity: High** (guaranteed runtime rejections for a mainstream input)
- **Issue**: photo posts: "maximum length for photo posts is 90 in UTF-16 runes"
  (title) and 4 000 (description). `TIKTOK-API.md` § 6 states a blanket
  "Title ≤ 2 200" and § 4.4 lists `title` uncapped; `TOOLS.md`
  `tiktok_post_photos.title` is "string, optional" with no bound.
- **Impact**: a model writing a normal-length caption into `title` gets an
  upstream `invalid_params`-class failure after passing local validation —
  exactly what the "validation before network" principle is meant to prevent.
- **Recommendation**: cap `title` at 90 UTF-16 code units for photos in the zod
  schema (and describe the split: short title vs. long description). Note the
  UTF-16 unit: emoji count as 2.
- **Doc refs**: `docs/TIKTOK-API.md` § 4.4/§ 6, `docs/TOOLS.md` (`tiktok_post_photos`).
  Source: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post

### Finding 3 — Branded content cannot be `SELF_ONLY`; unaudited apps cannot post branded content
- **Severity: High** (validation gap + compliance-relevant UX rule)
- **Issue**: TikTok's guidelines: when the branded-content option is checked,
  private visibility must be disabled — "Branded content visibility cannot be set
  to private." Consequence: `brand_content_toggle: true` + `privacy_level:
  SELF_ONLY` is an invalid combination, and since unaudited clients only get
  `SELF_ONLY`, **branded content is unpostable pre-audit**. No design doc
  mentions this interaction.
- **Impact**: doomed init calls; worse, an audit reviewer will look for exactly
  this UX rule (it is on the audit checklist along with the music-consent text).
- **Recommendation**: local validation in `tiktok_post_video`/`tiktok_post_photos`:
  reject `brand_content_toggle && privacy_level === "SELF_ONLY"` with a message
  explaining the rule; plan preview must surface "branded content ⇒ cannot be
  private; unaudited app ⇒ cannot post branded content yet". Also render the
  compliance wording: brand_organic → "Promotional content" music confirmation;
  brand_content → "Paid partnership" + Branded Content Policy consent.
- **Doc refs**: `docs/TOOLS.md` (both write tools), `docs/TIKTOK-API.md` § 7–8.
  Sources: https://developers.tiktok.com/doc/content-sharing-guidelines,
  https://www.tiktok.com/legal/page/global/bc-policy/en

### Finding 4 — Egress allowlist omits the real upload host; `upload_url` embeds a credential
- **Severity: Medium**
- **Issue**: FILE_UPLOAD PUTs target `open-upload.tiktokapis.com` (per TikTok's
  get-started examples), so `README.md`'s "the process talks to
  `open.tiktokapis.com` … — nothing else" is factually wrong, while
  ARCHITECTURE § 6's `*.tiktokapis.com` suffix rule happens to cover it. The
  returned `upload_url` carries `upload_id` and **`upload_token`** query
  parameters — a bearer-equivalent secret.
- **Impact**: (a) an implementer following README literally would block uploads;
  (b) logging/journaling the full `upload_url` leaks a live upload credential.
- **Recommendation**: name `open-upload.tiktokapis.com` explicitly in the egress
  allowlist (README + SECURITY.md) and add `upload_url`/`upload_token` to the
  redaction list (`mcp/redact.ts` spec) — log at most origin + path.
- **Doc refs**: `README.md` (Design at a glance), `docs/ARCHITECTURE.md` § 6,
  `docs/SECURITY.md` (Egress). Source:
  https://developers.tiktok.com/doc/content-posting-api-get-started

### Finding 5 — Loopback redirect: confirmed, and the fixed-port constraint is unnecessary
- **Severity: Medium** (design simplification; removes a hedged unknown)
- **Issue**: `AUTH.md` § 1 hedges on loopback-HTTP acceptance and therefore fixes
  the port (`TT_REDIRECT_PORT=43110`) with a manual-paste fallback. The desktop
  Login Kit doc settles it: `http://localhost` and `http://127.0.0.1` are the
  *only* permitted hosts for desktop apps, a port is **required**, and a
  **wildcard port** (`http://127.0.0.1:*/callback/`) may be registered. URIs must
  be static (no query/fragment), exact-matched (mind the trailing slash), ≤ 10
  per app, ≤ 512 chars.
- **Impact**: none if unchanged (fixed port remains valid), but the design can
  return to the preferred random-port pattern and drop the "TikTok may require
  HTTPS" caveat, which is wrong for desktop apps.
- **Recommendation**: update AUTH.md: recommend registering
  `http://127.0.0.1:*/callback/`, use a random port by default, keep
  `TT_REDIRECT_PORT` as an override; document exact-match/trailing-slash
  semantics; delete the HTTPS-doubt sentence; keep manual-paste as an optional
  convenience only.
- **Doc refs**: `docs/AUTH.md` § 1, `docs/CONFIGURATION.md` (OAuth section).
  Source: https://developers.tiktok.com/doc/login-kit-desktop

### Finding 6 — `creator_info` requires `video.publish`; draft-only profiles can't call it
- **Severity: Medium**
- **Issue**: `/v2/post/publish/creator_info/query/` is documented under scope
  `video.publish` (`scope_not_authorized` otherwise). A profile authorized only
  for `video.upload` (inbox-draft workflows) cannot run it. ARCHITECTURE § 8 says
  plan mode "runs all read steps — creator_info query …" generically, and
  TOOLS.md's plan flow implies creator_info before every publish.
- **Impact**: the plan phase of `tiktok_upload_video_draft` (and photo
  `MEDIA_UPLOAD` mode) would fail with a scope error even though the actual init
  call needs no creator_info (no `post_info`, no privacy level).
- **Recommendation**: make the creator_info pre-flight conditional: required for
  DIRECT_POST paths, skipped (or best-effort) for inbox/MEDIA_UPLOAD paths.
  State the `video.publish` scope on `tiktok_query_creator_info` in TOOLS.md.
- **Doc refs**: `docs/TOOLS.md` (`tiktok_query_creator_info`,
  `tiktok_upload_video_draft`), `docs/ARCHITECTURE.md` § 8. Source:
  https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info

### Finding 7 — Missing documented per-endpoint rate limits (status 30/min, creator_info 20/min)
- **Severity: Medium**
- **Issue**: `TIKTOK-API.md` § 5's table records only the 6/min init limit.
  Official references also fix: `status/fetch` **30 req/min**, `creator_info`
  **20 req/min**, per user access token.
- **Impact**: `tiktok_get_publish_status` with `wait: true` (5 s interval = 12/min)
  is safe alone, but two concurrent waits plus ad-hoc polls can trip 30/min;
  repeated plan previews (each calling creator_info) can trip 20/min.
- **Recommendation**: add both numbers to § 5; extend the client-side token-bucket
  design (ARCHITECTURE § 6.5) to cover these two endpoints, not just inits.
- **Doc refs**: `docs/TIKTOK-API.md` § 5, `docs/ARCHITECTURE.md` § 6. Sources:
  https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status,
  https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info

### Finding 8 — Error-code and `fail_reason` catalogs are incomplete
- **Severity: Medium**
- **Issue**: the design's known-error list omits documented codes the tool layer
  is expected to map to recovery hints: `url_ownership_unverified`,
  `privacy_level_option_mismatch`, `unaudited_client_can_only_post_to_private_accounts`,
  `spam_risk_too_many_pending_share` (inbox/photo: > 5 pending shares/24 h).
  TOOLS.md promises "Descriptions map every fail_reason to a recovery hint" but
  no doc enumerates them: `file_format_check_failed`, `duration_check_failed`,
  `frame_rate_check_failed`, `picture_size_check_failed`, `internal`,
  `video_pull_failed`, `photo_pull_failed`, `publish_cancelled`, `auth_removed`,
  `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`,
  `spam_risk_text`, `spam_risk`.
- **Impact**: the error-taxonomy promise (ARCHITECTURE § 11) can't be implemented
  from the spec; models get generic failures for the most common publish errors.
- **Recommendation**: add both catalogs to `TIKTOK-API.md` § 1/§ 4.5 with the
  recovery hint per code (e.g. `auth_removed` → re-login; `spam_risk_text` →
  rewrite title; `reached_active_user_cap` → suggest `MEDIA_UPLOAD`/wait 24 h).
- **Doc refs**: `docs/TIKTOK-API.md` § 1, § 4.5; `docs/TOOLS.md`
  (`tiktok_get_publish_status`).

### Finding 9 — Practical reach of PULL_FROM_URL: photo posting only works from developer-verified hosting
- **Severity: Medium** (expectation management; tool-description correctness)
- **Issue**: photos support **only** PULL_FROM_URL, and PULL_FROM_URL only
  accepts URLs whose **domain or URL prefix the developer has verified** in the
  portal. Therefore `tiktok_post_photos` cannot post arbitrary public image URLs
  (e.g. an Unsplash link) and cannot post local files at all. The docs state the
  verification rule but never draw this consequence.
- **Impact**: the single most likely first use ("post this image from my disk /
  from this link") fails with `url_ownership_unverified`; the model will retry
  uselessly unless the tool description forecloses it.
- **Recommendation**: say it outright in TOOLS.md (`photo_urls` description) and
  README: photo posting requires the operator to host images on a domain/prefix
  they have verified in the TikTok developer portal; local photo files are not
  postable via the API today. Consider a pre-flight config
  (`TT_VERIFIED_URL_PREFIXES`) so the plan phase can reject unverifiable URLs
  locally. Same caveat applies to `tiktok_post_video` with `source: "url"`.
- **Doc refs**: `docs/TOOLS.md` (`tiktok_post_photos`, `tiktok_post_video`),
  `docs/SECURITY.md` (egress note). Sources:
  https://developers.tiktok.com/doc/content-posting-api-reference-photo-post,
  https://developers.tiktok.com/doc/content-posting-api-reference-direct-post

### Finding 10 — Polling guidance misattributed; status retention unknown
- **Severity: Low**
- **Issue**: "TikTok recommends ≥ 5 s intervals; status is retained for a limited
  window" — neither statement appears in the official references.
- **Impact**: minor; risk of "verified" statements eroding trust in the reference
  doc's rigor.
- **Recommendation**: reword as client policy ("we poll at 5 s, which fits the
  30/min endpoint limit"); mark retention as unknown-until-measured and add it to
  the Phase 2 sandbox checklist.
- **Doc ref**: `docs/TIKTOK-API.md` § 4.5.

### Finding 11 — Missing client-side media validations TikTok will enforce
- **Severity: Low**
- **Issue**: § 6 omits documented constraints: video framerate **23–60 FPS**,
  dimensions **360–4096 px** per side; photo resolution max **1080p**. Each maps
  to a terminal `fail_reason` (`frame_rate_check_failed`,
  `picture_size_check_failed`).
- **Recommendation**: add to § 6 and to the pre-flight validation list
  (ARCHITECTURE § 8). Full ffprobe-grade validation is optional; at minimum the
  plan preview should warn when probing is impossible.
- **Doc refs**: `docs/TIKTOK-API.md` § 6, `docs/ARCHITECTURE.md` § 8. Source:
  https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide

### Finding 12 — Small reference corrections
- **Severity: Low**
- **Items**:
  1. `user.info.profile` also grants `username` (and `profile_web_link`) — add to
     the scope table (`TIKTOK-API.md` § 2) and the user-info field enum.
  2. `privacy_level_options` sets are account-type dependent (public vs. private
     account — see table row 29); `FOLLOWER_OF_CREATOR` implies a private account.
     Useful signal for plan previews.
  3. `creator_avatar_url` TTL is **2 h** (not the 6 h of Display API CDN URLs).
  4. Status response also carries `downloaded_bytes` (PULL_FROM_URL progress) —
     TOOLS.md output lists only `uploaded_bytes`.
  5. Read-side `title`/`video_description` are ~150-char display fields;
     `create_time` is epoch **seconds** while the list `cursor` is epoch
     **milliseconds** — worth a note so the implementation doesn't unify them.
  6. Revoke params are `client_key`, `client_secret`, `token` (access token).
  7. TESTING.md's chunk property invariant "chunks within bounds" must encode the
     real bounds: every non-final chunk ∈ [5 MB, 64 MB], final chunk ∈
     [chunk remainder rule, ≤ 128 MB], count = `floor(size/chunk_size)` ∈ [1, 1000].

## 5. Platform behaviors the design does not cover

1. **Branded-content ↔ privacy interaction** (Finding 3) — including the exact
   consent wording the audit checks ("Music Usage Confirmation" vs. "Branded
   Content Policy and Music Usage Confirmation").
2. **Pending-share cap for inbox flows** — `spam_risk_too_many_pending_share`:
   max 5 unprocessed inbox shares per 24 h. Distinct from the daily post cap and
   from the unaudited 5-user cap; hits exactly the draft workflow the design
   recommends as the safe default (`post_mode: "draft"`).
3. **Per-creator daily posting cap ≈ 15/day, shared across *all* third-party
   clients** — a user active in another tool can exhaust their cap; the server's
   local journal cannot predict it. Map `spam_risk_too_many_posts` accordingly.
4. **Post-audit caps remain** — the active-creator quota (sized at audit time)
   applies even after approval; `reached_active_user_cap` is not only an
   unaudited phenomenon. Recovery hint: inbox `MEDIA_UPLOAD` is reported to be
   exempt from the DAU cap (secondary source; verify in sandbox).
5. **`auth_removed` / `publish_cancelled` fail reasons** — the user can revoke the
   app or cancel mid-processing; the status tool should treat these as terminal
   with specific messaging (re-login vs. user-cancelled).
6. **Minor / restricted accounts** — creators under platform age thresholds get
   reduced `privacy_level_options` (no `PUBLIC_TO_EVERYONE`), forced
   `duet_disabled`/`stitch_disabled`. The creator_info-driven design handles this
   *implicitly*; the tool description should say "options may be reduced for some
   accounts (private, minors) — never hint the model to work around".
7. **Region availability** — TikTok does not publish a per-region availability
   matrix for Direct Post; integrators report gaps. Unverifiable from docs; add a
   sandbox probe and treat unexplained creator_info failures as possibly regional.
8. **Commercial-music constraints** — `auto_add_music` selects from licensed
   libraries; business/branded contexts restrict available music (Commercial
   Music Library). Not modeled; acceptable for v1, but the photo-post description
   should not promise specific music behavior.
9. **Upload PUT protocol difference** — the chunk PUT responds 206/201 with no
   `{data, error}` envelope; the HTTP client's envelope parser must not run on
   upload responses, and chunk-retry semantics (can a failed chunk PUT be
   retried? resumed?) are undocumented — decide and test empirically (the 1-hour
   `upload_url` TTL bounds any resume strategy).
10. **Redirect-URI exact matching** — trailing slash and port must match the
    registered URI byte-for-byte; a `/callback` vs `/callback/` mismatch is a
    classic integration failure. Document the canonical form once.

## 6. Deep dive

### 6.1 FILE_UPLOAD chunk math, exactly

The documented rules compose into a stricter algorithm than "5–64 MB chunks":

- `total_chunk_count = floor(video_size / chunk_size)` — TikTok's own formula.
  The remainder `video_size mod chunk_size` does **not** form an extra chunk; it
  is **merged into the final chunk**. So for `video_size = 65 MB`,
  `chunk_size = 32 MB`: count = 2, chunks are 32 MB and 33 MB.
- Constraints: `5 MB ≤ chunk_size ≤ 64 MB`; final chunk ≤ **128 MB**;
  `1 ≤ total_chunk_count ≤ 1000`; chunks PUT **sequentially**;
  `Content-Range: bytes {first}-{last}/{total}`; per-chunk response **206**,
  final **201**; everything within the 1-hour `upload_url` TTL.
- Files **< 5 MB**: single chunk, `chunk_size = video_size`, count = 1 (the only
  case where `chunk_size < 5 MB` is legal).
- Safety of the bounds: with `chunk_size ≤ 64 MB` the merged final chunk is
  `< 2 × chunk_size ≤ 128 MB`, so the 128 MB cap can never be violated by the
  floor-merge rule itself — but only if `chunk_size ≤ 64 MB` is enforced.
  With `video_size ≤ 4 GB` and `chunk_size ≥ 5 MB`, count ≤ 819 < 1000 — the
  chunk-count cap is likewise unreachable. A fixed `chunk_size = 64 MB` (whole
  file when smaller than 5 MB) is therefore always valid; recommend hard-coding
  it and deleting any chunk-size heuristics.
- Test-suite consequence (TESTING.md): the property invariant is *not* "all
  chunks within 5–64 MB". Correct invariants: (a) count = `floor(size/chunk)`,
  (b) non-final chunks exactly `chunk_size`, (c) final chunk =
  `chunk_size + (size mod chunk_size)` ≤ 128 MB, (d) contiguous ranges summing
  to `size`, (e) single whole-file chunk when `size < 5 MB`. Boundary cases to
  pin: size = 5 MB − 1, 5 MB, 64 MB, 64 MB + 1, 128 MB, 128 MB + 1, 4 GB.

### 6.2 Desktop OAuth: the two TikTok-specific traps

**Trap 1 — hex PKCE.** TikTok's desktop doc defines
`code_challenge = HEX(SHA256(code_verifier))`. Every mainstream OAuth/PKCE
library emits base64url per RFC 7636 — 43 chars of `[A-Za-z0-9-_]` — whereas
TikTok expects 64 lowercase hex chars. The failure mode is a rejected
authorization or token exchange with an unhelpful error. Mitigation: hand-roll
the 5-line challenge computation, pin it with a test vector, and comment *why*
it deviates from the RFC so a future refactor doesn't "fix" it back.

**Trap 2 — redirect URI shape.** Desktop apps may only use
`localhost`/`127.0.0.1` hosts (http allowed), the port is mandatory, wildcard
ports are supported (`http://127.0.0.1:*/callback/`), and URIs are static and
exact-matched. Practical setup for this server: register the wildcard-port URI
once, bind an OS-assigned ephemeral port at `login` time, and pass the concrete
`http://127.0.0.1:<port>/callback/` (trailing slash!) as `redirect_uri` in both
the authorize request and the token exchange (they must match each other and the
registered pattern). This removes the fixed-port collision risk (`43110` already
in use ⇒ login fails) that the current design accepts as a trade-off. The
`state` parameter remains mandatory practice; TikTok echoes it to the callback.

### 6.3 PULL_FROM_URL ownership verification workflow

What "verified domain" actually involves, and why it reshapes two tools:

1. In the developer portal, under the app's URL properties, the developer adds
   either a **domain** (verified via a DNS record / hosted signature file) or a
   **URL prefix** (exact-prefix match). Verification is per-app and must be
   completed **before** any `PULL_FROM_URL` init; otherwise the init returns
   `url_ownership_unverified`.
2. Constraints on the media URL itself: `https` only, **no redirects** (a CDN
   302 breaks the download), and the resource must remain available for **one
   hour** after the download task starts. `status/fetch` reports
   `PROCESSING_DOWNLOAD` with `downloaded_bytes`, and failures surface as
   `video_pull_failed` / `photo_pull_failed`.
3. Consequences for this design:
   - `tiktok_post_video(source: "url")` and `tiktok_post_photos` are only usable
     with hosting the *operator* controls — never with arbitrary links the model
     found on the web. The tool descriptions must state this as a hard platform
     rule so the model doesn't burn init-rate-limit budget discovering it.
   - Since photos have **no FILE_UPLOAD**, "post this local image" has no direct
     API path. The honest v1 posture is to document the limitation; a future
     convenience (operator-configured verified bucket the server uploads to) is
     out of scope and should stay out of v1 (it adds an egress target and a
     credential class).
   - A `TT_VERIFIED_URL_PREFIXES` allowlist (operator-declared) would let the
     plan phase reject unverifiable URLs locally, converting a confusing
     upstream error into an actionable local one — cheap and consistent with the
     "validation before network" principle.

---

*End of review. Verdict: **Approve with changes** — fold Findings 1–9 into the
specs before Phase 1; Findings 10–12 are editorial and can ride along.*
