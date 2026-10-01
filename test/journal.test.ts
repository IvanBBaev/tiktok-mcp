/**
 * `mcp/journal.ts` — the publish write-ahead log.
 *
 * What these tests are actually protecting:
 *
 * 1. **The journal can never break a publish.** Every write path is exercised
 *    with a broken filesystem underneath (unwritable parent, un-rotatable
 *    generation) and must come back `{ ok: false }` plus a warning instead of
 *    throwing into a caller that is mid-post.
 * 2. **`"unknown"` is derived, never stored.** An intent with no outcome folds
 *    to `unknown`; that is the crash-mid-publish signal (CC-E10) and the only
 *    thing standing between a user and a silent double-post.
 * 3. **The duplicate guard is conservative in the right direction.** Ten
 *    minutes, `ok`/ambiguous/unknown only, a bounded tail that reaches into `.1`
 *    when the active file is short, and a clock that stepped backwards makes
 *    it *more* suspicious, not less (CC-H1).
 * 4. **A damaged file degrades, it does not fail.** Torn tails, unknown
 *    versions and malformed records are skipped and *counted*, so a reader can
 *    tell "nothing happened" from "I could not read what happened".
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsp, {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';

import { envLockDir } from '../src/core/env-lock.js';
import { registerSecret } from '../src/core/redact.js';
import type { Logger } from '../src/core/log.js';
import {
  appendIntent,
  appendOutcome,
  checkDuplicate,
  DUPLICATE_WINDOW_MS,
  foldAttempts,
  foldedAttemptsCached,
  journalExists,
  journalTimestamp,
  mintAttemptId,
  readMerged,
  resolveJournalPath,
  TITLE_EXCERPT_MAX,
  titleExcerpt,
  type IntentRecord,
  type JournalAttempt,
  type JournalRecord,
  type OutcomeRecord,
} from '../src/mcp/journal.js';
import { BASELINE_NOW_MS, fsSandbox, mockClock, withEnv } from './helpers.js';

// fixtures --------------------------------------------------------------

const POSIX = process.platform !== 'win32';

/**
 * A regular file standing where a parent directory belongs is how `open` is
 * made to fail with a real errno other than ENOENT without touching
 * permissions — and unlike `chmod 000` it still denies root, which a container
 * CI runs as. win32 reports the same layout as ENOENT, which `isMissing` reads
 * as the tolerated "no journal yet".
 */
const canFailOpen: { skip?: string } = POSIX
  ? {}
  : { skip: 'ENOTDIR: win32 reports ENOENT for a file used as a directory' };

/** A journal path whose parent is a regular file, so every `open` is ENOTDIR. */
async function blockedPath(dir: string): Promise<string> {
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'not a directory');
  return join(blocker, 'journal.ndjson');
}

function intent(over: Partial<IntentRecord> = {}): IntentRecord {
  return {
    v: 1,
    type: 'intent',
    attempt_id: '01JQ0000000000000000000000',
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'tiktok_post_video',
    profile: 'default',
    open_id: 'open-1',
    plan_id: 'plan-1',
    payload_digest: 'digest-1',
    title_excerpt: 'A clip',
    source: 'FILE_UPLOAD',
    mode: 'direct',
    ...over,
  };
}

function outcome(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    v: 1,
    type: 'outcome',
    attempt_id: '01JQ0000000000000000000000',
    ts: '2026-01-01T00:00:01.000Z',
    result: 'ok',
    ...over,
  };
}

interface Recorded {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

function recordingLogger(): { logger: Logger; lines: Recorded[] } {
  const lines: Recorded[] = [];
  const push =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push(fields === undefined ? { level, msg } : { level, msg, fields });
    };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, lines };
}

/** Every test writes into its own temp dir; the path is the only shared state. */
async function sandbox(): Promise<{
  path: string;
  dir: string;
  // A property-typed function, not a method signature: these are destructured
  // at every call site, and a method signature would trip `unbound-method`.
  cleanup: () => Promise<void>;
}> {
  const created = await fsSandbox();
  return {
    path: join(created.dir, 'journal.ndjson'),
    dir: created.dir,
    cleanup: () => created.cleanup(),
  };
}

async function lines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

/** `JSON.parse` hands back `any`; narrow it once here instead of at each site. */
function parseLine(line: string | undefined): Record<string, unknown> {
  const value: unknown = JSON.parse(line ?? '');
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// path resolution -------------------------------------------------------

test('journal path: an explicit path wins over every other input', () => {
  assert.equal(resolveJournalPath({ path: '/tmp/x.ndjson' }), '/tmp/x.ndjson');
});

test('journal path: sits beside the resolved env file', () => {
  const envFile = join('srv', 'tiktok', '.env');
  assert.equal(resolveJournalPath({ envFile }), join('srv', 'tiktok', 'journal.ndjson'));
});

test('journal path: falls back to TT_ENV_FILE when no env file was passed', async () => {
  // Through a real directory: `resolveEnvFilePath` absolutizes the override, so
  // a hand-written literal would not survive the Windows leg.
  const created = await fsSandbox();
  try {
    const resolved = withEnv({ TT_ENV_FILE: join(created.dir, 'creds.env') }, () =>
      resolveJournalPath(),
    );
    assert.equal(resolved, join(created.dir, 'journal.ndjson'));
  } finally {
    await created.cleanup();
  }
});

// ids, timestamps, excerpts ---------------------------------------------

test('attempt id: 26 Crockford characters, no ambiguous letters', () => {
  const clock = mockClock();
  const id = mintAttemptId(clock);
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u);
});

test('attempt id: sorts chronologically, so file order is time order', () => {
  const clock = mockClock();
  const first = mintAttemptId(clock);
  clock.setNow(BASELINE_NOW_MS + 60_000);
  const second = mintAttemptId(clock);
  assert.ok(second > first, `${second} should sort after ${first}`);
});

test('attempt id: two attempts in the same millisecond stay distinct', () => {
  const clock = mockClock();
  assert.notEqual(mintAttemptId(clock), mintAttemptId(clock));
});

test('journal timestamp: ISO-8601 UTC taken from the clock seam', () => {
  const clock = mockClock();
  assert.equal(journalTimestamp(clock), new Date(BASELINE_NOW_MS).toISOString());
});

test('title excerpt: collapses whitespace and keeps short titles verbatim', () => {
  assert.equal(titleExcerpt('  a\n\t b  '), 'a b');
});

test('title excerpt: cuts to the cap with an ellipsis', () => {
  const excerpt = titleExcerpt('x'.repeat(200));
  assert.equal([...excerpt].length, TITLE_EXCERPT_MAX);
  assert.ok(excerpt.endsWith('…'));
});

