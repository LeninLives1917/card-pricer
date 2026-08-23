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
import { buildNameNumberIndex, resolveLine, resolveTypedLine } from '../../pricing/text-entry/resolve-line.js';
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

describe('a typed denominator is stronger evidence than a read one', () => {
  test('the TYPED path abstains when the printed total excludes the card', () => {
    // Superseded assertion, kept visible because the change was deliberate.
    // This used to assert `resolved` at medium confidence with
    // contradiction: true — set-resolve.js's lenient default, which is right
    // for PHOTOGRAPHS because a vision model misreads denominators often
    // enough that discarding an otherwise-unique match costs more than it
    // saves.
    //
    // A person typing "100/100" is different evidence: they copied both
    // numbers off the card in front of them. Measured cost of treating the
    // two the same — on a 20-card sample, four lines came back as questions
    // with two candidates each, where exactly one matched the typed total and
    // the other contradicted it. Four unnecessary questions in twenty, all
    // already answered by the denominator.
    const r = line('sud', '100', '100');
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.card_id, null);
  });

  test('the PHOTO path keeps the lenient behaviour, unchanged', async () => {
    // The measured 68.6% identity / 97.2% precision in §18 was obtained with
    // the lenient rule. Nothing here may move it.
    const { resolveIdentity } = await import('../../pricing/set-resolve.js');
    const read = { name: 'Rhydon', card_number: '61/64' };
    const lenient = resolveIdentity(read, deps.cardDb);
    assert.equal(lenient.id, 'xy1-61', 'the photo path must still answer');
    assert.equal(lenient.confidence, 'medium');
    assert.equal(lenient.contradiction, true);

    const strict = resolveIdentity(read, deps.cardDb, { strictPrintedTotal: true });
    assert.equal(strict.id, null, 'and the typed path must abstain on the same input');
    assert.equal(strict.reason, 'printed_total_excludes_all');
  });

  test('THE MEASURED FIX: four sampled lines that used to ask now resolve', () => {
    // Each had exactly one candidate matching the typed total and one
    // contradicting it. Real cards, read out of the catalogue rather than
    // remembered.
    for (const [text, expected] of [
      ['rhy 61/64', 'Rhyhorn'],
      ['mag 39/62', 'Magmar'],
      ['gal 174/185', "Galarian Sirfetch'd V"],
      ['cha 33/191', 'Charcadet'],
    ]) {
      const r = resolveTypedLine(text, deps);
      assert.equal(r.status, 'resolved', `${text}: ${r.reason}`);
      assert.equal(r.candidates[0].name, expected, text);
    }
  });

  test('THE SET-CODE HOLE: a code whose set size contradicts the total is refused', () => {
    // "gri 75/127" returned Mudbray from Guardians Rising. GRI is a real
    // alias for sm2 and sm2-75 is a real card — but Guardians Rising has 145
    // cards, not 127. 127 is Platinum, where 75 is Grimer.
    //
    // That rung carried the HIGHEST evidence rank, because set id + number is
    // unique by construction, and it was the one rung checking nothing.
    for (const [text, expected] of [['gri 75/127', 'Grimer'], ['por 104/147', 'Porygon2']]) {
      const r = resolveTypedLine(text, deps);
      assert.equal(r.status, 'resolved', `${text}: ${r.reason}`);
      assert.equal(r.candidates[0].name, expected, text);
    }
  });

  test('an exact name with no card at that number still widens to prefix', () => {
    // There is a card literally named "Eri", so "eri 103/132" matched
    // EXACTLY, found no card at 103, and stopped — while Erika's Kindness sat
    // at Gym Challenge 103 with a printed total of 132. "Exact does not
    // widen" is about preference, not exclusivity.
    const r = resolveTypedLine('eri 103/132', deps);
    assert.equal(r.status, 'resolved');
    assert.equal(r.candidates[0].name, "Erika's Kindness");
    assert.equal(r.name_match, 'prefix');
  });
});

