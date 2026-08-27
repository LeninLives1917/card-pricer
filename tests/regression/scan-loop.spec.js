// tests/regression/scan-loop.spec.js
//
// The hands-free scanning loop: gate the reticle the operator is aiming at,
// fire once, then wait for the card to physically leave before firing again.
//
// Everything here is pure, so a whole scanning session runs in under a
// millisecond with no browser, no camera and no clock.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAutoFire, LOCK_FRAMES, CLEAR_FRAMES } from '../../apps/vendor/modules/scan-loop.js';
import {
  gateReticle, detailDensity, sceneDelta, DETAIL_MIN, SHARPNESS_MIN,
  resetReticleCounts, getReticleCounts,
} from '../../apps/vendor/modules/frame-gate.js';
import {
  reticleRect, containedBox, CARD_ASPECT,
  focusConstraints, cameraReport, resetCameraReport,
} from '../../apps/vendor/modules/capture.js';

/** An RGBA region. `paint(x,y)` returns the grey level. */
function roi(w, h, paint) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const bareTable = (w = 64, h = 90) => roi(w, h, () => 128);
/**
 * Dense detail at several scales, like card art and text.
 *
 * NOT a period-2 checkerboard: a central difference compares x-1 against x+1,
 * which on a two-pixel pattern are the same value, so the sharpest possible
 * image reads as perfectly flat. Real art carries detail at many scales and is
 * unaffected, but it is worth knowing the operator has a blind frequency.
 */
const cardLike = (w = 64, h = 90) => roi(w, h, (x, y) =>
  (Math.floor(x / 3) + Math.floor(y / 4)) % 2 ? 20 : 235);
/** The same busy card seen through a soft lens. */
const blurredCard = (w = 64, h = 90) => roi(w, h, (x, y) => 128 + 40 * Math.sin((x + y) / 9));

describe('gateReticle answers about the box, not about a hunted card', () => {
  test('a bare table is not a card, however sharp the sensor is', () => {
    // This is the case locateCard could not express: it had no way to say
    // "nothing here", because a bounding box over noise still has an area.
    const v = gateReticle(bareTable());
    assert.equal(v.state, 'red');
    assert.match(v.hint, /Fill the box/);
  });

  test('a busy in-focus card goes green', () => {
    const v = gateReticle(cardLike());
    assert.equal(v.state, 'green', `detail ${v.detail.toFixed(3)} sharpness ${Math.round(v.sharpness)}`);
  });

  test('a card that is present but soft asks the operator to hold still', () => {
    const v = gateReticle(blurredCard(), { detailMin: 0 });
    assert.equal(v.state, 'amber');
    assert.match(v.hint, /Hold still/);
  });

  test('presence is decided before focus', () => {
    // "Hold still" over an empty table is advice about nothing, and a blur
    // reading taken off a bare surface is not a measurement of anything.
    const v = gateReticle(bareTable(), { sharpnessMin: 1e9 });
    assert.match(v.hint, /Fill the box/, 'emptiness must win over blur');
  });

  test('every verdict is counted', () => {
    resetReticleCounts();
    gateReticle(cardLike());
    gateReticle(bareTable());
    const c = getReticleCounts();
    assert.equal(c.analysed, 2);
    assert.equal(c.green + c.blurry + c.empty, 2, 'no frame may be uncounted');
  });
});

describe('detailDensity separates a card from a surface', () => {
  test('flat grey has no detail', () => {
    assert.ok(detailDensity(bareTable()) < DETAIL_MIN);
  });

  test('an absolute floor keeps sensor noise from becoming a card', () => {
    // A threshold relative to the frame's own mean promotes noise to signal on
    // a flat frame and reports a confident card on a picture of nothing —
    // the same trap already guarded in locateCard.
    const noisy = roi(64, 90, (x, y) => 128 + (((x * 31 + y * 17) % 5) - 2));
    assert.ok(detailDensity(noisy) < DETAIL_MIN, 'faint noise is not detail');
  });
});

describe('sceneDelta notices the card was swapped', () => {
  test('the same view scores near zero', () => {
    assert.ok(sceneDelta(cardLike(), cardLike()) < 0.01);
  });

  test('a different view scores high', () => {
    assert.ok(sceneDelta(cardLike(), bareTable()) > 0.1);
  });

  test('mismatched sizes are maximally different, never a crash', () => {
    assert.equal(sceneDelta(cardLike(32, 40), cardLike(64, 90)), 1);
    assert.equal(sceneDelta(null, cardLike()), 1);
  });
});

