/**
 * P-15 — resolve-and-pin spike (SECURITY.md § "DNS resolve-and-pin: deferred out
 * of v1", TESTING.md § Sandbox probes, docs/probes/PROBE-LOG.md).
 *
 * The question, restated: `core/http.preflightDns` resolves an allowlisted
 * hostname and refuses a private answer, but the connection is then opened by
 * `globalThis.fetch`, which resolves the name a *second* time. Between those two
 * resolutions an attacker who controls the name's DNS can swap the answer. The
 * gap is real, documented and accepted for v1. This spike answers, by running
 * code rather than by reasoning: can that gap be closed on stock Node, with no
 * new dependency, and what does closing it cost?
 *
 * Nothing here is production code and nothing under `src/` is touched — a spike
 * that edits the hot path is a work package wearing a disguise. This file exists
 * so the decision recorded in the probe log is backed by an execution that
 * anyone can repeat:
 *
 *     node --experimental-strip-types scripts/spikes/p15-resolve-and-pin.ts
 *     node build/scripts/spikes/p15-resolve-and-pin.js   # after `npm run build`
 *
 * It talks to nothing but loopback servers it starts itself, so it is safe to
 * run offline and on CI; the only external binary it wants is `openssl`, and the
 * TLS section reports itself SKIPPED rather than failing when that is missing.
 *
 * ## How the rebinding attack is simulated
 *
 * Only 127.0.0.1 and ::1 can be bound without root on a stock macOS/Linux box,
 * so the two "addresses" in the scenario are those two, standing in for the two
 * answers of a rebinding resolver:
 *
 *   - `127.0.0.1` → server **VETTED**   — the answer the pre-flight saw and
 *                                         accepted as public;
 *   - `::1`       → server **REBOUND**  — the answer the attacker swaps in for
 *                                         the second resolution.
 *
 * Both servers listen on the *same port* and report their own identity, so the
 * body of the response is a direct read-out of which address the socket reached.
 * That is the whole measurement: the private-vs-public *classification* is
 * already implemented and unit-tested in `core/http.isPrivateAddress`; what was
 * never demonstrated is whether the connection can be held to the address the
 * classification approved. This file demonstrates exactly that and claims
 * nothing more.
 */

import { execFileSync } from 'node:child_process';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// tiny reporting harness
// ---------------------------------------------------------------------------

interface Finding {
  readonly section: string;
  readonly claim: string;
  readonly verdict: 'PASS' | 'FAIL' | 'SKIP';
  readonly evidence: string;
}

const findings: Finding[] = [];

/**
 * Record one claim with the observation that settles it. The spike is only
 * worth anything if every line of its verdict is traceable to something that
 * actually ran, so nothing is printed that did not come through here.
 */