test('title excerpt: counts code points, never splitting a surrogate pair', () => {
  // 60 astral characters: a UTF-16 slice at 47 units would land mid-pair and
  // put a lone surrogate in the file.
  const excerpt = titleExcerpt('🎬'.repeat(60));
  assert.equal([...excerpt].length, TITLE_EXCERPT_MAX);
  assert.ok(!/[\uD800-\uDFFF]/u.test(excerpt.replaceAll('🎬', '')));
});

// appending -------------------------------------------------------------

test('append: the first write stamps a header and the record together', async () => {
  const { path, cleanup } = await sandbox();
  try {
    const result = await appendIntent(intent(), {
      path,
      createdBy: 'tiktok-mcp-ai@1.2.3',
    });
    assert.deepEqual(result, { ok: true });

    const written = await lines(path);
    assert.equal(written.length, 2);
    assert.deepEqual(parseLine(written[0]), {
      v: 1,
      type: 'header',
      created_by: 'tiktok-mcp-ai@1.2.3',
    });
    assert.equal(parseLine(written[1]).type, 'intent');

    // The `open` mode alone gives 0600 — no follow-up chmod on a path.
    if (POSIX) assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});

test('append: a missing parent directory is created 0700, not left to fail', async () => {
  const { dir, cleanup } = await sandbox();
  try {
    const path = join(dir, 'nested', 'journal.ndjson');
    assert.deepEqual(await appendIntent(intent(), { path }), { ok: true });
    if (POSIX) {
      const { mode } = await stat(join(dir, 'nested'));
      assert.equal(mode & 0o777, 0o700);
    }
  } finally {
    await cleanup();
  }
});

test('append: the header is written once, not before every record', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent(), { path });
    await appendOutcome(outcome(), { path });
    await appendIntent(intent({ attempt_id: 'B' }), { path });

    const types = (await lines(path)).map((line) => parseLine(line).type);
    assert.deepEqual(types, ['header', 'intent', 'outcome', 'intent']);
  } finally {
    await cleanup();
  }
});

test('append: the header falls back to an unknown version rather than omitting one', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent(), { path });
    assert.equal(
      parseLine((await lines(path))[0]).created_by,
      'tiktok-mcp-ai@0.0.0-unknown',
    );
  } finally {
    await cleanup();
  }
});

test('append: fields land in the documented order with absent optionals dropped', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendOutcome(outcome({ publish_id: 'pub-1' }), { path });
    const parsed = parseLine((await lines(path))[1]);
    assert.deepEqual(Object.keys(parsed), [
      'v',
      'type',
      'attempt_id',
      'ts',
      'result',
      'publish_id',
    ]);
  } finally {
    await cleanup();
  }
});

test('append: an over-long title is cut on the way to disk, not by the caller', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ title_excerpt: 'y'.repeat(300) }), { path });
    const parsed = parseLine((await lines(path))[1]);
    assert.equal([...String(parsed.title_excerpt)].length, TITLE_EXCERPT_MAX);
  } finally {
    await cleanup();
  }
});

test('append: a registered secret never reaches the file', async () => {
  const { path, cleanup } = await sandbox();
  try {
    const secret = 'act.journal-secret-value-0001';
    registerSecret(secret);
    await appendOutcome(
      outcome({ result: 'error', fail_reason: `denied for ${secret}` }),
      {
        path,
      },
    );
    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes(secret));
    assert.ok(text.includes('[REDACTED]'));
    // The line is still valid JSON — redaction happens per value, not on the
    // serialized line.
    assert.equal(parseLine((await lines(path))[1]).result, 'error');
  } finally {
    await cleanup();
  }
});

test('append: an unwritable location warns and returns not-ok instead of throwing', async () => {
  const { dir, cleanup } = await sandbox();
  try {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const { logger, lines: logged } = recordingLogger();

    const result = await appendIntent(intent(), {
      path: join(blocker, 'journal.ndjson'),
      logger,
    });

    assert.deepEqual(result, { ok: false });
    const warning = logged.find((line) => line.level === 'warn');
    assert.ok(warning !== undefined);
    assert.match(warning.msg, /publish is unaffected/u);
  } finally {
    await cleanup();
  }
});

test('append: a torn last line gets a newline first, so the next record stays readable', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent(), { path });
    // A crash mid-write: the fragment has no terminating newline.
    await appendFile(path, '{"v":1,"type":"outc');

    assert.deepEqual(await appendIntent(intent({ attempt_id: 'B' }), { path }), {
      ok: true,
    });

    const text = await readFile(path, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(text.includes('{"v":1,"type":"outc\n{'));
    const { records, skippedLines } = await readMerged({ path });
    assert.equal(skippedLines, 1);
    assert.deepEqual(
      records.flatMap((r) => (r.type === 'intent' ? [r.attempt_id] : [])),
      ['01JQ0000000000000000000000', 'B'],
    );
  } finally {
    await cleanup();
  }
});

test('append: a file that already ends in a newline gets no extra blank line', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent(), { path });
    await appendOutcome(outcome(), { path });

    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes('\n\n'));
    assert.deepEqual((await readMerged({ path })).skippedLines, 0);
  } finally {
    await cleanup();
  }
});

test('append: a short write warns and returns not-ok — a partial line is no record', async () => {
  const { path, cleanup } = await sandbox();
  // The FileHandle class is not exported; a real handle hands over its prototype.
  const probe = await fsp.open(path, 'a+');
  const proto = Object.getPrototypeOf(probe) as {
    write: (...args: unknown[]) => Promise<{ bytesWritten: number; buffer: unknown }>;
  };
  await probe.close();
  await rm(path);
  const original = proto.write;
  try {
    proto.write = async function shortWrite(
      this: unknown,
      ...args: unknown[]
    ): Promise<{ bytesWritten: number; buffer: unknown }> {
      const result = await original.apply(this, args);
      return { ...result, bytesWritten: result.bytesWritten - 1 };
    };
    const { logger, lines: logged } = recordingLogger();

    assert.deepEqual(await appendIntent(intent(), { path, logger }), { ok: false });

    const warning = logged.find((line) => line.level === 'warn');
    assert.ok(warning !== undefined);
    assert.match(warning.msg, /publish is unaffected/u);
    assert.match(String(warning.fields?.['reason']), /short journal write/u);
  } finally {
    proto.write = original;
    await cleanup();
  }
});

// rotation --------------------------------------------------------------

test('rotation: an oversized generation is rotated before the next intent', async () => {
  const { path, cleanup } = await sandbox();
  try {
    const { logger, lines: logged } = recordingLogger();
    await appendIntent(intent({ attempt_id: 'A' }), { path, maxBytes: 10, logger });
    await appendIntent(intent({ attempt_id: 'B' }), { path, maxBytes: 10, logger });

    assert.equal((await lines(`${path}.1`)).length, 2); // header + A
    assert.equal((await lines(path)).length, 2); // header + B
    assert.ok(logged.some((line) => line.msg.includes('rotated')));
    // The rotation lock is held only for the rename and released afterwards.
    assert.ok(!existsSync(envLockDir(path)), 'rotation lock released');
    assert.equal(envLockDir(path), `${path}.lock`);
  } finally {
    await cleanup();
  }
});

