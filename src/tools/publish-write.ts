/**
 * The video half of the write surface: `tiktok_post_video` (TOOLS.md § 3.8) and
 * `tiktok_upload_video_draft` (§ 3.9).
 *
 * These are the tools that can create something a user cannot undo from here —
 * posts are neither editable nor deletable through the API, and a draft has
 * already left for the user's inbox — so both are built out of the ordering in
 * `publish-common`, which is where § 2.6.3 actually lives. What stays here is
 * only what the two tools do *differently*:
 *
 *   - `tiktok_post_video` runs the `creator_info` pre-flight, resolves a
 *     `post_info` from it, and posts `DIRECT_POST`.
 *   - `tiktok_upload_video_draft` sends no `post_info` at all and never calls
 *     `creator_info` — a `video.upload`-only grant may not carry the scope for
 *     it (§ 3.9) — so it has no `creator` block and no consent line.
 *
 * Both accept the same two byte sources, and that is the other thing this file
 * owns: `source: "url"` hands TikTok a verified URL to pull, `source: "file"`
 * uploads a local file under `TT_MEDIA_ROOT` in chunks. The chunked path is the
 * one place where a failure lands *between* "nothing happened" and "the post
 * exists": the init has already minted a `publish_id` by the time the first
 * chunk moves, which is why `dispatchWrite` is told about it the instant it
 * exists rather than when the upload finishes.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import {
  auditRestrictionsActive,
  getCreatorInfo,
  initDraftUpload,
  initVideoPost,
  PRIVACY_LEVELS,
  resolveVideoPostInfo,
  VIDEO_TITLE_MAX,
  type CreatorInfo,
  type PublishInitResult,
  type VideoPostInput,
  type VideoSource,
} from '../api/publish.js';
import {
  contentTypeFor,
  planChunks,
  resolveMediaFile,
  uploadFile,
  verifyMediaFile,
  type ChunkPlan,
  type MediaFile,
} from '../api/upload.js';
import { defineTool, toolInput, type ToolCtx } from '../mcp/define.js';
import { invalidParamsError, publishToolError } from '../mcp/errors.js';
import type { IntentSource } from '../mcp/journal.js';
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
  type ChunkPosition,
  type DraftPreview,
  type SourceBlock,
  type WritePreview,
} from './publish-common.js';
import { auditRestrictionsNote } from './publish.js';

const TOOL_NAME = 'tiktok_post_video';
const DRAFT_TOOL_NAME = 'tiktok_upload_video_draft';

/** The `action` line of a preview — what the user is being asked to approve. */
const ACTION = 'DIRECT_POST video';
const DRAFT_ACTION = 'MEDIA_UPLOAD video draft';

/** Upstream `post_mode`, part of the digested payload (§ 2.6.2). */
const POST_MODE = 'DIRECT_POST';
const DRAFT_POST_MODE = 'MEDIA_UPLOAD';

// ---------------------------------------------------------------------------
// Result shapes (TOOLS.md § 3.8, § 3.9)
// ---------------------------------------------------------------------------

export type PostVideoData = WritePreview | AppliedData;

export type UploadDraftData = DraftPreview | AppliedData;

// ---------------------------------------------------------------------------
// The byte source, shared by both tools (TOOLS.md § 3.8 input rows)
// ---------------------------------------------------------------------------

/** The two source fields, as both tools' schemas expose them. */
interface SourceArgs {
  source: 'file' | 'url';
  file_path?: string;
  video_url?: string;
}

/**
 * One resolution, four consumers: what the preview shows, what the init sends,
 * what the digest binds, and what the journal records.
 */
interface ResolvedSource {
  block: SourceBlock;
  init: VideoSource;
  /** The `source_info` half of the digested payload (§ 2.6.2). */
  digestSource: Record<string, unknown>;
  intent: IntentSource;
  /** `source: "file"` only. */
  file?: { media: MediaFile; plan: ChunkPlan };
}

const SOURCE_DESCRIPTION =
  'Where the video bytes come from. "file": a local file under the ' +
  'operator-configured TT_MEDIA_ROOT, uploaded in chunks. "url": TikTok pulls from an HTTPS ' +
  'URL that must match a verified prefix in TT_VERIFIED_URL_PREFIXES.';

