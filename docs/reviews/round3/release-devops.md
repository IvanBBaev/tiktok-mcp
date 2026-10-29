# Round 3 — Release & DevOps review

Date 2026-10-29 · Commit `301b9bb` (main) · Reviewer: senior Release & DevOps engineer (npm trusted publishing/provenance, GitHub Actions, MCP Registry, VS Code Marketplace) · Scope: version strategy, CHANGELOG vs `release-guard`, the G-14 bootstrap and G-4 Pages enablement, all six workflows, the main-branch CI failure of 2026-10-29, dependabot PRs #36–#38, version consistency across manifests, the `bin/` shim, the npm tarball, the Node matrix, WORKLOG hygiene, and the round-2 DevOps review (`docs/reviews/round2/devops-deep-review.md`).

## Verdict

The release *machinery* is unusually good for a one-person project. The workflows are SHA-pinned and least-privilege, trusted publishing is OIDC-only, the `mcp-publisher` binary is checksum-verified, the followers are safely chained with `workflow_run`, the registry-state skip only acts on proof, and the tarball is checked against a manifest. None of it has ever run, though. **Nothing has been released.** The package is E404 on npm, there are no tags or GitHub releases, and Pages is off.

As of today the repository **cannot** release. `release-guard --tag v1.0.0` exits 1 because `[Unreleased]` holds 14 entries. The `VSCE_PAT` secret that the Marketplace follower needs does not exist. A dormant `NPM_TOKEN` secret contradicts the "no token anywhere" design. Main CI is red on the latest A11 commit because of a flaky virtual-clock test.

"1.0.0" was cut on 2026-10-23 without being shipped, and it has since been overtaken by about 1.1–1.3 worth of features. It is also undermined by two of its own criteria: a manual first publish carries no provenance, and the code has never touched the real TikTok API. I recommend making the first public version a **0.x bootstrap** (0.9.0), then cutting 1.0.0 from CI with provenance once the sandbox probes have run.

**Readiness score: 4/10.** Pipeline design alone would earn 8–9. The score is held down by release-blocking state (guard red, CI flaky, a missing secret, an inconsistent version story) and by having zero end-to-end release exercises.

## What is strong

