/**
 * Release engineering (IMPLEMENTATION-PLAN WP-3.1, gaps G-10/G-11).
 *
 * The release guard and the `serverjson-sync` gate only ever run at moments
 * nobody wants to debug — a pushed tag, a red `npm run check` minutes before a
 * publish — so their logic is exercised here as plain functions instead. The
 * file has a second job: the keep-a-changelog policy and the version agreement
 * between `package.json`, `server.json`, the plugin manifest and the extension
 * are asserted against the *committed* files on every test run, which is what
 * makes a drifted release identity a red suite rather than a bad tag.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { allTools } from '../src/tools/index.js';
import {
  checkChangelog,
  checkRelease,
  countEntries,
  distTagFor,
  normalizeTag,
  parseChangelog,
  readReleaseInputs,
  releaseNotes,
  releasedSection,
  resolveTag,
  type ReleaseInputs,
} from '../scripts/release-guard.js';
import { checkServerJson, liveFacts } from '../scripts/serverjson-sync.js';
import { readRepoJson, readRepoText } from '../scripts/lib/repo.js';

// ---------------------------------------------------------------------------
// tag parsing and dist-tag selection
// ---------------------------------------------------------------------------

test('a release tag is vX.Y.Z, with or without the v', () => {
  assert.equal(normalizeTag('v1.2.3'), '1.2.3');
  assert.equal(normalizeTag('1.2.3'), '1.2.3');
  assert.equal(normalizeTag(' v1.2.3-rc.1 '), '1.2.3-rc.1');
  for (const notATag of ['main', 'v1.2', 'release-1.2.3', 'v1.2.3.4', '']) {
    assert.equal(normalizeTag(notATag), undefined, notATag);
  }
});

test('a prerelease never claims the latest dist-tag', () => {
  // `npm publish` assigns `latest` unless told otherwise, and `latest` is what
  // every `npx tiktok-mcp-ai` resolves to.
  assert.equal(distTagFor('1.0.0'), 'latest');
  assert.equal(distTagFor('1.0.0-rc.1'), 'next');
});

test('the tag comes from the flag, the positional, or a tag ref — never a branch', () => {
  const onTag = { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' };
  assert.equal(resolveTag(['--tag', 'v1.0.0'], onTag), 'v1.0.0');
  assert.equal(resolveTag(['v1.0.0', '--notes'], onTag), 'v1.0.0');
  assert.equal(resolveTag(['--notes'], onTag), 'v9.9.9');
  assert.equal(
    resolveTag([], { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' }),
    undefined,
  );
  assert.equal(resolveTag([], {}), undefined);
});

// ---------------------------------------------------------------------------
// keep a changelog (G-10)
// ---------------------------------------------------------------------------

const RELEASED = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.0.0] - 2026-08-12',
  '',
  '### Added',
  '',
  '- A thing.',
  '',
  '[Unreleased]: https://example.invalid/compare/v1.0.0...HEAD',
  '[1.0.0]: https://example.invalid/releases/tag/v1.0.0',
].join('\n');

test('parseChangelog separates headings, dates and link definitions', () => {
  const changelog = parseChangelog(RELEASED);
  assert.deepEqual(
    changelog.sections.map((section) => section.label),
    ['Unreleased', '1.0.0'],
  );
  assert.equal(releasedSection(changelog)?.date, '2026-08-12');
  // Link definitions live inside the last section's text but are structure, not
  // release notes — `--notes` must not paste them into a GitHub release.
  assert.equal(releaseNotes(changelog, '1.0.0'), '### Added\n\n- A thing.');
  assert.deepEqual([...changelog.links].sort(), ['1.0.0', 'Unreleased']);
});

test('countEntries counts bullets and numbered items, not headings or prose', () => {
  assert.equal(countEntries('Some words.\n\n### Added\n\n- One\n- Two\n1. Three'), 3);
  assert.equal(countEntries('* Star bullet'), 1);
  assert.equal(countEntries('Nothing has shipped yet.'), 0);
  // A bare group heading is template, not a change.
  assert.equal(countEntries('### Added\n\n### Fixed'), 0);
});

test('an empty ### Added template under [Unreleased] does not block the release', () => {
  const text = RELEASED.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n');
  assert.deepEqual(checkChangelog(parseChangelog(text), '1.0.0'), []);
});

test('a released section of group headings alone lists no changes', () => {
  const text = RELEASED.replace('- A thing.', '### Fixed');
  const problems = checkChangelog(parseChangelog(text), '1.0.0');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /\[1\.0\.0\] lists no changes/);
});

test('the released changelog entry passes the policy', () => {
  assert.deepEqual(checkChangelog(parseChangelog(RELEASED), '1.0.0'), []);
});

test('a changelog whose top entry is still [Unreleased] blocks the release', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n';
  const problems = checkChangelog(parseChangelog(text), '1.0.0');
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /no released section/);
});

test('entries left under [Unreleased] block the release that should carry them', () => {
  const text = RELEASED.replace('## [Unreleased]\n', '## [Unreleased]\n\n- Forgotten.\n');
  const problems = checkChangelog(parseChangelog(text), '1.0.0');
  assert.equal(problems.length, 1);
  assert.match(
    problems[0] ?? '',
    /\[Unreleased\] still lists 1 entries above \[1\.0\.0\]/,
  );
});

test('the policy names each defect of the release entry separately', () => {
  const undated = checkChangelog(
    parseChangelog(RELEASED.replace(' - 2026-08-12', '')),
    '1.0.0',
  );
  assert.match(undated.join('\n'), /carries no ` - YYYY-MM-DD` date/);

  const impossible = parseChangelog(RELEASED.replace('2026-08-12', '2026-02-31'));
  assert.match(checkChangelog(impossible, '1.0.0').join('\n'), /not an ISO date/);

  const empty = parseChangelog(RELEASED.replace('### Added\n\n- A thing.\n', ''));
  assert.match(checkChangelog(empty, '1.0.0').join('\n'), /lists no changes/);

  const unlinked = parseChangelog(
    RELEASED.replace('[1.0.0]: https://example.invalid/releases/tag/v1.0.0', ''),
  );
  assert.match(
    checkChangelog(unlinked, '1.0.0').join('\n'),
    /no `\[1\.0\.0\]:` compare link/,
  );
});

test('the committed CHANGELOG.md obeys the policy it will be released under', async () => {
  // G-10 is a policy, not a one-off review: every versioned entry stays dated,
  // linked and non-empty for as long as the file exists.
  const changelog = parseChangelog(await readRepoText('CHANGELOG.md'));
  assert.equal(changelog.sections[0]?.label, 'Unreleased');
  assert.ok(changelog.links.has('Unreleased'));
  for (const section of changelog.sections.slice(1)) {
    assert.match(section.date ?? '', /^\d{4}-\d{2}-\d{2}$/, section.label);
    assert.ok(changelog.links.has(section.label), `${section.label} has no compare link`);
    assert.ok(countEntries(section.body) > 0, `${section.label} lists no changes`);
  }
});

// ---------------------------------------------------------------------------
// release-guard
// ---------------------------------------------------------------------------

function inputs(overrides: Partial<ReleaseInputs> = {}): ReleaseInputs {
  return {
    tag: 'v1.0.0',
    versions: [
      { label: 'package.json version', version: '1.0.0' },
      { label: 'server.json version', version: '1.0.0' },
    ],
    packagePrivate: false,
    serverDescription: 'A short description.',
    changelog: parseChangelog(RELEASED),
    ...overrides,
  };
}

test('a consistent release passes the guard', () => {
  assert.deepEqual(checkRelease(inputs()), []);
});

test('a version mismatch names exactly the two things that disagree', () => {
  const problems = checkRelease(
    inputs({
      versions: [
        { label: 'package.json version', version: '1.0.0' },
        { label: 'server.json version', version: '0.9.0' },
      ],
    }),
  );
  assert.deepEqual(problems, ['git tag v1.0.0 != server.json version 0.9.0']);
});

test('a missing version field is reported as missing, not as a mismatch', () => {
  const problems = checkRelease(inputs({ versions: [{ label: 'plugin version' }] }));
  assert.deepEqual(problems, [
    'plugin version is missing — nothing to compare git tag v1.0.0 with',
  ]);
});

test('a tag that is not a version is the only thing reported', () => {
  // Everything downstream is derived from the version, so reporting the rest
  // would be noise about a comparison that never happened.
  assert.deepEqual(checkRelease(inputs({ tag: 'nightly' })), [
    '"nightly" is not a vX.Y.Z release tag',
  ]);
});

test('the guard refuses the two failures that only surface after publishing', () => {
  // `private: true` fails inside `npm publish`; an over-long description fails
  // in the registry step, which runs after npm has spent the version.
  assert.match(
    checkRelease(inputs({ packagePrivate: true })).join('\n'),
    /"private": true/,
  );
  assert.match(
    checkRelease(inputs({ serverDescription: 'x'.repeat(101) })).join('\n'),
    /101 characters — the MCP registry schema caps it at 100/,
  );
});

test('readReleaseInputs reads every file the release identity lives in', async () => {
  const collected = await readReleaseInputs('v1.0.0');
  assert.deepEqual(
    collected.versions.map((source) => source.label),
    [
      'package.json version',
      'server.json version',
      'server.json packages[tiktok-mcp-ai] version',
      '.claude-plugin/plugin.json version',
      'extension/package.json version',
    ],
  );
});

test('the committed version fields already agree with each other', async () => {
  // The tag is the only thing missing before a release; everything else is
  // committed, so a forgotten bump is caught here rather than on the tag push.
  const pkg = await readRepoJson('package.json');
  const version = pkg?.['version'];
  const collected = await readReleaseInputs(`v${String(version)}`);
  for (const source of collected.versions) {
    assert.equal(source.version, version, source.label);
  }
});

// ---------------------------------------------------------------------------
// serverjson-sync
// ---------------------------------------------------------------------------

const FACTS = {
  transport: 'stdio',
  knownVars: new Set(['TT_MEDIA_ROOT', 'TT_TRANSPORT']),
  credentials: ['TT_CLIENT_KEY', 'TT_CLIENT_SECRET'],
  toolCount: 11,
};

function serverFixture(): Record<string, unknown> {
  return {
    name: 'io.github.Example/example-mcp',
    description: 'An example server — 11 tools.',
    repository: { url: 'https://github.com/Example/example', source: 'github' },
    version: '1.0.0',
    packages: [
      {
        registryType: 'npm',
        identifier: 'example-mcp',
        version: '1.0.0',
        transport: { type: 'stdio' },
        environmentVariables: [
          { name: 'TT_CLIENT_KEY', isRequired: true, isSecret: true },
          { name: 'TT_CLIENT_SECRET', isRequired: true, isSecret: true },
          { name: 'TT_MEDIA_ROOT', isRequired: false },
        ],
      },
    ],
  };
}

const PKG_FIXTURE = {
  name: 'example-mcp',
  version: '1.0.0',
  mcpName: 'io.github.Example/example-mcp',
  repository: { url: 'git+https://github.com/Example/example.git' },
};

test('a server.json that matches the code and the package passes', () => {
  // `git+…/example.git` and `…/example` are the same repository — a gate that
  // compared them literally would be permanently red for a correct file.
  assert.deepEqual(checkServerJson(serverFixture(), PKG_FIXTURE, FACTS), []);
});

test('every field server.json restates is compared against its source', () => {
  const cases: [string, (server: Record<string, unknown>) => void, RegExp][] = [
    [
      'mcpName',
      (s) => (s['name'] = 'io.github.Other/other'),
      /name .* != package.json mcpName/,
    ],
    [
      'version',
      (s) => (s['version'] = '2.0.0'),
      /server.json version 2\.0\.0 != package\.json/,
    ],
    [
      'repository',
      (s) => (s['repository'] = { url: 'https://elsewhere.invalid' }),
      /repository\.url/,
    ],
    [
      'tool count',
      (s) => (s['description'] = 'Now with 7 tools.'),
      /claims 7 tools, but the server registers 11/,
    ],
    ['package count', (s) => (s['packages'] = []), /lists 0 package entries/],
  ];
  for (const [label, mutate, expected] of cases) {
    const server = serverFixture();
    mutate(server);
    assert.match(checkServerJson(server, PKG_FIXTURE, FACTS).join('\n'), expected, label);
  }
});

test('the npm package entry is compared field by field', () => {
  const cases: [string, (entry: Record<string, unknown>) => void, RegExp][] = [
    ['registry', (e) => (e['registryType'] = 'pypi'), /registryType pypi != npm/],
    [
      'identifier',
      (e) => (e['identifier'] = 'other-mcp'),
      /identifier other-mcp != package\.json name/,
    ],
    ['version', (e) => (e['version'] = '0.9.0'), /package version 0\.9\.0 !=/],
    [
      'transport',
      (e) => (e['transport'] = { type: 'http' }),
      /transport http != the default transport stdio/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const server = serverFixture();
    const entry = (server['packages'] as Record<string, unknown>[])[0];
    if (entry !== undefined) mutate(entry);
    assert.match(checkServerJson(server, PKG_FIXTURE, FACTS).join('\n'), expected, label);
  }
});

test('the declared environment is held to what the build actually reads', () => {
  const variables = (server: Record<string, unknown>): Record<string, unknown>[] => {
    const entry = (server['packages'] as Record<string, unknown>[])[0] ?? {};
    return entry['environmentVariables'] as Record<string, unknown>[];
  };
  const cases: [string, (server: Record<string, unknown>) => void, RegExp][] = [
    ['unknown var', (s) => variables(s).push({ name: 'TT_GONE' }), /does not read/],
    [
      'duplicate',
      (s) => variables(s).push({ name: 'TT_MEDIA_ROOT' }),
      /declares TT_MEDIA_ROOT twice/,
    ],
    ['unnamed', (s) => variables(s).push({ isRequired: true }), /with no name/],
    [
      'optional marked required',
      (s) => {
        const media = variables(s)[2];
        if (media !== undefined) media['isRequired'] = true;
      },
      /marks TT_MEDIA_ROOT isRequired, but this build starts without it/,
    ],
    [
      'credential not secret',
      (s) => {
        const key = variables(s)[0];
        if (key !== undefined) key['isSecret'] = false;
      },
      /does not mark the credential TT_CLIENT_KEY isSecret/,
    ],
    [
      'credential omitted',
      (s) => {
        const entry = (s['packages'] as Record<string, unknown>[])[0] ?? {};
        entry['environmentVariables'] = [];
      },
      /omits TT_CLIENT_KEY, without which no install can authorize/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const server = serverFixture();
    mutate(server);
    assert.match(checkServerJson(server, PKG_FIXTURE, FACTS).join('\n'), expected, label);
  }
});

test('liveFacts reports the running build, not a second hand-written list', () => {
  const facts = liveFacts();
  assert.equal(facts.transport, 'stdio');
  assert.equal(facts.toolCount, allTools().length);
  assert.deepEqual(facts.credentials, ['TT_CLIENT_KEY', 'TT_CLIENT_SECRET']);
  assert.ok(facts.knownVars.has('TT_MEDIA_ROOT'));
});

test('the committed server.json passes its own gate', async () => {
  const server = await readRepoJson('server.json');
  const pkg = await readRepoJson('package.json');
  assert.ok(server !== undefined && pkg !== undefined);
  assert.deepEqual(checkServerJson(server, pkg, liveFacts()), []);
});
