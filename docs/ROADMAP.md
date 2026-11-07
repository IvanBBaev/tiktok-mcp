# Roadmap

> Detailed work-package breakdown: **docs/IMPLEMENTATION-PLAN.md** — it folds in
> the review findings (binding round-2 synthesis) and the corner-case catalog
> (docs/CORNER-CASES.md) and supersedes the phase outlines below where they
> differ. This file is the short orientation view only.

## Phase 0 — Foundation (repo bootstrap)
- Repo scaffolding: `package.json` (name `tiktok-mcp-ai`, ESM, **engines ≥ 22**),
  strict `tsconfig` (ES2022/NodeNext, `noUncheckedIndexedAccess`), ESLint flat
  config with layer-boundary rules, Prettier, `.editorconfig`, `.nvmrc` (**24**).
- **CI from the first commit**, blocking matrix ubuntu × Node {22, 24},
  macos × 24, **windows × 24** (full Windows support), plus an advisory
  ubuntu × 26 leg.
- `core/`: settings, config store (env file, profiles, atomic writes,
  cross-process env-file lock), errors, logging + redaction, egress host guard,
  http client with the three-class retry matrix and envelope decoding.
  Everything unit-tested before any tool exists.
- **Exit gate**: `npm run check` green in CI on all blocking legs; coverage
  gate active; zero tools.

## Phase 1 — Read surface (usable reader MVP)
- `login` CLI (PKCE loopback; manual-paste fallback), `doctor`.
- OAuth refresh machinery (skew, rotation, single-flight, cross-process lock).
- Packages `auth`, `user`, `video` + registry, manifest snapshot, README
  generation, `server.json`.
- **Exit gate**: real-account smoke test — login, `tiktok_get_auth_status`,
  `tiktok_get_user_info`, `tiktok_list_videos` through MCP Inspector.

## Phase 2 — Publishing
- The write-safety spine first: plan/execute with enforced single-use
  `plan_id`, append-only write-ahead journal, per-profile publish token bucket.
- `publish` reads: `tiktok_get_creator_info`, `tiktok_get_publish_status`,
  `tiktok_list_publish_journal`; then the four `publish-write` tools:
  `tiktok_post_video` (URL source first, then FILE_UPLOAD chunking),
  `tiktok_upload_video_draft`, `tiktok_post_photos`,
  `tiktok_upload_photos_draft`.
- Sandbox validation against an unaudited app (SELF_ONLY posts, draft flow),
  including executing the sandbox probes **P-1..P-14** and recording results.
- **Exit gate**: end-to-end SELF_ONLY video post + draft reaching the TikTok
  inbox on a test account; chunk-math property tests green; a deliberate
  duplicate execute blocked live by `plan_id`; all probes recorded.

## Phase 3 — Release & platform audit
CI already exists from Phase 0 (blocking matrix ubuntu × {22, 24}, macos × 24,
windows × 24, advisory 26) — this phase is release engineering only.
- CodeQL, dependabot, publish workflows (npm trusted publishing with
  provenance + MCP registry), CHANGELOG, root `SECURITY.md`, Claude Code
  plugin manifest (`.claude-plugin/`).
- Shipped here beyond the original outline: the documentation site (`site/`,
  deployed by `.github/workflows/pages.yml`) and the packed-tarball smoke gate
  (`npm run smoke:pack`, re-run in `publish.yml` before publishing), which
  replaced the hand-run RC checklist. One manual step still stands between the
  site and the audit (G-4): `site/privacy.html` and `site/terms.html` are
  committed (since `6410fa1`), but GitHub Pages is not enabled, so every URL on
  the site returns 404 (re-checked 2026-09-28). Enable it with Source = GitHub
  Actions and run `pages.yml` by `workflow_dispatch`.
- npm publish `0.x`; **submit** the TikTok content-sharing audit (required to
  lift SELF_ONLY). Audit *passed* is a 1.x platform milestone outside our
  control — v1.0 does not wait on TikTok's review queue. The submission
  playbook, the demo-video shot list and the journey log are docs/AUDIT.md.
- v1.0 itself is defined by the "Road to v1.0" section of
  docs/IMPLEMENTATION-PLAN.md: the 11-tool surface frozen under semver plus
  the gap list G-1..G-14 closed (LICENSE, unofficial-status disclaimer,
  operator docs, revoke flow, Privacy Policy + ToS at live URLs,
  first-release bootstrap, …).
- Optional: Research API package (`research`) — only if access is granted;
  client-credentials auth, own rate limits. No dark scaffold before then.

## Phase 4 — Ergonomics (demand-driven)
- MCP resources, prompts and argument completion — **shipped 2026-09-19** in
  three slices (TOOLS.md § 7): six read snapshots at `tiktok://auth/status`,
  `tiktok://user/info`, `tiktok://videos/recent`, `tiktok://creator/info`,
  `tiktok://publish/journal`, `tiktok://publish/{publish_id}/status`
  (`?account=` selects the profile; on the journal it filters;
  `publish/{publish_id}/status` is a URI template whose path parameter is the
  tool argument), three guided prompts (`tiktok_post_video_guided`,
  `tiktok_post_photos_guided`, `tiktok_upload_draft_guided`) and
  `completion/complete` over their arguments — `account` from the configured
  profiles, `privacy_level` from the four privacy levels, `publish_id` from the
  write-ahead journal. Resources and prompts ride the tool pipeline and the
  package gate, completion is matched against the same gated lists and reads
  local data only; none of the three adds write or network surface.
