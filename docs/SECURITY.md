# Security

Design-security document for tiktok-mcp-ai (not the disclosure policy — that is
the root `SECURITY.md`, see § Reporting). Normative on its own; sparse
`rationale: SYNTHESIS § x` pointers reference
`docs/reviews/round2/SYNTHESIS.md` for the *why* only.

## Threat model

**Deployment shape.** A **local, single-user process** launched by an MCP
client (stdio by default). It holds one operator's TikTok app credentials and
that operator's user tokens. It is not a hosted or multi-tenant service.

**Assets:**

- User OAuth tokens — access (24 h) and refresh (365 d, rotated on use).
- App `client_secret` (and `client_key`).
- The `upload_token` carried inside a TikTok-returned `upload_url`
  (bearer-equivalent for one upload session).
- Account integrity — no unwanted, wrong-account, or wrong-privacy posts.
- Local files — only operator-intended media may leave the machine.
- The publish journal (`journal.ndjson`) as an audit/privacy artifact.

**Adversaries considered:** a malicious or confused model issuing tool calls;
prompt injection via third-party content (video titles/descriptions, fetched
pages); a hostile web page in the user's browser reaching a loopback listener;
other local **users'** processes reading files; network attackers on
non-loopback HTTP paths; runaway loops burning quota; supply-chain compromise.

**Explicit non-goals:** a hostile local root user; a compromised MCP client
(it sees every result by design); same-user cooperating processes reading
files they are entitled to read (a correctness concern for token rotation,
handled by the env-file lock — not a confidentiality boundary); *proving* a
human approved a post (see § Prompt-injection surface).

## Controls

### Secrets & storage

- Tokens and the client secret live in one env file, resolved as:
  `TT_ENV_FILE` → XDG config dir (`~/.config/tiktok-mcp-ai/.env`) on POSIX →
  `%LOCALAPPDATA%\tiktok-mcp-ai\.env` on win32. Writes are atomic
  (0600 temp file, fsync, rename); the publish journal is `0600` in a `0700`
  directory beside the resolved env file.
- **File permissions are asserted on POSIX only**: env file and journal
  `0600`, directory `0700`, with mode-asserting tests. `fs.chmod(0o600)` is
  still called unconditionally on all platforms, but **on win32 chmod is a
  no-op** — see the Windows paragraph below. `doctor` warns on permission
  drift and offers to fix it; runtime writes always re-apply `0600` (CC-F3).
- Tokens never transit an MCP tool in either direction; authorization happens
  only in the `login` CLI flow. The `client_secret` is steered to the env
  file, never the MCP client's JSON config.
- No secret ever enters: stdout (protocol channel), stderr logs, the MCP log
  mirror, tool results, error messages, plan previews (`Authorization:
  Bearer ***`), the publish journal, or `doctor` output.

**Windows token storage** (rationale: SYNTHESIS § 2.1). On win32 there is no
POSIX mode to enforce: `fs.chmod` cannot restrict access and `stat().mode` is
synthesized. The protection boundary is the **default DACL of the per-user
profile directory** — `%LOCALAPPDATA%\tiktok-mcp-ai` is not readable by other
non-admin users, which is equivalent to `0600` for the stated adversary
(other local users; same-user processes are out of scope on every OS).
Consequences:

- Mode is asserted only when `process.platform !== "win32"`; the win32 test
  asserts location + content round-trip, with a named chmod-skip reason.
- `icacls` hardening is optional and **never run automatically** — `doctor`
  prints the profile-ACL info line and the `icacls` command as remediation
  *text* only.
- Atomic rename onto an open handle can fail EPERM/EBUSY on win32: retried
  ×3 (50/100/200 ms), then degrade to in-memory token + warning — a persist
  failure never discards a valid in-memory token.

**Secrets inventory** (every entry is registered with the redactor and banned
from every sink):

| Secret | Lives in | Notes |
|---|---|---|
| access token | env file, in-memory snapshot | `Authorization: Bearer ***` masking everywhere |
| refresh token | env file, in-memory snapshot | not Bearer-shaped — shape-based denylists alone are unsafe |
| `client_secret` | env file | never in MCP client config; not re-exported to child env |
| `upload_token` | inside `upload_url`, transient | query-string secret — see § Egress control |
| authorization `code`, `code_verifier`, `state` | login process memory only | full callback URL is also scrubbed; paste fallback reads the code without echo, never persists it |
| `TT_HTTP_TOKEN` | env / operator config | compared via fixed-length digests (no length oracle) |

