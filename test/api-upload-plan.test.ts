/**
 * `src/api/upload.ts` — the chunk planner and the media-root gate: every
 * decision this server makes about a local file *before* a single byte, or a
 * single publish attempt, is spent.
 *
 * Two classes of bug live here, and neither is visible from a happy path.
 *
 * The first is arithmetic. The plan is **decimal**, not binary, and
 * `total_chunk_count` is a *floor*, so the final chunk absorbs the remainder
 * and may legally be longer than the `chunk_size` the same plan declares. A
 * plausible "ceil, then a short tail" implementation passes a smoke test and
 * then puts a `Content-Range` on the wire that TikTok answers with a 400 —
 * after the init has already been charged against the 6/min budget. So the
 * eight worked vectors of TIKTOK-API.md § 4.6 are asserted byte-exactly, every
 * decimal boundary either side of 5 MB / 64 MB / 128 MB / 4 GiB gets its own
 * pin, and the invariants are re-checked as properties across the whole
 * one-byte-to-4-GiB domain (CC-D2).
 *
 * The second is containment. `resolveMediaFile` is the only thing standing
 * between an agent-supplied string and the operator's filesystem, and every way
 * it can be wrong is quiet: a `startsWith` root check that accepts
 * `/media-evil` beside `/media`, a symlink followed instead of resolved, a
 * relative path taken against the CWD — which under an agent is
 * attacker-influenced — instead of against the root. Each of those is a
 * negative test here rather than a comment (CC-D8), alongside the
 * empty/missing/not-a-file rejections that keep an init from being spent on a
 * file that could never upload (CC-D1) and the apply-time re-resolution that
 * refuses a file which changed or vanished since the human approved the
 * preview (CC-D3/CC-D4).
 */

