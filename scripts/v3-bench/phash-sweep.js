// scripts/v3-bench/phash-sweep.js
//
// Can the pHash fast path be made safe, or does it have to be replaced?
//
// On 2026-08-07 it answered 4 of the first 11 production scans and was wrong
// on all 4 — confirmed per row by the source badge, against 7/7 correct from
// the vision model. It now runs in shadow (pricing/fast-path-mode.js). The
// open question is whether that is a threshold problem or a descriptor
// problem, and the honest way to settle it is to replay LABELLED photos
// rather than argue from four observations.
//
// Replays the 64 real photographs in ~/.card-pricer-v3/photos through the
// production hash pipeline (cropToCard -> pHash/dHash/wHash -> lookup) and
// reports precision and coverage for three accept rules:
//
//   A  current       min distance across the three hash types <= T.
//                    This is exactly what lookupByHashes() does today.
//   B  + margin      as A, but the runner-up card must be at least M bits
//                    further away. Ports the accept-gate insight — a near-tie
//                    between two cards means the descriptor cannot separate
//                    them, and margin caught the reprint that score missed.
//   C  consensus     >= 2 of the 3 hash types independently name the SAME
//                    card within T. Three hashes are currently three
//                    independent chances to false-positive; requiring
//                    agreement turns them into corroboration instead.
//
// The 13 photos labelled __none__ are cards absent from the index. They are
// the cases that matter most: ANY fire on them is a false positive, and a
// rule that scores well while ignoring them is measuring the easy half.
//
// Usage:  node scripts/v3-bench/phash-sweep.js
//         node scripts/v3-bench/phash-sweep.js --max-t 12 --margin 4

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { cropToCard, computePhash, computeDhash, computeWhash, loadIndex } from '../../pricing/phash.js';

const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const PHOTO_DIR = process.env.V3_PHOTO_DIR || join(CACHE_DIR, 'photos');
const LABELS = join(PHOTO_DIR, 'labels.json');
const OUT = join(CACHE_DIR, 'phash-sweep.json');

const argv = process.argv.slice(2);
const argNum = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MAX_T = argNum('--max-t', 12);
const MARGIN = argNum('--margin', 4);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function hamming(a, b) {
  let x = a ^ b, d = 0;
  while (x !== 0n) { x &= x - 1n; d++; }
  return d;
}

const cardKey = (c) => c ? `${c.set_id}-${String(c.number).replace(/^0+(?=.)/, '')}` : null;
const labelKey = (v) => {
  const s = typeof v === 'string' ? v : v?.value;
  if (!s || s === '__none__') return '__none__';
  const [set, ...rest] = s.split('-');
  return `${set}-${rest.join('-').replace(/^0+(?=.)/, '')}`;
};

/**
 * Rank every index entry for one hash type. Returns the best match and the
 * best match belonging to a DIFFERENT card — the runner-up that margin is
 * measured against. Same-card entries (a card contributes several hashes)
 * must not count as their own runner-up or margin is always zero.
 */
function rank(index, hash) {
  if (hash == null) return null;
  let best = null, bestDist = 999, runnerDist = 999;
  for (const [key, card] of index) {
    const d = hamming(hash, key);
    if (d < bestDist) {
      if (best && cardKey(best) !== cardKey(card)) runnerDist = bestDist;
      bestDist = d; best = card;
    } else if (d < runnerDist && best && cardKey(card) !== cardKey(best)) {
      runnerDist = d;
    }
  }
  return best ? { card: best, distance: bestDist, runnerUp: runnerDist } : null;
}

