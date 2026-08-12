/**
 * The publish journal — an append-only, two-record NDJSON write-ahead log of
 * every publish attempt (ARCHITECTURE.md § 8.3, CONTRACTS.md § `mcp/journal.ts`,
 * CONFIGURATION.md § Journal).
 *
 * Two records per attempt: an **intent**, fsync'd *before* the init request
 * leaves the process, and an **outcome**, appended once the answer — or the
 * terminal failure — is known. The gap between them is the entire point. A
 * crash in that window leaves an intent with no outcome, which is the honest
 * record of "the request may have been sent" and the only local evidence a
 * human has when asking "did it actually post?" (CC-E10).
 *
 * Three rules follow from that and shape everything below:
 *
 * - **Never fail the publish.** Every append is best-effort: a full disk, a
 *   read-only home directory or a vanished parent becomes a logged warning and
 *   `{ ok: false }`, which the caller surfaces as `journal: "unavailable"` on
 *   the tool result. A journal that can break a post is worse than no journal.
 * - **`"unknown"` is never written.** It is derived at read time as
 *   intent-without-outcome; persisting it would need a writer that outlived the
 *   crash that produced it.
 * - **One `write()` of one complete line on an `O_APPEND` fd**, and no env
 *   lock. `O_APPEND` already orders concurrent writers in the kernel, and a
 *   publish must never queue behind a token refresh.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Clock } from '../core/clock.js';
import { resolveEnvFilePath } from '../core/config.js';
import { TikTokError } from '../core/errors.js';
import { silentLogger, type Logger } from '../core/log.js';
import { redactText } from '../core/redact.js';

/** The public record-shape version. Additive-only once the read tool ships. */
export const JOURNAL_VERSION = 1;

/** Sibling of the resolved env file, so one `TT_ENV_FILE` moves everything. */
const JOURNAL_FILE = 'journal.ndjson';

/** Exactly one rotated generation is kept; readers merge both. */
const ROTATED_SUFFIX = '.1';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Mirrors `settings.journalMaxBytes` (`TT_JOURNAL_MAX_BYTES`). */
export const DEFAULT_JOURNAL_MAX_BYTES = 5_242_880;

/** `title_excerpt` is a human hint in a log line, not the payload (§ 8.3). */
export const TITLE_EXCERPT_MAX = 48;

/** ARCHITECTURE § 8.4: the duplicate guard looks back exactly ten minutes. */
export const DUPLICATE_WINDOW_MS = 600_000;

/**
 * How much of the active generation the duplicate guard reads. A publish must
 * not pay for a 5 MB parse, and the window is ten minutes — 256 KiB is several
 * thousand records, orders of magnitude more than any account can produce in
 * that time.
 */
const DUPLICATE_TAIL_BYTES = 262_144;

/** Fallback stamp when the caller cannot supply the real package version. */
const UNKNOWN_CREATED_BY = 'tiktok-mcp-ai@0.0.0-unknown';

/** Crockford base32 — the ULID alphabet: no I, L, O or U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// records ---------------------------------------------------------------

/** Where the media came from — mirrors the publish tool's `source` argument. */
export type IntentSource = 'FILE_UPLOAD' | 'PULL_FROM_URL';

/** Persisted outcomes. `"unknown"` is deliberately absent — it is derived. */
export type OutcomeResult = 'ok' | 'error' | 'upload_failed' | 'send_ambiguous';

export interface IntentRecord {
  v: 1;
  type: 'intent';
  /** ULID: lexicographically sortable, so file order is time order. */
  attempt_id: string;
  /** ISO-8601 UTC. A persistence format only — comparisons are epoch ms (CC-H2). */
  ts: string;
  tool: string;
  profile: string;
  open_id: string;
  plan_id: string;
  payload_digest: string;
  title_excerpt: string;
  source: IntentSource;
  mode: string;
}

