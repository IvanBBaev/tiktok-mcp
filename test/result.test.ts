import assert from 'node:assert/strict';
import test from 'node:test';

import fc from 'fast-check';

import { isTikTokError } from '../src/core/errors.js';
import { registerSecret } from '../src/core/redact.js';
import {
  HINT_TYPES,
  RESULT_JSON_SCHEMA,
  toToolContent,
  truncateResult,
  type Hint,
  type ToolResult,
} from '../src/mcp/result.js';

/** The documented default of `TT_RESULT_CHAR_BUDGET`. */
const DEFAULT_BUDGET = 60_000;

interface VideoRow {
  id: string;
  title: string;
}

function videoPage(count: number, titleChars = 40): ToolResult<unknown> {
  const videos: VideoRow[] = [];
  for (let i = 0; i < count; i += 1) {
    videos.push({ id: `v${String(i)}`, title: 'x'.repeat(titleChars) });
  }
  return { ok: true, data: { videos, meta: { account: 'DEFAULT' } } };
}

function videosOf(result: ToolResult<unknown>): VideoRow[] {
  const data = result.data as { videos?: VideoRow[] } | undefined;
  return data?.videos ?? [];
}

function metaOf(result: ToolResult<unknown>): Record<string, unknown> {
  const data = result.data as { meta?: Record<string, unknown> } | undefined;
  return data?.meta ?? {};
}

// ---------------------------------------------------------------------------
// envelope + redaction (TOOLS.md §§ 2.1, 2.4, 2.5)
// ---------------------------------------------------------------------------

test('a result that fits is returned untouched and reports truncated: false', () => {
  const input: ToolResult<unknown> = {
    ok: true,
    data: { videos: [{ id: 'v1' }], meta: { account: 'WORK' } },
  };
  const out = truncateResult(input, DEFAULT_BUDGET);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.result, input);
  assert.deepEqual(JSON.parse(out.text), input);
});

test('every string value is redacted before serialization (§ 2.5)', () => {
  const secret = 'act.SUPERSECRETACCESSTOKEN0123456789';
  registerSecret(secret);
  const out = truncateResult(
    {
      ok: false,
      error: { code: 'internal_error', message: `boom ${secret}`, retryable: false },
      hints: [{ type: 'note', text: `token was ${secret}` }],
    },
    DEFAULT_BUDGET,
  );
  assert.ok(!out.text.includes(secret), 'the text block still leaks the secret');
  assert.equal(out.result.error?.message, 'boom [REDACTED]');
  assert.equal(out.result.hints?.[0]?.text, 'token was [REDACTED]');
});

test('redaction inside a string keeps the surrounding JSON parseable', () => {
  const secret = 'rft.QUOTE"AND\\BACKSLASH.0123456789';
  registerSecret(secret);
  const out = truncateResult(
    { ok: true, data: { note: `before ${secret} after` } },
    DEFAULT_BUDGET,
  );
  assert.deepEqual(JSON.parse(out.text), out.result);
});

test('object keys are left alone — only values are scrubbed', () => {
  const out = truncateResult(
    { ok: true, data: { access_token_hint: 'plain', meta: {} } },
    DEFAULT_BUDGET,
  );
  const data = out.result.data as Record<string, unknown>;
  assert.equal(data['access_token_hint'], 'plain');
});

test('a non-serializable result is a server bug, not a silent empty payload', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(
    () => truncateResult({ ok: true, data: cyclic }, DEFAULT_BUDGET),
    (err: unknown) => isTikTokError(err) && err.code === 'result_not_serializable',
  );
});

test('toToolContent returns exactly the text of truncateResult', () => {
  const input = videoPage(500);
  assert.equal(toToolContent(input, 2_000), truncateResult(input, 2_000).text);
});

// ---------------------------------------------------------------------------
// the truncation ladder (TOOLS.md § 2.4, CC-G2)
// ---------------------------------------------------------------------------

test('cc-g2: an oversized page drops trailing items and stays valid JSON', () => {
  const out = truncateResult(videoPage(500), 2_000);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 2_000);
  assert.deepEqual(JSON.parse(out.text), out.result);
  const kept = videosOf(out.result);
  assert.ok(kept.length > 0 && kept.length < 500);
  // The prefix is intact: item N is still item N.
  assert.equal(kept[0]?.id, 'v0');
  assert.equal(kept.at(-1)?.id, `v${String(kept.length - 1)}`);
});

