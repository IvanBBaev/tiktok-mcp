/**
 * Multi-process contention harness (TESTING.md § Multi-process env-lock harness).
 *
 * The env-file lock exists to stop two MCP server processes from refreshing the
 * same rotating refresh token at the same time. That is an inter-process
 * guarantee, so exactly one test proves it with real processes: N children fork,
 * meet at a barrier, and are released simultaneously into the contended window.
 *
 * The unit-level seams (contention → `env_file_busy`, stale lock, heartbeat,
 * release on throw) are tested in-process with `fsSandbox` and `mockClock` — both
 * layers are mandatory, because the fast seams cannot show that the lock is
 * honoured across an OS boundary, and the real race cannot exercise every branch.
 *
 * Every wait here is guarded by the caller's `AbortSignal` (use
 * `AbortSignal.timeout(...)`): a lock bug's natural failure mode is a deadlock,
 * and a deadlocked test that hangs CI for the whole job timeout reports nothing.
 * With the canary it reports "children never reached the barrier" in seconds.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** What one child reported back. */
export interface ChildOutcome {
  /** 0-based index, matching the `index` the worker was handed. */
  readonly index: number;
  /** Whether the worker returned instead of throwing. */
  readonly ok: boolean;
  /** The worker's return value (structured-cloned) when `ok`. */
  readonly payload?: unknown;
  /** `name: message` of what the worker threw, or why the child died. */
  readonly error?: string;
}

export interface ContendingChildrenOptions {
  /**
   * The **compiled** worker module — a path or a `file:` URL. Resolve it from
   * the test's own location, e.g.
   * `new URL('./workers/refresh-worker.js', import.meta.url)`.
   */
  readonly childModule: string | URL;
  /** How many children to run. Two is enough to contend; more widens the window. */
  readonly count: number;
  /**
   * Environment for the children, on top of the parent's. Put
   * `TT_ENV_FILE`/`TT_OAUTH_BASE_URL` here. `TIKTOK_MCP_TEST_INHERIT_ENV=1` is
   * added automatically so the children keep these instead of having the
   * harness's own `TT_` sanitizer strip them at import.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** JSON handed to every worker as `ctx.args`. */
  readonly args?: unknown;
  /** Deadlock canary. Strongly recommended: `AbortSignal.timeout(15_000)`. */
  readonly signal?: AbortSignal;
}

interface DoneMessage {
  readonly type: 'done';
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: string;
}

function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('type' in message))
    return undefined;
  const { type } = message;
  return typeof type === 'string' ? type : undefined;
}

/**
 * Fork `count` children, release them from one barrier, and collect what each
 * one returned.
 *
 * Resolves once every child has reported and exited — outcomes are ordered by
 * index, so a child that died without reporting still appears, with `ok: false`
 * and its stderr in `error`. Rejects only if the barrier itself fails (a child
 * dying before `ready`) or the canary fires; a worker that throws is a *result*,
 * not an error, since "the loser sees `env_file_busy`" is the expected outcome.
 *
 * Any child still alive is SIGKILLed on the way out, so a hung worker cannot
 * outlive the test.
 */
export async function runContendingChildren(
  opts: ContendingChildrenOptions,
): Promise<ChildOutcome[]> {
  const { count } = opts;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(
      `runContendingChildren: count must be an integer >= 1, got ${String(count)}`,
    );
  }

  const runner = fileURLToPath(new URL('./lock-child.js', import.meta.url));
  const moduleHref =
    opts.childModule instanceof URL
      ? opts.childModule.href
      : opts.childModule.startsWith('file:')
        ? opts.childModule
        : pathToFileURL(opts.childModule).href;

  const children: ChildProcess[] = [];
  const stderr = new Map<number, string>();
  const outcomes = new Map<number, ChildOutcome>();
  const ready: Promise<void>[] = [];
  const finished: Promise<void>[] = [];

  const canary =
    opts.signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          const abort = (): void => {
            const waiting = [...children.keys()].filter((i) => !outcomes.has(i));
            reject(
              new Error(
                `runContendingChildren: aborted with ${String(waiting.length)} of ` +
                  `${String(count)} child(ren) unfinished (indexes ${waiting.join(', ')}) — ` +
                  'the most likely cause is a lock that was never released',
              ),
            );
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });

  // `Promise.race` attaches a handler to the canary, so a late abort after the
  // race has settled is already accounted for and never surfaces as an
  // unhandled rejection.
  const guard = async <T>(work: Promise<T>): Promise<T> =>
    canary === undefined ? work : Promise.race([work, canary]);

  try {
    for (let index = 0; index < count; index += 1) {
      const child = fork(runner, [], {
        env: {
          ...process.env,
          ...opts.env,
          // The children need the TT_ variables the test set; the harness's
          // import-time sanitizer would otherwise wipe them.
          TIKTOK_MCP_TEST_INHERIT_ENV: '1',
          TIKTOK_MCP_TEST_CHILD_MODULE: moduleHref,
          TIKTOK_MCP_TEST_CHILD_INDEX: String(index),
          ...(opts.args === undefined
            ? {}
            : { TIKTOK_MCP_TEST_CHILD_ARGS: JSON.stringify(opts.args) }),
        },
        // stdout is piped, not inherited: a child writing to the parent's stdout
        // would corrupt the TAP stream `node --test` is parsing.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      stderr.set(index, '');

      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding('utf8');
        stream?.on('data', (chunk: string) => {
          stderr.set(index, (stderr.get(index) ?? '') + chunk);
        });
      }

      ready.push(
        new Promise<void>((resolve, reject) => {
          child.on('message', (message: unknown) => {
            if (messageType(message) === 'ready') resolve();
          });
          child.once('exit', (code, signal) => {
            reject(
              new Error(
                `runContendingChildren: child ${String(index)} exited ` +
                  `(code ${String(code)}, signal ${String(signal)}) before the barrier` +
                  `${stderr.get(index) === '' ? '' : `:\n${String(stderr.get(index))}`}`,
              ),
            );
          });
        }),
      );

      finished.push(
        new Promise<void>((resolve) => {
          child.on('message', (message: unknown) => {
            if (messageType(message) !== 'done') return;
            const done = message as DoneMessage;
            outcomes.set(index, {
              index,
              ok: done.ok,
              payload: done.payload,
              error: done.error,
            });
          });
          child.once('exit', (code, signal) => {
            if (!outcomes.has(index)) {
              outcomes.set(index, {
                index,
                ok: false,
                error:
                  `child exited (code ${String(code)}, signal ${String(signal)}) ` +
                  `without reporting${stderr.get(index) === '' ? '' : `:\n${String(stderr.get(index))}`}`,
              });
            }
            resolve();
          });
        }),
      );
    }

    // Barrier: everyone is loaded and waiting, so nobody gets a head start.
    await guard(Promise.all(ready));
    for (const child of children) child.send({ type: 'go' });
    await guard(Promise.all(finished));

    return [...outcomes.values()].sort((a, b) => a.index - b.index);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}
