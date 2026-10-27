/**
 * Elicitation-based consent for writes (TOOLS.md § 2.6.6, SECURITY.md
 * § Prompt-injection surface).
 *
 * `plan_id` proves a preview happened; it cannot prove a human approved it,
 * because a model can chain preview → apply in one turn. When the client
 * supports MCP elicitation, the apply step asks the human directly through an
 * `elicitation/create` form the model never sees the answer of before the
 * server does. `plan_id` stays the floor wherever the dialog is unavailable.
 *
 * This module owns the request shape, the dialog text and the error catalog.
 * The server owns the transport (`elicitInput`); the tools own *when* to ask.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import type {
  ClientCapabilities,
  ElicitRequestFormParams,
} from '@modelcontextprotocol/sdk/types.js';

import { titleExcerpt } from './journal.js';
import type { ToolError } from './result.js';

/** One post the dialog describes. Every field is server-owned or the caller's own argument. */
export interface ConsentItem {
  /** What happens, from a closed set of server texts ("Publish a video"). */
  action: string;
  /** Canonical profile name the write runs against. */
  account: string;
  /** The caller's title / caption, excerpted for the dialog. */
  text?: string;
  /** The resolved privacy level of a direct post. */
  privacy?: string;
}

/** What the human is asked to approve: one write, or a whole batch. */
export interface ConsentRequest {
  items: readonly ConsentItem[];
  /** Absolute ISO-8601 UTC when the apply queues instead of posting (§ 2.10). */
  runAt?: string;
}

/**
 * The human's answer. `declined` voids the plan; `cancelled` (the dialog was
 * dismissed, or timed out) leaves it valid — nobody said no.
 */
export type ConsentAnswer = 'approved' | 'declined' | 'cancelled';

/** Set on `ToolCtx` by the server when the client can show the dialog. */
export type ConsentAsk = (request: ConsentRequest) => Promise<ConsentAnswer>;

/** The one form field. Unchecked by default: approval is an act, not a default. */
export const CONSENT_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
  type: 'object',
  properties: {
    approve: {
      type: 'boolean',
      title: 'Approve',
      description: 'Check to let the server carry out exactly this request.',
      default: false,
    },
  },
  required: ['approve'],
};

/** How long the dialog may stay open before it counts as dismissed. */
export const CONSENT_TIMEOUT_MS = 300_000;

/**
 * True when the client declared form elicitation. The SDK normalizes the bare
 * `elicitation: {}` of older clients to `{ form: {} }`; a client that declared
 * only `url` mode cannot show the form.
 */
export function supportsConsentDialog(caps: ClientCapabilities | undefined): boolean {
  return caps?.elicitation?.form !== undefined;
}

function itemLine(item: ConsentItem): string {
  const parts = [`${item.action} on account '${item.account}'`];
  if (item.text !== undefined && item.text.trim() !== '') {
    parts.push(`"${titleExcerpt(item.text)}"`);
  }
  if (item.privacy !== undefined) parts.push(`privacy ${item.privacy}`);
  return parts.join(' — ');
}

/** The dialog text. Template plus the request's own values; never upstream content. */
export function consentMessage(request: ConsentRequest): string {
  const lines = [
    request.items.length === 1
      ? 'Approve this TikTok write? A published post cannot be withdrawn from here.'
      : `Approve these ${String(request.items.length)} TikTok writes? A published post cannot be withdrawn from here.`,
    ...request.items.map((item, index) =>
      request.items.length === 1
        ? itemLine(item)
        : `${String(index + 1)}. ${itemLine(item)}`,
    ),
  ];
  if (request.runAt !== undefined) {
    lines.push(`Scheduled for ${request.runAt} (queued locally, posted by run-queue).`);
  }
  return lines.join('\n');
}

/** Maps an `elicitation/create` result onto the three answers. */
export function consentAnswerOf(result: {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}): ConsentAnswer {
  if (result.action === 'cancel') return 'cancelled';
  if (result.action === 'accept' && result.content?.['approve'] === true)
    return 'approved';
  return 'declined';
}

// ---------------------------------------------------------------------------
// Catalog texts (TOOLS.md § 3.0)
// ---------------------------------------------------------------------------

/** The human said no. Non-retryable: the plan is void. */
export function consentDeclinedError(): ToolError {
  return {
    code: 'consent_declined',
    message:
      'The user declined this write in the confirmation dialog. Nothing was sent and the ' +
      'plan_id is now void. Do not retry; ask the user what to change, then preview again.',
    retryable: false,
  };
}

/** The dialog was dismissed or timed out. The plan is untouched. */
export function consentCancelledError(): ToolError {
  return {
    code: 'consent_cancelled',
    message:
      'The confirmation dialog was closed without an answer. Nothing was sent and the plan_id ' +
      'is still valid until it expires. Ask the user whether to go ahead; only if they say yes, ' +
      'call the tool again with the same arguments and plan_id.',
    retryable: false,
  };
}

/**
 * No dialog could be shown: the operator requires one and the client cannot
 * show it, or the request itself failed. The plan is untouched.
 */
export function consentUnavailableError(reason: 'unsupported' | 'failed'): ToolError {
  return {
    code: 'consent_unavailable',
    message:
      reason === 'unsupported'
        ? 'This server requires a confirmation dialog for every write (TT_ELICITATION=required) ' +
          'and this MCP client does not support elicitation. Nothing was sent. Use a client that ' +
          'supports elicitation, or ask the operator to change TT_ELICITATION.'
        : 'The confirmation dialog could not be shown (the elicitation request failed). Nothing ' +
          'was sent and the plan_id is still valid. Try the same call again once; if it fails ' +
          'again, tell the user.',
    retryable: false,
    details: { reason },
  };
}
