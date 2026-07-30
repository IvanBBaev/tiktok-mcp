# TikTok Platform Deep Review — Round 2

**Role:** Principal Integration Engineer, TikTok for Developers platform specialist
**Scope:** Second-pass verification and implementation-grade specification for the TikTok MCP server (design phase, no code)
**Builds on:** `docs/reviews/tiktok-platform-review.md` (round 1: 51 claims verified, Findings 1–12). This document does not repeat round-1 prose; it re-verifies the four round-1 corrections, resolves the three UNVERIFIED items, and delivers the implementation-grade specifications requested for round 2.

---

## 1. Reviewer & scope

Primary sources consulted (all fetched during this review):

| # | Source | URL |
|---|--------|-----|
| S1 | Login Kit for Desktop | https://developers.tiktok.com/doc/login-kit-desktop |
| S2 | OAuth user access token management | https://developers.tiktok.com/doc/oauth-user-access-token-management |
| S3 | Content Posting API — Get started | https://developers.tiktok.com/doc/content-posting-api-get-started |
| S4 | Content Posting API — Media transfer guide | https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide |
| S5 | Content Posting API — Direct Post reference (video init) | https://developers.tiktok.com/doc/content-posting-api-reference-direct-post |
| S6 | Content Posting API — Photo post reference | https://developers.tiktok.com/doc/content-posting-api-reference-photo-post |
| S7 | Content Posting API — Get post status (status/fetch) | https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status |
| S8 | Content Posting API — Query creator info | https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info |
| S9 | Content sharing guidelines (UX + audit rules) | https://developers.tiktok.com/doc/content-sharing-guidelines |
| S10 | Display API v2 — Error handling | https://developers.tiktok.com/doc/tiktok-api-v2-error-handling |
| S11 | Display API v2 — Rate limits | https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit |
| S12 | App review guidelines | https://developers.tiktok.com/doc/app-review-guidelines |
| S13 | Getting started — Create an app | https://developers.tiktok.com/doc/getting-started-create-an-app |
| S14 | Add a sandbox | https://developers.tiktok.com/doc/add-a-sandbox/ |
| S15 | Branded Content Policy | https://www.tiktok.com/legal/page/global/bc-policy/en |

Secondary sources (used only for undocumented operational facts, flagged as such wherever cited): getphyllo.com, docs.mixpost.app, postproxy.io engineering blogs on TikTok audit timelines.

Verification method: verbatim quote extraction from the primary pages above; arithmetic in the chunk test vectors computed and cross-checked against TikTok's own worked example in S3.

---

## 2. Re-verification of round-1 corrections

### 2.1 Correction (a): PKCE `code_challenge` is hex-encoded SHA-256 — **RE-CONFIRMED**

S1 states verbatim:

> "Create the code challenge by hashing the code verifier using hex encoding of SHA256."

The official code sample on the same page uses CryptoJS with `.toString(CryptoJS.enc.Hex)`. This is **not** RFC 7636 (which mandates base64url). The verifier alphabet and length are RFC-conformant:

> "unreserved characters [A-Z] / [a-z] / [0-9] / '-' / '.' / '_' / '~', with a minimum length of 43 characters and a maximum length of 128 characters."

**Verdict:** Round-1 correction stands. Implementation MUST use `hex(sha256(verifier))`, never base64url. A standard OAuth/PKCE library will silently produce base64url and every token exchange will fail — hand-roll the challenge derivation and pin it with a unit test vector.

### 2.2 Correction (b): Photo title 90 / description 4000 — **RE-CONFIRMED**

S6 states verbatim:

- `post_info.title` (photo): "The maximum length for photo posts is 90 in UTF-16 runes."
- `post_info.description` (photo): maximum length "4000 in UTF-16 runes."

Additional constraints confirmed on the same page: photos are **PULL_FROM_URL only**; `photo_images` accepts "up to 35 photo content URLs"; `photo_cover_index` selects the cover. Video `title` remains 2200 UTF-16 runes (S5) — the two media types have different caption models (video: single `title` used as caption; photo: separate `title` + `description`).

**Verdict:** Round-1 correction stands. Tool input validation must enforce per-media-type limits in UTF-16 code units (JavaScript `String.prototype.length` is exactly UTF-16 code units, so plain `.length` checks are correct — do not count Unicode code points).

### 2.3 Correction (c): `brand_content_toggle` incompatible with `SELF_ONLY` — **RE-CONFIRMED, with refinement**

S9 states verbatim:

> "If a user wants to choose Branded Content, it is important to note that it can only be configured with visibility as public/friends."

and requires that when private visibility is selected, either "the 'Branded Content' option should be disabled" or "the visibility setting should be automatically switched to public", with the exact tooltip wording:

> "Branded content visibility cannot be set to private."

**Refinement (new in round 2):** this is documented as a **mandatory client-side UX rule in the content-sharing guidelines**, not as an API error. The Direct Post reference (S5) documents `brand_content_toggle` only as "Set to `true` if the video is a paid partnership to promote a third-party business." and `brand_organic_toggle` as "Set to `true` if this video is promoting the creator's own business." — **no error code for the branded+SELF_ONLY combination is documented anywhere**. Whether the API rejects it (and with which code) or silently accepts it is unknown.

