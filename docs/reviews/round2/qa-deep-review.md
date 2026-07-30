# Round-2 Deep Review — Principal QA Engineer / Test Architect

## 1. Reviewer & scope

- **Role**: Principal QA engineer / test architect. Round-2 pass over the full design
  corpus **plus all six round-1 reviews**.
- **Date**: 2026-07-22.
- **Inputs**: `README.md`, all 8 docs in `docs/`, and `docs/reviews/{qa,security,
  architecture,ai-dx,devops-release,tiktok-platform}-review.md`.
- **Relationship to round 1**: `docs/reviews/qa-review.md` (referenced below as **R1**,
  findings **R1 F-1…F-25**, deep dives **R1 §6**) remains valid. This document does not
  restate it; it (a) cross-examines the *other* reviewers' proposals for testability,
  (b) resolves the spec ambiguities R1 flagged as blocking, (c) issues the **definitive
  test specification** — 166 cases superseding and reorganizing R1's 49, (d) fixes the
  four harness designs, and (e) proposes the CI quality gates and the concrete spec edits.
- **Reference shorthands**: `sec-Fn` = security review finding n, `arch-n` = architecture
  review finding n, `aidx-Fn` = AI/DX review, `devops-Fn` = DevOps review, `plat-Fn` =
  TikTok platform review, `DT-n` = decision table in § 3, and three-letter IDs
  (`OAU-07` etc.) = test cases in § 4.

Verdict on the round-1 corpus as a whole: the six reviews are **mutually consistent** on
every load-bearing mechanism (plan token, file locking, chunk retries, redaction
placement, journal semantics) — no reviewer's proposal makes another's untestable. Two
genuine conflicts need a decision, listed in § 7.

## 2. Cross-examination

For each other role's major proposal: verdict on its testability claim, the new test
surface it creates (with case IDs from § 4), and what becomes untestable if adopted
sloppily.

### 2.1 Security review

**sec-F1 — redaction primitive in `core/` — CONFIRM.**
Test surface: `RED-01…10`, plus the compiled-build e2e `RED-06` (seed a token into a
`core/oauth` error path, assert the stderr line is scrubbed). Sloppy-adoption risk: if
redaction stays in `mcp/` and core merely "avoids logging secrets by convention", core
error paths are unfalsifiable — there is no seam to assert on. The core primitive gives
one function to property-test (`RED-10`).

**sec-F2 — add authorization `code` + callback URL to scrub set — CONFIRM.** Folded into
`RED-01`; trivial extension of the scrub table.

**sec-F3 — `TT_MEDIA_ROOT` + symlink-escape rejection — CONFIRM, one REFINE.**
Surface: `CFG-13/14`, `TLS-16`. The symlink-escape case requires *real* symlinks in an
fs sandbox; on Windows symlink creation needs elevation, so that specific case must be
POSIX-gated **with a named skip reason** (per devops-F1 discipline), while the
realpath-containment and prefix-collision cases (`/media` vs `/media-evil`) run
everywhere. REFINE: the spec must state canonicalization = `fs.realpath` of *both* root
and candidate before prefix comparison, else the test has nothing exact to pin.

**sec-F4 — plan confirmation token bound to payload hash — CONFIRM, one REFINE.**
This is the single largest new test surface of round 2: `WRM-03…10` plus `DT-5`. It
*requires* the injectable clock (§ 5a) for TTL cases — with real timers, the expiry test
is a 10-minute sleep. REFINE (blocking for testability): the spec must pin the
**canonicalization rule** for the args hash (JSON with lexicographically sorted keys,
`undefined`/absent treated identically, no whitespace). Without it, `WRM-06/07`
(hash-equality property tests) cannot be written, and implementations will disagree
with the tests on semantically-equal payloads.

**sec-F5 — Origin/Host validation on the loopback server — CONFIRM.** `CLI-03`.
Unit-testable with raw `http.request` against the login server bound to port 0 — no
browser, no DNS. Cheap and deterministic.

**sec-F7 — temp file `O_EXCL` 0600, dir 0700, fsync+rename — CONFIRM, one REFUTE-part.**
`CFG-05/06/07`, `JRN-06`. The `O_EXCL` claim is directly testable (pre-create the temp
path; the writer must fail, not truncate). The **fsync** call is *not* observably
testable through the public API without an injected fs seam; either add the seam or
accept fsync as unasserted and say so in TESTING.md — do not write a test that merely
spies on `fs.fsync` being called via monkey-patching the module the code under test
imports, because tests run against compiled `build/` where that patching is unreliable.

**sec-F8 — upload_url registrable-domain match + port 443 + resolve-and-pin IP —
CONFIRM the first two, REFUTE resolve-and-pin for v1.**
Domain allowlist + scheme + port + userinfo checks: `UPL-16`, `HTP-09/10/11`, `DT-3` —
pure functions, fully testable. DNS resolve-and-pin, however, requires injecting a
custom `lookup`/`Agent` into `fetch` (undici dispatcher surgery), adds a live-DNS flake
class to CI, and defends against a TOCTOU only exploitable by an attacker who already
controls DNS answers for `*.tiktokapis.com`. Recommend: defer with an explicit
SECURITY.md note; keep the testable checks. If adopted anyway, it needs a `lookup` seam
in `core/http` specified now.

**sec-F14 — compare sha256 digests instead of raw `timingSafeEqual` — CONFIRM.**
Kills the length-mismatch `RangeError` crash class R1 F-19 found. `CLI-02` pins both
the mismatch-no-crash and the constant-length property.

**sec-F15 — journal rotation + purge on revoke — CONFIRM rotation, REFINE purge.**
Rotation: `JRN-05`. Purge-on-revoke destroys the audit trail the journal exists for and
conflicts with arch-2's duplicate guard (which reads recent journal history). If purge
is kept, it must be an explicit flag (`login --revoke --purge-journal`), and `JRN`
tests need a purge case; recommend default = keep.

**sec-F18 — `crypto.randomBytes ≥ 32`, base64url for state/verifier — CONFIRM.**
`OAU-03`. Test asserts length, charset, and uniqueness across calls — *not* entropy
(untestable); TESTING.md should say so to prevent a pseudo-scientific entropy test.

### 2.2 Architecture review

**arch-1 — cross-process advisory file lock around read-refresh-persist (+ devops-F8,
same proposal) — CONFIRM, with a mandatory two-seam harness REFINE.**
This is the proposal most at risk of becoming untestable if adopted sloppily. If the
lock is inlined into the refresh path with no seam, *every* lock behavior (waiting,
staleness, re-read-after-acquire, invalid_grant-once-retry) needs a real multi-process
test — slow, racy, unportable. Specify **both** layers now:
1. `core/lockfile.ts` exposing `withLock(path, fn, {timeoutMs, staleMs, clock})` —
   unit-tested single-process (`OAU-12/13/14/15`) with the fs sandbox and manual clock
   (staleness = clock arithmetic, contention = pre-created lock file).
2. Exactly **one** real child-process contention scenario (`OAU-16`, harness § 5c)
   proving the composition end-to-end: N processes, one refresh, rotated token wins.
Also CONFIRM read-merge-write (`CFG-08`) — snapshot-dump would make `OAU-13`
("skip refresh if already rotated") impossible to pass.

**arch-2 — journal-backed duplicate guard (title-hash window, `force:true`) — CONFIRM,
two REFINEs.** `JRN-10`. (a) The window needs the injectable clock. (b) The guard must
read a **bounded tail** of the journal (spec: last N bytes / M rows), else it is O(file)
and its interaction with rotation (`JRN-05`) is undefined — the test suite must include
the rotated-journal case (guard still sees entries in `.1`? Decision: no — window is
bounded by the active file; document it). Title hash must reuse the sec-F4/WRM
canonicalization so there is one hashing function to test, not two.

**arch-3 — apply path re-runs creator_info — CONFIRM.** Covered inside `WRM-11`
(recorder proves the apply-path call sequence) and `TLS-03` (live options in errors).

**arch-4 — retry matrix split: reads / inits / chunk PUTs; per-chunk retry — CONFIRM.**
`UPL-10…13`, `HTP-04/05/06`. Note: whether TikTok's upload host actually *accepts* a
re-PUT of the same range after an ambiguous timeout is empirically unknown (plat-§5.9);
the simulator (§ 5b) encodes **our** policy, and the Phase-2 sandbox checklist must
verify the platform's — listed in § 7.