- **Pinning and permissions.** Every action is pinned to a full SHA. `ci.yml` uses `contents: read`. `publish.yml` gets only `contents: write` and `id-token: write`, with `persist-credentials: false` and no `registry-url`, so no `_authToken` is ever written (`.github/workflows/publish.yml:36-98`). `mcp-publisher` v1.8.1 is checked with `sha256sum --check --strict` (`.github/workflows/publish-mcp.yml:62-76`).
- **Follower chaining.** `publish-mcp.yml` and `publish-vscode.yml` gate on the Publish `workflow_run` result: success, the right workflow path, a push event, and the same repository. A premature tag therefore cannot ship a Marketplace version that points at a missing npm package (`docs/IMPLEMENTATION-PLAN.md:224-243`).
- **`scripts/registry-state.ts`** skips `npm publish` only after proving three things: the version matches, the `gitHead` is the tagged commit, and the tarball files are equal. Any other registry error fails closed. A prerelease that holds `latest` is a hard failure (`scripts/registry-state.ts:345-349`).
- **`scripts/release-guard.ts`** checks five version fields, the changelog cut, `private`, and the length of the server.json description. I verified it rejects the current tree.
- **The tarball is clean and deterministic.** `npm pack --dry-run` lists 116 files (409.4 kB packed, 1.32 MB unpacked) and matches `pack-manifest.json` exactly. No maps, tests, sources or harness files are included.
- **The `bin/tiktok-mcp-ai.cjs` shim** is a CommonJS pre-check that gives Node < 22 users a readable "requires Node.js >= 22" and exits 1. It is proven by the `launcher-node12` CI job (`.github/workflows/ci.yml:106-114`).
- **Dependabot is grouped**, with TypeScript and `@types/node` majors held back. CodeQL runs `security-and-quality` on push, PR and a weekly schedule.

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| REL-01 | Critical | The repo cannot release in its current state. `release-guard --tag v1.0.0` exits 1 with "CHANGELOG.md [Unreleased] still lists 14 entries above [1.0.0]". Any other tag fails with 7 problems: 5 version fields, the 14 entries, and the topmost-entry mismatch. | `CHANGELOG.md:13-118` (Unreleased: Added at 15, Security at 106), `CHANGELOG.md:119`; `scripts/release-guard.ts` (`checkChangelog`). Verified by running the built guard in a scratch copy. | Decide the first version (REL-02), fold `[Unreleased]` into it, re-date it, and fix the compare links (`CHANGELOG.md:1003-1006`). |
| REL-02 | High | The "1.0.0" label is wrong for the first publish. It was cut on 10-23 and never shipped. `[1.0.0]` claims "the first version published to npm", which is false. About 1.1–1.3 features have landed since. The Road-to-1.0 criterion "published to npm with provenance" cannot be met by a manual bootstrap publish. No real-API probe has run, yet 1.0 starts the semver and deprecation contract. WP-3.4 itself plans "npm `0.x` release". | `package.json` version; `CHANGELOG.md:119`; `docs/IMPLEMENTATION-PLAN.md:80`, `:170-203`, `:254-257`; `docs/probes/PROBE-LOG.md` (all "not run"); `docs/TOOLS.md:31` ("added in 2.0", "added in 1.1"). | Bootstrap as **0.9.0** (stable, not a prerelease). It is published manually without provenance and rolls up 0.7, 0.8, 1.0 and Unreleased. Run P-1..P-14 against the published package, then cut **1.0.0 from CI with provenance**. Owner decision (Q1). |
| REL-03 | High | Main CI is red on `7ebe6c6` ("docs(roadmap): mark A11 done") because of a **flaky test**, not a regression. Only the build ubuntu/22 leg failed. The failing test is 2183, "cc-g7: the deepest hint chain fills all three slots and ships every one of them", which returned `plan_not_found` in 16.5 ms. It passed at `301b9bb` with no test change in between. | Run 40863479987; `test/tool-publish-write.test.ts:2645`; `runVirtual` at `test/tool-publish-write.test.ts:486-504`; plan TTL (`planTtlS` = 600 s on `ctx.api.clock`) at `src/tools/publish-common.ts:787`, `:802`. | Make virtual time advance only to the next pending timer, or pin `TT_PLAN_TTL_S` high in these tests. Apply the same fix to every `runVirtual` copy (REL-R2). |
| REL-04 | High | The `VSCE_PAT` repo secret is **absent**. On the first release, `publish-vscode.yml` will fail at `vsce publish` after npm and the MCP Registry have succeeded, leaving a release with one channel red. | `gh secret list` shows `NPM_TOKEN` only (plus Pages env); `.github/workflows/publish-vscode.yml:112-114`. | Before tagging, create Marketplace publisher `ivanbbaev` and an Azure DevOps PAT (Marketplace: Manage), then `gh secret set VSCE_PAT`. Or explicitly defer the extension (Q3). |
| REL-05 | High | A dormant long-lived `NPM_TOKEN` repo secret (created 2026-08-25) exists although no workflow references it. This contradicts `publish.yml:11` ("there is no NPM_TOKEN anywhere"). A future workflow or an injected step could use it, and it bypasses the provenance and OIDC-only posture. Its scope and expiry could not be verified because secret values are not readable. | `gh api repos/IvanBBaev/tiktok-mcp/actions/secrets`; `grep -r NPM_TOKEN .github` → comment only. | Revoke the token on npmjs.com and run `gh secret delete NPM_TOKEN` after the bootstrap. Set package publishing access to "Require 2FA and disallow tokens" (REL-R3). |
| REL-06 | Medium | The bootstrap step list omits the npm hardening that round 2 required. R2-F1 / amendment 9 asked for the "disallow tokens / require OIDC" toggle and for explicitly selecting the *Publish* action on post-2026-05-20 trusted-publisher configs. Neither appears in G-14 step 3 or in `CONTRIBUTING.md` § Releasing. **Round-2 finding still open.** | `docs/IMPLEMENTATION-PLAN.md:259-262`; `docs/reviews/round2/devops-deep-review.md:689-694`, `:739-741`. | Add both to the runbook (REL-R3). |
| REL-07 | Medium | GitHub Pages is not enabled (Pages API returns 404, `has_pages=false`). `pages.yml` therefore fails on every `site/**` push: the "Deploy Pages" runs for `7ebe6c6` and `effde25` are red, which adds noise to main. The privacy and terms URLs needed for the TikTok audit return 404 (G-4). | `gh api repos/IvanBBaev/tiktok-mcp/pages` → 404; `.github/workflows/pages.yml:5-25`. | Enable Pages with build type "workflow", dispatch `pages.yml` and curl both URLs (runbook step A). |
| REL-08 | Medium | Dependabot PRs #36 (typescript-eslint 8.71.2→8.72.0) and #38 (codeql-action v4.39.0→v4.39.1) are red only on `npm audit --omit=dev --audit-level=high`. Their base `e29c1eb` predates the H2 audit fix `4afcc78`. #37 (MCP SDK 1.32.1→1.32.2) was rebased on 10-29 and is green. | PR runs 40392798808 and 40393110181; `.github/workflows/ci.yml:60-61`. | Merge #37 now. Comment `@dependabot rebase` on #36 and #38, and merge both when green. Add `cooldown` to dependabot (REL-R5). |
| REL-09 | Medium | Every push runs the full 10-job matrix with no `paths-ignore`, no `concurrency`/`cancel-in-progress`, and no `timeout-minutes` in any workflow. Docs-only "mark X done" commits (a large share of history) pay the full cost and multiply flake exposure, which is exactly how REL-03 turned main red. | `.github/workflows/ci.yml:3-5` (no paths filter); `grep timeout-minutes .github/workflows` → empty. | Add `concurrency: ci-${{ github.ref }}` with cancel for PRs, `timeout-minutes` (CI 20, publish 30), and `paths-ignore` for `docs/**` and `*.md` **except** files the doc-sync gates check. Otherwise use a docs-only light job (REL-R4). |
| REL-10 | Medium | The suite runs **three times** on ubuntu/22. `npm run check` already includes `test` plus `coverage:run`, and then `npm run coverage` repeats build and tests for the Codecov upload. Round 2 placed the single coverage run on ubuntu/24. | `package.json` `check` script; `.github/workflows/ci.yml:46-57`; `docs/reviews/round2/devops-deep-review.md:258`. | Upload the lcov already produced by `coverage:run` in `check` and drop the separate `npm run coverage` step (REL-R4). |
| REL-11 | Medium | The Node matrix is stale against the calendar. Node 26 becomes LTS in October 2026 and is what the owner runs locally (v26.12.1), yet its CI leg is advisory and `check-latest`. The comment says it "may not exist yet". Round-2 unknown 7 ("promote to blocking at 26 LTS") is due and still open. `.nvmrc` is 24. | `.github/workflows/ci.yml:22-31`, `:18`, `:42`; `.nvmrc`; `docs/reviews/round2/devops-deep-review.md:770-772`. | Make ubuntu/26 blocking with `check-latest: false`, refresh the comment, and keep 22 as the floor leg (REL-R4). |
| REL-12 | Medium | The laptop bootstrap packs with npm 11.20.0 while CI packs with npm 12.1.0. The registry-state equality check compares the laptop tarball against the runner's `npm pack`. If npm 12 writes any file differently, especially the normalized `package.json`, the skip fails and the run stops at the fallback path. **Unverified**: I did not diff an 11.20 pack against a 12.1 pack. | `.github/workflows/publish.yml:54`; local `npm -v` = 11.20.0; `scripts/registry-state.ts:269-276`, `:340-343`. | Publish the bootstrap with the CI npm: `npx -y npm@12.1.0 publish --access public` (runbook step B). |
| REL-13 | Low | `CONTRIBUTING.md` § Releasing asks for hand edits of `server.json` (two fields) and `.claude-plugin/plugin.json`. The guard catches any drift but nothing writes these fields, so every release needs four manual edits plus `sync:write`. | `CONTRIBUTING.md:169-205`; `scripts/serverjson-sync.ts:178-228` (check only). | Add `npm run version:set -- X.Y.Z` to write all five fields and the site `softwareVersion` (REL-R6). |
| REL-14 | Low | The tarball ships 56 `.d.ts` files (342,556 bytes, about 26% of unpacked size), but `package.json` has no `types` or `exports`. `main` points at `build/src/index.js`, which has top-level `await main()`, so importing the package starts a server or CLI. | `package.json` (`main`, no `types`); `src/index.ts` top level; `npm pack --dry-run`. | Either drop declarations from the build (`declaration: false` or `!build/**/*.d.ts`) and remove `main`, or set `exports` to the bin-only surface. Regenerate `pack-manifest.json` (REL-R6). |
| REL-15 | Low | `docs/TOOLS.md` labels tools "added in 2.0" and "added in 1.1" for a product that has never shipped 1.0. Users and registry readers will be confused, and the labels will be wrong under REL-02. | `docs/TOOLS.md:31`. | Re-label against the version actually chosen (REL-R1). |
| REL-16 | Low | `main` has no branch protection (404 "Branch not protected"). Round-2 amendment 8 asked for the blocking set to be required. For a solo maintainer the main risk is pushing a tag on red CI, and the tag run re-runs `check`, which limits the damage. **Round-2 item still open.** | `gh api repos/IvanBBaev/tiktok-mcp/branches/main/protection` → 404; `docs/reviews/round2/devops-deep-review.md:736-737`. | Optional: protect `main` with the required checks, and add a tag ruleset restricting `v*` creation to the owner (Q4). |
| REL-17 | Low | `publish.yml` has no `environment:`. A protected `npm` environment, bound into the trusted-publisher config, would add a manual approval gate and limit OIDC publishing to that environment. Adding it later means changing the npm config at the same time, or every publish fails. | `.github/workflows/publish.yml:36`; `docs/IMPLEMENTATION-PLAN.md:259-262`. | Decide before step C (Q4). If yes, add `environment: npm` and enter `npm` in the trusted-publisher form. |
| REL-18 | Low | WORKLOG noise. 81 entries and 4,023 lines, many of them "review round N" and "mark X done" bookkeeping. The 2026-10-23 entry "Release 1.0.0 prepared" is followed by v2 feature work, so the journal hides the fact that the release never happened. It is local-only, so this has no product impact. | `WORKLOG.md` (git-excluded). | Write one "release status" line per entry until the first publish, and collapse roadmap-marking sessions. |

