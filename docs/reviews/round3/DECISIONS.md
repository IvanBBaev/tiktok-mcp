# Round 3 — Owner decisions

Date: 2026-10-30. This file settles the owner decisions Q1–Q7 from
[`SYNTHESIS.md`](SYNTHESIS.md) § 5, and the "Open questions for the owner" in
each role report. Every decision lists the reasoning behind it and what it changes
in [`docs/ROADMAP.md`](../../ROADMAP.md).

One principle runs through all of them. **Nothing has been published yet, so
tightening a default today costs no user anything.** After the first publish,
loosening a default is a compatible change and tightening one is breaking. When
the evidence is balanced, the stricter option wins now.

Some steps need the owner's own accounts or a human at the keyboard. They are
listed in § 4 as checklists.

## 1. Synthesis decisions Q1–Q7

### Q1 — First version: **0.9.0**

- **Why:**
  - The 1.0 criteria in the plan require CI provenance. The first npm publish has
    to be manual, because trusted publishing cannot authenticate a package the
    registry has never seen (G-14). A manual publish carries no provenance.
  - None of the probes P-1..P-14 has run against the real API yet.
  - A 1.0.0 that later needs a breaking fix from QA-R1 findings would spend the
    compatibility promise on day one.
- **Consequence:**
  - `REL-R1` becomes `todo` and applies the recommended path: fold `[1.0.0]` and
    `[Unreleased]` into `[0.9.0]`, and mark 0.7.0, 0.8.0 and 1.0.0 as internal
    milestones that were never published.
  - 1.0.0 is the first release published from CI with provenance, after QA-R1
    and QA-R2.

### Q2 — Public posting: **not a product goal**

- **Why:**
  - TikTok's audit rejects "apps for private or personal use".
  - A bring-your-own-app user therefore stays unaudited:
    - `SELF_ONLY` posts only;
    - a private account;
    - at most 5 posting users in 24 hours (10 sandbox target users).
  - Public posting needs an audited app held by an operator who posts on behalf
    of others. That is a hosted, multi-tenant service. It is already an explicit
    non-goal, and it would make the author a data controller.
- **Decision:** document the project as a **local-first tool** for three things:
  - reading your own account and analytics;
  - inbox drafts, which the user finishes and publishes in the TikTok app;
  - private test posts.
- **Consequence:**
  - `PRD-R5` writes the README in this framing.
  - The plan/apply write path stays. It is the correct design for an operator
    who does hold an audited app, but the docs do not promise public posting.
  - "Hosted public-posting service" moves into the explicit non-goals.

### Q3 — Consent default: **`TT_ELICITATION=required`**

- **Why:**
  - SEC and DX each recommended failing closed when a write package is enabled.
  - Today, under `auto`, a client without form elicitation applies a plan with
    `plan_id` as the only checkpoint. A model that a prompt injection has steered
    can produce that `plan_id` itself.
  - The setting only has effect once the operator has enabled a write package,
    because `core` is read-only. So a stricter default touches only people who
    have already chosen to write.
  - The rest of the project already fails closed: `TT_MEDIA_ROOT` unset rejects
    files, and `TT_WRITE_MODE` defaults to `plan`. `auto` was the exception.
  - Before the first publish the change breaks nobody. Moving to `required`
    later would be breaking.
- **Decision:**
  - The default becomes `required`.
  - The `consent_unavailable` error names the opt-out, `TT_ELICITATION=auto`,
    and says what the operator gives up by choosing it.
  - Batch items and `run-queue` replays stay exempt, because their consent was
    given when the batch or schedule was approved. `LGL-R4` tightens that path.
- **Consequence:**
  - `DX-R3` becomes `todo` and ships three things:
    - the `required` default;
    - the visible `consent_dialog` state;
    - the client matrix.
  - `LGL-R4` becomes `todo`.

### Q4 — Scope freeze: **yes**

- **Why:** the product score is 3/10 because nothing has reached a user, not
  because features are missing. Adding tools before the first publish widens the
  untested surface that QA-R1 has to cover.
- **Decision:**
  - No new tools, tool packages or `TT_*` settings until either:
    - 90 days after the first npm publish; or
    - 3 independent issues ask for the same feature.
  - Fixes, hardening and removals stay allowed.
  - B1 (Commercial Content API) moves to non-goals.
  - B2-SPIKE, B2, B3 and PLT-R9 are frozen until the 90-day review `PRD-R8`.
- **Consequence:** `PRD-R1` is carried out in this commit and is `done`.

### Q5 — Experimental features: **label only**