- Webhooks ingestion (portability events) if a use case appears.
- Desktop packaging only if usage justifies it. (The VS Code extension was
  pulled forward and shipped in Phase 3 — `extension/`, published by
  `.github/workflows/publish-vscode.yml` once the npm release on that `v*` tag
  succeeds; a prerelease tag ships to npm only, since the Marketplace rejects
  semver prereleases. What is still demand-driven is anything beyond that listing.)

## Phase 5 — v1.x / v2 feature track (codeable only)
Everything here is buildable without TikTok changing its API. Additive work ships
as 1.x minors under the compatibility policy; 2.0 is reserved for the change that
reshapes the profile model (a second auth provider).
- **1.1 — read-side value, hardening:** computed analytics over the video list
  (engagement rates, top posts, period aggregates, local snapshots for trends —
  the Display API keeps no history); media pre-flight checks before upload;
  DNS resolve-and-pin for outbound API and upload requests (P-15 — **shipped
  2026-10-28**, `TT_DNS_PIN`); a per-host outbound semaphore.
- **1.2 — push instead of poll:** a webhook receiver (`TikTok-Signature`
  HMAC-SHA256 verification, timestamp tolerance, dedupe for at-least-once
  delivery) for `post.publish.*` and `authorization.removed`; revocation marks
  the profile and drops its tokens; publish status as subscribable resources.
  Needs a public HTTPS URL the operator provides — no hosted relay (non-goal
  below); polling stays the fallback.
- **1.3 — workflow:** local scheduled publishing (queue + runner on top of
  plan/apply and the journal — the API has no scheduling), batch / multi-profile
  publish under one consent, elicitation-based consent with the plan token as
  fallback.
- **1.4 (optional, needs approval):** Commercial Content API package (ad
  library, EU data, client-credentials token).
- **2.0 (needs approval):** Business Accounts API — comments on owned videos
  (list/reply/hide), account and video insights, mentions, `comment.update`
  webhook — behind a second OAuth provider per profile. Spike first: can an
  individual developer get access at all.
- Not planned: Research API (academic only), Data Portability API (EEA/UK,
  low value here), mobile kits (Share Kit, Green Screen Kit).

## Parallel work queue
The open items below can run at the same time, each on its own branch, without
getting in each other's way. Each item is a heading
`#### <ID> — <title>`, and the line under it says what it waits for and where it
stands: `Deps <ids> · Status <todo|done|blocked: …> · Est <h>`. The claim script of
the `%-start-on-roadmap` workflow reads these lines from the committed `main`.
The round-3 review items are in [§ Round-3 release track](#round-3-release-track).
The release-blocking ones go first.

### How an item runs
- **One item per branch.** The branch is `wp/<ID>` (the branch name is the claim).
  Its worktree lives at `~/Development/_branches/tiktok-mcp-<id>`. Never work on two
  items in one branch.
- **Stay in your files.** Each item lists the files it **owns** (only this item
  edits them) and the **shared** files it may touch under the rules below. If you
  need a file outside both lists, stop and add it to the item here first. Do that
  in its own commit on `main`.
- **Finish with a rebase, never a merge commit.** Rebase on `main`, run
  `npm run check`, then fast-forward `main`. Remove the worktree and delete the branch.
  The last commit of the branch flips only this item's `Status` line to `done`
  (`Status done YYYY-MM-DD`). The other items' lines sit apart from it, so two
  branches never conflict on the roadmap.
- **One commit per item. No secrets, no harness files** (`CLAUDE.md`,
  `WORKLOG.md`, `.claude/`, `docs/ai/`).

### Shared files — how to edit them without conflicts
Several items touch these files. Each rule keeps a rebase conflict trivial: you keep
both sides, or you regenerate the file.

| File | Rule |
|---|---|
| `CHANGELOG.md` | Add **one** bullet at the **end** of the right `[Unreleased]` group. On conflict, keep both bullets. |
| `docs/CONTRACTS.md` change log | Add **one** row at the **end** of the table. On conflict, keep both rows in date order. |
| `docs/TOOLS.md` | A new tool takes the **next free** section number (today § 3.17). Never renumber existing sections in a parallel item. |
| `src/tools/index.ts` | Add the import or registration as a new line. Never reorder existing lines. |
| `README.md`, `server.json`, manifest snapshot, `.env.example` | Generated: after the rebase, run `npm run build && npm run sync:write && npm run docs:env`. Never merge these by hand. |
| `package.json`, `package-lock.json` | Only **H2** (and in round 3 only **SEC-R8**) changes dependencies. No other item in this queue may add one. If one must, it waits for H2 to be `done`. On a lockfile conflict, take `main`'s lockfile and rerun `npm install`. |
| `src/core/settings.ts`, `docs/CONFIGURATION.md`, `scripts/gen-env-example.ts`, `test/settings.test.ts` | Settings hotspot: at most one live item adds a `TT_*` setting. None of the items below needs one. |
| `src/core/http.ts` | Only **A11** edits it (the egress allowlist). H1 uses the existing seams (`outboundLookup`, `LookupFn`) and must not change this file. |
| `docs/SECURITY.md` | H1 edits only § DNS resolve-and-pin. A11 edits only the egress host list. |

### Which items can run together
H1, H2 and A11 share no owned file, so all three can run at once. Merge order does
not matter; H2 first keeps the lockfile out of the others' rebases. B2-SPIKE and
B2 are frozen by the round-3 scope freeze (PRD-R1) until the 90-day review
PRD-R8, and B3 waits for B2. B1 moved to the explicit non-goals.

#### H1 — Pin the login and doctor requests to the vetted DNS answer
Deps — · Status done 2026-10-28 · Est 3 h

- **Scope:** close the gap that SECURITY.md § DNS resolve-and-pin documents. The
  `login` CLI's token exchange (`exchangeCode`, whose seams already take `lookup`)
  and its user-info call, plus every outbound request `doctor` makes, get
  `outboundLookup(settings.dnsPin, process.env, dns.lookup)` at the CLI
  composition root. This is the same switch `src/index.ts` and `cli/run-queue.ts`
  use, so `TT_DNS_PIN=0` and the environment-proxy exception behave the same.
- **Owns:** `src/cli/login.ts`, `src/cli/doctor.ts`, and their tests under `test/`
  (login and doctor suites, plus `test/dns-pin.test.ts` for new cases).
- **Shared:** `docs/SECURITY.md` (only § DNS resolve-and-pin: drop the
  "login and doctor stay unpinned" note and move it to History), `CHANGELOG.md`,
  and a `docs/CONTRACTS.md` row only if an exported signature changes.
- **Acceptance:**
  - A test proves that the login exchange and a doctor probe pass a pinned
    dispatcher when the pin is on, and none with `TT_DNS_PIN=0`.
  - `npm run check` is green, with coverage at or above the gate.

#### H2 — Clear the open npm audit findings
Deps — · Status done 2026-10-28 · Est 0.5 h

- **Scope:** `npm audit fix` without `--force` for body-parser (high), fast-uri and
  qs (moderate), all transitive and pre-existing.
- **Owns:** `package-lock.json`. Touch `package.json` only if a range has to move.
- **Shared:** `CHANGELOG.md` (a `Security` bullet).
- **Acceptance:**
  - `npm audit` reports 0 vulnerabilities.
  - `npm run check` is green.
  - The lockfile diff touches only the advised packages and their own dependencies.

#### A11 — Embed tool over oEmbed (`tiktok_get_embed`)
Deps — · Status done 2026-10-28 · Est 5 h

- **Scope:** a read-only tool that returns TikTok's oEmbed answer (embed HTML,
  title, author, thumbnail) for a public video URL. It needs no user token.
