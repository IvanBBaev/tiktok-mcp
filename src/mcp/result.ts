/**
 * The result envelope every tool returns (CONTRACTS.md § `mcp/result.ts`,
 * TOOLS.md §§ 2.1, 2.4, 5) and the char-budget truncation that keeps it
 * inside `TT_RESULT_CHAR_BUDGET`.
 *
 * Two rules drive the whole file:
 *
 * - **The output is always valid JSON (CC-G2).** Truncation drops whole
 *   trailing items and stamps a marker; it NEVER slices the serialized text,
 *   which is also why a UTF-16 surrogate pair can never be cut in half.
 * - **`ok`, `error` and `hints` survive (CC-G7).** They are the fields a model
 *   needs to decide what to do next; a payload that does not fit is dropped
 *   before any of them is touched. When even the bare envelope exceeds the
 *   budget, validity wins and the budget is exceeded — a truthful oversized
 *   answer beats a corrupt small one.
 *
 * Redaction runs first, on the whole tree, so nothing added by truncation can
 * re-introduce a secret and no secret can be split across the elision point
 * (TOOLS.md §§ 2.4, 2.5).
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { TikTokError } from '../core/errors.js';
import { redactText } from '../core/redact.js';

/** Closed vocabulary — six hint types, no upstream text interpolation. */
export type HintType =
  'wait' | 'poll' | 'approval_required' | 'user_action' | 'reauth' | 'note';

export const HINT_TYPES: readonly HintType[] = Object.freeze([
  'wait',
  'poll',
  'approval_required',
  'user_action',
  'reauth',
  'note',
] as const);

export interface Hint {
  type: HintType;
  /** Model-facing sentence(s), ≤ 300 chars (TOOLS.md § 5.2). */
  text: string;
  // Structured fields per type (TOOLS.md § 5.1); each is present only for the
  // hint types that declare it, and absent otherwise.
  /** wait */
  retry_after_s?: number;
  /** wait — absolute ISO-8601 UTC */
  retry_at?: string;
  /** poll — exact tool name, e.g. "tiktok_get_publish_status" */
  tool?: string;
  /** poll */
  publish_id?: string;
  /** poll — absolute ISO-8601 UTC */
  poll_after?: string;
  /** approval_required */
  plan_id?: string;
  /** approval_required — absolute ISO-8601 UTC */
  expires_at?: string;
  /** user_action */
  action?:
    | 'login'
    | 'open_tiktok_app'
    | 'move_file'
    | 'host_media'
    | 'configure_server'
    | 'wait_for_audit';
  /** reauth — exact CLI line */
  command?: string;
  /** reauth */
  profile?: string;
}

export interface ToolError {
  /** Stable machine code from the TOOLS.md § 3.0 catalog. */
  code: string;
  /** Normative catalog text (substring-tested). */
  message: string;
  /** Mirrors `TikTokError.retryable` / the catalog column. */
  retryable: boolean;
  /** Upstream log_id, when present. */
  log_id?: string;
  /**
   * Open extension bag. The upstream error code lives at `details.api_code`
   * when kind === "api" (CC-B9).
   */
  details?: Record<string, unknown>;
}

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: ToolError;
  hints?: Hint[];
  /** Journal append failed — never a publish failure. */
  journal?: 'unavailable';
}

/** `data.meta.truncation` (TOOLS.md § 2.4). */
export interface TruncationInfo {
  truncated: true;
  /**
   * Why the collection is short. `char_budget` is stamped here, by the
   * truncator; the other two are stamped by a tool that stopped on its own —
   * `item_cap` when it hit its configured ceiling (resume and you get more),
   * `cursor_stuck` when the upstream stopped paginating (resume and you get the
   * same page again, which is why that case carries no `resume_cursor`).
   */
  reason: 'char_budget' | 'item_cap' | 'cursor_stuck';
  /** Items still present in the elided collection. */
  returned: number;
  /** Only when the tool knows how to resume; never invented by the truncator. */
  resume_cursor?: string;
}

export interface TruncateOptions {
  /** `TT_PRETTY_JSON=1` — indent the text block (and pay for it in budget). */
  pretty?: boolean;
}

