# Design Review — Senior DevOps / Release Engineer

## 1. Reviewer & scope

- **Role**: Senior DevOps / Release Engineer — npm publishing, GitHub Actions, supply-chain
  security, developer-tooling distribution.
- **Date**: 2026-07-21.
- **Documents reviewed**: `README.md`, `docs/ARCHITECTURE.md`, `docs/TIKTOK-API.md`,
  `docs/TOOLS.md`, `docs/AUTH.md`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`,
  `docs/TESTING.md`, `docs/ROADMAP.md`.
- **Baseline**: the sibling `servicenow-mcp-ai` production setup (ci.yml Node matrix +
  macOS/Windows/ancient-Node legs, codeql.yml, publish.yml + publish-mcp.yml,
  `prepublishOnly` gate, `files` allowlist, `.cjs` launcher, `server.json` via
  `gen:manifest`), as documented in the architecture reference map this design explicitly
  ports from.
- **Scope**: CI design, publish pipeline, supply-chain posture, distribution artifacts
  (npm package, `server.json`, Claude Code plugin, bin launcher), operational behavior of
  the local stdio process, release cadence and versioning. Functional/tool-surface design
  is reviewed only where it has release or operations consequences.

## 2. Executive summary

**Verdict: Approve with changes.**

This is one of the better-prepared pre-code designs I have reviewed. It inherits a proven
release shape from `servicenow-mcp-ai` (three runtime deps, `files` allowlist,
`prepublishOnly` full gate, `.cjs` engines guard, docs-sync gates implemented as tests,
CI with zero external network), and — critically for a token-handling tool — the design
keeps **CI free of secrets by construction**: every TikTok interaction in tests is mocked,
coverage is gated locally by `c8`, and no third-party upload service is specified. That
invariant must now be written down as policy, because it is currently only an accident of
the test strategy.

The gaps are almost all in the parts the docs treat as a Phase-3 afterthought: the release
pipeline itself. Nothing in the spec mentions npm **provenance or trusted publishing**,
version/tag/CHANGELOG discipline, or how `server.json` stays version-locked to the npm
package at publish time. CI arrives only in Phase 3 even though Phases 0–2 have exit gates
that depend on `npm run check` being green — two full phases of load-bearing gates with no
enforcement. And the single largest internal contradiction: the planned CI has a
**Windows leg**, while the configuration/security design assumes XDG paths and
`chmod 0600` with tests that *assert the 0600 mode* — assertions that cannot pass on
Windows as written. None of this requires redesign; it requires roughly one page of
additional spec (release engineering section) and a handful of ROADMAP moves. Hence
approve **with changes**, all of them actionable before Phase 0 ends.

## 3. Strengths

- **Zero-secret CI by design.** `docs/TESTING.md` § Integration: "CI never talks to
  TikTok — all network is mocked." No Codecov or other token-bearing uploader is
  specified; the coverage gate is local (`c8 --check-coverage`). This is the correct
  posture and rare to see stated pre-code.
- **Publish allowlist and gate inherited correctly.** `docs/SECURITY.md` § Supply chain:
  `files` allowlist ships only `build/` + `bin/` (no maps, no source, no env files),
  `prepublishOnly` runs the full gate, lockfile committed, three runtime dependencies.
  Minimal attack and audit surface.
- **`.cjs` launcher + Node guard** (`docs/ARCHITECTURE.md` § 2): the CommonJS bin performs
  the version check before the ESM graph is parsed, so ancient Node gets a readable error
  instead of a `SyntaxError`. This is the only engines enforcement that actually reaches
  consumers (npm `engines` alone only warns), and the design gets it right.
- **Docs-sync gates as tests, not conventions.** `readme-sync`, `env-docs-sync`, and the
  tool-manifest snapshot (`docs/TESTING.md` § Sync gates) mean the README tool table,
  `.env.example`, and the tool surface cannot drift without a red diff in CI. This is the
  cheapest possible docs-drift firewall and it is already specified.
- **stdout is protocol, stderr is logs** (`docs/ARCHITECTURE.md` § 2, § 10) — the classic
  stdio-MCP operational failure (a stray `console.log` corrupting the JSON-RPC stream) is
  designed out, with redaction specified and tested.
- **Client-side rate limiting as a support-load reducer.** The 6/min publish token bucket
  and the no-auto-retry rule for publish inits (`docs/ARCHITECTURE.md` § 6) mean the
  server hits its own limiter before TikTok's spam systems — fewer mystery
  `spam_risk_too_many_posts` tickets, no duplicate posts from retried inits.
- **`doctor` as a first-class CLI** (`docs/ARCHITECTURE.md` § 2) with offline + online
  checks, scope-vs-package comparison, and telemetry counters — exactly the support tool a
  distributed local process needs.
- **Honest upstream-facts hygiene**: `docs/TIKTOK-API.md` marks every unverified constraint
  *(verify at implementation time)* and dates its verification (2026-07-21). This
  materially de-risks the implementation phase.
- **Explicit non-goals** (`docs/ROADMAP.md`): no scraping, no dark scaffolds, no hosted
  multi-tenant mode — keeps the release artifact small and the compliance story clean.

## 4. Findings

### F1 — Windows is implied by CI but undesigned (XDG paths, `chmod 0600`, journal path)

- **Severity: High**
- **Issue**: `docs/ROADMAP.md` Phase 3 plans a CI **Windows leg**, but the entire
  configuration/security story assumes POSIX: env file at XDG
  `~/.config/tiktok-mcp-ai/.env` written `chmod 0600` (`docs/CONFIGURATION.md` intro,
  `docs/AUTH.md` § 4, `docs/SECURITY.md` § Secrets), journal at
  `~/.config/tiktok-mcp-ai/journal.ndjson` (`docs/ARCHITECTURE.md` § 8), and a test that
  *asserts* the 0600 mode (`docs/TESTING.md` § core/config).
- **Operational failure**: on win32, `fs.chmod` only toggles the read-only attribute;
  `stat().mode` reports 0666/0444-style values, so the "0600 mode asserted" test **cannot
  pass on the Windows leg** — the leg is either permanently red or the assertion gets
  silently skipped, quietly voiding the security claim. Separately, `~/.config` on Windows
  is un-idiomatic (users won't find their credentials file; support instructions in docs
  won't match reality), and `SECURITY.md`'s "chmod 0600" promise is simply false on the
  platform CI claims to support.
- **Recommendation**: decide Windows support explicitly, then spec it:
  1. Platform-aware data dir: `%APPDATA%\tiktok-mcp-ai\` on win32 (or honor
     `XDG_CONFIG_HOME` when set), POSIX XDG elsewhere — one resolver in `core/settings.ts`.
  2. On win32, skip the chmod call and the mode assertion **with a named skip reason**,
     and state in SECURITY.md that Windows protection relies on per-user profile ACLs
     (which are adequate for a single-user desktop process).
  3. Define what the Windows CI leg actually asserts (path resolution, atomic rename
     semantics, journal writes) so it is a real gate, not a checkbox.
  See Deep dive A.
- **Doc refs**: `docs/CONFIGURATION.md` (intro), `docs/AUTH.md` § 4, `docs/SECURITY.md`
  § Secrets, `docs/TESTING.md` § core/config, `docs/ROADMAP.md` Phase 3.

### F2 — CI deferred to Phase 3 while Phases 0–2 exit gates depend on it

- **Severity: High**
- **Issue**: `docs/ROADMAP.md` puts CI, CodeQL, and dependabot in Phase 3, but Phase 0's
  exit gate is "`npm run check` green; coverage gate active" and Phases 1–2 build the
  entire tool surface. All gating for two phases is local-machine-only.
- **Operational failure**: unenforced gates drift (a forgotten `npm run check`, a
  platform-specific breakage discovered months later when the matrix first runs), and the
  Phase 3 "add CI" task becomes "fix everything CI finds," landing in the same phase as
  the first publish — maximum schedule risk at the worst moment.
- **Recommendation**: create `.github/workflows/ci.yml` in **Phase 0** with a single leg
  (ubuntu, Node 22: `npm ci && npm run check`-equivalent). Grow it to the full matrix in
  Phase 3. Enable CodeQL and dependabot the moment `src/` exists — both are free for
  public repos and need no configuration beyond defaults (see F13).
- **Doc refs**: `docs/ROADMAP.md` Phases 0 and 3.

### F3 — No provenance / trusted-publishing / token policy in the publish design

- **Severity: High**
- **Issue**: the publish pipeline is specified only as "publish workflows (npm + MCP
  registry)" (`docs/ROADMAP.md` Phase 3) and "`prepublishOnly` runs the full gate"
  (`docs/SECURITY.md`). Nothing specifies **npm trusted publishing (OIDC)**, `--provenance`
  attestations, or a prohibition on long-lived automation tokens in repo secrets.
- **Operational failure**: the default path (a classic `NPM_TOKEN` in GitHub secrets) is
  precisely the vector behind the 2025 npm supply-chain incidents. For a package whose job
  is holding OAuth tokens, shipping without provenance also costs trust: consumers and
  registries increasingly check for attestations, and you cannot retrofit provenance onto
  already-published versions.
- **Recommendation**: write a short "Release engineering" section into the spec:
  - Publishing happens **only** from a GitHub Actions workflow via **npm trusted
    publishing** (OIDC; `permissions: id-token: write`), which produces provenance
    automatically. No npm token is ever stored in repo secrets.
  - The npm account requires 2FA; the **first** publish of the package (before a trusted
    publisher can be configured for it) is done manually with 2FA, then the trusted
    publisher is configured and tokens are never used again.
  - Provenance requires a public repo and GitHub-hosted runners — both already true here.
  See Deep dive B.
- **Doc refs**: `docs/ROADMAP.md` Phase 3, `docs/SECURITY.md` § Supply chain.

### F4 — Version / tag / CHANGELOG discipline is unspecified

- **Severity: High**
- **Issue**: the docs mention "npm publish `0.x`" and "CHANGELOG" as Phase-3 artifacts but
  define no release trigger, no rule that the git tag equals `package.json` version equals
  `server.json` version, and no CHANGELOG format or gate.
- **Operational failure**: the classic failure family — tag `v0.2.0` published as `0.1.9`
  because `package.json` wasn't bumped; MCP registry rejecting a `server.json` whose
  version doesn't exist on npm; a release with no CHANGELOG entry so users diff tarballs
  to find out what changed. All of these generate support load and erode trust, and npm
  versions are immutable so mistakes are permanent (`deprecate` is the only undo).
- **Recommendation**: specify: releases are cut by pushing a tag `vX.Y.Z` (or publishing a
  GitHub Release); the publish workflow **fails fast** unless
  `tag == package.json.version == server.json.version` and `CHANGELOG.md` contains a
  `## X.Y.Z` heading. CHANGELOG follows Keep-a-Changelog. Pre-1.0 semantics documented:
  0.x minor bumps may break tool-surface compatibility (the manifest snapshot test tells
  you when they do).
