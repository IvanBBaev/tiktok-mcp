/**
 * `tiktok_post_video` (TOOLS.md § 3.8) — the two-step write contract of § 2.6.
 *
 * This is the only tool that can create something the user cannot undo from
 * here, so the tests are organised around the guarantees that stand between a
 * model and an accidental post rather than around the happy path:
 *
 * - a preview sends nothing to `/publish/` and never spends a rate token;
 * - a preview without `privacy_level` yields **no** `plan_id` (§ 2.6.1 step 4);
 * - the pipeline order of § 2.6.3 holds — the duplicate guard runs *before*
 *   consumption, so a `possible_duplicate` refusal leaves the same `plan_id`
 *   appliable with `force: true`;
 * - a changed payload invalidates the plan (`plan_mismatch`), a spent one is
 *   `plan_not_found`, and both are decided before any network call;
 * - the journal intent is written before the init dispatch and the outcome
 *   after it, with `network_ambiguous` recorded as `send_ambiguous` (CC-B4);
 * - a failed journal write degrades the answer, never the post.
 *
 * `source: "file"` is carried through the same contract in its own section at
 * the end of the file: the chunk plan a preview publishes, the `FILE_UPLOAD`
 * `source_info` and the chunk PUTs an apply sends, the media-root confinement
 * that refuses a path before any request, and the re-stat that sits between the
 * plan guards and the first byte. The upload URL is a credential, so it is
 * asserted absent from every byte the tool hands back or writes down.
 *
 * The § 5.2 trust boundary gets its own case: hints stay inside the vocabulary
 * and the length limit, and no upstream string is ever interpolated into one.
 *
 * Upstream is stubbed by route rather than by call order ({@link fakeApi}): the
 * pipeline reads `creator_info` a second time on the apply call, so an ordered
 * script would encode that re-read as if it were the contract. Every scripted
 * failure is deliberately **non**-retryable (an HTTP-200 error envelope, or a
 * throw on the never-retried `init` class) — a retryable one would park on a
 * `mockClock` backoff that nothing advances, and the test would simply hang.
 */

import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { planChunks } from '../src/api/upload.js';
import { TikTokError } from '../src/core/errors.js';
import { createLogger, type Logger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import {
  peekPublishBucket,
  publishRateLimits,
  resetRateBuckets,
  resolvePublishBucket,
  takePublishToken,
} from '../src/mcp/plan.js';
import {
  outstandingPlans,
  PLAN_ID_PATTERN,
  resetPlanStore,
} from '../src/mcp/plan-store.js';
import {
  HINT_TYPES,
  MAX_HINTS,
  MAX_HINT_CHARS,
  truncateResult,
  type Hint,
  type ToolError,
  type ToolResult,
} from '../src/mcp/result.js';
import {
  checkMediaUrl,
  type AppliedData,
  type DraftPreview,
  type SourceBlock,
  type WritePreview,
} from '../src/tools/publish-common.js';
import {
  postVideoTool,
  uploadVideoDraftTool,
  type PostVideoData,
  type UploadDraftData,
} from '../src/tools/publish-write.js';
import { failRecovery } from '../src/tools/publish.js';
import {
  BASELINE_SCOPES,
  fsSandbox,
  mockClock,
  ttEnvelope,
  withFetch,
  type FetchStub,
  type MockClock,
} from './helpers.js';
import { deferred } from './harness/deferred.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

const VERIFIED_PREFIX = 'https://cdn.example.com/videos/';
const VIDEO_URL = `${VERIFIED_PREFIX}clip.mp4`;

const CREATOR_PATH = '/v2/post/publish/creator_info/query/';
const INIT_PATH = '/v2/post/publish/video/init/';

/** The upstream `creator_info` payload every preview and apply re-reads. */
const CREATOR_PAYLOAD = {
  creator_avatar_url: 'https://p16.tiktokcdn.com/avatar.jpeg',
  creator_username: 'test.creator',
  creator_nickname: 'Test Creator',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 300,
};

function creatorResponse(overrides: Record<string, unknown> = {}): Response {
  return ttEnvelope({ ...CREATOR_PAYLOAD, ...overrides });
}

function initResponse(publishId = 'v_pub_url~test.123'): Response {
  return ttEnvelope({ publish_id: publishId });
}

/**
 * The upload URL a `FILE_UPLOAD` init answers with. The host is one the egress
 * allow-list knows (`core/http`), or `uploadFile` would refuse the transfer
 * before the first PUT and the tests below would prove nothing about chunking.
 * Its `upload_token` query parameter *is* the upload credential.
 */
const UPLOAD_URL =
  'https://open-upload.tiktokapis.com/upload/' +
  '?upload_id=7300000000000000000&upload_token=fake-upload-token-b7c1d9e4';

/** The secret half of {@link UPLOAD_URL}, asserted against on its own. */
const UPLOAD_TOKEN = 'fake-upload-token-b7c1d9e4';

function fileInitResponse(publishId = 'v_pub_file~test.456'): Response {
  return ttEnvelope({ publish_id: publishId, upload_url: UPLOAD_URL });
}

/** What an upload endpoint answers with: a status and no body. */
function bare(status: number): Response {
  return new Response(null, { status });
}

/**
 * The size of every media fixture below.
 *
 * Anything under `MIN_WHOLE_BYTES` is one whole chunk by definition, and the
 * tool never passes a `chunkSizeOverride`, so the arithmetic is asserted
 * against {@link planChunks} rather than hard-coded.
 */
const MEDIA_BYTES = 4096;

/**
 * An upstream refusal that is **not** retryable: HTTP 200 carrying an error
 * envelope, which `core/http` only retries for `internal_error`. Anything
 * retryable would sleep on the mock clock forever.
 */
function refusal(code: string, message: string): Response {
  return ttEnvelope({}, { code, message });
}

type Args = Record<string, unknown>;

/** The smallest argument set that yields a complete plan. */
function previewArgs(overrides: Args = {}): Args {
  return {
    source: 'url',
    video_url: VIDEO_URL,
    title: 'A clip',
    privacy_level: 'SELF_ONLY',
    ...overrides,
  };
}

/** The `source: "file"` twin of {@link previewArgs}. */
function fileArgs(filePath: string, overrides: Args = {}): Args {
  return {
    source: 'file',
    file_path: filePath,
    title: 'A clip',
    privacy_level: 'SELF_ONLY',
    ...overrides,
  };
}

async function run(ctx: ToolCtx, args: Args): Promise<ToolResult<PostVideoData>> {
  return await postVideoTool.handler(postVideoTool.input.parse(args), ctx);
}

/**
 * The same clip for `tiktok_upload_video_draft`, which takes no title and no
 * privacy level — the user sets both in the app (§ 3.9).
 *
 * The draft tool's own contract is covered by `tool-publish-draft.test.ts`; it
 * appears here only because the § 5.2 case at the end of this file has to run
 * the hint chain that `publish-write.ts` composes, and that composition lives
 * in this module rather than in `publish-common`.
 */
function draftArgs(overrides: Args = {}): Args {
  return { source: 'url', video_url: VIDEO_URL, ...overrides };
}

async function runDraft(ctx: ToolCtx, args: Args): Promise<ToolResult<UploadDraftData>> {
  return await uploadVideoDraftTool.handler(uploadVideoDraftTool.input.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// a fetch stub that answers by route, not by position
// ---------------------------------------------------------------------------

/** Per-route handlers; `n` is how many times that route was already asked. */
interface ApiScript {
  creator?: (n: number) => Response | Promise<Response>;
  init?: (n: number) => Response | Promise<Response>;
  status?: (n: number) => Response | Promise<Response>;
  /** Answers chunk PUT number `n`; the default accepts the whole file (201). */
  chunk?: (n: number) => Response | Promise<Response>;
}

interface FakeCall {
  readonly path: string;
  readonly body: unknown;
  /**
   * The signal `core/http` handed to `fetch`. It is a composed signal — the
   * caller's abort source combined with the request timeout — never the
   * caller's own object, so tests assert what it *does*, not what it *is*.
   */
  readonly signal: AbortSignal | null | undefined;
}

/** One chunk PUT, with the framing that decides whether it was a valid chunk. */
interface FakePut {
  readonly url: string;
  readonly contentRange: string | undefined;
  readonly contentType: string | undefined;
  /** Bytes actually drained off the streamed body. */
  readonly bytes: number;
}

interface FakeApi extends FetchStub {
  readonly calls: readonly FakeCall[];
  /** Chunk PUTs in order; empty unless a `source: "file"` apply ran. */
  readonly puts: readonly FakePut[];
}

/**
 * Read a streamed request body to its end and report its length.
 *
 * `uploadFile` streams a chunk straight off the disk, so a body the stub never
 * reads leaves that file handle open for the rest of the process — and the
 * byte count is the only proof the plan and the transfer agree.
 */
async function drainBytes(body: unknown): Promise<number> {
  if (!(body instanceof ReadableStream)) return 0;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value?.length ?? 0;
  }
  return bytes;
}

function fakeApi(script: ApiScript = {}): FakeApi {
  const calls: FakeCall[] = [];
  const puts: FakePut[] = [];
  const seen = { creator: 0, init: 0, status: 0, chunk: 0 };

  /** Record the PUT, drain its body, then hand back the scripted answer. */
  const answerPut = async (
    url: string,
    init: RequestInit | undefined,
    answer: Response | Promise<Response>,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const bytes = await drainBytes(init?.body);
    puts.push({
      url,
      contentRange: headers.get('content-range') ?? undefined,
      contentType: headers.get('content-type') ?? undefined,
      bytes,
    });
    return await answer;
  };

  const stub = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      path,
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
      signal: init?.signal,
    });

    // A chunk PUT is routed by method: it goes to TikTok's opaque upload URL,
    // which is not one of the documented API paths.
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      const n = seen.chunk;
      seen.chunk += 1;
      return answerPut(String(input), init, script.chunk?.(n) ?? bare(201));
    }
    if (path.endsWith('/creator_info/query/')) {
      const n = seen.creator;
      seen.creator += 1;
      return Promise.resolve(script.creator?.(n) ?? creatorResponse());
    }
    if (path.endsWith('/video/init/')) {
      const n = seen.init;
      seen.init += 1;
      return Promise.resolve(script.init?.(n) ?? initResponse());
    }
    if (path.endsWith('/status/fetch/')) {
      const n = seen.status;
      seen.status += 1;
      if (script.status === undefined) {
        throw new Error('fakeApi: unscripted status read');
      }
      return Promise.resolve(script.status(n));
    }
    throw new Error(`fakeApi: unexpected request to ${path}`);
  };

  return Object.assign(stub, { calls, puts });
}

/** Every request path the stub saw, in order. */
function paths(stub: FakeApi): string[] {
  return stub.calls.map((call) => call.path);
}

