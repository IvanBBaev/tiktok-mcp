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
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { planChunks } from '../src/api/upload.js';
import { TikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import { resetRateBuckets, takePublishToken } from '../src/mcp/plan.js';
import { PLAN_ID_PATTERN, resetPlanStore } from '../src/mcp/plan-store.js';
import {
  HINT_TYPES,
  type Hint,
  type ToolError,
  type ToolResult,
} from '../src/mcp/result.js';
import type {
  AppliedData,
  SourceBlock,
  WritePreview,
} from '../src/tools/publish-common.js';
import { postVideoTool, type PostVideoData } from '../src/tools/publish-write.js';
import {
  BASELINE_SCOPES,
  fsSandbox,
  mockClock,
  ttEnvelope,
  withFetch,
  type FetchStub,
  type MockClock,
} from './helpers.js';

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

function dataOf(result: ToolResult<PostVideoData>): PostVideoData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

function previewOf(result: ToolResult<PostVideoData>): WritePreview {
  const data = dataOf(result);
  assert.ok(data.mode !== 'applied', 'expected a preview, got an applied post');
  return data;
}

function appliedOf(result: ToolResult<PostVideoData>): AppliedData {
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

function hintsOf(result: ToolResult<PostVideoData>): readonly Hint[] {
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

test('the local rate limit refuses before any network call and never spends the plan', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      // Drain the bucket the way six applies in one minute would.
      for (let i = 0; i < 6; i += 1) takePublishToken('DEFAULT', ctx.api.clock);
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
      for (let i = 0; i < 6; i += 1) takePublishToken('DEFAULT', ctx.api.clock);
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'wait');
    assert.ok(hint?.retry_at?.endsWith('Z'));
    assert.equal(typeof hint?.retry_after_s, 'number');
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
      // The § 3.8 text this hint copies is relative ("after N s"), so it
      // carries no `poll_after` instant — unlike the hint an apply that did
      // not wait emits. Pinned so the divergence stays a decision.
      assert.equal(hint?.poll_after, undefined);
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
    // attempt exists upstream even though not one byte was sent. Which failure
    // word `result` gets is `classifyDispatch`'s business (CC-B4); the
    // publish_id is what a reconciling reader cannot do without.
    const [outcome] = linesOf(await readJournal(dir), 'outcome');
    assert.equal(outcome?.['publish_id'], 'v_pub_file~test.456');
    assert.notEqual(outcome?.['result'], 'ok');
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
      assert.equal(stub.puts.length, 0);
    });
  },
);
