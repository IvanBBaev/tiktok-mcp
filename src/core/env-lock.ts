/**
 * core/env-lock.ts — the cross-process mutex around the env file.
 *
 * Spec: CONTRACTS.md § core/env-lock, ARCHITECTURE.md § 7.2 (lock protocol) and
 * § 7.3 (the refresh critical section), CONFIGURATION.md § Env-file lock,
 * CORNER-CASES.md CC-A2 (two server processes refreshing the same rotating
 * refresh token), CC-F5 (writer collision; a stale lock is broken after a
 * bounded age, with a warning), CC-H3 (a lock failure must never discard a
 * valid in-memory token) and CC-H4 (deterministic under the injected clock).
 *
 * Design notes:
 *
 * - **Acquisition is `fs.mkdir`.** One directory creation, `recursive: false`:
 *   the first caller creates `<envfile>.lock`, everyone else gets `EEXIST`.
 *   That is atomic on every platform and every file system this server can be
 *   installed on, including SMB/NFS home directories where `O_EXCL` on a file
 *   is unreliable. A *recursive* mkdir would succeed on an existing directory
 *   and hand the lock to everybody, which is why the flag is never touched.
 * - **Liveness is mtime-only, never PID.** The `holder.json` written inside the
 *   directory is diagnostic: it tells an operator (and `doctor`) who to look
 *   for. It is not consulted to decide whether a lock is dead — a PID means
 *   nothing across a container boundary or a shared network home, and it can be
 *   recycled. A lock counts as dead only when its directory mtime is older than
 *   `staleMs`, which is a property the holder actively maintains.
 * - **The heartbeat decouples staleness from work length.** The holder touches
 *   the directory mtime every `heartbeatMs` (2 s) while `fn` runs, so a
 *   critical section that legitimately takes a minute is never mistaken for a
 *   crashed process, while a *crashed* holder is reclaimed after 15 s rather
 *   than blocking the account until someone deletes a directory by hand. The
 *   heartbeat must therefore always be much shorter than the stale threshold —
 *   `core/settings` refuses the inverted combination and this module warns
 *   about it when the options are passed directly (CC-F5).
 * - **A lock hand-over is bounded, not prevented.** Two processes that decide
 *   the same lock is stale race to remove it. The removal is a `rename` to a
 *   unique tombstone, which only one of them can win, and the winner checks
 *   the tombstone is the directory whose age it measured before deleting it —
 *   so a breaker that lost the race puts a successor's fresh lock back rather
 *   than deleting it, and only one process can win the following `mkdir`. The residual hazard — a holder
 *   whose lock was reclaimed while it was still writing — is what the heartbeat
 *   exists to make practically impossible; the heartbeat additionally *reports*
 *   the loss when it notices, and the release step then leaves the current
 *   holder's directory alone instead of deleting a lock it no longer owns.
 * - **Ownership is verified, not assumed.** "The directory exists" does not
 *   mean "the directory is mine": a holder that stalls past `staleMs` can have
 *   its lock broken and re-created by another process under the same path, and
 *   an unchecked `utimes` would then keep the *new* holder's lock fresh while
 *   an unchecked `rm` on release would delete it and let a third writer in.
 *   So every acquisition records an identity for the directory it created, and
 *   both the heartbeat touch and the release `rm` re-read it first; on a
 *   mismatch (or a vanished directory) the lock is treated as lost and left
 *   alone. The identity is the exact `holder.json` content, which carries a
 *   per-acquisition random `token` — portable to every file system, unlike an
 *   inode number, which is `0` or unstable on some Windows and network file
 *   systems. Only when that record could not be written does the identity fall
 *   back to the directory's `ino` + `birthtimeMs`. A check-then-act window of
 *   one syscall remains between the verification and the touch/`rm`; closing
 *   the hand-over from minutes to that window is what the check is for.
 * - **Not reentrant.** This is a file-system mutex with no in-process
 *   bookkeeping, so two concurrent callers inside one process serialize exactly
 *   like two processes do — and a *nested* acquisition of the same env file
 *   deadlocks until `waitMs` expires and then surfaces `env_file_busy`. The
 *   in-process guard belongs one layer up: `core/oauth` single-flights refresh
 *   per profile and only the winner takes this lock (ARCHITECTURE.md § 7.3).
 * - **Journal appends do not take this lock** — their `O_APPEND` writes need
 *   none (ARCHITECTURE.md § 8.3), and taking the credential lock for every
 *   journal line would serialize the whole server behind it. Journal *rotation*
 *   does use this mutex, keyed on `journal.ndjson` rather than the env file, so
 *   it never queues behind a token refresh (`label` names it in the messages).
 * - **Timeout is a retryable, actionable error.** On `env_file_busy` the caller
 *   (oauth) re-reads the env file once and adopts a token the other process
 *   rotated before surfacing anything (TOOLS.md § 3.0); a failure to *take* the
 *   lock never invalidates the credentials already in memory (CC-H3).
 */

