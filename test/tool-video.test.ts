/**
 * `tiktok_list_videos` and `tiktok_query_videos` (TOOLS.md §§ 3.3, 3.4).
 *
 * Everything interesting in these two tools is pagination policy, so the tests
 * are organised by corner case: the cursor is opaque and is handed back
 * untouched (CC-C1), an empty page with `has_more: true` is legal (CC-C2), a
 * cursor that does not advance ends the walk instead of looping forever
 * (CC-C3), the `fetch_all` cap is only "truncation" when it actually cuts the
 * stream (CC-C4), `max_count` is clamped locally (CC-C5), more than 20 ids is a
 * local rejection (CC-C6) and ids TikTok omits are reported (CC-C7).
 *
 * The § 5.2 trust boundary gets its own case: cursors and video ids are
 * upstream strings and must never appear inside hint text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  listVideosTool,
  queryVideosTool,
  type ListVideosData,
  type QueryVideosData,
} from '../src/tools/video.js';
import {
  baselineEnv,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withFetch,
  type RecordedCall,
  type RecordingFetchStub,
} from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

function apiCtx(overrides: Record<string, string> = {}): ApiContext {
  return createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...baselineEnv(), ...overrides }),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
}

function toolCtx(overrides: Record<string, string> = {}): ToolCtx {
  return { api: apiCtx(overrides), log: NOOP_LOGGER };
}

/** One upstream page. `cursor` is sent as TikTok sends it: a JSON number. */
function page(
  ids: readonly string[],
  cursor: number | string,
  hasMore: boolean,
): Response {
  return ttEnvelope({
    videos: ids.map((id) => ({ id, title: `title ${id}` })),
    cursor,
    has_more: hasMore,
  });
}

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  assert.ok(call !== undefined, 'expected a recorded request');
  return call.json() as Record<string, unknown>;
}

function listData(result: ToolResult<ListVideosData>): ListVideosData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

function queryData(result: ToolResult<QueryVideosData>): QueryVideosData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

/** Run the list handler over a scripted upstream. */
async function list(
  args: Parameters<typeof listVideosTool.handler>[0],
  stub: RecordingFetchStub,
  ctx: ToolCtx = toolCtx(),
): Promise<ToolResult<ListVideosData>> {
  return withFetch(stub, async () => listVideosTool.handler(args, ctx));
}

// ---------------------------------------------------------------------------
// tiktok_list_videos — one page
// ---------------------------------------------------------------------------

test('a plain call fetches one page and reports the end of the list', async () => {
  const stub = scriptFetch([page(['v1', 'v2'], 0, false)]);
  const result = await list({}, stub);

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(bodyOf(stub.calls[0]), { max_count: 20 });
  assert.deepEqual(listData(result), {
    videos: [
      { id: 'v1', title: 'title v1' },
      { id: 'v2', title: 'title v2' },
    ],
    meta: { has_more: false },
  });
  assert.equal(result.hints, undefined);
});

test('cc-c1: the next cursor is handed back exactly as TikTok sent it', async () => {
  const stub = scriptFetch([page(['v1'], 1712345678000, true)]);
  const result = await list({}, stub);

  assert.equal(listData(result).meta.has_more, true);
  assert.equal(listData(result).meta.next_cursor, '1712345678000');
});

test('cc-c1: a cursor from a previous result is sent back unchanged', async () => {
  const stub = scriptFetch([page([], 0, false)]);
  await list({ cursor: 'opaque-page-token' }, stub);

  assert.equal(bodyOf(stub.calls[0])['cursor'], 'opaque-page-token');
});

test('has_more without a usable cursor advertises no resume token', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [], has_more: true })]);
  const result = await list({}, stub);

  assert.equal(listData(result).meta.has_more, true);
  assert.equal(listData(result).meta.next_cursor, undefined);
});

test('cc-c5: max_count out of range is clamped locally and explained, not rejected', async () => {
  const stub = scriptFetch([page(['v1'], 0, false)]);
  const result = await list({ max_count: 50 }, stub);

  assert.equal(bodyOf(stub.calls[0])['max_count'], 20);
  assert.equal(listData(result).meta.max_count, 20);
  const hint = result.hints?.[0];
  assert.ok(hint !== undefined);
  assert.equal(hint.type, 'note');
  assert.ok(hint.text.includes('max_count 50'));
  assert.ok(hint.text.includes('1–20'));
});

