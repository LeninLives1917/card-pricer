// Regression: the customer quote prices from the cheapest Near Mint English
// copy on Cardmarket, the same number the shop scanner prices from.
//
// INCIDENT PINNED (7 Oct 2026):
//
// Dave asked "to confirm we use card market lowest nm English?". We did not.
// The quote priced from the price guide's TREND, while the shop scanner
// (pricing/price.js) prices from TCGGO's lowest_near_mint, the cheapest NM
// English copy for sale, so a customer's online quote and the offer at the
// counter started from different numbers:
//
//   Mew ex 152/128          trend  99.21   cheapest NM English 105
//   Charizard ex 125/197    trend   3.51   cheapest NM English   2.50
//
// Dave's call: the quote uses the cheapest NM English copy, from the hub's
// daily TCGGO pull, with the guide as the cross-check and the fallback.
//
// Checking the two against each other on the live catalogue that morning
// turned up cards where NEITHER number can be trusted, and those go to the
// shop by hand instead of being quoted:
//
//   product_unconfirmed  TCGGO and TCGdex put different cards on one
//                        Cardmarket product. Snorlax swsh1-140 sat on the
//                        product Cardmarket itself calls "Snorlax VMAX", and
//                        had been quoted at the VMAX's trend, 69.66.
//   prices_disagree      the copy and the guide 5x or more apart: Gallade POP 7
//                        #2 trend 5.90 with the cheapest NM English copy at 500.
//
// And on the live catalogue: 18,056 of 19,718 priced cards (91.6%) price from
// the NM English copy; 215 disagree and 34 are unconfirmed, by hand.
//
// DI throughout (handleQuoteBatch(body, deps)); no mock.module().

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleQuoteBatch } from '../../apps/server/routes/quote-batch.js';
import { quotePriceCheck, QUOTE_NM_EN_MIN_RATIO } from '../../apps/server/routes/health.js';
import { buildPriceIndex, marketPriceOf, tcggoCheck, numbersAgree } from '../../pricing/quote-prices/feed-index.js';
import { loadSets } from '../../pricing/set-resolve.js';
import { getQuoteBatchCounts, resetQuoteBatchCounts } from '../../infra/observability/quote-batch-counters.js';

const NOW = Date.parse('2026-10-07T10:00:00Z');

const cardDb = () => new Map([
  ['sv3-125', { name: 'Charizard ex', setName: 'Obsidian Flames' }],
  ['swsh1-140', { name: 'Snorlax', setName: 'Sword & Shield' }],
  ['pop7-2', { name: 'Gallade', setName: 'POP Series 7' }],
  ['xy2-3', { name: 'Butterfree', setName: 'Flashfire' }],
  ['base1-3', { name: 'Chansey', setName: 'Base' }],
  ['base1-4', { name: 'Charizard', setName: 'Base' }],
  ['cel25c-4', { name: 'Charizard', setName: 'Celebrations: Classic Collection' }],
  ['base6-53', { name: 'Meowth', setName: 'Legendary Collection' }],
  ['sv2-50', { name: 'Tinkatink', setName: 'Paldea Evolved' }],
  ['sv2-60', { name: 'Wiglett', setName: 'Paldea Evolved' }],
  ['sv2-70', { name: 'Lechonk', setName: 'Paldea Evolved' }],
  ['sv2-80', { name: 'Pawmi', setName: 'Paldea Evolved' }],
  ['sv2-90', { name: 'Gholdengo', setName: 'Paldea Evolved' }],
  ['sv2-91', { name: 'Kingambit', setName: 'Paldea Evolved' }],
  ['sv2-95', { name: 'Tatsugiri', setName: 'Paldea Evolved' }],
  ['sv1-189', { name: "Professor's Research", setName: 'Scarlet & Violet' }],
  ['hgss4-94', { name: 'Gengar', setName: 'HS—Triumphant' }],
]);

