/**
 * tools-doc-sync (TESTING.md § Sync gates and repo meta).
 *
 * The gate's whole value is that it fails, so its correctness is entirely a
 * question of what it is willing to call agreement. That cannot be pinned
 * against the committed tree: TOOLS.md and the manifest are in sync today, and
 * a comparison that had quietly stopped comparing — a heading regex that
 * matches nothing, a table parser that finds no rows — would stay green
 * forever. So every rule is exercised against a small fixture pair shaped like
 * the real documents, and the committed tree gets two tests of its own: that it
 * passes, and that the parse behind that pass is not empty.
 *
 * The fixture tools are invented (`tiktok_get_thing`, `probe`), so nothing here
 * can be mistaken for a claim about the real surface, but the *shapes* are the
 * repo's own and each is there for a reason the gate would otherwise get wrong:
 * a `Scopes` line whose leading claim is followed by prose about a scope that
 * is not required, a `Req` column carrying a handler-level condition, all three
 * `.describe()` cell forms including the two cross-references, an `enum` type
 * spelling the gate must decline to read, and one section that states its
 * schema as a sentence instead of a table.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from '../scripts/lib/repo.js';
import {
  checkToolsDoc,
  collapse,
  parseDoc,
  parseManifest,
  parseScopeClaim,
  readToolsDocInputs,
  rowCells,
  syncToolsDoc,
} from '../scripts/tools-doc-sync.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureProperty {
  type?: string;
  items?: { type: string };
  description?: string;
}

interface FixtureTool {
  name: string;
  package: string;
  scopes: string[];
  scopesAnyOf?: string[];
  description: string;
  annotations: Record<string, string | boolean>;
  inputSchema: {
    type: string;
    properties: Record<string, FixtureProperty>;
    required?: string[];
    additionalProperties: boolean;
  };
}

const ACCOUNT =
  'Profile name from the server configuration. Omit to use the default profile.';
const THING_ID = 'The id of the thing to read.';

const TOOLS: readonly FixtureTool[] = [
  {
    name: 'tiktok_get_thing',
    package: 'probe',
    scopes: [],
    description: 'Read one thing by id.\n\nReturns the stored record and nothing else.',
    annotations: {
      title: 'Get thing',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: ACCOUNT },
        thing_id: { type: 'string', description: THING_ID },
      },
      required: ['thing_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tiktok_do_thing',
    package: 'probe-write',
    scopes: ['thing.write'],
    description: 'Create a thing and return its id.',
    annotations: {
      title: 'Do thing',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: ACCOUNT },
        thing_id: { type: 'string', description: THING_ID },
        count: { type: 'integer', description: 'How many to make.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to attach.',
        },
        mode: { type: 'string', description: 'Fast or careful.' },
      },
      required: ['thing_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tiktok_sketch_thing',
    package: 'probe-write',
    scopes: [],
    scopesAnyOf: ['thing.write', 'thing.draft'],
    description: 'Sketch a thing without publishing it.',
    annotations: {
      title: 'Sketch thing',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: ACCOUNT },
        thing_id: { type: 'string', description: THING_ID },
        wait: { type: 'boolean', description: 'Block until the sketch settles.' },
      },
      additionalProperties: false,
    },
  },
];

const DOC = `# Tool reference

## 1. Surface at a glance

**3 tools, 2 packages.**

| # | Tool | Package | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Required scope |
|---|---|---|---|---|---|---|---|
| 1 | \`tiktok_get_thing\` | probe | true | false | true | true | — |
| 2 | \`tiktok_do_thing\` | probe-write | **false** | **true** | **false** | true | \`thing.write\` |
| 3 | \`tiktok_sketch_thing\` | probe-write | **false** | **true** | **false** | true | \`thing.write\` or \`thing.draft\` |

## 2. Conventions

### 2.2 The common \`account\` field

- \`.describe()\` (normative): *"Profile name from the server configuration. Omit
  to use the default profile."*

## 3. Per-tool reference

### 3.1 \`tiktok_get_thing\`

- **Package:** \`probe\`. **Annotations:** \`readOnlyHint: true\`,
  \`destructiveHint: false\`, \`idempotentHint: true\`, \`openWorldHint: true\`
  (network only when the record is cold; the tuple describes capability).
- **Scopes:** none.
- **Description** (normative):

  > Read one thing by
  > id.
  >
  > Returns the stored record and nothing else.

- **Input schema:**

  | Field | Type | Req | Constraints | \`.describe()\` |
  |---|---|---|---|---|
  | \`account\` | string | no | | (common, § 2.2) |
  | \`thing_id\` | string | yes | non-empty | "The id of the thing to read." |

- **Output:** \`{ thing: { id, body } }\`.
- **Errors:** shared catalog only.

### 3.2 \`tiktok_do_thing\`

- **Package:** \`probe-write\`. **Annotations:** \`readOnlyHint: false\`,
  \`destructiveHint: true\`, \`idempotentHint: false\`, \`openWorldHint: true\`.
- **Scopes:** \`thing.write\`; a sketch is reachable with \`thing.draft\` instead,
  which this tool never accepts.
- **Description** (normative):

  > Create a thing and return its id.

- **Input schema:**

  | Field | Type | Req | Constraints | \`.describe()\` |
  |---|---|---|---|---|
  | \`account\` | string | no | | (common) |
  | \`thing_id\` | string | yes | non-empty | (as § 3.1) |
  | \`count\` | integer | no | 1..10, clamped locally | "How many to make." |
  | \`tags\` | string[] | no | | "Labels to attach." |
  | \`mode\` | enum \`fast \\| careful\` | no | default \`fast\` | "Fast or careful." |

### 3.3 \`tiktok_sketch_thing\`

- **Package:** \`probe-write\`. **Annotations:** \`readOnlyHint: false\`,
  \`destructiveHint: true\`, \`idempotentHint: false\`, \`openWorldHint: true\`.
- **Scopes:** \`thing.write\` or \`thing.draft\`.
- **Description** (normative):

  > Sketch a thing without publishing it.

- **Input schema:** \`account\` as § 2.2, \`thing_id\` as § 3.1, and \`wait\` —
  \`false\` by default — deciding whether the call blocks until the sketch
  settles.
`;

/** The fixture manifest, optionally mutated for the drift under test. */
function tools(mutate?: (all: FixtureTool[]) => void): FixtureTool[] {
  const all = structuredClone(TOOLS) as FixtureTool[];
  mutate?.(all);
  return all;
}

