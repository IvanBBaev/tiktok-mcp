# Configuration reference

Everything is environment-driven, prefix **`TT_`**. Per-key resolution order:
process env (from the MCP client) → env file. Resolution is **presence-based**:
a variable set to the empty string counts as **set** and overrides the env file
with "empty"; validation then rejects empties where a value is required
(CC-F2).

An `.env.example` is generated from the tables below and kept in sync by a
test (`env-docs-sync`). The `Settings` interface in `docs/CONTRACTS.md`
(§ core/settings) carries **exactly one field per variable in these tables** —
naming rule: strip `TT_`, camelCase (`TT_PLAN_TTL_S` → `planTtlS`,
`TT_ENV_LOCK_WAIT_MS` → `envLockWaitMs`). The credential keys (the token
sextet and `TT_PROFILE_<NAME>_*`) are the exception: they are read through
`core/config`'s `ProfileCredentials`, not `Settings`.

## Env file

### Location (rationale: SYNTHESIS § 2.1)

| Step | POSIX (Linux/macOS) | Windows (win32) |
|---|---|---|
| 1. Explicit override | `TT_ENV_FILE` (used verbatim) | `TT_ENV_FILE` (used verbatim) |
| 2. Default | `$XDG_CONFIG_HOME/tiktok-mcp-ai/.env`, falling back to `~/.config/tiktok-mcp-ai/.env` | `%LOCALAPPDATA%\tiktok-mcp-ai\.env` |

The resolved path is both the read source and the write target. The publish
journal (`journal.ndjson`) and the env-file lock directory (`<envfile>.lock`)
always live **beside the resolved env file**, so a custom `TT_ENV_FILE` keeps
all runtime artifacts together and `--purge-journal` needs no second resolver.

On Windows the location is `%LOCALAPPDATA%`, **never** `%APPDATA%` (Roaming):
roaming profiles replicate to other machines, and tokens must not roam.

### Permissions

- `fs.chmod(path, 0o600)` is called **unconditionally on all platforms** after
  every write. On win32 this is a harmless no-op; the mode is **asserted only
  when `process.platform !== "win32"`** — the win32 write assertion is "file
  exists and content round-trips".
- The containing directory is created `0o700` on POSIX; on win32 it is created
  normally and protection relies on the inherited user-profile ACLs of
  `%LOCALAPPDATA%` (the same model as aws-cli and gcloud).
- The server **never runs `icacls`**. On Windows, `doctor` prints an info line
  about profile ACLs and the optional hardening command as remediation **text
  only**:

  ```
  icacls "<path>" /inheritance:r /grant:r "%USERNAME%":F
  ```

- On POSIX, `doctor` warns when the file is not `0600` and offers to fix it;
  runtime writes always (re)apply `0600` (CC-F3).

### Writes (login, token rotation)

