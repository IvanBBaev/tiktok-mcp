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
  redacted unless allowlisted, rather than known-bad keys being scrubbed. The
  cost is that a diagnostic field nobody allowlisted is lost from the log: the
  chunk upload's chunk count is logged as `total_chunks` (it was
  `upload_chunks`, which the allowlist always scrubbed) and the retry delay
  `backoff_ms` is allowlisted, so both now reach stderr.
- **Exact-value secret registration**: tokens, `client_secret`, and
  `upload_token` are registered as exact values (`registerSecret`) and
  scrubbed out of free text (`redactText`) — this catches secrets embedded in
  query strings and form bodies that key-based rules miss. Registration
  happens where each value first enters the process: the `client_secret` when
  a profile's credentials are read (`readProfile`, the one path every caller
  takes to the app keys) and again at the start of the code exchange
  (`exchangeCode`, which receives it as an argument); the access and refresh
  tokens when a credential record is adopted, when a token response arrives,
  whenever one is sent as a bearer, and — for `login --revoke` — each access
  token before its revoke request is sent (including one a concurrent refresh
  rotated in); the PKCE verifier, the CSRF
  `state` and the authorization code when they are created or received; the
  `upload_token` when an init returns its `upload_url` (read from the query
  string, or — when the `upload_url` is not a parseable URL, which `core/http`
  later refuses and quotes — matched from its `upload_token=` text by hand)
  and again before each chunk PUT.
- **One sink redacts *after* serialization**: `cliIo` wraps stdout/stderr, so
  `doctor --json` is scrubbed as a whole document. `redactText` therefore
  matches each registered secret in its JSON-escaped rendering as well as its
  raw one — a secret containing a quote or a backslash would otherwise survive
  in escaped form, and a raw match landing mid-escape would leave a document a
  consumer cannot parse.
- The OAuth subsystem uses **allowlist logging**: `core/oauth` never
  serializes a raw token request or response body; it logs only
  `{grant_type, scope, truncated open_id, expires_in, http_status, log_id}`.
- Redaction is tested for idempotence, depth-completeness, and
  non-over-redaction; seeded-secret tests assert scrubbing on stderr and in
  the client mirror, not only in tool results.

### Egress control (SSRF posture)

- Data calls: hard-coded origin `https://open.tiktokapis.com`, no env
  override. OAuth authorize: `https://www.tiktok.com` (browser-side only);
  the token/refresh/revoke endpoints are pinned to `open.tiktokapis.com`.
  The one override that exists anywhere in the egress surface is the internal,
  unsupported `TT_OAUTH_BASE_URL`, which moves the OAuth origin **only** when it
  parses as a loopback origin (`127.0.0.0/8` or `[::1]`) — `originFor` in
  `core/oauth` discards anything else and falls back to the pin, so it can point
  the flow at a local test stub and at no other host.
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

