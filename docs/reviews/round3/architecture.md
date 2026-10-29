# Round 3 — Architecture review

Date 2026-10-29 · commit `301b9bb` · reviewer: senior Software Architect (TypeScript/Node, ports & adapters) · scope: layering and boundary enforcement, module cohesion and file sizes, duplication in `src/tools/publish-*.ts`, state and concurrency design, composition roots (`src/index.ts`, `src/cli/`), extensibility for roadmap B1/B2, accidental complexity, docs-as-spec burden, divergence from `docs/ARCHITECTURE.md`, status of round-2 `architecture-deep-review.md` points.

## Verdict

The built system keeps its core promise: the dependency direction is `core ← api ← mcp ← tools`, there are no upward imports, the clock and DNS seams are real, and the write-safety pipeline (plan, digest, journal, guards, dispatch) is coherent and well sectioned. Three structural problems remain, and they get more expensive with every feature merged. (1) Retry classification fails open: it depends on what each caller declares, not on the path allowlist the spec requires. (2) The credential and token model is hard-wired to "one TikTok app, one OAuth provider, caches keyed by profile name", which the roadmap's B1 and B2 explicitly break. (3) A 3616-line CONTRACTS.md and an 803-line ARCHITECTURE.md restate signatures that no gate checks, and both have already drifted. Beyond that, a 28k-line `src/` with v1.1–1.3 features has never sent a single real request to TikTok, so most of the complexity rests on assumptions nobody has tested. **Readiness score: 6/10.** The layering and write-safety design are good enough for a v1.0.0 release. The fail-open retry default, the stale architecture doc, and the B1/B2-unready config model keep the score from going higher.

## What is strong

- **No upward imports.** api→core 15 edges, mcp→api 4 / →core 56, tools→api 17 / →core 9 / →mcp 54. Nothing points against the direction (verified by grep). The core/api/mcp zones are enforced in `eslint.config.js` through `import-x/no-restricted-paths`.
- **Real seams.** `setTimeout`/`setInterval`/`Date.now` are banned outside `src/core/clock.ts` (`eslint.config.js`). DNS resolve-and-pin is injectable (`src/core/http.ts:761-951`). `ApiContext.getAccessToken` is a usable token-provider port (`src/api/context.ts`).
- **`mcp` does not import `tools`.** `createServer` receives `packages` from the entry point (`src/mcp/server.ts:565`, `src/index.ts`). This resolves the round-2 §3.7 coupling concern, even though the names differ from that design.
- **Large files are sectioned.** Even the 1000–1800-line files have clear `// ---` sections (`src/core/http.ts`, `src/tools/publish-common.ts`, `src/cli/doctor.ts`), so the split seams already exist.
- **Round-2 N1/N2/N5 implemented.** Random plan ids, the heartbeat env lock (`src/core/env-lock.ts`) and the versioned journal (`src/mcp/journal.ts`) are all in place.