function countPath(stub: FakeApi, path: string): number {
  return paths(stub).filter((seen) => seen === path).length;
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/**
 * The media root {@link withCtx} configures, given the sandbox directory.
 *
 * It is a *subdirectory* of the sandbox on purpose: the credential file and the
 * journal live in the sandbox root, and nothing that is not media may be
 * reachable through `TT_MEDIA_ROOT`. That also gives every test a ready-made
 * "outside the root, but still inside the sandbox" location.
 */
function mediaRootOf(dir: string): string {
  return join(dir, 'media');
}

/** A media file of exactly `size` bytes inside the media root; returns its path. */
async function writeMedia(dir: string, name: string, size: number): Promise<string> {
  const path = join(mediaRootOf(dir), name);
  await writeFile(path, new Uint8Array(size).fill(7));
  return path;
}

/**
 * A sandboxed tool context: a real credential file (so `open_id` resolves the
 * way it does in production) and the journal beside it.
 */
async function withCtx<T>(
  /** Server settings; an `undefined` value means "not set in the environment". */
  env: Record<string, string | undefined>,
  fn: (ctx: ToolCtx, dir: string, clock: MockClock) => Promise<T>,
  /**
   * The token seam. The default hands out the sandbox's own access token; a
   * test that needs a request to die *before* it is dispatched rejects here,
   * which is the one failure this file can prove never reached TikTok.
   */
  refresh: () => Promise<string> = () => Promise.resolve('test-access-token-DEFAULT'),
): Promise<T> {
  resetPlanStore();
  resetRateBuckets();
  const sandbox = await fsSandbox();
  try {
    const envFile = join(sandbox.dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-secret',
        'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
        'TT_REFRESH_TOKEN=test-refresh-token-DEFAULT',
        'TT_OPEN_ID=test-open-id-DEFAULT',
        `TT_SCOPES=${BASELINE_SCOPES}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    // `source: "file"` needs a configured root, so every context gets one. It
    // changes nothing for the url-only tests — an unused directory — and a test
    // that wants it unset or pointed elsewhere overrides it through `env` like
    // any other setting.
    const mediaRoot = mediaRootOf(sandbox.dir);
    await mkdir(mediaRoot, { recursive: true });
    const vars: Record<string, string> = {
      TT_ENV_FILE: envFile,
      TT_CLIENT_KEY: 'test-client-key',
      TT_CLIENT_SECRET: 'test-secret',
      TT_VERIFIED_URL_PREFIXES: VERIFIED_PREFIX,
      TT_MEDIA_ROOT: mediaRoot,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete vars[key];
      else vars[key] = value;
    }
    const clock = mockClock();
    const api: ApiContext = createApiContext({
      profile: 'DEFAULT',
      settings: loadSettings(vars),
      log: NOOP_LOGGER,
      clock,
      refresh,
    });
    return await fn({ api, log: NOOP_LOGGER }, sandbox.dir, clock);
  } finally {
    resetPlanStore();
    resetRateBuckets();
    await sandbox.cleanup();
  }
}

/** Spend the whole publish budget the way a minute of applies would. */
function drainPublishBucket(ctx: ToolCtx): void {
  const limits = publishRateLimits(ctx.api.settings);
  for (let i = resolvePublishBucket(limits).capacity; i > 0; i -= 1) {
    takePublishToken(ctx.api.profile, ctx.api.clock, limits);
  }
}

/**
 * `base` with a hook on `warn`.
 *
 * `journalOptions` wires `ToolCtx.log` straight into the publish journal, so a
 * warning the journal emits is a synchronous callback at a known point of the
 * pipeline — the one seam a test can use to act *inside* a step of § 2.6.3
 * rather than between two calls.
 */
function hookedLogger(base: Logger, onWarn: (msg: string) => void): Logger {
  const wrapped: Logger = {
    debug: (msg, fields) => {
      base.debug(msg, fields);
    },
    info: (msg, fields) => {
      base.info(msg, fields);
    },
    warn: (msg, fields) => {
      onWarn(msg);
      base.warn(msg, fields);
    },
    error: (msg, fields) => {
      base.error(msg, fields);
    },
    child: () => wrapped,
  };
  return wrapped;
}

/**
 * Await `pending` while pushing virtual time forward in slices.
 *
 * The poll loop registers its next sleep only once the status read before it
 * has resolved, so a single `advance` past the deadline would run out of due
 * waiters and stop early. Stepping — with the microtask queue drained between
 * steps, which `advance` does — walks the whole ladder. The step is smaller
 * than `SLEEP_SLICE_MS` so no bounded slice is ever skipped over.
 */
async function runVirtual<T>(clock: MockClock, pending: Promise<T>): Promise<T> {
  let done = false;
  const settled = pending.finally(() => {
    done = true;
  });
  // A rejection is re-thrown by the `await` below; this only stops Node from
  // calling it unhandled while the loop is still stepping.
  settled.catch(() => undefined);

  // The budget is wall-clock, not a step count. `advance` yields to the event
  // loop once per step, so a fixed number of steps is only a few real
  // milliseconds — less than a loaded machine needs to return a single journal
  // append, and the call would then be failed for someone else's I/O
  // contention (the coverage run puts one process per test file on the box).
  const giveUpAt = Date.now() + 20_000;
  while (!done && Date.now() < giveUpAt) await clock.advance(500);
  assert.ok(done, 'virtual time ran out before the call settled');
  return await settled;
}

function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

function previewOf(result: ToolResult<PostVideoData>): WritePreview {
  const data = dataOf(result);
  assert.ok(data.mode !== 'applied', 'expected a preview, got an applied post');
  return data;
}

function draftPreviewOf(result: ToolResult<UploadDraftData>): DraftPreview {
  const data = dataOf(result);
  assert.ok(data.mode !== 'applied', 'expected a preview, got an applied draft');
  return data;
}

function appliedOf(result: ToolResult<PostVideoData | UploadDraftData>): AppliedData {
  const data = dataOf(result);
  assert.ok(data.mode === 'applied', `expected an applied post, got ${data.mode}`);
  return data;
}

/** The `url` variant of the source block, asserted rather than assumed. */
function urlSource(block: SourceBlock): { type: 'url'; url: string } {
  assert.equal(block.type, 'url');
  assert.ok('url' in block && typeof block.url === 'string');
  return { type: 'url', url: block.url };
}

/** The `file` variant, likewise. */
function fileSource(block: SourceBlock): {
  resolved_path: string;
  file_size: number;
  chunk_summary: { file_size: number; chunk_size: number; chunks: number };
} {
  assert.equal(block.type, 'file');
  assert.ok('resolved_path' in block);
  return block;
}

function errorOf(result: ToolResult<PostVideoData>): ToolError {
  assert.equal(result.ok, false, JSON.stringify(result.data));
  assert.ok(result.error !== undefined);
  return result.error;
}

function hintsOf(result: ToolResult<unknown>): readonly Hint[] {
  return result.hints ?? [];
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

type JournalLine = Record<string, unknown>;

/**
 * The journal as written. A fresh file opens with a `header` record, so every
 * assertion below selects by `type` rather than by index.
 */
async function readJournal(dir: string): Promise<JournalLine[]> {
  const raw = await readFile(join(dir, 'journal.ndjson'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalLine);
}

function linesOf(lines: readonly JournalLine[], type: string): JournalLine[] {
  return lines.filter((line) => line['type'] === type);
}

// ---------------------------------------------------------------------------
// local validation — nothing leaves the process
// ---------------------------------------------------------------------------

test('a URL outside every verified prefix is refused without a request', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ video_url: 'https://evil.example.net/clip.mp4' })),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'url_prefix_unverified');
    assert.ok(error.message.includes('video_url'));
    assert.ok(error.message.includes('TT_VERIFIED_URL_PREFIXES'));
    assert.ok(error.message.includes('No request was sent'));
    assert.equal(stub.calls.length, 0);
  });
});

test('an unconfigured allow-list rejects every URL rather than allowing all', async () => {
  await withCtx({ TT_VERIFIED_URL_PREFIXES: undefined }, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, previewArgs()));
    assert.equal(errorOf(result).code, 'url_prefix_unverified');
    assert.equal(stub.calls.length, 0);
  });
});

test('CC-D10: a host that merely starts with the verified origin is refused without a request', async () => {
  await withCtx({ TT_VERIFIED_URL_PREFIXES: 'https://cdn.example.com' }, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ video_url: 'https://cdn.example.com.attacker.net/v.mp4' })),
    );
    assert.equal(errorOf(result).code, 'url_prefix_unverified');
    assert.equal(stub.calls.length, 0);
  });
});

test('checkMediaUrl matches the origin exactly, never as a string prefix', () => {
  const prefixes = ['https://cdn.example.com'];
  // A look-alike host that begins with the verified one is a different origin.
  assert.equal(
    checkMediaUrl('https://cdn.example.com.attacker.net/v.mp4', 'video_url', prefixes)
      ?.code,
    'url_prefix_unverified',
  );
  // So is the same host on another port.
  assert.equal(
    checkMediaUrl('https://cdn.example.com:8443/v.mp4', 'video_url', prefixes)?.code,
    'url_prefix_unverified',
  );
  // The verified origin itself passes, with or without a path under it.
  assert.equal(
    checkMediaUrl('https://cdn.example.com/v.mp4', 'video_url', prefixes),
    undefined,
  );
  assert.equal(
    checkMediaUrl('https://cdn.example.com', 'video_url', prefixes),
    undefined,
  );
});

test('checkMediaUrl compares hosts case-insensitively, as DNS does', () => {
  assert.equal(
    checkMediaUrl('https://CDN.Example.com/v.mp4', 'video_url', [
      'https://cdn.example.com',
    ]),
    undefined,
  );
  assert.equal(
    checkMediaUrl('https://cdn.example.com/videos/v.mp4', 'video_url', [
      'https://CDN.EXAMPLE.COM/videos/',
    ]),
    undefined,
  );
});

test('checkMediaUrl treats the prefix path as a literal prefix of the pathname', () => {
  const prefixes = [VERIFIED_PREFIX];
  assert.equal(
    checkMediaUrl(`${VERIFIED_PREFIX}clip.mp4`, 'video_url', prefixes),
    undefined,
  );
  assert.equal(
    checkMediaUrl(`${VERIFIED_PREFIX}nested/clip.mp4?sig=1`, 'video_url', prefixes),
    undefined,
  );
  // The path is case-sensitive, unlike the host.
  assert.equal(
    checkMediaUrl('https://cdn.example.com/Videos/clip.mp4', 'video_url', prefixes)?.code,
    'url_prefix_unverified',
  );
  assert.equal(
    checkMediaUrl('https://cdn.example.com/other/clip.mp4', 'video_url', prefixes)?.code,
    'url_prefix_unverified',
  );
});

test('checkMediaUrl skips an unparsable prefix instead of throwing or admitting', () => {
  // Alone, it admits nothing.
  assert.equal(
    checkMediaUrl('https://cdn.example.com/v.mp4', 'video_url', ['not a url'])?.code,
    'url_prefix_unverified',
  );
  // Beside a valid prefix, the valid one still decides.
  assert.equal(
    checkMediaUrl('https://cdn.example.com/v.mp4', 'video_url', [
      'not a url',
      'https://cdn.example.com',
    ]),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// the operator step a refusal names (TOOLS.md § 5.1, § 5.2)
// ---------------------------------------------------------------------------

test('§ 5.1: an unverified media URL carries the host_media user_action', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ video_url: 'https://evil.example.net/clip.mp4' })),
    );

    assert.equal(hintsOf(result).length, 1, 'the step, and nothing else');
    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'user_action');
    assert.equal(hint?.action, 'host_media');
    assert.ok((hint?.text.length ?? 999) <= 300, '§ 5.2 rule 1');
    assert.ok(hint?.text.includes('TT_VERIFIED_URL_PREFIXES'));
    assert.ok(hint?.text.includes('tiktok_post_video'));
    // § 5.2 rule 3: the offending URL is caller-supplied and stays in the
    // error message, which is a data field rather than an instruction channel.
    assert.ok(!hint?.text.includes('evil.example.net'));
    assert.equal(stub.calls.length, 0);
  });
});

test('§ 5.1: a file outside the media root carries the move_file user_action', async () => {
  await withCtx({}, async (ctx, dir) => {
    const outside = join(dir, 'outside.mp4');
    await writeFile(outside, new Uint8Array(MEDIA_BYTES).fill(7));
    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, fileArgs(outside)));

    assert.equal(errorOf(result).code, 'file_outside_media_root');
    assert.equal(hintsOf(result).length, 1);
    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'user_action');
    assert.equal(hint?.action, 'move_file');
    assert.ok((hint?.text.length ?? 999) <= 300, '§ 5.2 rule 1');
    assert.ok(hint?.text.includes('TT_MEDIA_ROOT'));
    assert.ok(hint?.text.includes('tiktok_post_video'));
    // § 5.2 rule 3 again: an env-var *name* is server-owned template text; the
    // resolved path and the root's value are not, and stay in the error.
    assert.ok(!hint?.text.includes(outside));
    assert.ok(!hint?.text.includes(mediaRootOf(dir)));
    assert.equal(stub.calls.length, 0);
  });
});

test('§ 5.1: an upstream url_ownership_unverified refusal still names the step', async () => {
  await withCtx({}, async (ctx) => {
    // CC-D10's other half: the prefix allow-list passes, and TikTok refuses the
    // pull anyway because the domain is not verified in the developer portal.
    // Nothing was created, so the step that unblocks the call is still human.
    const stub = fakeApi({
      init: () => refusal('url_ownership_unverified', 'domain not verified'),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(errorOf(result).code, 'url_prefix_unverified');
    assert.equal(hintsOf(result).length, 1);
    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'user_action');
    assert.equal(hint?.action, 'host_media');
  });
});

test('the allow-list itself cannot be emptied or downgraded to http', () => {
  // A set-but-empty value is a misconfiguration, not a permissive allow-list,
  // and an http prefix would make the pre-flight scheme check unreachable.
  const base = { TT_CLIENT_KEY: 'k', TT_CLIENT_SECRET: 's' };
  assert.throws(
    () => loadSettings({ ...base, TT_VERIFIED_URL_PREFIXES: '' }),
    /at least one/,
  );
  assert.throws(
    () => loadSettings({ ...base, TT_VERIFIED_URL_PREFIXES: 'http://cdn.example.com/' }),
    /https/,
  );
});

test('a non-https URL is invalid_params, not an unverified prefix', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ video_url: 'http://cdn.example.com/videos/clip.mp4' })),
    );
    assert.equal(errorOf(result).code, 'invalid_params');
    assert.equal(stub.calls.length, 0);
  });
});

test('a video_url the schema takes but the URL parser refuses is invalid_params', async () => {
  await withCtx({}, async (ctx) => {
    // `video_url` is a non-empty *string* in the schema, not a URL: a bare file
    // name is exactly what a model reaches for when it confuses the two
    // sources. Parsing is the first check in the chain, so the answer names the
    // real problem instead of the prefix allow-list, which cannot even be
    // consulted for something that has no origin.
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ video_url: 'clip.mp4' })),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'invalid_params');
    assert.ok(error.message.includes('video_url: must be an absolute URL'));
    assert.equal(stub.calls.length, 0);
  });
});

test('cc-d10: a URL carrying credentials is refused before TikTok can be handed them', async () => {
  await withCtx({ TT_VERIFIED_URL_PREFIXES: 'https://cdn.example.com/' }, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(
        ctx,
        previewArgs({ video_url: 'https://user:pass@cdn.example.com/videos/clip.mp4' }),
      ),
    );
    const error = errorOf(result);
    assert.equal(error.code, 'invalid_params');
    assert.ok(error.message.includes('credentials'));
    // The password must not survive into the answer.
    assert.ok(!JSON.stringify(result).includes('pass@'));
    assert.equal(stub.calls.length, 0);
  });
});

test('a plan_id that is not this server’s shape is rejected before any network call', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ plan_id: 'plan_not-hex' })),
    );
    const error = errorOf(result);
    assert.equal(error.code, 'invalid_params');
    assert.ok(error.message.includes('plan_id'));
    assert.equal(stub.calls.length, 0);
  });
});

test('an unknown argument is rejected by the strict schema (CC-G1)', () => {
  assert.throws(() => postVideoTool.input.parse(previewArgs({ privacy: 'SELF_ONLY' })));
});

// ---------------------------------------------------------------------------
// preview (§ 2.6.1)
// ---------------------------------------------------------------------------

test('a preview reads creator_info and posts nothing to /publish/video/init/', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, previewArgs()));

    assert.equal(previewOf(result).mode, 'plan');
    assert.deepEqual(paths(stub), [CREATOR_PATH]);
  });
});

test('a complete preview mints a single-use plan bound to the payload', async () => {
  await withCtx({}, async (ctx) => {
    const result = await withFetch(fakeApi(), async () => run(ctx, previewArgs()));

    const data = previewOf(result);
    assert.equal(data.mode, 'plan');
    assert.ok(data.plan_id !== undefined);
    assert.match(data.plan_id, PLAN_ID_PATTERN);
    // 600 s past the mock clock's baseline, as an absolute ISO-8601 UTC instant.
    assert.equal(data.expires_at, '2026-01-01T00:10:00.000Z');
    assert.equal(data.action, 'DIRECT_POST video');
    assert.equal(data.account.profile, 'DEFAULT');
    assert.equal(data.account.nickname, 'Test Creator');
    // § 2.5: the raw open_id never appears, not even in the account block.
    assert.ok(!JSON.stringify(data).includes('test-open-id-DEFAULT'));
    assert.equal(urlSource(data.payload.source).url, VIDEO_URL);
    assert.equal(data.payload.post_info?.['privacy_level'], 'SELF_ONLY');
    assert.ok(data.consent_line.includes('Music Usage Confirmation'));

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'approval_required');
    assert.equal(hint?.plan_id, data.plan_id);
    assert.equal(hint?.expires_at, data.expires_at);
  });
});

test('cc-e5: the preview shows the duration cap this server cannot enforce', async () => {
  // There is no media probing here, so a too-long video is only ever refused
  // asynchronously, by TikTok, after the bytes are spent. The one thing that
  // can be done locally is putting the cap in front of the human who approves
  // — which means it has to survive on the incomplete preview too, the shape
  // shown *before* anyone has committed to a privacy level.
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () => creatorResponse({ max_video_post_duration_sec: 60 }),
    });
    await withFetch(stub, async () => {
      const complete = previewOf(await run(ctx, previewArgs()));
      const incomplete = previewOf(
        await run(ctx, previewArgs({ privacy_level: undefined })),
      );
      for (const data of [complete, incomplete]) {
        assert.equal(data.creator.max_video_post_duration_sec, 60);
      }
    });
  });
});

test('a creator_info with no duration cap omits the field instead of reporting zero', async () => {
  // The upstream field is optional (an unaudited app never sees one), and the
  // block is what the human approves against. A `0` there reads as "no video
  // may be longer than nothing"; an absent cap has to stay an absent key.
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () => creatorResponse({ max_video_post_duration_sec: undefined }),
    });
    await withFetch(stub, async () => {
      const complete = previewOf(await run(ctx, previewArgs()));
      const incomplete = previewOf(
        await run(ctx, previewArgs({ privacy_level: undefined })),
      );
      for (const data of [complete, incomplete]) {
        assert.equal('max_video_post_duration_sec' in data.creator, false);
        assert.equal(data.creator.privacy_level_options.length, 2);
      }
    });
  });
});

test('a credential file with no open_id still previews, masked to the placeholder', async () => {
  await withCtx({}, async (ctx, dir) => {
    // The credential store is re-read per call (TOOLS.md § 6.2), so a file that
    // carries no `TT_OPEN_ID` — a hand-edited env, or a login that never wrote
    // one — is what the next preview resolves against. The account block still
    // has to render, and the empty id has to mask like any other: to the
    // placeholder, never to a raw value and never to `undefined`.
    await writeFile(
      join(dir, '.tiktok-mcp.env'),
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-secret',
        'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
        'TT_REFRESH_TOKEN=test-refresh-token-DEFAULT',
        `TT_SCOPES=${BASELINE_SCOPES}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, previewArgs()));

    const data = previewOf(result);
    assert.equal(data.account.open_id_masked, '…');
    assert.equal(data.account.profile, 'DEFAULT');
    assert.match(data.plan_id ?? '', PLAN_ID_PATTERN);
    assert.equal(countPath(stub, CREATOR_PATH), 1);
  });
});

