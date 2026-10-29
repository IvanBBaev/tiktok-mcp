# Round 3 — Legal, Privacy & Platform-Compliance review

Date 2026-10-29 · commit 301b9bb · reviewer role: senior Legal, Privacy & Platform-Compliance reviewer (GDPR, platform developer terms, trademark, OSS licensing) · scope: `site/privacy.html`, `site/terms.html`, `SECURITY.md`, `LICENSE`, trademark surfaces (`package.json`, `extension/`, `site/assets/`), and the TikTok-terms posture of the v1.1–1.3 features (schedule/run-queue, batch, webhooks, analytics, embed, consent).

> This is not legal advice. It lists the risks and the questions a lawyer, a data-protection authority or a TikTok app reviewer would raise.

External sources, all accessed 2026-10-29:

- TikTok Content Sharing Guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines
- TikTok App Review Guidelines: https://developers.tiktok.com/doc/app-review-guidelines
- TikTok Developer Terms of Service: https://www.tiktok.com/legal/page/global/tik-tok-developer-terms-of-service/en
- TikTok Brand and Use Guidelines: linked from the app-review page. I could not retrieve the full text, so nothing below that depends on it is verified.

## Verdict

The legal pages are well written and unusually honest: no telemetry, local-only storage, a clear AI-vendor disclosure, and no padding. They are also **out of date**. They were last revised on 2026-08-29 (last commit `6410fa1`, 2026-09-26). Since then the webhook receiver (10-24), the scheduler, batch publishing and elicitation (10-27) and the oEmbed tool all shipped, and each one changes what is stored or where data goes. The policy still calls itself "a description of the published source code", but its central claims are now false: "two files", "the complete set of network destinations", and "never contains … the full caption". On the platform side, the biggest risk is not in the code. TikTok's app review says **"Apps must not be for private or personal use"**, and the bring-your-own-app, single-operator model is exactly that. The docs never warn operators that their audit is likely to be rejected for this reason. The consent features (plan_id, elicitation, Music/Branded-Content declarations, commercial-disclosure enforcement) are strong. But `TT_WRITE_MODE=apply`, `TT_ELICITATION=auto` falling back to a plan_id the model can mint and spend by itself, one-approval batches and delayed unattended run-queue posting all sit uneasily with "don't send any content to TikTok until the user has expressly consented". The OSS licensing is clean.

**Readiness 5/10.** Licensing, the non-goals and the disclosure controls are release-grade. But the privacy policy is factually wrong about the built system. Under the Developer Terms §III.2(c) it has to be "complete and accurate", and it is what operators are told to copy. The audit-eligibility and trade-dress risks are also not surfaced to operators.

## What is strong

