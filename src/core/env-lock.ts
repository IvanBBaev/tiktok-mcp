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
 *   the same lock is stale race to remove it, but only one of them can win the
 *   following `mkdir`, so the mutex still holds. The residual hazard — a holder
 *   whose lock was reclaimed while it was still writing — is what the heartbeat
 *   exists to make practically impossible; the heartbeat additionally *reports*
 *   the loss when it notices, and the release step then leaves the current
 *   holder's directory alone instead of deleting a lock it no longer owns.
 * - **Not reentrant.** This is a file-system mutex with no in-process
 *   bookkeeping, so two concurrent callers inside one process serialize exactly
 *   like two processes do — and a *nested* acquisition of the same env file
 *   deadlocks until `waitMs` expires and then surfaces `env_file_busy`. The
 *   in-process guard belongs one layer up: `core/oauth` single-flights refresh
 *   per profile and only the winner takes this lock (ARCHITECTURE.md § 7.3).
 * - **The journal does not use this lock** — its `O_APPEND` writes need none
 *   (ARCHITECTURE.md § 8.3), and taking the credential lock for every journal
 *   line would serialize the whole server behind it.
 * - **Timeout is a retryable, actionable error.** On `env_file_busy` the caller
 *   (oauth) re-reads the env file once and adopts a token the other process
 *   rotated before surfacing anything (TOOLS.md § 3.0); a failure to *take* the
 *   lock never invalidates the credentials already in memory (CC-H3).
 */

import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { systemClock, type Clock } from './clock.js';
import { TikTokError } from './errors.js';
import { createLogger, type Logger } from './log.js';

/** Modes mirror `core/config`: the credential directory is owner-only. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Diagnostic-only holder record inside the lock directory (never liveness). */
const HOLDER_FILE = 'holder.json';

/**
 * Documented defaults (CONFIGURATION.md § Env-file lock). The composition root
 * passes `settings.envLockWaitMs` / `envLockStaleMs` / `envLockHeartbeatMs`,
 * which is where `TT_ENV_LOCK_*` is validated; these constants only cover a
 * direct caller that does not care.
 */
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 2_000;

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
async function lockAgeMs(lockDir: string, clock: Clock): Promise<number | undefined> {
  try {
    const info = await stat(lockDir);
    return clock.now() - info.mtimeMs;
  } catch {
    return undefined;
  }
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

/** Diagnostics only — who to look for, never who to trust (CC-A2). */
async function writeHolder(state: LockState): Promise<void> {
  const holder = {
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date(state.clock.now()).toISOString(), // CC-H2: ISO-8601 UTC
  };
  try {
    await writeFile(join(state.lockDir, HOLDER_FILE), `${JSON.stringify(holder)}\n`, {
      mode: FILE_MODE,
    });
  } catch (err) {
    // The lock is already held; failing here would throw away a valid mutex
    // over a diagnostic nicety.
    state.logger.debug('could not write the env-file lock holder record', {
      dir: state.lockDir,
      code: errnoOf(err) ?? 'unknown',
    });
  }
}

/**
 * Remove a lock whose mtime says its holder is gone (CC-F5). Returns whether
 * the directory is now clear to re-create.
 */
async function breakStaleLock(state: LockState, ageMs: number): Promise<boolean> {
  const holder = await readHolder(state.lockDir);
  try {
    await rm(state.lockDir, { recursive: true, force: true });
  } catch (err) {
    state.logger.warn(
      `could not remove the stale env-file lock ${state.lockDir} ` +
        `(last touched ${String(Math.round(ageMs))} ms ago)`,
      {
        dir: state.lockDir,
        env_file: state.envFilePath,
        code: errnoOf(err) ?? 'unknown',
      },
    );
    return false;
  }

  // Visible by contract: a broken lock means some process died holding it, and
  // the operator needs to know that happened even though this call recovered.
  state.logger.warn(
    `removed a stale env-file lock: ${state.lockDir} was last touched ` +
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
      `another tiktok-mcp-ai process is updating the credential file ` +
      `${state.envFilePath} and did not release ${state.lockDir} within ` +
      `${String(waitedS)} s (${String(attempts)} attempt${attempts === 1 ? '' : 's'})`,
    retryable: true,
    remediation:
      'Wait a few seconds and try again. If nothing else is running, run: ' +
      'npx tiktok-mcp-ai doctor — it reports stale locks and how to clear them.',
  });
}

