/**
 * Tests for mcp/completions.ts — the sources behind `completion/complete`
 * (TOOLS.md § 7.3).
 *
 * - `complete` filters by a case-insensitive prefix, keeps the source's own
 *   order, and caps the answer at the protocol's 100 while `total` and
 *   `hasMore` still describe the whole match;
 * - an argument without a source completes to nothing, not to an error;
 * - `profiles` reads the runtime's profile list — or, under `TT_LOCK_PROFILE`,
 *   offers the locked name alone, because that is the only name a call would
 *   accept (§ 2.2);
 * - `publish_ids` folds the real journal in a sandbox: newest first, each id
 *   once, attempts without an id skipped, filtered by the context's `account`
 *   (compared canonically, trimmed and upper-cased) the way
 *   `tiktok_list_publish_journal` filters, a blank account being no
 *   filter, `TT_LOCK_PROFILE` hiding every other profile, and a missing
 *   journal being no ids;
 * - `completionSourceProblem` names an empty or a repeating vocabulary.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { silentLogger } from '../src/core/log.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import {
  COMPLETION_MAX,
  complete,
  completionSourceProblem,
  type CompletionRuntime,
  type CompletionSource,
} from '../src/mcp/completions.js';
import {
  appendIntent,
  appendOutcome,
  type IntentRecord,
  type OutcomeRecord,
} from '../src/mcp/journal.js';
import { baselineEnv, fsSandbox } from './helpers.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Settings from the real loader, so the fixtures cannot drift from the schema. */
function settings(overrides: Record<string, string> = {}): Settings {
  return loadSettings({ ...baselineEnv(), ...overrides });
}

function runtimeOf(
  opts: { settings?: Settings; profiles?: readonly string[] } = {},
): CompletionRuntime {
  const names = opts.profiles ?? ['DEFAULT', 'WORK', 'DEMO'];
  return {
    settings: opts.settings ?? settings(),
    log: silentLogger,
    profiles: () => Promise.resolve(names.map((name) => ({ name }))),
  };
}

const LEVELS: CompletionSource = {
  kind: 'values',
  values: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
};

function intent(over: Partial<IntentRecord> & { attempt_id: string }): IntentRecord {
  return {
    v: 1,
    type: 'intent',
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'tiktok_post_video',
    profile: 'DEFAULT',
    open_id: 'open-1',
    plan_id: 'plan-1',
    payload_digest: 'digest-1',
    title_excerpt: 'A clip',
    source: 'FILE_UPLOAD',
    mode: 'direct',
    ...over,
  };
}

function outcome(over: Partial<OutcomeRecord> & { attempt_id: string }): OutcomeRecord {
  return { v: 1, type: 'outcome', ts: '2026-01-01T00:00:01.000Z', result: 'ok', ...over };
}

/**
 * A journal in a sandbox with four attempts, oldest first: `v_pub_file~1` by
 * DEFAULT, `v_pub_url~2` by WORK, a failed attempt with no id, and
 * `v_pub_file~1` again by DEFAULT — so "newest first, each once" has
 * something to prove.
 */
async function journalSandbox(overrides: Record<string, string> = {}): Promise<{
  settings: Settings;
  cleanup(): Promise<void>;
}> {
  const sandbox = await fsSandbox();
  const envFile = join(sandbox.dir, 'creds.env');
  const opts = { envFile };
  const attempts: readonly [IntentRecord, OutcomeRecord][] = [
    [
      intent({ attempt_id: '01JQ0000000000000000000001' }),
      outcome({ attempt_id: '01JQ0000000000000000000001', publish_id: 'v_pub_file~1' }),
    ],
    [
      intent({ attempt_id: '01JQ0000000000000000000002', profile: 'WORK' }),
      outcome({ attempt_id: '01JQ0000000000000000000002', publish_id: 'v_pub_url~2' }),
    ],
    [
      intent({ attempt_id: '01JQ0000000000000000000003' }),
      outcome({
        attempt_id: '01JQ0000000000000000000003',
        result: 'error',
        error_code: 'network_unsent',
      }),
    ],
    [
      intent({ attempt_id: '01JQ0000000000000000000004' }),
      outcome({ attempt_id: '01JQ0000000000000000000004', publish_id: 'v_pub_file~1' }),
    ],
  ];
  for (const [record, result] of attempts) {
    assert.deepEqual(await appendIntent(record, opts), { ok: true });
    assert.deepEqual(await appendOutcome(result, opts), { ok: true });
  }
  return {
    settings: settings({ TT_ENV_FILE: envFile, ...overrides }),
    cleanup: () => sandbox.cleanup(),
  };
}

