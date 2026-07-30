# Round-2 Deep Security Review — tiktok-mcp

## 1. Reviewer & scope

- **Role:** Principal Security Engineer — application security, OAuth 2.0 / PKCE,
  SSRF/egress control, agentic-AI (MCP) security, threat modeling.
- **Review type:** Round-2 defensive design review of an open-source, pre-code
  specification. No implementation exists. This round goes deeper than round 1: it
  cross-examines the security-relevant findings of the other five reviews, and it
  converts round-1 High/Critical findings into concrete, testable control specs.
- **Date:** 2026-07-21.
- **Inputs:** all of `docs/` + `README.md`, and all six round-1 reviews
  (`security-review.md`, `architecture-review.md`, `tiktok-platform-review.md`,
  `qa-review.md`, `devops-release-review.md`, `ai-dx-review.md`).
- **Relationship to round 1:** this document does **not** restate round-1 prose. It
  references round-1 findings by tag (`Security F4`, `Architecture Finding 2`,
  `Platform Finding 1`, `QA F-3`, `DevOps F8`, `AI-DX F1`) and builds on them.
  Where round 1 stopped at "constrain this" or "tighten that," this round writes the
  algorithm, the sink list, the test invariant, and the honest residual risk.

**Convergence thesis.** Five separate reviews independently discovered the same three
soft spots from different angles, which is the strongest possible signal that they are
real. (1) The plan-and-apply gate is an *affordance, not a guarantee*: `Security F4`,
`AI-DX F1` (rated Critical), and `Architecture Finding 2` all land on it — this round
fuses them into **one** `plan_id` mechanism. (2) The token-holding store races across
processes: `QA F-3`, `Architecture Finding 1`, and `DevOps F8` all describe the same
lost-update. (3) The upload path is the one place local bytes leave the box to a URL the
server did not hard-code: `Security F3` (which bytes), `Security F8` + `Platform Finding
4` + `QA F-6` (where the bytes go, and the `upload_token` secret riding in the URL).
These three, plus the redaction-layer defect (`Security F1/F2`) and loopback-HTTP
exposure (`Security F5` / `Architecture Finding 9`), are the substance of this review.

---

## 2. Cross-examination of other reviews' security-relevant claims

Format: **CONFIRM / REFUTE / REFINE**, with reasoning and the resulting decision.

### 2.1 Platform Finding 1 — hex-encoded PKCE `code_challenge` (`HEX(SHA256(verifier))`)

**Verdict: CONFIRM the fact, REFINE the security characterization.**

The platform reviewer verified that TikTok's PKCE deviates from RFC 7636: it expects
`code_challenge = lowercase-hex(SHA256(code_verifier))`, not
`base64url(SHA256(code_verifier))`. This is correct and load-bearing, so it must be
analyzed precisely rather than waved through.

- **No cryptographic weakening.** The challenge is the *same* SHA-256 digest in both
  schemes; hex vs base64url is an encoding of identical 256 bits. Encoding never adds or
  removes entropy. The security of PKCE rests entirely on (a) the verifier being drawn
  from a CSPRNG with adequate length and (b) the challenge being a one-way function of it
  — both hold identically here. There is **no** entropy loss and **no** downgrade of the
  binding between challenge and verifier. `Security F18` (unspecified entropy) is the real
  control point, not the encoding.
- **The verifier stays RFC-compliant.** Only the *challenge encoding* deviates. The
  `code_verifier` itself must remain a 43–128-char string from the RFC 7636 unreserved set
  `[A-Za-z0-9-._~]`. Decision: generate the verifier as **base64url(randomBytes(≥32))**
  (which is a subset of the allowed charset and yields 43 chars at 32 bytes), then compute
  the challenge as lowercase hex of its SHA-256. Do **not** hex-encode the verifier — only
  the challenge.
- **The real risk is interop, and it is a footgun.** Every off-the-shelf PKCE helper emits
  base64url challenges. If a maintainer later "fixes" the hand-rolled hex to use a library,
  or a dependency bump swaps the encoder, `authorize` will fail with an opaque
  `invalid_request` from TikTok. Mitigation is a **pinned test vector**: freeze one
  `(verifier, expected_hex_challenge)` pair as a unit test so any regression to base64url
  fails a local gate, not a user's browser. This belongs in `TESTING.md § core/oauth`.

**Decision recorded:** hex challenge is safe; add the pinned test vector and keep the
verifier base64url. See Specified Control C7.

### 2.2 Platform Finding 5 — wildcard-port loopback redirect `http://127.0.0.1:*/callback/`

**Verdict: CONFIRM, and it resolves `Security F13` (the fixed-port contradiction).**

The platform reviewer verified TikTok officially supports a wildcard-port loopback redirect
URI. This is materially better than round-1's assumption of a single pre-registered fixed
port (`43110`), which `Security F13` flagged as both self-contradictory in `AUTH.md §1` and
a port-squat/collision hazard.

- **Security effect: strictly positive.** An ephemeral OS-assigned port (bind `:0`, read
  the assigned port, build the redirect URI from it) removes the port-squat *denial-of-login*
  entirely — there is no fixed port to camp on — and aligns with RFC 8252 §7.3. It does not
  weaken CSRF defense: `state` is still the anti-forgery token and is still mandatory.
- **Caveat that must not be lost:** wildcard applies only to the **port**. The path
  (`/callback/`), scheme (`http`), and host (`127.0.0.1`, not `localhost` — avoid a DNS
  lookup) are still fixed and must be validated on the inbound request. And browser-
  reachability of the listener (any page can `fetch` the loopback while it is open) is
  unchanged — the shared Origin/`state` mitigation from `Security F5`/§6.1 still applies.

**Decision recorded:** adopt wildcard-port loopback; delete the fixed-`43110` design and
the `TT_REDIRECT_PORT` variable; keep manual-paste strictly as fallback. See amendment 6.

### 2.3 Platform Finding 4 — real upload host + `upload_token` credential in `upload_url`

