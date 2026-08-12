/**
 * `uploadFile` in `src/api/upload.ts` — the chunk transfer itself
 * (TIKTOK-API.md § 4.8, CC-A3, CC-D5, CC-D6, CC-G4).
 *
 * Every bug this file exists to catch is silent. A chunk PUT has no envelope to
 * decode and no body to inspect: TikTok answers a bare status, and the only
 * evidence that the right bytes reached the right offsets is the sequence of
 * `Content-Range` headers the client emitted. A chunk sent twice, a chunk
 * skipped, a retry that re-plans its range instead of repeating it byte for
 * byte, a `201` treated as "keep going", a ladder that ends on `206` and is
 * reported as success, a `403` answered by re-initializing the publish — each
 * one looks like a working upload from the outside, and each one either corrupts
 * the video or spends a publish attempt the user never approved. The simulator
 * enforces the offsets; the cases here pin the decisions taken on each status.
 *
 * Two deliberate choices, both forced by what the source actually does:
 *
 * - **Multi-chunk plans are hand-built.** `planChunks` collapses any file below
 *   `MIN_WHOLE_BYTES` (5,000,000) into a single whole-file chunk — the override
 *   argument is ignored below that threshold — so the only way to get a real
 *   multi-chunk plan out of it is a ≥ 5 MB fixture per case, five megabytes of
 *   scratch I/O to exercise a loop that does not care how large a chunk is.
 *   `ladder()` below repeats the same floor-merge arithmetic on kilobyte-sized
 *   files. The formula itself, with TikTok's own V1–V8 vectors, is covered in
 *   `test/api-upload-plan.test.ts`; the single-chunk case here still goes
 *   through the real `planChunks`.
 * - **Some cases script bare statuses instead of using the simulator.** The
 *   simulator keeps its own accepted-byte ledger and answers `416`/`201` from
 *   it, so a *scripted* `416` resync, a `201` that arrives before the last chunk
 *   and a ladder that never reaches `201` are precisely the answers that
 *   contradict that ledger. Those cases use `putStub`, which enforces nothing
 *   and only records what it saw.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { planChunks, uploadFile, type ChunkPlan } from '../src/api/upload.js';
import { isTikTokError, type TikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import { uploadSimulator } from './harness/upload-simulator.js';
import {
  baselineEnv,
  fsSandbox,
  mockClock,
  withFetch,
  type FetchStub,
  type MockClock,
} from './helpers.js';

const NOOP_LOGGER = createLogger({ level: 'error' });

/** Allowlisted, pre-signed, and shaped like the real thing (TIKTOK-API § 4.7). */
const UPLOAD_URL =
  'https://open-upload.tiktokapis.com/upload/' +
  '?upload_id=7300000000000000000&upload_token=fake-upload-token-b7c1d9e4';

function apiCtx(
  env: Record<string, string> = {},
  clock: MockClock = mockClock(),
): ApiContext {
  return createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ ...baselineEnv(), ...env }),
    log: NOOP_LOGGER,
    clock,
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * Deterministic filler with a period that shares no factor with any chunk size
 * used here, so a truncated, duplicated, reordered or offset-by-one chunk
 * changes the bytes the simulator compares against the source.
 */
function sourceBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i % 251);
}

