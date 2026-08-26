# Configure an MCP client

Copy-pasteable configuration for the clients people actually use. Everything
here assumes the app credentials are already in place — if not, start with
[docs/SETUP-TIKTOK-APP.md](SETUP-TIKTOK-APP.md).

**Contents:** [Facts that apply to every client](#facts-that-apply-to-every-client) ·
[Which launch command](#which-launch-command) · [Claude Code](#claude-code) ·
[Claude Desktop](#claude-desktop) · [VS Code](#vs-code) · [Cursor](#cursor) ·
[MCP Inspector](#mcp-inspector) · [Confirm the wiring](#confirm-the-wiring) ·
[Where the logs go](#where-the-logs-go)

## Facts that apply to every client

- **Every configuration below uses stdio.** The client starts the server as a
  child process and talks to it over stdin/stdout.
- **stdout belongs to the protocol.** All diagnostics go to stderr. If you wrap
  the server in a script, never let that script print to stdout.
- **Credentials do not belong in the client config.** `TT_CLIENT_KEY`,
  `TT_CLIENT_SECRET` and the tokens live in the env file
  (`~/.config/tiktok-mcp-ai/.env`, or `%LOCALAPPDATA%\tiktok-mcp-ai\.env` on
  Windows), which is written owner-only. An `env` block in a client's JSON works
  — real environment variables take precedence over the file — but that file is
  usually world-readable and often ends up in a dotfiles repo. Put non-secret
  tuning there (`TT_MEDIA_ROOT`, `TT_TOOL_PACKAGES`, `TT_LOG_LEVEL`) and leave
  the secrets in the env file.
- **Authorization happens outside the client.** Tokens never transit an MCP
  tool. Run `npx tiktok-mcp-ai login` in a terminal once; the server picks the
  tokens up from the env file on the next call.
- **Use absolute paths.** A client launched from the desktop does not inherit
  your shell's `PATH`, so `node`, `npx` and `nvm` shims may not resolve. When a
  client fails to start the server with "command not found", give it the
  absolute path to the interpreter (`which node`) and to the entry file.
- **Node 22 or newer.** The launcher checks the version and prints one sentence
  if it is too old, rather than a parse error.
- **Restart the client after editing its config.** Most clients read MCP
  configuration only at startup, and "quit" means quit — not close the window.

## Which launch command

Two forms appear below. Pick one and use it consistently.

| Form | Command | Use it when |
| ---- | ------- | ----------- |
| Published package | `npx -y tiktok-mcp-ai` | The package is installed from npm |
| Local clone | `node /absolute/path/to/tiktok-mcp/build/src/index.js` | You cloned this repository |

The npm package **is not published yet** — `npm view tiktok-mcp-ai` currently
returns 404 — so today the local-clone form is the one that works:

```bash
git clone https://github.com/IvanBBaev/tiktok-mcp.git
cd tiktok-mcp
npm install
npm run build
node build/src/index.js --version   # sanity check: prints the version and exits
```

`node build/src/index.js` and `node bin/tiktok-mcp-ai.cjs` are equivalent entry
points; the second adds the Node-version guard for very old runtimes. Every
`npx tiktok-mcp-ai …` command in these docs has a local equivalent —
`node build/src/index.js login`, `node build/src/index.js doctor`, and so on.

## Claude Code

Command form:

```bash
claude mcp add tiktok -- node /absolute/path/to/tiktok-mcp/build/src/index.js
```

Once the package is on npm:

```bash
claude mcp add tiktok -- npx -y tiktok-mcp-ai
```

Everything after `--` is the command Claude Code runs. Add `-s user` to register
the server for every project instead of the current one, and `-e KEY=value` for
an environment variable (`claude mcp add --help` is authoritative for the flags
of your version).

JSON form — a `.mcp.json` at the project root, checked in for the whole team:

```json
{
  "mcpServers": {
    "tiktok": {
      "command": "node",
      "args": ["/absolute/path/to/tiktok-mcp/build/src/index.js"],
      "env": {
        "TT_MEDIA_ROOT": "/absolute/path/to/your/media"
      }
    }
  }
}
```

There is also a plugin that registers the server for you:

```
/plugin marketplace add IvanBBaev/tiktok-mcp
/plugin install tiktok-mcp-ai
```

The plugin launches the server with `npx -y tiktok-mcp-ai`, so it needs the
published package.

## Claude Desktop

Edit `claude_desktop_config.json`:

| OS | Path |
| -- | ---- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "tiktok": {
      "command": "node",
      "args": ["/absolute/path/to/tiktok-mcp/build/src/index.js"]
    }
  }
}
```

Caveats specific to Claude Desktop:

- It is a GUI application, so it does **not** see your shell environment. If
  `node` comes from `nvm`, write the absolute interpreter path
  (`/Users/you/.nvm/versions/node/v24.x.y/bin/node`) rather than `node`.
- Quit the app completely and reopen it; reloading the window is not enough.
- The tools appear under the tools icon in the composer. If they do not, read
  the log file listed in [Where the logs go](#where-the-logs-go) — a server that
  crashed at startup usually printed exactly why.

## VS Code

VS Code (Copilot Chat, agent mode) reads `.vscode/mcp.json` in the workspace.
The one in this repository is a working example:

```json
{
  "servers": {
    "tiktok-mcp-ai": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/build/src/index.js"]
    }
  }
}
```

Note the schema differences from the Claude clients: the key is `servers`, not
`mcpServers`, and each entry declares `"type": "stdio"`. `${workspaceFolder}`
resolves inside VS Code, so this form only works for a clone you have open;
outside it, use an absolute path.

There is also a **TikTok MCP** extension
(`code --install-extension ivanbbaev.tiktok-mcp-ai`) that registers the server
in Copilot Chat with no `mcp.json` at all. It launches `npx -y tiktok-mcp-ai`,
so it needs the published package. Source: [extension/](../extension/).

## Cursor

Cursor reads `mcp.json` from `~/.cursor/mcp.json` (all projects) or
`.cursor/mcp.json` (one project), in the `mcpServers` shape:

```json
{
  "mcpServers": {
    "tiktok": {
      "command": "node",
      "args": ["/absolute/path/to/tiktok-mcp/build/src/index.js"]
    }
  }
}
```

Enable the server in Cursor's MCP settings pane after saving the file. Cursor,
like Claude Desktop, is launched from the desktop and does not inherit a shell
`PATH`.

## MCP Inspector

The fastest way to see the tool list without any client:

```bash
npx @modelcontextprotocol/inspector node /absolute/path/to/tiktok-mcp/build/src/index.js
```

The Inspector shows `tools/list` exactly as a client sees it, including the
`[UNAVAILABLE: …]` prefixes on tools whose scopes no profile has granted.

## Confirm the wiring

1. In a terminal: `npx tiktok-mcp-ai doctor` — or `node
   build/src/index.js doctor` from a clone. Exit code `0` means the local setup
   is healthy.
2. In the client: ask it to call `tiktok_get_auth_status`. It reports the
   configured profiles, their granted scopes and token freshness, and exposes no
   secret. If the client cannot see the tool, the problem is the client
   configuration, not the credentials.

A tool whose description starts with `[UNAVAILABLE: requires scope …]` is
registered but not authorized — the marker names the `login` command that fixes
it. See [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the rest.

## Where the logs go

The server writes structured lines to **stderr** at `TT_LOG_LEVEL` (default
`info`; `debug` for more). It never logs a secret — redaction sits below every
sink. Each client captures that stderr somewhere:

| Client | Where |
| ------ | ----- |
| Claude Code | The `/mcp` view; the CLI prints startup failures inline |
| Claude Desktop (macOS) | `~/Library/Logs/Claude/` — one log file per MCP server |
| Claude Desktop (Windows) | `%APPDATA%\Claude\logs\` |
| VS Code | Output panel → the MCP server's channel |
| Cursor | The MCP settings pane shows per-server status and output |
| MCP Inspector | Its own stderr pane |

Client config formats change; when a client's own documentation disagrees with
this page, the client's documentation wins. What does not change is the server
side: a stdio command, absolute paths, and the credentials in the env file.
