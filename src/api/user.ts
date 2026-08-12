/**
 * `GET /v2/user/info/` — the authenticated user's profile
 * (CONTRACTS.md § `api/user.ts`, TIKTOK-API.md § 3.1).
 *
 * `fields` is a required query parameter, and requesting a field whose scope
 * was not granted is assumed to be a hard 400 (`scope_permission_missed`;
 * upstream does not document the behaviour — probe P-4). This module therefore
 * publishes the field → scope map that lets the tool layer drop ungrantable
 * fields *before* the request, so the error path is never exercised in normal
 * operation.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only
 * (plus the shared api context).
 */

import { TikTokError } from '../core/errors.js';
import { apiRequest, malformedPayload, type ApiContext } from './context.js';

/** The upstream user object; every member is optional because `fields` selects it. */
export interface UserInfo {
  open_id?: string;
  union_id?: string;
  avatar_url?: string;
  display_name?: string;
  bio_description?: string;
  profile_deep_link?: string;
  username?: string;
  is_verified?: boolean;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
}

/**
 * Every documented user field, in the order results and requests use. Declared
 * as a literal tuple so the tool layer can hand it straight to `z.enum` — one
 * vocabulary, advertised and enforced from the same constant.
 */
export const USER_FIELDS = Object.freeze([
  'open_id',
  'union_id',
  'avatar_url',
  'display_name',
  'bio_description',
  'profile_deep_link',
  'username',
  'is_verified',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
] as const);

export type UserField = (typeof USER_FIELDS)[number];

/**
 * Upstream field → the `user.info.*` scope that unlocks it
 * (TIKTOK-API.md § "scopes"). The map is the allowlist as well: a name that is
 * not a key here is not a documented field and fails locally.
 */
export const USER_FIELD_SCOPES: Readonly<Record<UserField, string>> = Object.freeze({
  open_id: 'user.info.basic',
  union_id: 'user.info.basic',
  avatar_url: 'user.info.basic',
  display_name: 'user.info.basic',
  bio_description: 'user.info.profile',
  profile_deep_link: 'user.info.profile',
  username: 'user.info.profile',
  is_verified: 'user.info.profile',
  follower_count: 'user.info.stats',
  following_count: 'user.info.stats',
  likes_count: 'user.info.stats',
  video_count: 'user.info.stats',
});

/**
 * Fetch the authenticated user's profile.
 *
 * `fields` is passed through verbatim: the caller has already reduced it to
 * what the profile's scopes cover, and second-guessing it here would hide a
 * scope bug behind a silently different request.
 */
export async function getUserInfo(
  ctx: ApiContext,
  fields: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<UserInfo> {
  if (fields.length === 0) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message:
        'Invalid arguments: fields: at least one user field must be requested — ' +
        'TikTok requires the fields query parameter. No request was sent to TikTok.',
    });
  }
  const unknownField = fields.find((field) => !(field in USER_FIELD_SCOPES));
  if (unknownField !== undefined) {
    throw new TikTokError({
      kind: 'validation',
      code: 'invalid_params',
      message:
        `Invalid arguments: fields: '${unknownField}' is not a documented user field. ` +
        `Known fields: ${USER_FIELDS.join(', ')}. No request was sent to TikTok.`,
    });
  }

  const payload = await apiRequest<{ user?: UserInfo }>(ctx, {
    method: 'GET',
    path: '/v2/user/info/',
    fields,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  if (payload.user === undefined) {
    throw malformedPayload('/v2/user/info/', 'user object');
  }
  return payload.user;
}
