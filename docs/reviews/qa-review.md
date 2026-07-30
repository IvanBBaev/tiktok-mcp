# Design Review — Senior QA Engineer

## 1. Reviewer & scope

- **Role**: Senior QA Engineer — test architecture, Node.js, API mocking, property-based testing.
- **Date**: 2026-07-21.
- **Review focus**: testability of the whole design and completeness of the test strategy. `docs/TESTING.md` is the document under review, but every finding is assessed against the full specification.
- **Documents reviewed**: `README.md`, `docs/ARCHITECTURE.md`, `docs/TIKTOK-API.md`, `docs/TOOLS.md`, `docs/AUTH.md`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/ROADMAP.md`.
- **Baseline consulted**: the `servicenow-mcp-ai` architecture map (node:test, c8 ratcheted gates, `withFetch` recording mocks, manifest snapshot, `readme-sync`/`env-docs-sync` gates), which this design deliberately mirrors.

## 2. Executive summary

The test strategy inherits a proven harness (node:test, `withFetch` recording mocks that assert *outgoing* requests, manifest snapshot, sync gates, c8 ratchet, fast-check for chunk math) and correctly identifies the platform's sharpest edge — errors inside HTTP 200 — as a first-class test area. The plan-and-apply "no fetch on plan" assertion style is exactly right. As a skeleton, this is a strong start.

However, `docs/TESTING.md` is currently a happy-path-plus-one-error strategy for a server whose entire value proposition is surviving the *unhappy* paths. The highest-risk state machines in the design — chunked upload execution (as opposed to chunk *planning*), refresh-token rotation under persistence failure and cross-process access, the poll-until-terminal loop, and the `login` CLI flow — have either no planned tests or only their single happiest branch. There is no stated strategy for controlling time, which makes half of the listed tests (skew refresh, backoff, token bucket, 5 s polling, 60 s timeout) either slow, flaky, or unwritable as specified. Several spec ambiguities surfaced by writing this review ("delayed/rejected", "domain set fixed at implementation time", replay-if-no-publish_id) are themselves testability defects: a test cannot be written against an undecided behavior.

None of this requires redesigning the product. It requires roughly doubling the enumerated test surface, deciding a handful of behaviors, and adding three pieces of test infrastructure (deterministic clock, upload failure-injection harness, generated media fixtures).

**Verdict: Approve with changes.** The strategy skeleton and tooling choices are approved. `docs/TESTING.md` must be revised to address the High findings (F-1 … F-8) and to incorporate the test cases in § 5 before Phase 0 exit; Medium findings should land before their corresponding phase gates (publishing-related ones before Phase 2 exit).

## 3. Strengths

- **Request-asserting mocks.** `withFetch` records the outgoing request and tests assert URL, headers, and body — not just the handler's return value. This catches wrong `fields` serialization, missing `Content-Range`, and envelope misuse, which response-only mocks never would.
- **Negative-space assertions.** "Fetch mock not called" as an explicit assertion (host guard, plan mode, local validation failures) is the single best pattern in the document; it tests the absence of a side effect, which is where write-safety bugs live.
- **`ttEnvelope` as a first-class helper.** Baking the `{ data, error }` envelope into every mock response means no test can accidentally model TikTok as a normal REST API.
- **Manifest snapshot + sync gates.** Any tool-surface change forced through a reviewable fixture diff, plus `readme-sync`/`env-docs-sync`, is proven in the sibling project and correctly ported.
- **Property-based chunk math.** Bounds/contiguity/sum-to-size for arbitrary file sizes is the right property formulation and the right tool (fast-check).
- **Mock-only CI, honest about it.** CI never talks to TikTok; the manual sandbox checklist is explicitly separate. The stance is correct even if the integration layer is currently too thin (F-15).
- **Test-relevant design decisions already made.** `.strict()` schemas, idempotent-path *allowlist* (not method sniffing), single `TikTokError` taxonomy, atomic snapshot swap for credentials — all of these are designed to be assertable.

## 4. Findings

Severity scale: **Critical** (would ship a data-loss/lockout/protocol-breaking defect), **High** (a realistic, damaging defect class has no planned detection), **Medium** (gap that will surface as field bugs or flaky CI), **Low** (hardening/completeness).

---

### F-1 — HIGH — Chunked upload *execution* is untested; only chunk *planning* is covered

**Issue.** TESTING § api/* covers chunk-plan math and Content-Range header construction. Nothing covers the upload state machine at runtime: a PUT for chunk 3 of 5 failing (network error, 5xx, 408, connection reset mid-body), the `upload_url` expiring (it is valid **1 hour** — a 4 GB file on a slow uplink can exceed that), the per-PUT `TT_UPLOAD_TIMEOUT_MS` firing mid-stream, or TikTok's expected intermediate-chunk response codes. The retry matrix says uploads are never auto-retried, but the design never states — and the strategy never tests — what the tool *returns* after a partial upload: is `publish_id` surfaced so the model can poll or resume? Is resume even attempted, or is the upload abandoned?

**Defect that slips through.** A transient reset on chunk 3 leaves TikTok holding a half-uploaded video in `PROCESSING_UPLOAD`. The tool throws a generic error *without* the `publish_id`, the model retries the whole `tiktok_post_video` call, a second init succeeds — the user gets a duplicate (or a spam-risk strike), and the journal shows one entry for two upstream attempts.

**Recommendation.** Decide the semantics first (recommended: no resume in v1; on any upload failure return a structured error that *always* carries `publish_id`, the failed chunk index, and a hint to poll `tiktok_get_publish_status`; journal the attempt with outcome `upload_failed`). Then add a failure-injection harness to `withFetch` (per-call script: "init OK, PUT#1 OK, PUT#2 → ECONNRESET") and the test cases in § 5 "core/upload". See Deep dive § 6.1.

**Doc ref.** TESTING § api/*; ARCHITECTURE § 6, § 8; TIKTOK-API § 4.2; TOOLS `tiktok_post_video`.

---

### F-2 — HIGH — Duplicate-post ambiguity on init failure is untested and under-specified

**Issue.** The retry matrix entry "one forced refresh, one replay of init **only if no publish_id was returned**" implies a decision table that is nowhere enumerated: 401 before send vs. after send, network timeout *after* the request body was transmitted (the init may have been processed upstream), HTTP 200 + `error.code !== "ok"` on init, 5xx on init. TESTING only lists "429 never retried for publish inits".

**Defect that slips through.** A socket timeout after the init was accepted upstream is reported as a plain failure; the model re-invokes with `apply: true`; two posts are published. Conversely, an over-eager replay after a mid-flight 401 produces the same duplicate.

**Recommendation.** Write the decision table into ARCHITECTURE § 6 (recommended: any init failure where the request *may have been sent* — timeout, reset after send, ambiguous 5xx — is terminal, no replay, and the error message must say "the post may still have been created — check the journal / `tiktok_get_publish_status` / `tiktok_list_videos` before retrying"). Table-driven tests: one row per (failure point × response class), asserting exactly how many init requests the fetch mock saw and asserting the uncertainty wording in the error.

**Doc ref.** ARCHITECTURE § 6 (retry matrix row 3); TESTING § core/http; TOOLS `tiktok_post_video` errors.

---

### F-3 — HIGH — Refresh-token rotation hazards: persistence failure and cross-process races

**Issue.** TESTING covers rotation happy path ("new refresh token is persisted"). Two realistic failure modes are neither designed for nor tested:

1. **Persist failure after rotation.** Refresh succeeds, TikTok rotates the refresh token (old one now invalid), then the atomic env-file write fails (disk full, read-only FS, permissions). If the process later dies, the only valid refresh token existed solely in memory → **permanent lockout**, user must re-login.
2. **Cross-process race.** Two server instances (e.g. Claude Desktop + Claude Code, both configured with this server) share the XDG env file. Both refresh with the same refresh token; with rotation, one instance's persisted token is invalidated by the other's refresh. Atomic single-file writes do not fix last-writer-wins across processes, and the in-process per-profile mutex is invisible to the second process.

**Defect that slips through.** Intermittent, unreproducible "authorization expired — log in again" reports from users running two MCP clients, each individually correct.

**Recommendation.** (a) Test that a persist failure after rotation keeps serving the in-memory token, logs loudly, and retries persistence on the next write. (b) Decide the multi-process story: at minimum re-read the env file before a refresh (pick up a sibling's newer token), tolerate `invalid_grant` by re-reading once before declaring terminal failure, and document "one server instance per profile" as a known limitation. Test with two credential-store instances in one test process sharing a scratch env file.

**Doc ref.** AUTH § 2, § 4; ARCHITECTURE § 7; TESTING § core/oauth.

---

### F-4 — HIGH — The `login` CLI flow has zero planned tests

**Issue.** TESTING has no section for `index.ts` / CLI at all. `login` runs a one-shot loopback HTTP listener, verifies `state`, exchanges the code with PKCE, computes expiries, persists per-profile, and prints a partial-grant summary. Every one of those steps is testable without a browser — drive the listener with a plain HTTP request from the test — and none is listed. `doctor` and the node-version guard are likewise absent.

**Defect that slips through.** `state` mismatch accepted (CSRF on the loopback), `?error=access_denied` callback crashing instead of printing a clean message, port 43110 already bound producing an unintelligible stack, `expires_at` computed from the wrong field, partial scope grant persisted as full — any of these bricks or corrupts auth at first-run, the single worst place to fail a new user.

**Recommendation.** Add a "cli/login" test area: success round-trip (listener injected on an ephemeral port; assert token-exchange request contains `code_verifier`, assert persisted keys and `0600` mode); `state` mismatch → rejection, nothing persisted; `error=access_denied` callback → clean message, exit non-zero; port busy → actionable error; callback timeout; partial scope grant → persisted `TT_SCOPES` matches *granted*, summary shows the delta; `--revoke` calls the revoke endpoint and removes exactly the profile's keys. `doctor`: exit-code matrix (0 healthy / non-zero per hard-failure class) with mocked probe.

**Doc ref.** AUTH § 1; ARCHITECTURE § 2; TESTING (absent).

---

### F-5 — HIGH — No deterministic time-control strategy; half of the listed tests are time-dependent

**Issue.** Skew-window refresh (30 min), backoff `min(500·2^n, 8000) + jitter`, `Retry-After` cap, publish token bucket (6/min), poll interval 5 s, poll timeout 60 s, token expiries — the strategy lists tests for all of these but never states how time is controlled. With real timers the poll tests alone add minutes of wall time; with none, jitter makes backoff assertions flaky.

**Defect that slips through.** Two flavors: (a) the poll-timeout-vs-terminal race — poll loop times out at 60 s while the *in-flight* status request returns `PUBLISH_COMPLETE`; without controllable timers this interleaving cannot be constructed, so whichever behavior gets implemented ships untested (worst case: tool reports timeout for a post that visibly succeeded, model retries, duplicate); (b) a slow, intermittently red CI that the team learns to re-run instead of trust.

**Recommendation.** Mandate in TESTING.md: all durations flow through `core/settings.ts` (already true) *and* all waiting flows through an injectable sleep/clock (or `node:test`'s `t.mock.timers.enable({ apis: ["setTimeout", "Date"] })`, available on Node ≥ 20). Jitter must be an injectable RNG (seeded in tests) or asserted by bounds only. Add explicit tests: timeout fires while a status request is in flight and terminal state arrives "late" (define the winner — recommended: a terminal result obtained before returning always wins over the timeout); poll returns the *last observed* status plus `hints: "poll again"` on timeout.

**Doc ref.** TESTING § tools/*, § core/oauth, § core/http; CONFIGURATION (poll/timeout/RPM knobs); ARCHITECTURE § 6.

---

### F-6 — HIGH — Host-guard and `upload_url` validation negatives are too thin, and the allowed-domain set is an untestable placeholder

**Issue.** TESTING lists "https + allowed suffix, private ranges rejected". ARCHITECTURE § 6 defers the actual upload-domain set to "*exact domain set fixed at implementation time*". Two problems: (1) the classic suffix-matching bug class is not called out — a naive `endsWith("tiktokapis.com")` accepts `eviltiktokapis.com`; without a dot-anchored (or exact-host) check and a test for it, the SSRF control is one refactor away from a bypass; (2) a test cannot pin an allowlist that the spec has not defined, so the security-critical assertion will be written *after* the code it is supposed to constrain.

**Defect that slips through.** A hostile/compromised upstream response (or a future TikTok API change handled sloppily) supplies `upload_url: "https://open.tiktokapis.com.attacker.io/…"` or `https://eviltiktokapis.com/…` — the video bytes, and any headers the client attaches, go to an attacker host.

