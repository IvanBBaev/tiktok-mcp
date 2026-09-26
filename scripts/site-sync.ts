/**
 * site-sync (TESTING.md § Sync gates and repo meta).
 *
 * `site/` is a hand-written GitHub Pages site that restates three facts it does
 * not own: the released version, the URL the site is served from, and the set of
 * files it ships. Nothing recomputed any of them, and all three had already
 * drifted by 0.7.0 — the JSON-LD still advertised `softwareVersion: "0.0.0"`,
 * `sitemap.xml` and `robots.txt` pointed at `…/tiktok-mcp-ai/` (the npm package
 * name, not the repo slug, so a 404), and the Open Graph image was referenced
 * four times without ever existing. None of those break a test, none of them are
 * visible in a diff review, and all of them are only observable in production.
 *
 * The canonical base URL is taken from `.claude-plugin/plugin.json` `homepage`,
 * which already carries exactly `https://ivanbbaev.github.io/tiktok-mcp/`. It is
 * a repo-root manifest rather than a sub-package's, and — unlike `package.json`
 * `homepage`, which points at the README anchor — it means the Pages site. That
 * one field is then held to two independent witnesses so the "source of truth"
 * cannot itself rot: the slug in `package.json` `repository.url`, which is what
 * actually determines the Pages URL, and `extension/package.json` `homepage`,
 * the only other copy of the string in the repo.
 *
 * The comparison is on URL origin and path, never on a substring. `tiktok-mcp`
 * is the repo and `tiktok-mcp-ai` is the npm package, and the site legitimately
 * links to both — `https://www.npmjs.com/package/tiktok-mcp-ai` and the VS Code
 * marketplace `itemName=ivanbbaev.tiktok-mcp-ai` are correct strings that a
 * substring rule would "fix" into 404s. Only URLs on the site's own origin are
 * this gate's business; everything else is classified external and dropped.
 *
 * Unlike the generated artifacts, the pages are hand-authored prose, so this
 * gate never regenerates them. `--write` performs exactly one surgical repair —
 * the JSON-LD `softwareVersion` — because that is the only value whose correct
 * content is unambiguously derivable. A wrong URL might be the URL that is wrong
 * or the manifest that is wrong, and a missing asset cannot be conjured by a
 * script at all; both are reported for a human to settle.
 *
 * Deliberately NOT checked here, so the gate's silence is not read as more than
 * it is:
 *  - HTML validity, accessibility, or anything about the rendered page;
 *  - external links — a gate that resolved `https://github.com/…` over the
 *    network would fail on a bad DNS day and teach people to ignore it. Nothing
 *    in this file opens a socket;
 *  - `<lastmod>` freshness in the sitemap, which is editorial;
 *  - assets referenced from CSS or JS rather than from the HTML.
 *
 * Usage: `node build/scripts/site-sync.js [--write]`
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { asRecord, asString, REPO_ROOT } from './lib/repo.js';

const SITE_DIR = 'site';
const INDEX = 'index.html';
const SITEMAP = 'site/sitemap.xml';
const ROBOTS = 'site/robots.txt';
const PACKAGE_JSON = 'package.json';
const PLUGIN_JSON = '.claude-plugin/plugin.json';
const EXTENSION_JSON = 'extension/package.json';

// ---------------------------------------------------------------------------
// HTML scanning
//
// This is a focused regex scan, not an HTML parser, and it is deliberate: the
// repo ships no HTML parser and adding one to verify four attributes would be a
// dependency with a supply chain. The scan is made safe rather than clever —
// `<script>`/`<style>` bodies are removed first so no JavaScript operator is
// ever mistaken for markup, attributes are matched by name in any order and in
// any of the three quoting styles, and every value is then handed to `URL` or
// `JSON.parse` rather than being interpreted by a second regex.
// ---------------------------------------------------------------------------

/** Remove `<script>`/`<style>` bodies, keeping their opening tags. */
export function stripEmbeddedBodies(html: string): string {
  return html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2\s*>/gi, '$1');
}

/** Attribute-order- and quote-style-agnostic: `a="x"`, `a='x'` and `a=x`. */
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