- **Why:** a `TT_EXPERIMENTAL` switch would be a new `TT_*` setting, which the
  Q4 freeze forbids. It would also add a second gate in front of features that
  are already opt-in through `TT_TOOL_PACKAGES`.
- **Consequence:** `PRD-R6` marks the features Experimental in three places:
  - TOOLS.md;
  - the tool descriptions;
  - the CHANGELOG.

  It adds no setting.

### Q6 — Secrets and distribution

- **Revoke the dormant `NPM_TOKEN`: yes.**
  - No workflow references it (`publish.yml:11`).
  - It is the repository's only long-lived publish credential, so any future
    workflow change could exfiltrate it.
  - The first publish is made from the owner's machine after `npm login`, so
    the token is not needed for that either.
  - Steps: § 4.4.
- **VS Code extension: deferred to after the first release.**
  - There is no `VSCE_PAT` and no Marketplace publisher yet.
  - The extension only runs `npx -y tiktok-mcp-ai`, so it adds no reach until
    npm has the package.
  - New item `REL-R8`: `publish-vscode.yml` skips the Marketplace step with a
    notice when `VSCE_PAT` is absent, instead of failing the release run.
  - The owner creates the publisher whenever they choose (§ 4.5). The
    workflow's `workflow_dispatch` path then publishes the existing tag.
- **Environment, branch protection and tag ruleset: yes**, after the first
  publish (`REL-R7`, now `todo`).
  - The rules must stay compatible with the owner's direct-push, fast-forward
    workflow. On `main`:
    - block force-pushes and deletion;
    - no required pull requests.
  - The `v*` tag ruleset allows only the owner to create tags, and nobody to
    update or delete them.
  - A protected `npm` environment, limited to `v*` tags, is named in the npm
    trusted-publisher configuration.

### Q7 — Live session: **the owner runs it, on a private account**

- **Why:**
  - An unaudited app can post only `SELF_ONLY`, and only to a private account.
    On a public account a direct post fails, and only the draft path can be
    exercised.
  - Using a private account (or making the test account private for the
    session) lets one session cover both drafts and direct posts.
- **Consequence:**
  - `QA-R1` stays `blocked: owner`, because it needs a human at the keyboard.
  - The checklist is in § 4.1, and it has a step that tests a draft on a public
    account.
  - Probes:
    - P-10 (do drafts count toward the unaudited cap?) is required in the
      session, because the README wording depends on it.
    - P-8 and P-9 are tuning probes and may be deferred.

## 2. Answers to the role reports' open questions

### Architecture (`architecture.md`)

1. **ARC-R7 as a hard prerequisite of B2:** yes. B1 and B2 already depend on it.
   It is frozen with the B-track.
2. **CONTRACTS.md:**
   - Shrink it to the invariants, plus signatures generated from the exported
     types.
   - A gate fails when the two drift.
   - `ARC-R3` uses this option instead of a hand-written, hand-gated document.
3. **Feature freeze:** yes (Q4).
4. **`src/write/`:**
   - It lands after 0.9.0 and before 1.0.0 (`ARC-R8`).
   - Moving modules during the release-blocking work would conflict with SEC-R1,
     PLT-R2 and ARC-R4.
5. **`wait_for_completion=false`:** confirmed as the default. `ARC-R2` records
   the reversal.

### Security (`security.md`)

1. **The state directory:**
   - It is **outside** the threat model for 0.9.0.
   - SECURITY.md says plainly that write access to the env directory equals
     publish rights.
   - `SEC-R4` takes the "document" branch: no HMAC.
   - We revisit this if an agent with filesystem tools is ever declared in
     scope.
2. **`TT_ELICITATION` default:** `required` (Q3).
3. **Multi-app (several client keys):** supported, because each profile can
   carry its own app credentials.
   - The webhook receiver's first-profile identity is therefore a functional
     bug, not only hardening.
   - `SEC-R5` already verifies against every profile's app, and it is the fix.
4. **`TT_HTTP_INSECURE`:** kept.
   - CONFIGURATION.md already documents the reverse-proxy deployment that needs
     it.
   - Removing it would also break the freeze's spirit for no user gain.
   - `SEC-R7` keeps the hardening.
5. **DNS pin disabled under an environment proxy:** yes, `doctor` warns once.
   This is part of `SEC-R7`.

### QA (`qa.md`)

1. **Ship without the probes:** no. `QA-R1` stays release-blocking.
2. **Windows credential-file ACLs:**
   - Windows is best-effort for 0.9.0.
   - The docs say the credential file relies on the user-profile ACL.
   - No ACL code is written before 1.0.0.
3. **Codecov:**
   - Keep it, but switch the upload to tokenless OIDC (`use_oidc: true`). That
     needs no new secret.
   - Fail the job on upload errors on `main`.
   - Part of `QA-R4`.