/**
 * The fixture document with exact substitutions applied.
 *
 * Each edit asserts it matched: a drift test that silently edited nothing would
 * assert on the *unmodified* fixture and pass for the wrong reason.
 */
function docWith(edits: readonly (readonly [string, string])[]): string {
  let markdown = DOC;
  for (const [from, to] of edits) {
    assert.ok(markdown.includes(from), `the fixture no longer contains: ${from}`);
    markdown = markdown.replace(from, to);
  }
  return markdown;
}

function problems(
  markdown: string = DOC,
  manifest: readonly FixtureTool[] = TOOLS,
): string[] {
  const parsed = parseManifest(JSON.stringify({ tools: manifest }));
  assert.ok(parsed !== undefined, 'the fixture manifest is readable');
  return checkToolsDoc({ tools: parsed, doc: parseDoc(markdown) });
}

/** The single problem this drift is supposed to produce. */
function onlyProblem(markdown: string, manifest: readonly FixtureTool[] = TOOLS): string {
  const found = problems(markdown, manifest);
  assert.equal(
    found.length,
    1,
    `expected exactly one problem, got:\n${found.join('\n')}`,
  );
  return found[0] ?? '';
}

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

test('a scope line is read as its leading claim, not as every scope it mentions', () => {
  // The § 3.2 shape: a required scope, then prose naming one that is not.
  // Swallowing the tail would report a correct section as drifted, which is how
  // a gate stops being run.
  const claim = parseScopeClaim(
    '- **Scopes:** `thing.write`; a sketch is reachable with `thing.draft` instead.',
  );
  assert.deepEqual(claim.scopes, ['thing.write']);
  assert.equal(claim.anyOf, false);
});

