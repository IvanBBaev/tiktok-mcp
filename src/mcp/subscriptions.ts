/**
 * Resource subscriptions — the state behind `resources/subscribe`,
 * `resources/unsubscribe` and `notifications/resources/updated` (TOOLS.md
 * § 7.4).
 *
 * One hub per MCP session: a subscription is a promise to *that* client, and
 * the http transport builds one `Server` per session, so the hub lives next to
 * it and dies with it. Two sources tell a subscriber its resource moved:
 *
 * - **Pushed.** The composition root forwards a webhook event (a
 *   `post.publish.*` for the publish_id a URI names) through
 *   {@link SubscriptionHub.notify}. Instant, but only when TikTok can reach
 *   the server.
 * - **Polled.** A spec that declares a `watch` is re-read every
 *   {@link DEFAULT_SUBSCRIPTION_POLL_MS} while subscribed, and an envelope that
 *   differs from the last one — ignoring the spec's volatile fields, such as
 *   `checked_at` — notifies. Polling stops for a URI once its `watch` says the
 *   answer is settled (a terminal publish status) or a read fails in a way no
 *   retry changes, so a finished publish costs nothing more. A spec without a
 *   `watch` is never polled: re-reading `tiktok://videos/recent` on a timer
 *   would spend the user's rate limit on a guess.
 *
 * The first read of a URI is a silent baseline, taken at subscribe time, so a
 * change that lands between the subscribe and the first tick is still seen.
 * A pushed notification drops the baseline: the next poll re-seeds it instead
 * of announcing the same change a second time.
 *
 * **Degrade, never throw** — the `mcp/lifecycle` rule. A failed read or a
 * rejected notification is logged; nothing here rejects into the event loop,
 * and the client can always read the URI itself.
 *
 * Framework-free: reading and sending are injected, so the hub is testable
 * without a server and `mcp/server` stays the only SDK-facing module.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import type { Clock } from '../core/clock.js';
import { canonicalJson } from '../core/json.js';
import { silentLogger, type Logger } from '../core/log.js';
import type { ParsedResourceUri, ResourceMatch } from './resources.js';
import type { ToolResult } from './result.js';

/**
 * Poll period for a watched subscription. TikTok allows 30 status requests a
 * minute per user; one read per subscribed attempt every 15 s leaves room for
 * the tool's own polling next to a handful of subscriptions.
 */
export const DEFAULT_SUBSCRIPTION_POLL_MS = 15_000;

export interface SubscriptionHubOptions {
  /** Read one subscribed resource — `callTool` with the URI's arguments. */
  read: (match: ResourceMatch, parsed: ParsedResourceUri) => Promise<ToolResult<unknown>>;
  /** Send `notifications/resources/updated` for the URI as subscribed. */
  send: (uri: string) => Promise<void>;
  /** The polling clock. Without one nothing is polled; pushes still work. */
  clock?: Clock;
  /** Poll period in ms. Default {@link DEFAULT_SUBSCRIPTION_POLL_MS}. */
  intervalMs?: number;
  logger?: Logger;
}

export interface SubscriptionHub {
  /** Subscribe to `uri` (as the client wrote it). Re-subscribing is a no-op. */
  subscribe(uri: string, match: ResourceMatch, parsed: ParsedResourceUri): void;
  /** Idempotent: an unknown URI is not an error. */
  unsubscribe(uri: string): void;
  /**
   * Send `notifications/resources/updated` for every subscribed URI the
   * predicate accepts. Resolves the number notified; never rejects.
   */
  notify(predicate: (match: ResourceMatch) => boolean): Promise<number>;
  /** The subscribed URIs, in subscription order. A diagnostic. */
  subscribed(): readonly string[];
  /**
   * Stop polling and forget every subscription. Idempotent; a read in flight
   * is awaited, so nothing is sent after this resolves.
   */
  close(): Promise<void>;
}

