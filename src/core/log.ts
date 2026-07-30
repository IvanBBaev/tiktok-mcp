/**
 * Structured logging — JSON lines on **stderr only**.
 *
 * Spec: ARCHITECTURE.md § 10 (redaction & logging), SECURITY.md § Redaction
 * and § Stdout purity, CORNER-CASES.md CC-G3 (stdout carries nothing but MCP
 * JSON-RPC frames) and CC-H2 (persisted/emitted times are ISO-8601 UTC).
 *
 * Invariants this module guarantees:
 *
 * 1. **Nothing is ever written to stdout.** stdout is the stdio JSON-RPC
 *    channel; a single stray byte corrupts the session (CC-G3). The only sink
 *    here is `process.stderr` — `console.log` is additionally banned by lint.
 * 2. **Redaction happens before serialization** (ARCHITECTURE.md § 10): the
 *    message goes through `redactText` (registered secrets scrubbed out of
 *    free text) and the merged fields through `redactValue` (allowlist-based
 *    deep redaction, unknown keys default-deny). `logFields` being an
 *    allowlist is policy; this is the backstop.
 * 3. **Logging never throws and never crashes the process.** An
 *    unserializable field set degrades to a `log_error` marker, and a broken
 *    stderr pipe is swallowed.
 * 4. **Time comes from the injectable `Clock` seam** (CC-H4), so log
 *    timestamps are deterministic under `mockClock` and no test has to sleep.
 *
 * The MCP `logging`-capability mirror to the client lives in the mcp layer;
 * core only owns the stderr sink.
 */

import { systemClock, type Clock } from './clock.js';
import { redactText, redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Envelope keys a caller's fields may never overwrite. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['ts', 'level', 'msg']);

/** Matches the documented `TT_LOG_LEVEL` default (CONFIGURATION.md). */
const DEFAULT_LEVEL: LogLevel = 'info';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A broken stderr pipe (`EPIPE` when the parent closed the handle) must never
 * take the server down: the log line is simply lost.
 */
function writeStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    return;
  }
}

function buildRecord(
  level: LogLevel,
  ts: string,
  msg: string,
  merged: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ts, level, msg: redactText(msg) };
  if (Object.keys(merged).length > 0) {
    const redacted = redactValue(merged);
    if (isRecord(redacted)) {
      for (const [key, value] of Object.entries(redacted)) {
        if (!RESERVED_KEYS.has(key)) record[key] = value;
      }
      /* c8 ignore start */
    } else if (redacted !== undefined) {
      // Unreachable with the current `core/redact`: `merged` is a spread-created
      // plain object, so `redactValue` always walks it with `redactEntries` and
      // always returns a record. Kept as a backstop because the invariant lives
      // in another module and nothing enforces it across the boundary — if
      // `redactValue` ever starts collapsing whole objects, the field set must
      // still reach stderr rather than vanish silently.
      record.fields = redacted;
    }
    /* c8 ignore stop */
  }
  return record;
}

function emit(
  level: LogLevel,
  minLevel: LogLevel,
  clock: Clock,
  bound: Record<string, unknown>,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  let line: string;
  try {
    // CC-H2: emitted times are ISO-8601 UTC, derived from the injected clock.
    const ts = new Date(clock.now()).toISOString();
    try {
      line = JSON.stringify(buildRecord(level, ts, msg, { ...bound, ...fields }));
    } catch {
      // Circular or otherwise unserializable fields: keep the record, drop the
      // fields. A log call is never allowed to fail its caller.
      line = JSON.stringify({
        ts,
        level,
        msg: redactText(msg),
        log_error: 'log_fields_dropped',
      });
    }
  } catch {
    line = JSON.stringify({ level, log_error: 'log_record_dropped' });
  }
  writeStderr(line);
}

function makeLogger(
  minLevel: LogLevel,
  clock: Clock,
  bound: Record<string, unknown>,
): Logger {
  return {
    debug: (msg, fields) => emit('debug', minLevel, clock, bound, msg, fields),
    info: (msg, fields) => emit('info', minLevel, clock, bound, msg, fields),
    warn: (msg, fields) => emit('warn', minLevel, clock, bound, msg, fields),
    error: (msg, fields) => emit('error', minLevel, clock, bound, msg, fields),
    child: (fields) => makeLogger(minLevel, clock, { ...bound, ...fields }),
  };
}

/**
 * JSON lines on stderr ONLY (stdout purity, CC-G3). Every field value passes
 * through `core/redact` before serialization.
 *
 * Record shape: `{"ts","level","msg", …redacted fields}`. Fields bound with
 * `child()` are merged under the per-call fields (the call site wins), and
 * neither may overwrite the three envelope keys.
 *
 * @param opts.level Minimum level to emit; defaults to `"info"` (the
 *   `TT_LOG_LEVEL` default). The composition root passes `settings.logLevel`.
 * @param opts.clock Time source for `ts`; defaults to `systemClock`. Tests
 *   inject `mockClock()` so log output is byte-deterministic (CC-H4).
 */
export function createLogger(opts?: { level?: LogLevel; clock?: Clock }): Logger {
  return makeLogger(opts?.level ?? DEFAULT_LEVEL, opts?.clock ?? systemClock, {});
}
