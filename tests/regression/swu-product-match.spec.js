// The fourth adapter in the first-hit-wins family, after tcggo, justtcg and
// pokemontcg. pricing/adapters/swu-db.js ended its scoring loop with:
//
//   for (const c of results) { ...score... if (score > bestScore) { bestScore = score; best = c; } }
//   if (!best) best = results[0];
//
// `bestScore` started at -1, so `best` was assigned on the very first
// iteration even at score 0 — the `if (!best)` line was dead, and the effect
// was identical to the `let best = data[0]` seeding fixed elsewhere: a
// zero-scoring first search hit returned as a VERIFIED identity, carrying its
// own set name, set code and card number.
//
// swu-db returns no price of its own, so the damage is downstream rather than
// immediate: the wrong identity is what builds the Cardmarket URL and what the
// price cascade then prices. A wrong identity and a wrong price are the same
// incident with one hop between them.
//
// Verified red against the reinjected `bestScore = -1` seeding.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { axios } from '../../apps/server/_clients.js';
import { verifySWU } from '../../pricing/adapters/swu-db.js';
import {
  getPriceMatchCounts,
  resetPriceMatchCounts,
} from '../../infra/observability/price-match-counters.js';

const LUKE = { game: 'swu', name: 'Luke Skywalker', card_number: 'SOR 051', set_code: 'SOR' };

const row = (name, number, setCode, setName) => ({
  name,
  number: String(number),
  set: { code: setCode, name: setName },
  rarity: 'Legendary',
});

/** No #51 anywhere — every candidate is a different Luke. */
const WRONG_PAGE = [
  row('Luke Skywalker', '005', 'TWI', 'Twilight of the Republic'),
  row('Luke Skywalker', '203', 'SHD', 'Shadows of the Galaxy'),
];

let realGet;
const serve = (page) => { axios.get = async () => ({ data: page }); };

describe('swu-db identity gate', () => {
  beforeEach(() => { realGet = axios.get; resetPriceMatchCounts(); });
  afterEach(() => { axios.get = realGet; resetPriceMatchCounts(); });

  test('THE DEFECT: no candidate carries the number, so nothing is verified', async () => {
    serve(WRONG_PAGE);
    const out = await verifySWU(LUKE);

    // The old code returned WRONG_PAGE[0] — right name, wrong set, wrong
    // number — as a verified card.
    assert.equal(out, null);
    const s = getPriceMatchCounts().by_source['swu-db'];
    assert.equal(s.matched, 0);
    assert.equal(s.rejected_no_number_match, 1);
  });

  test('the correct printing is returned when it is on the page', async () => {
    serve([...WRONG_PAGE, row('Luke Skywalker', '051', 'SOR', 'Spark of Rebellion')]);
    const out = await verifySWU(LUKE);
    assert.equal(out.card_number, '051');
    assert.equal(out.set_code, 'SOR');
    assert.equal(getPriceMatchCounts().by_source['swu-db'].matched, 1);
  });

  test('a candidate whose number disagrees is skipped however well it scores on name', async () => {
    // Exact name + exact set code = 50 points, comfortably over the floor,
    // but it is card #5 and we asked for #51.
    serve([row('Luke Skywalker', '005', 'SOR', 'Spark of Rebellion')]);
    assert.equal(await verifySWU(LUKE), null);
  });

  test('with no number read, a weak name match is rejected rather than returned', async () => {
    // "Luke Skywalker" vs "Luke Skywalker's Landspeeder" is a substring hit
    // worth 15 — under the floor of 30. The old code returned it.
    serve([row("Luke Skywalker's Landspeeder", '120', 'SOR', 'Spark of Rebellion')]);
    const out = await verifySWU({ ...LUKE, card_number: null, set_code: null });
    assert.equal(out, null);
    assert.equal(getPriceMatchCounts().by_source['swu-db'].rejected_no_number_read, 1);
  });

  test('with no number read, an exact name match still verifies', async () => {
    serve([row('Luke Skywalker', '051', 'SOR', 'Spark of Rebellion')]);
    const out = await verifySWU({ ...LUKE, card_number: null, set_code: null });
    assert.equal(out.name, 'Luke Skywalker');
    assert.equal(getPriceMatchCounts().by_source['swu-db'].matched, 1);
  });

  test('leading zeros and the set prefix do not cause a false rejection', async () => {
    serve([row('Luke Skywalker', '51', 'SOR', 'Spark of Rebellion')]);
    const out = await verifySWU(LUKE);
    assert.ok(out, '"SOR 051" must match upstream "51"');
  });

  test('a run-together number keeps its letters — the separator is the signal', async () => {
    // "SOR 051" is a badge, a gap, then digits. "GG31" is a whole number.
    // Stripping letters unconditionally would turn the second into card 31
    // of some other set, which is a wrong answer that looks perfectly valid.
    serve([row('Hero Card', 'GG31', 'SOR', 'Spark of Rebellion')]);
    const out = await verifySWU({ game: 'swu', name: 'Hero Card', card_number: 'GG31' });
    assert.ok(out, 'GG31 must still match upstream GG31');
    assert.equal(out.card_number, 'GG31');
  });

  test('a run-together number does NOT match the bare digits of a different card', async () => {
    serve([row('Hero Card', '31', 'SOR', 'Spark of Rebellion')]);
    assert.equal(await verifySWU({ game: 'swu', name: 'Hero Card', card_number: 'GG31' }), null);
  });
  test('this source now appears in by_source at all', async () => {
    serve(WRONG_PAGE);
    await verifySWU(LUKE);
    assert.ok('swu-db' in getPriceMatchCounts().by_source);
    assert.equal(getPriceMatchCounts().by_source.pokemontcg, undefined,
      'pokemontcg was never asked and must not read as 0%');
  });
});
