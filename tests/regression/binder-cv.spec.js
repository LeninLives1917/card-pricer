// Regression: classical-CV binder card detection — pricing/binder-cv.js
//
// The end-to-end detector needs real photos to validate (it's a CV
// pipeline against unpredictable user input). What we lock down here are
// the pure math helpers — projection stddev, smoothing, percentile
// thresholding, run-finding, region stddev — that the detector is
// composed from. If the helpers are right, the detector's behaviour on
// any specific photo is a tuning problem, not a correctness one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectionStddev,
  smooth1d,
  thresholdAtPercentile,
  findRuns,
  regionStddev,
  cellBandsFromGaps,
  medianLength,
  snapBandsToLength,
} from '../../pricing/binder-cv.js';

// Helpers to build synthetic greyscale "images" as flat Uint8Arrays.
function uniformImage(W, H, value) {
  const buf = new Uint8Array(W * H);
  buf.fill(value);
  return buf;
}

function checkerboardImage(W, H, cellW, cellH) {
  // Black/white squares for a deterministic stddev signal.
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.floor(x / cellW);
      const cy = Math.floor(y / cellH);
      buf[y * W + x] = (cx + cy) % 2 === 0 ? 0 : 255;
    }
  }
  return buf;
}

// ── projectionStddev ─────────────────────────────────────────────────────

test('projectionStddev: uniform image has zero stddev on every column and row', () => {
  const W = 20, H = 10;
  const buf = uniformImage(W, H, 128);
  const cols = projectionStddev(buf, W, H, 'col');
  const rows = projectionStddev(buf, W, H, 'row');
  assert.equal(cols.length, W);
  assert.equal(rows.length, H);
  for (let i = 0; i < W; i++) assert.ok(cols[i] < 0.0001, `col ${i}: ${cols[i]}`);
  for (let i = 0; i < H; i++) assert.ok(rows[i] < 0.0001, `row ${i}: ${rows[i]}`);
});

test('projectionStddev: vertical-stripe image gives zero column stddev (each column uniform)', () => {
  // 10x10 image where each column has a single value (= column index * 25, capped).
  const W = 10, H = 10;
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      buf[y * W + x] = Math.min(255, x * 25);
    }
  }
  const cols = projectionStddev(buf, W, H, 'col');
  for (let i = 0; i < W; i++) assert.ok(cols[i] < 0.0001, `col ${i}: ${cols[i]}`);

  // Rows have all the variation (each row is 0,25,50,...,225).
  const rows = projectionStddev(buf, W, H, 'row');
  for (let i = 0; i < H; i++) assert.ok(rows[i] > 50, `row ${i}: ${rows[i]}`);
});

test('projectionStddev: checkerboard has high stddev on every column and row', () => {
  const W = 8, H = 8;
  const buf = checkerboardImage(W, H, 2, 2);
  const cols = projectionStddev(buf, W, H, 'col');
  const rows = projectionStddev(buf, W, H, 'row');
  // Half black, half white → stddev = 127.5 (population sd of 0/255 mix).
  for (let i = 0; i < W; i++) assert.ok(cols[i] > 100, `col ${i}: ${cols[i]}`);
  for (let i = 0; i < H; i++) assert.ok(rows[i] > 100, `row ${i}: ${rows[i]}`);
});

// ── smooth1d ─────────────────────────────────────────────────────────────

test('smooth1d: identity-ish for radius 0', () => {
  const input = new Float32Array([1, 2, 3, 4, 5]);
  const out = smooth1d(input, 0);
  assert.equal(out.length, 5);
  for (let i = 0; i < 5; i++) assert.equal(out[i], input[i]);
});

test('smooth1d: averages over the window', () => {
  // Radius 1 over [0,0,9,0,0] gives windows of 3 (with edge clipping):
  //   i=0: [0,0]      → 0
  //   i=1: [0,0,9]    → 3
  //   i=2: [0,9,0]    → 3
  //   i=3: [9,0,0]    → 3
  //   i=4: [0,0]      → 0
  const out = smooth1d(new Float32Array([0, 0, 9, 0, 0]), 1);
  assert.deepEqual(Array.from(out), [0, 3, 3, 3, 0]);
});

test('smooth1d: returns same length as input', () => {
  for (const len of [1, 3, 7, 100]) {
    const input = new Float32Array(len);
    assert.equal(smooth1d(input, 4).length, len);
  }
});

// ── thresholdAtPercentile ────────────────────────────────────────────────

