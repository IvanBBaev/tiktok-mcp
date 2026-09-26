/**
 * The machinery the four write tools share (TOOLS.md § 3.8–§ 3.11).
 *
 * `tiktok_post_video`, `tiktok_upload_video_draft`, `tiktok_post_photos` and
 * `tiktok_upload_photos_draft` differ in three places only — what they validate,
 * what they send, and whether they run the `creator_info` pre-flight. Everything
 * between those points is the same contract: the same catalog errors, the same
 * hint texts, the same plan guards, and above all the same § 2.6.3 ordering,
 * which is a safety property rather than a convenience:
 *
 *   1. validate locally           — nothing sent, nothing consumed
 *   2. check the local rate bucket — refuses before any network (§ 2.8); the
 *                                   token itself is only taken at step 7
 *   3. re-resolve through the preview's own code path
 *   4. recompute the payload digest
 *   5. verify the plan            — two codes only, § 2.6.3
 *   6. duplicate guard            — BEFORE consumption, so a refusal leaves the
 *                                   same plan_id appliable with force: true
 *   7. consume the plan, then take the rate token — atomic, before the
 *                                   init dispatch (CC-E7)
 *   8. journal the intent         — fsync'd, before the request leaves
 *   9. dispatch, then journal the outcome
 *
 * Steps 5–7 live in {@link runPlanGuards} and step 8–9 in {@link dispatchWrite}
 * for one reason: four hand-written copies of an ordering this delicate would
 * drift, and the drift would only ever show up as a double post.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { maskOpenId, readCredentialSnapshot } from '../api/context.js';
import {
  PRIVACY_LEVELS,
  PUBLISH_STATUSES,
  type CreatorInfo,
  type DerivedField,
} from '../api/publish.js';
import { isTikTokError } from '../core/errors.js';
import type { ToolCtx } from '../mcp/define.js';
import { invalidParamsError, publishToolError } from '../mcp/errors.js';
import {
  appendIntent,
  appendOutcome,
  checkDuplicate,
  journalTimestamp,
  mintAttemptId,
  titleExcerpt,
  type FoldedOutcome,
  type IntentSource,
  type JournalAttempt,
  type OutcomeRecord,
} from '../mcp/journal.js';
import {
  approvalRequiredHint,
  localRateLimitedError,
  localRateLimitedHint,
  peekPublishToken,
  planExpiresAt,
  planFailureError,
  publishRateLimits,
  takePublishToken,
  type RateBucketSnapshot,
  type RateLimitRefusal,
} from '../mcp/plan.js';
import {
  consumePlan,
  mintPlanId,
  storePlan,
  verifyPlan,
  type ConsumeFailure,
  type PlanExpectation,
  type PlanLimits,
  type PlanStoreOptions,
} from '../mcp/plan-store.js';
import {
  hintEnum,
  hintToken,
  quotedHintToken,
  type Hint,
  type ToolError,
  type ToolResult,
} from '../mcp/result.js';
import { failRecovery, journalOptions, pollPublishStatus } from './publish.js';

// ---------------------------------------------------------------------------
// Result shapes (TOOLS.md § 3.8)
// ---------------------------------------------------------------------------

export interface AccountBlock {
  profile: string;
  /**
   * From `creator_info`. Absent on the draft tools, which never run that
   * pre-flight — a `video.upload`-only grant may not even carry the scope
   * (§ 3.9), so there is no honest value to put here.
   */
  nickname?: string;
  open_id_masked: string;
}

export interface CreatorBlock {
  privacy_level_options: readonly string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
}

/** What a `source: "file"` preview tells the user before they approve bytes. */
export interface ChunkSummary {
  file_size: number;
  chunk_size: number;
  chunks: number;
}

export type SourceBlock =
  | { type: 'url'; url: string }
  | {
      type: 'file';
      resolved_path: string;
      file_size: number;
      chunk_summary: ChunkSummary;
    }
  | { type: 'url'; urls: readonly string[]; photo_cover_index: number };

/** `mode: "applied"` — the post or draft exists (or is processing) upstream. */
export interface AppliedData {
  mode: 'applied';
  publish_id: string;
  status: string;
  /** Only once TikTok published it and only for public posts. */
  public_post_id?: string;
  /**
   * Only when `wait_for_completion` saw a terminal FAILED: the same pair
   * `tiktok_get_publish_status` returns (Appendix A), so the reason that came
   * back on the poll is not lost to the caller.
   */
  fail_reason?: string;
  fail_recovery?: string;
  journal: 'recorded' | 'unavailable';
}

/**
 * What the two posting tools return before anything is sent (§ 2.6.1) — the
 * whole of what the user is asked to approve, in one object.
 *
 * `mode: "plan_incomplete"` is the same shape minus the plan: § 2.6.1 step 4
 * refuses to mint one while `privacy_level` is unchosen, and answers with the
 * live options instead of a token.
 */
export interface WritePreview {
  mode: 'plan' | 'plan_incomplete';
  /** Absent exactly when `mode` is `plan_incomplete`. */
  plan_id?: string;
  expires_at?: string;
  /** The fields that kept a plan from being minted; `["privacy_level"]` today. */
  missing?: readonly string[];
  account: AccountBlock;
  action: string;
  /** `post_info` is absent while `privacy_level` is — it cannot be resolved yet. */
  payload: { post_info?: Record<string, unknown>; source: SourceBlock };
  derived?: readonly DerivedField[];
  creator: CreatorBlock;
  audit_restrictions_active: boolean;
  consent_line: string;
  meta: { rate_bucket: RateBucketSnapshot };
}

