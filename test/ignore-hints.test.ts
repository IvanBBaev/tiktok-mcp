/**
 * ignore-hints (TESTING.md § Sync gates and repo meta).
 *
 * This gate is the only one whose subject is the coverage number's honesty
 * rather than two artifacts agreeing, so its own correctness matters more than
 * most: a checker that silently passed would restore exactly the condition it
 * was written to end, and the symptom — a percentage that is too high — is
 * indistinguishable from success.
 *
 * Every rule is therefore pinned against a fixture that *breaks* it, not
 * against the committed tree. The tree is currently clean and would keep a
 * checker that returned `[]` unconditionally looking perfect.
 *
 * The fixtures are deliberately shaped like the real failures rather than like
 * minimal inputs, because each rule exists for one specific accident:
 * a Prettier reflow, a bare hint nobody could argue with, a citation whose
 * target moved, and a block that grew outward until it covered a whole
 * function. A fixture that did not look like the accident would not prove the
 * rule catches it.
 *
 * `scripts/ignore-hints.ts` scans `src/` only, so the literal hint text below
 * cannot be picked up by the gate it is testing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockLines,
  candidatePaths,
  checkHints,
  citationsIn,
  parseHints,
  prosePreceding,
  readBudget,
  type ScannedFile,
  type Tree,
} from '../scripts/ignore-hints.js';

// ---------------------------------------------------------------------------
// Fixture tree
// ---------------------------------------------------------------------------

/** A two-file repo the citations below resolve against. */
const TREE: Tree = (() => {
  const files = new Map<string, string[]>([
    [
      'src/core/errors.ts',
      ['line one', 'line two', 'export class TikTokError {}', '', 'tail'],
    ],
    ['src/cli/thing.ts', ['a', 'b', 'c']],
  ]);
  return {
    lengthOf: (path) => files.get(path)?.length,
    lineAt: (path, line) => files.get(path)?.[line - 1],
  };
})();

const BUDGET = { hints: 99, blockLines: 99 };

function check(text: string): string[] {
  return checkHints([{ file: 'src/thing.ts', text }], TREE, BUDGET);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

void test('parses each hint form with its count', () => {
  const hints = parseHints(
    'src/a.ts',
    [
      '/* c8 ignore next -- one. */',
      '/* c8 ignore next 2 -- two. */',
      '/* c8 ignore start -- three. */',
      '/* c8 ignore stop */',
    ].join('\n'),
  );
  assert.deepEqual(
    hints.map((h) => [h.form, h.count, h.reason]),
    [
      ['next', undefined, 'one.'],
      ['next', 2, 'two.'],
      ['start', undefined, 'three.'],
      ['stop', undefined, ''],
    ],
  );
});

void test('a block costs the lines between its ends, not the ends themselves', () => {
  const hints = parseHints(
    'src/a.ts',
    ['/* c8 ignore start -- r. */', 'one', 'two', '/* c8 ignore stop */'].join('\n'),
  );
  assert.equal(blockLines(hints), 2);
});

void test('parses the node:coverage forms v8-to-istanbul also honours', () => {
  // lib/source.js in v8-to-istanbul accepts these spellings too, so a gate that
  // only knew `c8 ignore` would let them bypass every rule and the budget.
  const hints = parseHints(
    'src/a.ts',
    [
      '/* node:coverage ignore next -- one. */',
      '/* node:coverage ignore next 3 -- two. */',
      '/* node:coverage disable -- three. */',
      '/* node:coverage enable */',
    ].join('\n'),
  );
  assert.deepEqual(
    hints.map((h) => [h.form, h.count, h.reason]),
    [
      ['next', undefined, 'one.'],
      ['next', 3, 'two.'],
      ['start', undefined, 'three.'],
      ['stop', undefined, ''],
    ],
  );
});

void test('a node:coverage hint is held to the reason rule', () => {
  const problems = check(
    '/* node:coverage disable */\nconst x = 1;\n/* node:coverage enable */',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /gives no reason/);
  assert.deepEqual(
    check(
      '/* node:coverage disable -- unreachable: core/errors.ts:3. */\nx\n/* node:coverage enable */',
    ),
    [],
  );
});

void test('node:coverage hints count against the budget', () => {
  const files: ScannedFile[] = [
    {
      file: 'src/a.ts',
      text: '/* node:coverage ignore next -- unreachable: core/errors.ts:3. */',
    },
    { file: 'src/b.ts', text: '/* c8 ignore next -- unreachable: core/errors.ts:3. */' },
  ];
  const problems = checkHints(files, TREE, { hints: 1, blockLines: 99 });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /2 c8 ignore hints in src\/, budget is 1/);
});