interface Media {
  /** Absolute path of the fixture — `uploadFile` does not confine, it just reads. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A scratch media file, removed however the body ends. No committed binaries. */
async function withMedia<T>(
  spec: { size: number; name?: string },
  fn: (media: Media) => Promise<T>,
): Promise<T> {
  const sandbox = await fsSandbox();
  try {
    const path = join(sandbox.dir, spec.name ?? 'clip.mp4');
    const bytes = sourceBytes(spec.size);
    await writeFile(path, bytes);
    return await fn({ path, bytes });
  } finally {
    await sandbox.cleanup();
  }
}

/**
 * The plan `planChunks` would produce for `fileSize` at `chunkSize` if the
 * whole-file rule below 5,000,000 bytes did not override the split — same
 * floor-merge, so the final chunk absorbs the remainder.
 */
function ladder(fileSize: number, chunkSize: number): ChunkPlan {
  const totalChunkCount = Math.floor(fileSize / chunkSize);
  const chunks = Array.from({ length: totalChunkCount }, (_, index) => {
    const start = index * chunkSize;
    const end = index === totalChunkCount - 1 ? fileSize - 1 : start + chunkSize - 1;
    return { index, start, end, size: end - start + 1 };
  });
  return { chunkSize, totalChunkCount, chunks };
}

// ---------------------------------------------------------------------------
// stubs
// ---------------------------------------------------------------------------

function lowerHeaders(raw: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  const entries: [string, string | readonly string[] | undefined][] = Array.isArray(raw)
    ? raw.map((pair) => [pair[0] ?? '', pair[1]])
    : Object.entries(raw);
  for (const [key, value] of entries) {
    if (key === '' || value === undefined) continue;
    out[key.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
  }
  return out;
}

/**
 * The bytes of a request body. Draining matters even where the content is
 * ignored: an unread `fs.createReadStream` keeps its file descriptor open.
 */
async function drainBody(body: unknown): Promise<Uint8Array> {
  if (!(body instanceof ReadableStream)) return new Uint8Array(0);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const parts: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) parts.push(Buffer.from(value));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** What the real endpoint sends back: a status, and no JSON body. */
function bare(status: number, headers?: Record<string, string>): Response {
  return new Response(null, headers === undefined ? { status } : { status, headers });
}

/** One PUT a hand-written stub observed. */
interface SeenPut {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentRange: string | undefined;
  readonly bodyBytes: number;
}

/**
 * A stub that answers whatever the script says and enforces nothing.
 *
 * Needed wherever the simulator's own ledger would contradict the answer under
 * test: an injected `416` resync, a `201` before the last chunk, a ladder that
 * only ever returns `206`, and the cases that must prove *zero* PUTs happened.
 */
function putStub(answer: (ordinal: number, put: SeenPut) => Response | Error): {
  fetch: FetchStub;
  puts: SeenPut[];
} {
  const puts: SeenPut[] = [];
  return {
    puts,
    fetch: async (input, init) => {
      const headers = lowerHeaders(init?.headers);
      const body = await drainBody(init?.body);
      const put: SeenPut = {
        url: typeof input === 'string' ? input : input.toString(),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers,
        contentRange: headers['content-range'],
        bodyBytes: body.length,
      };
      puts.push(put);
      const outcome = answer(puts.length, put);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

/** Wrap a stub to record the request headers it was called with, in order. */
function recordHeaders(inner: FetchStub): {
  fetch: FetchStub;
  headers: Record<string, string>[];
} {
  const headers: Record<string, string>[] = [];
  return {
    headers,
    fetch: async (input, init) => {
      headers.push(lowerHeaders(init?.headers));
      return await inner(input, init);
    },
  };
}

// ---------------------------------------------------------------------------
// assertion plumbing
// ---------------------------------------------------------------------------

/**
 * Await `pending` while stepping virtual time forward.
 *
 * `mockClock` never moves on its own and the chunk retry loop awaits
 * `clock.sleep(backoff)`, so a retry case that does not step time hangs.
 * Only the retry cases need this; the per-request timeout waiter is cancelled
 * when the request settles, so everything else can simply be awaited.
 */
async function runVirtual<T>(clock: MockClock, pending: Promise<T>): Promise<T> {
  let done = false;
  const settled = pending.finally(() => {
    done = true;
  });
  settled.catch(() => undefined);
  // The budget is wall-clock, not a step count. `advance` yields to the event
  // loop once per step, so a fixed number of steps is only a few real
  // milliseconds — less than a loaded machine needs to return a single file
  // read, and the call would then be failed for someone else's I/O contention
  // (the coverage run puts one instrumented process per test file on the box).
  const giveUpAt = Date.now() + 20_000;
  while (!done && Date.now() < giveUpAt) await clock.advance(500);
  assert.ok(done, 'virtual time ran out before the call settled');
  return await settled;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the upload to reject, but it resolved');
}

function ttError(error: unknown): TikTokError {
  assert.equal(
    isTikTokError(error),
    true,
    `expected a TikTokError, got ${String(error)}`,
  );
  return error as TikTokError;
}

/** The verbatim `REPLAN` remediation from `src/api/upload.ts`. */
const NO_AUTO_REINIT = 'must not be re-initialized automatically';

// ---------------------------------------------------------------------------
// the happy paths
// ---------------------------------------------------------------------------

test('a single-chunk plan is one PUT carrying the whole-file Content-Range', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({ source: media.bytes, uploadUrl: UPLOAD_URL });
    const progress: [number, number][] = [];

    await withFetch(sim.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: planChunks(media.bytes.length),
        uploadUrl: UPLOAD_URL,
        onProgress: (index, totalChunks) => progress.push([index, totalChunks]),
        random: () => 0,
      }),
    );

    sim.assertComplete();
    assert.equal(sim.puts.length, 1);
    assert.equal(sim.puts[0]?.contentRange, 'bytes 0-24999/25000');
    assert.equal(sim.puts[0]?.bodyBytes, 25_000);
    assert.deepEqual(progress, [[0, 1]]);
  });
});