**arch-5 — separate flat-payload parser for OAuth endpoints — CONFIRM.** `OAU-04/05`
with a dedicated fixture family; prevents the envelope parser from silently
"succeeding" on OAuth error bodies.

**arch-6 — move `PACKAGES` manifest to `src/tools/index.ts` — CONFIRM.** Testable as a
layering gate (`REG-11`, ESLint no-restricted-imports stays green) and the manifest
snapshot (`REG-01`) imports from `tools/`, which is what freezes the surface.

**arch-7 — split publish package into read + write — CONFIRM.** `REG-10`; makes the
"readonly profile" claim falsifiable instead of vacuous.

**arch-13 — reword the vacuous 401-replay clause — CONFIRM.** `HTP-08` pins exactly
one forced refresh + one replay; `DT-4` gives the init-401 row concrete semantics.

**arch Deep-dive C — `wait_for_completion` default `false` for `source=file` —
REFINE/CONFLICT.** This contradicts TOOLS.md (default `true`) and aidx-F14 (keep
`true`, add progress notifications). Both variants are equally testable — but the
default is frozen into the manifest snapshot (`REG-01`) on day one, so the decision
must be made *before* Phase 2, not during. Flagged in § 7. The test spec is written
default-agnostic (`TLS-13` tests the timeout contract whichever default holds).

### 2.3 AI/DX review

**aidx-F1 — plan_id (same mechanism as sec-F4) — CONFIRM; elicitation REFINE.**
Elicitation as defense-in-depth is client-dependent and cannot be e2e-tested in CI.
Testable slice: the **feature-detect branch** — with an in-memory MCP client stub that
advertises/withholds elicitation capability, assert the server asks vs. falls back
(`WRM` family, advisory case). Do not write tests asserting human behavior.

**aidx-F3 — split `tiktok_post_photos` into post/draft pair — CONFIRM.** `TLS-14`.
The split is what keeps the marker sweep (`REG-04/05`) expressible as "1 tool = 1 scope
= 1 marker". The unsplit alternative needs per-mode marker logic — a strictly larger,
uglier test matrix. From the test seat: split.

**aidx-F4 — `tiktok_list_publish_journal` + journal-the-attempt-before-init — CONFIRM,
emphatically.** `JRN-02/03/08/09`. The attempt-first write is what makes DT-4's
`outcome: "unknown"` **observable** — without it, the "may-have-been-sent" decision
table has no artifact to assert on and R1 F-2's semantics stay untestable.

**aidx-F5 — marker lifecycle: call-time re-check, `listChanged`, reload triggers —
CONFIRM.** `REG-06/07/08`. `list_changed` emission is testable with the MCP SDK's
in-memory transport (no spawned process needed); the spawned-process test (`MET-02`)
stays focused on stdout purity only.

**aidx-F13 — truncation meta (`reason`, `resume_cursor`, items-not-fields) — CONFIRM.**
Converts R1 F-12's "truncation with explicit markers" from vibes into assertable shape:
`TLS-11/12`, `API-04`.

**aidx-F14 — progress notifications on poll ticks — REFINE.** Emission is testable
(in-memory transport, count notifications per tick under the manual clock); client
rendering is not. The load-bearing test remains the timeout-result contract `TLS-13`
(publish_id + follow-up hint present). Keep the notification test advisory until the
SDK's notification API stabilizes in our usage.

**aidx-F16 — discriminated union on `source` — CONFIRM.** Makes the contradictory-input
rows of R1 F-20's cross-field matrix *unrepresentable*, shrinking the matrix; `TLS-02`
asserts the error names the discriminator.

**aidx-F18 — envelope ↔ `CallToolResult` mapping (`ok:false ⇒ isError:true`,
`structuredContent`) — CONFIRM.** New registry-wide sweep `REG-12`.

**aidx-F19 — hints never interpolate upstream free-text — CONFIRM.** `RED-08` as a
fixture-driven sweep: run every tool against its recorded fixtures, collect all emitted
hints, assert none contains any string sourced from fixture response free-text fields.

### 2.4 DevOps / release review

**devops-F1 — Windows: skip 0600 assertions with named reasons; platform data-dir
resolver — CONFIRM.** `CFG-04/05/15`, `MET-09`. The named-skip sweep (`MET-09` greps
compiled tests for `skip(` without a reason string) is what prevents the "silently
voided security claim" failure mode. The Windows CI leg gets *real* assertions: path
resolver, rename-EPERM retry, journal writes — not just re-running neutral units.

**devops-F2 — CI in Phase 0, not Phase 3 — CONFIRM.** The gate table in § 6 assumes it;
per-area floors are meaningless if nothing runs them.

**devops-F6 — split `npm audit` out of the blocking gate — CONFIRM.** From the QA seat:
blocking gates must be **deterministic functions of the repo state**; a live advisory DB
in `check` violates that. Aligns with the zero-network-in-CI invariant.

**devops-F9 — journal failure semantics + rotation — CONFIRM.** `JRN-04/05`; identical
to sec-F15's rotation half.

**devops-F12/F13 — pack audit, launcher probe — CONFIRM.** `MET-08` (pack manifest
snapshot + no-install-scripts assertion); the launcher probe is a CI job, not a
node:test case — § 6 places it.

### 2.5 TikTok platform review

**plat-F1 — PKCE challenge is hex-encoded SHA-256 — CONFIRM.** `OAU-01/02`. The pinned
known-vector test is the highest-value single test in the auth area: it is the only
thing standing between the implementation and a future refactor "fixing" the encoding
back to RFC 7636 base64url (which every library and every LLM will suggest). The test
must carry a comment explaining the deviation.

**plat-F2 — photo title ≤ 90 UTF-16 units — CONFIRM.** `TLS-05` must count **UTF-16
code units** (emoji = 2), not code points — same unit discipline as the truncation
tests (R1 F-12, `TLS-12`).

**plat-F3 — `brand_content_toggle` ∧ `SELF_ONLY` invalid — CONFIRM.** `TLS-04`; pure
local validation, no network, trivially deterministic.

**plat-F4 — `open-upload.tiktokapis.com` + `upload_token` is a credential — CONFIRM.**
Extends the host-guard allowlist (`HTP-09`, `DT-3`) and the scrub set (`RED-01/09`).
This finding retroactively *changes* R1 F-6's expected-allowlist fixture — the round-1
host-guard tests written against `{open.tiktokapis.com}` alone would now be wrong.

**plat-F5 — wildcard-port redirect registration — REFINE (test-friendliness).**
Either fixed or random port is testable, but random-port + `TT_REDIRECT_PORT` override
is *more* testable: CLI tests already must bind port 0 (R1 F-25) to avoid collisions in
parallel CI. If the fixed port is kept, the login tests still inject port 0 and the
fixed default is asserted only in settings parsing (`CFG-09`).

**plat-F6 — `creator_info` requires `video.publish`; draft paths must skip it —
CONFIRM.** `API-07`. Without this, the plan phase of draft tools is untestable-green
for a `video.upload`-only profile — the fixture would have to fake a scope the profile
doesn't hold.

**plat-F7 — status 30/min, creator_info 20/min buckets — CONFIRM.** `HTP-17`; DT-1
extended with a read-bucket policy (delay, not reject — see table).

**plat-F8 — error-code and `fail_reason` catalogs — CONFIRM.** `API-11` is table-driven
off the catalog; add an exhaustiveness guard: the test fails if a fixture contains a
`fail_reason` absent from the mapping table.

**plat-§6.1 — chunk math (floor-merge rule) — CONFIRM; supersedes R1.** R1 F-21/§5's
invariant "all chunks within 5–64 MB" is **wrong** per the platform docs: the final
chunk is `chunk_size + remainder` up to 128 MB and there is no separate remainder
chunk. `UPL-01…06` encode the corrected invariants; TESTING.md's bullet must be
replaced (§ 6 amendment 1).

**plat-F9 — `TT_VERIFIED_URL_PREFIXES` pre-flight — CONFIRM.** `TLS-17`; converts a
guaranteed upstream failure into a local, deterministic, testable rejection.

## 3. Decision tables

These resolve the ambiguities R1 flagged as blocking testability (R1 F-2, F-5, F-6,
F-17). Each table is normative for the test spec in § 4; each row maps to at least one
case ID.