import assert from 'node:assert/strict';
import {
  mkdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import fc from 'fast-check';

import {
  CHUNK_SIZE_BYTES,
  contentTypeFor,
  MAX_CHUNK_COUNT,
  MAX_FILE_BYTES,
  MAX_FINAL_CHUNK_BYTES,
  MIN_WHOLE_BYTES,
  planChunks,
  resolveMediaFile,
  verifyMediaFile,
  type ChunkPlan,
} from '../src/api/upload.js';
import { isTikTokError } from '../src/core/errors.js';
import { BASELINE_NOW_MS, fsSandbox } from './helpers.js';

// ---------------------------------------------------------------------------
// local fixtures
// ---------------------------------------------------------------------------

/**
 * The `Content-Range` ladder a plan produces, built exactly the way
 * `uploadFile` builds it — the denominator is the file size, and `end` is the
 * inclusive last byte. Asserting the strings rather than the numbers is the
 * point: an off-by-one that the numbers hide is visible here.
 */
function contentRanges(plan: ChunkPlan, fileSize: number): string[] {
  return plan.chunks.map(
    (chunk) => `bytes ${String(chunk.start)}-${String(chunk.end)}/${String(fileSize)}`,
  );
}

// ---------------------------------------------------------------------------
// CC-D2 — the worked vectors V1–V8 (TIKTOK-API.md § 4.6)
// ---------------------------------------------------------------------------

interface Vector {
  readonly id: string;
  readonly rule: string;
  readonly fileSize: number;
  /**
   * Only V3 carries one. TikTok's own worked example splits 50,000,123 bytes at
   * 10,000,000, which `min(size, CHUNK_SIZE_BYTES)` can never produce — so the
   * override keeps the *formula* under test, not merely this server's constant.
   */
  readonly override?: number;
  readonly chunkSize: number;
  readonly totalChunkCount: number;
  readonly ranges: readonly string[];
}

const VECTORS: readonly Vector[] = [
  {
    id: 'v1',
    rule: 'below 5 MB uploads as one mandatory whole-file chunk',
    fileSize: 3_145_728,
    chunkSize: 3_145_728,
    totalChunkCount: 1,
    ranges: ['bytes 0-3145727/3145728'],
  },
  {
    id: 'v2',
    rule: 'exactly 5,000,000 bytes is a single chunk',
    fileSize: 5_000_000,
    chunkSize: 5_000_000,
    totalChunkCount: 1,
    ranges: ['bytes 0-4999999/5000000'],
  },
  {
    id: 'v3',
    rule: "TikTok's own worked example — 50,000,123 at 10,000,000 is 5 chunks",
    fileSize: 50_000_123,
    override: 10_000_000,
    chunkSize: 10_000_000,
    totalChunkCount: 5,
    ranges: [
      'bytes 0-9999999/50000123',
      'bytes 10000000-19999999/50000123',
      'bytes 20000000-29999999/50000123',
      'bytes 30000000-39999999/50000123',
      'bytes 40000000-50000122/50000123',
    ],
  },
  {
    id: 'v4',
    rule: 'exactly 64,000,000 bytes is a single chunk of exactly chunk_size',
    fileSize: 64_000_000,
    chunkSize: 64_000_000,
    totalChunkCount: 1,
    ranges: ['bytes 0-63999999/64000000'],
  },
  {
    id: 'v5',
    rule: 'a single chunk exceeds the declared chunk_size',
    fileSize: 64_000_001,
    chunkSize: 64_000_000,
    totalChunkCount: 1,
    ranges: ['bytes 0-64000000/64000001'],
  },
  {
    id: 'v6',
    rule: 'the merged final chunk is 86,000,000 bytes',
    fileSize: 150_000_000,
    chunkSize: 64_000_000,
    totalChunkCount: 2,
    ranges: ['bytes 0-63999999/150000000', 'bytes 64000000-149999999/150000000'],
  },
  {
    id: 'v7',
    rule: 'an exact multiple leaves the final chunk at exactly chunk_size',
    fileSize: 256_000_000,
    chunkSize: 64_000_000,
    totalChunkCount: 4,
    ranges: [
      'bytes 0-63999999/256000000',
      'bytes 64000000-127999999/256000000',
      'bytes 128000000-191999999/256000000',
      'bytes 192000000-255999999/256000000',
    ],
  },
];

for (const vector of VECTORS) {
  test(`cc-d2 ${vector.id} ${vector.rule}`, () => {
    const plan =
      vector.override === undefined
        ? planChunks(vector.fileSize)
        : planChunks(vector.fileSize, vector.override);

    assert.equal(plan.chunkSize, vector.chunkSize);
    assert.equal(plan.totalChunkCount, vector.totalChunkCount);
    // The declared count and the ladder actually emitted cannot disagree: the
    // count is what the init reports to TikTok, the ladder is what gets PUT.
    assert.equal(plan.chunks.length, vector.totalChunkCount);
    assert.deepEqual(contentRanges(plan, vector.fileSize), [...vector.ranges]);
  });
}

test('cc-d2 v8 4 GiB is 67 chunks whose final one absorbs 70,967,296 bytes', () => {
  const plan = planChunks(MAX_FILE_BYTES);

  assert.equal(MAX_FILE_BYTES, 4_294_967_296);
  assert.equal(plan.chunkSize, CHUNK_SIZE_BYTES);
  assert.equal(plan.totalChunkCount, 67);
  assert.equal(plan.chunks.length, 67);

  // 67 literal ranges assert nothing that three do not: the seam and the ends
  // are where a floor-merge goes wrong.
  assert.deepEqual(plan.chunks[0], {
    index: 0,
    start: 0,
    end: 63_999_999,
    size: 64_000_000,
  });
  assert.deepEqual(plan.chunks[65], {
    index: 65,
    start: 4_160_000_000,
    end: 4_223_999_999,
    size: 64_000_000,
  });
  assert.deepEqual(plan.chunks[66], {
    index: 66,
    start: 4_224_000_000,
    end: 4_294_967_295,
    size: 70_967_296,
  });

  const ranges = contentRanges(plan, MAX_FILE_BYTES);
  assert.equal(ranges.length, 67);
  assert.equal(ranges[0], 'bytes 0-63999999/4294967296');
  assert.equal(ranges[66], 'bytes 4224000000-4294967295/4294967296');
});

// ---------------------------------------------------------------------------
// CC-D2 — the decimal boundary pins, one test each
// ---------------------------------------------------------------------------

test('cc-d2 4,999,999 bytes — one byte under MIN_WHOLE — is one whole-file chunk', () => {
  assert.equal(4_999_999, MIN_WHOLE_BYTES - 1);
  const plan = planChunks(4_999_999);
  assert.equal(plan.chunkSize, 4_999_999);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(contentRanges(plan, 4_999_999), ['bytes 0-4999998/4999999']);
});

test('cc-d2 5,000,000 bytes — MIN_WHOLE exactly — is a single chunk', () => {
  assert.equal(5_000_000, MIN_WHOLE_BYTES);
  const plan = planChunks(5_000_000);
  assert.equal(plan.chunkSize, 5_000_000);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(contentRanges(plan, 5_000_000), ['bytes 0-4999999/5000000']);
});

test('cc-d2 64,000,000 bytes — CHUNK_SIZE exactly — is a single chunk', () => {
  assert.equal(64_000_000, CHUNK_SIZE_BYTES);
  const plan = planChunks(64_000_000);
  assert.equal(plan.chunkSize, 64_000_000);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(contentRanges(plan, 64_000_000), ['bytes 0-63999999/64000000']);
});

test('cc-d2 64,000,001 bytes is ONE merged chunk larger than the declared chunk_size', () => {
  const plan = planChunks(64_000_001);
  assert.equal(plan.chunkSize, CHUNK_SIZE_BYTES);
  assert.equal(plan.totalChunkCount, 1);
  // The floor-merge in one line: the only chunk is a byte longer than the size
  // the init declares, and that is correct rather than a bug.
  assert.deepEqual(plan.chunks[0], {
    index: 0,
    start: 0,
    end: 64_000_000,
    size: 64_000_001,
  });
  assert.deepEqual(contentRanges(plan, 64_000_001), ['bytes 0-64000000/64000001']);
});

test('cc-d2 127,999,999 bytes is one chunk — the longest a merge can produce', () => {
  const plan = planChunks(127_999_999);
  assert.equal(plan.chunkSize, CHUNK_SIZE_BYTES);
  assert.equal(plan.totalChunkCount, 1);
  assert.equal(plan.chunks[0]?.size, MAX_FINAL_CHUNK_BYTES);
  assert.deepEqual(contentRanges(plan, 127_999_999), ['bytes 0-127999998/127999999']);
});

test('cc-d2 128,000,000 bytes is exactly two chunks of chunk_size', () => {
  const plan = planChunks(128_000_000);
  assert.equal(plan.chunkSize, CHUNK_SIZE_BYTES);
  assert.equal(plan.totalChunkCount, 2);
  assert.deepEqual(contentRanges(plan, 128_000_000), [
    'bytes 0-63999999/128000000',
    'bytes 64000000-127999999/128000000',
  ]);
});

test('cc-d2 128,000,001 bytes is two chunks whose final one is 64,000,001 bytes', () => {
  const plan = planChunks(128_000_001);
  assert.equal(plan.chunkSize, CHUNK_SIZE_BYTES);
  assert.equal(plan.totalChunkCount, 2);
  assert.equal(plan.chunks[1]?.size, 64_000_001);
  assert.deepEqual(contentRanges(plan, 128_000_001), [
    'bytes 0-63999999/128000001',
    'bytes 64000000-128000000/128000001',
  ]);
});

test('cc-d2 4,294,967,296 bytes (4 GiB) is accepted as 67 chunks that sum to the file', () => {
  const plan = planChunks(4_294_967_296);
  assert.equal(plan.totalChunkCount, 67);
  assert.ok(plan.totalChunkCount <= MAX_CHUNK_COUNT);
  const sum = plan.chunks.reduce((total, chunk) => total + chunk.size, 0);
  assert.equal(sum, 4_294_967_296);
});

test('cc-d1 4,294,967,297 bytes is rejected as file_too_large before any init', () => {
  assert.throws(
    () => planChunks(4_294_967_297),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_too_large');
      // The user has to act on this, so it names the real size and the cap.
      assert.ok(error.message.includes('4294967297'));
      assert.ok(error.message.includes(String(MAX_FILE_BYTES)));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// CC-D2 — local rejections (no network, no init)
// ---------------------------------------------------------------------------

test('cc-d2 a file size that is not a positive safe integer is invalid_params', () => {
  for (const fileSize of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => planChunks(fileSize),
      (error: unknown) => {
        assert.ok(isTikTokError(error), `no TikTokError for ${String(fileSize)}`);
        assert.equal(error.kind, 'validation');
        assert.equal(error.code, 'invalid_params');
        assert.ok(error.message.includes('positive integer'));
        assert.ok(error.message.includes(String(fileSize)));
        return true;
      },
    );
  }
});

test('cc-d2 a chunk-size override larger than the file is invalid_params', () => {
  assert.throws(
    () => planChunks(10_000_000, 20_000_000),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('no larger than the file'));
      assert.ok(error.message.includes('20000000'));
      return true;
    },
  );
});

test('cc-d2 a chunk-size override of 0 is invalid_params, not a fallback', () => {
  // `?? ` only defers to the constant for nullish, so an explicit 0 must be
  // rejected rather than quietly re-read as "use the default".
  assert.throws(
    () => planChunks(10_000_000, 0),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('got 0 for 10000000 bytes'));
      return true;
    },
  );
});

