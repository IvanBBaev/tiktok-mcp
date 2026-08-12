/**
 * The read half of the `publish` package: `tiktok_get_creator_info` (§ 3.5),
 * `tiktok_get_publish_status` (§ 3.6) and the shared wait machinery they stand
 * on — the publish-bucket wait of § 2.8 and the poll ladder of § 2.7.
 *
 * The cases are organised around the promises a model would otherwise get
 * wrong:
 *
 * - a read DELAYS instead of refusing (§ 2.8) — a drained bucket costs seconds,
 *   and only a wait that outlives `TT_TIMEOUT_MS` becomes a refusal, one that
 *   provably never reached TikTok;
 * - `wait_for_completion: false` is exactly one request, even mid-processing;
 * - terminal-beats-deadline and timeout-is-not-error (§ 2.7): an exhausted
 *   budget is `ok: true` with the last observed status and a `poll` hint saying
 *   when to ask again — never an error, never a reason to re-post;
 * - every Appendix A `fail_reason` reaches the caller with a recovery action,
 *   including the two texts that deviate from the table on purpose, and an
 *   unrecognized code still answers "verify before retrying";
 * - a status result can never carry a token or an upload URL (§ 5.2).
 *
 * Time is virtual: `mockClock` moves only when a test moves it, so every wait is
 * observed instead of waited out. Jitter is never asserted exactly — the
 * deterministic cases pin timing through `TT_STATUS_POLL_TIMEOUT_MS` /
 * `TT_STATUS_POLL_INTERVAL_MS` or the injected `random` seam, and the one case
 * that runs on real jitter asserts counts and bounds.
 *
 * Upstream is stubbed by route ({@link fakeApi}) and every unscripted path
 * throws, so a request a test did not expect fails loudly instead of being
 * absorbed. Scripted failures are non-retryable HTTP-200 error envelopes: a
 * retryable one would park on a backoff nothing advances.
 */

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import {
  PUBLISH_BUCKET_CAPACITY,
  PUBLISH_BUCKET_REFILL_MS,
  resetRateBuckets,
  takePublishToken,
} from '../src/mcp/plan.js';
import type { Hint, ToolError, ToolResult } from '../src/mcp/result.js';
import {
  awaitPublishToken,
  getCreatorInfoTool,
  getPublishStatusTool,
  journalOptions,
  pollDelayMs,
  pollPublishStatus,
  type CreatorInfoData,
  type PublishStatusData,
} from '../src/tools/publish.js';
import { flush } from './harness/deferred.js';
import {
  BASELINE_NOW_MS,
  mockClock,
  TEST_LOG_ID,
  ttEnvelope,
  withFetch,
  type FetchStub,
  type MockClock,
} from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

const CREATOR_PATH = '/v2/post/publish/creator_info/query/';
const STATUS_PATH = '/v2/post/publish/status/fetch/';

const PUBLISH_ID = 'v_pub_url~test.123';

/** Absolute ISO-8601 UTC — the only timestamp shape a hint may carry (§ 5.1). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The upstream `creator_info` payload, fully populated. */
const CREATOR_PAYLOAD = {
  creator_avatar_url: 'https://p16.tiktokcdn.com/avatar.jpeg',
  creator_username: 'test.creator',
  creator_nickname: 'Test Creator',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 300,
};

function creatorResponse(overrides: Record<string, unknown> = {}): Response {
  return ttEnvelope({ ...CREATOR_PAYLOAD, ...overrides });
}

/**
 * An upstream refusal that is **not** retryable: HTTP 200 carrying an error
 * envelope, which `core/http` only retries for `internal_error`.
 */
function refusal(code: string, message: string): Response {
  return ttEnvelope({}, { code, message });
}

// ---------------------------------------------------------------------------
// a fetch stub that answers by route, not by position
// ---------------------------------------------------------------------------

/** Per-route handlers; `n` is how many times that route was already asked. */
interface ApiScript {
  creator?: (n: number) => Response;
  status?: (n: number) => Response;
}

interface FakeCall {
  readonly path: string;
  readonly body: unknown;
}

