/**
 * test/helpers.ts — the frozen cross-task test harness.
 *
 * Spec: CONTRACTS.md § Test harness (**authoritative**), mirrored in
 * TESTING.md § Harness. Every task in every wave consumes these eight symbols,
 * so this file is a contract, not a convenience: changing an existing signature
 * needs the same integrator sign-off as changing `docs/CONTRACTS.md`. Adding a
 * member is an addition; renaming or re-typing one breaks tasks that have
 * already landed.
 *
 * What it exists to guarantee (TESTING.md § Determinism rules):
 *
 * 1. **Tests never sleep** (rule 1 / CC-H4). `mockClock` implements the
 *    `core/clock.ts` `Clock` seam with virtual time; `advance(ms)` fires due
 *    sleeps in deadline order with zero wall-clock delay.
 * 2. **No real network** (rule 2). `withFetch` swaps `globalThis.fetch`;
 *    `scriptFetch` canned responses and records every outgoing request so a
 *    test can assert the URL, headers and body — and a call past the end of the
 *    script fails loudly instead of hanging.
 * 3. **No shared state** (rule 3). `withEnv` scopes env mutation and restores
 *    it even when the body throws; `fsSandbox` hands out a private scratch dir.
 *
 * The extended, non-contract harness (upload simulator, seeded RNG, deferreds,
 * multi-process lock driver) lives in `test/harness/**` and may change freely.
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Clock } from '../src/core/clock.js';

/**
 * Ambient `TT_*` variables are stripped from `process.env` the first time this
 * module is imported — which is once per test process, since every test file
 * imports it.
 *
 * Without this, a developer who has exported `TT_ACCESS_TOKEN` in their shell
 * runs a different test suite than CI does: `withEnv` only restores the keys it
 * was given, so anything else in the namespace leaks into every test that reads
 * settings. Determinism rule 3 ("no shared state between tests") has to cover
 * the state the process was born with, not just the state a test creates.
 *
 * `TT_` is a namespace this project owns end to end, so removing it cannot
 * disturb anything else in the environment.
 *
 * The one exception is a child process that a test *deliberately* launched with
 * `TT_*` set — the multi-process env-lock harness passes a shared env file and
 * the test-only `TT_OAUTH_BASE_URL` that way, and stripping them would defeat
 * the test. Such a child is started with `TIKTOK_MCP_TEST_INHERIT_ENV=1`, which
 * opts out. The flag deliberately does not live in the `TT_` namespace, so it
 * cannot be confused with a product setting or removed by this loop.
 */
