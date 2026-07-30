/**
 * Tests for core/json.ts — the single canonicalization behind every digest.
 *
 * `canonicalJson` is a wire format: the plan digest that makes `plan_id`
 * single-use (CC-E7) is SHA-256 over its output, so the properties pinned here
 * are what keeps an issued plan verifiable at execute time. Nothing in this
 * file touches the clock, the network or the file system.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import type { Arbitrary } from 'fast-check';

import { canonicalJson, sha256Hex } from '../src/core/json.js';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

/** Seeded PRNG (mulberry32) — every property failure reproduces (TESTING.md rule 4). */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rebuild the value with every object's own keys in a different order. */
function shuffleKeysDeep(value: JsonValue, rand: () => number): JsonValue {
  if (Array.isArray(value)) return value.map((item) => shuffleKeysDeep(item, rand));
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, JsonValue]> = Object.entries(value).map(
      ([key, item]) => [key, shuffleKeysDeep(item, rand)],
    );
    for (let i = entries.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const a = entries[i] as [string, JsonValue];
      const b = entries[j] as [string, JsonValue];
      entries[i] = b;
      entries[j] = a;
    }
    return Object.fromEntries(entries);
  }
  return value;
}

/** Sprinkle explicitly-undefined properties at every object level. */
function withUndefinedNoise(value: JsonValue, rand: () => number): unknown {
  if (Array.isArray(value)) return value.map((item) => withUndefinedNoise(item, rand));
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown]> = Object.entries(value).map(([key, item]) => [
      key,
      withUndefinedNoise(item, rand),
    ]);
    const noise = Math.floor(rand() * 3);
    for (let i = 0; i < noise; i += 1) {
      const key = `absent_${String(i)}`;
      if (!Object.prototype.hasOwnProperty.call(value, key))
        entries.push([key, undefined]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

/** JSON values only — the accepted domain of canonicalJson. */
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { maxDepth: 4 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000, max: 1_000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie('value'), {
      maxKeys: 5,
    }),
  ),
})).value as Arbitrary<JsonValue>;

/** Independent oracle: structural equality that does not use canonicalJson. */
function structurallyEqual(a: JsonValue, b: JsonValue): boolean {
  try {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(a)) as unknown,
      JSON.parse(JSON.stringify(b)) as unknown,
    );
    return true;
  } catch {
    return false;
  }
}

// --- shape of the output -----------------------------------------------------

test('cc-e7 object keys are sorted recursively and nothing is padded', () => {
  const out = canonicalJson({ b: 1, a: { d: [3, 2], c: 2 }, A: true });
  assert.equal(out, '{"A":true,"a":{"c":2,"d":[3,2]},"b":1}');
  assert.ok(!/\s/.test(out), 'canonical output contains no whitespace');
});

test('cc-e7 array order is data and is preserved', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('cc-e7 empty containers and nesting', () => {
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({ a: [{}, []] }), '{"a":[{},[]]}');
});

test('cc-e7 keys sort by utf-16 code unit, never by locale', () => {
  // Under a locale collation "a" would sort before "B"; code-unit order does not.
  assert.equal(canonicalJson({ a: 1, B: 2, '': 3 }), '{"":3,"B":2,"a":1}');
});

// --- absent ≡ undefined ≡ omitted -------------------------------------------

test('cc-e7 absent, undefined and omitted properties are byte-identical', () => {
  const omitted = canonicalJson({ a: 1 });
  assert.equal(canonicalJson({ a: 1, b: undefined }), omitted);
  assert.equal(canonicalJson(JSON.parse('{"a":1}') as unknown), omitted);
  assert.equal(canonicalJson({ b: undefined, a: 1, c: undefined }), omitted);
  assert.equal(canonicalJson({ x: undefined }), canonicalJson({}));
  assert.equal(canonicalJson({ a: { b: undefined } }), canonicalJson({ a: {} }));
});

test('cc-e7 null is a value, not an absent property', () => {
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({ a: undefined }));
});

