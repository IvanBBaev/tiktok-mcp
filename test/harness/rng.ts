/**
 * Seeded pseudo-randomness (TESTING.md § Extended harness, determinism rule 4).
 *
 * Anything random in a test comes from here: backoff jitter (the pinned-sequence
 * test), synthetic payload shuffling, and fast-check's global seed. `Math.random`
 * in a test is a flake waiting to happen — a failure that cannot be reproduced
 * from the printed seed is not a finding, it is noise.
 *
 * mulberry32: 32 bits of state, one multiply-xor-shift round. Not
 * cryptographic — nothing here generates a secret; entropy for `state`,
 * verifiers and `plan_id` comes from `node:crypto` in production and is
 * asserted by length/charset/uniqueness only (determinism rule 5).
 */

/** A seeded generator: call it for the next value in `[0, 1)`. */
export interface Rng {
  (): number;

  /** The seed this generator was built from — hand it to fast-check. */
  readonly seed: number;

  /** A uniform integer in `[0, maxExclusive)`; `maxExclusive` must be >= 1. */
  int(maxExclusive: number): number;

  /** A uniform element of `items`; throws on an empty array. */
  pick<T>(items: readonly T[]): T;

  /** `n` deterministic bytes — synthetic upload payloads, fake digests. */
  bytes(n: number): Uint8Array;
}

/**
 * Build a generator from `seed`. The same seed always produces the same
 * sequence, on every platform and Node version: the arithmetic is all
 * `Math.imul` and unsigned shifts, so there is no float-precision drift.
 */
export function makeRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new RangeError(`makeRng: seed must be an integer, got ${String(seed)}`);
  }

  let state = seed | 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const rng = next as Rng & { seed: number };
  rng.seed = seed;
  rng.int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(
        `Rng.int: maxExclusive must be an integer >= 1, got ${String(maxExclusive)}`,
      );
    }
    return Math.floor(next() * maxExclusive);
  };
  rng.pick = <T>(items: readonly T[]): T => {
    if (items.length === 0)
      throw new RangeError('Rng.pick: cannot pick from an empty array');
    // `int` is bounded by `items.length`, so the index is always in range.
    return items[rng.int(items.length)] as T;
  };
  rng.bytes = (n: number): Uint8Array => {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`Rng.bytes: n must be an integer >= 0, got ${String(n)}`);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = rng.int(256);
    return out;
  };
  return rng;
}
