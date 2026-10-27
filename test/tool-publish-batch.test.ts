/**
 * `tiktok_publish_batch` (TOOLS.md § 2.11, § 3.15): one preview and one plan
 * over several publishes, each item previewed and applied through its own tool
 * by `ctx.call` — the same `callTool` path an MCP request takes.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApiContext, type ApiContext } from '../src/api/context.js';
import { createLogger } from '../src/core/log.js';
import type { ConsentRequest } from '../src/mcp/consent.js';
import { loadSettings } from '../src/core/settings.js';
import { resetRateBuckets } from '../src/mcp/plan.js';
import { resetPlanStore } from '../src/mcp/plan-store.js';
import type { ToolResult } from '../src/mcp/result.js';
import { callTool, type ServerRuntime } from '../src/mcp/server.js';
import {
  BATCH_MAX_ITEMS,
  publishBatchTool,
  resetBatchPlans,
  type PublishBatchData,
} from '../src/tools/publish-batch.js';
import {
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
const INBOX_INIT_PATH = '/v2/post/publish/inbox/video/init/';
const DRAFT = 'tiktok_upload_video_draft';

type Args = Record<string, unknown>;

interface Harness {
  clock: MockClock;
  runtime: ServerRuntime;
  /** Inbox inits per access token, i.e. per profile. */
  inits: Map<string, number>;
}

async function withHarness<T>(
  env: Record<string, string>,
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  resetPlanStore();
  resetRateBuckets();
  resetBatchPlans();
  const sandbox = await fsSandbox();
  try {
    const envFile = join(sandbox.dir, '.tiktok-mcp.env');
    const lines: string[] = [
      'TT_CLIENT_KEY=test-client-key',
      'TT_CLIENT_SECRET=test-secret',
    ];
    for (const [prefix, name] of [
      ['TT_', 'DEFAULT'],
      ['TT_PROFILE_BRAND_', 'BRAND'],
    ] as const) {
      lines.push(
        `${prefix}ACCESS_TOKEN=test-access-token-${name}`,
        `${prefix}REFRESH_TOKEN=test-refresh-token-${name}`,
        `${prefix}OPEN_ID=test-open-id-${name}`,
        `${prefix}SCOPES=${BASELINE_SCOPES}`,
        `${prefix}TOKEN_EXPIRES_AT=${BASELINE_TOKEN_EXPIRES_AT}`,
        `${prefix}REFRESH_EXPIRES_AT=${BASELINE_REFRESH_EXPIRES_AT}`,
      );
    }
    await writeFile(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
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
        refresh: () => Promise.resolve(`test-access-token-${profile}`),
      });
    const runtime: ServerRuntime = {
      settings,
      log: NOOP_LOGGER,
      profiles: () =>
        Promise.resolve(
          ['DEFAULT', 'BRAND'].map((name) => ({
            name,
            scopes: BASELINE_SCOPES.split(','),
            authorized: true,
          })),
        ),
      createContext: (profile) => Promise.resolve(apiFor(profile)),
    };
    const inits = new Map<string, number>();
    const stub = (input: string | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path === INBOX_INIT_PATH) {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        const token = auth.replace(/^Bearer /, '');
        const n = (inits.get(token) ?? 0) + 1;
        inits.set(token, n);
        return Promise.resolve(
          ttEnvelope({ publish_id: `v_inbox_url~${token}.${String(n)}` }),
        );
      }
      throw new Error(`unexpected request to ${path}`);
    };
    return await withFetch(stub, async () => fn({ clock, runtime, inits }));
  } finally {
    resetPlanStore();
    resetRateBuckets();
    resetBatchPlans();
    await sandbox.cleanup();
  }
}

function draftItem(file: string, account?: string): { tool: string; args: Args } {
  return {
    tool: DRAFT,
    args: {
      source: 'url',
      video_url: `${VERIFIED_PREFIX}${file}`,
      ...(account === undefined ? {} : { account }),
    },
  };
}

async function batch(h: Harness, args: Args): Promise<ToolResult<PublishBatchData>> {
  return (await callTool(
    publishBatchTool,
    args,
    h.runtime,
  )) as ToolResult<PublishBatchData>;
}

function dataOf(result: ToolResult<PublishBatchData>): PublishBatchData {
  assert.ok(result.ok, JSON.stringify(result));
  return result.data as PublishBatchData;
}

