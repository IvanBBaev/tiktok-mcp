/**
 * The prompt manifest (TOOLS.md § 7.1) — three guided flows:
 * `tiktok_post_video_guided`, `tiktok_post_photos_guided` and
 * `tiktok_upload_draft_guided`.
 *
 * A tool description steers one call at a time; a prompt can hand the model
 * the whole canonical flow of TOOLS.md § 4 before the first call is made:
 * creator info, preview, human approval, apply with the `plan_id`, poll, and
 * what to do when a step fails. The text is steering only — every rule it
 * states (no privacy default, single-use plan, the duplicate guard, the caps)
 * is enforced by the tools it names, so a client that never lists prompts
 * loses convenience, not safety.
 *
 * Design notes:
 *
 * - **Three prompts, the write flows.** The read tools need no choreography;
 *   the three write paths — a direct video post, a direct photo post, a draft
 *   — are the ones with an order that matters and a step (human approval)
 *   that no tool can perform. All three belong to `publish-write` because
 *   each ends in a write tool; each also names the `publish` read tools
 *   (creator info, status, journal), so they require that package as well;
 *   when either is off none is listed
 *   (`mcp/prompts.ts`). The two draft tools share one prompt: their flows
 *   differ only in the tool and the preview shape, and the choice between
 *   them is the media the user hands over.
 * - **Names are verbatim.** Every tool, field, mode and error code in the text
 *   is spelled exactly as the manifest spells it, and `test/tool-prompts.test.ts`
 *   checks each `tiktok_*` name against `allTools()`, so a rename that misses
 *   this file fails a test instead of steering the model to a tool that no
 *   longer exists.
 * - **Sentences, not a JSON dump.** The arguments enter the text where they
 *   belong ("The video is …"), and an absent optional argument is stated as
 *   absent ("The user has not chosen a privacy level yet.") rather than left
 *   as a hole, because the model has to know that choosing one is the user's
 *   next step, not its own. Where the protocol cannot express a rule — the
 *   draft prompt's "a video or photo URLs, not both" — the render states the
 *   problem and stops before the steps, instead of steering a call that the
 *   tools would refuse.
 * - **Shared sentences are shared once.** The rules that are the same in
 *   every flow (approval, the plan's life, the poll, the failure discipline)
 *   are constants the flows compose, so the three cannot drift apart in the
 *   words a model is told to obey.
 * - **`PROMPTS` is the one ordered source** the server lists from, the same
 *   role `PACKAGES` plays for tools. It is frozen for the same reason.
 * - **Completion sources are declared, not coded.** `account` completes from
 *   the configured profiles and `privacy_level` from `PRIVACY_LEVELS` — the
 *   same vocabulary the write tools advertise — so `completion/complete` and
 *   the tool schema cannot disagree. Every other argument is free text and
 *   declares nothing (`mcp/completions`).
 *
 * Layering: `core ← api ← mcp ← tools`; this module imports `mcp/` and, for
 * the privacy vocabulary, `api/`.
 */

import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js';

import { PRIVACY_LEVELS } from '../api/publish.js';
import {
  definePrompt,
  type PromptArgs,
  type PromptArgumentSpec,
  type PromptSpec,
} from '../mcp/prompts.js';

/** The exact CLI line the flow tells the user to run on `auth_expired` (TOOLS.md § 5.3). */
const LOGIN_CLI = 'npx tiktok-mcp-ai login';

/**
 * The validated arguments as `validatePromptArgs` guarantees them: `video` is
 * declared required, so it is present and non-blank by the time `render` runs.
 * Declaring that here is what keeps `noUncheckedIndexedAccess` from widening
 * it to `string | undefined` and inventing a fallback no validated call can
 * reach — the same move as `ProfileKeyMatch` in `core/config.ts`.
 */
interface VideoGuidedArgs extends PromptArgs {
  readonly video: string;
}

/** The photo flow's arguments: `photo_urls` is required, so it is present. */
interface PhotosGuidedArgs extends PromptArgs {
  readonly photo_urls: string;
}

