/**
 * core/json.ts — THE single canonicalization in the codebase.
 *
 * `canonicalJson()` is the only serializer allowed to feed a digest
 * (`docs/ARCHITECTURE.md` § 8, `docs/CONTRACTS.md` § core/json): the plan digest
 * that makes `plan_id` single-use, and the journal duplicate guard's title hash,
 * are both SHA-256 over its output. A second implementation must not exist, and
 * **any behavior change here silently invalidates every plan_id already issued
 * to a user** — treat this file as a wire format, not as an implementation
 * detail.
 *
 * ## Output grammar
 *
 * A strict subset of JSON (RFC 8259) with no insignificant whitespace:
 * object members are emitted in ascending key order, arrays keep their index
 * order, and there is never a space, newline or trailing comma. The result is
 * always parseable by `JSON.parse` and always well-formed UTF-8 when encoded
 * (lone surrogates are escaped — see "Strings").
 *
 * ## Accepted values
 *
 * `null`, booleans, finite numbers, strings, arrays, and plain objects
 * (prototype `Object.prototype` or `null`). Everything else is **rejected with a
 * `TypeError`** rather than coerced: for a digest, a silent coercion is a
 * collision, and a collision is a payload the user never approved.
 *
 * ## Pinned decisions
 *
 * - **Key ordering** — ascending UTF-16 code-unit order (`<` on the raw key
 *   strings). Locale-independent by construction: `localeCompare` and any
 *   `Intl` collation are banned here because they are environment-dependent.
 * - **Recursion** — objects nested in objects/arrays are canonicalized by the
 *   same rules at every depth. Depth is bounded only by the engine stack; an
 *   adversarially deep structure throws `RangeError` (a rejection, not a
 *   corrupted digest).
 * - **Absent ≡ `undefined` ≡ omitted** (contract-mandated) — an own property
 *   whose value is `undefined` is dropped, so `{a:1}`, `{a:1,b:undefined}` and
 *   `JSON.parse('{"a":1}')` produce byte-identical output.
 * - **`null` is NOT absent** — it is a value and is emitted as `null`, so
 *   `{a:null}` and `{}` have different digests.
 * - **`undefined` outside an object property is rejected** — as a top-level
 *   value or as an array element it has no representation, and mapping it to
 *   `null` (what `JSON.stringify` does) would conflate it with a real `null`.
 *   Array holes are rejected for the same reason.
 * - **Non-finite numbers** (`NaN`, `±Infinity`) are rejected — `JSON.stringify`
 *   maps all three to `null`, collapsing three distinct payloads into one.
 * - **`-0` is normalized to `0`** — the two are `===`-equal numbers, so they are
 *   one payload and must have one digest. (`JSON.stringify` does the same.)
 * - **Number formatting** is ECMAScript `Number::toString`, i.e. the shortest
 *   round-tripping decimal form (`1e+21`, `1e-7`, `0.1`). It is specified,
 *   platform-independent, and `JSON.parse`-compatible.
 * - **`bigint` is rejected** — there is no lossless JSON number for values
 *   outside the IEEE-754 double range, and quoting them would make a bigint
 *   collide with the equivalent string.
 * - **`Date` is rejected** — `toJSON` is deliberately not consulted; a `Date`
 *   would collide with its own ISO string. All timestamps in this codebase are
 *   already ISO-8601 UTC strings (CC-H2), so a `Date` in a payload is a bug.
 * - **`Map`/`Set`/typed arrays/`RegExp`/`Error`/class instances/boxed
 *   primitives are rejected** — `JSON.stringify` renders most of them as `{}`,
 *   which makes every such value digest-identical to every other.
 * - **Functions and symbols are rejected**; an own symbol-keyed property makes
 *   the whole object rejected (nothing is silently dropped except the
 *   contract-mandated `undefined` properties).
 * - **Cycles are rejected** — detected on the ancestor chain, so a repeated but
 *   acyclic reference (the same object appearing twice as a sibling) is fine
 *   and is serialized twice.
 * - **No Unicode normalization** — strings are digested exactly as received.
 *   NFC/NFD variants are different payloads upstream and must stay different
 *   here.
 * - **Prototype-shaped keys** (`__proto__`, `constructor`) are ordinary own
 *   keys with no special meaning.
 *
 * ## Strings
 *
 * Escaping is `JSON.stringify`'s (ES2019 well-formed): `"` and `\`, the C0
 * control characters, and unpaired surrogates become `\uXXXX`; every other
 * code point is emitted literally. Digests are therefore taken over the UTF-8
 * encoding of a string that can always be encoded as UTF-8.
 *
 * Rejections throw `TypeError` with the JSON path of the offending node (keys
 * and indices only — never values, which may be user content).
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

/**
 * Serialize `value` to the canonical JSON form described above.
 *
 * @throws TypeError if the value (or anything reachable from it) is outside the
 *   accepted set: `undefined` in a non-droppable position, non-finite number,
 *   bigint, symbol, function, non-plain object, symbol-keyed property, array
 *   hole, or a cycle.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set<object>());
}

/**
 * Lowercase-hex SHA-256. Strings are hashed as UTF-8 bytes, so
 * `sha256Hex(canonicalJson(x))` is stable across platforms and Node versions.
 */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(bytes).digest('hex');
}

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw unsupported(path, `the non-finite number ${String(value)}`);
      }
      // -0 and 0 are the same number; one payload, one digest.
      return Object.is(value, -0) ? '0' : String(value);
    case 'object':
      if (value === null) return 'null';
      return encodeObject(value, path, ancestors);
    case 'undefined':
      // Reachable only at the root or inside an array: object properties whose
      // value is undefined are dropped before recursion.
      throw unsupported(path, 'undefined');
    default:
      // bigint, symbol, function.
      throw unsupported(path, `a ${typeof value} value`);
  }
}

function encodeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw unsupported(path, 'a circular reference');

  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) {
    throw unsupported(path, `a non-plain object (${constructorName(value)})`);
  }

  ancestors.add(value);
  try {
    return array
      ? encodeArray(value as unknown[], path, ancestors)
      : encodePlainObject(value as Record<string, unknown>, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function encodeArray(value: unknown[], path: string, ancestors: Set<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${String(index)}]`;
    if (!(index in value)) throw unsupported(itemPath, 'an array hole');
    parts.push(encode(value[index], itemPath, ancestors));
  }
  return `[${parts.join(',')}]`;
}

function encodePlainObject(
  value: Record<string, unknown>,
  path: string,
  ancestors: Set<object>,
): string {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw unsupported(path, 'an object with symbol-keyed properties');
  }

  // Read every property exactly once (a getter must not be invoked twice), then
  // drop the undefined-valued ones — absent ≡ undefined ≡ omitted.
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) continue;
    entries.push([key, item]);
  }
  entries.sort(([a], [b]) => compareKeys(a, b));

  const parts = entries.map(
    ([key, item]) =>
      `${JSON.stringify(key)}:${encode(item, childPath(path, key), ancestors)}`,
  );
  return `{${parts.join(',')}}`;
}

/** Ascending UTF-16 code-unit order — no locale, no `Intl`. */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function constructorName(value: object): string {
  const proto = Object.getPrototypeOf(value) as {
    constructor?: { name?: unknown };
  } | null;
  const name = proto?.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'unknown prototype';
}

function childPath(path: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function unsupported(path: string, what: string): TypeError {
  return new TypeError(`canonicalJson: cannot canonicalize ${what} at ${path}`);
}