**Verdict:** Round-1 correction stands, but enforcement responsibility is on our side. The MCP server MUST reject `brand_content_toggle: true` + `privacy_level: SELF_ONLY` at validation time with the tooltip wording above (this is also an audit checklist item — S9 UX rules are what the audit reviews). API-level behavior goes to the sandbox probe list (§7, P-6).

### 2.4 Correction (d): Upload host `open-upload.tiktokapis.com`, `upload_token` in query — **RE-CONFIRMED, with a new twist**

S3's worked example returns:

```
"upload_url": "https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123"
```

**New finding:** S4 (media transfer guide) shows a **second, regional upload host** in its example:

```
https://upload.us.tiktokapis.com/video/?upload_id=67890&upload_token=chunkexample
```

So the upload host is not a single fixed hostname; TikTok may return regional variants. Consequences:

1. The egress allowlist MUST match by suffix `*.tiktokapis.com` (or at minimum enumerate both `open-upload.tiktokapis.com` and `upload.*.tiktokapis.com`), not pin one upload host. Pinning only `open-upload.tiktokapis.com` would break uploads whenever a regional URL is issued.
2. The client MUST treat `upload_url` as an opaque URL to be used verbatim — never parsed/reconstructed.
3. `upload_token` is a bearer-equivalent credential carried in the query string — it MUST be redacted in all logs, error messages, and MCP tool outputs (round-1 Finding stands; now applies to any `*.tiktokapis.com` URL).

**Verdict:** Round-1 correction stands and is extended: suffix-based egress rule + URL opacity + query-string redaction.

---

## 3. Resolved unknowns (round-1 UNVERIFIED items)

### 3.1 Round-1 #7: does `invalid_params` exist? — **RESOLVED: both spellings exist, on different API surfaces**

- S10 (Display API error handling) documents **`invalid_params`** (plural), HTTP 400, alongside: `access_token_invalid` (401 — "Please refresh the token and retry."), `internal_error` (500), `invalid_file_upload` (400), `rate_limit_exceeded` (429), `scope_not_authorized` (401), `scope_permission_missed` (400).
- S5/S6/S7 (Content Posting API references) document **`invalid_param`** (singular), HTTP 400 — "Check error message for details."

**Implementation rule:** the error taxonomy mapper must recognize **both** spellings and normalize them to the same internal `INVALID_ARGUMENT` class. Never switch on exact string equality against only one variant.

### 3.2 Round-1 #21: requesting a user-info field outside granted scope — **CONFIRMED UNDOCUMENTED; safe design chosen**

The user-info reference does not state whether an out-of-scope field produces an error or a silent omission. S10's `scope_permission_missed` (400, "The scope required for this request is missing… ask users to authorize.") strongly suggests a **hard error**, not omission.

