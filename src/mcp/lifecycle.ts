/**
 * The credential-store watch behind `notifications/tools/list_changed` and
 * `notifications/resources/list_changed` (CC-A7, TOOLS.md § 6.3, CONTRACTS.md
 * § `mcp/lifecycle.ts`).
 *
 * `tools/list` already rebuilds every description from the credential store on
 * every request, so an `[UNAVAILABLE: …]` marker is never stale *when asked*
 * (TOOLS.md § 6.2). Nothing asks, though: an operator who runs `login` in a
 * second terminal has granted the missing scope, and the client still shows the
 * tool as unavailable until something makes it re-list. This module is that
 * something — it polls the store and calls back when the picture the tool list
 * is built from actually changed, which the caller turns into
 * `McpServerHandle.notifyListChanged()` — one callback for both lists, since a
 * resource description carries the same marker as its tool's.
 *
 * Three rules shape the whole module:
 *
 * - **Derived, not raw.** A file write is not a change. A token refresh
 *   rewrites the env file every couple of hours (and `TT_*` process-env
 *   overlays change nothing on disk at all), so the watch compares a canonical
 *   signature of *profile names plus their sorted scope sets* — the only inputs
 *   `unavailableMarker()` reads. An identical picture never notifies, however
 *   many times the bytes moved.
 * - **Polled through the clock, never `fs.watch`.** `fs.watch` misses
 *   rename-replacement (which is exactly how `persistProfilePatch` writes),
 *   is unreliable on network homes and fires differently on every platform
 *   (CC-H3), and it cannot be driven by `mockClock` (CC-H4). A tiny file read
 *   every couple of seconds is cheaper than the bugs. The interval is the
 *   debounce: two writes inside one tick collapse into one notification, and
 *   the floor is the 500 ms of TOOLS.md § 6.3.
 * - **Degrade, never throw.** An unreadable, vanished or malformed env file is
 *   a warning plus "no profiles"; a rejecting `onChange` is a warning. Nothing
 *   here may reject into the server's event loop, and nothing here is
 *   authoritative anyway — markers are advisory and the call-time scope check
 *   is the real gate (TOOLS.md § 6.1).
 *
 * ## Wiring (the composition root, `src/index.ts`)
 *
 * ```ts
 * const transport = await connectStdio(handle);
 * const watch = startCredentialWatch({
 *   envFilePath,
 *   clock: systemClock,
 *   logger,
 *   onChange: () => handle.notifyListChanged(),
 * });
 * await watch.poll(); // seed the baseline now instead of one tick from now
 * // …and in the shutdown handler, before server.close():
 * await watch.stop();
 * ```
 *
 * Order matters in both directions. Started **after** `connectStdio`, because
 * `notifyListChanged()` (the SDK's `sendToolListChanged()` underneath) throws
 * `Not connected` without a transport.
 * Stopped **before** `server.close()`, because a notification into a closing
 * transport is a rejection nobody needs to see.
 *
 * Framework-free on purpose: `onChange` is a plain callback, so the watch is
 * testable without a server and reusable by the HTTP transport, which owns a
 * different set of connected sessions.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import type { Clock } from '../core/clock.js';
import { listProfiles, readEnvFile, readProfile } from '../core/config.js';
import { isTikTokError } from '../core/errors.js';
import { canonicalJson } from '../core/json.js';
import { silentLogger, type Logger } from '../core/log.js';
import type { ProfileInfo } from './server.js';

/**
 * The debounce floor of TOOLS.md § 6.3. A shorter poll would turn a single
 * `login` — which rewrites the env file more than once — into a burst of
 * notifications.
 */
export const MIN_WATCH_INTERVAL_MS = 500;

/**
 * Default poll period. Fast enough that a `login` in another terminal is
 * visible before the operator has switched windows, slow enough that the read
 * is invisible next to everything else the process does.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** `clock.sleep` rejects above this, so an interval past it is not usable. */
