#!/usr/bin/env node
// scripts/v3-bench/review.js
//
// V3 Phase 0 — human-in-the-loop labelling for the benchmark photo set.
//
// The original plan labelled photos by filename, which meant renaming a few
// hundred files by hand. The operator is not doing that, and it was always the
// worst part of the plan.
//
// Instead: shoot freely with whatever filenames the phone produces, and let the
// matcher propose. This script runs the full pipeline over every photo, takes
// the top-K candidates, and writes ONE self-contained HTML page where each photo
// sits beside its candidates. The operator clicks the right card, or "not here".
// That yields genuine ground truth for a few minutes of clicking.
//
// WHY THIS IS NOT CIRCULAR: the operator VERIFIES a proposal, they do not accept
// it. If the true card is in the candidate list they pick it — including when it
// is rank 3, which still scores as a top-1 MISS. If it is absent they click "not
// here", which scores as a miss too. Recognition is a different act from
// generation, so top-1 and top-5 come out exactly right. The one thing this
// cannot measure is what the correct answer was when the system missed entirely,
// which the accuracy figures do not need.
//
// Usage:
//   node scripts/v3-bench/review.js                    # all photos
//   node scripts/v3-bench/review.js --limit 20         # first 20 (format check)
//
// Then open  ~/.card-pricer-v3/review.html  in a browser, click through, press
// "Download labels", save the JSON next to the photos as labels.json, and run:
//   node scripts/v3-bench/evaluate.js --photos --rectify --embeddings cls

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename, extname, relative, sep } from 'path';
import sharp from 'sharp';

import { computePhash, computeDhash } from '../../pricing/phash.js';
import { rectify } from './rectify.js';
import { poolTokens, quantise } from './build-embeddings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const PHOTO_DIR = process.env.V3_PHOTO_DIR || join(CACHE_DIR, 'photos');
const EMB_FILE = join(CACHE_DIR, 'embeddings.json');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
const OUT_HTML = join(CACHE_DIR, 'review.html');

const TOP_K = 6;
const THUMB_W = 190;
const CAND_W = 120;
const IMG_DIR = join(CACHE_DIR, 'refs');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : Number(process.argv[i + 1]);
}
const LIMIT = argVal('--limit');
// --misses re-reviews only the photos previously marked "not here". Needed
// after the index gains cards: a "__none__" label means "not among the
// candidates I was shown", which is a statement about the OLD index, not about
// the card. Confirmed matches don't need re-checking — a card that matched
// correctly still matches correctly when the index only grows.
const MISSES_ONLY = process.argv.includes('--misses');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return IMAGE_EXT.has(extname(e.name).toLowerCase()) ? [full] : [];
  });
}

