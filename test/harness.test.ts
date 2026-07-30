/**
 * Self-tests for the extended harness (TESTING.md § Extended harness).
 *
 * The harness is the instrument every later test measures with, so it is tested
 * first and on its own. A silently broken simulator does not fail — it *passes*
 * tests that should have failed, which is the one failure mode no downstream
 * suite can detect. Each test below therefore checks both directions: the
 * harness accepts correct behaviour, and it rejects the specific wrong
 * behaviour it exists to catch.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deferred, flush } from './harness/deferred.js';
import { runContendingChildren } from './harness/multi-process.js';
import { makeRng } from './harness/rng.js';
import { startTokenStub } from './harness/token-stub.js';
import { uploadSimulator, type UploadSimulator } from './harness/upload-simulator.js';
import { baselineEnv, fsSandbox, withEnv } from './helpers.js';

// ---------------------------------------------------------------------------
// Seeded RNG (determinism rule 4)
// ---------------------------------------------------------------------------

test('the same seed replays the same sequence, byte for byte', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const left = Array.from({ length: 20 }, () => a());
  const right = Array.from({ length: 20 }, () => b());
  assert.deepEqual(left, right);
  assert.equal(a.seed, 12345);
});

test('the generated sequence is pinned, so a rewrite cannot change it silently', () => {
  // Regenerating these numbers is not a fix: a printed seed has to reproduce
  // the same failure on every machine and Node version, which only holds while
  // the arithmetic is stable.
  const rng = makeRng(42);
  assert.deepEqual(
    [rng(), rng(), rng(), rng(), rng()],
    [
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
      0.17481389874592423,
    ],
  );
  assert.deepEqual([...makeRng(7).bytes(8)], [2, 15, 250, 178, 133, 103, 119, 61]);
});

test('different seeds diverge immediately', () => {
  assert.notEqual(makeRng(1)(), makeRng(2)());
});

test('every value is in [0, 1) and every int is in range', () => {
  const rng = makeRng(99);
  for (let i = 0; i < 500; i += 1) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `value out of range: ${String(value)}`);
    const int = rng.int(10);
    assert.ok(
      Number.isInteger(int) && int >= 0 && int < 10,
      `int out of range: ${String(int)}`,
    );
  }
});

test('pick chooses from the array and bytes has the requested length', () => {
  const rng = makeRng(2024);
  const items = ['alpha', 'beta', 'gamma'] as const;
  const seen = new Set<string>();
  for (let i = 0; i < 60; i += 1) seen.add(rng.pick(items));
  assert.deepEqual([...seen].sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(rng.bytes(0).length, 0);
  assert.equal(rng.bytes(33).length, 33);
});

test('the generator rejects arguments that would make it non-deterministic', () => {
  assert.throws(() => makeRng(1.5), /seed must be an integer/);
  assert.throws(() => makeRng(42).int(0), /maxExclusive must be an integer >= 1/);
  assert.throws(() => makeRng(42).int(2.5), /maxExclusive must be an integer >= 1/);
  assert.throws(() => makeRng(42).pick([]), /cannot pick from an empty array/);
  assert.throws(() => makeRng(42).bytes(-1), /n must be an integer >= 0/);
});

// ---------------------------------------------------------------------------
// Deferred promises
// ---------------------------------------------------------------------------

test('a deferred stays pending until it is settled by hand', async () => {
  const gate = deferred<number>();
  let resolved = false;
  const pending = gate.promise.then((value) => {
    resolved = true;
    return value;
  });

  await flush(2);
  assert.equal(resolved, false, 'settled without anyone resolving it');
  assert.equal(gate.settled, false);

  gate.resolve(7);
  assert.equal(gate.settled, true);
  assert.equal(await pending, 7);
  assert.equal(resolved, true);
});

test('a deferred rejects with the reason verbatim, even a non-Error', async () => {
  const gate = deferred();
  const reason = { code: 'env_file_busy' };
  gate.reject(reason);
  assert.equal(gate.settled, true);
  await assert.rejects(
    () => gate.promise,
    (err: unknown) => {
      // Identity, not shape: an abort reason is matched by reference upstream.
      assert.equal(err, reason);
      return true;
    },
  );
});

test('a deferred proves single-flight: the second caller joins the first request', async () => {
  // This is the whole reason deferred exists. Counting requests *after* both
  // callers finish cannot distinguish single-flight from a serial
  // implementation — both end at one. Holding the first request open can.
  const gate = deferred<string>();
  let starts = 0;
  let inFlight: Promise<string> | undefined;
  const refresh = (): Promise<string> => {
    if (inFlight !== undefined) return inFlight;
    starts += 1;
    inFlight = gate.promise;
    return inFlight;
  };

  const first = refresh();
  const second = refresh();
  await flush();

  assert.equal(starts, 1, 'the second caller started its own request');
  assert.equal(
    gate.settled,
    false,
    'the request finished before the assertion could see it',
  );

  gate.resolve('rotated-token');
  assert.deepEqual(await Promise.all([first, second]), [
    'rotated-token',
    'rotated-token',
  ]);
});

test('flush turns the event loop without waiting on wall-clock time', async () => {
  const trail: string[] = [];
  void Promise.resolve()
    .then(() => trail.push('microtask'))
    .then(() => trail.push('chained'));
  setImmediate(() => trail.push('macrotask'));

  await flush();
  assert.deepEqual(trail, ['microtask', 'chained', 'macrotask']);
});

// ---------------------------------------------------------------------------
// Upload simulator
// ---------------------------------------------------------------------------

const UPLOAD_URL = 'https://upload.example.invalid/v1/put?sig=abc';

/** One well-formed chunk PUT, the way the client is expected to send it. */
function chunkPut(
  sim: UploadSimulator,
  source: Uint8Array,
  first: number,
  length: number,
  extra: Record<string, string> = {},
): Promise<Response> {
  const last = first + length - 1;
  return sim.fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: {
      'content-range': `bytes ${String(first)}-${String(last)}/${String(source.length)}`,
      ...extra,
    },
    body: source.subarray(first, first + length),
  });
}