## Findings

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| ARC-01 | High | Retry/replay class is declared by the caller and defaults to `read`, so a forgotten `retryClass` silently makes a non-idempotent write retryable and 401-replayable. The spec requires classification by a path allowlist in `core/http.ts`, and that table does not exist. | `docs/ARCHITECTURE.md` §6.3; `src/api/context.ts` (`apiRequest` default `'read'`, 401 replay for read); `docs/CONTRACTS.md:722`; only `src/api/publish.ts:722,741,766` pass `'init'`; no path table in `src/core/http.ts` (grep for endpoint paths returns nothing) | Fail closed: classify by `(method, path)` against an allowlist in `core/http.ts`. Unknown POST paths are `init` (no retry, no replay). Make a test fail when an endpoint is not in the table. |
| ARC-02 | High | The config and credential model cannot take B1 (app-level client-credentials token) or B2 (second OAuth provider per profile) without a schema break. Today: one app per installation, the six token keys per profile, `CONFIG_SCHEMA_VERSION = 1`, token caches keyed by profile name only, `API_ORIGIN` and the egress kinds hard-coded. | `src/core/config.ts:63,85-153` (`APP_KEY_NAME`, `TOKEN_KEY_SUFFIX`, `PROFILE_KEY`); `src/core/oauth.ts:476-495,683,703,719,773,844,929`; `src/api/context.ts` (`API_ORIGIN`, hard-wired `login --profile` hint); `src/core/http.ts:147` (`EgressKind`) | Before B1/B2: an ADR plus a provider-aware credential store (`{provider, authKind}` dimension, cache key `(envFile, provider, profile)`), config schema v2 with a migration, and egress kinds per provider. |
| ARC-03 | High | Docs-as-spec has drifted and has no gate. ARCHITECTURE.md describes a bootstrap, a dependency count, a package list, a module tree and a retry mechanism that do not exist. CONTRACTS.md (3616 lines) restates TypeScript signatures that no gate compares with the code. | `docs/ARCHITECTURE.md:4` ("Two runtime dependencies"; `package.json` has 3), §1 tree L12-50 (missing api/embed, api/media, api/webhook, mcp/http, consent, errors, schedule, webhook, tools/analytics, embed, schedule, webhooks, publish-common, publish-photos, cli/run-queue), §2 L84-92 (`new McpServer`, `registerAllTools`, `setServer`, `connectTransport` are not in `src/`), §4 L220 and §5 L266-272 (5 packages vs 7 in `src/core/settings.ts:81-89`, "13 tools" vs 17 in `docs/tool-manifest.json`); `docs/CONTRACTS.md` ToolCtx has no `confirm?: ConsentAsk` (`src/mcp/define.ts:69`); `scripts/sync.ts` has 12 gates and none covers CONTRACTS/ARCHITECTURE | Resync ARCHITECTURE.md now (it is the first thing an auditor or contributor reads). Then cut CONTRACTS.md down to invariants and behaviour, and generate signatures (`tsc --declaration` / API Extractor report) with a drift gate. |
| ARC-04 | Medium | The write pipeline skeleton is copy-pasted four times, so the normative step order lives in four places. Drift is already visible: `executePost` and `executePhotos` wrap `resolveOpenId` in try/catch → `publishToolError`, while the two draft paths do not. The `privacy_level` required message is duplicated. | `src/tools/publish-write.ts:660-765` (executePost), `:904-988` (executeDraft, `resolveOpenId` at `:921`); `src/tools/publish-photos.ts:412-500`, `:651+` (`:666`) | Extract one `executeWrite(spec, hooks)` template into `publish-common.ts` (bucket → source → open_id → digest → expectation → confirm → schedule → guards → dispatch → wait). Each tool then supplies only its payload builder. |
| ARC-05 | Medium | About 14 process-global mutable singletons hold runtime state outside any composition root. Tests need ad-hoc reset functions, two runtimes in one process share state, and B2 per-provider separation is impossible. | `src/tools/publish-batch.ts:54`; `src/tools/publish-common.ts:816`; `src/core/oauth.ts:476,479,495,508`; `src/core/http.ts:1027`; `src/mcp/plan-store.ts:100`; `src/mcp/plan.ts:217-220` (buckets keyed by profile only); `src/mcp/journal.ts:602`; `src/core/redact.ts:214`; `src/core/config.ts:727,738`; `src/core/env-lock.ts:259`; `src/core/settings.ts:734`; `src/cli/index.ts:214` | Move the stateful maps into a `RuntimeState` object created by the composition root and passed through `ServerRuntime`. Process-wide only where that is intended (redaction registry). |
| ARC-06 | Medium | Runtime wiring is duplicated across three composition roots. `run-queue` re-implements the profile mapping and `createApiContext` wiring from `index.ts` line by line, and `doctor` wires its own. `src/index.ts` imports `overlayEnvFile` from `cli/index.js`, which only re-exports `core/config`. | `src/index.ts:45-347` (`startServer`), `:50`; `src/cli/run-queue.ts:341-388` (`buildRuntime`); `src/cli/doctor.ts:675,1277`; `src/cli/index.ts:178` | Extract `src/runtime.ts` (`buildServerRuntime(env, opts)`) used by the server, `run-queue` and `doctor`. Import `overlayEnvFile` from `core/config`. |
| ARC-07 | Medium | ESLint boundaries are incomplete. `tools/` and `cli/` are unrestricted, so the stated rules "tools never import core/http or core/oauth" and "cli reaches the network only through api" are conventions only, and `cli/login.ts` already breaks the second one. | `eslint.config.js` (no zone for tools/cli/`src/index.ts`); `src/cli/login.ts:53,63,813` (`ttRequest` from `core/http`); `src/cli/doctor.ts:55`; `src/cli/run-queue.ts:28`; `docs/ARCHITECTURE.md` §1 L57-60 | Add zones: tools ↛ core/http, core/oauth, cli; cli ↛ core/http except `outboundLookup` (or move that into api). Route login's user-info call through an `api/` function. |
| ARC-08 | Medium | `mcp/` has low cohesion. Protocol glue (server, http, define, result, prompts, resources, completions, subscriptions, lifecycle) sits next to write-safety domain and persistence (plan, plan-store, journal, schedule, consent) and an HTTP webhook receiver. "MCP glue" is now the second domain layer. | `src/mcp/plan.ts`, `plan-store.ts`, `journal.ts` (965 lines), `schedule.ts`, `consent.ts`, `webhook.ts` (451 lines); `src/cli/run-queue.ts` must import `mcp/` to run a queue without MCP | Introduce `src/write/` (plan, plan-store, journal, schedule, consent) between api and mcp, with its own eslint zone. Move `webhook.ts` beside `mcp/http.ts` under a `transport/` subfolder or keep it but document it. |
| ARC-09 | Medium | Five files are above 1100 lines and mix independent concerns. Change risk and review cost concentrate there. | `src/core/http.ts` 1807 (egress allowlist L62/L629, DNS L761-951, host slots L1014-1027, retry L1208, envelope decoder L1304, oauthRequest L1540, putChunk L1659); `src/cli/doctor.ts` 1392 (checks L278-984); `src/tools/publish-common.ts` 1348 (error catalog L276, hints L445, plan lifecycle L747, dispatch L990); `src/cli/login.ts` 1277 (callback server L332-604); `src/core/oauth.ts` 1135 (refresh L580-948, revoke L982-1135) | Split along the existing sections: `core/http/{egress,dns,transport,retry,envelope}.ts`; `cli/doctor/checks/*.ts`; `tools/publish-errors.ts` (catalog + hints); `cli/login-callback.ts`; `core/oauth-refresh.ts`. Behaviour-neutral, barrel re-exports. |
| ARC-10 | Medium | Accidental complexity is out of proportion to verified value: ~28k src lines, ~15.7k doc lines, 12 sync gates (7009 script lines) and v1.1–1.3 features (scheduling, batch, webhooks, analytics, embed, elicitation consent) built while probes P-1..P-14 are all "not run" and nothing has been published. Each unverified assumption about TikTok behaviour is now repeated across several modules. | `docs/probes/PROBE-LOG.md`; `CHANGELOG.md` [Unreleased]; `scripts/` | Freeze the feature surface (no B1/B2 code) until the Phase-2 real E2E and the probes have run. Fix the code against the probe results first. |
| ARC-11 | Low | `resolveOpenId` returns `''` when the profile is unknown, so a plan can be bound to an empty `open_id` (impact unverified; guards may catch it later). | `src/tools/publish-common.ts:675-678` | Throw a typed `profile_not_found` error. |
| ARC-12 | Low | Round-2 points partly open. N4 "one reload path (`core/config-store.ts`)": no such module; credentials are re-read in `src/index.ts` (`readProfiles`), `src/mcp/lifecycle.ts` (credential watch) and `src/core/oauth.ts` separately. §3.9 recommended `wait_for_completion` default true, ARCHITECTURE §8.2 now says false (design reversed, not recorded as a decision). §3.7 names (`registerAllTools`, `mcp/registry.ts`) are superseded, but ARCHITECTURE still shows them. N6 refine hook: not verified. | `docs/reviews/round2/architecture-deep-review.md` §3.7, §3.9, N4, N6; `src/mcp/lifecycle.ts:47` | Record the §3.9 reversal as an ADR line. Fold the reload path into ARC-R5's runtime module. |

