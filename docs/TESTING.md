# Testing strategy

Framework: built-in **`node:test`** + `node:assert/strict` — no test-runner
dependency (house style). Tests run against the compiled output in `build/`
(`npm test` = `node --test test/*.test.js`; `test:full` chains the build).
Property-based tests use **fast-check** (the only test-only dependency);
the global seed is fixed per run and printed on failure. Coverage via `c8`,
wired into `npm run check` from Phase 0 (floors and CI matrix below).

## Determinism rules (bind every test)

1. **Injectable clock everywhere time matters** (CC-H4). Every time-dependent
   behavior — refresh skew, token buckets, poll loops, plan TTL, lock
   staleness and heartbeat — runs on the `Clock` seam (`core/clock.ts`) and
   is tested with `mockClock(...).advance(ms)`. **Tests never sleep.**
   Production code never calls `Date.now()`/`setTimeout` directly (ESLint
   `no-restricted-globals`).
2. **No real network in unit tests.** All HTTP goes through the `withFetch`
   stub. A test asserting a guard ("nothing was sent") asserts the stub was
   never invoked. CI never talks to TikTok; empirical questions go through
   the sandbox probes (last section).
3. **No shared state between tests.** File-system tests run inside
   `fsSandbox()` scratch dirs; test servers bind port 0; env mutation is
   scoped via `withEnv`.
4. **Seeded randomness.** Backoff jitter and property generators consume a
   seeded PRNG; every failure reproduces from the printed seed.
5. **Honest limits.** Entropy of `state`/verifier/`plan_id` is asserted by
   length, charset, and uniqueness across calls only — never by
   pseudo-statistical entropy tests. `fsync` calls are unasserted (there is
   no observable seam through the public API); this document says so rather
   than pretending a monkey-patched spy proves them.

## Test naming

Test names cite the corner-case id they pin, e.g.
`"cc-a1 rotation persisted before first use"`,
`"cc-d2 v5 single chunk exceeds declared chunk_size"`. A corner case in
`docs/CORNER-CASES.md` without a citing test is an unfinished task
(see the definition of done in `docs/TASK-BREAKDOWN.md`).

## Layout

```
test/
  helpers.ts              # the frozen cross-task harness contract (CONTRACTS.md)
  harness.test.ts         # self-tests for the extended harness
  harness/                # extended harness (not contract): upload simulator,
                          # seeded RNG, deferreds, OAuth token stub, the
                          # multi-process runner for the lock race, and the
                          # recorded-fixture replay harness
    workers/              # worker modules the runner forks (never *.test.ts)
  fixtures/
    recorded/<area>/      # sanitized sandbox interactions, written only by
                          # `npm run fixtures:sanitize` (absent until the first
                          # sandbox pass — see § Recorded sandbox fixtures)
  *.test.ts               # one file per module/area (compiled with the build)
```

Two things this tree deliberately does **not** hold. The generated snapshots
live where the artifacts they describe do — [docs/tool-manifest.json](tool-manifest.json)
for the tool surface and `pack-manifest.json` in the repo root for the
`pack-audit` gate — because `npm run sync` compares them against the tree, not
against the suite. And there is no committed media: the upload tests write the
bytes they need into `fsSandbox()` at run time, which is what lets one helper
produce a single-chunk file, a multi-chunk file and a zero-byte file without
committing any of them.

## Harness — `test/helpers.ts`

The cross-task harness contract, mirrored from **CONTRACTS.md § Test
harness** (that section is authoritative; the two must never drift):

```ts
export function baselineEnv(): NodeJS.ProcessEnv;       // minimal valid TT_ set
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T;
export function withFetch<T>(stub: FetchStub, fn: () => Promise<T>): Promise<T>;
export function ttEnvelope(data: unknown, error?: { code: string; message: string }): Response;
export function scriptFetch(responses: Response[]): RecordingFetchStub;   // + .calls
export function mockClock(startEpochMs?: number): MockClock;
export interface MockClock extends Clock {
  advance(ms: number): Promise<void>;   // runs due sleeps deterministically
  pending(): number;                    // waiters still asleep
  setNow(epochMs: number): void;        // the only backwards-step seam
}
export function fsSandbox(): Promise<{ dir: string; cleanup(): Promise<void> }>;
```

- `baselineEnv()` — seeds client key/secret + a valid default profile.
- `withEnv(vars, fn)` — scoped env mutation + credential-store reload;
  `undefined` deletes a key for the duration.
- `withFetch(stub, fn)` — swaps `globalThis.fetch` with a recording stub;
  tests assert both the outgoing request (URL, headers, body) and the
  behavior. `ttEnvelope(data, error?)` builds a `{ data, error }` response,
  because **every** mocked API response needs the envelope.
- `mockClock(start?)` — implements the `core/clock.ts` `Clock` interface;
  `advance(ms)` moves time and resolves due `sleep`s in order, draining
  microtasks between resolutions. This is what makes CC-H4 hold: a TTL
  expiry test is `advance(600_001)`, not a ten-minute sleep.