test('thresholdAtPercentile: 50th percentile splits the array roughly in half', () => {
  const profile = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const mask = thresholdAtPercentile(profile, 0.5);
  let ones = 0;
  for (const v of mask) ones += v;
  // Threshold = sorted[5] = 6, so values > 6 = {7,8,9,10} → 4 ones.
  assert.equal(ones, 4);
});

test('thresholdAtPercentile: returns Uint8Array of correct length', () => {
  const profile = new Float32Array([5, 1, 9, 3, 7]);
  const mask = thresholdAtPercentile(profile, 0.4);
  assert.ok(mask instanceof Uint8Array);
  assert.equal(mask.length, 5);
  // Threshold ≈ sorted[2] = 5; values strictly > 5 are {7,9} → 2 ones at indices 2 and 4.
  assert.equal(mask[0], 0);
  assert.equal(mask[1], 0);
  assert.equal(mask[2], 1);
  assert.equal(mask[3], 0);
  assert.equal(mask[4], 1);
});

test('thresholdAtPercentile: 0 percentile keeps all values that exceed the minimum', () => {
  const profile = new Float32Array([0, 1, 2, 3, 4]);
  const mask = thresholdAtPercentile(profile, 0);
  // Threshold = sorted[0] = 0; mask is values strictly > 0 → 4 ones.
  let ones = 0;
  for (const v of mask) ones += v;
  assert.equal(ones, 4);
});

// ── findRuns ─────────────────────────────────────────────────────────────

test('findRuns: empty mask returns empty array', () => {
  assert.deepEqual(findRuns(new Uint8Array(10)), []);
});

test('findRuns: single run', () => {
  const mask = new Uint8Array([0, 0, 1, 1, 1, 0, 0]);
  assert.deepEqual(findRuns(mask), [{ start: 2, length: 3 }]);
});

test('findRuns: multiple disjoint runs', () => {
  const mask = new Uint8Array([1, 1, 0, 1, 0, 0, 1, 1, 1]);
  assert.deepEqual(findRuns(mask), [
    { start: 0, length: 2 },
    { start: 3, length: 1 },
    { start: 6, length: 3 },
  ]);
});

test('findRuns: trailing run is captured', () => {
  const mask = new Uint8Array([0, 1, 1, 1]);
  assert.deepEqual(findRuns(mask), [{ start: 1, length: 3 }]);
});

test('findRuns: leading run is captured', () => {
  const mask = new Uint8Array([1, 1, 0, 0]);
  assert.deepEqual(findRuns(mask), [{ start: 0, length: 2 }]);
});

test('findRuns: all-ones mask is a single full-length run', () => {
  const mask = new Uint8Array([1, 1, 1, 1, 1]);
  assert.deepEqual(findRuns(mask), [{ start: 0, length: 5 }]);
});

// ── regionStddev ─────────────────────────────────────────────────────────

test('regionStddev: uniform region returns 0', () => {
  const buf = uniformImage(20, 20, 128);
  assert.equal(regionStddev(buf, 20, 20, 0, 0, 20, 20), 0);
});

test('regionStddev: high-variance region returns high stddev', () => {
  const buf = checkerboardImage(20, 20, 2, 2);
  const std = regionStddev(buf, 20, 20, 0, 0, 20, 20);
  // Half pixels at 0, half at 255 → population stddev = 127.5.
  assert.ok(std > 100, `expected high stddev, got ${std}`);
});

test('regionStddev: ignores cell border (samples interior 60%)', () => {
  // Build a 20x20 buffer where the OUTER ring is noisy and the INNER
  // 12x12 region is uniform. regionStddev samples the inner 60% so it
  // should report ~0 even though the cell as a whole has high stddev.
  const W = 20, H = 20;
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const isBorder = x < 4 || x >= 16 || y < 4 || y >= 16;
      buf[y * W + x] = isBorder ? ((x + y) % 2 ? 0 : 255) : 128;
    }
  }
  // Pass the WHOLE 20x20 cell; regionStddev's pad=20% means it samples
  // x ∈ [4, 16) and y ∈ [4, 16) — which is the uniform interior.
  const std = regionStddev(buf, W, H, 0, 0, 20, 20);
  assert.ok(std < 1, `expected near-zero (interior is uniform), got ${std}`);
});

// ── cellBandsFromGaps ────────────────────────────────────────────────────
//
// The correctness move that fixed the "super zoomed in" bug: instead of
// finding "card-like columns" and risking that a card's lower-variance
// border gets thresholded out (yielding a band that's just the card's
// noisy centre), we find GAPS and take the regions between them — full
// edge-to-edge cell extents.

// gapCutoffFrac is interpreted as: cutoff = mean(profile) * gapCutoffFrac.
// 0.6 is the production default and works for the bimodal stddev profiles
// we get from real binder photos.

