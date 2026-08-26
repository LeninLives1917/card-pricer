// tests/regression/ocr-regions.spec.js
//
// The pure half of the no-AI image path: band geometry, band parsing, and
// choosing a card once the number has narrowed the field.
//
// STATE, 26 Aug 2026 — NOT WIRED INTO ANY ROUTE, and the header of
// pricing/ocr-first/regions.js says why. Measured against all 64 real
// benchmark photographs:
//
//     rectified          56/64
//     number arbitrated  33/64
//     name read          34/64
//     CORRECT            19/64   (30%)
//     wrong               1/64
//     asked              12/64
//     nothing            32/64
//
// The architecture holds up. Rectification is good — the failures inspected by
// hand produced clean, correctly-cropped 600x840 cards. The name band reads
// well when the card is the right way up ("Wash Rotom" came out perfectly).
//
// What fails is READING THE DIGITS. Pokemon prints its collector numbers in a
// stylised custom face, and stock Tesseract eng cannot read it: 055/182 comes
// back as 088/187 and no preprocessing recovers it. Six variants were tried
// (plain, x10 upscale, threshold, negate, negate+threshold, sharpen), each at
// two page-segmentation modes; all twelve misread the same digits the same way.
//
// So this is a font problem, not a tuning problem, and the fix is a
// font-specific reader — a trained Tesseract model or straight template
// matching over the eleven fixed glyphs (0-9 and /). Everything specced below
// is independent of which reader is used, which is why it is worth keeping.
//
// These tests cover only the pure functions. The OCR itself is injected, so
// nothing here needs Tesseract installed.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  NAME_BAND, NUMBER_BAND, NUMBER_SWEEP,
  readNumberBand, readNameBand, toTypedLine,
  candidatesAtNumber, chooseByName,
} from '../../pricing/ocr-first/regions.js';

let db;
let printedTotalFor;
before(async () => {
  db = JSON.parse(await readFile('data/card-db.json', 'utf8'));
  const raw = JSON.parse(await readFile('pricing/reference/pokemon-sets.json', 'utf8'));
  const sets = Array.isArray(raw) ? raw : (raw.data || Object.values(raw));
  const m = new Map(sets.map((s) => [s.id, Number(s.printedTotal)]));
  printedTotalFor = (sid) => m.get(sid) ?? null;
});

describe('band geometry stays inside the card', () => {
  for (const [name, band] of [['NAME_BAND', NAME_BAND], ['NUMBER_BAND', NUMBER_BAND]]) {
    test(`${name} is a fraction of the card, not a pixel rectangle`, () => {
      // Fractions so the bands hold at any capture resolution.
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.ok(band[k] > 0 && band[k] < 1, `${name}.${k} must be a fraction`);
      }
      assert.ok(band.x + band.w <= 1, `${name} runs off the right edge`);
      assert.ok(band.y + band.h <= 1, `${name} runs off the bottom edge`);
    });
  }

  test('the sweep overlaps rather than tiling', () => {
    // A single tuned rectangle DOES read the number — and moving it by 0.005
    // turns "133/182" into "122/7182". The sweep exists because that is too
    // brittle to ship.
    assert.ok(NUMBER_SWEEP.length >= 4, 'one band is a measurement, several are a vote');
    const widths = new Set(NUMBER_SWEEP.map((b) => b.w));
    assert.ok(widths.size > 1, 'bands of identical width cannot disagree usefully');
  });
});

describe('readNumberBand', () => {
  test('the real strip off a benchmark photo', () => {
    assert.deepEqual(readNumberBand('133/182'), { number: '133', total: '182', set_code: null });
  });

  test('leading zeros survive — the resolver normalises, this does not guess', () => {
    assert.equal(readNumberBand('055/182').number, '055');
  });

  test('a subset denominator loses its letters', () => {
    // The total is compared against a set's printed card COUNT.
    assert.equal(readNumberBand('TG19/TG30').total, '30');
  });

  test('common OCR confusions are repaired before matching', () => {
    assert.equal(readNumberBand('|33/182').number, '133');
    assert.equal(readNumberBand('O55/182').number, '055');
  });

  test('noise with no number is null, not a guess', () => {
    assert.equal(readNumberBand(''), null);
    assert.equal(readNumberBand('Illus. Kazumasa Yasukuni'), null);
  });
});

describe('readNameBand', () => {
  test('keeps the punctuation Pokemon names actually use', () => {
    assert.equal(readNameBand("N's Zoroark ex"), "N's Zoroark ex");
    assert.equal(readNameBand('Ho-Oh'), 'Ho-Oh');
  });

  test('takes the first line only', () => {
    // "Evolves from ..." sits directly under the name on every evolved card.
    assert.equal(readNameBand("Marnie's Scrafty\nEvolves from Marnie's Scraggy"), "Marnie's Scrafty");
  });

  test('a scrap of noise is not a name', () => {
    assert.equal(readNameBand('a'), null);
    assert.equal(readNameBand('  '), null);
  });
});

describe('candidatesAtNumber narrows before the name is used', () => {
  test('number + total selects a handful, not the catalogue', () => {
    // Paradox Rift and Destined Rivals both print 182 cards, which is why the
    // benchmark photos land on exactly two candidates every time.
    const c = candidatesAtNumber('133', '182', { cardDb: db, printedTotalFor });
    assert.ok(c.length >= 1 && c.length <= 6, `expected a handful, got ${c.length}`);
    assert.ok(c.includes('sv10-133'), 'the true card must be in the pool');
  });

  test('leading zeros do not change the pool', () => {
    const a = candidatesAtNumber('55', '182', { cardDb: db, printedTotalFor });
    const b = candidatesAtNumber('055', '182', { cardDb: db, printedTotalFor });
    assert.deepEqual(a.sort(), b.sort());
  });
});

describe('chooseByName picks from the pool, and abstains when it cannot', () => {
  test('a garbled name still separates two real candidates', () => {
    // "Mami" is what OCR actually returned for Marnie's Scrafty. Against the
    // whole catalogue it matches nothing; against {Doublade, Marnie's Scrafty}
    // it is obvious.
    const pool = candidatesAtNumber('133', '182', { cardDb: db, printedTotalFor });
    const pick = chooseByName(pool, 'Mami', db);
    assert.equal(pick.id, 'sv10-133');
    assert.equal(pick.confident, true);
  });

  test('a single candidate needs no name at all', () => {
    const pick = chooseByName(['base1-4'], null, db);
    assert.equal(pick.id, 'base1-4');
    assert.equal(pick.confident, true);
  });

  test('a name matching nothing is not evidence', () => {
    // The dangerous case: OCR read the flavour text or the wrong side of the
    // card. Half the characters wrong means it did not read this card's name.
    const pool = candidatesAtNumber('133', '182', { cardDb: db, printedTotalFor });
    const pick = chooseByName(pool, 'zzzzqqq', db);
    assert.equal(pick.confident, false, 'garbage must abstain, never choose');
  });

  test('two candidates and no name abstains', () => {
    const pool = candidatesAtNumber('133', '182', { cardDb: db, printedTotalFor });
    assert.ok(pool.length > 1);
    assert.equal(chooseByName(pool, '', db), null);
  });
});

describe('toTypedLine produces what the resolver already understands', () => {
  test('name + number/total', () => {
    assert.equal(toTypedLine({ name: 'Marn', number: '133', total: '182' }), 'Marn 133/182');
  });

  test('no number means no line — the number is the anchor', () => {
    assert.equal(toTypedLine({ name: 'Marn' }), null);
    assert.equal(toTypedLine({}), null);
  });
});
