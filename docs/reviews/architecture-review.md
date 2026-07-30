# Design Review — Senior Software Architect

## 1. Reviewer & scope

- **Role**: Senior Software Architect (TypeScript/Node.js, MCP server architecture)
- **Date**: 2026-07-21
- **Review target**: `tiktok-mcp` design-phase specification (no code exists yet)
- **Documents reviewed**:
  - `README.md`
  - `docs/ARCHITECTURE.md`
  - `docs/TIKTOK-API.md`
  - `docs/TOOLS.md`
  - `docs/AUTH.md`
  - `docs/CONFIGURATION.md`
  - `docs/SECURITY.md`
  - `docs/TESTING.md`
  - `docs/ROADMAP.md`
- **Baseline**: `servicenow-mcp-ai` architecture map
  (`facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md`), treated as the
  proven house-style reference this design deliberately mirrors.

## 2. Executive summary

This is a mature, well-scoped design that ports a proven architecture
(`servicenow-mcp-ai`) onto a much smaller but sharper-edged API surface, and it
ports the right things: lint-enforced layering, tools-as-data with a manifest and
snapshot test, plan-and-apply write safety with a journal, env-first configuration
with atomic `0600` writes, compact result shaping, and a compile-time egress
allowlist. The TikTok-specific additions — the `{data, error}`-envelope rule, the
path-allowlist idempotency classification for read POSTs, the client-side publish
token bucket, and the honest treatment of the audit gate — show real understanding
of the upstream platform rather than a mechanical port. The main weaknesses cluster
around the **token lifecycle under refresh rotation** (single-process single-flight
is designed, but cross-process contention and rotation-failure recovery are not),
the **non-idempotent publish path at the MCP boundary** (a client-side retry of an
`apply: true` call can double-post; nothing dedupes), an **internal contradiction
about re-querying `creator_info` on apply**, and a **retry matrix that wrongly
lumps chunk PUT uploads in with non-idempotent inits**. There are also several
smaller internal inconsistencies between documents (egress claim in README, profile
key counts, annotation hints, field lists) that are cheap to fix now and expensive
to fix after the manifest snapshot exists. None of the findings invalidates the
architecture; all are addressable at the specification level before Phase 0.

**Verdict: Approve with changes.** Findings 1–4 (High) must be resolved in the
docs before implementation starts; Medium findings should be resolved before the
affected phase begins.

## 3. Strengths

- **Layered architecture with a credible enforcement story.** The
  `core ← api ← mcp ← tools` rule is not aspirational — it names the exact ESLint
  mechanism (`no-restricted-imports`) and the exact forbidden edges
  (`tools → core/http*`, `tools → core/oauth*`). This is the single most valuable
  property of the sibling architecture and it is carried over intact
  (ARCHITECTURE § 1).
- **Tools-as-data done correctly.** The `ToolSpec` contract, `.strict()` schemas,
  `.describe()` on every field, the auto-injected `account` parameter, and the
  `describeAllTools()` → snapshot test → README generation pipeline make the tool
  surface diff-reviewable. This is exactly the pattern that made the sibling
  maintainable at 67 tools; adopting it at 9 tools means the project can grow
  without a rewrite (ARCHITECTURE §§ 4–5, TESTING sync gates).
- **The envelope rule is front and center.** TikTok's "failure inside HTTP 200"
  behavior is the number-one integration trap, and the design elevates it to the
  first section of TIKTOK-API.md and a hard rule in the HTTP client
  (`error.code !== "ok"` ⇒ `TikTokError`), with `log_id` preservation for support
  escalation. This is the right altitude for that rule.
- **Idempotency treated as a property of paths, not methods.** "Read POSTs are
  explicitly classified idempotent by an allowlist of paths — method alone is not
  enough on this API" (ARCHITECTURE § 6.4) is precisely the correct posture for
  TikTok's POST-heavy read surface. Most integrations get this wrong.
- **Plan-and-apply maps beautifully onto TikTok's audit requirements.** TikTok's
  integration guidelines demand showing the creator identity and obtaining consent
  before posting; the plan preview (creator nickname/avatar, resolved privacy,
  exact payload) makes the compliant UX the *default* path rather than a bolt-on
  (TIKTOK-API § 8, ARCHITECTURE § 8). This is a genuinely elegant alignment of a
  safety pattern with a platform-compliance requirement.
- **Honest handling of the audit gate.** Never hard-coding privacy levels, always
  offering exactly what `creator_info` returned, and teaching the model to explain
  the SELF_ONLY restriction instead of retrying is the correct, ToS-respecting
  design consequence (TIKTOK-API § 7).
- **Client-side publish token bucket.** Capping inits at 6/min per profile locally
  instead of discovering the limit via 429s (which the matrix correctly refuses to
  auto-retry for inits) is defense in depth against runaway model loops
  (ARCHITECTURE § 6.5, SECURITY write safety).
- **Verification discipline in TIKTOK-API.md.** Marking unverifiable upstream
  facts *(verify at implementation time)* — chunk math, photo FILE_UPLOAD, size
  caps, the `publicaly_available_post_id` sic — instead of asserting them is
  exactly what a design doc for a fast-moving platform should do.
