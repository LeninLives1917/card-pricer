// tests/regression/ocr-glyphs.spec.js
//
// The primitives for a glyph reader: binarise, segment, normalise, average,
// match. All pure, all tested on synthetic bitmaps so nothing here needs the
// network or an image decoder.
//
// STATE, 26 Aug 2026 — the primitives work, the END-TO-END READER DOES NOT, and
// pricing/ocr-first/glyphs.js says so at the top. What is proven:
//
//   - segmentation splits a correctly-placed band into the right glyph count
//     (sv10-133 -> 7 glyphs for "133/182"; swsh12-140 -> 7 for "140/195")
//   - the typeface is ONE family across eras — sv10, swsh12 and xy5 bands are
//     visibly the same bold-italic numerals, so one template set should cover
//     the catalogue
//   - the catalogue is a free labelled training set: 20,313 cards carry an
//     image URL and their collector number is in their own id
//
// What is NOT solved: finding the band. Layout moves between eras — bottom-LEFT
// from Sword & Shield onward (7,950 cards), bottom-RIGHT on XY and earlier
// (12,363) — and fixed fractions that work on sv10 miss on base1 and neo4.
// Scanning the whole bottom strip instead does not rescue it: at full width the
// strip binarises into one connected mass and segments into a single box.
//
// So the remaining work is per-era band calibration, and it is a sub-project
// rather than a loose end.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GLYPH_W, GLYPH_H, BAND_LEFT, BAND_RIGHT, bandForSet,
  binarise, segmentGlyphs, selectNumberRun,
  normaliseGlyph, averageGlyphs, matchScore, readGlyphs,
} from '../../pricing/ocr-first/glyphs.js';

/** Paint a strip: `bars` are [x0,x1,y0,y1] rectangles of ink. */
function strip(width, height, bars, { dark = false } = {}) {
  const bg = dark ? 220 : 30;
  const fg = dark ? 30 : 220;
  const data = new Uint8Array(width * height).fill(bg);
  for (const [x0, x1, y0, y1] of bars) {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) data[y * width + x] = fg;
  }
  return { data, width, height };
}

describe('band selection follows the layout, not the font', () => {
  test('Sword & Shield onward reads the bottom-left', () => {
    for (const s of ['swsh12', 'sv10', 'me4', 'zsv10pt5']) {
      assert.equal(bandForSet(s), BAND_LEFT, s);
    }
  });

  test('XY and earlier read the bottom-right', () => {
    for (const s of ['xy5', 'base1', 'neo4', 'ex10', 'sm10']) {
      assert.equal(bandForSet(s), BAND_RIGHT, s);
    }
  });

  test('both bands stay inside the card', () => {
    for (const b of [BAND_LEFT, BAND_RIGHT]) {
      assert.ok(b.x + b.w <= 1 && b.y + b.h <= 1);
    }
  });
});

describe('binarise picks its own polarity', () => {
  test('light ink on a dark band', () => {
    const bin = binarise(strip(40, 20, [[5, 9, 4, 15]]));
    assert.equal(bin.inkIsDark, false);
    assert.equal(bin.on[10 * 40 + 7], 1, 'the bar is ink');
    assert.equal(bin.on[10 * 40 + 30], 0, 'the background is not');
  });

  test('dark ink on a light band', () => {
    const bin = binarise(strip(40, 20, [[5, 9, 4, 15]], { dark: true }));
    assert.equal(bin.inkIsDark, true);
    assert.equal(bin.on[10 * 40 + 7], 1);
    assert.equal(bin.on[10 * 40 + 30], 0);
  });

  test('the minority is always the ink', () => {
    // Text covers a small share of a band. Whichever polarity lights up most of
    // the pixels is the background, whatever era the card is from.
    const mostlyLight = binarise(strip(40, 20, [[0, 35, 0, 19]], { dark: true }));
    assert.equal(mostlyLight.inkIsDark, false);
  });
});

