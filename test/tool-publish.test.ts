/**
 * `tiktok_list_publish_journal` (TOOLS.md § 3.7).
 *
 * The only closed-world tool in the server: no fetch stub appears anywhere in
 * this file, because a network call here would itself be the bug. What is worth
 * testing is the presentation contract, which exists to stop one specific
 * failure — a model reading "no entry" or "failed" and confidently re-posting
 * something that already went out:
 *
 * - `send_ambiguous` is presented as `unknown`, never as its own outcome.
 * - Every `unknown` in the answer comes with the verify-before-retry hint.
 * - `limit` cuts whole *attempts*, never an intent away from its outcome.
 * - "nothing has ever been published" and "the journal is damaged" are
 *   different answers, and both are stated out loud.
 *
 * The journal lives beside the credential file, so an `fsSandbox()` with a real
 * env file is all the isolation this needs.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings } from '../src/core/settings.js';
import type { ToolCtx } from '../src/mcp/define.js';
import {
  appendIntent,
  appendOutcome,
  type IntentRecord,
  type OutcomeRecord,
} from '../src/mcp/journal.js';
import type { ToolResult } from '../src/mcp/result.js';
import { listPublishJournalTool, type ListJournalData } from '../src/tools/publish.js';
import { BASELINE_SCOPES, fsSandbox, mockClock } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = createLogger({ level: 'error' });

function toolCtx(envFilePath: string): ToolCtx {
  const api: ApiContext = createApiContext({
    profile: 'DEFAULT',
    settings: loadSettings({ TT_ENV_FILE: envFilePath }),
    log: NOOP_LOGGER,
    clock: mockClock(),
    refresh: () => Promise.resolve('test-access-token-DEFAULT'),
  });
  return { api, log: NOOP_LOGGER };
}

interface Journalled {
  attemptId: string;
  ts: string;
  profile?: string;
  tool?: string;
  title?: string;
  outcome?: OutcomeRecord['result'];
  publishId?: string;
  errorCode?: string;
}

function intentOf(entry: Journalled): IntentRecord {
  return {
    v: 1,
    type: 'intent',
    attempt_id: entry.attemptId,
    ts: entry.ts,
    tool: entry.tool ?? 'tiktok_post_video',
    profile: entry.profile ?? 'DEFAULT',
    open_id: 'test-open-id-DEFAULT',
    plan_id: `plan-${entry.attemptId}`,
    payload_digest: `digest-${entry.attemptId}`,
    title_excerpt: entry.title ?? 'A clip',
    source: 'FILE_UPLOAD',
    mode: 'direct',
  };
}

/**
 * Runs `fn` against a sandbox holding a credential file and a journal built
 * from `entries` — appended through the real writer, so these tests exercise
 * the same file format the publish path produces.
 */
