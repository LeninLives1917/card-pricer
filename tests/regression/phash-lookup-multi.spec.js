// Regression: multi-hash index lookup — pricing/phash.js#lookupByHashes
//
// Locks down the new lookupByHashes() contract:
//   lookupByHashes({ phash, dhash, whash }, threshold)
//     → { card, distance, hashType } | null
//
// Also covers addToIndex() accepting the new object form, and the
// __seedIndexByType() test hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookupByHashes,
  addToIndex,
  __seedIndexByType,
  __resetIndex,
} from '../../pricing/phash.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function flipBits(hash, n) {
  let mask = 0n;
  for (let i = 0; i < n; i++) mask |= (1n << BigInt(i));
  return hash ^ mask;
}

const BASE_A = 0xDEADBEEFCAFEBABEn;
const BASE_B = 0x0123456789ABCDEFn;
const BASE_C = 0xFEDCBA9876543210n;

const CARD_A = { set_id: 'sv3pt5', number: '197' };
const CARD_B = { set_id: 'base1',  number: '4'   };

// ── lookupByHashes: miss on empty index ───────────────────────────────────

test('lookupByHashes: empty index → null', () => {
  __resetIndex();
  const result = lookupByHashes(
    { phash: BASE_A, dhash: BASE_B, whash: BASE_C },
    8
  );
  assert.strictEqual(result, null);
});

// ── lookupByHashes: hit on phash index ───────────────────────────────────

test('lookupByHashes: exact phash match → hit with distance 0, hashType phash', () => {
  __resetIndex();
  __seedIndexByType('phash', [{ hash: BASE_A, card: CARD_A }]);

  const result = lookupByHashes({ phash: BASE_A, dhash: BASE_B, whash: BASE_C }, 8);

  assert.notStrictEqual(result, null, 'expected a hit');
  assert.deepStrictEqual(result.card, CARD_A);
  assert.strictEqual(result.distance, 0);
  assert.strictEqual(result.hashType, 'phash');
});

// ── lookupByHashes: hit on dhash index ───────────────────────────────────

test('lookupByHashes: exact dhash match → hit with distance 0, hashType dhash', () => {
  __resetIndex();
  __seedIndexByType('dhash', [{ hash: BASE_B, card: CARD_A }]);

  // phash and whash don't match anything
  const result = lookupByHashes({ phash: BASE_A, dhash: BASE_B, whash: BASE_C }, 8);

  assert.notStrictEqual(result, null);
  assert.deepStrictEqual(result.card, CARD_A);
  assert.strictEqual(result.distance, 0);
  assert.strictEqual(result.hashType, 'dhash');
});

// ── lookupByHashes: hit on whash index ───────────────────────────────────

test('lookupByHashes: exact whash match → hit with distance 0, hashType whash', () => {
  __resetIndex();
  __seedIndexByType('whash', [{ hash: BASE_C, card: CARD_A }]);

  const result = lookupByHashes({ phash: BASE_A, dhash: BASE_B, whash: BASE_C }, 8);

  assert.notStrictEqual(result, null);
  assert.deepStrictEqual(result.card, CARD_A);
  assert.strictEqual(result.distance, 0);
  assert.strictEqual(result.hashType, 'whash');
});

// ── lookupByHashes: near-hit within threshold ────────────────────────────

test('lookupByHashes: phash 5 bits away, threshold 8 → hit distance 5', () => {
  __resetIndex();
  __seedIndexByType('phash', [{ hash: BASE_A, card: CARD_A }]);

  const queryPhash = flipBits(BASE_A, 5);
  const result = lookupByHashes({ phash: queryPhash, dhash: BASE_B, whash: BASE_C }, 8);

  assert.notStrictEqual(result, null);
  assert.strictEqual(result.distance, 5);
  assert.strictEqual(result.hashType, 'phash');
});

// ── lookupByHashes: threshold boundary ───────────────────────────────────