### Redaction (`core/redact`)

- The redaction primitive lives in **`core/redact`** (Layer 0), **below every
  sink**: stderr log lines, the MCP client log mirror, error messages, body
  snippets (CC-B2), tool results, plan previews, journal rows, `doctor`
  output. Loggers in every layer pass field values through it *before*
  serialization; `mcp/`-level redaction is a thin re-export, never a second
  implementation. Rationale: SYNTHESIS SYN-12.
- Redaction is **allowlist-based and default-deny**: unknown keys are
  redacted unless allowlisted, rather than known-bad keys being scrubbed.
- **Exact-value secret registration**: tokens, `client_secret`, and
  `upload_token` are registered as exact values (`registerSecret`) and
  scrubbed out of free text (`redactText`) — this catches secrets embedded in
  query strings and form bodies that key-based rules miss.
- The OAuth subsystem uses **allowlist logging**: `core/oauth` never
  serializes a raw token request or response body; it logs only
  `{grant_type, scope, truncated open_id, expires_in, http_status, log_id}`.
- Redaction is tested for idempotence, depth-completeness, and
  non-over-redaction; seeded-secret tests assert scrubbing on stderr and in
  the client mirror, not only in tool results.

### Egress control (SSRF posture)

- Data calls: hard-coded origin `https://open.tiktokapis.com`, no env
  override. OAuth authorize: `https://www.tiktok.com` (browser-side only).
- **Upload egress allowlist** (normative; rationale: SYNTHESIS § 2.5).
  Upload PUTs go only to the TikTok-returned `upload_url`, validated by
  `assertAllowedUrl` in `core/http` before any request is sent:
  1. Parse with the **WHATWG URL parser**; reject on parse failure. Matching
     runs on the parsed ASCII/A-label hostname (rejects IDN homographs).
  2. Scheme must be exactly `https:`.
  3. **No userinfo** — reject any URL carrying `username` or `password`.
  4. **Host allowlist**: the host is accepted iff it is exactly
     `open.tiktokapis.com`, exactly `open-upload.tiktokapis.com`, or matches
     `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$`. All matching is
     **dot-anchored on the full hostname** — **bare `endsWith` is banned**
     (it admits `eviltiktokapis.com`); the negative tests
     `eviltiktokapis.com` and `open.tiktokapis.com.attacker.tld` are
     mandatory.
  5. **Port 443 only** (an explicit `:443` or the https default); any other
     port is rejected.
  6. All egress runs with **`redirect: "error"`** — a 3xx to any host is an
     allowlist bypass, never followed (CC-B6).
- **No `Authorization` header on upload PUTs.** The `upload_token` inside the
  `upload_url` is the upload-session credential; the account bearer token is
  never sent to the upload host.
- **`upload_token` is a registered secret sink.** It must never appear in
  logs, error messages, or tool results; where an `upload_url` must be shown
  at all, only `origin + path` is shown — never the query string. The
  `upload_url` is opaque: used as returned, never rebuilt, never persisted.
- **Allowlist widening happens only by spec edit** — never by loosening to a
  blanket suffix match. Probe **P-9** records the upload hosts actually
  observed across runs; a new observed shape widens the pattern here first.
- `video_url` / `photo_urls` inputs (PULL_FROM_URL) are fetched by
  **TikTok**, not by this server — the server never fetches user-supplied
  URLs. It still validates `https:` scheme and rejects credentials-in-URL,
  and the tool description states the domain-verification requirement
  (CC-D10).

### DNS resolve-and-pin: deferred out of v1 (accepted risk)

Resolving the upload host and pinning the connection to verified-public IPs
is **deferred out of v1** (decision: SYNTHESIS § 2.6). It would require
custom dispatcher surgery in the HTTP client and introduce live-DNS behavior
that cannot be tested deterministically in CI, on the hottest data path.

**Compensating controls** (what stands in its place):

