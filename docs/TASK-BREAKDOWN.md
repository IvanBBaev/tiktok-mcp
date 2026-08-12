# Task breakdown for parallel agent development

Decomposition of `docs/IMPLEMENTATION-PLAN.md` into tasks small enough for one
agent each, designed so that tasks inside a batch can run **concurrently**
without merge conflicts or design drift.

## Operating model

**Roles.**

- **Worker agent** — implements exactly one task: only its owned files,
  exactly the contracts in `docs/CONTRACTS.md`.
- **Integrator** (the main session + the human) — spawns batches, merges
  results, runs `npm run check`, arbitrates contract-change requests,
  executes the tasks marked *integrator* (real-account smokes, sandbox
  probes, releases).

**Three rules that make parallelism safe.**

1. **File ownership is exclusive.** Every task lists its owned files; no two
   tasks in the same batch share a file. An agent that believes a foreign
   file must change **stops and reports** — it never edits it.
2. **Contracts over conversation.** Tasks depend on each other only through
   `docs/CONTRACTS.md` (frozen at the end of Wave B). A worker who finds a
   contract wrong proposes a change to the integrator; it never silently
   diverges.
3. **Specs are the input, reviews are history.** After Wave A, workers read
   the spec docs (`docs/*.md`) only. `docs/reviews/**` (incl. SYNTHESIS.md)
   stays authoritative for *why*, but implementation must not require
   archaeology there — that is what Wave A guarantees (gap G-13).

**Definition of done (every task).** Owned files implemented + tested (test
names cite the task's CC ids); `npm run check` green (typecheck, lint, tests,
coverage — once TB-1/TB-2 exist); no edits outside owned files; deviations
reported, not improvised. Docs tasks: doc reads standalone, no contradiction
with SYNTHESIS.md.

**Repo conventions (bind every agent).** Everything in the codebase is
English. No AI attribution in any artifact. Workers never run `git commit` /
`git push` — the integrator commits, and only when the human asks.

---

## Wave map

```
Wave A (8 parallel)  — spec reconciliation: docs state the synthesis outcomes
Wave B (1, then 8)   — repo scaffold, then the entire core/ foundation
Wave C (2+3+1+1)     — auth, CLIs, MCP layer, read tools → Phase-1 exit gate
Wave D (3+2+1+1)     — publish spine, journal, upload → Phase-2 exit gate
Wave E (4+1+1)       — release engineering, user docs, audit → v1.0
```

Wave N+1 starts only after the integrator has merged Wave N and its gate is
green. Batches inside a wave are listed per task (`after:`).

---

## Wave A — spec reconciliation (all 8 in parallel)

One doc per task ⇒ zero ownership conflicts. Source for every task:
`docs/reviews/round2/SYNTHESIS.md` (binding, § references below) + the round-2
review named in the task. SYNTHESIS § 4 backlog items 1–9 map here.
(Backlog items 10–11 — CORNER-CASES.md close-outs and IMPLEMENTATION-PLAN.md
maintenance — are already applied by the maintainer.)