const MAX_WATCH_INTERVAL_MS = 2_147_483_647;

/** Where a failed credential read is reported from. */
const READ_FAILURE_CODE = 'credential_store_unreadable';

/**
 * Sorted and de-duplicated: `TT_SCOPES` is an operator-edited comma list, so
 * `video.list,video.publish` and `video.publish,video.list,video.list` grant
 * exactly the same tools and must not read as a change.
 */
function normalizeScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes)].sort();
}

/**
 * The canonical fingerprint of everything the tool list reads out of the
 * credential store: every profile name with its normalized scope set, sorted by
 * name.
 *
 * All profiles, not just the active one — `unavailableMarker()` unions scopes
 * across profiles, so a *second* profile gaining `video.publish` changes what
 * the client should see even though the active profile did not move.
 *
 * Deliberately not a hash: the string is short, comparing it is cheap, and
 * having it readable makes a failing test say what actually differed.
 */
export function profileSignature(profiles: readonly ProfileInfo[]): string {
  const rows = profiles
    .map((profile) => ({
      name: profile.name,
      scopes: normalizeScopes(profile.scopes),
    }))
    // Code-unit order, not `localeCompare` — the signature must be identical on
    // every machine, and ICU collation is not (CC-H4).
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  return canonicalJson(rows);
}

/** What moved between two observations, by profile name. */
export interface ProfileDiff {
  /** Profiles that did not exist before — a first `login`, or a new account. */
  added: readonly string[];
  /** Profiles that disappeared — `logout`, or a hand-edited env file. */
  removed: readonly string[];
  /** Profiles that still exist but whose scope set changed (the CC-A7 case). */
  rescoped: readonly string[];
}

/**
 * Explains a signature change. Not needed to decide *whether* to notify — the
 * signature already did that — but a notification with no explanation is
 * unsupportable in the field, and the diff is what the log line prints.
 */
export function diffProfiles(
  previous: readonly ProfileInfo[],
  next: readonly ProfileInfo[],
): ProfileDiff {
  const before = scopeIndex(previous);
  const after = scopeIndex(next);
  const added: string[] = [];
  const removed: string[] = [];
  const rescoped: string[] = [];
  for (const [name, scopes] of after) {
    const had = before.get(name);
    if (had === undefined) added.push(name);
    else if (had !== scopes) rescoped.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) removed.push(name);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    rescoped: rescoped.sort(),
  };
}

function scopeIndex(profiles: readonly ProfileInfo[]): Map<string, string> {
  return new Map(
    profiles.map((profile) => [
      profile.name,
      canonicalJson(normalizeScopes(profile.scopes)),
    ]),
  );
}

/** Where {@link readCredentialProfiles} reads from. */
export interface CredentialSource {
  /** Resolved env file — `resolveEnvFilePath()` in the composition root. */
  envFilePath: string;
  /** Overrides `process.env` for the overlay. Test seam. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Presence-based overlay (CC-F2): the file supplies the baseline, the process
 * environment wins for every key it *has*, empty value included.
 *
 * A copy of `cli/index.ts`'s `overlayEnvFile` rather than an import of it —
 * `mcp` may not depend on `cli` (ARCHITECTURE.md layering, enforced by
 * ESLint), and eight lines of duplication are cheaper than inverting that.
 */
function overlayEnv(
  env: NodeJS.ProcessEnv,
  values: ReadonlyMap<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of values) merged[key] = value;
  return Object.assign(merged, env);
}

/**
 * The profile picture `tools/list` is built from: every configured profile with
 * the scopes it currently holds.
 *
 * The per-profile `catch` is not defensive noise. A half-written profile (an
 * interrupted `login`, a hand-edited file missing the client key) makes
 * `readProfile` throw, and an unreadable *one* profile must not blank out the
 * others — it reads as "no scopes", which marks its tools unavailable and
 * leaves every other profile intact. A failure of the *file* still propagates:
 * that is not partial knowledge, it is none.
 */