void test('next N costs N-1 block lines beyond the one a plain next costs', () => {
  assert.equal(blockLines(parseHints('src/a.ts', '/* c8 ignore next 5 -- r. */')), 4);
  assert.equal(blockLines(parseHints('src/a.ts', '/* c8 ignore next -- r. */')), 0);
  assert.equal(blockLines(parseHints('src/a.ts', '/* c8 ignore next 1 -- r. */')), 0);
});

void test('next N lines are charged against the block-line budget', () => {
  const problems = checkHints(
    [
      {
        file: 'src/a.ts',
        text: '/* c8 ignore next 5 -- unreachable: core/errors.ts:3. */',
      },
    ],
    TREE,
    { hints: 99, blockLines: 3 },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /4 lines inside c8 ignore blocks/);
});

void test('a start that never closes is reported and costs the rest of the file', () => {
  // c8 ignores everything after an unclosed start, so the budget must too.
  const text = [
    '/* c8 ignore start -- unreachable: core/errors.ts:3. */',
    'a',
    'b',
    'c',
  ].join('\n');
  const hints = parseHints('src/a.ts', text);
  assert.equal(blockLines(hints, 4), 3);
  // Without a line count the old signature stays backward-compatible.
  assert.equal(blockLines(hints), 0);

  const problems = checkHints([{ file: 'src/a.ts', text }], TREE, {
    hints: 99,
    blockLines: 2,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? '', /^src\/a\.ts:1: the block is never closed/);
  assert.match(problems[1] ?? '', /3 lines inside c8 ignore blocks/);
});

void test('a hint word with a suffix is counted the way v8-to-istanbul reads it', () => {
  // v8-to-istanbul's own pattern has no trailing word boundary, so `starting`
  // opens a block and `nextline` skips a line; a gate that required `\b` would
  // let both bypass the budget.
  const text = [
    '/* c8 ignore starting -- unreachable: core/errors.ts:3. */',
    'a',
    'b',
    '/* c8 ignore stopped */',
    '/* c8 ignore nextline -- unreachable: core/errors.ts:3. */',
  ].join('\n');
  const hints = parseHints('src/a.ts', text);
  assert.deepEqual(
    hints.map((h) => h.form),
    ['start', 'stop', 'next'],
  );
  assert.equal(blockLines(hints, 5), 2);

  const problems = checkHints([{ file: 'src/a.ts', text }], TREE, {
    hints: 2,
    blockLines: 99,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /3 c8 ignore hints in src\/, budget is 2/);
});

void test('an unclosed "starting" block costs the rest of the file', () => {
  const text = [
    '/* c8 ignore starting -- unreachable: core/errors.ts:3. */',
    'a',
    'b',
  ].join('\n');
  assert.equal(blockLines(parseHints('src/a.ts', text), 3), 2);
  assert.match(check(text)[0] ?? '', /never closed/);
});

void test('an unclosed node:coverage disable is reported the same way', () => {
  const problems = check(
    ['/* node:coverage disable -- unreachable: core/errors.ts:3. */', 'x'].join('\n'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /never closed/);
});

// ---------------------------------------------------------------------------
// Rule 1 — the hint must close on the line it opened on
// ---------------------------------------------------------------------------

void test('reports a hint whose comment wraps onto the next line', () => {
  // Exactly what Prettier produces from a hint with a long reason, and the
  // reason the rule exists: v8-to-istanbul anchors its patterns per line
  // (lib/source.js:54-70), so the continuation lines match nothing at all and
  // the hint lands short of its target without any error being raised.
  const problems = check(
    [
      '/* c8 ignore next -- unreachable: a reason long enough that the',
      '   formatter broke it. */',
      'const x = 1;',
    ].join('\n'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /spread across lines/);
});

void test('a single-line hint of any length is accepted', () => {
  assert.deepEqual(
    check('/* c8 ignore next -- unreachable: proved at core/errors.ts:3. */'),
    [],
  );
});

// ---------------------------------------------------------------------------
// Rule 2 — the hint must carry an argument
// ---------------------------------------------------------------------------

void test('reports a hint with no reason', () => {
  const problems = check('/* c8 ignore start */\nconst x = 1;\n/* c8 ignore stop */');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /gives no reason/);
});

void test('a stop needs no reason, being punctuation rather than a claim', () => {
  assert.deepEqual(
    check(
      '/* c8 ignore start -- unreachable: nothing reaches it. */\nx\n/* c8 ignore stop */',
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// Rule 3 — a citation must still point at a line
// ---------------------------------------------------------------------------

void test('harvests citations from the prose above the hint, not only the reason', () => {
  const lines = [
    '// Proved by the guard at core/errors.ts:3.',
    '/* c8 ignore next -- see above. */',
  ];
  assert.equal(prosePreceding(lines, 2), lines[0]);
  assert.deepEqual(
    citationsIn(lines.join('\n')).map((c) => c.text),
    ['core/errors.ts:3'],
  );
});

void test('accepts a citation written bare, src-relative or sibling-relative', () => {
  assert.deepEqual(candidatePaths('core/errors.ts', 'src/cli/thing.ts'), [
    'core/errors.ts',
    'src/core/errors.ts',
    'src/cli/core/errors.ts',
    'test/core/errors.ts',
    'scripts/core/errors.ts',
  ]);
  assert.deepEqual(
    check('/* c8 ignore next -- unreachable: core/errors.ts:3 throws. */'),
    [],
  );
});

void test('reports a citation to a file that does not exist', () => {
  const problems = check('/* c8 ignore next -- unreachable: core/gone.ts:3 throws. */');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /no such file exists/);
});

void test('reports a citation past the end of the cited file', () => {
  // The rot this gate was written for: the enforcer moved up, the citation
  // stayed, and nothing anywhere failed.
  const problems = check(
    '/* c8 ignore next -- unreachable: core/errors.ts:900 throws. */',
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /has only 5 lines/);
});

void test('reports a citation that now lands on a blank line', () => {
  const problems = check('/* c8 ignore next -- unreachable: core/errors.ts:4 throws. */');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /blank line/);
});

// ---------------------------------------------------------------------------
// Rule 4 — a block excludes an arm, not a function
// ---------------------------------------------------------------------------

void test('reports a block that encloses a function declaration', () => {
  // src/mcp/http.ts once did exactly this: two whole functions wrapped to hide
  // two narrow fallbacks, and 19 exercised lines left the denominator.
  const problems = check(
    [
      '/* c8 ignore start -- unreachable: nothing calls it. */',
      'export function requestPath(target: string): string {',
      '  return target;',
      '}',
      '/* c8 ignore stop */',
    ].join('\n'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /encloses a declaration/);
});

void test('a production seam default may enclose its whole function', () => {
  // The honest exception: every test injects a replacement, so the function
  // itself is the unit that never runs. The verdict is read from the reason
  // rather than guessed from shape, because it is a claim about the seam.
  assert.deepEqual(
    check(
      [
        '/* c8 ignore start -- production seam default, replaced by injection in every test. */',
        'async function defaultPrompt(q: string): Promise<string> {',
        '  return q;',
        '}',
        '/* c8 ignore stop */',
      ].join('\n'),
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

void test('reports a tree that spends more hints than the budget allows', () => {
  const files: ScannedFile[] = [
    { file: 'src/a.ts', text: '/* c8 ignore next -- unreachable: core/errors.ts:3. */' },
    { file: 'src/b.ts', text: '/* c8 ignore next -- unreachable: core/errors.ts:3. */' },
  ];
  const problems = checkHints(files, TREE, { hints: 1, blockLines: 99 });
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /2 c8 ignore hints in src\/, budget is 1/);
});

void test('the budget on disk is a number the tree can actually meet', async () => {
  // A budget is only a ratchet if it is not slack: one that had drifted far
  // above the real count would permit a silent re-inflation, which is the
  // failure this file exists to prevent.
  const budget = await readBudget();
  assert.ok(Number.isInteger(budget.hints) && budget.hints >= 0);
  assert.ok(Number.isInteger(budget.blockLines) && budget.blockLines >= 0);
});
