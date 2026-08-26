// tests/regression/ocr-line-read.spec.js
//
// Reading the collector number by OCR-ing the whole bottom LINE and pattern
// matching for "N/N" — no band finding, no segmentation, no glyph templates.
//
// WHY THIS REPLACED THE GLYPH READER
//
// pricing/ocr-first/glyphs.js tried the precise approach: locate the number,
// cut it into characters, match each against a template. Every piece worked in
// isolation and the whole never did — locating the run across eras topped out
// at 2 of 9, because every geometric rule tight enough to exclude the set-code
// box and rarity symbol also excluded a real glyph somewhere.
//
// The mistake was feeding Tesseract four-glyph crops. Tesseract reads LINES: it
// uses layout, word shapes and character context, and a tight crop strips all
// of that away. Given the whole bottom line it reads the number directly, and
// the earlier "stock Tesseract cannot read this font" finding turns out to have
// been about the crop, not the font.
//
// MEASURED, clean catalogue renders across twelve eras:  9/12  (glyph: 2/9)
// MEASURED, 64 real photographs:                        18/64, 3 wrong
//
// The gap between those two numbers is the honest state of this work. On a good
// image it reads the card; on a casual table photograph it usually does not,
// and 34 of the 64 never yield a readable number at all. Rectifying at 1800x2520
// instead of 600x840 did NOT close it — number-read stayed at exactly 30/64 for
// 8x the time — so the limit is the photographs, not resolution or algorithm.
//
// These specs cover the pure parts. OCR is injected, so nothing here needs
// Tesseract installed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import sharp from 'sharp';

import { STRIPS, PSM, numbersIn, readNumberLine } from '../../pricing/ocr-first/line-read.js';

/** A real (blank) card-shaped image — cropStrip runs sharp on whatever it gets. */
const card = () => sharp({
  create: { width: 300, height: 420, channels: 3, background: { r: 20, g: 20, b: 20 } },
}).png().toBuffer();

describe('numbersIn finds every N/N in a noisy line', () => {
  test('a real OCR dump off a card bottom', () => {
    const raw = 'Illus. Kazumasa Yasukuni | DRI EN 133/182 Groups of them beat up anything';
    assert.deepEqual(numbersIn(raw).map((n) => `${n.number}/${n.total}`), ['133/182']);
  });

  test('leading zeros are normalised, the total stays a number', () => {
    const [hit] = numbersIn('055/182');
    assert.equal(hit.number, '55');
    assert.equal(hit.total, 182);
  });

  test('spaces around the slash do not hide it', () => {
    assert.equal(numbersIn('133 / 182')[0].total, 182);
  });

  test('several candidates are all returned, not just the first', () => {
    // A copyright line can carry digits too. Picking one here would be a guess;
    // the caller arbitrates with real set sizes.
    assert.equal(numbersIn('1995, 96 4/102 and 12/34').length, 2);
  });

  test('a line with no number yields none', () => {
    assert.deepEqual(numbersIn('Illus. Mitsuhiro Arita'), []);
    assert.deepEqual(numbersIn(''), []);
    assert.deepEqual(numbersIn(null), []);
  });
});

describe('readNumberLine arbitrates with real set sizes', () => {
  test('a real printed total beats a more popular misreading', async () => {
    // "7182" can be read three times and still not be the size of any set.
    const r = await readNumberLine(await card(), async () => 'x 133/7182 y 133/182', new Set([182]));
    assert.equal(r.number, '133');
    assert.equal(r.total, 182);
    assert.equal(r.plausible, true);
  });

  test('with nothing plausible it still reports, flagged', async () => {
    // Absent is different from implausible, and the caller needs to tell them
    // apart — one is "no reading", the other is "a reading I do not believe".
    const r = await readNumberLine(await card(), async () => '133/7182', new Set([182]));
    assert.equal(r.total, 7182);
    assert.equal(r.plausible, false);
  });

  test('no reading at all is null, never a guess', async () => {
    assert.equal(await readNumberLine(await card(), async () => 'Illus. Kazumasa Yasukuni', new Set([182])), null);
  });

  test('an OCR that throws does not take the read down with it', async () => {
    const buf = await card();
    await assert.doesNotReject(() => readNumberLine(buf, async () => { throw new Error('worker died'); }, new Set([182])));
  });

  test('votes are counted across strips and modes', async () => {
    const r = await readNumberLine(await card(), async () => '133/182', new Set([182]));
    assert.equal(r.votes, STRIPS.length * PSM.length,
      'every strip and mode that agreed should be counted');
  });
});

describe('the strips overlap on purpose', () => {
  test('several views, because the number sits at different heights per era', () => {
    assert.ok(STRIPS.length >= 3);
    const heights = new Set(STRIPS.map((s) => s.h));
    assert.ok(heights.size > 1, 'identical strips cannot disagree usefully');
    for (const s of STRIPS) assert.ok(s.y + s.h <= 1.001, 'a strip must stay on the card');
  });
});
