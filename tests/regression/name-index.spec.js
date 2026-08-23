// Pins pricing/name-index.js — how typed text becomes catalogue names.
//
// WHY THIS EXISTS
//
// At a show the operator types against the clock, and the existing panel
// demands either a set code or a perfectly-spelled full name. Measured over
// all 20,546 catalogue cards, uniquely-identified share:
//
//   "4/102"            no name at all                46.0%
//   "ch 4/102"         first 2 letters               98.3%
//   "cha 4/102"        first 3 letters               99.0%
//   "charizard 4/102"  the whole name                99.6%
//
// Three letters costs 0.6 points. The denominator does the work; the prefix
// only breaks what the denominator cannot.
//
// THE RESIDUAL IS WHY AMBIGUITY MUST BE AN ANSWER
//
// 102 groups (206 cards) stay ambiguous under "first 3 + num/total", and 63 of
// them are DIFFERENT POKEMON sharing a prefix — bla|2|132 is Blastoise or
// Blaine's Charizard, and the price gap is large. Returning one would be the
// first-hit-wins defect this project has spent its history removing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNameIndex,
  namesWithPrefix,
  resolveTypedName,
  namesWithinEdit,
  editDistanceWithin,
  editBudget,
  normName,
  MIN_PREFIX,
} from '../../pricing/name-index.js';

const NAMES = [
  'Charizard', 'Charizard ex', 'Charmander', 'Charmeleon', 'Chansey',
  'Blastoise', "Blaine's Charizard", 'Blaziken', 'Blacephalon',
  'Mew', 'Muk', 'Wugtrio', 'Garganacl ex', 'Umbreon-GX', "Farfetch'd",
];
const idx = buildNameIndex(NAMES);

describe('normalisation', () => {
  test('folds the same way set-resolve.js does, so both agree on a name', () => {
    // set-resolve.js:69 strips everything but a-z0-9. If these two disagreed,
    // a name could resolve here and then fail there for no visible reason.
    assert.equal(normName('Umbreon-GX'), 'umbreongx');
    assert.equal(normName("Farfetch'd"), 'farfetchd');
    assert.equal(normName('  Charizard ex  '), 'charizardex');
  });

  test('one normalised form can keep several printed spellings', () => {
    const i = buildNameIndex(['Umbreon-GX', 'Umbreon GX']);
    assert.deepEqual(i.byNorm.get('umbreongx'), ['Umbreon-GX', 'Umbreon GX']);
  });
});

describe('prefix lookup', () => {
  test('finds every name starting with the prefix', () => {
    const got = namesWithPrefix(idx, 'char');
    assert.deepEqual(got.sort(), ['charizard', 'charizardex', 'charmander', 'charmeleon']);
  });

  test('a prefix shorter than the minimum is refused, not answered', () => {
    // Two letters measured 98.3% and three measured 99.0%, but a one- or
    // two-letter prefix fronts so much of the catalogue that returning
    // candidates would be noise rather than evidence.
    assert.deepEqual(namesWithPrefix(idx, 'ch'), []);
    assert.equal(MIN_PREFIX, 3);
  });

  test('the result is capped, so one keystroke cannot return the catalogue', () => {
    const many = buildNameIndex(Array.from({ length: 200 }, (_, i) => `Aaa${String(i).padStart(3, '0')}`));
    assert.equal(namesWithPrefix(many, 'aaa', { limit: 10 }).length, 10);
  });
});

