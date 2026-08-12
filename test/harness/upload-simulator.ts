/**
 * Upload simulator (TESTING.md § Extended harness).
 *
 * A scriptable dispatcher for the chunked `upload_url` PUT protocol
 * (TIKTOK-API.md § 1.3 / § 4.8), plugged in via `withFetch`. No real sockets: it
 * is a `FetchStub` that answers with the bare status codes the real upload
 * endpoint answers with (206 mid-upload, 201 on the last chunk, 4xx/5xx/416 on
 * failure) and no JSON body.
 *
 * The simulator is deliberately strict, because the interesting bugs on this
 * path are silent. One rule — **a chunk's first byte must equal the number of
 * bytes accepted so far** — enforces sequential, contiguous and gap-free
 * upload at once: an out-of-order chunk, a re-sent chunk that should not have
 * been re-sent, a skipped chunk and an overlapping chunk all violate it.
 *
 * `assertComplete()` is where a test's expectations are checked, and it checks
 * the things an "it returned 201" assertion misses:
 *
 * - the concatenated accepted bodies are byte-equal to the source file, so a
 *   truncated, duplicated or reordered chunk cannot pass;
 * - no PUT arrived after the final 201;
 * - no PUT carried an `Authorization` header — the pre-signed `upload_url`
 *   already authorizes the request, and sending the bearer to it would leak the
 *   access token to a different origin;
 * - every injected failure was actually reached, so a test that expects a retry
 *   *proves* the retry happened instead of passing because the client sailed
 *   through on the first try.
 *
 * A `hang` injection never answers, which is how the client's own timeout
 * (`TT_UPLOAD_TIMEOUT_MS`) is driven: pair it with `mockClock().advance(...)`
 * and an `AbortSignal`. The hang honours `init.signal`, so an aborted request
 * rejects with `signal.reason` exactly as `fetch` would.
 */

import assert from 'node:assert/strict';

import type { FetchStub } from '../helpers.js';

/** A failure to answer a PUT with, instead of accepting the chunk. */
export type InjectedOutcome =
  /**
   * Answer with this bare HTTP status (500, 403, 416, 400 …). `headers` is for
   * the one status that carries information the client acts on: a `416` whose
   * `Content-Range: bytes 0-{UPLOADED}/{TOTAL}` tells the client where TikTok
   * actually is, which is the only input a resync has.
   */
  | { readonly status: number; readonly headers?: Readonly<Record<string, string>> }
  /** Never answer, so the client's own timeout has to fire. */
  | { readonly hang: true };

export interface UploadSimulatorOptions {
  /** The exact bytes the client is expected to upload, in full. */
  readonly source: Uint8Array;
  /** The pre-signed URL the client must PUT to; any other target is a failure. */
  readonly uploadUrl: string;
  /**
   * Failures keyed by **1-based PUT ordinal** — `{ 1: { status: 500 } }` fails
   * the first PUT. Any ordinal not listed is accepted. Injected chunks do not
   * advance the accepted-byte count, so the client is expected to re-send the
   * same range.
   */
  readonly inject?: Readonly<Record<number, InjectedOutcome>>;
}

/** One PUT the simulator observed. */
export interface RecordedPut {
  /** 1-based ordinal, matching the `inject` keys. */
  readonly ordinal: number;
  readonly url: string;
  readonly method: string;
  readonly contentRange: string | undefined;
  /** Parsed range, or `undefined` when the header was missing or malformed. */
  readonly range: { first: number; last: number; total: number } | undefined;
  readonly bodyBytes: number;
  /** The status answered, or `'hang'` when the PUT was never answered. */
  readonly answered: number | 'hang';
}

export interface UploadSimulator {
  /** Hand this to `withFetch`. */
  readonly fetch: FetchStub;
  /** Every PUT so far, in order. */
  readonly puts: readonly RecordedPut[];
  /** Bytes accepted so far — the next chunk's expected first byte. */
  readonly accepted: number;
  /**
   * Verify the whole interaction. Throws an assertion error listing *every*
   * problem found, so one run tells the whole story rather than the first
   * symptom.
   */
  assertComplete(): void;
}

const RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/;

function parseRange(header: string | undefined): RecordedPut['range'] {
  if (header === undefined) return undefined;
  const match = RANGE_PATTERN.exec(header.trim());
  if (match === null) return undefined;
  return {
    first: Number(match[1]),
    last: Number(match[2]),
    total: Number(match[3]),
  };
}

function headerLookup(init: RequestInit | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const raw = init?.headers;
  if (raw === undefined) return undefined;
  if (raw instanceof Headers) return raw.get(wanted) ?? undefined;
  if (Array.isArray(raw)) {
    for (const pair of raw) {
      if (pair[0]?.toLowerCase() === wanted) return pair[1];
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return undefined;
}

/**
 * The bytes of a request body, draining a stream if that is what it is.
 *
 * A streamed body is the production shape, not an exotic one: a chunk can be
 * 128 MB, so the client reads it off the disk rather than into a buffer. The
 * simulator drains it — including on the `hang` path, where an undrained
 * `fs.createReadStream` would keep its file descriptor (and the test runner's
 * event loop) alive.
 */
async function toBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof ReadableStream) {
    const parts: Uint8Array[] = [];
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) parts.push(value);
    }
    return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError(
    'uploadSimulator: a chunk body must be bytes, a string or a ReadableStream, got ' +
      Object.prototype.toString.call(body),
  );
}

