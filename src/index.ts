#!/usr/bin/env node
/**
 * tiktok-mcp-ai — process entry point (ARCHITECTURE.md § 2).
 *
 * The only module allowed to read `process.argv`, install signal handlers or
 * set an exit code. Everything below it is a pure function of its arguments:
 * `runCli` *returns* the code it wants, the server is built from an injected
 * runtime, and neither one knows this file exists.
 *
 * Order matters here:
 *
 * 1. **Version guard first.** Node < 22 must print a sentence, not a syntax
 *    error, so nothing from the app graph is imported statically — every import
 *    below is dynamic and happens after the guard has passed. The published
 *    `bin/tiktok-mcp-ai.cjs` launcher performs the same check in CommonJS for
 *    the runtimes that cannot even parse this file.
 * 2. **CLI before server.** `login` and `doctor` are lazily imported by
 *    `cli/index.ts`, so a plain server start never loads the OAuth client, the
 *    HTTP callback listener or the health probes.
 * 3. **stdout belongs to the protocol** (CC-G3). Nothing here writes to stdout;
 *    diagnostics go to stderr through the structured logger, and the env file is
 *    read with `core/config`'s own parser rather than a side-effectful
 *    `dotenv/config` import that could print before transport connect.
 *
 * `process.exitCode` is set instead of calling `process.exit()`: an abrupt exit
 * truncates a piped stdout, and the last thing a CLI run does is print.
 */

const MIN_NODE_MAJOR = 22;

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
}

/** Wire the MCP server onto stdio and keep the process alive until it closes. */
async function startServer(): Promise<void> {
  const config = await import('./core/config.js');
  const { loadSettings } = await import('./core/settings.js');
  const { createLogger } = await import('./core/log.js');
  const { systemClock } = await import('./core/clock.js');
  const { overlayEnvFile, packageVersion } = await import('./cli/index.js');

  const envFilePath = config.resolveEnvFilePath();
  const snapshot = await config.readEnvFile(envFilePath);
  const env = overlayEnvFile(process.env, snapshot);
  const settings = loadSettings(env);
  const log = createLogger({ level: settings.logLevel, clock: systemClock });

  for (const warning of snapshot.warnings) log.warn(warning, { env_file: envFilePath });

  if (settings.transport !== 'stdio') {
    log.error(
      `TT_TRANSPORT=${settings.transport} is not implemented in this build; ` +
        'start the server on stdio instead.',
    );
    process.exitCode = 1;
    return;
  }

  const { createServer, connectStdio } = await import('./mcp/server.js');
  const { PACKAGES } = await import('./tools/index.js');
  const { createApiContext } = await import('./api/context.js');

  const handle = createServer({
    name: 'tiktok-mcp-ai',
    version: await packageVersion(),
    packages: PACKAGES,
    runtime: {
      settings,
      log,
      // Re-read on every listing: a `login` in another terminal changes the
      // answer, and the tool descriptions are rebuilt from it (TOOLS.md § 6.3).
      profiles: async () => {
        const current = await config.readEnvFile(envFilePath);
        const merged = overlayEnvFile(process.env, current);
        return config.listProfiles(current, merged).map((name) => {
          try {
            return {
              name,
              scopes: config.readProfile(name, current, merged).scopes ?? [],
            };
          } catch {
            return { name, scopes: [] };
          }
        });
      },
      // The api layer owns token resolution from here on: `createApiContext`
      // binds the profile onto the logger and routes every bearer through
      // `ensureFreshAccessToken` (ARCHITECTURE § 6).
      createContext: (profile: string) =>
        Promise.resolve(
          createApiContext({ profile, settings, log, clock: systemClock, env }),
        ),
    },
  });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    log.info(`received ${signal}; shutting down`);
    void handle.server.close().catch((err: unknown) => {
      log.warn('the MCP server did not close cleanly', {
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    process.exitCode = 1;
  });
  process.on('uncaughtException', (err: Error) => {
    log.error('uncaught exception', { reason: err.message });
    process.exitCode = 1;
    shutdown('SIGTERM');
  });

  await connectStdio(handle);
  log.info('tiktok-mcp-ai is serving MCP on stdio', {
    profile: settings.activeProfile,
    env_file: envFilePath,
  });
}

async function main(): Promise<void> {
  const { isCliInvocation, runCli } = await import('./cli/index.js');
  const argv = process.argv.slice(2);
  if (isCliInvocation(argv)) {
    process.exitCode = await runCli(argv);
    return;
  }
  await startServer();
}

if (nodeMajor() < MIN_NODE_MAJOR) {
  process.stderr.write(
    `tiktok-mcp-ai requires Node.js ${String(MIN_NODE_MAJOR)} or newer; ` +
      `this is ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else {
  try {
    await main();
  } catch (err) {
    // Startup failures are configuration errors far more often than bugs, so
    // the message is what the operator sees — not a stack trace.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
