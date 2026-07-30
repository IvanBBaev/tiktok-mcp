# Roadmap

> Detailed work-package breakdown: **docs/IMPLEMENTATION-PLAN.md** — it folds in
> the review findings (binding round-2 synthesis) and the corner-case catalog
> (docs/CORNER-CASES.md) and supersedes the phase outlines below where they
> differ. This file is the short orientation view only.

## Phase 0 — Foundation (repo bootstrap)
- Repo scaffolding: `package.json` (name `tiktok-mcp-ai`, ESM, **engines ≥ 22**),
  strict `tsconfig` (ES2022/NodeNext, `noUncheckedIndexedAccess`), ESLint flat
  config with layer-boundary rules, Prettier, `.editorconfig`, `.nvmrc` (**24**).
- **CI from the first commit**, blocking matrix ubuntu × Node {22, 24},
  macos × 24, **windows × 24** (full Windows support), plus an advisory
  ubuntu × 26 leg.
- `core/`: settings, config store (env file, profiles, atomic writes,
  cross-process env-file lock), errors, logging + redaction, egress host guard,
  http client with the three-class retry matrix and envelope decoding.
  Everything unit-tested before any tool exists.
- **Exit gate**: `npm run check` green in CI on all blocking legs; coverage
  gate active; zero tools.

## Phase 1 — Read surface (usable reader MVP)
- `login` CLI (PKCE loopback; manual-paste fallback), `doctor`.
- OAuth refresh machinery (skew, rotation, single-flight, cross-process lock).
- Packages `auth`, `user`, `video` + registry, manifest snapshot, README
  generation, `server.json`.
- **Exit gate**: real-account smoke test — login, `tiktok_get_auth_status`,
  `tiktok_get_user_info`, `tiktok_list_videos` through MCP Inspector.

## Phase 2 — Publishing
- The write-safety spine first: plan/execute with enforced single-use
  `plan_id`, append-only write-ahead journal, per-profile publish token bucket.
- `publish` reads: `tiktok_get_creator_info`, `tiktok_get_publish_status`,
  `tiktok_list_publish_journal`; then the four `publish-write` tools:
  `tiktok_post_video` (URL source first, then FILE_UPLOAD chunking),
  `tiktok_upload_video_draft`, `tiktok_post_photos`,
  `tiktok_upload_photos_draft`.
- Sandbox validation against an unaudited app (SELF_ONLY posts, draft flow),
  including executing the sandbox probes **P-1..P-14** and recording results.
- **Exit gate**: end-to-end SELF_ONLY video post + draft reaching the TikTok
  inbox on a test account; chunk-math property tests green; a deliberate
  duplicate execute blocked live by `plan_id`; all probes recorded.

## Phase 3 — Release & platform audit
CI already exists from Phase 0 (blocking matrix ubuntu × {22, 24}, macos × 24,
windows × 24, advisory 26) — this phase is release engineering only.
- CodeQL, dependabot, publish workflows (npm trusted publishing with
  provenance + MCP registry), CHANGELOG, root `SECURITY.md`, Claude Code
  plugin manifest (`.claude-plugin/`).
- npm publish `0.x`; **submit** the TikTok content-sharing audit (required to
  lift SELF_ONLY). Audit *passed* is a 1.x platform milestone outside our
  control — v1.0 does not wait on TikTok's review queue. Document the audit
  journey.
- v1.0 itself is defined by the "Road to v1.0" section of
  docs/IMPLEMENTATION-PLAN.md: the 11-tool surface frozen under semver plus
  the gap list G-1..G-13 closed (LICENSE, unofficial-status disclaimer,
  operator docs, revoke flow, RC checklist, …).
- Optional: Research API package (`research`) — only if access is granted;
  client-credentials auth, own rate limits. No dark scaffold before then.

## Phase 4 — Ergonomics (demand-driven)
- MCP resources (e.g. `tiktok://videos/recent` snapshot) and prompts
  (guided "post a video" flow).
- Webhooks ingestion (portability events) if a use case appears.
- VS Code extension / desktop packaging only if usage justifies it.

## Explicit non-goals
- No ads/Business API, no comment management (no public API), no scraping or
  unofficial endpoints, no multi-tenant hosted deployment, no token brokering
  for third parties, no engagement automation (likes/follows) — both unsupported
  by the API and against platform rules.