- **Licensing is clean.** MIT (`LICENSE`, `extension/LICENSE`). The npm package bundles no third-party code: `files` is `bin`/`build/src` only (`package.json:20-25`). All 94 production packages in `package-lock.json` are MIT, ISC, BSD-2 or BSD-3. The extension excludes `node_modules/**` (`extension/.vscodeignore`). No NOTICE file is needed for either.
- **No engagement automation, as promised.** None of the 17 tools in `docs/tool-manifest.json` likes, follows or comments (`site/terms.html:255`).
- **Commercial-content rules are enforced in code.** Branded content combined with SELF_ONLY is refused (`src/api/publish.ts:121,305`). The Music Usage and Branded Content Policy declarations are part of the plan (`src/tools/publish-common.ts:636-642`). `privacy_level` has no default and no plan is minted without it (`src/tools/publish-common.ts:536`).
- **AI-generated content is labelled by default.** `TT_DEFAULT_AIGC_LABEL=1` (`src/core/settings.ts:632`), and the default is surfaced in `derived` (`src/api/publish.ts:332-344`), so `site/terms.html:237` is accurate.
- **Analytics persists nothing.** It is derived live from `video/list` with a minimal field set (`src/tools/analytics.ts:46-55`), so there is no TikTok-data retention issue there.
- **Deauthorization is honoured.** An `authorization.removed` webhook clears the profile's tokens (`src/mcp/webhook.ts:393-397`, `src/core/oauth.ts:1084-1094`).
- **Unofficial / non-affiliation wording (G-2) is everywhere it was claimed to be:** `package.json:4`, the README callout, the extension description, and both legal pages.
- **SECURITY.md is a real disclosure policy:** private GitHub advisory reporting, an email fallback, a 90-day default, explicit out-of-scope items.

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| LGL-01 | High | The privacy policy no longer describes the software. It leaves out `schedule.json` (full tool arguments: complete caption, media path or URL, 30-day retention), `webhooks.ndjson` (event content plus `user_openid`), the lock directories and `holder.json`, and the oEmbed egress host. It calls its list of destinations "the complete set" and says only loopback is involved, even though webhooks need a public endpoint. | `site/privacy.html:150` "two files", `:202` "Nothing else is persisted", `:242` "never … the full caption", `:280` "complete set", `:296`; `src/mcp/schedule.ts:46,66,91-92`; `src/mcp/webhook.ts:25,65,73-85`; `src/core/http.ts:84`, `src/api/embed.ts:31`; `docs/CONFIGURATION.md:440-442` | Rewrite against the built system, and add a drift check that ties every persisted filename and egress host constant to the page (LGL-R1). |
| LGL-02 | High | Audit eligibility. TikTok rejects apps "for private or personal use" and requires apps "intended for a wide audience, not only test use or internal/private teams". Each operator registering a personal app for one local process is that case. Nothing in AUDIT.md or SETUP-TIKTOK-APP.md warns about it. | App Review Guidelines; Content Sharing Guidelines "Intended use"; `docs/AUDIT.md:246-250` (rejection classes listed without this one); `site/terms.html:258` "single-user process" | Tell operators plainly that public posting may never be approved for personal-use deployments and that SELF_ONLY plus the 5-users-per-24 h cap may be permanent. Make it an owner decision whether the project's own audit is attempted, and how it is framed (LGL-R3). |
| LGL-03 | High | The consent model has gaps against "Don't send any content to TikTok until the user has expressly consented" and the manual-selection rules: (a) `TT_WRITE_MODE=apply` posts with no checkpoint; (b) under `TT_ELICITATION=auto`, a client without elicitation leaves `plan_id` as the only gate, and the model can preview and apply in one turn, with the model picking `privacy_level`; (c) one approval covers up to 10 posts across accounts; (d) `run-queue` posts unattended up to 30 days plus 24 h after consent. | `docs/CONFIGURATION.md:229-245`; `src/tools/publish-batch.ts:1-13,41`; `src/mcp/schedule.ts:57-66`; `src/cli/run-queue.ts:1-23` | Write a compliance matrix and an "audit-safe profile" (`TT_ELICITATION=required`, no `apply`). Consider refusing `apply` mode for anything that is not SELF_ONLY, and per-item nicknames plus re-consent for batch and schedule (LGL-R3, LGL-R4). |
| LGL-04 | Medium | The GDPR role statement is wrong: "There is no controller collecting your data, because there is no collection". The operator is the controller for their app's users. The household exemption (GDPR Art. 2(2)(c)) does not cover managing other creators' accounts through profiles, and TikTok's Controller-to-Controller Data Terms (DTS §III.5) make the developer a controller. For the website, the author is the controller: the home page loads Google Fonts, sending EU visitors' IPs to Google without consent, which LG München I, 3 O 17493/20 (20 Jan 2022) held unlawful. | `site/privacy.html:140`; `site/privacy.html` § This website ("three web fonts from Google Fonts"); DTS §III.5 | Name the roles: the author is neither controller nor processor of runtime data; the operator is the controller; the author is the controller of the website. Self-host the fonts (LGL-R1, LGL-R5). |
| LGL-05 | Medium | Deletion is incomplete. The "Deleting your data" section omits `schedule.json`, `webhooks.ndjson`, the `.lock` directories and the suggested `run-queue.log`. `login --revoke --purge-journal` purges only the journal. `authorization.removed` clears tokens but leaves pending schedule entries, the journal and webhook records with that user's `open_id` and captions. Retention is size-based only (5 MB journal, 1 MB webhook log), never time-based. DTS §VI requires deleting TikTok Information on termination. | `site/privacy.html:458+`; `src/cli/login.ts:190,749` (no schedule/webhook handling); `src/core/oauth.ts:1092` "journal is untouched"; `docs/CONFIGURATION.md:340` (log path) | Add a `purge` command, cancel a revoked profile's pending schedule entries, and offer optional age-based retention (LGL-R2). |
| LGL-06 | Medium | Trade dress and naming go beyond minimal nominative use. The site palette and favicon are TikTok's signature cyan and red (`#00f2ea`/`#ff0050`) as a gradient. The extension `displayName` is "TikTok MCP" and its MCP server label is "TikTok", neither saying "Unofficial". App review says an app name "should not include a reference to social media companies (e.g. 'TikTok app')", yet SETUP gives operators no naming or icon guidance, so an operator who names their portal app `tiktok-mcp-ai` invites rejection. | `site/assets/styles.css:7-8,215,638`; `site/privacy.html` favicon `fill='%2300f2ea'`; `site/assets/og-banner.svg`; `extension/package.json:3,39`; `extension/src/extension.ts:21`; `docs/SETUP-TIKTOK-APP.md:45` | Change the palette, rename the display names (for example "MCP Server for TikTok (Unofficial)"), and add portal app-name and icon guidance (LGL-R5, LGL-R3). |
| LGL-07 | Medium | The npm name is unclaimed (E404), yet the extension and all docs run `npx -y tiktok-mcp-ai` unpinned. A third party, or a trademark complainant under npm's dispute policy, can take the name first, and every documented command would then run their code. | `extension/src/extension.ts:21-24`; brief: `npm view` → E404 | Do the first publish (G-14) before any extension or Marketplace listing. Consider a scoped fallback name (`@ivanbbaev/...`) in case of a dispute (owner decision). |
| LGL-08 | Low | The legal and marketing text contradicts itself. Terms says "pre-1.0" and SECURITY.md says "`0.x`", while `package.json` says 1.0.0. The `og:image:alt` says "11 tools, 5 packages"; there are 17 tools and 7 packages. | `site/terms.html:153`; `SECURITY.md:12,22`; `site/privacy.html:32,46`; `README.md` badge "tools-17" | Fix in LGL-R1. |
| LGL-09 | Low | `is_aigc` is defaulted for photo posts too. I did not verify that TikTok's photo `post_info` accepts `is_aigc`. A blanket default label can also mislabel human-made content. Labelling is safe-side, but accuracy is the operator's duty. | `src/tools/publish-photos.ts:268,322`; `src/api/publish.ts:446` | Probe it in the P-series. Document that the default is a policy choice, not a fact. |
| LGL-10 | Low | `PULL_FROM_URL` is only advisory against verified domains, but TikTok requires the URL "on a domain you have verified". The policy also says the server "never downloads" the media, while the operator's own media host does see TikTok's fetch. | `docs/CONFIGURATION.md:251` (`TT_VERIFIED_URL_PREFIXES` "Advisory only"); Content Sharing Guidelines "Technical" | Doctor warning when the prefix list is unset and URL posting is enabled; one sentence in the policy. |