import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { systemClock, type Clock } from './clock.js';
import { TikTokError } from './errors.js';
import { createLogger, type Logger } from './log.js';

/** Modes mirror `core/config`: the credential directory is owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Holder record inside the lock directory. Never liveness: its diagnostic
 * fields say who to look for, and its per-acquisition `token` makes the record
 * the ownership identity the heartbeat and the release step verify.
 */
const HOLDER_FILE = 'holder.json';

/**
 * Documented defaults (CONFIGURATION.md § Env-file lock). The composition root
 * passes `settings.envLockWaitMs` / `envLockStaleMs` / `envLockHeartbeatMs`,
 * which is where `TT_ENV_LOCK_*` is validated; these constants only cover a
 * direct caller that does not care.
 *
 * They are exported because two other modules need the same numbers and used to
 * spell them out again: `core/settings.ts` as the `TT_ENV_LOCK_*` defaults, and
 * `cli/doctor.ts` for the staleness verdict it prints when settings could not be
 * loaded. Three copies of one documented default is three chances to move two of
 * them — and the one that drifts is the doctor row, which is read precisely when
 * the configuration is already suspect.
 */
export const DEFAULT_WAIT_MS = 30_000;
export const DEFAULT_STALE_MS = 15_000;
export const DEFAULT_HEARTBEAT_MS = 2_000;

/** Contention retry window (ARCHITECTURE.md § 7.2: "50–150 ms jitter"). */
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 150;

/**
 * How often one `withEnvLock` call may reclaim a stale lock before it gives up
 * and waits like everyone else. Reclaiming is progress, so it deliberately does
 * not consume the wait budget — but an unbounded "break and retry" loop would
 * spin forever against a pathological `staleMs` of 0 with a busy competitor.
 */
const MAX_STALE_BREAKS = 3;

/** Options are additive to the contract signature; every one of them is a seam. */
export interface EnvLockOptions {
  /** Total time to wait for a held lock; default 30 000 ms. `0` = try once. */
  waitMs?: number;
  /** Age (by mtime) at which a lock is presumed dead; default 15 000 ms. */
  staleMs?: number;
  /** How often the holder touches the lock mtime; default 2 000 ms. */
  heartbeatMs?: number;
  clock?: Clock;
  /**
   * Where the stale-lock warning and the acquisition diagnostics go. Additive
   * to the documented signature: the contract requires a warning when a stale
   * lock is broken, and this module may not reach for a global sink.
   */
  logger?: Logger;
  /**
   * Source of the contention jitter, `[0, 1)`. Additive test seam: with a
   * seeded generator the retry ladder is deterministic (TESTING.md
   * determinism rule 4). Defaults to `Math.random`.
   */
  random?: () => number;
  /**
   * What the messages call the lock and the file it guards. Additive: the
   * journal takes this same mutex for rotation, and "another process is
   * updating the credential file" would send its reader to the wrong file.
   * Defaults to the env file's wording.
   */
  label?: { lock: string; guards: string };
}

