// apps/vendor/modules/frame-gate.js
//
// Should this frame become an API call?
//
// MEASURED (docs/V3_BENCHMARK.md §19). Across 51 real photographs, sharpness
// is the single largest predictor of whether the pipeline gets the card right:
//
//     median Laplacian variance, correct reads   585
//     median Laplacian variance, failures        241
//     failures in the blurriest third of photos  69%
//     accuracy in the sharpest third             88%   (vs 68.6% overall)
//
// A soft frame is not a hard card to identify — it is a frame that should
// never have been sent. Rejecting it at capture costs the operator half a
// second of "hold still"; sending it costs 1.6 cents, a round trip, and
// sometimes a wrong price on a card worth EUR 50.
//
// Everything here is a pure function over pixels so `node --test` can exercise
// it without a browser or a camera. No model, no network, ~2-4 ms a frame.
//
// THRESHOLDS ARE PROVISIONAL. They come from 51 photographs taken in one
// 115-second burst by one person, downscaled to 512px. They are a starting
// point with a counter attached, not constants anyone should trust yet — see
// `counts` below and re-fit against the stratified set.

/** Analysis is done at this width; the measured thresholds assume it. */
export const ANALYSIS_SIZE = 512;

/**
 * Laplacian variance at 512px. 250 lifted accuracy from 68.6% to 85% on the
 * measured set while rejecting 22% of frames for a retake. Above ~300 the
 * curve flattens and then declines, so this sits at the knee rather than at
 * the best single number — picking the peak of a 51-photo curve is fitting.
 */
export const SHARPNESS_MIN = 250;

/** Fraction of the frame the card should occupy before the number is legible. */
export const FILL_MIN = 0.25;

/** Edge energy in the outer band beyond this means the card runs off-frame. */
export const CLIP_EDGE_MAX = 0.18;

/** Outer band inspected for clipping, as a fraction of each dimension. */
export const EDGE_BAND = 0.04;

/** Consecutive good frames before the reticle locks green. Stops it flickering. */
export const STABLE_FRAMES = 3;

// Every rejection increments a counter something reads. A gate that silently
// throws away most frames looks identical to a camera that is not working.
const counts = { analysed: 0, green: 0, blurry: 0, clipped: 0, too_small: 0, no_card: 0 };
export function getGateCounts() { return { ...counts }; }
export function resetGateCounts() { for (const k of Object.keys(counts)) counts[k] = 0; }

/**
 * Grayscale Laplacian variance — the standard sharpness proxy. Low variance
 * means few sharp edges, which means blur (or an empty frame).
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img RGBA
 */
export function sharpness(img) {
  const { data, width: w, height: h } = img;
  if (w < 3 || h < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      // Luma of the 4-neighbourhood, without allocating a grayscale buffer.
      const c = lum(data, i);
      const v = -4 * c
        + lum(data, i - 4) + lum(data, i + 4)
        + lum(data, i - w * 4) + lum(data, i + w * 4);
      sum += v; sumSq += v * v; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function lum(d, i) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/**
 * Where is the card? Approximated by the bounding box of gradient energy —
 * a card on a table is the only thing in frame with strong edges, so this
 * tracks the card outline closely enough to guide framing. Deliberately NOT
 * quad detection: this runs on every frame and must stay cheap.
 *
 * Returns fill (fraction of frame covered), whether energy touches the outer
 * band (clipped), and how far the centre sits from the frame centre.
 */
export function locateCard(img, { edgeBand = EDGE_BAND } = {}) {
  const { data, width: w, height: h } = img;
  if (w < 8 || h < 8) return { found: false, fill: 0, clipped: false, offCentre: 1 };

  // Gradient magnitude per pixel, thresholded against the frame's own mean so
  // this works in bright and dim light without a fixed exposure assumption.
  const grad = new Float32Array(w * h);
  let gSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const gx = lum(data, i + 4) - lum(data, i - 4);
      const gy = lum(data, i + w * 4) - lum(data, i - w * 4);
      const g = Math.abs(gx) + Math.abs(gy);
      grad[y * w + x] = g;
      gSum += g;
    }
  }
  // Absolute floor as well as a relative one. Without it a flat frame (lens
  // capped, pointed at a blank table) has mean gradient 0, so every pixel
  // clears the threshold and the gate confidently reports a full-frame card.
  const thresh = Math.max(6, (gSum / (w * h)) * 2.2);

  let minX = w, maxX = -1, minY = h, maxY = -1, strong = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grad[y * w + x] < thresh) continue;
      strong++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || strong < (w * h) * 0.002) {
    return { found: false, fill: 0, clipped: false, offCentre: 1 };
  }

  const bw = maxX - minX, bh = maxY - minY;
  const fill = (bw * bh) / (w * h);

  const bandX = Math.max(1, Math.floor(w * edgeBand));
  const bandY = Math.max(1, Math.floor(h * edgeBand));
  const clipped = minX <= bandX || minY <= bandY || maxX >= w - bandX || maxY >= h - bandY;

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const offCentre = Math.hypot((cx - w / 2) / w, (cy - h / 2) / h) * 2;

  return { found: true, fill, clipped, offCentre, bbox: { minX, minY, maxX, maxY } };
}

/**
 * The whole verdict for one frame.
 *
 * Order matters: report the problem the operator should fix FIRST, not every
 * problem at once. One word beats a diagnostic panel when someone is holding a
 * card over a table.
 *
 * @returns {{ state: 'green'|'amber'|'red', hint: string, sharpness: number,
 *             fill: number, clipped: boolean }}
 */
export function gateFrame(img, opts = {}) {
  const sharpMin = opts.sharpnessMin ?? SHARPNESS_MIN;
  const fillMin = opts.fillMin ?? FILL_MIN;

  counts.analysed++;
  const sharp = sharpness(img);
  const loc = locateCard(img, opts);

  const base = { sharpness: sharp, fill: loc.fill, clipped: loc.clipped };

  if (!loc.found) {
    counts.no_card++;
    return { ...base, state: 'red', hint: 'Point at a card' };
  }
  // Clipping first: a card running off-frame loses the collector number, and
  // the earlier V3 work found frame-clipping behind ALL of its detection
  // failures. No amount of sharpness rescues a number that is not in shot.
  if (loc.clipped) {
    counts.clipped++;
    return { ...base, state: 'red', hint: 'Move back — card is cut off' };
  }
  if (loc.fill < fillMin) {
    counts.too_small++;
    return { ...base, state: 'amber', hint: 'Closer' };
  }
  // Sharpness last, because it is the one the operator fixes by simply
  // pausing — and it is meaningless to report while the framing is wrong.
  if (sharp < sharpMin) {
    counts.blurry++;
    return { ...base, state: 'amber', hint: 'Hold still' };
  }

  counts.green++;
  return { ...base, state: 'green', hint: 'Ready' };
}

/**
 * Debounce the verdict so the reticle does not strobe between states on
 * consecutive frames. Green requires STABLE_FRAMES consecutive greens; any
 * non-green resets immediately, because being slow to go green is safe and
 * being slow to go red is not.
 */
export function createStabiliser({ stableFrames = STABLE_FRAMES } = {}) {
  let run = 0;
  return function push(verdict) {
    if (verdict.state === 'green') {
      run++;
      return { ...verdict, locked: run >= stableFrames, run };
    }
    run = 0;
    return { ...verdict, locked: false, run: 0 };
  };
}
