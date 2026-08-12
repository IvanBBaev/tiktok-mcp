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
import type { WriteMode } from '../core/settings.js';
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

/** Capacity of the per-profile publish bucket: 6 inits per minute. */
export const PUBLISH_BUCKET_CAPACITY = 6;

/** Continuous refill: one token per 10 s (= the capacity per minute). */
export const PUBLISH_BUCKET_REFILL_MS = 10_000;

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

function bucketFor(profile: string, now: number): BucketState {
  const existing = buckets.get(profile);
  if (existing !== undefined) return existing;
  const created: BucketState = { tokens: PUBLISH_BUCKET_CAPACITY, updatedAt: now };
  buckets.set(profile, created);
  return created;
}

/**
 * Accrues whole tokens for the elapsed time. Integer arithmetic only: the
 * remainder stays banked in `updatedAt`, so 15 s of idling grants one token and
 * carries 5 s into the next interval — no float drift, no lost time.
 *
 * A full bucket does not bank progress (`updatedAt` jumps to now), and a clock
 * that stepped backwards accrues nothing rather than going negative.
 */
function refill(state: BucketState, now: number): void {
  if (now <= state.updatedAt) return;
  if (state.tokens >= PUBLISH_BUCKET_CAPACITY) {
    state.updatedAt = now;
    return;
  }
  const gained = Math.floor((now - state.updatedAt) / PUBLISH_BUCKET_REFILL_MS);
  if (gained <= 0) return;
  state.tokens = Math.min(PUBLISH_BUCKET_CAPACITY, state.tokens + gained);
  state.updatedAt =
    state.tokens >= PUBLISH_BUCKET_CAPACITY
      ? now
      : state.updatedAt + gained * PUBLISH_BUCKET_REFILL_MS;
}

function snapshot(state: BucketState): RateBucketSnapshot {
  const full = state.tokens >= PUBLISH_BUCKET_CAPACITY;
  return {
    tokens_available: state.tokens,
    ...(full
      ? {}
      : { next_token_at: isoUtc(state.updatedAt + PUBLISH_BUCKET_REFILL_MS) }),
  };
}

/**
 * Current occupancy without consuming anything — a preview always succeeds
 * regardless of the bucket and just reports what it sees (TOOLS.md § 2.6.1).
 */
export function peekPublishBucket(profile: string, clock: Clock): RateBucketSnapshot {
  const now = clock.now();
  const state = bucketFor(profile, now);
  refill(state, now);
  return snapshot(state);
}

/**
 * Takes one publish token, or refuses.
 *
 * The refusal is immediate and absolute-timed: the server never sleeps a write
 * call (TOOLS.md § 2.8) and never hands a model relative arithmetic to do
 * across turns (§ 5.2). `retry_at` is strictly in the future — a bucket that
 * had gone a full refill interval without a token would have refilled instead
 * of refusing.
 */
export function takePublishToken(profile: string, clock: Clock): RateBucketTake {
  const now = clock.now();
  const state = bucketFor(profile, now);
  refill(state, now);
  if (state.tokens <= 0) {
    const retryAtMs = state.updatedAt + PUBLISH_BUCKET_REFILL_MS;
    return {
      ok: false,
      refusal: {
        retry_after_s: Math.ceil((retryAtMs - now) / 1000),
        retry_at: isoUtc(retryAtMs),
      },
    };
  }
  state.tokens -= 1;
  return { ok: true, bucket: snapshot(state) };
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
 */
export function localRateLimitedError(refusal: RateLimitRefusal): ToolError {
  return {
    code: 'local_rate_limited',
    message:
      `This server's publish limiter (${String(PUBLISH_BUCKET_CAPACITY)}/min) rejected the call ` +
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
