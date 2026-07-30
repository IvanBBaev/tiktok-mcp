# Round-2 Synthesis — Lead Reviewer (binding)

Date: 2026-07-22. This document is the single authoritative resolution of the
round-2 review cycle. Every conflict below ends in exactly one chosen design;
the spec edits in § 4 make that design normative. Where a review and this
synthesis disagree, **this synthesis wins**.

Citation shorthand: `arch` = `architecture-deep-review.md`, `sec` =
`security-deep-review.md`, `plat` = `tiktok-platform-deep-review.md`, `qa` =
`qa-deep-review.md`, `devops` = `devops-deep-review.md`, `aidx` =
`ai-dx-deep-review.md` (all in `docs/reviews/round2/`). `WP-x.y` = work
packages in `docs/IMPLEMENTATION-PLAN.md`; `CC-*` = `docs/CORNER-CASES.md`.

---

## 1. Scope & method

**Inputs, in priority order:** the six round-2 deep reviews (read in full);
`docs/IMPLEMENTATION-PLAN.md` (8 decision points + risk register) and
`docs/CORNER-CASES.md` (open-items table); the spec corpus (`README.md`,
`docs/*.md`) and the round-1 reviews as context only.

**Adjudication criteria**, applied in this order when positions conflict:

1. **Platform facts beat design preference.** A documented or observed TikTok
   behavior (chunk math, regional hosts, retryable 5xx on chunk PUTs, hex
   PKCE) overrides any internally elegant design that contradicts it.
2. **Testability and fail-safety beat elegance.** A mechanism that cannot be
   deterministically tested (live-DNS pinning) or that fails dangerously
   under crash/timeout (in-place journal updates, long-blocking write calls)
   loses to the duller mechanism that fails safe.
3. **Strictest-safe default wins for write paths.** Where two defaults are
   both defensible, the one that cannot produce a duplicate post, a lost
   credential, or an unaudited egress wins.

**Method:** all distinct findings were deduplicated into the register (§ 3);
the eight known conflicts plus five additional divergences found during
cross-reading were each resolved with one binding decision (§ 2); every
decision maps to concrete spec edits (§ 4) and closes the plan's decision
points and the corner-case open items (§ 5). Runtime questions no review can
answer from documentation are consolidated into the probe list (§ 6).

---

## 2. Binding conflict resolutions

### 2.1 Windows secret protection

**Positions.** sec §2.7: support Windows by relying on the default DACL of
`%LOCALAPPDATA%\tiktok-mcp-ai` (per-user profile ACLs ≈ 0600 for the stated
adversary); `icacls` hardening optional, not a v1 blocker. devops §3 (R2-F1
context, CC-H3 owner): full functional support; `fs.chmod(0o600)` is a
harmless no-op on win32; **never** spawn `icacls` automatically; doctor
prints the `icacls` command as remediation text only; `%LOCALAPPDATA%` (not
Roaming); EPERM/EBUSY rename retry; Windows CI leg blocking from Phase 0.

**THE DECISION.** Full Windows support per **devops §3 items 1–9, adopted
verbatim as the normative spec**, with sec §2.7's platform-gated tests folded
in. Concretely: write target `%LOCALAPPDATA%\tiktok-mcp-ai\.env` (resolver:
`TT_ENV_FILE` → `$XDG_CONFIG_HOME`/`~/.config` on POSIX,
`%LOCALAPPDATA%` on win32); `fs.chmod(path, 0o600)` called unconditionally on
all platforms, mode *asserted* only when `process.platform !== "win32"`
(win32 assertion: file exists + content round-trips, with a named chmod-skip
reason in the test); directory `0o700` on POSIX, inherited profile ACLs on
win32; no automatic `icacls`, ever — doctor check 4 prints the profile-ACL
info line and the optional `icacls` command as text; rename-onto-open-handle
retried ×3 (50/100/200 ms) then degrade to in-memory-token + warn; no
`os`/platform guard in `package.json`; Windows CI leg blocking from the first
CI landing (WP-0.2).

**Rationale.** The two round-2 positions actually converge — security already
concedes automation is unnecessary for the stated adversary (other local
users), and the aws-cli/gcloud/gh precedent (devops §3) shows
profile-ACL-plus-documentation is the established norm for npx-class tools.
Automating `icacls` fails criteria 2 (locale-dependent output, OneDrive/
roaming/non-NTFS breakage) for no adversary-model gain.

**Consequences.** SECURITY.md gains the "Windows token storage" paragraph;
CONFIGURATION.md gains the win32 resolver column; TESTING.md gains
platform-gated permission asserts and the win32 EPERM retry test. Lands in
WP-0.2, WP-0.4; closes CC-H3.

### 2.2 Env-file lock protocol

**Positions.** arch §3.2 (N2): `O_EXCL` lock *file*, mtime heartbeat every
2 s, staleness 15 s, token-endpoint call made **under** the lock, wait up to
30 s then `env_file_busy`. devops §2a (R2-F4): `mkdir` lock *directory*
(atomic everywhere, robust on network FS), 5 s staleness, **no** heartbeat,
lock covers only the file mutation, never the network call; degrade like
persist failure, never fail a tool call. sec §2.4: lock must wrap the whole
read-latest→refresh→persist→swap sequence. qa §5c: two-seam harness
(`withLock(path, fn, {timeoutMs, staleMs, clock})` + exactly one real
child-process race, OAU-16) regardless of mechanism.

**THE DECISION.** A hybrid taking devops's *mechanism* and arch/sec's *scope
and liveness policy*:

- **Acquisition:** `fs.mkdir("<envfile>.lock")` — atomic on all platforms
  and network filesystems. Lock-dir content (a JSON file inside with
  `{pid, hostname, createdAt}`) is diagnostic only; **liveness is mtime-only,
  never PID-based**.
- **Scope:** the lock covers the full refresh critical section — re-read env
  (adopt if already rotated) → token-endpoint call → adopt in memory →
  read-merge-write persist (0600 temp, fsync, rename). Rationale below.
- **Liveness:** mtime heartbeat touch every `TT_ENV_LOCK_HEARTBEAT_MS`
  (2000); stale when `now − mtime > TT_ENV_LOCK_STALE_MS` (15000) ⇒ remove +
  re-acquire with a logged warning.
- **Contention:** wait with 50–150 ms jitter up to `TT_ENV_LOCK_WAIT_MS`
  (30000). On timeout: **re-read the env file once** — if a rotated token
  appeared (the other process finished), adopt it and proceed; only
  otherwise surface `env_file_busy`. Lock/persist failure never discards a
  valid in-memory token (devops degradation rule).
