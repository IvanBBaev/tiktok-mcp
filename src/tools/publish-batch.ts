/**
 * `tiktok_publish_batch` (TOOLS.md § 2.11, § 3.15): one plan for up to ten
 * publishes across profiles, approved once, applied item by item.
 *
 * The batch owns no publishing logic. Its preview runs each item's own tool
 * preview through `ctx.call` — the same path an MCP call takes, so account
 * resolution, scopes, `TT_LOCK_PROFILE` and creator_info are per item — and
 * mints one batch plan over the request, remembering the item plans behind
 * it. The apply spends the batch plan and applies every item with its own
 * plan, so each item still gets the whole § 2.6.3 pipeline: digest, open_id
 * and file checks, the duplicate guard, the per-profile rate bucket and the
 * journal. A failed item does not stop the others; the result lists each.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import { canonicalProfileName } from '../core/config.js';
import { defineTool, toolInput, type AnyToolSpec, type ToolCtx } from '../mcp/define.js';
import { invalidParamsError } from '../mcp/errors.js';
import {
  CONTROL_FIELDS,
  payloadDigest,
  peekPublishBucket,
  planFailureError,
  publishRateLimits,
  resolveWriteStep,
} from '../mcp/plan.js';
import { consumePlan, PLAN_ID_PATTERN, type PlanExpectation } from '../mcp/plan-store.js';
import type { Hint, ToolError, ToolResult } from '../mcp/result.js';
import { mintPlan, planLimits } from './publish-common.js';
import { postPhotosTool, uploadPhotosDraftTool } from './publish-photos.js';
import { postVideoTool, uploadVideoDraftTool } from './publish-write.js';
import { RUN_AT_ARG } from './schedule.js';

const TOOL_NAME = 'tiktok_publish_batch';

/** Most items one batch may hold. */
export const BATCH_MAX_ITEMS = 10;

/** The tools an item may name, in TOOLS.md order. */
const ITEM_TOOLS: readonly AnyToolSpec[] = [
  postVideoTool,
  uploadVideoDraftTool,
  postPhotosTool,
  uploadPhotosDraftTool,
];

const ITEM_TOOL_NAMES = ITEM_TOOLS.map((spec) => spec.name) as [string, ...string[]];

/** Batch plan → its items' plans, in item order. Bounded like the plan store. */
const itemPlans = new Map<string, readonly string[]>();
const MAX_REMEMBERED_BATCHES = 64;

function rememberItemPlans(batchPlanId: string, planIds: readonly string[]): void {
  itemPlans.set(batchPlanId, planIds);
  // A batch that is never applied leaves its entry behind; its plans expire in
  // the plan store anyway, so the oldest entry is the one to forget.
  if (itemPlans.size > MAX_REMEMBERED_BATCHES) {
    const oldest = itemPlans.keys().next().value as string;
    itemPlans.delete(oldest);
  }
}

/** Test seam: forget every remembered batch. */
export function resetBatchPlans(): void {
  itemPlans.clear();
}

const DESCRIPTION =
  'Publish up to 10 videos/photo posts in one approval — across several profiles or files. ' +
  'Each item is { tool, args } for tiktok_post_video, tiktok_upload_video_draft, ' +
  'tiktok_post_photos or tiktok_upload_photos_draft, with that tool’s own arguments (account ' +
  'picks the profile; omitted, the batch’s account). Call without plan_id for one preview ' +
  'of every item; after the user approves it, call again with the same items plus plan_id. ' +
  'Each item is applied with its own checks and rate limit; one failing does not stop the rest.';

const ITEM = z
  .object({
    tool: z.enum(ITEM_TOOL_NAMES).describe('The write tool this item runs.'),
    args: z
      .record(z.string(), z.unknown())
      .describe(
        'That tool’s arguments, as for a direct preview call (no plan_id, run_at, force or ' +
          'wait_for_completion).',
      ),
  })
  .strict();

const PUBLISH_BATCH_INPUT = toolInput({
  items: z
    .array(ITEM)
    .min(1)
    .max(BATCH_MAX_ITEMS)
    .describe('The publishes, 1–10, applied in this order.'),
  plan_id: z
    .string()
    .optional()
    .describe(
      'Omit to preview. To apply, the plan_id from the batch preview, after the user approved it.',
    ),
  run_at: RUN_AT_ARG,
});

type PublishBatchInput = z.infer<typeof PUBLISH_BATCH_INPUT>;