test('rotation: only one generation survives; the older one is discarded', async () => {
  const { path, cleanup } = await sandbox();
  try {
    for (const id of ['A', 'B', 'C']) {
      await appendIntent(intent({ attempt_id: id }), { path, maxBytes: 10 });
    }
    const merged = await readMerged({ path });
    const ids = merged.records
      .filter((record): record is IntentRecord => record.type === 'intent')
      .map((record) => record.attempt_id);
    assert.deepEqual(ids, ['B', 'C']);
  } finally {
    await cleanup();
  }
});

test('rotation: an outcome never rotates, so it cannot be split from its intent', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent(), { path, maxBytes: 5_000_000 });
    await appendOutcome(outcome(), { path, maxBytes: 10 });
    await assert.rejects(stat(`${path}.1`));
    assert.equal((await lines(path)).length, 3);
  } finally {
    await cleanup();
  }
});

test('rotation: a failed rotation warns and still appends the record', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // A non-empty directory cannot be replaced by `rename`.
    await mkdir(`${path}.1`);
    await writeFile(join(`${path}.1`, 'occupied'), 'x');
    await appendIntent(intent({ attempt_id: 'A' }), { path, maxBytes: 10 });

    const { logger, lines: logged } = recordingLogger();
    const result = await appendIntent(intent({ attempt_id: 'B' }), {
      path,
      maxBytes: 10,
      logger,
    });

    assert.deepEqual(result, { ok: true });
    assert.ok(
      logged.some((line) => line.level === 'warn' && line.msg.includes('rotate')),
    );
    assert.equal((await lines(path)).length, 3);
  } finally {
    await cleanup();
  }
});

// rotation lock ---------------------------------------------------------

/** `chmod` denies nothing to root, and nothing at all on win32. */
const canDenyAccess: { skip?: string } = !POSIX
  ? { skip: 'chmod-based access denial: win32 does not honour POSIX mode bits' }
  : process.getuid?.() === 0
    ? { skip: 'chmod-based access denial: root bypasses POSIX mode bits' }
    : {};

/**
 * Stand in for another process that holds the rotation lock and rotates the
 * journal while this one waits. The lock directory is pre-created (fresh
 * mtime, so live), and the first `mkdir` of it — the one that meets `EEXIST`
 * and sends `appendIntent` into its retry sleep — runs `rival` and then
 * releases the lock. The unlocked size check has necessarily happened by then
 * (the lock is only taken after it saw an over-cap file), so the re-check under
 * the lock is the only thing that can prevent a second rotation.
 */