- **`invalid_grant` recovery:** re-read once under the lock, adopt + retry
  once, else terminal re-login (arch §3.2, unchanged).
- **Release:** delete the lock dir; journal writes do **not** use this lock
  (append-only `O_APPEND` needs none).

**Rationale.** Criterion 3: TikTok rotates refresh tokens on use and the
rotation grace window is unknown (probe P-3); until proven safe, two
concurrent refreshes with the same refresh token must be assumed to brick
one of them. Only a lock that covers the network call prevents that
proactively — devops's mutation-only scope handles lost *writes* but leaves
the double-refresh race to the `invalid_grant` recovery path, i.e. it spends
a failure where arch's design spends none. devops's real objection —
"stale threshold must exceed the critical section" — is solved by the
heartbeat (arch N2), which decouples liveness from section length; devops's
5 s no-heartbeat design is only safe with a milliseconds-long section and is
therefore incompatible with the chosen scope. mkdir beats `O_EXCL` on
devops's ops facts (network FS, universal atomicity) and nothing in arch's
design depends on the lock being a file.

**Consequences.** ARCHITECTURE.md §7 + AUTH.md get the merged protocol;
CONFIGURATION.md gains the three `TT_ENV_LOCK_*` vars; qa's OAU-16
child-process race and the `withLock` unit seam are mandatory (TESTING.md);
doctor check 8 uses the 15 s threshold. Lands in WP-0.4, WP-1.1; closes plan
decision point 8. If P-3 proves a generous rotation grace, narrowing the
lock scope becomes a permitted future optimization — not before.

### 2.3 `wait_for_completion` default

**Positions.** arch §3.9: keep `true` on both video-posting tools (upload
dominates wall time; progress notifications reset client timeouts; WAJ
covers the failure tail). aidx §2.3: `false` on all four write tools, `true`
only on `tiktok_get_publish_status` (failure asymmetry; uniform memorizable
rule; the poll hint makes the cost one guided step). qa (REG-01, unknowns
§7.2): must be settled before Phase 2 — it freezes into the manifest
snapshot.

**THE DECISION.** **`false` on all four write tools; `true` on
`tiktok_get_publish_status`** (aidx §2.3 adopted). Write tools return
`publish_id` immediately with a `poll` hint carrying the exact tool name,
`publish_id`, and an absolute `poll_after`; the status tool does the bounded
~60 s wait internally, with terminal-beats-deadline and timeout-is-not-error
semantics (qa DT-2). `wait_for_completion: true` remains an explicit opt-in
on write tools, with a timeout warning in its `.describe()`. Architect's
per-chunk MCP progress notifications are retained (they matter regardless of
the default). The plan's decision point 6 already anticipated this outcome.

**Rationale.** Criterion 3. A client-timeout kill during a long write call
invites re-invocation of a destructive tool; the same kill on the status
tool is retried for free. plan_id single-use and the duplicate guard blunt
the worst case, but a default should not *rely* on backstops — and progress
notifications only help when the client supplies a `progressToken`, which
cannot be assumed. Architect's own §3.9 conceded the AI/DX round-1 arguments
were strong; the round-2 AI/DX asymmetry argument is decisive.

**Consequences.** TOOLS.md write-tool schemas (`default false`) and status
tool (`default true`); REG-01 manifest snapshot frozen accordingly; lands in
WP-2.3. Closes plan decision point 6.

### 2.4 Chunk size and chunk plan