/** One item of a preview: its tool's preview, minus the item plan. */
export interface BatchPreviewItem {
  index: number;
  tool: string;
  account?: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: ToolError;
}

/** One item of an apply: what its tool's apply returned. */
export interface BatchAppliedItem {
  index: number;
  tool: string;
  account: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: ToolError;
}

export type PublishBatchData =
  | {
      mode: 'plan';
      plan_id: string;
      expires_at: string;
      items: BatchPreviewItem[];
    }
  | { mode: 'plan_incomplete'; items: BatchPreviewItem[] }
  | {
      mode: 'applied';
      items: BatchAppliedItem[];
      succeeded: number;
      failed: number;
    };

/** An item as previewed and applied: `account` resolved, nothing else added. */
interface ResolvedItem {
  tool: AnyToolSpec;
  args: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pins every item to a profile and refuses control fields in item arguments. */
function resolveItems(
  args: PublishBatchInput,
  ctx: ToolCtx,
): { ok: true; items: ResolvedItem[] } | { ok: false; error: ToolError } {
  const items: ResolvedItem[] = [];
  for (const [index, item] of args.items.entries()) {
    const control = CONTROL_FIELDS.find((field) => Object.hasOwn(item.args, field));
    if (control !== undefined) {
      return {
        ok: false,
        error: invalidParamsError(
          `items[${String(index)}].args.${control}: set on the batch call, not on an item`,
        ),
      };
    }
    const tool = ITEM_TOOLS.find((spec) => spec.name === item.tool) as AnyToolSpec;
    const account = item.args['account'];
    items.push({
      tool,
      args: {
        ...item.args,
        account: typeof account === 'string' ? account : ctx.api.profile,
      },
    });
  }
  return { ok: true, items };
}

/** What the batch plan binds: the items as they will be replayed. */
function batchExpectation(items: readonly ResolvedItem[], ctx: ToolCtx): PlanExpectation {
  return {
    digest: payloadDigest(
      items.map((item) => ({ tool: item.tool.name, args: item.args })),
    ),
    profile: ctx.api.profile,
    // The items bind their own open_id; the batch binds only the request.
    openId: '',
    tool: TOOL_NAME,
  };
}

function callerOf(ctx: ToolCtx): NonNullable<ToolCtx['call']> {
  const { call } = ctx;
  if (call === undefined) {
    throw new Error(`${TOOL_NAME} needs ToolCtx.call — run it through callTool`);
  }
  return call;
}

function accountOf(result: ToolResult<unknown>): string | undefined {
  const meta = isRecord(result.data) ? result.data['meta'] : undefined;
  const account = isRecord(meta) ? meta['account'] : undefined;
  return typeof account === 'string' ? account : undefined;
}

/**
 * One warning naming every profile that gets more items than its local bucket
 * holds now: the surplus would be refused `local_rate_limited` at apply time.
 */
function rateNote(items: readonly BatchPreviewItem[], ctx: ToolCtx): Hint | undefined {
  const perProfile = new Map<string, number>();
  for (const item of items) {
    if (item.account !== undefined) {
      perProfile.set(item.account, (perProfile.get(item.account) ?? 0) + 1);
    }
  }
  const over: string[] = [];
  for (const [profile, count] of perProfile) {
    const { tokens_available: available } = peekPublishBucket(
      profile,
      ctx.api.clock,
      publishRateLimits(ctx.api.settings),
    );
    if (count > available) {
      over.push(
        `${String(count)} items publish on '${profile}', which allows ${String(available)} now`,
      );
    }
  }
  if (over.length === 0) return undefined;
  return {
    type: 'note',
    text:
      `Local rate limit: ${over.join('; ')}. The surplus will fail with local_rate_limited; ` +
      'apply those items later on their own.',
  };
}

async function previewBatch(
  items: readonly ResolvedItem[],
  ctx: ToolCtx,
): Promise<ToolResult<PublishBatchData>> {
  const call = callerOf(ctx);
  const previews: BatchPreviewItem[] = [];
  const planIds: string[] = [];
  for (const [index, item] of items.entries()) {
    ctx.progress?.(index, items.length);
    const result = await call(item.tool, item.args);
    const account = accountOf(result);
    const base = {
      index,
      tool: item.tool.name,
      ...(account === undefined ? {} : { account }),
    };
    if (!result.ok) {
      previews.push({ ...base, ok: false, error: result.error });
      continue;
    }
    const data = result.data as Record<string, unknown>;
    const rest = { ...data };
    delete rest['plan_id'];
    delete rest['expires_at'];
    const planId = data['plan_id'];
    if (data['mode'] === 'plan' && typeof planId === 'string') planIds.push(planId);
    previews.push({ ...base, ok: true, data: rest });
  }
  ctx.progress?.(items.length, items.length);

  if (planIds.length !== items.length) {
    return {
      ok: true,
      data: { mode: 'plan_incomplete', items: previews },
      hints: [
        {
          type: 'note',
          text:
            'Not every item previewed as a plan — see each item’s error or plan_incomplete. ' +
            'Fix those items and preview the whole batch again; no plan_id was issued.',
        },
      ],
    };
  }

  const plan = mintPlan(ctx, TOOL_NAME, batchExpectation(items, ctx).digest, '');
  rememberItemPlans(plan.planId, planIds);
  const note = rateNote(previews, ctx);
  return {
    ok: true,
    data: {
      mode: 'plan',
      plan_id: plan.planId,
      expires_at: plan.expiresAt,
      items: previews,
    },
    hints: note === undefined ? [plan.hint] : [plan.hint, note],
  };
}

async function applyBatch(
  args: PublishBatchInput,
  items: readonly ResolvedItem[],
  ctx: ToolCtx,
  planId: string | undefined,
): Promise<ToolResult<PublishBatchData>> {
  const { api } = ctx;
  const call = callerOf(ctx);

  let planIds: readonly (string | undefined)[] = items.map(() => undefined);
  if (planId !== undefined) {
    const consumed = consumePlan(
      planId,
      batchExpectation(items, ctx),
      api.clock,
      planLimits(ctx),
    );
    const remembered = itemPlans.get(planId);
    // A refused apply (wrong items, say) leaves the plan valid for a retry.
    if (consumed.ok) itemPlans.delete(planId);
    if (!consumed.ok || remembered === undefined) {
      const reason = consumed.ok ? 'unknown' : consumed.reason;
      return { ok: false, error: planFailureError(reason, api.settings.planTtlS) };
    }
    planIds = remembered;
  }

  const applied: BatchAppliedItem[] = [];
  for (const [index, item] of items.entries()) {
    ctx.progress?.(index, items.length);
    const itemPlan = planIds[index];
    const result = await call(item.tool, {
      ...item.args,
      ...(itemPlan === undefined ? {} : { plan_id: itemPlan }),
      ...(args.run_at === undefined ? {} : { run_at: args.run_at }),
    });
    const base = {
      index,
      tool: item.tool.name,
      account: accountOf(result) ?? canonicalProfileName(String(item.args['account'])),
    };
    applied.push(
      result.ok
        ? { ...base, ok: true, data: result.data as Record<string, unknown> }
        : { ...base, ok: false, error: result.error },
    );
  }
  ctx.progress?.(items.length, items.length);

  const failed = applied.filter((item) => !item.ok).length;
  const hints: Hint[] = [];
  if (failed > 0) {
    hints.push({
      type: 'note',
      text:
        `${String(failed)} of ${String(items.length)} items failed — see each item's error. ` +
        'The others went ahead. To retry one, preview it again with its own tool.',
    });
  }
  return {
    ok: true,
    data: { mode: 'applied', items: applied, succeeded: items.length - failed, failed },
    hints,
  };
}

export const publishBatchTool = defineTool<PublishBatchInput, PublishBatchData>({
  name: TOOL_NAME,
  title: 'Publish several posts in one approval',
  description: DESCRIPTION,
  package: 'publish-write',
  // Each item checks its own tool's scopes on its own profile.
  scopes: [],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: PUBLISH_BATCH_INPUT,
  handler: async (args, ctx): Promise<ToolResult<PublishBatchData>> => {
    if (args.plan_id !== undefined && !PLAN_ID_PATTERN.test(args.plan_id)) {
      return {
        ok: false,
        error: invalidParamsError(
          'plan_id: not a plan_id this tool issued — call without plan_id to get a fresh preview',
        ),
      };
    }
    const resolved = resolveItems(args, ctx);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const decision = resolveWriteStep(args.plan_id, ctx.api.settings.writeMode);
    return decision.step === 'preview'
      ? await previewBatch(resolved.items, ctx)
      : await applyBatch(args, resolved.items, ctx, decision.planId);
  },
});