- **Testing strategy names the load-bearing tests.** Fetch-mock assertions that a
  denied request never reached `fetch`, single-flight refresh under concurrency,
  property-based chunk math, and the manifest/README/env-docs sync gates are the
  right investments, ported knowingly from the sibling (TESTING).
- **Justified deviations from the sibling.** Fixed redirect port (TikTok requires
  pre-registered URIs), no pluggable multi-mode `AuthProvider` (TikTok has exactly
  one v1 auth mode), no dark scaffolds (explicitly rejecting the sibling's dark
  Jira module per its own caution list), clean `TT_` prefix from day one. Each
  deviation is documented with its reason — this is how mirroring a reference
  architecture should be done.

## 4. Findings

### Finding 1 — Refresh-token rotation vs. persistence: lost-update and multi-process hazards
**Severity: High** · AUTH § 2, § 4; ARCHITECTURE § 7; TESTING core/config

**Issue.** TikTok rotates refresh tokens: every refresh may invalidate the old
refresh token and return a new one that *must* be persisted. The design covers
in-process safety (per-profile single-flight mutex, atomic snapshot swap, atomic
temp-file + rename) but is silent on two failure modes that rotation makes acute:

1. **Cross-profile lost update.** Two profiles refreshing near-simultaneously each
   perform a read-modify-write of the *whole* env file. Atomic rename prevents torn
   files, not lost updates: writer B, holding a snapshot taken before writer A's
   rename, silently reverts A's freshly rotated refresh token. The old token may
   already be invalid upstream → profile A is bricked until manual re-login.
2. **Multi-process contention.** Nothing stops two server instances (e.g. Claude
   Desktop and Claude Code both configured with `npx tiktok-mcp-ai`) from sharing
   the same XDG env file. Both hold in-memory snapshots; whichever refreshes first
   rotates the token; the second process then refreshes with the now-invalid old
   refresh token and receives a terminal auth error — or worse, persists stale
   state over the first process's write. The sibling architecture mostly used
   long-lived password/basic credentials, so this hazard did not exist there; it
   cannot be inherited-by-omission here.

**Why it matters.** The failure mode is silent de-authorization of a working
profile, the single worst UX this server can produce, and it is triggered by the
completely ordinary act of running two MCP clients.

**Recommendation.**
- Serialize *all* env-file writes through one process-wide writer mutex, and make
  every write a fresh read-merge-write (re-read the file, apply only the writer's
  own keys, rename) rather than dumping an in-memory snapshot.
- For cross-process: acquire an advisory lock file around
  refresh-and-persist; after acquiring it, re-read the env file and *skip the
  refresh if another process already rotated* (expiry now outside the skew
  window). On `invalid_grant`-style refresh failure, re-read the env file once
  before declaring terminal failure — another process may hold the valid pair.
- Add both scenarios to TESTING (core/oauth and core/config sections); the current
  "torn-read impossibility" test covers the snapshot, not the file.

### Finding 2 — Duplicate-post window at the MCP boundary: nothing dedupes a retried `apply: true`
**Severity: High** · ARCHITECTURE § 8; TOOLS `tiktok_post_video`; CONFIGURATION `TT_STATUS_POLL_TIMEOUT_MS`

**Issue.** The retry matrix correctly refuses server-side retries of publish
inits. But the design ignores the retry layer *above* the server: MCP clients
time out tool calls, and models re-issue tool calls after ambiguous failures.
`tiktok_post_video` with `wait_for_completion: true` (the default) can legally run
for `upload time + 60 s` — for a FILE_UPLOAD of a large video this exceeds any
common client timeout. If the client aborts the call after the init succeeded, the
model sees a failed tool call with no `publish_id` and will plausibly call again
with `apply: true` → duplicate post. The journal records both but prevents
neither.

**Why it matters.** "A duplicate post is worse than a failed one" is the design's
own stated principle (ARCHITECTURE § 6.4); the current design enforces it only
below the MCP boundary, which is not where the realistic retry originates.

**Recommendation.**
- Add a journal-backed duplicate guard: on `apply: true`, if the journal contains
  an applied entry for the same profile + tool + title hash (+ file size/URL)
  within a configurable window (e.g. 10 min), refuse with an explicit error
  telling the model to check `tiktok_get_publish_status` with the journaled
  `publish_id`, overridable via an explicit `force: true` input.
- Journal the init *before* returning is not enough — journal it immediately
  after the init response (before upload/poll), so an aborted call still leaves
  the `publish_id` discoverable.
- Reconsider `wait_for_completion` defaulting to `true`; returning
  `publish_id` + a "poll in 5 s" hint immediately after upload keeps tool-call
  duration bounded and pushes the wait into cheap `tiktok_get_publish_status`
  calls. At minimum, document the client-timeout interaction.

### Finding 3 — Internal contradiction: is `creator_info` re-queried on apply?
**Severity: High** · ARCHITECTURE § 8 vs. TIKTOK-API § 4.1 and TOOLS package `publish`

**Issue.** TIKTOK-API § 4.1 states `creator_info` "**must be called before every
publish**" (an upstream integration requirement, audit-relevant per § 8). But
ARCHITECTURE § 8 defines the apply path as "init → upload (if FILE_UPLOAD) →
optional bounded status poll" — no `creator_info` call. The plan preview queries
it, but plan and apply are *separate tool invocations*, possibly minutes apart
(the human confirms in between), and possibly never paired at all when
`TT_WRITE_MODE=apply` lets a call go straight to apply. In that window
`privacy_level_options` or `max_video_post_duration_sec` can change, and the
compliance requirement ("before every publish") is unmet for the apply-only path.