// Feed version 2 rows: the 16 guide columns, then
// [nm_en, tcggo rows for the product, tcggo name, tcggo number].
const row = (set, local, name, id, trend, o = {}) => [
  set, local, name, id, trend, o.avg7 ?? trend, o.avg30 ?? trend, trend, trend == null ? null : trend / 4,
  o.holo ?? null, o.holo ?? null, o.holo ?? null, null, null, !!o.firstEd, !!o.reverse,
  o.nm ?? null,
  o.tn === undefined ? 1 : o.tn,
  o.tn === null ? null : (o.tname ?? name),
  o.tn === null ? null : (o.tnum ?? local),
];

const SETS = [
  ['sv03', 'Obsidian Flames', 'OBF', 197, 230, '2023-08-11'],
  ['swsh1', 'Sword & Shield', 'SSH', 202, 216, '2020-02-07'],
  ['pop7', 'POP Series 7', 'P7', 17, 17, '2008-03-01'],
  ['xy2', 'Flashfire', 'FLF', 106, 109, '2014-05-07'],
  ['base1', 'Base Set', 'BS', 102, 102, '1999-01-09'],
  ['cel25cc', 'Celebrations Classic Collection', 'CEL:CC', 25, 25, '2021-10-08'],
  ['lc', 'Legendary Collection', 'LC', 110, 110, '2002-05-24'],
  ['sv02', 'Paldea Evolved', 'PAL', 193, 279, '2023-06-09'],
  ['sv01', 'Scarlet & Violet', 'SVI', 198, 258, '2023-03-31'],
  ['hgss4', 'Triumphant', 'TRI', 102, 103, '2010-11-03'],
];

// Real numbers from 7 Oct 2026 where the card is real.
const CARDS = [
  row('sv03', '125', 'Charizard ex', 725205, 3.51, { avg7: 3.45, avg30: 3.66, nm: 2.5 }),
  row('swsh1', '140', 'Snorlax', 2001, 69.66, { nm: 45, tname: 'Snorlax VMAX', tnum: '142' }),
  row('pop7', '2', 'Gallade', 2002, 5.9, { nm: 500 }),
  row('xy2', '3', 'Butterfree', 2003, 6.61, { nm: 0.99 }),
  row('base1', '3', 'Chansey', 273698, 42.42, { nm: 42.42, tn: 2 }),
  row('base1', '4', 'Charizard', 273699, 569.73, { firstEd: true, nm: 520 }),
  row('cel25cc', 'CC002', 'Charizard', 2004, 200.96, { nm: 155, tnum: '4' }),
  row('lc', '53', 'Meowth', 2005, 0.02, { nm: 1.9 }),
  row('sv02', '050', 'Tinkatink', 2006, 0.12, { tn: null }),
  row('sv02', '060', 'Wiglett', 2007, 0.15, { nm: null }),
  row('sv02', '070', 'Lechonk', 2008, 0.10, { nm: 0.02 }),
  row('sv02', '080', 'Pawmi', 2009, 0.10, { nm: 0.05, reverse: true, holo: 0.4 }),
  row('sv02', '090', 'Gholdengo', 2010, 280, { nm: 320 }),
  row('sv02', '091', 'Kingambit', 2011, 320, { nm: 290 }),
  row('sv02', '095', 'Tatsugiri', 2012, null, { nm: 3 }),
  row('sv01', '189', "Professor's Research", 2013, 0.09, { nm: 0.02, tname: "Professor's Research (Professor Sada)" }),
  row('hgss4', '94', 'Gengar', 2014, 0.02, { avg7: 269.56, avg30: 908.54, nm: 59.99 }),
];

const FEED = (over = {}) => ({
  version: 2, snapshot_date: '2026-10-07', nm_en_date: '2026-10-07',
  cache_built_at: '2026-10-07T09:38:30Z', sets: SETS, cards: CARDS, ...over,
});

async function quote(lines, { feed = FEED(), ...over } = {}) {
  const db = cardDb();
  const res = await handleQuoteBatch(
    { lines, game: 'pokemon' },
    { cardDb: db, priceIndex: buildPriceIndex(feed, db, loadSets(), []), now: NOW, ...over },
  );
  assert.equal(res.status, 200);
  return res.body;
}