test('alternatives in a scope line are read as alternatives', () => {
  const claim = parseScopeClaim('- **Scopes:** `thing.write` or `thing.draft`.');
  assert.deepEqual(claim.scopes, ['thing.write', 'thing.draft']);
  assert.equal(claim.anyOf, true);
});

test('a parenthesised scope upgrade is prose, not a requirement', () => {
  // The § 1 shape: `user.info.basic` (+ optional `user.info.profile`, …).
  const claim = parseScopeClaim('`thing.write` (+ optional `thing.extra`)');
  assert.deepEqual(claim.scopes, ['thing.write']);
});

test('a table row keeps its empty cells and its escaped pipes', () => {
  // Dropping empty cells shifts every later column left, so a row with no
  // Constraints would compare its `.describe()` against the Req column.
  assert.deepEqual(rowCells('| `a` | string | no | | (common) |'), [
    '`a`',
    'string',
    'no',
    '',
    '(common)',
  ]);
  assert.deepEqual(rowCells('| `a` | enum \\| pair | no |'), [
    '`a`',
    'enum \\| pair',
    'no',
  ]);
});

test('collapsing folds wrapping without touching the words', () => {
  assert.equal(collapse('  Read one\n  thing  by id. '), 'Read one thing by id.');
});

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

test('a document that restates the manifest exactly reports nothing', () => {
  assert.deepEqual(problems(), []);
});

test('a description wrapped differently from the manifest still agrees', () => {
  // § 3.1's blockquote breaks "Read one thing by id." across two lines; the
  // manifest string does not. Comparing raw bytes would fail every section.
  assert.ok(DOC.includes('> Read one thing by\n  > id.'));
  assert.deepEqual(problems(), []);
});

test('a Req cell stating a handler-level condition reads as not required', () => {
  // `iff …` and `for execution` describe conditions the wire schema cannot
  // express. Only `yes` claims membership in `required`.
  assert.deepEqual(
    problems(
      docWith([['| `count` | integer | no |', '| `count` | integer | for execution |']]),
    ),
    [],
  );
});

test('an enum type spelling is declined rather than guessed at', () => {
  // `mode` is spelled as an inline union in the table and `string` in the
  // schema, and the repo spells such cells three different ways. The cell is
  // therefore not read at all — asserted here against a manifest that changed
  // the type outright, so the omission is on the record rather than a surprise.
  const retyped = tools((all) => {
    const field = all[1]?.inputSchema.properties['mode'];
    assert.ok(field !== undefined);
    field.type = 'integer';
  });
  assert.deepEqual(problems(DOC, retyped), []);
});

// ---------------------------------------------------------------------------
// Bijection, order, numbering
// ---------------------------------------------------------------------------

test('a section documenting a tool the manifest does not have fails', () => {
  const dropped = tools((all) => all.splice(2, 1));
  const problem = onlyProblem(DOC, dropped);
  assert.match(problem, /§ 3\.3 documents `tiktok_sketch_thing`/u);
  assert.match(problem, /a section describing a tool that no longer exists/u);
});

test('a tool with no section fails, and is named', () => {
  const problem = onlyProblem(docWith([[DOC.slice(DOC.indexOf('### 3.3')), '']]));
  assert.match(problem, /^tiktok_sketch_thing is in docs\/tool-manifest\.json/u);
  assert.match(problem, /documents no such tool/u);
});

test('two sections for one tool fail even though both directions are covered', () => {
  const twice = docWith([
    [
      '### 3.3 `tiktok_sketch_thing`',
      '### 3.3 `tiktok_do_thing`\n\n- **Package:** `probe-write`.\n\n### 3.4 `tiktok_sketch_thing`',
    ],
  ]);
  const found = problems(twice);
  assert.ok(
    found.some((problem) => /tiktok_do_thing has 2 sections/u.test(problem)),
    found.join('\n'),
  );
});

