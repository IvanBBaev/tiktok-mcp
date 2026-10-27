/**
 * Local scheduled publishing (TOOLS.md § 2.10, § 3.9, § 3.14).
 *
 * Four layers, each against a real sandboxed `schedule.json`:
 *
 * - the store (`mcp/schedule`): `run_at` parsing, the damaged-file refusal, the
 *   locked read-change-write and the retention prune;
 * - the tool side: an apply with `run_at` consumes the plan and queues the
 *   approved arguments instead of dispatching, and the queue/cancel tools;
 * - the runner (`cli/run-queue`): a due entry is re-previewed, checked against
 *   the approval and applied through the ordinary path; a changed request, a
 *   late entry and a non-due entry are each left unpublished;
 * - the command: flags, exit codes and the "nothing due" path.
 *
 * The draft tool with a URL source is the vehicle throughout: it needs no
 * `creator_info` and no file, so the only upstream call is the inbox init.
 */

import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { runCli } from '../src/cli/index.js';
import { runQueue, runRunQueue } from '../src/cli/run-queue.js';
import { isTikTokError } from '../src/core/errors.js';
import { createLogger } from '../src/core/log.js';
import { loadSettings, type Settings } from '../src/core/settings.js';
import type { AnyToolSpec, ToolCtx } from '../src/mcp/define.js';
import { resetRateBuckets } from '../src/mcp/plan.js';
import { mintPlanId, resetPlanStore, storePlan } from '../src/mcp/plan-store.js';
import type { ToolResult } from '../src/mcp/result.js';
import {
  parseRunAt,
  readSchedule,
  SCHEDULE_MAX_PENDING,
  updateSchedule,
  type ScheduledEntry,
  type ScheduleOptions,
} from '../src/mcp/schedule.js';
import { callTool, type ServerRuntime } from '../src/mcp/server.js';
import { uploadVideoDraftTool } from '../src/tools/publish-write.js';
import {
  cancelScheduledTool,
  listScheduledTool,
  type ListScheduledData,
} from '../src/tools/schedule.js';
import {
  BASELINE_NOW_MS,
  BASELINE_REFRESH_EXPIRES_AT,
  BASELINE_SCOPES,
  BASELINE_TOKEN_EXPIRES_AT,
  fsSandbox,
  mockClock,
  ttEnvelope,
  withFetch,
  type MockClock,
} from './helpers.js';

const NOOP_LOGGER = createLogger({ level: 'error' });
const VERIFIED_PREFIX = 'https://cdn.example.com/videos/';
const VIDEO_URL = `${VERIFIED_PREFIX}clip.mp4`;
const INBOX_INIT_PATH = '/v2/post/publish/inbox/video/init/';
const HOUR = 3_600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

interface Harness {
  dir: string;
  clock: MockClock;
  settings: Settings;
  ctx: ToolCtx;
  runtime: ServerRuntime;
  schedule: ScheduleOptions;
  inits: () => number;
}