test('a multi-chunk plan is PUT strictly in order and the bytes survive intact', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({ source: media.bytes, uploadUrl: UPLOAD_URL });
    const progress: [number, number][] = [];

    await withFetch(sim.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        // floor-merge: 2 chunks, the last one 15,000 bytes wide.
        plan: ladder(25_000, 10_000),
        uploadUrl: UPLOAD_URL,
        onProgress: (index, totalChunks) => progress.push([index, totalChunks]),
        random: () => 0,
      }),
    );

    // assertComplete() is where byte-equality with the source is checked.
    sim.assertComplete();
    assert.deepEqual(
      sim.puts.map((put) => put.contentRange),
      ['bytes 0-9999/25000', 'bytes 10000-24999/25000'],
    );
    assert.deepEqual(
      sim.puts.map((put) => put.bodyBytes),
      [10_000, 15_000],
    );
    assert.deepEqual(progress, [
      [0, 2],
      [1, 2],
    ]);
  });
});

test('cc-a3 a chunk PUT carries no Authorization header and asks for no token', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({ source: media.bytes, uploadUrl: UPLOAD_URL });
    const seen = recordHeaders(sim.fetch);
    let refreshes = 0;
    const ctx = createApiContext({
      profile: 'DEFAULT',
      settings: loadSettings(baselineEnv()),
      log: NOOP_LOGGER,
      clock: mockClock(),
      refresh: () => {
        refreshes += 1;
        return Promise.resolve('test-access-token-DEFAULT');
      },
    });

    await withFetch(seen.fetch, () =>
      uploadFile(ctx, {
        filePath: media.path,
        plan: ladder(25_000, 10_000),
        uploadUrl: UPLOAD_URL,
        random: () => 0,
      }),
    );

    sim.assertComplete();
    assert.equal(seen.headers.length, 2);
    for (const headers of seen.headers) {
      // The upload_token in the URL is the credential; the bearer belongs to a
      // different origin and sending it here would leak it.
      assert.equal(headers['authorization'], undefined);
    }
    assert.equal(refreshes, 0, 'an upload never refreshes: it survives token expiry');
  });
});

