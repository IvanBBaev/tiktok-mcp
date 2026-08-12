/**
 * `tiktok_post_photos` (TOOLS.md § 3.10) and `tiktok_upload_photos_draft`
 * (§ 3.11) — the carousel half of the write surface.
 *
 * The § 2.6 two-step contract is `publish-common`'s and is pinned by
 * `tool-publish-write.test.ts`; what these tests exist to hold down is what
 * photos do *differently*, because each difference is a place where a copy of
 * the video path would silently be wrong:
 *
 * - the init is the content endpoint with `media_type: "PHOTO"`, a `post_mode`
 *   and a `photo_images` carousel — there is no `upload_url`, no chunking and
 *   no `FILE_UPLOAD` branch to fall back to (CC-D10);
 * - `post_info` carries **no** `disable_duet` and **no** `disable_stitch`; the
 *   omission is the contract (§ 3.10), so it is asserted against a creator
 *   fixture that *does* have duets disabled;
 * - the text budget is 90/4000, not 2200 (CC-E3), and the duplicate guard's
 *   excerpt spans title *and* description because a carousel is usually
 *   untitled;
 * - `photo_cover_index` must index the carousel, and an unverified URL is
 *   reported one offender at a time, by index (CC-E9, § 3.10);
 * - `tiktok_post_photos` runs the `creator_info` pre-flight and
 *   `tiktok_upload_photos_draft` never does — a `video.upload`-only grant may
 *   not carry the scope (§ 3.11).
 *
 * Upstream is stubbed by route rather than by call order ({@link fakeApi}), so
 * the apply step's second `creator_info` read is an observation rather than a
 * scripted expectation, and a request to a *video* endpoint fails loudly
 * instead of being answered. Every scripted failure is deliberately
 * **non**-retryable, so nothing parks on a `mockClock` backoff that no test
 * advances.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import { resetRateBuckets, takePublishToken } from '../src/mcp/plan.js';
import { PLAN_ID_PATTERN, resetPlanStore } from '../src/mcp/plan-store.js';
import type { Hint, ToolError, ToolResult } from '../src/mcp/result.js';
import type {
  AppliedData,
  DraftPreview,
  SourceBlock,
  WritePreview,
} from '../src/tools/publish-common.js';
import {
  postPhotosTool,
  uploadPhotosDraftTool,
  type PostPhotosData,
  type UploadPhotosDraftData,
} from '../src/tools/publish-photos.js';
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

const VERIFIED_PREFIX = 'https://cdn.example.com/photos/';
const PHOTO_URLS = [
  `${VERIFIED_PREFIX}one.jpg`,
  `${VERIFIED_PREFIX}two.jpg`,
  `${VERIFIED_PREFIX}three.jpg`,
];

const TITLE = 'Trip photos';
const DESCRIPTION = 'Three shots from the trip';

const CREATOR_PATH = '/v2/post/publish/creator_info/query/';
/** Photos init through the *content* endpoint, never `/video/init/`. */
const INIT_PATH = '/v2/post/publish/content/init/';
const STATUS_PATH = '/v2/post/publish/status/fetch/';

/**
 * The upstream `creator_info` payload. `duet_disabled: true` is deliberate: if
 * the photo path ever resolved through the video resolver, the forced
 * `disable_duet` would show up in `post_info` and the § 3.10 assertions below
 * would catch it.
 */
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

/** A photo init answers with a `publish_id` only — there is no `upload_url`. */
function initResponse(publishId = 'v_pub_url~photo.123'): Response {
  return ttEnvelope({ publish_id: publishId });
}

type Args = Record<string, unknown>;

/** The smallest argument set that yields a complete `tiktok_post_photos` plan. */
function previewArgs(overrides: Args = {}): Args {
  return {
    photo_urls: PHOTO_URLS,
    photo_cover_index: 1,
    title: TITLE,
    description: DESCRIPTION,
    privacy_level: 'SELF_ONLY',
    ...overrides,
  };
}

/** The same carousel for the draft tool, which has no privacy or toggle fields. */
function draftArgs(overrides: Args = {}): Args {
  return {
    photo_urls: PHOTO_URLS,
    photo_cover_index: 1,
    title: TITLE,
    description: DESCRIPTION,
    ...overrides,
  };
}

