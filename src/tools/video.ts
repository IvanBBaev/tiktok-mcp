/**
 * `tiktok_list_videos` and `tiktok_query_videos` — the `video` package
 * (TOOLS.md §§ 3.3, 3.4).
 *
 * Everything interesting here is pagination policy, and all of it is corner
 * cases: the cursor is opaque (CC-C1), an empty page with `has_more: true` is
 * legal (CC-C2), a cursor that does not advance stops the walk instead of
 * looping forever (CC-C3), the `fetch_all` cap is only "truncation" when it
 * actually cuts the stream (CC-C4), `max_count` is clamped locally rather than
 * round-tripped as an upstream validation error (CC-C5), more than 20 ids is a
 * local rejection (CC-C6), and ids TikTok silently omits are reported back as
 * `missing_ids` (CC-C7).
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import {
  DEFAULT_VIDEO_FIELDS,
  listVideos,
  MAX_PAGE_SIZE,
  MAX_QUERY_IDS,
  MIN_PAGE_SIZE,
  queryVideos,
  VIDEO_FIELDS,
  type Video,
  type VideoField,
} from '../api/video.js';
import { defineTool, toolInput, type ToolCtx } from '../mcp/define.js';
import type { Hint, ToolResult, TruncationInfo } from '../mcp/result.js';

export interface ListVideosData {
  videos: Video[];
  meta: {
    has_more: boolean;
    /** Opaque token for the next page; only when there is one (CC-C1). */
    next_cursor?: string;
    /** The page size actually used — present only when `max_count` was clamped (CC-C5). */
    max_count?: number;
    truncation?: TruncationInfo;
  };
}

export interface QueryVideosData {
  videos: Video[];
  meta: {
    requested: number;
    returned: number;
    /** Ids TikTok did not return: deleted, private, or another user's (CC-C7). */
    missing_ids: string[];
  };
}

const FIELDS_DESCRIPTION =
  'Video fields to return. Omit for the default set ' +
  '(id, title, create_time, duration, stats, share_url).';

const fieldsArg = z.array(z.enum(VIDEO_FIELDS)).optional().describe(FIELDS_DESCRIPTION);

/**
 * CC-C5: `max_count` outside 1–20 is clamped here, not sent to TikTok. The
 * schema deliberately carries no `.min()/.max()` — a validation error would
 * cost the model a whole turn for a number it can only have meant as "as many
 * as possible".
 */
function clampPageSize(requested: number | undefined): {
  size: number;
  clamped: boolean;
} {
  if (requested === undefined) return { size: MAX_PAGE_SIZE, clamped: false };
  const size = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.trunc(requested)));
  return { size, clamped: size !== requested };
}

function clampNote(requested: number, size: number): Hint {
  return {
    type: 'note',
    text:
      `max_count ${requested} is outside TikTok's ${MIN_PAGE_SIZE}–${MAX_PAGE_SIZE} range, ` +
      `so this call used ${size}. Pass a value in range to keep the page size predictable.`,
  };
}

/** CC-C4: the cap cut the stream — say so, and say how to continue. */
function capNote(cap: number, returned: number, resumable: boolean): Hint {
  const how = resumable
    ? 'Call tiktok_list_videos again with cursor set to meta.truncation.resume_cursor to continue.'
    : 'Call tiktok_list_videos with an explicit cursor to continue.';
  return {
    type: 'note',
    text: `Stopped at the server cap of ${cap} videos after ${returned}; more pages remain. ${how}`,
  };
}

/** CC-C3: a cursor that does not advance ends the walk — never an endless loop. */
function loopNote(returned: number): Hint {
  return {
    type: 'note',
    text:
      `TikTok returned the same pagination cursor twice, so paging stopped after ${returned} ` +
      'videos instead of looping. The list may be incomplete; try again later.',
  };
}

/** CC-C7: counts only — video ids are upstream data and never enter hint text (§ 5.2 rule 3). */
function missingNote(missing: number, requested: number): Hint {
  return {
    type: 'note',
    text:
      `${missing} of ${requested} requested video ids were not returned by TikTok: they are ` +
      'deleted, private, or not owned by this account. They are listed in meta.missing_ids — do not request them again.',
  };
}

interface Walk {
  videos: Video[];
  hasMore: boolean;
  /** Cursor to continue from, when one is usable. */
  next: string | undefined;
  truncated: boolean;
  loop: boolean;
}

/**
 * Follow the cursor until TikTok runs out of pages or the server cap is hit.
 *
 * Three exits, three meanings: `has_more: false` is a complete answer (CC-C4 —
 * a cap hit exactly at a page boundary is NOT truncation), the cap is a cut
 * that must carry a resume cursor, and a non-advancing cursor is an upstream
 * fault that ends the walk (CC-C3).
 */