test('a preview reports the rate bucket without spending from it', async () => {
  await withCtx({}, async (ctx) => {
    await withFetch(fakeApi(), async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const second = previewOf(await run(ctx, previewArgs()));
      assert.equal(first.meta.rate_bucket.tokens_available, 6);
      assert.equal(second.meta.rate_bucket.tokens_available, 6);
    });
  });
});

test('the reported bucket is the one TT_PUBLISH_RPM configured', async () => {
  await withCtx({ TT_PUBLISH_RPM: '20' }, async (ctx, _dir, clock) => {
    await withFetch(fakeApi(), async () => {
      const full = previewOf(await run(ctx, previewArgs())).meta.rate_bucket;
      assert.equal(full.tokens_available, 20, 'the burst the operator asked for');

      takePublishToken(ctx.api.profile, clock, publishRateLimits(ctx.api.settings));
      const spent = previewOf(await run(ctx, previewArgs())).meta.rate_bucket;
      assert.equal(spent.tokens_available, 19);
      // 20/min is a token every 3 s, so that is what the model is told to
      // pace itself against — not the default's 10.
      assert.equal(Date.parse(spent.next_token_at ?? ''), clock.now() + 3_000);
    });
  });
});

test('a preview without privacy_level returns the options and NO plan_id', async () => {
  await withCtx({}, async (ctx) => {
    const result = await withFetch(fakeApi(), async () =>
      run(ctx, previewArgs({ privacy_level: undefined })),
    );

    const data = previewOf(result);
    assert.equal(data.mode, 'plan_incomplete');
    assert.equal(data.plan_id, undefined);
    assert.equal(data.expires_at, undefined);
    assert.deepEqual(data.missing, ['privacy_level']);
    assert.deepEqual(data.creator.privacy_level_options, [
      'PUBLIC_TO_EVERYONE',
      'SELF_ONLY',
    ]);
    // Nothing was resolved, so nothing is presented as if it had been.
    assert.equal(data.payload.post_info, undefined);
    assert.ok(hintsOf(result).every((hint) => hint.type !== 'approval_required'));
    assert.ok(hintsOf(result)[0]?.text.includes('PUBLIC_TO_EVERYONE'));
  });
});

test('an unaudited account carries the SELF_ONLY warning on every preview shape', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () => creatorResponse({ privacy_level_options: ['SELF_ONLY'] }),
    });
    await withFetch(stub, async () => {
      const complete = await run(ctx, previewArgs());
      const incomplete = await run(ctx, previewArgs({ privacy_level: undefined }));
      for (const result of [complete, incomplete]) {
        assert.equal(previewOf(result).audit_restrictions_active, true);
        assert.ok(hintsOf(result).some((hint) => hint.text.includes('SELF_ONLY')));
      }
    });
  });
});

test('a brand toggle changes the consent line the user has to approve', async () => {
  await withCtx({}, async (ctx) => {
    const result = await withFetch(fakeApi(), async () =>
      run(
        ctx,
        previewArgs({ privacy_level: 'PUBLIC_TO_EVERYONE', brand_organic_toggle: true }),
      ),
    );
    assert.ok(previewOf(result).consent_line.includes('Branded Content Policy'));
  });
});

test('creator settings that override a caller’s toggle are reported as derived', async () => {
  await withCtx({}, async (ctx) => {
    const result = await withFetch(fakeApi(), async () =>
      run(ctx, previewArgs({ disable_duet: false })),
    );
    const data = previewOf(result);
    // The fixture's account disables duets; a `false` cannot override it.
    assert.equal(data.payload.post_info?.['disable_duet'], true);
    assert.ok(data.derived?.some((entry) => entry.field === 'disable_duet'));
  });
});

test('every optional flag the caller sets reaches post_info under its upstream name', async () => {
  await withCtx({}, async (ctx) => {
    const result = await withFetch(fakeApi(), async () =>
      run(
        ctx,
        previewArgs({
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_comment: true,
          disable_stitch: true,
          video_cover_timestamp_ms: 1500,
          brand_content_toggle: true,
          is_aigc: true,
        }),
      ),
    );

    // Snake case stops at the tool boundary, so the payload the user approves is
    // the payload TikTok is sent — an argument silently dropped here would be a
    // post that does not match its own preview.
    assert.deepEqual(previewOf(result).payload.post_info, {
      title: 'A clip',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
      video_cover_timestamp_ms: 1500,
      brand_content_toggle: true,
      brand_organic_toggle: false,
      is_aigc: true,
    });
  });
});

test('cc-e2: brand_content_toggle with SELF_ONLY is refused at preview and mints no plan', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: 'SELF_ONLY', brand_content_toggle: true })),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'branded_content_privacy_conflict');
    assert.equal(error.retryable, false);
    // The preview read creator_info and then stopped: no plan to approve, and
    // nothing that could be applied later.
    assert.equal(countPath(stub, INIT_PATH), 0);
    assert.equal(result.data, undefined);
  });
});

test('cc-e1: a privacy level the account does not offer is refused at preview', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () => creatorResponse({ privacy_level_options: ['SELF_ONLY'] }),
    });
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: 'PUBLIC_TO_EVERYONE' })),
    );

    assert.equal(errorOf(result).code, 'privacy_level_unavailable');
    assert.ok(errorOf(result).message.includes('SELF_ONLY'));
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('a creator_info refusal fails the preview instead of planning without it', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () => refusal('creator_info_broken', 'the creator query failed'),
    });
    const result = await withFetch(stub, async () => run(ctx, previewArgs()));

    // A plan the user could approve must never be minted from creator state the
    // server could not read (§ 2.6.1): the preview is an error, not a guess.
    const error = errorOf(result);
    assert.equal(error.code, 'upstream_error');
    assert.equal(error.retryable, false);
    assert.equal(
      (error.details as Record<string, unknown>)['api_code'],
      'creator_info_broken',
    );
    assert.equal(result.data, undefined);
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

// ---------------------------------------------------------------------------
// execute (§ 2.6.3)
// ---------------------------------------------------------------------------

test('apply posts the previewed payload and returns publish_id with a poll hint', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_pub_url~test.123');
    assert.equal(data.status, 'PROCESSING_DOWNLOAD');
    assert.equal(data.journal, 'recorded');

    // § 2.6.3 re-resolves the payload against live creator settings before it
    // trusts the plan, so the apply reads creator_info again (CC-E1).
    assert.deepEqual(paths(stub), [CREATOR_PATH, CREATOR_PATH, INIT_PATH]);
    const body = stub.calls[2]?.body as Record<string, unknown>;
    assert.deepEqual(body['source_info'], {
      source: 'PULL_FROM_URL',
      video_url: VIDEO_URL,
    });

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'poll');
    assert.equal(hint?.tool, 'tiktok_get_publish_status');
    assert.equal(hint?.publish_id, 'v_pub_url~test.123');
    assert.ok(hint?.poll_after !== undefined);

    const journal = await readJournal(dir);
    assert.equal(journal[0]?.['type'], 'header');
    const [intent] = linesOf(journal, 'intent');
    const [outcome] = linesOf(journal, 'outcome');
    assert.equal(intent?.['tool'], 'tiktok_post_video');
    assert.equal(outcome?.['result'], 'ok');
    assert.equal(outcome?.['publish_id'], 'v_pub_url~test.123');
    assert.equal(outcome?.['attempt_id'], intent?.['attempt_id']);
  });
});

test('the intent is journaled before the request leaves and carries the plan it spent', async () => {
  await withCtx({}, async (ctx, dir) => {
    let atDispatch: JournalLine[] = [];
    const stub = fakeApi({
      init: async () => {
        atDispatch = await readJournal(dir);
        return initResponse();
      },
    });

    const planId = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      return preview.plan_id;
    });

    const intents = linesOf(atDispatch, 'intent');
    assert.equal(intents.length, 1);
    assert.equal(linesOf(atDispatch, 'outcome').length, 0);
    assert.equal(intents[0]?.['plan_id'], planId);
    assert.equal(intents[0]?.['source'], 'PULL_FROM_URL');
    assert.equal(intents[0]?.['title_excerpt'], 'A clip');
  });
});

test('a plan is single-use: the second apply is plan_not_found and sends nothing', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(errorOf(result).code, 'plan_not_found');
    // The second apply re-resolves, then stops at verification — before a
    // second init.
    assert.equal(countPath(stub, INIT_PATH), 1);
  });
});

