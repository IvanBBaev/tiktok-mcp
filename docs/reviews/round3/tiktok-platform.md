# Round 3 — TikTok platform integration review

Date 2026-10-29 · Commit 301b9bb · Reviewer: senior TikTok for Developers integration specialist (Login Kit, Display API, Content Posting API, app review, webhooks, oEmbed) · Scope: `src/api/*.ts`, `src/tools/publish-*.ts`, the webhook receiver, `docs/TIKTOK-API.md`, `docs/AUDIT.md`, `docs/SETUP-TIKTOK-APP.md`, `docs/probes/PROBE-LOG.md`, ROADMAP B1/B2-SPIKE/B2/B3. TikTok sources were re-read live; all of them were accessed on 2026-10-29.

## Verdict

At the wire level the integration is careful. Endpoints, scopes, the PKCE flavour, chunk math, error envelopes and the known TikTok misspellings mostly match what TikTok documents today. That holds for code that has **never sent one request to TikTok**: all fourteen live probes are `not run` (`docs/probes/PROBE-LOG.md:12-13`). The product's headline value is public posting through the audit, and that is where the work is weakest. Against today's guidelines the audit playbook would fail on the first submission:

- the interaction toggles default to *allowed*, which reverses the guideline's "none should be checked by default";
- there is no content preview;
- the demo is planned on production, but TikTok now requires sandbox for never-approved apps;
- the bring-your-own-app model collides with "Apps must not be for private or personal use".

There are also four smaller drifts, which nothing would surface until a live run:

- webhook event spelling;
- photo `is_aigc` placement;
- oEmbed deprecation;
- the commercial-content labels.

**Score: 4/10.** The wire contract is good (it would be about 7/10 alone). Audit readiness is about 2/10 and there is no empirical evidence at all.

## What is strong

- **Login Kit (desktop).** Hex-encoded SHA-256 PKCE, S256, the wildcard-port loopback redirect `http://127.0.0.1:*/callback/` and comma-joined scopes all match https://developers.tiktok.com/doc/login-kit-desktop (accessed 2026-10-29).
- **FILE_UPLOAD chunk math.** It matches https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide (accessed 2026-10-29):
  - minimum whole-file size 5 MB, chunk size 64 MB, final chunk ≤ 128 MB, 1–1000 chunks, floor-merge of the remainder (`src/api/upload.ts:47-64`, `:111-157`, floor at `:137`);
  - 201/206/416 handling, with a Content-Range resync on 416 (`src/api/upload.ts:625-781`).
- **The envelope rule is correct.** Success means `error.code === "ok"`, so non-ok codes returned on HTTP 200 are caught. That matters for creator_info's `spam_risk_*` and `reached_active_user_cap`, which TikTok returns with HTTP 200. These map to remediation text (`src/mcp/errors.ts:157-184`).
- **`log_id` is read defensively** (`src/core/http.ts:1317-1318`).
- **TikTok's known spellings are handled:**
  - `publicaly_available_post_id`, with a fallback to the correct spelling;
  - both `invalid_param` and `invalid_params` (R2-3);
  - the flat OAuth error shape (R2-4).
