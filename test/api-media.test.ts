/**
 * `api/media.ts` — the media pre-flight (ROADMAP Phase 5 / 1.1, TIKTOK-API § 6).
 *
 * Every file here is synthesised box by box, so each offset the parser reads
 * (`mvhd`/`mdhd` timing, `tkhd` 16.16 size, `hdlr` handler, `stsd` fourcc,
 * `stts` sample counts) is pinned against an independently built layout rather
 * than against a recorded sample that happens to parse.
 */

import assert from 'node:assert/strict';
import { truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACCEPTED_CODECS,
  checkMedia,
  inspectMovie,
  MAX_MOOV_BYTES,
  MEDIA_LIMITS,
  probeMediaFile,
  type MediaProbe,
} from '../src/api/media.js';
import {
  box,
  FTYP_MP4,
  FTYP_QT,
  hdlr,
  MDAT,
  moov,
  payload,
  timingBox,
  tkhd,
  u32,
  u64,
} from './harness/mp4.js';
import { fsSandbox } from './helpers.js';

async function probeBytes(bytes: Buffer): Promise<MediaProbe | undefined> {
  const sandbox = await fsSandbox();
  try {
    const path = join(sandbox.dir, 'clip.mp4');
    await writeFile(path, bytes);
    return await probeMediaFile(path);
  } finally {
    await sandbox.cleanup();
  }
}

const FULL: MediaProbe = {
  container: 'mp4',
  codec: 'avc1',
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 10,
};

// ---------------------------------------------------------------------------
// probeMediaFile — container sniffing and the top-level walk
// ---------------------------------------------------------------------------

test('an MP4 with moov after mdat is probed in full', async () => {
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, MDAT, moov()])), FULL);
});

test('ftyp major brand "qt  " is MOV', async () => {
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_QT, moov()])), {
    ...FULL,
    container: 'mov',
  });
});

test('a QuickTime file without ftyp is MOV by its first box', async () => {
  assert.deepEqual(await probeBytes(Buffer.concat([moov(), MDAT])), {
    ...FULL,
    container: 'mov',
  });
  assert.deepEqual(await probeBytes(Buffer.concat([box('wide'), MDAT])), {
    container: 'mov',
  });
});

test('the EBML magic is WebM, without further parsing', async () => {
  assert.deepEqual(
    await probeBytes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86])),
    {
      container: 'webm',
    },
  );
});

test('anything else is unknown, including a file too short to hold a box', async () => {
  assert.deepEqual(await probeBytes(Buffer.alloc(4096, 7)), { container: 'unknown' });
  assert.deepEqual(await probeBytes(Buffer.from('GIF89a')), { container: 'unknown' });
  assert.deepEqual(await probeBytes(Buffer.from([0, 1])), { container: 'unknown' });
});

test('an ftyp with no brand and nothing after it is MP4 with no fields', async () => {
  assert.deepEqual(await probeBytes(Buffer.concat([u32(8), Buffer.from('ftyp')])), {
    container: 'mp4',
  });
});

test('64-bit and to-the-end box sizes are followed', async () => {
  const largeMdat = Buffer.concat([
    u32(1),
    Buffer.from('mdat'),
    u64(16 + 32),
    Buffer.alloc(32),
  ]);
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, largeMdat, moov()])), FULL);

  // size 0 = "to the end of the file": the walk ends there without a moov.
  const toEnd = Buffer.concat([u32(0), Buffer.from('mdat'), Buffer.alloc(32)]);
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, toEnd])), {
    container: 'mp4',
  });

  // ...and a moov sized that way is still read.
  const moovToEnd = Buffer.concat([u32(0), moov().subarray(4)]);
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, moovToEnd])), FULL);
});

