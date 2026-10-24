/**
 * `tiktok_get_video_analytics` (TOOLS.md § 3.13).
 *
 * The tool is a walk plus a pure computation, and the tests follow that split.
 * The walk cases pin the policies that keep an aggregate honest: a `since`
 * bound ends the walk early, the cap and a stuck cursor are reported instead of
 * silently shrinking the sample, and every argument is validated before the
 * first request. The computation cases pin the arithmetic — rates, medians,
 * ISO weeks across a year boundary, time-zone bucketing — on fixed inputs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import type { Video } from '../src/api/video.js';
import { TikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  computeAnalytics,
  getVideoAnalyticsTool,
  isoWeek,
  localParts,
  median,
  parseInstant,
  rate,
  type VideoAnalyticsData,
} from '../src/tools/analytics.js';
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

/** Epoch seconds of an ISO-8601 instant. */
const at = (iso: string): number => Date.parse(iso) / 1000;

function video(
  id: string,
  iso: string | undefined,
  views: number,
  likes = 0,
  comments = 0,
  shares = 0,
): Video {
  return {
    id,
    title: `title ${id}`,
    share_url: `https://www.tiktok.com/@creator/video/${id}`,
    ...(iso === undefined ? {} : { create_time: at(iso) }),
    view_count: views,
    like_count: likes,
    comment_count: comments,
    share_count: shares,
  };
}

function page(videos: readonly Video[], cursor: number, hasMore: boolean): Response {
  return ttEnvelope({ videos, cursor, has_more: hasMore });
}

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  assert.ok(call !== undefined, 'expected a recorded request');
  return call.json() as Record<string, unknown>;
}

function dataOf(result: ToolResult<VideoAnalyticsData>): VideoAnalyticsData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

async function run(
  args: Parameters<typeof getVideoAnalyticsTool.handler>[0],
  stub: RecordingFetchStub,
  ctx: ToolCtx = toolCtx(),
): Promise<ToolResult<VideoAnalyticsData>> {
  return withFetch(stub, async () => getVideoAnalyticsTool.handler(args, ctx));
}

const invalidParams = (pattern: RegExp) => (error: unknown) =>
  error instanceof TikTokError &&
  error.code === 'invalid_params' &&
  pattern.test(error.message) &&
  /No request was sent to TikTok/.test(error.message);

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

test('a default call computes every section over one page', async () => {
  const stub = scriptFetch([
    page(
      [
        video('v3', '2026-10-21T18:00:00Z', 1000, 80, 10, 10),
        video('v2', '2026-10-19T09:30:00Z', 300, 15, 0, 0),
        video('v1', '2026-09-30T18:45:00Z', 200, 0, 2, 2),
      ],
      0,
      false,
    ),
  ]);
  const result = await run({}, stub);
  const data = dataOf(result);

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(bodyOf(stub.calls[0]), { max_count: 20 });
  assert.equal(
    new URL(stub.calls[0]?.url ?? '').searchParams.get('fields'),
    'id,title,create_time,share_url,like_count,comment_count,share_count,view_count',
  );

  assert.deepEqual(data.summary, {
    video_count: 3,
    views: 1500,
    likes: 95,
    comments: 12,
    shares: 12,
    engagement_rate: 0.0793,
    avg_views: 500,
    median_views: 300,
    first_post: '2026-09-30T18:45:00.000Z',
    last_post: '2026-10-21T18:00:00.000Z',
  });
  assert.deepEqual(
    data.top_videos.map((row) => row.id),
    ['v3', 'v2', 'v1'],
  );
  assert.deepEqual(data.top_videos[0], {
    id: 'v3',
    title: 'title v3',
    share_url: 'https://www.tiktok.com/@creator/video/v3',
    created_at: '2026-10-21T18:00:00.000Z',
    views: 1000,
    likes: 80,
    comments: 10,
    shares: 10,
    engagement_rate: 0.1,
  });
  assert.deepEqual(data.periods, [
    {
      period: '2026-09',
      video_count: 1,
      views: 200,
      likes: 0,
      comments: 2,
      shares: 2,
      engagement_rate: 0.02,
    },
    {
      period: '2026-10',
      video_count: 2,
      views: 1300,
      likes: 95,
      comments: 10,
      shares: 10,
      engagement_rate: 0.0885,
    },
  ]);
  assert.deepEqual(data.posting_times, {
    by_weekday: [
      { weekday: 'Mon', video_count: 1, avg_views: 300, engagement_rate: 0.05 },
      { weekday: 'Wed', video_count: 2, avg_views: 600, engagement_rate: 0.0867 },
    ],
    by_hour: [
      { hour: 9, video_count: 1, avg_views: 300, engagement_rate: 0.05 },
      { hour: 18, video_count: 2, avg_views: 600, engagement_rate: 0.0867 },
    ],
  });
  assert.deepEqual(data.meta, {
    timezone: 'UTC',
    period: 'month',
    rank_by: 'views',
    scanned: 3,
  });
  assert.equal(result.hints, undefined);
});

