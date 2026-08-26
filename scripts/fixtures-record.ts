/**
 * Record raw TikTok interactions from a real sandbox account
 * (TESTING.md § "Recorded sandbox fixtures").
 *
 * Every API-shape assertion in this suite is written by hand against the fetch
 * stub, which caps what the suite can prove: a hand-written envelope shows that
 * our parser accepts what we *believe* TikTok sends, never what TikTok actually
 * sent. A recorded fixture is the missing half — real bytes, captured once,
 * replayed on every run — so "TikTok's envelope drifted" turns into a red test
 * instead of a support thread, and "our payload drifted" is caught by the same
 * file from the other side.
 *
 * The awkward part is that the bytes can only come from a live, logged-in
 * account, and the raw capture of a live account is a credential dump: bearer
 * tokens in the request headers, `open_id` in the response, a pre-signed
 * `upload_url` with a token in its query string. That shapes everything here:
 *
 * - **It refuses to run in CI** ({@link refuseInCi}), before it reads a
 *   credential or opens a socket. A recorder that ran on a runner would either
 *   fail for want of an account or, far worse, succeed against one.
 * - **Output goes to `.fixtures-raw/`, never to `test/fixtures/recorded/`.**
 *   Nothing in this file sanitizes anything; `fixtures-sanitize` owns that step
 *   and the diff it produces is reviewed like code. Keeping the two apart means
 *   a recorder bug can leak into a gitignored directory, not into a commit.
 * - **The catalog is read-only by construction** ({@link CAPTURES}). Not one
 *   entry can post, delete or mutate — see the note above the catalog for why
 *   the publish and upload fixtures are captured by hand instead.
 *
 * The recording seam is the global `fetch`. `core/http.ts` calls
 * `globalThis.fetch(...)` directly and offers no per-call injection point, so
 * the only way to observe a real request is to replace the global for the
 * duration of the run — a process-wide side effect, which is exactly why this
 * is a standalone script and not something a test could do. See
 * {@link installFetchTap}.
 *
 * Usage: `node build/scripts/fixtures-record.js [--list] [--only=<name>[,<name>]] [--profile=<name>]`
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createApiContext, grantedScopes, type ApiContext } from '../src/api/context.js';
import { getCreatorInfo } from '../src/api/publish.js';
import { USER_FIELDS, getUserInfo } from '../src/api/user.js';
import { listVideos, queryVideos } from '../src/api/video.js';
import { overlayEnvFile } from '../src/cli/index.js';
import { systemClock } from '../src/core/clock.js';
import {
  normalizeProfileName,
  readEnvFile,
  resolveEnvFilePath,
} from '../src/core/config.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';

import {
  FIXTURE_SCHEMA,
  RAW_ROOT,
  fixturePath,
  parseFixture,
  renderFixture,
  type Fixture,
  type FixtureArea,
} from './lib/fixtures.js';
import { repoPath } from './lib/repo.js';

/** Every message this script prints is prefixed with its own name. */
const SCRIPT = 'fixtures-record';

// ---------------------------------------------------------------------------
// the capture catalog
// ---------------------------------------------------------------------------

/**
 * The scratch space captures share, in catalog order.
 *
 * `video/query` takes ids, and the only honest source of an id for a real
 * account is the `video/list` call that ran a moment earlier — a hard-coded id
 * would be someone's actual video and would rot the first time it is deleted.
 * So the list capture stashes what it saw and the query capture spends it.
 */
export interface CaptureState {
  /** Video ids returned by `video-list-first-page`; empty until it has run. */
  videoIds: string[];
}

/**
 * A capture that cannot produce a fixture right now and must not be reported as
 * a failure: the account has no videos, so `video/query` has nothing to ask
 * about. Thrown rather than returned because a capture's work is a sequence of
 * awaits and the decision is usually made halfway through it.
 */
class SkippedCapture extends Error {}

/** Abandon the current capture with a reason a human can act on. */
export function skipCapture(reason: string): never {
  throw new SkippedCapture(reason);
}

export interface CaptureSpec {
  /** kebab-case; becomes the file basename. */
  readonly name: string;
  readonly area: FixtureArea;
  /** Scopes the capture needs; skipped with a clear line when the profile lacks them. */
  readonly scopes: readonly string[];
  /** Why this interaction is worth a fixture — printed in `--list`. */
  readonly why: string;
  readonly run: (api: ApiContext, state: CaptureState) => Promise<void>;
}