async function withHarness<T>(
  env: Record<string, string>,
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  resetPlanStore();
  resetRateBuckets();
  const sandbox = await fsSandbox();
  try {
    const envFile = join(sandbox.dir, '.tiktok-mcp.env');
    await writeFile(
      envFile,
      [
        'TT_CLIENT_KEY=test-client-key',
        'TT_CLIENT_SECRET=test-secret',
        'TT_ACCESS_TOKEN=test-access-token-DEFAULT',
        'TT_REFRESH_TOKEN=test-refresh-token-DEFAULT',
        'TT_OPEN_ID=test-open-id-DEFAULT',
        `TT_SCOPES=${BASELINE_SCOPES}`,
        `TT_TOKEN_EXPIRES_AT=${BASELINE_TOKEN_EXPIRES_AT}`,
        `TT_REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const settings = loadSettings({
      TT_ENV_FILE: envFile,
      TT_CLIENT_KEY: 'test-client-key',
      TT_CLIENT_SECRET: 'test-secret',
      TT_VERIFIED_URL_PREFIXES: VERIFIED_PREFIX,
      ...env,
    });
    const clock = mockClock();
    const apiFor = (profile: string): ApiContext =>
      createApiContext({
        profile,
        settings,
        log: NOOP_LOGGER,
        clock,
        refresh: () => Promise.resolve('test-access-token-DEFAULT'),
      });
    const runtime: ServerRuntime = {
      settings,
      log: NOOP_LOGGER,
      profiles: () =>
        Promise.resolve([
          { name: 'DEFAULT', scopes: BASELINE_SCOPES.split(','), authorized: true },
        ]),
      createContext: (profile) => Promise.resolve(apiFor(profile)),
    };
    let inits = 0;
    const stub = (input: string | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === INBOX_INIT_PATH) {
        inits += 1;
        return Promise.resolve(
          ttEnvelope({ publish_id: `v_inbox_url~draft.${String(inits)}` }),
        );
      }
      throw new Error(`unexpected request to ${path}`);
    };
    return await withFetch(stub, async () =>
      fn({
        dir: sandbox.dir,
        clock,
        settings,
        ctx: { api: apiFor('DEFAULT'), log: NOOP_LOGGER },
        runtime,
        schedule: { envFile, logger: NOOP_LOGGER },
        inits: () => inits,
      }),
    );
  } finally {
    resetPlanStore();
    resetRateBuckets();
    await sandbox.cleanup();
  }
}

type Args = Record<string, unknown>;

async function draft(ctx: ToolCtx, args: Args): Promise<ToolResult<unknown>> {
  return await uploadVideoDraftTool.handler(uploadVideoDraftTool.input.parse(args), ctx);
}

async function previewPlanId(ctx: ToolCtx, args: Args = {}): Promise<string> {
  const result = await draft(ctx, { source: 'url', video_url: VIDEO_URL, ...args });
  assert.ok(result.ok, JSON.stringify(result));
  const planId = (result.data as { plan_id?: unknown }).plan_id;
  assert.equal(typeof planId, 'string');
  return planId as string;
}

/** Preview and schedule one draft `inMs` from now; returns its schedule_id. */
async function scheduleDraft(h: Harness, inMs = HOUR): Promise<string> {
  const planId = await previewPlanId(h.ctx);
  const result = await draft(h.ctx, {
    source: 'url',
    video_url: VIDEO_URL,
    plan_id: planId,
    run_at: iso(h.clock.now() + inMs),
  });
  assert.ok(result.ok, JSON.stringify(result));
  return (result.data as { schedule_id: string }).schedule_id;
}

function errorCode(result: ToolResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

test('parseRunAt: needs an explicit zone, the future, and at most 30 days', () => {
  const now = BASELINE_NOW_MS;
  assert.deepEqual(parseRunAt('2026-01-01T01:00:00Z', now), { ok: true, at: now + HOUR });
  assert.deepEqual(parseRunAt('2026-01-01T03:00:00+02:00', now), {
    ok: true,
    at: now + HOUR,
  });
  for (const bad of [
    '2026-01-01T01:00:00',
    '2026-01-01',
    'tomorrow',
    '2026-13-01T00:00:00Z',
  ]) {
    const parsed = parseRunAt(bad, now);
    assert.equal(parsed.ok, false, bad);
  }
  const past = parseRunAt('2025-12-31T23:00:00Z', now);
  assert.ok(!past.ok && past.problem.includes('not in the future'));
  const far = parseRunAt('2026-02-15T00:00:00Z', now);
  assert.ok(!far.ok && far.problem.includes('30 days'));
});

test('store: a missing file is empty; writes are 0600; a damaged file is refused', async () => {
  await withHarness({}, async (h) => {
    assert.deepEqual(await readSchedule(h.schedule), []);
    await updateSchedule(h.clock, () => undefined, h.schedule);
    const path = join(h.dir, 'schedule.json');
    if (process.platform !== 'win32')
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { v: 1, entries: [] });

    await writeFile(path, '{"v":1,"entries":[{"schedule_id":1}]}');
    await assert.rejects(readSchedule(h.schedule), (err: unknown) => {
      assert.ok(isTikTokError(err));
      assert.equal(err.code, 'schedule_unreadable');
      return true;
    });
    await writeFile(path, 'not json');
    await assert.rejects(updateSchedule(h.clock, () => undefined, h.schedule));
    // Refusing to rewrite is the point: the damaged bytes are still there.
    assert.equal(await readFile(path, 'utf8'), 'not json');
  });
});

test('store: finished entries past retention are pruned; pending ones never are', async () => {
  await withHarness({}, async (h) => {
    const old = iso(h.clock.now() - 31 * 24 * HOUR);
    const base: Omit<ScheduledEntry, 'schedule_id' | 'status'> = {
      tool: 'tiktok_upload_video_draft',
      profile: 'DEFAULT',
      open_id: 'x',
      args: {},
      payload_digest: 'd',
      title_excerpt: '',
      run_at: old,
      created_at: old,
      updated_at: old,
    };
    await updateSchedule(
      h.clock,
      (entries) => {
        entries.push({ ...base, schedule_id: 'a', status: 'done' });
        entries.push({ ...base, schedule_id: 'b', status: 'pending' });
      },
      h.schedule,
    );
    const ids = (await readSchedule(h.schedule)).map((e) => e.schedule_id);
    assert.deepEqual(ids, ['b']);
  });
});

// ---------------------------------------------------------------------------
// the tool side
// ---------------------------------------------------------------------------

test('apply with run_at queues the approved request, spends the plan, sends nothing', async () => {
  await withHarness({}, async (h) => {
    const planId = await previewPlanId(h.ctx);
    const runAt = iso(h.clock.now() + HOUR);
    const result = await draft(h.ctx, {
      source: 'url',
      video_url: VIDEO_URL,
      plan_id: planId,
      run_at: runAt,
    });
    assert.ok(result.ok, JSON.stringify(result));
    const data = result.data as { mode: string; schedule_id: string; run_at: string };
    assert.equal(data.mode, 'scheduled');
    assert.match(data.schedule_id, /^sch_[0-9A-Z]{26}$/);
    assert.equal(data.run_at, runAt);
    assert.ok(
      result.hints?.some(
        (hint) => hint.type === 'note' && hint.text.includes('run-queue'),
      ),
    );
    assert.equal(h.inits(), 0);

    const [entry] = await readSchedule(h.schedule);
    assert.ok(entry !== undefined);
    assert.equal(entry.status, 'pending');
    assert.equal(entry.tool, 'tiktok_upload_video_draft');
    assert.equal(entry.profile, 'DEFAULT');
    assert.deepEqual(entry.args, {
      source: 'url',
      video_url: VIDEO_URL,
      account: 'DEFAULT',
    });

    // The plan is spent: it cannot also be applied now.
    const again = await draft(h.ctx, {
      source: 'url',
      video_url: VIDEO_URL,
      plan_id: planId,
    });
    assert.equal(errorCode(again), 'plan_not_found');
  });
});

test('a bad run_at refuses and leaves the plan unspent', async () => {
  await withHarness({}, async (h) => {
    const planId = await previewPlanId(h.ctx);
    const bad = await draft(h.ctx, {
      source: 'url',
      video_url: VIDEO_URL,
      plan_id: planId,
      run_at: iso(h.clock.now() - HOUR),
    });
    assert.equal(errorCode(bad), 'invalid_params');
    const good = await draft(h.ctx, {
      source: 'url',
      video_url: VIDEO_URL,
      plan_id: planId,
      run_at: iso(h.clock.now() + HOUR),
    });
    assert.ok(good.ok, JSON.stringify(good));
    assert.deepEqual(await readSchedule(h.schedule).then((e) => e.length), 1);
  });
});

test('a full queue refuses with schedule_full and leaves the plan unspent', async () => {
  await withHarness({}, async (h) => {
    const stamp = iso(h.clock.now());
    await updateSchedule(
      h.clock,
      (entries) => {
        for (let i = 0; i < SCHEDULE_MAX_PENDING; i += 1) {
          entries.push({
            schedule_id: `sch_${String(i)}`,
            tool: 'tiktok_upload_video_draft',
            profile: 'DEFAULT',
            open_id: 'x',
            args: {},
            payload_digest: 'd',
            title_excerpt: '',
            run_at: iso(h.clock.now() + HOUR),
            created_at: stamp,
            updated_at: stamp,
            status: 'pending',
          });
        }
      },
      h.schedule,
    );
    const planId = await previewPlanId(h.ctx);
    const full = await draft(h.ctx, {
      source: 'url',
      video_url: VIDEO_URL,
      plan_id: planId,
      run_at: iso(h.clock.now() + HOUR),
    });
    assert.equal(errorCode(full), 'schedule_full');
    const now = await draft(h.ctx, {
      source: 'url',
      video_url: VIDEO_URL,
      plan_id: planId,
    });
    assert.ok(now.ok, JSON.stringify(now));
    assert.equal(h.inits(), 1);
  });
});

test('tiktok_list_scheduled lists summaries only, filtered and sorted by run_at', async () => {
  await withHarness({}, async (h) => {
    const later = await scheduleDraft(h, 2 * HOUR);
    const sooner = await scheduleDraft(h, HOUR);
    const result = await listScheduledTool.handler(
      listScheduledTool.input.parse({}),
      h.ctx,
    );
    assert.ok(result.ok);
    const data = result.data as ListScheduledData;
    assert.deepEqual(
      data.entries.map((e) => e.schedule_id),
      [sooner, later],
    );
    assert.equal(data.schedule_path, join(h.dir, 'schedule.json'));
    const wire = JSON.stringify(data);
    assert.ok(!wire.includes('payload_digest') && !wire.includes('open_id'));
    assert.ok(!wire.includes(VIDEO_URL), 'the approved arguments stay in the file');

    const other = await listScheduledTool.handler(
      listScheduledTool.input.parse({ account: 'other' }),
      h.ctx,
    );
    assert.ok(other.ok);
    assert.deepEqual((other.data as ListScheduledData).entries, []);
    const done = await listScheduledTool.handler(
      listScheduledTool.input.parse({ status: 'done' }),
      h.ctx,
    );
    assert.ok(done.ok);
    assert.deepEqual((done.data as ListScheduledData).entries, []);
  });
});

test('tiktok_cancel_scheduled cancels a pending entry, idempotently, and nothing else', async () => {
  await withHarness({}, async (h) => {
    const id = await scheduleDraft(h);
    const cancel = async (scheduleId: string): Promise<ToolResult<unknown>> =>
      await cancelScheduledTool.handler(
        cancelScheduledTool.input.parse({ schedule_id: scheduleId }),
        h.ctx,
      );
    assert.deepEqual((await cancel(id)).ok, true);
    assert.deepEqual((await cancel(id)).ok, true);
    assert.equal((await readSchedule(h.schedule))[0]?.status, 'cancelled');
    assert.equal(errorCode(await cancel('sch_nope')), 'schedule_not_found');
    assert.equal(
      errorCode(await cancel('sch_01ARZ3NDEKTSV4RRFFQ69G5FAV')),
      'schedule_not_found',
    );

    const done = await scheduleDraft(h);
    await updateSchedule(
      h.clock,
      (entries) => {
        const entry = entries.find((e) => e.schedule_id === done);
        if (entry !== undefined) entry.status = 'done';
      },
      h.schedule,
    );
    assert.equal(errorCode(await cancel(done)), 'schedule_not_cancellable');
  });
});

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

test('run-queue applies a due entry through the ordinary path and records publish_id', async () => {
  await withHarness({}, async (h) => {
    const due = await scheduleDraft(h, HOUR);
    const notYet = await scheduleDraft(h, 3 * HOUR);
    await h.clock.advance(HOUR + 1);

    const outcomes = await runQueue({
      runtime: h.runtime,
      clock: h.clock,
      schedule: h.schedule,
    });
    assert.deepEqual(
      outcomes.map((o) => [o.schedule_id, o.status]),
      [[due, 'done']],
    );
    assert.equal(outcomes[0]?.publish_id, 'v_inbox_url~draft.1');
    assert.equal(h.inits(), 1);

    const entries = await readSchedule(h.schedule);
    const byId = new Map(entries.map((e) => [e.schedule_id, e]));
    assert.equal(byId.get(due)?.status, 'done');
    assert.equal(byId.get(due)?.publish_id, 'v_inbox_url~draft.1');
    assert.equal(byId.get(notYet)?.status, 'pending');

    // The journal saw it like any other apply.
    const journal = await readFile(join(h.dir, 'journal.ndjson'), 'utf8');
    assert.ok(journal.includes('v_inbox_url~draft.1'));

    // A second pass has nothing to do.
    assert.deepEqual(
      await runQueue({ runtime: h.runtime, clock: h.clock, schedule: h.schedule }),
      [],
    );
    assert.equal(h.inits(), 1);
  });
});

test('run-queue refuses an entry whose request would now send something else', async () => {
  await withHarness({}, async (h) => {
    const id = await scheduleDraft(h, HOUR);
    await updateSchedule(
      h.clock,
      (entries) => {
        const entry = entries.find((e) => e.schedule_id === id);
        if (entry !== undefined)
          entry.args = { ...entry.args, video_url: `${VERIFIED_PREFIX}other.mp4` };
      },
      h.schedule,
    );
    await h.clock.advance(HOUR + 1);
    const [outcome] = await runQueue({
      runtime: h.runtime,
      clock: h.clock,
      schedule: h.schedule,
    });
    assert.equal(outcome?.status, 'failed');
    assert.equal(outcome?.error?.code, 'payload_changed');
    assert.equal(h.inits(), 0);
  });
});

test('run-queue expires an entry it reaches more than 24 h late, unposted', async () => {
  await withHarness({}, async (h) => {
    const id = await scheduleDraft(h, HOUR);
    await h.clock.advance(26 * HOUR);
    const [outcome] = await runQueue({
      runtime: h.runtime,
      clock: h.clock,
      schedule: h.schedule,
    });
    assert.equal(outcome?.schedule_id, id);
    assert.equal(outcome?.status, 'expired');
    assert.equal(outcome?.error?.code, 'schedule_expired');
    assert.equal(h.inits(), 0);
  });
});

test('run-queue --dry-run reports what is due without claiming it', async () => {
  await withHarness({}, async (h) => {
    const id = await scheduleDraft(h, HOUR);
    await h.clock.advance(HOUR + 1);
    const outcomes = await runQueue({
      runtime: h.runtime,
      clock: h.clock,
      schedule: h.schedule,
      dryRun: true,
    });
    assert.deepEqual(
      outcomes.map((o) => [o.schedule_id, o.status]),
      [[id, 'due']],
    );
    assert.equal((await readSchedule(h.schedule))[0]?.status, 'pending');
    assert.equal(h.inits(), 0);
  });
});

test('run-queue honours TT_LOCK_PROFILE: another profile’s entry is not claimed', async () => {
  await withHarness({ TT_LOCK_PROFILE: 'OTHER' }, async (h) => {
    // Written directly: the locked server could not have queued for DEFAULT.
    const stamp = iso(h.clock.now());
    await updateSchedule(
      h.clock,
      (entries) => {
        entries.push({
          schedule_id: 'sch_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          tool: 'tiktok_upload_video_draft',
          profile: 'DEFAULT',
          open_id: 'x',
          args: { source: 'url', video_url: VIDEO_URL, account: 'DEFAULT' },
          payload_digest: 'd',
          title_excerpt: '',
          run_at: stamp,
          created_at: stamp,
          updated_at: stamp,
          status: 'pending',
        });
      },
      h.schedule,
    );
    await h.clock.advance(1);
    assert.deepEqual(
      await runQueue({ runtime: h.runtime, clock: h.clock, schedule: h.schedule }),
      [],
    );
    assert.equal((await readSchedule(h.schedule))[0]?.status, 'pending');
  });
});

/** Write one due entry straight into the schedule; returns its id. */
async function pushEntry(
  h: Harness,
  overrides: Partial<ScheduledEntry> = {},
): Promise<string> {
  const stamp = iso(h.clock.now());
  const entry: ScheduledEntry = {
    schedule_id: 'sch_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    tool: 'tiktok_upload_video_draft',
    profile: 'DEFAULT',
    open_id: 'test-open-id-DEFAULT',
    args: { source: 'url', video_url: VIDEO_URL, account: 'DEFAULT' },
    payload_digest: 'digest',
    title_excerpt: '',
    run_at: stamp,
    created_at: stamp,
    updated_at: stamp,
    status: 'pending',
    ...overrides,
  };
  await updateSchedule(h.clock, (entries) => void entries.push(entry), h.schedule);
  await h.clock.advance(1);
  return entry.schedule_id;
}

type Scripted = (args: Args) => ToolResult<unknown> | Promise<ToolResult<unknown>>;

/**
 * The draft tool's schema with a scripted handler: a preview call (no
 * plan_id) and an apply call each take the next answer from the script.
 */
function scriptedTool(script: Scripted[]): AnyToolSpec {
  let calls = 0;
  return {
    ...(uploadVideoDraftTool as unknown as AnyToolSpec),
    handler: async (args) => {
      const next = script[calls];
      calls += 1;
      assert.ok(next !== undefined, `unexpected call ${String(calls)}`);
      return await next(args as Args);
    },
  };
}

/** A preview answer whose plan verifies against `pushEntry`'s defaults. */
function planFor(
  h: Harness,
  record: { openId?: string; fileIdentity?: string } = {},
): Scripted {
  return () => {
    const planId = mintPlanId();
    storePlan(planId, {
      digest: 'digest',
      profile: 'DEFAULT',
      openId: record.openId ?? 'test-open-id-DEFAULT',
      tool: 'tiktok_upload_video_draft',
      createdAt: h.clock.now(),
      used: false,
      ...(record.fileIdentity === undefined ? {} : { fileIdentity: record.fileIdentity }),
    });
    return { ok: true, data: { mode: 'plan', plan_id: planId } };
  };
}

const fail =
  (code: string, details?: Record<string, unknown>): Scripted =>
  () => ({
    ok: false,
    error: {
      code,
      kind: 'upstream',
      message: `${code} happened`,
      retryable: false,
      ...(details === undefined ? {} : { details }),
    },
  });

async function runOne(
  h: Harness,
  tools: readonly AnyToolSpec[],
): Promise<{
  status?: string;
  code?: string;
  publishId?: string;
  stored?: ScheduledEntry;
}> {
  const [outcome] = await runQueue({
    runtime: h.runtime,
    clock: h.clock,
    schedule: h.schedule,
    tools,
  });
  const [stored] = await readSchedule(h.schedule);
  return {
    ...(outcome === undefined ? {} : { status: outcome.status }),
    ...(outcome?.error === undefined ? {} : { code: outcome.error.code }),
    ...(outcome?.publish_id === undefined ? {} : { publishId: outcome.publish_id }),
    ...(stored === undefined ? {} : { stored }),
  };
}

test('run-queue fails an entry for a tool this server no longer has', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h, { tool: 'tiktok_gone' });
    const run = await runOne(h, []);
    assert.equal(run.status, 'failed');
    assert.equal(run.code, 'schedule_replay_failed');
    assert.equal(run.stored?.status, 'failed');
  });
});

test('run-queue fails an entry whose preview errors or is not a plan', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const errored = await runOne(h, [scriptedTool([fail('creator_info_failed')])]);
    assert.deepEqual([errored.status, errored.code], ['failed', 'creator_info_failed']);
  });
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const incomplete = await runOne(h, [
      scriptedTool([() => ({ ok: true, data: { mode: 'plan_incomplete' } })]),
    ]);
    assert.deepEqual(
      [incomplete.status, incomplete.code],
      ['failed', 'schedule_replay_failed'],
    );
  });
});

test('run-queue names a changed account or file, and sends nothing', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const run = await runOne(h, [scriptedTool([planFor(h, { openId: 'someone-else' })])]);
    assert.deepEqual([run.status, run.code], ['failed', 'account_changed']);
  });
  await withHarness({}, async (h) => {
    await pushEntry(h, { file_identity: 'a' });
    const run = await runOne(h, [scriptedTool([planFor(h, { fileIdentity: 'b' })])]);
    assert.deepEqual([run.status, run.code], ['failed', 'file_changed']);
  });
});

test('run-queue fails an apply that errors or returns no publish_id', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const run = await runOne(h, [scriptedTool([planFor(h), fail('network_ambiguous')])]);
    assert.deepEqual([run.status, run.code], ['failed', 'network_ambiguous']);
    assert.equal(run.stored?.error?.code, 'network_ambiguous');
  });
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const run = await runOne(h, [
      scriptedTool([planFor(h), () => ({ ok: true, data: { mode: 'applied' } })]),
    ]);
    assert.deepEqual([run.status, run.code], ['failed', 'schedule_replay_failed']);
  });
});

test('run-queue waits out a short local rate limit, then publishes afresh', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const started = h.clock.now();
    let settled = false;
    const pending = runOne(h, [
      scriptedTool([
        planFor(h),
        fail('local_rate_limited', { retry_after_s: 7 }),
        planFor(h),
        () => ({ ok: true, data: { mode: 'applied', publish_id: 'v_pub~1' } }),
      ]),
    ]).finally(() => {
      settled = true;
    });
    while (!settled) await h.clock.advance(h.clock.pending() > 0 ? 1000 : 0);
    const run = await pending;
    assert.deepEqual([run.status, run.publishId], ['done', 'v_pub~1']);
    assert.ok(h.clock.now() - started >= 7000);
    assert.equal(run.stored?.error, undefined);
  });
});

test('run-queue puts an entry back when the rate limit outlasts this run', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const run = await runOne(h, [
      scriptedTool([planFor(h), fail('local_rate_limited', { retry_after_s: 3600 })]),
    ]);
    assert.deepEqual([run.status, run.code], ['pending', 'local_rate_limited']);
    assert.equal(run.stored?.status, 'pending');
    assert.equal(run.stored?.error?.code, 'local_rate_limited');
  });
});

test('run-queue settles nothing for an entry removed while it ran', async () => {
  await withHarness({}, async (h) => {
    await pushEntry(h);
    const run = await runOne(h, [
      scriptedTool([
        async () => {
          await updateSchedule(h.clock, (entries) => void entries.splice(0), h.schedule);
          return await fail('creator_info_failed')({});
        },
      ]),
    ]);
    assert.equal(run.status, 'failed');
    assert.equal(run.stored, undefined);
  });
});

// ---------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------

function capture(): {
  out: string[];
  err: string[];
  deps: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
  };
}

test('run-queue command: --help, a bad flag, and an empty schedule', async () => {
  const help = capture();
  assert.equal(await runCli(['run-queue', '--help'], help.deps), 0);
  assert.ok(help.out.join('').includes('run-queue [--dry-run]'));

  const bad = capture();
  assert.equal(await runRunQueue({ argv: ['--now'], ...bad.deps }), 2);
  assert.ok(bad.err.join('').includes('--now'));

  await withHarness({}, async (h) => {
    const io = capture();
    const env = {
      TT_ENV_FILE: join(h.dir, '.tiktok-mcp.env'),
      TT_CLIENT_KEY: 'test-client-key',
      TT_CLIENT_SECRET: 'test-secret',
    };
    const code = await runRunQueue({ argv: [], env, clock: h.clock, ...io.deps });
    assert.equal(code, 0, io.err.join(''));
    assert.equal(io.out.join(''), 'Nothing was due.\n');

    const denied = capture();
    assert.equal(
      await runRunQueue({
        argv: [],
        env: { ...env, TT_WRITE_MODE: 'deny' },
        clock: h.clock,
        ...denied.deps,
      }),
      1,
    );
    assert.ok(denied.err.join('').includes('Publishing is disabled'));
  });
});

test('run-queue command: publishes, reports each entry, and exits 1 on a failure', async () => {
  await withHarness({}, async (h) => {
    const env = {
      TT_ENV_FILE: join(h.dir, '.tiktok-mcp.env'),
      TT_CLIENT_KEY: 'test-client-key',
      TT_CLIENT_SECRET: 'test-secret',
      TT_VERIFIED_URL_PREFIXES: VERIFIED_PREFIX,
    };
    const due = await scheduleDraft(h, HOUR);
    await h.clock.advance(HOUR + 1);

    const dry = capture();
    assert.equal(
      await runRunQueue({ argv: ['--dry-run'], env, clock: h.clock, ...dry.deps }),
      0,
      dry.err.join(''),
    );
    assert.ok(
      dry.out.join('').includes(`${due}  tiktok_upload_video_draft  @DEFAULT  due`),
    );

    const run = capture();
    assert.equal(
      await runRunQueue({
        argv: [],
        env,
        clock: h.clock,
        logger: NOOP_LOGGER,
        ...run.deps,
      }),
      0,
      run.out.join('') + run.err.join(''),
    );
    assert.ok(run.out.join('').includes('done  publish_id=v_inbox_url~draft.1'));

    await pushEntry(h, {
      schedule_id: 'sch_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      tool: 'tiktok_gone',
    });
    const failed = capture();
    assert.equal(
      await runRunQueue({
        argv: [],
        env,
        clock: h.clock,
        logger: NOOP_LOGGER,
        ...failed.deps,
      }),
      1,
    );
    assert.ok(failed.out.join('').includes('failed  schedule_replay_failed: '));

    await writeFile(join(h.dir, 'schedule.json'), '{ not json', { mode: 0o600 });
    const broken = capture();
    assert.equal(
      await runRunQueue({
        argv: [],
        env,
        clock: h.clock,
        logger: NOOP_LOGGER,
        ...broken.deps,
      }),
      1,
    );
    assert.ok(broken.err.join('').startsWith('run-queue: '));
  });
});

test('callTool path: run_at is a control field and stays out of the digest', async () => {
  await withHarness({}, async (h) => {
    const preview = await callTool(
      uploadVideoDraftTool,
      { source: 'url', video_url: VIDEO_URL, run_at: iso(h.clock.now() + HOUR) },
      h.runtime,
    );
    // A preview ignores run_at, so the same plan schedules or applies.
    assert.ok(preview.ok);
    assert.equal((preview.data as { mode: string }).mode, 'plan');
  });
});