- TLS certificate validation against the allowlisted hostname on an
  https-only connection — a rebound private IP cannot present a valid
  certificate for `*.tiktokapis.com`.
- The anchored host allowlist above (§ Egress control).
- `redirect: "error"` on all egress.
- No bearer token on upload PUTs — a redirected upload cannot leak the
  account credential, only the single-session `upload_token` and the media
  bytes.

**Residual risk, stated honestly:** an attacker who controls DNS resolution
for an allowlisted `tiktokapis.com` name can route the connection to a server
they control; TLS validation then blocks them unless they also hold a valid
certificate for that name (CA compromise). This combined attacker is accepted
for v1.

**Obligations that survive the deferral:** `core/http` exposes an
**injectable `lookup` seam** from day one (`TtRequestOptions.lookup`), so a
future flip to resolve-and-pin is a contained change; probe **P-15** is the
v1.x engineering spike evaluating an undici-dispatcher implementation.

### Local file confinement (`TT_MEDIA_ROOT`)

- `file_path` uploads are confined to `TT_MEDIA_ROOT`. Unset ⇒ **fail
  closed**: local-file uploads are rejected with an error naming the
  variable (never a silent CWD default — CWD under an agent is
  attacker-influenced).
- Both sides are canonicalized with `realpath` before a containment check on
  the resolved paths; traversal, symlinks escaping the root, directories,
  and device files are rejected; relative paths resolve against
  `TT_MEDIA_ROOT`, not CWD (CC-D8).
- TOCTOU re-validation at execute time: the path is re-resolved and the
  file's `(size, mtime, dev, ino)` captured at plan time must match —
  otherwise the bytes changed since the human saw the preview ⇒ reject,
  re-plan (CC-D3).
- The plan preview always shows the **resolved absolute path and byte size**
  — the human sees exactly which file would leave the machine.
- `TT_MEDIA_ROOT` should be a dedicated media directory, never `$HOME` or a
  config directory; confinement bounds *which* files can leave, not whether
  a previewed file is sensitive.

### Write safety (`TT_WRITE_MODE`)

Publish tools are plan-and-execute, gated by a single-use `plan_id`
(rationale: SYNTHESIS § 2.8). There is no `apply` boolean: a call without
`plan_id` is a preview; a call with a valid `plan_id` executes.

- **`plan` (default).** A write executes only with a `plan_id` minted by a
  prior preview of the same tool. The preview runs all read steps for real
  and shows the human the creator identity and the exact resolved payload;
  no init call is made.
- **`apply`.** `plan_id` becomes optional — writes may execute directly.
  Documented verbatim: **"trusted automation only: this mode has no
  injection resistance"**. For pipelines, not chat.
- **`deny`.** The `publish-write` package is unregistered — its tools do not
  exist in the session. (`TT_PACKAGES_READONLY=1` likewise registers only
  read-only tools.)

**The injection-resistance model of `plan` mode.** The defense is the
**human-visible preview plus a single-use `plan_id` bound to a canonical
payload digest**: the plan token is `plan_` + 32 lowercase hex chars of
`crypto.randomBytes` (random, never payload-derived — a derivable token could
be fabricated), stored in-process only with a 10-minute TTL, and bound to
SHA-256 over the **fully resolved upstream payload** (via the single
`canonicalJson`) plus the resolved account. At execute time the payload is
re-resolved through the same code path, the digest recomputed and compared
(`timingSafeEqual`), and the plan consumed atomically **before** the init is
dispatched — a retry with the same `plan_id` fails with `plan_not_found`
instead of double-posting (CC-E7). **`force` overrides only the duplicate
guard, never digest verification** — there is no way to execute a payload
other than the one previewed.

- **Publish journal** (append-only write-ahead journal, `journal.ndjson`):
  an intent record is fsync'd before every init, an outcome record appended
  after — an audit trail of every attempted write (when, profile, tool,
  plan_id, payload digest, publish_id, outcome) that survives crashes as
  intent-without-outcome. It stores a title *excerpt* only, never tokens.
- **Duplicate guard:** a same-digest publish with an ok/unknown outcome
  within 10 minutes is refused as `possible_duplicate` unless `force: true`.
