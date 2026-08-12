/**
 * The Content Posting API (CONTRACTS.md § `api/publish.ts`, TIKTOK-API.md
 * § 4.1–4.5): the `creator_info` pre-flight, the three init endpoints and
 * status polling — plus the local validation that must happen *before* any of
 * them is called.
 *
 * The validation is the point of this module. Every rule here rejects a post
 * that TikTok would reject anyway, or that its integration guidelines forbid
 * offering at all, and it does so with no network spent and nothing created
 * upstream: privacy must come from the live `creator_info` (CC-E1), branded
 * content cannot be private (CC-E2), captions are capped in UTF-16 code units
 * (CC-E3), creator-disabled interactions are forced on the payload rather than
 * argued with (CC-E4), and a carousel has 1–35 photos with a cover index inside
 * that range (CC-E9).
 *
 * The resolution helpers are deliberately pure and separate from the calls:
 * a preview digests the payload they return, and the apply step re-resolves it
 * and must reproduce the same bytes (TOOLS.md § 2.6.2). One resolver, one
 * answer — the plan contract has no meaning if the preview and the apply build
 * their payloads by different code paths.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only
 * (plus the shared api context).
 */

import { TikTokError } from '../core/errors.js';
import { registerSecret } from '../core/redact.js';
import { apiRequest, malformedPayload, type ApiContext } from './context.js';

// ---------------------------------------------------------------------------
// Vocabularies and limits (TIKTOK-API.md § 4.1–4.4, TOOLS.md Appendix B)
// ---------------------------------------------------------------------------

/**
 * Every privacy level TikTok documents. This is the vocabulary the tool layer
 * advertises through `z.enum`; it is **not** a list of what any given account
 * may use — that comes from `creator_info.privacy_level_options` on every
 * single call (CC-E1), and there is never a default (TOOLS.md § 2.6.1).
 */
export const PRIVACY_LEVELS = Object.freeze([
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const);

export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

/** Caption caps, in UTF-16 code units — TikTok's own unit (CC-E3). */
export const VIDEO_TITLE_MAX = 2200;
export const PHOTO_TITLE_MAX = 90;
export const PHOTO_DESCRIPTION_MAX = 4000;

/** Carousel bounds (TIKTOK-API.md § 4.4, CC-E9). */
export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 35;

/** The status values TikTok documents (TIKTOK-API.md § 4.5). */
export const PUBLISH_STATUSES = Object.freeze([
  'PROCESSING_DOWNLOAD',
  'PROCESSING_UPLOAD',
  'SEND_TO_USER_INBOX',
  'PUBLISH_COMPLETE',
  'FAILED',
] as const);

export type PublishStatusValue = (typeof PUBLISH_STATUSES)[number];

/** States no further poll can change. `SEND_TO_USER_INBOX` is the draft flow's success. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  'SEND_TO_USER_INBOX',
  'PUBLISH_COMPLETE',
  'FAILED',
]);

/**
 * Whether polling may stop. Unknown values are treated as **non**-terminal: a
 * status TikTok adds later is more likely a new processing stage than a new
 * outcome, and stopping early on it would report a post as finished when it is
 * still in flight.
 */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function invalid(detail: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'invalid_params',
    message: `Invalid arguments: ${detail}. Fix the arguments and call again. No request was sent to TikTok.`,
  });
}

/** CC-E1. Non-retryable: the same arguments will fail identically. */
function privacyLevelUnavailable(value: string, options: readonly string[]): TikTokError {
  const available = options.length === 0 ? '(none)' : options.join(', ');
  return new TikTokError({
    kind: 'validation',
    code: 'privacy_level_unavailable',
    message:
      `privacy_level '${value}' is not available for this account right now. ` +
      `Available options: ${available}. Re-preview with one of these. ` +
      `(Unaudited apps allow only SELF_ONLY.)`,
  });
}

/**
 * CC-E2. Rejected locally with TikTok's own tooltip meaning — the combination
 * has no documented API error code (probe P-6), and the content-sharing
 * guidelines make refusing it an audit requirement rather than a preference.
 */
function brandedContentPrivacyConflict(): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'branded_content_privacy_conflict',
    message:
      `brand_content_toggle: true cannot be combined with privacy_level SELF_ONLY — ` +
      `TikTok rejects branded content on private-visibility posts. While this app is ` +
      `unaudited, only SELF_ONLY is available, so branded-content posting is not possible ` +
      `at all. Either drop the brand toggle or wait until the app passes TikTok's audit.`,
  });
}