/**
 * Every interaction this script is allowed to record.
 *
 * **Nothing here writes.** No publish, no upload, no draft, no status poll on
 * something this script created — every entry is a read the account cannot
 * notice. That is not caution for its own sake: the recorder is run by a human
 * against a real TikTok account, usually more than once while getting the
 * captures right, and a catalog that could post would eventually post twice.
 *
 * The consequence is that `publish/` (beyond `creator_info`, which is a pure
 * read) and all of `upload/` stay empty here. Those fixtures land the other
 * way: a supervised sandbox publish is captured by hand, the raw JSON is edited
 * into this same format, and it goes through the sanitizer like everything
 * else. Recording them automatically would mean a script that posts to a real
 * creator's profile on every re-record, which is not a trade this repo makes.
 */
export const CAPTURES: readonly CaptureSpec[] = [
  {
    name: 'user-info-basic',
    area: 'user',
    scopes: ['user.info.basic'],
    why: 'the cheapest authenticated read there is — the envelope every other Display call shares, with the smallest field set a token can ask for',
    run: async (api) => {
      await getUserInfo(api, ['open_id', 'display_name', 'avatar_url']);
    },
  },
  {
    name: 'user-info-profile-stats',
    area: 'user',
    scopes: ['user.info.basic', 'user.info.profile', 'user.info.stats'],
    why: 'the full USER_FIELDS request: the one capture that shows which fields a full grant actually returns, and which the docs promise but upstream omits',
    run: async (api) => {
      await getUserInfo(api, [...USER_FIELDS]);
    },
  },
  {
    name: 'video-list-first-page',
    area: 'video',
    scopes: ['video.list'],
    why: 'a real page envelope — cursor, has_more and the video objects — which is where CC-C1 (the cursor is opaque) and CC-C5 (max_count is clamped) are decided',
    run: async (api, state) => {
      const page = await listVideos(api, { maxCount: 5 });
      state.videoIds = page.videos.map((video) => video.id);
    },
  },
  {
    name: 'video-query-by-id',
    area: 'video',
    scopes: ['video.list'],
    why: 'the by-id sibling of the list envelope, and the only way to see how upstream renders ids it will not return (CC-C7 missingIds)',
    run: async (api, state) => {
      // Two ids, not twenty: the shape of the answer is the contract, and a
      // fixture that carries a stranger's whole video library is a fixture
      // nobody wants to review.
      const ids = state.videoIds.slice(0, 2);
      if (ids.length === 0) {
        skipCapture(
          'video-list-first-page returned no videos, so there is no id to query',
        );
      }
      await queryVideos(api, ids);
    },
  },
  {
    name: 'creator-info',
    area: 'publish',
    scopes: ['video.publish'],
    why: 'the mandatory pre-flight of every direct post (CC-E1) — privacy_level_options, the disabled switches and max_video_post_duration_sec as an unaudited sandbox client really sees them',
    run: async (api) => {
      await getCreatorInfo(api);
    },
  },
];

// ---------------------------------------------------------------------------
// refusing to run in CI
// ---------------------------------------------------------------------------

/**
 * Values that mean "this variable is present but switched off". Anything else —
 * `1`, `true`, `yes`, a build number — is a CI runner, because every CI vendor
 * spells the affirmative differently and only the negatives are conventional.
 * Compared case- and whitespace-insensitively: `CI=False` is not a second CI.
 */
const NEGATIVE = new Set(['', '0', 'false']);

/** The variables that identify a runner, in the order the refusal names them. */
const CI_VARS = ['CI', 'GITHUB_ACTIONS'] as const;

/**
 * Why this environment must not record, or `undefined` when it may.
 *
 * The first CI check in this repo, and deliberately a local one: a shared
 * helper would invite a second caller with a different idea of what "in CI"
 * means, and the whole value of this function is that it is conservative. It
 * takes `env` as an argument rather than reading the global so the refusal is
 * testable without mutating the process it is testing.
 */