**Pre-flight resolution check** (defense in depth, not a pin): when a
`lookup` is injected, the allowlisted hostname is resolved first and the
request is refused (`egress_blocked`) if **any** answer is non-routable. IPv6
answers are normalized to their eight groups before classification, so
non-canonical spellings (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`) are caught. Refused:

- IPv4: `0/8`, `10/8`, `127/8`, `169.254/16` (incl. IMDS), `172.16/12`,
  `192.168/16`, `192.0.0/24`, `192.0.2/24`, `198.51.100/24`, `203.0.113/24`,
  `100.64/10` (CGNAT), `198.18/15`, and everything from `224/4` up
  (multicast, reserved, broadcast), and the deprecated 6to4 relay anycast
  `192.88.99.0/24`.
- IPv6 classified by the IPv4 they embed: `::/96` (incl. `::` and `::1`),
  `::ffff:0:0/96` (IPv4-mapped), SIIT `::ffff:0:0:0/96` (IPv4-translated),
  NAT64 `64:ff9b::/96`, 6to4 `2002::/16`.
- IPv6 refused outright: **everything outside global unicast `2000::/3`** —
  one rule rather than an enumeration, so it covers the rest of the
  IETF-reserved `0000::/8`, NAT64 local-use `64:ff9b:1::/48`, discard
  `100::/64`, SRv6 SIDs `5f00::/16`, unique-local `fc00::/7`, link-local
  `fe80::/10`, site-local `fec0::/10`, multicast `ff00::/8` and the unassigned
  space in between. Inside `2000::/3`, also refused: IETF protocol assignments
  `2001::/23` (incl. Teredo `2001::/32`, benchmarking `2001:2::/48` and
  ORCHID) and documentation `2001:db8::/32` and `3fff::/20`; 6to4
  `2002::/16` is judged by the IPv4 it embeds (above).
- Any answer that is not an IP literal.

A TOCTOU gap remains between this resolution and the HTTP client's own, which
is why the deferral above still stands.

**Obligations that survive the deferral:** `core/http` exposes an
**injectable `lookup` seam** from day one (`TtRequestOptions.lookup`), so a
future flip to resolve-and-pin is a contained change. Probe **P-15**, the v1.x
engineering spike, has been run (2026-08-31, offline): it reproduced the gap —
a pre-flight that vets one address while the connection reaches another — and
showed that a `lookup`-shaped pin closes it without weakening TLS identity (the
certificate is still validated against the hostname, and a trusted certificate
for the wrong name is still rejected) and at no measurable per-request cost,
since the pre-flight already pays the resolution. What keeps it out of v1 is
reach, not cost: `fetch` accepts a pin only through an undici dispatcher that
stock Node exposes nowhere but an undocumented global symbol, created lazily
and resolving to a different class under proxy environment variables. The
deferral above therefore rests on measurement rather than assumption; the run
is recorded in `docs/probes/PROBE-LOG.md` § P-15.

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
- **Upload pinning:** the transfer opens the file **once** and every chunk
  and retry reads from that descriptor (positional reads in 1 MiB slices,
  never a read stream that could close the shared handle), so a rename or
  replace of the path
  mid-upload cannot splice another file's bytes into the post. The
  descriptor's size must equal the plan total and its `(size, mtime, dev,
  ino)` must equal what the re-validation confirmed, else `plan_mismatch`
  before any byte is sent. Before each chunk the descriptor is re-stat'ed; a
  size or mtime change (in-place rewrite) fails the upload with
  `upload_interrupted` ("the media file was modified during the upload"); a
  file truncated mid-chunk fails that chunk's body; the re-stat after the failure
  reports the same, without spending the retries. **Known limit:** the check compares size and mtime, so a
  same-size rewrite within one mtime tick on a coarse filesystem (FAT/exFAT
  2 s, HFS+ 1 s) is not detected. `ctime` is not used because rename and
  unlink change it too, and a rename during an upload is deliberately
  supported.
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
  An in-process in-flight guard also refuses an unforced apply of a payload
  (same profile and digest) that another call in this process is dispatching
  right now (`details.in_flight: true`), so two applies of different plans
  for one payload cannot both pass the journal check before either has
  journaled its intent.
- Posting rate is capped client-side (`TT_PUBLISH_RPM`, default 6/min per
  profile, matching TikTok): an empty bucket rejects locally with an
  absolute `retry_at` — zero network spent. The local bucket is a courtesy,
  not the enforcement point (CC-B8).
- Optional `TT_LOCK_PROFILE` pins the session to one profile. The `account`
  argument stays in every tool schema, but any name other than the locked one
  answers `unknown_account` locally, and the publish journal
  (`tiktok_list_publish_journal`, `tiktok://publish/journal`, the `publish_id`
  completion) is filtered to the locked profile — another `account` filter
  narrows it to nothing, never to a different profile's rows. In the default
  multi-profile mode
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
  (CC-G6). The optional `TT_HTTP_ALLOWED_HOSTS` allowlist (bare host names)
  additionally pins `Host`, and a browser's `Origin` hostname, to the names
  clients use to reach the server — on any bind, loopback included. Allowlist
  entries and the `Host`/`Origin` hostnames are compared in one canonical form,
  the one the WHATWG URL parser gives (lowercased, IPv6 compressed, numeric IPv4
  shorthands such as `127.1` expanded to `127.0.0.1`), so no spelling of a
  listed name slips past or is refused by accident; an IPv6 zone id
  (`fe80::1%eth0`) is rejected in the allowlist, since no URL can carry one. The
  same
  Origin/Host and `state` discipline applies to the one-shot OAuth callback
  listener. A `Host` whose port is not a decimal 1–65535 cannot be parsed into
  an authority, so the gate refuses it `403` like any other bad `Host`, not
  with a bare SDK `400`. A port with leading zeros is the same port — `:080`
  is re-spelled `:80` before it is compared with the bound port — so a valid
  spelling is not refused by accident.