async function run(ctx: ToolCtx, args: Args): Promise<ToolResult<PostPhotosData>> {
  return await postPhotosTool.handler(postPhotosTool.input.parse(args), ctx);
}

async function runDraft(
  ctx: ToolCtx,
  args: Args,
): Promise<ToolResult<UploadPhotosDraftData>> {
  return await uploadPhotosDraftTool.handler(
    uploadPhotosDraftTool.input.parse(args),
    ctx,
  );
}

// ---------------------------------------------------------------------------
// a fetch stub that answers by route, not by position
// ---------------------------------------------------------------------------

/** Per-route handlers; `n` is how many times that route was already asked. */
interface ApiScript {
  creator?: (n: number) => Response | Promise<Response>;
  init?: (n: number) => Response | Promise<Response>;
  status?: (n: number) => Response | Promise<Response>;
}

interface FakeCall {
  readonly path: string;
  readonly body: unknown;
}

interface FakeApi extends FetchStub {
  readonly calls: readonly FakeCall[];
}

function fakeApi(script: ApiScript = {}): FakeApi {
  const calls: FakeCall[] = [];
  const seen = { creator: 0, init: 0, status: 0 };

  const stub = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      path,
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
    });

    if (path.endsWith('/creator_info/query/')) {
      const n = seen.creator;
      seen.creator += 1;
      return Promise.resolve(script.creator?.(n) ?? creatorResponse());
    }
    if (path.endsWith('/content/init/')) {
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
    // Reaching this for `/video/init/` would mean a photo tool took the video
    // path — the fallback is the assertion.
    throw new Error(`fakeApi: unexpected request to ${path}`);
  };

  return Object.assign(stub, { calls });
}

/** Every request path the stub saw, in order. */
function paths(stub: FakeApi): string[] {
  return stub.calls.map((call) => call.path);
}

function countPath(stub: FakeApi, path: string): number {
  return paths(stub).filter((seen) => seen === path).length;
}

/** The parsed request body of the `n`-th call, as a plain record. */
function bodyOf(stub: FakeApi, index: number): Record<string, unknown> {
  const call = stub.calls[index];
  assert.ok(call !== undefined, `no call #${String(index)} was made`);
  return call.body as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/**
 * A sandboxed tool context: a real credential file (so `open_id` resolves the
 * way it does in production) and the journal beside it.
 */
async function withCtx<T>(
  /** Server settings; an `undefined` value means "not set in the environment". */
  env: Record<string, string | undefined>,
  fn: (ctx: ToolCtx, dir: string, clock: MockClock) => Promise<T>,
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
    const vars: Record<string, string> = {
      TT_ENV_FILE: envFile,
      TT_CLIENT_KEY: 'test-client-key',
      TT_CLIENT_SECRET: 'test-secret',
      TT_VERIFIED_URL_PREFIXES: VERIFIED_PREFIX,
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
      refresh: () => Promise.resolve('test-access-token-DEFAULT'),
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
 * steps, which `advance` does — walks the whole ladder.
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

function previewOf(result: ToolResult<PostPhotosData>): WritePreview {
  const data = dataOf(result);
  assert.ok(data.mode !== 'applied', 'expected a preview, got an applied post');
  return data;
}

function draftPreviewOf(result: ToolResult<UploadPhotosDraftData>): DraftPreview {
  const data = dataOf(result);
  assert.ok(data.mode !== 'applied', 'expected a preview, got an applied draft');
  return data;
}

function appliedOf(
  result: ToolResult<PostPhotosData | UploadPhotosDraftData>,
): AppliedData {
  const data = dataOf(result);
  assert.ok(data.mode === 'applied', `expected an applied post, got ${data.mode}`);
  return data;
}

/** The carousel variant of the source block, asserted rather than assumed. */
function photoSource(block: SourceBlock): {
  urls: readonly string[];
  photo_cover_index: number;
} {
  assert.equal(block.type, 'url');
  assert.ok('urls' in block, 'expected the carousel source block');
  return block;
}

function errorOf(result: ToolResult<unknown>): ToolError {
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
// tiktok_post_photos — preview (§ 2.6.1, § 3.10)
// ---------------------------------------------------------------------------

test('§ 3.10 a preview without privacy_level returns plan_incomplete and no plan_id', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: undefined })),
    );

    const data = previewOf(result);
    assert.equal(data.mode, 'plan_incomplete');
    assert.equal(data.plan_id, undefined);
    assert.equal(data.expires_at, undefined);
    assert.deepEqual(data.missing, ['privacy_level']);
    assert.equal(data.action, 'DIRECT_POST photos');
    // Nothing was resolved, so nothing is presented as if it had been.
    assert.equal(data.payload.post_info, undefined);

    // The source block is still shown: it is what the user is being asked about.
    const source = photoSource(data.payload.source);
    assert.deepEqual(source.urls, PHOTO_URLS);
    assert.equal(source.photo_cover_index, 1);

    // The choice is handed back with the account's live options attached.
    assert.deepEqual(data.creator.privacy_level_options, [
      'PUBLIC_TO_EVERYONE',
      'SELF_ONLY',
    ]);
    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'user_action');
    assert.equal(hint?.action, 'configure_server');
    assert.ok(hint?.text.includes('PUBLIC_TO_EVERYONE'));
    assert.ok(hint?.text.includes('SELF_ONLY'));
    assert.ok(hint?.text.includes('tiktok_post_photos'));
    assert.ok(hintsOf(result).every((entry) => entry.type !== 'approval_required'));

    // A preview reads creator_info and sends nothing to any init endpoint.
    assert.deepEqual(paths(stub), [CREATOR_PATH]);
  });
});

