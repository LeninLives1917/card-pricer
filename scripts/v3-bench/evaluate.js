#!/usr/bin/env node
// scripts/v3-bench/evaluate.js
//
// V3 Phase 0 — two-stage retrieval evaluation.
//
//   Stage 1  art-box hash ensemble (pHash + dHash + wHash, summed Hamming)
//            over the whole catalogue  ->  top-k candidates
//   Stage 2  bottom-right signature (card number + set total, L1 distance)
//            re-ranks the candidates   ->  final answer
//
// Two query modes:
//
//   --synthetic N   Augment N cached reference images to imitate a photo
//                   (tilt, rotation, brightness, blur, glare, JPEG, framing).
//                   PROVISIONAL ONLY. The query is derived from the very image
//                   in the index, so this measures robustness to the specific
//                   distortions I chose to simulate. It is an UPPER BOUND and
//                   it cannot clear the Phase 0 evidence gate. Its purpose is
//                   to rank descriptor families and tune the pipeline while we
//                   wait for real photographs.
//
//   --photos        The operator's real photographs, labelled by filename
//                   (docs/V3_BENCHMARK_PHOTOS.md). THIS is the gate result.
//
// Usage:
//   node scripts/v3-bench/evaluate.js --synthetic 400
//   node scripts/v3-bench/evaluate.js --photos
//
// Implementation note: hashes are bit-packed into paired Uint32Arrays with a
// 16-bit popcount table rather than held as BigInt. Production's
// pricing/phash.js does a linear BigInt scan, which at full index size is
// ~60k BigInt XOR+popcounts per query — far too slow for a browser running at
// video frame rate. This is the shape B2 will need.

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename, extname } from 'path';
import sharp from 'sharp';

import { computePhash, computeDhash, computeWhash, cropToCard } from '../../pricing/phash.js';
import { rectify } from './rectify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const IMG_DIR = join(CACHE_DIR, 'refs');
const DESC_FILE = join(CACHE_DIR, 'descriptors.json');
const VAR_FILE  = join(CACHE_DIR, 'variants.json');
// Must mirror build-embeddings.js: index and query have to share the same
// photometric treatment or every comparison is against a differently-processed
// reference.
const EMB_NORMALISE = process.env.EMB_NORMALISE === '1';
const EMB_FILE  = join(CACHE_DIR, EMB_NORMALISE ? 'embeddings-norm.json' : 'embeddings.json');
const PHOTO_DIR = join(CACHE_DIR, 'photos');
const OUT_FILE = join(CACHE_DIR, 'evaluation.json');

const ART_BOX = { left: 0.085, top: 0.115, width: 0.830, height: 0.420 };
const BR_BOX = { left: 0.550, top: 0.890, width: 0.420, height: 0.100 };
const BR_W = 16, BR_H = 16;
const TOP_K = 10;
// Stage-1 distance gap (summed Hamming over 3 hashes) within which two
// candidates count as tied and stage 2 is allowed to arbitrate.
const AMBIG_MARGIN = Number(process.env.AMBIG_MARGIN ?? 2);
const EMB_AMBIG_COS = Number(process.env.EMB_AMBIG_COS ?? 0.02);

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
}
const USE_PHOTOS = process.argv.includes('--photos');
const N_SYNTH = argVal('--synthetic', 400);
// Ablation switches. --no-aug feeds the clean reference straight back in, which
// SHOULD score 100% top-1; anything less is loss introduced by our own
// normalisation path rather than by the descriptor or the query.
const NO_AUG = process.argv.includes('--no-aug');
const NO_CROP = process.argv.includes('--no-crop');
const AUG_MODE = process.argv.includes('--geo-only') ? 'geo'
               : process.argv.includes('--photo-only') ? 'photo' : 'all';
// Normalisation strategy: 'trim' is production's cropToCard, 'rectify' is
// OpenCV quad detection + perspective warp, 'none' is a bare resize.
const NORM = NO_CROP ? 'none'
           : process.argv.includes('--rectify') ? 'rectify' : 'trim';