### REL-01 — The guard refuses every tag today (Critical)

**What.** `checkChangelog` in `scripts/release-guard.ts` fails when any section above the topmost release has entries. `[Unreleased]` (`CHANGELOG.md:13`) has 14 bullet entries under `### Added` and `### Security`, above `[1.0.0] - 2026-10-23` (`:119`).

**Why it matters.** `publish.yml` runs the guard before anything else. Every possible tag push fails until the changelog is cut, so the G-14 bootstrap cannot even begin, because its step 1 runs the same guard.

**Failure scenario.** The owner follows G-14 step 1 on the current main: the guard prints "[Unreleased] still lists 14 entries". If they then hand-edit their way past it on the laptop, they publish a tarball whose `gitHead` is not on `main`. The later tag run's registry-state check rejects it ("published from another commit"), and an npm version has been burned that can never be re-published.

**Fix.** Do it on main through a normal commit. Rename `[1.0.0]` to the chosen version (REL-02) and date it on the publish day. Move the 14 Unreleased entries into it. Replace "the first version published to npm" with an accurate sentence. Update the compare links. Bump the five version fields and run `npm run sync:write`. Get CI green. Only then start the runbook.

### REL-02 — The first public version should be 0.9.0, not 1.0.0 (High)

**What.** The `1.0.0` in `package.json` reflects a cut made on 10-23 that never shipped. Since then about 1.1–1.3 of feature work has gone into Unreleased: DNS pin, elicitation consent, batch publish, scheduling and run-queue, webhooks, analytics, and the embed tool.