test('§ 3.10 a complete preview mints a plan whose post_info carries no duet or stitch field', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => run(ctx, previewArgs()));

    const data = previewOf(result);
    assert.equal(data.mode, 'plan');
    assert.ok(data.plan_id !== undefined);
    assert.match(data.plan_id, PLAN_ID_PATTERN);
    // 600 s past the mock clock's baseline, as an absolute ISO-8601 UTC instant.
    assert.equal(data.expires_at, '2026-01-01T00:10:00.000Z');
    assert.equal(data.action, 'DIRECT_POST photos');
    assert.equal(data.account.profile, 'DEFAULT');
    assert.equal(data.account.nickname, 'Test Creator');
    // § 2.5: the raw open_id never appears, not even in the account block.
    assert.ok(!JSON.stringify(data).includes('test-open-id-DEFAULT'));

    const postInfo = data.payload.post_info ?? {};
    // § 3.10: duet and stitch do not exist for a carousel. The fixture account
    // has duets disabled, so a video-shaped resolution would have forced
    // `disable_duet: true` in here.
    assert.deepEqual(Object.keys(postInfo).sort(), [
      'auto_add_music',
      'brand_content_toggle',
      'brand_organic_toggle',
      'description',
      'disable_comment',
      'is_aigc',
      'privacy_level',
      'title',
    ]);
    assert.ok(!JSON.stringify(postInfo).includes('duet'));
    assert.ok(!JSON.stringify(postInfo).includes('stitch'));
    assert.equal(postInfo['title'], TITLE);
    assert.equal(postInfo['description'], DESCRIPTION);
    assert.equal(postInfo['privacy_level'], 'SELF_ONLY');
    assert.equal(postInfo['auto_add_music'], false);
    assert.equal(postInfo['is_aigc'], true);
    // The creator block still reports the restriction — it is only `post_info`
    // that has nowhere to put it.
    assert.equal(data.creator.duet_disabled, true);
    assert.ok(data.derived?.some((entry) => entry.field === 'is_aigc'));
    assert.ok(data.consent_line.includes('Music Usage Confirmation'));

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'approval_required');
    assert.equal(hint?.plan_id, data.plan_id);
    assert.equal(hint?.expires_at, data.expires_at);
    assert.deepEqual(paths(stub), [CREATOR_PATH]);
  });
});

test('§ 2.6.1 a photo preview reports the rate bucket without spending from it', async () => {
  await withCtx({}, async (ctx) => {
    await withFetch(fakeApi(), async () => {
      const first = previewOf(await run(ctx, previewArgs()));
      const second = previewOf(await run(ctx, previewArgs({ privacy_level: undefined })));
      assert.equal(first.meta.rate_bucket.tokens_available, 6);
      assert.equal(second.meta.rate_bucket.tokens_available, 6);
    });
  });
});

