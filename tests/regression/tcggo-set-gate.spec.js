// tests/regression/tcggo-set-gate.spec.js
//
// PINS the defect measured against production on 24 Aug 2026.
//
// Charizard / set_code BS / number 4, same endpoint, one optional field apart:
//
//     without set_name   lowest_nm EUR 165   -> matched CELEBRATIONS #4
//     with    set_name   lowest_nm EUR 380   -> matched Base Set #4
//
// The old matcher treated the set as a SCORE, not a gate:
//
//     let score = 60;
//     if (item.name.includes(card.name))        score += 50;
//     if (item.episode.name.includes(set_name)) score += 30;
//     if (score > bestScore) { bestScore = score; best = item; }
//
// Two problems, both live. The set could not exclude anything, so a missing
// set_name simply removed the only set signal. And it was a substring test on a
// display name, so "Base" matched "Base Set 2" as happily as "Base Set" — equal
// scores, and `>` keeps whichever the upstream returned first. First-hit-wins
// on the set dimension, the same defect already closed in four other adapters.
//
// The fixtures below are REAL episode blocks from the subscribed listing
// (cardmarket-api-tcg.p.rapidapi.com/pokemon/cards), which is the only one that
// returns episode.code and cards_printed_total. Those two fields are what makes
// a gate possible at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseTcggoCandidate, setEvidence, printedTotalOf,
} from '../../pricing/adapters/tcggo-rapidapi.js';

// Real shapes, captured 24 Aug 2026.
const CELEBRATIONS_4 = {
  name: 'Charizard', card_number: '4', cardmarket_id: 528293,
  episode: { name: 'Celebrations', code: 'CEL', cards_total: 25, cards_printed_total: 25 },
  prices: { cardmarket: { lowest_near_mint: 165, '30d_average': 233.2, available_items: 395 } },
};
const BASE_SET_4 = {
  name: 'Charizard', card_number: '4',
  episode: { name: 'Base Set', code: 'BS', cards_total: 102, cards_printed_total: 102 },
  prices: { cardmarket: { lowest_near_mint: 380, '30d_average': 272.97, available_items: 79 } },
};
const BASE_SET_2_4 = {
  name: 'Charizard', card_number: '4',
  episode: { name: 'Base Set 2', code: 'B2', cards_total: 130, cards_printed_total: 130 },
  prices: { cardmarket: { lowest_near_mint: 88, '30d_average': 95 } },
};
const PAGE = [CELEBRATIONS_4, BASE_SET_4, BASE_SET_2_4];

describe('TCGGO set gate — the incident', () => {
  test('the set code decides, and Celebrations does not win', () => {
    const r = chooseTcggoCandidate(PAGE, {
      name: 'Charizard', card_number: '4', set_code: 'BS', set_name: 'Base',
    });
    assert.equal(r.item, BASE_SET_4, 'EUR 380, not the EUR 165 Celebrations card');
    assert.equal(r.evidence, 'code');
    assert.equal(r.reason, 'set_confirmed');
  });

  test('"Base" no longer wins Base Set 2 by substring', () => {
    // The exact ambiguity that made the old score useless: "Base" is contained
    // in both "Base Set" and "Base Set 2".
    const r = chooseTcggoCandidate([BASE_SET_2_4, BASE_SET_4], {
      name: 'Charizard', card_number: '4', set_code: 'BS',
    });
    assert.equal(r.item, BASE_SET_4);
    assert.equal(r.evidence, 'code');
  });

  test('the printed total resolves it when no set code was typed', () => {
    // The operator typed "4/102". docs/V3_BENCHMARK.md section 18 measured the
    // denominator at 99.6% catalogue uniqueness; this is it reaching the price
    // path for the first time.
    const r = chooseTcggoCandidate(PAGE, { name: 'Charizard', card_number: '4/102' });
    assert.equal(r.item, BASE_SET_4);
    assert.equal(r.evidence, 'total');
  });

  test('WITH NO SET EVIDENCE AT ALL IT REFUSES — this is the whole fix', () => {
    // Three printings share number 4 and nothing says which. The old code
    // returned whichever came first, which is how EUR 165 was quoted for a
    // EUR 380 card. An absent price costs nothing; a wrong one costs the
    // difference.
    const r = chooseTcggoCandidate(PAGE, { name: 'Charizard', card_number: '4' });
    assert.equal(r.item, null);
    assert.equal(r.reason, 'set_unconfirmed');
    assert.equal(r.considered, 3);
  });

  test('a sole candidate is priced, but flagged as unverified', () => {
    // One printing carries the number, so there is nothing to get wrong.
    // Reported separately so the match rate never silently includes it.
    const r = chooseTcggoCandidate([CELEBRATIONS_4], { name: 'Charizard', card_number: '4' });
    assert.equal(r.item, CELEBRATIONS_4);
    assert.equal(r.reason, 'sole_candidate');
  });

  test('a code match beats a printed-total match when they disagree', () => {
    // Two sets can share a printed total (many are 102 or 130). The code is the
    // stronger signal and must win.
    const decoy = {
      ...BASE_SET_2_4,
      episode: { name: 'Decoy', code: 'DEC', cards_printed_total: 102 },
    };
    const r = chooseTcggoCandidate([decoy, BASE_SET_4], {
      name: 'Charizard', card_number: '4/102', set_code: 'BS',
    });
    assert.equal(r.item, BASE_SET_4);
    assert.equal(r.evidence, 'code');
  });

  test('two sets claiming the SAME code is an honest refusal', () => {
    const twin = {
      ...BASE_SET_2_4,
      episode: { name: 'Impostor', code: 'BS', cards_printed_total: 999 },
    };
    const r = chooseTcggoCandidate([twin, BASE_SET_4], {
      name: 'Charizard', card_number: '4', set_code: 'BS',
    });
    assert.equal(r.item, null);
    assert.equal(r.reason, 'set_ambiguous');
  });
});