test('the chunk Content-Type is derived from the file extension', async () => {
  await withMedia({ size: 25_000, name: 'clip.mov' }, async (media) => {
    const sim = uploadSimulator({ source: media.bytes, uploadUrl: UPLOAD_URL });
    const seen = recordHeaders(sim.fetch);

    await withFetch(seen.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: planChunks(media.bytes.length),
        uploadUrl: UPLOAD_URL,
        random: () => 0,
      }),
    );

    sim.assertComplete();
    assert.equal(seen.headers[0]?.['content-type'], 'video/quicktime');
  });
});

test('an explicit contentType overrides the extension-derived one', async () => {
  await withMedia({ size: 25_000, name: 'clip.mov' }, async (media) => {
    const sim = uploadSimulator({ source: media.bytes, uploadUrl: UPLOAD_URL });
    const seen = recordHeaders(sim.fetch);

    await withFetch(seen.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: planChunks(media.bytes.length),
        uploadUrl: UPLOAD_URL,
        contentType: 'video/webm',
        random: () => 0,
      }),
    );

    sim.assertComplete();
    assert.equal(seen.headers[0]?.['content-type'], 'video/webm');
  });
});

// ---------------------------------------------------------------------------
// retries (CC-D6)
// ---------------------------------------------------------------------------

test('cc-d6 a 500 on chunk 2 re-puts the identical byte range and completes', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const clock = mockClock();
    const sim = uploadSimulator({
      source: media.bytes,
      uploadUrl: UPLOAD_URL,
      inject: { 2: { status: 500 } },
    });

    await withFetch(sim.fetch, () =>
      runVirtual(
        clock,
        uploadFile(apiCtx({}, clock), {
          filePath: media.path,
          plan: ladder(25_000, 10_000),
          uploadUrl: UPLOAD_URL,
          random: () => 0,
        }),
      ),
    );

    sim.assertComplete();
    assert.equal(sim.puts.length, 3);
    assert.deepEqual(
      sim.puts.map((put) => put.answered),
      [206, 500, 201],
    );
    // The retry is safe only because the range is byte-identical (CC-D6).
    assert.equal(sim.puts[2]?.contentRange, sim.puts[1]?.contentRange);
    assert.equal(sim.puts[2]?.contentRange, 'bytes 10000-24999/25000');
  });
});

test('cc-d6 a chunk that keeps failing stops after 1 + TT_CHUNK_RETRIES attempts', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const clock = mockClock();
    const sim = uploadSimulator({
      source: media.bytes,
      uploadUrl: UPLOAD_URL,
      inject: { 1: { status: 500 }, 2: { status: 500 } },
    });

    const error = ttError(
      await withFetch(sim.fetch, () =>
        rejection(
          runVirtual(
            clock,
            uploadFile(apiCtx({ TT_CHUNK_RETRIES: '1' }, clock), {
              filePath: media.path,
              plan: planChunks(media.bytes.length),
              uploadUrl: UPLOAD_URL,
              random: () => 0,
            }),
          ),
        ),
      ),
    );

    assert.equal(error.kind, 'network');
    assert.equal(error.code, 'upload_interrupted');
    // The ordinal and the byte range are what makes the failure actionable.
    assert.match(error.message, /chunk 1\/1 \(bytes 0-24999\)/);
    assert.match(error.message, /2 attempt\(s\) failed/);
    assert.ok(error.remediation?.includes(NO_AUTO_REINIT));
    assert.equal(sim.puts.length, 2, 'exactly 1 + TT_CHUNK_RETRIES attempts, no more');
  });
});

// ---------------------------------------------------------------------------
// terminal statuses (CC-D5)
// ---------------------------------------------------------------------------

test('cc-d5 a 403 is terminal, names the expired URL and forbids an auto re-init', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({
      source: media.bytes,
      uploadUrl: UPLOAD_URL,
      inject: { 1: { status: 403 } },
    });

    const error = ttError(
      await withFetch(sim.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: ladder(25_000, 10_000),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /HTTP 403 — the upload URL expired/);
    assert.ok(error.remediation?.includes(NO_AUTO_REINIT));
    assert.equal(sim.puts.length, 1, 'a terminal 4xx is never retried');
  });
});

