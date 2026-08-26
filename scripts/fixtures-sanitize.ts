/**
 * Fixture sanitizer (TESTING.md § Recorded sandbox fixtures).
 *
 * The fixtures under `test/fixtures/recorded/` are reviewed like code, and that
 * review only means something if the reviewer knows *how* the file in front of
 * them was produced. Hand-redacting a capture is how a token ships: the diff
 * looks plausible either way, and nothing distinguishes a field that was
 * cleaned from one that merely looked clean. So the committed tree is defined
 * as the output of one pure function over the raw captures — `sanitizeFixture`
 * in `lib/fixtures.ts` — and this script is the driver that applies it.
 *
 * The transform lives entirely in the library, which the recorder and the
 * replay test also read; nothing here knows what a token looks like. What this
 * script owns is the decisions around it:
 *
 * - **The refusal.** Every rendered fixture is scanned for secret shapes
 *   *before* anything is written, and one that still matches is not written at
 *   all. The meta test that forbids those shapes in the committed tree is the
 *   backstop; refusing here means the leak never reaches a file that someone
 *   could `git add` before the suite runs. The fix for a refusal is a new rule
 *   in `lib/fixtures.ts` — never a hand-edit of the output, which would put the
 *   committed tree back outside the transform.
 * - **One pass, one report.** A leak or a drift fails the run but never stops
 *   it. Whoever is holding a sandbox pass wants the whole list of what is
 *   wrong in one go, not the first problem N times.
 * - **Nothing is ever deleted.** See {@link reportOrphans}.
 *
 * The two modes answer two different questions. The default writes, and answers
 * "what did this sandbox pass change?" — the diff it leaves in the working tree
 * is the review artifact. `--check` never writes, and answers "is the committed
 * tree still exactly what the raw captures sanitize to?" — which is what catches
 * a fixture that was edited by hand after it was generated.
 *
 * Usage: `node build/scripts/fixtures-sanitize.js [--check] [--only=<name>[,<name>]]`
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  findSecretShapes,
  FIXTURE_ROOT,
  fixturePath,
  listFixtureFiles,
  loadFixtures,
  RAW_ROOT,
  renderFixture,
  sanitizeFixture,
  type LoadedFixture,
  type SecretHit,
} from './lib/fixtures.js';
import { firstDifference, readRepoText, repoPath, syncFile } from './lib/repo.js';

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

/** The command line, parsed. `only` is `undefined` when no filter was given. */
interface Options {
  readonly check: boolean;
  readonly only: ReadonlySet<string> | undefined;
}

/**
 * Parsed options, or the usage error to report.
 *
 * An unrecognized argument is refused rather than ignored. `--only foo` — a
 * space where the `=` belongs — would otherwise parse as "no filter at all",
 * and in write mode that turns a request to regenerate one fixture into a
 * working tree full of changes nobody asked for.
 */
function parseOptions(argv: readonly string[]): Options | string {
  const prefix = '--only=';
  let check = false;
  let filtered = false;
  const only = new Set<string>();
  for (const arg of argv) {
    if (arg === '--check') {
      check = true;
    } else if (arg.startsWith(prefix)) {
      filtered = true;
      for (const name of arg.slice(prefix.length).split(',')) {
        if (name !== '') only.add(name);
      }
    } else {
      return `unknown argument ${JSON.stringify(arg)}`;
    }
  }
  if (filtered && only.size === 0) return '--only was given no fixture name';
  return { check, only: filtered ? only : undefined };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

/** A fixture that did not make it into the committed tree, and why. */
interface Failure {
  readonly name: string;
  /** Always populated: on a red CI leg this text is the whole diagnosis. */
  readonly detail: string;
}

/** Continuation lines inside one failure detail, indented under its bullet. */
const INDENT = '\n      ';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One line per fixture, written as it is processed. A sandbox pass can carry
 * dozens of captures; streaming in order says which one a later crash was on.
 */
function report(name: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
}

/**
 * The streamed line for a refusal names the shapes only. The excerpts go with
 * the stderr block instead: they are fragments of the value that survived, and
 * the streamed report is the half of the output that gets redirected to a file
 * or pasted into an issue.
 */
function leakSummary(leaks: readonly SecretHit[]): string {
  const shapes = [...new Set(leaks.map((leak) => leak.shape))].join(', ');
  return (
    `refused to write — ${String(leaks.length)} secret shape(s) survived ` +
    `sanitization: ${shapes}`
  );
}

/** The same refusal for the stderr block, with the truncated excerpts. */
function leakDetail(file: string, leaks: readonly SecretHit[]): string {
  return [
    `${file} was not written; add the missing rule to scripts/lib/fixtures.ts`,
    ...leaks.map(
      (leak) => `${leak.shape}: ${leak.why} — ${JSON.stringify(leak.excerpt)}`,
    ),
  ].join(INDENT);
}

// ---------------------------------------------------------------------------
// one fixture
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  /** Where the sanitized capture belongs, repo-relative. */
  readonly file: string;
  /** The raw capture it was produced from, repo-relative. */
  readonly source: string;
  /** The committed file differed from the sanitized rendering. */
  readonly drifted: boolean;
  /** Non-empty means nothing was written, in either mode. */
  readonly leaks: readonly SecretHit[];
}