test('since ends the walk at the first video older than the bound', async () => {
  const stub = scriptFetch([
    page(
      [
        video('new', '2026-10-20T10:00:00Z', 10),
        video('old', '2026-09-01T10:00:00Z', 99),
      ],
      7,
      true,
    ),
  ]);
  const data = dataOf(await run({ since: '2026-10-01' }, stub));

  assert.equal(stub.calls.length, 1, 'no page past the bound is requested');
  assert.deepEqual(
    data.top_videos.map((row) => row.id),
    ['new'],
  );
  assert.equal(data.meta.scanned, 2);
  assert.equal(data.meta.since, '2026-10-01T00:00:00.000Z');
  assert.equal(data.meta.truncation, undefined);
});

test('a bare-date until includes that whole UTC day', async () => {
  const stub = scriptFetch([
    page(
      [
        video('after', '2026-10-20T00:00:01Z', 5),
        video('last-second', '2026-10-19T23:59:59Z', 4),
        video('undated', undefined, 3),
      ],
      0,
      false,
    ),
  ]);
  const data = dataOf(await run({ until: '2026-10-19' }, stub));

  assert.deepEqual(
    data.top_videos.map((row) => row.id),
    ['last-second', 'undated'],
  );
  assert.equal(data.meta.until, '2026-10-19T23:59:59.000Z');
});

test('a date-time until is used exactly as given', async () => {
  const stub = scriptFetch([
    page(
      [video('a', '2026-10-19T12:00:01Z', 5), video('b', '2026-10-19T12:00:00Z', 4)],
      0,
      false,
    ),
  ]);
  const data = dataOf(await run({ until: '2026-10-19T12:00:00Z' }, stub));

  assert.deepEqual(
    data.top_videos.map((row) => row.id),
    ['b'],
  );
});

test('every argument is validated before the first request', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, async () => {
    const ctx = toolCtx();
    await assert.rejects(
      getVideoAnalyticsTool.handler({ timezone: 'Mars/Olympus' }, ctx),
      invalidParams(/timezone must be an IANA time zone/),
    );
    await assert.rejects(
      getVideoAnalyticsTool.handler({ since: 'yesterday' }, ctx),
      invalidParams(/since must be an ISO-8601 date/),
    );
    await assert.rejects(
      getVideoAnalyticsTool.handler({ until: '2026-13-45' }, ctx),
      invalidParams(/until must be an ISO-8601 date/),
    );
    await assert.rejects(
      getVideoAnalyticsTool.handler({ since: '2026-10-02', until: '2026-10-01' }, ctx),
      invalidParams(/since must not be later than until/),
    );
  });
  assert.equal(stub.calls.length, 0);
});

test('since and until on the same day form a valid one-day window', async () => {
  const stub = scriptFetch([page([video('a', '2026-10-01T12:00:00Z', 1)], 0, false)]);
  const data = dataOf(await run({ since: '2026-10-01', until: '2026-10-01' }, stub));

  assert.equal(data.summary.video_count, 1);
});

test('top is clamped into 0–20 and the clamp is reported', async () => {
  const many = Array.from({ length: 25 }, (_unused, i) =>
    video(`v${String(i)}`, '2026-10-01T00:00:00Z', i),
  );
  const high = await run({ top: 50 }, scriptFetch([page(many, 0, false)]));
  assert.equal(dataOf(high).top_videos.length, 20);
  assert.equal(dataOf(high).meta.top, 20);
  assert.match(high.hints?.[0]?.text ?? '', /top 50 is outside the 0–20 range/);

  const low = await run({ top: -3 }, scriptFetch([page(many, 0, false)]));
  assert.deepEqual(dataOf(low).top_videos, []);
  assert.equal(dataOf(low).meta.top, 0);

  const exact = await run({ top: 2 }, scriptFetch([page(many, 0, false)]));
  assert.equal(dataOf(exact).top_videos.length, 2);
  assert.equal(dataOf(exact).meta.top, undefined);
  assert.equal(exact.hints, undefined);
});

