/**
 * The read half of the `publish` package: `tiktok_get_creator_info` (§ 3.5),
 * `tiktok_get_publish_status` (§ 3.6) and `tiktok_list_publish_journal`
 * (§ 3.7) — the three tools that answer questions about posting without ever
 * creating a post.
 *
 * The wait loop lives here rather than in `api/`: "how long may a tool block
 * before answering" is a tool-contract decision (§ 2.7), and both this file
 * and `tools/publish-write.ts` serve `wait_for_completion` from the same
 * {@link pollPublishStatus}.
 *
 * `tiktok_list_publish_journal` notes
 * ----------------------------------
 *
 * The one closed-world tool in the server: it consults no external system, so
 * `openWorldHint: false` and no scopes at all. It exists for exactly one
 * question — "did that publish actually go through?" — and it is the tool the
 * model is told to reach for *before* retrying anything ambiguous.
 *
 * Two contract details drive the shape of this file:
 *
 * - `account` is a **filter**, not a profile selection (§ 2.2 exception). The
 *   server wrapper knows this via `ACCOUNT_IS_FILTER` and leaves the argument
 *   alone; omitting it lists every profile's attempts, which is what an audit
 *   read should default to.
 * - The read-side outcome vocabulary is exactly `ok` · `error` ·
 *   `upload_failed` · `unknown`. The persisted `send_ambiguous` is presented as
 *   `unknown` because the operational advice is identical — the post MAY exist,
 *   verify before retrying. Only the doctor CLI keeps the two apart.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import type { ApiContext } from '../api/context.js';
import {
  auditRestrictionsActive,
  getCreatorInfo,
  getPublishStatus,
  isTerminalStatus,
  type PublishStatus,
} from '../api/publish.js';
import type { Clock } from '../core/clock.js';
import { defineTool, toolInput, type ToolCtx } from '../mcp/define.js';
import { invalidParamsError, publishToolError } from '../mcp/errors.js';
import {
  foldAttempts,
  journalExists,
  readMerged,
  resolveJournalPath,
  type FoldedOutcome,
  type JournalAttempt,
  type JournalOptions,
} from '../mcp/journal.js';
import {
  localRateLimitedError,
  localRateLimitedHint,
  takePublishToken,
  type RateLimitRefusal,
} from '../mcp/plan.js';
import type { Hint, ToolResult } from '../mcp/result.js';

/** The read-side vocabulary — `send_ambiguous` never reaches a caller. */
export type JournalOutcome = 'ok' | 'error' | 'upload_failed' | 'unknown';

export interface JournalEntry {
  ts: string;
  account: string;
  tool: string;
  title_excerpt: string;
  publish_id?: string;
  outcome: JournalOutcome;
  error_code?: string;
}