### DT-1 — Client-side rate limiting: delayed vs rejected

Policy: **writes reject, reads delay.** Rejecting inits keeps "no duplicate posts"
absolute and gives the model a structured pause instruction (R1 F-17, aidx-F15);
delaying reads is safe (idempotent) and invisible to the model.

| # | Bucket | State | Call | Behavior | Case |
|---|--------|-------|------|----------|------|
| 1 | publish inits (6/min, per profile) | tokens available | apply (init) | proceed; consume 1 token | HTP-15 |
| 2 | publish inits | empty | apply (init) | **reject locally, zero network**: `ok:false`, `code:"local_rate_limited"`, `retry_after_s`, absolute `retry_at`, imperative hint | HTP-15 |
| 3 | publish inits | empty | plan call | plan **succeeds** (no init occurs); preview includes `publish_rate: "6 of 6 slots used"` | WRM-02 |
| 4 | publish inits | refill | — | continuous refill 1 token / 10 s, capacity 6 (not fixed windows) | HTP-16 |
| 5 | status/fetch (30/min) | empty | poll tick | **delay** until a token is available, capped by remaining poll budget; never reject | HTP-17 |
| 6 | creator_info (20/min) | empty | plan call | **delay** up to `TT_TIMEOUT_MS`; if still empty → `local_rate_limited` with `retry_after_s` | HTP-17 |
| 7 | any | bucket says go, upstream still 429s | init | surface upstream `rate_limit_exceeded`; **never auto-retry an init** | HTP-05 |
| 8 | any | — | — | buckets are per profile (ALS-scoped) and refill on the injected clock | HTP-16 |

### DT-2 — Status polling: timeout vs terminal winner

Policy: **a terminal result obtained before returning always wins; a timeout result is
an instruction sheet, never a dead end** (R1 F-5, aidx-F14).

| # | Situation at deadline | Result | Case |
|---|----------------------|--------|------|
| 1 | Terminal status (`PUBLISH_COMPLETE`/`SEND_TO_USER_INBOX`/`FAILED`) received at t < timeout | terminal result; `FAILED` → `ok:false` + mapped `fail_reason` hint | API-13 |
| 2 | Poll response **in flight** when the deadline fires | await that response; terminal → terminal wins; non-terminal → timeout result | API-13 |
| 3 | Deadline fires between polls | timeout result: `ok:true`, `status:"timeout"`, last known status, `publish_id`, `uploaded_bytes`, hint with the exact follow-up call | TLS-13 |
| 4 | Poll fetch fails transiently mid-wait | retry within remaining budget (it is a read); budget exhausted → timeout result noting the last error | API-13 |
| 5 | Any timeout path | `publish_id` is **always** present in the result; no exception path may drop it | TLS-13 |
| 6 | Poll interval | `TT_STATUS_POLL_INTERVAL_MS` ticks on the injected clock; interval respects DT-1 row 5 | API-13 |

### DT-3 — `upload_url` validation (domain set fixed)

Policy: **exact dot-anchored allowlist, https, default port only, validated before the
first byte leaves the process** (R1 F-6, sec-F8, plat-F4).

| # | Candidate `upload_url` property | Verdict | Case |
|---|--------------------------------|---------|------|
| 1 | host ∈ { `open-upload.tiktokapis.com`, `open.tiktokapis.com` } (exact match) | allow | UPL-16 |
| 2 | host = `<label>.open-upload.tiktokapis.com` (proper dot-anchored subdomain of an allowlisted host) | allow | UPL-16 |
| 3 | `evil-open.tiktokapis.com.attacker.com` (suffix attack) | reject | HTP-10 |
| 4 | scheme ≠ `https` | reject | UPL-16 |
| 5 | explicit port other than 443 | reject | UPL-16 |
| 6 | userinfo present (`https://user@host/…`) | reject | HTP-10 |
| 7 | IP-literal host | reject | HTP-10 |
| 8 | any reject | error names the offending host; **zero bytes sent**; full URL never logged (origin + path only, query stripped) | RED-09 |
| 9 | DNS resolve-and-pin (sec-F8) | **deferred from v1** — documented in SECURITY.md, revisit if a `lookup` seam lands in core/http | — |

### DT-4 — Ambiguous init outcomes: replay and journaling rules

Policy: **an init whose request may have reached TikTok is terminal for automation;
only provably-unsent inits are freely re-plannable** (R1 F-2, arch-13, aidx-F4).

| # | Failure point | May have posted? | Auto-replay? | Journal outcome | Model-facing guidance | Case |
|---|--------------|------------------|--------------|-----------------|----------------------|------|
| 1 | Local validation / host guard / DT-1 reject (nothing sent) | no | n/a — model may re-plan freely | *(no attempt row)* | fix input / wait, then new plan | TLS-01 |
| 2 | Connection failed before request write (ECONNREFUSED, DNS) | no | **no** (conservative; can't always distinguish) | `unsent` | "The request never reached TikTok. Re-plan and retry." | JRN-02 |
| 3 | Socket error / timeout **after** request sent, no response read | **unknown** | **no** | `unknown` | "May have posted. Check `tiktok_list_publish_journal` + `tiktok_get_publish_status` before any retry." | JRN-03 |
| 4 | HTTP 401 response on init | no (auth rejected before creation) | one forced refresh + **one** replay, then terminal | updated in place | — | HTP-08 |
| 5 | HTTP 5xx response on init | unknown (server may have created the task) | **no** | `unknown_5xx` | same as row 3 | HTP-05 |
| 6 | HTTP 200 + envelope `error.code !== "ok"` | no (definitive rejection) | no auto-retry; model may fix & re-plan (fresh plan_id) | `rejected:<code>` | mapped recovery hint | API-11 |
| 7 | Init succeeded, chunk PUT fails after retry budget | post task exists | in-call same-range retries only (`UPL-10`); never a new init | `upload_failed` + publish_id + failed range | "Attempt is dead; a re-call creates a NEW post. Check status/journal first." | UPL-11 |
| 8 | Init succeeded, poll timed out | task exists, in progress | n/a | `pending` → updated by later status calls | DT-2 row 3 | TLS-13 |

### DT-5 — plan_id verification on apply (sec-F4 / aidx-F1 semantics pinned)

Checked in order; first failing row wins. `TT_PLAN_TTL_S` default 600.

| # | Check | On failure: error + hint | Case |
|---|-------|--------------------------|------|
| 1 | `TT_WRITE_MODE=apply` → **skip all checks** (documented operator opt-out) | — | WRM-10 |
| 2 | plan_id present (in plan mode) | `plan_required` — "Call without apply first, show the preview, apply after the user approves." | WRM-04 |
| 3 | plan_id exists in store | `plan_unknown` — same re-plan guidance | WRM-04 |
| 4 | plan unexpired (`now − issued ≤ TTL`, injected clock) | `plan_expired` — "Preview may be stale (creator settings can change). Generate a fresh preview and re-confirm." | WRM-05 |
| 5 | plan unused (single-use; consumed atomically on first accepted apply) | `plan_already_used` — one approval ≠ N posts | WRM-08 |
| 6 | canonical-args hash matches (sorted-key JSON, absent ≡ undefined) | `plan_args_changed` — names the drift, demands fresh preview | WRM-06 |
| 7 | resolved account/profile matches plan's | `plan_account_mismatch` — names both profiles | WRM-09 |
| 8 | all pass | execute; store entry consumed **before** the init request is sent | WRM-08 |

## 4. Test specification

The definitive per-module case list — implementation starts from this. It incorporates
and supersedes R1 § 5's 49 cases (provenance in the *Src* column: `R1 F-x` / `R1 §6` /
round-2 finding / `new`). **166 cases.**

Columns — **Type**: unit / property / contract (fixture-driven) / race / e2e-local /
meta (repo-level gate). **Needs**: `fetch` = scripted fetch mock (R1 §6), `clock` =
manual clock (§ 5a), `fs` = fs sandbox in scratch dir, `defer` = deferred-resolution
promises, `rng` = seeded PRNG, `sim` = upload simulator (§ 5b), `child` = child
processes (§ 5c), `fix` = recorded fixtures (§ 5d), `mem` = in-memory MCP transport.
**Gate**: B = blocking CI, A = advisory.