**Positions.** arch §3.5: fixed "64 MiB" (67 108 864). plat §4.1 (normative
algorithm): `CHUNK_SIZE = 64_000_000` **decimal** (safe under both readings
of TikTok's "64 MB"), `MIN_WHOLE = 5_000_000`, `chunk_size = min(size,
64_000_000)` for files ≥ 5 MB, `total_chunk_count = floor(size /
chunk_size)`, final chunk absorbs the remainder (max 127 999 999 bytes),
1 ≤ count ≤ 1000, 4 GiB file cap, test vectors V1–V8 (incl. V3 = TikTok's
own worked example and V5 = 64 000 001 → one chunk larger than the declared
chunk_size). qa (§2 plat-§6.1): confirms TESTING.md's "all chunks 5–64 MB"
invariant is **factually wrong** (the merged final chunk may legally reach
~128 MB and V5's single chunk exceeds the declared size).

**THE DECISION.** **plat §4.1 is the normative chunk algorithm, verbatim** —
decimal constants, floor-merge rule, invariants (count bounds, contiguity,
sum = file size), and vectors V1–V8 as the property-test fixture. arch's
"64 MiB" figure and TESTING.md's 5–64 MB-per-chunk invariant are struck.
`planChunks()` in `api/upload.ts` keeps arch's shape (pure function,
no cross-call resume, `upload_url` never persisted).

**Rationale.** Criterion 1, cleanly: the platform review derives the rule
from TikTok's own documented example and both-readings-safe arithmetic; QA
independently verified the old invariant false. There is no design freedom
here.

**Consequences.** TIKTOK-API.md gains the algorithm + V1–V8; TESTING.md's
invariant is replaced by the correct three (bounds, contiguity, sum);
CC-D2 reworded to decimal. Lands in WP-2.4 (+WP-0.5 constants).

### 2.5 Upload egress allowlist

**Positions.** qa DT-3: exact set `{open.tiktokapis.com,
open-upload.tiktokapis.com}`, dot-anchored, reject IP literals / userinfo /
port ≠ 443 / non-https. plat R2-1 (HIGH): the regional host
`upload.us.tiktokapis.com` is real; the allowlist must match suffix
`*.tiktokapis.com` or at minimum enumerate `open-upload` +
`upload.*.tiktokapis.com`; `upload_url` is opaque and never rebuilt.
sec C3/§7.1: registrable-domain, dot-bounded matching; "do not relax to a
suffix match — enumerate".

**THE DECISION.** **Enumerated apexes plus one anchored regional pattern** —
the `upload_url` host is accepted iff it is exactly
`open.tiktokapis.com`, exactly `open-upload.tiktokapis.com`, or matches
`^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$`. All matching is dot-anchored
on the full hostname; **bare `endsWith` is banned** (the
`eviltiktokapis.com` / `open.tiktokapis.com.attacker.tld` negatives from
sec C3 are mandatory tests). The rest of sec C3 stands: WHATWG parse,
https-only, no userinfo, port 443 only, `redirect: "error"`, no
`Authorization` header on upload PUTs, `upload_token` treated as a secret
sink. Probe P-9 records which regional hosts actually occur; new observed
shapes widen the pattern by spec edit, never by loosening to blanket suffix.

**Rationale.** Criterion 1 forces regional hosts in (plat's S4 screenshot is
a platform fact QA's exact set would break — a hard upload failure for EEA
users); criterion 3 keeps sec's no-blanket-suffix rule (a full
`*.tiktokapis.com` wildcard admits any future host on the domain, more than
uploads need). The anchored pattern is the minimal grammar covering the
observed fact.

**Consequences.** `core/http.ts` host guard + SECURITY.md C3 host rule +
TESTING.md negatives (UPL/TLS families); WP-0.5, WP-2.4. Closes the
CORNER-CASES "regional upload host" open item (verification: P-9).

### 2.6 DNS resolve-and-pin for upload PUTs

**Positions.** sec C3 step 6: resolve the host, assert all IPs public,
connect to the pinned IP preserving Host/SNI. qa §2 (sec-F8), DT-3 row 9:
**refuted for v1** — requires undici dispatcher surgery, introduces live-DNS
flake in CI, and only defends a TOCTOU window against an attacker who
already controls DNS for `*.tiktokapis.com`; defer with an explicit
SECURITY.md note; if ever adopted, the lookup seam must be specified now.

**THE DECISION.** **Deferred out of v1** (QA position). Compensating
controls, named in SECURITY.md as the accepted-risk record: TLS certificate
validation on an https-only connection (a rebound private IP cannot present
a valid `*.tiktokapis.com` certificate), the § 2.5 host allowlist,
`redirect: "error"`, and no bearer credentials on the PUT. Two obligations
survive: (a) `core/http.ts` exposes an **injectable lookup seam** from day
one so a future flip is a contained change (qa DT-3 row 9); (b) probe P-15
(engineering spike, not sandbox) evaluates an undici-dispatcher
implementation for v1.x.

**Rationale.** Criterion 2. The defended scenario requires DNS control over
TikTok's domain *and* a CA compromise to matter under TLS — marginal
residual risk — while the cost is real: untestable-in-CI behavior on the
hottest data path. Security's own unknowns list (#5) already flagged
feasibility as unproven.

**Consequences.** SECURITY.md deferral note; `core/http.ts` seam; WP-0.5.

### 2.7 Journal write semantics

**Positions.** devops §2b (R2-F5): **refutes** any update-in-place;
append-only, two records per publish (`attempt` fsync'd before init,
`outcome` on response, no fsync), fold by `attempt_id`, torn-tail
skip-and-count, `v:1`, 5 MB rotation with one generation, header record.
arch §3.6 (N5): intent/outcome schema with `attempt_id` ULID, result
vocabulary, rotation only immediately before an intent append, journal
becomes a public contract once `tiktok_list_publish_journal` ships.
aidx §2.2: `pending`-then-completion lines, `"unknown"` derived at read
time, `journal: "unavailable"` on append failure. qa DT-4: outcome names
`unsent`/`unknown`/`unknown_5xx`/`rejected:<code>`/`pending` and (JRN-02)
"updated in place after response".

**THE DECISION.** **Append-only two-record write-ahead journal** — devops's
mechanism, arch's schema, aidx's read surface. QA's JRN-02 "updated in
place" wording is overridden (its own harness tests append semantics; only
the phrasing was wrong). Normative:

- **Intent record** (fsync'd before the init request, appended at the same
  instant the plan is consumed): `{v:1, type:"intent", attempt_id (ULID),
  ts, tool, profile, open_id, plan_id, payload_digest,
  title_excerpt (≤48 chars), source, mode}`.
- **Outcome record** (appended on response or terminal upload failure, no
  fsync): `{v:1, type:"outcome", attempt_id, ts, result, publish_id?,
  error_code?, fail_reason?, chunk?}`.
- **One result vocabulary**, persisted: `ok` (init accepted, `publish_id`
  recorded) · `error` (clean failure — known-unsent transport errors use
  `error_code:"network_unsent"`, CC-B4's before-write case) ·
  `upload_failed` (init ok, chunk upload aborted; carries `publish_id` +
  chunk index) · `send_ambiguous` (transport failure after the request may
  have been sent). **Read-time derived, never written:** `unknown` = intent
  with no outcome record. The journal tool presents `send_ambiguous` as
  `unknown` (same operational meaning: the post MAY exist — verify before
  retrying); doctor keeps the distinction. QA's `unknown_5xx` →
  `send_ambiguous`; `rejected:<code>` → `error` + `error_code`; `pending` is
  not persisted (it is the intent-without-outcome state itself).
- **Lifecycle:** `journal.ndjson`, 0600 in a 0700 dir beside the resolved
  env file; first line after creation/rotation is
  `{v:1, type:"header", created_by:"tiktok-mcp-ai@X.Y.Z"}`; rotation at
  `TT_JOURNAL_MAX_BYTES` (5 242 880) checked only immediately before an
  intent append, one `.1` generation kept, readers merge both; torn-tail
  skip-and-count; unknown `v` ignored and counted; append failure is a
  warning, the result carries `journal:"unavailable"`, never a publish
  failure.
- **Duplicate guard** reads a bounded tail of the active generation only
  (qa); `ok`/`unknown`(incl. `send_ambiguous`) hits within 10 min trip
  `possible_duplicate` unless `force:true`; `error` and `upload_failed` do
  not trip it (aidx §2.1/§4.3).
- The record shape is a **public contract** from the moment the journal tool
  ships: additive-only under `v:1`, version bump only for incompatible
  shape changes (arch N5, devops §2b).

**Rationale.** Criterion 2: in-place NDJSON rewrites racing appends are how
audit trails corrupt (devops), and an intent without an outcome *is* the
truthful crash state, for free. The vocabulary merge keeps arch's
send-ambiguity distinction (needed for CC-B4/B5 honesty) while giving the
model aidx's four simple read-side outcomes.

**Consequences.** ARCHITECTURE.md §8, TOOLS.md §3.7, doctor check 9,
TESTING.md JRN family reworded to append-only. Lands in WP-2.2 (+WP-1.3
doctor).

### 2.8 `plan_id` — the one normative mechanism

**Positions.** Token: arch `plan_ + base64url(randomBytes(16))` (random —
N1: derived tokens are forgeable); sec `plan_<24 hex>` random; aidx
`plan_ + 16 hex` random. Digest: arch SHA-256 over the **resolved upstream
payload** via `canonicalJson()`; sec/aidx over canonicalized **args**
(defaults materialized; `plan_id`/`force`/`wait_for_completion` excluded).
Store: arch in-memory Map, cap 32 oldest-evicted, `TT_PLAN_TTL_S=600`;
devops §2c (R2-F3) in-memory only, LRU 100, TTL 10 min, never on disk.
Surface: arch flat `apply?+plan_id?` with registry refinement; aidx removes
`apply` entirely. qa DT-5: verification order; canonicalization **must** be
pinned in spec or WRM-06/07 are unwritable.

**THE DECISION.** One mechanism, assembled from the strictest elements:

1. **Token:** `plan_` + 32 lowercase hex chars = 16 random bytes
   (`crypto.randomBytes`). Random, never payload-derived (arch N1 / aidx
   §2.1 — a derivable token could be fabricated by a prompt-injected model
   that knows the scheme). Compared with `timingSafeEqual` over digests.
2. **Surface:** the `apply` boolean is **deleted** (aidx §2.1). Absence of
   `plan_id` = preview; presence = execute; `mode:"plan_incomplete"` (no
   token minted) when `privacy_level` is missing on direct-post tools;
   `force` overrides only the duplicate guard. `TT_WRITE_MODE`:
   `plan` (default) as above; `apply` makes `plan_id` optional (documented
   verbatim as "trusted automation only: this mode has no injection
   resistance"); `deny` unregisters `publish-write`.
3. **Digest:** SHA-256 over the **fully resolved upstream payload** —
   `post_info` + source info (canonical absolute file path, file size,
   chunk-plan summary, or validated `video_url`/photo list) + resolved
   `post_mode` — serialized by the single exported `canonicalJson()` in
   `core/json.ts`: recursively sorted keys, no whitespace, UTF-8, absent ≡
   undefined ≡ omitted (qa's pinning demand). Control fields
   (`plan_id`, `force`, `wait_for_completion`) are not payload and never
   enter the digest. The duplicate guard's title hash reuses the same
   function (qa §2).
4. **Store:** in-process memory only, never persisted (devops R2-F3 —
   restart ⇒ re-plan is the *designed* recovery); `Map<plan_id, {digest,
   profile, open_id, tool, created_at, used}>`; cap `TT_PLAN_MAX_OUTSTANDING`
   = 32, oldest-evicted, lazy eviction on access + sweep on plan creation;
   TTL `TT_PLAN_TTL_S` = 600 (all reviews agree: 600 s = 10 min).
5. **Apply pipeline (order is normative, qa DT-5 / aidx §2.1):** re-resolve
   the payload through the same code path as the preview (re-stat file with
   size/mtime/dev/ino match, re-run `creator_info` pre-flight on direct-post
   tools) → compute digest′ → verify: exists ∧ ¬used ∧ ¬expired ∧ tool
   match ∧ digest match ∧ open_id match — internal failure enum
   {unknown, expired, already_used, payload_mismatch, account_mismatch,
   tool_mismatch}, surfaced as exactly two errors: `plan_not_found`
   (unknown/expired/used) and `plan_mismatch` (payload/account/tool) with
   aidx's catalog texts → duplicate guard (unless `force`) → **consume
   atomically** (mark used) → journal intent append → init dispatch. The
   plan is consumed **before** the init is sent; a failed apply always
   requires a fresh preview; a consumed plan is never revived. A
   `possible_duplicate` rejection happens *before* consumption, so the same
   plan_id may be re-applied with `force` within its TTL after the user
   verifies.

**Rationale.** Random token: unanimous round-2 convergence, security-decisive
(N1). Resolved-payload digest beats args digest (criterion 3): it detects
*drift* — file swapped on disk, creator settings changed forcing different
toggles — that an args-only hash silently misses, and it machine-checks
what-you-preview-is-what-you-post (qa 6.3.2) because preview and apply run
one resolution code path. `apply`-boolean removal makes the two illegal
states unrepresentable instead of refined-away. Store cap 32 (arch's named
var) over LRU 100: both satisfy devops's boundedness demand; the smaller cap
fits the real usage (plans live ≤ 10 min) and one env var already names it.

**Consequences.** TOOLS.md common contract (aidx §7.2), ARCHITECTURE.md §8
(`src/mcp/plan-store.ts`, `core/json.ts`), CONFIGURATION.md
(`TT_PLAN_TTL_S`, `TT_PLAN_MAX_OUTSTANDING`, `TT_WRITE_MODE` rewrite),
TESTING.md WRM family now writable. Lands in WP-2.2. Closes plan decision
point 7 (with § 2.9's surface adoption).

### 2.9 Tool surface v1.1 (subsumed divergence)

**THE DECISION.** The **aidx §3 surface is adopted wholesale**: 11 tools, 5
packages (`auth`, `user`, `video`, `publish` = 3 reads incl. the journal
tool, `publish-write` = 4 writes); all four annotation hints required per
tool; `tiktok_get_auth_status` / `tiktok_get_creator_info` names (the plan's
WP-1.5 `tiktok_auth_status` is superseded); conditional `creator_info`
pre-flight (skipped for draft tools — scope reality, plat §6); hints closed
vocabulary of 6 types with the no-upstream-interpolation trust boundary
(aidx §5); scope/UNAVAILABLE lifecycle with `tools/list_changed` (aidx §6);
error catalog texts normative and substring-tested (qa API/REG families).
arch §3.7's manifest-in-code (`src/tools/index.ts`, one source → four
consumers) carries the surface. Elicitation is demoted to optional post-v1
(aidx over sec's target-state; `plan_id` closes the hole; sec's honest
"plan_id does not prove a human sat between calls" residual-risk note goes
into SECURITY.md).

### 2.10 Journal purge on revoke

**THE DECISION.** Default **keep** (qa §7.9, arch §2.1). `login --revoke`
never deletes the journal; purging is the explicit
`login --revoke --purge-journal` / `doctor --purge-journal`. Rationale: the
journal is the only audit trail for "did it post?"; destroying it on revoke
destroys exactly the record needed most. sec F15's purge option survives as
the explicit flag.

### 2.11 `TT_REDIRECT_PORT` and the loopback redirect

**THE DECISION.** Adopt the **wildcard-port loopback** registration
`http://127.0.0.1:*/callback/` — trailing slash mandatory, byte-identical
`redirect_uri` in authorize and exchange, code URL-decoded, prefer
`127.0.0.1`, no `::1` (plat §5.1). Default bind `127.0.0.1:0` (ephemeral).
**`TT_REDIRECT_PORT` is kept** as an optional fixed-port pin — sec §2.2's
deletion is rejected 2-vs-1 (arch keeps it as a pin; qa plat-F5 shows the
override is *more* testable and doctor check 13 needs it). Hex PKCE
confirmed (§ 5, CC-A13).