async function walkPages(
  ctx: ToolCtx,
  fields: readonly VideoField[],
  pageSize: number,
  start: string | undefined,
): Promise<Walk> {
  const cap = ctx.api.settings.fetchAllCap;
  const videos: Video[] = [];
  let cursor = start;
  let hasMore = true;
  let next: string | undefined;
  let loop = false;

  while (videos.length < cap && hasMore) {
    // CC-G4: cancellation is checked between pages as well as inside the
    // request, so a long walk stops at the next boundary rather than at the end.
    if (ctx.signal?.aborted === true) throw ctx.signal.reason;

    const room = cap - videos.length;
    const page = await listVideos(ctx.api, {
      maxCount: Math.min(pageSize, room),
      fields,
      ...(cursor === undefined ? {} : { cursor }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    // An over-long page is cut to the cap. The resume cursor then has to be the
    // one that was *sent*: re-reading a page costs duplicates, skipping one
    // costs videos.
    const accepted = page.videos.slice(0, room);
    const overshot = accepted.length < page.videos.length;
    videos.push(...accepted);
    hasMore = page.hasMore;
    ctx.progress?.(videos.length, cap);

    if (overshot) {
      next = cursor;
      hasMore = true;
      break;
    }
    if (cursor !== undefined && page.cursor === cursor) {
      // The cursor is dead: handing it back as a resume token would only buy the
      // caller the same page again, so the walk ends without one.
      loop = true;
      next = undefined;
      break;
    }
    // CC-C2: an empty page with `has_more: true` is legal — keep going as long
    // as the cursor advances.
    cursor = page.cursor;
    next = page.cursor === '' ? undefined : page.cursor;
  }

  return { videos, hasMore, next, truncated: hasMore, loop };
}

const LIST_DESCRIPTION =
  "List the authenticated user's PUBLIC videos, newest first, up to 20 per page. Pass cursor " +
  'from the previous result to get the next page, or set fetch_all: true to auto-paginate up ' +
  "to the server cap. Read-only. TikTok's Display API never returns private or friends-only " +
  'videos — an incomplete-looking list is usually privacy, not an error. share_url is the ' +
  'stable link to give the user; media/cover URLs expire in about 6 hours.';

const LIST_INPUT = toolInput({
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque pagination token from the previous result's meta.next_cursor. Pass it back " +
        'unchanged. Do not construct this value yourself.',
    ),
  max_count: z.number().int().optional().describe('Videos per page (1–20).'),
  fetch_all: z
    .boolean()
    .optional()
    .describe(
      'true = follow pagination automatically until done or the server cap (default 200 ' +
        'items) is hit; the result then reports truncation with a resume cursor.',
    ),
  fields: fieldsArg,
});

type ListVideosInput = z.infer<typeof LIST_INPUT>;

export const listVideosTool = defineTool<ListVideosInput, ListVideosData>({
  name: 'tiktok_list_videos',
  title: 'List TikTok videos',
  description: LIST_DESCRIPTION,
  package: 'video',
  scopes: ['video.list'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: LIST_INPUT,
  handler: async (args, ctx): Promise<ToolResult<ListVideosData>> => {
    const { size, clamped } = clampPageSize(args.max_count);
    const fields = args.fields ?? DEFAULT_VIDEO_FIELDS;
    const hints: Hint[] = [];
    if (clamped && args.max_count !== undefined)
      hints.push(clampNote(args.max_count, size));

    const meta: ListVideosData['meta'] = { has_more: false };
    if (clamped) meta.max_count = size;

    if (args.fetch_all !== true) {
      const page = await listVideos(ctx.api, {
        maxCount: size,
        fields,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      meta.has_more = page.hasMore;
      if (page.hasMore && page.cursor !== '') meta.next_cursor = page.cursor;
      const result: ToolResult<ListVideosData> = {
        ok: true,
        data: { videos: page.videos, meta },
      };
      if (hints.length > 0) result.hints = hints;
      return result;
    }

    const walk = await walkPages(ctx, fields, size, args.cursor);
    meta.has_more = walk.hasMore;
    if (walk.hasMore && walk.next !== undefined) meta.next_cursor = walk.next;
    if (walk.truncated) {
      const truncation: TruncationInfo = {
        truncated: true,
        // Two different stories, and the caller acts differently on each: the
        // cap is resumable (`resume_cursor` follows), a dead cursor is not.
        reason: walk.loop ? 'cursor_stuck' : 'item_cap',
        returned: walk.videos.length,
      };
      if (walk.next !== undefined) truncation.resume_cursor = walk.next;
      meta.truncation = truncation;
      hints.push(
        walk.loop
          ? loopNote(walk.videos.length)
          : capNote(
              ctx.api.settings.fetchAllCap,
              walk.videos.length,
              walk.next !== undefined,
            ),
      );
    }

    const result: ToolResult<ListVideosData> = {
      ok: true,
      data: { videos: walk.videos, meta },
    };
    if (hints.length > 0) result.hints = hints;
    return result;
  },
});

const QUERY_DESCRIPTION =
  'Fetch full details for up to 20 specific videos by id. Ids come from tiktok_list_videos or ' +
  'from the user. Read-only. Ids that do not belong to the authenticated user are silently ' +
  'absent from the response — TikTok does not report them as errors — so compare the returned ' +
  'ids against the requested ones.';

const QUERY_INPUT = toolInput({
  video_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_QUERY_IDS)
    .describe(
      `TikTok video ids to fetch (max ${MAX_QUERY_IDS} per call). More than ${MAX_QUERY_IDS} ` +
        'fails locally — split into batches.',
    ),
  fields: fieldsArg,
});

type QueryVideosInput = z.infer<typeof QUERY_INPUT>;

export const queryVideosTool = defineTool<QueryVideosInput, QueryVideosData>({
  name: 'tiktok_query_videos',
  title: 'Query TikTok videos by id',
  description: QUERY_DESCRIPTION,
  package: 'video',
  scopes: ['video.list'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: QUERY_INPUT,
  handler: async (args, ctx): Promise<ToolResult<QueryVideosData>> => {
    // Duplicates are collapsed before the call: asking TikTok for the same id
    // twice cannot return two videos, and `missing_ids` is a set as well.
    const ids = [...new Set(args.video_ids)];
    const { videos, missingIds } = await queryVideos(ctx.api, ids, {
      fields: args.fields ?? DEFAULT_VIDEO_FIELDS,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });

    const result: ToolResult<QueryVideosData> = {
      ok: true,
      data: {
        videos,
        meta: { requested: ids.length, returned: videos.length, missing_ids: missingIds },
      },
    };
    if (missingIds.length > 0)
      result.hints = [missingNote(missingIds.length, ids.length)];
    return result;
  },
});