**Why it matters.** This is both a correctness gap (stale privacy validation) and
an audit-compliance gap in the exact area TikTok audits. It is also a
documentation contradiction that an implementer will resolve arbitrarily.

**Recommendation.** Specify that the apply path *always* re-runs `creator_info`
and re-validates `privacy_level` (and forced interaction toggles, and duration
cap) against the fresh response before init, failing locally with a clear message
if the previously previewed privacy level is no longer offered. Update
ARCHITECTURE § 8 to "creator_info → validate → init → upload → poll".

### Finding 4 — Retry matrix conflates chunk PUT uploads with non-idempotent inits
**Severity: High** · ARCHITECTURE § 6.4; TIKTOK-API § 4.2

**Issue.** The matrix column "Publish inits & uploads" applies "5xx / network
error → no retry (a duplicate post is worse than a failed one)" to *uploads*. The
rationale is valid only for inits. A chunk PUT with an explicit
`Content-Range: bytes {first}-{last}/{total}` is a byte-range write of fixed
content — re-sending the same range cannot create a duplicate post; the post does
not exist until upload completes and TikTok processes it. Under the current
matrix, one transient network blip on chunk 40 of 60 aborts a multi-GB upload
with no recovery path (the `upload_url` is valid for an hour, but the design
discards it).

**Why it matters.** Large FILE_UPLOADs over residential links *will* hit
transient errors; making the entire upload non-retryable turns the flagship write
path into the least reliable one, for no safety benefit.

**Recommendation.** Split the matrix into three columns: reads / inits / chunk
PUTs. For chunk PUTs: retry per-chunk on 5xx/network with the standard backoff
(bounded per-chunk attempts), within the 1-hour `upload_url` validity. Verify at
implementation time whether TikTok's upload endpoint tolerates re-PUT of an
already-accepted range (and whether a ranged status probe exists); if it does
not, retry only chunks that never got a 2xx. Add the retry-on-chunk case to the
TESTING core/http matrix section.

### Finding 5 — OAuth endpoints do not speak the `{data, error}` envelope; "every v2 endpoint" is false
**Severity: Medium** · TIKTOK-API § 1, § 2; ARCHITECTURE § 6.3, § 11

**Issue.** TIKTOK-API § 1 asserts "Every v2 endpoint responds with" the
`{data, error}` envelope, and ARCHITECTURE § 6.3 builds the client's success rule
on it. But `POST /v2/oauth/token/` returns a *flat* token payload on success
(`access_token`, `expires_in`, `open_id`, …) and OAuth-style error fields on
failure — not the data/error envelope. The same likely applies to `revoke`. The
HTTP client design has no stated carve-out, so a literal implementation of § 6.3
would misclassify every successful token exchange as malformed.

**Why it matters.** The error taxonomy (§ 11) promises the model can distinguish
"invalid token (re-login)" — that distinction is *made* at the token endpoint,
whose error shape is currently unspecified. Terminal-refresh-failure detection
(AUTH § 2) depends on parsing exactly these errors.

**Recommendation.** Document the OAuth endpoints' actual response/error shapes in
TIKTOK-API § 2 (marked *verify*), and specify in ARCHITECTURE § 6.3 that envelope
parsing applies to data endpoints only, with a separate parser for the token
endpoints that maps OAuth error codes into `TikTokError` (`apiCode` =
`invalid_grant` etc.). Add a TESTING case for both shapes.

### Finding 6 — The PACKAGES manifest in `mcp/registry.ts` violates the stated layer rule
**Severity: Medium** · ARCHITECTURE § 1 vs. § 5

**Issue.** § 1 says `mcp` may import `core` and `api` — nothing else. § 5 places
the `PACKAGES` manifest, which imports `authSpecs`/`userSpecs`/… from `tools/`,
inside `src/mcp/registry.ts`. That is an `mcp → tools` import, which the § 1 rule
(and any faithful `no-restricted-imports` encoding of it) forbids. The sibling
has the same wrinkle; porting it verbatim ports the contradiction. Either the
lint rule as specified cannot be enabled, or it must carry an undocumented
exception — both undermine "enforced by ESLint" as a claim.

**Why it matters.** The layering rule is the design's central structural claim.
A rule with a silent exception on day one invites the next exception.

**Recommendation.** Two clean options; pick one and write it down:
(a) move the manifest to `src/tools/index.ts` (the top layer aggregates its own
specs) and have `registerAllTools(server, PACKAGES)` in `mcp/` accept it as a
parameter — the dependency then points `tools → mcp`, which is legal; or
(b) explicitly document `mcp/registry.ts` as the single sanctioned exception in
the ESLint config with a comment referencing this section. Option (a) is
preferred: it keeps the rule exception-free and makes the registry testable with
a synthetic manifest.

### Finding 7 — `core` package profile requires intra-package filtering that no mechanism provides
**Severity: Medium** · ARCHITECTURE § 5; CONFIGURATION `TT_TOOL_PACKAGES`; README tool table