interface Entry {
  readonly match: ResourceMatch;
  readonly parsed: ParsedResourceUri;
  /** The last envelope's comparable form; `undefined` until a baseline is read. */
  fingerprint?: string;
  /** No later read can differ, or none can succeed: polling has stopped. */
  settled: boolean;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The envelope as compared: `data` without the spec's volatile fields. */
function fingerprintOf(match: ResourceMatch, result: ToolResult<unknown>): string {
  const volatile = match.spec.watch?.volatile ?? [];
  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return canonicalJson({ ok: result.ok, data, error: result.error?.code });
  }
  const kept = Object.fromEntries(
    Object.entries(data).filter(([key]) => !volatile.includes(key)),
  );
  return canonicalJson({ ok: result.ok, data: kept, error: result.error?.code });
}

/** True once polling this entry can tell the client nothing new. */
function settles(match: ResourceMatch, result: ToolResult<unknown>): boolean {
  if (!result.ok) return result.error?.retryable === false;
  return match.spec.watch?.settled(result.data) ?? true;
}

export function createSubscriptionHub(opts: SubscriptionHubOptions): SubscriptionHub {
  const logger = opts.logger ?? silentLogger;
  const intervalMs = opts.intervalMs ?? DEFAULT_SUBSCRIPTION_POLL_MS;
  const entries = new Map<string, Entry>();
  const stopping = new AbortController();
  const inFlight = new Set<Promise<void>>();
  let loop: Promise<void> | undefined;

  const polled = (entry: Entry): boolean =>
    opts.clock !== undefined && entry.match.spec.watch !== undefined && !entry.settled;

  /** Track a read so `close()` can wait for it. */
  function track(work: Promise<void>): Promise<void> {
    inFlight.add(work);
    return work.finally(() => inFlight.delete(work));
  }

  async function send(uri: string): Promise<boolean> {
    try {
      await opts.send(uri);
      return true;
    } catch (cause) {
      logger.warn('a resources/updated notification failed', {
        uri,
        reason: reasonOf(cause),
      });
      return false;
    }
  }

  /** One read of one entry: seed the baseline, or compare and notify. */
  async function check(uri: string, entry: Entry): Promise<void> {
    let result: ToolResult<unknown>;
    try {
      result = await opts.read(entry.match, entry.parsed);
    } catch (cause) {
      logger.warn('a subscribed resource could not be read; polling continues', {
        uri,
        reason: reasonOf(cause),
      });
      return;
    }
    // Unsubscribed or closed while the read was out: nobody to tell.
    if (stopping.signal.aborted || entries.get(uri) !== entry) return;
    const next = fingerprintOf(entry.match, result);
    const previous = entry.fingerprint;
    entry.fingerprint = next;
    entry.settled = settles(entry.match, result);
    if (previous !== undefined && previous !== next) await send(uri);
  }

  function ensureLoop(): void {
    const clock = opts.clock;
    if (loop !== undefined || clock === undefined || stopping.signal.aborted) return;
    loop = (async () => {
      for (;;) {
        if (![...entries.values()].some(polled)) return;
        try {
          await clock.sleep(intervalMs, stopping.signal);
        } catch {
          // The interval is a legal delay, so only `close()` gets here.
          return;
        }
        for (const [uri, entry] of [...entries]) {
          if (stopping.signal.aborted) return;
          if (polled(entry)) await track(check(uri, entry));
        }
      }
    })().finally(() => {
      loop = undefined;
      // A subscribe that landed as the loop was deciding to stop needs it back.
      if ([...entries.values()].some(polled)) ensureLoop();
    });
  }

  return {
    subscribe: (uri, match, parsed) => {
      if (stopping.signal.aborted || entries.has(uri)) return;
      const entry: Entry = { match, parsed, settled: false };
      entries.set(uri, entry);
      if (!polled(entry)) return;
      void track(check(uri, entry));
      ensureLoop();
    },
    unsubscribe: (uri) => {
      entries.delete(uri);
    },
    notify: async (predicate) => {
      const matching = [...entries].filter(([, entry]) => predicate(entry.match));
      let sent = 0;
      for (const [uri, entry] of matching) {
        // The pushed change is announced here; the next poll re-seeds
        // silently instead of announcing it again.
        delete entry.fingerprint;
        if (await send(uri)) sent += 1;
      }
      return sent;
    },
    subscribed: () => [...entries.keys()],
    close: async () => {
      stopping.abort();
      entries.clear();
      await loop;
      await Promise.all([...inFlight]);
    },
  };
}
