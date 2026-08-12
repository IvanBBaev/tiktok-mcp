/**
 * Shared plumbing for the sync gates (TESTING.md § Sync gates and repo meta).
 *
 * Every generated artifact in this repo — the README tool table, `.env.example`,
 * the manifest snapshot — is produced by a script that can also *verify* it.
 * The write mode is what a contributor runs; the check mode is what
 * `npm run check` and CI run. Keeping both in one code path is the whole point:
 * a generator and a separate hand-written checker are two things that can
 * disagree, and the one that drifts is always the checker.
 *
 * These scripts are not part of the shipped server — they run from `build/` like
 * everything else, but nothing under `src/` may import them.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo root, resolved from this module's own compiled location
 * (`build/scripts/lib/repo.js` → three levels up). Deriving it from
 * `process.cwd()` would make every gate depend on where npm was invoked from.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

/**
 * Read a repo file with line endings normalized to LF.
 *
 * The Windows CI leg is blocking, and a checkout there may carry CRLF. A gate
 * that compared raw bytes would fail on Windows for a repo that is perfectly in
 * sync — a false alarm that trains people to ignore the gate.
 */
export async function readRepoText(rel: string): Promise<string> {
  const text = await readFile(repoPath(rel), 'utf8');
  return text.replace(/\r\n/g, '\n');
}

export interface SyncOutcome {
  file: string;
  /** True when the file on disk differed from the generated content. */
  drifted: boolean;
}

/**
 * Write `next` to `rel`, or — in check mode — report the difference without
 * touching the file.
 *
 * Check mode never repairs. A CI leg that silently fixed the artifact it was
 * asked to verify would report success for a working tree that is still wrong,
 * and the fix would exist only on a machine nobody commits from.
 */
export async function syncFile(
  rel: string,
  next: string,
  check: boolean,
): Promise<SyncOutcome> {
  const current = await readRepoText(rel).catch(() => undefined);
  if (current === next) return { file: rel, drifted: false };
  if (!check) await writeFile(repoPath(rel), next, 'utf8');
  return { file: rel, drifted: true };
}

/** The first differing line, rendered for a gate failure message. */
export function firstDifference(expected: string, actual: string): string {
  const want = expected.split('\n');
  const got = actual.split('\n');
  const max = Math.max(want.length, got.length);
  for (let i = 0; i < max; i += 1) {
    if (want[i] === got[i]) continue;
    return [
      `line ${String(i + 1)}:`,
      `  generated: ${JSON.stringify(want[i] ?? '<end of file>')}`,
      `  on disk:   ${JSON.stringify(got[i] ?? '<end of file>')}`,
    ].join('\n');
  }
  return 'files differ only in trailing content';
}