### ARC-01 — Retry class fails open

**What.** `apiRequest` in `src/api/context.ts` takes a caller-supplied `retryClass` that defaults to `'read'`. Read requests are retried on 5xx and network errors and replayed once after a 401 refresh. Only the three publish init calls (`src/api/publish.ts:722,741,766`) opt out. `docs/ARCHITECTURE.md` §6.3 (and round-2 §3.3/A1 `classifyRequest`) specify the opposite: classification by a path allowlist in `core/http.ts`, "never by HTTP method alone". `docs/CONTRACTS.md:722` documents the default as it is now, which turns the divergence into a contract.

**Why it matters.** Idempotency is a safety property, and a safety property should not depend on every future caller remembering a flag. B2 adds non-idempotent writes (comment reply and hide), and B1 adds a new API family.

**Failure scenario.** A B2 `replyToComment` POST is added without `retryClass`. TikTok answers 502 after it has committed the reply, or the socket resets after the request is sent. The engine retries, and the user's account posts the same reply two or three times. The plan/journal duplicate guard does not see this because it sits above the transport retry.

**Fix.** Put a `(method, path) → class` table in `core/http.ts` (or `api/endpoints.ts`). Known reads → `read`, upload chunk PUT → `chunk`, publish/init and every unknown non-GET → `init` (no retry, no 401 replay). The caller can only make the class stricter, never looser. Add a test that walks every `api/*` endpoint constant and fails if one is not in the table. Update CONTRACTS.md:722 and ARCHITECTURE §6.3 to match.