**Verdict: CONFIRM, and it upgrades `Security F8` from defense-in-depth to load-bearing.**

The platform reviewer established two facts round 1 did not have: (1) the actual upload host
is `open-upload.tiktokapis.com` (not the data host `open.tiktokapis.com`), and (2) the
`upload_url` carries an `upload_token` query-string secret that is **bearer-equivalent** for
that upload session.

- This makes `Security F8`'s host/IP validation non-optional: the upload host is a
  *different* apex-subdomain than the hard-coded data origin, so any allowlist that only
  knows `open.tiktokapis.com` will either wrongly reject legitimate uploads or (worse) be
  loosened to a suffix match that also admits `eviltiktokapis.com` (`QA F-6`).
- The `upload_token` is a **new secret sink** that round-1's inventory missed. It appears
  in an *URL*, which is the most log-prone place a secret can live (request logs, error
  `detail`, plan previews, `doctor` output, journal). It must be added to the redaction
  contract and — critically — the redactor must handle **secrets embedded in query strings**,
  which a key/Bearer-shaped denylist will not catch (parallel to the `Security F2` form-body
  problem). Log only `origin + path` of an `upload_url`, never the query.

**Decision recorded:** upload host joins the allowlist as a named apex; `upload_token` joins
the secret inventory with a query-string-aware redaction rule. See Specified Controls C3, C1.

### 2.4 Architecture Finding 1 / QA F-3 / DevOps F8 — cross-process refresh-token lost update

**Verdict: CONFIRM the correctness hole; REFINE the security classification (it is NOT a new
security hole).**

All three reviews describe the same scenario: two server processes (Claude Desktop + Claude
Code) share one env file; TikTok rotates the refresh token on refresh; process A persists the
rotated token, process B still holds the pre-rotation token in its in-memory snapshot and
later refreshes with a now-invalid token → terminal "log in again."

- **This is primarily a correctness/reliability defect, not a confidentiality/integrity
  breach.** The threat model already places *same-user local processes* out of the trust
  boundary for reading the env file (`SECURITY.md` scopes "other local processes" to other
  users). Two cooperating same-user processes racing on a file they are both entitled to read
  is a lost-update bug, not a privilege escalation. So the architect's advisory-lock +
  read-merge-write recommendation **closes the correctness hole; it does not change the
  security posture** — and it must be described that way, honestly, rather than sold as a
  security fix.
- **However, there is a genuine security-adjacent property to preserve.** The round-1
  guarantee that a *torn read* (new access token paired with old refresh token) is
  structurally impossible (`ARCHITECTURE.md §7`, atomic write + atomically swapped snapshot)
  must survive the new lock design. The correct primitive is: hold an advisory file lock
  around the whole **read-latest → refresh → persist → swap-snapshot** sequence, and re-read
  the on-disk refresh token *inside* the lock before deciding whether to refresh (another
  process may have already rotated it — in which case adopt the newer token instead of
  refreshing). This preserves atomicity and adds staleness-tolerance. See Specified Control C5.
- **One true security sub-point:** the advisory lockfile itself must be created `0600` in the
  `0700` data dir, and must not be a predictable name a same-user process could pre-create as
  a symlink to elsewhere (`Security F7`'s temp-file discipline applies to the lock too).

**Decision recorded:** adopt lock + read-merge-write; classify as reliability with an
atomicity-preservation constraint; do not overclaim it as closing a security hole.

### 2.5 AI-DX F1 + Architecture Finding 2 + Security F4 — the plan-and-apply gate

**Verdict: CONFIRM the defect (all three agree); CONVERGE the three proposals into one.**

This is the most important cross-examination. Three reviews propose overlapping mechanisms:

- `Security F4`: a short-lived, single-use **confirmation token** derived from a hash of the
  resolved payload; `apply` must echo it; reject on hash mismatch.
- `AI-DX F1` (rated **Critical**): a single-use **`plan_id`** stored server-side with
  SHA-256 of canonicalized args + resolved account/`open_id` + TTL; `apply` requires the
  `plan_id`; verify exists ∧ fresh ∧ unused ∧ args-hash-match ∧ account-match; plus
  result-embedded directive hints and optional MCP **elicitation**.
- `Architecture Finding 2`: a **journal-backed duplicate-post dedup guard** (a content
  fingerprint checked against the journal to refuse a re-post).

These are not competing — they are three layers of one control, and they compose cleanly:

1. **`plan_id` is the core mechanism** (AI-DX F1 == Security F4, same idea, AI-DX's shape is
   more complete). It makes a no-preview apply *unexecutable*, binds the exact bytes/params
   (kills preview/execute TOCTOU), binds the account (subsumes the account half of
   `Security F11`), and single-use kills approval-replay.
2. **The journal dedup guard is complementary, defending a different axis** — not "was this
   previewed?" but "did we already post something byte-identical very recently?" It catches
   the lost-response double-post (`AI-DX F4`) and an approved-plan replayed after TTL by a new
   plan. Keep both.
3. **Elicitation is the only *hard* human-in-the-loop control** and must be named as the
   target state, feature-detected, with plan_id as the floor when the client lacks it.

**The honest residual risk — stated plainly, because round-1 `SECURITY.md` overstates
protection.** The `plan_id` mechanism forces a two-call shape and defeats *single-message*
injection (an injected instruction cannot know an unissued `plan_id`). It does **not** prove a
human sat between the two calls: an eager or injected model can still call `plan` then `apply`
with the returned `plan_id` back-to-back in one autonomous turn. Only elicitation (client-
supported) or `TT_WRITE_MODE=plan` **plus an out-of-band human review** closes that gap. The
spec must claim exactly this and no more. See Specified Control C4 and amendment 3.

### 2.6 AI-DX F10 + Security F11 — the model-controlled `account` selector

**Verdict: CONFIRM; the two proposals combine into a complete control.**

`Security F11` proposed a **profile lock** (`TT_LOCK_PROFILE=1` pins the session to one
profile and removes the auto-injected `account` argument). `AI-DX F10` proposed **binding the
resolved profile into the plan token**, **echoing `meta.account`** in every result, and a
**named validation error** for unknown profiles. These are orthogonal and both wanted:

- The lock is the *operator's* structural defense (a session literally cannot address another
  profile — the argument does not exist in the schema when locked).