export interface ListJournalData {
  /** Newest first — an audit read is answering "what happened last?". */
  entries: JournalEntry[];
  meta: {
    journal_path: string;
    /** Matches before `limit` was applied, so the caller knows if it cut. */
    total_matching: number;
    /** Torn-tail or unknown-version lines the reader ignored (§ 8.3). */
    skipped_lines: number;
  };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const DESCRIPTION =
  "Read this server's local, append-only journal of publish attempts: timestamp, account, " +
  'tool, title excerpt, publish_id, and outcome. Outcomes: "ok" (upstream accepted the ' +
  'request), "error" (clean failure), "upload_failed" (init succeeded, upload aborted), ' +
  '"unknown" (the request was sent but no response was recorded — the post MAY exist; ' +
  'verify with tiktok_get_publish_status or tiktok_list_videos before retrying anything). ' +
  'Local file read; no network, no scopes required. Check this first before re-trying any ' +
  'failed or ambiguous publish. The journal only covers posts made through this server on ' +
  'this machine.';

const LIST_JOURNAL_INPUT = toolInput({
  // Deliberately shadows the injected profile-selecting `account` (§ 2.2
  // exception): here it narrows the answer instead of choosing who to ask.
  account: z
    .string()
    .optional()
    .describe('Filter to one profile. Omit for all profiles.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe('Newest entries to return.'),
  // Validated in the handler rather than with `.refine()`: a Zod effect
  // degrades the JSON Schema the model actually sees, and "a parsable
  // timestamp" is not expressible in JSON Schema anyway.
  since: z.string().optional().describe('Only entries at or after this UTC timestamp.'),
});

type ListJournalInput = z.infer<typeof LIST_JOURNAL_INPUT>;

/**
 * `send_ambiguous` folds into `unknown`. Both mean "sent, no confirmed answer",
 * and a caller that treated them differently would be inventing a distinction
 * the upstream never made.
 */
function present(outcome: FoldedOutcome): JournalOutcome {
  return outcome === 'send_ambiguous' ? 'unknown' : outcome;
}

function toEntry(attempt: JournalAttempt): JournalEntry {
  const entry: JournalEntry = {
    ts: attempt.ts,
    account: attempt.profile,
    tool: attempt.tool,
    title_excerpt: attempt.title_excerpt,
    outcome: present(attempt.outcome),
  };
  if (attempt.publish_id !== undefined) entry.publish_id = attempt.publish_id;
  if (attempt.error_code !== undefined) entry.error_code = attempt.error_code;
  return entry;
}

/** A first run has no file at all — an empty answer, not a missing one. */
function emptyJournalNote(): Hint {
  return {
    type: 'note',
    text:
      'No publish journal exists on this machine yet, so no post has been made through this ' +
      'server. This is not an error and nothing was lost.',
  };
}

/** The one outcome that costs the user a manual check — say so explicitly. */
function unknownOutcomeNote(count: number): Hint {
  return {
    type: 'note',
    text:
      `${count} of these attempts have outcome "unknown": the request was sent but no answer ` +
      'was recorded, so the post MAY exist. Verify with tiktok_get_publish_status (or ' +
      'tiktok_list_videos) before publishing the same content again.',
  };
}

/** Damage report: a truncated write, not a reason to distrust the rest. */
function skippedLinesNote(count: number): Hint {
  return {
    type: 'note',
    text:
      `${count} journal line(s) were unreadable and skipped — usually a truncated last write ` +
      'after a crash. The entries shown are intact; the journal may simply be missing one attempt.',
  };
}

// ---------------------------------------------------------------------------
// shared: the publish-bucket wait (§ 2.8) and the status wait loop (§ 2.7)
// ---------------------------------------------------------------------------

/** Longest single sleep, so a suspended process notices a jumped clock (CC-H1). */
const SLEEP_SLICE_MS = 1_000;

/** First hop of the documented 2 s → 5 s → 10 s ladder. */
const POLL_FIRST_DELAY_MS = 2_000;

/** Fraction of a poll delay drawn as jitter, from the injectable `random` seam. */
const POLL_JITTER_FRACTION = 0.2;

/**
 * The documented backoff ladder (§ 3.6) expressed against the configured base
 * interval: 2 s, then the base, then twice the base for every later hop. With
 * the default `TT_STATUS_POLL_INTERVAL_MS=5000` that is exactly "2 s, then 5 s,
 * then every 10 s"; lowering the setting compresses the whole ladder instead of
 * leaving a first hop that is longer than the steady state.
 */
export function pollDelayMs(step: number, baseMs: number): number {
  if (step <= 0) return Math.min(POLL_FIRST_DELAY_MS, baseMs);
  return step === 1 ? baseMs : baseMs * 2;
}

/**
 * Sleep `ms` as a chain of bounded sleeps, re-deriving the deadline from the
 * clock on every wake (CC-H1). Returns early — and reports it — when the
 * deadline passes while asleep, which is how a suspended laptop stops looking
 * like a fast poll loop.
 */
async function sleepBounded(
  clock: Clock,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const until = clock.now() + ms;
  for (let left = ms; left > 0; left = until - clock.now()) {
    await clock.sleep(Math.min(left, SLEEP_SLICE_MS), signal);
  }
}

/**
 * Take one publish-bucket token, waiting for it up to `TT_TIMEOUT_MS`.
 *
 * Reads delay instead of rejecting (§ 2.8): a `creator_info` call is not a
 * post, so making the model wait a few seconds is strictly better than handing
 * it a refusal it would immediately retry. Writes never come through here —
 * they take the token immediately or refuse.
 */
export async function awaitPublishToken(
  api: ApiContext,
  signal?: AbortSignal,
): Promise<RateLimitRefusal | undefined> {
  const { clock } = api;
  const deadline = clock.now() + api.settings.timeoutMs;
  for (;;) {
    const take = takePublishToken(api.profile, clock);
    if (take.ok) return undefined;
    const remaining = deadline - clock.now();
    if (remaining <= 0) return take.refusal;
    // At least 1 ms so a refusal that rounds to "now" cannot spin the loop.
    await sleepBounded(
      clock,
      Math.min(Math.max(take.refusal.retry_after_s * 1000, 1), remaining),
      signal,
    );
  }
}

export interface PollOptions {
  /** `false` performs exactly one status request (§ 2.7). */
  waitForCompletion: boolean;
  signal?: AbortSignal;
  /** Jitter source; defaults to `Math.random`. Tests inject a fixed stream. */
  random?: () => number;
}

export interface PollOutcome {
  status: PublishStatus;
  /** Epoch ms of the observation, for `checked_at`. */
  checkedAtMs: number;
  /** True when the loop stopped at the deadline rather than at a terminal status. */
  timedOut: boolean;
}

/**
 * Poll `publish_id` until a terminal status or the wait budget runs out.
 *
 * Two rules from § 2.7 shape it: **terminal-beats-deadline** — a terminal
 * status observed on the last request is returned as terminal, not as a
 * timeout — and **timeout-is-not-error** — running out of budget yields the
 * last observed status with `timedOut: true`, never a thrown error. The caller
 * turns that into `ok: true` plus a fresh `poll` hint.
 */
export async function pollPublishStatus(
  api: ApiContext,
  publishId: string,
  opts: PollOptions,
): Promise<PollOutcome> {
  const { clock } = api;
  const random = opts.random ?? Math.random;
  const deadline = clock.now() + api.settings.statusPollTimeoutMs;
  const base = api.settings.statusPollIntervalMs;
  const signalOpt = opts.signal === undefined ? {} : { signal: opts.signal };

  for (let step = 0; ; step += 1) {
    const status = await getPublishStatus(api, publishId, signalOpt);
    const checkedAtMs = clock.now();
    if (!opts.waitForCompletion || isTerminalStatus(status.status)) {
      return { status, checkedAtMs, timedOut: false };
    }
    const remaining = deadline - checkedAtMs;
    const delay = pollDelayMs(step, base);
    const jittered = delay * (1 + POLL_JITTER_FRACTION * (random() * 2 - 1));
    // A wait that would overshoot the deadline is not worth taking: the answer
    // it produces would arrive after the caller was promised a reply.
    if (remaining <= jittered) return { status, checkedAtMs, timedOut: true };
    await sleepBounded(clock, jittered, opts.signal);
  }
}

/** The journal wiring every publish tool uses — env file, size cap, logger. */
export function journalOptions(ctx: ToolCtx): JournalOptions {
  const { settings } = ctx.api;
  return {
    ...(settings.envFile === undefined ? {} : { envFile: settings.envFile }),
    maxBytes: settings.journalMaxBytes,
    logger: ctx.log,
  };
}

// ---------------------------------------------------------------------------
// tiktok_get_creator_info (§ 3.5)
// ---------------------------------------------------------------------------

export interface CreatorInfoData {
  creator: {
    nickname: string;
    privacy_level_options: readonly string[];
    comment_disabled: boolean;
    duet_disabled: boolean;
    stitch_disabled: boolean;
    max_video_post_duration_sec?: number;
  };
  /** `true` when the options are exactly `["SELF_ONLY"]` — an unaudited app. */
  audit_restrictions_active: boolean;
}

const CREATOR_INFO_DESCRIPTION =
  "Fetch the creator's live posting state: nickname, the privacy_level options currently " +
  'available, whether comments/duets/stitch are disabled account-wide, and the maximum allowed ' +
  'video duration. Requires scope video.publish; TikTok limit 20 requests/min. You do NOT need ' +
  'to call this before posting — the preview step of tiktok_post_video and tiktok_post_photos ' +
  'runs it automatically and embeds the result. Call it directly only to answer user questions ' +
  'about posting capabilities. If privacy_level_options contains only SELF_ONLY, the app is ' +
  'unaudited: every post will be visible to the account owner only, regardless of arguments.';

const CREATOR_INFO_INPUT = toolInput({});

type CreatorInfoInput = z.infer<typeof CREATOR_INFO_INPUT>;

/** The one fact a caller must not miss: nothing posted here will be public. */
export function auditRestrictionsNote(): Hint {
  return {
    type: 'note',
    text:
      "This app has not passed TikTok's audit: the only available privacy level is SELF_ONLY, " +
      'so every post will be visible to the account owner alone. Tell the user this before ' +
      'posting; only the developer passing the audit changes it.',
  };
}

export const getCreatorInfoTool = defineTool<CreatorInfoInput, CreatorInfoData>({
  name: 'tiktok_get_creator_info',
  title: 'Get creator posting state',
  description: CREATOR_INFO_DESCRIPTION,
  package: 'publish',
  scopes: ['video.publish'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: CREATOR_INFO_INPUT,
  handler: async (_args, ctx): Promise<ToolResult<CreatorInfoData>> => {
    // § 2.8: a read delays instead of rejecting. Only when the wait itself
    // outlives TT_TIMEOUT_MS does the refusal reach the caller.
    const refusal = await awaitPublishToken(ctx.api, ctx.signal);
    if (refusal !== undefined) {
      return {
        ok: false,
        error: localRateLimitedError(refusal),
        hints: [localRateLimitedHint(refusal)],
      };
    }

    const info = await getCreatorInfo(
      ctx.api,
      ctx.signal === undefined ? {} : { signal: ctx.signal },
    );
    const restricted = auditRestrictionsActive(info);

    const creator: CreatorInfoData['creator'] = {
      nickname: info.nickname,
      privacy_level_options: info.privacyLevelOptions,
      comment_disabled: info.commentDisabled,
      duet_disabled: info.duetDisabled,
      stitch_disabled: info.stitchDisabled,
      ...(info.maxVideoPostDurationSec === undefined
        ? {}
        : { max_video_post_duration_sec: info.maxVideoPostDurationSec }),
    };

    const result: ToolResult<CreatorInfoData> = {
      ok: true,
      data: { creator, audit_restrictions_active: restricted },
    };
    if (restricted) result.hints = [auditRestrictionsNote()];
    return result;
  },
});

// ---------------------------------------------------------------------------
// tiktok_get_publish_status (§ 3.6)
// ---------------------------------------------------------------------------

export interface PublishStatusData {
  /** Always present, including on a poll timeout — it is what a retry needs. */
  publish_id: string;
  status: string;
  fail_reason?: string;
  fail_recovery?: string;
  public_post_id?: string;
  uploaded_bytes?: number;
  downloaded_bytes?: number;
  checked_at: string;
}

const PUBLISH_STATUS_DESCRIPTION =
  'Check — and by default briefly wait on — the status of a publish attempt by publish_id. ' +
  'Read-only, idempotent, safe to repeat; TikTok limit 30 requests/min. Statuses: ' +
  'PROCESSING_DOWNLOAD (pulling from URL), PROCESSING_UPLOAD (checking the uploaded file), ' +
  'SEND_TO_USER_INBOX (draft delivered — the user must open the TikTok app notification to ' +
  'finish), PUBLISH_COMPLETE (live; public_post_id present when TikTok exposes it), FAILED ' +
  '(fail_reason mapped to a recovery action in the result). With wait_for_completion: true (the ' +
  'default) the call polls on a backoff schedule (2 s, then 5 s, then every 10 s, with jitter) ' +
  'up to ~60 s and returns the last observed status; a timeout is NOT a failure — call again ' +
  'with the same publish_id. Never re-run a posting tool just because processing is slow.';

const PUBLISH_STATUS_INPUT = toolInput({
  publish_id: z
    .string()
    .min(1)
    .describe(
      'The publish_id returned by a posting tool (or found in tiktok_list_publish_journal).',
    ),
  wait_for_completion: z
    .boolean()
    .optional()
    .describe(
      'true (default) = poll internally until a terminal status or ~60 s, then return the last ' +
        'observed status. false = one status request, return immediately.',
    ),
});

type PublishStatusInput = z.infer<typeof PUBLISH_STATUS_INPUT>;

/**
 * Appendix A — `fail_reason` → recovery text.
 *
 * Two texts deviate from the table on purpose, because the placeholder they
 * carry is not available at this call site: `duration_check_failed` points at
 * `tiktok_get_creator_info` instead of interpolating
 * `max_video_post_duration_sec` (the status endpoint reports no creator data,
 * and this tool may run on a `video.upload`-only profile that cannot ask), and
 * `internal` names the publish_id instead of a `log_id` (the upstream envelope
 * carries `log_id` only on failures, and a reported FAILED status is a success
 * at the HTTP level). Everything else is verbatim.
 */
function failRecovery(reason: string): string {
  switch (reason) {
    case 'file_format_check_failed':
      return (
        'The file is not a format TikTok accepts (MP4/WebM/MOV). Re-encode and post again with ' +
        'a fresh preview.'
      );
    case 'duration_check_failed':
      return (
        "Video duration is outside this account's allowed range (call tiktok_get_creator_info " +
        'for max_video_post_duration_sec). Trim or re-encode.'
      );
    case 'frame_rate_check_failed':
      return "Frame rate is outside TikTok's 23–60 FPS range. Re-encode.";
    case 'picture_size_check_failed':
      return "Dimensions are outside TikTok's limits (videos 360–4096 px; photos up to 1080p). Resize.";
    case 'video_pull_failed':
    case 'photo_pull_failed':
      return (
        'TikTok could not download the media URL. It must be HTTPS, serve the bytes without ' +
        'redirects, and stay reachable for about an hour. Fix the hosting and post again.'
      );
    case 'publish_cancelled':
      return 'The user cancelled this post in the TikTok app. Nothing to retry.';
    case 'auth_removed':
      return (
        "The user revoked this app's access in TikTok settings. Ask the user to run the login " +
        'CLI again.'
      );
    case 'spam_risk_text':
      return (
        "TikTok's spam filter rejected the title or description wording. Change the text and " +
        'post again.'
      );
    case 'spam_risk':
    case 'spam_risk_too_many_posts':
      return 'TikTok applied an account-level posting throttle. Do not retry today.';
    case 'internal':
      return (
        'TikTok internal error. A later retry with a fresh preview may succeed. Quote this ' +
        'publish_id and the time of the attempt if the user contacts TikTok support.'
      );
    default:
      return (
        `TikTok reported an unrecognized failure code '${reason}'. Treat the post as not ` +
        'published; verify with tiktok_list_videos before retrying.'
      );
  }
}

/** A draft landed in the inbox: only the user, in the app, can finish it. */
function inboxUserActionHint(): Hint {
  return {
    type: 'user_action',
    action: 'open_tiktok_app',
    text:
      'The draft reached the account inbox. Ask the user to open the TikTok app notification ' +
      'and finish the post there — this server cannot publish it, and re-posting would create ' +
      'a second draft.',
  };
}

/** Poll timeout: still processing, still fine. Re-ask, never re-post. */
function stillProcessingHint(publishId: string, pollAfter: string): Hint {
  return {
    type: 'poll',
    tool: 'tiktok_get_publish_status',
    publish_id: publishId,
    poll_after: pollAfter,
    text:
      `Still processing. Call tiktok_get_publish_status with publish_id "${publishId}" after ` +
      `${pollAfter} to confirm the post went live. Do not re-post.`,
  };
}

export const getPublishStatusTool = defineTool<PublishStatusInput, PublishStatusData>({
  name: 'tiktok_get_publish_status',
  title: 'Get publish status',
  description: PUBLISH_STATUS_DESCRIPTION,
  package: 'publish',
  // TikTok answers `/publish/status/fetch/` for either grant, and a
  // draft-only installation holds only `video.upload` (§ 3.6).
  scopes: [],
  scopesAnyOf: ['video.publish', 'video.upload'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: PUBLISH_STATUS_INPUT,
  handler: async (args, ctx): Promise<ToolResult<PublishStatusData>> => {
    const publishId = args.publish_id;
    let outcome;
    try {
      outcome = await pollPublishStatus(ctx.api, publishId, {
        waitForCompletion: args.wait_for_completion ?? true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (cause) {
      // `invalid_publish_id` is the one upstream code with a tool-specific
      // catalog entry; everything else keeps the shared mapping.
      return { ok: false, error: publishToolError(cause) };
    }

    const { status } = outcome;
    const publicPostId = status.publicPostIds?.[0];
    const data: PublishStatusData = {
      publish_id: publishId,
      status: status.status,
      ...(status.failReason === undefined
        ? {}
        : {
            fail_reason: status.failReason,
            fail_recovery: failRecovery(status.failReason),
          }),
      ...(publicPostId === undefined ? {} : { public_post_id: publicPostId }),
      ...(status.uploadedBytes === undefined
        ? {}
        : { uploaded_bytes: status.uploadedBytes }),
      ...(status.downloadedBytes === undefined
        ? {}
        : { downloaded_bytes: status.downloadedBytes }),
      checked_at: new Date(outcome.checkedAtMs).toISOString(),
    };

    const hints: Hint[] = [];
    if (status.status === 'SEND_TO_USER_INBOX') hints.push(inboxUserActionHint());
    if (outcome.timedOut) {
      const pollAfter = new Date(
        outcome.checkedAtMs + ctx.api.settings.statusPollIntervalMs,
      ).toISOString();
      hints.push(stillProcessingHint(publishId, pollAfter));
    }

    const result: ToolResult<PublishStatusData> = { ok: true, data };
    if (hints.length > 0) result.hints = hints;
    return result;
  },
});

// ---------------------------------------------------------------------------
// tiktok_list_publish_journal (§ 3.7)
// ---------------------------------------------------------------------------

export const listPublishJournalTool = defineTool<ListJournalInput, ListJournalData>({
  name: 'tiktok_list_publish_journal',
  title: 'List publish journal entries',
  description: DESCRIPTION,
  package: 'publish',
  scopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // The only closed-world tool: a local file read, fully determined by this
    // server's own prior writes.
    openWorldHint: false,
  },
  input: LIST_JOURNAL_INPUT,
  handler: async (args, ctx): Promise<ToolResult<ListJournalData>> => {
    const sinceMs = args.since === undefined ? undefined : Date.parse(args.since);
    if (sinceMs !== undefined && !Number.isFinite(sinceMs))
      return {
        ok: false,
        error: invalidParamsError(
          'since must be an ISO-8601 UTC timestamp, e.g. "2026-01-01T00:00:00Z"',
        ),
      };

    const opts = journalOptions(ctx);
    const journalPath = resolveJournalPath(opts);

    // No `limit` here: `readMerged` limits *records*, which can cut an intent
    // away from its outcome and turn a finished attempt into a false
    // "unknown". Fold everything, then limit whole attempts.
    const { records, skippedLines } = await readMerged(opts);
    const attempts = foldAttempts(records);

    const matching = attempts.filter((attempt) => {
      if (args.account !== undefined && attempt.profile !== args.account) return false;
      if (sinceMs === undefined) return true;
      const at = Date.parse(attempt.ts);
      // An unparsable timestamp survived the record validator but cannot be
      // compared; keeping it out of a bounded window is the honest answer.
      return Number.isFinite(at) && at >= sinceMs;
    });

    const limit = args.limit ?? DEFAULT_LIMIT;
    const newestFirst = matching.slice().reverse();
    const entries = newestFirst.slice(0, limit).map(toEntry);

    const hints: Hint[] = [];
    if (attempts.length === 0 && !(await journalExists(opts)))
      hints.push(emptyJournalNote());
    const unknowns = entries.filter((entry) => entry.outcome === 'unknown').length;
    if (unknowns > 0) hints.push(unknownOutcomeNote(unknowns));
    if (skippedLines > 0) hints.push(skippedLinesNote(skippedLines));

    const result: ToolResult<ListJournalData> = {
      ok: true,
      data: {
        entries,
        meta: {
          journal_path: journalPath,
          total_matching: matching.length,
          skipped_lines: skippedLines,
        },
      },
    };
    if (hints.length > 0) result.hints = hints;
    return result;
  },
});
