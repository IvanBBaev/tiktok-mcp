/**
 * `mcp/webhook` — the event log, the identity read and the receiver's status
 * decisions (ARCHITECTURE.md § 6.1). Real files in a temp dir; virtual time.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fsp, { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Logger } from '../src/core/log.js';
import type { ForgetOutcome } from '../src/core/oauth.js';
import { loadSettings } from '../src/core/settings.js';
import { TikTokError } from '../src/core/errors.js';
import { registerSecret } from '../src/core/redact.js';
import {
  AUTHORIZATION_REMOVED,
  RECENT_DIGESTS,
  WEBHOOK_LOG_MAX_BYTES,
  appendWebhookRecord,
  createWebhookReceiver,
  readWebhookIdentity,
  readWebhookLog,
  resolveWebhookLogPath,
  revocationListener,
  webhookRouteFor,
  type WebhookIdentity,
  type WebhookReceiverOptions,
  type WebhookRecord,
} from '../src/mcp/webhook.js';
import { BASELINE_NOW_MS, fsSandbox, mockClock } from './helpers.js';

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function recordingLogger(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, msg, fields });
    };
  const logger: Logger & { lines: Line[] } = {
    lines,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

function record(over: Partial<WebhookRecord> = {}): WebhookRecord {
  return {
    v: 1,
    received_at: '2026-01-01T00:00:00.000Z',
    digest: 'd1',
    event: 'post.publish.complete',
    create_time: 1_767_225_600,
    user_openid: 'open-1',
    content: {},
    ...over,
  };
}

async function sandbox(): Promise<{
  dir: string;
  path: string;
  cleanup: () => Promise<void>;
}> {
  const created = await fsSandbox();
  return {
    dir: created.dir,
    path: join(created.dir, 'webhooks.ndjson'),
    cleanup: () => created.cleanup(),
  };
}

// log path ----------------------------------------------------------------

test('resolveWebhookLogPath: webhooks.ndjson beside the env file', () => {
  assert.equal(
    resolveWebhookLogPath('/a/b/.tiktok-mcp.env'),
    join('/a/b', 'webhooks.ndjson'),
  );
  assert.match(resolveWebhookLogPath(), /webhooks\.ndjson$/u);
});

// append / read -----------------------------------------------------------

test('append + read: lines round-trip oldest first, 0600 in a created dir', async () => {
  const { dir, cleanup } = await sandbox();
  try {
    const path = join(dir, 'nested', 'webhooks.ndjson');
    await appendWebhookRecord(path, record({ digest: 'a' }));
    await appendWebhookRecord(
      path,
      record({ digest: 'b', profile: 'BRAND', publish_id: 'p' }),
    );
    const read = await readWebhookLog(path);
    assert.equal(read.exists, true);
    assert.equal(read.skippedLines, 0);
    assert.deepEqual(
      read.records.map((r) => r.digest),
      ['a', 'b'],
    );
    assert.equal(read.records[1]?.profile, 'BRAND');
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await cleanup();
  }
});

test('append: rotates to .1 past maxBytes; read merges both generations and dedupes', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await appendWebhookRecord(path, record({ digest: 'a' }), 10);
    await appendWebhookRecord(path, record({ digest: 'b' }), 10);
    assert.match(await readFile(`${path}.1`, 'utf8'), /"digest":"a"/u);
    assert.doesNotMatch(await readFile(path, 'utf8'), /"digest":"a"/u);
    // A redelivery that crossed a restart lands in the current generation too.
    await appendWebhookRecord(path, record({ digest: 'a' }));
    const read = await readWebhookLog(path);
    assert.deepEqual(
      read.records.map((r) => r.digest),
      ['a', 'b'],
    );
    assert.equal(WEBHOOK_LOG_MAX_BYTES, 1_048_576);
  } finally {
    await cleanup();
  }
});

test('read: only the rotated generation still counts as existing', async () => {
  const { path, cleanup } = await sandbox();
  try {
    await writeFile(`${path}.1`, `${JSON.stringify(record())}\n`);
    const read = await readWebhookLog(path);
    assert.equal(read.exists, true);
    assert.equal(read.records.length, 1);
  } finally {
    await cleanup();
  }
});

test('read: no file is an empty, non-existent log', async () => {
  const { path, cleanup } = await sandbox();
  try {
    assert.deepEqual(await readWebhookLog(path), {
      records: [],
      skippedLines: 0,
      exists: false,
    });
  } finally {
    await cleanup();
  }
});

test('read: torn, foreign and wrong-shape lines are counted and skipped', async () => {
  const { path, cleanup } = await sandbox();
  try {
    const bad = [
      '{"torn":',
      '[1]',
      'null',
      JSON.stringify({ ...record(), v: 2 }),
      JSON.stringify({ ...record(), content: null }),
      JSON.stringify({ ...record(), content: [] }),
      JSON.stringify({ ...record(), create_time: '1' }),
    ];
    await writeFile(path, [...bad, JSON.stringify(record()), '', '  '].join('\n'));
    const read = await readWebhookLog(path);
    assert.equal(read.skippedLines, bad.length);
    assert.equal(read.records.length, 1);
  } finally {
    await cleanup();
  }
});

test('read: an existing but unreadable log is webhook_log_unreadable', async () => {
  const { path, cleanup } = await sandbox();
  try {
    // A directory where the file should be: EISDIR on every platform.
    await mkdir(path);
    await assert.rejects(readWebhookLog(path), (error: unknown) => {
      assert.ok(error instanceof TikTokError);
      assert.equal(error.code, 'webhook_log_unreadable');
      assert.equal(error.kind, 'internal');
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    await cleanup();
  }
});

test('append: a short write throws — a partial line is no record', async () => {
  const { path, cleanup } = await sandbox();
  // The FileHandle class is not exported; a real handle hands over its prototype.
  const probe = await fsp.open(path, 'a');
  const proto = Object.getPrototypeOf(probe) as {
    write: (...args: unknown[]) => Promise<{ bytesWritten: number; buffer: unknown }>;
  };
  await probe.close();
  await fsp.rm(path);
  const original = proto.write;
  try {
    proto.write = async function shortWrite(
      this: unknown,
      ...args: unknown[]
    ): Promise<{ bytesWritten: number; buffer: unknown }> {
      const result = await original.apply(this, args);
      return { ...result, bytesWritten: result.bytesWritten - 1 };
    };
    await assert.rejects(appendWebhookRecord(path, record()), /short webhook log write/u);
  } finally {
    proto.write = original;
    await cleanup();
  }
});

// identity ----------------------------------------------------------------

test('readWebhookIdentity: app credentials plus the open_id → profile map', async () => {
  const { dir, cleanup } = await sandbox();
  try {
    const envFile = join(dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-client-secret',
        'TT_OPEN_ID=open-default',
        'TT_PROFILE_BRAND_OPEN_ID=open-brand',
        'TT_PROFILE_ALT_OPEN_ID=open-brand',
        'TT_PROFILE_BROKEN_OPEN_ID=open-broken',
        'TT_PROFILE_BROKEN_TOKEN_EXPIRES_AT=not-a-date',
        'TT_PROFILE_NOID_ACCESS_TOKEN=x',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const identity = await readWebhookIdentity(envFile, {});
    assert.ok(identity !== undefined);
    assert.equal(identity.clientKey, 'test-client-key');
    assert.equal(identity.clientSecret, 'test-client-secret');
    assert.deepEqual(
      [...identity.profiles],
      [
        // ALT sorts before BRAND, so ALT wins the shared open_id.
        ['open-brand', 'ALT'],
        ['open-default', 'DEFAULT'],
      ],
    );
  } finally {
    await cleanup();
  }
});

test('readWebhookIdentity: no app credentials, or no env file, is undefined', async () => {
  const { dir, cleanup } = await sandbox();
  try {
    const envFile = join(dir, '.tiktok-mcp.env');
    assert.equal(await readWebhookIdentity(envFile, {}), undefined);
    await writeFile(envFile, 'TT_OPEN_ID=open-default\n', { mode: 0o600 });
    assert.equal(await readWebhookIdentity(envFile, {}), undefined);
  } finally {
    await cleanup();
  }
});

// receiver ----------------------------------------------------------------

const SECRET = 'test-client-secret';
const NOW_S = Math.floor(BASELINE_NOW_MS / 1000);

function eventBody(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      client_key: 'test-client-key',
      event: 'post.publish.complete',
      create_time: NOW_S,
      user_openid: 'open-brand',
      content: JSON.stringify({ publish_id: 'pub-1' }),
      ...over,
    }),
  );
}

function signed(
  rawBody: Buffer,
  secret: string = SECRET,
): { signature: string; rawBody: Buffer } {
  const s = createHmac('sha256', secret)
    .update(`${String(NOW_S)}.`)
    .update(rawBody)
    .digest('hex');
  return { signature: `t=${String(NOW_S)},s=${s}`, rawBody };
}

const IDENTITY: WebhookIdentity = {
  clientKey: 'test-client-key',
  clientSecret: SECRET,
  profiles: new Map([['open-brand', 'BRAND']]),
};

async function receiver(over: Partial<WebhookReceiverOptions> = {}): Promise<{
  receive: ReturnType<typeof createWebhookReceiver>;
  log: ReturnType<typeof recordingLogger>;
  path: string;
  events: WebhookRecord[];
  cleanup: () => Promise<void>;
}> {
  const { path, cleanup } = await sandbox();
  const log = recordingLogger();
  const events: WebhookRecord[] = [];
  const receive = createWebhookReceiver({
    identity: () => Promise.resolve(IDENTITY),
    logPath: path,
    clock: mockClock(),
    log,
    toleranceS: 300,
    onEvent: (r) => {
      events.push(r);
    },
    ...over,
  });
  return { receive, log, path, events, cleanup };
}

test('receiver: a genuine event is recorded, logged and handed to onEvent — 200', async () => {
  const { receive, log, path, events, cleanup } = await receiver();
  try {
    const delivery = signed(eventBody());
    assert.equal(await receive(delivery), 200);
    const { records } = await readWebhookLog(path);
    assert.equal(records.length, 1);
    assert.deepEqual(
      { ...records[0], digest: undefined },
      {
        v: 1,
        received_at: new Date(BASELINE_NOW_MS).toISOString(),
        digest: undefined,
        event: 'post.publish.complete',
        create_time: NOW_S,
        user_openid: 'open-brand',
        profile: 'BRAND',
        publish_id: 'pub-1',
        content: { publish_id: 'pub-1' },
      },
    );
    assert.deepEqual(events, records);
    const info = log.lines.find((l) => l.level === 'info');
    assert.deepEqual(info?.fields, {
      event: 'post.publish.complete',
      profile: 'BRAND',
      publish_id: 'pub-1',
    });

    // A redelivery is success, not news: no second line, no second onEvent.
    assert.equal(await receive(delivery), 200);
    assert.equal((await readWebhookLog(path)).records.length, 1);
    assert.equal(events.length, 1);
    assert.ok(log.lines.some((l) => l.level === 'debug' && /redelivery/u.test(l.msg)));
  } finally {
    await cleanup();
  }
});

test('receiver: an unknown open_id and no publish_id record neither — and no onEvent is fine', async () => {
  const { receive, log, path, cleanup } = await receiver({ onEvent: undefined });
  try {
    const raw = eventBody({
      user_openid: 'stranger',
      event: 'authorization.removed',
      content: '{}',
    });
    assert.equal(await receive(signed(raw)), 200);
    const [only] = (await readWebhookLog(path)).records;
    assert.equal(only?.profile, undefined);
    assert.equal(only?.publish_id, undefined);
    assert.deepEqual(log.lines.find((l) => l.level === 'info')?.fields, {
      event: 'authorization.removed',
    });
  } finally {
    await cleanup();
  }
});

test('receiver: no app credentials — 503', async () => {
  const { receive, log, cleanup } = await receiver({
    identity: () => Promise.resolve(undefined),
  });
  try {
    assert.equal(await receive(signed(eventBody())), 503);
    assert.equal(log.lines[0]?.level, 'warn');
  } finally {
    await cleanup();
  }
});

test('receiver: an unreadable env file — 503, the reason redacted', async () => {
  registerSecret(SECRET);
  const { receive, log, cleanup } = await receiver({
    identity: () => Promise.reject(new Error(`boom ${SECRET}`)),
  });
  try {
    assert.equal(await receive(signed(eventBody())), 503);
    const reason = String(log.lines.find((l) => l.level === 'error')?.fields['reason']);
    assert.match(reason, /boom/u);
    assert.ok(!reason.includes(SECRET));
  } finally {
    await cleanup();
  }
});

test('receiver: a bad signature — 401, logged with the reason only', async () => {
  const { receive, log, path, cleanup } = await receiver();
  try {
    const delivery = signed(eventBody(), 'wrong-secret');
    assert.equal(await receive(delivery), 401);
    assert.equal(await receive({ signature: undefined, rawBody: eventBody() }), 401);
    assert.deepEqual(
      log.lines.map((l) => l.fields['reason']),
      ['mismatch', 'missing'],
    );
    assert.ok(log.lines.every((l) => !JSON.stringify(l).includes(delivery.signature)));
    assert.equal((await readWebhookLog(path)).exists, false);
  } finally {
    await cleanup();
  }
});

test('receiver: a signed non-event, or an event for another app — 400', async () => {
  const { receive, path, cleanup } = await receiver();
  try {
    assert.equal(await receive(signed(Buffer.from('not json'))), 400);
    assert.equal(await receive(signed(eventBody({ client_key: 'other-app' }))), 400);
    assert.equal((await readWebhookLog(path)).exists, false);
  } finally {
    await cleanup();
  }
});

test('receiver: a log that cannot be written — 500, and the digest is not remembered', async () => {
  const { dir, cleanup } = await sandbox();
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'a file, not a directory');
  const {
    receive,
    log,
    events,
    cleanup: done,
  } = await receiver({
    logPath: join(blocker, 'webhooks.ndjson'),
  });
  try {
    const delivery = signed(eventBody());
    assert.equal(await receive(delivery), 500);
    assert.equal(await receive(delivery), 500);
    assert.equal(events.length, 0);
    assert.equal(log.lines.filter((l) => l.level === 'error').length, 2);
  } finally {
    await done();
    await cleanup();
  }
});

test('receiver: the redelivery memory is bounded — the oldest digest is forgotten', async () => {
  const { receive, path, events, cleanup } = await receiver();
  try {
    const first = signed(eventBody({ create_time: NOW_S - 1 }));
    assert.equal(await receive(first), 200);
    for (let i = 0; i < RECENT_DIGESTS; i += 1) {
      assert.equal(
        await receive(signed(eventBody({ content: `{"n":${String(i)}}` }))),
        200,
      );
    }
    // Forgotten in memory, so it is recorded again; the reader still dedupes.
    assert.equal(await receive(first), 200);
    assert.equal(events.length, RECENT_DIGESTS + 2);
    assert.equal((await readWebhookLog(path)).records.length, RECENT_DIGESTS + 1);
  } finally {
    await cleanup();
  }
});

// route -------------------------------------------------------------------

test('webhookRouteFor: undefined without TT_WEBHOOK_PATH', () => {
  const settings = loadSettings({});
  assert.equal(webhookRouteFor(settings, recordingLogger(), mockClock()), undefined);
});

test('webhookRouteFor: serves the path and reads the env file per request', async () => {
  const { dir, cleanup } = await sandbox();
  try {
    const envFile = join(dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      'TT_CLIENT_KEY=test-client-key\nTT_CLIENT_SECRET=test-client-secret\n',
      { mode: 0o600 },
    );
    await chmod(envFile, 0o600);
    const settings = loadSettings({
      TT_ENV_FILE: envFile,
      TT_TRANSPORT: 'http',
      TT_HTTP_TOKEN: 'test-http-bearer-0123456789abcdef',
      TT_WEBHOOK_PATH: '/tiktok/events',
    });
    const events: WebhookRecord[] = [];
    const route = webhookRouteFor(settings, recordingLogger(), mockClock(), (r) => {
      events.push(r);
    });
    assert.ok(route !== undefined);
    assert.equal(route.path, '/tiktok/events');
    assert.equal(await route.receive(signed(eventBody())), 200);
    assert.equal(events.length, 1);
    assert.equal((await readWebhookLog(join(dir, 'webhooks.ndjson'))).records.length, 1);

    const withoutHook = webhookRouteFor(settings, recordingLogger(), mockClock());
    assert.equal(await withoutHook?.receive(signed(eventBody({ create_time: 1 }))), 200);
  } finally {
    await cleanup();
  }
});

test('webhookRouteFor: falls back to the default env file location', () => {
  const settings = { ...loadSettings({}), webhookPath: '/hook' };
  delete (settings as { envFile?: string }).envFile;
  const route = webhookRouteFor(settings, recordingLogger(), mockClock());
  assert.equal(route?.path, '/hook');
});

// revocation ------------------------------------------------------------

function revoked(over: Partial<WebhookRecord> = {}): WebhookRecord {
  return record({
    event: AUTHORIZATION_REMOVED,
    user_openid: 'open-brand',
    profile: 'BRAND',
    ...over,
  });
}

function listener(outcome: ForgetOutcome | Error) {
  const log = recordingLogger();
  const forgets: [string, string][] = [];
  const announced: string[] = [];
  const onEvent = revocationListener({
    log,
    forget: (profile, openId) => {
      forgets.push([profile, openId]);
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    },
    onRevoked: (profile) => {
      announced.push(profile);
      return Promise.resolve();
    },
  });
  return { log, forgets, announced, onEvent };
}

test('revocation: authorization.removed clears the profile, then announces it', async () => {
  const { log, forgets, announced, onEvent } = listener('cleared');
  await onEvent(revoked());
  assert.deepEqual(forgets, [['BRAND', 'open-brand']]);
  assert.deepEqual(announced, ['BRAND']);
  assert.equal(log.lines[0]?.level, 'warn');
  assert.equal(log.lines[0]?.fields['profile'], 'BRAND');
});

test('revocation: other events, and an open_id no profile held, are ignored', async () => {
  const { forgets, onEvent } = listener('cleared');
  await onEvent(record({ profile: 'BRAND' }));
  const stranger = revoked();
  delete (stranger as { profile?: string }).profile;
  await onEvent(stranger);
  assert.deepEqual(forgets, []);
});

test('revocation: nothing to clear is logged and not announced', async () => {
  for (const outcome of ['absent', 'other-account'] as const) {
    const { log, announced, onEvent } = listener(outcome);
    await onEvent(revoked());
    assert.deepEqual(announced, []);
    assert.equal(log.lines[0]?.level, 'info');
    assert.equal(log.lines[0]?.fields['outcome'], outcome);
  }
});

test('revocation: an unwritable env file is an error to fix by hand', async () => {
  const { log, announced, onEvent } = listener('unwritable');
  await onEvent(revoked());
  assert.deepEqual(announced, []);
  assert.equal(log.lines[0]?.level, 'error');
  assert.match(log.lines[0]?.msg ?? '', /remove them by hand/u);
});

test('revocation: a failure is logged, redacted, and never rejects', async () => {
  registerSecret('secret-in-error-0123');
  const { log, announced, onEvent } = listener(new Error('boom secret-in-error-0123'));
  await onEvent(revoked());
  assert.deepEqual(announced, []);
  assert.equal(log.lines[0]?.level, 'error');
  assert.doesNotMatch(String(log.lines[0]?.fields['reason']), /secret-in-error-0123/u);
});

test('revocation: by default the env file the process names is cleared', async () => {
  const { dir, cleanup } = await sandbox();
  const previous = process.env['TT_ENV_FILE'];
  try {
    const envFile = join(dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-client-secret',
        'TT_PROFILE_BRAND_ACCESS_TOKEN=act.brand',
        'TT_PROFILE_BRAND_OPEN_ID=open-brand',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    process.env['TT_ENV_FILE'] = envFile;
    // No `onRevoked`: the credential watch's next poll would announce it.
    await revocationListener({ log: recordingLogger() })(revoked());
    const after = await readFile(envFile, 'utf8');
    assert.doesNotMatch(after, /act\.brand/u);
    assert.match(after, /TT_CLIENT_KEY=test-client-key/u);
  } finally {
    if (previous === undefined) delete process.env['TT_ENV_FILE'];
    else process.env['TT_ENV_FILE'] = previous;
    await cleanup();
  }
});