/**
 * The lock directory for an env file: `<envfile>.lock`, a sibling of the file
 * itself so it inherits the same directory permissions and lands on the same
 * file system (a lock on a different volume would guarantee nothing).
 *
 * Exported so `doctor` can report a stale lock without duplicating the naming
 * rule.
 */
export function envLockDir(envFilePath: string): string {
  return `${envFilePath}.lock`;
}

/** Links followed before a chain counts as a loop (Linux's SYMLOOP_MAX). */
const MAX_LINK_HOPS = 40;

/**
 * The one spelling of a file that every writer agrees on: symlinks resolved, a
 * dangling chain followed hop by hop to the file it will create, and a file
 * that does not exist yet placed under its parent's real directory. The lock
 * directory and the atomic write both key on it — a symlink and its target
 * locked under two different names would exclude nothing while writing the
 * same bytes, and a write renamed onto a link mid-chain would replace that
 * link with a regular file.
 *
 * A loop has no file at its end; the path is then returned as given, and the
 * read that follows reports the loop.
 */
export async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    try {
      return await realpath(current);
    } catch {
      // Not there yet, or a link to something not there yet.
    }
    const parent = await realpath(dirname(current)).catch(() => dirname(current));
    const here = join(parent, basename(current));
    try {
      if (!(await lstat(here)).isSymbolicLink()) return here;
      // A relative target is relative to the link's real directory.
      current = resolve(parent, await readlink(here));
    } catch {
      // Nothing at the path at all: it is its own target.
      return here;
    }
  }
  return resolve(path);
}

/** Everything the acquire/heartbeat/release steps need, resolved once. */
interface LockState {
  readonly envFilePath: string;
  readonly lockDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly waitMs: number;
  readonly staleMs: number;
  readonly heartbeatMs: number;
  readonly random: () => number;
  /** e.g. `env-file`, as in "the env-file lock". */
  readonly lockLabel: string;
  /** e.g. `the credential file`. */
  readonly guards: string;
}

/**
 * Why the lock can no longer be treated as this acquisition's own. `lost` is
 * set when the directory is gone or now belongs to another holder; otherwise
 * the ownership could not be established (e.g. `EACCES`), which is reported
 * but is not proof that anyone else holds the lock.
 */
interface OwnershipFailure {
  readonly lost: boolean;
  readonly code: string;
}

/**
 * The identity of the directory one acquisition created: the exact holder
 * record it wrote (`record`), or — when that record could not be written — the
 * directory's `ino:birthtimeMs` (`stat`). `expected` is the failure itself when
 * even the fallback could not be captured.
 */
interface LockIdentity {
  readonly source: 'record' | 'stat';
  readonly expected: string | OwnershipFailure;
}

/** The diagnostic record, as far as it could be read back. */
interface LockHolder {
  readonly pid?: number;
  readonly hostname?: string;
  readonly createdAt?: string;
}

let fallbackLogger: Logger | undefined;
function defaultLogger(): Logger {
  fallbackLogger ??= createLogger();
  return fallbackLogger;
}

/** Same shape as `core/config`'s private helper; neither module exports it. */
function errnoOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * The errno to put in a log field, with a name for the values that carry none.
 * One helper rather than seven copies of `errnoOf(err) ?? 'unknown'`, because
 * only two of the seven catches can actually take the fallback and the other
 * five would be writing a case they can never exercise:
 *
 * - `writeHolder` and `lockUnusable` catch more than a syscall — a clock whose
 *   `toISOString` throws a `RangeError`, a diagnostic sink that throws a
 *   `TypeError` — so `unknown` is a real outcome there, and both are tested;
 * - the five sites whose `try` holds nothing but an `fs/promises` call
 *   (`breakStaleLock`'s `rename` and `rm`, `readIdentity`, the heartbeat's
 *   `utimes`, `release`) cannot reach it.
 *   Every rejection those produce is a `UVException` or a Node `ERR_*` error,
 *   both of which carry a string `code`; the one shape that does not — a path
 *   argument whose getter throws during validation — is ruled out by
 *   `envLockDir` (line 131), whose template literal makes `state.lockDir` a
 *   primitive string.
 */
