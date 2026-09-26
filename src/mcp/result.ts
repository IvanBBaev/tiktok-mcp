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
 * The two § 5.2 hint caps are declared here, but at runtime they bind only to
 * the notes truncation itself appends — every other hint in the server is a
 * literal a tool writes. See {@link MAX_HINTS} for what that meant and what now
 * checks it.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { TikTokError } from '../core/errors.js';
import { redactText } from '../core/redact.js';

/** Closed vocabulary — six hint types, no upstream text interpolation. */
export type HintType =
  'wait' | 'poll' | 'approval_required' | 'user_action' | 'reauth' | 'note';

/**
 * The same vocabulary as a value, so it can be iterated rather than trusted.
 *
 * 2026-09-01: every member was checked against the emitters under `src/` —
 * `wait` 1, `poll` 3, `approval_required` 1, `user_action` 6, `reauth` 2,
 * `note` 9. All six are live; there is no second `wait_for_audit` hiding here.
 *
 * That is recorded as a dated verification and not as a guarantee: a census by
 * grep is stale the moment someone adds a type, which is why
 * `test/result.test.ts` now walks this list for emitters the way it already
 * walks {@link USER_ACTIONS}.
 */
export const HINT_TYPES: readonly HintType[] = Object.freeze([
  'wait',
  'poll',
  'approval_required',
  'user_action',
  'reauth',
  'note',
] as const);

/**
 * Closed vocabulary — the operator-side steps a `user_action` hint may name.
 *
 * Enumerable at runtime for the same reason as {@link HINT_TYPES}: a closed
 * vocabulary nothing can iterate is a comment rather than a contract, and
 * `test/result.test.ts` walks this list to check every member is one some code
 * path actually emits.
 *
 * Membership is decided by the one question TOOLS.md § 5.1 asks — is this a
 * step only the human or operator can take *next, before this call can
 * proceed*? Two members have been weighed against it and answered oppositely,
 * which is not an inconsistency but the test doing its job:
 *
 * - `wait_for_audit` was a member until 2026-08-31 and failed it. An unaudited
 *   app is a standing condition of the installation, reported alongside a
 *   preview or a successful post — a flow that continues, and which a
 *   `user_action` would tell a model to halt. § 4 (flow 2) and § 5.1 both give
 *   that case to `note`.
 * - `move_file` and `host_media` were emitted by nothing until 2026-09-01 and
 *   pass it. `file_outside_media_root` and `url_prefix_unverified` are
 *   non-retryable refusals that end the call with nothing created, and neither
 *   moving a file nor re-hosting media is something the model can do for
 *   itself. They ride only on that shape: past an init the attempt exists
 *   upstream (CC-B4) and the next step is a status poll, not a human.
 */
export const USER_ACTIONS = Object.freeze([
  'login',
  'open_tiktok_app',
  'move_file',
  'host_media',
  'configure_server',
] as const);

export type UserAction = (typeof USER_ACTIONS)[number];

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
  /** user_action — see {@link USER_ACTIONS} for why the audit gate is not here. */
  action?: UserAction;
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

