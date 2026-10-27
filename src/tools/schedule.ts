/**
 * Local scheduled publishing, tool side (TOOLS.md § 2.10, § 3.9, § 3.14):
 * the `run_at` branch the four write tools take at apply time, and the two
 * tools that read and cancel the queue.
 *
 * `run_at` is a control field on the apply call. Everything up to step 4 of
 * § 2.6.3 runs as for an immediate apply — re-resolve, re-digest, the same
 * plan checks — and then, instead of the duplicate guard, the rate token and
 * the dispatch, the plan is consumed and the approved request is written to
 * `mcp/schedule`. Those three steps belong to the moment of publishing, so
 * the runner (`tiktok-mcp-ai run-queue`) performs them through the ordinary
 * apply path when the entry falls due.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import { canonicalProfileName } from '../core/config.js';
import { defineTool, toolInput, type ToolCtx } from '../mcp/define.js';
import { invalidParamsError, toolErrorFrom } from '../mcp/errors.js';
import { titleExcerpt } from '../mcp/journal.js';
import { CONTROL_FIELDS, planFailureError } from '../mcp/plan.js';
import { consumePlan, type PlanExpectation } from '../mcp/plan-store.js';
import type { Hint, ToolError, ToolResult } from '../mcp/result.js';
import {
  mintScheduleId,
  parseRunAt,
  readSchedule,
  resolveSchedulePath,
  SCHEDULE_ID_PATTERN,
  SCHEDULE_MAX_PENDING,
  SCHEDULE_STATUSES,
  scheduleOptionsFor,
  updateSchedule,
  type ScheduledEntry,
  type ScheduleStatus,
} from '../mcp/schedule.js';
import { fileChangedError, planLimits } from './publish-common.js';

/** The `run_at` row every write tool's schema carries. */
export const RUN_AT_ARG = z
  .string()
  .optional()
  .describe(
    'Schedule instead of publishing now: an ISO-8601 date-time with Z or an offset, up to 30 ' +
      'days ahead. Only on the apply call (with plan_id). The approved request is queued ' +
      'locally and published by `tiktok-mcp-ai run-queue`, which must run on THIS machine at ' +
      'or after that time (cron/launchd) — TikTok has no scheduling of its own.',
  );

/** `mode: "scheduled"` — the request is queued; nothing was sent. */
export interface ScheduledData {
  mode: 'scheduled';
  schedule_id: string;
  run_at: string;
  status: 'pending';
}

/** What the four write tools hand {@link schedulePlanned}. */
export interface ScheduleRequest {
  toolName: string;
  /** The parsed tool arguments, control fields included — stripped here. */
  args: Record<string, unknown>;
  runAt: string;
  planId: string | undefined;
  expectation: PlanExpectation;
  /** What `title_excerpt` is cut from, as for the journal. */
  title: string;
}

function scheduleOptions(ctx: ToolCtx): ReturnType<typeof scheduleOptionsFor> {
  return scheduleOptionsFor(ctx.api.settings, ctx.log);
}

function scheduleFullError(): ToolError {
  return {
    code: 'schedule_full',
    message:
      `The local publish schedule already holds ${String(SCHEDULE_MAX_PENDING)} pending ` +
      'entries. Cancel some with tiktok_cancel_scheduled, or let the runner publish them first.',
    retryable: false,
  };
}

/** The arguments the runner replays: no control field, `account` pinned. */
function storedArgs(
  args: Record<string, unknown>,
  profile: string,
): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        value !== undefined && key !== 'run_at' && !CONTROL_FIELDS.includes(key),
    ),
  );
  return { ...kept, account: profile };
}

function scheduledNote(runAt: string): Hint {
  return {
    type: 'note',
    text:
      `Queued for ${runAt}. Nothing is posted until \`tiktok-mcp-ai run-queue\` runs on this ` +
      'machine at or after that time — the machine must be on. Check with ' +
      'tiktok_list_scheduled; cancel with tiktok_cancel_scheduled.',
  };
}