if (process.env.TIKTOK_MCP_TEST_INHERIT_ENV !== '1') {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TT_')) delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * The injectable fetch shape (the `fetch` seam taken by `api/http.ts`). A stub
 * either implements this signature directly or is built by `scriptFetch` from
 * an ordered list of canned `Response`s — one per expected upstream call.
 */
export type FetchStub = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** One request a `scriptFetch` stub observed, in the order it was made. */
export interface RecordedCall {
  /** The request target, always as a string (a `URL` input is stringified). */
  readonly url: string;
  /** Upper-cased method; `GET` when the init omitted one, as `fetch` does. */
  readonly method: string;
  /** Header names lower-cased, so assertions do not depend on caller casing. */
  readonly headers: Readonly<Record<string, string>>;
  /** Exactly the value passed as `init.body` — untouched, for identity checks. */
  readonly body: unknown;
  /**
   * The body decoded as UTF-8 text; `''` when there was none. Throws for body
   * kinds this harness cannot decode synchronously (streams, `FormData`,
   * `Blob`) — a test that needs one of those should assert on `body` instead.
   */
  text(): string;
  /** `text()` parsed as JSON. Throws if the body was not JSON. */
  json(): unknown;
}

/** A `FetchStub` that also exposes what it was asked to send. */
export interface RecordingFetchStub extends FetchStub {
  /** Every call so far, including one that overran the script. */
  readonly calls: readonly RecordedCall[];
}

/**
 * Thrown when a `scriptFetch` stub is called more times than it has responses.
 * A distinct name matters: production code maps *every* fetch rejection to a
 * transport error (`network_unsent`), so a swallowed harness failure would
 * otherwise surface as a plausible-looking upstream error. If a test's
 * assertion looks wrong rather than absent, also assert `stub.calls.length`.
 */
export class ScriptFetchExhaustedError extends Error {
  constructor(scripted: number, url: string) {
    super(
      `scriptFetch: unexpected request #${String(scripted + 1)} to ${url} — ` +
        `the script only holds ${String(scripted)} response(s). ` +
        'An extra upstream call is a test failure, not a retry.',
    );
    this.name = 'ScriptFetchExhaustedError';
  }
}

function headerRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (raw === undefined) return out;
  if (raw instanceof Headers) {
    for (const [name, value] of raw.entries()) out[name.toLowerCase()] = value;
    return out;
  }
  if (Array.isArray(raw)) {
    for (const pair of raw) {
      const [name, value] = pair;
      if (name !== undefined && value !== undefined) out[name.toLowerCase()] = value;
    }
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    // Node's `HeadersInit` record form allows a repeated header as an array;
    // `fetch` joins those with ", " on the wire, so assertions see the wire form.
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function decodeBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  throw new TypeError(
    `RecordedCall.text(): cannot decode a body of this kind synchronously ` +
      `(${Object.prototype.toString.call(body)}); assert on \`body\` instead`,
  );
}

function record(input: string | URL, init?: RequestInit): RecordedCall {
  const body = init?.body;
  return {
    url: typeof input === 'string' ? input : input.toString(),
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: headerRecord(init),
    body,
    text: () => decodeBody(body),
    json: () => JSON.parse(decodeBody(body)) as unknown,
  };
}

/**
 * Build a `FetchStub` that returns the given `Response`s in order; a call past
 * the end throws `ScriptFetchExhaustedError` (an unexpected extra request is a
 * test failure, not a hang).
 *
 * Each response is handed out as a `clone()`, so the entries stay unread and
 * the *same* `Response` object may appear several times — which is what a
 * retry test wants (`scriptFetch([boom, boom, ok])`). Passing a response whose
 * body has already been consumed is rejected rather than silently yielding an
 * empty body.
 *
 * The returned stub is a `RecordingFetchStub`: `stub.calls` holds one
 * `RecordedCall` per invocation, in order.
 *
 * The throw is synchronous — not a rejected promise — so it also escapes a
 * caller that forgets to await.
 */
export function scriptFetch(responses: Response[]): RecordingFetchStub {
  const calls: RecordedCall[] = [];
  let next = 0;

  const stub = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const call = record(input, init);
    calls.push(call);
    const canned = responses[next];
    if (canned === undefined) {
      throw new ScriptFetchExhaustedError(responses.length, call.url);
    }
    next += 1;
    if (canned.bodyUsed) {
      throw new TypeError(
        `scriptFetch: response #${String(next)} has already been read; ` +
          'build a fresh Response (e.g. a second ttEnvelope call) per entry',
      );
    }
    return Promise.resolve(canned.clone());
  };

  return Object.defineProperty(stub, 'calls', {
    get: () => calls,
    enumerable: true,
  }) as RecordingFetchStub;
}

/**
 * Run `fn` with `globalThis.fetch` replaced by `stub`, restoring the real
 * `fetch` afterwards — including when `fn` throws or rejects.
 *
 * This is the async scope: unlike `withEnv`, the swap lasts until the returned
 * promise settles, so awaited work inside `fn` still sees the stub.
 */
