/**
 * TikTok's public oEmbed endpoint — `GET https://www.tiktok.com/oembed?url=…`
 * (TOOLS.md § 3.17, ROADMAP A11).
 *
 * The endpoint is not part of the authenticated API: it needs no token, lives
 * on its own host, and answers with a flat oEmbed object rather than the
 * `{data,error}` envelope. Three rules follow from that:
 *
 * - **Validation before network.** The caller's URL must be one of TikTok's
 *   public video URL shapes; anything else (another host, `http:`, userinfo,
 *   a port, a profile or short link) is refused locally. The URL that is sent
 *   is rebuilt from the parsed username and video id, so a query string or a
 *   fragment the caller added never reaches TikTok.
 * - **No bearer, ever.** The request uses the `oembed` egress class of
 *   `core/http`, which admits exactly `https://www.tiktok.com/oembed` and
 *   refuses a bearer outright.
 * - **The answer is untrusted and size-capped.** Only the documented members
 *   are kept, each type-checked, and an answer larger than
 *   {@link OEMBED_MAX_ANSWER_CHARS} is refused rather than truncated: half an
 *   embed snippet is not an embed snippet.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only
 * (plus the shared api context).
 */

import { TikTokError } from '../core/errors.js';
import { ttRequest } from '../core/http.js';
import { malformedPayload, type ApiContext } from './context.js';

/** The one oEmbed endpoint; `core/http` re-checks host and path. */
export const OEMBED_ENDPOINT = 'https://www.tiktok.com/oembed';

/** Longest video URL accepted as input (characters). */
export const VIDEO_URL_MAX_CHARS = 2048;

/** Largest oEmbed answer accepted, measured as its JSON text (characters). */
export const OEMBED_MAX_ANSWER_CHARS = 64 * 1024;

/** Hosts a public TikTok video URL may name. Exact matches only. */
const VIDEO_HOSTS: ReadonlySet<string> = new Set([
  'www.tiktok.com',
  'tiktok.com',
  'm.tiktok.com',
]);

/**
 * `/@{username}/video/{id}` with an optional trailing slash. Usernames are
 * letters, digits, `_` and `.`; the id is TikTok's decimal video id.
 */
const VIDEO_PATH_RE = /^\/@([A-Za-z0-9_.]{1,32})\/video\/(\d{1,20})\/?$/;

/** A validated public video URL, in its canonical form. */
export interface VideoRef {
  /** `https://www.tiktok.com/@{username}/video/{id}` — what is sent to oEmbed. */
  url: string;
  username: string;
  videoId: string;
}

/** The members of TikTok's oEmbed answer this server passes on. */
export interface EmbedAnswer {
  html: string;
  title?: string;
  author_name?: string;
  author_url?: string;
  author_unique_id?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  provider_name?: string;
  provider_url?: string;
}

function invalidUrl(reason: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'invalid_params',
    message:
      `Invalid arguments: url: ${reason}. Expected a public TikTok video URL such as ` +
      'https://www.tiktok.com/@username/video/1234567890123456789. No request was sent to TikTok.',
  });
}

/**
 * Check `input` against TikTok's public video URL shapes and return its
 * canonical form. Throws `invalid_params` for anything else.
 */
export function parseVideoUrl(input: string): VideoRef {
  if (input.length > VIDEO_URL_MAX_CHARS) {
    throw invalidUrl(`longer than ${String(VIDEO_URL_MAX_CHARS)} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw invalidUrl('not an absolute URL');
  }
  if (parsed.protocol !== 'https:') throw invalidUrl('the scheme must be https');
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidUrl('the URL must not carry credentials');
  }
  if (parsed.port !== '') throw invalidUrl('the URL must not name a port');
  if (!VIDEO_HOSTS.has(parsed.hostname)) {
    throw invalidUrl(`host ${parsed.hostname} is not a TikTok host`);
  }
  const match = VIDEO_PATH_RE.exec(parsed.pathname);
  if (match === null) throw invalidUrl('the path is not /@username/video/<id>');
  const [, username = '', videoId = ''] = match;
  return {
    url: `https://www.tiktok.com/@${username}/video/${videoId}`,
    username,
    videoId,
  };
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reduce the raw answer to {@link EmbedAnswer}: documented members only, each
 * with the type it is documented to have. A member of the wrong type is
 * dropped, not coerced; a missing or non-string `html` is a shape change.
 */
function pickAnswer(raw: unknown): EmbedAnswer {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformedPayload('/oembed', 'oEmbed object');
  }
  const record = raw as Record<string, unknown>;
  const html = optionalString(record, 'html');
  if (html === undefined || html === '') {
    throw malformedPayload('/oembed', 'html embed snippet');
  }
  const answer: EmbedAnswer = { html };
  for (const key of [
    'title',
    'author_name',
    'author_url',
    'author_unique_id',
    'thumbnail_url',
    'provider_name',
    'provider_url',
  ] as const) {
    const value = optionalString(record, key);
    if (value !== undefined) answer[key] = value;
  }
  for (const key of ['thumbnail_width', 'thumbnail_height'] as const) {
    const value = optionalNumber(record, key);
    if (value !== undefined) answer[key] = value;
  }
  return answer;
}

/**
 * Fetch the oEmbed answer for a public TikTok video. `videoUrl` is validated
 * first ({@link parseVideoUrl}); no token is resolved or sent.
 */
export async function getEmbed(
  ctx: ApiContext,
  videoUrl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ video: VideoRef; answer: EmbedAnswer }> {
  const video = parseVideoUrl(videoUrl);
  const url = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(video.url)}`;
  const raw = await ttRequest<unknown>({
    method: 'GET',
    url,
    egress: 'oembed',
    retryClass: 'read',
    clock: ctx.clock,
    logger: ctx.log,
    timeoutMs: ctx.settings.timeoutMs,
    maxAttempts: 1 + ctx.settings.maxRetries,
    maxConcurrent: ctx.settings.maxConcurrent,
    ...(ctx.lookup === undefined ? {} : { lookup: ctx.lookup }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  const size = JSON.stringify(raw).length;
  if (size > OEMBED_MAX_ANSWER_CHARS) {
    throw new TikTokError({
      kind: 'api',
      code: 'upstream_error',
      message:
        `TikTok returned an error: the oEmbed answer is ${String(size)} characters, over the ` +
        `${String(OEMBED_MAX_ANSWER_CHARS)}-character cap. It was discarded unread.`,
      retryable: false,
      remediation: 'Retry later; if it persists, the oEmbed contract has changed.',
    });
  }
  return { video, answer: pickAnswer(raw) };
}
