# Round 3 — Security review

Date 2026-10-29 · Commit `301b9bb` · Reviewer: senior Application Security Engineer (OAuth/OIDC, SSRF, supply chain, threat modeling) · Scope: token storage, OAuth PKCE login and refresh rotation, redaction, egress guard and DNS pin, Streamable HTTP transport, webhook receiver, oEmbed and prompt-injection surface, write safety (plan/apply, consent, journal), unattended `run-queue`, GitHub workflows and supply chain. Static review only. No live TikTok calls were made, and nothing here has been checked against the real API: all sandbox probes are still "not run".

## Verdict

For a local-first MCP server, the security engineering is above average. Every round-2 control (C1–C8) I checked is implemented: the egress allowlist with `redirect: "error"`, the DNS resolve-and-pin, the hex PKCE, refresh rotation serialized under the env lock, exact-value secret registration, the Host/Origin rebinding gate and the HMAC webhook. The remaining risk is concentrated where a prompt-injected agent meets the human. The consent dialog, the one checkpoint a human sees, does not show which media file or URL will be published. Most read tools do not carry the untrusted-content notice that `docs/SECURITY.md` promises. The OAuth callback listener lacks the Host/Origin check the doc claims, and `schedule.json` is an unauthenticated approval store that `run-queue` executes with `consented: true`. None of these is Critical, and none is exploitable without either a prompt-injected agent or a same-user process. Still, a tool that publishes to a public social account should not ship a consent prompt that hides the payload. **Readiness: 7/10.** The core crypto, egress and transport controls are solid. One High gap in the consent checkpoint and several doc-vs-code drifts must close first, and nothing has been exercised against production TikTok.

## What is strong

- **PKCE matches TikTok's actual (non-RFC) variant.** The verifier and state come from 32 random bytes as base64url, the challenge is the lowercase-hex SHA-256, and the verifier is registered as a secret on creation (`src/core/oauth.ts:216`, `:300-315`).
- **Refresh rotation is correct under concurrency.** Callers coalesce onto one promise. `withEnvLock` covers re-read, network call, adopt and persist, and the rotated refresh token is persisted before the new access token is served (`src/core/oauth.ts:15-21`, `:683`, `:703-773`). After a lock timeout the process adopts the token on disk instead of spending a dead one (`:791-802`).
- **Every token value is registered for redaction** the moment it exists: access, refresh, code, client secret and verifier (`src/core/oauth.ts:315`, `:388-389`, `:449-450`, `:524-525`).
- **Env-file writes are atomic.** The temp file is opened with `'wx'` and 0600, then fsync and rename, followed by an unconditional `chmod 0600` that warns on failure (`src/core/config.ts:826-912`).
- **The transport compares the bearer in constant time.** Both sides are SHA-256 digests fed to `timingSafeEqual`, and the Host/Origin gate runs before auth. A loopback bind requires both the loopback name and the exact bound port (`src/mcp/http.ts:243-275`). No CORS headers are emitted.
- **The webhook signature check is sound.** HMAC-SHA256 runs over `"<t>." + raw body` with a fixed-length `timingSafeEqual`, an absolute-value timestamp tolerance (default 300 s, range 30–3600) and a 64 KiB cap (`src/api/webhook.ts`).
- **The plan/apply binding is real.** `plan_id` is single-use and bound to the payload digest, and a "no" in the consent dialog consumes the plan (`src/tools/publish-common.ts:868-897`). The journal stores only `title_excerpt` and the `source` enum, never the media URL or path (`src/mcp/journal.ts:91-110`).
- **`run-queue` re-verifies before acting.** It re-previews each entry, checks the fresh plan against the stored digest and the stored file identity, forces `writeMode: 'plan'` and honors `deny`/read-only (`src/cli/run-queue.ts:354`, `:420`).
- **The workflow supply chain is clean.**
  - Every `uses:` is pinned to a full SHA; a grep found no unpinned action.
  - Top-level permissions default to `contents: read`.
  - `persist-credentials: false` is set.
  - npm publishing uses OIDC trusted publishing with provenance.
  - The `workflow_run` followers check `path`, `event == 'push'` and `head_repository == github.repository` and check out `head_sha` (`.github/workflows/publish-mcp.yml:32-46`, `publish-vscode.yml:36-53`).
  - Dependabot covers npm (root and extension) and github-actions.
