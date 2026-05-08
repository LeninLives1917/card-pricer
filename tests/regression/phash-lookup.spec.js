// Regression: perceptual hash index lookup — pricing/phash.js#lookupByPhash
//
// Locks down the lookup contract described in docs/design/phash-lookup.md:
//   lookupByPhash(hash: bigint, threshold: number): { card, distance } | null
//
// The module keeps internal state (_index = Map<bigint, card>). These tests
// need to seed and reset that state without hitting disk or the network.
//
// IMPLEMENTER NOTE — required test hook:
//   Export `__seedIndex(entries)` and `__resetIndex()` from pricing/phash.js:
//
//     export function __seedIndex(entries) {
//       // entries: Array<{ hash: bigint, card: { set_id, number } }>
//       for (const { hash, card } of entries) _index.set(hash, card);
//     }
//     export function __resetIndex() { _index.clear(); }
//
//   These hooks are test-only (underscore-prefixed convention matches
//   _refImagePromise etc. in this codebase). They avoid disk I/O and the
//   addToIndex debounce timer during unit testing.
//
//   If neither hook nor addToIndex-with-path-override is available, this
//   file will fail to import or will skip affected tests — the spec is the
//   contract; do not stub the module to make tests pass without the real
//   implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lookupByPhash, __seedIndex, __resetIndex } from '../../pricing/phash.js';

// ── Hamming distance helper ───────────────────────────────────────────────

function hamming(a, b) {
  let x = a ^ b;
  let c = 0n;
  while (x) {
    c += x & 1n;
    x >>= 1n;
  }
  return Number(c);
}

// ── Bit-manipulation helpers for constructing test hashes ────────────────

// Flip exactly `n` bits in `hash` at deterministic positions (LSBs first).
// Returns a new BigInt that differs from hash by exactly n bits.
function flipBits(hash, n) {
  let mask = 0n;
  for (let i = 0; i < n; i++) {
    mask |= (1n << BigInt(i));
  }
  return hash ^ mask;
}

// A stable base hash used across tests — picked to sit well away from 0/max
// so that flipBits(base, k) never accidentally wraps past 64 bits.
const BASE_HASH = 0xDEADBEEFCAFEBABEn;

const CARD_A = { set_id: 'sv3pt5', number: '197' };
const CARD_B = { set_id: 'base1',  number: '4'   };
const CARD_C = { set_id: 'cel25c', number: '016' };

// ── Reset between tests ──────────────────────────────────────────────────
// node:test does not have beforeEach; we reset inside each test instead.

// ── Hit case ──────────────────────────────────────────────────────────────

test('hit case: exact hash match returns card with distance 0', () => {
  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(BASE_HASH, 8);

  assert.notStrictEqual(result, null, 'expected a hit, got null');
  assert.deepStrictEqual(result.card, CARD_A);
  assert.strictEqual(result.distance, 0);
});

test('hit case: exact match on a second seeded entry returns the right card', () => {
  const hash2 = 0x0123456789ABCDEFn;
  __resetIndex();
  __seedIndex([
    { hash: BASE_HASH, card: CARD_A },
    { hash: hash2,     card: CARD_B },
  ]);

  const result = lookupByPhash(hash2, 8);

  assert.notStrictEqual(result, null);
  assert.deepStrictEqual(result.card, CARD_B);
  assert.strictEqual(result.distance, 0);
});

// ── Near-hit within threshold ─────────────────────────────────────────────

test('near-hit: hash differing by 5 bits, threshold 8 → hit with distance 5', () => {
  const queryHash = flipBits(BASE_HASH, 5);
  assert.strictEqual(hamming(BASE_HASH, queryHash), 5, 'test setup: expected 5-bit delta');

  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(queryHash, 8);

  assert.notStrictEqual(result, null, 'expected a hit at distance 5 with threshold 8');
  assert.deepStrictEqual(result.card, CARD_A);
  assert.strictEqual(result.distance, 5);
});