function errorCode(result: ToolResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

const TWO_PROFILES = [draftItem('a.mp4'), draftItem('b.mp4', 'brand')];

test('preview then apply: one plan publishes on every profile it names', async () => {
  await withHarness({}, async (h) => {
    const progress: [number, number][] = [];
    const preview = dataOf(
      (await callTool(publishBatchTool, { items: TWO_PROFILES }, h.runtime, {
        progress: (done, total) => progress.push([done, total]),
      })) as ToolResult<PublishBatchData>,
    );
    assert.equal(preview.mode, 'plan');
    if (preview.mode !== 'plan') return;
    assert.match(preview.plan_id, /^plan_[0-9a-f]{32}$/);
    assert.deepEqual(
      preview.items.map((item) => [item.index, item.account, item.ok]),
      [
        [0, 'DEFAULT', true],
        [1, 'BRAND', true],
      ],
    );
    // The item plans stay inside the batch; only its own plan is handed out.
    for (const item of preview.items) {
      assert.equal(item.data?.['plan_id'], undefined);
      assert.equal(item.data?.['expires_at'], undefined);
      assert.equal(item.data?.['mode'], 'plan');
    }
    assert.deepEqual(progress.at(-1), [2, 2]);
    assert.equal(h.inits.size, 0, 'a preview sends nothing');

    const applied = dataOf(
      await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id }),
    );
    assert.equal(applied.mode, 'applied');
    if (applied.mode !== 'applied') return;
    assert.equal(applied.succeeded, 2);
    assert.equal(applied.failed, 0);
    assert.deepEqual(
      applied.items.map((item) => [item.account, item.ok, item.data?.['mode']]),
      [
        ['DEFAULT', true, 'applied'],
        ['BRAND', true, 'applied'],
      ],
    );
    assert.equal(h.inits.get('test-access-token-DEFAULT'), 1);
    assert.equal(h.inits.get('test-access-token-BRAND'), 1);

    // Single use, like every plan.
    const again = await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id });
    assert.equal(errorCode(again), 'plan_not_found');
  });
});

test('the batch account is the default for items that name none', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(
      await batch(h, { items: [draftItem('a.mp4')], account: 'brand' }),
    );
    assert.equal(preview.mode, 'plan');
    assert.equal(preview.items[0]?.account, 'BRAND');
  });
});

test('a changed item list does not apply, and the plan survives for the right one', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(await batch(h, { items: TWO_PROFILES }));
    assert.equal(preview.mode, 'plan');
    if (preview.mode !== 'plan') return;
    const changed = await batch(h, {
      items: [draftItem('a.mp4'), draftItem('OTHER.mp4', 'brand')],
      plan_id: preview.plan_id,
    });
    assert.equal(errorCode(changed), 'plan_mismatch');
    assert.equal(h.inits.size, 0);

    const applied = dataOf(
      await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id }),
    );
    assert.equal(applied.mode, 'applied');
  });
});

test('a plan the batch no longer remembers is plan_not_found', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(await batch(h, { items: TWO_PROFILES }));
    if (preview.mode !== 'plan') return assert.fail('expected a plan');
    resetBatchPlans();
    const applied = await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id });
    assert.equal(errorCode(applied), 'plan_not_found');
  });
});

test('only the newest batches are remembered', async () => {
  await withHarness({ TT_PLAN_MAX_OUTSTANDING: '100' }, async (h) => {
    const first = dataOf(await batch(h, { items: [draftItem('a.mp4')] }));
    if (first.mode !== 'plan') return assert.fail('expected a plan');
    for (let i = 0; i < 64; i += 1) {
      dataOf(await batch(h, { items: [draftItem(`n${String(i)}.mp4`)] }));
    }
    const applied = await batch(h, {
      items: [draftItem('a.mp4')],
      plan_id: first.plan_id,
    });
    assert.equal(errorCode(applied), 'plan_not_found');
  });
});