test('the cap cuts the walk and the result says so', async () => {
  const stub = scriptFetch([
    page(
      [video('a', '2026-10-05T00:00:00Z', 1), video('b', '2026-10-04T00:00:00Z', 1)],
      11,
      true,
    ),
    page(
      [video('c', '2026-10-03T00:00:00Z', 1), video('d', '2026-10-02T00:00:00Z', 1)],
      12,
      true,
    ),
  ]);
  const seen: number[][] = [];
  const ctx: ToolCtx = {
    ...toolCtx({ TT_FETCH_ALL_CAP: '3' }),
    progress: (done, total) => seen.push([done, total]),
  };
  const result = await run({}, stub, ctx);
  const data = dataOf(result);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(bodyOf(stub.calls[0]), { max_count: 3 });
  assert.deepEqual(bodyOf(stub.calls[1]), { max_count: 1, cursor: 11 });
  assert.equal(data.meta.scanned, 3);
  assert.deepEqual(data.meta.truncation, {
    truncated: true,
    reason: 'item_cap',
    returned: 3,
  });
  assert.match(result.hints?.[0]?.text ?? '', /newest 3 public videos.*TT_FETCH_ALL_CAP/);
  assert.deepEqual(seen, [
    [2, 3],
    [3, 3],
  ]);
});

test('a cap that lands exactly on the end of the list is not truncation', async () => {
  const stub = scriptFetch([page([video('a', '2026-10-05T00:00:00Z', 1)], 0, false)]);
  const result = await run({}, stub, toolCtx({ TT_FETCH_ALL_CAP: '1' }));

  assert.equal(dataOf(result).meta.truncation, undefined);
  assert.equal(result.hints, undefined);
});

test('a cap reached past the since bound is not truncation', async () => {
  const stub = scriptFetch([
    page(
      [video('a', '2026-10-05T00:00:00Z', 1), video('b', '2026-09-01T00:00:00Z', 1)],
      4,
      true,
    ),
  ]);
  const result = await run(
    { since: '2026-10-01' },
    stub,
    toolCtx({ TT_FETCH_ALL_CAP: '2' }),
  );

  assert.equal(dataOf(result).meta.truncation, undefined);
});

test('a cursor that does not advance stops the walk and is reported', async () => {
  const stub = scriptFetch([
    page([video('a', '2026-10-05T00:00:00Z', 1)], 5, true),
    page([video('b', '2026-10-04T00:00:00Z', 1)], 5, true),
  ]);
  const result = await run({}, stub);
  const data = dataOf(result);

  assert.equal(stub.calls.length, 2);
  assert.equal(data.meta.scanned, 2);
  assert.deepEqual(data.meta.truncation, {
    truncated: true,
    reason: 'cursor_stuck',
    returned: 2,
  });
  assert.match(
    result.hints?.[0]?.text ?? '',
    /same pagination cursor twice.*after 2 videos/,
  );
});

test('has_more without a usable cursor ends the walk without truncation', async () => {
  const stub = scriptFetch([
    ttEnvelope({ videos: [video('a', undefined, 1)], has_more: true }),
  ]);
  const data = dataOf(await run({}, stub));

  assert.equal(stub.calls.length, 1);
  assert.equal(data.meta.truncation, undefined);
});

test('a live signal is forwarded; an aborted one stops before any request', async () => {
  const live = new AbortController();
  const ok = scriptFetch([page([], 0, false)]);
  await run({}, ok, { ...toolCtx(), signal: live.signal });
  assert.equal(ok.calls.length, 1);

  const stub = scriptFetch([]);
  const controller = new AbortController();
  controller.abort(new Error('client cancelled'));
  await assert.rejects(
    run({}, stub, { ...toolCtx(), signal: controller.signal }),
    /client cancelled/,
  );
  assert.equal(stub.calls.length, 0);
});

