/**
 * Release guard (IMPLEMENTATION-PLAN WP-3.1 / gap G-10).
 *
 * The identity of a release lives in five hand-edited places — the git tag,
 * `package.json`, `server.json` (twice: the server version and the npm package
 * entry), the Claude Code plugin manifest and the topmost CHANGELOG entry — and
 * nothing else in the repo compares them. They are edited at different moments
 * by a human, which is exactly the shape of drift a `npm version` + `git push
 * --tags` afternoon produces.
 *
 * The cost of that drift is asymmetric: an npm version number is spent the
 * moment it publishes and can only be deprecated, never re-used, and the MCP
 * registry step runs *after* npm, so a `server.json` the registry rejects fails
 * when the version is already gone. This guard therefore runs before the
 * publish, refuses on the first disagreement, and names the two things that
 * disagree rather than "versions differ".
 *
 * It deliberately does not write. A script that "fixed" the version fields
 * would be deciding on its own what is being released — the one decision that
 * has to stay with the person pushing the tag.
 *
 * Usage: `node build/scripts/release-guard.js [<tag>|--tag <tag>] [--notes|--dist-tag]`
 * In CI the tag comes from `GITHUB_REF_NAME` when the pushed ref is a tag.
 */

import { asRecord, asString, readRepoJson, readRepoText } from './lib/repo.js';

const PACKAGE_JSON = 'package.json';
const SERVER_JSON = 'server.json';
const PLUGIN_JSON = '.claude-plugin/plugin.json';
const EXTENSION_JSON = 'extension/package.json';
const CHANGELOG = 'CHANGELOG.md';

/**
 * The MCP registry schema caps `description` at 100 characters
 * (`server.schema.json`, 2025-12-11). It is checked here rather than in the
 * `serverjson-sync` gate because it is the registry's rule, not this repo's
 * invariant — and because the registry publish runs after npm, where a
 * rejection costs a version.
 */
const MAX_SERVER_DESCRIPTION = 100;

/** `vX.Y.Z`, optionally with a SemVer prerelease/build suffix. */
const TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

const HEADING_PATTERN = /^## \[([^\]]+)\](?:\s+-\s+(.+?))?\s*$/;
const LINK_PATTERN = /^\[([^\]]+)\]:\s+\S+/;
/**
 * A bullet or a numbered item — a change. A bare `### Added` heading is not: an
 * empty template group would otherwise block a release as "unreleased entries",
 * and a released section of headings alone would pass as listing changes.
 */
const ENTRY_PATTERN = /^(?:[-*] |\d+\. )/;

// --- changelog (keep a changelog 1.1.0) ---

export interface ChangelogSection {
  /** Heading text inside the brackets: `Unreleased` or a version. */
  label: string;
  /** The ` - YYYY-MM-DD` part of the heading, when present. */
  date?: string;
  /** Everything under the heading, link definitions removed. */
  body: string;
}

export interface Changelog {
  sections: readonly ChangelogSection[];
  /** Labels carrying a `[label]: url` definition — the compare links. */
  links: ReadonlySet<string>;
}

export function parseChangelog(text: string): Changelog {
  const sections: ChangelogSection[] = [];
  const links = new Set<string>();
  let current: { label: string; date?: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const { label, date, lines } = current;
    sections.push({
      label,
      ...(date === undefined ? {} : { date }),
      body: lines.join('\n').trim(),
    });
  };
  for (const line of text.split('\n')) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading !== null) {
      flush();
      const [, label, date] = heading;
      current = {
        label: label ?? '',
        ...(date === undefined ? {} : { date }),
        lines: [],
      };
      continue;
    }
    const link = LINK_PATTERN.exec(line);
    if (link !== null) {
      // Link definitions sit at the bottom of the file, inside the last
      // section's text; they are structure, not release notes.
      links.add(link[1] ?? '');
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  return { sections, links };
}

export function isUnreleased(label: string): boolean {
  return /^unreleased$/i.test(label);
}

/** Entry-shaped lines in a section body; 0 means "this section says nothing". */
export function countEntries(body: string): number {
  return body.split('\n').filter((line) => ENTRY_PATTERN.test(line)).length;
}

