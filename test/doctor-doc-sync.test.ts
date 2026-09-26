/**
 * doctor-doc-sync (TESTING.md § Sync gates and repo meta).
 *
 * The gate compares one hand-written table against one exported array, so the
 * failure that matters is the gate that stops comparing: a header line that no
 * longer matches, a row parser that swallows the whole document, a set
 * difference reported as an order problem. All three pass against a tree that
 * is already in sync, which is why the fixtures below are not the committed
 * tree. Two tests do read it, and they check what a fixture cannot — that the
 * document a reader opens agrees with the check-list the CLI actually runs.
 *
 * The fixture checks are `alpha`, `beta gate`, `gamma` rather than the real
 * titles, so nothing asserted here can be mistaken for a claim about what
 * `doctor` checks. What each check *means* is not tested here at all; the
 * second column is prose, and this gate deliberately says nothing about it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DOCTOR_CHECKS } from '../src/cli/doctor.js';
import {
  checkDoctorDoc,
  parseCheckTable,
  syncDoctorDoc,
} from '../scripts/doctor-doc-sync.js';
import { REPO_ROOT } from '../scripts/lib/repo.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHECKS = [{ title: 'alpha' }, { title: 'beta gate' }, { title: 'gamma' }];

const TABLE = [
  '| Check | What it is telling you |',
  '| ----- | ---------------------- |',
  '| `alpha` | the first one |',
  '| `beta gate` | the second one |',
  '| `gamma` | the third one |',
].join('\n');

const PROLOGUE = '## What each check means\n\nThe checks run in this order.\n\n';
const EPILOGUE = '\n\n## Setup and startup\n\n| Symptom | Fix |\n| --- | --- |\n';

function doc(table: string): string {
  return `${PROLOGUE}${table}${EPILOGUE}`;
}

async function fixture(markdown: string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'doctor-doc-sync-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  const file = join(root, 'docs/TROUBLESHOOTING.md');
  await writeFile(file, markdown, 'utf8');
  return { root, file };
}

// ---------------------------------------------------------------------------
// parseCheckTable
// ---------------------------------------------------------------------------

test('the table is read in document order, backticks stripped', () => {
  const parsed = parseCheckTable(doc(TABLE));
  assert.deepEqual(parsed, { titles: ['alpha', 'beta gate', 'gamma'] });
});

test('the table ends at the first line that is not a row', () => {
  const parsed = parseCheckTable(doc(TABLE));
  assert.ok('titles' in parsed);
  // EPILOGUE opens another table; reaching it would make every later section a
  // phantom check and the gate would fail for a reason nobody could act on.
  assert.equal(parsed.titles.includes('Symptom'), false);
});

test('a title without backticks is taken as written', () => {
  const parsed = parseCheckTable(doc(TABLE.replace('`alpha`', 'alpha')));
  assert.deepEqual(parsed, { titles: ['alpha', 'beta gate', 'gamma'] });
});

test('no header line is reported as missing, not as an empty check-list', () => {
  assert.deepEqual(parseCheckTable('# Troubleshooting\n\nnothing here.\n'), {
    error: 'missing',
  });
});

test('two header lines are ambiguous — the gate does not pick one', () => {
  assert.deepEqual(parseCheckTable(`${doc(TABLE)}\n${TABLE}\n`), {
    error: 'ambiguous',
  });
});

test('a header with no rows under it is empty, not vacuously in sync', () => {
  const header = TABLE.split('\n').slice(0, 2).join('\n');
  assert.deepEqual(parseCheckTable(doc(header)), { error: 'empty' });
});

test('a row whose first cell is blank ends the table', () => {
  const table = `${TABLE}\n|  | a continuation line |`;
  const parsed = parseCheckTable(doc(table));
  assert.deepEqual(parsed, { titles: ['alpha', 'beta gate', 'gamma'] });
});

// ---------------------------------------------------------------------------
// checkDoctorDoc
// ---------------------------------------------------------------------------

test('the same titles in the same order are no problem at all', () => {
  assert.deepEqual(checkDoctorDoc(['a', 'b'], ['a', 'b']), []);
});

test('a check with no row names the check', () => {
  const problems = checkDoctorDoc(['a', 'b'], ['a']);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /runs a check titled `b`/u);
});

test('a row with no check says the check is gone, not that the row is missing', () => {
  const problems = checkDoctorDoc(['a'], ['a', 'b']);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /row for `b`, which is not a check any more/u);
});

test('two rows for one check are reported once, as a duplicate', () => {
  const problems = checkDoctorDoc(['a', 'b'], ['a', 'b', 'b']);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /two rows for `b`/u);
});

test('the right set in the wrong order is its own problem, and prints the order', () => {
  const problems = checkDoctorDoc(['a', 'b'], ['b', 'a']);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /wrong order/u);
  assert.match(problems[0] ?? '', /a, b/u);
});

test('an order complaint is withheld while the sets still differ', () => {
  // Otherwise a single missing row reports twice and sends somebody reordering
  // rows that were never in the wrong place.
  const problems = checkDoctorDoc(['a', 'b', 'c'], ['c', 'a']);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /runs a check titled `b`/u);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a document that matches the check-list passes', async () => {
  const f = await fixture(doc(TABLE));
  try {
    assert.equal(await syncDoctorDoc(f.root, CHECKS), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a check added without a row fails the gate', async () => {
  const f = await fixture(doc(TABLE));
  try {
    const checks = [...CHECKS, { title: 'delta' }];
    assert.equal(await syncDoctorDoc(f.root, checks), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a failing gate leaves the document byte-identical', async () => {
  const before = doc(TABLE);
  const f = await fixture(before);
  try {
    await syncDoctorDoc(f.root, [...CHECKS, { title: 'delta' }]);
    assert.equal(await readFile(f.file, 'utf8'), before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('CRLF line endings are not drift', async () => {
  const f = await fixture(doc(TABLE).replace(/\n/gu, '\r\n'));
  try {
    assert.equal(await syncDoctorDoc(f.root, CHECKS), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a missing document fails rather than passing with nothing to compare', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-doc-sync-'));
  try {
    assert.equal(await syncDoctorDoc(root, CHECKS), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a table that cannot be found fails instead of comparing nothing', async () => {
  const f = await fixture('# Troubleshooting\n\nthe table moved.\n');
  try {
    assert.equal(await syncDoctorDoc(f.root, CHECKS), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an empty check-list fails instead of passing vacuously', async () => {
  const f = await fixture(doc(TABLE));
  try {
    assert.equal(await syncDoctorDoc(f.root, []), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The committed tree
// ---------------------------------------------------------------------------

test('the committed TROUBLESHOOTING.md agrees with DOCTOR_CHECKS', async () => {
  assert.equal(await syncDoctorDoc(REPO_ROOT), true);
});

test('the committed table has one row per check and no spares', async () => {
  const markdown = await readFile(join(REPO_ROOT, 'docs/TROUBLESHOOTING.md'), 'utf8');
  const parsed = parseCheckTable(markdown.replace(/\r\n/gu, '\n'));
  assert.ok('titles' in parsed);
  assert.deepEqual(
    parsed.titles,
    DOCTOR_CHECKS.map((check) => check.title),
  );
});