test('cellBandsFromGaps: 3-card profile with two clear gaps yields 3 cells', () => {
  // Simulate a profile across 100 columns with three "card" zones (high
  // values) separated by two "gap" zones (low values).
  //   [0..30]   = card 0 (value 100)
  //   [30..38]  = gap   (value 5)
  //   [38..68]  = card 1 (value 100)
  //   [68..76]  = gap   (value 5)
  //   [76..100] = card 2 (value 100)
  const profile = new Float32Array(100);
  for (let i = 0; i < 100; i++) {
    if ((i >= 30 && i < 38) || (i >= 68 && i < 76)) profile[i] = 5;
    else profile[i] = 100;
  }
  // mean ≈ 84.8; cutoff = 84.8 * 0.6 ≈ 50.9. Values 5 < 50.9 → gap.
  const cells = cellBandsFromGaps(profile, 100, 0.6, 0.05, 0.10);
  assert.equal(cells.length, 3, `expected 3 cells, got ${cells.length}: ${JSON.stringify(cells)}`);
  // First card spans [0..30].
  assert.equal(cells[0].start, 0);
  assert.equal(cells[0].length, 30);
  // Second card spans [38..68].
  assert.equal(cells[1].start, 38);
  assert.equal(cells[1].length, 30);
  // Third card spans [76..100].
  assert.equal(cells[2].start, 76);
  assert.equal(cells[2].length, 24);
});

test('cellBandsFromGaps: tiny "gap" inside a card (low-variance art region) is NOT split', () => {
  // 100-column profile with a single card-zone but a 2-column dip in
  // the middle (e.g. a white area on the card art). With minGapFrac=0.05
  // (5 columns), the 2-column dip is too small to count — the cell
  // stays unified.
  const profile = new Float32Array(100);
  profile.fill(100);
  profile[48] = 5;
  profile[49] = 5;
  const cells = cellBandsFromGaps(profile, 100, 0.6, 0.05, 0.10);
  assert.equal(cells.length, 1, 'sub-threshold gap should NOT split the cell');
  assert.equal(cells[0].start, 0);
  assert.equal(cells[0].length, 100);
});

test('cellBandsFromGaps: cards touching the image edges still form bands', () => {
  // [0..40] card | [40..50] gap | [50..100] card.
  const profile = new Float32Array(100);
  for (let i = 0; i < 100; i++) {
    profile[i] = (i >= 40 && i < 50) ? 5 : 100;
  }
  const cells = cellBandsFromGaps(profile, 100, 0.6, 0.05, 0.10);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].start, 0);
  assert.equal(cells[0].length, 40);
  assert.equal(cells[1].start, 50);
  assert.equal(cells[1].length, 50);
});

test('cellBandsFromGaps: gap-fraction independent (works at 30%, 70%, etc.)', () => {
  // Same algorithm should handle a "sparse layout" page where most of
  // the axis is gap (e.g. 1 card on a mostly-empty page). 70% gap, 30% card.
  const profile = new Float32Array(100);
  for (let i = 0; i < 100; i++) profile[i] = 5;        // gap
  for (let i = 35; i < 65; i++) profile[i] = 100;       // 30-col card
  const cells = cellBandsFromGaps(profile, 100, 0.6, 0.05, 0.10);
  // Should find the single card. mean ≈ 33.5; cutoff ≈ 20.1. Value 5 < 20.1.
  assert.equal(cells.length, 1);
  assert.equal(cells[0].start, 35);
  assert.equal(cells[0].length, 30);
});

test('cellBandsFromGaps: filters out cells smaller than minBandFrac', () => {
  // Profile with a tiny "card" sliver between two big gaps:
  // [0..30] gap | [30..32] card (only 2px wide) | [32..70] gap | [70..100] card
  const profile = new Float32Array(100);
  for (let i = 0; i < 100; i++) {
    if ((i >= 30 && i < 32) || (i >= 70 && i < 100)) profile[i] = 100;
    else profile[i] = 5;
  }
  // minBandFrac=0.10 → cells must be ≥10 columns. The 2-column "card"
  // is dropped; only the 30-column one survives.
  const cells = cellBandsFromGaps(profile, 100, 0.6, 0.05, 0.10);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].start, 70);
  assert.equal(cells[0].length, 30);
});

test('cellBandsFromGaps: no gaps at all → entire profile is one band', () => {
  // All-uniform profile → no values below cutoff, no gaps found.
  // Result: one cell spanning the full length. The detector's "≥2
  // bands per axis" guard then bails to Claude.
  const profile = new Float32Array(100);
  profile.fill(100);
  const cells = cellBandsFromGaps(profile, 100, 0.6, 0.05, 0.10);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].length, 100);
});