test('cc-e7 undefined has no representation outside an object property', () => {
  assert.throws(() => canonicalJson(undefined), TypeError);
  assert.throws(() => canonicalJson([undefined]), /undefined at \$\[0\]/);

  const sparse = new Array<number>(3);
  sparse[0] = 1;
  sparse[2] = 3;
  assert.throws(() => canonicalJson(sparse), /array hole at \$\[1\]/);
});

// --- numbers -----------------------------------------------------------------

test('cc-e7 negative zero and zero are one payload', () => {
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.equal(canonicalJson(-0), canonicalJson(0));
});

test('cc-e7 numbers use the shortest round-tripping form', () => {
  assert.equal(canonicalJson([1, 1.5, -2, 1e21, 1e-7, 0.1]), '[1,1.5,-2,1e+21,1e-7,0.1]');
  assert.equal(JSON.parse(canonicalJson(0.1)) as unknown, 0.1);
});

test('cc-e7 non-finite numbers are rejected instead of collapsing to null', () => {
  assert.throws(() => canonicalJson(Number.NaN), /non-finite number NaN at \$/);
  assert.throws(
    () => canonicalJson({ a: Infinity }),
    /non-finite number Infinity at \$\.a/,
  );
  assert.throws(() => canonicalJson([-Infinity]), /non-finite number -Infinity/);
});

// --- strings -----------------------------------------------------------------

test('cc-e7 strings keep their exact code points and escape only what json requires', () => {
  assert.equal(canonicalJson('a"b\\c\n'), '"a\\"b\\\\c\\n"');
  assert.equal(canonicalJson('\u00e9\u{1f600}'), '"\u00e9\u{1f600}"');
  // Lone surrogate: escaped, so the output is always encodable as UTF-8.
  assert.equal(canonicalJson('\ud800'), '"\\ud800"');
  assert.equal(canonicalJson('\u0000'), '"\\u0000"');
});

test('cc-e7 unicode normalization is never applied', () => {
  // Precomposed NFC vs decomposed NFD are distinct payloads.
  assert.notEqual(canonicalJson('\u00e9'), canonicalJson('e\u0301'));
});

// --- rejected values ---------------------------------------------------------

test('cc-e7 values that would silently collide are rejected', () => {
  assert.throws(() => canonicalJson(10n), /a bigint value at \$/);
  assert.throws(() => canonicalJson({ a: Symbol('s') }), /a symbol value at \$\.a/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /a function value at \$\.a/);
  assert.throws(() => canonicalJson(new Date(0)), /non-plain object \(Date\) at \$/);
  assert.throws(() => canonicalJson(new Map([['a', 1]])), /non-plain object \(Map\)/);
  assert.throws(() => canonicalJson(new Set([1])), /non-plain object \(Set\)/);
  assert.throws(() => canonicalJson(/re/), /non-plain object \(RegExp\)/);
  assert.throws(() => canonicalJson(new Error('boom')), /non-plain object \(Error\)/);
  assert.throws(
    () => canonicalJson(new Uint8Array([1])),
    /non-plain object \(Uint8Array\)/,
  );
  const oddPrototype = Object.create(null) as object;
  assert.throws(() => canonicalJson(Object.create(oddPrototype)), /unknown prototype/);
});

test('cc-e7 class instances and toJSON never masquerade as plain objects', () => {
  class Payload {
    readonly a = 1;
    toJSON(): unknown {
      return { a: 1 };
    }
  }
  assert.throws(() => canonicalJson(new Payload()), /non-plain object \(Payload\)/);
  // A plain object carrying a toJSON hook is rejected as well: the hook is
  // never consulted, so it cannot rewrite what gets digested.
  assert.throws(
    () => canonicalJson({ a: 1, toJSON: () => ({ b: 2 }) }),
    /a function value at \$\.toJSON/,
  );
});

test('cc-e7 symbol-keyed properties reject the whole object', () => {
  const value = { a: 1, [Symbol('hidden')]: 2 };
  assert.throws(() => canonicalJson(value), /symbol-keyed properties at \$/);
});