async function main() {
  if (!fs.existsSync(LABELS)) {
    console.error(`[phash-sweep] no labels at ${LABELS}`);
    process.exit(1);
  }
  const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8'));

  console.log('[phash-sweep] loading production hash index…');
  await loadIndex();
  const { _phashIndex, _dhashIndex, _whashIndex } = await import('../../pricing/phash.js')
    .then(async () => {
      // The indexes are module-private; re-read the artefact directly so this
      // script measures the same bytes production loads.
      const file = process.env.PHASH_FILE || join(process.cwd(), 'data', 'card-phashes.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const toMap = (o) => new Map(Object.entries(o || {}).map(([h, c]) => [BigInt('0x' + h), c]));
      return { _phashIndex: toMap(raw.phash), _dhashIndex: toMap(raw.dhash), _whashIndex: toMap(raw.whash) };
    });

  console.log(`[phash-sweep] index: phash=${_phashIndex.size} dhash=${_dhashIndex.size} whash=${_whashIndex.size}`);

  const photos = walk(PHOTO_DIR);
  console.log(`[phash-sweep] ${photos.length} photos\n`);

  // Compute once; sweep thresholds over the cached rankings.
  const rows = [];
  for (const [i, p] of photos.entries()) {
    const rel = relative(PHOTO_DIR, p).replace(/\\/g, '/');
    const truth = labelKey(labels[rel]);
    if (labels[rel] === undefined) continue;

    let hashes;
    try {
      const buf = await cropToCard(fs.readFileSync(p));
      hashes = {
        phash: await computePhash(buf),
        dhash: await computeDhash(buf),
        whash: await computeWhash(buf),
      };
    } catch (e) {
      console.warn(`  ! ${rel}: ${e.message}`);
      continue;
    }

    rows.push({
      rel, truth,
      phash: rank(_phashIndex, hashes.phash),
      dhash: rank(_dhashIndex, hashes.dhash),
      whash: rank(_whashIndex, hashes.whash),
    });
    if ((i + 1) % 10 === 0) console.log(`  …${i + 1}/${photos.length}`);
  }

  const inIndex = rows.filter(r => r.truth !== '__none__').length;
  console.log(`\n[phash-sweep] ${rows.length} scored (${inIndex} in-index, ${rows.length - inIndex} absent)\n`);

  const results = [];
  for (let T = 0; T <= MAX_T; T++) {
    const rules = { A: fire => fireA(fire, T), B: fire => fireB(fire, T, MARGIN), C: fire => fireC(fire, T) };
    const row = { threshold: T };
    for (const [name, fn] of Object.entries(rules)) {
      let fired = 0, correct = 0, wrongOnAbsent = 0;
      for (const r of rows) {
        const said = fn(r);
        if (!said) continue;
        fired++;
        if (r.truth === '__none__') wrongOnAbsent++;
        else if (said === r.truth) correct++;
      }
      row[name] = {
        fired,
        correct,
        wrong: fired - correct,
        wrong_on_absent: wrongOnAbsent,
        precision: fired ? correct / fired : null,
        coverage: rows.length ? fired / rows.length : 0,
      };
    }
    results.push(row);
  }

  const pct = v => v === null ? '  n/a' : (v * 100).toFixed(1).padStart(5);
  console.log('  T | rule            fired  correct  WRONG  precision  coverage');
  console.log('  --+------------------------------------------------------------');
  for (const r of results) {
    for (const [name, label] of [['A', 'A current    '], ['B', `B +margin${String(MARGIN).padEnd(4)}`], ['C', 'C consensus  ']]) {
      const c = r[name];
      console.log(`  ${String(r.threshold).padStart(2)}| ${label}  ${String(c.fired).padStart(5)}  ${String(c.correct).padStart(7)}  ${String(c.wrong).padStart(5)}     ${pct(c.precision)}%    ${pct(c.coverage)}%`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ generated_for: 'phash salvageability', margin: MARGIN, rows: results }, null, 2));
  console.log(`\n[phash-sweep] wrote ${OUT}`);
  console.log('\nREAD THIS AS: precision is what matters. A wrong price costs real');
  console.log('money; an abstention costs a second. A rule only earns "primary"');
  console.log('if it reaches 100% precision at coverage worth having — and even');
  console.log(`then, 0 wrong out of N is no OBSERVED errors, not a bounded rate.`);
}

// Rule A — exactly what production's lookupByHashes does: global minimum
// distance across all three hash types.
function fireA(r, T) {
  let best = null, bestD = T + 1;
  for (const t of ['phash', 'dhash', 'whash']) {
    const x = r[t];
    if (x && x.distance <= T && x.distance < bestD) { bestD = x.distance; best = x.card; }
  }
  return cardKey(best);
}

// Rule B — A, plus the runner-up card must be M bits further away.
function fireB(r, T, M) {
  let best = null, bestD = T + 1, bestRunner = 0;
  for (const t of ['phash', 'dhash', 'whash']) {
    const x = r[t];
    if (x && x.distance <= T && x.distance < bestD) { bestD = x.distance; best = x.card; bestRunner = x.runnerUp; }
  }
  if (!best) return null;
  return (bestRunner - bestD) >= M ? cardKey(best) : null;
}

// Rule C — at least two hash types independently name the same card.
function fireC(r, T) {
  const votes = new Map();
  for (const t of ['phash', 'dhash', 'whash']) {
    const x = r[t];
    if (x && x.distance <= T) {
      const k = cardKey(x.card);
      votes.set(k, (votes.get(k) || 0) + 1);
    }
  }
  for (const [k, n] of votes) if (n >= 2) return k;
  return null;
}

main().catch(e => { console.error(e); process.exit(1); });
