// Pins the incident of 14 Aug 2026: a Charizard ex SVP 56 with a Cardmarket
// value of roughly €15 was quoted at €561.50.
//
// pricing/adapters/tcggo-rapidapi.js seeded its product choice to `data[0]` —
// the first search result — and returned it regardless of score. A name-only
// match scored 50 of a possible 140 (wrong set, wrong number) and was priced as
// the identified card. Nothing downstream compared the priced product's number
// against the requested one, and the Cardmarket link displayed beside the price
// is built from our own identity rather than from the matched product, so the
// link was right, the price was 37x wrong, and the two never met.
//
// The gate now requires the card number to agree. These tests fail against the
// old `let best = data[0]` seeding — verified by reinjecting it.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { axios } from '../../apps/server/_clients.js';
import { fetchRapidAPICardmarketPrice } from '../../pricing/adapters/tcggo-rapidapi.js';
import { normaliseCardNumber } from '../../pricing/card-number.js';
import {
  getPriceMatchCounts,
  resetPriceMatchCounts,
} from '../../infra/observability/price-match-counters.js';

const CHARIZARD_SVP_56 = {
  game: 'pokemon',
  name: 'Charizard ex',
  card_number: '056',
  set_name: 'Scarlet & Violet Black Star Promos',
};

/** The five-result page that produced the €561.50 quote: no SVP 56 on it. */
const WRONG_PAGE = [
  {
    name: 'Charizard ex',
    card_number: '223',
    episode: { name: 'Obsidian Flames', code: 'OBF' },
    prices: { cardmarket: { lowest_near_mint: 561.5, '30d_average': 540 } },
  },
  {
    name: 'Charizard ex',
    card_number: '125',
    episode: { name: 'Paldean Fates', code: 'PAF' },
    prices: { cardmarket: { lowest_near_mint: 88.0 } },
  },
];

const priced = (num, eur, setName) => ({
  name: 'Charizard ex',
  card_number: num,
  episode: { name: setName, code: 'SVP' },
  prices: { cardmarket: { lowest_near_mint: eur, '30d_average': eur } },
});

let realGet;
let realKey;

function serve(rows) {
  axios.get = async () => ({ data: { data: rows } });
}

describe('TCGGO product match gate', () => {
  beforeEach(() => {
    realGet = axios.get;
    realKey = process.env.RAPIDAPI_KEY;
    process.env.RAPIDAPI_KEY = 'test-key';
    resetPriceMatchCounts();
  });

  afterEach(() => {
    axios.get = realGet;
    if (realKey === undefined) delete process.env.RAPIDAPI_KEY;
    else process.env.RAPIDAPI_KEY = realKey;
    resetPriceMatchCounts();
  });

  test('THE INCIDENT: no candidate carries the requested number, so nothing is priced', async () => {
    serve(WRONG_PAGE);
    const out = await fetchRapidAPICardmarketPrice(CHARIZARD_SVP_56);

    // The old code returned WRONG_PAGE[0] and priced it at 561.5.
    assert.equal(out, null, 'a card we cannot attribute must not be priced');

    const c = getPriceMatchCounts();
    assert.equal(c.rejected_no_number_match, 1);
    assert.equal(c.matched, 0);
    assert.equal(c.match_rate, 0);
    assert.equal(c.last_rejection.requested, '56');
    assert.equal(c.last_rejection.candidates, 2);
  });

  test('the right printing is found even when decoys head the results', async () => {
    serve([...WRONG_PAGE, priced('56', 15.2, 'Scarlet & Violet Black Star Promos')]);
    const out = await fetchRapidAPICardmarketPrice(CHARIZARD_SVP_56);

    assert.equal(out.card_number, '56');
    assert.equal(out.price, 15.2, 'the €15 card, not the €561 one at the top of the page');
    assert.equal(getPriceMatchCounts().matched, 1);
  });

  test('a number match wins over a set-name match that disagrees on number', async () => {
    // Set name agrees on the decoy and disagrees on the true card. Under the old
    // scoring a 50+30 name+set decoy beat a bare number match.
    serve([
      { ...WRONG_PAGE[0], episode: { name: 'Scarlet & Violet Black Star Promos', code: 'SVP' } },
      priced('56', 15.2, 'Some Other Set'),
    ]);
    const out = await fetchRapidAPICardmarketPrice(CHARIZARD_SVP_56);
    assert.equal(out.price, 15.2);
  });

  test('leading zeros do not cause a false rejection', async () => {
    // "056" against upstream "56" compared false under the old `itemNum === num`
    // test, quietly widening the set of cards that fell through to data[0].
    serve([priced('56', 15.2, 'Scarlet & Violet Black Star Promos')]);
    const out = await fetchRapidAPICardmarketPrice({ ...CHARIZARD_SVP_56, card_number: '056/197' });
    assert.equal(out.price, 15.2);
  });

  test('no card number read means no price, counted separately from a mismatch', async () => {
    serve(WRONG_PAGE);
    const out = await fetchRapidAPICardmarketPrice({ ...CHARIZARD_SVP_56, card_number: null });

    assert.equal(out, null);
    const c = getPriceMatchCounts();
    assert.equal(c.rejected_no_number_read, 1);
    assert.equal(c.rejected_no_number_match, 0, 'a missing number is a different defect from a wrong one');
  });

  test('the priced result carries the evidence for what it describes', async () => {
    serve([priced('56', 15.2, 'Scarlet & Violet Black Star Promos')]);
    const out = await fetchRapidAPICardmarketPrice(CHARIZARD_SVP_56);
    assert.equal(out.requested_number, '56');
    assert.ok(out.match_score >= 60, 'score must include the mandatory number match');
  });

  test('zero upstream results is an absent card, not a match failure', async () => {
    serve([]);
    assert.equal(await fetchRapidAPICardmarketPrice(CHARIZARD_SVP_56), null);
    const c = getPriceMatchCounts();
    assert.equal(c.no_candidates, 1);
    assert.equal(c.match_rate, null, 'never asked to match is not a 0% match rate');
  });
});

describe('normaliseCardNumber', () => {
  test('drops the denominator and leading zeros', () => {
    assert.equal(normaliseCardNumber('073/084'), '73');
    assert.equal(normaliseCardNumber('056'), '56');
    assert.equal(normaliseCardNumber('56'), '56');
    assert.equal(normaliseCardNumber(56), '56');
  });

  test('keeps promo prefixes, which are part of the identity', () => {
    assert.equal(normaliseCardNumber('SVP 056'), 'svp056');
    assert.equal(normaliseCardNumber('XY03'), 'xy03');
  });

  test('returns null for nothing comparable rather than an empty token', () => {
    // '' would compare equal to '' and match every numberless card to each other.
    for (const v of [null, undefined, '', '   ', '/84']) {
      assert.equal(normaliseCardNumber(v), null, `${JSON.stringify(v)} must not be comparable`);
    }
  });
});