describe('createAutoFire fires once per card', () => {
  const green = (f, t, n = 1, d = 0) => {
    let fires = 0;
    for (let i = 0; i < n; i++) if (f({ state: 'green', sceneDelta: d, now: t.v += 120 }).fire) fires++;
    return fires;
  };
  const red = (f, t, n) => { for (let i = 0; i < n; i++) f({ state: 'red', now: t.v += 120 }); };

  test('a card left in frame is scanned once, not forty times', () => {
    // There is no dedupe anywhere else on this path — pair.js posts whatever
    // it is handed — so this counter IS the guard.
    const f = createAutoFire(); const t = { v: 0 };
    assert.equal(green(f, t, 60), 1);
  });

  test('it settles before firing', () => {
    const f = createAutoFire(); const t = { v: 0 };
    assert.equal(green(f, t, LOCK_FRAMES - 1), 0, 'a brief green must not fire');
    assert.equal(green(f, t, 1), 1);
  });

  test('FOUR COPIES OF THE SAME CARD ARE FOUR SCANS', () => {
    // The regression that matters. Suppressing by card identity would eat
    // three of these, report four sent, and leave nothing to disagree with.
    // The rule is physical — fire, then wait for the card to leave — so
    // identity never enters into it.
    const f = createAutoFire(); const t = { v: 0 };
    let fires = 0;
    for (let card = 0; card < 4; card++) {
      fires += green(f, t, 10);
      red(f, t, CLEAR_FRAMES);        // lifted off
    }
    assert.equal(fires, 4);
  });

  test('a card slid out and replaced in one motion still fires', () => {
    // This operator never produces an empty frame, so the clear-frames rule
    // alone would fire once and then stall — and a stall reads as silence,
    // not as an error.
    const f = createAutoFire(); const t = { v: 0 };
    assert.equal(green(f, t, 10), 1);
    green(f, t, 3, 0.4);                    // the swap: the view is moving
    assert.equal(green(f, t, 10), 1, 'once the new card settles it fires');
    assert.equal(f.counts().rearm_scene, 1);
  });

  test('movement across the reticle does not fire repeatedly', () => {
    // sceneDelta is measured between consecutive frames, so a hand crossing
    // the box holds it high for a second or more. Re-arming on every one of
    // those frames turns one swap into three scans.
    const f = createAutoFire(); const t = { v: 0 };
    green(f, t, 10);                        // card one, one scan
    green(f, t, 25, 0.4);                   // sustained movement
    assert.equal(f.counts().fired, 1, 'nothing may fire while the view is moving');
    assert.ok(f.counts().settling_scene > 0, 'and the wait must be counted');
  });

  test('a wobble at the clear threshold does not double-fire', () => {
    const f = createAutoFire(); const t = { v: 0 };
    green(f, t, 10);
    for (let i = 0; i < 8; i++) { red(f, t, CLEAR_FRAMES); green(f, t, 1); }
    assert.ok(f.counts().fired <= 2, `flicker produced ${f.counts().fired} fires`);
  });

  test('a red frame during settling resets the lock', () => {
    const f = createAutoFire(); const t = { v: 0 };
    green(f, t, LOCK_FRAMES - 1);
    red(f, t, 1);
    assert.equal(green(f, t, LOCK_FRAMES - 1), 0, 'the run must start again');
  });

  test('every frame lands in exactly one reason', () => {
    const f = createAutoFire(); const t = { v: 0 };
    const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add(f({ state: i % 7 ? 'green' : 'red', now: t.v += 120 }).reason);
    assert.ok(seen.size > 1);
    assert.equal(f.counts().frames, 30);
  });

  test('reset returns it to armed', () => {
    const f = createAutoFire(); const t = { v: 0 };
    green(f, t, 10);
    f.reset();
    assert.equal(green(f, t, 10), 1, 'reset must re-arm, not leave it held');
  });
});

// ---------------------------------------------------------------------------
// RETICLE GEOMETRY.
//
// Once the gate reads the reticle, the box on screen and the box in the sensor
// frame have to be the same rectangle. If they drift the operator is lining
// the card up against a rectangle nothing is grading — and nothing about the
// screen would look wrong.

