# Round 3 — QA / Test Architect review

Date 2026-10-29 · commit 301b9bb · reviewer role: senior QA / Test Architect (test strategy, contract
testing, property testing, flaky-test diagnosis) · scope: the built test system — `test/` (73 files),
`test/harness/`, `scripts/{fixtures-*,coverage-gate,smoke-pack}.ts`, `scripts/coverage-floors.json`,
`scripts/ignore-budget.json`, `.c8rc.json`, `.github/workflows/ci.yml`, `docs/TESTING.md`,
`docs/probes/{PROBE-LOG,RUNBOOK}.md`, `docs/TIKTOK-API.md`, CI history on `main`.

Executed: one `npm run build && npm test` locally (under concurrent reviewer load) —
**2416/2416 pass, test-runner duration 46.1 s, 3 m 05 s wall including build, 19 % CPU**
(`scratchpad/qa-test.log`). CI logs read with `gh run view` for runs 40863479987, 40863479896,
40392794940, 40392798808, 40393110181, 40939777223.

## Verdict

The suite is an unusually disciplined *self-consistency* proof: 2.4k tests, deterministic clock and
RNG seams, a 2-line `c8 ignore` budget, self-proving gates that refuse to pass vacuously, a 3-OS
packed-tarball smoke. But every TikTok byte the suite has ever parsed was written by the same hand
that wrote the parser — `test/fixtures/recorded/` does not exist, all 14 sandbox probes are `not run`,
and the riskiest surfaces (OAuth token exchange, chunked upload, all four publish inits) are excluded
from the replay contract even once fixtures exist. 99.8 % coverage therefore proves "the code does
what the spec author believed", not "the code works against TikTok". On top of that, `main` went red
on 2026-10-29 from a **reproducible-by-design flake** in the virtual-clock helper — the third
incarnation of the same root cause the WORKLOG has already "fixed" twice. **Readiness 4/10**: the
internal test engineering is 8–9/10, but for a release whose v1.0 criteria require probes
P-1..P-14 executed (`docs/IMPLEMENTATION-PLAN.md:169`), the external validation is essentially zero.

## What is strong

- **Seams, not monkey-patching.** Injectable `Clock` (`src/core/clock.ts`), seeded RNG
  (`test/harness/rng.ts`), fixed-seed fast-check (`test/http.test.ts:502`, `test/api-upload-plan.test.ts:421`),
  scriptable upload simulator, multi-process env-lock harness (`test/harness/multi-process.ts`).
- **Non-vacuity everywhere.** The replay suite counts its synthetic self-tests and fails if they did not
  run (`test/fixtures-replay.test.ts:16-22`, `SELF_TESTS = 10`); sync gates fail on a missing anchor
  rather than passing (seen in CI logs: "floors-doc-sync: … has no floors table").
- **Coverage budget is honest.** Global floor 98/98/98 with per-file 98/98/100 on the money paths
  (`scripts/coverage-floors.json`), ignore budget `{"hints": 2, "blockLines": 0}` and exactly 2
  `c8 ignore` in `src/`.
- **Black-box packed smoke** on ubuntu/macOS/windows (`scripts/smoke-pack.ts`, `ci.yml` smoke-pack job)
  that builds its child env from nothing and does a real JSON-RPC handshake.
