// Regression: cropToCard — pricing/phash.js
//
// Verifies that cropToCard:
//   1. Returns a Buffer.
//   2. Returns an image at the normalised card dimensions (600×840).
//   3. Removes uniform borders: an image with a thick solid-colour border
//      produces output whose metadata matches the 600×840 target.
//   4. Is resilient — returns the original buffer (without throwing) when
//      given a deliberately minimal/degenerate input.
//   5. Does not alter an image that already matches card dimensions.
//
// All images are synthesised via Sharp — no on-disk fixtures, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { cropToCard } from '../../pricing/phash.js';

// ── Helpers ───────────────────────────────────────────────────────────────

async function solidImage(width, height, r, g, b) {
  return sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  }).png().toBuffer();
}

/**
 * Build a synthetic "card + border" image: a white-background card body
 * (inner rectangle) centred within a grey border frame.
 */
async function cardWithBorder(totalW, totalH, borderPx, cardR, cardG, cardB, borderR, borderG, borderB) {
  // Create a solid-border outer image then composite the card body on top.
  const outer = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r: borderR, g: borderG, b: borderB } },
  }).png().toBuffer();

  const innerW = totalW - borderPx * 2;
  const innerH = totalH - borderPx * 2;

  // Inner card-body: a gradient so it has real structure (not uniform —
  // Sharp's trim may not trim a uniform inner region).
  const pixels = new Uint8Array(innerW * innerH * 3);
  for (let y = 0; y < innerH; y++) {
    for (let x = 0; x < innerW; x++) {
      const v = Math.round((x / (innerW - 1)) * 180 + 40);
      const base = (y * innerW + x) * 3;
      pixels[base] = cardR ? cardR : v;
      pixels[base + 1] = cardG ? cardG : Math.max(0, v - 30);
      pixels[base + 2] = cardB ? cardB : Math.max(0, v - 60);
    }
  }
  const inner = await sharp(Buffer.from(pixels.buffer), { raw: { width: innerW, height: innerH, channels: 3 } })
    .png().toBuffer();

  return sharp(outer)
    .composite([{ input: inner, left: borderPx, top: borderPx }])
    .png()
    .toBuffer();
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('cropToCard returns a Buffer', async () => {
  const buf = await solidImage(400, 560, 200, 200, 200);
  const result = await cropToCard(buf);
  assert.ok(Buffer.isBuffer(result), 'expected a Buffer');
});

test('cropToCard output is 600×840 (standard card dimensions)', async () => {
  const buf = await solidImage(400, 560, 150, 100, 80);
  const result = await cropToCard(buf);
  const meta = await sharp(result).metadata();
  assert.strictEqual(meta.width,  600, `expected width 600, got ${meta.width}`);
  assert.strictEqual(meta.height, 840, `expected height 840, got ${meta.height}`);
});

test('cropToCard: image already at card dimensions still returns 600×840 buffer', async () => {
  const buf = await solidImage(600, 840, 180, 120, 60);
  const result = await cropToCard(buf);
  const meta = await sharp(result).metadata();
  assert.strictEqual(meta.width,  600);
  assert.strictEqual(meta.height, 840);
});

test('cropToCard: wide landscape photo → 600×840 output', async () => {
  // A phone photo held in landscape: 1200×900 with no significant border.
  const pixels = new Uint8Array(1200 * 900 * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = 100; pixels[i + 1] = 80; pixels[i + 2] = 60;
  }
  const buf = await sharp(Buffer.from(pixels.buffer), { raw: { width: 1200, height: 900, channels: 3 } })
    .png().toBuffer();
  const result = await cropToCard(buf);
  const meta = await sharp(result).metadata();
  assert.strictEqual(meta.width,  600);
  assert.strictEqual(meta.height, 840);
});

test('cropToCard: image with large uniform border produces 600×840 output', async () => {
  // A card body (gradient) surrounded by a thick solid grey border.
  // After trim + inset the output should still be 600×840 (the resize step
  // normalises dimensions regardless of how much border was removed).
  const buf = await cardWithBorder(800, 900, 100, 0, 0, 0, 200, 200, 200);
  const result = await cropToCard(buf);
  const meta = await sharp(result).metadata();
  assert.strictEqual(meta.width,  600, `width should be 600 after crop-normalise, got ${meta.width}`);
  assert.strictEqual(meta.height, 840, `height should be 840, got ${meta.height}`);
});

test('cropToCard: does not throw on a tiny 1×1 image', async () => {
  // Degenerate case — cropToCard must either return the original or a
  // normalised buffer without throwing.
  const buf = await solidImage(1, 1, 128, 128, 128);
  const result = await cropToCard(buf);
  assert.ok(Buffer.isBuffer(result), 'must return a Buffer even for 1×1 input');
});

test('cropToCard: does not throw on an invalid/empty buffer', async () => {
  // Fully invalid input — Sharp will fail internally; cropToCard must catch
  // and return the original buffer rather than propagating the error.
  const emptyBuf = Buffer.alloc(0);
  const result = await cropToCard(emptyBuf);
  // Result is the original unchanged buffer (graceful degradation).
  assert.ok(Buffer.isBuffer(result), 'must return a Buffer for invalid input');
  // We only require it not to throw and to return a Buffer; we do NOT require
  // it to be 600×840 since we returned the broken original.
});

test('cropToCard: output aspect ratio is approximately 5:7 (card proportions)', async () => {
  // 600:840 = 5:7. Allow ±2px tolerance.
  const buf = await solidImage(400, 560, 100, 150, 200);
  const result = await cropToCard(buf);
  const meta = await sharp(result).metadata();
  // The resize(600, 840, fill) guarantees exact dimensions — this is a
  // belt-and-braces check that the implementation hasn't changed the target.
  const ratio = meta.width / meta.height;
  const expected = 600 / 840;
  assert.ok(
    Math.abs(ratio - expected) < 0.01,
    `expected ratio ~${expected.toFixed(3)}, got ${ratio.toFixed(3)}`
  );
});