test('§ 3.10 an unaudited account carries the SELF_ONLY warning on both preview shapes', async () => {
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

// ---------------------------------------------------------------------------
// tiktok_post_photos — local validation (CC-D10, CC-E3, CC-E9)
// ---------------------------------------------------------------------------

test('cc-d10 a photo_urls entry outside every verified prefix names the first offender only', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(
        ctx,
        previewArgs({
          photo_urls: [
            PHOTO_URLS[0],
            'https://evil.example.net/two.jpg',
            'https://other.example.net/three.jpg',
          ],
        }),
      ),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'url_prefix_unverified');
    assert.ok(error.message.includes('photo_urls[1]'));
    // Reported one at a time: a caller that gets every offender at once tends to
    // blind-fix and re-send.
    assert.ok(!error.message.includes('photo_urls[2]'));
    assert.equal(error.details?.['field'], 'photo_urls[1]');
    assert.ok(error.message.includes('TT_VERIFIED_URL_PREFIXES'));
    assert.ok(error.message.includes('No request was sent'));
    // § 3.10: photos have no FILE_UPLOAD branch, so the catalog's "use source
    // file" way out must not be offered here.
    assert.ok(!error.message.includes('source "file"'));
    assert.ok(error.message.includes('host the media under a verified prefix'));
    assert.equal(stub.calls.length, 0);
  });
});

test('cc-e9 a photo_cover_index past the end of photo_urls is refused before any request', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ photo_cover_index: 3 })),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'invalid_params');
    assert.ok(error.message.includes('photo_cover_index'));
    assert.ok(error.message.includes('3 photos'));
    assert.equal(stub.calls.length, 0);

    // The last valid index is accepted, so the bound is `>=`, not `>`.
    const ok = await withFetch(stub, async () =>
      run(ctx, previewArgs({ photo_cover_index: 2 })),
    );
    assert.equal(previewOf(ok).mode, 'plan');
  });
});

test('cc-e9 the carousel bounds (1–35 photos) are enforced by the schema of both photo tools', () => {
  const many = Array.from({ length: 36 }, (_, i) => `${VERIFIED_PREFIX}${String(i)}.jpg`);
  for (const parse of [
    (args: Args) => postPhotosTool.input.parse(previewArgs(args)),
    (args: Args) => uploadPhotosDraftTool.input.parse(draftArgs(args)),
  ]) {
    assert.throws(() => parse({ photo_urls: [] }));
    assert.throws(() => parse({ photo_urls: many }));
    assert.doesNotThrow(() => parse({ photo_urls: many.slice(0, 35) }));
    // A negative or fractional cover index never reaches the range check.
    assert.throws(() => parse({ photo_cover_index: -1 }));
    assert.throws(() => parse({ photo_cover_index: 1.5 }));
  }
});

test('cc-e3 a title over 90 UTF-16 code units is rejected (photos cap at 90, not 2200)', () => {
  assert.doesNotThrow(() =>
    postPhotosTool.input.parse(previewArgs({ title: 'x'.repeat(90) })),
  );
  assert.throws(() => postPhotosTool.input.parse(previewArgs({ title: 'x'.repeat(91) })));
  // The video cap would have let this through; photos are a different budget.
  assert.throws(() =>
    postPhotosTool.input.parse(previewArgs({ title: 'x'.repeat(2200) })),
  );
  // UTF-16 code units, not code points: 46 emoji are 92 units (CC-E3).
  assert.throws(() =>
    postPhotosTool.input.parse(previewArgs({ title: '🙂'.repeat(46) })),
  );
  assert.doesNotThrow(() =>
    postPhotosTool.input.parse(previewArgs({ title: '🙂'.repeat(45) })),
  );
  // The draft tool shares the limit rather than restating it.
  assert.throws(() =>
    uploadPhotosDraftTool.input.parse(draftArgs({ title: 'x'.repeat(91) })),
  );
});

test('cc-e3 a description over 4000 UTF-16 code units is rejected by both photo tools', () => {
  assert.doesNotThrow(() =>
    postPhotosTool.input.parse(previewArgs({ description: 'd'.repeat(4000) })),
  );
  assert.throws(() =>
    postPhotosTool.input.parse(previewArgs({ description: 'd'.repeat(4001) })),
  );
  assert.doesNotThrow(() =>
    uploadPhotosDraftTool.input.parse(draftArgs({ description: 'd'.repeat(4000) })),
  );
  assert.throws(() =>
    uploadPhotosDraftTool.input.parse(draftArgs({ description: 'd'.repeat(4001) })),
  );
});

