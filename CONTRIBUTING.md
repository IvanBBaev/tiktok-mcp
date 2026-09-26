# Contributing

Thanks for your interest in `tiktok-mcp-ai`. This is an unofficial,
community-built MCP server for TikTok; contributions of all sizes are welcome —
bug reports, docs fixes, tests, and features.

## Reporting a bug

Start with the doctor output — it answers most of the questions a maintainer
would ask you anyway:

```bash
npx tiktok-mcp-ai doctor
```

**Paste that output into the issue.** It is designed to be shareable: only a
masked `open_id`, scope names, expiry timestamps and file paths ever reach a row,
and `cliIo` runs the same allowlist redaction over everything it prints. The
guarantee is written down in [docs/SECURITY.md](docs/SECURITY.md) § Redaction —
no secret enters stdout, stderr, the log mirror, tool results, error messages,
the publish journal, or `doctor` output. If you want to double-check before
pasting, read it: paths are the only thing in there you might consider private.

Include, on top of that:

- **Versions** — `npx tiktok-mcp-ai --version`, `node --version`, your OS.
- **The MCP client** and its version (Claude Code, Claude Desktop, VS Code,
  Cursor, the Inspector…), and how it launches the server.
- **What you did** — the tool that was called and, with any personal content
  removed, the arguments it was called with.
- **The exact error** — the `code` from the error envelope (`auth_expired`,
  `plan_mismatch`, `rate_limited`, …) and the message verbatim. TikTok's
  `log_id`, when the message carries one, is what lets a platform-side problem be
  traced.
- **What you expected instead**, if it is not obvious.

Never paste:

- the env file, or any part of it;
- `TT_CLIENT_SECRET`, access tokens, refresh tokens, or an authorization code —
  a full redirect URL contains one;
- an `upload_url` — its query string carries the `upload_token`, which is the
  upload-session credential.

If you believe you have found a **security** vulnerability, do not open a public
issue: [SECURITY.md](SECURITY.md) has the private reporting channel.

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) maps the common failure modes
to fixes — worth a look first, since many reports turn out to be a missing scope
or an expired refresh token.

## Development setup

```bash
nvm use          # Node from .nvmrc (pins 24; the project requires >= 22)
npm install
npm run build    # clean + tsc -> build/
```

Everything runs on Node's built-ins plus two runtime dependencies
(`@modelcontextprotocol/sdk`, `zod`) — no test framework,
no bundler. There is deliberately no `dotenv`: the env file is read by
`core/config`'s own parser, because importing `dotenv/config` would let a
dependency print to stdout before the transport connects (CC-G3).
Tests use `node:test` and run against the compiled output in `build/`.

## Quality gates

Run the full gate before opening a pull request — it is exactly what CI runs:

```bash
npm run check       # typecheck + lint + format + build + test + coverage + sync
```