/**
 * The draft preview: {@link WritePreview} minus everything `creator_info`
 * feeds. That omission is the contract, not an economy — without the
 * pre-flight there is no nickname, no privacy options and no consent line to
 * state, and echoing empty ones would suggest the draft carries settings it
 * does not. There is no `plan_incomplete` twin either: no field is left for
 * the user to choose, so a draft preview is either a plan or an error.
 */
export interface DraftPreview {
  mode: 'plan';
  plan_id: string;
  expires_at: string;
  account: AccountBlock;
  action: string;
  payload: { post_info?: Record<string, unknown>; source: SourceBlock };
  meta: { rate_bucket: RateBucketSnapshot };
}

/**
 * The first status a successful init implies, before anything is polled.
 * `PULL_FROM_URL` means TikTok fetches the bytes itself, so the first state is
 * the download one; `FILE_UPLOAD` has already moved them, so it is processing.
 */
export function initialStatus(source: IntentSource): string {
  return source === 'FILE_UPLOAD' ? 'PROCESSING_UPLOAD' : 'PROCESSING_DOWNLOAD';
}

// ---------------------------------------------------------------------------
// Write-only catalog entries (TOOLS.md § 3.0)
// ---------------------------------------------------------------------------

/**
 * `url_prefix_unverified`. Carries the field name because the photo tools raise
 * the same code for `photo_urls[i]`, and "which URL" is the first thing the
 * caller needs.
 *
 * The catalog text offers `source: "file"` as the way out. That sentence is
 * omitted for photos on purpose: the photo endpoints have no upload at all
 * (§ 3.10), so pointing a caller at a branch that does not exist would cost a
 * round of wrong advice.
 */
export function urlPrefixUnverifiedError(
  field: string,
  fileAlternative = true,
): ToolError {
  const alternative = fileAlternative
    ? 'Use source "file" for local video files, or ask the user to host the media under a ' +
      'verified prefix.'
    : 'Ask the user to host the media under a verified prefix.';
  return {
    code: 'url_prefix_unverified',
    message:
      `${field} does not match any verified URL prefix configured in TT_VERIFIED_URL_PREFIXES. ` +
      'TikTok only pulls media from domains its developer verified in the TikTok developer ' +
      `portal — this is a platform rule, not a server setting. ${alternative} ` +
      'No request was sent.',
    retryable: false,
    details: { field },
  };
}

/**
 * `network_unsent` — the safe half of the network taxonomy. `core/http` never
 * mints this: with `retryClass: "init"` it cannot tell an unsent request from a
 * delivered one, so it always errs toward `network_ambiguous`. The code exists
 * for the failures the tools *can* prove were never dispatched.
 */
export function networkUnsentError(): ToolError {
  return {
    code: 'network_unsent',
    message:
      'The network failed before the publish request was sent — TikTok received nothing and no ' +
      "post was created (journal outcome 'error'). When the connection recovers, generate a " +
      'fresh preview and apply with the new plan_id.',
    retryable: false,
  };
}

/**
 * `network_ambiguous` — the post MAY exist. Never auto-retry through this.
 *
 * `publishId` is set only for a caller abort that landed after the init: the
 * attempt then provably exists upstream, and whether its last bytes arrived is
 * exactly what nobody knows. The id is upstream-originated, so it rides in
 * `details` only and the message stays the one text every ambiguous send gets.
 */
export function networkAmbiguousError(publishId?: string): ToolError {
  return {
    code: 'network_ambiguous',
    message:
      'The network failed after the publish request may already have been sent — the post MAY ' +
      'exist upstream. Do NOT apply again. Check tiktok_list_publish_journal (the latest entry ' +
      "will show outcome 'unknown') and tiktok_get_publish_status or tiktok_list_videos first; " +
      'retry only if no post exists, with a fresh preview.',
    retryable: false,
    ...(publishId === undefined ? {} : { details: { publish_id: publishId } }),
  };
}

/**
 * `plan_mismatch` for a local file that is no longer the one the preview saw
 * (CC-D3). Same code as every other mismatch — § 2.6.3 keeps plan failures to
 * two — but its own text, because "the arguments differ" would send a caller
 * hunting through arguments that are byte-for-byte what it previewed.
 */
export function fileChangedError(): ToolError {
  return {
    code: 'plan_mismatch',
    message:
      'The file changed since plan: the file at file_path no longer matches the size, ' +
      'modification time and identity captured when the preview was generated. Generate a ' +
      'fresh preview and apply again.',
    retryable: false,
    details: { reason: 'file_changed' },
  };
}

/**
 * `upload_interrupted` (§ 3.0). The init succeeded, so a `publish_id` exists and
 * the caller must be told which one — the recovery is "check that id, then start
 * a NEW attempt", never a resume and never an automatic re-init (CC-D5).
 *
 * The id TikTok minted is upstream-originated, and this message is read as an
 * instruction ("check this id"), so § 3.0 "Upstream values in error and recovery
 * text" applies: it is inlined only as an opaque token, in both of its
 * grammatical slots, and `details.publish_id` keeps the raw value regardless.
 * `detail` — the transport cause — is upstream free text and never enters the
 * sentence at all; it lives in `details.reason`.
 */