async function rivalRotation(
  path: string,
  rival: () => Promise<void>,
): Promise<{ lockAttempts: () => number; restore: () => void }> {
  const lockDir = envLockDir(path);
  await mkdir(lockDir);
  const realMkdir = fsp.mkdir;
  let attempts = 0;
  const spy = mock.method(
    fsp,
    'mkdir',
    async (...args: Parameters<typeof fsp.mkdir>): Promise<string | undefined> => {
      if (args[0] !== lockDir) return await realMkdir(...args);
      attempts += 1;
      try {
        return await realMkdir(...args);
      } finally {
        if (attempts === 1) {
          await rival();
          await rm(lockDir, { recursive: true, force: true });
        }
      }
    },
  );
  syncBuiltinESMExports();
  return {
    lockAttempts: () => attempts,
    restore: () => {
      spy.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

test('rotation lock: a rotation done while waiting for the lock is not repeated', async () => {
  const { path, cleanup } = await sandbox();
  await appendIntent(intent({ attempt_id: 'A' }), { path });
  const original = await readFile(path, 'utf8');
  const rival = await rivalRotation(path, async () => {
    // The other process rotates and then records an attempt of its own, so the
    // active generation is back but small.
    await rename(path, `${path}.1`);
    await appendOutcome(outcome({ attempt_id: 'X' }), { path });
  });
  try {
    const { logger, lines: logged } = recordingLogger();
    const result = await appendIntent(intent({ attempt_id: 'B' }), {
      path,
      maxBytes: original.length,
      logger,
    });

    assert.deepEqual(result, { ok: true });
    // It waited (EEXIST), then took the lock once the rival released it.
    assert.equal(rival.lockAttempts(), 2);
    // `.1` still holds the generation the rival rotated out — not the rival's
    // fresh one, which a second rename would have retired over it.
    assert.equal(await readFile(`${path}.1`, 'utf8'), original);
    const active = (await lines(path)).map((line) => parseLine(line));
    assert.deepEqual(
      active.map((record) => [record['type'], record['attempt_id']]),
      [
        ['header', undefined],
        ['outcome', 'X'],
        ['intent', 'B'],
      ],
    );
    assert.ok(!logged.some((line) => line.msg.includes('rotated')));
    assert.ok(!logged.some((line) => line.level === 'warn'));
    assert.ok(!existsSync(envLockDir(path)), 'rotation lock released');
  } finally {
    rival.restore();
    await cleanup();
  }
});

test('rotation lock: an active generation the rival rotated away is not rotated again', async () => {
  const { path, cleanup } = await sandbox();
  await appendIntent(intent({ attempt_id: 'A' }), { path });
  const original = await readFile(path, 'utf8');
  // The rival only rotates: the active generation is absent under the lock.
  const rival = await rivalRotation(path, () => rename(path, `${path}.1`));
  try {
    const { logger, lines: logged } = recordingLogger();
    const result = await appendIntent(intent({ attempt_id: 'B' }), {
      path,
      maxBytes: 10,
      logger,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(rival.lockAttempts(), 2);
    assert.equal(await readFile(`${path}.1`, 'utf8'), original);
    const active = (await lines(path)).map((line) => parseLine(line));
    assert.deepEqual(
      active.map((record) => [record['type'], record['attempt_id']]),
      [
        ['header', undefined],
        ['intent', 'B'],
      ],
    );
    assert.ok(!logged.some((line) => line.msg.includes('rotated')));
    assert.ok(!logged.some((line) => line.level === 'warn'));
    assert.ok(!existsSync(envLockDir(path)), 'rotation lock released');
  } finally {
    rival.restore();
    await cleanup();
  }
});

test('rotation lock: concurrent intents on an over-cap journal rotate once and lose nothing', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // Intent and outcome, so the over-cap generation is strictly larger than a
    // fresh one holding a single intent: whichever append rotates second must
    // see a generation under the cap, not one that happens to be as large.
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    await appendOutcome(outcome({ attempt_id: 'A' }), { path });
    const original = await readFile(path, 'utf8');
    const { logger, lines: logged } = recordingLogger();
    const opts = { path, maxBytes: original.length, logger };

    const results = await Promise.all([
      appendIntent(intent({ attempt_id: 'B' }), opts),
      appendIntent(intent({ attempt_id: 'C' }), opts),
    ]);

    assert.deepEqual(results, [{ ok: true }, { ok: true }]);
    assert.equal(logged.filter((line) => line.msg.includes('rotated')).length, 1);
    assert.ok(!logged.some((line) => line.level === 'warn'));
    assert.equal(await readFile(`${path}.1`, 'utf8'), original);
    const ids = (await readMerged({ path })).records
      .filter((record): record is IntentRecord => record.type === 'intent')
      .map((record) => record.attempt_id)
      .sort();
    assert.deepEqual(ids, ['A', 'B', 'C']);
    assert.ok(!existsSync(envLockDir(path)), 'rotation lock released');
  } finally {
    await cleanup();
  }
});

test('rotation lock: a holder that never releases within 2 s warns and still appends', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    // A live holder: fresh mtime, far inside the 15 s stale threshold, so the
    // wait runs out its whole 2 s budget (env-lock is on the system clock here).
    await mkdir(envLockDir(path));

    const { logger, lines: logged } = recordingLogger();
    const result = await appendIntent(intent({ attempt_id: 'B' }), {
      path,
      maxBytes: 10,
      logger,
    });

    assert.deepEqual(result, { ok: true });
    const warn = logged.find((line) => line.level === 'warn');
    assert.equal(warn?.msg, 'could not rotate the publish journal; it keeps growing');
    assert.equal(warn.fields?.['path'], path);
    assert.match(String(warn.fields?.['reason']), /did not release/);
    // The lock is named for what it guards here, not for the credential file
    // whose mutex it borrows.
    assert.match(
      String(warn.fields?.['reason']),
      /another tiktok-mcp-ai process is updating the publish journal /,
    );
    assert.doesNotMatch(String(warn.fields?.['reason']), /credential file/);
    assert.ok(!logged.some((line) => line.msg.includes('rotated')));
    // Unrotated: the record joined the over-cap generation.
    await assert.rejects(stat(`${path}.1`));
    assert.deepEqual(
      (await lines(path)).map((line) => parseLine(line)['attempt_id']),
      [undefined, 'A', 'B'],
    );
    // The other holder's lock is not this process's to remove.
    assert.ok(existsSync(envLockDir(path)), 'foreign lock left in place');
  } finally {
    await cleanup();
  }
});

test(
  'rotation lock: an unusable lock location warns and still appends',
  canDenyAccess,
  async () => {
    const { dir, path, cleanup } = await sandbox();
    try {
      await appendIntent(intent({ attempt_id: 'A' }), { path });
      // The existing journal stays appendable, but no lock directory (and no
      // rename) can be made in a read-only parent.
      await chmod(dir, 0o500);

      const { logger, lines: logged } = recordingLogger();
      const result = await appendIntent(intent({ attempt_id: 'B' }), {
        path,
        maxBytes: 10,
        logger,
      });

      assert.deepEqual(result, { ok: true });
      const warn = logged.find((line) => line.level === 'warn');
      assert.equal(warn?.msg, 'could not rotate the publish journal; it keeps growing');
      assert.match(
        String(warn.fields?.['reason']),
        /the journal rotation lock directory .+ could not be created \([A-Z]+\), so concurrent writes to the publish journal cannot be made safe/,
      );
      assert.doesNotMatch(String(warn.fields?.['reason']), /env-file|credential file/);
      assert.ok(!existsSync(envLockDir(path)));
      assert.ok(!existsSync(`${path}.1`));
      assert.deepEqual(
        (await lines(path)).map((line) => parseLine(line)['attempt_id']),
        [undefined, 'A', 'B'],
      );
    } finally {
      await chmod(dir, 0o700).catch(() => undefined);
      await cleanup();
    }
  },
);

// directory durability -------------------------------------------------

/** What the spied `open` saw when it was asked to open the journal's directory. */
interface DirOpen {
  /** Whether the rotated generation already existed at that moment. */
  rotatedExists: boolean;
  /** Whether the active generation already existed at that moment. */
  activeExists: boolean;
}

/**
 * Spy on `fs/promises.open` for the journal module: every open of `dir` is
 * recorded (and, with `failDir`, rejected), every other open goes through.
 * `syncBuiltinESMExports` is what makes the ESM `open` binding in
 * `mcp/journal.ts` see the replacement.
 */
function spyDirectoryOpens(
  dir: string,
  path: string,
  failDir = false,
): { opens: DirOpen[]; fileOpens: () => number; restore: () => void } {
  const realOpen = fsp.open;
  const opens: DirOpen[] = [];
  const spy = mock.method(fsp, 'open', (...args: Parameters<typeof fsp.open>) => {
    if (args[0] === dir) {
      opens.push({
        rotatedExists: existsSync(`${path}.1`),
        activeExists: existsSync(path),
      });
      if (failDir) {
        return Promise.reject(
          Object.assign(new Error('simulated EISDIR'), { code: 'EISDIR' }),
        );
      }
    }
    return realOpen(...args);
  });
  syncBuiltinESMExports();
  return {
    opens,
    fileOpens: () =>
      spy.mock.calls.filter(
        (call) => call.arguments[0] === path || call.arguments[0] === `${path}.1`,
      ).length,
    restore: () => {
      spy.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

test("durability: an fsync'd append that creates the file syncs its directory once", async () => {
  const { dir, path, cleanup } = await sandbox();
  const spy = spyDirectoryOpens(dir, path);
  try {
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    // The directory is synced after the file exists, never before it.
    assert.deepEqual(spy.opens, [{ rotatedExists: false, activeExists: true }]);

    // Appending to an existing generation creates no directory entry.
    await appendIntent(intent({ attempt_id: 'B' }), { path });
    assert.equal(spy.opens.length, 1);
  } finally {
    spy.restore();
    await cleanup();
  }
});

test("durability: an outcome that creates the file is not fsync'd, so neither is the directory", async () => {
  const { dir, path, cleanup } = await sandbox();
  const spy = spyDirectoryOpens(dir, path);
  try {
    assert.deepEqual(await appendOutcome(outcome(), { path }), { ok: true });
    assert.equal(spy.opens.length, 0);
  } finally {
    spy.restore();
    await cleanup();
  }
});

test('durability: a rotation syncs the directory after the rename', async () => {
  const { dir, path, cleanup } = await sandbox();
  await appendIntent(intent({ attempt_id: 'A' }), { path });
  const spy = spyDirectoryOpens(dir, path);
  try {
    await appendIntent(intent({ attempt_id: 'B' }), { path, maxBytes: 10 });
    // First the rename's sync (the active name gone, `.1` in place), then the
    // sync for the fresh generation the intent created.
    assert.deepEqual(spy.opens, [
      { rotatedExists: true, activeExists: false },
      { rotatedExists: true, activeExists: true },
    ]);
  } finally {
    spy.restore();
    await cleanup();
  }
});

test('durability: a directory that cannot be synced logs at debug and never fails the append', async () => {
  const { dir, path, cleanup } = await sandbox();
  const spy = spyDirectoryOpens(dir, path, true);
  try {
    const { logger, lines: logged } = recordingLogger();
    assert.deepEqual(await appendIntent(intent({ attempt_id: 'A' }), { path, logger }), {
      ok: true,
    });
    assert.deepEqual(
      await appendIntent(intent({ attempt_id: 'B' }), { path, maxBytes: 10, logger }),
      { ok: true },
    );

    const debug = logged.filter(
      (line) => line.msg === 'could not fsync the journal directory',
    );
    // One for the creating append, one for the rotation, one for the fresh
    // generation after it.
    assert.equal(debug.length, 3);
    for (const line of debug) {
      assert.equal(line.level, 'debug');
      assert.equal(line.fields?.['path'], dir);
      assert.match(String(line.fields?.['reason']), /simulated EISDIR/);
    }
    // The rotation itself still went through and was reported as such.
    assert.ok(
      logged.some((line) => line.level === 'info' && line.msg.includes('rotated')),
    );
    assert.ok(!logged.some((line) => line.level === 'warn'));
    assert.equal((await lines(`${path}.1`)).length, 2);
    assert.equal((await lines(path)).length, 2);
  } finally {
    spy.restore();
    await cleanup();
  }
});

// folded-attempts cache -------------------------------------------------

test('folded cache: an unchanged journal is answered without being read again', async () => {
  const { dir, path, cleanup } = await sandbox();
  await appendIntent(intent({ attempt_id: 'A' }), { path });
  // Two attempts, so an in-place `.reverse()` would actually have to write.
  await appendIntent(intent({ attempt_id: 'B' }), { path });
  const spy = spyDirectoryOpens(dir, path);
  try {
    const first = await foldedAttemptsCached({ path });
    assert.deepEqual(
      first.map((attempt) => [attempt.attempt_id, attempt.outcome]),
      [
        ['A', 'unknown'],
        ['B', 'unknown'],
      ],
    );
    const readsAfterFirst = spy.fileOpens();
    assert.ok(readsAfterFirst > 0, 'the first call reads the journal');

    const second = await foldedAttemptsCached({ path });
    assert.equal(second, first, 'the very same folded array is reused');
    // Shared between callers, so frozen: one caller's in-place `.reverse()`
    // must not reorder every other caller's view.
    assert.equal(Object.isFrozen(first), true);
    assert.throws(() => (first as JournalAttempt[]).reverse(), TypeError);
    assert.throws(() => {
      (first as JournalAttempt[]).push(first[0] as JournalAttempt);
    }, TypeError);
    assert.deepEqual(
      (await foldedAttemptsCached({ path })).map((attempt) => attempt.attempt_id),
      ['A', 'B'],
    );
    assert.equal(spy.fileOpens(), readsAfterFirst, 'no generation is opened again');
  } finally {
    spy.restore();
    await cleanup();
  }
});

test('folded cache: an append invalidates the cached attempts', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    const before = await foldedAttemptsCached({ path });
    assert.equal(before[0]?.outcome, 'unknown');

    await appendOutcome(outcome({ attempt_id: 'A', result: 'ok' }), { path });
    const after = await foldedAttemptsCached({ path });
    assert.notEqual(after, before);
    assert.equal(after[0]?.outcome, 'ok');
  } finally {
    await cleanup();
  }
});

test('folded cache: a rotation invalidates the cached attempts', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    const before = await foldedAttemptsCached({ path });
    assert.deepEqual(
      before.map((attempt) => attempt.attempt_id),
      ['A'],
    );

    await appendIntent(intent({ attempt_id: 'B' }), { path, maxBytes: 10 });
    assert.ok(existsSync(`${path}.1`), 'rotated');
    const after = await foldedAttemptsCached({ path });
    assert.deepEqual(
      after.map((attempt) => attempt.attempt_id),
      ['A', 'B'],
    );
  } finally {
    await cleanup();
  }
});