Individual steps, if you want to iterate faster:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint (flat config + typescript-eslint)
npm run format:check   # Prettier, verify only
npm run format         # Prettier, write
npm test               # node --test over build/test (needs a prior build)
npm run coverage       # build + c8 report + per-area floors
npm run coverage:gate  # per-area floors only (needs a prior coverage:run)
npm run sync           # every generated artifact vs the tree — reports, never writes
npm run sync:write     # regenerate them instead of complaining
npm run smoke:pack     # pack, install the tarball elsewhere, run the installed binary
```

`smoke:pack` is deliberately outside `check`: it installs from the network,
while `check` stays offline-safe. CI runs it on ubuntu, macOS and Windows, and
`publish.yml` runs it once more before publishing.

Two more are local-only and need a real sandbox account, so they are outside
`check` too — and `fixtures:record` refuses to run in CI at all:

```bash
npm run fixtures:record    # capture live read-only interactions to .fixtures-raw/
npm run fixtures:sanitize  # raw captures → the committed test/fixtures/recorded/ tree
```

Nothing from `.fixtures-raw/` is ever committed: it holds live tokens and a
usable `upload_url`. The sanitizer is the only thing that writes into
`test/fixtures/recorded/`, and it refuses to write a file that still matches a
secret shape — see [docs/TESTING.md](docs/TESTING.md) § Recorded sandbox
fixtures.

`sync` covers the README tool table, `.env.example`, `docs/tool-manifest.json`
and `pack-manifest.json`. It reports **all** stale artifacts before failing, so
one run tells you everything to regenerate; `npm run sync:write` then does it.

CI runs on every push and pull request across the supported Node versions and on
Linux, macOS **and Windows** — the Windows leg matters because the env-file store
does atomic, line-ending-preserving rewrites, so keep line endings LF (see
[.gitattributes](.gitattributes)). Coverage is tracked and expected to hold or
improve; a change that removes a covered path should add a test, not lower the
bar.

## Conventions

- **One commit per task**, with a clear message describing the change (no AI
  attribution trailers).
- **Tests ship with the change.** Every behavioral change lands with a test in
  the same commit; corner cases have IDs in
  [docs/CORNER-CASES.md](docs/CORNER-CASES.md) — reference the `CC-*` id you
  cover.
- **The README tools table is generated.** Edit the tool definitions under
  `src/tools/`, then regenerate the block between the
  `<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->` markers with
  `npm run docs:readme`. A drift check keeps the committed table in sync with the
  registrations — never hand-edit inside the generated markers.
- **The manifest is a snapshot.** The in-code `PACKAGES` manifest (tool ⇄ package
  ⇄ annotations) is snapshotted to [docs/tool-manifest.json](docs/tool-manifest.json);
  regenerate it with `npm run sync:write` in the same change when you add or move
  a tool. It is generated against a synthetic fully-authorized profile, so it
  describes the server and never the credentials on the machine that ran it.
- **Scopes are gated in both directions.** A tool declaring a scope its package
  does not request in `PACKAGE_SCOPES` (`src/cli/login.ts`) fails
  `test/manifest.test.ts` — a login that cannot call the tool it authorized is a
  failure only the end user would discover.
- **Docs move with the code.** A change to behavior updates the matching design
  doc under `docs/` (architecture, tools, auth, configuration, security) and the
  user-facing [CHANGELOG.md](CHANGELOG.md) in the same commit.
- **English only** in code, comments, docs, tests and commit messages.

## Where things live

The code is layered, and the import direction is enforced by ESLint:

```
core  ←  api  ←  mcp  ←  tools
```

- `core/` — config, env-file store (0600, atomic, locked), redaction, errors,
  the plan store and the publish journal, JSON canonicalization. Depends on
  nothing above it.
- `api/` — the TikTok HTTP client (allowlisted egress, the three-class retry
  matrix, chunked uploads), OAuth/PKCE, token refresh. Uses `core/`.
- `mcp/` — server construction, transport (stdio / Streamable HTTP), the
  `ToolSpec` contract and registration, result shaping.
- `tools/` — the 11 tool implementations, grouped into packages. Tool code never
  reaches for HTTP or auth directly — it goes through `api/`.

Redaction lives in `core/redact`, below every sink, so no secret can reach a log,
a tool result, or the journal. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the full module contract and [docs/CONTRACTS.md](docs/CONTRACTS.md) for the
frozen inter-module interfaces.

## Releasing

The package is published to npm as
[`tiktok-mcp-ai`](https://www.npmjs.com/package/tiktok-mcp-ai) from CI on a
version tag — maintainers only:

1. Update [CHANGELOG.md](CHANGELOG.md): move `[Unreleased]` items under the new
   version and date, and refresh the compare links.
2. Bump the version (`npm version <patch|minor|major>`), which creates the
   `vX.Y.Z` tag.
3. Push the tag; CI runs the full gate and publishes on green. A prerelease
   tag (`vX.Y.Z-rc.N`) goes to npm under the `next` dist-tag only — the VS Code
   Marketplace rejects semver prereleases, so `publish-vscode.yml` skips its
   publish step for such a version.
4. Verify the published package and the GitHub release notes.

Versioning follows [SemVer](https://semver.org):

- **patch** — bug fixes and internal changes with no contract impact.
- **minor** — new tools, new options, or new env vars that are backward
  compatible.
- **major** — a breaking change to a tool contract, an env var, or the CLI.