test('changing an argument after the preview invalidates the plan', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, title: 'A different clip' }),
      );
    });

    assert.equal(errorOf(result).code, 'plan_mismatch');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('an unknown plan_id is plan_not_found', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ plan_id: `plan_${'0'.repeat(32)}` })),
    );
    assert.equal(errorOf(result).code, 'plan_not_found');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('TT_WRITE_MODE=apply executes without a plan_id and journals an empty plan', async () => {
  await withCtx({ TT_WRITE_MODE: 'apply' }, async (ctx, dir) => {
    const result = await withFetch(fakeApi(), async () => run(ctx, previewArgs()));

    assert.equal(appliedOf(result).publish_id, 'v_pub_url~test.123');
    // The honest record of "nothing approved this".
    assert.equal(linesOf(await readJournal(dir), 'intent')[0]?.['plan_id'], '');
  });
});

test('TT_WRITE_MODE=apply still refuses to post without a privacy_level', async () => {
  await withCtx({ TT_WRITE_MODE: 'apply' }, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: undefined })),
    );

    // The field is optional in the schema only so § 2.6.1 can answer with the
    // options; executing without one would let the server pick the audience.
    const error = errorOf(result);
    assert.equal(error.code, 'invalid_params');
    assert.ok(error.message.includes('privacy_level'));
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('a creator_info refusal on the apply stops the post before the init', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      creator: (n) =>
        n === 0
          ? creatorResponse()
          : refusal('creator_info_broken', 'the creator query failed'),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    // CC-E1: the apply re-reads creator state, so a failure there is a failure of
    // the apply — the approved plan is not applied against stale settings.
    const error = errorOf(result);
    assert.equal(error.code, 'upstream_error');
    assert.equal(error.retryable, false);
    assert.equal(countPath(stub, INIT_PATH), 0);
    // The failure is pre-dispatch, so the journal was never even opened.
    await assert.rejects(
      async () => await readJournal(dir),
      (cause: NodeJS.ErrnoException) => cause.code === 'ENOENT',
    );
  });
});

test('a post with no title sends no title field and journals an empty one', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs({ title: undefined })));
      // An absent caption is absent upstream, not an empty string: TikTok treats
      // `""` as a caption the user wrote.
      assert.equal('title' in (preview.payload.post_info ?? {}), false);
      return await run(ctx, previewArgs({ title: undefined, plan_id: preview.plan_id }));
    });

    assert.equal(appliedOf(result).publish_id, 'v_pub_url~test.123');
    const body = stub.calls[2]?.body as Record<string, unknown>;
    assert.equal('title' in (body['post_info'] as Record<string, unknown>), false);
    // `title_excerpt` is a human label for the attempt, not the payload, so an
    // untitled post is recorded with an empty one rather than skipping the field.
    assert.equal(linesOf(await readJournal(dir), 'intent')[0]?.['title_excerpt'], '');
  });
});

test('the local rate limit refuses before any network call and never spends the plan', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      drainPublishBucket(ctx);
      const refused = await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(errorOf(refused).code, 'local_rate_limited');
      assert.equal(stub.calls.length, 1);

      // The refusal cost nothing: with a token back, the same plan still applies.
      resetRateBuckets();
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(appliedOf(result).publish_id, 'v_pub_url~test.123');
  });
});

test('a rate-limit refusal carries a wait hint with an absolute instant', async () => {
  await withCtx({}, async (ctx) => {
    const result = await withFetch(fakeApi(), async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      drainPublishBucket(ctx);
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'wait');
    assert.ok(hint?.retry_at?.endsWith('Z'));
    assert.equal(typeof hint?.retry_after_s, 'number');
  });
});

test('a refusal that never reaches an init leaves the rate bucket untouched', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const limits = publishRateLimits(ctx.api.settings);
    const tokens = (): number =>
      peekPublishBucket(ctx.api.profile, ctx.api.clock, limits).tokens_available;

    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      const budget = tokens();

      // § 2.6.3 step 2 only reads the bucket; the token is taken at step 7,
      // once nothing else can still say no. A caller who mistypes a plan_id
      // therefore pays nothing — the alternative charged a minute's publish
      // budget for a request TikTok never saw.
      const unknown = await run(ctx, previewArgs({ plan_id: `plan_${'0'.repeat(32)}` }));
      assert.equal(errorOf(unknown).code, 'plan_not_found');
      const changed = await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, title: 'A different clip' }),
      );
      assert.equal(errorOf(changed).code, 'plan_mismatch');
      assert.equal(countPath(stub, INIT_PATH), 0);
      assert.equal(tokens(), budget, 'a rejected plan_id must not spend a token');

      // The plan the caller did approve is still good, and paying for it is
      // what moves the bucket.
      const applied = await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(appliedOf(applied).publish_id, 'v_pub_url~test.123');
      assert.equal(tokens(), budget - 1);

      // Same for the duplicate guard, which also refuses ahead of step 7.
      const second = previewOf(await run(ctx, previewArgs()));
      const duplicate = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      assert.equal(errorOf(duplicate).code, 'possible_duplicate');
      assert.equal(tokens(), budget - 1);
    });
  });
});

test('cc-g5: a bucket emptied between the step-2 peek and the step-7 take refuses unspent', async () => {
  await withCtx({}, async (ctx) => {
    // Step 2 only peeks; the token is taken at step 7, and the apply's own
    // `creator_info` re-read sits between them. A second apply on the same
    // profile can empty the bucket inside that window — the only way the take
    // can fail after the peek said yes. Draining from inside the re-read is
    // that interleaving, made deterministic.
    const stub = fakeApi({
      creator: (n) => {
        if (n === 1) drainPublishBucket(ctx);
        return creatorResponse();
      },
    });

    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      const refused = await run(ctx, previewArgs({ plan_id: preview.plan_id }));

      assert.equal(errorOf(refused).code, 'local_rate_limited');
      assert.equal(hintsOf(refused)[0]?.type, 'wait');
      assert.equal(countPath(stub, INIT_PATH), 0);

      // The refusal lands before the plan is consumed, which is the whole
      // reason the bucket is peeked again ahead of it: the same plan_id still
      // applies once the caller has waited the bucket out.
      resetRateBuckets();
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(appliedOf(result).publish_id, 'v_pub_url~test.123');
  });
});

test('cc-h1: a plan that expires inside the duplicate-guard read is refused at step 7', async () => {
  await withCtx({}, async (ctx, dir, clock) => {
    // Steps 5 and 7 both check the plan and the guard's journal read sits
    // between them, so the re-check at step 7 is not ceremony: the plan can
    // stop being applicable inside that window. A machine that suspends over
    // the read (CC-H1) wakes with the TTL already gone — `verifyPlan` said yes
    // and `consumePlan` still has to be allowed to say no.
    //
    // The window is entered through documented seams only. A directory where
    // the journal file belongs makes the guard's read fail, and the failure is
    // reported through the injected `ctx.log`; that callback is provably after
    // step 5 and before step 7, and the injected clock moves from inside it.
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });

    let suspensions = 0;
    const armed: ToolCtx = {
      ...ctx,
      log: hookedLogger(ctx.log, (msg) => {
        if (!msg.includes('duplicate check')) return;
        suspensions += 1;
        clock.setNow(clock.now() + ctx.api.settings.planTtlS * 1_000);
      }),
    };

    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(armed, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(suspensions, 1, 'the clock must have moved inside the guard');
    assert.equal(errorOf(result).code, 'plan_not_found');
    // Nothing was dispatched, and the expired entry is gone rather than left
    // behind for a later call to trip over.
    assert.equal(countPath(stub, INIT_PATH), 0);
    assert.equal(outstandingPlans(), 0);
  });
});

test('a plan lost inside the duplicate-guard read costs no rate token', async () => {
  // Same window as above, entered the same way, but with a one-second TTL so
  // the suspension that kills the plan is far too short to refill a token: a
  // token taken ahead of the consume would still be missing afterwards.
  await withCtx({ TT_PLAN_TTL_S: '1' }, async (ctx, dir, clock) => {
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });
    const armed: ToolCtx = {
      ...ctx,
      log: hookedLogger(ctx.log, (msg) => {
        if (msg.includes('duplicate check')) clock.setNow(clock.now() + 1_000);
      }),
    };
    const limits = publishRateLimits(ctx.api.settings);
    const tokens = (): number =>
      peekPublishBucket(ctx.api.profile, ctx.api.clock, limits).tokens_available;

    const stub = fakeApi();
    const before = tokens();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(armed, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(errorOf(result).code, 'plan_not_found');
    assert.equal(countPath(stub, INIT_PATH), 0);
    assert.equal(tokens(), before, 'a refused consume leaves the bucket as it found it');
  });
});

// ---------------------------------------------------------------------------
// duplicate guard (§ 2.6.5)
// ---------------------------------------------------------------------------

test('an identical payload within the window is refused, and the refusal keeps the plan appliable', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      init: (n) => initResponse(n === 0 ? 'v_pub_url~first.1' : 'v_pub_url~second.2'),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: first.plan_id }));

      const second = previewOf(await run(ctx, previewArgs()));
      const refused = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      const error = errorOf(refused);
      assert.equal(error.code, 'possible_duplicate');
      assert.ok(error.message.includes("outcome 'ok'"));
      assert.ok(error.message.includes('v_pub_url~first.1'));
      assert.ok(error.message.includes('force: true'));

      // § 2.6.3: the guard runs BEFORE consumption, so the very same plan_id
      // is still the token that applies once the user has verified.
      const forced = await run(
        ctx,
        previewArgs({ plan_id: second.plan_id, force: true }),
      );
      assert.equal(appliedOf(forced).publish_id, 'v_pub_url~second.2');
    });
  });
});

test('a journaled failure does not trip the duplicate guard', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: (n) => (n === 0 ? refusal('invalid_param', 'bad request') : initResponse()),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const failed = await run(ctx, previewArgs({ plan_id: first.plan_id }));
      assert.equal(failed.ok, false);

      const second = previewOf(await run(ctx, previewArgs()));
      const retried = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      assert.equal(appliedOf(retried).publish_id, 'v_pub_url~test.123');
    });

    // Only `ok`, `send_ambiguous` and a missing outcome trip the guard — a
    // recorded `error` is proof that nothing reached TikTok.
    assert.equal(linesOf(await readJournal(dir), 'outcome')[0]?.['result'], 'error');
  });
});

/**
 * The in-process twin of the journal guard. With the journal unreadable and
 * unwritable (a directory where the file belongs), the journal can neither
 * record the first apply nor refuse the second, so the only thing standing
 * between two concurrent applies of the same payload is the in-flight map.
 */
async function withGatedInit<T>(
  settle: (n: number) => Response,
  fn: (
    ctx: ToolCtx,
    stub: FakeApi,
    sent: Promise<void>,
    release: () => void,
  ) => Promise<T>,
): Promise<T> {
  return await withCtx({}, async (ctx, dir) => {
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });
    const sent = deferred();
    const gate = deferred();
    const stub = fakeApi({
      init: async (n) => {
        if (n === 0) {
          sent.resolve();
          await gate.promise;
        }
        return settle(n);
      },
    });
    return await withFetch(stub, () =>
      fn(ctx, stub, sent.promise, () => {
        gate.resolve();
      }),
    );
  });
}

function assertInFlight(result: ToolResult<PostVideoData>): void {
  const error = errorOf(result);
  assert.equal(error.code, 'possible_duplicate');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, { in_flight: true });
  assert.ok(error.message.includes("account 'DEFAULT'"));
  assert.ok(error.message.includes('force: true'));
}

/** Rewrites the `profile` every journaled intent carries — another account's history. */
async function reassignJournal(dir: string, profile: string): Promise<void> {
  const path = join(dir, 'journal.ndjson');
  const raw = await readFile(path, 'utf8');
  assert.ok(raw.includes('"profile":"DEFAULT"'), 'the intent carries its profile');
  await writeFile(path, raw.replaceAll('"profile":"DEFAULT"', `"profile":"${profile}"`));
}

test("the duplicate guard is per account: another profile's identical post does not trip it", async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: (n) => initResponse(n === 0 ? 'v_pub_url~first.1' : 'v_pub_url~second.2'),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: first.plan_id }));
      // The same video on a second account is a second post, not the first one
      // twice — a guard shared across profiles would refuse it as a duplicate.
      await reassignJournal(dir, 'BRAND');

      const second = previewOf(await run(ctx, previewArgs()));
      const applied = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      assert.equal(appliedOf(applied).publish_id, 'v_pub_url~second.2');
    });
  });
});

test('the duplicate guard compares profiles canonically and names the one it matched', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi();

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: first.plan_id }));
      // A line written under another spelling of this same profile (CC-F4).
      await reassignJournal(dir, 'default');

      const second = previewOf(await run(ctx, previewArgs()));
      const error = errorOf(await run(ctx, previewArgs({ plan_id: second.plan_id })));
      assert.equal(error.code, 'possible_duplicate');
      assert.ok(error.message.includes("on account 'default'"), error.message);
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

