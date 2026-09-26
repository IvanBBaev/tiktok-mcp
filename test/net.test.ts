/**
 * Tests for core/net.ts — the listener-side helpers both servers share.
 *
 * `boundPortOf` is the one place the three shapes `Server.address()` is typed
 * for are decided, and the two its callers never see (a unix-socket path, and
 * `null` before `listen` resolves) are reachable only here: each server binds
 * a `host:port` and reads the address after the awaited bind. The surface each
 * caller actually exercises — a port-0 bind advertising the OS-assigned port —
 * is asserted in `mcp-http.test.ts` and `login.test.ts` against a real socket.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { boundPortOf } from '../src/core/net.js';

test('the bound port is the address port, and the asked-for one otherwise', () => {
  // One type for three states: a listening TCP socket, a unix socket, and not
  // listening at all. Only the first carries a port; the two fallbacks answer
  // to the type, and answer with the port that was asked for rather than with
  // a port nothing is listening on.
  assert.equal(
    boundPortOf({ address: '127.0.0.1', family: 'IPv4', port: 51234 }, 0),
    51234,
  );
  assert.equal(boundPortOf('/tmp/listener.sock', 3000), 3000);
  assert.equal(boundPortOf(null, 3000), 3000);
});
