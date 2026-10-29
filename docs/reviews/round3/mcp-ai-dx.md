# Round 3 — MCP / AI-DX review

Date 2026-10-29 · Commit 301b9bb · Role: senior MCP / AI developer-experience engineer · Scope: the tool surface as a model sees it (tools/list, schemas, annotations, outputSchema, errors, hints, plan/apply, elicitation, resources, prompts, completion), the Claude Code plugin, the VS Code extension, first-run experience, and the delta against `docs/reviews/round2/ai-dx-deep-review.md`.

Method: static reading of `src/mcp/**`, `src/tools/**`, `src/core/settings.ts`, the README, `docs/CLIENTS.md`, `.claude-plugin/*`, `extension/*`, plus a live stdio probe of the built server (SDK `Client`, isolated `HOME`, no credentials, no TikTok traffic) in two configurations: default (`core`) and `TT_TOOL_PACKAGES=all`. Every byte count below comes from that probe. Client elicitation support is from vendor release notes as I remember them. It was **not verified live** and is marked as such.

## Verdict

The server-side MCP engineering is unusually strong. It has a uniform result envelope with a closed hint vocabulary, actionable `invalid_params` and `missing_scope` errors, digest-bound single-use plans, working completion, and prompts that name the exact tools. As a protocol citizen it beats almost every public MCP server. The AI-DX *around* that core is not release-ready. The two advertised zero-config install paths (plugin and VS Code extension) launch an npm package that does not exist yet. The README's first copy-paste write demo is rejected by the server's own strict schema. A fresh user's first tool call says "run login", and login then fails for missing app credentials. On clients without form elicitation, the default `TT_ELICITATION=auto` silently drops the server-side human gate, and nothing tells the user or the model that this happened. The full surface costs ~12.5–14k tokens of tools/list, 28% of it a duplicated generic outputSchema. Nothing has been exercised against the real API or a real model loop.

**Readiness: 6/10.** The core protocol design deserves an 8 or 9. Distribution, first-run, documentation correctness and consent visibility pull it down, and three of those are release-blocking.

## What is strong

- **The envelope and hints.** `{ok,data,error{code,message,retryable,log_id,details},hints[],journal}` comes with six closed hint types (`src/mcp/result.ts:543`). It is mirrored as text plus `structuredContent`, and `isError` is set correctly (`src/mcp/server.ts` `toCallToolResult`). Round 2's requirement for `structuredContent` is met.
- **Errors a model can act on.** I observed these live:
  - An unknown argument returns "`bogus`: unknown argument — check the spelling… No request was sent to TikTok."
  - `unknown_account` lists the configured profiles.
  - `missing_scope` carries a `reauth` hint with the exact command.
  - A batch preview returns `plan_incomplete` with per-item errors.