- **Doc refs**: `docs/ROADMAP.md` Phase 3; `docs/ARCHITECTURE.md` § 5 (manifest snapshot
  as the breaking-change detector).

### F5 — `server.json` lifecycle and npm↔registry ordering not specified

- **Severity: Medium**
- **Issue**: `server.json` is mentioned as generated (`docs/CONFIGURATION.md` last
  paragraph; ROADMAP Phase 1) but nothing specifies: a `gen:manifest --check` CI gate (the
  env-var table and `isSecret`/`isRequired` flags can drift), the ordering of npm publish
  vs. MCP-registry publish, or handling of the registry's validation that the version
  exists on npm (with `mcpName` in `package.json` matching the registry id).
- **Operational failure**: a stale `server.json` published to the registry with wrong env
  vars misconfigures every user who installs via the registry; publishing to the registry
  before npm propagation completes fails intermittently (a flaky release pipeline is a
  pipeline people bypass by hand).
- **Recommendation**: (1) `server.json` is generated from `package.json` (version, name)
  plus the same source that generates `.env.example`, and CI runs the generator in
  `--check` mode alongside `env-docs-sync`; (2) registry publish is a separate job that
  runs **after** npm publish succeeds, polls the npm registry until the version is
  visible (bounded retry), then publishes via the MCP publisher CLI's **GitHub OIDC**
  login (no stored secret — the `io.github.IvanBBaev/*` namespace authenticates via OIDC);
  (3) pin the `server.json` schema version and re-check it at each release. See Deep
  dive C.