test('near-hit: hash differing by 1 bit, threshold 8 → hit with distance 1', () => {
  const queryHash = flipBits(BASE_HASH, 1);
  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(queryHash, 8);

  assert.notStrictEqual(result, null);
  assert.strictEqual(result.distance, 1);
});

// ── Miss case ─────────────────────────────────────────────────────────────

test('miss case: query with high Hamming distance from all seeded entries returns null', () => {
  // BASE_HASH XOR 0xFFFFFFFFFFFFFFFF flips all 64 bits → distance 64.
  const farAwayHash = BASE_HASH ^ 0xFFFFFFFFFFFFFFFFn;
  assert.ok(hamming(BASE_HASH, farAwayHash) >= 50, 'test setup: expected far hash');

  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(farAwayHash, 8);

  assert.strictEqual(result, null, `expected null, got ${JSON.stringify(result)}`);
});

test('miss case: empty index always returns null', () => {
  __resetIndex();

  assert.strictEqual(lookupByPhash(BASE_HASH, 8), null);
  assert.strictEqual(lookupByPhash(0n, 8), null);
  assert.strictEqual(lookupByPhash(0xFFFFFFFFFFFFFFFFn, 8), null);
});

// ── Threshold edge cases ──────────────────────────────────────────────────
//
// Design spec: "distance ≤ threshold" is the inclusive hit condition.

test('threshold edge: distance == threshold (8) → HIT', () => {
  const queryHash = flipBits(BASE_HASH, 8);
  assert.strictEqual(hamming(BASE_HASH, queryHash), 8, 'test setup: expected exactly 8-bit delta');

  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(queryHash, 8);

  assert.notStrictEqual(result, null,
    'distance == threshold must be a HIT (inclusive ≤)');
  assert.strictEqual(result.distance, 8);
});

test('threshold edge: distance == threshold+1 (9) → MISS', () => {
  const queryHash = flipBits(BASE_HASH, 9);
  assert.strictEqual(hamming(BASE_HASH, queryHash), 9, 'test setup: expected exactly 9-bit delta');

  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(queryHash, 8);

  assert.strictEqual(result, null,
    'distance == threshold+1 must be a MISS');
});

test('threshold edge: threshold 0 → only exact match hits', () => {
  const queryAtDistance1 = flipBits(BASE_HASH, 1);
  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  // Exact match still hits.
  const hit = lookupByPhash(BASE_HASH, 0);
  assert.notStrictEqual(hit, null, 'exact match must hit even at threshold 0');
  assert.strictEqual(hit.distance, 0);

  // Distance-1 misses.
  const miss = lookupByPhash(queryAtDistance1, 0);
  assert.strictEqual(miss, null, 'distance 1 must miss at threshold 0');
});

test('threshold edge: varying threshold changes hit/miss boundary on the same query', () => {
  // Use a fixed index hash and a query 5 bits away.
  // threshold=4 → miss; threshold=5 → hit; threshold=6 → hit.
  const queryHash = flipBits(BASE_HASH, 5);
  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  assert.strictEqual(lookupByPhash(queryHash, 4), null, 'threshold 4 should miss at distance 5');
  assert.notStrictEqual(lookupByPhash(queryHash, 5), null, 'threshold 5 should hit at distance 5');
  assert.notStrictEqual(lookupByPhash(queryHash, 6), null, 'threshold 6 should hit at distance 5');
});

// ── Min-distance preference ───────────────────────────────────────────────
//
// When multiple index entries fall within threshold, lookupByPhash must
// return the one with the smallest Hamming distance.

test('min-distance: two entries within threshold, closer one wins', () => {
  // H1 is 3 bits from query; H2 is 7 bits from query.
  // Both are within threshold=8. Expect H1 / CARD_A with distance 3.
  const query  = BASE_HASH;
  const indexH1 = flipBits(BASE_HASH, 3); // stored hash, 3 bits away from query
  const indexH2 = flipBits(BASE_HASH, 7); // stored hash, 7 bits away from query

  // Sanity-check the test geometry.
  assert.strictEqual(hamming(query, indexH1), 3, 'test setup: H1 should be 3 bits from query');
  assert.strictEqual(hamming(query, indexH2), 7, 'test setup: H2 should be 7 bits from query');

  __resetIndex();
  __seedIndex([
    { hash: indexH1, card: CARD_A },
    { hash: indexH2, card: CARD_B },
  ]);

  const result = lookupByPhash(query, 8);

  assert.notStrictEqual(result, null);
  assert.deepStrictEqual(result.card, CARD_A,
    `expected CARD_A (distance 3), got ${JSON.stringify(result.card)}`);
  assert.strictEqual(result.distance, 3);
});