// ---------------------------------------------------------------------------
// complete — matching, order, cap
// ---------------------------------------------------------------------------

test('complete offers a values source whole, in its own order, for an empty prefix', async () => {
  assert.deepEqual(await complete(LEVELS, runtimeOf(), { value: '' }), {
    values: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    total: 3,
    hasMore: false,
  });
});

test('complete matches a case-insensitive prefix and nothing else', async () => {
  const runtime = runtimeOf();
  assert.deepEqual((await complete(LEVELS, runtime, { value: 'se' })).values, [
    'SELF_ONLY',
  ]);
  assert.deepEqual((await complete(LEVELS, runtime, { value: 'Mutual_' })).values, [
    'MUTUAL_FOLLOW_FRIENDS',
  ]);
  // A substring is not a prefix.
  assert.deepEqual(await complete(LEVELS, runtime, { value: 'ONLY' }), {
    values: [],
    total: 0,
    hasMore: false,
  });
});

test('complete caps the values at COMPLETION_MAX while total and hasMore describe the rest', async () => {
  const values = Array.from({ length: COMPLETION_MAX + 25 }, (_, i) => `id_${String(i)}`);
  const result = await complete({ kind: 'values', values }, runtimeOf(), {
    value: 'ID_',
  });
  assert.equal(COMPLETION_MAX, 100);
  assert.equal(result.values.length, COMPLETION_MAX);
  assert.deepEqual(result.values.slice(0, 2), ['id_0', 'id_1']);
  assert.equal(result.total, 125);
  assert.equal(result.hasMore, true);
  // Exactly the cap is not "more".
  const exact = await complete(
    { kind: 'values', values: values.slice(0, COMPLETION_MAX) },
    runtimeOf(),
    { value: '' },
  );
  assert.equal(exact.total, COMPLETION_MAX);
  assert.equal(exact.hasMore, false);
});

test('complete answers an argument without a source with nothing, never an error', async () => {
  assert.deepEqual(await complete(undefined, runtimeOf(), { value: 'x' }), {
    values: [],
    total: 0,
    hasMore: false,
  });
});

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

test('profiles offers the configured profile names from the runtime', async () => {
  const runtime = runtimeOf();
  assert.deepEqual(await complete({ kind: 'profiles' }, runtime, { value: '' }), {
    values: ['DEFAULT', 'WORK', 'DEMO'],
    total: 3,
    hasMore: false,
  });
  assert.deepEqual(
    (await complete({ kind: 'profiles' }, runtime, { value: 'de' })).values,
    ['DEFAULT', 'DEMO'],
  );
});

test('profiles offers the locked profile alone under TT_LOCK_PROFILE', async () => {
  const runtime = runtimeOf({ settings: settings({ TT_LOCK_PROFILE: 'work' }) });
  assert.deepEqual(await complete({ kind: 'profiles' }, runtime, { value: '' }), {
    values: ['WORK'],
    total: 1,
    hasMore: false,
  });
  // The other names are unknown to a call, so they are not offered either.
  assert.deepEqual(
    (await complete({ kind: 'profiles' }, runtime, { value: 'd' })).values,
    [],
  );
});

// ---------------------------------------------------------------------------
// publish_ids
// ---------------------------------------------------------------------------

test('publish_ids folds the journal: newest first, each id once, no id skipped', async () => {
  const journal = await journalSandbox();
  try {
    const runtime = runtimeOf({ settings: journal.settings });
    assert.deepEqual(await complete({ kind: 'publish_ids' }, runtime, { value: '' }), {
      values: ['v_pub_file~1', 'v_pub_url~2'],
      total: 2,
      hasMore: false,
    });
    assert.deepEqual(
      (await complete({ kind: 'publish_ids' }, runtime, { value: 'V_PUB_U' })).values,
      ['v_pub_url~2'],
    );
  } finally {
    await journal.cleanup();
  }
});