### ARC-02 — Config and token model not ready for B1/B2

**What.** `src/core/config.ts:85-153` treats the TikTok app as one per installation (`TT_CLIENT_KEY/TT_CLIENT_SECRET`, commented "never per profile — one app, many accounts"). Profiles are a fixed six-key token suffix set, and the schema is v1. In `src/core/oauth.ts`, the adopted-token cache, the single-flight refresh map and `spentTokens` are keyed by profile name only (`:476-495`, used at `:683,703,719,773,844,929`). `src/api/context.ts` hard-codes `https://open.tiktokapis.com` and a `login --profile` recovery hint. `EgressKind` (`src/core/http.ts:147`) knows only api, upload and oembed.

**Why it matters.** The roadmap's B1 needs a client-credentials token that belongs to the app, not to a profile, is EU-only, and has its own refresh semantics. B2 needs a second OAuth provider per profile (Business API, `business_id = open_id`), on a different host, with different scopes. Neither fits. B2 is already labelled "2.0, owns settings/config hotspot", but no design exists, so the break would be designed inside a 30 h feature item.

**Failure scenario.** B2 is implemented by adding `TT_PROFILE_X_BIZ_*` keys and reusing the profile-keyed caches. The Display token and the Business token for the same profile collide in `adopted`/`inFlight`: a refresh of one invalidates or overwrites the other, and a revoke webhook (`forgetRevokedProfile`) wipes both. The bug only shows with real tokens, which the mock-only test suite cannot catch.

**Fix.** Do ARC-R7 before B1/B2. It covers: an ADR for the credential model; a `CredentialKey = {envFile, provider, subject}` used by every cache; config schema v2 with a migration and a `doctor` check; `ApiContext` parameterized by provider (origin, egress kind, auth-expired hint). The v1 file format stays readable.

### ARC-03 — Docs-as-spec drift with no gate

**What.** Concrete drift between ARCHITECTURE.md and the code:
- dependency count (2 stated, 3 in `package.json`);
- module tree (about 15 modules missing);
- the §2 bootstrap snippet, which names four APIs that do not exist in `src/`;
- package and tool counts (5/13 stated vs 7/17 actual);
- the §6.3 retry mechanism (ARC-01);
- the §1 claim that the cli reaches the network only through api (ARC-07).

