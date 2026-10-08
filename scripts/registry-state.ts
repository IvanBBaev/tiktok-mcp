/**
 * Registry state before `npm publish` (IMPLEMENTATION-PLAN gap G-14).
 *
 * Trusted publishing cannot publish a package's first version, so that version
 * is published by hand and the `vX.Y.Z` tag is pushed afterwards. Left alone,
 * that tag's *Publish* run would fail at `npm publish` (E403 — a published
 * version cannot be overwritten), and since the GitHub release and both
 * follower workflows need a *successful* run, the release would have to be
 * finished by hand. The same holds for re-running a *Publish* run whose npm
 * step succeeded and whose GitHub release step did not.
 *
 * This script decides whether `publish.yml` publishes or skips, and it only
 * ever skips on proof:
 *
 * - **The registry answer is unambiguous.** `npm view <name>@<version>` must
 *   either return exactly this version or fail with E404. Any other failure — a
 *   network error, a 5xx, output it cannot parse — fails the step: publishing
 *   blindly could spend a version on a transient error, and skipping blindly
 *   would release a GitHub tag for a version npm may not have.
 * - **The published version came from this commit.** npm records the `gitHead`
 *   of the tree it published from; it must equal `HEAD` here. A version
 *   published from another commit under the same number is a release identity
 *   problem no skip can fix — the fix is a new version.
 * - **The published bytes are what this commit packs.** `gitHead` is asserted
 *   by whoever published, not verified by the registry, so the registry
 *   tarball is downloaded (public, no credentials), checked against its
 *   `dist.integrity`, and compared with a fresh `npm pack` of this tree —
 *   byte for byte when the gzip streams agree, and file by file when only the
 *   compression differs (a laptop's zlib need not match the runner's).
 *
 * What it cannot do is move a dist-tag: trusted publishing authorizes
 * `npm publish` and nothing else, and this workflow holds no token by design.
 * So a skipped publish only *checks* that the expected dist-tag points at this
 * version — a warning when it does not (a re-run of an older release is the
 * legitimate case), a failure when a prerelease holds `latest`.
 *
 * Usage: `node build/scripts/registry-state.js` — prints its reasoning and, on
 * a runner, writes `skip=true|false` to `$GITHUB_OUTPUT`. Exits 1 when it can
 * neither publish nor skip safely.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { distTagFor } from './release-guard.js';
import { asRecord, asString, readRepoJson, REPO_ROOT } from './lib/repo.js';

/** The public registry, named explicitly: this is a read that needs no auth. */
const REGISTRY = 'https://registry.npmjs.org/';
const NPM_TIMEOUT_MS = 120_000;
const TARBALL_TIMEOUT_MS = 60_000;
/** How many differing paths a failure message names before it summarizes. */
const MAX_LISTED_PATHS = 10;

// --- npm view ---

export type RegistryView =
  | { kind: 'absent' }
  | {
      kind: 'published';
      version?: string;
      gitHead?: string;
      integrity?: string;
      tarball?: string;
      distTags: Readonly<Record<string, string>>;
    }
  | { kind: 'error'; detail: string };

/**
 * Classify `npm view <spec> version gitHead dist.integrity dist.tarball
 * dist-tags --json`.
 *
 * npm 10 prints the fields as one object; npm 11+ wraps it in a one-element
 * array. A failure is `{ "error": { "code", "summary" } }` on stdout either way.
 * Only E404 means "not published"; everything else is an error, including an
 * empty answer — older npm printed nothing, with exit 0, for a version it
 * could not find, and a check that read silence as absence would publish on
 * any npm that fails quietly.
 */
