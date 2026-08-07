// tests/regression/frame-gate.spec.js
//
// INCIDENT / MOTIVATION (docs/V3_BENCHMARK.md §19). Sharpness turned out to be
// the largest single predictor of whether the pipeline identifies a card:
// median Laplacian variance 585 on correct reads against 241 on failures, with
// 69% of all failures sitting in the blurriest third of the photo set and 88%
// accuracy in the sharpest third against 68.6% overall.
//
// The gate exists so a soft or clipped frame never becomes an API call. These
// pin the ordering of its feedback and its refusal to answer, both of which
// are easy to "tidy" into something worse.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sharpness, locateCard, gateFrame, createStabiliser,
  getGateCounts, resetGateCounts, SHARPNESS_MIN,
} from '../../apps/vendor/modules/frame-gate.js';

// --- synthetic frames -------------------------------------------------

function frame(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  paint({
    set(x, y, v) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    },
  });
  return { data, width: w, height: h };
}

/** A hard-edged rectangle: lots of gradient, i.e. a sharp "card". */
const sharpCard = (w, h, m) => frame(w, h, ({ set }) => {
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    // Interior texture so the Laplacian sees edges inside the card too.
    set(x, y, (x + y) % 8 < 4 ? 20 : 230);
  }
});

/**
 * The same card, defocused. The EDGE has to be soft too — a hard outline
 * around a smooth interior still scores 661 on Laplacian variance, because a
 * crisp border is exactly what the metric measures. Real blur ramps the
 * transition over several pixels, which is what this does.
 */
const blurryCard = (w, h, m, ramp = 10) => frame(w, h, ({ set }) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.min(x - m, y - m, (w - m) - x, (h - m) - y);
    if (d <= -ramp) continue;                       // background
    const t = Math.min(1, Math.max(0, (d + ramp) / (2 * ramp)));
    set(x, y, Math.round(255 - t * 127));           // 255 -> 128 over 2*ramp px
  }
});

/**
 * A card running off two edges, with background still visible on the others.
 * A frame with NO background is not a clipped card, it is a texture — the
 * relative threshold has nothing to separate the card from.
 */
const clippedCard = (w, h, blur = false) => frame(w, h, ({ set }) => {
  for (let y = 0; y < h - 10; y++) for (let x = 0; x < w - 10; x++) {
    set(x, y, blur ? 128 + 8 * Math.sin((x + y) / 20) : ((x + y) % 8 < 4 ? 20 : 230));
  }
});

// --- sharpness --------------------------------------------------------

test('sharpness separates a crisp frame from a smooth one', () => {
  const crisp = sharpness(sharpCard(96, 96, 12));
  const soft = sharpness(blurryCard(96, 96, 12));
  assert.ok(crisp > soft * 10,
    `crisp (${crisp.toFixed(0)}) should dwarf soft (${soft.toFixed(0)}) — this is ` +
    'the signal that predicted 69% of pipeline failures');
});

test('an empty frame is not sharp', () => {
  assert.ok(sharpness(frame(64, 64, () => {})) < 1);
});

test('sharpness tolerates degenerate input rather than throwing', () => {
  // A gate that crashes on a 1px frame takes the whole scanner down.
  assert.equal(sharpness({ data: new Uint8ClampedArray(4), width: 1, height: 1 }), 0);
  assert.equal(sharpness({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), 0);
});

// --- framing ----------------------------------------------------------

test('a card touching the frame edge is reported as clipped', () => {
  // Clipping was behind ALL 8 detection failures in the earlier V3 work: a
  // collector number outside the shot cannot be recovered by any model.
  const loc = locateCard(clippedCard(96, 96));
  assert.equal(loc.found, true);
  assert.equal(loc.clipped, true);
});

test('a card with margin around it is not clipped', () => {
  const loc = locateCard(sharpCard(96, 96, 20));
  assert.equal(loc.found, true);
  assert.equal(loc.clipped, false);
});

test('fill reflects how much of the frame the card occupies', () => {
  const big = locateCard(sharpCard(96, 96, 12));
  const small = locateCard(sharpCard(96, 96, 36));
  assert.ok(big.fill > small.fill,
    'a card further away must report a smaller fill, or "Closer" never fires');
});

test('an empty frame reports no card rather than inventing one', () => {
  const loc = locateCard(frame(64, 64, () => {}));
  assert.equal(loc.found, false);
  assert.equal(loc.fill, 0);
});

// --- the verdict ------------------------------------------------------

test('a sharp, well-framed card goes GREEN', () => {
  const v = gateFrame(sharpCard(128, 128, 24), { fillMin: 0.05, sharpnessMin: 10 });
  assert.equal(v.state, 'green');
  assert.equal(v.hint, 'Ready');
});

test('a blurred card is AMBER with "Hold still", never green', () => {
  const v = gateFrame(blurryCard(128, 128, 24), { fillMin: 0.05 });
  assert.notEqual(v.state, 'green');
  assert.equal(v.hint, 'Hold still');
});

test('clipping is reported BEFORE blur — you cannot fix focus on a card that is cut off', () => {
  // Ordering is the whole design. Telling someone to hold still while the
  // collector number is outside the frame sends them to a dead end.
  const v = gateFrame(clippedCard(128, 128, true), { fillMin: 0.05 });
  assert.equal(v.state, 'red');
  assert.match(v.hint, /cut off/);
});

test('an empty frame says what to do rather than reporting a metric', () => {
  const v = gateFrame(frame(64, 64, () => {}));
  assert.equal(v.state, 'red');
  assert.equal(v.hint, 'Point at a card');
});

test('the default sharpness threshold is the measured knee, not the peak', () => {
  // 250 lifted accuracy 68.6% -> 85% while rejecting 22% of frames. Above ~300
  // the curve flattens then declines; picking that peak would be fitting a
  // 51-photo sample.
  assert.equal(SHARPNESS_MIN, 250);
});

// --- stability + counters --------------------------------------------

test('green locks only after consecutive good frames', () => {
  const push = createStabiliser({ stableFrames: 3 });
  const g = { state: 'green', hint: 'Ready' };
  assert.equal(push(g).locked, false);
  assert.equal(push(g).locked, false);
  assert.equal(push(g).locked, true, 'third consecutive green locks');
});

test('any bad frame resets the lock immediately', () => {
  // Slow to go green is safe. Slow to go red is not — a stale green invites a
  // capture of a frame that has already drifted.
  const push = createStabiliser({ stableFrames: 3 });
  const g = { state: 'green' };
  push(g); push(g);
  assert.equal(push({ state: 'amber' }).run, 0);
  assert.equal(push(g).locked, false, 'the run restarts from zero');
});

test('every rejection increments a counter something can read', () => {
  // A gate that silently discards most frames is indistinguishable from a
  // broken camera. This project has shipped that failure more than once.
  resetGateCounts();
  gateFrame(frame(64, 64, () => {}));
  gateFrame(clippedCard(128, 128, true), { fillMin: 0.05 });
  gateFrame(blurryCard(128, 128, 24), { fillMin: 0.05 });
  gateFrame(sharpCard(128, 128, 24), { fillMin: 0.05, sharpnessMin: 10 });
  const c = getGateCounts();
  assert.equal(c.analysed, 4);
  assert.equal(c.no_card, 1);
  assert.equal(c.clipped, 1);
  assert.equal(c.blurry, 1);
  assert.equal(c.green, 1);
  resetGateCounts();
});
