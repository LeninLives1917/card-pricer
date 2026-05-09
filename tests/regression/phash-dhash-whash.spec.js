// Regression: dHash and wHash computation — pricing/phash.js
//
// Locks down determinism, return-type, range, and sensitivity contracts for
// computeDhash and computeWhash, mirroring the structure of phash.spec.js.
//
// All test images are synthesised via Sharp — no on-disk fixtures, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { computeDhash, computeWhash } from '../../pricing/phash.js';

// ── Hamming distance helper ───────────────────────────────────────────────

function hamming(a, b) {
  let x = a ^ b;
  let c = 0n;
  while (x) {
    c += x & 1n;
    x >>= 1n;
  }
  return Number(c);
}

// ── Synthetic image factories ─────────────────────────────────────────────

async function solidImage(width, height, r, g, b) {
  return sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

async function gradientImage(width, height) {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      const base = (y * width + x) * 3;
      pixels[base] = v; pixels[base + 1] = v; pixels[base + 2] = v;
    }
  }
  return sharp(Buffer.from(pixels.buffer), { raw: { width, height, channels: 3 } })
    .png().toBuffer();
}

async function mixedGradientImage(width, height) {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const vx = Math.round((x / (width - 1)) * 180 + 20);
      const vy = Math.round((y / (height - 1)) * 50);
      const base = (y * width + x) * 3;
      pixels[base]     = Math.min(255, vx + Math.round(Math.sin(x / 5) * 20));
      pixels[base + 1] = Math.min(255, vy + Math.round(Math.cos(y / 4) * 15));
      pixels[base + 2] = Math.min(255, Math.round((vx + vy) / 2));
    }
  }
  return sharp(Buffer.from(pixels.buffer), { raw: { width, height, channels: 3 } })
    .png().toBuffer();
}

async function radialGradientImage(width, height) {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2, dy = y - height / 2;
      const v = Math.min(255, Math.round((Math.sqrt(dx * dx + dy * dy) / (width / 2)) * 255));
      const base = (y * width + x) * 3;
      pixels[base] = v; pixels[base + 1] = v; pixels[base + 2] = v;
    }
  }
  return sharp(Buffer.from(pixels.buffer), { raw: { width, height, channels: 3 } })
    .png().toBuffer();
}

// =============================================================================
// dHash tests
// =============================================================================

test('computeDhash returns a BigInt', async () => {
  const buf = await solidImage(64, 64, 128, 128, 128);
  const hash = await computeDhash(buf);
  assert.strictEqual(typeof hash, 'bigint', `expected BigInt, got ${typeof hash}`);
});

test('computeDhash returns a value in the 64-bit range', async () => {
  const buf = await solidImage(64, 64, 200, 100, 50);
  const hash = await computeDhash(buf);
  assert.ok(hash >= 0n);
  assert.ok(hash < (1n << 64n));
});

test('computeDhash is deterministic: same buffer → same hash on 3 calls', async () => {
  const buf = await gradientImage(80, 80);
  const h1 = await computeDhash(buf);
  const h2 = await computeDhash(buf);
  const h3 = await computeDhash(buf);
  assert.strictEqual(h1, h2, 'second call differs from first');
  assert.strictEqual(h2, h3, 'third call differs from second');
});

test('computeDhash: identical content from independent pipelines → distance 0', async () => {
  const buf1 = await gradientImage(96, 96);
  const buf2 = await gradientImage(96, 96);
  const h1 = await computeDhash(buf1);
  const h2 = await computeDhash(buf2);
  assert.strictEqual(hamming(h1, h2), 0,
    `expected distance 0, got ${hamming(h1, h2)}`);
});

test('computeDhash: JPEG recompression (q99→q80) yields distance ≤ 8', async () => {
  const base = await mixedGradientImage(64, 64);
  const q99 = await sharp(base).jpeg({ quality: 99 }).toBuffer();
  const q80 = await sharp(base).jpeg({ quality: 80 }).toBuffer();
  const h1 = await computeDhash(q99);
  const h2 = await computeDhash(q80);
  const dist = hamming(h1, h2);
  assert.ok(dist <= 8, `expected distance ≤ 8 for JPEG q99→q80, got ${dist}`);
});

