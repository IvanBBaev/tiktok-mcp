# Implementation plan

Work-package breakdown of `docs/ROADMAP.md`, folding in the round-1 review
findings (`docs/reviews/`) and the corner-case catalog
(`docs/CORNER-CASES.md`). Where this plan and the ROADMAP phase outlines
differ (e.g. CI moved to Phase 0), **this plan wins**. Round 2 is complete:
`docs/reviews/round2/SYNTHESIS.md` is the **binding record** of every
contested design decision; all former decision points are closed (see
§ Decision points) and the plan below reflects the synthesis outcomes.
For agent-parallel execution, the WPs are decomposed into small owned-file
tasks in `docs/TASK-BREAKDOWN.md`.

Conventions: `WP-<phase>.<n>`; effort is T-shirt sized (S ≤ half day,
M ≈ 1–2 days, L ≈ 3–5 days of focused work). Every WP lists the corner cases
(CC-*) it must implement **and test** — a WP is not done while one of its CC
IDs has no test.

---

## Phase 0 — Foundation (no tools yet)

**Goal:** a repo where every later feature lands on tested infrastructure.
CI runs from the first commit (round-1 DevOps finding: gates that appear in
Phase 3 arrive too late to protect Phases 1–2).

| WP | Scope | Effort | Corner cases |
|---|---|---|---|
| WP-0.1 | Repo bootstrap: `package.json` (name `tiktok-mcp-ai`, ESM, **engines ≥ 22** — Node 20 is EOL), strict `tsconfig` (ES2022/NodeNext, `noUncheckedIndexedAccess`), ESLint flat config with the 4-layer `no-restricted-imports` boundaries + `no-console`, Prettier, `.nvmrc` 24, `.editorconfig` | S | — |
| WP-0.2 | CI from day one: `ci.yml` (lint, typecheck, build, test, coverage gate); **blocking matrix** ubuntu × Node {22, 24}, macos × 24, windows × 24 (full Windows support — SYNTHESIS § 2.1); advisory ubuntu × 26 leg without coverage (c8 broken on ≥ 25) | S | — |
| WP-0.3 | `core/errors` (single `TikTokError` taxonomy) + `core/log` (stderr-only JSON) + **`core/redact`** — the allowlist redaction primitive lives in core, below every sink, not in `mcp/` (round-1 security F1/F2) | M | CC-B9, CC-G3 |
| WP-0.4 | `core/config`: env-file parser (comment-preserving), atomic `0600` writes, profile sextets, zod validation of every TT_ var, presence-based resolution; **cross-process lock manager** (lock file, read-merge-write, stale-lock recovery) | L | CC-F1–F6, CC-A2 |
| WP-0.5 | `core/http`: fetch wrapper with pinned egress hosts (exactly `open.tiktokapis.com` / `open-upload.tiktokapis.com` + anchored regional pattern `^upload\.[a-z0-9-]{1,16}\.tiktokapis\.com$`, bare `endsWith` banned — SYNTHESIS § 2.5; injectable DNS-lookup seam from day 1, resolve-and-pin deferred to spike P-15), `{data,error}` envelope decoder **and** the separate OAuth-shape decoder, `redirect: "error"`, three-class retry matrix (reads / inits / chunk PUTs), `Retry-After` handling, per-host concurrency semaphore, injectable clock | L | CC-A12, CC-B1–B9, CC-H1, CC-H2 |
| WP-0.6 | Test harness: `helpers.js` (`baselineEnv`, `withEnv`, `withFetch`, `ttEnvelope`, mock clock), c8 coverage gate wired into `npm run check`, fs-sandbox helper for config tests | M | CC-H4 |

**Exit gate:** `npm run check` green in CI; coverage gate active; zero tools.

## Phase 1 — Auth + read surface (usable reader MVP)