export async function readCredentialProfiles(
  source: CredentialSource,
): Promise<readonly ProfileInfo[]> {
  const snapshot = await readEnvFile(source.envFilePath);
  const env = overlayEnv(source.env ?? process.env, snapshot.values);
  return listProfiles(snapshot, env).map((name) => {
    try {
      const stored = readProfile(name, snapshot, env);
      return {
        name,
        scopes: stored.scopes ?? [],
        authorized: stored.accessToken !== undefined || stored.refreshToken !== undefined,
      };
    } catch {
      return { name, scopes: [], authorized: false };
    }
  });
}

/** Handed to `onChange` when the tool-visible picture moved. */
export interface CredentialChange extends ProfileDiff {
  /** The picture as of this poll — what a rebuilt `tools/list` would use. */
  profiles: readonly ProfileInfo[];
  /** The picture the previous notification (or the baseline) was taken from. */
  previous: readonly ProfileInfo[];
}

export interface CredentialWatchOptions {
  /** Resolved env file. Also the `env_file` field of every log line. */
  envFilePath: string;
  /** The `core/clock.ts` seam — the only source of time and delay here. */
  clock: Clock;
  /**
   * Called once per observed change, awaited before the next poll runs. A
   * rejection is logged and swallowed: the baseline still advances, so a failed
   * notification is not retried forever. Losing one `tools/list_changed` costs
   * a stale marker until the next change, and markers are advisory.
   */
  onChange: (change: CredentialChange) => void | Promise<void>;
  /**
   * Where to read the picture from. Defaults to {@link readCredentialProfiles}
   * over `envFilePath`. Pass `runtime.profiles` to guarantee the watch compares
   * byte-for-byte what `tools/list` builds from, whatever that is.
   */
  profiles?: () => Promise<readonly ProfileInfo[]>;
  /**
   * The picture already known to the caller. Omitted, the first poll seeds the
   * baseline silently and only the second one can notify — which is why
   * {@link CredentialWatcher.poll} is public.
   */
  baseline?: readonly ProfileInfo[];
  /** Poll period in ms. Default {@link DEFAULT_WATCH_INTERVAL_MS}. */
  intervalMs?: number;
  logger?: Logger;
  /** Overrides `process.env` for the default reader. Test seam. */
  env?: NodeJS.ProcessEnv;
}

export interface CredentialWatcher {
  /**
   * Reads once, right now, outside the tick. Resolves `true` if this poll
   * notified. Concurrent calls (and a manual call racing the loop) share one
   * in-flight read, so a change can never be reported twice.
   */
  poll(): Promise<boolean>;
  /**
   * Stops the loop and waits for it. Idempotent, and it leaves no pending timer
   * behind — a process whose last live handle is this watch exits after it.
   * A poll already in flight is awaited, so no callback runs after this
   * resolves.
   */
  stop(): Promise<void>;
}

/**
 * An interval that is not a usable delay falls back to the default with a
 * warning — same trade as `core/env-lock.ts`'s `duration()`. Throwing would
 * take the whole server down over a log-level detail; clamping silently would
 * hide the operator's typo. The upper bound is real: `clock.sleep` rejects
 * above 2^31-1 ms, which would kill the loop on its first tick.
 */
function watchInterval(
  value: number | undefined,
  envFilePath: string,
  logger: Logger,
): number {
  if (value === undefined) return DEFAULT_WATCH_INTERVAL_MS;
  if (
    Number.isFinite(value) &&
    value >= MIN_WATCH_INTERVAL_MS &&
    value <= MAX_WATCH_INTERVAL_MS
  ) {
    return value;
  }
  logger.warn(
    `credential watch interval must be a finite number of milliseconds between ` +
      `${String(MIN_WATCH_INTERVAL_MS)} and ${String(MAX_WATCH_INTERVAL_MS)}, got ` +
      `${String(value)}; using the default of ${String(DEFAULT_WATCH_INTERVAL_MS)} ms instead`,
    { env_file: envFilePath, code: 'invalid_watch_interval' },
  );
  return DEFAULT_WATCH_INTERVAL_MS;
}