/**
 * Queue an approved request (§ 2.10). The plan is consumed inside the queue
 * lock, so a plan that a concurrent apply won is never also queued, and a
 * queue that is full leaves the plan unspent for an immediate apply.
 */
export async function schedulePlanned(
  ctx: ToolCtx,
  req: ScheduleRequest,
): Promise<ToolResult<ScheduledData>> {
  const { api } = ctx;
  const now = api.clock.now();
  const parsed = parseRunAt(req.runAt, now);
  if (!parsed.ok) return { ok: false, error: invalidParamsError(parsed.problem) };
  const runAt = new Date(parsed.at).toISOString();

  const stamp = new Date(now).toISOString();
  const entry: ScheduledEntry = {
    schedule_id: mintScheduleId(api.clock),
    tool: req.toolName,
    profile: api.profile,
    open_id: req.expectation.openId,
    args: storedArgs(req.args, api.profile),
    payload_digest: req.expectation.digest,
    ...(req.expectation.fileIdentity === undefined
      ? {}
      : { file_identity: req.expectation.fileIdentity }),
    title_excerpt: titleExcerpt(req.title),
    run_at: runAt,
    created_at: stamp,
    updated_at: stamp,
    status: 'pending',
  };

  let refusal: ToolError | undefined;
  try {
    await updateSchedule(
      api.clock,
      (entries) => {
        if (
          entries.filter((e) => e.status === 'pending').length >= SCHEDULE_MAX_PENDING
        ) {
          refusal = scheduleFullError();
          return;
        }
        if (req.planId !== undefined) {
          const consumed = consumePlan(
            req.planId,
            req.expectation,
            api.clock,
            planLimits(ctx),
          );
          if (!consumed.ok) {
            refusal =
              consumed.reason === 'file_changed'
                ? fileChangedError()
                : planFailureError(consumed.reason, api.settings.planTtlS);
            return;
          }
        }
        entries.push(entry);
      },
      scheduleOptions(ctx),
    );
  } catch (cause) {
    return { ok: false, error: toolErrorFrom(cause) };
  }
  if (refusal !== undefined) return { ok: false, error: refusal };

  return {
    ok: true,
    data: {
      mode: 'scheduled',
      schedule_id: entry.schedule_id,
      run_at: runAt,
      status: 'pending',
    },
    hints: [scheduledNote(runAt)],
  };
}

// ---------------------------------------------------------------------------
// tiktok_list_scheduled (§ 3.9)
// ---------------------------------------------------------------------------

/** One entry as listed — the approval's payload stays in the file. */
export interface ScheduledSummary {
  schedule_id: string;
  tool: string;
  profile: string;
  title_excerpt: string;
  run_at: string;
  status: ScheduleStatus;
  created_at: string;
  updated_at: string;
  publish_id?: string;
  error?: { code: string; message: string };
}

export interface ListScheduledData {
  entries: ScheduledSummary[];
  schedule_path: string;
}

const LIST_DESCRIPTION =
  "List this server's local publish schedule: publishes queued with run_at, newest run_at " +
  'last. Statuses: "pending" (waiting for its time), "running" (a runner is applying it — if ' +
  'it stays there, check tiktok_list_publish_journal), "done" (publish_id set), "failed" ' +
  '(error says why; nothing was retried), "cancelled", "expired" (the runner reached it more ' +
  'than 24 h late). Local file only — no network call.';

const LIST_SCHEDULED_INPUT = toolInput({
  // Shadows the profile-selecting `account`, as in tiktok_list_publish_journal.
  account: z
    .string()
    .optional()
    .describe('Filter to one profile. Omit for all profiles.'),
  status: z
    .enum(SCHEDULE_STATUSES as [ScheduleStatus, ...ScheduleStatus[]])
    .optional()
    .describe('Filter to one status. Omit for all.'),
});

type ListScheduledInput = z.infer<typeof LIST_SCHEDULED_INPUT>;

