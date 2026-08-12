/**
 * The photo half of the write surface: `tiktok_post_photos` (TOOLS.md § 3.10)
 * and `tiktok_upload_photos_draft` (§ 3.11).
 *
 * Photos are not videos with a different `media_type`, and the differences are
 * the reason this file exists rather than another branch inside
 * `publish-write`:
 *
 * - **URLs only.** TikTok's content endpoint has no `FILE_UPLOAD` source for
 *   photos, so there is no `TT_MEDIA_ROOT` path here and no chunking. A local
 *   photo cannot be posted at all — the user has to host it first, which is
 *   what the `url_prefix_unverified` message says instead of offering a `file`
 *   alternative that does not exist.
 * - **A different text budget.** `title` is 90 UTF-16 code units, not 2200;
 *   the long text belongs in `description` (4000). Both limits are enforced in
 *   `api/publish` so the two photo tools cannot drift apart.
 * - **No duet or stitch.** Those fields do not exist upstream for a carousel,
 *   so the schema omits them — the omission is itself the contract (§ 3.10).
 *
 * Everything else — the § 2.6.3 ordering, the plan guards, the duplicate guard,
 * the journal — is `publish-common`'s, unchanged.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import {
  auditRestrictionsActive,
  getCreatorInfo,
  initPhotoPost,
  MAX_PHOTOS,
  MIN_PHOTOS,
  PHOTO_DESCRIPTION_MAX,
  PHOTO_TITLE_MAX,
  PRIVACY_LEVELS,
  resolvePhotoDraftPostInfo,
  resolvePhotoPostInfo,
  type CreatorInfo,
  type PhotoPostInput,
} from '../api/publish.js';
import { defineTool, toolInput, type ToolCtx } from '../mcp/define.js';
import { invalidParamsError, publishToolError } from '../mcp/errors.js';
import { payloadDigest, peekPublishBucket, resolveWriteStep } from '../mcp/plan.js';
import { PLAN_ID_PATTERN, type PlanExpectation } from '../mcp/plan-store.js';
import type { Hint, ToolError, ToolResult } from '../mcp/result.js';
import {
  accountBlock,
  checkMediaUrl,
  choosePrivacyHint,
  consentLine,
  creatorBlock,
  dispatchWrite,
  draftInboxHint,
  mintPlan,
  resolveOpenId,
  runPlanGuards,
  signalOpt,
  takeWriteToken,
  waitIfAsked,
  type AppliedData,
  type DraftPreview,
  type SourceBlock,
  type WritePreview,
} from './publish-common.js';
import { auditRestrictionsNote } from './publish.js';

const TOOL_NAME = 'tiktok_post_photos';
const DRAFT_TOOL_NAME = 'tiktok_upload_photos_draft';

const ACTION = 'DIRECT_POST photos';
const DRAFT_ACTION = 'MEDIA_UPLOAD photos draft';

const POST_MODE = 'DIRECT_POST';
const DRAFT_POST_MODE = 'MEDIA_UPLOAD';

/** Both photo tools resolve to `PULL_FROM_URL`; nothing else is possible. */
const INTENT = 'PULL_FROM_URL';

export type PostPhotosData = WritePreview | AppliedData;
export type UploadPhotosDraftData = DraftPreview | AppliedData;

// ---------------------------------------------------------------------------
// The carousel, shared by both tools
// ---------------------------------------------------------------------------

/** The two source fields, as both schemas expose them. */
interface CarouselArgs {
  photo_urls: readonly string[];
  photo_cover_index?: number;
}

const PHOTO_URLS_DESCRIPTION =
  'HTTPS URLs of the photos, in carousel order (1–35). Every URL must start with a verified ' +
  'prefix from TT_VERIFIED_URL_PREFIXES — TikTok refuses unverified domains. JPEG or WebP, up ' +
  'to 20 MB and 1080p each.';

const COVER_INDEX_DESCRIPTION =
  'Zero-based index of the cover photo. Must be a valid index into photo_urls.';

const TITLE_DESCRIPTION =
  'Photo post title — max 90 UTF-16 code units (NOT 2200; photos differ from videos). Longer ' +
  'text goes in description.';