describe('resolveTypedLine — evidence decides, not order', () => {
  test('THE DEFECT: "MEG 172/132" must be Mystery Garden, not Mega Audino ex', () => {
    // Found while wiring the tokeniser. "meg" is a legitimate three-letter
    // prefix of "Mega Audino ex", which has a card at 172, so the NAME reading
    // resolved first and returned an Ascended Heroes card. MEG is also a real
    // set code for Mega Evolution, where 172 is Mystery Garden.
    //
    // Both readings resolve. Taking the first was the bug. Set id + number is
    // unique by construction — it IS the catalogue key, measured 100% — while
    // a three-letter prefix measured 99.0%, so the set reading is better
    // founded and must win on evidence rather than on ordering.
    const r = resolveTypedLine('MEG 172/132', deps);
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'me1-172');
    assert.equal(r.candidates[0].name, 'Mystery Garden');
    // The MECHANISM changed after strictPrintedTotal landed, and the change
    // is an improvement worth naming. This used to assert the name reading
    // was OUTRANKED — resolved, then beaten on evidence. Now the printed
    // total eliminates it before it ever resolves: me2pt5 has 295 cards, the
    // line said 132. Refuted beats outranked, because it needs no ranking
    // rule to be trusted.
    assert.equal(r.reason, 'set_code_and_number');
    assert.deepEqual(r.outranked ?? [], [], 'the wrong reading should now be refuted by the total, not merely outranked');
  });

  test('a name-prefix reading still wins when no set code is plausible', () => {
    // "cha" is not a set code, so the set reading resolves to nothing and the
    // name reading carries the line.
    const r = resolveTypedLine('cha 4/102', deps);
    assert.equal(r.card_id, 'base1-4');
    assert.equal(r.shape, 'name_only');
    assert.equal(r.name_match, 'prefix');
  });

  test('an exact name outranks a prefix reading of the same line', () => {
    const r = resolveTypedLine('charizard 4/102', deps);
    assert.equal(r.name_match, 'exact');
    assert.equal(r.card_id, 'base1-4');
  });

  test('the "ex" trap resolves to the right card end to end', () => {
    // The €561.50 incident card. Old parser: name "Charizard", set "EX".
    const r = resolveTypedLine('Charizard ex SVP 056', deps);
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'svp-56');
    assert.equal(r.candidates[0].name, 'Charizard ex');
  });

  test('the legacy "PFL 94" shape still resolves by set code', () => {
    const r = resolveTypedLine('PFL 94', deps);
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'me2-94');
    assert.equal(r.reason, 'set_code_and_number');
  });

  test('quantity, condition and finish survive to the interpretation', () => {
    const r = resolveTypedLine('3x Charizard ex SVP 056 nm reverse', deps);
    assert.equal(r.card_id, 'svp-56');
    assert.equal(r.interpretation.qty, 3);
    assert.equal(r.interpretation.condition, 'NM');
    assert.equal(r.interpretation.finish, 'reverse_holo');
  });

  test('ambiguity survives the whole pipeline', () => {
    const r = resolveTypedLine('bla 2/132', deps);
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.card_id, null);
    assert.ok(r.candidates.length > 1);
  });

  test('the operator\'s whole paste resolves through the raw-line path', () => {
    const BLOCK = [
      'Mystery Garden meg en 172/132', 'Wugtrio paf en 224/091', 'Dewgong pfl en 097/094',
      'Garganacle ex scr en 089/142', 'Rotom ex pfl en 029/094', 'Durant ex ssp en 004/191',
      "Team Rockets Crobat ex dri en 122/182 League Promo Stamp", 'Mismagius ex pfl en 036/094',
      'Megaton Blower ssp en 182/191', 'Slaking ex ssp en 147/191', 'Tapu Koko ex jtg en 051/159',
      'Mega Sharpedo ex pfl en 061/094',
    ];
    const missed = BLOCK.map((l) => [l, resolveTypedLine(l, deps)])
      .filter(([, r]) => r.status !== 'resolved')
      .map(([l, r]) => `${l}: ${r.reason}`);
    assert.deepEqual(missed, []);
  });

  test('a line with no number is refused rather than guessed at', () => {
    const r = resolveTypedLine('Charizard', deps);
    assert.equal(r.status, 'need_more');
    assert.equal(r.reason, 'no_interpretation');
  });
});

describe('alphanumeric collector numbers keep the catalogue\'s own casing', () => {
  test('THE DEFECT: "Froakie XY03" resolved to an id the catalogue does not hold', () => {
    // set-resolve.js composes its answer as `${setId}-${normalisedNumber}`
    // and that normalisation lowercases. Numeric numbers round-trip; an
    // alphanumeric one does not — the catalogue key is `xyp-XY03` and the
    // rebuilt id was `xyp-xy03`. It reported RESOLVED and then the lookup
    // missed, so the card came back with a null name. Resolved and unusable
    // is worse than not found, because only one of those is visible.
    const r = resolveTypedLine('Froakie XY03', deps);
    assert.equal(r.status, 'resolved');
    assert.equal(r.card_id, 'xyp-XY03', 'must be the real catalogue key, not a lowercased rebuild');
    assert.equal(r.candidates[0].name, 'Froakie', 'a null name here means the id did not resolve');
    assert.ok(deps.cardDb[r.card_id], 'the returned id must exist in the catalogue');
  });

  test('the same card via a separated badge and via a prefix', () => {
    for (const line of ['Froakie XY 03', 'fro XY 03', 'fro XY03']) {
      const r = resolveTypedLine(line, deps);
      assert.equal(r.card_id, 'xyp-XY03', line);
      assert.equal(r.candidates[0].name, 'Froakie', line);
    }
  });

  test('every resolved id exists in the catalogue, across shapes', () => {
    const lines = ['cha 4/102', 'Charizard ex 056/197', 'MEG 172/132', 'PFL 94',
      "N's Zekrom MEP 031", 'Froakie XY03', 'wug 224/091', 'sv3pt5-4'];
    const broken = lines
      .map((l) => [l, resolveTypedLine(l, deps)])
      .filter(([, r]) => r.status === 'resolved' && !deps.cardDb[r.card_id])
      .map(([l, r]) => `${l} -> ${r.card_id}`);
    assert.deepEqual(broken, [], 'these resolved to ids the catalogue does not hold');
  });
});