- `fsSandbox()` — per-test scratch directory + cleanup; all config, journal,
  and lock tests operate inside it.
- **Importing the harness sanitizes the environment.** Every ambient `TT_`
  variable is deleted at import, so a developer with `TT_ACCESS_TOKEN`
  exported in their shell runs the same suite CI runs — `withEnv` only
  restores the keys it was handed, so it cannot undo pre-existing ones. The
  single opt-out is `TIKTOK_MCP_TEST_INHERIT_ENV=1`, set automatically for the
  children of the multi-process harness (which receive their env file and
  `TT_OAUTH_BASE_URL` that way). It is deliberately outside the `TT_`
  namespace so it cannot be mistaken for a product setting, or stripped by the
  loop it guards.

### Extended harness (`test/harness/` — supporting, not contract)

- **Upload simulator** — a scriptable dispatcher plugged into `withFetch`
  (no real sockets). It parses each PUT's `Content-Range`, rejects any range
  whose first byte ≠ bytes accepted so far (one rule enforces sequential,
  contiguous, gap-free upload), buffers every request body, and on
  `assertComplete()` verifies: concatenated bodies byte-equal the source
  file, no PUT after the final 201, no `Authorization` header on any PUT,
  and every scripted failure entry was consumed (so a test that expects a
  retry *proves* the retry happened). Per-chunk scripts inject 5xx, 4xx,
  416, 403, and hangs (paired with `mockClock` driving
  `TT_UPLOAD_TIMEOUT_MS`).
- **Seeded RNG** — mulberry32-style `makeRng(seed)`; consumed by backoff
  jitter (the pinned-sequence test) and handed to fast-check as its seed. The
  first values for a given seed are pinned by a test: a printed seed is only
  a reproduction recipe while the arithmetic is stable.
- **Deferred promises** — for asserting in-flight states (e.g. single-flight
  refresh: two concurrent calls, one pending fetch). `flush(turns?)` turns the
  event loop without consuming wall-clock time; it is not a sleep, and a test
  that needs *time* uses `mockClock().advance(ms)`.
- **OAuth token stub** — `startTokenStub()` runs a real `node:http` server on
  port 0 for the tests that cross a process boundary. It answers the **flat**
  OAuth shape (TIKTOK-API § 1.2 / CC-A12), never the envelope, and rotates
  both tokens with an increasing serial so a duplicated refresh is visible as
  two different serials rather than as an equal count.
- **Self-tested.** `test/harness.test.ts` checks each of these in both
  directions — that it accepts correct behaviour *and* rejects the specific
  wrong behaviour it exists to catch. A silently broken simulator does not
  fail; it passes tests that should have failed, and no downstream suite can
  detect that.

### Multi-process env-lock harness

The env-file lock (`core/env-lock.ts`, `withEnvLock`) is tested in two
layers; both are mandatory (rationale: SYNTHESIS § 2.2).

**Unit seam — deterministic, milliseconds fast.** `withEnvLock` with an
injected clock inside an fs sandbox:

- contention: pre-create the `<envfile>.lock` directory → caller waits with
  jitter, then times out with `env_file_busy` (after the caller's
  re-read-once obligation);
- stale lock: age the lock dir's mtime past `staleMs`, advance the mock
  clock → lock removed + re-acquired with a logged warning;
- heartbeat: while the critical section runs, the lock dir mtime is touched
  every `heartbeatMs` on the injected clock (so a long refresh is never
  stolen mid-flight);
- release: lock dir removed on success and on throw.

**One real race — genuine OS semantics.** Real child processes (at minimum
two) contend for the mkdir lock against the compiled build:

- the parent starts a local token stub (plain `node:http` on port 0) that
  counts refresh calls and returns rotated tokens with a serial number, and
  writes a shared near-expiry env file in the sandbox;
- children barrier on IPC (`ready`/`go`) to maximize contention, each runs
  the refresh path and reports its token serial;
- assertions: the stub saw **exactly one** refresh; every child ends on the
  same rotated serial; the env file parses and contains that serial; no lock
  directory is left behind. The whole test runs under an
  `AbortSignal.timeout` deadlock canary.
- Requires the test-only `TT_OAUTH_BASE_URL` override (internal,
  unsupported) so the children's token-endpoint calls reach the stub —
  cross-process fetch cannot otherwise be redirected.

The mechanics live in `runContendingChildren` (`test/harness/multi-process.ts`),
which forks `harness/lock-child.ts` — never the worker directly — so every
worker inherits the same barrier protocol. A worker is an ESM module in
`harness/workers/` default-exporting `(ctx) => unknown`; whatever it returns is
structured-cloned back as a `ChildOutcome`. A worker that **throws** is a
reported outcome (`ok: false`), not a harness error: the losing children *are*
the expected result. The runner rejects only when the barrier itself fails or
the canary fires, and SIGKILLs any survivor on the way out.

The barrier is load-bearing. Without it the first child forked has a head start
measured in tens of milliseconds — long enough to complete the whole refresh
before the second child has finished loading Node, so "exactly one refresh
happened" would pass while proving nothing. `harness.test.ts` pins the unlocked
baseline this test contrasts with: two children with no lock produce **two**
refreshes and two different serials.