- **privacy_level has no default.** A missing level is `plan_incomplete` (`src/tools/publish-write.ts:404`, `:421`, `:605-615`, `:690`).
- **branded + SELF_ONLY is refused before the call** (`src/api/publish.ts:117`).
- **Display API.** The field lists and the 20-item page and query caps match the reference (`src/api/user.ts`, `src/api/video.ts:42`).
- **Webhook signature.** `t=…,s=…` with HMAC-SHA256 over `${t}.${rawBody}`, a timing-safe compare and a 300 s tolerance matches https://developers.tiktok.com/doc/webhooks-verification (accessed 2026-10-29).

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| PLT-01 | Critical | The audit is structurally unlikely to pass for the bring-your-own-app model. Each user's app is a private/personal-use app with a placeholder site and policies, and possibly a TikTok-referencing name. | `docs/SETUP-TIKTOK-APP.md:3-6`, `:56-70`; `docs/AUDIT.md:9-22`; the guidelines (see detail) | Reframe public posting as "possible, not promised". Document the submitter's own-product requirements. Decide whether the project itself should operate one audited app. |
| PLT-02 | Critical | The demo-video plan contradicts today's rules. AUDIT.md says shoot on unaudited production, but TikTok now says a never-approved app must demo in sandbox. | `docs/AUDIT.md:187`; `docs/probes/PROBE-LOG.md:22-24`; round-2 R2-7 | Rewrite AUDIT.md § 4 for a sandbox demo with SELF_ONLY. Retire R2-7. |
| PLT-03 | High | The interaction toggles default to *allowed* (`disable_*=false`). TikTok requires "none should be checked by default". The spec and the audit shot list both bake in the misreading. | `src/api/publish.ts:379-399`, `:436-441`; `docs/TIKTOK-API.md:709`; `docs/AUDIT.md:307` | Default `disable_comment/duet/stitch` to `true` unless the user opts in, or require an explicit choice. Fix both docs and the tests. |
| PLT-04 | High | No content preview and no "processing can take a few minutes" notice. The guidelines require both; the "preview" is only the plan JSON. | grep for a media preview or processing notice in `src/tools/publish-*.ts` finds nothing; `docs/AUDIT.md` § 4.3 | Add a media preview (cover/thumbnail URL or local-file summary plus title) and the processing notice to the plan/apply output. Add both to the shot list. |
| PLT-05 | High | Zero live exercise. P-1..P-14 are `not run`, and the riskiest assumptions (P-2/P-11 upload resync, P-13 photo fields, P-4, P-12) decide whether posting works at all. | `docs/probes/PROBE-LOG.md:12-13` | Run the RUNBOOK session in sandbox before calling anything 1.0 for posting. |
| PLT-06 | Medium | Webhook event spelling. TikTok documents `post.publish.no_longer_publicaly_available`; the code only knows the correct spelling, so the event is treated as unknown. | `src/api/webhook.ts:33`; `docs/TIKTOK-API.md:750` | Accept both spellings and normalise to one internal name. |
| PLT-07 | Medium | Photo `is_aigc` is sent inside `post_info`. The photo-post reference lists it as a top-level body field, so the AI label may be silently dropped. | `src/api/publish.ts:446`, body at `:768-774` | Move it to the top level, or send both, behind P-13. |
| PLT-08 | Medium | The commercial-content UX deviates from the guideline: no "Paid partnership" or "Promotional content" label, and the consent line adds Branded Content Policy for "Your brand" only. Wording is "By approving…", not "By posting, you agree…", with no links. | `src/tools/publish-common.ts:638-642` | Branded Content Policy wording only when `brand_content_toggle`. Add the label strings and the policy links. Require at least one sub-option when disclosure is on. |
| PLT-09 | Medium | oEmbed ("Embed Videos") is announced for deprecation in favour of Embed Player, and A11 was just built on it. The answer type also omits `embed_product_id` and `embed_type`. | `src/api/embed.ts:31`; https://developers.tiktok.com/doc/embed-videos | Mark the tool deprecated-upstream in TOOLS.md. Plan an Embed Player variant (it is a client-side iframe, so mostly a URL builder). |
| PLT-10 | Medium | AUDIT.md is stale and second-hand. It cites version 0.8.0 while package.json says 1.0.0, it says nobody has read the live form, and § 3 is a round-2 transcription. | `docs/AUDIT.md:9-22`, `:207-214` | Re-transcribe from the live guidelines with access dates and fix the version. |
| PLT-11 | Medium | Photo DIRECT_POST vs MEDIA_UPLOAD field set. `disable_comment`, `auto_add_music` and the brand toggles are DIRECT_POST-only per the reference, but `resolvePhotoPostInfo` builds them regardless of mode. | `src/api/publish.ts:436-446` | Strip the DIRECT_POST-only fields for MEDIA_UPLOAD (unverified whether TikTok rejects or ignores them; P-13). |
| PLT-12 | Low | The webhook parser requires `user_openid`. TikTok's `portability.download.ready` example omits it, so the receiver answers 400 and TikTok retries for 72 h. | `src/api/webhook.ts:130`; `src/mcp/webhook.ts:311-318` | Treat `user_openid` as optional and return 200 for well-signed unknown or partial events. |
| PLT-13 | Low | Legacy events (`video.upload.failed`, `video.publish.completed`) carry `share_id`, not `publish_id`. | `src/api/webhook.ts:160-162` | Fall back to `share_id`. |
| PLT-14 | Low | `MAX_FILE_BYTES` is 4 GiB; TikTok says "4GB". Files between 4e9 and 4.29e9 bytes may be rejected upstream after a long upload. | `src/api/upload.ts:58` | Cap at 4_000_000_000 until a probe shows otherwise. |
| PLT-15 | Low | SETUP says "`127.0.0.1`, not `localhost`"; TikTok's desktop doc allows both. The unverified-domain error is named by the local catalog code, not TikTok's `url_ownership_unverified`. | `docs/SETUP-TIKTOK-APP.md:116`, `:248` | Fix the wording and name both codes. |
| PLT-16 | Low | A webhook needs a public HTTPS callback; a local stdio MCP needs a tunnel. Not checked for a doc mention (unverified). | https://developers.tiktok.com/doc/webhooks-overview | State the tunnel requirement and the "return 200 fast" rule in TOOLS/SETUP. |