test('cc-c5: an in-range max_count is used verbatim and says nothing', async () => {
  const stub = scriptFetch([page(['v1'], 0, false)]);
  const result = await list({ max_count: 5 }, stub);

  assert.equal(bodyOf(stub.calls[0])['max_count'], 5);
  assert.equal(listData(result).meta.max_count, undefined);
  assert.equal(result.hints, undefined);
});

test('cc-c5: the schema itself accepts an out-of-range max_count', () => {
  // Deliberately no .min()/.max(): a validation error would cost the model a
  // whole turn for a number it can only have meant as "as many as possible".
  assert.equal(listVideosTool.input.safeParse({ max_count: 500 }).success, true);
  assert.equal(listVideosTool.input.safeParse({ max_count: 0 }).success, true);
  assert.equal(listVideosTool.input.safeParse({ max_count: 1.5 }).success, false);
});

// ---------------------------------------------------------------------------
// tiktok_list_videos — fetch_all
// ---------------------------------------------------------------------------

test('cc-c4: a walk that reaches the end of the list is complete, not truncated', async () => {
  const stub = scriptFetch([
    page(['v1', 'v2'], 'c1', true),
    page(['v3', 'v4'], 'c2', false),
  ]);
  const result = await list(
    { fetch_all: true },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '4' }),
  );

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(
    listData(result).videos.map((video) => video.id),
    ['v1', 'v2', 'v3', 'v4'],
  );
  // The cap was reached exactly at a page boundary — the list still ended.
  assert.deepEqual(listData(result).meta, { has_more: false });
  assert.equal(result.hints, undefined);
});

test('cc-c4: a walk cut by the server cap reports truncation and how to resume', async () => {
  const stub = scriptFetch([page(['v1', 'v2'], 'c1', true), page(['v3'], 'c2', true)]);
  const result = await list(
    { fetch_all: true },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '3' }),
  );

  assert.deepEqual(listData(result).meta, {
    has_more: true,
    next_cursor: 'c2',
    truncation: { truncated: true, reason: 'item_cap', returned: 3, resume_cursor: 'c2' },
  });
  const hint = result.hints?.[0];
  assert.ok(hint !== undefined);
  assert.equal(hint.type, 'note');
  assert.ok(hint.text.includes('server cap of 3'));
  assert.ok(hint.text.includes('meta.truncation.resume_cursor'));
});

test('the walk never asks for more videos than the cap has room for', async () => {
  const stub = scriptFetch([page(['v1', 'v2'], 'c1', true), page(['v3'], 'c2', true)]);
  await list({ fetch_all: true }, stub, toolCtx({ TT_FETCH_ALL_CAP: '3' }));

  assert.equal(bodyOf(stub.calls[0])['max_count'], 3);
  assert.equal(bodyOf(stub.calls[1])['max_count'], 1);
});

test('an over-long page is cut to the cap and resumes from the cursor that was sent', async () => {
  const stub = scriptFetch([page(['v1', 'v2', 'v3', 'v4', 'v5'], 'c9', true)]);
  const result = await list(
    { fetch_all: true, cursor: 'c0' },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '3' }),
  );

  assert.deepEqual(
    listData(result).videos.map((video) => video.id),
    ['v1', 'v2', 'v3'],
  );
  // Re-reading a page costs duplicates, skipping one costs videos: the sent
  // cursor is the only value that loses neither.
  assert.equal(listData(result).meta.truncation?.resume_cursor, 'c0');
});

test('an over-long first page has no cursor to resume from and says so', async () => {
  const stub = scriptFetch([page(['v1', 'v2', 'v3'], 'c9', true)]);
  const result = await list(
    { fetch_all: true },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '2' }),
  );

  // Nothing was sent, so there is nothing to hand back: the caller is told to
  // supply a cursor rather than offered one that would repeat the same page.
  assert.deepEqual(listData(result).meta.truncation, {
    truncated: true,
    reason: 'item_cap',
    returned: 2,
  });
  assert.equal(listData(result).meta.next_cursor, undefined);
  assert.ok(result.hints?.[0]?.text.includes('with an explicit cursor'));
});