test('a malformed top-level header stops the walk with the container kept', async () => {
  // size smaller than its own header
  const tiny = Buffer.concat([u32(4), Buffer.from('free')]);
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, tiny, moov()])), {
    container: 'mp4',
  });
  // size past the end of the file
  const long = Buffer.concat([u32(10_000), Buffer.from('mdat')]);
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, long])), {
    container: 'mp4',
  });
  // a 64-bit size whose largesize field is cut off
  const cut = Buffer.concat([u32(1), Buffer.from('mdat'), u32(0)]);
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, cut])), {
    container: 'mp4',
  });
});

test('the walk gives up after the top-level box budget', async () => {
  const frees = Array.from({ length: 64 }, () => box('free'));
  assert.deepEqual(await probeBytes(Buffer.concat([FTYP_MP4, ...frees, moov()])), {
    container: 'mp4',
  });
  // ftyp + 62 frees puts moov at the 64th box: the last one walked.
  assert.deepEqual(
    await probeBytes(Buffer.concat([FTYP_MP4, ...frees.slice(2), moov()])),
    FULL,
  );
});

test('a moov over the size cap is not loaded', async () => {
  const sandbox = await fsSandbox();
  try {
    const path = join(sandbox.dir, 'huge.mov');
    const size = MAX_MOOV_BYTES + 8 + 1;
    await writeFile(path, Buffer.concat([FTYP_QT, u32(size), Buffer.from('moov')]));
    await truncate(path, FTYP_QT.length + size); // sparse
    assert.deepEqual(await probeMediaFile(path), { container: 'mov' });
  } finally {
    await sandbox.cleanup();
  }
});

test('an unreadable path probes to undefined, not to "unknown"', async () => {
  const sandbox = await fsSandbox();
  try {
    assert.equal(await probeMediaFile(join(sandbox.dir, 'missing.mp4')), undefined);
    assert.equal(await probeMediaFile(sandbox.dir), undefined); // EISDIR on read
  } finally {
    await sandbox.cleanup();
  }
});

// ---------------------------------------------------------------------------
// inspectMovie — the moov payload
// ---------------------------------------------------------------------------

test('version-1 mvhd, tkhd and mdhd read their wider fields', () => {
  assert.deepEqual(inspectMovie(payload(moov({ version: 1 }))), {
    codec: 'avc1',
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 10,
  });
});

test('fps is the stts sample total over the mdhd duration', () => {
  // 23.976: 1001-tick frames at 24000/s, 240 frames.
  const movie = moov({ mediaScale: 24_000, mediaDuration: 240_240, samples: [200, 40] });
  assert.equal(inspectMovie(payload(movie)).fps, 23.98);
});

test('the first video track wins; tracks of other kinds are skipped', () => {
  const audio = box('trak', tkhd(0, 0, 0), box('mdia', hdlr('soun')));
  const bare = box('trak', tkhd(0, 0, 0));
  const full = moov();
  const video = full.subarray(full.indexOf('trak', 0, 'latin1') - 4);
  const movie = box('moov', timingBox('mvhd', 0, 1000, 10_000), audio, bare, video);
  assert.deepEqual(inspectMovie(payload(movie)), {
    codec: 'avc1',
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 10,
  });
});

test('a movie with no video track reports its duration only', () => {
  assert.deepEqual(inspectMovie(payload(moov({ handler: 'soun' }))), { durationSec: 10 });
});

test('without a usable mvhd the video track supplies the duration', () => {
  assert.equal(inspectMovie(payload(moov({ withMvhd: false }))).durationSec, 10);
  assert.equal(inspectMovie(payload(moov({ movieScale: 0 }))).durationSec, 10);
  // mvhd wins when both are present
  assert.equal(inspectMovie(payload(moov({ movieDuration: 12_500 }))).durationSec, 12.5);
});

test('missing or empty tables leave their fields out', () => {
  assert.deepEqual(inspectMovie(payload(moov({ codec: undefined }))), {
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 10,
  });
  assert.equal(inspectMovie(payload(moov({ withStts: false }))).fps, undefined);
  assert.equal(inspectMovie(payload(moov({ mediaDuration: 0 }))).fps, undefined);
  assert.equal(inspectMovie(payload(moov({ mediaScale: 0 }))).fps, undefined);
  const noStbl = inspectMovie(payload(moov({ withStbl: false })));
  assert.equal(noStbl.codec, undefined);
  assert.equal(noStbl.fps, undefined);
});

