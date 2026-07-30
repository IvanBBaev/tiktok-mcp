import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from '../src/core/log.js';
import { registerSecret } from '../src/core/redact.js';

type WriteFn = typeof process.stderr.write;

const FIXED_EPOCH_MS = 1_769_000_000_000;
const FIXED_EPOCH_ISO = '2026-01-21T12:53:20.000Z';

/**
 * A minimal `Clock` (structurally compatible with core/clock.ts) whose `sleep`
 * fails the test if anything tries to use it: logging is synchronous and must
 * never touch the sleep seam (CC-H4 — tests never sleep).
 */
function frozenClock(nowMs = FIXED_EPOCH_MS) {
  return {
    now: () => nowMs,
    sleep: (): Promise<void> => {
      throw new Error('the logger must never sleep');
    },
  };
}

/**
 * Captures everything written to stdout and stderr while `fn` runs. `fn` must
 * be synchronous so no unrelated writer can interleave while the streams are
 * swapped.
 */
function capture(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const sinkTo =
    (sink: string[]): WriteFn =>
    (chunk: string | Uint8Array): boolean => {
      sink.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const realOut: WriteFn = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const realErr: WriteFn = process.stderr.write;
  process.stdout.write = sinkTo(out);
  process.stderr.write = sinkTo(err);
  try {
    fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { out, err };
}

function parseLines(chunks: string[]): Record<string, unknown>[] {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('cc-g3 the logger never writes to stdout', () => {
  const log = createLogger({ level: 'debug', clock: frozenClock() });
  const { out, err } = capture(() => {
    log.debug('debug record');
    log.info('info record', { attempt: 1 });
    log.warn('warn record');
    log.error('error record', { code: 'network_unsent' });
    log.child({ profile: 'DEFAULT' }).info('child record');
  });

  assert.deepEqual(out, [], 'stdout is the JSON-RPC channel and must stay empty');
  assert.equal(parseLines(err).length, 5);
});

test('cc-g3 each record is exactly one newline-delimited JSON object on stderr', () => {
  const log = createLogger({ clock: frozenClock() });
  const { out, err } = capture(() => {
    log.info('first line\nsecond line\r\nthird line');
    log.info('plain');
  });

  assert.deepEqual(out, []);
  const raw = err.join('');
  assert.ok(raw.endsWith('\n'));
  // Embedded newlines are JSON-escaped, so the stream stays one record per line.
  assert.equal(raw.split('\n').filter((l) => l.length > 0).length, 2);

  const records = parseLines(err);
  assert.equal(records[0]?.msg, 'first line\nsecond line\r\nthird line');
  assert.equal(records[1]?.msg, 'plain');
});

test('cc-h2 the ts field is ISO-8601 UTC derived from the injected clock', () => {
  const log = createLogger({ clock: frozenClock() });
  const { err } = capture(() => {
    log.info('timed');
  });

  const record = parseLines(err)[0];
  assert.equal(record?.ts, FIXED_EPOCH_ISO);
  assert.equal(record?.level, 'info');
  assert.equal(record?.msg, 'timed');
});

test('cc-h4 emitting a record is synchronous and never uses the sleep seam', () => {
  const log = createLogger({ level: 'debug', clock: frozenClock() });
  const { err } = capture(() => {
    log.debug('no sleeping here');
  });

  assert.equal(parseLines(err).length, 1);
});

test('records below the configured level are suppressed', () => {
  const log = createLogger({ level: 'warn', clock: frozenClock() });
  const { err } = capture(() => {
    log.debug('dropped');
    log.info('dropped');
    log.warn('kept');
    log.error('kept');
  });

  assert.deepEqual(
    parseLines(err).map((r) => r.level),
    ['warn', 'error'],
  );
});

test('the default level is info, so debug is suppressed without any options', () => {
  const log = createLogger();
  const { out, err } = capture(() => {
    log.debug('dropped');
    log.info('kept');
  });

  assert.deepEqual(out, []);
  const records = parseLines(err);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.msg, 'kept');
  // Falls back to the system clock: a real, parseable ISO-8601 UTC instant.
  assert.match(String(records[0]?.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('child fields are equivalent to the same fields passed per call', () => {
  const clock = frozenClock();
  const viaChild = capture(() => {
    createLogger({ clock }).child({ profile: 'DEFAULT' }).child({ attempt: 2 }).info('m');
  });
  const viaCall = capture(() => {
    createLogger({ clock }).info('m', { profile: 'DEFAULT', attempt: 2 });
  });

  assert.deepEqual(parseLines(viaChild.err), parseLines(viaCall.err));
});

test('per-call fields win over fields bound by child()', () => {
  const clock = frozenClock();
  const overridden = capture(() => {
    createLogger({ clock }).child({ attempt: 1 }).info('m', { attempt: 2 });
  });
  const direct = capture(() => {
    createLogger({ clock }).info('m', { attempt: 2 });
  });

  assert.deepEqual(parseLines(overridden.err), parseLines(direct.err));
});

test('a child logger does not mutate its parent', () => {
  const clock = frozenClock();
  const parent = createLogger({ clock });
  const child = parent.child({ profile: 'DEFAULT' });

  const fromParent = capture(() => {
    parent.info('m');
  });
  const fromChild = capture(() => {
    child.info('m');
  });
  const baseline = capture(() => {
    createLogger({ clock }).info('m');
  });

  assert.deepEqual(parseLines(fromParent.err), parseLines(baseline.err));
  assert.notDeepEqual(parseLines(fromChild.err), parseLines(baseline.err));
});

test('caller fields can never overwrite the ts, level or msg envelope keys', () => {
  const log = createLogger({ clock: frozenClock() });
  const { err } = capture(() => {
    log.child({ level: 'error', ts: 'yesterday' }).info('real message', {
      msg: 'spoofed message',
    });
  });

  const record = parseLines(err)[0];
  assert.equal(record?.ts, FIXED_EPOCH_ISO);
  assert.equal(record?.level, 'info');
  assert.equal(record?.msg, 'real message');
});

test('an unserializable field set degrades instead of throwing', () => {
  const log = createLogger({ clock: frozenClock() });
  const circular: Record<string, unknown> = { label: 'loop' };
  circular.self = circular;

  let captured: { out: string[]; err: string[] } | undefined;
  assert.doesNotThrow(() => {
    captured = capture(() => {
      log.info('kept going', circular);
    });
  });

  assert.deepEqual(captured?.out, []);
  const records = parseLines(captured?.err ?? []);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.msg, 'kept going');
});

test('a broken stderr pipe is swallowed and never crashes the caller', () => {
  const log = createLogger({ clock: frozenClock() });
  let attempts = 0;
  const throwingWrite: WriteFn = (): boolean => {
    attempts += 1;
    throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const realErr: WriteFn = process.stderr.write;
  process.stderr.write = throwingWrite;
  try {
    assert.doesNotThrow(() => {
      log.error('the parent closed the pipe', { code: 'network_unsent' });
    });
  } finally {
    process.stderr.write = realErr;
  }

  assert.equal(attempts, 1, 'the record was offered to the closed pipe exactly once');
});

test('a field set that survives redaction but not serialization degrades to log_fields_dropped', () => {
  const log = createLogger({ clock: frozenClock() });
  // `redactValue` rewrites every value it walks into something JSON-safe — even
  // a bigint comes back as a string — with one exception: `Error.name` is copied
  // through verbatim. A non-string name therefore survives redaction as a plain
  // record and only blows up inside `JSON.stringify`.
  const broken = new Error('boom');
  (broken as unknown as { name: unknown }).name = 10n;

  let captured: { out: string[]; err: string[] } | undefined;
  assert.doesNotThrow(() => {
    captured = capture(() => {
      log.warn('fields could not be serialized', {
        profile: 'FIELD-VALUE-CANARY',
        error: broken,
      });
    });
  });

  assert.deepEqual(captured?.out, []);
  const records = parseLines(captured?.err ?? []);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    ts: FIXED_EPOCH_ISO,
    level: 'warn',
    msg: 'fields could not be serialized',
    log_error: 'log_fields_dropped',
  });
  assert.ok(
    !(captured?.err.join('') ?? '').includes('FIELD-VALUE-CANARY'),
    'a field value leaked into the degraded record',
  );
});

test('an unrepresentable clock instant degrades the whole record to log_record_dropped', () => {
  // `new Date(NaN).toISOString()` throws RangeError, so not even the envelope
  // can be built; the record collapses to the level plus the error marker.
  const log = createLogger({ clock: frozenClock(Number.NaN) });

  let captured: { out: string[]; err: string[] } | undefined;
  assert.doesNotThrow(() => {
    captured = capture(() => {
      log.error('MESSAGE-CANARY', { profile: 'FIELD-VALUE-CANARY' });
    });
  });

  assert.deepEqual(captured?.out, []);
  // Exact match: neither the message nor any field content may survive.
  assert.deepEqual(captured?.err, [
    '{"level":"error","log_error":"log_record_dropped"}\n',
  ]);
});

test('cc-g3 a registered secret never reaches the stderr sink', () => {
  const secret = 'act.SEEDED-LOG-SECRET-0123456789abcdef';
  registerSecret(secret);

  const log = createLogger({ level: 'debug', clock: frozenClock() });
  const { out, err } = capture(() => {
    log.debug(`refreshing with ${secret}`, {
      access_token: secret,
      nested: {
        upload_url: `https://open-upload.tiktokapis.com/x?upload_token=${secret}`,
      },
    });
  });

  assert.deepEqual(out, []);
  const raw = err.join('');
  assert.ok(raw.length > 0);
  assert.ok(!raw.includes(secret), 'the seeded secret leaked to stderr');
});
