/**
 * FILE_UPLOAD: the chunk planner, the media-root gate and the chunk transfer
 * (CONTRACTS.md § `api/upload.ts`, TIKTOK-API.md §§ 4.6–4.8, CC-D1–D9, CC-A3,
 * CC-G4).
 *
 * Three responsibilities, deliberately separable:
 *
 * - {@link planChunks} is **pure**. It turns a byte count into the exact
 *   `Content-Range` ladder TikTok expects, in decimal megabytes (TikTok's own
 *   worked example uses 10,000,000, not 10 MiB — SYNTHESIS § 2.4). The rule
 *   that trips everyone is the floor-merge: `total_chunk_count` is
 *   `floor(size / chunk_size)`, so the *final* chunk absorbs the remainder and
 *   may legally be larger than the declared `chunk_size`.
 * - {@link resolveMediaFile} / {@link verifyMediaFile} are the CC-D8 confinement
 *   and the CC-D3/CC-D4 re-stat. They live here rather than in the tool layer
 *   because both publish tools that can read a local file would otherwise carry
 *   a copy, and a divergent copy of a containment check is a vulnerability.
 * - {@link uploadFile} moves the bytes. It streams each chunk straight off the
 *   disk, so a 128 MB final chunk never becomes a 128 MB buffer, and it owns
 *   the per-chunk retry loop itself: `core/http`'s `putChunk` cannot replay a
 *   stream, so the byte range — which is what makes a re-PUT safe (CC-D6) — is
 *   re-read here and handed to a fresh call.
 *
 * The credential rule is inherited, not re-implemented: a chunk PUT carries no
 * `Authorization` header at all, because the `upload_token` inside the URL is
 * the credential (TIKTOK-API § 4.7). One consequence is worth stating out loud:
 * a long upload survives access-token expiry (CC-A3), so nothing here refreshes
 * anything mid-transfer.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only
 * (plus the shared api context).
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';

import { isTikTokError, TikTokError } from '../core/errors.js';
import { assertAllowedUrl, putChunk } from '../core/http.js';
import type { ApiContext } from './context.js';

// ---------------------------------------------------------------------------
// Constants (TIKTOK-API.md § 4.6 — decimal bytes, not KiB/MiB)
// ---------------------------------------------------------------------------

/** Below this, TikTok mandates a single whole-file chunk. */
export const MIN_WHOLE_BYTES = 5_000_000;

/**
 * The chunk size this server declares. Decimal on purpose: it is under the
 * 64 MB ceiling on either reading (64,000,000 < 67,108,864), and it keeps the
 * merged final chunk at most 127,999,999 bytes — under the 128 MB cap on either
 * reading as well.
 */
export const CHUNK_SIZE_BYTES = 64_000_000;

/** 4 GiB. Rejected here rather than upstream, before an init is spent. */
export const MAX_FILE_BYTES = 4_294_967_296;

/** Upstream's hard bound. 4 GiB / 64,000,000 is 67 chunks, so it is slack. */
export const MAX_CHUNK_COUNT = 1000;

/** `CHUNK_SIZE_BYTES + (CHUNK_SIZE_BYTES - 1)` — the widest a merge can make it. */
export const MAX_FINAL_CHUNK_BYTES = 127_999_999;

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

/** One PUT: `end` is **inclusive**, matching `Content-Range`'s last byte. */
export interface ChunkRange {
  index: number;
  start: number;
  end: number;
  size: number;
}

export interface ChunkPlan {
  chunkSize: number;
  totalChunkCount: number;
  chunks: ChunkRange[];
}

function invalid(message: string, remediation?: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'invalid_params',
    message,
    ...(remediation === undefined ? {} : { remediation }),
  });
}

/**
 * The `Content-Range` ladder for a file of `fileSize` bytes.
 *
 * PURE — no clock, no filesystem, no network. Vectors V1–V8 in TIKTOK-API.md
 * § 4.6 are the shared test fixture.
 *
 * `chunkSizeOverride` exists for exactly one reason: TikTok's own worked
 * example (V3 — 50,000,123 bytes split at 10,000,000 into 5 chunks) is not
 * reachable from `min(size, CHUNK_SIZE_BYTES)`, which would answer with one
 * chunk. Keeping the example expressible keeps the *formula* under test rather
 * than only this server's choice of constant. Production always omits it, and
 * an override is validated exactly like the computed value.
 */