test('cc-d2 a fractional chunk-size override is invalid_params', () => {
  assert.throws(
    () => planChunks(10_000_000, 1_000_000.5),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('1000000.5'));
      return true;
    },
  );
});

test('cc-d2 an override that would need more than 1000 chunks is invalid_params', () => {
  assert.throws(
    () => planChunks(4_294_967_296, 1_000_000),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'invalid_params');
      // floor(4,294,967,296 / 1,000,000) = 4294 — four times upstream's cap.
      assert.ok(error.message.includes('4294 chunks'));
      assert.ok(error.message.includes(`1–${String(MAX_CHUNK_COUNT)}`));
      return true;
    },
  );
});

test('cc-d2 an override whose merged final chunk would exceed the 128 MB cap is rejected', () => {
  // Only reachable through an override: the production constant caps the merge
  // at 127,999,999 by construction, so this guards the guard.
  assert.throws(
    () => planChunks(199_999_999, 100_000_000),
    (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'invalid_params');
      assert.ok(error.message.includes('final chunk of 199999999 bytes'));
      assert.ok(error.message.includes(String(MAX_FINAL_CHUNK_BYTES)));
      return true;
    },
  );
});

test('cc-d2 the sub-5 MB whole-file rule overrides an explicit chunk-size override', () => {
  // TikTok mandates one whole-file chunk below MIN_WHOLE, so the override is
  // not merely clamped — it is ignored, and the plan is the file itself.
  const plan = planChunks(3_145_728, 1_000_000);
  assert.equal(plan.chunkSize, 3_145_728);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(contentRanges(plan, 3_145_728), ['bytes 0-3145727/3145728']);
});