CONTRACTS.md restates exported TypeScript shapes by hand. It already lacks `ConsentAsk` and `ToolCtx.confirm` (`src/mcp/define.ts:69`) and still says "13 tools". `scripts/sync.ts` runs 12 gates (manifest, readme, env-docs, pack-audit, server.json, site, cc-coverage, tools-doc, floors-doc, doctor-doc, ignore-hints, build-freshness), and none of them covers these two documents. CONTRACTS.md changed in 21 of 87 commits.

**Why it matters.** These two documents are the project's design authority, and the agents building the roadmap read them first. Contributors and reviewers (including the TikTok audit) will trust them. A spec that is wrong in checkable places teaches readers to ignore it, and the hand-maintained part costs a share of every change.

**Failure scenario.** An autonomous session implementing B2 follows ARCHITECTURE §6.3 and assumes `core/http` classifies the new endpoint path. It adds no `retryClass`, the reply is retried (ARC-01), and review passes because the code "matches the architecture doc".

**Fix.** ARC-R2 (release-blocking) resyncs ARCHITECTURE.md with the code and records the §3.9 reversal. ARC-R3 turns CONTRACTS.md into invariants plus a generated API report, with a gate that fails on drift.

## Open questions for the owner

1. Is B2 (Business API, 2.0 break) still the plan? If yes, do you accept ARC-R7 (credential-model ADR + schema v2) as a hard prerequisite, even though B2 itself is owner-blocked?
2. Is CONTRACTS.md meant to stay a hand-written normative spec (then it needs a gate), or may it shrink to invariants with generated signatures?
3. Feature freeze: will you stop merging new tool surface until the probes P-1..P-14 and the Phase-2 real E2E post have run?
4. Do you want `src/write/` (moving plan/journal/schedule/consent out of `mcp/`) before 1.0.0, or after the first publish to avoid churn?
5. `wait_for_completion` default: confirm `false` as the decision (round-2 §3.9 recommended `true`).

## Proposed roadmap items

#### ARC-R1 — Classify retry class by endpoint table, failing closed
Deps — · Status todo · Est 4 h

- **Scope:** **Release-blocking.** Replace the caller-declared `retryClass` default with a `(method, path)` table: known reads → `read`, chunk PUT → `chunk`, every other non-GET (including unknown) → `init`. Callers may only make the class stricter. 401 replay only for `read`.
- **Owns:** `src/api/endpoints.ts` (new), `test/api/endpoints.test.ts` (new)
- **Shared:** `src/api/context.ts`, `src/core/http.ts`, `src/api/publish.ts`, `src/api/embed.ts`, `docs/CONTRACTS.md` (api/context section, L722), `docs/ARCHITECTURE.md` §6.3
- **Acceptance:**
  - An `apiRequest` POST to an unlisted path is not retried on 503 or network reset and is not replayed after a 401 (test).
  - A test enumerates every endpoint used in `src/api/*.ts` and fails if one is missing from the table.
  - No `retryClass: 'read'` default remains in `src/api/context.ts`.
  - `npm run check` green.

#### ARC-R2 — Resync ARCHITECTURE.md with the built system
Deps — · Status todo · Est 3 h

- **Scope:** **Release-blocking.** Rewrite §1 module tree, §2 bootstrap (real `createServer`/`connectStdio`/http path), §4/§5 package and tool lists (7 packages, 17 tools), dependency count, §6.3 (after ARC-R1, or mark it pending), §1 network rule. Record the `wait_for_completion=false` decision (reversal of round-2 §3.9) and the superseded §3.7 names.
- **Owns:** `docs/ARCHITECTURE.md`
- **Shared:** —
- **Acceptance:**
  - Every module path named in ARCHITECTURE.md exists (`ls` check). Every `src/**/*.ts` module appears in the tree.
  - No identifier in a code block is missing from `src/` (grep for `registerAllTools`, `setServer`, `connectTransport`, `new McpServer` returns 0).
  - Counts match `package.json` dependencies, `TOOL_PACKAGES` and `docs/tool-manifest.json`.