test('a section out of manifest order fails, because the doc cites itself by number', () => {
  const swapped = tools((all) => {
    const [first, second] = [all[0], all[1]];
    assert.ok(first !== undefined && second !== undefined);
    all[0] = second;
    all[1] = first;
  });
  const found = problems(DOC, swapped);
  assert.equal(found.length, 2);
  assert.match(found[0] ?? '', /is section 1 of docs\/TOOLS\.md/u);
  assert.match(found[0] ?? '', /must be `3\.1`/u);
});

test('a renumbered section fails even when it is in the right place', () => {
  const problem = onlyProblem(docWith([['### 3.2 `', '### 3.9 `']]));
  assert.match(problem, /§ 3\.9 `tiktok_do_thing` is section 2/u);
});

// ---------------------------------------------------------------------------
// Package, scopes, annotations
// ---------------------------------------------------------------------------

test('a package the doc renamed fails', () => {
  const problem = onlyProblem(
    docWith([
      [
        '- **Package:** `probe`. **Annotations:**',
        '- **Package:** `auth`. **Annotations:**',
      ],
    ]),
  );
  assert.match(problem, /package is `auth` in the doc, `probe` in the manifest/u);
});

test('a scope the doc dropped fails, with both lists quoted', () => {
  const problem = onlyProblem(
    docWith([['- **Scopes:** `thing.write`;', '- **Scopes:** `thing.read`;']]),
  );
  assert.match(
    problem,
    /scopes are `thing\.read` in the doc, `thing\.write` in the manifest/u,
  );
});

test('a doc that requires both scopes where the manifest accepts either fails', () => {
  const problem = onlyProblem(
    docWith([
      [
        '- **Scopes:** `thing.write` or `thing.draft`.',
        '- **Scopes:** `thing.write` and `thing.draft`.',
      ],
    ]),
  );
  assert.match(problem, /the manifest declares scopesAnyOf/u);
});

test('a scope line that names nothing and does not say "none" fails', () => {
  // Silence is not the same claim as "no scope required", and a section whose
  // scope line turned into prose has stopped stating a requirement at all.
  const problem = onlyProblem(
    docWith([['- **Scopes:** none.', '- **Scopes:** see the package table.']]),
  );
  assert.match(problem, /names no scope and does not say "none"/u);
});

test('an annotation hint the doc contradicts fails in both the section and § 1', () => {
  const found = problems(
    docWith([
      [
        '`idempotentHint: true`, `openWorldHint: true`\n  (network',
        '`idempotentHint: false`, `openWorldHint: true`\n  (network',
      ],
      [
        '| probe | true | false | true | true | — |',
        '| probe | true | false | false | true | — |',
      ],
    ]),
  );
  assert.equal(found.length, 2);
  assert.match(
    found[0] ?? '',
    /§ 3\.1 tiktok_get_thing: `idempotentHint` is false in the doc, true in the manifest/u,
  );
  assert.match(found[1] ?? '', /§ 1 tiktok_get_thing: `idempotentHint` is false/u);
});

test('a hint the doc stopped stating is missing, not merely unchecked', () => {
  const problem = onlyProblem(
    docWith([[', `openWorldHint: true`\n  (network', '\n  (network']]),
  );
  assert.match(problem, /`openWorldHint` is missing in the doc, true in the manifest/u);
});

// ---------------------------------------------------------------------------
// The normative description
// ---------------------------------------------------------------------------

test('a description that drifted by one word fails, quoting both texts', () => {
  const problem = onlyProblem(
    docWith([
      [
        '> Returns the stored record and nothing else.',
        '> Returns the cached record and nothing else.',
      ],
    ]),
  );
  assert.match(problem, /the normative description disagrees with the manifest/u);
  assert.match(problem, /doc: {6}Read one thing by id\. ⏎⏎ Returns the cached record/u);
  assert.match(problem, /manifest: Read one thing by id\. ⏎⏎ Returns the stored record/u);
});