test('cc-c2: an empty page with has_more true does not end the walk', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [], cursor: 'c1', has_more: true }),
    ttEnvelope({ videos: [], cursor: 'c2', has_more: true }),
    page(['v1'], 'c3', false),
  ]);
  const result = await list({ fetch_all: true }, stub);

  assert.equal(stub.calls.length, 3);
  assert.deepEqual(
    listData(result).videos.map((video) => video.id),
    ['v1'],
  );
  assert.equal(listData(result).meta.has_more, false);
});

test('cc-c3: a cursor that does not advance stops the walk instead of looping', async () => {
  const stub = scriptFetch([
    page(['v1'], 'stuck', true),
    page(['v2'], 'stuck', true),
    // A third response exists so a loop would be visible as an extra call
    // rather than as a harness error.
    page(['v3'], 'stuck', true),
  ]);
  const result = await list({ fetch_all: true }, stub);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(
    listData(result).videos.map((video) => video.id),
    ['v1', 'v2'],
  );
  // The cursor is dead, so it is not offered as a resume token — and the reason
  // says which of the two short-walk stories this is, without reading the hint.
  assert.deepEqual(listData(result).meta.truncation, {
    truncated: true,
    reason: 'cursor_stuck',
    returned: 2,
  });
  assert.equal(listData(result).meta.next_cursor, undefined);
  const hint = result.hints?.[0];
  assert.ok(hint !== undefined);
  assert.ok(hint.text.includes('same pagination cursor twice'));
});

test('cc-c3: a page that carries no cursor at all cannot advance either', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [{ id: 'v1' }], has_more: true }),
    ttEnvelope({ videos: [{ id: 'v2' }], has_more: true }),
  ]);
  const result = await list({ fetch_all: true }, stub);

  assert.equal(stub.calls.length, 2);
  assert.equal(listData(result).meta.next_cursor, undefined);
  assert.equal(listData(result).meta.truncation?.reason, 'cursor_stuck');
  assert.ok(result.hints?.[0]?.text.includes('same pagination cursor twice'));
});

test('a clamp note and a cap note can both be reported, clamp first', async () => {
  const stub = scriptFetch([page(['v1', 'v2'], 'c1', true)]);
  const result = await list(
    { fetch_all: true, max_count: 99 },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '2' }),
  );

  assert.deepEqual(
    result.hints?.map((hint) => hint.type),
    ['note', 'note'],
  );
  assert.ok(result.hints?.[0]?.text.includes('max_count 99'));
  assert.ok(result.hints?.[1]?.text.includes('server cap of 2'));
});

test('§ 5.2 rule 3: no upstream string ever reaches a hint', async () => {
  const stub = scriptFetch([
    page(['video-id-7351', 'video-id-7352'], 'CURSOR-SECRET', true),
  ]);
  const result = await list(
    { fetch_all: true, cursor: 'SENT-CURSOR' },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '2' }),
  );

  const text = (result.hints ?? []).map((hint) => hint.text).join(' ');
  for (const upstream of ['CURSOR-SECRET', 'SENT-CURSOR', 'video-id-7351', 'title ']) {
    assert.ok(!text.includes(upstream), `hint text leaked ${upstream}`);
  }
});

test('progress is reported once per page and never overshoots the total', async () => {
  const stub = scriptFetch([page(['v1', 'v2'], 'c1', true), page(['v3'], 'c2', false)]);
  const seen: { done: number; total: number }[] = [];
  const ctx: ToolCtx = {
    ...toolCtx({ TT_FETCH_ALL_CAP: '10' }),
    progress: (done, total) => seen.push({ done, total }),
  };

  await list({ fetch_all: true }, stub, ctx);

  assert.deepEqual(seen, [
    { done: 2, total: 10 },
    { done: 3, total: 10 },
  ]);
  for (const call of seen) assert.ok(call.done <= call.total);
});

test('a live signal is forwarded to every request the tools make', async () => {
  const controller = new AbortController();
  const stub = scriptFetch([
    page(['v1'], 0, false),
    page(['v2'], 0, false),
    ttEnvelope({ videos: [{ id: 'v3' }] }),
  ]);
  const ctx: ToolCtx = { ...toolCtx(), signal: controller.signal };

  await withFetch(stub, async () => {
    await listVideosTool.handler({}, ctx);
    await listVideosTool.handler({ fetch_all: true }, ctx);
    await queryVideosTool.handler({ video_ids: ['v3'] }, ctx);
  });

  assert.equal(stub.calls.length, 3);
  assert.equal(controller.signal.aborted, false);
});

