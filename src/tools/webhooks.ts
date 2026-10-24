/**
 * `tiktok_list_webhook_events` (TOOLS.md § 3.8) — the read side of the webhook
 * receiver (`mcp/webhook`): what TikTok pushed to this server, newest first.
 *
 * Like `tiktok_list_publish_journal` it is a closed-world local file read with
 * no scopes, and `account` is a filter, not a profile selection (§ 2.2
 * exception). An event whose `open_id` matched no local profile when it
 * arrived carries no account and is left out of an account-filtered answer.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { z } from 'zod';

import { canonicalProfileName, resolveEnvFilePath } from '../core/config.js';
import { defineTool, toolInput } from '../mcp/define.js';
import type { Hint, ToolResult } from '../mcp/result.js';
import {
  readWebhookLog,
  resolveWebhookLogPath,
  type WebhookRecord,
} from '../mcp/webhook.js';

export interface WebhookEventEntry {
  received_at: string;
  event: string;
  /** TikTok's event time, as ISO-8601 UTC. */
  created_at: string;
  account?: string;
  open_id: string;
  publish_id?: string;
  content: Record<string, unknown>;
}

export interface ListWebhookEventsData {
  /** Newest first. */
  events: WebhookEventEntry[];
  meta: {
    log_path: string;
    /** Matches before `limit` was applied. */
    total_matching: number;
    skipped_lines: number;
  };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

const DESCRIPTION =
  "Read the events TikTok pushed to this server's webhook receiver, newest first: event name " +
  '(e.g. "post.publish.complete", "post.publish.failed", "authorization.removed"), receipt and ' +
  'event time, account, publish_id and the event content. Filter by event, publish_id or ' +
  'account. Local file read; no network, no scopes required. Events arrive only while the ' +
  "server runs over HTTP with TT_WEBHOOK_PATH registered as the app's callback URL.";

const LIST_WEBHOOK_EVENTS_INPUT = toolInput({
  // Shadows the injected profile-selecting `account`, as the journal tool does.
  account: z
    .string()
    .optional()
    .describe('Filter to one profile. Omit for all profiles.'),
  event: z
    .string()
    .optional()
    .describe('Filter to one event name, e.g. "post.publish.complete".'),
  publish_id: z.string().optional().describe('Filter to the events of one publish.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe('Newest events to return.'),
});

type ListWebhookEventsInput = z.infer<typeof LIST_WEBHOOK_EVENTS_INPUT>;

function toEntry(record: WebhookRecord): WebhookEventEntry {
  const entry: WebhookEventEntry = {
    received_at: record.received_at,
    event: record.event,
    created_at: new Date(record.create_time * 1000).toISOString(),
    open_id: record.user_openid,
    content: record.content,
  };
  if (record.profile !== undefined) entry.account = record.profile;
  if (record.publish_id !== undefined) entry.publish_id = record.publish_id;
  return entry;
}

function noEventsNote(configured: boolean): Hint {
  if (configured) {
    return {
      type: 'note',
      text:
        'No webhook event has been received yet. Check that the public URL of TT_WEBHOOK_PATH is ' +
        'the callback URL registered for this app in the TikTok developer portal.',
    };
  }
  return {
    type: 'note',
    text:
      'No webhook event has been received on this machine, and this server has no receiver: ' +
      "set TT_WEBHOOK_PATH (with TT_TRANSPORT=http) and register its public URL as the app's " +
      'callback URL in the TikTok developer portal.',
  };
}

function skippedLinesNote(count: number): Hint {
  return {
    type: 'note',
    text: `${count} webhook log line(s) were unreadable and skipped; the events shown are intact.`,
  };
}

export const listWebhookEventsTool = defineTool<
  ListWebhookEventsInput,
  ListWebhookEventsData
>({
  name: 'tiktok_list_webhook_events',
  title: 'List received webhook events',
  description: DESCRIPTION,
  package: 'publish',
  scopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: LIST_WEBHOOK_EVENTS_INPUT,
  handler: async (args, ctx): Promise<ToolResult<ListWebhookEventsData>> => {
    const { settings } = ctx.api;
    const logPath = resolveWebhookLogPath(
      settings.envFile ?? resolveEnvFilePath(process.env),
    );
    const { records, skippedLines, exists } = await readWebhookLog(logPath);

    // The same spelling rule and lock behaviour as the journal tool's filter.
    const account =
      args.account === undefined
        ? undefined
        : canonicalProfileName(args.account) || undefined;
    const locked = settings.lockProfile;
    const matching = records.filter((record) => {
      if (locked !== undefined && record.profile !== locked) return false;
      if (account !== undefined && record.profile !== account) return false;
      if (args.event !== undefined && record.event !== args.event) return false;
      return args.publish_id === undefined || record.publish_id === args.publish_id;
    });

    const limit = args.limit ?? DEFAULT_LIMIT;
    const events = matching.slice().reverse().slice(0, limit).map(toEntry);

    const hints: Hint[] = [];
    if (!exists) hints.push(noEventsNote(settings.webhookPath !== undefined));
    if (skippedLines > 0) hints.push(skippedLinesNote(skippedLines));

    const result: ToolResult<ListWebhookEventsData> = {
      ok: true,
      data: {
        events,
        meta: {
          log_path: logPath,
          total_matching: matching.length,
          skipped_lines: skippedLines,
        },
      },
    };
    if (hints.length > 0) result.hints = hints;
    return result;
  },
});