test('the elision keeps the largest prefix that fits, not an arbitrary one', () => {
  const budget = 2_000;
  const out = truncateResult(videoPage(500), budget);
  const kept = videosOf(out.result);
  // One more item of the same page would have pushed the text over the budget,
  // so the binary search stopped at the maximum rather than early.
  const nextItem = JSON.stringify({
    id: `v${String(kept.length)}`,
    title: 'x'.repeat(40),
  });
  assert.ok(out.text.length + nextItem.length + 1 > budget);
});

test('the truncation marker records the reason and the item count', () => {
  const out = truncateResult(videoPage(500), 2_000);
  assert.deepEqual(metaOf(out.result)['truncation'], {
    truncated: true,
    reason: 'char_budget',
    returned: videosOf(out.result).length,
  });
});

test('a note hint explains the elision and names the budget', () => {
  const out = truncateResult(videoPage(500), 2_000);
  const note = out.result.hints?.at(-1);
  assert.equal(note?.type, 'note');
  assert.match(note?.text ?? '', /2000-character response budget/);
  assert.match(note?.text ?? '', /of 500 items returned/);
  assert.match(note?.text ?? '', /Narrow the request/);
});

test('an existing resume_cursor is carried into the marker and the note', () => {
  const page = videoPage(500);
  const data = page.data as Record<string, unknown>;
  data['meta'] = { account: 'DEFAULT', truncation: { resume_cursor: 'cursor-123' } };
  const out = truncateResult(page, 2_000);
  const marker = metaOf(out.result)['truncation'] as Record<string, unknown>;
  assert.equal(marker['resume_cursor'], 'cursor-123');
  assert.match(out.result.hints?.at(-1)?.text ?? '', /cursor "cursor-123"/);
});

test('a resume_cursor is never invented when the tool did not supply one', () => {
  const out = truncateResult(videoPage(500), 2_000);
  const marker = metaOf(out.result)['truncation'] as Record<string, unknown>;
  assert.equal(marker['resume_cursor'], undefined);
});

test('an oversized payload with no array to elide is reduced to its meta block', () => {
  const out = truncateResult(
    {
      ok: true,
      data: {
        creator_info: { nickname: 'n'.repeat(2_000) },
        meta: { account: 'DEFAULT' },
      },
    },
    400,
  );
  assert.deepEqual(Object.keys(out.result.data as object), ['meta']);
  assert.equal(metaOf(out.result)['account'], 'DEFAULT');
  assert.deepEqual(metaOf(out.result)['truncation'], {
    truncated: true,
    reason: 'char_budget',
    returned: 0,
  });
  assert.match(out.result.hints?.at(-1)?.text ?? '', /payload was omitted/);
  assert.deepEqual(JSON.parse(out.text), out.result);
});

test('cc-g7: the floor keeps ok, error, hints and journal when nothing else fits', () => {
  const out = truncateResult(
    {
      ok: false,
      data: { videos: [{ id: 'v'.repeat(500) }] },
      error: { code: 'rate_limited', message: 'Too many requests.', retryable: true },
      journal: 'unavailable',
    },
    120,
  );
  assert.equal(out.result.ok, false);
  assert.equal(out.result.data, undefined);
  assert.equal(out.result.error?.code, 'rate_limited');
  assert.equal(out.result.journal, 'unavailable');
  assert.ok((out.result.hints ?? []).length > 0);
});

test('cc-g7: validity beats the budget — a bare envelope is never sliced', () => {
  const out = truncateResult(
    {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'm'.repeat(400),
        retryable: false,
      },
    },
    10,
  );
  assert.ok(out.text.length > 10, 'the floor was expected to exceed a tiny budget');
  assert.deepEqual(JSON.parse(out.text), out.result);
  assert.equal(out.result.error?.code, 'internal_error');
});

test('a budget of zero still yields parseable JSON', () => {
  const out = truncateResult({ ok: true, data: { videos: [{ id: 'v1' }] } }, 0);
  assert.deepEqual(JSON.parse(out.text), out.result);
  assert.equal(out.result.ok, true);
});

