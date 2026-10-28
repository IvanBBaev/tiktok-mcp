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
| `package.json`, `package-lock.json` | Only **H2** changes dependencies. No other item in this queue may add one. If one must, it waits for H2 to be `done`. On a lockfile conflict, take `main`'s lockfile and rerun `npm install`. |
| `src/core/settings.ts`, `docs/CONFIGURATION.md`, `scripts/gen-env-example.ts`, `test/settings.test.ts` | Settings hotspot: at most one live item adds a `TT_*` setting. None of the items below needs one. |
| `src/core/http.ts` | Only **A11** edits it (the egress allowlist). H1 uses the existing seams (`outboundLookup`, `LookupFn`) and must not change this file. |
| `docs/SECURITY.md` | H1 edits only § DNS resolve-and-pin. A11 edits only the egress host list. |

### Which items can run together
H1, H2 and A11 share no owned file, so all three can run at once. Merge order does
not matter; H2 first keeps the lockfile out of the others' rebases. B1, B2-SPIKE and
B2 wait for the owner, and B3 waits for B2.

#### H1 — Pin the login and doctor requests to the vetted DNS answer
Deps — · Status todo · Est 3 h

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
Deps — · Status todo · Est 0.5 h

- **Scope:** `npm audit fix` without `--force` for body-parser (high), fast-uri and
  qs (moderate), all transitive and pre-existing.
- **Owns:** `package-lock.json`. Touch `package.json` only if a range has to move.
- **Shared:** `CHANGELOG.md` (a `Security` bullet).
- **Acceptance:**
  - `npm audit` reports 0 vulnerabilities.
  - `npm run check` is green.
  - The lockfile diff touches only the advised packages and their own dependencies.

#### A11 — Embed tool over oEmbed (`tiktok_get_embed`)
Deps — · Status todo · Est 5 h

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

#### B1 — Commercial Content API package (`adlib`)
Deps — · Status blocked: owner approval (optional 1.4) · Est 12 h

- **Scope:** ad search, ad details and advertiser search over a client-credentials
  token kept separate from user OAuth. EU-only data.
- **Before anyone starts:** the owner must approve the item and the new auth mode.

#### B2-SPIKE — Can an individual developer get Business API access?
Deps — · Status blocked: owner (apply for the app in the TikTok developer portal) · Est 2 h

- **Scope:** apply for access, record the outcome and limits in
  `docs/probes/PROBE-LOG.md`, and give a GO or NO-GO for B2.

#### B2 — Business Accounts package
Deps B2-SPIKE · Status todo · Est 30 h

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
Deps B2 · Status todo · Est 3 h

- **Scope:** route `comment.update` events through the existing webhook receiver
  and subscription hub (1.2 work, done) to comment resources.
- **Owns:** a new handler module next to `mcp/webhook`.
- **Shared:** `src/index.ts` wiring.

## Explicit non-goals
- No ads management, no scraping or
  unofficial endpoints, no multi-tenant hosted deployment, no token brokering
  for third parties, no engagement automation (likes/follows) — both unsupported
  by the API and against platform rules.