export function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

export interface ScannedTag {
  name: string;
  attributes: Map<string, string>;
}

/** `[^>]*` spans newlines, so a Prettier-wrapped multi-line tag still matches. */
const TAG = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;

export function tagsOf(html: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  for (const match of stripEmbeddedBodies(html).matchAll(TAG)) {
    tags.push({
      name: (match[1] ?? '').toLowerCase(),
      attributes: attributesOf(match[2] ?? ''),
    });
  }
  return tags;
}

/** Every `id` a fragment link could legitimately target. */
export function idsOf(tags: readonly ScannedTag[]): Set<string> {
  const ids = new Set<string>();
  for (const tag of tags) {
    const id = tag.attributes.get('id');
    if (id !== undefined && id !== '') ids.add(id);
  }
  return ids;
}

/** The first tag matching `name` whose `key` attribute equals `value`. */
function findTag(
  tags: readonly ScannedTag[],
  name: string,
  key: string,
  value: string,
): ScannedTag | undefined {
  return tags.find(
    (tag) => tag.name === name && (tag.attributes.get(key) ?? '').toLowerCase() === value,
  );
}

/** `<meta property="og:url">`, whichever of `property`/`name` carries the key. */
function metaTag(tags: readonly ScannedTag[], key: string): ScannedTag | undefined {
  return findTag(tags, 'meta', 'property', key) ?? findTag(tags, 'meta', 'name', key);
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

const LD_JSON =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Every `application/ld+json` body, with its offset in the original HTML. */
function ldBlocks(html: string): { body: string; start: number }[] {
  const blocks: { body: string; start: number }[] = [];
  for (const match of html.matchAll(LD_JSON)) {
    const body = match[1];
    if (body === undefined || match.index === undefined) continue;
    blocks.push({ body, start: match.index + match[0].indexOf(body) });
  }
  return blocks;
}

/** Flatten a JSON-LD document into its nodes, following `@graph`. */
function ldNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(ldNodes);
  const record = asRecord(value);
  if (record === undefined) return [];
  return [record, ...ldNodes(record['@graph'])];
}

/**
 * The `SoftwareApplication` node, parsed as JSON rather than pattern-matched.
 * A regex over the version number would keep passing the day the field moves
 * into a different node, which is precisely when it stops being true.
 */
export function softwareApplication(html: string): Record<string, unknown> | undefined {
  for (const block of ldBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.body);
    } catch {
      continue;
    }
    for (const node of ldNodes(parsed)) {
      if (node['@type'] === 'SoftwareApplication') return node;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Meta tags whose `content` is a URL. Every other `content` is prose. */
const URL_META = new Set([
  'og:url',
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:url',
]);

export interface Reference {
  /** File and element, for the failure message. */
  where: string;
  value: string;
}

/**
 * A stable name for one attribute of one tag. The identity checks below build
 * the same string for the slots they own, so a defect they already named is
 * recognised — and skipped — by the generic scan rather than reported twice.
 */
export function labelFor(page: string, tag: ScannedTag, attribute: string): string {
  for (const key of ['rel', 'property', 'name']) {
    const value = tag.attributes.get(key);
    if (value !== undefined)
      return `${SITE_DIR}/${page} <${tag.name} ${key}="${value}" ${attribute}>`;
  }
  return `${SITE_DIR}/${page} <${tag.name} ${attribute}>`;
}

/** Every URL-bearing attribute of one page's tags. */
export function referencesFrom(page: string, tags: readonly ScannedTag[]): Reference[] {
  const references: Reference[] = [];
  for (const tag of tags) {
    for (const attribute of ['href', 'src']) {
      const value = tag.attributes.get(attribute);
      if (value !== undefined)
        references.push({ where: labelFor(page, tag, attribute), value });
    }
    if (tag.name !== 'meta') continue;
    const key = tag.attributes.get('property') ?? tag.attributes.get('name') ?? '';
    const content = tag.attributes.get('content');
    if (content !== undefined && URL_META.has(key.toLowerCase())) {
      references.push({ where: labelFor(page, tag, 'content'), value: content });
    }
  }
  return references;
}

export function sitemapLocations(sitemap: string): Reference[] {
  return [...sitemap.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) => ({
    where: `${SITEMAP} <loc>`,
    value: (match[1] ?? '').trim(),
  }));
}

