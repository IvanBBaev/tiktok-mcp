# Round 3 — Product / OSS strategy review

Date 2026-10-29 · commit `301b9bb` · reviewer role: senior Product Manager / open-source developer-tools strategist · scope: target user and value reachability, setup friction, scope and effort allocation, the B1/B2 bets, docs volume vs. what a user reads, competitive position, a ship-it plan with a scope freeze and 90-day metrics. Read-only review. The competitive data was fetched live on 2026-10-29 (GitHub API, npm registry and downloads API, the official MCP registry, TikTok developer docs).

## Verdict

As engineering, the project is excellent. As a product, it does not exist yet. Nothing has shipped: `npm view tiktok-mcp-ai` returns E404, there are no tags and no releases. No line of code has met the real TikTok API (PROBE-LOG: every live probe is `not run`). In the six days after "1.0.0" was prepared, eleven new features landed (+4,942 src / +6,038 test lines since `effde25`). The bigger problem is strategic, and nothing in the repo addresses it. The project's model is "bring your own TikTok app". TikTok's App Review Guidelines say verbatim: **"Apps must not be for private or personal use."** So an individual's app will most likely never pass review. That leaves the core user in sandbox or unaudited mode for good: `SELF_ONLY`, private account only, at most 10 sandbox target users. README's hero feature (public "safe publishing", `PUBLIC_TO_EVERYONE` in the Quick demo) is out of that user's reach. The value they can actually reach is **reading your own account and analytics, plus drafts sent to your TikTok inbox**, and the product should be positioned and shipped around that. Two direct competitors already ship. `@thenavidm/tiktok-mcp-cli` uses the same bring-your-own-app model, has been on npm since 2026-09-03 and gets 449 downloads a month. `postoncehq/tiktok-mcp` is hosted, uses an audited app and needs "no developer app". **Readiness score: 3/10.** The code is ready, but the product is unshipped, unvalidated, mispositioned for the user it can actually serve, and its scope is still growing.

## What is strong

