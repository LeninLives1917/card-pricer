#!/usr/bin/env node
// scripts/v3-bench/build-descriptors.js
//
// V3 Phase 0 — descriptor construction + intrinsic separability measurement.
//
// Reads the cached reference images written by fetch-refs.js and computes each
// candidate descriptor family over the whole catalogue. Then measures how well
// each family separates DIFFERENT CARDS FROM EACH OTHER.
//
// Why that measurement matters, and why it comes first:
//   Top-1 accuracy on real photographs needs the operator's photo set. But the
//   ceiling on achievable accuracy does not. If two different cards land 4 bits
//   apart in the index, then no confidence threshold can distinguish "correct
//   match at distance 4" from "wrong card at distance 4" — the photo quality is
//   irrelevant, the descriptor simply cannot represent the difference. So we
//   can falsify a descriptor family before a single photo is taken, and we can
//   size the confidence threshold we'd actually be able to ship.
//
// Families measured:
//   full-phash / full-dhash / full-whash   whole card, as production does today
//   art-phash  / art-dhash  / art-whash    artwork window only, border+text cropped
//
// Usage:
//   node scripts/v3-bench/build-descriptors.js
//   node scripts/v3-bench/build-descriptors.js --limit 2000
//
// Env:
//   V3_CACHE_DIR   cache root (default ~/.card-pricer-v3)

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

import { computePhash, computeDhash, computeWhash } from '../../pricing/phash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const IMG_DIR = join(CACHE_DIR, 'refs');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
const OUT_FILE = join(CACHE_DIR, 'descriptors.json');
const REPORT_FILE = join(CACHE_DIR, 'separability.json');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : Number(process.argv[i + 1]);
}
const LIMIT = argVal('--limit');

// Artwork window as a fraction of the card face, for the classic Pokémon
// layout: below the name bar, above the attack text. Deliberately conservative
// — a slightly tight crop is safer than one that catches the text box, because
// the text box is where near-identical reprints look most alike.
//
// Modern full-art / alt-art cards bleed art to the edges and this window will
// simply sample their centre. That is a real limitation and one of the things
// this measurement is meant to expose, not hide.
const ART_BOX = { left: 0.085, top: 0.115, width: 0.830, height: 0.420 };

// Stage-2 disambiguation region. twin-regions.js measured this empirically:
// across 144 cross-set reprint pairs, the bottom-right corner (card number +
// set total) separated 4.4× better than the whole card, and cut the share of
// still-inseparable pairs from 75% to 14.6%. It beat a hand-placed set-symbol
// box, because symbol position moves too much across eras to hard-code.
const BR_BOX = { left: 0.550, top: 0.890, width: 0.420, height: 0.100 };

// The stage-2 descriptor is NOT a 64-bit hash. A hash of a ~100x34 region is
// mostly noise; what we need is the fine detail a hash throws away. So we keep
// a small contrast-normalised greyscale signature and compare it by L1
// distance. 16x16 uint8 = 256 bytes/card → ~5 MB across the catalogue, which
// is affordable to ship alongside the retrieval index.
const BR_W = 16, BR_H = 16;

async function cropArt(buf, w, h) {
  const left = Math.round(w * ART_BOX.left);
  const top = Math.round(h * ART_BOX.top);
  const width = Math.round(w * ART_BOX.width);
  const height = Math.round(h * ART_BOX.height);
  return sharp(buf).extract({ left, top, width, height })
    .resize(245, 342, { fit: 'fill' }).toBuffer();
}

/**
 * Contrast-normalised bottom-right signature. Normalising per-crop means a
 * global brightness or print-run difference cannot masquerade as a genuine
 * distinction between two cards.
 */
async function brSignature(buf, w, h) {
  const left = Math.round(w * BR_BOX.left);
  const top = Math.round(h * BR_BOX.top);
  const width = Math.max(1, Math.min(w - left, Math.round(w * BR_BOX.width)));
  const height = Math.max(1, Math.min(h - top, Math.round(h * BR_BOX.height)));
  const raw = await sharp(buf).extract({ left, top, width, height })
    .resize(BR_W, BR_H, { fit: 'fill' }).greyscale().raw().toBuffer();

  let min = 255, max = 0;
  for (const v of raw) { if (v < min) min = v; if (v > max) max = v; }
  const span = Math.max(1, max - min);
  const out = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = Math.round(((raw[i] - min) / span) * 255);
  return out;
}

/** Mean absolute difference between two uint8 signatures, 0..255. */
export function sigDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// -----------------------------------------------------------------------------
// bit helpers — descriptors are stored as BigInt, packed to hex for output
// -----------------------------------------------------------------------------

function popcount64(x) {
  let n = 0;
  while (x !== 0n) { x &= x - 1n; n++; }
  return n;
}

// -----------------------------------------------------------------------------
// separability
// -----------------------------------------------------------------------------

/**
 * For a descriptor family, measure:
 *   - exact collisions: distinct cards sharing an identical descriptor. These
 *     are unrecoverable — the index physically cannot tell them apart, and the
 *     production Map-keyed-by-hash silently drops one of them.
 *   - nearest-neighbour distance distribution: for a sample of cards, the
 *     Hamming distance to the CLOSEST OTHER card. This is the margin a photo
 *     has to beat. If the 5th percentile of this distribution is ~6 bits, then
 *     a match threshold of 6 will produce wrong answers at scale no matter how
 *     good the camera is.
 */