test('min-distance: three entries, only two within threshold, closest returned', () => {
  const query   = BASE_HASH;
  const indexH1 = flipBits(BASE_HASH, 2);  // distance 2 — closest
  const indexH2 = flipBits(BASE_HASH, 6);  // distance 6 — within threshold
  const indexH3 = flipBits(BASE_HASH, 10); // distance 10 — outside threshold=8

  __resetIndex();
  __seedIndex([
    { hash: indexH1, card: CARD_A },
    { hash: indexH2, card: CARD_B },
    { hash: indexH3, card: CARD_C },
  ]);

  const result = lookupByPhash(query, 8);

  assert.notStrictEqual(result, null);
  assert.deepStrictEqual(result.card, CARD_A,
    `expected CARD_A (distance 2), got ${JSON.stringify(result.card)}`);
  assert.strictEqual(result.distance, 2);
});

test('min-distance: insertion order does not affect which card wins', () => {
  // Seed H2 (distance 7) before H1 (distance 3); result should still be H1.
  const query   = BASE_HASH;
  const indexH1 = flipBits(BASE_HASH, 3);
  const indexH2 = flipBits(BASE_HASH, 7);

  __resetIndex();
  __seedIndex([
    { hash: indexH2, card: CARD_B }, // seeded first this time
    { hash: indexH1, card: CARD_A },
  ]);

  const result = lookupByPhash(query, 8);

  assert.notStrictEqual(result, null);
  assert.deepStrictEqual(result.card, CARD_A,
    'min-distance winner must not depend on insertion order');
  assert.strictEqual(result.distance, 3);
});

// ── Edge / defensive cases ────────────────────────────────────────────────

test('lookupByPhash: threshold 64 matches everything in the index', () => {
  // Even a hash with all 64 bits flipped should hit.
  const farHash = BASE_HASH ^ 0xFFFFFFFFFFFFFFFFn;
  __resetIndex();
  __seedIndex([{ hash: BASE_HASH, card: CARD_A }]);

  const result = lookupByPhash(farHash, 64);

  assert.notStrictEqual(result, null,
    'threshold 64 should hit any hash in the index');
  assert.strictEqual(result.distance, 64);
});

test('lookupByPhash: index with many entries returns the global minimum-distance card', () => {
  // Seed 10 entries at Hamming distances 1–10 from BASE_HASH.
  // Each entry uses a non-overlapping bit bucket so distances are exact.
  //
  // Bucket formula: for distance d, flip the d bits starting at bit d*(d-1)/2.
  //   d=1:  bit  0        (1 bit  → distance 1)
  //   d=2:  bits 1-2      (2 bits → distance 2)
  //   d=3:  bits 3-5      (3 bits → distance 3)
  //   ...
  //   d=10: bits 45-54    (10 bits → distance 10)
  // Total bits used: 55 ≤ 64. No overlap. All positions 0-54 are within range.
  const entries = [];
  for (let d = 10; d >= 1; d--) {
    const startBit = d * (d - 1) / 2;
    let mask = 0n;
    for (let i = 0; i < d; i++) {
      mask |= (1n << BigInt(startBit + i));
    }
    const indexedHash = BASE_HASH ^ mask;
    entries.push({ hash: indexedHash, card: { set_id: `sv${d}`, number: `${d}` } });
  }

  __resetIndex();
  __seedIndex(entries);

  const result = lookupByPhash(BASE_HASH, 15);

  assert.notStrictEqual(result, null);
  assert.strictEqual(result.distance, 1, `expected min distance 1, got ${result.distance}`);
  assert.strictEqual(result.card.number, '1');
});
