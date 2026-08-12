# tiktok-mcp-ai — Unofficial TikTok MCP Server

| [![npm version](https://img.shields.io/npm/v/tiktok-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/tiktok-mcp-ai) | [![npm downloads](https://img.shields.io/npm/dm/tiktok-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/tiktok-mcp-ai) | [![node](https://img.shields.io/node/v/tiktok-mcp-ai?style=flat-square&logo=node.js&logoColor=white&label=node)](https://nodejs.org) | [![tools](https://img.shields.io/badge/tools-11-blue?style=flat-square)](https://ivanbbaev.github.io/tiktok-mcp/#tools) | [![License: MIT](https://img.shields.io/npm/l/tiktok-mcp-ai?style=flat-square&color=blue&label=license)](LICENSE) |
| :--: | :--: | :--: | :--: | :--: |
| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/tiktok-mcp/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/tiktok-mcp/actions/workflows/ci.yml) | [![coverage](https://img.shields.io/codecov/c/github/IvanBBaev/tiktok-mcp/main?style=flat-square&logo=codecov&logoColor=white&label=coverage)](https://codecov.io/gh/IvanBBaev/tiktok-mcp) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/tiktok-mcp?style=flat-square&logo=github&logoColor=white)](https://github.com/IvanBBaev/tiktok-mcp/commits/main) | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) | [![Known Vulnerabilities](https://snyk.io/test/npm/tiktok-mcp-ai/badge.svg)](https://snyk.io/test/npm/tiktok-mcp-ai) |

📖 **[Documentation site →](https://ivanbbaev.github.io/tiktok-mcp/)**

An unofficial MCP ([Model Context Protocol](https://modelcontextprotocol.io))
server for **TikTok** — a safe, policy-governed tool surface over the official
[TikTok for Developers](https://developers.tiktok.com) APIs: the **Display API**
(read a creator's profile and videos) and the **Content Posting API** (publish
videos and photo carousels). It adds OAuth 2.0 (PKCE) user authorization,
plan-then-execute write safety, an append-only publish journal, multi-account
profiles, and token-efficient results — so a model can work with TikTok without
knowing any of the platform's sharp edges (24-hour tokens, cursor pagination,
chunked uploads, per-token rate limits, the app-audit gate, and an error
envelope that hides failures inside HTTP 200 responses).

> **Unofficial project.** This is an independent, community-built MCP server. It
> is **not** affiliated with, endorsed by, or sponsored by TikTok or ByteDance
> Ltd. "TikTok" is a trademark of its owner, used here only nominatively to
> identify the service this server connects to. See [Trademark](#trademark).

**Contents:** [Quick demo](#quick-demo) · [Features](#features) ·
[Requirements](#requirements) · [Setup](#setup) ·
[Configure credentials](#configure-credentials) · [Run / debug](#run--debug) ·
[Develop](#develop) · [Tools](#tools) · [Security notes](#security-notes) ·
[Project documentation](#project-documentation) · [Support](#support) ·
[Trademark](#trademark)

_Built and maintained in my own time — if it helps, a
[GitHub Sponsors](https://github.com/sponsors/IvanBBaev) tip keeps it going.
Full [Support](#support) options are near the end._

## Quick demo

The signature move is **safe publishing**: a write tool never mutates on the
first call. Point your MCP client at a TikTok app ([Setup](#setup)), authorize
once (`npx tiktok-mcp-ai login`), and ask:

**1. "Post this clip — but show me exactly what will happen first."** The model
calls `tiktok_post_video` **without** a `plan_id`. Nothing is posted: the result
is a full, human-readable **preview** — the resolved creator identity, the
privacy level, every flag, the chunk plan for the upload, the exact upstream
request that would be sent — plus a single-use `plan_id` valid for 10 minutes:

```jsonc
// tiktok_post_video  — preview (no plan_id ⇒ nothing is posted)
{
  "source": "file",
  "file_path": "clips/launch-teaser.mp4",
  "post_info": {
    "title": "Launch day! #buildinpublic",
    "privacy_level": "PUBLIC_TO_EVERYONE",
  },
}
```

**2. "Looks right — do it."** The model calls the **same tool again with the
`plan_id`** from the preview. The payload is re-resolved through the identical
code path, its SHA-256 digest is compared against the plan, the plan is consumed
atomically, and only then is the upload dispatched — so a retry can never
double-post, and nothing but the previewed payload can ever run:

```jsonc
// tiktok_post_video  — execute (the plan_id selects execution)
{
  "source": "file",
  "file_path": "clips/launch-teaser.mp4",
  "post_info": {
    "title": "Launch day! #buildinpublic",
    "privacy_level": "PUBLIC_TO_EVERYONE",
  },
  "plan_id": "plan_9f2c7b1e4a6d0c83f5b2e19a7d4c6f80",
}
```

**3. "Did anything actually post?"** Every attempt — intent before the request,
outcome after — is written to a local append-only journal. Read it back with a
tool, no matter which client made the post:

```bash
npx tiktok-mcp-ai doctor   # among other checks: reconciles the publish journal
```

All read tools are safe to call anytime; the four write tools are the only ones
gated by plan-then-execute, and they return the `publish_id` immediately so the
model can poll `tiktok_get_publish_status` for the terminal state.

## Features

- Full **Display API** reads: the authorized creator's public profile
  (`tiktok_get_user_info`) and their own posted videos with cursor pagination
  (`tiktok_list_videos`, `tiktok_query_videos`) — minimal default field sets to
  keep results token-cheap.
- Full **Content Posting API**: publish a video directly (`tiktok_post_video`),
  upload a video to the creator's inbox as a draft
  (`tiktok_upload_video_draft`), and the photo-carousel equivalents
  (`tiktok_post_photos`, `tiktok_upload_photos_draft`) — from a confined local
  directory (`FILE_UPLOAD`, chunked) or a portal-verified URL (`PULL_FROM_URL`).
- **Plan-then-execute write safety** (the headline feature): there is no `apply`
  boolean. A publish call **without** a `plan_id` validates everything and
  returns a non-mutating preview plus a single-use `plan_id`; calling again with
  that token executes **exactly** the previewed payload. The token is random
  (never payload-derived), bound to a SHA-256 digest of the fully resolved
  request, TTL-limited (10 min), and consumed before the upload — so an injected
  instruction cannot fabricate one and a retry cannot double-post.
- **Append-only publish journal**: a write-ahead `journal.ndjson` records an
  intent (fsync'd) before every publish and an outcome after — a durable audit
  trail of "did it post?" that survives crashes, readable via
  `tiktok_list_publish_journal`. A same-payload duplicate within 10 minutes is
  refused (`possible_duplicate`) unless you pass `force`.
- **OAuth 2.0 (Login Kit) with PKCE**: a one-time interactive
  `npx tiktok-mcp-ai login` stores a refresh token — never a password. TikTok's
  hex `code_challenge` deviation from RFC 7636 is handled correctly.
- **Multi-account profiles**: one TikTok app, many creator accounts
  (`TT_PROFILE_<NAME>_*`); an optional `account` argument routes a single call
  via `AsyncLocalStorage`, so parallel calls with different accounts never bleed.
- **Tool packages**: load only the groups you need via `TT_TOOL_PACKAGES`
  (default profile `core` = all reads; `all` enables the write tools too).
- Least-privilege controls: package deny/read-only lists (`TT_PACKAGES_DENY`,
  `TT_PACKAGES_READONLY`) and a write-mode switch (`TT_WRITE_MODE` =
  `plan` | `apply` | `deny`). Login scopes are derived least-privilege from the
  enabled packages.
- **Egress allowlist**: the process talks only to `open.tiktokapis.com`, the
  media-upload hosts (`open-upload.tiktokapis.com` and the anchored regional
  `upload.<region>.tiktokapis.com` pattern), and `www.tiktok.com` for the OAuth
  authorize redirect — matched dot-anchored on the parsed hostname, https/443
  only, with `redirect: "error"`. Nothing else is reachable.
- Resilience: per-request timeout, a three-class retry matrix (reads retried
  with backoff and `Retry-After`; publish inits **never** retried; chunk PUTs
  replay-safe by byte range), a per-host concurrency semaphore, and a local
  publish-rate token bucket (6/min per profile, matching TikTok).
- MCP **tool annotations** (all four hints on every tool), structured error
  payloads written for the model, and **structured logging on stderr only** —
  stdout stays pure JSON-RPC.
- Credentials in a local env file (`TT_ENV_FILE`, else the XDG/`%LOCALAPPDATA%`
  config dir), written owner-only (`0600`) with atomic, comment-preserving
  rewrites; no secret ever enters a log, a tool result, or the journal.

## Requirements

- Node.js **≥ 22** (enforced: `engines` + a runtime guard with a clear message;
  the project targets the version in `.nvmrc`, which pins 24). The published
  launcher performs the same guard in CommonJS, so an ancient Node prints a
  readable message instead of a parse error.
- A **TikTok developer app** (client key + secret) from the
  [TikTok Developer Portal](https://developers.tiktok.com), with Login Kit and
  the products you need enabled (Display API for reads, Content Posting API for
  publishing).
- Scopes granted by the end user at login: `user.info.basic` and `video.list`
  for reads; `video.publish` (direct post) and/or `video.upload` (draft) for
  publishing.
- **Publishing caveat (upstream platform rule):** until the TikTok app passes
  TikTok's audit, all posts are forced to `SELF_ONLY` visibility and at most 5
  distinct users may post per 24 hours. This server **honors** the gate — it
  offers exactly the privacy levels `creator_info` returns and explains the
  restriction in errors, never circumvents it.

## Setup

From source (for development):

```bash
npm install
npm run build
```

Or run the published package directly, without cloning:

```bash
npx tiktok-mcp-ai
```

Register it with an MCP client (Claude Desktop, VS Code Chat, the Inspector…) by
pointing the server command at `npx`. The credentials go in the `env` block; the
client key and secret are the only required values:

```json
{
  "mcpServers": {
    "tiktok": {
      "command": "npx",
      "args": ["-y", "tiktok-mcp-ai"],
      "env": {
        "TT_CLIENT_KEY": "…",
        "TT_CLIENT_SECRET": "…",
        "TT_MEDIA_ROOT": "/path/to/your/media"
      }
    }
  }
}
```

`TT_MEDIA_ROOT` is only needed to post **local files** (`FILE_UPLOAD`); uploads
are confined to that directory. Omit it for URL-based posting only.

**Claude Code plugin** (zero-config — installs the server wired up):

```bash
/plugin marketplace add IvanBBaev/tiktok-mcp
/plugin install tiktok-mcp-ai
```

**VS Code** — install the **TikTok MCP** extension from the Marketplace
(`code --install-extension ivanbbaev.tiktok-mcp-ai`); it registers the server in
Copilot Chat (agent mode) automatically, no manual `mcp.json`. Source:
[extension/](extension/).

The `client_secret` and the user tokens are read from
`~/.config/tiktok-mcp-ai/.env` (POSIX) or `%LOCALAPPDATA%\tiktok-mcp-ai\.env`
(Windows), or from real environment variables — see below.

### Quickstart

Two required variables identify your TikTok app; everything else is optional
tuning. Set them (in the env file or the real environment), then authorize the
account you want to act as:

```dotenv
TT_CLIENT_KEY=your-app-client-key
TT_CLIENT_SECRET=your-app-client-secret
```

```bash
# one-time interactive authorization (opens the browser, loopback redirect)
npx tiktok-mcp-ai login

# verify everything is wired
npx tiktok-mcp-ai doctor
```

`login` stores a **refresh token** (never a password) in the env file; the
server then runs non-interactively. See the full
[Environment variables](#environment-variables) reference for the rest.

### Verify your setup

Once the two variables are set and you have run `login`, confirm the connection
before you start:

```bash
npx tiktok-mcp-ai doctor
```

`doctor` is an offline + online health check: it locates the env file, confirms
the client key is present, checks token validity and expiry, makes one
`user/info` probe, compares granted scopes against the configured packages, and
reconciles the publish journal. It exits non-zero on hard failures, so it also
works as a CI/readiness check. From inside a session you can also call the
`tiktok_get_auth_status` tool to see which profiles are authorized, their
granted scopes, and token freshness — without exposing any secret.

## Configure credentials

TikTok uses OAuth 2.0 (Login Kit) with **user access tokens** — there is no
password or API-key mode. App-level credentials
(`TT_CLIENT_KEY` / `TT_CLIENT_SECRET`) identify your developer app; user tokens
(obtained by `login`) identify the account you act as.

The env file is resolved in this order: `TT_ENV_FILE`, then
`$XDG_CONFIG_HOME/tiktok-mcp-ai/.env` (falling back to
`~/.config/tiktok-mcp-ai/.env`) on POSIX, or `%LOCALAPPDATA%\tiktok-mcp-ai\.env`
on Windows. A global/`npx` install therefore writes to your user config rather
than into `node_modules`. Real environment variables always take precedence over
the file. The resolved path is both the read source and the write target; the
publish journal and the env-file lock live beside it.

### OAuth 2.0 (Authorization Code + PKCE) — the only auth method

Register a **loopback redirect URI** on your app in the developer portal — the
wildcard-port form, trailing slash mandatory:

```
http://127.0.0.1:*/callback/
```

Set `TT_CLIENT_KEY` and `TT_CLIENT_SECRET`, then run the one-time interactive
login:

```bash
npx tiktok-mcp-ai login
```

It opens the browser at `https://www.tiktok.com/v2/auth/authorize/`, you
approve, and the obtained **refresh token** (plus `access_token`, `open_id`,
granted `scope`, and absolute expiries) is stored in your env file. The server
then runs non-interactively (refresh-token grant) — **no password is ever
stored**. PKCE is always used; TikTok requires the `code_challenge` to be the
**lowercase-hex** encoding of `SHA-256(verifier)` (a deliberate deviation from
RFC 7636's base64url), which this server implements directly — a stock PKCE
library would silently produce base64url and every exchange would fail.

> TikTok users can **deselect scopes** on the consent screen — a partial grant
> is normal. `login` prints granted-vs-requested scopes; tools whose scopes are
> missing are marked `[UNAVAILABLE: …]` in the session and become available
> after a re-login that requests them.

`login` and revocation are CLI subcommands, never MCP tools — the OAuth dance
needs a browser and a listener, and no MCP tool ever receives or returns token
material.

| Command | What it does |
| ------- | ------------ |
| `npx tiktok-mcp-ai login` | Interactive OAuth authorization-code + PKCE via a single-accept loopback listener; stores the refresh token for the active profile. Accepts `--profile <name>` and `--scopes <csv>`; falls back to manual paste on a headless host. |
| `npx tiktok-mcp-ai login --revoke` | Revokes the profile's tokens and clears them from the env file — but **keeps the publish journal** (the only audit trail for "did it post?"). Add `--purge-journal` to also delete journal data. |

### Multi-account profiles

One TikTok app can serve many accounts. The bare token keys
(`TT_ACCESS_TOKEN`, `TT_REFRESH_TOKEN`, `TT_OPEN_ID`, …) are the `default`
profile; extra accounts use `TT_PROFILE_<NAME>_*` with the same keys.
`TT_ACTIVE_PROFILE` selects the default, and every tool accepts an optional
`account: "brand"` argument to run one call against another profile — the
selection travels via `AsyncLocalStorage`, so parallel calls with different
accounts cannot bleed into each other. Authorize an extra account with
`npx tiktok-mcp-ai login --profile brand`.

### Environment variables

All settings are read from the env file (or the real process environment, which
takes precedence). Only the first two are required; the rest are optional tuning
knobs. See [.env.example](.env.example) for a template and
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the complete reference
(including the env-file lock, journal, and per-chunk upload knobs).

| Variable | Required | Default | Description |
| -------- | :------: | ------- | ----------- |
| `TT_CLIENT_KEY` | yes | — | TikTok app client key. |
| `TT_CLIENT_SECRET` | yes | — | TikTok app client secret. Never logged or returned by any tool. |
| `TT_MEDIA_ROOT` | no | — (fail-closed) | The only directory `FILE_UPLOAD` tools may read media from; unset ⇒ `source:"file"` is rejected locally. Choose a dedicated media folder, never `$HOME`. |
| `TT_VERIFIED_URL_PREFIXES` | no | — | Comma-separated `https://` prefixes verified in the developer portal, so the plan phase can catch unverifiable `PULL_FROM_URL` domains early. **Advisory only** — TikTok's portal is the source of truth. |
| `TT_TOOL_PACKAGES` | no | `core` | Comma/space list of packages (`auth`, `user`, `video`, `publish`, `publish-write`) or a profile: `core` = all reads, `all` = everything. |
| `TT_PACKAGES_DENY` | no | — | Packages forced off regardless of `TT_TOOL_PACKAGES` (deny wins). |
| `TT_PACKAGES_READONLY` | no | `0` | `1` registers only read-only tools (unregisters `publish-write`). |
| `TT_WRITE_MODE` | no | `plan` | `plan` (default — preview then `plan_id`), `apply` (**trusted automation only: no injection resistance**), or `deny` (the `publish-write` package is not registered). |
| `TT_PLAN_TTL_S` | no | `600` | Lifetime of a minted `plan_id`; an expired plan fails with `plan_not_found` and needs a fresh preview. |
| `TT_PLAN_MAX_OUTSTANDING` | no | `32` | Cap on the in-memory plan store; oldest plans evicted first. |
| `TT_DEFAULT_AIGC_LABEL` | no | `1` | Default for the AIGC (`is_aigc`) label on posts — on, because MCP-driven content is typically AI-assisted. |
| `TT_ACTIVE_PROFILE` | no | `DEFAULT` | Profile used when a tool call has no `account` argument. |
| `TT_LOCK_PROFILE` | no | — | Pin the session to one profile: an explicit `account` naming any other profile fails locally (no network spent). |
| `TT_REDIRECT_PORT` | no | — (ephemeral) | Optional fixed-port pin for the `login` loopback server; unset binds `127.0.0.1:0`. |
| `TT_LOGIN_SCOPES` | no | derived | Scopes requested by `login`; the default is least-privilege from `TT_TOOL_PACKAGES`. Set explicitly to override. |
| `TT_TOKEN_REFRESH_SKEW_S` | no | `1800` | Refresh the access token this many seconds before its expiry. |
| `TT_TRANSPORT` | no | `stdio` | `stdio` (default) or `http` (Streamable HTTP for remote/agent clients). |
| `TT_HTTP_HOST` | no | `127.0.0.1` | Bind host for the http transport (loopback by default). |
| `TT_PORT` | no | `3000` | TCP port for the http transport. |
| `TT_HTTP_TOKEN` | no | — | Bearer token, **required whenever `TT_TRANSPORT=http`** (loopback included); compared constant-time. The server refuses to start over http without it. |
| `TT_HTTP_INSECURE` | no | `0` | `1` acknowledges a non-loopback bind without TLS termination in front. |
| `TT_TIMEOUT_MS` | no | `30000` | Per-request timeout (ms). |
| `TT_MAX_RETRIES` | no | `3` | Retry cap for the idempotent **read** class (429/5xx/network, honoring `Retry-After`). Publish inits are never retried. |
| `TT_MAX_CONCURRENT` | no | `4` | Per-host concurrency semaphore. |
| `TT_PUBLISH_RPM` | no | `6` | Local token bucket for publish inits, per profile — an empty bucket rejects locally with an absolute `retry_at`. |
| `TT_FETCH_ALL_CAP` | no | `200` | Item cap for `fetch_all` pagination; a capped read always surfaces `truncated`. |
| `TT_RESULT_CHAR_BUDGET` | no | `25000` | Truncation budget for tool results (always valid JSON). |
| `TT_PRETTY_JSON` | no | `0` | `1` pretty-prints results (costs tokens). |
| `TT_LOG_LEVEL` | no | `info` | stderr log level: `error`, `warn`, `info`, `debug` (never logs bodies with secrets). |
| `TT_ENV_FILE` | no | — | Explicit path to the env file to read/write; the journal and lock follow it. |
| `TT_PROFILE_<NAME>_*` | no | — | The token keys for an extra account profile (`TT_PROFILE_BRAND_ACCESS_TOKEN`, …). Written by `login --profile <name>`. |

Token values (`TT_ACCESS_TOKEN`, `TT_REFRESH_TOKEN`, `TT_OPEN_ID`, `TT_SCOPES`,
`TT_TOKEN_EXPIRES_AT`, `TT_REFRESH_EXPIRES_AT`, and their profile-prefixed forms)
are **written by `login` / refresh** — do not set them by hand.

### Access policy

Access to the publishing surface is controlled on the **package axis** — because
the write tools are a distinct risk class from the reads. Guard it three ways,
independently:

| Control | Effect |
| ------- | ------ |
| `TT_TOOL_PACKAGES` | Which packages are registered at all. `core` (default) = the read packages `auth,user,video,publish`; `all` adds `publish-write`. |
| `TT_PACKAGES_DENY` | Packages forced off even if enabled above (deny always wins). |
| `TT_PACKAGES_READONLY=1` / `TT_WRITE_MODE=deny` | Two ways to drop the write tools: `PACKAGES_READONLY` registers only read-only tools; `WRITE_MODE=deny` unregisters the `publish-write` package specifically. |

A read-only deployment (`core`, the default) never even registers the four write
tools, and its derived login scopes never carry posting authority — so a leaked
read token cannot post. See [Security notes](#security-notes) for the full model.

## Run / debug

- **VS Code**: install the **TikTok MCP** extension (above), or start the server
  from a `.vscode/mcp.json` registration and use it from Chat.
- **MCP Inspector**: point it at `npx -y tiktok-mcp-ai`.
- **Directly**: `npm start` (or `node build/src/index.js`).

### Command-line interface

The published `tiktok-mcp-ai` binary (run it directly, or via
`npx tiktok-mcp-ai`) has three invocations. All connection settings come from
environment variables / the env file (see
[Environment variables](#environment-variables)); the subcommands operate on the
active profile (`TT_ACTIVE_PROFILE`, or `--profile <name>`).

| Command | What it does | Exit codes |
| ------- | ------------ | ---------- |
| `tiktok-mcp-ai` | Starts the MCP server. The transport (`stdio` default, or `http`) is chosen by `TT_TRANSPORT`; runs until `SIGINT`/`SIGTERM`. | `0` clean shutdown · `1` fatal startup error |
| `tiktok-mcp-ai login` | One-time OAuth authorization-code + PKCE login: opens the browser, captures the loopback redirect (or manual paste), stores a refresh token. `--revoke` disconnects an account; `--purge-journal` also deletes journal data. | `0` success · `1` login/revoke failed |
| `tiktok-mcp-ai doctor` | Offline + online health check: env file located, client key present, token validity/expiry, one `user/info` probe, granted scopes vs. enabled packages, journal reconciliation. | `0` healthy · non-zero on hard failures |

## Develop

```bash
npm run check       # full gate: typecheck, lint, format, build, tests, coverage, sync
npm test            # unit tests only (node:test; needs a prior npm run build)
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (flat config + typescript-eslint)
npm run format      # format with Prettier
npm run coverage    # tests under c8 + the per-area floors in scripts/coverage-floors.json
npm run sync        # verify the generated artifacts (README table, .env.example, …)
npm run sync:write  # regenerate them after changing a tool, a setting or `files`
```

The layered architecture (`core ← api ← mcp ← tools`) is enforced at lint time:
tool code never touches HTTP or auth directly, network access flows through
`api/` only, and redaction lives in `core/redact` below every sink. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module contract and
[CONTRIBUTING.md](CONTRIBUTING.md) for the conventions (one commit per task,
tests ship with the change, the generated README tools table).

## Tools

<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->

_This table is generated from the tool registrations — edit the tool
definitions in `src/tools/`, then run `npm run docs:readme`. Descriptions are
summarized to their first sentence; the full text an agent sees is in
[docs/tool-manifest.json](docs/tool-manifest.json)._

| Package | Tool | Read-only | Description |
| ------- | ---- | :-------: | ----------- |
| `auth` | `tiktok_get_auth_status` | yes | Report authentication status for the configured TikTok profile(s): granted scopes, token expiry, and which tool packages are usable per profile. |
| `user` | `tiktok_get_user_info` | yes | Fetch the authenticated TikTok user's profile: display name, avatar, bio, and counts (followers, following, likes, videos). |
| `video` | `tiktok_list_videos` | yes | List the authenticated user's PUBLIC videos, newest first, up to 20 per page. |
| `video` | `tiktok_query_videos` | yes | Fetch full details for up to 20 specific videos by id. |
| `publish` | `tiktok_get_creator_info` | yes | Fetch the creator's live posting state: nickname, the privacy_level options currently available, whether comments/duets/stitch are disabled account-wide, and the maximum allowed video duration. |
| `publish` | `tiktok_get_publish_status` | yes | Check — and by default briefly wait on — the status of a publish attempt by publish_id. |
| `publish` | `tiktok_list_publish_journal` | yes | Read this server's local, append-only journal of publish attempts: timestamp, account, tool, title excerpt, publish_id, and outcome. |
| `publish-write` | `tiktok_post_video` | no | Post a video DIRECTLY to the authenticated account's TikTok profile — it goes live without further user action once TikTok finishes processing. |
| `publish-write` | `tiktok_upload_video_draft` | no | Upload a video to the user's TikTok INBOX as a draft — the user must open the TikTok app notification, edit, and publish it themselves; nothing goes live from this call. |
| `publish-write` | `tiktok_post_photos` | no | Post a photo carousel DIRECTLY to the user's TikTok profile — it goes live once processing completes. |
| `publish-write` | `tiktok_upload_photos_draft` | no | Send a photo carousel to the user's TikTok INBOX as a draft — the user finishes and publishes it in the TikTok app; nothing goes live from this call. |

<!-- GENERATED:TOOLS:END -->

The table lists what this version actually registers. The publishing tools —
`tiktok_get_creator_info`, `tiktok_get_publish_status`,
`tiktok_list_publish_journal` and the four `publish-write` tools — are designed
and specified in [docs/TOOLS.md](docs/TOOLS.md) but are not registered yet; the
table grows itself as they land, since it is generated from the registry rather
than written by hand.

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) so clients can apply the right confirmation
UX. Read tools are safe to call anytime; the four `publish-write` tools are the
only writes, gated by plan-then-execute.

### Tool packages

Tools are grouped into packages so you can expose only what a given client needs
(fewer tools keep the model focused). Set `TT_TOOL_PACKAGES` to a comma/space
separated list of profiles or package names:

- `core` (default) — `auth`, `user`, `video`, `publish` (all the read tools,
  including the read-only publishing context: creator info, publish status, and
  the journal reader).
- `all` — `core` plus `publish-write` (the four write tools).
- Individual packages: `auth`, `user`, `video`, `publish`, `publish-write`.

`TT_PACKAGES_DENY` removes packages even if enabled; `TT_PACKAGES_READONLY=1`
forces the `publish-write` package off. Packages group by **risk class**, so the
write tools can be dropped in one move.

```dotenv
# Read-only deployment: profile, videos and publishing context — no write tools
TT_TOOL_PACKAGES=core
```

### The plan-then-execute contract

The four `publish-write` tools never mutate on the first call:

1. **Preview** — call the tool **without** a `plan_id`. It runs every *read*
   step for real (the `creator_info` pre-flight on direct-post tools, media
   validation, `TT_MEDIA_ROOT` confinement, URL-domain sanity), makes **no**
   init call, and returns a structured preview: creator identity, resolved
   privacy level, all flags, the chunk plan, the exact upstream request, and a
   fresh single-use `plan_id` (`plan_` + 32 hex chars, 10-minute TTL). A
   direct-post call missing `privacy_level` returns `mode:"plan_incomplete"` and
   **no token is minted**.
2. **Execute** — call the **same tool again with that `plan_id`**. The payload
   is re-resolved through the identical code path, a SHA-256 digest is compared
   (`timingSafeEqual`) against the plan, the duplicate guard runs, and the plan
   is **consumed atomically before** the init is dispatched — so an MCP-client
   retry fails with `plan_not_found` instead of double-posting. A write returns
   the `publish_id` immediately (`wait_for_completion` defaults to `false`).
3. **Poll** — call `tiktok_get_publish_status` with the `publish_id` for the
   bounded wait to a terminal state.

`force: true` overrides **only** the duplicate guard, never the digest check —
there is no way to execute a payload other than the one previewed.

## Security notes

- The env file is git-ignored and written **owner-only (`0600`)** on POSIX (a
  no-op on Windows, where `%LOCALAPPDATA%` profile ACLs are the boundary) — it
  holds the client secret and refresh tokens. Writes are atomic (0600 temp file,
  fsync, rename) and comment-preserving.
- **No secret ever leaves the process** through a sink: not stdout (reserved for
  the JSON-RPC protocol), not stderr logs, not the MCP log mirror, not tool
  results, error messages, plan previews (`Authorization: Bearer ***`), the
  journal, or `doctor` output. Redaction is a core primitive below every sink,
  allowlist-based and default-deny; tokens, the client secret, and the
  `upload_token` are registered as exact values and scrubbed from free text too.
- **Egress is allowlisted.** Data calls go only to `https://open.tiktokapis.com`
  (no override env exists); upload PUTs go only to a TikTok-returned `upload_url`
  whose host must match `open.tiktokapis.com`, `open-upload.tiktokapis.com`, or
  the anchored `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$` — dot-anchored on the
  parsed hostname (bare `endsWith` is banned), https/443 only, no userinfo, with
  `redirect: "error"` so a 3xx to any other host is never followed. Upload PUTs
  carry **no** `Authorization` header — the `upload_token` in the URL is the
  session credential, so a redirected upload cannot leak the account token.
- **Local files are confined.** `FILE_UPLOAD` reads only from `TT_MEDIA_ROOT`
  (fail-closed when unset); both sides are `realpath`-canonicalized before a
  containment check, traversal/symlink-escape/device files are rejected, and the
  file's `(size, mtime, dev, ino)` captured at plan time must match at execute
  time (TOCTOU re-validation). The preview shows the resolved absolute path and
  byte size, so the human sees exactly which file would leave the machine.
- **Write safety is the plan-then-execute contract** above: a human-visible
  preview plus a single-use, digest-bound `plan_id`. It defeats single-message
  injection (an injected instruction cannot know an unissued `plan_id`) and binds
  execution to exactly the previewed payload. Honest limit: it does **not** prove
  a human sat between the two calls — a model can chain preview → execute in one
  turn; the digest binding caps the blast radius to that one payload.
- **Least-privilege scopes.** Login scopes are derived from the enabled
  packages, so a read-only (`core`) deployment never holds a refresh token
  carrying posting authority; publishing requires an explicit re-login opting
  into `video.publish` / `video.upload`.
- **HTTP transport** is off by default (stdio has no listening socket). When
  enabled it binds loopback, validates `Origin`/`Host` even on loopback
  (DNS-rebinding defense), and **requires** `TT_HTTP_TOKEN` (constant-time bearer
  check); a non-loopback bind additionally needs TLS in front or an explicit
  `TT_HTTP_INSECURE=1`.
- **Platform compliance.** Only official APIs — no scraping, no reverse-
  engineered endpoints. The unaudited-client rules (SELF_ONLY, 5-user cap) are
  honored, not circumvented; the AIGC label defaults on; CDN URLs are documented
  as ephemeral; the server keeps no database — the env file and the publish
  journal are the only state.

See [SECURITY.md](SECURITY.md) for the reporting channel and the hardened
defaults, and [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

## Project documentation

| Document | Contents |
| -------- | -------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layered architecture, bootstrap, transport, tool-spec pattern, manifest & registration, HTTP client and retry matrix, write safety (plan store, journal), pagination, redaction, error taxonomy |
| [docs/TOOLS.md](docs/TOOLS.md) | Complete tool catalog with input/output schemas, annotations, the plan/execute contract, the error catalog and the hints vocabulary |
| [docs/AUTH.md](docs/AUTH.md) | OAuth flows, the PKCE hex deviation, token lifecycle and refresh, revocation, multi-account profiles, the scope model |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every `TT_*` variable with defaults; env-file resolution (POSIX/Windows), permissions, profiles, the env-file lock and journal knobs |
| [docs/SECURITY.md](docs/SECURITY.md) | Design threat model: assets, adversaries, secret handling, redaction, egress control, write safety, platform-compliance posture |
| [docs/TIKTOK-API.md](docs/TIKTOK-API.md) | The upstream API landscape: endpoints, scopes, rate limits, the audit gate, media constraints, the chunk algorithm, the error envelope |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy: `node:test`, fetch mocking, the manifest snapshot, coverage gates, the CI matrix |
| [docs/CORNER-CASES.md](docs/CORNER-CASES.md) | Catalog of corner cases (CC-*) every implementation work package must test |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Frozen inter-module interfaces for parallel implementation |
| [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) | Work packages, dependency spine, closed decision points, the road to v1.0 |
| [docs/TASK-BREAKDOWN.md](docs/TASK-BREAKDOWN.md) | Wave/task decomposition for parallel development |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Short phase outline and out-of-scope list |
| [CONTRIBUTING.md](CONTRIBUTING.md) / [SECURITY.md](SECURITY.md) | Dev setup, gates and conventions / security model and vulnerability reporting |
| [WORKLOG.md](WORKLOG.md) / [CHANGELOG.md](CHANGELOG.md) | Detailed work journal / user-facing changelog |

## Support

This project is built and maintained in my own time. If it saves you or your
team time, please consider supporting its continued development — sponsorship
directly funds new features, bug fixes and keeping pace with TikTok's API
surface.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee taken out (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; it also
  accepts **PayPal**, so it's the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)

## Trademark

**Trademark & affiliation.** `tiktok-mcp-ai` is an independent, community-built
open-source project. It is **not** affiliated with, endorsed by, sponsored by,
or in any way officially connected to TikTok, ByteDance Ltd., or any of their
subsidiaries or affiliates.

"TikTok" and all related names, marks, logos, and brand features are trademarks
of ByteDance Ltd. and its affiliates. They are used in this project only
**nominatively** — to identify the third-party service that this MCP server
connects to — as permitted by nominative fair use. No sponsorship or endorsement
is implied.

This project accesses TikTok exclusively through the official TikTok for
Developers APIs and is subject to TikTok's Developer Terms of Service and
platform policies. You are responsible for your own use of the TikTok APIs and
for complying with all applicable TikTok terms. The software is provided "as is",
without warranty of any kind.