interface FakeApi extends FetchStub {
  readonly calls: readonly FakeCall[];
}

function fakeApi(script: ApiScript = {}): FakeApi {
  const calls: FakeCall[] = [];
  const seen = { creator: 0, status: 0 };

  const stub = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      path,
      body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
    });

    if (path === CREATOR_PATH) {
      const n = seen.creator;
      seen.creator += 1;
      if (script.creator === undefined) {
        throw new Error('fakeApi: unscripted creator_info read');
      }
      return Promise.resolve(script.creator(n));
    }
    if (path === STATUS_PATH) {
      const n = seen.status;
      seen.status += 1;
      if (script.status === undefined) {
        throw new Error('fakeApi: unscripted status read');
      }
      return Promise.resolve(script.status(n));
    }
    throw new Error(`fakeApi: unexpected request to ${path}`);
  };

  return Object.assign(stub, { calls });
}

/** Every request path the stub saw, in order. */
function paths(stub: FakeApi): string[] {
  return stub.calls.map((call) => call.path);
}

function countPath(stub: FakeApi, path: string): number {
  return paths(stub).filter((seen) => seen === path).length;
}

// ---------------------------------------------------------------------------
// context and the virtual-time driver
// ---------------------------------------------------------------------------

interface Harness {
  ctx: ToolCtx;
  clock: MockClock;
}

/**
 * A tool context on virtual time. No credential file is needed here: neither
 * read tool touches the credential store — the bearer arrives through the
 * `refresh` seam — which keeps these tests free of the filesystem entirely.
 */
function harness(env: Record<string, string> = {}): Harness {
  const clock = mockClock();
  const api: ApiContext = createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...env }),
    log: NOOP_LOGGER,
    clock,
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
  return { ctx: { api, log: NOOP_LOGGER }, clock };
}

async function withCtx<T>(
  /** Server settings; everything omitted keeps its documented default. */
  env: Record<string, string>,
  fn: (ctx: ToolCtx, clock: MockClock) => Promise<T>,
): Promise<T> {
  resetRateBuckets();
  try {
    const { ctx, clock } = harness(env);
    return await fn(ctx, clock);
  } finally {
    resetRateBuckets();
  }
}

/** Spend the whole publish bucket, so the next taker has to wait for a refill. */
function drainPublishBucket(ctx: ToolCtx): void {
  for (let i = 0; i < PUBLISH_BUCKET_CAPACITY; i += 1) {
    takePublishToken(ctx.api.profile, ctx.api.clock);
  }
}

/** One `sleepBounded` slice — the granularity every wait in publish.ts uses. */
const STEP_MS = 1_000;

/** Virtual seconds the pump spends before it declares the work stuck. */
const MAX_STEPS = 120;

/** One real millisecond — what the pump waits in while work is in flight. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
}

/**
 * Advance virtual time in slices until `work` settles — the pump of
 * `http.test.ts`, because these waits are the same bounded slices.
 *
 * A step ends on whichever comes first: the work settling, or one REAL
 * millisecond. The real slice is the point: a flush-only pump spins its whole
 * budget in microseconds and would move the clock out from under a request that
 * is still in flight, which is precisely what the instant-by-instant
 * assertions below would then measure wrong.
 */
async function drive<T>(clock: MockClock, work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  // The caller decides what to do with a rejection; this only keeps an
  // in-flight failure from surfacing as an unhandled rejection first.
  const finished = tracked.then(
    () => undefined,
    () => undefined,
  );

  await flush(2);
  // The opening request waits for no virtual time at all, so it gets its real
  // millisecond before the first advance rather than after it.
  await Promise.race([finished, tick()]);
  for (let step = 0; step < MAX_STEPS && !settled; step += 1) {
    await clock.advance(STEP_MS);
    await Promise.race([finished, tick()]);
  }
  if (!settled) {
    throw new Error(
      `drive: the call had not settled after ${String(STEP_MS * MAX_STEPS)} ms of ` +
        'virtual time — either it is waiting on something the mock clock does not own, ' +
        'or the fetch stub never answered',
    );
  }
  return await tracked;
}

