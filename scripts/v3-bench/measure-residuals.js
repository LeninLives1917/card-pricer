#!/usr/bin/env node
// scripts/v3-bench/measure-residuals.js
//
// What distortion actually survives rectification?
//
// Index-side augmentation only helps if the distortions it simulates match the
// ones real photographs carry AFTER rectification. Rectification already
// removes rotation and perspective, so augmenting for those wastes index space
// on a problem that is already solved. Guessing the parameters would be the
// same mistake as the synthetic benchmark: tuning against invented data.
//
// This measures the residual directly. For every photo the operator confirmed,
// it rectifies the photo, fetches that card's reference render, and compares:
//
//   brightness   mean luminance ratio (photo / reference)
//   contrast     stddev ratio — sleeve haze and glare flatten contrast
//   sharpness    variance-of-Laplacian ratio — how much softer the photo is
//   framing      best alignment offset found by a small translation search
//
// Output feeds the augmentation parameters in build-embeddings.js.

import fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { rectify } from './rectify.js';

const CACHE = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const W = 245, H = 342;

const stats = a => {
  const v = [...a].sort((x, y) => x - y);
  const q = p => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  return { n: v.length, p10: q(0.10), p50: q(0.50), p90: q(0.90), min: v[0], max: v[v.length - 1] };
};
const show = (name, s, unit = '') =>
  console.log(`  ${name.padEnd(12)} p10 ${s.p10.toFixed(3)}${unit}  median ${s.p50.toFixed(3)}${unit}  ` +
              `p90 ${s.p90.toFixed(3)}${unit}   (range ${s.min.toFixed(3)}–${s.max.toFixed(3)})`);

async function grey(buf) {
  const { data } = await sharp(buf).resize(W, H, { fit: 'fill' }).greyscale()
    .raw().toBuffer({ resolveWithObject: true });
  return data;
}
const mean = d => d.reduce((s, v) => s + v, 0) / d.length;
function stddev(d) { const m = mean(d); return Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / d.length); }
/** Variance of the 4-neighbour Laplacian — a standard sharpness proxy. */
function lapVar(d) {
  const out = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    out.push(4 * d[i] - d[i - 1] - d[i + 1] - d[i - W] - d[i + W]);
  }
  return stddev(out) ** 2;
}
/** Best translation offset (in card fractions) by coarse search. */
function bestOffset(a, b) {
  let best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -12; dy <= 12; dy += 3) for (let dx = -12; dx <= 12; dx += 3) {
    let err = 0, n = 0;
    for (let y = 20; y < H - 20; y += 4) for (let x = 20; x < W - 20; x += 4) {
      const j = (y + dy) * W + (x + dx);
      if (j < 0 || j >= a.length) continue;
      err += Math.abs(a[y * W + x] - b[j]); n++;
    }
    if (n && err / n < best.err) best = { dx, dy, err: err / n };
  }
  return { dx: best.dx / W, dy: best.dy / H };
}

async function main() {
  const labels = JSON.parse(fs.readFileSync(join(CACHE, 'photos', 'labels.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(join(CACHE, 'manifest.json'), 'utf8'));
  const confirmed = Object.entries(labels).filter(([, v]) => v !== '__none__');
  console.log(`[residuals] ${confirmed.length} photos with a confirmed card`);

  const bright = [], contrast = [], sharp_ = [], offX = [], offY = [];
  let done = 0, skipped = 0;

  for (const [rel, cardId] of confirmed) {
    const m = manifest.cards[cardId];
    if (!m) { skipped++; continue; }
    const refPath = join(CACHE, 'refs', m.set_id,
      `${String(m.number).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`);
    if (!fs.existsSync(refPath)) { skipped++; continue; }

    try {
      const { buffer, alt } = await rectify(fs.readFileSync(join(CACHE, 'photos', rel)));
      const ref = await grey(fs.readFileSync(refPath));
      // Pick the orientation closer to the reference, so a 180 flip does not
      // masquerade as a huge residual.
      let photo = await grey(buffer);
      if (alt) {
        const altG = await grey(alt);
        const err = g => { let e = 0; for (let i = 0; i < g.length; i += 7) e += Math.abs(g[i] - ref[i]); return e; };
        if (err(altG) < err(photo)) photo = altG;
      }

      bright.push(mean(photo) / Math.max(1, mean(ref)));
      contrast.push(stddev(photo) / Math.max(1, stddev(ref)));
      sharp_.push(lapVar(photo) / Math.max(1, lapVar(ref)));
      const o = bestOffset(ref, photo);
      offX.push(Math.abs(o.dx)); offY.push(Math.abs(o.dy));
      done++;
    } catch { skipped++; }
  }

  console.log(`[residuals] measured ${done}, skipped ${skipped}\n`);
  console.log('Residual distortion surviving rectification (photo / reference):');
  show('brightness', stats(bright), 'x');
  show('contrast', stats(contrast), 'x');
  show('sharpness', stats(sharp_), 'x');
  console.log('\nFraming offset remaining after rectification (fraction of card):');
  show('|dx|', stats(offX));
  show('|dy|', stats(offY));

  const b = stats(bright), c = stats(contrast), s = stats(sharp_);
  console.log('\nSuggested augmentation envelope (p10–p90 of what was measured):');
  console.log(`  brightness  ${b.p10.toFixed(2)}–${b.p90.toFixed(2)}x`);
  console.log(`  contrast    ${c.p10.toFixed(2)}–${c.p90.toFixed(2)}x`);
  console.log(`  sharpness   ${s.p10.toFixed(2)}–${s.p90.toFixed(2)}x  (values <1 mean the photo is softer)`);
  console.log(`  framing     +/-${(stats(offX).p90 * 100).toFixed(1)}% x, +/-${(stats(offY).p90 * 100).toFixed(1)}% y`);
}

main().catch(e => { console.error('[residuals] FATAL:', e); process.exit(1); });