- Posting rate is capped client-side (`TT_PUBLISH_RPM`, default 6/min per
  profile, matching TikTok): an empty bucket rejects locally with an
  absolute `retry_at` — zero network spent. The local bucket is a courtesy,
  not the enforcement point (CC-B8).
- Optional `TT_LOCK_PROFILE` pins the session to one profile (the `account`
  selector is removed from tool schemas); in the default multi-profile mode
  the account is bound into the plan digest, so plan and execute cannot
  straddle accounts.

### Prompt-injection surface

- Read tools return third-party content (video titles/descriptions). Results
  are data, never instructions; descriptions remind the model that video
  metadata is untrusted user content. No tool output is ever fed into
  another tool automatically by the server. Hints use a closed vocabulary
  and never interpolate upstream text.
- **What `plan_id` does and does not guarantee (honest claim).** It makes a
  no-preview write unexecutable and defeats *single-message* injection — an
  injected instruction cannot know an unissued `plan_id`. It does **not**
  prove a human sat between the two calls: a model can chain preview →
  execute in one autonomous turn.
- **Elicitation is demoted to optional post-v1** (rationale: SYNTHESIS
  § 2.9). Residual risk, stated honestly: without elicitation, plan-mode
  confirmation happens in the client conversation, so a sufficiently
  deceived model could still execute a previewed plan; the digest binding
  limits this to **exactly the previewed payload** — nothing else can be
  posted under that plan_id. If elicitation ships later, it becomes the hard
  human checkpoint where the client supports it; `plan_id` remains the
  floor.

### Transport

- stdio by default (no listening socket at all).
- HTTP mode binds loopback by default and validates `Origin`/`Host` **even
  on loopback** (DNS-rebinding / hostile-page defense). `TT_HTTP_TOKEN` is
  **required whenever `TT_TRANSPORT=http` — including a loopback bind** (SYN-31);
  the server refuses to start without it. A non-loopback bind additionally
  requires TLS termination or an explicit `TT_HTTP_INSECURE=1` acknowledgement
  (CC-G6). The same Origin/Host and
  `state` discipline applies to the one-shot OAuth callback listener.
- Bearer comparison is constant-time over fixed-length SHA-256 digests of
  provided vs expected token (no `RangeError`, no length oracle); sessions
  use `randomUUID`.
- **Stdout purity** (CC-G3): nothing but JSON-RPC protocol frames on stdout,
  ever — logs go to stderr only; enforced by a `console.log` lint ban and a
  boot test asserting stdout emptiness around a tool call.

### Least-privilege scopes

Login scopes are derived from the enabled tool packages: a read-only
deployment never holds a refresh token carrying posting authority; enabling
publishing requires an explicit re-login opting into `video.publish` /
`video.upload` (the publish package maps to `video.publish`, which
`creator_info` also requires).

### Supply chain / code

- Minimal runtime dependency set, lockfile committed, `npm audit` in the
  `check` script and CI.
- `prepublishOnly` runs the full gate; publish allowlist ships only `build/`
  + `bin/` (no maps, no source, no env files); no install scripts.
- npm trusted publishing (OIDC) + provenance; CodeQL + dependabot in CI from
  the first release; workflows SHA-pinned.

## Platform-compliance posture (TikTok ToS)

- Only official APIs; no scraping, no reverse-engineered endpoints, no
  watermark removal, nothing that violates TikTok's developer terms.
- The unaudited-client rules (SELF_ONLY, 5-user cap) are **honored, not
  circumvented**: the server offers exactly the privacy levels creator_info
  returns and explains the audit gate in errors instead of suggesting
  workarounds.
- Commercial-content disclosure toggles and the AIGC label are first-class
  inputs; `is_aigc` defaults **on** because MCP-driven content is typically
  AI-assisted (operator-overridable via `TT_DEFAULT_AIGC_LABEL`).
- CDN URLs are documented as ephemeral; the server stores no user content.
- Data minimization: default field sets are minimal; the server keeps no
  database — the env file and the publish journal are the only state.

## Reporting

`SECURITY.md` at repo root (once published) will carry a private-disclosure
contact and a 90-day coordinated-disclosure policy, mirroring servicenow-mcp.
