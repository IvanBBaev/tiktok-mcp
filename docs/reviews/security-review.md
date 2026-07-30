# Design Review — Senior Security Engineer

## 1. Reviewer & scope

- **Role:** Senior Security Engineer — application security, OAuth/OIDC, threat modeling.
- **Review type:** Defensive design review of an open-source, pre-code specification. No implementation exists; the review targets the *design* as written.
- **Date:** 2026-07-21.
- **Subject:** `tiktok-mcp` (planned npm package `tiktok-mcp-ai`) — an MCP server over TikTok's Display and Content Posting APIs.
- **Documents reviewed (all of `docs/` + root):**
  - `README.md`
  - `docs/ARCHITECTURE.md`
  - `docs/TIKTOK-API.md`
  - `docs/TOOLS.md`
  - `docs/AUTH.md`
  - `docs/CONFIGURATION.md`
  - `docs/SECURITY.md`
  - `docs/TESTING.md`
  - `docs/ROADMAP.md`
- **Baseline for comparison:** the sibling `servicenow-mcp` architecture map (`facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md`), from which this design is a deliberate port.

Scope covered: OAuth 2.0 + PKCE correctness, token storage, secret redaction, egress/SSRF, prompt-injection surface and the write gate, HTTP transport, multi-account isolation, supply chain, threat-model completeness, and TikTok ToS/compliance posture.

---

## 2. Executive summary

This is a strong, security-conscious design that starts from a proven baseline and applies the right primitives: a compile-time egress allowlist, PKCE on a loopback redirect, `0600` atomic env-file writes with an atomically swapped in-memory snapshot, a plan-and-apply write gate, stdio-by-default transport, and a small dependency surface. The threat model in `SECURITY.md` is explicitly scoped and names the important adversaries (confused model, prompt injection, local processes, network attackers). For a design-phase document, the security altitude is well above average, and most of the hard architectural decisions are already correct.

The findings below are therefore about depth and enforcement, not about missing foundations. Three themes recur. First, several controls are described as *guarantees* when they are really *affordances*: plan-and-apply only protects a user who is actually in the loop between the plan and the apply call, and redaction is a denylist that must not be the last line of defense on the OAuth path. Second, the layering that is a strength (`core ← api ← mcp ← tools`) creates a redaction gap: the secret-handling code (`core/http`, `core/oauth`) sits *below* `mcp/redact.ts` and logs to stderr directly, so it cannot depend on the mcp-layer scrubber. Third, the model controls two powerful, under-constrained inputs — an arbitrary local `file_path` for uploads and the `account` profile selector — and the design does not bound either. The fixed-port loopback redirect, the `upload_url` validation, and the HTTP-transport loopback exposure each need tightening that the docs currently defer to "implementation time." The TikTok ToS/compliance posture is genuinely good and needs no rework.

**Overall verdict: Approve with changes.** No blocking Critical issues for a local single-user tool, but there are four High findings that should be resolved in the design before code is written, because each one changes a module's contract (redaction location, `file_path` policy, apply-token binding, HTTP origin checks) rather than being a late implementation detail.

---

## 3. Strengths