| Task | Owned doc | Scope (normative inputs) | Size |
|---|---|---|---|
| TA-1 | `docs/TOOLS.md` | Full replacement with the v1.1 surface: 11 tools / 5 packages, names `tiktok_get_auth_status` / `tiktok_get_creator_info`, **`apply` boolean deleted** (plan_id presence = execute; `mode:"plan_incomplete"`), all four annotation hints per tool, hints closed vocabulary (six types — this task narrows `HintType` in CONTRACTS.md §mcp/result as its one sanctioned contract edit), error catalog with normative texts, `wait_for_completion` defaults (§ 2.3), journal read tool. Inputs: SYNTHESIS § 2.3, § 2.8, § 2.9; round-2 AI/DX review § 3. | L |
| TA-2 | `docs/ARCHITECTURE.md` | Rewrite § 7 (write safety) + § 8 (concurrency/persistence): plan store semantics, journal WAJ design, env-file lock, three-class retry matrix, redaction moved to `core/redact`, module layout incl. `core/json`, `core/env-lock`, `mcp/plan-store`, `mcp/journal`. Inputs: SYNTHESIS § 2.2, § 2.7, § 2.8, § 2.13. | L |
| TA-3 | `docs/TIKTOK-API.md` | Chunk algorithm section replaced with the decimal algorithm **verbatim** (round-2 platform § 4.1; vectors V1–V8); upload-host section (exact hosts + anchored regional pattern); chunk-PUT retry semantics (5xx retryable, 416 resync, 403 expired); resolve remaining `(verify at implementation time)` markers into probe references (P-1..P-16). Inputs: SYNTHESIS § 2.4, § 2.5, § 2.13, § 6. | M |
| TA-4 | `docs/TESTING.md` | Strike the wrong "5–64 MB per chunk" invariant → bounds/contiguity/sum properties + V1–V8 fixture; document harness seams (mock clock, fetch stub, fs sandbox, multi-process lock test); CI matrix (ubuntu×{22,24}, macos×24, windows×24, advisory 26); stdout-purity test; probe log convention for WP-2.6/TD-7. Inputs: SYNTHESIS § 2.4, § 2.13b; round-2 QA review. | M |
| TA-5 | `docs/SECURITY.md` | Egress allowlist spelled exactly (§ 2.5, endsWith ban, upload_token secret sink, no bearer on PUTs); DNS resolve-and-pin **deferred** note + compensating controls + P-15 spike; redaction-in-core; TT_WRITE_MODE=apply documented with the verbatim "trusted automation only: this mode has no injection resistance"; elicitation demoted to optional post-v1 with an honest residual-risk note. Inputs: SYNTHESIS § 2.5, § 2.6, § 2.8; round-2 security review. | M |
| TA-6 | `docs/CONFIGURATION.md` | Add all synthesis env vars (TT_PLAN_TTL_S, TT_PLAN_MAX_OUTSTANDING, TT_ENV_LOCK_*, TT_JOURNAL_MAX_BYTES, TT_CHUNK_RETRIES, TT_LOCK_PROFILE, TT_CONFIG_SCHEMA, TT_VERIFIED_URL_PREFIXES advisory-only, TT_MEDIA_ROOT fail-closed); Windows path resolution (%LOCALAPPDATA%) + 0600 semantics per platform; TT_REDIRECT_PORT as optional pin; TT_WRITE_MODE three values. Keep the var table 1:1 with CONTRACTS.md §core/settings. Inputs: SYNTHESIS § 2.1, § 2.2, § 2.8, § 2.12. | M |
| TA-7 | `docs/AUTH.md` | Hex-PKCE pinned test vector; wildcard-port loopback flow (`http://127.0.0.1:*/callback/`, trailing slash, byte-identical redirect_uri, bind 127.0.0.1:0, prefer 127.0.0.1 / no ::1); TT_REDIRECT_PORT as pin; revoke semantics (§ 2.10 — journal kept, `--purge-journal` explicit); env-lock interaction of refresh (adopt-rotated-token path). Inputs: SYNTHESIS § 2.2, § 2.10, § 2.11, § 5 (CC-A13). | M |
| TA-8 | `README.md` + `docs/ROADMAP.md` | README: 11-tool table, Node ≥ 22 (.nvmrc 24), quickstart with plan/execute (no `apply`), unofficial-status disclaimer (G-2, README half), "MIT" pointing at the LICENSE file TB-1 creates; ROADMAP: refresh phase blurbs to match the updated plan (probes, Windows CI, tool names). Inputs: SYNTHESIS § 2.9, § 2.13b; IMPLEMENTATION-PLAN "Road to v1.0". | M |

**Wave-A gate (integrator):** cross-read for contradictions (esp. tool names,
env-var table vs CONTRACTS.md, chunk numbers); no doc references a review for
normative content.

---

## Wave B — foundation (TB-1 solo, then TB-2..TB-9 in parallel)

Implements WP-0.1–0.6. After merge, `docs/CONTRACTS.md` is **frozen**.