**Safe assumption adopted:** treat it as a hard 400. The MCP server keeps its client-side field filter (only request fields covered by the token's granted `scope` string, which the token response returns comma-separated per S2) so the error path is never exercised in normal operation. Runtime probe P-4 (§7) confirms actual behavior.

### 3.3 Round-1 #42: how long is a `publish_id` queryable via status/fetch? — **CONFIRMED UNDOCUMENTED; safe design chosen**

S7 documents the endpoint, its 30 req/min limit, and its terminal states, but no retention window. No other primary page mentions one.

**Safe assumption adopted:**
1. Treat `publish_id` as reliably queryable for **at least the duration of the publish attempt plus a short tail** — do not design any feature that depends on querying a publish_id days later.
2. The journal MUST persist the **terminal status (and `publicaly_available_post_id` when present) immediately upon observation** — the journal, not TikTok, is the system of record for post history.
3. When status/fetch returns `invalid_publish_id` (400) for an ID the journal knows, map it to "status no longer available — see journal", not to a user error.

Runtime probe P-1 (§7) measures the actual window.

---

## 4. Implementation-grade specifications

### 4.1 FILE_UPLOAD chunk algorithm + test vectors

#### 4.1.1 Rules (verbatim, S4)

> "Each chunk must be at least 5 MB but no greater than 64 MB, except for the final chunk, which can be greater than chunk_size (up to 128 MB)."
> "Videos with a total size less than 5 MB must be uploaded as a whole, with chunk_size equal to the entire video's byte size."
> "Videos with a total size greater than 64 MB must be uploaded in multiple chunks."
> "There must be a minimum of 1 chunk and a maximum of 1000 chunks."
> "total_chunk_count should be equal to video_size divided by chunk_size, rounded down to the nearest integer."
> "File chunks must be uploaded sequentially."

PUT headers per chunk: `Content-Type: {MIME_TYPE}`, `Content-Length: {BYTE_SIZE_OF_THIS_CHUNK}`, `Content-Range: bytes {FIRST_BYTE}-{LAST_BYTE}/{TOTAL_BYTE_LENGTH}`.

**MB convention:** TikTok's own worked example (S3) uses `chunk_size: 10000000` for a `video_size: 50000123` file — decimal megabytes. To be safe under *either* reading (5 MB = 5,000,000 or 5,242,880; 64 MB = 64,000,000 or 67,108,864), the constants below use **decimal for the minimum bound check and decimal for the chosen chunk size**, which satisfies both interpretations of the maximum (64,000,000 < 67,108,864).

#### 4.1.2 Algorithm (normative)

```
CHUNK_SIZE   = 64_000_000        // constant; safe under decimal and binary readings
MIN_WHOLE    = 5_000_000         // below this, whole-file upload is mandatory
MAX_FILE     = 4 * 1024**3      // 4 GB hard cap (S4); reject larger before init

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

With `CHUNK_SIZE = 64,000,000` the final merged chunk is at most `64,000,000 + 63,999,999 = 127,999,999 < 128 MB` under the decimal reading, so the 128 MB final-chunk cap can never be violated. Max file 4 GB / 64,000,000 → at most 67 chunks, far below the 1000-chunk cap. Expected responses: `206` per intermediate chunk, `201` after the final chunk (S4; full code table in §4.2.4).

#### 4.1.3 Test vectors (all byte values exact; `/TOTAL` denominator = video_size)

| # | video_size (bytes) | chunk_size | total_chunk_count | Content-Range sequence | Rule exercised |
|---|---|---|---|---|---|
| V1 | 3,145,728 | 3,145,728 | 1 | `bytes 0-3145727/3145728` | < 5 MB → whole-file mandatory |
| V2 | 5,000,000 | 5,000,000 | 1 | `bytes 0-4999999/5000000` | exactly 5 MB, single chunk |
| V3 (official, S3) | 50,000,123 | 10,000,000 | 5 | `bytes 0-9999999/50000123` · `10000000-19999999` · `20000000-29999999` · `30000000-39999999` · `40000000-50000122` | floor(50,000,123/10⁷)=5; final chunk 10,000,123 bytes (merged remainder) — matches TikTok's own example |
| V4 | 64,000,000 | 64,000,000 | 1 | `bytes 0-63999999/64000000` | exactly 64 MB, single chunk |
| V5 | 64,000,001 | 64,000,000 | 1 | `bytes 0-64000000/64000001` | floor = 1 → ONE chunk whose actual length (64,000,001) **exceeds declared chunk_size** — the key floor-merge subtlety |
| V6 | 150,000,000 | 64,000,000 | 2 | `bytes 0-63999999/150000000` · `bytes 64000000-149999999/150000000` | final chunk 86,000,000 ≤ 128 MB |
| V7 | 256,000,000 | 64,000,000 | 4 | `0-63999999` · `64000000-127999999` · `128000000-191999999` · `192000000-255999999` (all `/256000000`) | exact multiple — final chunk exactly chunk_size |
| V8 | 4,294,967,296 (4 GiB) | 64,000,000 | 67 | chunks 1–66: 64,000,000 bytes each (chunk 66 ends at 4,223,999,999); final: `bytes 4224000000-4294967295/4294967296` (70,967,296 bytes) | max file size; 67 ≤ 1000 chunks; final merge ≤ 128 MB |

These eight vectors are the mandatory table-driven unit test for the chunk planner (TESTING.md amendment A-10, §6).

#### 4.1.4 Media constraints to validate before init (S4)

Video: MP4 (recommended) / WebM / MOV; H.264 (recommended) / H.265 / VP8 / VP9; 23–60 FPS; 360–4096 px on both dimensions; max duration 10 minutes; max 4 GB.
Photo (PULL_FROM_URL only): WebP / JPEG; max 1080p; max 20 MB per image; up to 35 images.

### 4.2 Complete error-code catalog with MCP recovery actions

Three distinct error shapes exist. The client must select the parser by endpoint class, never by guessing.

#### 4.2.1 Shape 1 — OAuth endpoints (`/v2/oauth/token/`, `/v2/oauth/revoke/`): flat object, NOT the data envelope (S2)

```json
{ "error": "invalid_request", "error_description": "...", "log_id": "..." }
```

| `error` value | Meaning | MCP recovery action |
|---|---|---|
| `invalid_request` (documented, S2) | Malformed params, bad/expired/reused `code`, redirect_uri mismatch, wrong PKCE | Non-retryable. Surface `AUTH_ERROR` with `error_description`; if during login flow, restart authorization |
| `invalid_grant` / `invalid_client` / `unauthorized_client` / `invalid_scope` (standard OAuth2; not individually documented by TikTok) | Standard OAuth2 semantics | Same class: non-retryable `AUTH_ERROR`; parse defensively — treat any non-empty `error` as failure |

Notes fixed by S2: token success returns `access_token` (24 h, `expires_in: 86400`), `refresh_token` (`refresh_expires_in: 31536000` = 365 d), `open_id`, comma-separated `scope`, `token_type: Bearer`. The authorization `code` "should be URL decoded" before exchange; `redirect_uri` "must be the same as the redirect_uri used for requesting code"; `code_verifier` is "Required for mobile and desktop app only". Refresh rotation: "The returned refresh_token may be different than the one passed in the payload. You must use the newly-returned token if the value is different than the previous one." Revoke takes `client_key`, `client_secret`, `token` (the access token) and returns an empty body on success.

#### 4.2.2 Shape 2 — data endpoints (`{data, error}` envelope; success iff `error.code === "ok"`)

Display API surface (S10):

| `error.code` | HTTP | MCP recovery action |
|---|---|---|
| `ok` | 200 | Success |
| `invalid_params` (plural) | 400 | Non-retryable `VALIDATION_ERROR`; should be prevented by client-side validation |
| `access_token_invalid` | 401 | Attempt one token refresh, replay once; if still failing → `AUTH_ERROR`, prompt re-login. (S10: "Please refresh the token and retry.") |
| `scope_not_authorized` | 401 | Non-retryable `SCOPE_ERROR`: user did not grant the scope → re-consent flow |
| `scope_permission_missed` | 400 | Same as above (missing scope on request) → re-consent flow |
| `invalid_file_upload` | 400 | Non-retryable; report file problem |
| `rate_limit_exceeded` | 429 | Retryable: token-bucket backoff, honor sliding-window minute (S11), then retry |
| `internal_error` | 500 | Retryable with exponential backoff + jitter, bounded attempts |

Content Posting API surface (S5, S6, S7 — same envelope, different codes):

| `error.code` | HTTP | Endpoint(s) | MCP recovery action |
|---|---|---|---|
| `invalid_param` (singular) | 400 | all CPA | Non-retryable `VALIDATION_ERROR` ("Check error message for details.") |
| `app_version_check_failed` | 400 | photo init | Non-retryable; message: user's TikTok app "must not be less than 31.8" for MEDIA_UPLOAD (S6) — user must update their TikTok mobile app |
| `spam_risk_too_many_posts` | 403 | init | Non-retryable today: "The daily post cap from the API is reached for the current user." → report cap (~15/day per creator, S9), suggest retry tomorrow; do NOT auto-retry |
| `spam_risk_user_banned_from_posting` | 403 | init | Non-retryable, terminal for this account; surface clearly |
| `spam_risk_too_many_pending_share` | 403 | photo/inbox init | Non-retryable now: "There may be at most 5 pending shares within any 24-hour period" (S6) → advise user to complete/publish pending drafts, retry later |
| `reached_active_user_cap` | 403 | init | Non-retryable now: "The daily quota for active publishing users from your client is reached." (unaudited: 5 users/24 h, S9) → app-level cap, not user error |
| `unaudited_client_can_only_post_to_private_accounts` | 403 | init | Non-retryable: account must be private while client is unaudited (S9) → actionable message: set account private or complete audit |
| `url_ownership_unverified` | 403 | PULL_FROM_URL init | Non-retryable: domain/prefix not verified → point to §4.3 workflow |
| `privacy_level_option_mismatch` | 403 | init | Non-retryable: chosen `privacy_level` not in this creator's `privacy_level_options` → re-query creator_info, re-prompt user |
| `invalid_publish_id` | 400 | status/fetch | Non-retryable; if journal knows the ID → "status no longer available, see journal" (§3.3) |
| `token_not_authorized_for_specified_publish_id` | 400 | status/fetch | Non-retryable: publish_id belongs to a different user token → internal bookkeeping error, check journal/account mapping |
| `access_token_invalid` | 401 | all | One refresh + single replay (init is safe to replay only if no publish was created — replay the *request*, never assume side effects; see probe P-5) |
| `scope_not_authorized` | 401 | all | Re-consent with `video.publish` / `video.upload` as needed |
| `rate_limit_exceeded` | 429 | all | Backoff per §4.4 budgets, retry |
| `internal_error` | 5xx | all | Retryable with backoff |

#### 4.2.3 Publish `fail_reason` values (status/fetch, S7) — post-mortem mapping

| `fail_reason` | MCP action |
|---|---|
| `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed` | Non-retryable media validation failure → report the specific constraint (§4.1.4) so the user can transcode |
| `internal` | **Officially retryable** — S7: "This is a retryable error." → the MCP server may offer a re-publish (new init, new publish_id) |
| `video_pull_failed`, `photo_pull_failed` | Source URL unreachable/expired during the 1-hour pull window (S4) → check URL availability, re-init |
| `publish_cancelled` | User cancelled in-app → informational |
| `auth_removed` | User revoked app access mid-publish → `AUTH_ERROR`, re-login required |
| `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk` | Non-retryable moderation outcomes; `spam_risk_text` → suggest editing caption; generic `spam_risk` → do not auto-retry |

status/fetch also returns `publicaly_available_post_id` (list of int64 — note TikTok's own misspelling "publicaly", copy it exactly) "returned only if the post is published for public viewership", plus `uploaded_bytes` (FILE_UPLOAD) and `downloaded_bytes` (PULL_FROM_URL) progress counters.

#### 4.2.4 Shape 3 — upload PUT responses (raw HTTP, no JSON envelope; S4)

| HTTP | Meaning (verbatim gist) | MCP recovery action |
|---|---|---|
| 201 | "All parts are uploaded. TikTok will start the posting process." | Upload complete → begin status polling |
| 206 | "The current chunk has been successfully processed. There are additional chunks yet to be uploaded." | Continue with next sequential chunk |
| 400 | "Malformated request headers, or BYTE_SIZE_OF_THIS_CHUNK does not reflect the true byte size" | Non-retryable → bug in chunk planner; abort, report |
| 403 | "The upload_url has expired" | Non-retryable on this URL → re-init (new publish_id), restart upload |
| 404 | "TikTok cannot find a valid upload task" | Re-init required |
| 416 | "Content-Range does not reflect the actual upload progress" | Resynchronize: consult last successful response's `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL}` header and/or status/fetch `uploaded_bytes`, then resume from the correct offset (see §5.2) |
| 5xx | "Gateway connection error or TikTok Internal error. **You should retry submitting this chunk**" | **Officially retryable** → bounded retries with backoff of the SAME chunk PUT |

The 5xx row is TikTok's explicit instruction and **contradicts the current design's blanket "no auto-retry for uploads"** — see Finding R2-2 and amendment A-2.

### 4.3 PULL_FROM_URL domain verification — workflow and consequence matrix

#### 4.3.1 Workflow (S4)

1. Developer portal → your app page → **"URL properties"** button (top of page).
2. Switch to **Production mode** first — S4: "Ensure you are verifying properties for your app in Production mode, then click Verify properties." (Properties verified in sandbox do not carry.)
3. Choose property type:
   - **Domain** (recommended, covers all URLs on the domain/subdomain): "add a signature string to the domain's DNS records" (TXT record), then Verify. Subject to DNS propagation delay (minutes to 48 h; TikTok documents no SLA).
   - **URL prefix**: prefix must be `https://` + host + path + trailing `/`. Download the signature file, upload it to your server under that prefix, then Verify.
