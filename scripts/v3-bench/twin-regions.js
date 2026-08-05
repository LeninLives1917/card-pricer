#!/usr/bin/env node
// scripts/v3-bench/twin-regions.js
//
// V3 Phase 0 — "which part of the card actually distinguishes a reprint?"
//
// build-descriptors.js showed that reprints sharing artwork (base2-22 Mr. Mime
// vs base4-27 Mr. Mime) land at Hamming distance 0 on every whole-card and
// art-box descriptor. They are the same picture. This script asks the obvious
// follow-up: is there ANY region of the card that separates them, and if so
// where, so that a second-stage crop can disambiguate a top-k candidate set.
//
// It does not guess at card layout. Pass 2 measures, pixel by pixel, where
// twins differ, and prints a heatmap. Pass 3 then scores candidate crop
// regions — including ones derived from what the heatmap shows.
//
// IMPORTANT INTERPRETATION LIMIT: this measures separability between CLEAN CDN
// RENDERS. A region that separates references may still be unreadable in a
// hand-held photo of a sleeved card — a set symbol is ~20x20px here. This
// establishes the ceiling (is the information present at all?), not the
// achievable result (can a phone resolve it?). The second question needs the
// operator's photo set.
//
// Usage:
//   node scripts/v3-bench/twin-regions.js
//   node scripts/v3-bench/twin-regions.js --pairs 400

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const IMG_DIR = join(CACHE_DIR, 'refs');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
const OUT_FILE = join(CACHE_DIR, 'twin-regions.json');

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
}
const MAX_PAIRS = argVal('--pairs', 400);

// Heatmap grid. 24x34 keeps the card's ~0.7 aspect and stays readable as ASCII.
const GW = 24, GH = 34;

// Candidate crop regions, as fractions of the card face {l, t, w, h}.
// ART is the retrieval descriptor and is here as the control — it is expected
// to fail on twins by construction.
const REGIONS = {
  'full-card':      { l: 0.000, t: 0.000, w: 1.000, h: 1.000 },
  'art-box':        { l: 0.085, t: 0.115, w: 0.830, h: 0.420 },
  'bottom-strip':   { l: 0.000, t: 0.880, w: 1.000, h: 0.120 },
  'bottom-left':    { l: 0.030, t: 0.890, w: 0.520, h: 0.100 },
  'bottom-right':   { l: 0.550, t: 0.890, w: 0.420, h: 0.100 },
  'symbol-classic': { l: 0.700, t: 0.510, w: 0.230, h: 0.080 },
  'lower-third':    { l: 0.000, t: 0.660, w: 1.000, h: 0.340 },
};

function splitId(id) {
  const i = id.lastIndexOf('-');
  return { setId: id.slice(0, i), number: id.slice(i + 1) };
}

function pathFor(setId, number) {
  return join(IMG_DIR, setId, `${String(number).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`);
}

// Cheap 64-bit dHash used only to FIND twins (9x8 greyscale column gradients).
// Much faster than the 32x32 DCT pHash and sufficient to bucket exact dupes.
async function fastDhash(buf) {
  const raw = await sharp(buf).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  let hash = 0n, bit = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (raw[r * 9 + c] > raw[r * 9 + c + 1]) hash |= (1n << BigInt(bit));
      bit++;
    }
  }
  return hash;
}

// Mean absolute difference over a normalised greyscale crop, 0..255.
// For regions of only a few hundred pixels a 64-bit hash is mostly noise, so we
// compare pixels directly. Contrast-normalising each crop first stops a global
// brightness or print-run difference from masquerading as a real distinction.
function normalise(raw) {
  let min = 255, max = 0;
  for (const v of raw) { if (v < min) min = v; if (v > max) max = v; }
  const span = Math.max(1, max - min);
  const out = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = ((raw[i] - min) / span) * 255;
  return out;
}

async function regionPixels(buf, meta, reg, w = 32, h = 32) {
  const left = Math.max(0, Math.round(meta.width * reg.l));
  const top = Math.max(0, Math.round(meta.height * reg.t));
  const width = Math.max(1, Math.min(meta.width - left, Math.round(meta.width * reg.w)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(meta.height * reg.h)));
  const raw = await sharp(buf).extract({ left, top, width, height })
    .resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer();
  return normalise(raw);
}