### 4.1 core/config + settings (CFG)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| CFG-01 | Var set in process env and env file → process env wins | unit | fs | B | R1 §5 |
| CFG-02 | `TT_ENV_FILE` set → that path used, XDG ignored | unit | fs | B | R1 §5 |
| CFG-03 | `XDG_CONFIG_HOME` set → honored; unset → `~/.config/tiktok-mcp-ai` | unit | fs | B | R1 §5 |
| CFG-04 | Platform resolver (platform injected): win32 → `%LOCALAPPDATA%\tiktok-mcp-ai`, else XDG | unit | — | B | devops-F1 |
| CFG-05 | Env file written → mode 0600, parent dir 0700 (POSIX; named win32 skip) | unit | fs | B | sec-F7 |
| CFG-06 | Temp file pre-exists at target temp path → write **fails** (O_EXCL), never truncates | unit | fs | B | sec-F7 |
| CFG-07 | Concurrent reader during write → sees only old or new complete content (atomic rename) | race | fs | B | R1 F-3 |
| CFG-08 | File holds unknown keys → read-merge-write preserves them byte-exactly | unit | fs | B | arch-1 |
| CFG-09 | Numeric vars: bounds enforced, non-numeric → error naming the var and expected range | unit | — | B | R1 §5 |
| CFG-10 | Boolean parsing table: `1/true/0/false/TRUE/garbage` → documented results | unit | — | B | new |
| CFG-11 | Profile names: accept/reject set for `^[a-z][a-z0-9_]{0,31}$` | unit | — | B | arch-19 |
| CFG-12 | `TT_PROFILE_<NAME>_*` resolution; unknown profile → error listing configured profiles | unit | — | B | aidx-F10 |
| CFG-13 | `TT_MEDIA_ROOT`: file inside root (after realpath) → allowed; outside → rejected | unit | fs | B | sec-F3 |
| CFG-14 | Root `/media`, candidate `/media-evil/x` → rejected (prefix-collision); symlink escaping root → rejected (POSIX, named skip) | unit | fs | B | sec-F3 |
| CFG-15 | win32 rename gets EPERM (injected fs error) → bounded retry then clear error | unit | fs | A | devops-DDA |

### 4.2 core/oauth (OAU)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| OAU-01 | Pinned vector: known verifier → exact 64-char lowercase-hex challenge (with why-comment) | unit | — | B | plat-F1 |
| OAU-02 | Property: generated verifiers are 43–128 chars of `[A-Za-z0-9-._~]`; challenge always 64 hex | property | rng | B | plat-F1 |
| OAU-03 | state/verifier: ≥ 32 random bytes, base64url charset, unique across 1000 calls | unit | — | B | sec-F18 |
| OAU-04 | Token exchange response (flat payload) parsed; envelope parser NOT applied | contract | fetch,fix | B | arch-5 |
| OAU-05 | OAuth error body (`error`/`error_description`) → taxonomy; `invalid_grant` → terminal re-login hint | unit | fetch | B | arch-5 |
| OAU-06 | Token expires in skew window (injected clock) → proactive refresh; outside → no refresh | unit | clock,fetch | B | R1 F-5 |
| OAU-07 | N concurrent `getAccessToken` → exactly 1 refresh; asserted **while pending** via deferred fetch | race | fetch,defer | B | R1 F-7 |
| OAU-08 | Refresh returns rotated refresh_token → persisted before mutex release | unit | fetch,fs | B | R1 F-3 |
| OAU-09 | Persist fails (read-only dir) → session continues on in-memory token + loud stderr warning | unit | fetch,fs | B | R1 F-3 |
| OAU-10 | Semaphore saturated (4 in-flight) + 401 triggers refresh → refresh completes (token path bypasses semaphore); AbortSignal.timeout watchdog | race | fetch,defer | B | R1 F-7 |
| OAU-11 | Two profiles interleaved, responses resolved in reverse order → each call gets its own profile's token (ALS) | race | fetch,defer | B | R1 F-11 |
| OAU-12 | `withLock`: lock file held → caller waits until release; timeout → clear error | unit | fs,clock | B | arch-1 |
| OAU-13 | After lock acquire, env re-read; token already rotated by "other process" → network refresh skipped | unit | fs,fetch | B | arch-1 |
| OAU-14 | Lock file older than staleMs / dead PID → broken with stderr warning, refresh proceeds | unit | fs,clock | B | arch-1 |
| OAU-15 | Refresh gets `invalid_grant` → env re-read once; newer token found → retry with it; else terminal | unit | fs,fetch | B | arch-1 |
| OAU-16 | 4 real processes race one refresh against a local token stub → stub sees exactly 1 refresh; all 4 end on the rotated token; env file parseable | race | child | B* | arch-1/devops-F8 |
| OAU-17 | Revoke sends `client_key`/`client_secret`/`token`; retried once on network error; tokens cleared from file, client creds kept | unit | fetch,fs | B | plat-12.6 |
| OAU-18 | Comma-separated scope string → set; partial grant surfaced to caller | unit | — | B | new |

\* blocking on the ubuntu leg, advisory on macOS/Windows (§ 6).

### 4.3 core/http + host guard (HTP)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| HTP-01 | HTTP 200 + `error.code !== "ok"` → `TikTokError` with `apiCode`, `logId`, status | unit | fetch | B | R1 §5 |
| HTP-02 | Edge envelopes: missing `error`, non-JSON, empty body, `ok` code + missing `data` → defined errors, no crash | unit | fetch | B | R1 F-9 |
| HTP-03 | Upload-host PUT responses (206/201, no envelope) → envelope parser NOT applied | unit | fetch | B | plat-§5.9 |
| HTP-04 | 429 on read → retried honoring `Retry-After` (cap 60 s), stops at `TT_MAX_RETRIES` | unit | fetch,clock | B | R1 §5 |
| HTP-05 | 429/5xx/network on publish init → **never** auto-retried; DT-4 row recorded | unit | fetch | B | R1 F-2 |
| HTP-06 | 5xx retried only for idempotent reads; POST reads flagged idempotent retry, init not | unit | fetch,clock | B | arch-DDA |
| HTP-07 | Backoff sequence `min(500·2^n, 8000)+jitter` with seeded RNG → exact pinned sequence | unit | clock,rng | B | R1 F-5 |
| HTP-08 | 401 → exactly one forced refresh + one replay; second 401 → terminal (no loop) | unit | fetch | B | arch-13 |
| HTP-09 | Host guard accepts `open.tiktokapis.com` and `open-upload.tiktokapis.com` | unit | — | B | plat-F4 |
| HTP-10 | Negatives: `evil-open.tiktokapis.com.attacker.com`, userinfo, IP literal, port ≠ 443, http | unit | — | B | R1 F-6 |
| HTP-11 | Property: random hostnames pass iff exact/dot-anchored allowlist member | property | rng | B | R1 F-6 |
| HTP-12 | 30x from API host → error, redirect not followed (`redirect: "error"`) | unit | fetch | B | arch-10 |
| HTP-13 | 5 concurrent requests, `TT_MAX_CONCURRENT=4` → 5th not dispatched while 4 pending (asserted mid-flight) | race | defer | B | R1 §5 |
| HTP-14 | In-flight request rejects → semaphore slot released (no leak; next request proceeds) | race | defer | B | new |
| HTP-15 | 6 inits pass, 7th → local reject, zero fetch, `retry_after_s` + absolute `retry_at` (DT-1) | unit | clock | B | R1 F-17 |
| HTP-16 | Advance clock 10 s → exactly one slot refilled (continuous refill, per-profile bucket) | unit | clock | B | new |
| HTP-17 | status bucket (30/min) and creator_info bucket (20/min) → **delay** not reject; delay bounded (DT-1 rows 5–6) | unit | clock | B | plat-F7 |
| HTP-18 | `TT_TIMEOUT_MS` aborts request via signal; uploads use `TT_UPLOAD_TIMEOUT_MS` | unit | fetch,clock | B | R1 §5 |
| HTP-19 | Bearer header sent to API host; **absent** on upload-host PUTs (recorder asserts) | unit | fetch | B | R1 §6 |