test('a lost paragraph break fails, because the wire text has one', () => {
  // Whitespace is collapsed inside a paragraph and compared between them; a
  // check that collapsed everything would call these two texts equal.
  const problem = onlyProblem(
    docWith([['> id.\n  >\n  > Returns', '> id.\n  > Returns']]),
  );
  assert.match(problem, /the normative description disagrees/u);
});

test('a section with no normative blockquote fails rather than skipping the tool', () => {
  const problem = onlyProblem(
    docWith([
      [
        '- **Description** (normative):\n\n  > Sketch a thing without publishing it.\n',
        '',
      ],
    ]),
  );
  assert.match(problem, /no "\*\*Description\*\* \(normative\)" blockquote/u);
});

// ---------------------------------------------------------------------------
// The input schema
// ---------------------------------------------------------------------------

test('a field added to the schema but not to the table fails', () => {
  const grown = tools((all) => {
    const tool = all[0];
    assert.ok(tool !== undefined);
    tool.inputSchema.properties['probe'] = {
      type: 'boolean',
      description: 'Verify against the server.',
    };
  });
  const problem = onlyProblem(DOC, grown);
  assert.match(problem, /the input-schema table lists `account`, `thing_id`,/u);
  assert.match(problem, /the schema has `account`, `thing_id`, `probe`/u);
});

test('a row for a field the schema does not have fails', () => {
  const problem = onlyProblem(
    docWith([['  | `tags` | string[] | no | | "Labels to attach." |\n', '']]),
  );
  assert.match(problem, /the input-schema table lists .*the schema has/su);
});

test('a table that reordered its rows fails', () => {
  // The order is the wire order and the reading order at once; a table that
  // drifts out of it stops being a transcription and becomes a paraphrase.
  const problem = onlyProblem(
    docWith([
      [
        '| `account` | string | no | | (common) |\n  | `thing_id` | string | yes | non-empty | (as § 3.1) |',
        '| `thing_id` | string | yes | non-empty | (as § 3.1) |\n  | `account` | string | no | | (common) |',
      ],
    ]),
  );
  assert.match(problem, /\(order included\)/u);
});

test('a required field the table marks optional fails', () => {
  const problem = onlyProblem(
    docWith([
      [
        '| `thing_id` | string | yes | non-empty | "The id of the thing to read." |',
        '| `thing_id` | string | no | non-empty | "The id of the thing to read." |',
      ],
    ]),
  );
  assert.match(problem, /the table marks none required, the schema requires `thing_id`/u);
  assert.match(problem, /a `Req` cell other than `yes` reads as not-required/u);
});

test('a type the table contradicts fails for the spellings the gate reads', () => {
  const problem = onlyProblem(
    docWith([['| `count` | integer |', '| `count` | string |']]),
  );
  assert.match(problem, /`count` is `string` in the table, `integer` in the schema/u);
});

test('a string[] cell is checked against the array shape, not against "array"', () => {
  const problem = onlyProblem(
    docWith([['| `tags` | string[] |', '| `tags` | boolean |']]),
  );
  assert.match(problem, /`tags` is `boolean` in the table, `array` in the schema/u);
});

// ---------------------------------------------------------------------------
// `.describe()` cells, in all three forms
// ---------------------------------------------------------------------------

test('a quoted describe cell that drifted fails, quoting both texts', () => {
  const problem = onlyProblem(
    docWith([['"How many to make."', '"How many things to make."']]),
  );
  assert.match(problem, /the `\.describe\(\)` of `count` disagrees/u);
  assert.match(problem, /doc: {6}How many things to make\./u);
  assert.match(problem, /manifest: How many to make\./u);
});

