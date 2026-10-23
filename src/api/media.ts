/**
 * Media pre-flight: a read-only look inside a local video file before it is
 * uploaded (TIKTOK-API.md § 6, CC-D9, ROADMAP Phase 5 / 1.1).
 *
 * TikTok validates the container, codec, frame rate and resolution only after
 * every byte has arrived, and reports a mismatch asynchronously as a `FAILED`
 * status. A 2 GB upload that was never going to be accepted is the expensive
 * way to learn that, so the preview reads the file's own header first:
 *
 * - {@link probeMediaFile} sniffs the container from the first bytes and, for
 *   an ISO base-media file (MP4/MOV), walks the top-level boxes with positional
 *   reads, loads `moov` alone and hands it to {@link inspectMovie}. It never
 *   reads `mdat`, so the cost is a few small reads plus the movie header.
 * - {@link inspectMovie} is **pure**: duration from `mvhd`, and from the first
 *   video track (`hdlr` = `vide`) its `tkhd` dimensions, the `stsd` sample-entry
 *   fourcc and a frame rate from `stts` sample counts over the `mdhd` duration.
 * - {@link checkMedia} is **pure** and turns a probe into the issues TikTok's
 *   documented limits would reject.
 *
 * Advisory by construction: a probe that cannot read or cannot make sense of a
 * field leaves it out, and a field that is absent is never an issue. WebM is
 * recognised by its EBML magic but not parsed further. Nothing here refuses a
 * request — the tool layer reports what it found next to the plan.
 *
 * Layering: `core ← api ← mcp ← tools`. This file imports nothing from the
 * project.
 */

import { open, type FileHandle } from 'node:fs/promises';

/** What the first bytes say the file is. */
export type MediaContainer = 'mp4' | 'mov' | 'webm' | 'unknown';

export interface MediaProbe {
  container: MediaContainer;
  /** The first video sample entry's fourcc, e.g. `avc1`; printable ASCII only. */
  codec?: string;
  width?: number;
  height?: number;
  /** Average frames per second, two decimals. */
  fps?: number;
  /** Seconds, two decimals. */
  durationSec?: number;
}

/** One rejected limit; the tool layer turns each into a fixed phrase. */
export type MediaIssue = 'container' | 'codec' | 'resolution' | 'frame_rate' | 'duration';

/** TikTok's documented limits (TIKTOK-API.md § 6). */
export const MEDIA_LIMITS = Object.freeze({
  minSidePx: 360,
  maxSidePx: 4096,
  minFps: 23,
  maxFps: 60,
  /** The platform maximum, used when no creator-specific value is known. */
  maxDurationSec: 600,
});

/** Sample entries for H.264 (`avc1`/`avc3`), H.265 (`hvc1`/`hev1`), VP8, VP9. */
export const ACCEPTED_CODECS: readonly string[] = Object.freeze([
  'avc1',
  'avc3',
  'hvc1',
  'hev1',
  'vp08',
  'vp09',
]);

/** A `moov` larger than this is not loaded; the container verdict still stands. */
export const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/** Top-level boxes walked before giving up on finding `moov`. */
const MAX_TOP_LEVEL_BOXES = 64;

/** Boxes a QuickTime file may open with when it carries no `ftyp`. */
const BARE_QUICKTIME_BOXES: ReadonlySet<string> = new Set([
  'moov',
  'mdat',
  'wide',
  'free',
  'skip',
]);

const EBML_MAGIC = 0x1a45dfa3;

// ---------------------------------------------------------------------------
// The file walk
// ---------------------------------------------------------------------------

/**
 * Probe `path` (already confined by `resolveMediaFile`). Resolves `undefined`
 * when the file cannot be opened or read at all — an I/O failure says nothing
 * about the media, so it must not read as "unknown container".
 */
export async function probeMediaFile(path: string): Promise<MediaProbe | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  const probe = await handle
    .stat()
    .then((stats) => probeHandle(handle, stats.size))
    .catch(() => undefined);
  await handle.close();
  return probe;
}