describe('TCGGO set gate — the number is still the hard gate', () => {
  test('nothing carrying the number means nothing is priced', () => {
    const r = chooseTcggoCandidate(PAGE, {
      name: 'Charizard', card_number: '223', set_code: 'BS',
    });
    assert.equal(r.item, null);
    assert.equal(r.reason, 'no_number_match');
  });

  test('no number read at all is a distinct outcome', () => {
    const r = chooseTcggoCandidate(PAGE, { name: 'Charizard' });
    assert.equal(r.item, null);
    assert.equal(r.reason, 'no_number_read');
  });

  test('leading zeros still normalise', () => {
    const r = chooseTcggoCandidate(PAGE, {
      name: 'Charizard', card_number: '004', set_code: 'BS',
    });
    assert.equal(r.item, BASE_SET_4);
  });
});

describe('printedTotalOf', () => {
  test('reads the denominator the operator typed', () => {
    assert.equal(printedTotalOf({ card_number: '4/102' }), 102);
    assert.equal(printedTotalOf({ card_number: '004 / 102' }), 102);
  });

  test('prefers an explicit field', () => {
    assert.equal(printedTotalOf({ card_number: '4', printed_total: 102 }), 102);
    assert.equal(printedTotalOf({ card_number: '4', total: '197' }), 197);
  });

  test('absent is null, never zero — never-asked is not a total of nothing', () => {
    assert.equal(printedTotalOf({ card_number: '4' }), null);
    assert.equal(printedTotalOf({}), null);
    assert.equal(printedTotalOf({ card_number: '4/0' }), null);
  });
});

describe('setEvidence ranking', () => {
  test('code beats total beats name', () => {
    assert.equal(setEvidence(BASE_SET_4, { set_code: 'BS' }), 'code');
    assert.equal(setEvidence(BASE_SET_4, { card_number: '4/102' }), 'total');
    assert.equal(setEvidence(BASE_SET_4, { set_name: 'Base Set' }), 'name_exact');
    assert.equal(setEvidence(BASE_SET_4, { set_name: 'Base' }), 'name', 'substring only');
    assert.equal(setEvidence(BASE_SET_4, { set_name: 'Nothing Like It' }), null);
  });

  test('exact name rescues the sets whose codes disagree', () => {
    // Our catalogue carries ptcgo-style codes, TCGGO carries Cardmarket's own.
    // Measured 24 Aug 2026 — all six of these match on name and NOT on code:
    //   SV1/SVI  G2/GC  N4/NDE  POP2/(blank)  PR/WP  SV2/PAL
    // Adding exact-name evidence took coverage from 87% to 95% on a 60-card
    // sample, without weakening the gate: substring stays insufficient.
    const sv = { name: 'Drowzee', card_number: '82',
      episode: { name: 'Scarlet & Violet', code: 'SVI', cards_printed_total: 198 },
      prices: { cardmarket: { lowest_near_mint: 1 } } };
    assert.equal(setEvidence(sv, { set_name: 'Scarlet & Violet', set_code: 'SV1' }), 'name_exact');
  });

  test('normalisation covers ampersands, accents and punctuation', () => {
    const ep = (n) => ({ name: 'x', card_number: '1', episode: { name: n } });
    assert.equal(setEvidence(ep('Scarlet & Violet'), { set_name: 'Scarlet and Violet' }), 'name_exact');
    assert.equal(setEvidence(ep('HS—Unleashed'), { set_name: 'HS Unleashed' }), 'name_exact');
    assert.equal(setEvidence(ep('Pokémon GO'), { set_name: 'Pokemon GO' }), 'name_exact');
  });

  test('case and padding do not matter to the code comparison', () => {
    assert.equal(setEvidence(BASE_SET_4, { set_code: 'bs' }), 'code');
    assert.equal(setEvidence(BASE_SET_4, { set_code: ' BS ' }), 'code');
  });
});

