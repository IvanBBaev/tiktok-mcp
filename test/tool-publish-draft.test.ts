/**
 * `tiktok_upload_video_draft` (TOOLS.md § 3.9) — the draft half of the two-step
 * write contract of § 2.6.
 *
 * The draft tool shares its pipeline with `tiktok_post_video`, so this file does
 * not re-test the pipeline; it pins the four things that are *only* true here:
 *
 * - the pre-flight is absent. A `video.upload`-only grant may not carry the
 *   scope for `creator_info`, so neither the preview nor the apply may read it,
 *   and the preview therefore has no `creator` block and no `consent_line`;
 * - the wire shape is the inbox init — `/v2/post/publish/inbox/video/init/` with
 *   `source_info` and nothing else. `post_mode: "MEDIA_UPLOAD"` is the *digested*
 *   mode of § 2.6.2: it binds the plan and it is what the journal records, but it
 *   is never sent (see the wire-body assertions below);
 * - a plan is bound to the tool that minted it, so a `tiktok_post_video` token
 *   cannot be spent here (§ 2.6.3 step 5) — the two tools differ in what they
 *   create, and one preview must never authorise the other;
 * - the terminal status of the draft flow is `SEND_TO_USER_INBOX`, and every
 *   success carries the § 5.3 "open the app" instruction ahead of the poll hint.
 *
 * Both byte sources are covered end to end, and the `source: "file"` apply
 * doubles as the § 2.5 leak test: the `upload_url` is a bearer credential, so it
 * is asserted absent from the whole serialized result *and* the whole journal,
 * on the success path and on the interrupted-upload path.
 *
 * Upstream is stubbed by route rather than by call order ({@link fakeApi}), and
 * every scripted failure is deliberately non-retryable — a retryable one would
 * park on a `mockClock` backoff that nothing advances.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { planChunks } from '../src/api/upload.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import { resetRateBuckets } from '../src/mcp/plan.js';
import { PLAN_ID_PATTERN, resetPlanStore } from '../src/mcp/plan-store.js';
import type { Hint, ToolError, ToolResult } from '../src/mcp/result.js';
import type {
  AppliedData,
  DraftPreview,
  SourceBlock,
} from '../src/tools/publish-common.js';
import {
  postVideoTool,
  uploadVideoDraftTool,
  type UploadDraftData,
} from '../src/tools/publish-write.js';
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
/** The direct-post init — the draft tool must never touch it. */
const VIDEO_INIT_PATH = '/v2/post/publish/video/init/';
/** The inbox init (TIKTOK-API.md § 4.3) — the only init a draft may send. */
const INBOX_INIT_PATH = '/v2/post/publish/inbox/video/init/';
const STATUS_PATH = '/v2/post/publish/status/fetch/';

/**
 * The `upload_token` is the upload session's bearer credential (§ 2.5), so the
 * fixture value is deliberately unmistakable: any test that finds this substring
 * in a result, a hint or the journal has found a real leak.
 */
const UPLOAD_TOKEN = 'tt-upload-token-DO-NOT-LEAK-0123456789';
const UPLOAD_HOST = 'open-upload.tiktokapis.com';
const UPLOAD_URL = `https://${UPLOAD_HOST}/upload/?upload_id=up_1&upload_token=${UPLOAD_TOKEN}`;

const DRAFT_PUBLISH_ID = 'v_inbox_url~draft.1';

/** The `creator_info` payload — scripted only so a stray read would *succeed*. */
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

function initResponse(publishId = DRAFT_PUBLISH_ID, uploadUrl?: string): Response {
  return ttEnvelope({
    publish_id: publishId,
    ...(uploadUrl === undefined ? {} : { upload_url: uploadUrl }),
  });
}

function statusResponse(status: string): Response {
  return ttEnvelope({ status });
}

type Args = Record<string, unknown>;

async function run(ctx: ToolCtx, args: Args): Promise<ToolResult<UploadDraftData>> {
  return await uploadVideoDraftTool.handler(uploadVideoDraftTool.input.parse(args), ctx);
}

// ---------------------------------------------------------------------------
// a fetch stub that answers by route, not by position
// ---------------------------------------------------------------------------

