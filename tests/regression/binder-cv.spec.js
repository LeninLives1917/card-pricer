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

// End-to-end "is the projection profile actually finding bands?" test
// is intentionally NOT here — synthetic data tuned to match the
// detector's threshold + smooth-radius is too brittle (a 10px gap with
// SMOOTH_RADIUS=4 false-merges adjacent bands depending on percentile
// landing). Real-image fixture testing belongs in a manual smoke run,
// not in the unit suite. The math helpers above being correct + the
// algorithm being a straightforward composition of them is what we
// rely on; tuning the thresholds is a real-photo problem.
