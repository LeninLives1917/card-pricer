// pricing/ocr-first/glyphs.js
//
// A glyph reader for Pokemon collector numbers.
//
// STATUS: PRIMITIVES ONLY, NOT WIRED INTO ANY ROUTE. The pieces below are
// tested and work; the end-to-end reader does not, because finding the band is
// unsolved. What is proven and what is not is set out under "WHERE THIS GOT TO"
// at the bottom of this comment.
//
//
// WHY NOT GENERAL OCR
//
// Stock Tesseract cannot read these digits. Measured 26 Aug 2026 on the 64-photo
// benchmark: a crisp, correctly-cropped "055/182" comes back as "088/187", and
// six preprocessing variants at two page-segmentation modes all misread the same
// digits identically. General OCR hedges across every typeface it might be
// looking at, and that hedging is the error.
//
// This asks a much smaller question. The alphabet is ELEVEN characters — 0-9 and
// the slash — and the typeface never changes: bands pulled from sv10, swsh12 and
// xy5 are visibly the same bold-italic face. So instead of inference, compare
// each glyph against eleven known shapes and take the closest.
//
// WHERE THE TEMPLATES COME FROM
//
// The catalogue is already a labelled training set. Every card record carries an
// image URL, and its collector number is in its own id: sv10-133 IS the label
// "133". Crop the band, cut it into glyphs, and if the glyph count matches the
// expected string the assignment is unambiguous — no hand-labelling, and every
// era covered.
//
// Only descriptors are kept. The card art is fetched, measured and discarded,
// which is the rule CLAUDE.md already sets for reference images.
//
// LAYOUT, not font, is what varies:
//   Sword & Shield onward  number at the bottom-LEFT   (7,950 labelled images)
//   XY and earlier         number at the bottom-RIGHT  (12,363)
//
// Reading the wrong corner is why the earlier Tesseract sweep returned nothing
// on older cards — it was not failing to read them, it was not looking at them.

// WHERE THIS GOT TO, 26 Aug 2026.
//
// PROVEN:
//   - segmentation splits a correctly-placed band into the right glyph count —
//     sv10-133 gives 7 glyphs for "133/182", swsh12-140 gives 7 for "140/195"
//   - the typeface is ONE family across eras: bands from sv10, swsh12 and xy5
//     are visibly the same bold-italic numerals, so a single template set
//     should cover the catalogue rather than one per era
//   - the catalogue is a free labelled training set — 20,313 cards carry an
//     image URL and the collector number is in the card's own id
//
// FINDING THE BAND WITHOUT KNOWING THE ERA — the right idea, still unfinished.
//
// bandForSet() takes a set id and returns a corner, which is circular for
// anything but training: the set id is what we are trying to work out. Reading
// an unseen card cannot begin by knowing where its era printed the number. So
// findNumberBand() scans BOTH corners at several thresholds and lets the card
// say which one holds a number-shaped run of glyphs.
//
// That fixed the blob problem — a corner is small enough to threshold sensibly,
// where the full-width strip merged into one 2199x339 mass — but locating the
// run is still only 2 of 9 across eras. Three scoring rules were tried and each
// failed differently; they are recorded so nobody repeats them:
//
//   1. Evenness of height and baseline, no length term. Rejected the "/" (in
//      this italic face it is taller than the numerals and descends below the
//      baseline), which SPLIT "133/182" into two 3-glyph runs — and with no
//      length term the 3-glyph slice scored BETTER than the whole, because a
//      shorter window has a tighter baseline. Every card returned exactly 3
//      glyphs. 0 of 9.
//
//   2. Add a length term. Correct and necessary, but not sufficient: 2 of 9.
//
//   3. Classify the slash explicitly as "narrow and tall". Worse — a "1" is
//      narrow and tall too, so "11/105" read as three separators and was
//      rejected outright. Back to 0 of 9.
//
// Current rule is loose tolerances plus a length weight: 2 of 9. base1 and neo4
// land exactly; sv10, xy5 and sv1 find a partial run; swsh12 and sm10 find
// nothing.
//
// The pattern across all three attempts is that every constraint tight enough
// to exclude furniture also excludes a legitimate glyph somewhere in the
// catalogue. That says the discriminator should not be geometry alone — the
// templates themselves are the missing signal, and they cannot be built until
// the band is found. Breaking that circle is the actual task: bootstrap
// templates from the sets where the band IS found reliably (base1, neo4 style
// layouts), then use those templates to locate the band on the rest.
//
// OLDER NOTES — fixed-fraction bands:
//   - fixed fractions tuned on sv10 miss on base1, neo4, ex10 and sv1: the
//     glyph counts come back 2, 1, and 10 against expected 5, 6, 7
//   - scanning the whole bottom strip instead does not rescue it. At full
//     width the strip binarises into one connected mass and segments into a
//     single 2199x339 box, because the strip carries artwork, borders and
//     several text runs at different contrasts
//   - so the number band has to be calibrated per era (or per layout family),
//     which is a sub-project rather than a loose end
//
// The honest read: the approach is sound and the data to do it is free, but it
// needs sustained calibration work before it beats the vision model's measured
// 68.6%.

