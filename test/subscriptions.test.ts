/**
 * `mcp/subscriptions` — the per-session subscription hub (TOOLS.md § 7.4):
 * the silent baseline, polling a watched spec until it settles, pushed
 * notifications, and a close that leaves nothing scheduled. Time comes from
 * `mockClock`; reads and sends are recorded fakes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Logger } from '../src/core/log.js';
import type {
  ParsedResourceUri,
  ResourceMatch,
  ResourceSpec,
  ResourceWatch,
} from '../src/mcp/resources.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  DEFAULT_SUBSCRIPTION_POLL_MS,
  createSubscriptionHub,
  type SubscriptionHubOptions,
} from '../src/mcp/subscriptions.js';
import { deferred, flush } from './harness/deferred.js';
import { mockClock } from './helpers.js';

interface Recorded {
  readonly level: string;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      records.push(fields === undefined ? { level, msg } : { level, msg, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, records };
}

/** Only `watch` is read by the hub; the rest of the spec is irrelevant here. */
function specOf(watch?: ResourceWatch): ResourceSpec {
  return (watch === undefined ? {} : { watch }) as unknown as ResourceSpec;
}

const STATUS_WATCH: ResourceWatch = {
  volatile: ['checked_at'],
  settled: (data) => (data as { status?: string }).status === 'PUBLISH_COMPLETE',
};

function matchOf(spec: ResourceSpec, publishId = 'v_1'): ResourceMatch {
  return { spec, params: { publish_id: publishId } };
}

function parsedOf(uri: string): ParsedResourceUri {
  return { uri };
}

function statusResult(status: string, checkedAt = 't0'): ToolResult<unknown> {
  return { ok: true, data: { status, checked_at: checkedAt } };
}

/** A hub whose reads answer from `answers` in turn (the last one repeats). */
function fixture(
  answers: (ToolResult<unknown> | Error)[],
  overrides: Partial<SubscriptionHubOptions> = {},
) {
  const clock = mockClock();
  const { logger, records } = recordingLogger();
  const sent: string[] = [];
  let reads = 0;
  const hub = createSubscriptionHub({
    read: () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer as ToolResult<unknown>);
    },
    send: (uri) => {
      sent.push(uri);
      return Promise.resolve();
    },
    clock,
    logger,
    ...overrides,
  });
  return { hub, clock, records, sent, reads: () => reads };
}

const URI = 'tiktok://publish/v_1/status';

test('a watched subscription is seeded silently, then notified when its answer moves', async () => {
  const f = fixture([
    statusResult('PROCESSING_UPLOAD', 't0'),
    statusResult('PROCESSING_UPLOAD', 't1'),
    statusResult('PUBLISH_COMPLETE', 't2'),
  ]);
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  assert.equal(f.reads(), 1, 'the baseline is read at subscribe time');
  assert.deepEqual(f.sent, []);

  // Only `checked_at` moved — volatile, so not a change.
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.sent, []);

  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.equal(f.reads(), 3);
  assert.deepEqual(f.sent, [URI]);

  // Terminal: polling stopped, nothing is left scheduled.
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS * 3);
  assert.equal(f.reads(), 3);
  assert.equal(f.clock.pending(), 0);
  assert.deepEqual(f.hub.subscribed(), [URI]);
  await f.hub.close();
});

test('the poll period is configurable', async () => {
  const f = fixture(
    [statusResult('PROCESSING_UPLOAD'), statusResult('PUBLISH_COMPLETE')],
    { intervalMs: 1_000 },
  );
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  await f.clock.advance(1_000);
  assert.deepEqual(f.sent, [URI]);
  await f.hub.close();
});

test('a non-retryable failure settles the subscription; a retryable one keeps polling', async () => {
  const fatal: ToolResult<unknown> = {
    ok: false,
    error: { code: 'invalid_params', message: 'no', retryable: false },
  };
  const transient: ToolResult<unknown> = {
    ok: false,
    error: { code: 'rate_limited', message: 'later', retryable: true },
  };

  const settled = fixture([fatal]);
  settled.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  await settled.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS * 2);
  assert.equal(settled.reads(), 1);
  assert.equal(settled.clock.pending(), 0);
  await settled.hub.close();

  const retrying = fixture([transient, transient, statusResult('PROCESSING_UPLOAD')]);
  retrying.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  await retrying.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(retrying.sent, [], 'the same failure twice is not a change');
  await retrying.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(retrying.sent, [URI], 'recovering from the failure is one');
  await retrying.hub.close();
});

test('a read that throws is logged and polling continues', async () => {
  const f = fixture([
    statusResult('PROCESSING_UPLOAD'),
    new Error('socket hang up'),
    statusResult('PUBLISH_COMPLETE'),
  ]);
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(
    f.records.map((record) => [record.level, record.fields?.['reason']]),
    [['warn', 'socket hang up']],
  );
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(f.sent, [URI]);
  await f.hub.close();
});