- **Plan-then-execute** (`src/mcp/plan.ts`, `src/mcp/plan-store.ts`): a SHA-256 digest-bound, single-use plan with a TTL, and `approval_required` hints that tell the model exactly what to resend (`src/mcp/plan.ts:425-438`).
- **Annotations are complete and mostly honest.** All four hints are required by the type in `src/mcp/define.ts`. Reads are `readOnly` and `idempotent`. Local-only reads (journal, webhooks, scheduled) correctly set `openWorldHint:false`.
- **Completion, resources and prompts.** Completion for `privacy_level` ("P" → `PUBLIC_TO_EVERYONE`), `account` and `publish_id` works. There are 5 resources and 6 templates, with subscribe and listChanged. The `post_video_guided` prompt is a precise step-by-step script.
- **Ecosystem posture.** `docs/CLIENTS.md` honestly states that the package is unpublished. The VS Code publish workflow refuses to ship a Marketplace version that npm does not have (`.github/workflows/publish-vscode.yml:1-40`).
- **Drift guards.** `docs/tool-manifest.json` is generated and the tests check `TOOLS.md`/manifest sync.

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| DX-01 | High | The plugin and the VS Code extension both launch `npx -y tiktok-mcp-ai`, which is unpublished (E404), so both fail on first start. They pass no env, so even after publication they expose 10 `core` tools while advertising "17 tools". Their homepage is a 404 Pages URL. | `.claude-plugin/plugin.json:5,7`; `.claude-plugin/marketplace.json:8`; `extension/src/extension.ts`; `extension/package.json:4,13`; `src/core/settings.ts:101-105,614-621` | Do not announce the plugin or extension before npm publish. Change the wording to "10 read tools by default, 17 with `TT_TOOL_PACKAGES=all`". Give the extension a `tiktokMcp.toolPackages` setting. Gate on Pages being live. **Release-blocking.** |
| DX-02 | High | The README Quick demo is wrong: the copy-paste write call is rejected. It nests `post_info:{title,privacy_level}`, but the schema is flat and `.strict()`, so the server answers "`post_info`: unknown argument". The README also says "four write tools" (there are six), claims `npx tiktok-mcp-ai` runs today, omits `embed` from the package list, and "Read it back with a tool" shows a CLI command. | `README.md:53,71,80-84,87,203,428,528`; `src/tools/publish-write.ts` (flat input); `src/mcp/define.ts` `toolInput().strict()` | Regenerate the demo from a real recorded preview/execute pair, and add a test that parses every README JSON block against the tool schema. Fix the counts from the manifest. **Release-blocking.** |
| DX-03 | High | With the default `TT_ELICITATION=auto`, the consent dialog runs only if the client declares `elicitation.form`. Otherwise `confirmWrite` proceeds silently and `plan_id` is the only gate. A model can chain preview → apply in one turn. Nothing in tools/list, `get_auth_status`, the apply result or the docs tells anyone that the human gate is off for this client. There is no client support matrix. | `src/core/settings.ts:621`; `src/mcp/consent.ts` `supportsConsentDialog`; `src/tools/publish-common.ts:852-895`; `docs/CLIENTS.md` (no matrix); `docs/CONFIGURATION.md:215,234` | Report `consent_dialog: active\|unavailable\|off` in `get_auth_status` and in every apply result's `journal`/`note` hint. Add a client matrix verified live. Decide the default for v0.1 explicitly (see the open questions). **Release-blocking.** |
| DX-04 | Medium | Every tool declares the same 812-byte generic `outputSchema` with an unconstrained `data`. That is 17 × 812 B ≈ 13.8 KB, ~28% of the `all` tools/list payload, and tells the client nothing about per-tool data shapes. Round 2 intended outputSchema to describe results. | `src/mcp/server.ts:277`; `src/mcp/result.ts:543+`; probe: 49,639 B total | Either declare per-tool `data` schemas (zod → JSON Schema, already done for `docs/tool-manifest.json` `resultSchema`), or emit them only where a shape is stable. Never repeat a schema that carries no information. |
| DX-05 | Medium | The token cost is high and growing. The `all` surface is 49.6 KB (~12.5–14k tokens); `core` is 22.4 KB (~6k). `tiktok_post_video` alone is 6.6 KB (1.3 KB description, 4.2 KB input). The `account` description repeats on 17 tools. The surface grew from round 2's "final" 11 tools / 5 packages to 17 / 7. | probe `scratchpad/dx/all.json`; `src/mcp/define.ts` `ACCOUNT_DESCRIPTION`; round 2 §tool finalisation | Set a budget (for example ≤ 35 KB for `all`, enforced in a test). Move policy prose to server `instructions` or a `tiktok://guide` resource. Shorten repeated descriptions. Consider an opt-in `publish-batch` package for batch and schedule. |
| DX-06 | Medium | The `initialize` result has no server `instructions`. Cross-tool rules (plan-then-execute, "call `get_creator_info` before posting", account selection, what hints mean) are duplicated inside each tool description instead of stated once. | `src/mcp/server.ts` (no `instructions` option); probe `getInstructions()` → `undefined` | Add ~600–900 B of `instructions`, then delete the duplicated prose from the descriptions. This is net-negative in tokens. |
| DX-07 | Medium | First run is a dead end. With no app credentials, `get_auth_status` returns `ok:true` with a "run login" hint. `login` then fails with "missing TikTok app credentials". `doctor --offline` correctly reports FAIL, but its first remediation is again "run login". The remediation also tells users to put `TT_CLIENT_KEY`/`TT_CLIENT_SECRET` "in the MCP client configuration", which contradicts `CLIENTS.md`. | probe output; `docs/CLIENTS.md:19`; `src/cli/login*`, `src/cli/doctor*` remediation strings | `get_auth_status` should report `app_credentials: missing` with a `user_action` hint first. Order the remediations correctly (credentials → login → doctor). Use one credential story everywhere. |
| DX-08 | Medium | The default `core` profile hides all write tools and all 3 prompts. Calling a write tool returns a bare protocol error "Unknown tool: tiktok_post_video", with no hint that `TT_TOOL_PACKAGES=all` exists. A user who installs the plugin to "post to TikTok" sees a read-only server and nothing explains why. | `src/core/settings.ts:101-105,614-621`; `src/mcp/server.ts` unknown-tool `McpError`; probe: core → 0 prompts | Make `get_auth_status` list the disabled packages and how to enable them. Return an `ok:false` envelope with a `user_action` hint for known-but-disabled tool names. Document this in `CLIENTS.md` for each client. |
| DX-09 | Medium | `plan_mismatch` does not say which fields differ, so a model that reformatted one argument has to guess or start over. | `src/mcp/plan.ts:365-385` | Store the canonical args with the plan. Return `details.differing_fields: string[]` (names only, never values of sensitive fields). |
| DX-10 | Medium | There are no model-in-the-loop evals. 2,415 tests cover the protocol, but none check that a model picks the right tool, respects preview → approval → apply, or recovers from the hints. All description and token work is unmeasured. | `test/**` (73 files, none agentic) | Add a small eval suite (10–20 scripted tasks) run on demand against a mock TikTok. Track tool-selection accuracy and plan-flow violations. |
| DX-11 | Low | `max_count` and `video_cover_timestamp_ms` declare no `.min/.max`, so the advertised JSON Schema shows ±2^53 bounds. Out-of-range values are clamped with a note instead of being refused. | `src/tools/video.ts:62-80,204`; `src/tools/publish-write.ts:447` | Add `.min(1).max(20)` (and an equivalent bound for the cover timestamp), so the schema states the contract. |
| DX-12 | Low | A missing required `source` reads as `Invalid option: expected one of "file"\|"url"`, not "required argument is missing". | probe `tiktok_post_video {}` | Special-case `undefined` in the discriminated-union error mapper. |
| DX-13 | Low | `tiktok_get_embed` needs no auth but sits in an opt-in package outside `core`. It is the safest tool to demo, and a first-run user never sees it. | `src/core/settings.ts:77,101-105` | Include `embed` in `core`, or explain in the docs why it is excluded. |
| DX-14 | Low | The draft-upload tools carry `destructiveHint:true`. A draft goes to the creator's inbox and is not published. Clients that colour destructive tools may over-warn. | probe annotations; `src/tools/publish-write.ts` | Decide and document. `destructive:false, idempotent:false` is defensible for drafts. |
| DX-15 | Low | Results and resources expose absolute local paths (`journal_path`, `schedule_path`, `log_path`), which leaks the home directory and username into model context and transcripts. | probe results | Return `~`-relative paths, or a resource URI. |
| DX-16 | Low | The VS Code extension has no `contributes.configuration`, so there is no way to set packages, profile or write mode without editing global env. | `extension/package.json`; `extension/src/extension.ts` | Add 3–4 settings mapped onto the definition's `env`. |
| DX-17 | Info (still open from round 2) | The surface has never been verified against the real API (probes P-1..P-14 are "not run"). The photo-draft `post_info` unknowns and the round-2 `cancel_publish` question remain open: they were answered with a local-only `cancel_scheduled`, not a TikTok cancel. | brief; round 2 "remaining unknowns" | Run the sandbox probes before release. Until then, label the tool descriptions that depend on unverified behaviour. |