**Why it matters.** 1.0 is a public contract. `docs/IMPLEMENTATION-PLAN.md` lists "published to npm with provenance" as a 1.0 criterion, but npm/cli#8544 is still open, so the first version *must* be published manually and therefore without provenance. Every probe in `docs/probes/PROBE-LOG.md` is "not run", so the first real API contact could force breaking changes to tool contracts days after a 1.0. The project's own WP-3.4 (`docs/IMPLEMENTATION-PLAN.md:80`) planned an npm 0.x release.

**The three options:**
- **(a) 1.0.0 including all Unreleased work.** Mechanically fine, because the version was never published. It permanently ships 1.0 without provenance and before real-API validation.
- **(b) 0.x.** Recommended as **0.9.0**: stable, gets `latest`, and the semver signal is honest.
- **(c) A prerelease such as 1.0.0-rc.1.** A trap. I believe, without having verified it, that the registry assigns `latest` to a package's very first version even under `--tag next`. If so, `registry-state.ts:345-349` fails the tag run, and its remedy (`npm dist-tag add …@<stable> latest`) needs a stable version that does not exist. The Marketplace also rejects prereleases.

**Fix.** Choose 0.9.0 (Q1). Run the probes against the published 0.9.0. Then cut 1.0.0 as the first CI-published, provenance-attested release, which satisfies the 1.0 criterion literally.

**Alternative that keeps 1.0.0 with provenance.** Do a one-shot CI bootstrap with a short-lived granular token (`NODE_AUTH_TOKEN` plus `--provenance` from `publish.yml` via a temporary workflow), then revoke the token and switch to trusted publishing. It is more moving parts, and the owner must accept a token existing for a few minutes.