- **Doc refs**: `docs/CONFIGURATION.md` (final paragraph), `docs/ROADMAP.md` Phases 1
  and 3, `README.md` (registry id).

### F6 — `npm audit` as a hard gate in `check`/`prepublishOnly` is release-fragile

- **Severity: Medium**
- **Issue**: the design inherits `check` = verify + coverage + `npm audit`
  (`docs/SECURITY.md` § Supply chain), and `prepublishOnly` runs `check`. `npm audit`
  consults the live advisory DB: its result changes without any code change.
- **Operational failure**: a new advisory against a dev-only transitive dependency turns
  every branch red and **blocks an urgent release** (e.g. a security fix of your own) until
  an unrelated upstream publishes. It also makes `prepublishOnly` network-dependent.
- **Recommendation**: split the concern: PR/release gate runs
  `npm audit --omit=dev --audit-level=high` (runtime deps only — with 3 runtime deps this
  will essentially never fire falsely); the full audit runs in a **scheduled** weekly
  workflow plus dependabot alerts. Document an explicit break-glass note that a failing
  scheduled audit does not block tag-based publishes of unrelated fixes.
- **Doc refs**: `docs/SECURITY.md` § Supply chain; baseline `check` script.

### F7 — Node support policy: Node 20 is already EOL

- **Severity: Medium**
- **Issue**: engines `>= 20` with matrix 20/22/24 (`README.md` § Requirements,
  `docs/ROADMAP.md` Phase 3). Node 20 reached end-of-life on 2026-04-30 — before this
  project's first release can possibly ship.
