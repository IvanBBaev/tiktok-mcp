# Copilot instructions — tiktok-mcp-ai server

This is a **Model Context Protocol (MCP) server** written in **TypeScript** that
gives an MCP client a safe, policy-governed tool surface over the official
[TikTok for Developers](https://developers.tiktok.com) APIs: the **Display API**
(read a creator's profile and videos) and the **Content Posting API** (publish
videos and photo carousels). 11 tools in 5 packages, OAuth 2.0 (PKCE) user
authorization, multi-account profiles and plan-then-execute write safety.

## Architecture (4 layers — boundaries are ESLint-enforced)

The dependency direction is strictly **`core ← api ← mcp ← tools`**: a layer may
import only from the layers to its left.

- `src/core/` — platform-agnostic plumbing: the env-file config store, every
  `TT_*` setting, OAuth 2.0 (PKCE) login and 24-hour token refresh, the HTTP
  client (retry matrix, per-token rate limits), the append-only publish journal,
  SSRF/host guards and error handling.
- `src/api/` — one module per TikTok REST area (user, video, creator/publish
  info, content posting), all over mock-testable `fetch`; unwraps TikTok's
  HTTP-200 error envelope into typed results.
- `src/mcp/` — server wiring: the declarative tool registry (a package is a
  plug-in), input-schema plumbing, result shaping and redaction, prompts and
  resources.
- `src/tools/` — the per-package `ToolSpec` definitions consumed by the registry
  (**tools-as-data**: each tool is a plain object, not bespoke wiring).
- `bin/tiktok-mcp-ai.cjs` — the published entry: a Node-version guard that then
  dynamic-imports the ESM server. `src/index.ts` is the server entry (stdio by
  default, Streamable HTTP with `TT_TRANSPORT=http`).

## Tools & packages

- Packages: `auth`, `user`, `video`, `publish` (read-only publishing context)
  and `publish-write` (the four write tools). `TT_TOOL_PACKAGES` default `core` =
  all reads; `all` = everything.
- Read-only tools (`tiktok_get_user_info`, `tiktok_list_videos`, …) are safe to
  call anytime. The four write tools (`tiktok_post_video`,
  `tiktok_upload_video_draft`, `tiktok_post_photos`, `tiktok_upload_photos_draft`)
  are **plan-then-execute**: a call without a `plan_id` never mutates — it returns
  a non-mutating preview plus a single-use `plan_id`; calling again with that
  `plan_id` executes exactly the previewed payload.

## Credentials & policy

- Required env: `TT_CLIENT_KEY`, `TT_CLIENT_SECRET` (secret). Local-file posting
  is confined to `TT_MEDIA_ROOT`. Tokens are written by `login`/refresh — never
  set `TT_ACCESS_TOKEN` / `TT_REFRESH_TOKEN` by hand.
- Never log or echo secrets (client secret, tokens, `TT_HTTP_TOKEN`).
- Writes are **plan-by-default** (`TT_WRITE_MODE` = plan | apply | deny),
  journaled to the append-only publish journal; policy axes: `TT_PACKAGES_DENY`
  and `TT_PACKAGES_READONLY`.
- CLI subcommands (not MCP tools): `login` (OAuth authorization-code + PKCE via a
  loopback redirect; `login --revoke` disconnects an account) and `doctor`
  (health/credential check).

## Conventions

- stdio transport: **never** write to `stdout` (no `console.log`) — structured
  JSON logs go to stderr.
- ES modules with `.js` import specifiers; TypeScript strict +
  `noUncheckedIndexedAccess`.
- Tool input schemas are `zod` raw shapes; handlers must not throw — catch and
  return `{ isError: true }` results.
- Every `TT_*` variable read in `src/` must be documented in
  `docs/CONFIGURATION.md`.

## Build & run

- `npm install`, then **`npm run check`** — the full gate (typecheck + lint +
  format:check + build + test). Run it before finishing any change.
- Node **≥ 22** (`.nvmrc` pins 24).

## SDK references

- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Concepts & guides: https://modelcontextprotocol.io/docs
- TikTok for Developers: https://developers.tiktok.com/doc
