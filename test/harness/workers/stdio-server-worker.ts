/**
 * Child process for the CC-G3 stdout-purity test: a real MCP server served over
 * a real `StdioServerTransport`.
 *
 * The parent spawns this with piped stdio, feeds it newline-delimited JSON-RPC
 * frames on stdin and asserts that *every* line it wrote to stdout is one of
 * those frames coming back. Proving that in-process would prove less: the child
 * is the only place where `connectStdio`, the SDK's stdout writer and the
 * logger's stderr sink all share one pair of file descriptors.
 *
 * The tool and the logger here are deliberately noisy — the handler logs at
 * `debug` on every call — so a sink that ever pointed at stdout would show up
 * as a non-frame line rather than as silence.
 *
 * Settings come from an explicit object, never `process.env`: the parent's
 * environment must not be able to change what is measured.
 */

import { z } from 'zod';

import { createLogger } from '../../../src/core/log.js';
import { loadSettings } from '../../../src/core/settings.js';
import { systemClock } from '../../../src/core/clock.js';
import { defineTool, toolInput } from '../../../src/mcp/define.js';
import {
  connectStdio,
  createServer,
  type ServerRuntime,
} from '../../../src/mcp/server.js';

const settings = loadSettings({});
const log = createLogger({ level: 'debug' });

const tool = defineTool({
  name: 'tiktok_list_videos',
  title: 'List videos',
  description: 'List the authenticated creator’s public videos.',
  package: 'video',
  scopes: [],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: toolInput({ max_count: z.number().int().min(1).max(20).optional() }),
  handler: (_args, ctx) => {
    ctx.log.info('handler ran', { note: 'this line belongs on stderr' });
    return Promise.resolve({ ok: true, data: { videos: [] } });
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

log.info('stdio worker starting', { transport: 'stdio' });
await connectStdio(handle);