### LGL-01 — Privacy policy no longer matches the code

**What.** The page describes the 2026-08 system. The built system adds three kinds of persistent state and one egress host:

1. **`schedule.json`** (`src/mcp/schedule.ts:46`). Each entry stores `args`, "the approved tool arguments" (`:91-92`): the full title or caption, the media `file_path` or source URL, brand toggles, the profile, the `open_id` and `run_at`. Finished entries are kept for 30 days (`:66`). This directly contradicts `privacy.html:242`.
2. **`webhooks.ndjson`** (`src/mcp/webhook.ts:65`). It stores `user_openid`, `content` (TikTok's event payload) and `publish_id` (`:73-85`), rotated by size at 1 MB with one previous generation kept.
3. **Lock artifacts**: `<envfile>.lock/holder.json`, `journal.ndjson.lock`, `schedule.json.lock` (`src/core/env-lock.ts:104`, `docs/CONFIGURATION.md:32,307,329`). They are small, but "Nothing else is persisted" is a literal claim.
4. **Egress to `https://www.tiktok.com/oembed`** (`src/core/http.ts:84`, `src/api/embed.ts:31`). This is an unauthenticated public endpoint, separate from the "official Display API and Content Posting API" the page names.
5. **The webhook receiver.** It requires a public HTTPS callback, which means a reverse proxy or a non-loopback bind with `TT_HTTP_INSECURE=1` (`docs/CONFIGURATION.md:437-442`). It is an *inbound, internet-facing* endpoint authenticated by HMAC. The page says the HTTP transport "binds a loopback socket … changes nothing about where data goes" (`:296`).

**Why it matters.** DTS §III.2(c) requires "a complete and accurate disclosure to your End Users of the privacy practices". `docs/SETUP-TIKTOK-APP.md:60-68` tells operators to use these pages as "the factual half of what your own policy has to state". AUDIT.md §2.1 also plans to submit them for the owner's own app. An inaccurate policy is a reason for TikTok to reject or suspend the app. Under GDPR it is an Art. 12–13 transparency failure, and the operator inherits it.

**Failure scenario.** An operator copies "never contains the full caption" into their own policy and turns on scheduling. A user's unreleased campaign captions then sit in `schedule.json` for 30 days, a later backup leaks them, and the published policy is shown to have been false.

**Fix.** Rewrite the storage, egress, HTTP transport and deletion sections, and bump "Last updated". Then make the policy part of the `npm run sync` drift gate: a `site-sync` check that every `*_FILE` constant in `src/mcp/*.ts` and `src/cli/*.ts`, and every host constant in `src/core/http.ts`, appears in `site/privacy.html`. A future feature should not be able to silently falsify the policy again.

### LGL-02 — "Apps must not be for private or personal use"

**What.** TikTok's App Review Guidelines list "Apps must not be for private or personal use" and "Apps that are still in development or testing will not be approved". The Content Sharing Guidelines add: "The app must be intended for a wide audience, not only test use or internal/private teams." The project's deployment model, by its own terms (`site/terms.html:258`), is "a single-user process holding one operator's credentials", with each operator registering their own app.

**Why it matters.** Unaudited clients post only SELF_ONLY, to private accounts, for at most 5 users per 24 h. Unless the operator's app passes audit, those limits are permanent, and for the typical personal operator the audit is unlikely to pass. The README and site promote publishing "videos and photo carousels". Users will reasonably expect public posting, and the docs do not tell them it may never come.

**Failure scenario.** An operator spends days building a website, a policy and a demo video for the audit, and is rejected as "personal use". Or they misrepresent the app as a multi-user product to pass, which is the operator breaching TikTok's terms.

**Fix.** Add a prominent section to SETUP §7 and AUDIT.md: "What the audit will likely decide for a personal deployment". Separately, the owner decides whether the project's own audit attempt continues, and how it is framed honestly (for example, as a hosted multi-user product, which would contradict the terms' non-goals). This is an owner decision (see the open questions).

