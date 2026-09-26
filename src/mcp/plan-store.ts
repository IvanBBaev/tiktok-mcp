/**
 * The plan store — the execution tokens behind the two-step write contract
 * (TOOLS.md § 2.6.2, ARCHITECTURE.md § 8, CONTRACTS.md § mcp/plan-store.ts).
 *
 * A preview mints a `plan_id` and records the SHA-256 digest of the *fully
 * resolved* upstream payload. The apply call re-resolves the payload, recomputes
 * the digest and presents the token back; this module proves that the payload
 * did not change, that the token belongs to the same tool and account, that it
 * has not expired, and that it is used **at most once** (CC-E7).
 *
 * Deliberately in-process and non-persistent: a restart invalidates every
 * outstanding plan and re-previewing is the *designed* recovery. Nothing here
 * touches the filesystem, the network or the wall clock — time always arrives
 * through the injected {@link Clock} (or through {@link PlanRecord.createdAt}),
 * so the whole lifecycle is deterministic in tests.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { Buffer } from 'node:buffer';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock } from '../core/clock.js';

/** One outstanding execution token. */
export interface PlanRecord {
  /** `sha256Hex(canonicalJson(fully resolved payload))` — see `mcp/plan.ts`. */
  digest: string;
  /** Configured profile name the preview resolved to. */
  profile: string;
  /** `open_id` of the account the preview resolved to (never masked here). */
  openId: string;
  /** Tool name the preview was produced by, e.g. `tiktok_post_video`. */
  tool: string;
  /** `clock.now()` at mint time (epoch ms, CC-H2 — comparisons are numeric). */
  createdAt: number;
  /** Flipped by the first successful {@link consumePlan}; never flipped back. */
  used: boolean;
  /**
   * The local file's identity at preview time (CC-D3) — size, mtime, device and
   * inode, as one opaque string — or absent for a payload with no local file.
   *
   * Bound here rather than folded into {@link digest} on purpose. The digest is
   * also the duplicate guard's key (§ 2.6.5), and a re-copied or re-touched file
   * with the same bytes is the same post: an identity inside the digest would
   * let the guard wave a genuine duplicate through. Nor is it ever sent
   * upstream — it exists only so an apply can refuse a file that was swapped
   * for another of the same size between the preview a user approved and the
   * bytes about to leave.
   */
  fileIdentity?: string;
}

/** `plan_` + 32 lowercase hex chars (TOOLS.md § 2.6.2). */
export const PLAN_ID_PATTERN = /^plan_[0-9a-f]{32}$/;

/** 16 bytes of `crypto.randomBytes` → 32 hex chars. */
const PLAN_ID_BYTES = 16;

/**
 * The two settings the store obeys. Passed in rather than read from the
 * environment so the store stays a pure data structure (and so tests can drive
 * TTL and cap without touching `process.env`).
 *
 * Defaults mirror `core/settings.ts` (`TT_PLAN_TTL_S` = 600,
 * `TT_PLAN_MAX_OUTSTANDING` = 32); a test asserts the two stay in sync.
 */
export interface PlanLimits {
  /** `TT_PLAN_TTL_S` — seconds a plan stays applicable. */
  planTtlS: number;
  /** `TT_PLAN_MAX_OUTSTANDING` — hard cap on live plans; oldest evicted. */
  planMaxOutstanding: number;
}

/**
 * Additive optional argument on the frozen CONTRACTS.md signatures: the
 * contract names `settings.planTtlS` / `settings.planMaxOutstanding` as
 * governing TTL and cap but gives the functions no way to receive them.
 * Omitting it falls back to the documented defaults.
 */
export interface PlanStoreOptions {
  limits?: PlanLimits;
}

/** `TT_PLAN_TTL_S` default (CONFIGURATION.md). */
export const DEFAULT_PLAN_TTL_S = 600;

/** `TT_PLAN_MAX_OUTSTANDING` default (CONFIGURATION.md). */
export const DEFAULT_PLAN_MAX_OUTSTANDING = 32;

const DEFAULT_LIMITS: PlanLimits = Object.freeze({
  planTtlS: DEFAULT_PLAN_TTL_S,
  planMaxOutstanding: DEFAULT_PLAN_MAX_OUTSTANDING,
});

/**
 * The store. One `Map` for the life of the process, insertion-ordered, never
 * persisted, never shared between profiles (the record carries its own).
 */