test('cc-d5 a 404 is terminal and says TikTok no longer knows the upload task', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({
      source: media.bytes,
      uploadUrl: UPLOAD_URL,
      inject: { 1: { status: 404 } },
    });

    const error = ttError(
      await withFetch(sim.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: planChunks(media.bytes.length),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /HTTP 404 — TikTok no longer knows this upload task/);
    assert.ok(error.remediation?.includes(NO_AUTO_REINIT));
    assert.equal(sim.puts.length, 1);
  });
});

test('cc-d5 a 400 is reported as a server bug, not as a user error', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({
      source: media.bytes,
      uploadUrl: UPLOAD_URL,
      inject: { 1: { status: 400 } },
    });

    const error = ttError(
      await withFetch(sim.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: planChunks(media.bytes.length),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /HTTP 400 — the chunk headers did not match the bytes/);
    assert.ok(error.remediation?.includes('This is a server bug, not a user error'));
    assert.ok(error.remediation?.includes('report it with the byte range above'));
    // Distinct from every other terminal status: a 400 is ours to fix.
    assert.equal(error.remediation?.includes(NO_AUTO_REINIT), false);
    assert.equal(sim.puts.length, 1);
  });
});

test('cc-d5 an undocumented 4xx is terminal with the bare status in the detail', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({
      source: media.bytes,
      uploadUrl: UPLOAD_URL,
      inject: { 1: { status: 409 } },
    });

    const error = ttError(
      await withFetch(sim.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: planChunks(media.bytes.length),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /: HTTP 409$/);
    assert.ok(error.remediation?.includes(NO_AUTO_REINIT));
    assert.equal(sim.puts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 416 resync (CC-D6) — scripted, because the simulator's ledger is the thing
// a resync has to contradict.
// ---------------------------------------------------------------------------

test('cc-d6 a 416 reporting the current chunk as done advances past it', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub((ordinal) =>
      ordinal === 1 ? bare(416, { 'content-range': 'bytes 0-9999/25000' }) : bare(201),
    );

    await withFetch(stub.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: ladder(25_000, 10_000),
        uploadUrl: UPLOAD_URL,
        random: () => 0,
      }),
    );

    assert.deepEqual(
      stub.puts.map((put) => put.contentRange),
      ['bytes 0-9999/25000', 'bytes 10000-24999/25000'],
    );
  });
});

test('cc-d6 a 416 whose progress is the next chunk start resumes at that chunk', async () => {
  await withMedia({ size: 30_000 }, async (media) => {
    // `10000` read as a byte COUNT — the reading `status/fetch` uses.
    const stub = putStub((ordinal) =>
      ordinal === 3
        ? bare(416, { 'content-range': 'bytes 0-10000/30000' })
        : bare(ordinal === 5 ? 201 : 206),
    );
    const progress: number[] = [];

    await withFetch(stub.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: ladder(30_000, 10_000),
        uploadUrl: UPLOAD_URL,
        onProgress: (index) => progress.push(index),
        random: () => 0,
      }),
    );

    assert.deepEqual(
      stub.puts.map((put) => put.contentRange),
      [
        'bytes 0-9999/30000',
        'bytes 10000-19999/30000',
        'bytes 20000-29999/30000',
        'bytes 10000-19999/30000',
        'bytes 20000-29999/30000',
      ],
    );
    assert.deepEqual(progress, [0, 1, 1, 2]);
  });
});

test('cc-d6 a 416 whose progress is the next chunk start minus one resumes there too', async () => {
  await withMedia({ size: 30_000 }, async (media) => {
    // `9999` read as a last-byte INDEX — the reading the Content-Range header
    // suggests. Both readings must land on the same chunk (probe P-11).
    const stub = putStub((ordinal) =>
      ordinal === 3
        ? bare(416, { 'content-range': 'bytes 0-9999/30000' })
        : bare(ordinal === 5 ? 201 : 206),
    );

    await withFetch(stub.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: ladder(30_000, 10_000),
        uploadUrl: UPLOAD_URL,
        random: () => 0,
      }),
    );

    assert.equal(stub.puts.length, 5);
    assert.equal(stub.puts[3]?.contentRange, 'bytes 10000-19999/30000');
  });
});