function measureSeparability(entries, sampleSize = 1500) {
  const n = entries.length;

  // exact collisions
  const byHash = new Map();
  for (const e of entries) {
    const k = e.hash;
    if (!byHash.has(k)) byHash.set(k, []);
    byHash.get(k).push(e.id);
  }
  const collisionGroups = [...byHash.values()].filter(g => g.length > 1);
  const collidingCards = collisionGroups.reduce((s, g) => s + g.length, 0);

  // nearest-neighbour margin over a deterministic stride sample
  const stride = Math.max(1, Math.floor(n / sampleSize));
  const nnDist = [];
  const nnPairs = [];
  for (let i = 0; i < n; i += stride) {
    const a = entries[i];
    let best = 65, bestId = null;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = popcount64(a.hash ^ entries[j].hash);
      if (d < best) { best = d; bestId = entries[j].id; if (d === 0) break; }
    }
    nnDist.push(best);
    nnPairs.push({ card: a.id, nearest: bestId, distance: best });
  }

  nnDist.sort((x, y) => x - y);
  const pct = p => nnDist[Math.min(nnDist.length - 1, Math.floor(nnDist.length * p))];

  return {
    cards: n,
    distinctDescriptors: byHash.size,
    collisionGroups: collisionGroups.length,
    collidingCards,
    collisionRate: +(collidingCards / n).toFixed(4),
    nnSampled: nnDist.length,
    nnMin: nnDist[0],
    nnP01: pct(0.01),
    nnP05: pct(0.05),
    nnP25: pct(0.25),
    nnMedian: pct(0.50),
    worstPairs: nnPairs.sort((a, b) => a.distance - b.distance).slice(0, 12),
  };
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error(`[descriptors] manifest not found at ${MANIFEST_FILE}`);
    console.error(`[descriptors] run: node scripts/v3-bench/fetch-refs.js`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  let ids = Object.keys(manifest.cards).sort();
  if (LIMIT) ids = ids.slice(0, LIMIT);

  console.log(`[descriptors] ${ids.length} cards from ${CACHE_DIR}`);

  const families = {
    'full-phash': [], 'full-dhash': [], 'full-whash': [],
    'art-phash': [], 'art-dhash': [], 'art-whash': [],
  };
  const perCard = {};

  const startMs = Date.now();
  let done = 0, failed = 0;

  for (const id of ids) {
    const m = manifest.cards[id];
    const safeNumber = String(m.number).replace(/[^A-Za-z0-9_-]/g, '_');
    const path = join(IMG_DIR, m.set_id, `${safeNumber}.webp`);
    let buf;
    try { buf = fs.readFileSync(path); } catch { failed++; continue; }

    try {
      const meta = await sharp(buf).metadata();
      const artBuf = await cropArt(buf, meta.width, meta.height);
      const brSig = await brSignature(buf, meta.width, meta.height);

      const [fp, fd, fw, ap, ad, aw] = await Promise.all([
        computePhash(buf), computeDhash(buf), computeWhash(buf),
        computePhash(artBuf), computeDhash(artBuf), computeWhash(artBuf),
      ]);

      families['full-phash'].push({ id, hash: fp });
      families['full-dhash'].push({ id, hash: fd });
      families['full-whash'].push({ id, hash: fw });
      families['art-phash'].push({ id, hash: ap });
      families['art-dhash'].push({ id, hash: ad });
      families['art-whash'].push({ id, hash: aw });

      perCard[id] = {
        set_id: m.set_id, number: m.number, name: m.name,
        full: { p: fp.toString(16), d: fd.toString(16), w: fw.toString(16) },
        art: { p: ap.toString(16), d: ad.toString(16), w: aw.toString(16) },
        br: brSig.toString('base64'),
      };
    } catch (err) {
      failed++; continue;
    }

    if (++done % 2000 === 0) {
      const rate = done / ((Date.now() - startMs) / 1000);
      console.log(`[descriptors] ${done}/${ids.length} (${rate.toFixed(0)}/s)`);
    }
  }

  console.log(`[descriptors] computed ${done}, failed ${failed}, in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({ version: 1, artBox: ART_BOX, cards: perCard }), 'utf8');
  console.log(`[descriptors] wrote ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1)} MB)`);

  // ---- separability -------------------------------------------------------
  console.log('');
  console.log('[descriptors] ============ intrinsic separability ============');
  console.log('[descriptors] "nn" = Hamming distance from a card to the CLOSEST OTHER card.');
  console.log('[descriptors] A photo must match its true card more tightly than this to be safe.');
  console.log('');
  console.log('family        cards  distinct  collide  rate    nnMin  p01  p05  p25  med');
  console.log('------------  -----  --------  -------  ------  -----  ---  ---  ---  ---');

  const report = {};
  for (const [name, entries] of Object.entries(families)) {
    const r = measureSeparability(entries);
    report[name] = r;
    console.log(
      `${name.padEnd(12)}  ${String(r.cards).padStart(5)}  ${String(r.distinctDescriptors).padStart(8)}  ` +
      `${String(r.collidingCards).padStart(7)}  ${r.collisionRate.toFixed(4)}  ` +
      `${String(r.nnMin).padStart(5)}  ${String(r.nnP01).padStart(3)}  ${String(r.nnP05).padStart(3)}  ` +
      `${String(r.nnP25).padStart(3)}  ${String(r.nnMedian).padStart(3)}`
    );
  }

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log(`[descriptors] wrote ${REPORT_FILE}`);

  // Surface the worst offenders for the best full-card family — these are the
  // pairs the shipped system will confuse, named, so they can be eyeballed.
  const worst = report['full-phash'].worstPairs.slice(0, 8);
  console.log('');
  console.log('[descriptors] closest confusable pairs (full-phash):');
  for (const p of worst) {
    const a = perCard[p.card], b = perCard[p.nearest];
    if (!a || !b) continue;
    console.log(`  d=${String(p.distance).padStart(2)}  ${p.card} "${a.name}"  vs  ${p.nearest} "${b.name}"`);
  }
}

main().catch(err => { console.error('[descriptors] FATAL:', err); process.exit(1); });