### 2.12 Local rate-limit behavior

**THE DECISION.** **qa DT-1 is normative.** Publish inits: local token
bucket 6/min per profile, continuous refill (1 token/10 s), empty bucket ⇒
reject locally with `local_rate_limited` + `retry_after_s` + absolute
`retry_at`, zero network, never sleep; the *preview* still succeeds and
shows bucket occupancy. Reads: short delay instead of rejection —
status polls bounded by the poll budget, `creator_info` waits up to
`TT_TIMEOUT_MS` then `local_rate_limited` (arch §2.2's ≤2 s note is
compatible). Buckets are per-profile, ALS-scoped, on the injected clock.
The local bucket is a courtesy, not the enforcement point (CC-B8): upstream
429 on init remains terminal.

### 2.13 Chunk-PUT retryability and Node/CI numbers (subsumed divergences)

**THE DECISION.** (a) Chunk PUTs are a **retryable class** — plat R2-2's
"You should retry submitting this chunk" on 5xx is a platform fact that
overrides any blanket "no retry after send" wording; retry in-call 1 +
`TT_CHUNK_RETRIES` (3) with identical `Content-Range`; 4xx terminal; 403 ⇒
url expired ⇒ no auto-re-init (CC-D5); 416 ⇒ resync via
`uploaded_bytes` (plat §5.2); publish inits stay never-retried. (b) Node:
`engines >= 22`, blocking matrix ubuntu×{22,24} + macos×24 + windows×24,
advisory ubuntu×26 without coverage, `.nvmrc` = **24** (devops §4.0
supersedes WP-0.1's ".nvmrc 22" and README's "Node ≥ 20").

