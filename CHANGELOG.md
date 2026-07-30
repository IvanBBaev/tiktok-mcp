# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For the
detailed development journal see [WORKLOG.md](WORKLOG.md).

## [Unreleased]

Initial pre-release development. The design corpus under `docs/` is complete and
the public project surface is being assembled ahead of the first tagged release;
the runtime under `src/` is under active implementation. Nothing has shipped to
npm yet.

### Added

- Project scope: an unofficial MCP server for TikTok over the official Display
  API (reads) and Content Posting API (publishing), with **11 tools** across the
  `auth`, `user`, `video`, `publish` and `publish-write` packages.
- **Plan-then-execute write safety** for all four publishing tools — a call
  without a `plan_id` previews and mints a single-use, digest-bound token; a call
  with it executes exactly the previewed payload.
- **Append-only publish journal** (`journal.ndjson`): a write-ahead intent record
  before each publish and an outcome after, readable via
  `tiktok_list_publish_journal`.
- **OAuth 2.0 (Login Kit) with PKCE**, including TikTok's lowercase-hex
  `code_challenge` deviation from RFC 7636, a loopback-redirect `login`, token
  refresh, and revocation.
- **Multi-account profiles** (`TT_PROFILE_<NAME>_*`) with per-call `account`
  routing via `AsyncLocalStorage`.
- **Tool packages** and least-privilege access policy (`TT_TOOL_PACKAGES`,
  `TT_PACKAGES_DENY`, `TT_PACKAGES_READONLY`, `TT_WRITE_MODE`).
- **Egress allowlist** (data host, anchored upload hosts, OAuth authorize host),
  a three-class HTTP retry matrix, per-host concurrency limiting, and a local
  publish-rate token bucket.
- `stdio` transport (default) and an opt-in Streamable HTTP transport requiring a
  bearer token with `Origin`/`Host` validation.
- CLI subcommands `login` and `doctor`; token-efficient, size-budgeted tool
  results; secret redaction below every sink.
- Public project files: README, this changelog, `CONTRIBUTING.md`, `SECURITY.md`,
  `.env.example`, `.gitattributes`, and the design docs under `docs/`.

[Unreleased]: https://github.com/IvanBBaev/tiktok-mcp/commits/main