- Bearer comparison is constant-time over fixed-length SHA-256 digests of
  provided vs expected token (no `RangeError`, no length oracle); sessions
  use `randomUUID`.
- **Resource bounds** (fixed constants, not settings): request bodies are
  capped at 4 MiB (`413 Payload Too Large`, `connection: close`; a declared
  `content-length` over the cap is refused before a byte is read), an
  unparsable body is `400` / `-32700`, at most 128 sessions are live (one more
  `initialize` is `503` `too many open sessions`; a session still opening
  holds its slot, so concurrent `initialize` requests cannot overshoot), and a session idle for
  30 minutes — no request in flight, no open stream, no JSON-RPC call still
  unanswered — is closed when the next session opens (a client that
  disconnected mid tool call keeps its session until the handler answers). An authenticated client can therefore not exhaust memory with
  one body or with abandoned sessions.
- **Shutdown drains.** Once `close()` starts, a new request gets `503`
  `Service Unavailable: the server is shutting down`; in-flight `POST` /
  `DELETE` requests, and every JSON-RPC request whose handler has not answered
  yet, get up to 10 s to finish (a request accepted before the shutdown may
  complete during the drain). The second half matters: a client that
  disconnected mid tool call leaves no open response, yet its handler — a
  publish, say — is still running, and shutdown no longer aborts it. A request
  the client cancels (`notifications/cancelled`), or one whose transport closes,
  stops being waited for; a `notifications/cancelled` for an existing session
  is still delivered during the drain (every other new request gets `503`), so
  a cancel can end the drain early. A `POST` whose body finishes arriving after
  the drain began gets the same `503` `shutting down`, not a `404`
  `Session not found`. `GET` SSE streams are not waited for, since they have
  no end. Past the budget a warning is logged and
  whatever is still in flight is aborted; then the sessions and the listener
  are closed. A publish mid-upload therefore normally lands its journal
  outcome instead of being left `unknown`.
- **Off-loopback DNS rebinding.** Without an allowlist, the `Origin` check off
  loopback can only require the `Origin` hostname to equal `Host` (the port
  belongs to the TLS terminator), and after DNS rebinding a hostile page's
  `Origin` and `Host` agree — so the Host/Origin rule does **not** stop
  rebinding, and the bearer token is the remaining layer (a browser page does
  not hold it). Setting `TT_HTTP_ALLOWED_HOSTS` closes it: a rebound name is
  not on the list, so its `Host` is refused. It is recommended whenever
  `TT_HTTP_INSECURE=1`; the server warns at startup, and `doctor`'s
  `transport` row warns, when insecure mode runs without it. On loopback the
  full authority is pinned and the rule holds either way — which is why both
  `TT_HTTP_INSECURE=1` warnings (off-box without TLS, allowlist unset) fire only
  on a non-loopback bind: on loopback the flag is redundant and neither warning
  would be true.
