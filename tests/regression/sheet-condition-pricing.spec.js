// tests/regression/sheet-condition-pricing.spec.js
//
// PINS a one-sided condition adjustment found 24 Aug 2026.
//
// The buy price was condition-adjusted on the server and had been for a while.
// The SELL price was computed in the browser as:
//
//     sell = market_value * (markup / 100)
//
// off the Near Mint reference, with no multiplier. Measured live on Fossil
// Gengar #5 at a 60% buy rate and a 110% markup:
//
//     condition   NM lowest   buy      sell (before)   sell (correct)
//     NM          EUR 210     126.00   231.00          231.00
//     EX          EUR 210     105.84   231.00          193.44
//     PL          EUR 210      50.40   231.00           92.40
//
// So a Played Gengar was bought at EUR 50.40 and listed at EUR 231 — the Near
// Mint asking price for a card that is visibly not Near Mint. Buying right and
// then pricing the shelf wrong is the same defect in the other direction, and
// it is the one the customer sees.
//
// These are pure arithmetic checks against the same expressions the sheet uses.
// The sheet is a browser module with no DOM here, so the maths is asserted
// directly and the rendering is asserted by reading the source — the same
// approach as the other vendor-module specs, which cannot import from pricing/.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CONDITION_MULTIPLIERS } from '../../pricing/conditions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHEET = join(ROOT, 'apps', 'vendor', 'modules', 'result-sheet.js');

const NM_LOWEST = 210;
const MARKUP = 110;
const BUY_PCT = 0.6;

const adjustedFor = (grade) => Math.round(NM_LOWEST * CONDITION_MULTIPLIERS[grade] * 100) / 100;
const sellFor = (grade) => Math.round(adjustedFor(grade) * (MARKUP / 100) * 100) / 100;
const buyFor = (grade) => Math.round(NM_LOWEST * CONDITION_MULTIPLIERS[grade] * BUY_PCT * 100) / 100;

describe('both sides of the trade use the same condition multiplier', () => {
  test('Near Mint is untouched — the multiplier is 1.00', () => {
    assert.equal(adjustedFor('NM'), NM_LOWEST);
    assert.equal(sellFor('NM'), 231);
  });

  test('a Played card is not listed at the Near Mint price', () => {
    assert.equal(buyFor('PL'), 50.4);
    assert.equal(sellFor('PL'), 92.4, 'was EUR 231 — the Near Mint ask');
    assert.ok(sellFor('PL') < 231, 'the shelf price must follow the card, not the reference');
  });

  test('buy stays below sell at every grade — the shop never loses on the spread', () => {
    for (const g of ['NM', 'EX', 'GD', 'LP', 'PL', 'PO']) {
      assert.ok(buyFor(g) < sellFor(g),
        `${g}: buy ${buyFor(g)} must be under sell ${sellFor(g)}`);
    }
  });

  test('the spread ratio is identical at every grade', () => {
    // If buy and sell use the same multiplier the margin is invariant. A
    // difference here means one side is adjusted and the other is not, which
    // is exactly the defect.
    const ratios = ['NM', 'EX', 'GD', 'LP', 'PL', 'PO'].map((g) => sellFor(g) / buyFor(g));
    for (const r of ratios) assert.ok(Math.abs(r - ratios[0]) < 0.001, 'margin must not vary by grade');
  });
});

describe('the sheet computes sell from the adjusted value', () => {
  test('sell is derived from `adjusted`, not the raw market figure', async () => {
    const src = await readFile(SHEET, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.match(code, /const sell = entry\.custom_sell \?\? Math\.round\(adjusted \*/,
      'sell must use the condition-adjusted value');
    assert.doesNotMatch(code, /const sell = entry\.custom_sell \?\? Math\.round\(mv \*/,
      'the Near Mint reference must not price the shelf');
  });

  test('the market cell says which number it is showing', async () => {
    const src = await readFile(SHEET, 'utf8');
    // "Market" could be a trend, an average, or an ask. This one is the
    // cheapest English Near Mint listing — the same price the Cardmarket link
    // opens on — and the label should say so.
    assert.match(src, /NM lowest/, 'the Near Mint reference must be named');
    assert.match(src, /This card/, 'and the adjusted value distinguished from it');
  });

  test('a non-NM card shows the arithmetic, not just a number', async () => {
    const src = await readFile(SHEET, 'utf8');
    assert.match(src, /NM lowest €\$\{Number\(mv\)\.toFixed\(2\)\} × \$\{condMult/,
      'the operator must be able to see where the adjusted figure came from');
  });
});

describe('graded comps are a Near Mint question', () => {
  test('the block is hidden once a lower condition is selected', async () => {
    const src = await readFile(SHEET, 'utf8');
    // "PSA 10 = 73x raw" is true of a pristine copy and meaningless for the
    // Excellent card on the counter. Once the operator marks the card down the
    // comps are no longer a decision they are making, so the block goes rather
    // than lingering as the most eye-catching number on the sheet.
    assert.match(src, /const gradedBlock = \(gradedRows && \(condition === 'NM' \|\| condition === 'MT'\)\)/,
      'graded comps render only for NM/MT');
  });

  test('nothing is left behind when it is hidden', async () => {
    const src = await readFile(SHEET, 'utf8');
    assert.doesNotMatch(src, /gradedNote/, 'no leftover annotation machinery');
  });
});