test('a correct three-chunk upload is accepted: 206, 206, then 201', async () => {
  const source = makeRng(1).bytes(30);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });

  assert.equal((await chunkPut(sim, source, 0, 10)).status, 206);
  assert.equal(sim.accepted, 10);
  assert.equal((await chunkPut(sim, source, 10, 10)).status, 206);
  assert.equal((await chunkPut(sim, source, 20, 10)).status, 201);
  assert.equal(sim.accepted, 30);

  sim.assertComplete();
  assert.deepEqual(
    sim.puts.map((put) => put.answered),
    [206, 206, 201],
  );
  assert.equal(sim.puts[0]?.contentRange, 'bytes 0-9/30');
});

test('a single-chunk upload completes on the first PUT', async () => {
  const source = makeRng(2).bytes(12);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  assert.equal((await chunkPut(sim, source, 0, 12)).status, 201);
  sim.assertComplete();
});

test('an injected 500 is re-sent as the same range and the upload still completes', async () => {
  const source = makeRng(3).bytes(20);
  const sim = uploadSimulator({
    source,
    uploadUrl: UPLOAD_URL,
    inject: { 2: { status: 500 } },
  });

  assert.equal((await chunkPut(sim, source, 0, 10)).status, 206);
  // The failure must not move the accepted-byte cursor, or the retry of the
  // same range would be rejected as out of order.
  assert.equal((await chunkPut(sim, source, 10, 10)).status, 500);
  assert.equal(sim.accepted, 10);
  assert.equal((await chunkPut(sim, source, 10, 10)).status, 201);

  sim.assertComplete();
  assert.deepEqual(
    sim.puts.map((put) => put.answered),
    [206, 500, 201],
  );
});

test('an out-of-order chunk is answered 416 and reported by assertComplete', async () => {
  const source = makeRng(4).bytes(30);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });

  assert.equal((await chunkPut(sim, source, 0, 10)).status, 206);
  // Skips bytes 10-19 entirely — the gap the "first byte === accepted" rule
  // exists to catch.
  assert.equal((await chunkPut(sim, source, 20, 10)).status, 416);
  assert.throws(
    () => sim.assertComplete(),
    /starts at byte 20, but 10 bytes have been accepted/,
  );
});

