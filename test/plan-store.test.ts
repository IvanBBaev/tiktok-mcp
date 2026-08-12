/**
 * `mcp/plan-store.ts` — the execution tokens behind the two-step write contract.
 *
 * This is the module that stands between "the model said apply" and an
 * irreversible post, so what is asserted here is the refusals: a token used
 * twice, a token that outlived its TTL, a token presented against a different
 * account, tool or payload. Every one of those must fail, and the happy path
 * must survive all four checks — a store that is merely strict is a store nobody
 * can publish through.
 *
 * The store is process-wide by design, so every test starts from
 * `resetPlanStore()` and drives time through a `MockClock`. Nothing here is
 * timing-dependent: the expiry boundary is asserted at the exact millisecond,
 * not "after a while".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PLAN_MAX_OUTSTANDING,
  DEFAULT_PLAN_TTL_S,
  PLAN_ID_PATTERN,
  consumePlan,
  mintPlanId,
  outstandingPlans,
  resetPlanStore,
  storePlan,
  verifyPlan,
  type PlanExpectation,
  type PlanLimits,
  type PlanRecord,
} from '../src/mcp/plan-store.js';
import { loadSettings } from '../src/core/settings.js';
import { BASELINE_NOW_MS, baselineEnv, mockClock, type MockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function record(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    digest: DIGEST,
    profile: 'DEFAULT',
    openId: 'open-id-1',
    tool: 'tiktok_post_video',
    createdAt: BASELINE_NOW_MS,
    used: false,
    ...over,
  };
}

function expectation(over: Partial<PlanExpectation> = {}): PlanExpectation {
  return {
    digest: DIGEST,
    profile: 'DEFAULT',
    openId: 'open-id-1',
    tool: 'tiktok_post_video',
    ...over,
  };
}

/** A store seeded with one plan, plus the clock the apply call will read. */
function seeded(
  over: Partial<PlanRecord> = {},
  limits?: PlanLimits,
): { id: string; clock: MockClock } {
  resetPlanStore();
  const id = mintPlanId();
  storePlan(id, record(over), limits === undefined ? {} : { limits });
  return { id, clock: mockClock() };
}

// ---------------------------------------------------------------------------
// plan ids
// ---------------------------------------------------------------------------

test('a plan id is plan_ plus 32 lowercase hex characters', () => {
  for (let i = 0; i < 32; i += 1) {
    assert.match(mintPlanId(), PLAN_ID_PATTERN);
  }
});

test('plan ids are random, not derived from the payload they approve', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i += 1) ids.add(mintPlanId());
  // 128 bits of entropy: a collision in 200 draws is not a flake, it is a bug.
  assert.equal(ids.size, 200);
});

// ---------------------------------------------------------------------------
// the happy path and the four refusals
// ---------------------------------------------------------------------------

test('a plan applies once, with the payload, account and tool it previewed', () => {
  const { id, clock } = seeded();
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
});

test('cc-e7: the second apply of one plan id loses', () => {
  const { id, clock } = seeded();
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
  assert.deepEqual(consumePlan(id, expectation(), clock), {
    ok: false,
    reason: 'already_used',
  });
});