describe('segmentGlyphs splits on empty columns', () => {
  test('three separated bars are three glyphs', () => {
    const bin = binarise(strip(60, 20, [[4, 8, 3, 16], [16, 20, 3, 16], [28, 32, 3, 16]]));
    assert.equal(segmentGlyphs(bin).length, 3);
  });

  test('a short mark is not a glyph', () => {
    // A rarity dot or a stray speck sits well below the digit line.
    const bin = binarise(strip(60, 20, [[4, 8, 3, 16], [16, 20, 14, 16]]));
    assert.equal(segmentGlyphs(bin).length, 1);
  });

  test('touching characters segment as one — and that is fine', () => {
    // A projection split cannot separate them. During training a band whose
    // glyph count does not match the label is DISCARDED, so a bad split costs
    // a sample and never poisons a template.
    const bin = binarise(strip(60, 20, [[4, 20, 3, 16]]));
    assert.equal(segmentGlyphs(bin).length, 1);
  });
});

describe('selectNumberRun keeps the digits and drops the furniture', () => {
  test('a tall isolated symbol is excluded', () => {
    // Bands carry a regulation mark, a set-code box and a rarity symbol. Digits
    // share a height and a baseline; furniture does not.
    const bin = binarise(strip(120, 30, [
      [4, 10, 2, 27],      // tall box — furniture
      [30, 36, 8, 24], [40, 46, 8, 24], [50, 56, 8, 24],  // three digits
      [90, 104, 6, 26],    // wide symbol — furniture
    ]));
    const run = selectNumberRun(segmentGlyphs(bin));
    assert.equal(run.length, 3, 'only the digits survive');
    assert.ok(run.every((b) => b.x0 >= 30 && b.x1 <= 56));
  });

  test('an empty band yields an empty run', () => {
    assert.deepEqual(selectNumberRun([]), []);
  });
});

describe('normalise and match', () => {
  test('a glyph normalises to the fixed box regardless of its size', () => {
    const bin = binarise(strip(60, 30, [[10, 14, 5, 24]]));
    const [box] = segmentGlyphs(bin);
    const cell = normaliseGlyph(bin, box);
    assert.equal(cell.length, GLYPH_W * GLYPH_H);
  });

  test('aspect ratio is deliberately discarded', () => {
    // A "1" is far narrower than an "8". Stretching both to one box turns that
    // difference into shape rather than size, which is what makes fixed-size
    // template comparison work.
    const narrow = binarise(strip(60, 30, [[10, 12, 5, 24]]));
    const wide = binarise(strip(60, 30, [[10, 24, 5, 24]]));
    const a = normaliseGlyph(narrow, segmentGlyphs(narrow)[0]);
    const b = normaliseGlyph(wide, segmentGlyphs(wide)[0]);
    assert.ok(matchScore(a, b) > 0.9, 'two solid blocks look alike once normalised');
  });

  test('a template is the mean of its samples', () => {
    const a = new Float32Array(GLYPH_W * GLYPH_H).fill(1);
    const b = new Float32Array(GLYPH_W * GLYPH_H).fill(0);
    const avg = averageGlyphs([a, b]);
    assert.ok(Math.abs(avg[0] - 0.5) < 1e-6);
  });

  test('an identical shape scores 1, an inverted one scores 0', () => {
    const a = new Float32Array(GLYPH_W * GLYPH_H).fill(1);
    const b = new Float32Array(GLYPH_W * GLYPH_H).fill(0);
    assert.ok(Math.abs(matchScore(a, a) - 1) < 1e-6);
    assert.ok(Math.abs(matchScore(a, b) - 0) < 1e-6);
  });
});

describe('readGlyphs reports how sure it was', () => {
  test('every glyph carries a score and a margin over the runner-up', () => {
    // A reader that only returns text cannot be gated. The margin is what a
    // caller uses to decide between answering and asking.
    const bin = binarise(strip(60, 24, [[6, 12, 4, 19], [20, 26, 4, 19]]));
    const solid = new Float32Array(GLYPH_W * GLYPH_H).fill(1);
    const empty = new Float32Array(GLYPH_W * GLYPH_H).fill(0);
    const out = readGlyphs(bin, { 8: solid, 1: empty });
    assert.equal(out.text.length, 2);
    for (const g of out.glyphs) {
      assert.ok(typeof g.score === 'number' && typeof g.margin === 'number');
    }
    assert.ok(out.minScore <= 1);
  });

  test('no templates means no reading, not a guess', () => {
    const bin = binarise(strip(60, 24, [[6, 12, 4, 19]]));
    assert.equal(readGlyphs(bin, {}), null);
  });
});
