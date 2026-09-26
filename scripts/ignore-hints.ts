/**
 * ignore-hints (TESTING.md § Sync gates and repo meta).
 *
 * A `/* c8 ignore *\/` hint is the one construct in this repo that makes a
 * problem *disappear from the report* rather than fixing it. Every other gate
 * checks that two artifacts agree; this one checks the honesty of the coverage
 * number itself, because a hint that is wrong does not fail — it silently
 * subtracts, and the percentage goes up either way.
 *
 * Four rules, and each one is a failure this repo actually shipped before the
 * gate existed:
 *
 *  - **the hint must be closed on the line it opens on.** `v8-to-istanbul`
 *    matches its patterns against one line at a time and anchors them at the
 *    start of the line (`lib/source.js:54-70`), so the continuation lines of a
 *    wrapped comment match nothing. A hint that Prettier reflowed across three
 *    lines ignores its own first line and one more, lands two lines short of
 *    its target, and does nothing at all. Nothing reports this: the coverage
 *    simply fails to move, which reads as "the branch is covered elsewhere";
 *  - **the hint must say why.** A bare `/* c8 ignore start *\/` is a claim with
 *    no argument attached, and it is the form that survives review longest
 *    precisely because there is nothing in it to disagree with;
 *  - **a `file:line` in the argument must still point at a line.** The reasons
 *    here cite the enforcer that makes the code unreachable — the guard, the
 *    throw site, the injection point. Those citations are the entire evidence
 *    base, and they rot the moment someone edits the cited file, with no
 *    symptom whatsoever. This rule is why the gate exists;
 *  - **a block may not swallow a function, unless the function *is* the thing
 *    that never runs.** An exclusion is normally for the arm that cannot be
 *    reached, not for the function containing it: `src/mcp/http.ts` once
 *    wrapped two whole functions — `requestPath` and `boundPortOf`, both of
 *    which run on every request — in order to hide two narrow fallbacks, and 19
 *    lines of exercised, testable code vanished from the denominator. The one
 *    honest exception is a *production seam default*, where the whole function
 *    is the unreachable unit because every test injects a replacement; that
 *    verdict is spelled out in the reason, so the rule reads it rather than
 *    guessing from shape.
 *
 * On top of the four, a **budget**: the number of hints in `src/` may not grow.
 * Coverage floors ratchet up; this ratchets down, and for the same reason. A
 * floor that only ever rises and an exclusion count that only ever falls are
 * the two halves of one promise — that the number means more each release, not
 * less. `--ratchet` lowers the budget to what the tree actually spends.
 *
 * Check-only in `npm run check`: there is no such thing as automatically
 * repairing a stale citation, because the repair is a person re-reading the
 * cited code and deciding whether the claim still holds.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readRepoText, repoPath, syncFile } from './lib/repo.js';

/**
 * The most hints `src/` may carry, and the file the number lives in.
 *
 * It is a JSON file rather than a constant so that `--ratchet` can move it
 * without a code edit, exactly as `coverage-floors.json` works.
 */
export const BUDGET_FILE = 'scripts/ignore-budget.json';