test('lookupByHashes: distance == threshold → hit', () => {
  __resetIndex();
  __seedIndexByType('dhash', [{ hash: BASE_B, card: CARD_A }]);

  const queryDhash = flipBits(BASE_B, 8);
  const result = lookupByHashes({ phash: BASE_A, dhash: queryDhash, whash: BASE_C }, 8);

  assert.notStrictEqual(result, null, 'distance == threshold must hit');
  assert.strictEqual(result.distance, 8);
});

test('lookupByHashes: distance == threshold+1 → miss', () => {
  __resetIndex();
  __seedIndexByType('dhash', [{ hash: BASE_B, card: CARD_A }]);

  const queryDhash = flipBits(BASE_B, 9);
  const result = lookupByHashes({ phash: BASE_A, dhash: queryDhash, whash: BASE_C }, 8);

  assert.strictEqual(result, null, 'distance threshold+1 must miss');
});

// ── lookupByHashes: best across all indexes ───────────────────────────────
//
// phash is 7 bits away, whash is 3 bits away — whash wins.

test('lookupByHashes: whash closer than phash → whash wins', () => {
  __resetIndex();
  __seedIndexByType('phash', [{ hash: BASE_A,                  card: CARD_A }]);
  __seedIndexByType('whash', [{ hash: flipBits(BASE_C, 3), card: CARD_A }]);

  const result = lookupByHashes(
    { phash: flipBits(BASE_A, 7), dhash: BASE_B, whash: BASE_C },
    8
  );

  assert.notStrictEqual(result, null);
  assert.strictEqual(result.distance, 3, `expected whash distance 3, got ${result.distance}`);
  assert.strictEqual(result.hashType, 'whash');
});

// ── lookupByHashes: null hash values are skipped ─────────────────────────

test('lookupByHashes: null hash values for dhash/whash skipped gracefully', () => {
  __resetIndex();
  __seedIndexByType('phash', [{ hash: BASE_A, card: CARD_A }]);

  const result = lookupByHashes({ phash: BASE_A, dhash: null, whash: null }, 8);

  assert.notStrictEqual(result, null, 'should still hit via phash');
  assert.strictEqual(result.hashType, 'phash');
});

// ── addToIndex with object form ───────────────────────────────────────────

test('addToIndex with {phash, dhash, whash} object populates all three indexes', async () => {
  __resetIndex();

  const card = { set_id: 'sv1', number: '23' };
  await addToIndex({ phash: BASE_A, dhash: BASE_B, whash: BASE_C }, card);

  // Each hash type should hit independently.
  const rP = lookupByHashes({ phash: BASE_A, dhash: 0n, whash: 0n }, 0);
  const rD = lookupByHashes({ phash: 0n, dhash: BASE_B, whash: 0n }, 0);
  const rW = lookupByHashes({ phash: 0n, dhash: 0n, whash: BASE_C }, 0);

  assert.notStrictEqual(rP, null, 'phash not indexed');
  assert.notStrictEqual(rD, null, 'dhash not indexed');
  assert.notStrictEqual(rW, null, 'whash not indexed');

  assert.deepStrictEqual(rP.card, card);
  assert.deepStrictEqual(rD.card, card);
  assert.deepStrictEqual(rW.card, card);
});

test('addToIndex with legacy bigint form still populates phash only', async () => {
  __resetIndex();

  const card = { set_id: 'sv1', number: '99' };
  await addToIndex(BASE_A, card);   // legacy form

  const rP = lookupByHashes({ phash: BASE_A, dhash: BASE_B, whash: BASE_C }, 0);
  const rD = lookupByHashes({ phash: 0n, dhash: BASE_B, whash: 0n }, 0);

  assert.notStrictEqual(rP, null, 'phash should be indexed via legacy form');
  assert.strictEqual(rD, null, 'dhash should NOT be indexed via legacy form');
});
