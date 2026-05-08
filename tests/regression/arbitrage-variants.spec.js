// RG-13: arbitrage one-row-per-variant — every variant produces exactly one arbitrage row.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arbitrageVariants } from '../../apps/server/routes/admin.js';

// Variant tokens the function iterates over (verbatim).
const STANDARD_VARIANTS = ['normal', 'holofoil', '1stEditionNormal', '1stEditionHolofoil', 'unlimitedHolofoil'];
const ALL_VARIANTS = [...STANDARD_VARIANTS, 'reverseHolofoil'];

// Minimal CARD_PRICES-shaped entry with all variants populated.
function makeEntry(overrides = {}) {
  return {
    tcg: {
      normal:              { market: 10,  low: 8  },
      holofoil:            { market: 20,  low: 17 },
      '1stEditionNormal':  { market: 30,  low: 26 },
      '1stEditionHolofoil':{ market: 40,  low: 35 },
      unlimitedHolofoil:   { market: 50,  low: 44 },
      reverseHolofoil:     { market: 15,  low: 12 },
    },
    cm: {
      lowPriceExPlus: 5,
      avg7:  4.5,
      avg30: 4.2,
      reverseHoloLow:    6,
      reverseHoloAvg7:   5.5,
      reverseHoloAvg30:  5.1,
    },
    ...overrides,
  };
}

// ── RG-13: all 6 variants → 6 rows ───────────────────────────────────────────

test('RG-13: all 6 variants populated → 6 output rows (5 standard + reverseHolofoil)', () => {
  const entry = makeEntry();
  const rows = arbitrageVariants(entry, 0.92);
  assert.equal(rows.length, 6, `expected 6 rows, got ${rows.length}`);
});

// ── RG-13: one-row-per-variant (no collapsing) ────────────────────────────────

test('RG-13: each known variant produces exactly one row', () => {
  const entry = makeEntry();
  const rows = arbitrageVariants(entry, 0.92);
  for (const token of ALL_VARIANTS) {
    const matching = rows.filter(r => r.variant === token);
    assert.equal(matching.length, 1, `expected exactly 1 row for variant "${token}", got ${matching.length}`);
  }
});

// ── RG-13: sparse input → only rows where data exists ────────────────────────

test('RG-13: only normal + holofoil set → 2 rows, not 5 or 6', () => {
  const entry = {
    tcg: {
      normal:   { market: 10, low: 8 },
      holofoil: { market: 20, low: 17 },
      // 1stEditionNormal, 1stEditionHolofoil, unlimitedHolofoil: undefined
      // reverseHolofoil: undefined
    },
    cm: {
      lowPriceExPlus: 5,
      avg7: 4.5,
      avg30: 4.2,
      // no reverseHolo fields
    },
  };
  const rows = arbitrageVariants(entry, 0.92);
  assert.equal(rows.length, 2, `expected 2 rows, got ${rows.length}`);
  const tokens = rows.map(r => r.variant);
  assert.ok(tokens.includes('normal'),   'must include normal');
  assert.ok(tokens.includes('holofoil'), 'must include holofoil');
});

// ── RG-13: variant-name labeling preserved verbatim ──────────────────────────

test('RG-13: variant field carries verbatim token strings (camelCase, not shape-shifted)', () => {
  const entry = makeEntry();
  const rows = arbitrageVariants(entry, 0.92);
  const tokens = rows.map(r => r.variant);
  // Exact casing as iterated in the source loop — regression pin against
  // any future lower-casing, slugification, or display-name substitution.
  assert.ok(tokens.includes('normal'),               '"normal" token preserved');
  assert.ok(tokens.includes('holofoil'),             '"holofoil" token preserved');
  assert.ok(tokens.includes('1stEditionNormal'),     '"1stEditionNormal" token preserved');
  assert.ok(tokens.includes('1stEditionHolofoil'),   '"1stEditionHolofoil" token preserved');
  assert.ok(tokens.includes('unlimitedHolofoil'),    '"unlimitedHolofoil" token preserved');
  assert.ok(tokens.includes('reverseHolofoil'),      '"reverseHolofoil" token preserved');
});

// ── RG-13: reverseHolofoil uses its own CM price fields ──────────────────────

test('RG-13: reverseHolofoil row uses cm.reverseHoloLow (not cm.lowPriceExPlus)', () => {
  const entry = makeEntry();
  // Set cm prices to distinct values so any cross-wiring is detectable.
  entry.cm.lowPriceExPlus = 5;
  entry.cm.reverseHoloLow = 99;
  const rows = arbitrageVariants(entry, 0.92);
  const rhRow = rows.find(r => r.variant === 'reverseHolofoil');
  assert.ok(rhRow, 'reverseHolofoil row must be present');
  assert.equal(rhRow.eur, 99, 'reverseHolofoil eur must come from cm.reverseHoloLow');
});

test('RG-13: reverseHolofoil absent when cm has no reverseHolo price fields', () => {
  const entry = {
    tcg: {
      normal:          { market: 10, low: 8 },
      reverseHolofoil: { market: 15, low: 12 },
    },
    cm: {
      lowPriceExPlus: 5,
      avg7: 4.5,
      avg30: 4.2,
      // reverseHoloLow and reverseHoloTrend both absent
    },
  };
  const rows = arbitrageVariants(entry, 0.92);
  const rhRow = rows.find(r => r.variant === 'reverseHolofoil');
  assert.equal(rhRow, undefined, 'reverseHolofoil must not appear when cm has no reverse price');
});

// ── RG-13: empty / null input → empty array, no throw ────────────────────────

test('RG-13: null entry → empty array, no throw', () => {
  assert.deepEqual(arbitrageVariants(null, 0.92), []);
});

test('RG-13: entry with no tcg/cm → empty array, no throw', () => {
  assert.deepEqual(arbitrageVariants({}, 0.92), []);
});

test('RG-13: entry with tcg/cm but no variant keys → empty array', () => {
  const entry = { tcg: {}, cm: { lowPriceExPlus: 5 } };
  assert.deepEqual(arbitrageVariants(entry, 0.92), []);
});

// ── RG-13: ratio direction is correct ────────────────────────────────────────

test('RG-13: us_to_eu direction → ratio = eur / usdInEur', () => {
  const entry = {
    tcg: { normal: { market: 10, low: 8 } },
    cm:  { lowPriceExPlus: 12, avg7: 0, avg30: 0 },
  };
  const rate = 0.9;
  const rows = arbitrageVariants(entry, rate, 'us_to_eu');
  assert.equal(rows.length, 1);
  const row = rows[0];
  const expected = +(12 / (10 * 0.9)).toFixed(3);
  assert.equal(+row.ratio.toFixed(3), expected, 'us_to_eu ratio mismatch');
});

test('RG-13: eu_to_us direction → ratio = usdInEur / eur', () => {
  const entry = {
    tcg: { normal: { market: 10, low: 8 } },
    cm:  { lowPriceExPlus: 12, avg7: 0, avg30: 0 },
  };
  const rate = 0.9;
  const rows = arbitrageVariants(entry, rate, 'eu_to_us');
  assert.equal(rows.length, 1);
  const row = rows[0];
  const expected = +((10 * 0.9) / 12).toFixed(3);
  assert.equal(+row.ratio.toFixed(3), expected, 'eu_to_us ratio mismatch');
});
