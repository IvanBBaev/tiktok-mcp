/**
 * The sync gates as tests (TESTING.md § Sync gates and repo meta).
 *
 * `npm run sync` compares the generated artifacts against the tree; this file
 * covers the two things a byte comparison cannot: the invariants the generators
 * assume (so a snapshot that regenerates cleanly is still *correct*), and the
 * pure rendering logic of the scripts themselves, which otherwise would only
 * ever be exercised by the gate that trusts it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PACKAGE_SCOPES, SCOPE_ORDER } from '../src/cli/login.js';
import { TOOL_PACKAGES } from '../src/core/settings.js';
import { RESULT_JSON_SCHEMA } from '../src/mcp/result.js';
import { PACKAGES, allTools, describeAllTools } from '../src/tools/index.js';
import { evaluate, matches, percent } from '../scripts/coverage-gate.js';
import { renderDefault, specCoverage } from '../scripts/gen-env-example.js';
import { renderManifest } from '../scripts/gen-manifest.js';
import { applyToolsBlock, renderToolsTable, summarize } from '../scripts/gen-readme.js';
import { firstDifference, REPO_ROOT } from '../scripts/lib/repo.js';

// ---------------------------------------------------------------------------
// describeAllTools — the shape every generated artifact is built from
// ---------------------------------------------------------------------------

test('describeAllTools covers the manifest exactly once, in manifest order', () => {
  const entries = describeAllTools();
  assert.deepEqual(
    entries.map((entry) => entry.tool.name),
    allTools().map((spec) => spec.name),
  );
});

test('describeAllTools is deterministic — no ambient credential leaks in', () => {
  assert.deepEqual(describeAllTools(), describeAllTools());
});

test('a fully authorized description never carries an UNAVAILABLE marker', () => {
  // The generated README and manifest are written for a complete install; a
  // marker there would document a limitation of the machine that ran the
  // generator, not of the server.
  for (const entry of describeAllTools()) {
    assert.equal(
      entry.tool.description?.startsWith('[UNAVAILABLE'),
      false,
      `${entry.tool.name} described as unavailable under a full grant`,
    );
  }
});

test('every tool shares the one result outputSchema', () => {
  // gen-manifest.ts emits `resultSchema` once on the strength of this; a tool
  // that diverged would still be snapshotted, but the sharing claim would be a
  // lie and the snapshot would grow a surprising inline schema.
  for (const entry of describeAllTools()) {
    assert.deepEqual(entry.tool.outputSchema, RESULT_JSON_SCHEMA, entry.tool.name);
  }
});

test('every described tool carries the four annotations and a title', () => {
  for (const entry of describeAllTools()) {
    const annotations = entry.tool.annotations ?? {};
    assert.equal(typeof annotations.title, 'string', entry.tool.name);
    for (const hint of [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const) {
      assert.equal(typeof annotations[hint], 'boolean', `${entry.tool.name}.${hint}`);
    }
  }
});

// ---------------------------------------------------------------------------
// PACKAGE_SCOPES drift (TOOLS.md § 2 scope column)
// ---------------------------------------------------------------------------

test('login requests every scope the registered tools need', () => {
  // Subset, always: a tool asking for a scope `login` never requests would fail
  // against the live API with an authorization error nobody can act on.
  for (const pkg of PACKAGES) {
    const granted = new Set(PACKAGE_SCOPES[pkg.name]);
    for (const spec of pkg.tools) {
      for (const scope of spec.scopes) {
        assert.ok(
          granted.has(scope),
          `${spec.name} needs "${scope}", which PACKAGE_SCOPES.${pkg.name} does not request`,
        );
      }
    }
  }
});

test('login never requests a scope this server does not know', () => {
  // The other direction is deliberately NOT equality: `user` requests the
  // profile and stats scopes although `tiktok_get_user_info` registers only
  // `user.info.basic`, because those scopes gate optional fields and a profile
  // that cannot answer in full is a re-login the user did not expect. What must
  // hold is that every requested scope is a real one — a typo would come back
  // from TikTok as a generic authorization failure.
  const known = new Set(SCOPE_ORDER);
  for (const [pkg, scopes] of Object.entries(PACKAGE_SCOPES)) {
    for (const scope of scopes) {
      assert.ok(
        known.has(scope),
        `PACKAGE_SCOPES.${pkg} requests unknown scope "${scope}"`,
      );
    }
  }
});

test('every known scope is reachable through some package', () => {
  // The converse: a scope in SCOPE_ORDER that no package requests can never be
  // granted, so a tool declaring it would be permanently unavailable.
  const requested = new Set(Object.values(PACKAGE_SCOPES).flat());
  for (const scope of SCOPE_ORDER) {
    assert.ok(requested.has(scope), `no package requests "${scope}"`);
  }
});

test('PACKAGE_SCOPES has an entry per package name', () => {
  assert.deepEqual(Object.keys(PACKAGE_SCOPES).sort(), [...TOOL_PACKAGES].sort());
});

// ---------------------------------------------------------------------------
// gen-readme.ts
// ---------------------------------------------------------------------------

test('the README table renders one row per tool with the read-only column', () => {
  const table = renderToolsTable(describeAllTools());
  const rows = table.split('\n').filter((line) => line.startsWith('| `'));
  assert.equal(rows.length, allTools().length);
  assert.ok(rows.every((row) => row.includes(' yes ') || row.includes(' no ')));
});

test('a pipe in a description is escaped instead of splitting the row', () => {
  const table = renderToolsTable([
    {
      package: 'video',
      scopes: [],
      tool: { name: 'tiktok_x', description: 'a | b', inputSchema: { type: 'object' } },
    },
  ]);
  assert.ok(table.includes('a \\| b'));
});

test('the README block replacement leaves every byte outside the markers alone', () => {
  const readme = [
    'before',
    '<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->',
    'stale',
    '<!-- GENERATED:TOOLS:END -->',
    'after',
  ].join('\n');
  const next = applyToolsBlock(readme, 'fresh');
  assert.ok(next.startsWith('before\n'));
  assert.ok(next.endsWith('\nafter'));
  assert.ok(next.includes('fresh'));
  assert.equal(next.includes('stale'), false);
});

test('the table cell is the first sentence, not the whole model-facing text', () => {
  assert.equal(summarize('One. Two. Three.'), 'One.');
  assert.equal(summarize('No terminator'), 'No terminator');
  assert.equal(summarize('Spans\na line break. Rest.'), 'Spans\na line break.');
  assert.equal(summarize(''), '');
});

test('every table cell stays short enough to read', () => {
  for (const entry of describeAllTools()) {
    const summary = summarize(entry.tool.description ?? '');
    assert.ok(
      summary.length <= 200,
      `${entry.tool.name}: first sentence is ${String(summary.length)} chars`,
    );
  }
});

test('a README without the markers fails loudly rather than silently', () => {
  assert.throws(() => applyToolsBlock('no markers here', 'x'), /markers are missing/);
});

// ---------------------------------------------------------------------------
// gen-env-example.ts
// ---------------------------------------------------------------------------

test('the .env.example spec documents exactly the known settings variables', () => {
  assert.deepEqual(specCoverage(), { missing: [], extra: [], duplicate: [] });
});

test('defaults render in env-file spelling', () => {
  assert.equal(renderDefault(undefined), '');
  assert.equal(renderDefault(true), '1');
  assert.equal(renderDefault(false), '0');
  assert.equal(renderDefault(30_000), '30000');
  assert.equal(renderDefault(['core', 'auth']), 'core,auth');
  assert.equal(renderDefault([]), '');
});

test('a default with no env-file spelling fails the generator instead of shipping', () => {
  // `[object Object]` in .env.example would be documentation that is worse than
  // none: it looks like a value a user could copy.
  assert.throws(() => renderDefault({ nested: true }), /no env-file spelling/);
});

// ---------------------------------------------------------------------------
// gen-manifest.ts
// ---------------------------------------------------------------------------

test('the manifest snapshot hoists the shared result schema exactly once', () => {
  const rendered = JSON.parse(renderManifest(describeAllTools())) as {
    resultSchema: unknown;
    tools: readonly Record<string, unknown>[];
  };
  assert.deepEqual(rendered.resultSchema, RESULT_JSON_SCHEMA);
  assert.equal(rendered.tools.length, allTools().length);
  for (const tool of rendered.tools) {
    assert.equal('outputSchema' in tool, false, String(tool['name']));
    assert.ok(Array.isArray(tool['scopes']));
  }
});

test('a tool whose outputSchema diverged keeps it inline', () => {
  const rendered = JSON.parse(
    renderManifest([
      {
        package: 'video',
        scopes: [],
        tool: {
          name: 'tiktok_x',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object', properties: { odd: { type: 'string' } } },
        },
      },
    ]),
  ) as { tools: readonly Record<string, unknown>[] };
  assert.ok(rendered.tools[0] !== undefined && 'outputSchema' in rendered.tools[0]);
});

// ---------------------------------------------------------------------------
// coverage-gate.ts
// ---------------------------------------------------------------------------

test('rule matching is exact for files and prefix-based for /**', () => {
  assert.equal(matches('src/core/http.ts', 'src/core/http.ts'), true);
  assert.equal(matches('src/core/http.ts', 'src/core/http2.ts'), false);
  assert.equal(matches('src/api/**', 'src/api/publish.ts'), true);
  assert.equal(matches('src/api/**', 'src/apix/publish.ts'), false);
});

test('an area with nothing to cover counts as covered', () => {
  assert.equal(percent({ total: 0, covered: 0 }), 100);
  assert.equal(percent({ total: 4, covered: 3 }), 75);
});

const FLOORS = {
  global: { lines: 90, branches: 80, functions: 95 },
  rules: [
    { path: 'src/core/oauth.ts', lines: 95, branches: 90, functions: 100 },
    { path: 'src/cli/**', lines: 85, branches: 75, functions: 90, advisory: true },
    { path: 'src/core/**', lines: 90, branches: 80, functions: 95 },
  ],
};

function fileSummary(lines: number, branches: number, functions: number) {
  const metric = (pct: number) => ({ total: 100, covered: pct });
  return {
    lines: metric(lines),
    branches: metric(branches),
    functions: metric(functions),
  };
}

test('each file is charged to its first matching rule, not to every match', () => {
  const { areas } = evaluate(FLOORS, {
    [`${REPO_ROOT}src/core/oauth.ts`]: fileSummary(96, 91, 100),
    [`${REPO_ROOT}src/core/log.ts`]: fileSummary(92, 84, 96),
  });
  const byPath = new Map(areas.map((area) => [area.path, area]));
  assert.equal(byPath.get('src/core/oauth.ts')?.files, 1);
  assert.equal(byPath.get('src/core/**')?.files, 1);
  assert.equal(byPath.get('GLOBAL')?.files, 2);
});

test('a metric below its floor fails the area', () => {
  const { areas } = evaluate(FLOORS, {
    [`${REPO_ROOT}src/core/oauth.ts`]: fileSummary(96, 80, 100),
  });
  const oauth = areas.find((area) => area.path === 'src/core/oauth.ts');
  assert.deepEqual(
    oauth?.failures.map((failure) => failure.metric),
    ['branches'],
  );
});

test('an advisory area reports its failure without blocking', () => {
  const { areas } = evaluate(FLOORS, {
    [`${REPO_ROOT}src/cli/login.ts`]: fileSummary(10, 10, 10),
  });
  const cli = areas.find((area) => area.path === 'src/cli/**');
  assert.equal(cli?.advisory, true);
  assert.equal(cli?.failures.length, 3);
});

test('a rule that matches no file yet neither passes nor fails silently', () => {
  const { areas } = evaluate(FLOORS, {});
  const oauth = areas.find((area) => area.path === 'src/core/oauth.ts');
  assert.equal(oauth?.files, 0);
  assert.deepEqual(oauth?.failures, []);
});

// ---------------------------------------------------------------------------
// lib/repo.ts
// ---------------------------------------------------------------------------

test('a drift report points at the first differing line', () => {
  const report = firstDifference('a\nb\nc', 'a\nx\nc');
  assert.match(report, /line 2/);
  assert.match(report, /"b"/);
  assert.match(report, /"x"/);
});

test('a file that is only truncated still reports a difference', () => {
  assert.match(firstDifference('a\nb', 'a'), /end of file/);
});