// ---------------------------------------------------------------------------
// calling the tools
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function creatorInfo(ctx: ToolCtx): Promise<ToolResult<CreatorInfoData>> {
  return getCreatorInfoTool.handler(getCreatorInfoTool.input.parse({}), ctx);
}

function publishStatus(ctx: ToolCtx, args: Args): Promise<ToolResult<PublishStatusData>> {
  return getPublishStatusTool.handler(getPublishStatusTool.input.parse(args), ctx);
}

/** A status read that needs no virtual time — anything that sleeps hangs here. */
async function runStatus(
  ctx: ToolCtx,
  stub: FakeApi,
  args: Args,
): Promise<ToolResult<PublishStatusData>> {
  return await withFetch(stub, () => publishStatus(ctx, args));
}

function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const { data } = result;
  assert.ok(data !== undefined, 'expected a payload');
  return data;
}

function errorOf(result: ToolResult<unknown>): ToolError {
  assert.equal(result.ok, false, 'expected a refusal');
  const { error } = result;
  assert.ok(error !== undefined, 'expected an error');
  return error;
}

function hintsOf(result: ToolResult<unknown>): readonly Hint[] {
  const { hints } = result;
  assert.ok(hints !== undefined, 'expected hints');
  return hints;
}

// ---------------------------------------------------------------------------
// pollDelayMs — the documented ladder, as a pure function
// ---------------------------------------------------------------------------

test('pollDelayMs walks the documented 2 s, base, twice-base ladder', () => {
  assert.equal(pollDelayMs(0, 5_000), 2_000);
  assert.equal(pollDelayMs(1, 5_000), 5_000);
  assert.equal(pollDelayMs(2, 5_000), 10_000);
  assert.equal(pollDelayMs(7, 5_000), 10_000, 'every later hop stays at 2x base');
  assert.equal(pollDelayMs(-1, 5_000), 2_000, 'a negative step is the first hop');
});

test('pollDelayMs compresses the ladder when the base is below the first hop', () => {
  // Lowering TT_STATUS_POLL_INTERVAL_MS must not leave a first hop that is
  // longer than the steady state it is supposed to lead into.
  assert.equal(pollDelayMs(0, 1_000), 1_000);
  assert.equal(pollDelayMs(1, 1_000), 1_000);
  assert.equal(pollDelayMs(2, 1_000), 2_000);
});

// ---------------------------------------------------------------------------
// awaitPublishToken — § 2.8, delay instead of refuse
// ---------------------------------------------------------------------------

test('awaitPublishToken costs no time while the bucket still holds tokens', async () => {
  await withCtx({}, async (ctx, clock) => {
    const refused = await awaitPublishToken(ctx.api);
    assert.equal(refused, undefined);
    assert.equal(clock.now(), BASELINE_NOW_MS, 'a free token is taken immediately');
    assert.equal(clock.pending(), 0, 'nothing is left sleeping');
  });
});

test('awaitPublishToken waits the refill out on a drained bucket', async () => {
  await withCtx({}, async (ctx, clock) => {
    drainPublishBucket(ctx);
    const startedAt = clock.now();
    const refused = await drive(clock, awaitPublishToken(ctx.api));

    assert.equal(refused, undefined, 'the wait ends in a token, not a refusal');
    const waited = clock.now() - startedAt;
    assert.ok(waited >= PUBLISH_BUCKET_REFILL_MS, `waited only ${String(waited)} ms`);
    assert.equal(clock.pending(), 0, 'the sleep chain finished, it did not leak');
  });
});

test('awaitPublishToken refuses once the wait would outlive TT_TIMEOUT_MS', async () => {
  await withCtx({ TT_TIMEOUT_MS: '1' }, async (ctx, clock) => {
    drainPublishBucket(ctx);
    const refused = await drive(clock, awaitPublishToken(ctx.api));

    assert.ok(refused !== undefined, 'a wait past the timeout has to refuse');
    assert.ok(refused.retry_after_s > 0);
    assert.match(refused.retry_at, ISO_UTC);
    // The loop sleeps at least a millisecond before giving up, so a refusal
    // that rounds to "now" can never spin.
    assert.ok(clock.now() > BASELINE_NOW_MS, 'it slept rather than busy-looped');
    assert.equal(clock.pending(), 0);
  });
});