### PLT-01 — The audit model is at odds with TikTok's app review guidelines

- **What:** https://developers.tiktok.com/doc/app-review-guidelines (updated 2026-08-04, accessed 2026-10-29) includes these rules:
  - "Apps must not be for private or personal use".
  - The website must be a real product site, not a landing or login page, with privacy/terms links visible without opening a menu.
  - The app name must not reference social media companies.
  - Only request the scopes the app needs.

  This server has no app of its own: every user registers **their own** app (`docs/SETUP-TIKTOK-APP.md:3-6`) and must write their own policies (`:56-70`). Each such app is, by construction, one person using it on their own account. That is exactly the rejected class. The project's own policy pages 404 because Pages is off (G-4).
- **Why it matters:** public posting is the main reason to install the Content Posting package. Without an audit pass, every user is limited to SELF_ONLY posts, a private account and 5 users/24 h.
- **Failure scenario:** a user follows AUDIT.md, names the app "tiktok-mcp-ai demo", points the site at a GitHub README and submits. TikTok rejects it for personal use, the name and the site. AUDIT.md gives them no warning.
- **Fix:**
  1. Put an explicit "who can realistically pass" section at the top of AUDIT.md: an organisation or product with a real site, a non-TikTok name and an app that serves its users.
  2. In README/TOOLS, describe public posting as conditional.
  3. Owner decision: run one project-operated audited app (this changes the threat model, because the client secret is then shared), or keep BYO and accept that most users stay at SELF_ONLY.

### PLT-02 — The demo has to be shot in sandbox

- **What:** the same guidelines page says "If the app has not been approved before, a sandbox environment on the Developer Portal must be used" for the demo. `docs/AUDIT.md:187` and the probe-log rules (`docs/PROBE-LOG.md:22-24`) instruct the opposite, citing round-2 R2-7.
- **Why it matters:** the demo is the main artefact reviewers judge. Shooting it in the wrong environment is a rejection round.
- **Failure scenario:** the owner records five production clips and the review comes back asking for a sandbox demo. Days are lost per round, and the clips have to be reshot.
- **Fix:** rewrite AUDIT.md § 4.1 and § 4.3 for a sandbox demo, with a target user and SELF_ONLY. Remove the "unaudited production" guidance from PROBE-LOG.md, and mark R2-7 superseded with the URL and date.

### PLT-03 — The interaction toggles default to "allowed"