- **Known limits.** A request still in flight when the 10 s drain budget runs
  out is aborted, so a very slow upload can still end with an `unknown`
  journal outcome.
- **No local paths through the MCP surface.** An env file that cannot be read
  or parsed lists as no profiles (every scoped tool `[UNAVAILABLE: …]`), and a
  failing completion answers an empty list; neither returns a JSON-RPC error
  carrying the absolute path. The path goes to stderr only.
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

Every claim below is a statement about a file in this repository, and each one
names the file so it can be checked rather than believed.

- **Minimal runtime dependency set** (two direct runtime dependencies), root
  `package-lock.json` committed. `npm audit --omit=dev --audit-level=high` runs
  in CI (`.github/workflows/ci.yml`, the ubuntu/Node 22 leg) and fails the
  build on a high or critical advisory in a *runtime* dependency. It is
  deliberately **not** part of `npm run check`: the local gate must not turn
  red because a registry-side advisory was published overnight, on a machine
  that may be offline.
- **Every third-party GitHub Action is pinned to a full 40-character commit
  SHA**, with the human-readable version in a trailing comment — across all of
  `ci.yml`, `codeql.yml`, `pages.yml`, `publish.yml`, `publish-mcp.yml` and
  `publish-vscode.yml`. A tag is a movable pointer and an action runs with
  access to the workflow's token and secrets; a commit SHA is the only
  reference an upstream account compromise cannot repoint. There are no
  floating `@v4`-style references left.
- **Dependabot keeps those pins from rotting** (`.github/dependabot.yml`): the
  `github-actions` ecosystem at `/`, plus npm at `/` and at `/extension`, all
  weekly and grouped. Dependabot rewrites both the SHA and the version comment,
  so pinning and automation compose rather than fight. `typescript` majors are
  explicitly ignored there — a compiler major is a migration taken
  deliberately, not a bot PR.
- **CodeQL** (`.github/workflows/codeql.yml`) runs the
  `javascript-typescript` extractor with the `security-and-quality` query suite
  on every push to `main`, every pull request, and weekly on a cron, so an
  advisory in code nobody has touched still surfaces. `build-mode: none` —
  source-only analysis, no `autobuild`, no competition with `tsc`.
- Publishing happens **only from CI on a version tag**, never from a laptop:
  `.github/workflows/publish.yml` runs `npm run release:guard` and the full
  `npm run check` before `npm publish`. The VS Code Marketplace
  (`publish-vscode.yml`) and MCP Registry (`publish-mcp.yml`) publishes follow
  the npm publish via `workflow_run` rather than racing it on the same tag, so
  a tag whose npm publish fails ships nowhere. A prerelease version
  (`vX.Y.Z-rc.N`, anything with a `-`) ships to npm under the `next` dist-tag
  only: the Marketplace rejects semver prereleases, so `publish-vscode.yml`
  skips its publish step for one rather than failing after npm already has
  the version. The publish allowlist ships only
  `build/src` + `bin/` (no maps, no tests, no source, no env files); no install
  scripts.
- npm **trusted publishing** (OIDC): the workflow holds no npm token at all —
  `id-token: write` plus a registry-side trusted publisher is the whole
  credential, and `--provenance` is attested from that same identity. The MCP
  Registry publish (`publish-mcp.yml`) is likewise GitHub OIDC with no stored
  secret.
- **Workflow tokens stay out of reach of install scripts.** `npm ci` runs
  every devDependency's lifecycle scripts, so `ci.yml` declares a top-level
  `permissions: contents: read` (nothing in it writes to the repository), and
  `publish.yml` checks out with `persist-credentials: false`, so its write
  token never sits in `.git/config` while those scripts run (`gh release`
  reads `GH_TOKEN` instead). The npm that runs next to the OIDC-capable
  publish job is pinned (`npm install -g npm@12.1.0`; trusted publishing needs
  ≥ 11.5.1, Node 22 ships 10.x) rather than a floating `npm@latest`.