let detectHits = 0, detectMiss = 0;
// --variants matches against the framing-variant index (build-variants.js):
// several art-box framings per card, best-of. Absorbs the residual offset
// between the index's convention and what rectification produces (§5.2).
const USE_VARIANTS = process.argv.includes('--variants');
// --embeddings [cls|mean] swaps stage 1 from the hash ensemble to DINOv2
// global embeddings (approach (b)). Stage 2 is unchanged.
const EMB_I = process.argv.indexOf('--embeddings');
const EMB_MODE = EMB_I === -1 ? null
  : (['cls', 'mean'].includes(process.argv[EMB_I + 1]) ? process.argv[EMB_I + 1] : 'cls');

// -----------------------------------------------------------------------------
// bit-packed hamming
// -----------------------------------------------------------------------------

const POPCNT16 = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) POPCNT16[i] = (i & 1) + POPCNT16[i >> 1];

function popcount32(x) {
  return POPCNT16[x & 0xffff] + POPCNT16[(x >>> 16) & 0xffff];
}

function hexToPair(hex) {
  const v = BigInt('0x' + hex);
  return [Number(v & 0xffffffffn) >>> 0, Number((v >> 32n) & 0xffffffffn) >>> 0];
}

// -----------------------------------------------------------------------------
// query descriptors
// -----------------------------------------------------------------------------

async function cropBox(buf, meta, box, w, h) {
  const left = Math.max(0, Math.round(meta.width * box.left));
  const top = Math.max(0, Math.round(meta.height * box.top));
  const width = Math.max(1, Math.min(meta.width - left, Math.round(meta.width * box.width)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(meta.height * box.height)));
  let p = sharp(buf).extract({ left, top, width, height });
  if (w) p = p.resize(w, h, { fit: 'fill' });
  return p.toBuffer();
}

async function brSignature(buf, meta) {
  const left = Math.max(0, Math.round(meta.width * BR_BOX.left));
  const top = Math.max(0, Math.round(meta.height * BR_BOX.top));
  const width = Math.max(1, Math.min(meta.width - left, Math.round(meta.width * BR_BOX.width)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(meta.height * BR_BOX.height)));
  const raw = await sharp(buf).extract({ left, top, width, height })
    .resize(BR_W, BR_H, { fit: 'fill' }).greyscale().raw().toBuffer();
  let min = 255, max = 0;
  for (const v of raw) { if (v < min) min = v; if (v > max) max = v; }
  const span = Math.max(1, max - min);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = Math.round(((raw[i] - min) / span) * 255);
  return out;
}

/**
 * Normalise a query to a 245x342 card face.
 *
 * needsCrop is true for BOTH real photographs and synthetic queries: the
 * augmentation rotates and shears, which leaves background fill around the
 * card, so an augmented render needs exactly the same boundary detection a
 * phone photo does. Skipping it hashes the padding along with the card and
 * depresses the result for reasons that have nothing to do with the descriptor.
 */
async function normaliseCard(buf, needsCrop) {
  if (!needsCrop || NORM === 'none') {
    return sharp(buf).resize(245, 342, { fit: 'fill' }).toBuffer();
  }
  if (NORM === 'rectify') {
    const { buffer, detected } = await rectify(buf);
    if (detected) detectHits++; else detectMiss++;
    return sharp(buffer).resize(245, 342, { fit: 'fill' }).toBuffer();
  }
  const cropped = await cropToCard(buf);
  return sharp(cropped).resize(245, 342, { fit: 'fill' }).toBuffer();
}

async function queryDescriptors(buf, needsCrop) {
  const face = await normaliseCard(buf, needsCrop);
  const meta = await sharp(face).metadata();
  const art = await cropBox(face, meta, ART_BOX, 245, 342);
  const [p, d, w] = await Promise.all([computePhash(art), computeDhash(art), computeWhash(art)]);
  const br = await brSignature(face, meta);
  const emb = EMB_MODE ? await embedFace(face) : null;
  return { p, d, w, br, emb };
}

