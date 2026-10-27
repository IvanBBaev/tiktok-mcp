/**
 * `mcp/consent` (TOOLS.md § 2.6.6) — the dialog text, the answer mapping and
 * the capability check. The tool-level behaviour (decline voids the plan,
 * cancel keeps it) lives with the tools that call `confirmWrite`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONSENT_SCHEMA,
  consentAnswerOf,
  consentCancelledError,
  consentDeclinedError,
  consentMessage,
  consentUnavailableError,
  supportsConsentDialog,
} from '../src/mcp/consent.js';

test('only an explicit, checked approval approves', () => {
  assert.equal(
    consentAnswerOf({ action: 'accept', content: { approve: true } }),
    'approved',
  );
  assert.equal(
    consentAnswerOf({ action: 'accept', content: { approve: false } }),
    'declined',
  );
  assert.equal(
    consentAnswerOf({ action: 'accept', content: { approve: 'true' } }),
    'declined',
  );
  assert.equal(consentAnswerOf({ action: 'accept' }), 'declined');
  assert.equal(consentAnswerOf({ action: 'decline' }), 'declined');
  assert.equal(consentAnswerOf({ action: 'cancel' }), 'cancelled');
});

test('the form field starts unchecked and is required', () => {
  assert.deepEqual(CONSENT_SCHEMA.required, ['approve']);
  assert.equal(CONSENT_SCHEMA.properties['approve']?.type, 'boolean');
  assert.equal(
    (CONSENT_SCHEMA.properties['approve'] as { default?: unknown }).default,
    false,
  );
});

test('form elicitation is required; url-only does not count', () => {
  assert.equal(supportsConsentDialog(undefined), false);
  assert.equal(supportsConsentDialog({}), false);
  assert.equal(supportsConsentDialog({ elicitation: { url: {} } }), false);
  assert.equal(supportsConsentDialog({ elicitation: { form: {} } }), true);
});

test('one item reads as one line; several are numbered; run_at is spelled out', () => {
  const single = consentMessage({
    items: [
      {
        action: 'Publish a video',
        account: 'DEFAULT',
        text: 'A clip',
        privacy: 'SELF_ONLY',
      },
    ],
  });
  assert.equal(
    single,
    'Approve this TikTok write? A published post cannot be withdrawn from here.\n' +
      'Publish a video on account \'DEFAULT\' — "A clip" — privacy SELF_ONLY',
  );

  const several = consentMessage({
    items: [
      { action: 'Publish a video', account: 'DEFAULT', text: '  ' },
      { action: 'Publish a photo carousel', account: 'BRAND' },
    ],
    runAt: '2026-11-01T09:00:00.000Z',
  }).split('\n');
  assert.match(several[0] ?? '', /^Approve these 2 TikTok writes\?/);
  assert.equal(several[1], "1. Publish a video on account 'DEFAULT'");
  assert.equal(several[2], "2. Publish a photo carousel on account 'BRAND'");
  assert.match(several[3] ?? '', /^Scheduled for 2026-11-01T09:00:00.000Z/);
});

test('a long title is excerpted, never shown whole', () => {
  const message = consentMessage({
    items: [{ action: 'Publish a video', account: 'DEFAULT', text: 'x'.repeat(500) }],
  });
  assert.ok(message.length < 200);
});

test('the consent errors are catalog codes, none retryable', () => {
  assert.equal(consentDeclinedError().code, 'consent_declined');
  assert.equal(consentCancelledError().code, 'consent_cancelled');
  assert.equal(consentUnavailableError('unsupported').code, 'consent_unavailable');
  assert.deepEqual(consentUnavailableError('failed').details, { reason: 'failed' });
  for (const error of [
    consentDeclinedError(),
    consentCancelledError(),
    consentUnavailableError('unsupported'),
    consentUnavailableError('failed'),
  ]) {
    assert.equal(error.retryable, false);
  }
});