---

## 3. Consolidated findings register

Status legend: **decided-here** (resolved by § 2), **spec-edit-pending**
(uncontested round-2 material awaiting the § 4 edit), **sandbox-probe**
(answer requires § 6).

| ID | Sev | Finding (one line) | Sources | Status |
|---|---|---|---|---|
| SYN-01 | Critical | plan_id contract fragmented across four variants (token derivation, digest target, store, surface) | arch §3.1 N1; sec C4; aidx §2.1; devops §2c R2-F3; qa DT-5 | decided-here (§ 2.8) |
| SYN-02 | Critical | Chunk math: "64 MiB"/"5–64 MB per chunk" spec claims are factually wrong; decimal floor-merge algorithm required | plat §4.1; qa §2; arch §3.5 | decided-here (§ 2.4) |
| SYN-03 | Critical | Regional upload host `upload.us.tiktokapis.com` breaks the exact-set egress allowlist | plat R2-1; sec C3/§7.1; qa DT-3 | decided-here (§ 2.5) |
| SYN-04 | Critical | Env-file lock: staleness < network timeout lets a waiter steal the lock mid-refresh; mechanism/scope disputed | arch §3.2 N2; devops §2a R2-F4; sec §2.4; qa §5c | decided-here (§ 2.2) |
| SYN-05 | Critical | Journal update-in-place corrupts the audit trail; append-only two-record WAJ required | devops §2b R2-F5; arch §3.6; aidx §2.2; qa DT-4/JRN-02 | decided-here (§ 2.7) |
| SYN-06 | High | `wait_for_completion` default on write tools invites duplicate-post re-invocation on client timeout | aidx §2.3; arch §3.9; qa REG-01, §7.2 | decided-here (§ 2.3) |
| SYN-07 | High | Chunk-PUT 5xx is officially retryable — blanket "never retry after send" is wrong for this class | plat R2-2/§4.2; arch §3.3; CC-B7 | decided-here (§ 2.13a) |
| SYN-08 | High | Windows: chmod is a no-op; support model must be profile-ACL + doctor text, never automated icacls | devops §3; sec §2.7; CC-H3 | decided-here (§ 2.1) |
| SYN-09 | High | PKCE deviation: `code_challenge` = lowercase hex SHA-256; wildcard-port loopback `http://127.0.0.1:*/callback/` with mandatory trailing slash | plat §5.1; sec §2.1/2.2; CC-A13 | decided-here (§ 2.11, § 5) |
| SYN-10 | High | `upload_token` in `upload_url` is a bearer secret: new redaction sink, query-string-aware scrub, no Authorization on PUTs | sec C3; plat R2-1; devops §2e; arch §3.4 | spec-edit-pending |
| SYN-11 | High | DNS resolve-and-pin: required by security, refuted as untestable/flaky for v1 by QA | sec C3 step 6, unknown 5; qa DT-3 row 9 | decided-here (§ 2.6) + P-15 |
| SYN-12 | High | Redaction must live in `core/` below every sink (stderr, doctor, journal, results), allowlist OAuth logging | sec C1; arch §3.4; devops §2e R2-F6 | spec-edit-pending |
| SYN-13 | High | `TT_MEDIA_ROOT`: fail-closed unset, realpath+`path.relative` containment (win32 case-insensitive), TOCTOU re-stat at apply | sec C2; devops §2d R2-F7; aidx §2.4; CC-D3/D8 | spec-edit-pending |
| SYN-14 | High | Ambiguous init outcomes: transport-after-send is terminal `send_ambiguous`; never retried; journal + status are the recovery | arch §3.3; qa DT-4; aidx §2.2; CC-B4/B5 | decided-here (§ 2.7) |
| SYN-15 | High | Trusted publishing cannot do the first publish; manual 2FA bootstrap + npm ≥ 11.5.1 + "Require OIDC" toggle | devops §4.3 R2-F1 | spec-edit-pending |
| SYN-16 | High | Sandbox cannot post publicly — Phase-2 exit gate must be SELF_ONLY probes; audit demo shot on unaudited production | plat §5.8 R2-7 | spec-edit-pending |
| SYN-17 | High | Three upstream error shapes (OAuth flat / envelope / raw chunk HTTP) need separate decoders; `invalid_param` vs `invalid_params` | plat §4.2; CC-A12/B1 | spec-edit-pending |
| SYN-18 | High | Local rate-limit policy: writes reject with `retry_at` (zero network), reads delay; per-profile buckets on injected clock | qa DT-1; arch §2.2; aidx F15; CC-B8 | decided-here (§ 2.12) |
| SYN-19 | High | Duplicate guard: bounded tail scan of active journal generation, canonical title hash, `force` override, `error` outcomes exempt | aidx §2.1; arch §3.6; sec C4; qa §2 | decided-here (§ 2.7/2.8) |
| SYN-20 | Medium | Tool surface v1.1: 11 tools / 5 packages, `apply` boolean removed, annotations mandatory, manifest-in-code | aidx §3; arch §3.7/3.8 | decided-here (§ 2.9) |
| SYN-21 | Medium | Node claims stale: engines ≥ 22, matrix 22/24 + advisory 26 (c8 broken ≥ 25), CI + Windows leg in Phase 0 | devops §4.0 R2-F2 | decided-here (§ 2.13b) |
| SYN-22 | Medium | Hint system: closed 6-type vocabulary, absolute UTC times, no upstream text interpolation (trust boundary) | aidx §5 | spec-edit-pending |
| SYN-23 | Medium | Scope/UNAVAILABLE lifecycle: advisory markers, authoritative call-time check, credential watch + `tools/list_changed` | aidx §6; arch §3.2 N4 | spec-edit-pending |
| SYN-24 | Medium | Test harness: injectable Clock seam (not global fake timers), seeded RNG, upload simulator, two-seam lock harness, sanitized fixtures | qa §5; CC-H4 | spec-edit-pending |
| SYN-25 | Medium | 166-case test spec + coverage floors with ratchet + blocking/advisory split + 3-layer stdout-purity gate | qa §4/§6 | spec-edit-pending |
| SYN-26 | Medium | Doctor: 15-check normative list, all output through redaction, `--json`, offline by default | devops §5.1; sec C1 | spec-edit-pending |
| SYN-27 | Medium | Env-file schema versioning: `TT_CONFIG_SCHEMA`, round-trip unknown keys, never migrate on read, pre-migration backup | devops §5.5 | spec-edit-pending |
| SYN-28 | Medium | Release machinery: release-guard / pack-audit / wait-npm scripts, SHA-pinned workflows, zero-secret CI, MCP registry sequencing | devops §4 | spec-edit-pending |
| SYN-29 | Medium | PULL_FROM_URL domain verification workflow (production mode, TXT/signature file, 1 h availability, no redirects); `TT_VERIFIED_URL_PREFIXES` advisory-only | plat §4.3; arch §2.1 | spec-edit-pending |
| SYN-30 | Medium | Status polling: 2 s→5 s→10 s + jitter schedule, terminal-beats-deadline, timeout-is-not-error with `publish_id` always present | plat §4.4; qa DT-2; CC-E8 | spec-edit-pending |
| SYN-31 | Medium | HTTP transport: `TT_HTTP_TOKEN` mandatory whenever `TT_TRANSPORT=http`, Origin/Host validation, TLS or explicit insecure flag beyond loopback | sec C6; CC-G6 | spec-edit-pending |
| SYN-32 | Medium | Least-privilege scopes derived from enabled packages (publish needs `video.publish`; draft-only profiles need `video.upload` only) | sec C8; aidx §3.0 | spec-edit-pending |
| SYN-33 | Medium | `creator_info` pre-flight is conditional — skipped for draft tools (scope reality); "no need to call first" wording | aidx §2.0/F9; plat §6 | decided-here (§ 2.9) |
| SYN-34 | Low | Journal purge on revoke destroys the audit trail — default keep, purge explicit | qa §7.9; arch §2.1; sec F15 | decided-here (§ 2.10) |
| SYN-35 | Low | Journal shape is a public contract once the journal tool ships: `v:1`, additive-only | arch N5; devops §2b | decided-here (§ 2.7) |
| SYN-36 | Low | Elicitation demoted to optional post-v1; residual "plan_id proves no human" risk documented honestly | aidx §2.0; sec C4 | decided-here (§ 2.9) |
| SYN-37 | Low | `TT_REDIRECT_PORT` kept as optional pin (testability + doctor check); default ephemeral port | qa §2 plat-F5; arch §2.1; sec §2.2 | decided-here (§ 2.11) |
| SYN-38 | Low | npx staleness: doctor WARN with verbatim cache-clear commands (`~/.npm/_npx` / `%LOCALAPPDATA%\npm-cache\_npx`) | devops §5.3 R2-F8 | spec-edit-pending |
| SYN-39 | Low | Tool name drift: plan says `tiktok_auth_status`, surface says `tiktok_get_auth_status` — latter wins | aidx §3.1; WP-1.5 | decided-here (§ 2.9) |
| SYN-40 | Low | Runtime unknowns requiring live verification (retention, re-PUT, rotation grace, draft TTL, caps, photo-draft fields, upload_url anatomy) | plat §6 P-1..P-10; arch U1–U8; aidx §8; sec unknowns | sandbox-probe (§ 6) |