#### ARC-R3 — Gate CONTRACTS.md against the code
Deps ARC-R2 · Status todo · Est 6 h

- **Scope:** Generate the public signature report (API Extractor or `tsc --declaration` digest) into `docs/api-report/`. Replace the restated signatures in CONTRACTS.md with links to it, keeping invariants and behaviour. Add a `contracts-sync` gate to `scripts/sync.ts` that fails on drift. Add `ConsentAsk` / `ToolCtx.confirm`.
- **Owns:** `docs/api-report/*` (new), `scripts/contracts-sync.ts` (new)
- **Shared:** `docs/CONTRACTS.md`, `scripts/sync.ts`, `package.json` (script/devDependency)
- **Acceptance:**
  - Changing an exported type without regenerating fails `npm run check`.
  - CONTRACTS.md contains no hand-copied `interface`/`type` blocks that duplicate exported code.
  - CONTRACTS.md line count drops by at least 40 %.

#### ARC-R4 — Extract one executeWrite pipeline for the four write tools
Deps — · Status todo · Est 5 h

- **Scope:** Add `executeWrite(spec, hooks)` to `publish-common.ts`. It owns the ordered steps (bucket, source, open_id with uniform error mapping, privacy check, digest, expectation, confirm, schedule, guards, dispatch, wait). Port executePost, executeDraft, executePhotos and executePhotosDraft to it. Fix the `resolveOpenId` error-handling drift and the `''` fallback (ARC-11).
- **Owns:** —
- **Shared:** `src/tools/publish-common.ts`, `src/tools/publish-write.ts`, `src/tools/publish-photos.ts`, related tests
- **Acceptance:**
  - The step sequence exists in exactly one function (grep: `runPlanGuards(` and `dispatchWrite(` each called only from `executeWrite`).
  - Unknown profile returns the same typed error from all four tools (test).
  - Manifest snapshot unchanged. `npm run check` green with coverage floors held.

#### ARC-R5 — Build the runtime in one composition module
Deps — · Status todo · Est 3 h

- **Scope:** Extract `src/runtime.ts` `buildServerRuntime(env, opts)` (settings, logger, lookup, profiles, `createContext`, credential reload). Use it from `src/index.ts`, `src/cli/run-queue.ts` (with `writeMode: 'plan'`) and `src/cli/doctor.ts`. Import `overlayEnvFile` from `core/config` directly.
- **Owns:** `src/runtime.ts` (new), `test/runtime.test.ts` (new)
- **Shared:** `src/index.ts`, `src/cli/run-queue.ts`, `src/cli/doctor.ts`, `src/cli/index.ts`
- **Acceptance:**
  - `createApiContext(` is called only in `src/runtime.ts` (grep).
  - `src/index.ts` does not import from `./cli/`.
  - Server, `run-queue` and `doctor` tests pass unchanged.

#### ARC-R6 — Enforce tools/ and cli/ boundaries in ESLint
Deps — · Status todo · Est 2 h

- **Scope:** Add `no-restricted-paths` zones: `src/tools` ↛ `core/http`, `core/oauth`, `src/cli`; `src/cli` ↛ `core/http` (move `outboundLookup` behind `api/` or allow it by named import only). Move login's user-info `ttRequest` call into an `api/` function.
- **Owns:** —
- **Shared:** `eslint.config.js`, `src/cli/login.ts`, `src/cli/doctor.ts`, `src/cli/run-queue.ts`, `src/api/*` (one new function)
- **Acceptance:**
  - A deliberate `import { ttRequest } from '../core/http.js'` in `src/tools/` or `src/cli/` fails lint (fixture or test).
  - `grep "core/http" src/cli src/tools` returns only the allowed import.
  - `npm run check` green.

#### ARC-R7 — Design a provider-aware credential model before B1/B2
Deps — · Status todo · Est 8 h

