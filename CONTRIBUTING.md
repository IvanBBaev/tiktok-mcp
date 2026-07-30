# Contributing

Thanks for your interest in `tiktok-mcp-ai`. This is an unofficial,
community-built MCP server for TikTok; contributions of all sizes are welcome —
bug reports, docs fixes, tests, and features.

## Development setup

```bash
nvm use          # Node from .nvmrc (pins 24; the project requires >= 22)
npm install
npm run build    # clean + tsc -> build/
```

Everything runs on Node's built-ins plus three runtime dependencies
(`@modelcontextprotocol/sdk`, `zod`, `dotenv`) — no test framework, no bundler.
Tests use `node:test` and run against the compiled output in `build/`.

## Quality gates

Run the full gate before opening a pull request — it is exactly what CI runs:

```bash
npm run check       # typecheck + lint + format:check + build + test
```

Individual steps, if you want to iterate faster:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint (flat config + typescript-eslint)
npm run format:check   # Prettier, verify only
npm run format         # Prettier, write
npm test               # node --test over build/test (needs a prior build)
npm run coverage       # build + c8 coverage report
```

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
  ⇄ annotations) is asserted against a committed fixture; update the fixture in
  the same change when you add or move a tool.
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
3. Push the tag; CI runs the full gate and publishes on green.
4. Verify the published package and the GitHub release notes.

Versioning follows [SemVer](https://semver.org):

- **patch** — bug fixes and internal changes with no contract impact.
- **minor** — new tools, new options, or new env vars that are backward
  compatible.
- **major** — a breaking change to a tool contract, an env var, or the CLI.