function record(
  section: string,
  claim: string,
  verdict: Finding['verdict'],
  evidence: string,
): void {
  findings.push({ section, claim, verdict, evidence });
  console.log(`  [${verdict}] ${claim}\n         ${evidence}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

function short(value: unknown, max = 120): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Cause chain of a `TypeError: fetch failed`, where undici hides the real code. */
function causeOf(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (cause === undefined) return short(error);
  const code: unknown = (cause as { code?: unknown }).code;
  return `${short(error, 40)} ← ${typeof code === 'string' ? code : short(cause, 60)}`;
}

// ---------------------------------------------------------------------------
// the DNS seam, in the two shapes Node hands it to us
// ---------------------------------------------------------------------------

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * The single call shape both `net.connect` and `core/http.preflightDns` use.
 * Node's real `dns.lookup` is far more overloaded than this; the spike only has
 * to be compatible with the way it is actually called, which the shape probe in
 * section 1 prints so the assumption is visible rather than assumed.
 */
type NodeLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

/** Answer `options.all` correctly — undici always asks for the list form. */
function deliver(
  answer: LookupAddress,
  options: unknown,
  callback: LookupCallback,
): void {
  const wantsAll =
    typeof options === 'object' && options !== null && 'all' in options
      ? (options as { all?: unknown }).all === true
      : false;
  if (wantsAll) callback(null, [answer]);
  else callback(null, answer.address, answer.family);
}

interface FakeDns {
  /** Answers for `hostname`, consumed by call index and clamped to the last. */
  script(hostname: string, answers: readonly LookupAddress[]): void;
  callsFor(hostname: string): number;
  /** Calls that fell through to the real resolver — the OS-level cost counter. */
  delegated(): number;
  restore(): void;
}

/**
 * Install a rebinding resolver **process-wide**.
 *
 * `net.connect` reads `dns.lookup` off the CommonJS `node:dns` module object at
 * connect time, so overwriting that property is the only way to make undici —
 * which exposes no per-request resolver on stock Node — see a name the machine's
 * real resolver has never heard of. The ESM namespace is frozen, hence
 * `createRequire`. This is a test-bed device, not a proposal: patching a builtin
 * globally would poison every socket in the process, which is precisely why it
 * is evaluated in section 2 and rejected there.
 */
function installFakeDns(): FakeDns {
  const require = createRequire(import.meta.url);
  const dnsModule = require('node:dns') as { lookup: NodeLookupFn };
  const real = dnsModule.lookup;

  const scripts = new Map<string, readonly LookupAddress[]>();
  const counts = new Map<string, number>();
  let delegatedCalls = 0;

  const patched = function patchedLookup(hostname: string, ...rest: unknown[]): void {
    const answers = scripts.get(hostname);
    if (answers === undefined) {
      delegatedCalls += 1;
      (real as unknown as (...args: unknown[]) => void)(hostname, ...rest);
      return;
    }
    const index = counts.get(hostname) ?? 0;
    counts.set(hostname, index + 1);
    const answer = answers[Math.min(index, answers.length - 1)];
    const callback = rest.at(-1) as LookupCallback;
    if (answer === undefined) {
      callback(new Error(`p15: no scripted answer for ${hostname}`), '', 0);
      return;
    }
    deliver(answer, rest[0], callback);
  } as unknown as NodeLookupFn;

  dnsModule.lookup = patched;

  return {
    script: (hostname, answers) => {
      scripts.set(hostname, answers);
      counts.set(hostname, 0);
    },
    callsFor: (hostname) => counts.get(hostname) ?? 0,
    delegated: () => delegatedCalls,
    restore: () => {
      dnsModule.lookup = real;
    },
  };
}

/**
 * The pin itself: a `lookup` that ignores the network and always answers with
 * the address the caller already vetted. This is the entire production change
 * on the resolver side — everything else is about where such a function can be
 * plugged in.
 */
function pinnedLookup(answer: LookupAddress): NodeLookupFn {
  return (_hostname, options, callback) => {
    deliver(answer, options, callback);
  };
}

// ---------------------------------------------------------------------------
// loopback test bed
// ---------------------------------------------------------------------------

interface EchoPair {
  readonly vetted: HttpServer;
  readonly rebound: HttpServer;
  readonly port: number;
}

function echoServer(identity: string): HttpServer {
  return createHttpServer((_request, response) => {
    response.setHeader('content-type', 'text/plain');
    response.end(identity);
  });
}

function listen(server: HttpServer, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/**
 * Two servers on one port, one per loopback family. Same port is not a detail:
 * it makes `http://name:port/` a single URL whose destination depends on the
 * resolved address and on nothing else, which is what the whole experiment
 * measures. Port 0 on the first bind can collide on the second family, so this
 * retries rather than fabricating a result from a lucky first draw.
 */
async function startEchoPair(): Promise<EchoPair | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const vetted = echoServer('VETTED');
    const rebound = echoServer('REBOUND');
    try {
      const port = await listen(vetted, '127.0.0.1', 0);
      await listen(rebound, '::1', port);
      return { vetted, rebound, port };
    } catch {
      await close(vetted);
      await close(rebound);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

async function fetchText(url: string, dispatcher?: object): Promise<string> {
  const init =
    dispatcher === undefined ? undefined : ({ dispatcher } as unknown as FetchInit);
  const response = await fetch(url, init);
  return await response.text();
}

interface NodeHttpResult {
  readonly status: number;
  readonly body: string;
  readonly remoteAddress: string;
  readonly authorized?: boolean;
  readonly peerSubjectCn?: string;
}

/** One `node:http`/`node:https` request, reduced to what the assertions read. */
function nodeRequest(
  secure: boolean,
  options: RequestOptions,
): Promise<NodeHttpResult | Error> {
  return new Promise((resolve) => {
    const send = secure ? httpsRequest : httpRequest;
    const request = send(options, (response) => {
      const socket = response.socket;
      const remoteAddress = socket.remoteAddress ?? '';
      const tls =
        secure && 'getPeerCertificate' in socket
          ? (socket as unknown as {
              authorized: boolean;
              getPeerCertificate: () => { subject?: { CN?: string } };
            })
          : undefined;
      const authorized = tls?.authorized;
      const peerSubjectCn = tls?.getPeerCertificate().subject?.CN;
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body,
          remoteAddress,
          authorized,
          peerSubjectCn,
        });
      });
    });
    request.on('error', (error) => {
      resolve(error);
    });
    request.end();
  });
}

