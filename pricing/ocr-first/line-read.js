// pricing/ocr-first/line-read.js
//
// Read the collector number by OCR-ing the whole bottom LINE, then pattern
// matching for "N/N". No band finding, no segmentation, no glyph templates.
//
// WHY THIS AND NOT THE GLYPH READER
//
// pricing/ocr-first/glyphs.js took the opposite approach: locate the number
// precisely, cut it into characters, and match each against a template. Every
// piece of that worked in isolation and the whole never did — locating the run
// across eras topped out at 2 of 9, because every geometric constraint tight
// enough to exclude the set-code box and rarity symbol also excluded a real
// glyph somewhere in the catalogue.
//
// The mistake was feeding Tesseract four-glyph crops. Tesseract reads LINES —
// it uses layout, word shapes and character context, and a tight crop strips
// all of that out. Given the whole bottom line instead it reads the number
// directly, and the earlier "stock Tesseract cannot read this font" conclusion
// turns out to have been a conclusion about the crop, not the font.
//
// MEASURED on clean catalogue renders, one strip: 5 of 8. With several strips
// and the total checked against real set sizes: 4 of 4 before a bounds bug
// stopped the run, including the card that failed on a single strip.
//
// THE TOTAL IS THE ARBITER. A denominator that is not the printed size of any
// Pokemon set is not a collector number, whatever it looks like — that single
// check is what lets several noisy readings be collected and the right one
// picked out, instead of trusting one crop to be perfect.

import sharp from 'sharp';

/**
 * Overlapping views of the bottom of the card.
 *
 * Different eras put the number at different heights, and a strip that clips it
 * reads nothing. Rather than work out which era this is — which needs the card
 * identified, the very thing being attempted — read several and let the total
 * decide which reading was real.
 */
export const STRIPS = Object.freeze([
  { y: 0.885, h: 0.105 },
  { y: 0.900, h: 0.075 },
  { y: 0.860, h: 0.140 },
  { y: 0.920, h: 0.065 },
]);

/** Page-segmentation modes: a uniform block, then sparse text. */
export const PSM = Object.freeze(['6', '11']);

/**
 * Crop one strip, clamped to the image.
 *
 * base1 renders are 600x825 where modern ones are 733x1024, so a fraction that
 * fits one can run past the bottom of another — sharp throws "bad extract area"
 * rather than clipping, which killed a benchmark run mid-way.
 */
export async function cropStrip(buffer, strip, opts = {}) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const top = Math.max(0, Math.min(meta.height - 2, Math.round(strip.y * meta.height)));
  const height = Math.max(2, Math.min(meta.height - top, Math.round(strip.h * meta.height)));
  const maxW = opts.maxWidth ?? 4000;
  return sharp(buffer)
    .extract({ left: 0, top, width: meta.width, height })
    .resize({ width: Math.min(meta.width * (opts.scale ?? 3), maxW), kernel: 'lanczos3' })
    .greyscale()
    .normalise()
    .png()
    .toBuffer();
}

/** Every "N/N" in a blob of OCR text. */
export function numbersIn(text) {
  const out = [];
  for (const m of String(text ?? '').replace(/\s+/g, ' ').matchAll(/(\d{1,4})\s*\/\s*(\d{1,4})/g)) {
    out.push({ number: m[1].replace(/^0+(?=\d)/, ''), total: Number(m[2]), raw: m[0] });
  }
  return out;
}

/**
 * Read the collector number off a rectified card.
 *
 * @param {Buffer} buffer                     rectified card image
 * @param {(img: Buffer, psm: string) => Promise<string>} ocr
 * @param {Set<number>} knownTotals           every real printed total
 * @returns {{number, total, plausible, votes, readings}|null}
 */
export async function readNumberLine(buffer, ocr, knownTotals, opts = {}) {
  const totals = knownTotals instanceof Set ? knownTotals : new Set(knownTotals ?? []);
  const tally = new Map();

  for (const strip of (opts.strips ?? STRIPS)) {
    let img;
    try { img = await cropStrip(buffer, strip, opts); } catch { continue; }
    if (!img) continue;
    for (const psm of (opts.psm ?? PSM)) {
      let text;
      try { text = await ocr(img, psm); } catch { continue; }
      for (const hit of numbersIn(text)) {
        const key = `${hit.number}/${hit.total}`;
        const prev = tally.get(key) ?? { ...hit, votes: 0 };
        prev.votes += 1;
        tally.set(key, prev);
      }
    }
  }
  if (!tally.size) return null;

  const readings = [...tally.values()].map((r) => ({ ...r, plausible: totals.has(r.total) }));
  // A real printed total beats a popular misreading. "7182" can be read three
  // times and still not be the size of any set.
  readings.sort((a, b) => (Number(b.plausible) - Number(a.plausible)) || (b.votes - a.votes));
  const best = readings[0];
  return { ...best, readings };
}