**Recommendation.** Fix the domain-matching *algorithm* in the spec now (exact host or `host === d || host.endsWith("." + d)`), even if the domain list has a verify-marker. Negative suite (each asserting **fetch not called**): `eviltiktokapis.com`; `open.tiktokapis.com.attacker.io`; `http:` scheme; userinfo (`https://u:p@…`); IPv4/IPv6 literals incl. `[::1]`, `169.254.x`, `10.x`; trailing-dot host; explicit port; uppercase host (must normalize, then pass/fail correctly). Property test: any URL accepted by the guard has a host that is *exactly* a member of the allowset under the dot-anchored rule. Also assert **header hygiene**: the upload PUT must not carry the API bearer token unless the TikTok contract requires it (see Deep dive § 6.1).

**Doc ref.** ARCHITECTURE § 6.1; SECURITY § Egress control; TESTING § core/http.

---

### F-7 — HIGH — Semaphore × single-flight refresh deadlock scenario; the semaphore has no tests at all

**Issue.** `TT_MAX_CONCURRENT` (default 4) gates requests per host; the refresh is single-flight per profile. If the refresh request itself is routed through the same semaphore while 4 requests hold slots *waiting on that refresh*, the system deadlocks. Whether the implementation will have this bug depends on ordering decisions the spec does not make, and the strategy contains no semaphore tests and no combined-scenario test.

