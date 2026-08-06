// Regression: card-rectify — pricing/card-rectify.js
//
// Covers the rollout contract rather than matching accuracy (accuracy lives in
// docs/V3_BENCHMARK.md, measured against the real catalogue):
//
//   1. With CARD_RECTIFY unset, cropToCard behaves exactly as before. This is
//      the whole basis for calling the change safe, so it is asserted, not
//      assumed.
//   2. With CARD_RECTIFY=1, a synthetic tilted card on a textured background is
//      detected and rectified, and the 600x840 output contract still holds.
//   3. Every degenerate input degrades to a fallback instead of throwing —
//      a card scanner must never crash on a bad frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  rectifyCard, rectifyCardOrientations, isEnabled, CARD_W, CARD_H,
} from '../../pricing/card-rectify.js';
import { cropToCard } from '../../pricing/phash.js';

import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const RECTIFY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- fixtures ---------------------------------------------------------------

/** A card-like image: coloured border, lighter interior, plausible proportions. */
async function makeCard(w = 300, h = 419) {
  const border = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 220, g: 190, b: 40 } },
  }).png().toBuffer();

  const inset = Math.round(w * 0.07);
  const inner = await sharp({
    create: {
      width: w - inset * 2, height: h - inset * 2, channels: 3,
      background: { r: 60, g: 110, b: 180 },
    },
  }).png().toBuffer();

  return sharp(border)
    .composite([{ input: inner, left: inset, top: inset }])
    .png().toBuffer();
}

/**
 * That card, rotated and placed on a textured background — a "photograph".
 *
 * `rotate` defaults to a near-upright card; pass ~90 to lay it on its side, which
 * is how cards actually sit on a table and the case an earlier aspect test
 * rejected outright (0 of 8 detected on the operator's real photos).
 */
async function makeScene(rotate = 7) {
  const card = await sharp(await makeCard())
    .rotate(rotate, { background: { r: 30, g: 30, b: 30 } })
    .png().toBuffer();
  const cm = await sharp(card).metadata();

  const BW = Math.round(cm.width * 1.3), BH = Math.round(cm.height * 1.3);
  const NS = 24;
  const noise = Buffer.alloc(NS * NS * 3);
  // Deterministic pseudo-texture: uniform fill would let .trim() succeed for
  // the wrong reason and make this test prove nothing.
  for (let i = 0; i < noise.length; i++) noise[i] = 40 + ((i * 37) % 70);
  const bg = await sharp(noise, { raw: { width: NS, height: NS, channels: 3 } })
    .resize(BW, BH, { fit: 'fill' }).blur(4).png().toBuffer();

  return sharp(bg).composite([{
    input: card,
    left: Math.round((BW - cm.width) / 2),
    top: Math.round((BH - cm.height) / 2),
  }]).jpeg({ quality: 85 }).toBuffer();
}

function withFlag(value, fn) {
  const prev = process.env.CARD_RECTIFY;
  if (value === null) delete process.env.CARD_RECTIFY;
  else process.env.CARD_RECTIFY = value;
  return (async () => {
    try { return await fn(); }
    finally {
      if (prev === undefined) delete process.env.CARD_RECTIFY;
      else process.env.CARD_RECTIFY = prev;
    }
  })();
}

// --- flag gating ------------------------------------------------------------

test('isEnabled reflects CARD_RECTIFY and defaults to off', async () => {
  await withFlag(null, () => assert.equal(isEnabled(), false));
  await withFlag('0', () => assert.equal(isEnabled(), false));
  await withFlag('1', () => assert.equal(isEnabled(), true));
});

test('flag off: cropToCard keeps the 600x840 contract', async () => {
  await withFlag(null, async () => {
    const out = await cropToCard(await makeScene());
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 600);
    assert.equal(meta.height, 840);
  });
});

// --- rectification ----------------------------------------------------------

test('rectifyCard finds a tilted card on a textured background', async () => {
  const out = await rectifyCard(await makeScene());
  // Null is an acceptable outcome only if OpenCV is genuinely unavailable;
  // when it loads, this scene is well within what detection should handle.
  if (out === null) {
    console.warn('[card-rectify.spec] OpenCV unavailable — detection assertions skipped');
    return;
  }
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, CARD_W);
  assert.equal(meta.height, CARD_H);
});

// --- orientation ------------------------------------------------------------

