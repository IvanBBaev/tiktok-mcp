/**
 * readme-sync (TESTING.md § Sync gates and repo meta): the README tool table is
 * generated from the live manifest, never hand-written.
 *
 * The table between the `GENERATED:TOOLS` markers is the first thing a reader
 * sees, so it is also the first thing to go stale — a renamed tool or a reworded
 * description is exactly the kind of change that never reaches prose. Generating
 * it from `describeAllTools()` means the README can only be wrong if the
 * manifest is.
 *
 * Usage: `node build/scripts/gen-readme.js [--check]`
 */

import { describeAllTools, type ManifestEntry } from '../src/tools/index.js';
import { firstDifference, readRepoText, syncFile } from './lib/repo.js';

const README = 'README.md';
const BEGIN = '<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->';
const END = '<!-- GENERATED:TOOLS:END -->';

const PREAMBLE = [
  '',
  '_This table is generated from the tool registrations — edit the tool',
  'definitions in `src/tools/`, then run `npm run docs:readme`. Descriptions are',
  'summarized to their first sentence; the full text an agent sees is in',
  '[docs/tool-manifest.json](docs/tool-manifest.json)._',
  '',
];

/**
 * A pipe inside a description would end the cell early and silently reshape the
 * table. Escaping is cheaper than a rule forbidding the character.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * First sentence only. Tool descriptions are written for the *model* — they
 * carry the caveats an agent needs mid-call (expiring CDN URLs, silently
 * omitted fields) and run to a paragraph each. Pasted whole they turn the
 * README table into an unreadable wall, so the table takes the opening claim
 * and the manifest keeps the full text.
 */
export function summarize(description: string): string {
  return /^(.*?[.!?])(\s|$)/s.exec(description)?.[1] ?? description;
}

export function renderToolsTable(entries: readonly ManifestEntry[]): string {
  const rows = entries.map((entry) => {
    const readOnly = entry.tool.annotations?.readOnlyHint === true ? 'yes' : 'no';
    return `| \`${entry.package}\` | \`${entry.tool.name}\` | ${readOnly} | ${cell(
      summarize(entry.tool.description ?? ''),
    )} |`;
  });
  return [
    ...PREAMBLE,
    '| Package | Tool | Read-only | Description |',
    '| ------- | ---- | :-------: | ----------- |',
    ...rows,
    '',
  ].join('\n');
}

/** Replace the marked block, leaving every byte outside the markers alone. */
export function applyToolsBlock(readme: string, table: string): string {
  const begin = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${README}: the GENERATED:TOOLS markers are missing or reversed`);
  }
  return `${readme.slice(0, begin + BEGIN.length)}\n${table}\n${readme.slice(end)}`;
}

export async function generateReadme(): Promise<string> {
  return applyToolsBlock(
    await readRepoText(README),
    renderToolsTable(describeAllTools()),
  );
}

export async function syncReadme(check: boolean): Promise<boolean> {
  const next = await generateReadme();
  const { drifted } = await syncFile(README, next, check);
  if (!drifted) return true;
  if (!check) {
    process.stdout.write(`readme-sync: ${README} regenerated.\n`);
    return true;
  }
  const current = await readRepoText(README);
  process.stderr.write(
    `readme-sync: ${README} tool table is stale — run \`npm run docs:readme\`.\n` +
      `${firstDifference(next, current)}\n`,
  );
  return false;
}

if (process.argv[1]?.endsWith('gen-readme.js') === true) {
  const ok = await syncReadme(process.argv.includes('--check'));
  process.exitCode = ok ? 0 : 1;
}