test('folded cache: absent generations are cached as empty, and their creation is seen', async () => {
  const { dir, path, cleanup } = await sandbox();
  const spy = spyDirectoryOpens(dir, path);
  try {
    const empty = await foldedAttemptsCached({ path });
    assert.deepEqual(empty, []);
    const reads = spy.fileOpens();
    assert.equal(await foldedAttemptsCached({ path }), empty, 'cached while absent');
    assert.equal(spy.fileOpens(), reads);

    await appendIntent(intent({ attempt_id: 'A' }), { path });
    const created = await foldedAttemptsCached({ path });
    assert.deepEqual(
      created.map((attempt) => attempt.attempt_id),
      ['A'],
    );
  } finally {
    spy.restore();
    await cleanup();
  }
});

test('folded cache: resolves the same path as the other readers, cached per path', async () => {
  const one = await sandbox();
  const two = await sandbox();
  try {
    await appendIntent(intent({ attempt_id: 'ONE' }), { path: one.path });
    await appendIntent(intent({ attempt_id: 'TWO' }), { path: two.path });
    const [a, b] = await Promise.all([
      foldedAttemptsCached({ path: one.path }),
      foldedAttemptsCached({ path: two.path }),
    ]);
    assert.equal(a[0]?.attempt_id, 'ONE');
    assert.equal(b[0]?.attempt_id, 'TWO');
    assert.equal(await foldedAttemptsCached({ path: one.path }), a);
  } finally {
    await one.cleanup();
    await two.cleanup();
  }
});

// reading and parsing ---------------------------------------------------

test('read: a journal that was never created reads as empty, not as an error', async () => {
  const { path, cleanup } = await sandbox();
  try {
    assert.deepEqual(await readMerged({ path }), { records: [], skippedLines: 0 });
    assert.equal(await journalExists({ path }), false);
  } finally {
    await cleanup();
  }
});

test('read: both generations merge oldest first', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    // Rotation moves A aside; B opens a fresh generation with its own header.
    await appendIntent(intent({ attempt_id: 'B' }), { path, maxBytes: 10 });

    const { records } = await readMerged({ path });
    assert.deepEqual(
      records.map((record) => record.type),
      ['header', 'intent', 'header', 'intent'],
    );
    assert.equal(await journalExists({ path }), true);
  } finally {
    await cleanup();
  }
});

test('read: a rotated generation alone still counts as an existing journal', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await writeFile(`${path}.1`, '');
    assert.equal(await journalExists({ path }), true);
  } finally {
    await cleanup();
  }
});

test('read: limit keeps the newest records', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ attempt_id: 'A' }), { path });
    await appendIntent(intent({ attempt_id: 'B' }), { path });

    const { records } = await readMerged({ path, limit: 1 });
    assert.equal(records.length, 1);
    assert.equal((records[0] as IntentRecord).attempt_id, 'B');
  } finally {
    await cleanup();
  }
});