function errnoCode(err: unknown): string {
  return errnoOf(err) ?? 'unknown';
}

/**
 * A duration option that is not a usable number falls back to the documented
 * default with a warning. Silently coercing it would hide the caller's bug;
 * throwing would fail a token refresh over a log-level detail, and the whole
 * point of CC-H3 is that lock trouble never costs a valid token.
 */
function duration(
  value: number | undefined,
  fallback: number,
  label: string,
  minMs: number,
  state: { envFilePath: string; logger: Logger },
): number {
  if (value === undefined) return fallback;
  if (Number.isFinite(value) && value >= minMs) return value;
  state.logger.warn(
    `env lock ${label} must be a finite number of milliseconds >= ${String(minMs)}, ` +
      `got ${String(value)}; using the default of ${String(fallback)} ms instead`,
    { env_file: state.envFilePath, code: 'invalid_env_lock_duration' },
  );
  return fallback;
}

function resolveOptions(envFilePath: string, opts: EnvLockOptions): LockState {
  const logger = opts.logger ?? defaultLogger();
  const base = { envFilePath, logger };
  const staleMs = duration(opts.staleMs, DEFAULT_STALE_MS, 'staleMs', 0, base);
  const heartbeatMs = duration(
    opts.heartbeatMs,
    DEFAULT_HEARTBEAT_MS,
    'heartbeatMs',
    1,
    base,
  );

  if (heartbeatMs >= staleMs) {
    // CC-F5: a heartbeat slower than the stale threshold lets a *live* holder be
    // declared dead and its lock stolen mid-write. `core/settings` rejects the
    // combination for `TT_ENV_LOCK_*`; a direct caller only gets this warning.
    logger.warn(
      `env lock heartbeat (${String(heartbeatMs)} ms) is not shorter than the stale ` +
        `threshold (${String(staleMs)} ms): a live holder can be declared stale mid-write`,
      { env_file: envFilePath, code: 'env_lock_heartbeat_too_slow' },
    );
  }

  return {
    envFilePath,
    lockDir: envLockDir(envFilePath),
    clock: opts.clock ?? systemClock,
    logger,
    waitMs: duration(opts.waitMs, DEFAULT_WAIT_MS, 'waitMs', 0, base),
    staleMs,
    heartbeatMs,
    random: opts.random ?? Math.random,
    lockLabel: opts.label?.lock ?? 'env-file',
    guards: opts.label?.guards ?? 'the credential file',
  };
}

/**
 * A jittered retry delay in `[50, 150]` ms. The spread matters: without it N
 * processes released from the same barrier would re-`mkdir` in lockstep forever.
 * A seam that returns something outside `[0, 1)` is clamped rather than allowed
 * to turn into a `NaN` delay that would abort the whole acquisition.
 */
function jitterMs(random: () => number): number {
  const raw = random();
  const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.5;
  return RETRY_MIN_MS + Math.round(bounded * (RETRY_MAX_MS - RETRY_MIN_MS));
}

/**
 * Age of the lock by mtime, or `undefined` when it cannot be stat'ed (it just
 * disappeared, or the directory is unreadable).
 *
 * The mtime comes from the *file system's* clock and `now()` from the injected
 * one — in production both are the system clock. A negative age (the clock
 * stepped backwards, or a network file system whose clock runs ahead) reads as
 * "fresh", which is the safe direction: a live lock is never stolen.
 */
async function lockAge(lockDir: string, clock: Clock): Promise<LockAge | undefined> {
  try {
    const info = await stat(lockDir);
    return { ageMs: clock.now() - info.mtimeMs, identity: staleIdentity(info) };
  } catch {
    return undefined;
  }
}

/** What the age was measured on: the directory itself, not whatever holds its path. */
interface LockAge {
  readonly ageMs: number;
  readonly identity: string;
}

/**
 * The identity of one lock directory as the file system sees it. A rename
 * keeps it; a directory re-created under the same path gets a new one (a
 * reused inode still carries a new birth time where the file system has one).
 */
