// Pins pricing/text-entry/tokenise.js — the parser that refuses to decide.
//
// WHY THIS EXISTS
//
// apps/vendor/modules/text-parse.js is an ordered regex cascade: first match
// wins, ordering fixed at authoring time. Measured behaviour before this
// module existed:
//
//   "Charizard ex 056/197"  ->  name "Charizard",  set_code "EX"
//   "Mew VMAX 114/264"      ->  name "Mew",        set_code "VMAX"
//   "cha 4/102"             ->  name null,         set_code "CHA"
//   "cha 4/102 nm"          ->  name "nm"
//   "charizard 4/102"       ->  unparsed
//
// The first two matter most: ~700 of 4,456 distinct catalogue names (15.7%)
// end in ex/V/VMAX/VSTAR/GX, and those carry 16.3% of catalogue value against
// 8.6% of cards. The defect is concentrated on the chase cards.
//
// It cannot be fixed with more regexes, because "MEG 172/132" and "cha 4/102"
// are the SAME SHAPE and the line does not say which token is a set code. The
// catalogue says. So the tokeniser emits both readings and the resolver
// arbitrates.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tokeniseLine } from '../../pricing/text-entry/tokenise.js';

const shapes = (line) => tokeniseLine(line).interpretations.map((i) => i.shape);
const byShape = (line, shape) => tokeniseLine(line).interpretations.find((i) => i.shape === shape);
const top = (line) => tokeniseLine(line).interpretations[0];

describe('the ambiguity is emitted, not resolved', () => {
  test('"cha 4/102" yields BOTH a name reading and a set-code reading', () => {
    assert.deepEqual(shapes('cha 4/102').sort(), ['name_only', 'set_then_name']);
  });

  test('"MEG 172/132" yields the same two readings — it is the same shape', () => {
    // This is the whole argument for the rewrite. If the tokeniser could tell
    // these apart it would not need to emit two readings; it cannot, because
    // the information is not in the line.
    assert.deepEqual(shapes('MEG 172/132').sort(), ['name_only', 'set_then_name']);
  });
});

describe('the "ex" trap', () => {
  test('"Charizard ex 056/197" keeps the suffix in the top reading', () => {
    const t = top('Charizard ex 056/197');
    assert.equal(t.shape, 'name_only');
    assert.equal(t.name, 'Charizard ex');
    assert.equal(t.card_number, '056');
    assert.equal(t.total, '197');
  });

  test('the set-code reading still exists, but is heavily penalised', () => {
    // EX is a REAL set code (165 cards, ecard1), so it cannot simply be
    // deleted from consideration — that would be the mirror of the bug. It is
    // ranked low and left for the catalogue to reject.
    const i = byShape('Charizard ex 056/197', 'name_then_set');
    assert.equal(i.set_code, 'EX');
    assert.ok(i.prior < 0.5, `expected a low prior, got ${i.prior}`);
    assert.ok(i.prior < top('Charizard ex 056/197').prior);
  });

  test('every known name suffix is protected the same way', () => {
    for (const [line, name] of [
      ['Mew VMAX 114/264', 'Mew VMAX'],
      ['Charizard VSTAR 018/172', 'Charizard VSTAR'],
      ['Umbreon GX 154/149', 'Umbreon GX'],
      ['Pikachu V 043/172', 'Pikachu V'],
    ]) {
      assert.equal(top(line).name, name, line);
    }
  });
});

describe('shapes the old cascade could not parse at all', () => {
  test('name + num/total, with no set code', () => {
    const t = top('charizard 4/102');
    assert.equal(t.name, 'charizard');
    assert.equal(t.card_number, '4');
    assert.equal(t.total, '102');
  });

  test('the catalogue key form', () => {
    const t = top('sv3pt5-4');
    assert.equal(t.shape, 'catalogue_key');
    assert.equal(t.set_code, 'sv3pt5');
    assert.equal(t.card_number, '4');
  });

  test('a hash-prefixed number', () => {
    assert.equal(top('Charizard #4').card_number, '4');
  });

  test('a promo badge beside its number yields both readings', () => {
    // "SVP 056" prints as a badge, a gap, then digits — but a model or a human
    // may run them together, and "XY03" genuinely IS one token. Both go
    // forward rather than one being guessed.
    const s = shapes("N's Zekrom MEP 031");
    assert.ok(s.includes('name_then_set'));
    assert.equal(byShape("N's Zekrom MEP 031", 'name_then_set').name, "N's Zekrom");
  });
});

describe('position is preserved', () => {
  test('trailing annotations do not become part of the name', () => {
    // The operator really pastes this line. Flattening the words after the
    // number into the name gives "Team Rockets Crobat ex dri League Promo
    // Stamp", which matches nothing.
    const i = byShape('Team Rockets Crobat ex dri en 122/182 League Promo Stamp', 'name_then_set');
    assert.equal(i.name, 'Team Rockets Crobat ex');
    assert.equal(i.set_code, 'DRI');
    assert.equal(i.extras, 'League Promo Stamp');
  });

  test('the legacy set-first shape survives, with the name AFTER the number', () => {
    const i = byShape('MEG 172 Pikachu', 'set_then_name');
    assert.equal(i.set_code, 'MEG');
    assert.equal(i.card_number, '172');
    assert.equal(i.name, 'Pikachu');
  });
});

