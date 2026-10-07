// Regression: a card worth more than the hand-price line is priced in the
// shop, never quoted online.
//
// INCIDENT PINNED (7 Oct 2026, the morning the whole-list quote went live):
//
// Once the hub's product fill priced the older sets, "Gengar H9/H32" (the
// Skyridge holo) offered a candidate at EUR 4,217.75, Cardmarket's trend,
// while the cheapest copy for sale was EUR 450. On a card like that the
// guide's number is a thin market's say-so, and condition and fakes move it by
// more than an online quote can carry. Dave's call, same morning: any card
// valued over EUR 300 comes back "we'll price this by hand".
//
// What "valued" means, pinned below: the card's own guide value (the reverse
// holo value for a reverse), BEFORE any condition mark-down, and per card, not
// multiplied by quantity. A played copy of a EUR 670 card is still a card to
// see in person; three copies of a EUR 150 card are three EUR 150 cards. A
// withheld card carries no number in the response, and a question option over
// the line settles as by hand when the customer picks it.
//
// DI throughout (handleQuoteBatch(body, deps)); no mock.module().

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { handleQuoteBatch, HAND_PRICE_ABOVE_EUR } from '../../apps/server/routes/quote-batch.js';
import { buildPriceIndex } from '../../pricing/quote-prices/feed-index.js';
import { loadSets } from '../../pricing/set-resolve.js';
import { entryOf, resolveAsk } from '../../apps/quote/modules/batch.js';
import { getQuoteBatchCounts, resetQuoteBatchCounts } from '../../infra/observability/quote-batch-counters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = Date.parse('2026-10-07T01:00:00Z');

const cardDb = () => new Map([
  ['swsh7-215', { name: 'Umbreon VMAX', setName: 'Evolving Skies' }],
  ['swsh7-95', { name: 'Umbreon VMAX', setName: 'Evolving Skies' }],
  ['gym2-2', { name: "Blaine's Charizard", setName: 'Gym Challenge' }],
  ['dp3-2', { name: 'Blastoise', setName: 'Secret Wonders' }],
  ['sv3-125', { name: 'Charizard ex', setName: 'Obsidian Flames' }],
  ['base1-4', { name: 'Charizard', setName: 'Base' }],
  ['cel25c-4', { name: 'Charizard', setName: 'Celebrations: Classic Collection' }],
  ['base1-6', { name: 'Gyarados', setName: 'Base' }],
]);

// [set, local, name, id_product, trend, avg7, avg30, avg, low,
//  trend_holo, avg7_holo, avg30_holo, avg_holo, low_holo, first_ed, has_reverse]
const row = (set, local, name, id, trend, o = {}) => [
  set, local, name, id, trend, o.avg7 ?? trend, o.avg30 ?? trend, trend, trend / 4,
  o.holo ?? null, o.holo ?? null, o.holo ?? null, null, null, !!o.firstEd, !!o.reverse,
];