- **Real SDK client over Streamable HTTP** (`test/mcp-http.test.ts:36,312`) and a real-socket DNS-pin
  test through the undici `Agent` (`test/dns-pin.test.ts:168`).

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| QA-01 | Critical | Zero real-API evidence: no recorded fixtures, all live probes P-1..P-14 `not run`, Phase-2 exit gate (SELF_ONLY E2E) never met, yet the version reads 1.0.0 | `test/fixtures/recorded/` absent (`git ls-files` has no fixture data); `docs/probes/PROBE-LOG.md:13,138-153` all `not run`; `docs/ROADMAP.md:38-42`; `docs/IMPLEMENTATION-PLAN.md:64,169` | Run the minimal live-validation plan (QA-R1) before any npm publish; record fixtures in the same session |
| QA-02 | High | The contract-replay design excludes the riskiest surfaces: only 5 read endpoints are routable; `auth` and `upload` are declared non-replayable; publish inits (video/inbox/photo, PULL_FROM_URL), status for photo, webhooks, oEmbed, revoke have no route; recorder catalog is read-only | `test/harness/fixtures.ts:182-195` (ROUTES), `:229-240` (NON_REPLAYABLE_AREAS); `scripts/fixtures-record.ts:129-175` (5 captures) | Add routes for init/status/token/chunk-PUT fixtures captured by hand during QA-R1 (QA-R2) |
| QA-03 | High | `main` CI red 2026-10-29 (run 40863479987, ubuntu/22): `cc-g7 … deepest hint chain` failed `plan_not_found`. Root cause: `runVirtual` advances the mock clock 500 ms per event-loop turn **unconditionally** for up to 20 s of wall time; any real I/O (journal mkdir/append, file read) before the plan is consumed lets virtual time pass the 600 s plan TTL (1200 turns). Same class as the two earlier "fixes" (WORKLOG l.1110 fixed-steps→wall-clock; l.3665 `holdTime` added only in `api-upload.test.ts`) | `test/tool-publish-write.test.ts:486-504`, `:2645-2700`; duplicates `test/tool-publish-draft.test.ts:320`, `test/tool-publish-photos.test.ts:313`, `test/api-upload.test.ts:250-269`; `src/mcp/plan-store.ts:118-119`; CI log `tool-publish-write.test.js:2063` | Single shared `runVirtual` in `test/helpers.ts` that advances only while `clock.pending() > 0`, otherwise yields real time (QA-R3) |
| QA-04 | High | Hand-written fakes encode belief, not observation, and are duplicated: `fakeApi` exists in 5 files, routes by `path.endsWith`, defaults every chunk PUT to `201` (TikTok documents 206 for non-final chunks — exactly what P-11 is meant to settle), `ttEnvelope` is always HTTP 200; no fake validates method, `Authorization`, `Content-Type` or body schema of what the client sent | `test/tool-publish-write.test.ts:281-330` (`bare(201)` default at :317); `grep -l "function fakeApi" test` → 5 files; `test/helpers.ts:236-251` | One schema-validating fake TikTok (request zod-checked against `docs/TIKTOK-API.md`), seeded from recorded fixtures (QA-R2) |
| QA-05 | High | Probe runbook is not executable today: setup calls `npx tiktok-mcp-ai login/doctor` but the package is unpublished (`npm view` → E404); probes gate publish, publish gates the runbook — a circular dependency | `docs/probes/RUNBOOK.md:35-36,114` | Use `node build/src/index.js …` (or `npm link`) in the runbook; part of QA-R1 |
| QA-06 | Medium | No hang protection: no `timeout-minutes` in any workflow, no `--test-timeout`, zero per-test `timeout:` options. A hung child-process or drain test burns the GitHub default 6 h | `grep timeout-minutes .github/workflows/*.yml` → none; `package.json` `test` script; `grep -c "timeout:" test/*.ts` → 0 | `--test-timeout=60000` in `test`/`coverage:run`, `timeout-minutes: 20` per job (QA-R4) |
| QA-07 | Medium | Codecov upload fails silently on every `main` run ("Token required - not valid tokenless upload"), masked by `continue-on-error`; the README coverage badge is therefore stale/unbacked. The ci.yml comment "thresholds are enforced by .c8rc.json" is also misleading — `.c8rc.json` holds 90/80/95, the real gate is `coverage-floors.json` 98 | CI run 40939777223 codecov step; `.github/workflows/ci.yml:47-58`; `.c8rc.json` | Add `CODECOV_TOKEN` secret or drop the upload + badge; fix the comment (QA-R4) |
| QA-08 | Medium | The suite runs 3× on the ubuntu/22 leg: `npm run check` already does `test` + `coverage:run` + `coverage:gate`, then `npm run coverage` rebuilds and runs it again — triples flake exposure and wall time on the one leg that uploads coverage | `package.json` `check`/`coverage`; `ci.yml:46,49-50` | Drop the separate `npm run coverage` step; upload the lcov the check already produced (QA-R4) |
| QA-09 | Medium | Property tests are fixed-seed only; the round-2 plan for a nightly 2 000-run exploration with printed seeds was never built — the properties re-check the same 200–300 inputs forever | `test/http.test.ts:502,527`; `test/api-upload-plan.test.ts:421`; `docs/reviews/round2/qa-deep-review.md` § 6.2; no `schedule:` in `.github/workflows/ci.yml` | Env-driven seed/runs (`TT_PROP_SEED`, `TT_PROP_RUNS`) + nightly workflow (QA-R5) |
| QA-10 | Medium | Coverage is not assertion strength: no mutation testing on the money paths; 276 assertions match on prose (`message.includes` 183, `text.includes` 93), coupling tests to wording while saying nothing about whether a mutated branch is caught | `grep -rhoE "message\.includes\(|text\.includes\(" test/*.ts`; no Stryker/mutation config in repo | One-off Stryker run on `core/http.ts`, `api/upload.ts`, `mcp/plan-store.ts`, `core/oauth.ts`; record the score (QA-R6) |
| QA-11 | Medium | No out-of-process E2E that reaches a `tools/call` with a (fake) upstream: the API origin is a hard-coded constant, so spawned-server tests and `smoke:pack` stop at `initialize`/`tools/list`; every real tool path runs in-process with `globalThis.fetch` stubbed (bypassing the undici dispatcher/pin path the production fetch uses) | `src/api/context.ts:133`, `src/core/http.ts:66`; `scripts/smoke-pack.ts:570-599`; `test/helpers.ts:216` | Live smoke script (QA-R1) covers this against the real API; do not add a production origin override |
| QA-12 | Low | Only MCP protocol `2025-06-18` is exercised; no negotiation test for an older (`2025-03-26`) or newer client version | `test/entry.test.ts:94,320`, `test/mcp-http.test.ts:298`, `test/server.test.ts:2474` | Parametrize the handshake test over supported versions (QA-R5) |
| QA-13 | Low | Known-but-uninvestigated flake left open: `harness.test.ts` "a worker module without a default export…" child exit 90 under load | `WORKLOG.md:3642` | Track as an item; fold into QA-R3 sweep |
| QA-14 | Low | Slow tests dominate wall time under load: webhook redelivery-memory 6.2 s, surrogate truncation property 5.6 s, unreadable credential store 5.4 s, four stdio-drain tests 2.6–3.0 s each | `scratchpad/qa-test.log` (local run) | Move bounded-memory and long properties behind the nightly profile (QA-R5) |
| QA-15 | Low | Windows leg skips every credential-file permission assertion (POSIX_ONLY / mode-bit skips) — there is no test of what protects the env file on win32 at all | `test/doctor.test.ts:427-513`, `test/config.test.ts:46` | Decide the win32 posture (owner Q2) and assert it, even if it is "warn only" |

