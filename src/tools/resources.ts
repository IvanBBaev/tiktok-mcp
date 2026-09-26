/**
 * The resource manifest in code (TOOLS.md § 7.2).
 *
 * `RESOURCES` is the ONE ordered source consumed by `resources/list`,
 * `resources/templates/list` and `resources/read`. Each entry pins a read-only
 * tool from the tool manifest to a `tiktok://` URI with fixed arguments, so a
 * client that attaches a snapshot to a conversation gets exactly the envelope
 * the tool would have returned — same account resolution, same scope check,
 * same redaction and truncation (CC-G2/G7). Nothing is fetched here; the
 * server runs the bound tool through its own `callTool` pipeline.
 *
 * Order is part of the surface: it fixes the order of `resources/list` and of
 * the TOOLS.md § 7.2 table, so entries are appended, never re-sorted.
 *
 * A resource is the tool's *default* answer — one page of videos, no live
 * probe of the token, so `args` is `{}` — except where the default would
 * block: `tiktok_get_publish_status` waits up to ~60 s for a terminal status
 * unless told otherwise, and a snapshot must return at once, so that entry
 * fixes `wait_for_completion: false`. A URI carries two variables and no
 * more: `?account=<profile>`, which `defineResource` forbids as a fixed
 * argument so the `{?account}` template stays true, and a `{name}` path
 * segment — the one tool argument a read cannot default (`{publish_id}`),
 * which makes the entry a template listed by `resources/templates/list` only.
 *
 * Layering: `core ← api ← mcp ← tools`. This is the top layer; nothing imports
 * from it except the bootstrap.
 */

import { defineResource, type ResourceSpec } from '../mcp/resources.js';
import { getAuthStatusTool } from './auth.js';
import {
  getCreatorInfoTool,
  getPublishStatusTool,
  listPublishJournalTool,
} from './publish.js';
import { getUserInfoTool } from './user.js';
import { listVideosTool } from './video.js';

/**
 * `tiktok://auth/status` — the local credential picture, no network.
 *
 * Mirrors `tiktok_get_auth_status` without `probe`, so a read is instant and
 * cannot fail on a dead token: a stale credential is *reported* in the row, not
 * thrown. The one tool with no scopes, so this resource is never marked
 * unavailable.
 */
export const authStatusResource = defineResource({
  uri: 'tiktok://auth/status',
  name: 'tiktok_auth_status',
  title: 'TikTok auth status',
  description:
    'Authentication status of every configured TikTok profile — granted scopes, token ' +
    'expiry and which tool packages each profile can use — as tiktok_get_auth_status ' +
    'reports it without a live probe. Append ?account=<profile> to run the read as ' +
    'that profile instead of the default one.',
  tool: getAuthStatusTool,
  args: {},
});

/**
 * `tiktok://user/info` — the authenticated creator's profile.
 *
 * Mirrors `tiktok_get_user_info` with the default field set: every field the
 * granted scopes allow, omissions listed in `meta.omitted_fields`.
 */
export const userInfoResource = defineResource({
  uri: 'tiktok://user/info',
  name: 'tiktok_user_info',
  title: 'TikTok user info',
  description:
    "The authenticated TikTok user's profile — display name, avatar, bio, follower and " +
    'video counts, plus @username and profile link when the scopes allow — as ' +
    'tiktok_get_user_info returns it with its default fields. Append ' +
    '?account=<profile> to read the profile of another configured account.',
  tool: getUserInfoTool,
  args: {},
});

/**
 * `tiktok://videos/recent` — the first page of public videos, newest first.
 *
 * Mirrors `tiktok_list_videos` with its own default page size (20) and no
 * `fetch_all`: a snapshot is one page, and a client that wants more calls the
 * tool with the cursor the snapshot's `meta.next_cursor` carries.
 */