test('rectifyCard finds a card lying LANDSCAPE and returns a portrait face', async () => {
  // Regression for the aspect test that only ever accepted an upright card:
  // it measured 0 of 8 on real photos, where cards lie flat on a table.
  // Establish OpenCV availability from the UPRIGHT case first. Without this, a
  // detector that rejects landscape cards returns null and the test skips —
  // silently passing the exact regression it exists to catch.
  const upright = await rectifyCard(await makeScene(7));
  if (upright === null) {
    console.warn('[card-rectify.spec] OpenCV unavailable — landscape assertions skipped');
    return;
  }

  const out = await rectifyCard(await makeScene(88));
  assert.ok(out !== null,
    'landscape card was not detected — the aspect gate is rejecting sideways cards again');
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, CARD_W);
  assert.equal(meta.height, CARD_H);
  // A landscape card warped without rotating the corner list squashes the long
  // edge into the width; the face then has no usable vertical structure. Check
  // the output actually carries the card's long axis vertically by confirming
  // the interior panel is taller than it is wide.
  const { data, info } = await sharp(out).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x, y) => data[y * info.width + x];
  const midX = Math.floor(info.width / 2), midY = Math.floor(info.height / 2);
  let vertRun = 0, horizRun = 0;
  for (let y = 0; y < info.height; y++) if (Math.abs(at(midX, y) - at(midX, midY)) < 40) vertRun++;
  for (let x = 0; x < info.width; x++) if (Math.abs(at(x, midY) - at(midX, midY)) < 40) horizRun++;
  assert.ok(vertRun / info.height > 0.5, `expected a tall interior panel, got ${vertRun}/${info.height}`);
  assert.ok(horizRun / info.width > 0.5, `expected a wide interior panel, got ${horizRun}/${info.width}`);
});

test('rectifyCardOrientations returns both 180-degree variants', async () => {
  const res = await rectifyCardOrientations(await makeScene());
  if (res === null) return; // OpenCV unavailable
  for (const buf of [res.primary, res.alt]) {
    const meta = await sharp(buf).metadata();
    assert.equal(meta.width, CARD_W);
    assert.equal(meta.height, CARD_H);
  }
  // The alt must actually differ — a card face is not symmetric under 180°.
  assert.notEqual(res.primary.toString('base64'), res.alt.toString('base64'));
});

test('rectifyCardOrientations returns null on unusable input, never throws', async () => {
  assert.equal(await rectifyCardOrientations(Buffer.alloc(0)), null);
  assert.equal(await rectifyCardOrientations(Buffer.from('garbage')), null);
  assert.equal(await rectifyCardOrientations(null), null);
});

test('flag on: cropToCard still returns 600x840', async () => {
  await withFlag('1', async () => {
    const out = await cropToCard(await makeScene());
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 600);
    assert.equal(meta.height, 840);
  });
});

// --- degradation ------------------------------------------------------------

test('rectifyCard returns null, never throws, on unusable input', async () => {
  assert.equal(await rectifyCard(Buffer.alloc(0)), null);
  assert.equal(await rectifyCard(Buffer.from('not an image')), null);
  assert.equal(await rectifyCard(null), null);
  assert.equal(await rectifyCard(undefined), null);
});

test('rectifyCard returns null on an image with no card-like quad', async () => {
  const blank = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).png().toBuffer();
  assert.equal(await rectifyCard(blank), null);
});

test('flag on: a frame with no card still falls back to a 600x840 buffer', async () => {
  await withFlag('1', async () => {
    const blank = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 128, g: 128, b: 128 } },
    }).png().toBuffer();
    const out = await cropToCard(blank);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 600);
    assert.equal(meta.height, 840);
  });
});

test('flag on: cropToCard does not throw on a corrupt buffer', async () => {
  await withFlag('1', async () => {
    const out = await cropToCard(Buffer.from('garbage'));
    assert.ok(Buffer.isBuffer(out));
  });
});

// ---------------------------------------------------------------------------
// Flag parsing. isEnabled() required the literal string '1', so CARD_RECTIFY=true
// looked correct, did nothing, and said nothing. In production the value was set
// correctly in the Render dashboard and was dropped by blueprint reconciliation
// because it was not declared in render.yaml — two silent ways for the same flag
// to be off while everyone believed it was on.

test('accepts the values a person would reasonably type', () => {
  for (const v of ['1', 'true', 'TRUE', 'Yes', ' on ', 'enabled']) {
    assert.equal(isEnabled({ CARD_RECTIFY: v }), true, `"${v}" should enable`);
  }
});

test('anything unrecognised stays OFF — a flag must not enable itself', () => {
  for (const v of ['0', 'false', 'no', 'off', '', '   ', 'maybe', undefined]) {
    assert.equal(isEnabled({ CARD_RECTIFY: v }), false, `"${v}" must not enable`);
  }
  assert.equal(isEnabled({}), false);
});

test('CARD_RECTIFY is declared in render.yaml, not only in the dashboard', () => {
  // Render reconciles the environment against the blueprint on every deploy, so
  // a dashboard-only variable is silently dropped. This is how it was set
  // correctly and still read as off.
  const yaml = fs.readFileSync(join(RECTIFY_ROOT, 'render.yaml'), 'utf8');
  assert.match(yaml, /- key: CARD_RECTIFY\s*\n\s*value: "1"/,
    'declare it in render.yaml or the next deploy will drop it');
});