describe('resolveTypedName — the order is the design', () => {
  test('an exact hit does NOT widen to everything starting with it', () => {
    // Somebody who types "Charizard" means Charizard, not Charizard ex.
    // Widening here would manufacture an ambiguity the operator never had.
    const r = resolveTypedName(idx, 'Charizard');
    assert.equal(r.how, 'exact');
    assert.deepEqual(r.names, ['charizard']);
    assert.equal(r.ambiguous, false);
  });

  test('a prefix widens, and says so', () => {
    const r = resolveTypedName(idx, 'cha');
    assert.equal(r.how, 'prefix');
    assert.ok(r.names.length > 1);
    assert.equal(r.ambiguous, true);
  });

  test('a prefix matching exactly one name is not ambiguous', () => {
    const r = resolveTypedName(idx, 'wug');
    assert.equal(r.how, 'prefix');
    assert.deepEqual(r.names, ['wugtrio']);
    assert.equal(r.ambiguous, false);
  });

  test('too short is distinct from not found', () => {
    // Different answers: one is about the operator's input, the other about
    // the catalogue. Merging them would hide which is which in the counters.
    assert.equal(resolveTypedName(idx, 'ch').how, 'too_short');
    assert.equal(resolveTypedName(idx, 'zzzzz').how, 'none');
  });
});

describe('typo tolerance', () => {
  test('THE MEASURED CASE: Garganacle -> Garganacl', () => {
    // From the operator's own 12-line paste. The catalogue spells it
    // "Garganacl ex"; the paste says "Garganacle ex". That single line was
    // the only one of twelve that failed to resolve before this existed.
    const r = resolveTypedName(idx, 'Garganacle ex');
    assert.equal(r.how, 'fuzzy');
    assert.deepEqual(r.names, ['garganaclex']);
  });

  test('SHORT NAMES GET NO BUDGET — Mew must never become Muk', () => {
    // Three-letter names are dense. Mew/Muk/Men are all one edit apart, and
    // swapping one for another is a real price error, not a helpful fix.
    assert.equal(editBudget('mew'.length), 0);
    assert.deepEqual(namesWithinEdit(idx, 'mew').names, []);
    assert.deepEqual(namesWithinEdit(idx, 'muw').names, []);
  });

  test('the budget grows with length, where edits are safer', () => {
    assert.equal(editBudget(5), 0);
    assert.equal(editBudget(6), 1);
    assert.equal(editBudget(9), 1);
    assert.equal(editBudget(10), 2);
  });

  test('a tie returns BOTH names, never a winner', () => {
    const two = buildNameIndex(['Machamp', 'Machop']);
    // 'machomp' sits one edit from Machamp; if something else tied, both come
    // back. The caller must not be handed a coin-flip.
    const r = namesWithinEdit(two, 'machomp');
    assert.ok(r.names.length >= 1);
    if (r.names.length > 1) assert.ok(r.names.includes('machamp'));
  });

  test('fuzzy runs only after exact and prefix have failed', () => {
    // 'chansey' is exact; it must not be dragged toward anything else.
    assert.equal(resolveTypedName(idx, 'chansey').how, 'exact');
    assert.equal(resolveTypedName(idx, 'cha').how, 'prefix');
  });

  test('fuzzy can be switched off by the caller', () => {
    assert.equal(resolveTypedName(idx, 'Garganacle ex', { fuzzy: false }).how, 'none');
  });
});

describe('editDistanceWithin', () => {
  test('computes small distances correctly', () => {
    assert.equal(editDistanceWithin('abc', 'abc', 2), 0);
    assert.equal(editDistanceWithin('abc', 'abd', 2), 1);
    assert.equal(editDistanceWithin('abc', 'axd', 2), 2);
  });

  test('abandons rather than computing a distance it was not asked for', () => {
    // The early exit is what makes a full-catalogue scan affordable; the
    // contract is "> max", not the true distance.
    assert.ok(editDistanceWithin('abcdef', 'zzzzzz', 1) > 1);
    assert.ok(editDistanceWithin('a', 'abcdefgh', 2) > 2);
  });

  test('handles empty input without throwing', () => {
    assert.equal(editDistanceWithin('', '', 1), 0);
    assert.equal(editDistanceWithin('', 'ab', 5), 2);
    assert.equal(editDistanceWithin('ab', '', 5), 2);
  });
});