---

## 4. Prioritized spec-change backlog

Ordered: an item blocks everything below it that touches the same doc.
Each entry: doc → change → WP tag.

1. **`docs/TOOLS.md` — full body replacement** with the aidx §3–§6 v1.1
   surface: at-a-glance table, common contract (envelope, `account`
   injection, validation-before-network, truncation, token discipline),
   **plan lifecycle per § 2.8** (no `apply` boolean; `plan_id`-only;
   consumed-before-init; duplicate guard + `force`; `TT_WRITE_MODE`
   matrix), shared error catalog (normative texts incl. `plan_not_found`,
   `plan_mismatch`, `possible_duplicate`, `network_ambiguous`,
   `upload_interrupted`, cap errors), hints spec (closed vocabulary), scope
   lifecycle, per-tool reference §§3.1–3.11 with `wait_for_completion`
   defaults per § 2.3. → **WP-2.2, WP-2.5, WP-1.4**
2. **`docs/ARCHITECTURE.md` §8** — plan store (`src/mcp/plan-store.ts`:
   in-memory Map, cap 32, TTL 600 s, `canonicalJson()` in `core/json.ts`,
   consumption point, failure enum); WAJ two-record schema + result
   vocabulary + rotation + header record per § 2.7; retry decision table
   (six request classes by path allowlist, three lanes, init-terminal rule,
   chunk-PUT retry class per § 2.13a); manifest-in-code
   (`src/tools/index.ts`, four consumers). → **WP-2.2, WP-0.5, WP-1.4**
3. **`docs/ARCHITECTURE.md` §7 + `docs/AUTH.md`** — merged lock protocol
   per § 2.2 (mkdir lock dir, 2 s heartbeat, 15 s staleness, 30 s wait +
   re-read-on-timeout, refresh under lock, degradation rules,
   `invalid_grant` recovery); win32 storage + rename-retry (devops §3);
   single snapshot-reload path for env changes (arch N4). → **WP-0.4,
   WP-1.1**