test('a spec without a watch, or a hub without a clock, is never polled', async () => {
  const unwatched = fixture([statusResult('PROCESSING_UPLOAD')]);
  unwatched.hub.subscribe(URI, matchOf(specOf()), parsedOf(URI));
  await flush();
  await unwatched.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS * 2);
  assert.equal(unwatched.reads(), 0);
  assert.equal(unwatched.clock.pending(), 0);
  await unwatched.hub.close();

  const sent: string[] = [];
  let reads = 0;
  const clockless = createSubscriptionHub({
    read: () => {
      reads += 1;
      return Promise.resolve(statusResult('PROCESSING_UPLOAD'));
    },
    send: (uri) => {
      sent.push(uri);
      return Promise.resolve();
    },
  });
  clockless.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  assert.equal(reads, 0);
  // Pushes still reach it.
  assert.equal(await clockless.notify(() => true), 1);
  assert.deepEqual(sent, [URI]);
  await clockless.close();
});

test('notify reaches only the subscriptions the predicate accepts and counts the sends', async () => {
  const f = fixture([statusResult('PROCESSING_UPLOAD')]);
  const spec = specOf();
  const other = 'tiktok://publish/v_2/status';
  f.hub.subscribe(URI, matchOf(spec, 'v_1'), parsedOf(URI));
  f.hub.subscribe(other, matchOf(spec, 'v_2'), parsedOf(other));
  // Re-subscribing is a no-op: one notification, not two.
  f.hub.subscribe(URI, matchOf(spec, 'v_1'), parsedOf(URI));
  assert.deepEqual(f.hub.subscribed(), [URI, other]);

  const count = await f.hub.notify((match) => match.params['publish_id'] === 'v_2');
  assert.equal(count, 1);
  assert.deepEqual(f.sent, [other]);

  // Unsubscribed (and an unknown URI is fine): no longer notified.
  f.hub.unsubscribe(other);
  f.hub.unsubscribe('tiktok://publish/v_9/status');
  assert.equal(await f.hub.notify(() => true), 1);
  assert.deepEqual(f.sent, [other, URI]);
  await f.hub.close();
});

test('a rejected notification is logged and not counted', async () => {
  const f = fixture([statusResult('PROCESSING_UPLOAD')], {
    send: () => Promise.reject(new Error('Not connected')),
  });
  f.hub.subscribe(URI, matchOf(specOf()), parsedOf(URI));
  assert.equal(await f.hub.notify(() => true), 0);
  assert.deepEqual(
    f.records.map((record) => [record.level, record.fields?.['uri']]),
    [['warn', URI]],
  );
  await f.hub.close();
});

test('a push drops the baseline, so the next poll does not announce the change again', async () => {
  const f = fixture([
    statusResult('PROCESSING_UPLOAD'),
    statusResult('PROCESSING_DOWNLOAD'),
    statusResult('PROCESSING_DOWNLOAD'),
    statusResult('PUBLISH_COMPLETE'),
  ]);
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  assert.equal(await f.hub.notify(() => true), 1);
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(f.sent, [URI], 'the re-seed is silent');
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(f.sent, [URI], 'unchanged since the re-seed');
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(f.sent, [URI, URI]);
  await f.hub.close();
});

test('an unsubscribe while a read is out drops its answer', async () => {
  const pending = deferred<ToolResult<unknown>>();
  const f = fixture([statusResult('PROCESSING_UPLOAD')], {
    read: () => pending.promise,
  });
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  f.hub.unsubscribe(URI);
  pending.resolve(statusResult('PUBLISH_COMPLETE'));
  await flush(2);
  // The loop sees no subscription left and ends.
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.equal(f.clock.pending(), 0);
  assert.deepEqual(f.sent, []);
  await f.hub.close();
});

test('close stops the loop, awaits a read in flight and ignores later subscribes', async () => {
  const pending = deferred<ToolResult<unknown>>();
  let reads = 0;
  const f = fixture([statusResult('PROCESSING_UPLOAD')], {
    read: () => {
      reads += 1;
      return reads === 1
        ? Promise.resolve(statusResult('PROCESSING_UPLOAD'))
        : pending.promise;
    },
  });
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush();
  void f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  await flush();
  assert.equal(reads, 2, 'the tick read is in flight');

  let closed = false;
  const closing = f.hub.close().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false, 'close waits for the read');
  pending.resolve(statusResult('PUBLISH_COMPLETE'));
  await closing;
  assert.deepEqual(f.sent, [], 'nothing is sent after close');
  assert.equal(f.clock.pending(), 0);
  assert.deepEqual(f.hub.subscribed(), []);

  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  assert.deepEqual(f.hub.subscribed(), []);
  await f.hub.close();
});

test('a subscribe after polling ended starts the loop again', async () => {
  const f = fixture([statusResult('PUBLISH_COMPLETE')]);
  f.hub.subscribe(URI, matchOf(specOf(STATUS_WATCH)), parsedOf(URI));
  await flush(2);
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.equal(f.clock.pending(), 0, 'settled at the baseline: no loop');

  const second = 'tiktok://publish/v_2/status';
  const g = fixture([statusResult('PROCESSING_UPLOAD'), statusResult('FAILED')], {
    clock: f.clock,
  });
  g.hub.subscribe(second, matchOf(specOf(STATUS_WATCH), 'v_2'), parsedOf(second));
  await flush();
  assert.equal(f.clock.pending(), 1);
  await f.clock.advance(DEFAULT_SUBSCRIPTION_POLL_MS);
  assert.deepEqual(g.sent, [second]);
  await f.hub.close();
  await g.hub.close();
});