export interface OutcomeRecord {
  v: 1;
  type: 'outcome';
  attempt_id: string;
  ts: string;
  /**
   * A *known-unsent* network failure is `"error"` with
   * `error_code: "network_unsent"` (CC-B4), never `send_ambiguous` — the
   * difference is whether a human has to go and check.
   */
  result: OutcomeResult;
  publish_id?: string;
  error_code?: string;
  fail_reason?: string;
  /** Chunk index an upload aborted on, for `upload_failed`. */
  chunk?: number;
}

export interface HeaderRecord {
  v: 1;
  type: 'header';
  created_by: string;
}

export type JournalRecord = IntentRecord | OutcomeRecord | HeaderRecord;

/** Read-side vocabulary: the persisted four plus the derived `"unknown"`. */
export type FoldedOutcome = OutcomeResult | 'unknown';

/** One intent folded together with its outcome, if the outcome exists. */
export interface JournalAttempt {
  attempt_id: string;
  ts: string;
  tool: string;
  profile: string;
  open_id: string;
  plan_id: string;
  payload_digest: string;
  title_excerpt: string;
  source: IntentSource;
  mode: string;
  outcome: FoldedOutcome;
  /** When the outcome landed; absent for a derived `"unknown"`. */
  outcome_ts?: string;
  publish_id?: string;
  error_code?: string;
  fail_reason?: string;
  chunk?: number;
}

/**
 * Additive optional argument on the frozen CONTRACTS.md signatures, the same
 * precedent as `PlanStoreOptions` in `mcp/plan-store.ts`: the contract names
 * the env file, `settings.journalMaxBytes` and the package version as governing
 * this module but gives the functions no way to receive them. Omitting it falls
 * back to the documented defaults, so the frozen call shapes still work.
 */
export interface JournalOptions {
  /** Absolute path to `journal.ndjson`; resolved from the env file when absent. */
  path?: string;
  /** `settings.journalMaxBytes`. */
  maxBytes?: number;
  /** `settings.envFile`, when the caller already resolved it. */
  envFile?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** `tiktok-mcp-ai@X.Y.Z` stamped into the header of a fresh generation. */
  createdBy?: string;
}

// paths -----------------------------------------------------------------

/**
 * `journal.ndjson` beside the resolved env file (CONFIGURATION.md § Journal).
 * Keeping every runtime artifact in one directory is what lets a custom
 * `TT_ENV_FILE` move the whole footprint and lets `--purge-journal` work
 * without a second resolver.
 */
export function resolveJournalPath(opts: JournalOptions = {}): string {
  if (opts.path !== undefined) return opts.path;
  const envFile = opts.envFile ?? resolveEnvFilePath(opts.env ?? process.env);
  return join(dirname(envFile), JOURNAL_FILE);
}

// ids and excerpts ------------------------------------------------------

/**
 * A ULID: 48-bit timestamp then 80 bits of randomness, both Crockford base32.
 * Sortable by construction, so a `sort` of the file is chronological even
 * across generations, and collision-free enough that two processes appending
 * concurrently never fold into one attempt.
 *
 * The random half maps bytes through `CROCKFORD[b % 32]`: 256 is divisible by
 * 32, so the modulo is exactly uniform — no rejection sampling needed.
 */
export function mintAttemptId(clock: Clock): string {
  let time = '';
  let ms = clock.now();
  for (let i = 0; i < 10; i += 1) {
    time = `${CROCKFORD[ms % 32] ?? '0'}${time}`;
    ms = Math.floor(ms / 32);
  }
  const bytes = randomBytes(16);
  let random = '';
  for (const byte of bytes) random += CROCKFORD[byte % 32] ?? '0';
  return `${time}${random}`;
}

/**
 * The `ts` of a record. ISO-8601 UTC is a persistence format only; every
 * comparison in this module goes back through epoch milliseconds (CC-H2).
 */
