/**
 * `mcp/plan.ts` — the digest, the write-mode decision, the publish bucket and
 * the normative texts of the two-step write contract.
 *
 * Three properties carry the whole contract and each is asserted directly: the
 * digest is stable under key order and re-resolution (or no preview would ever
 * apply), it separates payloads that differ in any way (or a plan would approve
 * a post it never showed), and it refuses to be computed over the control fields
 * that are allowed to change between the two calls.
 *
 * The bucket is the other half: it must refuse *without sleeping* and must say
 * when to come back as an absolute instant (TOOLS.md § 2.8, § 5.2). Time is
 * virtual throughout, so "10 seconds later" is exact rather than approximate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTROL_FIELDS,
  DEFAULT_PUBLISH_RPM,
  approvalRequiredHint,
  localRateLimitedError,
  localRateLimitedHint,
  payloadDigest,
  peekPublishBucket,
  peekPublishToken,
  planExpiresAt,
  planFailureError,
  publishRateLimits,
  resetRateBuckets,
  resolvePublishBucket,
  resolveWriteStep,
  takePublishToken,
  type RateBucketOptions,
  type RateLimitRefusal,
} from '../src/mcp/plan.js';
import type { ConsumeFailure } from '../src/mcp/plan-store.js';
import { loadSettings } from '../src/core/settings.js';
import { BASELINE_NOW_MS, baselineEnv, mockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// payload digest
// ---------------------------------------------------------------------------

const PAYLOAD = {
  post_info: { title: 'Hello', privacy_level: 'SELF_ONLY', disable_comment: false },
  source_info: { source: 'FILE_UPLOAD', video_size: 1024, chunk_size: 1024 },
  post_mode: 'DIRECT_POST',
};

test('the digest is 64 lowercase hex characters', () => {
  assert.match(payloadDigest(PAYLOAD), /^[0-9a-f]{64}$/);
});

test('re-resolving an unchanged payload reproduces the digest', () => {
  assert.equal(payloadDigest(PAYLOAD), payloadDigest(structuredClone(PAYLOAD)));
});

test('key order is not part of the payload', () => {
  const reordered = {
    post_mode: 'DIRECT_POST',
    source_info: { chunk_size: 1024, video_size: 1024, source: 'FILE_UPLOAD' },
    post_info: { disable_comment: false, privacy_level: 'SELF_ONLY', title: 'Hello' },
  };
  assert.equal(payloadDigest(reordered), payloadDigest(PAYLOAD));
});

test('any difference in the resolved payload is a different digest', () => {
  const variants = [
    { ...PAYLOAD, post_info: { ...PAYLOAD.post_info, title: 'Hello ' } },
    {
      ...PAYLOAD,
      post_info: { ...PAYLOAD.post_info, privacy_level: 'PUBLIC_TO_EVERYONE' },
    },
    { ...PAYLOAD, post_info: { ...PAYLOAD.post_info, disable_comment: true } },
    { ...PAYLOAD, source_info: { ...PAYLOAD.source_info, video_size: 1025 } },
    { ...PAYLOAD, post_mode: 'MEDIA_UPLOAD' },
  ];
  const digests = new Set(variants.map(payloadDigest));
  digests.add(payloadDigest(PAYLOAD));
  assert.equal(digests.size, variants.length + 1);
});

test('a control field in the payload is a server bug, raised as one', () => {
  for (const field of CONTROL_FIELDS) {
    assert.throws(() => payloadDigest({ ...PAYLOAD, [field]: 'x' }), {
      name: 'TypeError',
      message: new RegExp(`control field "${field}"`),
    });
  }
});

test('a control field nested inside the payload is not the same thing', () => {
  // Only the top level is call shaping; `post_info.force` would be a real field.
  assert.doesNotThrow(() =>
    payloadDigest({ ...PAYLOAD, post_info: { ...PAYLOAD.post_info, force: true } }),
  );
});

test('a non-object payload digests without a control-field check', () => {
  assert.match(payloadDigest('plain'), /^[0-9a-f]{64}$/);
  assert.notEqual(payloadDigest([1, 2]), payloadDigest([2, 1]));
});

test('cc-h2: expires_at is absolute ISO-8601 UTC', () => {
  const expiresAt = planExpiresAt(BASELINE_NOW_MS, 600);
  assert.match(expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(Date.parse(expiresAt), BASELINE_NOW_MS + 600_000);
});

// ---------------------------------------------------------------------------
// TT_WRITE_MODE
// ---------------------------------------------------------------------------

test('absence of plan_id is the preview, presence is the execution', () => {
  assert.deepEqual(resolveWriteStep(undefined, 'plan'), { step: 'preview' });
  assert.deepEqual(resolveWriteStep('plan_abc', 'plan'), {
    step: 'execute',
    planId: 'plan_abc',
  });
});

test('apply mode executes without a plan_id, and still verifies one that is given', () => {
  assert.deepEqual(resolveWriteStep(undefined, 'apply'), { step: 'execute' });
  assert.deepEqual(resolveWriteStep('plan_abc', 'apply'), {
    step: 'execute',
    planId: 'plan_abc',
  });
});

test('deny never reaches the resolver — arriving there is raised, not written', () => {
  assert.throws(() => resolveWriteStep(undefined, 'deny'), /must not be registered/);
  assert.throws(() => resolveWriteStep('plan_abc', 'deny'), /must not be registered/);
});

// ---------------------------------------------------------------------------
// the publish bucket
// ---------------------------------------------------------------------------

/**
 * The rate every case below runs at unless it names its own: whatever
 * `TT_PUBLISH_RPM` defaults to. The fence a few cases down pins that default to
 * the capacity 6 and the 10 s interval this bucket has always had, so deriving
 * the numbers here keeps the rest of the suite about behaviour rather than
 * arithmetic.
 */