- **`PULL_FROM_URL` cannot be used for SSRF.** The server never fetches the URL. It only validates https, no userinfo and the verified prefix, then hands the URL to TikTok.

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| SEC-01 | High | The consent dialog hides the payload. It shows action, account, title and privacy, but not the media source (file path or URL), the brand/disclosure flags, AIGC, or the comment/duet/stitch settings. A prompt-injected agent can swap the file behind a benign title and the human approves blind. | `src/mcp/consent.ts:26-34`, `:79-87`; `src/tools/publish-write.ts:718-728` (only `text` and `privacy` are passed) | Add `source` (basename plus parent directory for files; origin plus path, query stripped, for URLs), the file size, the disclosure/brand/AIGC flags and the interaction toggles to `ConsentItem`, and render them. Do the same for the photo and batch tools. |
| SEC-02 | Medium | Drift from `docs/SECURITY.md:362-364`: only `tiktok_get_embed` has an untrusted-content notice. The video, user, comment/webhook-event and journal read tools return TikTok-sourced text without one, and the server sends no `instructions`. | `grep -rn untrusted src/tools` finds only `src/tools/embed.ts:29`; `docs/SECURITY.md:362-364` | Add a shared `UNTRUSTED_NOTE` suffix to every tool that returns upstream text, plus server `instructions`. Add a test asserting the notice is on every tool marked `openWorldHint` that returns text. |
| SEC-03 | Medium | Drift from `docs/SECURITY.md:403`: the OAuth callback listener does no Host/Origin check. Because the single-accept latch flips before the state check, any local web page that hits `/callback` first ends the login attempt (login DoS; `state` still prevents CSRF). With `TT_REDIRECT_PORT` pinned, the port is known. | `src/cli/login.ts:469-492`, `:525-538`; `docs/SECURITY.md:403` | Reuse `dnsRebindingRejection`, or require `Host == 127.0.0.1:<port>` and refuse any request carrying `Origin`/`Sec-Fetch-Site: cross-site`, before flipping the latch. Flip the latch only on a state match, or say in the doc that it does not. |
| SEC-04 | Medium | `schedule.json` is an unauthenticated approval store. Each entry is executed by `run-queue` with `consented: true`, and the stored `payload_digest` is not keyed, so anything that can write the file (an agent with filesystem tools, a same-user process) can queue a publish that never passed a human checkpoint. Not documented in the threat model. | `src/cli/run-queue.ts:201`; `src/mcp/schedule.ts` (stored digest) | Either HMAC each entry with a key in the env file (0600) and refuse unsigned entries, or document explicitly in SECURITY.md that write access to the state directory is equivalent to publish rights. |
| SEC-05 | Medium | The webhook receiver does work before authenticating: it reads and parses the env file on every unauthenticated POST before checking the signature. Identity is the first profile only (`identity ??=`), so a second app's events always fail verification. | `src/mcp/webhook.ts:222-232`, `:282-300` | Cache the identity (invalidate on env-file mtime), verify against every configured client secret, and rate-limit 401s per remote address. |
| SEC-06 | Low | Replay dedupe is an in-memory set of 1024 digests. After a restart, a captured delivery replayed within the tolerance window is re-appended and `onEvent` (including `authorization.removed`, which calls `forgetRevokedProfile`) fires again. | `src/mcp/webhook.ts:63`, `:176-192` | Seed the set from the tail of the event log at startup. |
| SEC-07 | Low | The webhook log's 0600 mode applies only when the file is created. An existing looser file is not tightened, and a pre-existing directory is not chmodded to 0700. | `src/mcp/webhook.ts:114` | `fchmod(0o600)` after open (non-win32), matching `atomicWrite`. |
| SEC-08 | Low | Response bodies are unbounded. `await response.text()` has no size cap, and the oEmbed 64 KiB cap is checked only after the full parse. A hostile or broken upstream can force a large allocation that only the timeout bounds. | `src/core/http.ts:1192`; `src/api/embed.ts:37`, `:190` | Stream the body with a byte cap (for example 4 MiB for JSON, 64 KiB for oEmbed) and abort beyond it. |
| SEC-09 | Low | `underPrefix` uses a literal `pathname.startsWith`, so a `TT_VERIFIED_URL_PREFIXES` entry without a trailing slash admits sibling paths (`/media` matches `/media-private/...`). | `src/tools/publish-common.ts:703-711` | Normalize prefixes to end in `/`, or require `pathname === p` or `startsWith(p + '/')`. |
| SEC-10 | Low | HTTP transport hardening gaps: `TT_HTTP_TOKEN` needs only 16 printable characters (no entropy check), there is no auth-failure throttling, no explicit `headersTimeout`/`requestTimeout`, and `TT_HTTP_INSECURE=1` acknowledges but does not enforce TLS off loopback. | `src/core/settings.ts` (token and insecure validation); `src/mcp/http.ts` (no timeouts set) | Require 32 or more characters (or reject low-variety tokens), add a small per-IP 401 back-off, and set explicit server timeouts. |
| SEC-11 | Low | The oEmbed `html` is returned verbatim. A client that renders tool results as HTML would execute TikTok's script tag. Only the description warns. | `src/tools/embed.ts:21-29`, `:63-66` | Mark the field in the output schema as raw HTML, not to be rendered, or return it as a fenced code block in the text content. |
| SEC-12 | Low | `npm audit --omit=dev` reports one moderate advisory (GHSA-rmxm-3fg6-px4f, `@hono/node-server` 2.1.0, via `@modelcontextprotocol/sdk` 1.32.1). It is not reachable, since `serveStatic` is not used, but the CI gate is `--audit-level=high`, so it is silent. The three stale dependabot PRs (#36–38) are still open. | `npm audit` output; `.github/workflows/ci.yml:61` | Run `npm audit fix` (lockfile only) and merge or close #36–38 before the first release. |
| SEC-13 | Info | Windows token storage relies on per-user `%LOCALAPPDATA%` inheritance. The 0600 `chmod` is a no-op there and no ACL is applied. This is a documented decision, and it should stay explicit in the README install notes. | `src/core/config.ts:236-250`, `:826-912` | Keep as documented, or add an optional `icacls /inheritance:r /grant:r %USERNAME%:F` step to `doctor`. |

### SEC-01 — The consent dialog hides what is being published

- **What:** `confirmWrite` builds a `ConsentItem` with only `action`, `account`, `text` (the title) and `privacy` (`src/tools/publish-write.ts:718-728`). `formatConsentItem` renders those fields and nothing more (`src/mcp/consent.ts:79-87`). The media source, the brand/disclosure flags and the interaction settings never reach the human.
- **Why it matters:** The elicitation dialog is the only control documented as standing between a prompt-injected agent and a public post (`docs/SECURITY.md`, the write-safety section). The `plan_id` digest binds the payload to the plan, but the human never sees the payload, so the binding guarantees only that the agent cannot change what the human did not see.
- **Failure scenario:** The agent reads a video description or webhook event containing an injected instruction. It calls the publish tool with `file_path` set to some other `.mp4` under `TT_MEDIA_ROOT` (or a `PULL_FROM_URL` on a verified prefix pointing at a different object), a harmless title and `privacy_level: PUBLIC_TO_EVERYONE`. The dialog reads "Publish a video · @account · 'Weekend recap' · privacy PUBLIC_TO_EVERYONE". The user approves, and the wrong bytes go public. The same applies to turning off a required brand-content disclosure.
- **Fix:**
  1. Extend `ConsentItem` with `source` (for a file, the last two path segments plus the size; for a URL, origin plus path with the query stripped), `disclosure` (brand_organic / brand_content / AIGC) and `interactions` (comment/duet/stitch disabled).
  2. Render them in `formatConsentItem` and populate them in every write tool (video, photos, batch, schedule).
  3. Add a test that fails if a publish-tool argument that changes the outcome is absent from the rendered consent text.
  4. Add a "what the human sees" note to `docs/SECURITY.md`.

## Open questions for the owner

1. Is the state directory (`schedule.json`, the journal, the webhook log) inside the threat model? If an agent with filesystem tools is in scope, SEC-04 needs the HMAC. If not, SECURITY.md must say that write access to that directory means publish rights.
2. Should `TT_ELICITATION` default to `required` once a write package is enabled? Today, a client without elicitation support publishes with no human checkpoint unless the user opts in.
3. Is multi-app (several client keys) a supported configuration? If yes, SEC-05's first-profile identity is a functional bug, not only a hardening item.
4. Will the HTTP transport ever be documented for non-loopback use? If not, consider removing `TT_HTTP_INSECURE` instead of hardening it (SEC-10).
5. Should the DNS pin's automatic disable under an env proxy be logged once at `warn` in `doctor`? I did not verify what `doctor` prints today.

## Proposed roadmap items

#### SEC-R1 — Show the full payload in the consent dialog
Deps none · Status open · Est 4 h
- **Scope:** **Release-blocking.** Fixes SEC-01. Add `source`, `size`, disclosure/brand/AIGC flags and interaction toggles to `ConsentItem` and render them, for every write tool (video, photos, batch, schedule).
- **Owns:** `src/mcp/consent.ts`, the consent call sites in `src/tools/publish-write.ts`, `src/tools/publish-photos.ts`, `src/tools/publish-batch.ts`, `src/tools/schedule.ts`.
- **Shared:** `docs/SECURITY.md` (the write-safety section), consent tests.
- **Acceptance:** A test asserts that the rendered consent text contains the file basename or URL path (query stripped), the privacy level and every disclosure flag for each write tool. No URL query string or full home-directory path appears in the dialog.

#### SEC-R2 — Untrusted-content notice on every upstream-text tool, plus server instructions
Deps none · Status open · Est 2 h
- **Scope:** **Release-blocking** (SECURITY.md currently claims this). Fixes SEC-02 and SEC-11. Add a shared notice suffix and server `instructions`, and mark oEmbed `html` as non-renderable.
- **Owns:** a new constant in `src/mcp/define.ts` or similar, tool descriptions under `src/tools/`.
- **Shared:** `docs/SECURITY.md:362-364`, the tool-description snapshot tests.
- **Acceptance:** A test enumerates the tools that return TikTok-sourced text and asserts that each description contains the notice. The server `instructions` are present in the initialize result.

#### SEC-R3 — Host/Origin gate on the OAuth callback listener
Deps none · Status open · Est 2 h
- **Scope:** Fixes SEC-03. Apply the loopback Host/port check and refuse cross-site requests before the single-accept latch flips. Fix the claim at `docs/SECURITY.md:403` either way.
- **Owns:** `src/cli/login.ts` (`createCallbackSink`, `nodeListen`).
- **Shared:** `src/mcp/http.ts` (if `dnsRebindingRejection` is reused), `docs/SECURITY.md`.
- **Acceptance:** A request with a wrong Host, or with `Origin: https://evil.example`, gets 403 and leaves the latch unconsumed. A correct callback afterwards still completes the login.

#### SEC-R4 — Authenticate or document the schedule store
Deps none · Status open · Est 3 h
- **Scope:** Fixes SEC-04. HMAC each `schedule.json` entry with a per-install key kept in the 0600 env file, and have `run-queue` refuse entries that are unsigned or carry a bad signature. Alternatively, as an owner decision, document that write access to the state directory equals publish rights.
- **Owns:** `src/mcp/schedule.ts`, `src/cli/run-queue.ts`.
- **Shared:** `docs/SECURITY.md` (threat model), `src/core/config.ts` (key storage).
- **Acceptance:** A hand-edited entry is refused by `run-queue` with a clear error and is never applied. Existing entries migrate, or the change is documented as a breaking change.

#### SEC-R5 — Webhook receiver hardening
Deps none · Status open · Est 3 h
- **Scope:** Fixes SEC-05, SEC-06 and SEC-07. Cache the identity and verify against every configured client secret before any further work, seed the dedupe set from the log tail at startup, `fchmod` the log to 0600, and add a per-IP 401 back-off.
- **Owns:** `src/mcp/webhook.ts`.
- **Shared:** `src/api/webhook.ts`, the webhook tests.
- **Acceptance:** With two profiles, events signed by either app verify. A delivery replayed after a restart inside the window is not re-appended. A pre-existing 0644 log ends up 0600.

#### SEC-R6 — Bounded response bodies
Deps none · Status open · Est 2 h
- **Scope:** Fixes SEC-08. Read upstream bodies through a byte-capped stream: a general JSON cap, plus the oEmbed cap enforced before parsing.
- **Owns:** `src/core/http.ts` (around `:1192`), `src/api/embed.ts`.
- **Shared:** the http tests.
- **Acceptance:** A stubbed upstream body one byte over the cap fails with a typed, redacted error, without buffering the whole body.

#### SEC-R7 — Small input and transport hardening
Deps none · Status open · Est 2 h
- **Scope:** Fixes SEC-09 and SEC-10. Enforce a path-segment boundary for verified prefixes, require a minimum of 32 characters for `TT_HTTP_TOKEN`, and set explicit server `headersTimeout`/`requestTimeout`.
- **Owns:** `src/tools/publish-common.ts` (`underPrefix`), `src/core/settings.ts`, `src/mcp/http.ts`.
- **Shared:** the settings docs (`docs/` configuration page), the tests.
- **Acceptance:** `/media` no longer admits `/media-private/x.mp4`. A 20-character token is refused at startup with a clear message. The timeouts are visible in a test.

#### SEC-R8 — Dependency hygiene before the first release
Deps none · Status open · Est 1 h
- **Scope:** **Release-blocking** (it should not ship with known advisories and stale bot PRs). Fixes SEC-12. Run `npm audit fix` on the lockfile and merge or close dependabot #36–38. Consider tightening the CI gate to `--audit-level=moderate` for prod deps, with an allowlist file.
- **Owns:** `package-lock.json`, `.github/workflows/ci.yml`.
- **Shared:** the dependabot PRs.
- **Acceptance:** `npm audit --omit=dev` reports 0 vulnerabilities, and no dependabot PR is older than 14 days.

## Top recommendation

Before the first release, make the consent dialog show exactly which media and disclosure settings will be published (SEC-R1), because that dialog is the only thing standing between a prompt-injected agent and a public post.