const DESCRIPTION_DESCRIPTION =
  'Photo post description, up to 4000 UTF-16 code units. #hashtags and @mentions are parsed here.';

/** Zod bounds the array; this bounds the index against it and checks every URL. */
function checkCarousel(
  args: CarouselArgs,
  prefixes: readonly string[],
): ToolError | undefined {
  const cover = args.photo_cover_index ?? 0;
  if (cover >= args.photo_urls.length) {
    return invalidParamsError(
      `photo_cover_index: ${String(cover)} is not an index into photo_urls ` +
        `(${String(args.photo_urls.length)} photo${args.photo_urls.length === 1 ? '' : 's'})`,
    );
  }
  // Reported one at a time, by index: a model that gets "photo_urls[3]" can fix
  // that entry, where a list of every offender invites a blind re-send.
  for (const [index, url] of args.photo_urls.entries()) {
    const failed = checkMediaUrl(url, `photo_urls[${String(index)}]`, prefixes, false);
    if (failed !== undefined) return failed;
  }
  return undefined;
}

function photoSourceBlock(args: CarouselArgs): SourceBlock {
  return {
    type: 'url',
    urls: [...args.photo_urls],
    photo_cover_index: args.photo_cover_index ?? 0,
  };
}

/**
 * What gets digested (§ 2.6.2): the fully resolved upstream payload. Preview
 * and apply build it through this one function, so the two digests can only
 * differ if the payload really did.
 */
function digestedPayload(
  postInfo: Record<string, unknown>,
  postMode: string,
  args: CarouselArgs,
): Record<string, unknown> {
  return {
    media_type: 'PHOTO',
    post_mode: postMode,
    post_info: postInfo,
    source_info: {
      source: INTENT,
      photo_images: [...args.photo_urls],
      photo_cover_index: args.photo_cover_index ?? 0,
    },
  };
}

/**
 * The upstream half of a dispatch. `report` fires the moment a `publish_id`
 * exists, which is what lets a later failure be classified as an attempt that
 * happened rather than one that did not (CC-B4) — for photos there is no
 * second phase after it, but the classification still depends on the call.
 */
function photoSender(
  ctx: ToolCtx,
  postInfo: Record<string, unknown>,
  postMode: 'DIRECT_POST' | 'MEDIA_UPLOAD',
  args: CarouselArgs,
): (report: (publishId: string) => void) => Promise<string> {
  return async (report) => {
    const started = await initPhotoPost(ctx.api, {
      postInfo,
      postMode,
      photoUrls: [...args.photo_urls],
      photoCoverIndex: args.photo_cover_index ?? 0,
      ...signalOpt(ctx),
    });
    report(started.publishId);
    return started.publishId;
  };
}

/**
 * § 3.10: the duplicate guard excerpts title *and* description. A carousel is
 * frequently untitled with all the text in the description, and excerpting only
 * the title would make every such post look identical to the guard.
 */
function excerptText(title: string | undefined, description: string | undefined): string {
  return [title, description].filter((part) => part !== undefined).join(' ');
}

// ---------------------------------------------------------------------------
// tiktok_post_photos (TOOLS.md § 3.10)
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Post a photo carousel DIRECTLY to the user's TikTok profile — it goes live once processing " +
  'completes. Requires scope video.publish. Use for "post these photos". NOT for "send photos ' +
  'to my drafts" — use tiktok_upload_photos_draft. Posts cannot be edited or deleted through ' +
  'this server.\n\n' +
  'Photos can only be pulled by TikTok from verified URLs (prefixes configured in ' +
  'TT_VERIFIED_URL_PREFIXES) — the photo API has no local-file upload. For photos on disk, the ' +
  'user must first host them under a verified prefix. Title is much shorter than for videos: ' +
  'max 90 UTF-16 code units; the longer text belongs in description (max 4000). Same ' +
  'preview/plan_id contract and the same rate limits (6/min local, ~15 posts/24 h shared) as ' +
  'tiktok_post_video.';