export function refuseInCi(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of CI_VARS) {
    const value = env[name];
    if (value === undefined) continue;
    if (NEGATIVE.has(value.trim().toLowerCase())) continue;
    return `${name}=${value}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const USAGE = [
  `Usage: node build/scripts/${SCRIPT}.js [--list] [--only=<name>[,<name>]] [--profile=<name>]`,
  '',
  '  --list             print the capture catalog and record nothing',
  '  --only <names>     record only these captures (comma-separated)',
  '  --profile <name>   credential profile to record against',
  '                     (default: TT_ACTIVE_PROFILE, else DEFAULT)',
  '  -h, --help         show this help',
  '',
].join('\n');

interface RecordFlags {
  profile?: string;
  /** Capture names from `--only`; absent means the whole catalog. */
  only?: readonly string[];
  list: boolean;
  help: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly flags: RecordFlags }
  | { readonly ok: false; readonly message: string };

/**
 * Same grammar as `tiktok-mcp-ai doctor`: `--flag value` and `--flag=value` are
 * both accepted, an unknown flag is an error rather than a silently ignored
 * word. Mirroring the CLI matters more than brevity here — this script is run
 * by the same person, minutes after running `doctor --profile sandbox`.
 */
function parseRecordArgs(argv: readonly string[]): ParseResult {
  const flags: RecordFlags = { list: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    let value: string | undefined;
    if (name === '--profile' || name === '--only') {
      if (inline !== undefined) value = inline;
      else {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '') {
        return { ok: false, message: `${name} needs a value.` };
      }
    } else if (inline !== undefined) {
      return { ok: false, message: `${name} does not take a value.` };
    }

    switch (name) {
      case '--profile':
        flags.profile = value;
        break;
      case '--only':
        flags.only = (value ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');
        break;
      case '--list':
        flags.list = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      default:
        return { ok: false, message: `Unknown option ${JSON.stringify(arg)}.` };
    }
  }
  return { ok: true, flags };
}

/** Catalog names, in catalog order — the vocabulary `--only` accepts. */
function captureNames(): string {
  return CAPTURES.map((spec) => spec.name).join(', ');
}

/**
 * The captures `--only` selected, in catalog order rather than in the order the
 * flag listed them: `video-query-by-id` needs the ids `video-list-first-page`
 * stashes, so the catalog order is a dependency order and honouring the
 * caller's order would break it.
 */
function selectCaptures(only: readonly string[] | undefined): CaptureSpec[] | string {
  if (only === undefined) return [...CAPTURES];
  const unknown = only.filter((name) => !CAPTURES.some((spec) => spec.name === name));
  if (unknown.length > 0) {
    return `--only names no such capture: ${unknown.join(', ')}. Known captures: ${captureNames()}.`;
  }
  return CAPTURES.filter((spec) => only.includes(spec.name));
}

/** `--list`: the catalog as a human reads it before deciding what to record. */
function renderCatalog(): string {
  const lines = [`${SCRIPT}: ${String(CAPTURES.length)} captures, all read-only.`, ''];
  for (const spec of CAPTURES) {
    lines.push(
      `  ${spec.area}/${spec.name}`,
      `    scopes: ${spec.scopes.join(', ')}`,
      `    why:    ${spec.why}`,
      '',
    );
  }
  lines.push(
    'Nothing here posts, uploads or deletes. The publish and upload fixtures are',
    'captured by hand from a supervised sandbox run — see the note above CAPTURES.',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  /** Always populated: this line is the whole diagnosis of a failed capture. */
  detail: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One line per capture, printed as it happens so a long run streams in order. */
function record(checks: Check[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}\n`);
}

// ---------------------------------------------------------------------------
// the fetch tap
// ---------------------------------------------------------------------------

/** One observed HTTP round trip, in the vocabulary the fixture format uses. */
interface RecordedCall {
  /** Stamped when the response arrived, not when the file is written. */
  readonly recordedAt: string;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody: unknown;
  readonly status: number;
  readonly responseHeaders: Record<string, string>;
  readonly responseBody: unknown;
}

/**
 * Headers as the format wants them: names lower-cased, multi-valued names
 * joined with `', '`. `Headers` already normalizes both, so this is a copy into
 * a plain object rather than a transformation — but the `toLowerCase` stays,
 * because `parseFixture` rejects a capitalized name and a future `Headers`
 * implementation is not this script's problem to debug at replay time.
 */
