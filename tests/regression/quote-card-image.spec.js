// Regression: every card in a quote carries a picture link, for the
// "which one is yours?" picker on the website (/sell-cards).
//
// WHY (7 Oct 2026): the reprint question asks the customer whether their
// Charizard 4/102 has an anniversary stamp, and the options read "Base",
// "Celebrations: Classic Collection" and "30th Celebration: Classic
// Collection". A customer holding the card knows it by sight, not by set name;
// Dave asked for a photo on each option.
//
// The links point at the source CDNs (images.pokemontcg.io, assets.tcgdex.net);
// nothing is copied. The cases below were each checked against the CDN that
// day: the cel25c images exist only under "_A", number 15 in cel25c is four
// cards behind two images (so none), 30th Celebration is on TCGdex with a
// 3-digit number, and its Classic Collection has no images anywhere yet.
//
// DI throughout (handleQuoteBatch(body, deps)); no mock.module().

import test from 'node:test';
import assert from 'node:assert/strict';

import { cardImageUrl } from '../../pricing/quote-prices/card-image.js';
import { handleQuoteBatch } from '../../apps/server/routes/quote-batch.js';
import { buildPriceIndex } from '../../pricing/quote-prices/feed-index.js';
import { loadSets } from '../../pricing/set-resolve.js';

test('picture links, per source', () => {
  assert.equal(cardImageUrl('base1-4'), 'https://images.pokemontcg.io/base1/4.png');
  assert.equal(cardImageUrl('ecard3-H9'), 'https://images.pokemontcg.io/ecard3/H9.png');
  assert.equal(cardImageUrl('cel25c-4'), 'https://images.pokemontcg.io/cel25c/4_A.png');
  assert.equal(cardImageUrl('cel25c-4_A'), 'https://images.pokemontcg.io/cel25c/4_A.png');
  assert.equal(cardImageUrl('cel25c-15'), null, 'four cards share number 15');
  assert.equal(cardImageUrl('cel25c-15_A3'), null);
  assert.equal(cardImageUrl('me55-152'), 'https://assets.tcgdex.net/en/me/30th/152/low.webp');
  assert.equal(cardImageUrl('me55-1'), 'https://assets.tcgdex.net/en/me/30th/001/low.webp');
  assert.equal(cardImageUrl('me55c-4'), null);
  assert.equal(cardImageUrl('nonsense'), null);
  assert.equal(cardImageUrl('base1-4"><script>'), null, 'only plain ids become URLs');
});

test('the reprint question carries a picture for every option that has one', async () => {
  const db = new Map([
    ['base1-4', { name: 'Charizard', setName: 'Base' }],
    ['cel25c-4', { name: 'Charizard', setName: 'Celebrations: Classic Collection' }],
  ]);
  const row = (set, local, name, id, trend) => [
    set, local, name, id, trend, trend, trend, trend, trend / 4,
    null, null, null, null, null, false, false,
  ];
  const feed = {
    snapshot_date: '2026-10-07',
    sets: [
      ['base1', 'Base Set', 'BS', 102, 102, '1999-01-09'],
      ['cel25cc', 'Celebrations Classic Collection', 'CEL:CC', 25, 25, '2021-10-08'],
    ],
    cards: [row('base1', '4', 'Charizard', 1, 250), row('cel25cc', 'CC002', 'Charizard', 2, 155)],
  };
  const res = await handleQuoteBatch(
    { lines: ['Charizard 4/102'], game: 'pokemon' },
    { cardDb: db, priceIndex: buildPriceIndex(feed, db, loadSets(), []), now: Date.parse('2026-10-07T10:00:00Z') },
  );
  const [ask] = res.body.rows;
  assert.equal(ask.status, 'ask');
  const images = Object.fromEntries(ask.candidates.map((c) => [c.card.id, c.card.image]));
  assert.equal(images['base1-4'], 'https://images.pokemontcg.io/base1/4.png');
  assert.equal(images['cel25c-4'], 'https://images.pokemontcg.io/cel25c/4_A.png');
});
