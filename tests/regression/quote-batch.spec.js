// Regression: the whole-list customer quote (POST /api/v2/quote/batch).
//
// INCIDENTS PINNED (7 Oct 2026):
//
//   1. The quote page could price 4 cards. It made two live requests per card
//      behind one 10/hour limiter shared with the email step. This route makes
//      a whole list ONE request, matched locally and priced from the hub's
//      daily Cardmarket price guide. (The limiter itself is pinned in
//      quote-rate-limits.spec.js.)
//   2. "Charizard 4/102" resolved to the Base Set original for a customer
//      holding a Celebrations Classic Collection reprint, which prints the same
//      name and number. Measured: 18 of 18 wrong answers in a whole-catalogue
//      sweep of "name number/total" were exactly this. It must be ASKED.
//   3. "CRI 12/86" failed for all 241 Chaos Rising / Pitch Black cards because
//      the set codes were missing from the alias table.
//
// DI throughout (handleQuoteBatch(body, deps)); no mock.module().

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleQuoteBatch, MAX_BATCH_LINES, linesOf } from '../../apps/server/routes/quote-batch.js';
import { buildPriceIndex, marketPriceOf, normCardNumber, tcgdexSetFor, namesAgree, COL }
  from '../../pricing/quote-prices/feed-index.js';
import { loadSets } from '../../pricing/set-resolve.js';

const NOW = Date.parse('2026-10-07T01:00:00Z');

const cardDb = () => new Map([
  ['base1-4', { name: 'Charizard', setName: 'Base' }],
  ['base4-4', { name: 'Charizard', setName: 'Base Set 2' }],
  ['cel25c-4', { name: 'Charizard', setName: 'Celebrations: Classic Collection' }],
  ['sv3-125', { name: 'Charizard ex', setName: 'Obsidian Flames' }],
  ['gym2-2', { name: "Blaine's Charizard", setName: 'Gym Challenge' }],
  ['dp3-2', { name: 'Blastoise', setName: 'Secret Wonders' }],
  ['me4-12', { name: 'Braixen', setName: 'Chaos Rising' }],
  ['base1-58', { name: 'Pikachu', setName: 'Base' }],
  ['base1-6', { name: 'Gyarados', setName: 'Base' }],
  ['sv2-100', { name: 'Spikey Mon', setName: 'Paldea Evolved' }],
]);

// [set, local, name, id_product, trend, avg7, avg30, avg, low,
//  trend_holo, avg7_holo, avg30_holo, avg_holo, low_holo, first_ed, has_reverse]
const row = (set, local, name, id, trend, opts = {}) => [
  set, local, name, id, trend, opts.avg7 ?? trend, opts.avg30 ?? trend, trend, trend / 4,
  opts.holo ?? null, null, null, null, null, !!opts.firstEd, !!opts.reverse,
];

const FEED = {
  snapshot_date: '2026-10-06',
  cache_built_at: '2026-10-06T23:20:00Z',
  sets: [
    ['base1', 'Base Set', 'BS', 102, 102, '1999-01-09'],
    ['base4', 'Base Set 2', 'B2', 130, 130, '2000-02-24'],
    ['cel25cc', 'Celebrations Classic Collection', 'CEL:CC', 25, 25, '2021-10-08'],
    ['sv02', 'Paldea Evolved', 'PAL', 193, 279, '2023-06-09'],
    ['sv03', 'Obsidian Flames', 'OBF', 197, 230, '2023-08-11'],
    ['gym2', 'Gym Challenge', 'G2', 132, 132, '2000-10-16'],
    ['dp3', 'Secret Wonders', 'SW', 132, 132, '2007-11-01'],
    ['me04', 'Chaos Rising', 'CRI', 86, 122, '2026-05-22'],
    ['30th-c', '30th Classic Collection', '30C', 30, 30, '2026-09-16'],
  ],
  cards: [
    row('base1', '4', 'Charizard', 273699, 569.73, { firstEd: true }),
    row('base4', '4', 'Charizard', 1001, 310.4),
    row('cel25cc', 'CC002', 'Charizard', 1002, 213.52),
    row('sv03', '125', 'Charizard ex', 725205, 3.47, { reverse: false }),
    row('gym2', '2', "Blaine's Charizard", 1003, 670.21),
    row('dp3', '2', 'Blastoise', 1004, 20.12, { reverse: true, holo: 31.5 }),
    row('me04', '012', 'Braixen', 1005, 0.03),
    row('base1', '58', 'Pikachu', 1006, 5, { firstEd: true }),
    row('base1', '6', 'Gyarados', 1007, 21.54),
    row('sv02', '100', 'Spikey Mon', 1008, 100, { avg30: 10 }),
    row('30th-c', '001', 'Charizard', null, null),
  ],
};