4. **`docs/TIKTOK-API.md`** — normative chunk algorithm + V1–V8 (§ 2.4);
   raw chunk-PUT response table (206/201/400/403/404/416/5xx) incl. the
   official 5xx-retry quote; error-shape trichotomy + `invalid_param(s)`
   note; `fail_reason` → recovery table; rate-limit table (6/20/30/min,
   600/min Display) + business caps; PULL_FROM_URL verification workflow;
   regional-host note + § 2.5 allowlist grammar; `publicaly_available_post_id`
   spelling warning. → **WP-0.5, WP-2.3, WP-2.4**
5. **`docs/TESTING.md`** — **delete the false "all chunks 5–64 MB"
   invariant**, replace with bounds/contiguity/sum + V1–V8 property vectors;
   chunk-PUT retry class tests; Clock seam + seeded RNG + upload simulator +
   two-seam lock harness (OAU-16 child-process race, `TT_OAUTH_BASE_URL`
   test override) + sanitized fixtures; coverage floors + ratchet;
   blocking/advisory split; stdout-purity 3-layer gate; platform-gated
   permission asserts + win32 EPERM retry test; pack-audit in the CI-gates
   list; journal tests reworded append-only. → **WP-0.6, WP-0.2, WP-2.4**
6. **`docs/SECURITY.md`** — "Windows token storage" paragraph (§ 2.1);
   upload_url validation algorithm per § 2.5 with the **explicit DNS-pin
   deferral note** (accepted risk, compensating controls, P-15) per § 2.6;
   secrets inventory + 8-sink redaction table + OAuth allowlist logging
   (SYN-10/12); threat-model §4 replacement text (sec §4); scopes-from-
   packages; `TT_HTTP_TOKEN` rule; elicitation residual-risk note (§ 2.9).
   → **WP-0.3, WP-0.5, WP-3.2**
7. **`docs/CONFIGURATION.md`** — resolver table + win32 column
   (`%LOCALAPPDATA%`, not Roaming; journal + lock beside the resolved env
   file); new vars: `TT_PLAN_TTL_S` 600, `TT_PLAN_MAX_OUTSTANDING` 32,
   `TT_ENV_LOCK_HEARTBEAT_MS` 2000, `TT_ENV_LOCK_STALE_MS` 15000,
   `TT_ENV_LOCK_WAIT_MS` 30000, `TT_JOURNAL_MAX_BYTES` 5242880,
   `TT_CHUNK_RETRIES` 3, `TT_LOCK_PROFILE`, `TT_DEFAULT_AIGC_LABEL`;
   `TT_MEDIA_ROOT` fail-closed semantics + exact unset error text;
   `TT_WRITE_MODE` rewrite incl. the "trusted automation only" sentence;
   `TT_REDIRECT_PORT` reworded as optional pin; `TT_CONFIG_SCHEMA` +
   migration policy (devops §5.5); `TT_VERIFIED_URL_PREFIXES`
   advisory-only wording. → **WP-0.4, WP-1.2, WP-2.2**
8. **`docs/AUTH.md`** — hex-PKCE pinned test vector (verifier,
   expected_hex_challenge); wildcard-port loopback registration string
   (trailing slash, byte-identical `redirect_uri`, URL-decode the code,
   prefer 127.0.0.1, no `::1`); doctor 15-check list becomes the normative
   doctor spec (+ `--json`, refresh-horizon warning); token prefixes note
   (arch U6). → **WP-1.1, WP-1.2, WP-1.3**
9. **`README.md` + `docs/ROADMAP.md`** — Node ≥ 22 everywhere; CI (incl.
   Windows leg + launcher probe) moved into Phase-0 exit criteria; tool
   table regenerated from the manifest; `TT_MEDIA_ROOT` in the quickstart
   block; Windows storage paragraph; npx cache-clear commands. →
   **WP-0.1, WP-0.2**
10. **`docs/CORNER-CASES.md`** — close the open-items table per § 5; CC-D2
    reworded to the decimal algorithm; CC-B7 notes chunk-PUT 5xx as
    officially retryable; CC-H3 marked resolved; CC-E7 wording aligned to
    `plan_not_found` (consumed-before-init). → rides the WPs above
11. **`docs/IMPLEMENTATION-PLAN.md`** — decision points 1–8 marked closed
    (§ 5); WP-0.1 `.nvmrc` → 24; WP-1.5 tool name → `tiktok_get_auth_status`;
    WP-2.6 exit gate restated as "all § 6 sandbox probes executed, SELF_ONLY
    end-to-end green"; probe execution assigned to WP-2.6 (P-1..P-14) and
    WP-0.5 (P-15 spike). → plan maintenance
12. **New release artifacts** — `.github/workflows/{ci,codeql,publish,
    dependabot}.yml` (SHA-pinned, zero-secret, blocking set per devops
    §4.1); `scripts/{release-guard,pack-audit,wait-npm}.mjs` +
    `test/fixtures/pack-manifest.json`; RELEASING notes (manual first
    publish with 2FA → trusted-publisher setup incl. "Require OIDC" toggle
    and post-2026-05-20 action selection). → **WP-0.2, WP-3.1–3.3**

---

## 5. Decision points closed

**IMPLEMENTATION-PLAN.md "Decision points awaiting round-2" (8):**

| # | Point | Final answer |
|---|---|---|
| 1 | Windows support level (CC-H3) | **Closed** — full support per § 2.1 (devops §3 spec verbatim); Windows CI leg blocking from Phase 0. |
| 2 | Regional upload host in egress allowlist | **Closed** — enumerated apexes + anchored `upload.<region>.tiktokapis.com` pattern per § 2.5; observed-host verification = **probe P-9**. |
| 3 | Hex PKCE final confirmation (CC-A13) | **Closed — CONFIRMED.** `code_challenge` = lowercase-hex SHA-256 of the verifier (plat §5.1, sec §2.1); verifier stays base64url ≥ 32 bytes; pinned test vector in AUTH.md; encoding isolated in one function stands. First real login (Phase-1 exit) is the live confirmation; no dedicated probe. |
| 4 | Re-PUT semantics for chunk retries (CC-D6) | **Design closed, behavior probed** — chunk PUTs are retryable with identical `Content-Range`; 416 resyncs via `uploaded_bytes` (plat §5.2). Exact accepted-range tolerance = **probe P-2** (with P-11 recording) before the Phase-2 retry matrix freezes. |
| 5 | publish_id retention (CC-E8) | **Open — probe P-1.** Until answered, `publish_not_found` text hedges ("retained only for a limited window") and the journal is the durable record. |
| 6 | `wait_for_completion` default | **Closed** — `false` on all four write tools, `true` on `tiktok_get_publish_status` (§ 2.3); frozen into the manifest snapshot. |
| 7 | Final tool surface v1.1 | **Closed** — 11 tools / 5 packages, `plan_id`-only write gating per § 2.8/2.9. |
| 8 | Lock-file protocol details | **Closed** — mkdir lock dir beside the resolved env file, 2 s heartbeat, 15 s staleness, 30 s wait, refresh under lock, degrade-never-fail (§ 2.2). |