4. Prefix matching semantics (S4, verbatim example): verified `https://example.com/videos/user/` covers `https://example.com/videos/user/123/example.mp4` but **not** `https://example.com/videos/2023/user/123/example.mp4`.
5. Scope of the requirement: "All apps that use the Content Posting API upload URL or the Link Sharing URL must verify these URLs, regardless of when the app was created."
6. Runtime constraints on the pulled URL (S4): HTTPS only; **redirects are not followed**; the URL "must remain accessible for the entire duration of the download process, which times out one hour after the download task is initiated."

#### 4.3.2 Practical consequence matrix for photo posting (photos have NO FILE_UPLOAD path, S6)

| Source the user wants to post | Works? | Why / what the MCP server should say |
|---|---|---|
| Local file on disk | **No** (photos) | No FILE_UPLOAD for photos. Server must respond with the remediation: upload the file to a verified domain/prefix first. (Videos: use FILE_UPLOAD instead.) |
| Arbitrary web URL (Unsplash, another site) | **No** | `url_ownership_unverified` — you cannot verify a domain you don't control |
| Operator's own domain, verified (Domain method) | **Yes** | Any path on the domain; HTTPS, no redirects, ≤ 20 MB, ≤ 1080p, JPEG/WebP, reachable for 1 h |
| Operator's own domain, verified prefix only | **Yes, if** the full URL starts with the exact verified prefix (path-segment-exact, see 4.3.1.4) |
| S3/GCS presigned URL | **Only if** the bucket hostname (e.g. `bucket.s3.amazonaws.com`) or a prefix on it is verified — normally impossible on shared cloud hostnames you don't control at DNS level; use a CNAME'd custom domain instead. Query strings do not affect prefix matching (prefix is host+path), so signed query params are fine on a verified host |
| CDN URL that 30x-redirects to origin | **No** | Redirects are not followed |