/** Per-route handlers; `n` is how many times that route was already asked. */
interface ApiScript {
  creator?: (n: number) => Response;
  /** `/inbox/video/init/` — matched before the direct-post init it shadows. */
  inbox?: (n: number) => Response;
  init?: (n: number) => Response;
  status?: (n: number) => Response;
  /** A chunk PUT to the upload host. */
  upload?: (n: number) => Response;
}

interface FakeCall {
  readonly path: string;
  readonly method: string;
  readonly url: string;
  /** Parsed JSON for the API calls; `undefined` for a streamed chunk PUT. */
  readonly body: unknown;
  /** Byte length of a streamed chunk PUT. */
  readonly bytes?: number;
  readonly headers: Headers;
}

interface FakeApi extends FetchStub {
  readonly calls: readonly FakeCall[];
}

function fakeApi(script: ApiScript = {}): FakeApi {
  const calls: FakeCall[] = [];
  const seen = { creator: 0, inbox: 0, init: 0, status: 0, upload: 0 };

  const stub = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    // The chunk body is a stream; draining it here is what a real fetch would
    // do, and the byte count is the only thing worth remembering about it.
    let bytes: number | undefined;
    if (init?.body instanceof ReadableStream) {
      bytes = (await new Response(init.body).arrayBuffer()).byteLength;
    }
    calls.push({
      path,
      method: init?.method ?? 'GET',
      url: String(input),
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
      ...(bytes === undefined ? {} : { bytes }),
      headers,
    });

    if (url.host === UPLOAD_HOST) {
      const n = seen.upload;
      seen.upload += 1;
      // 201 = "the transfer is complete", which is correct for every plan this
      // file can produce (see the single-chunk note in the file-apply test).
      return script.upload?.(n) ?? new Response(null, { status: 201 });
    }
    if (path === INBOX_INIT_PATH) {
      const n = seen.inbox;
      seen.inbox += 1;
      return script.inbox?.(n) ?? initResponse();
    }
    if (path.endsWith('/creator_info/query/')) {
      const n = seen.creator;
      seen.creator += 1;
      return script.creator?.(n) ?? ttEnvelope(CREATOR_PAYLOAD);
    }
    if (path.endsWith('/video/init/')) {
      const n = seen.init;
      seen.init += 1;
      return script.init?.(n) ?? initResponse('v_pub~direct.1');
    }
    if (path.endsWith('/status/fetch/')) {
      const n = seen.status;
      seen.status += 1;
      if (script.status === undefined) {
        throw new Error('fakeApi: unscripted status read');
      }
      return script.status(n);
    }
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

function callTo(stub: FakeApi, path: string): FakeCall {
  const call = stub.calls.find((seen) => seen.path === path);
  assert.ok(call !== undefined, `no request was sent to ${path}`);
  return call;
}

function putCalls(stub: FakeApi): FakeCall[] {
  return stub.calls.filter((call) => call.method === 'PUT');
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/**
 * The sandbox layout: the credential file (and therefore the journal) at the
 * top, `TT_MEDIA_ROOT` one level down. Keeping the root a *subdirectory* is what
 * makes the CC-D8 escape test expressible — `outside.mp4` next to the env file
 * is genuinely outside the root without leaving the sandbox.
 */
interface Sandbox {
  dir: string;
  media: string;
}

async function withCtx<T>(
  /** Server settings; an `undefined` value means "not set in the environment". */
  env: Record<string, string | undefined>,
  fn: (ctx: ToolCtx, box: Sandbox, clock: MockClock) => Promise<T>,
): Promise<T> {
  resetPlanStore();
  resetRateBuckets();
  const sandbox = await fsSandbox();
  try {
    const media = join(sandbox.dir, 'media');
    await mkdir(media);
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
      TT_MEDIA_ROOT: media,
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
    return await fn({ api, log: NOOP_LOGGER }, { dir: sandbox.dir, media }, clock);
  } finally {
    resetPlanStore();
    resetRateBuckets();
    await sandbox.cleanup();
  }
}

/** A deterministic media file. Bytes are irrelevant; the size drives the plan. */
async function writeClip(path: string, size = 4096): Promise<number> {
  await writeFile(path, new Uint8Array(size).fill(7));
  return size;
}

/**
 * Await `pending` while pushing virtual time forward in slices. The poll loop
 * registers its next sleep only once the read before it resolved, so a single
 * `advance` past the deadline would run out of due waiters and stop early.
 */
async function runVirtual<T>(clock: MockClock, pending: Promise<T>): Promise<T> {
  let done = false;
  const settled = pending.finally(() => {
    done = true;
  });
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

function dataOf(result: ToolResult<UploadDraftData>): UploadDraftData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

function previewOf(result: ToolResult<UploadDraftData>): DraftPreview {
  const data = dataOf(result);
  assert.ok(data.mode === 'plan', `expected a preview, got ${data.mode}`);
  return data;
}

function appliedOf(result: ToolResult<UploadDraftData>): AppliedData {
  const data = dataOf(result);
  assert.ok(data.mode === 'applied', `expected an applied draft, got ${data.mode}`);
  return data;
}

function errorOf(result: ToolResult<UploadDraftData>): ToolError {
  assert.equal(result.ok, false, JSON.stringify(result.data));
  assert.ok(result.error !== undefined);
  return result.error;
}

function hintsOf(result: ToolResult<UploadDraftData>): readonly Hint[] {
  return result.hints ?? [];
}

/** The `url` variant of the source block, asserted rather than assumed. */
function urlSource(block: SourceBlock): { url: string } {
  assert.equal(block.type, 'url');
  assert.ok('url' in block && typeof block.url === 'string');
  return { url: block.url };
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

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

type JournalLine = Record<string, unknown>;

async function journalText(box: Sandbox): Promise<string> {
  return await readFile(join(box.dir, 'journal.ndjson'), 'utf8');
}

/** The journal as written. A fresh file opens with a `header` record. */
async function readJournal(box: Sandbox): Promise<JournalLine[]> {
  const raw = await journalText(box);
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalLine);
}

function linesOf(lines: readonly JournalLine[], type: string): JournalLine[] {
  return lines.filter((line) => line['type'] === type);
}

function oneLine(lines: readonly JournalLine[], type: string): JournalLine {
  const [first, ...rest] = linesOf(lines, type);
  assert.ok(first !== undefined, `no ${type} record in the journal`);
  assert.equal(rest.length, 0, `expected exactly one ${type} record`);
  return first;
}

// ---------------------------------------------------------------------------
// preview — source: "url" (TOOLS.md § 3.9, § 2.6.1)
// ---------------------------------------------------------------------------

test('§ 3.9: a url preview mints a plan and states the draft action with no creator block', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, { source: 'url', video_url: VIDEO_URL }),
    );

    const preview = previewOf(result);
    assert.equal(preview.mode, 'plan');
    assert.match(preview.plan_id, PLAN_ID_PATTERN);
    // TT_PLAN_TTL_S defaults to 600 s from the frozen 2026-01-01T00:00:00Z.
    assert.equal(preview.expires_at, '2026-01-01T00:10:00.000Z');
    assert.equal(preview.action, 'MEDIA_UPLOAD video draft');
    assert.deepEqual(preview.payload.source, { type: 'url', url: VIDEO_URL });
    assert.equal(urlSource(preview.payload.source).url, VIDEO_URL);

    // § 3.9: no pre-flight means there is nothing honest to put in a `creator`
    // block, and a draft carries no caption or privacy level to consent to.
    assert.ok(!('creator' in preview));
    assert.ok(!('consent_line' in preview));
    assert.ok(!('audit_restrictions_active' in preview));
    assert.ok(!('nickname' in preview.account));
    assert.ok(!('post_info' in preview.payload));
    assert.equal(preview.account.profile, 'DEFAULT');

    // A preview is a read that reads nothing upstream at all.
    assert.equal(stub.calls.length, 0);
    const [hint, ...rest] = hintsOf(result);
    assert.equal(hint?.type, 'approval_required');
    assert.equal(rest.length, 0);
  });
});

