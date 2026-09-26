/**
 * cc-coverage (TESTING.md § Sync gates and repo meta).
 *
 * The gate compares the ids `docs/CORNER-CASES.md` defines against the ids
 * `test/` names, so its own correctness rests entirely on what it is willing to
 * call a definition. Two rules carry that weight and both are pinned here
 * against fixtures rather than against the committed tree, because the
 * committed tree is currently in sync and would keep a broken harvester green:
 *
 *  - **a range is not a definition.** `CC-A1–A7` is one string naming seven
 *    cases; a harvester that read ids from mentions would "define" `CC-A1` from
 *    a file that defines nothing and leave the other six invisible. The
 *    simplification is tempting — one regex instead of two — so it gets a test
 *    that fails loudly the day someone tries it;
 *  - **an exemption dies when its reason does.** An exemption for a case that
 *    is now tested is drift, and an exemption list that never fails is a skip
 *    list with better manners.
 *
 * The fixture ids are deliberately not the repo's real ones (domains X, Y, Z),
 * so nothing here can be mistaken for coverage of an actual corner case — and
 * `scripts/cc-coverage.ts` excludes this file from the citation scan anyway,
 * which is itself one of the tests below.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkCoverage,
  citedIds,
  definedIds,
  EXEMPTIONS,
  readCoverageInputs,
  syncCoverage,
  type CoverageInputs,
} from '../scripts/cc-coverage.js';
import { REPO_ROOT } from '../scripts/lib/repo.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * A catalog shaped like the real one: three definitions, and then every way the
 * repo's docs mention an id *without* defining it — a work-package range in en
 * dashes, a prose cross-reference, and the "open items" table that restates
 * ids it does not own.
 */
const CATALOG = `# Corner-case catalog

- **ID scheme:** \`CC-<domain><n>\`, reused in test names (\`cc-x1 something\`).

## X. A domain

- **CC-X1 — first case.** Prose that mentions CC-X2 as a cross-reference.
- **CC-X2 — second case.** More prose.

## Y. Another domain

- **CC-Y1 — the only case here.** Cases CC-X1–X2 are owned by WP-1.
- Cases CC-Z1–Z9 are owned by WP-2 and defined nowhere.
- **CC-Z1–Z9 — a range in the bullet position is still not a definition.**

## Open items

| ID | Question | Resolution |
|---|---|---|
| CC-X2 | Something | **CLOSED.** |
| CC-Z4 | Something else | **Open upstream.** |
`;

const DEFINED: readonly string[] = ['CC-X1', 'CC-X2', 'CC-Y1'];

function inputs(overrides: Partial<CoverageInputs> = {}): CoverageInputs {
  return {
    defined: overrides.defined ?? DEFINED,
    cited:
      overrides.cited ??
      new Map([
        ['CC-X1', 'test/one.test.ts'],
        ['CC-X2', 'test/one.test.ts'],
        ['CC-Y1', 'test/two.test.ts'],
      ]),
    exemptions: overrides.exemptions ?? new Map(),
  };
}

// ---------------------------------------------------------------------------
// Harvesting definitions
// ---------------------------------------------------------------------------

test('only the bullet definition sites are harvested, in catalog order', () => {
  assert.deepEqual(definedIds(CATALOG), DEFINED);
});

test('a range is a reference, never a definition — not even in bullet position', () => {
  // The whole point of the two-regex harvester. `CC-Z1–Z9` names nine cases and
  // defines none of them; a scan that read ids from mentions would invent
  // `CC-Z1`, silently swallow `CC-Z2…Z9`, and report full coverage of a domain
  // that has no definitions at all. If this test ever fails, the harvester was
  // "simplified" into an echo of the docs rather than a reading of them.
  const harvested = definedIds(CATALOG);
  for (const id of ['CC-Z1', 'CC-Z2', 'CC-Z4', 'CC-Z9']) {
    assert.ok(!harvested.includes(id), `${id} was invented from a range`);
  }
});