export function uploadInterruptedError(
  publishId: string,
  chunk: number,
  total: number,
  detail: string,
): ToolError {
  const id = hintToken(publishId);
  const minted =
    id === undefined ? 'the publish_id is in details.publish_id' : `publish_id ${id}`;
  const check = id ?? 'that publish_id';
  return {
    code: 'upload_interrupted',
    message:
      `Upload failed at chunk ${String(chunk)}/${String(total)} after automatic retries ` +
      `(${minted}). The upload cannot be resumed; TikTok will expire this ` +
      `attempt on its own. Check tiktok_get_publish_status for ${check}; if the user ` +
      'still wants the post, generate a fresh preview and apply again — that creates a NEW ' +
      'publish attempt.',
    retryable: false,
    details: { publish_id: publishId, chunk, total_chunks: total, reason: detail },
  };
}

/**
 * `possible_duplicate` (§ 2.6.5). The persisted `send_ambiguous` is presented as
 * `unknown`, the same read-side vocabulary `tiktok_list_publish_journal` uses —
 * the advice is identical either way.
 *
 * The message names the whole payload as the discriminator because that is what
 * the guard matches (`payload_digest`, § 2.6.5). Naming the title instead was
 * wrong for all four tools — the video draft has no title — and it pointed at the
 * wrong recovery: a caption edit already makes this a different attempt, so a
 * caller who "fixed" the title would post twice.
 *
 * `profile` is server configuration and `matched.ts` is a timestamp this server
 * wrote, so both are server-owned text. `matched.publish_id` is not: it is the
 * id TikTok minted, replayed out of the journal, so § 3.0 "Upstream values in
 * error and recovery text" admits it only as an opaque token. A value that is
 * not one drops the clause exactly as an absent id already does, and
 * `details.publish_id` still carries it.
 */
export function possibleDuplicateError(
  profile: string,
  matched: JournalAttempt,
): ToolError {
  const outcome: FoldedOutcome = matched.outcome === 'ok' ? 'ok' : 'unknown';
  const named = hintToken(matched.publish_id);
  const publishId = named === undefined ? '' : `, publish_id ${named}`;
  return {
    code: 'possible_duplicate',
    message:
      `A publish attempt with an identical payload (same media, text and settings — the guard ` +
      `matches the whole resolved request, not any single field) on account '${profile}' was ` +
      `journaled at ${matched.ts} with outcome '${outcome}'${publishId}. ` +
      `Verify with tiktok_get_publish_status and ` +
      'tiktok_list_publish_journal that no post was created. Only if confirmed, re-preview and ' +
      'apply with force: true.',
    retryable: false,
    details: {
      attempt_id: matched.attempt_id,
      journaled_at: matched.ts,
      outcome,
      ...(matched.publish_id === undefined ? {} : { publish_id: matched.publish_id }),
    },
  };
}

// ---------------------------------------------------------------------------
// Hints (TOOLS.md § 5)
// ---------------------------------------------------------------------------

/**
 * The `poll` hint every apply carries when it did not wait (§ 2.7).
 *
 * The id is quoted through {@link quotedHintToken}: § 5.2 rule 3 admits it into
 * the text only as an opaque identifier, and only when it still looks like one.
 * The unfiltered value always ships in the `publish_id` field beside the text.
 */
export function pollHint(publishId: string, pollAfter: string): Hint {
  return {
    type: 'poll',
    tool: 'tiktok_get_publish_status',
    publish_id: publishId,
    poll_after: pollAfter,
    text:
      `The post was accepted and is processing. Call tiktok_get_publish_status with ` +
      `${quotedHintToken('publish_id', publishId)} after ${pollAfter} to confirm it went ` +
      'live. Do not post again.',
  };
}

/**
 * A `wait_for_completion` poll that ran out of time — success, not failure.
 *
 * A `poll` hint carries an absolute `poll_after` (§ 2.7), and this one is no
 * exception: without it the model is told to poll again with nothing to say
 * when, which on a post that just failed to settle within the whole budget is
 * an invitation to hammer the status endpoint.
 */
export function stillProcessingAfterApplyHint(
  publishId: string,
  status: string,
  timeoutS: number,
  pollAfter: string,
): Hint {
  const known = hintEnum(status, PUBLISH_STATUSES) ?? 'processing';
  return {
    type: 'poll',
    tool: 'tiktok_get_publish_status',
    publish_id: publishId,
    poll_after: pollAfter,
    text:
      `Still ${known} after ${String(timeoutS)} s — normal for large videos. Call ` +
      `tiktok_get_publish_status with ${quotedHintToken('publish_id', publishId)} after ` +
      `${pollAfter}; do not re-post.`,
  };
}

/**
 * The journal could not be written. Never a publish failure — always a warning.
 *
 * A `note` carries no structured fields (§ 5.1), so an id that fails the § 5.2
 * rule 3 shape check simply leaves the text; it is still in `data.publish_id`
 * on the very same result, and the fallback sentence sends the model to the
 * two tools that can find the post without it.
 */
export function journalUnavailableNote(publishId: string | undefined): Hint {
  const id = quotedHintToken('publish_id', publishId);
  const where =
    publishId === undefined || id.startsWith('this')
      ? 'Check tiktok_get_publish_status and tiktok_list_videos before any retry.'
      : `Note ${id} and verify with tiktok_get_publish_status before any retry.`;
  return {
    type: 'note',
    text:
      'This attempt could not be written to the publish journal, so the duplicate guard cannot ' +
      `see it. ${where}`,
  };
}

/**
 * `mode: "plan_incomplete"` — say what is missing and who has to decide it.
 *
 * `creator_info` is only checked for an array of strings upstream, so the text
 * lists this server's own `PRIVACY_LEVELS` literals *selected by* what arrived
 * (§ 5.2 rule 3), not the arrived strings. Anything unrecognized — or an empty
 * list — is left to `data.creator.privacy_level_options`, which the same result
 * carries unfiltered.
 */
