/**
 * TikTok webhook events — signature verification and payload decoding
 * (CONTRACTS.md § `api/webhook.ts`, TIKTOK-API.md § 10).
 *
 * TikTok POSTs one JSON event per request to the callback URL registered for
 * the app, and signs it: the `TikTok-Signature` header carries `t=<unix
 * seconds>,s=<hex>`, where `s` is HMAC-SHA256 keyed with the app's client
 * secret over `${t}.${rawBody}`. Delivery is at-least-once with retries for up
 * to 72 hours, so the same event can arrive more than once; {@link eventDigest}
 * is the key a receiver dedupes on, because the payload carries no event id.
 *
 * Everything here is pure: no socket, no file, no clock read of its own. The
 * receiver in `mcp/webhook` owns the transport, the persistence and the time.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** The header TikTok signs with; Node lower-cases incoming header names. */
export const SIGNATURE_HEADER = 'tiktok-signature';

/** Default replay window: a signature older (or newer) than this is refused. */
export const DEFAULT_SIGNATURE_TOLERANCE_S = 300;

/** The events this build understands; anything else is kept as `other`. */
export const WEBHOOK_EVENTS = Object.freeze([
  'authorization.removed',
  'post.publish.failed',
  'post.publish.complete',
  'post.publish.inbox_delivered',
  'post.publish.publicly_available',
  'post.publish.no_longer_publicly_available',
  'video.upload.failed',
  'video.publish.completed',
  'portability.download.ready',
] as const);

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

const KNOWN_EVENTS: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

/** One decoded event. `content` is TikTok's JSON-in-a-string, parsed. */
export interface WebhookEvent {
  client_key: string;
  /** The event name as sent; {@link isKnownEvent} says whether this build knows it. */
  event: string;
  /** Unix seconds, as TikTok reports when the event happened. */
  create_time: number;
  user_openid: string;
  content: Record<string, unknown>;
}

export type SignatureCheck =
  { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export function isKnownEvent(name: string): name is WebhookEventName {
  return KNOWN_EVENTS.has(name);
}

/** `t=…,s=…` in any order; `undefined` unless both parts are present and sane. */
function parseSignatureHeader(value: string): { t: number; s: string } | undefined {
  let t: number | undefined;
  let s: string | undefined;
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(val)) t = Number(val);
    else if (key === 's' && /^[0-9a-f]{64}$/i.test(val)) s = val.toLowerCase();
  }
  return t === undefined || s === undefined ? undefined : { t, s };
}

/**
 * Verify `TikTok-Signature` against the raw body. The comparison is constant
 * time over equal-length digests, and the timestamp must sit within
 * `toleranceS` of `nowMs` in either direction — a captured request replayed
 * later is refused even though its signature is genuine.
 */
export function verifyWebhookSignature(input: {
  header: string | undefined;
  rawBody: Buffer;
  clientSecret: string;
  nowMs: number;
  toleranceS?: number;
}): SignatureCheck {
  if (input.header === undefined || input.header === '') {
    return { ok: false, reason: 'missing' };
  }
  const parsed = parseSignatureHeader(input.header);
  if (parsed === undefined) return { ok: false, reason: 'malformed' };
  const tolerance = input.toleranceS ?? DEFAULT_SIGNATURE_TOLERANCE_S;
  if (Math.abs(input.nowMs / 1000 - parsed.t) > tolerance) {
    return { ok: false, reason: 'stale' };
  }
  const expected = createHmac('sha256', input.clientSecret)
    .update(`${String(parsed.t)}.`)
    .update(input.rawBody)
    .digest();
  const presented = Buffer.from(parsed.s, 'hex');
  return timingSafeEqual(expected, presented)
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode a verified body. `content` arrives as a JSON string; a string that is
 * not a JSON object decodes to `{}` rather than failing the event, because the
 * envelope fields are what routing needs and TikTok will keep redelivering a
 * request this receiver refuses. `undefined` means the envelope itself is
 * unusable.
 */
export function parseWebhookEvent(rawBody: Buffer): WebhookEvent | undefined {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  const { client_key, event, create_time, user_openid, content } = body;
  if (typeof client_key !== 'string' || client_key === '') return undefined;
  if (typeof event !== 'string' || event === '') return undefined;
  if (typeof create_time !== 'number' || !Number.isFinite(create_time)) return undefined;
  if (typeof user_openid !== 'string') return undefined;
  return {
    client_key,
    event,
    create_time,
    user_openid,
    content: decodeContent(content),
  };
}

function decodeContent(content: unknown): Record<string, unknown> {
  if (isRecord(content)) return content;
  if (typeof content !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The dedupe key: SHA-256 of the raw body. A redelivery is byte-identical (the
 * signature header changes, the body does not), and two distinct events differ
 * at least in `create_time` or `content`.
 */
export function eventDigest(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** `content.publish_id` when the event concerns one publish, else `undefined`. */
export function eventPublishId(event: WebhookEvent): string | undefined {
  const id = event.content['publish_id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}