4. **Sandbox logistics:** see Q7.
   - P-8 and P-9 may be deferred.
   - P-10 is required.
5. **Mutation score:** a one-off measurement (`QA-R6`), not a gate. A gate is
   reconsidered at the 90-day review.

### TikTok platform (`tiktok-platform.md`)

1. **Audit model:** bring-your-own-app, unaudited (Q2).
2. **App-name suggestions without "tiktok":** yes. TikTok's developer guidelines
   reject app names that contain its marks. `PLT-R3` fixes SETUP-TIKTOK-APP.md.
3. **Silent change to `disable_*=true` before the first publish:** acceptable.
   - No user exists yet.
   - `PLT-R1` records the change in the CHANGELOG, so it is not silent in the
     release notes.
4. **The embed tool:**
   - Keep it, labelled Experimental (`PRD-R6`).
   - `PLT-R7` adds the Embed Player option and marks oEmbed as deprecated
     upstream.
   - The tool can be removed at the 90-day review if nobody uses it.
5. **B1:** out of scope. Moved to non-goals (Q4).
6. **Applying for the Business API under the owner's own name:**
   - Not now.
   - `PLT-R9` and `B2-SPIKE` are frozen until `PRD-R8` decides B2 on evidence.

### MCP and AI developer experience (`mcp-ai-dx.md`)

1. **Consent default:** `required` (Q3).
2. **`core` stays read-only:** yes.
   - The plugin ships one entry.
   - The docs show the one `TT_TOOL_PACKAGES` line that enables writing.
   - A second "writer" entry would be a second launch path to keep true for
     little gain. `DX-R1` covers the env passthrough.
3. **The tools/list budget gate:**
   - Accepted: at most 35 KB with all packages enabled, and at most 4 KB per
     tool (`DX-R5`).
   - The policy prose moves into the server `instructions`. SEC-R2 adds those
     instructions.
4. **Per-tool `data` schemas:**
   - Commit to them only after QA-R1 has recorded the real response shapes.
   - `DX-R4` now depends on `QA-R1`.
   - The generic `outputSchema` stays until then.
5. **Live clients to smoke-test:** Claude Code, Claude Desktop, VS Code (Copilot
   agent mode) and Cursor (`DX-R10`).
6. **Drafts as `destructiveHint`:** keep it.
   - A draft spends one of the 5 unaudited posting inits per 24 hours.
   - It also lands in the user's TikTok inbox.
   - The conservative hint is accurate.

### Legal and compliance (`legal-compliance.md`)

1. **Audit submission:** none for 0.9.0 (Q2). `site/terms.html` keeps
   "single-user" and "not a multi-tenant hosted deployment", which is accurate.
2. **`TT_WRITE_MODE=apply` for public posts:**
   - It stays available.
   - It is documented as "trusted automation only".
   - An unaudited app can only post `SELF_ONLY` anyway, and an audited operator
     needs the mode.
   - `LGL-R4` makes the apply path state that the operator's audit is a
     precondition for public visibility.
3. **Scheduled posts:**
   - No fresh consent at run time, because the consent is given when the
     schedule is approved.
   - The horizon shrinks from 30 days to a fixed 7 days.
   - This is a constant, not a new setting.
   - `LGL-R4` carries it out. It can land after 0.9.0 because scheduling is
     labelled Experimental (`PRD-R6`) and sits outside the compatibility policy.
4. **Visual identity before Pages goes live:**
   - Rebrand. `LGL-R5` replaces the cyan and red palette.
   - The site's display name becomes "MCP server for TikTok (unofficial)".
   - This happens before `REL-R3` enables Pages.
   - The npm name `tiktok-mcp-ai` is a descriptive, nominative use, and it
     stays.
5. **Fallback name after a trademark complaint:** `@ivanbbaev/clipcast-mcp`.
   - It is scoped and does not contain the mark.
   - It is recorded here only; nothing is reserved yet.
6. **An operator privacy-policy and terms template:**
   - After the release.
   - It is folded into `LGL-R2`'s data-deletion work as a docs deliverable.

### Release and DevOps (`release-devops.md`)

1. **First version:** 0.9.0 (Q1).
2. **`NPM_TOKEN`:** revoke it (Q6, § 4.4).
3. **VS Code extension:** deferred (Q6, `REL-R8`).
4. **Hardening:** an npm environment, protection for `main` and a tag ruleset,
   after the first publish (`REL-R7`).
5. **A docs-only CI path:**
   - Yes, inside `QA-R4`.
   - The sync and docs-drift gates still run on docs-only pushes.