test('a second apply of the same payload is refused while the first is being sent', async () => {
  await withGatedInit(
    (n) => initResponse(`v_pub_url~call.${String(n)}`),
    async (ctx, stub, sent, release) => {
      const first = previewOf(await run(ctx, previewArgs()));
      const second = previewOf(await run(ctx, previewArgs()));
      assert.notEqual(first.plan_id, second.plan_id);

      const pending = run(ctx, previewArgs({ plan_id: first.plan_id }));
      await sent;
      assertInFlight(await run(ctx, previewArgs({ plan_id: second.plan_id })));
      assert.equal(countPath(stub, INIT_PATH), 1);

      release();
      assert.equal(appliedOf(await pending).publish_id, 'v_pub_url~call.0');

      // Settled, so released: the refused plan was never spent and applies now.
      const again = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~call.1');
    },
  );
});

test('a dispatch that fails still releases its payload for the next apply', async () => {
  await withGatedInit(
    (n) => (n === 0 ? refusal('invalid_param', 'bad request') : initResponse()),
    async (ctx, _stub, sent, release) => {
      const first = previewOf(await run(ctx, previewArgs()));
      const second = previewOf(await run(ctx, previewArgs()));

      const pending = run(ctx, previewArgs({ plan_id: first.plan_id }));
      await sent;
      assertInFlight(await run(ctx, previewArgs({ plan_id: second.plan_id })));

      release();
      assert.equal((await pending).ok, false);

      const again = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~test.123');
    },
  );
});

test('force: true passes an in-flight payload, and each dispatch releases its own hold', async () => {
  await withGatedInit(
    (n) => initResponse(`v_pub_url~call.${String(n)}`),
    async (ctx, _stub, sent, release) => {
      const first = previewOf(await run(ctx, previewArgs()));
      const forcedPlan = previewOf(await run(ctx, previewArgs()));
      const third = previewOf(await run(ctx, previewArgs()));

      const pending = run(ctx, previewArgs({ plan_id: first.plan_id }));
      await sent;

      // Forced, so not refused — and it registers a second hold on the key.
      const forced = await run(
        ctx,
        previewArgs({ plan_id: forcedPlan.plan_id, force: true }),
      );
      assert.equal(appliedOf(forced).publish_id, 'v_pub_url~call.1');

      // The forced dispatch released only its own hold: the first still counts.
      assertInFlight(await run(ctx, previewArgs({ plan_id: third.plan_id })));

      release();
      assert.equal(appliedOf(await pending).publish_id, 'v_pub_url~call.0');

      const again = await run(ctx, previewArgs({ plan_id: third.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~call.2');
    },
  );
});

test('two concurrent identical applies: exactly one is sent, the other is refused as in flight', async () => {
  await withCtx({}, async (ctx) => {
    // Both applies are held at their `creator_info` re-read until each has
    // asked, then released together, so they reach the plan guards in the same
    // turn of the event loop. The journal is a real file here, so its read
    // yields to disk I/O — the window in which a hold registered only *after*
    // the read would let the second apply through the check as well. The first
    // init is held too, so the winner is still in flight when the loser lands.
    const bothAsked = deferred();
    const initGate = deferred();
    const stub = fakeApi({
      creator: async (n) => {
        if (n === 3) bothAsked.resolve();
        if (n >= 2) await bothAsked.promise;
        return creatorResponse();
      },
      init: async (n) => {
        if (n === 0) await initGate.promise;
        return initResponse(`v_pub_url~call.${String(n)}`);
      },
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const second = previewOf(await run(ctx, previewArgs()));

      const applies = [
        run(ctx, previewArgs({ plan_id: first.plan_id })),
        run(ctx, previewArgs({ plan_id: second.plan_id })),
      ];
      const loser = await Promise.race(applies);
      assertInFlight(loser);

      initGate.resolve();
      const settled = await Promise.all(applies);
      const applied = settled.filter((result) => result.ok);
      assert.equal(applied.length, 1, 'exactly one apply proceeds');
      assert.equal(
        appliedOf(applied[0] as ToolResult<PostVideoData>).publish_id,
        'v_pub_url~call.0',
      );
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

test('a journal possible_duplicate refusal releases its in-flight hold', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: (n) => initResponse(`v_pub_url~call.${String(n)}`),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: first.plan_id }));

      const second = previewOf(await run(ctx, previewArgs()));
      const refused = errorOf(await run(ctx, previewArgs({ plan_id: second.plan_id })));
      assert.equal(refused.code, 'possible_duplicate');
      assert.notDeepEqual(refused.details, { in_flight: true }, 'the journal refused it');

      // Take the journal's match away: another account's history does not trip
      // the guard. What is left to refuse an unforced apply is a leaked hold.
      await reassignJournal(dir, 'BRAND');
      const again = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~call.1');
    });
  });
});

test('a rate refusal inside the plan guards releases its in-flight hold', async () => {
  await withCtx({}, async (ctx) => {
    // Drained from inside the apply's `creator_info` re-read, so the step-2
    // check passes and the refusal comes from the guards' own peek — after the
    // hold was registered.
    const stub = fakeApi({
      creator: (n) => {
        if (n === 1) drainPublishBucket(ctx);
        return creatorResponse();
      },
    });

    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      const refused = await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(errorOf(refused).code, 'local_rate_limited');
      assert.equal(countPath(stub, INIT_PATH), 0);

      resetRateBuckets();
      const again = await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~test.123');
    });
  });
});

test('a plan refusal inside the plan guards releases its in-flight hold', async () => {
  await withCtx({}, async (ctx, dir, clock) => {
    // The plan expires inside the duplicate-guard read (see cc-h1 above), so
    // `consumePlan` refuses it after the hold was registered.
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });
    let armed = true;
    const suspending: ToolCtx = {
      ...ctx,
      log: hookedLogger(ctx.log, (msg) => {
        if (!armed || !msg.includes('duplicate check')) return;
        armed = false;
        clock.setNow(clock.now() + ctx.api.settings.planTtlS * 1_000);
      }),
    };

    const stub = fakeApi();
    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      const refused = await run(suspending, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(errorOf(refused).code, 'plan_not_found');
      assert.equal(countPath(stub, INIT_PATH), 0);

      const fresh = previewOf(await run(ctx, previewArgs()));
      const again = await run(ctx, previewArgs({ plan_id: fresh.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~test.123');
    });
  });
});

test('a throw inside the plan guards after the hold is taken releases the hold', async () => {
  await withCtx({}, async (ctx) => {
    // A settings read that fails once, at the first place the apply reads it:
    // the journal options the duplicate check builds — past the in-flight
    // registration, before the plan is consumed or a token is taken.
    const settings = ctx.api.settings;
    let armed = false;
    let thrownFrom = '';
    const trapped: typeof settings = {
      ...settings,
      get journalMaxBytes(): number {
        if (armed) {
          armed = false;
          const error = new Error('settings store unavailable');
          thrownFrom = error.stack ?? '';
          throw error;
        }
        return settings.journalMaxBytes;
      },
    };
    const failing: ToolCtx = { ...ctx, api: { ...ctx.api, settings: trapped } };

    const stub = fakeApi();
    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));

      armed = true;
      await assert.rejects(
        run(failing, previewArgs({ plan_id: preview.plan_id })),
        /settings store unavailable/,
      );
      // Not vacuous: the throw came from inside the guards, after the hold.
      assert.ok(thrownFrom.includes('runPlanGuards'), thrownFrom);
      assert.equal(countPath(stub, INIT_PATH), 0);

      // The plan was never consumed; a leaked hold would refuse it as in flight.
      const again = await run(failing, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(appliedOf(again).publish_id, 'v_pub_url~test.123');
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

// ---------------------------------------------------------------------------
// network taxonomy (CC-B4)
// ---------------------------------------------------------------------------

test('an ambiguous transport failure is journaled as send_ambiguous and forbids a retry', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: () => {
        throw new TypeError('fetch failed');
      },
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const error = errorOf(result);
    assert.equal(error.code, 'network_ambiguous');
    assert.equal(error.retryable, false);
    assert.ok(error.message.includes('Do NOT apply again'));

    const [outcome] = linesOf(await readJournal(dir), 'outcome');
    assert.equal(outcome?.['result'], 'send_ambiguous');
    assert.equal(outcome?.['error_code'], 'network_ambiguous');
  });
});

test('an ambiguous attempt trips the duplicate guard on the next identical apply', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      init: (n) => {
        if (n === 0) throw new TypeError('fetch failed');
        return initResponse();
      },
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: first.plan_id }));

      const second = previewOf(await run(ctx, previewArgs()));
      const refused = await run(ctx, previewArgs({ plan_id: second.plan_id }));
      const error = errorOf(refused);
      assert.equal(error.code, 'possible_duplicate');
      // `send_ambiguous` is presented in the read-side vocabulary.
      assert.ok(error.message.includes("outcome 'unknown'"));
      assert.ok(!error.message.includes('send_ambiguous'));
    });
  });
});

test('an init answered with a 502 gateway page is send_ambiguous and blocks the retry', async () => {
  // The gateway may have forwarded the init before it failed: a new attempt
  // could post the same video twice, so the next identical apply is refused.
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: (n) =>
        n === 0
          ? new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 })
          : initResponse(),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const error = errorOf(await run(ctx, previewArgs({ plan_id: first.plan_id })));
      assert.equal(error.code, 'network_ambiguous');
      assert.equal(error.retryable, false);

      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'send_ambiguous');
      assert.equal(outcome?.['error_code'], 'network_ambiguous');

      const second = previewOf(await run(ctx, previewArgs()));
      const refused = errorOf(await run(ctx, previewArgs({ plan_id: second.plan_id })));
      assert.equal(refused.code, 'possible_duplicate');
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

test('an init answered ok with a null data is send_ambiguous and blocks the retry', async () => {
  // TikTok said `ok`, so the task may exist: the unreadable payload must not be
  // journalled as a plain `error` the duplicate guard would let through.
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: (n) =>
        n === 0
          ? new Response(JSON.stringify({ data: null, error: { code: 'ok' } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : initResponse(),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const error = errorOf(await run(ctx, previewArgs({ plan_id: first.plan_id })));
      assert.equal(error.code, 'network_ambiguous');
      assert.equal(error.retryable, false);

      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'send_ambiguous');
      assert.equal(outcome?.['error_code'], 'network_ambiguous');

      const second = previewOf(await run(ctx, previewArgs()));
      const refused = errorOf(await run(ctx, previewArgs({ plan_id: second.plan_id })));
      assert.equal(refused.code, 'possible_duplicate');
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

test('an init refused with a 4xx gateway page is a plain error the next apply may retry', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({
      init: (n) =>
        n === 0
          ? new Response('<html>403 Forbidden</html>', { status: 403 })
          : initResponse(),
    });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const error = errorOf(await run(ctx, previewArgs({ plan_id: first.plan_id })));
      assert.equal(error.code, 'upstream_error');

      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'error');

      const second = previewOf(await run(ctx, previewArgs()));
      const applied = appliedOf(await run(ctx, previewArgs({ plan_id: second.plan_id })));
      assert.equal(applied.publish_id, 'v_pub_url~test.123');
      assert.equal(countPath(stub, INIT_PATH), 2);
    });
  });
});

test('a failure before the request was dispatched is network_unsent, not ambiguous', async () => {
  // The token seam dies once the apply has read `creator_info`, so the init
  // request is the one that never leaves — the only shape of network failure
  // this tool can honestly call "unsent".
  let dispatchable = true;
  const stub = fakeApi({
    creator: (n) => {
      if (n >= 1) dispatchable = false;
      return creatorResponse();
    },
  });

  await withCtx(
    {},
    async (ctx, dir) => {
      const result = await withFetch(stub, async () => {
        const preview = previewOf(await run(ctx, previewArgs()));
        return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      });

      const error = errorOf(result);
      assert.equal(error.code, 'network_unsent');
      assert.equal(error.retryable, false);
      assert.ok(error.message.includes('TikTok received nothing'));
      // Nothing reached `/video/init/`, which is what the code promises.
      assert.equal(countPath(stub, INIT_PATH), 0);

      // The safe half of the taxonomy is journaled as a plain error: there is
      // nothing for a later duplicate guard to be careful about.
      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'error');
      assert.equal(outcome?.['error_code'], 'network_unsent');
    },
    () =>
      dispatchable
        ? Promise.resolve('test-access-token-DEFAULT')
        : Promise.reject(
            new TikTokError({
              code: 'network_error',
              kind: 'network',
              message: 'connect ECONNREFUSED',
              retryable: true,
            }),
          ),
  );
});

test('cc-g4: a final chunk whose answer never came is send_ambiguous with its chunk, not upload_failed', async () => {
  // No retries, so the one lost answer is the whole story and no backoff has
  // to be stepped through on the mock clock.
  await withCtx({ TT_CHUNK_RETRIES: '0' }, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi({
      init: () => fileInitResponse(),
      chunk: () => {
        throw new TypeError('fetch failed');
      },
    });

    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      const result = await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));

      const error = errorOf(result);
      assert.equal(error.code, 'network_ambiguous');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, { publish_id: 'v_pub_file~test.456' });
      assert.deepEqual(hintsOf(result), []);
      assert.equal(countPath(stub, '/upload/'), 1, 'one PUT, no retry');

      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'send_ambiguous');
      assert.equal(outcome?.['publish_id'], 'v_pub_file~test.456');
      assert.equal(outcome?.['error_code'], 'network_ambiguous');
      assert.equal(outcome?.['chunk'], 1);

      // The upload may have completed, so the next identical apply is refused.
      const again = previewOf(await run(ctx, fileArgs(path)));
      const refused = errorOf(await run(ctx, fileArgs(path, { plan_id: again.plan_id })));
      assert.equal(refused.code, 'possible_duplicate');
      assert.ok(refused.message.includes('v_pub_file~test.456'));
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