/** Result plus the exact text that mirrors it — the two never drift. */
export interface TruncatedResult {
  /** The redacted (and possibly elided) envelope, for `structuredContent`. */
  result: ToolResult<unknown>;
  /** `JSON.stringify` of {@link result}, for the mirroring text block. */
  text: string;
  /** True when items or the payload were dropped to fit the budget. */
  truncated: boolean;
}

/** TOOLS.md § 5.2 — at most three hints per result. */
const MAX_HINTS = 3;

/** TOOLS.md § 5.2 — a hint sentence never exceeds 300 characters. */
const MAX_HINT_CHARS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Snapshot the envelope as a pure JSON tree, so every later step operates on
 * exactly what the client will see (`toJSON`, `undefined` fields and class
 * instances are already resolved). A non-serializable result is a handler bug.
 */
function toJsonTree(result: ToolResult<unknown>): ToolResult<unknown> {
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    throw new TikTokError({
      kind: 'internal',
      code: 'result_not_serializable',
      message: 'The tool produced a result that cannot be serialized to JSON.',
      retryable: false,
      remediation: 'This is a bug in the server; please report it with the tool name.',
    });
  }
  return JSON.parse(json) as ToolResult<unknown>;
}

/**
 * Apply `redactText` to every string *value* in the tree. Keys are field names
 * chosen by this server or by the TikTok API and are never secrets, so they
 * are left alone (which also keeps this linear in the number of values).
 */
function scrubTree(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(scrubTree);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrubTree(val);
    return out;
  }
  return value;
}

function normalizeBudget(budgetChars: number): number {
  if (!Number.isFinite(budgetChars)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(budgetChars));
}

/** Append a `note` hint, unless the result already carries the maximum of three. */
function withNote(hints: Hint[] | undefined, text: string): Hint[] | undefined {
  const existing = hints ?? [];
  if (existing.length >= MAX_HINTS) return hints;
  return [...existing, { type: 'note', text }];
}

function elisionNote(
  returned: number,
  total: number,
  budget: number,
  cursor?: string,
): string {
  const head = `Result truncated to fit the ${budget}-character response budget: ${returned} of ${total} items returned.`;
  const withCursor = `${head} Call the same tool again with cursor "${cursor}" for the rest.`;
  if (cursor !== undefined && withCursor.length <= MAX_HINT_CHARS) return withCursor;
  return `${head} Narrow the request (fewer ids, a smaller page size) to see the rest.`;
}

function dropNote(budget: number): string {
  return (
    `The result did not fit the ${budget}-character response budget and its payload was omitted; ` +
    'only the outcome and these hints are returned. Narrow the request and call again.'
  );
}

/** The `data` key holding the biggest serialized array, if any. */
function largestArrayKey(data: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  let bestSize = -1;
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const size = JSON.stringify(value).length;
    if (size > bestSize) {
      best = key;
      bestSize = size;
    }
  }
  return best;
}

function existingTruncation(data: unknown): TruncationInfo | undefined {
  if (!isRecord(data) || !isRecord(data['meta'])) return undefined;
  const marker = data['meta']['truncation'];
  return isRecord(marker) ? (marker as unknown as TruncationInfo) : undefined;
}

function markerFor(
  previous: TruncationInfo | undefined,
  returned: number,
): TruncationInfo {
  const marker: TruncationInfo = { truncated: true, reason: 'char_budget', returned };
  if (previous?.resume_cursor !== undefined)
    marker.resume_cursor = previous.resume_cursor;
  return marker;
}

/** The envelope with `data[key]` cut to its first `returned` items. */
function withElision(
  result: ToolResult<unknown>,
  data: Record<string, unknown>,
  key: string,
  returned: number,
  total: number,
  budget: number,
): ToolResult<unknown> {
  const previous = existingTruncation(data);
  const marker = markerFor(previous, returned);
  const meta = isRecord(data['meta']) ? { ...data['meta'] } : {};
  meta['truncation'] = marker;
  const items = data[key] as unknown[];
  return {
    ...result,
    data: { ...data, [key]: items.slice(0, returned), meta },
    hints: withNote(
      result.hints,
      elisionNote(returned, total, budget, marker.resume_cursor),
    ),
  };
}

