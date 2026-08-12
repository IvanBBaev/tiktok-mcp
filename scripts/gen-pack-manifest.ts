/**
 * Pack audit (TESTING.md § Sync gates and repo meta): the exact file list
 * `npm publish` would upload, committed as a snapshot.
 *
 * `files` in package.json plus `.npmignore` semantics are subtle enough that
 * the interesting failures are silent ones — a `build/**\/*.test.js` negation
 * that stops matching, a `bin/` that quietly drops out of the tarball, a stray
 * `.env` picked up by a broadened glob. None of those break a test; all of them
 * ship. Comparing against a reviewed list turns each into a diff in the PR.
 *
 * Only paths are snapshotted, never sizes or integrity hashes: those change on
 * every source edit and would make the gate pure noise.
 *
 * Requires a current `build/` — `files` includes `build/src`, so run it after
 * `npm run build` (the check chain does).
 *
 * Usage: `node build/scripts/gen-pack-manifest.js [--check]`
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { firstDifference, readRepoText, REPO_ROOT, syncFile } from './lib/repo.js';

const MANIFEST = 'pack-manifest.json';

const execFileAsync = promisify(execFile);

interface PackFile {
  path: string;
}

interface PackResult {
  files?: readonly PackFile[];
}

/**
 * `npm pack --dry-run` writes no tarball but still runs `prepack`/`prepare`;
 * this package defines neither, so the call is a pure query over the working
 * tree. On Windows the npm shim is a `.cmd`, which Node refuses to exec
 * directly, hence the shell.
 */
export async function packedFiles(): Promise<readonly string[]> {
  const isWindows = process.platform === 'win32';
  const { stdout } = await execFileAsync(
    isWindows ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: REPO_ROOT, shell: isWindows, maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as readonly PackResult[];
  const files = parsed[0]?.files;
  if (files === undefined) {
    throw new Error('pack-manifest: `npm pack --dry-run --json` returned no file list');
  }
  // npm's order follows its own traversal; sorting makes the diff reviewable.
  return [...files.map((file) => file.path)].sort();
}

export function renderManifest(files: readonly string[]): string {
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

export async function syncPackManifest(check: boolean): Promise<boolean> {
  const next = renderManifest(await packedFiles());
  const { drifted } = await syncFile(MANIFEST, next, check);
  if (!drifted) return true;
  if (!check) {
    process.stdout.write(`pack-manifest: ${MANIFEST} regenerated.\n`);
    return true;
  }
  const current = await readRepoText(MANIFEST).catch(() => '');
  process.stderr.write(
    `pack-manifest: the published file list changed — review the diff, then run \`npm run sync:write\`.\n` +
      `${firstDifference(next, current)}\n`,
  );
  return false;
}

if (process.argv[1]?.endsWith('gen-pack-manifest.js') === true) {
  const ok = await syncPackManifest(process.argv.includes('--check'));
  process.exitCode = ok ? 0 : 1;
}
