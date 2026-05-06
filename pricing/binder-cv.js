// pricing/binder-cv.js
//
// Classical computer-vision card detection for binder pages — replaces
// the Sonnet bbox-detection step with deterministic image processing.
//
// Why this exists: the LLM-based detector (pricing/binder.js) was
// producing off-centre boxes that pulled neighbouring pockets into the
// crops, even with temperature: 0 and a tighter prompt. CV grid
// detection is pixel-precise by construction.
//
// Algorithm — projection profile + run length:
//
//   1. Resize the photo to ~800px wide (speed), greyscale it.
//   2. For each column X, compute the std-deviation of pixel values
//      across Y. Cards are visually rich (high stddev — varied art,
//      text, holos); the gaps between pockets are smooth plastic or
//      paper backing (low stddev).
//   3. Smooth the profile with a small box filter to suppress noise.
//   4. Threshold at the 35th percentile — values above are "card
//      column", below are "gap column".
//   5. Find contiguous runs of "card column" → vertical bands.
//   6. Repeat steps 2–5 across rows → horizontal bands.
//   7. Grid cells = vertical_bands × horizontal_bands.
//   8. For each cell:
//        - Reject if aspect ratio is outside [0.55, 0.95] (cards are ~5:7).
//        - Reject if the cell's interior stddev is below MIN_CONTENT_STD
//          (empty pocket, no card present).
//   9. Return the survivors as normalised bboxes in [0..1] coords.
//
// Limits we accept (Claude fallback in identify.js handles them):
//   - Heavily rotated / perspective-distorted photos (the projection
//     profile blurs through tilted grid lines).
//   - Pages with cards crammed edge-to-edge with no inter-pocket gap.
//   - Single-card / non-grid scans (returns zero bboxes — caller falls
//     back to Claude).
//
// All math helpers are pure exports so tests can synthesise greyscale
// arrays without spinning up sharp.

import sharp from 'sharp';

// ── Tunable thresholds — change carefully, read the comments first ─────────

// Long-edge resize: 800px gives accurate grid detection on a 3x3 page
// (each card is ~250px in the resized image — plenty of pixels for stddev
// calculation) while keeping per-page processing under 200ms.
export const PROC_WIDTH = 800;

// 1D box-filter radius for smoothing the projection profile. Suppresses
// per-pixel noise from texture without obscuring genuine gaps. At
// PROC_WIDTH=800 a radius of 4 averages over 9 pixels (~1% of the image).
export const SMOOTH_RADIUS = 4;

// Percentile of profile values to use as the "is this a card?" threshold.
// 0.35 means columns/rows in the bottom 35% of stddev are gaps. Lower =
// more permissive (catches faint cards but lets noise through); higher =
// stricter. Tuned for typical binder photography (page background lighter
// than cards).
export const COL_THRESHOLD_PCT = 0.35;
export const ROW_THRESHOLD_PCT = 0.35;

// Minimum band size as fraction of image. Bands smaller than this are
// noise — there's no card 1% of the page wide. 8% allows up to ~12 bands
// per axis (which would be a 12-pocket page — already at the binder spec).
export const MIN_BAND_FRAC = 0.08;

// Card aspect ratio = ~5:7 → w/h ≈ 0.71. Allow ±~25% to account for
// slightly cropped or angled cards. Outside this range = not a card.
export const ASPECT_MIN = 0.55;
export const ASPECT_MAX = 0.95;

// Minimum interior stddev to count a cell as containing a card. Empty
// binder pockets show through to the page or backing, with stddev close
// to 0–10. Cards (even monochrome ones) have stddev ≥ ~20. 15 is the
// safe threshold.
export const MIN_CONTENT_STD = 15;

/**
 * Detect cards on a binder-page photo using projection-profile grid
 * detection. Same return shape as pricing/binder.js#detectBinderCards
 * so the caller can swap the two transparently.
 *
 * @param {object} args
 * @param {Buffer} args.buffer  Raw image bytes (JPEG/PNG/WebP).
 * @returns {Promise<{cards: Array<{x:number,y:number,w:number,h:number}>, reason: string, ms: number}>}
 *   reason is a short string identifying why we returned what we did
 *   (cv-success / no-grid-detected / no-valid-cells / no-dimensions).
 *   ms is the time the detector took, for logging.
 */
