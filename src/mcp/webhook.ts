/**
 * The webhook receiver and its event log (ARCHITECTURE.md § 6.1,
 * CONTRACTS.md § `mcp/webhook.ts`, CONFIGURATION.md § Webhooks).
 *
 * TikTok pushes publish-status and authorization events to one public HTTPS
 * URL per app. Under `TT_TRANSPORT=http` with `TT_WEBHOOK_PATH` set, the HTTP
 * transport hands every POST on that path here instead of to MCP. The path is
 * exempt from the bearer — TikTok cannot present one — and is authenticated by
 * the `TikTok-Signature` HMAC instead (`api/webhook`), keyed with the app's
 * client secret as the env file holds it *now*, so a rotated secret takes
 * effect without a restart.
 *
 * What the receiver answers decides whether TikTok retries:
 *
 * - **200** — accepted and recorded, or a redelivery of an event already
 *   recorded. Delivery is at-least-once; a duplicate is success, not news.
 * - **401** — no, a malformed, a stale or a wrong signature. Logged with the
 *   reason, never with the header.
 * - **400** — a genuine signature over a body that is not an event, or an event
 *   for another app. Retrying cannot fix either.
 * - **500** — the event could not be written. TikTok retries for 72 hours, so
 *   refusing is how a full disk loses nothing.
 * - **503** — no app credentials are configured yet; TikTok retries too.
 *
 * The log is `webhooks.ndjson` beside the env file — one JSON line per event,
 * `0600`, one rotated generation past {@link WEBHOOK_LOG_MAX_BYTES}. Only this
 * process writes it (the receiver lives in the one HTTP server), so rotation
 * needs no lock; readers merge both generations and dedupe by digest, which
 * also covers a redelivery that crossed a restart.
 *
 * Layering: `core ← api ← mcp ← tools`.
 */

import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  eventDigest,
  eventPublishId,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../api/webhook.js';
import type { Clock } from '../core/clock.js';
import {
  listProfiles,
  readEnvFile,
  readProfile,
  resolveEnvFilePath,
} from '../core/config.js';
import { TikTokError } from '../core/errors.js';
import type { Logger } from '../core/log.js';
import { forgetRevokedProfile, type ForgetOutcome } from '../core/oauth.js';
import { redactText } from '../core/redact.js';
import type { Settings } from '../core/settings.js';

/** The record-shape version. Additive-only. */
export const WEBHOOK_LOG_VERSION = 1;

/** Past this size the next append first rotates the file to `.1`. */
export const WEBHOOK_LOG_MAX_BYTES = 1_048_576;

/** How many recent digests the receiver remembers to answer redeliveries. */
export const RECENT_DIGESTS = 1024;

const WEBHOOK_LOG_FILE = 'webhooks.ndjson';
const ROTATED_SUFFIX = '.1';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** One persisted event. */
export interface WebhookRecord {
  v: 1;
  /** ISO-8601 UTC, this server's receipt time. */
  received_at: string;
  /** SHA-256 of the raw body — the dedupe key. */
  digest: string;
  event: string;
  /** Unix seconds, TikTok's time of the event. */
  create_time: number;
  user_openid: string;
  /** The local profile whose `open_id` matches, when one does. */
  profile?: string;
  publish_id?: string;
  content: Record<string, unknown>;
}

/** `webhooks.ndjson` beside the resolved env file. */
export function resolveWebhookLogPath(envFile?: string): string {
  return join(dirname(envFile ?? resolveEnvFilePath(process.env)), WEBHOOK_LOG_FILE);
}

// writing ---------------------------------------------------------------

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/** One complete line per `write()` on an `O_APPEND` fd, rotating first when due. */
export async function appendWebhookRecord(
  path: string,
  record: WebhookRecord,
  maxBytes: number = WEBHOOK_LOG_MAX_BYTES,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const size = await fileSize(path);
  if (size !== undefined && size >= maxBytes) {
    await rename(path, `${path}${ROTATED_SUFFIX}`);
  }
  const line = `${JSON.stringify(record)}\n`;
  const handle = await open(path, 'a', FILE_MODE);
  try {
    const { bytesWritten } = await handle.write(line);
    const expected = Buffer.byteLength(line);
    if (bytesWritten !== expected) {
      throw new Error(
        `short webhook log write: ${String(bytesWritten)} of ${String(expected)} bytes`,
      );
    }
  } finally {
    await handle.close();
  }
}

// reading ---------------------------------------------------------------

function isRecordShape(value: unknown): value is WebhookRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r['v'] === WEBHOOK_LOG_VERSION &&
    typeof r['received_at'] === 'string' &&
    typeof r['digest'] === 'string' &&
    typeof r['event'] === 'string' &&
    typeof r['create_time'] === 'number' &&
    typeof r['user_openid'] === 'string' &&
    typeof r['content'] === 'object' &&
    r['content'] !== null &&
    !Array.isArray(r['content'])
  );
}