const { capacity: DEFAULT_CAPACITY, refillMs: DEFAULT_REFILL_MS } =
  resolvePublishBucket();

test('the bucket defaults are the TT_PUBLISH_RPM default — six inits, one per 10 s', () => {
  assert.equal(DEFAULT_PUBLISH_RPM, loadSettings(baselineEnv()).publishRpm);
  assert.deepEqual(resolvePublishBucket(), { capacity: 6, refillMs: 10_000 });
  assert.deepEqual(resolvePublishBucket({}), resolvePublishBucket());
});

test('a fresh bucket is full and has nothing to wait for', () => {
  resetRateBuckets();
  assert.deepEqual(peekPublishBucket('DEFAULT', mockClock()), {
    tokens_available: DEFAULT_CAPACITY,
  });
});

test('peeking never consumes — a preview costs no publish budget', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < 10; i += 1) peekPublishBucket('DEFAULT', clock);
  assert.equal(peekPublishBucket('DEFAULT', clock).tokens_available, DEFAULT_CAPACITY);
});

test('peeking a token gives the take verdict and spends nothing', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(peekPublishToken('DEFAULT', clock), undefined);
  }
  // The budget is still whole after ten asks: this is what lets the execute
  // pipeline refuse an empty bucket before any network (§ 2.6.3 step 2) and
  // still charge the token only once an init is about to go out (step 7).
  assert.equal(peekPublishBucket('DEFAULT', clock).tokens_available, DEFAULT_CAPACITY);

  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);
  const peeked = peekPublishToken('DEFAULT', clock);
  const refused = takePublishToken('DEFAULT', clock);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  // One verdict, not two: a peek that refused on different terms than the take
  // would make step 2 and step 7 disagree about the same bucket.
  assert.deepEqual(peeked, refused.refusal);
  assert.equal(clock.pending(), 0);
});