### QA-01 — Zero real-API evidence

**What.** The project's own definition of v1.0 says probes P-1..P-14 executed and recorded
(`docs/IMPLEMENTATION-PLAN.md:169`) and the Phase-2 exit gate is a live SELF_ONLY end-to-end
(`docs/ROADMAP.md:38-42`). None of that happened; meanwhile `[Unreleased]` grows with v1.1–1.3
features built on the same unverified assumptions. `fixtures-replay.test.ts` is honest about it — it
warns that nothing is replayed — but a warning is not a gate.

**Why it matters.** Many load-bearing decisions are probe-gated guesses: 206 vs 201 chunk answers
(P-11), re-PUT tolerance (P-2), 416 body shape, `upload_url` host allowlist (P-9/P-14 — a wrong host
list hard-fails *every* upload by design of the host guard), refresh-rotation grace (P-3), out-of-scope
field behaviour (P-4). Any one being wrong is a 100 % failure of a headline tool on first real use.

**Failure scenario.** v1.0.0 lands on npm; the first user's `tiktok_post_video` (file) fails because
the upload host is `*.tiktokcdn-eu.com` or similar and the guard rejects it, or because a non-final
chunk answered 206 with a header shape the parser did not expect. The 2.4k green tests could not have
caught either.

**Fix.** QA-R1: a 1–2 hour, single-account session that covers the release-blocking probes and
records fixtures at the same time; everything else in the probe catalog (P-1, P-7, P-8, P-10, P-13,
P-16) is explicitly deferred with a dated note in PROBE-LOG.