async function readGeneration(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new TikTokError({
      kind: 'internal',
      code: 'webhook_log_unreadable',
      message:
        `The webhook event log at ${path} exists but cannot be read. Ask the user to check ` +
        'its permissions; events TikTok sends are still recorded while the file can be appended to.',
      retryable: false,
      cause,
    });
  }
}

export interface WebhookLogRead {
  /** Oldest first, one per digest. */
  records: WebhookRecord[];
  skippedLines: number;
  /** Whether either generation exists. */
  exists: boolean;
}

/** Both generations, oldest first, deduped by digest; bad lines are counted. */
export async function readWebhookLog(path: string): Promise<WebhookLogRead> {
  const rotated = await readGeneration(`${path}${ROTATED_SUFFIX}`);
  const current = await readGeneration(path);
  const records: WebhookRecord[] = [];
  const seen = new Set<string>();
  let skippedLines = 0;
  for (const raw of `${rotated ?? ''}\n${current ?? ''}`.split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecordShape(parsed)) {
      skippedLines += 1;
      continue;
    }
    if (seen.has(parsed.digest)) continue;
    seen.add(parsed.digest);
    records.push(parsed);
  }
  return {
    records,
    skippedLines,
    exists: rotated !== undefined || current !== undefined,
  };
}

// identity --------------------------------------------------------------

/** Who an event may come from, and which local profile each `open_id` is. */
export interface WebhookIdentity {
  clientKey: string;
  clientSecret: string;
  /** `open_id` → profile name; the first profile in sort order wins a tie. */
  profiles: ReadonlyMap<string, string>;
}

/**
 * The app credentials and the `open_id` map as the env file holds them now.
 * `undefined` when no app credentials are configured. A profile that cannot be
 * read (a broken expiry, say) only drops out of the map: it must not stop
 * events for every other profile.
 */