const REPRINTS = [{
  set_id: 'me55c', set_name: '30th Celebration: Classic Collection',
  label: '30th Celebration Classic Collection reprint (2026)', tcgdex_set: '30th-c',
  upstream_id: 'me55c-4', name: 'Charizard', number: '4',
}];

const indexFor = (db, feed = FEED) => buildPriceIndex(feed, db, loadSets(), REPRINTS);

async function quote(lines, over = {}) {
  const db = over.cardDb ?? cardDb();
  const res = await handleQuoteBatch(
    { lines, game: over.game ?? 'pokemon' },
    { cardDb: db, priceIndex: over.priceIndex !== undefined ? over.priceIndex : indexFor(db), now: over.now ?? NOW },
  );
  return res;
}

test('the hub join maps catalogue cards by set, number AND name', () => {
  const idx = indexFor(cardDb());
  assert.equal(idx.stats.catalogue_cards, 10);
  assert.equal(idx.byCatalogueKey.get('sv3-125')[COL.idProduct], 725205, 'sv3 -> sv03, 125 -> 125');
  assert.equal(idx.byCatalogueKey.get('me4-12')[COL.idProduct], 1005, 'me4 -> me04, 12 -> 012');
  assert.equal(idx.byCatalogueKey.get('cel25c-4')[COL.idProduct], 1002,
    'Classic Collection numbers differ between sources (4 vs CC002): matched by unique name');
});

test('a number that matches with a name that does not is refused, not trusted', () => {
  const db = new Map([['sv3-125', { name: 'Pikachu', setName: 'Obsidian Flames' }]]);
  const idx = indexFor(db);
  assert.equal(idx.byCatalogueKey.has('sv3-125'), false);
  assert.equal(idx.stats.name_mismatch, 1);
});

test('normalisation and set mapping', () => {
  assert.equal(normCardNumber('004'), '4');
  assert.equal(normCardNumber('SV001'), 'SV1');
  assert.equal(normCardNumber('TG01'), 'TG1');
  assert.equal(normCardNumber('189a'), '189A');
  const ids = new Set(['sv03.5', 'me02.5', 'sv10', 'lc', 'base1']);
  assert.equal(tcgdexSetFor('sv3pt5', ids), 'sv03.5');
  assert.equal(tcgdexSetFor('me2pt5', ids), 'me02.5');
  assert.equal(tcgdexSetFor('sv10', ids), 'sv10');
  assert.equal(tcgdexSetFor('base6', ids), 'lc');
  assert.equal(tcgdexSetFor('base1', ids), 'base1');
  assert.equal(tcgdexSetFor('nope', ids), null);
  assert.ok(namesAgree('Umbreon ★', 'Umbreon'));
  assert.ok(namesAgree('M Charizard-EX', 'M Charizard EX'));
  assert.ok(!namesAgree('Pikachu', 'Raichu'));
});

test('price selection: trend, spike cap, reverse holo, 1st Edition, no product', () => {
  assert.deepEqual(marketPriceOf(row('x', '1', 'A', 1, 12.5)).value, 12.5);
  const spike = marketPriceOf(row('x', '1', 'A', 1, 100, { avg30: 10 }));
  assert.equal(spike.value, 10);
  assert.equal(spike.capped, true, 'a trend over 3x the 30-day average is capped and flagged');
  const rev = marketPriceOf(row('x', '1', 'A', 1, 20, { reverse: true, holo: 31.5 }), { finish: 'reverse_holo' });
  assert.equal(rev.value, 31.5);
  assert.equal(rev.field, 'trend_holo');
  const noRev = marketPriceOf(row('x', '1', 'A', 1, 20, { reverse: false }), { finish: 'reverse_holo' });
  assert.equal(noRev.value, 20);
  assert.equal(noRev.finish_fallback, true, 'no reverse printing: priced as the card that exists, and said so');
  assert.equal(marketPriceOf(row('x', '1', 'A', 1, 20), { finish: 'first_edition' }).value, null);
  assert.equal(marketPriceOf(row('x', '1', 'A', null, null)).reason, 'no_cardmarket_product');
});

