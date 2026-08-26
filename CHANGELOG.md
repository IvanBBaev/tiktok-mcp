# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). What
counts as a breaking change, and how long a deprecated tool or environment
variable keeps working, is written down in
[docs/SECURITY.md § Compatibility and deprecation policy](docs/SECURITY.md#compatibility-and-deprecation-policy).

Every entry below is user-visible. Refactors, test-only changes and internal
plumbing stay in the commit history where they belong.

## [Unreleased]

## [0.7.0] - 2026-08-26

First published release. The version reflects how much of the planned surface is
built and exercised, not a promise of stability: it is pre-1.0, so a minor bump
may still break a contract — see
[docs/SECURITY.md § Compatibility and deprecation policy](docs/SECURITY.md#compatibility-and-deprecation-policy).

### Added

- **11 tools** across the `auth`, `user`, `video`, `publish` and `publish-write`
  packages: `tiktok_get_auth_status`, `tiktok_get_user_info`,
  `tiktok_list_videos`, `tiktok_query_videos`, `tiktok_get_creator_info`,
  `tiktok_get_publish_status`, `tiktok_list_publish_journal`,
  `tiktok_post_video`, `tiktok_upload_video_draft`, `tiktok_post_photos` and
  `tiktok_upload_photos_draft`.
- **Plan-then-execute write safety** on all four publishing tools: a call
  without a `plan_id` previews and mints a single-use, digest-bound token, and a
  call with one executes exactly the previewed payload — or nothing.
  `TT_WRITE_MODE` (`plan` / `apply` / `deny`) sets how strict that is.
- **Append-only publish journal** (`journal.ndjson`): a write-ahead intent
  record before each publish and an outcome after it, readable through
  `tiktok_list_publish_journal`, with duplicate detection across restarts.
- **OAuth 2.0 (Login Kit) with PKCE**, including TikTok's lowercase-hex
  `code_challenge` deviation from RFC 7636, a single-accept loopback redirect,
  single-flight token refresh and revocation.
- **CLI**: `tiktok-mcp-ai login` (least-privilege scopes derived from the
  enabled tool packages), `login --revoke [--purge-journal]`, and
  `tiktok-mcp-ai doctor`, which reports configuration, token state and file
  permissions with every secret redacted. `doctor --json` prints the whole
  report as one versioned JSON document on stdout — and nothing else, on every
  exit path — so a readiness gate can consume it without scraping rows.
- **npx staleness check** in `doctor`: a copy running from the npx cache warns,
  with the cache-clear command for your platform (`rm -rf ~/.npm/_npx`,
  `%LOCALAPPDATA%\npm-cache\_npx`), because `npm cache clean` does not remove it
  and npx will otherwise keep re-running the version you first tried.
- **Multi-account profiles** (`TT_PROFILE_<NAME>_*`) with per-call `account`
  routing, and `TT_LOCK_PROFILE` for deployments that must not switch accounts.
- **Tool packages as an access policy**: `TT_TOOL_PACKAGES`,
  `TT_PACKAGES_DENY`, `TT_PACKAGES_READONLY` — a read-only deployment never
  holds a token carrying posting authority.
- **Resumable chunked uploads** for `FILE_UPLOAD` video posting, with local
  files confined to `TT_MEDIA_ROOT`, and `PULL_FROM_URL` posting restricted to
  verified URL prefixes.
- **Egress allowlist** (data host, anchored upload hosts, OAuth authorize host),
  a three-class HTTP retry matrix, per-host concurrency limiting and a local
  publish-rate token bucket.
- **Two transports**: stdio by default, and Streamable HTTP under
  `TT_TRANSPORT=http` with one MCP session per connection. The HTTP bind
  requires `TT_HTTP_TOKEN` on every request — including a loopback bind —
  validates `Origin` and `Host` against the bind as a DNS-rebinding defense, and
  refuses to serve off-box without TLS in front of it or an explicit
  `TT_HTTP_INSECURE=1`.
- **Live tool list**: the server watches the credential file and sends
  `notifications/tools/list_changed` when a profile is added, removed or
  re-scoped, so a `login` in another terminal updates the tools an
  already-connected client can see.
- **Credential storage in an env file** written atomically at `0600` under a
  cross-process lock, preserving comments, ordering and line endings on rewrite.
- **Secret redaction below every sink** — logs, tool results and the journal —
  and stdout kept clean for the stdio JSON-RPC stream.
- **Token-efficient results**: a size-budgeted JSON envelope
  (`TT_RESULT_CHAR_BUDGET`) with structured errors and actionable hints.
- Distribution manifests for the MCP registry (`server.json`), Claude Code
  (`.claude-plugin/`) and VS Code (`extension/`), plus the documentation site
  under `docs/`.
- Repo gates: generated README tool table, `.env.example` and
  `docs/tool-manifest.json`, a packed-tarball audit, per-area coverage floors,
  and a CI matrix over Node 22/24/26 on Linux, macOS and Windows.

[Unreleased]: https://github.com/IvanBBaev/tiktok-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/IvanBBaev/tiktok-mcp/releases/tag/v0.7.0