test('cc-g1 an unknown argument is rejected by the strict schema of both photo tools', () => {
  // `disable_duet` is the interesting one: it exists on the video tools, so a
  // model that generalises gets a hard error rather than a silently dropped key.
  assert.throws(() => postPhotosTool.input.parse(previewArgs({ disable_duet: true })));
  assert.throws(() => postPhotosTool.input.parse(previewArgs({ disable_stitch: true })));
  assert.throws(() =>
    uploadPhotosDraftTool.input.parse(draftArgs({ privacy_level: 'SELF_ONLY' })),
  );
});

test('§ 2.6.3 a plan_id that is not this server’s shape is rejected by both photo tools', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    await withFetch(stub, async () => {
      const post = await run(ctx, previewArgs({ plan_id: 'plan_not-hex' }));
      assert.equal(errorOf(post).code, 'invalid_params');
      assert.ok(errorOf(post).message.includes('plan_id'));

      const draft = await runDraft(ctx, draftArgs({ plan_id: 'plan_not-hex' }));
      assert.equal(errorOf(draft).code, 'invalid_params');
    });
    assert.equal(stub.calls.length, 0);
  });
});

test('cc-e1 a privacy level the account does not offer is refused on preview and on apply', async () => {
  const unaudited: ApiScript = {
    creator: () => creatorResponse({ privacy_level_options: ['SELF_ONLY'] }),
  };

  await withCtx({}, async (ctx) => {
    const stub = fakeApi(unaudited);
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: 'PUBLIC_TO_EVERYONE' })),
    );
    assert.equal(errorOf(result).code, 'privacy_level_unavailable');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });

  // The apply path re-resolves through the preview's own code, so it refuses
  // the same combination even when a plan once existed for it.
  await withCtx({ TT_WRITE_MODE: 'apply' }, async (ctx) => {
    const stub = fakeApi(unaudited);
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: 'PUBLIC_TO_EVERYONE' })),
    );
    assert.equal(errorOf(result).code, 'privacy_level_unavailable');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('§ 3.10 TT_WRITE_MODE=apply without privacy_level is invalid_params, not a default', async () => {
  await withCtx({ TT_WRITE_MODE: 'apply' }, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, previewArgs({ privacy_level: undefined })),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'invalid_params');
    assert.ok(error.message.includes('privacy_level'));
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

// ---------------------------------------------------------------------------
// tiktok_post_photos — apply (§ 2.6.3)
// ---------------------------------------------------------------------------

test('§ 3.10 apply posts media_type PHOTO with the previewed carousel and journals the attempt', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id }));
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_pub_url~photo.123');
    // PULL_FROM_URL: TikTok fetches the photos itself, so the first state is the
    // download one.
    assert.equal(data.status, 'PROCESSING_DOWNLOAD');
    assert.equal(data.journal, 'recorded');

    // § 2.6.3 re-resolves against live creator settings before it trusts the
    // plan, so the apply reads creator_info again (CC-E1). One init, no upload.
    assert.deepEqual(paths(stub), [CREATOR_PATH, CREATOR_PATH, INIT_PATH]);
    const body = bodyOf(stub, 2);
    assert.equal(body['media_type'], 'PHOTO');
    assert.equal(body['post_mode'], 'DIRECT_POST');
    assert.deepEqual(body['source_info'], {
      source: 'PULL_FROM_URL',
      photo_images: PHOTO_URLS,
      photo_cover_index: 1,
    });
    const sent = body['post_info'] as Record<string, unknown>;
    assert.equal(sent['privacy_level'], 'SELF_ONLY');
    assert.equal(sent['title'], TITLE);
    assert.ok(!Object.hasOwn(sent, 'disable_duet'));
    assert.ok(!Object.hasOwn(sent, 'disable_stitch'));

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'poll');
    assert.equal(hint?.tool, 'tiktok_get_publish_status');
    assert.equal(hint?.publish_id, 'v_pub_url~photo.123');
    assert.ok(hint?.poll_after !== undefined);

    const journal = await readJournal(dir);
    assert.equal(journal[0]?.['type'], 'header');
    const [intent] = linesOf(journal, 'intent');
    const [outcome] = linesOf(journal, 'outcome');
    assert.equal(intent?.['tool'], 'tiktok_post_photos');
    assert.equal(intent?.['mode'], 'DIRECT_POST');
    assert.equal(intent?.['source'], 'PULL_FROM_URL');
    assert.equal(outcome?.['result'], 'ok');
    assert.equal(outcome?.['publish_id'], 'v_pub_url~photo.123');
    assert.equal(outcome?.['attempt_id'], intent?.['attempt_id']);
  });
});