- **Package:** the tool ships in its own tool package `embed`, so it can be
  dropped if TikTok deprecates oEmbed.
- **Validation:**
  - The input URL is checked against TikTok's public video URL shapes.
  - The answer is size-capped and treated as untrusted content.
- **Owns:** `src/api/embed.ts`, `src/tools/embed.ts`, `test/embed.test.ts`.
- **Shared:**
  - `src/core/http.ts`: add the oEmbed host to the egress allowlist, with a test.
  - `docs/SECURITY.md`: egress host list.
  - `src/tools/index.ts`.
  - `docs/TOOLS.md`: § 3.17.
  - Generated files: README, `server.json`, manifest.
  - `docs/CONTRACTS.md` row and `CHANGELOG.md`.
- **Acceptance:**
  - The tool is listed only when the `embed` package is enabled.
  - A non-TikTok or non-https URL is refused before any request.
  - The host guard admits exactly the oEmbed endpoint.
  - `npm run check` is green.

#### H3 — Pin the server's token refresh to the vetted DNS answer
Deps — · Status done 2026-10-29 · Est 1 h

- **Scope:** `createApiContext` already pins every API request when it gets a
  `lookup`, but the token refresh it triggers (`ensureFreshAccessToken`) runs
  unpinned. Forward the context's `lookup` into the refresh deps, so the server,
  `run-queue` and `doctor` pin the refresh without wiring of their own. Drop
  `doctor`'s refresh wrapper, which becomes redundant.
- **Owns:** `src/api/context.ts`, `src/cli/doctor.ts` (only the refresh wrapper),
  `test/dns-pin.test.ts`.
- **Shared:** `docs/SECURITY.md` (only § DNS resolve-and-pin), `CHANGELOG.md`,
  and a `docs/CONTRACTS.md` row.
- **Acceptance:**
  - A test proves that a refresh triggered through an `ApiContext` with a
    `lookup` receives that `lookup`, and that it gets none without one.
  - `npm run check` is green.

#### B2-SPIKE — Can an individual developer get Business API access?
Deps — · Status blocked: frozen until PRD-R8 (round-3 scope freeze), then owner (apply in the TikTok developer portal) · Est 2 h

- **Scope:** apply for access, record the outcome and limits in
  `docs/probes/PROBE-LOG.md`, and give a GO or NO-GO for B2.

#### B2 — Business Accounts package
Deps B2-SPIKE, ARC-R7 · Status blocked: frozen until PRD-R8 (round-3 scope freeze) · Est 30 h

- **Scope:** a second OAuth provider per profile (`business_id` = `open_id`) and
  these tools:
  - list, reply to and hide comments on owned videos, with plan/apply and
    `plan_token` for destructive operations;
  - account and video insights;
  - mentions.
- **Release:** it reshapes the profile model, so it ships as **2.0**.
- **Coordination:** it owns the settings and config hotspot while it is live.
  Start no other settings item next to it.

#### B3 — `comment.update` webhook drives resource updates
Deps B2 · Status blocked: frozen until PRD-R8 (round-3 scope freeze) · Est 3 h

- **Scope:** route `comment.update` events through the existing webhook receiver
  and subscription hub (1.2 work, done) to comment resources.