test('time zone, day period and engagement ranking reach the computation', async () => {
  const stub = scriptFetch([
    page(
      [
        // 22:30 UTC on Monday is 01:30 on Tuesday in Sofia (EEST, UTC+3).
        video('late', '2026-10-19T22:30:00Z', 100, 30),
        video('dark', '2026-10-18T08:00:00Z', 0, 5),
        video('busy', '2026-10-17T08:00:00Z', 1000, 10),
      ],
      0,
      false,
    ),
  ]);
  const data = dataOf(
    await run(
      { timezone: 'Europe/Sofia', period: 'day', rank_by: 'engagement_rate' },
      stub,
    ),
  );

  assert.deepEqual(
    data.top_videos.map((row) => [row.id, row.engagement_rate]),
    [
      ['late', 0.3],
      ['busy', 0.01],
      ['dark', null],
    ],
  );
  assert.deepEqual(
    data.periods.map((row) => row.period),
    ['2026-10-17', '2026-10-18', '2026-10-20'],
  );
  assert.deepEqual(
    data.posting_times.by_weekday.map((row) => row.weekday),
    ['Tue', 'Sat', 'Sun'],
  );
  assert.deepEqual(
    data.posting_times.by_hour.map((row) => row.hour),
    [1, 11],
  );
  assert.equal(data.meta.timezone, 'Europe/Sofia');
  assert.equal(data.meta.rank_by, 'engagement_rate');
});

// ---------------------------------------------------------------------------
// the computation
// ---------------------------------------------------------------------------

const UTC = { timezone: 'UTC', period: 'week', rankBy: 'likes', top: 5 } as const;

test('weekly labels follow ISO 8601 across a year boundary', () => {
  const computed = computeAnalytics(
    [
      video('a', '2025-12-29T12:00:00Z', 1),
      video('b', '2026-01-01T12:00:00Z', 1),
      video('c', '2027-01-01T12:00:00Z', 1),
      video('d', '2026-10-24T12:00:00Z', 1),
    ],
    UTC,
  );

  assert.deepEqual(
    computed.periods.map((row) => [row.period, row.video_count]),
    [
      ['2026-W01', 2],
      ['2026-W43', 1],
      ['2026-W53', 1],
    ],
  );
  assert.equal(isoWeek(2021, 1, 3), '2020-W53');
  assert.equal(isoWeek(2024, 12, 30), '2025-W01');
});

test('an empty list yields zeros and no calendar rows', () => {
  assert.deepEqual(computeAnalytics([], UTC), {
    summary: {
      video_count: 0,
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      engagement_rate: null,
      avg_views: 0,
      median_views: 0,
    },
    top_videos: [],
    periods: [],
    posting_times: { by_weekday: [], by_hour: [] },
  });
});

test('undated videos count in the totals but not on the calendar', () => {
  const computed = computeAnalytics([video('a', undefined, 10, 1)], UTC);

  assert.equal(computed.summary.video_count, 1);
  assert.equal(computed.summary.first_post, undefined);
  assert.equal(computed.top_videos[0]?.created_at, undefined);
  assert.deepEqual(computed.periods, []);
});

test('missing, negative and non-finite counters read as zero', () => {
  const odd: Video = {
    id: 'odd',
    view_count: -5,
    like_count: Number.NaN,
    comment_count: Number.POSITIVE_INFINITY,
  };
  const computed = computeAnalytics([odd], UTC);

  assert.deepEqual(computed.top_videos, [
    { id: 'odd', views: 0, likes: 0, comments: 0, shares: 0, engagement_rate: null },
  ]);
});

test('median handles odd, even and empty inputs', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('rate rounds to four decimals and is null without views', () => {
  assert.equal(rate(1, 3), 0.3333);
  assert.equal(rate(5, 0), null);
});

test('parseInstant accepts dates and date-times and shifts only bare-date upper bounds', () => {
  assert.equal(parseInstant('since', '2026-10-01'), at('2026-10-01T00:00:00Z'));
  assert.equal(parseInstant('until', '2026-10-01', true), at('2026-10-01T23:59:59Z'));
  assert.equal(
    parseInstant('until', '2026-10-01T05:00:00+02:00', true),
    at('2026-10-01T03:00:00Z'),
  );
  assert.throws(
    () => parseInstant('since', 'Oct 1 2026'),
    invalidParams(/since must be/),
  );
});

test('localParts tolerates a formatter that omits a part', () => {
  const bare = {
    formatToParts: () => [{ type: 'literal', value: '/' }],
  } as unknown as Intl.DateTimeFormat;

  assert.deepEqual(localParts(bare, 0), { year: 0, month: 0, day: 0, hour: 0 });
});