### LGL-03 — Consent model versus "express consent" and manual selection

**What.** The Content Sharing Guidelines require a creator-nickname display, a privacy dropdown "with no default value", interaction toggles off by default and turned on manually, a content preview, the declarations, and no upload "until the user has expressly consented". The code reproduces the *data* side well: no default privacy, the declarations, creator_info refresh. Four paths weaken the *human* side:

- **`TT_WRITE_MODE=apply`**: documented as "trusted automation only: this mode has no injection resistance" (`docs/CONFIGURATION.md:229-231`). Posting happens with no consent step at all.
- **`TT_ELICITATION=auto`**: when the client cannot show the dialog, "`plan_id` stays the only checkpoint" (`:239-240`). The model receives the `plan_id` and can spend it in the next tool call, and the model is also the one filling in `privacy_level`. Whether a human ever saw the preview depends on the client.
- **Batch**: one approval covers up to 10 posts across profiles (`src/tools/publish-batch.ts:41`), and items are exempt from the dialog (`docs/CONFIGURATION.md:244-245`). A reviewer will ask whether the user saw each item's creator nickname.
- **Schedule**: consent is given up to 30 days ahead (`src/mcp/schedule.ts:57`) and executed unattended by cron. The re-preview and digest check (`src/cli/run-queue.ts:11-17`) is good engineering, but it is not renewed consent. creator_info is fetched at run time, not when the user rendered the post page.

**Why it matters.** These features are the most likely place for an auditor's demo-video review, or a later enforcement action, to land. TikTok can suspend the operator's app under DTS §VI "for any reason".

**Fix.** (1) Document an "audit-safe configuration" and a per-guideline compliance matrix. (2) Owner decision: in code, refuse `TT_WRITE_MODE=apply` for any privacy level other than SELF_ONLY, or at least have `doctor` warn about it. Show each batch item's creator nickname and the rendered declarations in the batch consent. Optionally require elicitation for `run_at` scheduling.