- **Owns:** a new handler module next to `mcp/webhook`.
- **Shared:** `src/index.ts` wiring.

## Round-3 release track
The round-3 review (2026-10-29) asked whether the first public release can ship.
It found that nothing has shipped or met the real API, and that the release path
is blocked. Read these before claiming an item:
- [`docs/reviews/round3/SYNTHESIS.md`](reviews/round3/SYNTHESIS.md): roles,
  scores, themes, resolved conflicts, owner decisions Q1–Q7 and the recommended
  order.
- [`docs/reviews/round3/DECISIONS.md`](reviews/round3/DECISIONS.md): the owner
  decisions Q1–Q7 and the answers to every report's open questions
  (2026-10-30), plus the checklists for the steps only the owner can do.
- The eight role reports in [`docs/reviews/round3/`](reviews/round3/). Each item
  below keeps its report ID, so `REL-R2` is detailed under that heading in
  `release-devops.md`, with full evidence and acceptance criteria.

The prefixes are:

| Prefix | Report |
|---|---|
| ARC | `architecture.md` |
| SEC | `security.md` |
| QA | `qa.md` |
| PLT | `tiktok-platform.md` |
| DX | `mcp-ai-dx.md` |
| PRD | `product.md` |
| LGL | `legal-compliance.md` |
| REL | `release-devops.md` |

These items run under the same rules as the parallel work queue above: one
branch per item, rebase and fast-forward, and the last commit flips the item's
`Status` line.

**Release-blocking** marks an item that must be `done` before the first tag.
Merged items list the report IDs they absorb.

**Scope freeze** (PRD-R1, decided 2026-10-30): no new tools, tool packages or
`TT_*` settings until 90 days after the first npm publish, or until 3
independent issues ask for the same feature. Fixes, hardening and removals stay
allowed. The first version is **0.9.0**, and the project is positioned as a
local-first tool for reading, inbox drafts and private test posts, not as a
public-posting product (DECISIONS.md Q1, Q2).

### Round-3 shared-file rules
These add to the table above.

| File | Rule |
|---|---|
| Publish plan and consent (`src/api/publish.ts`, `src/mcp/consent.ts`, `src/tools/publish-*.ts`) | Serialised: PLT-R1 → SEC-R1 → PLT-R2. No other item edits these files while one of the three is live. |
| `README.md` hand-written sections | DX-R2 first, then PRD-R5. PRD-R6 adds only the experimental labels. |
| `package.json`, `package-lock.json` | Only SEC-R8 changes dependencies, and only REL-R6 changes the `version`, `types` or `files` fields. |
| `docs/AUDIT.md`, `docs/SETUP-TIKTOK-APP.md` | Owned by PLT-R3. PRD-R5 edits these files only after PLT-R3 is `done`. |
| `site/*` | LGL-R1 owns `privacy.html` and `terms.html`. LGL-R5 owns the styles and fonts. |
| Test clock helpers (`test/helpers.ts` and the `runVirtual` copies) | Owned by REL-R2. Merge it first, because every other item's CI depends on it. |
| Settings hotspot | DX-R3 changes only a default value. PRD-R6 adds `TT_EXPERIMENTAL` only if the owner chooses that in Q5. ARC-R7 is design-only. |

### Release-blocking, codeable now

#### REL-R2 — Make the virtual test clock deterministic
Deps — · Status todo · Est 3 h

- **Absorbs:** QA-R3.
- **Scope:** **Release-blocking.**
  - Replace the four copies of `runVirtual`, which add 500 ms per event-loop
    turn, with one shared helper in `test/helpers.ts` that advances to the next
    pending timer.
  - Add a regression test. It injects extra idle event-loop turns before apply
    and asserts that the plan survives its 600 s TTL. This was the cc-g7
    `plan_not_found` failure on `main`.
- **Owns:** `test/helpers.ts`, `test/helpers.test.ts` and the suites that carry a copy of
  `runVirtual`.
- **Shared:** `docs/CONTRACTS.md` § Test harness and change log, `docs/TESTING.md`
  § Harness (the harness additions are recorded there).
- **Acceptance:**
  - No local `runVirtual` remains.
  - `npm run check` is green locally and on CI three times in a row.

#### ARC-R1 — Classify retry class by endpoint table, failing closed
Deps — · Status todo · Est 4 h

- **Scope:** **Release-blocking.**
  - A `(method, path)` table decides the retry class: known reads → `read`,
    chunk PUT → `chunk`, and every other non-GET, unknown ones included →
    `init`.
  - A caller may only make its class stricter.
  - A 401 is replayed only for `read`.
- **Owns:** the retry-class code in `src/core/http.ts` and its tests.
- **Acceptance:** see `architecture.md` § ARC-R1.

#### PLT-R1 — Default interaction toggles to off and fix the docs that misread the rule
Deps — · Status todo · Est 2 h

- **Scope:** **Release-blocking.**
  - Comment, duet and stitch default to off (`src/api/publish.ts:379-399`).
    TikTok's UX rules require the user to turn them on.
  - Fix the docs that say otherwise.
- **Acceptance:** see `tiktok-platform.md` § PLT-R1.

#### SEC-R2 — Untrusted-content notice on upstream text, plus server instructions
Deps — · Status todo · Est 2 h

- **Scope:** **Release-blocking.**
  - Every tool that returns upstream text gets a shared notice suffix. This is
    what SECURITY.md already claims.
  - Add MCP server `instructions`.
  - Mark the oEmbed `html` field as non-renderable.
  - DX-R5 keeps only the token-budget cut.
