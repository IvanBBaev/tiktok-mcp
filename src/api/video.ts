/**
 * `POST /v2/video/list/` and `POST /v2/video/query/` — the read side of the
 * Display API (CONTRACTS.md § `api/video.ts`, TIKTOK-API.md § 3.2–3.3).
 *
 * Both endpoints share one scope (`video.list`), one field vocabulary and one
 * envelope; they differ only in how the page is selected — by cursor or by id.
 * The corner cases this module owns are the ones that cost a caller money if
 * they are guessed: the cursor is opaque (CC-C1), `max_count` is clamped rather
 * than round-tripped (CC-C5), more than 20 ids is a local rejection (CC-C6) and
 * ids TikTok silently omits come back as `missingIds` (CC-C7).
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only
 * (plus the shared api context).
 */

import { TikTokError } from '../core/errors.js';
import { apiRequest, malformedPayload, type ApiContext } from './context.js';

/** A video as the Display API returns it; `fields` selects which members exist. */
export interface Video {
  id: string;
  create_time?: number;
  title?: string;
  video_description?: string;
  duration?: number;
  height?: number;
  width?: number;
  cover_image_url?: string;
  share_url?: string;
  embed_html?: string;
  embed_link?: string;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  view_count?: number;
}

/**
 * Every documented video field (TIKTOK-API.md § 3.2). A literal tuple, so the
 * tool layer advertises exactly this list through `z.enum` and cannot drift.
 */
export const VIDEO_FIELDS = Object.freeze([
  'id',
  'create_time',
  'title',
  'video_description',
  'duration',
  'height',
  'width',
  'cover_image_url',
  'share_url',
  'embed_html',
  'embed_link',
  'like_count',
  'comment_count',
  'share_count',
  'view_count',
] as const);

export type VideoField = (typeof VIDEO_FIELDS)[number];

/**
 * The default set (TOOLS.md § 3.3): identity, the human-readable bits, the
 * stable link and the counts. `cover_image_url`, `embed_html` and `embed_link`
 * are excluded on purpose — they are long, they expire in ~6 h, and paying for
 * them in the character budget on every list call is a bad trade.
 */
export const DEFAULT_VIDEO_FIELDS: readonly VideoField[] = Object.freeze([
  'id',
  'title',
  'create_time',
  'duration',
  'share_url',
  'like_count',
  'comment_count',
  'share_count',
  'view_count',
]);

/** TIKTOK-API.md § 3.2 — the page size TikTok accepts. */
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 20;

/** TIKTOK-API.md § 3.3 — the id cap `video/query` enforces (CC-C6). */
export const MAX_QUERY_IDS = 20;

/** The upstream page shape shared by both endpoints. */
interface VideoPage {
  videos?: unknown;
  cursor?: unknown;
  has_more?: unknown;
}

function invalid(detail: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'invalid_params',
    message: `Invalid arguments: ${detail}. Fix the arguments and call again. No request was sent to TikTok.`,
  });
}

/** The vocabulary as a lookup set — the tuple above is for `z.enum`, this is for checks. */
const KNOWN_VIDEO_FIELDS: ReadonlySet<string> = new Set<string>(VIDEO_FIELDS);

/** Reject a field name that is not in the documented vocabulary, before any request. */
function assertKnownFields(fields: readonly string[]): void {
  if (fields.length === 0) {
    throw invalid(
      'fields: at least one video field must be requested — TikTok requires the fields query parameter',
    );
  }
  const unknownField = fields.find((field) => !KNOWN_VIDEO_FIELDS.has(field));
  if (unknownField !== undefined) {
    throw invalid(
      `fields: '${unknownField}' is not a documented video field. Known fields: ${VIDEO_FIELDS.join(', ')}`,
    );
  }
}

/** `id` is what `missingIds` and every follow-up call are keyed on, so it is never optional. */
function withId(fields: readonly string[]): readonly string[] {
  return fields.includes('id') ? fields : ['id', ...fields];
}

/**
 * CC-C1: the cursor is opaque — nothing here reads it as a timestamp.
 *
 * TikTok sends it as a JSON number (int64 milliseconds) and expects the same
 * JSON type back, so a value that survives a lossless number round trip is sent
 * as a number and anything else is echoed verbatim as a string. Both directions
 * preserve exactly what upstream produced.
 */
function cursorForRequest(cursor: string): string | number {
  const asNumber = Number(cursor);
  const lossless =
    /^\d+$/.test(cursor) && Number.isSafeInteger(asNumber) && String(asNumber) === cursor;
  return lossless ? asNumber : cursor;
}