### 4.4 core/upload (UPL)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| UPL-01 | Property: `count = floor(size/chunk_size)` for all valid (size, chunk_size) | property | rng | B | plat-12.7 |
| UPL-02 | Property: non-final chunks exactly `chunk_size`; final `= chunk_size + (size mod chunk_size)` ≤ 128 MB | property | rng | B | plat-§6.1 |
| UPL-03 | Property: ranges contiguous, disjoint, sum = size; count ∈ [1, 1000] | property | rng | B | R1 F-21 |
| UPL-04 | size < 5 MB → single whole-file chunk (only legal sub-5 MB case) | unit | — | B | plat-§6.1 |
| UPL-05 | Boundary pins: 5 MB−1, 5 MB, 64 MB, 64 MB+1, 128 MB, 128 MB+1, 4 GB | unit | — | B | plat-§6.1 |
| UPL-06 | Fixed `chunk_size = 64 MB` policy: plan valid for every size ≤ 4 GB (no heuristics) | unit | — | B | plat-§6.1 |
| UPL-07 | Executor emits `Content-Range: bytes {first}-{last}/{total}` exactly matching the plan | unit | sim | B | R1 F-1 |
| UPL-08 | Chunks PUT sequentially; simulator rejects any out-of-order/overlapping range | unit | sim | B | R1 §6 |
| UPL-09 | Concatenated received bodies byte-equal the seeded-PRNG source file (streamed) | unit | sim,rng,fs | B | R1 §6 |
| UPL-10 | Scripted 500 on chunk k → same byte range re-PUT; success → upload continues to 201 | unit | sim | B | arch-4/aidx-F11 |
| UPL-11 | Retry budget exhausted on chunk k → `upload_failed` carrying publish_id + failed range + status/journal hint | unit | sim | B | R1 F-1 |
| UPL-12 | After final 201 → no further PUTs issued (simulator records violations) | unit | sim | B | new |
| UPL-13 | Chunk 4xx (non-retryable) → terminal immediately; 5xx/timeout → retryable path | unit | sim | B | arch-4 |
| UPL-14 | Simulated 403-after-expiry (1 h TTL via clock) → terminal with re-init guidance, no retry storm | unit | sim,clock | B | R1 F-1 |
| UPL-15 | Large sparse source streamed → process RSS stays bounded (never buffers whole file) | unit | fs | A | R1 §6 |
| UPL-16 | `upload_url` validation table DT-3: each row → allow/reject before any byte sent | unit | — | B | R1 F-6/sec-F8 |

### 4.5 api/* (API)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| API-01 | user/info request: `fields` in query string, exact URL/shape vs recorded fixture | contract | fetch,fix | B | R1 §5 |
| API-02 | Fields outside granted scopes → filtered client-side, noted in result, not errored | unit | fetch | B | R1 §5 |
| API-03 | list_videos: cursor/`has_more` passed through; cursor treated as opaque (no arithmetic) | unit | fetch | B | arch-18 |
| API-04 | fetch_all: stops on `has_more=false`; stops at `TT_FETCH_ALL_CAP` with `item_cap` meta + resume cursor; repeated-cursor loop guard trips | unit | fetch | B | R1 F-18 |
| API-05 | query_videos with 21 ids → local rejection, zero fetch | unit | fetch | B | R1 §5 |
| API-06 | creator_info fixtures (public/private/unaudited account) → options sets parsed; `audit_restrictions_active` derived when options = [SELF_ONLY] | contract | fix | B | aidx-F9 |
| API-07 | Draft/inbox path with `video.upload`-only profile → creator_info **skipped**, plan succeeds | unit | fetch | B | plat-F6 |
| API-08 | video init payload (post_info/source_info both sources) deep-equals recorded fixture shape | contract | fix | B | R1 F-15 |
| API-09 | photo init payload: `media_type:"PHOTO"`, post_mode, ≤ 35 urls, cover index | contract | fix | B | R1 F-15 |
| API-10 | status/fetch: all documented statuses mapped; `publicaly_available_post_id` normalized to `post_ids` | contract | fix | B | R1 §5 |
| API-11 | Table-driven: every documented error code + `fail_reason` → taxonomy class + recovery hint; fixture containing an unmapped code fails the suite | unit | fix | B | plat-F8/R1 F-22 |
| API-12 | `uploaded_bytes`/`downloaded_bytes` surfaced on in-progress statuses | unit | fetch | B | plat-12.4 |
| API-13 | Poll loop under manual clock: DT-2 rows 1, 2, 4, 6 (terminal-in-flight beats deadline; transient poll errors retried within budget) | unit | clock,fetch | B | R1 F-5 |

### 4.6 mcp/define + registry (REG)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| REG-01 | `describeAllTools()` under full-scope baselineEnv deep-equals committed manifest snapshot | meta | — | B | R1 F-13 |
| REG-02 | Sweep: every registered tool's schema is `.strict()` — unknown arg rejected for each | meta | — | B | R1 §5 |
| REG-03 | Sweep: every field has `.describe()`; every tool states the full four-hint annotation tuple explicitly | meta | — | B | aidx-F2/F6 |
| REG-04 | Missing scope → `[UNAVAILABLE: …]` marker at position 0 of the description | unit | — | B | R1 §5 |
| REG-05 | Multi-profile: marker computed from the union of granted scopes across profiles | unit | — | B | arch-8 |
| REG-06 | Env file gains scope after registration → next call re-checks store and **succeeds** despite stale marker | unit | fs | B | aidx-F5 |
| REG-07 | Genuinely unavailable tool called → fast local `missing_scope` error + login hint, zero fetches | unit | fetch | B | aidx-F5 |
| REG-08 | Marker transition on env reload → `notifications/tools/list_changed` emitted (in-memory transport) | unit | mem,fs | B | aidx-F5 |
| REG-09 | `TT_WRITE_MODE=deny` → write tools unregistered; read tools intact | unit | — | B | R1 §6 |
| REG-10 | `TT_PACKAGES` / readonly filtering incl. split publish-read vs publish-write packages | unit | — | B | arch-7 |
| REG-11 | Layering: manifest lives in `tools/`; ESLint no-restricted-imports gate green | meta | — | B | arch-6 |
| REG-12 | Envelope↔MCP mapping sweep: `ok:false` ⇒ `isError:true`; `structuredContent` present when `output` declared | meta | mem | B | aidx-F18 |

### 4.7 mcp/write-mode + plan_id (WRM)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| WRM-01 | 18-cell matrix: {plan,apply,deny} × {no-apply,apply} × {read, write-draft, write-post} — parameterized sweep, each cell's registration/behavior pinned | unit | fetch | B | R1 §6 |
| WRM-02 | Plan call → **zero** write-endpoint fetches; preview holds creator identity, exact payload echo, `upload_plan` summary (file_size/chunk_size/chunks — no per-chunk list), bucket state | unit | fetch | B | R1 §6/aidx-F20 |
| WRM-03 | Plan result carries fresh `plan_id` + the three directive hints | unit | — | B | aidx-F1 |
| WRM-04 | Apply without / with unknown plan_id in plan mode → DT-5 rows 2–3 errors with re-plan guidance | unit | — | B | sec-F4 |
| WRM-05 | Apply after TTL (clock advanced past `TT_PLAN_TTL_S`) → `plan_expired` | unit | clock | B | sec-F4 |
| WRM-06 | Apply with any mutated arg → `plan_args_changed` (hash mismatch) | unit | — | B | sec-F4 |
| WRM-07 | Property: canonicalization — key order / absent-vs-undefined never change the hash; any value change does | property | rng | B | new |
| WRM-08 | Second apply with a consumed plan_id → `plan_already_used`; consumption happens **before** init dispatch | unit | fetch | B | aidx-DDA |
| WRM-09 | Plan under profile A, apply under profile B → `plan_account_mismatch` naming both | unit | — | B | aidx-F10 |
| WRM-10 | `TT_WRITE_MODE=apply` → plan_id not required; enforcement documented off | unit | — | B | aidx-F1 |
| WRM-11 | Recorder proves: payload sent on apply deep-equals the previewed payload; apply path re-runs creator_info before init | unit | fetch | B | R1 §6/arch-3 |
| WRM-12 | Registry-wide plan sweep: every write tool has a plan fixture; adding a write tool without one fails CI | meta | fix | B | R1 §6 |