### QA-02 — Contract replay excludes the riskiest surfaces

**What.** The replay harness can only route `user/info`, `video/list`, `video/query`,
`creator_info/query`, `status/fetch` (`test/harness/fixtures.ts:182-195`). `auth` and `upload` are
declared non-replayable "because another test owns that contract" (`:229-240`) — but those other
tests own a *hand-written* contract. Init endpoints have no route at all.

**Why.** Drift detection is weakest exactly where TikTok's behaviour is least documented and
consequences are highest (money path, token rotation).

**Fix.** QA-R2: add replay routes for the four init endpoints and status; add a separate "raw HTTP"
fixture kind for token exchange/refresh (form-encoded, no envelope) and chunk PUT (status + headers +
body), replayed through `core/oauth` and `api/upload` parsers respectively. Hand-captured during QA-R1
and sanitized by `fixtures-sanitize`.

### QA-03 — Free-running virtual clock (red `main`)

**What.** `runVirtual` (`test/tool-publish-write.test.ts:486-504`) does
`while (!done && Date.now() < giveUpAt) await clock.advance(500)`. `advance` yields one macrotask;
while the call under test is awaiting *real* filesystem I/O (this test deliberately makes the journal
path a directory, so appends fail through real fs calls), the loop keeps moving virtual time. 1200
turns = 600 s = plan TTL (`src/mcp/plan-store.ts:118-119`), so the apply sees `plan_not_found`. Locally
it passed; on a slower CI runner it failed. The 120 s request-timeout variant of the same bug was
patched only in `api-upload.test.ts` (`holdTime`, `:246-266`); the three tool-level copies were not.

**Why.** It is not a "load flake" to retry — it is a deterministic race whose outcome depends on I/O
latency, and four divergent copies guarantee it returns.

**Fix.** QA-R3: one `runVirtual` in `test/helpers.ts`: per turn, `await setImmediate()`; call
`clock.advance(...)` **only when `clock.pending() > 0`** (the code is blocked on a virtual sleep) —
ideally advance straight to the next due timer. Delete the four local copies; add a regression test
that runs a call with a slow real-I/O stub and a 1 s plan TTL and asserts it still applies.

### QA-04 — Fakes that encode belief

**What.** Five private `fakeApi` copies, suffix routing, permissive request handling, always-200
envelopes, `201` default for every chunk. A request-side bug (wrong method, missing `Content-Type:
application/json; charset=UTF-8`, wrong `Content-Range` format on the last chunk) passes unless an
individual test happens to assert it.

**Fix.** QA-R2: a single `test/harness/fake-tiktok.ts` that (a) zod-validates every incoming request
against the documented shape per endpoint, failing the test on any deviation, (b) returns responses
seeded from recorded fixtures when present, and (c) models the documented 206/201 chunk semantics.
Migrate the five copies.

### QA-05 — Runbook not executable

The runbook's setup step uses `npx tiktok-mcp-ai` (`docs/probes/RUNBOOK.md:35-36,114`); the package is
not on npm. Whoever finally books sandbox time hits E404 at minute one — or worse, a squatted name.
Replace with `node build/src/index.js login|doctor` from the repo checkout.

## Open questions for the owner

1. **Is v1.0.0 allowed to ship without the live probes?** If yes, the IMPLEMENTATION-PLAN v1.0
   criterion and the Phase-2 gate must be formally amended and the README must say "not validated
   against the live API"; if no (recommended), QA-R1 is the critical path and feature work should pause.
