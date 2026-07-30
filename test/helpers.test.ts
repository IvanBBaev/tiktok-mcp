/**
 * Self-tests for the frozen harness (`test/helpers.ts`).
 *
 * The harness is the thing every other test trusts, so its guarantees are
 * asserted here rather than assumed: virtual time really is virtual, scoped
 * mutation really is restored on the throwing path, and an unexpected upstream
 * call really does fail rather than hang.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  BASELINE_NOW_MS,
  BASELINE_SCOPES,
  ScriptFetchExhaustedError,
  TEST_LOG_ID,
  baselineEnv,
  fsSandbox,
  mockClock,
  scriptFetch,
  ttEnvelope,
  withEnv,
  withFetch,
} from './helpers.js';

interface Envelope {
  data: unknown;
  error: { code: string; message: string; log_id: string };
}

// ---------------------------------------------------------------------------
// mockClock
// ---------------------------------------------------------------------------

test('cc-h4 advancing virtual time by ten minutes costs no wall-clock time', async () => {
  const clock = mockClock(0);
  const woke: number[] = [];
  const pending = clock.sleep(9 * 60_000).then(() => woke.push(clock.now()));

  const startedAt = process.hrtime.bigint();
  await clock.advance(10 * 60_000);
  await pending;
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert.deepEqual(woke, [9 * 60_000]);
  assert.equal(clock.now(), 10 * 60_000);
  // A generous bound: the point is that nothing waited on a real timer, not
  // that the machine is fast. A real ten-minute sleep would blow this by 5 000x.
  assert.ok(elapsedMs < 2_000, `advance took ${String(elapsedMs)} ms of real time`);
});

test('mockClock starts at the baseline instant unless told otherwise', () => {
  assert.equal(mockClock().now(), BASELINE_NOW_MS);
  assert.equal(new Date(BASELINE_NOW_MS).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(mockClock(42).now(), 42);
});

test('due sleeps resolve in deadline order, ties in request order', async () => {
  const clock = mockClock(0);
  const order: string[] = [];
  const all = Promise.all([
    clock.sleep(30).then(() => order.push('30')),
    clock.sleep(10).then(() => order.push('10-first')),
    clock.sleep(10).then(() => order.push('10-second')),
    clock.sleep(20).then(() => order.push('20')),
  ]);

  assert.equal(clock.pending(), 4);
  await clock.advance(30);
  await all;

  assert.deepEqual(order, ['10-first', '10-second', '20', '30']);
  assert.equal(clock.pending(), 0);
});

test('a woken sleeper sees the instant it was woken at, not the end of the window', async () => {
  const clock = mockClock(0);
  const seen: number[] = [];
  const all = Promise.all([
    clock.sleep(10).then(() => seen.push(clock.now())),
    clock.sleep(20).then(() => seen.push(clock.now())),
  ]);

  await clock.advance(100);
  await all;

  assert.deepEqual(seen, [10, 20]);
  assert.equal(clock.now(), 100);
});

test('a sleep requested from a continuation fires inside the same advance', async () => {
  const clock = mockClock(0);
  const trail: string[] = [];
  const chain = (async () => {
    await clock.sleep(100);
    trail.push(`first@${String(clock.now())}`);
    await clock.sleep(100);
    trail.push(`second@${String(clock.now())}`);
  })();

  await clock.advance(250);
  await chain;

  assert.deepEqual(trail, ['first@100', 'second@200']);
  assert.equal(clock.now(), 250);
  assert.equal(clock.pending(), 0);
});

test('a sleep past the advance window stays pending', async () => {
  const clock = mockClock(0);
  let resolved = false;
  const late = clock.sleep(500).then(() => {
    resolved = true;
  });

  await clock.advance(499);
  assert.equal(resolved, false);
  assert.equal(clock.pending(), 1);

  await clock.advance(1);
  await late;
  assert.equal(resolved, true);
});

test('sleep is always asynchronous — even sleep(0) needs time to pass', async () => {
  const clock = mockClock(0);
  let resolved = false;
  const zero = clock.sleep(0).then(() => {
    resolved = true;
  });

  assert.equal(resolved, false, 'sleep(0) must not resolve synchronously');
  assert.equal(clock.pending(), 1);

  await clock.advance(0);
  await zero;
  assert.equal(resolved, true);
  assert.equal(clock.now(), 0, 'advance(0) fires due sleeps without moving time');
});

test('a negative delay is clamped to zero rather than rejected', async () => {
  const clock = mockClock(1_000);
  const missed = clock.sleep(-5_000);
  await clock.advance(0);
  await missed;
  assert.equal(clock.now(), 1_000);
});

test('NaN, infinite and over-2^31 delays reject with RangeError', async () => {
  const clock = mockClock(0);
  await assert.rejects(clock.sleep(Number.NaN), RangeError);
  await assert.rejects(clock.sleep(Number.POSITIVE_INFINITY), RangeError);
  await assert.rejects(clock.sleep(Number.NEGATIVE_INFINITY), RangeError);
  await assert.rejects(clock.sleep(2_147_483_648), RangeError);
  assert.equal(clock.pending(), 0, 'a rejected sleep must not leave a waiter behind');
});

test('an already-aborted signal rejects immediately and registers no waiter', async () => {
  const clock = mockClock(0);
  const controller = new AbortController();
  const reason = new Error('gone before we started');
  controller.abort(reason);

  await assert.rejects(
    clock.sleep(50, controller.signal),
    (thrown: unknown) => thrown === reason,
  );
  assert.equal(clock.pending(), 0);
});

test('aborting during a sleep drops the waiter and rejects with signal.reason', async () => {
  const clock = mockClock(0);
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  const pending = clock.sleep(10_000, controller.signal);
  assert.equal(clock.pending(), 1);

  controller.abort(reason);
  await assert.rejects(pending, (thrown: unknown) => thrown === reason);
  assert.equal(clock.pending(), 0);

  // The cancelled sleep must not resurface when time reaches its deadline.
  await clock.advance(20_000);
  assert.equal(clock.pending(), 0);
});

test('an abort with no reason rejects with a DOMException named AbortError', async () => {
  const clock = mockClock(0);
  const controller = new AbortController();
  const pending = clock.sleep(10_000, controller.signal);
  controller.abort();

  await assert.rejects(pending, (thrown: unknown) => {
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.name, 'AbortError');
    return true;
  });
});

test('advance rejects a negative or non-finite step', async () => {
  const clock = mockClock(0);
  await assert.rejects(clock.advance(-1), RangeError);
  await assert.rejects(clock.advance(Number.NaN), RangeError);
  await assert.rejects(clock.advance(Number.POSITIVE_INFINITY), RangeError);
  assert.equal(clock.now(), 0);
});

test('setNow steps time backwards without firing or cancelling waiters', async () => {
  const clock = mockClock(10_000);
  let resolved = false;
  const pending = clock.sleep(1_000).then(() => {
    resolved = true;
  });

  clock.setNow(5_000);
  assert.equal(clock.now(), 5_000);
  assert.equal(clock.pending(), 1);
  assert.equal(resolved, false);

  // The deadline was fixed at 11 000 when the sleep was requested, so from
  // 5 000 it now takes 6 000 ms of virtual time — deadline logic that assumed a
  // monotonic clock is exactly what this exposes.
  await clock.advance(5_999);
  assert.equal(resolved, false);
  await clock.advance(1);
  await pending;
  assert.equal(resolved, true);
});

// ---------------------------------------------------------------------------
// baselineEnv / withEnv
// ---------------------------------------------------------------------------

test('baselineEnv is a fresh, complete, mutually consistent credential set', () => {
  const first = baselineEnv();
  const second = baselineEnv();
  assert.notEqual(first, second, 'each call must hand out a separate object');
  assert.deepEqual(first, second);

  for (const key of [
    'TT_CLIENT_KEY',
    'TT_CLIENT_SECRET',
    'TT_ACCESS_TOKEN',
    'TT_REFRESH_TOKEN',
    'TT_OPEN_ID',
    'TT_SCOPES',
    'TT_TOKEN_EXPIRES_AT',
    'TT_REFRESH_EXPIRES_AT',
  ]) {
    assert.ok((first[key] ?? '').length > 0, `${key} is missing from the baseline`);
  }

  assert.equal(first.TT_SCOPES, BASELINE_SCOPES);
  // cc-h2: expiries are ISO-8601 UTC, and both lie in the mock clock's future.
  const tokenExpiry = Date.parse(String(first.TT_TOKEN_EXPIRES_AT));
  const refreshExpiry = Date.parse(String(first.TT_REFRESH_EXPIRES_AT));
  assert.ok(tokenExpiry > BASELINE_NOW_MS);
  assert.ok(refreshExpiry > tokenExpiry);
});

test('withEnv applies, deletes and restores exactly the keys it was given', () => {
  process.env.TT_PRESENT_BEFORE = 'outer';
  try {
    const inside = withEnv(
      { TT_PRESENT_BEFORE: 'inner', TT_ADDED: 'new', TT_ABSENT: undefined },
      () => ({
        present: process.env.TT_PRESENT_BEFORE,
        added: process.env.TT_ADDED,
        absentKeyExists: 'TT_ABSENT' in process.env,
      }),
    );

    assert.deepEqual(inside, {
      present: 'inner',
      added: 'new',
      absentKeyExists: false,
    });
    assert.equal(process.env.TT_PRESENT_BEFORE, 'outer');
    assert.equal('TT_ADDED' in process.env, false, 'an added key must be removed again');
  } finally {
    delete process.env.TT_PRESENT_BEFORE;
  }
});

test('withEnv deletes a key for the duration and puts it back afterwards', () => {
  process.env.TT_TO_HIDE = 'visible';
  try {
    withEnv({ TT_TO_HIDE: undefined }, () => {
      assert.equal('TT_TO_HIDE' in process.env, false);
    });
    assert.equal(process.env.TT_TO_HIDE, 'visible');
  } finally {
    delete process.env.TT_TO_HIDE;
  }
});

test('withEnv restores the environment when the body throws', () => {
  assert.equal('TT_ROLLED_BACK' in process.env, false);
  assert.throws(() => {
    withEnv({ TT_ROLLED_BACK: 'set' }, () => {
      throw new Error('body failed');
    });
  }, /body failed/);
  assert.equal('TT_ROLLED_BACK' in process.env, false);
});

test('withEnv nests: the inner scope overrides only its own keys', () => {
  withEnv({ TT_OUTER: 'a', TT_SHARED: 'outer' }, () => {
    withEnv({ TT_SHARED: 'inner', TT_INNER: 'b' }, () => {
      assert.equal(process.env.TT_OUTER, 'a');
      assert.equal(process.env.TT_SHARED, 'inner');
      assert.equal(process.env.TT_INNER, 'b');
    });
    assert.equal(process.env.TT_SHARED, 'outer');
    assert.equal('TT_INNER' in process.env, false);
  });
  assert.equal('TT_OUTER' in process.env, false);
  assert.equal('TT_SHARED' in process.env, false);
});

test('the harness leaves no TT_ variable in the ambient environment', () => {
  assert.deepEqual(
    Object.keys(process.env).filter((key) => key.startsWith('TT_')),
    [],
  );
});

test('an ambient TT_ variable does not survive importing the harness', () => {
  const helpers = new URL('./helpers.js', import.meta.url);
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(helpers.href)});
       const leaked = Object.keys(process.env).filter((k) => k.startsWith('TT_'));
       process.stdout.write(JSON.stringify(leaked));`,
    ],
    {
      env: {
        ...process.env,
        TT_ACCESS_TOKEN: 'a-developer-shell-token',
        TT_CLIENT_KEY: 'a-developer-shell-key',
      },
      encoding: 'utf8',
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), []);
});

// ---------------------------------------------------------------------------
// scriptFetch / withFetch / ttEnvelope
// ---------------------------------------------------------------------------

test('withFetch swaps globalThis.fetch and restores it afterwards', async () => {
  const real = globalThis.fetch;
  const stub = scriptFetch([ttEnvelope({ ok: true })]);

  const swapped = await withFetch(stub, async () => {
    assert.notEqual(globalThis.fetch, real);
    await fetch('https://open.tiktokapis.com/v2/user/info/');
    return globalThis.fetch;
  });

  assert.notEqual(swapped, real);
  assert.equal(globalThis.fetch, real);
});

test('withFetch restores globalThis.fetch when the body rejects', async () => {
  const real = globalThis.fetch;
  await assert.rejects(
    withFetch(scriptFetch([]), () => Promise.reject(new Error('body failed'))),
    /body failed/,
  );
  assert.equal(globalThis.fetch, real);
});

test('scriptFetch hands out its responses in order', async () => {
  const stub = scriptFetch([ttEnvelope({ step: 1 }), ttEnvelope({ step: 2 })]);
  const seen = await withFetch(stub, async () => {
    const first = (await (await fetch('https://x/1')).json()) as Envelope;
    const second = (await (await fetch('https://x/2')).json()) as Envelope;
    return [first.data, second.data];
  });

  assert.deepEqual(seen, [{ step: 1 }, { step: 2 }]);
  assert.deepEqual(
    stub.calls.map((call) => call.url),
    ['https://x/1', 'https://x/2'],
  );
});

test('scriptFetch records the URL, method, lower-cased headers and body', async () => {
  const stub = scriptFetch([ttEnvelope({ publish_id: 'p1' })]);
  await withFetch(stub, () =>
    fetch(new URL('https://open.tiktokapis.com/v2/post/publish/video/init/'), {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ post_info: { title: 'hello' } }),
    }),
  );

  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call?.url, 'https://open.tiktokapis.com/v2/post/publish/video/init/');
  assert.equal(call?.method, 'POST');
  assert.equal(call?.headers['content-type'], 'application/json');
  assert.equal(call?.headers.authorization, 'Bearer secret');
  assert.deepEqual(call?.json(), { post_info: { title: 'hello' } });
});

test('a request with no init records as GET with an empty body', async () => {
  const stub = scriptFetch([ttEnvelope(null)]);
  await withFetch(stub, () => fetch('https://x/plain'));

  const call = stub.calls[0];
  assert.equal(call?.method, 'GET');
  assert.deepEqual(call?.headers, {});
  assert.equal(call?.text(), '');
});

test('a binary body is recorded verbatim and decodes as UTF-8 text', async () => {
  const stub = scriptFetch([ttEnvelope(null)]);
  const bytes = new TextEncoder().encode('chunk-bytes');
  await withFetch(stub, () =>
    fetch('https://upload/put', { method: 'PUT', body: bytes }),
  );

  const call = stub.calls[0];
  assert.equal(call?.body, bytes, 'the exact body value is kept for identity checks');
  assert.equal(call?.text(), 'chunk-bytes');
});

test('the same Response may be scripted more than once, for retry paths', async () => {
  const boom = ttEnvelope(null, { code: 'internal_error', message: 'try again' });
  const stub = scriptFetch([boom, boom, ttEnvelope({ recovered: true })]);

  const codes = await withFetch(stub, async () => {
    const out: string[] = [];
    for (const path of ['1', '2', '3']) {
      const body = (await (await fetch(`https://x/${path}`)).json()) as Envelope;
      out.push(body.error.code);
    }
    return out;
  });

  assert.deepEqual(codes, ['internal_error', 'internal_error', 'ok']);
});

test('a call past the end of the script throws synchronously and is recorded', () => {
  const stub = scriptFetch([]);
  assert.throws(
    () => stub('https://open.tiktokapis.com/v2/user/info/'),
    ScriptFetchExhaustedError,
  );
  assert.equal(stub.calls.length, 1, 'the overrun call is still recorded');
});

test('a stub that must never be called reports zero calls', async () => {
  const stub = scriptFetch([]);
  await withFetch(stub, () => Promise.resolve());
  assert.equal(stub.calls.length, 0);
});

test('scriptFetch refuses a response whose body has already been read', async () => {
  const used = ttEnvelope({ drained: true });
  await used.json();
  const stub = scriptFetch([used]);
  assert.throws(() => stub('https://x/1'), TypeError);
});

test('ttEnvelope builds a success envelope with a log_id on HTTP 200', async () => {
  const response = ttEnvelope({ user: { open_id: 'o1' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), {
    data: { user: { open_id: 'o1' } },
    error: { code: 'ok', message: '', log_id: TEST_LOG_ID },
  });
});

test('cc-b9 a failure envelope still arrives as HTTP 200 and keeps its log_id', async () => {
  const response = ttEnvelope(null, {
    code: 'spam_risk_too_many_posts',
    message: 'daily post cap reached',
  });
  assert.equal(response.status, 200, 'the envelope, not the status, carries failure');

  const body = (await response.json()) as Envelope;
  assert.equal(body.error.code, 'spam_risk_too_many_posts');
  assert.equal(body.error.message, 'daily post cap reached');
  assert.equal(body.error.log_id, TEST_LOG_ID);
});

// ---------------------------------------------------------------------------
// fsSandbox
// ---------------------------------------------------------------------------

test('fsSandbox hands out a private, fully resolved directory', async () => {
  const first = await fsSandbox();
  const second = await fsSandbox();
  try {
    assert.notEqual(first.dir, second.dir);
    assert.equal(first.dir, await realpath(first.dir), 'dir must already be resolved');

    const file = join(first.dir, 'creds.env');
    await writeFile(file, 'TT_ACCESS_TOKEN=scratch\n', 'utf8');
    assert.equal(await readFile(file, 'utf8'), 'TT_ACCESS_TOKEN=scratch\n');
    assert.equal(existsSync(join(second.dir, 'creds.env')), false);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }

  assert.equal(existsSync(first.dir), false);
  assert.equal(existsSync(second.dir), false);
});

test('cleanup is idempotent, so a doubled finally is safe', async () => {
  const sandbox = await fsSandbox();
  await writeFile(join(sandbox.dir, 'file'), 'x', 'utf8');
  await sandbox.cleanup();
  await sandbox.cleanup();
  assert.equal(existsSync(sandbox.dir), false);
});