### DX-01 — The plugin and the VS Code extension cannot start

- **What:** both integrations hard-code `npx -y tiktok-mcp-ai` (`extension/src/extension.ts`; `.claude-plugin/plugin.json` `mcpServers.tiktok`). The package returns E404 on npm. Neither integration passes an `env`, so `TT_TOOL_PACKAGES` falls back to `core` (`src/core/settings.ts:614-621`): 10 read-only tools, 0 prompts. Their descriptions still say "17 tools" (`plugin.json:5`, `marketplace.json:8`, `extension/package.json:4`), and their `homepage` points at Pages, which is not enabled.
- **Why it matters:** these are the lowest-friction entry points, and the README presents them as zero-config. A first impression that ends in a spawn failure gets uninstalled.
- **Failure scenario:** a user runs `/plugin marketplace add IvanBBaev/tiktok-mcp`. The server fails to spawn (npx E404), Claude Code shows the MCP server as failed, and the homepage link 404s. After publication the user asks to "post this video", gets "Unknown tool", and nothing explains why.
- **Fix:** sequence the launch so npm publish comes first, then Pages, then plugin and Marketplace (the extension workflow already enforces this; the plugin has no such gate). Make the copy accurate ("10 read tools by default; enable writes with `TT_TOOL_PACKAGES=all`"). Add `env` support: plugin `mcpServers.tiktok.env` with documented overrides, and extension settings (DX-16).