test('§ 3.9: neither the draft preview nor the draft apply reads creator_info', async () => {
  await withCtx({}, async (ctx, box) => {
    const stub = fakeApi();
    await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, { source: 'url', video_url: VIDEO_URL }));
      assert.equal(countPath(stub, CREATOR_PATH), 0);

      const applied = appliedOf(
        await run(ctx, {
          source: 'url',
          video_url: VIDEO_URL,
          plan_id: preview.plan_id,
        }),
      );
      assert.equal(applied.mode, 'applied');
    });

    // The whole point of § 3.9: a video.upload-only grant may not carry the
    // scope for creator_info, so the tool may never depend on it.
    assert.equal(countPath(stub, CREATOR_PATH), 0);
    assert.deepEqual(paths(stub), [INBOX_INIT_PATH]);
    // ...and no draft path ever reached the direct-post init either.
    assert.equal(countPath(stub, VIDEO_INIT_PATH), 0);
    const journal = await readJournal(box);
    assert.equal(linesOf(journal, 'intent').length, 1);
  });
});

// ---------------------------------------------------------------------------
// apply — source: "url" (TOOLS.md § 2.6.3, § 5.3)
// ---------------------------------------------------------------------------

test('§ 3.9: applying a url plan posts source_info to the inbox init and journals the attempt', async () => {
  await withCtx({}, async (ctx, box) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, { source: 'url', video_url: VIDEO_URL }));
      return await run(ctx, {
        source: 'url',
        video_url: VIDEO_URL,
        plan_id: preview.plan_id,
      });
    });

    const applied = appliedOf(result);
    assert.equal(applied.publish_id, DRAFT_PUBLISH_ID);
    assert.equal(applied.status, 'PROCESSING_DOWNLOAD');
    assert.equal(applied.journal, 'recorded');

    // The wire body of TIKTOK-API.md § 4.3: `source_info` and nothing else. The
    // `post_mode: "MEDIA_UPLOAD"` of § 2.6.2 is the *digested* mode — it binds
    // the plan and it is journaled, but the inbox endpoint accepts no such
    // field, so sending one would be a contract error rather than a nicety.
    const init = callTo(stub, INBOX_INIT_PATH);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.body, {
      source_info: { source: 'PULL_FROM_URL', video_url: VIDEO_URL },
    });
    assert.equal(countPath(stub, VIDEO_INIT_PATH), 0);

    // § 5.3: the draft only becomes a post if the user opens the app, so that
    // instruction rides ahead of the poll hint.
    const [first, second, ...rest] = hintsOf(result);
    assert.equal(first?.type, 'user_action');
    assert.equal(first?.action, 'open_tiktok_app');
    assert.match(String(first?.text), /TikTok app notification/);
    assert.equal(second?.type, 'poll');
    assert.equal(second?.tool, 'tiktok_get_publish_status');
    assert.equal(second?.publish_id, DRAFT_PUBLISH_ID);
    assert.equal(rest.length, 0);

    const journal = await readJournal(box);
    const intent = oneLine(journal, 'intent');
    assert.equal(intent['tool'], 'tiktok_upload_video_draft');
    assert.equal(intent['mode'], 'MEDIA_UPLOAD');
    assert.equal(intent['source'], 'PULL_FROM_URL');
    assert.equal(intent['profile'], 'DEFAULT');
    assert.equal(typeof intent['payload_digest'], 'string');
    const outcome = oneLine(journal, 'outcome');
    assert.equal(outcome['result'], 'ok');
    assert.equal(outcome['publish_id'], DRAFT_PUBLISH_ID);
    assert.equal(outcome['attempt_id'], intent['attempt_id']);
  });
});