| WP | Scope | Effort | Corner cases |
|---|---|---|---|
| WP-1.1 | `core/oauth`: PKCE (hex challenge isolated in one function — CC-A13), token exchange, proactive refresh with skew, **rotation persisted before first use**, single-flight per profile + the WP-0.4 cross-process lock, terminal invalid-grant path | L | CC-A1–A7, CC-A12, CC-A13 |
| WP-1.2 | `login` CLI: loopback server (state validation, single-accept, port strategy per CC-A8), manual-paste fallback, profile targeting + overwrite confirmation, scope selection | L | CC-A8–A11 |
| WP-1.3 | `doctor` CLI: config/permissions/profile checks, token expiry warnings, journal reconciliation listing (intents without outcomes) | M | CC-A5, CC-F3, CC-E10 |
| WP-1.4 | `mcp/` layer: server bootstrap (stdio), `defineTool` + registry + PACKAGES manifest, `.strict()` schemas, result envelope `{ok,data?,error?,hints?}`, char-budget truncation, `[UNAVAILABLE]` markers (startup-static v1), stdout-purity test | L | CC-G1–G3, CC-G7 |
| WP-1.5 | Read tools: `auth` (`tiktok_get_auth_status`), `user` (`tiktok_get_user_info`), `video` (`tiktok_list_videos`, `tiktok_query_videos`) with cursor handling and `missing_ids` | M | CC-C1–C7 |
| WP-1.6 | Sync gates: manifest snapshot test, `readme-sync`, `env-docs-sync`, `.env.example` generation | S | — |

**Exit gate:** real-account smoke — `login`, `tiktok_get_auth_status`,
`tiktok_get_user_info`, `tiktok_list_videos` through MCP Inspector; all Phase-1
CC tests green.

## Phase 2 — Publishing

The riskiest phase; ordered so the write-safety spine (WP-2.1/2.2) exists
before any tool can spend a publish init.