// ---------------------------------------------------------------------------
// tiktok_get_creator_info (§ 3.5)
// ---------------------------------------------------------------------------

test('creator info maps the upstream payload to snake_case creator fields', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({ creator: () => creatorResponse() });
    const result = await withFetch(stub, () => creatorInfo(ctx));

    // Deep equality is the point: the avatar URL and the username exist
    // upstream and must NOT travel into the tool result.
    assert.deepEqual(dataOf(result), {
      creator: {
        nickname: 'Test Creator',
        privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
        comment_disabled: false,
        duet_disabled: true,
        stitch_disabled: false,
        max_video_post_duration_sec: 300,
      },
      audit_restrictions_active: false,
    });
    assert.equal(result.hints, undefined, 'an unrestricted account needs no hint');
    assert.deepEqual(paths(stub), [CREATOR_PATH]);
    const [call] = stub.calls;
    assert.ok(call !== undefined);
    assert.deepEqual(call.body, {}, 'creator_info takes no arguments');
  });
});

test('creator info omits max_video_post_duration_sec when upstream omits it', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () =>
        ttEnvelope({
          creator_nickname: 'Test Creator',
          privacy_level_options: ['PUBLIC_TO_EVERYONE'],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
        }),
    });
    const data = dataOf(await withFetch(stub, () => creatorInfo(ctx)));

    assert.ok(!Object.hasOwn(data.creator, 'max_video_post_duration_sec'));
    assert.equal(data.creator.nickname, 'Test Creator');
  });
});

test('privacy options of exactly SELF_ONLY raise the audit flag and one note', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      creator: () => creatorResponse({ privacy_level_options: ['SELF_ONLY'] }),
    });
    const result = await withFetch(stub, () => creatorInfo(ctx));
    const data = dataOf(result);

    assert.deepEqual(data.creator.privacy_level_options, ['SELF_ONLY']);
    assert.equal(data.audit_restrictions_active, true);

    const hints = hintsOf(result);
    assert.equal(hints.length, 1, 'exactly one hint, not a pile of advice');
    const [note] = hints;
    assert.ok(note !== undefined);
    assert.equal(note.type, 'note');
    assert.match(note.text, /SELF_ONLY/u);
    assert.match(note.text, /audit/u);
    assert.ok(note.text.length <= 300, 'hints stay inside the § 5.2 budget');
  });
});

test('a creator info read delays on a drained bucket instead of refusing', async () => {
  await withCtx({}, async (ctx, clock) => {
    drainPublishBucket(ctx);
    const startedAt = clock.now();
    const stub = fakeApi({ creator: () => creatorResponse() });
    const result = await withFetch(stub, () => drive(clock, creatorInfo(ctx)));

    // § 2.8: the bucket refilled while the call waited, so the caller gets the
    // answer it asked for — a few seconds later, not a refusal to retry.
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined, 'a read must not refuse on a full bucket');
    dataOf(result);
    assert.deepEqual(paths(stub), [CREATOR_PATH], 'the read still happened');
    const waited = clock.now() - startedAt;
    assert.ok(waited >= PUBLISH_BUCKET_REFILL_MS, `waited only ${String(waited)} ms`);
  });
});

test('a creator info wait past TT_TIMEOUT_MS refuses without calling TikTok', async () => {
  await withCtx({ TT_TIMEOUT_MS: '1' }, async (ctx, clock) => {
    drainPublishBucket(ctx);
    const stub = fakeApi();
    const result = await withFetch(stub, () => drive(clock, creatorInfo(ctx)));

    const error = errorOf(result);
    assert.equal(error.code, 'local_rate_limited');
    assert.equal(error.retryable, true, 'the caller may come back later');
    assert.equal(result.data, undefined);
    assert.equal(stub.calls.length, 0, 'a local refusal never reaches TikTok');

    const [wait] = hintsOf(result);
    assert.ok(wait !== undefined);
    assert.equal(wait.type, 'wait');
    assert.ok(wait.retry_after_s !== undefined);
    assert.ok(wait.retry_after_s > 0);
    assert.ok(wait.retry_at !== undefined);
    assert.match(wait.retry_at, ISO_UTC);
  });
});