### DX-02 — The README's first write example is rejected

- **What:** `README.md:53` and `:71` show `"post_info": { "title": …, "privacy_level": … }`. The input schema is flat and strict (`src/mcp/define.ts` `toolInput()` → `.strict()`), so the server returns `invalid_params` "post_info: unknown argument". There are also stale facts:
  - "four write tools" (`:87`, `:428`, `:528`); `publish-write` now has six.
  - "Or run the published package directly: `npx tiktok-mcp-ai`" (`:203`), which returns E404.
  - The package list omits `embed`.
  - "Read it back with a tool" (`:80`) is followed by a `doctor` CLI command (`:84`).
- **Why it matters:** the README is the spec that users, and models reading the repo, copy from. A demo that fails undermines trust in the safety story it is meant to show off.
- **Failure scenario:** a developer pastes the README call into MCP Inspector. It fails, and they conclude the server is broken or the docs are unmaintained.
- **Fix:** generate the demo blocks from recorded probe output. Add a docs test that extracts every fenced JSON tool call from `README.md`/`docs/*.md` and validates it against the tool's zod schema. Derive the counts from `docs/tool-manifest.json`.

### DX-03 — The human gate silently disappears on clients without elicitation

- **What:** `TT_ELICITATION` defaults to `auto` (`src/core/settings.ts:621`). `supportsConsentDialog` checks `caps?.elicitation?.form` (`src/mcp/consent.ts`). When the client lacks it, `confirmWrite` (`src/tools/publish-common.ts:852-895`) returns success unless the mode is `required`. The only remaining protections are the `plan_id` round-trip and the client's own tool-approval prompt. Both are model- and client-dependent, and neither is controlled by this server.
- **Why it matters:** the product's headline promise is "plan-then-execute write safety". On clients that lack elicitation (Claude Desktop is the likely case; **unverified**), a model can call preview and then apply in the same turn without the human seeing the plan. The audit journal records the post after the fact. Clients that do support it (VS Code ≥ ~1.102, Cursor ≥ ~1.5, recent Claude Code; all **unverified live**) have the opposite problem: up to three confirmations (client tool approval, elicitation dialog, chat approval).
- **Failure scenario:** a user on Claude Desktop with auto-approve enabled for the server asks "draft a post about X". The model previews, receives `approval_required`, interprets the user's earlier request as approval, and applies. A PUBLIC post goes live. The user's mental model from the README was "it always asks me first".
- **Fix:**
  - Add `consent_dialog: "active" | "unavailable" | "off"` to `get_auth_status`, and add a `note` hint on every apply when the dialog was unavailable.
  - Add a live-verified client matrix to `CLIENTS.md`.
  - The owner decides whether v0.1 ships `required` (fail closed, with a clear `consent_unavailable` error telling users to set `auto`) or keeps `auto` with the visibility above.
  - The README's safety claim must match whichever default is chosen.

## Open questions for the owner

