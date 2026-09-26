/**
 * site-sync (TESTING.md § Sync gates and repo meta).
 *
 * The gate itself only ever runs inside `npm run check`, so its logic is
 * exercised here as plain functions and against throwaway fixture trees. The
 * fixtures are the point: the gate has to fail on a drifted site, and a test
 * that only ever saw the committed (correct) tree would pass forever while the
 * detection logic quietly rotted.
 *
 * The fixture page is deliberately awkward — markup-shaped strings inside a
 * `<script>`, a CSS `url()`, an unquoted attribute, a single-quoted attribute,
 * a Prettier-wrapped multi-line `<meta>`, a `data:` favicon and prose in a
 * `content=` — because every one of those has a plausible naive check that it
 * breaks.
 *
 * The last group does read the committed `site/`, which is what turns a real
 * drift — a forgotten version bump, a moved asset — into a red suite rather
 * than a 404 in production.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { asRecord, asString, REPO_ROOT } from '../scripts/lib/repo.js';
import {
  attributesOf,
  canonicalBase,
  checkSite,
  idsOf,
  labelFor,
  pagesUrlFor,
  pageUrl,
  readSiteInputs,
  referencesFrom,
  repairSoftwareVersion,
  resolveReference,
  robotsSitemaps,
  sitemapLocations,
  softwareApplication,
  stripEmbeddedBodies,
  syncSite,
  tagsOf,
  type SiteInputs,
  type SitePage,
} from '../scripts/site-sync.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BASE = 'https://example-owner.github.io/example-repo/';
const REPOSITORY = 'git+https://github.com/Example-Owner/example-repo.git';
const VERSION = '1.2.3';

/** An inline SVG favicon: a reference that is not a file and never was. */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3C/svg%3E";

interface IndexOptions {
  canonical?: string;
  ogUrl?: string;
  ogImage?: string;
  ldUrl?: string;
  version?: string;
  body?: string;
}

function indexHtml(options: IndexOptions = {}): string {
  const canonical = options.canonical ?? BASE;
  const ogUrl = options.ogUrl ?? BASE;
  const ogImage = options.ogImage ?? `${BASE}assets/og-image.png`;
  const ldUrl = options.ldUrl ?? BASE;
  const version = options.version ?? VERSION;
  return `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" href="${FAVICON}" />
    <link rel="canonical" href="${canonical}" />
    <meta
      property="og:url"
      content="${ogUrl}"
    />
    <meta property="og:image" content="${ogImage}" />
    <meta name="twitter:image" content="${ogImage}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel='stylesheet' href='assets/styles.css' />
    <style>
      .hero { background: url("assets/never-scanned.png"); }
    </style>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", "url": "${BASE}" },
          {
            "@type": "SoftwareApplication",
            "name": "Example",
            "url": "${ldUrl}",
            "softwareVersion": "${version}",
            "downloadUrl": "https://www.npmjs.com/package/tiktok-mcp-ai"
          }
        ]
      }
    </script>
  </head>
  <body id="top">
    <a href="#security">Security</a>
    <section id="security">
      <a href="https://marketplace.visualstudio.com/items?itemName=ivanbbaev.tiktok-mcp-ai">
        VS Code
      </a>
      <a href="privacy.html#data">Privacy</a>
      <a href="mailto:hello@example.com">Mail</a>
      <a href="#">Back to top</a>
    </section>
    ${options.body ?? ''}
    <script src=assets/app.js></script>
    <script>
      const markup = "<b href=nope.png>";
      if (1 < 2 && 3 > 2) console.log(markup);
    </script>
  </body>
</html>
`;
}

function privacyHtml(canonical: string = `${BASE}privacy.html`): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" href="${FAVICON}" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${BASE}assets/og-image.png" />
    <link rel="stylesheet" href="assets/styles.css" />
  </head>
  <body>
    <a href="index.html#security">Security</a>
    <section id="data">Data</section>
  </body>
</html>
`;
}

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE}</loc>
    <lastmod>2026-08-29</lastmod>
  </url>
  <url>
    <loc>${BASE}privacy.html</loc>
  </url>
</urlset>
`;

const ROBOTS = `User-agent: *\nAllow: /\n\nSitemap: ${BASE}sitemap.xml\n`;

const FILES = new Set([
  'index.html',
  'privacy.html',
  'robots.txt',
  'sitemap.xml',
  'assets/app.js',
  'assets/styles.css',
  'assets/og-image.png',
]);