Gate: blocking on the ubuntu leg, advisory on macOS/Windows until Phase 3
proves stability.

### Recorded sandbox fixtures

Every API-shape assertion elsewhere in this suite is written by hand against the
fetch stub, and that caps what the suite can prove: a hand-written envelope
shows that our parser accepts what we *believe* TikTok sends, never what TikTok
actually sent. A recorded fixture is the missing half — real bytes, captured
once, replayed on every run — so "TikTok's envelope drifted" becomes a red test
instead of a support thread, and "our payload drifted" is caught by the same
file from the other side.

**The machinery is built; the tree is empty.** `test/fixtures/recorded/` does
not exist until someone with sandbox credentials runs the recorder, and an
empty tree is the expected state until then. What that costs is stated
explicitly below, because a suite whose only evidence is "zero fixtures, zero
failures" is a suite that cannot fail.

#### The format

`test/fixtures/recorded/<area>/<name>.json`, one interaction per file, one
`<area>` per API surface (`auth`, `user`, `video`, `publish`, `upload` — a
closed set, so a typo is a validation failure rather than a silently unreplayed
directory). `scripts/lib/fixtures.ts` owns the shape, the sanitizer and the
discovery, and it is the one module the recorder, the sanitizer and the replay
test all read, so the three cannot drift apart:

```jsonc
{
  "schema": "tiktok-mcp/fixture@1",
  "recordedAt": "2026-08-22T16:06:13.888Z", // ISO-8601 UTC; feeds staleness
  "area": "user",
  "name": "user-info-basic",
  "endpoint": { "method": "GET", "host": "…", "path": "/v2/user/info/" },
  "request": { "url": "…", "headers": { … }, "body": null },
  "response": { "status": 200, "headers": { … }, "body": { … } }
}
```

Two additions to the sketch this section used to carry. `response.headers` is
part of the format because the chunked-upload path answers with a bare status,
a `Content-Range` and *no body at all* — a body-only fixture cannot express the
one interaction most worth recording, and `Retry-After` is the same story on the
retry path. And `endpoint` is redundant with `request.url` by construction: it
exists so a reader can see what was called without parsing a query string, and
the parser enforces that the two agree.

Raw and sanitized files share one shape. The only difference is which directory
they live in.

#### Recording — `npm run fixtures:record`

Local-only, and it **refuses to run in CI** before it reads a credential or
opens a socket: a recorder that ran on a runner would either fail for want of an
account or, far worse, succeed against one. It taps `globalThis.fetch`, drives
the real `api/` functions against a real profile, and writes every observed call
to `.fixtures-raw/<area>/<name>.json` at mode `0600`.

The capture catalog is **read-only by construction** — `--list` prints it with
the reason each entry earns a fixture. Nothing in it posts, uploads or deletes,
because the script is run by a human against a real account, usually more than
once while getting the captures right, and a catalog that could post would
eventually post twice. The consequence is that the `upload/` fixtures and the
publish ones beyond `creator_info` land the other way: a supervised sandbox
publish is captured by hand, edited into this same format, and put through the
sanitizer like everything else.

`.fixtures-raw/` is gitignored and stays that way. It holds live access tokens,
real `open_id`s and a usable `upload_url`; nothing in it is ever committed.

#### Sanitizing — `npm run fixtures:sanitize`

The committed tree is *defined* as the output of one pure function over the raw
captures. That is the whole point: hand-redacting a capture is how a token
ships, because the diff looks plausible either way and nothing distinguishes a
field that was cleaned from one that merely looked clean.

| In a raw capture | In the committed file |
| --- | --- |
| access / refresh token, client key & secret, PKCE verifier | `<ACCESS_TOKEN>`-style placeholder (JSON position) or bare `REDACTED` (query/form position) |
| `open_id`, `union_id`, display name | stable, shape-preserving HMAC pseudonym |
| `log_id` | shape-preserving fake |
| `upload_url` | synthetic host, `upload_token=REDACTED` |
| everything else — including TikTok's `error.code` | verbatim |

That last row is load-bearing. In JSON position `code` is TikTok's own error
code (`spam_risk_too_many_posts`), which is the single field the replay contract
exists to assert on; only the OAuth authorization `code`, which appears solely
as a query or form parameter, is a credential. `src/core/redact.ts` allowlists
the same name for the same reason, and runs as the sanitizer's last pass — a
safety net under the explicit transforms, not a replacement for them.

Two properties worth stating, because they look like one property and are not.
The sanitizer is **stable**: the same raw capture always renders to the same
bytes, which is what keeps a fixture diff reviewable. It is deliberately **not
idempotent**: a pseudonym is by construction indistinguishable from a real
value, so a second pass re-pseudonymizes it. Nothing needs it to be — the
sanitizer only ever reads `.fixtures-raw/`.