const FILE_PATH_DESCRIPTION =
  'Path to the video file (absolute, or relative to TT_MEDIA_ROOT). Must resolve inside ' +
  'TT_MEDIA_ROOT; checked at preview and re-checked at apply. Mutually exclusive with video_url.';

const VIDEO_URL_DESCRIPTION =
  'HTTPS URL of the video. Must start with one of the verified URL prefixes; TikTok refuses ' +
  'pulls from unverified domains. Must serve the bytes without redirects and stay reachable ' +
  'for about 1 hour. Mutually exclusive with file_path.';

/**
 * The cross-field half of the schema, checked imperatively.
 *
 * § 3.8 describes the input as discriminated on `source`, and it is — but not
 * as a `z.discriminatedUnion`: that produces a JSON Schema with no top-level
 * object shape, which both the strictness contract of `mcp/define` and the
 * models reading the manifest depend on. A flat strict object plus this
 * function is the same contract with a schema a client can actually render.
 */
function checkSourceArgs(
  args: SourceArgs,
  prefixes: readonly string[],
): ToolError | undefined {
  if (args.source === 'url') {
    if (args.file_path !== undefined) {
      return invalidParamsError(
        'file_path: must not be set when source is "url" — the two are mutually exclusive',
      );
    }
    if (args.video_url === undefined) {
      return invalidParamsError('video_url: required when source is "url"');
    }
    return checkMediaUrl(args.video_url, 'video_url', prefixes);
  }
  if (args.video_url !== undefined) {
    return invalidParamsError(
      'video_url: must not be set when source is "file" — the two are mutually exclusive',
    );
  }
  if (args.file_path === undefined) {
    return invalidParamsError('file_path: required when source is "file"');
  }
  return undefined;
}

/**
 * Resolve the source the same way in the preview and in the apply.
 *
 * For a file this stats the disk, confines the path to `TT_MEDIA_ROOT` and
 * computes the chunk plan — all before the rate token is spent on the preview
 * side, and before the digest on the apply side, because the resolved path and
 * size are part of what the user approved. A file swapped between the two calls
 * therefore surfaces as `plan_mismatch` rather than as a silent upload of
 * different bytes (CC-D3).
 */
