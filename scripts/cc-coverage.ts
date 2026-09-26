/**
 * cc-coverage (TESTING.md § Sync gates and repo meta).
 *
 * `docs/CORNER-CASES.md` enumerates every edge case the implementation is
 * supposed to handle, decided at design time "so tests can be written first",
 * and asks for the ids to be reused in test names. Nothing enforced the second
 * half. The catalog is the kind of document that is written once and read as
 * evidence forever after, so an id whose test was never written — or whose test
 * was deleted in a refactor — reads exactly like one that is covered. Five ids
 * (CC-A4, CC-A14, CC-E5, CC-E6, CC-E8) were in precisely that state when this
 * gate was written: decided, believed tested, named by nothing.
 *
 * The gate is a set comparison between the ids the catalog **defines** and the
 * ids `test/` **names**, and it fails in three directions:
 *
 *  - a defined id no test names — the case is documented but unpinned;
 *  - a cited id the catalog does not define — a typo (`CC-E88`) or a citation
 *    left behind after a definition was renamed away. Without this direction a
 *    misspelled citation covers nothing while looking like coverage;
 *  - an exemption for an id that is now cited — a stale exemption is drift in
 *    the same way a stale snapshot is, and one that outlives its reason is how
 *    an exemption list turns into a permanent skip list.
 *
 * Two rules make the comparison trustworthy rather than merely green:
 *
 * **Ids are harvested from definition sites, never from mentions.** A definition
 * is the catalog's bullet form — `- **CC-A1 — <title>.**` — and nothing else.
 * The docs are full of references that a mention-scan would swallow: the closing
 * "open items" table restates four ids in `| CC-E8 | … |` rows, and
 * `docs/IMPLEMENTATION-PLAN.md` assigns work packages in en-dash ranges
 * (`CC-A1–A7`, `CC-B1–B9`). Harvesting a range invents ids — `CC-A1–A7` is one
 * string naming seven cases, six of which the scan would never see, while
 * `CC-D1–D9` would happily "define" a `CC-D1` in a file that defines nothing.
 * An authority derived from mentions is not an authority; it is an echo.
 *
 * **Citations are matched case-insensitively.** The catalog's own ID-scheme note
 * asks for `cc-a1 rotation persisted before first use`, and the house test-name
 * convention (TESTING.md § Test naming) is lowercase throughout. An
 * uppercase-only scan reports the entire suite as uncovered, which is how this
 * gate would have been "fixed" by loosening it.
 *
 * Deliberately NOT checked here, so the gate's silence is not read as more than
 * it is:
 *  - whether the citing test actually exercises the case. A gate cannot read a
 *    test's mind; it can only make an unpinned case impossible to overlook. The
 *    id in the name is a claim a human makes and a reviewer can check;
 *  - how many tests cite an id, or that a case with several clauses has one test
 *    per clause;
 *  - citations in `src/`, which are cross-references in prose, not coverage;
 *  - the catalog's prose, its ordering, or whether its domains are contiguous.
 *
 * Check-only: there is nothing derivable to write. The repair for a missing
 * citation is a test, and a script that invented one would be writing the very
 * evidence this gate exists to demand.
 *
 * Usage: `node build/scripts/cc-coverage.js`
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { REPO_ROOT } from './lib/repo.js';

const CATALOG = 'docs/CORNER-CASES.md';
const TEST_DIR = 'test';

/**
 * This gate's own test file, excluded from the citation scan.
 *
 * It has to spell out malformed ids (`CC-E88`) and range strings as fixtures,
 * and a scan that counted those would report the typo it is *testing for* as a
 * real one — and would let a fixture stand in as coverage for a case nobody
 * tested. The file therefore cites nothing, by construction.
 */
const SELF = 'cc-coverage.test.ts';

/**
 * A catalog definition site: the bullet, the bolded id, the em-dash title.
 *
 * The trailing `—` (em dash, as ` — `) is the discriminator. A range
 * written in the same bullet position — `- **CC-A1–A7 — owned by WP-1.**` —
 * fails to match at all rather than matching its first endpoint, which is the
 * correct reading: a range names cases, it does not define one.
 */
const DEFINITION = /^- \*\*(CC-[A-Z]\d+) — /gmu;

/**
 * Any mention of an id, in either case. Used only against `test/` sources.
 *
 * The `i` is the whole point and was worth a failing test to learn: written
 * without it, this scan reported five genuinely-cited cases as unpinned,
 * because the house convention spells ids lowercase in test names.
 */
const CITATION = /\bCC-([A-Za-z])(\d+)\b/giu;

/**
 * Ids that no CI test can pin, each with the reason it cannot.
 *
 * Empty, and that is a finding rather than an omission: every case the catalog
 * defines is named by at least one test today. The list exists so that the day
 * one genuinely cannot be — a case observable only against a live TikTok
 * sandbox, say, or one whose trigger is a platform behavior no fixture can
 * reproduce — the reason is written down and reviewed, instead of the id being
 * quietly dropped from the comparison. An entry is a claim with an author, not
 * a skip: adding one is a diff a reviewer sees, and {@link checkCoverage} fails
 * the moment the claim stops being true.
 */
export const EXEMPTIONS: ReadonlyMap<string, string> = new Map<string, string>([]);