The script refuses to write a file that still matches a secret shape, in either
mode, and reports every problem in one pass rather than stopping at the first.
The fix for a refusal is a new rule in `scripts/lib/fixtures.ts` — never a
hand-edit of the output, which would put the committed tree back outside the
transform. `--check` writes nothing and answers the other question: is the
committed tree still exactly what the raw captures sanitize to? That is what
catches a fixture edited by hand after it was generated. `--only=<name>` narrows
either mode. Nothing is ever deleted; an orphaned committed fixture is reported
and left alone.

#### The replay contract — `test/fixtures-replay.test.ts`

`test/harness/fixtures.ts` turns a fixture back into a real round trip through
the production code. Both directions come out of a *single* call, which is not a
coincidence: `core/http.ts` reads `globalThis.fetch` off the global at call time
and `src/api/*` exports no standalone response parser, so driving the api
function against a scripted stub is the only seam there is — and it is the seam
that makes the request assertion available in the same breath. (The section
previously described replaying `response.body` "through the `api/` parsers" as
though a standalone parser seam existed. It does not.)

The response half asserts the api function reaches a verdict rather than
crashing on shape — a fixture that records an upstream rejection is legitimate
and valuable, so a `TikTokError` is a pass. The request half compares what our
client produced against the recording: method, origin and path exactly; the
query as a set, since parameter order is contract on neither side; `accept` and
`content-type` exactly, `authorization` by shape (the fixture holds a
placeholder — comparing values would compare the sanitizer against the harness),
and the *absence* of `authorization` where it must be absent. Bodies compare
structurally, with **booleans and numbers keeping their values** (a flipped
`disable_comment` is exactly the silent drift this exists for) while strings
collapse to their type, because a sanitized fixture holds pseudonyms and
reporting those as drift would report the sanitizer's own work.

An endpoint no route covers is a **loud failure**, not a skip: a recorded
interaction nobody replays looks exactly like a verified one. The two exemptions
are named, with reasons, in `NON_REPLAYABLE_AREAS` — `auth/` (form-encoded,
outside the `{data,error}` envelope, owned by `test/oauth.test.ts`) and
`upload/` (a pre-signed PUT on another origin, owned by
`test/api-upload.test.ts`). Both are still recorded, sanitized, round-tripped
through the format and scanned for secrets; only the replay assertion skips
them.

#### What holds while the tree is empty

- The harness proves itself on synthetic fixtures: a clean round trip, and one
  test per drift it must detect (a dropped field, a changed number, a flipped
  flag, a changed method, a changed path, a recorded error envelope, an
  unrouted endpoint, a non-replayable area).
- The tree-wide test counts those self-tests and **fails if they did not all
  run**, so "zero fixtures" can never be mistaken for "verified". It also warns,
  by name, that nothing is being replayed.
- The secret-shape meta test scans **every file** under the tree — at any depth,
  whatever its extension — not just the `<area>/*.json` the loader reads. A
  `.bak` from a hand-edit or an editor swapfile is committed like any other
  file, and a leak does not have to be well-formed. A non-vacuity test proves
  the scanner still fires on a hand-written token and stays quiet on the
  sanitized spellings.

#### Refreshing

Re-record on a TikTok API version bump, on each sandbox pass, or when a probe
resolves a spec marker. `recordedAt` feeds an advisory staleness warning after
180 days — a warning, never a failure: a fixture going stale is a prompt to book
sandbox time, and a red suite on a date arithmetic helps nobody. Run
`fixtures:record`, then `fixtures:sanitize`, then review the diff like code.

## What must be covered (per area)

### core/oauth

- Proactive refresh inside the skew window; single-flight under concurrency
  (two parallel calls → exactly one refresh request, asserted while pending
  via a deferred fetch).
- Refresh-token **rotation**: the new refresh token is persisted **before
  first use** of the new access token (cc-a1/cc-a2), under the env lock.
- 401 → exactly one forced refresh + one replay, idempotent requests only;
  a second 401 is terminal (no loop).
- `invalid_grant` → re-read the env once under the lock; a newer token found
  → adopt + retry once; else terminal error naming the `login` command.
- Persist failure (read-only dir) → session continues on the in-memory
  token + loud stderr warning; a valid token is never discarded.
- PKCE: pinned hex vector (known verifier → exact 64-char lowercase-hex
  challenge, with a comment explaining the TikTok deviation from RFC 7636);
  property: challenge is always 64 lowercase hex chars.

### core/env-lock

Both harness layers above; plus: lock/persist failure degrades, never fails
a tool call; on wait timeout the caller re-reads the env once and adopts a
rotated token before surfacing `env_file_busy`; the journal never takes
this lock.

### core/http

- Envelope rule: HTTP 200 + `error.code !== "ok"` → `TikTokError` with
  apiCode and log_id preserved; non-JSON/empty bodies tolerated with defined
  errors. The envelope decoder is **not** applied to OAuth responses (flat
  shape) or upload-host PUT responses (raw HTTP).