**TB-1 — repo scaffold** · size S · after: Wave A
Owned: `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`,
`.editorconfig`, `.nvmrc` (24), `.gitignore`, `LICENSE` (MIT — G-1), empty
`src/`/`test/` layout. Also: `git init` + `.git/info/exclude` entries for
`CLAUDE.md`, `CLAUDE.local.md`, `WORKLOG.md`, `.claude/`, `docs/ai/` (local
AI-harness files only — `docs/*.md` design docs and `docs/reviews/**` ARE
committed). `package.json` description carries the unofficial-status
disclaimer (G-2, npm half). ESLint: 4-layer `no-restricted-imports` +
`no-console`. DoD: `npm run check` scripts wired (green with zero tests).

Then in parallel (all `after: TB-1`; test obligations cite CC ids):

| Task | Owned files | Contract produced | CCs / notes | Size |
|---|---|---|---|---|
| TB-2 | — (reconcile only) | — | `.github/workflows/ci.yml` is delivered by the presentation build (see § "Presentation build" note). TB-2 reduces to reconciling that workflow to the canonical **blocking matrix ubuntu×{22,24}, macos×24, windows×24; advisory ubuntu×26 (no coverage)** and wiring the coverage gate once tests exist. | S |
| TB-3 | `src/core/errors.ts`, `src/core/log.ts` + tests | core/errors, core/log | CC-B9, CC-G3 (stderr-only) | M |
| TB-4 | `src/core/redact.ts` + tests | core/redact | Allowlist default-deny; registered-secret scrub | S |
| TB-5 | `src/core/json.ts`, `src/core/clock.ts` + tests | core/json (canonicalJson — THE one), core/clock | absent≡undefined≡omitted property tests | S |
| TB-6 | `test/helpers.ts`, `test/harness/**` + self-tests | test harness | mockClock.advance never sleeps (CC-H4); `FetchStub`/`scriptFetch`; fs sandbox; `test/harness/**` holds the heavier fixtures (chunked-upload simulator, refresh-worker double, multi-process lock helper) consumed by later waves | M |
| TB-7 | `src/core/settings.ts`, `src/core/config.ts` + tests | core/settings, core/config | CC-F1–F4, CC-F6, CC-A2 (write path), CC-H3 (win32 degrade) | L |
| TB-8 | `src/core/env-lock.ts` + multi-process test | core/env-lock | CC-F5, CC-A2; real two-process stale/heartbeat test | L |
| TB-9 | `src/core/http.ts` + tests | core/http | CC-A12, CC-B1–B9, CC-H1, CC-H2; allowlist per § 2.5; lookup seam | L |

**Wave-B gate:** `npm run check` green on all four OS legs; coverage gate
active; CONTRACTS.md frozen (changelog entry).

---

## Wave C — auth + MCP + read surface (Phase 1)

| Task | After | Owned files | Scope / CCs | Size |
|---|---|---|---|---|
| TC-1 | Wave B | `src/core/oauth.ts` + tests | PKCE (hex, pinned vector), exchange, single-flight refresh, rotation-before-use, invalid_grant adopt-then-terminal. CC-A1–A7, CC-A12, CC-A13 | L |
| TC-4 | Wave B (parallel with TC-1) | `src/mcp/define.ts`, `src/mcp/result.ts`, `src/mcp/server.ts`, `src/tools/index.ts` + tests | ToolSpec, PACKAGES manifest, `.strict()`, result envelope + valid-JSON truncation, `[UNAVAILABLE]` startup-static, stdout-purity test. CC-G1–G3, CC-G7 | L |
| TC-2 | TC-1 | `src/cli/login.ts`, `src/cli/index.ts` + tests | Loopback (wildcard-port, single-accept, state constant-time), manual-paste fallback, profile overwrite confirm, **`--revoke` (+ `--purge-journal`) — G-5, § 2.10**. CC-A8–A11 | L |
| TC-3 | TC-1 | `src/cli/doctor.ts` + tests | Config/permissions/expiry checks, win32 icacls remediation text, journal reconciliation listing (reads via mcp/journal contract; stub until TD-3 merges). **Owns the doctor check-list**: the full ordered set of health checks is defined here; other tasks contribute a check only by registering one, never by editing `doctor.ts` out from under this owner. CC-A5, CC-F3, CC-E10 | M |
| TC-5 | TC-4 | `src/api/context.ts`, `src/api/user.ts`, `src/api/video.ts`, `src/tools/auth.ts`, `src/tools/user.ts`, `src/tools/video.ts` + tests | Read tools incl. `tiktok_get_auth_status`; cursor rules, `missing_ids`. CC-C1–C7 | M |
| TC-6 | TC-4, TC-5 | `scripts/` (manifest snapshot, readme-sync, env-docs-sync, .env.example gen, **coverage-floor gate**) + tests | Sync gates wired into `npm run check`. NOTE: the presentation build already ships a hand-written `.env.example` and a hand-written README tools table (between the `GENERATED:TOOLS` markers); TC-6 replaces both with generators + drift gates that must reproduce them byte-for-byte from the live tool registry. **Added by the integrator after TC-2:** (a) the per-directory coverage-floor gate of TESTING.md § "Coverage floors and ratchet" is owned here — it was unowned; (b) `npm run check` must grow to `typecheck → lint → format:check → build → test → coverage → sync gates`, which TESTING.md already claims it is; (c) a drift gate asserting `PACKAGE_SCOPES` in `src/cli/login.ts` equals, per package, the union of `ToolSpec.scopes` over the live manifest — `login` cannot import the manifest (it must not load the MCP SDK), so the two are kept equal by a gate rather than by construction. | M |
| TC-7 | all C | — (integrator + human) | Phase-1 exit gate: real-account login, reads via MCP Inspector | S |

