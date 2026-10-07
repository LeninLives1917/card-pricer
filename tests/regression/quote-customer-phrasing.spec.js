// Regression: how CUSTOMERS type a card list, on the public whole-list quote.
//
// INCIDENTS PINNED (7 Oct 2026, the night the whole-list quote was built):
//
// The typed resolver was built for the shop's own shorthand. Before going
// live, 2,000 catalogue cards were typed the way a customer types them and run
// through the route. As typed into the resolver, which is all the first build
// did:
//
//   rev Gengar 94/162            qualifier first        0.1% matched
//   Reverse Holo Charizard ...   qualifier first        0.0%
//   1st Edition Machamp 8/102    qualifier first        0.0%
//   Machamp 8/102 first edition  "first" unread         100% priced as Unlimited
//   2 x Charizard 4/102          quantity               100% read as 1
//   Charizard 4/102 x3           quantity               100% read as 1
//   Charizard Base Set 4/102     set name in the way    3.5% matched
//   Base Set Charizard 4/102     set name first         0.3%
//   4/102 Charizard              number first           0.0%
//   nm Charizard 4/102           grade first            58.1%
//   Charizard 4/102 PSA 9        a graded slab          priced as a raw NM card
//   Light Dragonite 14/105       "Light" read as LP     quoted at x0.58
//
// And the price guide itself: Gengar (HS—Triumphant 94) had trend 0.02 beside
// avg7 269.56 and avg30 908.54. The route quoted the trend.
//
// After: every format above matched 99.95-100% of the 2,000, with no wrong card
// in any of them (the sweep is customer-sweep.mjs in the Card Pricing project).
//
// DI throughout (handleQuoteBatch(body, deps)); no mock.module().

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleQuoteBatch } from '../../apps/server/routes/quote-batch.js';
import { buildPriceIndex, marketPriceOf } from '../../pricing/quote-prices/feed-index.js';
import { loadSets } from '../../pricing/set-resolve.js';
import {
  cleanCustomerLine, moveQualifiers, stripSetName, buildSetNameTokens, contextAgrees,
  setEvidence, gradeAndFinishOutsideName,
} from '../../pricing/text-entry/customer-line.js';
import { getQuoteBatchCounts, resetQuoteBatchCounts } from '../../infra/observability/quote-batch-counters.js';

const NOW = Date.parse('2026-10-07T01:00:00Z');

const cardDb = () => new Map([
  ['base1-6', { name: 'Gyarados', setName: 'Base' }],
  ['base1-58', { name: 'Pikachu', setName: 'Base' }],
  ['gym1-132', { name: 'Water Energy', setName: 'Gym Heroes' }],
  ['gym2-132', { name: 'Water Energy', setName: 'Gym Challenge' }],
  ['neo4-14', { name: 'Light Dragonite', setName: 'Neo Destiny' }],
  ['sv3-125', { name: 'Charizard ex', setName: 'Obsidian Flames' }],
  ['hgss4-94', { name: 'Gengar', setName: 'HS—Triumphant' }],
]);

// [set, local, name, id_product, trend, avg7, avg30, avg, low,
//  trend_holo, avg7_holo, avg30_holo, avg_holo, low_holo, first_ed, has_reverse]
const row = (set, local, name, id, trend, o = {}) => [
  set, local, name, id, trend, o.avg7 ?? trend, o.avg30 ?? trend, trend, trend / 4,
  o.holo ?? null, o.holo ?? null, o.holo ?? null, null, null, !!o.firstEd, !!o.reverse,
];

const FEED = {
  snapshot_date: '2026-10-06',
  cache_built_at: '2026-10-06T23:20:00Z',
  sets: [
    ['base1', 'Base Set', 'BS', 102, 102, '1999-01-09'],
    ['gym1', 'Gym Heroes', 'G1', 132, 132, '2000-08-14'],
    ['gym2', 'Gym Challenge', 'G2', 132, 132, '2000-10-16'],
    ['neo4', 'Neo Destiny', 'N4', 105, 113, '2002-02-28'],
    ['sv03', 'Obsidian Flames', 'OBF', 197, 230, '2023-08-11'],
    ['hgss4', 'Triumphant', 'TRI', 102, 103, '2010-11-03'],
  ],
  cards: [
    row('base1', '6', 'Gyarados', 2001, 21.54, { firstEd: true }),
    row('base1', '58', 'Pikachu', 2002, 5, { avg7: 20, avg30: 21 }),
    row('gym1', '132', 'Water Energy', 2003, 0.5),
    row('gym2', '132', 'Water Energy', 2004, 0.6),
    row('neo4', '14', 'Light Dragonite', 2005, 83.64),
    row('sv03', '125', 'Charizard ex', 2006, 3.47, { reverse: true, holo: 6.25 }),
    row('hgss4', '94', 'Gengar', 2007, 0.02, { avg7: 269.56, avg30: 908.54 }),
  ],
};

