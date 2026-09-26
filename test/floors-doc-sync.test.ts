/**
 * floors-doc-sync (TESTING.md § Sync gates and repo meta).
 *
 * The gate renders the § Coverage floors table from `scripts/coverage-floors.json`,
 * so everything that can go wrong with it goes wrong quietly: a table that looks
 * right and reports floors from two phases ago, or a generator that appends a
 * second table below the first and calls the document repaired.
 *
 * The fixtures are therefore not the committed tree. The committed tree is in
 * sync — it is the output of this gate — and would keep a renderer green that
 * dropped a rule, sorted the rows, or silently rendered `undefined` into a cell.
 * Two tests do read the committed files, and both check the thing a fixture
 * cannot: that the document a contributor actually opens agrees with the JSON
 * the gate actually enforces, rule for rule.
 *
 * Fixture paths are `src/alpha/**` and friends rather than the repo's real
 * areas, so no assertion here can be mistaken for a statement about a real
 * floor. Floors policy is not tested here at all — whether a floor is high
 * enough is `scripts/coverage-gate.ts`, against real coverage data.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseFloors,
  renderFloorsTable,
  replaceTable,
  syncFloorsDoc,
  type Floors,
} from '../scripts/floors-doc-sync.js';
import { REPO_ROOT } from '../scripts/lib/repo.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Shaped like the real file: a specific path before the `**` rule it sits
 * under, and one advisory rule.
 */
const FLOORS_JSON = JSON.stringify(
  {
    global: { lines: 90, branches: 80, functions: 95 },
    rules: [
      { path: 'src/alpha/one.ts', lines: 98, branches: 97, functions: 100 },
      { path: 'src/alpha/**', lines: 92, branches: 88, functions: 96 },
      {
        path: 'src/beta/**',
        lines: 85,
        branches: 70,
        functions: 90,
        advisory: true,
        advisoryReason: 'a sentence that belongs in the JSON, not in a table cell',
      },
    ],
  },
  null,
  2,
);

const TABLE = [
  '| Area | Lines | Branches | Functions |',
  '|---|---|---|---|',
  '| `src/alpha/one.ts` | 98 | 97 | 100 |',
  '| `src/alpha/**` | 92 | 88 | 96 |',
  '| `src/beta/**` — advisory | 85 | 70 | 90 |',
  '| **global** | 90 | 80 | 95 |',
].join('\n');

const PROLOGUE = '## Coverage floors and ratchet\n\nThe gate applies this table:\n\n';
const EPILOGUE = '\n\n**Ratchet policy:** floors are never lowered.\n';

function doc(table: string): string {
  return `${PROLOGUE}${table}${EPILOGUE}`;
}

interface AfterHook {
  after: (fn: () => Promise<void>) => void;
}

async function fixture(
  t: AfterHook,
  markdown: string = doc(TABLE),
  floors: string = FLOORS_JSON,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'floors-doc-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'docs/TESTING.md'), markdown, 'utf8');
  await writeFile(join(root, 'scripts/coverage-floors.json'), floors, 'utf8');
  return root;
}

const read = async (root: string): Promise<string> =>
  readFile(join(root, 'docs/TESTING.md'), 'utf8');

// ---------------------------------------------------------------------------
// parseFloors
// ---------------------------------------------------------------------------

test('a well-formed floors file parses, with advisory defaulting to false', () => {
  const floors = parseFloors(FLOORS_JSON);
  assert.equal(floors?.rules.length, 3);
  assert.equal(floors?.rules[0]?.advisory, false);
  assert.equal(floors?.rules[2]?.advisory, true);
  assert.deepEqual(floors?.global, { lines: 90, branches: 80, functions: 95 });
});