/**
 * CC-C1, the response direction: TikTok sends the cursor as a JSON number, but
 * the value is opaque, so it is carried as a string and nothing here parses it.
 * A cursor of any other type (absent, null, an object after a shape change) is
 * reported as the empty string — "there is no page token", which is distinct
 * from the string `"0"` a caller may legitimately be handed back.
 */
function readCursor(cursor: unknown): string {
  if (typeof cursor === 'string') return cursor;
  if (typeof cursor === 'number') return String(cursor);
  return '';
}

/** The upstream `videos` member, validated as an array of objects carrying an id. */
function readVideos(page: VideoPage, endpoint: string): Video[] {
  const { videos } = page;
  if (videos === undefined) return [];
  if (!Array.isArray(videos)) throw malformedPayload(endpoint, 'videos array');
  return videos as Video[];
}

export interface ListVideosOptions {
  /** Opaque page token from the previous page; absent means "from the start" (CC-C1). */
  cursor?: string;
  /** Page size; clamped to 1–20 by the caller (CC-C5) and re-clamped here. */
  maxCount?: number;
  /** Video fields to request; {@link DEFAULT_VIDEO_FIELDS} when absent. */
  fields?: readonly string[];
  signal?: AbortSignal;
}

/**
 * One page of the authenticated user's public videos, newest first.
 *
 * `hasMore: true` with an empty `videos` array is legal and is not an error
 * (CC-C2) — the caller decides whether to follow the cursor.
 */
export async function listVideos(
  ctx: ApiContext,
  opts: ListVideosOptions,
): Promise<{ videos: Video[]; cursor: string; hasMore: boolean }> {
  // Validated as the caller wrote it, so `fields: []` is a rejection rather than
  // a silent "just the id" request; `withId` then adds what the result is keyed on.
  const requested = opts.fields ?? DEFAULT_VIDEO_FIELDS;
  assertKnownFields(requested);
  const fields = withId(requested);

  const maxCount = Math.min(
    MAX_PAGE_SIZE,
    Math.max(MIN_PAGE_SIZE, Math.trunc(opts.maxCount ?? MAX_PAGE_SIZE)),
  );

  const page = await apiRequest<VideoPage>(ctx, {
    method: 'POST',
    path: '/v2/video/list/',
    fields,
    body: {
      max_count: maxCount,
      // Present only when the caller has one: absent means "from the start",
      // and an explicit `0` or `""` is a different request (CC-C1).
      ...(opts.cursor === undefined ? {} : { cursor: cursorForRequest(opts.cursor) }),
    },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  return {
    videos: readVideos(page, '/v2/video/list/'),
    cursor: readCursor(page.cursor),
    hasMore: page.has_more === true,
  };
}

export interface QueryVideosOptions {
  /** Video fields to request; {@link DEFAULT_VIDEO_FIELDS} when absent. */
  fields?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Full details for up to 20 specific videos.
 *
 * CC-C6: more than 20 ids is rejected locally instead of being split silently —
 * a caller that asked for 50 videos must learn that it got a page, not a set.
 * CC-C7: ids TikTok omits (deleted, private, or another user's) come back in
 * `missingIds` so the caller stops re-requesting them.
 */
export async function queryVideos(
  ctx: ApiContext,
  ids: string[],
  opts: QueryVideosOptions = {},
): Promise<{ videos: Video[]; missingIds: string[] }> {
  if (ids.length === 0) throw invalid('video_ids: at least one video id is required');
  if (ids.length > MAX_QUERY_IDS) {
    throw invalid(
      `video_ids: ${String(ids.length)} ids were requested but TikTok accepts at most ` +
        `${String(MAX_QUERY_IDS)} per call — split the ids into batches of ${String(MAX_QUERY_IDS)} and call again`,
    );
  }
  const blank = ids.find((id) => id.trim() === '');
  if (blank !== undefined) throw invalid('video_ids: an id must not be empty');

  const requested = opts.fields ?? DEFAULT_VIDEO_FIELDS;
  assertKnownFields(requested);
  const fields = withId(requested);

  const page = await apiRequest<VideoPage>(ctx, {
    method: 'POST',
    path: '/v2/video/query/',
    fields,
    body: { filters: { video_ids: ids } },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const videos = readVideos(page, '/v2/video/query/');
  const returned = new Set(videos.map((video) => video.id));
  return { videos, missingIds: ids.filter((id) => !returned.has(id)) };
}