- **Operational failure**: the matrix spends a leg testing an unpatched runtime; engines
  `>=20` implicitly endorses running an OAuth-token-holding process on an EOL Node; and
  when you later raise engines it is a breaking change requiring a major/minor bump you
  could avoid now for free (no users yet).
- **Recommendation**: set `engines: node >= 22` at Phase 0; matrix 22/24 (+ current
  non-LTS as a non-blocking leg if desired — note the sibling's coverage-guard found
  c8 breakage on Node ≥ 25, so keep coverage gating on the LTS legs). Write a one-line
  support policy: "supported = active LTS lines; engines raised in a minor within 0.x, in
  a major after 1.0."
- **Doc refs**: `README.md` § Requirements, `docs/ARCHITECTURE.md` intro,
  `docs/ROADMAP.md` Phases 0 and 3.

### F8 — Cross-process refresh race: token rotation with two MCP clients

- **Severity: Medium**
- **Issue**: the refresh mutex is single-flight **per profile, per process**
  (`docs/AUTH.md` § 2). Real users run the same server config in Claude Desktop *and*
  Claude Code simultaneously — two processes sharing one env file. TikTok **rotates
  refresh tokens** on refresh (`docs/TIKTOK-API.md` § 2), and the docs require persisting
  the returned token.
- **Operational failure**: process A refreshes and persists a rotated refresh token;
  process B still holds the pre-rotation token in its in-memory snapshot and later
  refreshes with it. If TikTok invalidates rotated-away tokens, B's refresh fails
  terminally → intermittent "authorization expired — log in again" reports that no one can
  reproduce. This is the exact class of bug that dominates issue trackers for local
  credential-holding tools.
- **Recommendation**: before refreshing, re-read the env file and use its refresh token if
  it is newer than the in-memory one; hold an advisory **file lock** (lockfile beside the
  env file) around the read-refresh-persist sequence. Add a `doctor` check that detects
  multiple concurrent server processes for the same profile. Spec this in AUTH.md § 2 now —
  it shapes the config-store API.
- **Doc refs**: `docs/AUTH.md` § 2, § 4; `docs/ARCHITECTURE.md` § 7.

### F9 — `journal.ndjson`: no rotation, no size cap, undefined failure semantics

- **Severity: Medium**
- **Issue**: every applied publish appends to `~/.config/tiktok-mcp-ai/journal.ndjson`
  (`docs/ARCHITECTURE.md` § 8; `docs/SECURITY.md` § Write safety). No maximum size,
  rotation, or behavior when the append fails (disk full, directory unwritable, ACL
  issue) is specified.
- **Operational failure**: unbounded growth is slow here (publishes are rate-capped) but
  nonzero over years; the sharper issue is failure semantics — if a journal append error
  aborts the publish, a full disk blocks posting for no user-visible reason; if it's
  silently swallowed, the audit trail has invisible holes.
- **Recommendation**: specify: journal append failure is a **logged warning, never a
  publish failure**, and the tool result carries `journal: "unavailable"` so the gap is
  visible; rotate at a size threshold (e.g. 5 MB → `journal.ndjson.1`, keep one
  generation, or `TT_JOURNAL_MAX_BYTES`); `doctor` reports journal path, size, and last
  entry. On Windows the journal follows the F1 data-dir resolution.
- **Doc refs**: `docs/ARCHITECTURE.md` § 8, `docs/SECURITY.md` § Write safety.

### F10 — npx staleness: the distribution channel has no version-drift story

- **Severity: Medium**
- **Issue**: every documented invocation path — README quickstart, the planned Claude Code
  plugin manifest, `login`/`doctor` instructions — uses `npx -y tiktok-mcp-ai`. npx serves
  a **cached** version and does not reliably auto-update.
