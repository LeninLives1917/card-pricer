// Pins the same defect as tcggo-product-match.spec.js and
// justtcg-product-match.spec.js, in the third adapter — the one nobody
// audited, and the one that sits HIGHEST in the cascade.
//
// pricing/adapters/pokemontcg.js:594 did:
//
//   let bestMatch = resp.data.data[0];
//   if (card.card_number) {
//     const targetNum = card.card_number.replace(/\/.*/, '');
//     const exact = resp.data.data.find(c => c.number === targetNum);
//     if (exact) bestMatch = exact;
//   }
//
// Three ways that produced a confident wrong price:
//   1. the query fell back to `name:"${card.name}"` whenever set_code or
//      card_number was missing, so there was no number to check AT ALL;
//   2. `c.number === targetNum` is unnormalised, so "056" !== "56" and a
//      correct candidate was skipped in favour of hit #1;
//   3. pokemontcg.js never imported price-match-counters, so the per-source
//      health line built to catch exactly this could not see it.
//
// The result reached bestPrice by the shortest route in the whole cascade:
//   prices.cardmarket_price
//     -> price.js:255-256  pricing.cardmarket.price
//     -> price.js:374      bestPrice          (first rung after graded)
//
// Verified red against the reinjected `let bestMatch = resp.data.data[0]`.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { axios } from '../../apps/server/_clients.js';
import { pricePokemonCard } from '../../pricing/adapters/pokemontcg.js';
import {
  getPriceMatchCounts,
  resetPriceMatchCounts,
} from '../../infra/observability/price-match-counters.js';

/** The card from the incident: Charizard ex, SVP 056, ~EUR 15 on Cardmarket. */
const CHARIZARD = {
  game: 'pokemon',
  name: 'Charizard ex',
  card_number: '056',
  set_code: 'SVP',
};

const row = (number, cmLow, setName = 'Some Set') => ({
  name: 'Charizard ex',
  number: String(number),
  set: { id: setName.toLowerCase().replace(/\s+/g, ''), name: setName },
  images: { large: `https://example.invalid/${number}.png` },
  rarity: 'Double Rare',
  cardmarket: { prices: { lowPriceExPlus: cmLow, trendPrice: cmLow } },
});

/** No #56 anywhere — the page shape that produced EUR 561.50. */
const WRONG_PAGE = [row(223, 561.5, 'Obsidian Flames'), row(125, 96, 'Paldean Fates')];

let realGet, calls, lastParams;

function serve(page) {
  calls = 0;
  lastParams = null;
  axios.get = async (_url, cfg) => {
    calls += 1;
    lastParams = cfg?.params ?? null;
    return { data: { data: page } };
  };
}

describe('pokemontcg.io product match gate', () => {
  beforeEach(() => {
    realGet = axios.get;
    resetPriceMatchCounts();
  });

  afterEach(() => {
    axios.get = realGet;
    resetPriceMatchCounts();
  });

  test('THE INCIDENT: no candidate carries the number, so nothing is priced', async () => {
    serve(WRONG_PAGE);
    const out = await pricePokemonCard(CHARIZARD);

    // The old code returned WRONG_PAGE[0] and set cardmarket_price = 561.50,
    // which price.js:374 then promoted straight to bestPrice.
    assert.equal(out.cardmarket_price, undefined);
    assert.equal(out.pokemontcg, undefined);

    const c = getPriceMatchCounts();
    assert.equal(c.by_source.pokemontcg.matched, 0);
    assert.equal(c.by_source.pokemontcg.rejected_no_number_match, 1);
    assert.equal(c.last_rejection.source, 'pokemontcg');
    assert.equal(c.last_rejection.requested, '56');
  });

  test('the source now appears in by_source at all — it never did before', async () => {
    serve(WRONG_PAGE);
    await pricePokemonCard(CHARIZARD);
    assert.ok(
      'pokemontcg' in getPriceMatchCounts().by_source,
      'health price_match.by_source could not see this adapter before the gate',
    );
  });

  test('the right printing is priced when it is on the page', async () => {
    serve([...WRONG_PAGE, row(56, 15.0, 'Scarlet & Violet Black Star Promos')]);
    const out = await pricePokemonCard(CHARIZARD);
    assert.equal(out.cardmarket_price, 15.0);
    assert.equal(out.pokemontcg.number, '56');
    assert.equal(getPriceMatchCounts().by_source.pokemontcg.matched, 1);
  });

  test('leading zeros do not cause a false rejection', async () => {
    // "056" vs upstream "56" answered FALSE under `c.number === targetNum`,
    // silently dropping the correct candidate through to hit #1.
    serve([row(56, 15.0)]);
    const out = await pricePokemonCard({ ...CHARIZARD, card_number: '056/197' });
    assert.ok(out.cardmarket_price, '056/197 must match upstream 56');
    assert.equal(out.pokemontcg.requested_number, '56');
  });

  test('a card with no number is never priced by a name-only search', async () => {
    // The old `else { query = `name:"${card.name}"` }` branch had nothing to
    // check against, so hit #1 was always returned.
    serve(WRONG_PAGE);
    const out = await pricePokemonCard({ ...CHARIZARD, card_number: null });
    assert.equal(out.cardmarket_price, undefined);
    assert.equal(calls, 0, 'must abstain before spending a request');
    assert.equal(getPriceMatchCounts().by_source.pokemontcg.rejected_no_number_read, 1);
  });

  test('an empty upstream page counts as absent, not as a match failure', async () => {
    serve([]);
    await pricePokemonCard(CHARIZARD);
    const s = getPriceMatchCounts().by_source.pokemontcg;
    assert.equal(s.no_candidates, 1);
    assert.equal(s.rejected_no_number_match, 0);
  });

  test('the printed set code is resolved, not lowercased into a bogus set id', async () => {
    // `set.id:${card.set_code.toLowerCase()}` turned PAF into set.id:paf,
    // which does not exist upstream, so the search returned nothing.
    serve([row(224, 3.0, 'Paldean Fates')]);
    await pricePokemonCard({ ...CHARIZARD, card_number: '224', set_code: 'PAF' });
    assert.match(String(lastParams.q), /set\.id:sv4pt5/);
    assert.doesNotMatch(String(lastParams.q), /set\.id:paf/);
  });

  test('the search page is wide enough for the gate to find the card', async () => {
    serve([row(56, 15.0)]);
    await pricePokemonCard(CHARIZARD);
    assert.ok(
      lastParams.pageSize >= 20,
      'a 5-result page turns a correct card into no price once the gate rejects',
    );
  });

  test('counts stay per source, so one adapter cannot mask another', async () => {
    serve(WRONG_PAGE);
    await pricePokemonCard(CHARIZARD);
    const c = getPriceMatchCounts();
    assert.deepEqual(Object.keys(c.by_source), ['pokemontcg']);
    assert.equal(c.by_source.tcggo, undefined, 'tcggo was never asked and must not read as 0%');
  });

  test('match_rate is null when nothing was ever asked', () => {
    assert.equal(getPriceMatchCounts().match_rate, null);
  });
});