**Defect that slips through.** Under a burst of ≥ 4 concurrent tool calls exactly when the token crosses the skew window, the server hangs forever; in stdio mode this presents as a wedged MCP client with no error anywhere.

**Recommendation.** Specify that token-endpoint requests bypass the data-path semaphore (they target the same host). Tests: (a) with limit 4 and 5 concurrent deferred requests, at most 4 fetches are in flight (assert via mock instrumentation), the 5th proceeds after a release; (b) **the deadlock canary**: 4+ concurrent calls that all require a proactive refresh must complete under mock timers — this single test pins the bypass decision forever; (c) two *different* profiles refresh concurrently → two refresh requests (mutex is per-profile); same profile → exactly one.

**Doc ref.** ARCHITECTURE § 6.2, § 6.5; TESTING § core/oauth (single-flight bullet).

---

### F-8 — HIGH — stdout protocol purity is asserted nowhere

**Issue.** ARCHITECTURE § 2 declares "stdout is reserved for the MCP stdio protocol; all logging is stderr-only". No test enforces it. This is not hypothetical: `dotenv` ≥ 16.4 prints an advertising/tip line via `console.log` (stdout) unless suppressed — a widely reported breaker of stdio MCP servers — and this design has `dotenv` as a runtime dependency loaded at bootstrap.

**Defect that slips through.** A routine `dotenv` (or any dependency) upgrade starts printing one line to stdout; every stdio client fails to parse the stream; the server is bricked for all users while the entire test suite stays green.

**Recommendation.** Two cheap tests: (a) unit — import/execute the config-loading path with `process.stdout.write` instrumented; assert zero writes; (b) end-to-end smoke — spawn `build/index.js` with a scratch env, send an `initialize` JSON-RPC message over stdin, assert stdout contains *only* parseable JSON-RPC frames. Make (b) part of the blocking CI gate.

**Doc ref.** ARCHITECTURE § 2 (bootstrap), § 10; TESTING (absent).

---

### F-9 — MEDIUM — Envelope edge cases beyond `error.code !== "ok"` are unlisted

**Issue.** Only the canonical failure envelope is tested. Unlisted: HTTP 200 with a non-JSON body; body with `data` but **no `error` object** (must not be treated as success by accident of optional chaining); HTTP 4xx/5xx *with* a valid envelope (which field wins — status or `error.code`? The spec says envelope "regardless of HTTP status", so pin it); empty body; `error.code === "ok"` with HTTP 500 (conflict — define precedence); envelope with `error.code !== "ok"` *and* usable `data` (partial success). Also: `log_id` must survive into `TikTokError` for every path — currently only stated for the canonical case.

**Defect that slips through.** A TikTok edge (LB error page, truncated response) crashes the handler with a raw `TypeError: Cannot read properties of undefined` instead of a model-actionable `TikTokError`, losing the `log_id` TikTok support would need.

**Recommendation.** A table-driven envelope test: rows of (HTTP status, body) → expected (success | `TikTokError` with specific `apiCode`/`status`/`logId` | parse-error `TikTokError`). Include the `publicaly_available_post_id` *(sic)* field spelling as a pinned fixture so a silent TikTok fix doesn't break parsing (accept both spellings, test both).

**Doc ref.** TIKTOK-API § 1, § 4.5; ARCHITECTURE § 6.3; TESTING § core/http.

---

### F-10 — MEDIUM — Journal integrity is reduced to "the journal gains one entry"

**Issue.** Untested: journal append failure while the upstream post *succeeded* (must not convert a successful publish into a tool error — or if it should, that is a policy decision to make and pin); concurrent applies producing interleaved/corrupt NDJSON lines; a pre-existing corrupt line breaking subsequent appends or `doctor`; secret-freedom of the journal specifically (SECURITY promises "no tokens in the journal" — promise ⇒ test); file permissions (it contains `open_id`-adjacent data, profile names, publish ids — recommend `0600` like the env file, currently unspecified).

**Defect that slips through.** Two parallel applies interleave partial lines; the journal — the *audit trail the write-safety story rests on* — is silently unparseable exactly when someone needs it to answer "what did the model post?"

**Recommendation.** Tests: append is a single atomic `write` of one `\n`-terminated line (concurrency test with N parallel applies → N parseable lines); append failure → publish result still returns `publish_id` + a `journal_write_failed` warning in `hints`; redaction sweep over journal output; mode assertion (POSIX only, see F-25).

