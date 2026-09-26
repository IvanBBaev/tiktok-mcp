/**
 * floors-doc-sync (TESTING.md § Sync gates and repo meta).
 *
 * `scripts/coverage-floors.json` is the authority on coverage floors: the gate
 * reads it, `test/manifest.test.ts` reads it, and `--ratchet` rewrites it. The
 * § Coverage floors table in `docs/TESTING.md` restated the same numbers by
 * hand, and nothing compared the two.
 *
 * It drifted the moment it could. A ratchet raises each rule on its own, so the
 * table's editorial grouping — four files on one row, "`core/oauth`,
 * `api/upload`, `mcp/plan-store`, `core/redact` | 95 | 90 | 100" — stopped being
 * true the first time two of those four ratcheted apart, and after the Phase-3
 * ratchet every row in the table was wrong. The rule for `src/core/**` had never
 * appeared in it at all. A floors table that is merely decorative is worse than
 * no table: it is the document a contributor consults to find out what standard
 * their file is held to, and it was answering with numbers three phases old.
 *
 * So the table is generated, not checked. That is the opposite call from
 * `cc-coverage` and `tools-doc-sync`, and for the opposite reason: those two
 * guard documents where drift is a judgement (a missing test, a spec the code
 * walked away from) and a script that "repaired" them would be forging the
 * evidence. Here there is no judgement anywhere. The JSON is the decision; the
 * table is a rendering of it; the repair is mechanical and `npm run sync:write`
 * performs it. Floors policy is unaffected — this gate never reads or writes a
 * floor value, it only makes the document say what the JSON already says, in
 * whichever direction the JSON moved.
 *
 * Row order is reproduced exactly as the JSON lists it, because order is
 * load-bearing: a source file is charged to the FIRST matching rule, so
 * `src/core/http.ts` must precede `src/core/**` or the specific floor never
 * applies. A table sorted for looks would document a partition the gate does not
 * use.
 *
 * Deliberately NOT checked here:
 *  - whether a floor is *right*, or high enough, or matches achieved coverage —
 *    that is `scripts/coverage-gate.ts`, at a different time, against real data;
 *  - the prose around the table, including the ratchet-policy paragraph. Prose
 *    is where the reasons live and a generator has no business rewriting it;
 *  - `advisoryReason`, which is a sentence explaining a temporary exception and
 *    belongs in the JSON next to the exception, not in a table cell;
 *  - the other tables in this document, and the floors table quoted inside
 *    `docs/reviews/` — a review is a record of what was said at the time and
 *    must not be edited to agree with today.
 *
 * Usage: `node build/scripts/floors-doc-sync.js [--check]`
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { firstDifference, REPO_ROOT } from './lib/repo.js';

const DOC = 'docs/TESTING.md';
const FLOORS = 'scripts/coverage-floors.json';

/**
 * The table's header row, used as the anchor.
 *
 * Anchoring on a heading instead would bind the gate to the document's section
 * layout, which prose edits move; the header row is the table itself. The block
 * it opens runs to the first blank line — a markdown table cannot contain one.
 */
const HEADER = '| Area | Lines | Branches | Functions |';
const SEPARATOR = '|---|---|---|---|';

export interface Floor {
  lines: number;
  branches: number;
  functions: number;
}

export interface FloorRule extends Floor {
  path: string;
  advisory: boolean;
}

export interface Floors {
  global: Floor;
  rules: readonly FloorRule[];
}

/**
 * A floor percentage, or `undefined` for anything that is not one.
 *
 * A rule whose `lines` arrived as a string would otherwise render as a cell
 * reading `undefined` — a table that is syntactically fine, silently wrong, and
 * committed by a gate that reported success.
 */
function asFloor(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function asTriple(value: unknown): Floor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const lines = asFloor(row['lines']);
  const branches = asFloor(row['branches']);
  const functions = asFloor(row['functions']);
  if (lines === undefined || branches === undefined || functions === undefined) {
    return undefined;
  }
  return { lines, branches, functions };
}

/** Parse the floors file, or `undefined` when it is not the shape the gate renders. */
export function parseFloors(text: string): Floors | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const doc = raw as Record<string, unknown>;
  const global = asTriple(doc['global']);
  const list = doc['rules'];
  if (global === undefined || !Array.isArray(list) || list.length === 0) return undefined;
  const rules: FloorRule[] = [];
  for (const entry of list) {
    const triple = asTriple(entry);
    if (triple === undefined) return undefined;
    const row = entry as Record<string, unknown>;
    const path = row['path'];
    if (typeof path !== 'string' || path.length === 0) return undefined;
    rules.push({ path, advisory: row['advisory'] === true, ...triple });
  }
  return { global, rules };
}