export function parseView(stdout: string, exitCode: number): RegistryView {
  const text = stdout.trim();
  if (text === '') {
    return {
      kind: 'error',
      detail: `npm view printed nothing (exit ${String(exitCode)})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      kind: 'error',
      detail: `npm view printed non-JSON output (exit ${String(exitCode)})`,
    };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      return {
        kind: 'error',
        detail: `npm view returned ${String(parsed.length)} results, not 1`,
      };
    }
    parsed = parsed[0];
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    return { kind: 'error', detail: 'npm view returned something other than an object' };
  }
  const error = asRecord(record['error']);
  if (error !== undefined) {
    const code = asString(error['code']) ?? 'unknown';
    if (code === 'E404' && exitCode !== 0) return { kind: 'absent' };
    const summary = asString(error['summary']);
    return {
      kind: 'error',
      detail: `npm view failed with ${code}${summary === undefined ? '' : `: ${summary}`}`,
    };
  }
  if (exitCode !== 0) {
    return {
      kind: 'error',
      detail: `npm view exited ${String(exitCode)} without an error object`,
    };
  }
  const distTags: Record<string, string> = {};
  for (const [tag, value] of Object.entries(asRecord(record['dist-tags']) ?? {})) {
    if (typeof value === 'string') distTags[tag] = value;
  }
  const version = asString(record['version']);
  const gitHead = asString(record['gitHead']);
  const integrity = asString(record['dist.integrity']);
  const tarball = asString(record['dist.tarball']);
  return {
    kind: 'published',
    ...(version === undefined ? {} : { version }),
    ...(gitHead === undefined ? {} : { gitHead }),
    ...(integrity === undefined ? {} : { integrity }),
    ...(tarball === undefined ? {} : { tarball }),
    distTags,
  };
}

/**
 * Why the published version is not this commit's release, or `undefined` when
 * its number and `gitHead` agree with this checkout.
 */
export function identityProblem(
  view: Extract<RegistryView, { kind: 'published' }>,
  spec: string,
  version: string,
  head: string,
): string | undefined {
  if (view.version !== version) {
    return `npm view ${spec} answered version ${JSON.stringify(view.version ?? null)}, not "${version}"`;
  }
  if (view.gitHead === undefined) {
    return (
      `${spec} is published but records no gitHead, so nothing ties it to this commit ` +
      `(npm records one only when publishing from a git checkout whose .git is a directory)`
    );
  }
  if (view.gitHead !== head) {
    return (
      `${spec} was published from commit ${view.gitHead}, but this tag is ${head} — ` +
      `a published version cannot be replaced; release a new version instead`
    );
  }
  return undefined;
}

// --- tarball comparison ---

/** SRI string (`sha512-<base64>`) of a buffer, as npm writes `dist.integrity`. */
export function sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function octal(block: Buffer, offset: number, length: number): number {
  const text = block
    .subarray(offset, offset + length)
    .toString('latin1')
    .replace(/\0.*$/s, '')
    .trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function cString(block: Buffer, offset: number, length: number): string {
  const text = block.subarray(offset, offset + length).toString('utf8');
  const nul = text.indexOf('\0');
  return nul === -1 ? text : text.slice(0, nul);
}

/** `path` from a PAX extended header body (`<len> <key>=<value>\n` records). */
function paxPath(body: Buffer): string | undefined {
  let path: string | undefined;
  let rest = body;
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    if (space === -1) break;
    const length = Number.parseInt(rest.subarray(0, space).toString('latin1'), 10);
    if (!Number.isInteger(length) || length <= space) break;
    const record = rest
      .subarray(space + 1, length)
      .toString('utf8')
      .replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    rest = rest.subarray(length);
  }
  return path;
}

/**
 * Regular files of an uncompressed tar stream, as path → sha256 of the bytes.
 *
 * Only what `npm pack` writes is understood: ustar headers (name + prefix),
 * PAX extended headers for long paths, and GNU long names. Directories and
 * links carry no bytes to compare and are skipped; modes and mtimes are not
 * compared — npm normalizes both when it packs.
 */
export function tarFiles(tar: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (body.length !== size) throw new Error('truncated tar entry');
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pendingPath = paxPath(body) ?? pendingPath;
      continue;
    }
    if (type === 'L') {
      pendingPath = cString(body, 0, body.length);
      continue;
    }
    if (type === 'g') continue;
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const path = pendingPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    pendingPath = undefined;
    if (type === '0' || type === '\0' || type === '7') {
      files.set(path, createHash('sha256').update(body).digest('hex'));
    }
  }
  return files;
}

/** Paths present on one side only or with different bytes, sorted. */
export function diffFiles(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
): string[] {
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  return [...paths].filter((path) => expected.get(path) !== actual.get(path)).sort();
}

export type ContentCheck =
  | { kind: 'identical' }
  | { kind: 'equivalent' }
  | { kind: 'different'; paths: readonly string[] }
  | { kind: 'unavailable'; detail: string };

/** Compare the registry tarball with this tree's `npm pack` output. */
export function compareTarballs(local: Buffer, published: Buffer): ContentCheck {
  if (sri(local) === sri(published)) return { kind: 'identical' };
  let paths: string[];
  try {
    paths = diffFiles(tarFiles(gunzipSync(local)), tarFiles(gunzipSync(published)));
  } catch (err) {
    return { kind: 'unavailable', detail: `could not unpack a tarball: ${message(err)}` };
  }
  return paths.length === 0 ? { kind: 'equivalent' } : { kind: 'different', paths };
}

// --- the decision ---

export interface DecisionInput {
  name: string;
  version: string;
  /** `git rev-parse HEAD` of the checkout being released. */
  head: string;
  view: RegistryView;
  /** Only consulted once the version and gitHead agree. */
  content?: ContentCheck;
}

export interface Decision {
  action: 'publish' | 'skip' | 'fail';
  reason: string;
  warnings: readonly string[];
}

export function decide(input: DecisionInput): Decision {
  const { name, version, head, view, content } = input;
  const spec = `${name}@${version}`;
  const fail = (reason: string): Decision => ({ action: 'fail', reason, warnings: [] });
  if (view.kind === 'absent') {
    return {
      action: 'publish',
      reason: `${spec} is not on the registry (E404) — publishing it.`,
      warnings: [],
    };
  }
  if (view.kind === 'error') {
    return fail(
      `could not tell whether ${spec} is published (${view.detail}) — ` +
        `refusing both to publish and to skip; re-run once the registry answers.`,
    );
  }
  const problem = identityProblem(view, spec, version, head);
  if (problem !== undefined) return fail(`${problem}.`);
  if (content === undefined) {
    return fail(
      `${spec} is published and its contents were not compared — not skipping.`,
    );
  }
  if (content.kind === 'unavailable') {
    return fail(
      `${spec} is published but could not be compared with this commit: ${content.detail}.`,
    );
  }
  if (content.kind === 'different') {
    const listed = content.paths.slice(0, MAX_LISTED_PATHS).join(', ');
    const more =
      content.paths.length > MAX_LISTED_PATHS
        ? ` and ${String(content.paths.length - MAX_LISTED_PATHS)} more`
        : '';
    return fail(
      `${spec} was published from this commit but its tarball differs from what this ` +
        `commit packs (${listed}${more}) — not releasing it under this tag.`,
    );
  }

  const distTag = distTagFor(version);
  if (distTag !== 'latest' && view.distTags['latest'] === version) {
    return fail(
      `${spec} is a prerelease and holds the \`latest\` dist-tag — move \`latest\` back ` +
        `(npm dist-tag add ${name}@<stable> latest) and re-run; this workflow cannot, ` +
        `since trusted publishing authorizes \`npm publish\` only.`,
    );
  }
  const warnings: string[] = [];
  const tagged = view.distTags[distTag];
  if (tagged !== version) {
    warnings.push(
      `dist-tag \`${distTag}\` points at ${tagged ?? 'nothing'}, not ${version}. A skipped ` +
        `publish cannot move it (trusted publishing authorizes \`npm publish\` only); ` +
        `if this is not a re-run of an older release, run ` +
        `\`npm dist-tag add ${spec} ${distTag}\` by hand.`,
    );
  }
  const match =
    content.kind === 'identical'
      ? 'its tarball is byte-identical to this commit’s npm pack'
      : 'its tarball holds the same files as this commit’s npm pack (only the gzip stream differs)';
  return {
    action: 'skip',
    reason:
      `${spec} is already on the registry, published from this commit (${head}), and ` +
      `${match} — skipping npm publish.`,
    warnings,
  };
}