function dirIdentity(info: { ino: number; birthtimeMs: number }): string {
  return `${String(info.ino)}:${String(info.birthtimeMs)}`;
}

/**
 * What a breaker compares before deleting: the directory identity plus the
 * mtime its age was measured on. Where the file system reports no birth time
 * (`birthtimeMs` is 0) a successor may reuse the inode and match on identity
 * alone; it cannot also carry the stale mtime, since taking a lock stamps a
 * fresh one. A rename leaves the mtime alone, and a holder that heartbeats in
 * between is alive — so a mismatch hands the lock back either way.
 */
function staleIdentity(info: {
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
}): string {
  return `${dirIdentity(info)}:${String(info.mtimeMs)}`;
}

/** Best-effort read of the diagnostic record; a damaged file simply says nothing. */
async function readHolder(lockDir: string): Promise<LockHolder> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(lockDir, HOLDER_FILE), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { pid, hostname: host, createdAt } = parsed as Record<string, unknown>;
    return {
      ...(typeof pid === 'number' ? { pid } : {}),
      ...(typeof host === 'string' ? { hostname: host } : {}),
      ...(typeof createdAt === 'string' ? { createdAt } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Write the holder record and return its exact content — the ownership
 * identity — or `undefined` when it could not be written. The diagnostic fields
 * say who to look for, never who to trust (CC-A2); the `token` is what tells
 * this acquisition's directory apart from a successor's under the same path.
 */
async function writeHolder(state: LockState): Promise<string | undefined> {
  try {
    // Building the record is inside the `try` on purpose: `hostname()` is a
    // syscall that can fail, and an escaping failure would reach `acquire`'s
    // catch, which reads every error there as a `mkdir` verdict — turning a
    // lock this process already holds into `env_lock_unusable` and leaving the
    // directory behind.
    const holder = {
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date(state.clock.now()).toISOString(), // CC-H2: ISO-8601 UTC
      token: randomUUID(),
    };
    const content = `${JSON.stringify(holder)}\n`;
    await writeFile(join(state.lockDir, HOLDER_FILE), content, { mode: FILE_MODE });
    return content;
  } catch (err) {
    // The lock is already held; failing here would throw away a valid mutex
    // over a diagnostic nicety.
    state.logger.debug(`could not write the ${state.lockLabel} lock holder record`, {
      dir: state.lockDir,
      code: errnoCode(err),
    });
    return undefined;
  }
}

/**
 * Read the current identity of the lock directory from `source`, or the
 * failure that prevented it. `ENOENT` means the directory (or the record in
 * it) is gone, which is a lost lock; any other errno only means it could not
 * be checked.
 */
async function readIdentity(
  lockDir: string,
  source: LockIdentity['source'],
): Promise<string | OwnershipFailure> {
  try {
    if (source === 'record') return await readFile(join(lockDir, HOLDER_FILE), 'utf8');
    return dirIdentity(await stat(lockDir));
  } catch (err) {
    const code = errnoCode(err);
    return { lost: code === 'ENOENT', code };
  }
}

/** Record the identity of the directory this acquisition just created. */
async function captureIdentity(state: LockState): Promise<LockIdentity> {
  const record = await writeHolder(state);
  if (record !== undefined) return { source: 'record', expected: record };
  return { source: 'stat', expected: await readIdentity(state.lockDir, 'stat') };
}

/**
 * Whether the lock directory is still the one this acquisition created:
 * `undefined` when it is, otherwise why it cannot be treated as ours.
 */
async function verifyOwnership(
  state: LockState,
  identity: LockIdentity,
): Promise<OwnershipFailure | undefined> {
  if (typeof identity.expected !== 'string') return identity.expected;
  const current = await readIdentity(state.lockDir, identity.source);
  if (typeof current !== 'string') return current;
  return current === identity.expected
    ? undefined
    : { lost: true, code: 'env_lock_replaced' };
}

/** The warning for a lock that was lost while held (vanished or replaced). */
function lossMessage(state: LockState, failure: OwnershipFailure): string {
  return failure.code === 'ENOENT'
    ? `the ${state.lockLabel} lock ${state.lockDir} vanished while it was held — another ` +
        `process may be writing ${state.envFilePath} at the same time`
    : `the ${state.lockLabel} lock ${state.lockDir} was reclaimed by another holder while it ` +
        `was held — another process may be writing ${state.envFilePath} at the same time`;
}

/** Whether anything is at `path`; an unreadable path counts as taken. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    return errnoOf(err) !== 'ENOENT';
  }
}

/**
 * Remove a lock whose mtime says its holder is gone (CC-F5). Returns whether
 * the directory is now clear to re-create.
 *
 * The age was measured by an earlier `stat`, and between that and the removal
 * another process may already have broken the same lock and taken a fresh one
 * under the same path. Removing the path would then delete a live lock. So the
 * directory is first moved aside with a `rename` — atomic, so of two breakers
 * only one gets it — and the tombstone is checked to be the very directory
 * whose age was measured. If it is not, it is somebody's live lock: it is put
 * back, and this call waits like any other contender.
 */
async function breakStaleLock(state: LockState, stale: LockAge): Promise<boolean> {
  const ageMs = stale.ageMs;
  const holder = await readHolder(state.lockDir);
  const tombstone = `${state.lockDir}.stale-${randomUUID()}`;
  try {
    await rename(state.lockDir, tombstone);
  } catch (err) {
    // `ENOENT`: another breaker got there first, and the path is clear or
    // already re-taken — either way the next `mkdir` decides.
    if (errnoOf(err) === 'ENOENT') return true;
    state.logger.warn(
      `could not remove the stale ${state.lockLabel} lock ${state.lockDir} ` +
        `(last touched ${String(Math.round(ageMs))} ms ago)`,
      {
        dir: state.lockDir,
        env_file: state.envFilePath,
        code: errnoCode(err),
      },
    );
    return false;
  }

  state.logger.debug(`moved the stale ${state.lockLabel} lock aside`, {
    dir: state.lockDir,
    tombstone,
  });
  let ours: boolean;
  try {
    ours = staleIdentity(await stat(tombstone)) === stale.identity;
  } catch {
    ours = false;
  }
  if (!ours) {
    // A successor's lock, taken after the age was measured: hand it back — but
    // only onto a free path. On POSIX a `rename` onto an empty directory
    // replaces it, and an empty directory there is a third process's lock in
    // the instant between its `mkdir` and its holder file.
    try {
      if (await exists(state.lockDir)) throw new Error('the lock path is taken');
      await rename(tombstone, state.lockDir);
      state.logger.debug(
        `the stale ${state.lockLabel} lock ${state.lockDir} was re-taken before it could be removed`,
        { dir: state.lockDir, env_file: state.envFilePath },
      );
      return false;
    } catch {
      // The path was taken yet again in between. The successor's heartbeat
      // reports the loss; the tombstone must not outlive it, so it is removed
      // below like any other.
    }
  }

  try {
    await rm(tombstone, { recursive: true, force: true });
  } catch (err) {
    // The path is already clear; only the remains are left behind.
    state.logger.warn(
      `could not delete the remains of the stale ${state.lockLabel} lock at ${tombstone}`,
      { dir: tombstone, env_file: state.envFilePath, code: errnoCode(err) },
    );
  }
  if (!ours) return false;

  // Visible by contract: a broken lock means some process died holding it, and
  // the operator needs to know that happened even though this call recovered.
  state.logger.warn(
    `removed a stale ${state.lockLabel} lock: ${state.lockDir} was last touched ` +
      `${String(Math.round(ageMs))} ms ago, past the ${String(state.staleMs)} ms ` +
      'stale threshold',
    {
      dir: state.lockDir,
      env_file: state.envFilePath,
      ...(holder.pid === undefined ? {} : { pid: holder.pid }),
      ...(holder.hostname === undefined ? {} : { hostname: holder.hostname }),
      ...(holder.createdAt === undefined ? {} : { created_at: holder.createdAt }),
    },
  );
  return true;
}

function busyError(state: LockState, waitedMs: number, attempts: number): TikTokError {
  const waitedS = Math.round(waitedMs / 100) / 10;
  return new TikTokError({
    kind: 'config',
    code: 'env_file_busy',
    message:
      `another tiktok-mcp-ai process is updating ${state.guards} ` +
      `${state.envFilePath} and did not release ${state.lockDir} within ` +
      `${String(waitedS)} s (${String(attempts)} attempt${attempts === 1 ? '' : 's'})`,
    retryable: true,
    remediation:
      'Wait a few seconds and try again. If nothing else is running, run: ' +
      'npx tiktok-mcp-ai doctor — it reports stale locks and how to clear them.',
  });
}

function lockUnusable(state: LockState, cause: unknown): TikTokError {
  const code = errnoCode(cause);
  return new TikTokError({
    kind: 'config',
    code: 'env_lock_unusable',
    message:
      `the ${state.lockLabel} lock directory ${state.lockDir} could not be created (${code}), ` +
      `so concurrent writes to ${state.guards} cannot be made safe`,
    remediation:
      `Check that ${dirname(state.lockDir)} exists and is writable by this user, ` +
      'or point TT_ENV_FILE at a writable location.',
    cause,
  });
}

/**
 * Take the lock, waiting up to `waitMs` with jittered retries.
 *
 * The deadline is re-derived from `clock.now()` on every wake rather than
 * accumulated from the sleeps, so a process suspended mid-sleep does not
 * silently extend its own budget (CC-H1).
 */
async function acquire(state: LockState): Promise<LockIdentity> {
  const { clock, lockDir, logger, staleMs } = state;
  const startedAt = clock.now();
  const deadline = startedAt + state.waitMs;
  let attempt = 0;
  let staleBreaks = 0;
  let parentCreated = false;

  for (;;) {
    attempt += 1;
    try {
      // `recursive` stays false on purpose: it is the entire mutual exclusion.
      await mkdir(lockDir, { mode: DIR_MODE });
      // Never throws: a failure to record the identity is itself the identity.
      const identity = await captureIdentity(state);
      logger.debug(`${state.lockLabel} lock acquired`, {
        dir: lockDir,
        env_file: state.envFilePath,
        attempt,
        duration_ms: clock.now() - startedAt,
      });
      return identity;
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT' && !parentCreated) {
        // First run on a fresh machine: the config directory does not exist yet.
        // Create it owner-only, exactly as `core/config` does, and try again.
        parentCreated = true;
        try {
          await mkdir(dirname(lockDir), { recursive: true, mode: DIR_MODE });
          continue;
        } catch (mkdirErr) {
          throw lockUnusable(state, mkdirErr);
        }
      }
      if (code !== 'EEXIST') throw lockUnusable(state, err);
    }

    const age = await lockAge(lockDir, clock);
    if (age !== undefined && age.ageMs > staleMs && staleBreaks < MAX_STALE_BREAKS) {
      staleBreaks += 1;
      // Reclaiming a dead lock is progress, not waiting: retry immediately
      // instead of spending part of the wait budget on it.
      if (await breakStaleLock(state, age)) continue;
    }

    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0) throw busyError(state, clock.now() - startedAt, attempt);
    await clock.sleep(Math.min(jitterMs(state.random), remainingMs));
  }
}