test('a "(common)" cell is compared against § 2.2, not waved through', () => {
  const drifted = tools((all) => {
    for (const tool of all) {
      const account = tool.inputSchema.properties['account'];
      if (account !== undefined) account.description = 'Which profile to use.';
    }
  });
  // Two, not three: § 3.3 states its schema as prose and has no cell to check.
  const found = problems(DOC, drifted);
  assert.equal(found.length, 2, found.join('\n'));
  for (const problem of found) {
    assert.match(problem, /the `\.describe\(\)` of `account` disagrees/u);
  }
});

test('an "(as § 3.N)" cell follows the reference to the row it defers to', () => {
  const drifted = tools((all) => {
    const tool = all[1];
    assert.ok(tool !== undefined);
    const field = tool.inputSchema.properties['thing_id'];
    assert.ok(field !== undefined);
    field.description = 'A different id entirely.';
  });
  const problem = onlyProblem(DOC, drifted);
  assert.match(
    problem,
    /§ 3\.2 tiktok_do_thing: the `\.describe\(\)` of `thing_id` disagrees/u,
  );
  assert.match(problem, /doc: {6}The id of the thing to read\./u);
});

test('an "(as § 3.N)" cell pointing at a row that is not there fails', () => {
  const problem = onlyProblem(docWith([['(as § 3.1)', '(as § 3.3)']]));
  assert.match(problem, /§ 3\.3 has no `thing_id` row to defer to/u);
});

test('a describe cell in a fourth form is reported, never skipped', () => {
  // A cell shape the gate cannot follow is a cell nothing checks, and silence
  // there would be indistinguishable from agreement.
  const problem = onlyProblem(docWith([['(common, § 2.2)', 'see § 2.2']]));
  assert.match(problem, /cannot be read/u);
  assert.match(
    problem,
    /neither a quoted string, nor `\(common\)`, nor `\(as § 3\.N\)`/u,
  );
});

// ---------------------------------------------------------------------------
// Prose-form schemas — checked in one direction, and only one
// ---------------------------------------------------------------------------

test('a prose schema that stopped naming a field fails', () => {
  const problem = onlyProblem(docWith([['and `wait` —', 'and a flag —']]));
  assert.match(problem, /the input-schema sentence never names `wait`/u);
  assert.match(problem, /only checked in this direction/u);
});

test('a prose schema naming a field the schema dropped is not caught, by design', () => {
  // Stated so the limit is a decision on the record rather than a surprise: the
  // sentence's other code spans are values (`false`) and constants, and no
  // filter admits `wait` while rejecting those.
  const shrunk = tools((all) => {
    const tool = all[2];
    assert.ok(tool !== undefined);
    delete tool.inputSchema.properties['wait'];
  });
  assert.deepEqual(problems(DOC, shrunk), []);
});

// ---------------------------------------------------------------------------
// § 1, the glance table
// ---------------------------------------------------------------------------

test('a glance row missing from the table fails before the columns are compared', () => {
  const problem = onlyProblem(
    docWith([
      [
        '| 3 | `tiktok_sketch_thing` | probe-write | **false** | **true** | **false** | true | `thing.write` or `thing.draft` |\n',
        '',
      ],
    ]),
  );
  assert.match(problem, /§ 1: the glance table lists/u);
  assert.match(problem, /\(order included\)/u);
});

test('a glance row whose package contradicts the section fails', () => {
  const problem = onlyProblem(
    docWith([
      ['| 2 | `tiktok_do_thing` | probe-write |', '| 2 | `tiktok_do_thing` | probe |'],
    ]),
  );
  assert.match(problem, /§ 1 tiktok_do_thing: package is `probe` in the glance table/u);
});