**Issue.** The profile `core` is defined as "auth+user+video+publish-read". But
the registry's unit of enablement is the *package*, and `publish` contains both
read tools (`tiktok_query_creator_info`, `tiktok_get_publish_status`) and write
tools. "publish-read" is neither a package nor a documented filter; the only
hint-based filter described (`TT_PACKAGES_READONLY`) is global, not per-package.
As specified, `core` is unimplementable without inventing a mechanism.

**Why it matters.** `core` is the *default* profile — ambiguity here is ambiguity
in what a fresh install exposes.

**Recommendation.** Either (a) split the package into `publish` (read pre-flight
+ status) and `publish-write` (the three write tools) — my preference, since it
makes profiles pure package unions and lets `TT_PACKAGES_DENY=publish-write`
express a common deployment; or (b) define profiles as
package-set + optional readonly flag pairs and document that. Update README,
ARCHITECTURE § 5, and CONFIGURATION together; the manifest snapshot test will
then lock in the answer.

### Finding 8 — Startup scope markers are per-server, but scopes are per-profile
**Severity: Medium** · TOOLS "Cross-cutting behavior"; AUTH § 5

**Issue.** "At startup, tools whose scopes were not granted still register but
their description gains a leading `[UNAVAILABLE: missing scope …]` marker." Tool
descriptions are global per server; granted scopes are per *profile*. With
multi-account profiles (AUTH § 3), profile `default` may lack `video.publish`
while profile `brand` has it — a startup marker computed from either profile is
wrong for the other. Markers are also frozen at registration: a re-login that
adds scopes while the server runs leaves stale `[UNAVAILABLE]` text (no
`listChanged` story is designed).

**Why it matters.** The marker exists to prevent "silent failures
mid-conversation"; a wrong marker *causes* mid-conversation confusion instead —
the model will refuse tools that would work for the requested `account`.

**Recommendation.** Compute the startup marker from the union of all configured
profiles' scopes ("unavailable" only if *no* profile can use it), phrase it
per-profile ("missing scope video.publish on profile(s): default"), and keep the
authoritative check at call time against the resolved profile's scopes (which
AUTH § 5 already implies via `scope_not_authorized` mapping). Optionally note
`listChanged` re-registration as a Phase 4 ergonomic.

### Finding 9 — Streamable HTTP transport: no Origin validation specified
**Severity: Medium** · ARCHITECTURE § 3; SECURITY "Transport"

**Issue.** The HTTP transport section covers bind host, bearer token,
constant-time comparison, and session IDs, but not `Origin` header validation.
The MCP specification requires Streamable HTTP servers to validate `Origin` to
prevent DNS-rebinding attacks — a hostile web page can otherwise drive a
loopback-bound server (the default `127.0.0.1:3000` with no token is exactly the
vulnerable configuration) through the victim's browser.

**Why it matters.** This server can *post to the user's TikTok account*. A
rebinding attack that reaches tool invocation on a `TT_WRITE_MODE=apply`
deployment is account takeover for posting purposes. The threat model
(SECURITY) explicitly includes "a compromised or hostile web page".

**Recommendation.** Specify in ARCHITECTURE § 3 and SECURITY: reject requests
whose `Origin` header is present and not an allowed value (and consider requiring
`TT_HTTP_TOKEN` even for loopback binds, or at least document the residual risk).
Add a TESTING case under a new transport section.

### Finding 10 — HTTP redirect-following policy unspecified (host-guard bypass channel)
**Severity: Medium** · ARCHITECTURE § 6.1; SECURITY "Egress control"

**Issue.** The host guard validates the URL *before* fetch, but `fetch` follows
redirects by default. A 30x from `open.tiktokapis.com` (or from the upload host)
to an arbitrary origin would be followed with the `Authorization` header — or
media bytes — attached, silently bypassing the compile-time allowlist. Neither
document states `redirect: "error"`/manual handling.

**Why it matters.** The egress allowlist is a headline security control
("Egress allowlist … nothing else", README); an unspecified redirect policy is
the standard way such allowlists leak in practice.

**Recommendation.** Specify `redirect: "error"` (or `"manual"` with re-validation
through the host guard) for every request in `core/http.ts`, including upload
PUTs, and add a fetch-mock test asserting a redirect response is not followed.

### Finding 11 — Client-side media validation promises more than a zero-dependency build can deliver
**Severity: Medium** · TIKTOK-API § 6; TOOLS "Cross-cutting behavior"; ARCHITECTURE § 8

**Issue.** The design commits to client-side enforcement of media constraints
"before upload": container checks, and duration validated against
`max_video_post_duration_sec`. With exactly three runtime dependencies (SDK, zod,
dotenv), there is no library that reads MP4/WebM/MOV duration; "sniffed"
(TOOLS) covers magic bytes at best. Duration validation requires hand-parsing the
MP4 `moov/mvhd` atom (and something else entirely for WebM/MOV), which is real
work the docs neither scope nor assign to a module.

**Why it matters.** Either the implementation silently drops a documented
validation (spec drift on a plan-preview promise — "warnings (e.g. … duration
over creator cap)" in TOOLS), or it grows an unplanned parser. Both are avoidable
now.