async function quote(lines, over = {}) {
  const db = cardDb();
  const res = await handleQuoteBatch(
    { lines, game: 'pokemon' },
    { cardDb: db, priceIndex: buildPriceIndex(FEED, db, loadSets(), []), now: NOW, ...over },
  );
  assert.equal(res.status, 200);
  return res.body.rows;
}

// ── the line reader ────────────────────────────────────────────────────────

test('quantities in the forms customers write them', () => {
  const q = (l) => cleanCustomerLine(l);
  assert.deepEqual([q('2 x Charizard 4/102').qty, q('2 x Charizard 4/102').text], [2, 'Charizard 4/102']);
  assert.equal(q('x2 Pikachu 58/102').qty, 2);
  assert.equal(q('2 Pikachu 58/102').qty, 2, 'a bare count, only because a number follows');
  assert.equal(q('Charizard 4/102 x3').qty, 3);
  assert.equal(q('Charizard 4/102 (x3)').qty, 3);
  assert.equal(q('Charizard 4/102 x 2').qty, 2);
  assert.equal(q('Charizard 4/102 qty: 4').qty, 4);
  assert.equal(q('Charizard\t4/102\t2').qty, 2, 'a spreadsheet quantity column');
  assert.equal(q('Charizard, Base Set, 4/102, 3').qty, 3);
  assert.equal(q('Charizard 4/102').qty, null);
  assert.equal(q('1. Charizard 4/102').qty, null, 'a list index is not a quantity');
  assert.equal(q('1. Charizard 4/102').text, 'Charizard 4/102');
  assert.equal(q('Dialga LV.X 99/146').qty, null, 'the X of LV.X is not a quantity');
  assert.equal(q('Dialga LV.X 99/146').text, 'Dialga LV.X 99/146');
});

test('phrases become the words the tokeniser knows; names are left alone', () => {
  const t = (l) => cleanCustomerLine(l).text;
  assert.equal(t('Machamp 8/102 first edition'), 'Machamp 8/102 1st');
  assert.equal(t('1st Edition Machamp 8/102'), '1st Machamp 8/102');
  assert.equal(t('reverse holo Pikachu 58/102'), 'rev Pikachu 58/102');
  assert.equal(t('Pikachu 58/102 RH'), 'Pikachu 58/102 rev');
  assert.equal(t('Pikachu 58/102 r/h'), 'Pikachu 58/102 rev');
  assert.equal(t('Charizard 4/102 near mint'), 'Charizard 4/102 nm');
  assert.equal(t('Pikachu 58/102 lightly played'), 'Pikachu 58/102 lp');
  assert.equal(t('Charizard 4 / 102'), 'Charizard 4/102');
  assert.equal(t('Charizard #4/102'), 'Charizard 4/102');
  assert.equal(t('Charizard - Base Set - 4/102'), 'Charizard Base Set 4/102');
  assert.equal(t('Ho-Oh 7/64'), 'Ho-Oh 7/64');
  assert.equal(t("Boss's Orders (Ghetsis) 172/192"), "Boss's Orders (Ghetsis) 172/192");
  assert.equal(t('First Ticket 5/10'), 'First Ticket 5/10', '"first" alone is a word in a name');
});

test('language words and grading marks are read, not searched for', () => {
  const j = cleanCustomerLine('Charizard Japanese 4/102');
  assert.equal(j.lang, 'ja');
  const g = cleanCustomerLine('Charizard 4/102 PSA 9');
  assert.equal(g.graded, true);
  assert.equal(g.text, 'Charizard 4/102');
  assert.equal(cleanCustomerLine('PSA10 Charizard 4/102').graded, true);
  assert.equal(cleanCustomerLine('Charizard 4/102 BGS Gem Mint 9.5').text, 'Charizard 4/102');
  assert.equal(cleanCustomerLine('Charizard 4/102').graded, false);
});