describe('quantity, condition and finish', () => {
  test('a leading quantity is extracted, not glued to the name', () => {
    // The old parser produced name "3x Charizard".
    const t = top('3x Charizard ex 056/197');
    assert.equal(t.qty, 3);
    assert.equal(t.name, 'Charizard ex');
  });

  test('a trailing "3x" is NOT treated as a quantity', () => {
    // It is somebody's shorthand for something else, and guessing is not the
    // parser's job.
    assert.equal(top('Charizard ex 056/197 3x').qty, 1);
  });

  test('condition and finish are extracted — finish changes the PRICE', () => {
    // A reverse holo and a normal are different products on Cardmarket, and
    // the price adapters already accept card.variant. The parser has simply
    // never extracted it.
    const t = top('cha 4/102 nm reverse');
    assert.equal(t.condition, 'NM');
    assert.equal(t.finish, 'reverse_holo');
    assert.equal(t.name, 'cha');
  });

  test('"ex" is never read as a condition grade', () => {
    // EX is a grade in some vocabularies. Here it is on ~700 card names, so
    // treating it as a grade would rebuild the trap from the other side.
    const t = top('Charizard ex 056/197');
    assert.equal(t.condition, null);
    assert.equal(t.name, 'Charizard ex');
  });

  test('a language token is extracted and does not pollute the name', () => {
    const t = top('Mystery Garden meg en 172/132');
    assert.equal(t.lang, 'en');
    assert.ok(!/\ben\b/.test(t.name ?? ''));
  });
});

describe('refusals', () => {
  test('an empty line yields nothing', () => {
    assert.deepEqual(tokeniseLine('').interpretations, []);
    assert.deepEqual(tokeniseLine('   ').interpretations, []);
    assert.deepEqual(tokeniseLine(null).interpretations, []);
  });

  test('a line with no number at all yields no interpretation', () => {
    // Without a collector number there is nothing to resolve against, and the
    // catalogue is only 6.9% unique on name alone.
    assert.deepEqual(tokeniseLine('Charizard').interpretations, []);
  });

  test('readings come back sorted, strongest prior first', () => {
    const priors = tokeniseLine('Mystery Garden meg en 172/132').interpretations.map((i) => i.prior);
    assert.deepEqual(priors, [...priors].sort((a, b) => b - a));
  });
});

describe('spacing is a keyboard problem, not an ambiguity', () => {
  // Reported from real use: "it should work with both". People type "4/102",
  // "4 / 102" and "cha4/102" and mean one card. The tokeniser splits on
  // whitespace, so those arrive as one token, three tokens and one glued
  // token — three parses of one intent. Normalising the spacing is the only
  // rewriting done to a line, and it changes which READINGS are possible not
  // at all; it just stops the splitter mangling them.

  test('spaces around the slash do not change the reading', () => {
    for (const v of ['cha 4/102', 'cha 4 / 102', 'cha 4/ 102', 'cha 4 /102']) {
      const t = top(v);
      assert.equal(t.card_number, '4', v);
      assert.equal(t.total, '102', v);
      assert.equal(t.name, 'cha', v);
    }
  });

  test('a name glued to its number is split', () => {
    assert.equal(top('cha4/102').name, 'cha');
    assert.equal(top('cha4/102').card_number, '4');
    assert.equal(byShape('MEG172/132', 'set_then_name').set_code, 'MEG');
  });

  test('tabs and runs of spaces collapse', () => {
    assert.equal(top('  cha    4/102  ').name, 'cha');
    assert.equal(top('cha\t4/102').name, 'cha');
  });

  test('normalising does NOT glue a real name to a real number', () => {
    // "Charizard ex 056/197" must keep its suffix and its denominator.
    const t = top('Charizard ex 056/197');
    assert.equal(t.name, 'Charizard ex');
    assert.equal(t.card_number, '056');
    assert.equal(t.total, '197');
  });
});

describe('a promo badge separated from its number', () => {
  test('"Froakie XY 03" yields the rejoined reading "XY03"', () => {
    // The badge and the digits are separate elements on the card, printed
    // with a gap, so whether a person types a space between them is a coin
    // toss. The catalogue stores the joined form (xyp-XY03).
    const i = byShape('Froakie XY 03', 'promo_split_rejoined');
    assert.ok(i, 'the rejoined reading must exist');
    assert.equal(i.card_number, 'XY03');
    assert.equal(i.name, 'Froakie');
  });

  test('the rejoin does NOT fire when a denominator was given', () => {
    // "Charizard ex 056/197" has a total, so "ex" is a name suffix and not a
    // badge. Rejoining would invent "EX056".
    assert.equal(byShape('Charizard ex 056/197', 'promo_split_rejoined'), undefined);
  });

  test('a name suffix is heavily penalised even when it could be a badge', () => {
    const i = byShape('Pikachu V 43', 'promo_split_rejoined');
    if (i) assert.ok(i.prior < 0.2, `expected a low prior for a name suffix, got ${i.prior}`);
  });
});