- **Compile-time egress allowlist.** Data calls are pinned to `https://open.tiktokapis.com` with *no* env override (`ARCHITECTURE.md §6.1`, `SECURITY.md § Egress control`). Removing the override is the single most effective SSRF control and is done correctly.
- **Server never brokers tokens.** OAuth happens only in the `login` CLI; no MCP tool receives or returns token material (`AUTH.md §1`, `§4`). This keeps secrets off the model channel by construction, not by filtering.
- **Atomic, `0600`, comment-preserving env writes + atomically swapped in-memory snapshot** make a torn read (new access token paired with old refresh token) structurally impossible (`ARCHITECTURE.md §7`). Refresh-token **rotation** is persisted (`AUTH.md §2`) — a common bug avoided.
- **Refresh is single-flight per profile** with a mutex, and 401 triggers exactly one forced refresh + one replay, idempotent-only, with publish init explicitly excluded unless no `publish_id` was returned (`ARCHITECTURE.md §6.2`/`§6.4`). This is a careful, correct treatment of non-idempotent writes.
- **Plan-and-apply write gate** plus a local publish journal and `TT_WRITE_MODE=deny` / `TT_PACKAGES_READONLY=1` hard read-only modes (`ARCHITECTURE.md §8`).
- **stdio by default (no listening socket)**; HTTP mode refuses non-loopback binds without a bearer, compared with `timingSafeEqual` (`ARCHITECTURE.md §3`).
- **Client-side publish token bucket** (6/min) so a runaway loop hits a local limiter before TikTok's spam systems (`ARCHITECTURE.md §6.5`).
- **Small, auditable supply chain:** three runtime deps, committed lockfile, `npm audit` in the gate, CodeQL + dependabot planned, publish allowlist ships only `build/` + `bin/` (`SECURITY.md § Supply chain`).
- **Honest ToS posture:** honors the unaudited-client SELF_ONLY / 5-user gate instead of circumventing it, surfaces commercial-content disclosure and defaults `is_aigc` on (`SECURITY.md § Platform-compliance`, `TIKTOK-API.md §7–8`).
- **`.strict()` schemas with per-field `.describe()`** reject typo'd/unknown arguments as validation errors rather than silently dropping them (`ARCHITECTURE.md §5`).

---

## 4. Findings

Severity reflects impact on a **local, single-user** deployment (the stated model), not a hosted multi-tenant one.

### F1 — Redaction lives in the wrong layer for the code that handles secrets *(High)*

- **Issue.** `ARCHITECTURE.md §10` attributes scrubbing to `mcp/redact.ts`, but the modules that actually touch raw secrets — `core/oauth.ts` (token exchange/refresh) and `core/http.ts` (Authorization headers, error bodies) — are in **Layer 0** and log to stderr directly. The layering rule (`§1`: "`core` imports nothing from the other layers") forbids `core` from importing `mcp/redact.ts`. So the mcp-layer scrubber cannot cover the very code most likely to emit a token. `§1` does list "redaction primitives" under `core/`, but `§10` names only `mcp/redact.ts` — the design is ambiguous about which scrubber runs on core-level stderr logs and on client-mirrored logs.
- **Failure mode.** A refresh error, an `unhandledRejection` in the OAuth path, or an upstream 4xx whose body echoes the request could write an access/refresh token or `client_secret` to stderr (and, via the `logging` capability, to the MCP client) with no scrubber in the path. Denylist redaction at the mcp boundary would never see it, because the log was emitted below that boundary.
- **Recommendation.** Make the redaction primitive a **`core/`** utility that every logger (including `core/http` and `core/oauth`) calls *before* serialization; `mcp/redact.ts` becomes a thin re-export/wrapper for the model-facing path. State in `§10` that *all* stderr and client-mirrored logs pass through core redaction. Add a test that seeds a token into a `core/oauth` error and asserts it comes out scrubbed on stderr, not only in a tool result.
- **Reference.** `ARCHITECTURE.md §1`, `§10`; `SECURITY.md § Secrets`.

### F2 — OAuth token exchange/refresh must use allowlist logging, not denylist redaction *(High)*

- **Issue.** Redaction is described as scrubbing "known secret keys and bearer-shaped strings" (`SECURITY.md § Secrets`). The OAuth token endpoint request is **form-encoded** and carries `client_secret`, `code`, `code_verifier`, and `refresh_token`; the response JSON carries `access_token` and a possibly-rotated `refresh_token`. A refresh token is *not* "Bearer-shaped," and a form-encoded body may never be parsed into the keys the redactor recognizes. A denylist that misses one field leaks it.
- **Failure mode.** Any log line, error `detail`, or debug dump on the token path that serializes the raw request/response body before key-based redaction leaks a long-lived (365-day) refresh token or the app `client_secret`.
- **Recommendation.** For the OAuth subsystem specifically, **never serialize raw request/response bodies**. Log an explicit allowlist of non-secret fields (`grant_type`, `open_id` truncated, `scope`, `expires_in`, HTTP status, `log_id`) and nothing else. Add `code` (the authorization code) and the full callback URL to the global scrub set — `AUTH.md` lists `code_verifier` as redacted but not `code`.
- **Reference.** `ARCHITECTURE.md §10`; `TIKTOK-API.md §2`; `SECURITY.md § Secrets`; `AUTH.md §1`.