- **What:** https://developers.tiktok.com/doc/content-sharing-guidelines (updated 2026-08-04, accessed 2026-10-29) says: "Users must manually turn on these interaction settings and none should be checked by default." The settings are Allow Comment, Duet and Stitch. The code sends `disable_comment/duet/stitch = input ?? false` (`src/api/publish.ts:379-399`, photo at `:436-441`), so all interactions are **on** unless the caller says otherwise.
  - `docs/TIKTOK-API.md:709` turns "default to off" into `disable_*=false`.
  - `docs/AUDIT.md:307` puts `false` in the demo shot list as evidence of compliance.
  - Round 2 transcribed the rule correctly (§ 5.7 item 4); the misreading happened downstream.
- **Why it matters:** reviewers check exactly this, and the demo would show it on screen.
- **Failure scenario:** the reviewer sees `disable_comment: false` with no user choice in the plan preview, and the audit is rejected on content-sharing UX.
- **Fix:**
  1. Default all three toggles to `disable_*=true`, recorded in `derived[]` with the reason "interactions off until the user enables them".
  2. Respect `creator_info.*_disabled`.
  3. Update TIKTOK-API.md § 8, AUDIT.md § 4.3 and the tests.

  This is a behaviour change, so it needs a CHANGELOG entry.

### PLT-04 — No content preview and no processing notice

- **What:** the content-sharing guidelines say "API Clients should display a preview of the to-be-posted content". They also expect the user to be told that processing can take minutes, and that the post status be tracked. The plan output shows creator info, privacy and payload, but no media preview: no cover image URL, no thumbnail, no file name or size/duration summary (grep across `src/tools/publish-*.ts`). There is also no processing notice.
- **Why it matters:** this is another explicitly audited UX item, and an MCP client has to be *given* something it can render.
- **Failure scenario:** the reviewer asks "where does the user see what will be posted?" and the submission is rejected.
- **Fix:**
  1. Add a `preview` block to the plan output:
     - photos: the image URLs and the cover index;
     - pull-URL video: the URL;
     - FILE_UPLOAD: the file name, size, duration if known, and the title/description exactly as they will post.
  2. Optionally expose an `image` content item when the MCP client supports it.
  3. On apply, add "TikTok may take a few minutes to process; track with …".
  4. Add both to the shot list.

### PLT-05 — No empirical evidence

- **What:** every probe that needs a sandbox is `not run` (`docs/probes/PROBE-LOG.md:12-13`). These are the most likely to be wrong, in order:
  1. **P-11 / P-2: upload progress semantics.** TikTok calls `uploaded_bytes` "1-indexed" and a 206 returns a Content-Range. The 416 resync arithmetic at `src/api/upload.ts:645-781` assumes one interpretation. Off-by-one means a corrupt upload or an endless 416 loop.
  2. **P-13: photo body shape** (PLT-07, PLT-11). Wrong field placement means the label is silently dropped, or a 400.
  3. **P-4 / P-12: status and draft behaviour.** Inbox drafts' terminal state and publish_id lifetime are undocumented.
  4. **Regional upload host** (R2-1). This was fixed in code; still unverified live.
- **Fix:** run the RUNBOOK sandbox session once and record every result. Gate any "posting works" claim in README on it.

## Open questions for the owner

1. **Audit model:** stay BYO-app, where most users never pass the audit, or operate one project-owned audited app? The second needs a real product site, a shared-secret threat model and ongoing compliance.
2. **App name:** may docs keep suggesting names that contain "tiktok"? The npm name `tiktok-mcp-ai` is fine for npm. It is not fine as a TikTok app name.
3. **Interaction defaults:** is a silent behaviour change to `disable_*=true` acceptable before the first npm publish, or should callers be forced to choose explicitly?
4. **Embed tool (A11):** keep it on a deprecated upstream, replace it with an Embed Player URL builder, or remove it before release?
5. **B1 (Commercial Content API):** it needs a separate access application, is EU ad-library scoped, and is research/transparency oriented. Is that in scope for a personal MCP at all?
6. **B2-SPIKE (Business API):** TikTok API for Business requires a business developer registration and Business accounts. An individual can apply, but approval is discretionary. Unverified: I did not submit an application. Is the owner willing to apply under his own name?

