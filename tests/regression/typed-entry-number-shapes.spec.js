// tests/regression/typed-entry-number-shapes.spec.js
//
// PINS a defect found by the operator typing 20 random cards through the app,
// 24 Aug 2026. Two of the twenty failed:
//
//     wel 189a/214   ->  "Glass Trumpet · ASC 189"   (should be Welder, Unbroken Bonds)
//     uno F/115      ->  "Not found: card_number is required"
//
// Neither was a pricing problem. The tokeniser could not READ the line.
//
// TWO CAUSES, both in pricing/text-entry/tokenise.js.
//
// 1. The number patterns demanded pure digits:
//
//        NUM_TOTAL_RX = /^(\d{1,4})\s*\/\s*(\d{1,4})$/
//        BARE_NUM_RX  = /^#?(\d{1,4})$/
//
//    so 189a, TG19, SV064 and a bare Unown letter had no reading at all.
//
// 2. normaliseSpacing split ANY letter run flush against a numerator:
//
//        .replace(/([A-Za-z])(\d{1,4}\/\d{1,4})/g, '$1 $2')
//
//    Right for "cha4/102" -> "cha 4/102". Wrong for "amp H1/147", which became
//    "amp H 1/147" — the subset letter handed to the NAME and a bare digit left
//    as the collector number. Position tells them apart: a letter run that
//    OPENS the line is a name or set code run together with the number; one
//    that FOLLOWS a word is part of the number, because the name is already
//    given.
//
// MEASURED across all 20,493 catalogue cards with a printed total, each typed
// as "<3-letter prefix> <number>/<printed total>":
//
//     shape             cards    before      after
//     digits           18,849    18,348     18,348   (unchanged)
//     letters+digits    1,509         0      1,491
//     digits+letter        70         0         69
//     single letter        26         0         26
//     other                39         0          8
//     TOTAL            20,493    18,348     19,942
//                                  (90%)      (97%)
//
// No shape regressed. The denominator is what takes name+number from 88.5% to
// 99.6% catalogue uniqueness, so these 1,644 cards were previously resolvable
// only on the weakest evidence, or not at all.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normaliseSpacing, tokeniseLine } from '../../pricing/text-entry/tokenise.js';
import { resolveTypedLine } from '../../pricing/text-entry/resolve-line.js';
import { getTypedEntryIndexes } from '../../pricing/text-entry/index-cache.js';

let db;
let idx;
before(async () => {
  db = JSON.parse(await readFile('data/card-db.json', 'utf8'));
  idx = getTypedEntryIndexes(db);
});
const resolve = (line) =>
  resolveTypedLine(line, { cardDb: db, nameIndex: idx.nameIndex, nameNumberIndex: idx.nameNumberIndex });

describe('the two lines the operator reported', () => {
  test('"wel 189a/214" resolves to Welder, not Glass Trumpet', () => {
    const r = resolve('wel 189a/214');
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'sm10-189a');
    assert.equal(db[r.card_id].name, 'Welder');
  });

  test('"uno F/115" resolves — Unown is numbered by LETTER', () => {
    const r = resolve('uno F/115');
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'ex10-F');
  });
});

describe('normaliseSpacing splits only at the start of the line', () => {
  test('a name run together with the number is still split', () => {
    assert.equal(normaliseSpacing('cha4/102'), 'cha 4/102');
    assert.equal(normaliseSpacing('MEG172/132'), 'MEG 172/132');
  });

  test('a leading quantity is stepped over', () => {
    assert.equal(normaliseSpacing('3x cha4/102'), '3x cha 4/102');
  });

  test('a subset code AFTER the name is left alone', () => {
    // This is the fix. Splitting here is what broke 1,509 cards.
    assert.equal(normaliseSpacing('amp H1/147'), 'amp H1/147');
    assert.equal(normaliseSpacing('cor TG19/30'), 'cor TG19/30');
    assert.equal(normaliseSpacing('gal SV064/122'), 'gal SV064/122');
  });

  test('spaces around a slash are still collapsed', () => {
    assert.equal(normaliseSpacing('cha 4 / 102'), 'cha 4/102');
  });
});

describe('every collector-number shape now reads', () => {
  const cases = [
    ['digits', 'cha 4/102', 'base1-4'],
    ['digits+letter', 'wel 189a/214', 'sm10-189a'],
    ['letters+digits (subset)', 'cor TG19/30', 'swsh12tg-TG19'],
    ['letters+digits (shiny vault)', 'gal SV064/122', 'swsh45sv-SV064'],
    ['single letter (Unown)', 'uno F/115', 'ex10-F'],
  ];
  for (const [shape, line, expected] of cases) {
    test(`${shape}: "${line}"`, () => {
      const r = resolve(line);
      assert.equal(r.status, 'resolved', `${line} -> ${r.reason}`);
      assert.equal(r.card_id, expected);
    });
  }
});

describe('the widened patterns do not invent card numbers', () => {
  test('the CATALOGUE refuses a bad letter reading, not a blocklist', () => {
    // "cha v/102" would be a Charizard numbered V in a 102-card set. No such
    // card, so it declines — and that is the right mechanism.
    //
    // The first fix used a NAME_SUFFIX blocklist so a "v" could never be read
    // as a number. It made Unown V unreachable: ex10-V is a real card, and it
    // was exactly the 1 of 26 letter-numbered cards still missing from the
    // sweep. Letting the catalogue arbitrate is both safer and more precise —
    // letter numbers exist in one set only, and the name must still match.
    for (const line of ['cha v/102', 'pik v/102']) {
      assert.notEqual(resolve(line).status, 'resolved', line);
    }
  });

  test('and the real letter-numbered cards all resolve, V and M included', () => {
    assert.equal(resolve('uno V/115').card_id, 'ex10-V', 'the card the blocklist cost us');
    assert.equal(resolve('uno M/115').card_id, 'ex10-M');
    assert.equal(resolve('uno F/115').card_id, 'ex10-F');
  });

  test('a bare letter with no denominator is not a number', () => {
    // The denominator is what corroborates the reading; without it a stray
    // letter would become a collector number.
    const t = tokeniseLine('cha v');
    for (const i of t.interpretations) {
      assert.notEqual(i.card_number, 'V', 'a stray letter must not become a collector number');
    }
  });

  test('the denominator keeps its digits when the subset letters differ', () => {
    // TG19/TG30 — the total is compared against a set's printed card COUNT, so
    // the letters have to come off or it can never match.
    const t = tokeniseLine('cor TG19/TG30');
    const withTotal = t.interpretations.find((i) => i.total);
    assert.ok(withTotal, 'a reading with a total must exist');
    assert.equal(withTotal.total, '30');
  });
});