export async function readWebhookIdentity(
  envFile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebhookIdentity | undefined> {
  const snapshot = await readEnvFile(envFile);
  let identity: WebhookIdentity | undefined;
  const profiles = new Map<string, string>();
  for (const name of listProfiles(snapshot, env)) {
    let credentials;
    try {
      credentials = readProfile(name, snapshot, env);
    } catch {
      continue;
    }
    identity ??= {
      clientKey: credentials.clientKey,
      clientSecret: credentials.clientSecret,
      profiles,
    };
    const openId = credentials.openId;
    if (openId !== undefined && !profiles.has(openId)) profiles.set(openId, name);
  }
  return identity;
}

// receiving -------------------------------------------------------------

export interface WebhookReceiverOptions {
  /** Read on every request, so a rotated secret applies without a restart. */
  identity: () => Promise<WebhookIdentity | undefined>;
  logPath: string;
  clock: Clock;
  log: Logger;
  /** `TT_WEBHOOK_TOLERANCE_S`. */
  toleranceS: number;
  /**
   * Called once per newly recorded event, after it is on disk. Not awaited:
   * TikTok gets its answer without waiting for whatever the event sets off.
   */
  onEvent?: (record: WebhookRecord) => void | Promise<void>;
  /** A test seam; defaults to {@link WEBHOOK_LOG_MAX_BYTES}. */
  maxBytes?: number;
}

export interface WebhookDelivery {
  signature: string | undefined;
  rawBody: Buffer;
}

/** Takes one verified-or-not delivery and answers the HTTP status to send. */
export type WebhookReceiver = (delivery: WebhookDelivery) => Promise<number>;

export function createWebhookReceiver(opts: WebhookReceiverOptions): WebhookReceiver {
  const log = opts.log.child({ component: 'webhook' });
  // Insertion-ordered, so the oldest digest is the first one evicted.
  const recent = new Set<string>();
  const remember = (digest: string): void => {
    recent.add(digest);
    if (recent.size > RECENT_DIGESTS) {
      const [oldest] = recent;
      recent.delete(oldest as string);
    }
  };

  return async ({ signature, rawBody }) => {
    let identity: WebhookIdentity | undefined;
    try {
      identity = await opts.identity();
    } catch (cause) {
      log.error('webhook refused: the env file could not be read', {
        status: 503,
        reason: redactText(String(cause)),
      });
      return 503;
    }
    if (identity === undefined) {
      log.warn('webhook refused: no app credentials are configured', { status: 503 });
      return 503;
    }
    const check = verifyWebhookSignature({
      header: signature,
      rawBody,
      clientSecret: identity.clientSecret,
      nowMs: opts.clock.now(),
      toleranceS: opts.toleranceS,
    });
    if (!check.ok) {
      log.warn('webhook refused: signature rejected', {
        status: 401,
        reason: check.reason,
      });
      return 401;
    }
    const event = parseWebhookEvent(rawBody);
    if (event === undefined) {
      log.warn('webhook refused: the body is not a TikTok event', { status: 400 });
      return 400;
    }
    if (event.client_key !== identity.clientKey) {
      log.warn('webhook refused: the event names another app', { status: 400 });
      return 400;
    }
    const digest = eventDigest(rawBody);
    if (recent.has(digest)) {
      log.debug('webhook redelivery ignored', { event: event.event });
      return 200;
    }
    const profile = identity.profiles.get(event.user_openid);
    const publishId = eventPublishId(event);
    const record: WebhookRecord = {
      v: WEBHOOK_LOG_VERSION,
      received_at: new Date(opts.clock.now()).toISOString(),
      digest,
      event: event.event,
      create_time: event.create_time,
      user_openid: event.user_openid,
      ...(profile === undefined ? {} : { profile }),
      ...(publishId === undefined ? {} : { publish_id: publishId }),
      content: event.content,
    };
    try {
      await appendWebhookRecord(opts.logPath, record, opts.maxBytes);
    } catch (cause) {
      log.error('webhook event could not be recorded; TikTok will redeliver it', {
        status: 500,
        path: opts.logPath,
        reason: redactText(String(cause)),
      });
      return 500;
    }
    remember(digest);
    log.info('webhook event recorded', {
      event: event.event,
      ...(profile === undefined ? {} : { profile }),
      ...(publishId === undefined ? {} : { publish_id: publishId }),
    });
    void opts.onEvent?.(record);
    return 200;
  };
}

/** What the HTTP transport needs to serve the receiver. */
export interface WebhookRoute {
  path: string;
  receive: WebhookReceiver;
}

/**
 * The receiver as `TT_WEBHOOK_PATH` configures it, or `undefined` when no path
 * is set. The composition root's whole share of the wiring.
 */
export function webhookRouteFor(
  settings: Settings,
  log: Logger,
  clock: Clock,
  onEvent?: (record: WebhookRecord) => void | Promise<void>,
): WebhookRoute | undefined {
  if (settings.webhookPath === undefined) return undefined;
  const envFile = settings.envFile ?? resolveEnvFilePath(process.env);
  return {
    path: settings.webhookPath,
    receive: createWebhookReceiver({
      identity: () => readWebhookIdentity(envFile),
      logPath: resolveWebhookLogPath(envFile),
      clock,
      log,
      toleranceS: settings.webhookToleranceS,
      ...(onEvent === undefined ? {} : { onEvent }),
    }),
  };
}

// revocation ------------------------------------------------------------

/** The event TikTok sends when the user removes this app's access. */
export const AUTHORIZATION_REMOVED = 'authorization.removed';

export interface RevocationListenerOptions {
  log: Logger;
  /** The local clear; {@link forgetRevokedProfile} unless a test swaps it. */
  forget?: (profile: string, openId: string) => Promise<ForgetOutcome>;
  /**
   * Called after a profile's tokens were cleared, so clients hear about it at
   * once rather than on the credential watch's next poll.
   */
  onRevoked?: (profile: string) => Promise<void>;
}

/**
 * The `onEvent` hook that acts on `authorization.removed`: the named profile's
 * tokens are cleared locally (no upstream call — the grant is already gone),
 * then `onRevoked` runs. Every other event, and one from an `open_id` no
 * profile held, is ignored. The returned promise never rejects; a failure is
 * logged, since the event itself is already safely on disk.
 */
export function revocationListener(
  opts: RevocationListenerOptions,
): (record: WebhookRecord) => Promise<void> {
  const log = opts.log.child({ component: 'webhook' });
  const forget =
    opts.forget ??
    ((profile: string, openId: string) =>
      forgetRevokedProfile(profile, openId, { logger: log }));
  return async (record) => {
    if (record.event !== AUTHORIZATION_REMOVED || record.profile === undefined) return;
    const profile = record.profile;
    try {
      const outcome = await forget(profile, record.user_openid);
      if (outcome === 'unwritable') {
        log.error(
          'TikTok reported the access removed, but the tokens could not be cleared from the env file; remove them by hand',
          { profile },
        );
        return;
      }
      if (outcome !== 'cleared') {
        log.info('TikTok reported the access removed; nothing to clear', {
          profile,
          outcome,
        });
        return;
      }
      log.warn('TikTok reported the access removed; the tokens were cleared', {
        profile,
      });
      await opts.onRevoked?.(profile);
    } catch (cause) {
      log.error('the access removal could not be applied', {
        profile,
        reason: redactText(String(cause)),
      });
    }
  };
}