async function resolveSource(
  ctx: ToolCtx,
  args: SourceArgs,
): Promise<{ ok: true; value: ResolvedSource } | { ok: false; error: ToolError }> {
  if (args.source === 'url') {
    const url = args.video_url ?? '';
    return {
      ok: true,
      value: {
        block: { type: 'url', url },
        init: { source: 'PULL_FROM_URL', videoUrl: url },
        digestSource: { source: 'PULL_FROM_URL', video_url: url },
        intent: 'PULL_FROM_URL',
      },
    };
  }

  let media: MediaFile;
  let plan: ChunkPlan;
  try {
    media = await resolveMediaFile(args.file_path ?? '', ctx.api.settings.mediaRoot);
    plan = planChunks(media.size);
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  return {
    ok: true,
    value: {
      block: {
        type: 'file',
        resolved_path: media.path,
        file_size: media.size,
        chunk_summary: {
          file_size: media.size,
          chunk_size: plan.chunkSize,
          chunks: plan.totalChunkCount,
        },
      },
      init: {
        source: 'FILE_UPLOAD',
        videoSize: media.size,
        chunkSize: plan.chunkSize,
        totalChunkCount: plan.totalChunkCount,
      },
      // `resolved_path` is not sent upstream, and it is digested anyway: the
      // user approved *this* file, and two different files of identical size
      // would otherwise share a digest and be interchangeable under one plan.
      digestSource: {
        source: 'FILE_UPLOAD',
        video_size: media.size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
        resolved_path: media.path,
      },
      intent: 'FILE_UPLOAD',
      file: { media, plan },
    },
  };
}

/**
 * The upstream half of a dispatch: init, then — for a file — move the bytes.
 *
 * `report` fires between the two, and everything about how a failure is
 * classified hangs off that call: after it, a `publish_id` exists upstream no
 * matter what the chunks do (CC-B4). The re-stat immediately before the first
 * PUT closes the last window, where a file could change between the digest and
 * the transfer.
 */
function videoSender(
  ctx: ToolCtx,
  src: ResolvedSource,
  init: (source: VideoSource) => Promise<PublishInitResult>,
): {
  send: (report: (publishId: string) => void) => Promise<string>;
  position?: () => ChunkPosition;
} {
  const file = src.file;
  if (file === undefined) {
    return {
      send: async (report) => {
        const started = await init(src.init);
        report(started.publishId);
        return started.publishId;
      },
    };
  }

  let done = 0;
  return {
    // `done` counts accepted chunks, so the one that failed is the next one.
    position: () => ({ chunk: done + 1, total: file.plan.totalChunkCount }),
    send: async (report) => {
      const started = await init(src.init);
      report(started.publishId);
      const media = await verifyMediaFile(file.media, ctx.api.settings.mediaRoot);
      await uploadFile(ctx.api, {
        filePath: media.path,
        plan: file.plan,
        uploadUrl: started.uploadUrl ?? '',
        contentType: contentTypeFor(media.path),
        ...signalOpt(ctx),
        onProgress: (chunkIndex, totalChunks) => {
          done = chunkIndex + 1;
          ctx.progress?.(done, totalChunks);
        },
      });
      return started.publishId;
    },
  };
}

// ---------------------------------------------------------------------------
// Input (TOOLS.md § 3.8)
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Post a video DIRECTLY to the authenticated account's TikTok profile — it goes live without " +
  'further user action once TikTok finishes processing. Requires scope video.publish. Use when ' +
  'the user says "post/publish this video". NOT for "send it to my drafts" — use ' +
  'tiktok_upload_video_draft for that. Posts cannot be edited or deleted through this server; ' +
  'removal requires the TikTok app.\n\n' +
  'Two-step contract: calling WITHOUT plan_id validates everything (file or URL, title, ' +
  'toggles, live creator settings) and returns a preview plus a single-use plan_id valid for ' +
  '10 minutes — no post is created. Show the preview to the user, including the consent line ' +
  'it contains. After the user explicitly approves, call again with identical arguments plus ' +
  'plan_id to execute. privacy_level has NO default: the user must pick one of the options ' +
  'listed in the preview (unaudited apps: SELF_ONLY only — the post will be private).\n\n' +
  'Rate limits: 6 posts/min (enforced locally) and roughly 15 posts/24 h per account shared ' +
  "across ALL apps using TikTok's API. On success the call returns publish_id immediately; " +
  'processing continues asynchronously — follow the returned poll hint to ' +
  'tiktok_get_publish_status.';

const POST_VIDEO_INPUT = toolInput({
  source: z.enum(['file', 'url']).describe(SOURCE_DESCRIPTION),
  file_path: z.string().min(1).optional().describe(FILE_PATH_DESCRIPTION),
  video_url: z.string().min(1).optional().describe(VIDEO_URL_DESCRIPTION),
  title: z
    .string()
    .max(VIDEO_TITLE_MAX)
    .optional()
    .describe(
      'Caption. Up to 2200 UTF-16 code units (emoji count as 2, the way TikTok counts). ' +
        '#hashtags and @mentions are parsed by TikTok. Omit for an untitled post.',
    ),
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
    .describe('true disables comments on this post. Leave false unless the user asks.'),
  disable_duet: z
    .boolean()
    .optional()
    .describe(
      "true disables duets. If the creator's account already disables duets, the server forces " +
        'true and flags it in the preview — a false here cannot override it.',
    ),
  disable_stitch: z
    .boolean()
    .optional()
    .describe(
      "true disables stitch. Forced true when the creator's account disables stitch, " +
        'flagged in the preview.',
    ),
  video_cover_timestamp_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Video frame to use as the cover, in milliseconds from the start. Omit for TikTok's " +
        'default.',
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

type PostVideoInput = z.infer<typeof POST_VIDEO_INPUT>;

// ---------------------------------------------------------------------------
// Payload assembly (§ 2.6.2)
// ---------------------------------------------------------------------------

/** Tool arguments → the `api/publish` input shape. Snake case stops here. */
function toVideoPostInput(args: PostVideoInput, privacyLevel: string): VideoPostInput {
  return {
    ...(args.title === undefined ? {} : { title: args.title }),
    privacyLevel,
    ...(args.disable_comment === undefined
      ? {}
      : { disableComment: args.disable_comment }),
    ...(args.disable_duet === undefined ? {} : { disableDuet: args.disable_duet }),
    ...(args.disable_stitch === undefined ? {} : { disableStitch: args.disable_stitch }),
    ...(args.video_cover_timestamp_ms === undefined
      ? {}
      : { videoCoverTimestampMs: args.video_cover_timestamp_ms }),
    ...(args.brand_content_toggle === undefined
      ? {}
      : { brandContentToggle: args.brand_content_toggle }),
    ...(args.brand_organic_toggle === undefined
      ? {}
      : { brandOrganicToggle: args.brand_organic_toggle }),
    ...(args.is_aigc === undefined ? {} : { isAigc: args.is_aigc }),
  };
}

/**
 * What gets digested (§ 2.6.2): the fully resolved upstream payload, control
 * fields excluded by construction. Preview and apply build it through this one
 * function, so the two digests can only differ if the payload really did.
 */
function digestedPayload(
  postInfo: Record<string, unknown>,
  src: ResolvedSource,
): Record<string, unknown> {
  return {
    post_info: postInfo,
    post_mode: POST_MODE,
    source_info: src.digestSource,
  };
}

/** The draft's payload carries no `post_info` — the inbox init accepts none. */
function draftDigestedPayload(src: ResolvedSource): Record<string, unknown> {
  return { post_mode: DRAFT_POST_MODE, source_info: src.digestSource };
}

// ---------------------------------------------------------------------------
// tiktok_post_video — preview (TOOLS.md § 2.6.1)
// ---------------------------------------------------------------------------

async function previewPost(
  args: PostVideoInput,
  ctx: ToolCtx,
): Promise<ToolResult<PostVideoData>> {
  const { api } = ctx;

  const source = await resolveSource(ctx, args);
  if (!source.ok) return { ok: false, error: source.error };

  // A preview is a read: it makes no publish, init or upload request, so it
  // never spends a publish token and never fails on an empty bucket (§ 2.6.1).
  // The bucket state is *reported* instead, so the model can see whether the
  // apply it is about to ask approval for will be accepted.
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

  // § 2.6.1 step 4: no privacy level, no plan. The result still carries the
  // live options, because the whole point is to let the user choose from them.
  if (args.privacy_level === undefined) {
    const hints: Hint[] = [choosePrivacyHint(TOOL_NAME, creator.privacyLevelOptions)];
    if (restricted) hints.push(auditRestrictionsNote());
    return {
      ok: true,
      data: {
        mode: 'plan_incomplete',
        ...shared,
        payload: { source: source.value.block },
        missing: ['privacy_level'],
      },
      hints,
    };
  }

  let resolved;
  try {
    resolved = resolveVideoPostInfo(toVideoPostInput(args, args.privacy_level), creator, {
      isAigc: api.settings.defaultAigcLabel,
    });
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  const plan = mintPlan(
    ctx,
    TOOL_NAME,
    payloadDigest(digestedPayload(resolved.postInfo, source.value)),
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
      payload: { post_info: resolved.postInfo, source: source.value.block },
      derived: resolved.derived,
    },
    hints,
  };
}

// ---------------------------------------------------------------------------
// tiktok_post_video — apply (TOOLS.md § 2.6.3)
// ---------------------------------------------------------------------------

async function executePost(
  args: PostVideoInput,
  ctx: ToolCtx,
  planId: string | undefined,
): Promise<ToolResult<PostVideoData>> {
  const { api } = ctx;

  // Step 2 — before any network, and before the plan is touched, so a refusal
  // costs nothing but the round trip the caller did not make.
  const refused = takeWriteToken(ctx);
  if (refused !== undefined) return refused;

  // Step 3 — the same code path the preview ran, against live creator state and
  // a live re-stat of the file. A network failure here is provably
  // pre-dispatch: nothing was journaled and no init was sent, so it stays an
  // ordinary read error rather than becoming `network_unsent` (which promises a
  // journal entry exists).
  const source = await resolveSource(ctx, args);
  if (!source.ok) return { ok: false, error: source.error };

  let creator: CreatorInfo;
  let resolved;
  let openId: string;
  try {
    creator = await getCreatorInfo(api, signalOpt(ctx));
    openId = await resolveOpenId(ctx);
    // `privacy_level` is optional in the schema but mandatory to execute: the
    // preview that would have caught it returns `plan_incomplete` instead.
    if (args.privacy_level === undefined) {
      return {
        ok: false,
        error: invalidParamsError(
          'privacy_level: required to post — call this tool without plan_id to see the options ' +
            'the account currently allows',
        ),
      };
    }
    resolved = resolveVideoPostInfo(toVideoPostInput(args, args.privacy_level), creator, {
      isAigc: api.settings.defaultAigcLabel,
    });
  } catch (cause) {
    return { ok: false, error: publishToolError(cause) };
  }

  // Step 4.
  const digest = payloadDigest(digestedPayload(resolved.postInfo, source.value));
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
  const sender = videoSender(ctx, source.value, async (videoSource) =>
    initVideoPost(api, {
      postInfo: resolved.postInfo,
      source: videoSource,
      ...signalOpt(ctx),
    }),
  );
  const result = await dispatchWrite(ctx, {
    toolName: TOOL_NAME,
    mode: POST_MODE,
    source: source.value.intent,
    title: args.title ?? '',
    digest,
    planId: planId ?? '',
    openId,
    ...sender,
  });

  return await waitIfAsked(ctx, result, args.wait_for_completion === true);
}

// ---------------------------------------------------------------------------
// tiktok_post_video (§ 3.8)
// ---------------------------------------------------------------------------

export const postVideoTool = defineTool<PostVideoInput, PostVideoData>({
  name: TOOL_NAME,
  title: 'Post a video to TikTok',
  description: DESCRIPTION,
  package: 'publish-write',
  scopes: ['video.publish'],
  annotations: {
    readOnlyHint: false,
    // The post is public and cannot be edited or deleted through this server.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: POST_VIDEO_INPUT,
  handler: async (args, ctx): Promise<ToolResult<PostVideoData>> => {
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

    const sourceError = checkSourceArgs(args, ctx.api.settings.verifiedUrlPrefixes);
    if (sourceError !== undefined) return { ok: false, error: sourceError };

    // `deny` never reaches here — the package is not registered at all.
    const decision = resolveWriteStep(args.plan_id, ctx.api.settings.writeMode);
    return decision.step === 'preview'
      ? await previewPost(args, ctx)
      : await executePost(args, ctx, decision.planId);
  },
});

// ---------------------------------------------------------------------------
// tiktok_upload_video_draft (TOOLS.md § 3.9)
// ---------------------------------------------------------------------------

const DRAFT_DESCRIPTION =
  "Upload a video to the user's TikTok INBOX as a draft — the user must open the TikTok app " +
  'notification, edit, and publish it themselves; nothing goes live from this call. Requires ' +
  'scope video.upload (NOT video.publish — this tool works on draft-only authorizations). Use ' +
  'when the user says "send it to my drafts / I\'ll finish it in the app". NOT for direct ' +
  'publishing — use tiktok_post_video. Drafts carry no caption, privacy, or toggles — the user ' +
  'sets those in the app — so this tool takes only the video source. Same preview/plan_id ' +
  'contract as tiktok_post_video. TikTok allows at most 5 unpublished API drafts per account ' +
  'per 24 h; unopened drafts expire on their own. After success, tell the user to open the ' +
  'TikTok app inbox notification to finish the post.';

const UPLOAD_DRAFT_INPUT = toolInput({
  source: z.enum(['file', 'url']).describe(SOURCE_DESCRIPTION),
  file_path: z.string().min(1).optional().describe(FILE_PATH_DESCRIPTION),
  video_url: z.string().min(1).optional().describe(VIDEO_URL_DESCRIPTION),
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

type UploadDraftInput = z.infer<typeof UPLOAD_DRAFT_INPUT>;

/**
 * No `plan_incomplete` branch exists here, and cannot: that mode is § 2.6.1's
 * answer to a missing `privacy_level`, and this tool has no field a user must
 * still choose. A draft preview is either a plan or an error.
 */
async function previewDraft(
  args: UploadDraftInput,
  ctx: ToolCtx,
): Promise<ToolResult<UploadDraftData>> {
  const { api } = ctx;

  const source = await resolveSource(ctx, args);
  if (!source.ok) return { ok: false, error: source.error };

  const openId = await resolveOpenId(ctx);
  const plan = mintPlan(
    ctx,
    DRAFT_TOOL_NAME,
    payloadDigest(draftDigestedPayload(source.value)),
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
      payload: { source: source.value.block },
      meta: { rate_bucket: peekPublishBucket(api.profile, api.clock) },
    },
    hints: [plan.hint],
  };
}

async function executeDraft(
  args: UploadDraftInput,
  ctx: ToolCtx,
  planId: string | undefined,
): Promise<ToolResult<UploadDraftData>> {
  const { api } = ctx;

  // Step 2.
  const refused = takeWriteToken(ctx);
  if (refused !== undefined) return refused;

  // Step 3 — for a draft the whole of "re-resolve" is the source: there is no
  // `creator_info` to re-read and no `post_info` to rebuild.
  const source = await resolveSource(ctx, args);
  if (!source.ok) return { ok: false, error: source.error };
  const openId = await resolveOpenId(ctx);

  // Step 4.
  const digest = payloadDigest(draftDigestedPayload(source.value));
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
  const sender = videoSender(ctx, source.value, async (videoSource) =>
    initDraftUpload(api, { source: videoSource, ...signalOpt(ctx) }),
  );
  const result = await dispatchWrite(ctx, {
    toolName: DRAFT_TOOL_NAME,
    mode: DRAFT_POST_MODE,
    source: source.value.intent,
    title: '',
    digest,
    planId: planId ?? '',
    openId,
    ...sender,
  });

  const waited = await waitIfAsked(ctx, result, args.wait_for_completion === true);
  // § 5.3: the draft only becomes a post if the user opens the app, so that
  // instruction rides on every success — ahead of the poll hint, which is the
  // less useful of the two once the bytes are upstream.
  if (waited.ok) waited.hints = [draftInboxHint(), ...(waited.hints ?? [])];
  return waited;
}

export const uploadVideoDraftTool = defineTool<UploadDraftInput, UploadDraftData>({
  name: DRAFT_TOOL_NAME,
  title: 'Upload a video draft to the TikTok inbox',
  description: DRAFT_DESCRIPTION,
  package: 'publish-write',
  // NOT video.publish: the whole point of this tool is that it works on a
  // draft-only grant (§ 3.9).
  scopes: ['video.upload'],
  annotations: {
    readOnlyHint: false,
    // Nothing goes live, but the draft has left for the user's inbox and this
    // server cannot retract it — and it has spent pending-share quota (§ 3.9).
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: UPLOAD_DRAFT_INPUT,
  handler: async (args, ctx): Promise<ToolResult<UploadDraftData>> => {
    if (args.plan_id !== undefined && !PLAN_ID_PATTERN.test(args.plan_id)) {
      return {
        ok: false,
        error: invalidParamsError(
          'plan_id: not a plan_id this tool issued — call without plan_id to get a fresh preview',
        ),
      };
    }

    const sourceError = checkSourceArgs(args, ctx.api.settings.verifiedUrlPrefixes);
    if (sourceError !== undefined) return { ok: false, error: sourceError };

    const decision = resolveWriteStep(args.plan_id, ctx.api.settings.writeMode);
    return decision.step === 'preview'
      ? await previewDraft(args, ctx)
      : await executeDraft(args, ctx, decision.planId);
  },
});