function mad(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

async function main() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error(`[twin-regions] run fetch-refs.js first`); process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const ids = Object.keys(manifest.cards).sort();
  console.log(`[twin-regions] ${ids.length} cached cards`);

  // ---- Pass 1: find exact-duplicate groups -------------------------------
  console.log('[twin-regions] pass 1 — hashing to find twins …');
  const buckets = new Map();
  let done = 0, missing = 0;
  const t0 = Date.now();

  for (const id of ids) {
    const { setId, number } = splitId(id);
    let buf;
    try { buf = fs.readFileSync(pathFor(setId, number)); } catch { missing++; continue; }
    let h;
    try { h = await fastDhash(buf); } catch { missing++; continue; }
    const k = h.toString(16);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
    if (++done % 4000 === 0) {
      console.log(`[twin-regions]   ${done}/${ids.length} (${(done / ((Date.now() - t0) / 1000)).toFixed(0)}/s)`);
    }
  }

  const groups = [...buckets.values()].filter(g => g.length > 1);
  const cardsInGroups = groups.reduce((s, g) => s + g.length, 0);
  console.log(`[twin-regions] pass 1 done — ${groups.length} twin groups covering ${cardsInGroups} cards ` +
              `(${(cardsInGroups / done * 100).toFixed(2)}% of catalogue), ${missing} unreadable`);

  // Cross-set pairs only: two cards from the SAME set sharing a dhash is a
  // different problem (usually energy cards), and not the reprint case.
  const pairs = [];
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = splitId(g[i]), b = splitId(g[j]);
        if (a.setId !== b.setId) pairs.push([g[i], g[j]]);
      }
    }
  }
  console.log(`[twin-regions] ${pairs.length} cross-set twin pairs`);

  const sample = pairs.slice(0, MAX_PAIRS);
  if (!sample.length) { console.log('[twin-regions] no cross-set twins — nothing to analyse'); return; }

  console.log('');
  console.log('[twin-regions] examples:');
  for (const [a, b] of sample.slice(0, 10)) {
    console.log(`  ${a.padEnd(14)} "${manifest.cards[a].name}"  ==  ${b.padEnd(14)} "${manifest.cards[b].name}"`);
  }

  // ---- Pass 2: where do they differ? -------------------------------------
  console.log('');
  console.log(`[twin-regions] pass 2 — difference heatmap over ${sample.length} pairs …`);
  const accum = new Float64Array(GW * GH);
  let counted = 0;

  for (const [ida, idb] of sample) {
    const A = splitId(ida), B = splitId(idb);
    try {
      const [ra, rb] = await Promise.all([
        sharp(fs.readFileSync(pathFor(A.setId, A.number))).resize(GW, GH, { fit: 'fill' }).greyscale().raw().toBuffer(),
        sharp(fs.readFileSync(pathFor(B.setId, B.number))).resize(GW, GH, { fit: 'fill' }).greyscale().raw().toBuffer(),
      ]);
      const na = normalise(ra), nb = normalise(rb);
      for (let i = 0; i < accum.length; i++) accum[i] += Math.abs(na[i] - nb[i]);
      counted++;
    } catch { /* skip */ }
  }

  for (let i = 0; i < accum.length; i++) accum[i] /= Math.max(1, counted);
  const peak = Math.max(...accum);
  const RAMP = ' .:-=+*#%@';

  console.log(`[twin-regions] mean |difference| per cell across ${counted} pairs (peak ${peak.toFixed(1)}/255):`);
  console.log('   +' + '-'.repeat(GW) + '+');
  for (let r = 0; r < GH; r++) {
    let line = '';
    for (let c = 0; c < GW; c++) {
      const v = accum[r * GW + c] / (peak || 1);
      line += RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))];
    }
    console.log(`${String(Math.round(r / GH * 100)).padStart(3)}|${line}|`);
  }
  console.log('   +' + '-'.repeat(GW) + '+');
  console.log('   (left column = % down the card face)');

  // ---- Pass 3: score candidate regions -----------------------------------
  console.log('');
  console.log(`[twin-regions] pass 3 — separation per candidate region …`);
  console.log('');
  console.log('region           meanMAD  medMAD  minMAD  %pairs<2  %pairs<5');
  console.log('---------------  -------  ------  ------  --------  --------');

  const results = {};
  for (const [name, reg] of Object.entries(REGIONS)) {
    const scores = [];
    for (const [ida, idb] of sample) {
      const A = splitId(ida), B = splitId(idb);
      try {
        const ba = fs.readFileSync(pathFor(A.setId, A.number));
        const bb = fs.readFileSync(pathFor(B.setId, B.number));
        const [ma, mb] = await Promise.all([sharp(ba).metadata(), sharp(bb).metadata()]);
        const [pa, pb] = await Promise.all([regionPixels(ba, ma, reg), regionPixels(bb, mb, reg)]);
        scores.push(mad(pa, pb));
      } catch { /* skip */ }
    }
    if (!scores.length) continue;
    scores.sort((x, y) => x - y);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const med = scores[Math.floor(scores.length / 2)];
    const under = t => (scores.filter(v => v < t).length / scores.length * 100);
    results[name] = {
      meanMAD: +mean.toFixed(2), medianMAD: +med.toFixed(2), minMAD: +scores[0].toFixed(2),
      pctUnder2: +under(2).toFixed(1), pctUnder5: +under(5).toFixed(1), pairs: scores.length,
    };
    console.log(
      `${name.padEnd(15)}  ${mean.toFixed(2).padStart(7)}  ${med.toFixed(2).padStart(6)}  ` +
      `${scores[0].toFixed(2).padStart(6)}  ${under(2).toFixed(1).padStart(8)}  ${under(5).toFixed(1).padStart(8)}`
    );
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    twinGroups: groups.length, cardsInGroups, crossSetPairs: pairs.length,
    analysed: counted, regions: results,
    heatmap: { w: GW, h: GH, values: [...accum].map(v => +v.toFixed(2)) },
    examples: sample.slice(0, 40).map(([a, b]) => ({ a, b, name: manifest.cards[a].name })),
  }, null, 2), 'utf8');

  console.log('');
  console.log(`[twin-regions] wrote ${OUT_FILE}`);
  console.log('[twin-regions] higher MAD = better separation. %pairs<2 is the share of');
  console.log('[twin-regions] twin pairs that region STILL cannot tell apart.');
}

main().catch(err => { console.error('[twin-regions] FATAL:', err); process.exit(1); });