export function planChunks(fileSize: number, chunkSizeOverride?: number): ChunkPlan {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw invalid(
      `planChunks: fileSize must be a positive integer, got ${String(fileSize)}`,
    );
  }
  if (fileSize > MAX_FILE_BYTES) {
    throw new TikTokError({
      kind: 'validation',
      code: 'file_too_large',
      message:
        `The file is ${String(fileSize)} bytes; TikTok's maximum is ` +
        `${String(MAX_FILE_BYTES)}. The user must shorten or re-encode the video.`,
    });
  }

  // Below 5 MB the whole-file rule overrides everything, including an override.
  const chunkSize =
    fileSize < MIN_WHOLE_BYTES
      ? fileSize
      : (chunkSizeOverride ?? Math.min(fileSize, CHUNK_SIZE_BYTES));

  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > fileSize) {
    throw invalid(
      `planChunks: chunkSize must be a positive integer no larger than the file, ` +
        `got ${String(chunkSize)} for ${String(fileSize)} bytes`,
    );
  }

  // floor-merge: the remainder folds into the final chunk instead of becoming
  // an extra short one, which is what makes V5 (one chunk of 64,000,001 bytes
  // against a declared 64,000,000) correct rather than a bug.
  const totalChunkCount = Math.floor(fileSize / chunkSize);
  if (totalChunkCount < 1 || totalChunkCount > MAX_CHUNK_COUNT) {
    throw invalid(
      `planChunks: ${String(totalChunkCount)} chunks is outside the supported ` +
        `range 1–${String(MAX_CHUNK_COUNT)}`,
    );
  }

  const chunks: ChunkRange[] = [];
  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    const end = index === totalChunkCount - 1 ? fileSize - 1 : start + chunkSize - 1;
    chunks.push({ index, start, end, size: end - start + 1 });
  }

  const last = chunks[chunks.length - 1];
  if (last === undefined || last.size > MAX_FINAL_CHUNK_BYTES) {
    throw invalid(
      `planChunks: final chunk of ${String(last?.size)} bytes exceeds the ` +
        `${String(MAX_FINAL_CHUNK_BYTES)}-byte cap`,
    );
  }
  return { chunkSize, totalChunkCount, chunks };
}

/** The `/TOTAL` denominator every `Content-Range` in a plan shares. */
function planFileSize(plan: ChunkPlan): number {
  const last = plan.chunks[plan.chunks.length - 1];
  if (last === undefined) {
    throw invalid('uploadFile: the chunk plan is empty');
  }
  return last.end + 1;
}

// ---------------------------------------------------------------------------
// Media root confinement (CC-D8) and the apply-time re-stat (CC-D3/CC-D4)
// ---------------------------------------------------------------------------

/**
 * A resolved local file, plus the identity a later apply must still find.
 *
 * `(size, mtimeMs, dev, ino)` is the four-tuple SECURITY.md pins: size alone
 * misses a same-length edit, and mtime alone misses a swap that preserved it.
 */
export interface MediaFile {
  /** Canonical absolute path — symlinks already resolved. */
  path: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

const MEDIA_ROOT_UNSET =
  'source "file" is disabled: the operator has not set TT_MEDIA_ROOT (the only ' +
  'directory this server may read media from). Ask the user to set TT_MEDIA_ROOT ' +
  'in the server configuration and restart, or host the media on a verified URL ' +
  'and use source "url".';

function notFound(path: string, root: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'file_not_found',
    message:
      `file_path ${path} does not exist or is not a regular file. Ask the user ` +
      `for the correct path under ${root}.`,
  });
}