**Design consequence (unchanged from round 1, now with full mechanics):** photo posting is unusable without operator-owned, TikTok-verified hosting. CONFIGURATION.md must carry a `media.pull_base_url` operator setting plus a setup guide referencing this workflow (amendment A-6).

### 4.4 Rate-limit table (completed)

| Endpoint | Limit | Dimension | Source |
|---|---|---|---|
| `POST /v2/post/publish/video/init/` (direct post) | 6 req/min | per user access token | S5 |
| `POST /v2/post/publish/inbox/video/init/` (upload/inbox) | 6 req/min | per user access token | round-1 verified (upload reference) |
| `POST /v2/post/publish/content/init/` (photo) | 6 req/min | per user access token | S6 |
| `POST /v2/post/publish/creator_info/query/` | 20 req/min | per user access token | S8 |
| `POST /v2/post/publish/status/fetch/` | 30 req/min | per user access token | S7 |
| `GET /v2/user/info/` | 600 req/min | sliding 1-min window; dimension not stated (assume per app; probe P-8) | S11 |
| `POST /v2/video/list/` | 600 req/min | same | S11 |
| `POST /v2/video/query/` | 600 req/min | same | S11 |
| Chunk PUT to `upload_url` | no documented limit | — | S4 (silent) |

S11: "Request rate calculation is based on a one minute sliding window"; on exceed: HTTP 429 + `rate_limit_exceeded`; higher limits by request via the Support Page.

Business-level caps that behave like rate limits but are NOT 429s (all 403 `error.code`s, §4.2.2):

| Cap | Value | Dimension | Source |
|---|---|---|---|
| Active publishing users | 5 users / 24 h (unaudited) | per API client (app) | S9 ("Unaudited API Clients can allow up to 5 users to post in a 24 hour window") |
| Daily posts per creator | "typically around 15 posts per day/creator account", shared across ALL API clients posting for that creator | per creator account | S9 |
| Pending shares | max 5 pending within any 24-hour period | per creator account | S6 |

**Token-bucket design:** per-user-token buckets at 6/min (init), 20/min (creator_info), 30/min (status); creator_info result may be cached ≤ a few minutes for validation reuse but MUST be re-queried when rendering the posting plan (S8: "When rendering the Export to TikTok page, your app must invoke the API and use the latest creator information returned"; `creator_avatar_url` TTL is 2 h). Status polling at 30/min allows a 2-second minimum poll interval; recommended schedule: 2 s → 5 s → 10 s with jitter, well inside budget.

---

## 5. Answers to cross-role platform questions

### 5.1 Loopback redirect exactness (architecture Q1)

S1, verbatim rules for desktop redirect URIs:

- "Only `localhost` or loopback IP `127.0.0.1` are allowed host names in URI" — **both** are permitted.
- "URIs must be absolute and begin with `https` or `http`" — plain `http` is allowed for loopback.
- "URIs must have a port number, and wildcard port number (*) is supported" — register `http://127.0.0.1:*/callback/` and bind any ephemeral port at runtime.
- "URIs must be static. Parameters or fragment CANNOT be appended to the URI."
- Max 10 URIs per app, each < 512 chars.
- Valid examples given: `http://localhost:3455/callback/`, `http://127.0.0.1:*/callback/`, `https://127.0.0.1:3455/callback/` — note the **trailing slash** in every official example.

**Prescription:** register `http://127.0.0.1:*/callback/` (prefer 127.0.0.1 over localhost to avoid resolver tricks — consistent with the security review); at runtime send `redirect_uri=http://127.0.0.1:{port}/callback/` **with the trailing slash**, byte-identical in the authorize request and the token exchange (S2: redirect_uri "must be the same as the redirect_uri used for requesting code"). IPv6 `::1` is not mentioned — do not use it.

### 5.2 Re-PUT semantics of an already-accepted chunk range (architecture Q6)

What is documented (S4):

- 5xx on a chunk PUT: "You should retry submitting this chunk" — same-chunk retry is official.
- 416 means "Content-Range does not reflect the actual upload progress" — i.e., the server tracks progress and rejects ranges that don't line up.
- Every successful upload response carries `Content-Range: bytes 0-{UPLOADED_BYTES}/{TOTAL_BYTE_LENGTH}` — server-side progress is readable from the last response.
- status/fetch returns `uploaded_bytes` — progress is also queryable out-of-band at 30/min.
- "File chunks must be uploaded sequentially" — no parallel PUTs.

**Resume algorithm after an ambiguous outcome** (timeout / connection reset mid-PUT):

1. Query status/fetch → read `uploaded_bytes`.
2. If `uploaded_bytes` covers the chunk just sent → it was accepted; continue with the next chunk.
3. If not → re-PUT the same chunk (officially sanctioned for 5xx-class failures).
4. If a re-PUT returns 416 → the range was already recorded; re-read progress and advance.

What remains unverified: whether a re-PUT of a fully-accepted range returns 416, 206 (idempotent accept), or something else — probe P-2 (§7).

### 5.3 Do inbox drafts expire? — **UNDOCUMENTED**

No primary page states a TTL for inbox-shared (draft) content. Indirect signal: the "5 pending shares within any 24-hour period" cap (S6) implies pending state persists on at least a 24-hour scale, but persistence ≥ cap window is an inference, not a fact. **Design stance:** the `post_video_draft` tool output must tell the user to open TikTok and complete the draft promptly; the journal records the share as `SEND_TO_USER_INBOX` complete, making no claim about draft longevity. Probe P-7.

### 5.4 The 5-pending-shares / 24 h cap — details

S6: error `spam_risk_too_many_pending_share` (403): "There may be at most 5 pending shares within any 24-hour period." Per creator account; "pending" = shared to inbox but not yet completed/published by the user in-app. Combined with §5.3: heavy draft-mode use hits this fast — the MCP server should count inbox shares per account per rolling 24 h in the journal and warn at 4.

### 5.5 Region (UnitedStates/Europe) differences for a solo developer

Documented facts only:

- App creation (S13) has **no region selector**; no per-region Direct Post availability matrix is published anywhere.
- A **regional upload host exists** (`upload.us.tiktokapis.com`, S4) — regionality is real at the infrastructure level; handle via URL opacity + suffix allowlist (§2.4).
- The Research API is restricted to US/EU academics — irrelevant to this project but shows TikTok does gate by region per-product.
- For a Bulgaria-based (EEA) solo developer: GDPR applies to the operator as controller of the stored tokens/journal; the design's local-only storage minimizes exposure. No TikTok-side EEA-specific developer gate is documented for Login Kit / Display / Content Posting.
- Round-1 stance stands: treat unexplained publish failures as possibly regional; verify with the operator's own account in sandbox (probe P-9).

### 5.6 Minor and private accounts

- **Private accounts** (S8): `privacy_level_options` for private accounts = `{FOLLOWER_OF_CREATOR, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY}` (public accounts get `PUBLIC_TO_EVERYONE` instead of `FOLLOWER_OF_CREATOR`); `duet_disabled`/`stitch_disabled` are "true if the creator account is private or they set … to 'No one'". While the client is unaudited, ALL posting accounts must be private anyway (S9).
- **Minors:** there is no API-level minors documentation. Enforcement is implicit: TikTok simply narrows `privacy_level_options` and interaction abilities for such accounts, and the server's rule "creator_info is the source of truth, offer only what it returns" handles this automatically with no age logic on our side. Branded content is 18+ per the Branded Content Policy (S15) — app-level enforcement by TikTok, not ours.
- **Design rule:** never hardcode the privacy-option list; always render from the fresh creator_info response (also an audit UX requirement, S9: manual selection, "no default value").

### 5.7 Audit process — concrete requirements, demo video, timeline, rejection reasons

Requirements (S12, S13, S9):