test('read: damaged lines are skipped and counted, one per kind', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await writeFile(
      path,
      [
        JSON.stringify({ v: 1, type: 'header', created_by: 'tiktok-mcp-ai@1.0.0' }),
        JSON.stringify({ v: 1, type: 'header' }), // header without created_by
        JSON.stringify({ v: 2, type: 'intent' }), // future version
        JSON.stringify({ v: 1, type: 'sabotage' }), // unknown type
        JSON.stringify([1, 2, 3]), // not a record object
        JSON.stringify({ ...intent(), profile: 7 }), // wrong field type
        JSON.stringify({ ...intent(), source: 'MAGIC' }), // not an enum member
        JSON.stringify({ ...outcome(), result: 'unknown' }), // never persisted
        JSON.stringify(intent()),
        '{"v":1,"type":"outc', // torn tail
      ].join('\n'),
    );

    const { records, skippedLines } = await readMerged({ path });
    assert.equal(skippedLines, 8);
    assert.deepEqual(
      records.map((record) => record.type),
      ['header', 'intent'],
    );
  } finally {
    await cleanup();
  }
});

test('read: optional outcome fields survive the round trip', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendOutcome(
      outcome({
        result: 'upload_failed',
        publish_id: 'pub-9',
        error_code: 'upload_interrupted',
        fail_reason: 'chunk stalled',
        chunk: 3,
      }),
      { path },
    );
    const { records } = await readMerged({ path });
    assert.deepEqual(records[1], {
      v: 1,
      type: 'outcome',
      attempt_id: '01JQ0000000000000000000000',
      ts: '2026-01-01T00:00:01.000Z',
      result: 'upload_failed',
      publish_id: 'pub-9',
      error_code: 'upload_interrupted',
      fail_reason: 'chunk stalled',
      chunk: 3,
    });
  } finally {
    await cleanup();
  }
});

test('read: an unreadable generation is journal_unreadable, not an empty answer', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await mkdir(path); // a directory where the file should be
    await assert.rejects(readMerged({ path }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'journal_unreadable');
      assert.match(String((error as Error).message), /verify with tiktok_list_videos/u);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test(
  'read: an open that fails for a reason other than missing is not an empty journal',
  canFailOpen,
  async () => {
    const { dir, cleanup } = await sandbox();
    try {
      // Only ENOENT means "no such generation". Every other errno the kernel
      // raises — here ENOTDIR — is a journal that exists and cannot be read,
      // and reporting it as empty would tell a user no post was ever made.
      const path = await blockedPath(dir);
      await assert.rejects(readMerged({ path }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'journal_unreadable');
        const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
        assert.equal(cause?.code, 'ENOTDIR');
        return true;
      });
    } finally {
      await cleanup();
    }
  },
);

test('read: an outcome that lost a required field is skipped, not folded in', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // Both shapes come from a torn write or a hand-edited journal: valid JSON,
    // right type, but missing a field the contract makes required.
    await writeFile(
      path,
      [
        JSON.stringify({ v: 1, type: 'header', created_by: 'tiktok-mcp-ai@1.0.0' }),
        JSON.stringify(intent()),
        JSON.stringify({ v: 1, type: 'outcome', attempt_id: 'A', ts: 'x' }), // no result
        JSON.stringify({ v: 1, type: 'outcome', attempt_id: 'A', result: 'ok' }), // no ts
      ].join('\n'),
    );

    const { records, skippedLines } = await readMerged({ path });
    assert.equal(skippedLines, 2);
    // The intent survives, and with no readable outcome it folds to the honest
    // "unknown" instead of borrowing a result from half a record.
    const attempts = foldAttempts(records);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.outcome, 'unknown');
  } finally {
    await cleanup();
  }
});

// folding ---------------------------------------------------------------

test('fold: an intent with its outcome carries the outcome detail', () => {
  const attempts = foldAttempts([
    intent(),
    outcome({ result: 'error', error_code: 'network_unsent', fail_reason: 'dns' }),
  ]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.outcome, 'error');
  assert.equal(attempts[0]?.error_code, 'network_unsent');
  assert.equal(attempts[0]?.fail_reason, 'dns');
  assert.equal(attempts[0]?.outcome_ts, '2026-01-01T00:00:01.000Z');
});

test('fold: an intent with no outcome is unknown — the crash case (CC-E10)', () => {
  const attempts = foldAttempts([intent()]);
  assert.equal(attempts[0]?.outcome, 'unknown');
  assert.equal(attempts[0]?.outcome_ts, undefined);
});

test('fold: an orphan outcome is not an attempt', () => {
  assert.deepEqual(foldAttempts([outcome({ attempt_id: 'nobody' })]), []);
});

test('fold: a second outcome for one attempt wins — a retried write is the truth', () => {
  const attempts = foldAttempts([
    intent(),
    outcome({ result: 'send_ambiguous' }),
    outcome({ result: 'ok', publish_id: 'pub-2' }),
  ]);
  assert.equal(attempts[0]?.outcome, 'ok');
  assert.equal(attempts[0]?.publish_id, 'pub-2');
});

test('fold: the chunk an aborted upload died on survives to the folded attempt', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // The record `dispatchWrite` writes when a chunked upload aborts past the
    // init (`tools/publish-common.ts` classifyDispatch): `upload_failed` plus
    // the chunk the bytes stopped on, so a reader can say how far they got.
    await appendIntent(intent(), { path });
    await appendOutcome(
      outcome({
        result: 'upload_failed',
        publish_id: 'pub-7',
        error_code: 'upload_interrupted',
        chunk: 4,
      }),
      { path },
    );

    const attempts = foldAttempts((await readMerged({ path })).records);
    assert.equal(attempts[0]?.outcome, 'upload_failed');
    assert.equal(attempts[0]?.chunk, 4);
    // And an outcome that carries no chunk — every `source: "url"` tool — must
    // not have one invented for it.
    assert.equal(foldAttempts([intent(), outcome()])[0]?.chunk, undefined);
  } finally {
    await cleanup();
  }
});

test('fold: a header carries no attempt', () => {
  const header: JournalRecord = { v: 1, type: 'header', created_by: 'x@1.0.0' };
  assert.deepEqual(foldAttempts([header]), []);
});

// duplicate guard -------------------------------------------------------

/** Writes one attempt with a `ts` relative to the mock clock's baseline. */
async function journalAttempt(
  path: string,
  over: {
    digest: string;
    agoMs: number;
    result?: OutcomeRecord['result'];
    id?: string;
    profile?: string;
  },
): Promise<void> {
  const ts = new Date(BASELINE_NOW_MS - over.agoMs).toISOString();
  const attemptId = over.id ?? `A${over.agoMs}`;
  await appendIntent(
    intent({
      attempt_id: attemptId,
      ts,
      payload_digest: over.digest,
      ...(over.profile === undefined ? {} : { profile: over.profile }),
    }),
    { path },
  );
  if (over.result !== undefined) {
    await appendOutcome(outcome({ attempt_id: attemptId, ts, result: over.result }), {
      path,
    });
  }
}