// ---------------------------------------------------------------------------
// CC-D2 — the invariants as properties (seeded: TESTING.md forbids flakiness)
// ---------------------------------------------------------------------------

const PLAN_PROPERTY = { seed: 42, numRuns: 300 } as const;

test('cc-d2 property: every plan is 1–1000 chunks with in-bounds chunk lengths', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: MAX_FILE_BYTES }), (fileSize) => {
      const plan = planChunks(fileSize);

      assert.ok(plan.totalChunkCount >= 1, `count ${String(plan.totalChunkCount)}`);
      assert.ok(plan.totalChunkCount <= MAX_CHUNK_COUNT);
      assert.equal(plan.chunks.length, plan.totalChunkCount);

      plan.chunks.forEach((chunk, position) => {
        assert.equal(chunk.index, position);
        assert.equal(chunk.size, chunk.end - chunk.start + 1);
        if (position === plan.totalChunkCount - 1) {
          // The final chunk absorbs the remainder: never shorter than the
          // declared size, never past the cap the constant was chosen for.
          assert.ok(chunk.size >= plan.chunkSize);
          assert.ok(chunk.size <= MAX_FINAL_CHUNK_BYTES);
        } else {
          assert.equal(chunk.size, plan.chunkSize);
        }
      });
    }),
    PLAN_PROPERTY,
  );
});