interface Heartbeat {
  /** Stop touching the lock and wait for the loop to finish. */
  stop(): Promise<void>;
  /** Whether the lock was observed to be gone or replaced while `fn` ran. */
  lost(): boolean;
}

/**
 * Keep the lock's mtime fresh while `fn` runs, so a slow critical section is
 * never mistaken for a dead process (CC-F5).
 *
 * Every touch is preceded by an ownership check: stamping a directory that now
 * belongs to another holder would keep *its* lock alive under our name and
 * hide the loss, so a vanished or replaced lock marks the heartbeat lost and
 * ends it without touching anything.
 *
 * Built from repeated bounded `clock.sleep`s rather than `setInterval` — the
 * timer globals are banned outside `core/clock` precisely so this loop is
 * drivable by `mockClock().advance()` (CC-H4).
 */
function startHeartbeat(state: LockState, identity: LockIdentity): Heartbeat {
  const { clock, heartbeatMs, lockDir, logger } = state;
  const stopping = new AbortController();
  let lost = false;

  const loop = (async (): Promise<void> => {
    for (;;) {
      try {
        await clock.sleep(heartbeatMs, stopping.signal);
      } catch (err) {
        if (stopping.signal.aborted) return; // the normal end: release() aborted us
        logger.warn(
          `the ${state.lockLabel} lock heartbeat for ${lockDir} stopped early; the lock may be ` +
            `declared stale after ${String(state.staleMs)} ms while it is still held`,
          {
            dir: lockDir,
            env_file: state.envFilePath,
            reason: err instanceof Error ? err.message : String(err),
          },
        );
        return;
      }

      let failure = await verifyOwnership(state, identity);
      if (failure === undefined) {
        const at = new Date(clock.now());
        try {
          await utimes(lockDir, at, at);
          continue;
        } catch (err) {
          const code = errnoCode(err);
          failure = { lost: code === 'ENOENT', code };
        }
      }

      lost = failure.lost;
      logger.warn(
        lost
          ? lossMessage(state, failure)
          : `could not refresh the mtime of the ${state.lockLabel} lock ${lockDir} ` +
              `(${failure.code}); it may be declared stale while it is still held`,
        { dir: lockDir, env_file: state.envFilePath, code: failure.code },
      );
      return;
    }
  })();

  return {
    stop: async (): Promise<void> => {
      stopping.abort();
      await loop;
    },
    lost: () => lost,
  };
}