- **Scope:** ADR plus implementation of the store foundations: a `CredentialKey {envFile, provider, subject}` used by every token cache in `core/oauth.ts`; config schema v2 with provider/auth-kind per profile and an app-level client-credentials slot; a v1→v2 migration that only reads v1; a provider-parameterized `ApiContext` (origin, egress kind, auth-expired hint). Prerequisite for B1 and B2, not release-blocking for 1.0.0.
- **Owns:** `docs/adr/credential-model.md` (new), `src/core/credentials.ts` (new)
- **Shared:** `src/core/config.ts`, `src/core/oauth.ts`, `src/api/context.ts`, `src/core/http.ts` (EgressKind), `src/cli/doctor.ts`, `docs/CONTRACTS.md`, `docs/ROADMAP.md` (B1/B2 deps)
- **Acceptance:**
  - Two providers for the same profile name refresh and revoke independently (test).
  - A v1 env file loads unchanged, and `doctor` reports the schema version.
  - No `Map` in `core/oauth.ts` is keyed by a bare profile string.
  - B1 and B2 list ARC-R7 in their Deps.

#### ARC-R8 — Move write-safety modules out of mcp/
Deps ARC-R4 · Status todo · Est 4 h

- **Scope:** Create `src/write/` with plan, plan-store, journal, schedule and consent (the protocol-specific elicitation adapter stays in `mcp/`). Add an ESLint zone: `write` may import core/api, not mcp/tools/cli.
- **Owns:** `src/write/*` (moved files)
- **Shared:** `src/mcp/*` imports, `src/tools/*` imports, `src/cli/run-queue.ts`, `eslint.config.js`, `docs/ARCHITECTURE.md`
- **Acceptance:**
  - `src/cli/run-queue.ts` imports nothing from `src/mcp/`.
  - `src/write/` has no imports from `mcp`, `tools` or `cli` (lint-enforced).
  - All tests pass without changing assertions.

#### ARC-R9 — Split core/http.ts and cli/doctor.ts along their sections
Deps ARC-R1 · Status todo · Est 5 h

- **Scope:** Make behaviour-neutral splits:
  - `core/http.ts` → `core/http/{egress,dns,transport,retry,envelope,index}.ts`
  - `cli/doctor.ts` → `cli/doctor/{checks/*,render,index}.ts`
  - `publish-common.ts` error catalog and hints → `tools/publish-errors.ts`
  - `cli/login.ts` callback server → `cli/login-callback.ts`

  Keep the public import paths through barrels.
- **Owns:** the new split files
- **Shared:** `src/core/http.ts`, `src/cli/doctor.ts`, `src/tools/publish-common.ts`, `src/cli/login.ts`, `eslint.config.js` (paths), `scripts/sync.ts` (doctor-doc gate paths if affected)
- **Acceptance:**
  - No file in `src/` exceeds 900 lines.
  - The manifest snapshot and all sync gates are unchanged.
  - Coverage floors are held.

#### ARC-R10 — Own mutable runtime state in a RuntimeState object
Deps ARC-R5 · Status todo · Est 6 h

- **Scope:** Replace the module-level Maps with fields of a `RuntimeState` created in `buildServerRuntime` and threaded through `ServerRuntime`: publish-batch `itemPlans`, publish-common `inFlight`, oauth `adopted`/`inFlight`/`spentTokens`, http `hostSlots`, plan-store `plans`, plan `buckets`, journal fold cache. Remove the `reset*` test hooks. The redaction registry stays process-wide by design.
- **Owns:** `src/core/runtime-state.ts` (new)
- **Shared:** files listed in ARC-05, `src/runtime.ts`, tests that use reset hooks
- **Acceptance:**
  - Two runtimes created in one test process do not share plans, buckets or token caches (test).
  - `grep -n "^const .* = new Map" src/` returns only allow-listed process-wide registries.
  - `npm run check` green.

**Top recommendation:** Before writing any more feature code, make retry classification fail closed (ARC-R1) and bring ARCHITECTURE.md back in line with the code (ARC-R2), then freeze the feature surface until real TikTok probes have run and the credential-model ADR (ARC-R7) exists.