test('cc-e7 changing the carousel after the preview is plan_mismatch and sends no init', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      // One field of the digested payload moved: a different cover photo.
      return await run(
        ctx,
        previewArgs({ plan_id: preview.plan_id, photo_cover_index: 2 }),
      );
    });

    assert.equal(errorOf(result).code, 'plan_mismatch');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('cc-e7 a photo plan is single-use: the second apply is plan_not_found', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      return await run(ctx, previewArgs({ plan_id: preview.plan_id, force: true }));
    });

    assert.equal(errorOf(result).code, 'plan_not_found');
    assert.equal(countPath(stub, INIT_PATH), 1);
  });
});

test('§ 2.8 the local rate limit refuses a photo apply before any network call', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      for (let i = 0; i < 6; i += 1) takePublishToken('DEFAULT', ctx.api.clock);

      const refusedPost = await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      assert.equal(errorOf(refusedPost).code, 'local_rate_limited');
      // The draft tool draws from the same per-account bucket.
      const refusedDraft = await runDraft(ctx, draftArgs({ plan_id: preview.plan_id }));
      assert.equal(errorOf(refusedDraft).code, 'local_rate_limited');

      // Only the preview's own creator_info read ever left the process.
      assert.deepEqual(paths(stub), [CREATOR_PATH]);
    });
  });
});

test('§ 3.10 the duplicate guard excerpts title and description together', async () => {
  await withCtx({}, async (ctx, dir) => {
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

      // § 2.6.3: the guard runs BEFORE consumption, so the very same plan_id is
      // still the token that applies once the user has verified.
      const forced = await run(
        ctx,
        previewArgs({ plan_id: second.plan_id, force: true }),
      );
      assert.equal(appliedOf(forced).publish_id, 'v_pub_url~second.2');
    });

    // § 3.10: the excerpt is title + description, because a carousel is often
    // untitled and every such post would otherwise look identical to the guard.
    const [intent] = linesOf(await readJournal(dir), 'intent');
    assert.equal(intent?.['title_excerpt'], `${TITLE} ${DESCRIPTION}`);
  });
});

test('§ 3.10 a carousel missing either text field journals the other one alone', async () => {
  await withCtx({}, async (ctx, dir) => {
    await withFetch(fakeApi(), async () => {
      // Untitled — the common case for a carousel.
      const untitled = previewOf(await run(ctx, previewArgs({ title: undefined })));
      await run(ctx, previewArgs({ title: undefined, plan_id: untitled.plan_id }));

      // And the mirror image, so the join cannot pick up a stray separator.
      const bare = previewOf(await run(ctx, previewArgs({ description: undefined })));
      const applied = await run(
        ctx,
        previewArgs({ description: undefined, plan_id: bare.plan_id }),
      );
      assert.equal(appliedOf(applied).publish_id, 'v_pub_url~photo.123');
    });

    const [first, second] = linesOf(await readJournal(dir), 'intent');
    assert.equal(first?.['title_excerpt'], DESCRIPTION);
    assert.equal(second?.['title_excerpt'], TITLE);
  });
});