### F3 — `file_path` is an unrestricted, model-chosen local-file read → exfiltration channel *(High)*

- **Issue.** `tiktok_post_video` / `tiktok_upload_video_draft` accept `file_path` = "Absolute path to the video file" (`TOOLS.md`). Nothing restricts the path to a media directory. The model chooses it, and on apply the server reads those bytes and PUTs them to TikTok's `upload_url`.
- **Attack scenario.** A prompt-injected model (payload arriving via a video title/description read by a Display tool, per `SECURITY.md § Prompt-injection`) calls `tiktok_post_video` with `file_path` set to `~/.config/tiktok-mcp-ai/.env`, `~/.ssh/id_rsa`, or another sensitive local file, `apply: true`. In `TT_WRITE_MODE=apply`, or if a human rubber-stamps the preview, the file's bytes are uploaded off-box to TikTok as a "video." Container sniffing (`TOOLS.md § Cross-cutting: media files are stat'ed and sniffed`) is the only barrier, and lenient sniffing can be fooled (e.g., a crafted file with a valid MP4 box header prefixing arbitrary tail bytes).
- **Recommendation.** Constrain `file_path` to an operator-configured media root (`TT_MEDIA_ROOT`, default the current working directory or an explicit opt-in), reject symlinks that escape it, canonicalize before the check, and make the container validation strict (full moov/box parse, not a magic-byte prefix). Always render the *resolved absolute path* and byte size in the plan preview so a reviewing human sees exactly what will leave the machine.
- **Reference.** `TOOLS.md § tiktok_post_video`, `§ Cross-cutting behavior`; `SECURITY.md § Prompt-injection surface`.

### F4 — Plan-and-apply is an affordance, not an enforced human checkpoint *(High)*

- **Issue.** `SECURITY.md § Prompt-injection surface` claims a write "requires explicit `apply: true`, which an injected instruction cannot supply without the model deliberately passing it — and the plan preview gives the human a checkpoint." Both halves overstate the guarantee. The model *can* be manipulated into passing `apply: true`, and in an autonomous agent loop the model can call the tool in plan mode and then immediately re-call it with `apply: true` with **no human observing anything in between**. Nothing binds the apply call to a plan the human actually saw.
- **Failure mode.** Injected content instructs the model: "first preview, then post with apply true." The model complies in two back-to-back tool calls; the human sees a finished post, not a checkpoint. `TT_WRITE_MODE=apply` removes even the two-step dance.
- **Recommendation.** (a) Reframe the docs: the *guarantee* is provided only by `TT_WRITE_MODE=plan` **plus a human reviewing the preview out-of-band**; the two-call sequence alone is not a control. (b) Strengthen it: have plan mode issue a short-lived, single-use **confirmation token** derived from a hash of the resolved payload; require `apply` to echo that exact token, and reject apply calls whose payload does not match the token's hash. This forces a fresh preview to exist for the exact bytes/parameters being posted and prevents a blind apply, without pretending to force a human. (c) Document `TT_WRITE_MODE=apply` as "trusted-automation only — no injection resistance."
- **Reference.** `ARCHITECTURE.md §8`; `SECURITY.md § Prompt-injection surface`, `§ Write safety`; `CONFIGURATION.md § Tool surface & write policy`.

### F5 — Loopback HTTP transport has no Origin/DNS-rebinding defense and no mandatory token *(High/Medium)*

- **Issue.** In `TT_TRANSPORT=http` the default bind is `127.0.0.1:3000` and a bearer token is required only for **non-loopback** binds (`ARCHITECTURE.md §3`, `CONFIGURATION.md § Transport`). A loopback HTTP listener with no token is reachable by **any web page open in the user's browser**: `fetch('http://127.0.0.1:3000', …)` from a malicious site, plus DNS-rebinding to bypass the browser's same-origin restriction, lets a remote page drive the local MCP server. The MCP Streamable-HTTP guidance itself calls out this exact class of attack.
- **Failure mode.** A user browsing a hostile page while the server runs in HTTP mode has their TikTok tools invoked by that page — reading profile/video data and, in apply mode, posting.
- **Recommendation.** Even on loopback, validate the `Origin`/`Host` header against an allowlist and reject browser origins; and/or require `TT_HTTP_TOKEN` whenever `TT_TRANSPORT=http`, loopback or not. For non-loopback, additionally require TLS (see F9). Keep stdio the default and document HTTP mode as advanced.
- **Reference.** `ARCHITECTURE.md §3`; `CONFIGURATION.md § Transport`; `SECURITY.md § Transport`.

### F6 — Default login requests write scopes even for read-only use (over-privilege) *(Medium)*

- **Issue.** `TT_LOGIN_SCOPES` defaults to all six scopes including `video.publish` and `video.upload` (`AUTH.md §1 step 2`, `CONFIGURATION.md § OAuth / login`). A user who only wants the reader surface (`TT_TOOL_PACKAGES=reader`) is nonetheless asked at consent to grant publish/upload rights to their account.
- **Failure mode.** The stored refresh token carries posting authority that the deployment never uses; if that token leaks (see storage findings), the blast radius includes posting to the account, not just reading it. Violates least privilege.
- **Recommendation.** Default the login scope set to the **read** scopes, and derive requested scopes from the configured tool packages (or require `--scopes`/`TT_LOGIN_SCOPES` to opt into write). Document that publishing requires an explicit re-login with the write scopes.
- **Reference.** `AUTH.md §1`, `§5`; `CONFIGURATION.md § OAuth / login`; `ARCHITECTURE.md §5`.

### F7 — Atomic-write and directory/journal permissions are under-specified *(Medium)*

- **Issue.** The design says the env file is written `0600` via temp-file + rename (`ARCHITECTURE.md §7`, `CONFIGURATION.md`), but does not specify: (a) the temp file is created `O_CREAT|O_EXCL` with mode `0600` *at creation* (not chmod'd afterward, which leaves a world-readable window), (b) the temp name is unpredictable and in the same directory, (c) the containing `~/.config/tiktok-mcp-ai/` directory is `0700`, or (d) the permissions of `journal.ndjson`.
- **Failure mode.** A predictable temp name enables a same-user symlink/pre-creation swap; a post-chmod window briefly exposes tokens; a `0755` directory lets other local users enumerate the journal (posting history) even if the env file itself is `0600`. On a shared host these are real local-disclosure paths.
- **Recommendation.** Specify: directory created `0700`; temp file `mkstemp`-style random name in the same dir, opened `O_EXCL` mode `0600`; `fsync` then `rename`; orphan-temp cleanup on failure; journal file `0600`. Add a test asserting each mode (TESTING already asserts `0600` on the env file — extend it).
- **Reference.** `ARCHITECTURE.md §7`, `§8`; `CONFIGURATION.md`; `AUTH.md §4`; `TESTING.md § core/config`.

### F8 — `upload_url` validation must check the resolved IP and port, not just a host suffix *(Medium)*

- **Issue.** `ARCHITECTURE.md §6.1` validates the TikTok-returned `upload_url` to be `https:` on a "TikTok-owned upload domain … (exact domain set fixed at implementation time)" and rejects loopback/private/link-local *targets*. Two gaps: a naive `endsWith("tiktokapis.com")` matches `eviltiktokapis.com`; and a host that *passes* a suffix check can still resolve (via DNS) to a private/link-local IP (rebinding), so a string check on the hostname is insufficient.
- **Failure mode.** The `upload_url` is the destination for raw local video bytes (F3 shows those bytes may be sensitive). If validation is bypassable, that is an *exfiltration* channel, not merely SSRF. The channel is TLS-authenticated from TikTok today, so this is defense-in-depth — but it is the last barrier if the token endpoint response is ever spoofed or a future code path relaxes the origin pin.
- **Recommendation.** Parse the URL, compare the host as a *registrable domain* (exact match or a true subdomain of an allowlisted apex, leading-dot boundary), require the default `443` (reject non-standard ports), resolve the host and assert every resolved IP is public, then connect to that pinned IP with the validated Host/SNI to avoid TOCTOU rebinding. Reject credentials-in-URL. Cover all of this in the host-guard tests.
- **Reference.** `ARCHITECTURE.md §6.1`; `SECURITY.md § Egress control`; `TESTING.md § core/http`.

### F9 — Non-loopback HTTP mode permits plaintext bearer + data over the network *(Medium)*

- **Issue.** A non-loopback bind is allowed once `TT_HTTP_TOKEN` is set (`ARCHITECTURE.md §3`), but nothing requires TLS. The bearer token and all MCP traffic (profile data, video metadata) would cross the network in cleartext.
- **Failure mode.** A network attacker on the path captures the bearer (constant-time comparison is irrelevant once it's sniffed) and replays it, and reads all tool results.
- **Recommendation.** Require TLS for any non-loopback bind (terminate in-process or mandate a documented reverse proxy and refuse to start on `0.0.0.0` without an explicit `TT_HTTP_INSECURE=1` acknowledgement). Document that HTTP mode is intended for a loopback dev bridge, not exposure.
- **Reference.** `ARCHITECTURE.md §3`; `CONFIGURATION.md § Transport`.

### F10 — `client_secret` in the MCP client config is a plaintext, process-visible exposure *(Medium)*

- **Issue.** The quickstart puts `TT_CLIENT_KEY`/`TT_CLIENT_SECRET` directly in the MCP client's JSON config (`README.md § Quickstart`). That file is plaintext on disk (e.g., `claude_desktop_config.json`), and env passed this way is inherited by the child process and, on some platforms, visible in process listings (`/proc/<pid>/environ`, `ps -E`) and to any subprocess the server spawns. `SECURITY.md` does not mention this exposure.
- **Failure mode.** Another same-user process reads the client secret from the config file or the process environment. The secret is per-operator (their own TikTok app), so blast radius is that app's abuse, but combined with a leaked user token it is enough to mint/refresh tokens.
- **Recommendation.** Recommend the **XDG env file** (`0600`) as the primary home for `TT_CLIENT_SECRET` and document env-in-config as the less-safe convenience option. Note the process-environment exposure explicitly in `SECURITY.md`. Confirm the server never re-exports these into a spawned child's environment.
- **Reference.** `README.md § Quickstart`; `CONFIGURATION.md § App & tokens`; `SECURITY.md § threat model`.

### F11 — The `account` profile selector is a model-controlled authorization input *(Medium)*

- **Issue.** Every tool auto-receives an `account` argument selecting a token profile (`ARCHITECTURE.md §5`, `AUTH.md §3`, `TOOLS.md § header`). Isolation between concurrent profiles is handled correctly via `AsyncLocalStorage`, but the *selection* is model-controlled, so any conversation can act as any configured profile.
- **Failure mode.** A prompt-injected or confused model posts to (or reads) the wrong account — e.g., publishes attacker-supplied content to the `brand` profile while the user believed the session was scoped to a throwaway account. Not an isolation break, but a cross-profile authorization surprise.
- **Recommendation.** Offer a lock: `TT_LOCK_PROFILE=1` (or "only `TT_ACTIVE_PROFILE` unless a per-tool override is explicitly enabled") that removes the auto-injected `account` argument so a session is pinned to one profile. Include the target profile in the plan preview so cross-profile posts are visible to a reviewer.
- **Reference.** `ARCHITECTURE.md §5`, `§7`; `AUTH.md §3`; `TOOLS.md § header`.

### F12 — Authorization `code` leaks via clipboard, terminal, and browser history in the login flows *(Medium/Low)*

- **Issue.** The loopback redirect places `code`/`state` in the browser URL bar (→ browser history), and the *manual copy-paste fallback* (`AUTH.md §1`, `ROADMAP.md Phase 1`) routes the code through the clipboard and the terminal (→ shell history / scrollback). `SECURITY.md` does not consider this path.
- **Failure mode.** A clipboard manager or shell-history file captures a fresh authorization code; combined with the locally-readable `client_secret` and, in a native flow, potentially the `code_verifier` if the flow is not strictly single-process, a stale code could be replayed. PKCE + single-use codes make this hard, but the leakage is real and avoidable.
- **Recommendation.** Prefer the loopback listener; use the manual paste only as a true fallback. In the manual flow, accept only the `code` (not the whole URL), read it without echo, never persist it, and clear it from memory immediately. Add `code` and the callback URL to redaction (see F2). Document the clipboard/history exposure.
- **Reference.** `AUTH.md §1`; `ROADMAP.md Phase 1`; `SECURITY.md § threat model`.

### F13 — `TT_REDIRECT_PORT` is fixed; the doc contradicts itself and omits collision/squat handling *(Low)*

- **Issue.** `AUTH.md §1` step 1 says the listener is on "`http://127.0.0.1:<random port>/callback`" and then, in the same step, says the port is **fixed** via `TT_REDIRECT_PORT` (default `43110`) because TikTok requires pre-registered redirect URIs. That is contradictory as written, and it does not say what happens if `43110` is already bound.
- **Failure mode.** A local process already listening on `43110` (benign collision, or a hostile "port squat") makes the legit listener fail to bind. A squatter receives the callback (code + state) but cannot exchange it without the `code_verifier` (PKCE) — so it is a login DoS, not a token theft. Still, undefined behavior on bind failure is a usability and clarity gap.
- **Recommendation.** Fix the wording to state the port is fixed and pre-registered. On bind failure, fail closed with a clear message and offer the manual-paste fallback; verify `state` in constant time; ensure the listener is strictly one-shot and closes immediately after the first callback. Note explicitly in the deep dive (§6) that PKCE is what neutralizes a port squatter.
- **Reference.** `AUTH.md §1`; `CONFIGURATION.md § OAuth / login`.