import sharp from 'sharp';

/** Bottom-left, Sword & Shield onward. */
export const BAND_LEFT = Object.freeze({ x: 0.03, y: 0.925, w: 0.34, h: 0.045 });
/** Bottom-right, XY and earlier. */
export const BAND_RIGHT = Object.freeze({ x: 0.55, y: 0.900, w: 0.43, h: 0.050 });

const MODERN = /^(swsh|sv|me|zsv|rsv)/;

/** Which corner this set prints its number in. */
export function bandForSet(setId) {
  return MODERN.test(String(setId)) ? BAND_LEFT : BAND_RIGHT;
}

/** Normalised glyph size. Small: these are shapes, not pictures. */
export const GLYPH_W = 16;
export const GLYPH_H = 24;

/**
 * Pull a band out of a card image as raw greyscale.
 *
 * Returns { data, width, height } so the segmenter can work on pixels without
 * re-encoding between every step.
 */
export async function bandPixels(buffer, band, opts = {}) {
  const scale = opts.scale ?? 3;
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const rect = {
    left: Math.max(0, Math.round(band.x * meta.width)),
    top: Math.max(0, Math.round(band.y * meta.height)),
    width: Math.min(meta.width, Math.round(band.w * meta.width)),
    height: Math.min(meta.height, Math.round(band.h * meta.height)),
  };
  if (rect.width < 10 || rect.height < 6) return null;
  const { data, info } = await sharp(buffer)
    .extract(rect)
    .resize({ width: rect.width * scale, kernel: 'lanczos3' })
    .greyscale()
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Binarise, choosing polarity from the band itself.
 *
 * The number is white-on-dark on modern cards and black-on-light on older ones,
 * and both appear within a single era. Rather than carry a flag around, take
 * whichever polarity yields a sane amount of ink — text covers a small minority
 * of a band, so the polarity that lights up 60% of the pixels is the background.
 */
export function binarise(px, threshold = 128) {
  const { data, width, height } = px;
  const on = new Uint8Array(width * height);
  let light = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] > threshold) light += 1;
  const inkIsDark = light > data.length / 2;
  for (let i = 0; i < data.length; i += 1) {
    on[i] = (inkIsDark ? data[i] <= threshold : data[i] > threshold) ? 1 : 0;
  }
  return { on, width, height, inkIsDark };
}

/**
 * Cut a binarised band into glyphs on empty columns.
 *
 * Deliberately simple. A projection split cannot separate touching characters,
 * and that is fine: a band whose glyph count does not match the expected label
 * is DISCARDED during training rather than guessed at, so a bad split costs a
 * sample and never poisons a template.
 */
