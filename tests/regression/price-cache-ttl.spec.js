// RG-12: priceCache TTL (60-min). The TTL constant is 1 hour; entries past their TTL must not be returned.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRICE_CACHE_TTL_MS,
  priceCacheKey,
  priceCacheGet,
  priceCacheSet,
  _testGetEntryTs,
  _testSetEntryTs,
} from '../../pricing/price.js';

// ---------------------------------------------------------------------------
// RG-12a: TTL constant pinned at exactly 60 minutes
// ---------------------------------------------------------------------------

test('RG-12: PRICE_CACHE_TTL_MS is exactly 60 * 60 * 1000 (3 600 000 ms)', () => {
  assert.strictEqual(PRICE_CACHE_TTL_MS, 60 * 60 * 1000,
    'TTL must be 3600000 ms — any other value is a regression');
});

// ---------------------------------------------------------------------------
// RG-12b: priceCacheKey shape — all 8 dimensions must appear in the key
// ---------------------------------------------------------------------------

test('RG-12: priceCacheKey encodes all 8 dimensions (game|name|set|num|cond|variant|graded|buy%)', () => {
  const card = {
    game: 'pokemon',
    name: 'Pikachu',
    set_code: 'mew',
    card_number: '058',
    condition_estimate: 'LP',
    variant: 'holo',
    graded: { company: 'PSA', grade: 10 },
  };
  const key = priceCacheKey(card, 0.6);

  // All eight pipe-delimited segments must be present.
  const parts = key.split('|');
  assert.strictEqual(parts.length, 8, `key must have 8 pipe-delimited segments, got ${parts.length}: "${key}"`);

  assert.strictEqual(parts[0], 'pokemon',   'segment 0: game');
  assert.strictEqual(parts[1], 'pikachu',   'segment 1: name (lowercased)');
  assert.strictEqual(parts[2], 'MEW',       'segment 2: set_code (uppercased)');
  assert.strictEqual(parts[3], '058',       'segment 3: card_number');
  assert.strictEqual(parts[4], 'LP',        'segment 4: condition_estimate');
  assert.strictEqual(parts[5], 'holo',      'segment 5: variant');
  assert.strictEqual(parts[6], 'PSA-10',    'segment 6: graded compound (company-grade)');
  assert.strictEqual(parts[7], '0.6',       'segment 7: buyPercentage');
});

test('RG-12: priceCacheKey uses defaults for missing optional fields', () => {
  const key = priceCacheKey({ name: 'Charizard' }, 0.5);
  const parts = key.split('|');
  assert.strictEqual(parts.length, 8, 'must still produce 8 segments when optional fields are absent');
  assert.strictEqual(parts[4], 'NM',     'condition_estimate defaults to NM');
  assert.strictEqual(parts[5], 'normal', 'variant defaults to normal');
  assert.strictEqual(parts[6], '',       'graded segment is empty when graded is absent');
});

// ---------------------------------------------------------------------------
// RG-12c: set + immediate get returns the stored value (sanity)
// ---------------------------------------------------------------------------

test('RG-12: priceCacheSet then priceCacheGet returns the stored value immediately', () => {
  const key = priceCacheKey({ game: 'magic', name: 'Black Lotus', set_code: 'LEA', card_number: '232' }, 0.6);
  const payload = { cardmarket: { price: 9999 } };

  priceCacheSet(key, payload);
  const result = priceCacheGet(key);

  assert.deepStrictEqual(result, payload,
    'priceCacheGet must return the exact payload stored by priceCacheSet on an immediate read');
});

// ---------------------------------------------------------------------------
// RG-12d: timestamp recorded on priceCacheSet
// ---------------------------------------------------------------------------

test('RG-12: priceCacheSet records a timestamp close to Date.now()', () => {
  const key = priceCacheKey({ game: 'lorcana', name: 'Elsa', set_code: 'TFC', card_number: '001' }, 0.6);
  const before = Date.now();
  priceCacheSet(key, { price: 5 });
  const after = Date.now();

  const ts = _testGetEntryTs(key);
  assert.ok(ts !== null, '_testGetEntryTs must return the timestamp written by priceCacheSet');
  assert.ok(ts >= before && ts <= after,
    `entry timestamp (${ts}) must be between ${before} and ${after}`);
});

// ---------------------------------------------------------------------------
// RG-12e: backdated entry → cache miss (expiry behavior)
// ---------------------------------------------------------------------------

test('RG-12: entry older than PRICE_CACHE_TTL_MS is treated as a cache miss', () => {
  const key = priceCacheKey({ game: 'yugioh', name: 'Blue-Eyes', set_code: 'SDK', card_number: '001' }, 0.6);
  priceCacheSet(key, { price: 25 });

  // Backdate the entry's timestamp to exactly TTL + 1 ms ago.
  const expiredTs = Date.now() - PRICE_CACHE_TTL_MS - 1;
  _testSetEntryTs(key, expiredTs);

  const result = priceCacheGet(key);
  assert.strictEqual(result, null,
    'priceCacheGet must return null for an entry whose timestamp is older than PRICE_CACHE_TTL_MS');
});

// ---------------------------------------------------------------------------
// RG-12f: entry within TTL → cache hit
// ---------------------------------------------------------------------------

test('RG-12: entry within PRICE_CACHE_TTL_MS is still a cache hit', () => {
  const key = priceCacheKey({ game: 'swu', name: 'Luke Skywalker', set_code: 'SOR', card_number: '001' }, 0.6);
  const payload = { price: 12 };
  priceCacheSet(key, payload);

  // Set timestamp to exactly TTL - 1 ms ago (still within window).
  const freshTs = Date.now() - PRICE_CACHE_TTL_MS + 1;
  _testSetEntryTs(key, freshTs);

  const result = priceCacheGet(key);
  assert.deepStrictEqual(result, payload,
    'priceCacheGet must return the value when the entry timestamp is within PRICE_CACHE_TTL_MS');
});
