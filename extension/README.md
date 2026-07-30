# TikTok MCP — VS Code extension

Drive a **TikTok** creator account from VS Code **Copilot Chat (agent mode)**.
This extension registers the [`tiktok-mcp-ai`](https://www.npmjs.com/package/tiktok-mcp-ai)
MCP server automatically — install it and the TikTok tools appear in Chat, with
no manual `.vscode/mcp.json`.

<!-- TODO(owner): before running `vsce publish`, add a 128×128 PNG at
     `extension/icon.png` (referenced by `package.json`). It is intentionally
     not committed here — the extension will not package/publish without it. -->

## What you get

11 tools over the official [TikTok for Developers](https://developers.tiktok.com)
APIs — the **Display API** (read a creator's profile and videos) and the
**Content Posting API** (publish videos and photo carousels), plus:

- **Plan-then-execute write safety** — the four write tools never mutate on the
  first call (`TT_WRITE_MODE=plan` by default): they return a non-mutating
  preview plus a single-use `plan_id`. Call again with that `plan_id` to publish
  exactly what you previewed. Every attempt is recorded in a local, append-only
  publish journal.
- **OAuth 2.0 (PKCE) user authorization** — authorize one or more creator
  accounts with `npx tiktok-mcp-ai login`; short-lived (24-hour) tokens are
  refreshed automatically, and multi-account profiles let you switch creators.
- **Least-privilege tool surface** and **token-efficient results** — the default
  `TT_TOOL_PACKAGES=core` exposes only read tools (auth status, profile, videos,
  publishing context); opt into the write tools explicitly.

## Setup

1. Install this extension. The **TikTok** MCP server is registered for Copilot
   Chat (it runs via `npx -y tiktok-mcp-ai`, so Node.js 22+ is required).
2. Provide your TikTok app credentials in an env file at
   `~/.config/tiktok-mcp-ai/.env`:
   ```dotenv
   TT_CLIENT_KEY=your-tiktok-app-client-key
   TT_CLIENT_SECRET=your-tiktok-app-client-secret
   # optional — set only to post local files (confines FILE_UPLOAD to this directory):
   TT_MEDIA_ROOT=/path/to/your/media
   ```
   Then authorize a creator account (OAuth 2.0 authorization-code + PKCE via a
   loopback redirect): `npx tiktok-mcp-ai login`.
3. Open Copilot Chat, switch to **agent mode**, and ask — e.g. _"Using TikTok,
   show my profile and list my 5 most recent videos."_

Start read-only and safe: keep the default `TT_WRITE_MODE=plan` and the default
`TT_TOOL_PACKAGES=core` (read-only tools) until you trust the workflow.

## After install

MCP tools are only surfaced in **agent mode**, so open Copilot Chat and switch
its mode selector to **Agent** — the `tiktok_*` tools become available there.
To confirm everything is wired up, ask the model to run an authorization check,
e.g. _"Run tiktok_get_auth_status and show me the result."_

<!-- TODO(owner): capture a screenshot of the Copilot Chat agent-mode selector,
     add it to the extension package, and uncomment the line below:
![Copilot Chat mode selector switched to Agent](docs/agent-mode.png) -->

## Links

- Documentation: https://ivanbbaev.github.io/tiktok-mcp/
- Source / issues: https://github.com/IvanBBaev/tiktok-mcp
- npm package: https://www.npmjs.com/package/tiktok-mcp-ai

MIT licensed.

## Trademark

> **Trademark & affiliation.** `tiktok-mcp-ai` is an independent, community-built
> open-source project. It is **not** affiliated with, endorsed by, sponsored by,
> or in any way officially connected to TikTok, ByteDance Ltd., or any of their
> subsidiaries or affiliates.
>
> "TikTok" and all related names, marks, logos, and brand features are trademarks
> of ByteDance Ltd. and its affiliates. They are used in this project only
> **nominatively** — to identify the third-party service that this MCP server
> connects to — as permitted by nominative fair use. No sponsorship or endorsement
> is implied.
>
> This project accesses TikTok exclusively through the official TikTok for
> Developers APIs and is subject to TikTok's Developer Terms of Service and
> platform policies. You are responsible for your own use of the TikTok APIs and
> for complying with all applicable TikTok terms. The software is provided "as is",
> without warranty of any kind.
