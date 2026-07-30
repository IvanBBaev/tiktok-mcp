/**
 * Generic child runner for the multi-process harness (TESTING.md § Multi-process
 * env-lock harness).
 *
 * `runContendingChildren` forks *this* module, never the worker directly, so
 * every worker gets the same barrier protocol for free:
 *
 * 1. import the worker module named by `TIKTOK_MCP_TEST_CHILD_MODULE`;
 * 2. send `ready` and block until the parent answers `go`;
 * 3. run the worker's default export;
 * 4. send `done` with its return value, or with the error message.
 *
 * The barrier is what makes the race real. Without it the first child forked has
 * a head start measured in tens of milliseconds — long enough to finish the
 * whole refresh before the second child has finished loading Node, so "exactly
 * one refresh happened" would pass while proving nothing. Releasing all children
 * from a single `go` puts them inside the contended window together.
 *
 * A worker is an ESM module whose default export is
 * `(ctx: ChildContext) => unknown | Promise<unknown>`. Whatever it returns is
 * structured-cloned back to the parent, so keep it to JSON.
 *
 * This file is a script, not a test: it must never match the `*.test.js` glob.
 */

/** What the runner hands the worker's default export. */
export interface ChildContext {
  /** 0-based index of this child within the fleet. */
  readonly index: number;
  /** The `args` value `runContendingChildren` was given, structured-cloned. */
  readonly args: unknown;
}

type Worker = (ctx: ChildContext) => unknown;

function fail(message: string): never {
  process.stderr.write(`lock-child: ${message}\n`);
  process.exit(90);
}

/** `process.send` is only present when the process was forked with an IPC channel. */
function requireSend(): NonNullable<typeof process.send> {
  const channel = process.send?.bind(process);
  if (channel === undefined) fail('was not forked with an IPC channel');
  return channel;
}
const send = requireSend();

const modulePath = process.env['TIKTOK_MCP_TEST_CHILD_MODULE'];
if (modulePath === undefined || modulePath === '') {
  fail('TIKTOK_MCP_TEST_CHILD_MODULE is not set');
}

const index = Number(process.env['TIKTOK_MCP_TEST_CHILD_INDEX'] ?? '0');
const rawArgs = process.env['TIKTOK_MCP_TEST_CHILD_ARGS'];

/**
 * Send a message and wait until it is actually on the wire.
 *
 * `process.send` queues; `process.disconnect()` tears the channel down. Doing
 * both in the same tick can drop the `done` message, and the parent would then
 * see a child that exited 0 without reporting — an intermittent failure that
 * looks like a bug in the code under test.
 */
function report(message: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    send(message, undefined, undefined, (err) => {
      if (err === null) resolve();
      else reject(err);
    });
  });
}

/** Wait for the parent's `go`, or die if the parent vanishes first. */
function waitForGo(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'go') {
          process.off('message', onMessage);
          process.off('disconnect', onDisconnect);
          resolve();
        }
      }
    };
    function onDisconnect(): void {
      process.off('message', onMessage);
      reject(new Error('the parent disconnected before releasing the barrier'));
    }
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

// Top-level await: this module is only ever run as an ESM entry point.
const imported = (await import(modulePath)) as { default?: unknown };
const worker = imported.default;
if (typeof worker !== 'function') {
  fail(`${modulePath} has no default-exported function`);
}

await report({ type: 'ready' });
await waitForGo();

try {
  const payload = await (worker as Worker)({
    index,
    args: rawArgs === undefined ? undefined : JSON.parse(rawArgs),
  });
  await report({ type: 'done', ok: true, payload });
} catch (err) {
  await report({
    type: 'done',
    ok: false,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
}

// The IPC channel keeps the event loop alive; drop it so the child exits 0 on
// its own instead of being killed by the parent's cleanup.
process.disconnect();