- **Operational failure**: a user reports a bug fixed three releases ago; support burns
  time before discovering their npx cache pins 0.2.1. With a plugin manifest fanning the
  same command out to many users, an urgent fix (e.g. a redaction bug) does not actually
  reach users on publish.
- **Recommendation**: `doctor` must print its own version and the latest version on npm
  (one registry metadata fetch, still no secrets) with an update hint; docs and the plugin
  manifest should standardize on `npx -y tiktok-mcp-ai@latest` (or document the cache
  behavior explicitly); the GitHub issue template asks for `doctor` output, which then
  answers the version question automatically.
- **Doc refs**: `README.md` § Quickstart, `docs/ROADMAP.md` Phase 3 (plugin manifest).

### F11 — Release cadence vs. the TikTok audit: first-release UX is SELF_ONLY

- **Severity: Medium**
- **Issue**: Phase 3 publishes `0.x` **and then** submits the TikTok content-sharing audit
  (`docs/ROADMAP.md`). Until the audit passes — typically weeks, with possible
  resubmissions — every install posts `SELF_ONLY` and at most 5 users/24 h can post
  (`docs/TIKTOK-API.md` § 7). The docs handle this well *inside* tools (creator_info-driven
  privacy, explanatory errors) but not in the release artifacts.
- **Operational failure**: the npm README is the storefront; users who miss the caveat file
  "posting is broken / everything is private" issues, and early-adopter sentiment is set by
  an upstream restriction, not the software. Meanwhile audit resubmission cycles may need
  fast doc/UX tweaks — if the release pipeline is heavyweight, the audit stalls.
- **Recommendation**: (1) the published README carries the audit status as a top-level
  banner (unaudited → SELF_ONLY), updated at audit pass; (2) `doctor` surfaces audit state
  empirically (creator_info returning only `SELF_ONLY` ⇒ "app unaudited") so support triage
  is one command; (3) define **1.0 criteria = audit passed + tool surface stable**, keeping
  0.x semantics honest; (4) keep the pipeline cheap enough that doc-only patch releases
  during the audit window are a 5-minute operation — which the F3/F4 workflow gives you.
- **Doc refs**: `docs/ROADMAP.md` Phase 3, `docs/TIKTOK-API.md` § 7–8, `README.md`
  § Requirements.

### F12 — Tarball content is asserted in prose but not gated

- **Severity: Low**
- **Issue**: SECURITY.md promises the tarball ships only `build/` + `bin/` (no maps, no
  env files), but nothing verifies the realized tarball. `files` allowlists are easy to
  regress (a renamed build dir, a new top-level asset, maps un-excluded by a glob edit).
  There is also no stated invariant that the package has **no install scripts**.
- **Operational failure**: a silently fattened tarball ships source maps or fixtures; worse,
  an accidental `postinstall` (e.g. added by tooling) is the #1 red flag in supply-chain
  scanners and would tank trust in a credential-handling package.
- **Recommendation**: add a CI "pack audit" step: `npm pack --dry-run --json`, snapshot
  the file list as a fixture (same pattern as the tools-manifest snapshot), and assert
  `package.json` contains no `preinstall`/`install`/`postinstall`. Two lines of test,
  permanent guarantee.
- **Doc refs**: `docs/SECURITY.md` § Supply chain, `docs/TESTING.md` § Sync gates.

### F13 — Workflow hardening & the ancient-Node launcher probe are missing from the plan

- **Severity: Low**
- **Issue**: ROADMAP's CI list ("Node 20/22/24 matrix + macOS + Windows leg, CodeQL,
  dependabot") omits: the sibling's **ancient-Node launcher probe** (run the `.cjs` bin on
  Node ≈14–16, assert the friendly error and non-zero exit); action **SHA-pinning**;
  least-privilege workflow `permissions`; dependabot's `github-actions` ecosystem; and a
  ban on `pull_request_target`.
- **Operational failure**: the launcher guard is the one code path no normal matrix leg
  ever executes — it only breaks in the field, on the machines of exactly the users least
  able to debug it. Unpinned third-party actions are a real compromise vector (2025's
  action-hijacking incidents), and with zero secrets the blast radius is small but the
  provenance-signing publish job is still a target.
- **Recommendation**: add the probe as a tiny CI job; pin all actions to commit SHAs;
  default `permissions: contents: read` at workflow level, `id-token: write` only on the
  publish job; dependabot covers both `npm` and `github-actions` weekly; never use
  `pull_request_target`. Codify **"CI requires zero repository secrets; adding one is a
  design-review event"** in SECURITY.md — this is the finding that locks in the project's
  best property.
