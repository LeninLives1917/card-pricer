// Regression: customer-facing PDF export — apps/vendor/modules/pdf-export.js
//
// The actual print() flow needs jsdom + a real iframe so we don't spec it
// here. What we DO lock down:
//   - buildRow math: market value, cash/credit offers, qty multipliers,
//     custom_buy override precedence
//   - image-source priority (image_url > reference_image > scan photo)
//   - renderPrintHtml output shape (title / shop name / totals appear,
//     "Cash offer" / "Store credit" columns toggle on/off cleanly)
//
// State.js is imported transitively but reads localStorage only inside
// functions, so the bare import is safe in node:test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _test_internals } from '../../apps/vendor/modules/pdf-export.js';
const { buildRow, renderPrintHtml, euro, round2 } = _test_internals;

// ── buildRow ───────────────────────────────────────────────────────────────

test('buildRow uses market_value and computes cash/credit at the slider %', () => {
  const r = buildRow({
    card: { name: 'Pikachu', set_code: 'MEG', card_number: '172', set_name: 'Mega Evolutions', rarity: 'Rare' },
    market_value: 10,
  }, /* cashPct */ 50, /* creditPct */ 70);
  assert.equal(r.name, 'Pikachu');
  assert.equal(r.setLabel, 'MEG 172');
  assert.equal(r.market, '€10.00');
  assert.equal(r.cash,   '€5.00');
  assert.equal(r.credit, '€7.00');
});

test('buildRow honours custom_buy override (operator-set cash) but recomputes credit', () => {
  const r = buildRow({
    card: { name: 'Charizard' },
    market_value: 100,
    custom_buy: 42,
  }, 50, 70);
  // custom_buy wins for cash (per existing session.js logic).
  assert.equal(r.cash, '€42.00');
  // Credit still derives from market * creditPct%.
  assert.equal(r.credit, '€70.00');
});

test('buildRow falls back through cardmarket.price / cardmarket.trend / buy_price.market_value', () => {
  // No top-level market_value; should pick buy_price.market_value first.
  const r1 = buildRow({
    card: { name: 'X' },
    buy_price: { market_value: 25 },
  }, 50, 70);
  assert.equal(r1.market, '€25.00');

  const r2 = buildRow({
    card: { name: 'X' },
    cardmarket: { price: 12.5 },
  }, 50, 70);
  assert.equal(r2.market, '€12.50');

  const r3 = buildRow({
    card: { name: 'X' },
    cardmarket: { trend: 8 },
  }, 50, 70);
  assert.equal(r3.market, '€8.00');
});

test('buildRow multiplies all three figures by quantity (duplicate_count + 1)', () => {
  const r = buildRow({
    card: { name: 'Pikachu' },
    market_value: 10,
    duplicate_count: 2, // qty = 3
  }, 50, 70);
  assert.equal(r.qty, 3);
  assert.equal(r.marketRaw, 30);
  assert.equal(r.cashRaw, 15);
  assert.equal(r.creditRaw, 21);
});

test('buildRow image priority: card.image_url > card.reference_image > entry.image', () => {
  // image_url wins.
  assert.equal(buildRow({
    card: { image_url: 'A', reference_image: 'B' },
    image: 'C',
  }, 50, 70).image, 'A');

  // reference_image when image_url missing.
  assert.equal(buildRow({
    card: { reference_image: 'B' },
    image: 'C',
  }, 50, 70).image, 'B');

  // entry.image as last resort.
  assert.equal(buildRow({
    card: {},
    image: 'C',
  }, 50, 70).image, 'C');

  // Empty when nothing set.
  assert.equal(buildRow({
    card: {},
  }, 50, 70).image, '');
});

test('buildRow handles missing card cleanly (Unknown name, blank labels)', () => {
  const r = buildRow({}, 50, 70);
  assert.equal(r.name, 'Unknown card');
  assert.equal(r.setLabel, '');
  assert.equal(r.qty, 1);
  assert.equal(r.market, '€0.00');
});

// ── euro / round2 ─────────────────────────────────────────────────────────