// --- I/O ---

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command and resolve with its exit code rather than rejecting on a
 * non-zero one: `npm view` reports "not published" as exit 1, which is an
 * answer here, not a crash. Linux-only (publish.yml runs on ubuntu), so no
 * `.cmd` shim handling.
 */
function run(file: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: REPO_ROOT, timeout: NPM_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err !== null && typeof err.code !== 'number') {
          reject(new Error(`could not run ${file}: ${err.message}`));
          return;
        }
        resolve({ code: err === null ? 0 : Number(err.code), stdout, stderr });
      },
    );
  });
}

async function fetchTarball(url: string): Promise<Buffer> {
  if (!url.startsWith('https://'))
    throw new Error(`refusing a non-https tarball URL: ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${url} answered ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
}

/** `npm pack` this tree into a temp dir and return the tarball's bytes. */
async function packLocal(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'tiktok-mcp-registry-state-'));
  try {
    const packed = await run('npm', [
      'pack',
      '--ignore-scripts',
      '--pack-destination',
      dir,
    ]);
    if (packed.code !== 0) throw new Error(`npm pack exited ${String(packed.code)}`);
    const tarballs = (await readdir(dir)).filter((file) => file.endsWith('.tgz'));
    const [tarball] = tarballs;
    if (tarballs.length !== 1 || tarball === undefined) {
      throw new Error(`npm pack left ${String(tarballs.length)} tarballs, not 1`);
    }
    return await readFile(join(dir, tarball));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function compareWithRegistry(
  view: Extract<RegistryView, { kind: 'published' }>,
): Promise<ContentCheck> {
  if (view.integrity === undefined || view.tarball === undefined) {
    return {
      kind: 'unavailable',
      detail: 'the registry lists no dist.integrity/dist.tarball',
    };
  }
  try {
    const published = await fetchTarball(view.tarball);
    if (sri(published) !== view.integrity) {
      return {
        kind: 'unavailable',
        detail: `the downloaded tarball does not match the registry's dist.integrity`,
      };
    }
    return compareTarballs(await packLocal(), published);
  } catch (err) {
    return { kind: 'unavailable', detail: message(err) };
  }
}

