/**
 * doctor-doc-sync (TESTING.md § Sync gates and repo meta).
 *
 * `doctor` owns a check-list — `DOCTOR_CHECKS` in `src/cli/doctor.ts` — and
 * `docs/TROUBLESHOOTING.md` § What each check means restates it by hand: one
 * row per check, in the same order, second column the prose a reader needs
 * when a row of output confuses them. The section says so out loud — "the
 * checks run in this order. Reading them top to bottom is reading the startup
 * path of the server" — which is a promise the document makes about the code,
 * and until this gate nothing held it to it.
 *
 * It is the drift class that has already bitten this repo: the `publish
 * journal` row described a fold the tool had stopped doing, and the document
 * went on describing it because a document has no way to notice. A check added
 * without a row is a row of output nobody can look up. A row left behind by a
 * deleted check is a paragraph explaining something that no longer runs, which
 * reads exactly like a specification and is a lie. A row in the wrong place
 * breaks the one claim the section makes about itself.
 *
 * **Checked, never written** — unlike `floors-doc-sync`, which renders its
 * table from JSON. There is no rendering here: the second column is the whole
 * value of the row and only a person can write it. A generator would have to
 * invent that prose, or emit an empty cell, and an empty cell that satisfies a
 * gate is worse than the drift it replaced. So a difference is reported as
 * what it is — a decision somebody still has to make — and both files are left
 * exactly as they were.
 *
 * What is compared: the **titles**, as a sequence. Not the check `id`s — those
 * are the `--json` contract and they already have an owner in
 * `test/doctor.test.ts` ("the report keeps its order"), so gating on them here
 * would fail twice for one cause. Not the prose in the second column, not the
 * severities a check can emit, and not the `configuration` pseudo-check that
 * `runDoctor` synthesizes when the configuration cannot be read at all: it is
 * not in `DOCTOR_CHECKS`, it never appears beside the real rows, and
 * § `--json` for scripts and CI describes it where it belongs.
 *
 * Usage: `node build/scripts/doctor-doc-sync.js`
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DOCTOR_CHECKS } from '../src/cli/doctor.js';
import { REPO_ROOT } from './lib/repo.js';

const DOC = 'docs/TROUBLESHOOTING.md';
const SOURCE = 'src/cli/doctor.ts';

const HEADER = '| Check | What it is telling you |';

/** Why the table could not be read at all — distinct from "the rows disagree". */
export type TableError = 'missing' | 'ambiguous' | 'empty';

/**
 * Discriminated rather than `string[] | TableError`. The failure codes and the
 * row titles are both strings, and a table whose single row happened to read
 * `empty` would be indistinguishable from a table that has none.
 */
export type TableParse = { titles: readonly string[] } | { error: TableError };

/** The first cell of a markdown row, with the backticks the doc wraps it in. */
function firstCell(line: string): string | undefined {
  const cells = line.split('|');
  const cell = cells[1];
  if (cell === undefined) return undefined;
  return cell.trim().replace(/^`(.*)`$/u, '$1');
}

/**
 * The ordered first column of the check table.
 *
 * Anchored on the header line rather than the `##` heading: a heading can be
 * reworded without changing what the table asserts, and two tables under one
 * heading would still need telling apart.
 */
export function parseCheckTable(markdown: string): TableParse {
  const lines = markdown.split('\n');
  const starts = lines.flatMap((line, i) => (line === HEADER ? [i] : []));
  if (starts.length === 0) return { error: 'missing' };
  if (starts.length > 1) return { error: 'ambiguous' };
  const start = starts[0] ?? 0;
  const titles: string[] = [];
  // + 2 skips the header and the `| ----- | ---- |` separator under it.
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !line.startsWith('|')) break;
    const title = firstCell(line);
    if (title === undefined || title === '') break;
    titles.push(title);
  }
  return titles.length === 0 ? { error: 'empty' } : { titles };
}

/**
 * Every way the two sequences can disagree, as sentences a reader can act on.
 *
 * Set differences are reported before order, because a missing row explains an
 * order mismatch that would otherwise be reported as its own separate problem
 * and send somebody moving rows that were never in the wrong place.
 */
export function checkDoctorDoc(
  expected: readonly string[],
  documented: readonly string[],
): readonly string[] {
  const problems: string[] = [];

  const seen = new Set<string>();
  for (const title of documented) {
    if (seen.has(title)) problems.push(`${DOC}: two rows for \`${title}\``);
    seen.add(title);
  }

  for (const title of expected) {
    if (!seen.has(title)) {
      problems.push(
        `${SOURCE} runs a check titled \`${title}\` that ${DOC} has no row for`,
      );
    }
  }
  const known = new Set(expected);
  for (const title of documented) {
    if (!known.has(title)) {
      problems.push(`${DOC} has a row for \`${title}\`, which is not a check any more`);
    }
  }

  if (problems.length === 0 && documented.join('\n') !== expected.join('\n')) {
    problems.push(
      `the rows are the right set in the wrong order — ${SOURCE} runs them as ` +
        `${expected.join(', ')}`,
    );
  }
  return problems;
}

export async function syncDoctorDoc(
  root: string = REPO_ROOT,
  checks: readonly { readonly title: string }[] = DOCTOR_CHECKS,
): Promise<boolean> {
  const markdown = await readFile(join(root, DOC), 'utf8')
    .then((text) => text.replace(/\r\n/gu, '\n'))
    .catch(() => undefined);
  if (markdown === undefined) {
    process.stderr.write(`doctor-doc-sync: could not read ${DOC}.\n`);
    return false;
  }

  const parsed = parseCheckTable(markdown);
  if ('error' in parsed) {
    const why = {
      missing: `no \`${HEADER}\` line — the table moved or its header changed`,
      ambiguous: `two \`${HEADER}\` lines — which one states the check-list is a guess`,
      empty: 'the table header is there with no rows under it',
    }[parsed.error];
    process.stderr.write(
      `doctor-doc-sync: ${DOC} § What each check means: ${why}.\n` +
        '  The comparison below would be vacuous, so it is not made. Restore the\n' +
        '  table, or move this gate to wherever the check-list is documented now.\n',
    );
    return false;
  }

  const expected = checks.map((check) => check.title);
  if (expected.length === 0) {
    process.stderr.write(
      `doctor-doc-sync: ${SOURCE} exports no checks — every comparison below ` +
        'would pass vacuously.\n',
    );
    return false;
  }

  const problems = checkDoctorDoc(expected, parsed.titles);
  if (problems.length === 0) return true;

  process.stderr.write(
    `doctor-doc-sync: ${DOC} and ${SOURCE} disagree about doctor's check-list:\n`,
  );
  for (const problem of problems) process.stderr.write(`  x ${problem}\n`);
  process.stderr.write(
    `  note: this gate never writes either file. The second column of that table is\n` +
      '  prose only a person can write, so a new check needs a row written by hand and\n' +
      '  a row with no check needs deleting by hand. `npm run sync:write` will not do\n' +
      '  it for you, and a row added with an empty explanation is worse than the drift.\n',
  );
  return false;
}

if (process.argv[1]?.endsWith('doctor-doc-sync.js') === true) {
  const ok = await syncDoctorDoc();
  process.exitCode = ok ? 0 : 1;
}
