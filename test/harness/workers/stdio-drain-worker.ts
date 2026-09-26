/**
 * Child process for the stdio drain tests: a real MCP server over a real
 * `StdioServerTransport`, whose one tool can start the session's drain from
 * inside a call and reports on stderr when that drain settles.
 *
 * `connectStdio` binds the process's own stdin and stdout, so the drain cannot
 * be driven in-process without handing the test runner's streams to the SDK.
 * The parent feeds JSON-RPC frames, reads the frames back from stdout and the
 * drain's progress from stderr (one JSON log line per event).
 *
 * Once a drain has started, the session refuses every new request, so each
 * scenario runs in a child of its own. `process.argv[2]` picks the start-up:
 * - `idle` drains at once, before anything arrived, and also makes the
 *   transport's write fail for the request id `reject-me` — the refusal of
 *   that request must not surface as an unhandled rejection;
 * - anything else waits for the parent's calls.
 *
 * The tool `tiktok_list_videos` takes `{ label, budget_ms, mode, drain, delay_ms,
 * orphan_error }`:
 * - `drain: 'start'` starts a drain with no abort signal, `'none'` starts none,
 *   and `'signals'` starts two from the same call: one with a signal that is
 *   already aborted (settling as `pre-aborted`), then one with a signal aborted
 *   when stdin ends (as `src/index.ts` does). One call starts both because the
 *   first drain refuses every request that arrives after it;
 * - `mode: 'answer'` waits `delay_ms` (default 100) and answers;
 * - `mode: 'hold'` waits for its own cancellation, so a drain settles either
 *   on a `notifications/cancelled`, on its budget, or on its signal;
 * - `orphan_error: true` writes an error response with no id after starting
 *   the drain — it answers nothing, so it must not settle the drain.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { createLogger } from '../../../src/core/log.js';
import { loadSettings } from '../../../src/core/settings.js';
import { systemClock } from '../../../src/core/clock.js';
import { defineTool, toolInput } from '../../../src/mcp/define.js';
import {
  connectStdio,
  createServer,
  type ServerRuntime,
  type StdioSession,
} from '../../../src/mcp/server.js';

const scenario = process.argv[2] ?? 'calls';
const settings = loadSettings({});
const log = createLogger({ level: 'debug' });
const holder: { session?: StdioSession } = {};
const clientGone = new AbortController();
process.stdin.once('end', () => {
  clientGone.abort();
});

if (scenario === 'idle') {
  // The refusal's write is the only one that can fail here; `trackStdioCalls`
  // binds `send` when it wraps the transport, so the prototype must be
  // patched before `connectStdio`.
  const proto = StdioServerTransport.prototype;
  // Read through the descriptor: the original is re-invoked with the right
  // `this` below, so it must stay unbound.
  const original = Object.getOwnPropertyDescriptor(proto, 'send')?.value as (
    this: StdioServerTransport,
    message: JSONRPCMessage,
  ) => Promise<void>;
  proto.send = function (
    this: StdioServerTransport,
    message: JSONRPCMessage,
  ): Promise<void> {
    if ('id' in message && message.id === 'reject-me') {
      log.info('refusal write failed');
      return Promise.reject(new Error('stdout is gone'));
    }
    return original.call(this, message);
  };
}

function startDrain(label: string, budgetMs: number, drain: DrainMode): void {
  const session = holder.session;
  if (session === undefined) throw new Error('the session is not connected yet');
  if (drain === 'none') return;
  if (drain === 'signals') {
    void session.drain(budgetMs, systemClock, AbortSignal.abort()).then(() => {
      log.info('drain settled: pre-aborted');
    });
    void session.drain(budgetMs, systemClock, clientGone.signal).then(() => {
      log.info(`drain settled: ${label}`);
    });
    return;
  }
  void session.drain(budgetMs, systemClock).then(() => {
    log.info(`drain settled: ${label}`);
  });
}

type DrainMode = 'start' | 'none' | 'signals';

const tool = defineTool({
  name: 'tiktok_list_videos',
  title: 'Hold a call open',
  description: 'Test tool: starts the stdio drain from inside a call.',
  package: 'video',
  scopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: toolInput({
    label: z.string(),
    budget_ms: z.number().int().min(0),
    mode: z.enum(['answer', 'hold']),
    drain: z.enum(['start', 'none', 'signals']).default('start'),
    delay_ms: z.number().int().min(0).default(100),
    orphan_error: z.boolean().default(false),
  }),
  handler: async (args, ctx) => {
    startDrain(args.label, args.budget_ms, args.drain);
    if (args.orphan_error) {
      await holder.session?.transport.send({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
      } as unknown as JSONRPCMessage);
      log.info(`orphan error sent: ${args.label}`);
    }
    if (args.mode === 'answer') {
      await new Promise((resolve) => setTimeout(resolve, args.delay_ms));
      log.info(`handler returning: ${args.label}`);
      return { ok: true, data: { label: args.label } };
    }
    log.info(`hold started: ${args.label}`);
    await new Promise<void>((resolve) => {
      ctx.signal?.addEventListener('abort', () => {
        resolve();
      });
    });
    log.info(`hold aborted: ${args.label}`);
    return { ok: true, data: { label: args.label } };
  },
});

const runtime: ServerRuntime = {
  settings,
  log,
  profiles: () => Promise.resolve([{ name: 'DEFAULT', scopes: [] }]),
  createContext: (profile: string) =>
    Promise.resolve({
      profile,
      settings,
      log,
      clock: systemClock,
      getAccessToken: () => Promise.resolve('unused'),
    }),
};

const handle = createServer({
  name: 'tiktok-mcp-ai',
  version: '0.0.0-test',
  packages: [{ name: 'video', tools: [tool] }],
  runtime,
});

holder.session = await connectStdio(handle);
if (scenario === 'idle') {
  // Nothing is in flight yet: a drain with a budget far beyond the parent's
  // deadline must return at once — and from here on every request is refused.
  await holder.session.drain(600_000, systemClock);
  log.info('idle drain returned');
}
log.info('worker ready');