test("Dave's screenshot: Mew ex 152/128 quotes the cheapest NM English copy, 105, not the trend 99.21", () => {
  const mew = ['30th', '152', 'Mew ex', 908354, 99.21, 128.76, 155.08, 294.6, 80,
    0, null, null, null, null, false, false, 105, 1, 'Mew ex', '152'];
  const p = marketPriceOf(mew);
  assert.equal(p.value, 105);
  assert.equal(p.basis, 'nm_en');
});

test('a clean card is priced from the NM English copy, and the response says so', async () => {
  const body = await quote(['Charizard ex 125/197']);
  const [r] = body.rows;
  assert.equal(r.status, 'priced');
  assert.equal(r.price.market, 2.5, 'not the trend, 3.51');
  assert.equal(r.price.basis, 'nm_en');
  assert.equal(r.price.source, 'cardmarket_nm_en');
  assert.equal(r.price.as_of, '2026-10-07');
  assert.equal(body.nm_en_usable, true);
  assert.equal(body.nm_en_as_of, '2026-10-07');
  assert.match(body.price_source, /Near Mint English/);
});

test('bulk is the bulk market: 0.02 against a trend of 0.10 is quoted, not refused', async () => {
  const [r] = (await quote(['Lechonk 70/193'])).rows;
  assert.equal(r.status, 'priced');
  assert.equal(r.price.market, 0.02);
});

test('no NM English number to use: the guide value, with the reason on the row', async () => {
  const rows = (await quote(['Chansey 3/102', 'Tinkatink 50/193', 'Wiglett 60/193', "Professor's Research 189/198"])).rows;
  const why = rows.map((r) => [r.status, r.price?.basis, r.price?.nm_en_fallback]);
  assert.deepEqual(why[0], ['priced', 'trend', 'shared_product'], 'TCGGO files two cards under the product');
  assert.deepEqual(why[1], ['priced', 'trend', 'not_in_tcggo']);
  assert.deepEqual(why[2], ['priced', 'trend', 'no_listing'], 'no English NM copy for sale');
  assert.deepEqual(why[3], ['priced', 'trend', 'name_differs'], 'same number, a name TCGGO spells differently');
  assert.equal(rows[0].price.market, 42.42);
  assert.equal(rows[0].price.source, 'cardmarket_price_guide');
});

test('product_unconfirmed: TCGGO says the product is a different card, so neither number is quoted', async () => {
  const [r] = (await quote(['Snorlax 140/202'])).rows;
  assert.equal(r.status, 'unpriced');
  assert.equal(r.unpriced_reason, 'product_unconfirmed');
  assert.equal(r.card.id, 'swsh1-140', 'the card is still identified');
  assert.equal(tcggoCheck(CARDS[1]), 'product_unconfirmed');
});

test('the Classic Collection is numbered as printed by TCGGO, and that is not a mismatch', async () => {
  assert.equal(numbersAgree('4', 'CC002'), false);
  const [r] = (await quote(['cha 4/102 celebrations'])).rows;
  assert.equal(r.card.id, 'cel25c-4');
  assert.equal(r.status, 'priced');
  assert.equal(r.price.market, 155);
  assert.equal(r.price.basis, 'nm_en');
});

test('prices_disagree: 5x apart is by hand (a dearer copy from 50c up, a cheaper one when the guide says EUR 2+)', async () => {
  const rows = (await quote(['Gallade 2/17', 'Butterfree 3/106', 'Meowth 53/110'])).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.unpriced_reason]), [
    ['unpriced', 'prices_disagree'], // NM English 500 against a trend of 5.90
    ['unpriced', 'prices_disagree'], // NM English 0.99 against a trend of 6.61
    ['unpriced', 'prices_disagree'], // NM English 1.90 against a trend of 0.02 (over 50c)
  ]);
});

test('a reverse holo is priced from the guide reverse holo value, and says why', async () => {
  const [plain, rev] = (await quote(['Pawmi 80/193', 'rev Pawmi 80/193'])).rows;
  assert.equal(plain.price.market, 0.05);
  assert.equal(plain.price.basis, 'nm_en');
  assert.equal(rev.price.market, 0.4);
  assert.equal(rev.price.basis, 'trend');
  assert.equal(rev.price.nm_en_fallback, 'reverse_holo', 'TCGGO prices the product, not the reverse');
});