**Doc ref.** ARCHITECTURE § 8; SECURITY § Write safety; TESTING § mcp/*.

---

### F-11 — MEDIUM — Profile isolation (AsyncLocalStorage) has no planned tests

**Issue.** AUTH § 3 claims "parallel calls with different accounts cannot bleed into each other" — a claim about the trickiest concurrency primitive in Node — and the strategy never tests it. Also untested: unknown `account` value (must be a clean validation error, not a fall-through to the default profile), `TT_ACTIVE_PROFILE` pointing at a nonexistent profile, and refresh under profile A not touching profile B's persisted keys.

**Defect that slips through.** A `tools/` helper caches a module-level "current token" outside ALS; two interleaved calls (`account: "brand"` and default) post the brand video to the personal account. This is the single most embarrassing bug this server could have.

**Recommendation.** The bleed test: two concurrent tool calls with different `account` args against a deferred fetch mock; resolve them in *reverse* order; assert each recorded request carried its own profile's bearer. Run the same shape through a refresh-triggering path. Add: unknown account → validation error naming known profiles; per-profile env-file writes touch only that profile's keys (assert full file content).

**Doc ref.** AUTH § 3; ARCHITECTURE § 4, § 7; TESTING (absent).

---

### F-12 — MEDIUM — Truncation correctness is under-specified: surrogate pairs, validity, and ordering with redaction

**Issue.** "Over-budget payload → `truncated` marker, valid JSON" is listed, but the halving loop operates on characters; TikTok titles/descriptions are emoji-heavy (astral-plane characters = UTF-16 surrogate *pairs*). Cutting between surrogates yields an unpaired surrogate — `JSON.stringify` will emit it, some JSON parsers and the MCP transport layer may reject or mangle it. Also unstated: does truncation run **after** redaction (it must — truncating first could slice a token into a fragment the redactor no longer recognizes)? And the title-length validation (≤ 2 200 *UTF-16* chars) needs the same code-unit-semantics test.

**Defect that slips through.** A result containing "🎬🎬🎬…" truncates mid-pair; the client's JSON parse fails; the model sees a transport error instead of a truncated result — for precisely the large, real-world payloads truncation exists to save.

**Recommendation.** Property tests (fast-check): for arbitrary JSON-serializable payloads (generator biased toward astral chars and long strings) — output parses as JSON; output length ≤ budget; `truncated` marker present iff content was dropped; no unpaired surrogates (`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/` never matches); a seeded fake token never appears in truncated output (pins the redact-then-truncate order). Title validation: `"🎬".repeat(1100)` = exactly 2 200 code units → accepted; +1 → rejected locally.

**Doc ref.** ARCHITECTURE § 9; TIKTOK-API § 6; TESTING § mcp/*.

---

### F-13 — MEDIUM — Manifest snapshot is environment-dependent as designed (scope markers), and its required depth is unstated

**Issue.** TOOLS § Cross-cutting: tools with missing scopes register with a `[UNAVAILABLE: …]` description prefix. Tool descriptions therefore depend on the ambient credential state — but the manifest snapshot test compares `describeAllTools()` to a fixture. On a CI machine (no scopes) vs. a dev machine (full scopes) the outputs differ: the snapshot is nondeterministic by construction. Additionally the fixture's required content is unspecified — a snapshot that omits annotations, `.describe()` texts, or the auto-injected `account` parameter will silently miss exactly the changes it exists to catch.

**Defect that slips through.** Snapshot passes in CI, fails locally (or vice versa); the team "fixes" it by regenerating blindly, and the gate stops gating. Separately, an annotation flip (`readOnlyHint` dropped from a publish tool) sails through an under-specified snapshot.

**Recommendation.** Snapshot must be computed under `baselineEnv()` with **all scopes granted** (pin this in helpers); a *separate* test covers marker injection (seed a scopes-subset env → assert the prefix appears on exactly the right tools, and that calling one still returns a clean scope error). Fixture must include, per tool: name, title, full description, package, all four annotations, and the full input schema shape including the injected `account` param (plus a test that a spec defining its own `account` is not double-injected).

**Doc ref.** TESTING § mcp/*; TOOLS § Cross-cutting; ARCHITECTURE § 5.

---

### F-14 — MEDIUM — Coverage gate: global-only thresholds, no ratchet policy, no per-area floors, no blocking-vs-advisory split

**Issue.** `lines ≥ 90, branches ≥ 80, functions ≥ 95` are sane numbers, but: (1) they are **global** — a 100 %-covered `tools/` layer arithmetically hides an untested `core/oauth` branch, and the risk lives almost entirely in `core/http` + `core/oauth` branch coverage; (2) "raised as the suite matures" is not a policy — nothing prevents lowering; (3) coverage is measured on `build/` output — the strategy must state that c8 source-map remapping is configured and that helpers/fixtures are excluded, or the numbers are noise; (4) nowhere does TESTING.md say what **blocks** CI versus what is advisory.

**Defect that slips through.** The 429-for-publish-init branch (the "never retry" arm) is never executed by any test; global lines sit comfortably at 92 %; the gate is green; the one behavior that prevents duplicate posts under rate-limiting ships unverified.

**Recommendation.** (a) Add per-area floors via `c8 --per-file` or a second c8 invocation scoped to `build/core/**` with branches ≥ 90. (b) State the ratchet rule: thresholds may only rise; raise within 2 points of actuals at each minor release. (c) Document the c8 config (source maps on, `test/` + `build/**/*.map` handling, exclude list). (d) Add a "CI gates" section: **blocking** = lint, typecheck, build, unit tests, coverage thresholds, manifest snapshot, sync gates, stdout-purity smoke (F-8), ancient-Node launcher probe, `npm audit` at high+; **advisory** = Codecov upload/PR deltas, mutation testing if ever added, any live-network job.

**Doc ref.** TESTING (header + absent CI section); ROADMAP Phase 0/3.

---

### F-15 — MEDIUM — The manual sandbox checklist is too thin to be the only integration layer

**Issue.** TIKTOK-API.md is honest that many load-bearing facts carry *(verify at implementation time)* markers: exact chunk rules, final-chunk tolerance, `publicaly_available_post_id` spelling, loopback-HTTP redirect acceptance, photo FILE_UPLOAD existence, size caps. Mock-only CI **encodes the design's assumptions and then tests the code against its own assumptions** — a closed loop. The manual checklist (happy-path login/post/draft/poll) neither converts those verify-markers into checks nor covers live negatives, and nothing captures real responses for future regression use.

**Defect that slips through.** TikTok's real init response shape differs subtly from `ttEnvelope`-based fixtures (an extra required field, different chunk-count validation); every unit test passes; the first real `apply: true` in Phase 2 fails in a way no test ever modeled — or worse, half-works.

**Recommendation.** (a) During Phase 1/2 sandbox runs, **record sanitized real responses** (token exchange, user/info, video/list page pair, creator_info, init, status sequence incl. a FAILED one) into `test/fixtures/recorded/` and replay them in CI as contract tests — this turns the one-time manual effort into a permanent regression net. (b) Extend the checklist with live negatives: 7th init in a minute (verify the local bucket engages before TikTok 429s), non-`SELF_ONLY` privacy on an unaudited app (expect upstream rejection + the documented explanation), expired `upload_url` (wait > 1 h), status poll after the retention window. (c) Track every *(verify)* marker as a checklist line item whose completion updates both TIKTOK-API.md and the corresponding fixture. (d) Optional but cheap: a manually-triggered `live-smoke.yml` workflow (secrets-gated, never scheduled, never blocking) so re-verification after TikTok platform changes is one click.

**Doc ref.** TESTING § Integration; TIKTOK-API (verify markers throughout); ROADMAP Phase 1/2 exit gates.

---

### F-16 — MEDIUM — Stale-build false greens: `npm test` runs against `build/` without rebuilding

**Issue.** Tests import compiled output; `npm test` does not chain the build (`test:full` does). Editing `src/`, running `npm test`, and seeing green against *yesterday's* build is a daily workflow hazard the sibling project explicitly flags as a caution ("you must build before testing").

**Defect that slips through.** A developer "verifies" a fix that was never compiled; CI later fails — or worse, CI's cached build also predates the change in a misconfigured workflow, and the fix ships untested.

**Recommendation.** Add a build-freshness guard as test file #1: newest `mtime` under `src/` must not exceed newest under `build/`, else fail with "run npm run build". (Alternatively make `npm test` chain `tsc` — slower but safer; pick one and document it.) CI must always run `test:full` semantics.

**Doc ref.** TESTING (header); sibling caution § 8.

---

### F-17 — MEDIUM — Token-bucket behavior is ambiguous ("delayed/rejected"), making its own listed test unwritable

**Issue.** TESTING § core/http: "7th init within a minute is **delayed/rejected** locally". Delay and reject are opposite UX contracts (a delayed init can silently hold a tool call for up to 60 s; a rejection returns a wait hint the model can act on). A test cannot assert an undecided behavior. Also missing: the bucket is per **profile** — cross-profile independence needs a test — and the window semantics (fixed vs. sliding) are unstated.

**Defect that slips through.** Implementer picks "delay"; a batch of 7 queued posts wedges an MCP tool call for a minute with no feedback; alternatively implementer picks "reject" but the error lacks the wait-seconds hint TOOLS promises.

**Recommendation.** Decide: **reject with a structured wait hint** (consistent with the "429 surfaced to the model with wait guidance" row and with MCP call-latency expectations). Tests under mock timers: 6 inits pass, 7th rejects with `retry_after_s` ≈ remaining window; after advancing the clock, it passes; property test — for arbitrary call timestamps, no 60 s sliding window ever contains > 6 *forwarded* inits; profile A exhausting its bucket leaves profile B unaffected.

**Doc ref.** TESTING § core/http; ARCHITECTURE § 6.5; CONFIGURATION `TT_PUBLISH_RPM`.

---

### F-18 — MEDIUM — `fetch_all` has no cursor-loop guard test (or design)

**Issue.** Pagination tests cover passthrough, cap, and `truncated`. Nothing covers a hostile/buggy upstream returning `has_more: true` with a **repeating cursor** (or `cursor: 0`) — the classic infinite-pagination bug. The item cap bounds total items, but only if the cap check is reached; a page of 0 items with `has_more: true` and an unchanged cursor can loop forever without accumulating items.

**Defect that slips through.** One malformed TikTok page response pins the server at 100 % CPU inside a read-only tool — in stdio mode, a hung client.

**Recommendation.** Specify a loop guard (stop when the cursor does not advance, or hard-cap page *count* at `ceil(cap / min_page_size)`), then tests: repeated cursor → terminates with `truncated: true` + a warning; empty page + `has_more` → terminates. Property test: for arbitrary (finite or adversarially cyclic) page sequences, `fetch_all` terminates within the page bound, never exceeds the item cap, and sets `truncated` correctly.

**Doc ref.** ARCHITECTURE § 9; TESTING § api/*; TOOLS `tiktok_list_videos`.

---

### F-19 — MEDIUM — HTTP transport (Streamable HTTP) has no planned tests, including a known `timingSafeEqual` crash class

**Issue.** No tests listed for: missing/wrong bearer → 401; non-loopback bind without `TT_HTTP_TOKEN` refusing to start; session-id issuance. Specific trap: `crypto.timingSafeEqual` **throws `RangeError` on unequal buffer lengths** — a naive implementation crashes (or 500s) on any wrong-length token, which is both a DoS vector and a length oracle.

**Defect that slips through.** `curl -H "Authorization: Bearer x"` (1-byte token) takes down or errors the transport instead of returning a clean 401.

**Recommendation.** Spin the HTTP transport on port 0 in tests: correct token → 200-class; wrong same-length token → 401; wrong-**length** token → 401 (this single case pins the length-guard/HMAC-compare fix); no header → 401; `TT_HTTP_HOST=0.0.0.0` without token → startup refusal with a clear message. Keep stdio as an e2e spawn test (shared with F-8b).

**Doc ref.** ARCHITECTURE § 3; SECURITY § Transport; TESTING (absent).

---

### F-20 — MEDIUM — The input-validation negative matrix for write tools is mostly unenumerated

**Issue.** `.strict()` unknown-key rejection is the only schema negative listed. The write tools have conditional/cross-field rules that zod `.strict()` alone does not give: `source="file"` requires `file_path` and must reject a *also*-present `video_url` (and vice versa); `privacy_level` required **only on apply**; `privacy_level` supplied on a photo `draft` post (invalid combination per TOOLS); `cover_index` ≥ `photo_urls.length`; `photo_urls` length 0 and 36; interaction toggles that must be **forced true** when creator_info reports them disabled (an override attempt must not win); `wait_for_completion` with `apply: false` (define: ignored with a note, or rejected).

**Defect that slips through.** A call with both `file_path` and `video_url` posts the wrong source; a `disable_duet: false` override on a duet-disabled creator produces an upstream `invalid_params` the model can't interpret — both were locally detectable.

**Recommendation.** A table-driven validation matrix per write tool: (args, expected error substring | expected forced value), each negative asserting **no fetch occurred**. Include the forced-toggle case as a plan-preview assertion (preview shows `disable_duet: true (forced: creator setting)`).

**Doc ref.** TOOLS § publish tools + Cross-cutting; TESTING § mcp/*, § tools/*.

---

### F-21 — LOW — Media-validation fixtures: one 64 KB happy MP4 is not a fixture strategy

**Issue.** `tiny.mp4` covers only "valid, single-chunk". Missing: corrupt container (renamed `.txt`), zero-byte file, directory path, nonexistent path, named pipe / non-regular file, a file over the size cap, and — critically — any multi-chunk-sized input (nothing between 64 KB and 5 MB+ exists in fixtures; committing 64 MB binaries is a non-starter).

**Recommendation.** Generate synthetic files at test time in the scratch dir with a seeded PRNG (deterministic bytes → byte-range assertions possible, see Deep dive § 6.1); commit only tiny negative fixtures (a 1 KB fake-MP4 with a valid `ftyp` box, a corrupt one). Add a TOCTOU note: the file is re-stat'ed at apply time (plan-time validation may be stale) — one test where the file changes size between plan and apply.

**Doc ref.** TESTING § Layout; TOOLS § Cross-cutting ("validation before network").

---

### F-22 — LOW — Error-taxonomy and `fail_reason` mappings are promised but not test-listed

**Issue.** ARCHITECTURE § 11 promises the model can distinguish five recovery classes; TOOLS promises "descriptions map every `fail_reason` to a recovery hint". Neither has a corresponding test entry. These mappings are pure data → the cheapest possible table-driven tests, and the most model-visible behavior in the product.

**Recommendation.** One table test: each known `apiCode` (`access_token_invalid`, `scope_not_authorized`, `rate_limit_exceeded`, `spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`, `reached_active_user_cap`, `invalid_params`) → asserted recovery-action substring in the tool error. Same for every documented `fail_reason` and for the status vocabulary (unknown status value → generic-but-safe handling, not a crash — TikTok adds statuses).

**Doc ref.** ARCHITECTURE § 11; TOOLS `tiktok_get_publish_status`; TIKTOK-API § 1, § 4.5.

---

### F-23 — LOW — Redaction tests need depth: placement, over-redaction, idempotence

**Issue.** "Seeded tokens come out scrubbed" is the right start. Unlisted: tokens inside nested error `detail` / URL query strings / the client log-mirror path / the journal (F-10); **over-redaction** (a legitimate title that merely *looks* bearer-shaped must survive — otherwise user content is corrupted); idempotence (`redact(redact(x)) === redact(x)`); interaction with truncation ordering (F-12).

**Recommendation.** Property test: for arbitrary payload shapes with secrets injected at arbitrary depths (keys and values), serialized output contains no secret substring; plus one explicit over-redaction case; plus the log-mirror path (capture what `logging` capability would send).

**Doc ref.** ARCHITECTURE § 10; SECURITY § Secrets; TESTING § mcp/*.

---

### F-24 — LOW — Sync-gate set is missing `server.json`

**Issue.** CONFIGURATION.md ends by describing a generated `server.json` with `isSecret`/`isRequired` flags; the sibling keeps it honest with `gen:manifest`. TESTING lists only `readme-sync` and `env-docs-sync`. An out-of-date registry manifest ships wrong metadata to the MCP registry (e.g. a new secret env var not flagged `isSecret`).

**Recommendation.** Add a `serverjson-sync` gate: regenerate in-memory from the same settings table that feeds `.env.example` and deep-compare with the committed file. While here: the README **quickstart env block** and the tool *table* are both README content — confirm `readme-sync` covers the table *generation boundary markers*, and pin that in the test.

**Doc ref.** CONFIGURATION (final paragraph); TESTING § Sync gates.

---

### F-25 — LOW — Cross-platform and parallel-execution test hygiene is unstated

**Issue.** Phase 3 CI adds Windows and macOS legs. Three predictable breakages: (1) `chmod 0600` assertions are meaningless on Windows (mode reads back differently) — the listed "0600 mode asserted" test will fail there unless platform-gated; (2) `node --test` runs test *files* concurrently in separate processes — any test touching the real `~/.config/tiktok-mcp-ai/` path, or binding the fixed `TT_REDIRECT_PORT` 43110, will collide across files; (3) XDG conventions don't map 1:1 to Windows (`%APPDATA%`) — path-resolution tests need both branches.

**Recommendation.** Mandate in TESTING.md: every test runs with `TT_ENV_FILE` (or an overridden config home) pointing into a per-test scratch directory — the suite must never read or write the real user config; permission assertions are `process.platform !== "win32"`-gated with a Windows-specific fallback assertion (file exists, content correct); all listeners bind port 0 with the port injected. Add one Windows path-resolution test before the Windows CI leg lands, not after it goes red.

**Doc ref.** TESTING § core/config, § Layout; ROADMAP Phase 3; AUTH § 1.

---

## 5. Additional test cases the strategy must include

Organized by the same areas as TESTING.md; items marked **(P)** are property-based (fast-check) candidates.

### core/oauth
1. Refresh succeeds, env-file persist **fails** → in-memory token still serves; warning logged; next write retries persistence (F-3).
2. Two credential stores sharing one scratch env file: A refreshes (rotation), B's next refresh gets `invalid_grant` → B re-reads the file once before declaring terminal failure (F-3).
3. Refresh failure during single-flight: both concurrent waiters receive the same terminal error; exactly one refresh HTTP call was made.
4. Two **different** profiles refresh concurrently → two refresh calls (per-profile mutex independence).
5. 401 replay on a **non**-idempotent path → no replay, uncertainty-worded error (cross-check with F-2 table).
6. `TT_TOKEN_EXPIRES_AT` unparseable/absent → treated as expired (proactive refresh attempted), not a crash.
7. Deadlock canary: 4+ concurrent calls all needing proactive refresh, semaphore limit 4, mock timers → all complete (F-7).

### core/http & host guard
8. Envelope decision table (F-9), including missing `error` object, non-JSON 200, 5xx-with-envelope precedence, empty body.
9. Retry matrix per **allowlisted path**: each read POST retried on 5xx; a path *not* on the allowlist is not retried even as POST (safe-default check for future endpoints).
10. `Retry-After: 3600` → capped at 60 s (mock timers assert the actual delay).
11. Backoff bounds **(P)**: for arbitrary attempt counts, delay ∈ [base, 8000 + jitter-max]; monotone cap.
12. Timeout actually aborts: never-resolving fetch + `TT_TIMEOUT_MS` → AbortSignal fired, `TikTokError` names the timeout.
13. Host-guard negative suite incl. `eviltiktokapis.com`, `open.tiktokapis.com.attacker.io`, userinfo, IPv6/private literals, trailing dot, uppercase, explicit port — each asserting fetch not called (F-6).
14. Host-guard acceptance **(P)**: any accepted URL's host is exactly in the allowset under dot-anchored matching.
15. Semaphore: ≤ 4 in flight with 5 pending; slot released on both success and failure paths.
16. Token bucket (F-17): 6 pass / 7th rejects with wait hint; window slide under mock timers; per-profile independence; sliding-window property **(P)**.

### core/upload (new area — currently absent)
17. Multi-chunk happy path with a generated 12 MB seeded-PRNG file: N PUTs, each `Content-Range` correct, **concatenated recorded bodies byte-equal the source file**.
18. PUT #2 of 3 fails (ECONNRESET / 5xx / timeout): no further PUTs; error carries `publish_id` + failed-chunk info + poll hint; journal outcome recorded (F-1).
19. Upload PUT header hygiene: no `Authorization` bearer sent to the upload host (or exactly the headers the verified TikTok contract requires — pin whichever is decided).
20. `upload_url` expiry: mock clock advanced past 1 h mid-upload → upstream 403 mapped to an actionable "upload window expired, re-run" error (F-1).
21. Boundary sizes as *execution* tests, not just planning: 5 MB exactly, 64 MB, 64 MB + 1, < 5 MB single-chunk (final-chunk-tolerance rule pinned once verified).
22. `total_chunk_count`/`chunk_size`/`video_size` internal consistency in the init body **(P)** — matches the chunk plan for arbitrary sizes.

### core/config
23. Env-file round-trip **(P)**: arbitrary files (comments, blank lines, `=` in values, quoting) → update one key → all other lines and comments byte-preserved; mode 0600 (POSIX-gated).
24. Malformed line in an existing env file → load succeeds with a warning, write preserves the line verbatim.
25. Profile parsing edge: profile with access token but no refresh token → usable until expiry, then terminal error advising login (no refresh attempt with `undefined`).
26. Precedence: process env beats file for the same key (`override: false` pinned by test).

### api/* (pagination & fields)
27. Cursor-loop guard: repeated cursor / zero-item page with `has_more` → terminates, `truncated: true`, warning (F-18).
28. `fetch_all` termination **(P)**: arbitrary page sequences incl. cycles → terminates within page bound, cap respected, `truncated` correct, no duplicate items when cursors advance.
29. `tiktok_query_videos` with 21 ids → local validation error, no fetch; 20 ids → single request.
30. User-info field filtering: field outside granted scopes → dropped + noted in result; *all* fields outside scopes → clean result with note, not an upstream error.

### mcp/* (result, redact, journal, registry)
31. Truncation validity **(P)**: valid JSON out, ≤ budget, marker iff dropped, no unpaired surrogates, redact-before-truncate pinned (F-12).
32. Journal concurrency: N parallel applies → N parseable NDJSON lines; append failure does not fail the publish; journal never contains secrets (F-10).
33. Snapshot determinism: computed under full-scopes `baselineEnv`; separate scope-marker test (F-13); `account` param present in snapshot; no double-injection.
34. Registry policy matrix: unknown package name in `TT_TOOL_PACKAGES` (decide: warn vs. error — then pin); `TT_PACKAGES_DENY` beats profile; `TT_PACKAGES_READONLY=1` × `TT_WRITE_MODE=apply` → writes still absent (deny-wins pinned).
35. Redaction depth/over-redaction/idempotence **(P)** (F-23).
36. Plan/apply registry-wide sweep: for **every** write tool in the manifest, invoking without `apply` performs no init/upload calls (see Deep dive § 6.3) — table-driven from `PACKAGES` so future tools inherit the gate.
37. Preview/apply payload equality: the `post_info`/`source_info` shown in plan deep-equals what apply sends (Deep dive § 6.3).

### tools/*
38. Validation matrix per write tool (F-20): source/file/url mutual exclusivity; privacy-on-apply-only; privacy-on-photo-draft rejection; `cover_index` bounds; forced interaction toggles shown in preview.
39. Poll loop under mock timers: terminal on first poll; terminal on last-before-timeout; timeout while request in flight with late terminal (winner pinned, F-5); `FAILED` + every documented `fail_reason` → recovery hint (F-22); unknown status value → safe handling; status-retention-window expiry error mapped.
40. `tiktok_auth_status` with `probe: false` → fetch not called; with `probe: true` → exactly one `user/info` call; output never contains token material (redaction sweep on this tool specifically).
41. `wait_for_completion` result when polling fails after successful init → `publish_id` still returned (TOOLS promise ⇒ test).

### cli & transport (new areas — currently absent)
42. `login` suite (F-4): success round-trip, state mismatch, `error=access_denied`, port busy, callback timeout, partial scope grant, `--revoke`, manual-paste fallback path.
43. `doctor` exit-code matrix with mocked probe; telemetry counters appear in output.
44. stdout purity: config-load unit test + spawned-server JSON-RPC frame test (F-8).
45. HTTP transport: bearer 401 matrix incl. wrong-length token; non-loopback-without-token startup refusal; session id issuance (F-19).
46. Node-version-guard launcher probe (ancient Node prints the clear message) — CI job, as in the sibling.

### CI meta
47. Build-freshness guard (F-16).
48. `serverjson-sync` gate (F-24).
49. Per-area coverage floor for `build/core/**` (F-14).

## 6. Deep dive

### 6.1 Simulating chunked uploads faithfully — what `withFetch` can and cannot give you

`withFetch` swaps `globalThis.fetch` for a recording mock. For JSON request/response cycles that is fully faithful. For chunked PUT uploads, four fidelity gaps matter, and the harness must be designed around them:

1. **Request bodies may be streams.** If the implementation feeds `fs.createReadStream` (or a `Blob` slice) into fetch, the mock receives a stream/duplex body, not a string. A recording mock that calls `String(body)` will record `[object ReadableStream]` and every byte-level assertion silently degrades to nothing. The helper must detect and **fully consume** stream bodies into a `Buffer` before recording. Then the single most valuable upload assertion becomes possible: *concatenating the recorded PUT bodies in order is byte-identical to the source file* (with seeded-PRNG generated files, § 5 #17, this is cheap and total — it catches off-by-one slicing, overlapping ranges, and re-read bugs in one assertion).

2. **What the mock cannot simulate must be pinned by contract tests instead.** Real chunk PUT behavior — TikTok's actual per-chunk status codes (the docs suggest partial-content-style responses for intermediate chunks; a *(verify)* item), TCP resets mid-body, backpressure — cannot be produced by a fetch mock. The strategy's answer must be two-layered: (a) unit tests encode the *decided* contract (e.g. "a non-2xx PUT response aborts the upload with publish_id attached"); (b) the Phase-2 sandbox run **records** the real per-chunk response codes into fixtures (F-15), after which the unit contract is re-checked against reality once and pinned forever. Without step (b), the upload tests verify the design's guess about TikTok, not TikTok.

3. **Failure injection needs to be scriptable per call, not per test.** The natural extension of `withFetch` is a scripted dispatcher: an ordered list of matchers → responses/errors, e.g. `[initOk, putOk, reject(new TypeError("fetch failed")), …]`, with an assertion that the script was fully consumed (or deliberately not — "no further PUTs after failure" is itself asserted by *unconsumed* script entries). This turns every F-1 scenario into a three-line test and keeps interleaving explicit.

4. **Header hygiene is an upload-specific assertion.** The upload PUT goes to a *different host* than the API. The recorded request must be asserted for what it does **not** contain: the user's bearer token (unless the verified contract requires it), and any `TT_*`-derived values. A pre-signed URL plus a leaked bearer header is how token exfiltration bugs ship. This assertion costs one line and belongs in every upload test, not a dedicated one.

Finally, time: the `upload_url` 1-hour validity interacts with multi-chunk uploads of large files. Under mock timers, advance the clock past the window between chunk N and N+1 and pin the error mapping (§ 5 #20). Without a controllable clock this scenario is untestable — which is exactly why F-5 is a High.

### 6.2 Race-testing single-flight refresh without flakes

Races are only testable when the test controls the interleaving. The pattern that makes every F-3/F-7/F-11 scenario deterministic on `node:test` is **deferred-resolution mocks + explicit sequencing**, not `Promise.all` and hope:

- Build a `deferred()` helper (exposed `{ promise, resolve, reject }`). The scripted fetch dispatcher (§ 6.1.3) returns `deferred.promise` for the refresh call. Now the test — not the scheduler — decides when the refresh "completes".
- **Single-flight proof**: fire two tool calls; both reach the point of needing a refresh; assert the mock recorded exactly **one** token-endpoint request *while the deferred is still pending* (this is the actual single-flight claim — counting requests after everything settles can pass even with a race, because the second refresh may reuse the first's freshly-written token). Then resolve, await both calls, assert both used the new token.
- **Rotation-persistence race**: resolve the refresh deferred, but make the env-file writer fail (inject via a settings/fs seam — the design's "one documented function per knob" in `core/settings.ts` should extend to an injectable persistence sink for exactly this reason). Assert the in-memory snapshot rotated, the tool call succeeded, and a warning was logged (F-3a).
- **Interleaved-profile proof (ALS bleed)**: two calls with different `account` values, each blocked on its own deferred fetch; resolve them in *reverse arrival order*; assert each recorded request carried its own profile's token. Reverse-order resolution is the key — same-order resolution passes even with a module-level "current profile" variable, which is precisely the bug being hunted.
- **Deadlock canary**: set `TT_MAX_CONCURRENT=4`, issue 5 calls that all need a proactive refresh, resolve the refresh, assert all 5 complete within the mock-timer horizon. Wrap in a real-time watchdog (`AbortSignal.timeout(2000)`) so a deadlock fails fast with a named assertion instead of hanging CI for the runner's global timeout.

One structural rule makes all of this reliable: tests that swap `globalThis.fetch` or mutate env **must not run concurrently within a process**. `node --test` gives per-file process isolation for free; *within* a file, keep `withFetch`-scoped subtests sequential (the default) and document that `concurrency: true` is forbidden for suites using global swaps. That sentence belongs in TESTING.md § helpers.

### 6.3 The plan/apply boundary as a machine-checked invariant, not a per-tool test

Plan-and-apply is the product's core safety promise, and the strategy currently tests it as N hand-written per-tool cases. Two upgrades make the promise structural:

1. **Registry-wide sweep.** Iterate the `PACKAGES` manifest; for every tool *without* `readOnlyHint`, synthesize a minimal valid argument set (a per-tool fixture map keyed by tool name — the test **fails if a write tool has no fixture**, which is the enforcement hook), invoke without `apply`, and assert the scripted fetch saw only allowlisted read paths (`creator_info/query` and nothing else — specifically: no `/init/` path, no PUT). Because the sweep is driven by the same manifest that drives registration, a future `tiktok_delete_video` tool added in Phase 4 is *born* covered: forgetting the fixture fails CI, and no individual developer has to remember the plan-mode test. This converts "each write tool has a plan test" (a convention) into "no write tool can exist without one" (an invariant).

2. **What-you-preview-is-what-you-post.** The preview's value is that the human confirms *the exact post*. That is only true if the previewed payload and the applied payload are generated by one code path. Pin it: run the same arguments in plan mode, capture the previewed `post_info`/`source_info`; run in apply mode against the scripted mock; deep-equal the preview against the recorded init request body (modulo an explicitly whitelisted delta — e.g. nothing, ideally). This test fails the moment someone "fixes" a bug in the apply path without updating the preview builder — the exact divergence that silently turns the human checkpoint into theater. Add one adversarial variant: creator_info returns `duet_disabled: true`, the caller passes `disable_duet: false`, and both the preview *and* the applied body must show `disable_duet: true` with the forced-value annotation in the preview (F-20).

3. **The mode matrix is small — enumerate it exhaustively.** `TT_WRITE_MODE ∈ {plan, apply, deny}` × `apply ∈ {absent, false, true}` × `TT_PACKAGES_READONLY ∈ {0,1}` is 18 cells. Encode it as one table test asserting, per cell: registered? init called? preview returned? journal written? Deny-wins ordering (`deny` and `READONLY=1` beat everything) is then pinned in a form a reviewer can read in ten seconds, and a future config knob has an obvious place to extend the table. Ambiguities the table will force out now, at design time: does `apply: false` explicitly passed under `TT_WRITE_MODE=apply` mean "preview" (it must — pin it), and is `apply: true` under `plan` mode sufficient (per the docs, yes — pin it).

---

*End of review. Verdict: **Approve with changes** — revise `docs/TESTING.md` per findings F-1…F-8 and § 5 before the Phase 0 exit gate; publishing-related items (F-1, F-2, F-15, F-17, upload area) must be green before the Phase 2 exit gate.*
