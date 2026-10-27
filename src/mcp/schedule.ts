/**
 * The local publish schedule — approved publishes queued for a later time
 * (TOOLS.md § 2.10, CONFIGURATION.md § Schedule).
 *
 * TikTok's API has no scheduling, so a scheduled publish is a promise *this
 * machine* keeps: a write tool's apply call with `run_at` stores the approved
 * request here instead of dispatching it, and `tiktok-mcp-ai run-queue` — run
 * by cron, launchd or by hand — applies whatever is due. Nothing publishes
 * while the machine is off or the runner is not scheduled; an entry the runner
 * reaches more than {@link SCHEDULE_LATE_LIMIT_MS} after its `run_at` expires
 * instead of posting a day late.
 *
 * What is stored is the approval, not a token: plans live in one process for
 * ten minutes (`mcp/plan-store`), so an entry keeps the tool arguments, the
 * payload digest and the file identity the user approved. The runner
 * re-resolves the arguments, and anything that would change what TikTok
 * receives — an edited file, a changed account, a creator setting that alters
 * the resolved payload — refuses the entry instead of publishing something
 * nobody saw.
 *
 * One JSON document, rewritten atomically (temp file + rename) under its own
 * lock — the env-lock mutex keyed on this file — so a runner claiming due
 * entries and a tool adding one never lose each other's write. Unlike the
 * journal, a damaged file is refused rather than skipped: rewriting it would
 * drop the entries that could not be read.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Clock } from '../core/clock.js';
import { resolveEnvFilePath } from '../core/config.js';
import { withEnvLock } from '../core/env-lock.js';
import { TikTokError } from '../core/errors.js';
import { silentLogger, type Logger } from '../core/log.js';
import type { Settings } from '../core/settings.js';
import { mintAttemptId } from './journal.js';

/** The document version. Additive-only. */
export const SCHEDULE_VERSION = 1;

/** Sibling of the resolved env file, like `journal.ndjson`. */
const SCHEDULE_FILE = 'schedule.json';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** How long a tool waits for a runner holding the queue lock. */
const LOCK_WAIT_MS = 5_000;

/** Pending entries one installation may hold — a queue, not a backlog. */
export const SCHEDULE_MAX_PENDING = 50;

/** How far ahead `run_at` may be: a month, well past any campaign plan. */
export const SCHEDULE_MAX_HORIZON_MS = 30 * 24 * 3_600_000;

/**
 * How late the runner may still apply an entry. A machine that slept through
 * the slot publishes on wake within a day; past that the entry expires, since
 * a post days late is rarely the one the user approved.
 */
export const SCHEDULE_LATE_LIMIT_MS = 24 * 3_600_000;

/** Finished entries are kept this long for `tiktok_list_scheduled`, then pruned. */
export const SCHEDULE_RETENTION_MS = 30 * 24 * 3_600_000;

/** `sch_` + a ULID: sortable by creation, unique across processes. */
export const SCHEDULE_ID_PATTERN = /^sch_[0-9A-HJKMNP-TV-Z]{26}$/;

export type ScheduleStatus =
  'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired';

export const SCHEDULE_STATUSES: readonly ScheduleStatus[] = Object.freeze([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
  'expired',
]);

/** One queued publish. Persisted as written; snake case like the journal. */
export interface ScheduledEntry {
  schedule_id: string;
  tool: string;
  profile: string;
  open_id: string;
  /** The approved tool arguments, control fields removed, `account` pinned. */
  args: Record<string, unknown>;
  payload_digest: string;
  file_identity?: string;
  title_excerpt: string;
  /** ISO-8601 UTC. */
  run_at: string;
  created_at: string;
  updated_at: string;
  status: ScheduleStatus;
  /** Set once a run dispatched the entry and TikTok minted one. */
  publish_id?: string;
  /** Why a run refused or failed the entry. */
  error?: { code: string; message: string };
}