## Proposed roadmap items

#### PLT-R1 — Default interaction toggles to off and fix the docs that misread the rule
Deps — · Status todo · Est 2 h

- **Scope:** **Release-blocking.**
  - `disable_comment/duet/stitch` default to `true` for video and photo DIRECT_POST unless the caller enables them; the defaults are recorded in `derived[]`.
  - Correct TIKTOK-API.md § 8 and AUDIT.md § 4.3, citing the guideline URL and access date.
  - Add a CHANGELOG entry.
- **Owns:** `src/api/publish.ts` (interaction resolution only)
- **Shared:** `docs/TIKTOK-API.md`, `docs/AUDIT.md`, `CHANGELOG.md`, publish tests
- **Acceptance:**
  - A plan with no toggle input shows `disable_*: true` and three `derived[]` entries.
  - An explicit `disableComment: false` is honoured.
  - The docs quote "none should be checked by default".
  - The gate is green.

#### PLT-R2 — Add a content preview, processing notice and commercial-content labels to publish output
Deps PLT-R1 · Status todo · Est 5 h

- **Scope:** **Release-blocking.** Add to the plan output:
  - a `preview` block (media URL(s), cover index, file name/size/duration, final title and caption);
  - the commercial label: "Paid partnership" for branded content, "Promotional content" for Your brand only.

  Also:
  - the apply result carries the processing notice and a status-tracking hint;
  - `consentLine` names Branded Content Policy only when `brand_content_toggle` is set, uses TikTok's "By posting, you agree to…" wording and includes the policy URLs;
  - a disclosure turned on with no sub-option selected is refused.
- **Owns:** `src/tools/publish-common.ts` (preview, consent, label helpers)
- **Shared:** `src/tools/publish-write.ts`, `src/tools/publish-photos.ts`, `docs/TOOLS.md`, tests
- **Acceptance:**
  - Snapshot tests show the preview for each of video FILE_UPLOAD, PULL_FROM_URL and photo.
  - The label strings appear exactly.
  - Brand-organic-only gives the Music-Usage-only line.
  - Apply text contains the processing notice.

#### PLT-R3 — Rewrite AUDIT.md against the live guidelines
Deps PLT-R1, PLT-R2 · Status todo · Est 3 h

- **Scope:** **Release-blocking** (the docs must not mislead at first release). Changes:
  - re-transcribe the content-sharing and app-review guidelines with access dates;
  - plan the demo in sandbox (retire R2-7);
  - add a "who can pass" section (no personal use, a real product site, a non-TikTok name, minimal scopes, policy links visible);
  - fix the 0.8.0 → current version reference;
  - rebuild the shot list for the preview, toggles-off, labels and processing notice.
- **Owns:** `docs/AUDIT.md`
- **Shared:** `docs/SETUP-TIKTOK-APP.md` (§ 1, § 3 localhost, § 8 error-code name), `docs/probes/PROBE-LOG.md` (Rules bullet)
- **Acceptance:**
  - Every requirement line has a URL and the 2026-10-29 (or later) date.
  - No "unaudited production" guidance remains.
  - The version matches package.json.

#### PLT-R4 — Run the sandbox probe session and record P-1..P-14
Deps — · Status blocked: owner (sandbox app + target-user account) · Est 4 h

- **Scope:** **Release-blocking** for any "posting works" claim.
  - Execute `docs/probes/RUNBOOK.md`, starting with P-11/P-2 (upload resync, `uploaded_bytes` indexing), P-13 (photo body shape), P-4 and P-12.
  - Record every outcome, failures included.
  - Open a contract-change entry for each contradiction.
- **Owns:** `docs/probes/PROBE-LOG.md`
- **Shared:** `docs/TIKTOK-API.md` Appendix A
- **Acceptance:**
  - Each P-1..P-14 has an entry or an explicit "blocked because…".
  - At least one real SELF_ONLY video post reaches `PUBLISH_COMPLETE`.
  - Redaction rules are followed.