// ---------------------------------------------------------------------------
// wait_for_completion (§ 2.7)
// ---------------------------------------------------------------------------

test('wait_for_completion returns the terminal status and the public post id', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      status: () =>
        ttEnvelope({
          status: 'PUBLISH_COMPLETE',
          publicaly_available_post_id: ['7300000000000000000'],
        }),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
      );
    });

    const data = appliedOf(result);
    assert.equal(data.status, 'PUBLISH_COMPLETE');
    assert.equal(data.public_post_id, '7300000000000000000');
    // Terminal: no reason left to poll.
    assert.equal(hintsOf(result).length, 0);
  });
});

test('a wait that runs out of time is still a success, with a still-processing hint', async () => {
  await withCtx(
    { TT_STATUS_POLL_INTERVAL_MS: '5000', TT_STATUS_POLL_TIMEOUT_MS: '60000' },
    async (ctx, _dir, clock) => {
      // Never terminal: the poll can only end at the deadline.
      const stub = fakeApi({
        status: () => ttEnvelope({ status: 'PROCESSING_DOWNLOAD' }),
      });
      const result = await withFetch(stub, async () => {
        const preview = previewOf(await run(ctx, previewArgs()));
        return await runVirtual(
          clock,
          run(ctx, previewArgs({ plan_id: preview.plan_id, wait_for_completion: true })),
        );
      });

      // § 2.7: timeout-is-not-error. The post exists; only its final state is
      // still unknown.
      const data = appliedOf(result);
      assert.equal(data.publish_id, 'v_pub_url~test.123');
      assert.equal(data.status, 'PROCESSING_DOWNLOAD');
      assert.equal(data.journal, 'recorded');
      assert.ok(
        countPath(stub, '/v2/post/publish/status/fetch/') > 1,
        'expected a poll loop',
      );

      const [hint] = hintsOf(result);
      assert.equal(hint?.type, 'poll');
      assert.equal(hint?.publish_id, 'v_pub_url~test.123');
      assert.ok(hint?.text.includes('Still PROCESSING_DOWNLOAD after 60 s'));
      assert.ok(hint?.text.includes('do not re-post'));
      // § 2.7: every `poll` hint carries an absolute instant, this one
      // included. The exact arithmetic is pinned by the next test, where no
      // virtual time passes between the hint and the assertion.
      assert.match(hint?.poll_after ?? '', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
      assert.ok(hint?.text.includes(`after ${hint.poll_after ?? ''}`));
    },
  );
});

test("the still-processing hint's poll_after is the status tool's own interval", async () => {
  // A zero budget times out on the first read, so nothing sleeps and virtual
  // time stands exactly where the hint was built — the only way this instant
  // can be asserted as a value rather than as a range.
  await withCtx(
    { TT_STATUS_POLL_INTERVAL_MS: '5000', TT_STATUS_POLL_TIMEOUT_MS: '0' },
    async (ctx, _dir, clock) => {
      const stub = fakeApi({
        status: () => ttEnvelope({ status: 'PROCESSING_DOWNLOAD' }),
      });
      const result = await withFetch(stub, async () => {
        const preview = previewOf(await run(ctx, previewArgs()));
        return await run(
          ctx,
          previewArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
        );
      });

      assert.equal(appliedOf(result).status, 'PROCESSING_DOWNLOAD');
      const [hint] = hintsOf(result);
      assert.equal(hint?.type, 'poll');
      assert.equal(hint?.poll_after, new Date(clock.now() + 5_000).toISOString());
      assert.equal(clock.pending(), 0, 'a zero budget must not have slept');
    },
  );
});

test('a status read that fails after a successful post does not fail the post', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      status: () => refusal('invalid_publish_id', 'no such publish id'),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
      );
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_pub_url~test.123');
    assert.equal(data.journal, 'recorded');
    assert.equal(hintsOf(result)[0]?.type, 'poll');
  });
});

/**
 * Appendix A, verbatim: the normative recovery texts the waited FAILED tests
 * pin. Spelled out rather than read back from `failRecovery`, so a drifted
 * mapping fails here instead of agreeing with itself.
 */
const VIDEO_PULL_RECOVERY =
  'TikTok could not download the media URL. It must be HTTPS, serve the bytes without ' +
  'redirects, and stay reachable for about an hour. Fix the hosting and post again.';
const SPAM_TEXT_RECOVERY =
  "TikTok's spam filter rejected the title or description wording. Change the text and " +
  'post again.';

test('§ 3.8 a wait that ends in FAILED carries the fail_reason and its Appendix A recovery', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      status: () => ttEnvelope({ status: 'FAILED', fail_reason: 'video_pull_failed' }),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
      );
    });

    // The post was accepted; TikTok's verdict on it is data, not an error.
    const data = appliedOf(result);
    assert.equal(data.status, 'FAILED');
    assert.equal(data.fail_reason, 'video_pull_failed');
    assert.equal(data.fail_recovery, VIDEO_PULL_RECOVERY);
    assert.equal(data.fail_recovery, failRecovery('video_pull_failed'));
    assert.equal(data.public_post_id, undefined);
    // Terminal: nothing left to poll for.
    assert.equal(hintsOf(result).length, 0);
  });
});

test('§ 3.8 a wait that ends in FAILED without a reason sets neither fail field', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({ status: () => ttEnvelope({ status: 'FAILED' }) });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
      );
    });

    const data = appliedOf(result);
    assert.equal(data.status, 'FAILED');
    // No invented reason, and no recovery text for a reason nobody gave.
    assert.equal('fail_reason' in data, false);
    assert.equal('fail_recovery' in data, false);
  });
});

test('§ 3.8 a wait that completes ignores a fail_reason TikTok echoes alongside', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      status: () =>
        ttEnvelope({
          status: 'PUBLISH_COMPLETE',
          fail_reason: 'internal',
          publicaly_available_post_id: ['7300000000000000001'],
        }),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
      );
    });

    const data = appliedOf(result);
    assert.equal(data.status, 'PUBLISH_COMPLETE');
    assert.equal('fail_reason' in data, false);
    assert.equal('fail_recovery' in data, false);
  });
});

test('§ 3.9 a waited draft that ends in FAILED has its recovery and no inbox hint', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      init: () => initResponse('v_inbox~failed.8'),
      status: () => ttEnvelope({ status: 'FAILED', fail_reason: 'spam_risk_text' }),
    });
    const result = await withFetch(stub, async () => {
      const preview = draftPreviewOf(await runDraft(ctx, draftArgs()));
      return await runDraft(
        ctx,
        draftArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
      );
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_inbox~failed.8');
    assert.equal(data.status, 'FAILED');
    assert.equal(data.fail_reason, 'spam_risk_text');
    assert.equal(data.fail_recovery, SPAM_TEXT_RECOVERY);
    // A failed draft never reached the inbox, so "open the TikTok app" would
    // send the user looking for something that is not there.
    const hints = hintsOf(result);
    assert.equal(
      hints.some((hint) => hint.action === 'open_tiktok_app'),
      false,
    );
    assert.equal(hints.length, 0);
  });
});

// ---------------------------------------------------------------------------
// journal degradation
// ---------------------------------------------------------------------------

test('an unwritable journal degrades the answer without losing the post', async () => {
  await withCtx({}, async (ctx, dir) => {
    // A directory where the journal file belongs: every append fails, nothing
    // else does.
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });

    const result = await withFetch(fakeApi(), async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_pub_url~test.123');
    assert.equal(data.journal, 'unavailable');
    assert.equal(result.journal, 'unavailable');
    assert.ok(hintsOf(result).some((hint) => hint.text.includes('duplicate guard')));
  });
});

test('an unwritable journal degrades a refusal as well as a post', async () => {
  await withCtx({}, async (ctx, dir) => {
    // Both halves fail at once: the journal cannot be appended to and the init
    // is refused. The refusal is what the caller asked about, so it stays the
    // error, and the lost record is reported beside it rather than instead.
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });
    const stub = fakeApi({
      init: () => refusal('spam_risk_too_many_posts', 'too many posts today'),
    });

    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(errorOf(result).code, 'daily_post_cap');
    assert.equal(result.journal, 'unavailable');
    assert.ok(
      hintsOf(result).some((hint) => hint.text.includes('duplicate guard')),
      'the caller is told the guard cannot protect the next attempt',
    );
  });
});

test('cc-b4: an unwritable journal degrades an interrupted upload, and the note names the publish_id', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    // The init minted a publish_id and the first chunk is refused for good
    // (403 is terminal on the upload URL, § 4.8) while the journal cannot be
    // appended to. The attempt exists upstream, so the note has to name the id
    // the blind duplicate guard would otherwise have matched on — unlike the
    // pre-init refusal above, where there is nothing to name.
    await mkdir(join(dir, 'journal.ndjson'), { recursive: true });
    const stub = fakeApi({ init: () => fileInitResponse(), chunk: () => bare(403) });

    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
    });

    assert.equal(result.ok, false);
    assert.equal(errorOf(result).code, 'upload_interrupted');
    assert.equal(result.journal, 'unavailable');
    const note = hintsOf(result).find((hint) => hint.text.includes('duplicate guard'));
    assert.ok(
      note !== undefined,
      'the caller is told the guard cannot protect the next attempt',
    );
    assert.ok(
      note.text.includes('publish_id "v_pub_file~test.456"'),
      `the note names the id the guard cannot see: ${note.text}`,
    );
    // Past an init nothing a human does unblocks the call (§ 5.1): the note is
    // the only hint.
    assert.equal(hintsOf(result).length, 1);
  });
});

// ---------------------------------------------------------------------------
// cancellation — the forwarding half of CC-G4
// ---------------------------------------------------------------------------

test('cc-g4: an aborted preview asks TikTok nothing', async () => {
  await withCtx({}, async (ctx) => {
    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));
    const cancelled: ToolCtx = { ...ctx, signal: controller.signal };
    const stub = fakeApi();

    const result = await withFetch(stub, () => run(cancelled, previewArgs()));

    assert.equal(result.ok, false, 'a cancelled preview plans nothing');
    assert.equal(stub.calls.length, 0, 'the creator_info read never left the process');
  });
});

test('cc-g4: a cancellation between the plan guards and the init stops the post', async () => {
  await withCtx({}, async (ctx, dir) => {
    const reason = new Error('client cancelled');
    const controller = new AbortController();
    const cancelled: ToolCtx = { ...ctx, signal: controller.signal };
    // The apply re-reads `creator_info` before it trusts the plan (CC-E1), so
    // cancelling while that read is in flight lands the abort exactly between
    // the plan guards and the init — the last instant at which nothing has been
    // created yet.
    const stub = fakeApi({
      creator: (n) => {
        if (n === 1) controller.abort(reason);
        return creatorResponse();
      },
    });

    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(cancelled, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(result.ok, false, 'a cancelled apply does not post');
    assert.equal(countPath(stub, INIT_PATH), 0, 'the init never left the process');

    // Forwarded, not identical: `core/http` composes the caller's signal with
    // the request timeout, so the proof is that the signal the request carried
    // aborted with the caller's own reason.
    const apply = stub.calls[1];
    assert.ok(apply?.signal instanceof AbortSignal, 'the request carried a signal');
    assert.equal(apply.signal.aborted, true);
    assert.equal(apply.signal.reason, reason);

    // Cancelled before the send began, so the init was refused before `fetch`:
    // nothing was created, and the journal says so.
    const journal = await readJournal(dir);
    assert.equal(linesOf(journal, 'intent').length, 1);
    assert.equal(linesOf(journal, 'outcome')[0]?.['result'], 'error');
  });
});

test('cc-g4: a cancellation while the init is in flight is ambiguous and forbids a retry', async () => {
  await withCtx({}, async (ctx, dir) => {
    const controller = new AbortController();
    const cancelled: ToolCtx = { ...ctx, signal: controller.signal };
    // The cancel lands with the init already out: TikTok may have it and act
    // on it whatever this process stops waiting for.
    const stub = fakeApi({
      init: (n) => {
        if (n === 0) {
          controller.abort(new Error('client cancelled'));
          throw new TypeError('fetch failed');
        }
        return initResponse();
      },
    });

    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      const result = await run(cancelled, previewArgs({ plan_id: preview.plan_id }));

      const error = errorOf(result);
      assert.equal(error.code, 'network_ambiguous');
      assert.equal(error.details, undefined, 'no publish_id was minted');
      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'send_ambiguous');
      assert.equal(outcome?.['error_code'], 'network_ambiguous');

      // `error` would have let this through and posted a second time.
      const again = previewOf(await run(ctx, previewArgs()));
      const refused = await run(ctx, previewArgs({ plan_id: again.plan_id }));
      assert.equal(errorOf(refused).code, 'possible_duplicate');
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

test('cc-g4: a cancellation mid-upload is ambiguous, keeps the publish_id and forbids a retry', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const controller = new AbortController();
    const cancelled: ToolCtx = { ...ctx, signal: controller.signal };
    // The last chunk is out when the cancel lands: TikTok may assemble the post
    // from it, so `upload_failed` — "the bytes never arrived" — is not known.
    const stub = fakeApi({
      init: () => fileInitResponse(),
      chunk: () => {
        controller.abort(new Error('client cancelled'));
        throw new TypeError('fetch failed');
      },
    });

    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      const result = await run(cancelled, fileArgs(path, { plan_id: preview.plan_id }));

      const error = errorOf(result);
      assert.equal(error.code, 'network_ambiguous');
      assert.deepEqual(error.details, { publish_id: 'v_pub_file~test.456' });
      assert.deepEqual(hintsOf(result), []);
      const [outcome] = linesOf(await readJournal(dir), 'outcome');
      assert.equal(outcome?.['result'], 'send_ambiguous');
      assert.equal(outcome?.['publish_id'], 'v_pub_file~test.456');
      assert.equal(outcome?.['error_code'], 'network_ambiguous');
      assert.equal(outcome?.['chunk'], 1);

      const again = previewOf(await run(ctx, fileArgs(path)));
      const refused = errorOf(await run(ctx, fileArgs(path, { plan_id: again.plan_id })));
      assert.equal(refused.code, 'possible_duplicate');
      assert.ok(refused.message.includes('v_pub_file~test.456'));
      assert.equal(countPath(stub, INIT_PATH), 1);
    });
  });
});

