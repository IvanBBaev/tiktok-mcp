import assert from 'node:assert/strict';
import test from 'node:test';

import { isTikTokError, TikTokError, type ErrorKind } from '../src/core/errors.js';
import { registerSecret } from '../src/core/redact.js';

test('cc-b9 api_code and log_id are carried when the upstream response provides them', () => {
  const err = new TikTokError({
    kind: 'api',
    code: 'upstream_error',
    message: 'TikTok returned an error: internal error.',
    apiCode: 'internal_error',
    logId: '20260728120000ABCDEF',
    retryable: true,
  });

  assert.equal(err.kind, 'api');
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.apiCode, 'internal_error');
  assert.equal(err.logId, '20260728120000ABCDEF');
  assert.equal(err.retryable, true);
});

test('cc-b9 an upstream error without log_id is constructed and rendered without it', () => {
  const err = new TikTokError({
    kind: 'api',
    code: 'upstream_error',
    message: 'TikTok returned an error: invalid parameter.',
    apiCode: 'invalid_params',
  });

  assert.equal(err.logId, undefined);
  assert.equal(err.apiCode, 'invalid_params');
  // Nothing may interpolate an absent log_id into user-facing text.
  assert.ok(!err.message.includes('undefined'));
  assert.ok(!String(err).includes('undefined'));
});

test('cc-b9 the whole envelope is readable from the error alone', () => {
  const err = new TikTokError({
    kind: 'api',
    code: 'rate_limited',
    message: 'TikTok rate limit reached for this endpoint.',
    apiCode: 'rate_limit_exceeded',
    logId: '2026072812345XYZ',
    retryable: true,
  });

  // Exactly the fields mcp/result needs for { code, message, retryable,
  // api_code?, log_id? } — no extra lookup, no assumption about log_id.
  assert.deepEqual(
    {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      api_code: err.apiCode,
      log_id: err.logId,
    },
    {
      code: 'rate_limited',
      message: 'TikTok rate limit reached for this endpoint.',
      retryable: true,
      api_code: 'rate_limit_exceeded',
      log_id: '2026072812345XYZ',
    },
  );
});

test('retryable defaults to false so no write is replayed by accident', () => {
  const err = new TikTokError({
    kind: 'policy',
    code: 'possible_duplicate',
    message: 'A publish attempt with this title was already journaled.',
  });

  assert.equal(err.retryable, false);
  assert.equal(err.apiCode, undefined);
  assert.equal(err.logId, undefined);
  assert.equal(err.remediation, undefined);
});

test('a TikTokError is a real Error: name, message, stack and prototype chain', () => {
  const err = new TikTokError({
    kind: 'validation',
    code: 'invalid_params',
    message: 'Invalid arguments: title: too long. No request was sent to TikTok.',
  });

  assert.ok(err instanceof TikTokError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'TikTokError');
  assert.equal(
    err.message,
    'Invalid arguments: title: too long. No request was sent to TikTok.',
  );
  assert.equal(typeof err.stack, 'string');
  assert.ok((err.stack ?? '').includes('TikTokError'));
});

test('the cause is preserved for diagnostics', () => {
  const cause = new Error('ECONNRESET');
  const err = new TikTokError({
    kind: 'network',
    code: 'network_unsent',
    message: 'The network failed before the publish request was sent.',
    cause,
  });

  assert.equal(err.cause, cause);
});

test('remediation is optional and survives verbatim when supplied', () => {
  const err = new TikTokError({
    kind: 'auth',
    code: 'auth_expired',
    message: "TikTok rejected the token for account 'DEFAULT'.",
    remediation: 'npx tiktok-mcp-ai login --profile DEFAULT',
  });

  assert.equal(err.remediation, 'npx tiktok-mcp-ai login --profile DEFAULT');
});

test('every kind of the taxonomy is accepted and preserved', () => {
  const kinds: ErrorKind[] = [
    'config',
    'auth',
    'api',
    'network',
    'validation',
    'policy',
    'internal',
  ];

  for (const kind of kinds) {
    const err = new TikTokError({ kind, code: 'x', message: 'y' });
    assert.equal(err.kind, kind);
  }
});

test('isTikTokError narrows only genuine TikTokError values', () => {
  const err = new TikTokError({ kind: 'internal', code: 'internal', message: 'boom' });

  assert.equal(isTikTokError(err), true);
  assert.equal(isTikTokError(new Error('boom')), false);
  assert.equal(isTikTokError(new TypeError('boom')), false);
  assert.equal(isTikTokError({ kind: 'api', code: 'x', message: 'y' }), false);
  assert.equal(isTikTokError(null), false);
  assert.equal(isTikTokError(undefined), false);
  assert.equal(isTikTokError('TikTokError'), false);

  if (isTikTokError(err)) {
    // Narrowing gives the taxonomy fields without a cast.
    assert.equal(err.code, 'internal');
  }
});

test('a registered secret is scrubbed out of the message and the remediation', () => {
  const secret = 'act.SEEDED-ERROR-SECRET-0123456789abcdef';
  registerSecret(secret);

  const err = new TikTokError({
    kind: 'auth',
    code: 'auth_expired',
    message: `TikTok rejected the token ${secret} for account 'DEFAULT'.`,
    remediation: `retry with ${secret}`,
  });

  assert.ok(!err.message.includes(secret));
  assert.ok(!(err.remediation ?? '').includes(secret));
  // Only the secret is removed; the surrounding sentence stays intact.
  assert.ok(err.message.includes("for account 'DEFAULT'."));
});
