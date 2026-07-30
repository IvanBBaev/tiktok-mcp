/**
 * Self-test worker: one child wins, the rest report a failure.
 *
 * Mirrors the shape every lock test has — a single winner and N losers that see
 * `env_file_busy` — without needing the lock to exist yet. It pins the contract
 * that a worker which *throws* is a reported outcome (`ok: false`), not a harness
 * error: the losing children are the expected result of a contention test, so
 * `runContendingChildren` must not reject on them.
 */

import type { ChildContext } from '../lock-child.js';

export default function outcomeWorker(ctx: ChildContext): unknown {
  if (ctx.index !== 0) {
    throw new Error(`env_file_busy: child ${String(ctx.index)} lost the race`);
  }
  return { index: ctx.index, args: ctx.args, won: true };
}
