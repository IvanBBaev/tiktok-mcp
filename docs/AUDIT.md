# The TikTok content-sharing audit

TikTok gates public posting behind an app review it calls the **content-sharing
audit**. Until the app passes it, every post this server makes is `SELF_ONLY`
and at most five people a day can post through it
([docs/TIKTOK-API.md § 7](TIKTOK-API.md#7-unaudited-client-restrictions-the-audit-gate)).
This file is the submission playbook: what has to be true before you open the
form, what the demo video has to show, what changes afterwards, and a log to
record what actually happened.

**What this file can and cannot tell you.** Nobody involved in writing it has
opened TikTok's submission form. Everything stated as fact here is traceable to
material already in this repository — the doc and section are named at each
claim — and everything that would need the developer portal to confirm is marked
**[verify in the portal]**. Those markers are not hedging for its own sake: they
are the list of things to check on screen before you submit, because getting one
of them wrong is a rejection round. The repo's most detailed account of the
requirements is a *second-hand transcription* of TikTok's guidelines made during
the round-2 review
([docs/reviews/round2/tiktok-platform-deep-review.md § 5.7](reviews/round2/tiktok-platform-deep-review.md)),
not a reading of the live form; § 3 below says so again where it matters.

**Contents:** [1. What the audit changes](#1-what-the-audit-changes) ·
[2. Preconditions](#2-preconditions) ·
[3. What the submission asks for](#3-what-the-submission-asks-for) ·
[4. The demo video](#4-the-demo-video) ·
[5. Submission checklist](#5-submission-checklist) ·
[6. After you submit](#6-after-you-submit) ·
[7. What changes when it passes](#7-what-changes-when-it-passes) ·
[8. Journey log](#8-journey-log)

## 1. What the audit changes

| | Unaudited app (today) | After a pass |
| --- | --- | --- |
| `creator_info.privacy_level_options` | `["SELF_ONLY"]` only | The account's real options, incl. `PUBLIC_TO_EVERYONE` |
| Posting account | Must itself be private; a public account gets `unaudited_client_can_only_post_to_private_accounts` (403) | No such restriction |
| Distinct posting users | 5 per 24 h per app (`reached_active_user_cap`, 403) | Lifts |
| Branded content | Impossible — it requires a non-private privacy level | Possible |

Source for all four rows:
[docs/TIKTOK-API.md § 7](TIKTOK-API.md#7-unaudited-client-restrictions-the-audit-gate)
and [docs/SETUP-TIKTOK-APP.md § 7](SETUP-TIKTOK-APP.md#7-the-audit-gate). The
error codes are the ones the server maps in `src/mcp/errors.ts`
(`reached_active_user_cap` → catalog code `active_user_cap`, whose remediation
text already says "the permanent fix is the developer passing TikTok's app
audit").

What the audit does **not** change:

- **Sandbox.** Sandbox mode does not offer Content Posting for public videos at
  all, independently of the audit
  ([docs/TIKTOK-API.md § 7](TIKTOK-API.md#7-unaudited-client-restrictions-the-audit-gate)
  item 3; [docs/SETUP-TIKTOK-APP.md § 6](SETUP-TIKTOK-APP.md#6-sandbox-vs-production)).
  Passing the audit does not make sandbox post publicly.
- **Already-posted content.** The lift is not retroactive: existing `SELF_ONLY`
  posts stay private until the user changes them by hand in the TikTok app
  (TIKTOK-API § 7 item 4).
- **The read side.** Nothing in this repo ties the Display API (`user/info`,
  `video/list`, `video/query`) to the content-sharing audit; its scopes are
  granted per user at login and its quota is the 600/min sliding window of
  [docs/TIKTOK-API.md § 5](TIKTOK-API.md#5-rate-limits--business-caps).
  **[verify in the portal]** whether your app's read products carry any review
  requirement of their own — the repo has no evidence either way.
- **Other people's apps.** The audit is per developer app, so every operator who
  installs this server starts unaudited with their own app. A pass for one app
  changes nothing for anyone else's — which is why the server's
  audit-restriction texts stay in the product permanently and are driven by
  data, not by a build flag (§ 7).

Until the audit passes, the interim path for content that has to end up public
is the **draft/inbox flow**: the server uploads to the creator's TikTok inbox and
the human finishes the post in the app, where the normal privacy picker applies.
Drafts take no `post_info` at all
([docs/TIKTOK-API.md § 4.3](TIKTOK-API.md#43-upload-draft-to-inbox-post-v2postpublishinboxvideoinit)),
so no privacy level is sent. Whether drafts also consume the 5-users/24 h cap is
unresolved — sandbox probe **P-10**, still `not run`
([docs/probes/PROBE-LOG.md](probes/PROBE-LOG.md)).

## 2. Preconditions

Everything below is a hard prerequisite. Each item says how to check it from
this repo; the ones that need the portal say so. Two of them (§ 2.1, § 2.6) are
open gaps today, verified by hand rather than assumed.

### 2.1 Privacy Policy and Terms of Service at live URLs — currently blocked

The review transcription lists a valid Privacy Policy **and** Terms of Service
"visible on your official website" as the first requirement
([§ 5.7](reviews/round2/tiktok-platform-deep-review.md) item 1), and
[docs/SETUP-TIKTOK-APP.md § 7](SETUP-TIKTOK-APP.md#7-the-audit-gate) warns that
"a placeholder or a dead link is an easy rejection".

The pages are written — `site/privacy.html` and `site/terms.html` — and
`.github/workflows/pages.yml` deploys `site/` to GitHub Pages. Both files are
committed — tracked on `main` since commit `6410fa1`, so `pages.yml`, which
builds its artifact from the *repository's* checkout, carries them. **One thing
still stands between them and a live URL: GitHub Pages is not enabled on the
repository** (`gh api repos/IvanBBaev/tiktok-mcp/pages` → 404). The
push-triggered `pages.yml` run of that commit failed for that reason, nothing is
deployed, and all three of

- `https://ivanbbaev.github.io/tiktok-mcp/`
- `https://ivanbbaev.github.io/tiktok-mcp/privacy.html`
- `https://ivanbbaev.github.io/tiktok-mcp/terms.html`

return **404** (re-checked 2026-09-28 — the tracked-file list, the Pages API
and all three URLs — not assumed). This is gap **G-4** in
[docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) and the human step is
spelled out in the TE-5 row of [docs/TASK-BREAKDOWN.md](TASK-BREAKDOWN.md):
enable Pages with **Source = GitHub Actions**, then run `pages.yml` by its
`workflow_dispatch` — it auto-triggers only on pushes that touch `site/**`, and
the commit carrying the pages has already been pushed — and confirm both URLs
resolve in a browser. Do not open the submission before
that; a 404 on the policy URL is the cheapest possible rejection.

If you are a third-party operator submitting your **own** app, these are not
your URLs. [docs/SETUP-TIKTOK-APP.md § 1](SETUP-TIKTOK-APP.md#1-create-the-app)
is explicit that this project's policy pages are reference material, not the
values to enter — you need your own, on your own site.

### 2.2 An official website whose domain matches the app

The same requirement list pairs the policy pages with "a valid official website"
and an app name that matches the site, with mismatched domain/app names appearing
in the documented rejection classes
([§ 5.7](reviews/round2/tiktok-platform-deep-review.md) items 1 and 5). For this
project the site is the Pages deployment of § 2.1, so the two unblock together.

### 2.3 App name and branding that cannot be confused with TikTok's

Same source, item 1: "app name custom, matching your site, no TikTok-confusable
branding". The repo's own position on this is gap **G-2**, recorded **closed**
in [docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md). The unofficial-status
and trademark disclaimer now carries on every surface a reviewer reaches
without the portal — inventory re-checked 2026-09-01:

- `README.md`: the callout under the title and § Trademark.
- `package.json`: the `description` opens with "Unofficial" and a `trademark`
  field carries the full non-affiliation text, so both ship on npm.
- `extension/package.json`: the `description` — the single line the VS Code
  Marketplace shows in search results — opens with "Unofficial:" and ends with
  "Not affiliated with, endorsed by, or sponsored by TikTok or ByteDance";
  `extension/README.md` § Trademark carries the long form into the listing body.
- `site/privacy.html` and `site/terms.html`: the meta description and the lead
  paragraph of each, plus a dedicated § Unofficial in the terms.
  `site/index.html` says "unofficial" in the hero and the footer and states the
  full non-affiliation sentence in two FAQ answers.

Note the overlap with § 2.1: the three site pages are the items on that list a
reviewer cannot actually see today, because Pages is not enabled and the whole
site 404s. **[verify in the portal]** that the app's
display name, icon and description in the portal carry the same disclaimer, and
that the name does not read as an official TikTok product. Nothing in the repo
can confirm what is currently typed into those fields.

### 2.4 The products and scopes you are actually submitting

The review transcription says the form wants per-product and per-scope
justification text ([§ 5.7](reviews/round2/tiktok-platform-deep-review.md) item
2), and that "all selected products and scopes must be clearly demonstrated in
the video" (item 3). The set this server needs is the table in
[docs/SETUP-TIKTOK-APP.md § 2](SETUP-TIKTOK-APP.md#2-add-the-products) — Login
Kit, Display API, Content Posting API, with the scopes listed there and in
[docs/TIKTOK-API.md § 2](TIKTOK-API.md#scopes-used-by-this-server). Submit
exactly what you demonstrate. Adding a product you cannot show on video pulls
the "incomplete information" rejection class onto an otherwise clean submission.

Which scopes those are is not a fixed list of six — it is derived from the tool
packages the installation enables (`PACKAGE_SCOPES` in `src/cli/login.ts`, the
same derivation stated in [docs/AUTH.md § 1.2](AUTH.md)). The default
`TT_TOOL_PACKAGES=core` requests **five** — `user.info.basic`,
`user.info.profile`, `user.info.stats`, `video.list`, `video.publish` — and
`video.upload`, the inbox-draft scope, joins them **only** when the
`publish-write` package is enabled. Both halves of that bind the demo: every
write tool the § 4 shot list films (`tiktok_post_video`,
`tiktok_upload_video_draft`, the photo pair) lives in `publish-write`, so the
login you record is a six-scope one — and item 3 then wants all six on screen,
which means the draft/inbox flow is filmed too, not only the direct post.
Requesting `video.upload` and showing no draft is the same "incomplete
information" exposure as an undemonstrated product. Read the granted-scope line
`login` prints at the end of the flow, not this paragraph, for what your app
actually asked for.

### 2.5 A production app you can actually film

The demo has to be shot on **unaudited production**, not sandbox — see § 4.
That means the production app exists, the redirect URI is registered on it
([docs/SETUP-TIKTOK-APP.md § 3](SETUP-TIKTOK-APP.md#3-register-the-redirect-uri)),
a **private** TikTok account has authorized it
([§ 5](SETUP-TIKTOK-APP.md#5-authorize-an-account)), and
`tiktok-mcp-ai doctor` is green
([§ 9](SETUP-TIKTOK-APP.md#9-confirm-it-works)). If you intend to demonstrate
`PULL_FROM_URL` posting, domain verification is a separate portal step with its
own Production-mode caveat
([§ 8](SETUP-TIKTOK-APP.md#8-verify-a-domain-for-url-posting)) — verify the
domain first or keep URL posting out of the demo entirely.

### 2.6 The package installable by a reviewer

"Apps still in development or testing" is a documented rejection class
([§ 5.7](reviews/round2/tiktok-platform-deep-review.md) item 5). Today
`https://registry.npmjs.org/tiktok-mcp-ai` returns **404** and `git tag -l` is
empty (both re-checked 2026-09-28) because the first release has not been
published: gap **G-14** (first-release bootstrap) in
[docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md), still **open** there,
executed in TE-5. Note the contradiction to resolve before you cite a version
anywhere in the submission: `CHANGELOG.md` carries a dated `0.7.0` entry
describing itself as "First published release" and `package.json` is at `0.7.0`
— that release landed on `main` in commit `2794dbd` — while the registry has no
such package. Publish first, then submit, and make the version you name in the
form the one a reviewer can install. The publish is manual: G-14 records that
trusted publishing cannot ship a package's first version, so a `v*` tag pushed
before it fails at `npm publish` and releases nothing. It spends nothing either:
`publish-vscode.yml` and `publish-mcp.yml` follow a successful npm publish
rather than the tag, so no Marketplace or MCP Registry version is burnt — but
the release still waits on the manual publish.

### 2.7 Do not confuse this with the sandbox probes

The probe programme **P-1..P-16**
([docs/probes/PROBE-LOG.md](probes/PROBE-LOG.md), index in
[docs/TIKTOK-API.md Appendix A](TIKTOK-API.md#appendix-a--sandbox-probe-index))
gates **v1.0**, not the audit. The probes answer empirical questions about the
API; the audit is a review of the integration's behaviour. They share no
deliverable: probes are run in sandbox and recorded in the probe log, the demo
is shot in production and recorded here. PROBE-LOG's own rules say the demo
"is not a probe and does not belong in this file". Its status line now reads
that **one** probe has been run — P-15, the offline engineering spike, on
2026-08-31 — and that every probe needing a live sandbox account is still
`not run` (re-checked 2026-09-28). Nothing in the sandbox programme has to
finish before you submit.

## 3. What the submission asks for

**Read this section as a checklist to verify, not as the requirements.** It is
transcribed from
[docs/reviews/round2/tiktok-platform-deep-review.md § 5.7](reviews/round2/tiktok-platform-deep-review.md),
which quotes TikTok's app-review and content-sharing guidelines as they read
when that review was written. The live form is the authority.

| # | What the review recorded | Status |
| --- | --- | --- |
| 1 | Privacy Policy + ToS on the official website; valid official website; custom app name matching the site; no TikTok-confusable branding | § 2.1–2.3 |
| 2 | Per-product / per-scope justification text in the review form | Write it against § 2.4. **[verify in the portal]** the exact fields, their character limits, and whether justification is per product or per scope |
| 3 | Demo videos: up to **5**, **50 MB** each; "the complete end-to-end flow of the up-to-date integrations"; "Clearly show the user interface and user interactions"; "All selected products and scopes must be clearly demonstrated in the video" | § 4. **[verify in the portal]** the current count/size limits and accepted formats before you spend a day rendering |
| 4 | Content Posting additionally checks the UX rules: privacy chosen manually with **no default**; comment/duet/stitch toggles **none checked by default**; commercial-content toggle **off by default**; the music-usage confirmation wording; branded-content-cannot-be-private | § 4 shot list; the same rules are [docs/TIKTOK-API.md § 8](TIKTOK-API.md#8-uxintegration-guidelines-that-are-audit-relevant) |
| 5 | Documented rejection classes: incomplete information; adult content; apps "still in development or testing"; mismatched domain/app names | § 2.2, § 2.3, § 2.6 |
| 6 | Timeline: **not documented officially** | See below |

**Timeline.** The review is explicit that TikTok does not document a turnaround.
The numbers it cites — 3–5 business days for a clean pass, 2–4 weeks with
feedback rounds — come from third-party blogs that the review itself flags as
secondary sources. Treat them as folklore, plan for neither, and record what you
actually observe in § 8. **[verify in the portal]** whether the submission UI
states an SLA; if it does, that supersedes everything here.

**[verify in the portal]** — additionally, and with no repo evidence at all:
where the submission form lives in the current portal navigation, whether it is
per app or per product, whether submitting locks the app's configuration while
review is pending, and whether a rejected submission can be edited and resent or
must be recreated. Do not plan around any assumption on these.

## 4. The demo video

### 4.1 Where it is shot, and why that is awkward

Sandbox cannot post publicly, so the full flow cannot be demonstrated there;
the demo is shot on **unaudited production with a private account**, where every
post is `SELF_ONLY` (finding **R2-7** and
[§ 5.8](reviews/round2/tiktok-platform-deep-review.md) of the round-2 review;
[docs/TIKTOK-API.md § 7](TIKTOK-API.md#7-unaudited-client-restrictions-the-audit-gate)
item 3). You are therefore filming the very restriction you are asking to have
lifted. Say so on screen or in the justification text rather than letting the
reviewer wonder why nothing is public.

This recording is **not a probe**. Nothing from it goes into
[docs/probes/PROBE-LOG.md](probes/PROBE-LOG.md) — its rules exclude the demo
explicitly. What it produced belongs in § 8 of this file.

### 4.2 The interface problem

The demo checklist assumes a GUI ("Clearly show the user interface and user
interactions"). This server is headless: its interface is an MCP client
conversation plus the plan/execute approval step. The round-2 review calls this
out as the **MCP-specific risk** and states plainly that whether reviewers
accept a conversational UI as "the user interface" is untested — expect at least
one feedback round. Film in a client with a visible UI (Claude Desktop, VS Code,
or the MCP Inspector — see [docs/CLIENTS.md](CLIENTS.md)) rather than a raw
stdio session, and let the tool output be legible on screen.

### 4.3 Shot list

Each row maps a checked requirement to the concrete artifact the server already
produces. The preview contract is
[docs/TOOLS.md § 2.6.1](TOOLS.md); the unaudited walk-through is its canonical
flow 2. In the last column "§ 5.7" is the round-2 review's requirement list and
"§ 8" is [docs/TIKTOK-API.md](TIKTOK-API.md#8-uxintegration-guidelines-that-are-audit-relevant).

| Show | The artifact | Why it is on the list |
| --- | --- | --- |
| The creator, before anything is posted | `tiktok_get_creator_info` output — nickname and avatar, echoed into the publish preview's `creator` block | § 8: show nickname/avatar from creator_info before posting |
| Privacy has no default | Call the post tool **without** `privacy_level`: the preview returns `mode: "plan_incomplete"`, `missing: ["privacy_level"]`, no `post_info` and **no `plan_id`**, plus the hint "No plan_id was issued: privacy_level is required and has no default. Ask the user to choose one of …" — nothing is postable until the human names a level | § 5.7 item 4: "manually chosen … no default value" |
| The user choosing a level | The second preview, now with `privacy_level` set, returning `mode: "plan"` and a `plan_id` | Same |
| Toggles are off unless asked for | The preview `payload`: `disable_comment` / `disable_duet` / `disable_stitch` are `false`, and any value the *server* chose rather than the caller appears in `derived[]` with a reason | § 5.7 item 4: "none should be checked by default" |
| Commercial content off by default | The same payload: `brand_content_toggle` and `brand_organic_toggle` are sent as `false` unless the caller explicitly sets them | Same |
| Branded content vs. private | Attempt `brand_content_toggle: true` with `SELF_ONLY`: the server refuses with `branded_content_privacy_conflict`, carrying TikTok's own tooltip wording | § 5.7 item 4, [docs/TIKTOK-API.md § 4.2](TIKTOK-API.md#42-direct-post-video-post-v2postpublishvideoinit) |
| Music-usage confirmation | The preview's `consent_line`: "By approving this post you confirm the user agrees to TikTok's Music Usage Confirmation." (the branded variant adds the Branded Content Policy) | § 5.7 item 4: the confirmation wording |
| Explicit consent before sending | The human approving, then the execute call with the single-use `plan_id` — and a second execute with the same `plan_id` being refused | § 8: "ask for explicit consent before sending content" |
| The audit restriction, explained in-product | `audit_restrictions_active: true` in the preview plus the note the server emits: only `SELF_ONLY` is available, every post is visible to the owner alone, "only the developer passing the audit changes it" | Makes the reason for the submission visible on screen |
| A real terminal outcome | `tiktok_get_publish_status` reaching a terminal state, and the post visible in the TikTok app on the private account | "the complete end-to-end flow" |
| The draft/inbox flow, if `video.upload` is in the submission | `tiktok_upload_video_draft` (or `tiktok_upload_photos_draft`) reaching a terminal status and the draft waiting in the creator's TikTok inbox — drafts take no `post_info`, so no privacy level is sent | § 5.7 item 3: `video.upload` is a scope only the draft tools exercise, so a submission that lists it and films only the direct post is undemonstrated (§ 2.4) |
| Login, if the scopes are in the submission | The `login` flow granting the exact scopes of § 2.4 | § 5.7 item 3: every submitted scope demonstrated |

One thing that will be on screen and needs a sentence of narration: `is_aigc`
defaults to **true** (`TT_DEFAULT_AIGC_LABEL` ships as `1` —
[docs/TOOLS.md § 3.8](TOOLS.md), [docs/CONFIGURATION.md](CONFIGURATION.md)), and
the preview reports it in `derived[]` as "defaulted from the server setting". If
the demo clip is not AI-generated, set `is_aigc: false` in the shot so the
recording does not show the integration mislabelling human content — and explain
the default, since erring towards the AI label is deliberate.

The chicken-and-egg to plan around: the checklist wants the branded-content UX
demonstrated, but on an unaudited app branded content is **impossible** — the
only privacy level on offer is `SELF_ONLY`, and that combination is exactly what
the server refuses. The refusal, with TikTok's tooltip wording, is the only
thing that can be filmed. Name the constraint in the justification text so it
does not read as a missing requirement.

### 4.4 What must not be in frame

The redaction rules of [docs/probes/PROBE-LOG.md](probes/PROBE-LOG.md) apply to
the recording as well as to written records:

- No access or refresh tokens, no `client_secret`, no `upload_url` (it carries
  an upload token in the query string).
- No `open_id`.
- The authorization URL of the login step carries the **client key** — blur it,
  or start the recording after the redirect. **[verify in the portal]** whether
  the reviewer needs to see the client key at all; assume not.
- Nothing on screen from an account other than the demo account.

Review the footage frame by frame before uploading: a video in TikTok's review
queue is not something you can edit afterwards. If a secret does end up in
frame, treat it as compromised — regenerate it in the portal and re-run `login`
for every profile ([docs/SETUP-TIKTOK-APP.md § 4](SETUP-TIKTOK-APP.md#4-store-the-client-key-and-secret),
[docs/AUTH.md](AUTH.md)).

## 5. Submission checklist

Work top to bottom; every item points at the section that defines it.

1. GitHub Pages enabled, `pages.yml` deployed, both `privacy.html` and
   `terms.html` loading over HTTPS — verified in a browser, not assumed (§ 2.1,
   G-4). The two page files are already committed; the workflow deploys the
   repository, not your working tree, so keep any edit to them committed too.
2. Official website live and its domain consistent with the app name (§ 2.2).
3. App name, icon and description free of TikTok-confusable branding and
   carrying the unofficial-status disclaimer (§ 2.3, G-2).
4. The product/scope set fixed and written down; justification text drafted per
   product and per scope (§ 2.4).
5. First npm release published so a reviewer can install the version you cite;
   `CHANGELOG.md` and the registry agreeing (§ 2.6, G-14).
6. Production app configured, private demo account authorized, `doctor` green
   (§ 2.5).
7. Demo recorded per the § 4 shot list, reviewed for leaked secrets (§ 4.4),
   and inside whatever count/size limits the form actually states (§ 3, item 3).
8. Submit. Immediately record the date, the exact product/scope set, and the
   video list in § 8 — you will need it to interpret whatever comes back.

## 6. After you submit

- **v1.0 does not wait for a verdict.** Audit *passed* is a 1.x platform
  milestone outside this project's control; v1.0 requires the audit
  **submitted** ([docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) § Road to
  v1.0, [docs/ROADMAP.md](ROADMAP.md) Phase 3, and the TE-5 row of
  [docs/TASK-BREAKDOWN.md](TASK-BREAKDOWN.md)). Ship on the submission, not on
  the review queue.
- **The fallback operating state is the current one.** Unaudited production with
  private accounts plus the draft/inbox flow needs no audit and is what every
  operator gets on day one anyway (§ 1). The round-2 review names keeping it as
  the fallback explicitly.
- **Expect a feedback round.** Same review, MCP-specific risk: a conversational
  UI as "the user interface" is untested.
- **Copy any rejection text verbatim into § 8**, before paraphrasing it. The
  exact wording is the only reliable input for the next attempt, and it is the
  only first-hand evidence this repo will ever have about the requirements —
  every "[verify in the portal]" marker above is a candidate to replace with a
  fact once you have been through the form.

## 7. What changes when it passes

**Code: nothing.** The restriction is detected from data, never configured. The
server decides whether the audit gate is active by looking at what
`creator_info` returned — `auditRestrictionsActive()` in `src/api/publish.ts` is
true exactly when the only offered privacy level is `SELF_ONLY`. When TikTok
starts returning more options, the preview's `audit_restrictions_active` flag
goes false, the note stops being emitted and the additional levels become
selectable, with no release required. Do not add a "we are audited now" setting;
it would be wrong for every other operator's app (§ 1).

**Docs: only the claims about *this project's own* app.** Statements about what
an unaudited app can do stay true and must not be deleted.

| Claim | Where | What it becomes |
| --- | --- | --- |
| The publishing caveat and the audit-gate walkthrough | `README.md` § Requirements ("until the TikTok app passes TikTok's audit…") and § Platform compliance, [docs/SETUP-TIKTOK-APP.md § 7](SETUP-TIKTOK-APP.md#7-the-audit-gate) | **No change needed** — both are already written about *the operator's* app, which is the correct framing. Check them rather than assume, but resist the urge to delete them |
| Audit submitted / audit passed | [docs/ROADMAP.md](ROADMAP.md) Phase 3, [docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) § Road to v1.0 and its risk-register row "TikTok audit delayed/rejected" | The risk retires; the 1.x milestone closes |
| "Only the developer passing the audit changes it" | `auditRestrictionsNote()` in `src/tools/publish.ts` | Still correct and still needed — it fires per app, from data |
| The `wait_for_audit` hint action | [docs/TOOLS.md § 5.1](TOOLS.md), [docs/CONTRACTS.md](CONTRACTS.md), `src/mcp/result.ts` | **Resolved 2026-08-31 — nothing to do here.** The member was dropped from the closed vocabulary rather than wired: an unaudited app is a standing condition of the installation, which § 5.1 assigns to a `note`, not a step only a human can take next. `auditRestrictionsNote()` stays a `note` and stops firing by itself once `creator_info` widens |
| The site FAQ's explanation of the gate | `site/index.html` | **Fixed 2026-08-30**, independently of the audit. The page used to say TikTok "forces every direct post to SELF_ONLY regardless of the `privacy_level` you send"; the *effect* was right, the mechanism was not. The server refuses a level `creator_info` did not offer, locally, with `privacy_level_unavailable` ([docs/TOOLS.md](TOOLS.md) error catalog) — the video is not posted at the wrong visibility, it is not posted at all. When the audit passes, the FAQ answer and the warn callout both need re-reading, not deleting |

And the one thing to tell users explicitly: **the lift is not retroactive.**
Posts made while unaudited stay `SELF_ONLY` until their author changes them in
the TikTok app (§ 1).

## 8. Journey log

One row per event — submission, feedback, resubmission, verdict. Keep the
redaction rules of § 4.4 (no tokens, no `open_id`, no client key). Paste
rejection text verbatim before summarising it. When an entry turns a
**[verify in the portal]** marker above into a known fact, edit that marker out
and cite this log instead.

| Date | Event | Products / scopes submitted | What was sent | Outcome / verbatim response |
| --- | --- | --- | --- | --- |
| | | | | |

Entry template for anything longer than a table row:

```
### YYYY-MM-DD — <event>

- **App / environment:** production, unaudited (or: audited)
- **Submitted:** products, scopes, video count and total size
- **Response:** verbatim, then the paraphrase
- **Repo changes it implies:** docs/sections to update, markers to retire
```

## Sources

Repository material this file is built from — nothing here was taken from
TikTok's site directly:

- [docs/TIKTOK-API.md § 7](TIKTOK-API.md#7-unaudited-client-restrictions-the-audit-gate)
  (unaudited-client restrictions), [§ 8](TIKTOK-API.md#8-uxintegration-guidelines-that-are-audit-relevant)
  (audit-relevant UX rules), [§ 4.1–4.3](TIKTOK-API.md#41-pre-flight-post-v2postpublishcreator_infoquery)
  (creator_info, direct post, drafts), [§ 5](TIKTOK-API.md#5-rate-limits--business-caps)
  (limits and caps), [Appendix A](TIKTOK-API.md#appendix-a--sandbox-probe-index) (probe index)
- [docs/SETUP-TIKTOK-APP.md](SETUP-TIKTOK-APP.md) §§ 1–3, 5–9 — app creation,
  products and scopes, redirect URI, sandbox vs. production, the audit gate,
  domain verification, `doctor`
- [docs/reviews/round2/tiktok-platform-deep-review.md](reviews/round2/tiktok-platform-deep-review.md)
  § 5.7 (requirements, rejection classes, timeline, MCP-specific risk), § 5.8
  (sandbox), finding R2-7 (demo needs production)
- [docs/probes/PROBE-LOG.md](probes/PROBE-LOG.md) — probe status, redaction
  rules, and the rule that the demo is not a probe
- [docs/TOOLS.md](TOOLS.md) § 2.6.1 (preview contract), § 4 flow 2 (unaudited
  app), § 5.1 (hint vocabulary), error catalog
  (`privacy_level_unavailable`, `branded_content_privacy_conflict`,
  `active_user_cap`)
- [docs/IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) — WP-3.4, gaps G-2, G-4,
  G-14, § Road to v1.0, risk register;
  [docs/TASK-BREAKDOWN.md](TASK-BREAKDOWN.md) TE-5
- Code: `src/api/publish.ts` (`auditRestrictionsActive`), `src/tools/publish.ts`
  (`auditRestrictionsNote`), `src/tools/publish-common.ts` (`consentLine`),
  `src/mcp/errors.ts` (`reached_active_user_cap` → `active_user_cap`)

TikTok's own documentation links are listed at the end of
[docs/SETUP-TIKTOK-APP.md](SETUP-TIKTOK-APP.md#sources) and
[docs/TIKTOK-API.md](TIKTOK-API.md#sources); this file does not reproduce them,
because it has not re-read them.