1. **The consent default for v0.1** (DX-03):
   - Fail closed (`required`) and accept that clients without elicitation must opt out.
   - Or keep `auto`, but make the inactive gate visible?
2. **Should `core` stay read-only?** If yes, should the plugin ship a second "writer" entry with `TT_TOOL_PACKAGES=all`, or should users edit the env?
3. **Is a token budget for tools/list acceptable as a CI gate** (for example ≤ 35 KB for `all`)? Would you accept moving policy prose into `instructions`?
4. **Per-tool `data` schemas** (DX-04): commit to shapes now, before the real-API probes? Or drop `outputSchema` until the shapes are verified?
5. **Which clients will you smoke-test live** before announcing? This needs your accounts and machines.
6. **Drafts as `destructiveHint`** (DX-14): keep it conservative, or relax it?

## Proposed roadmap items

#### DX-R1 — Fix the plugin and extension launch path and their claims
Deps npm publish, Pages enabled · Status blocked: owner (npm publish + Pages) · Est 2 h
- **Scope:** correct the tool-count copy ("10 by default, 17 with `all`") in `plugin.json`, `marketplace.json` and `extension/package.json`. Add documented `env` passthrough for the plugin. Add a release-checklist item that the plugin and marketplace are announced only after `npm view tiktok-mcp-ai` succeeds and the homepage returns 200. **Release-blocking.**
- **Owns:** `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `extension/package.json`
- **Shared:** `docs/CLIENTS.md`, release checklist
- **Acceptance:** after publish, a fresh `/plugin marketplace add` and the VS Code extension each start the server and list tools. The copy matches the default tool count. The homepage resolves.

#### DX-R2 — Correct the README demo and stale facts, and guard them with a test
Deps — · Status todo · Est 1.5 h
- **Scope:** flatten the Quick-demo JSON. Fix "four write tools" → six. Remove or qualify the "run the published package" claim until publish. Add `embed` to the package list. Fix the "read it back" step. Add a test that validates every fenced tool-call JSON in `README.md` and `docs/*.md` against the zod schemas. **Release-blocking.**
- **Owns:** `README.md`, new `test/docs-examples.test.ts`
- **Shared:** `docs/TOOLS.md`
- **Acceptance:** the docs-examples test passes. A grep for "four write tools" returns nothing. The demo, pasted into Inspector, yields a preview with `approval_required`.

#### DX-R3 — Make the consent-dialog state visible and decide the default
Deps DX-R10 (matrix data) · Status blocked: owner (default decision) · Est 3 h
- **Scope:** add `consent_dialog` to the `get_auth_status` data. Add a `note` hint on apply when no dialog ran. Add a client support matrix to `CLIENTS.md`. Apply the owner's chosen `TT_ELICITATION` default, and align the README safety wording. **Release-blocking.**
- **Owns:** `src/mcp/consent.ts`, `src/tools/auth*.ts`, `src/tools/publish-common.ts`
- **Shared:** `src/core/settings.ts`, `docs/CLIENTS.md`, `docs/CONFIGURATION.md`, `README.md`
- **Acceptance:** tests cover the `consent_dialog` value for form-capable, non-capable and `off` clients. The apply result carries the note when the dialog was unavailable. The docs matrix lists at least four clients with a verification date.

#### DX-R4 — Replace the duplicated generic outputSchema with per-tool data schemas
Deps — · Status todo · Est 5 h
- **Scope:** add an optional `output` zod schema to `ToolSpec`. Emit `outputSchema` with a typed `data` per tool (reuse the manifest `resultSchema` source). Validate `structuredContent` against it in tests.
- **Owns:** `src/mcp/define.ts`, `src/mcp/server.ts` (`describeTool`), `src/mcp/result.ts`
- **Shared:** `src/tools/*.ts`, `docs/tool-manifest.json` generator
- **Acceptance:** no two tools share a byte-identical `outputSchema`. Every handler's success result validates against its declared schema in tests.

#### DX-R5 — Cut the tools/list token budget and add server instructions
Deps DX-R4 · Status todo · Est 3 h
- **Scope:**
  - Add `instructions` (≤ 900 B) covering plan-then-execute, account selection and the hint semantics.
  - Remove the duplicated prose from tool descriptions and shorten `ACCOUNT_DESCRIPTION`.
  - Add a size test: `all` tools/list ≤ 35 KB, and no single tool over 4 KB.
- **Owns:** `src/mcp/server.ts`, `src/mcp/define.ts`, tool descriptions in `src/tools/*.ts`
- **Shared:** `docs/TOOLS.md`, `docs/tool-manifest.json`
- **Acceptance:** the measured `all` payload is ≤ 35 KB (from 49.6 KB). `getInstructions()` is non-empty. The tools-doc sync tests pass.

#### DX-R6 — Fix the first-run credential diagnostics
Deps — · Status todo · Est 2 h
- **Scope:**
  - `get_auth_status` reports `app_credentials: present|missing` and puts a `user_action` hint first when they are missing.
  - The `doctor` and `login` remediations are ordered credentials → login.
  - One credential-placement story, consistent with `CLIENTS.md:19`.
  - **Release-blocking.**
- **Owns:** `src/tools/auth*.ts`, CLI `login`/`doctor` remediation strings
- **Shared:** `docs/CLIENTS.md`, `docs/CONFIGURATION.md`
- **Acceptance:** with an empty `HOME`, the first tool call names the missing variables and where to put them. No remediation string recommends the client config if the docs forbid it.

#### DX-R7 — Explain disabled packages and plan mismatches
Deps — · Status todo · Est 2 h
- **Scope:**
  - A known-but-disabled tool name returns an `ok:false` envelope with a `user_action` hint that names the package and `TT_TOOL_PACKAGES`.
  - `get_auth_status` lists the disabled packages.
  - `plan_mismatch` returns `details.differing_fields`.
- **Owns:** `src/mcp/server.ts` (unknown-tool path), `src/mcp/plan.ts`, `src/mcp/plan-store.ts`
- **Shared:** `docs/TOOLS.md`
- **Acceptance:** tests cover calling `tiktok_post_video` under `core` (hint present) and a one-field mismatch (that field name is listed and no values are echoed).

#### DX-R8 — Tighten schema bounds and error wording
Deps — · Status todo · Est 1 h
- **Scope:**
  - Add `.min/.max` to `max_count` and `video_cover_timestamp_ms`.
  - A missing discriminated-union field reports "required argument is missing".
  - Return `~`-relative paths in results.
  - Decide the drafts' `destructiveHint`.
- **Owns:** `src/tools/video.ts`, `src/tools/publish-write.ts`, the error mapper in `src/mcp/`
- **Shared:** `docs/tool-manifest.json`
- **Acceptance:** the advertised schemas contain no ±2^53 bounds. Calling `tiktok_post_video {}` says `source` is required.

#### DX-R9 — Add a model-in-the-loop eval harness
Deps DX-R5 · Status todo · Est 6 h
- **Scope:** 10–20 scripted tasks run against a mocked TikTok. Score tool-selection accuracy, plan-flow adherence (no apply without user approval), and recovery from hints. Run on demand, outside the default gate.
- **Owns:** new `evals/` directory and its npm script
- **Shared:** mock fixtures in `test/`
- **Acceptance:** a baseline report is committed. A description change can be compared before and after.

#### DX-R10 — Smoke-test the live client matrix
Deps npm publish or a local-clone build · Status blocked: owner (client accounts and machines) · Est 2 h
- **Scope:** in Claude Code, Claude Desktop, Cursor and VS Code, record:
  - the tool count;
  - whether the consent dialog appears;
  - the number of confirmations per write;
  - whether the prompts and completion show up.
  Feed the results into DX-R3.
- **Owns:** the `docs/CLIENTS.md` matrix section
- **Shared:** DX-R3
- **Acceptance:** the matrix has dated, observed results for all four clients, and every "unverified" mark in this review is resolved.

**Top recommendation:** before announcing anything, make the first five minutes true: a launch command that resolves, a README demo that the server accepts, a first tool call that names the missing credentials, and a visible statement of whether this client gets the human consent dialog.