test('the bucket allows six inits, then refuses the seventh', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = DEFAULT_CAPACITY - 1; i >= 0; i -= 1) {
    const take = takePublishToken('DEFAULT', clock);
    assert.ok(take.ok);
    assert.equal(take.bucket.tokens_available, i);
  }
  const refused = takePublishToken('DEFAULT', clock);
  assert.equal(refused.ok, false);
});

test('the refusal is immediate and says when to come back, absolutely', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);

  const refused = takePublishToken('DEFAULT', clock);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.refusal.retry_after_s, DEFAULT_REFILL_MS / 1000);
  assert.equal(Date.parse(refused.refusal.retry_at), BASELINE_NOW_MS + DEFAULT_REFILL_MS);
  // Nothing slept: the clock has no pending waiter.
  assert.equal(clock.pending(), 0);
});

test('one token returns per refill interval, and the remainder is banked', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);

  // 15 s grants one token and carries 5 s forward.
  clock.setNow(BASELINE_NOW_MS + 15_000);
  const first = takePublishToken('DEFAULT', clock);
  assert.ok(first.ok);
  assert.equal(first.bucket.tokens_available, 0);

  // 5 s later the banked remainder completes the next interval.
  clock.setNow(BASELINE_NOW_MS + 20_000);
  const second = takePublishToken('DEFAULT', clock);
  assert.ok(second.ok);
});

test('a drained bucket refills to the brim and no further', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);

  // An hour is many times the minute the whole budget takes to come back, and
  // the bucket returns full — not with an hour of intervals owed behind it.
  clock.setNow(BASELINE_NOW_MS + 3_600_000);
  assert.deepEqual(peekPublishBucket('DEFAULT', clock), {
    tokens_available: DEFAULT_CAPACITY,
  });
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) {
    assert.equal(takePublishToken('DEFAULT', clock).ok, true);
  }
  assert.equal(takePublishToken('DEFAULT', clock).ok, false);
});

test('a full bucket does not bank idle time into a burst', () => {
  resetRateBuckets();
  const clock = mockClock();
  peekPublishBucket('DEFAULT', clock);
  clock.setNow(BASELINE_NOW_MS + 3_600_000);
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) {
    assert.equal(takePublishToken('DEFAULT', clock).ok, true);
  }
  assert.equal(takePublishToken('DEFAULT', clock).ok, false);
});

test('cc-h1: a clock that steps backwards accrues nothing rather than going negative', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);
  clock.setNow(BASELINE_NOW_MS - 3_600_000);

  const refused = takePublishToken('DEFAULT', clock);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  // The deadline is kept on the bucket's own timeline rather than recomputed
  // from a clock that just lied, so `retry_at` and `retry_after_s` still agree
  // with each other — the caller waits out the step instead of getting a
  // deadline in its own past and retrying in a loop.
  assert.equal(Date.parse(refused.refusal.retry_at), BASELINE_NOW_MS + DEFAULT_REFILL_MS);
  assert.equal(refused.refusal.retry_after_s, 3_610);
});

test('a drained bucket reports the instant its next token lands', () => {
  resetRateBuckets();
  const clock = mockClock();
  takePublishToken('DEFAULT', clock);
  const snapshot = peekPublishBucket('DEFAULT', clock);
  assert.equal(snapshot.tokens_available, DEFAULT_CAPACITY - 1);
  assert.equal(
    Date.parse(snapshot.next_token_at ?? ''),
    BASELINE_NOW_MS + DEFAULT_REFILL_MS,
  );
});

test('the bucket is per profile — one account cannot spend another one out', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < DEFAULT_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);
  assert.equal(takePublishToken('DEFAULT', clock).ok, false);
  assert.equal(takePublishToken('WORK', clock).ok, true);
});

// ---------------------------------------------------------------------------
// TT_PUBLISH_RPM
// ---------------------------------------------------------------------------

