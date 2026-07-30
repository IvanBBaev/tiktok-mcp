# Round-2 Deep Review — Principal DevOps / Release Engineer

## 1. Reviewer & scope

- **Role**: Principal DevOps / Release Engineer — CI/CD, npm supply chain, MCP registry
  operations, cross-platform runtime behavior, field operability.
- **Date**: 2026-07-22.
- **Round-1 predecessor**: `docs/reviews/devops-release-review.md` (16 findings F1–F16 +
  pipeline outline). This review **builds on it** — round-1 findings are referenced by
  number, not restated. Where round 2 changes a round-1 position, that is stated
  explicitly.
- **Inputs**: full spec (`README.md` + all 8 `docs/*.md`), all five round-1 reviews
  (devops, security, architecture, qa, ai-dx, tiktok-platform), and the
  `servicenow-mcp-ai` baseline architecture map.
- **Deliverables**: cross-examination of other roles' round-1 findings from an ops
  angle (§ 2); the Windows decision (§ 3); implementation-grade pipeline specs (§ 4);
  ops runbook content (§ 5); new findings and ordered spec amendments (§ 6); remaining
  unknowns (§ 7).

## 2. Cross-examination of round-1 findings (ops angle)

### 2a. Cross-process env-file locking — **CONFIRM the need, REFINE the mechanism**

Origin: devops F8, architecture Finding 1, qa F-3.

The race is real and the round-1 protocol (re-read before refresh, in-process
single-flight, read-merge-write persist, re-read once on `invalid_grant`) is correct.
The **advisory lock file** proposal needs ops hardening, because naive lock files fail
exactly where this server will run:

- **Crash survival.** A lock taken via `open(O_EXCL)` and deleted on release does *not*
  survive a crash — the file stays behind and every future refresh persists blocks
  forever. Any lock design **must** have a stale policy. The proven pattern
  (proper-lockfile) is: acquire via **`fs.mkdir(<envfile>.lock)`** — atomic on all
  platforms and, unlike `O_EXCL`, not broken on network filesystems — and treat the
  lock as **stale when its `mtime` is older than a threshold**, at which point the
  next acquirer removes and re-acquires it, logging a warning
  ([proper-lockfile](https://www.npmjs.com/package/proper-lockfile)). Do **not** add
  the dependency (3-runtime-deps discipline); the mkdir + mtime-age subset is ~40
  lines in `core/config.ts`.
- **Stale policy.** Never PID-based: PIDs are meaningless across container namespaces
  and are recycled aggressively on Windows. Age-based only. To keep the threshold
  small, the lock must cover **only the file mutation** (read-merge-write-rename),
  *never* the token-endpoint network call — the critical section is then milliseconds
  and a **5 s stale threshold** with no heartbeat is safe. Cross-process
  double-refresh is already handled by the re-read + `invalid_grant` re-read protocol;
  the lock's only job is preventing interleaved writes from losing keys.
- **Containers.** Two containers bind-mounting the same config dir share the
  filesystem, so mkdir atomicity holds; the age-based stale policy is the only part
  that remains correct there (PID checks would cross namespaces). Document "one
  writer per env file is the supported topology; the lock makes violations safe, not
  fast".
- **Ops surface.** `doctor` must check for a leftover `.lock` directory older than the
  threshold and print the removal command (§ 5.1 check 8). Acquisition failure after
  N retries must degrade the same way as persist failure (qa F-3a): keep serving the
  in-memory token, warn loudly, retry on next write — never fail a tool call because
  of the lock.

### 2b. Journal write-ahead design — **CONFIRM intent, REFUTE in-place updates, REFINE lifecycle**

Origin: architecture Finding 2, ai-dx F4, devops F9, qa F-10.

Write-ahead journaling (record the attempt *before* the init request) is the right
dedup/audit foundation, and F4's `tiktok_list_publish_journal` tool makes the journal
load-bearing — which raises the ops bar on its integrity.

- **REFUTE "update the row on response"** (ai-dx F4 wording). In-place NDJSON line
  updates are how journals corrupt: a rewrite racing an append, or a crash mid-rewrite,
  torches the audit trail. The journal must be **append-only, two records per
  publish**: `{v:1, event:"attempt", attempt_id, ts, tool, profile, args_hash,
  title_excerpt}` fsync'd *before* the init request is sent, then
  `{v:1, event:"outcome", attempt_id, ts, publish_id?, outcome}` appended on response
  (no fsync needed — losing an outcome record degrades to `outcome: "unknown"`, which
  is exactly the truthful state). Readers (journal tool, doctor, dedup window) fold
  records by `attempt_id`. An attempt with no outcome **is** the "may have posted —
  check status before retrying" signal, for free, across crashes.
- **Rotation** (confirms devops F9): size check at append-handle open; at ≥ 5 MB rename
  `journal.ndjson` → `journal.ndjson.1` (one generation kept, older deleted). Rotation
  must never split an attempt/outcome pair's *readability*: the journal tool reads
  `.1` + current when folding. At ~300 bytes/record, 5 MB ≈ 8 000 publishes — years of
  history for the target user.
- **Corruption recovery.** A crash mid-append leaves a torn last line. Readers parse
  line-by-line, skip and count unparseable lines, and **never** let a bad line block
  appends. `doctor` reports the count (§ 5.1 check 7). No repair tooling in v1 —
  skip-and-count is the repair.
- **Format versioning.** Every record carries `v: 1`. Readers ignore records with
  unknown `v` (count them separately in doctor). Version bumps only for
  shape-incompatible changes; additive fields do not bump.
- **What doctor reports**: path, size, generations present, last-write age,
  unparseable-line count, and the number of unresolved `unknown` outcomes (attempts
  with no outcome record) — the last one is the "did it post?" queue an operator
  actually needs to see.
- Permissions `0600` (qa F-10, POSIX-gated per § 3); `login --revoke --purge-journal`
  per security F15.

### 2c. plan_id store — **CONFIRM the mechanism, REFUTE any on-disk persistence**

Origin: ai-dx F1 (plan-token binding), security F4 (confirmation token).

"Stored server-side" must be pinned down before someone implements it as a file. From
an ops standpoint the store must be **in-memory only**:

- The plan→apply pair happens within one MCP session, i.e. one server process. A
  server restart between plan and apply loses the plan — and the designed recovery
  ("plan expired, re-plan and re-confirm") is *correct* behavior after a restart,
  because creator_info may have changed.
- A disk store would create: a cleanup obligation (TTL sweeps across restarts), a new
  secrets-adjacent artifact (args hashes + account bindings) subject to the same
  0600/redaction/purge rules as the journal, a cross-process coherence question
  (which process owns sweeping?), and doctor/uninstall surface — all for zero
  operational win.
- Spec: `Map<plan_id, {args_hash, profile, created_at, used}>`, lazy eviction on
  access + sweep on each plan creation, hard cap 100 entries (LRU) to bound memory.
  Nothing on disk; nothing for doctor, `--revoke`, or uninstall docs to mention.
  State this explicitly in ARCHITECTURE § 8 so drift toward persistence is a
  reviewable decision, not an accident.

### 2d. TT_MEDIA_ROOT — **CONFIRM the control, REFINE default + containment algorithm**

Origin: security F3.

The exfiltration control is right. Two ops refinements:

- **Default when unset: fail closed, but with a first-class error.** A permissive
  default (e.g. `~`) guts the control — `~/.ssh`, `~/.aws`, browser profiles all live
  under home. A silent deny generates the #1 support issue ("it worked in the demo").
  Resolution: unset ⇒ `source: "file"` is rejected **locally** with the exact
  remediation (`Set TT_MEDIA_ROOT to the folder containing your videos, e.g.
  TT_MEDIA_ROOT=~/Movies, then retry`), the README quickstart block includes
  `TT_MEDIA_ROOT` alongside the client key/secret, and `doctor` validates the
  configured value (§ 5.1 check 10). First-run UX is solved by documentation and
  error text, not by weakening the control.
- **Containment algorithm.** `startsWith` prefix checks are wrong twice: `/media`
  matches `/media-evil`, and Windows paths compare case-insensitively. Specify:
  canonicalize both sides with `fs.realpath` (resolves symlinks — required by
  security F3 anyway), then containment via `path.relative(root, target)` — inside iff
  the result is non-empty-or-empty, not `..`-prefixed, and not absolute; compare
  case-insensitively on `win32`. Cross-platform note for CONFIGURATION.md: the value
  is a plain absolute path (`C:\Users\me\Videos` on Windows); `~` expansion is done by
  the server, not the shell, when the value comes from an MCP client config.

### 2e. Core-level redaction — **CONFIRM, with log-shipping consequences made explicit**

Origin: security F1/F2; platform review Finding 4 (`upload_token` in `upload_url`).

Placing the redaction primitive in `core/` (below `mcp/`) is the correct call and has
operational consequences the spec should claim as features:

- **stderr becomes safe to ship.** Real deployments capture stderr into files,
  journald, or log shippers (Datadog/CloudWatch) — often without the operator
  consciously deciding to. If redaction lives only at MCP result shaping, every
  shipped log line is a token-leak channel. With a single choke point in
  `core/log.ts` through which *every* emitted line passes (registered-secret
  replacement + pattern sweep, including `upload_token` query params per platform
  Finding 4), the runbook can state: "stderr is line-JSON and safe to ship as-is."
  That sentence is only writable with core-level redaction.
- **Doctor output is a leak channel too.** Users paste `doctor` output into GitHub
  issues verbatim — this is where credentials leak in the wild. `doctor` (and
  `login`'s console output) must route through the same primitive. Add a test:
  doctor output with fully-populated env contains no secret material.
- **Journal writes** route through the same primitive (qa F-10's secret-freedom test
  then covers one code path, not N).
- Cost note: redaction on every log line is O(secrets × line length) — registered
  secrets are ≤ ~10 strings; this is noise. No sampling or opt-out needed.

## 3. The Windows decision (round-1 F1)

### Analysis

**What `fs.chmod` actually does on win32.** Node/libuv does not implement Windows
ACLs. `fs.chmod` only toggles the FILE_ATTRIBUTE_READONLY bit: if any write bit is
present in the mode, the read-only attribute is cleared; if none, it is set. Group and
other bits are ignored entirely, and `fs.stat` reports a synthesized mode (0666/0444
family), so a "mode is 0600" assertion can never pass on Windows
([nodejs/node#30019](https://github.com/nodejs/node/issues/30019),
[cross-platform-node-guide: permissions](https://github.com/ehmicky/cross-platform-node-guide/blob/main/docs/5_security/permissions.md)).
Corollary worth stating because it is subtle: `chmod(0o600)` on win32 is a **harmless
no-op** (owner-write present ⇒ read-only not set) — it neither protects nor breaks
subsequent token-rotation writes.

**Is icacls realistic for an npx-distributed tool?** Technically yes
(`icacls <file> /inheritance:r /grant:r "%USERNAME%":F`), practically no as an
automatic step: it means spawning a shell tool with locale-dependent output from a
server process, and it misbehaves on OneDrive-redirected profiles, roaming domain
profiles, and non-NTFS volumes. No comparable npx/CLI tool does it.

**What the comparable CLIs actually do.** AWS CLI stores plaintext
`%USERPROFILE%\.aws\credentials` with **no additional ACLs** — it relies on the
default NTFS ACLs of the user profile directory (user + SYSTEM + Administrators)
([AWS CLI config files](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)).
gcloud does the same with its credential files under the profile. gh prefers the OS
credential store (Windows Credential Manager) but **falls back to a plaintext
`hosts.yml`** when the store is unavailable
([cli/cli#7757](https://github.com/cli/cli/issues/7757)). So "plaintext under the
profile directory, protected by default profile ACLs" is the established norm for
this class of tool; DPAPI/Credential-Manager integration is the gold standard but
requires native modules or shelling out — incompatible with a 3-dependency npx
package.

### Recommendation (one): **Full functional support on Windows, with documented best-effort file protection — no ACL automation, no platform guard**

Exact specification:

1. **Storage location**: `%LOCALAPPDATA%\tiktok-mcp-ai\.env` (and journal beside it).
   **Not** `%APPDATA%` — Roaming profiles replicate to other machines and tokens must
   not roam. Resolver order on win32: `TT_ENV_FILE` → `%LOCALAPPDATA%\tiktok-mcp-ai\.env`
   → project `.env`; write target is always the `%LOCALAPPDATA%` path.
2. **chmod policy**: call `fs.chmod(path, 0o600)` unconditionally on all platforms
   (no-op on win32, see above); **assert** modes only when
   `process.platform !== "win32"` (aligns with qa F-25). On win32 the fallback
   assertion is: file exists, content round-trips.
3. **Directory creation**: `0o700` on POSIX; on win32 create normally and rely on
   inherited profile ACLs. **Never spawn `icacls` automatically.**
4. **Atomic rename hardening**: `rename` onto an open destination fails with
   `EPERM`/`EBUSY` on Windows (AV scanners, Search indexer). Retry ×3 with
   50/100/200 ms backoff; on final failure keep the in-memory token, warn loudly,
   retry persistence on next write (same degradation path as qa F-3a).
5. **Doctor on win32** (§ 5.1 check 3): verify the resolved env-file path is under
   `%USERPROFILE%`; if the operator pointed `TT_ENV_FILE` somewhere world-readable
   (e.g. `C:\temp`), FAIL with remediation. Print one info line: *"Windows: file
   protection relies on your user-profile ACLs (the same model as aws-cli and
   gcloud). To harden further, run: icacls "<path>" /inheritance:r /grant:r
   "%USERNAME%":F"* — remediation **text only**, never executed by the tool.
6. **Build-script hygiene**: remove the POSIX `chmod 755` from the build script
   (round-1 F14) — npm sets bin executability itself; if needed use `fs.chmod` from a
   Node script.
7. **SECURITY.md + README**: one explicit "Windows token storage" paragraph stating
   the model above, so the posture is a documented decision, not an omission.
8. **CI**: the Windows leg is **blocking from the first CI landing** (Phase 0/1), not
   Phase 3 (see § 4.1). Windows support that isn't continuously tested is
   non-support with extra steps.
9. **No `os` field, no engine/platform guard** in `package.json` — we support the
   platform.

Rejected alternatives, for the record: *full support with automated ACLs* — icacls
automation is fragile and unprecedented in this tool class; *v1 non-support with
platform guard* — Claude Desktop's largest install base is Windows, and the actual
work to reach parity (items 1–6) is smaller than the support burden a guard would
create.

## 4. Pipelines (implementation-grade)

### 4.0 The Node version decision

As of this review: **Node 20 is EOL** (2026-04-30); Node 22 is Maintenance LTS (EOL
2027-04-30); **Node 24 is Active LTS** (EOL 2028-04-30, Maintenance from 2026-10-20);
Node 26 is Current, LTS in Oct 2026
([nodejs/Release](https://github.com/nodejs/Release),
[nodejs.org EOL](https://nodejs.org/en/about/eol)). c8 is broken on Node ≥ 25
(sibling's `coverage-guard`).

Decision, superseding both README ("Node ≥ 20") and ROADMAP Phase 3 ("20/22/24
matrix"):

- `engines: { "node": ">=22" }`, `.npmrc` `engine-strict=true`, `.nvmrc` → `24`.
- Blocking matrix: **ubuntu × {22, 24}, macos × 24, windows × 24**.
- Advisory leg: **ubuntu × 26**, `continue-on-error: true`, tests without coverage
  (c8 incompatibility) — early warning for the Oct 2026 LTS transition.
- Coverage gate runs once, on ubuntu/24.

### 4.1 `.github/workflows/ci.yml`

All action refs must be SHA-pinned (round-1 F13); `<SHA>` placeholders below are
resolved at implementation time.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: verify (${{ matrix.os }}, node ${{ matrix.node }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest]
        node: [22, 24]
        include:
          - { os: macos-latest, node: 24 }
          - { os: windows-latest, node: 24 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@<SHA> # v4
      - uses: actions/setup-node@<SHA> # v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run lint
      - run: npm run format:check
      - run: npm test            # includes sync gates, manifest snapshot,
                                 # stdout-purity smoke, serverjson-sync
      - name: Coverage gate
        if: matrix.os == 'ubuntu-latest' && matrix.node == 24
        run: npm run test:coverage

  launcher-probe:
    name: ancient-node launcher probe
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 14 }
      - name: bin guard prints a clear message and exits non-zero
        run: |
          set +e
          out=$(node bin/tiktok-mcp-ai.cjs 2>&1)
          code=$?
          set -e
          echo "$out"
          test $code -ne 0
          echo "$out" | grep -q "Node.js >= 22"

  pack-audit:
    name: tarball audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: node scripts/pack-audit.mjs   # spec in § 4.5

  audit-deps:
    name: npm audit (runtime, high+)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high

  node-next:
    name: advisory - node 26 (no coverage)
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 26, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test
```

Blocking set (branch protection): all `verify` legs, `launcher-probe`, `pack-audit`,
`audit-deps`. Advisory: `node-next`. The zero-secret invariant (round-1 F13) holds:
no job has any secret, `permissions` is read-only, no `pull_request_target`. The
weekly *full* `npm audit` (dev deps included, any severity) lives in the scheduled
`audit-schedule.yml` per round-1 F6 — unchanged, not restated.

### 4.2 `.github/workflows/codeql.yml`

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "17 6 * * 1"

permissions:
  contents: read

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
      actions: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: github/codeql-action/init@<SHA>
        with:
          languages: javascript-typescript
          build-mode: none
      - uses: github/codeql-action/analyze@<SHA>
        with:
          category: "/language:javascript-typescript"
```

### 4.3 npm trusted publishing — exact setup

Current state (verified 2026-07): trusted publishing via OIDC is GA
([GitHub changelog](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/),
[npm docs](https://docs.npmjs.com/trusted-publishers/)). Provenance attestations are
generated **automatically** when publishing through a trusted publisher — no
`--provenance` flag needed
([npm provenance docs](https://docs.npmjs.com/generating-provenance-statements/)).
Requirements and traps:

1. **First-publish bootstrap is manual.** OIDC cannot create a package — the package
   must exist on npm before a trusted publisher can be configured
   ([philna.sh: things you need to do for trusted publishing](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)).
   Sequence: publish `0.1.0` **locally** with 2FA (`npm publish` after a full
   `npm run check`), then configure the trusted publisher. This also resolves
   round-1 F16 (unreserved name) — do the manual publish as soon as the package
   skeleton exists; an honest `0.1.0-alpha` under the final name reserves it.
2. **npmjs.com configuration** (package → Settings → Publishing access):
   - Add trusted publisher → GitHub Actions → organization/user `IvanBBaev`,
     repository `tiktok-mcp`, workflow filename `publish.yml`, environment: leave
     empty (no GH environment used).
   - Publisher configs created **after 2026-05-20** must explicitly select allowed
     actions — select **Publish**.
   - Flip **"Require OIDC / disallow tokens"** — this is the easily-missed toggle
     that actually closes the token attack surface; without it the trusted publisher
     is additive, not restrictive.
3. **npm CLI ≥ 11.5.1** is required in the workflow. Do not assume the
   runner/Node-24 bundle satisfies it — pin defensively with
   `npm install -g npm@latest` (see § 4.4).
4. Workflow job needs `permissions: id-token: write`. No `NPM_TOKEN` secret exists
   anywhere — end state per round-1 deep dive B: repo contains no secrets, CI holds
   no secrets.

### 4.4 `.github/workflows/publish.yml`

Trigger: version tags. Jobs: verify → release-guard → npm-publish → mcp-registry.

```yaml
name: Publish

on:
  push:
    tags: ["v*.*.*"]

permissions: {}

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run check        # build + lint + format + test + coverage + audit
      - run: node scripts/pack-audit.mjs

  release-guard:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: 24 }
      - run: node scripts/release-guard.mjs "${GITHUB_REF_NAME}"

  npm-publish:
    needs: [verify, release-guard]
    runs-on: ubuntu-latest
    permissions:
      id-token: write            # OIDC exchange with npm
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with:
          node-version: 24
          registry-url: "https://registry.npmjs.org"
      - run: npm install -g npm@latest   # trusted publishing needs npm >= 11.5.1
      - run: npm ci
      - run: npm run build
      - run: npm publish                 # no token; OIDC; provenance automatic

  mcp-registry:
    needs: npm-publish
    runs-on: ubuntu-latest
    permissions:
      id-token: write            # github-oidc login to the MCP registry
      contents: read
    steps:
      - uses: actions/checkout@<SHA>
      - name: Wait for npm propagation
        run: node scripts/wait-npm.mjs "tiktok-mcp-ai" "${GITHUB_REF_NAME#v}"
      - name: Install mcp-publisher
        run: |
          curl -fsSL \
            "https://github.com/modelcontextprotocol/registry/releases/download/<PINNED_VERSION>/mcp-publisher_<PINNED_VERSION>_linux_amd64.tar.gz" \
            -o mcp-publisher.tar.gz
          echo "<PINNED_SHA256>  mcp-publisher.tar.gz" | sha256sum -c -
          tar xzf mcp-publisher.tar.gz mcp-publisher
      - run: ./mcp-publisher login github-oidc
      - run: ./mcp-publisher publish
```

`scripts/wait-npm.mjs` spec: poll
`https://registry.npmjs.org/<name>/<version>` every 15 s until HTTP 200; timeout
10 min (propagation is usually < 1 min; the timeout exists for registry incidents);
on timeout exit 1 with "npm publish succeeded but the version is not yet visible —
re-run only the failed jobs once it appears". Because `mcp-registry` is a separate
job, GitHub's "re-run failed jobs" repeats registry publication **without**
re-publishing npm — this is the recovery path for every registry-side failure.

Registry preconditions (per
[MCP registry quickstart](https://modelcontextprotocol.io/registry/quickstart)):
`package.json` carries `"mcpName": "io.github.IvanBBaev/tiktok-mcp-ai"` (the
registry's npm-ownership validation marker — it must be inside the *published
tarball*, which pack-audit asserts); `server.json.name` equals `mcpName`; the
`io.github.IvanBBaev/` prefix is what `github-oidc` login authorizes. `server.json`
is regenerated by `gen:manifest` and CI-checked by the `serverjson-sync` gate
(qa F-24), so the tag commit is guaranteed current — this closes round-1 F5's
ordering concern end-to-end: tag ⇒ guard proves versions match ⇒ npm ⇒ poll ⇒
registry.

### 4.5 `scripts/release-guard.mjs` — spec + runnable pseudocode

Checks (all must pass; each failure prints its own remediation):

```js
// usage: node scripts/release-guard.mjs v0.2.0
const tag = process.argv[2] ?? "";
const fail = (msg) => { console.error(`release-guard: ${msg}`); process.exitCode = 1; };

if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag "${tag}" is not vX.Y.Z`);
const v = tag.slice(1);

const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.version !== v)
  fail(`package.json version ${pkg.version} != tag ${v} — run npm version ${v}`);
if (pkg.mcpName !== "io.github.IvanBBaev/tiktok-mcp-ai")
  fail(`package.json mcpName is "${pkg.mcpName}" — registry validation will reject`);

const server = JSON.parse(await readFile("server.json", "utf8"));
if (server.name !== pkg.mcpName) fail(`server.json name != mcpName`);
if (server.version !== v) fail(`server.json version ${server.version} != ${v} — run npm run gen:manifest`);
for (const p of server.packages ?? [])
  if (p.version !== v) fail(`server.json packages[].version ${p.version} != ${v}`);

const changelog = await readFile("CHANGELOG.md", "utf8");
const headings = [...changelog.matchAll(/^## \[?(\d+\.\d+\.\d+)\]?/gm)].map(m => m[1]);
if (headings[0] !== v)
  fail(`CHANGELOG.md top entry is "${headings[0] ?? "none"}", expected ${v} — add the release notes`);

process.exit(process.exitCode ?? 0);
```

Run in `publish.yml` (blocking) **and** locally via `npm run release-guard` before
tagging (round-1 F4's discipline made mechanical). Deliberately *not* run on every
PR — versions are only meaningful at tag time.

### 4.6 `scripts/pack-audit.mjs` — spec

Purpose: the published tarball's file list is a reviewed fixture; no accidental
inclusion (env files, journals, review docs, tests) or loss (bin launcher) can ship.

1. Run `npm pack --dry-run --json`; extract `files[].path`; sort; strip sizes/mtimes.
2. Deep-compare against `test/fixtures/pack-manifest.json`. Any diff fails with the
   added/removed lists and "if intentional: npm run gen:pack-manifest and commit the
   reviewed diff".
3. Hard invariants asserted regardless of fixture state:
   - present: `package.json`, `README.md`, `LICENSE`, `bin/tiktok-mcp-ai.cjs`,
     `build/index.js`, `server.json`;
   - absent: any `*.map` (files-allowlist `!build/**/*.map` per the sibling), any
     path matching `\.env`, `journal`, `docs/`, `test/`, `.claude`, `WORKLOG`;
   - `package.json` inside the pack has **no** `preinstall`/`install`/`postinstall`
     scripts (install-script supply-chain guard, round-1 F12);
   - `pkg.mcpName` present (registry validation reads it from the tarball).
4. Runs on every PR (`pack-audit` job) and inside publish `verify`.

### 4.7 `dependabot.yml`

Round-1 F6/F13 stand: weekly `npm` + `github-actions` ecosystems, grouped minor/patch
updates. One addition: dependabot PRs exercise the full blocking set including
`pack-audit`, which catches a dependency update that changes tarball contents (e.g. a
hoisted file) — worth a comment in the config so nobody "optimizes" pack-audit out of
PR scope.

## 5. Ops runbook

### 5.1 `doctor` — full check list

Output: human-readable by default, `--json` for machines; **all output passes the
core redaction primitive** (§ 2e). Exit code 0 = no FAIL (warnings allowed), 1 = any
FAIL. `--probe` opts into network checks; without it doctor is fully offline.

| # | Check | Pass | Fail/Warn | Remediation text (printed) |
|---|---|---|---|---|
| 1 | Node version | `>= 22` | FAIL below | "Install Node 24 LTS (nodejs.org). Node 20 reached end-of-life 2026-04-30." |
| 2 | Package staleness (network, 2 s timeout, skipped offline) | running version == npm `latest` | WARN if older | "A newer version exists (X.Y.Z). npx caches aggressively: clear with `rm -rf ~/.npm/_npx` (POSIX) / `%LOCALAPPDATA%\npm-cache\_npx` (Windows), or pin `tiktok-mcp-ai@latest`." |
| 3 | Env file resolution | resolved path printed; file exists, parses | FAIL unparseable; WARN missing (pre-login state) | "Run `npx tiktok-mcp-ai login`." / parse error line number |
| 4 | Env file protection | POSIX: mode 0600, dir 0700; win32: path under `%USERPROFILE%` | FAIL | POSIX: "Run chmod 600 <path>". win32: profile-ACL info line + optional icacls command (§ 3 item 5) |
| 5 | Unknown `TT_*` keys | none | WARN each | "Unknown key TT_PROFLE_X — did you mean TT_PROFILE_X?" (typo detection against the settings table) |
| 6 | Credentials per profile | client key+secret present; token expiries parseable | FAIL missing pair; WARN token absent | "Profile 'brand': run login with TT_PROFILE=brand" |
| 7 | Refresh-token horizon | > 14 days to 365-day expiry | WARN under 14 d; FAIL expired | "Refresh token expires in N days — re-run login before then; after expiry a full browser login is required." |
| 8 | Stale env-file lock | no `<env>.lock`, or younger than 5 s | WARN stale | "A previous process crashed while writing credentials. Remove: rm -rf <path>.lock" |
| 9 | Journal health | exists (or absent pre-first-write); parseable; size < 5 MB | WARN: N unparseable lines; M attempts with outcome `unknown`; rotation overdue | "M publish attempts have no recorded outcome — verify with tiktok_get_publish_status before re-posting." |
| 10 | `TT_MEDIA_ROOT` | unset (info) or set + exists + directory + readable | FAIL set-but-invalid | "TT_MEDIA_ROOT points to a missing directory: <path>" ; info when unset: "file uploads disabled until set" |
| 11 | Write-mode / registry config | `TT_WRITE_MODE` ∈ plan/apply/deny; package names valid | FAIL invalid value | lists valid values / known packages |
| 12 | Transport config | stdio; or http with token when host ≠ loopback | FAIL non-loopback tokenless | "Set TT_HTTP_TOKEN or bind 127.0.0.1." |
| 13 | Login readiness | `TT_REDIRECT_PORT` (fixed-port mode) currently bindable | WARN busy | "Port 43110 is in use — login will fail; set TT_REDIRECT_PORT or free the port." |
| 14 | Scopes vs packages (needs stored scope list; `--probe` re-verifies live) | every enabled package's scopes granted | WARN | "Package `publish` enabled but scope video.publish not granted — run login --scopes video.publish" |
| 15 | `--probe` only: live `user/info` per profile | envelope `ok` | FAIL with taxonomy class | maps to the standard error taxonomy (re-login / scopes / rate limit) |

### 5.2 Journal lifecycle

As specified in § 2b: append-only two-record schema (`attempt` fsync'd pre-init,
`outcome` on response), `v: 1` per record, 5 MB rotation to a single `.1` generation,
torn-tail tolerance with skip-and-count, 0600, `--purge-journal` on revoke, doctor
reporting per § 5.1 check 9. One addition for supportability: the journal's first
line after creation/rotation is a header record
`{v:1, event:"header", created_by:"tiktok-mcp-ai@X.Y.Z"}` — when a user attaches a
journal to a bug report, the producing version is in the file itself.

### 5.3 npx version staleness

`npx -y tiktok-mcp-ai` resolves from the npx cache and can serve a stale version
indefinitely. Policy (extends round-1 F10):

- MCP client config examples in README use the bare name (fast startup); the
  **staleness surface is doctor check 2**, which is cheap and offline-safe.
- Document the actual cache-clear commands (npm's cache clean does *not* clear npx):
  `rm -rf ~/.npm/_npx` / `%LOCALAPPDATA%\npm-cache\_npx`.
- `@latest` pinning is documented as the opt-in for always-fresh (cost: registry
  check + possible reinstall on every client start — meaningful on Claude Desktop
  startup path; that is why it is not the default recommendation).
- Every release's CHANGELOG entry is the user-facing trigger; SECURITY-relevant
  releases get a "please update" note that doctor's WARN reinforces.

### 5.4 Per-platform path matrix

| Artifact | Linux | macOS | Windows |
|---|---|---|---|
| Env file (write target) | `$XDG_CONFIG_HOME/tiktok-mcp-ai/.env`, default `~/.config/tiktok-mcp-ai/.env` | `~/.config/tiktok-mcp-ai/.env` (deliberately XDG-style, **not** `~/Library` — matches sibling and gh; one doc, one test, one support answer) | `%LOCALAPPDATA%\tiktok-mcp-ai\.env` (not Roaming, § 3) |
| Journal | same dir, `journal.ndjson` | same | same |
| Lock | `<env>.lock/` (mkdir) beside the env file | same | same |
| Plan store | in-memory only (§ 2c) | — | — |
| Logs | stderr only — no log files, ever | — | — |
| npx cache (support answers) | `~/.npm/_npx` | `~/.npm/_npx` | `%LOCALAPPDATA%\npm-cache\_npx` |

`TT_ENV_FILE` overrides the env-file location on all platforms; journal and lock
always live beside the *resolved* env file (so a custom location keeps its artifacts
together, and `--purge-journal` needs no second resolver).

### 5.5 Env-file schema upgrade / migration policy

The env file outlives any single version of the server; npx staleness (§ 5.3) means
**old binaries will read files written by new binaries** and vice versa. Policy:

1. **Schema marker**: every save writes `TT_CONFIG_SCHEMA=1` (absent ⇒ 1). Bump only
   on incompatible shape changes (a key *rename* is compatible under rule 3; a
   semantic change of an existing key's value format is not).
2. **Forward compatibility (old binary, newer file)**: unknown `TT_*` keys are
   ignored with a single warning — and the comment-preserving writer **must
   round-trip unknown keys verbatim** (never drop what it doesn't understand). If
   `TT_CONFIG_SCHEMA` is greater than the binary supports: refuse to *write* (read
   is best-effort), with "this config was written by a newer version — update:
   npx tiktok-mcp-ai@latest".
3. **Renames (e.g. profile key renames)**: maintain a `LEGACY_KEYS` map in
   `core/config.ts`. On load, legacy names are read with a deprecation warning; on
   the next save, values are written under the new name and the old line is replaced
   in place (comment preserved above it). The map is kept for **at least two minor
   versions** after the rename ships; removal is a CHANGELOG "Breaking" entry.
4. **Pre-migration backup**: the first save that changes `TT_CONFIG_SCHEMA` copies
   the file to `.env.pre-schema<N>` (0600) once. Doctor lists leftover backups as
   info with a "safe to delete after verifying login works" note.
5. **Never migrate on read.** Migration happens only on an explicit write (login,
   token rotation, or `doctor --fix` if ever added) — a read-only invocation must
   not mutate the operator's file.
6. Removal/renaming of any documented key requires touching the settings table,
   which `env-docs-sync` + `serverjson-sync` gates propagate to `.env.example`,
   README, and `server.json` in the same commit — the migration policy rides the
   existing sync-gate machinery.

## 6. New findings and spec amendments

### New findings

- **R2-F1 — HIGH — Trusted publishing cannot perform the first publish; publish.yml
  has two version traps.** The package must exist before a trusted publisher can be
  configured; first publish is manual with 2FA (§ 4.3). Additionally: npm CLI must be
  ≥ 11.5.1 in the workflow, and publisher configs created after 2026-05-20 must have
  the "Publish" action explicitly selected. Refines round-1 F3/F16; without this the
  first tag push fails in a confusing way.
- **R2-F2 — MEDIUM — ROADMAP/README Node claims are stale.** "Node ≥ 20" and the
  Phase-3 "20/22/24 matrix" predate Node 20's EOL (2026-04-30). Engines ≥ 22, matrix
  22/24 + advisory 26; the advisory leg must skip c8 (broken ≥ 25).
- **R2-F3 — MEDIUM — The plan_id store's persistence is unspecified and will drift
  to disk if unstated.** Must be specified as in-memory only, LRU-capped, with
  restart ⇒ re-plan as the designed recovery (§ 2c).
- **R2-F4 — MEDIUM — The env-file lock needs an explicit crash/stale spec.**
  mkdir-based acquisition, mtime-age staleness (5 s), lock scope = file mutation
  only, never PID checks; degrade like persist failure, never fail a tool call
  (§ 2a).
- **R2-F5 — MEDIUM — Journal write-ahead must be append-only two-record, not
  update-in-place.** ai-dx F4's "update the row" is the wrong mechanism; attempts
  without outcomes are the crash-visible truth (§ 2b).
- **R2-F6 — LOW — Doctor/login console output must pass redaction** — pasted doctor
  output in GitHub issues is a primary real-world leak channel (§ 2e).
- **R2-F7 — LOW — TT_MEDIA_ROOT containment algorithm must be specified**
  (realpath + `path.relative`, case-insensitive on win32; fail-closed unset with
  actionable error) (§ 2d).
- **R2-F8 — LOW — npx cache-clear instructions are missing** from the docs; doctor
  staleness WARN should include them verbatim (§ 5.3).

### Spec amendments (ordered, concrete)

1. `README.md` + `docs/ROADMAP.md`: Node ≥ 20 → **Node ≥ 22**; Phase-3 CI matrix →
   22/24 blocking + 26 advisory; move "CI landing" (ci.yml + Windows leg +
   launcher probe) from Phase 3 into **Phase 0 exit criteria** (round-1 F2, now with
   the concrete workflow from § 4.1 there is nothing left to defer).
2. `docs/ARCHITECTURE.md` § 7: add the lock spec (§ 2a) — mkdir lock, 5 s mtime
   staleness, mutation-only scope, degradation path; add the win32 storage/rename
   rules (§ 3 items 1–4).
3. `docs/ARCHITECTURE.md` § 8: journal = append-only two-record write-ahead schema
   with `v`, rotation at 5 MB/one generation, torn-tail tolerance, header record
   (§ 2b, § 5.2); plan store = in-memory only, LRU 100, TTL 10 min (§ 2c).
4. `docs/SECURITY.md`: add the "Windows token storage" paragraph (§ 3 item 7);
   restate stderr-safe-to-ship + doctor-output redaction as consequences of the
   core-level redaction primitive (§ 2e).
5. `docs/CONFIGURATION.md`: env-file resolution table gains the win32 column
   (`%LOCALAPPDATA%`, not Roaming); add `TT_CONFIG_SCHEMA` and the migration policy
   summary (§ 5.5); document `TT_MEDIA_ROOT` unset ⇒ file source disabled with the
   exact error text (§ 2d).
6. `docs/AUTH.md`: doctor check list (§ 5.1) becomes the normative doctor spec;
   add refresh-token-horizon warning (check 7) and `--json`.
7. Create `scripts/release-guard.mjs`, `scripts/pack-audit.mjs`,
   `scripts/wait-npm.mjs` per § 4.5/4.6/4.4; add `test/fixtures/pack-manifest.json`
   and `npm run gen:pack-manifest`.
8. Create `.github/workflows/ci.yml`, `codeql.yml`, `publish.yml`, `dependabot.yml`
   per § 4; SHA-pin all actions; configure branch protection with the blocking set
   (§ 4.1).
9. Release process doc (CONTRIBUTING or RELEASING.md): manual first publish with
   2FA → npmjs trusted-publisher setup incl. the "Require OIDC" toggle and
   post-2026-05-20 action selection → all later releases via tag push (§ 4.3).
10. `docs/TESTING.md`: add pack-audit to the CI-gates list; platform-gate mode
    assertions per § 3 item 2 (aligns with qa F-25); add a rename-retry test for the
    win32 EPERM path (mockable via injectable fs seam).

## 7. Remaining unknowns

1. **mcp-publisher release pinning** — the exact release version + sha256 for the
   binary download in `publish.yml` must be resolved and pinned at implementation
   time (placeholder in § 4.4); revisit whether the registry ships an official
   GitHub Action by then.
2. **npm propagation SLA** — the 15 s/10 min polling numbers are conservative
   guesses; measure during the first real publish and tighten.
3. **Whether the MCP registry re-validates `mcpName` from the tarball or the
   registry metadata at publish time** — pack-audit asserts it in the tarball either
   way; verify the failure mode once during the first registry publish.
4. **npm bundled with Node 24 on `ubuntu-latest` vs the 11.5.1 floor** — the
   `npm install -g npm@latest` step makes this moot but adds seconds; check and
   drop it if the runner image is already compliant.
5. **Windows Dev Drive / ReFS rename semantics** — the EPERM/EBUSY retry (§ 3
   item 4) is designed for NTFS + AV; ReFS behavior unverified. Low risk; the retry
   is harmless either way.
6. **TikTok audit timing vs release cadence** (round-1 F11 stands) — whether the
   npm listing should carry the "unaudited: SELF_ONLY" caveat in the package
   description until the audit passes; decide at Phase-3 entry.
7. **Node 26 LTS transition (Oct 2026)** — when 26 goes LTS, promote the advisory
   leg to blocking and re-test c8 (or its replacement) on ≥ 25; tracked by the
   `node-next` leg staying visible in CI.

---

*End of round-2 DevOps review. Companion round-1 document:
`docs/reviews/devops-release-review.md` (findings F1–F16 remain in force except
where refined above).*