function inputs(overrides: Partial<SiteInputs> = {}): SiteInputs {
  return {
    pages: [
      { path: 'index.html', html: indexHtml() },
      { path: 'privacy.html', html: privacyHtml() },
    ],
    sitemap: SITEMAP,
    robots: ROBOTS,
    version: VERSION,
    homepage: BASE,
    extensionHomepage: BASE,
    repositoryUrl: REPOSITORY,
    files: FILES,
    ...overrides,
  };
}

/** Replace one page's HTML, leaving the rest of the site alone. */
function withPage(path: string, html: string): Partial<SiteInputs> {
  const pages: SitePage[] = inputs().pages.map((page) =>
    page.path === path ? { path, html } : page,
  );
  return { pages };
}

// ---------------------------------------------------------------------------
// HTML scanning
// ---------------------------------------------------------------------------

test('embedded script and style bodies are dropped, their opening tags kept', () => {
  const stripped = stripEmbeddedBodies(indexHtml());
  assert.ok(stripped.includes('<script src=assets/app.js>'));
  assert.ok(!stripped.includes('nope.png'));
  assert.ok(!stripped.includes('never-scanned.png'));
});

test('attributes are read in any order and in all three quoting styles', () => {
  const attributes = attributesOf(`href='a.css' rel=stylesheet data-x="1"`);
  assert.equal(attributes.get('href'), 'a.css');
  assert.equal(attributes.get('rel'), 'stylesheet');
  assert.equal(attributes.get('data-x'), '1');
});

test('markup-shaped text inside a script is never scanned as a tag', () => {
  const tags = tagsOf(indexHtml());
  assert.ok(!tags.some((tag) => tag.attributes.get('href') === 'nope.png'));
  assert.ok(tags.some((tag) => tag.name === 'script'));
});

test('ids are collected from the page for fragment checking', () => {
  const ids = idsOf(tagsOf(indexHtml()));
  assert.deepEqual([...ids].sort(), ['security', 'top']);
});

test('a multi-line meta tag is still matched', () => {
  const tags = tagsOf(indexHtml());
  const ogUrl = tags.find((tag) => tag.attributes.get('property') === 'og:url');
  assert.equal(ogUrl?.attributes.get('content'), BASE);
});

test('the JSON-LD is parsed, and the node is found through @graph', () => {
  const application = softwareApplication(indexHtml());
  assert.equal(asString(application?.['softwareVersion']), VERSION);
});