/** ISO calendar date, rejecting well-formed impossibilities like `2026-02-31`. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/** The topmost section that is not `[Unreleased]` — the release being cut. */
export function releasedSection(changelog: Changelog): ChangelogSection | undefined {
  return changelog.sections.find((section) => !isUnreleased(section.label));
}

/**
 * Keep-a-changelog policy (G-10), enforced against the version being tagged.
 * The rules are the ones a reader depends on: the release is at the top, it is
 * dated, it lists something, it is linkable, and nothing that ships with it was
 * left behind under `[Unreleased]`.
 */
export function checkChangelog(changelog: Changelog, version: string): string[] {
  const problems: string[] = [];
  const head = releasedSection(changelog);
  if (head === undefined) {
    return [
      `${CHANGELOG} has no released section — the topmost entry is still ` +
        `[Unreleased]; move it under \`## [${version}] - <YYYY-MM-DD>\``,
    ];
  }
  for (const section of changelog.sections.slice(0, changelog.sections.indexOf(head))) {
    const entries = countEntries(section.body);
    if (entries > 0) {
      problems.push(
        `${CHANGELOG} [${section.label}] still lists ${String(entries)} entries above ` +
          `[${head.label}] — everything shipping in ${version} belongs under it`,
      );
    }
  }
  if (head.label !== version) {
    problems.push(`git tag ${version} != ${CHANGELOG} topmost entry [${head.label}]`);
  }
  if (head.date === undefined) {
    problems.push(`${CHANGELOG} entry [${head.label}] carries no \` - YYYY-MM-DD\` date`);
  } else if (!isIsoDate(head.date)) {
    problems.push(
      `${CHANGELOG} entry [${head.label}] is dated "${head.date}", which is not an ISO date`,
    );
  }
  if (countEntries(head.body) === 0) {
    problems.push(`${CHANGELOG} entry [${head.label}] lists no changes`);
  }
  if (!changelog.links.has(head.label)) {
    problems.push(`${CHANGELOG} has no \`[${head.label}]:\` compare link`);
  }
  return problems;
}

/** The release notes for `version`, ready for `gh release create --notes-file`. */
export function releaseNotes(changelog: Changelog, version: string): string | undefined {
  return changelog.sections.find((section) => section.label === version)?.body;
}

// --- the guard ---

export interface VersionSource {
  /** How the source is named in a failure line, e.g. `server.json version`. */
  label: string;
  version?: string;
}

export interface ReleaseInputs {
  tag: string;
  versions: readonly VersionSource[];
  /** `package.json` `"private": true` — npm refuses to publish such a package. */
  packagePrivate: boolean;
  serverDescription?: string;
  changelog: Changelog;
}

/** Everything wrong with this release, in the order a human would fix it. */
export function checkRelease(input: ReleaseInputs): string[] {
  const version = normalizeTag(input.tag);
  if (version === undefined) {
    return [`"${input.tag}" is not a vX.Y.Z release tag`];
  }
  const problems: string[] = [];
  for (const source of input.versions) {
    if (source.version === undefined) {
      problems.push(
        `${source.label} is missing — nothing to compare git tag ${input.tag} with`,
      );
    } else if (source.version !== version) {
      problems.push(`git tag ${input.tag} != ${source.label} ${source.version}`);
    }
  }
  if (input.packagePrivate) {
    problems.push(`${PACKAGE_JSON} is \`"private": true\` — npm publish would refuse it`);
  }
  const description = input.serverDescription;
  if (description !== undefined && description.length > MAX_SERVER_DESCRIPTION) {
    problems.push(
      `${SERVER_JSON} description is ${String(description.length)} characters — the MCP ` +
        `registry schema caps it at ${String(MAX_SERVER_DESCRIPTION)} and would reject the ` +
        `server after npm has already published`,
    );
  }
  problems.push(...checkChangelog(input.changelog, version));
  return problems;
}

/** `v1.2.3` and `1.2.3` both mean the version `1.2.3`; anything else is not a tag. */
export function normalizeTag(tag: string): string | undefined {
  return TAG_PATTERN.exec(tag.trim())?.[1];
}