test('a value line, when set, is judged on the number quoted', async () => {
  const [over, under] = (await quote(['Gholdengo 90/193', 'Kingambit 91/193'], { handPriceAboveEur: 300 })).rows;
  assert.equal(over.status, 'unpriced', 'NM English 320, trend 280');
  assert.equal(over.unpriced_reason, 'high_value');
  assert.equal(under.status, 'priced', 'NM English 290, trend 320');
  assert.equal(under.price.market, 290);
});

test('a broken guide or no guide price is still by hand: nothing to check the copy against', async () => {
  const [gengar, tats] = (await quote(['Gengar 94/102', 'Tatsugiri 95/193'])).rows;
  assert.equal(gengar.unpriced_reason, 'price_unstable');
  assert.equal(tats.unpriced_reason, 'no_price_in_guide');
});

test('a stale or missing NM English pull puts every card on the guide, and says so', async () => {
  const stale = await quote(['Charizard ex 125/197'], { feed: FEED({ nm_en_date: '2026-10-02' }) });
  assert.equal(stale.nm_en_usable, false);
  assert.equal(stale.rows[0].price.market, 3.51);
  assert.equal(stale.rows[0].price.nm_en_fallback, 'nm_en_stale');
  assert.match(stale.price_source, /price guide/);

  const v1 = FEED({ version: 1, nm_en_date: undefined, cards: CARDS.map((r) => r.slice(0, 16)) });
  const missing = await quote(['Charizard ex 125/197'], { feed: v1 });
  assert.equal(missing.rows[0].price.nm_en_fallback, 'nm_en_missing');
  assert.equal(missing.rows[0].price.market, 3.51);
});

test('counted: priced lines by basis, the fallbacks by reason, and the ratio', async () => {
  resetQuoteBatchCounts();
  await quote(['Charizard ex 125/197', 'Lechonk 70/193', 'Chansey 3/102', 'rev Pawmi 80/193']);
  const c = getQuoteBatchCounts();
  assert.equal(c.priced_nm_en, 2);
  assert.equal(c.priced_on_guide, 2);
  assert.deepEqual(c.on_guide_by_reason, { shared_product: 1, reverse_holo: 1 });
  assert.equal(c.nm_en_ratio, 0.5);
});

test('the index counts it too, for /api/health', () => {
  const db = cardDb();
  const idx = buildPriceIndex(FEED(), db, loadSets(), []);
  assert.equal(idx.nmEnDate, '2026-10-07');
  assert.equal(idx.stats.product_unconfirmed, 1);
  assert.equal(idx.stats.prices_disagree, 3);
  assert.ok(idx.stats.nm_en_priced >= 6);
  assert.equal(idx.stats.on_guide.shared_product, 1);
  assert.ok(idx.stats.nm_en_ratio > 0 && idx.stats.nm_en_ratio < 1);
});

test('/api/health: missing, stale or thin NM English coverage degrades quote_prices', () => {
  const env = { HUB_SUPABASE_URL: 'https://x.supabase.co', HUB_SUPABASE_KEY: 'k' };
  const base = {
    configured: true, loaded: true, snapshot_date: '2026-10-07', age_days: 0.4, stale_after_days: 3,
    mapped_ratio: 0.995, priced_ratio: 0.943, last_error: null,
    nm_en_date: '2026-10-07', nm_en_age_days: 0.4, nm_en_ratio: 0.916,
  };
  assert.equal(quotePriceCheck(base, env).ok, true);
  assert.match(quotePriceCheck(base, env).detail, /NM English 2026-10-07 on 91\.6%/);

  const none = quotePriceCheck({ ...base, nm_en_date: null, nm_en_age_days: null }, env);
  assert.equal(none.ok, false);
  assert.match(none.detail, /no NM English prices/);

  const stale = quotePriceCheck({ ...base, nm_en_date: '2026-10-02', nm_en_age_days: 5.4 }, env);
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /NM English prices stale/);

  const thin = quotePriceCheck({ ...base, nm_en_ratio: QUOTE_NM_EN_MIN_RATIO - 0.01 }, env);
  assert.equal(thin.ok, false);
  assert.match(thin.detail, /usable NM English price/);
});