## Open questions for the owner

1. Will you submit the project's own TikTok app for the content-sharing audit, given the "private or personal use" rejection class? If so, what audience does the submission claim, and does that match `site/terms.html` ("single-user", "not a multi-tenant hosted deployment")?
2. Should `TT_WRITE_MODE=apply` stay available for public posts at all, or be limited to SELF_ONLY or drafts (`upload_*_draft`, where TikTok's in-app flow supplies the consent)?
3. Should scheduled posts need fresh consent (for example, only drafts can be scheduled, or a schedule horizon of hours rather than 30 days)?
4. Will you rebrand the visual identity (cyan/red palette, "TikTok MCP" display name) before the site goes live via G-4, or accept the trade-dress risk?
5. If a TikTok/ByteDance trademark complaint ever reaches npm or the VS Code Marketplace, which fallback name do you want (scoped `@ivanbbaev/…`, or a name without the mark)?
6. Should the project ship an operator privacy-policy and terms *template* with the GDPR roles filled in, given that operators currently have to write their own from scratch?

## Proposed roadmap items

#### LGL-R1 — Make the privacy policy and terms describe the built system, and gate them against drift
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking.** Rewrite `site/privacy.html` storage, egress, HTTP transport, AI-client and deletion sections. Add `schedule.json` (fields, 30-day retention), `webhooks.ndjson` (fields, 1 MB rotation), the lock artifacts, the `run-queue` log the docs suggest, the `www.tiktok.com/oembed` egress and the internet-facing webhook receiver. Replace "There is no controller" with an explicit roles section: the author is neither controller nor processor of runtime data; the operator is the controller of their app's data; the author is the controller of the website. Fix the stale version wording ("pre-1.0", "0.x") and the `og:image:alt` tool counts. Bump "Last updated". Extend `scripts/site-sync.ts` so `npm run sync` fails when a persisted-file constant or an egress host constant is missing from `site/privacy.html`.
- **Owns:** `site/privacy.html`, `site/terms.html`
- **Shared:** `scripts/site-sync.ts`, `SECURITY.md` (version wording only)
- **Acceptance:**
  - Every filename persisted under the env directory in `src/` (`journal.ndjson`, `schedule.json`, `webhooks.ndjson`, locks) and every host in `src/core/http.ts` appears in `site/privacy.html`.
  - Removing one of them from the page makes `npm run sync` fail.
  - No sentence claims "two files", "complete set" or "never … full caption" unless it is true.
  - `site/terms.html`, `SECURITY.md` and `package.json` agree on the release status.
  - `npm run check` is green.

#### LGL-R2 — Complete the data-deletion story: purge command, revocation clean-up, age-based retention
Deps LGL-R1 · Status todo · Est 4 h

- **Scope:** Add `tiktok-mcp-ai purge [--profile <name>] [--all]`. It deletes tokens, the journal (both generations), schedule entries, webhook records and stale locks, and prints exactly what it removed. `login --revoke` and the `authorization.removed` webhook cancel the revoked profile's pending schedule entries, with the reason `authorization_removed`. Optional `TT_JOURNAL_MAX_AGE_DAYS` / `TT_WEBHOOK_LOG_MAX_AGE_DAYS` prune by age on append. `doctor` lists every local data file and its size.
- **Owns:** `src/cli/purge.ts`, `test/cli/purge.test.ts`
- **Shared:** `src/cli/index.ts`, `src/cli/login.ts`, `src/core/oauth.ts`, `src/mcp/schedule.ts`, `src/mcp/journal.ts`, `src/mcp/webhook.ts`, `src/cli/doctor.ts`, `docs/CONFIGURATION.md`, `site/privacy.html` (deletion section)
- **Acceptance:**
  - After `purge --all`, no file written by the server remains in the env directory (test).
  - A revoked profile has 0 `pending` schedule entries (tests for both the revoke and the webhook paths).
  - With the age variables set, entries older than N days are pruned on the next append (test).
  - The privacy "Deleting your data" section names the command.
  - `npm run check` is green with the coverage gate met.

#### LGL-R3 — Publish an operator platform-compliance guide (audit eligibility, consent matrix, app naming, policy template)
Deps LGL-R1 · Status todo · Est 4 h

- **Scope:** **Release-blocking.** Add to `docs/AUDIT.md` and `docs/SETUP-TIKTOK-APP.md`:
  - A prominent "personal-use rejection class" warning, quoting the App Review and Content Sharing Guidelines with URLs and access dates. It must say that SELF_ONLY plus 5 users per 24 h may be permanent for personal deployments.
  - A per-requirement Content Sharing Guidelines compliance matrix: requirement → how the server satisfies it → which config breaks it (`TT_WRITE_MODE=apply`, `TT_ELICITATION=auto/off`, batch, `run_at`).
  - An "audit-safe configuration" for the demo video.
  - Portal app-name and icon guidance: no "TikTok" in the app name, no TikTok-confusable icon or colours.
  - An operator privacy-policy and terms template with the GDPR roles, the TikTok C2C Data Terms reference and the full local-data inventory.
- **Owns:** `docs/OPERATOR-POLICY-TEMPLATE.md`
- **Shared:** `docs/AUDIT.md`, `docs/SETUP-TIKTOK-APP.md`, `README.md` (one-line pointer)
- **Acceptance:**
  - AUDIT.md §2 lists "private or personal use" and "wide audience" as rejection classes, with cited URLs.
  - The matrix covers every bullet of the Content Sharing Guidelines "Direct Post API Requirements".
  - SETUP §1 contains app-name and icon rules.
  - The template names the controller, the data inventory, retention, deletion and the AI-vendor disclosure.
  - `npm run sync` is green.

#### LGL-R4 — Tighten consent on the unattended and multi-post write paths
Deps LGL-R3 · Status blocked: owner decision (open questions 2–3) · Est 5 h

- **Scope:**
  - Refuse `TT_WRITE_MODE=apply` for direct posts whose `privacy_level` is not `SELF_ONLY` (drafts are unaffected), or, if the owner prefers, `doctor` and startup warn about it.
  - The batch consent dialog and preview show each item's creator nickname, privacy level, disclosure labels and declaration text.
  - Elicitation is required for an apply carrying `run_at` when the client supports it. The schedule horizon becomes configurable (`TT_SCHEDULE_MAX_HORIZON_H`).
- **Owns:** `test/tools/consent-compliance.test.ts`
- **Shared:** `src/core/settings.ts`, `src/mcp/plan.ts`, `src/mcp/consent.ts`, `src/tools/publish-batch.ts`, `src/tools/schedule.ts`, `src/mcp/schedule.ts`, `docs/CONFIGURATION.md`, `docs/TOOLS.md`
- **Acceptance:**
  - A test proves an `apply`-mode `PUBLIC_TO_EVERYONE` post is refused, or warned about, per the owner's decision.
  - The batch elicitation payload contains one nickname per item (test).
  - The horizon variable is honoured (test).
  - `npm run check` is green.

#### LGL-R5 — Remove TikTok trade dress and third-party font loading from the site and extension
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking** (the site goes live with G-4).
  - Replace the `#00f2ea`/`#ff0050` accent pair and gradient in `site/assets/styles.css`, the favicons and `og-banner.svg`/`og-image.png` with a non-TikTok palette.
  - Self-host the three web fonts, or use system fonts, so no visitor request reaches Google.
  - Rename the extension `displayName` and MCP server label to a form that leads with the project, not the mark, and says "Unofficial" (for example "MCP Server for TikTok (Unofficial)").
  - Update the "This website" paragraph of the privacy page.
- **Owns:** `site/assets/styles.css`, `site/assets/og-banner.svg`, `site/assets/og-image.png`, `extension/package.json`, `extension/src/extension.ts`
- **Shared:** `site/index.html`, `site/privacy.html`, `site/terms.html` (favicon and font links)
- **Acceptance:**
  - `grep -ri "00f2ea\|ff0050\|fonts.googleapis\|fonts.gstatic" site/ extension/` returns nothing.
  - The extension `displayName` contains "Unofficial" and does not start with "TikTok".
  - The privacy page no longer mentions Google Fonts.
  - The site renders, checked with the screenshot tooling or a manual browser check.

## Top recommendation

Before Pages goes live and before anyone copies the privacy page, rewrite it to match the code and gate it against drift (LGL-R1), and tell operators plainly that a personal-use app will probably never pass TikTok's audit (LGL-R3).