/**
 * TOOLS.md § 5.2 — at most three hints per result.
 *
 * **2026-09-01 — where the caps bind.** Both this and {@link MAX_HINT_CHARS}
 * were read from exactly two places, `withNote` and `elisionNote`, and both of
 * those run only on the notes *truncation itself* appends to a result it has
 * just shortened. No hint a tool emits passes through either: every one is an
 * array literal or a `Hint[]` accumulator under `src/tools/`, assigned straight
 * onto the envelope. So for the hints a caller actually sees, the caps were
 * documentation with no enforcement point — the shape the `wait_for_audit`
 * defect had (see {@link USER_ACTIONS}): true on the day it was written, with
 * nothing in the repo able to notice the day it stopped being true.
 *
 * Both are now exported, and `test/result.test.ts` walks the hint construction
 * sites under `src/` against them. Several tool tests already asserted `<= 3`
 * and `<= 300`, but only on the paths they happen to execute and with the two
 * numbers retyped as literals; the walk covers construction sites rather than
 * executions, and reads the numbers from here.
 *
 * Two mechanisms were weighed and rejected:
 *
 * - **Truncating hints at serialization.** A hint is what tells a model what to
 *   do next. § 5.2 rule 4 orders them most-actionable-first, so the one a
 *   truncator would drop is the least actionable — but "least actionable" is
 *   not "unnecessary", and a silent drop is the worse failure of the two:
 *   nothing downstream can tell that advice went missing, which is exactly why
 *   §§ 2.4/CC-G7 make dropped *payload* announce itself with a marker and a
 *   note. There is no equivalent receipt available for a dropped hint, because
 *   the result is by definition already out of hint slots.
 * - **Throwing on an over-cap result.** That trades a cosmetic ceiling for an
 *   outage: a post that already succeeded upstream would come back to the
 *   caller as a server error because this server wrote one sentence too many.
 *
 * A walk costs nothing at runtime and fails in CI instead. It is not total, and
 * the test states precisely where it stops seeing: hint text that interpolates
 * a value is measured with a nominal per-placeholder allowance, and three sites
 * compose their hints from an array a *caller* built, which no text scan can
 * bound. The deepest of those three reaches exactly three hints today, with no
 * headroom left.
 */
export const MAX_HINTS = 3;

/**
 * TOOLS.md § 5.2 — a hint sentence never exceeds 300 characters.
 *
 * Measured on `Hint.text` alone; the structured fields beside it are not part
 * of the budget. See {@link MAX_HINTS} for where this binds and what checks it.
 *
 * **2026-09-02 — why one runtime enforcement and not a general one.** This cap
 * is read at runtime in exactly one place, `elisionNote`, and that is the
 * one place where it should be: the resume cursor is the only value in a hint
 * whose length no static reading can bound. Everywhere else a hint is a fixed
 * server template plus values admitted by {@link hintToken} /
 * {@link hintEnum} — bounded by {@link MAX_HINT_TOKEN_CHARS} or by a
 * server-owned vocabulary — so an over-long hint is a bug in *this server's*
 * templates, which CI can see before the code ships and a caller never can.
 *
 * A general runtime guard was considered and rejected on the same grounds as
 * the two mechanisms in {@link MAX_HINTS}, plus one that is specific to this
 * cap: what a truncator would cut is the *end* of the sentence, and every poll
 * hint in the server ends with the negative imperative that keeps a slow
 * publish from becoming two posts ("Do not re-post.", "Do not post again.",
 * "do not re-post."). Clipping a hint at 300 characters would strip exactly the
 * half that prevents the accident, on the path where a model was about to be
 * told to poll. Dropping the hint outright is worse still — no advice at all —
 * and throwing turns a post that already succeeded upstream into an error. So
 * the enforcement point stays where a failure costs nothing: the source walk in
 * `test/result.test.ts`, which measures construction sites rather than the
 * executions a runtime check would happen to see.
 */
export const MAX_HINT_CHARS = 300;

/**
 * TOOLS.md § 5.2 rule 3 — the longest upstream-originated identifier a hint may
 * inline.
 *
 * The rule admits exactly two upstream-touched shapes into hint text (see the
 * document for why): a **single opaque identifier** the recommended next call
 * must quote back, and a **member of a closed vocabulary this server owns**.
 * {@link hintToken} decides the first, {@link hintEnum} the second. Everything
 * else — titles, nicknames, upstream error text, lists of ids — stays in `data`.
 *
 * 64 is not cosmetic. It is the largest value that keeps every hint that
 * inlines an identifier inside {@link MAX_HINT_CHARS} with room to spare: the
 * tightest of them (`journalUnavailableNote`) spends 174 characters on its own
 * template, and the widest (`stillProcessingAfterApplyHint`) spends 116 plus a
 * 19-character status, a 24-character timestamp and a small integer. Observed
 * TikTok `publish_id`s are about half of it (`v_pub_url~v2.7300000000000000001`
 * is 31), so the cap refuses hostile lengths without clipping honest ones.
 */
export const MAX_HINT_TOKEN_CHARS = 64;