// ---------------------------------------------------------------------------
// hint grammar (§ 5.2)
// ---------------------------------------------------------------------------

test('every hint this tool can emit stays inside the vocabulary and the length limit', async () => {
  const seen: Hint[] = [];
  const collect = (result: ToolResult<PostVideoData>): void => {
    seen.push(...hintsOf(result));
    assert.ok(hintsOf(result).length <= 3, 'at most three hints');
  };

  await withCtx({}, async (ctx) => {
    // The first two reads model an unaudited app; the rest a normal account.
    const stub = fakeApi({
      creator: (n) =>
        n < 2
          ? creatorResponse({ privacy_level_options: ['SELF_ONLY'] })
          : creatorResponse(),
    });
    await withFetch(stub, async () => {
      collect(await run(ctx, previewArgs({ privacy_level: undefined })));
      collect(await run(ctx, previewArgs()));
      const preview = previewOf(await run(ctx, previewArgs()));
      collect(await run(ctx, previewArgs({ plan_id: preview.plan_id })));
    });
  });

  assert.ok(seen.length >= 4);
  for (const hint of seen) {
    assert.ok(HINT_TYPES.includes(hint.type), `unknown hint type ${hint.type}`);
    assert.ok(hint.text.length <= 300, `hint too long: ${hint.text}`);
    // § 5.2: no upstream string is ever interpolated into hint text.
    assert.ok(!hint.text.includes('Test Creator'));
    assert.ok(!hint.text.includes('test-open-id'));
  }
});

/** The inbox draft the deepest hint chain below is built on. */
const DRAFT_PUBLISH_ID = 'v_inbox~draft.7';

/**
 * The § 5.2 caps, asserted on the envelope the caller actually receives.
 *
 * Deliberately duplicated in `tool-publish-photos.test.ts` rather than lifted
 * into `test/helpers.ts`: the two files pin the same property on two different
 * tools, and a shared copy invites editing it for one tool's convenience while
 * the other silently stops checking what it thinks it checks. The numbers are
 * imported, not retyped — a local `3` would only agree with itself.
 *
 * `truncated` is the assertion that carries this, not a scan for the
 * truncator's own note: `withNote` in `mcp/result.ts` *declines* to append that
 * note once a result already holds {@link MAX_HINTS} hints, so at the cap a
 * shortened payload has no slot left to announce itself in. The deep-equal
 * beside it says the hints that ship are the hints the tool wrote — none
 * appended, none rewritten on the way out.
 */
function assertHintsIntact(result: ToolResult<unknown>, budget: number): void {
  const hints = hintsOf(result);
  assert.ok(
    hints.length <= MAX_HINTS,
    `${String(hints.length)} hints exceed the § 5.2 cap of ${String(MAX_HINTS)}`,
  );
  for (const hint of hints) {
    assert.ok(
      hint.text.length <= MAX_HINT_CHARS,
      `hint over ${String(MAX_HINT_CHARS)}: ${hint.text}`,
    );
  }

  // The detector, proved before it is trusted: the same envelope carrying a
  // payload no budget this size can hold *is* reported as truncated. Without
  // this, the assertion below would pass just as happily on a truncator that
  // had stopped reporting anything at all.
  const overflowing = truncateResult(
    { ...result, data: { blob: 'x'.repeat(budget + 1) } },
    budget,
  );
  assert.equal(overflowing.truncated, true, 'the elision check is vacuous');

  const shipped = truncateResult(result, budget);
  assert.equal(shipped.truncated, false, 'the result was shortened to fit the budget');
  assert.deepEqual(shipped.result.hints, hints, 'truncation rewrote the hints');
}

test('cc-g7: the deepest hint chain fills all three slots and ships every one of them', async () => {
  // The maximum this server can compose, and the one thing no static scan of
  // the hint literals can see, because each of the three is written at a
  // different site and only the runtime knows they meet:
  //
  //   1. `draftInboxHint()`, prepended by `executeDraft` in this module;
  //   2. `waitIfAsked`'s still-processing poll, unshifted onto whatever the
  //      dispatch handed it;
  //   3. `dispatchWrite`'s journal-unavailable note, the array those two grew.
  //
  // A fourth hint added inside any one of them would be dropped in silence:
  // the post still succeeded, the result still returned, and the only casualty
  // is the guidance the model needed next.
  await withCtx(
    { TT_STATUS_POLL_INTERVAL_MS: '5000', TT_STATUS_POLL_TIMEOUT_MS: '60000' },
    async (ctx, dir, clock) => {
      // A directory where the journal file belongs: every append fails and
      // nothing else does, so the note is earned rather than injected.
      await mkdir(join(dir, 'journal.ndjson'), { recursive: true });
      // Never terminal, so the wait can only end at its deadline.
      const stub = fakeApi({
        init: () => initResponse(DRAFT_PUBLISH_ID),
        status: () => ttEnvelope({ status: 'PROCESSING_DOWNLOAD' }),
      });

      const result = await withFetch(stub, async () => {
        const preview = draftPreviewOf(await runDraft(ctx, draftArgs()));
        return await runVirtual(
          clock,
          runDraft(
            ctx,
            draftArgs({ plan_id: preview.plan_id, wait_for_completion: true }),
          ),
        );
      });

      // § 2.7: the timeout is not a failure — the draft is in the inbox.
      const data = appliedOf(result);
      assert.equal(data.publish_id, DRAFT_PUBLISH_ID);
      assert.equal(data.status, 'PROCESSING_DOWNLOAD');
      assert.equal(data.journal, 'unavailable');
      assert.equal(result.journal, 'unavailable');

      // § 5.2 rule 4, most actionable first: the step only the human can take,
      // then the call the model should make, then the caveat on the guard.
      const hints = hintsOf(result);
      assert.deepEqual(
        hints.map((hint) => hint.type),
        ['user_action', 'poll', 'note'],
      );
      assert.equal(hints[0]?.action, 'open_tiktok_app');
      assert.ok(hints[0]?.text.includes('Unopened drafts expire.'));
      assert.equal(hints[1]?.tool, 'tiktok_get_publish_status');
      assert.equal(hints[1]?.publish_id, DRAFT_PUBLISH_ID);
      assert.ok(hints[1]?.text.includes('Still PROCESSING_DOWNLOAD after 60 s'));
      assert.ok(hints[2]?.text.includes('duplicate guard'));
      assert.ok(hints[2]?.text.includes(DRAFT_PUBLISH_ID));

      // Read as one statement: three hints, all of them inside the caps, all of
      // them still there once the result has been through the char budget.
      assertHintsIntact(result, ctx.api.settings.resultCharBudget);
      // Not merely under the cap — *at* it. This chain has no headroom, so a
      // fourth hint anywhere in it changes this line and nothing else.
      assert.equal(hints.length, MAX_HINTS);
    },
  );
});

test('the tool declares itself destructive and non-idempotent (§ 3.8)', () => {
  assert.deepEqual(postVideoTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(postVideoTool.package, 'publish-write');
  assert.deepEqual(postVideoTool.scopes, ['video.publish']);
});

test('no result this tool returns ever carries an upload token or an access token', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      init: () =>
        ttEnvelope({
          publish_id: 'v_pub_url~test.123',
          upload_url: 'https://open-upload.tiktokapis.com/x?upload_token=SECRET-TOKEN',
        }),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('SECRET-TOKEN'));
    assert.ok(!serialized.includes('upload_token'));
    assert.ok(!serialized.includes('test-access-token-DEFAULT'));
  });
});

// ---------------------------------------------------------------------------
// source: "file" — the FILE_UPLOAD half (§ 3.8, TIKTOK-API.md §§ 4.6–4.8)
// ---------------------------------------------------------------------------

/**
 * Symlink creation needs elevation or developer mode on Windows, which CI does
 * not grant; the platform-neutral variants below cover the same seams.
 */
const SYMLINK_SKIP: string | false =
  process.platform === 'win32'
    ? 'symlink creation requires elevation or developer mode on Windows'
    : false;

test('a file preview publishes the resolved path and the chunk plan (CC-D2, § 3.8)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, fileArgs(path)));

    const preview = previewOf(result);
    const source = fileSource(preview.payload.source);
    assert.equal(source.resolved_path, path);
    assert.equal(source.file_size, MEDIA_BYTES);

    // The summary is the planner's own arithmetic, not a restatement of it.
    const plan = planChunks(MEDIA_BYTES);
    assert.deepEqual(source.chunk_summary, {
      file_size: MEDIA_BYTES,
      chunk_size: plan.chunkSize,
      chunks: plan.totalChunkCount,
    });

    // A preview still touches nothing under /publish/ but the creator read.
    assert.deepEqual(paths(stub), [CREATOR_PATH]);
    assert.equal(stub.puts.length, 0);
  });
});

test('a file preview mints a plan an otherwise identical url post cannot spend (§ 2.6.2)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      assert.equal(preview.mode, 'plan');
      assert.match(preview.plan_id ?? '', PLAN_ID_PATTERN);
      // Same account, same title, same privacy level: only `source_info`
      // differs, and the digest covers it.
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(errorOf(result).code, 'plan_mismatch');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('two files of the same size do not share a plan — the path is digested (CC-D3)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const first = await writeMedia(dir, 'first.mp4', MEDIA_BYTES);
    const second = await writeMedia(dir, 'second.mp4', MEDIA_BYTES);
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(first)));
      return await run(ctx, fileArgs(second, { plan_id: preview.plan_id }));
    });

    assert.equal(errorOf(result).code, 'plan_mismatch');
    assert.equal(countPath(stub, INIT_PATH), 0);
    assert.equal(stub.puts.length, 0);
  });
});

test('a file rewritten in place after the preview is plan_mismatch, not a new upload (CC-D3)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      // Same path, same size — the digest cannot tell. Only the identity the
      // plan bound beside it can: the bytes the user approved may be gone.
      await writeFile(path, new Uint8Array(MEDIA_BYTES).fill(9));
      const stamp = new Date('2020-01-02T03:04:05Z');
      await utimes(path, stamp, stamp);
      return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
    });

    const error = errorOf(result);
    assert.equal(error.code, 'plan_mismatch');
    assert.ok(error.message.startsWith('The file changed since plan'), error.message);
    assert.deepEqual(error.details, { reason: 'file_changed' });
    assert.equal(countPath(stub, INIT_PATH), 0);
    assert.equal(stub.puts.length, 0);
  });
});

test('a file identity never reaches TikTok or the digest the duplicate guard matches', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi({ init: () => fileInitResponse() });

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, fileArgs(path)));
      appliedOf(await run(ctx, fileArgs(path, { plan_id: first.plan_id })));
      const init = stub.calls.find((call) => call.path === INIT_PATH);
      const sent = JSON.stringify(init?.body);
      assert.ok(!sent.includes('mtime') && !sent.includes('ino'), sent);

      // A re-touched copy of the same bytes is the same post: a fresh plan for
      // it is valid, and the guard still refuses it as a duplicate.
      const stamp = new Date('2020-01-02T03:04:05Z');
      await utimes(path, stamp, stamp);
      const second = previewOf(await run(ctx, fileArgs(path)));
      const refused = await run(ctx, fileArgs(path, { plan_id: second.plan_id }));
      assert.equal(errorOf(refused).code, 'possible_duplicate');
    });
  });
});