export function robotsSitemaps(robots: string): Reference[] {
  return [...robots.matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)[ \t]*$/gim)].map(
    (match) => ({
      where: `${ROBOTS} Sitemap line`,
      value: match[1] ?? '',
    }),
  );
}

type Resolved =
  | { kind: 'external' }
  /** Same host as the site, but outside the canonical base — the 404 case. */
  | { kind: 'off-base' }
  /** Same origin and under the base: a path that must exist under `site/`. */
  | { kind: 'local'; path: string; fragment: string };

/**
 * Classify one reference against the canonical base. Anything that is not an
 * `http(s)` URL under the site's own host is not this gate's business and is
 * never fetched, resolved or reported: a bare `#fragment`, a `data:` URI (the
 * favicons are inline SVG data URIs, not files), a `mailto:`, an external link.
 */
export function resolveReference(
  value: string,
  base: string,
  from: string = INDEX,
): Resolved | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '#') return undefined;
  let url: URL;
  let root: URL;
  try {
    root = new URL(base);
    // A same-page `#id` resolves against the page it was found on, so the
    // fragment check below knows which document must contain the target.
    url = new URL(trimmed, new URL(from, base));
  } catch {
    return undefined;
  }
  // `data:` and `mailto:` land here; only the web protocols name a site file.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  // Origin, then path prefix — never a substring. The trailing slash on the
  // base is load-bearing: `/tiktok-mcp-ai/` does not start with `/tiktok-mcp/`.
  if (url.origin !== root.origin) return { kind: 'external' };
  if (!url.pathname.startsWith(root.pathname)) return { kind: 'off-base' };
  let path = decodeURIComponent(url.pathname.slice(root.pathname.length));
  // A directory URL is served by its index document; `…/tiktok-mcp/` is the
  // site root, which is `site/index.html`.
  if (path === '' || path.endsWith('/')) path += INDEX;
  return { kind: 'local', path, fragment: decodeURIComponent(url.hash.slice(1)) };
}

// ---------------------------------------------------------------------------
// Canonical base
// ---------------------------------------------------------------------------

/** `git+https://github.com/O/R.git` → the Pages URL GitHub will serve it at. */
export function pagesUrlFor(repositoryUrl: string | undefined): string | undefined {
  if (repositoryUrl === undefined) return undefined;
  const normalized = repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com') return undefined;
  const [owner, repo] = url.pathname.replace(/^\//, '').split('/');
  if (owner === undefined || repo === undefined || repo === '') return undefined;
  return `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

/** One HTML page of the site, keyed by its `/`-separated path under `site/`. */
export interface SitePage {
  path: string;
  html: string;
}

export interface SiteInputs {
  /** Every `*.html` under `site/`. */
  pages: readonly SitePage[];
  sitemap: string;
  robots: string;
  /** `package.json` version — the release the site must advertise. */
  version: string | undefined;
  /** `.claude-plugin/plugin.json` homepage — the canonical base. */
  homepage: string | undefined;
  /** `extension/package.json` homepage — a witness, not the source. */
  extensionHomepage: string | undefined;
  /** `package.json` repository.url — the slug Pages actually serves from. */
  repositoryUrl: string | undefined;
  /** Paths under `site/`, `/`-separated. */
  files: ReadonlySet<string>;
}

/**
 * The one base every self-referencing URL must use, plus any complaint about
 * the source of truth itself. The homepage field decides; the two witnesses
 * exist so the field cannot quietly become wrong.
 */
export function canonicalBase(inputs: SiteInputs): {
  base: string | undefined;
  problems: string[];
} {
  const problems: string[] = [];
  const { homepage } = inputs;
  if (homepage === undefined || homepage === '') {
    problems.push(
      `${PLUGIN_JSON}: no "homepage" — this gate derives the site's canonical URL from it. ` +
        `Set it to the GitHub Pages URL of this repo (…/OWNER.github.io/REPO/).`,
    );
    return { base: undefined, problems };
  }
  const base = homepage.endsWith('/') ? homepage : `${homepage}/`;
  if (base !== homepage) {
    problems.push(
      `${PLUGIN_JSON}: "homepage" is "${homepage}" — add the trailing slash ("${base}"), ` +
        `so it names the site root rather than a page.`,
    );
  }
  const derived = pagesUrlFor(inputs.repositoryUrl);
  if (derived !== undefined && derived !== base) {
    problems.push(
      `${PLUGIN_JSON}: "homepage" is "${base}" but ${PACKAGE_JSON} "repository.url" ` +
        `puts GitHub Pages at "${derived}". One of the two is wrong — the repo slug decides.`,
    );
  }
  const { extensionHomepage } = inputs;
  if (extensionHomepage !== undefined && extensionHomepage !== base) {
    problems.push(
      `${EXTENSION_JSON}: "homepage" is "${extensionHomepage}", ` +
        `but ${PLUGIN_JSON} says the site is at "${base}". Make them the same string.`,
    );
  }
  return { base, problems };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The absolute URL a page is served at. */
