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

import type { StdioSession } from './mcp/server.js';

const MIN_NODE_MAJOR = 22;
/** How long a signalled stdio shutdown waits for calls in flight (as HTTP's drain). */
const STDIO_DRAIN_MS = 10_000;

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
}

/**
 * Wire the MCP server onto the configured transport and keep the process alive
 * until it closes — stdio by default, Streamable HTTP under `TT_TRANSPORT=http`
 * (CC-G6). The runtime is built once and handed to both branches as a factory,
 * so the two transports differ only in how a session arrives.
 */
async function startServer(): Promise<void> {
  const config = await import('./core/config.js');
  const { isLoopbackHost, loadSettings } = await import('./core/settings.js');
  const { createLogger } = await import('./core/log.js');
  const { systemClock } = await import('./core/clock.js');
  const { overlayEnvFile, packageVersion } = await import('./cli/index.js');

  const envFilePath = config.resolveEnvFilePath();
  const snapshot = await config.readEnvFile(envFilePath);
  const env = overlayEnvFile(process.env, snapshot);
  const settings = loadSettings(env);
  const log = createLogger({ level: settings.logLevel, clock: systemClock });

  for (const warning of snapshot.warnings) log.warn(warning, { env_file: envFilePath });

  const { createServer, connectStdio } = await import('./mcp/server.js');
  const { PACKAGES } = await import('./tools/index.js');
  const { PROMPTS } = await import('./tools/prompts.js');
  const { RESOURCES } = await import('./tools/resources.js');
  const { createApiContext } = await import('./api/context.js');

  const version = await packageVersion();

  // Re-read on every listing: a `login` in another terminal changes the answer,
  // and the tool descriptions are rebuilt from it (TOOLS.md § 6.3). The
  // credential watch below reads through this same function, so what it
  // compares is byte-for-byte what `tools/list` would have answered.
  const readProfiles = async (): Promise<
    { name: string; scopes: string[]; authorized: boolean }[]
  > => {
    const current = await config.readEnvFile(envFilePath);
    const merged = overlayEnvFile(process.env, current);
    return config.listProfiles(current, merged).map((name) => {
      try {
        const stored = config.readProfile(name, current, merged);
        return {
          name,
          scopes: stored.scopes ?? [],
          authorized:
            stored.accessToken !== undefined || stored.refreshToken !== undefined,
        };
      } catch {
        return { name, scopes: [], authorized: false };
      }
    });
  };

  // What the MCP surface reads: a store that cannot be read is a store with no
  // profiles, so every tool lists as unavailable — the answer the credential
  // watch announces — instead of `tools/list` failing with the file's path.
  // The watch keeps reading through `readProfiles` itself, where the failure
  // is what it logs.
  const listingProfiles = async (): Promise<
    { name: string; scopes: string[]; authorized: boolean }[]
  > => {
    try {
      return await readProfiles();
    } catch {
      return [];
    }
  };

  // One SDK `Server` binds exactly one transport, so the http branch builds one
  // per session (CC-G6) and stdio is the degenerate case with a single one. A
  // credential change has to reach every live session, hence the set.
  const handles = new Set<ReturnType<typeof createServer>>();
  const makeHandle = (): ReturnType<typeof createServer> => {
    const handle = createServer({
      name: 'tiktok-mcp-ai',
      version,
      packages: PACKAGES,
      prompts: PROMPTS,
      resources: RESOURCES,
      runtime: {
        settings,
        log,
        profiles: listingProfiles,
        // The api layer owns token resolution from here on: `createApiContext`
        // binds the profile onto the logger and routes every bearer through
        // `ensureFreshAccessToken` (ARCHITECTURE § 6). It gets the real
        // process env, not `env`: the overlay froze the env file's startup
        // tokens into it, and since the env wins over the file (CC-F2) every
        // re-read under the lock would return them — a refresh token another
        // process already rotated, or one `login --revoke` already cleared.
        createContext: (profile: string) =>
          Promise.resolve(
            createApiContext({
              profile,
              settings,
              log,
              clock: systemClock,
              env: process.env,
            }),
          ),
      },
    });
    handles.add(handle);
    return handle;
  };

  // Assigned by whichever transport wins the branch below; the signal handlers
  // are installed first so a Ctrl-C during a slow bind is still handled.
  let closeTransport: () => Promise<void> = () => Promise.resolve();
  // Stopped before the transport, not after: the watch notifies through the
  // live sessions, and a notification racing a closing transport is the one
  // avoidable "Not connected" in an otherwise clean shutdown.
  let stopWatch: () => Promise<void> = () => Promise.resolve();
  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) return;
    closing = true;
    log.info(`${reason}; shutting down`);
    void stopWatch()
      .then(() => closeTransport())
      .catch((err: unknown) => {
        log.warn('the MCP server did not close cleanly', {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  };
  process.once('SIGINT', () => shutdown('received SIGINT'));
  process.once('SIGTERM', () => shutdown('received SIGTERM'));

  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    process.exitCode = 1;
  });
  process.on('uncaughtException', (err: Error) => {
    log.error('uncaught exception', { reason: err.message });
    process.exitCode = 1;
    shutdown('uncaught exception');
  });

  if (settings.transport === 'http') {
    const { startHttpTransport } = await import('./mcp/http.js');
    const transport = await startHttpTransport({
      settings,
      log,
      clock: systemClock,
      createHandle: () => makeHandle(),
      releaseHandle: (handle) => {
        handles.delete(handle);
      },
    });
    closeTransport = () => transport.close();
    // A signal that landed during the bind already ran `shutdown` against the
    // no-op placeholder; the listener it could not see is closed here instead.
    if (closing) {
      await closeTransport();
      return;
    }
    // On loopback the flag is redundant (nothing needs acknowledging there), and
    // the bind is neither reachable off-box nor exposed to rebinding past the
    // pinned Host check, so neither warning would be true.
    if (settings.httpInsecure && !isLoopbackHost(settings.httpHost)) {
      // `core/settings` already made the operator acknowledge this; the point
      // of repeating it is that the acknowledgement lives in an env file and
      // the person reading the logs may not be the person who wrote it.
      log.warn(
        'TT_HTTP_INSECURE=1: this bind is reachable off-box without TLS in front of it',
        { url: transport.url },
      );
      if (settings.httpAllowedHosts === undefined) {
        // Past loopback the Host/Origin check can only hold Origin to Host, and
        // after DNS rebinding the two agree; the allowlist is what pins them.
        log.warn(
          'TT_HTTP_ALLOWED_HOSTS is unset: past loopback, DNS rebinding is stopped only by the bearer',
          { url: transport.url },
        );
      }
    }
    // The URL never carries the bearer, and `TT_HTTP_TOKEN` is a registered
    // secret — a log line cannot hand out the credential (CC-G6).
    log.info('tiktok-mcp-ai is serving MCP over http', {
      url: transport.url,
      profile: settings.activeProfile,
      env_file: envFilePath,
    });
  } else {
    const handle = makeHandle();
    const stdio: { session?: StdioSession } = {};
    const clientGone = new AbortController();
    // A signal (a host restart) lets calls in flight answer first, as the HTTP
    // transport's drain does: closing aborts every handler, and a publish cut
    // mid-upload is an ambiguous attempt. A closed stdin has nobody to answer,
    // whether it closed before the signal or during the drain.
    closeTransport = async () => {
      await stdio.session?.drain(STDIO_DRAIN_MS, systemClock, clientGone.signal);
      await handle.server.close();
    };
    // Closing stdin is how an MCP client ends a stdio session. The SDK's
    // transport only listens for `data`, and the credential watch below keeps
    // a timer alive, so without this a disconnected server would linger until
    // somebody signalled it.
    process.stdin.once('end', () => {
      clientGone.abort();
      shutdown('stdin closed by the client');
    });
    stdio.session = await connectStdio(handle);
    if (closing) {
      await closeTransport();
      return;
    }
    log.info('tiktok-mcp-ai is serving MCP on stdio', {
      profile: settings.activeProfile,
      env_file: envFilePath,
    });
  }

  // Both branches converge here, transport already serving: anything that has
  // to run for the life of the process — a credential watch, a health probe —
  // starts below and is torn down from `shutdown`.

  // CC-A7. Without this the tool and resource lists are only correct the next
  // time a client asks: a `login` in another terminal grants a scope, and the
  // `[UNAVAILABLE]` markers stay stale until something happens to trigger a
  // `tools/list` or `resources/list`. Starting after connect is part of the
  // contract — `notifyListChanged()` (the SDK's `sendToolListChanged()` and
  // `sendResourceListChanged()` underneath) throws on a server with no
  // transport.
  const { startCredentialWatch } = await import('./mcp/lifecycle.js');
  if (closing) return;
  const watch = startCredentialWatch({
    envFilePath,
    clock: systemClock,
    logger: log,
    profiles: readProfiles,
    onChange: async (change) => {
      log.info(
        'credentials changed; telling clients to re-list the tools and resources',
        {
          env_file: envFilePath,
          added: change.added.length,
          removed: change.removed.length,
          rescoped: change.rescoped.length,
        },
      );
      // A session that has already gone away rejects the notification. That is
      // the session ending, not a failure worth reporting, so it is dropped
      // from the set instead of logged. (Closed http sessions normally leave
      // the set through `releaseHandle`; this catches any that did not.)
      await Promise.all(
        [...handles].map(async (handle) => {
          try {
            await handle.notifyListChanged();
          } catch {
            handles.delete(handle);
          }
        }),
      );
    },
  });
  stopWatch = () => watch.stop();
  // Seeds the baseline now rather than one tick from now: a change that lands
  // between the transport connecting and the first tick would otherwise be
  // read as the starting state and never announced.
  await watch.poll();
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