### REL-03 — A flaky virtual-clock test turns main red (High)

**What.** `runVirtual` (`test/tool-publish-write.test.ts:486-504`) advances the `MockClock` by 500 ms on every event-loop turn until a 20 s wall-clock budget runs out, regardless of whether the code under test is waiting on a timer. The plan store measures its 600 s TTL on that same clock (`src/tools/publish-common.ts:787`, `:802`).

**Why it matters.** About 1,200 loop turns of unrelated async I/O before the plan is consumed (env-file re-read, journal `mkdir` failure path) expire the plan. That happens on a slow or loaded runner. This is the most likely cause of the `plan_not_found` in run 40863479987. It is a high-confidence inference that I did not reproduce, and it fits the 16.5 ms failure, the single failing leg, and the pass at `301b9bb` with an unchanged test. The same helper pattern exists in `tool-publish-photos` and other tests.

**Failure scenario.** The release commit's CI goes red at random, or the tag run's `npm run check` (`publish.yml:60`) flakes *after* the guard. The release run then fails with nothing to fix, and the operator learns to distrust the gate.

**Fix.** Pick one:
- Make `runVirtual` advance the clock only to the next scheduled timer (`clock.next()` style), and only when no microtasks are pending.
- Set `TT_PLAN_TTL_S` to a very large value in the affected tests.
- Consume the plan before entering virtual time.

Then add a deterministic regression test: inject 2,000 idle `setImmediate` turns before apply and assert the plan survives.

### REL-04 — `VSCE_PAT` is missing (High)

**What.** `publish-vscode.yml:112-114` publishes with `-p "$VSCE_PAT"`, but the secret does not exist in the repository.

**Why it matters.** It is the last link of the first release. The workflow skips a duplicate version but cannot authenticate at all.

**Failure scenario.** The tag run succeeds, the MCP Registry follower succeeds, the VS Code follower fails red, and the release ends with one channel missing. A manual `gh workflow run publish-vscode.yml --ref vX.Y.Z` is needed after the secret is created. That is recoverable, but it is avoidable noise on launch day.

**Fix.** Create the publisher at <https://marketplace.visualstudio.com/manage> (ID `ivanbbaev`, matching `extension/package.json:6`). Create an Azure DevOps PAT with Organization "All accessible organizations" and scope Marketplace → Manage, and pick a short expiry. Then run `gh secret set VSCE_PAT -R IvanBBaev/tiktok-mcp`. Alternatively, defer the extension for the first release (Q3) and accept the red follower, or gate it on the presence of the secret.

### REL-05 — A dormant `NPM_TOKEN` secret (High)

**What.** A repository secret `NPM_TOKEN` (created 2026-08-25) exists although the design and `publish.yml:11` say there is none.

**Why it matters.** It is a long-lived credential that can publish without provenance and without the guard. A compromised dependency in any workflow step that runs `npm ci` lifecycle scripts cannot read secrets that the job does not reference. Still, any future or edited workflow, or a malicious PR merged by mistake, can reference it. It also undercuts "disallow tokens" as a policy.

**Failure scenario.** Someone (or an AI session) "fixes" the G-14 E404 by adding `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. Releases then silently stop going through OIDC.

**Fix.** Use it once for the REL-02 alternative if the owner chooses that. Otherwise revoke it on npmjs.com (Access Tokens) and run `gh secret delete NPM_TOKEN -R IvanBBaev/tiktok-mcp`. Then set package Settings → Publishing access → "Require two-factor authentication and disallow tokens". As far as I know, trusted publishing keeps working with that setting, but this is unverified against current npm behaviour; confirm on the first tag run.

## Verified copy-paste release runbook (for the 0.9.0 decision)

The runbook assumes `V=0.9.0`; substitute if Q1 is answered differently. Steps marked *(unverified)* rely on documented behaviour that I could not exercise read-only.

**Step 0: on `main`, through normal commits (prerequisites, REL-R1/R2).**
1. Fix the flake (REL-R2). Merge #37, rebase and merge #36 and #38 (REL-08). CI must be green on main.
2. Cut the release:
   - `CHANGELOG.md`: rename `## [1.0.0] - 2026-10-23` to `## [0.9.0] - <publish date>`, fold the 14 Unreleased entries into it, correct its first paragraph, and update the compare links.
   - `npm version 0.9.0 --no-git-tag-version`, plus the same inside `extension/`.
   - Edit `server.json` (`version` and `packages[0].version`) and `.claude-plugin/plugin.json`.
   - Run `npm run build && npm run sync:write` (site `softwareVersion`).
   - Run `npm run check && node build/scripts/release-guard.js --tag v0.9.0`.
   - Commit, push, and wait for green CI.

