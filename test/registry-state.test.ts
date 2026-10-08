/**
 * The publish-or-skip decision in front of `npm publish` (gap G-14).
 *
 * `scripts/registry-state.ts` runs only inside a tag's *Publish* run, where a
 * wrong answer either spends a version or releases a tag npm does not hold, so
 * its logic is exercised here as plain functions over recorded npm output and
 * hand-built tarballs. Nothing here touches the network.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  compareTarballs,
  decide,
  diffFiles,
  identityProblem,
  parseView,
  sri,
  tarFiles,
  type ContentCheck,
  type RegistryView,
} from '../scripts/registry-state.js';

const NAME = 'tiktok-mcp-ai';
const HEAD = 'c63de15a992d37f0d6cec03ac7631872838602cb';
const OTHER = '2ca716d6313dcfab425d3555ac8bf85929bc57a4';

function published(
  overrides: Partial<Extract<RegistryView, { kind: 'published' }>> = {},
): Extract<RegistryView, { kind: 'published' }> {
  return {
    kind: 'published',
    version: '1.2.3',
    gitHead: HEAD,
    integrity: 'sha512-x',
    tarball: 'https://registry.npmjs.org/tiktok-mcp-ai/-/tiktok-mcp-ai-1.2.3.tgz',
    distTags: { latest: '1.2.3' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// npm view output
// ---------------------------------------------------------------------------

test('npm view: the npm 10 object and the npm 11+ one-element array read the same', () => {
  const fields = {
    version: '1.2.3',
    gitHead: HEAD,
    'dist.integrity': 'sha512-abc',
    'dist.tarball': 'https://registry.npmjs.org/x/-/x-1.2.3.tgz',
    'dist-tags': { latest: '1.2.3', next: '1.3.0-rc.1', bogus: 7 },
  };
  const expected: RegistryView = {
    kind: 'published',
    version: '1.2.3',
    gitHead: HEAD,
    integrity: 'sha512-abc',
    tarball: 'https://registry.npmjs.org/x/-/x-1.2.3.tgz',
    distTags: { latest: '1.2.3', next: '1.3.0-rc.1' },
  };
  assert.deepEqual(parseView(JSON.stringify(fields), 0), expected);
  assert.deepEqual(parseView(JSON.stringify([fields], null, 2), 0), expected);
});

test('npm view: only E404 means "not published"', () => {
  const e404 = JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } });
  assert.deepEqual(parseView(e404, 1), { kind: 'absent' });
  // An E404 object with exit 0 is not a shape npm produces — not trusted.
  assert.equal(parseView(e404, 0).kind, 'error');
});

test('npm view: every other failure is an error, never "absent" and never "published"', () => {
  const cases: [string, number][] = [
    [
      JSON.stringify({
        error: { code: 'ECONNREFUSED', summary: 'connect ECONNREFUSED' },
      }),
      1,
    ],
    [JSON.stringify({ error: { code: 'E500' } }), 1],
    [JSON.stringify({ error: {} }), 1],
    ['', 0], // older npm: silence for a version it could not find
    ['', 1],
    ['npm error code ETIMEDOUT', 1],
    ['[]', 0],
    [JSON.stringify([{ version: '1.2.3' }, { version: '1.2.4' }]), 0],
    ['"1.2.3"', 0],
    [JSON.stringify({ version: '1.2.3' }), 1],
  ];
  for (const [stdout, code] of cases) {
    assert.equal(
      parseView(stdout, code).kind,
      'error',
      `${stdout} / exit ${String(code)}`,
    );
  }
  const detail = parseView(
    JSON.stringify({ error: { code: 'E503', summary: 'down' } }),
    1,
  );
  assert.deepEqual(detail, { kind: 'error', detail: 'npm view failed with E503: down' });
});

// ---------------------------------------------------------------------------
// identity: version and gitHead
// ---------------------------------------------------------------------------

test('identity: the exact version, published from this commit, passes', () => {
  assert.equal(identityProblem(published(), `${NAME}@1.2.3`, '1.2.3', HEAD), undefined);
});

test('identity: another version, a missing gitHead or another commit is refused', () => {
  const spec = `${NAME}@1.2.3`;
  assert.match(
    identityProblem(published({ version: '1.2.4' }), spec, '1.2.3', HEAD) ?? '',
    /answered version "1\.2\.4", not "1\.2\.3"/,
  );
  const noVersion = published();
  delete noVersion.version;
  assert.match(
    identityProblem(noVersion, spec, '1.2.3', HEAD) ?? '',
    /answered version null/,
  );
  const noHead = published();
  delete noHead.gitHead;
  assert.match(identityProblem(noHead, spec, '1.2.3', HEAD) ?? '', /records no gitHead/);
  assert.match(
    identityProblem(published({ gitHead: OTHER }), spec, '1.2.3', HEAD) ?? '',
    new RegExp(`published from commit ${OTHER}, but this tag is ${HEAD}`),
  );
});

// ---------------------------------------------------------------------------
// tarballs
// ---------------------------------------------------------------------------

function header(name: string, size: number, type: string, prefix = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  block.write(type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  return block;
}

function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

interface Entry {
  path: string;
  body?: string;
  type?: string;
  /** How a long path is carried: ustar prefix, PAX `x` header or GNU `L`. */
  via?: 'prefix' | 'pax' | 'gnu';
}