- **Real differentiators exist, and they suit a cautious AI-agent audience.** Plan-then-execute writes with a single-use `plan_id`, a write-ahead publish journal, least-privilege login scopes, and a default `TT_TOOL_PACKAGES=core` that registers reads only (`docs/CONFIGURATION.md:211`). No competitor I inspected offers this.
- **The setup docs are honest and precise about the gate.** They cover the redirect-URI shape (`docs/SETUP-TIKTOK-APP.md:101-128`, consistent with TikTok's Login Kit for Desktop rules), the audit gate (`:195-216`) and why the project's own privacy and terms pages must not be submitted as the user's own (`:56-68`).
- **Distribution plumbing is pre-built.** npm, the MCP registry, the VS Code extension and the Claude Code plugin all follow one tag (`docs/AUDIT.md:201-217`). Once the manual first publish happens, the reach is wider than any competitor's.
- **The local-first, no-third-party-holds-your-token story is real.** It sets this project apart from PostOnce, TikNeuron, Apify and HasData, which are hosted or proxied.

## Competitive landscape (accessed 2026-10-29)

| Project | Stars / npm downloads (30 d) | Approach | Auth model | Relevance |
|---|---|---|---|---|
| [Seym0n/tiktok-mcp](https://github.com/Seym0n/tiktok-mcp) | 208 ★ | Subtitles and virality analysis of public videos | Third-party TikNeuron API key, `.mcpb` bundle | Leader by stars. A different job (research, not your own account) |
| [yap-audio/tiktok-mcp](https://github.com/yap-audio/tiktok-mcp) | 77 ★ | Discovery and metadata of public videos | Scraping/unofficial | Different job |
| [HasData/tiktok-mcp](https://github.com/HasData/tiktok-mcp) | 12 ★ / 265 dl | Public profiles, videos, comments, search | Hosted API key | Different job |
| [postoncehq/tiktok-mcp](https://github.com/postoncehq/tiktok-mcp) | 3 ★ (created 2026-09-29) | **Publish, schedule, drafts through the official API**, plus content skills | Hosted PostOnce account; "no TikTok developer app to set up". 7-day free trial, then paid | **Direct substitute for the write story, with zero setup friction** |
| [thenavidm/tiktok-mcp-cli](https://github.com/thenavidm/tiktok-mcp-cli) (`@thenavidm/tiktok-mcp-cli`) | 1 ★ / **449 dl**, published 2026-09-03, 2.0.1 on 2026-10-05 | 14 tools: profile, stats, top posts, video/photo publish, drafts, status | **Same BYO-app model** as this project | **Direct competitor in the same niche, already shipping** |
| [0xArtex/tiktok-mcp](https://github.com/0xArtex/tiktok-mcp) | 2 ★ | Post, schedule, follow, like | Browser automation (Playwright, QR login) | Against TikTok's terms. Not a peer |
| `redfox-tiktok-mcp` (npm) | 494 dl | Hosted | API key | Different job |
| **IvanBBaev/tiktok-mcp** | 1 ★ / **unpublished** | 17 tools, official APIs, write safety | BYO app | — |

The official MCP registry (`registry.modelcontextprotocol.io/v0/servers?search=tiktok`) lists only hosted data or ads servers (trendhaus, trendsapi, toptik, pipeboard ads). There is **no official-API, own-account server there yet**, so that slot is still open. It will not stay open for long.

Takeaways. (1) The "your own account, official API" niche has a live competitor that shipped almost two months ago. Every week this project stays unpublished costs it the "first trustworthy one" position. (2) Users who want to **publish publicly** will choose PostOnce, because it already holds an audited app. This project cannot win that user without becoming a hosted, multi-tenant service (an explicit non-goal). (3) The defensible position is **local-first, no middleman, safe-by-default, for developers and technical creators**: read, analyse, draft.

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| PRD-01 | Critical | Zero releases after 3 months, and no user has ever been able to install it. Two owner-only actions (manual first npm publish, G-14; enable Pages, G-4) have blocked every release since 2026-08-26 (64 days). In that time 67 commits landed in October alone. | `npm view` E404; `git ls-remote --tags` empty; `docs/IMPLEMENTATION-PLAN.md:193,203`; WORKLOG `## 2026-08-26 — Cut and push 0.7.0; npm publish blocked on trusted-publisher setup`; `git log` per month: Jul 7, Aug 12, Sep 1, Oct 67 | Scope freeze now (PRD-R1). The owner runs G-4/G-14 this week (PRD-R4). Do no feature work until a version is on npm. |
| PRD-02 | Critical | The bring-your-own-app model collides with TikTok's review rule "Apps must not be for private or personal use" (also "Apps that are still in development or testing will not be approved"). An individual's app most likely never reaches production, so public posting, the README hero, is out of reach for the core user. Nothing in the repo mentions this rule. | [TikTok App Review Guidelines](https://developers.tiktok.com/doc/app-review-guidelines) (accessed 2026-10-29); `grep -i 'personal' docs/AUDIT.md docs/SETUP-TIKTOK-APP.md` → no match; README Quick demo `README.md:38,55,73` (`PUBLIC_TO_EVERYONE`) | Reposition around reachable value (PRD-R5). Document "permanent sandbox / unaudited" as the supported mode for individuals. Answer the "who submits an audit, for which app" question in the docs. |
| PRD-03 | High | No real-API validation. All live probes are `not run`, and the Phase-2 exit gate (a real SELF_ONLY post plus a draft reaching the inbox) was never met. The 2,415 tests and 99.81% coverage verify the code against the spec, not against TikTok. If shipped this way, the first user is the first integration test. | `docs/probes/PROBE-LOG.md:12-13,136-153`; `docs/ROADMAP.md` Phase 2 exit gate; WORKLOG: 2 probe-related sessions (fixtures spine, runbook), 0 probes executed | Make a ~2-hour core-path smoke against a sandbox account a release gate (PRD-R2). Record P-3, P-4, P-10, P-11 and P-14 at minimum. |
| PRD-04 | High | Scope expansion after the declared freeze. v1.0 was defined as "the 11-tool surface frozen under semver". `main` now has 17 tools, and `[Unreleased]` holds 14 user-visible bullets (DNS pin ×3, elicitation, batch, scheduling, webhooks ×3, concurrency cap, embed, …). 24 commits since `effde25` add +4,942 src and +6,038 test lines. B1/B2/B3 stay queued. | `docs/ROADMAP.md:63`; `docs/IMPLEMENTATION-PLAN.md:165`; `CHANGELOG.md:13-118`; `docs/tool-manifest.json` (17 tools); `git diff --shortstat effde25 HEAD -- src test` | Freeze the surface (PRD-R1). Mark webhooks, scheduler, batch and embed as **experimental**, outside the semver promise, until real users exercise them (PRD-R6). |
| PRD-05 | High | Effort allocation is inverted against risk. Of the 81 WORKLOG sessions (keyword match on headings, categories overlap): about 18 went to review rounds, about 9 to coverage and branch sweeps, 7 to dependency hygiene, 4 to CI/flake/Windows, about 10 to v2 features, and **0 to running anything against TikTok**. The project's biggest unknown, whether TikTok behaves as the spec assumes, got the least investment. | `grep '^## ' WORKLOG.md` (e.g. "Review round 1…15", "Coverage exclusions driven down: 47 hints → 15 / 0", "Every uncovered branch … given a verdict") | Rebalance: the next 10 hours go to real-API validation and release. Hold further review rounds until user-reported issues exist. |
| PRD-06 | High | The release identity is false or inconsistent. `CHANGELOG.md` `[1.0.0] - 2026-10-23` says "The first version published to npm", but it was never published. `package.json`, `server.json` and the extension all say 1.0.0, while `main` carries `[Unreleased]` content that `release-guard` will refuse to ship as 1.0.0. Promising semver stability for an API surface never exercised against the platform is a commitment the project cannot back yet. | `CHANGELOG.md:119-125`; `package.json:3`; `server.json:9,14`; `extension/package.json:5`; release-guard rule "no entries stranded under [Unreleased]" (`docs/IMPLEMENTATION-PLAN.md:199`) | Owner decision (Q1). Recommended: fold everything into a first public **0.9.0** and promote to 1.0.0 after 30 days with no surface-breaking findings. The alternative is a re-dated 1.0.0 cut from HEAD. Either way, rewrite the false sentence (PRD-R3). |
| PRD-07 | High | Several new features have near-zero reachable value for the core user. Webhooks need a public HTTPS URL, one callback per app, and the HTTP transport, which a local stdio user does not have. Scheduling only produces `SELF_ONLY` posts on an unaudited app, and the machine must be on with cron. Batch/multi-profile hits the 5-users/24 h cap and the private-account rule, and agencies, its natural user, are exactly whom the personal-use rule excludes. Embed sits on an endpoint TikTok marks "deprecated soon". | `CHANGELOG.md:23-60,87`; `docs/CONFIGURATION.md:337-348`; `docs/ai/V2-ANALYSIS.md` §1 (oEmbed "deprecated soon"); `docs/TIKTOK-API.md` §7 | Do not delete them. Freeze them, label them experimental, keep them out of README's hero and feature list, and let issues and downloads decide whether they graduate (PRD-R6). |
| PRD-08 | Medium | The setup-friction estimate is optimistic. "Plan for 15 minutes" covers only the portal app. The real path is: developer account → app → Login Kit + Display + Content Posting → sandbox → add your own account as a target user (requires its login credentials, and the account may take up to an hour to appear) → redirect URI → env file → `login` → `doctor` → make the account private for direct posts. For a non-developer creator this means 45–90 minutes and several failure points. | `docs/SETUP-TIKTOK-APP.md:8-10,177-193`; [TikTok "Add a sandbox"](https://developers.tiktok.com/doc/add-a-sandbox) (10 target users, credentials required, up to 1 h delay; accessed 2026-10-29) | State an honest 30–60 minutes and the persona ("you are comfortable with a developer portal"). Add a sandbox-first fast path at the top (PRD-R5). Measure it (PRD-R7). |
| PRD-09 | Medium | The docs volume is far beyond what any user reads: about 910 KB of `docs/*.md` (CONTRACTS.md 285 KB, TOOLS.md 130 KB, TESTING.md 73 KB), README 48 KB / 644 lines, site 154 KB. A user reads README, SETUP, CLIENTS and TROUBLESHOOTING (≈ 100 KB). The rest is internal specification, presented at the same level, so the reader cannot tell where to start. README badges point at an npm package that 404s. | `wc -c docs/*.md README.md site/*.html`; `README.md:3,5` (npm/downloads/node/license/snyk badges on an E404 package) | After the release, a docs diet: README ≤ 15 KB with deep links, and internal specs moved under `docs/internals/` (PRD-R9). Not release-blocking, except that the badges must resolve once published. |
| PRD-10 | Medium | The B1/B2 bets target different personas and have unresolved access risk. B1 (Commercial Content API) serves EU ad-library researchers and marketers, with a new auth mode, and has no link to the own-account creator. B2 (Business API) is the highest-value feature (comments, insights), but V2-ANALYSIS notes it "may be company-only since 2026-03". It also faces the same personal-use review problem and is estimated at 30 h + 3 h (B3). | `docs/ROADMAP.md` B1/B2-SPIKE/B2/B3; `docs/ai/V2-ANALYSIS.md` §1, §2 Tier B | **Cut B1** (move to non-goals). **Defer B2-SPIKE** until the 90-day metrics show retained users who ask for comments or insights. B3 follows B2. |
| PRD-11 | Medium | No feedback loop is defined. Without telemetry (correct for this product), success can only be read from npm downloads, GitHub stars and issues, and setup reports. Nothing invites those signals: there is no "setup worked / failed at step N" issue template and no success metric anywhere in ROADMAP. | `docs/ROADMAP.md` (no metrics section); `.github/` has no setup-report template (not verified file by file) | Add the 90-day metrics and a setup-report issue template (PRD-R7). |
| PRD-12 | Low | Maintainer hygiene signals: 3 Dependabot PRs open for 3–7 days (#36, #37, #38), 1 star, 1 fork. Fine at this stage, but a stale PR list is the first thing an evaluator sees. | `gh pr list` | Merge or close them before the release announcement. |

### PRD-01 — Zero releases (Critical)

**What.** Since 2026-08-26 every release has been blocked by two owner-only steps, each about 30 minutes: the manual first `npm publish` with the trusted-publisher configuration (G-14), and enabling GitHub Pages and running `pages.yml` (G-4). Neither step needs code. The repo itself says so ("an owner action with nothing left for the repo to contribute", `docs/IMPLEMENTATION-PLAN.md:203`). **Why it matters.** An OSS developer tool earns adoption, issues and contributors only once it is installable. Every unshipped week compounds three risks: a competitor becomes the default answer (thenavidm has been on npm since 2026-09-03), the TikTok API drifts away from the spec, and the maintainer burns out on work nobody uses. **Failure scenario.** Another month of v1.x/v2 features, still unpublished, and the official MCP registry slot for "TikTok, official API, own account" goes to someone else. **Fix.** PRD-R1 (freeze), PRD-R2 (smoke), PRD-R3 (version identity), PRD-R4 (owner publish). Target: on npm within 7 days.

### PRD-02 — The audit is not reachable for the core user (Critical)

**What.** The repo treats "submit the audit" as the path to public posting (`docs/ROADMAP.md` Phase 3, `docs/AUDIT.md`). That path exists for a **product** with its own users, website and UI. A developer who installs this server registers a personal app for their own account, which is precisely what TikTok's guidelines exclude. The owner's own audit, if it ever passes, helps nobody else, because the server ships no credentials (`docs/SETUP-TIKTOK-APP.md:3-6`). **Why it matters.** The value proposition on the first screen (README Quick demo: post `PUBLIC_TO_EVERYONE`) is something the reader cannot get. The first-run experience then becomes `unaudited_client_can_only_post_to_private_accounts` (403) on a creator's public account. Expectations get broken at the worst possible moment. **What is actually reachable** (to be confirmed by PRD-R2): reads and computed analytics of your own account in sandbox; inbox drafts (`video.upload`), where the human finishes and chooses privacy in the TikTok app. That fits the project's human-in-the-loop safety story naturally. Whether drafts need a private account or count against the 5-user cap is probe P-10, which has not been run. Also reachable: `SELF_ONLY` direct posts for a private test account. **Fix.** Reposition (PRD-R5). Lead with "Ask your AI about your TikTok performance; let it prepare drafts in your inbox". Document sandbox as the supported mode for individuals. Quote the personal-use rule in SETUP §7 and AUDIT §3. Keep the audit playbook for the minority who build a real product on top. Owner question Q2 covers whether to pursue a hosted, audited app at all.

### PRD-03 — No real-API validation (High)

**What / why.** The whole HTTP, OAuth and upload stack (core/http.ts 1,807 lines, oauth.ts 1,135, upload.ts) is built from a transcription of TikTok docs. Its edge cases (chunk-PUT status codes P-11, refresh-rotation grace P-3, upload URL anatomy P-14) are explicitly open questions. **Failure scenario.** The first public user hits a 416 or an unexpected envelope on chunk upload, and the published 1.0.0 "stable" contract must break in week one. **Fix.** PRD-R2: a scripted 2-hour owner session on a sandbox app covering login → auth_status → user_info → list_videos → analytics → video draft → SELF_ONLY post on a private account → publish_status → duplicate execute blocked → revoke. Record the results in PROBE-LOG. If any assumption breaks, fix it before tagging.

### PRD-04 / PRD-05 — Scope creep and an inverted allocation (High)

**What.** v1.0 was declared frozen at 11 tools. Six tools and roughly 11k lines of src and tests were added afterwards, before any user existed. Review rounds 1–15 and the coverage sweeps (to 99.81% lines) took more sessions than the whole v2 feature track, and none of them reduced the platform risk. **Why it matters.** Every feature added before release enlarges the semver surface frozen at 1.0, and the docs/contract surface the maintainer must keep in sync (CONTRACTS.md 3,616 lines). It also adds to what the first users can hit, all without demand evidence. **Fix.** A written freeze in ROADMAP (PRD-R1): no new tools, packages or `TT_*` settings until 90 days after the first publish or 3 independent feature requests, whichever comes first. Bug fixes and probe-driven fixes only. A 2-week hold on further review rounds and coverage ratchets.

### PRD-06 — False release identity (High)

**What.** The changelog claims a publish that never happened. The version fields claim 1.0.0 for code that has moved on since. **Why it matters.** The repo's own credibility rests on precision, and a reviewer (TikTok's, or an evaluator on GitHub) who checks `npm view` finds a contradiction in the first paragraph. Semver 1.0 promises a stable surface that has not met the API. **Fix.** PRD-R3 per the owner's choice in Q1. Recommendation: **0.9.0**, a non-prerelease semver that the VS Code Marketplace accepts, covering the 11 core tools plus the experimental extras. 1.0.0 follows after 30 days of real use with no surface-breaking findings and the probes recorded.

### PRD-07 — Low-reach features (High)

**Ranking** (value to the reachable persona vs. sessions spent; value is my judgement, effort comes from WORKLOG and line counts):

| Feature | Reachable value | Effort sunk | Disposition |
|---|---|---|---|
| Read tools + **analytics** (`tiktok_get_video_analytics`, ~1.1k lines incl. tests) | **High.** Works in sandbox, read-only scopes, the most common creator question ("what performed?") | 1 session | **Hero** — lead with it |
| **Inbox drafts** (video and photos) | **High** if P-10 confirms it works for public accounts | part of TD-6 | **Hero** — lead with it |
| Plan-then-execute + journal | High as a differentiator (trust) | the core of Phase 2 | Keep as a supporting message |
| Elicitation consent (`consent.ts` 162 lines) | Medium. Only clients that support elicitation, falls back cleanly | 1 session | Keep, default `auto` |
| Media pre-flight, per-host cap, DNS pin ×3 | Low visible value, real hardening | ~4 sessions | Keep. Do not market it |
| Scheduling + `run-queue` (~1.6k lines) | Low. SELF_ONLY on unaudited apps, machine must be on | 1 session | **Experimental**, out of the README hero |
| Batch / multi-profile (~1k lines) | Low. 5-user cap, agency persona excluded by review rules | 1 session | **Experimental** |
| Webhooks + revocation + subscriptions (~1.9k lines) | Very low for stdio users. Needs public HTTPS and the HTTP transport | 3 commits | **Experimental**, documented only in CONFIGURATION |
| Embed (oEmbed, ~650 lines) | Low; endpoint "deprecated soon" | 1 session | **Experimental**, already opt-in |
| B1 adlib | Different persona | 0 (12 h est.) | **Cut** |
| B2/B3 Business API | Highest in theory, access unknown | 0 (33 h est.) | **Defer**, gated by the 90-day signal |

## Open questions for the owner

1. **Version of the first public release:** 0.9.0 (recommended: room to break the surface after real-API findings), or a re-cut 1.0.0 from HEAD with the experimental features carved out of the semver promise?
2. **Do you want a public-posting product at all?** Only an audited app held by an operator makes public posting reachable for others, and that means a hosted, multi-tenant service (today an explicit non-goal, and PostOnce's business). If no, accept and document that this is a local-first read + draft + private-test-post tool for developers. If yes, it is a different project with legal, privacy and ops commitments. Decide that before writing B2.
3. **Will you run the 2-hour sandbox smoke yourself this week?** It needs your TikTok account credentials for the sandbox target user, and no agent can do it.
4. **Is your own account public?** If it is, direct posting is unusable for you on an unaudited app, which makes drafts the only write path you can demo.
5. **Experimental features: freeze or quarantine?** Keep webhooks, scheduler, batch and embed in the package, marked experimental (recommended), or move them behind an explicit `TT_EXPERIMENTAL=1` so they cannot be enabled by `all`?
6. **B1:** may it move to non-goals?

## Proposed roadmap items

#### PRD-R1 — Declare a scope freeze and defer the B-track
Deps — · Status todo · Est 0.5 h

- **Scope:** **Release-blocking.** Add a "Scope freeze" section at the top of the Parallel work queue in `docs/ROADMAP.md`. It says: no new tools, tool packages or `TT_*` settings until 90 days after the first npm publish, or until 3 independent issues request a feature; only bug fixes, probe-driven fixes and release work are admitted. Flip B1 to `Status blocked: frozen (moved to non-goals)` and add it to § Explicit non-goals. Flip B2-SPIKE/B2/B3 to `blocked: frozen until the 90-day review (PRD-R8)`.
- **Owns:** `docs/ROADMAP.md` (freeze section; B1, B2-SPIKE, B2, B3 status lines; non-goals list)
- **Shared:** —
- **Acceptance:**
  - `docs/ROADMAP.md` contains a "Scope freeze" section with the end condition stated.
  - No item in the queue is `todo` except release and validation items.
  - B1 appears under § Explicit non-goals.

#### PRD-R2 — Run the core-path smoke against a real sandbox account
Deps — · Status blocked: owner (needs a sandbox app with their own account as a target user) · Est 3 h

- **Scope:** **Release-blocking.** One scripted session against a TikTok sandbox app: `login` → `doctor` green → `tiktok_get_auth_status` → `tiktok_get_user_info` → `tiktok_list_videos` → `tiktok_get_video_analytics` → `tiktok_upload_video_draft` (FILE_UPLOAD) reaching the inbox → `tiktok_post_video` SELF_ONLY on a private account → `tiktok_get_publish_status` to completion → a duplicate execute with the same `plan_id` refused → `login --revoke`. Record P-3, P-4, P-10, P-11 and P-14 along the way. Note whether a draft on a **public** account works (P-10 adjacent). Any spec mismatch becomes its own fix item before tagging.
- **Owns:** `docs/probes/PROBE-LOG.md` (result rows only)
- **Shared:** `docs/TIKTOK-API.md` (only where a probe overturns a stated assumption)
- **Acceptance:**
  - PROBE-LOG shows P-3, P-4, P-10, P-11 and P-14 with status `run` and redacted evidence.
  - A new PROBE-LOG section "Core-path smoke <date>" lists each of the 11 steps as pass or fail.
  - Every failure has a linked roadmap fix item; the first release waits for all of them.

#### PRD-R3 — Make the release identity true
Deps PRD-R1 · Status todo · Est 1.5 h

- **Scope:** **Release-blocking.** Apply the owner's choice from Q1. Recommended path: rename the unpublished `[1.0.0]` and fold `[Unreleased]` into `[0.9.0] - <publish date>`, saying that 0.7.0/0.8.0/1.0.0 were internal milestones never published. Set every version field to 0.9.0. Delete the sentence "The first version published to npm" unless it becomes true. Keep `release-guard --tag v0.9.0` green.
- **Owns:** `CHANGELOG.md` (version headings and the 1.0.0 intro paragraph), `package.json` (version), `package-lock.json` (version), `server.json`, `extension/package.json`
- **Shared:** `docs/AUDIT.md` § 2.6 (the version to cite), `docs/IMPLEMENTATION-PLAN.md` § Road to v1.0 (state that 1.0 follows 0.9 + 30 days)
- **Acceptance:**
  - `grep -n 'first version published' CHANGELOG.md` matches only the version actually published.
  - All four version fields agree.
  - `npm run release:guard -- --tag v0.9.0` (or the chosen tag) passes.
  - `npm run check` is green.

#### PRD-R4 — Owner: enable Pages and do the first manual npm publish
Deps PRD-R2, PRD-R3 · Status blocked: owner (G-4, G-14) · Est 1 h

- **Scope:** **Release-blocking.** Enable GitHub Pages (Source = GitHub Actions) and run `pages.yml`. Do the manual `npm publish` of the chosen version together with the trusted-publisher configuration, then push the tag so the GitHub release, VS Code Marketplace and MCP registry follow. Merge or close Dependabot PRs #36–#38 first.
- **Owns:** — (no repo files; the follow-up flips G-4/G-14 in `docs/IMPLEMENTATION-PLAN.md`)
- **Shared:** `docs/IMPLEMENTATION-PLAN.md` (G-4, G-14 rows)
- **Acceptance:**
  - `npm view tiktok-mcp-ai version` returns the tagged version.
  - `https://ivanbbaev.github.io/tiktok-mcp/privacy.html` returns 200.
  - A GitHub release exists for the tag; the MCP registry search for `tiktok` lists the server.
  - Every README badge renders a value, none "not found".
  - `gh pr list` shows no Dependabot PR older than 7 days.

#### PRD-R5 — Reposition README and setup around the reachable value
Deps PRD-R2 · Status todo · Est 4 h

- **Scope:** **Release-blocking.** Rewrite the README opening and Quick demo around "analyse your own account + prepare drafts in your inbox, local-first, nothing posts without your approval". The demo uses a draft or a SELF_ONLY post, not `PUBLIC_TO_EVERYONE`. Add a "Who this is for / what TikTok lets an individual do" box near the top: sandbox app, up to 10 target accounts, SELF_ONLY + private account for direct posts, public posting only for an app that passes review, plus the verbatim guideline "Apps must not be for private or personal use" with its URL and access date. In `docs/SETUP-TIKTOK-APP.md`, replace "15 minutes" with an honest range and add a sandbox-first fast path. Cite the same rule in `docs/AUDIT.md` §3 as rejection class 7. Feature list order: reads and analytics, drafts, safe writes; experimental features in a separate short list.
- **Owns:** `docs/SETUP-TIKTOK-APP.md`, `docs/AUDIT.md` (§ 3 table and intro)
- **Shared:** `README.md` (the hand-written parts only; regenerate the generated parts per the shared-files rule), `site/index.html` (hero text only)
- **Acceptance:**
  - `grep -n PUBLIC_TO_EVERYONE README.md` returns no match inside § Quick demo.
  - `grep -n 'private or personal use' docs/SETUP-TIKTOK-APP.md docs/AUDIT.md` matches both files.
  - README's first screen (≤ 40 lines after the badges) states the persona and the SELF_ONLY reality.
  - `npm run check` is green (docs-sync gates included).

#### PRD-R6 — Label the low-reach features experimental
Deps PRD-R1 · Status todo · Est 2 h

- **Scope:** **Release-blocking.** Mark scheduling (`run_at`, `run-queue`, `tiktok_list_scheduled`, `tiktok_cancel_scheduled`), `tiktok_publish_batch`, the webhook receiver, publish-status subscriptions and `tiktok_get_embed` as **Experimental**: excluded from the compatibility policy until promoted. Add an `Experimental:` prefix to their TOOLS.md entries and a sentence in their tool descriptions, plus a CHANGELOG note. Optionally (owner Q5) gate them behind `TT_EXPERIMENTAL=1`, which needs the settings hotspot.
- **Owns:** `docs/TOOLS.md` (the affected entries' status lines)
- **Shared:** `docs/SECURITY.md` § Compatibility and deprecation policy (one paragraph defining "experimental"), `CHANGELOG.md`, tool description strings in `src/tools/schedule.ts`, `src/tools/publish-batch.ts`, `src/tools/webhooks.ts`, `src/tools/embed.ts`, regenerated README/manifest
- **Acceptance:**
  - The compatibility policy defines "experimental" and lists the features.
  - Each affected tool description starts with or contains "Experimental".
  - `npm run check` is green.

#### PRD-R7 — Define the 90-day success metrics and the feedback channel
Deps PRD-R4 · Status todo · Est 2 h

- **Scope:** Add a "Post-release metrics" section to `docs/ROADMAP.md` with targets for day 30, 60 and 90 (below). Add a GitHub issue template "Setup report", which asks for the step reached (1–9 of SETUP), the time taken, sandbox or production, and redacted `doctor --json`. Add a short weekly log table in the same section, filled from the npm downloads API and `gh`. No telemetry in the product.
- **Owns:** `.github/ISSUE_TEMPLATE/setup-report.yml`
- **Shared:** `docs/ROADMAP.md` (new section)
- **Acceptance:**
  - The template renders on GitHub's new-issue page.
  - ROADMAP lists the metrics with numeric targets and their data sources.

#### PRD-R8 — Hold the 90-day review and decide B2 on evidence
Deps PRD-R7 · Status blocked: 90 days after the first publish · Est 1 h

- **Scope:** Compare the metrics with their targets. Promote experimental features that real users exercised; deprecate the ones nobody touched (the policy's grace period applies). Decide GO or NO-GO on B2-SPIKE only if at least 3 independent requests for comments or insights exist. Decide 1.0.0 if no surface-breaking findings remain open.
- **Owns:** `docs/ROADMAP.md` (the review entry)
- **Shared:** `CHANGELOG.md` (promotions/deprecations)
- **Acceptance:**
  - A dated review entry with the metrics vs. targets, and a decision on each experimental feature and on B2.

#### PRD-R9 — Docs diet: separate user docs from internal specs
Deps PRD-R4 · Status todo · Est 4 h

- **Scope:** Shrink README to ≤ 15 KB: the persona box, quickstart, tool table and links. Move the detail to the existing docs. Move internal specification docs (`CONTRACTS.md`, `TESTING.md`, `CORNER-CASES.md`, `TASK-BREAKDOWN.md`, `IMPLEMENTATION-PLAN.md`) under `docs/internals/` with a one-line index. Fix the links and the docs-sync gates accordingly. Keep SETUP, CLIENTS, CONFIGURATION, TROUBLESHOOTING, TOOLS, SECURITY and AUTH as the user set.
- **Owns:** `docs/internals/` (new), moved files
- **Shared:** `README.md`, every doc with cross-links, the docs-sync scripts that reference paths
- **Acceptance:**
  - `wc -c README.md` ≤ 15,000.
  - `docs/` top level holds only user-facing docs plus `internals/`, `probes/`, `reviews/`.
  - The link check and `npm run check` are green.

### Ship-it plan (milestones)

| When | Milestone | Exit check |
|---|---|---|
| Day 0–2 | PRD-R1 freeze; PRD-R2 sandbox smoke (owner, 2–3 h) | PROBE-LOG core-path section all pass, or fix items filed |
| Day 3–5 | Fixes from the smoke; PRD-R3, PRD-R5, PRD-R6 | `npm run check` green; README states the persona |
| Day 6–7 | PRD-R4 publish (0.9.0), Pages live, MCP registry listing | `npm view` returns the version; privacy URL 200 |
| Day 8–14 | Launch via the `launch-marketing` skill (owner-approved posts) to MCP-adjacent channels; PRD-R7 metrics live | First external setup report |
| Day 30 | Probe backlog P-1..P-16 complete; promote to 1.0.0 if no breaking findings | 1.0.0 on npm |
| Day 90 | PRD-R8 review | Decisions recorded |

**Success metrics for the first 90 days** (data sources: npm downloads API, GitHub, issues; no telemetry):

| Metric | Day 30 | Day 90 | Why |
|---|---|---|---|
| npm downloads, trailing 30 days | ≥ 300 | ≥ 1,000 | Benchmark: thenavidm at 449 one month after its first publish |
| GitHub stars | ≥ 25 | ≥ 100 | Discovery signal for registries and aggregators |
| Setup reports reaching `doctor` green | ≥ 5 | ≥ 20 | Validates that the friction is survivable |
| Median reported setup time | ≤ 60 min | ≤ 40 min | Friction target after the docs fixes |
| Setup abandonment (reports that stop before step 9) | measured | ≤ 30% | Locates the real blocker |
| Issues from users other than the owner | ≥ 3 | ≥ 10 | Real demand signal; feeds the freeze exit |
| Breaking-surface findings from real API use | 0 open at day 30 | 0 | Gate for 1.0.0 |
| Listings: MCP registry, Smithery/Glama/mcp.so | registry + 1 | registry + 3 | Distribution |

Top recommendation: freeze the scope today, spend 3 hours proving the core path against a real sandbox account, then publish 0.9.0 within a week, positioned as "analyse your own TikTok and draft into your inbox, local-first and safe" rather than as a public-posting tool its own users cannot get approved.