**Step A: G-4, enable Pages** (independent; do it first because the TikTok audit needs the URLs).
```sh
export PATH=/opt/homebrew/bin:$PATH
gh api -X POST repos/IvanBBaev/tiktok-mcp/pages -f build_type=workflow   # (unverified syntax; UI alt: Settings → Pages → Source: GitHub Actions)
gh api repos/IvanBBaev/tiktok-mcp/pages --jq '.build_type,.html_url'
gh workflow run pages.yml --ref main -R IvanBBaev/tiktok-mcp
gh run watch -R IvanBBaev/tiktok-mcp "$(gh run list -R IvanBBaev/tiktok-mcp --workflow pages.yml -L1 --json databaseId --jq '.[0].databaseId')"
curl -sI https://ivanbbaev.github.io/tiktok-mcp/privacy.html | head -1   # expect HTTP/2 200
curl -sI https://ivanbbaev.github.io/tiktok-mcp/terms.html   | head -1   # expect HTTP/2 200
```

**Step B: G-14, the manual first publish from a plain clone** (it must be `.git` as a directory so `gitHead` is recorded).
```sh
export PATH=/opt/homebrew/bin:$PATH
V=0.9.0
rm -rf ~/Development/_temp/release-clone
git clone https://github.com/IvanBBaev/tiktok-mcp.git ~/Development/_temp/release-clone
cd ~/Development/_temp/release-clone
test -d .git && git log -1 --format='%H %s'          # must be the green release commit on main
npm ci && npm run build
node build/scripts/release-guard.js --tag "v$V"       # must exit 0
npm run smoke:pack
npx -y npm@12.1.0 login                               # same npm as publish.yml:54 (REL-12)
npx -y npm@12.1.0 publish --access public             # 2FA OTP prompt; NO --provenance; stable => latest
npm view "tiktok-mcp-ai@$V" version gitHead dist-tags --json   # gitHead must equal: git rev-parse HEAD
```

**Step C: npm-side configuration** (npmjs.com → `tiktok-mcp-ai` → Settings).
1. Trusted Publisher → GitHub Actions:
   - owner `IvanBBaev`, repository `tiktok-mcp`, workflow filename `publish.yml`;
   - environment empty, unless Q4 adds one;
   - **select the "Publish" action explicitly** *(round-2 R2-F1; unverified UI wording)*.
2. Publishing access → **Require two-factor authentication and disallow tokens**.
3. Delete the dormant token:
   - revoke it under npmjs.com → Access Tokens;
   - `gh secret delete NPM_TOKEN -R IvanBBaev/tiktok-mcp`.

**Step D: Marketplace secret** (or skip and accept a red follower, Q3).
```sh
# after creating publisher "ivanbbaev" and an Azure DevOps PAT (Marketplace: Manage, all orgs)
gh secret set VSCE_PAT -R IvanBBaev/tiktok-mcp      # paste the PAT at the prompt; never on the command line
gh secret list -R IvanBBaev/tiktok-mcp              # expect VSCE_PAT, and no NPM_TOKEN
```

**Step E: tag, run and verify.**
```sh
cd ~/Development/_temp/release-clone
git tag "v$V" && git push origin "v$V"
gh run watch -R IvanBBaev/tiktok-mcp "$(gh run list -R IvanBBaev/tiktok-mcp --workflow publish.yml -L1 --json databaseId --jq '.[0].databaseId')"
# expect: registry step logs "already published ... byte-identical/equal" and SKIPS npm publish; release created
gh release view "v$V" -R IvanBBaev/tiktok-mcp
gh run list -R IvanBBaev/tiktok-mcp --workflow publish-mcp.yml -L1
gh run list -R IvanBBaev/tiktok-mcp --workflow publish-vscode.yml -L1
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.IvanBBaev%2Ftiktok-mcp-ai/versions/$V"   # expect 200 (unverified encoding)
npx -y tiktok-mcp-ai@"$V" --version                  # smoke from the registry
cd ~ && rm -rf ~/Development/_temp/release-clone
```