- Retry matrix — **three classes** (rationale: SYNTHESIS § 2.13):
  - `read`: 429/5xx/network retried with backoff; `Retry-After` honored and
    capped; stops at the retry budget.
  - `init`: **never** retried — not on 429, not on 5xx, not on network
    error (CC-B4/CC-B5/CC-B8).
  - `chunk`: 5xx/timeout retried in-call 1 + `TT_CHUNK_RETRIES` with an
    **identical** `Content-Range` (officially retryable class); 4xx
    terminal; 403 = expired upload URL → terminal, no auto-re-init
    (CC-D5); 416 → resync from `uploaded_bytes` (CC-D6).
- Host guard (rationale: SYNTHESIS § 2.5): a URL is accepted iff https,
  port 443, no userinfo, and host is exactly `open.tiktokapis.com`, exactly
  `open-upload.tiktokapis.com`, or matches
  `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$`. Mandatory negatives:
  `eviltiktokapis.com`, `open.tiktokapis.com.attacker.tld`, userinfo, IP
  literals, port ≠ 443, plain http. Bare `endsWith` is banned — a property
  test generates hostnames and asserts acceptance iff the grammar matches.
  Any rejection happens **before** fetch runs (stub not called); rejected
  URLs are logged origin + path only, query stripped.
- Auth header discipline: bearer present on API calls; **absent** on OAuth
  calls and on all upload PUTs (the `upload_token` in the URL is the
  credential and a registered secret).
- Local rate limiting (rationale: SYNTHESIS § 2.12): publish inits use a
  per-profile token bucket 6/min with continuous refill (1 token / 10 s, on
  the injected clock — `advance(10_000)` refills exactly one). The 7th init
  in a minute is **rejected locally**: `local_rate_limited` +
  `retry_after_s` + absolute `retry_at`, zero network, never sleeps; the
  preview still succeeds and shows bucket occupancy. Read buckets (status
  polls, `creator_info`) **delay** instead of reject, bounded by the poll
  budget / `TT_TIMEOUT_MS`. Upstream 429 on an init remains terminal.

### core/config + settings

- Env-file resolution precedence (`TT_ENV_FILE` → XDG on POSIX →
  `%LOCALAPPDATA%` on win32, platform injected); atomic + comment-preserving
  rewrite; profile parsing (`TT_PROFILE_X_*`); torn-read impossibility
  (snapshot swap); read-merge-write preserves unknown keys byte-exactly.
- Platform-gated permission asserts: `0600` file / `0700` dir modes asserted
  **only** when `process.platform !== "win32"`; the win32 leg asserts
  existence + content round-trip, with a **named** chmod-skip reason. A
  hygiene sweep fails any `skip(` without a reason string.
- win32 EPERM/EBUSY rename (injected fs error) → bounded retry ×3 then
  degrade to in-memory token + warning (CC-H3).
- `TT_MEDIA_ROOT`: realpath containment (root and candidate), the
  `/media` vs `/media-evil` prefix-collision negative everywhere; the
  symlink-escape negative POSIX-gated with a named skip reason.

### api/* — including the chunk plan (CC-D2)

- Field-set construction (`fields` in query string), cursor pagination
  (`has_more`/`cursor` passthrough, `fetch_all` cap + `truncated` flag),
  scope-based field filtering for user info.
- **Chunk plan (`planChunks`)** — the **decimal algorithm** normative in
  `docs/TIKTOK-API.md` (rationale: SYNTHESIS § 2.4). The former claim that
  "every chunk is 5–64 MB" is **struck as factually wrong**: the final chunk
  absorbs the remainder and may legally reach **127,999,999 bytes**, and a
  64,000,001-byte file produces a single chunk *larger than its declared
  chunk_size*. The correct, tested property set:
  - `size < 5,000,000` → exactly one whole-file chunk
    (`chunk_size = size`) — the only legal sub-5 MB shape;
  - otherwise `chunk_size = min(size, 64_000_000)`,
    `total_chunk_count = floor(size / chunk_size)`, and the **final chunk
    absorbs the remainder**;
  - invariants (property-based, fast-check, sizes drawn from 1 byte up to
    the 4 GiB cap): `1 ≤ total_chunk_count ≤ 1000`; every non-final chunk
    is exactly `chunk_size`; the final chunk length is in
    `[chunk_size, 127_999_999]`; ranges are contiguous and disjoint,
    starting at 0 and ending at `size − 1`; chunk lengths sum to the file
    size; every `Content-Range` denominator equals the file size.
  - **Vectors V1–V8** (the worked table in `docs/TIKTOK-API.md`) are the
    canonical table-driven fixture: assert `chunk_size`,
    `total_chunk_count`, and the full `Content-Range` sequence byte-exactly
    — including V3 (TikTok's own worked example, 50,000,123 bytes → 5
    chunks) and V5 (64,000,001 bytes → one chunk exceeding the declared
    chunk_size).
  - Decimal boundary pins (unit tests): 4,999,999 (whole-file) · 5,000,000
    (single chunk) · 64,000,000 (single chunk) · 64,000,001 (one merged
    chunk) · 127,999,999 (one chunk — the maximum legal chunk length) ·
    128,000,000 (2 × 64,000,000 exactly) · 128,000,001 (final chunk
    64,000,001) · 4,294,967,296 = 4 GiB (accepted, 67 chunks) ·
    4,294,967,297 (rejected locally before any init).