/** `code` for the log line; a config failure keeps its own taxonomy code. */
function failureCode(cause: unknown): string {
  return isTikTokError(cause) ? cause.code : READ_FAILURE_CODE;
}

function failureReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Starts watching the credential store. Returns immediately; the first poll
 * happens one interval later (or now, if the caller calls
 * {@link CredentialWatcher.poll}).
 *
 * The loop is a `sleep`-driven `for(;;)`, not a repeating timer: one pending
 * sleep at a time means `stop()` can prove there is nothing left scheduled, and
 * a slow read delays the next tick instead of stacking on top of it.
 */
export function startCredentialWatch(opts: CredentialWatchOptions): CredentialWatcher {
  const logger = opts.logger ?? silentLogger;
  const intervalMs = watchInterval(opts.intervalMs, opts.envFilePath, logger);
  const source: CredentialSource = {
    envFilePath: opts.envFilePath,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  };
  const read = opts.profiles ?? (() => readCredentialProfiles(source));
  const stopping = new AbortController();

  let current: readonly ProfileInfo[] = opts.baseline ?? [];
  let signature =
    opts.baseline === undefined ? undefined : profileSignature(opts.baseline);
  let degraded = false;
  let inFlight: Promise<boolean> | undefined;

  /** Never throws: a store that cannot be read is a store with no profiles. */
  async function observe(): Promise<readonly ProfileInfo[]> {
    try {
      const profiles = await read();
      degraded = false;
      return profiles;
    } catch (cause) {
      const message =
        `the credential store could not be read; every tool reads as ` +
        `unavailable until it can be read again`;
      const fields = {
        env_file: opts.envFilePath,
        code: failureCode(cause),
        reason: failureReason(cause),
      };
      // A permanently broken file would otherwise warn on every single tick;
      // the transition is the news, the repetition is noise.
      if (degraded) logger.debug(message, fields);
      else logger.warn(message, fields);
      degraded = true;
      return [];
    }
  }

  async function runPoll(): Promise<boolean> {
    const profiles = await observe();
    const next = profileSignature(profiles);
    const previous = current;
    current = profiles;
    if (signature === undefined) {
      // First observation with no caller-supplied baseline: this *is* the
      // baseline. Notifying here would tell every client to re-list the tool
      // set it has just been given.
      signature = next;
      return false;
    }
    if (next === signature) return false;
    signature = next;
    const change: CredentialChange = {
      profiles,
      previous,
      ...diffProfiles(previous, profiles),
    };
    logger.info(
      `the credential store changed — added [${change.added.join(', ')}], ` +
        `removed [${change.removed.join(', ')}], rescoped [${change.rescoped.join(', ')}]; ` +
        `notifying clients that the tool list changed`,
      { env_file: opts.envFilePath, count: profiles.length },
    );
    try {
      await opts.onChange(change);
    } catch (cause) {
      logger.warn(
        `the tools/list_changed notification failed; clients keep the tool ` +
          `descriptions they already have until the next change`,
        { env_file: opts.envFilePath, reason: failureReason(cause) },
      );
    }
    return true;
  }

  function poll(): Promise<boolean> {
    // After `stop()` nothing may notify a transport that is being closed.
    if (stopping.signal.aborted) return Promise.resolve(false);
    inFlight ??= runPoll().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  const loop = (async () => {
    for (;;) {
      try {
        await opts.clock.sleep(intervalMs, stopping.signal);
      } catch {
        // `intervalMs` was validated to be a legal delay, so the only rejection
        // reachable here is the abort from `stop()`.
        return;
      }
      await poll();
    }
  })();

  return {
    poll,
    stop: async () => {
      stopping.abort();
      await loop;
      // A poll started through `poll()` runs outside the loop; it is the same
      // "already in flight" the contract promises to wait for.
      await inFlight;
    },
  };
}