test('euro formats to 2dp with euro sign', () => {
  assert.equal(euro(0), '€0.00');
  assert.equal(euro(1), '€1.00');
  assert.equal(euro(1.234), '€1.23');
  assert.equal(euro(1.235), '€1.24'); // banker's round? no — Math.round half-away-from-zero
  assert.equal(euro(null), '€0.00');
  assert.equal(euro(undefined), '€0.00');
});

test('round2 cents-rounds positive numbers', () => {
  assert.equal(round2(0), 0);
  assert.equal(round2(1.234), 1.23);
  assert.equal(round2(1.235), 1.24);
  assert.equal(round2(0.1 + 0.2), 0.3); // float-safe (0.30000000000000004 → 0.3)
});

// ── renderPrintHtml ────────────────────────────────────────────────────────

function sampleCtx(overrides = {}) {
  return {
    title: 'Card Pricer — Test session',
    shopName: 'Card Pricer',
    shopEmail: 'shop@example.com',
    sessionName: 'Test session',
    dateStr: '5 May 2026',
    rows: [
      buildRow({
        card: { name: 'Pikachu', set_code: 'MEG', card_number: '172', image_url: 'https://example.com/pikachu.png' },
        market_value: 10,
      }, 50, 70),
    ],
    totals: { market: 10, cash: 5, credit: 7 },
    cashPct: 50,
    creditPct: 70,
    showCash: true,
    showCredit: true,
    ...overrides,
  };
}

test('renderPrintHtml emits a complete HTML document', () => {
  const html = renderPrintHtml(sampleCtx());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html[^>]*>/);
  assert.match(html, /<\/html>\s*$/);
});

test('renderPrintHtml puts shop + session in the header', () => {
  const html = renderPrintHtml(sampleCtx());
  assert.match(html, /Card Pricer/);
  assert.match(html, /Test session/);
  assert.match(html, /5 May 2026/);
});

test('renderPrintHtml renders the row image, name, set label, and prices', () => {
  const html = renderPrintHtml(sampleCtx());
  assert.match(html, /pikachu\.png/);
  assert.match(html, /Pikachu/);
  assert.match(html, /MEG 172/);
  assert.match(html, /€10\.00/);
  assert.match(html, /€5\.00/);
  assert.match(html, /€7\.00/);
});

test('renderPrintHtml shows totals footer with market/cash/credit', () => {
  const html = renderPrintHtml(sampleCtx());
  assert.match(html, /Total cash offer \(50%\)/);
  assert.match(html, /Total store credit \(70%\)/);
  assert.match(html, /Market value/);
});

test('renderPrintHtml hides credit column when creditOnly=false / showCredit=false', () => {
  const html = renderPrintHtml(sampleCtx({ showCredit: false }));
  assert.doesNotMatch(html, /Total store credit/);
  assert.doesNotMatch(html, /Store credit<\/dt>/);
});

test('renderPrintHtml hides cash column when showCash=false', () => {
  const html = renderPrintHtml(sampleCtx({ showCash: false }));
  assert.doesNotMatch(html, /Total cash offer/);
  assert.doesNotMatch(html, /Cash offer<\/dt>/);
});

test('renderPrintHtml escapes user-supplied strings (XSS guard)', () => {
  const ctx = sampleCtx();
  ctx.shopName = '<script>alert(1)</script>';
  ctx.rows[0].name = '"><img src=x>';
  const html = renderPrintHtml(ctx);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /"><img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renderPrintHtml shows quantity badge for duplicate stacks', () => {
  const ctx = sampleCtx();
  ctx.rows[0] = buildRow({
    card: { name: 'Pikachu' },
    market_value: 10,
    duplicate_count: 2, // qty = 3
  }, 50, 70);
  const html = renderPrintHtml(ctx);
  assert.match(html, /×3/);
});

test('renderPrintHtml pluralisation: "1 card" vs "2 cards"', () => {
  const oneCard = renderPrintHtml(sampleCtx({
    rows: [sampleCtx().rows[0]],
  }));
  assert.match(oneCard, /Buy quote for 1 card\./);

  const twoCards = renderPrintHtml(sampleCtx({
    rows: [sampleCtx().rows[0], sampleCtx().rows[0]],
  }));
  assert.match(twoCards, /Buy quote for 2 cards\./);
});