- **Acceptance:** see `security.md` § SEC-R2.

#### SEC-R8 — Dependency hygiene before the first release
Deps — · Status todo · Est 1 h

- **Absorbs:** REL-R5.
- **Scope:** **Release-blocking.**
  - Merge #37 now.
  - Rebase #36 and #38. They are red only because their base predates the
    audit fix. Then merge them or close them.
  - Add a dependabot cooldown.
  - Consider `--audit-level=moderate` for production dependencies.
- **Owns:** `package.json`, `package-lock.json`, `.github/dependabot.yml`.
- **Acceptance:**
  - No dependabot PR is open.
  - `npm audit` reports 0 vulnerabilities.
  - `npm run check` is green.

#### DX-R2 — Correct the README demo and stale facts, and guard them with a test
Deps — · Status todo · Est 1.5 h

- **Scope:** **Release-blocking.**
  - Flatten the Quick demo JSON. Today the strict schema rejects `post_info`.
  - Change "four write tools" to six.
  - Qualify the `npx` claim until the package is published.
  - Add `embed` to the package list.
  - Add a test that validates every fenced tool-call JSON in `README.md` and
    `docs/*.md` against the zod schemas.
- **Acceptance:** see `mcp-ai-dx.md` § DX-R2.

#### DX-R6 — Fix the first-run credential diagnostics
Deps — · Status todo · Est 2 h

- **Scope:** **Release-blocking.** Missing or invalid credentials on first start
  produce one clear, actionable error.
- **Acceptance:** see `mcp-ai-dx.md` § DX-R6.

#### LGL-R1 — Make the privacy policy and terms describe the built system, and gate them
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking.**
  - `site/privacy.html` adds the missing data and egress:
    - `schedule.json`
    - `webhooks.ndjson`
    - the lock artifacts
    - the `run-queue` log
    - the oEmbed egress
    - the webhook receiver
  - Replace "There is no controller" with an explicit roles section.
  - Fix the stale version wording.
  - Extend `scripts/site-sync.ts` so that `npm run sync` fails when a persisted
    file or an egress host is missing from the policy.
- **Acceptance:** see `legal-compliance.md` § LGL-R1.

#### LGL-R5 — Remove TikTok trade dress and third-party fonts from the site and extension
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking**, because the site goes live with the first
  release.
  - Drop the TikTok brand colours.
  - Self-host the fonts instead of loading them from Google Fonts.
  - Add "Unofficial" to the extension's display name.
- **Acceptance:** see `legal-compliance.md` § LGL-R5.

### Release-blocking, after another item

#### SEC-R1 — Show the full payload in the consent dialog
Deps PLT-R1 · Status todo · Est 4 h

- **Scope:** **Release-blocking.** For every write tool (video, photos, batch,
  schedule), `ConsentItem` carries and renders:
  - the media source and size;
  - the disclosure, brand-content and AIGC flags;
  - the interaction toggles.
- **Acceptance:** see `security.md` § SEC-R1.

#### PLT-R2 — Add a content preview, processing notice and commercial-content labels
Deps SEC-R1 · Status todo · Est 5 h

- **Scope:** **Release-blocking.** The plan output gets the UX elements that
  TikTok's audit checks: a content preview, the processing-time notice, and the
  commercial-content labels and declarations.
- **Acceptance:** see `tiktok-platform.md` § PLT-R2.

#### PLT-R3 — Rewrite AUDIT.md against the live guidelines and add the operator compliance guide
Deps PLT-R2, LGL-R1 · Status todo · Est 6 h

- **Absorbs:** LGL-R3.
- **Scope:** **Release-blocking.**
  - Rewrite `docs/AUDIT.md` against the current guidelines. It still cites
    0.8.0.
  - Cite "Apps must not be for private or personal use" verbatim, with its URL
    and access date, as rejection class 7.
  - Add an operator guide to `docs/AUDIT.md` and `docs/SETUP-TIKTOK-APP.md`. It
    covers:
    - audit eligibility;
    - a consent matrix;
    - app naming;
    - a privacy-policy template for the operator's own app.
- **Owns:** `docs/AUDIT.md`, `docs/SETUP-TIKTOK-APP.md`.
- **Acceptance:** both PLT-R3 in `tiktok-platform.md` and LGL-R3 in
  `legal-compliance.md`.

#### ARC-R2 — Resync ARCHITECTURE.md with the built system
Deps ARC-R1 · Status todo · Est 3 h

- **Scope:** **Release-blocking.** Bring these up to date:
  - the module tree and the bootstrap;
  - the package and tool lists (7 packages, 17 tools);
  - the dependency count;
  - § 6.3 on the retry class.

  Record two decisions: the `wait_for_completion=false` reversal and the names
  that replaced those in § 3.7.
- **Acceptance:** see `architecture.md` § ARC-R2.

#### REL-R1 — Decide the first version and cut the changelog
Deps — · Status todo · Est 1.5 h

- **Absorbs:** PRD-R3.
- **Scope:** **Release-blocking.**
  - Apply the owner's Q1 choice, 0.9.0 (DECISIONS.md Q1):
    1. Fold `[1.0.0]` and `[Unreleased]` into `[0.9.0] - <publish date>`.
    2. Say that 0.7.0, 0.8.0 and 1.0.0 were internal milestones that were never
       published.
    3. Delete the false "first version published to npm" line.
    4. Set every version field.
  - 1.0.0 becomes the first CI-attested release, after the probes.