// -----------------------------------------------------------------------------
// embedding query path (approach (b))
// -----------------------------------------------------------------------------

let _fe = null;
async function embedder() {
  if (_fe) return _fe;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(CACHE_DIR, 'models');
  const emb = JSON.parse(fs.readFileSync(EMB_FILE, 'utf8'));
  _fe = { fn: await pipeline('image-feature-extraction', emb.model, { dtype: emb.dtype }) };
  return _fe;
}

/** Embed an already-normalised 245x342 card face, returning an Int8Array. */
async function embedFace(faceBuf) {
  const { RawImage } = await import('@huggingface/transformers');
  const { poolTokens, quantise } = await import('./build-embeddings.js');
  const { fn } = await embedder();
  let pipe = sharp(faceBuf).removeAlpha();
  if (EMB_NORMALISE) pipe = pipe.normalise();
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  const out = await fn(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3));
  const pooled = poolTokens(out.data, out.dims);
  const q = quantise(pooled[EMB_MODE]);
  const v = new Int8Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = q[i] - 128;
  return v;
}

// -----------------------------------------------------------------------------
// synthetic augmentation
// -----------------------------------------------------------------------------

// Deterministic PRNG so runs are reproducible and comparable across changes.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Imitate a hand-held capture. sharp has no homography, so tilt is approximated
 * with an affine shear + rotation — that captures most of the effect of holding
 * a card off-axis but understates true perspective foreshortening. Another
 * reason these numbers are an upper bound.
 */