test('duplicate: a successful attempt inside the window trips the guard', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 60_000, result: 'ok', id: 'HIT' });
    const check = await checkDuplicate('d1', 'DEFAULT', mockClock(), { path });
    assert.equal(check.duplicate, true);
    assert.equal(check.matchedAttemptId, 'HIT');
    // TD-3: the matched attempt travels with the verdict, so a refusal can name
    // what it collided with instead of only that it collided.
    assert.equal(check.matched?.attempt_id, 'HIT');
    assert.equal(check.matched?.outcome, 'ok');
    assert.equal(check.matched?.payload_digest, 'd1');
  } finally {
    await cleanup();
  }
});

test('duplicate: an ambiguous send counts — the post may exist', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000, result: 'send_ambiguous' });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: an intent with no outcome counts — the same reason', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000 });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
  } finally {
    await cleanup();
  }
});

test("duplicate: the guard is per profile — another account's attempt never trips it", async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, {
      digest: 'd1',
      agoMs: 1_000,
      result: 'ok',
      id: 'BRAND-HIT',
      profile: 'BRAND',
    });
    // The same payload on another account is a different post.
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
    // On its own account it trips, and the match names that account.
    const own = await checkDuplicate('d1', 'BRAND', mockClock(), { path });
    assert.equal(own.duplicate, true);
    assert.equal(own.matched?.profile, 'BRAND');
    // Compared canonically on both sides (CC-F4): the fixture's own intent
    // records `default` in lower case, and a caller spelling still matches it.
    await journalAttempt(path, { digest: 'd2', agoMs: 1_000, result: 'ok' });
    assert.equal(
      (await checkDuplicate('d2', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
    assert.equal(
      (await checkDuplicate('d2', ' default ', mockClock(), { path })).duplicate,
      true,
    );
    assert.equal(
      (await checkDuplicate('d2', 'BRAND', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: a clean failure is exempt, so a retry is never blocked', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000, result: 'error' });
    await journalAttempt(path, { digest: 'd2', agoMs: 1_000, result: 'upload_failed' });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
    assert.equal(
      (await checkDuplicate('d2', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: outside the ten-minute window it is a new publish', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, {
      digest: 'd1',
      agoMs: DUPLICATE_WINDOW_MS + 1_000,
      result: 'ok',
    });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: a timestamp in the future still trips it (CC-H1)', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // A clock that stepped backwards must make the guard more suspicious, not
    // less: `force` is the escape hatch, a double post is not undoable.
    await journalAttempt(path, { digest: 'd1', agoMs: -3_600_000, result: 'ok' });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: an unparsable timestamp cannot match a bounded window', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ ts: 'not-a-date', payload_digest: 'd1' }), { path });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: a different payload is not a duplicate', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'other', agoMs: 1_000, result: 'ok' });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: the newest matching attempt is the one reported', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 300_000, result: 'ok', id: 'OLD' });
    await journalAttempt(path, { digest: 'd1', agoMs: 10_000, result: 'ok', id: 'NEW' });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).matchedAttemptId,
      'NEW',
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: an intent rotated into .1 inside the window still trips the guard', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // The rotation lands right after the attempt was recorded — by this
    // process on its next publish, or by another process at any time. The
    // attempt is still inside its window and must not be re-sendable.
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000, result: 'ok', id: 'HIT' });
    await appendIntent(intent({ attempt_id: 'FORCE_ROTATE' }), { path, maxBytes: 10 });
    assert.ok((await readFile(`${path}.1`, 'utf8')).includes('"HIT"'), 'rotated');
    assert.ok(
      !(await readFile(path, 'utf8')).includes('"HIT"'),
      'not in the active file',
    );

    const check = await checkDuplicate('d1', 'DEFAULT', mockClock(), { path });
    assert.equal(check.duplicate, true);
    assert.equal(check.matchedAttemptId, 'HIT');
    assert.equal(check.matched?.outcome, 'ok');
  } finally {
    await cleanup();
  }
});

test('duplicate: .1 is not read when the active tail already fills the budget', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // A hit sits in `.1`; the active generation alone is larger than the
    // 256 KiB tail window, so its cut tail spends the whole budget on the
    // newest records and the older generation is never reached.
    await journalAttempt(`${path}.1`, {
      digest: 'd1',
      agoMs: 1_000,
      result: 'ok',
      id: 'OLDER',
    });
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    const pad = 'x'.repeat(120);
    const filler: string[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      filler.push(
        JSON.stringify(
          intent({ attempt_id: `PAD${i}`, ts, payload_digest: `pad-${i}`, mode: pad }),
        ),
      );
    }
    await writeFile(path, `${filler.join('\n')}\n`);
    assert.ok((await stat(path)).size > 262_144);

    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
    // The active tail itself is still scanned.
    assert.equal(
      (await checkDuplicate('pad-1999', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: an intent in .1 folds with its outcome in the active generation', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // The generations are scanned oldest first, so the outcome still follows
    // its intent. Read separately, the intent would fold to `unknown` and block
    // a retry of what was in fact a clean failure.
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    await appendIntent(intent({ attempt_id: 'SPLIT', ts, payload_digest: 'd1' }), {
      path: `${path}.1`,
    });
    await appendOutcome(outcome({ attempt_id: 'SPLIT', ts, result: 'error' }), { path });
    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );

    // And an `ok` outcome split the same way is the success it records.
    await appendIntent(intent({ attempt_id: 'SPLIT_OK', ts, payload_digest: 'd2' }), {
      path: `${path}.1`,
    });
    await appendOutcome(outcome({ attempt_id: 'SPLIT_OK', ts, result: 'ok' }), { path });
    const check = await checkDuplicate('d2', 'DEFAULT', mockClock(), { path });
    assert.equal(check.duplicate, true);
    assert.equal(check.matched?.outcome, 'ok');
  } finally {
    await cleanup();
  }
});

test('duplicate: a missing active generation still scans .1', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(`${path}.1`, { digest: 'd1', agoMs: 1_000, id: 'ONLY_OLDER' });
    const check = await checkDuplicate('d1', 'DEFAULT', mockClock(), { path });
    assert.equal(check.duplicate, true);
    assert.equal(check.matchedAttemptId, 'ONLY_OLDER');
    assert.equal(check.matched?.outcome, 'unknown');
  } finally {
    await cleanup();
  }
});