### 4.8 journal + journal tool (JRN)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| JRN-01 | N parallel applies → N complete, parseable NDJSON lines (single-write atomic append) | race | fs | B | R1 F-10 |
| JRN-02 | Attempt row written **before** the init request; updated in place after response (DT-4 rows 2, 6) | unit | fetch,fs | B | aidx-F4 |
| JRN-03 | Socket cut after send → row persists with `outcome:"unknown"` (DT-4 row 3) | unit | fetch,fs | B | aidx-F4 |
| JRN-04 | Journal dir unwritable → publish proceeds; stderr warning; result carries `journal:"unavailable"` | unit | fs | B | devops-F9 |
| JRN-05 | Size crosses `TT_JOURNAL_MAX_BYTES` → rotate to `.1`, one generation kept | unit | fs | B | devops-F9/sec-F15 |
| JRN-06 | Journal file created 0600 (POSIX; named win32 skip) | unit | fs | B | sec-F7 |
| JRN-07 | Rows: seeded access token / upload_token absent; title excerpt ≤ 48 chars; `\n`/ANSI in titles escaped | unit | fs | B | sec-F16/plat-F4 |
| JRN-08 | `tiktok_list_publish_journal`: `limit`/`since`/account filters correct; `unknown`-outcome rows included | unit | fs | B | aidx-F4 |
| JRN-09 | Journal tool is closed-world: zero fetches; annotations RO + `openWorldHint:false` | unit | fetch | B | aidx-F4 |
| JRN-10 | Same profile+tool+title-hash within window → refused with pointer to journaled publish_id; `force:true` overrides; guard reads bounded tail only (rotated entries out of scope) | unit | fs,clock | B | arch-2 |
| JRN-11 | Torn/garbage last line in journal → reads and duplicate guard tolerate it (crash recovery) | unit | fs | B | new |

### 4.9 mcp/redact (RED)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| RED-01 | Scrub set: access/refresh tokens, client_secret, authorization code, state, `upload_token`, upload_url query → `[REDACTED]` | unit | — | B | sec-F1/F2/plat-F4 |
| RED-02 | Deep nesting, arrays, and cyclic structures → fully scrubbed, no hang | unit | — | B | R1 F-23 |
| RED-03 | Idempotence: `redact(redact(x)) ≡ redact(x)` | property | rng | B | R1 F-23 |
| RED-04 | Over-redaction guard: publish_id, open_id-shaped strings, titles survive untouched | unit | — | B | R1 F-23 |
| RED-05 | Secret straddling the truncation boundary → redact-before-truncate; no prefix leaks | unit | — | B | R1 F-12 |
| RED-06 | e2e (compiled build): token seeded into a core/oauth error → stderr line scrubbed | e2e-local | fs | B | sec-F1 |
| RED-07 | Newlines / ANSI escapes in upstream titles → escaped in every stderr log line | unit | — | B | sec-F16 |
| RED-08 | Fixture-driven sweep: no emitted hint string contains upstream free-text (titles, fail_reason strings) | meta | fix | B | aidx-F19 |
| RED-09 | upload_url in any log/journal → origin + path only, query stripped | unit | — | B | plat-F4 |
| RED-10 | Property: secret planted at a random path in a random envelope → never survives redaction | property | rng | B | new |

### 4.10 tools/* (TLS)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| TLS-01 | Sweep: invalid args on **every** registered tool → zod error, zero fetches (validation-before-network) | meta | fetch | B | R1 F-20 |
| TLS-02 | `source` discriminated union: `source:"url"` + `file_path` unrepresentable; error names the discriminator | unit | — | B | aidx-F16 |
| TLS-03 | `privacy_level` missing on apply → error lists the creator's live options (incl. unaudited explanation) | unit | fetch | B | aidx-F16 |
| TLS-04 | `brand_content_toggle && privacy_level=SELF_ONLY` → local reject; preview warns "unaudited ⇒ branded content unpostable" | unit | — | B | plat-F3 |
| TLS-05 | Photo title 91 UTF-16 units (emoji counts 2) → reject; 90 → pass; video title bound 2200 | unit | — | B | plat-F2 |
| TLS-06 | `photo_urls` bounds 1–35; `cover_index` within array bounds | unit | — | B | R1 §5 |
| TLS-07 | Creator-disabled toggle forced true → preview flags the coercion (only diffs from input are flagged) | unit | fetch | B | R1 §5/aidx-F20 |
| TLS-08 | `is_aigc` defaults from `TT_DEFAULT_AIGC_LABEL`; explicit argument wins | unit | — | B | R1 §5 |
| TLS-09 | Unknown `account` → local error listing configured profiles (exact-case guidance) | unit | — | B | aidx-F10 |
| TLS-10 | Every result envelope carries `meta.account` (+ truncated open_id) | unit | fetch | B | aidx-F10 |
| TLS-11 | Char-budget halving keeps valid JSON; `cursor`/`has_more`/`meta` survive; `meta.reason` ∈ {char_budget, item_cap} with cause-specific hint | unit | — | B | aidx-F13/R1 F-12 |
| TLS-12 | Property: truncation never cuts inside a surrogate pair | property | rng | B | R1 F-12 |
| TLS-13 | Poll deadline reached → result has publish_id, last status, "normal for large videos" reassurance, exact follow-up hint (DT-2 rows 3, 5) | unit | clock,fetch | B | aidx-F14 |
| TLS-14 | Split photo tools: each carries exactly one scope; marker correct under each grant combination | unit | — | B | aidx-F3 |
| TLS-15 | Draft tools' success result hint instructs opening the TikTok inbox notification | unit | fetch | B | aidx-F8 |
| TLS-16 | `TT_MEDIA_ROOT` set: outside-root and symlink-escape file inputs rejected; preview shows resolved path + size | unit | fs | B | sec-F3 |
| TLS-17 | `TT_VERIFIED_URL_PREFIXES` set: URL-source post with unlisted prefix → local reject naming the config; unset → preview warning only | unit | — | B | plat-F9 |

### 4.11 CLI: login + doctor (CLI)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| CLI-01 | Authorize URL: hex challenge, comma-joined scopes, state, exact registered redirect_uri (trailing slash) | unit | — | B | plat-F1/F5 |
| CLI-02 | Callback with wrong/absent state → 400, no token exchange; digest-compare (no `timingSafeEqual` length crash) | unit | — | B | R1 F-19/sec-F14 |
| CLI-03 | Callback with non-loopback Host/forged Origin → rejected (DNS rebinding) | unit | — | B | sec-F5 |
| CLI-04 | Wrong path → 404; success page HTML contains neither code nor tokens | unit | — | B | R1 F-4 |
| CLI-05 | Full flow in-process: injected browser-opener + local token stub → env file written with tokens/scopes/open_id, 0600 | e2e-local | fs,child | B | R1 F-4 |
| CLI-06 | Requested port busy → readable error naming the port + `TT_REDIRECT_PORT` remedy | unit | fs | B | R1 F-4 |
| CLI-07 | Authorize callback carries `error` (user denied) → non-zero exit, readable message, nothing persisted | unit | — | B | R1 F-4 |
| CLI-08 | `--revoke` → revoke endpoint called, tokens removed from file, client creds retained | unit | fetch,fs | B | R1 §5 |
| CLI-09 | No callback within login timeout → server closed, non-zero exit, clean message | unit | clock | B | R1 F-4 |
| CLI-10 | doctor offline: env presence, file modes, profile list, journal path/size/last entry | unit | fs | B | R1 §5 |
| CLI-11 | doctor online (mocked): token validity, scope-vs-package diff, audit-state inference (options=[SELF_ONLY] ⇒ "app unaudited") | unit | fetch | B | devops-F11 |
| CLI-12 | doctor prints own version + latest from npm metadata (mocked); no secrets in output | unit | fetch | A | devops-F10 |
| CLI-13 | login/doctor stdout discipline: no tokens/codes ever printed; machine-readable sections parse | unit | fs | B | new |

### 4.12 Transport + repo meta (MET)