function bare(status: number, headers?: Readonly<Record<string, string>>): Response {
  // The real endpoint answers chunk PUTs with a status and no JSON body.
  return new Response(null, headers === undefined ? { status } : { status, headers });
}

/**
 * Build a simulator for one upload of `source` to `uploadUrl`.
 *
 * ```ts
 * const sim = uploadSimulator({ source, uploadUrl, inject: { 2: { status: 500 } } });
 * await withFetch(sim.fetch, () => uploadChunks(...));
 * sim.assertComplete();   // proves the 500 was hit *and* the bytes still match
 * ```
 */
export function uploadSimulator(opts: UploadSimulatorOptions): UploadSimulator {
  const { source, uploadUrl } = opts;
  const inject = opts.inject ?? {};
  const injectedOrdinals = Object.keys(inject).map(Number);

  const puts: RecordedPut[] = [];
  const problems: string[] = [];
  const reached = new Set<number>();
  const accepted: Uint8Array[] = [];
  let acceptedBytes = 0;
  let finalStatusSeen = false;

  const stub: FetchStub = async (input, init) => {
    const ordinal = puts.length + 1;
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const contentRange = headerLookup(init, 'content-range');
    const range = parseRange(contentRange);
    const body = await toBytes(init?.body);

    const answer = (answered: number | 'hang'): void => {
      puts.push({
        ordinal,
        url,
        method,
        contentRange,
        range,
        bodyBytes: body.length,
        answered,
      });
    };

    if (url !== uploadUrl) {
      problems.push(`put #${String(ordinal)}: went to ${url}, expected ${uploadUrl}`);
    }
    if (method !== 'PUT') {
      problems.push(`put #${String(ordinal)}: method was ${method}, expected PUT`);
    }
    if (headerLookup(init, 'authorization') !== undefined) {
      // The upload URL is pre-signed; the bearer belongs to open.tiktokapis.com
      // only. Sending it here hands the access token to a different origin.
      problems.push(`put #${String(ordinal)}: carried an Authorization header`);
    }
    if (finalStatusSeen) {
      problems.push(`put #${String(ordinal)}: arrived after the final 201`);
      answer(400);
      return bare(400);
    }

    const injected = inject[ordinal];
    if (injected !== undefined) {
      reached.add(ordinal);
      if ('hang' in injected) {
        answer('hang');
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) return;
          if (signal.aborted) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              // Mirrors `fetch`: an aborted request rejects with signal.reason.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      answer(injected.status);
      return bare(injected.status, injected.headers);
    }

    // The one rule that makes the upload sequential, contiguous and gap-free.
    if (range === undefined) {
      problems.push(
        `put #${String(ordinal)}: Content-Range missing or malformed (${String(contentRange)})`,
      );
    } else {
      if (range.total !== source.length) {
        problems.push(
          `put #${String(ordinal)}: declared total ${String(range.total)}, ` +
            `source is ${String(source.length)} bytes`,
        );
      }
      if (range.first !== acceptedBytes) {
        problems.push(
          `put #${String(ordinal)}: starts at byte ${String(range.first)}, ` +
            `but ${String(acceptedBytes)} bytes have been accepted`,
        );
        answer(416);
        return bare(416, {
          // TikTok documents this as `bytes 0-{UPLOADED_BYTES}/{TOTAL}`, so the
          // literal byte COUNT goes where a last-byte index would normally sit.
          // That off-by-one ambiguity is real and unresolved (probe P-11), and
          // reproducing it verbatim is the point: a client that assumes one
          // reading must be caught here rather than in production.
          'content-range': `bytes 0-${String(acceptedBytes)}/${String(source.length)}`,
        });
      }
      if (range.last !== range.first + body.length - 1) {
        problems.push(
          `put #${String(ordinal)}: range ${String(range.first)}-${String(range.last)} ` +
            `does not match a ${String(body.length)}-byte body`,
        );
      }
    }

    accepted.push(body);
    acceptedBytes += body.length;
    const status = acceptedBytes >= source.length ? 201 : 206;
    if (status === 201) finalStatusSeen = true;
    answer(status);
    return bare(status);
  };

  return {
    fetch: stub,
    puts,
    get accepted() {
      return acceptedBytes;
    },
    assertComplete: () => {
      const missed = injectedOrdinals
        .filter((ordinal) => !reached.has(ordinal))
        .sort((a, b) => a - b);
      const all = [...problems];
      if (missed.length > 0) {
        all.push(
          `injected failures at put(s) ${missed.join(', ')} were never reached — ` +
            'the client did not make as many requests as the test expects',
        );
      }
      if (!finalStatusSeen) {
        all.push(
          `the upload never completed: ${String(acceptedBytes)} of ` +
            `${String(source.length)} bytes accepted, no 201 issued`,
        );
      }
      const uploaded = Buffer.concat(accepted.map((chunk) => Buffer.from(chunk)));
      if (!uploaded.equals(Buffer.from(source))) {
        all.push(
          `the uploaded bytes differ from the source (${String(uploaded.length)} ` +
            `vs ${String(source.length)} bytes)`,
        );
      }
      assert.deepEqual(
        all,
        [],
        `upload simulator found ${String(all.length)} problem(s)`,
      );
    },
  };
}