export function journalTimestamp(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/**
 * Collapse whitespace and cut to `TITLE_EXCERPT_MAX` *code points* — slicing
 * UTF-16 units would split a surrogate pair and put a lone half in the file.
 */
export function titleExcerpt(title: string): string {
  const flat = title.replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  if (chars.length <= TITLE_EXCERPT_MAX) return flat;
  return `${chars.slice(0, TITLE_EXCERPT_MAX - 1).join('')}…`;
}

// serialization ---------------------------------------------------------

/**
 * Fields are written in an explicit order rather than the caller's insertion
 * order, so the on-disk shape is stable no matter how the record was built.
 * String values go through `redactText` individually: `[REDACTED]` carries no
 * quotes, so scrubbing the serialized line would also be valid JSON, but
 * scrubbing values keeps the structure provably untouched. `undefined` fields
 * are dropped — an absent optional must not become `null`.
 */
function serialize(fields: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? redactText(value) : value;
  }
  return `${JSON.stringify(out)}\n`;
}

function headerLine(createdBy: string): string {
  return serialize({ v: JOURNAL_VERSION, type: 'header', created_by: createdBy });
}

function intentLine(rec: IntentRecord): string {
  return serialize({
    v: JOURNAL_VERSION,
    type: 'intent',
    attempt_id: rec.attempt_id,
    ts: rec.ts,
    tool: rec.tool,
    profile: rec.profile,
    open_id: rec.open_id,
    plan_id: rec.plan_id,
    payload_digest: rec.payload_digest,
    title_excerpt: titleExcerpt(rec.title_excerpt),
    source: rec.source,
    mode: rec.mode,
  });
}

function outcomeLine(rec: OutcomeRecord): string {
  return serialize({
    v: JOURNAL_VERSION,
    type: 'outcome',
    attempt_id: rec.attempt_id,
    ts: rec.ts,
    result: rec.result,
    publish_id: rec.publish_id,
    error_code: rec.error_code,
    fail_reason: rec.fail_reason,
    chunk: rec.chunk,
  });
}

// parsing ---------------------------------------------------------------

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function asIntent(source: Record<string, unknown>): IntentRecord | undefined {
  const attemptId = stringField(source, 'attempt_id');
  const ts = stringField(source, 'ts');
  const tool = stringField(source, 'tool');
  const profile = stringField(source, 'profile');
  const openId = stringField(source, 'open_id');
  const planId = stringField(source, 'plan_id');
  const digest = stringField(source, 'payload_digest');
  const excerpt = stringField(source, 'title_excerpt');
  const src = stringField(source, 'source');
  const mode = stringField(source, 'mode');
  if (
    attemptId === undefined ||
    ts === undefined ||
    tool === undefined ||
    profile === undefined ||
    openId === undefined ||
    planId === undefined ||
    digest === undefined ||
    excerpt === undefined ||
    mode === undefined ||
    (src !== 'FILE_UPLOAD' && src !== 'PULL_FROM_URL')
  )
    return undefined;
  return {
    v: JOURNAL_VERSION,
    type: 'intent',
    attempt_id: attemptId,
    ts,
    tool,
    profile,
    open_id: openId,
    plan_id: planId,
    payload_digest: digest,
    title_excerpt: excerpt,
    source: src,
    mode,
  };
}

const OUTCOME_RESULTS: ReadonlySet<string> = new Set([
  'ok',
  'error',
  'upload_failed',
  'send_ambiguous',
]);

function asOutcome(source: Record<string, unknown>): OutcomeRecord | undefined {
  const attemptId = stringField(source, 'attempt_id');
  const ts = stringField(source, 'ts');
  const result = stringField(source, 'result');
  if (attemptId === undefined || ts === undefined || result === undefined)
    return undefined;
  if (!OUTCOME_RESULTS.has(result)) return undefined;

  const out: OutcomeRecord = {
    v: JOURNAL_VERSION,
    type: 'outcome',
    attempt_id: attemptId,
    ts,
    result: result as OutcomeResult,
  };
  const publishId = stringField(source, 'publish_id');
  if (publishId !== undefined) out.publish_id = publishId;
  const errorCode = stringField(source, 'error_code');
  if (errorCode !== undefined) out.error_code = errorCode;
  const failReason = stringField(source, 'fail_reason');
  if (failReason !== undefined) out.fail_reason = failReason;
  const chunk = source['chunk'];
  if (typeof chunk === 'number') out.chunk = chunk;
  return out;
}