function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function isJson(contentType: string | undefined): boolean {
  return contentType !== undefined && /\bjson\b/i.test(contentType);
}

/**
 * A body as the fixture stores it: parsed JSON when the content type says JSON,
 * otherwise the raw string (a form body is a contract too, and `a=1&b=2` is
 * exactly what the replay has to compare against), `null` for no body at all.
 *
 * A JSON content type that does not parse is kept as the raw string rather than
 * dropped: an upstream error page served with the wrong header is a fixture
 * worth having, and losing it would leave "the body was empty" as the only
 * explanation.
 */
function decodeBody(text: string, contentType: string | undefined): unknown {
  if (text === '') return null;
  if (!isJson(contentType)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The request body, or `null` when there is nothing textual to record.
 *
 * A non-string body is a stream or a byte range — an upload chunk. Those bytes
 * are the file under test, not part of the contract, and copying them into a
 * JSON document would produce a fixture nobody can review.
 */
function decodeRequestBody(body: unknown, contentType: string | undefined): unknown {
  return typeof body === 'string' ? decodeBody(body, contentType) : null;
}

interface DescribedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

/**
 * Normalize the two shapes `fetch` accepts into one.
 *
 * `core/http.ts` always passes a `URL` plus an init, but the tap replaces a
 * *global*: any other caller in the process — a dependency, a future code path
 * — goes through here too, and a recorder that threw on a `Request` would take
 * the whole run down with it.
 */
function describeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): DescribedRequest {
  if (typeof input === 'string') {
    return {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
  }
  if (input instanceof URL) {
    return {
      url: input.href,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
  }
  return {
    url: input.url,
    method: init?.method ?? input.method,
    headers: new Headers(init?.headers ?? input.headers),
  };
}

/**
 * Replace `globalThis.fetch` with a tap that appends to `calls`, and return the
 * function that puts the original back.
 *
 * This is process-wide, which is the whole reason the recorder is a script:
 * a test that swapped the global would leak it into every other test in the
 * same process the moment one assertion threw before its cleanup ran.
 *
 * Two rules the tap follows. The response is read through `clone()`, so the
 * real client still gets an undisturbed body — reading `response.text()` here
 * would leave `core/http` with a consumed stream and every capture would fail
 * as a transport error. And a failure *inside* the tap is reported and
 * swallowed: the recorder observes the run, it does not get to break it.
 */
function installFetchTap(calls: RecordedCall[]): () => void {
  const original = globalThis.fetch;

  const tapped: typeof globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    try {
      const described = describeRequest(input, init);
      const requestHeaders = headerMap(described.headers);
      const responseHeaders = headerMap(response.headers);
      // The clone is buffered in memory until both branches are read; every
      // body in this catalog is a few kilobytes of JSON, and the upload path
      // (the one body that is not) is not in the catalog.
      const text = await response.clone().text();
      calls.push({
        recordedAt: new Date().toISOString(),
        method: described.method.toUpperCase(),
        url: described.url,
        requestHeaders,
        requestBody: decodeRequestBody(init?.body, requestHeaders['content-type']),
        status: response.status,
        responseHeaders,
        responseBody: decodeBody(text, responseHeaders['content-type']),
      });
    } catch (err) {
      process.stderr.write(
        `${SCRIPT}: could not record one call (${message(err)}); the run continues.\n`,
      );
    }
    return response;
  };

  globalThis.fetch = tapped;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * The basename for call number `index` of a capture.
 *
 * A capture is one *interaction*, but an interaction can cost more than one
 * HTTP call: a 401 buys exactly one forced refresh and one replay
 * (ARCHITECTURE § 6), so a token that expires mid-capture turns one read into
 * three requests. Suffixing the extras keeps every call on disk — the refresh
 * and the replay are precisely the round trips no hand-written stub gets right
 * — and leaves the reviewer to decide which of them earns a committed fixture.
 */
function captureName(name: string, index: number): string {
  return index === 0 ? name : `${name}-${String(index + 1)}`;
}

/**
 * Write one capture to `.fixtures-raw/<area>/<name>.json` and answer with the
 * repo-relative path.
 *
 * `parseFixture` runs on our own output before it is written, which looks
 * redundant and is not: a capture that violates the format has to fail here,
 * while the account and the network are still at hand, rather than three steps
 * later when the sanitizer or the replay test trips over a file that cannot be
 * re-recorded without another sandbox session.
 *
 * The file is created `0600`. It carries a live bearer token until the
 * sanitizer has run, and the same reasoning the credential store follows
 * applies to its raw twin. (Node applies the mode on creation only, so a
 * re-record inherits whatever the first run set.)
 */
async function writeCapture(
  area: FixtureArea,
  name: string,
  call: RecordedCall,
): Promise<string> {
  const target = new URL(call.url);
  const fixture: Fixture = {
    schema: FIXTURE_SCHEMA,
    recordedAt: call.recordedAt,
    area,
    name,
    endpoint: { method: call.method, host: target.host, path: target.pathname },
    request: { url: call.url, headers: call.requestHeaders, body: call.requestBody },
    response: {
      status: call.status,
      headers: call.responseHeaders,
      body: call.responseBody,
    },
  };
  const file = fixturePath(RAW_ROOT, area, name);
  const absolute = repoPath(file);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, renderFixture(parseFixture(fixture, file)), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return file;
}

// ---------------------------------------------------------------------------
// the api context
// ---------------------------------------------------------------------------

interface Recorder {
  readonly api: ApiContext;
  readonly profile: string;
  /** Scopes TikTok actually granted this profile — a partial grant is normal. */
  readonly granted: readonly string[];
}

/**
 * Build the context the captures run against, exactly the way `cli/doctor.ts`
 * builds the one its api probe uses.
 *
 * Two details are load-bearing. The profile is resolved through the same chain
 * doctor uses (`--profile`, then `TT_PROFILE_LOCK`, then `TT_ACTIVE_PROFILE`,
 * which `loadSettings` has already defaulted to `DEFAULT`), because a recorder
 * with its own idea of "the default account" would record the wrong one. And
 * `createApiContext` is called **without** a `refresh` override, so the api
 * layer resolves the token through the real single-flight, rotation-safe path —
 * a stubbed resolver would record requests carrying a token that never came
 * from the credential store, which is the one thing a fixture must not do.
 *
 * The logger is pinned to `error`: the recorder's own report is the output that
 * matters here, and an `info`-level run buries it under per-request lines.
 */
async function createRecorder(
  profileFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Recorder> {
  const snapshot = await readEnvFile(resolveEnvFilePath(env));
  const merged = overlayEnvFile(env, snapshot);
  const settings = loadSettings(merged);
  const profile = normalizeProfileName(
    profileFlag ?? settings.lockProfile ?? settings.activeProfile,
  );
  const api = createApiContext({
    profile,
    settings,
    log: createLogger({ level: 'error', clock: systemClock }),
    clock: systemClock,
    env: merged,
  });
  return { api, profile, granted: await grantedScopes(api, merged) };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/** Scopes a capture needs that this profile has not granted. */
function missingScopes(spec: CaptureSpec, granted: readonly string[]): string[] {
  return spec.scopes.filter((scope) => !granted.includes(scope));
}

/**
 * Run one capture and write whatever it produced.
 *
 * Everything the capture caused to be sent is written, including the calls of a
 * capture that *failed*: an upstream rejection is often the most valuable
 * fixture in the tree — nobody can invent TikTok's error envelope from the docs
 * — and discarding it would mean another sandbox session to get it back. The
 * failure is still reported as a failure.
 */
async function runCapture(
  spec: CaptureSpec,
  api: ApiContext,
  state: CaptureState,
  calls: RecordedCall[],
  checks: Check[],
): Promise<string[]> {
  const before = calls.length;
  let failure: string | undefined;
  let skipped: string | undefined;
  try {
    await spec.run(api, state);
  } catch (err) {
    if (err instanceof SkippedCapture) skipped = err.message;
    else failure = message(err);
  }

  const written: string[] = [];
  for (const [index, call] of calls.slice(before).entries()) {
    written.push(await writeCapture(spec.area, captureName(spec.name, index), call));
  }

  const wrote =
    written.length === 0 ? 'no call reached the network' : `wrote ${written.join(', ')}`;
  if (skipped !== undefined) {
    record(checks, spec.name, true, `skipped (${skipped})`);
  } else if (failure !== undefined) {
    record(checks, spec.name, false, `${failure} — ${wrote}`);
  } else {
    record(checks, spec.name, true, wrote);
  }
  return written;
}

/**
 * The closing reminder. It says the same three things every time on purpose:
 * the directory is gitignored, the files are *not* sanitized, and the run is
 * only half done. No captured value is printed — the point of this script is
 * that the credentials it handles stay in one directory.
 */
function reminder(written: readonly string[]): string {
  return (
    `${SCRIPT}: ${String(written.length)} raw capture(s) under ${RAW_ROOT}/. ` +
    "They are gitignored and NOT sanitized — they still carry this account's " +
    'access token, open_id and any pre-signed URL upstream handed back.\n' +
    `${SCRIPT}: next step — \`npm run fixtures:sanitize\`, then review the diff it ` +
    'produces under test/fixtures/recorded/ like code.\n'
  );
}

/**
 * Refuse in CI, parse, then record — in that order, so the refusal happens
 * before a credential is read or a socket is opened.
 *
 * Returns a boolean and never calls `process.exit`: the tail below owns the
 * exit code, and a caller that wants to record inside a larger program gets to
 * decide what a failure means.
 */
export async function runFixturesRecord(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const refusal = refuseInCi(env);
  if (refusal !== undefined) {
    process.stderr.write(
      `${SCRIPT}: refusing to run in CI — ${refusal}; recording needs a real sandbox ` +
        "account's credentials.\n",
    );
    return false;
  }

  const parsed = parseRecordArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${SCRIPT}: ${parsed.message}\n\n${USAGE}`);
    return false;
  }
  if (parsed.flags.help) {
    process.stdout.write(USAGE);
    return true;
  }
  if (parsed.flags.list) {
    process.stdout.write(renderCatalog());
    return true;
  }

  const selected = selectCaptures(parsed.flags.only);
  if (typeof selected === 'string') {
    process.stderr.write(`${SCRIPT}: ${selected}\n`);
    return false;
  }

  let recorder: Recorder;
  try {
    recorder = await createRecorder(parsed.flags.profile, env);
  } catch (err) {
    process.stderr.write(
      `${SCRIPT}: could not resolve the credentials to record with: ${message(err)}\n`,
    );
    return false;
  }

  const checks: Check[] = [];
  const calls: RecordedCall[] = [];
  const state: CaptureState = { videoIds: [] };
  const written: string[] = [];
  const restoreFetch = installFetchTap(calls);
  try {
    // The token is resolved once, before the first capture, so that a refresh
    // TikTok happens to need is recorded as the auth interaction it is instead
    // of being filed under whichever capture went first. It is a plain
    // `getAccessToken()` and never a forced one: forcing would rotate a live
    // refresh token, which is a write to the account's credential state and has
    // no place in a read-only catalog.
    await recorder.api.getAccessToken();
    for (const [index, call] of calls.entries()) {
      written.push(await writeCapture('auth', captureName('token-refresh', index), call));
    }
    calls.length = 0;
    record(
      checks,
      'token',
      true,
      written.length === 0
        ? `the stored access token for ${recorder.profile} is still valid; no refresh to record`
        : `wrote ${written.join(', ')}`,
    );

    for (const spec of selected) {
      const missing = missingScopes(spec, recorder.granted);
      if (missing.length > 0) {
        record(checks, spec.name, true, `skipped (${missing.join(', ')} not granted)`);
        continue;
      }
      written.push(...(await runCapture(spec, recorder.api, state, calls, checks)));
    }
  } catch (err) {
    record(checks, 'recorder', false, message(err));
  } finally {
    restoreFetch();
  }

  if (written.length > 0) process.stdout.write(reminder(written));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    process.stderr.write(
      `${SCRIPT}: ${String(failed.length)} of ${String(checks.length)} steps failed ` +
        `(profile ${recorder.profile}):\n` +
        `${failed.map((check) => `  x ${check.name} — ${check.detail}`).join('\n')}\n`,
    );
    return false;
  }
  process.stdout.write(
    `${SCRIPT}: ${String(checks.length)} steps ran clean against profile ` +
      `${recorder.profile}.\n`,
  );
  return true;
}

if (process.argv[1]?.endsWith('fixtures-record.js') === true) {
  const ok = await runFixturesRecord(process.argv.slice(2), process.env);
  process.exitCode = ok ? 0 : 1;
}