- Chunk **execution** (upload simulator): `Content-Range` headers exactly
  match the plan; strictly sequential PUTs; scripted 500 on chunk *k* →
  same byte range re-PUT then continue to 201; retry budget exhausted →
  `upload_failed` carrying publish_id + failed range; 4xx terminal
  immediately; 403-after-TTL (clock-driven) terminal with re-plan guidance
  and no retry storm; concatenated received bodies byte-equal the source
  file (streamed — RSS stays bounded, advisory).
- Status polling: poll loop on the mock clock; **terminal-beats-deadline**
  (a terminal response in flight when the deadline fires still wins);
  **timeout-is-not-error** — the timeout result is `ok:true` carrying the
  **last observed** status (never a synthetic `"timeout"` status: TOOLS.md
  §§ 2.7/3.6 make the deadline a property of the call, not of the post) and
  `publish_id` **always** present, plus the exact follow-up hint
  (rationale: SYNTHESIS § 2.3).

### mcp/*

- Manifest snapshot test — any tool-surface change (names, schemas,
  `wait_for_completion` defaults) must touch the committed fixture.
- `.strict()` sweep: unknown argument → validation error on every tool.
- **Plan lifecycle** (no `apply` boolean — rationale: SYNTHESIS § 2.8):
  a call without `plan_id` is a preview — **zero** write-endpoint fetches
  (stub asserts), preview contains creator info, the exact resolved payload,
  and a fresh `plan_id`. A call with `plan_id` executes: re-resolve →
  digest → verify → **consume before init dispatch**. Tests: second use of
  a consumed plan → `plan_not_found`; TTL expiry via
  `advance(TT_PLAN_TTL_S · 1000 + 1)` → `plan_not_found`; any mutated
  payload / wrong profile / wrong tool → `plan_mismatch`; digest property
  tests: key order and absent-vs-undefined never change the digest, any
  value change does (`canonicalJson` is the single hashing function).
  `TT_WRITE_MODE=deny` → publish-write package unregistered, reads intact;
  `=apply` → `plan_id` optional (documented operator opt-out).
- **Journal — append-only WAJ** (rationale: SYNTHESIS § 2.7): the intent
  record is fsync'd and appended **before** the init request; the outcome
  record is appended on response or terminal upload failure. Records are
  never updated in place. Tests: simulated crash between intent and outcome
  → the read surface derives `unknown` (intent-without-outcome);
  `send_ambiguous` presented as `unknown` by the journal tool; torn/garbage
  tail line skipped and counted; rotation at `TT_JOURNAL_MAX_BYTES` with
  one `.1` generation, readers merge both; append failure → warning +
  `journal:"unavailable"` on the result, never a publish failure; duplicate
  guard reads a bounded tail of the active generation only, `force:true`
  overrides, `error`/`upload_failed` outcomes exempt.
- Redaction: a result/log/error artificially seeded with tokens (including
  `upload_token` and full `upload_url` query strings) comes out scrubbed;
  idempotence property; over-redaction guard (publish_id, open_id-shaped
  strings, titles survive).
- Result truncation: over-budget payload → `truncated` marker, valid JSON,
  never a mid-surrogate cut; `ok`/`error`/`hints` fields never truncated
  away (CC-G7).

### tools/*

- Handler behavior with mocked api layer: privacy_level not among the
  creator's live options → local validation error, no init call;
  `brand_content_toggle` + `SELF_ONLY` → local reject; missing scope →
  `[UNAVAILABLE]` marker logic + fast local error with zero fetches.
- `wait_for_completion` defaults frozen in the manifest: `false` on all
  four write tools, `true` on `tiktok_get_publish_status`; the status
  tool's bounded wait is tested under the mock clock (see api/* polling).
- Hint sweep: no emitted hint string contains upstream free-text
  (fixture-driven; trust boundary).

### Sync gates and repo meta

`npm run sync` runs every gate in check mode and reports all of them before
failing, so one run lists everything to regenerate rather than one thing at a
time; `npm run sync:write` regenerates instead of complaining. Each generator
is also its own script (`npm run docs:readme`, `npm run docs:env`) for the
common case of touching one thing.

- `readme-sync`: the README tool table equals `describeAllTools()` output.
  The table carries the *first sentence* of each description; the full,
  model-facing text lives in `docs/tool-manifest.json`, because pasting whole
  paragraphs into table cells produces a README nobody reads.
- `env-docs-sync`: `.env.example` equals the CONFIGURATION.md variable
  table equals the settings source. Split in two: the generator
  (`scripts/gen-env-example.ts`) renders every shown default by calling
  `loadSettings`, and asserts its hand-written prose spec covers exactly
  `knownSettingVars()` — so a new `TT_` variable cannot land undocumented,
  nor a deleted one linger. The CONFIGURATION.md half stays in
  `test/settings.test.ts`.