test('advisory is true only when it is the boolean true', () => {
  // A truthy string would make a blocking rule render as advisory — the row
  // would tell a reader their floor is not enforced when it is.
  const floors = parseFloors(
    JSON.stringify({
      global: { lines: 1, branches: 1, functions: 1 },
      rules: [{ path: 'src/a/**', lines: 1, branches: 1, functions: 1, advisory: 'yes' }],
    }),
  );
  assert.equal(floors?.rules[0]?.advisory, false);
});

test('a floor that is not an integer percentage is rejected, not rendered', () => {
  // The failure this rules out is a cell reading `undefined` in a document that
  // is otherwise valid markdown, committed by a gate that reported success.
  for (const bad of ['"97"', '97.5', '101', '-1', 'null']) {
    const text = `{"global":{"lines":1,"branches":1,"functions":1},"rules":[{"path":"src/a/**","lines":${bad},"branches":1,"functions":1}]}`;
    assert.equal(parseFloors(text), undefined, bad);
  }
});

test('malformed JSON, a missing global and an empty rule list are all rejected', () => {
  assert.equal(parseFloors('{ not json'), undefined);
  assert.equal(parseFloors('{"rules":[]}'), undefined);
  assert.equal(
    parseFloors('{"global":{"lines":1,"branches":1,"functions":1},"rules":[]}'),
    undefined,
  );
  assert.equal(
    parseFloors('{"global":{"lines":1,"branches":1},"rules":[{"path":"a"}]}'),
    undefined,
  );
});