async function probeHandle(handle: FileHandle, fileSize: number): Promise<MediaProbe> {
  const head = await readAt(handle, 0, 16);
  if (head.length >= 4 && head.readUInt32BE(0) === EBML_MAGIC)
    return { container: 'webm' };
  if (head.length < 8) return { container: 'unknown' };

  const firstType = head.toString('latin1', 4, 8);
  let container: MediaContainer;
  if (firstType === 'ftyp') {
    container =
      head.length >= 12 && head.toString('latin1', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
  } else if (BARE_QUICKTIME_BOXES.has(firstType)) {
    container = 'mov';
  } else {
    return { container: 'unknown' };
  }

  const moov = await findMoov(handle, fileSize);
  return moov === undefined ? { container } : { container, ...inspectMovie(moov) };
}

/** The `moov` payload, or `undefined` when it is absent, malformed or too large. */
async function findMoov(
  handle: FileHandle,
  fileSize: number,
): Promise<Buffer | undefined> {
  let pos = 0;
  for (let count = 0; count < MAX_TOP_LEVEL_BOXES && pos + 8 <= fileSize; count++) {
    const header = await readAt(handle, pos, 16);
    const box = boxAt(header, 0, header.length, fileSize - pos);
    if (box === undefined) return undefined;
    if (box.type === 'moov') {
      const length = box.end - box.start;
      return length <= MAX_MOOV_BYTES
        ? readAt(handle, pos + box.start, length)
        : undefined;
    }
    pos += box.end;
  }
  return undefined;
}

async function readAt(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// ---------------------------------------------------------------------------
// Box parsing (pure)
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  /** Payload start, relative to the buffer the box was read from. */
  start: number;
  /** One past the last byte of the box. */
  end: number;
}

/**
 * The box whose header starts at `offset`. `available` is how many bytes the
 * box may span — the parent's remaining length, which is also what a size of 0
 * ("to the end") means. `headerEnd` bounds how much of the header is readable.
 */
function boxAt(
  buf: Buffer,
  offset: number,
  headerEnd: number,
  available: number,
): Box | undefined {
  if (offset + 8 > headerEnd) return undefined;
  const size32 = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let headerSize = 8;
  let size: number;
  if (size32 === 1) {
    if (offset + 16 > headerEnd) return undefined;
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else {
    size = size32 === 0 ? available : size32;
  }
  if (size < headerSize || size > available) return undefined;
  return { type, start: offset + headerSize, end: offset + size };
}

/** The direct children of the payload `[start, end)`. Stops at the first bad header. */
function children(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos < end) {
    const box = boxAt(buf, pos, end, end - pos);
    if (box === undefined) break;
    boxes.push(box);
    pos = box.end;
  }
  return boxes;
}

function child(buf: Buffer, parent: Box, type: string): Box | undefined {
  return children(buf, parent.start, parent.end).find((box) => box.type === type);
}

/** `(timescale, duration)` from a v0/v1 `mvhd` or `mdhd` payload. */
function timing(buf: Buffer, box: Box): { timescale: number; duration: number } {
  const v1 = buf.readUInt8(box.start) === 1;
  const at = box.start + (v1 ? 20 : 12);
  return {
    timescale: buf.readUInt32BE(at),
    duration: v1 ? Number(buf.readBigUInt64BE(at + 4)) : buf.readUInt32BE(at + 4),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Printable ASCII stays; anything else becomes `?`, so a hostile file cannot inject text. */
function sanitizeFourcc(raw: string): string {
  return raw.replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Read what a `moov` payload says about the movie and its first video track.
 * Any field that does not parse is left out; the fields read before it stay.
 */
export function inspectMovie(moov: Buffer): Omit<MediaProbe, 'container'> {
  const out: Omit<MediaProbe, 'container'> = {};
  const root: Box = { type: 'moov', start: 0, end: moov.length };
  try {
    const mvhd = child(moov, root, 'mvhd');
    if (mvhd !== undefined) {
      const { timescale, duration } = timing(moov, mvhd);
      if (timescale > 0) out.durationSec = round2(duration / timescale);
    }

    const trak = children(moov, root.start, root.end).find(
      (box) => box.type === 'trak' && handlerOf(moov, box) === 'vide',
    );
    if (trak === undefined) return out;

    const tkhd = child(moov, trak, 'tkhd');
    if (tkhd !== undefined) {
      const at = tkhd.start + (moov.readUInt8(tkhd.start) === 1 ? 88 : 76);
      // 16.16 fixed point; the fraction is never meaningful for pixels. Some
      // muxers leave the track size at zero, which means "unknown", not 0 px.
      const width = moov.readUInt32BE(at) >>> 16;
      const height = moov.readUInt32BE(at + 4) >>> 16;
      if (width > 0 && height > 0) Object.assign(out, { width, height });
    }

    const mdia = child(moov, trak, 'mdia');
    const mdhd = mdia && child(moov, mdia, 'mdhd');
    const stbl = mdia && descend(moov, mdia, ['minf', 'stbl']);
    const stsd = stbl && child(moov, stbl, 'stsd');
    if (stsd !== undefined && moov.readUInt32BE(stsd.start + 4) > 0) {
      out.codec = sanitizeFourcc(
        moov.toString('latin1', stsd.start + 12, stsd.start + 16),
      );
    }

    const stts = stbl && child(moov, stbl, 'stts');
    if (mdhd !== undefined && stts !== undefined) {
      const { timescale, duration } = timing(moov, mdhd);
      const entries = moov.readUInt32BE(stts.start + 4);
      let samples = 0;
      for (let i = 0; i < entries; i++)
        samples += moov.readUInt32BE(stts.start + 8 + i * 8);
      if (timescale > 0 && duration > 0) {
        const seconds = duration / timescale;
        out.fps = round2(samples / seconds);
        out.durationSec ??= round2(seconds);
      }
    }
  } catch {
    // A truncated or malformed box: keep what was read before it.
  }
  return out;
}

function descend(buf: Buffer, from: Box, path: readonly string[]): Box | undefined {
  let box: Box | undefined = from;
  for (const type of path) {
    box = child(buf, box, type);
    if (box === undefined) return undefined;
  }
  return box;
}

/** The `mdia/hdlr` handler type of a `trak`: `vide`, `soun`, … */
function handlerOf(buf: Buffer, trak: Box): string | undefined {
  const hdlr = descend(buf, trak, ['mdia', 'hdlr']);
  return hdlr && buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
}

// ---------------------------------------------------------------------------
// The verdict (pure)
// ---------------------------------------------------------------------------

/**
 * The limits a probe breaks. `maxDurationSec` is the creator's
 * `max_video_post_duration_sec` when known; a draft has no creator lookup and
 * falls back to the platform maximum.
 */
export function checkMedia(
  probe: MediaProbe,
  maxDurationSec: number = MEDIA_LIMITS.maxDurationSec,
): MediaIssue[] {
  const issues: MediaIssue[] = [];
  if (probe.container === 'unknown') issues.push('container');
  if (probe.codec !== undefined && !ACCEPTED_CODECS.includes(probe.codec))
    issues.push('codec');
  const sides = [probe.width, probe.height].filter((side) => side !== undefined);
  if (
    sides.some((side) => side < MEDIA_LIMITS.minSidePx || side > MEDIA_LIMITS.maxSidePx)
  ) {
    issues.push('resolution');
  }
  if (
    probe.fps !== undefined &&
    (probe.fps < MEDIA_LIMITS.minFps || probe.fps > MEDIA_LIMITS.maxFps)
  ) {
    issues.push('frame_rate');
  }
  if (probe.durationSec !== undefined && probe.durationSec > maxDurationSec) {
    issues.push('duration');
  }
  return issues;
}