function tar(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { path, body = '', type = '0', via } of entries) {
    const data = Buffer.from(body, 'utf8');
    let name = path;
    let prefix = '';
    if (via === 'prefix') {
      const cut = path.lastIndexOf('/');
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    } else if (via === 'pax') {
      const record = (length: number): string => `${String(length)} path=${path}\n`;
      let length = record(0).length;
      while (record(length).length !== length) length = record(length).length;
      const pax = Buffer.from(record(length), 'utf8');
      blocks.push(header('PaxHeader', pax.length, 'x'), padded(pax));
      name = 'truncated-by-pax';
    } else if (via === 'gnu') {
      const long = Buffer.from(`${path}\0`, 'utf8');
      blocks.push(header('././@LongLink', long.length, 'L'), padded(long));
      name = 'truncated-by-gnu';
    }
    blocks.push(header(name, data.length, type, prefix), padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Over the 100-byte ustar name field; too long for the 155-byte prefix too. */
const LONG = `package/build/src/${'nested/'.repeat(24)}deep.js`;
/** Over 100 bytes, but fits the ustar prefix + name split. */
const MEDIUM = `package/build/src/${'dir/'.repeat(22)}file.js`;

test('tar: regular files by full path, however the path is carried', () => {
  const files = tarFiles(
    tar([
      { path: 'package/package.json', body: '{"name":"x"}' },
      { path: 'package/build/', type: '5' },
      { path: 'package/empty.txt' },
      { path: MEDIUM, body: 'a', via: 'prefix' },
      { path: LONG, body: 'b', via: 'pax' },
      { path: `${LONG}.map`, body: 'c', via: 'gnu' },
      { path: 'package/link', type: '2' },
    ]),
  );
  assert.deepEqual(
    [...files.keys()].sort(),
    [LONG, `${LONG}.map`, MEDIUM, 'package/empty.txt', 'package/package.json'].sort(),
  );
  assert.equal(files.get(LONG)?.length, 64);
  assert.notEqual(files.get(LONG), files.get(`${LONG}.map`));
});

test('tar: a truncated entry is an error, not a shorter file', () => {
  const whole = tar([{ path: 'package/a.js', body: 'x'.repeat(600) }]);
  assert.throws(() => tarFiles(whole.subarray(0, 512 + 100)), /truncated tar entry/);
});

test('diffFiles names added, removed and changed paths, sorted', () => {
  const expected = new Map([
    ['b', '1'],
    ['a', '1'],
    ['same', '9'],
  ]);
  const actual = new Map([
    ['a', '2'],
    ['c', '1'],
    ['same', '9'],
  ]);
  assert.deepEqual(diffFiles(expected, actual), ['a', 'b', 'c']);
  assert.deepEqual(diffFiles(expected, expected), []);
});

test('compareTarballs: identical bytes, same files under other gzip, different files', () => {
  const raw = tar([
    { path: 'package/package.json', body: '{"version":"1.2.3"}' },
    { path: 'package/build/src/index.js', body: 'export {};\n' },
  ]);
  const local = gzipSync(raw, { level: 9 });
  assert.deepEqual(compareTarballs(local, Buffer.from(local)), { kind: 'identical' });
  const recompressed = gzipSync(raw, { level: 1 });
  assert.notEqual(sri(local), sri(recompressed));
  assert.deepEqual(compareTarballs(local, recompressed), { kind: 'equivalent' });
  const tampered = gzipSync(
    tar([
      { path: 'package/package.json', body: '{"version":"1.2.3"}' },
      { path: 'package/build/src/index.js', body: 'steal();\n' },
      { path: 'package/postinstall.js', body: 'steal();\n' },
    ]),
  );
  assert.deepEqual(compareTarballs(local, tampered), {
    kind: 'different',
    paths: ['package/build/src/index.js', 'package/postinstall.js'],
  });
  assert.equal(compareTarballs(local, Buffer.from('not gzip')).kind, 'unavailable');
});

test('sri is the sha512 form npm writes into dist.integrity', () => {
  assert.equal(
    sri(Buffer.from('')),
    'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
  );
});

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

const IDENTICAL: ContentCheck = { kind: 'identical' };

test('decide: not on the registry → publish', () => {
  const decision = decide({
    name: NAME,
    version: '1.2.3',
    head: HEAD,
    view: { kind: 'absent' },
  });
  assert.equal(decision.action, 'publish');
  assert.match(decision.reason, /not on the registry \(E404\)/);
});

test('decide: a registry error neither publishes nor skips', () => {
  const decision = decide({
    name: NAME,
    version: '1.2.3',
    head: HEAD,
    view: { kind: 'error', detail: 'npm view failed with ETIMEDOUT' },
  });
  assert.equal(decision.action, 'fail');
  assert.match(decision.reason, /refusing both to publish and to skip/);
});

test('decide: published from this commit with the same bytes → skip, no warnings', () => {
  const decision = decide({
    name: NAME,
    version: '1.2.3',
    head: HEAD,
    view: published(),
    content: IDENTICAL,
  });
  assert.equal(decision.action, 'skip');
  assert.deepEqual(decision.warnings, []);
  assert.match(decision.reason, /already on the registry, published from this commit/);
  assert.match(decision.reason, /byte-identical/);
  const equivalent = decide({
    name: NAME,
    version: '1.2.3',
    head: HEAD,
    view: published(),
    content: { kind: 'equivalent' },
  });
  assert.equal(equivalent.action, 'skip');
  assert.match(equivalent.reason, /only the gzip stream differs/);
});

test('decide: identity or content that does not check out is a failure, never a skip', () => {
  const base = { name: NAME, version: '1.2.3', head: HEAD };
  const failures = [
    decide({ ...base, view: published({ gitHead: OTHER }), content: IDENTICAL }),
    decide({ ...base, view: published({ version: '1.2.4' }), content: IDENTICAL }),
    decide({ ...base, view: published() }),
    decide({
      ...base,
      view: published(),
      content: { kind: 'unavailable', detail: 'offline' },
    }),
    decide({
      ...base,
      view: published(),
      content: { kind: 'different', paths: ['package/a.js'] },
    }),
  ];
  for (const decision of failures) assert.equal(decision.action, 'fail', decision.reason);
  const many = decide({
    ...base,
    view: published(),
    content: {
      kind: 'different',
      paths: Array.from({ length: 13 }, (_, i) => `f${String(i)}`),
    },
  });
  assert.match(many.reason, /f9 and 3 more/);
});

test('decide: a skip cannot move a dist-tag, so it warns — or fails for a prerelease on latest', () => {
  const stale = decide({
    name: NAME,
    version: '1.2.3',
    head: HEAD,
    view: published({ distTags: { latest: '1.3.0' } }),
    content: IDENTICAL,
  });
  assert.equal(stale.action, 'skip');
  assert.equal(stale.warnings.length, 1);
  assert.match(stale.warnings[0] ?? '', /`latest` points at 1\.3\.0, not 1\.2\.3/);
  assert.match(stale.warnings[0] ?? '', /npm dist-tag add tiktok-mcp-ai@1\.2\.3 latest/);

  const untagged = decide({
    name: NAME,
    version: '1.3.0-rc.1',
    head: HEAD,
    view: published({ version: '1.3.0-rc.1', distTags: { latest: '1.2.3' } }),
    content: IDENTICAL,
  });
  assert.equal(untagged.action, 'skip');
  assert.match(untagged.warnings[0] ?? '', /`next` points at nothing/);

  const rcOnLatest = decide({
    name: NAME,
    version: '1.3.0-rc.1',
    head: HEAD,
    view: published({ version: '1.3.0-rc.1', distTags: { latest: '1.3.0-rc.1' } }),
    content: IDENTICAL,
  });
  assert.equal(rcOnLatest.action, 'fail');
  assert.match(rcOnLatest.reason, /prerelease and holds the `latest` dist-tag/);
});