test('a chunk that repeats already-accepted bytes is rejected', async () => {
  const source = makeRng(5).bytes(20);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  await chunkPut(sim, source, 0, 10);
  assert.equal((await chunkPut(sim, source, 5, 10)).status, 416);
  assert.throws(() => sim.assertComplete(), /starts at byte 5/);
});

test('leaking the bearer to the upload URL is reported', async () => {
  const source = makeRng(6).bytes(10);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  await chunkPut(sim, source, 0, 10, {
    authorization: 'Bearer test-access-token-DEFAULT',
  });
  assert.throws(() => sim.assertComplete(), /carried an Authorization header/);
});

test('a PUT to the wrong URL or with the wrong method is reported', async () => {
  const source = makeRng(7).bytes(4);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  await sim.fetch('https://open.tiktokapis.com/v2/post/publish/', {
    method: 'POST',
    headers: { 'content-range': `bytes 0-3/4` },
    body: source,
  });
  assert.throws(() => sim.assertComplete(), /went to https:\/\/open\.tiktokapis\.com/);
  assert.throws(() => sim.assertComplete(), /method was POST, expected PUT/);
});

test('an unreached injection fails the test instead of passing quietly', async () => {
  const source = makeRng(8).bytes(10);
  const sim = uploadSimulator({
    source,
    uploadUrl: UPLOAD_URL,
    inject: { 2: { status: 403 } },
  });
  // The client sailed through in one PUT, so the retry the test claimed to
  // exercise never happened.
  assert.equal((await chunkPut(sim, source, 0, 10)).status, 201);
  assert.throws(
    () => sim.assertComplete(),
    /injected failures at put\(s\) 2 were never reached/,
  );
});

test('an upload that stops halfway is reported as incomplete', async () => {
  const source = makeRng(9).bytes(30);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  await chunkPut(sim, source, 0, 10);
  assert.throws(
    () => sim.assertComplete(),
    /the upload never completed: 10 of 30 bytes accepted/,
  );
});

test('a PUT after the final 201 is refused and reported', async () => {
  const source = makeRng(10).bytes(10);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  assert.equal((await chunkPut(sim, source, 0, 10)).status, 201);
  assert.equal((await chunkPut(sim, source, 0, 10)).status, 400);
  assert.throws(() => sim.assertComplete(), /arrived after the final 201/);
});

test('a malformed Content-Range is reported rather than guessed at', async () => {
  const source = makeRng(11).bytes(8);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  await sim.fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: { 'content-range': 'bytes=0-7/8' },
    body: source,
  });
  assert.throws(() => sim.assertComplete(), /Content-Range missing or malformed/);
});

test('a declared total that disagrees with the source is reported', async () => {
  const source = makeRng(12).bytes(8);
  const sim = uploadSimulator({ source, uploadUrl: UPLOAD_URL });
  await sim.fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: { 'content-range': 'bytes 0-7/9' },
    body: source,
  });
  assert.throws(() => sim.assertComplete(), /declared total 9, source is 8 bytes/);
});

test('a hung PUT never answers and rejects with the abort reason', async () => {
  const source = makeRng(13).bytes(10);
  const sim = uploadSimulator({
    source,
    uploadUrl: UPLOAD_URL,
    inject: { 1: { hang: true } },
  });
  const controller = new AbortController();
  const pending = sim.fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: { 'content-range': 'bytes 0-9/10' },
    body: source,
    signal: controller.signal,
  });

  await flush();
  assert.equal(sim.puts[0]?.answered, 'hang');

  const reason = new Error('upload timed out');
  controller.abort(reason);
  await assert.rejects(
    () => pending,
    (err: unknown) => {
      // `fetch` rejects with signal.reason itself, so the simulator must too.
      assert.equal(err, reason);
      return true;
    },
  );
});