// Candidate thumbnails come from the LOCAL cache, not the CDN. The manifest's
// displayUrl points at ~800 KB hi-res PNGs; at 6 candidates x a few hundred
// photos that is well over a thousand remote images and the page never finishes
// loading (observed: every candidate rendered as a grey box). Small embedded
// JPEGs make the page self-contained, fast, and usable with no internet — which
// also means it can be opened on the shop floor.
let PRESEED = {};
const _thumbCache = new Map();
async function candThumb(id, meta) {
  if (_thumbCache.has(id)) return _thumbCache.get(id);
  const p = join(IMG_DIR, meta.set_id, `${String(meta.number).replace(/[^A-Za-z0-9_-]/g, '_')}.webp`);
  let uri = '';
  try {
    const b = await sharp(p).resize(CAND_W).jpeg({ quality: 70 }).toBuffer();
    uri = 'data:image/jpeg;base64,' + b.toString('base64');
  } catch { /* not cached — render a blank tile rather than failing the row */ }
  _thumbCache.set(id, uri);
  return uri;
}

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function main() {
  if (!fs.existsSync(PHOTO_DIR)) {
    console.error(`[review] no photo directory at ${PHOTO_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(EMB_FILE)) {
    console.error('[review] embeddings.json not found — run build-embeddings.js');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const emb = JSON.parse(fs.readFileSync(EMB_FILE, 'utf8'));
  const ids = Object.keys(emb.cards);
  const N = ids.length;
  const D = emb.dims;

  const embAll = new Int8Array(N * D);
  ids.forEach((id, i) => {
    const b = Buffer.from(emb.cards[id].cls, 'base64');
    for (let k = 0; k < D; k++) embAll[i * D + k] = b[k] - 128;
  });
  console.log(`[review] index: ${N} cards, d=${D} (${emb.model})`);

  let files = walk(PHOTO_DIR).sort();

  if (MISSES_ONLY) {
    const labelsFile = join(PHOTO_DIR, 'labels.json');
    if (!fs.existsSync(labelsFile)) {
      console.error(`[review] --misses needs ${labelsFile}`); process.exit(1);
    }
    const prev = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    const before = files.length;
    files = files.filter(f => prev[relative(PHOTO_DIR, f).split(sep).join('/')] === '__none__');
    console.log(`[review] --misses: ${files.length} of ${before} photos previously marked "not here"`);
    // Carry the confirmed labels into the page's saved state so a re-review
    // downloads a COMPLETE labels.json, not just the re-checked subset.
    PRESEED = Object.fromEntries(
      Object.entries(prev).filter(([, v]) => v !== '__none__'));
  }

  if (LIMIT) files = files.slice(0, LIMIT);
  if (!files.length) {
    console.error(`[review] no images found under ${PHOTO_DIR}`);
    process.exit(1);
  }
  console.log(`[review] ${files.length} photos`);

  const { pipeline, env, RawImage } = await import('@huggingface/transformers');
  env.cacheDir = join(CACHE_DIR, 'models');
  const fe = await pipeline('image-feature-extraction', emb.model, { dtype: emb.dtype });

  const rows = [];
  let done = 0, failed = 0, detected = 0;
  const t0 = Date.now();

  for (const file of files) {
    let thumb, cands;
    try {
      const raw = fs.readFileSync(file);

      // Same pipeline the benchmark uses, so what the operator confirms is what
      // the system would actually have produced.
      const { buffer: face, alt, detected: det } = await rectify(raw);
      if (det) detected++;

      // Quad detection recovers the card's axis but not which end is up, and on
      // real table photos the result is upside down as often as not. Score both
      // orientations and keep the better — otherwise every flipped card lands in
      // the review page with six irrelevant candidates.
      const faces = [face];
      if (alt) faces.push(alt);

      let scored = null, winner = faces[0];
      for (const f of faces) {
        const faceBuf = await sharp(f).resize(245, 342, { fit: 'fill' }).toBuffer();
        const { data, info } = await sharp(faceBuf).removeAlpha().raw()
          .toBuffer({ resolveWithObject: true });
        const out = await fe(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3));
        const q = quantise(poolTokens(out.data, out.dims).cls);
        const qv = new Int8Array(D);
        for (let i = 0; i < D; i++) qv[i] = q[i] - 128;

        const sc = new Array(N);
        for (let ci = 0; ci < N; ci++) {
          let dot = 0;
          const off = ci * D;
          for (let k = 0; k < D; k++) dot += embAll[off + k] * qv[k];
          sc[ci] = { ci, dot };
        }
        sc.sort((a, b) => b.dot - a.dot);
        if (!scored || sc[0].dot > scored[0].dot) { scored = sc; winner = f; }
      }

      cands = [];
      for (const s of scored.slice(0, TOP_K)) {
        const id = ids[s.ci];
        const m = manifest.cards[id] || {};
        cands.push({
          id,
          name: emb.cards[id].name,
          set: m.setName || emb.cards[id].set_id,
          num: emb.cards[id].number,
          img: await candThumb(id, emb.cards[id]),
          cos: (s.dot / (127 * 127)).toFixed(3),
        });
      }

      // The photo itself is embedded so the page works with no local server and
      // can be moved around freely. Rotation is baked in from EXIF, or phone
      // photos display sideways.
      // Show the RECTIFIED face, not the raw photo: the operator should be
      // comparing what the matcher actually saw. When detection fails this is
      // just the resized frame, which is itself the useful signal.
      // Show the orientation that WON, not the arbitrary primary — otherwise the
      // operator is asked to compare an upside-down card against right-way-up
      // candidates, which is needless work and invites mistakes.
      thumb = (await sharp(winner).resize(THUMB_W).jpeg({ quality: 72 }).toBuffer())
        .toString('base64');
    } catch (err) {
      failed++;
      if (failed <= 5) console.error(`[review] ${basename(file)}: ${err.message}`);
      continue;
    }

    rows.push({ file: relative(PHOTO_DIR, file).replace(/\\/g, '/'), thumb, cands });

    if (++done % 25 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`[review] ${done}/${files.length} (${rate.toFixed(1)}/s)`);
    }
  }

  console.log(`[review] processed ${done}, failed ${failed}, quad detected ${detected}/${done}` +
              ` (${(detected / Math.max(1, done) * 100).toFixed(1)}%)`);

  const tops = rows.map(r => Number(r.cands[0].cos)).sort((a, b) => a - b);
  const pc = q => tops[Math.min(tops.length - 1, Math.floor(tops.length * q))];
  console.log(`[review] top-1 cosine: min ${pc(0).toFixed(3)} | p25 ${pc(0.25).toFixed(3)} | ` +
              `median ${pc(0.5).toFixed(3)} | p75 ${pc(0.75).toFixed(3)} | max ${pc(0.999).toFixed(3)}`);
  console.log('[review] for reference, a correct match on clean renders scores ~0.85-1.00');

  // ---- page ---------------------------------------------------------------
  const cards = rows.map((r, i) => `
<div class="row" data-i="${i}" data-file="${esc(r.file)}">
  <div class="q">
    <img class="qimg" src="data:image/jpeg;base64,${r.thumb}" alt="">
    <button class="flip" type="button" title="Rotate 180°">⟳ flip</button>
    <div class="fn">${esc(r.file)}</div>
  </div>
  <div class="cands">
    ${r.cands.map((c, j) => `
    <label class="c" data-id="${esc(c.id)}">
      <input type="radio" name="r${i}" value="${esc(c.id)}">
      <img src="${c.img}" loading="lazy" alt="">
      <div class="meta"><b>${esc(c.name)}</b><span>${esc(c.set)} #${esc(c.num)}</span>
      <span class="cos">${j === 0 ? '★ ' : ''}${c.cos}</span></div>
    </label>`).join('')}
    <label class="c none">
      <input type="radio" name="r${i}" value="__none__">
      <div class="nonebox">Not here</div>
    </label>
  </div>
</div>`).join('');

  const html = `<!doctype html><meta charset="utf-8">
<title>Card-Pricer V3 — photo review</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
 h1{font-size:18px;margin:0 0 4px}
 .bar{position:sticky;top:0;background:#111;padding:10px 0 12px;border-bottom:1px solid #333;z-index:5}
 .bar button{font:inherit;padding:8px 14px;margin-right:8px;border-radius:6px;border:1px solid #555;background:#222;color:#eee;cursor:pointer}
 .bar button:hover{background:#2c2c2c}
 #prog{color:#9c9}
 .row{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid #292929;align-items:flex-start}
 .row.done{opacity:.45}
 .q{flex:0 0 ${THUMB_W}px}
 .q img{width:100%;border-radius:6px;display:block;transition:transform .12s}
 .q img.flipped{transform:rotate(180deg)}
 .flip{margin-top:4px;width:100%;font:inherit;font-size:12px;padding:3px 0;border:1px solid #555;
       border-radius:5px;background:#222;color:#bbb;cursor:pointer}
 .flip:hover{background:#2c2c2c;color:#eee}
 .fn{font-size:11px;color:#888;word-break:break-all;margin-top:4px}
 .cands{display:flex;gap:8px;flex-wrap:wrap;flex:1}
 .c{position:relative;width:118px;cursor:pointer;border:2px solid transparent;border-radius:8px;padding:4px;background:#1a1a1a}
 .c:hover{background:#242424}
 .c input{position:absolute;opacity:0}
 .c img{width:100%;border-radius:4px;display:block;background:#333;min-height:150px}
 .c:has(input:checked){border-color:#4ade80;background:#16281c}
 .meta{font-size:11px;line-height:1.3;margin-top:4px}
 .meta b{display:block;font-size:12px}
 .meta span{display:block;color:#999}
 .cos{color:#6cf!important}
 .none .nonebox{display:flex;align-items:center;justify-content:center;height:150px;border:1px dashed #666;border-radius:4px;color:#aaa;font-size:12px}
</style>
<div class="bar">
  <h1>Card-Pricer V3 — photo review</h1>
  <div style="font-size:13px;color:#aaa;margin-bottom:8px">
    Click the card that matches the photo on the left. If none of them is right, click <b>Not here</b>.
    A rank-2 pick still counts as a top-1 miss — pick the truth, not the first option.
    Progress saves automatically. If a photo looks upside down, hit <b>flip</b> — it only changes the view, not the answer.
  </div>
  <button id="dl">Download labels</button>
  <button id="clr">Clear all</button>
  <span id="prog"></span>
</div>
${cards}
<script>
const KEY='cp-v3-review';
const PRESEED=__PRESEED__;
const state=Object.assign({}, PRESEED, JSON.parse(localStorage.getItem(KEY)||'{}'));
localStorage.setItem(KEY,JSON.stringify(state));
const rows=[...document.querySelectorAll('.row')];
function paint(){
  let n=0;
  for(const row of rows){
    const f=row.dataset.file;
    if(state[f]){ n++; row.classList.add('done');
      const el=row.querySelector('input[value="'+CSS.escape(state[f])+'"]');
      if(el) el.checked=true;
    } else row.classList.remove('done');
  }
  document.getElementById('prog').textContent=n+' / '+rows.length+' labelled';
}
// Orientation is chosen by match score, so when the match is wrong it is a coin
// flip. Three automatic signals were measured against the 29 correctly-matched
// photos — bottom-vs-top detail energy (34.5%), mean-of-top-50 similarity
// (72.4%), global mean similarity (62.1%) — and none was reliable enough to
// trust. A flip button always works, so the operator gets that instead.
document.addEventListener('click',e=>{
  const b=e.target.closest('.flip'); if(!b)return;
  b.parentElement.querySelector('.qimg').classList.toggle('flipped');
});
document.addEventListener('change',e=>{
  if(e.target.type!=='radio')return;
  const row=e.target.closest('.row');
  state[row.dataset.file]=e.target.value;
  localStorage.setItem(KEY,JSON.stringify(state));
  paint();
});
document.getElementById('dl').onclick=()=>{
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download='labels.json'; a.click();
};
document.getElementById('clr').onclick=()=>{
  if(!confirm('Clear all labels?'))return;
  localStorage.removeItem(KEY);
  for(const k in state) delete state[k];
  document.querySelectorAll('input[type=radio]').forEach(r=>r.checked=false);
  paint();
};
paint();
</script>`;

  fs.writeFileSync(OUT_HTML, html.replace('__PRESEED__', JSON.stringify(PRESEED)), 'utf8');
  console.log(`[review] wrote ${OUT_HTML} (${(fs.statSync(OUT_HTML).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log('[review] open it, click through, then "Download labels" and save');
  console.log(`[review] labels.json into ${PHOTO_DIR}`);
}

main().catch(err => { console.error('[review] FATAL:', err); process.exit(1); });