/**
 * Release: stop the heartbeat, verify the directory is still ours, then delete
 * it. Never throws.
 */
async function release(
  state: LockState,
  identity: LockIdentity,
  heartbeat: Heartbeat,
): Promise<void> {
  await heartbeat.stop();
  // The heartbeat already saw the loss and reported it.
  if (heartbeat.lost()) return;

  // The directory may have been reclaimed since the last beat and now belong to
  // a different holder; deleting it would hand the lock to a third process.
  // Ownership that could not be established is not deleted blind either; the
  // lock is left for the stale threshold to reclaim.
  const failure = await verifyOwnership(state, identity);
  if (failure !== undefined) {
    state.logger.warn(failure.lost ? lossMessage(state, failure) : leakedMessage(state), {
      dir: state.lockDir,
      env_file: state.envFilePath,
      code: failure.code,
    });
    return;
  }

  try {
    await rm(state.lockDir, { recursive: true, force: true });
  } catch (err) {
    state.logger.warn(leakedMessage(state), {
      dir: state.lockDir,
      env_file: state.envFilePath,
      code: errnoCode(err),
    });
  }
}

/** The warning for a lock this process owns but could not remove. */
function leakedMessage(state: LockState): string {
  return (
    `could not remove the ${state.lockLabel} lock ${state.lockDir}; the next writer will ` +
    `treat it as stale after ${String(state.staleMs)} ms`
  );
}

/**
 * Run `fn` while holding the cross-process lock on `envFilePath`.
 *
 * `fn` runs exactly once, and only after the lock is held. The lock is released
 * in a `finally`, and release failures are logged rather than thrown, so
 * whatever `fn` produced — value or error — is what the caller sees.
 *
 * @throws TikTokError `env_file_busy` (retryable) when the lock was still held
 *   after `waitMs`; `env_lock_unusable` when the lock directory cannot be
 *   created at all. Neither one invalidates credentials already in memory
 *   (CC-H3) — the caller degrades, it does not log the user out.
 */
export async function withEnvLock<T>(
  envFilePath: string,
  fn: () => Promise<T>,
  opts: EnvLockOptions = {},
): Promise<T> {
  const state = resolveOptions(await canonicalPath(envFilePath), opts);
  const identity = await acquire(state);
  const heartbeat = startHeartbeat(state, identity);
  try {
    return await fn();
  } finally {
    await release(state, identity, heartbeat);
  }
}