**CORNER-CASES.md open items:** CC-A13 → closed (row 3). CC-D6 → probe P-2
(row 4). CC-E8 → probe P-1 (row 5). CC-H3 → closed (row 1). Regional upload
host → closed with P-9 verification (row 2).

---

## 6. Consolidated probe list

P-1…P-10 keep the platform review's numbering; P-11…P-16 are added from the
other reviews, deduplicated (arch U1 ≡ P-3, arch U3 ≡ P-2, aidx §8.2 ≡ P-7,
aidx §8.3 ≡ P-1, aidx §8.5 ≡ P-10, arch U8 + sec unknown 2 ≡ P-14). All run
in sandbox (SELF_ONLY) except where marked; none block Phase 0; each blocks
the Phase-2 freeze point named.

| # | Probe | Answers | Blocks |
|---|---|---|---|
| P-1 | Poll `status/fetch` on an aging publish_id until it disappears | Retention window (CC-E8); `publish_not_found` wording; journal-vs-status guidance | WP-2.3 |
| P-2 | Re-PUT an already-accepted chunk range; record acceptance/rejection | CC-D6 re-PUT tolerance; retry-matrix freeze | WP-2.4 |
| P-3 | Refresh twice with the same refresh token in quick succession | Rotation grace window (arch U1); whether § 2.2's lock scope may ever be narrowed | WP-1.1 hardening |
| P-4 | Request a field outside granted scopes on user/video reads | Silent-omit vs error behavior (plat P-4) | WP-1.5 |
| P-5 | Revoke mid-upload; observe 401-after-init behavior | Orphaned-publish handling; `auth_removed` mapping | WP-2.4 |
| P-6 | `brand_content_toggle` + SELF_ONLY at the API (not just docs) | Whether the local `branded_content_privacy_conflict` rule matches upstream | WP-2.1 |
| P-7 | Leave an inbox draft unopened; measure expiry | Draft TTL number for the `user_action` hint (aidx §8.2) | WP-2.5 |
| P-8 | Hammer a Display read to the 600/min boundary | Limit dimension (per-token vs per-app) for the read limiter | WP-0.5 tuning |
| P-9 | Capture `upload_url` hosts across runs (incl. EEA account if available) | Regional-host reality; § 2.5 pattern sufficiency | WP-0.5 |
| P-10 | Drafts (MEDIA_UPLOAD) vs the 5-users/24 h unaudited cap | Whether drafts consume the active-user cap (aidx §8.5) | error texts, WP-2.5 |
| P-11 | Record raw chunk-PUT responses: per-chunk 206/201, 416 body + headers, 5xx shape | Retry classifier fixtures (aidx §8.4, qa 6.1.2); runs in the same session as P-2 | WP-2.4 |
| P-12 | Send two byte-identical inits back-to-back | Upstream init idempotency/dedup (arch U2); `send_ambiguous` recovery guidance | WP-2.2 texts |
| P-13 | Photo-draft init with `title`/`description`; photo direct-post with `auto_add_music` | Dead-field check for §3.10/3.11 schemas (aidx §8.1/§8.6) | WP-2.5 schemas |
| P-14 | Dissect `upload_url` anatomy: host, `upload_token` param, observed TTL | Redaction pattern completeness; CC-D5 timing; § 2.5 grammar | WP-2.4 |
| P-15 | *(engineering spike, not sandbox)* undici-dispatcher resolve-and-pin prototype behind the lookup seam | Feasibility/cost of reinstating DNS pinning in v1.x (§ 2.6) | none (v1.x) |
| P-16 | Re-query `creator_info` across hours/days | Options volatility (arch U5); whether the 600 s plan TTL is comfortably inside it | none (tuning) |

Sandbox constraint (plat §5.8): probes run with SELF_ONLY only; the audit
demo video is shot later on unaudited **production** with a private account
(R2-7). DevOps release unknowns (mcp-publisher pinning, npm propagation SLA,
Node-26 LTS transition) are tracked in devops §7, not as probes.

---

## 7. Verdict

**Ready for Phase 0: YES — unconditionally.** Nothing in Phase 0 (WP-0.1 –
WP-0.6) depends on an open probe, and every design its modules implement
(redaction-in-core, lock protocol, http retry classes, egress grammar,
harness seams) is now singular and testable. Phase 2's freeze points are
gated by probes P-1/P-2/P-11 only, and those run inside WP-2.6 as planned.

**Top 5 to fold into the spec before code lands** (backlog items 1–5 — in
this order, since later edits cite earlier ones):

1. **TOOLS.md replacement** with the v1.1 surface + the § 2.8 plan contract
   — every write-path WP builds against this file.
2. **ARCHITECTURE.md §7/§8** — plan store, append-only WAJ, lock protocol,
   retry table: the two "structurally hard pieces" the plan's dependency
   spine already puts first (WP-0.4, WP-2.2).
3. **TIKTOK-API.md chunk algorithm + raw-response table** — the only place
   round 2 found the spec *factually wrong*; WP-0.5/WP-2.4 must not be
   written against the wrong constants.
4. **TESTING.md** — delete the false chunk invariant, add the harness seams
   (Clock, lock, simulator) so WP-0.6 builds the right scaffolding first.
5. **SECURITY.md + CONFIGURATION.md** — Windows storage, DNS-pin deferral
   note, sink table, and the full env-var table (lock/plan/journal vars) so
   Phase-0 config code ships with its documented contract.

The review cycle converged: no conflict survived adjudication without a
single binding design, all eight plan decision points are closed (two with
named probes), and the residual risk register is honest — duplicate posts
are defended by three independent layers (plan_id, WAJ + duplicate guard,
never-retry inits), credentials by the merged lock protocol, and the
remaining unknowns are empirical questions with assigned probes, not design
disagreements.

*End of synthesis. This document supersedes conflicting statements in the
six round-2 reviews; the § 4 backlog is the mechanical path to a consistent
spec.*