async function augment(buf, rnd, mode = 'all') {
  const geo = mode === 'all' || mode === 'geo';
  const photo = mode === 'all' || mode === 'photo';
  const jitter = (lo, hi) => lo + rnd() * (hi - lo);
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;

  const shear = geo ? jitter(-0.10, 0.10) : 0;
  const scale = geo ? jitter(0.94, 1.06) : 1;
  const angle = geo ? jitter(-6, 6) : 0;

  let img = sharp(buf);
  if (geo) {
    img = img
      .affine([[scale, shear], [shear * 0.4, scale]], { background: '#202020' })
      .rotate(angle, { background: '#202020' });
  }
  if (photo) {
    img = img
      .modulate({ brightness: jitter(0.80, 1.20), saturation: jitter(0.88, 1.12) })
      .blur(jitter(0.3, 1.4));
  }

  // Glare: a soft bright band screened over the upper card, as a sleeve or holo
  // would throw under hall lighting.
  if (photo && rnd() < 0.5) {
    const gw = Math.round(W * jitter(0.3, 0.7));
    const gh = Math.round(H * jitter(0.15, 0.4));
    const glare = await sharp({
      create: { width: gw, height: gh, channels: 3, background: '#ffffff' },
    }).blur(Math.max(1, gw / 6)).png().toBuffer();
    img = sharp(await img.png().toBuffer()).composite([{
      input: glare, blend: 'screen',
      left: Math.round(rnd() * Math.max(1, W - gw)),
      top: Math.round(rnd() * Math.max(1, H * 0.6)),
    }]);
  }

  // Place the card on a background, as any real capture has it. Earlier
  // revisions cropped INTO the card to simulate framing error, which meant the
  // card frequently had no four corners in frame — unrealistic for bulk
  // scanning, and it starved quad detection of the thing it looks for.
  // Partial occlusion is a deliberate, separate bucket in the photo set
  // (docs/V3_BENCHMARK_PHOTOS.md), not the default case.
  const card = await img.png().toBuffer();
  const cm = await sharp(card).metadata();

  let out = card;
  if (geo) {
    const pad = jitter(1.10, 1.45);
    const BW = Math.round(cm.width * pad), BH = Math.round(cm.height * pad);

    // Textured background: uniform fill would let a .trim() heuristic succeed
    // for the wrong reason and would flatter the baseline we are measuring
    // against. Low-res noise upscaled gives a cloth/table-like surface.
    const NS = 24;
    const noise = Buffer.alloc(NS * NS * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = 40 + Math.floor(rnd() * 70);
    const bg = await sharp(noise, { raw: { width: NS, height: NS, channels: 3 } })
      .resize(BW, BH, { fit: 'fill' }).blur(4).png().toBuffer();

    out = await sharp(bg).composite([{
      input: card,
      left: Math.round(rnd() * (BW - cm.width)),
      top: Math.round(rnd() * (BH - cm.height)),
    }]).png().toBuffer();
  }

  return sharp(out).jpeg({ quality: Math.round(jitter(58, 88)) }).toBuffer();
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(DESC_FILE)) {
    console.error('[evaluate] descriptors.json not found — run build-descriptors.js first');
    process.exit(1);
  }
  console.log('[evaluate] loading index …');
  const desc = JSON.parse(fs.readFileSync(DESC_FILE, 'utf8'));
  const ids = Object.keys(desc.cards);
  const N = ids.length;
  const SIG = BR_W * BR_H;

  // Stage-2 signatures and display names are always keyed per CARD.
  const brAll = new Uint8Array(N * SIG);
  const nameOf = new Array(N);
  ids.forEach((id, i) => {
    const c = desc.cards[id];
    if (c.br) brAll.set(Buffer.from(c.br, 'base64'), i * SIG);
    nameOf[i] = c.name;
  });

  // Stage-1 entries may be per-card or per-(card, framing variant). cardOf maps
  // an entry back to its card so several entries can vote for one answer.
  let pLo, pHi, dLo, dHi, wLo, wHi, cardOf, E, useW;

  let embAll = null, EMB_D = 0;
  if (EMB_MODE) {
    if (!fs.existsSync(EMB_FILE)) {
      console.error('[evaluate] embeddings.json not found — run build-embeddings.js');
      process.exit(1);
    }
    const emb = JSON.parse(fs.readFileSync(EMB_FILE, 'utf8'));
    EMB_D = emb.dims;
    embAll = new Int8Array(N * EMB_D);
    let miss = 0;
    ids.forEach((id, i) => {
      const c = emb.cards[id];
      if (!c) { miss++; return; }
      const b = Buffer.from(c[EMB_MODE], 'base64');
      for (let k = 0; k < EMB_D; k++) embAll[i * EMB_D + k] = b[k] - 128;
    });
    console.log(`[evaluate] ${N} cards | embeddings ${emb.model} ${EMB_MODE} d=${EMB_D}` +
                (miss ? ` | ${miss} MISSING from embedding index` : ''));
  }

  if (USE_VARIANTS) {
    if (!fs.existsSync(VAR_FILE)) {
      console.error('[evaluate] variants.json not found — run build-variants.js');
      process.exit(1);
    }
    const vr = JSON.parse(fs.readFileSync(VAR_FILE, 'utf8'));
    const idx = new Map(ids.map((id, i) => [id, i]));
    const entries = [];
    for (const [id, c] of Object.entries(vr.cards)) {
      const ci = idx.get(id);
      if (ci === undefined) continue;
      for (let v = 0; v < c.p.length; v++) entries.push({ ci, p: c.p[v], d: c.d[v] });
    }
    E = entries.length;
    pLo = new Uint32Array(E); pHi = new Uint32Array(E);
    dLo = new Uint32Array(E); dHi = new Uint32Array(E);
    cardOf = new Int32Array(E);
    entries.forEach((e, i) => {
      [pLo[i], pHi[i]] = hexToPair(e.p);
      [dLo[i], dHi[i]] = hexToPair(e.d);
      cardOf[i] = e.ci;
    });
    useW = false;
    console.log(`[evaluate] ${N} cards / ${E} entries (${vr.variants.length} framing variants), wHash dropped`);
  } else {
    E = N;
    pLo = new Uint32Array(E); pHi = new Uint32Array(E);
    dLo = new Uint32Array(E); dHi = new Uint32Array(E);
    wLo = new Uint32Array(E); wHi = new Uint32Array(E);
    cardOf = new Int32Array(E);
    ids.forEach((id, i) => {
      const c = desc.cards[id];
      [pLo[i], pHi[i]] = hexToPair(c.art.p);
      [dLo[i], dHi[i]] = hexToPair(c.art.d);
      [wLo[i], wHi[i]] = hexToPair(c.art.w);
      cardOf[i] = i;
    });
    useW = true;
    console.log(`[evaluate] ${N} cards indexed`);
  }

  // ---- build query list ---------------------------------------------------
  const queries = [];
  if (USE_PHOTOS) {
    if (!fs.existsSync(PHOTO_DIR)) {
      console.error(`[evaluate] no photo dir at ${PHOTO_DIR}`); process.exit(1);
    }
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name))
        : ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(e.name).toLowerCase()) ? [join(dir, e.name)] : []);
    const files = walk(PHOTO_DIR);
    const byLower = new Map(ids.map(id => [id.toLowerCase(), id]));
    for (const f of files) {
      const stem = basename(f, extname(f));
      const us = stem.indexOf('_');
      const label = byLower.get((us === -1 ? stem : stem.slice(0, us)).toLowerCase());
      if (label) queries.push({ file: f, truth: label, variant: us === -1 ? null : stem.slice(us + 1) });
    }
    console.log(`[evaluate] ${queries.length} labelled photographs`);
    if (!queries.length) { console.error('[evaluate] no resolvable labels — run validate-photos.js'); process.exit(1); }
  } else {
    const stride = Math.max(1, Math.floor(N / N_SYNTH));
    for (let i = 0; i < N && queries.length < N_SYNTH; i += stride) {
      const id = ids[i];
      const c = desc.cards[id];
      const p = join(IMG_DIR, c.set_id, `${String(c.number).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`);
      if (fs.existsSync(p)) queries.push({ file: p, truth: id, variant: 'synthetic' });
    }
    console.log(`[evaluate] ${queries.length} synthetic queries`);
    console.log('[evaluate] *** PROVISIONAL — synthetic augmentation, upper bound only ***');
  }

  // ---- evaluate -----------------------------------------------------------
  const rnd = mulberry32(0x5EED1234);
  const perCardScratch = new Uint16Array(N);
  const idxOf = new Map(ids.map((id, i) => [id, i]));
  const stats = {
    n: 0, s1top1: 0, s1top5: 0, s1topK: 0, s2top1: 0,
    s2fixed: 0, s2broke: 0, latency: [],
  };
  const failures = [];

  for (const q of queries) {
    let buf;
    try {
      buf = fs.readFileSync(q.file);
      if (!USE_PHOTOS && !NO_AUG) buf = await augment(buf, rnd, AUG_MODE);
    } catch { continue; }

    let qd;
    const t0 = process.hrtime.bigint();
    // Photos have background; augmented renders have rotation fill. Both need
    // boundary detection. A clean unaugmented reference does not.
    // Normalise whenever a strategy is selected. Previously this skipped
    // normalisation for unaugmented input, which silently made
    // "--no-aug --rectify" a no-op and reported 0/0 detections.
    const needsCrop = NORM !== 'none';
    try { qd = await queryDescriptors(buf, needsCrop); } catch { continue; }

    const [qpLo, qpHi] = hexToPair(qd.p.toString(16).padStart(16, '0'));
    const [qdLo, qdHi] = hexToPair(qd.d.toString(16).padStart(16, '0'));
    const [qwLo, qwHi] = hexToPair(qd.w.toString(16).padStart(16, '0'));

    // Stage 1 — summed Hamming across the art-box hashes.
    //
    // With a framing-variant index each card contributes several entries. A card
    // scores its BEST variant: the variants are alternative framings of the same
    // artwork, so the question is "does any framing match?", not "do all". Best
    // distance per card is tracked in a scratch array to avoid a second pass.
    let best;
    if (EMB_MODE) {
      // Cosine similarity over L2-normalised int8 vectors: the dot product
      // preserves the float ranking, so no dequantisation is needed. Converted
      // to a pseudo-distance so the rest of the pipeline is unchanged.
      const scored = new Array(N);
      for (let ci = 0; ci < N; ci++) {
        let dot = 0;
        const off = ci * EMB_D;
        for (let k = 0; k < EMB_D; k++) dot += embAll[off + k] * qd.emb[k];
        scored[ci] = { i: ci, d: -dot };
      }
      scored.sort((a, b) => a.d - b.d);
      best = scored.slice(0, TOP_K);
    } else {
    const bestPerCard = perCardScratch;
    bestPerCard.fill(255);
    for (let i = 0; i < E; i++) {
      let dist =
        popcount32(pLo[i] ^ qpLo) + popcount32(pHi[i] ^ qpHi) +
        popcount32(dLo[i] ^ qdLo) + popcount32(dHi[i] ^ qdHi);
      if (useW) {
        dist += popcount32(wLo[i] ^ qwLo) + popcount32(wHi[i] ^ qwHi);
      }
      const ci = cardOf[i];
      if (dist < bestPerCard[ci]) bestPerCard[ci] = dist;
    }

    best = new Array(TOP_K).fill(null).map(() => ({ i: -1, d: 999 }));
    for (let ci = 0; ci < N; ci++) {
      const dist = bestPerCard[ci];
      if (dist < best[TOP_K - 1].d) {
        let j = TOP_K - 1;
        while (j > 0 && best[j - 1].d > dist) { best[j] = best[j - 1]; j--; }
        best[j] = { i: ci, d: dist };
      }
    }
    best = best.filter(b => b.i >= 0 && b.d < 255);
    }

    // Stage 2 — bottom-right re-rank, but ONLY among candidates stage 1 could
    // not separate.
    //
    // Applying it to every query is strictly harmful: measured at full scale it
    // fixed 9 queries and broke 74. The bottom-right region is small and its
    // content depends on precise framing, so on a distorted query it is far
    // noisier than the art-box ensemble. It carries real information only when
    // stage 1 has genuinely tied — the reprint-twin case it was built for.
    //
    // So: re-rank only the candidates within AMBIG_MARGIN of the best stage-1
    // distance, and leave everything else in stage-1 order.
    const withBr = best.map(b => {
      let s = 0;
      const off = b.i * SIG;
      for (let k = 0; k < SIG; k++) s += Math.abs(brAll[off + k] - qd.br[k]);
      return { ...b, br: s / SIG };
    });
    const d0 = withBr.length ? withBr[0].d : 0;
    // The tie margin has to be in the units of whatever stage 1 produced.
    // AMBIG_MARGIN is Hamming bits; for embeddings the score is a negated int8
    // dot product, so the equivalent margin is a cosine delta scaled by 127^2
    // (the maximum magnitude of a component product for unit vectors).
    // Measured: reprint twins sit at 0.95-0.99 cosine to each other, so a 0.02
    // window catches genuine ties without dragging in unrelated candidates.
    const margin = EMB_MODE ? EMB_AMBIG_COS * 127 * 127 : AMBIG_MARGIN;
    const tied = withBr.filter(b => b.d - d0 <= margin);
    const rest = withBr.filter(b => b.d - d0 > margin);
    const reranked = tied.length > 1
      ? [...tied.sort((a, b) => a.br - b.br), ...rest]
      : withBr;

    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
    stats.latency.push(elapsed);

    const truthIdx = idxOf.get(q.truth);
    const s1rank = best.findIndex(b => b.i === truthIdx);
    const s2rank = reranked.findIndex(b => b.i === truthIdx);

    stats.n++;
    if (s1rank === 0) stats.s1top1++;
    if (s1rank >= 0 && s1rank < 5) stats.s1top5++;
    if (s1rank >= 0) stats.s1topK++;
    if (s2rank === 0) stats.s2top1++;
    if (s1rank !== 0 && s2rank === 0) stats.s2fixed++;
    if (s1rank === 0 && s2rank !== 0) stats.s2broke++;

    if (s2rank !== 0 && failures.length < 30) {
      const got = reranked[0];
      failures.push({
        query: basename(q.file), truth: q.truth, truthName: nameOf[truthIdx],
        got: got ? ids[got.i] : null, gotName: got ? nameOf[got.i] : null,
        s1rank, s2rank, s1dist: got ? got.d : null,
      });
    }
  }

  // ---- report -------------------------------------------------------------
  const pct = n => (n / stats.n * 100).toFixed(1);
  stats.latency.sort((a, b) => a - b);
  const lat = p => stats.latency[Math.min(stats.latency.length - 1, Math.floor(stats.latency.length * p))];

  console.log('');
  console.log('[evaluate] ================= results =================');
  console.log(`[evaluate] mode          : ${USE_PHOTOS ? 'REAL PHOTOGRAPHS (gate result)' : 'SYNTHETIC (provisional upper bound)'}`);
  console.log(`[evaluate] queries       : ${stats.n}`);
  console.log(`[evaluate] normalisation : ${NORM}`);
  console.log(`[evaluate] stage 1        : ${EMB_MODE ? 'DINOv2 ' + EMB_MODE : (USE_VARIANTS ? 'hash ensemble + framing variants' : 'hash ensemble')}`);
  if (NORM === 'rectify') {
    const tot = detectHits + detectMiss;
    console.log(`[evaluate] quad detected : ${detectHits}/${tot} (${(detectHits / Math.max(1, tot) * 100).toFixed(1)}%)`);
  }
  console.log(`[evaluate] catalogue     : ${N} cards`);
  console.log('');
  console.log(`[evaluate] stage 1 top-1 : ${pct(stats.s1top1)}%   (art-box hash ensemble)`);
  console.log(`[evaluate] stage 1 top-5 : ${pct(stats.s1top5)}%`);
  console.log(`[evaluate] stage 1 top-${TOP_K}: ${pct(stats.s1topK)}%   <- ceiling for stage 2`);
  console.log(`[evaluate] stage 2 top-1 : ${pct(stats.s2top1)}%   (bottom-right re-rank)`);
  console.log('');
  console.log(`[evaluate] stage 2 fixed : ${stats.s2fixed} queries stage 1 got wrong`);
  console.log(`[evaluate] stage 2 broke : ${stats.s2broke} queries stage 1 had right`);
  console.log(`[evaluate] net effect    : ${stats.s2fixed - stats.s2broke >= 0 ? '+' : ''}${stats.s2fixed - stats.s2broke} queries`);
  console.log('');
  console.log(`[evaluate] latency p50   : ${lat(0.50).toFixed(1)} ms`);
  console.log(`[evaluate] latency p95   : ${lat(0.95).toFixed(1)} ms`);
  console.log(`[evaluate] (single-threaded Node, full linear scan, no ANN index)`);

  if (failures.length) {
    console.log('');
    console.log('[evaluate] sample failures:');
    for (const f of failures.slice(0, 12)) {
      console.log(`  ${f.query.padEnd(24)} truth ${f.truth} "${f.truthName}"`);
      console.log(`  ${''.padEnd(24)} got   ${f.got} "${f.gotName}"  (s1rank=${f.s1rank}, s2rank=${f.s2rank})`);
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    mode: USE_PHOTOS ? 'photos' : 'synthetic', catalogue: N, queries: stats.n,
    stage1: { top1: +pct(stats.s1top1), top5: +pct(stats.s1top5), topK: +pct(stats.s1topK) },
    stage2: { top1: +pct(stats.s2top1), fixed: stats.s2fixed, broke: stats.s2broke },
    latencyMs: { p50: +lat(0.50).toFixed(1), p95: +lat(0.95).toFixed(1) },
    failures,
  }, null, 2), 'utf8');
  console.log('');
  console.log(`[evaluate] wrote ${OUT_FILE}`);
}

main().catch(err => { console.error('[evaluate] FATAL:', err); process.exit(1); });