### F14 — `timingSafeEqual` on the HTTP bearer will throw or leak length if lengths differ *(Low)*

- **Issue.** `crypto.timingSafeEqual` requires equal-length buffers and throws otherwise; a naive length pre-check reintroduces a timing/length side channel (`ARCHITECTURE.md §3`).
- **Recommendation.** Compare fixed-length digests (e.g., `sha256(provided)` vs `sha256(expected)`) so length never varies and the comparison is constant-time regardless of input.
- **Reference.** `ARCHITECTURE.md §3`; `SECURITY.md § Transport`.

### F15 — Publish journal has no bound, no rotation, and survives logout/revoke *(Low)*

- **Issue.** `journal.ndjson` grows unbounded and appends forever (`ARCHITECTURE.md §8`); `AUTH.md §2` `--revoke` removes tokens but the design does not say the journal (posting history: profile, publish_id, title hash, timestamp) is purged or that its retention is bounded.
- **Failure mode.** Long-lived local record of the user's posting activity persists after they "log out," readable by any same-user process (and by others if directory perms are loose, per F7).
- **Recommendation.** Bound/rotate the journal, set it `0600`, and document retention. Optionally offer `login --revoke --purge-journal`.
- **Reference.** `ARCHITECTURE.md §8`; `AUTH.md §2`; `SECURITY.md § Write safety`.