test('cc-e7 cycles are rejected but shared acyclic references are not', () => {
  const shared = { a: 1 };
  assert.equal(canonicalJson({ x: shared, y: shared }), '{"x":{"a":1},"y":{"a":1}}');

  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic['self'] = cyclic;
  assert.throws(() => canonicalJson(cyclic), /circular reference at \$\.self/);

  const list: unknown[] = [];
  list.push(list);
  assert.throws(() => canonicalJson(list), /circular reference at \$\[0\]/);
});

test('cc-e7 null-prototype objects are plain and prototype-shaped keys are ordinary', () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare['b'] = 1;
  bare['a'] = 2;
  assert.equal(canonicalJson(bare), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson({ ['__proto__']: 1, constructor: 2 }),
    '{"__proto__":1,"constructor":2}',
  );
});

test('cc-e7 deep nesting is canonicalized at every level', () => {
  let value: JsonValue = 0;
  for (let i = 0; i < 200; i += 1) value = { b: value, a: i };
  const out = canonicalJson(value);
  assert.equal(canonicalJson(JSON.parse(out) as JsonValue), out);
});

// --- properties --------------------------------------------------------------

test('cc-e7 property: key order never changes the canonical form', () => {
  fc.assert(
    fc.property(jsonValue, fc.integer(), (value, seed) => {
      const shuffled = shuffleKeysDeep(value, makeRng(seed));
      assert.equal(canonicalJson(shuffled), canonicalJson(value));
    }),
  );
});

test('cc-e7 property: undefined-valued properties never change the canonical form', () => {
  fc.assert(
    fc.property(jsonValue, fc.integer(), (value, seed) => {
      const noisy = withUndefinedNoise(value, makeRng(seed));
      assert.equal(canonicalJson(noisy), canonicalJson(value));
    }),
  );
});

test('cc-e7 property: the canonical form is valid json and is a fixed point', () => {
  fc.assert(
    fc.property(jsonValue, (value) => {
      const once = canonicalJson(value);
      const twice = canonicalJson(JSON.parse(once) as JsonValue);
      assert.equal(twice, once);
    }),
  );
});

test('cc-e7 property: canonical forms agree with structural equality', () => {
  fc.assert(
    fc.property(jsonValue, jsonValue, (a, b) => {
      assert.equal(canonicalJson(a) === canonicalJson(b), structurallyEqual(a, b));
    }),
  );
});

test('cc-e7 property: the digest is stable 64-char lowercase hex over the canonical form', () => {
  fc.assert(
    fc.property(jsonValue, fc.integer(), (value, seed) => {
      const digest = sha256Hex(canonicalJson(value));
      assert.match(digest, /^[0-9a-f]{64}$/);
      assert.equal(
        sha256Hex(canonicalJson(shuffleKeysDeep(value, makeRng(seed)))),
        digest,
      );
    }),
  );
});

// --- sha256Hex ---------------------------------------------------------------

test('cc-e7 sha256Hex matches the pinned NIST vectors', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('cc-e7 sha256Hex hashes strings as utf-8 bytes', () => {
  assert.equal(sha256Hex('é'), sha256Hex(new Uint8Array([0xc3, 0xa9])));
  const view = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]).subarray(1, 4);
  assert.equal(sha256Hex(view), sha256Hex('abc'));
});

test('cc-e7 the digest changes with any payload change', () => {
  const base = {
    post_info: { title: 'hello', privacy_level: 'SELF_ONLY' },
    source: 'PULL',
  };
  const digest = sha256Hex(canonicalJson(base));
  const reordered = {
    source: 'PULL',
    post_info: { privacy_level: 'SELF_ONLY', title: 'hello' },
  };
  assert.equal(sha256Hex(canonicalJson(reordered)), digest);
  const mutated = { ...base, post_info: { ...base.post_info, title: 'hellO' } };
  assert.notEqual(sha256Hex(canonicalJson(mutated)), digest);
});
