# Round-3 Review — Synthesis

Date: 2026-10-29. Baseline: `main` at `301b9bb` (H3 done). This round asks one
question: **can `tiktok-mcp-ai` ship its first public release, and what stands
in the way?** Eight senior reviewers read the code, docs, CI, npm registry and
GitHub state independently. They made no changes. Their reports sit next to this
file. This synthesis merges them and resolves their conflicts. Every item it
keeps is in [`docs/ROADMAP.md` § Round-3 release track](../../ROADMAP.md#round-3-release-track).

## 1. Roles and why each was chosen

The project is an MCP server that posts to a third-party social platform on a
user's behalf. It is distributed as an npm package, a Claude plugin and a VS Code
extension. Each role below covers a risk area that would stop a release on its
own.

| Prefix | Role | Why this project needs it | Report |
|---|---|---|---|
| ARC | Software architect | 28k lines of `src/` over five layers, and a B-track that changes the credential model | [architecture.md](architecture.md) |
| SEC | Application security engineer | OAuth tokens on disk, writes to a public account, a webhook receiver, DNS pinning, prompt-injection exposure through upstream text | [security.md](security.md) |
| QA | QA / test architect | 2416 tests and 99.81% coverage, but no evidence from the real API, and `main` is red | [qa.md](qa.md) |
| PLT | TikTok platform integration expert | The Content Posting API audit, UX rules and sandbox limits decide what users can do at all | [tiktok-platform.md](tiktok-platform.md) |
| DX | MCP / AI-DX engineer | The tool surface, schemas, consent elicitation and token budget are what the model and the client actually see | [mcp-ai-dx.md](mcp-ai-dx.md) |
| PRD | Product manager | Scope, positioning, competitors and what to ship first | [product.md](product.md) |
| LGL | Legal and compliance reviewer | The privacy policy and terms are a precondition for the audit. Also GDPR roles, trademark and trade dress | [legal-compliance.md](legal-compliance.md) |
| REL | Release / DevOps engineer | Zero releases so far, trusted publishing, the G-4 and G-14 owner gates, and the CI flake | [release-devops.md](release-devops.md) |

**Roles not used, and why:**
- UX/UI design: the only UI is the client's consent dialog, which DX and SEC
  covered.
- Performance: there is a single local user, and API rate limits dominate.
- Accessibility: the site is three static pages. LGL checked those for
  compliance and found no UI to audit.

## 2. Scores

| Role | Score | Critical | High | One-line verdict |
|---|---:|---:|---:|---|
| SEC | 7/10 | 0 | 1 | Strong design. The consent dialog does not show what will be posted |
| ARC | 6/10 | 0 | 3 | Clean layering. Retry class fails open, docs drifted, credential model not ready for B1/B2 |
| DX | 6/10 | 0 | 3 | Good tool design. Launch path, README demo and consent visibility are broken |
| LGL | 5/10 | 0 | 3 | The privacy policy describes a smaller system than the one that exists |
| PLT | 4/10 | 2 | 3 | Wire contract about 7/10, audit readiness about 2/10, no evidence from the real API |
| QA | 4/10 | 1 | 4 | Suite green locally (2416/2416). Nothing replays real write responses; flaky clock helper |
| REL | 4/10 | 1 | 4 | Pipeline design 8–9/10, but the guard refuses every tag and two secrets are wrong |
| PRD | 3/10 | 2 | 5 | Excellent engineering, no product yet: unshipped, unvalidated, mispositioned |
| **Mean** | **4.9/10** | **6** | **26** | |

The roles disagree because they score different things. The code and design
roles (SEC, ARC, DX) score 6–7. The roles that judge contact with reality
(PLT, QA, REL, PRD) score 3–4. The gap between those two groups is the main
finding of the round.

## 3. Cross-role themes

### T1 — Nothing has ever shipped or met the real API (6 roles)
`npm view tiktok-mcp-ai` returns E404. There are no tags and no releases. Every
live probe from P-1 to P-14 is `not run`. The contract replay covers 5 read
endpoints and no write responses. The fake chunk upload answers 201 where TikTok
answers 206.

Meanwhile, 11 features landed in the six days after "1.0.0" was prepared, and
`CHANGELOG.md:121` says 1.0.0 was published, which is false.

Evidence: QA-01, QA-02, QA-04, PLT-05, PRD-01, PRD-03, PRD-06, REL-01, REL-02.

**Resolution:** one owner-run sandbox session (`QA-R1`, merging PLT-R4 and
PRD-R2) comes before any "posting works" claim. Its fixtures then feed the
replay suite (`QA-R2`).

### T2 — The personal-use rule blocks the audit (PLT, LGL, PRD)
TikTok's App Review Guidelines say: "Apps must not be for private or personal
use." The project's model is "bring your own app". Under that model an
individual's app will most likely never pass review. It stays in sandbox or
unaudited mode, which means `SELF_ONLY` posts, a private account, and at most 10
target users.

The README's hero flow (`PUBLIC_TO_EVERYONE`) is out of reach for that user.

Evidence: PLT-01, PLT-02, LGL-02, PRD-02.

**Resolution:**
- Reposition the product around what this user can reach: reading their own
  account and analytics, drafts sent to the inbox, and private test posts
  (`PRD-R5`).
- Say this honestly in the setup and audit docs (`PLT-R3`).
- Whether a public-posting product is wanted at all is an owner decision (see
  § 5, Q2).

### T3 — The human gate is weaker than the docs claim (SEC, DX, LGL, PLT)
There are four gaps:
- The consent dialog leaves out the media and the disclosure and interaction
  flags (SEC-01).
- With `TT_ELICITATION=auto` and a client without elicitation, no dialog runs
  and nothing says so (DX-03).
- Apply mode, batch and run-queue paths run with weaker or pre-given consent
  (LGL-03, SEC-04).
- Comment, duet and stitch default to allowed, where TikTok's UX rules require
  them off (PLT-03).

**Resolution:**
- These items are code work and need no decision: `PLT-R1` (toggles off),
  `SEC-R1` (full payload in the dialog), `PLT-R2` (preview and notices).
- `DX-R3` makes the dialog state visible. Its default value waits for an owner
  decision.
- `LGL-R4` tightens the unattended paths after the compliance guide is written.

### T4 — The docs describe a different system (ARC, LGL, DX, PRD, PLT)
- ARCHITECTURE.md and CONTRACTS.md drifted from the code (ARC-03).
- privacy.html leaves out `schedule.json`, `webhooks.ndjson` and the oEmbed
  egress (LGL-01).
- The README demo is rejected by the strict schema, and it says "four write
  tools" where there are six (DX-02).
- AUDIT.md cites 0.8.0 (PLT, medium).
- CHANGELOG claims a publish that never happened (PRD-06).

**Resolution:** fix each one, and give the fixes that can drift again a gate:
- `DX-R2`: a test checks every JSON block in the docs against its tool schema.
- `LGL-R1`: `npm run sync` fails when a persisted file or egress host is missing
  from the privacy policy.
- `ARC-R3`: gate CONTRACTS.md.

### T5 — Scope keeps growing after the freeze (PRD, ARC)
The tool count went from 11 to 17 after "1.0.0" was cut. About 18 review
sessions and 9 coverage sweeps were spent, against zero sessions with the real
API. The B-track would reshape the profile model before any user exists.

Evidence: PRD-04, PRD-05, PRD-07, ARC-02.

**Resolution:**
- Scope freeze (`PRD-R1`, owner decision).
- Label the reach-limited features experimental (`PRD-R6`).
- `ARC-R7` (provider-aware credential model) becomes a hard prerequisite of B1
  and B2.

### T6 — Release identity and pipeline state (REL, PRD, QA, SEC)
- `release-guard` refuses every tag.
- "1.0.0" was never shipped, and a manual first publish cannot carry
  provenance.
- `VSCE_PAT` is missing.
- A dormant `NPM_TOKEN` contradicts the tokenless design.
- Pages is off, so the privacy URL is a 404.
- Dependabot PRs #36–#38 are open.
- `main` is red because of the `runVirtual` flake.

**Resolution:**
- Fix the flake first (`REL-R2`, merged with QA-R3).
- Decide the version and fold the changelog (`REL-R1`, merged with PRD-R3).
- Clear the dependencies (`SEC-R8`, merged with REL-R5).
- Then the owner runs the bootstrap (`REL-R3`, merged with PRD-R4, G-4 and
  G-14).

## 4. Conflicts resolved

| Topic | Positions | Decision |
|---|---|---|
| First public version | PRD and REL: 0.9.0. Plan and package.json: 1.0.0 | **Recommend 0.9.0** (owner Q1). A 1.0 criterion requires provenance, which a manual first publish cannot give, and P-1..P-14 are unrun. 1.0.0 becomes the first release attested from CI, after the probes. `REL-R1` applies whichever choice the owner makes. |
| Flake fix | QA-R3: one timer-driven helper (3 h). REL-R2: next-timer advance or a large TTL (2 h) | **QA's design inside REL-R2:** one shared `runVirtual` in `test/helpers.ts` that advances to the next timer, plus REL's regression test. 3 h. |
| Where server `instructions` live | SEC-R2 (untrusted-content notice) and DX-R5 (token budget) | **SEC-R2** adds the instructions, because SECURITY.md already claims the notice exists. DX-R5 keeps only the size cut. |
| AUDIT.md rewrite and operator guide | PLT-R3 and LGL-R3 both edit `docs/AUDIT.md` | **Merged into `PLT-R3`** (6 h). One owner per file. |
| CI hygiene | QA-R4 and REL-R4 overlap: timeouts, single test pass, Codecov | **Merged into `QA-R4`** (3 h). |
| Live session | QA-R1, PLT-R4 and PRD-R2 describe the same owner session | **Merged into `QA-R1`.** It uses PRD's step list and records P-1..P-14 per PLT. |
| Owner bootstrap | REL-R3, PRD-R4, G-4, G-14, DX-R1 precondition | **`REL-R3`** follows REL's verified runbook. DX-R1 depends on it. |
| Dependencies | SEC-R8 and REL-R5 | **Merged into `SEC-R8`**, plus REL's dependabot cooldown. |
| Severity of PLT-01 | PLT: Critical. LGL: High | Critical for the *public-posting* promise, but it does not block a release of the read and draft product. The fix is positioning (`PRD-R5`), not code. |

## 5. Owner decisions (no agent can make these)

The owner's answers, dated 2026-10-30, are in [`DECISIONS.md`](DECISIONS.md).

1. **Q1 — First version:** 0.9.0 (recommended), or 1.0.0 published manually
   without provenance? Blocks `REL-R1`.
2. **Q2 — Public posting:** is a public-posting product wanted at all? If yes,
   it needs an audited app held by an operator, which is a hosted service and
   today an explicit non-goal. If no, document the project as a local-first tool
   for reading, drafts and private test posts. Blocks B2 and shapes `PRD-R5`.
3. **Q3 — Consent default:** keep `TT_ELICITATION=auto` with visible state, or
   use a stricter default that refuses writes when the client has no
   elicitation? Blocks `DX-R3` and `LGL-R4`.
4. **Q4 — Scope freeze:** no new tools, packages or `TT_*` settings for 90 days
   after the first publish, B1 moved to non-goals, B2 frozen until the 90-day
   review. Blocks `PRD-R1`.
5. **Q5 — Experimental features:** label them only (recommended), or also put
   them behind `TT_EXPERIMENTAL=1`? Shapes `PRD-R6`.
6. **Q6 — Secrets and distribution:**
   - Revoke the dormant `NPM_TOKEN`?
   - Ship the VS Code extension at the first release (create the publisher and
     `VSCE_PAT`), or defer it?
   - Add a protected `npm` environment, branch protection and a tag ruleset
     (`REL-R7`)?
7. **Q7 — Live session:** run the sandbox session yourself (`QA-R1`, about
   2–4 h). It needs your account as a sandbox target user. Is that account
   public? If it is, drafts are the only write path you can demo.

## 6. Recommended order

The release-blocking path, with owner steps in **bold**:

1. **Decide Q1, Q3 and Q4.** About 15 minutes; this unblocks the rest.
2. Codeable now, in parallel:
   - `REL-R2`: flake fix, turns `main` green
   - `ARC-R1`
   - `PLT-R1`
   - `SEC-R2`
   - `SEC-R8`
   - `DX-R2`
   - `DX-R6`
   - `LGL-R1`
   - `LGL-R5`
3. These follow, in this order:
   1. `SEC-R1`
   2. `PLT-R2`
   3. `PLT-R3`
   4. `ARC-R2`
   5. `REL-R1`
   6. `PRD-R6`
4. **`QA-R1`: the owner runs the sandbox session.** Any mismatch it finds
   becomes its own fix item.
5. `QA-R2` (replay from the recorded fixtures) and `PRD-R5` (repositioned
   README).
6. **`REL-R3`: the owner bootstrap.** Enable Pages, do the manual npm publish,
   change the npm settings and the secrets, push the tag. Then `DX-R1`.

The release-blocking work comes to about 60 h of agent time. That includes the
items that start only after an owner decision: `PRD-R1`, `REL-R1`, `DX-R3` and
`DX-R1`. The owner work comes to about 5 h of hands-on time (`QA-R1` and
`REL-R3`), plus the decisions.

## 7. Index of report IDs to roadmap items

**Merged** (the absorbed IDs live on in the reports only):

| Roadmap item | Absorbed IDs |
|---|---|
| QA-R1 | PLT-R4, PRD-R2 |
| REL-R1 | PRD-R3 |
| REL-R2 | QA-R3 |
| REL-R3 | PRD-R4, G-4, G-14 |
| SEC-R8 | REL-R5 |
| PLT-R3 | LGL-R3 |
| QA-R4 | REL-R4 |

Every other proposed item keeps its report ID in the roadmap. Each roadmap item
points back to its report for evidence and full acceptance criteria.