function summaryOf(entry: ScheduledEntry): ScheduledSummary {
  return {
    schedule_id: entry.schedule_id,
    tool: entry.tool,
    profile: entry.profile,
    title_excerpt: entry.title_excerpt,
    run_at: entry.run_at,
    status: entry.status,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    ...(entry.publish_id === undefined ? {} : { publish_id: entry.publish_id }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

export const listScheduledTool = defineTool<ListScheduledInput, ListScheduledData>({
  name: 'tiktok_list_scheduled',
  title: 'List scheduled publishes',
  description: LIST_DESCRIPTION,
  package: 'publish',
  scopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: LIST_SCHEDULED_INPUT,
  handler: async (args, ctx): Promise<ToolResult<ListScheduledData>> => {
    const opts = scheduleOptions(ctx);
    let entries: ScheduledEntry[];
    try {
      entries = await readSchedule(opts);
    } catch (cause) {
      return { ok: false, error: toolErrorFrom(cause) };
    }
    const account =
      args.account === undefined
        ? undefined
        : canonicalProfileName(args.account) || undefined;
    const locked = ctx.api.settings.lockProfile;
    const matching = entries
      .filter((entry) => locked === undefined || entry.profile === locked)
      .filter((entry) => account === undefined || entry.profile === account)
      .filter((entry) => args.status === undefined || entry.status === args.status)
      .sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at));
    return {
      ok: true,
      data: {
        entries: matching.map(summaryOf),
        schedule_path: resolveSchedulePath(opts),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// tiktok_cancel_scheduled (§ 3.14)
// ---------------------------------------------------------------------------

export interface CancelScheduledData {
  schedule_id: string;
  status: 'cancelled';
}

const CANCEL_DESCRIPTION =
  'Cancel a pending scheduled publish (from tiktok_list_scheduled) before the runner reaches ' +
  'it. Local only: nothing was sent to TikTok, so nothing is undone there. An entry that is ' +
  'already running, done or failed cannot be cancelled — a post that exists stays.';

const CANCEL_SCHEDULED_INPUT = toolInput({
  schedule_id: z
    .string()
    .describe('The schedule_id returned by the apply call with run_at.'),
});

type CancelScheduledInput = z.infer<typeof CANCEL_SCHEDULED_INPUT>;

function notFoundError(): ToolError {
  return {
    code: 'schedule_not_found',
    message:
      'No scheduled publish has this schedule_id. List them with tiktok_list_scheduled.',
    retryable: false,
  };
}

export const cancelScheduledTool = defineTool<CancelScheduledInput, CancelScheduledData>({
  name: 'tiktok_cancel_scheduled',
  title: 'Cancel a scheduled publish',
  description: CANCEL_DESCRIPTION,
  package: 'publish-write',
  scopes: [],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: CANCEL_SCHEDULED_INPUT,
  handler: async (args, ctx): Promise<ToolResult<CancelScheduledData>> => {
    if (!SCHEDULE_ID_PATTERN.test(args.schedule_id)) {
      return { ok: false, error: notFoundError() };
    }
    const locked = ctx.api.settings.lockProfile;
    let refusal: ToolError | undefined;
    try {
      await updateSchedule(
        ctx.api.clock,
        (entries) => {
          const entry = entries.find(
            (e) =>
              e.schedule_id === args.schedule_id &&
              (locked === undefined || e.profile === locked),
          );
          if (entry === undefined) {
            refusal = notFoundError();
            return;
          }
          // Cancelling twice answers the same: the entry is cancelled.
          if (entry.status === 'cancelled') return;
          if (entry.status !== 'pending') {
            refusal = {
              code: 'schedule_not_cancellable',
              message:
                `This scheduled publish is ${entry.status}, so it can no longer be cancelled. ` +
                'Check tiktok_list_scheduled and tiktok_list_publish_journal for what happened.',
              retryable: false,
              details: { status: entry.status },
            };
            return;
          }
          entry.status = 'cancelled';
          entry.updated_at = new Date(ctx.api.clock.now()).toISOString();
        },
        scheduleOptions(ctx),
      );
    } catch (cause) {
      return { ok: false, error: toolErrorFrom(cause) };
    }
    if (refusal !== undefined) return { ok: false, error: refusal };
    return { ok: true, data: { schedule_id: args.schedule_id, status: 'cancelled' } };
  },
});