test('TT_PUBLISH_RPM sets the burst size and the refill interval together', () => {
  resetRateBuckets();
  const limits: RateBucketOptions = { limits: { publishRpm: 20 } };
  const clock = mockClock();

  // Twenty in the burst where the default allows six, and the twenty-first is
  // refused three seconds out rather than ten.
  assert.deepEqual(peekPublishBucket('DEFAULT', clock, limits), { tokens_available: 20 });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(takePublishToken('DEFAULT', clock, limits).ok, true);
  }
  const refused = takePublishToken('DEFAULT', clock, limits);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.refusal.retry_after_s, 3);
  assert.equal(Date.parse(refused.refusal.retry_at), BASELINE_NOW_MS + 3_000);
});

test('publishRateLimits carries TT_PUBLISH_RPM off a loaded settings snapshot', () => {
  const settings = loadSettings({ ...baselineEnv(), TT_PUBLISH_RPM: '12' });
  assert.deepEqual(publishRateLimits(settings), { limits: { publishRpm: 12 } });
  assert.deepEqual(resolvePublishBucket(publishRateLimits(settings)), {
    capacity: 12,
    refillMs: 5_000,
  });
});

test('a rate that does not divide 60 000 rounds the interval up, never down', () => {
  // 60 000 / 7 is 8571.43: 8571 ms would refill at 7.001/min — over what the
  // operator allowed — so the leftover fraction is spent, not dropped.
  assert.deepEqual(resolvePublishBucket({ limits: { publishRpm: 7 } }), {
    capacity: 7,
    refillMs: 8_572,
  });

  for (let rpm = 1; rpm <= 120; rpm += 1) {
    const rate = resolvePublishBucket({ limits: { publishRpm: rpm } });
    assert.equal(rate.capacity, rpm, `capacity for ${String(rpm)}/min`);
    // Whole milliseconds, because the bucket banks the remainder in a timestamp.
    assert.ok(Number.isInteger(rate.refillMs), `${String(rpm)}/min is fractional`);
    assert.ok(rate.refillMs * rpm >= 60_000, `${String(rpm)}/min refills too fast`);
  }
});

test('a non-divisible rate keeps whole-millisecond accounting over many refills', () => {
  resetRateBuckets();
  const limits: RateBucketOptions = { limits: { publishRpm: 7 } };
  const { capacity, refillMs } = resolvePublishBucket(limits);
  const clock = mockClock();
  for (let i = 0; i < capacity; i += 1) takePublishToken('DEFAULT', clock, limits);

  // Ten intervals, each one still exactly `refillMs` after the last: the bucket
  // advances its own timestamp by whole intervals, so the rounded fraction
  // cannot accumulate into an early token over a long session.
  for (let i = 1; i <= 10; i += 1) {
    clock.setNow(BASELINE_NOW_MS + i * refillMs - 1);
    assert.equal(
      takePublishToken('DEFAULT', clock, limits).ok,
      false,
      `token arrived a millisecond early at interval ${String(i)}`,
    );
    clock.setNow(BASELINE_NOW_MS + i * refillMs);
    assert.equal(
      takePublishToken('DEFAULT', clock, limits).ok,
      true,
      `token missing at interval ${String(i)}`,
    );
  }
});

test('a rate below one is clamped rather than dividing by zero', () => {
  // Settings validate `TT_PUBLISH_RPM` as an integer >= 1; this is the guard for
  // a caller that constructs the limits itself.
  assert.deepEqual(resolvePublishBucket({ limits: { publishRpm: 0 } }), {
    capacity: 1,
    refillMs: 60_000,
  });
});

test('a bucket filled at one rate cannot outlive it holding more than the next allows', () => {
  // The bucket map is process-wide while the rate arrives per call, so a peek at
  // a smaller rate must not report tokens that rate could never have granted.
  resetRateBuckets();
  const clock = mockClock();
  assert.equal(peekPublishBucket('DEFAULT', clock).tokens_available, DEFAULT_CAPACITY);
  assert.deepEqual(peekPublishBucket('DEFAULT', clock, { limits: { publishRpm: 2 } }), {
    tokens_available: 2,
  });
});

