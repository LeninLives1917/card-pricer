// Pins the same defect as tcggo-product-match.spec.js, in the adapter that sits
// directly BELOW tcggo in the price cascade (pricing/price.js).
//
// pricing/adapters/justtcg.js had `let best = data[0]` in two places and an
// unnormalised `itemNum === num` comparison. Left alone, it would have absorbed
// every card the tcggo gate started rejecting and priced it off the first search
// hit instead — the tcggo counters would have shown a gate working perfectly
// while the wrong prices carried on under a different source label. That is the
// project's standing defect shape, one rung down the cascade.
//
// Verified red against the reinjected `let best = data[0]` seeding.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { axios } from '../../apps/server/_clients.js';
import { fetchJustTCGPrice } from '../../pricing/adapters/justtcg.js';
import {
  getPriceMatchCounts,
  resetPriceMatchCounts,
} from '../../infra/observability/price-match-counters.js';

const CHARIZARD = {
  game: 'pokemon',
  name: 'Charizard ex',
  card_number: '056/197',
  set_name: 'Scarlet & Violet Black Star Promos',
  condition_estimate: 'NM',
};

const variants = (usd) => [{ condition: 'Near Mint', printing: 'Normal', price: usd }];

const row = (num, usd, setName = 'Some Set') => ({
  name: 'Charizard ex',
  number: num,
  set_name: setName,
  set: setName.toLowerCase().replace(/\s+/g, '-'),
  variants: variants(usd),
});

/** No #56 anywhere — the shape that produced the wrong price. */
const WRONG_PAGE = [row('223', 640, 'Obsidian Flames'), row('125', 96, 'Paldean Fates')];

let realGet, realKey, calls;

/** Serve `pages` in order, one per axios.get, repeating the last forever. */
function serve(...pages) {
  calls = 0;
  axios.get = async () => {
    const p = pages[Math.min(calls, pages.length - 1)];
    calls += 1;
    return { data: { data: p } };
  };
}

describe('JustTCG product match gate', () => {
  beforeEach(() => {
    realGet = axios.get;
    realKey = process.env.JUSTTCG_API_KEY;
    process.env.JUSTTCG_API_KEY = 'test-key';
    resetPriceMatchCounts();
  });

  afterEach(() => {
    axios.get = realGet;
    if (realKey === undefined) delete process.env.JUSTTCG_API_KEY;
    else process.env.JUSTTCG_API_KEY = realKey;
    resetPriceMatchCounts();
  });

  test('THE INCIDENT, one rung down: no candidate has the number, so nothing is priced', async () => {
    serve(WRONG_PAGE); // both the primary query and the retry see the same page
    const out = await fetchJustTCGPrice(CHARIZARD);

    // The old code returned WRONG_PAGE[0] and priced the €640 card.
    assert.equal(out, null);
    const c = getPriceMatchCounts();
    assert.equal(c.by_source.justtcg.matched, 0);
    assert.ok(c.by_source.justtcg.rejected_no_number_match >= 1);
  });

  test('counts are kept per source, so one adapter cannot mask the other', async () => {
    serve(WRONG_PAGE);
    await fetchJustTCGPrice(CHARIZARD);
    const c = getPriceMatchCounts();
    assert.deepEqual(Object.keys(c.by_source), ['justtcg']);
    assert.equal(c.by_source.tcggo, undefined, 'tcggo was never asked and must not appear as 0%');
    assert.equal(c.last_rejection.source, 'justtcg');
  });

  test('the right printing is priced when it is on the page', async () => {
    serve([...WRONG_PAGE, row('56', 16.5, 'Scarlet & Violet Black Star Promos')]);
    const out = await fetchJustTCGPrice(CHARIZARD);
    assert.equal(out.card_number, '56');
    assert.equal(getPriceMatchCounts().by_source.justtcg.matched, 1);
  });

  test('leading zeros do not cause a false rejection', async () => {
    // "056/197" vs upstream "56" answered false under `itemNum === num`.
    serve([row('56', 16.5)]);
    const out = await fetchJustTCGPrice(CHARIZARD);
    assert.ok(out, '056/197 must match upstream 56');
  });

  test('a rejected page triggers ONE name-only retry, which can recover the card', async () => {
    // Primary "{name} {number}" query buries the right printing; the wider
    // name-only query surfaces it. This is the coverage the gate would
    // otherwise have cost.
    serve(WRONG_PAGE, [row('56', 16.5, 'Scarlet & Violet Black Star Promos')]);
    const out = await fetchJustTCGPrice(CHARIZARD);
    assert.ok(out, 'the retry must be able to rescue a rejected lookup');
    assert.equal(out.card_number, '56');
    assert.equal(calls, 2, 'exactly one retry — the free tier is 100 calls/day');
  });

  test('no retry when the primary query was already name-only', async () => {
    // Without a number there is nothing to narrow, so the retry would repeat
    // the identical request and burn quota for nothing.
    serve(WRONG_PAGE);
    await fetchJustTCGPrice({ ...CHARIZARD, card_number: null });
    assert.equal(calls, 1);
    assert.equal(getPriceMatchCounts().by_source.justtcg.rejected_no_number_read, 1);
  });
});
