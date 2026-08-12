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
 *   2. take the local rate token  — before any network (§ 2.8)
 *   3. re-resolve through the preview's own code path
 *   4. recompute the payload digest
 *   5. verify the plan            — two codes only, § 2.6.3
 *   6. duplicate guard            — BEFORE consumption, so a refusal leaves the
 *                                   same plan_id appliable with force: true
 *   7. consume the plan           — atomic, before the init dispatch (CC-E7)
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
import type { CreatorInfo, DerivedField } from '../api/publish.js';
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
  planExpiresAt,
  planFailureError,
  takePublishToken,
  type RateBucketSnapshot,
} from '../mcp/plan.js';
import {
  consumePlan,
  mintPlanId,
  storePlan,
  verifyPlan,
  type PlanExpectation,
  type PlanLimits,
  type PlanStoreOptions,
} from '../mcp/plan-store.js';
import type { Hint, ToolError, ToolResult } from '../mcp/result.js';
import { journalOptions, pollPublishStatus } from './publish.js';

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

/** `network_ambiguous` — the post MAY exist. Never auto-retry through this. */
export function networkAmbiguousError(): ToolError {
  return {
    code: 'network_ambiguous',
    message:
      'The network failed after the publish request may already have been sent — the post MAY ' +
      'exist upstream. Do NOT apply again. Check tiktok_list_publish_journal (the latest entry ' +
      "will show outcome 'unknown') and tiktok_get_publish_status or tiktok_list_videos first; " +
      'retry only if no post exists, with a fresh preview.',
    retryable: false,
  };
}

/**
 * `upload_interrupted` (§ 3.0). The init succeeded, so a `publish_id` exists and
 * the caller must be told which one — the recovery is "check that id, then start
 * a NEW attempt", never a resume and never an automatic re-init (CC-D5).
 */