// ---------------------------------------------------------------------------
// creator_info
// ---------------------------------------------------------------------------

/** The creator's current posting capabilities (TIKTOK-API.md § 4.1). */
export interface CreatorInfo {
  nickname: string;
  username: string;
  /** Documented TTL of 2 h — never cached across a preview (TIKTOK-API.md § 4.1). */
  avatarUrl?: string;
  /** The only source of truth for what `privacy_level` may be (CC-E1). */
  privacyLevelOptions: readonly string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec?: number;
}

interface CreatorInfoPayload {
  creator_avatar_url?: unknown;
  creator_username?: unknown;
  creator_nickname?: unknown;
  privacy_level_options?: unknown;
  comment_disabled?: unknown;
  duet_disabled?: unknown;
  stitch_disabled?: unknown;
  max_video_post_duration_sec?: unknown;
}

const CREATOR_INFO_PATH = '/v2/post/publish/creator_info/query/';

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `privacy_level_options` is the one member a shape change must not be
 * survivable on: everything else here is display, but silently reading this as
 * "no options" would turn every post into a `privacy_level_unavailable`
 * refusal, and reading it as "anything goes" would let the server offer a
 * visibility the account does not have.
 */
function readPrivacyOptions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((option) => typeof option !== 'string')) {
    throw malformedPayload(CREATOR_INFO_PATH, 'privacy_level_options string array');
  }
  return value as readonly string[];
}

/**
 * The creator's live posting capabilities.
 *
 * Mandatory before every direct post and re-queried when a plan is rendered —
 * caching it across the plan TTL is exactly the drift CC-E1 exists to catch.
 * The draft/inbox tools never call it: they send no `post_info`, and a
 * `video.upload`-only grant may not even carry the scope for this endpoint.
 */