export async function detectBinderCardsCV({ buffer } = {}) {
  const t0 = Date.now();
  if (!buffer) return { cards: [], reason: 'no-buffer', ms: 0 };

  let meta;
  try { meta = await sharp(buffer).metadata(); }
  catch (err) {
    console.error('[BINDER-CV] metadata failed:', err.message);
    return { cards: [], reason: 'no-dimensions', ms: Date.now() - t0 };
  }
  const ow = meta.width || 0;
  const oh = meta.height || 0;
  if (!ow || !oh) return { cards: [], reason: 'no-dimensions', ms: Date.now() - t0 };

  // Resize + greyscale + raw bytes.
  let raw;
  try {
    raw = await sharp(buffer)
      .resize(PROC_WIDTH)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    console.error('[BINDER-CV] resize/greyscale failed:', err.message);
    return { cards: [], reason: 'sharp-failed', ms: Date.now() - t0 };
  }

  const W = raw.info.width;
  const H = raw.info.height;
  const pixels = raw.data;

  const colStd = projectionStddev(pixels, W, H, 'col');
  const colSmooth = smooth1d(colStd, SMOOTH_RADIUS);
  const colMask = thresholdAtPercentile(colSmooth, COL_THRESHOLD_PCT);
  const colBands = findRuns(colMask).filter((b) => b.length >= W * MIN_BAND_FRAC);

  const rowStd = projectionStddev(pixels, W, H, 'row');
  const rowSmooth = smooth1d(rowStd, SMOOTH_RADIUS);
  const rowMask = thresholdAtPercentile(rowSmooth, ROW_THRESHOLD_PCT);
  const rowBands = findRuns(rowMask).filter((b) => b.length >= H * MIN_BAND_FRAC);

  if (colBands.length === 0 || rowBands.length === 0) {
    return { cards: [], reason: 'no-grid-detected', ms: Date.now() - t0 };
  }

  const cards = [];
  for (const row of rowBands) {
    for (const col of colBands) {
      const aspect = col.length / row.length;
      if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) continue;

      const contentStd = regionStddev(pixels, W, H, col.start, row.start, col.length, row.length);
      if (contentStd < MIN_CONTENT_STD) continue;

      cards.push({
        x: col.start / W,
        y: row.start / H,
        w: col.length / W,
        h: row.length / H,
        // CV detector never produces hints — that's an OCR job. Keep the
        // field absent so identifyCore doesn't see an empty string.
      });
    }
  }

  // Same row-then-column ordering as pricing/binder.js parser.
  cards.sort((a, b) => {
    if (Math.abs(a.y - b.y) < 0.05) return a.x - b.x;
    return a.y - b.y;
  });

  return {
    cards,
    reason: cards.length ? 'cv-success' : 'no-valid-cells',
    ms: Date.now() - t0,
  };
}

// ── Pure helpers — exported for testing ────────────────────────────────────

/**
 * Per-axis stddev profile of a greyscale image.
 *
 * For axis='col' returns Float32Array(W) where profile[x] is the
 * stddev of pixel values at column x across all rows.
 *
 * For axis='row' returns Float32Array(H) where profile[y] is the
 * stddev of pixel values at row y across all columns.
 *
 * Cards have high values (varied content); gaps have low values
 * (smooth uniform background).
 */
export function projectionStddev(pixels, W, H, axis) {
  if (axis === 'col') {
    const out = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let sum = 0, sumSq = 0;
      for (let y = 0; y < H; y++) {
        const v = pixels[y * W + x];
        sum += v;
        sumSq += v * v;
      }
      const mean = sum / H;
      const variance = sumSq / H - mean * mean;
      out[x] = Math.sqrt(Math.max(0, variance));
    }
    return out;
  }
  // axis === 'row'
  const out = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let sum = 0, sumSq = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) {
      const v = pixels[base + x];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / W;
    const variance = sumSq / W - mean * mean;
    out[y] = Math.sqrt(Math.max(0, variance));
  }
  return out;
}

/**
 * Box-filter smooth a 1D profile with the given radius. Returns a new
 * array of the same length; samples within `radius` of either edge use
 * a smaller window (so endpoints aren't pinned to zero).
 */
export function smooth1d(profile, radius) {
  const n = profile.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    for (let j = lo; j <= hi; j++) {
      sum += profile[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Threshold a profile at the given percentile. Returns Uint8Array(n)
 * with 1 where profile[i] > threshold and 0 otherwise.
 *
 * Percentile thresholding is robust to lighting variance — bright vs
 * dim photos shift absolute values but the relative ranking of "card
 * columns" vs "gap columns" is preserved.
 */
export function thresholdAtPercentile(profile, pct) {
  const sorted = Array.from(profile).sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * pct)));
  const threshold = sorted[idx];
  const mask = new Uint8Array(profile.length);
  for (let i = 0; i < profile.length; i++) {
    mask[i] = profile[i] > threshold ? 1 : 0;
  }
  return mask;
}

/**
 * Find contiguous runs of 1s in a binary mask. Returns array of
 * { start, length } in increasing-position order.
 */
export function findRuns(mask) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      runs.push({ start, length: i - start });
      start = -1;
    }
  }
  if (start !== -1) {
    runs.push({ start, length: mask.length - start });
  }
  return runs;
}

/**
 * Stddev of pixel values inside a sub-rectangle of a greyscale buffer.
 * Used to filter empty pockets — card content has stddev ≥ ~20, empty
 * pockets ≤ ~10.
 *
 * Samples the interior 60% of the cell to avoid the cell's own border
 * (which can be the binder pocket plastic and skew the stddev high
 * even on empty cells).
 */
export function regionStddev(pixels, W, H, x0, y0, w, h) {
  const padX = Math.floor(w * 0.2);
  const padY = Math.floor(h * 0.2);
  const x1 = Math.max(0, x0 + padX);
  const y1 = Math.max(0, y0 + padY);
  const x2 = Math.min(W, x0 + w - padX);
  const y2 = Math.min(H, y0 + h - padY);
  let sum = 0, sumSq = 0, count = 0;
  for (let y = y1; y < y2; y++) {
    const base = y * W;
    for (let x = x1; x < x2; x++) {
      const v = pixels[base + x];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return Math.sqrt(Math.max(0, variance));
}

export default { detectBinderCardsCV };