export function choosePrivacyHint(toolName: string, options: readonly string[]): Hint {
  const known = PRIVACY_LEVELS.filter((level) => options.includes(level));
  const list =
    known.length > 0
      ? `one of ${known.join(', ')}`
      : 'one of the levels in data.creator.privacy_level_options';
  return {
    type: 'user_action',
    action: 'configure_server',
    text:
      'No plan_id was issued: privacy_level is required and has no default. Ask the user to ' +
      `choose ${list}, then call ${toolName} again with privacy_level set.`,
  };
}

/**
 * Every successful draft apply (§ 3.9, § 3.11). Verbatim from § 5.3, which is
 * the normative rendering — the § 3.9 prose says "Unfinished" where § 5.3 and
 * the tool description both say "Unopened"; two of three win.
 */
export function draftInboxHint(): Hint {
  return {
    type: 'user_action',
    action: 'open_tiktok_app',
    text:
      'Tell the user: open the TikTok app notification to edit and publish the draft. ' +
      'Unopened drafts expire.',
  };
}

/**
 * `file_outside_media_root` (§ 3.0, CC-D1/CC-D8). Verbatim from § 5.3.
 *
 * Neither branch is one the model can take: it cannot move a file and it
 * cannot re-configure the server, so § 5.1's test — "a step only the
 * human/operator can take *next*, before this call can proceed" — is met.
 * The resolved path and the configured root stay in `error.message`: § 5.2
 * rule 3 whitelists env-var *names* as server-owned template text, but a
 * filesystem path is not on that list.
 */
export function moveFileHint(toolName: string): Hint {
  return {
    type: 'user_action',
    action: 'move_file',
    text:
      'Only the user can move files: ask them to put the file inside the media root the error ' +
      'names, or to set TT_MEDIA_ROOT to a directory that contains it and restart the server. ' +
      `Then call ${toolName} again with the new file_path.`,
  };
}

/**
 * `url_prefix_unverified` (§ 3.0, CC-D10). Verbatim from § 5.3.
 *
 * Says nothing about `source: "file"` on purpose. That alternative exists for
 * two of the four write tools only (§ 3.10 photos have no upload path), it is
 * already in the catalog message for the two that have it, and a `user_action`
 * hint operationalizes the human branch — the one the model cannot resolve on
 * its own. § 5.2 rule 5 asks the hint not to contradict the error, not to
 * repeat all of it.
 */
export function hostMediaHint(toolName: string): Hint {
  return {
    type: 'user_action',
    action: 'host_media',
    text:
      'Only the user can change where media is hosted: ask them to serve it under a prefix ' +
      `listed in TT_VERIFIED_URL_PREFIXES, then call ${toolName} again with the new URL. ` +
      'Do not retry the same URL.',
  };
}

/**
 * The `user_action` a refusal earns, if any — the single place the mapping
 * from catalog code to operator step lives.
 *
 * Only codes whose recovery is a human step qualify. `file_not_found`,
 * `file_too_large` and friends are also non-retryable, but their recovery is
 * "ask for the right path" / "re-encode", which the error message already
 * states and which no vocabulary member names.
 *
 * Callers must not use this past an init: see {@link dispatchWrite}.
 */
export function userActionHint(error: ToolError, toolName: string): Hint | undefined {
  if (error.code === 'file_outside_media_root') return moveFileHint(toolName);
  if (error.code === 'url_prefix_unverified') return hostMediaHint(toolName);
  return undefined;
}

/**
 * A refusal in the shape § 5 owes the caller: the error, plus the operator
 * step that unblocks it when there is one.
 *
 * Used at every tool-layer site where a pre-network validation error becomes a
 * result. The error is raised deeper — `file_outside_media_root` in
 * `api/upload.ts`, which the layering forbids from importing `Hint` at all —
 * so the hint is attached here, keyed off the stable catalog code.
 */