**Recommendation.** Decide and document: (a) best-effort duration extraction for
MP4 only via a small hand-rolled `mvhd` reader in `core/` (bounded scope,
property-testable), with WebM/MOV duration checks explicitly delegated to
TikTok's server-side error; or (b) drop client-side duration validation from the
spec and let the preview warn only on size/extension/existence. State the choice
in TIKTOK-API § 6 and TOOLS.

### Finding 12 — Login loopback redirect is a single unverified assumption with an unspecified fallback
**Severity: Medium** · AUTH § 1; ROADMAP Phase 1

**Issue.** The entire interactive login UX rests on TikTok accepting
`http://127.0.0.1:43110/callback` as a registered redirect URI — flagged *(verify
at implementation time)*, which is correct, but the named fallback ("manual
copy-paste flow") is not designed at all: no URI to register in that case, no
description of what the user pastes (full redirect URL? code + state?), no state
verification story. TikTok's portal has historically required HTTPS redirect
URIs for web apps; the probability that the fallback becomes the *primary* flow
is not small.

**Why it matters.** This is Phase 1's exit-gate path. If the assumption fails
mid-implementation with no designed fallback, the login UX gets improvised — the
worst place for improvisation is the OAuth flow.

**Recommendation.** Spec the fallback now in AUTH § 1: the out-of-band pattern
(register an HTTPS redirect the developer controls, or TikTok-supported
equivalent; user pastes the full redirect URL back into the CLI; CLI parses
`code` + `state`, verifies `state`, proceeds with the same PKCE exchange). Also
record the verification of loopback acceptance as an explicit Phase 1 task in
ROADMAP, before the login CLI is built.

### Finding 13 — The 401-replay condition for inits is ill-defined
**Severity: Low** · ARCHITECTURE § 6.4

**Issue.** "401 / token invalid → one forced refresh, one replay **of init only
if no publish_id was returned**." A 401 (or `access_token_invalid` envelope) is
an error response; it never carries a `publish_id`, so the condition is
vacuously true and the guard as written guards nothing. The *actual* safety
argument — that an auth-rejected init is rejected before any post is created,
making replay safe — is unstated.

**Why it matters.** An implementer will either implement a meaningless check or
puzzle over intent; the real invariant ("auth rejection happens before side
effects") is the thing worth writing down and verifying upstream.

**Recommendation.** Reword: "401/`access_token_invalid` on an init is replayed
once after a forced refresh, on the grounds that an auth-rejected request cannot
have created a post *(verify TikTok rejects before side effects at implementation
time)*." Delete the publish_id clause.

### Finding 14 — README egress claim contradicts the upload path
**Severity: Low** · README "Design at a glance" vs. ARCHITECTURE § 6.1, SECURITY "Egress control"

**Issue.** README: "the process talks to `open.tiktokapis.com` (and
`www.tiktok.com` for the OAuth authorize redirect only) — nothing else."
FILE_UPLOAD PUTs go to the TikTok-returned `upload_url` on a separate
upload domain (ARCHITECTURE § 6.1, SECURITY both say so). "Nothing else" is
false, and README is the document outsiders read.

**Recommendation.** Amend README to "…plus TikTok's own upload hosts for the
`upload_url` returned by a publish init, validated against a fixed TikTok-owned
domain set."

### Finding 15 — Annotation hints applied inconsistently across the catalog
**Severity: Low** · TOOLS (all tool headers)

**Issue.** `tiktok_get_user_info`, `tiktok_list_videos`, `tiktok_query_videos`
carry **ID** (`idempotentHint`); `tiktok_query_creator_info` and
`tiktok_get_publish_status` do not — yet both are on the retry matrix's
idempotent read-POST allowlist (ARCHITECTURE § 6.4). Meanwhile no publish tool
states `destructiveHint`; per the MCP spec its *default is `true`* for
non-read-only tools, so the write tools will advertise as destructive unless
explicitly set — a defensible outcome, but currently an accident, not a decision.

**Recommendation.** Add **ID** to the two read POST tools (or document why not),
and make an explicit `destructiveHint` decision for the three write tools
(creating a post destroys nothing — `false` with `idempotentHint: false` is
arguably more accurate; either way, write it down so the manifest snapshot
captures intent).

### Finding 16 — Profile key list disagrees between documents (five vs. six keys)
**Severity: Low** · ARCHITECTURE § 7 vs. CONFIGURATION "App & tokens", AUTH § 1

**Issue.** ARCHITECTURE § 7 lists the profile as `TT_ACCESS_TOKEN /
TT_REFRESH_TOKEN / TT_OPEN_ID / TT_SCOPES / TT_TOKEN_EXPIRES_AT` — omitting
`TT_REFRESH_EXPIRES_AT`, which CONFIGURATION includes ("same six token keys") and
AUTH § 1 step 4 persists.

**Recommendation.** Add `TT_REFRESH_EXPIRES_AT` to ARCHITECTURE § 7. Trivial, but
this is exactly the kind of drift the design's own `env-docs-sync` gate exists to
prevent — the docs should be clean before that gate is codified.

### Finding 17 — `share_url` appears in the default field set but not in the documented field list
**Severity: Low** · TOOLS `tiktok_list_videos` vs. TIKTOK-API § 3.2

**Issue.** TOOLS defaults include `share_url`; TIKTOK-API § 3.2's video field
list does not contain it (it lists `embed_html`, `embed_link`, …). Either the
field list is incomplete or the default is invalid — an invalid `fields` value is
a hard upstream error on this API.

**Recommendation.** Reconcile: verify `share_url` against the upstream reference
and add it to TIKTOK-API § 3.2, or drop it from the TOOLS default. The zod enum
for `fields` will have to pick one — do it in the docs first.

### Finding 18 — Cursor described as both opaque and a typed unix-ms number
**Severity: Low** · TOOLS `tiktok_list_videos`; ARCHITECTURE § 9

**Issue.** The `cursor` input is simultaneously "Opaque paging cursor" and
"(unix ms)" typed as `number`. If it is opaque, do not document its unit or
constrain its type beyond what round-tripping requires; if it is semantically a
timestamp, it is not opaque. Ambiguity here invites the model to fabricate
cursors from dates.

**Recommendation.** Treat it as opaque passthrough: type it as the exact value
returned by the previous call, describe it as "pass the `cursor` value from the
previous response verbatim; do not construct it", and drop the unit from the
model-facing description.

### Finding 19 — Profile-name → env-key mapping rules unspecified
**Severity: Low** · AUTH § 3; CONFIGURATION `TT_PROFILE_<NAME>_*`

**Issue.** `login --profile brand` maps to `TT_PROFILE_BRAND_*`. Nothing
specifies the allowed profile-name alphabet, case handling, or collisions
(`brand-x` vs `brand_x` both wanting `TT_PROFILE_BRAND_X_*`), nor how the
`account` tool argument is matched (case-sensitive?).

**Recommendation.** Constrain profile names at `login` time (e.g.
`^[a-z][a-z0-9_]{0,31}$`, uppercased for env keys, matched case-insensitively
from the `account` arg), and reject an unknown `account` with an error listing
configured profiles.

### Finding 20 — Publish journal has no growth or privacy lifecycle
**Severity: Low** · ARCHITECTURE § 8; SECURITY "Write safety"

**Issue.** `journal.ndjson` is append-only with no size cap, rotation, or
retention policy. Low volume makes growth a non-issue for years, but the journal
is also the proposed dedup source (Finding 2) and an audit trail — unbounded
files eventually get deleted wholesale by users, destroying both roles at once.

**Recommendation.** Specify a simple size-based rotation (e.g. rotate at 5 MB,
keep one predecessor) and note it in SECURITY as part of the "only state" story.

### Finding 21 — `TT_LOGIN_SCOPES` defaults to the full six-scope set regardless of intent
**Severity: Low** · CONFIGURATION "OAuth / login"; AUTH § 1

**Issue.** The default consent request includes `video.publish` and
`video.upload` even for a deployment whose operator only ever wanted the reader
surface (`TT_TOOL_PACKAGES=reader`). Users see a scarier consent screen than
necessary, and the token carries write capability that the tool-surface policy
then has to suppress — capability should be minimized at grant time, not only at
registration time.

**Recommendation.** Derive the default `login` scope set from the configured
package profile (reader → the three `user.info.*` + `video.list`; publisher →
all six), keeping `--scopes` as the explicit override. Document the mapping in
AUTH § 1.

### Finding 22 — Project-local `.env` fallback can accumulate tokens inside a repo
**Severity: Low** · CONFIGURATION "Resolution order"; SECURITY "Secrets"

**Issue.** The read path includes a project `.env`; writes always target the XDG
file. Fine — but a user who *starts* with tokens in a project `.env` (a common
copy-paste outcome) has secrets inside a directory that may be a git repo, and
the design neither warns nor migrates.

**Recommendation.** Have `doctor` (and startup, once, at `warn` level) flag token
material found in a non-XDG env file, recommending migration to the XDG path.

### Finding 23 — `TT_PACKAGES_READONLY` vs `TT_WRITE_MODE=deny`: overlapping knobs, undocumented difference
**Severity: Low** · CONFIGURATION "Tool surface & write policy"; ARCHITECTURE § 5, § 8

**Issue.** Both knobs remove write tools from registration; on this small surface
the observable difference is nil today, but the semantics differ ("register only
`readOnlyHint` tools" vs "do not register write tools") and will diverge the
moment a non-publish write tool appears. The docs never contrast them, so
operators cannot choose deliberately.

**Recommendation.** Add one sentence to CONFIGURATION contrasting the two
(`READONLY` is a registration filter by annotation; `WRITE_MODE` governs the
plan/apply/deny behavior of write tools) and state that `deny` implies the same
surface as `READONLY=1` *for v1*.

## 5. Open questions & assumptions to validate before implementation

1. **Loopback HTTP redirect URI** — does the TikTok portal accept
   `http://127.0.0.1:<port>/callback` for a desktop-style app? (Gates the entire
   login design; Finding 12.)
2. **Refresh-token rotation semantics** — is there a reuse grace window for the
   previous refresh token after rotation? Determines how aggressive the
   multi-process recovery (Finding 1) must be.
3. **OAuth endpoint response/error shapes** — exact success and error JSON for
   `/v2/oauth/token/` and `/v2/oauth/revoke/` (Finding 5).
4. **Upload endpoint semantics** — the exact TikTok-owned upload domain set for
   the host guard; whether an already-accepted chunk range can be re-PUT
   (Finding 4); actual chunk-size math including the final-chunk rule.
5. **Photo FILE_UPLOAD** — still PULL_FROM_URL-only? (TIKTOK-API § 4.4 flags it.)
6. **`creator_info` rate limit** — the init endpoints have 6/min; does
   `creator_info/query` have its own per-token limit that the re-query-on-apply
   policy (Finding 3) and token bucket must respect?
7. **Status retention window** — how long after a terminal state does
   `status/fetch` keep answering for a `publish_id`? Affects the resume story
   TOOLS promises.
8. **401 side-effect ordering** — does TikTok guarantee auth rejection happens
   before any publish side effect (Finding 13's replay-safety premise)?
9. **`is_aigc` default-on** — product decision to validate with the operator
   story: defaulting the AIGC label to `true` mislabels genuinely human-made
   content posted through the server. Is per-call model discretion (no default,
   required input on apply) safer than a global default in either direction?
10. **MCP client timeout budget** — what tool-call durations do the primary
    target clients tolerate, and should FILE_UPLOAD publishes emit MCP progress
    notifications (see Deep dive C)?
11. **Sandbox availability** — does TikTok offer a sandbox app mode adequate for
    the Phase 2 exit gate, or is the "sandbox" actually an unaudited production
    app posting SELF_ONLY? TESTING and ROADMAP use the word "sandbox" for what
    TIKTOK-API describes as unaudited-production behavior; align the vocabulary.
12. **Full upstream error-code list** — TIKTOK-API § 1 marks it *(verify)*; the
    error-to-recovery-hint mapping in TOOLS (`tiktok_get_publish_status`) needs
    the real list.

## 6. Deep dive

### A. Idempotency on TikTok's POST-everything surface — and the two writes the matrix forgot

TikTok's v2 API uses POST for almost everything, including pure reads
(`video/list`, `video/query`, `creator_info/query`, `status/fetch`). The design's
response — an explicit path allowlist of idempotent operations, with method
treated as meaningless (ARCHITECTURE § 6.4) — is the correct architectural move,
and it is the piece I would defend most strongly in this spec. But walking the
full request inventory shows the classification is incomplete: the server issues
*six* kinds of state-changing or state-adjacent requests, and the matrix only
classifies three.

| Request | True idempotency | Matrix today | Correct policy |
|---|---|---|---|
| Read POSTs (list/query/status/creator_info) | Idempotent | retry | retry (as designed) |
| Publish inits (video/inbox/content) | **Non-idempotent** (creates `publish_id`, eventually a post) | no retry | no retry (as designed) |
| Chunk PUT to `upload_url` | Idempotent *per range* — bytes are fixed, post not yet created | lumped with inits: no retry | **retry per chunk** (Finding 4) |
| Token refresh (`grant_type=refresh_token`) | **Non-idempotent** — rotation consumes the old token | unclassified | never blind-retry on ambiguous outcome; recover by re-reading persisted state (Finding 1) |
| Token exchange (`grant_type=authorization_code`) | Non-idempotent (code is single-use) | unclassified (CLI path) | no retry; re-prompt login |
| Revoke | Idempotent in effect | unclassified | safe to retry once |

The refresh row deserves emphasis because it is the *hidden write* in the read
path: a proactive refresh triggered by `tiktok_list_videos` mutates durable auth
state. The most dangerous outcome is not a failed refresh but an **ambiguous**
one — a network error after TikTok issued and rotated the token but before the
response arrived. The old refresh token may now be dead and the new one was never
seen. No retry policy fixes this; only recovery design does: persist-before-use
ordering, `invalid_grant` handled by re-reading the env file (another process may
have the valid pair), and finally a terminal "re-login" error. The matrix should
grow rows for the token endpoints so the implementer of `core/oauth.ts` inherits
a decided policy instead of improvising one.

The second boundary the design under-weights is *above* the server: MCP clients
and models retry tool calls. Server-side "no retry for inits" is necessary but
not sufficient — the effective idempotency contract of `tiktok_post_video
(apply: true)` is what the *model* experiences, and today that contract is
"retrying may double-post". The journal is already positioned to fix this (it
records profile, tool, publish_id, title hash, outcome); making it a dedup index
(Finding 2) closes the loop and turns an audit artifact into an active safety
control — a strictly better return on the same file.

### B. The `AsyncLocalStorage` profile context: right pattern, wrong sole owner of durable state

Carrying the per-request account profile via `AsyncLocalStorage` (ARCHITECTURE
§ 4, AUTH § 3) is the proven sibling pattern and the correct one: it survives
`await` chains, needs no parameter threading through `api/` signatures, and makes
parallel calls with different `account` values structurally unable to bleed into
each other. Three properties must hold for it to stay sound here, and only the
first is currently guaranteed by the design:

1. **Context establishment is centralized.** `runSpec()` is the single place that
   resolves `account` → profile and enters the ALS scope; every downstream read
   (`core/oauth.ts` auth injection, journal writes, `logFields`) sees a
   consistent profile. Designed. One gap: the *fallback* semantics when
   `account` is absent must read `TT_ACTIVE_PROFILE` at call time, not capture
   it at module load — the env file is runtime-writable, and a stale capture
   would ignore a profile switch. Worth one sentence in ARCHITECTURE § 4.

2. **Nothing escapes the scope.** Everything in the v1 design that acts on a
   profile (bounded status polls, chunk uploads, journal appends) runs inside
   the handler's async chain, so context loss cannot occur. The design should
   however *state the invariant* — "no profile-dependent work is ever scheduled
   outside the tool-call ALS scope" — because the first violation will arrive
   innocently (a background token pre-refresher, a webhook consumer in Phase 4)
   and will read the default profile silently. An eslint ban on
   `setInterval`/detached promises in `core/oauth.ts` is cheap insurance.

3. **ALS isolates *selection*, not *storage*.** This is where the design
   over-trusts the pattern. Two concurrent calls with `account: "default"` and
   `account: "brand"` are perfectly isolated in-memory — and then both refresh,
   and both rewrite the *same shared env file*. The per-profile mutex serializes
   refreshes within a profile; nothing serializes the file across profiles or
   across processes (Finding 1). The atomic snapshot swap ("torn read
   impossible") solves the read side; the write side needs the same rigor: one
   writer mutex, read-merge-write, and an advisory lock for the cross-process
   case. In short: ALS answers "whose token do I use?", and the design must
   separately answer "who may write the token file, when, based on what read?" —
   currently it does not.

A final note on HTTP transport: with `TT_TRANSPORT=http`, multiple concurrent
MCP sessions multiplex into one process. ALS handles the interleaving correctly
by construction, but the per-profile refresh mutex and the publish token bucket
become *shared across sessions* — two HTTP clients posting on the same profile
share the 6/min budget. That is the correct behavior (the upstream limit is per
token, not per session) and worth one clarifying sentence in ARCHITECTURE § 6.5.

### C. Chunked upload: module placement, resumability, and the long-call problem

The design places "upload chunking" in `core/` (ARCHITECTURE § 1) and asks the
plan preview to include "chunk plan (count/sizes) for files" (TOOLS). This is
consistent with the layer rules only if the *responsibilities* are split
precisely, because three layers legitimately touch uploads:

- **`core/upload-chunks.ts` (pure math).** `planChunks(fileSize, constraints) →
  { chunkSize, totalChunkCount, ranges[] }`. No I/O, no HTTP. This is the right
  home: the property tests TESTING already specifies (bounds, contiguity, sum ==
  file size) want a pure function, and the *(verify exact math)* flag in
  TIKTOK-API § 4.2 means this function will be rewritten once against real docs —
  isolate it.
- **`api/publish.ts` (orchestration).** Owns the sequence creator_info → init →
  stream chunks → status, and *exposes the chunk plan* to the tool layer (e.g.
  `previewPost()` returns the plan). This is the piece the layer rule protects:
  tools may not import `core/upload-chunks.ts` directly (it is `core/`), so the
  preview's chunk plan must flow through an `api/` function. The docs never say
  this; without it, an implementer will "just import the helper" from
  `tools/publish.ts` and quietly breach the boundary the ESLint rule may or may
  not catch depending on how the glob is written. One sentence in ARCHITECTURE
  § 1 fixes it.
- **`core/http.ts` (transport).** The PUT itself, with the upload-host guard,
  `TT_UPLOAD_TIMEOUT_MS`, and — per Finding 4 — per-chunk retry. The
  `Content-Range` header construction should live here or in the chunk plan, in
  exactly one place, because the off-by-one in `bytes {first}-{last}/{total}` is
  the classic bug the property tests exist to kill.

Two design consequences follow that the docs have not yet drawn:

**Resumability.** The `upload_url` lives for one hour and the chunk plan is
deterministic. That means a failed upload at chunk *k* is resumable *within the
same tool call* at near-zero design cost (retry chunk *k*, continue) — but
resumable *across* tool calls only if the `publish_id` + `upload_url` + plan are
kept somewhere. The journal already stores `publish_id`; storing the
`upload_url` would put a capability-bearing URL on disk — I would *not* do that
(SECURITY's "no secrets in the journal" spirit applies; the URL authorizes
writes). The right v1 line: in-call retry yes, cross-call resume no — a failed
upload is reported with its `publish_id` and the model is told the draft init
will expire. Write that line down so nobody "improves" it into persisting upload
URLs.

**The long-call problem.** A 2 GB FILE_UPLOAD on a 20 Mbit/s uplink is ~15
minutes of PUTs inside a single MCP tool call, before any status polling. Three
mitigations compose: (1) MCP progress notifications per completed chunk — the
protocol supports them, the SDK exposes them, and the design's `logging`
capability mirror is adjacent but not equivalent; (2) `wait_for_completion`
default flipped to `false` for `source: "file"` (the upload already dominates
the call; tacking a 60 s poll onto it buys little); (3) explicit documentation
that operators of timeout-enforcing clients should raise the tool-call timeout
for `publish` or prefer `PULL_FROM_URL`. None of these is hard; all three are
invisible in the current docs, and the first one is the difference between a
model (and human) watching a silent 15-minute call versus a progressing one.

---

*End of review. Findings 1–4 block Phase 0 sign-off; Medium findings should be
resolved in the documents before their owning phase begins; Low findings are
docs-hygiene and can be batched.*