**Fallback.** If the registry step fails (tarball mismatch, or the version was published from another commit), follow `docs/IMPLEMENTATION-PLAN.md` § Fallback: `release-guard --notes`, `gh release create --verify-tag`, then `gh workflow run` for both followers. **Never** delete and re-push a tag over a version npm already holds unless registry-state has verified it.

**After 0.9.0:** run probes P-1..P-14 against `npx tiktok-mcp-ai@0.9.0`, fix what breaks, cut 1.0.0 on main, and push the tag. That is the first provenance-attested publish; check it with `npm view tiktok-mcp-ai@1.0.0 dist.attestations`.

## Open questions for the owner

1. **First version:** 0.9.0 (recommended), 1.0.0 including Unreleased without provenance, or 1.0.0 through a one-shot token CI bootstrap with provenance?
2. **NPM_TOKEN:** do you know what it is (scope, expiry, which account)? If it is not used for Q1's token route, may it be revoked now?
3. **VS Code extension at first release:** ship it (requires creating the publisher and `VSCE_PAT`), or defer until 1.0?
4. **Hardening:** a protected `npm` environment with approval on `publish.yml` (it must be decided before the trusted-publisher form), branch protection on `main`, and a `v*` tag ruleset. Yes or no?
5. **CI budget:** is a `paths-ignore` or light job for docs-only commits acceptable, given that the doc-sync gates must still run when generated docs change?

## Proposed roadmap items

#### REL-R1 — Decide the first version and cut the changelog
Deps — · Status blocked: owner (Q1) · Est 1.5 h

- **Scope:** **Release-blocking.** Apply the Q1 decision.
  - Rename and re-date the `[1.0.0]` section and fold `[Unreleased]` into it.
  - Correct the "first version published to npm" text and update the compare links.
  - Bump `package.json`, `extension/package.json`, `server.json` (both fields), `.claude-plugin/plugin.json` and the site `softwareVersion` through `sync:write`.
  - Re-label the "added in 1.1/2.0" notes in `docs/TOOLS.md`.
  - Align the `docs/IMPLEMENTATION-PLAN.md` Road-to-1.0 text: provenance arrives with the first CI publish.
- **Owns:** `CHANGELOG.md`, `server.json`, `.claude-plugin/plugin.json`, `extension/package.json`, `extension/package-lock.json`.
- **Shared:** `package.json`, `package-lock.json`, `site/index.html`, `docs/TOOLS.md`, `docs/IMPLEMENTATION-PLAN.md`.
- **Acceptance:**
  - `node build/scripts/release-guard.js --tag vX.Y.Z` exits 0.
  - `npm run check` is green.
  - `grep -n "added in 2.0\|added in 1.1" docs/TOOLS.md` is empty, or matches the shipped versions.
  - CI on main is green for the commit.

#### REL-R2 — Make `runVirtual` time advance deterministic
Deps — · Status todo · Est 2 h

- **Scope:** **Release-blocking.** Replace the blind 500 ms-per-turn clock advance with next-timer advancement, or pin a large plan TTL, in every test helper that uses the pattern. Add a regression test that injects extra idle event-loop turns before apply and asserts that the plan survives.
- **Owns:** the `runVirtual` helpers in `test/tool-publish-write.test.ts`, `test/tool-publish-photos.test.ts` and any other copies.
- **Shared:** `test/helpers/*` (if the helper is extracted).
- **Acceptance:**
  - The cc-g7 test passes 200 consecutive runs under `--test-concurrency` equal to the CPU count with CPU stress.
  - The new regression test fails against the old helper and passes against the new one.
  - Coverage floors are unchanged.

#### REL-R3 — Execute the owner bootstrap: Pages, npm, secrets
Deps REL-R1, REL-R2 · Status blocked: owner (npm 2FA, Pages, Marketplace account) · Est 1 h

- **Scope:** **Release-blocking.** Run the runbook steps A–E from this report:
  - enable Pages;
  - publish manually with npm 12.1.0;
  - configure the trusted publisher with the Publish action;
  - require 2FA and disallow tokens;
  - revoke and delete `NPM_TOKEN`;
  - create `VSCE_PAT`, or record the deferral;
  - push the tag.

  Copy the runbook into `CONTRIBUTING.md` § Releasing and replace G-14 step 3 with the hardened version.
