// tests/regression/condition-not-in-search.spec.js
//
// PINS the operator's instruction, 26 Aug 2026: condition must not be
// accounted for BEFORE the search. It is a pricing question, applied after the
// card is known, and it must never decide which card we are looking at.
//
// The tokeniser consumed condition and finish words with `continue`, which
// REMOVED them from the line. Harmless for a trailing "nm" — that lands in the
// trailing-context bucket and is ignored for identity anyway. Catastrophic for
// a word that also begins a card's name, because the name loses a token and the
// card becomes unfindable by its own printed name.
//
// MEASURED by a five-agent stress sweep:
//
//     "M Charizard-EX 13/108"  -> the leading M is Mint, the name becomes
//                                 "Charizard-EX", and all 87 M-prefixed
//                                 Mega-EX cards are unreachable.
//     "rev 216/197"            -> "rev" is a finish word, so Revavroom ex
//                                 produced ZERO readings. Same for "holo"
//                                 (Holon's Magneton and 20 others), "nor",
//                                 "mint", "poor", "played".
//
// AFTER: of the 112 catalogue cards whose name starts with one of those words,
// 111 resolve by full name + number/total, none wrongly. Catalogue-wide,
// correct answers went 20,221 -> 20,242 with wrong still at zero.
//
// Two consequences had to be handled with it:
//
//  1. A leading name-word still READS as a grade, and first-wins meant it
//     BLOCKED the real one — "M Charizard-EX 13/108 lp" reported NM. A grade
//     after the collector number now beats one before it, because the grade
//     belongs with the price and the price comes after the card.
//
//  2. The grade map predated the move to Cardmarket's scale and knew only the
//     old TCGPlayer vocabulary, so "gd", "pl" and "po" — three of the six
//     grades printed on the buttons the operator is looking at — were not
//     recognised at all.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { tokeniseLine } from '../../pricing/text-entry/tokenise.js';
import { resolveTypedLine } from '../../pricing/text-entry/resolve-line.js';
import { getTypedEntryIndexes } from '../../pricing/text-entry/index-cache.js';
import { CONDITION_ORDER, CONDITION_MULTIPLIERS } from '../../pricing/conditions.js';

let db;
let idx;
before(async () => {
  db = JSON.parse(await readFile('data/card-db.json', 'utf8'));
  idx = getTypedEntryIndexes(db);
});
const resolve = (line) =>
  resolveTypedLine(line, { cardDb: db, nameIndex: idx.nameIndex, nameNumberIndex: idx.nameNumberIndex });
const read = (line) => tokeniseLine(line).interpretations[0] || {};

describe('a condition word never removes a name token', () => {
  test('M Charizard-EX is findable by its printed name', () => {
    // The leading M was consumed as Mint. 87 cards, none reachable.
    assert.equal(resolve('M Charizard-EX 13/108').card_id, 'xy12-13');
  });

  test('Revavroom ex is findable — "rev" is a finish word', () => {
    assert.equal(resolve('rev 216/197').card_id, 'sv3-216');
    assert.equal(resolve('Revavroom ex 216/197').card_id, 'sv3-216');
  });

  test('every card whose name starts with such a word resolves', () => {
    const WORDS = ['m', 'rev', 'holo', 'nor', 'mint', 'poor', 'played', 'good', 'light'];
    let n = 0;
    let bad = 0;
    for (const [id, c] of Object.entries(db)) {
      const first = String(c.name).split(/[\s-]/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!WORDS.includes(first)) continue;
      // Celebrations Classic Collection keys carry an underscore disambiguator
      // (cel25c-76_A). Those cards are reprints that show their ORIGINAL set's
      // number on the card face, so an operator types "cha 4/102" and correctly
      // gets Base Set. There is no printed form that selects the reprint, which
      // is a property of the cards rather than of the parser.
      if (id.slice(id.lastIndexOf('-') + 1).includes('_')) continue;
      n += 1;
      const r = resolve(`${c.name} ${id.slice(id.lastIndexOf('-') + 1)}`);
      // Ambiguity is fine — the point is that it is not silently unfindable.
      if (r.status === 'need_more' && r.reason === 'no_interpretation') bad += 1;
    }
    assert.ok(n > 100, `expected 100+ such cards, found ${n}`);
    assert.equal(bad, 0, `${bad} of ${n} produced no reading at all`);
  });
});

describe('the grade is still read, just not used to search', () => {
  test('a trailing grade reaches the interpretation', () => {
    assert.equal(read('cha 4/102 nm').condition, 'NM');
    assert.equal(read('cha 4/102 lp').condition, 'LP');
    assert.equal(read('cha 4/102 rev holo').finish, 'reverse_holo');
  });

  test('a trailing grade does not change which card is found', () => {
    for (const suffix of ['', ' nm', ' lp', ' po', ' rev holo', ' near mint']) {
      assert.equal(resolve(`cha 4/102${suffix}`).card_id, 'base1-4', `suffix "${suffix}"`);
    }
  });
});

describe('a grade after the number beats one before it', () => {
  test('a leading name-word does not block the operator\'s real grade', () => {
    // Reported NM before: the M in the card's own name claimed the slot.
    assert.equal(read('M Charizard-EX 13/108 lp').condition, 'LP');
    assert.equal(read('M Charizard-EX 13/108 po').condition, 'PO');
  });

  test('with nothing after the number, the earlier reading still stands', () => {
    assert.equal(read('M Charizard-EX 13/108').condition, 'NM');
  });
});

describe('every grade the picker offers is typeable', () => {
  test('the short forms', () => {
    const got = {};
    for (const g of CONDITION_ORDER) got[g] = read(`cha 4/102 ${g.toLowerCase()}`).condition;
    // EX is deliberately NOT a grade token: it is a name suffix on ~700 cards,
    // and reading it as a condition would re-create the trap this module
    // exists to remove. It stays selectable in the UI.
    assert.equal(got.EX, null, 'ex must remain a name suffix, not a grade');
    for (const g of CONDITION_ORDER.filter((x) => x !== 'EX')) {
      assert.equal(got[g], g, `"${g.toLowerCase()}" should read as ${g}`);
    }
  });

  test('the long forms match the labels on the buttons', () => {
    assert.equal(read('cha 4/102 good').condition, 'GD');
    assert.equal(read('cha 4/102 played').condition, 'PL');
    assert.equal(read('cha 4/102 poor').condition, 'PO');
  });

  test('"played" selects the grade that word names', () => {
    // It used to map to the legacy MP. The picker labels PL "Played", so the
    // word must select PL — and that IS a repricing, 0.58 -> 0.40.
    assert.equal(read('cha 4/102 played').condition, 'PL');
    assert.equal(CONDITION_MULTIPLIERS.PL, 0.40);
  });
});
