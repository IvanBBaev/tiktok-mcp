/**
 * The endpoint table that decides a request's retry class (ARCHITECTURE § 6.3).
 *
 * `core/http` enforces what a class means; this module decides which class a
 * `(method, path)` pair belongs to. The decision used to be the caller's, with
 * `read` as the default, so a new write endpoint that forgot to say `init`
 * would have been retried on a 503 and replayed after a 401 — and a retried
 * write can duplicate a post (TIKTOK-API.md § 4.2, probe P-12). The table fails
 * closed instead:
 *
 * - a listed endpoint gets its listed class;
 * - a `PUT` is a chunk upload to a validated `upload_url` (`chunk`); its path
 *   is opaque, so the method alone decides;
 * - any other `GET` is a read;
 * - every other non-`GET`, unknown ones included, is `init` — never retried,
 *   never replayed.
 *
 * A caller may still ask for a class, but only a stricter one
 * ({@link effectiveRetryClass}): a hint can never loosen the table.
 *
 * Layering: `core ← api ← mcp ← tools`. This file may import from `core` only.
 */

import type { RetryClass } from '../core/http.js';

/** HTTP methods the table knows about. */
export type EndpointMethod = 'GET' | 'POST' | 'PUT';

export interface EndpointEntry {
  readonly method: EndpointMethod;
  /** Path on the endpoint's origin, without query string. */
  readonly path: string;
  readonly retryClass: RetryClass;
}

/**
 * Every endpoint `src/api/*.ts` calls. A test enumerates the paths used in
 * those modules and fails when one is missing here, so a new endpoint must be
 * classified on purpose. Read POSTs are listed one by one: TikTok uses `POST`
 * for queries, so the method says nothing about idempotency.
 */
export const ENDPOINTS: readonly EndpointEntry[] = Object.freeze([
  // Display API reads (TIKTOK-API.md § 3)
  { method: 'GET', path: '/v2/user/info/', retryClass: 'read' },
  { method: 'POST', path: '/v2/video/list/', retryClass: 'read' },
  { method: 'POST', path: '/v2/video/query/', retryClass: 'read' },
  // Content Posting API reads (TIKTOK-API.md § 4)
  { method: 'POST', path: '/v2/post/publish/creator_info/query/', retryClass: 'read' },
  { method: 'POST', path: '/v2/post/publish/status/fetch/', retryClass: 'read' },
  // Content Posting API inits — a retry or replay can duplicate a post
  { method: 'POST', path: '/v2/post/publish/video/init/', retryClass: 'init' },
  { method: 'POST', path: '/v2/post/publish/inbox/video/init/', retryClass: 'init' },
  { method: 'POST', path: '/v2/post/publish/content/init/', retryClass: 'init' },
  // Public oEmbed on www.tiktok.com (TOOLS.md § 3.17)
  { method: 'GET', path: '/oembed', retryClass: 'read' },
]);

/** Strictness order: a later class allows fewer retries. */
const STRICTNESS: Readonly<Record<RetryClass, number>> = Object.freeze({
  read: 0,
  chunk: 1,
  init: 2,
});

const BY_KEY: ReadonlyMap<string, RetryClass> = new Map(
  ENDPOINTS.map((entry) => [`${entry.method} ${entry.path}`, entry.retryClass]),
);

/** The table's class for `(method, path)`, failing closed for unknown writes. */
export function classifyEndpoint(method: EndpointMethod, path: string): RetryClass {
  const listed = BY_KEY.get(`${method} ${path}`);
  if (listed !== undefined) return listed;
  if (method === 'PUT') return 'chunk';
  if (method === 'GET') return 'read';
  return 'init';
}

/**
 * The class a request actually runs under: the table's class, or the caller's
 * `requested` class when that one is stricter. A looser request is ignored.
 */
export function effectiveRetryClass(
  method: EndpointMethod,
  path: string,
  requested?: RetryClass,
): RetryClass {
  const table = classifyEndpoint(method, path);
  if (requested === undefined) return table;
  return STRICTNESS[requested] > STRICTNESS[table] ? requested : table;
}