// ── medianLength ────────────────────────────────────────────────────────

test('medianLength: odd count returns middle element', () => {
  const bands = [
    { start: 0, length: 100 },
    { start: 200, length: 105 },
    { start: 400, length: 95 },
  ];
  assert.equal(medianLength(bands), 100);
});

test('medianLength: even count averages the two middle elements', () => {
  const bands = [
    { start: 0, length: 80 },
    { start: 100, length: 100 },
    { start: 200, length: 110 },
    { start: 300, length: 130 },
  ];
  assert.equal(medianLength(bands), 105); // avg of 100 and 110
});

test('medianLength: empty / single returns sensible default', () => {
  assert.equal(medianLength([]), 0);
  assert.equal(medianLength([{ start: 0, length: 50 }]), 50);
});

test('medianLength: outliers do not pull the median (unlike mean)', () => {
  // Three sane cells at length 100, one outlier at length 500.
  // Mean = (100+100+100+500)/4 = 200; median = 100. Median is right.
  const bands = [
    { start: 0, length: 100 },
    { start: 200, length: 100 },
    { start: 400, length: 100 },
    { start: 600, length: 500 },
  ];
  assert.equal(medianLength(bands), 100);
});

// ── snapBandsToLength ───────────────────────────────────────────────────

test('snapBandsToLength: snaps each band to target length, centred on detected centre', () => {
  const bands = [
    { start: 10, length: 100 },  // centre = 60
    { start: 200, length: 95 },  // centre = 247.5
    { start: 400, length: 105 }, // centre = 452.5
  ];
  const out = snapBandsToLength(bands, 100, 1000);
  // Every band now has length 100 and is centred on its detected centre.
  for (const b of out) assert.equal(b.length, 100);
  assert.equal(out[0].start, 10);  // 60 - 50
  assert.equal(out[1].start, 198); // round(247.5 - 50) = 198
  assert.equal(out[2].start, 403); // round(452.5 - 50) = 403
});

test('snapBandsToLength: clamps left edge — band touching x=0 cannot start at -5', () => {
  // Band centred at x=20 with target length 100 would start at -30.
  const bands = [{ start: 0, length: 40 }]; // centre = 20
  const out = snapBandsToLength(bands, 100, 1000);
  assert.equal(out[0].start, 0);
  assert.ok(out[0].length <= 100, `length should not exceed target: ${out[0].length}`);
  assert.ok(out[0].start + out[0].length <= 1000, 'shouldn\'t overflow right edge');
});

test('snapBandsToLength: clamps right edge — band touching totalLength cannot extend past it', () => {
  // Band at the right edge of a 1000-wide axis.
  const bands = [{ start: 950, length: 40 }]; // centre = 970
  const out = snapBandsToLength(bands, 100, 1000);
  // Centre 970 with length 100 → start at 920, end at 1020. Clamp to 1000.
  assert.ok(out[0].start + out[0].length <= 1000);
});

test('snapBandsToLength: target length 0 returns bands unchanged', () => {
  const bands = [{ start: 10, length: 50 }];
  const out = snapBandsToLength(bands, 0, 1000);
  assert.equal(out[0].start, 10);
  assert.equal(out[0].length, 50);
});

test('snapBandsToLength: pulls undersized bands up to target (the "top frame cropped" fix)', () => {
  // 3 bands detected. Two are correct length 200, one is a top-frame-cut
  // version at length 170 (missed the top 30px). After snapping all to
  // median length, the undersized one is back at 200 and centred on
  // its detected centre — recovering the missing top pixels.
  const bands = [
    { start: 50, length: 200 },   // ok, centre = 150
    { start: 300, length: 170 },  // top cut, detected centre = 385 (would be 400 if full)
    { start: 550, length: 200 },  // ok, centre = 650
  ];
  const median = medianLength(bands); // = 200
  const out = snapBandsToLength(bands, median, 1000);
  assert.equal(out[1].length, 200);
  // Centred on 385: start should be 285 (was 300). It moved UP — recovered ~15px of top.
  assert.equal(out[1].start, 285);
});

// End-to-end "is the projection profile actually finding bands?" test
// is intentionally NOT here — synthetic data tuned to match the
// detector's threshold + smooth-radius is too brittle (a 10px gap with
// SMOOTH_RADIUS=4 false-merges adjacent bands depending on percentile
// landing). Real-image fixture testing belongs in a manual smoke run,
// not in the unit suite. The math helpers above being correct + the
// algorithm being a straightforward composition of them is what we
// rely on; tuning the thresholds is a real-photo problem.