- **Acceptance:**
  - `release-guard --tag v<chosen>` exits 0. Today it fails for every tag.
  - `npm run check` is green.

#### PRD-R1 — Declare a scope freeze and defer the B-track
Deps — · Status done 2026-10-30 · Est 0.5 h

- **Scope:** **Release-blocking.**
  - Write a freeze: no new tools, tool packages or `TT_*` settings until 90
    days after the first npm publish, or until 3 independent issues ask for a
    feature.
  - Move B1 to non-goals.
  - Freeze B2-SPIKE, B2 and B3 until PRD-R8.
- **Acceptance:** see `product.md` § PRD-R1.

#### PRD-R6 — Label the low-reach features experimental
Deps PRD-R1 · Status todo · Est 2 h

- **Scope:** **Release-blocking.** Mark these features **Experimental** and
  exclude them from the compatibility policy:
  - scheduling: `run_at`, `run-queue`, and the list and cancel tools;
  - `tiktok_publish_batch`;
  - the webhook receiver;
  - publish-status subscriptions;
  - `tiktok_get_embed`.

  The label goes in TOOLS.md, the tool descriptions and CHANGELOG. No
  `TT_EXPERIMENTAL` setting: Q5 chose label only.
- **Acceptance:** see `product.md` § PRD-R6.

#### DX-R3 — Make the consent-dialog state visible and apply the chosen default
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking.**
  - Add `consent_dialog: active|unavailable|off` to `get_auth_status`.
  - Add a `note` hint on apply when no dialog ran.
  - Add a client support matrix to `CLIENTS.md`.
  - Change the `TT_ELICITATION` default to `required` (DECISIONS.md Q3). The
    `consent_unavailable` error names `TT_ELICITATION=auto` as the opt-out and
    says what it gives up. Update CONFIGURATION.md, SECURITY.md, the README
    and CHANGELOG.
- **Acceptance:** see `mcp-ai-dx.md` § DX-R3.

#### REL-R8 — Skip the Marketplace publish cleanly when VSCE_PAT is unset
Deps — · Status todo · Est 0.5 h

- **Scope:** **Release-blocking.** The VS Code extension is deferred (Q6), so
  `VSCE_PAT` does not exist. Today `publish-vscode.yml` would fail the release
  run.
  - Expose `secrets.VSCE_PAT != ''` as a job-level env flag.
  - When it is false, skip the Marketplace step and print a `::notice::` that
    names DECISIONS.md § 4.5.
  - Leave every other gate in the workflow unchanged.