### Product (`product.md`)

1. **Version:** 0.9.0.
2. **Public-posting product:** no (Q2).
3. **The sandbox smoke run by the owner:** yes (Q7, § 4.1).
4. **Is the owner's account public?** The session uses a private account (Q7).
5. **Experimental features:** label only (Q5).
6. **B1 to non-goals:** done (Q4).

## 3. Roadmap changes made with this decision

These changes land in `docs/ROADMAP.md`.

**Unblocked and set to `todo`:**
- `REL-R1`
- `DX-R3`
- `LGL-R4`
- `REL-R7`

**`PRD-R1`:** `done`. The freeze is written into the roadmap's round-3 section.
B1 moved to the explicit non-goals.

**Frozen until `PRD-R8`:**
- `B2-SPIKE`
- `B2`
- `B3`
- `PLT-R9`

**New, release-blocking and codeable now:** `REL-R8`. The Marketplace step
skips cleanly when `VSCE_PAT` is unset.

**Dependency and scope changes:**
- `DX-R4` now depends on `QA-R1`.
- `SEC-R4`, `SEC-R5`, `SEC-R7`, `QA-R4`, `LGL-R4`, `LGL-R5` and `ARC-R3`
  record the options chosen above.

## 4. Owner checklists (only a human can do these)

### 4.1 `QA-R1` — the sandbox session (about 2–4 h)

1. Open developers.tiktok.com and create an app.
   - Pick a name without "TikTok".
   - Add the Login Kit and Content Posting API products.
   - Add the scopes `user.info.basic`, `user.info.profile`, `user.info.stats`,
     `video.list`, `video.upload` and `video.publish`.
2. Under **Sandbox**:
   - Add your own TikTok account as a target user.
   - Set that account to **private** for the session.
3. Register the redirect URI that `docs/SETUP-TIKTOK-APP.md` gives.
4. Store the client key and secret the way `docs/CLIENTS.md` describes. Never
   put them in the repo.
5. Run the session in the order `ROADMAP.md` § QA-R1 lists:
   1. `login`, then `doctor`, which must be all green.
   2. Auth status, user info, list videos and analytics.
   3. A FILE_UPLOAD draft. Check that it arrives in the TikTok inbox.
   4. A `SELF_ONLY` direct post.
   5. Poll the publish status until it completes.
   6. Re-run execute with the same `plan_id`. It must be refused.
   7. `login --revoke`.
6. Make the account public again. Try one more draft to learn whether drafts
   work on a public account.
7. Hand the raw responses and the P-1..P-14 outcomes to an agent session. It
   writes them into `docs/probes/PROBE-LOG.md` and the QA-R2 fixtures, with all
   tokens redacted.

### 4.2 npm account (before `REL-R3`)

1. Run `npm login` on this machine. Today, `npm whoami` answers ENEEDAUTH.
2. On npmjs.com, open Account → Two-Factor Authentication and enable
   "Authorization and writes".
3. Check that the name is still free: `npm view tiktok-mcp-ai` must answer E404.

### 4.3 `REL-R3` — the bootstrap, after every other release-blocking item is `done`

1. GitHub → Settings → Pages → Source = **GitHub Actions**. Then run `pages.yml`
   (it accepts `workflow_dispatch`). Check that `privacy.html` and `terms.html`
   return 200.
2. Do the manual first publish from a clean checkout of the release tag:
   `npm ci && npm run check && npm publish --access public`.
3. On npmjs.com, open the package → Settings → Trusted publishing:
   - Add GitHub Actions with the repository `IvanBBaev/tiktok-mcp`, the workflow
     `publish.yml` and the environment `npm`.
   - Set "Require two-factor authentication and disallow tokens".
4. Push the `v0.9.0` tag. Check the follower workflows: the GitHub release, the
   MCP registry, and the Marketplace step being skipped (`REL-R8`).

### 4.4 Revoking `NPM_TOKEN`

1. On npmjs.com, open Access Tokens and delete the token stored in the repo
   secret.
2. Delete the GitHub copy: `gh secret delete NPM_TOKEN -R IvanBBaev/tiktok-mcp`.

The agent did not run this step. Deleting the secret cannot be undone, so it is
left to you.

### 4.5 VS Code Marketplace (optional, after the first release)

1. Create a publisher at marketplace.visualstudio.com/manage. Its ID must match
   `publisher` in `extension/package.json`.
2. Create an Azure DevOps PAT with the scope Marketplace → Manage. Store it with
   `gh secret set VSCE_PAT -R IvanBBaev/tiktok-mcp`.
3. Run `publish-vscode.yml` with `workflow_dispatch` on the released tag.
