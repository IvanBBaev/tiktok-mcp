/**
 * Local OAuth token endpoint stub (TESTING.md § Multi-process env-lock harness).
 *
 * The one test that must cross a real process boundary — "two children contend
 * for the env-file lock, exactly one refresh reaches the server" — cannot use
 * `withFetch`: a stub swapped into *this* process is invisible to a child. So
 * the parent runs a real `node:http` server on port 0 and hands the children
 * `TT_OAUTH_BASE_URL` (test-only, internal, unsupported — CONFIGURATION.md) so
 * their token calls arrive here.
 *
 * It answers the **flat** OAuth shape, not the `{data, error}` envelope
 * (TIKTOK-API.md § 1.2 / CC-A12): applying the envelope decoder to this endpoint
 * is a real bug class, so the stub must not paper over it.
 *
 * Every successful refresh rotates both tokens and stamps them with an
 * increasing serial. That serial is the assertion instrument: if two children
 * each refreshed, they end on different serials and the lock did not hold; if
 * the lock held, both end on the same one and the server counted exactly one
 * refresh.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A refresh the stub served (or refused), in arrival order. */
export interface ServedRefresh {
  /** 1-based arrival order. */
  readonly ordinal: number;
  readonly grantType: string;
  readonly clientKey: string | undefined;
  /** The refresh token the caller presented. */
  readonly refreshToken: string | undefined;
  /** The serial handed back, or `undefined` when the stub returned an error. */
  readonly serial: number | undefined;
}

export interface TokenStubOptions {
  /** `expires_in` handed back, in seconds. Defaults to the real 24 h. */
  readonly expiresIn?: number;
  /** `refresh_expires_in` handed back, in seconds. Defaults to the real 365 d. */
  readonly refreshExpiresIn?: number;
  readonly openId?: string;
  readonly scope?: string;
  /**
   * Flat OAuth errors keyed by **1-based arrival ordinal**, e.g.
   * `{ 1: { error: 'invalid_grant', error_description: '…' } }`. A refused call
   * does not rotate the tokens and does not consume a serial.
   */
  readonly failWith?: Readonly<
    Record<number, { readonly error: string; readonly error_description: string }>
  >;
}

export interface TokenStub {
  /** Origin to put in `TT_OAUTH_BASE_URL`, e.g. `http://127.0.0.1:53124`. */
  readonly baseUrl: string;
  /** Every token call the stub saw, in order. */
  readonly served: readonly ServedRefresh[];
  /** How many calls **succeeded** — the "exactly one refresh" assertion. */
  readonly refreshCount: number;
  /** The serial of the most recent successful rotation, or `0` if none. */
  readonly serial: number;
  /** Requests to a path this stub does not implement (a client-side bug). */
  readonly unexpected: readonly string[];
  close(): Promise<void>;
}

const DEFAULT_EXPIRES_IN = 86_400;
const DEFAULT_REFRESH_EXPIRES_IN = 31_536_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Start the stub. Implements `POST …/v2/oauth/token/` (rotating) and
 * `POST …/v2/oauth/revoke/` (empty success body); anything else is answered 404
 * and recorded in `unexpected`, so a wrong path shows up as a named failure
 * rather than a confusing transport error.
 */
export async function startTokenStub(opts: TokenStubOptions = {}): Promise<TokenStub> {
  const expiresIn = opts.expiresIn ?? DEFAULT_EXPIRES_IN;
  const refreshExpiresIn = opts.refreshExpiresIn ?? DEFAULT_REFRESH_EXPIRES_IN;
  const openId = opts.openId ?? 'test-open-id-DEFAULT';
  const scope = opts.scope ?? 'user.info.basic,video.list,video.publish,video.upload';
  const failWith = opts.failWith ?? {};

  const served: ServedRefresh[] = [];
  const unexpected: string[] = [];
  let serial = 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    };

    if (req.method === 'POST' && path.endsWith('/oauth/revoke/')) {
      send(200, {});
      return;
    }

    if (req.method !== 'POST' || !path.endsWith('/oauth/token/')) {
      unexpected.push(`${String(req.method)} ${path}`);
      send(404, { error: 'not_found', error_description: `no stub route for ${path}` });
      return;
    }

    void readBody(req).then((raw) => {
      const form = new URLSearchParams(raw);
      const ordinal = served.length + 1;
      const failure = failWith[ordinal];

      if (failure !== undefined) {
        served.push({
          ordinal,
          grantType: form.get('grant_type') ?? '',
          clientKey: form.get('client_key') ?? undefined,
          refreshToken: form.get('refresh_token') ?? undefined,
          serial: undefined,
        });
        // Flat OAuth error shape — NOT the {data, error} envelope (CC-A12).
        send(400, { ...failure, log_id: `stub-log-${String(ordinal)}` });
        return;
      }

      serial += 1;
      served.push({
        ordinal,
        grantType: form.get('grant_type') ?? '',
        clientKey: form.get('client_key') ?? undefined,
        refreshToken: form.get('refresh_token') ?? undefined,
        serial,
      });
      send(200, {
        access_token: `stub-access-${String(serial)}`,
        expires_in: expiresIn,
        open_id: openId,
        refresh_expires_in: refreshExpiresIn,
        refresh_token: `stub-refresh-${String(serial)}`,
        scope,
        token_type: 'Bearer',
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the OS picks a free port, so parallel test files never collide
    // (determinism rule 3). 127.0.0.1, never ::1 — same rule as the loopback
    // redirect URI.
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    served,
    get refreshCount() {
      return served.filter((call) => call.serial !== undefined).length;
    },
    get serial() {
      return serial;
    },
    unexpected,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Without this, a child that left a keep-alive socket open makes
        // `close()` hang until the socket times out.
        server.closeAllConnections();
        server.close((err) => {
          if (err === undefined) resolve();
          else reject(err);
        });
      }),
  };
}
