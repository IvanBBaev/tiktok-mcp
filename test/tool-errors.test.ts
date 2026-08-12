import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { TikTokError } from '../src/core/errors.js';
import { registerSecret } from '../src/core/redact.js';
import {
  describeZodError,
  invalidParamsError,
  missingScopeError,
  publishToolError,
  toolErrorFrom,
  unknownAccountError,
} from '../src/mcp/errors.js';

/** The `ZodError` a schema produces for a given value, or a test failure. */
function zodErrorOf(schema: z.ZodTypeAny, value: unknown): z.ZodError {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, 'expected the value to fail validation');
  assert.ok(parsed.error !== undefined);
  return parsed.error;
}

// ---------------------------------------------------------------------------
// describeZodError — the `<field>: <reason>` half of `invalid_params`
// ---------------------------------------------------------------------------

test('a failing field is named by its dotted path', () => {
  const schema = z
    .object({ post_info: z.object({ title: z.string() }).strict() })
    .strict();
  assert.match(
    describeZodError(zodErrorOf(schema, { post_info: { title: 7 } })),
    /^post_info\.title: /,
  );
});

test('an array element is named by index, not by a bare field name', () => {
  const schema = z.object({ ids: z.array(z.string()) }).strict();
  assert.match(describeZodError(zodErrorOf(schema, { ids: ['a', 2] })), /^ids\[1\]: /);
});

test('a failure at the root reports `arguments` rather than an empty path', () => {
  assert.match(describeZodError(zodErrorOf(z.string(), 7)), /^arguments: /);
});

test('cc-g1: an unknown top-level key names itself', () => {
  const schema = z.object({ max_count: z.number().optional() }).strict();
  assert.equal(
    describeZodError(zodErrorOf(schema, { max_cont: 3 })),
    "max_cont: unknown argument — check the spelling and the tool's input schema",
  );
});

test('cc-g1: an unknown nested key is reported with its parent path', () => {
  const schema = z
    .object({ post_info: z.object({ title: z.string() }).strict() })
    .strict();
  assert.match(
    describeZodError(
      zodErrorOf(schema, { post_info: { title: 'x', privacy: 'PUBLIC' } }),
    ),
    /^post_info\.privacy: unknown argument/,
  );
});

test('several unknown keys at once are listed together', () => {
  const schema = z.object({ a: z.string().optional() }).strict();
  assert.match(describeZodError(zodErrorOf(schema, { b: 1, c: 2 })), /^b, c: unknown/);
});

test('an empty issue list still yields a message instead of undefined', () => {
  assert.equal(describeZodError(new z.ZodError([])), 'arguments: invalid');
});

// ---------------------------------------------------------------------------
// the wrapper-owned catalog entries (TOOLS.md § 3.0)
// ---------------------------------------------------------------------------

test('invalid_params states that nothing was sent upstream', () => {
  const err = invalidParamsError('max_count: expected number');
  assert.equal(err.code, 'invalid_params');
  assert.equal(err.retryable, false);
  assert.equal(
    err.message,
    'Invalid arguments: max_count: expected number. Fix the arguments and call again. ' +
      'No request was sent to TikTok.',
  );
});

test('unknown_account lists the configured profiles and the default', () => {
  const err = unknownAccountError('WROK', ['DEFAULT', 'WORK'], 'DEFAULT');
  assert.equal(err.code, 'unknown_account');
  assert.equal(
    err.message,
    "Unknown account 'WROK'. Configured profiles: DEFAULT, WORK. " +
      "Omit account to use the default profile ('DEFAULT').",
  );
  assert.deepEqual(err.details, {
    configured: ['DEFAULT', 'WORK'],
    default_profile: 'DEFAULT',
  });
});

test('unknown_account says so explicitly when nothing is configured', () => {
  const err = unknownAccountError('WORK', [], 'DEFAULT');
  assert.match(err.message, /Configured profiles: \(none configured\)\./);
  assert.deepEqual(err.details?.['configured'], []);
});

test('unknown_account copies the profile list instead of aliasing it', () => {
  const configured = ['DEFAULT'];
  const err = unknownAccountError('WORK', configured, 'DEFAULT');
  configured.push('LATE');
  assert.deepEqual(err.details?.['configured'], ['DEFAULT']);
});

test('missing_scope names the profile, the scope and the login command', () => {
  const err = missingScopeError('WORK', 'video.publish');
  assert.equal(err.code, 'missing_scope');
  assert.equal(
    err.message,
    "Account 'WORK' was authorized without scope video.publish, which this tool requires. " +
      'Ask the user to run: npx tiktok-mcp-ai login --profile WORK --scopes video.publish — ' +
      'then verify with tiktok_get_auth_status.',
  );
  assert.deepEqual(err.details, { profile: 'WORK', missing_scope: 'video.publish' });
});

// ---------------------------------------------------------------------------
// toolErrorFrom — the single catch-site mapping
// ---------------------------------------------------------------------------

test('a TikTokError keeps its own catalog code, kind and retryability', () => {
  const err = toolErrorFrom(
    new TikTokError({
      code: 'rate_limited',
      kind: 'api',
      message: 'Too many requests.',
      retryable: true,
    }),
  );
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryable, true);
  assert.equal(err.details?.['kind'], 'api');
});

