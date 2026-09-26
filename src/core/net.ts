/**
 * core/net.ts — listener-side helpers shared by the two servers this package
 * binds: the MCP HTTP transport (`mcp/http`) and the login loopback callback
 * (`cli/login`). It lives here because `mcp/` may not import `cli/`, and a
 * one-liner duplicated across two layers is two places to get it wrong.
 */

import type { AddressInfo } from 'node:net';

/**
 * The port a bound server actually listens on — the asked-for one may be 0.
 *
 * `Server.address()` is typed `AddressInfo | string | null` for all three of its
 * shapes at once: `null` before `listen` resolves, a path string for a unix
 * socket, an {@link AddressInfo} for a TCP one. Both callers only ever see the
 * third — each binds a `host:port` and reads the address after the awaited
 * bind — but the type cannot say so, so the other two arms answer with the port
 * that was asked for rather than with a port nothing is listening on. Split out
 * as an ordinary function so all three arms are decided by a test rather than
 * excluded from coverage.
 */
export function boundPortOf(
  address: AddressInfo | string | null,
  fallback: number,
): number {
  return typeof address === 'object' && address !== null ? address.port : fallback;
}