describe('reticleRect is the same box the gate reads', () => {
  const SIZES = [[1080, 1920], [1920, 1080], [1280, 720], [720, 1280], [1000, 1000], [4000, 2252]];

  test('true card aspect in PIXELS at every sensor shape', () => {
    // A box given as an independent fraction of each axis is card-shaped at
    // exactly one sensor aspect and skewed at every other, which is not
    // something anyone would catch by looking at it.
    for (const [w, h] of SIZES) {
      const r = reticleRect(w, h);
      assert.ok(Math.abs((r.w * w) / (r.h * h) - CARD_ASPECT) < 1e-9, `${w}x${h}`);
    }
  });

  test('it always fits inside the frame', () => {
    for (const [w, h] of SIZES) {
      const r = reticleRect(w, h);
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 && r.y + r.h <= 1, `${w}x${h}`);
    }
  });

  test('it is centred', () => {
    for (const [w, h] of SIZES) {
      const r = reticleRect(w, h);
      assert.ok(Math.abs((r.x + r.w / 2) - 0.5) < 1e-9);
      assert.ok(Math.abs((r.y + r.h / 2) - 0.5) < 1e-9);
    }
  });

  test('it takes the largest card-shaped box that fits, not the short axis', () => {
    // Sizing against the short axis looks equivalent and quietly throws away
    // a third of the card's pixels in portrait — resolution not spent on the
    // collector number, the field behind ~30% of failures.
    const portrait = reticleRect(1080, 1920);
    assert.ok(portrait.w > 0.7, `portrait wastes width: ${portrait.w.toFixed(2)}`);
    const landscape = reticleRect(1920, 1080);
    assert.ok(landscape.h > 0.7, `landscape wastes height: ${landscape.h.toFixed(2)}`);
  });

  test('a frame with no dimensions yields the whole frame, never NaN', () => {
    for (const r of [reticleRect(0, 0), reticleRect(undefined, 100)]) {
      for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(r[k]), k);
    }
  });
});

describe('containedBox places the overlay on the video, not the element', () => {
  test('letterboxes on the axis that does not fit', () => {
    const b = containedBox(400, 600, 1080, 1920);   // element wider than the frame
    assert.ok(b.left > 0 && Math.abs(b.top) < 1e-9);
    assert.ok(Math.abs(b.height - 600) < 1e-9, 'the tall axis should fill');
  });

  test('the painted box never exceeds the element', () => {
    for (const [ew, eh] of [[400, 600], [900, 200], [50, 50]]) {
      const b = containedBox(ew, eh, 1920, 1080);
      assert.ok(b.width <= ew + 1e-9 && b.height <= eh + 1e-9);
    }
  });

  test('matching aspects need no letterbox', () => {
    const b = containedBox(960, 540, 1920, 1080);
    assert.ok(Math.abs(b.left) < 1e-9 && Math.abs(b.top) < 1e-9);
  });

  test('a zero-sized frame degrades rather than dividing by zero', () => {
    const b = containedBox(400, 600, 0, 0);
    for (const k of ['left', 'top', 'width', 'height']) assert.ok(Number.isFinite(b[k]), k);
  });
});

// ---------------------------------------------------------------------------
// CAMERA CONTROL.
//
// This app asked the phone for a rear camera and torch, and nothing else. V1
// had tap-to-focus and pinch zoom; the V3 rewrite dropped both. That matters
// beyond itself: "would a native app be more reliable" is largely a question
// about camera control, and it cannot be answered while the web path asks for
// none of the controls the web already exposes.

describe('focusConstraints asks only for what the device offers', () => {
  test('a device with everything gets continuous focus, exposure and a centre point', () => {
    const c = focusConstraints({
      focusMode: ['manual', 'single-shot', 'continuous'],
      exposureMode: ['manual', 'continuous'],
      pointsOfInterest: true,
    });
    assert.deepEqual(c.find((x) => 'focusMode' in x), { focusMode: 'continuous' });
    assert.deepEqual(c.find((x) => 'exposureMode' in x), { exposureMode: 'continuous' });
    assert.deepEqual(c.find((x) => 'pointsOfInterest' in x).pointsOfInterest, [{ x: 0.5, y: 0.5 }]);
  });

  test('continuous is preferred over manual', () => {
    // The operator slides cards under a fixed phone: the subject distance
    // barely changes but does change, so a manual lock set on card one is
    // wrong by card ten.
    const c = focusConstraints({ focusMode: ['manual', 'continuous'] });
    assert.deepEqual(c[0], { focusMode: 'continuous' });
  });

  test('single-shot is taken when continuous is absent', () => {
    assert.deepEqual(focusConstraints({ focusMode: ['single-shot'] }), [{ focusMode: 'single-shot' }]);
  });

  test('manual alone is not used at all', () => {
    assert.deepEqual(focusConstraints({ focusMode: ['manual'] }), []);
  });

  test('a device offering nothing is asked for nothing, never guessed at', () => {
    // applyConstraints with an unsupported advanced constraint is not an
    // error on every device — some accept it and ignore it, which is how a
    // camera comes to look locked while focusing on the table.
    for (const caps of [null, undefined, {}, { focusMode: [] }]) {
      assert.deepEqual(focusConstraints(caps), []);
    }
  });
});

describe('cameraReport distinguishes never-asked from refused', () => {
  test('it starts null, not false', () => {
    resetCameraReport();
    const r = cameraReport();
    for (const k of ['focus', 'exposure', 'still']) {
      assert.equal(r[k], null, `${k} must be null before anything is attempted`);
    }
  });

  test('it is a copy, so a caller cannot corrupt the record', () => {
    resetCameraReport();
    const r = cameraReport();
    r.focus = 'tampered';
    assert.equal(cameraReport().focus, null);
  });
});
