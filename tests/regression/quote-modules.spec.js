// tests/regression/quote-modules.spec.js
// Author: A5 (S8). Pure-function smoke tests for the customer quote app.
//
// Goal: pin the public contracts of parse-lines / cardmarket-url / totals
// without booting the full DOM. These are the modules the orchestrator
// will reuse if /quote ever grows a Node-side companion (e.g. server-side
// PDF rendering of a saved quote in S12).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLines, MAX_CARDS } from '../../apps/quote/modules/parse-lines.js';
import { buildCardmarketUrl } from '../../apps/quote/modules/cardmarket-url.js';
import {
  calcCardOffers,
  sumTotals,
  formatEur,
  CONDITION_MULTS,
  DEFAULT_CASH_PCT,
  DEFAULT_CREDIT_PCT,
} from '../../apps/quote/modules/totals.js';

// ── parseLines ─────────────────────────────────────────────────────────
test('parseLines: bare number form keeps set_code empty and discards "/total"', () => {
  const out = parseLines('44\n200/167');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { set_code: '', card_number: '44', name: '', raw: '44' });
  assert.deepEqual(out[1], { set_code: '', card_number: '200', name: '', raw: '200/167' });
});

test('parseLines: set + number form parses both tokens, drops total', () => {
  const out = parseLines('MEG 133\nTWM 200/167');
  assert.deepEqual(out[0], { set_code: 'MEG', card_number: '133', name: '', raw: 'MEG 133' });
  assert.deepEqual(out[1], { set_code: 'TWM', card_number: '200', name: '', raw: 'TWM 200/167' });
});

test('parseLines: third+ tokens become the optional name', () => {
  const out = parseLines('MEG 133 Bulbasaur ex');
  assert.equal(out[0].name, 'Bulbasaur ex');
  assert.equal(out[0].set_code, 'MEG');
  assert.equal(out[0].card_number, '133');
});

test('parseLines: skips comments and blanks', () => {
  const out = parseLines('# header\n\n// note\nMEG 1\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].set_code, 'MEG');
});

test('parseLines: caps at MAX_CARDS=20', () => {
  assert.equal(MAX_CARDS, 20);
  const lines = Array.from({ length: 25 }, (_, i) => `MEG ${i + 1}`).join('\n');
  const out = parseLines(lines);
  assert.equal(out.length, 20);
});

// ── buildCardmarketUrl ─────────────────────────────────────────────────
test('buildCardmarketUrl: returns null for non-Pokemon cards', () => {
  assert.equal(buildCardmarketUrl({ game: 'magic', set_code: 'mkm', card_number: '1', name: 'Foo' }), null);
});

test('buildCardmarketUrl: known set builds direct product URL with padded number', () => {
  const url = buildCardmarketUrl({
    game: 'pokemon',
    set_code: 'me1',
    card_number: '155',
    name: 'Mega Venusaur ex',
  });
  // Slug: Mega-Evolution; PTCGO: MEG; padded num: 155 (already 3 digits)
  assert.equal(url, 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Mega-Evolution/Mega-Venusaur-ex-MEG155');
});

test('buildCardmarketUrl: pads short numbers to 3 digits', () => {
  const url = buildCardmarketUrl({
    game: 'pokemon',
    set_code: 'me1',
    card_number: '3',
    name: 'Pikachu',
  });
  assert.ok(url.endsWith('-MEG003'), 'expected -MEG003 suffix; got ' + url);
});

test('buildCardmarketUrl: drops the "/total" suffix from card_number', () => {
  const url = buildCardmarketUrl({
    game: 'pokemon',
    set_code: 'sv6',
    card_number: '200/167',
    name: 'Pidgeot ex',
  });
  assert.ok(url.endsWith('-TWM200'), 'expected TWM200 suffix; got ' + url);
});

test('buildCardmarketUrl: unknown set falls back to slug+searchString', () => {
  const url = buildCardmarketUrl({
    game: 'pokemon',
    set_code: 'wht',
    set_name: 'White Flare',
    card_number: '5',
    name: 'Eevee',
  });
  assert.ok(url?.startsWith('https://www.cardmarket.com/en/Pokemon/Products/Singles/White-Flare?searchString='), url);
});

// ── totals ─────────────────────────────────────────────────────────────
test('calcCardOffers: NM passes through, applies pct correctly', () => {
  const o = calcCardOffers(10, 'NM', DEFAULT_CASH_PCT, DEFAULT_CREDIT_PCT);
  assert.equal(o.market, 10);
  assert.equal(o.cash, 5.5);
  assert.equal(o.credit, 7);
});

test('calcCardOffers: condition multiplier discounts effective MV', () => {
  const o = calcCardOffers(10, 'MP', 50, 70);
  // 10 × 0.7 × 0.5 = 3.5
  assert.equal(o.cash, 3.5);
  // 10 × 0.7 × 0.7 = 4.9
  assert.equal(o.credit, 4.9);
});

test('calcCardOffers: unknown / missing condition = NM (mult 1)', () => {
  const o = calcCardOffers(10, undefined, 50, 70);
  assert.equal(o.cash, 5);
  assert.equal(o.credit, 7);
});

test('CONDITION_MULTS pinned to V1 values', () => {
  assert.equal(CONDITION_MULTS.NM, 1.0);
  assert.equal(CONDITION_MULTS.LP, 0.85);
  assert.equal(CONDITION_MULTS.MP, 0.7);
  assert.equal(CONDITION_MULTS.HP, 0.5);
  assert.equal(CONDITION_MULTS.DMG, 0.3);
});

test('sumTotals: skips error rows, sums priced rows', () => {
  const totals = sumTotals([
    { market: 10, cash: 5, credit: 7 },
    { error: 'not found', line: 'XYZ 1' },
    { market: 20, cash: 10, credit: 14 },
  ]);
  assert.equal(totals.market, 30);
  assert.equal(totals.cash, 15);
  assert.equal(totals.credit, 21);
});

test('formatEur: two decimals, EUR sign', () => {
  assert.equal(formatEur(0), '€0.00');
  assert.equal(formatEur(1.2), '€1.20');
  assert.equal(formatEur(null), '€0.00');
});