test('a whole list is ONE request: priced, asked, by hand and not found, with reasons', async () => {
  const res = await quote([
    'Charizard ex 125/197',
    'bla 2/132',
    'CRI 12/86',
    'Pikachu 58/102 1st edition',
    '3x Gyarados 6/102 lp',
    'Pikachu 58/102 jp',
    'xyz',
  ]);
  assert.equal(res.status, 200);
  const [ex, bla, cri, first, gyara, jp, xyz] = res.body.rows;

  assert.equal(ex.status, 'priced');
  assert.equal(ex.card.id, 'sv3-125');
  assert.equal(ex.price.market, 3.47);
  assert.equal(ex.price.as_of, '2026-10-06');

  assert.equal(bla.status, 'ask', "Blastoise and Blaine's Charizard share bla|2|132: never guessed");
  assert.deepEqual(bla.candidates.map((c) => c.card.id).sort(), ['dp3-2', 'gym2-2']);
  const blastoise = bla.candidates.find((c) => c.card.id === 'dp3-2');
  assert.equal(blastoise.price.market, 20.12, 'candidates carry prices');
  const blaine = bla.candidates.find((c) => c.card.id === 'gym2-2');
  assert.equal(blaine.price.market, 670.21, 'no value line by default (quote-high-value.spec.js)');

  assert.equal(cri.status, 'priced', 'CRI is a real set code (Chaos Rising)');
  assert.equal(cri.card.id, 'me4-12');

  assert.equal(first.status, 'unpriced');
  assert.equal(first.unpriced_reason, 'first_edition', 'the guide does not split 1st Edition: by hand');

  assert.equal(gyara.status, 'priced');
  assert.equal(gyara.qty, 3);
  assert.equal(gyara.condition, 'LP');
  assert.equal(gyara.condition_multiplier, 0.58, 'Cardmarket LP from pricing/conditions.js');

  assert.equal(jp.status, 'not_supported');
  assert.equal(xyz.status, 'not_found');
  assert.ok(xyz.message.length > 10, 'a not-found row says what to add');

  assert.equal(res.body.summary.lines, 7);
  assert.equal(res.body.summary.cards_priced, 1 + 1 + 3);
});

test('THE REPRINT CASE: "Charizard 4/102" is asked, never silently the original', async () => {
  const res = await quote(['Charizard 4/102']);
  const [r] = res.body.rows;
  assert.equal(r.status, 'ask');
  assert.equal(r.reprint_question, true);
  const ids = r.candidates.map((c) => c.card.id);
  assert.ok(ids.includes('base1-4'), 'the original is offered');
  assert.ok(ids.includes('cel25c-4'), 'the Celebrations reprint is offered');
  assert.ok(ids.includes('me55c-4'), 'the 30th Celebration reprint is offered');
  const cel = r.candidates.find((c) => c.card.id === 'cel25c-4');
  assert.equal(cel.price.market, 213.52);
  const thirty = r.candidates.find((c) => c.card.id === 'me55c-4');
  assert.equal(thirty.price, null, 'not on Cardmarket yet: priced by hand, not guessed');
});

test('1st Edition is the original by definition: no reprint question, priced by hand', async () => {
  const res = await quote(['Charizard 4/102 1st edition']);
  const [r] = res.body.rows;
  assert.equal(r.status, 'unpriced');
  assert.equal(r.unpriced_reason, 'first_edition');
  assert.equal(r.card.id, 'base1-4');
});

test('a line that SAYS which reprint goes straight to it', async () => {
  const res = await quote(['cha 4/102 celebrations']);
  const [r] = res.body.rows;
  assert.equal(r.status, 'priced');
  assert.equal(r.card.id, 'cel25c-4');
  assert.equal(r.price.market, 213.52);
});

test('a spiking price is capped to the 30-day average and flagged', async () => {
  const res = await quote(['Spikey Mon 100/193']);
  const [r] = res.body.rows;
  assert.equal(r.status, 'priced');
  assert.equal(r.price.market, 10);
  assert.equal(r.price.capped, true);
});

test('a stale or missing price feed prices nothing, and says why', async () => {
  const stale = await quote(['Charizard ex 125/197'], { now: Date.parse('2026-10-12T00:00:00Z') });
  assert.equal(stale.body.prices_usable, false);
  assert.equal(stale.body.rows[0].status, 'unpriced');
  assert.equal(stale.body.rows[0].unpriced_reason, 'prices_stale');
  assert.equal(stale.body.rows[0].card.id, 'sv3-125', 'identity still works without prices');

  const none = await quote(['Charizard ex 125/197'], { priceIndex: null });
  assert.equal(none.body.rows[0].unpriced_reason, 'prices_unavailable');
});

test('bounds: too many lines is a 413, other games a 400, comments are skipped', async () => {
  const many = await quote(Array.from({ length: MAX_BATCH_LINES + 1 }, () => 'Charizard ex 125/197'));
  assert.equal(many.status, 413);
  const magic = await quote(['MKM 123'], { game: 'magic' });
  assert.equal(magic.status, 400);
  assert.deepEqual(linesOf({ text: '# header\nCharizard ex 125/197\n\n// note\n  cha 4/102  ' }),
    ['Charizard ex 125/197', 'cha 4/102']);
});
