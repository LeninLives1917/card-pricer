// Regression: cross-source price divergence guard.
//
// The bestPrice cascade is first-match-wins, so a single bad adapter sets the
// price with nothing to contradict it. That is how eBay quoted €2.28 against a
// €168-210 market: every number needed to notice the problem was already in the
// `pricing` object, and nothing compared them.
//
// The guard's contract has a deliberate asymmetry worth pinning down:
//   >= 3 sources — the median identifies the outlier, so it can be rejected
//   == 2 sources — disagreement is flagged, but NO outlier is named, because
//                  with two numbers and no tie-breaker there is no way to know
//                  which one is wrong. Guessing would reproduce the original
//                  bug with extra steps.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPriceDivergence, comparableEurPrices } from '../../pricing/price.js';

// --- collection -------------------------------------------------------------

test('collects EUR prices across sources, skipping absent and non-positive', () => {
  const got = comparableEurPrices({
    cardmarket: { price: 180 },
    justtcg: { price_eur: 175 },
    tcgplayer: null,
    ebay: { median_price: 2.28, currency: 'EUR' },
  });
  assert.deepEqual(got.map(p => p.source).sort(), ['cardmarket', 'ebay', 'justtcg']);
});

test('a zero or negative price is not a comparable price', () => {
  const got = comparableEurPrices({ cardmarket: { price: 0 }, justtcg: { price_eur: -3 } });
  assert.deepEqual(got, []);
});

// --- the incident this exists to catch --------------------------------------

test('the real eBay incident: 2.28 against 180/175 is rejected as an outlier', () => {
  const d = detectPriceDivergence({
    cardmarket: { price: 180.00 },
    justtcg: { price_eur: 175.85 },
    ebay: { median_price: 2.28, currency: 'EUR' },
  });
  assert.equal(d.diverged, true);
  assert.equal(d.adjudicable, true);
  assert.deepEqual(d.outliers, ['ebay']);
  assert.ok(d.ratio > 70, `expected a large ratio, got ${d.ratio}`);
});

// --- adjudication rules -----------------------------------------------------

test('two disagreeing sources are flagged but NOT adjudicated', () => {
  const d = detectPriceDivergence({
    cardmarket: { price: 180 },
    justtcg: { price_eur: 2.5 },
  });
  assert.equal(d.diverged, true);
  assert.equal(d.adjudicable, false, 'must not pick a winner from two numbers');
  assert.deepEqual(d.outliers, [], 'must not name an outlier without a majority');
});

test('sources in close agreement do not diverge', () => {
  const d = detectPriceDivergence({
    cardmarket: { price: 180 },
    justtcg: { price_eur: 175.85 },
    ebay: { median_price: 190, currency: 'EUR' },
  });
  assert.equal(d.diverged, false);
  assert.deepEqual(d.outliers, []);
});

test('a single source cannot diverge from anything', () => {
  const d = detectPriceDivergence({ cardmarket: { price: 180 } });
  assert.equal(d.diverged, false);
  assert.equal(d.ratio, null);
});

test('no sources at all is handled without throwing', () => {
  const d = detectPriceDivergence({});
  assert.equal(d.diverged, false);
  assert.deepEqual(d.prices, []);
});

test('an outlier ABOVE the median is caught, not just below', () => {
  // Guards against a check written only for the lowball case that motivated it.
  const d = detectPriceDivergence({
    cardmarket: { price: 10 },
    justtcg: { price_eur: 11 },
    ebay: { median_price: 900, currency: 'EUR' },
  });
  assert.equal(d.diverged, true);
  assert.deepEqual(d.outliers, ['ebay']);
});

test('the divergence factor is configurable', () => {
  const pricing = { cardmarket: { price: 100 }, justtcg: { price_eur: 30 } };
  assert.equal(detectPriceDivergence(pricing, { factor: 5 }).diverged, false);
  assert.equal(detectPriceDivergence(pricing, { factor: 3 }).diverged, true);
});

test('divergence reports the sources it compared, for the operator to read', () => {
  const d = detectPriceDivergence({
    cardmarket: { price: 180 },
    justtcg: { price_eur: 175.85 },
    ebay: { median_price: 2.28, currency: 'EUR' },
  });
  assert.equal(d.prices.length, 3);
  assert.ok(d.median > 100, `median should reflect the majority, got ${d.median}`);
});