| ID | Given / When / Then | Type | Needs | Gate | Src |
|----|--------------------|------|-------|------|-----|
| MET-01 | `process.stdout.write` instrumented during import + registerAll → zero non-protocol writes | unit | — | B | R1 F-8 |
| MET-02 | Spawned compiled server on stdio: initialize + tools/list → **every** stdout line parses as a JSON-RPC frame | e2e-local | child | B* | R1 F-8 |
| MET-03 | dotenv loaded quiet; regression: env file present at startup → no tip line on stdout | unit | fs | B | R1 F-8 |
| MET-04 | Build freshness: newest `src/` mtime ≤ `build/` mtime, else fail with "run build" | meta | — | B | R1 F-16 |
| MET-05 | readme-sync: README tool table equals generated table | meta | — | B | R1 §5 |
| MET-06 | env-docs-sync: CONFIGURATION table ≡ `.env.example` ≡ settings source | meta | — | B | R1 §5 |
| MET-07 | serverjson-sync: `gen:manifest --check` clean; `mcpName` equals registry id | meta | — | B | R1 F-24/devops-F5 |
| MET-08 | Pack audit: `npm pack --dry-run --json` file list equals fixture; no install scripts in package.json | meta | — | B | devops-F12 |
| MET-09 | Hygiene sweep: tests use scratch dirs + injected ports only; every platform `skip` carries a named reason | meta | — | B | R1 F-25/devops-F1 |
| MET-10 | Coverage-gate config self-test: per-area floor table present, every floor ≥ policy minimum | meta | — | A | R1 F-14 |

\* blocking on ubuntu; advisory on macOS/Windows until Phase 3 (§ 6).

## 5. Harness designs

### 5a. Deterministic time — recommendation: injectable clock, not global fake timers

**Decision**: a DI `Clock` seam in `core/`, threaded through settings/context. Reasons:
tests run against compiled `build/` across module boundaries (TESTING.md), where
`t.mock.timers` must patch globals for code it did not load — brittle; fake timers
interact badly with real promise I/O in the scripted fetch mock and with child
processes; and the seam also carries the seeded jitter RNG (R1 F-5), which fake timers
cannot. `node:test` mock timers remain acceptable *only* in leaf tests that own all
timers (none currently required).

```ts
// core/clock.ts
export interface Clock {
  now(): number;                                        // epoch ms
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export const systemClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) => timersPromises.setTimeout(ms, undefined, { signal }),
};
// Composition: Settings carries { clock, rng }; core/http, core/oauth, api/publish
// (poller), mcp/write-mode (plan TTL), journal (timestamps) consume it. Production
// code never calls Date.now()/setTimeout directly (ESLint no-restricted-globals rule).

// test/helpers/manual-clock.ts
export function makeManualClock(start = 0): ManualClock;
interface ManualClock extends Clock {
  advance(ms: number): Promise<void>; // moves time; resolves due sleeps in order,
                                      // draining microtasks between resolutions
  pendingSleeps(): number;            // assertion aid (e.g. poller is waiting)
}
```

Poller tests then read: `advance(5000)` per tick; DT-2 row 2 is exercised by scripting
the fetch mock's response as a deferred resolved *after* `advance()` crosses the
deadline. Seeded RNG: `makeRng(seed)` (mulberry32), consumed by backoff jitter
(`HTP-07`) and fast-check (`fc.configureGlobal({ seed })` — seed printed on failure).

### 5b. Chunked-upload simulator

A scriptable dispatcher plugged into the standard fetch mock — no real sockets.

```ts
const sim = makeUploadSim({
  sourcePath,                    // seeded-PRNG fixture on disk (R1 F-21)
  expectedPlan,                  // from planChunks() — ranges to enforce
  script: { 2: [{ status: 500 }, { status: 500 }, "ok"],   // chunk 2: fail twice
            5: [{ hang: true }] },                          // chunk 5: never respond
});
await withFetch(sim.dispatch, () => runUpload(...));
sim.assertComplete();            // throws unless all invariants held
```

Behavior contract:
- Parses `Content-Range: bytes {first}-{last}/{total}`; **rejects** (and records a
  violation) any range whose `first !== bytesAccepted` — this enforces sequential,
  contiguous, gap-free upload in one rule.
- **Consumes every request body stream to a Buffer** (never `text()` on binary);
  appends accepted chunks; `assertComplete()` byte-compares the concatenation against
  the source file, asserts total = file size, asserts no PUT arrived after the final
  201, and asserts header hygiene (no `Authorization`, correct `Content-Type`).
- Responds 206 for non-final, 201 for final, unless the per-chunk script says
  otherwise; scripted entries are consumed in order (a retry consumes the next entry),
  and `assertComplete()` fails on unconsumed script entries — so a test that expects a
  retry *proves* the retry happened.
- `{ hang: true }` returns a never-resolving response for timeout tests (paired with
  the manual clock driving `TT_UPLOAD_TIMEOUT_MS`).

### 5c. Multi-process lock-contention harness

Two layers (see § 2.2 arch-1 — both are required):

**Unit seam** (fast, cross-platform): `core/lockfile.ts` — `withLock(path, fn,
{timeoutMs, staleMs, clock})`. Contention is simulated by pre-creating the lock file;
staleness by advancing the manual clock; win32 EPERM by an injected fs-error shim.
Covers `OAU-12/13/14/15` in milliseconds.

**One real race** (`OAU-16`): proves the composition against genuine OS semantics.
- Parent test: starts a **local HTTP token stub** on port 0 (plain `node:http`) that
  counts `POST /v2/oauth/token/` calls and returns rotated tokens with a serial
  number; writes a shared env file (near-expiry token) in the scratch sandbox.
- Requires one test-only settings override: the OAuth base URL must be injectable via
  env (`TT_OAUTH_BASE_URL`, documented "internal, unsupported"). This is the only spec
  change the harness itself needs — without it, cross-process fetch cannot be
  redirected and the scenario is untestable.
- Spawns 4 children running `test/harness/refresh-worker.mjs` against `build/`; each
  child signals `ready` over IPC, the parent broadcasts `go` (barrier — maximizes
  contention), each child performs `getAccessToken()` and reports the token serial.
- Assertions: stub saw **exactly one** refresh; all 4 children report the same
  (rotated) serial; the env file parses and contains that serial; no lock file left
  behind. Whole test under `AbortSignal.timeout(15_000)` as a deadlock canary.
- Gate: blocking on ubuntu, advisory on macOS/Windows until Phase 3 proves stability.

### 5d. Recorded sanitized sandbox fixtures (contract tests)

**Location**: `test/fixtures/recorded/<area>/<name>.json`, one interaction per file:

```json
{
  "recordedAt": "2026-07-21",
  "endpoint": "POST /v2/post/publish/video/init/",
  "request":  { "headers": { "content-type": "application/json; charset=UTF-8" },
                "body": { "post_info": { "…": "…" }, "source_info": { "…": "…" } } },
  "response": { "status": 200,
                "body": { "data": { "publish_id": "v_pub_file~FAKE.1" },
                          "error": { "code": "ok", "message": "",
                                     "log_id": "20260721000000FAKE" } } }
}
```

**Sanitization rules** (applied by `scripts/fixtures-sanitize.mjs`, mechanical — never
by hand): bearer/refresh tokens → `act.test.REDACTED`; `open_id`/`union_id` → stable
pseudonyms via HMAC with a fixed test key (identities stay consistent *across*
fixtures); `log_id` → shape-preserving fake; `upload_url` →
`https://open-upload.tiktokapis.com/video/?upload_id=FAKE&upload_token=REDACTED`;
display names/avatars/URLs → fixed synthetic values; volatile numbers (counts,
timestamps) kept — contract tests assert **shape and key sets**, not volatile values.
A meta test asserts no fixture matches secret-shaped regexes (belt and braces).

**Refresh procedure**: `npm run fixtures:record` (local only, real sandbox creds via
env — the script refuses to run in CI) writes raw captures to a gitignored dir;
`fixtures:sanitize` produces the committed files; the diff is human-reviewed like any
code change. Re-record on: TikTok API version bump, Phase-2 sandbox pass, or any
`(verify at implementation time)` marker being resolved. Each fixture's `recordedAt`
feeds an advisory staleness test (warn > 180 days).

**Consumption**: contract tests replay `response.body` through the `api/` parsers
(assert successful parse into the internal types) and run our client against the
scripted fetch mock, asserting the produced request matches the fixture's `request`
shape. This is what catches "TikTok's envelope drifted" and "our payload drifted"
symmetrically (R1 F-15).

## 6. CI quality gates and spec amendments

### 6.1 Coverage floors (c8, per area)

c8 has no native per-directory thresholds → a small gate script
(`test/tools/coverage-gate.mjs`) reads `coverage-final.json` and applies this table,
which lives in one JSON file consumed by both the gate and `MET-10`:

| Area | Lines | Branches | Functions | Rationale |
|------|-------|----------|-----------|-----------|
| `core/oauth`, `core/upload`, `mcp/write-mode` (+plan store), `mcp/redact` | 95 | 90 | 100 | token safety, money-path, the two security mechanisms |
| `core/http` | 92 | 88 | 100 | retry/backoff branch forest |
| `core/config`, journal | 92 | 85 | 100 | secret storage + audit trail |
| `api/*` | 90 | 85 | 95 | mostly straight-line parsing |
| `mcp/*` (rest), `tools/*` | 90 | 80 | 95 | schema-heavy, sweeps carry the load |
| `cli/*` | 85 | 75 | 90 | advisory in Phase 0, blocking from Phase 1 |
| **global** (TESTING.md's existing numbers) | 90 | 80 | 95 | unchanged |

**Ratchet policy**: at each phase exit, every floor rises to
`max(floor, achieved − 2)`; floors are never lowered except by a commit whose message
carries a review note; the raise lands in the same PR that raised coverage (prevents
"someone else will ratchet it").

### 6.2 Blocking vs advisory split

- **Blocking on every leg**: all unit/property/contract/meta cases marked B, all sync
  gates (`MET-04…08`), stdout-purity `MET-01/03`.
- **Blocking on ubuntu, advisory on macOS/Windows** (until Phase 3 stabilizes them):
  child-process suites `OAU-16`, `MET-02`, `CLI-05`.
- **Advisory everywhere**: `UPL-15` (RSS heuristic), `CLI-12`, `CFG-15`, `MET-10`,
  fixture-staleness warning, aidx-F14 notification-emission test.
- **Property-test budget**: 200 runs per property in PR CI; 2 000 runs in a nightly
  scheduled workflow (non-blocking; failures file issues with the printed seed).
- Windows leg asserts its *real* jobs (CFG-04/15, journal writes, path resolution) —
  never silently skips without a named reason (`MET-09`).

### 6.3 stdout-purity gate design

Three layers (R1 F-8 refined): `MET-01` (in-process instrumentation — catches the
class), `MET-03` (dotenv tip-line regression — catches the known instance; load dotenv
with `quiet: true`), `MET-02` (spawned compiled server — catches anything the unit
seams miss, including transitive-dependency writes at import time). All three cheap;
first two run on every leg.

### 6.4 Spec amendments (ordered, concrete)

1. **docs/TESTING.md** — replace the "7th init within a minute is delayed/rejected
   locally" sentence with a reference to DT-1 (reject-for-inits, delay-for-reads);
   **replace** the chunk-invariant bullet ("chunks within bounds") with the corrected
   invariants UPL-01…06 (floor-merge rule, final ≤ 128 MB — the current bullet is
   factually wrong per plat-§6.1); append § 3's decision tables as an appendix; add a
   "Harnesses" section adopting § 5a–d (clock seam, upload simulator contract, lock
   harness incl. the `TT_OAUTH_BASE_URL` test override, fixture format + refresh
   procedure); replace the flat per-area bullets with the § 6.1 floor table + ratchet
   policy; extend the helpers list with `makeManualClock`, `makeRng`, `makeUploadSim`,
   `deferred`, `spawnServer`, `withLock` sandbox utilities; state that entropy is
   asserted by length/charset/uniqueness only, and that fsync is unasserted (or gets a
   seam) per § 2.1.
2. **docs/ARCHITECTURE.md § 6** — split the retry matrix into three explicit rows
   (reads / publish inits / chunk PUTs) with the per-chunk same-range retry; add the
   DT-1 bucket semantics (incl. status 30/min and creator_info 20/min buckets); note
   that the envelope parser is bypassed for upload-host responses; cap and formula
   already present — add the seeded-jitter seam.
3. **docs/ARCHITECTURE.md § 8 + docs/TOOLS.md** — specify the plan_id contract as
   DT-5: `TT_PLAN_TTL_S` (default 600), single-use, canonicalization rule
   (sorted-key JSON, absent ≡ undefined), account binding, and the exact re-plan error
   texts; restate the write-mode matrix with plan_id (aidx-F1.6).
4. **docs/AUTH.md § 1** — state PKCE challenge = hex(SHA-256(verifier)), verifier
   43–128 chars of `[A-Za-z0-9-._~]`, and require the pinned test vector (OAU-01);
   adopt wildcard-port registration with `TT_REDIRECT_PORT` as override (plat-F5);
   document the digest-compare rule for state (sec-F14).
5. **docs/AUTH.md § 2 / § 4** — specify the cross-process lock protocol (lockfile
   beside the env file; acquire → re-read → refresh-if-still-stale → persist →
   release; stale-lock breaking; invalid_grant re-read-once) and read-merge-write.
6. **docs/TOOLS.md** — truncation meta contract (aidx-F13 shape, DT-2/TLS-11
   semantics); poll-timeout result contract (DT-2 row 3); the photo tool split; the
   `tiktok_list_publish_journal` spec (aidx-F4 + JRN-08/09); DT-4's model-facing
   guidance strings.
7. **docs/CONFIGURATION.md** — add `TT_PLAN_TTL_S`, `TT_JOURNAL_MAX_BYTES`,
   `TT_MEDIA_ROOT`, `TT_VERIFIED_URL_PREFIXES` (all with defaults + env-docs-sync
   rows); mark `TT_OAUTH_BASE_URL` internal/test-only.
8. **docs/SECURITY.md** — rewrite the prompt-injection paragraph to the plan_id-accurate
   claim (aidx-F1); add `upload_token`/`upload_url` to the secret inventory (plat-F4);
   record the sec-F8 resolve-and-pin deferral (DT-3 row 9); add devops-F13's
   "CI requires zero repository secrets" invariant.

## 7. Remaining unknowns

Things no test in § 4 can settle from the spec — each needs an owner and a phase:

1. **Chunk-PUT re-PUT semantics upstream** — does TikTok's upload host accept a
   repeated `Content-Range` after an ambiguous timeout (is our UPL-10 policy actually
   safe end-to-end)? Empirical; Phase-2 sandbox checklist item. The simulator encodes
   our policy either way.
2. **`wait_for_completion` default** — TOOLS.md/aidx-F14 say `true`; arch Deep-dive C
   says `false` for `source=file`. Frozen into the manifest snapshot on day one —
   decide before Phase 2. Test spec is default-agnostic.
3. **Status retention window** after terminal state (plat-F10) — unknown; affects how
   long the journal's "check status first" hint stays actionable. Sandbox measurement.
4. **Field-outside-scope behavior** on Display API (error vs silent omission,
   plat row 21) — determines whether API-02's client-side filter is belt-and-braces or
   load-bearing. Phase-1 empirical check; keep the filter regardless.
5. **Elicitation support** across real MCP clients — determines whether the WRM
   elicitation branch ever runs in the wild; feature-detect test exists either way.
6. **Rotated-refresh-token invalidation timing** — whether TikTok kills the old
   refresh token immediately on rotation. The lock design is correct defensively in
   both worlds; OAU-16 proves our side only.
7. **PKCE migration risk** — if TikTok ever moves to RFC 7636 base64url, OAU-01's
   pinned vector fails loudly (by design). Re-verify the doc at implementation time
   and at each SDK-era upgrade.
8. **Display API QPS** — no published numbers; DT-1 covers only documented buckets.
   Treat upstream 429 as authoritative for reads (already retried).
9. **Journal purge-on-revoke** (sec-F15 vs arch-2 conflict) — recommend default-keep
   with explicit `--purge-journal` flag; needs a one-line decision in SECURITY.md.
10. **`npx` staleness telemetry** (devops-F10) — doctor's latest-version check is
    specced advisory (CLI-12); whether it should ever gate anything is a product call,
    not a QA one.

---

*End of round-2 QA deep review. Test specification: **166 cases** (§ 4), superseding
R1 § 5's 49. Blocking: 158; advisory: 8. Harnesses: injectable clock + seeded RNG,
scriptable upload simulator, two-layer lock-contention harness, sanitized recorded
fixtures. All four round-1 blocking ambiguities resolved as decision tables (§ 3),
plus the plan_id verification table. Two genuine cross-review conflicts surfaced for
decision (§ 7 items 2 and 9).*