/** The ids `docs/CORNER-CASES.md` defines, in catalog order. */
export function definedIds(markdown: string): readonly string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(DEFINITION)) {
    const id = match[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Every id a source file names, normalized to the catalog's spelling. */
export function citedIds(source: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(CITATION)) {
    const domain = match[1];
    const index = match[2];
    if (domain === undefined || index === undefined) continue;
    ids.add(`CC-${domain.toUpperCase()}${index}`);
  }
  return ids;
}

export interface CoverageInputs {
  /** Ids defined by the catalog. */
  defined: readonly string[];
  /** Cited id → the test file that names it (the first, in read order). */
  cited: ReadonlyMap<string, string>;
  /** Exempted id → the reason it cannot be pinned. */
  exemptions: ReadonlyMap<string, string>;
}

/** Sort key: domain letter, then index numerically — `CC-A2` before `CC-A10`. */
function idOrder(id: string): [string, number] {
  const parsed = /^CC-([A-Z])(\d+)$/u.exec(id);
  return [parsed?.[1] ?? id, Number(parsed?.[2] ?? 0)];
}

function byId(a: string, b: string): number {
  const [leftDomain, leftIndex] = idOrder(a);
  const [rightDomain, rightIndex] = idOrder(b);
  return leftDomain === rightDomain
    ? leftIndex - rightIndex
    : leftDomain.localeCompare(rightDomain);
}

/** One problem line per disagreement, ordered by id so the report is stable. */
export function checkCoverage(inputs: CoverageInputs): string[] {
  const defined = new Set(inputs.defined);
  const problems: string[] = [];

  for (const id of [...defined].sort(byId)) {
    if (inputs.cited.has(id)) continue;
    if (inputs.exemptions.has(id)) continue;
    problems.push(
      `${id} is defined in ${CATALOG} but no test names it — write the test, ` +
        `or add it to EXEMPTIONS in scripts/cc-coverage.ts with the reason it cannot be`,
    );
  }

  for (const [id, file] of [...inputs.cited].sort(([a], [b]) => byId(a, b))) {
    if (defined.has(id)) continue;
    problems.push(
      `${id} is named by ${file} but ${CATALOG} defines no such id — a typo, ` +
        `or a citation outliving the definition it referred to`,
    );
  }

  for (const [id, reason] of [...inputs.exemptions].sort(([a], [b]) => byId(a, b))) {
    const file = inputs.cited.get(id);
    if (file !== undefined) {
      problems.push(
        `${id} is exempted ("${reason}") but ${file} cites it now — ` +
          `delete the exemption, the reason no longer holds`,
      );
    }
    if (!defined.has(id)) {
      problems.push(
        `${id} is exempted ("${reason}") but ${CATALOG} no longer defines it — ` +
          `delete the exemption`,
      );
    }
  }

  return problems;
}

/** Every `*.ts` under `dir`, relative to `root`, excluding this gate's own test. */
async function testSources(root: string): Promise<string[]> {
  const entries = await readdir(join(root, TEST_DIR), {
    recursive: true,
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === SELF) continue;
    files.push(join(entry.parentPath, entry.name));
  }
  return files.sort();
}

/** The catalog and the suite, or `undefined` when either cannot be read. */
export async function readCoverageInputs(
  root: string = REPO_ROOT,
): Promise<CoverageInputs | undefined> {
  let markdown: string;
  let files: string[];
  try {
    markdown = await readFile(join(root, CATALOG), 'utf8');
    files = await testSources(root);
  } catch {
    return undefined;
  }
  const cited = new Map<string, string>();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // Reported with forward slashes on every platform: the failure text names a
    // file a contributor is meant to open, and the Windows CI leg is blocking.
    const named = relative(root, file).split(sep).join('/');
    for (const id of citedIds(source)) {
      if (!cited.has(id)) cited.set(id, named);
    }
  }
  return { defined: definedIds(markdown), cited, exemptions: EXEMPTIONS };
}

/** Report the drift; there is nothing here a script may repair. */
export async function syncCoverage(root: string = REPO_ROOT): Promise<boolean> {
  const inputs = await readCoverageInputs(root);
  if (inputs === undefined) {
    process.stderr.write(
      `cc-coverage: could not read ${CATALOG} and ${TEST_DIR}/ — both are required.\n`,
    );
    return false;
  }
  if (inputs.defined.length === 0) {
    process.stderr.write(
      `cc-coverage: ${CATALOG} defines no ids — the harvest matches ` +
        '`- **CC-A1 — title.**` and nothing else, so either the catalog was ' +
        'emptied or its bullet form changed.\n',
    );
    return false;
  }
  const problems = checkCoverage(inputs);
  if (problems.length === 0) return true;
  process.stderr.write(
    `cc-coverage: ${CATALOG} and ${TEST_DIR}/ disagree about which corner cases are pinned:\n`,
  );
  for (const problem of problems) process.stderr.write(`  x ${problem}\n`);
  process.stderr.write(
    '  note: a citation is the id in a test name, lowercase by convention —\n' +
      "  test('cc-a1: the rotated refresh token is on disk before …', …).\n" +
      '  note: this gate proves an id is named, never that the test naming it is any good;\n' +
      '  that judgement is the reviewer’s, and the citation is what gives them something to judge.\n',
  );
  return false;
}

if (process.argv[1]?.endsWith('cc-coverage.js') === true) {
  const ok = await syncCoverage();
  process.exitCode = ok ? 0 : 1;
}
