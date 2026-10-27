/**
 * `tiktok_get_video_analytics` — the `analytics` package (TOOLS.md § 3.16).
 *
 * The Display API reports raw counters per video and nothing else: no rates,
 * no aggregates, no history. This tool walks the public video list once and
 * computes what a creator actually asks about — totals, engagement rate, the
 * best posts, per-period aggregates and when posting pays off. It adds no
 * scope and no upstream endpoint: everything is derived from `video/list`.
 *
 * Two policies shape the walk. The list is newest first, so a `since` bound
 * ends it at the first page that reaches past the bound instead of reading the
 * whole history. And the walk shares `fetch_all`'s cap (`TT_FETCH_ALL_CAP`):
 * when the cap cuts the window, the result says so — an aggregate over a silent
 * subset reads exactly like an aggregate over everything.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import { listVideos, MAX_PAGE_SIZE, type Video, type VideoField } from '../api/video.js';
import { TikTokError } from '../core/errors.js';
import { defineTool, toolInput, type ToolCtx } from '../mcp/define.js';
import type { Hint, ToolResult, TruncationInfo } from '../mcp/result.js';

export const PERIODS = ['day', 'week', 'month'] as const;
export type Period = (typeof PERIODS)[number];

export const RANK_BY = [
  'views',
  'likes',
  'comments',
  'shares',
  'engagement_rate',
] as const;
export type RankBy = (typeof RANK_BY)[number];

export const DEFAULT_TOP = 5;
export const MAX_TOP = 20;

/** Monday first, as ISO 8601 numbers its weekdays. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Exactly the members the computation reads — nothing that expires, nothing long. */
const ANALYTICS_FIELDS: readonly VideoField[] = Object.freeze([
  'id',
  'title',
  'create_time',
  'share_url',
  'like_count',
  'comment_count',
  'share_count',
  'view_count',
]);

/** Counters summed over a set of videos, with the rate derived from them. */
export interface Totals {
  video_count: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** (likes + comments + shares) / views; `null` when there are no views. */
  engagement_rate: number | null;
}

export interface RankedVideo {
  id: string;
  title?: string;
  share_url?: string;
  /** ISO-8601 UTC. */
  created_at?: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagement_rate: number | null;
}

export interface PeriodRow extends Totals {
  /** `2026-10-24`, `2026-W43` or `2026-10`, in the requested time zone. */
  period: string;
}

export interface SlotRow {
  video_count: number;
  avg_views: number;
  engagement_rate: number | null;
}

export interface VideoAnalyticsData {
  summary: Totals & {
    avg_views: number;
    median_views: number;
    /** ISO-8601 UTC of the oldest and newest analysed video. */
    first_post?: string;
    last_post?: string;
  };
  top_videos: RankedVideo[];
  periods: PeriodRow[];
  posting_times: {
    by_weekday: (SlotRow & { weekday: Weekday })[];
    by_hour: (SlotRow & { hour: number })[];
  };
  meta: {
    timezone: string;
    period: Period;
    rank_by: RankBy;
    /** ISO-8601 UTC bounds actually applied. */
    since?: string;
    until?: string;
    /** Public videos read from TikTok before the window was applied. */
    scanned: number;
    /** The `top` actually used — present only when the requested one was clamped. */
    top?: number;
    truncation?: TruncationInfo;
  };
}

function invalid(detail: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'invalid_params',
    message: `Invalid arguments: ${detail}. Fix the arguments and call again. No request was sent to TikTok.`,
  });
}

/**
 * An instant from an ISO-8601 date or date-time. A bare date is a whole UTC
 * day: its first second as a lower bound, its last second as an upper one —
 * `until: 2026-10-31` that dropped everything posted on the 31st would be a
 * window nobody meant.
 */
export function parseInstant(name: string, value: string, endOfDay = false): number {
  const ms = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(ms)) {
    throw invalid(`${name} must be an ISO-8601 date or date-time such as 2026-10-01`);
  }
  const seconds = Math.floor(ms / 1000);
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? seconds + 86_399 : seconds;
}