test('cc-g5: two applies racing on one plan id cannot both win', () => {
  const { id, clock } = seeded();
  // The check-and-mark is synchronous, so "concurrent" is exactly this: two
  // calls with no suspension point between them.
  const results = [
    consumePlan(id, expectation(), clock),
    consumePlan(id, expectation(), clock),
  ];
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test('an unknown plan id is refused rather than invented', () => {
  resetPlanStore();
  const clock = mockClock();
  assert.deepEqual(consumePlan(mintPlanId(), expectation(), clock), {
    ok: false,
    reason: 'unknown',
  });
});

test('a changed payload does not apply under the old plan id', () => {
  const { id, clock } = seeded();
  assert.deepEqual(consumePlan(id, expectation({ digest: OTHER_DIGEST }), clock), {
    ok: false,
    reason: 'payload_mismatch',
  });
});

test('a digest of a different length is refused, not compared', () => {
  const { id, clock } = seeded();
  // timingSafeEqual throws on mismatched lengths; the length check must come
  // first or a truncated digest crashes the tool call.
  assert.deepEqual(consumePlan(id, expectation({ digest: 'short' }), clock), {
    ok: false,
    reason: 'payload_mismatch',
  });
});

test('a plan previewed for one account does not apply to another', () => {
  const { id, clock } = seeded();
  assert.deepEqual(consumePlan(id, expectation({ openId: 'open-id-2' }), clock), {
    ok: false,
    reason: 'account_mismatch',
  });
  assert.deepEqual(consumePlan(id, expectation({ profile: 'WORK' }), clock), {
    ok: false,
    reason: 'account_mismatch',
  });
});

test('a plan previewed by one tool does not apply through another', () => {
  const { id, clock } = seeded();
  assert.deepEqual(consumePlan(id, expectation({ tool: 'tiktok_post_photo' }), clock), {
    ok: false,
    reason: 'tool_mismatch',
  });
});

test('a refused apply leaves the plan usable — only success consumes it', () => {
  const { id, clock } = seeded();
  assert.equal(consumePlan(id, expectation({ digest: OTHER_DIGEST }), clock).ok, false);
  assert.equal(
    consumePlan(id, expectation({ tool: 'tiktok_post_photo' }), clock).ok,
    false,
  );
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
});

// ---------------------------------------------------------------------------
// expiry
// ---------------------------------------------------------------------------

test('the TTL boundary is exclusive: applicable on [t, t+ttl)', () => {
  const limits: PlanLimits = { planTtlS: 600, planMaxOutstanding: 32 };
  const last = seeded({}, limits);
  last.clock.setNow(BASELINE_NOW_MS + 600_000 - 1);
  assert.deepEqual(consumePlan(last.id, expectation(), last.clock, { limits }), {
    ok: true,
  });

  const first = seeded({}, limits);
  first.clock.setNow(BASELINE_NOW_MS + 600_000);
  assert.deepEqual(consumePlan(first.id, expectation(), first.clock, { limits }), {
    ok: false,
    reason: 'expired',
  });
});

test('an expired plan is dropped on access, not merely refused', () => {
  const limits: PlanLimits = { planTtlS: 1, planMaxOutstanding: 32 };
  const { id, clock } = seeded({}, limits);
  clock.setNow(BASELINE_NOW_MS + 1_000);
  assert.equal(consumePlan(id, expectation(), clock, { limits }).ok, false);
  assert.equal(outstandingPlans(), 0);
});

test('expiry is decided before single-use — both read as plan_not_found anyway', () => {
  const limits: PlanLimits = { planTtlS: 60, planMaxOutstanding: 32 };
  const { id, clock } = seeded({}, limits);
  assert.equal(consumePlan(id, expectation(), clock, { limits }).ok, true);
  clock.setNow(BASELINE_NOW_MS + 60_000);
  assert.deepEqual(consumePlan(id, expectation(), clock, { limits }), {
    ok: false,
    reason: 'expired',
  });
});

test('cc-h1: a clock that steps backwards does not expire a plan', () => {
  const { id, clock } = seeded();
  clock.setNow(BASELINE_NOW_MS - 86_400_000);
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
});

test('a non-positive TTL expires a plan the instant it is minted', () => {
  const limits: PlanLimits = { planTtlS: 0, planMaxOutstanding: 32 };
  const { id, clock } = seeded({}, limits);
  assert.deepEqual(consumePlan(id, expectation(), clock, { limits }), {
    ok: false,
    reason: 'expired',
  });
});

// ---------------------------------------------------------------------------
// verifying without consuming
// ---------------------------------------------------------------------------

test('verifying a plan runs every check but leaves it unspent', () => {
  const { id, clock } = seeded();
  assert.deepEqual(verifyPlan(id, expectation(), clock), { ok: true });
  // The execute pipeline verifies at step 5 and consumes only at step 7, with
  // the duplicate guard in between: a `possible_duplicate` rejection has to
  // leave the same plan id appliable with force, which it would not if
  // verification spent the token.
  assert.deepEqual(verifyPlan(id, expectation(), clock), { ok: true });
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
});

test('a verified plan still applies exactly once', () => {
  const { id, clock } = seeded();
  assert.deepEqual(verifyPlan(id, expectation(), clock), { ok: true });
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
  assert.deepEqual(consumePlan(id, expectation(), clock), {
    ok: false,
    reason: 'already_used',
  });
});

test('verifying an unknown plan id refuses rather than invents', () => {
  resetPlanStore();
  assert.deepEqual(verifyPlan(mintPlanId(), expectation(), mockClock()), {
    ok: false,
    reason: 'unknown',
  });
});

test('verifying drops an expired plan on access, exactly as applying does', () => {
  const limits: PlanLimits = { planTtlS: 1, planMaxOutstanding: 32 };
  const { id, clock } = seeded({}, limits);
  clock.setNow(BASELINE_NOW_MS + 1_000);
  assert.deepEqual(verifyPlan(id, expectation(), clock, { limits }), {
    ok: false,
    reason: 'expired',
  });
  // Lazy eviction is the only reclaim path on the read side; a verify that only
  // refused would leave the entry outstanding until the next store swept it.
  assert.equal(outstandingPlans(), 0);
});

test('verifying reports an already consumed plan as already_used', () => {
  const { id, clock } = seeded();
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
  assert.deepEqual(verifyPlan(id, expectation(), clock), {
    ok: false,
    reason: 'already_used',
  });
});

test('verifying refuses a plan presented through another tool', () => {
  const { id, clock } = seeded();
  assert.deepEqual(verifyPlan(id, expectation({ tool: 'tiktok_post_photo' }), clock), {
    ok: false,
    reason: 'tool_mismatch',
  });
});

test('verifying refuses a plan presented against another account', () => {
  const { id, clock } = seeded();
  assert.deepEqual(verifyPlan(id, expectation({ profile: 'WORK' }), clock), {
    ok: false,
    reason: 'account_mismatch',
  });
  assert.deepEqual(verifyPlan(id, expectation({ openId: 'open-id-2' }), clock), {
    ok: false,
    reason: 'account_mismatch',
  });
});

test('verifying refuses a payload that changed since the preview', () => {
  const { id, clock } = seeded();
  assert.deepEqual(verifyPlan(id, expectation({ digest: OTHER_DIGEST }), clock), {
    ok: false,
    reason: 'payload_mismatch',
  });
});

test('verifying refuses a digest of a different length instead of throwing', () => {
  const { id, clock } = seeded();
  // timingSafeEqual throws on mismatched lengths; the length check must come
  // first or a truncated digest crashes the tool call.
  assert.deepEqual(verifyPlan(id, expectation({ digest: 'short' }), clock), {
    ok: false,
    reason: 'payload_mismatch',
  });
});

test('verifying an expired-and-used plan reports expired, not already_used', () => {
  const limits: PlanLimits = { planTtlS: 60, planMaxOutstanding: 32 };
  const { id, clock } = seeded({ used: true }, limits);
  clock.setNow(BASELINE_NOW_MS + 60_000);
  assert.deepEqual(verifyPlan(id, expectation(), clock, { limits }), {
    ok: false,
    reason: 'expired',
  });
});

test('verifying reports the coarsest mismatch first: tool, then account, then payload', () => {
  const { id, clock } = seeded();
  // All three wrong at once, peeled off one check at a time — the reason names
  // the first check that fails, so an operator reading the log is pointed at
  // the wrong tool rather than at a digest that was never going to match.
  assert.deepEqual(
    verifyPlan(
      id,
      expectation({ tool: 'tiktok_post_photo', profile: 'WORK', digest: OTHER_DIGEST }),
      clock,
    ),
    { ok: false, reason: 'tool_mismatch' },
  );
  assert.deepEqual(
    verifyPlan(id, expectation({ profile: 'WORK', digest: OTHER_DIGEST }), clock),
    { ok: false, reason: 'account_mismatch' },
  );
  assert.deepEqual(verifyPlan(id, expectation({ digest: OTHER_DIGEST }), clock), {
    ok: false,
    reason: 'payload_mismatch',
  });
});

test('verifying honours a custom TTL rather than the default', () => {
  const limits: PlanLimits = { planTtlS: 5, planMaxOutstanding: 32 };
  const short = seeded({}, limits);
  short.clock.setNow(BASELINE_NOW_MS + 5_000);
  assert.deepEqual(verifyPlan(short.id, expectation(), short.clock, { limits }), {
    ok: false,
    reason: 'expired',
  });

  // The very same instant is comfortably inside the default 600 s window, so
  // the refusal above came from the passed-in limits and nothing else.
  const fallback = seeded();
  fallback.clock.setNow(BASELINE_NOW_MS + 5_000);
  assert.deepEqual(verifyPlan(fallback.id, expectation(), fallback.clock), { ok: true });
});

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

test('storing sweeps every plan the new one has outlived', () => {
  const limits: PlanLimits = { planTtlS: 60, planMaxOutstanding: 32 };
  resetPlanStore();
  for (let i = 0; i < 5; i += 1) {
    storePlan(mintPlanId(), record({ createdAt: BASELINE_NOW_MS + i }), { limits });
  }
  assert.equal(outstandingPlans(), 5);

  storePlan(mintPlanId(), record({ createdAt: BASELINE_NOW_MS + 120_000 }), { limits });
  assert.equal(outstandingPlans(), 1);
});

test('the sweep uses the TTL boundary, not a rounder one', () => {
  const limits: PlanLimits = { planTtlS: 60, planMaxOutstanding: 32 };
  resetPlanStore();
  storePlan(mintPlanId(), record({ createdAt: BASELINE_NOW_MS }), { limits });
  storePlan(mintPlanId(), record({ createdAt: BASELINE_NOW_MS + 1 }), { limits });

  // Exactly 60 s after the first: the first is expired, the second has 1 ms left.
  storePlan(mintPlanId(), record({ createdAt: BASELINE_NOW_MS + 60_000 }), { limits });
  assert.equal(outstandingPlans(), 2);
});

test('the cap evicts the oldest plan, so minting forever cannot grow the process', () => {
  const limits: PlanLimits = { planTtlS: 3600, planMaxOutstanding: 3 };
  resetPlanStore();
  const ids = [0, 1, 2].map((offset) => {
    const id = mintPlanId();
    storePlan(id, record({ createdAt: BASELINE_NOW_MS + offset }), { limits });
    return id;
  });
  const newest = mintPlanId();
  storePlan(newest, record({ createdAt: BASELINE_NOW_MS + 3 }), { limits });

  assert.equal(outstandingPlans(), 3);
  const clock = mockClock();
  const oldest = ids[0];
  assert.ok(oldest !== undefined);
  assert.deepEqual(consumePlan(oldest, expectation(), clock, { limits }), {
    ok: false,
    reason: 'unknown',
  });
  assert.deepEqual(consumePlan(newest, expectation(), clock, { limits }), { ok: true });
});

test('a cap below one is clamped rather than looped on', () => {
  const limits: PlanLimits = { planTtlS: 3600, planMaxOutstanding: 0 };
  resetPlanStore();
  const id = mintPlanId();
  storePlan(id, record(), { limits });
  assert.equal(outstandingPlans(), 1);
  assert.deepEqual(consumePlan(id, expectation(), mockClock(), { limits }), { ok: true });
});

test('re-storing a known id replaces it instead of counting twice', () => {
  resetPlanStore();
  const id = mintPlanId();
  storePlan(id, record());
  storePlan(id, record({ digest: OTHER_DIGEST }));
  assert.equal(outstandingPlans(), 1);
  assert.deepEqual(consumePlan(id, expectation({ digest: OTHER_DIGEST }), mockClock()), {
    ok: true,
  });
});

test('the stored record is a copy — the caller cannot reach in and flip used', () => {
  resetPlanStore();
  const id = mintPlanId();
  const mine = record();
  storePlan(id, mine);
  mine.used = true;
  mine.digest = OTHER_DIGEST;
  assert.deepEqual(consumePlan(id, expectation(), mockClock()), { ok: true });
});

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

test('the store defaults are the TT_PLAN_* defaults', () => {
  const settings = loadSettings(baselineEnv());
  assert.equal(DEFAULT_PLAN_TTL_S, settings.planTtlS);
  assert.equal(DEFAULT_PLAN_MAX_OUTSTANDING, settings.planMaxOutstanding);
});

test('omitting the limits uses those defaults', () => {
  resetPlanStore();
  const id = mintPlanId();
  storePlan(id, record());
  const clock = mockClock();
  clock.setNow(BASELINE_NOW_MS + DEFAULT_PLAN_TTL_S * 1000 - 1);
  assert.deepEqual(consumePlan(id, expectation(), clock), { ok: true });
});

test('resetPlanStore drops everything', () => {
  resetPlanStore();
  storePlan(mintPlanId(), record());
  storePlan(mintPlanId(), record());
  assert.equal(outstandingPlans(), 2);
  resetPlanStore();
  assert.equal(outstandingPlans(), 0);
});