// ---------------------------------------------------------------------------
// section 1 — what does stock Node actually expose?
// ---------------------------------------------------------------------------

const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

interface AgentOptions {
  readonly connect?: {
    readonly lookup?: NodeLookupFn;
    readonly ca?: string | readonly string[];
  };
}
type AgentCtor = new (options: AgentOptions) => object;

/**
 * Node bundles undici but exports none of it. The one handle that exists is the
 * lazily-created global dispatcher undici parks on `globalThis` under a
 * versioned symbol after the first `fetch`; from an instance, `.constructor` is
 * the `Agent` class. Undocumented and version-keyed (`.1`), so every use of it
 * has to be able to find nothing and say so.
 */
function undiciAgentCtor(): AgentCtor | undefined {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const dispatcher = holder[UNDICI_GLOBAL_DISPATCHER];
  if (typeof dispatcher !== 'object' || dispatcher === null) return undefined;
  const ctor: unknown = (dispatcher as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' ? (ctor as AgentCtor) : undefined;
}

function dispatcherClassName(): string {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const dispatcher = holder[UNDICI_GLOBAL_DISPATCHER];
  if (typeof dispatcher !== 'object' || dispatcher === null) return 'absent';
  const ctor: unknown = (dispatcher as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' ? ((ctor as { name?: string }).name ?? '?') : '?';
}

/**
 * What class the symbol holds in a *fresh* process after `prelude` has run.
 *
 * A child is the only honest way to ask this twice: the global dispatcher is
 * built once per process, and undici reads the proxy environment while building
 * it, so neither the "not yet created" state nor the proxy variant can be
 * observed again from inside a process that has one.
 */
function dispatcherClassInChild(prelude: string, env?: NodeJS.ProcessEnv): string {
  const source =
    `${prelude}\n` +
    "const d = globalThis[Symbol.for('undici.globalDispatcher.1')];\n" +
    "process.stdout.write(d ? d.constructor.name : 'absent');";
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: env ?? process.env,
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function probeCapabilities(
  warmUpUrl: string,
  classAtStartup: string,
): Promise<void> {
  heading('1. What a stock Node 22 exposes (no dependency added)');
  console.log(`  node ${process.version} on ${process.platform}`);

  for (const specifier of ['undici', 'node:undici']) {
    try {
      await import(specifier);
      record('capabilities', `import('${specifier}')`, 'FAIL', 'resolved — unexpected');
    } catch (error) {
      record(
        'capabilities',
        `import('${specifier}') is unavailable`,
        'PASS',
        short(error, 90),
      );
    }
  }

  const globals = ['Agent', 'Dispatcher', 'setGlobalDispatcher'] as const;
  const globalTypes = globals
    .map((name) => `${name}=${typeof (globalThis as Record<string, unknown>)[name]}`)
    .join(' ');
  record(
    'capabilities',
    'no undici class is a global',
    globalTypes.includes('function') ? 'FAIL' : 'PASS',
    globalTypes,
  );

  // Does global fetch even read `init.dispatcher`? A duck-typed object answers
  // that: if `dispatch` is invoked, the seam is honoured; if the request then
  // never settles, the seam demands the full undici handler protocol.
  let duckCalls = 0;
  let handlerKeys = '';
  const duck = {
    dispatch(_options: unknown, handler: object): boolean {
      duckCalls += 1;
      handlerKeys = Object.keys(handler).slice(0, 5).join(',');
      return true;
    },
  };
  const stalled = Symbol('stalled');
  const raced = await Promise.race([
    fetchText(warmUpUrl, duck).catch((error: unknown) => short(error, 60)),
    new Promise<symbol>((resolve) => setTimeout(() => resolve(stalled), 500).unref()),
  ]);
  record(
    'capabilities',
    'global fetch honours init.dispatcher',
    duckCalls === 1 ? 'PASS' : 'FAIL',
    `dispatch calls=${duckCalls}, handler keys=[${handlerKeys}], fetch outcome=${
      raced === stalled
        ? 'never settled (full Dispatcher protocol required)'
        : short(raced, 60)
    }`,
  );

  try {
    await fetchText(warmUpUrl, {});
    record('capabilities', 'a non-Dispatcher is rejected', 'FAIL', 'no error thrown');
  } catch (error) {
    record('capabilities', 'a non-Dispatcher is rejected', 'PASS', causeOf(error));
  }

  const ctor = undiciAgentCtor();
  record(
    'capabilities',
    'a real undici Agent class is reachable via the global-dispatcher symbol',
    ctor === undefined ? 'FAIL' : 'PASS',
    `globalThis[Symbol.for('undici.globalDispatcher.1')] → ${dispatcherClassName()}`,
  );
  // The symbol only exists once *something* has caused undici's global
  // dispatcher to be built, so a pinned Agent cannot be constructed
  // unconditionally at process start; the borrow needs a fallback for the
  // window before it appears.
  const bare = dispatcherClassInChild('');
  const afterHttpImport = dispatcherClassInChild("await import('node:http');");
  const afterFetch = dispatcherClassInChild(
    "await fetch('http://127.0.0.1:1/').catch(() => {});",
  );
  record(
    'capabilities',
    'the dispatcher has to be created before it can be borrowed',
    bare === 'absent' && afterFetch !== 'absent' ? 'PASS' : 'FAIL',
    `fresh process: ${bare}; after ESM import of node:http: ${afterHttpImport}; ` +
      `after one fetch: ${afterFetch}; in this process at startup: ${classAtStartup}`,
  );

  const proxyClass = dispatcherClassInChild(
    "await fetch('http://127.0.0.1:1/').catch(() => {});",
    {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
    },
  );
  record(
    'capabilities',
    'the class behind the symbol depends on the environment',
    proxyClass === 'Agent' ? 'FAIL' : 'PASS',
    `no proxy env → ${dispatcherClassName()}; NODE_USE_ENV_PROXY=1 + HTTP_PROXY → ${proxyClass} ` +
      '(a pin then applies to the proxy address, not the API host)',
  );
}

// ---------------------------------------------------------------------------
// section 2 — the TOCTOU gap, reproduced
// ---------------------------------------------------------------------------

const REBIND_HOST = 'rebind.p15.invalid';

/**
 * Today's shape: pre-flight resolves (answer 1, vetted) and `fetch` resolves
 * again (answer 2, rebound). `.invalid` is reserved and unresolvable, so a
 * response at all proves the scripted resolver is the only one in play.
 */
async function reproduceToctou(dns: FakeDns, port: number): Promise<void> {
  heading('2. The accepted v1 gap, reproduced');

  const vettedAnswer = await new Promise<LookupAddress>((resolve, reject) => {
    const require = createRequire(import.meta.url);
    const lookup = (require('node:dns') as { lookup: NodeLookupFn }).lookup;
    lookup(REBIND_HOST, { all: true }, (error, address) => {
      if (error !== null) reject(error);
      else resolve((address as LookupAddress[])[0] as LookupAddress);
    });
  });

  const body = await fetchText(`http://${REBIND_HOST}:${port}/`);
  record(
    'toctou',
    'pre-flight vets one address, fetch connects to another',
    body === 'REBOUND' ? 'PASS' : 'FAIL',
    `pre-flight saw ${vettedAnswer.address} (VETTED); fetch reached ${body} ` +
      `after ${dns.callsFor(REBIND_HOST)} resolutions of the same name`,
  );
}

// ---------------------------------------------------------------------------
// section 3 — pinning, two ways
// ---------------------------------------------------------------------------

async function pinViaUndiciAgent(dns: FakeDns, port: number): Promise<void> {
  heading('3a. Pin via an undici Agent with connect.lookup');

  const ctor = undiciAgentCtor();
  if (ctor === undefined) {
    record('pin-agent', 'undici Agent obtainable', 'SKIP', 'global dispatcher absent');
    return;
  }

  const before = dns.callsFor(REBIND_HOST);
  const agent = new ctor({
    connect: { lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }) },
  });
  const body = await fetchText(`http://${REBIND_HOST}:${port}/`, agent);
  const after = dns.callsFor(REBIND_HOST);

  record(
    'pin-agent',
    'fetch through a pinned Agent lands on the vetted address',
    body === 'VETTED' ? 'PASS' : 'FAIL',
    `body=${body} while the scripted resolver would have answered ::1 (REBOUND)`,
  );
  record(
    'pin-agent',
    'the pinned Agent never consults the scriptable resolver',
    after === before ? 'PASS' : 'FAIL',
    `resolver calls during the request: ${after - before}`,
  );
}

async function pinViaNodeHttp(dns: FakeDns, port: number): Promise<void> {
  heading('3b. Pin via node:http request({ lookup })');

  // `agent: false` on both of these: the default global agent keeps sockets
  // alive, and the pin belongs to the *socket*, so a pooled connection would
  // decide the outcome instead of the resolver. The pooling effect is worth
  // knowing and is measured separately below.
  const before = dns.callsFor(REBIND_HOST);
  const pinned = await nodeRequest(false, {
    host: REBIND_HOST,
    port,
    path: '/',
    agent: false,
    lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }),
  });
  const after = dns.callsFor(REBIND_HOST);
  record(
    'pin-http',
    'node:http honours a per-request lookup and lands on the vetted address',
    pinned instanceof Error ? 'FAIL' : pinned.body === 'VETTED' ? 'PASS' : 'FAIL',
    pinned instanceof Error
      ? short(pinned)
      : `body=${pinned.body} remoteAddress=${pinned.remoteAddress}, ` +
          `resolver calls during the request: ${after - before}`,
  );

  const unpinned = await nodeRequest(false, {
    host: REBIND_HOST,
    port,
    path: '/',
    agent: false,
  });
  record(
    'pin-http',
    'the same call without lookup follows the rebound answer (control)',
    unpinned instanceof Error ? 'FAIL' : unpinned.body === 'REBOUND' ? 'PASS' : 'FAIL',
    unpinned instanceof Error ? short(unpinned) : `body=${unpinned.body}`,
  );

  // Found the hard way: a pin is per-connection, and no HTTP agent keys its
  // socket pool on `lookup`. So a *later* request that carries no pin can be
  // served over the socket an earlier pinned request opened — the pin outlives
  // the resolution that justified it. Harmless here (it errs towards the vetted
  // address) but it means "pinned" is a property of a connection's lifetime,
  // not of a request, and any real implementation has to say which it means.
  const pooledPin = await nodeRequest(false, {
    host: REBIND_HOST,
    port,
    path: '/',
    lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }),
  });
  const pooledReuse = await nodeRequest(false, { host: REBIND_HOST, port, path: '/' });
  record(
    'pin-http',
    'a keep-alive socket carries the pin into later, unpinned requests',
    !(pooledPin instanceof Error) &&
      !(pooledReuse instanceof Error) &&
      pooledPin.body === 'VETTED' &&
      pooledReuse.body === 'VETTED'
      ? 'PASS'
      : 'FAIL',
    pooledPin instanceof Error || pooledReuse instanceof Error
      ? 'request failed'
      : `pinned request → ${pooledPin.body}; next unpinned request on the pooled ` +
          `socket → ${pooledReuse.body} (the resolver would have said REBOUND)`,
  );
}

