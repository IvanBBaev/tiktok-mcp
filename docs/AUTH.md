# Authentication & authorization

TikTok uses OAuth 2.0 (Login Kit) with **user access tokens**. There is no
password or API-key mode: every data call runs on behalf of a TikTok user who
granted consent. App-level credentials (`TT_CLIENT_KEY`/`TT_CLIENT_SECRET`)
identify the developer app; user tokens identify the account.

## 1. Interactive login (CLI, not an MCP tool)

`npx tiktok-mcp-ai login [--profile <name>] [--scopes <csv>]`

Authorization-code flow with PKCE (TikTok's hex variant — § 2) and a loopback
redirect.

### 1.1 Loopback redirect (normative)

- **Registered redirect URI** (developer portal, once per app): the
  wildcard-port loopback form

  ```
  http://127.0.0.1:*/callback/
  ```

  The **trailing slash is mandatory** — every official TikTok desktop example
  carries it, and a slashless registration will not match the runtime URI.
- **Runtime bind:** `127.0.0.1:0` by default — an ephemeral port, so "port
  busy" is a non-event. Prefer `127.0.0.1`; **never bind or offer `::1`**
  (IPv6 loopback is not in TikTok's allowed host list). The effective redirect
  URI is `http://127.0.0.1:<port>/callback/`.
- **Byte-identical `redirect_uri`:** the `redirect_uri` parameter sent in the
  authorize URL and in the token exchange MUST be byte-for-byte identical to
  the effective URL — same scheme, host, port, path, and trailing slash.
- **`TT_REDIRECT_PORT` is an optional pin**, never a requirement (the wildcard
  registration accepts any port). If the pinned port is occupied, `login`
  fails with an error that names `TT_REDIRECT_PORT` and offers the
  manual-paste fallback — it never silently binds a port shape that is not
  registered (CC-A8).
- **Single-accept + constant-time state (CC-A9):** the listener accepts
  exactly one authorization response. `state` is random per attempt and
  verified with a **constant-time comparison**; a second hit (browser
  prefetch, page reload) receives a static "already handled" page and is
  never exchanged. A failed exchange consumes the attempt — the user restarts
  `login`.
- **Code decoding:** the authorization `code` arrives URL-encoded in the
  callback query string and MUST be **URL-decoded exactly once** before the
  token exchange — zero decodes breaks the exchange, a second decode corrupts
  any code containing `%`-sequences.
- **Manual-paste fallback (CC-A10):** when no listener can serve the redirect
  (headless/SSH session, pinned port busy, local firewall), `login` prints
  the authorize URL and accepts pasted input: either the full redirect URL
  (`state` is validated when present in it) or the bare `code`. Anything else
  is rejected with a clear message.

### 1.2 Flow

1. Start the single-accept loopback listener (§ 1.1) — or arm the
   manual-paste fallback.
2. Open the browser at `https://www.tiktok.com/v2/auth/authorize/` with
   `client_key`, `response_type=code`, requested `scope` (default:
   `user.info.basic,user.info.profile,user.info.stats,video.list,video.publish,video.upload`),
   `redirect_uri` (byte-identical, § 1.1), random `state`, `code_challenge`
   (§ 2), `code_challenge_method=S256` (TikTok's label for its hex variant).
3. Exchange the code at `POST https://open.tiktokapis.com/v2/oauth/token/`
   (form-encoded; flat OAuth response shape — § 4.1) with `client_key`,
   `client_secret`, `grant_type=authorization_code`, the once-decoded `code`,
   the byte-identical `redirect_uri`, and `code_verifier`.
4. Persist per profile: `access_token`, `refresh_token`, `open_id`, granted
   `scope`, and the computed absolute `expires_at` / `refresh_expires_at`
   (§ 3.1).
5. Print a summary: profile name, display name (one `user/info` probe),
   granted vs. requested scopes. TikTok users can deselect scopes on the
   consent screen — a partial grant is normal and must be shown, not treated
   as an error.

Logging in over a profile that already has tokens prompts for confirmation
(TTY) or requires `--force` (non-TTY), naming the TikTok account being
replaced (CC-A11).

`login` is deliberately a CLI subcommand: the OAuth dance needs a browser and
a listener, and an MCP tool must never receive or return token material.

## 2. PKCE — TikTok's hex deviation (CONFIRMED)

**CONFIRMED (CC-A13):** TikTok requires the `code_challenge` to be the
**lowercase hexadecimal** encoding of `SHA-256(code_verifier)` — a deliberate
deviation from RFC 7636, which mandates base64url. TikTok's documentation
states verbatim: *"Create the code challenge by hashing the code verifier
using hex encoding of SHA256."* A stock OAuth/PKCE library silently produces
base64url and every token exchange fails with `invalid_request` — the
challenge derivation is hand-rolled, never delegated to a library.

- **Verifier:** RFC 7636-conformant — unreserved characters
  (`A–Z a–z 0–9 - . _ ~`), length 43–128; generated from
  `crypto.randomBytes` (≥ 32 bytes, base64url-encoded).
- **Challenge:** `hex(sha256(verifier))`, always 64 lowercase `[0-9a-f]`
  characters.
- **Isolation:** the encoding lives in exactly one function —
  `pkceChallenge()` in `core/oauth.ts` — so a flip is a one-line change if
  TikTok ever aligns with the RFC.

### 2.1 Pinned test vector (normative fixture)

The `pkceChallenge()` unit test MUST assert exactly this pair:

```
verifier  = tiktok-mcp-ai_pinned-pkce-vector_0123456789abcdefghijklmnopqrstuvwxyz
challenge = 6d737a2ebee1e9712ca50681cb2cb3ae5315985849a85cf11400a06b2fcbd91f
```

The verifier is 69 characters from `[a-z0-9-_]` (⊂ RFC 7636 unreserved).
The expected challenge is reproducible with
`printf '%s' '<verifier>' | shasum -a 256`. The RFC 7636 base64url encoding
of the same digest — `bXN6Lr7h6XEspQaByyyzrlMVmFhJqFzxFACgay_L2R8` — is the
**wrong** answer and serves as the negative assertion: a test that sees it
has caught a library-default regression.

## 3. Token lifecycle at runtime

### 3.1 Expiry bookkeeping

- The token exchange returns `expires_in: 86400` (24 h) and
  `refresh_expires_in: 31536000` (365 d). Both expiries are stored as
  **absolute ISO-8601 UTC timestamps** computed as `received_at + expires_in`
  (`expires_at`, `refresh_expires_at`) — never as relative durations.
- Clock skew (CC-A4): if the stored expiry is in the past at load time but a
  request still succeeds, trust the API, not the clock. Proactive refresh
  fires when a request finds the access token within
  `TT_TOKEN_REFRESH_SKEW_S` (default 30 min) of `expires_at`. Independently, a
  401 / invalid-token on a live call triggers exactly **one** forced refresh
  and one replay — idempotent requests only (see the retry matrix).
- **Refresh-horizon warning (CC-A5):** `tiktok_get_auth_status` and `doctor`
  warn when `refresh_expires_at` is within **30 days**.
- **Terminal states:** an expired refresh token (365 d horizon reached) and
  user-side revocation (the user removed the app in TikTok settings — calls
  fail with an invalid-token code, refresh fails with `invalid_grant`;
  CC-A6) both map to the same **terminal** remediation: "authorization
  expired — re-run `tiktok-mcp-ai login`". Nothing loops or retries.
- Chunked uploads survive access-token expiry (CC-A3): chunk PUTs
  authenticate via the `upload_token` inside the `upload_url`, not the
  bearer; the status call after the upload triggers a normal refresh.

### 3.2 Refresh machinery (normative)

Refresh is `POST https://open.tiktokapis.com/v2/oauth/token/` with
`grant_type=refresh_token` (flat OAuth shape, § 4.1). TikTok may **rotate**
the refresh token on every refresh, and the rotation grace window is unknown
— two concurrent refreshes with the same refresh token must be assumed to
brick one of them. Hence:

- **In-process: single-flight per profile.** Concurrent tool calls coalesce
  onto one in-flight refresh; two refreshes for the same profile never race
  inside one process.
- **Cross-process: the env-file lock.** A mkdir-based lock directory
  (`<envfile>.lock` beside the resolved env file; atomic on every platform
  and network FS) serializes refreshes across processes. Liveness is
  mtime-only: heartbeat touch every 2 s, stale after 15 s (stale locks are
  removed and re-acquired with a logged warning), contention waits up to
  30 s with 50–150 ms jitter. The three knobs —
  `TT_ENV_LOCK_HEARTBEAT_MS`, `TT_ENV_LOCK_STALE_MS`, `TT_ENV_LOCK_WAIT_MS`
  — are documented in CONFIGURATION.md.
- **Lock scope** covers the full refresh critical section (rationale:
  SYNTHESIS § 2.2): re-read the env file (**adopt** the tokens if another
  process already rotated them, skipping the network call) → token-endpoint
  call → adopt the new token set in memory → read-merge-write persist (0600
  temp file, fsync, rename). Journal appends never use this lock.
- **Rotation persisted before use (CC-A1):** the rotated refresh token is
  written to the env file — atomically, in the same write as the new access
  token — **before** the new access token is used for any request. The only
  loss window is a crash between receipt and persist.
- **Lock timeout:** re-read the env file **once**; if a rotated token
  appeared (the other process finished its refresh), adopt it and proceed.
  Only otherwise surface `env_file_busy`.
- **`invalid_grant` recovery:** re-read the env file once **under the lock**;
  if a different refresh token is found there, adopt it and retry the
  refresh exactly once; otherwise it is the terminal re-login error (§ 3.1).
- **Degradation, never data loss:** a lock or persist failure never discards
  a valid in-memory token. The process continues in degraded in-memory mode
  with a warning — the token set survives until process exit, and a tool
  call is never failed because a credential could not be *persisted*.

## 4. Revocation — `login --revoke`

`tiktok-mcp-ai login --revoke [--profile <name>]`:

1. Calls `POST https://open.tiktokapis.com/v2/oauth/revoke/` (form-encoded:
   `client_key`, `client_secret`, `token` = the access token; empty body on
   success).
2. Clears the profile's token fields from the env file (under the env-file
   lock, § 3.2).
3. **Keeps the publish journal.** The journal is the only audit trail for
   "did it post?" — destroying it on revoke would destroy exactly the record
   needed most (rationale: SYNTHESIS § 2.10). Purging journal data requires
   the **explicit `--purge-journal` flag**, available on `login --revoke`
   and on `doctor`; without it, no revoke path touches the journal.

### 4.1 OAuth wire shape (CC-A12)

The token and revoke endpoints speak **flat OAuth-style JSON** (`error`,
`error_description`, `log_id`) — **not** the `{data, error}` envelope used by
the Display/Content APIs. They get a dedicated decoder (`oauthRequest` in
`core/http`); applying the envelope decoder to an OAuth response is a bug.

## 5. Multi-account profiles

One TikTok app, many user accounts:

```
TT_CLIENT_KEY / TT_CLIENT_SECRET            # the app (shared)
TT_ACCESS_TOKEN, TT_REFRESH_TOKEN, ...      # profile "default"
TT_PROFILE_BRAND_ACCESS_TOKEN, ...          # profile "brand"
TT_ACTIVE_PROFILE=default                   # which profile tools use by default
```

Every tool accepts `account: "brand"` to run one call against another profile;
the selection travels via `AsyncLocalStorage`, so parallel calls with
different accounts cannot bleed into each other. `tiktok_get_auth_status`
lists all profiles with expiry info.

## 6. Storage rules

- Tokens live **only** in the resolved env file (`TT_ENV_FILE` → XDG config
  dir on POSIX, `%LOCALAPPDATA%\tiktok-mcp-ai\.env` on win32 — resolver and
  permission semantics in CONFIGURATION.md; `0600` where the platform
  enforces modes) or in process env supplied by the MCP client; never in
  logs, journal, tool results, or error messages.
- The in-memory credential snapshot is replaced atomically on refresh;
  readers can never observe a new access token paired with an old refresh
  token.
- `TT_CLIENT_SECRET` is required for token exchange/refresh. Web-app style
  deployments that must not hold the secret client-side are out of scope for
  v1 (the server is a local, single-user process by design).

## 7. Scope model

Requested at login, granted (possibly partially) by the user, checked at
runtime:

- The registry marks tools whose scopes are missing (description prefix
  `[UNAVAILABLE: …]`) at startup.
- `scope_not_authorized` at call time (e.g. token predates a new scope) maps
  to: "re-run login requesting scope X".
- Field-level filtering: `tiktok_get_user_info` silently drops profile fields
  the granted scopes cannot serve and notes the omission in the result,
  because TikTok hard-errors on fields outside granted scopes.