// ---------------------------------------------------------------------------
// tiktok_get_publish_status (§ 3.6) — the wait contract of § 2.7
// ---------------------------------------------------------------------------

test('wait_for_completion false performs exactly one request mid-processing', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({ status: () => ttEnvelope({ status: 'PROCESSING_UPLOAD' }) });
    const result = await runStatus(ctx, stub, {
      publish_id: PUBLISH_ID,
      wait_for_completion: false,
    });
    const data = dataOf(result);

    assert.equal(data.status, 'PROCESSING_UPLOAD');
    assert.equal(data.publish_id, PUBLISH_ID);
    assert.equal(data.checked_at, new Date(BASELINE_NOW_MS).toISOString());
    assert.equal(countPath(stub, STATUS_PATH), 1, 'one look, no polling');
    assert.equal(result.hints, undefined, 'a single-shot read is not a timeout');

    const [call] = stub.calls;
    assert.ok(call !== undefined);
    assert.deepEqual(call.body, { publish_id: PUBLISH_ID });
  });
});

test('a terminal status observed on the last allowed request beats the deadline', async () => {
  // A zero budget means the very first observation is also the last one.
  await withCtx({ TT_STATUS_POLL_TIMEOUT_MS: '0' }, async (ctx) => {
    const stub = fakeApi({ status: () => ttEnvelope({ status: 'PUBLISH_COMPLETE' }) });
    const data = dataOf(await runStatus(ctx, stub, { publish_id: PUBLISH_ID }));

    assert.equal(data.status, 'PUBLISH_COMPLETE');
    assert.equal(countPath(stub, STATUS_PATH), 1);
  });
});

test('an exhausted poll budget is ok true with one poll hint, not an error', async () => {
  await withCtx(
    { TT_STATUS_POLL_TIMEOUT_MS: '0', TT_STATUS_POLL_INTERVAL_MS: '5000' },
    async (ctx) => {
      const stub = fakeApi({
        status: () => ttEnvelope({ status: 'PROCESSING_DOWNLOAD' }),
      });
      const result = await runStatus(ctx, stub, { publish_id: PUBLISH_ID });
      const data = dataOf(result);

      assert.equal(result.error, undefined, 'timeout-is-not-error (§ 2.7)');
      assert.equal(data.status, 'PROCESSING_DOWNLOAD', 'the last observed status');
      assert.equal(data.publish_id, PUBLISH_ID, 'a retry needs the id, timeout or not');
      assert.equal(countPath(stub, STATUS_PATH), 1);

      const hints = hintsOf(result);
      assert.equal(hints.length, 1);
      const [poll] = hints;
      assert.ok(poll !== undefined);
      assert.equal(poll.type, 'poll');
      assert.equal(poll.tool, 'tiktok_get_publish_status');
      assert.equal(poll.publish_id, PUBLISH_ID);
      assert.ok(poll.poll_after !== undefined);
      assert.match(poll.poll_after, ISO_UTC);
      // poll_after is exactly checked_at + the configured interval.
      const nextAt = new Date(Date.parse(data.checked_at) + 5_000).toISOString();
      assert.equal(poll.poll_after, nextAt);
      assert.ok(poll.text.includes(PUBLISH_ID));
      assert.match(poll.text, /Do not re-post/u);
    },
  );
});