export function pageUrl(base: string, path: string): string {
  return path === INDEX ? base : base + path;
}

interface ScannedPage extends SitePage {
  tags: ScannedTag[];
  ids: Set<string>;
}

/** Every problem, one line each, in the order a reader would fix them. */
export function checkSite(inputs: SiteInputs): string[] {
  const problems: string[] = [];
  const { base, problems: baseProblems } = canonicalBase(inputs);
  problems.push(...baseProblems);
  if (base === undefined) return problems;

  const pages: ScannedPage[] = inputs.pages.map((page) => {
    const tags = tagsOf(page.html);
    return { ...page, tags, ids: idsOf(tags) };
  });
  if (!pages.some((page) => page.path === INDEX)) {
    problems.push(
      `${SITE_DIR}/: no ${INDEX} — the site root has nothing to serve at "${base}".`,
    );
  }

  // 1. Version. The JSON-LD is the site's machine-readable claim about which
  //    release it documents, and it is the one value `--write` can repair.
  const carriers = pages.filter((page) => softwareApplication(page.html) !== undefined);
  if (carriers.length === 0) {
    problems.push(
      `${SITE_DIR}/: no JSON-LD "SoftwareApplication" node in any page — nothing states ` +
        `which release the site documents. Add one to ${SITE_DIR}/${INDEX}.`,
    );
  }
  for (const page of carriers) {
    const application = softwareApplication(page.html) ?? {};
    const advertised = asString(application['softwareVersion']);
    if (advertised !== inputs.version) {
      problems.push(
        `${SITE_DIR}/${page.path}: JSON-LD "softwareVersion" is ${JSON.stringify(advertised)} ` +
          `but ${PACKAGE_JSON} "version" is ${JSON.stringify(inputs.version)}. ` +
          `Run \`npm run sync:write\` to correct it.`,
      );
    }
  }

  // 2. Identity. Every slot that names the site itself must name it the same
  //    way; `reported` keeps the generic scan below from repeating a line.
  const reported = new Set<string>();
  const expect = (where: string, actual: string, wanted: string): void => {
    if (actual === wanted) return;
    reported.add(where);
    problems.push(
      `${where}: is "${actual}" but must be "${wanted}" — every absolute URL the site ` +
        `uses for itself has to be the one canonical base from ${PLUGIN_JSON}.`,
    );
  };

  for (const page of pages) {
    const self = pageUrl(base, page.path);
    const canonical = findTag(page.tags, 'link', 'rel', 'canonical');
    if (canonical === undefined) {
      problems.push(
        `${SITE_DIR}/${page.path}: no <link rel="canonical"> — add one pointing at "${self}".`,
      );
    } else {
      expect(
        labelFor(page.path, canonical, 'href'),
        canonical.attributes.get('href') ?? '',
        self,
      );
    }
    const ogUrl = metaTag(page.tags, 'og:url');
    if (ogUrl === undefined) {
      problems.push(
        `${SITE_DIR}/${page.path}: no <meta property="og:url"> — add one with content "${self}".`,
      );
    } else {
      expect(
        labelFor(page.path, ogUrl, 'content'),
        ogUrl.attributes.get('content') ?? '',
        self,
      );
    }
    // The JSON-LD `url` is the application's home page, which is the site root
    // rather than the page the node happens to be embedded in.
    const application = softwareApplication(page.html);
    if (application !== undefined) {
      const where = `${SITE_DIR}/${page.path} JSON-LD SoftwareApplication.url`;
      const url = asString(application['url']);
      if (url === undefined) {
        problems.push(`${where}: missing — add "url": "${base}".`);
      } else {
        expect(where, url, base);
      }
    }
  }

  // 3. robots.txt points crawlers at the sitemap, in absolute form.
  const sitemapLines = robotsSitemaps(inputs.robots);
  if (sitemapLines.length === 0) {
    problems.push(`${ROBOTS}: no "Sitemap:" line — add "Sitemap: ${base}sitemap.xml".`);
  }
  for (const line of sitemapLines) {
    expect(line.where, line.value, `${base}sitemap.xml`);
  }

  // 4. Sitemap coverage. A page that exists but is not listed is invisible to
  //    crawlers, and that is exactly the drift a new page introduces.
  const locations = sitemapLocations(inputs.sitemap);
  const listed = new Set(locations.map((location) => location.value));
  for (const page of pages) {
    const self = pageUrl(base, page.path);
    if (!listed.has(self)) {
      problems.push(
        `${SITEMAP}: no <loc> for ${SITE_DIR}/${page.path} — add "<loc>${self}</loc>", ` +
          `or the page ships unlisted.`,
      );
    }
  }

  // 5. Every remaining same-origin reference: on the base, and on disk.
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const references: (Reference & { from: string })[] = [
    ...pages.flatMap((page) =>
      referencesFrom(page.path, page.tags).map((reference) => ({
        ...reference,
        from: page.path,
      })),
    ),
    ...locations.map((location) => ({ ...location, from: INDEX })),
    ...sitemapLines.map((line) => ({ ...line, from: INDEX })),
  ];
  const seen = new Set<string>();
  for (const reference of references) {
    const resolved = resolveReference(reference.value, base, reference.from);
    if (resolved === undefined || resolved.kind === 'external') continue;
    const key = `${reference.where}\u0000${reference.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (reported.has(reference.where)) continue;
    if (resolved.kind === 'off-base') {
      problems.push(
        `${reference.where}: "${reference.value}" is on the site's host but outside "${base}" — ` +
          `a URL that will 404. Point it at a path under the canonical base.`,
      );
      continue;
    }
    if (!inputs.files.has(resolved.path)) {
      problems.push(
        `${reference.where}: "${reference.value}" resolves to ${SITE_DIR}/${resolved.path}, ` +
          `which does not exist. Add the file or drop the reference.`,
      );
      continue;
    }
    // Fragments are checked only into pages this gate has parsed; an anchor
    // into a non-HTML file has no ids to check against.
    const target = byPath.get(resolved.path);
    if (
      resolved.fragment !== '' &&
      target !== undefined &&
      !target.ids.has(resolved.fragment)
    ) {
      problems.push(
        `${reference.where}: "${reference.value}" points at #${resolved.fragment}, ` +
          `but no element in ${SITE_DIR}/${resolved.path} has that id.`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Reading, repair, orchestration
// ---------------------------------------------------------------------------

/** LF-normalized, so a CRLF checkout on Windows CI compares equal. */
async function readText(root: string, rel: string): Promise<string | undefined> {
  try {
    return (await readFile(join(root, rel), 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

async function readJson(
  root: string,
  rel: string,
): Promise<Record<string, unknown> | undefined> {
  const text = await readText(root, rel);
  if (text === undefined) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Every file under `site/`, as `/`-separated paths relative to it. */
async function siteFiles(root: string): Promise<Set<string>> {
  const dir = join(root, SITE_DIR);
  const files = new Set<string>();
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files.add(relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return files;
}

export async function readSiteInputs(root: string): Promise<SiteInputs | undefined> {
  const files = await siteFiles(root);
  const pages: SitePage[] = [];
  for (const path of [...files].sort()) {
    if (!path.endsWith('.html')) continue;
    const html = await readText(root, `${SITE_DIR}/${path}`);
    if (html !== undefined) pages.push({ path, html });
  }
  const [sitemap, robots] = await Promise.all([
    readText(root, SITEMAP),
    readText(root, ROBOTS),
  ]);
  if (pages.length === 0 || sitemap === undefined || robots === undefined)
    return undefined;
  const [pkg, plugin, extension] = await Promise.all([
    readJson(root, PACKAGE_JSON),
    readJson(root, PLUGIN_JSON),
    readJson(root, EXTENSION_JSON),
  ]);
  return {
    pages,
    sitemap,
    robots,
    version: asString(pkg?.['version']),
    homepage: asString(plugin?.['homepage']),
    extensionHomepage: asString(extension?.['homepage']),
    repositoryUrl: asString(asRecord(pkg?.['repository'])?.['url']),
    files,
  };
}

/** The one derivable value, spliced in place rather than regenerated. */
const SOFTWARE_VERSION = /("softwareVersion"\s*:\s*")([^"]*)(")/g;

/**
 * Rewrite the JSON-LD `softwareVersion`, or return `undefined` if the edit is
 * not unambiguous. Splicing text into a hand-authored page is only safe when
 * there is exactly one candidate inside exactly one JSON-LD block; anything
 * else is reported instead, because a script that guesses here corrupts prose.
 */
export function repairSoftwareVersion(html: string, version: string): string | undefined {
  const hits: { start: number; end: number }[] = [];
  for (const block of ldBlocks(html)) {
    for (const match of block.body.matchAll(SOFTWARE_VERSION)) {
      if (match.index === undefined) continue;
      const start = block.start + match.index + (match[1] ?? '').length;
      hits.push({ start, end: start + (match[2] ?? '').length });
    }
  }
  const hit = hits[0];
  if (hits.length !== 1 || hit === undefined) return undefined;
  return html.slice(0, hit.start) + version + html.slice(hit.end);
}

/** Repair what is derivable; report what is not. */
export async function syncSite(
  check: boolean,
  root: string = REPO_ROOT,
): Promise<boolean> {
  const inputs = await readSiteInputs(root);
  if (inputs === undefined) {
    process.stderr.write(
      `site-sync: could not read ${SITE_DIR}/ — expected at least one *.html page ` +
        `plus sitemap.xml and robots.txt.\n`,
    );
    return false;
  }
  let current = inputs;
  if (!check && inputs.version !== undefined) {
    const version = inputs.version;
    const pages: SitePage[] = [];
    for (const page of inputs.pages) {
      const application = softwareApplication(page.html);
      const advertised = asString(application?.['softwareVersion']);
      const repaired =
        application !== undefined && advertised !== version
          ? repairSoftwareVersion(page.html, version)
          : undefined;
      if (repaired === undefined || repaired === page.html) {
        pages.push(page);
        continue;
      }
      await writeFile(join(root, SITE_DIR, page.path), repaired, 'utf8');
      process.stdout.write(
        `site-sync: wrote ${SITE_DIR}/${page.path} (softwareVersion → ${version})\n`,
      );
      pages.push({ ...page, html: repaired });
    }
    current = { ...inputs, pages };
  }
  const problems = checkSite(current);
  if (problems.length === 0) return true;
  process.stderr.write(
    'site-sync: site/ disagrees with the identity it advertises — edit the file named on each line:\n',
  );
  for (const problem of problems) process.stderr.write(`  x ${problem}\n`);
  process.stderr.write(
    '  note: `npm run sync:write` repairs only the JSON-LD softwareVersion; a wrong URL and a\n' +
      '  missing file are decisions, not derivations, so this gate reports them rather than guessing.\n' +
      '  note: external links, HTML validity and <lastmod> freshness are not checked here.\n',
  );
  return false;
}

if (process.argv[1]?.endsWith('site-sync.js') === true) {
  const ok = await syncSite(!process.argv.includes('--write'));
  process.exitCode = ok ? 0 : 1;
}