test('cc-g4: an aborted call stops before the next page is requested', async () => {
  const stub = scriptFetch([]);
  const controller = new AbortController();
  controller.abort(new Error('client cancelled'));
  const ctx: ToolCtx = { ...toolCtx(), signal: controller.signal };

  await withFetch(stub, async () => {
    await assert.rejects(
      listVideosTool.handler({ fetch_all: true }, ctx),
      /client cancelled/,
    );
  });
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// tiktok_query_videos
// ---------------------------------------------------------------------------

test('query returns what TikTok sent and counts the request', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [{ id: 'v1' }, { id: 'v2' }] })]);
  const result = await withFetch(stub, async () =>
    queryVideosTool.handler({ video_ids: ['v1', 'v2'] }, toolCtx()),
  );

  assert.deepEqual(bodyOf(stub.calls[0]), { filters: { video_ids: ['v1', 'v2'] } });
  assert.deepEqual(queryData(result).meta, {
    requested: 2,
    returned: 2,
    missing_ids: [],
  });
  assert.equal(result.hints, undefined);
});

test('cc-c7: ids TikTok omits are listed, and the hint counts them without naming them', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [{ id: 'v2' }] })]);
  const result = await withFetch(stub, async () =>
    queryVideosTool.handler({ video_ids: ['v1', 'v2', 'v3'] }, toolCtx()),
  );

  assert.deepEqual(queryData(result).meta, {
    requested: 3,
    returned: 1,
    missing_ids: ['v1', 'v3'],
  });
  const hint = result.hints?.[0];
  assert.ok(hint !== undefined);
  assert.equal(hint.type, 'note');
  assert.ok(hint.text.includes('2 of 3 requested video ids'));
  assert.ok(!hint.text.includes('v1'));
  assert.ok(hint.text.length <= 300);
});

test('duplicate ids are collapsed before the request', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [{ id: 'v1' }] })]);
  const result = await withFetch(stub, async () =>
    queryVideosTool.handler({ video_ids: ['v1', 'v1', 'v1'] }, toolCtx()),
  );

  assert.deepEqual(bodyOf(stub.calls[0]), { filters: { video_ids: ['v1'] } });
  assert.equal(queryData(result).meta.requested, 1);
});

test('an explicit field list reaches the request', async () => {
  const stub = scriptFetch([ttEnvelope({ videos: [{ id: 'v1' }] })]);
  await withFetch(stub, async () =>
    queryVideosTool.handler(
      { video_ids: ['v1'], fields: ['title', 'view_count'] },
      toolCtx(),
    ),
  );

  assert.equal(
    new URL(stub.calls[0]?.url ?? '').searchParams.get('fields'),
    'id,title,view_count',
  );
});

test('cc-c6: the schema caps the id list at 20 and rejects empty ones', () => {
  const ids = (count: number): string[] =>
    Array.from({ length: count }, (_unused, i) => `v${String(i)}`);

  assert.equal(queryVideosTool.input.safeParse({ video_ids: ids(20) }).success, true);
  assert.equal(queryVideosTool.input.safeParse({ video_ids: ids(21) }).success, false);
  assert.equal(queryVideosTool.input.safeParse({ video_ids: [] }).success, false);
  assert.equal(queryVideosTool.input.safeParse({ video_ids: [''] }).success, false);
  assert.equal(queryVideosTool.input.safeParse({}).success, false);
});

// ---------------------------------------------------------------------------
// the declared surface
// ---------------------------------------------------------------------------

test('cc-g1: both schemas are strict and carry the shared account argument', () => {
  assert.equal(
    listVideosTool.input.safeParse({ fetch_all: true, fetchall: 1 }).success,
    false,
  );
  assert.equal(listVideosTool.input.safeParse({ account: 'WORK' }).success, true);
  assert.equal(
    queryVideosTool.input.safeParse({ video_ids: ['v1'], account: 'WORK' }).success,
    true,
  );
  assert.equal(
    queryVideosTool.input.safeParse({ video_ids: ['v1'], feilds: [] }).success,
    false,
  );
});

test('both tools are read-only members of the video package', () => {
  for (const tool of [listVideosTool, queryVideosTool]) {
    assert.equal(tool.package, 'video', tool.name);
    assert.deepEqual(tool.scopes, ['video.list'], tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});