test('cc-d2 property: ranges are contiguous, disjoint and cover exactly the file', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: MAX_FILE_BYTES }), (fileSize) => {
      const plan = planChunks(fileSize);

      let cursor = 0;
      let sum = 0;
      for (const chunk of plan.chunks) {
        // `start === cursor` is contiguity and disjointness at once: a gap or
        // an overlap both move the cursor away from the next start.
        assert.equal(chunk.start, cursor);
        cursor = chunk.end + 1;
        sum += chunk.size;
      }

      assert.equal(plan.chunks[0]?.start, 0);
      assert.equal(cursor, fileSize);
      assert.equal(sum, fileSize);
      assert.equal(plan.chunks[plan.chunks.length - 1]?.end, fileSize - 1);

      // Every denominator is the file size — the ladder is one file, not many.
      for (const range of contentRanges(plan, fileSize)) {
        assert.ok(range.endsWith(`/${String(fileSize)}`));
      }
    }),
    PLAN_PROPERTY,
  );
});

// ---------------------------------------------------------------------------
// CC-D8 — media-root confinement
// ---------------------------------------------------------------------------

/**
 * `fs.symlink` needs SeCreateSymbolicLinkPrivilege on win32, which neither a
 * developer shell nor CI grants by default.
 */
const POSIX_ONLY =
  process.platform === 'win32' ? 'symlink creation needs elevation on Windows' : false;

/**
 * The >4 GiB fixture is a sparse file: `truncate` sets the length without
 * allocating blocks, so it costs nothing on APFS/ext4. NTFS reserves the space
 * instead, and asking a CI runner for 4 GiB of real disk to exercise one
 * comparison is not a trade worth making.
 */
const SPARSE_ONLY =
  process.platform === 'win32' ? 'a sparse 4 GiB fixture is not free on NTFS' : false;

/**
 * The mtime every media fixture is written with — `BASELINE_NOW_MS` expressed
 * in seconds, so the fixtures agree with the harness clock.
 *
 * It is pinned rather than inherited because `verifyMediaFile` compares
 * `mtimeMs` **exactly**: two writes inside the same millisecond are
 * indistinguishable to it, which would make a change-detection test pass or
 * fail on how fast the machine is.
 */
const PINNED_MTIME_S = BASELINE_NOW_MS / 1000;

/**
 * A sandbox holding a `media` root *inside* it, so a test can also place files
 * as siblings of the root — which is what the traversal and prefix-collision
 * negatives need. Never a hard-coded POSIX path: `path.join` keeps the win32
 * leg of CI honest.
 */
async function mediaBox(): Promise<{
  outer: string;
  root: string;
  cleanup(): Promise<void>;
}> {
  const box = await fsSandbox();
  const root = path.join(box.dir, 'media');
  await mkdir(root);
  return { outer: box.dir, root, cleanup: () => box.cleanup() };
}

async function writeMedia(
  file: string,
  content: string,
  mtimeSeconds: number = PINNED_MTIME_S,
): Promise<void> {
  await writeFile(file, content);
  await utimes(file, mtimeSeconds, mtimeSeconds);
}