const POST_PHOTOS_INPUT = toolInput({
  photo_urls: z
    .array(z.string().min(1))
    .min(MIN_PHOTOS)
    .max(MAX_PHOTOS)
    .describe(PHOTO_URLS_DESCRIPTION),
  photo_cover_index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(COVER_INDEX_DESCRIPTION),
  title: z.string().max(PHOTO_TITLE_MAX).optional().describe(TITLE_DESCRIPTION),
  description: z
    .string()
    .max(PHOTO_DESCRIPTION_MAX)
    .optional()
    .describe(DESCRIPTION_DESCRIPTION),
  privacy_level: z
    .enum(PRIVACY_LEVELS)
    .optional()
    .describe(
      'Who can see the post. NO default — the user must choose from the options in the preview ' +
        '(they depend on account type and app audit status; unaudited apps allow only ' +
        'SELF_ONLY). A preview without this field returns the options and no plan_id.',
    ),
  disable_comment: z
    .boolean()
    .optional()
    .describe('true disables comments on this post.'),
  auto_add_music: z
    .boolean()
    .optional()
    .describe(
      'true lets TikTok add recommended music to the carousel. Ask the user; photo posts ' +
        'without music play silent.',
    ),
  brand_content_toggle: z
    .boolean()
    .optional()
    .describe(
      'true ONLY when the user states this is paid partnership / branded content for a third ' +
        'party. Incompatible with privacy_level SELF_ONLY — and therefore unavailable while the ' +
        'app is unaudited. Adds the Branded Content consent line to the preview.',
    ),
  brand_organic_toggle: z
    .boolean()
    .optional()
    .describe(
      "true when the post promotes the user's OWN business (organic branded content).",
    ),
  is_aigc: z
    .boolean()
    .optional()
    .describe(
      'Label the post as AI-generated content on TikTok. Defaults to true because posts made ' +
        'through an AI assistant usually are. Set false only if the user confirms the content is ' +
        'not AI-generated.',
    ),
  wait_for_completion: z
    .boolean()
    .optional()
    .describe(
      'After a successful apply, keep polling publish status inside this call (up to ~60 s) ' +
        'before returning. Default false: return publish_id immediately with a poll hint — ' +
        'prefer that; long calls risk client timeouts, and a timed-out write call must never be ' +
        're-run blindly.',
    ),
  plan_id: z
    .string()
    .optional()
    .describe(
      "Execution token from this tool's own preview. Present = execute the previewed post. " +
        'Single-use, expires 10 minutes after the preview, bound to the exact previewed payload ' +
        'and this account. Never invent or reuse one.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Override the duplicate guard. Set true only after verifying via ' +
        'tiktok_list_publish_journal and tiktok_get_publish_status that the earlier identical ' +
        'attempt did not create a post.',
    ),
});

type PostPhotosInput = z.infer<typeof POST_PHOTOS_INPUT>;

/** Tool arguments → the `api/publish` input shape. Snake case stops here. */
function toPhotoPostInput(args: PostPhotosInput, privacyLevel: string): PhotoPostInput {
  return {
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.description === undefined ? {} : { description: args.description }),
    privacyLevel,
    ...(args.disable_comment === undefined
      ? {}
      : { disableComment: args.disable_comment }),
    ...(args.auto_add_music === undefined ? {} : { autoAddMusic: args.auto_add_music }),
    ...(args.brand_content_toggle === undefined
      ? {}
      : { brandContentToggle: args.brand_content_toggle }),
    ...(args.brand_organic_toggle === undefined
      ? {}
      : { brandOrganicToggle: args.brand_organic_toggle }),
    ...(args.is_aigc === undefined ? {} : { isAigc: args.is_aigc }),
  };
}