/**
 * Render the table.
 *
 * The advisory marker is part of the generated text rather than a footnote a
 * human maintains, because an advisory rule is one the gate reports and does not
 * enforce — a reader who cannot see that from the row is reading the table
 * wrongly in the one place it matters.
 */
export function renderFloorsTable(floors: Floors): string {
  const rows = floors.rules.map((rule) => {
    const label = `\`${rule.path}\`${rule.advisory ? ' — advisory' : ''}`;
    return `| ${label} | ${String(rule.lines)} | ${String(rule.branches)} | ${String(rule.functions)} |`;
  });
  const { lines, branches, functions } = floors.global;
  rows.push(
    `| **global** | ${String(lines)} | ${String(branches)} | ${String(functions)} |`,
  );
  return [HEADER, SEPARATOR, ...rows].join('\n');
}

export type TableError = 'missing' | 'ambiguous';

/**
 * Discriminated on purpose. A bare `string | TableError` would let the failure
 * codes be read as document text — and a document that happened to consist of
 * the word `missing` would be indistinguishable from a missing anchor.
 */
export type TableResult = { text: string } | { error: TableError };

/**
 * Replace the anchored block, or name why it could not be found.
 *
 * Both failures are reported rather than repaired. A missing anchor means the
 * table was deleted or its columns renamed, and appending a fresh one somewhere
 * plausible would leave the old wording in place with a duplicate below it; two
 * anchors mean a second table with identical columns appeared, and guessing
 * which one the floors belong to is exactly the guess a gate must not make.
 */
export function replaceTable(markdown: string, table: string): TableResult {
  const lines = markdown.split('\n');
  const starts = lines.flatMap((line, i) => (line === HEADER ? [i] : []));
  if (starts.length === 0) return { error: 'missing' };
  if (starts.length > 1) return { error: 'ambiguous' };
  const start = starts[0] ?? 0;
  let end = start;
  while (end < lines.length && lines[end] !== '') end += 1;
  return { text: [...lines.slice(0, start), table, ...lines.slice(end)].join('\n') };
}

export async function syncFloorsDoc(
  check: boolean,
  root: string = REPO_ROOT,
): Promise<boolean> {
  let docText: string;
  let floorsText: string;
  try {
    // LF-normalized for the same reason as `readRepoText`: the Windows CI leg is
    // blocking and a CRLF checkout must not read as drift.
    docText = (await readFile(join(root, DOC), 'utf8')).replace(/\r\n/gu, '\n');
    floorsText = await readFile(join(root, FLOORS), 'utf8');
  } catch {
    process.stderr.write(
      `floors-doc-sync: could not read ${DOC} and ${FLOORS} — both are required.\n`,
    );
    return false;
  }
  const floors = parseFloors(floorsText);
  if (floors === undefined) {
    process.stderr.write(
      `floors-doc-sync: ${FLOORS} is not the shape this gate renders — it needs a ` +
        '`global` triple and a non-empty `rules` array, each entry with a `path` and ' +
        'integer `lines`/`branches`/`functions` percentages.\n',
    );
    return false;
  }
  const replaced = replaceTable(docText, renderFloorsTable(floors));
  if ('error' in replaced && replaced.error === 'missing') {
    process.stderr.write(
      `floors-doc-sync: ${DOC} has no floors table — the anchor is the header row\n` +
        `  ${HEADER}\n` +
        '  and the block it opens ends at the first blank line. Restore it (or fix the\n' +
        '  column names) rather than letting the document carry no floors at all.\n',
    );
    return false;
  }
  if ('error' in replaced) {
    process.stderr.write(
      `floors-doc-sync: ${DOC} has more than one table with the floors header, and\n` +
        '  which one the floors belong to is not a gate’s guess to make.\n',
    );
    return false;
  }
  const next = replaced.text;
  if (next === docText) return true;
  if (!check) {
    await writeFile(join(root, DOC), next, 'utf8');
    process.stdout.write(`floors-doc-sync: ${DOC} floors table regenerated.\n`);
    return true;
  }
  process.stderr.write(
    `floors-doc-sync: the § Coverage floors table in ${DOC} no longer matches ${FLOORS} —\n` +
      '  the JSON is the authority (the gate reads it, `--ratchet` writes it), so the\n' +
      '  repair is `npm run sync:write`, never an edit to the floors themselves.\n' +
      `${firstDifference(next, docText)}\n`,
  );
  return false;
}

if (process.argv[1]?.endsWith('floors-doc-sync.js') === true) {
  const ok = await syncFloorsDoc(process.argv.includes('--check'));
  process.exitCode = ok ? 0 : 1;
}