- The plan-token account binding is the *default-mode* defense (multi-profile stays available,
  but plan and apply cannot straddle accounts, and the human sees the target account in the
  preview + `meta.account`).
- Unknown-profile → local validation error listing configured profiles (never an opaque
  upstream token error) is pure ergonomics-as-security: it stops the model from retrying
  blind against the wrong credentials.

**Decision recorded:** ship all three. `account` binding is folded into `plan_id` (C4);
`TT_LOCK_PROFILE` and `meta.account` echo are specified in amendment 8.

### 2.7 DevOps F1 / QA F-25 — Windows `chmod 0600` is a fiction

**Verdict: CONFIRM; DECIDE — support Windows with ACL-based protection (do not silently skip).**

Round 1 (`Security F7`) specified POSIX `0600` + `0700` dir + a mode-asserting test. The DevOps
and QA reviews correctly note that on win32 `fs.chmod` only toggles the read-only bit,
`stat().mode` reports a synthesized `0666`, and the mode-assertion test **cannot pass** on the
Windows CI leg — so the leg is either permanently red or the assertion is silently skipped,
quietly voiding the security *claim*.

The security question the task asks is precise: *what replaces 0600 on Windows — an ACL spec or
explicit non-support?* Decision:

- **Support Windows explicitly, with a documented ACL-based secret protection.** The equivalent
  of `0600` on Windows for this threat model ("other *users'* local processes read the file")
  is the **default DACL of the per-user profile directory**: `%LOCALAPPDATA%\tiktok-mcp-ai\` is
  not readable by other non-admin users. That is comparable in practice to `0600` for the
  stated adversary. (Same-user processes can read the file on *every* OS — that is out of scope
  on every OS, so Windows is not weaker here than POSIX.)
- **Storage location must be platform-aware.** `~/.config` is un-idiomatic on Windows. One
  resolver: `TT_ENV_FILE` (explicit) → `$XDG_CONFIG_HOME` if set → win32 ?
  `%LOCALAPPDATA%\tiktok-mcp-ai` : `~/.config/tiktok-mcp-ai`. Tokens should **not roam**, so
  `%LOCALAPPDATA%` (machine-local), not `%APPDATA%` (roaming). The journal and lockfile follow
  the same resolver.
- **The test contract becomes platform-gated (`QA F-25`):** POSIX asserts `stat().mode == 0600`
  (env, journal) and `0700` (dir); win32 asserts instead that (a) the file resolved under the
  per-user data dir and (b) the chmod call was *skipped with a named reason*, not silently a
  no-op. `SECURITY.md` must state the honest contract: POSIX → 0600 enforced; Windows → per-user
  profile ACL, `icacls` hardening optional and not a v1 blocker.

**Decision recorded:** Windows supported with ACL protection; platform-aware resolver;
platform-gated assertions; honest `SECURITY.md` wording. See amendment 5.

### 2.8 QA F-6 — host-guard negatives and upload PUT header hygiene

**Verdict: CONFIRM; fold into the upload_url control (C3).**

Two QA points are load-bearing and are absorbed into the specified controls: (1) a naive
`endsWith("tiktokapis.com")` matches `eviltiktokapis.com` — the allowlist must be exact-apex-
or-dot-bounded-subdomain, tested with an explicit negative suite including `eviltiktokapis.com`,
`open.tiktokapis.com.attacker.tld`, and IDN/punycode homographs; (2) the upload PUT must carry
**no `Authorization: Bearer <access_token>` header** — the upload session authenticates via the
`upload_token` in the URL, and sending the account bearer to a (validated-but-still-distinct)
host is a needless credential exposure. C3 encodes both.

### 2.9 QA F-19 / Security F14 — `timingSafeEqual` on unequal-length buffers

**Verdict: CONFIRM; the fix is a one-liner and is specified in C6.** Compare fixed-length
SHA-256 digests of provided vs expected token so length never varies (no `RangeError`, no length
oracle, constant-time). This also cleanly handles the empty/absent-token case (digest of "" ≠
digest of secret).

---

## 3. Specified controls (round-1 High/Critical, resolved concretely)

Each control below is written to be directly implementable and directly testable. "Sinks"
means every place bytes can escape the process toward a human, a log, a model, or disk.

### C1 — Core-level allowlist logging & redaction architecture (resolves Security F1, F2)

**Root cause restated in one line:** the code that touches raw secrets (`core/oauth.ts`,
`core/http.ts`) is Layer 0 and logs to stderr directly, but the named scrubber `mcp/redact.ts`
is Layer 2 — and the layering rule forbids `core` importing `mcp`. So the most secret-laden
logs bypass the only redactor.

**Control:**

1. **Redaction primitive moves to `core/redact.ts`** (Layer 0). Every logger in every layer
   calls it *before* serialization. `mcp/redact.ts` becomes a thin re-export for the model-
   facing path (no independent logic). This is a hard layering fact, testable via the existing
   ESLint `no-restricted-imports` rig plus a test that greps for any `process.stderr`/`console`
   write not routed through the core logger.

2. **Enumerate every sink and the redaction it is subject to** (this table is the contract —
   put it in `SECURITY.md`):

   | # | Sink | What may reach it | Redaction applied |
   |---|------|-------------------|-------------------|
   | 1 | stderr JSON logs | operational events | core redaction on every field; untrusted metadata kept out of `logFields` (`Security F16`) |
   | 2 | MCP `logging` capability mirror (to client) | same events as stderr | **same** core redaction — the mirror serializes the *already-redacted* record, never the raw one |
   | 3 | Tool result envelope (`data`) | model-facing data | core redaction + `Authorization: Bearer ***` masking; `open_id`/`union_id` truncated |
   | 4 | Error `detail` / `message` | cause + recovery | core redaction; **never** serialize a raw upstream request/response body |
   | 5 | Plan preview | resolved payload | `Authorization` masked; `upload_url` shown as origin+path only; resolved file path + byte size shown (that is *intended* disclosure to the human) |
   | 6 | `journal.ndjson` | audit rows | no secrets by construction (see inventory §4); title *excerpt* allowed (`AI-DX F4`), never tokens |
   | 7 | `doctor` output | diagnostics | core redaction; scope/version/paths only, never token values |
   | 8 | stdout | JSON-RPC protocol only | nothing else ever (`QA F-8`: dotenv/console must not print to stdout) |

3. **OAuth subsystem uses allowlist logging, not denylist redaction** (this is the F2 core).
   The token endpoint request is *form-encoded* (`client_secret`, `code`, `code_verifier`,
   `refresh_token`) and the response is JSON (`access_token`, rotated `refresh_token`). A
   key/Bearer-shaped denylist can miss form fields and non-Bearer-shaped refresh tokens.
   Rule: **`core/oauth` never serializes a raw request or response body.** It logs only this
   allowlist: `{ grant_type, scope, open_id (truncated), expires_in, http_status, log_id }`.
   Anything else on that path is dropped, not redacted.

4. **Global scrub set** (for the denylist that guards sinks where allowlisting is impractical):
   `access_token`, `refresh_token`, `client_secret`, `code`, `code_verifier`, `Authorization`,
   `upload_token` (query-string aware — see C3), plus the full callback URL and any `upload_url`
   query string. Redactor must be **query-string aware** and **form-body aware**, not only
   JSON-key aware.

5. **Test invariants (extend `TESTING.md` downward into `core`):**
   - Seed each secret into a `core/oauth` refresh *error* and assert it is scrubbed on **stderr**
     and in the **client mirror**, not merely in a tool result.
   - Property test (`QA F-23`): redaction is idempotent (`redact(redact(x)) == redact(x)`),
     depth-complete (nested objects/arrays scrubbed), and does not over-redact non-secret
     lookalikes it should keep (e.g., a video `id`).
   - Log-forging test (`Security F16`): a video title containing `\n`, `{`, `}` is JSON-escaped,
     never string-concatenated into a log line.

### C2 — `TT_MEDIA_ROOT` confinement for `file_path` uploads (resolves Security F3)

**Threat:** `file_path` is an arbitrary, model-chosen absolute path; on apply the server reads
those bytes and PUTs them off-box. A prompt-injected model can name `~/.ssh/id_rsa` or the env
file itself and exfiltrate it as a "video."

**Control — the exact resolution algorithm:**

1. **Configured root.** `TT_MEDIA_ROOT` (operator-set). Default: **fail-closed** — if unset,
   uploads from local `file_path` are rejected with a named error instructing the operator to
   set `TT_MEDIA_ROOT`. (Do *not* default to CWD silently; CWD under an agent is attacker-
   influenced. A documented `TT_MEDIA_ROOT=$PWD` opt-in is fine, but it must be a choice.)
2. **Canonicalize both sides with `realpath`** (following symlinks) **before** comparison:
   `resolved = realpath(file_path)`, `root = realpath(TT_MEDIA_ROOT)`.
3. **Containment check on the canonical paths:** `resolved === root || resolved.startsWith(root
   + path.sep)`. This defeats `..` traversal (canonicalization removes it) and symlink escape
   (realpath resolves the link target, so a symlink inside the root pointing to `/etc` fails
   the check). Reject with a named error otherwise.
4. **TOCTOU re-validation at apply (`Security F9` threat #9):** the canonicalization + strict
   container sniff happens at **plan** time (for the preview) **and again at apply** time,
   immediately before the read, on the *same resolved path*, and the file's `(size, mtime,
   dev, ino)` captured at plan must match at apply — otherwise the bytes changed since the
   human saw the preview → reject, re-plan. This binds the reviewed bytes to the posted bytes.
5. **Strict container validation, not magic-byte prefix (`Security F3` deep dive):** parse the
   MP4/MOV box structure (presence and sanity of `ftyp`/`moov`), not just the first 12 bytes —
   a crafted file with a valid `ftyp` prefix and arbitrary tail must be rejected.
6. **Human-visible disclosure:** the plan preview always renders the **resolved absolute path**
   and **byte size**, so a reviewing human sees exactly which file leaves the machine. This is
   the single most effective mitigation and costs nothing.

**Residual risk (honest):** confinement only bounds *which* files can leave; a human who
rubber-stamps a preview naming a legitimate-but-sensitive file inside the root, or an operator
who sets `TT_MEDIA_ROOT=$HOME`, defeats it. Document that `TT_MEDIA_ROOT` should be a dedicated
media directory, never `$HOME` or a config dir.

### C3 — `upload_url` validation algorithm (resolves Security F8; folds Platform F4, QA F-6)

The `upload_url` is TikTok-returned (not hard-coded) and is where local bytes leave the box, so
it is treated as if it were the *only* barrier even though TLS from the pinned origin makes it
defense-in-depth today.

**Algorithm (in order; any failure → reject, no request sent):**

1. **Parse** the URL with the WHATWG URL parser. Reject if parsing fails.
2. **Scheme** must be exactly `https:`.
3. **No credentials in URL** — reject if `username` or `password` is present.
4. **Host allowlist by registrable domain, dot-bounded.** Maintain a named allowlist of
   TikTok apexes that now must include **`open-upload.tiktokapis.com`** (upload) alongside
   `open.tiktokapis.com` (data). Match = host is exactly an allowlisted apex, **or** a true
   subdomain ending in `"." + apex`. Never `endsWith(apex)` (that admits
   `eviltiktokapis.com`, `QA F-6`). Reject IDN/punycode homographs (compare the ASCII/A-label
   form).
5. **Port** must be `443` (or empty, i.e. the https default). Reject non-standard ports.
6. **Resolve + pin public IPs.** DNS-resolve the host; assert **every** resolved address is
   publicly routable — reject loopback, RFC-1918 private, link-local (incl.
   `169.254.169.254` cloud-metadata), CGNAT, and IPv6 ULA/link-local. Then **connect to the
   pinned resolved IP while preserving the validated `Host` header and SNI**, so a rebind
   between check and connect cannot redirect the bytes (TOCTOU).
7. **`redirect: "error"`** on the fetch (`Architecture Finding 10`): a 3xx to any host is an
   allowlist bypass; refuse to follow redirects on the upload PUT (and on all egress).
8. **Header hygiene (`QA F-6`):** the upload PUT carries **no `Authorization: Bearer`** —
   the `upload_token` in the URL authenticates the session; do not also send the account token
   to this host.
9. **Redaction (`Platform F4`):** the whole `upload_url` (which contains the `upload_token`
   secret) is redacted everywhere — logs, errors, preview, journal, doctor. Where the URL must
   be shown at all (e.g., a debug line), show **origin + path only**, never the query string.

**Test suite (`TESTING.md § core/http`, host-guard negatives):** positive
`open-upload.tiktokapis.com`; negatives `eviltiktokapis.com`, `open.tiktokapis.com.attacker.tld`,
`open-upload.tiktokapis.com:8443` (bad port), `http://` (bad scheme), a host resolving to
`127.0.0.1`/`169.254.169.254`/`10.0.0.1` (private-IP), a 302-redirect response (must not
follow), a URL with `user:pass@` credentials, and an `upload_url` asserted absent from every
sink.