/**
 * RFC 3986 *unreserved* characters, and an alphanumeric first character.
 *
 * The charset is the point, not an accident of what TikTok happens to send:
 * a hint is an instruction channel, so a value entering it must not be able to
 * carry a line break, a quote, a colon or a bracket — the punctuation with
 * which upstream text would stop being a name and start being a sentence. The
 * leading-alphanumeric rule additionally stops a value that would render as a
 * list bullet or a command-line flag.
 */
const HINT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

/**
 * An upstream identifier as it may appear in hint text, or `undefined` when it
 * may not.
 *
 * `undefined` is deliberately the "refuse" answer rather than a truncation or
 * an escape: a clipped identifier is worse than none — a model would quote it
 * back and get `invalid_publish_id` — and escaping would put upstream bytes in
 * the channel anyway. Callers fall back to a template that names no identifier
 * and leave the raw value in the structured field beside it, which is where
 * § 5.2's own last sentence puts upstream data.
 */
export function hintToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_HINT_TOKEN_CHARS) return undefined;
  return HINT_TOKEN_PATTERN.test(value) ? value : undefined;
}

/**
 * The member of a server-owned vocabulary an upstream value selects, if any.
 *
 * What gets interpolated on a match is this server's own literal — the upstream
 * string only chose which one — so a matched value is server-owned text under
 * § 5.2 rule 3, not upstream text that happened to look safe. A value matching
 * nothing is free text by definition and the caller must use a template that
 * does not name it.
 *
 * This deliberately does not validate anything upstream: `api/publish.ts` still
 * reports an unrecognized status rather than rejecting it, and `data.status`
 * still carries whatever arrived. The narrowing happens here, at the hint
 * boundary, and nowhere else.
 */
export function hintEnum<T extends string>(
  value: string | undefined,
  vocabulary: readonly T[],
): T | undefined {
  return vocabulary.find((member) => member === value);
}

/**
 * How a hint names an identifier it wants quoted back into the next call.
 *
 * One helper rather than a guard per site: the three `poll` hints in the server
 * all face the same choice, and the fallback has to be a phrase a model can act
 * on. `label` is the structured field on the very same hint object (§ 5.1
 * declares `publish_id` for `poll`), so the fallback is a precise reference
 * rather than the "vague reference" § 5.2 rule 1 forbids — the value is one
 * field away, in the typed form that was always the honest place for it.
 */
export function quotedHintToken(label: string, value: string | undefined): string {
  const token = hintToken(value);
  return token === undefined ? `this hint's ${label}` : `${label} "${token}"`;
}

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

function elisionNote(returned: number, total: number, budget: number): string {
  return (
    `Result truncated to fit the ${budget}-character response budget: ${returned} of ${total} ` +
    'items returned. Narrow the request (fewer ids, a smaller page size) to see the rest.'
  );
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

/**
 * `meta` of an elided result. Every cursor the tool put there points past the
 * *whole* page it fetched, so after items were cut from that page a cursor
 * would resume beyond them and the cut items would never be seen. There is no
 * cursor for "item N" to put in its place — upstream cursors are opaque — so
 * the elided result carries none and its note says to narrow the request.
 */
function elidedMeta(
  data: Record<string, unknown>,
  returned: number,
): Record<string, unknown> {
  const meta = isRecord(data['meta']) ? { ...data['meta'] } : {};
  delete meta['next_cursor'];
  meta['truncation'] = { truncated: true, reason: 'char_budget', returned };
  return meta;
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
  const meta = elidedMeta(data, returned);
  const items = data[key] as unknown[];
  return {
    ...result,
    data: { ...data, [key]: items.slice(0, returned), meta },
    hints: withNote(result.hints, elisionNote(returned, total, budget)),
  };
}

/** The envelope with `data` reduced to its `meta` block. */
function withMetaOnly(
  result: ToolResult<unknown>,
  data: Record<string, unknown>,
  budget: number,
): ToolResult<unknown> {
  const meta = elidedMeta(data, 0);
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
 * under `data`, cut to the longest run of leading items that fits — a binary
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