test('cc-d6 a 416 pointing back at the rejected range is a contradiction, not a resync', async () => {
  await withMedia({ size: 30_000 }, async (media) => {
    const stub = putStub((ordinal) =>
      ordinal === 2 ? bare(416, { 'content-range': 'bytes 0-10000/30000' }) : bare(206),
    );

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: ladder(30_000, 10_000),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /points back at the same range/);
    assert.equal(stub.puts.length, 2, 're-sending it would 416 forever');
  });
});

test('cc-d6 a 416 reporting progress inside a chunk is terminal and names the count', async () => {
  await withMedia({ size: 30_000 }, async (media) => {
    const stub = putStub((ordinal) =>
      ordinal === 2 ? bare(416, { 'content-range': 'bytes 0-12345/30000' }) : bare(206),
    );

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: ladder(30_000, 10_000),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /reports 12345 bytes of progress/);
    assert.match(error.message, /not a chunk boundary of this plan/);
    assert.equal(stub.puts.length, 2, 'a plan cannot resume inside a chunk');
  });
});

test('cc-d6 a 416 with no Content-Range is terminal: there is nothing to resync from', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub(() => bare(416));

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: ladder(25_000, 10_000),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /no progress to resync from/);
    assert.match(error.message, /chunk 1\/2 \(bytes 0-9999\)/);
    assert.equal(stub.puts.length, 1);
  });
});

test('cc-d6 a 416 ping-pong is failed once the resync budget is spent, not spun on', async () => {
  await withMedia({ size: 30_000 }, async (media) => {
    // Chunk 1 is told "you are at 20000", chunk 2 is told "you are at 0", for
    // ever: progress that oscillates without the upload advancing.
    const stub = putStub((_ordinal, put) =>
      put.contentRange === 'bytes 0-9999/30000'
        ? bare(416, { 'content-range': 'bytes 0-20000/30000' })
        : bare(416, { 'content-range': 'bytes 0-0/30000' }),
    );

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: ladder(30_000, 10_000),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    assert.match(error.message, /rejected the byte range 4 times without the upload/);
    // One resync per chunk is the budget; the fourth ends it.
    assert.equal(stub.puts.length, 4);
  });
});

// ---------------------------------------------------------------------------
// completion signalling (§ 4.8)
// ---------------------------------------------------------------------------

test('a 201 before the last chunk ends the upload instead of writing to a closed one', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub(() => bare(201));
    const progress: [number, number][] = [];

    await withFetch(stub.fetch, () =>
      uploadFile(apiCtx(), {
        filePath: media.path,
        plan: ladder(25_000, 10_000),
        uploadUrl: UPLOAD_URL,
        onProgress: (index, totalChunks) => progress.push([index, totalChunks]),
        random: () => 0,
      }),
    );

    assert.equal(stub.puts.length, 1, 'a further PUT would write to a closed upload');
    assert.deepEqual(progress, [[0, 2]]);
  });
});

test('every chunk accepted with no 201 is an interrupted upload, not a success', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub(() => bare(206));

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: ladder(25_000, 10_000),
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'upload_interrupted');
    // Reporting success here would hand back a publish_id stuck in PROCESSING.
    assert.match(
      error.message,
      /All 2 chunks were accepted but TikTok never confirmed the transfer/,
    );
    assert.match(error.message, /no HTTP 201 after bytes 10000-24999/);
    assert.ok(error.remediation?.includes(NO_AUTO_REINIT));
    assert.equal(stub.puts.length, 2);
  });
});

