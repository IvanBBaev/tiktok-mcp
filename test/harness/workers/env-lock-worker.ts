/**
 * Multi-process worker: contend for one env file through `withEnvLock`.
 *
 * Every child does a read-modify-write of a counter line in the same env file
 * *inside* the lock, with a deliberate real-time pause between the read and the
 * write to make the window wide enough that an unlocked run would lose updates.
 * It also appends an `enter`/`leave` pair to a shared trace file (`O_APPEND`, no
 * lock of its own — the journal precedent), so the parent can prove the critical
 * sections did not interleave rather than merely that the arithmetic worked out.
 *
 * The counter value each child *observed* is what makes the proof sharp: under a
 * working mutex the four children see 0, 1, 2, 3 in some order, while two
 * children that ever overlap must see the same number.
 *
 * Everything comes in through `ctx.args` — no `TT_` variables are read, so this
 * worker deliberately skips the import-time sanitizer that `refresh-worker`
 * needs, and the parent's environment cannot change what is being measured.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { envLockDir, withEnvLock } from '../../../src/core/env-lock.js';
import type { ChildContext } from '../lock-child.js';

/** The line the children fight over; shaped like a real env entry. */
const COUNTER_KEY = 'TT_TEST_COUNTER';

interface WorkerArgs {
  readonly envFile: string;
  readonly tracePath: string;
  /** Real milliseconds to hold the lock between reading and writing. */
  readonly holdMs: number;
  readonly waitMs: number;
}

function parseArgs(raw: unknown): WorkerArgs {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('env-lock-worker: args must be an object');
  }
  const { envFile, tracePath, holdMs, waitMs } = raw as Record<string, unknown>;
  if (typeof envFile !== 'string' || typeof tracePath !== 'string') {
    throw new TypeError('env-lock-worker: args.envFile and args.tracePath are required');
  }
  return {
    envFile,
    tracePath,
    holdMs: typeof holdMs === 'number' ? holdMs : 40,
    waitMs: typeof waitMs === 'number' ? waitMs : 10_000,
  };
}

/**
 * A real sleep — the one place TESTING.md allows it. `core/clock` is not used
 * here on purpose: the point of this worker is that the mutex holds against the
 * operating system's scheduler, not against a virtual clock.
 */
function hold(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readCounter(envFile: string): Promise<number> {
  const text = await readFile(envFile, 'utf8');
  const match = new RegExp(`^${COUNTER_KEY}=(\\d+)$`, 'm').exec(text);
  const value = match?.[1];
  return value === undefined ? 0 : Number(value);
}

/** The lock's own `holder.json`, read from inside the critical section. */
async function holderPid(envFile: string): Promise<number | undefined> {
  const raw: unknown = JSON.parse(
    await readFile(join(envLockDir(envFile), 'holder.json'), 'utf8'),
  );
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { pid } = raw as { pid?: unknown };
  return typeof pid === 'number' ? pid : undefined;
}

async function trace(tracePath: string, event: string, index: number): Promise<void> {
  await appendFile(tracePath, `${JSON.stringify({ event, index })}\n`);
}

export default async function envLockWorker(ctx: ChildContext): Promise<unknown> {
  const args = parseArgs(ctx.args);

  const result = await withEnvLock(
    args.envFile,
    async () => {
      await trace(args.tracePath, 'enter', ctx.index);
      const seen = await readCounter(args.envFile);
      const pid = await holderPid(args.envFile);
      await hold(args.holdMs);
      await writeFile(args.envFile, `${COUNTER_KEY}=${String(seen + 1)}\n`, {
        mode: 0o600,
      });
      await trace(args.tracePath, 'leave', ctx.index);
      return { seen, ownsHolderRecord: pid === process.pid };
    },
    { waitMs: args.waitMs },
  );

  return { index: ctx.index, pid: process.pid, ...result };
}