test('assertComplete reports every problem it found, not just the first', async () => {
  const source = makeRng(14).bytes(20);
  const sim = uploadSimulator({
    source,
    uploadUrl: UPLOAD_URL,
    inject: { 3: { status: 500 } },
  });
  await chunkPut(sim, source, 0, 10, { authorization: 'Bearer leaked' });
  await chunkPut(sim, source, 15, 5);
  assert.throws(
    () => sim.assertComplete(),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /carried an Authorization header/);
      assert.match(message, /starts at byte 15/);
      assert.match(message, /injected failures at put\(s\) 3 were never reached/);
      assert.match(message, /the upload never completed/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// OAuth token stub
// ---------------------------------------------------------------------------

test('the token stub answers the flat OAuth shape and rotates both tokens', async (t) => {
  const stub = await startTokenStub();
  t.after(() => stub.close());

  const response = await fetch(`${stub.baseUrl}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: 'test-client-key',
      grant_type: 'refresh_token',
      refresh_token: 'test-refresh-token-DEFAULT',
    }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  // TIKTOK-API § 1.2: this endpoint is NOT enveloped. A test that passes
  // against `{data: …}` here would hide the wrong decoder being used (CC-A12).
  assert.equal('data' in body, false);
  assert.equal('error' in body, false);
  assert.equal(body['access_token'], 'stub-access-1');
  assert.equal(body['refresh_token'], 'stub-refresh-1');
  assert.equal(body['expires_in'], 86_400);
  assert.equal(body['refresh_expires_in'], 31_536_000);
  assert.equal(body['token_type'], 'Bearer');

  assert.equal(stub.refreshCount, 1);
  assert.equal(stub.serial, 1);
  assert.equal(stub.served[0]?.grantType, 'refresh_token');
  assert.equal(stub.served[0]?.refreshToken, 'test-refresh-token-DEFAULT');
  assert.deepEqual(stub.unexpected, []);
});

test('each successful refresh advances the serial, so duplicates are detectable', async (t) => {
  const stub = await startTokenStub();
  t.after(() => stub.close());

  const tokens: unknown[] = [];
  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(`${stub.baseUrl}/v2/oauth/token/`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token' }).toString(),
    });
    tokens.push(((await response.json()) as Record<string, unknown>)['access_token']);
  }

  assert.deepEqual(tokens, ['stub-access-1', 'stub-access-2', 'stub-access-3']);
  assert.equal(stub.refreshCount, 3);
});

test('an injected OAuth failure is flat too, and consumes no serial', async (t) => {
  const stub = await startTokenStub({
    failWith: {
      1: { error: 'invalid_grant', error_description: 'Refresh token is invalid.' },
    },
  });
  t.after(() => stub.close());

  const failed = await fetch(`${stub.baseUrl}/v2/oauth/token/`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token' }).toString(),
  });
  const failedBody = (await failed.json()) as Record<string, unknown>;
  assert.equal(failed.status, 400);
  assert.equal(failedBody['error'], 'invalid_grant');
  assert.equal(failedBody['error_description'], 'Refresh token is invalid.');
  assert.equal('data' in failedBody, false);
  assert.equal(stub.refreshCount, 0);

  // The next call is ordinal 2, which was not scripted to fail, and it gets
  // serial 1 — a refused refresh must not burn a rotation.
  const ok = await fetch(`${stub.baseUrl}/v2/oauth/token/`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token' }).toString(),
  });
  assert.equal(
    ((await ok.json()) as Record<string, unknown>)['access_token'],
    'stub-access-1',
  );
  assert.equal(stub.served.length, 2);
  assert.equal(stub.served[0]?.serial, undefined);
  assert.equal(stub.served[1]?.serial, 1);
});

test('the stub serves revoke and records requests to routes it does not implement', async (t) => {
  const stub = await startTokenStub();
  t.after(() => stub.close());

  const revoked = await fetch(`${stub.baseUrl}/v2/oauth/revoke/`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), {});

  const wrong = await fetch(`${stub.baseUrl}/v2/user/info/`, { method: 'POST' });
  assert.equal(wrong.status, 404);
  assert.deepEqual(stub.unexpected, ['POST /v2/user/info/']);
  assert.equal(stub.refreshCount, 0);
});

// ---------------------------------------------------------------------------
// Multi-process contention harness
// ---------------------------------------------------------------------------

const REFRESH_WORKER = new URL('./harness/workers/refresh-worker.js', import.meta.url);
const OUTCOME_WORKER = new URL('./harness/workers/outcome-worker.js', import.meta.url);

test('children meet at the barrier and report their own results', async (t) => {
  const outcomes = await runContendingChildren({
    childModule: OUTCOME_WORKER,
    count: 3,
    args: { note: 'passed through as JSON' },
    signal: AbortSignal.timeout(30_000),
  });
  t.diagnostic(JSON.stringify(outcomes));

  assert.equal(outcomes.length, 3);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.index),
    [0, 1, 2],
  );

  // A worker that throws is a *result*: "the losers see env_file_busy" is the
  // expected outcome of a contention test, not a harness error.
  assert.equal(outcomes[0]?.ok, true);
  assert.deepEqual(outcomes[0]?.payload, {
    index: 0,
    args: { note: 'passed through as JSON' },
    won: true,
  });
  for (const loser of [outcomes[1], outcomes[2]]) {
    assert.equal(loser?.ok, false);
    assert.match(loser?.error ?? '', /Error: env_file_busy: child \d lost the race/);
  }
});

test('the TT_ variables the test sets survive into the children', async (t) => {
  // Without TIKTOK_MCP_TEST_INHERIT_ENV the worker's own `import './helpers.js'`
  // would strip TT_OAUTH_BASE_URL at load and every child would fail.
  const stub = await startTokenStub();
  t.after(() => stub.close());
  const sandbox = await fsSandbox();
  t.after(() => sandbox.cleanup());

  const outcomes = await runContendingChildren({
    childModule: REFRESH_WORKER,
    count: 2,
    env: { ...baselineEnv(), TT_OAUTH_BASE_URL: stub.baseUrl },
    signal: AbortSignal.timeout(30_000),
  });
  t.diagnostic(JSON.stringify(outcomes));

  for (const outcome of outcomes) {
    assert.equal(outcome.ok, true, outcome.error);
    const payload = outcome.payload as Record<string, unknown>;
    assert.equal(payload['status'], 200);
    assert.equal(payload['hasDataWrapper'], false);
    assert.match(String(payload['accessToken']), /^stub-access-[12]$/);
  }

  // Two unlocked processes refresh twice and end on different serials — this is
  // exactly the damage `core/env-lock` exists to prevent, pinned here so the
  // lock's own test has an unlocked baseline to contrast with.
  assert.equal(stub.refreshCount, 2);
  assert.deepEqual(
    outcomes
      .map((outcome) => (outcome.payload as Record<string, unknown>)['accessToken'])
      .sort(),
    ['stub-access-1', 'stub-access-2'],
  );
});

test('the parent environment does not leak the fixture variables back', () => {
  // A guard on the test above: `runContendingChildren` builds the child env from
  // a copy, so setting TT_OAUTH_BASE_URL for the children must not touch this
  // process — where every other test relies on it being absent.
  assert.equal(process.env['TT_OAUTH_BASE_URL'], undefined);
  withEnv({ TT_OAUTH_BASE_URL: 'http://127.0.0.1:1' }, () => {
    assert.equal(process.env['TT_OAUTH_BASE_URL'], 'http://127.0.0.1:1');
  });
  assert.equal(process.env['TT_OAUTH_BASE_URL'], undefined);
});

test('an already-aborted canary fails fast instead of hanging the job', async () => {
  await assert.rejects(
    () =>
      runContendingChildren({
        childModule: OUTCOME_WORKER,
        count: 2,
        signal: AbortSignal.abort(),
      }),
    /aborted with .* child\(ren\) unfinished/,
  );
});

test('a fleet size that cannot contend is rejected outright', async () => {
  await assert.rejects(
    () => runContendingChildren({ childModule: OUTCOME_WORKER, count: 0 }),
    /count must be an integer >= 1/,
  );
});

test('a worker module without a default export is reported, not silently skipped', async () => {
  await assert.rejects(
    () =>
      runContendingChildren({
        // `deferred.js` is a real module with named exports only.
        childModule: new URL('./harness/deferred.js', import.meta.url),
        count: 1,
        signal: AbortSignal.timeout(30_000),
      }),
    /has no default-exported function/,
  );
});