- **The `workflow_run` followers check what they follow.** A `workflow_run`
  trigger matches the upstream workflow by *name*, and both followers hold a
  credential (`VSCE_PAT`; the repository's OIDC identity for the MCP Registry).
  So neither trusts a bare `conclusion == 'success'`: each also requires the
  run's `path` to be `.github/workflows/publish.yml`, its `event` to be `push`
  (which excludes pull-request runs, including Dependabot's, that report this
  repository as their head) and its `head_repository` to be this repository,
  and checks out the run's `head_sha` — the tagged commit, not `main`'s HEAD.
  Defense in depth, not a response to a known exploit. `workflow_dispatch`
  remains the manual override, but it is not a bypass: a dispatch must run on
  a `v*` tag ref and runs `npm run release:guard` (tag, every version field
  and the changelog agreeing) before it publishes, since no *Publish* run
  checked them for it.
- **`mcp-publisher` is pinned and verified.** `publish-mcp.yml` downloads a
  fixed release of the MCP Registry's `mcp-publisher` (not `releases/latest`)
  and checks its sha256 against the value taken from that release's published
  checksums file before running it — the job holds an OIDC token that can
  register under the repository's identity, and every action in the
  workflows is already pinned to a commit SHA.
- **The one long-lived secret is `VSCE_PAT`** (`publish-vscode.yml`), the Azure
  DevOps token for the Visual Studio Marketplace, which offers no OIDC
  equivalent. It is scoped to *Marketplace → Manage*, lives only as a repository
  secret, and is used in exactly one step, which the job reaches only after a
  successful npm publish of the same tag (or on a manual dispatch). Naming it
  here rather than claiming "no long-lived tokens" is the point: the npm path
  has none, the Marketplace path has one, and that is the residual.

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

## Compatibility and deprecation policy

The published surface is everything a caller can observe: the **tool set**,
their **input schemas**, the **`ToolResult` envelope** and the fields tools
return inside it, the **error-code catalog** (`docs/TOOLS.md` § 3.0), the
**closed `hints` vocabularies** — the hint types and the `user_action` list,
both enumerable at runtime from `src/mcp/result.ts` — the **`TT_*` environment
variables** and the **CLI**. Not the module layout, not the shape of an internal
type. Everything on that surface follows SemVer, and every change to it lands
in [CHANGELOG.md](../CHANGELOG.md) under `Added`, `Changed`, `Deprecated`,
`Removed`, `Fixed` or `Security` (G-10).

The catalog and the vocabularies are on that list for the same reason the tool
names are: a model *branches* on `error.code` and on `hint.type`. Renaming
`rate_limited`, or dropping a member of the `user_action` list, breaks a caller
exactly as removing a tool does — and breaks it more quietly, because the call
still returns and only the branch stops matching. A closed vocabulary is a
promise about what can come back; changing it silently spends that promise.

**Breaking** — major only:

- removing a tool, or removing or renaming a tool input;
- narrowing what an input accepts;
- removing or renaming a field a tool returns, or a field of the `ToolResult`
  envelope;
- removing or renaming an error code, or broadening what an existing code
  covers so a caller's branch now catches a failure it did not before;
- removing a member of a closed `hints` vocabulary;
- removing a `TT_*` variable;
- changing a default in a way that changes *what gets posted* (for example the
  AIGC label default).

**Minor** — adding a tool, an optional input, a returned field, an error code
or a hint type, and widening what an input accepts. Growth is safe in the
direction that matters: a caller that has never heard of a new member treats it
the way it already treats an unrecognized one, whereas a caller that loses a
member it was matching on gets silence.

**Worked example — the one removal that was not breaking.** `wait_for_audit`
was dropped from the `user_action` vocabulary on 2026-08-31, which has exactly
the shape the list above calls breaking, and it was correctly not treated as
one. Nothing observable changed: the name existed only as a member of the type,
no code path ever emitted it, so no result ever carried it and no caller can
have branched on it — the vocabulary shrank, the wire did not. The breaking
case is removing a member callers actually received, and that is the case this
policy is about; a member no result ever contained is a comment, and deleting a
comment is not a contract change. (The release was pre-1.0 besides, where the
clause below applies anyway.) It is written down because a policy that
retroactively condemns a change the project made deliberately, without saying
why that change was fine, is a policy the next maintainer routes around.

**Grace period.** Nothing on that surface is removed without first being
deprecated in a release, and a deprecated thing keeps working for **at least
one minor release and 90 days** before the major that removes it. During the
grace period:

- the tool's description and `docs/TOOLS.md` entry say `Deprecated:` and name
  the replacement — the model reads the description, so that is the channel
  that actually reaches the caller;
- a deprecated tool's result carries the same notice as a `hint`, because a
  client that never re-reads `tools/list` still sees the result;
- a deprecated environment variable keeps being **honored**, and says so once
  at startup on stderr (never stdout, see *Transport*) and again in
  `tiktok-mcp-ai doctor` — no variable is deprecated yet and that trigger does
  not exist, so see *What the first variable deprecation has to build* below
  for what it costs;
- the replacement ships in the *same* release as the deprecation, so there is
  never a window where the old way is discouraged and the new way is absent.

**What the first variable deprecation has to build.** No `TT_*` variable is
deprecated today, so the clause above is unexercised rather than unmet — and
it is spelled out here so it stays that way. The release that first deprecates
or renames a variable owes this work in the same commit. Both channels the
clause promises already exist; only the trigger is missing:

- **The carrier is live.** Anything pushed into `EnvFileSnapshot.warnings` is
  already printed once at startup on stderr by the bootstrap in `src/index.ts`
  and listed by `doctor`'s `env-file` check (`src/cli/doctor.ts`). Nothing new
  is needed to reach either audience.
- **The registry is missing.** There is no map of old name → new name. It has
  to be consulted where a key is classified — `isKnownKey` in
  `src/core/config.ts` — and it has to make the deprecated name *read and
  honored*, not merely noticed. Today an unrecognized `TT_*` key is reported as
  **"ignored"**, which is the opposite of what this policy promises, so a rename
  that stopped there would be a silent breakage wearing a warning.
- **The `process.env` path needs it too.** `parseSnapshot` scans only the env
  file. A `TT_*` passed in an MCP client's `env` block never reaches it, and
  `loadSettings` reads the names it knows and ignores the rest without a
  word — so an operator who configures through their client, which is the
  common case, would see nothing. The registry has to be consulted on both
  paths, or the promise holds only for installations that use an env file.

None of this is built, and it should not be built before there is a variable to
put in it. Standing machinery for a hypothetical deprecation is how a repository
ends up documenting a feature nobody wrote.

**Exception — security.** A control that has to change to close a
vulnerability changes immediately, in a patch if need be, and the changelog
entry says so under `Security`. Safety is not deprecated on a timer.

**Before 1.0.0** the surface is explicitly unstable: SemVer allows a `0.x`
minor to break, and while the tool set is still settling it will. The
deprecation ritual above still applies to *removals* — a `0.x` release also
announces what it is taking away — but the 90-day floor starts at `1.0.0`.

**Upstream churn is not our deprecation.** When TikTok removes a field or a
scope, the tool it belongs to is affected the day TikTok says so; the server
surfaces that as a structured error naming the platform, and the changelog
records it under `Changed` with the date. Pretending we can hold a grace period
over an API we do not control would be a lie in the policy.

## Reporting

The disclosure policy — supported versions, the private reporting channel, the
response commitment, and what is in and out of scope — is
[`SECURITY.md` at the repository root](../SECURITY.md), which is also the file
GitHub surfaces in its *Report a vulnerability* UI. This document stays the
design-security reference; that one stays the process. Neither repeats the
other.