test('pollPublishStatus spends the documented ladder between requests', async () => {
  await withCtx(
    { TT_STATUS_POLL_INTERVAL_MS: '5000', TT_STATUS_POLL_TIMEOUT_MS: '60000' },
    async (ctx, clock) => {
      // random() === 0.5 makes the jitter factor exactly 1, which is the only
      // way the delays can be asserted as numbers instead of as bounds.
      const seenAt: number[] = [];
      const stub = fakeApi({
        status: (n) => {
          seenAt.push(clock.now() - BASELINE_NOW_MS);
          return ttEnvelope({ status: n < 3 ? 'PROCESSING_UPLOAD' : 'PUBLISH_COMPLETE' });
        },
      });
      const outcome = await withFetch(stub, () =>
        drive(
          clock,
          pollPublishStatus(ctx.api, PUBLISH_ID, {
            waitForCompletion: true,
            random: () => 0.5,
          }),
        ),
      );

      assert.equal(outcome.status.status, 'PUBLISH_COMPLETE');
      assert.equal(outcome.timedOut, false);
      assert.deepEqual(seenAt, [0, 2_000, 7_000, 17_000], '2 s, then 5 s, then 10 s');
      assert.equal(outcome.checkedAtMs, BASELINE_NOW_MS + 17_000);
      assert.equal(clock.pending(), 0);
    },
  );
});

test('the status tool re-polls a non-terminal status and stops at the terminal one', async () => {
  await withCtx({ TT_STATUS_POLL_INTERVAL_MS: '5000' }, async (ctx, clock) => {
    // The handler owns no `random` seam, so this case asserts ordering, counts
    // and bounds only — never a delay jitter can move.
    const stub = fakeApi({
      status: (n) =>
        ttEnvelope({ status: n === 0 ? 'PROCESSING_DOWNLOAD' : 'PUBLISH_COMPLETE' }),
    });
    const startedAt = clock.now();
    const result = await withFetch(stub, () =>
      drive(clock, publishStatus(ctx, { publish_id: PUBLISH_ID })),
    );
    const data = dataOf(result);

    assert.equal(data.status, 'PUBLISH_COMPLETE');
    assert.equal(countPath(stub, STATUS_PATH), 2, 'it waited and asked again');
    assert.equal(result.hints, undefined, 'a terminal answer carries no poll hint');
    // First hop: 2 s ± 20 %, rounded up to whole driver ticks.
    const waited = clock.now() - startedAt;
    assert.ok(waited >= 1_600, `first hop was only ${String(waited)} ms`);
    assert.ok(waited <= 5_000, `first hop ballooned to ${String(waited)} ms`);
  });
});

test('SEND_TO_USER_INBOX attaches the open-the-TikTok-app user action', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({ status: () => ttEnvelope({ status: 'SEND_TO_USER_INBOX' }) });
    const result = await runStatus(ctx, stub, { publish_id: PUBLISH_ID });
    const data = dataOf(result);

    assert.equal(data.status, 'SEND_TO_USER_INBOX');
    assert.equal(countPath(stub, STATUS_PATH), 1, 'the inbox is a terminal state');

    const hints = hintsOf(result);
    assert.equal(hints.length, 1);
    const [action] = hints;
    assert.ok(action !== undefined);
    assert.equal(action.type, 'user_action');
    assert.equal(action.action, 'open_tiktok_app');
    assert.match(action.text, /TikTok app notification/u);
    assert.match(action.text, /second draft/u, 'it must forbid a re-post');
    assert.ok(action.text.length <= 300);
  });
});

test('PUBLISH_COMPLETE surfaces the first id of the upstream post list', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      status: () =>
        ttEnvelope({
          status: 'PUBLISH_COMPLETE',
          // TikTok's own spelling of the field, typo included.
          publicaly_available_post_id: [7_240_111_222_333, 7_240_111_222_334],
        }),
    });
    const data = dataOf(await runStatus(ctx, stub, { publish_id: PUBLISH_ID }));

    assert.equal(data.public_post_id, '7240111222333');
  });
});

test('public_post_id is omitted when the upstream list is absent or empty', async () => {
  await withCtx({}, async (ctx) => {
    const absent = fakeApi({ status: () => ttEnvelope({ status: 'PUBLISH_COMPLETE' }) });
    const first = dataOf(await runStatus(ctx, absent, { publish_id: PUBLISH_ID }));
    assert.ok(!Object.hasOwn(first, 'public_post_id'));

    const empty = fakeApi({
      status: () =>
        ttEnvelope({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }),
    });
    const second = dataOf(await runStatus(ctx, empty, { publish_id: PUBLISH_ID }));
    assert.ok(!Object.hasOwn(second, 'public_post_id'), 'an empty list is no id');
  });
});