// ---------------------------------------------------------------------------
// the catalog texts
// ---------------------------------------------------------------------------

test('three internal reasons collapse into plan_not_found, three into plan_mismatch', () => {
  const notFound: ConsumeFailure[] = ['unknown', 'expired', 'already_used'];
  const mismatch: ConsumeFailure[] = [
    'payload_mismatch',
    'account_mismatch',
    'tool_mismatch',
  ];

  for (const reason of notFound) {
    assert.equal(planFailureError(reason, 600).code, 'plan_not_found');
  }
  for (const reason of mismatch) {
    assert.equal(planFailureError(reason, 600).code, 'plan_mismatch');
  }
});

test('neither plan failure is retryable, and both name the recovery', () => {
  for (const reason of ['expired', 'payload_mismatch'] as ConsumeFailure[]) {
    const error = planFailureError(reason, 600);
    assert.equal(error.retryable, false);
    assert.match(error.message, /WITHOUT plan_id/);
  }
});

test('the plan_not_found text states the TTL in minutes the user configured', () => {
  assert.match(planFailureError('expired', 600).message, /expire 10 minutes/);
  assert.match(planFailureError('expired', 90).message, /expire 1\.5 minutes/);
});

test('the internal reason never leaks — expired and used read identically', () => {
  assert.deepEqual(
    planFailureError('expired', 600),
    planFailureError('already_used', 600),
  );
  assert.deepEqual(
    planFailureError('account_mismatch', 600),
    planFailureError('tool_mismatch', 600),
  );
});

test('local_rate_limited is retryable and carries the wait in both forms', () => {
  const refusal: RateLimitRefusal = {
    retry_after_s: 10,
    retry_at: '2026-01-01T00:00:10.000Z',
  };
  const error = localRateLimitedError(refusal);
  assert.equal(error.code, 'local_rate_limited');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.details, { retry_after_s: 10, retry_at: refusal.retry_at });
  assert.match(error.message, /2026-01-01T00:00:10\.000Z/);

  const hint = localRateLimitedHint(refusal);
  assert.equal(hint.type, 'wait');
  assert.equal(hint.retry_after_s, 10);
  assert.equal(hint.retry_at, refusal.retry_at);
});

test('the refusal text quotes the configured rate, not the default one', () => {
  const refusal: RateLimitRefusal = {
    retry_after_s: 3,
    retry_at: '2026-01-01T00:00:03.000Z',
  };
  assert.match(localRateLimitedError(refusal).message, /limiter \(6\/min\)/);
  assert.match(
    localRateLimitedError(refusal, { limits: { publishRpm: 20 } }).message,
    /limiter \(20\/min\)/,
  );
});

test('the approval hint carries the plan id and its deadline in the text as well', () => {
  const hint = approvalRequiredHint('plan_abc', '2026-01-01T00:10:00.000Z');
  assert.equal(hint.type, 'approval_required');
  assert.equal(hint.plan_id, 'plan_abc');
  assert.equal(hint.expires_at, '2026-01-01T00:10:00.000Z');
  assert.match(hint.text, /plan_id "plan_abc"/);
  assert.match(hint.text, /2026-01-01T00:10:00\.000Z/);
});

test('every catalog text stays inside the 300-character hint budget', () => {
  const refusal: RateLimitRefusal = {
    retry_after_s: 10,
    retry_at: '2026-01-01T00:00:10.000Z',
  };
  for (const hint of [
    localRateLimitedHint(refusal),
    approvalRequiredHint('plan_abc', '2026-01-01T00:10:00.000Z'),
  ]) {
    assert.ok(
      hint.text.length <= 300,
      `${hint.type} hint is ${String(hint.text.length)} chars`,
    );
  }
});