test('cc-d8 a file under the root resolves canonically and carries its identity', async () => {
  const box = await mediaBox();
  try {
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');

    const media = await resolveMediaFile(clip, box.root);
    const stats = await stat(clip);

    assert.equal(media.path, clip);
    assert.ok(path.isAbsolute(media.path));
    assert.equal(media.size, 17);
    assert.equal(media.size, stats.size);
    // The whole four-tuple is populated: size alone misses a same-length edit,
    // mtime alone misses a swap that preserved it.
    assert.equal(media.mtimeMs, PINNED_MTIME_S * 1000);
    assert.equal(media.mtimeMs, stats.mtimeMs);
    assert.equal(media.dev, stats.dev);
    assert.equal(media.ino, stats.ino);
    assert.ok(media.ino > 0);
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 an unconfigured media root fails closed and points at source "url"', async () => {
  const box = await mediaBox();
  try {
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');

    // Both spellings of "unset": absent, and present-but-empty (which is what
    // `TT_MEDIA_ROOT=` normalizes to). There is deliberately no CWD fallback.
    for (const root of [undefined, '']) {
      await assert.rejects(resolveMediaFile(clip, root), (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.kind, 'config');
        assert.equal(error.code, 'media_root_not_configured');
        assert.ok(error.message.includes('TT_MEDIA_ROOT'));
        assert.ok(error.message.includes('use source "url"'));
        return true;
      });
    }
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 a media root that does not exist is a config error naming the root', async () => {
  const box = await mediaBox();
  try {
    const missingRoot = path.join(box.outer, 'no-such-root');
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');

    await assert.rejects(resolveMediaFile(clip, missingRoot), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'config');
      assert.equal(error.code, 'media_root_not_configured');
      // The operator has to fix this, so the value they set is quoted back.
      assert.ok(error.message.includes(missingRoot));
      assert.ok(error.message.includes('does not exist or cannot be read'));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 a relative file_path resolves against the root, never the CWD', async () => {
  const box = await mediaBox();
  try {
    await mkdir(path.join(box.root, 'sub'));
    const clip = path.join(box.root, 'sub', 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');

    const media = await resolveMediaFile(path.join('sub', 'clip.mp4'), box.root);

    assert.equal(media.path, clip);
    assert.equal(path.relative(box.root, media.path), path.join('sub', 'clip.mp4'));
    // Under an agent the working directory is attacker-influenced, so the fact
    // that it played no part is the assertion.
    assert.notEqual(path.dirname(media.path), process.cwd());
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 an absolute path outside the root is file_outside_media_root', async () => {
  const box = await mediaBox();
  try {
    const outside = path.join(box.outer, 'outside.mp4');
    await writeMedia(outside, 'outside the root');

    await assert.rejects(resolveMediaFile(outside, box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_outside_media_root');
      assert.ok(error.message.includes(outside));
      assert.ok(error.message.includes(box.root));
      assert.ok(error.message.includes('Do not attempt alternative paths'));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 a .. traversal that climbs out of the root is file_outside_media_root', async () => {
  const box = await mediaBox();
  try {
    const outside = path.join(box.outer, 'outside.mp4');
    await writeMedia(outside, 'outside the root');

    // The file exists, so this is genuinely the containment check firing and
    // not ENOENT wearing its coat.
    await assert.rejects(
      resolveMediaFile(path.join('..', 'outside.mp4'), box.root),
      (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'file_outside_media_root');
        assert.ok(error.message.includes(outside));
        return true;
      },
    );
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 the root directory itself is not a file inside the root', async () => {
  const box = await mediaBox();
  try {
    // `path.relative(root, root)` is `""`, which the source treats as "not
    // strictly inside" — the containment check runs before the isFile check.
    await assert.rejects(resolveMediaFile(box.root, box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_outside_media_root');
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 a sibling directory that merely prefixes the root name is rejected', async () => {
  const box = await mediaBox();
  try {
    // The whole point of `path.relative` over `startsWith`: `<tmp>/media-evil`
    // begins with `<tmp>/media` as a string and is nowhere near it as a path.
    const evilDir = path.join(box.outer, 'media-evil');
    await mkdir(evilDir);
    const evil = path.join(evilDir, 'clip.mp4');
    await writeMedia(evil, 'not really an mp4');

    assert.ok(evil.startsWith(box.root), 'the fixture must be a string-prefix match');

    await assert.rejects(resolveMediaFile(evil, box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_outside_media_root');
      assert.ok(error.message.includes(evil));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test(
  'cc-d8 a symlink inside the root pointing outside it is rejected, not followed',
  { skip: POSIX_ONLY },
  async () => {
    const box = await mediaBox();
    try {
      const outside = path.join(box.outer, 'outside.mp4');
      await writeMedia(outside, 'outside the root');
      const link = path.join(box.root, 'link.mp4');
      await symlink(outside, link);

      await assert.rejects(resolveMediaFile('link.mp4', box.root), (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.code, 'file_outside_media_root');
        // The *resolved* target is reported: containment ran after realpath,
        // which is the only order that catches this.
        assert.ok(error.message.includes(outside));
        return true;
      });
    } finally {
      await box.cleanup();
    }
  },
);

test(
  'cc-d1 a dangling symlink is file_not_found, revealing nothing about the target',
  { skip: POSIX_ONLY },
  async () => {
    const box = await mediaBox();
    try {
      const link = path.join(box.root, 'dead.mp4');
      await symlink(path.join(box.outer, 'ghost.mp4'), link);

      await assert.rejects(resolveMediaFile('dead.mp4', box.root), (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.kind, 'validation');
        assert.equal(error.code, 'file_not_found');
        // The candidate is named, never the target it failed to reach.
        assert.ok(error.message.includes(link));
        assert.equal(error.message.includes('ghost.mp4'), false);
        return true;
      });
    } finally {
      await box.cleanup();
    }
  },
);

test('cc-d1 a file_path that does not exist under the root is file_not_found', async () => {
  const box = await mediaBox();
  try {
    await assert.rejects(resolveMediaFile('ghost.mp4', box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_not_found');
      assert.ok(error.message.includes(path.join(box.root, 'ghost.mp4')));
      assert.ok(error.message.includes(box.root));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d8 a directory inside the root is not a regular file', async () => {
  const box = await mediaBox();
  try {
    const dir = path.join(box.root, 'clips');
    await mkdir(dir);

    await assert.rejects(resolveMediaFile('clips', box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_not_found');
      assert.ok(error.message.includes('is not a regular file'));
      assert.ok(error.message.includes(dir));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d1 a zero-byte file is file_empty, so no init is spent on it', async () => {
  const box = await mediaBox();
  try {
    const empty = path.join(box.root, 'empty.mp4');
    await writeMedia(empty, '');

    await assert.rejects(resolveMediaFile('empty.mp4', box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_empty');
      // TOOLS.md § 3.0 catalog text, asserted rather than paraphrased.
      assert.ok(error.message.includes('is an empty file (0 bytes)'));
      assert.ok(error.message.includes(empty));
      assert.ok(error.message.includes(box.root));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test(
  'cc-d1 a file over 4 GiB is file_too_large at resolve time, before any init',
  { skip: SPARSE_ONLY },
  async () => {
    const box = await mediaBox();
    try {
      // 4 GiB + 1 byte, as a *sparse* file: `truncate` sets the length without
      // allocating a single block (verified: st_blocks === 0), so this costs
      // nothing on disk and runs in under a millisecond. Nothing reads the
      // bytes — `resolveMediaFile` rejects on `stat().size` alone, which is the
      // whole point of the guard: no init is spent and no byte is read.
      const huge = path.join(box.root, 'huge.mp4');
      await writeFile(huge, '');
      await truncate(huge, MAX_FILE_BYTES + 1);
      assert.equal((await stat(huge)).size, MAX_FILE_BYTES + 1);

      await assert.rejects(resolveMediaFile('huge.mp4', box.root), (error: unknown) => {
        assert.ok(isTikTokError(error));
        assert.equal(error.kind, 'validation');
        assert.equal(error.code, 'file_too_large');
        assert.ok(error.message.includes(String(MAX_FILE_BYTES + 1)));
        assert.ok(error.message.includes(String(MAX_FILE_BYTES)));
        return true;
      });
    } finally {
      await box.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// CC-D3 / CC-D4 — the apply-time re-resolution
// ---------------------------------------------------------------------------

test('cc-d3 an untouched file verifies to an identical MediaFile', async () => {
  const box = await mediaBox();
  try {
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');

    const planned = await resolveMediaFile(clip, box.root);
    const applied = await verifyMediaFile(planned, box.root);

    assert.deepEqual(applied, planned);
  } finally {
    await box.cleanup();
  }
});

test('cc-d3 a same-length rewrite is caught as plan_mismatch', async () => {
  const box = await mediaBox();
  try {
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');
    const planned = await resolveMediaFile(clip, box.root);

    // Same byte count, different bytes — so `size` cannot see it and only the
    // mtime can. The mtime is bumped explicitly because a rewrite this fast
    // lands in the same millisecond, which would make the test pass or fail on
    // machine speed rather than on the code being tested.
    await writeMedia(clip, 'NOT REALLY AN MP4', PINNED_MTIME_S + 60);
    assert.equal((await stat(clip)).size, planned.size);

    await assert.rejects(verifyMediaFile(planned, box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'policy');
      assert.equal(error.code, 'plan_mismatch');
      assert.ok(error.message.includes('The file changed since plan'));
      assert.ok(error.message.includes(clip));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d3 a swap that preserves size and mtime is caught by the inode', async () => {
  const box = await mediaBox();
  try {
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');
    const planned = await resolveMediaFile(clip, box.root);

    // `rename` rather than unlink+create: both files exist at once, so the new
    // inode is guaranteed to differ (a freed inode number can be reused
    // immediately on ext4, which would make unlink+create flaky).
    const replacement = path.join(box.root, 'replacement.tmp');
    await writeMedia(replacement, 'NOT REALLY AN MP4');
    await rename(replacement, clip);

    const current = await stat(clip);
    assert.equal(current.size, planned.size, 'the swap must preserve the size');
    assert.equal(current.mtimeMs, planned.mtimeMs, 'the swap must preserve the mtime');
    assert.notEqual(current.ino, planned.ino, 'the swap must change the inode');

    await assert.rejects(verifyMediaFile(planned, box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'policy');
      assert.equal(error.code, 'plan_mismatch');
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

test('cc-d4 a file deleted between plan and apply is file_not_found', async () => {
  const box = await mediaBox();
  try {
    const clip = path.join(box.root, 'clip.mp4');
    await writeMedia(clip, 'not really an mp4');
    const planned = await resolveMediaFile(clip, box.root);

    await rm(clip);

    // Re-resolution, not a re-stat of the recorded path, so the answer is the
    // same local rejection a fresh call would give — and no init is spent.
    await assert.rejects(verifyMediaFile(planned, box.root), (error: unknown) => {
      assert.ok(isTikTokError(error));
      assert.equal(error.kind, 'validation');
      assert.equal(error.code, 'file_not_found');
      assert.ok(error.message.includes(clip));
      return true;
    });
  } finally {
    await box.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CC-D9 — extension → MIME
// ---------------------------------------------------------------------------

test('cc-d9 contentTypeFor maps the accepted containers to their MIME types', () => {
  const base = path.join('media', 'clip');
  assert.equal(contentTypeFor(`${base}.mp4`), 'video/mp4');
  assert.equal(contentTypeFor(`${base}.m4v`), 'video/mp4');
  assert.equal(contentTypeFor(`${base}.mov`), 'video/quicktime');
  assert.equal(contentTypeFor(`${base}.qt`), 'video/quicktime');
  assert.equal(contentTypeFor(`${base}.webm`), 'video/webm');
});

test('cc-d9 contentTypeFor ignores case and falls back to video/mp4', () => {
  assert.equal(contentTypeFor(path.join('media', 'CLIP.MP4')), 'video/mp4');
  assert.equal(contentTypeFor(path.join('media', 'clip.MoV')), 'video/quicktime');
  // Refusing an unknown extension locally would invent an error code the
  // § 3.0 catalog does not have; TikTok validates by content anyway (CC-D9).
  assert.equal(contentTypeFor(path.join('media', 'clip.avi')), 'video/mp4');
  assert.equal(contentTypeFor(path.join('media', 'clip')), 'video/mp4');
  assert.equal(contentTypeFor(path.join('media', 'clip.')), 'video/mp4');
});

test('cc-d9 contentTypeFor never returns an inherited Object.prototype member', () => {
  // The extension is user-controlled and was once looked up on an object
  // literal, so `clip.constructor` resolved to a *function* and went straight
  // past the `??` fallback into the Content-Type header. The lookup table is a
  // Map for exactly this reason; these keys are the regression pin.
  for (const key of [
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
  ]) {
    const result = contentTypeFor(path.join('media', `clip.${key}`));
    assert.equal(typeof result, 'string', `contentTypeFor(.${key}) must return a string`);
    assert.equal(result, 'video/mp4');
  }
});