1. Valid Privacy Policy **and** Terms of Service "visible on your official website"; a valid official website; app name custom, matching your site, no TikTok-confusable branding.
2. Per-product/per-scope justification text in the review form.
3. Demo videos: up to **5 videos, 50 MB each**, showing "the complete end-to-end flow of the up-to-date integrations"; "Clearly show the user interface and user interactions"; "All selected products and scopes must be clearly demonstrated in the video."
4. Content Posting audit additionally checks S9 UX rules: privacy level manually chosen with "no default value"; interaction toggles (comment/duet/stitch) "none should be checked by default"; commercial-content toggle "turned off by default"; music-usage confirmation wording ("By posting, you agree to TikTok's Music Usage Confirmation"; branded → "Branded Content Policy and Music Usage Confirmation"); branded-content-vs-private rule (§2.3).
5. Documented rejection classes (S12): incomplete information; adult content; apps "still in development or testing"; mismatched domain/app names.
6. Timeline: **not documented officially.** Secondary sources (getphyllo, mixpost, postproxy — flagged as secondary) report 3–5 business days for a clean pass, 2–4 weeks with feedback rounds.

**MCP-specific risk:** the demo-video checklist assumes a GUI. For a headless MCP server, the "user interface" is the MCP client conversation plus the plan-preview/apply step. The demo recording must show, in an MCP client (e.g. Claude Desktop or Inspector): creator_info being fetched and displayed, the user manually choosing privacy from the returned options (no default), toggles defaulting to off, the music-confirmation text in the plan preview, and the explicit apply/consent step. Whether TikTok reviewers accept a conversational UI as "the user interface" is untested — expect at least one feedback round; keep sandbox + private-account SELF_ONLY mode as the fallback operating state (it requires no audit).

### 5.8 Sandbox (architecture Q11 — resolved)

S14 + S13: sandbox is "a restricted environment that allows you to try out integrations without having to submit your app for review"; it is the default for new apps; up to **5 sandboxes per app**, up to **10 target users per sandbox** (added via Sandbox settings → Target users → Add account; must be TikTok accounts the developer controls that agree to the Developer ToS). Restriction: "Sandbox mode does not offer access to Content Posting API for public videos or Data Portability API" — i.e., in sandbox you can exercise the full flow only to private visibility. **Phase-2 exit gate wording should be:** "all probes pass in sandbox against a target-user account, posting with SELF_ONLY" — public-visibility posting is only testable in Production after audit.

---

## 6. New findings and spec amendments

### 6.1 New findings

**Finding R2-1 — Regional upload host breaks a pinned egress allowlist.**
Severity: **HIGH**. Issue: S4 shows `upload.us.tiktokapis.com` while S3 shows `open-upload.tiktokapis.com`; the current SECURITY.md egress allowlist pins fixed hostnames. Impact: FILE_UPLOAD fails closed the first time TikTok issues a regional URL. Recommendation: suffix rule `*.tiktokapis.com` for the upload leg; treat `upload_url` as opaque. (Refs: S3, S4; §2.4.)

**Finding R2-2 — Official chunk-PUT 5xx retry guidance contradicts the design's "no auto-retry for uploads".**
Severity: **HIGH**. Issue: S4 explicitly says for 5xx "You should retry submitting this chunk"; ARCHITECTURE.md's retry matrix currently forbids automatic retry on the upload leg. Impact: large uploads become needlessly fragile; a single transient 502 aborts a 4 GB upload. Recommendation: amend the retry matrix — chunk PUT 5xx: bounded same-chunk retries with backoff; 416: resync via progress (§5.2); 400/403/404: abort (re-init for 403/404). Init/publish POSTs keep the conservative no-auto-retry rule. (Refs: S4; §4.2.4, §5.2.)

**Finding R2-3 — `invalid_param` vs `invalid_params`: two spellings on two API surfaces.**
Severity: **MEDIUM**. Impact: an error mapper matching only one spelling silently misclassifies the other as UNKNOWN. Recommendation: normalize both to `INVALID_ARGUMENT`; add both to the taxonomy test. (Refs: S5–S7 vs S10; §3.1.)

**Finding R2-4 — OAuth endpoints use a flat error shape, not the `{data, error}` envelope.**
Severity: **MEDIUM**. Issue: `{error, error_description, log_id}` (S2) — a response parser expecting the envelope on token/revoke calls will crash or misread. Recommendation: two parsers selected by endpoint class; taxonomy tests for both. (Refs: S2; §4.2.1.)

**Finding R2-5 — `app_version_check_failed` (photo MEDIA_UPLOAD requires TikTok app ≥ 31.8).**
Severity: **LOW**. A user-device precondition surfaced as a 400; needs a human-actionable message ("update the TikTok app on your phone"). (Refs: S6; §4.2.2.)

**Finding R2-6 — status/fetch has publish-scoped auth errors and a misspelled field.**
Severity: **LOW**. `invalid_publish_id` and `token_not_authorized_for_specified_publish_id` (S7) need distinct handling (§4.2.2); the public-post ID field is spelled `publicaly_available_post_id` — copy TikTok's misspelling exactly or the field reads as absent. (Refs: S7.)

**Finding R2-7 — Sandbox cannot post publicly; audit demo needs Production.**
Severity: **MEDIUM**. Issue: "Sandbox mode does not offer access to Content Posting API for public videos" (S14), while the audit demo must show the full flow. Impact: the demo video has to be shot against an unaudited Production app (SELF_ONLY, private account) — plan the recording flow accordingly. (Refs: S14, S12, S9; §5.7, §5.8.)

**Finding R2-8 — Display API quota is generous (600/min sliding window) and increase is by support request.**
Severity: **LOW**. 600/min for user/info, video/list, video/query (S11) removes any need for aggressive Display-API throttling; keep a modest client-side ceiling and map 429 → backoff. (Refs: S11; §4.4.)

