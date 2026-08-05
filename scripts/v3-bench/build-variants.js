#!/usr/bin/env node
// scripts/v3-bench/build-variants.js
//
// V3 Phase 0 — framing-variant index.
//
// The round-trip check (docs/V3_BENCHMARK.md §5.2) showed the index and the
// query do not share a framing convention: feeding clean references back in
// scores 90%, not 100%. The index takes the raw CDN render straight to the art
// box; a query arrives via rectification, whose detected card edge sits a little
// differently. A fixed art box then samples slightly different content on each
// side, and a perceptual hash has no tolerance for that.
//
// Rather than chase an exact convention match — which would still be brittle
// against real perspective residual — index each card at several framing
// offsets and match on the best. This is the same trick the original crawler
// used (5 visual variants per card) applied to the axis that actually matters.
//
// Only pHash and dHash are computed. wHash measured weakest on every
// separability metric (§3) and is dropped.
//
// Usage:
//   node scripts/v3-bench/build-variants.js
//   node scripts/v3-bench/build-variants.js --limit 2000

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

import { computePhash, computeDhash } from '../../pricing/phash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const IMG_DIR = join(CACHE_DIR, 'refs');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
const OUT_FILE = join(CACHE_DIR, 'variants.json');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : Number(process.argv[i + 1]);
}
const LIMIT = argVal('--limit');

const ART_BOX = { left: 0.085, top: 0.115, width: 0.830, height: 0.420 };

// Framing variants, as multiplicative scale about the art-box centre plus a
// translation in card-fraction units. Chosen to span the residual error a
// rectified capture can carry: a slightly tight or loose card-edge detection
// (scale) and a small perspective-induced drift (translation).
const VARIANTS = [
  { s: 1.00, dx: 0.000, dy: 0.000 },   // canonical
  { s: 0.94, dx: 0.000, dy: 0.000 },   // detection ran tight
  { s: 1.06, dx: 0.000, dy: 0.000 },   // detection ran loose
  { s: 1.00, dx: 0.020, dy: 0.015 },   // drift down-right
  { s: 1.00, dx: -0.020, dy: -0.015 }, // drift up-left
];

function boxFor(v) {
  const cx = ART_BOX.left + ART_BOX.width / 2 + v.dx;
  const cy = ART_BOX.top + ART_BOX.height / 2 + v.dy;
  const w = ART_BOX.width * v.s;
  const h = ART_BOX.height * v.s;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

async function artCrop(buf, meta, box) {
  const left = Math.max(0, Math.round(meta.width * box.left));
  const top = Math.max(0, Math.round(meta.height * box.top));
  const width = Math.max(1, Math.min(meta.width - left, Math.round(meta.width * box.width)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(meta.height * box.height)));
  return sharp(buf).extract({ left, top, width, height })
    .resize(245, 342, { fit: 'fill' }).toBuffer();
}

async function main() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error('[variants] run fetch-refs.js first'); process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  let ids = Object.keys(manifest.cards).sort();
  if (LIMIT) ids = ids.slice(0, LIMIT);

  console.log(`[variants] ${ids.length} cards x ${VARIANTS.length} framing variants`);
  const boxes = VARIANTS.map(boxFor);

  // Resume: this build takes ~30 min and previously wrote only on completion,
  // so a kill lost every card. Checkpoint periodically and skip what is already
  // present. Written to a tmp path then renamed so an interrupted checkpoint
  // cannot leave a truncated file behind.
  let cards = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      if (prev.version === 1 && prev.cards
          && JSON.stringify(prev.variants) === JSON.stringify(VARIANTS)) {
        cards = prev.cards;
        console.log(`[variants] resuming — ${Object.keys(cards).length} cards already built`);
      } else {
        console.log('[variants] existing file has different variant spec — rebuilding');
      }
    } catch { /* corrupt: rebuild */ }
  }

  const flush = () => {
    const tmp = OUT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, artBox: ART_BOX, variants: VARIANTS, cards }), 'utf8');
    fs.renameSync(tmp, OUT_FILE);
  };

  const t0 = Date.now();
  let done = 0, failed = 0, sinceFlush = 0;

  for (const id of ids) {
    if (cards[id]) continue;
    const m = manifest.cards[id];
    const path = join(IMG_DIR, m.set_id, `${String(m.number).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`);
    let buf;
    try { buf = fs.readFileSync(path); } catch { failed++; continue; }

    try {
      const meta = await sharp(buf).metadata();
      const p = [], d = [];
      for (const box of boxes) {
        const crop = await artCrop(buf, meta, box);
        const [ph, dh] = await Promise.all([computePhash(crop), computeDhash(crop)]);
        p.push(ph.toString(16).padStart(16, '0'));
        d.push(dh.toString(16).padStart(16, '0'));
      }
      cards[id] = { set_id: m.set_id, number: m.number, name: m.name, p, d };
    } catch { failed++; continue; }

    done++; sinceFlush++;
    if (sinceFlush >= 1000) {
      flush(); sinceFlush = 0;
      const rate = done / ((Date.now() - t0) / 1000);
      const remaining = ids.length - Object.keys(cards).length;
      console.log(`[variants] ${Object.keys(cards).length}/${ids.length} ` +
                  `(${rate.toFixed(0)}/s, ETA ${(remaining / rate / 60).toFixed(1)} min)`);
    }
  }

  flush();

  console.log(`[variants] done — ${done} cards, ${failed} failed, ` +
              `${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`[variants] wrote ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(err => { console.error('[variants] FATAL:', err); process.exit(1); });