export function segmentGlyphs(bin, opts = {}) {
  const { on, width, height } = bin;
  const minInk = opts.minInk ?? 1;
  const cols = new Int32Array(width);
  for (let x = 0; x < width; x += 1) {
    let c = 0;
    for (let y = 0; y < height; y += 1) if (on[y * width + x]) c += 1;
    cols[x] = c;
  }
  const runs = [];
  let start = -1;
  for (let x = 0; x < width; x += 1) {
    if (cols[x] >= minInk) { if (start < 0) start = x; }
    else if (start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, width - 1]);

  const minW = opts.minWidth ?? 2;
  const minH = opts.minHeight ?? Math.round(height * 0.25);
  const out = [];
  for (const [x0, x1] of runs) {
    if (x1 - x0 + 1 < minW) continue;
    let y0 = height;
    let y1 = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (on[y * width + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
      }
    }
    if (y1 < y0 || (y1 - y0 + 1) < minH) continue;
    out.push({ x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

/**
 * Scale one segmented glyph into the fixed GLYPH_W x GLYPH_H box.
 *
 * Aspect ratio is DISCARDED on purpose. A "1" is far narrower than an "8", and
 * stretching both to the same box turns that difference into shape rather than
 * size — which is what makes a fixed-size template comparison work at all.
 */
export function normaliseGlyph(bin, box) {
  const { on, width } = bin;
  const cell = new Float32Array(GLYPH_W * GLYPH_H);
  for (let gy = 0; gy < GLYPH_H; gy += 1) {
    for (let gx = 0; gx < GLYPH_W; gx += 1) {
      const sx = box.x0 + Math.floor((gx / GLYPH_W) * box.w);
      const sy = box.y0 + Math.floor((gy / GLYPH_H) * box.h);
      cell[gy * GLYPH_W + gx] = on[sy * width + sx] ? 1 : 0;
    }
  }
  return cell;
}

/** Mean of many normalised glyphs — the template. */
export function averageGlyphs(cells) {
  const acc = new Float32Array(GLYPH_W * GLYPH_H);
  for (const c of cells) for (let i = 0; i < acc.length; i += 1) acc[i] += c[i];
  for (let i = 0; i < acc.length; i += 1) acc[i] /= cells.length || 1;
  return acc;
}

/**
 * How well one glyph matches a template. 1.0 is identical.
 *
 * Plain agreement rather than correlation: the cells are near-binary, the
 * templates are means of many samples, and a simple score is easier to reason
 * about when a match goes wrong.
 */
export function matchScore(cell, template) {
  let agree = 0;
  for (let i = 0; i < cell.length; i += 1) {
    agree += 1 - Math.abs(cell[i] - template[i]);
  }
  return agree / cell.length;
}

/**
 * Read a band using a template set.
 *
 * @param {object} bin        binarised band
 * @param {object} templates  { '0': Float32Array, ..., '/': Float32Array }
 * @returns {{text, glyphs, minScore}|null}
 */
export function readGlyphs(bin, templates, opts = {}) {
  const boxes = segmentGlyphs(bin, opts);
  if (!boxes.length) return null;
  const keys = Object.keys(templates);
  if (!keys.length) return null;

  let text = '';
  let minScore = 1;
  const glyphs = [];
  for (const box of boxes) {
    const cell = normaliseGlyph(bin, box);
    let bestKey = null;
    let best = -1;
    let second = -1;
    for (const k of keys) {
      const s = matchScore(cell, templates[k]);
      if (s > best) { second = best; best = s; bestKey = k; }
      else if (s > second) second = s;
    }
    glyphs.push({ ch: bestKey, score: best, margin: best - second });
    text += bestKey;
    if (best < minScore) minScore = best;
  }
  return { text, glyphs, minScore };
}

/**
 * Pick out the run of glyphs that is actually the collector number.
 *
 * A band contains more than the number: a regulation mark, a set-code box, a
 * rarity symbol, sometimes an illustrator credit clipped at the top. Those
 * segment into "glyphs" too, and a raw count can match the expected label by
 * coincidence while pointing at the wrong shapes — sv10-133 segments into
 * exactly 7 runs, but with widths 34,58,147,57,30,143,52, and a 147-wide digit
 * beside a 30-wide one is not a digit.
 *
 * Digits in a number share a height and sit on a baseline. So: take the median
 * glyph height, keep only glyphs close to it and close to that baseline, and
 * return the longest contiguous run. Everything else is furniture.
 */
export function selectNumberRun(boxes, opts = {}) {
  if (!boxes.length) return [];
  const hTol = opts.heightTolerance ?? 0.28;
  const wMax = opts.maxWidthRatio ?? 1.6;

  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)];
  const baselines = boxes.map((b) => b.y1).sort((a, b) => a - b);
  const medBase = baselines[Math.floor(baselines.length / 2)];

  const ok = boxes.filter((b) => Math.abs(b.h - medH) <= medH * hTol
    && Math.abs(b.y1 - medBase) <= medH * 0.35
    && b.w <= medH * wMax);

  // Longest contiguous run, where contiguous means "not separated by a gap
  // wider than a character". A wide gap is the space between the number and
  // the rarity symbol.
  let best = [];
  let cur = [];
  for (let i = 0; i < ok.length; i += 1) {
    if (!cur.length) { cur = [ok[i]]; continue; }
    const prev = cur[cur.length - 1];
    const gap = ok[i].x0 - prev.x1;
    if (gap <= medH * 0.9) cur.push(ok[i]);
    else { if (cur.length > best.length) best = cur; cur = [ok[i]]; }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

// ---------------------------------------------------------------------------
// FIND THE NUMBER, THEN READ IT.
//
// bandForSet() above takes a set id and returns a corner — which is circular
// for anything except training, because the set id is what we are trying to
// work out. Reading a card we have never seen cannot start by knowing where its
// era printed the number.
//
// So scan instead. There are only two candidate corners, the number is the
// largest run of same-height glyphs down there, and the card itself says which
// corner it is in. No era knowledge, no layout table.
//
// This also fixes the failure that stopped the previous attempt. Binarising the
// WHOLE bottom strip merged everything into one 2199x339 blob, because the
// strip spans artwork, borders and several text runs at different contrasts. A
// corner is small enough to threshold sensibly, and trying a few thresholds per
// corner costs nothing.

/** The two places a collector number is ever printed. */
export const CORNERS = Object.freeze([
  { name: 'bottom-left', x: 0.02, y: 0.900, w: 0.44, h: 0.075 },
  { name: 'bottom-right', x: 0.54, y: 0.885, w: 0.44, h: 0.080 },
]);

/**
 * Does this glyph run look like a collector number?
 *
 * Scored without templates, because scoring is what tells us WHERE to point the
 * templates. A number is 3-9 characters of even height sitting on one baseline,
 * evenly spaced, none of them much wider than they are tall. Illustrator
 * credits are longer and lower-contrast; a set-code box is one tall rectangle;
 * a rarity symbol is isolated.
 */
export function scoreNumberRun(run, bandHeight) {
  if (!run || run.length < 3 || run.length > 9) return 0;

  // TOLERANCES WIDE ENOUGH TO HOLD A SLASH, and no attempt to classify one.
  //
  // Two earlier versions failed here and both are worth recording.
  //
  // Tight evenness rejected the "/" — in this italic face it is taller than the
  // numerals and descends below the baseline — which SPLIT "133/182" into two
  // separate 3-glyph runs. Every card came back with exactly 3 glyphs.
  //
  // Special-casing a separator as "narrow and tall" was worse: a "1" is narrow
  // and tall too, so "11/105" was read as three separators and rejected
  // outright. 2 of 9 became 0 of 9.
  //
  // So measure the whole run loosely rather than trying to name its parts. The
  // baseline is the reliable signal — digits and a slash all sit on one — and
  // height varies more than expected across a real print run.
  const hs = run.map((b) => b.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)];
  if (medH < bandHeight * 0.18) return 0;
  if (!run.every((b) => b.h >= medH * 0.55 && b.h <= medH * 1.6)) return 0;

  const bases = run.map((b) => b.y1);
  const baseSpread = Math.max(...bases) - Math.min(...bases);
  if (baseSpread > medH * 0.55) return 0;

  const gaps = run.slice(1).map((b, i) => b.x0 - run[i].x1);
  if (gaps.some((g) => g > medH * 0.9)) return 0;

  const aspectOk = run.filter((b) => b.w <= medH * 1.3).length / run.length;
  if (aspectOk < 0.7) return 0;

  // LENGTH MATTERS. Any 3-glyph slice of a 7-glyph number is itself a valid run
  // and scores better on a tighter baseline, so without weighting length the
  // shortest window always wins. The correct run is the longest valid one.
  return run.length * (medH / bandHeight) * aspectOk * (1 - baseSpread / (medH + 1));
}



/**
 * Locate the collector number by scanning both corners at several thresholds.
 *
 * @param {Buffer} buffer  a rectified card
 * @returns {{corner, bin, run, score, threshold, inverted}|null}
 */
export async function findNumberBand(buffer, opts = {}) {
  const scale = opts.scale ?? 4;
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;

  let best = null;
  for (const corner of CORNERS) {
    const rect = {
      left: Math.round(corner.x * meta.width),
      top: Math.round(corner.y * meta.height),
      width: Math.round(corner.w * meta.width),
      height: Math.round(corner.h * meta.height),
    };
    if (rect.width < 10 || rect.height < 8) continue;
    const { data, info } = await sharp(buffer).extract(rect)
      .resize({ width: rect.width * scale, kernel: 'lanczos3' })
      .greyscale().normalise().raw().toBuffer({ resolveWithObject: true });

    for (const threshold of (opts.thresholds ?? [100, 130, 160, 190])) {
      const bin = binarise({ data, width: info.width, height: info.height }, threshold);
      const boxes = segmentGlyphs(bin, { minHeight: Math.round(info.height * 0.15) });
      if (boxes.length < 3) continue;
      // Every contiguous window, so a number sitting beside furniture is still
      // found — the run does not have to be the whole corner.
      for (let i = 0; i < boxes.length; i += 1) {
        for (let n = 3; n <= Math.min(9, boxes.length - i); n += 1) {
          const run = boxes.slice(i, i + n);
          const score = scoreNumberRun(run, info.height);
          if (score > (best?.score ?? 0)) {
            best = { corner: corner.name, bin, run, score, threshold, inverted: bin.inkIsDark };
          }
        }
      }
    }
  }
  return best;
}