export const recentVideosResource = defineResource({
  uri: 'tiktok://videos/recent',
  name: 'tiktok_videos_recent',
  title: 'Recent TikTok videos',
  description:
    "The newest page of the authenticated user's public TikTok videos (up to 20, newest " +
    'first, with id, title, duration, stats and share_url) — one default page of ' +
    'tiktok_list_videos, never auto-paginated. Append ?account=<profile> to read the ' +
    'videos of another configured account.',
  tool: listVideosTool,
  args: {},
});

/**
 * `tiktok://creator/info` — the live posting state TikTok reports for the creator.
 *
 * Mirrors `tiktok_get_creator_info`, which takes no arguments beyond `account`.
 * This read costs an upstream call under TikTok's 20-requests-per-minute
 * limit for creator info, so a client should not poll it.
 */
export const creatorInfoResource = defineResource({
  uri: 'tiktok://creator/info',
  name: 'tiktok_creator_info',
  title: 'TikTok creator posting state',
  description:
    "The creator's live posting state — nickname, the privacy_level options currently " +
    'available, whether comments, duets and stitch are disabled account-wide, and the ' +
    'maximum video duration — exactly as tiktok_get_creator_info returns it. Append ' +
    '?account=<profile> to read the state of another configured account.',
  tool: getCreatorInfoTool,
  args: {},
});

/**
 * `tiktok://publish/journal` — this server's own record of publish attempts.
 *
 * Mirrors `tiktok_list_publish_journal` with its defaults: the newest 20
 * attempts across every profile. The one read that never leaves the machine —
 * the tool is a local file read with no scopes — and the one where
 * `?account=` is not a profile resolution: the tool treats `account` as a
 * filter (TOOLS.md § 2.2 / § 3.7), so the query narrows the rows instead of
 * choosing who reads.
 */
export const publishJournalResource = defineResource({
  uri: 'tiktok://publish/journal',
  name: 'tiktok_publish_journal',
  title: 'TikTok publish journal',
  description:
    "This server's local, append-only journal of publish attempts — timestamp, account, " +
    'tool, title excerpt, publish_id and outcome (ok, error, upload_failed or unknown) — ' +
    'the newest 20 across all profiles, as tiktok_list_publish_journal returns them. A ' +
    'local file read: no network, no scopes. Append ?account=<profile> to filter the ' +
    'entries to that profile; it does not change who reads.',
  tool: listPublishJournalTool,
  args: {},
});

/**
 * `tiktok://publish/{publish_id}/status` — one publish attempt, as it stands now.
 *
 * Mirrors `tiktok_get_publish_status` for the attempt the path names, with
 * `wait_for_completion: false` fixed: the tool's default is to poll for up to
 * ~60 s, and a snapshot that blocks is not a snapshot. One status request per
 * read, so a client that wants to follow processing reads the URI again
 * (TikTok limit 30 requests/min). A template — listed by
 * `resources/templates/list` only — because without a publish_id there is
 * nothing to read.
 */
export const publishStatusResource = defineResource({
  uri: 'tiktok://publish/{publish_id}/status',
  name: 'tiktok_publish_status',
  title: 'TikTok publish status',
  description:
    'The current status of one publish attempt by publish_id — status, fail_reason with ' +
    'its fail_recovery, public_post_id once live, uploaded and downloaded byte counters ' +
    'and checked_at — exactly as tiktok_get_publish_status returns it with ' +
    'wait_for_completion: false: one status request, no polling, so a client polls by ' +
    'reading again. Needs scope video.publish or video.upload. Append ' +
    '?account=<profile> to read as that profile instead of the default one.',
  tool: getPublishStatusTool,
  args: { wait_for_completion: false },
  // A client filling in the template is offered the ids the journal recorded,
  // newest first — the ones a read here could say anything about.
  completions: { publish_id: { kind: 'publish_ids' } },
});

/** Every resource, in `resources/list` order; the template comes last. */
export const RESOURCES: readonly ResourceSpec[] = Object.freeze([
  authStatusResource,
  userInfoResource,
  recentVideosResource,
  creatorInfoResource,
  publishJournalResource,
  publishStatusResource,
] as const);