test('duplicate: a torn last line of .1 does not swallow the first active line', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // `.1` ends mid-record with no newline, and the active generation starts
    // straight with the hit (no header). Concatenated without a separator,
    // the fragment and the hit would parse as one broken line and both vanish.
    await writeFile(`${path}.1`, '{"v":1,"type":"outc');
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    await writeFile(
      path,
      `${JSON.stringify(intent({ attempt_id: 'FIRST', ts, payload_digest: 'd1' }))}\n`,
    );
    const check = await checkDuplicate('d1', 'DEFAULT', mockClock(), { path });
    assert.equal(check.duplicate, true);
    assert.equal(check.matchedAttemptId, 'FIRST');
  } finally {
    await cleanup();
  }
});

test('duplicate: a large .1 contributes only the budget the active file left over', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // `.1` is larger than the whole window: its head (the buried hit) is cut
    // and only its newest records are scanned in front of the active file.
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    const pad = 'x'.repeat(120);
    const filler: string[] = [
      JSON.stringify(
        intent({ attempt_id: 'BURIED', ts, payload_digest: 'buried', mode: pad }),
      ),
    ];
    for (let i = 0; i < 2_000; i += 1) {
      filler.push(
        JSON.stringify(
          intent({ attempt_id: `PAD${i}`, ts, payload_digest: `pad-${i}`, mode: pad }),
        ),
      );
    }
    await writeFile(`${path}.1`, `${filler.join('\n')}\n`);
    await journalAttempt(path, { digest: 'recent', agoMs: 1_000, id: 'RECENT' });

    assert.equal(
      (await checkDuplicate('recent', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
    assert.equal(
      (await checkDuplicate('pad-1999', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
    assert.equal(
      (await checkDuplicate('buried', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: invalid UTF-8 in a cut active tail does not make it look whole', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // The active file is 10 bytes over the 262,144-byte window, so its tail is
    // cut. Its kept part holds 50 bytes of 0xFF, each of which decodes to a
    // three-byte U+FFFD — the decoded tail re-encodes to exactly the file
    // size. Measuring the text instead of the raw read would call this tail
    // whole and ask `.1` for a negative budget, failing the check as unreadable.
    const window = 262_144;
    const size = window + 10;
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    const head = Buffer.from(`${'x'.repeat(99)}\n`);
    const invalid = Buffer.concat([Buffer.alloc(50, 0xff), Buffer.from('\n')]);
    const hit = Buffer.from(
      `${JSON.stringify(intent({ attempt_id: 'HIT', ts, payload_digest: 'hit' }))}\n`,
    );
    const fillerLength = size - head.length - invalid.length - hit.length - 1;
    const filler = Buffer.from(`${'y'.repeat(fillerLength)}\n`);
    const file = Buffer.concat([head, invalid, filler, hit]);
    assert.equal(file.length, size);
    await writeFile(path, file);
    await writeFile(
      `${path}.1`,
      `${JSON.stringify(intent({ attempt_id: 'OLD', ts, payload_digest: 'old' }))}\n`,
    );

    // The setup reproduces the confusion: the kept tail decodes to `size` bytes.
    const kept = file.subarray(size - window).toString('utf8');
    const trimmed = kept.slice(kept.indexOf('\n') + 1);
    assert.equal(Buffer.byteLength(trimmed), size);

    const { logger, lines: logged } = recordingLogger();
    const check = await checkDuplicate('hit', 'DEFAULT', mockClock(), { path, logger });
    assert.equal(check.duplicate, true);
    assert.equal(check.matchedAttemptId, 'HIT');
    assert.deepEqual(logged, [], 'the journal was read, not reported unreadable');
    // The tail was cut, so `.1` is never consulted.
    assert.equal(
      (await checkDuplicate('old', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: a missing journal allows the publish', async () => {
  const { path, cleanup } = await sandbox();
  try {
    assert.deepEqual(await checkDuplicate('d1', 'DEFAULT', mockClock(), { path }), {
      duplicate: false,
    });
  } finally {
    await cleanup();
  }
});

test('duplicate: an unreadable journal warns and allows the publish', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await mkdir(path);
    const { logger, lines: logged } = recordingLogger();
    assert.deepEqual(
      await checkDuplicate('d1', 'DEFAULT', mockClock(), { path, logger }),
      {
        duplicate: false,
      },
    );
    assert.ok(
      logged.some(
        (line) => line.level === 'warn' && line.msg.includes('allowing the publish'),
      ),
    );
  } finally {
    await cleanup();
  }
});

test(
  'duplicate: a tail read that fails with no logger configured still allows the publish',
  canFailOpen,
  async () => {
    const { dir, cleanup } = await sandbox();
    try {
      // No `logger` in the options — the fallback is the whole reason a broken
      // journal cannot throw out of a publish on a server that configured none.
      const path = await blockedPath(dir);
      assert.deepEqual(await checkDuplicate('d1', 'DEFAULT', mockClock(), { path }), {
        duplicate: false,
      });
    } finally {
      await cleanup();
    }
  },
);

test('duplicate: a tail window with no line boundary is dropped whole', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // A torn write of one oversized record — the process died before the
    // terminating newline and the fragment is longer than the tail window, so
    // the window holds no trustworthy boundary at all. Half a record must never
    // reach the parser, which means the guard sees nothing and allows the post:
    // the attempt buried in front of the fragment is out of the window too.
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000, result: 'ok', id: 'HIT' });
    await appendFile(
      path,
      `{"v":1,"type":"outcome","ts":"${ts}","fail_reason":"${'x'.repeat(400_000)}`,
    );

    assert.equal(
      (await checkDuplicate('d1', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: only the tail of a large journal is read', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // `buried` sits at the head, then ~700 KB of padding pushes it past the
    // 256 KiB tail window. It is inside the ten-minute window and would trip
    // the guard if the guard read the whole file — it must not, or every
    // publish would pay for a 5 MB parse.
    const ts = new Date(BASELINE_NOW_MS - 1_000).toISOString();
    const pad = 'x'.repeat(120);
    const filler: string[] = [
      JSON.stringify({ v: 1, type: 'header', created_by: 'tiktok-mcp-ai@1.0.0' }),
      JSON.stringify(
        intent({ attempt_id: 'BURIED', ts, payload_digest: 'buried', mode: pad }),
      ),
    ];
    for (let i = 0; i < 2_000; i += 1) {
      filler.push(
        JSON.stringify(
          intent({ attempt_id: `PAD${i}`, ts, payload_digest: `pad-${i}`, mode: pad }),
        ),
      );
    }
    await writeFile(path, `${filler.join('\n')}\n`);
    await journalAttempt(path, {
      digest: 'recent',
      agoMs: 1_000,
      result: 'ok',
      id: 'RECENT',
    });

    assert.equal(
      (await checkDuplicate('recent', 'DEFAULT', mockClock(), { path })).duplicate,
      true,
    );
    assert.equal(
      (await checkDuplicate('buried', 'DEFAULT', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});