test('a rule without a path is rejected', () => {
  assert.equal(
    parseFloors(
      '{"global":{"lines":1,"branches":1,"functions":1},"rules":[{"lines":1,"branches":1,"functions":1}]}',
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// renderFloorsTable
// ---------------------------------------------------------------------------

test('the table renders every rule, in the order the JSON lists them', () => {
  const floors = parseFloors(FLOORS_JSON);
  assert.ok(floors !== undefined);
  assert.equal(renderFloorsTable(floors), TABLE);
});

test('row order follows the JSON even when it looks wrong', () => {
  // Order is load-bearing: a file is charged to the first matching rule, so a
  // table sorted for looks would document a partition the gate does not use.
  const floors: Floors = {
    global: { lines: 1, branches: 2, functions: 3 },
    rules: [
      { path: 'src/z/**', lines: 10, branches: 11, functions: 12, advisory: false },
      { path: 'src/a/one.ts', lines: 20, branches: 21, functions: 22, advisory: false },
    ],
  };
  const rows = renderFloorsTable(floors).split('\n');
  assert.equal(rows[2], '| `src/z/**` | 10 | 11 | 12 |');
  assert.equal(rows[3], '| `src/a/one.ts` | 20 | 21 | 22 |');
  assert.equal(rows[4], '| **global** | 1 | 2 | 3 |');
});

// ---------------------------------------------------------------------------
// replaceTable
// ---------------------------------------------------------------------------

test('the replacement stops at the blank line and leaves the prose alone', () => {
  const stale = TABLE.replace('| 98 | 97 | 100 |', '| 1 | 2 | 3 |');
  const result = replaceTable(doc(stale), TABLE);
  assert.ok('text' in result);
  assert.equal(result.text, doc(TABLE));
  assert.ok(result.text.startsWith(PROLOGUE), 'the paragraph above survives');
  assert.ok(result.text.endsWith(EPILOGUE), 'the ratchet paragraph survives');
});

test('a document with no floors table is an error, never an append', () => {
  const result = replaceTable('# Testing\n\nNo table here.\n', TABLE);
  assert.deepEqual(result, { error: 'missing' });
});

test('two tables with the floors header are ambiguous rather than a guess', () => {
  const result = replaceTable(`${doc(TABLE)}\n${doc(TABLE)}`, TABLE);
  assert.deepEqual(result, { error: 'ambiguous' });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a document that matches the JSON passes in check mode', async (t) => {
  assert.equal(await syncFloorsDoc(true, await fixture(t)), true);
});

test('a stale table fails the check and is repaired by the write mode', async (t) => {
  // The exact drift the gate was written for: a ratchet raised the JSON and the
  // hand-maintained table kept the old numbers.
  const stale = TABLE.replace(
    '| `src/alpha/one.ts` | 98 | 97 | 100 |',
    '| `src/alpha/one.ts` | 90 | 85 | 100 |',
  );
  const root = await fixture(t, doc(stale));
  assert.equal(await syncFloorsDoc(true, root), false);
  assert.equal(await read(root), doc(stale), 'check mode never repairs');
  assert.equal(await syncFloorsDoc(false, root), true);
  assert.equal(await read(root), doc(TABLE));
  assert.equal(await syncFloorsDoc(true, root), true, 'and the repair is stable');
});

test('a rule the table never mentions is drift, not a rule the gate skips', async (t) => {
  // The bug that motivated this gate: `src/core/**` existed in the JSON and had
  // no row at all, so nothing in the document said what the floor was.
  const short = TABLE.split('\n')
    .filter((row) => !row.startsWith('| `src/beta/**`'))
    .join('\n');
  const root = await fixture(t, doc(short));
  assert.equal(await syncFloorsDoc(true, root), false);
  assert.equal(await syncFloorsDoc(false, root), true);
  assert.ok((await read(root)).includes('| `src/beta/**` — advisory | 85 | 70 | 90 |'));
});

test('rows reordered against the JSON are drift', async (t) => {
  const rows = TABLE.split('\n');
  const swapped = [rows[0], rows[1], rows[3], rows[2], rows[4], rows[5]].join('\n');
  assert.equal(await syncFloorsDoc(true, await fixture(t, doc(swapped))), false);
});

test('a CRLF checkout of a synced document is not reported as drift', async (t) => {
  // The Windows CI leg is blocking; a false alarm there trains people to ignore
  // the gate.
  const root = await fixture(t, doc(TABLE).replace(/\n/gu, '\r\n'));
  assert.equal(await syncFloorsDoc(true, root), true);
});

test('a missing document or floors file fails rather than passing vacuously', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'floors-doc-sync-empty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await syncFloorsDoc(true, root), false);
  assert.equal(await syncFloorsDoc(false, root), false);
});

test('a floors file the gate cannot read is a failure in both modes', async (t) => {
  const root = await fixture(t, doc(TABLE), '{ not json');
  assert.equal(await syncFloorsDoc(true, root), false);
  assert.equal(await syncFloorsDoc(false, root), false);
  assert.equal(await read(root), doc(TABLE), 'and the document is left alone');
});

test('a missing anchor fails the write mode too, leaving the document untouched', async (t) => {
  const orphan = '# Testing\n\nThe table was deleted.\n';
  const root = await fixture(t, orphan);
  assert.equal(await syncFloorsDoc(false, root), false);
  assert.equal(await read(root), orphan);
});

test('an ambiguous anchor fails the write mode too, leaving the document untouched', async (t) => {
  const twice = `${doc(TABLE)}\n${doc(TABLE)}`;
  const root = await fixture(t, twice);
  assert.equal(await syncFloorsDoc(false, root), false);
  assert.equal(await read(root), twice);
});

// ---------------------------------------------------------------------------
// The committed tree
// ---------------------------------------------------------------------------

test('the committed TESTING.md table matches the committed floors', async () => {
  assert.equal(await syncFloorsDoc(true, REPO_ROOT), true);
});

test('every committed rule has a row, and no row is invented', async () => {
  const floors = parseFloors(
    await readFile(join(REPO_ROOT, 'scripts/coverage-floors.json'), 'utf8'),
  );
  assert.ok(floors !== undefined);
  const markdown = await readFile(join(REPO_ROOT, 'docs/TESTING.md'), 'utf8');
  const rendered = renderFloorsTable(floors).split('\n').slice(2);
  for (const row of rendered) assert.ok(markdown.includes(row), row);
  assert.equal(
    rendered.length,
    floors.rules.length + 1,
    'every rule plus the global row',
  );
});
