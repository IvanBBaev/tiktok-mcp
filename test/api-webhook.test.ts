/**
 * `api/webhook` — signature verification and event decoding (TIKTOK-API.md § 10).
 * Pure functions: no network, no files, no clock beyond the `nowMs` argument.
 */

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  DEFAULT_SIGNATURE_TOLERANCE_S,
  WEBHOOK_EVENTS,
  eventDigest,
  eventPublishId,
  isKnownEvent,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../src/api/webhook.js';

const SECRET = 'test-client-secret';
const NOW_S = 1_767_225_600;
const NOW_MS = NOW_S * 1000;

function sign(body: Buffer, t: number = NOW_S, secret: string = SECRET): string {
  return createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(body)
    .digest('hex');
}

function body(fields: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

const EVENT = body({
  client_key: 'test-client-key',
  event: 'post.publish.complete',
  create_time: NOW_S,
  user_openid: 'test-open-id',
  content: JSON.stringify({ publish_id: 'v_pub_file~v2.123' }),
});

function verify(header: string | undefined, raw: Buffer = EVENT, toleranceS?: number) {
  return verifyWebhookSignature({
    header,
    rawBody: raw,
    clientSecret: SECRET,
    nowMs: NOW_MS,
    ...(toleranceS === undefined ? {} : { toleranceS }),
  });
}

test('verifyWebhookSignature: a genuine t=…,s=… header passes', () => {
  assert.deepEqual(verify(`t=${String(NOW_S)},s=${sign(EVENT)}`), { ok: true });
});

test('verifyWebhookSignature: parts in any order, with spaces and upper-case hex', () => {
  const header = ` s=${sign(EVENT).toUpperCase()} , t=${String(NOW_S)} `;
  assert.deepEqual(verify(header), { ok: true });
});

test('verifyWebhookSignature: an absent or empty header is missing', () => {
  assert.deepEqual(verify(undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(verify(''), { ok: false, reason: 'missing' });
});

test('verifyWebhookSignature: a header without both sane parts is malformed', () => {
  for (const header of [
    `t=${String(NOW_S)}`,
    `s=${sign(EVENT)}`,
    `t=abc,s=${sign(EVENT)}`,
    `t=${String(NOW_S)},s=nothex`,
    `t=${String(NOW_S)},s=${sign(EVENT).slice(2)}`,
    'garbage',
    `x=1,t=${String(NOW_S)}`,
  ]) {
    assert.deepEqual(verify(header), { ok: false, reason: 'malformed' }, header);
  }
});

test('verifyWebhookSignature: a timestamp outside the window is stale, either way', () => {
  const past = NOW_S - DEFAULT_SIGNATURE_TOLERANCE_S - 1;
  const future = NOW_S + DEFAULT_SIGNATURE_TOLERANCE_S + 1;
  assert.deepEqual(verify(`t=${String(past)},s=${sign(EVENT, past)}`), {
    ok: false,
    reason: 'stale',
  });
  assert.deepEqual(verify(`t=${String(future)},s=${sign(EVENT, future)}`), {
    ok: false,
    reason: 'stale',
  });
});

test('verifyWebhookSignature: the tolerance argument widens and narrows the window', () => {
  const old = NOW_S - 600;
  const header = `t=${String(old)},s=${sign(EVENT, old)}`;
  assert.deepEqual(verify(header, EVENT, 900), { ok: true });
  const edge = NOW_S - 30;
  assert.deepEqual(verify(`t=${String(edge)},s=${sign(EVENT, edge)}`, EVENT, 30), {
    ok: true,
  });
  assert.deepEqual(
    verify(`t=${String(edge - 1)},s=${sign(EVENT, edge - 1)}`, EVENT, 30),
    {
      ok: false,
      reason: 'stale',
    },
  );
});

test('verifyWebhookSignature: another secret, another body or another t is a mismatch', () => {
  const t = String(NOW_S);
  assert.deepEqual(verify(`t=${t},s=${sign(EVENT, NOW_S, 'other-secret')}`), {
    ok: false,
    reason: 'mismatch',
  });
  assert.deepEqual(
    verify(`t=${t},s=${sign(EVENT)}`, Buffer.concat([EVENT, Buffer.from(' ')])),
    {
      ok: false,
      reason: 'mismatch',
    },
  );
  assert.deepEqual(verify(`t=${String(NOW_S - 1)},s=${sign(EVENT)}`), {
    ok: false,
    reason: 'mismatch',
  });
});

test('parseWebhookEvent: decodes the envelope and the JSON-string content', () => {
  assert.deepEqual(parseWebhookEvent(EVENT), {
    client_key: 'test-client-key',
    event: 'post.publish.complete',
    create_time: NOW_S,
    user_openid: 'test-open-id',
    content: { publish_id: 'v_pub_file~v2.123' },
  });
});

test('parseWebhookEvent: content as an object is kept; anything else decodes to {}', () => {
  const base = {
    client_key: 'k',
    event: 'authorization.removed',
    create_time: NOW_S,
    user_openid: 'o',
  };
  assert.deepEqual(
    parseWebhookEvent(body({ ...base, content: { reason: 1 } }))?.content,
    {
      reason: 1,
    },
  );
  for (const content of [undefined, 42, null, '[1,2]', 'not json', '"str"']) {
    assert.deepEqual(
      parseWebhookEvent(body({ ...base, content }))?.content,
      {},
      String(content),
    );
  }
});

test('parseWebhookEvent: an unusable envelope is undefined', () => {
  const good = {
    client_key: 'k',
    event: 'e',
    create_time: NOW_S,
    user_openid: 'o',
    content: '{}',
  };
  assert.equal(parseWebhookEvent(Buffer.from('not json')), undefined);
  assert.equal(parseWebhookEvent(Buffer.from('[1]')), undefined);
  assert.equal(parseWebhookEvent(Buffer.from('null')), undefined);
  for (const [key, value] of [
    ['client_key', ''],
    ['client_key', 7],
    ['event', ''],
    ['event', null],
    ['create_time', '1'],
    ['user_openid', 3],
  ] as const) {
    assert.equal(parseWebhookEvent(body({ ...good, [key]: value })), undefined, key);
  }
  // JSON cannot carry a non-finite number, so the finiteness guard is reached
  // only through a huge literal that parses to Infinity.
  const infinite = Buffer.from(
    '{"client_key":"k","event":"e","create_time":1e999,"user_openid":"o"}',
  );
  assert.equal(parseWebhookEvent(infinite), undefined);
});

test('eventDigest: SHA-256 hex of the raw bytes', () => {
  assert.equal(eventDigest(EVENT), createHash('sha256').update(EVENT).digest('hex'));
  assert.notEqual(
    eventDigest(EVENT),
    eventDigest(Buffer.concat([EVENT, Buffer.from('\n')])),
  );
});

test('eventPublishId: a non-empty string publish_id, else undefined', () => {
  const event = parseWebhookEvent(EVENT);
  assert.ok(event !== undefined);
  assert.equal(eventPublishId(event), 'v_pub_file~v2.123');
  assert.equal(eventPublishId({ ...event, content: { publish_id: '' } }), undefined);
  assert.equal(eventPublishId({ ...event, content: { publish_id: 5 } }), undefined);
  assert.equal(eventPublishId({ ...event, content: {} }), undefined);
});

test('isKnownEvent: every listed event, and nothing else', () => {
  for (const name of WEBHOOK_EVENTS) assert.equal(isKnownEvent(name), true);
  assert.equal(isKnownEvent('post.publish.unknown'), false);
  assert.ok(Object.isFrozen(WEBHOOK_EVENTS));
});