test('an item that does not preview leaves the batch without a plan', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(
      await batch(h, {
        items: [
          draftItem('a.mp4'),
          {
            tool: DRAFT,
            args: { source: 'url', video_url: 'https://elsewhere.example/x.mp4' },
          },
          draftItem('c.mp4', 'nobody'),
        ],
      }),
    );
    assert.equal(preview.mode, 'plan_incomplete');
    assert.equal('plan_id' in preview, false);
    assert.deepEqual(
      preview.items.map((item) => item.ok),
      [true, false, false],
    );
    assert.ok(preview.items[1]?.error?.code);
    assert.equal(preview.items[2]?.account, undefined);
  });
});

test('control fields belong to the batch call, not to an item', async () => {
  await withHarness({}, async (h) => {
    for (const field of ['plan_id', 'force', 'wait_for_completion', 'run_at']) {
      const item = draftItem('a.mp4');
      item.args[field] = 'x';
      const result = await batch(h, { items: [item] });
      assert.equal(errorCode(result), 'invalid_params', field);
      assert.match(
        result.error?.message ?? '',
        new RegExp(`items\\[0\\]\\.args\\.${field}`),
      );
    }
  });
});

test('input bounds: 1..10 items, a known tool, a well-formed plan_id', async () => {
  await withHarness({}, async (h) => {
    assert.equal(errorCode(await batch(h, { items: [] })), 'invalid_params');
    const many = Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, i) =>
      draftItem(`${String(i)}.mp4`),
    );
    assert.equal(errorCode(await batch(h, { items: many })), 'invalid_params');
    assert.equal(
      errorCode(await batch(h, { items: [{ tool: 'tiktok_get_user', args: {} }] })),
      'invalid_params',
    );
    assert.equal(
      errorCode(await batch(h, { items: TWO_PROFILES, plan_id: 'nope' })),
      'invalid_params',
    );
    assert.equal(
      errorCode(
        await batch(h, { items: TWO_PROFILES, plan_id: `plan_${'0'.repeat(32)}` }),
      ),
      'plan_not_found',
    );
  });
});

test('more items than a profile’s bucket: a note at preview, local_rate_limited at apply', async () => {
  await withHarness({ TT_PUBLISH_RPM: '1' }, async (h) => {
    const items = [draftItem('a.mp4'), draftItem('b.mp4'), draftItem('c.mp4', 'brand')];
    const preview = await batch(h, { items });
    const data = dataOf(preview);
    if (data.mode !== 'plan') return assert.fail('expected a plan');
    const notes = (preview.hints ?? []).filter((hint) => hint.type === 'note');
    assert.equal(notes.length, 1);
    assert.match(
      JSON.stringify(notes[0]),
      /2 items publish on 'DEFAULT', which allows 1 now/,
    );

    const applied = await batch(h, { items, plan_id: data.plan_id });
    const result = dataOf(applied);
    if (result.mode !== 'applied') return assert.fail('expected applied');
    assert.deepEqual(
      result.items.map((item) => [item.account, item.ok, item.error?.code]),
      [
        ['DEFAULT', true, undefined],
        ['DEFAULT', false, 'local_rate_limited'],
        ['BRAND', true, undefined],
      ],
    );
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.match(JSON.stringify(applied.hints), /1 of 3 items failed/);
  });
});

test('run_at on the batch schedules every item instead of sending it', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(await batch(h, { items: TWO_PROFILES }));
    if (preview.mode !== 'plan') return assert.fail('expected a plan');
    const runAt = new Date(h.clock.now() + 3_600_000).toISOString();
    const applied = dataOf(
      await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id, run_at: runAt }),
    );
    if (applied.mode !== 'applied') return assert.fail('expected applied');
    assert.deepEqual(
      applied.items.map((item) => [item.ok, typeof item.data?.['schedule_id']]),
      [
        [true, 'string'],
        [true, 'string'],
      ],
    );
    assert.equal(h.inits.size, 0);
  });
});

test('TT_WRITE_MODE=apply runs the items without a plan', async () => {
  await withHarness({ TT_WRITE_MODE: 'apply' }, async (h) => {
    const applied = dataOf(await batch(h, { items: TWO_PROFILES }));
    assert.equal(applied.mode, 'applied');
    assert.equal(h.inits.size, 2);
  });
});

test('the handler needs ctx.call', async () => {
  await withHarness({}, async (h) => {
    const api = await h.runtime.createContext('DEFAULT');
    await assert.rejects(
      publishBatchTool.handler(publishBatchTool.input.parse({ items: TWO_PROFILES }), {
        api,
        log: NOOP_LOGGER,
      }),
      /needs ToolCtx\.call/,
    );
  });
});