export async function getCreatorInfo(
  ctx: ApiContext,
  opts: { signal?: AbortSignal } = {},
): Promise<CreatorInfo> {
  const payload = await apiRequest<CreatorInfoPayload>(ctx, {
    method: 'POST',
    path: CREATOR_INFO_PATH,
    // No `fields` (this is the Content Posting API) but an explicit empty JSON
    // body, so the request carries the `content-type` TikTok documents for it.
    body: {},
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  const duration = payload.max_video_post_duration_sec;
  return {
    nickname: readText(payload.creator_nickname),
    username: readText(payload.creator_username),
    ...(typeof payload.creator_avatar_url === 'string'
      ? { avatarUrl: payload.creator_avatar_url }
      : {}),
    privacyLevelOptions: readPrivacyOptions(payload.privacy_level_options),
    // Absent reads as "not disabled": these are display-and-force inputs, and a
    // missing switch must not silently forbid an interaction the creator allows.
    commentDisabled: payload.comment_disabled === true,
    duetDisabled: payload.duet_disabled === true,
    stitchDisabled: payload.stitch_disabled === true,
    ...(typeof duration === 'number' && Number.isFinite(duration)
      ? { maxVideoPostDurationSec: duration }
      : {}),
  };
}

/**
 * `audit_restrictions_active` (TOOLS.md § 3.5): true exactly when `SELF_ONLY`
 * is the only option, which is what an unaudited client sees. Every post from
 * such an app is visible to the account owner alone, and saying so up front is
 * cheaper than a confused user asking why nobody can see their video.
 */
export function auditRestrictionsActive(creator: CreatorInfo): boolean {
  const [only] = creator.privacyLevelOptions;
  return creator.privacyLevelOptions.length === 1 && only === 'SELF_ONLY';
}

// ---------------------------------------------------------------------------
// Payload resolution (pure)
// ---------------------------------------------------------------------------

/**
 * A value the **server** chose, not the caller — an env-driven default or a
 * creator restriction the payload was forced to obey. Schema defaults the model
 * can read off the tool description are not listed: `derived` exists to surprise
 * nobody, and padding it with `brand_content_toggle: false` buries the entries
 * that matter (TOOLS.md § 2.6.1).
 */
export interface DerivedField {
  field: string;
  value: unknown;
  reason: string;
}

/** The exact upstream `post_info` object plus the story of how it got that way. */
export interface ResolvedPostInfo {
  postInfo: Record<string, unknown>;
  derived: readonly DerivedField[];
}

/** Server-side defaults the caller did not state. */
export interface PostDefaults {
  /** `TT_DEFAULT_AIGC_LABEL` — ships as `true` (TOOLS.md § 3.8). */
  isAigc: boolean;
}

export interface VideoPostInput {
  title?: string;
  /** Required here: a missing privacy level is `plan_incomplete`, decided by the tool. */
  privacyLevel: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  isAigc?: boolean;
}

export interface PhotoPostInput {
  title?: string;
  description?: string;
  privacyLevel: string;
  disableComment?: boolean;
  autoAddMusic?: boolean;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
  isAigc?: boolean;
}

/**
 * CC-E3: the cap is in UTF-16 code units, which is precisely what
 * `String.prototype.length` counts — an emoji costs 2 and a combining sequence
 * costs one per unit, matching how TikTok measures. Counting code points here
 * would let a caption that upstream rejects through.
 */
function assertTextLimit(field: string, text: string, max: number): void {
  if (text.length > max) {
    throw invalid(
      `${field}: ${String(text.length)} UTF-16 code units exceeds TikTok's maximum of ` +
        `${String(max)} for this field — shorten the text (note that emoji count as 2)`,
    );
  }
}

/** CC-E1 then CC-E2: an unavailable level is reported before the conflict it may cause. */
function assertPrivacy(
  privacyLevel: string,
  brandContentToggle: boolean,
  creator: CreatorInfo,
): void {
  if (!creator.privacyLevelOptions.includes(privacyLevel)) {
    throw privacyLevelUnavailable(privacyLevel, creator.privacyLevelOptions);
  }
  if (brandContentToggle && privacyLevel === 'SELF_ONLY') {
    throw brandedContentPrivacyConflict();
  }
}

/**
 * CC-E4: a creator-level switch wins over the argument. TikTok would reject the
 * post (or silently ignore the flag), so the payload is forced and the override
 * is reported in `derived` — the preview must show what will actually be sent,
 * not what was asked for.
 */
function resolveInteractionFlag(
  field: string,
  requested: boolean,
  creatorDisabled: boolean,
  noun: string,
  derived: DerivedField[],
): boolean {
  if (!creatorDisabled || requested) return requested;
  derived.push({
    field,
    value: true,
    reason: `the creator has ${noun} disabled on their account, so this cannot be enabled for the post`,
  });
  return true;
}

function resolveAigc(
  input: { isAigc?: boolean },
  defaults: PostDefaults,
  derived: DerivedField[],
): boolean {
  if (input.isAigc !== undefined) return input.isAigc;
  derived.push({
    field: 'is_aigc',
    value: defaults.isAigc,
    reason: 'defaulted from the server setting TT_DEFAULT_AIGC_LABEL',
  });
  return defaults.isAigc;
}

/** Absent and empty are the same thing — "no caption" — and are sent as absent. */
function captionOrAbsent(text: string | undefined): string | undefined {
  return text === undefined || text === '' ? undefined : text;
}

/**
 * The `post_info` of a direct video post (TIKTOK-API.md § 4.2), fully resolved.
 *
 * Pure: given the same input, creator and defaults it returns the same object
 * every time, which is what lets the apply step re-derive a preview's digest.
 */
export function resolveVideoPostInfo(
  input: VideoPostInput,
  creator: CreatorInfo,
  defaults: PostDefaults,
): ResolvedPostInfo {
  const title = captionOrAbsent(input.title);
  if (title !== undefined) assertTextLimit('title', title, VIDEO_TITLE_MAX);

  const cover = input.videoCoverTimestampMs;
  if (cover !== undefined && (!Number.isInteger(cover) || cover < 0)) {
    throw invalid(
      `video_cover_timestamp_ms: must be a non-negative whole number of milliseconds, got ${String(cover)}`,
    );
  }

  const brandContentToggle = input.brandContentToggle ?? false;
  assertPrivacy(input.privacyLevel, brandContentToggle, creator);

  const derived: DerivedField[] = [];
  const postInfo: Record<string, unknown> = {
    ...(title === undefined ? {} : { title }),
    privacy_level: input.privacyLevel,
    disable_comment: resolveInteractionFlag(
      'disable_comment',
      input.disableComment ?? false,
      creator.commentDisabled,
      'comments',
      derived,
    ),
    disable_duet: resolveInteractionFlag(
      'disable_duet',
      input.disableDuet ?? false,
      creator.duetDisabled,
      'duets',
      derived,
    ),
    disable_stitch: resolveInteractionFlag(
      'disable_stitch',
      input.disableStitch ?? false,
      creator.stitchDisabled,
      'stitches',
      derived,
    ),
    ...(cover === undefined ? {} : { video_cover_timestamp_ms: cover }),
    brand_content_toggle: brandContentToggle,
    brand_organic_toggle: input.brandOrganicToggle ?? false,
    is_aigc: resolveAigc(input, defaults, derived),
  };

  return { postInfo, derived };
}

/**
 * The `post_info` of a photo carousel (TIKTOK-API.md § 4.4), fully resolved.
 *
 * Photos carry no duet/stitch switches — the fields do not exist upstream, so
 * the creator's duet/stitch restrictions have nothing to force here. Comments
 * still do (CC-E4).
 */
export function resolvePhotoPostInfo(
  input: PhotoPostInput,
  creator: CreatorInfo,
  defaults: PostDefaults,
): ResolvedPostInfo {
  const title = captionOrAbsent(input.title);
  if (title !== undefined) assertTextLimit('title', title, PHOTO_TITLE_MAX);
  const description = captionOrAbsent(input.description);
  if (description !== undefined) {
    assertTextLimit('description', description, PHOTO_DESCRIPTION_MAX);
  }

  const brandContentToggle = input.brandContentToggle ?? false;
  assertPrivacy(input.privacyLevel, brandContentToggle, creator);

  const derived: DerivedField[] = [];
  const postInfo: Record<string, unknown> = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    privacy_level: input.privacyLevel,
    disable_comment: resolveInteractionFlag(
      'disable_comment',
      input.disableComment ?? false,
      creator.commentDisabled,
      'comments',
      derived,
    ),
    auto_add_music: input.autoAddMusic ?? false,
    brand_content_toggle: brandContentToggle,
    brand_organic_toggle: input.brandOrganicToggle ?? false,
    is_aigc: resolveAigc(input, defaults, derived),
  };

  return { postInfo, derived };
}

/**
 * The `post_info` of a photo carousel sent to the inbox as a draft
 * (TOOLS.md § 3.11).
 *
 * A draft carries no privacy level and no toggles — the user picks those in the
 * app — so this is not {@link resolvePhotoPostInfo} with optional arguments: it
 * is a different, smaller payload that must not grow defaults. What it does
 * share is the text limits, which is exactly why it lives here rather than in
 * the tool layer: `title` is 90 units for photos, not 2200, and a second copy
 * of that rule is a second place for it to drift.
 *
 * Takes no `CreatorInfo`: the draft tools hold `video.upload` only and never
 * run the `creator_info` pre-flight.
 */
export function resolvePhotoDraftPostInfo(input: {
  title?: string;
  description?: string;
}): ResolvedPostInfo {
  const title = captionOrAbsent(input.title);
  if (title !== undefined) assertTextLimit('title', title, PHOTO_TITLE_MAX);
  const description = captionOrAbsent(input.description);
  if (description !== undefined) {
    assertTextLimit('description', description, PHOTO_DESCRIPTION_MAX);
  }

  return {
    postInfo: {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    },
    derived: [],
  };
}

/**
 * CC-E9: a carousel needs at least one photo, at most 35, and a cover index
 * that points at one of them. All three are rejected before the init — an init
 * that fails upstream still burns a publish attempt and a rate-bucket token.
 */
export function validatePhotoSource(
  photoUrls: readonly string[],
  photoCoverIndex: number,
): void {
  if (photoUrls.length < MIN_PHOTOS) {
    throw invalid('photo_urls: at least one photo URL is required');
  }
  if (photoUrls.length > MAX_PHOTOS) {
    throw invalid(
      `photo_urls: ${String(photoUrls.length)} photos were given but TikTok accepts at most ` +
        `${String(MAX_PHOTOS)} per carousel — remove the extras and preview again`,
    );
  }
  if (
    !Number.isInteger(photoCoverIndex) ||
    photoCoverIndex < 0 ||
    photoCoverIndex >= photoUrls.length
  ) {
    throw invalid(
      `photo_cover_index: must be a whole number between 0 and ${String(photoUrls.length - 1)} ` +
        `(the index of one of the ${String(photoUrls.length)} photos), got ${String(photoCoverIndex)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Init calls
// ---------------------------------------------------------------------------

/**
 * How TikTok gets the video: it downloads it from a verified URL, or the client
 * PUTs the bytes to the `upload_url` the init returns.
 */
export type VideoSource =
  | { source: 'PULL_FROM_URL'; videoUrl: string }
  | {
      source: 'FILE_UPLOAD';
      videoSize: number;
      chunkSize: number;
      totalChunkCount: number;
    };

export interface VideoPostInit {
  /** From {@link resolveVideoPostInfo} — never hand-built at the call site. */
  postInfo: Record<string, unknown>;
  source: VideoSource;
  signal?: AbortSignal;
}

export interface DraftUploadInit {
  source: VideoSource;
  signal?: AbortSignal;
}

export interface PhotoPostInit {
  /** From {@link resolvePhotoPostInfo}. */
  postInfo: Record<string, unknown>;
  postMode: 'DIRECT_POST' | 'MEDIA_UPLOAD';
  photoUrls: readonly string[];
  photoCoverIndex: number;
  signal?: AbortSignal;
}

/** What an init hands back: the handle to poll, and (FILE_UPLOAD only) where to PUT. */
export interface PublishInitResult {
  publishId: string;
  /** Valid for 1 hour. Carries the `upload_token` — a secret, never surfaced. */
  uploadUrl?: string;
}

interface InitPayload {
  publish_id?: unknown;
  upload_url?: unknown;
}

function sourceInfoBody(source: VideoSource): Record<string, unknown> {
  if (source.source === 'PULL_FROM_URL') {
    return { source: 'PULL_FROM_URL', video_url: source.videoUrl };
  }
  return {
    source: 'FILE_UPLOAD',
    video_size: source.videoSize,
    chunk_size: source.chunkSize,
    total_chunk_count: source.totalChunkCount,
  };
}

function readPublishId(payload: InitPayload, endpoint: string): string {
  const id = payload.publish_id;
  if (typeof id !== 'string' || id === '') {
    throw malformedPayload(endpoint, 'publish_id string');
  }
  return id;
}

/**
 * The `upload_token` in an `upload_url` query string *is* the upload session's
 * bearer credential (SECURITY.md § Egress control), so it is registered as a
 * secret the moment it exists — before the URL can reach a log line, an error
 * message or a journal entry.
 */
function readUploadUrl(payload: InitPayload): string | undefined {
  const url = payload.upload_url;
  if (typeof url !== 'string' || url === '') return undefined;
  try {
    const token = new URL(url).searchParams.get('upload_token');
    if (token !== null) registerSecret(token);
  } catch {
    // Not a parseable URL; `core/http` refuses to PUT to it later. Nothing to register.
  }
  return url;
}

/**
 * A `FILE_UPLOAD` init that answers without an `upload_url` leaves the caller
 * holding a `publish_id` it can never feed bytes to, so it is refused here
 * rather than a directory later: the tool layer's classification then reads the
 * failure correctly — an attempt exists upstream, and nothing was uploaded.
 */
function initResult(
  payload: InitPayload,
  endpoint: string,
  requireUploadUrl: boolean,
): PublishInitResult {
  const uploadUrl = readUploadUrl(payload);
  if (requireUploadUrl && uploadUrl === undefined) {
    throw malformedPayload(endpoint, 'upload_url string for a FILE_UPLOAD init');
  }
  return {
    publishId: readPublishId(payload, endpoint),
    ...(uploadUrl === undefined ? {} : { uploadUrl }),
  };
}

const VIDEO_INIT_PATH = '/v2/post/publish/video/init/';
const INBOX_INIT_PATH = '/v2/post/publish/inbox/video/init/';
const CONTENT_INIT_PATH = '/v2/post/publish/content/init/';
const STATUS_PATH = '/v2/post/publish/status/fetch/';

/**
 * Starts a direct video post — the call that can create a post.
 *
 * `retryClass: 'init'` is load-bearing, not a tuning knob: an init is attempted
 * exactly once, an upstream 429 on it is terminal, and the 401-refresh-replay
 * is off. Two byte-identical inits are assumed to create two posts until probe
 * P-12 says otherwise (TIKTOK-API.md § 4.2).
 */
export async function initVideoPost(
  ctx: ApiContext,
  req: VideoPostInit,
): Promise<PublishInitResult> {
  const payload = await apiRequest<InitPayload>(ctx, {
    method: 'POST',
    path: VIDEO_INIT_PATH,
    retryClass: 'init',
    body: { post_info: req.postInfo, source_info: sourceInfoBody(req.source) },
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  return initResult(payload, VIDEO_INIT_PATH, req.source.source === 'FILE_UPLOAD');
}

/**
 * Starts an inbox draft upload (TIKTOK-API.md § 4.3). No `post_info` at all —
 * the user writes the caption and picks the privacy level inside the app — so
 * no `creator_info` pre-flight and none of the validation above applies.
 */
export async function initDraftUpload(
  ctx: ApiContext,
  req: DraftUploadInit,
): Promise<PublishInitResult> {
  const payload = await apiRequest<InitPayload>(ctx, {
    method: 'POST',
    path: INBOX_INIT_PATH,
    retryClass: 'init',
    body: { source_info: sourceInfoBody(req.source) },
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  return initResult(payload, INBOX_INIT_PATH, req.source.source === 'FILE_UPLOAD');
}

/**
 * Starts a photo carousel (TIKTOK-API.md § 4.4). Photos are PULL_FROM_URL only
 * — there is no FILE_UPLOAD path for them upstream — so this init never returns
 * an `upload_url` and local photo files are impossible in v1.
 *
 * The CC-E9 bounds are re-checked here rather than trusted from the caller: the
 * validation is what stands between a bad argument and a burnt publish attempt,
 * and it must hold on the apply path too.
 */
export async function initPhotoPost(
  ctx: ApiContext,
  req: PhotoPostInit,
): Promise<{ publishId: string }> {
  validatePhotoSource(req.photoUrls, req.photoCoverIndex);

  const payload = await apiRequest<InitPayload>(ctx, {
    method: 'POST',
    path: CONTENT_INIT_PATH,
    retryClass: 'init',
    body: {
      media_type: 'PHOTO',
      post_mode: req.postMode,
      post_info: req.postInfo,
      source_info: {
        source: 'PULL_FROM_URL',
        photo_images: [...req.photoUrls],
        photo_cover_index: req.photoCoverIndex,
      },
    },
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  return { publishId: readPublishId(payload, CONTENT_INIT_PATH) };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface PublishStatus {
  /** Typed as a plain string: an unrecognized status is reported, never rejected. */
  status: string;
  /** Present on `FAILED`. Mapped to recovery advice by the tool layer (CC-E5). */
  failReason?: string;
  /** Only for posts published for public viewership. */
  publicPostIds?: readonly string[];
  uploadedBytes?: number;
  downloadedBytes?: number;
}

interface StatusPayload {
  status?: unknown;
  fail_reason?: unknown;
  /** TikTok's own misspelling — copying it exactly is binding (TIKTOK-API.md § 4.5). */
  publicaly_available_post_id?: unknown;
  /** Accepted too, in case upstream ever fixes the spelling. */
  publicly_available_post_id?: unknown;
  uploaded_bytes?: unknown;
  downloaded_bytes?: unknown;
}

/**
 * Post ids arrive as JSON numbers (int64) and are carried as strings, because
 * every consumer — the journal, the result formatter, the share URL — wants
 * text. Ids above 2^53 have already lost precision in `JSON.parse` before this
 * runs; nothing at this layer can recover it, and re-serializing a float would
 * only hide that. Non-numeric entries are echoed as given.
 */
function readPostIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((id) => (typeof id === 'string' ? id : String(id)));
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Polls a publish attempt (TIKTOK-API.md § 4.5).
 *
 * A `read`-class call: it creates nothing, so retrying it is free, and the
 * journal — not this endpoint — is the system of record once a terminal status
 * has been observed (the retention window is probe P-1).
 */
export async function getPublishStatus(
  ctx: ApiContext,
  publishId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PublishStatus> {
  if (publishId.trim() === '') throw invalid('publish_id: must not be empty');

  const payload = await apiRequest<StatusPayload>(ctx, {
    method: 'POST',
    path: STATUS_PATH,
    body: { publish_id: publishId },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  if (typeof payload.status !== 'string' || payload.status === '') {
    throw malformedPayload(STATUS_PATH, 'status string');
  }

  const postIds =
    readPostIds(payload.publicaly_available_post_id) ??
    readPostIds(payload.publicly_available_post_id);
  const uploadedBytes = readCount(payload.uploaded_bytes);
  const downloadedBytes = readCount(payload.downloaded_bytes);

  return {
    status: payload.status,
    ...(typeof payload.fail_reason === 'string' && payload.fail_reason !== ''
      ? { failReason: payload.fail_reason }
      : {}),
    ...(postIds === undefined ? {} : { publicPostIds: postIds }),
    ...(uploadedBytes === undefined ? {} : { uploadedBytes }),
    ...(downloadedBytes === undefined ? {} : { downloadedBytes }),
  };
}