test('the open-items table restates ids without defining new ones', () => {
  // CC-Z4 appears only in the table. Harvesting it would put an id into the
  // authority that the catalog never decided, and then demand a test for it.
  assert.ok(!definedIds(CATALOG).includes('CC-Z4'));
  assert.ok(CATALOG.includes('| CC-Z4 |'), 'the fixture still exercises the table');
});

test('a catalog whose bullet form changed harvests nothing rather than guessing', () => {
  assert.deepEqual(definedIds('- CC-X1: first case, unbolded.\n'), []);
  assert.deepEqual(
    definedIds('  - **CC-X1 — indented, so not a top-level case.**\n'),
    [],
  );
});

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

test('citations are read in the lowercase the test-name convention asks for', () => {
  // TESTING.md § Test naming is lowercase throughout, and an uppercase-only
  // scan would report the entire suite as uncovered — the exact false alarm
  // that gets a gate loosened instead of obeyed.
  assert.deepEqual([...citedIds("test('cc-x1: a thing', () => {})")], ['CC-X1']);
  assert.deepEqual([...citedIds('// CC-X1 and Cc-X1 are the same id')], ['CC-X1']);
});

test('an id is matched on its own boundaries, not as a substring', () => {
  const found = citedIds('CC-X1, CC-X10, and MCC-X1X are three different things');
  assert.deepEqual([...found].sort(), ['CC-X1', 'CC-X10']);
});

test('a file citing nothing contributes nothing', () => {
  assert.equal(citedIds('const CC = 1; // no corner cases here\n').size, 0);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a catalog whose every case is named passes', () => {
  assert.deepEqual(checkCoverage(inputs()), []);
});

test('a defined case nothing names is reported, with both ways out', () => {
  const cited = new Map([['CC-X1', 'test/one.test.ts']]);
  const problems = checkCoverage(inputs({ cited }));
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? '', /^CC-X2 is defined in docs\/CORNER-CASES\.md/u);
  assert.match(problems[0] ?? '', /write the test, or add it to EXEMPTIONS/u);
  assert.match(problems[1] ?? '', /^CC-Y1 /u);
});

test('a citation the catalog does not define is a typo, and says so', () => {
  const cited = new Map<string, string>(inputs().cited);
  cited.set('CC-X88', 'test/typo.test.ts');
  const problems = checkCoverage(inputs({ cited }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /CC-X88 is named by test\/typo\.test\.ts/u);
  assert.match(problems[0] ?? '', /defines no such id — a typo/u);
});

test('an exemption stands in for a citation, and only for a defined id', () => {
  const cited = new Map([
    ['CC-X1', 'test/one.test.ts'],
    ['CC-Y1', 'test/two.test.ts'],
  ]);
  const exemptions = new Map([['CC-X2', 'only observable against a live sandbox']]);
  assert.deepEqual(checkCoverage(inputs({ cited, exemptions })), []);
});

test('an exemption for a case that is now tested is drift, and fails', () => {
  // The rule that keeps the list from becoming permanent: the day someone
  // writes the test, the exemption has to go with it. Without this the list
  // only ever grows, and every entry reads as "untestable" forever.
  const exemptions = new Map([['CC-X2', 'only observable against a live sandbox']]);
  const problems = checkCoverage(inputs({ exemptions }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /CC-X2 is exempted/u);
  assert.match(problems[0] ?? '', /test\/one\.test\.ts cites it now/u);
  assert.match(problems[0] ?? '', /delete the exemption/u);
});

test('an exemption for a case the catalog dropped is drift too', () => {
  const exemptions = new Map([['CC-X9', 'a case that was deleted in review']]);
  const problems = checkCoverage(inputs({ exemptions }));
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /no longer defines it/u);
});

test('every problem is reported once, ordered by id and numerically within a domain', () => {
  const defined = ['CC-X10', 'CC-X2', 'CC-Y1'];
  const problems = checkCoverage(inputs({ defined, cited: new Map() }));
  assert.deepEqual(
    problems.map((problem) => problem.split(' ')[0]),
    ['CC-X2', 'CC-X10', 'CC-Y1'],
  );
});

// ---------------------------------------------------------------------------
// End to end, against a throwaway tree
// ---------------------------------------------------------------------------

interface AfterHook {
  after: (fn: () => Promise<void>) => void;
}

async function fixture(
  t: AfterHook,
  files: Record<string, string> = { 'one.test.ts': "test('cc-x1 cc-x2 cc-y1', …)\n" },
  catalog: string = CATALOG,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-coverage-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'test', 'harness'), { recursive: true });
  await writeFile(join(root, 'docs/CORNER-CASES.md'), catalog, 'utf8');
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, 'test', name), body, 'utf8');
  }
  return root;
}