- **Atomic:** a temp file in the same directory (written `0600`, fsync'd),
  then `rename` onto the target.
- **Comment- and CRLF-preserving:** rewrites keep comments and line endings;
  unknown `TT_*` keys are round-tripped verbatim, never dropped.
- **win32 rename hardening:** `rename` onto an open handle (antivirus
  scanners, the Search indexer) can fail `EPERM`/`EBUSY`; it is retried ×3
  with 50/100/200 ms backoff. On final failure the process **degrades to the
  in-memory token with a warning** and retries persistence on the next write —
  a persist failure never discards a valid in-memory token and never fails a
  tool call (CC-H3).
- All writers (`login`, token refresh, `doctor`) serialize on the
  cross-process env-file lock (CC-A2, CC-F5; protocol below).

### Parsing (CC-F1)

Missing file — fine (process env may suffice). Unreadable file — explicit
error. Malformed line — error naming the line number. Duplicate key — **last
wins**, with a logged warning. CRLF endings tolerated and preserved.

### Numeric validation (CC-F6)

Every numeric `TT_` variable is zod-validated at startup; **all** problems are
aggregated into **one** startup error. Garbage values never become NaN
behavior at call time.

### Schema versioning — `TT_CONFIG_SCHEMA`

- Every save writes `TT_CONFIG_SCHEMA=1`; an absent marker reads as `1`. The
  number bumps only on incompatible shape changes (a key rename is compatible;
  changing an existing key's value format is not).
- **Old binary, newer file:** unknown keys are ignored with a single warning
  (and round-tripped on write). If `TT_CONFIG_SCHEMA` is greater than the
  binary supports, the binary refuses to **write** (reads stay best-effort)
  with the remediation "this config was written by a newer version — update:
  `npx tiktok-mcp-ai@latest`".
- **Never migrate on read.** Migration happens only on an explicit write
  (login, token rotation); a read-only invocation must not mutate the
  operator's file.
- The first save that changes `TT_CONFIG_SCHEMA` copies the file once to
  `.env.pre-schema<N>` (`0600`); `doctor` lists leftover backups as info.

## Profiles

- The **default profile** is the bare token sextet: `TT_ACCESS_TOKEN`,
  `TT_REFRESH_TOKEN`, `TT_OPEN_ID`, `TT_SCOPES`, `TT_TOKEN_EXPIRES_AT`,
  `TT_REFRESH_EXPIRES_AT`.
- Extra accounts use `TT_PROFILE_<NAME>_*` — the same six keys per profile.
  Profile names match `[A-Z0-9_]+` and are upper-cased on read; a profile
  literally named `DEFAULT` collides with the implicit default sextet and is
  rejected (CC-F4).
- `TT_ACTIVE_PROFILE` selects the profile used when a tool call has no
  `account` argument; pointing it at a nonexistent profile is a startup
  configuration error listing the profiles that do exist (CC-F4).

## Variables

### Env file & profiles

| Variable | Default | Description |
|---|---|---|
| `TT_ENV_FILE` | — | Explicit env-file path override (all platforms); journal and lock follow the resolved file |
| `TT_CONFIG_SCHEMA` | `1` (absent ⇒ `1`) | Env-file schema marker, written on every save — see Schema versioning above |
| `TT_ACTIVE_PROFILE` | `DEFAULT` | Profile used when a tool call has no `account` argument |
| `TT_LOCK_PROFILE` | — | Pin the session to one profile: when set, an explicit `account` naming any other profile fails locally (no network spent), and the plan preview names the target profile |

### App & tokens

| Variable | Default | Description |
|---|---|---|
| `TT_CLIENT_KEY` | — (required) | TikTok app client key |
| `TT_CLIENT_SECRET` | — (required) | TikTok app client secret (secret) |
| `TT_ACCESS_TOKEN` | — | Default-profile user access token (written by `login`) (secret) |
| `TT_REFRESH_TOKEN` | — | Default-profile refresh token (written by `login`/refresh) (secret) |
| `TT_OPEN_ID` | — | Default-profile open_id (written by `login`) |
| `TT_SCOPES` | — | Granted scopes, comma-separated (written by `login`) |
| `TT_TOKEN_EXPIRES_AT` | — | Access-token expiry, ISO-8601 UTC (written by `login`/refresh; CC-H2) |
| `TT_REFRESH_EXPIRES_AT` | — | Refresh-token expiry, ISO-8601 UTC (written by `login`/refresh; CC-H2) |
| `TT_PROFILE_<NAME>_*` | — | The same six token keys per extra account profile |

### OAuth / login

| Variable | Default | Description |
|---|---|---|
| `TT_REDIRECT_PORT` | — (ephemeral) | **Optional fixed-port pin** for the login loopback server — see below |
| `TT_LOGIN_SCOPES` | derived from enabled packages | Scopes requested by `login`; the default is least-privilege from `TT_TOOL_PACKAGES` (direct posting needs `video.publish`, draft-only setups need `video.upload` only). Set explicitly to override |
| `TT_TOKEN_REFRESH_SKEW_S` | `1800` (s) | Refresh the access token this long before its expiry |

**`TT_REDIRECT_PORT` — optional pin only** (rationale: SYNTHESIS § 2.11). The
registered redirect is the wildcard-port form `http://127.0.0.1:*/callback/`
(trailing slash mandatory; the `redirect_uri` sent is byte-identical to the
effective URL), and the default flow binds `127.0.0.1:0` — an ephemeral port,
so "port busy" is a non-event by default. When the variable pins a port and
that port is occupied, `login` fails with a message **naming
`TT_REDIRECT_PORT`** and offers the manual-paste fallback; it never silently
binds a redirect shape that is not registered (CC-A8).

### Tool surface & write policy

| Variable | Default | Description |
|---|---|---|
| `TT_TOOL_PACKAGES` | `core` | Comma list of packages (`auth`, `user`, `video`, `publish`, `publish-write`) or a named profile: `core` = all reads (`auth`+`user`+`video`+`publish`), `all` = everything |
| `TT_PACKAGES_DENY` | — | Packages forced off regardless of the above (deny wins) |
| `TT_PACKAGES_READONLY` | `0` | `1` = register only tools with `readOnlyHint` (unregisters `publish-write`) |
| `TT_WRITE_MODE` | `plan` | `plan` \| `apply` \| `deny` — see below |
| `TT_PLAN_TTL_S` | `600` | Lifetime of a minted `plan_id`; an expired plan fails with `plan_not_found` and requires a fresh preview |
| `TT_PLAN_MAX_OUTSTANDING` | `32` | Cap on the in-memory plan store; oldest plans are evicted first |
| `TT_DEFAULT_AIGC_LABEL` | `1` | Default for `is_aigc` on posts |

**`TT_WRITE_MODE` — three values** (rationale: SYNTHESIS § 2.8):

- **`plan` (default).** Write tools have no `apply` boolean. A call **without**
  `plan_id` validates everything, spends no init, and returns a preview plus a
  single-use `plan_id` (`plan_` + 32 lowercase hex chars); a call **with** a
  `plan_id` executes it. A direct-post call missing `privacy_level` returns
  `mode:"plan_incomplete"` and no token is minted. The plan store is
  in-process memory only and is never persisted — a server restart means
  re-plan, by design.
- **`apply`.** `plan_id` becomes optional: a write call without one executes
  directly. Documented warning, verbatim: **"trusted automation only: this
  mode has no injection resistance"**.
- **`deny`.** The `publish-write` package is not registered at all.

### Media & URL sources

| Variable | Default | Description |
|---|---|---|
| `TT_MEDIA_ROOT` | — (**fail-closed**) | The only directory `FILE_UPLOAD` tools may read media from; unset ⇒ `source:"file"` is rejected locally — see below |
| `TT_VERIFIED_URL_PREFIXES` | — | Comma-separated `https://` URL prefixes the operator has verified in the TikTok developer portal. **Advisory only** — see below |

**`TT_MEDIA_ROOT` — fail-closed.** `FILE_UPLOAD` tools refuse to run without
it: when unset, `source:"file"` is rejected **locally** (no network spent)
with error code `media_root_not_configured` and this exact text:

> source "file" is disabled: the operator has not set TT_MEDIA_ROOT (the only
> directory this server may read media from). Ask the user to set
> TT_MEDIA_ROOT in the server configuration and restart, or host the media on
> a verified URL and use source "url".

Semantics:

- The value is a plain absolute path (`C:\Users\me\Videos` on Windows); `~`
  expansion is done by the server, not the shell, when the value comes from an
  MCP client config.
- Containment (CC-D8): both sides are canonicalized with `fs.realpath`
  (symlinks resolved), then containment is checked via
  `path.relative(root, target)` — inside iff the result is neither
  `..`-prefixed nor absolute; the comparison is case-insensitive on win32.
  Bare prefix/`startsWith` checks are wrong (`/media` matches `/media-evil`)
  and are not used. Relative `file_path` values resolve against
  `TT_MEDIA_ROOT`, never CWD. Directories and device files are rejected.
- The check runs at plan time and is **re-run at execute** together with the
  re-stat (size/mtime match — CC-D3/D4).
- Choose a dedicated media folder; pointing `TT_MEDIA_ROOT` at `$HOME` defeats
  the control (`~/.ssh`, browser profiles, … all live under home).
- `doctor`: unset is info ("file uploads disabled until set"); set-but-invalid
  (missing directory, unreadable) is FAIL.

**`TT_VERIFIED_URL_PREFIXES` — advisory only, never a security control.**
TikTok only pulls `PULL_FROM_URL` media from domains verified in the
developer portal; the portal is the source of truth and upstream
`url_ownership_unverified` remains the authoritative failure. This variable
only lets the plan phase catch unverifiable URLs early: when set, a
`video_url`/photo URL that matches no listed prefix fails at plan time with an
explanatory error naming the variable; when unset, URLs pass through and the
plan preview carries a warning that TikTok refuses unverified domains. A
stale local list must never be treated as enforcement.

### Journal

| Variable | Default | Description |
|---|---|---|
| `TT_JOURNAL_MAX_BYTES` | `5242880` | Rotation threshold for `journal.ndjson`; checked only immediately before an intent append; one `.1` generation kept |

**Location & lifecycle** (rationale: SYNTHESIS § 2.7): the journal is
`journal.ndjson`, created `0600`, in a `0700` directory (POSIX; inherited
profile ACLs on win32) **beside the resolved env file**. It is append-only
(`O_APPEND`) and does **not** use the env-file lock. Rotation keeps exactly
one `.1` generation; readers merge both. `login --revoke` keeps the journal
(it is the only audit trail for "did it post?"); purging requires the
explicit `--purge-journal` flag (rationale: SYNTHESIS § 2.10).

### Env-file lock

| Variable | Default | Description |
|---|---|---|
| `TT_ENV_LOCK_HEARTBEAT_MS` | `2000` | Interval of the mtime heartbeat touch on the held lock directory |
| `TT_ENV_LOCK_STALE_MS` | `15000` | A lock whose mtime is older than this is stale: removed and re-acquired with a logged warning |
| `TT_ENV_LOCK_WAIT_MS` | `30000` | Maximum wait for a contended lock (retries with 50–150 ms jitter) before the timeout path below |

**Protocol** (rationale: SYNTHESIS § 2.2): acquisition is
`fs.mkdir("<envfile>.lock")` — atomic on every platform and network
filesystem. The JSON file inside (`{pid, hostname, createdAt}`) is diagnostic
only; **liveness is mtime-only, never PID-based**. The lock covers the full
token-refresh critical section: re-read env (adopt if already rotated) →
token-endpoint call → adopt in memory → read-merge-write persist. On wait
timeout the process **re-reads the env file once** — if a rotated token
appeared, it is adopted and the call proceeds; only otherwise is
`env_file_busy` surfaced. A lock or persist failure never discards a valid
in-memory token. Journal appends do not take this lock.

### HTTP / limits / output

| Variable | Default | Description |
|---|---|---|
| `TT_TIMEOUT_MS` | `30000` | Per-request timeout |
| `TT_UPLOAD_TIMEOUT_MS` | `120000` | Timeout **per chunk PUT** — the whole transfer has no separate wall-clock cap (CC-D7) |
| `TT_MAX_RETRIES` | `3` | Retry cap for the idempotent **read** class (429/5xx/network, honoring `Retry-After`); publish inits are never retried (CC-B7) |
| `TT_CHUNK_RETRIES` | `3` | Per-chunk retry cap for upload PUTs: each chunk is tried once plus up to this many retries with an **identical** `Content-Range` (5xx retryable; 4xx terminal; 403 = expired upload URL, no auto-re-init; 416 ⇒ resync via `uploaded_bytes`) — CC-B7, CC-D6 |
| `TT_MAX_CONCURRENT` | `4` | Per-host concurrency semaphore |
| `TT_PUBLISH_RPM` | `6` | Local token bucket for publish inits, per profile (continuous refill — one token every 10 s at the default) — see below |
| `TT_FETCH_ALL_CAP` | `200` | Item cap for `fetch_all` pagination |
| `TT_RESULT_CHAR_BUDGET` | `25000` | Truncation budget for tool results (always valid JSON — CC-G2) |
| `TT_PRETTY_JSON` | `0` | Pretty-print results (costs tokens) |
| `TT_STATUS_POLL_INTERVAL_MS` | `5000` | Base interval between publish-status polls inside `wait_for_completion` (wall-clock deadlines re-checked on wake — CC-H1) |
| `TT_STATUS_POLL_TIMEOUT_MS` | `60000` | Poll budget; hitting it is **not** an error — the result says "still processing" with the `publish_id` (CC-E8) |
| `TT_LOG_LEVEL` | `info` | stderr-only log level (`debug` never logs bodies with secrets) |

**Local rate limiting** (rationale: SYNTHESIS § 2.12): the publish-init
bucket is per profile with continuous refill; an empty bucket rejects
**locally** with `local_rate_limited`, a `retry_after_s`, and an absolute
`retry_at` — zero network, never a sleep. The plan preview still succeeds and
shows bucket occupancy. Reads delay briefly instead of rejecting: status
polls stay inside the poll budget, and `creator_info` waits up to
`TT_TIMEOUT_MS` before returning `local_rate_limited`. The local bucket is a
courtesy, not the enforcement point — an upstream 429 on an init remains
terminal (CC-B8).

### Transport

| Variable | Default | Description |
|---|---|---|
| `TT_TRANSPORT` | `stdio` | `stdio` or `http` (Streamable HTTP) |
| `TT_HTTP_HOST` | `127.0.0.1` | HTTP bind host |
| `TT_PORT` | `3000` | HTTP port |
| `TT_HTTP_TOKEN` | — | Bearer token, **required whenever `TT_TRANSPORT=http`** — loopback included; at least 16 characters of printable ASCII with no spaces (it travels verbatim in an `Authorization` header); compared constant-time via fixed-length digests (secret) |
| `TT_HTTP_INSECURE` | `0` | `1` explicitly acknowledges a non-loopback bind without TLS; otherwise the server refuses to bind beyond loopback without TLS termination in front |

### Internal / test-only

These are **not** part of the supported configuration surface: they exist so the
test harness can point the OAuth flow at a local stub instead of the live
provider. They are deliberately absent from `.env.example` and from the
generated `server.json`, may change or disappear in any release, and must never
be set in a real deployment.

| Variable | Default | Description |
|---|---|---|
| `TT_OAUTH_BASE_URL` | — | Overrides the OAuth authorize/token origin. Internal, unsupported. Ignored unless the process is running under the test harness. |

Secrets (`TT_CLIENT_SECRET`, `TT_ACCESS_TOKEN`, `TT_REFRESH_TOKEN`,
`TT_HTTP_TOKEN`, and the per-profile token keys) are flagged
`isSecret: true` in the generated `server.json` registry manifest;
`TT_CLIENT_KEY`/`TT_CLIENT_SECRET` are `isRequired: true`.