function lockUnusable(state: LockState, cause: unknown): TikTokError {
  const code = errnoOf(cause) ?? 'unknown';
  return new TikTokError({
    kind: 'config',
    code: 'env_lock_unusable',
    message:
      `the env-file lock directory ${state.lockDir} could not be created (${code}), ` +
      'so concurrent credential writes cannot be made safe',
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
async function acquire(state: LockState): Promise<void> {
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
      await writeHolder(state);
      logger.debug('env-file lock acquired', {
        dir: lockDir,
        env_file: state.envFilePath,
        attempt,
        duration_ms: clock.now() - startedAt,
      });
      return;
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

    const ageMs = await lockAgeMs(lockDir, clock);
    if (ageMs !== undefined && ageMs > staleMs && staleBreaks < MAX_STALE_BREAKS) {
      staleBreaks += 1;
      // Reclaiming a dead lock is progress, not waiting: retry immediately
      // instead of spending part of the wait budget on it.
      if (await breakStaleLock(state, ageMs)) continue;
    }

    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0) throw busyError(state, clock.now() - startedAt, attempt);
    await clock.sleep(Math.min(jitterMs(state.random), remainingMs));
  }
}

interface Heartbeat {
  /** Stop touching the lock and wait for the loop to finish. */
  stop(): Promise<void>;
  /** Whether the lock directory was observed to be gone while `fn` ran. */
  lost(): boolean;
}

/**
 * Keep the lock's mtime fresh while `fn` runs, so a slow critical section is
 * never mistaken for a dead process (CC-F5).
 *
 * Built from repeated bounded `clock.sleep`s rather than `setInterval` — the
 * timer globals are banned outside `core/clock` precisely so this loop is
 * drivable by `mockClock().advance()` (CC-H4).
 */
function startHeartbeat(state: LockState): Heartbeat {
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
          `the env-file lock heartbeat for ${lockDir} stopped early; the lock may be ` +
            `declared stale after ${String(state.staleMs)} ms while it is still held`,
          {
            dir: lockDir,
            env_file: state.envFilePath,
            reason: err instanceof Error ? err.message : String(err),
          },
        );
        return;
      }

      const at = new Date(clock.now());
      try {
        await utimes(lockDir, at, at);
      } catch (err) {
        const code = errnoOf(err) ?? 'unknown';
        lost = code === 'ENOENT';
        logger.warn(
          lost
            ? `the env-file lock ${lockDir} vanished while it was held — another ` +
                `process may be writing ${state.envFilePath} at the same time`
            : `could not refresh the mtime of the env-file lock ${lockDir} (${code}); ` +
                'it may be declared stale while it is still held',
          { dir: lockDir, env_file: state.envFilePath, code },
        );
        return;
      }
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

/** Release: stop the heartbeat, then delete the lock directory. Never throws. */
async function release(state: LockState, heartbeat: Heartbeat): Promise<void> {
  await heartbeat.stop();
  // The directory was already reclaimed by someone else and may now belong to a
  // different holder; deleting it would hand the lock to a third process.
  if (heartbeat.lost()) return;

  try {
    await rm(state.lockDir, { recursive: true, force: true });
  } catch (err) {
    state.logger.warn(
      `could not remove the env-file lock ${state.lockDir}; the next writer will ` +
        `treat it as stale after ${String(state.staleMs)} ms`,
      {
        dir: state.lockDir,
        env_file: state.envFilePath,
        code: errnoOf(err) ?? 'unknown',
      },
    );
  }
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
  const state = resolveOptions(envFilePath, opts);
  await acquire(state);
  const heartbeat = startHeartbeat(state);
  try {
    return await fn();
  } finally {
    await release(state, heartbeat);
  }
}