test('a tree whose tests name every case passes', async (t) => {
  assert.equal(await syncCoverage(await fixture(t)), true);
});

test('a tree with an unpinned case fails', async (t) => {
  const root = await fixture(t, { 'one.test.ts': "test('cc-x1 only', …)\n" });
  assert.equal(await syncCoverage(root), false);
});

test('this gate’s own test file is never a citation source', async (t) => {
  // It has to spell out `CC-X88` and range strings as fixtures. Counting those
  // would let the gate's own prose stand in as coverage, and would report the
  // typo it is testing for as a real one.
  const root = await fixture(t, {
    'cc-coverage.test.ts': "const typo = 'CC-X88'; // and cc-x1, cc-x2, cc-y1\n",
  });
  const read = await readCoverageInputs(root);
  assert.deepEqual([...(read?.cited.keys() ?? [])], []);
  assert.equal(await syncCoverage(root), false, 'the three real cases are unpinned');
});

test('citations are collected from nested test directories too', async (t) => {
  const root = await fixture(t, { 'one.test.ts': "test('cc-x1 cc-x2', …)\n" });
  await writeFile(
    join(root, 'test/harness/worker.ts'),
    '// cc-y1: the harness half of the case\n',
    'utf8',
  );
  const read = await readCoverageInputs(root);
  assert.equal(read?.cited.get('CC-Y1'), 'test/harness/worker.ts');
  assert.equal(await syncCoverage(root), true);
});

test('a missing catalog fails rather than passing vacuously', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-coverage-empty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await syncCoverage(root), false);
});

test('a catalog that defines nothing fails instead of reporting perfect coverage', async (t) => {
  // Zero definitions and zero citations is a passing set comparison and a
  // broken gate; the emptiness has to be the failure.
  const root = await fixture(t, { 'one.test.ts': '// nothing\n' }, '# Empty\n');
  assert.equal(await syncCoverage(root), false);
});

// ---------------------------------------------------------------------------
// The committed tree
// ---------------------------------------------------------------------------

test('the committed catalog and suite agree', async () => {
  const read = await readCoverageInputs(REPO_ROOT);
  assert.ok(read !== undefined);
  assert.deepEqual(checkCoverage(read), []);
});

test('the committed catalog defines the domains it advertises', async () => {
  const read = await readCoverageInputs(REPO_ROOT);
  const domains = new Set((read?.defined ?? []).map((id) => id.slice(3, 4)));
  assert.deepEqual([...domains].sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.ok((read?.defined.length ?? 0) > 60, 'the harvest is not one lucky bullet');
});

test('every exemption carries a reason, and today there are none', () => {
  for (const [id, reason] of EXEMPTIONS) {
    assert.match(id, /^CC-[A-Z]\d+$/u);
    assert.ok(reason.length > 20, `${id} needs a reason, not a placeholder`);
  }
  assert.equal(EXEMPTIONS.size, 0, 'every defined case is pinned by a named test');
});