- Manifest snapshot: `docs/tool-manifest.json`, generated against a synthetic
  fully-authorized profile so it describes the server rather than the machine
  that ran it.
- `serverjson-sync`: the MCP-registry manifest is **checked, never written** —
  `server.json` is hand-curated and `npm run sync:write` deliberately leaves it
  alone, so this gate reports in both modes. It compares only the facts
  `server.json` restates from a live source: name ⇄ `mcpName`, version ⇄
  `package.json`, repository URL, the "N tools" claim ⇄ `allTools().length`,
  the single npm package entry (registry type, identifier, version, transport
  ⇄ the default `TT_TRANSPORT`), and the declared environment — every variable
  must be one `knownSettingVars()` returns, the two credential variables must
  be `isRequired` + `isSecret`, and nothing else may be required. What it does
  *not* check is written into the gate's own failure text: JSON-schema
  validity, whether the variable list is *complete*, the wording of the
  description, and whether a non-credential variable ought to be secret.
- **Pack audit**: `npm pack --dry-run --json` file list equals the
  committed `pack-manifest.json` fixture; no install scripts in
  `package.json`. Paths only — never sizes or integrity hashes, which change
  on every build and would make the fixture noise.
- Build freshness: newest `src/`, `test/` or `scripts/` mtime ≤ newest
  `build/` mtime, else "run build" — the tests execute compiled output, so a
  stale `build/` is a green run of the previous commit.
- Hygiene sweep: tests use scratch dirs + injected ports only; every
  platform skip carries a named reason.

Two invariants a byte comparison cannot check live in `test/manifest.test.ts`
next to the generators' own unit tests: that a described tool never carries an
`[UNAVAILABLE …]` marker or a diverging `outputSchema`, and the
`PACKAGE_SCOPES` drift gate (every scope a registered tool declares is
requested by its package; every requested scope is one this server knows).

## Coverage floors and ratchet

`c8` has no per-directory thresholds, so a small gate script
(`scripts/coverage-gate.ts`, run as `npm run coverage:gate`) reads
`coverage/coverage-summary.json` — the `json-summary` reporter, whose
per-file totals are the post-source-map numbers the text reporter prints —
and applies this table (stored as `scripts/coverage-floors.json`, consumed by
both the gate and its self-tests in `test/manifest.test.ts`):

| Area | Lines | Branches | Functions |
|---|---|---|---|
| `core/oauth`, `api/upload`, `mcp/plan-store`, `core/redact` | 95 | 90 | 100 |
| `core/http` | 92 | 88 | 100 |
| `core/config` + `core/settings`, `mcp/journal` | 92 | 85 | 100 |
| `api/*` (rest) | 90 | 85 | 95 |
| `mcp/*` (rest), `tools/*` | 90 | 80 | 95 |
| `cli/*` (advisory in Phase 0, blocking from Phase 1) | 85 | 75 | 90 |
| **global** | 90 | 80 | 95 |

**Ratchet policy:** at each phase exit every floor rises to
`max(floor, achieved − 2)` — `node build/scripts/coverage-gate.js --ratchet`
rewrites the table in place. Floors are never lowered except by a commit
whose message carries a review note; a raise lands in the same change that
raised the coverage.

Repo tooling under `scripts/` is excluded from the coverage report
(`.c8rc.json`): its floors would be a quality signal about the build, not
about the server. What that buys is a working alarm — a `src/` file matched
by no rule is reported by name as "covered by the global floor only", which
is otherwise indistinguishable from a file nobody thought about.

## CI matrix and gates

| Leg | Node | Role |
|---|---|---|
| ubuntu | 22 | **blocking** |
| ubuntu | 24 | **blocking** |
| macos | 24 | **blocking** |
| windows | 24 | **blocking** |
| ubuntu | 26 | advisory, **without coverage** — c8 is broken on Node ≥ 25 |

`engines` is `>= 22`; `.nvmrc` pins **24** (the development and primary CI
version). The Windows leg is blocking from the first CI landing (Phase 0)
and runs *real* assertions — path resolver, journal writes, rename-retry —
never silent skips. The coverage gate runs inside `npm run check`
(typecheck → lint → build → test → coverage → sync gates) from Phase 0.

Blocking/advisory split:

- **Blocking on every leg:** all unit/property/contract/meta suites, sync
  gates, pack audit, in-process stdout purity.
- **Blocking on ubuntu, advisory on macOS/Windows until Phase 3:** the
  child-process suites (multi-process lock race, spawned-server stdout
  purity, login e2e).
- **Advisory everywhere:** RSS-bound streaming heuristic, doctor
  latest-version check, injected win32 EPERM retry, coverage-table
  self-test, fixture-staleness warning.
- **Property-test budget:** 200 runs per property in PR CI; 2,000 runs in a
  nightly scheduled workflow (non-blocking; failures file issues with the
  printed seed).
- `npm audit` is **not** part of the blocking gate — blocking gates must be
  deterministic functions of the repo state, and a live advisory DB is not.