// ---------------------------------------------------------------------------
// abort (CC-G4)
// ---------------------------------------------------------------------------

test('cc-g4 an already-aborted signal rejects with the reason verbatim and sends nothing', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub(() => bare(201));
    const controller = new AbortController();
    const reason = new Error('cancelled before the first chunk');
    controller.abort(reason);

    const error = await withFetch(stub.fetch, () =>
      rejection(
        uploadFile(apiCtx(), {
          filePath: media.path,
          plan: planChunks(media.bytes.length),
          uploadUrl: UPLOAD_URL,
          signal: controller.signal,
          random: () => 0,
        }),
      ),
    );

    assert.equal(error, reason, "an abort is the caller's own reason, not a TikTokError");
    assert.equal(isTikTokError(error), false);
    assert.equal(stub.puts.length, 0, 'not a single byte leaves the process');
  });
});

test('cc-g4 an abort between chunks unwinds verbatim and stops the ladder', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const sim = uploadSimulator({ source: media.bytes, uploadUrl: UPLOAD_URL });
    const controller = new AbortController();
    const reason = new Error('cancelled mid-upload');

    const error = await withFetch(sim.fetch, () =>
      rejection(
        uploadFile(apiCtx(), {
          filePath: media.path,
          plan: ladder(25_000, 10_000),
          uploadUrl: UPLOAD_URL,
          signal: controller.signal,
          onProgress: (index) => {
            if (index === 0) controller.abort(reason);
          },
          random: () => 0,
        }),
      ),
    );

    assert.equal(error, reason);
    assert.equal(isTikTokError(error), false);
    assert.equal(sim.puts.length, 1, 'the second chunk is never sent');
  });
});

test('cc-g4 an abort during a chunk PUT is not re-labelled as an upload failure', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const controller = new AbortController();
    const reason = new Error('cancelled while the chunk was in flight');
    const stub = putStub(() => {
      controller.abort(reason);
      return reason;
    });

    const error = await withFetch(stub.fetch, () =>
      rejection(
        uploadFile(apiCtx(), {
          filePath: media.path,
          plan: planChunks(media.bytes.length),
          uploadUrl: UPLOAD_URL,
          signal: controller.signal,
          random: () => 0,
        }),
      ),
    );

    assert.equal(error, reason);
    assert.equal(isTikTokError(error), false, 'an abort is not an outcome to wrap');
    assert.equal(stub.puts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// refusals before the wire
// ---------------------------------------------------------------------------

test('a non-allowlisted upload_url is refused before any request is made', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub(() => bare(201));

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: planChunks(media.bytes.length),
            // A suffix that `endsWith` would have accepted.
            uploadUrl:
              'https://open-upload.tiktokapis.com.attacker.tld/upload/?upload_token=x',
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'egress_blocked');
    assert.equal(stub.puts.length, 0);
  });
});

test('an empty chunk plan is rejected before the first PUT', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const stub = putStub(() => bare(201));

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: { chunkSize: 25_000, totalChunkCount: 1, chunks: [] },
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'invalid_params');
    assert.match(error.message, /the chunk plan is empty/);
    assert.equal(stub.puts.length, 0);
  });
});

test('a plan with fewer chunks than it declares fails loudly mid-ladder', async () => {
  await withMedia({ size: 25_000 }, async (media) => {
    const full = ladder(25_000, 10_000);
    const truncated: ChunkPlan = { ...full, chunks: full.chunks.slice(0, 1) };
    const stub = putStub(() => bare(206));

    const error = ttError(
      await withFetch(stub.fetch, () =>
        rejection(
          uploadFile(apiCtx(), {
            filePath: media.path,
            plan: truncated,
            uploadUrl: UPLOAD_URL,
            random: () => 0,
          }),
        ),
      ),
    );

    assert.equal(error.code, 'invalid_params');
    assert.match(error.message, /chunk 1 is missing from the plan/);
    assert.equal(stub.puts.length, 1);
  });
});
