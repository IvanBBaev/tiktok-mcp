import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';

import { redactText, redactValue, registerSecret } from '../src/core/redact.js';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';

/**
 * The secret registry is process-global by design (SECURITY.md: exact-value
 * registration), so every test uses a distinct, obviously-fake value instead
 * of resetting shared state.
 */
const SEED = 20260728;

test('redact allowlisted log fields survive redaction', () => {
  const fields = {
    msg: 'request finished',
    log_id: '2026072812345678',
    http_status: 200,
    retryable: false,
    scopes: ['video.publish', 'video.upload'],
  };
  assert.deepStrictEqual(redactValue(fields), fields);
});

test('redact key matching is separator- and case-insensitive', () => {
  assert.deepStrictEqual(redactValue({ logId: 'a1', LOG_ID: 'a2', 'log-id': 'a3' }), {
    logId: 'a1',
    LOG_ID: 'a2',
    'log-id': 'a3',
  });
});

test('redact unknown key is redacted by default (allowlist default-deny)', () => {
  const out = redactValue({
    x_session_cookie: 'sensitive-looking-but-unknown',
    authorization: 'Bearer abcdef',
    client_secret: 'super-secret',
    refreshToken: 'rft.unregistered.value',
  });
  assert.deepStrictEqual(out, {
    x_session_cookie: REDACTED,
    authorization: REDACTED,
    client_secret: REDACTED,
    refreshToken: REDACTED,
  });
});

test('redact default-deny reaches every depth, not just the top level', () => {
  const out = redactValue({
    error: {
      code: 'plan_mismatch',
      hints: [{ type: 'note', text: 'stale plan', session_cookie: 'nope' }],
    },
  });
  assert.deepStrictEqual(out, {
    error: {
      code: 'plan_mismatch',
      hints: [{ type: 'note', text: 'stale plan', session_cookie: REDACTED }],
    },
  });
});

test('redact a secret used as an object key is scrubbed from the key too', () => {
  const secret = 'tb4-key-secret-6b1f0d94';
  registerSecret(secret);
  const out = redactValue({ [secret]: 'value' });
  assert.deepStrictEqual(out, { [REDACTED]: REDACTED });
});

test('cc-a3 upload_token never survives redaction of an upload_url', () => {
  const uploadToken = 'tb4-upload-token-9c3d51ae';
  registerSecret(uploadToken);
  const out = redactValue({
    upload_url: `https://upload.eu.tiktokapis.com/video/?upload_id=7&upload_token=${uploadToken}`,
    method: 'PUT',
    content_range: 'bytes 0-99/100',
  });
  assert.deepStrictEqual(out, {
    upload_url: 'https://upload.eu.tiktokapis.com/video/',
    method: 'PUT',
    content_range: 'bytes 0-99/100',
  });
});

test('cc-a3 an unregistered upload_token is still stripped with the URL query', () => {
  const out = redactValue({
    url: 'https://upload.eu.tiktokapis.com/video/?upload_token=never-registered-token',
  });
  assert.deepStrictEqual(out, { url: 'https://upload.eu.tiktokapis.com/video/' });
});

test('redact url userinfo credentials are dropped', () => {
  assert.deepStrictEqual(
    redactValue({ url: 'https://user:pw@open.tiktokapis.com/v2/x/' }),
    {
      url: 'https://open.tiktokapis.com/v2/x/',
    },
  );
});

test('redact a plain url without query or userinfo is left intact', () => {
  const url = 'https://open.tiktokapis.com/v2/video/list/';
  assert.deepStrictEqual(redactValue({ url }), { url });
});

test('redact an unparseable url-shaped string is returned unchanged', () => {
  assert.deepStrictEqual(redactValue({ url: 'https://[?x' }), { url: 'https://[?x' });
});

test('cc-b2 body snippet with a registered token is scrubbed', () => {
  const accessToken = 'act.tb4-body-snippet-2f7a44c1';
  registerSecret(accessToken);
  const out = redactValue({
    http_status: 502,
    body_snippet: `<html>gateway error for ${accessToken}</html>`,
  });
  assert.deepStrictEqual(out, {
    http_status: 502,
    body_snippet: `<html>gateway error for ${REDACTED}</html>`,
  });
});

test('redactText scrubs registered secrets out of free text', () => {
  const clientSecret = 'tb4-client-secret-0ab9e733';
  registerSecret(clientSecret);
  assert.equal(
    redactText(`refresh failed for ${clientSecret} (twice: ${clientSecret})`),
    `refresh failed for ${REDACTED} (twice: ${REDACTED})`,
  );
});

test('redactText masks Authorization bearer tokens', () => {
  assert.equal(
    redactText('sent Authorization: Bearer act.unregistered-token~123'),
    'sent Authorization: Bearer ***',
  );
});

test('redactText scrubs sensitive query and form parameters by name', () => {
  assert.equal(
    redactText(
      'POST /v2/oauth/token/ grant_type=authorization_code&code=abc123&code_verifier=xyz789',
    ),
    'POST /v2/oauth/token/ grant_type=authorization_code&code=REDACTED&code_verifier=REDACTED',
  );
  assert.equal(
    redactText('GET https://upload.eu.tiktokapis.com/v/?upload_token=zzz&state=qqq'),
    'GET https://upload.eu.tiktokapis.com/v/?upload_token=REDACTED&state=REDACTED',
  );
});