export interface Budget {
  /** Maximum `c8 ignore` hints across `src/**\/*.ts`. */
  hints: number;
  /** Maximum lines enclosed by `start`/`stop` pairs across `src/**\/*.ts`. */
  blockLines: number;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export type HintForm = 'next' | 'start' | 'stop';

export interface Hint {
  /** Repo-relative file the hint sits in. */
  file: string;
  /** 1-based line the hint opens on. */
  line: number;
  form: HintForm;
  /** The `next N` count, when the hint carries one. */
  count: number | undefined;
  /** Everything after `--`, trimmed; empty when the hint gives no reason. */
  reason: string;
  /** True when the comment does not close on the line it opened on. */
  wrapped: boolean;
}

/**
 * The opener, deliberately looser than `v8-to-istanbul`'s own patterns.
 *
 * The converter anchors at `^\W*`, so a hint that is *not* at the start of its
 * line means something different to it (it ignores only that line). This gate
 * has to see every form a person might have written, including the ones the
 * converter would quietly reinterpret, so it matches anywhere on the line and
 * lets the rules below judge what it found. No trailing word boundary, because
 * v8-to-istanbul has none: `c8 ignore starting …` is honoured as `start`, so it
 * must be counted as one.
 */
const OPENER =
  /\/\* (?:(?:c8|v8) ignore|node:coverage(?: ignore)?) (next(?: (\d+))?|start|stop|disable|enable)/;

/** `node:coverage disable`/`enable` are the same block under another name. */
const FORM_ALIASES: Readonly<Record<string, HintForm>> = {
  disable: 'start',
  enable: 'stop',
};

export function parseHints(file: string, text: string): Hint[] {
  const hints: Hint[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const match = OPENER.exec(raw);
    if (match === null) continue;
    const head = match[1] ?? '';
    const form: HintForm = head.startsWith('next')
      ? 'next'
      : (FORM_ALIASES[head] ?? (head as HintForm));
    const after = raw.slice(match.index);
    const closed = after.includes('*/');
    const marker = after.indexOf('--');
    const reason =
      closed && marker !== -1 ? after.slice(marker + 2, after.indexOf('*/')).trim() : '';
    hints.push({
      file,
      line: index + 1,
      form,
      count: match[2] === undefined ? undefined : Number(match[2]),
      reason,
      wrapped: !closed,
    });
  }
  return hints;
}

/**
 * Lines a hint hides beyond the one line a plain `next` costs: the body of a
 * `start`/`stop` block, the extra lines of a `next N`, and — for a `start` that
 * never closes — everything to the end of the file, which is what c8 ignores.
 */
export function blockLines(hints: readonly Hint[], lineCount = 0): number {
  let total = 0;
  let open: number | undefined;
  for (const hint of hints) {
    if (hint.form === 'next' && hint.count !== undefined)
      total += Math.max(0, hint.count - 1);
    if (hint.form === 'start') open = hint.line;
    else if (hint.form === 'stop' && open !== undefined) {
      total += hint.line - open - 1;
      open = undefined;
    }
  }
  if (open !== undefined) total += Math.max(0, lineCount - open);
  return total;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface Citation {
  /** The text as written, e.g. `core/errors.ts:34`. */
  text: string;
  path: string;
  line: number;
}

/**
 * `path/file.ts:123`, in every shape the reasons in this repo use it.
 *
 * Citations are written the way a person would say them out loud — sometimes
 * repo-relative (`src/cli/doctor.ts:291`), more often just far enough to be
 * unambiguous (`core/errors.ts:34`, `publish-write.ts:163`). Resolution below
 * accepts all three rather than forcing a spelling, because a gate that made
 * people write longer citations would get fewer citations.
 */
const CITATION = /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|md|json)):(\d+)\b/g;

export function citationsIn(text: string): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(CITATION)) {
    found.push({ text: match[0], path: match[1] ?? '', line: Number(match[2]) });
  }
  return found;
}

/**
 * The comment block immediately above a hint, which is where the argument is.
 *
 * TESTING.md tells contributors to keep the hint itself to one line and put the
 * reasoning in an ordinary comment above it — so the citations that matter are
 * usually *not* inside the hint. This walks upward across contiguous `//` and
 * ` *` lines to collect them.
 */
export function prosePreceding(lines: readonly string[], line: number): string {
  const collected: string[] = [];
  for (let i = line - 2; i >= 0; i -= 1) {
    const text = lines[i] ?? '';
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) collected.unshift(text);
    else break;
  }
  return collected.join('\n');
}