- **Owns:** `.github/workflows/publish-vscode.yml`.
- **Acceptance:**
  - `actionlint` (or the repo's workflow lint) passes.
  - A `workflow_dispatch` run without the secret ends green with the notice.
  - `npm run check` is green.

### Release-blocking owner steps and what follows them

#### QA-R1 — Run the live-validation session against a TikTok sandbox app
Deps — · Status blocked: owner (sandbox app + own private account as target user, human at the keyboard; checklist in DECISIONS.md § 4.1) · Est 4 h

- **Absorbs:** PLT-R4 and PRD-R2.
- **Scope:** **Release-blocking** for any "posting works" claim. Run one
  scripted session, which spends 2–3 inits:
  1. `login`, then `doctor` green
  2. auth status, user info, list videos, analytics
  3. a FILE_UPLOAD draft that reaches the inbox
  4. a `SELF_ONLY` post on a private account
  5. publish status polled to completion
  6. a duplicate execute with the same `plan_id`, which must be refused
  7. `login --revoke`

  Along the way:
  - Record P-1..P-14 in `docs/probes/PROBE-LOG.md`.
  - Capture the raw responses for QA-R2.
  - Note whether a draft works on a **public** account.
  - P-10 is required. P-8 and P-9 may be deferred (DECISIONS.md Q7).
  - Every mismatch with the spec becomes its own fix item before the tag.
- **Acceptance:** see `qa.md` § QA-R1 and `product.md` § PRD-R2.

#### QA-R2 — Extend contract replay to inits, token and chunk PUT, behind one validating fake
Deps QA-R1 · Status todo · Est 8 h

- **Scope:** **Release-blocking.**
  - Add a `raw` fixture kind, recorded in QA-R1.
  - Replay the token, init and chunk PUT responses. Chunk PUTs answer 206, not
    201.
  - Merge the five `fakeApi` copies into one fake that validates requests.
- **Acceptance:** see `qa.md` § QA-R2.

#### PRD-R5 — Reposition README and setup around the reachable value
Deps QA-R1, DX-R2, PLT-R3 · Status todo · Est 4 h

- **Scope:** **Release-blocking.**
  - Rewrite the README opening and the Quick demo around what the user can
    reach: their own analytics, drafts in the inbox, and private test posts.
  - Add a box that says what TikTok lets an individual do.
  - Give an honest setup time and a sandbox-first fast path.
  - Shape the text by Q2: a local-first tool, not a public-posting product.
- **Acceptance:** see `product.md` § PRD-R5.

#### REL-R3 — Owner bootstrap: Pages, first npm publish, npm settings and secrets
Deps REL-R1, REL-R2, REL-R8, SEC-R8, LGL-R1, LGL-R5, QA-R1 · Status blocked: owner (G-4, G-14, npm login and 2FA; checklists in DECISIONS.md § 4.2–4.4) · Est 1 h

- **Absorbs:** PRD-R4, plus IMPLEMENTATION-PLAN gates G-4 and G-14.
- **Scope:** **Release-blocking.** Follow the runbook in `release-devops.md`
  (steps A–E):
  1. Enable GitHub Pages (Source = GitHub Actions) and run `pages.yml`.
  2. Do the manual first `npm publish`.
  3. Configure the trusted publisher. Select the "Publish" action and set
     "disallow tokens".
  4. Revoke the dormant `NPM_TOKEN`.
  5. The extension is deferred (Q6). The Marketplace step skips (REL-R8)
     until the owner creates the publisher and `VSCE_PAT` (DECISIONS.md
     § 4.5).
  6. Push the tag, then verify npm, the GitHub release, the MCP registry and
     the Marketplace.
- **Acceptance:**
  - `npm view tiktok-mcp-ai` shows the chosen version.
  - The privacy and terms URLs return 200.
  - All follower workflows are green.

#### DX-R1 — Fix the plugin and extension launch path and their claims
Deps REL-R3 · Status todo · Est 2 h

- **Scope:** **Release-blocking** for announcing the plugin and extension.
  - Change the copy to "10 tools by default, 17 with `TT_TOOL_PACKAGES=all`".
  - Pass env through to the plugin.
  - Add a `tiktokMcp.toolPackages` setting to the extension.
  - Add a checklist step: announce only after `npm view` succeeds and the
    homepage returns 200.
- **Acceptance:** see `mcp-ai-dx.md` § DX-R1.

### After the first release
These items are not release-blocking. Each one is detailed under its ID in its
report.

#### ARC-R3 — Gate CONTRACTS.md against the code
Deps ARC-R2 · Status todo · Est 6 h

- **Scope:** CONTRACTS.md is 3616 lines and has drifted. Shrink it to the
  invariants plus signatures generated from the exported types, and fail a
  gate when they drift (DECISIONS.md, architecture Q2).

#### ARC-R4 — Extract one executeWrite pipeline for the write tools
Deps PLT-R2 · Status todo · Est 5 h

- **Scope:** the write tools build plan, consent, journal and dispatch in
  separate places. Give them one shared pipeline.

#### ARC-R5 — Build the runtime in one composition module
Deps — · Status todo · Est 3 h

- **Scope:** wire the server, `run-queue` and `doctor` from one composition
  module.

#### ARC-R6 — Enforce the tools/ and cli/ boundaries in ESLint
Deps — · Status todo · Est 2 h

- **Scope:** add ESLint import zones for `src/tools/` and `src/cli/`.

#### ARC-R7 — Design a provider-aware credential model before B1/B2
Deps — · Status todo · Est 8 h

- **Scope:** write an ADR, with a prototype, for credentials keyed by app and
  provider. Today they are keyed by profile name. This is a hard prerequisite of
  B1 and B2.

#### ARC-R8 — Move the write-safety modules out of mcp/
Deps ARC-R4 · Status todo · Est 4 h

- **Scope:** move the write-safety modules out of `src/mcp/`.

#### ARC-R9 — Split core/http.ts and cli/doctor.ts along their sections
Deps ARC-R1 · Status todo · Est 5 h

- **Scope:** split both files along their existing sections.

#### ARC-R10 — Own mutable runtime state in a RuntimeState object
Deps ARC-R5 · Status todo · Est 6 h

- **Scope:** move the mutable runtime state into one `RuntimeState` object.

#### SEC-R3 — Host/Origin gate on the OAuth callback listener
Deps — · Status todo · Est 2 h

- **Scope:** check the Host and Origin headers on the OAuth callback listener.

#### SEC-R4 — Authenticate or document the schedule store
Deps — · Status todo · Est 3 h

- **Scope:** `run-queue` runs `schedule.json` entries as already consented.
  Document the trust boundary: write access to the env directory equals
  publish rights. No HMAC (DECISIONS.md, security Q1).

#### SEC-R5 — Webhook receiver hardening
Deps — · Status todo · Est 3 h

- **Scope:**
  - Verify the signature before reading the env file.
  - Verify the signature for every profile's app, not only the first. Each
    profile may carry its own app, so this is a functional bug (DECISIONS.md,
    security Q3).

#### SEC-R6 — Bounded response bodies
Deps ARC-R1 · Status todo · Est 2 h

- **Scope:** cap the size of every upstream response body.

#### SEC-R7 — Small input and transport hardening
Deps — · Status todo · Est 2 h

- **Scope:**
  - URL prefix checks
  - token length bounds
  - timeouts
  - `TT_HTTP_INSECURE` stays, with its hardening (DECISIONS.md, security Q4)
  - `doctor` warns once when an environment proxy disables the DNS pin

#### PLT-R5 — Fix the photo body shape: top-level is_aigc and mode-specific fields
Deps QA-R1 · Status todo · Est 2 h

- **Scope:** fix the photo request body. Needs the P-13 evidence from QA-R1.

#### PLT-R6 — Harden webhook event parsing against TikTok's documented shapes
Deps SEC-R5 · Status todo · Est 2 h

- **Scope:** parse webhook events against TikTok's documented shapes, including
  the `no_longer_publicaly_available` spelling.

#### PLT-R7 — Mark oEmbed as deprecated upstream and add an Embed Player option
Deps — · Status todo · Est 2 h

- **Scope:** mark oEmbed as deprecated upstream and add an Embed Player option.

#### PLT-R8 — Align the upload size cap and small doc drifts
Deps — · Status todo · Est 1 h

- **Scope:** align the upload size cap with TikTok's limit and fix the small doc
  drifts.

#### PLT-R9 — Decide B1/B2 feasibility and record the access paths
Deps — · Status blocked: frozen until PRD-R8 (round-3 scope freeze) · Est 2 h

- **Scope:** decide whether B2 is feasible and record the access paths. B1 is a
  non-goal. Feeds B2-SPIKE.

#### LGL-R2 — Complete the data-deletion story
Deps LGL-R1 · Status todo · Est 4 h

- **Scope:**
  - a purge command
  - clean-up after token revocation
  - age-based retention
  - an operator privacy-policy and terms template with the GDPR roles filled in
    (DECISIONS.md, legal Q6)

#### LGL-R4 — Tighten consent on the unattended and multi-post write paths
Deps PLT-R3, DX-R3 · Status todo · Est 5 h

- **Scope:** tighten consent on the apply-mode, `auto` fallback, batch and
  `run-queue` paths (DECISIONS.md Q3 and legal Q2–Q3):
  - Cut the schedule horizon from 30 days to a fixed 7 days. This is a
    constant, not a setting.
  - Apply mode states that the operator's audit is a precondition for public
    visibility.

#### DX-R4 — Replace the duplicated generic outputSchema with per-tool data schemas
Deps QA-R1 · Status todo · Est 5 h

- **Scope:** the duplicated generic output schema is 28% of `tools/list`.
  Replace it with one data schema per tool.

#### DX-R5 — Cut the tools/list token budget
Deps DX-R4, SEC-R2 · Status todo · Est 3 h

- **Scope:** cut `tools/list` to at most 35 KB with all packages enabled. Today
  it is 49.6 KB. SEC-R2 adds the server instructions.

#### DX-R7 — Explain disabled packages and plan mismatches
Deps — · Status todo · Est 2 h

- **Scope:** explain disabled packages and plan mismatches in the error
  messages.

#### DX-R8 — Tighten schema bounds and error wording
Deps — · Status todo · Est 1 h

- **Scope:** tighten the schema bounds and the error wording.

#### DX-R9 — Add a model-in-the-loop eval harness
Deps DX-R5 · Status todo · Est 6 h

- **Scope:** 10–20 scripted tasks run against a mocked TikTok. Run it on
  demand, outside the default gate.

#### DX-R10 — Smoke-test the live client matrix
Deps REL-R3 · Status blocked: owner (client accounts and machines) · Est 2 h

- **Scope:** smoke-test the server in each live client. This feeds the DX-R3
  matrix.

#### QA-R4 — Harden CI hygiene and cut its cost
Deps REL-R2 · Status todo · Est 3 h

- **Absorbs:** REL-R4.
- **Scope:**
  - job timeouts and concurrency cancel;
  - run the test suite once, not three times on ubuntu/22;
  - an honest Codecov upload, which fails silently today: tokenless OIDC
    (`use_oidc: true`), failing on upload errors on `main` (DECISIONS.md, QA
    Q3);
  - a docs-only light path that keeps the sync gates;
  - decide whether the Node 26 leg becomes required.

#### QA-R5 — Add a nightly exploration profile for properties and protocol versions
Deps QA-R4 · Status todo · Est 3 h

- **Scope:** a nightly run with random seeds and the protocol-version matrix.

#### QA-R6 — Measure assertion strength with a one-off mutation run on the money paths
Deps — · Status todo · Est 4 h

- **Scope:** run Stryker once on `http.ts`, `upload.ts`, `plan-store.ts` and
  `oauth.ts`, and record the score.

#### REL-R6 — Add a version-set script and tidy the tarball surface
Deps REL-R1 · Status todo · Est 2 h

- **Scope:**
  - Add one script that sets the version everywhere.
  - Add a `types` field for the 56 shipped `.d.ts` files.
  - Trim the tarball.

#### REL-R7 — Harden the publish path with an environment and rulesets
Deps REL-R3 · Status todo · Est 1 h

- **Scope** (DECISIONS.md Q6), compatible with the direct-push,
  fast-forward workflow:
  - a protected `npm` environment, limited to `v*` tags and named in the npm
    trusted-publisher configuration;
  - protection on `main` that blocks force-pushes and deletion, with no
    required pull requests;
  - a `v*` tag ruleset: only the owner creates tags, and nobody updates or
    deletes them.

#### PRD-R7 — Define the 90-day success metrics and the feedback channel
Deps REL-R3 · Status todo · Est 2 h

- **Scope:** define the metrics and add an issue template.

#### PRD-R8 — Hold the 90-day review and decide B2 on evidence
Deps PRD-R7 · Status blocked: 90 days after the first publish · Est 1 h

- **Scope:** hold the review and decide B2 on the evidence.

#### PRD-R9 — Docs diet: separate user docs from internal specs
Deps REL-R3 · Status todo · Est 4 h

- **Scope:** separate the user docs from the internal specs.

## Explicit non-goals
- **B1, the Commercial Content API package (`adlib`)**: moved here by the
  round-3 scope freeze (PRD-R1, 2026-10-30). It needs a separate
  client-credentials auth mode for EU-only ad data, which is far from the
  local-first product.
- **A hosted public-posting service**: public posting needs an audited app
  held by an operator who posts for others (DECISIONS.md Q2).
- No ads management, no scraping or
  unofficial endpoints, no multi-tenant hosted deployment, no token brokering
  for third parties, no engagement automation (likes/follows) — both unsupported
  by the API and against platform rules.