test('redactText and registerSecret ignore trivially short values', () => {
  registerSecret('');
  registerSecret('ok');
  assert.equal(redactText('ok, everything is ok'), 'ok, everything is ok');
});

test('redactText is idempotent', () => {
  const refreshToken = 'rft.tb4-idempotent-8d21ca50';
  registerSecret(refreshToken);
  const once = redactText(
    `Bearer ${refreshToken} sent as ?access_token=${refreshToken}&state=s1`,
  );
  assert.equal(redactText(once), once);
});

test('redact over-redaction guard: ids, titles and hints survive', () => {
  const fields = {
    publish_id: 'v_pub_url~v2.123456789',
    open_id: 'a1b2…y9z0',
    title_excerpt: 'My best video yet',
    title: 'My best video yet',
    hints: [
      {
        type: 'poll',
        tool: 'tiktok_get_publish_status',
        poll_after: '2026-07-28T10:00:00Z',
      },
    ],
  };
  assert.deepStrictEqual(redactValue(fields), fields);
});

test('redact scalars pass through and non-serializable values are denied', () => {
  assert.equal(redactValue('plain text'), 'plain text');
  assert.equal(redactValue(42), 42);
  assert.equal(redactValue(true), true);
  assert.equal(redactValue(null), null);
  assert.equal(redactValue(undefined), undefined);
  assert.deepStrictEqual(redactValue({ bytes: 64_000_000n }), { bytes: '64000000' });
  assert.deepStrictEqual(redactValue({ tool: () => 'x' }), { tool: REDACTED });
  assert.deepStrictEqual(redactValue({ tool: Symbol('t') }), { tool: REDACTED });
});

test('cc-h2 Date values render as ISO-8601 UTC, invalid dates are denied', () => {
  assert.deepStrictEqual(redactValue({ created_at: new Date(1_769_000_000_000) }), {
    created_at: '2026-01-21T12:53:20.000Z',
  });
  assert.deepStrictEqual(redactValue({ created_at: new Date(Number.NaN) }), {
    created_at: REDACTED,
  });
});

test('redact non-plain objects are denied wholesale', () => {
  assert.equal(redactValue(new Map([['a', 1]])), REDACTED);
  assert.deepStrictEqual(redactValue({ error: new Set([1]) }), { error: REDACTED });
  assert.deepStrictEqual(redactValue({ bytes: new Uint8Array([1, 2]) }), {
    bytes: REDACTED,
  });
  assert.deepStrictEqual(redactValue(Object.create(null)), {});
});

test('redact Error instances expose name, message and allowlisted fields only', () => {
  const logId = 'log-tb4-error-77';
  const err = Object.assign(new Error('upstream said Bearer act.leak-me'), {
    code: 'plan_not_found',
    log_id: logId,
    client_secret: 'tb4-error-secret-4411af02',
  });
  const out = redactValue({ error: err }) as { error: Record<string, unknown> };
  assert.deepStrictEqual(out.error, {
    name: 'Error',
    message: 'upstream said Bearer ***',
    code: 'plan_not_found',
    log_id: logId,
    client_secret: REDACTED,
  });
  assert.equal('stack' in out.error, false);
});

test('redact arrays are redacted element-wise', () => {
  assert.deepStrictEqual(
    redactValue({ records: [{ tool: 't', secret_field: 's' }, 7, 'x'] }),
    {
      records: [{ tool: 't', secret_field: REDACTED }, 7, 'x'],
    },
  );
  assert.deepStrictEqual(redactValue([{ msg: 'a' }]), [{ msg: 'a' }]);
});

test('redact circular structures are marked, shared references are not', () => {
  const node: Record<string, unknown> = { msg: 'root' };
  node.error = node;
  assert.deepStrictEqual(redactValue(node), { msg: 'root', error: CIRCULAR });

  const shared = { msg: 'shared' };
  assert.deepStrictEqual(redactValue({ error: shared, hints: shared }), {
    error: { msg: 'shared' },
    hints: { msg: 'shared' },
  });
});

test('redact deeply nested structures are denied past the depth limit', () => {
  let deep: Record<string, unknown> = { msg: 'bottom' };
  for (let i = 0; i < 12; i += 1) deep = { error: deep };
  const json = JSON.stringify(redactValue(deep));
  assert.equal(json.includes('bottom'), false);
  assert.equal(json.includes(REDACTED), true);
});

test('redact property: redactValue is idempotent for arbitrary values', () => {
  fc.assert(
    fc.property(
      fc.anything({
        withBigInt: true,
        withDate: true,
        withMap: true,
        withSet: true,
        withTypedArray: true,
        withNullPrototype: true,
      }),
      (value) => {
        const once = redactValue(value);
        assert.deepStrictEqual(redactValue(once), once);
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

test('redact property: a registered secret never survives redactValue', () => {
  const secret = 'tb4-property-secret-4f9a2c8e1d';
  registerSecret(secret);
  fc.assert(
    fc.property(fc.jsonValue(), fc.string(), (shape, noise) => {
      const payload = {
        msg: `${noise}${secret}`,
        title: secret,
        data: shape,
        [secret]: shape,
        error: { code: secret, unknown_field: secret },
      };
      assert.equal(JSON.stringify(redactValue(payload)).includes(secret), false);
    }),
    { seed: SEED, numRuns: 200 },
  );
});
