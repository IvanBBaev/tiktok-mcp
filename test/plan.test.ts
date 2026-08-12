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
  PUBLISH_BUCKET_CAPACITY,
  PUBLISH_BUCKET_REFILL_MS,
  approvalRequiredHint,
  localRateLimitedError,
  localRateLimitedHint,
  payloadDigest,
  peekPublishBucket,
  planExpiresAt,
  planFailureError,
  resetRateBuckets,
  resolveWriteStep,
  takePublishToken,
  type RateLimitRefusal,
} from '../src/mcp/plan.js';
import type { ConsumeFailure } from '../src/mcp/plan-store.js';
import { BASELINE_NOW_MS, mockClock } from './helpers.js';

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

test('a fresh bucket is full and has nothing to wait for', () => {
  resetRateBuckets();
  assert.deepEqual(peekPublishBucket('DEFAULT', mockClock()), {
    tokens_available: PUBLISH_BUCKET_CAPACITY,
  });
});

test('peeking never consumes — a preview costs no publish budget', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < 10; i += 1) peekPublishBucket('DEFAULT', clock);
  assert.equal(
    peekPublishBucket('DEFAULT', clock).tokens_available,
    PUBLISH_BUCKET_CAPACITY,
  );
});

test('the bucket allows six inits, then refuses the seventh', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = PUBLISH_BUCKET_CAPACITY - 1; i >= 0; i -= 1) {
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
  for (let i = 0; i < PUBLISH_BUCKET_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);

  const refused = takePublishToken('DEFAULT', clock);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.refusal.retry_after_s, PUBLISH_BUCKET_REFILL_MS / 1000);
  assert.equal(
    Date.parse(refused.refusal.retry_at),
    BASELINE_NOW_MS + PUBLISH_BUCKET_REFILL_MS,
  );
  // Nothing slept: the clock has no pending waiter.
  assert.equal(clock.pending(), 0);
});

test('one token returns per refill interval, and the remainder is banked', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < PUBLISH_BUCKET_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);

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

test('a full bucket does not bank idle time into a burst', () => {
  resetRateBuckets();
  const clock = mockClock();
  peekPublishBucket('DEFAULT', clock);
  clock.setNow(BASELINE_NOW_MS + 3_600_000);
  for (let i = 0; i < PUBLISH_BUCKET_CAPACITY; i += 1) {
    assert.equal(takePublishToken('DEFAULT', clock).ok, true);
  }
  assert.equal(takePublishToken('DEFAULT', clock).ok, false);
});

test('cc-h1: a clock that steps backwards accrues nothing rather than going negative', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < PUBLISH_BUCKET_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);
  clock.setNow(BASELINE_NOW_MS - 3_600_000);

  const refused = takePublishToken('DEFAULT', clock);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  // The deadline is kept on the bucket's own timeline rather than recomputed
  // from a clock that just lied, so `retry_at` and `retry_after_s` still agree
  // with each other — the caller waits out the step instead of getting a
  // deadline in its own past and retrying in a loop.
  assert.equal(
    Date.parse(refused.refusal.retry_at),
    BASELINE_NOW_MS + PUBLISH_BUCKET_REFILL_MS,
  );
  assert.equal(refused.refusal.retry_after_s, 3_610);
});

test('a drained bucket reports the instant its next token lands', () => {
  resetRateBuckets();
  const clock = mockClock();
  takePublishToken('DEFAULT', clock);
  const snapshot = peekPublishBucket('DEFAULT', clock);
  assert.equal(snapshot.tokens_available, PUBLISH_BUCKET_CAPACITY - 1);
  assert.equal(
    Date.parse(snapshot.next_token_at ?? ''),
    BASELINE_NOW_MS + PUBLISH_BUCKET_REFILL_MS,
  );
});

test('the bucket is per profile — one account cannot spend another one out', () => {
  resetRateBuckets();
  const clock = mockClock();
  for (let i = 0; i < PUBLISH_BUCKET_CAPACITY; i += 1) takePublishToken('DEFAULT', clock);
  assert.equal(takePublishToken('DEFAULT', clock).ok, false);
  assert.equal(takePublishToken('WORK', clock).ok, true);
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