---

## Wave D — publishing (Phase 2)

| Task | After | Owned files | Scope / CCs | Size |
|---|---|---|---|---|
| TD-1 | Wave C | `src/api/publish.ts` + tests | creator_info + local validation (privacy options, brand×SELF_ONLY, UTF-16 caps, interaction flags, photo bounds), init/status calls. CC-E1–E4, CC-E9 | M |
| TD-2 | Wave C (parallel with TD-1) | `src/mcp/plan-store.ts`, digest glue in `src/mcp/plan.ts` + tests | mintPlanId/consumePlan per contract; canonicalJson digest over fully resolved payload; TT_WRITE_MODE; local token bucket (6/min, refill 1/10 s, `local_rate_limited` + absolute retry_at — § 2.12). CC-E7, CC-B8, CC-G5 | L |
| TD-3 | Wave C (parallel) | `src/mcp/journal.ts`, journal read tool in `src/tools/publish.ts` (read half) + tests | WAJ two-record protocol, O_APPEND, fsync-on-intent, rotation, torn-tail, duplicate guard, send_ambiguous→unknown presentation. CC-B5, CC-E10 | L |
| TD-4 | TD-1, TD-2, TD-3 | `src/tools/publish-write.ts` (video post + status tool half) + tests | `tiktok_post_video` (PULL_FROM_URL), `tiktok_get_publish_status` (+wait_for_completion, terminal-beats-deadline, timeout-not-error), pipeline order § 2.8 (re-resolve → digest → consume → intent → init). CC-D10, CC-E5, CC-E6, CC-E8 | L |
| TD-5 | TD-1 (parallel with TD-4) | `src/api/upload.ts` + tests | planChunks (pure, V1–V8 property fixture), TT_MEDIA_ROOT confinement, streaming chunk PUTs + per-chunk retry + abort, re-stat on execute. CC-D1–D9, CC-A3, CC-G4 | L |
| TD-6 | TD-4, TD-5 | draft + photo tools in `src/tools/publish-write.ts` (second half) + tests | `tiktok_upload_video_draft`, photo post tools (PULL_FROM_URL-only). CC-E6, CC-E9, CC-D10 | M |
| TD-7 | all D | `docs/probes/PROBE-LOG.md` (integrator + human) | Execute sandbox probes P-1..P-14, record results, fold any surprises back via contract-change process; Phase-2 exit gate incl. live CC-E7 demo | M |

---

## Wave E — release & v1.0 (Phase 3 + gap list)