test('a zero track size is unknown, not 0 px', () => {
  const probe = inspectMovie(payload(moov({ width: 0 })));
  assert.equal(probe.width, undefined);
  assert.equal(probe.height, undefined);
});

test('a non-printable fourcc is sanitised', () => {
  assert.equal(inspectMovie(payload(moov({ codec: 'a\nc\u0001' }))).codec, 'a?c?');
});

test('a truncated movie keeps the fields read before the cut', () => {
  const movie = payload(moov());
  // Cut inside tkhd: the trak header still claims its full size, so the box
  // walk refuses it and only mvhd survives.
  assert.deepEqual(inspectMovie(movie.subarray(0, 60)), { durationSec: 10 });
  // A trak whose stts claims more entries than it holds throws mid-read.
  const lying = Buffer.from(movie);
  const at = lying.indexOf('stts', 0, 'latin1') + 8;
  lying.writeUInt32BE(1_000_000, at);
  assert.deepEqual(inspectMovie(lying), {
    codec: 'avc1',
    width: 1080,
    height: 1920,
    durationSec: 10,
  });
});

test('a garbage child header ends that level of the walk', () => {
  const movie = box(
    'moov',
    timingBox('mvhd', 0, 1000, 10_000),
    u32(3),
    Buffer.from('junk'),
  );
  assert.deepEqual(inspectMovie(payload(movie)), { durationSec: 10 });
  // fewer bytes left than a box header
  const tail = Buffer.concat([payload(moov()), Buffer.from([1, 2, 3])]);
  assert.deepEqual(inspectMovie(tail), inspectMovie(payload(moov())));
  assert.deepEqual(inspectMovie(Buffer.alloc(0)), {});
});

// ---------------------------------------------------------------------------
// checkMedia — the documented limits
// ---------------------------------------------------------------------------

test('a conforming probe has no issues', () => {
  assert.deepEqual(checkMedia(FULL), []);
  assert.deepEqual(checkMedia({ container: 'webm' }), []);
  for (const codec of ACCEPTED_CODECS)
    assert.deepEqual(checkMedia({ ...FULL, codec }), []);
});

test('every limit is checked, in a fixed order', () => {
  assert.deepEqual(
    checkMedia({
      container: 'unknown',
      codec: 'mp4v',
      width: 320,
      height: 240,
      fps: 15,
      durationSec: 601,
    }),
    ['container', 'codec', 'resolution', 'frame_rate', 'duration'],
  );
});

test('the bounds are inclusive', () => {
  const { minSidePx, maxSidePx, minFps, maxFps, maxDurationSec } = MEDIA_LIMITS;
  assert.deepEqual(checkMedia({ ...FULL, width: minSidePx, height: maxSidePx }), []);
  assert.deepEqual(checkMedia({ ...FULL, width: maxSidePx + 1, height: 1920 }), [
    'resolution',
  ]);
  assert.deepEqual(checkMedia({ ...FULL, width: 1080, height: minSidePx - 1 }), [
    'resolution',
  ]);
  assert.deepEqual(checkMedia({ ...FULL, fps: minFps }), []);
  assert.deepEqual(checkMedia({ ...FULL, fps: maxFps }), []);
  assert.deepEqual(checkMedia({ ...FULL, fps: maxFps + 0.01 }), ['frame_rate']);
  assert.deepEqual(checkMedia({ ...FULL, durationSec: maxDurationSec }), []);
});

test('the creator limit replaces the platform maximum', () => {
  assert.deepEqual(checkMedia({ ...FULL, durationSec: 61 }, 60), ['duration']);
  assert.deepEqual(checkMedia({ ...FULL, durationSec: 60 }, 60), []);
});