/**
 * Sanitize one raw capture and decide what happens to its committed file.
 *
 * The secret scan runs on the *rendered* text rather than on the fixture
 * object: that is the byte sequence that would land on disk, and it is also
 * what the meta test reads back, so the two agree by construction rather than
 * by both being careful.
 */
export async function sanitizeOne(
  loaded: LoadedFixture,
  check: boolean,
): Promise<SanitizeResult> {
  const sanitized = sanitizeFixture(loaded.fixture);
  const next = renderFixture(sanitized);
  const file = fixturePath(FIXTURE_ROOT, sanitized.area, sanitized.name);

  const leaks = findSecretShapes(next);
  // `drifted: false` on a refusal does not mean the file on disk matches:
  // nothing was compared, because nothing may be written.
  if (leaks.length > 0) return { file, source: loaded.file, drifted: false, leaks };

  // An area directory does not exist until its first fixture lands, and
  // `syncFile` writes without creating one. Check mode creates nothing at all —
  // a mode whose job is to verify must leave no trace of having run.
  if (!check) await mkdir(dirname(repoPath(file)), { recursive: true });
  const { drifted } = await syncFile(file, next, check);
  return { file, source: loaded.file, drifted, leaks: [] };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * Two captures claiming one committed path, refused before anything is
 * written. `name` is the file's basename by construction when the recorder
 * wrote it, so this only fires on a hand-edited capture — but the failure it
 * prevents is silent: last writer wins, and the committed fixture then
 * flip-flops between runs depending on directory order.
 */
function findCollision(selected: readonly LoadedFixture[]): string | undefined {
  const claimed = new Map<string, string>();
  for (const item of selected) {
    const key = `${item.fixture.area}/${item.fixture.name}`;
    const first = claimed.get(key);
    if (first !== undefined) return `${first} and ${item.file} both sanitize to ${key}`;
    claimed.set(key, item.file);
  }
  return undefined;
}

/**
 * Committed fixtures with no raw capture behind them, reported and left alone.
 *
 * Deleting them would be the right action drawn from the wrong evidence. Raw
 * captures are gitignored and machine-local: `.fixtures-raw/` holds whatever
 * *this* machine recorded most recently, which says nothing about whether a
 * fixture recorded on someone else's sandbox pass is still wanted. Pruning is a
 * human decision made against the replay tests, never against a directory
 * listing that is empty on every fresh clone.
 */
async function reportOrphans(produced: ReadonlySet<string>): Promise<void> {
  for (const file of await listFixtureFiles(FIXTURE_ROOT)) {
    if (produced.has(file)) continue;
    process.stdout.write(
      `  .. ${file} has no raw capture — it was recorded on another machine ` +
        `or the capture was pruned\n`,
    );
  }
}

export async function runFixturesSanitize(argv: readonly string[]): Promise<boolean> {
  const options = parseOptions(argv);
  if (typeof options === 'string') {
    process.stderr.write(
      `fixtures-sanitize: ${options}.\n` +
        'Usage: node build/scripts/fixtures-sanitize.js [--check] [--only=<name>[,<name>]]\n',
    );
    return false;
  }

  let loaded: LoadedFixture[];
  try {
    loaded = await loadFixtures(RAW_ROOT);
  } catch (err) {
    // A raw capture that does not parse is a bug in the recorder, and the
    // message names the file. Sanitizing the others would bury it.
    process.stderr.write(`fixtures-sanitize: ${message(err)}\n`);
    return false;
  }
  if (loaded.length === 0) {
    process.stdout.write(
      `fixtures-sanitize: no raw captures under ${RAW_ROOT}/ — nothing to sanitize.\n`,
    );
    return true;
  }

  const only = options.only;
  if (only !== undefined) {
    const known = new Set(loaded.map((item) => item.fixture.name));
    const unknown = [...only].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      process.stderr.write(
        `fixtures-sanitize: no raw capture named ${unknown.join(', ')}. ` +
          `Recorded here: ${[...known].sort().join(', ')}.\n`,
      );
      return false;
    }
  }
  const selected =
    only === undefined ? loaded : loaded.filter((item) => only.has(item.fixture.name));

  const collision = findCollision(selected);
  if (collision !== undefined) {
    process.stderr.write(`fixtures-sanitize: ${collision}.\n`);
    return false;
  }

  const failures: Failure[] = [];
  const produced = new Set<string>();
  let drifted = 0;
  let leaked = 0;

  for (const item of selected) {
    const name = item.fixture.name;
    let result: SanitizeResult;
    try {
      result = await sanitizeOne(item, options.check);
    } catch (err) {
      // A write that failed — a read-only tree, a full disk — is one failed
      // fixture, not a lost report: the remaining captures still run.
      failures.push({ name, detail: message(err) });
      report(name, false, message(err));
      continue;
    }
    produced.add(result.file);

    if (result.leaks.length > 0) {
      leaked += 1;
      failures.push({ name, detail: leakDetail(result.file, result.leaks) });
      report(name, false, leakSummary(result.leaks));
      continue;
    }
    if (!result.drifted) {
      report(name, true, 'unchanged');
      continue;
    }
    drifted += 1;
    if (!options.check) {
      // Phrased like the sync gates rather than as an `ok` line: a written file
      // is a change to the working tree, and it should read as one.
      process.stdout.write(`fixtures-sanitize: ${result.file} written.\n`);
      continue;
    }
    report(name, false, `${result.file} is out of date`);
    // Recomputed rather than carried on `SanitizeResult`: `sanitizeFixture` is
    // pure, so this is byte-for-byte what `sanitizeOne` compared against, and
    // it is only ever needed on the failing path.
    const next = renderFixture(sanitizeFixture(item.fixture));
    const current = await readRepoText(result.file).catch(() => '');
    failures.push({
      name,
      detail:
        `${result.file} is not what ${item.file} sanitizes to; ` +
        `re-run without --check and review the diff${INDENT}` +
        firstDifference(next, current).split('\n').join(INDENT),
    });
  }

  // Skipped under `--only`, every committed fixture outside the filter looks
  // orphaned, so the note is only meaningful for a full pass.
  if (only === undefined) await reportOrphans(produced);

  process.stdout.write(
    `fixtures-sanitize: ${String(selected.length)} sanitized, ${String(drifted)} ` +
      `${options.check ? 'drifted' : 'written'}, ` +
      `${String(loaded.length - selected.length)} skipped, ${String(leaked)} leaked.\n`,
  );
  if (failures.length === 0) return true;
  process.stderr.write(
    `fixtures-sanitize: ${String(failures.length)} of ${String(selected.length)} ` +
      `fixture(s) failed:\n` +
      `${failures.map((failure) => `  x ${failure.name} — ${failure.detail}`).join('\n')}\n`,
  );
  return false;
}

if (process.argv[1]?.endsWith('fixtures-sanitize.js') === true) {
  const ok = await runFixturesSanitize(process.argv.slice(2));
  process.exitCode = ok ? 0 : 1;
}