export interface ScheduleOptions {
  /** Absolute path to `schedule.json`; resolved from the env file when absent. */
  path?: string;
  /** `settings.envFile`, when the caller already resolved it. */
  envFile?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/** The same wiring `journalOptionsFor` gives the journal. */
export function scheduleOptionsFor(settings: Settings, logger: Logger): ScheduleOptions {
  return {
    ...(settings.envFile === undefined ? {} : { envFile: settings.envFile }),
    logger,
  };
}

/** `schedule.json` beside the resolved env file. */
export function resolveSchedulePath(opts: ScheduleOptions = {}): string {
  if (opts.path !== undefined) return opts.path;
  const envFile = opts.envFile ?? resolveEnvFilePath(opts.env ?? process.env);
  return join(dirname(envFile), SCHEDULE_FILE);
}

export function mintScheduleId(clock: Clock): string {
  return `sch_${mintAttemptId(clock)}`;
}

// reading ---------------------------------------------------------------

function unreadable(path: string, problem: string): TikTokError {
  return new TikTokError({
    kind: 'config',
    code: 'schedule_unreadable',
    message: `The publish schedule at ${path} cannot be read: ${problem}.`,
    retryable: false,
    remediation:
      'Fix or move the file aside; nothing is published from a schedule that cannot be read.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is ScheduledEntry {
  if (!isRecord(value)) return false;
  const strings = [
    'schedule_id',
    'tool',
    'profile',
    'open_id',
    'payload_digest',
    'title_excerpt',
    'run_at',
    'created_at',
    'updated_at',
  ];
  return (
    strings.every((key) => typeof value[key] === 'string') &&
    isRecord(value['args']) &&
    SCHEDULE_STATUSES.includes(value['status'] as ScheduleStatus)
  );
}

/** Every entry, oldest first. A missing file is an empty schedule. */
export async function readSchedule(
  opts: ScheduleOptions = {},
): Promise<ScheduledEntry[]> {
  const path = resolveSchedulePath(opts);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw unreadable(path, String((cause as Error).message));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable(path, 'it is not JSON');
  }
  if (!isRecord(parsed) || parsed['v'] !== SCHEDULE_VERSION) {
    throw unreadable(path, `it is not a version ${String(SCHEDULE_VERSION)} schedule`);
  }
  const entries = parsed['entries'];
  if (!Array.isArray(entries) || !entries.every(isEntry)) {
    throw unreadable(path, 'an entry is malformed');
  }
  return entries;
}

// writing ---------------------------------------------------------------

async function writeAtomically(
  path: string,
  entries: readonly ScheduledEntry[],
): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify({ v: SCHEDULE_VERSION, entries }, null, 2)}\n`;
  const handle = await open(temp, 'w', FILE_MODE);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } catch (cause) {
    await handle.close();
    await rm(temp, { force: true });
    throw cause;
  }
  await handle.close();
  await rename(temp, path);
}

/** Terminal entries past {@link SCHEDULE_RETENTION_MS} are dropped on write. */
function pruned(entries: readonly ScheduledEntry[], now: number): ScheduledEntry[] {
  return entries.filter((entry) => {
    if (entry.status === 'pending' || entry.status === 'running') return true;
    const at = Date.parse(entry.updated_at);
    return !Number.isFinite(at) || now - at < SCHEDULE_RETENTION_MS;
  });
}

/**
 * Read, change and rewrite the schedule under its lock. `change` mutates the
 * array it is given and returns what the caller wants back; it runs with the
 * lock held, so it must not wait on anything slow.
 */
export async function updateSchedule<T>(
  clock: Clock,
  change: (entries: ScheduledEntry[]) => T,
  opts: ScheduleOptions = {},
): Promise<T> {
  const path = resolveSchedulePath(opts);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  return await withEnvLock(
    path,
    async () => {
      const entries = await readSchedule({ ...opts, path });
      const result = change(entries);
      await writeAtomically(path, pruned(entries, clock.now()));
      return result;
    },
    {
      waitMs: LOCK_WAIT_MS,
      clock,
      logger: opts.logger ?? silentLogger,
      label: { lock: 'schedule lock', guards: 'the publish schedule' },
    },
  );
}

// run_at ----------------------------------------------------------------

/** A date-time with `Z` or an explicit offset — never host-local time. */
const RUN_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `run_at` → epoch ms, or the sentence that says why not. Strictly in the
 * future and within {@link SCHEDULE_MAX_HORIZON_MS}.
 */
export function parseRunAt(
  runAt: string,
  now: number,
): { ok: true; at: number } | { ok: false; problem: string } {
  const at = RUN_AT_PATTERN.test(runAt) ? Date.parse(runAt) : Number.NaN;
  if (!Number.isFinite(at)) {
    return {
      ok: false,
      problem:
        'run_at must be an ISO-8601 date-time with Z or an offset, e.g. "2026-11-01T18:00:00Z"',
    };
  }
  if (at <= now) {
    return {
      ok: false,
      problem: 'run_at is not in the future — apply without run_at to publish now',
    };
  }
  if (at - now > SCHEDULE_MAX_HORIZON_MS) {
    return { ok: false, problem: 'run_at is more than 30 days ahead' };
  }
  return { ok: true, at };
}