### C4 — Unified plan-and-apply mechanism: `plan_id` (resolves Security F4, AI-DX F1, Architecture Finding 2)

**One mechanism, three layers** (see cross-examination §2.5):

1. **Plan step** (`apply` absent/false) validates, queries `creator_info`, runs C2 media checks,
   then stores server-side, keyed by a freshly generated single-use **`plan_id`** (e.g.
   `plan_<24 hex>` from `randomBytes`):
   - `SHA-256` of the **canonicalized** resolved post arguments (stable key order, normalized
     values — this is the args-hash binding),
   - the resolved **account profile + `open_id`** (account binding, subsumes `Security F11` /
     `AI-DX F10`),
   - a **TTL** (default 10 min),
   - `used: false`.
   The plan response embeds directive **hints** at the decision point (recency beats a
   description read thousands of tokens ago):
   `["This is a preview only — nothing was posted.", "Show this to the user and get explicit
   approval in their own message before applying.", "To execute: re-call with apply and
   plan_id \"plan_…\"."]`.
2. **Apply step** requires `plan_id` (schema: `apply` and `plan_id` required together via a zod
   refinement / discriminated shape). Server verifies **exists ∧ unexpired ∧ unused ∧
   args-hash-match ∧ account-match**; on any mismatch → `ok:false` with a recovery hint
   ("Plan expired or arguments changed — re-call without apply to get a fresh preview, show it,
   apply only after the user approves."). On success, mark `used` (single-use) **before** the
   network call so a retry cannot replay it.
3. **Journal dedup guard (`Architecture Finding 2`)** runs *in addition*: before init, compute a
   content fingerprint (account + normalized title/privacy/media identity) and check the recent
   journal; a byte-identical very-recent post → refuse with a "looks like a duplicate of
   publish_id X — confirm you intend a second post" hint. This catches the lost-response
   double-post (`AI-DX F4`) that `plan_id` alone does not.
4. **Elicitation** (MCP) is the hard human control where supported: on apply, issue an
   elicitation ("Post '<title>' as <privacy> to @<nickname>?") and execute only on human accept.
   Feature-detect; plan_id-only is the floor. `doctor` reports whether the connected client
   supports elicitation.
5. **`TT_WRITE_MODE` matrix restated:** `plan` (default) = `plan_id` required + elicitation when
   available; `apply` = operator explicitly waives both (documented "trusted-automation only,
   for pipelines not chat — no injection resistance"); `deny` = write tools unregistered.

**Residual risk, stated in the spec (not hidden):** `plan_id` makes skipping the preview
*impossible* and neutralizes single-message injection (it cannot know an unissued `plan_id`),
but it does **not** prove a human was between the two calls — an autonomous model can chain
plan→apply. Only elicitation or out-of-band human review of `plan`-mode previews closes that.
`SECURITY.md`'s prompt-injection paragraph is rewritten to claim exactly this.

### C5 — Cross-process refresh: advisory lock + read-merge-write (resolves Architecture Finding 1 / QA F-3 / DevOps F8)

**Classification (honest):** reliability fix with an atomicity-preservation constraint; **not**
a new confidentiality/integrity control (same-user processes are already out of scope).

**Control:**

1. Around the **entire** refresh critical section — *acquire lock → re-read on-disk tokens →
   decide → refresh → persist (atomic temp+rename) → swap in-memory snapshot → release lock* —
   hold a **advisory file lock** (`lockfile` beside the env file, e.g.
   `.env.lock`, created `O_EXCL` `0600` in the `0700` dir, unpredictable-name discipline per
   `Security F7`).
2. **Read-merge-write:** inside the lock, re-read the on-disk `refresh_token`; if it is newer
   than the in-memory one (another process already rotated), **adopt it and skip the refresh**;
   otherwise refresh and persist the rotated token. This tolerates the race instead of losing
   the update.
3. Preserve the round-1 **torn-read impossibility**: the access/refresh pair is written and
   snapshot-swapped atomically, so no observer ever sees a mismatched pair. The lock must not
   change that.
4. `doctor` check: detect multiple concurrent server processes for the same profile and warn
   (`DevOps F8`).
5. Windows note: advisory locks and atomic rename behave differently (EPERM/EBUSY when the
   destination is open); the writer retries-on-EPERM briefly on win32 (`DevOps` deep dive A.3).

### C6 — Loopback HTTP transport: Origin/Host validation + mandatory token (resolves Security F5; folds Architecture Finding 9, Security F14, F9)

**Control:**

1. **Origin/Host validation even on loopback (`Architecture Finding 9`, MCP spec requirement).**
   Reject any request whose `Origin` header is a browser origin (any `http(s)://…` site) and
   whose `Host` is not the expected loopback authority. This defeats the DNS-rebinding /
   hostile-page-drives-loopback class. Applies to both the MCP HTTP listener **and** the OAuth
   callback listener (§2.2 caveat).
2. **Require `TT_HTTP_TOKEN` whenever `TT_TRANSPORT=http`** — loopback or not. Round 1 only
   required it for non-loopback; a tokenless loopback listener is reachable by any local page.
3. **Constant-time token check via fixed-length digests (`Security F14`/`QA F-19`):** compare
   `sha256(provided)` vs `sha256(expected)` with `timingSafeEqual` — equal-length always, no
   `RangeError`, no length oracle; absent/empty token digests to a non-matching value → 401.
4. **Non-loopback requires TLS (`Security F9`):** refuse to bind a non-loopback address without
   TLS unless an explicit `TT_HTTP_INSECURE=1` acknowledgement is set; document HTTP mode as an
   advanced loopback dev-bridge, stdio remaining the default.
5. Session ids from `randomUUID` (already specified) — unchanged.

### C7 — OAuth flow hardening (resolves Security F12, F13, F18; folds Platform F1, F5)

1. **Entropy (`Security F18`):** `state` and `code_verifier` both from `crypto.randomBytes(≥32)`
   base64url. Verifier length lands in the RFC 7636 43–128 range; charset is a subset of the
   allowed unreserved set.
2. **hex challenge with pinned test vector (`Platform F1`, §2.1):** `code_challenge =
   lowercase-hex(sha256(verifier))`; freeze one `(verifier, expected)` test vector.
3. **Wildcard-port loopback (`Platform F5`, §2.2):** bind `127.0.0.1:0`, derive the redirect
   URI from the assigned port; delete `TT_REDIRECT_PORT`. Listener is strictly one-shot, closes
   after the first callback, validates `state` in **constant time**, ignores requests with a
   non-matching `state`, and returns a neutral page reflecting no request content.
4. **`code` handling (`Security F12`, F2):** add the authorization `code` and the full callback
   URL to the scrub set. Manual-paste fallback accepts only the `code` (not the whole URL), reads
   it without echo, never persists it, uses it once. Prefer the loopback listener; paste is a
   true fallback only.

### C8 — Least-privilege login scopes (resolves Security F6)

Default `TT_LOGIN_SCOPES` to the **read** scopes and **derive requested scopes from the
configured tool packages**; publishing requires an explicit re-login opting into
`video.publish`/`video.upload` (or explicit `--scopes`). A reader-only deployment must never
hold a refresh token carrying posting authority. Note `Platform Finding 6`: `creator_info`
requires the `video.publish` scope, so the scope-derivation table must map the publish package
(not the reader package) to include it.

---

## 4. Revised threat model (replacement text for `SECURITY.md § Threat model`)

> ### Threat model
>
> **Deployment shape.** `tiktok-mcp` is a **local, single-user process** launched by an MCP
> client (stdio by default). It holds one operator's TikTok app credentials and that operator's
> user tokens. It is not a hosted or multi-tenant service.
>
> **Assets (what we protect):**
> - **User OAuth tokens** — access (24 h) and refresh (365 d, rotated on use).
> - **App `client_secret`** and `client_key`.
> - **The `upload_token`** carried inside a TikTok-returned `upload_url` (bearer-equivalent for
>   one upload session).
> - **Account integrity** — no unwanted, wrong-account, or wrong-privacy posts.
> - **Local files** — only operator-intended media may leave the machine.
> - **The audit trail** (`journal.ndjson`) as a privacy artifact.
>
> **Trust boundaries (text diagram):**
> ```
>   [ TikTok API ]  <—TLS, pinned origins—>  ┌─────────────────────────────┐
>   open.tiktokapis.com (data)               │  tiktok-mcp process          │
>   open-upload.tiktokapis.com (upload)      │  core (secrets, http, oauth) │
>        ▲                                    │   ── boundary A ──           │
>        │ egress allowlist + IP pin          │  api                         │
>        │ redirect:error                     │   ── boundary B ──           │
>   ─────┼──────────────────────────────      │  mcp (transport, redact)     │
>        │                                    │   ── boundary C ──           │
>   [ MCP client / model ] <—stdio JSON-RPC—> │  tools                       │
>        ▲   untrusted model + 3p content     └─────────────────────────────┘
>        │                                          │ 0600 env file, 0700 dir,
>   [ browser (login redirect) ]                    │ journal, advisory lock
>        │  loopback listener, Origin+state         ▼
>        └───────────────────────────────────  [ local filesystem, TT_MEDIA_ROOT ]
> ```
> - **Boundary A (process ↔ TikTok):** egress allowlist (hard-coded data origin; validated
>   upload host with IP pinning; `redirect:error`); TLS.
> - **Boundary B (process ↔ model/client):** every tool result and mirrored log passes core
>   redaction; results are data, never instructions; no tool output is auto-fed to another tool.
> - **Boundary C (process ↔ local disk):** secrets in a `0600` file under a `0700` (POSIX) /
>   per-user-ACL (Windows) dir; `file_path` confined to `TT_MEDIA_ROOT`.
>
> **Adversaries considered:**
> 1. **Malicious or confused model** — issues tool calls the user did not intend, including
>    `apply`, wrong `account`, or an out-of-root `file_path`.
> 2. **Prompt injection via third-party content** — a video title/description or a fetched web
>    page carries "post this now / upload that file / switch to the brand account."
> 3. **Hostile web page in the user's browser** — reaches the loopback HTTP listener or the OAuth
>    callback listener (DNS-rebinding / same-origin bypass).
> 4. **Other local users' processes** — read the env file, journal, or process environment.
> 5. **Network attackers** — on non-loopback HTTP paths.
> 6. **Denial-of-wallet / quota** — a runaway loop burns the unaudited 5-user/24 h cap or Display
>    QPS, locking out the legitimate user.
> 7. **Supply-chain** — a compromised release or transitive dependency.
>
> **Controls mapped to threats:** (1,2) plan-and-apply `plan_id` + journal dedup + elicitation
> (C4); over-privilege bounded by least-scope login (C8); `account` bound into `plan_id` +
> optional `TT_LOCK_PROFILE` + `meta.account` echo. (2 exfiltration) `TT_MEDIA_ROOT` confinement
> + strict container sniff + TOCTOU re-check (C2); `upload_url` IP-pinned allowlist (C3);
> core-level redaction so tokens never reach any sink (C1). (3) Origin/Host + `state` validation
> on both listeners, mandatory `TT_HTTP_TOKEN` for HTTP (C6); wildcard-port one-shot loopback
> (C7). (4) `0600`/`0700` POSIX, per-user ACL on Windows; `client_secret` steered to the env
> file not the MCP client config; journal `0600`, bounded, purgeable. (5) TLS required for
> non-loopback. (6) client-side publish token bucket; document the read-side quota gap. (7) npm
> trusted publishing (OIDC) + provenance, 2FA, pinned actions, `files` allowlist, no install
> scripts.
>
> **Explicit non-goals (out of scope):**
> - A **hostile local root** user (can read any file / any process memory).
> - A **compromised MCP client** (it holds the app secret and sees every result by design — we
>   enumerate that trusted data rather than defend against a malicious client).
> - **Same-user cooperating processes** reading files they are entitled to read (this is a
>   correctness concern for token rotation, handled by C5, not a confidentiality boundary).
> - **Proving a human approved** a post — `plan_id` forces a preview to exist and binds the
>   bytes/account, but only client-supported elicitation or out-of-band review of `plan`-mode
>   previews provides a hard human checkpoint. `TT_WRITE_MODE=apply` waives even the soft gate.

---

## 5. Secrets inventory (every secret, home, forbidden sinks, control)

| Secret | Lives in | Must NEVER reach | Control that prevents it |
|--------|----------|------------------|--------------------------|
| **Access token** (24 h) | env file `0600`; in-memory snapshot | stdout, stderr logs, client mirror, tool results, error detail, plan preview, journal, doctor | C1 core redaction on every sink; `Authorization: Bearer ***` masking; never in a tool schema (login-only) |
| **Refresh token** (365 d, rotated) | env file `0600`; in-memory snapshot | all of the above; **not Bearer-shaped** so denylist alone is unsafe | C1 OAuth allowlist logging (never serialize token response body); atomic write + C5 lock preserve integrity |
| **`client_secret`** | env file `0600` (preferred) — **not** MCP client config | logs, results, errors, preview, journal; process env of spawned children | C1 scrub set; steer to env file not JSON config (`Security F10`); confirm no re-export to child env |
| **`client_key`** | env file | low-sensitivity but treated as secret in logs | C1 scrub set |
| **`upload_token`** (in `upload_url`, per-session bearer) | transient, in-memory during an upload | **any** log/preview/journal/doctor; especially query-string logging | C1 query-string-aware redaction; C3 shows `upload_url` as origin+path only; upload PUT sends no account bearer |
| **Authorization `code`** (single-use, login) | transient, login process memory; browser URL bar / clipboard in paste fallback | logs, persistence, shell history, error detail | C7: scrub set incl. `code` + callback URL; paste fallback reads code only, no echo, no persist, single use |
| **`code_verifier`** (PKCE) | login process memory only | logs, persistence, any sink | C1 scrub set; never leaves the login process; C7 |
| **`state`** (CSRF nonce) | login process memory | (not a confidentiality secret, but) must be unpredictable + constant-time compared | C7: `randomBytes(≥32)`, constant-time compare |
| **`TT_HTTP_TOKEN`** (HTTP bearer) | env / operator config | logs; must be length-hidden in comparison | C6: fixed-length digest compare (no length oracle) |

---

## 6. Spec amendments (ordered, concrete edits)

Ordered by dependency (a change others reference comes first).

1. **`ARCHITECTURE.md §10` + `§1` (redaction location).** Replace "`mcp/redact.ts` scrubs …"
   with: the redaction primitive lives in **`core/redact.ts`**; every logger in every layer
   calls it before serialization; `mcp/redact.ts` is a thin re-export for the model-facing path;
   **all** stderr and client-mirrored logs pass through core redaction. Add the sink table (C1.2)
   and the OAuth allowlist-logging rule (C1.3).

2. **`SECURITY.md § Secrets` + new § Threat model.** Replace the threat-model section wholesale
   with §4 above. Replace the "`mcp/redact.ts` scrubs known secret keys and bearer-shaped
   strings" bullet with the C1 contract (core-level, allowlist on OAuth, query-string + form
   aware). Add the secrets inventory table (§5).

3. **`SECURITY.md § Write safety` + `§ Prompt-injection surface`; `TOOLS.md § publish`;
   `ARCHITECTURE.md §8`; `CONFIGURATION.md § write policy`.** Replace the overstated
   prompt-injection paragraph with the C4 mechanism and its **honest residual-risk** statement.
   Change the `apply` contract from `apply: boolean` to `apply` + required `plan_id`
   (zod-refined). Document the `plan`/`apply`/`deny` matrix per C4.5. Add the journal dedup guard
   and elicitation-as-target-state.

4. **`TOOLS.md § tiktok_post_video / tiktok_upload_video_draft` + `§ Cross-cutting`;
   `ARCHITECTURE.md §6.1`; `CONFIGURATION.md`.** Add `TT_MEDIA_ROOT` (fail-closed default) and
   the C2 resolution algorithm; change `file_path`'s description to state the confinement and
   that the resolved absolute path + byte size appear in the preview. Add the plan/apply TOCTOU
   re-check.

5. **`CONFIGURATION.md` intro; `AUTH.md §4`; `SECURITY.md § Secrets`; `ARCHITECTURE.md §7/§8`;
   `TESTING.md § core/config`.** Add the platform-aware path resolver (C-DevOps: `TT_ENV_FILE` →
   `$XDG_CONFIG_HOME` → win32 `%LOCALAPPDATA%` : `~/.config`). State the honest POSIX-`0600` /
   Windows-per-user-ACL contract. Make the mode-assertion test **platform-gated** (POSIX asserts
   `0600`/`0700`; win32 asserts location + named chmod-skip). Add `0700` dir, `mkstemp`-style
   `O_EXCL 0600` temp, `fsync`+rename, orphan-temp cleanup, journal `0600` (`Security F7`).

6. **`AUTH.md §1`; `CONFIGURATION.md § OAuth`; `docs §6.1`.** Replace the fixed-`43110` /
   `TT_REDIRECT_PORT` design (and its self-contradiction) with the wildcard-port loopback
   (`127.0.0.1:0`, derive URI from assigned port). Delete `TT_REDIRECT_PORT`. Specify one-shot
   listener, constant-time `state`, Origin/Host validation, neutral no-reflect page, manual-paste
   as fallback-only reading code without echo. Add the hex-challenge pinned test vector and the
   `randomBytes(≥32)` entropy spec (C7).

7. **`ARCHITECTURE.md §6.1` + `§6` (retry) + `SECURITY.md § Egress`; `TESTING.md § core/http`.**
   Add `open-upload.tiktokapis.com` to the allowlist; replace any suffix match with the C3
   dot-bounded registrable-domain algorithm; add scheme/port/credentials checks, DNS-resolve +
   public-IP assertion + IP-pinning, `redirect:"error"` on all egress, no-Authorization on upload
   PUTs, and `upload_url` (with `upload_token`) redaction (origin+path only). Add the host-guard
   negative suite (C3 tests). Note that individual chunk PUT retries are safe/idempotent
   (`AI-DX F11`) even though inits are not.

8. **`ARCHITECTURE.md §5/§7`; `AUTH.md §3`; `TOOLS.md § header`; `CONFIGURATION.md`.** Add
   `TT_LOCK_PROFILE=1` (removes the auto-injected `account` arg, pins the session); every result
   envelope carries `meta.account` (+ truncated `open_id`); unknown-profile → local validation
   error listing configured profiles (`Security F11` + `AI-DX F10`). Note the `account` binding is
   already enforced via `plan_id` (C4).

9. **`AUTH.md §1/§5`; `CONFIGURATION.md § OAuth`; `ARCHITECTURE.md §5`.** Default `TT_LOGIN_SCOPES`
   to read scopes; derive requested scopes from configured packages; publish requires explicit
   re-login. Map the publish package to include `video.publish` (needed for `creator_info`,
   `Platform F6`) (C8).

10. **`ARCHITECTURE.md §3`; `CONFIGURATION.md § Transport`; `SECURITY.md § Transport`.** Require
    `TT_HTTP_TOKEN` whenever `TT_TRANSPORT=http`; add Origin/Host + `state` validation on both
    listeners; fixed-length-digest constant-time token compare; require TLS (or explicit
    `TT_HTTP_INSECURE=1`) for non-loopback (C6).

11. **`ARCHITECTURE.md §7`; `AUTH.md §2`; `DevOps` alignment.** Add the C5 advisory-lock +
    read-merge-write refresh sequence and the `doctor` multi-process check; classify it as a
    reliability fix preserving torn-read atomicity.

12. **`ARCHITECTURE.md §8`; `AUTH.md §2`; `SECURITY.md § Write safety`.** Bound/rotate the
    journal, `0600`, document retention and `--revoke --purge-journal`; journal append failure is
    a logged warning that never fails a publish and surfaces `journal:"unavailable"`
    (`Security F15` + `DevOps F9`). Store a title *excerpt*, never a secret (`AI-DX F4`).

---

## 7. Remaining unknowns

These require upstream verification or an explicit operator decision and cannot be closed at
design time:

1. **Exact TikTok upload-host set.** `open-upload.tiktokapis.com` is verified (`Platform F4`),
   but whether TikTok ever returns a *different* upload subdomain (regional edge, CDN) is unknown.
   The C3 allowlist must be confirmed against live init responses at implementation time; if
   TikTok uses per-region hosts, the allowlist becomes a small set of apexes, not one. **Do not**
   relax to a suffix match to accommodate this — enumerate.
2. **`upload_token` lifetime and reuse semantics.** Whether the `upload_token` is single-use,
   per-chunk, or valid for the whole session bounds how long it is a live secret in memory and
   whether a failed-upload token is safely reusable on resume. Affects `AI-DX F11` resume design.
3. **Whether TikTok invalidates rotated-away refresh tokens immediately.** C5's necessity hinges
   on this; if the old refresh token has a grace window, the race is milder. Verify empirically.
4. **MCP client elicitation support in the field.** C4's hard human control depends on client
   support that is currently uneven; the floor (plan_id) must carry the design until elicitation
   is broadly available. `doctor` should report per-client support once measurable.
5. **DNS-pinning interaction with the HTTP client library.** Connecting to a pinned IP while
   preserving Host/SNI (C3 step 6) may require a custom lookup/agent depending on the chosen
   client; feasibility with three runtime deps needs a spike.
6. **Windows `icacls` hardening.** Whether to actively set a restrictive DACL (beyond relying on
   the inherited per-user profile ACL) is deferred; it is not a v1 blocker but should be revisited
   if a shared-Windows-host deployment is ever in scope.
7. **Read-side denial-of-wallet.** The publish token bucket guards writes; there is no equivalent
   guard on Display-API reads, so a runaway loop can still exhaust Display QPS. Whether to add a
   read-side limiter (and its default) is an open product decision.

*End of round-2 deep security review.*