/**
 * One line to a record, or `undefined` for anything this reader must ignore:
 * a torn tail, a future `v`, or a record missing a field the contract makes
 * required. Every `undefined` is counted, never silently dropped — a reader
 * that hides lines is worse than one that admits it skipped them.
 */
function asRecord(value: unknown): JournalRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  if (source['v'] !== JOURNAL_VERSION) return undefined;
  switch (source['type']) {
    case 'header': {
      const createdBy = stringField(source, 'created_by');
      return createdBy === undefined
        ? undefined
        : { v: JOURNAL_VERSION, type: 'header', created_by: createdBy };
    }
    case 'intent':
      return asIntent(source);
    case 'outcome':
      return asOutcome(source);
    default:
      return undefined;
  }
}

interface ParsedLines {
  records: JournalRecord[];
  skipped: number;
}

function parseLines(text: string): ParsedLines {
  const records: JournalRecord[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      skipped += 1;
      continue;
    }
    records.push(record);
  }
  return { records, skipped };
}

// reading ---------------------------------------------------------------

function unreadable(path: string, cause: unknown): TikTokError {
  return new TikTokError({
    kind: 'internal',
    code: 'journal_unreadable',
    message:
      `The journal file at ${path} is missing or unreadable. Publishes may still have ` +
      'happened — verify with tiktok_list_videos. Ask the user to check the file if an ' +
      'audit trail is required.',
    retryable: false,
    cause,
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** `undefined` means "no such generation"; anything else is a real failure. */
async function readWhole(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw unreadable(path, cause);
  }
  try {
    return await handle.readFile('utf8');
  } catch (cause) {
    throw unreadable(path, cause);
  } finally {
    await handle.close();
  }
}

/**
 * The last `maxBytes` of a generation, with the leading partial line dropped.
 * Cutting mid-line is guaranteed by construction, so the first newline is the
 * first trustworthy boundary; without that trim a half-record would inflate
 * `skippedLines` on every single duplicate check.
 */
async function readTail(path: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw unreadable(path, cause);
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    if (length === size) return text;
    const boundary = text.indexOf('\n');
    return boundary === -1 ? '' : text.slice(boundary + 1);
  } catch (cause) {
    throw unreadable(path, cause);
  } finally {
    await handle.close();
  }
}

/** True when either generation exists — how a caller tells "empty" from "fresh". */
export async function journalExists(opts: JournalOptions = {}): Promise<boolean> {
  const path = resolveJournalPath(opts);
  for (const candidate of [path, `${path}${ROTATED_SUFFIX}`]) {
    try {
      await stat(candidate);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Both generations, oldest first. Torn tail lines and unknown versions are
 * skipped and counted (§ 8.3).
 *
 * `limit` keeps the newest N *records* — note that it can cut an intent away
 * from its outcome, which is why the read tool folds first and limits after.
 */
export async function readMerged(
  opts: JournalOptions & { limit?: number } = {},
): Promise<{ records: JournalRecord[]; skippedLines: number }> {
  const path = resolveJournalPath(opts);
  const older = parseLines((await readWhole(`${path}${ROTATED_SUFFIX}`)) ?? '');
  const active = parseLines((await readWhole(path)) ?? '');
  const records = [...older.records, ...active.records];
  const skippedLines = older.skipped + active.skipped;
  const { limit } = opts;
  if (limit === undefined || records.length <= limit) return { records, skippedLines };
  return { records: records.slice(records.length - limit), skippedLines };
}

/**
 * Pair intents with their outcomes by `attempt_id`. An intent with no outcome
 * folds to `"unknown"` — the crash-mid-publish case (CC-E10) — and a duplicate
 * outcome for one attempt keeps the last, which is what a retried write means.
 * Outcomes with no intent (an orphan left by a tail read, or by a rotation
 * between the two appends) are not attempts and are dropped.
 */
export function foldAttempts(records: readonly JournalRecord[]): JournalAttempt[] {
  const outcomes = new Map<string, OutcomeRecord>();
  for (const record of records) {
    if (record.type === 'outcome') outcomes.set(record.attempt_id, record);
  }

  const attempts: JournalAttempt[] = [];
  for (const record of records) {
    if (record.type !== 'intent') continue;
    const outcome = outcomes.get(record.attempt_id);
    const attempt: JournalAttempt = {
      attempt_id: record.attempt_id,
      ts: record.ts,
      tool: record.tool,
      profile: record.profile,
      open_id: record.open_id,
      plan_id: record.plan_id,
      payload_digest: record.payload_digest,
      title_excerpt: record.title_excerpt,
      source: record.source,
      mode: record.mode,
      outcome: outcome?.result ?? 'unknown',
    };
    if (outcome !== undefined) {
      attempt.outcome_ts = outcome.ts;
      if (outcome.publish_id !== undefined) attempt.publish_id = outcome.publish_id;
      if (outcome.error_code !== undefined) attempt.error_code = outcome.error_code;
      if (outcome.fail_reason !== undefined) attempt.fail_reason = outcome.fail_reason;
      if (outcome.chunk !== undefined) attempt.chunk = outcome.chunk;
    }
    attempts.push(attempt);
  }
  return attempts;
}

// writing ---------------------------------------------------------------

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/**
 * Rotation is checked here and only here — immediately before an intent append
 * — so an outcome can never be separated from its intent by a rotation this
 * process performed (§ 8.3). One generation is kept; `rename` over an existing
 * `.1` discards the older one atomically.
 *
 * A rotation failure is not an append failure: the journal simply grows past
 * the threshold, which is strictly better than losing the record.
 */
async function rotateIfNeeded(
  path: string,
  maxBytes: number,
  logger: Logger,
): Promise<void> {
  try {
    const size = await fileSize(path);
    if (size === undefined || size < maxBytes) return;
    await rename(path, `${path}${ROTATED_SUFFIX}`);
    logger.info('rotated the publish journal', { path, bytes: size, rotated: true });
  } catch (cause) {
    logger.warn('could not rotate the publish journal; it keeps growing', {
      path,
      reason: redactText(String(cause)),
    });
  }
}

/**
 * One `write()` of one complete line on an `O_APPEND` fd. The file is created
 * `0600` by the `open` mode and the directory `0700` by `mkdir` — no follow-up
 * `chmod`, which would be a second syscall racing on a path rather than an fd.
 *
 * A fresh generation gets its header prepended to the *same* buffer, so the
 * header and the first record are one atomic append: a crash can never leave a
 * header-only file that a reader would mistake for a complete generation.
 */
async function appendLine(
  path: string,
  line: string,
  fsync: boolean,
  createdBy: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const handle = await open(path, 'a', FILE_MODE);
  try {
    const { size } = await handle.stat();
    await handle.write(size === 0 ? `${headerLine(createdBy)}${line}` : line);
    if (fsync) await handle.sync();
  } finally {
    await handle.close();
  }
}

async function tryAppend(
  path: string,
  line: string,
  fsync: boolean,
  opts: JournalOptions,
  logger: Logger,
): Promise<{ ok: boolean }> {
  try {
    await appendLine(path, line, fsync, opts.createdBy ?? UNKNOWN_CREATED_BY);
    return { ok: true };
  } catch (cause) {
    // Never rethrown: the caller is mid-publish and an audit line is not worth
    // a failed post. The tool result carries `journal: "unavailable"` instead.
    logger.warn('could not append to the publish journal; the publish is unaffected', {
      path,
      reason: redactText(String(cause)),
    });
    return { ok: false };
  }
}

/**
 * Append an intent — fsync'd, because the whole guarantee is that the record
 * reaches the disk *before* the request reaches TikTok. Rotation is evaluated
 * first (and only here).
 */
export async function appendIntent(
  rec: IntentRecord,
  opts: JournalOptions = {},
): Promise<{ ok: boolean }> {
  const path = resolveJournalPath(opts);
  const logger = opts.logger ?? silentLogger;
  await rotateIfNeeded(path, opts.maxBytes ?? DEFAULT_JOURNAL_MAX_BYTES, logger);
  return await tryAppend(path, intentLine(rec), true, opts, logger);
}

/**
 * Append an outcome — no fsync. The intent already carries the durable "this
 * may have been sent" signal; paying a second fsync would slow every publish to
 * remove an ambiguity that only a crash in a millisecond-wide window creates,
 * and that ambiguity already reads as `"unknown"`, which is the safe answer.
 */
export async function appendOutcome(
  rec: OutcomeRecord,
  opts: JournalOptions = {},
): Promise<{ ok: boolean }> {
  const path = resolveJournalPath(opts);
  return await tryAppend(
    path,
    outcomeLine(rec),
    false,
    opts,
    opts.logger ?? silentLogger,
  );
}

// duplicate guard -------------------------------------------------------

/**
 * Outcomes that make a re-publish suspicious. `error` and `upload_failed` are
 * exempt: both mean nothing was posted, so blocking the retry would strand the
 * user (§ 8.4).
 */
const TRIPPING_OUTCOMES: ReadonlySet<FoldedOutcome> = new Set<FoldedOutcome>([
  'ok',
  'send_ambiguous',
  'unknown',
]);

export interface DuplicateCheck {
  duplicate: boolean;
  /** Set iff `duplicate` — the attempt that tripped the guard. */
  matchedAttemptId?: string;
  /**
   * The whole matched attempt. `possible_duplicate` (TOOLS.md § 3.0) has to
   * name the profile, the timestamp, the outcome and the `publish_id`, none of
   * which can be recovered from an attempt id.
   */
  matched?: JournalAttempt;
}

/**
 * SYNTHESIS § 2.7 / ARCHITECTURE § 8.4 — has this exact payload already been
 * attempted, successfully or ambiguously, in the last ten minutes?
 *
 * Reads a bounded tail of the **active generation only**: an outcome always
 * follows its own intent in the file, so a tail can orphan an outcome (dropped
 * by `foldAttempts`, harmless) but can never hide an outcome from an intent the
 * tail contains — the guard never invents an `"unknown"`.
 *
 * The window test is `now - ts <= WINDOW`, so a timestamp in the *future* also
 * trips it. That is the conservative direction for a write guard (CC-H1): a
 * clock that jumped backwards should make the server more careful about
 * duplicates, not less, and `force: true` is the documented escape hatch.
 *
 * An unreadable journal is not a duplicate. Failing closed would let one bad
 * file mode brick every publish on the machine, and the plan digest check has
 * already established that the caller is applying a payload the user approved.
 */
export async function checkDuplicate(
  payloadDigest: string,
  clock: Clock,
  opts: JournalOptions = {},
): Promise<DuplicateCheck> {
  const path = resolveJournalPath(opts);
  let text: string | undefined;
  try {
    text = await readTail(path, DUPLICATE_TAIL_BYTES);
  } catch (cause) {
    (opts.logger ?? silentLogger).warn(
      'could not read the publish journal for the duplicate check; allowing the publish',
      { path, reason: redactText(String(cause)) },
    );
    return { duplicate: false };
  }
  if (text === undefined) return { duplicate: false };

  const now = clock.now();
  const attempts = foldAttempts(parseLines(text).records);
  for (const attempt of attempts.reverse()) {
    if (attempt.payload_digest !== payloadDigest) continue;
    if (!TRIPPING_OUTCOMES.has(attempt.outcome)) continue;
    const at = Date.parse(attempt.ts);
    if (Number.isNaN(at) || now - at > DUPLICATE_WINDOW_MS) continue;
    return { duplicate: true, matchedAttemptId: attempt.attempt_id, matched: attempt };
  }
  return { duplicate: false };
}