test('byte counters travel through only while upstream reports them', async () => {
  await withCtx({}, async (ctx) => {
    const args = { publish_id: PUBLISH_ID, wait_for_completion: false };
    const reported = fakeApi({
      status: () =>
        ttEnvelope({
          status: 'PROCESSING_UPLOAD',
          uploaded_bytes: 4_096,
          downloaded_bytes: 2_048,
        }),
    });
    const seen = dataOf(await runStatus(ctx, reported, args));
    assert.equal(seen.uploaded_bytes, 4_096);
    assert.equal(seen.downloaded_bytes, 2_048);

    const silent = fakeApi({ status: () => ttEnvelope({ status: 'PROCESSING_UPLOAD' }) });
    const bare = dataOf(await runStatus(ctx, silent, args));
    assert.ok(!Object.hasOwn(bare, 'uploaded_bytes'));
    assert.ok(!Object.hasOwn(bare, 'downloaded_bytes'));
  });
});

// ---------------------------------------------------------------------------
// FAILED — Appendix A, every documented reason
// ---------------------------------------------------------------------------

interface FailCase {
  reason: string;
  /** A distinctive fragment of the recovery text, never the whole paragraph. */
  recovery: RegExp;
}

const FAIL_CASES: readonly FailCase[] = [
  { reason: 'file_format_check_failed', recovery: /MP4\/WebM\/MOV/u },
  { reason: 'duration_check_failed', recovery: /tiktok_get_creator_info/u },
  { reason: 'frame_rate_check_failed', recovery: /23–60 FPS/u },
  { reason: 'picture_size_check_failed', recovery: /360–4096 px/u },
  { reason: 'video_pull_failed', recovery: /could not download the media URL/u },
  { reason: 'photo_pull_failed', recovery: /could not download the media URL/u },
  { reason: 'publish_cancelled', recovery: /cancelled this post in the TikTok app/u },
  { reason: 'auth_removed', recovery: /revoked this app's access/u },
  { reason: 'spam_risk_text', recovery: /spam filter rejected the title/u },
  { reason: 'spam_risk', recovery: /account-level posting throttle/u },
  { reason: 'spam_risk_too_many_posts', recovery: /account-level posting throttle/u },
  { reason: 'internal', recovery: /TikTok internal error/u },
  {
    // Not in Appendix A: a code TikTok adds later still has to produce an
    // action, and that action is "verify, then decide" — never a blind retry.
    reason: 'brand_new_reason',
    recovery: /unrecognized failure code 'brand_new_reason'/u,
  },
];

test('every fail_reason reaches the caller with its Appendix A recovery', async () => {
  for (const entry of FAIL_CASES) {
    await withCtx({}, async (ctx) => {
      const stub = fakeApi({
        status: () => ttEnvelope({ status: 'FAILED', fail_reason: entry.reason }),
      });
      const result = await runStatus(ctx, stub, { publish_id: PUBLISH_ID });
      const data = dataOf(result);

      assert.equal(result.ok, true, 'a reported failure is a successful read');
      assert.equal(data.status, 'FAILED');
      assert.equal(data.fail_reason, entry.reason, 'the upstream code, verbatim');
      assert.ok(data.fail_recovery !== undefined, `no recovery for ${entry.reason}`);
      assert.match(data.fail_recovery, entry.recovery);
      assert.equal(countPath(stub, STATUS_PATH), 1, 'FAILED is terminal');
    });
  }
});

test('the two deliberate Appendix A deviations stay deviated', async () => {
  await withCtx({}, async (ctx) => {
    // The status endpoint reports no creator data and this tool may run on a
    // video.upload-only profile, so the duration text points at the tool that
    // can answer instead of interpolating a number it does not have.
    const duration = fakeApi({
      status: () =>
        ttEnvelope({ status: 'FAILED', fail_reason: 'duration_check_failed' }),
    });
    const first = dataOf(await runStatus(ctx, duration, { publish_id: PUBLISH_ID }));
    assert.ok(first.fail_recovery !== undefined);
    assert.match(first.fail_recovery, /call tiktok_get_creator_info/u);
    assert.ok(!/\d/u.test(first.fail_recovery), 'no duration number is invented');

    // A FAILED status is an HTTP-level success, so the envelope carries no
    // log_id to quote — the publish_id is what support can be given instead.
    const internal = fakeApi({
      status: () => ttEnvelope({ status: 'FAILED', fail_reason: 'internal' }),
    });
    const second = dataOf(await runStatus(ctx, internal, { publish_id: PUBLISH_ID }));
    assert.ok(second.fail_recovery !== undefined);
    assert.match(second.fail_recovery, /Quote this publish_id/u);
    assert.ok(!second.fail_recovery.includes('log_id'), 'no log_id is promised');
  });
});

// ---------------------------------------------------------------------------
// refusals and the trust boundary
// ---------------------------------------------------------------------------

test('an upstream invalid_publish_id becomes the publish_not_found catalog code', async () => {
  await withCtx({}, async (ctx) => {
    const upstreamText = 'publish_id 4711 not found in shard cluster tt-internal';
    const stub = fakeApi({
      status: () => refusal('invalid_publish_id', upstreamText),
    });
    const result = await runStatus(ctx, stub, { publish_id: 'v_pub_url~expired.9' });

    const error = errorOf(result);
    assert.equal(error.code, 'publish_not_found', 'remapped by publishToolError');
    assert.equal(error.retryable, false);
    assert.match(error.message, /no record of this publish_id/u);
    assert.equal(result.data, undefined, 'a refusal carries no payload');
    // § 5.2: the upstream prose stays out of the model-facing message, while
    // the structured fields keep everything an operator needs.
    assert.ok(!error.message.includes('tt-internal'));
    assert.equal(error.log_id, TEST_LOG_ID);
    assert.equal(error.details?.['api_code'], 'invalid_publish_id');
  });
});

test('a status result never carries a token, an upload URL or an upload token', async () => {
  await withCtx({}, async (ctx) => {
    const stub = fakeApi({
      status: () =>
        ttEnvelope({
          status: 'PUBLISH_COMPLETE',
          publicaly_available_post_id: [7_240_111_222_333],
          // Fields the mapper must drop rather than pass along.
          access_token: 'act.upstream-secret-value',
          upload_url: 'https://open-upload.tiktokapis.com/upload/?upload_id=abc',
          upload_token: 'upload-token-secret-value',
        }),
    });
    const result = await runStatus(ctx, stub, { publish_id: PUBLISH_ID });
    dataOf(result);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('access_token'));
    assert.ok(!serialized.includes('upload_url'));
    assert.ok(!serialized.includes('upload_token'));
    assert.ok(!serialized.includes('secret-value'));
    assert.ok(!serialized.includes('test-access-token-DEFAULT'));
  });
});

// ---------------------------------------------------------------------------
// journalOptions — the wiring every publish tool shares
// ---------------------------------------------------------------------------

test('journalOptions carries the env file, the size cap and the call logger', () => {
  const envFile = join(tmpdir(), 'tiktok-mcp-read-test.env');
  const { ctx } = harness({ TT_ENV_FILE: envFile, TT_JOURNAL_MAX_BYTES: '4096' });
  const options = journalOptions(ctx);

  assert.ok(options.envFile !== undefined);
  // Compared by basename: TT_ENV_FILE is resolved, and an absolute path
  // literal would not survive the Windows leg of CI.
  assert.ok(options.envFile.endsWith('tiktok-mcp-read-test.env'));
  assert.equal(options.maxBytes, 4_096);
  assert.equal(options.logger, ctx.log, 'the journal logs through the call logger');
});

test('journalOptions omits envFile entirely when TT_ENV_FILE is unset', () => {
  const { ctx } = harness();
  const options = journalOptions(ctx);

  assert.ok(!Object.hasOwn(options, 'envFile'), 'omitted, never undefined');
  assert.equal(options.maxBytes, 5_242_880, 'the documented default cap');
  assert.equal(options.logger, ctx.log);
});