### 6.2 Spec amendments (ordered, concrete)

1. **A-1 (SECURITY.md, CONFIGURATION.md):** change the egress allowlist upload entry to suffix match `*.tiktokapis.com`; add "upload_url is opaque — never rebuild it"; extend the redaction rule to `upload_token` in any URL. (Finding R2-1)
2. **A-2 (ARCHITECTURE.md):** rewrite the retry-matrix upload row per Finding R2-2: chunk PUT 5xx → bounded same-chunk retry; 416 → resume via `uploaded_bytes`; 403/404 → re-init; init/publish POST → no auto-retry (unchanged).
3. **A-3 (TIKTOK-API.md):** replace the error section with the three-shape catalog of §4.2 verbatim (OAuth flat shape; envelope codes incl. both `invalid_param(s)` spellings; upload PUT HTTP table; full `fail_reason` list with the `internal`-is-retryable note).
4. **A-4 (TIKTOK-API.md):** add the chunk algorithm and constants of §4.1.2 (CHUNK_SIZE = 64,000,000; whole-file < 5,000,000; floor-merge final chunk; 1000-chunk invariant) and the V1–V8 vector table.
5. **A-5 (AUTH.md):** state both allowed loopback hosts and prescribe `http://127.0.0.1:*/callback/` registration + trailing-slash byte-identical `redirect_uri` in authorize and token calls; note `code` must be URL-decoded; PKCE hex rule already present from round 1.
6. **A-6 (CONFIGURATION.md):** add `media.pull_base_url` and a "Domain verification" operator guide condensed from §4.3 (Production-mode caveat included).
7. **A-7 (TOOLS.md):** add validation rules — reject `brand_content_toggle` + `SELF_ONLY` with the S9 tooltip text; per-media caption limits (photo 90/4000, video 2200, UTF-16 units); photo source = URL only with remediation text; count inbox pending shares in the journal and warn at 4/5. (§2.2, §2.3, §4.3.2, §5.4)
8. **A-8 (TOOLS.md, ARCHITECTURE.md):** map `invalid_publish_id` on known IDs to "see journal"; persist terminal status + `publicaly_available_post_id` immediately (§3.3, R2-6).
9. **A-9 (ROADMAP.md):** re-word the Phase-2 exit gate per §5.8 (sandbox = target users, SELF_ONLY only); add the audit-prep work item with the §5.7 checklist incl. MCP demo-video plan.
10. **A-10 (TESTING.md):** add mandatory table-driven tests: V1–V8 chunk vectors; PKCE hex vector; error-taxonomy fixtures for all three shapes incl. both `invalid_param(s)` spellings and the `publicaly_available_post_id` spelling.
11. **A-11 (TIKTOK-API.md):** complete the rate-limit table per §4.4 including the three business caps and the 30/min-derived polling schedule.

---

## 7. Remaining unknowns (each with the sandbox probe that answers it)

| # | Unknown | Probe |
|---|---------|-------|
| P-1 | status/fetch retention window for a `publish_id` | Publish in sandbox; query at +1 h, +24 h, +48 h, +7 d; record when `invalid_publish_id` begins |
| P-2 | Response to re-PUT of an already-accepted chunk range | Upload V6 (2 chunks); after chunk 1's 206, re-PUT chunk 1 byte-identically; record status (416 vs 206 vs other) and whether the upload still completes with 201 |
| P-3 | Refresh-token rotation grace (is the old refresh_token usable after rotation returns a new one?) | Refresh once, then attempt a second refresh with the OLD token; record error; verify the error shape is the flat OAuth shape |
| P-4 | Out-of-scope user-info field: hard error vs silent omission | Token with `user.info.basic` only; request `follower_count`; record whether it's 400 `scope_permission_missed` or 200 with the field omitted |
| P-5 | Does a 401 on video init ever occur AFTER task creation (side effect before auth failure)? | Init with an expired access token; confirm no publish_id/pending share was created (status of pending count before/after) |
| P-6 | API behavior for `brand_content_toggle: true` + `privacy_level: SELF_ONLY` | Send exactly this init in sandbox; record error code (expected `invalid_param` or `privacy_level_option_mismatch`) or acceptance |
| P-7 | Inbox draft TTL | Send an inbox share to a target user; do not complete it; check in-app visibility at +24 h, +72 h, +7 d; also observe when the pending-share counter frees |
| P-8 | Dimension of the 600/min Display quota (per app vs per token) | Two target-user tokens; drive user/info to 429 on token A; immediately call with token B; if B also 429s, the quota is per app |
| P-9 | Regional behavior of Direct Post for an EEA developer + which upload host is issued | Run the full FILE_UPLOAD flow from the EEA operator account; record the `upload_url` hostname and any region-specific failures |
| P-10 | Whether MEDIA_UPLOAD (inbox) counts against the unaudited 5-active-users/24 h cap the same way direct post does | With 5 distinct target users having posted via direct post, attempt an inbox share from a 6th; record `reached_active_user_cap` presence |

All ten probes are runnable inside one sandbox with ≤ 3 target-user accounts, except P-9's public-visibility aspect (Production only, per Finding R2-7).

---

*End of round-2 review. Round-1 findings 1–12 remain in force except where amended above (notably the upload-retry rule, Finding R2-2).*