2. **Windows credential-file posture**: accept "no ACL enforcement, doctor warns" or implement an ACL
   check? Tests cannot assert a policy that does not exist (QA-15).
3. **Codecov**: add a token, or drop Codecov and the badge in favour of the in-repo gate?
4. **Sandbox account logistics**: do you have a sandbox app with Login Kit + Content Posting and a
   private target-user account today? P-8/P-9/P-10 need extra accounts — confirm they may be deferred.
5. **Mutation-score target**: is a one-off measurement enough, or should a floor become a gate?

## Proposed roadmap items

#### QA-R1 — Run the minimal live-validation session against the sandbox
Deps — · Status blocked: owner (sandbox app + private target-user account, human at the keyboard) · Est 4 h

- **Scope:** **Release-blocking.** One session, one account, in this order (spends 2–3 inits):
  (1) fix RUNBOOK setup to `node build/src/index.js login|doctor`; (2) `doctor` all ok;
  (3) reads: `tiktok_get_user_info`, `tiktok_list_videos`, `tiktok_query_videos`, `creator_info` —
  with `fixtures:record` on, plus P-4 (one out-of-scope field); (4) inbox draft of a ≤5 MB MP4 via
  `source=file`, multi-chunk (force small chunk size) — capture raw init, every chunk-PUT status +
  headers + body, the `upload_url` host and query params (P-14, P-11, P-9 for this account), poll
  status to terminal; (5) SELF_ONLY direct post `source=file` to `PUBLISH_COMPLETE` (Phase-2 gate),
  capture `status/fetch` bodies; (6) one deliberate re-PUT of an accepted range (P-2) on a fresh init;
  (7) last: P-3 (two rapid refreshes) on a throwaway env file. Record each in PROBE-LOG; mark P-1, P-5,
  P-6, P-7, P-8, P-10, P-12, P-13, P-16 as "deferred to v1.x" with reason. Any spec contradiction goes
  through the CONTRACTS change log.
- **Owns:** `docs/probes/PROBE-LOG.md`, `docs/probes/RUNBOOK.md`, `test/fixtures/recorded/**`
- **Shared:** `docs/TIKTOK-API.md`, `docs/CONTRACTS.md` (only if a probe contradicts them), `src/core/http.ts` (upload host list, only if P-9/P-14 contradict it)
- **Acceptance:**
  - PROBE-LOG has dated entries for P-2, P-3, P-4, P-9, P-11, P-14 and a SELF_ONLY E2E entry; others marked deferred with reason
  - `test/fixtures/recorded/` contains ≥5 read fixtures, sanitized; `fixtures-replay` section B replays them with no drift
  - Secret-shape meta test green on the committed tree; diff reviewed by the owner
  - RUNBOOK contains no `npx tiktok-mcp-ai` before publish

#### QA-R2 — Extend contract replay to inits, token and chunk-PUT, behind one validating fake
Deps QA-R1 · Status todo · Est 8 h

- **Scope:** **Release-blocking.** Add a `raw` fixture kind (status, headers, body; no envelope) for
  token exchange/refresh and chunk PUT; add replay routes for video/inbox/photo init and status;
  build `test/harness/fake-tiktok.ts` that zod-validates every request per endpoint and serves
  fixture-seeded responses with documented 206/201 chunk semantics; migrate the 5 `fakeApi` copies.
- **Owns:** `test/harness/fake-tiktok.ts`, `test/harness/fixtures.ts`, `scripts/lib/fixtures.ts`
- **Shared:** `test/tool-publish-{write,draft,photos,read}.test.ts`, `test/hint-guard.test.ts`, `test/fixtures-replay.test.ts`, `scripts/fixtures-sanitize.ts`, `docs/TESTING.md`
- **Acceptance:**
  - `grep -l "function fakeApi" test` returns nothing
  - A request with a wrong method / missing `Content-Type` / malformed `Content-Range` fails a test via the fake, proven by a self-test
  - `NON_REPLAYABLE_AREAS` is empty or each entry names a test that replays a recorded raw fixture
  - Recorded init, status, token and chunk fixtures from QA-R1 replay green