test('remediation is appended to the message', () => {
  const err = toolErrorFrom(
    new TikTokError({
      code: 'invalid_grant',
      kind: 'auth',
      message: 'The refresh token was rejected.',
      retryable: false,
      remediation: 'Run: npx tiktok-mcp-ai login.',
    }),
  );
  assert.equal(
    err.message,
    'The refresh token was rejected. Run: npx tiktok-mcp-ai login.',
  );
});

test('remediation already present in the message is not repeated', () => {
  const err = toolErrorFrom(
    new TikTokError({
      code: 'invalid_grant',
      kind: 'auth',
      message: 'The refresh token was rejected. Run: npx tiktok-mcp-ai login.',
      retryable: false,
      remediation: 'Run: npx tiktok-mcp-ai login.',
    }),
  );
  assert.equal(
    err.message,
    'The refresh token was rejected. Run: npx tiktok-mcp-ai login.',
  );
});

test('log_id and api_code travel as structured fields, not as prose', () => {
  const err = toolErrorFrom(
    new TikTokError({
      code: 'upstream_error',
      kind: 'api',
      message: 'TikTok rejected the request.',
      retryable: false,
      logId: '2026072812345',
      apiCode: 'spam_risk_too_many_posts',
    }),
  );
  assert.equal(err.log_id, '2026072812345');
  assert.equal(err.details?.['api_code'], 'spam_risk_too_many_posts');
  assert.ok(!err.message.includes('spam_risk_too_many_posts'));
});

test('an unexpected throw becomes internal_error with a fixed message', () => {
  const err = toolErrorFrom(new Error('cannot read properties of undefined'));
  assert.equal(err.code, 'internal_error');
  assert.equal(err.retryable, false);
  assert.match(err.message, /bug in tiktok-mcp-ai/);
  assert.match(err.message, /do not retry in a loop/);
  // The thrown text is evidence, not prose the model should read as guidance.
  assert.equal(err.details?.['reason'], 'cannot read properties of undefined');
  assert.ok(!err.message.includes('cannot read properties'));
});

test('a thrown non-Error is stringified rather than dropped', () => {
  assert.equal(toolErrorFrom('boom').details?.['reason'], 'boom');
  assert.equal(toolErrorFrom(undefined).details?.['reason'], 'undefined');
});

test('the thrown text is redacted before it reaches details.reason', () => {
  const secret = 'act.LEAKEDVIASTACKTRACE0123456789';
  registerSecret(secret);
  const err = toolErrorFrom(new Error(`request failed with ${secret}`));
  assert.equal(err.details?.['reason'], 'request failed with [REDACTED]');
});

// ---------------------------------------------------------------------------
// publishToolError — the § 3.0 cap/verification remaps
// ---------------------------------------------------------------------------

/** An upstream refusal as `core/http` mints it, carrying TikTok's own code. */
function upstream(apiCode: string): TikTokError {
  return new TikTokError({
    code: 'upstream_error',
    kind: 'api',
    message: 'TikTok rejected the request.',
    retryable: false,
    logId: '2026080912345',
    apiCode,
  });
}

test('every remapped upstream code becomes an actionable catalog code', () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['spam_risk_too_many_posts', 'daily_post_cap'],
    ['reached_active_user_cap', 'active_user_cap'],
    ['spam_risk_too_many_pending_share', 'pending_share_cap'],
    ['url_ownership_unverified', 'url_prefix_unverified'],
    ['invalid_publish_id', 'publish_not_found'],
  ];
  for (const [apiCode, code] of expected) {
    const err = publishToolError(upstream(apiCode));
    assert.equal(err.code, code, apiCode);
    assert.equal(err.retryable, false, apiCode);
    // § 5.2: the remap replaces TikTok's prose rather than quoting it.
    assert.ok(!err.message.includes('TikTok rejected the request.'), apiCode);
  }
});

test('a remap keeps log_id and the upstream spelling as structured evidence', () => {
  const err = publishToolError(upstream('spam_risk_too_many_posts'));
  assert.equal(err.log_id, '2026080912345');
  assert.equal(err.details?.['api_code'], 'spam_risk_too_many_posts');
});

test('cc-d10: an upstream domain refusal reads as the same failure as the local one', () => {
  const err = publishToolError(upstream('url_ownership_unverified'));
  assert.equal(err.code, 'url_prefix_unverified');
  assert.ok(err.message.includes('TikTok developer portal'));
  assert.ok(err.message.includes('TT_VERIFIED_URL_PREFIXES'));
});

test('an unmapped upstream code falls through to the plain mapping', () => {
  const err = publishToolError(upstream('spam_risk_text'));
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.details?.['api_code'], 'spam_risk_text');
});

test('a TikTokError without an api_code is not remapped by accident', () => {
  const err = publishToolError(
    new TikTokError({
      code: 'rate_limited',
      kind: 'api',
      message: 'Too many requests.',
      retryable: true,
    }),
  );
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryable, true);
});

test('a plain throw still becomes internal_error rather than a publish diagnosis', () => {
  assert.equal(publishToolError(new Error('boom')).code, 'internal_error');
});