export async function withFetch<T>(stub: FetchStub, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** The `log_id` every `ttEnvelope` response carries (CC-B9 assertions). */
export const TEST_LOG_ID = '20260101000000010204046050060A1B2C3';

/**
 * Build a TikTok `{ data, error }` envelope response (TIKTOK-API.md § 1.1).
 * Every mocked API response needs the envelope, and the transport treats
 * `error.code !== "ok"` as failure *even on HTTP 200* — which is exactly the
 * case worth testing, so the status here is always 200. A test that needs a
 * different status (or a malformed body) builds its own `Response`.
 */
export function ttEnvelope(
  data: unknown,
  error?: { code: string; message: string },
): Response {
  const body = JSON.stringify({
    data,
    error: {
      code: error?.code ?? 'ok',
      message: error?.message ?? '',
      log_id: TEST_LOG_ID,
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

/**
 * The virtual instant `mockClock()` starts at: 2026-01-01T00:00:00.000Z.
 *
 * `baselineEnv()`'s token expiries are pinned relative to it, so the default
 * clock and the default credentials are coherent by construction: the access
 * token expires 24 h into the mock's future, the refresh token a year in.
 */
export const BASELINE_NOW_MS = 1_767_225_600_000;

/** `BASELINE_NOW_MS` + 24 h — the baseline access-token expiry (CC-H2 ISO UTC). */
export const BASELINE_TOKEN_EXPIRES_AT = '2026-01-02T00:00:00.000Z';

/** `BASELINE_NOW_MS` + 365 d — the baseline refresh-token expiry. */
export const BASELINE_REFRESH_EXPIRES_AT = '2027-01-01T00:00:00.000Z';

/** The full scope set `login` requests by default (AUTH.md § 2). */
export const BASELINE_SCOPES =
  'user.info.basic,user.info.profile,user.info.stats,video.list,video.publish,video.upload';

/**
 * The minimal valid `TT_*` set: client credentials plus a complete, unexpired
 * default profile (CONFIGURATION.md § Required / § Default-profile tokens).
 * Everything else is left to its documented default, so a test that cares about
 * one setting overrides exactly that one.
 *
 * A fresh object every call — callers spread and mutate it freely.
 */
export function baselineEnv(): NodeJS.ProcessEnv {
  return {
    TT_CLIENT_KEY: 'test-client-key',
    TT_CLIENT_SECRET: 'test-client-secret',
    TT_ACCESS_TOKEN: 'test-access-token-DEFAULT',
    TT_REFRESH_TOKEN: 'test-refresh-token-DEFAULT',
    TT_OPEN_ID: 'test-open-id-DEFAULT',
    TT_SCOPES: BASELINE_SCOPES,
    TT_TOKEN_EXPIRES_AT: BASELINE_TOKEN_EXPIRES_AT,
    TT_REFRESH_EXPIRES_AT: BASELINE_REFRESH_EXPIRES_AT,
  };
}

/**
 * Run `fn` with `vars` applied to `process.env`, then restore every touched key
 * to what it was — present-with-value or absent. A `undefined` value deletes
 * the key for the duration. Restoration also happens when `fn` throws.
 *
 * Nests: an inner `withEnv` overrides only its own keys and restores the outer
 * scope's values on the way out.
 *
 * **`fn` must be synchronous.** The signature is `() => T`, and the env is
 * restored the moment `fn` *returns* — so `withEnv(vars, () => doAsync())`
 * restores the environment before the async work has read it. Read settings
 * inside the body and await outside, or await inside a body that `withFetch`
 * (the async scope) wraps.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

/** Mirrors `core/clock.ts`'s `MAX_TIMER_MS` — the signed-32-bit timer ceiling. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * `Clock` under virtual time. `advance` is the only thing that makes time pass.
 */
export interface MockClock extends Clock {
  /**
   * Move virtual time forward by `ms`, resolving every sleep that comes due in
   * deadline order (ties in the order the sleeps were requested) and draining
   * microtasks between resolutions — so a continuation that sleeps again inside
   * the window is picked up by the same `advance`. Resolves once time has
   * reached the target and nothing else is due. Never waits on real time.
   *
   * `ms` must be a finite number `>= 0`; `advance(0)` is legal and fires
   * anything already due (a `sleep(0)`).
   */
  advance(ms: number): Promise<void>;

  /** How many sleeps are currently waiting — `0` asserts "nothing pending". */
  pending(): number;

  /**
   * Reposition virtual time without firing or cancelling anything.
   *
   * `Clock.now()` explicitly does not promise monotonicity ("the system clock
   * can step backwards"), and deadline logic has to tolerate that. This is the
   * only seam that can produce the backwards step, so the tolerance is
   * testable rather than merely documented.
   */
  setNow(epochMs: number): void;
}

interface Waiter {
  readonly deadline: number;
  readonly seq: number;
  settle(): void;
}

/**
 * One turn of the event loop: `setImmediate` is a macrotask, so by the time it
 * runs the entire microtask queue — including chained `await`s in the
 * continuations just released — has drained. No wall-clock time passes.
 */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The test clock. Implements every `sleep` semantic `core/clock.ts` requires of
 * an implementation — same rejection type and same message as `systemClock`, so
 * a test asserting on either passes against both:
 *
 * - always asynchronous, even `sleep(0)`;
 * - a negative delay clamps to `0`;
 * - `NaN`, `±Infinity` and delays above 2^31-1 reject with `RangeError`;
 * - an already-aborted signal rejects immediately with `signal.reason` and
 *   registers no waiter;
 * - an abort during the sleep drops the waiter and rejects with
 *   `signal.reason`.
 *
 * The one deliberate difference: time does not pass on its own. A pending
 * `sleep` resolves only from `advance`, which is what makes the ordering
 * observable — and what turns a forgotten `advance` into a visibly hung test
 * rather than a flaky one.
 */
export function mockClock(startEpochMs: number = BASELINE_NOW_MS): MockClock {
  let current = startEpochMs;
  let nextSeq = 0;
  const waiters = new Set<Waiter>();

  async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (typeof ms !== 'number' || Number.isNaN(ms)) {
      throw new RangeError(`clock.sleep: ms must be a number, got ${String(ms)}`);
    }
    if (!Number.isFinite(ms)) {
      throw new RangeError(`clock.sleep: ms must be finite, got ${String(ms)}`);
    }
    if (ms > MAX_TIMER_MS) {
      throw new RangeError(
        `clock.sleep: ms must be <= ${String(MAX_TIMER_MS)} (2^31-1), got ${String(ms)}; ` +
          'build longer waits from repeated bounded sleeps with a re-checked deadline',
      );
    }
    if (signal?.aborted === true) throw signal.reason;

    const deadline = current + (ms > 0 ? ms : 0);
    await new Promise<void>((resolve, reject) => {
      function detach(): void {
        signal?.removeEventListener('abort', onAbort);
      }
      function onAbort(): void {
        waiters.delete(waiter);
        detach();
        // The `Clock` contract rejects with `signal.reason` verbatim: that is
        // the value `fetch` and `AbortSignal.timeout` surface and the one
        // callers match on. `abort(reason)` accepts anything, so narrowing it
        // to an `Error` here would make the mock diverge from `systemClock`.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal?.reason);
      }
      const waiter: Waiter = {
        deadline,
        seq: nextSeq++,
        settle: () => {
          detach();
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
    });
  }

  function due(target: number): Waiter | undefined {
    let best: Waiter | undefined;
    for (const waiter of waiters) {
      if (waiter.deadline > target) continue;
      if (
        best === undefined ||
        waiter.deadline < best.deadline ||
        (waiter.deadline === best.deadline && waiter.seq < best.seq)
      ) {
        best = waiter;
      }
    }
    return best;
  }

  async function advance(ms: number): Promise<void> {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new RangeError(
        `mockClock.advance: ms must be a finite number >= 0, got ${String(ms)}`,
      );
    }
    const target = current + ms;
    for (let waiter = due(target); waiter !== undefined; waiter = due(target)) {
      waiters.delete(waiter);
      // Time steps to each deadline in turn, so a continuation reading `now()`
      // sees the instant it was woken at — not the end of the whole window.
      if (waiter.deadline > current) current = waiter.deadline;
      waiter.settle();
      await drain();
    }
    current = target;
    await drain();
  }

  return {
    now: () => current,
    sleep,
    advance,
    pending: () => waiters.size,
    setNow: (epochMs: number) => {
      current = epochMs;
    },
  };
}

// ---------------------------------------------------------------------------
// filesystem
// ---------------------------------------------------------------------------

/**
 * A private scratch directory (determinism rule 3: file-system tests share
 * nothing). `dir` is fully resolved with `realpath`, so a test may compare
 * paths it built from `dir` against paths the code under test produced —
 * on macOS `os.tmpdir()` is a symlink (`/var` → `/private/var`) and the
 * unresolved form would not match.
 *
 * `cleanup()` is idempotent and never throws on a directory that is already
 * gone, so it is safe in a `finally` that may run twice.
 */
export async function fsSandbox(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const created = await mkdtemp(join(tmpdir(), 'tiktok-mcp-test-'));
  const dir = await realpath(created);
  let removed = false;
  return {
    dir,
    cleanup: async (): Promise<void> => {
      if (removed) return;
      removed = true;
      await rm(created, { recursive: true, force: true });
    },
  };
}
