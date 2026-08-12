/**
 * `tiktok_get_user_info` — the whole `user` package (TOOLS.md § 3.2).
 *
 * The tool's job beyond the request itself is the scope arithmetic: TikTok's
 * `/v2/user/info/` is assumed to reject a field whose `user.info.*` scope was
 * not granted (TIKTOK-API.md, probe P-4), so requested fields the profile
 * cannot cover are dropped **before** the call and reported in
 * `meta.omitted_fields`. A partial grant is normal (CC-A7) and is not an error.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import { grantedScopes, maskOpenId } from '../api/context.js';
import {
  getUserInfo,
  USER_FIELD_SCOPES,
  type UserField,
  type UserInfo,
} from '../api/user.js';
import { defineTool, toolInput } from '../mcp/define.js';
import type { ToolResult } from '../mcp/result.js';

/**
 * The selectable fields, named as they appear in the result (TOOLS.md § 3.2) —
 * input and output speak one vocabulary, so a model can always ask for what it
 * just read. `profile_web_link` is the only name that differs from upstream's
 * (`profile_deep_link`); {@link UPSTREAM_FIELD} owns that translation.
 *
 * `open_id` and `union_id` are not selectable: the first is always fetched and
 * only ever leaves as `open_id_masked`, the second is a cross-app identifier
 * § 3.2 does not return at all.
 */
const SELECTABLE_FIELDS = Object.freeze([
  'display_name',
  'avatar_url',
  'bio_description',
  'username',
  'profile_web_link',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
] as const);

type SelectableField = (typeof SELECTABLE_FIELDS)[number];

/** Result name → the upstream field name that carries it. */
const UPSTREAM_FIELD: Readonly<Record<SelectableField, UserField>> = Object.freeze({
  display_name: 'display_name',
  avatar_url: 'avatar_url',
  bio_description: 'bio_description',
  username: 'username',
  profile_web_link: 'profile_deep_link',
  follower_count: 'follower_count',
  following_count: 'following_count',
  likes_count: 'likes_count',
  video_count: 'video_count',
});

/**
 * Always requested, whatever `fields` says: `open_id` identifies the profile the
 * answer belongs to and `display_name` is non-optional in the § 3.2 output.
 * Both are `user.info.basic`, which this tool already requires.
 */
const ALWAYS_FIELDS: readonly UserField[] = Object.freeze(['open_id', 'display_name']);

/** The § 3.2 `user` object. Every member is optional — `fields` selects it. */
export interface UserProfile {
  open_id_masked?: string;
  display_name?: string;
  avatar_url?: string;
  bio_description?: string;
  username?: string;
  profile_web_link?: string;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
}

export interface UserInfoData {
  user: UserProfile;
  meta: {
    /** Fields dropped because the profile's scopes do not cover them (§ 3.2). */
    omitted_fields: string[];
  };
}

/**
 * Rename upstream's members into result names. Only fields that were requested
 * can be present, so a member missing here means it was not asked for (or
 * TikTok had nothing for it) — never that it was silently dropped.
 */
function render(info: UserInfo): UserProfile {
  const user: UserProfile = {};
  if (info.open_id !== undefined) user.open_id_masked = maskOpenId(info.open_id);
  if (info.display_name !== undefined) user.display_name = info.display_name;
  if (info.avatar_url !== undefined) user.avatar_url = info.avatar_url;
  if (info.bio_description !== undefined) user.bio_description = info.bio_description;
  if (info.username !== undefined) user.username = info.username;
  if (info.profile_deep_link !== undefined)
    user.profile_web_link = info.profile_deep_link;
  if (info.follower_count !== undefined) user.follower_count = info.follower_count;
  if (info.following_count !== undefined) user.following_count = info.following_count;
  if (info.likes_count !== undefined) user.likes_count = info.likes_count;
  if (info.video_count !== undefined) user.video_count = info.video_count;
  return user;
}

const DESCRIPTION =
  "Fetch the authenticated TikTok user's profile: display name, avatar, bio, and counts " +
  '(followers, following, likes, videos). With the user.info.profile scope it also returns ' +
  'the @username and profile link. Read-only. Requested fields not covered by the granted ' +
  'scopes are omitted and listed in meta.omitted_fields — that is not an error. Avatar URLs ' +
  'are TikTok CDN links that expire after roughly 6 hours; do not store them long-term.';

const INPUT = toolInput({
  fields: z
    .array(z.enum(SELECTABLE_FIELDS))
    .optional()
    .describe(
      'Profile fields to return. Omit for all fields your scopes allow. ' +
        'Unknown field names fail locally.',
    ),
});

type UserInfoInput = z.infer<typeof INPUT>;

export const getUserInfoTool = defineTool<UserInfoInput, UserInfoData>({
  name: 'tiktok_get_user_info',
  title: 'TikTok user info',
  description: DESCRIPTION,
  package: 'user',
  // Only the basic scope is required; profile/stats fields degrade to omissions.
  scopes: ['user.info.basic'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: INPUT,
  handler: async (args, ctx): Promise<ToolResult<UserInfoData>> => {
    const requested = args.fields ?? SELECTABLE_FIELDS;
    // Re-read on every call (TOOLS.md § 6.2): a login in another terminal can
    // widen the grant between two calls of the same session.
    const granted = await grantedScopes(ctx.api);

    const omitted: string[] = [];
    const fields = [...ALWAYS_FIELDS];
    for (const name of requested) {
      const upstream = UPSTREAM_FIELD[name];
      if (!granted.includes(USER_FIELD_SCOPES[upstream])) {
        omitted.push(name);
        continue;
      }
      if (!fields.includes(upstream)) fields.push(upstream);
    }

    const info = await getUserInfo(
      ctx.api,
      fields,
      ctx.signal === undefined ? {} : { signal: ctx.signal },
    );

    return { ok: true, data: { user: render(info), meta: { omitted_fields: omitted } } };
  },
});