describe('duplicate upstream products', () => {
  // The upstream catalogue lists the same Cardmarket product twice. Measured
  // 24 Aug 2026: Dark Tyranitar NDE 11 and Sabrina's Drowzee GC 95 each appear
  // with identical cardmarket_id, identical price and identical
  // available_items, differing only in an internal id and a cosmetic rarity
  // string ("Rare Holo" vs "Holo Rare").
  //
  // Before dedupe these looked like two printings sharing a number in one set,
  // and the ambiguity rule refused to price a card with exactly ONE product
  // behind it. That was every remaining refusal in a 60-card sample.
  const dup = (id, rarity) => ({
    name: 'Dark Tyranitar', card_number: '11', cardmarket_id: 274663, rarity,
    episode: { name: 'Neo Destiny', code: 'NDE', cards_printed_total: 105 },
    prices: { cardmarket: { lowest_near_mint: 275, available_items: 97 } },
  });

  test('the same product listed twice is one product, not an ambiguity', () => {
    const r = chooseTcggoCandidate([dup(18363, 'Rare Holo'), dup(49966, 'Holo Rare')], {
      name: 'Dark Tyranitar', set_name: 'Neo Destiny', set_code: 'N4', card_number: '11',
    });
    assert.equal(r.reason, 'set_confirmed');
    assert.equal(r.considered, 1, 'the duplicate must not inflate the candidate count');
    assert.equal(r.item.prices.cardmarket.lowest_near_mint, 275);
  });

  test('GENUINELY different products sharing a number still refuse', () => {
    // Dedupe must not become a way to silently collapse real ambiguity: these
    // carry different cardmarket_ids, so both survive and neither is confirmed.
    const a = { name: 'Charizard', card_number: '4', cardmarket_id: 1,
      episode: { name: 'Set A', code: 'AA', cards_printed_total: 50 }, prices: { cardmarket: {} } };
    const b = { name: 'Charizard', card_number: '4', cardmarket_id: 2,
      episode: { name: 'Set B', code: 'BB', cards_printed_total: 60 }, prices: { cardmarket: {} } };
    const r = chooseTcggoCandidate([a, b], { name: 'Charizard', card_number: '4' });
    assert.equal(r.item, null);
    assert.equal(r.reason, 'set_unconfirmed');
    assert.equal(r.considered, 2);
  });

  test('a missing cardmarket_id never collapses two candidates', () => {
    const a = { name: 'X', card_number: '1', episode: { name: 'Set A', code: 'AA' }, prices: { cardmarket: {} } };
    const b = { name: 'X', card_number: '1', episode: { name: 'Set B', code: 'BB' }, prices: { cardmarket: {} } };
    const r = chooseTcggoCandidate([a, b], { name: 'X', card_number: '1' });
    assert.equal(r.considered, 2, 'null ids are not equal to each other');
  });
});

describe('duplicate ids that DISAGREE are a conflict, not a duplicate', () => {
  // PINS a bug introduced by the dedupe above and caught by verifying against
  // production. Two upstream rows for Base Set Charizard #4 carry the SAME
  // cardmarket_id 660224 and completely different numbers:
  //
  //     base/charizard-4-2   nm=null   avg30=10.46      avail=509
  //     base/charizard-24    nm=2695   avg30=2475.96    avail=39
  //
  // Collapsing on the id alone kept whichever came first and quoted EUR 10.46
  // for a card whose 30-day average is EUR 2,475 — and TCGplayer says USD 731,
  // so the two sources disagreed by 70x. Before dedupe this case refused;
  // after it, it answered confidently and wrongly, which is strictly worse than
  // the bug it was fixing.
  //
  // Sharing an id is not sufficient. The PAYLOADS must agree.
  const base = (slug, nm, avg30, avail) => ({
    name: 'Charizard', card_number: '4', cardmarket_id: 660224, slug,
    episode: { name: 'Base', code: 'BS', cards_printed_total: 102 },
    prices: { cardmarket: { lowest_near_mint: nm, '30d_average': avg30, available_items: avail } },
  });
  const ASK = { name: 'Charizard', set_name: 'Base', set_code: 'BS', card_number: '4' };

  test('the real conflict refuses rather than picking one', () => {
    const r = chooseTcggoCandidate(
      [base('charizard-4-2', null, 10.46, 509), base('charizard-24', 2695, 2475.96, 39)], ASK,
    );
    assert.equal(r.item, null, 'EUR 10.46 must not be quoted for this card');
    assert.equal(r.reason, 'set_ambiguous');
    assert.equal(r.considered, 2);
  });

  test('order does not decide it', () => {
    // The old rule was order-dependent, which is what made it a lottery.
    const r = chooseTcggoCandidate(
      [base('charizard-24', 2695, 2475.96, 39), base('charizard-4-2', null, 10.46, 509)], ASK,
    );
    assert.equal(r.item, null);
  });

  test('genuinely identical rows still collapse to one', () => {
    const r = chooseTcggoCandidate([base('a', 275, 275, 97), base('b', 275, 275, 97)], ASK);
    assert.equal(r.reason, 'set_confirmed');
    assert.equal(r.considered, 1);
  });

  test('a differing available_items alone is enough to keep both', () => {
    // Supply is the field the price history exists to record. Two rows that
    // disagree about it cannot be averaged into one without inventing data.
    const r = chooseTcggoCandidate([base('a', 275, 275, 97), base('b', 275, 275, 12)], ASK);
    assert.equal(r.considered, 2);
    assert.equal(r.item, null);
  });
});
