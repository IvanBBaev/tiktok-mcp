/**
 * The glue around the plan store (TOOLS.md § 2.6, § 2.8, § 3.0): payload
 * digests, `TT_WRITE_MODE` step resolution, the local publish rate bucket, and
 * the normative error/hint texts of the two-step write contract.
 *
 * Everything here is pure or clock-driven — no network, no filesystem, no
 * `Date.now()`. The tools (TD-4) own the resolution of a payload; this module
 * owns what happens to it afterwards, so the digest rules and the catalog texts
 * live in exactly one place.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import type { Clock } from '../core/clock.js';
import { canonicalJson, sha256Hex } from '../core/json.js';
import type { Settings, WriteMode } from '../core/settings.js';
import type { Hint, ToolError } from './result.js';
import type { ConsumeFailure } from './plan-store.js';

// ---------------------------------------------------------------------------
// Payload digest
// ---------------------------------------------------------------------------

/**
 * Call-shaping arguments that are **not** payload and never enter the digest
 * (TOOLS.md § 2.6.2). They change how the server behaves, not what TikTok
 * receives, so including them would make a plan un-appliable by construction.
 */
export const CONTROL_FIELDS: readonly string[] = Object.freeze([
  'plan_id',
  'force',
  'wait_for_completion',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SHA-256 over `canonicalJson()` of the **fully resolved upstream payload** —
 * post-defaults, post-normalization, exactly the bytes the API would receive
 * (`post_info` + resolved source info + resolved `post_mode`).
 *
 * Two different resolved payloads cannot share a digest (canonical JSON is
 * injective over the values it accepts), and re-resolving an unchanged request
 * reproduces the digest byte-for-byte — which is the entire security property
 * the apply step rests on. Key order, `undefined` vs absent, and `-0` vs `0`
 * are all normalized by `canonicalJson`; unrepresentable values (NaN, bigint,
 * cycles, class instances) throw there with a JSON path.
 *
 * @throws TypeError if a control field leaked into the payload — a server bug,
 * never caller input, since the payload is built by the tool, not parsed.
 */
export function payloadDigest(payload: unknown): string {
  if (isRecord(payload)) {
    for (const field of CONTROL_FIELDS) {
      if (Object.hasOwn(payload, field)) {
        throw new TypeError(
          `control field "${field}" must not be part of the plan payload`,
        );
      }
    }
  }
  return sha256Hex(canonicalJson(payload));
}

/**
 * `expires_at` for a plan minted at `createdAtMs` — absolute ISO-8601 UTC, the
 * only time format that crosses the wire (CC-H2). It is the first instant the
 * plan is no longer accepted, matching `consumePlan()`.
 */
export function planExpiresAt(createdAtMs: number, ttlS: number): string {
  return isoUtc(createdAtMs + ttlS * 1000);
}

function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// ---------------------------------------------------------------------------
// TT_WRITE_MODE
// ---------------------------------------------------------------------------

/** Which half of the two-step contract a call is performing. */
export type WriteStep = 'preview' | 'execute';

export interface WriteStepDecision {
  step: WriteStep;
  /**
   * The token that must be verified before executing. Absent exactly when
   * `TT_WRITE_MODE=apply` executed a call that carried no `plan_id` — the
   * unverified fast path that mode exists to enable.
   */
  planId?: string;
}

/**
 * Resolves preview-vs-execute from the presence of `plan_id` and the write mode
 * (TOOLS.md § 2.6.4). There is no `apply` boolean: absence of `plan_id` is the
 * preview, presence is the execution.
 *
 * `deny` never reaches here — the `publish-write` package is not registered, so
 * the tools do not exist. Reaching it means the package gate leaked, which is a
 * server bug and is raised as such rather than silently writing.
 */
export function resolveWriteStep(
  planId: string | undefined,
  mode: WriteMode,
): WriteStepDecision {
  if (mode === 'deny') {
    throw new Error('write tools must not be registered when TT_WRITE_MODE=deny');
  }
  if (planId !== undefined) return { step: 'execute', planId };
  return mode === 'apply' ? { step: 'execute' } : { step: 'preview' };
}

// ---------------------------------------------------------------------------
// Local publish rate bucket (TOOLS.md § 2.8)
// ---------------------------------------------------------------------------

/**
 * The one setting the bucket obeys. Passed in rather than read from the
 * environment so the bucket stays pure and clock-driven — the same seam
 * `PlanLimits` gives the plan store.
 */
export interface PublishRateLimits {
  /** `TT_PUBLISH_RPM` — publish inits allowed per profile per minute. */
  publishRpm: number;
}

/**
 * Additive optional argument on the frozen CONTRACTS.md signatures, exactly as
 * `PlanStoreOptions` is for the store: the contract names `settings.publishRpm`
 * as governing the bucket but gave the functions no way to receive it. Omitting
 * it falls back to {@link DEFAULT_PUBLISH_RPM}.
 */
export interface RateBucketOptions {
  limits?: PublishRateLimits;
}

/**
 * `TT_PUBLISH_RPM` default (CONFIGURATION.md); a test asserts it equals
 * `loadSettings(baselineEnv()).publishRpm`.
 */
export const DEFAULT_PUBLISH_RPM = 6;

const DEFAULT_LIMITS: PublishRateLimits = Object.freeze({
  publishRpm: DEFAULT_PUBLISH_RPM,
});

/** One minute — the window `TT_PUBLISH_RPM` is expressed over. */
const MINUTE_MS = 60_000;

/** What one rate resolves to; the two numbers are only ever derived together. */
export interface PublishBucketRate {
  /** Burst size: a full bucket is the whole minute's budget, spendable at once. */
  capacity: number;
  /** Milliseconds one token takes to come back. */
  refillMs: number;
}

/**
 * `capacity = rpm`, `refillMs = 60_000 / rpm` — the default 6 resolves to the
 * capacity 6 and the one-token-per-10-s refill this bucket has always had.
 *
 * The interval is rounded to whole milliseconds because {@link refill} banks the
 * remainder *in* `updatedAt`: a fractional interval would put that timestamp —
 * and with it the `retry_at` / `next_token_at` instants computed from it — on
 * values `Date` silently truncates, and repeated float multiples of it would
 * drift over a long session. Rounding is **up** so a rate that does not divide
 * 60 000 evenly lands just under what the operator allowed rather than just
 * over: 7/min refills every 8572 ms (6.999/min), never every 8571 (7.001/min).
 * The bucket exists to protect the account from TikTok's spam systems (§ 2.8),
 * so the leftover millisecond belongs on the conservative side.
 *
 * A rate below 1 is clamped instead of trusted — `TT_PUBLISH_RPM` is validated
 * as an integer ≥ 1, and a zero reaching here would be a division by zero.
 */
export function resolvePublishBucket(options: RateBucketOptions = {}): PublishBucketRate {
  const rpm = Math.max(1, Math.floor((options.limits ?? DEFAULT_LIMITS).publishRpm));
  return { capacity: rpm, refillMs: Math.ceil(MINUTE_MS / rpm) };
}

/**
 * The bucket's half of a loaded settings snapshot. Lives here rather than in
 * `tools/` because all four write tools and the `creator_info` wait need it, and
 * they do not all import from one another.
 */
export function publishRateLimits(settings: Settings): RateBucketOptions {
  return { limits: { publishRpm: settings.publishRpm } };
}

/** `data.meta.rate_bucket` on a preview (TOOLS.md § 2.6.1). */
export interface RateBucketSnapshot {
  tokens_available: number;
  /** Absent while the bucket is full — there is nothing to wait for. */
  next_token_at?: string;
}

/** Everything a `local_rate_limited` refusal needs; the time is absolute. */
export interface RateLimitRefusal {
  retry_after_s: number;
  retry_at: string;
}

export type RateBucketTake =
  { ok: true; bucket: RateBucketSnapshot } | { ok: false; refusal: RateLimitRefusal };

interface BucketState {
  tokens: number;
  /** Epoch ms the current refill interval started from. */
  updatedAt: number;
}

/** Per-profile, in-process, bounded by the number of configured profiles. */
const buckets = new Map<string, BucketState>();

function bucketFor(profile: string, now: number, rate: PublishBucketRate): BucketState {
  const existing = buckets.get(profile);
  if (existing !== undefined) return existing;
  const created: BucketState = { tokens: rate.capacity, updatedAt: now };
  buckets.set(profile, created);
  return created;
}

/**
 * Accrues whole tokens for the elapsed time. Integer arithmetic only: the
 * remainder stays banked in `updatedAt`, so 15 s of idling at 6/min grants one
 * token and carries 5 s into the next interval — no float drift, no lost time.
 *
 * A full bucket does not bank progress (`updatedAt` jumps to now), and a clock
 * that stepped backwards accrues nothing rather than going negative.
 *
 * The `Map` outlives any single rate: settings are loaded once per process, so
 * only a test hands the same profile two capacities, but a bucket that was
 * filled under a larger one must not go on reporting tokens the current one
 * cannot hold.
 */
function refill(state: BucketState, now: number, rate: PublishBucketRate): void {
  if (state.tokens > rate.capacity) state.tokens = rate.capacity;
  if (now <= state.updatedAt) return;
  if (state.tokens >= rate.capacity) {
    state.updatedAt = now;
    return;
  }
  const gained = Math.floor((now - state.updatedAt) / rate.refillMs);
  if (gained <= 0) return;
  state.tokens = Math.min(rate.capacity, state.tokens + gained);
  state.updatedAt =
    state.tokens >= rate.capacity ? now : state.updatedAt + gained * rate.refillMs;
}

function snapshot(state: BucketState, rate: PublishBucketRate): RateBucketSnapshot {
  const full = state.tokens >= rate.capacity;
  return {
    tokens_available: state.tokens,
    ...(full ? {} : { next_token_at: isoUtc(state.updatedAt + rate.refillMs) }),
  };
}

/**
 * Current occupancy without consuming anything — a preview always succeeds
 * regardless of the bucket and just reports what it sees (TOOLS.md § 2.6.1).
 */
export function peekPublishBucket(
  profile: string,
  clock: Clock,
  options: RateBucketOptions = {},
): RateBucketSnapshot {
  const rate = resolvePublishBucket(options);
  const now = clock.now();
  const state = bucketFor(profile, now, rate);
  refill(state, now, rate);
  return snapshot(state, rate);
}

/**
 * The refusal an empty bucket owes a caller, or `undefined` while it holds a
 * token. Refilled state only — never spends.
 *
 * The refusal is immediate and absolute-timed: the server never sleeps a write
 * call (TOOLS.md § 2.8) and never hands a model relative arithmetic to do
 * across turns (§ 5.2). `retry_at` is strictly in the future — a bucket that
 * had gone a full refill interval without a token would have refilled instead
 * of refusing.
 */
function refusalFor(
  state: BucketState,
  now: number,
  rate: PublishBucketRate,
): RateLimitRefusal | undefined {
  if (state.tokens > 0) return undefined;
  const retryAtMs = state.updatedAt + rate.refillMs;
  return {
    retry_after_s: Math.ceil((retryAtMs - now) / 1000),
    retry_at: isoUtc(retryAtMs),
  };
}

/**
 * Would a take succeed right now? Same refusal as {@link takePublishToken},
 * nothing spent.
 *
 * This is what lets the execute pipeline refuse an empty bucket before any
 * network call (§ 2.6.3 step 2) while spending the token only once an init is
 * actually about to go out (step 7): a rejected `plan_id` costs nothing.
 * Two reads rather than a take plus a give-back on purpose — `refill` banks the
 * sub-interval remainder in `updatedAt`, so a returned token would also return
 * whatever time had accrued since it was taken.
 */
export function peekPublishToken(
  profile: string,
  clock: Clock,
  options: RateBucketOptions = {},
): RateLimitRefusal | undefined {
  const rate = resolvePublishBucket(options);
  const now = clock.now();
  const state = bucketFor(profile, now, rate);
  refill(state, now, rate);
  return refusalFor(state, now, rate);
}

/** Takes one publish token, or refuses with {@link refusalFor}'s verdict. */
export function takePublishToken(
  profile: string,
  clock: Clock,
  options: RateBucketOptions = {},
): RateBucketTake {
  const rate = resolvePublishBucket(options);
  const now = clock.now();
  const state = bucketFor(profile, now, rate);
  refill(state, now, rate);
  const refusal = refusalFor(state, now, rate);
  if (refusal !== undefined) return { ok: false, refusal };
  state.tokens -= 1;
  return { ok: true, bucket: snapshot(state, rate) };
}

/** Test seam — the buckets are process-wide state, like the plan store. */
export function resetRateBuckets(): void {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Catalog texts (TOOLS.md § 3.0, § 5.3)
// ---------------------------------------------------------------------------

/** "10", or "1.5" for a TTL that is not a whole number of minutes. */
function formatMinutes(ttlS: number): string {
  const minutes = ttlS / 60;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/**
 * Maps the internal consume failure onto the **two** codes callers ever see:
 * `plan_not_found` (unknown / expired / already used) and `plan_mismatch`
 * (payload / account / tool). Both are non-retryable — the only recovery is a
 * fresh preview, which is exactly what the texts instruct.
 *
 * The internal reason is deliberately not surfaced in `details`: a model that
 * can distinguish "expired" from "already used" is tempted to treat one of them
 * as retryable, and neither is.
 */
export function planFailureError(reason: ConsumeFailure, ttlS: number): ToolError {
  if (reason === 'unknown' || reason === 'expired' || reason === 'already_used') {
    return {
      code: 'plan_not_found',
      message:
        `This plan_id is unknown, already used, or expired (plans are single-use and expire ` +
        `${formatMinutes(ttlS)} minutes after the preview). Call the tool again WITHOUT plan_id ` +
        `to generate a fresh preview, show it to the user, and apply with the new plan_id only ` +
        `after the user approves.`,
      retryable: false,
    };
  }
  return {
    code: 'plan_mismatch',
    message:
      `The arguments (or the target account) differ from what this plan_id previewed. A plan ` +
      `applies only the exact previewed payload. Call the tool again WITHOUT plan_id to preview ` +
      `the changed arguments, show the new preview to the user, then apply with the new plan_id.`,
    retryable: false,
  };
}

/**
 * The local bucket's refusal (TOOLS.md § 3.0). Retryable — nothing was sent,
 * nothing was consumed, and the plan itself is untouched; only the clock stands
 * in the way. The wait is stated as an absolute instant in the text and as
 * seconds in the structured fields.
 *
 * The rate in the text is the configured one: a model told "6/min" by a server
 * running at 20 would pace its retries against a limit that does not exist.
 */
export function localRateLimitedError(
  refusal: RateLimitRefusal,
  options: RateBucketOptions = {},
): ToolError {
  const { capacity } = resolvePublishBucket(options);
  return {
    code: 'local_rate_limited',
    message:
      `This server's publish limiter (${String(capacity)}/min) rejected the call ` +
      `to protect the account from TikTok's spam systems. Wait until ${refusal.retry_at} ` +
      `(${String(refusal.retry_after_s)} s), then apply again with a fresh preview.`,
    retryable: true,
    details: { retry_after_s: refusal.retry_after_s, retry_at: refusal.retry_at },
  };
}

/** The `wait` hint that accompanies {@link localRateLimitedError}. */
export function localRateLimitedHint(refusal: RateLimitRefusal): Hint {
  return {
    type: 'wait',
    retry_after_s: refusal.retry_after_s,
    retry_at: refusal.retry_at,
    text:
      `Rate limit: wait until ${refusal.retry_at}, then apply again with a fresh preview. ` +
      `Do not retry earlier.`,
  };
}

/**
 * The `approval_required` hint every `mode: "plan"` preview carries (TOOLS.md
 * § 5.3). Composed from server-owned templates and server-owned values only —
 * no upstream string ever reaches a hint (§ 5.2 trust boundary).
 */
export function approvalRequiredHint(planId: string, expiresAt: string): Hint {
  return {
    type: 'approval_required',
    plan_id: planId,
    expires_at: expiresAt,
    text:
      `Show this preview to the user, including the consent line. Only after explicit approval, ` +
      `call the tool again with the same arguments plus plan_id "${planId}" (valid until ` +
      `${expiresAt}).`,
  };
}