test('qualifiers move behind the number, keeping the ones that start real names', () => {
  assert.deepEqual(moveQualifiers('rev Gengar 94/162'), ['Gengar 94/162 rev']);
  assert.ok(moveQualifiers('rev Light Piloswine 26/105').includes('Light Piloswine 26/105 rev'));
  assert.deepEqual(moveQualifiers('4/102 Charizard'), ['Charizard 4/102']);
  assert.deepEqual(moveQualifiers('Charizard 4/102 rev'), []);
});

test('a set name comes out whole, and only whole', () => {
  const tokens = buildSetNameTokens(['Base', 'Base Set 2', 'Team Rocket', 'Team Magma vs Team Aqua', 'Deoxys']);
  assert.deepEqual(stripSetName('Charizard Base Set 4/102', tokens),
    [{ text: 'Charizard 4/102', dropped: ['Base', 'Set'] }]);
  assert.equal(stripSetName('Charizard Base Set 2 4/130', tokens)[0].text, 'Charizard 4/130');
  assert.equal(stripSetName("Team Magma vs Team Aqua Team Aqua's Carvanha 47/95", tokens)[0].text,
    "Team Aqua's Carvanha 47/95");
  assert.deepEqual(stripSetName("Team Rocket's Mewtwo ex 81/182", tokens), [],
    "Rocket's is not Rocket");
  const both = stripSetName('Deoxys ex Deoxys 98/107', tokens).map((v) => v.text);
  assert.ok(both.includes('Deoxys ex 98/107'), 'a set named like a card is tried at both ends');
});

test('dropped words are checked against the card, not assumed', () => {
  const base = { set_name: 'Base', set_id: 'base1', set_code: 'BS' };
  assert.equal(contextAgrees(['Base', 'Set'], base), true);
  assert.equal(contextAgrees(['Holo', 'Rare'], base), true);
  assert.equal(contextAgrees(['Red', 'Cheeks'], base), false);
  assert.equal(setEvidence(['Holo'], base), false, 'filler alone names no set');
  assert.equal(setEvidence(['Gym', 'Heroes'], { set_name: 'Gym Heroes', set_id: 'gym1' }), true);
  assert.equal(setEvidence(['Gym', 'Heroes'], { set_name: 'Gym Challenge', set_id: 'gym2' }), false);
  assert.equal(contextAgrees(["McDonald's", 'Collection', '2019'],
    { set_name: "McDonald's Collection 2019", set_id: 'mcd19' }), true);
});

test('a grade word inside the card name is not a grade', () => {
  assert.deepEqual(gradeAndFinishOutsideName('Light Dragonite 14/105', 'Light Dragonite'),
    { condition: null, finish: null });
  assert.deepEqual(gradeAndFinishOutsideName('Light Dragonite 14/105 pl', 'Light Dragonite'),
    { condition: 'PL', finish: null });
  assert.equal(gradeAndFinishOutsideName('Charizard 4/102 lp', 'Charizard'), null,
    'no clash: the tokeniser reading stands');
});

// ── the route ──────────────────────────────────────────────────────────────

test('a qualifier before the name still finds the card, with its finish', async () => {
  const [r] = await quote(['rev Charizard ex 125/197']);
  assert.equal(r.status, 'priced');
  assert.equal(r.card.id, 'sv3-125');
  assert.equal(r.finish, 'reverse_holo');
  assert.equal(r.price.market, 6.25, 'priced from the reverse holo fields');
  assert.equal(r.rescue, 'qualifiers_moved');

  const [n] = await quote(['6/102 Gyarados']);
  assert.equal(n.status, 'priced');
  assert.equal(n.card.id, 'base1-6');
});

test('a wrong total after a moved qualifier asks; it does not blame the name', async () => {
  // Found on production after the first deploy: "rev Gengar 94/162" said "We
  // couldn't find that name", while "Gengar 94/162" asked which Gengar. The
  // rewrite's question was dropped because the typed total ruled it out.
  const [r] = await quote(['rev Gyarados 6/999']);
  assert.equal(r.status, 'ask');
  assert.ok(r.candidates.some((c) => c.card.id === 'base1-6'));
  assert.equal(r.finish, 'reverse_holo');
});

test('1st Edition, however it is written, is priced by hand', async () => {
  const rows = await quote(['1st Edition Gyarados 6/102', 'Gyarados 6/102 first edition', 'first edition Gyarados 6/102']);
  for (const r of rows) {
    assert.equal(r.status, 'unpriced', r.line);
    assert.equal(r.unpriced_reason, 'first_edition', r.line);
    assert.equal(r.card.id, 'base1-6', r.line);
  }
});