export function localRefusal(error: ToolError, toolName: string): ToolResult<never> {
  const hint = userActionHint(error, toolName);
  return hint === undefined ? { ok: false, error } : { ok: false, error, hints: [hint] };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * TikTok's own consent requirement, restated by the server. The preview has to
 * show it *before* approval, so it is composed here from server-owned templates
 * — nothing upstream is interpolated (§ 5.2).
 */
export function consentLine(brandContent: boolean, brandOrganic: boolean): string {
  return brandContent || brandOrganic
    ? "By approving this post you confirm the user agrees to TikTok's Branded Content Policy and " +
        'Music Usage Confirmation.'
    : "By approving this post you confirm the user agrees to TikTok's Music Usage Confirmation.";
}

export function planLimits(ctx: ToolCtx): PlanStoreOptions {
  const limits: PlanLimits = {
    planTtlS: ctx.api.settings.planTtlS,
    planMaxOutstanding: ctx.api.settings.planMaxOutstanding,
  };
  return { limits };
}

export function signalOpt(ctx: ToolCtx): { signal?: AbortSignal } {
  return ctx.signal === undefined ? {} : { signal: ctx.signal };
}

export function creatorBlock(info: CreatorInfo): CreatorBlock {
  return {
    privacy_level_options: info.privacyLevelOptions,
    comment_disabled: info.commentDisabled,
    duet_disabled: info.duetDisabled,
    stitch_disabled: info.stitchDisabled,
    ...(info.maxVideoPostDurationSec === undefined
      ? {}
      : { max_video_post_duration_sec: info.maxVideoPostDurationSec }),
  };
}

/**
 * The `open_id` a plan is bound to. Re-read on every call rather than cached:
 * the credential store is the authority and a re-login can change the account
 * behind a profile name between preview and apply — which is exactly the
 * `plan_mismatch` this binding exists to catch (§ 2.6.3 step 5).
 */
export async function resolveOpenId(ctx: ToolCtx): Promise<string> {
  const profiles = await readCredentialSnapshot(ctx.api);
  return profiles.find((entry) => entry.name === ctx.api.profile)?.openId ?? '';
}

/**
 * `open_id` masked for display (§ 2.5) — the preview has to let a user confirm
 * *which* account is about to post without printing the identifier itself.
 */
export function accountBlock(
  profile: string,
  openId: string,
  nickname?: string,
): AccountBlock {
  return {
    profile,
    ...(nickname === undefined ? {} : { nickname }),
    open_id_masked: maskOpenId(openId),
  };
}

/**
 * Whether `target` sits under a verified prefix. Compared parsed, not as raw
 * strings: the origin has to match exactly, so `https://cdn.example.com` does
 * not admit `https://cdn.example.com.attacker.net/…`, and a host spelled in
 * another case still matches the one the operator configured. The path stays a
 * literal prefix, which is how TikTok itself reads the verified prefix.
 */
function underPrefix(target: URL, prefix: string): boolean {
  let allowed: URL;
  try {
    allowed = new URL(prefix);
  } catch {
    return false;
  }
  return target.origin === allowed.origin && target.pathname.startsWith(allowed.pathname);
}

/**
 * Local URL validation. Both checks are pre-network by contract: an unverified
 * prefix must never become a TikTok round-trip, because TikTok's own refusal
 * would arrive as an opaque upstream code (CC-D10).
 */
export function checkMediaUrl(
  url: string,
  field: string,
  prefixes: readonly string[],
  fileAlternative = true,
): ToolError | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalidParamsError(`${field}: must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    return invalidParamsError(`${field}: must use https://`);
  }
  // CC-D10: credentials in the URL would be handed to TikTok's fetcher and end
  // up in whatever it logs. Refuse locally rather than leak them upstream.
  if (parsed.username !== '' || parsed.password !== '') {
    return invalidParamsError(
      `${field}: must not contain credentials (user:password@host)`,
    );
  }
  if (!prefixes.some((prefix) => underPrefix(parsed, prefix))) {
    return urlPrefixUnverifiedError(field, fileAlternative);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plan lifecycle (TOOLS.md § 2.6)
// ---------------------------------------------------------------------------

/** A refusal in the shape § 2.8 owes the caller: the error plus its `wait` hint. */
function rateRefused(ctx: ToolCtx, refusal: RateLimitRefusal): ToolResult<never> {
  const limits = publishRateLimits(ctx.api.settings);
  return {
    ok: false,
    error: localRateLimitedError(refusal, limits),
    hints: [localRateLimitedHint(refusal)],
  };
}

/**
 * Step 2 of § 2.6.3: an empty bucket refuses here, before any network call.
 *
 * A check rather than a take, because the token belongs to an init that is
 * about to happen. Taking it this early charged the account's publish budget
 * for calls that never reached TikTok at all — a mistyped `plan_id`, an expired
 * one, a duplicate — and the caller's only way to get it back was to wait out a
 * refill interval for a request that was never sent. {@link runPlanGuards}
 * takes it at step 7 instead.
 */
export function checkWriteBucket(ctx: ToolCtx): ToolResult<never> | undefined {
  const refusal = peekPublishToken(
    ctx.api.profile,
    ctx.api.clock,
    publishRateLimits(ctx.api.settings),
  );
  return refusal === undefined ? undefined : rateRefused(ctx, refusal);
}

/** Mint and store the preview's token. Returns what the preview must echo. */
export function mintPlan(
  ctx: ToolCtx,
  toolName: string,
  digest: string,
  openId: string,
  fileIdentity?: string,
): { planId: string; expiresAt: string; hint: Hint } {
  const createdAt = ctx.api.clock.now();
  const planId = mintPlanId();
  storePlan(
    planId,
    {
      digest,
      profile: ctx.api.profile,
      openId,
      tool: toolName,
      createdAt,
      used: false,
      fileIdentity,
    },
    planLimits(ctx),
  );
  const expiresAt = planExpiresAt(createdAt, ctx.api.settings.planTtlS);
  return { planId, expiresAt, hint: approvalRequiredHint(planId, expiresAt) };
}

/**
 * Payloads with a dispatch in progress in this process, keyed by profile and
 * digest, with how many dispatches hold each.
 *
 * The journal guard cannot see these: two applies of *different* plans for the
 * same payload can both read the journal before either has appended its
 * intent. The entry is taken before the journal read and held across it, and
 * callers go straight from {@link runPlanGuards} into
 * {@link dispatchWrite}, which releases the entry once it settles.
 */
const inFlight = new Map<string, number>();

function inFlightKey(profile: string, digest: string): string {
  return `${profile}\u0000${digest}`;
}

/** Only reached for a key {@link runPlanGuards} registered, so it is present. */
function releaseInFlight(key: string): void {
  const held = inFlight.get(key) as number;
  if (held === 1) inFlight.delete(key);
  else inFlight.set(key, held - 1);
}

/** `possible_duplicate` for a payload whose dispatch has not settled yet. */
export function inFlightDuplicateError(profile: string): ToolError {
  return {
    code: 'possible_duplicate',
    message:
      `A publish attempt with an identical payload on account '${profile}' is being sent right ` +
      'now. Wait for it to finish, then check tiktok_list_publish_journal and ' +
      'tiktok_get_publish_status. Only if no post was created, re-preview and apply with ' +
      'force: true.',
    retryable: false,
    details: { in_flight: true },
  };
}

/** A plan refusal as the caller sees it — the file's own text for CC-D3. */
function planRefused(ctx: ToolCtx, reason: ConsumeFailure): ToolResult<never> {
  const error =
    reason === 'file_changed'
      ? fileChangedError()
      : planFailureError(reason, ctx.api.settings.planTtlS);
  return { ok: false, error };
}

/**
 * Steps 5, 6 and 7 of § 2.6.3, in the one order that is safe.
 *
 * `verifyPlan` proves the token without spending it, the duplicate guard's file
 * read sits between the two calls so a refusal leaves the same `plan_id`
 * appliable with `force: true`, and `consumePlan` re-checks under the same
 * expectation because that file read gave a concurrent apply a window to win.
 *
 * The rate token is spent last, once the plan is. The bucket is peeked first,
 * so a concurrent apply that emptied it since step 2 is refused with the plan
 * still unspent and the same `plan_id` applies after the wait; the plan is
 * consumed next, so a plan lost in the window above costs no token; and only
 * then is the token taken. Nothing yields from the peek to the take and a
 * bucket only gains tokens while nobody spends, so the take cannot refuse what
 * the peek allowed — the token is charged only for a call that goes on to
 * dispatch an init.
 *
 * The in-flight entry is taken before the file read and held across it, so a
 * second identical apply arriving during the read is refused as in flight
 * instead of passing the journal check alongside the first; every refusal from
 * there on hands the entry back.
 */
export async function runPlanGuards(
  ctx: ToolCtx,
  planId: string | undefined,
  expectation: PlanExpectation,
  force: boolean,
): Promise<ToolResult<never> | undefined> {
  const { api } = ctx;
  const failed = (error: ToolError): ToolResult<never> => ({ ok: false, error });

  if (planId !== undefined) {
    const verdict = verifyPlan(planId, expectation, api.clock, planLimits(ctx));
    if (!verdict.ok) return planRefused(ctx, verdict.reason);
  }

  const key = inFlightKey(api.profile, expectation.digest);
  if (!force && inFlight.has(key)) return failed(inFlightDuplicateError(api.profile));
  // Registered before the journal read, not after it: a dispatch for the same
  // payload that appended its intent, posted and settled while that read was
  // pending would otherwise be invisible to both checks. Registered even under
  // `force`: a forced apply is still a dispatch that an unforced one for the
  // same payload must not race. Every refusal below hands the entry back.
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  const refused = (result: ToolResult<never>): ToolResult<never> => {
    releaseInFlight(key);
    return result;
  };

  // A throw past this point must hand the entry back too, or the payload stays
  // "in flight" for the life of the process.
  try {
    if (!force) {
      // Per profile: the same video on two accounts is two posts, not one twice.
      // Never rejects: an unreadable journal is logged and lets the publish through.
      const duplicate = await checkDuplicate(
        expectation.digest,
        api.profile,
        api.clock,
        journalOptions(ctx),
      );
      if (duplicate.duplicate && duplicate.matched !== undefined) {
        return refused(
          failed(possibleDuplicateError(duplicate.matched.profile, duplicate.matched)),
        );
      }
    }

    // No `await` from here to the return below.
    const rates = publishRateLimits(api.settings);
    const refusal = peekPublishToken(api.profile, api.clock, rates);
    if (refusal !== undefined) return refused(rateRefused(ctx, refusal));

    if (planId !== undefined) {
      const consumed = consumePlan(planId, expectation, api.clock, planLimits(ctx));
      if (!consumed.ok) return refused(planRefused(ctx, consumed.reason));
    }

    // Cannot refuse — see above — so its verdict is not re-read.
    takePublishToken(api.profile, api.clock, rates);
    return undefined;
  } catch (error) {
    releaseInFlight(key);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dispatch (TOOLS.md § 2.6.3 steps 8–9)
// ---------------------------------------------------------------------------

/** Where the bytes stand when a dispatch fails — for `upload_interrupted`. */
export interface ChunkPosition {
  chunk: number;
  total: number;
}

/**
 * What a sender reports once its init has returned and more can still fail:
 * the `publish_id` TikTok minted and where the bytes stand at any later moment.
 */
export interface InitialisedUpload {
  publishId: string;
  position: () => ChunkPosition;
}

export interface DispatchOptions {
  toolName: string;
  /** Journalled `mode` — the resolved upstream `post_mode` (§ 2.6.2). */
  mode: string;
  source: IntentSource;
  /**
   * What the journal line's `title_excerpt` is cut from — a human reading the
   * journal, not the duplicate guard, which matches on `digest`. `''` for the
   * video draft, which carries no title; the photo tools pass their title and
   * description joined.
   */
  title: string;
  digest: string;
  /** `''` only under `TT_WRITE_MODE=apply` with no token — an honest record. */
  planId: string;
  openId: string;
  /**
   * The upstream half. Calls `report` the moment an init returns a `publish_id`
   * that a later step can still fail behind — the chunk upload — which is what
   * lets that failure be classified as `upload_failed` (the post exists) rather
   * than `error` (it does not). A sender whose init is its last throwable step
   * has nothing to report: its `publish_id` is the resolved value, and every
   * failure it can raise is honestly pre-init.
   */
  send: (report: (started: InitialisedUpload) => void) => Promise<string>;
}

/**
 * A dispatch that reached TikTok, as a type that says so.
 *
 * `ok` and `data` are declared independently on {@link ToolResult} — honestly,
 * because the tools that answer with a refusal carry neither — but
 * {@link dispatchWrite} decides the two together: its one success branch is the
 * only place a dispatch builds a result with `data`, and every failure branch
 * builds one without. Narrowing the *return type* is what lets its callers read
 * that pairing off the type instead of re-checking a state no dispatch can
 * produce; it is the same move `MappedToolError` makes in `mcp/errors.ts`, for
 * the same reason, and it stays local to the one function that guarantees it.
 */
export type AppliedResult = ToolResult<AppliedData> & { ok: true; data: AppliedData };

/** The other half of a dispatch: an `error`, and never a payload. */
export type FailedDispatch = ToolResult<AppliedData> & { ok: false; data?: undefined };

/** What {@link dispatchWrite} answers — one of the two, never a mix. */
export type DispatchResult = AppliedResult | FailedDispatch;

/**
 * What {@link waitIfAsked} answers: the same two halves, with `hints` promoted
 * to required on the applied one. Every exit that returns an applied result
 * unshifts a hint onto whatever the dispatch left, so "an applied result has
 * hints" is a guarantee of that function rather than of the envelope — and
 * stating it here is what lets the two draft handlers prepend their inbox hint
 * without a fallback for a state no execution reaches.
 */
export type WaitedResult = (AppliedResult & { hints: Hint[] }) | FailedDispatch;

/**
 * Everything after the plan has been consumed: journal, dispatch, journal.
 *
 * Split out because from here on a failure is no longer "nothing happened" —
 * the record on disk is the only thing that can tell a user which.
 */
export async function dispatchWrite(
  ctx: ToolCtx,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  try {
    return await dispatchRegistered(ctx, opts);
  } finally {
    releaseInFlight(inFlightKey(ctx.api.profile, opts.digest));
  }
}

async function dispatchRegistered(
  ctx: ToolCtx,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const { api } = ctx;
  const journal = journalOptions(ctx);
  const attemptId = mintAttemptId(api.clock);

  // Step 8.
  const intent = await appendIntent(
    {
      v: 1,
      type: 'intent',
      attempt_id: attemptId,
      ts: journalTimestamp(api.clock),
      tool: opts.toolName,
      profile: api.profile,
      open_id: opts.openId,
      plan_id: opts.planId,
      payload_digest: opts.digest,
      title_excerpt: titleExcerpt(opts.title),
      source: opts.source,
      mode: opts.mode,
    },
    journal,
  );

  const writeOutcome = async (
    rec: Omit<OutcomeRecord, 'v' | 'type' | 'attempt_id' | 'ts'>,
  ) =>
    await appendOutcome(
      {
        v: 1,
        type: 'outcome',
        attempt_id: attemptId,
        ts: journalTimestamp(api.clock),
        ...rec,
      },
      journal,
    );

  // Step 9. `initialised` is the whole classification: set by `report`, it says
  // an attempt exists upstream regardless of what failed afterwards, and where
  // its bytes stand.
  let initialised: InitialisedUpload | undefined;
  // A signal that fired before the send is one no request ever carried live:
  // `core/http` refuses an aborted signal before `fetch`, so what that abort
  // unwinds provably never left the process.
  const cancelledBeforeSend = ctx.signal?.aborted === true;
  try {
    const publishId = await opts.send((started) => {
      initialised = started;
    });
    const recorded =
      intent.ok && (await writeOutcome({ result: 'ok', publish_id: publishId })).ok;
    const result: AppliedResult = {
      ok: true,
      data: {
        mode: 'applied',
        publish_id: publishId,
        status: initialStatus(opts.source),
        journal: recorded ? 'recorded' : 'unavailable',
      },
    };
    if (!recorded) {
      result.journal = 'unavailable';
      result.hints = [journalUnavailableNote(publishId)];
    }
    return result;
  } catch (cause) {
    const aborted = !cancelledBeforeSend && callerAborted(ctx, cause);
    const failure = classifyDispatch(cause, initialised, aborted);
    // Short-circuited on purpose: an outcome whose intent never reached the disk
    // is an orphan the reader drops anyway (§ 8.3).
    const recorded = intent.ok && (await writeOutcome(failure.outcome)).ok;
    const failed: FailedDispatch = { ok: false, error: failure.error };
    // A `user_action` names the step that unblocks *this* call (§ 5.1). Past an
    // init there is nothing left to unblock: the attempt exists upstream, the
    // journal says `upload_failed` (CC-B4) and the next step is
    // `tiktok_get_publish_status`, not a human. Only the pre-init branch —
    // TikTok refusing the pull outright — earns one.
    const step =
      initialised === undefined
        ? userActionHint(failure.error, opts.toolName)
        : undefined;
    // Most-actionable-first (§ 5.2 rule 4): the step that fixes the call, then
    // the caveat about the duplicate guard.
    const hints: Hint[] = step === undefined ? [] : [step];
    if (!recorded) {
      failed.journal = 'unavailable';
      hints.push(journalUnavailableNote(initialised?.publishId));
    }
    if (hints.length > 0) failed.hints = hints;
    return failed;
  }
}

/**
 * Did this failure come from the caller cancelling rather than from TikTok?
 *
 * The transport rethrows a caller abort verbatim — the signal's own reason, not
 * a `TikTokError` (CC-G4) — so "the signal fired and what unwound is not one of
 * ours" is the test. A `TikTokError` that lands after a late cancel is still
 * TikTok's verdict and keeps its own classification. The caller only asks this
 * of a signal that was live when the send began.
 */
function callerAborted(ctx: ToolCtx, cause: unknown): boolean {
  return ctx.signal?.aborted === true && !isTikTokError(cause);
}

/**
 * A dispatch failure, as the error the caller sees and the line the journal
 * keeps.
 *
 * A caller abort is the one failure that says nothing about what TikTok saw:
 * the init or the last chunk may have left before the cancel and completed
 * anyway (CC-G4). It is `send_ambiguous` on either side of the init — never
 * `error` or `upload_failed`, the two outcomes the duplicate guard lets
 * through, because a retry after a cancel is exactly the one that posts twice.
 *
 * The dividing line is whether an init already returned a `publish_id`. Before
 * it, `retryClass: "init"` has turned every ambiguous transport failure into
 * `network_ambiguous`, and any remaining `network` failure provably never left
 * the process, so it is `network_unsent`. After it, the attempt exists upstream
 * whatever happened to the bytes — the outcome is `upload_failed`, never
 * `error`, which a reader would take as "nothing was created" (CC-B4).
 */
function classifyDispatch(
  cause: unknown,
  initialised: InitialisedUpload | undefined,
  aborted: boolean,
): {
  error: ToolError;
  outcome: Omit<OutcomeRecord, 'v' | 'type' | 'attempt_id' | 'ts'>;
} {
  if (initialised !== undefined) {
    // Only a sender with chunks still to send reports at all — the URL branch
    // of `videoSender` and `photoSender` resolve straight out of their init —
    // so an initialised failure always has a position to name.
    const at = initialised.position();
    // A caller abort, or a final chunk whose answer never came: either way the
    // upload may have completed, and TikTok posts what completes.
    if (aborted || (isTikTokError(cause) && cause.code === 'network_ambiguous')) {
      return {
        error: networkAmbiguousError(initialised.publishId),
        outcome: {
          result: 'send_ambiguous',
          publish_id: initialised.publishId,
          error_code: 'network_ambiguous',
          chunk: at.chunk,
        },
      };
    }
    if (isTikTokError(cause) && cause.code === 'upload_interrupted') {
      return {
        error: uploadInterruptedError(
          initialised.publishId,
          at.chunk,
          at.total,
          cause.message,
        ),
        outcome: {
          result: 'upload_failed',
          publish_id: initialised.publishId,
          error_code: 'upload_interrupted',
          chunk: at.chunk,
        },
      };
    }
    // Everything else that can fail after the init — the re-stat, the upload
    // host's own refusals, an unexpected throw — left the same trace: TikTok
    // minted the `publish_id`, so the attempt exists and only the bytes are
    // missing. `error` is the journal's word for "nothing was created", and a
    // reader who believes it posts a second time.
    const error = publishToolError(cause);
    return {
      error,
      outcome: {
        result: 'upload_failed',
        publish_id: initialised.publishId,
        error_code: error.code,
        chunk: at.chunk,
      },
    };
  }

  if (aborted || (isTikTokError(cause) && cause.code === 'network_ambiguous')) {
    return {
      error: networkAmbiguousError(),
      outcome: { result: 'send_ambiguous', error_code: 'network_ambiguous' },
    };
  }
  const error =
    isTikTokError(cause) && cause.kind === 'network'
      ? networkUnsentError()
      : publishToolError(cause);
  return { error, outcome: { result: 'error', error_code: error.code } };
}

// ---------------------------------------------------------------------------
// wait_for_completion (TOOLS.md § 2.7)
// ---------------------------------------------------------------------------

/**
 * Attach the `poll` hint, optionally after waiting for a terminal status.
 *
 * Three rules from § 2.7, all of which say the same thing — an accepted post
 * stays accepted: a timeout is not an error, a status read that throws is not
 * an error, and neither downgrades `ok`. Both failure paths fall back to the
 * exact hint an immediate return would have carried.
 *
 * A dispatch that failed passes straight through: there is no `publish_id` to
 * poll for, and § 2.7 has nothing to say about a post that was never accepted.
 * {@link DispatchResult} is what makes that one check enough — it pairs `ok`
 * with `data`, so the applied half needs no second test for a payload, and
 * {@link WaitedResult} hands the caller back the hints this function always
 * attaches to it.
 */
export async function waitIfAsked(
  ctx: ToolCtx,
  result: DispatchResult,
  waitForCompletion: boolean,
): Promise<WaitedResult> {
  const { api } = ctx;
  if (!result.ok) return result;
  const data = result.data;

  const hints = result.hints ?? [];
  // One source for both poll hints: the status tool's own polling interval, so
  // a re-ask lands on the schedule `tiktok_get_publish_status` already keeps.
  const nextPollAt = (): string =>
    new Date(api.clock.now() + api.settings.statusPollIntervalMs).toISOString();
  const laterPoll = (): Hint => pollHint(data.publish_id, nextPollAt());

  if (!waitForCompletion) {
    hints.unshift(laterPoll());
    return { ...result, hints };
  }

  try {
    const polled = await pollPublishStatus(api, data.publish_id, {
      waitForCompletion: true,
      ...signalOpt(ctx),
    });
    data.status = polled.status.status;
    const [publicPostId] = polled.status.publicPostIds ?? [];
    if (publicPostId !== undefined) data.public_post_id = publicPostId;
    const failReason = polled.status.failReason;
    if (data.status === 'FAILED' && failReason !== undefined) {
      data.fail_reason = failReason;
      data.fail_recovery = failRecovery(failReason);
    }
    if (polled.timedOut) {
      hints.unshift(
        stillProcessingAfterApplyHint(
          data.publish_id,
          data.status,
          Math.round(api.settings.statusPollTimeoutMs / 1000),
          nextPollAt(),
        ),
      );
    }
  } catch {
    hints.unshift(laterPoll());
  }
  return { ...result, hints };
}