#### QA-R3 — Replace the free-running virtual clock helper with a timer-driven one
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking** (main is red-prone). One `runVirtual` in `test/helpers.ts` that
  advances virtual time only while `clock.pending() > 0` (to the next due timer), otherwise yields
  real time; remove the 4 local copies and `holdTime`; regression test with slow real I/O and a short
  plan TTL; investigate the `harness.test.ts` exit-90 flake (WORKLOG l.3642).
- **Owns:** `test/helpers.ts` (runVirtual), `test/helpers.test.ts`
- **Shared:** `test/tool-publish-write.test.ts`, `test/tool-publish-draft.test.ts`, `test/tool-publish-photos.test.ts`, `test/api-upload.test.ts`, `test/harness.test.ts`
- **Acceptance:**
  - `grep -n "function runVirtual" test` → exactly one hit, in `test/helpers.ts`
  - New regression test: a call whose stub awaits 200 ms of real I/O before consuming a plan with `TT_PLAN_TTL_S=1` applies successfully
  - Full suite green 10× in a row under `stress`-style parallel load (e.g. 4 concurrent `npm test`), result noted in WORKLOG

#### QA-R4 — Harden CI hygiene: timeouts, single test pass, honest coverage upload
Deps — · Status todo · Est 1.5 h

- **Scope:** add `--test-timeout=60000` to `test` and `coverage:run`; `timeout-minutes: 20` on every
  CI job; remove the duplicate `npm run coverage` step on ubuntu/22 and upload the lcov produced by
  `check`; fix or remove the Codecov upload per owner decision; correct the `.c8rc.json` comment.
- **Owns:** `.github/workflows/ci.yml`
- **Shared:** `package.json` (scripts), `README.md` (badge, if dropped), `docs/TESTING.md` § CI matrix
- **Acceptance:**
  - `actionlint` clean; every job has `timeout-minutes`
  - The ubuntu/22 leg runs the test suite at most twice (plain + coverage)
  - Codecov step either succeeds on `main` or no longer exists
  - A deliberately hanging test fails within 60 s locally

#### QA-R5 — Add a nightly exploration profile for properties and protocol versions
Deps QA-R4 · Status todo · Est 3 h

- **Scope:** fast-check seed/runs from `TT_PROP_SEED`/`TT_PROP_RUNS` (fixed defaults for PR CI);
  nightly scheduled workflow with random seed and 2 000 runs that prints the seed on failure; move the
  three >5 s tests behind the nightly profile; parametrize the initialize handshake test over the
  supported MCP protocol versions.
- **Owns:** `.github/workflows/nightly.yml`, `test/harness/rng.ts`
- **Shared:** `test/http.test.ts`, `test/api-upload-plan.test.ts`, `test/oauth.test.ts`, `test/entry.test.ts`, `docs/TESTING.md`
- **Acceptance:**
  - PR CI behaviour unchanged (same seeds) and wall time not higher
  - Nightly run executes ≥2 000 runs per property and logs the seed
  - Handshake test covers at least `2025-03-26`, `2025-06-18` and the SDK's latest

#### QA-R6 — Measure assertion strength with a one-off mutation run on the money paths
Deps — · Status todo · Est 4 h

- **Scope:** run Stryker (or equivalent) on `src/core/http.ts`, `src/api/upload.ts`,
  `src/mcp/plan-store.ts`, `src/core/oauth.ts`; record the mutation score per file in
  `docs/TESTING.md`; kill or justify surviving mutants with new assertions.
- **Owns:** `stryker.config.json` (dev-only, not in `files`)
- **Shared:** `docs/TESTING.md`, tests for the four files, `package.json` (devDependency)
- **Acceptance:**
  - Score recorded per file; every surviving mutant either killed by a new assertion or listed with a reason
  - Not part of `npm run check` (cost); documented how to rerun

Top recommendation: stop adding features and run QA-R1 — one sandbox session that records fixtures and settles the upload/token probes is worth more than the next thousand mocked tests.