async function previewPhotos(
  args: PostPhotosInput,
  ctx: ToolCtx,
): Promise<ToolResult<PostPhotosData>> {
  const { api } = ctx;

  // A preview is a read: it makes no init request, spends no publish token and
  // never fails on an empty bucket (§ 2.6.1). The bucket state is reported
  // instead, so the model can see whether the apply will be accepted.
  let creator: CreatorInfo;
  try {
    creator = await getCreatorInfo(api, signalOpt(ctx));
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  const openId = await resolveOpenId(ctx);
  const restricted = auditRestrictionsActive(creator);
  const shared = {
    account: accountBlock(api.profile, openId, creator.nickname),
    action: ACTION,
    creator: creatorBlock(creator),
    audit_restrictions_active: restricted,
    consent_line: consentLine(
      args.brand_content_toggle === true,
      args.brand_organic_toggle === true,
    ),
    meta: { rate_bucket: peekPublishBucket(api.profile, api.clock) },
  };

  // § 2.6.1 step 4: no privacy level, no plan — with the live options attached,
  // because the whole point is to let the user choose from them.
  if (args.privacy_level === undefined) {
    const hints: Hint[] = [choosePrivacyHint(TOOL_NAME, creator.privacyLevelOptions)];
    if (restricted) hints.push(auditRestrictionsNote());
    return {
      ok: true,
      data: {
        mode: 'plan_incomplete',
        ...shared,
        payload: { source: photoSourceBlock(args) },
        missing: ['privacy_level'],
      },
      hints,
    };
  }

  let resolved;
  try {
    resolved = resolvePhotoPostInfo(toPhotoPostInput(args, args.privacy_level), creator, {
      isAigc: api.settings.defaultAigcLabel,
    });
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  const plan = mintPlan(
    ctx,
    TOOL_NAME,
    payloadDigest(digestedPayload(resolved.postInfo, POST_MODE, args)),
    openId,
  );

  const hints: Hint[] = [plan.hint];
  if (restricted) hints.push(auditRestrictionsNote());

  return {
    ok: true,
    data: {
      mode: 'plan',
      plan_id: plan.planId,
      expires_at: plan.expiresAt,
      ...shared,
      payload: { post_info: resolved.postInfo, source: photoSourceBlock(args) },
      derived: resolved.derived,
    },
    hints,
  };
}

async function executePhotos(
  args: PostPhotosInput,
  ctx: ToolCtx,
  planId: string | undefined,
): Promise<ToolResult<PostPhotosData>> {
  const { api } = ctx;

  // Step 2 — before any network, and before the plan is touched.
  const refused = takeWriteToken(ctx);
  if (refused !== undefined) return refused;

  // Step 3 — the preview's own code path, against live creator state.
  let creator: CreatorInfo;
  let resolved;
  let openId: string;
  try {
    creator = await getCreatorInfo(api, signalOpt(ctx));
    openId = await resolveOpenId(ctx);
    if (args.privacy_level === undefined) {
      return {
        ok: false,
        error: invalidParamsError(
          'privacy_level: required to post — call this tool without plan_id to see the options ' +
            'the account currently allows',
        ),
      };
    }
    resolved = resolvePhotoPostInfo(toPhotoPostInput(args, args.privacy_level), creator, {
      isAigc: api.settings.defaultAigcLabel,
    });
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  // Step 4.
  const digest = payloadDigest(digestedPayload(resolved.postInfo, POST_MODE, args));
  const expectation: PlanExpectation = {
    digest,
    profile: api.profile,
    openId,
    tool: TOOL_NAME,
  };

  // Steps 5–7.
  const guard = await runPlanGuards(ctx, planId, expectation, args.force === true);
  if (guard !== undefined) return { ok: false, error: guard };

  // Steps 8–9.
  const result = await dispatchWrite(ctx, {
    toolName: TOOL_NAME,
    mode: POST_MODE,
    source: INTENT,
    title: excerptText(args.title, args.description),
    digest,
    planId: planId ?? '',
    openId,
    send: photoSender(ctx, resolved.postInfo, POST_MODE, args),
  });

  return await waitIfAsked(ctx, result, args.wait_for_completion === true);
}

export const postPhotosTool = defineTool<PostPhotosInput, PostPhotosData>({
  name: TOOL_NAME,
  title: 'Post a photo carousel to TikTok',
  description: DESCRIPTION,
  package: 'publish-write',
  scopes: ['video.publish'],
  annotations: {
    readOnlyHint: false,
    // The carousel is public and cannot be edited or deleted through this server.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: POST_PHOTOS_INPUT,
  handler: async (args, ctx): Promise<ToolResult<PostPhotosData>> => {
    // Checked here rather than with `.refine()`: a refinement makes the schema a
    // `ZodEffects`, and the JSON Schema agents read loses the object shape.
    if (args.plan_id !== undefined && !PLAN_ID_PATTERN.test(args.plan_id)) {
      return {
        ok: false,
        error: invalidParamsError(
          'plan_id: not a plan_id this tool issued — call without plan_id to get a fresh preview',
        ),
      };
    }

    const carouselError = checkCarousel(args, ctx.api.settings.verifiedUrlPrefixes);
    if (carouselError !== undefined) return { ok: false, error: carouselError };

    const decision = resolveWriteStep(args.plan_id, ctx.api.settings.writeMode);
    return decision.step === 'preview'
      ? await previewPhotos(args, ctx)
      : await executePhotos(args, ctx, decision.planId);
  },
});

// ---------------------------------------------------------------------------
// tiktok_upload_photos_draft (TOOLS.md § 3.11)
// ---------------------------------------------------------------------------

const DRAFT_DESCRIPTION =
  "Send a photo carousel to the user's TikTok INBOX as a draft — the user finishes and " +
  'publishes it in the TikTok app; nothing goes live from this call. Requires scope ' +
  'video.upload. Use for "send these photos to my drafts". NOT for direct posting — use ' +
  'tiktok_post_photos. Same verified-URL-only rule as tiktok_post_photos (no local photo files ' +
  '— the platform has no photo upload endpoint). Same preview/plan_id contract. Counts toward ' +
  "TikTok's cap of 5 unpublished API drafts per 24 h. After success, tell the user to open the " +
  'TikTok app inbox notification.';

const UPLOAD_PHOTOS_DRAFT_INPUT = toolInput({
  photo_urls: z
    .array(z.string().min(1))
    .min(MIN_PHOTOS)
    .max(MAX_PHOTOS)
    .describe(PHOTO_URLS_DESCRIPTION),
  photo_cover_index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(COVER_INDEX_DESCRIPTION),
  title: z.string().max(PHOTO_TITLE_MAX).optional().describe(TITLE_DESCRIPTION),
  description: z
    .string()
    .max(PHOTO_DESCRIPTION_MAX)
    .optional()
    .describe(DESCRIPTION_DESCRIPTION),
  wait_for_completion: z
    .boolean()
    .optional()
    .describe(
      'After a successful apply, keep polling publish status inside this call (up to ~60 s) ' +
        'before returning; the terminal status for a draft is SEND_TO_USER_INBOX. Default ' +
        'false: return publish_id immediately with a poll hint — prefer that; long calls risk ' +
        'client timeouts, and a timed-out write call must never be re-run blindly.',
    ),
  plan_id: z
    .string()
    .optional()
    .describe(
      "Execution token from this tool's own preview. Present = execute the previewed upload. " +
        'Single-use, expires 10 minutes after the preview, bound to the exact previewed payload ' +
        'and this account. Never invent or reuse one.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Override the duplicate guard. Set true only after verifying via ' +
        'tiktok_list_publish_journal and tiktok_get_publish_status that the earlier identical ' +
        'attempt did not create a draft.',
    ),
});

type UploadPhotosDraftInput = z.infer<typeof UPLOAD_PHOTOS_DRAFT_INPUT>;

/**
 * The draft `post_info` — title and description only. It is resolved through
 * `api/publish` rather than assembled here so the 90/4000 limits are checked
 * once, in the same place the posting tool checks them.
 */
function draftPostInfo(args: UploadPhotosDraftInput): Record<string, unknown> {
  return resolvePhotoDraftPostInfo({
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.description === undefined ? {} : { description: args.description }),
  }).postInfo;
}

async function previewPhotosDraft(
  args: UploadPhotosDraftInput,
  ctx: ToolCtx,
): Promise<ToolResult<UploadPhotosDraftData>> {
  const { api } = ctx;

  let postInfo: Record<string, unknown>;
  try {
    postInfo = draftPostInfo(args);
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  const openId = await resolveOpenId(ctx);
  const plan = mintPlan(
    ctx,
    DRAFT_TOOL_NAME,
    payloadDigest(digestedPayload(postInfo, DRAFT_POST_MODE, args)),
    openId,
  );

  return {
    ok: true,
    data: {
      mode: 'plan',
      plan_id: plan.planId,
      expires_at: plan.expiresAt,
      account: accountBlock(api.profile, openId),
      action: DRAFT_ACTION,
      payload: { post_info: postInfo, source: photoSourceBlock(args) },
      meta: { rate_bucket: peekPublishBucket(api.profile, api.clock) },
    },
    hints: [plan.hint],
  };
}

async function executePhotosDraft(
  args: UploadPhotosDraftInput,
  ctx: ToolCtx,
  planId: string | undefined,
): Promise<ToolResult<UploadPhotosDraftData>> {
  const { api } = ctx;

  // Step 2.
  const refused = takeWriteToken(ctx);
  if (refused !== undefined) return refused;

  // Step 3 — no `creator_info` to re-read: a `video.upload`-only grant may not
  // carry the scope for it (§ 3.11).
  let postInfo: Record<string, unknown>;
  try {
    postInfo = draftPostInfo(args);
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }
  const openId = await resolveOpenId(ctx);

  // Step 4.
  const digest = payloadDigest(digestedPayload(postInfo, DRAFT_POST_MODE, args));
  const expectation: PlanExpectation = {
    digest,
    profile: api.profile,
    openId,
    tool: DRAFT_TOOL_NAME,
  };

  // Steps 5–7.
  const guard = await runPlanGuards(ctx, planId, expectation, args.force === true);
  if (guard !== undefined) return { ok: false, error: guard };

  // Steps 8–9.
  const result = await dispatchWrite(ctx, {
    toolName: DRAFT_TOOL_NAME,
    mode: DRAFT_POST_MODE,
    source: INTENT,
    title: excerptText(args.title, args.description),
    digest,
    planId: planId ?? '',
    openId,
    send: photoSender(ctx, postInfo, DRAFT_POST_MODE, args),
  });

  const waited = await waitIfAsked(ctx, result, args.wait_for_completion === true);
  // § 5.3: the draft only becomes a post if the user opens the app, so that
  // instruction rides ahead of the poll hint on every success.
  if (waited.ok) waited.hints = [draftInboxHint(), ...(waited.hints ?? [])];
  return waited;
}

export const uploadPhotosDraftTool = defineTool<
  UploadPhotosDraftInput,
  UploadPhotosDraftData
>({
  name: DRAFT_TOOL_NAME,
  title: 'Upload a photo draft to the TikTok inbox',
  description: DRAFT_DESCRIPTION,
  package: 'publish-write',
  // NOT video.publish: the point of this tool is that it works on a draft-only
  // grant (§ 3.11).
  scopes: ['video.upload'],
  annotations: {
    readOnlyHint: false,
    // Nothing goes live, but the draft has left for the user's inbox, this
    // server cannot retract it, and it has spent pending-share quota (§ 3.11).
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: UPLOAD_PHOTOS_DRAFT_INPUT,
  handler: async (args, ctx): Promise<ToolResult<UploadPhotosDraftData>> => {
    if (args.plan_id !== undefined && !PLAN_ID_PATTERN.test(args.plan_id)) {
      return {
        ok: false,
        error: invalidParamsError(
          'plan_id: not a plan_id this tool issued — call without plan_id to get a fresh preview',
        ),
      };
    }

    const carouselError = checkCarousel(args, ctx.api.settings.verifiedUrlPrefixes);
    if (carouselError !== undefined) return { ok: false, error: carouselError };

    const decision = resolveWriteStep(args.plan_id, ctx.api.settings.writeMode);
    return decision.step === 'preview'
      ? await previewPhotosDraft(args, ctx)
      : await executePhotosDraft(args, ctx, decision.planId);
  },
});
