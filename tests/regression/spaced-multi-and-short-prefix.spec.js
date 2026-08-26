// tests/regression/spaced-multi-and-short-prefix.spec.js
//
// The last two findings from the five-agent stress sweep, 26 Aug 2026.
//
// ---------------------------------------------------------------------------
// 1. A SECOND CARD HIDING IN THE TRAILING CONTEXT — the only SILENT failure
//    left in the resolver.
//
// "fly 7/25 syl 86/191" is two cards with a space between them. The first
// resolves cleanly, everything after it lands in `extras`, and the line
// returned Flying Pikachu VMAX at high confidence with Sylveon silently
// discarded. Measured: 389 of 400 such lines dropped the second card, and
// nothing on screen said so.
//
// The GLUED form ("cha4/102bla2/102") was already caught, because it fails to
// resolve whole and reaches trySplit. This one never fails, so it never
// reached it. Hitting space instead of Enter is at least as likely as typing
// no separator at all.
//
// Trailing context is usually legitimate — "nm", "rev holo", "psa 10", a
// price. What distinguishes a card is that it RESOLVES as one, and asking the
// resolver is a stronger test than any pattern: a grade or a price does not
// name a card, so it cannot resolve to one.
//
// ---------------------------------------------------------------------------
// 2. A PUNCTUATED NAME LOST CHARACTERS BEFORE THE LENGTH CHECK.
//
// normName strips non-alphanumerics, so a three-character prefix of a
// punctuated name normalises to two and was rejected as too short. "Lt. 6/132"
// became "lt", and all 25 Lt. Surge's cards were unreachable by a three-letter
// prefix — along with Ho-Oh, Mr. Mime, the whole growing N's family, and
// Wo-Chien.
//
// The minimum exists so a very short prefix cannot return an unusable
// candidate list. That holds only when the prefix is the ONLY evidence. With a
// printed total the list is narrowed by (number, total), which is 99.6% unique
// across the catalogue, and two-character buckets are small anyway: median 10
// names, largest 165.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

describe('two cards separated by a space are never silently halved', () => {
  const cases = [
    ['fly 7/25 syl 86/191', ['Flying Pikachu VMAX', 'Sylveon ex']],
    ['cha 4/102 bla 2/102', ['Charizard', 'Blastoise']],
    ['tea 240/182 dar 110/215', ["Team Rocket's Mewtwo ex", 'Darkrai ex']],
  ];
  for (const [line, expected] of cases) {
    test(`"${line}" splits`, () => {
      const r = resolve(line);
      assert.equal(r.status, 'multi', 'dropping the second card silently is the defect');
      assert.equal(r.pieces.length, 2);
      const names = r.pieces.map((p) => (p.card_id ? db[p.card_id].name : p.text));
      assert.deepEqual(names, expected);
    });
  }

  test('the first card is still resolved, not discarded with the line', () => {
    // The operator should see what was found, not an error to diagnose.
    const r = resolve('cha 4/102 bla 2/102');
    assert.equal(r.pieces[0].card_id, 'base1-4');
    assert.equal(r.pieces[1].card_id, 'base1-2');
  });
});

describe('legitimate trailing context is not mistaken for a card', () => {
  // A stress agent found all of these handled 340/340. Splitting them would
  // trade one defect for a noisier one.
  const noise = ['nm', 'lp', 'po', 'rev holo', 'near mint', 'psa 10', '25 euro', '1st ed', 'holo'];
  for (const suffix of noise) {
    test(`"cha 4/102 ${suffix}" stays one card`, () => {
      const r = resolve(`cha 4/102 ${suffix}`);
      assert.equal(r.status, 'resolved', `"${suffix}" must not look like a second card`);
      assert.equal(r.card_id, 'base1-4');
    });
  }

  test('a leading quantity does not split either', () => {
    assert.equal(resolve('3x cha 4/102 nm').card_id, 'base1-4');
  });
});

describe('a punctuated prefix is not punished for its punctuation', () => {
  const cases = [
    ['Lt. 6/132', 'gym1-6', "Lt. Surge's Electabuzz"],
    ['Ho- 111/123', 'hgss1-111', 'Ho-Oh LEGEND'],
    ["N's 185/159", 'sv9-185', "N's Zoroark ex"],
    ['Wo- 257/193', 'sv2-257', 'Wo-Chien ex'],
  ];
  for (const [line, expected, name] of cases) {
    test(`"${line}" -> ${name}`, () => {
      assert.equal(resolve(line).card_id, expected);
    });
  }

  test('two characters still refuse when there is no denominator', () => {
    // The relaxation is paid for by the printed total. Without one the prefix
    // is the only evidence and the old floor applies.
    for (const line of ['Lt. 6', 'Ho- 111', 'ch 4']) {
      const r = resolve(line);
      assert.equal(r.status, 'need_more', line);
      assert.equal(r.reason, 'name_prefix_too_short');
    }
  });

  test('a short prefix that genuinely does not settle it still asks', () => {
    assert.equal(resolve('ch 2/102').status, 'ambiguous');
  });
});