- **Doc refs**: `docs/ROADMAP.md` Phase 3, `docs/SECURITY.md` § Supply chain.

### F14 — Build/test scripts inherit POSIX-isms that break Windows contributors

- **Severity: Low**
- **Issue**: the baseline build script ends with `chmod 755 build/index.js`, and the rm
  step is node-shimmed but chmod is not. With a Windows CI leg and potential Windows
  contributors, `npm run build` must work in cmd/PowerShell.
- **Operational failure**: Windows leg fails at build before any test runs; contributors
  on Windows cannot develop.
- **Recommendation**: make scripts platform-neutral: do the chmod via
  `node -e "process.platform!=='win32'&&require('fs').chmodSync('build/index.js',0o755)"`
  (or drop it — npm sets the exec bit for `bin` entries at install time; the direct-exec
  convenience is dev-only). Same review for any future script using `rm`, `cp`, or glob
  expansion.
- **Doc refs**: `docs/ROADMAP.md` Phase 0; baseline package.json scripts.

### F15 — Quickstart routes the client secret through the MCP client config

- **Severity: Low**
- **Issue**: `README.md` § Quickstart shows `TT_CLIENT_KEY`/`TT_CLIENT_SECRET` inline in
  the MCP client's JSON config. That file (e.g. `claude_desktop_config.json`) is plaintext
  with default permissions — outside the carefully specified 0600 env-file story.
- **Operational failure**: the project's own recommended setup undercuts its secret-storage
  design; secrets end up in a world-readable-ish config that users paste into bug reports.
- **Recommendation**: make the documented happy path "put app credentials in the XDG env
  file (or run `login`, which writes it) and keep the MCP client config secret-free"; show
  the inline-env variant as the alternative, with a caveat. Env-first precedence
  (`docs/CONFIGURATION.md`) already supports both.
- **Doc refs**: `README.md` § Quickstart, `docs/CONFIGURATION.md` (resolution order),
  `docs/SECURITY.md` § Secrets.

### F16 — Package name is announced but unreserved during a public design phase

- **Severity: Low**
- **Issue**: `README.md` names the npm package `tiktok-mcp-ai` and the registry id
  `io.github.IvanBBaev/tiktok-mcp-ai` months before Phase 3 publishes anything.
- **Operational failure**: npm names are first-come-first-served; a squatted name at
  Phase 3 means renaming the package, the bin, the env-file directory, `mcpName`, and the
  plugin manifest — a cross-cutting rename late in the project. Secondary risk: "tiktok"
  in the name is exposed to a trademark dispute under npm's policy (low likelihood,
  nonzero; the sibling's `-ai` suffix pattern and clear "unofficial" README language
  mitigate).
- **Recommendation**: decide deliberately: either reserve the name early (publish a
  minimal honest `0.0.1` placeholder stating "design phase, see repo") or accept the risk
  and pre-plan the fallback name. The MCP registry id is namespace-protected by GitHub
  OIDC and is not at risk.
- **Doc refs**: `README.md` (intro).

## 5. Proposed CI/publish pipeline

Concrete shape the project should adopt (names/steps map to existing scripts):

### `ci.yml` — every push to `main` and every PR

```yaml
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  verify:            # fast feedback leg — ubuntu, Node 22 (.nvmrc)
    steps: npm ci → npm run lint → npm run format:check → npm run build → npm test
  test-matrix:       # os: [ubuntu] × node: [22, 24]  +  macos/node 22  +  windows/node 22
    steps: npm ci → npm run build → npm test
    # coverage gate (c8 --check-coverage) runs on ubuntu/22 only (c8 breaks on newest Node)
  launcher-probe:    # ubuntu + old Node (e.g. 16): node bin/tiktok-mcp-ai.cjs
    # assert: non-zero exit AND the friendly "Node >= 22 required" message
  pack-audit:        # npm pack --dry-run --json → diff vs test/fixtures/pack-manifest.json
    # assert: no install scripts in package.json
  audit-deps:        # npm audit --omit=dev --audit-level=high (runtime deps only)
```

Blocking for merge (branch protection): `verify`, `test-matrix`, `launcher-probe`,
`pack-audit`. The docs-sync gates (`readme-sync`, `env-docs-sync`, tools-manifest
snapshot, `gen:manifest --check` for `server.json`) run **inside `npm test`**, so they are
automatically blocking on every leg — keep it that way rather than as separate workflow
steps that can be forgotten.

### `codeql.yml` — push/PR + weekly schedule

Default JavaScript/TypeScript CodeQL setup. Enable from the first commit containing
`src/` (Phase 0), not Phase 3.