test('quantities reach the quote', async () => {
  const rows = await quote(['2 x Gyarados 6/102', 'Gyarados 6/102 x3', 'Gyarados\t6/102\t4']);
  assert.deepEqual(rows.map((r) => [r.status, r.qty]), [['priced', 2], ['priced', 3], ['priced', 4]]);
});

test('a set name on the line is set aside, and checked against the card', async () => {
  const rows = await quote(['Gyarados Base Set 6/102', 'Base Set Gyarados 6/102', 'Gyarados - Base Set - 6/102']);
  for (const r of rows) {
    assert.equal(r.status, 'priced', r.line);
    assert.equal(r.card.id, 'base1-6', r.line);
    assert.equal(r.rescue, 'context_dropped', r.line);
  }
  // Words that say nothing about the set: ask, do not assert.
  const [red] = await quote(['Gyarados Red Cheeks 6/102']);
  assert.equal(red.status, 'ask');
  assert.equal(red.rescue, 'context_unconfirmed');
  assert.equal(red.question, 'Is this your card?');
  assert.deepEqual(red.candidates.map((c) => c.card.id), ['base1-6']);
});

test('the set name settles a question the number cannot', async () => {
  const [plain] = await quote(['Water Energy 132/132']);
  assert.equal(plain.status, 'ask', 'two 132-card sets with a Water Energy at 132');
  const [named] = await quote(['Water Energy Gym Heroes 132/132']);
  assert.equal(named.status, 'priced');
  assert.equal(named.card.id, 'gym1-132');
});

test('a graded card is priced by hand, never as a raw copy', async () => {
  const [r] = await quote(['Gyarados 6/102 PSA 9']);
  assert.equal(r.status, 'unpriced');
  assert.equal(r.unpriced_reason, 'graded');
  assert.equal(r.card.id, 'base1-6');
});

test('a language written out in full is honoured', async () => {
  const [r] = await quote(['Gyarados Japanese 6/102']);
  assert.equal(r.status, 'not_supported');
  assert.match(r.message, /Japanese/);
});

test('"Light Dragonite" is not a lightly played Dragonite', async () => {
  const [a, b] = await quote(['Light Dragonite 14/105', 'Light Dragonite 14/105 pl']);
  assert.equal(a.status, 'priced');
  assert.equal(a.condition, 'NM');
  assert.equal(a.condition_multiplier, 1);
  assert.equal(a.rescue, undefined, 'resolved as typed, no rewrite');
  assert.equal(b.condition, 'PL');
});

test('a broken trend is not quoted; a dip is smoothed and flagged', async () => {
  const [g, p] = await quote(['Gengar 94/102', 'Pikachu 58/102']);
  assert.equal(g.status, 'unpriced');
  assert.equal(g.unpriced_reason, 'price_unstable', 'trend 0.02 beside avg30 908.54');
  assert.equal(p.status, 'priced');
  assert.equal(p.price.market, 20, 'median of trend 5, avg7 20, avg30 21');
  assert.equal(p.price.dip, true);

  // The spike direction is unchanged: capped to the 30-day average.
  const spike = marketPriceOf(row('x', '1', 'A', 1, 100, { avg7: 100, avg30: 10 }));
  assert.equal(spike.value, 10);
  assert.equal(spike.capped, true);
  // Cheap cards wobble; under BROKEN_MIN_EUR the median is used, not "by hand".
  const cheap = marketPriceOf(row('x', '1', 'A', 1, 0.05, { avg7: 1.28, avg30: 1.08 }));
  assert.equal(cheap.value, 1.08);
});

test('rewrites are bounded per request, and running out is counted', async () => {
  resetQuoteBatchCounts();
  const [r] = await quote(['Gyarados Base Set 6/102'], { rewriteBudget: 0 });
  assert.equal(r.status, 'not_found', 'answered as typed once the budget is spent');
  assert.equal(getQuoteBatchCounts().rewrite_budget_exhausted, 1);
});

test('every line read by a rewrite is counted by kind', async () => {
  resetQuoteBatchCounts();
  await quote(['rev Charizard ex 125/197', 'Gyarados Base Set 6/102', 'Gyarados Red Cheeks 6/102', 'Gyarados 6/102']);
  const c = getQuoteBatchCounts();
  assert.deepEqual(c.rescued_by, { qualifiers_moved: 1, context_dropped: 1, context_unconfirmed: 1 });
  assert.equal(c.rescued_ratio, 3 / 4);
});