// ---------------------------------------------------------------------------
// section 4 — does pinning survive TLS?
// ---------------------------------------------------------------------------

interface Cert {
  readonly key: string;
  readonly cert: string;
}

/**
 * Two throwaway self-signed certs, one per identity. Generated at run time in a
 * temp dir rather than committed: a checked-in key is a key, however toy, and a
 * spike is not worth one.
 */
function makeCerts(dir: string): { good: Cert; rogue: Cert } | undefined {
  const build = (name: string, cn: string): Cert => {
    const keyPath = join(dir, `${name}.key`);
    const certPath = join(dir, `${name}.crt`);
    execFileSync(
      'openssl',
      // prettier-ignore
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '1',
        '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  };
  try {
    return {
      good: build('good', 'pinned.p15.invalid'),
      rogue: build('rogue', 'rogue.p15.invalid'),
    };
  } catch {
    return undefined;
  }
}

/**
 * The point of this section: pinning by *resolver* keeps the URL's hostname, so
 * SNI and certificate-name validation still run against the name. The obvious
 * alternative — putting the IP in the URL and forcing a `Host` header — throws
 * that away unless `servername` is restored by hand, and cannot be expressed
 * through `fetch` at all.
 */
async function tlsUnderPin(dir: string): Promise<void> {
  heading('4. TLS identity under the pin');

  const certs = makeCerts(dir);
  if (certs === undefined) {
    record(
      'tls',
      'openssl available for an ephemeral cert',
      'SKIP',
      'openssl not usable',
    );
    return;
  }

  const good = createHttpsServer(
    { key: certs.good.key, cert: certs.good.cert },
    (_q, s) => s.end('VETTED-TLS'),
  );
  const rogue = createHttpsServer(
    { key: certs.rogue.key, cert: certs.rogue.cert },
    (_q, s) => s.end('ROGUE-TLS'),
  );
  const goodPort = await listen(good, '127.0.0.1', 0);
  const roguePort = await listen(rogue, '127.0.0.1', 0);
  const pin = pinnedLookup({ address: '127.0.0.1', family: 4 });
  const host = 'pinned.p15.invalid';

  try {
    const ok = await nodeRequest(true, {
      host,
      port: goodPort,
      path: '/',
      ca: certs.good.cert,
      lookup: pin,
    });
    record(
      'tls',
      'https.request under a pin validates the cert against the hostname',
      !(ok instanceof Error) && ok.authorized === true && ok.peerSubjectCn === host
        ? 'PASS'
        : 'FAIL',
      ok instanceof Error
        ? short(ok)
        : `status=${ok.status} body=${ok.body} authorized=${String(ok.authorized)} ` +
            `peerCN=${ok.peerSubjectCn ?? '-'} remoteAddress=${ok.remoteAddress}`,
    );

    // Both certs are trusted here on purpose: with the chain out of the way, the
    // only thing that can still reject the rogue server is the name check — so a
    // failure proves *that* control, not merely an untrusted issuer.
    const wrongName = await nodeRequest(true, {
      host,
      port: roguePort,
      path: '/',
      ca: [certs.good.cert, certs.rogue.cert],
      lookup: pin,
    });
    const code =
      wrongName instanceof Error
        ? ((wrongName as NodeJS.ErrnoException).code ?? '')
        : `unexpected ${wrongName.status}`;
    record(
      'tls',
      'a trusted certificate for the wrong name is still rejected',
      code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'PASS' : 'FAIL',
      String(code),
    );

    const ctor = undiciAgentCtor();
    if (ctor === undefined) {
      record('tls', 'pinned Agent over TLS', 'SKIP', 'global dispatcher absent');
    } else {
      const agent = new ctor({ connect: { lookup: pin, ca: certs.good.cert } });
      const body = await fetchText(`https://${host}:${goodPort}/`, agent).catch(
        (error: unknown) => causeOf(error),
      );
      record(
        'tls',
        'fetch through a pinned Agent keeps full TLS validation',
        body === 'VETTED-TLS' ? 'PASS' : 'FAIL',
        `body=${body}`,
      );
      const rogueAgent = new ctor({
        connect: { lookup: pin, ca: [certs.good.cert, certs.rogue.cert] },
      });
      const rogueBody = await fetchText(`https://${host}:${roguePort}/`, rogueAgent).then(
        (text) => `unexpected success: ${text}`,
        (error: unknown) => causeOf(error),
      );
      record(
        'tls',
        'the pinned Agent rejects the wrong-name certificate too',
        rogueBody.includes('ERR_TLS_CERT_ALTNAME_INVALID') ? 'PASS' : 'FAIL',
        rogueBody,
      );
    }

    // The alternative that needs no dispatcher and no resolver: connect to the
    // literal address and restore the identity by hand. It works — and shows
    // exactly how much hand-restoring `lookup` saves.
    const byIp = await nodeRequest(true, {
      host: '127.0.0.1',
      port: goodPort,
      path: '/',
      ca: certs.good.cert,
      servername: host,
      headers: { host },
    });
    record(
      'tls',
      'IP-in-URL + explicit servername/Host also validates (node:https only)',
      !(byIp instanceof Error) && byIp.authorized === true ? 'PASS' : 'FAIL',
      byIp instanceof Error
        ? short(byIp)
        : `status=${byIp.status} authorized=${String(byIp.authorized)} peerCN=${byIp.peerSubjectCn ?? '-'}`,
    );
  } finally {
    await close(good);
    await close(rogue);
  }
}

// ---------------------------------------------------------------------------
// section 5 — what it costs
// ---------------------------------------------------------------------------

const BENCH_HOST = 'bench.p15.invalid';
const BENCH_N = 200;

function summarize(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return `mean ${mean.toFixed(3)} ms, p50 ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms`;
}

async function measureCost(dns: FakeDns, port: number): Promise<void> {
  heading(`5. Cost, over ${BENCH_N} sequential loopback requests each`);

  dns.script(BENCH_HOST, [{ address: '127.0.0.1', family: 4 }]);
  const url = `http://${BENCH_HOST}:${port}/`;
  const ctor = undiciAgentCtor();

  /** What `preflightDns` does today: one resolution per request, `all: true`. */
  const require = createRequire(import.meta.url);
  const preflight = async (host: string): Promise<LookupAddress> =>
    await new Promise((resolve, reject) => {
      const lookup = (require('node:dns') as { lookup: NodeLookupFn }).lookup;
      lookup(host, { all: true }, (error, address) => {
        const first = (address as LookupAddress[])[0];
        if (error !== null || first === undefined)
          reject(error ?? new Error('no answer'));
        else resolve(first);
      });
    });

  // One long-lived Agent whose lookup reads the address the latest pre-flight
  // vetted. Pinning per request by building an Agent per request would work too
  // and would throw away the connection pool with it; this keeps both, at the
  // price named in 3b — a reused socket keeps the address of the pre-flight that
  // opened it.
  let currentPin: LookupAddress = { address: '127.0.0.1', family: 4 };
  const followingPin: NodeLookupFn = (_host, options, callback) => {
    deliver(currentPin, options, callback);
  };
  const pinnedAgent =
    ctor === undefined ? undefined : new ctor({ connect: { lookup: followingPin } });

  const run = async (label: string, once: () => Promise<unknown>): Promise<void> => {
    const before = dns.callsFor(BENCH_HOST);
    await once(); // warm the connection pool: the first request pays for the socket
    const samples: number[] = [];
    for (let i = 0; i < BENCH_N; i += 1) {
      const start = performance.now();
      await once();
      samples.push(performance.now() - start);
    }
    const resolutions = dns.callsFor(BENCH_HOST) - before;
    record(
      'cost',
      label,
      'PASS',
      `${summarize(samples)}; resolver calls for ${BENCH_N + 1} requests: ${resolutions}`,
    );
  };

  await run('a: fetch alone — the v1 default, no seam injected', () => fetchText(url));
  await run('b: pre-flight + fetch — today with the lookup seam injected', async () => {
    await preflight(BENCH_HOST);
    await fetchText(url);
  });
  if (pinnedAgent !== undefined) {
    await run(
      'c: pre-flight + fetch through a pinned Agent — resolve-and-pin',
      async () => {
        currentPin = await preflight(BENCH_HOST);
        await fetchText(url, pinnedAgent);
      },
    );
  }
  await run(
    'd: pre-flight + node:http request({ lookup }) — resolve-and-pin',
    async () => {
      const pinned = await preflight(BENCH_HOST);
      await nodeRequest(false, {
        host: BENCH_HOST,
        port,
        path: '/',
        lookup: pinnedLookup(pinned),
      });
    },
  );

  // What one pre-flight actually costs when the OS resolver answers it. This is
  // a warm-cache loopback number and is *not* the cost of a cold WAN lookup —
  // it only bounds the in-process overhead of the extra call itself.
  const realLookup = (require('node:dns') as { lookup: NodeLookupFn }).lookup;
  const samples: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const start = performance.now();
    await new Promise<void>((resolve) => {
      realLookup('localhost', { all: true }, () => {
        resolve();
      });
    });
    samples.push(performance.now() - start);
  }
  record(
    'cost',
    'one dns.lookup("localhost") (warm OS cache)',
    'PASS',
    summarize(samples),
  );

  // A claim the redesign would rest on, checked rather than remembered:
  // node:http reports a 3xx instead of following it, so CC-B6 survives a move
  // off fetch — but as a different code path, not the same one.
  const redirector = createHttpServer((_request, response) => {
    response.writeHead(302, { location: 'http://example.invalid/' });
    response.end();
  });
  const redirectPort = await listen(redirector, '127.0.0.1', 0);
  const hop = await nodeRequest(false, {
    host: '127.0.0.1',
    port: redirectPort,
    path: '/',
  });
  record(
    'cost',
    'node:http never follows a redirect by itself (CC-B6 equivalence)',
    !(hop instanceof Error) && hop.status === 302 ? 'PASS' : 'FAIL',
    hop instanceof Error ? short(hop) : `status=${hop.status}`,
  );
  await close(redirector);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('P-15 — resolve-and-pin spike (no TikTok account, no external network)');

  // Read before anything can call fetch: undici creates its global dispatcher
  // lazily, and whether it exists yet decides if a pinned Agent can be built at
  // process start or only after a first request has already gone out unpinned.
  const classAtStartup = dispatcherClassName();

  const pair = await startEchoPair();
  if (pair === undefined) {
    console.log('\nINCONCLUSIVE: could not bind 127.0.0.1 and ::1 on one port.');
    process.exitCode = 1;
    return;
  }
  const warmUpUrl = `http://127.0.0.1:${pair.port}/`;

  const dns = installFakeDns();
  const tempDir = mkdtempSync(join(tmpdir(), 'p15-'));
  try {
    // The rebinding script: first answer public-stand-in, every later answer the
    // attacker's. Scripted before the first fetch so no cached socket predates it.
    dns.script(REBIND_HOST, [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);

    await probeCapabilities(warmUpUrl, classAtStartup);
    await reproduceToctou(dns, pair.port);
    await pinViaUndiciAgent(dns, pair.port);
    await pinViaNodeHttp(dns, pair.port);
    await tlsUnderPin(tempDir);
    await measureCost(dns, pair.port);
  } finally {
    dns.restore();
    rmSync(tempDir, { recursive: true, force: true });
    await close(pair.vetted);
    await close(pair.rebound);
  }

  heading('Verdict');
  const failed = findings.filter((finding) => finding.verdict === 'FAIL');
  const skipped = findings.filter((finding) => finding.verdict === 'SKIP');
  console.log(
    `  ${findings.length} claims checked — ${findings.length - failed.length - skipped.length} PASS, ` +
      `${failed.length} FAIL, ${skipped.length} SKIP`,
  );
  for (const finding of failed)
    console.log(`  FAIL ${finding.section}: ${finding.claim}`);
  console.log(
    '\n  Proven: the v1 TOCTOU gap is reachable in practice, and a `lookup`-shaped\n' +
      '  pin closes it on stock Node — through node:http/https natively, and through\n' +
      '  fetch only via an undici Agent reached by an undocumented global symbol.\n' +
      '  Not proven, and not claimed: that either route is stable enough to ship.\n' +
      '  See docs/probes/PROBE-LOG.md § P-15 for the decision this fed.',
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