### `audit-schedule.yml` — weekly cron

Full `npm audit` (including dev deps), non-blocking for releases; failures surface as a
red scheduled run + dependabot alerts. This is where advisory noise lives, instead of in
`prepublishOnly` (F6).

### `publish.yml` — trigger: push of tag `v*` (or GitHub Release published)

```yaml
jobs:
  verify:        # full gate again, ubuntu/22: build + lint + format + test + coverage
  release-guard: # fail unless: tag == package.json.version == server.json.version
                 #              && CHANGELOG.md has "## <version>" heading
  npm-publish:
    needs: [verify, release-guard]
    permissions: { id-token: write, contents: read }
    # npm trusted publishing (OIDC) — NO NPM_TOKEN secret anywhere.
    # Provenance attestation is generated automatically under trusted publishing.
    steps: npm ci → npm run build → npm publish --access public
  mcp-registry-publish:
    needs: npm-publish
    permissions: { id-token: write, contents: read }
    steps:
      - poll registry.npmjs.org until <version> is visible (bounded, ~5 min)
      - mcp-publisher login github-oidc      # namespace io.github.IvanBBaev — no secret
      - mcp-publisher publish                # server.json, version == npm version
```

Rules: `prepublishOnly` stays as a belt-and-braces local gate but the **only** sanctioned
publish path is this workflow; the first-ever publish is manual with 2FA to create the
package, after which the trusted publisher is configured and tokens are retired. Zero
repository secrets across all workflows — an explicit, documented invariant.

### `dependabot.yml`

`npm` (weekly) + `github-actions` (weekly). All actions referenced by SHA.

### Phase mapping

Phase 0: `ci.yml` (single leg) + CodeQL + dependabot + pack-audit. Phase 1: add
docs-sync/manifest gates as they appear (they are tests, so free). Phase 3: widen the
matrix (macOS/Windows/launcher-probe), add `publish.yml`/registry job, cut `v0.x`.

## 6. Deep dive

### A. Windows reality check: XDG and 0600 do not port

The design's secret-storage contract — XDG path + `chmod 0600` + atomic
rename + a test asserting the mode — is correct and testable on Linux/macOS. On Windows,
three of those four pillars change:

1. **`chmod` is a fiction.** Node's `fs.chmod` on win32 maps only to the FILE_ATTRIBUTE
   read-only bit. Setting `0o600` does nothing meaningful; `fs.stat` will report a
   synthesized mode (typically `0o666`). The TESTING.md assertion "`0600` mode asserted"
   will fail. The equivalent protection on Windows is the **default ACL of the user
   profile directory** (`C:\Users\<user>\AppData\...` is not readable by other
   non-admin users), which is comparable in practice to 0600 for the stated threat model
   ("other local processes reading files" — SECURITY.md scopes this to other *users*'
   processes; same-user processes can read the file on every OS). The honest spec is:
   POSIX → 0600 enforced and asserted; Windows → rely on profile ACLs, skip chmod, assert
   instead that the file landed under the per-user data dir. Optionally harden with
   `icacls` later — do not block v1 on it.