export async function runRegistryState(env: NodeJS.ProcessEnv): Promise<boolean> {
  const pkg = (await readRepoJson('package.json')) ?? {};
  const name = asString(pkg['name']);
  const version = asString(pkg['version']);
  if (name === undefined || version === undefined) {
    process.stderr.write('registry-state: package.json has no name/version\n');
    return false;
  }
  const rev = await run('git', ['rev-parse', 'HEAD']);
  const head = rev.stdout.trim();
  if (rev.code !== 0 || !/^[0-9a-f]{40}$/.test(head)) {
    process.stderr.write('registry-state: could not read HEAD with git rev-parse\n');
    return false;
  }

  const spec = `${name}@${version}`;
  const viewed = await run('npm', [
    'view',
    spec,
    'version',
    'gitHead',
    'dist.integrity',
    'dist.tarball',
    'dist-tags',
    '--json',
    '--prefer-online',
    `--registry=${REGISTRY}`,
  ]);
  const view = parseView(viewed.stdout, viewed.code);
  const content =
    view.kind === 'published' && identityProblem(view, spec, version, head) === undefined
      ? await compareWithRegistry(view)
      : undefined;
  const decision = decide({ name, version, head, view, content });

  for (const warning of decision.warnings)
    process.stdout.write(`::warning::${warning}\n`);
  if (decision.action === 'fail') {
    process.stdout.write(`::error title=Registry state::${decision.reason}\n`);
    return false;
  }
  const skip = decision.action === 'skip';
  process.stdout.write(
    skip
      ? `::notice title=npm publish skipped::${decision.reason}\n`
      : `registry-state: ${decision.reason}\n`,
  );
  const output = env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    await appendFile(output, `skip=${String(skip)}\n`);
  }
  return true;
}

if (process.argv[1]?.endsWith('registry-state.js') === true) {
  const ok = await runRegistryState(process.env);
  process.exitCode = ok ? 0 : 1;
}