test('the biggest top-level array is the one elided', () => {
  const out = truncateResult(
    {
      ok: true,
      data: {
        warnings: ['short'],
        videos: Array.from({ length: 300 }, (_, i) => ({ id: `v${String(i)}` })),
        meta: {},
      },
    },
    1_500,
  );
  const data = out.result.data as { warnings: string[]; videos: unknown[] };
  assert.deepEqual(data.warnings, ['short'], 'the small array must survive intact');
  assert.ok(data.videos.length < 300);
});

test('a result already at three hints does not gain a fourth', () => {
  const hints: Hint[] = [
    { type: 'wait', text: 'a' },
    { type: 'poll', text: 'b' },
    { type: 'user_action', text: 'c' },
  ];
  const out = truncateResult({ ...videoPage(500), hints }, 2_000);
  assert.equal(out.result.hints?.length, 3);
});

test('pretty output is indented and still respects the budget', () => {
  const out = truncateResult(videoPage(500), 4_000, { pretty: true });
  assert.ok(out.text.includes('\n  '), 'expected indented JSON');
  assert.ok(out.text.length <= 4_000);
  assert.deepEqual(JSON.parse(out.text), out.result);
  // Indentation costs budget, so pretty keeps strictly fewer items.
  const compact = truncateResult(videoPage(500), 4_000);
  assert.ok(videosOf(out.result).length < videosOf(compact.result).length);
});

// ---------------------------------------------------------------------------
// CC-G2 as a property: valid JSON at every budget, for every payload
// ---------------------------------------------------------------------------

test('cc-g2: the text is parseable JSON and mirrors the result at any budget', () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ id: fc.string(), title: fc.string() }), { maxLength: 40 }),
      fc.integer({ min: 0, max: 3_000 }),
      fc.boolean(),
      (videos, budget, pretty) => {
        const out = truncateResult({ ok: true, data: { videos, meta: {} } }, budget, {
          pretty,
        });
        assert.deepEqual(JSON.parse(out.text), out.result);
        assert.equal(out.result.ok, true);
      },
    ),
    { numRuns: 200 },
  );
});

test('cc-g2: truncation never leaves an unpaired surrogate', () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ id: fc.string(), title: fc.fullUnicodeString() }), {
        minLength: 1,
        maxLength: 30,
      }),
      fc.integer({ min: 0, max: 2_000 }),
      (videos, budget) => {
        const { text } = truncateResult({ ok: true, data: { videos, meta: {} } }, budget);
        for (let i = 0; i < text.length; i += 1) {
          const code = text.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            assert.ok(
              next >= 0xdc00 && next <= 0xdfff,
              `high surrogate at ${String(i)} has no low surrogate`,
            );
            i += 1;
          } else {
            assert.ok(
              !(code >= 0xdc00 && code <= 0xdfff),
              `lone low surrogate at ${String(i)}`,
            );
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('cc-g7: ok, error and hints survive every budget', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 800 }), (budget) => {
      const out = truncateResult(
        {
          ok: false,
          data: { videos: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) },
          error: { code: 'rate_limited', message: 'Too many requests.', retryable: true },
          hints: [{ type: 'wait', text: 'Wait and retry.', retry_after_s: 30 }],
        },
        budget,
      );
      assert.equal(out.result.ok, false);
      assert.equal(out.result.error?.code, 'rate_limited');
      assert.ok((out.result.hints ?? []).length > 0);
    }),
    { numRuns: 100 },
  );
});

// ---------------------------------------------------------------------------
// the advertised output schema
// ---------------------------------------------------------------------------

test('the advertised outputSchema accepts only envelope keys and requires ok', () => {
  const schema = RESULT_JSON_SCHEMA as {
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  assert.deepEqual(schema.required, ['ok']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'data',
    'error',
    'hints',
    'journal',
    'ok',
  ]);
});

test('the advertised hint enum matches the six documented hint types', () => {
  const hints = (RESULT_JSON_SCHEMA as { properties: Record<string, unknown> })
    .properties['hints'] as { items: { properties: { type: { enum: string[] } } } };
  assert.deepEqual(hints.items.properties.type.enum, [...HINT_TYPES]);
  assert.equal(HINT_TYPES.length, 6);
});

test('the advertised outputSchema is frozen', () => {
  assert.ok(Object.isFrozen(RESULT_JSON_SCHEMA));
});