### F16 — Untrusted video metadata flows into structured logs (log-forging) *(Low)*

- **Issue.** Read tools surface third-party titles/descriptions; if any of that reaches stderr/JSON logs via `logFields` or error text without strict JSON escaping, control characters/newlines could forge log entries. `SECURITY.md § Prompt-injection` treats this content as data for the model but does not mention the logging path.
- **Recommendation.** Guarantee logs are built with `JSON.stringify` (escaping), never string concatenation, and keep untrusted metadata out of `logFields`. Add a redaction/escaping test with a title containing newlines and braces.
- **Reference.** `ARCHITECTURE.md §10`; `SECURITY.md § Prompt-injection surface`.

### F17 — Supply-chain hardening: no provenance/2FA and an unpinned `npx -y` quickstart *(Low)*

- **Issue.** The quickstart runs `npx -y tiktok-mcp-ai` (auto-confirm, unpinned) (`README.md § Quickstart`), and `SECURITY.md § Supply chain` does not mention npm publish provenance, publisher 2FA, or version pinning.
- **Failure mode.** A future compromised release (or transitive dep) is pulled automatically with no version floor and no provenance to verify the artifact.
- **Recommendation.** Publish with `npm publish --provenance`, require 2FA on the npm account, and document pinning a version (`tiktok-mcp-ai@x.y.z`) in the MCP config for reproducibility. Optionally ship an SBOM.
- **Reference.** `README.md § Quickstart`; `SECURITY.md § Supply chain`; `ROADMAP.md Phase 3`.