/**
 * Resolve `filePath` to a real file inside `mediaRoot`, or reject locally.
 *
 * Order matters, and every step of it is a documented rule:
 *
 * 1. No root configured ⇒ fail closed (CC-D8). There is deliberately no CWD
 *    fallback: under an agent the working directory is attacker-influenced.
 * 2. A relative path resolves against the **root**, never the CWD.
 * 3. Both sides go through `realpath`, so a symlink that points out of the root
 *    is caught by the containment check rather than followed.
 * 4. Containment is `path.relative`, not `startsWith` — `/media` must not match
 *    `/media-evil`. On win32 `path.relative` already compares case-insensitively.
 * 5. Directories and device files fail the `isFile` test; empty and oversized
 *    files fail their own checks, so no init is ever spent on them (CC-D1).
 */
export async function resolveMediaFile(
  filePath: string,
  mediaRoot: string | undefined,
): Promise<MediaFile> {
  if (mediaRoot === undefined || mediaRoot === '') {
    throw new TikTokError({
      kind: 'config',
      code: 'media_root_not_configured',
      message: MEDIA_ROOT_UNSET,
    });
  }

  let root: string;
  try {
    root = await realpath(mediaRoot);
  } catch (cause) {
    throw new TikTokError({
      kind: 'config',
      code: 'media_root_not_configured',
      message:
        `TT_MEDIA_ROOT is set to ${mediaRoot}, which does not exist or cannot be ` +
        'read. Ask the operator to point it at an existing, readable directory.',
      cause,
    });
  }

  const candidate = isAbsolute(filePath) ? filePath : resolvePath(root, filePath);

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (cause) {
    // A dangling symlink and a missing file are the same answer to the caller;
    // neither reveals whether something else exists at that path.
    throw new TikTokError({
      kind: 'validation',
      code: 'file_not_found',
      message:
        `file_path ${candidate} does not exist or is not a regular file. Ask the ` +
        `user for the correct path under ${mediaRoot}.`,
      cause,
    });
  }

  const rel = relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)) {
    throw outsideRoot(real, mediaRoot);
  }
  // `path.relative` uses the platform separator; check the win32 one too so a
  // POSIX-hosted test of a Windows-shaped path cannot pass by accident.
  if (rel.startsWith('..\\')) throw outsideRoot(real, mediaRoot);

  const stats = await stat(real);
  if (!stats.isFile()) throw notFound(real, mediaRoot);
  if (stats.size === 0) {
    throw new TikTokError({
      kind: 'validation',
      code: 'file_empty',
      message:
        `file_path ${real} is an empty file (0 bytes). Ask the user for the ` +
        `correct path under ${mediaRoot}.`,
    });
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new TikTokError({
      kind: 'validation',
      code: 'file_too_large',
      message:
        `The file is ${String(stats.size)} bytes; TikTok's maximum is ` +
        `${String(MAX_FILE_BYTES)}. The user must shorten or re-encode the video.`,
    });
  }

  return {
    path: real,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
  };
}

function outsideRoot(resolved: string, root: string): TikTokError {
  return new TikTokError({
    kind: 'validation',
    code: 'file_outside_media_root',
    message:
      `file_path resolves to ${resolved}, which is outside the configured media ` +
      `root ${root}. This server only reads media inside that directory ` +
      '(operator policy). Ask the user to move the file there or to change ' +
      'TT_MEDIA_ROOT. Do not attempt alternative paths.',
  });
}

/**
 * Re-run the whole resolution at apply time and insist on the same file.
 *
 * The preview the human approved described *these* bytes, and the chunk plan
 * was computed from this size; a file that changed underneath makes both stale
 * (CC-D3), and a file that vanished makes them meaningless (CC-D4). Re-resolving
 * — rather than re-stat-ing the recorded path — also re-runs containment, so a
 * symlink swapped to point outside the root between plan and apply is caught.
 */
