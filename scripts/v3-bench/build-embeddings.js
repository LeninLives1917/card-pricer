#!/usr/bin/env node
// scripts/v3-bench/build-embeddings.js
//
// V3 Phase 0 — approach (b): learned global embeddings.
//
// Perceptual hashes measured fragile to both geometry and lighting even after
// rectification (docs/V3_BENCHMARK.md §5). A learned descriptor should absorb
// what a 64-bit threshold hash cannot.
//
// Model: DINOv2-small via transformers.js. Chosen over CLIP because CLIP is
// trained for SEMANTIC similarity — it would happily place two different
// Charizard cards next to each other, which is precisely the confusion we
// cannot afford. DINOv2 self-supervised features are markedly better at
// instance-level, near-duplicate retrieval.
//
// transformers.js runs the same ONNX graph in Node and in the browser (WASM or
// WebGPU), so this is B2's inference path, not a Node-only prototype.
//
// Two descriptors are stored from a single forward pass, since the pass
// dominates the cost and it is not obvious in advance which wins:
//   cls  — the [CLS] token, DINOv2's canonical global descriptor
//   mean — mean over the 256 patch tokens, often better under occlusion
//
// Both are L2-normalised then quantised to int8. 384 dims -> 384 bytes/card
// -> ~7.6 MB across the catalogue, which is shippable.
//
// Usage:
//   node scripts/v3-bench/build-embeddings.js
//   node scripts/v3-bench/build-embeddings.js --limit 500

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import sharp from 'sharp';
import { pipeline, env, RawImage } from '@huggingface/transformers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const IMG_DIR = join(CACHE_DIR, 'refs');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
// Photometric normalisation. Lighting cost ~20 points of top-1 on its own
// (docs/V3_BENCHMARK.md), so stretch each card's histogram to the full range
// before embedding. This MUST be applied identically when building the index
// and when embedding a query, hence a separate artifact rather than a flag that
// could be set on one side only.
const NORMALISE = process.env.EMB_NORMALISE === '1';
const OUT_FILE = join(CACHE_DIR, NORMALISE ? 'embeddings-norm.json' : 'embeddings.json');

env.cacheDir = join(CACHE_DIR, 'models');

const MODEL = process.env.EMB_MODEL || 'Xenova/dinov2-small';
const DTYPE = process.env.EMB_DTYPE || 'q8';

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : Number(process.argv[i + 1]);
}
const LIMIT = argVal('--limit');

/**
 * Pool a [1, T, D] token tensor into { cls, mean }, both L2-normalised.
 * transformers.js ignores the `pooling` option for image-feature-extraction on
 * this architecture and returns raw tokens, so pooling is done here.
 */
export function poolTokens(data, dims) {
  const [, T, D] = dims;
  const cls = new Float32Array(D);
  const mean = new Float32Array(D);

  for (let d = 0; d < D; d++) cls[d] = data[d];              // token 0 = [CLS]
  for (let t = 1; t < T; t++) {
    const off = t * D;
    for (let d = 0; d < D; d++) mean[d] += data[off + d];
  }
  const patches = Math.max(1, T - 1);
  for (let d = 0; d < D; d++) mean[d] /= patches;

  const l2 = v => {
    let s = 0;
    for (const x of v) s += x * x;
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= s;
    return v;
  };
  return { cls: l2(cls), mean: l2(mean) };
}

/**
 * Quantise an L2-normalised float vector to int8.
 * Components of a unit vector are in [-1, 1]; scaling by 127 keeps the full
 * range with symmetric rounding. Cosine similarity over the int8 vectors is
 * proportional to the float dot product, so ranking is preserved.
 */
export function quantise(v) {
  const out = Buffer.allocUnsafe(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(v[i] * 127) + 128));
  }
  return out;
}

async function main() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error('[embeddings] run fetch-refs.js first'); process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  let ids = Object.keys(manifest.cards).sort();
  if (LIMIT) ids = ids.slice(0, LIMIT);

  console.log(`[embeddings] model=${MODEL} dtype=${DTYPE} normalise=${NORMALISE}`);
  console.log(`[embeddings] ${ids.length} cards`);

  const t0 = Date.now();
  const fe = await pipeline('image-feature-extraction', MODEL, { dtype: DTYPE });
  console.log(`[embeddings] model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Resume, for the same reason as build-variants.js: a long run that wrote
  // only on completion loses everything if it is killed.
  let cards = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      if (prev.model === MODEL && prev.dtype === DTYPE && prev.cards) {
        cards = prev.cards;
        console.log(`[embeddings] resuming — ${Object.keys(cards).length} cards already embedded`);
      } else {
        console.log('[embeddings] existing file used a different model/dtype — rebuilding');
      }
    } catch { /* corrupt: rebuild */ }
  }

  const tStart = Date.now();
  let done = 0, failed = 0, D = 0, sinceFlush = 0;

  const flush = () => {
    const tmp = OUT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, model: MODEL, dtype: DTYPE, dims: D, cards }), 'utf8');
    fs.renameSync(tmp, OUT_FILE);
  };

  for (const id of ids) {
    if (cards[id]) continue;
    const m = manifest.cards[id];
    const path = join(IMG_DIR, m.set_id, `${String(m.number).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`);
    try {
      // Decode via sharp: RawImage.read cannot handle every WebP variant, and
      // this keeps decoding identical to every other stage of the benchmark.
      let pipe = sharp(path).removeAlpha();
      if (NORMALISE) pipe = pipe.normalise();
      const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
      const img = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);

      const out = await fe(img);
      const { cls, mean } = poolTokens(out.data, out.dims);
      D = cls.length;
      cards[id] = {
        set_id: m.set_id, number: m.number, name: m.name,
        cls: quantise(cls).toString('base64'),
        mean: quantise(mean).toString('base64'),
      };
    } catch (err) {
      failed++;
      if (failed <= 3) console.error(`[embeddings] ${id}: ${err.message}`);
      continue;
    }

    done++; sinceFlush++;
    if (sinceFlush >= 500) {
      flush(); sinceFlush = 0;
      const rate = done / ((Date.now() - tStart) / 1000);
      const remaining = ids.length - Object.keys(cards).length;
      console.log(`[embeddings] ${Object.keys(cards).length}/${ids.length} ` +
                  `(${rate.toFixed(1)}/s, ETA ${(remaining / rate / 60).toFixed(1)} min)`);
    }
  }

  flush();

  const mb = fs.statSync(OUT_FILE).size / 1024 / 1024;
  console.log(`[embeddings] done — ${done} cards, ${failed} failed, ` +
              `${((Date.now() - tStart) / 60000).toFixed(1)} min`);
  console.log(`[embeddings] dims=${D} | ${OUT_FILE} (${mb.toFixed(1)} MB JSON)`);
  console.log(`[embeddings] binary-packed would be ${(done * D / 1024 / 1024).toFixed(1)} MB per descriptor`);
}

// Only run when invoked directly. evaluate.js imports poolTokens/quantise from
// this module; without this guard that import would silently start a full
// catalogue embedding run.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch(err => { console.error('[embeddings] FATAL:', err); process.exit(1); });
}