2. **Path conventions.** `~/.config` exists on Windows only if something created it; the
   idiomatic location is `%APPDATA%\tiktok-mcp-ai\` (roaming) or `%LOCALAPPDATA%`
   (machine-local — arguably better for tokens, which should not roam between machines
   via domain profiles). Recommended resolver: `TT_ENV_FILE` (explicit) →
   `$XDG_CONFIG_HOME` if set → win32 ? `%LOCALAPPDATA%\tiktok-mcp-ai` :
   `~/.config/tiktok-mcp-ai`. The journal and any future state follow the same resolver —
   one function, one test per platform.
3. **Atomic rename** (`rename(2)`-style replace) behaves differently on Windows when the
   destination is open by another process (EPERM/EBUSY instead of atomic replace). With
   F8's file lock this is largely mooted, but the config writer should retry-on-EPERM
   briefly on win32. This is exactly the behavior the Windows CI leg should exercise —
   giving that leg a real job (F1.3) beyond re-running platform-neutral unit tests.

Decision to record in the spec: **Windows is supported, with documented ACL-based secret
protection**, or **Windows is unsupported and the CI leg is dropped**. Given `npx` as the
distribution channel, Windows users will arrive either way; supporting them deliberately
is cheaper than supporting them accidentally.

### B. npm trusted publishing & provenance — the publish path for a credential-handling package

Context: the 2024–2025 npm supply-chain incidents (token exfiltration, the Sept-2025
self-replicating worm attacking maintainer tokens) ended the era of long-lived automation
tokens as acceptable practice. npm's answer is **trusted publishing**: the registry trusts
a specific GitHub repository + workflow identity via OIDC, so publishing requires no
stored credential at all, and each publish carries a **provenance attestation** (SLSA)
linking the tarball to the exact commit, workflow, and runner that produced it —
verifiable via `npm audit signatures` and shown on the npm package page.

Why it matters disproportionately here: this package's entire value proposition is "trust
me with your TikTok OAuth tokens." A provenance-verified, zero-secret release path is a
*feature* of that trust story, and it should be stated in SECURITY.md alongside the
threat model. The operational recipe:

1. **First publish** (Phase 3): manual, from a clean checkout, npm account with 2FA
   (security-key or TOTP). This creates the package so it can be configured.
2. On npmjs.com → package → Settings → **Trusted Publisher**: bind
   `IvanBBaev/tiktok-mcp` + `publish.yml` (+ environment, if used). From now on, publish
   access = "this workflow on this repo," revocable in one click.
3. The workflow job needs `permissions: id-token: write` and a current npm CLI (Node 24's
   bundled npm suffices; on Node 22 update npm in the job). Under trusted publishing,
   provenance is generated by default — no `--provenance` flag juggling, though keeping
   the flag explicit documents intent.
4. Constraints to respect: provenance requires the repo to be public at publish time and
   GitHub-hosted runners (both true here); versions are immutable — the F4 release-guard
   job is what stands between a typo and a permanently-burned version number.
5. **Account hygiene** remains: 2FA enforced, no legacy tokens left alive, publishing
   config change = security event. With trusted publishing configured, consider setting
   the package to disallow token-based publishes entirely.

The same zero-secret pattern extends to the MCP registry: the `io.github.*` namespace
authenticates the publisher CLI via **GitHub Actions OIDC** (`login github-oidc`), so the
registry job also holds no secret. The end state — worth writing as a single sentence in
SECURITY.md — is: *the repository contains no secrets, CI holds no secrets, and no
credential exists whose theft allows publishing this package.*

### C. `server.json` / MCP-registry manifest lifecycle

The registry manifest is small but has three failure modes the spec should close:

1. **Drift.** `server.json` duplicates facts owned elsewhere: the version
   (`package.json`), the env-var surface with `isSecret`/`isRequired`
   (`docs/CONFIGURATION.md` table → `core/settings.ts`), the package/registry identity
   (`mcpName`). The design already generates `.env.example` from the same table and gates
   it with `env-docs-sync`; `server.json` must join that regime: `gen:manifest` reads
   `package.json` + the settings source, and CI runs it in `--check` mode. A hand-edited
   `server.json` should be impossible to merge. The `mcpName` field in `package.json`
   must equal the registry id — the registry uses it to verify npm-package ownership, and
   it is the one identity fact with no other consumer, i.e. the one most likely to rot
   silently; the check-mode gate covers it.
2. **Ordering.** The registry validates that the referenced npm package version actually
   exists. Publishing the manifest in the same breath as `npm publish` races npm's
   propagation. The pipeline in § 5 serializes: npm publish → poll until the version is
   visible → registry publish, with bounded retry. If the registry step still fails, the
   release is *partially* out — npm has the version, the registry does not. Make the
   registry job idempotent and safely re-runnable (`workflow_dispatch` with a version
   input) so recovery is "re-run job," not "cut 0.x.y+1."
3. **Schema evolution.** `server.json` pins a dated schema URL. The registry is young and
   its schema moves; dependabot will never flag it. Two cheap mitigations: validate
   `server.json` against the pinned schema in CI (catches accidental invalidity), and
   treat a registry-publish failure with a schema error as the upgrade signal. Check the
   schema version as a step in each release's checklist rather than assuming stability.

One more registry-adjacent artifact deserves the same discipline: the **Claude Code plugin
manifest** (`.claude-plugin/`, ROADMAP Phase 3) embeds the `npx` invocation and the
package name. It has no external validator at all, so it is pure trust-me configuration —
cover it with a trivial test asserting the command string references the `package.json`
name (and the `@latest` policy from F10), and bump it in the F4 release-guard checklist.

---

*End of review. Verdict: **Approve with changes** — proceed to Phase 0 once F1–F4 are
reflected in the spec (a short "Release engineering" addition plus ROADMAP moves); the
remaining findings can land as Phase-0/Phase-3 checklist items.*