const plans = new Map<string, PlanRecord>();

function limitsOf(options: PlanStoreOptions): PlanLimits {
  return options.limits ?? DEFAULT_LIMITS;
}

/** TTL in ms; a non-positive TTL means "expired the instant it was minted". */
function ttlMsOf(limits: PlanLimits): number {
  return Math.max(0, limits.planTtlS) * 1000;
}

/**
 * `expires_at` is the first instant a plan is no longer accepted: a plan minted
 * at `t` with TTL 600 s is applicable on `[t, t + 600_000)`.
 *
 * A clock that steps backwards (CC-H1) simply yields a negative age — never
 * expired, never a crash.
 */
function isExpired(record: PlanRecord, now: number, ttlMs: number): boolean {
  return now - record.createdAt >= ttlMs;
}

/** Reclaims every expired entry — the sweep-on-creation half of the policy. */
function sweepExpired(now: number, ttlMs: number): void {
  for (const [id, record] of plans) {
    if (isExpired(record, now, ttlMs)) plans.delete(id);
  }
}

/** Evicts the oldest used plan, else the oldest plan, by `createdAt`; ties break on insertion order. */
function evictOldest(): void {
  // A used plan goes first: it can only ever answer `plan_not_found`, which an
  // unknown id answers too, while a live one still has a publish waiting on it.
  let oldestId: string | undefined;
  let oldestKey = Number.POSITIVE_INFINITY;
  for (const [id, record] of plans) {
    const key = record.used
      ? record.createdAt - Number.MAX_SAFE_INTEGER
      : record.createdAt;
    if (key < oldestKey) {
      oldestKey = key;
      oldestId = id;
    }
  }
  if (oldestId !== undefined) plans.delete(oldestId);
}

/**
 * A fresh execution token: `plan_` + 32 lowercase hex chars, 16 bytes of
 * `crypto.randomBytes`. Random by construction — never derived from the
 * payload, so a token can never be guessed from the arguments it approves.
 */
export function mintPlanId(): string {
  return `plan_${randomBytes(PLAN_ID_BYTES).toString('hex')}`;
}

/**
 * Records an outstanding plan.
 *
 * Bounded on both axes: expired entries are swept first (using the new
 * record's own timestamp as "now", so no clock is needed), then the oldest
 * survivor is evicted until the cap has room. A client can therefore mint
 * forever without growing the process.
 *
 * The record is copied — the caller cannot reach in later and flip `used`.
 */
export function storePlan(
  id: string,
  rec: PlanRecord,
  options: PlanStoreOptions = {},
): void {
  const limits = limitsOf(options);
  sweepExpired(rec.createdAt, ttlMsOf(limits));
  // Re-storing a known id replaces it instead of counting twice.
  plans.delete(id);
  // Clamped: a cap below 1 would otherwise loop forever on an empty store.
  const cap = Math.max(1, Math.floor(limits.planMaxOutstanding));
  while (plans.size >= cap) evictOldest();
  plans.set(id, { ...rec });
}

/**
 * Why a consume attempt failed. Surfaced to callers as **exactly two** error
 * codes (TOOLS.md § 2.6.3): `plan_not_found` for `unknown | expired |
 * already_used`, `plan_mismatch` for the rest — see `planFailureError()` in
 * `mcp/plan.ts`.
 */
export type ConsumeFailure =
  | 'unknown'
  | 'expired'
  | 'already_used'
  | 'payload_mismatch'
  | 'account_mismatch'
  | 'tool_mismatch'
  | 'file_changed';

/** What the apply call claims the plan approved. */
export interface PlanExpectation {
  /** Digest recomputed over the *re-resolved* payload (TOOLS.md § 2.6.3 step 4). */
  digest: string;
  profile: string;
  openId: string;
  tool: string;
  /** The re-resolved file's identity, compared verbatim with the preview's. */
  fileIdentity?: string;
}

export type ConsumeResult = { ok: true } | { ok: false; reason: ConsumeFailure };

/**
 * Constant-time digest comparison. Length is compared first (unavoidably
 * leaking it) because `timingSafeEqual` throws on mismatched lengths; both
 * sides are fixed-width SHA-256 hex in practice.
 */
function digestEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The verdict plus the record it was reached about.
 *
 * {@link verifyPlan} and {@link consumePlan} run the identical checks and
 * differ only in what they do afterwards, so the checks live here once. The
 * record travels out with the verdict because `consumePlan` needs the very
 * object the checks were performed on: re-reading the `Map` after the fact
 * would reintroduce a `PlanRecord | undefined` the type system cannot narrow
 * away, and the resulting dead branch would have to be excluded from coverage
 * rather than tested. `verifyPlan` drops the record on the way out, so the
 * exported result type stays the two-armed {@link ConsumeResult}.
 */
type LocatedPlan =
  { ok: true; record: PlanRecord } | { ok: false; reason: ConsumeFailure };

/**
 * Runs every check a consume attempt makes, without mutating the store.
 *
 * Expiry is checked before `used` (the doc lists them the other way round):
 * lazy eviction has to happen on access, and an expired-but-used plan is more
 * honestly reported as expired. Both map to `plan_not_found`, so the
 * distinction is invisible to callers.
 */
function locatePlan(
  id: string,
  expect: PlanExpectation,
  clock: Clock,
  options: PlanStoreOptions = {},
): LocatedPlan {
  const limits = limitsOf(options);
  const now = clock.now();
  const record = plans.get(id);
  if (record === undefined) return { ok: false, reason: 'unknown' };
  if (isExpired(record, now, ttlMsOf(limits))) {
    plans.delete(id);
    return { ok: false, reason: 'expired' };
  }
  if (record.used) return { ok: false, reason: 'already_used' };
  if (record.tool !== expect.tool) return { ok: false, reason: 'tool_mismatch' };
  if (record.profile !== expect.profile || record.openId !== expect.openId) {
    return { ok: false, reason: 'account_mismatch' };
  }
  if (!digestEquals(record.digest, expect.digest)) {
    return { ok: false, reason: 'payload_mismatch' };
  }
  // Last, because a changed digest already says more: the arguments differ.
  // Both sides absent is equal, which is every URL-sourced and photo payload.
  if (record.fileIdentity !== expect.fileIdentity) {
    return { ok: false, reason: 'file_changed' };
  }
  return { ok: true, record };
}

/**
 * Everything {@link consumePlan} checks, *without* marking the plan used.
 *
 * The execute pipeline verifies at step 5 but consumes only at step 7, with the
 * duplicate guard in between (TOOLS.md § 2.6.3). A `possible_duplicate`
 * rejection has to leave the same `plan_id` appliable with `force: true`, which
 * it would not if verification consumed.
 *
 * The checks themselves live in {@link locatePlan}; this drops the record it
 * returns, so callers cannot reach in and flip `used` behind the store's back.
 */
export function verifyPlan(
  id: string,
  expect: PlanExpectation,
  clock: Clock,
  options: PlanStoreOptions = {},
): ConsumeResult {
  const located = locatePlan(id, expect, clock, options);
  return located.ok ? { ok: true } : located;
}

/**
 * Verifies and atomically consumes a plan.
 *
 * "Atomically" is literal rather than aspirational: the whole check-and-mark is
 * synchronous with no `await` between reading `used` and setting it, so two
 * concurrent applies of one `plan_id` can never both win — the second one gets
 * `already_used` (CC-E7, CC-G5). Callers must invoke this **before** the
 * journal intent append and the init dispatch.
 *
 * A caller that already ran {@link verifyPlan} still calls this and still has
 * to honour its verdict: the two are separated by the duplicate guard's file
 * read, and a concurrent apply may have consumed the plan in that window.
 */
export function consumePlan(
  id: string,
  expect: PlanExpectation,
  clock: Clock,
  options: PlanStoreOptions = {},
): ConsumeResult {
  const located = locatePlan(id, expect, clock, options);
  if (!located.ok) return located;
  // The mark is atomic because `locatePlan` handed back the record itself:
  // nothing is re-read between the check and the write, so there is no window
  // for an interleaving to widen and no `undefined` arm to explain away.
  located.record.used = true;
  return { ok: true };
}

/**
 * Live plans, including consumed-but-not-yet-expired ones. Diagnostics only
 * (`outstanding` is already on the redaction allowlist); never a control input.
 */
export function outstandingPlans(): number {
  return plans.size;
}

/**
 * Drops every plan. The process-wide `Map` is the store's whole identity, so
 * tests need a seam to isolate from each other — same pattern as
 * `resetTokenCache()` in `core/oauth.ts`. Not used in production code.
 */
export function resetPlanStore(): void {
  plans.clear();
}