- **Owns:** `CONTRIBUTING.md` (§ Releasing).
- **Shared:** `docs/IMPLEMENTATION-PLAN.md` (G-4/G-14 rows and the bootstrap section).
- **Acceptance:**
  - `curl -sI …/privacy.html` and `…/terms.html` both return 200.
  - `npm view tiktok-mcp-ai@X.Y.Z gitHead` equals the tagged SHA.
  - The publish run is green with the "already published" skip.
  - `gh release view vX.Y.Z` succeeds.
  - The MCP Registry version lookup returns 200.
  - The Marketplace shows `ivanbbaev.tiktok-mcp-ai`, or the deferral is recorded.
  - `gh secret list` shows no `NPM_TOKEN`.

#### REL-R4 — Cut CI cost and flake exposure
Deps — · Status todo · Est 2.5 h

- **Scope:**
  - Add `concurrency` (cancel-in-progress for PRs and non-main refs).
  - Add `timeout-minutes` to every job.
  - Remove the duplicate `npm run coverage` step and upload the lcov from `check`'s `coverage:run`.
  - Promote ubuntu/26 to blocking and refresh its comment.
  - Skip the heavy matrix for docs-only commits, using `paths-ignore`, or a light job that still runs `npm run sync` and doc gates when generated docs change.
- **Owns:** `.github/workflows/ci.yml`.
- **Shared:** `.github/workflows/pages.yml`, `.github/workflows/codeql.yml` (timeouts only); `docs/TESTING.md` (CI section).
- **Acceptance:**
  - `grep -c timeout-minutes .github/workflows/*.yml` is at least 1 per job.
  - The ubuntu/22 leg runs the test suite exactly twice (`test` and `coverage:run`), shown by the log.
  - A docs-only PR finishes in under 3 minutes.
  - The Node 26 leg is required and green.
  - The Codecov upload still reports.

#### REL-R5 — Clear dependabot PRs and add a cooldown
Deps — · Status todo · Est 0.5 h

- **Scope:** Merge #37. Rebase and merge #36 and #38 once green. Add `cooldown` (for example, 3 days minor and patch, 7 days major) to every ecosystem in `.github/dependabot.yml` to reduce supply-chain day-0 risk.
- **Owns:** `.github/dependabot.yml`.
- **Shared:** `package-lock.json`, `.github/workflows/codeql.yml` (via the PRs).
- **Acceptance:**
  - `gh pr list --author app/dependabot` is empty.
  - Main CI is green.
  - `dependabot.yml` validates (no config error in the Dependabot UI).

#### REL-R6 — Add a version-set script and tidy the tarball surface
Deps REL-R1 · Status todo · Est 2 h

- **Scope:**
  - Add `scripts/version-set.ts` (`npm run version:set -- X.Y.Z`) to write all five version fields and run `sync:write`, then update `CONTRIBUTING.md` step 2 to use it.
  - Stop shipping unused `.d.ts` files (or add `exports` and `types` deliberately), and drop or neutralize `main` so `import 'tiktok-mcp-ai'` does not start a server.
  - Regenerate `pack-manifest.json`.
- **Owns:** `scripts/version-set.ts`, `pack-manifest.json`.
- **Shared:** `package.json`, `tsconfig*.json`, `CONTRIBUTING.md`.
- **Acceptance:**
  - `npm run version:set -- 9.9.9 && node build/scripts/release-guard.js --tag v9.9.9` reports only the changelog problem.
  - `npm pack --dry-run` lists no `.d.ts`, or `types` resolves.
  - The tarball shrinks by roughly 340 kB unpacked.
  - `smoke:pack` is green.

#### REL-R7 — Harden the publish path with environment and rulesets
Deps REL-R3 · Status blocked: owner (Q4) · Est 1 h

- **Scope:**
  - Optionally add `environment: npm` (required reviewer: the owner) to `publish.yml`, entered in the trusted-publisher config at the same time.
  - Protect `main` with the blocking CI set.
  - Add a tag ruleset so only the owner can create `v*`.
- **Owns:** —
- **Shared:** `.github/workflows/publish.yml`, `docs/IMPLEMENTATION-PLAN.md` (bootstrap step 3).
- **Acceptance:**
  - `gh api repos/IvanBBaev/tiktok-mcp/branches/main/protection` returns 200.
  - The next tag run pauses for approval (if chosen) and then publishes with provenance.
  - `npm view … dist.attestations` is present.

**Top recommendation:** fix the flaky test, then cut the changelog and bump to **0.9.0**, and run the verified runbook (Pages → manual npm 12.1.0 publish → trusted publisher with tokens disallowed → delete `NPM_TOKEN` and add `VSCE_PAT` → tag), so that 1.0.0 becomes the first CI-attested release after the real-API probes.