test('cc-b4 an ambiguous transport failure on the content init is journaled as send_ambiguous', async () => {
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

// ---------------------------------------------------------------------------
// wait_for_completion (§ 2.7)
// ---------------------------------------------------------------------------

test('§ 3.10 wait_for_completion polls until the terminal status and returns the public post id', async () => {
  await withCtx({}, async (ctx, _dir, clock) => {
    const stub = fakeApi({
      status: (n) =>
        n < 2
          ? ttEnvelope({ status: 'PROCESSING_DOWNLOAD' })
          : ttEnvelope({
              status: 'PUBLISH_COMPLETE',
              publicaly_available_post_id: ['7300000000000000000'],
            }),
    });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      return await runVirtual(
        clock,
        run(ctx, previewArgs({ plan_id: preview.plan_id, wait_for_completion: true })),
      );
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_pub_url~photo.123');
    assert.equal(data.status, 'PUBLISH_COMPLETE');
    assert.equal(data.public_post_id, '7300000000000000000');
    assert.equal(countPath(stub, STATUS_PATH), 3);
    // Terminal: no reason left to poll.
    assert.equal(hintsOf(result).length, 0);
  });
});

test('§ 2.7 a photo wait that runs out of time is still a success, with a still-processing hint', async () => {
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

      // § 2.7: timeout-is-not-error. The carousel exists; only its final state
      // is still unknown.
      const data = appliedOf(result);
      assert.equal(data.publish_id, 'v_pub_url~photo.123');
      assert.equal(data.status, 'PROCESSING_DOWNLOAD');
      assert.equal(data.journal, 'recorded');
      assert.ok(countPath(stub, STATUS_PATH) > 1, 'expected a poll loop');

      const [hint] = hintsOf(result);
      assert.equal(hint?.type, 'poll');
      assert.equal(hint?.publish_id, 'v_pub_url~photo.123');
      assert.ok(hint?.text.includes('Still PROCESSING_DOWNLOAD after 60 s'));
      assert.ok(hint?.text.includes('do not re-post'));
    },
  );
});

// ---------------------------------------------------------------------------
// tiktok_upload_photos_draft (§ 3.11)
// ---------------------------------------------------------------------------

test('§ 3.11 a draft preview always mints a plan and runs no creator_info pre-flight', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => runDraft(ctx, draftArgs()));

    const data = draftPreviewOf(result);
    // No privacy_level gate: nothing is left for the user to choose, so a draft
    // preview is either a plan or an error — never `plan_incomplete`.
    assert.equal(data.mode, 'plan');
    assert.match(data.plan_id, PLAN_ID_PATTERN);
    assert.equal(data.expires_at, '2026-01-01T00:10:00.000Z');
    assert.equal(data.action, 'MEDIA_UPLOAD photos draft');
    assert.equal(data.account.profile, 'DEFAULT');
    // Without the pre-flight there is no honest nickname to state.
    assert.equal(data.account.nickname, undefined);

    const shape: Record<string, unknown> = { ...data };
    assert.equal(shape['creator'], undefined);
    assert.equal(shape['consent_line'], undefined);
    assert.equal(shape['audit_restrictions_active'], undefined);
    assert.deepEqual(data.payload.post_info, {
      title: TITLE,
      description: DESCRIPTION,
    });
    assert.deepEqual(photoSource(data.payload.source).urls, PHOTO_URLS);

    // § 3.11: a `video.upload`-only grant may not carry the scope for
    // creator_info, so the draft tool must never ask for it.
    assert.equal(countPath(stub, CREATOR_PATH), 0);
    assert.equal(stub.calls.length, 0);

    const [hint] = hintsOf(result);
    assert.equal(hint?.type, 'approval_required');
    assert.equal(hint?.plan_id, data.plan_id);
  });
});

test('§ 3.11 a draft apply sends post_mode MEDIA_UPLOAD and leads with the inbox hint', async () => {
  await withCtx({}, async (ctx, dir) => {
    const stub = fakeApi({ init: () => initResponse('v_inbox~photo.9') });
    const result = await withFetch(stub, async () => {
      const preview = draftPreviewOf(await runDraft(ctx, draftArgs()));
      return await runDraft(ctx, draftArgs({ plan_id: preview.plan_id }));
    });

    const data = appliedOf(result);
    assert.equal(data.publish_id, 'v_inbox~photo.9');
    assert.equal(data.journal, 'recorded');

    // The only request the whole draft flow makes: no creator_info, no upload.
    assert.deepEqual(paths(stub), [INIT_PATH]);
    const body = bodyOf(stub, 0);
    assert.equal(body['media_type'], 'PHOTO');
    assert.equal(body['post_mode'], 'MEDIA_UPLOAD');
    // A draft carries no privacy level and no toggles — the user picks those in
    // the app, so the payload must not grow defaults.
    assert.deepEqual(body['post_info'], { title: TITLE, description: DESCRIPTION });
    assert.deepEqual(body['source_info'], {
      source: 'PULL_FROM_URL',
      photo_images: PHOTO_URLS,
      photo_cover_index: 1,
    });

    // § 5.3: the draft only becomes a post if the user opens the app, so that
    // instruction rides ahead of the poll hint.
    const hints = hintsOf(result);
    assert.equal(hints[0]?.type, 'user_action');
    assert.equal(hints[0]?.action, 'open_tiktok_app');
    assert.ok(hints[0]?.text.includes('Unopened drafts expire.'));
    assert.equal(hints[1]?.type, 'poll');

    const [intent] = linesOf(await readJournal(dir), 'intent');
    assert.equal(intent?.['tool'], 'tiktok_upload_photos_draft');
    assert.equal(intent?.['mode'], 'MEDIA_UPLOAD');
    assert.equal(intent?.['source'], 'PULL_FROM_URL');
  });
});