/** The envelope with `data` reduced to its `meta` block. */
function withMetaOnly(
  result: ToolResult<unknown>,
  data: Record<string, unknown>,
  budget: number,
): ToolResult<unknown> {
  const meta = isRecord(data['meta']) ? { ...data['meta'] } : {};
  meta['truncation'] = markerFor(existingTruncation(data), 0);
  return { ...result, data: { meta }, hints: withNote(result.hints, dropNote(budget)) };
}

/** The CC-G7 floor: outcome, error, hints, journal — nothing else. */
function withoutData(result: ToolResult<unknown>, budget: number): ToolResult<unknown> {
  const floor: ToolResult<unknown> = { ok: result.ok };
  if (result.error !== undefined) floor.error = result.error;
  const hints = withNote(result.hints, dropNote(budget));
  if (hints !== undefined) floor.hints = hints;
  if (result.journal !== undefined) floor.journal = result.journal;
  return floor;
}

/**
 * Redact, then shrink the envelope until it fits `budgetChars`.
 *
 * The ladder, in order: (1) the whole result; (2) the largest top-level array
 * under `data`, cut to the most trailing items that still fit — a binary
 * search, so a 10 000-item page costs ~14 serializations; (3) `data` reduced
 * to its `meta` block; (4) the CC-G7 floor. Only the first level is free of a
 * `note` hint; every other level explains itself.
 *
 * Arrays nested deeper than `data.<key>` are not elided — a tool whose payload
 * is deeply nested caps it itself (`item_cap`) rather than relying on this.
 */
export function truncateResult(
  result: ToolResult<unknown>,
  budgetChars: number,
  opts: TruncateOptions = {},
): TruncatedResult {
  const budget = normalizeBudget(budgetChars);
  const space = opts.pretty === true ? 2 : undefined;
  const serialize = (value: unknown): string => JSON.stringify(value, null, space);
  const scrubbed = scrubTree(toJsonTree(result)) as ToolResult<unknown>;

  const full = serialize(scrubbed);
  if (full.length <= budget) return { result: scrubbed, text: full, truncated: false };

  const data = scrubbed.data;
  if (isRecord(data)) {
    const key = largestArrayKey(data);
    if (key !== undefined) {
      const total = (data[key] as unknown[]).length;
      let low = 0;
      let high = total - 1;
      let best = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const candidate = withElision(scrubbed, data, key, mid, total, budget);
        if (serialize(candidate).length <= budget) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best >= 0) {
        const elided = withElision(scrubbed, data, key, best, total, budget);
        return { result: elided, text: serialize(elided), truncated: true };
      }
    }
    const metaOnly = withMetaOnly(scrubbed, data, budget);
    const metaText = serialize(metaOnly);
    if (metaText.length <= budget)
      return { result: metaOnly, text: metaText, truncated: true };
  }

  const floor = withoutData(scrubbed, budget);
  return { result: floor, text: serialize(floor), truncated: true };
}

/**
 * The text block that mirrors `structuredContent` (TOOLS.md § 2.1). Callers
 * that also need the matching structured value should use {@link truncateResult}
 * so the two views cannot drift apart.
 */
export function toToolContent(
  result: ToolResult<unknown>,
  budgetChars: number,
  opts: TruncateOptions = {},
): string {
  return truncateResult(result, budgetChars, opts).text;
}

/**
 * The `outputSchema` advertised for every tool. `data` is intentionally
 * unconstrained: a `ToolSpec` declares only its *input* schema (CONTRACTS.md),
 * so the envelope — not the payload — is what the server can promise. Clients
 * validate `structuredContent` against this, so it must stay a superset of
 * everything {@link truncateResult} can produce.
 */
export const RESULT_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    ok: {
      type: 'boolean',
      description: 'False when the call failed; `error` is then present.',
    },
    data: { description: 'Tool-specific payload; absent on failure.' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        log_id: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
      required: ['code', 'message', 'retryable'],
      additionalProperties: true,
    },
    hints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...HINT_TYPES] },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
        additionalProperties: true,
      },
    },
    journal: { type: 'string', enum: ['unavailable'] },
  },
  required: ['ok'],
  additionalProperties: false,
});