/** Candidate repo-relative paths for a citation, most specific first. */
export function candidatePaths(cited: string, from: string): string[] {
  const dir = from.slice(0, from.lastIndexOf('/'));
  return [cited, `src/${cited}`, `${dir}/${cited}`, `test/${cited}`, `scripts/${cited}`];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface ScannedFile {
  file: string;
  text: string;
}

/** A repo the checker can resolve citations against, injectable for fixtures. */
export interface Tree {
  /** Line count of a repo-relative file, or undefined when it does not exist. */
  lengthOf(path: string): number | undefined;
  /** The text of a line, 1-based; undefined when out of range. */
  lineAt(path: string, line: number): string | undefined;
}

/** Declarations an exclusion block must not contain (see the header). */
const DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?function\s|^\s*(?:export\s+)?class\s/;

/**
 * The one verdict for which enclosing a whole declaration is the correct shape.
 *
 * Matched on the reason text rather than inferred, because the difference
 * between "this function never runs in a test" and "this function runs on every
 * request and I hid it" is a claim about the seam, not about the code's shape —
 * and a claim has to be written down to be reviewable. The wording is fixed so
 * that the exemption cannot be taken by accident: it is the phrase TESTING.md
 * prescribes for verdict 4, and any citation it carries is checked by Rule 3
 * like every other.
 */
const SEAM_DEFAULT = /production seam default/;

export function checkHints(
  files: readonly ScannedFile[],
  tree: Tree,
  budget: Budget,
): string[] {
  const problems: string[] = [];
  let hintTotal = 0;
  let blockTotal = 0;

  for (const { file, text } of files) {
    const lines = text.split('\n');
    const hints = parseHints(file, text);
    hintTotal += hints.length;
    blockTotal += blockLines(hints, lines.length);

    let openedAt: Hint | undefined;
    for (const hint of hints) {
      const at = `${file}:${hint.line}`;

      // Rule 1 — the comment must close on the line it opened on.
      if (hint.wrapped) {
        problems.push(
          `${at}: the hint is spread across lines. v8-to-istanbul matches one ` +
            `line at a time (lib/source.js:54-70), so a wrapped hint silently ` +
            `ignores the wrong lines. Keep it to one line.`,
        );
        continue;
      }

      // Rule 2 — it must carry an argument. `stop` is punctuation, not a claim.
      if (hint.form !== 'stop' && hint.reason === '') {
        problems.push(
          `${at}: the hint gives no reason. Write ` +
            `\`/* c8 ignore ${hint.form} -- <verdict>: <why> */\` and cite the ` +
            `file:line that enforces it (TESTING.md § What to do with an ` +
            `uncovered branch).`,
        );
      }

      // Rule 3 — every file:line in the hint or the prose above it must resolve.
      const scope = `${prosePreceding(lines, hint.line)}\n${hint.reason}`;
      for (const cite of citationsIn(scope)) {
        const resolved = candidatePaths(cite.path, file).find(
          (candidate) => tree.lengthOf(candidate) !== undefined,
        );
        if (resolved === undefined) {
          problems.push(`${at}: cites ${cite.text}, but no such file exists.`);
          continue;
        }
        const body = tree.lineAt(resolved, cite.line);
        if (body === undefined) {
          problems.push(
            `${at}: cites ${cite.text}, but ${resolved} has only ` +
              `${String(tree.lengthOf(resolved))} lines. The citation has rotted — ` +
              `re-read the code and restate the verdict.`,
          );
        } else if (body.trim() === '') {
          problems.push(
            `${at}: cites ${cite.text}, which is a blank line. The cited code ` +
              `moved; the claim needs re-checking, not renumbering.`,
          );
        }
      }

      // Rule 4 — a block excludes an unreachable arm, never a whole function.
      if (hint.form === 'start') openedAt = hint;
      if (hint.form === 'stop' && openedAt !== undefined) {
        const span = lines.slice(openedAt.line, hint.line - 1);
        const declared = span.find((line) => DECLARATION.test(line));
        if (declared !== undefined && !SEAM_DEFAULT.test(openedAt.reason)) {
          problems.push(
            `${file}:${openedAt.line}: the block encloses a declaration ` +
              `(\`${declared.trim().slice(0, 48)}\`). Exclude the arm that cannot ` +
              `be reached, not the function that contains it — unless the whole ` +
              `function is a production seam default, which the reason must say.`,
          );
        }
        openedAt = undefined;
      }
    }
    if (openedAt !== undefined) {
      problems.push(
        `${file}:${openedAt.line}: the block is never closed, so c8 ignores the ` +
          `rest of the file. Close it with a stop hint on the line after the arm.`,
      );
    }
  }

  // The budget, last, so a tree that broke a rule reads the rule first.
  if (hintTotal > budget.hints) {
    problems.push(
      `budget: ${String(hintTotal)} c8 ignore hints in src/, budget is ` +
        `${String(budget.hints)}. An exclusion hides a branch instead of ` +
        `testing it, so the count ratchets down like a coverage floor ratchets ` +
        `up. Test the branch, or lower another exclusion to pay for this one.`,
    );
  }
  if (blockTotal > budget.blockLines) {
    problems.push(
      `budget: ${String(blockTotal)} lines inside c8 ignore blocks in src/, ` +
        `budget is ${String(budget.blockLines)}.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

async function tsFiles(root: string, rel: string, out: string[]): Promise<void> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const next = `${rel}/${entry.name}`;
    if (entry.isDirectory()) await tsFiles(root, next, out);
    else if (entry.name.endsWith('.ts')) out.push(next);
  }
}

/** The live repo, read once into memory — citations cross files constantly. */
export async function readTree(paths: readonly string[]): Promise<Tree> {
  const cache = new Map<string, string[]>();
  for (const path of paths) {
    try {
      cache.set(path, (await readRepoText(path)).split('\n'));
    } catch {
      // A citation to a file that does not exist is Rule 3's finding to report,
      // not this loader's: leaving it out of the cache is how it says so.
    }
  }
  return {
    lengthOf: (path) => cache.get(path)?.length,
    lineAt: (path, line) => cache.get(path)?.[line - 1],
  };
}

export async function readBudget(): Promise<Budget> {
  const raw = JSON.parse(await readRepoText(BUDGET_FILE)) as Budget;
  return { hints: raw.hints, blockLines: raw.blockLines };
}

export async function syncIgnoreHints(ratchet = false): Promise<boolean> {
  const rel: string[] = [];
  await tsFiles(repoPath(), 'src', rel);
  const files: ScannedFile[] = [];
  for (const file of rel) files.push({ file, text: await readRepoText(file) });

  // Citations may name any repo file, so the tree is every path a reason could
  // plausibly cite — not just the sources being scanned.
  const citable: string[] = [...rel];
  for (const dir of ['test', 'scripts', 'docs']) {
    try {
      await tsFiles(repoPath(), dir, citable);
    } catch {
      // An absent directory cannot be cited; Rule 3 reports it if one is.
    }
  }
  const extra = await readdir(repoPath('docs'));
  for (const name of extra) if (name.endsWith('.md')) citable.push(`docs/${name}`);
  const tree = await readTree(citable);

  const budget = await readBudget();
  const problems = checkHints(files, tree, budget);

  if (ratchet) {
    const hints = files.reduce((sum, f) => sum + parseHints(f.file, f.text).length, 0);
    const lines = files.reduce(
      (sum, f) => sum + blockLines(parseHints(f.file, f.text), f.text.split('\n').length),
      0,
    );
    const next = {
      hints: Math.min(budget.hints, hints),
      blockLines: Math.min(budget.blockLines, lines),
    };
    await syncFile(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`, false);
    process.stdout.write(
      `ignore-hints: budget ratcheted to ${String(next.hints)} hints / ` +
        `${String(next.blockLines)} block lines.\n`,
    );
    return problems.filter((p) => !p.startsWith('budget:')).length === 0;
  }

  for (const problem of problems) process.stderr.write(`ignore-hints: ${problem}\n`);
  return problems.length === 0;
}

if (process.argv[1]?.endsWith('ignore-hints.js') === true) {
  const ok = await syncIgnoreHints(process.argv.includes('--ratchet'));
  process.exitCode = ok ? 0 : 1;
}