test('§ 3.11 photo_cover_index defaults to 0 for a single-photo draft', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const applied = await withFetch(stub, async () => {
      const args = { photo_urls: [PHOTO_URLS[0]] };
      const preview = draftPreviewOf(await runDraft(ctx, args));
      assert.equal(photoSource(preview.payload.source).photo_cover_index, 0);
      // An untitled draft sends an empty post_info rather than empty strings.
      assert.deepEqual(preview.payload.post_info, {});
      return await runDraft(ctx, { ...args, plan_id: preview.plan_id });
    });

    assert.equal(appliedOf(applied).publish_id, 'v_pub_url~photo.123');
    assert.deepEqual(bodyOf(stub, 0)['source_info'], {
      source: 'PULL_FROM_URL',
      photo_images: [PHOTO_URLS[0]],
      photo_cover_index: 0,
    });
  });
});

test('§ 2.6.3 a plan minted by tiktok_post_photos is rejected by tiktok_upload_photos_draft', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      // Same carousel, same account, same server — a different tool.
      return await runDraft(ctx, draftArgs({ plan_id: preview.plan_id }));
    });

    assert.equal(errorOf(result).code, 'plan_mismatch');
    assert.equal(countPath(stub, INIT_PATH), 0);
  });
});

test('§ 3.11 a duplicate draft is refused until force, on the draft tool’s own digest', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      init: (n) => initResponse(n === 0 ? 'v_inbox~first.1' : 'v_inbox~second.2'),
    });

    await withFetch(stub, async () => {
      const first = draftPreviewOf(await runDraft(ctx, draftArgs()));
      await runDraft(ctx, draftArgs({ plan_id: first.plan_id }));

      const second = draftPreviewOf(await runDraft(ctx, draftArgs()));
      const refused = await runDraft(ctx, draftArgs({ plan_id: second.plan_id }));
      assert.equal(errorOf(refused).code, 'possible_duplicate');

      const forced = await runDraft(
        ctx,
        draftArgs({ plan_id: second.plan_id, force: true }),
      );
      assert.equal(appliedOf(forced).publish_id, 'v_inbox~second.2');
    });
  });
});

// ---------------------------------------------------------------------------
// declarations (§ 3.10, § 3.11)
// ---------------------------------------------------------------------------

test('§ 3.10 / § 3.11 both photo tools are destructive, and only the posting one needs video.publish', () => {
  for (const spec of [postPhotosTool, uploadPhotosDraftTool]) {
    assert.deepEqual(spec.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(spec.package, 'publish-write');
  }
  assert.equal(postPhotosTool.name, 'tiktok_post_photos');
  assert.deepEqual(postPhotosTool.scopes, ['video.publish']);
  // § 3.11: the whole point of the draft tool is that it works on a draft-only
  // grant.
  assert.equal(uploadPhotosDraftTool.name, 'tiktok_upload_photos_draft');
  assert.deepEqual(uploadPhotosDraftTool.scopes, ['video.upload']);
});

test('§ 2.5 no result either photo tool returns carries a token or a raw open_id', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const serialized = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, previewArgs()));
      const applied = await run(ctx, previewArgs({ plan_id: preview.plan_id }));
      const draft = await runDraft(ctx, draftArgs());
      return JSON.stringify([preview, applied, draft]);
    });

    assert.ok(!serialized.includes('test-access-token-DEFAULT'));
    assert.ok(!serialized.includes('test-refresh-token-DEFAULT'));
    assert.ok(!serialized.includes('test-open-id-DEFAULT'));
    assert.ok(!serialized.includes('test-secret'));
    // § 2.5 names these two explicitly; photos have no upload at all, so their
    // absence should hold by construction — pinned so it stays that way.
    assert.ok(!serialized.includes('upload_url'));
    assert.ok(!serialized.includes('upload_token'));
  });
});
