/**
 * The sync gates, run as one step (TESTING.md § Sync gates and repo meta).
 *
 * `npm run sync` verifies every generated artifact; `npm run sync:write`
 * regenerates them. One entry point matters more than it looks: a contributor
 * who has to remember four separate commands will remember three, and the
 * fourth artifact is the one that drifts.
 *
 * Gates that live as tests instead of scripts — the manifest snapshot, the
 * `.env.example` ⇄ CONFIGURATION.md ⇄ `Settings` cross-check, the
 * `PACKAGE_SCOPES` drift check — are reported here as such rather than being
 * silently absent, so this report reads as the full gate list.
 *
 * Usage: `node build/scripts/sync.js [--write]`
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { syncEnvExample } from './gen-env-example.js';
import { syncManifest } from './gen-manifest.js';
import { syncPackManifest } from './gen-pack-manifest.js';
import { syncReadme } from './gen-readme.js';
import { repoPath } from './lib/repo.js';

interface Gate {
  name: string;
  run: (check: boolean) => Promise<boolean>;
  /** Reported but never fails the run. */
  advisory?: boolean;
}

/** Newest mtime of the files with `extension` under `dir`, or 0 if absent. */
async function newestMtime(dir: string, extension: string): Promise<number> {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(repoPath(dir), { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const info = await stat(join(entry.parentPath, entry.name));
    newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

/**
 * Tests run from `build/`, so a stale build means the suite just re-ran the
 * previous commit's code and passed for the wrong reason — the single most
 * misleading green this repo can produce.
 */
export async function buildFreshness(): Promise<boolean> {
  const [src, tests, scripts, built] = await Promise.all([
    newestMtime('src', '.ts'),
    newestMtime('test', '.ts'),
    newestMtime('scripts', '.ts'),
    newestMtime('build', '.js'),
  ]);
  const source = Math.max(src, tests, scripts);
  if (built === 0) {
    process.stderr.write('build-freshness: build/ is missing — run `npm run build`.\n');
    return false;
  }
  if (source > built) {
    process.stderr.write(
      'build-freshness: a source file is newer than build/ — run `npm run build`.\n',
    );
    return false;
  }
  return true;
}

const GATES: readonly Gate[] = [
  { name: 'manifest-snapshot', run: syncManifest },
  { name: 'readme-sync', run: syncReadme },
  { name: 'env-docs-sync', run: syncEnvExample },
  { name: 'pack-audit', run: syncPackManifest },
  { name: 'build-freshness', run: () => buildFreshness() },
];

/** Gates enforced elsewhere, listed so this report is the whole picture. */
const ELSEWHERE: readonly string[] = [
  'env-docs-sync (CONFIGURATION.md ⇄ Settings) — test/settings.test.ts',
  'package-scopes-drift — test/manifest.test.ts',
  'coverage floors — npm run coverage:gate',
  'serverjson-sync — not yet implemented (Phase 3, docs/TESTING.md)',
];

export async function runSync(write: boolean): Promise<boolean> {
  let ok = true;
  for (const gate of GATES) {
    const passed = await gate.run(!write);
    const mark = passed ? 'ok  ' : gate.advisory === true ? 'warn' : 'FAIL';
    process.stdout.write(`${mark} ${gate.name}\n`);
    if (!passed && gate.advisory !== true) ok = false;
  }
  for (const note of ELSEWHERE) process.stdout.write(`  .. ${note}\n`);
  return ok;
}

if (process.argv[1]?.endsWith('sync.js') === true) {
  const ok = await runSync(process.argv.includes('--write'));
  process.exitCode = ok ? 0 : 1;
}
