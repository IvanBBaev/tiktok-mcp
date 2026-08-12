/**
 * Manifest snapshot (TESTING.md § Sync gates and repo meta): `docs/tool-manifest.json`
 * is the byte-exact wire surface — every tool name, description, input schema,
 * annotation and scope that `tools/list` returns for a fully authorized install.
 *
 * The point of committing it is review. A one-word change to a description or a
 * loosened `.optional()` on an input is invisible in a diff of `src/tools/`
 * unless you already know where to look, yet both are breaking changes for an
 * agent that has learned this surface. Here they are one line of JSON.
 *
 * `outputSchema` is shared by construction (`RESULT_JSON_SCHEMA`), so it is
 * emitted once as `resultSchema` instead of four identical copies — but only
 * for the tools that actually match it; one that diverged would carry its own
 * `outputSchema` inline rather than disappear into the shared field.
 *
 * Usage: `node build/scripts/gen-manifest.js [--check]`
 */

import { RESULT_JSON_SCHEMA } from '../src/mcp/result.js';
import { describeAllTools, type ManifestEntry } from '../src/tools/index.js';
import { firstDifference, readRepoText, syncFile } from './lib/repo.js';

const MANIFEST = 'docs/tool-manifest.json';

const HEADER: readonly string[] = [
  'GENERATED — run `npm run sync:write` after changing a tool definition.',
  'The wire surface of tools/list for an installation holding every scope.',
  'A diff here is a change agents can see: review it as an API change.',
];

export function renderManifest(entries: readonly ManifestEntry[]): string {
  const shared = JSON.stringify(RESULT_JSON_SCHEMA);
  const tools = entries.map((entry) => {
    const { outputSchema, ...tool } = entry.tool;
    const diverged = JSON.stringify(outputSchema) !== shared;
    return {
      package: entry.package,
      scopes: entry.scopes,
      ...(entry.scopesAnyOf === undefined ? {} : { scopesAnyOf: entry.scopesAnyOf }),
      ...tool,
      ...(diverged ? { outputSchema } : {}),
    };
  });
  return `${JSON.stringify(
    { $comment: HEADER, resultSchema: RESULT_JSON_SCHEMA, tools },
    null,
    2,
  )}\n`;
}

export async function syncManifest(check: boolean): Promise<boolean> {
  const next = renderManifest(describeAllTools());
  const { drifted } = await syncFile(MANIFEST, next, check);
  if (!drifted) return true;
  if (!check) {
    process.stdout.write(`manifest-snapshot: ${MANIFEST} regenerated.\n`);
    return true;
  }
  const current = await readRepoText(MANIFEST).catch(() => '');
  process.stderr.write(
    `manifest-snapshot: the tool surface changed — review the diff, then run \`npm run sync:write\`.\n` +
      `${firstDifference(next, current)}\n`,
  );
  return false;
}

if (process.argv[1]?.endsWith('gen-manifest.js') === true) {
  const ok = await syncManifest(process.argv.includes('--check'));
  process.exitCode = ok ? 0 : 1;
}
