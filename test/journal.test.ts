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
 *    minutes, `ok`/ambiguous/unknown only, active generation only, and a clock
 *    that stepped backwards makes it *more* suspicious, not less (CC-H1).
 * 4. **A damaged file degrades, it does not fail.** Torn tails, unknown
 *    versions and malformed records are skipped and *counted*, so a reader can
 *    tell "nothing happened" from "I could not read what happened".
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { registerSecret } from '../src/core/redact.js';
import type { Logger } from '../src/core/log.js';
import {
  appendIntent,
  appendOutcome,
  checkDuplicate,
  DUPLICATE_WINDOW_MS,
  foldAttempts,
  journalExists,
  journalTimestamp,
  mintAttemptId,
  readMerged,
  resolveJournalPath,
  TITLE_EXCERPT_MAX,
  titleExcerpt,
  type IntentRecord,
  type JournalRecord,
  type OutcomeRecord,
} from '../src/mcp/journal.js';
import { BASELINE_NOW_MS, fsSandbox, mockClock, withEnv } from './helpers.js';

// fixtures --------------------------------------------------------------

const POSIX = process.platform !== 'win32';

/**
 * The tail read opens a handle rather than slurping the file, and win32 hands
 * out a handle for a directory and then reads it as zero bytes — an empty
 * journal, not a failure. Only POSIX turns "a directory stands here" into the
 * read error the warn-and-allow path is about.
 */
const canFailTailRead: { skip?: string } = POSIX
  ? {}
  : { skip: 'directory-as-file: win32 opens a directory handle and reads it as empty' };

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

test('fold: a header carries no attempt', () => {
  const header: JournalRecord = { v: 1, type: 'header', created_by: 'x@1.0.0' };
  assert.deepEqual(foldAttempts([header]), []);
});

// duplicate guard -------------------------------------------------------

/** Writes one attempt with a `ts` relative to the mock clock's baseline. */
async function journalAttempt(
  path: string,
  over: { digest: string; agoMs: number; result?: OutcomeRecord['result']; id?: string },
): Promise<void> {
  const ts = new Date(BASELINE_NOW_MS - over.agoMs).toISOString();
  const attemptId = over.id ?? `A${over.agoMs}`;
  await appendIntent(intent({ attempt_id: attemptId, ts, payload_digest: over.digest }), {
    path,
  });
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
    const check = await checkDuplicate('d1', mockClock(), { path });
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
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, true);
  } finally {
    await cleanup();
  }
});

test('duplicate: an intent with no outcome counts — the same reason', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000 });
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, true);
  } finally {
    await cleanup();
  }
});

test('duplicate: a clean failure is exempt, so a retry is never blocked', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000, result: 'error' });
    await journalAttempt(path, { digest: 'd2', agoMs: 1_000, result: 'upload_failed' });
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, false);
    assert.equal((await checkDuplicate('d2', mockClock(), { path })).duplicate, false);
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
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, false);
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
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, true);
  } finally {
    await cleanup();
  }
});

test('duplicate: an unparsable timestamp cannot match a bounded window', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendIntent(intent({ ts: 'not-a-date', payload_digest: 'd1' }), { path });
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, false);
  } finally {
    await cleanup();
  }
});

test('duplicate: a different payload is not a duplicate', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'other', agoMs: 1_000, result: 'ok' });
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, false);
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
      (await checkDuplicate('d1', mockClock(), { path })).matchedAttemptId,
      'NEW',
    );
  } finally {
    await cleanup();
  }
});

test('duplicate: the rotated generation is out of scope', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await journalAttempt(path, { digest: 'd1', agoMs: 1_000, result: 'ok' });
    await appendIntent(intent({ attempt_id: 'FORCE_ROTATE' }), { path, maxBytes: 10 });
    assert.equal((await checkDuplicate('d1', mockClock(), { path })).duplicate, false);
  } finally {
    await cleanup();
  }
});

test('duplicate: a missing journal allows the publish', async () => {
  const { path, cleanup } = await sandbox();
  try {
    assert.deepEqual(await checkDuplicate('d1', mockClock(), { path }), {
      duplicate: false,
    });
  } finally {
    await cleanup();
  }
});

test(
  'duplicate: an unreadable journal warns and allows the publish',
  canFailTailRead,
  async () => {
    const { path, cleanup } = await sandbox();
    try {
      await mkdir(path);
      const { logger, lines: logged } = recordingLogger();
      assert.deepEqual(await checkDuplicate('d1', mockClock(), { path, logger }), {
        duplicate: false,
      });
      assert.ok(
        logged.some(
          (line) => line.level === 'warn' && line.msg.includes('allowing the publish'),
        ),
      );
    } finally {
      await cleanup();
    }
  },
);

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

    assert.equal((await checkDuplicate('recent', mockClock(), { path })).duplicate, true);
    assert.equal(
      (await checkDuplicate('buried', mockClock(), { path })).duplicate,
      false,
    );
  } finally {
    await cleanup();
  }
});