/**
 * A prerelease must not become `latest`, or every `npx tiktok-mcp-ai` in the
 * world silently upgrades to a release candidate.
 */
export function distTagFor(version: string): string {
  return version.includes('-') ? 'next' : 'latest';
}

/** Explicit tag first, then the pushed ref — never a guess from `git describe`. */
export function resolveTag(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const flag = argv.indexOf('--tag');
  if (flag >= 0) return argv[flag + 1];
  const positional = argv.find((argument) => !argument.startsWith('-'));
  if (positional !== undefined) return positional;
  if (env['GITHUB_REF_TYPE'] === 'tag') return env['GITHUB_REF_NAME'];
  return undefined;
}

export async function readReleaseInputs(tag: string): Promise<ReleaseInputs> {
  const pkg = (await readRepoJson(PACKAGE_JSON)) ?? {};
  const server = (await readRepoJson(SERVER_JSON)) ?? {};
  const plugin = (await readRepoJson(PLUGIN_JSON)) ?? {};
  const extension = await readRepoJson(EXTENSION_JSON);
  const packages = Array.isArray(server['packages']) ? server['packages'] : [];
  const versions: VersionSource[] = [
    { label: `${PACKAGE_JSON} version`, version: asString(pkg['version']) },
    { label: `${SERVER_JSON} version`, version: asString(server['version']) },
    ...packages.map((entry, index) => {
      const record = asRecord(entry) ?? {};
      const identifier = asString(record['identifier']) ?? String(index);
      return {
        label: `${SERVER_JSON} packages[${identifier}] version`,
        version: asString(record['version']),
      };
    }),
    { label: `${PLUGIN_JSON} version`, version: asString(plugin['version']) },
    // publish-vscode.yml publishes the extension once this tag's npm publish
    // succeeds, so a forgotten bump there ships a marketplace entry describing
    // another release.
    ...(extension === undefined
      ? []
      : [
          { label: `${EXTENSION_JSON} version`, version: asString(extension['version']) },
        ]),
  ];
  const description = asString(server['description']);
  return {
    tag,
    versions,
    packagePrivate: pkg['private'] === true,
    ...(description === undefined ? {} : { serverDescription: description }),
    changelog: parseChangelog(await readRepoText(CHANGELOG)),
  };
}

const USAGE =
  'release-guard: no tag given — pass `--tag vX.Y.Z`, or run it on a tag ref in CI.\n' +
  'Usage: node build/scripts/release-guard.js [<tag>|--tag <tag>] [--notes|--dist-tag]\n';

/**
 * `--notes` and `--dist-tag` still run every check first: printing release notes
 * for a release that is not internally consistent would hand the caller exactly
 * the artifact the guard exists to prevent.
 */
export async function runReleaseGuard(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const tag = resolveTag(argv, env);
  if (tag === undefined) {
    process.stderr.write(USAGE);
    return false;
  }
  const inputs = await readReleaseInputs(tag);
  const problems = checkRelease(inputs);
  if (problems.length > 0) {
    process.stderr.write(
      `release-guard: ${tag} is not releasable — ${String(problems.length)} problem(s):\n` +
        `${problems.map((problem) => `  x ${problem}`).join('\n')}\n`,
    );
    return false;
  }
  const version = normalizeTag(tag) ?? tag;
  if (argv.includes('--notes')) {
    process.stdout.write(`${releaseNotes(inputs.changelog, version) ?? ''}\n`);
    return true;
  }
  if (argv.includes('--dist-tag')) {
    process.stdout.write(`${distTagFor(version)}\n`);
    return true;
  }
  process.stdout.write(
    `release-guard: ${tag} agrees with ` +
      `${inputs.versions.map((source) => source.label).join(', ')} and ${CHANGELOG}.\n`,
  );
  return true;
}

if (process.argv[1]?.endsWith('release-guard.js') === true) {
  const ok = await runReleaseGuard(process.argv.slice(2), process.env);
  process.exitCode = ok ? 0 : 1;
}