#### PLT-R5 — Fix photo body shape: top-level is_aigc and mode-specific fields
Deps PLT-R4 (P-13) · Status todo · Est 2 h

- **Scope:**
  - Send `is_aigc` at the top level of `/v2/post/publish/content/init/` (per the photo-post reference); keep it in `post_info` only if P-13 shows it is read there.
  - Strip DIRECT_POST-only fields (`disable_comment`, `auto_add_music`, brand toggles) for MEDIA_UPLOAD.
- **Owns:** `src/api/publish.ts` (photo builder)
- **Shared:** `docs/TIKTOK-API.md` § 4.4, tests
- **Acceptance:**
  - The request-body snapshot for photo DIRECT_POST and MEDIA_UPLOAD matches the reference.
  - The P-13 entry is cited.

#### PLT-R6 — Harden webhook event parsing against TikTok's documented shapes
Deps — · Status todo · Est 2 h

- **Scope:**
  - Accept `post.publish.no_longer_publicaly_available` as an alias.
  - Make `user_openid` optional (portability events).
  - Fall back to `content.share_id` for legacy events.
  - Return 200 for well-signed unknown events.
  - Document the HTTPS tunnel requirement for local servers.
- **Owns:** `src/api/webhook.ts`
- **Shared:** `src/mcp/webhook.ts`, `docs/TIKTOK-API.md` § 10, `docs/TOOLS.md`, tests
- **Acceptance:**
  - Fixtures from TikTok's three doc examples parse.
  - The misspelled event routes to the same handler.
  - No 400 for a signed portability event.

#### PLT-R7 — Mark oEmbed as deprecated upstream and add an Embed Player option
Deps — · Status todo · Est 2 h

- **Scope:**
  - Record TikTok's deprecation notice for Embed Videos (https://developers.tiktok.com/doc/embed-videos) in TOOLS.md and TIKTOK-API.md.
  - Add the `embed_product_id`/`embed_type` fields.
  - Return an Embed Player URL alongside the oEmbed HTML.
- **Owns:** `src/api/embed.ts`
- **Shared:** `src/tools/` embed tool, `docs/TOOLS.md`, tests
- **Acceptance:**
  - The tool description states the deprecation.
  - The Player URL is built from the parsed video id.
  - Existing tests pass.

#### PLT-R8 — Align upload size cap and small doc drifts
Deps — · Status todo · Est 1 h

- **Scope:**
  - Set `MAX_FILE_BYTES` to 4_000_000_000 (decimal "4GB") until a probe shows otherwise.
  - SETUP: localhost is allowed (still recommend 127.0.0.1) and name `url_ownership_unverified` beside the local code.
- **Owns:** `src/api/upload.ts` (constant only)
- **Shared:** `docs/SETUP-TIKTOK-APP.md`, `docs/TIKTOK-API.md` § 4.6, the upload vectors
- **Acceptance:**
  - A file of 4_000_000_001 bytes is rejected before init with a clear message.
  - The V-vectors are updated.

#### PLT-R9 — Decide B1/B2 feasibility and record the access paths
Deps — · Status blocked: owner (apply for Business API / Commercial Content API access) · Est 2 h

- **Scope:**
  - Record the eligibility facts with URLs:
    - Commercial Content API: separate application, EU-scoped ad library, client-credentials;
    - Business API: a business developer registration and Business accounts.
  - Record the owner's application outcome, and decide GO or NO-GO for B1 and B2.
  - Supersedes B2-SPIKE's open-ended framing.
- **Owns:** a `docs/probes/PROBE-LOG.md` entry (B2-SPIKE)
- **Shared:** `docs/ROADMAP.md` (B1/B2 status)
- **Acceptance:**
  - The decision is recorded with the date and evidence.
  - B1 and B2 are either unblocked with known limits or moved to non-goals.

**Top recommendation:** before publishing 1.0 to npm, ship PLT-R1, PLT-R2 and PLT-R3, and run the sandbox probes (PLT-R4); today the posting path is both unproven and set up to fail TikTok's audit.