// ---------------------------------------------------------------------------
// local validation — nothing leaves the process (TOOLS.md § 3.0)
// ---------------------------------------------------------------------------

test('§ 3.9 / CC-D10: a video_url outside every verified prefix is refused before any request', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () =>
      run(ctx, { source: 'url', video_url: 'https://evil.example.net/clip.mp4' }),
    );

    const error = errorOf(result);
    assert.equal(error.code, 'url_prefix_unverified');
    assert.ok(error.message.includes('video_url'));
    assert.ok(error.message.includes('TT_VERIFIED_URL_PREFIXES'));
    assert.ok(error.message.includes('No request was sent'));
    assert.equal(stub.calls.length, 0);
  });
});

test('§ 3.9: the two byte sources are mutually exclusive and each one requires its own field', async () => {
  await withCtx({}, async (ctx, box) => {
    const clip = join(box.media, 'clip.mp4');
    await writeClip(clip);
    const stub = fakeApi();

    const cases: { args: Args; needle: RegExp }[] = [
      {
        args: { source: 'url', video_url: VIDEO_URL, file_path: clip },
        needle: /file_path: must not be set when source is "url"/,
      },
      {
        args: { source: 'file', file_path: clip, video_url: VIDEO_URL },
        needle: /video_url: must not be set when source is "file"/,
      },
      { args: { source: 'url' }, needle: /video_url: required when source is "url"/ },
      { args: { source: 'file' }, needle: /file_path: required when source is "file"/ },
    ];

    await withFetch(stub, async () => {
      for (const { args, needle } of cases) {
        const error = errorOf(await run(ctx, args));
        assert.equal(error.code, 'invalid_params', JSON.stringify(args));
        assert.match(error.message, needle);
      }
    });

    // Every refusal is a local one — the mutual exclusion is a typo, not a
    // question for TikTok.
    assert.equal(stub.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// preview — source: "file" (TOOLS.md § 3.9, § 2.6.1)
// ---------------------------------------------------------------------------

test('§ 3.9 / § 2.6.1: a file preview shows the resolved path, the size and the chunk plan', async () => {
  await withCtx({}, async (ctx, box) => {
    const clip = join(box.media, 'clip.mp4');
    const size = await writeClip(clip);
    const stub = fakeApi();

    const result = await withFetch(stub, async () =>
      run(ctx, { source: 'file', file_path: 'clip.mp4' }),
    );

    const preview = previewOf(result);
    const source = fileSource(preview.payload.source);
    // A relative `file_path` resolves against TT_MEDIA_ROOT, never the CWD.
    assert.equal(source.resolved_path, clip);
    assert.equal(source.file_size, size);

    // The summary is the plan the apply will execute, not a restatement of the
    // arguments: it is checked against the planner rather than hard-coded.
    const plan = planChunks(size);
    assert.deepEqual(source.chunk_summary, {
      file_size: size,
      chunk_size: plan.chunkSize,
      chunks: plan.totalChunkCount,
    });

    assert.match(preview.plan_id, PLAN_ID_PATTERN);
    assert.equal(preview.action, 'MEDIA_UPLOAD video draft');
    assert.ok(!('creator' in preview));
    // Statting a file is not a network call, and no init is spent on a preview.
    assert.equal(stub.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// apply — source: "file" (TIKTOK-API.md §§ 4.6–4.8)
// ---------------------------------------------------------------------------

test('§ 3.9 / CC-D6: applying a file plan declares FILE_UPLOAD and PUTs every planned chunk', async () => {
  await withCtx({}, async (ctx, box) => {
    const clip = join(box.media, 'clip.mp4');
    const size = await writeClip(clip);
    const plan = planChunks(size);
    // `planChunks` merges the remainder into the final chunk, so a plan only
    // reaches two chunks at 128,000,000 bytes — out of reach for a test file.
    // The count is therefore asserted against the planner, not against `1`.
    assert.equal(plan.totalChunkCount, 1);

    const stub = fakeApi({ inbox: () => initResponse(DRAFT_PUBLISH_ID, UPLOAD_URL) });
    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, { source: 'file', file_path: clip }));
      return await run(ctx, {
        source: 'file',
        file_path: clip,
        plan_id: preview.plan_id,
      });
    });

    const applied = appliedOf(result);
    assert.equal(applied.publish_id, DRAFT_PUBLISH_ID);
    // FILE_UPLOAD has already moved the bytes, so the first state is processing.
    assert.equal(applied.status, 'PROCESSING_UPLOAD');

    const init = callTo(stub, INBOX_INIT_PATH);
    assert.deepEqual(init.body, {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
      },
    });

    const puts = putCalls(stub);
    assert.equal(puts.length, plan.totalChunkCount);
    const [put] = puts;
    assert.ok(put !== undefined);
    assert.equal(put.url, UPLOAD_URL);
    assert.equal(put.bytes, size);
    // `Content-Range`'s last byte is inclusive (TIKTOK-API.md § 4.6).
    assert.equal(put.headers.get('content-range'), `bytes 0-${String(size - 1)}/${size}`);
    assert.equal(put.headers.get('content-type'), 'video/mp4');
    // § 4.7 rule 4: the upload_token in the URL *is* the credential.
    assert.equal(put.headers.get('authorization'), null);

    const journal = await readJournal(box);
    assert.equal(oneLine(journal, 'intent')['source'], 'FILE_UPLOAD');
    assert.equal(oneLine(journal, 'outcome')['result'], 'ok');
  });
});

test('CC-D8: a file outside TT_MEDIA_ROOT — directly or through a symlink — never reaches the network', async () => {
  await withCtx({}, async (ctx, box) => {
    const outside = join(box.dir, 'outside.mp4');
    await writeClip(outside);
    const escape = join(box.media, 'escape.mp4');
    await symlink(outside, escape);
    const stub = fakeApi();

    await withFetch(stub, async () => {
      for (const filePath of [outside, escape]) {
        const error = errorOf(await run(ctx, { source: 'file', file_path: filePath }));
        assert.equal(error.code, 'file_outside_media_root', filePath);
        // The symlink is *resolved* before containment is decided, so the
        // message names the real file rather than the link that hid it.
        assert.ok(error.message.includes(outside), error.message);
        assert.ok(error.message.includes(box.media));
      }
    });

    assert.equal(stub.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// plan binding (TOOLS.md § 2.6.3 step 5)
// ---------------------------------------------------------------------------

test('§ 2.6.3 step 5: a plan_id minted by tiktok_post_video is not appliable as a draft', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi();
    const result = await withFetch(stub, async () => {
      const foreign = await postVideoTool.handler(
        postVideoTool.input.parse({
          source: 'url',
          video_url: VIDEO_URL,
          title: 'A clip',
          privacy_level: 'SELF_ONLY',
        }),
        ctx,
      );
      assert.equal(foreign.ok, true, JSON.stringify(foreign.error));
      const data = foreign.data;
      assert.ok(data !== undefined && data.mode === 'plan');
      const planId = data.plan_id;
      assert.ok(typeof planId === 'string');

      return await run(ctx, { source: 'url', video_url: VIDEO_URL, plan_id: planId });
    });

    // A preview authorises one action by one tool: the post tool's token cannot
    // buy a draft, even though both would send the same bytes.
    const error = errorOf(result);
    assert.equal(error.code, 'plan_mismatch');
    // Only the post tool's own pre-flight went out; no draft was ever initiated.
    assert.equal(countPath(stub, CREATOR_PATH), 1);
    assert.equal(countPath(stub, INBOX_INIT_PATH), 0);
    assert.equal(countPath(stub, VIDEO_INIT_PATH), 0);
  });
});

// ---------------------------------------------------------------------------
// duplicate guard (TOOLS.md § 2.6.5)
// ---------------------------------------------------------------------------

test('§ 2.6.5: a second identical apply is refused, and the same plan_id still applies with force', async () => {
  await withCtx({}, async (ctx, box) => {
    const stub = fakeApi();
    const args = { source: 'url', video_url: VIDEO_URL };

    await withFetch(stub, async () => {
      const first = previewOf(await run(ctx, args));
      appliedOf(await run(ctx, { ...args, plan_id: first.plan_id }));

      const second = previewOf(await run(ctx, args));
      // Step 6 runs *before* step 7, so the refusal leaves the plan unspent.
      const refused = errorOf(await run(ctx, { ...args, plan_id: second.plan_id }));
      assert.equal(refused.code, 'possible_duplicate');
      assert.match(refused.message, /force: true/);
      assert.equal(countPath(stub, INBOX_INIT_PATH), 1);

      const forced = appliedOf(
        await run(ctx, { ...args, plan_id: second.plan_id, force: true }),
      );
      assert.equal(forced.publish_id, DRAFT_PUBLISH_ID);
    });

    // Exactly two inits: the duplicate refusal never reached the network.
    assert.equal(countPath(stub, INBOX_INIT_PATH), 2);
    const journal = await readJournal(box);
    assert.equal(linesOf(journal, 'intent').length, 2);
    assert.equal(linesOf(journal, 'outcome').length, 2);
  });
});

// ---------------------------------------------------------------------------
// wait_for_completion (TOOLS.md § 2.7, § 3.9)
// ---------------------------------------------------------------------------

test('§ 2.7 / § 3.9: wait_for_completion polls until the terminal SEND_TO_USER_INBOX', async () => {
  await withCtx({}, async (ctx, box, clock) => {
    const stub = fakeApi({
      status: (n) =>
        statusResponse(n === 0 ? 'PROCESSING_DOWNLOAD' : 'SEND_TO_USER_INBOX'),
    });

    const result = await withFetch(stub, async () => {
      const preview = previewOf(await run(ctx, { source: 'url', video_url: VIDEO_URL }));
      return await runVirtual(
        clock,
        run(ctx, {
          source: 'url',
          video_url: VIDEO_URL,
          plan_id: preview.plan_id,
          wait_for_completion: true,
        }),
      );
    });

    const applied = appliedOf(result);
    // The draft flow's success is the inbox, not PUBLISH_COMPLETE.
    assert.equal(applied.status, 'SEND_TO_USER_INBOX');
    assert.equal(applied.publish_id, DRAFT_PUBLISH_ID);
    assert.equal(countPath(stub, STATUS_PATH), 2);

    // A terminal status is not a timeout, so no poll hint is attached — the
    // § 5.3 instruction is the only thing left to say.
    const [only, ...rest] = hintsOf(result);
    assert.equal(only?.type, 'user_action');
    assert.equal(only?.action, 'open_tiktok_app');
    assert.equal(rest.length, 0);

    assert.equal(oneLine(await readJournal(box), 'outcome')['result'], 'ok');
  });
});

// ---------------------------------------------------------------------------
// § 2.5 — the upload URL is a credential
// ---------------------------------------------------------------------------

test('§ 2.5: the upload_url and its upload_token never reach a result, a hint or the journal', async () => {
  await withCtx({}, async (ctx, box) => {
    const ok = join(box.media, 'ok.mp4');
    const bad = join(box.media, 'bad.mp4');
    await writeClip(ok);
    await writeClip(bad, 2048);

    // The second attempt fails the transfer with an expired upload URL (403 is
    // terminal on this URL, § 4.8) so the leak check also covers the error text
    // and the `upload_failed` journal outcome, not just the happy path.
    const stub = fakeApi({
      inbox: (n) =>
        initResponse(n === 0 ? 'v_inbox~ok.1' : 'v_inbox~bad.1', `${UPLOAD_URL}&i=${n}`),
      upload: (n) =>
        n === 0
          ? new Response(null, { status: 201 })
          : new Response(null, { status: 403 }),
    });

    const [good, failed] = await withFetch(stub, async () => {
      const okPreview = previewOf(await run(ctx, { source: 'file', file_path: ok }));
      const okResult = await run(ctx, {
        source: 'file',
        file_path: ok,
        plan_id: okPreview.plan_id,
      });
      const badPreview = previewOf(await run(ctx, { source: 'file', file_path: bad }));
      const badResult = await run(ctx, {
        source: 'file',
        file_path: bad,
        plan_id: badPreview.plan_id,
      });
      return [okResult, badResult];
    });

    assert.ok(good !== undefined && failed !== undefined);
    assert.equal(appliedOf(good).publish_id, 'v_inbox~ok.1');
    const interrupted = errorOf(failed);
    assert.equal(interrupted.code, 'upload_interrupted');
    // The failure has to name the publish_id — an attempt exists upstream.
    assert.ok(interrupted.message.includes('v_inbox~bad.1'));

    // Everything the caller can see, and everything left on disk.
    const surface = [
      JSON.stringify(good),
      JSON.stringify(failed),
      await journalText(box),
    ].join('\n');
    for (const secret of [UPLOAD_TOKEN, UPLOAD_HOST, 'upload_token', 'upload_url']) {
      assert.ok(
        !surface.includes(secret),
        `"${secret}" leaked into a result, a hint or the journal`,
      );
    }

    const journal = await readJournal(box);
    const outcomes = linesOf(journal, 'outcome');
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0]?.['result'], 'ok');
    // CC-B4: the init already minted a publish_id, so this is `upload_failed` —
    // never `error`, which a reader would take as "nothing was created".
    assert.equal(outcomes[1]?.['result'], 'upload_failed');
    assert.equal(outcomes[1]?.['publish_id'], 'v_inbox~bad.1');
  });
});