export async function verifyMediaFile(
  previous: MediaFile,
  mediaRoot: string | undefined,
): Promise<MediaFile> {
  const current = await resolveMediaFile(previous.path, mediaRoot);
  const same =
    current.path === previous.path &&
    current.size === previous.size &&
    current.mtimeMs === previous.mtimeMs &&
    current.dev === previous.dev &&
    current.ino === previous.ino;
  if (!same) {
    throw new TikTokError({
      kind: 'policy',
      code: 'plan_mismatch',
      message:
        `The file changed since plan: ${previous.path} no longer matches the ` +
        'size, modification time and identity captured when the preview was ' +
        'generated. Generate a fresh preview and apply again.',
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// The transfer (TIKTOK-API.md §§ 4.7–4.8)
// ---------------------------------------------------------------------------

/**
 * Extension → MIME. No document prescribes this map, so it is a choice:
 * mislabelling a container is harmless because TikTok validates by content and
 * reports a mismatch asynchronously as `fail_reason: file_format_check_failed`
 * (CC-D9), whereas refusing an unknown extension locally would invent an error
 * code the § 3.0 catalog does not have.
 */
const DEFAULT_CONTENT_TYPE = 'video/mp4';

/**
 * A `Map`, not an object literal, and that is not a style choice: the lookup key
 * is a user-controlled file extension, and an object literal inherits from
 * `Object.prototype`, so `clip.constructor` would resolve to a *function* and
 * sail straight past the `??` fallback into the `Content-Type` header. A `Map`
 * has no prototype chain to walk.
 */
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['qt', 'video/quicktime'],
  ['webm', 'video/webm'],
]);

export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION.get(ext) ?? DEFAULT_CONTENT_TYPE;
}

/** ARCHITECTURE § 6: `min(500 · 2^(n-1), 8000)` plus up to 25 % jitter. */
function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return Math.round(base * (1 + random() * 0.25));
}