### F18 — `state` and `code_verifier` entropy source is unspecified *(Low)*

- **Issue.** `AUTH.md §1` uses a "random `state`" and PKCE `code_challenge` but does not pin the CSPRNG or the entropy size.
- **Recommendation.** Specify `crypto.randomBytes` (≥ 32 bytes) base64url for both `state` and `code_verifier` (RFC 7636 range), and constant-time `state` comparison on callback. Cheap to state now; easy to get subtly wrong later.
- **Reference.** `AUTH.md §1`.

---

## 5. Threat-model gaps (threats `SECURITY.md` does not consider)

`SECURITY.md` names: malicious/confused model, hostile web page (prompt injection), other local processes reading files, network attackers; and explicitly excludes hostile local root and a compromised MCP client. The following are not addressed and should be added:

1. **Model-chosen local file read → off-box exfiltration.** `file_path` is arbitrary; the upload path can move any readable local file to TikTok (F3). The current model considers "local processes reading files" but not the server *itself* reading and exfiltrating files under model direction.
2. **Clipboard / terminal / browser-history capture of the authorization code** during login, especially in the manual-paste fallback (F12).
3. **Process-environment and MCP-client-config exposure of `client_secret`/tokens** — env inheritance, `/proc/<pid>/environ`, plaintext config file (F10). The model discusses the env *file* but not the env *variable* channel it itself recommends in the quickstart.
4. **DNS-rebinding / same-origin browser reach of the loopback HTTP listener** (F5) and of the login callback listener (F13) — a hostile *page* (distinct from a hostile server) driving a loopback socket.
5. **Autonomous-loop bypass of plan-and-apply** — the threat that there is *no human between plan and apply*, which the current text implicitly assumes exists (F4).
6. **Cross-profile misuse via the model-controlled `account` argument** (F11) — an authorization boundary the threat model treats only as an isolation (memory-bleed) concern.
7. **Denial-of-wallet / quota exhaustion.** A runaway or injected model can burn the unaudited-app 5-user/24h cap or exhaust Display-API QPS, locking the legitimate user out. The publish token bucket mitigates writes; reads have no equivalent guard.
8. **Journal as a privacy artifact** — persistent posting history surviving revoke (F15).
9. **TOCTOU on the media file** between validation (stat/sniff) and upload read — a same-user swap of `file_path` contents after validation. Low for single-user, but unstated.
10. **Trust placed in the model and client is not spelled out.** Every tool result (profile PII, `union_id`, video stats) is visible to the model and mirrored to the client; the client stores the app secret. "We don't defend against a compromised client" is stated, but the *data the client is trusted with* is not enumerated, which matters for users deciding whether HTTP mode / a shared client is acceptable.