// Real guide numbers from 7 Oct 2026 where the card is real (Umbreon VMAX
// 215/203, Charizard ex 125/197); the rest are the quote-batch.spec.js values.
const FEED = {
  snapshot_date: '2026-10-07',
  cache_built_at: '2026-10-07T09:20:00Z',
  sets: [
    ['swsh7', 'Evolving Skies', 'EVS', 203, 237, '2021-08-27'],
    ['gym2', 'Gym Challenge', 'G2', 132, 132, '2000-10-16'],
    ['dp3', 'Secret Wonders', 'SW', 132, 132, '2007-11-01'],
    ['sv03', 'Obsidian Flames', 'OBF', 197, 230, '2023-08-11'],
    ['base1', 'Base Set', 'BS', 102, 102, '1999-01-09'],
    ['cel25cc', 'Celebrations Classic Collection', 'CEL:CC', 25, 25, '2021-10-08'],
  ],
  cards: [
    row('swsh7', '215', 'Umbreon VMAX', 574273, 2026.85, { avg7: 2079.63, avg30: 1762.99 }),
    row('swsh7', '095', 'Umbreon VMAX', 574100, 41.2),
    row('gym2', '2', "Blaine's Charizard", 1003, 670.21),
    row('dp3', '2', 'Blastoise', 1004, 20.12),
    row('sv03', '125', 'Charizard ex', 725205, 3.51, { reverse: true, holo: 6.25 }),
    row('base1', '4', 'Charizard', 273699, 569.73, { firstEd: true }),
    row('cel25cc', 'CC002', 'Charizard', 1002, 213.52),
    row('base1', '6', 'Gyarados', 1007, 150),
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

test('the line is EUR 300', () => {
  assert.equal(HAND_PRICE_ABOVE_EUR, 300);
});

test('a card valued over the line is by hand, and its number is not in the response', async () => {
  const [moon, plain] = await quote(['Umbreon VMAX 215/203', 'Umbreon VMAX 95/203']);
  assert.equal(moon.status, 'unpriced');
  assert.equal(moon.unpriced_reason, 'high_value');
  assert.equal(moon.card.id, 'swsh7-215', 'the card is still identified');
  assert.equal(moon.price, undefined);
  assert.doesNotMatch(JSON.stringify(moon), /2026\.85|2,026/, 'the guide value is not leaked');

  assert.equal(plain.status, 'priced', 'the regular Umbreon VMAX is an ordinary quote');
  assert.equal(plain.price.market, 41.2);
});

test('valued before condition: a played copy of a EUR 670 card is still seen in person', async () => {
  const [r] = await quote(["Blaine's Charizard 2/132 pl"]);
  assert.equal(r.card.id, 'gym2-2');
  assert.equal(r.condition, 'PL', '670.21 x 0.40 would be 268.08, under the line');
  assert.equal(r.status, 'unpriced');
  assert.equal(r.unpriced_reason, 'high_value');
});

test('per card, not per line: three EUR 150 cards are three ordinary quotes', async () => {
  const [r] = await quote(['3x Gyarados 6/102']);
  assert.equal(r.status, 'priced');
  assert.equal(r.qty, 3);
  assert.equal(r.price.market, 150);
});

test('the boundary: AT the line is quoted, over it is not', async () => {
  const [at] = await quote(['Blastoise 2/132'], { handPriceAboveEur: 20.12 });
  assert.equal(at.status, 'priced');
  const [over] = await quote(['Blastoise 2/132'], { handPriceAboveEur: 20.11 });
  assert.equal(over.status, 'unpriced');
  assert.equal(over.unpriced_reason, 'high_value');
});

test('a reverse holo is judged on the reverse holo value', async () => {
  const [normal, rev] = await quote(['Charizard ex 125/197', 'rev Charizard ex 125/197'], { handPriceAboveEur: 5 });
  assert.equal(normal.status, 'priced', 'normal 3.51');
  assert.equal(rev.status, 'unpriced', 'reverse 6.25');
  assert.equal(rev.unpriced_reason, 'high_value');
});

test('a question option over the line carries no price, and picking it is by hand', async () => {
  const [ask] = await quote(['bla 2/132']);
  assert.equal(ask.status, 'ask');
  const blaine = ask.candidates.find((c) => c.card.id === 'gym2-2');
  const blastoise = ask.candidates.find((c) => c.card.id === 'dp3-2');
  assert.equal(blaine.price, null);
  assert.equal(blaine.unpriced_reason, 'high_value');
  assert.equal(blastoise.price.market, 20.12, 'the cheap option keeps its price');

  // The page settles the pick from the row alone (apps/quote/modules/batch.js).
  const entry = entryOf(ask, 55, 70);
  const picked = resolveAsk(entry, ask.candidates.indexOf(blaine), 55, 70);
  assert.equal(picked.byHand, true);
  assert.equal(picked.reason, 'high_value');
  assert.equal(picked.card.id, 'gym2-2');
});

test('the reprint question: an original over the line is by hand, its reprints still price', async () => {
  const [ask] = await quote(['Charizard 4/102']);
  assert.equal(ask.reprint_question, true);
  const original = ask.candidates.find((c) => c.card.id === 'base1-4');
  const cel = ask.candidates.find((c) => c.card.id === 'cel25c-4');
  assert.equal(original.price, null);
  assert.equal(original.unpriced_reason, 'high_value');
  assert.equal(cel.price.market, 213.52);

  // A line that names the reprint goes straight to it, and is judged the same.
  const [named] = await quote(['cha 4/102 celebrations'], { handPriceAboveEur: 200 });
  assert.equal(named.card.id, 'cel25c-4');
  assert.equal(named.status, 'unpriced');
  assert.equal(named.unpriced_reason, 'high_value');
});

test('counted: /api/health -> quote_batch.unpriced_by_reason.high_value', async () => {
  resetQuoteBatchCounts();
  await quote(['Umbreon VMAX 215/203', 'Umbreon VMAX 95/203']);
  const c = getQuoteBatchCounts();
  assert.equal(c.unpriced_by_reason.high_value, 1);
  assert.equal(c.priced, 1);
});

test('the page says it: words for the reason, and the same line in the instructions', async () => {
  const main = await readFile(join(ROOT, 'apps/quote/modules/main.js'), 'utf8');
  assert.match(main, /\bhigh_value:\s*['"]/, 'BY_HAND_REASONS has customer words for high_value');
  const page = await readFile(join(ROOT, 'apps/quote/index.html'), 'utf8');
  assert.ok(page.includes(`€${HAND_PRICE_ABOVE_EUR}`),
    'the step text names the same line the server uses; change both together');
});