test('a file apply sends FILE_UPLOAD source_info and PUTs the plan (TIKTOK-API §§ 4.6–4.7)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi({ init: () => fileInitResponse() });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
    });

    const applied = appliedOf(result);
    assert.equal(applied.publish_id, 'v_pub_file~test.456');
    // The bytes move here rather than upstream, so the opening status is the
    // upload one, not PROCESSING_DOWNLOAD.
    assert.equal(applied.status, 'PROCESSING_UPLOAD');

    const plan = planChunks(MEDIA_BYTES);
    const init = stub.calls.find((call) => call.path === INIT_PATH)?.body as Args;
    assert.deepEqual(init['source_info'], {
      source: 'FILE_UPLOAD',
      video_size: MEDIA_BYTES,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunkCount,
    });

    // One PUT per planned chunk, to the URL the init handed back.
    assert.equal(stub.puts.length, plan.totalChunkCount);
    const [put] = stub.puts;
    assert.equal(put?.url, UPLOAD_URL);
    assert.equal(put?.contentType, 'video/mp4');
    assert.equal(
      put?.contentRange,
      `bytes 0-${String(MEDIA_BYTES - 1)}/${String(MEDIA_BYTES)}`,
    );
    assert.equal(put?.bytes, MEDIA_BYTES);

    const journal = await readJournal(dir);
    assert.equal(linesOf(journal, 'intent')[0]?.['source'], 'FILE_UPLOAD');
    assert.equal(linesOf(journal, 'outcome')[0]?.['result'], 'ok');
  });
});

test('every accepted chunk reports progress to the client (§ 2.7, CC-D7)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const seen: [number, number][] = [];
    // `withCtx` builds the context a client that sent no progress token gets;
    // one that sent a token gets a reporter wired to a notification.
    const reporting: ToolCtx = {
      ...ctx,
      progress: (done, total) => {
        seen.push([done, total]);
      },
    };
    const stub = fakeApi({ init: () => fileInitResponse() });
    await withFetch(stub, async () => {
      const preview = previewOf(await run(reporting, fileArgs(path)));
      return await run(reporting, fileArgs(path, { plan_id: preview.plan_id }));
    });

    // `chunk_size` is `min(file_size, 64,000,000)` and the count is a floor, so
    // a fixture would have to exceed 128 MB to produce a second chunk. The pair
    // is the contract either way: `done` counts accepted chunks, `total` is the
    // planned count, and the last report is the complete one.
    const plan = planChunks(MEDIA_BYTES);
    assert.deepEqual(seen, [[1, plan.totalChunkCount]]);
    assert.equal(seen.length, stub.puts.length);
  });
});

/**
 * The smallest file `planChunks` splits in two: `chunk_size` is
 * `min(file_size, 64,000,000)` and the count is a floor, so two chunks need
 * 128,000,000 bytes. Written sparse, so it costs no disk — only the reads.
 */
const TWO_CHUNK_BYTES = 128_000_000;

async function writeSparseMedia(dir: string, name: string): Promise<string> {
  const path = join(mediaRootOf(dir), name);
  await writeFile(path, new Uint8Array(0));
  await truncate(path, TWO_CHUNK_BYTES);
  return path;
}

/** A 416 whose progress sends the cursor back to chunk 1: TikTok holds nothing. */
function resyncToStart(): Response {
  return new Response(null, {
    status: 416,
    headers: { 'content-range': `bytes 0-0/${String(TWO_CHUNK_BYTES)}` },
  });
}

test('progress never goes backwards when a resync moves the upload back (§ 2.7, CC-D7)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeSparseMedia(dir, 'long.mp4');
    assert.equal(planChunks(TWO_CHUNK_BYTES).totalChunkCount, 2);
    const seen: [number, number][] = [];
    const reporting: ToolCtx = {
      ...ctx,
      progress: (done, total) => {
        seen.push([done, total]);
      },
    };
    // Chunk 1 accepted, chunk 2 resynced back to the start, both re-sent.
    const answers = [bare(206), resyncToStart(), bare(206), bare(201)];
    const stub = fakeApi({
      init: () => fileInitResponse(),
      chunk: (n) => answers[n] ?? bare(500),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(reporting, fileArgs(path)));
      return await run(reporting, fileArgs(path, { plan_id: preview.plan_id }));
    });

    assert.equal(appliedOf(result).publish_id, 'v_pub_file~test.456');
    assert.equal(stub.puts.length, 4);
    // The resync and the re-sent chunk 1 are below what was already reported:
    // an MCP progress value must increase, so neither is sent again.
    assert.deepEqual(seen, [
      [1, 2],
      [2, 2],
    ]);
  });
});

test('a failure after a backward resync names the chunk the upload was sent back to', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeSparseMedia(dir, 'long.mp4');
    const seen: number[] = [];
    const reporting: ToolCtx = {
      ...ctx,
      progress: (done) => {
        seen.push(done);
      },
    };
    // Chunk 1 accepted, chunk 2 resynced back to the start, chunk 1 then 403s.
    const answers = [bare(206), resyncToStart(), bare(403)];
    const stub = fakeApi({
      init: () => fileInitResponse(),
      chunk: (n) => answers[n] ?? bare(500),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(reporting, fileArgs(path)));
      return await run(reporting, fileArgs(path, { plan_id: preview.plan_id }));
    });

    const error = errorOf(result);
    assert.equal(error.code, 'upload_interrupted');
    // Chunk 1 is where it failed, not chunk 2 — the high-water mark of progress.
    assert.match(error.message, /Upload failed at chunk 1\/2/);
    assert.equal(error.details?.['chunk'], 1);
    assert.equal(error.details?.['total_chunks'], 2);
    assert.deepEqual(seen, [1], 'the progress reported stays where it was');

    const [outcome] = linesOf(await readJournal(dir), 'outcome');
    assert.equal(outcome?.['result'], 'upload_failed');
    assert.equal(outcome?.['chunk'], 1);
  });
});

test('a file outside TT_MEDIA_ROOT is refused before any request (CC-D1, CC-D8)', async () => {
  await withCtx({}, async (ctx, dir) => {
    // The sandbox root is outside the media root by construction.
    const outside = join(dir, 'outside.mp4');
    await writeFile(outside, new Uint8Array(MEDIA_BYTES).fill(7));
    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, fileArgs(outside)));

    const error = errorOf(result);
    assert.equal(error.code, 'file_outside_media_root');
    assert.ok(error.message.includes('outside the configured media root'));
    assert.ok(error.message.includes(mediaRootOf(dir)));
    assert.equal(stub.calls.length, 0);
    assert.equal(stub.puts.length, 0);
  });
});

test(
  'a symlink inside the root pointing outside it is refused before any request (CC-D8)',
  { skip: SYMLINK_SKIP },
  async () => {
    await withCtx({}, async (ctx, dir) => {
      const outside = join(dir, 'outside.mp4');
      await writeFile(outside, new Uint8Array(MEDIA_BYTES).fill(7));
      const link = join(mediaRootOf(dir), 'link.mp4');
      await symlink(outside, link);

      const stub = fakeApi();
      const result = await withFetch(stub, async () => run(ctx, fileArgs(link)));

      const error = errorOf(result);
      assert.equal(error.code, 'file_outside_media_root');
      // Containment is decided on the resolved target, not on the link.
      assert.ok(error.message.includes(outside));
      assert.equal(stub.calls.length, 0);
      assert.equal(stub.puts.length, 0);
    });
  },
);

test('source and its media argument are mutually exclusive, and each half is required (§ 3.8)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi();
    await withFetch(stub, async () => {
      const cases: [string, Args, string][] = [
        ['url + file_path', previewArgs({ file_path: path }), 'mutually exclusive'],
        [
          'file + video_url',
          fileArgs(path, { video_url: VIDEO_URL }),
          'mutually exclusive',
        ],
        [
          'url without video_url',
          previewArgs({ video_url: undefined }),
          'video_url: required',
        ],
        [
          'file without file_path',
          fileArgs(path, { file_path: undefined }),
          'file_path: required',
        ],
      ];
      for (const [label, args, fragment] of cases) {
        const error = errorOf(await run(ctx, args));
        assert.equal(error.code, 'invalid_params', label);
        assert.ok(error.message.includes(fragment), `${label}: ${error.message}`);
      }
    });

    // None of the four reached the network, so none of them minted a plan.
    assert.equal(stub.calls.length, 0);
    assert.equal(stub.puts.length, 0);
  });
});

test('a FILE_UPLOAD init without an upload_url is upstream_error and sends no chunk (§ 3.0)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    // A publish_id and nowhere to send the bytes: caught in `api/publish`
    // before the transfer, not by PUTting into the void.
    const stub = fakeApi({ init: () => initResponse('v_pub_file~test.456') });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
    });

    const error = errorOf(result);
    assert.equal(error.code, 'upstream_error');
    assert.ok(error.message.includes('upload_url'));
    assert.equal(stub.puts.length, 0);

    // The init never produced a usable result, so nothing is recorded as
    // existing upstream.
    const [outcome] = linesOf(await readJournal(dir), 'outcome');
    assert.equal(outcome?.['result'], 'error');
    assert.equal(outcome?.['error_code'], 'upstream_error');
    assert.equal(outcome?.['publish_id'], undefined);
  });
});

test('neither the result nor the journal ever carries the upload_url or its token (§ 2.5)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    const stub = fakeApi({ init: () => fileInitResponse() });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
    });

    // The upload really happened — this is the leak-prone path, not a no-op.
    assert.equal(appliedOf(result).publish_id, 'v_pub_file~test.456');
    assert.equal(stub.puts.length, planChunks(MEDIA_BYTES).totalChunkCount);

    const journal = await readJournal(dir);
    for (const [what, text] of [
      ['result', JSON.stringify(result)],
      ['journal', JSON.stringify(journal)],
    ] as const) {
      assert.ok(!text.includes(UPLOAD_URL), `${what} carries the upload URL`);
      assert.ok(!text.includes(UPLOAD_TOKEN), `${what} carries the upload token`);
      assert.ok(!text.includes('upload_token'), `${what} names upload_token`);
      assert.ok(!text.includes('open-upload'), `${what} carries the upload host`);
    }
  });
});

test('the file is re-verified between the plan guards and the first byte (CC-D3)', async () => {
  await withCtx({}, async (ctx, dir) => {
    const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
    // The init call is the last moment before the transfer: the apply has
    // already re-resolved the file and spent the plan, so only the re-stat in
    // front of the first PUT can still catch a swap made here.
    const stub = fakeApi({
      init: async () => {
        await rm(path);
        await writeMedia(dir, 'clip.mp4', MEDIA_BYTES * 2);
        return fileInitResponse();
      },
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, fileArgs(path)));
      return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
    });

    const error = errorOf(result);
    assert.equal(error.code, 'plan_mismatch');
    assert.ok(error.message.includes('changed since plan'));
    assert.equal(stub.puts.length, 0);

    // The init already minted a publish_id, so the journal has to say that an
    // attempt exists upstream even though not one byte was sent: after the
    // init every failure is `upload_failed`, whatever aborted the bytes
    // (CC-B4). `error` here would read as "nothing was created".
    const [outcome] = linesOf(await readJournal(dir), 'outcome');
    assert.equal(outcome?.['publish_id'], 'v_pub_file~test.456');
    assert.equal(outcome?.['result'], 'upload_failed');
    assert.equal(outcome?.['error_code'], 'plan_mismatch');
    // Nothing was accepted, so the chunk that failed is the first one.
    assert.equal(outcome?.['chunk'], 1);
  });
});

test(
  'a symlink retargeted outside the root after the plan guards is caught first (CC-D3, CC-D8)',
  { skip: SYMLINK_SKIP },
  async () => {
    await withCtx({}, async (ctx, dir) => {
      const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
      const outside = join(dir, 'outside.mp4');
      await writeFile(outside, new Uint8Array(MEDIA_BYTES).fill(7));

      // Same identity-check seam as above, but the swap keeps the size and
      // escapes the root instead: containment is re-decided too, not only the
      // four-field identity.
      const stub = fakeApi({
        init: async () => {
          await rm(path);
          await symlink(outside, path);
          return fileInitResponse();
        },
      });
      const result = await withFetch(stub, async () => {
        const preview = previewOf(await run(ctx, fileArgs(path)));
        return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
      });

      assert.equal(errorOf(result).code, 'file_outside_media_root');
      // § 5.1: the same code earns a `move_file` hint before the init and none
      // after it. The init already returned a publish_id, so the attempt exists
      // upstream (CC-B4) and no human step unblocks *this* call — the next move
      // is tiktok_get_publish_status.
      assert.deepEqual(hintsOf(result), []);
      assert.equal(stub.puts.length, 0);
    });
  },
);

test(
  '§ 5.1: the apply-time containment re-run still carries the move_file step',
  { skip: SYMLINK_SKIP },
  async () => {
    await withCtx({}, async (ctx, dir) => {
      const path = await writeMedia(dir, 'clip.mp4', MEDIA_BYTES);
      const outside = join(dir, 'outside.mp4');
      await writeFile(outside, new Uint8Array(MEDIA_BYTES).fill(7));

      const stub = fakeApi();
      const result = await withFetch(stub, async () => {
        const preview = previewOf(await run(ctx, fileArgs(path)));
        // Retargeted *between* the calls, so step 3 re-resolves and refuses
        // before any init — the pre-network half of the same swap the test
        // above drives from inside the init.
        await rm(path);
        await symlink(outside, path);
        return await run(ctx, fileArgs(path, { plan_id: preview.plan_id }));
      });

      assert.equal(errorOf(result).code, 'file_outside_media_root');
      const [hint] = hintsOf(result);
      assert.equal(hint?.action, 'move_file');
      assert.equal(countPath(stub, INIT_PATH), 0);
      assert.equal(stub.puts.length, 0);
    });
  },
);