test('computeDhash: brightness shift +15% yields distance ≤ 8 (dHash is brightness-robust)', async () => {
  // dHash is differential — a global brightness offset cancels out in the
  // column comparisons, so the hash should be nearly identical.
  const base = await mixedGradientImage(64, 64);
  const bright = await sharp(base).modulate({ brightness: 1.15 }).toBuffer();
  const h1 = await computeDhash(base);
  const h2 = await computeDhash(bright);
  const dist = hamming(h1, h2);
  assert.ok(dist <= 8, `dHash should be robust to +15% brightness, distance=${dist}`);
});

test('computeDhash: horizontal gradient vs radial gradient → distance ≥ 10', async () => {
  const grad = await gradientImage(64, 64);
  const radial = await radialGradientImage(64, 64);
  const h1 = await computeDhash(grad);
  const h2 = await computeDhash(radial);
  const dist = hamming(h1, h2);
  assert.ok(dist >= 10, `expected distance ≥ 10 for structurally different images, got ${dist}`);
});

// =============================================================================
// wHash tests
// =============================================================================

test('computeWhash returns a BigInt', async () => {
  const buf = await solidImage(64, 64, 128, 128, 128);
  const hash = await computeWhash(buf);
  assert.strictEqual(typeof hash, 'bigint', `expected BigInt, got ${typeof hash}`);
});

test('computeWhash returns a value in the 64-bit range', async () => {
  const buf = await solidImage(64, 64, 200, 100, 50);
  const hash = await computeWhash(buf);
  assert.ok(hash >= 0n);
  assert.ok(hash < (1n << 64n));
});

test('computeWhash is deterministic: same buffer → same hash on 3 calls', async () => {
  const buf = await mixedGradientImage(80, 80);
  const h1 = await computeWhash(buf);
  const h2 = await computeWhash(buf);
  const h3 = await computeWhash(buf);
  assert.strictEqual(h1, h2, 'second call differs from first');
  assert.strictEqual(h2, h3, 'third call differs from second');
});

test('computeWhash: identical content from independent pipelines → distance 0', async () => {
  const buf1 = await gradientImage(96, 96);
  const buf2 = await gradientImage(96, 96);
  const h1 = await computeWhash(buf1);
  const h2 = await computeWhash(buf2);
  assert.strictEqual(hamming(h1, h2), 0,
    `expected distance 0, got ${hamming(h1, h2)}`);
});

test('computeWhash: JPEG recompression (q99→q80) yields distance ≤ 8', async () => {
  const base = await mixedGradientImage(64, 64);
  const q99 = await sharp(base).jpeg({ quality: 99 }).toBuffer();
  const q80 = await sharp(base).jpeg({ quality: 80 }).toBuffer();
  const h1 = await computeWhash(q99);
  const h2 = await computeWhash(q80);
  const dist = hamming(h1, h2);
  assert.ok(dist <= 8, `expected distance ≤ 8 for JPEG q99→q80, got ${dist}`);
});

test('computeWhash: horizontal gradient vs radial gradient → distance ≥ 10', async () => {
  const grad = await gradientImage(64, 64);
  const radial = await radialGradientImage(64, 64);
  const h1 = await computeWhash(grad);
  const h2 = await computeWhash(radial);
  const dist = hamming(h1, h2);
  assert.ok(dist >= 10, `expected distance ≥ 10 for structurally different images, got ${dist}`);
});

// =============================================================================
// Cross-algorithm sensitivity: pHash/dHash/wHash disagree on different images
// =============================================================================

test('all three hash types return distinct values for structurally different images', async () => {
  // Sanity: the three algorithms are independent — a horizontal gradient and
  // a radial gradient should produce different hashes under all three types.
  const { computePhash } = await import('../../pricing/phash.js');
  const grad   = await gradientImage(64, 64);
  const radial = await radialGradientImage(64, 64);

  const [p1, d1, w1] = await Promise.all([computePhash(grad), computeDhash(grad), computeWhash(grad)]);
  const [p2, d2, w2] = await Promise.all([computePhash(radial), computeDhash(radial), computeWhash(radial)]);

  // Each algorithm should show meaningful separation between the two images.
  assert.ok(hamming(p1, p2) > 0, 'pHash should differ for gradient vs radial');
  assert.ok(hamming(d1, d2) > 0, 'dHash should differ for gradient vs radial');
  assert.ok(hamming(w1, w2) > 0, 'wHash should differ for gradient vs radial');
});