test('a headline that counts wrong fails', () => {
  const problem = onlyProblem(
    docWith([['**3 tools, 2 packages.**', '**4 tools, 3 packages.**']]),
  );
  assert.match(
    problem,
    /the headline claims 4 tools in 3 packages; the manifest has 3 in 2/u,
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
  markdown: string = DOC,
  manifest: readonly FixtureTool[] = TOOLS,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tools-doc-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/TOOLS.md'), markdown, 'utf8');
  await writeFile(
    join(root, 'docs/tool-manifest.json'),
    `${JSON.stringify({ $comment: 'fixture', tools: manifest }, undefined, 2)}\n`,
    'utf8',
  );
  return root;
}

test('a tree whose document restates its manifest passes', async (t) => {
  assert.equal(await syncToolsDoc(await fixture(t)), true);
});

test('a tree whose description drifted fails', async (t) => {
  const root = await fixture(
    t,
    docWith([
      ['> Create a thing and return its id.', '> Create a thing and return its handle.'],
    ]),
  );
  assert.equal(await syncToolsDoc(root), false);
});

test('a tree with a field in the schema and not in the table fails', async (t) => {
  const grown = tools((all) => {
    const tool = all[0];
    assert.ok(tool !== undefined);
    tool.inputSchema.properties['probe'] = { type: 'boolean', description: 'Probe.' };
  });
  assert.equal(await syncToolsDoc(await fixture(t, DOC, grown)), false);
});

test('a tree documenting a tool that does not exist fails', async (t) => {
  const dropped = tools((all) => all.splice(1, 1));
  assert.equal(await syncToolsDoc(await fixture(t, DOC, dropped)), false);
});

test('a CRLF checkout is in sync, not in permanent drift', async (t) => {
  // The Windows CI leg is blocking, and a gate that failed on a correct
  // checkout is a gate that gets deleted rather than obeyed.
  const root = await fixture(t, DOC.replace(/\n/gu, '\r\n'));
  assert.equal(await syncToolsDoc(root), true);
});

test('a missing document fails rather than passing vacuously', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tools-doc-sync-empty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await syncToolsDoc(root), false);
});

test('a manifest with no tools fails instead of reporting perfect agreement', async (t) => {
  // Zero tools and zero sections compare equal, which is a passing set
  // comparison and a broken gate.
  assert.equal(await syncToolsDoc(await fixture(t, '# Empty\n', [])), false);
});

test('a document whose heading form changed fails instead of comparing nothing', async (t) => {
  const renamed = DOC.replace(/^### 3\.\d+ `/gmu, '#### tool ');
  assert.equal(await syncToolsDoc(await fixture(t, renamed)), false);
});

test('a manifest that is not the shape it claims fails', async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, 'docs/tool-manifest.json'),
    '{"tools":[{"name":1}]}',
    'utf8',
  );
  assert.equal(await syncToolsDoc(root), false);
  assert.equal(parseManifest('not json'), undefined);
});

// ---------------------------------------------------------------------------
// The committed tree
// ---------------------------------------------------------------------------

test('the committed TOOLS.md and tool-manifest.json agree', async () => {
  const read = await readToolsDocInputs(REPO_ROOT);
  assert.ok(read !== undefined);
  assert.deepEqual(checkToolsDoc(read), []);
});

test('the committed parse is not vacuous — every section is read, not merely found', async () => {
  // The pass above is only worth something if the reader actually reached the
  // parts it compares. One empty description or one unfound table would make
  // that tool's agreement free.
  const read = await readToolsDocInputs(REPO_ROOT);
  assert.ok(read !== undefined);
  assert.equal(read.doc.sections.length, read.tools.length);
  assert.ok(read.tools.length >= 11, 'the manifest still describes the whole surface');
  assert.equal(read.doc.glance?.length, read.tools.length);
  assert.ok(read.doc.headline !== undefined);
  assert.ok((read.doc.commonAccount ?? '').length > 40);
  for (const section of read.doc.sections) {
    assert.ok(section.package !== undefined, `${section.tool} has no package line`);
    assert.ok(section.scopes !== undefined, `${section.tool} has no scopes line`);
    assert.equal(section.annotations.length, 4, `${section.tool} states four hints`);
    assert.ok(
      (section.description ?? '').length > 100,
      `${section.tool} has no normative description`,
    );
    assert.ok(section.schema !== undefined, `${section.tool} has no input schema`);
  }
});