/** One `user` text message — the only message shape this manifest renders. */
function userMessage(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

// ---------------------------------------------------------------------------
// Sentences the flows share
// ---------------------------------------------------------------------------

/**
 * A user-supplied value as it appears in a rendered step: JSON-quoted, so a
 * quote or a line break inside it cannot close the sentence and read as an
 * instruction of its own.
 */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/** The privacy level: the user's choice, or the fact that it is still theirs to make. */
function privacySentence(value: string | undefined): string {
  return value === undefined
    ? 'The user has not chosen a privacy level yet.'
    : `The user chose privacy_level ${quoted(value)}.`;
}

/** The account: the profile to pass on every call, or the default. */
function accountSentence(value: string | undefined): string {
  return value === undefined
    ? 'No account was named: omit account so the default profile is used.'
    : `Pass account ${quoted(value)} on every call below.`;
}

/** An optional text field of a photo post, stated as given or as absent. */
function textSentence(field: string, value: string | undefined): string {
  return value === undefined
    ? `No ${field} was given: omit ${field} unless the user supplies one.`
    : `The ${field} is ${quoted(value)}.`;
}

/** The URLs of a `photo_urls` argument: split on commas and whitespace, blanks dropped. */
function splitUrls(raw: string): readonly string[] {
  return raw.split(/[\s,]+/).filter((part) => part !== '');
}

/** The carousel as the model must pass it: the count and the order, verbatim. */
function carouselSentence(urls: readonly string[]): string {
  const count =
    urls.length === 1 ? 'one photo' : `${String(urls.length)} photos, in this order`;
  return `The carousel has ${count}: ${urls.map(quoted).join(', ')}.`;
}

/** The first line after the situation, in every flow that has steps. */
const ORDER_RULE =
  'Work through these steps in order. Every rule below is also enforced by the ' +
  'tools, so do not shortcut it.';

/** How `video` maps onto the flat `source` shape of the video tools (TOOLS.md § 3.8). */
const VIDEO_MAPPING =
  'Map the video: if it starts with https://, pass source: "url" and video_url; ' +
  'otherwise pass source: "file" and file_path.';

/** How the carousel maps onto `photo_urls` / `photo_cover_index` (TOOLS.md § 3.10). */
const CAROUSEL_MAPPING =
  'Pass photo_urls as an array in the order above and photo_cover_index 0 unless the ' +
  'user named another cover.';

/** The one step no tool can perform. */
const APPROVAL_RULE =
  'Ask for explicit approval. Do NOT call with plan_id until the user has approved in ' +
  'their own words.';

/** The plan's life (TOOLS.md § 2.6) — follows "… plus the plan_id from the preview." */
const PLAN_RULE =
  'It is single-use and expires 10 minutes after the preview; leave ' +
  'wait_for_completion off.';

/** The one answer to `mode: "plan_incomplete"`: the choice is the user's (TOOLS.md § 4 item 1). */
const PLAN_INCOMPLETE_RULE =
  'On mode: "plan_incomplete", show the user the privacy_level_options it lists and ' +
  'ask them to choose one — never pick one for them — then preview again with their ' +
  'choice.';

/** The poll of a direct post: it ends live. */
const POLL_LIVE =
  'Follow the poll hint: call tiktok_get_publish_status with the publish_id until ' +
  'PUBLISH_COMPLETE, then report the public_post_id. On FAILED, report ' +
  "TikTok's reason and do not re-post.";

/** The poll of a draft: it ends in the user's inbox, and the user finishes it. */
const POLL_INBOX =
  'Follow the poll hint: call tiktok_get_publish_status with the publish_id until ' +
  'SEND_TO_USER_INBOX, then tell the user to open the TikTok app inbox notification ' +
  'to edit and publish the draft; unopened drafts expire. On FAILED, report ' +
  "TikTok's reason and do not re-send.";

/** The caps of a direct post (TOOLS.md § 4 item 2). */
const CAP_FAILURES =
  'daily_post_cap or active_user_cap — stop and tell the user it cannot be done today.';

/** The cap of a draft (TOOLS.md § 3.9). */
const DRAFT_CAP_FAILURE =
  'pending_share_cap — TikTok allows 5 unpublished API drafts per account per 24 h; ' +
  'stop and tell the user to publish or discard drafts in the TikTok app, or wait.';

/** A photo URL TikTok cannot pull from: there is no file path to fall back to. */
const PHOTO_URL_FAILURE =
  'url_prefix_unverified — the message names the offending photo_urls[<i>]; the user ' +
  'must host that photo under a verified prefix (photos have no file upload); never ' +
  'rewrite a URL yourself.';

/** A video URL TikTok cannot pull from: a local file is the other way in. */
const VIDEO_URL_FAILURE =
  'url_prefix_unverified — the user must host the video under a verified prefix or ' +
  'give a local file under TT_MEDIA_ROOT; never rewrite a URL yourself.';

/** The failures every write flow handles the same way (TOOLS.md § 4 items 3–4). */
const COMMON_FAILURES =
  `auth_expired — ask the user to run ${LOGIN_CLI} and do not retry until they ` +
  'confirm it is done. possible_duplicate — verify with tiktok_list_publish_journal ' +
  'and tiktok_get_publish_status before ever using force. plan_mismatch or ' +
  'plan_not_found — preview again; never invent a plan_id.';

/** The one message of a flow: the situation, the order rule, the numbered steps. */
function flow(situation: string, steps: readonly string[]): readonly PromptMessage[] {
  const numbered = steps.map((step, index) => `${String(index + 1)}. ${step}`);
  return [userMessage([situation, ORDER_RULE, ...numbered].join('\n\n'))];
}

// ---------------------------------------------------------------------------
// tiktok_post_video_guided
// ---------------------------------------------------------------------------

/** The opening paragraph: what is being posted, in the user's own terms. */
function videoSituation(args: VideoGuidedArgs): string {
  const title =
    args.title === undefined
      ? 'No caption was given: omit title unless the user supplies one.'
      : `The caption (title) is ${quoted(args.title)}.`;
  return [
    `Post a video to TikTok through this server. The video is ${quoted(args.video)}.`,
    title,
    privacySentence(args.privacy_level),
    accountSentence(args.account),
  ].join(' ');
}

/** The flow of TOOLS.md § 4 item 1 and § 3.8, step by step, tools named verbatim. */
const VIDEO_STEPS: readonly string[] = Object.freeze([
  'Call tiktok_get_creator_info to learn privacy_level_options, which toggles ' +
    '(comments, duet, stitch) the account disables, and max_video_post_duration_sec.',
  'Call tiktok_post_video WITHOUT plan_id — that is the preview; nothing is ' +
    `posted. ${VIDEO_MAPPING} Pass title and privacy_level when given. ` +
    PLAN_INCOMPLETE_RULE,
  'Show the user the preview: payload.post_info, every derived row, the ' +
    `consent_line and the source block (for a file, the chunk plan). ${APPROVAL_RULE}`,
  'Call tiktok_post_video again with IDENTICAL arguments plus the plan_id from ' +
    `the preview. ${PLAN_RULE}`,
  POLL_LIVE,
  `If a call fails: ${CAP_FAILURES} ${COMMON_FAILURES}`,
]);

/** `privacy_level` reads the same in every flow that posts directly, and completes from the vocabulary. */
const PRIVACY_ARGUMENT = Object.freeze<PromptArgumentSpec>({
  name: 'privacy_level',
  description:
    'Who can see the post: PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, ' +
    'FOLLOWER_OF_CREATOR or SELF_ONLY. Omit to have the flow show the live ' +
    'options and ask the user.',
  required: false,
  completion: { kind: 'values', values: PRIVACY_LEVELS },
});

/** `account` reads the same in every flow, and completes from the configured profiles. */
const ACCOUNT_ARGUMENT = Object.freeze<PromptArgumentSpec>({
  name: 'account',
  description:
    'Profile name from the server configuration. Omit to use the default profile.',
  required: false,
  completion: { kind: 'profiles' },
});

/** The guided direct-post flow (TOOLS.md § 7.1). */
export const postVideoGuidedPrompt: PromptSpec = definePrompt({
  name: 'tiktok_post_video_guided',
  title: 'Post a video (guided)',
  description:
    'Walk through posting a video to TikTok safely: check the creator settings, ' +
    "preview the post, get the user's approval, apply with the plan_id, then poll " +
    'until it is live. Every step names the exact tool to call.',
  package: 'publish-write',
  requires: ['publish'],
  arguments: [
    {
      name: 'video',
      description:
        'Local file path (absolute or relative to TT_MEDIA_ROOT) or HTTPS URL of the video.',
      required: true,
    },
    {
      name: 'title',
      description:
        'Caption for the post (up to 2200 UTF-16 code units). Omit for an untitled post.',
      required: false,
    },
    PRIVACY_ARGUMENT,
    ACCOUNT_ARGUMENT,
  ],
  render: (args: VideoGuidedArgs) => flow(videoSituation(args), VIDEO_STEPS),
});

// ---------------------------------------------------------------------------
// tiktok_post_photos_guided
// ---------------------------------------------------------------------------

/** `photo_urls` reads the same in both flows that take a carousel. */
const PHOTO_URLS_DESCRIPTION =
  'HTTPS URLs of the photos in carousel order (1–35), separated by commas or ' +
  'whitespace. Every URL must start with a verified prefix from ' +
  'TT_VERIFIED_URL_PREFIXES — TikTok cannot pull photos from anywhere else.';

/** A `photo_urls` value that named no URL at all — nothing to preview. */
const NO_PHOTOS =
  'No photo URLs were given. Ask the user for them before calling any tool.';

/** The opening paragraph of the photo flow: the carousel and its text, verbatim. */
function photosSituation(args: PhotosGuidedArgs, urls: readonly string[]): string {
  return [
    `Post a photo carousel to TikTok through this server. ${carouselSentence(urls)}`,
    textSentence('title', args.title),
    textSentence('description', args.description),
    privacySentence(args.privacy_level),
    accountSentence(args.account),
  ].join(' ');
}

/** The flow of TOOLS.md § 3.10, step by step, tools named verbatim. */
const PHOTOS_STEPS: readonly string[] = Object.freeze([
  'Call tiktok_get_creator_info to learn privacy_level_options and whether comments ' +
    'are disabled.',
  'Call tiktok_post_photos WITHOUT plan_id — that is the preview; nothing is ' +
    `posted. ${CAROUSEL_MAPPING} Pass title, description and privacy_level when ` +
    'given. Set auto_add_music only if the user wants music — without it the post ' +
    `plays silent, so ask. ${PLAN_INCOMPLETE_RULE}`,
  'Show the user the preview: payload.post_info, every derived row, the ' +
    `consent_line and payload.source (urls and cover index). ${APPROVAL_RULE}`,
  'Call tiktok_post_photos again with IDENTICAL arguments plus the plan_id from ' +
    `the preview. ${PLAN_RULE}`,
  POLL_LIVE,
  `If a call fails: ${PHOTO_URL_FAILURE} ${CAP_FAILURES} ${COMMON_FAILURES}`,
]);

/** The guided photo-carousel post (TOOLS.md § 7.1). */
export const postPhotosGuidedPrompt: PromptSpec = definePrompt({
  name: 'tiktok_post_photos_guided',
  title: 'Post photos (guided)',
  description:
    'Walk through posting a photo carousel to TikTok safely: check the creator ' +
    "settings, preview the post, get the user's approval, apply with the plan_id, " +
    'then poll until it is live. Every step names the exact tool to call.',
  package: 'publish-write',
  requires: ['publish'],
  arguments: [
    { name: 'photo_urls', description: PHOTO_URLS_DESCRIPTION, required: true },
    {
      name: 'title',
      description:
        'Photo post title (up to 90 UTF-16 code units). Longer text belongs in ' +
        'description.',
      required: false,
    },
    {
      name: 'description',
      description:
        'Photo post description (up to 4000 UTF-16 code units). #hashtags and ' +
        '@mentions are parsed here.',
      required: false,
    },
    PRIVACY_ARGUMENT,
    ACCOUNT_ARGUMENT,
  ],
  render: (args: PhotosGuidedArgs) => {
    const urls = splitUrls(args.photo_urls);
    if (urls.length === 0) return [userMessage(NO_PHOTOS)];
    return flow(photosSituation(args, urls), PHOTOS_STEPS);
  },
});

// ---------------------------------------------------------------------------
// tiktok_upload_draft_guided
// ---------------------------------------------------------------------------

/** Both media at once: a draft holds one, and the choice is the user's. */
const BOTH_MEDIA =
  'Both a video and photo URLs were given; a draft holds one or the other. Ask the ' +
  'user which one to send before calling any tool.';

/** No media at all: nothing to preview. */
const NO_MEDIA =
  'Neither a video nor photo URLs were given. Ask the user for one of them before ' +
  'calling any tool.';

/** The step every draft flow opens with: no creator pre-flight (TOOLS.md § 3.9). */
const NO_CREATOR_INFO =
  'Do NOT call tiktok_get_creator_info: a draft carries no privacy level or toggles, ' +
  'and a draft-only authorization (scope video.upload only) may lack the scope that ' +
  'call needs.';

/**
 * The text a video draft cannot carry (TOOLS.md § 3.9), stated as not sent
 * rather than dropped in silence: the model has to know the user finishes
 * the caption in the app, not that the argument was lost. One sentence per
 * case; empty when neither was given, so the situation reads the same as
 * before.
 */
function unsentTextSentence(args: PromptArgs): string {
  const hasTitle = args.title !== undefined;
  const hasDescription = args.description !== undefined;
  if (hasTitle && hasDescription) {
    return (
      ' A title and a description were given, but a video draft carries neither — ' +
      'they are not sent; the user writes them in the app.'
    );
  }
  if (hasTitle) {
    return (
      ' A title was given, but a video draft carries no title — it is not sent; the ' +
      'user writes it in the app.'
    );
  }
  if (hasDescription) {
    return (
      ' A description was given, but a video draft carries no description — it is ' +
      'not sent; the user writes it in the app.'
    );
  }
  return '';
}

/** The video draft: the situation and the steps of TOOLS.md § 3.9. */
function videoDraft(video: string, args: PromptArgs): readonly PromptMessage[] {
  const situation =
    `Send a video to the user's TikTok drafts through this server. The video is ` +
    `${quoted(video)}.${unsentTextSentence(args)} ${accountSentence(args.account)}`;
  return flow(situation, [
    NO_CREATOR_INFO,
    'Call tiktok_upload_video_draft WITHOUT plan_id — that is the preview; nothing ' +
      `is sent. ${VIDEO_MAPPING} The preview is always mode: "plan".`,
    `Show the user the preview: payload.source (for a file, the chunk plan). ${APPROVAL_RULE}`,
    'Call tiktok_upload_video_draft again with IDENTICAL arguments plus the plan_id ' +
      `from the preview. ${PLAN_RULE}`,
    POLL_INBOX,
    `If a call fails: ${DRAFT_CAP_FAILURE} ${VIDEO_URL_FAILURE} ${COMMON_FAILURES}`,
  ]);
}

/** The photo draft: the situation and the steps of TOOLS.md § 3.11. */
function photosDraft(
  urls: readonly string[],
  args: PromptArgs,
): readonly PromptMessage[] {
  const situation = [
    `Send a photo carousel to the user's TikTok drafts through this server. ` +
      carouselSentence(urls),
    textSentence('title', args.title),
    textSentence('description', args.description),
    accountSentence(args.account),
  ].join(' ');
  return flow(situation, [
    NO_CREATOR_INFO,
    'Call tiktok_upload_photos_draft WITHOUT plan_id — that is the preview; nothing ' +
      `is sent. ${CAROUSEL_MAPPING} Pass title and description when given. The ` +
      'preview is always mode: "plan".',
    'Show the user the preview: payload.post_info and payload.source (the urls and ' +
      `the photo_cover_index). ${APPROVAL_RULE}`,
    'Call tiktok_upload_photos_draft again with IDENTICAL arguments plus the plan_id ' +
      `from the preview. ${PLAN_RULE}`,
    POLL_INBOX,
    `If a call fails: ${DRAFT_CAP_FAILURE} ${PHOTO_URL_FAILURE} ${COMMON_FAILURES}`,
  ]);
}

/**
 * The guided draft flow (TOOLS.md § 7.1). Every argument is optional because
 * the protocol cannot say "exactly one of `video` and `photo_urls`"; the
 * render says it instead, and stops before the steps when the rule is broken.
 */
export const uploadDraftGuidedPrompt: PromptSpec = definePrompt({
  name: 'tiktok_upload_draft_guided',
  title: 'Send to drafts (guided)',
  description:
    "Walk through sending a video or a photo carousel to the user's TikTok drafts: " +
    "preview the upload, get the user's approval, apply with the plan_id, then poll " +
    'until it reaches the inbox. Every step names the exact tool to call.',
  package: 'publish-write',
  requires: ['publish'],
  arguments: [
    {
      name: 'video',
      description:
        'Local file path (absolute or relative to TT_MEDIA_ROOT) or HTTPS URL of the ' +
        "video to send to the user's drafts. Give this or photo_urls, not both.",
      required: false,
    },
    {
      name: 'photo_urls',
      description: `${PHOTO_URLS_DESCRIPTION} Give this or video, not both.`,
      required: false,
    },
    {
      name: 'title',
      description:
        'Title for a photo draft (up to 90 UTF-16 code units). A video draft has no ' +
        'title — the user writes it in the app.',
      required: false,
    },
    {
      name: 'description',
      description:
        'Description for a photo draft (up to 4000 UTF-16 code units); #hashtags and ' +
        '@mentions are parsed here. A video draft has no description — the user ' +
        'writes it in the app.',
      required: false,
    },
    ACCOUNT_ARGUMENT,
  ],
  render: (args: PromptArgs) => {
    const urls = args.photo_urls === undefined ? [] : splitUrls(args.photo_urls);
    if (args.video === undefined) {
      return urls.length === 0 ? [userMessage(NO_MEDIA)] : photosDraft(urls, args);
    }
    return urls.length === 0 ? videoDraft(args.video, args) : [userMessage(BOTH_MEDIA)];
  },
});

/** Every prompt the server lists, in `prompts/list` order. */
export const PROMPTS: readonly PromptSpec[] = Object.freeze([
  postVideoGuidedPrompt,
  postPhotosGuidedPrompt,
  uploadDraftGuidedPrompt,
]);