export function uploadInterruptedError(
  publishId: string,
  chunk: number,
  total: number,
  detail: string,
): ToolError {
  return {
    code: 'upload_interrupted',
    message:
      `Upload failed at chunk ${String(chunk)}/${String(total)} after automatic retries ` +
      `(publish_id ${publishId}). The upload cannot be resumed; TikTok will expire this ` +
      `attempt on its own. Check tiktok_get_publish_status for ${publishId}; if the user ` +
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
 */
export function possibleDuplicateError(
  profile: string,
  matched: JournalAttempt,
): ToolError {
  const outcome: FoldedOutcome = matched.outcome === 'ok' ? 'ok' : 'unknown';
  const publishId =
    matched.publish_id === undefined ? '' : `, publish_id ${matched.publish_id}`;
  return {
    code: 'possible_duplicate',
    message:
      `A publish attempt with this title on account '${profile}' was journaled at ${matched.ts} ` +
      `with outcome '${outcome}'${publishId}. Verify with tiktok_get_publish_status and ` +
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

/** The `poll` hint every apply carries when it did not wait (§ 2.7). */
export function pollHint(publishId: string, pollAfter: string): Hint {
  return {
    type: 'poll',
    tool: 'tiktok_get_publish_status',
    publish_id: publishId,
    poll_after: pollAfter,
    text:
      `The post was accepted and is processing. Call tiktok_get_publish_status with publish_id ` +
      `"${publishId}" after ${pollAfter} to confirm it went live. Do not post again.`,
  };
}

/** A `wait_for_completion` poll that ran out of time — success, not failure. */
export function stillProcessingAfterApplyHint(
  publishId: string,
  status: string,
  timeoutS: number,
): Hint {
  return {
    type: 'poll',
    tool: 'tiktok_get_publish_status',
    publish_id: publishId,
    text:
      `Still ${status} after ${String(timeoutS)} s — normal for large videos. Call ` +
      `tiktok_get_publish_status with publish_id "${publishId}"; do not re-post.`,
  };
}

/** The journal could not be written. Never a publish failure — always a warning. */
export function journalUnavailableNote(publishId: string | undefined): Hint {
  const where =
    publishId === undefined
      ? 'Check tiktok_get_publish_status and tiktok_list_videos before any retry.'
      : `Note publish_id "${publishId}" and verify with tiktok_get_publish_status before any retry.`;
  return {
    type: 'note',
    text:
      'This attempt could not be written to the publish journal, so the duplicate guard cannot ' +
      `see it. ${where}`,
  };
}

/** `mode: "plan_incomplete"` — say what is missing and who has to decide it. */
export function choosePrivacyHint(toolName: string, options: readonly string[]): Hint {
  const list = options.length > 0 ? options.join(', ') : '(none available)';
  return {
    type: 'user_action',
    action: 'configure_server',
    text:
      'No plan_id was issued: privacy_level is required and has no default. Ask the user to ' +
      `choose one of ${list}, then call ${toolName} again with privacy_level set.`,
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
  if (!prefixes.some((prefix) => url.startsWith(prefix))) {
    return urlPrefixUnverifiedError(field, fileAlternative);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plan lifecycle (TOOLS.md § 2.6)
// ---------------------------------------------------------------------------

/** Step 2 of § 2.6.3, as a result rather than a throw. */
export function takeWriteToken(ctx: ToolCtx): ToolResult<never> | undefined {
  const take = takePublishToken(ctx.api.profile, ctx.api.clock);
  if (take.ok) return undefined;
  return {
    ok: false,
    error: localRateLimitedError(take.refusal),
    hints: [localRateLimitedHint(take.refusal)],
  };
}

/** Mint and store the preview's token. Returns what the preview must echo. */
export function mintPlan(
  ctx: ToolCtx,
  toolName: string,
  digest: string,
  openId: string,
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
    },
    planLimits(ctx),
  );
  const expiresAt = planExpiresAt(createdAt, ctx.api.settings.planTtlS);
  return { planId, expiresAt, hint: approvalRequiredHint(planId, expiresAt) };
}

/**
 * Steps 5, 6 and 7 of § 2.6.3, in the one order that is safe.
 *
 * `verifyPlan` proves the token without spending it, the duplicate guard's file
 * read sits between the two calls so a refusal leaves the same `plan_id`
 * appliable with `force: true`, and `consumePlan` re-checks under the same
 * expectation because that file read gave a concurrent apply a window to win.
 */
export async function runPlanGuards(
  ctx: ToolCtx,
  planId: string | undefined,
  expectation: PlanExpectation,
  force: boolean,
): Promise<ToolError | undefined> {
  const { api } = ctx;

  if (planId !== undefined) {
    const verdict = verifyPlan(planId, expectation, api.clock, planLimits(ctx));
    if (!verdict.ok) return planFailureError(verdict.reason, api.settings.planTtlS);
  }

  if (!force) {
    const duplicate = await checkDuplicate(
      expectation.digest,
      api.clock,
      journalOptions(ctx),
    );
    if (duplicate.duplicate && duplicate.matched !== undefined) {
      return possibleDuplicateError(api.profile, duplicate.matched);
    }
  }

  if (planId !== undefined) {
    const consumed = consumePlan(planId, expectation, api.clock, planLimits(ctx));
    if (!consumed.ok) return planFailureError(consumed.reason, api.settings.planTtlS);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Dispatch (TOOLS.md § 2.6.3 steps 8–9)
// ---------------------------------------------------------------------------

/** Where the bytes stand when a dispatch fails — for `upload_interrupted`. */
export interface ChunkPosition {
  chunk: number;
  total: number;
}

export interface DispatchOptions {
  toolName: string;
  /** Journalled `mode` — the resolved upstream `post_mode` (§ 2.6.2). */
  mode: string;
  source: IntentSource;
  /** Text the duplicate guard excerpts; `''` for the tools that carry no title. */
  title: string;
  digest: string;
  /** `''` only under `TT_WRITE_MODE=apply` with no token — an honest record. */
  planId: string;
  openId: string;
  /**
   * The upstream half. Calls `report` the moment an init returns a `publish_id`,
   * which is what lets a later failure be classified as `upload_failed` (the
   * post exists) rather than `error` (it does not).
   */
  send: (report: (publishId: string) => void) => Promise<string>;
  /** Consulted only when an `upload_interrupted` has to name its chunk. */
  position?: () => ChunkPosition;
}

/**
 * Everything after the plan has been consumed: journal, dispatch, journal.
 *
 * Split out because from here on a failure is no longer "nothing happened" —
 * the record on disk is the only thing that can tell a user which.
 */
export async function dispatchWrite(
  ctx: ToolCtx,
  opts: DispatchOptions,
): Promise<ToolResult<AppliedData>> {
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
  // an attempt exists upstream regardless of what failed afterwards.
  let initialised: string | undefined;
  try {
    const publishId = await opts.send((id) => {
      initialised = id;
    });
    const recorded =
      intent.ok && (await writeOutcome({ result: 'ok', publish_id: publishId })).ok;
    const result: ToolResult<AppliedData> = {
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
    const failure = classifyDispatch(cause, initialised, opts);
    // Short-circuited on purpose: an outcome whose intent never reached the disk
    // is an orphan the reader drops anyway (§ 8.3).
    const recorded = intent.ok && (await writeOutcome(failure.outcome)).ok;
    const failed: ToolResult<AppliedData> = { ok: false, error: failure.error };
    if (!recorded) {
      failed.journal = 'unavailable';
      failed.hints = [journalUnavailableNote(initialised)];
    }
    return failed;
  }
}

/**
 * A dispatch failure, as the error the caller sees and the line the journal
 * keeps.
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
  initialised: string | undefined,
  opts: DispatchOptions,
): {
  error: ToolError;
  outcome: Omit<OutcomeRecord, 'v' | 'type' | 'attempt_id' | 'ts'>;
} {
  if (initialised !== undefined) {
    const at = opts.position?.() ?? { chunk: 0, total: 0 };
    if (isTikTokError(cause) && cause.code === 'upload_interrupted') {
      return {
        error: uploadInterruptedError(initialised, at.chunk, at.total, cause.message),
        outcome: {
          result: 'upload_failed',
          publish_id: initialised,
          error_code: 'upload_interrupted',
          chunk: at.chunk,
        },
      };
    }
    const error = publishToolError(cause);
    return {
      error,
      outcome: { result: 'error', publish_id: initialised, error_code: error.code },
    };
  }

  if (isTikTokError(cause) && cause.code === 'network_ambiguous') {
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
 */
export async function waitIfAsked(
  ctx: ToolCtx,
  result: ToolResult<AppliedData>,
  waitForCompletion: boolean,
): Promise<ToolResult<AppliedData>> {
  const { api } = ctx;
  const data = result.data;
  if (data === undefined) return result;

  const hints = result.hints ?? [];
  const laterPoll = (): Hint =>
    pollHint(
      data.publish_id,
      new Date(api.clock.now() + api.settings.statusPollIntervalMs).toISOString(),
    );

  if (!waitForCompletion) {
    hints.unshift(laterPoll());
    result.hints = hints;
    return result;
  }

  try {
    const polled = await pollPublishStatus(api, data.publish_id, {
      waitForCompletion: true,
      ...signalOpt(ctx),
    });
    data.status = polled.status.status;
    const [publicPostId] = polled.status.publicPostIds ?? [];
    if (publicPostId !== undefined) data.public_post_id = publicPostId;
    if (polled.timedOut) {
      hints.unshift(
        stillProcessingAfterApplyHint(
          data.publish_id,
          data.status,
          Math.round(api.settings.statusPollTimeoutMs / 1000),
        ),
      );
    }
  } catch {
    hints.unshift(laterPoll());
  }
  result.hints = hints;
  return result;
}