test('§ 2.6.6: one dialog approves the whole batch, and the items do not ask again', async () => {
  // `required` would refuse any item that asked on its own: the items run
  // without a dialog of their own, so they pass only because consent carried.
  await withHarness({ TT_ELICITATION: 'required' }, async (h) => {
    const asked: ConsentRequest[] = [];
    const confirm = (request: ConsentRequest): Promise<'approved'> => {
      asked.push(request);
      return Promise.resolve('approved');
    };
    const preview = dataOf(await batch(h, { items: TWO_PROFILES }));
    assert.equal(preview.mode, 'plan');
    if (preview.mode !== 'plan') return;
    assert.equal(asked.length, 0, 'a preview never asks');

    const applied = dataOf(
      (await callTool(
        publishBatchTool,
        { items: TWO_PROFILES, plan_id: preview.plan_id },
        h.runtime,
        { confirm },
      )) as ToolResult<PublishBatchData>,
    );
    assert.equal(applied.mode, 'applied');
    if (applied.mode !== 'applied') return;
    assert.equal(applied.succeeded, 2);
    assert.equal(asked.length, 1);
    assert.deepEqual(
      asked[0]?.items.map((item) => [item.action, item.account]),
      [
        ['Upload a video to the TikTok inbox as a draft', 'DEFAULT'],
        ['Upload a video to the TikTok inbox as a draft', 'BRAND'],
      ],
    );
  });
});

test('§ 2.6.6: a declined batch sends nothing and its plan is void', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(await batch(h, { items: TWO_PROFILES }));
    assert.equal(preview.mode, 'plan');
    if (preview.mode !== 'plan') return;
    const declined = await callTool(
      publishBatchTool,
      { items: TWO_PROFILES, plan_id: preview.plan_id },
      h.runtime,
      { confirm: () => Promise.resolve('declined') },
    );
    assert.equal(errorCode(declined), 'consent_declined');
    assert.equal(h.inits.size, 0);

    const replay = await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id });
    assert.equal(errorCode(replay), 'plan_not_found');
    assert.equal(h.inits.size, 0);
  });
});

test('§ 2.6.6: the batch dialog names each item by its own tool and caption', async () => {
  await withHarness({}, async (h) => {
    const items = [
      {
        tool: 'tiktok_upload_photos_draft',
        args: {
          photo_urls: [`${VERIFIED_PREFIX}a.jpg`],
          description: 'Only a description',
          account: 'brand',
        },
      },
      draftItem('a.mp4'),
    ];
    const preview = dataOf(await batch(h, { items }));
    assert.equal(preview.mode, 'plan');
    if (preview.mode !== 'plan') return;

    const asked: ConsentRequest[] = [];
    const declined = await callTool(
      publishBatchTool,
      { items, plan_id: preview.plan_id },
      h.runtime,
      {
        confirm: (request) => {
          asked.push(request);
          return Promise.resolve('declined');
        },
      },
    );
    assert.equal(errorCode(declined), 'consent_declined');
    assert.deepEqual(
      asked[0]?.items.map((item) => [item.action, item.account, item.text, item.privacy]),
      [
        [
          'Upload a photo carousel to the TikTok inbox as a draft',
          'BRAND',
          'Only a description',
          undefined,
        ],
        [
          'Upload a video to the TikTok inbox as a draft',
          'DEFAULT',
          undefined,
          undefined,
        ],
      ],
    );
  });
});

test('§ 2.6.6: a dismissed batch dialog sends nothing and keeps the plan appliable', async () => {
  await withHarness({}, async (h) => {
    const preview = dataOf(await batch(h, { items: TWO_PROFILES }));
    assert.equal(preview.mode, 'plan');
    if (preview.mode !== 'plan') return;
    const cancelled = await callTool(
      publishBatchTool,
      { items: TWO_PROFILES, plan_id: preview.plan_id },
      h.runtime,
      { confirm: () => Promise.resolve('cancelled') },
    );
    assert.equal(errorCode(cancelled), 'consent_cancelled');
    assert.equal(h.inits.size, 0);

    const applied = dataOf(
      await batch(h, { items: TWO_PROFILES, plan_id: preview.plan_id }),
    );
    assert.equal(applied.mode, 'applied');
  });
});