---

## 6. Deep dive

### 6.1 The fixed-port loopback OAuth redirect

**Why the port is fixed.** RFC 8252 (OAuth for Native Apps) recommends a loopback redirect on an *ephemeral* port precisely so nothing has to be pre-registered. TikTok breaks that assumption: it requires an exact pre-registered `redirect_uri`, so the design pins `http://127.0.0.1:43110/callback` (`AUTH.md §1`, `CONFIGURATION.md`). That is the correct adaptation, but it changes the risk profile, and the doc's own "random port" phrasing (F13) should be corrected to avoid implying an ephemeral port.

**What the fixed loopback listener defends, and what it doesn't.** Using the literal `127.0.0.1` (not `localhost`) is right — it avoids a DNS lookup that could be hijacked. The listener must be **strictly one-shot**, close immediately after the first request, and validate `state` in constant time. The `state` is the CSRF defense: without it, any local page could POST a forged `?code=…` to the callback and complete a login the user did not initiate.

**The port-squat case.** Because the port is fixed and predictable, a co-resident same-user process can bind `43110` first. It then receives the real callback — `code` + `state` — but **cannot** complete the exchange: the token endpoint additionally requires the `code_verifier` (held only in the login process's memory) and the `client_secret`. This is exactly where PKCE earns its keep: a squatter gets a single-use code with no verifier and no replay value. The residual impact is a **login denial of service** plus knowledge of `state`. The design should (a) detect bind failure and fail closed with guidance, and (b) state this PKCE guarantee explicitly, because it is the reason a fixed loopback port is acceptable here.

**Browser-reachability of the listener.** While the listener is open, any page in the user's browser can attempt `http://127.0.0.1:43110/callback?...`. `state` validation defeats a forged code, but the listener should also ignore requests lacking a matching `state`, respond with a neutral page, and not reflect any request content. This is the same DNS-rebinding class as F5 and deserves one shared mitigation: reject requests whose `Origin`/`Host` is not the expected loopback and whose `state` does not match.

**Manual-paste fallback.** The fallback (needed if TikTok rejects loopback-HTTP for this app class) routes the `code` through the clipboard and terminal (F12). Accept only the code, read it without echo, never persist it, redact it, and use it once.

### 6.2 `upload_url` validation and the exfiltration channel it guards

The upload PUT is the one place the server sends **local bytes off the machine**, to a URL it did not hard-code — TikTok returns `upload_url` in the init response (`TIKTOK-API.md §4.2`). Two properties must both hold for this to be safe:

1. **The destination is genuinely TikTok.** A host-suffix string test is insufficient in two ways: `endsWith("tiktokapis.com")` matches `eviltiktokapis.com`, and even a correctly-suffixed host can *resolve* to a private/loopback/link-local address (rebinding) or to `169.254.169.254` (cloud metadata). The check must parse the URL, match the host as an exact apex or a true dot-bounded subdomain of an allowlisted registrable domain, require port 443, resolve the host, assert every resolved IP is publicly routable, and then connect to that pinned IP while preserving Host/SNI to avoid a TOCTOU rebind between check and connect (F8).
2. **The bytes are what the user intended.** This is where 6.2 meets F3: if `file_path` can be any local file, a strong `upload_url` check still faithfully ships `~/.ssh/id_rsa` to TikTok. The two controls are complementary — destination validation stops *where* bytes go; `TT_MEDIA_ROOT` + strict container validation stop *which* bytes go. Neither alone is sufficient.

Because the `upload_url` arrives over a TLS-authenticated channel from the pinned API origin, F8 is defense-in-depth today. It becomes load-bearing the moment anything relaxes the origin pin or if a response is ever spoofed, so it should be implemented as if it were the only barrier. The plan preview should show the resolved file path and byte size (F3) so the *human* barrier is meaningful too.

### 6.3 Redaction guarantees: denylist at the boundary vs. allowlist at the source

The design's redaction is a **denylist**: scrub known keys and Bearer-shaped strings before serialization (`SECURITY.md § Secrets`, `ARCHITECTURE.md §10`). Denylists fail open — a field the list didn't anticipate leaks. Two structural problems compound this:

- **Location (F1).** The scrubber is named as `mcp/redact.ts`, but the code that handles raw secrets (`core/oauth`, `core/http`) is a *lower* layer that cannot import it and logs to stderr directly. The primitive must live in `core/` so it sits beneath the secret-handling code, with the mcp layer re-using it for the model-facing path. Otherwise the most sensitive logs bypass redaction entirely.
- **Shape (F2).** The OAuth path carries secrets in **form-encoded** request bodies and in **response JSON** (including a rotated refresh token that is not Bearer-shaped). A key/shape denylist can miss both. The right guarantee for this narrow, high-value path is an **allowlist**: never serialize the raw body; log only an explicit set of non-secret fields.

Concretely, the redaction contract should read: *no secret ever reaches stderr, the `logging` mirror, a tool result, an error `detail`, or the journal.* Achieve it with (1) a `core/` redaction primitive on every log sink; (2) allowlist logging in the OAuth subsystem; (3) an explicit scrub set that includes `access_token`, `refresh_token`, `client_secret`, `code`, `code_verifier`, `Authorization`, plus the full callback URL; (4) `open_id`/`union_id` truncated in logs (already planned for `open_id`); and (5) tests that seed each secret into a `core`-level error and a mirrored log — not only a tool result — and assert it comes out scrubbed. `TESTING.md § mcp/*` already tests result/log/error scrubbing; extend it *downward* into `core/oauth` and `core/http`, which is where a real leak would originate.

---

*End of review.*
