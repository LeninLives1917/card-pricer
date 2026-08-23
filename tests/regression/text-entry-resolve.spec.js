// Pins pricing/text-entry/resolve-line.js against the REAL catalogue.
//
// WHY THIS EXISTS
//
// The show format. The operator is holding the card and typing against the
// clock, and everything they need is printed on it: a few letters of the name
// and the collector number with its denominator.
//
//   cha 4/102   ->  base1-4  Charizard (Base)
//
// Measured over all 20,546 cards: "first 3 letters + num/total" identifies
// 99.0% uniquely, against 99.6% for the full name and 46.0% for the
// denominator alone.
//
// THIS SPEC RUNS AGAINST data/card-db.json, DELIBERATELY.
//
// The value of these formats is a property of the real catalogue — its
// reprints, its collisions, its spelling of "Garganacl". A fixture would
// measure a catalogue I invented, which is the synthetic-benchmark trap
// CLAUDE.md already records for images. The file is untracked and lives on
// the Render disk, so its absence FAILS LOUDLY rather than skipping: a
// silently-skipped test is an invisible fallback wearing a test's clothes.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildNameIndex } from '../../pricing/name-index.js';
import { buildNameNumberIndex, resolveLine } from '../../pricing/text-entry/resolve-line.js';
import { parseTextEntryLine } from '../../apps/vendor/modules/text-parse.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = join(REPO, 'data', 'card-db.json');

let deps;
before(() => {
  assert.ok(
    fs.existsSync(DB_PATH),
    'data/card-db.json is missing. It is untracked and lives on the Render disk; '
    + 'build it with `node scripts/build-phash-db.js`. This spec must not be skipped — '
    + 'the formats it pins are properties of the real catalogue.',
  );
  const cardDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  deps = {
    cardDb,
    nameIndex: buildNameIndex(Object.values(cardDb).map((c) => c.name)),
    nameNumberIndex: buildNameNumberIndex(cardDb),
  };
});

const line = (name, card_number, total, set_code) =>
  resolveLine({ name, card_number, total, set_code }, deps);

describe('the show format: first letters + number/total', () => {
  test('THE HEADLINE: "cha 4/102" is Base Set Charizard', () => {
    const r = line('cha', '4', '102');
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'base1-4');
    assert.equal(r.name_match, 'prefix');
    assert.equal(r.candidates[0].name, 'Charizard');
  });

  test('the full name reaches the same card by the exact path', () => {
    const r = line('charizard', '4', '102');
    assert.equal(r.card_id, 'base1-4');
    assert.equal(r.name_match, 'exact');
  });

  test('a three-letter prefix works across eras', () => {
    assert.equal(line('wug', '224', '091').card_id, 'sv4pt5-224');
    assert.equal(line('mys', '172', '132').card_id, 'me1-172');
  });
});

describe('ambiguity is an answer', () => {
  test('THE DANGEROUS CASE: "bla 2/132" must ASK, not guess', () => {
    // Blastoise (Secret Wonders) and Blaine's Charizard (Gym Challenge) share
    // a prefix, a collector number and a set size. The price gap is large.
    // Returning either would be first-hit-wins with extra steps.
    const r = line('bla', '2', '132');
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.card_id, null);
    const names = r.candidates.map((c) => c.name);
    assert.ok(names.includes('Blastoise'), `expected Blastoise among ${names}`);
    assert.ok(names.some((n) => /Blaine/.test(n)), `expected a Blaine's card among ${names}`);
  });

  test('typing more letters resolves what the prefix could not', () => {
    // The operator's escape hatch, and the reason the picker is a fallback
    // rather than the primary interface.
    const r = line('blastoise', '2', '132');
    assert.equal(r.status, 'resolved');
    assert.equal(r.name_match, 'exact');
    assert.equal(r.candidates[0].name, 'Blastoise');
  });
});

describe('the operator\'s real 12-line paste', () => {
  // Verbatim from tests/regression/text-entry-parse.spec.js, which pins the
  // format Dave actually pastes. Before this module, 11 of 12 resolved.
  const BLOCK = [
    'Mystery Garden meg en 172/132',
    'Wugtrio paf en 224/091',
    'Dewgong pfl en 097/094',
    'Garganacle ex scr en 089/142',
    'Rotom ex pfl en 029/094',
    'Durant ex ssp en 004/191',
    "Team Rockets Crobat ex dri en 122/182 League Promo Stamp",
    'Mismagius ex pfl en 036/094',
    'Megaton Blower ssp en 182/191',
    'Slaking ex ssp en 147/191',
    'Tapu Koko ex jtg en 051/159',
    'Mega Sharpedo ex pfl en 061/094',
  ];

  test('all twelve resolve', () => {
    const missed = [];
    for (const raw of BLOCK) {
      const p = parseTextEntryLine(raw);
      const r = line(p.name, p.card_number, p.total, p.set_code);
      if (r.status !== 'resolved') missed.push(`${p.name}: ${r.reason}`);
    }
    assert.deepEqual(missed, []);
  });

  test('the misspelled line resolves, and is FLAGGED as fuzzy', () => {
    // The catalogue spells it "Garganacl ex"; the paste says "Garganacle ex".
    // Resolving it silently would be the wrong fix — the result carries
    // name_match: 'fuzzy' so it can be shown differently.
    const p = parseTextEntryLine('Garganacle ex scr en 089/142');
    const r = line(p.name, p.card_number, p.total, p.set_code);
    assert.equal(r.status, 'resolved');
    assert.equal(r.name_match, 'fuzzy');
    assert.equal(r.candidates[0].name, 'Garganacl ex');
  });

  test("an apostrophe difference is not a typo — Team Rockets vs Team Rocket's", () => {
    const p = parseTextEntryLine("Team Rockets Crobat ex dri en 122/182 League Promo Stamp");
    const r = line(p.name, p.card_number, p.total, p.set_code);
    assert.equal(r.name_match, 'exact', 'normalisation strips punctuation, so this is an EXACT match');
    assert.equal(r.candidates[0].name, "Team Rocket's Crobat ex");
  });
});

describe('honest refusals', () => {
  test('a name nobody has heard of is not found', () => {
    assert.equal(line('xyzzyx', '4', '102').status, 'not_found');
  });

  test('a real name at a number it was never printed at is not found', () => {
    const r = line('charizard', '999', '102');
    assert.equal(r.status, 'not_found');
  });

  test('a two-letter prefix asks for more rather than guessing', () => {
    const r = line('ch', '4', '102');
    assert.equal(r.status, 'need_more');
    assert.equal(r.reason, 'name_prefix_too_short');
  });

  test('no number at all is refused', () => {
    assert.equal(line('charizard', '', '').status, 'need_more');
  });

  test('a bare number with no name is refused rather than guessed', () => {
    // "4/102" alone identifies 46% of the catalogue uniquely, which sounds
    // usable until you notice it means a coin-flip on the other 54%.
    const r = line('', '4', '102');
    assert.equal(r.status, 'need_more');
  });
});

describe('the resolver keeps its measured behaviour', () => {
  test('a printed total that contradicts the set is surfaced, not hidden', () => {
    // set-resolve.js downgrades confidence and sets contradiction rather than
    // failing outright. That behaviour is measured (§18) and must survive.
    const r = line('sud', '100', '100');
    assert.equal(r.status, 'resolved');
    assert.ok(['high', 'medium'].includes(r.confidence));
    if (r.reason.includes('mismatch')) assert.equal(r.contradiction, true);
  });
});