test('a malformed JSON-LD block yields no node rather than throwing', () => {
  const html = `<script type="application/ld+json">{ nope </script>`;
  assert.equal(softwareApplication(html), undefined);
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

test('references cover href, src and URL-bearing meta, but not prose content', () => {
  const values = referencesFrom('index.html', tagsOf(indexHtml())).map(
    (reference) => reference.value,
  );
  assert.ok(values.includes('assets/styles.css'));
  assert.ok(values.includes('assets/app.js'));
  assert.ok(values.includes(`${BASE}assets/og-image.png`));
  assert.ok(!values.includes('width=device-width, initial-scale=1'));
});

test('a reference label names the page, the element and the attribute', () => {
  const canonical = tagsOf(indexHtml()).find(
    (tag) => tag.attributes.get('rel') === 'canonical',
  );
  assert.ok(canonical !== undefined);
  assert.equal(
    labelFor('privacy.html', canonical, 'href'),
    'site/privacy.html <link rel="canonical" href>',
  );
});

test('sitemap and robots references are extracted', () => {
  assert.deepEqual(
    sitemapLocations(SITEMAP).map((location) => location.value),
    [BASE, `${BASE}privacy.html`],
  );
  assert.deepEqual(
    robotsSitemaps(ROBOTS).map((line) => line.value),
    [`${BASE}sitemap.xml`],
  );
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('a reference that cannot name a file is skipped, not reported', () => {
  for (const value of [FAVICON, 'mailto:hello@example.com', '#', '   ']) {
    assert.equal(resolveReference(value, BASE), undefined, value.slice(0, 24));
  }
});

test('same-origin references resolve to a path under site/', () => {
  assert.deepEqual(resolveReference('assets/app.js', BASE), {
    kind: 'local',
    path: 'assets/app.js',
    fragment: '',
  });
  assert.deepEqual(resolveReference(BASE, BASE), {
    kind: 'local',
    path: 'index.html',
    fragment: '',
  });
  assert.deepEqual(resolveReference(`${BASE}privacy.html#data`, BASE), {
    kind: 'local',
    path: 'privacy.html',
    fragment: 'data',
  });
});

test('a bare fragment resolves against the page it was found on', () => {
  assert.deepEqual(resolveReference('#data', BASE, 'privacy.html'), {
    kind: 'local',
    path: 'privacy.html',
    fragment: 'data',
  });
});

test('a same-host URL outside the base is off-base, not local', () => {
  assert.deepEqual(
    resolveReference('https://example-owner.github.io/other-repo/', BASE),
    {
      kind: 'off-base',
    },
  );
});

/**
 * The bug this gate exists to catch, and the bug a careless fix would create.
 * `tiktok-mcp` is the repo slug and `tiktok-mcp-ai` is the npm package; both
 * strings legitimately appear on the site. A substring rule on the package name
 * would flag two correct links, and a substring rule on the repo slug would
 * accept `…github.io/tiktok-mcp-ai/`, which 404s. Only host plus path prefix
 * separates them — note the trailing slash on the base doing that work.
 */
test('the package name is not the repo slug: host and path decide, not substrings', () => {
  const real = 'https://ivanbbaev.github.io/tiktok-mcp/';
  for (const external of [
    'https://www.npmjs.com/package/tiktok-mcp-ai',
    'https://marketplace.visualstudio.com/items?itemName=ivanbbaev.tiktok-mcp-ai',
    'https://github.com/IvanBBaev/tiktok-mcp',
  ]) {
    assert.deepEqual(resolveReference(external, real), { kind: 'external' }, external);
  }
  assert.deepEqual(resolveReference('https://ivanbbaev.github.io/tiktok-mcp-ai/', real), {
    kind: 'off-base',
  });
});

// ---------------------------------------------------------------------------
// The canonical base and its witnesses
// ---------------------------------------------------------------------------

test('the Pages URL is derived from the repository slug', () => {
  assert.equal(pagesUrlFor(REPOSITORY), BASE);
  assert.equal(pagesUrlFor('https://gitlab.com/o/r'), undefined);
  assert.equal(pagesUrlFor(undefined), undefined);
});

test('the base comes from the plugin manifest homepage', () => {
  assert.deepEqual(canonicalBase(inputs()), { base: BASE, problems: [] });
});

test('a homepage without a trailing slash is named as such, and still usable', () => {
  const result = canonicalBase(inputs({ homepage: BASE.slice(0, -1) }));
  assert.equal(result.base, BASE);
  assert.match(result.problems.join('\n'), /trailing slash/);
});

test('the source of truth is held to its two witnesses', () => {
  assert.match(
    canonicalBase(
      inputs({ repositoryUrl: 'https://github.com/Example-Owner/other' }),
    ).problems.join('\n'),
    /repository\.url.*other/s,
  );
  assert.match(
    canonicalBase(inputs({ extensionHomepage: 'https://example.com/' })).problems.join(
      '\n',
    ),
    /extension\/package\.json/,
  );
});

test('without a homepage the gate says so and checks nothing else', () => {
  const result = canonicalBase(inputs({ homepage: undefined }));
  assert.equal(result.base, undefined);
  assert.match(result.problems.join('\n'), /\.claude-plugin\/plugin\.json.*homepage/);
  assert.equal(checkSite(inputs({ homepage: undefined })).length, 1);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a consistent site passes', () => {
  assert.deepEqual(checkSite(inputs()), []);
});

test('an inline data: favicon is not reported as a dangling asset', () => {
  const reported = checkSite(inputs()).join('\n');
  assert.ok(!reported.includes('data:image/svg+xml'));
  // And it is genuinely present in what the gate scanned, not absent by luck.
  const values = referencesFrom('index.html', tagsOf(indexHtml())).map(
    (reference) => reference.value,
  );
  assert.ok(values.includes(FAVICON));
});

test('external links are never resolved against the site tree', () => {
  const problems = checkSite(
    inputs(
      withPage('index.html', indexHtml({ body: '<a href="https://x.example/a">x</a>' })),
    ),
  );
  assert.deepEqual(problems, []);
});

const FAILURES: readonly [string, Partial<SiteInputs>, RegExp][] = [
  [
    'the JSON-LD version lags the package version',
    withPage('index.html', indexHtml({ version: '0.0.0' })),
    /softwareVersion" is "0\.0\.0".*"version" is "1\.2\.3"/s,
  ],
  [
    'a canonical link points at the wrong URL',
    withPage('index.html', indexHtml({ canonical: 'https://example.com/' })),
    /index\.html <link rel="canonical" href>.*must be "https:\/\/example-owner/s,
  ],
  [
    'a sub-page canonical points at the site root instead of the page',
    withPage('privacy.html', privacyHtml(BASE)),
    /site\/privacy\.html <link rel="canonical" href>.*privacy\.html/s,
  ],
  [
    'og:url disagrees with the canonical link',
    withPage('index.html', indexHtml({ ogUrl: `${BASE}index.html` })),
    /<meta property="og:url" content>/,
  ],
  [
    'the JSON-LD url disagrees with the base',
    withPage('index.html', indexHtml({ ldUrl: 'https://example-owner.github.io/' })),
    /SoftwareApplication\.url/,
  ],
  [
    'robots.txt advertises a sitemap on the old URL',
    { robots: `Sitemap: https://example-owner.github.io/example-repo-ai/sitemap.xml\n` },
    /robots\.txt Sitemap line.*must be/s,
  ],
  [
    'robots.txt has no sitemap line at all',
    { robots: 'User-agent: *\nAllow: /\n' },
    /robots\.txt: no "Sitemap:" line/,
  ],
  [
    'a page is missing from the sitemap',
    {
      sitemap: SITEMAP.replace(
        / {2}<url>\n {4}<loc>[^<]*privacy\.html<\/loc>\n {2}<\/url>\n/,
        '',
      ),
    },
    /sitemap\.xml: no <loc> for site\/privacy\.html/,
  ],
  [
    'a sitemap entry points outside the canonical base',
    {
      sitemap: SITEMAP.replace(
        `${BASE}privacy.html`,
        'https://example-owner.github.io/elsewhere/privacy.html',
      ),
    },
    /outside "https:\/\/example-owner\.github\.io\/example-repo\/"/,
  ],
  [
    'the Open Graph image is referenced but was never added',
    { files: new Set([...FILES].filter((file) => file !== 'assets/og-image.png')) },
    /og-image\.png, which does not exist/,
  ],
  [
    'a link points at a fragment that no element carries',
    withPage('index.html', indexHtml({ body: '<a href="privacy.html#missing">p</a>' })),
    /#missing.*no element in site\/privacy\.html has that id/s,
  ],
  [
    'a same-page anchor points at a missing id',
    withPage('index.html', indexHtml({ body: '<a href="#gone">g</a>' })),
    /#gone.*site\/index\.html/s,
  ],
  [
    'a page declares no canonical link at all',
    withPage('privacy.html', privacyHtml().replace(/<link rel="canonical"[^>]*>/, '')),
    /privacy\.html: no <link rel="canonical">/,
  ],
  [
    'no page carries a SoftwareApplication node',
    { pages: [{ path: 'index.html', html: privacyHtml(BASE) }] },
    /no JSON-LD "SoftwareApplication" node/,
  ],
];

for (const [label, overrides, expected] of FAILURES) {
  test(`the gate fails when ${label}`, () => {
    const problems = checkSite(inputs(overrides));
    assert.notDeepEqual(problems, []);
    assert.match(problems.join('\n'), expected);
  });
}

test('one defect is reported once, not once per check that noticed it', () => {
  const problems = checkSite(
    inputs(withPage('index.html', indexHtml({ canonical: 'https://example.com/' }))),
  );
  const canonicalLines = problems.filter((problem) =>
    problem.includes('<link rel="canonical" href>'),
  );
  assert.equal(canonicalLines.length, 1);
});

test('every failure names the file it is about', () => {
  for (const [label, overrides] of FAILURES) {
    for (const problem of checkSite(inputs(overrides))) {
      assert.match(problem, /(site\/|package\.json|plugin\.json)/, label);
    }
  }
});

// ---------------------------------------------------------------------------
// The one repair
// ---------------------------------------------------------------------------

test('the softwareVersion is spliced in place, leaving the prose untouched', () => {
  const before = indexHtml({ version: '0.0.0' });
  const after = repairSoftwareVersion(before, VERSION);
  assert.ok(after !== undefined);
  assert.equal(asString(softwareApplication(after)?.['softwareVersion']), VERSION);
  assert.equal(
    after.replace(`"softwareVersion": "${VERSION}"`, '"softwareVersion": "0.0.0"'),
    before,
  );
});

test('the repair is idempotent', () => {
  const html = indexHtml();
  assert.equal(repairSoftwareVersion(html, VERSION), html);
});

test('an ambiguous repair is refused rather than guessed', () => {
  const twice = indexHtml().replace(
    '"softwareVersion": "1.2.3"',
    '"softwareVersion": "1.2.3", "alt": { "softwareVersion": "9.9.9" }',
  );
  assert.equal(repairSoftwareVersion(twice, '2.0.0'), undefined);
  // A version string outside any JSON-LD block is prose, and is not touched.
  const prose = `<p>"softwareVersion": "0.0.0"</p>`;
  assert.equal(repairSoftwareVersion(prose, '2.0.0'), undefined);
});

// ---------------------------------------------------------------------------
// End to end, against a throwaway tree
// ---------------------------------------------------------------------------

interface AfterHook {
  after: (fn: () => Promise<void>) => void;
}

async function fixture(
  t: AfterHook,
  overrides: { index?: string; sitemap?: string; robots?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'site-sync-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'site', 'assets'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'extension'), { recursive: true });
  const write = (rel: string, body: string): Promise<void> =>
    writeFile(join(root, rel), body, 'utf8');
  await Promise.all([
    write('site/index.html', overrides.index ?? indexHtml()),
    write('site/privacy.html', privacyHtml()),
    write('site/sitemap.xml', overrides.sitemap ?? SITEMAP),
    write('site/robots.txt', overrides.robots ?? ROBOTS),
    write('site/assets/app.js', '// app\n'),
    write('site/assets/styles.css', 'body { color: #000; }\n'),
    write('site/assets/og-image.png', 'png\n'),
    write(
      'package.json',
      JSON.stringify({ version: VERSION, repository: { url: REPOSITORY } }),
    ),
    write('.claude-plugin/plugin.json', JSON.stringify({ homepage: BASE })),
    write('extension/package.json', JSON.stringify({ homepage: BASE })),
  ]);
  return root;
}

test('a correct tree passes in both modes and is left byte-identical', async (t) => {
  const root = await fixture(t);
  const before = await readFile(join(root, 'site/index.html'), 'utf8');
  assert.equal(await syncSite(true, root), true);
  assert.equal(await syncSite(false, root), true);
  assert.equal(await readFile(join(root, 'site/index.html'), 'utf8'), before);
});

test('--write repairs the version drift the check reports', async (t) => {
  const root = await fixture(t, { index: indexHtml({ version: '0.0.0' }) });
  assert.equal(await syncSite(true, root), false);
  assert.equal(await syncSite(false, root), true);
  const repaired = await readFile(join(root, 'site/index.html'), 'utf8');
  assert.equal(asString(softwareApplication(repaired)?.['softwareVersion']), VERSION);
  assert.equal(await syncSite(true, root), true);
});

test('--write does not paper over a wrong URL', async (t) => {
  const robots = `Sitemap: ${BASE}sitemap.xm\n`;
  const root = await fixture(t, { robots });
  assert.equal(await syncSite(false, root), false);
  assert.equal(await readFile(join(root, 'site/robots.txt'), 'utf8'), robots);
});

test('a missing site/ fails rather than passing vacuously', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'site-sync-empty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await syncSite(true, root), false);
});

test('readSiteInputs finds every page and every shipped file', async (t) => {
  const root = await fixture(t);
  const read = await readSiteInputs(root);
  assert.deepEqual(
    read?.pages.map((page) => page.path),
    ['index.html', 'privacy.html'],
  );
  assert.ok(read?.files.has('assets/og-image.png'));
  assert.equal(read?.version, VERSION);
});

test('a page URL is the base for index.html and base plus path otherwise', () => {
  assert.equal(pageUrl(BASE, 'index.html'), BASE);
  assert.equal(pageUrl(BASE, 'privacy.html'), `${BASE}privacy.html`);
});

// ---------------------------------------------------------------------------
// The committed tree
// ---------------------------------------------------------------------------

test('the plugin manifest still carries the Pages URL this gate derives from', async () => {
  const read = await readSiteInputs(REPO_ROOT);
  assert.ok(read !== undefined);
  assert.equal(read.homepage, pagesUrlFor(read.repositoryUrl));
});

test('the committed site/ passes its own gate', async () => {
  const read = await readSiteInputs(REPO_ROOT);
  assert.ok(read !== undefined);
  assert.deepEqual(checkSite(read), []);
});

test('the committed site/ links to npm without claiming npm is the site', async () => {
  const read = await readSiteInputs(REPO_ROOT);
  const index = read?.pages.find((page) => page.path === 'index.html');
  assert.ok(index !== undefined);
  const application = softwareApplication(index.html);
  const download = asString(application?.['downloadUrl']) ?? '';
  // The package name and the repo slug differ on purpose; the gate must call
  // this correct link external rather than "fixing" it into the site's origin.
  assert.match(download, /tiktok-mcp-ai/);
  assert.deepEqual(resolveReference(download, read?.homepage ?? BASE), {
    kind: 'external',
  });
  assert.equal(asString(asRecord(application)?.['url']), read?.homepage);
});