async function withJournal<T>(
  entries: readonly Journalled[],
  fn: (ctx: ToolCtx, dir: string) => Promise<T>,
): Promise<T> {
  const sandbox = await fsSandbox();
  try {
    const envFile = join(sandbox.dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-secret',
        'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
        'TT_OPEN_ID=test-open-id-DEFAULT',
        `TT_SCOPES=${BASELINE_SCOPES}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const path = join(sandbox.dir, 'journal.ndjson');
    for (const entry of entries) {
      await appendIntent(intentOf(entry), { path });
      if (entry.outcome === undefined) continue;
      const outcome: OutcomeRecord = {
        v: 1,
        type: 'outcome',
        attempt_id: entry.attemptId,
        ts: entry.ts,
        result: entry.outcome,
      };
      if (entry.publishId !== undefined) outcome.publish_id = entry.publishId;
      if (entry.errorCode !== undefined) outcome.error_code = entry.errorCode;
      await appendOutcome(outcome, { path });
    }

    return await fn(toolCtx(envFile), sandbox.dir);
  } finally {
    await sandbox.cleanup();
  }
}

function dataOf(result: ToolResult<ListJournalData>): ListJournalData {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data;
}

function hintTexts(result: ToolResult<ListJournalData>): string[] {
  return (result.hints ?? []).map((hint) => hint.text);
}

const AT = (minute: number): string =>
  new Date(Date.UTC(2026, 0, 1, 12, minute, 0)).toISOString();

// ---------------------------------------------------------------------------
// the shape of an entry
// ---------------------------------------------------------------------------

test('an entry carries the audit vocabulary, and nothing that is not in it', async () => {
  const result = await withJournal(
    [
      {
        attemptId: 'A1',
        ts: AT(0),
        title: 'My first clip',
        outcome: 'ok',
        publishId: 'pub-1',
      },
    ],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );

  assert.deepEqual(dataOf(result).entries, [
    {
      ts: AT(0),
      account: 'DEFAULT',
      tool: 'tiktok_post_video',
      title_excerpt: 'My first clip',
      publish_id: 'pub-1',
      outcome: 'ok',
    },
  ]);
  // A clean, fully-resolved read asks the caller for nothing (§ 5.2 rule 1).
  assert.equal(result.hints, undefined);
});

test('an error entry carries its code and no publish_id', async () => {
  const result = await withJournal(
    [{ attemptId: 'A1', ts: AT(0), outcome: 'error', errorCode: 'rate_limited' }],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );

  const [entry] = dataOf(result).entries;
  assert.equal(entry?.outcome, 'error');
  assert.equal(entry?.error_code, 'rate_limited');
  assert.equal(entry?.publish_id, undefined);
});

test('the journal path is reported, so a human can go and read the file', async () => {
  const result = await withJournal([], async (ctx, dir) => {
    const answer = await listPublishJournalTool.handler({}, ctx);
    assert.equal(dataOf(answer).meta.journal_path, join(dir, 'journal.ndjson'));
    return answer;
  });
  assert.equal(dataOf(result).entries.length, 0);
});

// ---------------------------------------------------------------------------
// outcome presentation
// ---------------------------------------------------------------------------

test('send_ambiguous is presented as unknown — the advice is identical', async () => {
  const result = await withJournal(
    [{ attemptId: 'A1', ts: AT(0), outcome: 'send_ambiguous' }],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );

  assert.equal(dataOf(result).entries[0]?.outcome, 'unknown');
  assert.ok(!JSON.stringify(dataOf(result)).includes('send_ambiguous'));
});

test('an intent with no outcome reads as unknown (CC-E10)', async () => {
  const result = await withJournal([{ attemptId: 'A1', ts: AT(0) }], async (ctx) =>
    listPublishJournalTool.handler({}, ctx),
  );
  assert.equal(dataOf(result).entries[0]?.outcome, 'unknown');
});

test('every unknown comes with the verify-before-retry hint', async () => {
  const result = await withJournal(
    [
      { attemptId: 'A1', ts: AT(0) },
      { attemptId: 'A2', ts: AT(1), outcome: 'send_ambiguous' },
      { attemptId: 'A3', ts: AT(2), outcome: 'ok', publishId: 'pub-3' },
    ],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );

  const [hint] = hintTexts(result);
  assert.ok(hint !== undefined);
  assert.match(hint, /^2 of these attempts have outcome "unknown"/u);
  assert.match(hint, /tiktok_get_publish_status/u);
  assert.ok(
    hint.length <= 300,
    `hint is ${String(hint.length)} chars (§ 5.2 caps at 300)`,
  );
});

test('upload_failed keeps its own name — nothing reached TikTok to verify', async () => {
  const result = await withJournal(
    [{ attemptId: 'A1', ts: AT(0), outcome: 'upload_failed' }],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );
  assert.equal(dataOf(result).entries[0]?.outcome, 'upload_failed');
  assert.equal(result.hints, undefined);
});

// ---------------------------------------------------------------------------
// ordering, limit and filters
// ---------------------------------------------------------------------------

test('entries come back newest first', async () => {
  const result = await withJournal(
    [
      { attemptId: 'OLD', ts: AT(0), outcome: 'ok' },
      { attemptId: 'MID', ts: AT(1), outcome: 'ok' },
      { attemptId: 'NEW', ts: AT(2), outcome: 'ok' },
    ],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );

  assert.deepEqual(
    dataOf(result).entries.map((entry) => entry.ts),
    [AT(2), AT(1), AT(0)],
  );
});

test('limit cuts whole attempts and total_matching still reports the truth', async () => {
  const result = await withJournal(
    [
      { attemptId: 'A1', ts: AT(0), outcome: 'ok' },
      { attemptId: 'A2', ts: AT(1), outcome: 'ok' },
      { attemptId: 'A3', ts: AT(2), outcome: 'ok' },
    ],
    async (ctx) => listPublishJournalTool.handler({ limit: 2 }, ctx),
  );

  const data = dataOf(result);
  assert.equal(data.entries.length, 2);
  assert.equal(data.meta.total_matching, 3);
  // Both records of the newest attempt survived the cut: a limit that split an
  // intent from its outcome would turn a finished post into a false "unknown".
  assert.equal(data.entries[0]?.outcome, 'ok');
});

test('the default limit is 20, not the whole file', async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    attemptId: `A${String(i)}`,
    ts: AT(i),
    outcome: 'ok' as const,
  }));
  const result = await withJournal(entries, async (ctx) =>
    listPublishJournalTool.handler({}, ctx),
  );

  const data = dataOf(result);
  assert.equal(data.entries.length, 20);
  assert.equal(data.meta.total_matching, 25);
  assert.equal(data.entries[0]?.ts, AT(24));
});

test('account is a filter here, not a profile selection (§ 2.2 exception)', async () => {
  const result = await withJournal(
    [
      { attemptId: 'A1', ts: AT(0), profile: 'DEFAULT', outcome: 'ok' },
      { attemptId: 'A2', ts: AT(1), profile: 'BRAND', outcome: 'ok' },
    ],
    async (ctx) => listPublishJournalTool.handler({ account: 'BRAND' }, ctx),
  );

  const data = dataOf(result);
  assert.equal(data.meta.total_matching, 1);
  assert.deepEqual(
    data.entries.map((entry) => entry.account),
    ['BRAND'],
  );
});

test('omitting account lists every profile — an audit read defaults to everything', async () => {
  const result = await withJournal(
    [
      { attemptId: 'A1', ts: AT(0), profile: 'DEFAULT', outcome: 'ok' },
      { attemptId: 'A2', ts: AT(1), profile: 'BRAND', outcome: 'ok' },
    ],
    async (ctx) => listPublishJournalTool.handler({}, ctx),
  );
  assert.equal(dataOf(result).meta.total_matching, 2);
});

test('since is inclusive of its own instant', async () => {
  const result = await withJournal(
    [
      { attemptId: 'A1', ts: AT(0), outcome: 'ok' },
      { attemptId: 'A2', ts: AT(5), outcome: 'ok' },
      { attemptId: 'A3', ts: AT(10), outcome: 'ok' },
    ],
    async (ctx) => listPublishJournalTool.handler({ since: AT(5) }, ctx),
  );

  assert.deepEqual(
    dataOf(result).entries.map((entry) => entry.ts),
    [AT(10), AT(5)],
  );
});

test('an unparsable since is an argument error, not an empty answer', async () => {
  const result = await withJournal(
    [{ attemptId: 'A1', ts: AT(0), outcome: 'ok' }],
    async (ctx) => listPublishJournalTool.handler({ since: 'last tuesday' }, ctx),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'invalid_params');
  assert.match(String(result.error?.message), /ISO-8601/u);
  // No silent zero-result answer: a model would read that as "never published".
  assert.equal(result.data, undefined);
});

// ---------------------------------------------------------------------------
// the two ways of having nothing to show
// ---------------------------------------------------------------------------

test('a machine that never published says so, instead of returning a bare empty list', async () => {
  const result = await withJournal([], async (ctx) =>
    listPublishJournalTool.handler({}, ctx),
  );

  assert.deepEqual(dataOf(result).entries, []);
  const [hint] = hintTexts(result);
  assert.ok(hint !== undefined);
  assert.match(hint, /No publish journal exists on this machine yet/u);
  assert.ok(hint.length <= 300);
});

test('an existing journal with no matches does not claim nothing was ever published', async () => {
  const result = await withJournal(
    [{ attemptId: 'A1', ts: AT(0), profile: 'DEFAULT', outcome: 'ok' }],
    async (ctx) => listPublishJournalTool.handler({ account: 'BRAND' }, ctx),
  );

  assert.deepEqual(dataOf(result).entries, []);
  assert.equal(result.hints, undefined);
});

test('skipped lines are counted and explained, not silently swallowed', async () => {
  const result = await withJournal(
    [{ attemptId: 'A1', ts: AT(0), outcome: 'ok' }],
    async (ctx, dir) => {
      // A torn last write — exactly what a crash mid-append leaves behind.
      await writeFile(join(dir, 'journal.ndjson'), '{"v":1,"type":"outc', { flag: 'a' });
      return listPublishJournalTool.handler({}, ctx);
    },
  );

  const data = dataOf(result);
  assert.equal(data.meta.skipped_lines, 1);
  assert.equal(data.entries.length, 1);
  const hint = hintTexts(result).find((text) => text.includes('unreadable and skipped'));
  assert.ok(hint !== undefined);
  assert.match(hint, /truncated last write/u);
  assert.ok(hint.length <= 300);
});

// ---------------------------------------------------------------------------
// the tool's own declaration
// ---------------------------------------------------------------------------

test('the tool needs no scopes and touches no external system', () => {
  assert.deepEqual([...listPublishJournalTool.scopes], []);
  assert.equal(listPublishJournalTool.package, 'publish');
  assert.deepEqual(listPublishJournalTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('the description tells the model to check here before retrying', () => {
  assert.match(listPublishJournalTool.description, /Check this first before re-trying/u);
  assert.match(listPublishJournalTool.description, /the post MAY exist/u);
});