| Task | After | Owned files | Scope | Size |
|---|---|---|---|---|
| TE-1 | Wave D | `.github/workflows/release.yml`, `scripts/release-guard.*`, `CHANGELOG.md` | npm trusted publishing (OIDC) + provenance; tag==version==server.json==CHANGELOG guard; keep-a-changelog policy (G-10); deprecation policy text (G-11) | M |
| TE-2 | Wave D (parallel) | `.github/workflows/codeql.yml`, `.github/dependabot.yml`, root `SECURITY.md` | Scanning + disclosure policy | S |
| TE-3 | Wave D (parallel) | `server.json`, `.claude-plugin/` | MCP registry entry + publish sequencing; Claude Code plugin manifest | M |
| TE-4 | Wave D (parallel) | `docs/SETUP-TIKTOK-APP.md` (G-3), `docs/CLIENTS.md` (G-6), `docs/TROUBLESHOOTING.md` (G-7), uninstall section (G-8), `CONTRIBUTING.md` (G-9) | User-facing operator docs; verifies the G-2 disclaimer is present in README + npm | M |
| TE-5 | TE-1..TE-4 | — (integrator + human) | RC checklist: `npx` install smoke on 3 OS (G-12); Privacy Policy + ToS live URLs tracked (G-4 — human deliverable); npm 0.x → 1.0; TikTok audit **submission** | M |
| TE-6 | any time after Wave C | `src/mcp/lifecycle.ts` + tests | Scope/`[UNAVAILABLE]` v2: credential-store watch + `tools/list_changed` (WP-3.5). CC-A7 | M |
| TE-7 | Wave C (parallel with Wave D) | `src/mcp/http.ts` + tests, transport branch in `src/index.ts` | **Streamable HTTP transport — CC-G6.** `TT_TRANSPORT=http` currently refuses to start (`src/index.ts`), while README § env table, CONFIGURATION.md § transport and SECURITY.md already document it as a shipped feature: the gap must close before v1.0 or the docs must retract it. Owns `StreamableHTTPServerTransport` wiring, `TT_HTTP_HOST`/`TT_PORT` bind, the mandatory `TT_HTTP_TOKEN` bearer (constant-time compare over fixed-length digests; startup refusal when absent — loopback included), `Origin`/`Host` validation on every request (DNS-rebinding defense), the non-loopback TLS / `TT_HTTP_INSECURE=1` acknowledgement, and per-session isolation of the mcp runtime. `TT_HTTP_TOKEN` stays a registered secret and reports as `<redacted>`. **Added by the integrator after TC-2** — CC-G6 had no owner. | L |

**v1.0 gate:** IMPLEMENTATION-PLAN "Road to v1.0" definition satisfied;
G-1..G-13 all closed or explicitly tracked (G-4).

---

## Agent briefing template

Spawn each worker with this prompt skeleton (fill the ⟨…⟩):

```
You are implementing task ⟨ID⟩ of the tiktok-mcp-ai project
(/Users/ivanbaev/Development/tiktok-mcp).

Read, in order:
1. docs/TASK-BREAKDOWN.md — your entry ⟨ID⟩ (scope, owned files, CCs, DoD)
2. docs/CONTRACTS.md — the interfaces you must produce and consume
3. Your spec inputs: ⟨docs listed in the task entry⟩
4. docs/CORNER-CASES.md — the CC ids your entry cites
(SYNTHESIS.md § references are for rationale only; the spec docs are your
source of truth.)

Hard rules:
- Edit ONLY your owned files: ⟨list⟩. If any other file must change, STOP
  and report the needed change instead of making it.
- Implement the CONTRACTS.md signatures exactly. If a contract is wrong or
  incomplete, report a proposed change — do not silently diverge.
- Everything you write is English. No AI attribution. Never run git
  commit/push.
- Tests: node:test + the test/helpers contract; test names cite CC ids
  (e.g. "cc-a1 rotation persisted before first use"); no real sleeps —
  mock clock only; no real network — fetch stub only.

Done means: your task's DoD; `npm run check` green; report exactly what you
implemented, every deviation you propose, and the real test output.
```

## Integrator checklist (per wave)

1. Spawn the wave's parallel batch (one Agent per task, single message).
2. On completion: review each report; apply approved contract changes to
   CONTRACTS.md (+ changelog row); reject silent divergence.
3. Merge, run `npm run check` (all OS legs via CI once TB-2 exists).
4. Run the wave gate; append a WORKLOG.md entry; only then open the next wave.
5. Commit/push only when the human explicitly asks.
