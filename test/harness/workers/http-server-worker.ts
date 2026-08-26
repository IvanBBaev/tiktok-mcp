/**
 * Child process for the CC-G3 stdout-purity test on the http transport: a real
 * MCP server served over a real `StreamableHTTPServerTransport`.
 *
 * The parent spawns this with piped stdio, reads the bound URL off the worker's
 * *stderr* log line, drives a full session against it and then asserts that the
 * child's stdout stayed byte-for-byte empty. In-process the same assertion would
 * be worth much less: `node --test` writes its own reporter frames to stdout, so
 * a patched `process.stdout.write` measures the runner rather than the server.
 *
 * Both a served request and a refused one run through here — the logger is at
 * `debug` and the tool handler logs on every call, so a sink that ever pointed
 * at stdout shows up as output instead of as silence.
 *
 * Settings come from an explicit object rather than `process.env`, except for
 * the bearer, which the parent has to know to be able to authenticate at all.
 * The port is overwritten to 0 afterwards: `TT_PORT` is validated as 1..65535
 * and a test may only take an ephemeral bind.
 */

import { z } from 'zod';

import { systemClock } from '../../../src/core/clock.js';
import { createLogger } from '../../../src/core/log.js';
import { loadSettings, type Settings } from '../../../src/core/settings.js';
import { defineTool, toolInput } from '../../../src/mcp/define.js';
import { startHttpTransport } from '../../../src/mcp/http.js';
import { createServer, type ServerRuntime } from '../../../src/mcp/server.js';

const settings: Settings = {
  ...loadSettings({
    TT_TRANSPORT: 'http',
    TT_HTTP_HOST: '127.0.0.1',
    TT_HTTP_TOKEN: process.env['TIKTOK_MCP_TEST_HTTP_TOKEN'] ?? '',
    TT_LOG_LEVEL: 'debug',
  }),
  port: 0,
};
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

const transport = await startHttpTransport({
  settings,
  log,
  clock: systemClock,
  createHandle: () =>
    createServer({
      name: 'tiktok-mcp-ai',
      version: '0.0.0-test',
      packages: [{ name: 'video', tools: [tool] }],
      runtime,
    }),
});

// The parent waits for exactly this line to learn where to connect; the URL
// never carries the bearer, so stderr stays safe to read in a test log.
log.info('http worker listening', { url: transport.url });

const stop = (): void => {
  void transport.close();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