test('publish_ids keeps one profile when the context names an account; blank is no filter', async () => {
  const journal = await journalSandbox();
  try {
    const runtime = runtimeOf({ settings: journal.settings });
    const source: CompletionSource = { kind: 'publish_ids' };
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: 'WORK' } }))
        .values,
      ['v_pub_url~2'],
    );
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: 'DEFAULT' } }))
        .values,
      ['v_pub_file~1'],
    );
    // The account is compared canonically, like the journal tool's filter and
    // a profile-selecting account (CC-F4): `work` and ` Work ` name WORK.
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: 'work' } }))
        .values,
      ['v_pub_url~2'],
    );
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: ' Work ' } }))
        .values,
      ['v_pub_url~2'],
    );
    // A name nobody used still matches nothing.
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: 'brand' } }))
        .values,
      [],
    );
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: '' } })).values,
      ['v_pub_file~1', 'v_pub_url~2'],
    );
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { title: 'x' } })).values,
      ['v_pub_file~1', 'v_pub_url~2'],
    );
  } finally {
    await journal.cleanup();
  }
});

test('publish_ids under TT_LOCK_PROFILE offers only the locked profile, whatever the context names', async () => {
  const journal = await journalSandbox({ TT_LOCK_PROFILE: 'work' });
  try {
    const runtime = runtimeOf({ settings: journal.settings });
    const source: CompletionSource = { kind: 'publish_ids' };
    // No account: the lock alone filters, as it does in the journal tool.
    assert.deepEqual((await complete(source, runtime, { value: '' })).values, [
      'v_pub_url~2',
    ]);
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: 'Work' } }))
        .values,
      ['v_pub_url~2'],
    );
    // Another profile's ids stay hidden even when the context names it.
    assert.deepEqual(
      (await complete(source, runtime, { value: '', context: { account: 'DEFAULT' } }))
        .values,
      [],
    );
  } finally {
    await journal.cleanup();
  }
});

test('publish_ids is empty when no journal exists yet', async () => {
  const sandbox = await fsSandbox();
  try {
    const runtime = runtimeOf({
      settings: settings({ TT_ENV_FILE: join(sandbox.dir, 'creds.env') }),
    });
    assert.deepEqual(await complete({ kind: 'publish_ids' }, runtime, { value: '' }), {
      values: [],
      total: 0,
      hasMore: false,
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('publish_ids sees a journal change between two completions despite the fold cache', async () => {
  const journal = await journalSandbox();
  try {
    const runtime = runtimeOf({ settings: journal.settings });
    const source: CompletionSource = { kind: 'publish_ids' };
    assert.deepEqual((await complete(source, runtime, { value: '' })).values, [
      'v_pub_file~1',
      'v_pub_url~2',
    ]);
    // Unchanged in between: the cached fold answers identically.
    assert.deepEqual((await complete(source, runtime, { value: '' })).values, [
      'v_pub_file~1',
      'v_pub_url~2',
    ]);

    // Another publish lands, as it would from a tool call in the same process.
    const envFile = journal.settings.envFile;
    assert.ok(envFile !== undefined);
    const opts = { envFile };
    await appendIntent(intent({ attempt_id: '01JQ0000000000000000000005' }), opts);
    await appendOutcome(
      outcome({ attempt_id: '01JQ0000000000000000000005', publish_id: 'v_pub_new~5' }),
      opts,
    );
    assert.deepEqual((await complete(source, runtime, { value: '' })).values, [
      'v_pub_new~5',
      'v_pub_file~1',
      'v_pub_url~2',
    ]);
  } finally {
    await journal.cleanup();
  }
});

// ---------------------------------------------------------------------------
// completionSourceProblem
// ---------------------------------------------------------------------------

test('completionSourceProblem names an empty or a repeating vocabulary, and nothing else', () => {
  assert.equal(
    completionSourceProblem({ kind: 'values', values: [] }),
    'a "values" completion lists no values',
  );
  assert.equal(
    completionSourceProblem({ kind: 'values', values: ['a', 'b', 'a'] }),
    'a "values" completion repeats "a"',
  );
  assert.equal(completionSourceProblem(LEVELS), undefined);
  assert.equal(completionSourceProblem({ kind: 'profiles' }), undefined);
  assert.equal(completionSourceProblem({ kind: 'publish_ids' }), undefined);
});