function interrupted(
  chunk: ChunkRange,
  total: number,
  detail: string,
  remediation: string,
  cause?: unknown,
): TikTokError {
  return new TikTokError({
    kind: 'network',
    code: 'upload_interrupted',
    message:
      `Upload failed at chunk ${String(chunk.index + 1)}/${String(total)} ` +
      `(bytes ${String(chunk.start)}-${String(chunk.end)}): ${detail}`,
    remediation,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The recovery every terminal upload failure shares: a new attempt, not a resume. */
const REPLAN =
  'The upload cannot be resumed and this attempt must not be re-initialized ' +
  'automatically. Check the publish status for this publish_id; if the user still ' +
  'wants the post, generate a fresh preview and apply again — that creates a NEW ' +
  'publish attempt.';

export interface UploadFileOptions {
  /** Canonical path from {@link resolveMediaFile} — this function does not confine. */
  filePath: string;
  plan: ChunkPlan;
  /** From the init. Opaque, carries the `upload_token`; never logged or returned. */
  uploadUrl: string;
  /** Overrides {@link contentTypeFor}. */
  contentType?: string;
  signal?: AbortSignal;
  /** Fired after TikTok accepts chunk `chunkIndex` (0-based), so `+1` are done. */
  onProgress?: (chunkIndex: number, totalChunks: number) => void;
  /** Jitter source. Test seam. */
  random?: () => number;
}

/**
 * PUT every chunk of the plan, sequentially, until TikTok answers `201`.
 *
 * Retry ownership is the subtle part. `core/http`'s `putChunk` retries a 5xx by
 * itself only when it was handed a replayable `Uint8Array`; a stream forces a
 * single attempt, because re-sending a half-consumed stream would put a
 * truncated range on the wire. Streaming is not negotiable here — the final
 * chunk can reach 128 MB — so the loop lives on this side: a retry re-opens the
 * file at the same offsets and sends a byte-identical `Content-Range`, which is
 * exactly what makes a re-PUT safe (CC-D6).
 *
 * Status handling follows § 4.8: `206` continues, `201` completes, `416` resyncs
 * from the reported progress, and every other 4xx is terminal on this URL —
 * notably `403` (the one-hour URL expired), which must never trigger an
 * automatic re-init, because that would spend the publish budget and orphan a
 * pending post (CC-D5).
 */
export async function uploadFile(
  ctx: ApiContext,
  opts: UploadFileOptions,
): Promise<void> {
  assertAllowedUrl(opts.uploadUrl, 'upload');

  const total = planFileSize(opts.plan);
  const chunkCount = opts.plan.totalChunkCount;
  const contentType = opts.contentType ?? contentTypeFor(opts.filePath);
  const random = opts.random ?? Math.random;
  const attempts = 1 + Math.max(0, ctx.settings.chunkRetries);
  const log = ctx.log.child({ upload_chunks: chunkCount });

  let index = 0;
  // A 416 moves the cursor wherever TikTok says progress actually is, including
  // backwards. That is legitimate, but it is also the one way this loop can fail
  // to terminate: a server that keeps re-reporting the same progress would have
  // us re-send the same chunks forever. Every chunk is allowed to trigger one
  // resync, no more (`resyncBudget`); past that the upload is failed instead of
  // spun on.
  const resyncBudget = chunkCount;
  let resyncs = 0;
  while (index < chunkCount) {
    opts.signal?.throwIfAborted();

    const chunk = opts.plan.chunks[index];
    if (chunk === undefined) {
      throw invalid(`uploadFile: chunk ${String(index)} is missing from the plan`);
    }
    const contentRange = `bytes ${String(chunk.start)}-${String(chunk.end)}/${String(total)}`;

    let result;
    try {
      result = await putChunkWithRetries(ctx, {
        chunk,
        chunkCount,
        contentRange,
        contentType,
        attempts,
        random,
        filePath: opts.filePath,
        uploadUrl: opts.uploadUrl,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (cause) {
      if (!isTikTokError(cause)) throw cause; // an abort unwinds verbatim (CC-G4)
      throw interrupted(
        chunk,
        chunkCount,
        `${String(attempts)} attempt(s) failed — ${cause.message}`,
        REPLAN,
        cause,
      );
    }

    if (result.status === 201) {
      if (index < chunkCount - 1) {
        // Not the documented sequence, but TikTok says the transfer is done and
        // a further PUT would be a write against a closed upload.
        log.warn('upload complete before the last chunk', {
          chunk_index: chunk.index,
          total_chunks: chunkCount,
        });
      }
      opts.onProgress?.(chunk.index, chunkCount);
      return;
    }

    if (result.status === 206) {
      opts.onProgress?.(chunk.index, chunkCount);
      index += 1;
      continue;
    }

    if (result.status === 416) {
      resyncs += 1;
      if (resyncs > resyncBudget) {
        throw interrupted(
          chunk,
          chunkCount,
          `HTTP 416 — TikTok rejected the byte range ${String(resyncs)} times without ` +
            'the upload making progress',
          REPLAN,
        );
      }
      index = resyncIndex(opts.plan, chunk, chunkCount, result.uploadedBytes, log);
      continue;
    }

    throw interrupted(
      chunk,
      chunkCount,
      terminalDetail(result.status),
      result.status === 400 ? PLANNER_BUG : REPLAN,
    );
  }

  // Every chunk was accepted with a 206 and no 201 ever arrived. Reporting this
  // as success would hand the caller a publish_id that will never leave
  // PROCESSING; § 4.8 makes the 201 the completion signal, so its absence is a
  // failure of the transfer, not of the post.
  const last = opts.plan.chunks[chunkCount - 1];
  throw new TikTokError({
    kind: 'network',
    code: 'upload_interrupted',
    message:
      `All ${String(chunkCount)} chunks were accepted but TikTok never confirmed ` +
      `the transfer (no HTTP 201 after bytes ${String(last?.start)}-${String(last?.end)}).`,
    remediation: REPLAN,
  });
}

const PLANNER_BUG =
  'TikTok rejected the chunk headers, which means the declared byte size did ' +
  'not match the bytes sent. This is a server bug, not a user error: report it ' +
  'with the byte range above. A fresh preview will re-plan the upload.';

function terminalDetail(status: number): string {
  if (status === 400) return 'HTTP 400 — the chunk headers did not match the bytes';
  if (status === 403)
    return 'HTTP 403 — the upload URL expired (it is valid for one hour)';
  if (status === 404) return 'HTTP 404 — TikTok no longer knows this upload task';
  return `HTTP ${String(status)}`;
}

/**
 * Where to continue after a 416 ("the range does not reflect actual progress").
 *
 * `uploadedBytes` is reported verbatim by `core/http` because its unit is only
 * pinned by probe P-11 — TikTok's `Content-Range: bytes 0-{UPLOADED_BYTES}/…`
 * reads as a last-byte index, while `status/fetch`'s `uploaded_bytes` reads as a
 * count. Both readings are accepted here rather than guessing: a chunk counts as
 * accepted at `end`, and the next chunk is found at either `start` or
 * `start - 1`. Anything that lands mid-chunk is terminal — resuming inside a
 * chunk is not something the plan can express.
 */
function resyncIndex(
  plan: ChunkPlan,
  chunk: ChunkRange,
  chunkCount: number,
  uploadedBytes: number | undefined,
  log: ApiContext['log'],
): number {
  if (uploadedBytes === undefined) {
    throw interrupted(
      chunk,
      chunkCount,
      'HTTP 416 — TikTok reported a progress mismatch but no progress to resync from',
      REPLAN,
    );
  }
  log.warn('chunk range rejected as out of sync', {
    chunk_index: chunk.index,
    uploaded_bytes: uploadedBytes,
  });

  if (uploadedBytes >= chunk.end) {
    // Already recorded — advance past it (CC-D6 step 4).
    return chunk.index + 1;
  }
  const next = plan.chunks.findIndex(
    (c) => c.start === uploadedBytes || c.start === uploadedBytes + 1,
  );
  if (next === chunk.index) {
    // The rejected range *is* the range TikTok points at. Re-sending it would
    // produce the same 416 forever, so this is a contradiction, not a resync.
    throw interrupted(
      chunk,
      chunkCount,
      `HTTP 416 — TikTok rejected this range but reports progress (${String(uploadedBytes)} ` +
        'bytes) that points back at the same range',
      REPLAN,
    );
  }
  if (next === -1) {
    throw interrupted(
      chunk,
      chunkCount,
      `HTTP 416 — TikTok reports ${String(uploadedBytes)} bytes of progress, which ` +
        'is not a chunk boundary of this plan',
      REPLAN,
    );
  }
  return next;
}

interface ChunkAttemptOptions {
  chunk: ChunkRange;
  chunkCount: number;
  contentRange: string;
  contentType: string;
  attempts: number;
  random: () => number;
  filePath: string;
  uploadUrl: string;
  signal?: AbortSignal;
}

/**
 * One chunk, up to `attempts` times, a fresh read stream per attempt.
 *
 * `chunkRetries: 0` is passed deliberately: `putChunk` would disable its own
 * retries for a stream body anyway, and saying so explicitly keeps the retry
 * count in one place instead of two.
 */
async function putChunkWithRetries(
  ctx: ApiContext,
  opts: ChunkAttemptOptions,
): Promise<{ status: number; uploadedBytes?: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    opts.signal?.throwIfAborted();
    try {
      return await putChunk({
        uploadUrl: opts.uploadUrl,
        contentRange: opts.contentRange,
        contentType: opts.contentType,
        body: chunkStream(opts.filePath, opts.chunk),
        contentLength: opts.chunk.size,
        timeoutMs: ctx.settings.uploadTimeoutMs,
        chunkRetries: 0,
        clock: ctx.clock,
        logger: ctx.log,
        random: opts.random,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (error) {
      // Only a transport-class failure is replayable; a validation error would
      // fail identically forever, and an abort is not an outcome at all.
      if (!isTikTokError(error) || !error.retryable) throw error;
      lastError = error;
      if (attempt === opts.attempts) break;
      const wait = backoffMs(attempt, opts.random);
      ctx.log.debug('retrying chunk', {
        chunk_index: opts.chunk.index,
        attempt,
        backoff_ms: wait,
      });
      await ctx.clock.sleep(wait, opts.signal);
    }
  }
  throw lastError;
}

/** A fresh `ReadableStream` over one byte range. Never buffers the chunk. */
function chunkStream(filePath: string, chunk: ChunkRange): ReadableStream<Uint8Array> {
  const node = createReadStream(filePath, { start: chunk.start, end: chunk.end });
  return Readable.toWeb(node);
}
