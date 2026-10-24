/**
 * `tiktok_list_webhook_events` (TOOLS.md § 3.8) — the read side of the webhook
 * receiver. Closed-world like the journal tool: no fetch stub, a real log file
 * beside a real env file in an `fsSandbox()`.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import type { ToolResult } from '../src/mcp/result.js';
import { appendWebhookRecord, type WebhookRecord } from '../src/mcp/webhook.js';
import {
  listWebhookEventsTool,
  type ListWebhookEventsData,
} from '../src/tools/webhooks.js';
import { fsSandbox, mockClock, withEnv } from './helpers.js';

const NOOP_LOGGER = createLogger({ level: 'error' });

function toolCtx(env: Record<string, string>): ToolCtx {
  const api = createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings(env),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
  return { api, log: NOOP_LOGGER };
}

function record(n: number, over: Partial<WebhookRecord> = {}): WebhookRecord {
  return {
    v: 1,
    received_at: new Date(Date.UTC(2026, 0, 1, 12, n)).toISOString(),
    digest: `d${String(n)}`,
    event: 'post.publish.complete',
    create_time: 1_767_225_600 + n,
    user_openid: 'open-default',
    profile: 'DEFAULT',
    content: {},
    ...over,
  };
}

async function withLog<T>(
  records: readonly WebhookRecord[] | undefined,
  fn: (env: Record<string, string>, dir: string) => Promise<T>,
): Promise<T> {
  const sandbox = await fsSandbox();
  try {
    const envFile = join(sandbox.dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      'TT_CLIENT_KEY=test-client-key\nTT_CLIENT_SECRET=test-secret\n',
      { mode: 0o600 },
    );
    if (records !== undefined) {
      for (const r of records)
        await appendWebhookRecord(join(sandbox.dir, 'webhooks.ndjson'), r);
    }
    return await fn({ TT_ENV_FILE: envFile }, sandbox.dir);
  } finally {
    await sandbox.cleanup();
  }
}

function dataOf(result: ToolResult<ListWebhookEventsData>): ListWebhookEventsData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

test('an entry carries the event, both times, account, open_id, publish_id and content', async () => {
  const result = await withLog(
    [record(0, { publish_id: 'pub-1', content: { publish_id: 'pub-1' } })],
    async (env) => listWebhookEventsTool.handler({}, toolCtx(env)),
  );
  assert.deepEqual(dataOf(result).events, [
    {
      received_at: '2026-01-01T12:00:00.000Z',
      event: 'post.publish.complete',
      created_at: new Date((1_767_225_600 + 0) * 1000).toISOString(),
      account: 'DEFAULT',
      open_id: 'open-default',
      publish_id: 'pub-1',
      content: { publish_id: 'pub-1' },
    },
  ]);
  assert.equal(result.hints, undefined);
});

test('an event from an unknown open_id has no account', async () => {
  const stranger = { ...record(0), user_openid: 'stranger' };
  delete (stranger as { profile?: string }).profile;
  const result = await withLog([stranger], async (env) =>
    listWebhookEventsTool.handler({}, toolCtx(env)),
  );
  const [entry] = dataOf(result).events;
  assert.equal(entry?.account, undefined);
  assert.equal(entry?.publish_id, undefined);
});

test('newest first, limit cuts the answer but not total_matching, and the path is reported', async () => {
  const records = Array.from({ length: 25 }, (_, n) => record(n));
  await withLog(records, async (env, dir) => {
    const ctx = toolCtx(env);
    const byDefault = dataOf(await listWebhookEventsTool.handler({}, ctx));
    assert.equal(byDefault.events.length, 20);
    assert.equal(byDefault.events[0]?.received_at, records[24]?.received_at);
    assert.equal(byDefault.meta.total_matching, 25);
    assert.equal(byDefault.meta.log_path, join(dir, 'webhooks.ndjson'));
    const three = dataOf(await listWebhookEventsTool.handler({ limit: 3 }, ctx));
    assert.equal(three.events.length, 3);
  });
});

test('event, publish_id and account filter; account is spelling-insensitive', async () => {
  const records = [
    record(0, { event: 'post.publish.failed', publish_id: 'p1' }),
    record(1, { publish_id: 'p1' }),
    record(2, { profile: 'BRAND', publish_id: 'p2' }),
  ];
  await withLog(records, async (env) => {
    const ctx = toolCtx(env);
    const list = async (args: Record<string, string>): Promise<number> =>
      dataOf(await listWebhookEventsTool.handler(args, ctx)).meta.total_matching;
    assert.equal(await list({ event: 'post.publish.failed' }), 1);
    assert.equal(await list({ publish_id: 'p1' }), 2);
    assert.equal(await list({ account: ' brand ' }), 1);
    assert.equal(await list({ account: 'BRAND', publish_id: 'p1' }), 0);
    // A blank account names nobody, so it filters nothing.
    assert.equal(await list({ account: '  ' }), 3);
  });
});

test('a locked profile only ever sees its own events', async () => {
  const records = [record(0), record(1, { profile: 'BRAND' })];
  await withLog(records, async (env) => {
    const base = toolCtx(env);
    const ctx: ToolCtx = {
      ...base,
      api: { ...base.api, settings: { ...base.api.settings, lockProfile: 'BRAND' } },
    };
    const all = dataOf(await listWebhookEventsTool.handler({}, ctx));
    assert.deepEqual(
      all.events.map((e) => e.account),
      ['BRAND'],
    );
    const other = dataOf(
      await listWebhookEventsTool.handler({ account: 'default' }, ctx),
    );
    assert.equal(other.meta.total_matching, 0);
  });
});

test('no log yet: a note that says how to set the receiver up — or how to check it', async () => {
  await withLog(undefined, async (env) => {
    const off = await listWebhookEventsTool.handler({}, toolCtx(env));
    assert.deepEqual(dataOf(off).events, []);
    assert.match(off.hints?.[0]?.text ?? '', /set TT_WEBHOOK_PATH/u);

    const on = await listWebhookEventsTool.handler(
      {},
      toolCtx({
        ...env,
        TT_TRANSPORT: 'http',
        TT_HTTP_TOKEN: 'test-http-bearer-0123456789abcdef',
        TT_WEBHOOK_PATH: '/tiktok/events',
      }),
    );
    assert.match(on.hints?.[0]?.text ?? '', /No webhook event has been received yet/u);
  });
});

test('unreadable lines are counted and noted', async () => {
  await withLog([record(0)], async (env, dir) => {
    await writeFile(join(dir, 'webhooks.ndjson'), '{"torn":\n', { flag: 'a' });
    const result = await listWebhookEventsTool.handler({}, toolCtx(env));
    assert.equal(dataOf(result).meta.skipped_lines, 1);
    assert.equal(dataOf(result).events.length, 1);
    assert.match(
      result.hints?.[0]?.text ?? '',
      /1 webhook log line\(s\) were unreadable/u,
    );
  });
});

test('without TT_ENV_FILE in settings the default env file location is used', async () => {
  await withLog([record(0)], async (env, dir) => {
    const ctx = toolCtx({});
    const settings = { ...ctx.api.settings };
    delete (settings as { envFile?: string }).envFile;
    const pending = withEnv({ TT_ENV_FILE: env['TT_ENV_FILE'] }, () =>
      listWebhookEventsTool.handler({}, { ...ctx, api: { ...ctx.api, settings } }),
    );
    const data = dataOf(await pending);
    assert.equal(data.meta.log_path, join(dir, 'webhooks.ndjson'));
  });
});