/** The formatter doubles as the time-zone validator: an unknown zone throws. */
export function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
  } catch {
    throw invalid('timezone must be an IANA time zone name such as Europe/Sofia or UTC');
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

export function localParts(format: Intl.DateTimeFormat, epochS: number): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(epochS * 1000))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** 0 = Monday … 6 = Sunday, for a calendar date. */
export function weekdayIndex(year: number, month: number, day: number): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** ISO 8601 week label (`2026-W01`); the week-year can differ from the date's year. */
export function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  // The Thursday of this week decides which year the week belongs to.
  date.setUTCDate(date.getUTCDate() + 3 - weekdayIndex(year, month, day));
  const weekYear = date.getUTCFullYear();
  const firstThursday = Date.UTC(weekYear, 0, 4);
  const week = 1 + Math.round((date.getTime() - firstThursday) / 86_400_000 / 7);
  return `${weekYear}-W${pad(week)}`;
}

export function periodLabel(parts: LocalParts, period: Period): string {
  if (period === 'month') return `${parts.year}-${pad(parts.month)}`;
  if (period === 'week') return isoWeek(parts.year, parts.month, parts.day);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Four decimals: enough to rank on, short enough for the character budget. */
export function rate(engagements: number, views: number): number | null {
  if (views <= 0) return null;
  return Math.round((engagements / views) * 10_000) / 10_000;
}

const count = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export function totalsOf(videos: readonly Video[]): Totals {
  let views = 0;
  let likes = 0;
  let comments = 0;
  let shares = 0;
  for (const video of videos) {
    views += count(video.view_count);
    likes += count(video.like_count);
    comments += count(video.comment_count);
    shares += count(video.share_count);
  }
  return {
    video_count: videos.length,
    views,
    likes,
    comments,
    shares,
    engagement_rate: rate(likes + comments + shares, views),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // One middle element for an odd count, the two middle ones for an even count.
  const middle = sorted.slice((sorted.length - 1) >> 1, (sorted.length >> 1) + 1);
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
}

const isoOf = (epochS: number | undefined): string | undefined =>
  epochS === undefined ? undefined : new Date(epochS * 1000).toISOString();

export function ranked(video: Video): RankedVideo {
  const views = count(video.view_count);
  const likes = count(video.like_count);
  const comments = count(video.comment_count);
  const shares = count(video.share_count);
  const createdAt = isoOf(video.create_time);
  return {
    id: video.id,
    ...(video.title === undefined ? {} : { title: video.title }),
    ...(video.share_url === undefined ? {} : { share_url: video.share_url }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    views,
    likes,
    comments,
    shares,
    engagement_rate: rate(likes + comments + shares, views),
  };
}

/** Descending by the metric; a `null` rate sorts last; ties keep newest first. */
export function rankKey(video: RankedVideo, by: RankBy): number {
  if (by === 'engagement_rate') return video.engagement_rate ?? -1;
  return video[by];
}

function slot(videos: readonly Video[]): SlotRow {
  const totals = totalsOf(videos);
  return {
    video_count: totals.video_count,
    avg_views: videos.length === 0 ? 0 : Math.round(totals.views / videos.length),
    engagement_rate: totals.engagement_rate,
  };
}

export interface AnalyticsOptions {
  timezone: string;
  period: Period;
  rankBy: RankBy;
  top: number;
}

/** The pure part: everything after the walk, testable without a network. */
export function computeAnalytics(
  videos: readonly Video[],
  options: AnalyticsOptions,
  format: Intl.DateTimeFormat = zoneFormatter(options.timezone),
): Omit<VideoAnalyticsData, 'meta'> {
  const totals = totalsOf(videos);
  const times = videos
    .map((video) => video.create_time)
    .filter((time): time is number => time !== undefined);
  const firstPost = times.length === 0 ? undefined : isoOf(Math.min(...times));
  const lastPost = times.length === 0 ? undefined : isoOf(Math.max(...times));

  const top = videos
    .map(ranked)
    .sort((a, b) => rankKey(b, options.rankBy) - rankKey(a, options.rankBy))
    .slice(0, options.top);

  const byPeriod = new Map<string, Video[]>();
  const byWeekday = WEEKDAYS.map((weekday) => ({ weekday, videos: [] as Video[] }));
  const byHour: Video[][] = Array.from({ length: 24 }, () => []);
  for (const video of videos) {
    // A video without a timestamp still counts in the totals; it just has no
    // place on a calendar.
    if (video.create_time === undefined) continue;
    const parts = localParts(format, video.create_time);
    const label = periodLabel(parts, options.period);
    const bucket = byPeriod.get(label) ?? [];
    bucket.push(video);
    byPeriod.set(label, bucket);
    byWeekday[weekdayIndex(parts.year, parts.month, parts.day)]?.videos.push(video);
    byHour[parts.hour]?.push(video);
  }

  return {
    summary: {
      ...totals,
      avg_views: videos.length === 0 ? 0 : Math.round(totals.views / videos.length),
      median_views: median(videos.map((video) => count(video.view_count))),
      ...(firstPost === undefined ? {} : { first_post: firstPost }),
      ...(lastPost === undefined ? {} : { last_post: lastPost }),
    },
    top_videos: top,
    // Labels are zero-padded, so a string sort is a chronological one.
    periods: [...byPeriod.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([period, bucket]) => ({ period, ...totalsOf(bucket) })),
    posting_times: {
      by_weekday: byWeekday
        .map(({ weekday, videos: bucket }) => ({ weekday, ...slot(bucket) }))
        .filter((row) => row.video_count > 0),
      by_hour: byHour
        .map((bucket, hour) => ({ hour, ...slot(bucket) }))
        .filter((row) => row.video_count > 0),
    },
  };
}

interface Scan {
  videos: Video[];
  scanned: number;
  /** The cap ended the walk while older videos inside the window remained. */
  capped: boolean;
  /** TikTok handed back the cursor it was sent — the walk stopped short. */
  stuck: boolean;
}

/**
 * Read the list newest first until it ends, the window's lower bound is passed,
 * or the cap is reached. Only videos inside `[since, until]` are kept; `scanned`
 * counts everything read, so the caller can see what the window cost.
 */
async function scan(
  ctx: ToolCtx,
  since: number | undefined,
  until: number | undefined,
): Promise<Scan> {
  const cap = ctx.api.settings.fetchAllCap;
  const kept: Video[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  let hasMore = true;
  let passedSince = false;
  let stuck = false;

  while (hasMore && !passedSince && scanned < cap) {
    if (ctx.signal?.aborted === true) throw ctx.signal.reason;
    const page = await listVideos(ctx.api, {
      maxCount: Math.min(MAX_PAGE_SIZE, cap - scanned),
      fields: ANALYTICS_FIELDS,
      ...(cursor === undefined ? {} : { cursor }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    for (const video of page.videos.slice(0, cap - scanned)) {
      scanned += 1;
      const time = video.create_time;
      if (since !== undefined && time !== undefined && time < since) {
        passedSince = true;
        continue;
      }
      if (until !== undefined && time !== undefined && time > until) continue;
      kept.push(video);
    }
    ctx.progress?.(scanned, cap);
    hasMore = page.hasMore && page.cursor !== '';
    if (hasMore && cursor !== undefined && page.cursor === cursor) {
      stuck = true;
      break;
    }
    cursor = page.cursor;
  }

  return { videos: kept, scanned, capped: hasMore && !passedSince && !stuck, stuck };
}

function capNote(cap: number): Hint {
  return {
    type: 'note',
    text:
      `Analysed only the newest ${cap} public videos (the server cap); older videos in the ` +
      'window were not read. Narrow the window with since/until, or raise TT_FETCH_ALL_CAP.',
  };
}

function stuckNote(scanned: number): Hint {
  return {
    type: 'note',
    text:
      `TikTok returned the same pagination cursor twice, so reading stopped after ${scanned} ` +
      'videos. The figures cover a partial list; try again later.',
  };
}

function topClampNote(requested: number, used: number): Hint {
  return {
    type: 'note',
    text: `top ${requested} is outside the 0–${MAX_TOP} range, so this call used ${used}.`,
  };
}

const ANALYTICS_DESCRIPTION =
  "Compute engagement analytics over the authenticated user's PUBLIC videos. Returns totals, " +
  'engagement rate ((likes + comments + shares) / views), average and median views, the top ' +
  'videos by a chosen metric, per-day/week/month aggregates and posting-time breakdowns by ' +
  'weekday and hour. Read-only; derived from the video list, so private and friends-only ' +
  'videos are not counted. Counts are as of now — TikTok keeps no history, so there are no ' +
  'per-period deltas for a single video.';

const ANALYTICS_INPUT = toolInput({
  since: z
    .string()
    .optional()
    .describe(
      'Only videos posted at or after this instant (ISO-8601 date or date-time; a bare ' +
        'date is midnight UTC). Omit for no lower bound.',
    ),
  until: z
    .string()
    .optional()
    .describe(
      'Only videos posted at or before this instant (ISO-8601; a bare date includes that ' +
        'whole UTC day). Omit for no upper bound.',
    ),
  period: z
    .enum(PERIODS)
    .optional()
    .describe('Bucket size for the periods aggregates. Default month.'),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA time zone for periods and posting times, e.g. Europe/Sofia. Default UTC. ' +
        'Timestamps in the result stay UTC.',
    ),
  rank_by: z
    .enum(RANK_BY)
    .optional()
    .describe('Metric that orders top_videos. Default views.'),
  top: z
    .number()
    .int()
    .optional()
    .describe(`How many top videos to return (0–${MAX_TOP}).`),
});

type VideoAnalyticsInput = z.infer<typeof ANALYTICS_INPUT>;

export const getVideoAnalyticsTool = defineTool<VideoAnalyticsInput, VideoAnalyticsData>({
  name: 'tiktok_get_video_analytics',
  title: 'Compute TikTok video analytics',
  description: ANALYTICS_DESCRIPTION,
  package: 'analytics',
  scopes: ['video.list'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: ANALYTICS_INPUT,
  handler: async (args, ctx): Promise<ToolResult<VideoAnalyticsData>> => {
    // Everything is validated before the first request (TOOLS.md § 2.3).
    const timezone = args.timezone ?? 'UTC';
    const format = zoneFormatter(timezone);
    const since =
      args.since === undefined ? undefined : parseInstant('since', args.since);
    const until =
      args.until === undefined ? undefined : parseInstant('until', args.until, true);
    if (since !== undefined && until !== undefined && since > until) {
      throw invalid('since must not be later than until');
    }
    const requestedTop = args.top ?? DEFAULT_TOP;
    const top = Math.min(MAX_TOP, Math.max(0, requestedTop));
    const period = args.period ?? 'month';
    const rankBy = args.rank_by ?? 'views';

    const walk = await scan(ctx, since, until);
    const computed = computeAnalytics(
      walk.videos,
      { timezone, period, rankBy, top },
      format,
    );

    const hints: Hint[] = [];
    const meta: VideoAnalyticsData['meta'] = {
      timezone,
      period,
      rank_by: rankBy,
      scanned: walk.scanned,
    };
    if (since !== undefined) meta.since = new Date(since * 1000).toISOString();
    if (until !== undefined) meta.until = new Date(until * 1000).toISOString();
    if (top !== requestedTop) {
      meta.top = top;
      hints.push(topClampNote(requestedTop, top));
    }
    if (walk.capped || walk.stuck) {
      meta.truncation = {
        truncated: true,
        reason: walk.stuck ? 'cursor_stuck' : 'item_cap',
        returned: walk.videos.length,
      };
      hints.push(
        walk.stuck ? stuckNote(walk.scanned) : capNote(ctx.api.settings.fetchAllCap),
      );
    }

    const result: ToolResult<VideoAnalyticsData> = {
      ok: true,
      data: { ...computed, meta },
    };
    if (hints.length > 0) result.hints = hints;
    return result;
  },
});