**Packed-artifact smoke — the `smoke-pack` job, on ubuntu + macOS + Windows.**
`npm run check` proves the repository, and the `pack-audit` gate proves *what*
the tarball contains (`pack-manifest.json`); neither one proves the published
artifact runs. `scripts/smoke-pack.ts` (`npm run smoke:pack`) packs the tree
into a temp directory, installs that tarball into a second temp prefix outside
the repo (`--omit=dev --ignore-scripts`) and then drives the *installed*
binary: `--version` prints the packaged version, `--help` prints the usage,
an unknown subcommand exits `2`, and a real JSON-RPC handshake over stdio —
`initialize` → `notifications/initialized` → `tools/list` — has to answer with
the server identity read back out of the packed `package.json` and a non-empty
tool list. The child is spawned with a synthetic `HOME` and a `TT_ENV_FILE`
pointing at an empty env file, never the ambient environment, so what it
proves is the zero-credential boot a first-time `npx` user gets: nothing
configured, the server still starts and still lists its tools, every unmet
scope carrying the `[UNAVAILABLE]` marker (§ TOOLS.md 6.1). All three OSes,
because the failures it catches — a file missing from `files`, a path that
only resolves in the repo layout, a win32 shim difference — are
platform-shaped. It is deliberately **not** part of `npm run check`: it
installs from the network, and `check` stays offline-safe and fast.

**On a tag only** — `npm run release:guard` in `publish.yml`, before anything
is published: the pushed tag, `package.json`, `server.json` (top level *and*
the npm package entry), `.claude-plugin/plugin.json`, `extension/package.json`
and the topmost `CHANGELOG.md` heading must all name the same version, and
that heading must not be `Unreleased`. It is deliberately **not** part of
`npm run check`: as an always-on gate it would be red on every commit between
releases, which is the state a healthy repo spends its life in. `npm run sync`
therefore lists it under "checked elsewhere". Its logic is
plain functions over parsed inputs, so `test/release.test.ts` exercises the
failure messages directly rather than shelling out to CI.

`npm run smoke:pack` runs on a tag as well — the same script, the last step
before `npm publish`, ubuntu only because the three-OS spread already ran on
the commit being tagged. It needs no registry credentials, so it adds no
second authentication surface to a workflow whose whole point is that it
carries no token.

## stdout purity (CC-G3)

The MCP stdio transport owns stdout; one stray `console.log` corrupts the
protocol stream. Four layers, cheapest first:

1. **Static:** ESLint `no-console` ban across `src/` (the static half —
   `console.log` and friends cannot compile into the server). All
   diagnostics go to stderr through the redacting logger.
2. **In-process:** instrument `process.stdout.write` during import,
   registration, and a tool call → zero non-protocol writes. The `dotenv`
   tip-line regression this originally guarded is now structurally impossible:
   `core/config` parses the env file itself and the package ships no `dotenv`
   dependency, so no library gets an import-time chance to print.
3. **Spawned:** boot the compiled server on stdio as a child process, run
   `initialize` + `tools/list` + invoke a tool, and assert **every** stdout
   line parses as a JSON-RPC protocol frame — nothing else, including
   transitive-dependency writes at import time. (Blocking on ubuntu,
   advisory elsewhere until Phase 3.)
4. **Packed:** the `smoke-pack` job repeats that assertion against the
   *installed tarball* instead of the repo build — `initialize` +
   `tools/list`, every stdout line has to parse as a JSON-RPC frame — on all
   three OSes and blocking on each. Layer 3 can only see what the repo layout
   imports; this one sees what a user's `node_modules` actually loads.

## Sandbox probes and the probe log

CI never talks to TikTok — all network is mocked, and the MCP Inspector
(`npx @modelcontextprotocol/inspector node build/src/index.js`, see
[CLIENTS.md](CLIENTS.md#mcp-inspector)) is the manual smoke-test harness.
Questions the spec
cannot answer from documentation are settled empirically by the
**sandbox probes P-1..P-14** (enumerated in SYNTHESIS § 6 and referenced
from the spec docs), executed in **Phase 2 (task TD-7 / WP-2.6)** against a
real sandbox app. Sandbox constraint: probes run **SELF_ONLY** only —
the sandbox cannot post publicly; the Phase-2 exit gate is a SELF_ONLY
end-to-end pass.

**Probe-log convention.** Every executed probe gets one entry in
`docs/probes/PROBE-LOG.md`:

- **date** the probe ran;
- **request/response summary**, redacted with the same sanitization rules
  as recorded fixtures (never raw tokens, ids, or upload URLs);
- **conclusion** — the empirical answer, stated plainly;
- **spec impact** — which spec doc/contract changes as a result, or
  explicitly "none". A probe result that contradicts the spec flows through
  the contract-change process; it is never folded in silently.

P-15 is an engineering spike (undici resolve-and-pin prototype behind the
lookup seam), not a sandbox probe; P-16 is optional tuning. Neither blocks
Phase 2. Sandbox runs also drive the recorded-fixture refresh procedure
(see the harness section).