| WP | Scope | Effort | Corner cases |
|---|---|---|---|
| WP-2.1 | `api/publish` preconditions: `creator_info` query + local validation (privacy options, brand×SELF_ONLY, UTF-16 length caps, interaction flags, photo bounds) | M | CC-E1–E4, CC-E9 |
| WP-2.2 | Write-safety spine: plan-and-apply with **enforced single-use `plan_id`** (issued by preview; digest = SHA-256 over the fully resolved payload via one exported `canonicalJson()`, control fields never digested; TTL'd, stored locally), write-ahead journal (intent → init → outcome), `TT_WRITE_MODE`, per-profile publish token bucket | L | CC-E7, CC-E10, CC-B5, CC-B8, CC-G5 |
| WP-2.3 | `tiktok_post_video` (PULL_FROM_URL first) + `tiktok_get_publish_status` (+ `wait_for_completion` polling), status/fetch error catalog mapping | M | CC-D10, CC-E5, CC-E6, CC-E8 |
| WP-2.4 | FILE_UPLOAD path: chunk planner (property-tested vectors), `TT_MEDIA_ROOT` confinement, streaming chunk PUTs with per-chunk retry + abort support, plan/apply re-stat | L | CC-D1–D9, CC-A3, CC-G4 |
| WP-2.5 | `tiktok_upload_video_draft` (inbox), photo posting (PULL_FROM_URL-only, split per round-2 AI/DX surface), journal-listing tool | M | CC-E6, CC-E9, CC-D10 |
| WP-2.6 | Sandbox validation: execute **all SYNTHESIS § 6 sandbox probes (P-1..P-14)** and record results; unaudited-app manual checklist (SELF_ONLY post, draft to inbox, photo draft, poll to terminal); recorded-fixture refresh | M | — |

**Exit gate:** end-to-end SELF_ONLY video post + draft reaching the TikTok
inbox on a test account; chunk property tests green; a deliberate duplicate
execute blocked by plan_id (CC-E7 demonstrated live); probes P-1..P-14
executed with results recorded in the probe log.

## Phase 3 — Release & platform audit

CI already exists (WP-0.2); this phase is release engineering only.

| WP | Scope | Effort | Corner cases |
|---|---|---|---|
| WP-3.1 | Publish pipeline: npm **trusted publishing (OIDC) + provenance**, release-guard (git tag == package.json == server.json == CHANGELOG), pack-audit tarball snapshot | M | — |
| WP-3.2 | CodeQL + dependabot + root `SECURITY.md` (disclosure policy) | S | — |
| WP-3.3 | MCP registry `server.json` + publish sequencing; Claude Code plugin manifest (`.claude-plugin/`) | M | — |
| WP-3.4 | npm `0.x` release; submit TikTok content-sharing **audit**; document the audit journey (requirements, demo video, timeline) | M | — |
| WP-3.5 | Scope/`[UNAVAILABLE]` lifecycle v2: credential-store watch + `tools/list_changed` (per round-2 AI/DX contract) | M | CC-A7 |

**Exit gate:** installable via `npx tiktok-mcp-ai` from npm with provenance;
registry listing live; audit submitted.

## Phase 4 — Ergonomics (demand-driven, unchanged)

MCP resources/prompts, webhooks ingestion, packaging — only when usage
justifies. Research API package only if access is granted.

---

## Dependency spine (critical path)

```
WP-0.1 → WP-0.3 → WP-0.4 → WP-0.5 → WP-1.1 → WP-1.2 → WP-1.4 → WP-1.5
                                                    ↘ WP-2.1 → WP-2.2 → WP-2.3 → WP-2.4 → WP-2.5 → WP-2.6
WP-0.2 (CI) gates everything from the first PR.        WP-3.* after WP-2.6.
```

The two structurally hard pieces — the cross-process lock manager (WP-0.4) and
the plan_id/journal spine (WP-2.2) — sit early in their phases on purpose:
everything above them assumes they exist.

## Review findings → plan mapping

| Round-1 finding (consensus) | Where folded |
|---|---|
| plan-and-apply bypassable → enforced plan_id | WP-2.2 |
| Cross-process refresh-rotation lost update | WP-0.4 + WP-1.1 |
| Redaction belongs in core, allowlist-based | WP-0.3 |
| Chunk PUTs deserve their own retry class | WP-0.5 + WP-2.4 |
| `TT_MEDIA_ROOT` file confinement | WP-2.4 |
| `open-upload.tiktokapis.com` in egress allowlist | WP-0.5 |
| Hex PKCE challenge | WP-1.1 (isolated per CC-A13) |
| CI from Phase 0, engines ≥ 22 | WP-0.1 + WP-0.2 |
| Photo 90-char title, brand×SELF_ONLY validation | WP-2.1 |
| Apply re-queries creator_info | WP-2.2 (CC-E1) |
| Duplicate-post window / journal write-ahead | WP-2.2 (CC-B5, CC-E7) |
| Split photo tools, journal tool, 11-tool surface | WP-2.5 (final shape from round-2 AI/DX) |
| npm OIDC trusted publishing, release-guard | WP-3.1 |
| stdout purity test, mock-clock harness | WP-0.6 + WP-1.4 |

## Decision points — all closed by round 2 (SYNTHESIS.md)

Every point below is settled; the SYNTHESIS section is the binding text.

1. **Windows support level** (CC-H3) → **closed**: full support, blocking
   Windows CI leg from Phase 0 — SYNTHESIS § 2.1 → WP-0.2/WP-0.4.
2. **Regional upload host** → **closed**: enumerated apexes + anchored
   `^upload\.<region>\.tiktokapis\.com$` pattern; probe P-9 records observed
   hosts — § 2.5 → WP-0.5.
3. **Hex PKCE** (CC-A13) → **closed**: CONFIRMED lowercase hex; pinned vector
   in AUTH.md — § 5 → WP-1.1.
4. **Re-PUT semantics** (CC-D6) → **design closed**: identical
   `Content-Range` retry, 416 resync; empirics via probe P-2 — § 2.13 →
   WP-2.4.
5. **publish_id retention** (CC-E8) → **open upstream, non-blocking**: probe
   P-1; hedged `publish_not_found`, journal is the durable record — § 5 →
   WP-2.3.
6. **`wait_for_completion` default** → **closed**: `false` on all four write
   tools, `true` on `tiktok_get_publish_status`; write tools return
   `publish_id` + a `poll` hint — § 2.3 → WP-2.3.
7. **Tool surface v1.1** → **closed**: 11 tools / 5 packages, wholesale from
   the round-2 AI/DX review; `tiktok_get_auth_status` /
   `tiktok_get_creator_info` names — § 2.9 → WP-2.2/2.5.
8. **Env-file lock protocol** → **closed**: hybrid `mkdir` lock-dir, mtime
   heartbeat 2 s, stale 15 s, wait 30 s + jitter, adopt-rotated-token
   fallback — § 2.2 → WP-0.4.

The plan/execute mechanism itself was also finalized (§ 2.8): the `apply`
boolean is **deleted** — absence of `plan_id` = preview, presence = execute;
`mode:"plan_incomplete"` when required fields are missing; digest over the
fully resolved payload via one exported `canonicalJson()`.

## Road to v1.0 — definition and gap list

**What 1.0 means.** Version 1.0 is a *stable public contract*, not "audit
passed":

- the 11-tool surface (SYNTHESIS § 2.9) is frozen under semver. Breaking
  changes are: tool rename/removal, result-field removal, env-var rename,
  journal record-shape change (journal `v:1` is additive-only once the
  journal tool ships);
- Phase 0–3 exit gates green, sandbox probes P-1..P-14 executed and recorded;
- published to npm with provenance and listed in the MCP registry;
- the TikTok content-sharing audit is **submitted**. Audit *passed* (lifting
  SELF_ONLY) is a 1.x platform milestone outside our control — 1.0 must not
  wait on TikTok's review queue.

**Gap list** — needed for 1.0 but absent from the WPs above. Each gap is
scheduled as a concrete task in `docs/TASK-BREAKDOWN.md` ("Lands in").

| ID | Gap | Lands in |
|---|---|---|
| G-1 | `LICENSE` file (MIT) — README says "MIT (planned)"; no WP creates the file | TB-1 |
| G-2 | Unofficial-status/trademark disclaimer in README + npm package description ("not affiliated with TikTok/ByteDance") | TB-1, TE-4 |
| G-3 | `docs/SETUP-TIKTOK-APP.md` — operator walkthrough of the developer portal: app creation, Login Kit + Content Posting products, redirect URI registration, sandbox setup, domain verification | TE-4 |
| G-4 | Privacy Policy + Terms of Service at live URLs — hard prerequisite for the TikTok audit; external deliverable (cannot be closed inside the repo, only tracked) | TE-5 |
| G-5 | `login --revoke` (logout/disconnect) implementation + tests — mentioned in AUTH.md, absent from every WP; includes § 2.10 semantics (revoke keeps the journal; purge only with explicit `--purge-journal`) | TC-2 |
| G-6 | `docs/CLIENTS.md` — per-client configuration: Claude Code, Claude Desktop, VS Code, Cursor | TE-4 |
| G-7 | `docs/TROUBLESHOOTING.md` — top failure modes, doctor-first diagnostic flow | TE-4 |
| G-8 | Uninstall / data-removal story: what to delete (env file, journal), how to revoke access | TE-4 |
| G-9 | `CONTRIBUTING.md` — how to file bugs with redacted `doctor` output | TE-4 |
| G-10 | CHANGELOG policy (keep-a-changelog) wired into the release guard from the first release | TE-1 |
| G-11 | Deprecation policy for tools and env vars (grace period + hints channel) | TE-1 |
| G-12 | RC checklist: `npx tiktok-mcp-ai` install smoke on ubuntu/macos/windows before tagging | TE-5 |
| G-13 | Spec-doc reconciliation (SYNTHESIS § 4 backlog items 1–9) — the docs must state the synthesis outcomes directly so implementation agents build from a consistent spec, not review archaeology | Wave A (TA-1..TA-8) |

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| TikTok audit delayed/rejected | Publishing stuck at SELF_ONLY + 5 users | Ship reader MVP first (Phase 1 has standalone value); document audit path; SELF_ONLY is fully exercisable meanwhile |
| Platform docs drift vs reality | Rework in `api/` | Sandbox checklist per phase; `(verify at implementation time)` markers resolved by probes; error-catalog mapping isolated in one module |
| Duplicate posts despite design | User-visible spam | plan_id + journal + never-retry-inits (three independent layers); CC-E7 demonstrated in the Phase-2 exit gate |
| Cross-process races rarer than tests | Bricked profiles in the field | Lock manager is Phase 0 with a dedicated multi-process test harness (round-2 QA); doctor reconciliation as backstop |
| Windows divergence discovered late | Support burden | Resolved: full Windows support decided (SYNTHESIS § 2.1); blocking Windows CI leg from Phase 0 (WP-0.2), before any fs code lands |

## Definition of done (every WP)

Code + tests for the WP's CC list green; coverage gate not lowered; sync gates
green; no new lint exceptions; WORKLOG entry appended.
