// scripts/v3-bench/eval-vision.js
//
// How accurate is the PRODUCTION vision path on real photographs?
//
// Every accuracy number this project has published measures the V3 embedding
// index (docs/V3_BENCHMARK.md §12-§15). The path that actually serves
// customers — Claude reads the card, verifyIdentified resolves it against the
// catalogue — has never been measured on more than a handful of scans. The
// only production evidence is 7/7 correct from one paired-phone session, which
// is no observed errors, not a bounded error rate.
//
// Runs the real pipeline (identifyCore -> verifyIdentified) over the labelled
// photo set and scores the resolved card against the label.
//
// MODEL-AGNOSTIC BY DESIGN. The read step is isolated behind readCard() so a
// different vision model can be scored on the identical photos, labels, and
// scoring rule. Comparing two providers on their own vendor benchmarks proves
// nothing about THIS task; comparing them here does.
//
// Cost: ~64 identify calls. At the measured ~1.6 US cents per card that is
// roughly $1 per full run. count_tokens is free but inference is not.
//
// Usage:
//   node scripts/v3-bench/eval-vision.js
//   node scripts/v3-bench/eval-vision.js --limit 10      # cheap smoke run
//   node scripts/v3-bench/eval-vision.js --concurrency 2

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';

import { identifyCore } from '../../pricing/identify-core.js';
import { verifyIdentified } from '../../pricing/verify.js';
// The catalogue must be loaded or set resolution silently disables itself and
// this harness measures the OLD behaviour while reporting it as the new one.
import { initCardDb, CARD_DB } from '../../apps/server/_card-db-boot.js';

const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const PHOTO_DIR = process.env.V3_PHOTO_DIR || join(CACHE_DIR, 'photos');
const LABELS = join(PHOTO_DIR, 'labels.json');
const OUT = join(CACHE_DIR, 'eval-vision.json');

const argv = process.argv.slice(2);
const argNum = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const LIMIT = argNum('--limit', Infinity);
const CONCURRENCY = argNum('--concurrency', 3);
const argStr = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROVIDER = argStr('--provider', 'claude');
const GEMINI_MODEL = argStr('--model', 'gemini-3-flash-preview');

// The production system prompt, read from source rather than copied, so a
// cross-provider comparison cannot silently drift from what ships.
//
// FAIRNESS CAVEAT, stated up front: this prompt is 3,651 tokens tuned against
// Claude over many iterations. Handing it unchanged to another model measures
// "which model does best on Claude's prompt", which favours the incumbent. It
// is still the right FIRST test, because it is exactly the drop-in swap an
// operator would actually make. A verdict either way deserves a re-tuned
// prompt before it is treated as settled.
const CARD_ID_SYSTEM_PROMPT = (() => {
  const src = fs.readFileSync(join(process.cwd(), 'pricing', 'identify-core.js'), 'utf8');
  const m = src.match(/CARD_ID_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/);
  if (!m) throw new Error('could not extract CARD_ID_SYSTEM_PROMPT');
  return m[1];
})();

const USER_MSG = 'Identify this trading card. FIRST read the card number at the bottom of the card — this is the most critical field. If it has no slash (like SM211, SWSH066) it is a PROMO card. Be extremely precise with the set code and card number.';

let _lastUsage = null;

async function readWithGemini(buffer) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    systemInstruction: { parts: [{ text: CARD_ID_SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: buffer.toString('base64') } },
        { text: USER_MSG },
      ],
    }],
    // 2048 was not enough: Gemini 3 thinks by default and spent 1,962 tokens
    // reasoning, leaving 71 for the answer — every response came back as
    // truncated JSON with finishReason MAX_TOKENS. That is a harness bug, not
    // a model failure, and scoring it as a model failure would have been a
    // false result in the incumbent's favour.
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
  };
  // Retry 429/5xx with backoff. A rate limit mid-run silently truncated an
  // earlier evaluation to 13 of 64 photos, and a partial run that still prints
  // a percentage is exactly the kind of half-measured number this project has
  // been bitten by. Fail loudly after the retries instead.
  let r, lastBody = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) break;
    lastBody = (await r.text()).slice(0, 200);
    if (r.status !== 429 && r.status < 500) break;
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
  if (!r.ok) throw new Error(`gemini ${r.status} after retries: ${lastBody}`);
  const j = await r.json();
  const finish = j.candidates?.[0]?.finishReason;
  const text = j.candidates?.[0]?.content?.parts?.map((x) => x.text).filter(Boolean).join('') ?? '';
  if (finish === 'MAX_TOKENS') throw new Error('gemini truncated (MAX_TOKENS) — raise maxOutputTokens');
  if (!text) throw new Error(`gemini empty response (finish=${finish})`);
  _lastUsage = j.usageMetadata ?? null;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('gemini returned unparseable JSON');
    parsed = JSON.parse(m[0]);
  }
  return parsed.cards ?? [];
}

const _usageTotals = { prompt: 0, output: 0, thoughts: 0, calls: 0 };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const normNum = (n) => String(n ?? '').trim().replace(/^0+(?=.)/, '').toLowerCase();
const idKey = (setId, number) => `${String(setId).toLowerCase()}-${normNum(number)}`;

// (set_code, number) -> [set_id, ...]. Built from the catalogue rather than
// hard-coded, so it tracks whatever card-db.json actually holds.
const CODE_INDEX = (() => {
  const idx = new Map();
  const dbPath = join(process.cwd(), 'data', 'card-db.json');
  if (!fs.existsSync(dbPath)) return idx;
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  for (const [key, v] of Object.entries(db)) {
    const code = String(v.setCode || '').toUpperCase();
    if (!code) continue;
    const dash = key.indexOf('-');
    const setId = key.slice(0, dash);
    const num = normNum(key.slice(dash + 1));
    const k = `${code}|${num}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(setId);
  }
  return idx;
})();

/**
 * Recover the catalogue identity of a verified card.
 *
 * Two routes, because neither alone is sufficient:
 *   1. reference_image — pokemontcg.io serves .../<set_id>/<number>_hires.png,
 *      which carries the set_id directly. Often null on newer sets.
 *   2. (set_code, number) resolved through the catalogue. set_code is a DISPLAY
 *      code and is not always the set_id (JTG is sv9, TWM is sv6), and it is
 *      occasionally ambiguous — CEL maps to both cel25 and cel25c, whose #4 is
 *      Palkia in one and Charizard in the other. Ambiguity is reported, never
 *      silently resolved to whichever came first.
 */
function identityOf(card) {
  const cands = [];
  const url = card?.reference_image;
  if (typeof url === 'string') {
    const m = url.match(/images\.pokemontcg\.io\/([^/]+)\/([^/]+?)(?:_hires)?\.(?:png|jpg|webp)/i);
    if (m) cands.push({ id: idKey(m[1], m[2]), via: 'image_url' });
  }

  const code = String(card?.set_code || '').toUpperCase();
  // Collector numbers arrive as '72' and as '127/167'; the denominator is not
  // part of the identity.
  const num = normNum(String(card?.card_number ?? '').replace(/\/.*$/, ''));
  if (code && num) {
    // Many set codes ARE the set id (ME5 -> me5). Newer sets are often missing
    // from card-db entirely, so this must not depend on a catalogue hit — a
    // correct read of a card the catalogue lacks is still a correct read.
    cands.push({ id: idKey(code, num), via: 'code_as_id' });

    const hits = CODE_INDEX.get(`${code}|${num}`);
    if (hits?.length) {
      for (const h of hits) cands.push({ id: idKey(h, num), via: hits.length > 1 ? 'AMBIGUOUS_SET_CODE' : 'catalogue' });
    }
  }

  const uniq = [...new Map(cands.map((c) => [c.id, c])).values()];
  return {
    ids: uniq.map((c) => c.id),
    id: uniq[0]?.id ?? null,
    via: uniq[0]?.via ?? (code && num ? 'unresolved' : 'no_code_or_number'),
    ambiguous: cands.some((c) => c.via === 'AMBIGUOUS_SET_CODE')
      ? (CODE_INDEX.get(`${code}|${num}`) || null) : null,
  };
}

const truthOf = (raw) => {
  const s = typeof raw === 'string' ? raw : raw?.value;
  if (!s || s === '__none__') return '__none__';
  const [set, ...rest] = s.split('-');
  return idKey(set, rest.join('-'));
};

/**
 * THE PROVIDER SEAM.
 *
 * Returns the raw read plus the verified card. Swap the body to score another
 * vision model: everything downstream (verification, scoring, the photo set,
 * the labels) stays identical, so the comparison isolates the reader.
 */
async function readCard(buffer) {
  let raw;
  if (PROVIDER === 'gemini') {
    raw = await readWithGemini(buffer);
    if (_lastUsage) {
      _usageTotals.calls++;
      _usageTotals.prompt += _lastUsage.promptTokenCount ?? 0;
      _usageTotals.output += _lastUsage.candidatesTokenCount ?? 0;
      _usageTotals.thoughts += _lastUsage.thoughtsTokenCount ?? 0;
    }
  } else {
    const out = await identifyCore({ buffer });
    raw = out.cached ? (out.result?.cards ?? []) : (out.parsed?.cards ?? []);
  }
  // Verification, resolution and scoring are IDENTICAL for every provider —
  // only the read differs, so a difference in the result is a difference in
  // the reader.
  const verified = raw.length ? await verifyIdentified(raw) : [];
  return { raw: raw[0] ?? null, card: verified[0] ?? null, source: PROVIDER };
}

async function main() {
  const needKey = PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[needKey]) {
    console.error(`[eval-vision] ${needKey} not set`);
    process.exit(1);
  }
  if (!fs.existsSync(LABELS)) {
    console.error(`[eval-vision] no labels at ${LABELS}`);
    process.exit(1);
  }

  await initCardDb();
  if (CARD_DB.size === 0) {
    console.error('[eval-vision] catalogue empty after initCardDb() — refusing to ' +
      'run, the result would measure the wrong pipeline');
    process.exit(1);
  }
  console.log(`[eval-vision] catalogue: ${CARD_DB.size} cards`);

  const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
  const photos = walk(PHOTO_DIR).filter((p) => labels[relative(PHOTO_DIR, p).split(sep).join('/')] !== undefined);
  const work = photos.slice(0, LIMIT);

  console.log(`[eval-vision] provider=${PROVIDER}${PROVIDER === 'gemini' ? ' model=' + GEMINI_MODEL : ''}`);
  console.log(`[eval-vision] ${work.length} labelled photos, concurrency ${CONCURRENCY}`);
  console.log('[eval-vision] this spends real API credit — roughly $0.016/photo\n');

  const rows = [];
  let done = 0;

  async function runOne(p) {
    const rel = relative(PHOTO_DIR, p).split(sep).join('/');
    const truth = truthOf(labels[rel]);

    // Match the phone: capture at 1600px long edge, JPEG q85.
    let buffer;
    try {
      buffer = await sharp(fs.readFileSync(p))
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (e) {
      rows.push({ rel, truth, error: `resize: ${e.message}` });
      return;
    }

    try {
      const { raw, card, source } = await readCard(buffer);
      const ident = identityOf(card);
      rows.push({
        rel, truth, source,
        said: ident.id,
        said_all: ident.ids,
        resolved_via: ident.via,
        ambiguous: ident.ambiguous ?? null,
        name: card?.name ?? raw?.name ?? null,
        set_code: card?.set_code ?? raw?.set_code ?? null,
        card_number: card?.card_number ?? raw?.card_number ?? null,
        verified: card?.verified ?? false,
        // The prompt tells the model to drop confidence below 0.5 when it
        // cannot read the card. Nothing in production reads this field.
        model_confidence: raw?.confidence ?? null,
        confidence: card?.confidence_score ?? null,
        // Candidate lists already exist inside verify and are discarded at the
        // route boundary. Captured here because they are what an amber lane
        // would show the operator.
        candidates: Array.isArray(card?.candidates) ? card.candidates.length : 0,
      });
    } catch (e) {
      rows.push({ rel, truth, error: e.message });
    } finally {
      done++;
      if (done % 5 === 0) console.log(`  …${done}/${work.length}`);
    }
  }

  const queue = [...work];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await runOne(queue.shift());
  }));

  // ── Scoring ────────────────────────────────────────────────────────
  //
  // Only the 51 photos with a CONFIRMED positive label can be scored. A
  // `__none__` label means "the reviewer could not confirm any candidate the
  // embedding index showed them" — it is a statement about that index, NOT a
  // claim that the card is absent from the catalogue. Those photos have no
  // ground truth, so scoring against them would be inventing a denominator.
  // They are reported separately as unlabelled predictions worth reviewing.
  const scorable = rows.filter((r) => r.truth !== '__none__' && !r.error);
  const unlabelled = rows.filter((r) => r.truth === '__none__' && !r.error);
  const errored = rows.filter((r) => r.error);

  const hit = (r) => Array.isArray(r.said_all) && r.said_all.includes(r.truth);
  const correct = scorable.filter((r) => hit(r));
  const wrong = scorable.filter((r) => r.said && !hit(r));
  const abstained = scorable.filter((r) => !r.said);

  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : 'n/a');

  console.log('\n════════ VISION PATH — PRODUCTION PIPELINE ════════');
  console.log(`scored (confirmed labels) : ${scorable.length}`);
  console.log(`  correct                 : ${correct.length}  (${pct(correct.length, scorable.length)}%)`);
  console.log(`  WRONG                   : ${wrong.length}  (${pct(wrong.length, scorable.length)}%)`);
  console.log(`  no answer returned      : ${abstained.length}`);
  console.log(`precision when it answers : ${pct(correct.length, correct.length + wrong.length)}%`);
  console.log(`unlabelled (__none__)     : ${unlabelled.length}  — no ground truth, listed below`);
  console.log(`errors                    : ${errored.length}`);

  if (wrong.length) {
    console.log('\n── WRONG ──');
    for (const r of wrong) {
      console.log(`  ${r.rel.slice(-24).padEnd(26)} truth=${r.truth.padEnd(12)} said=${String(r.said_all?.join('/') ?? r.said).padEnd(22)} "${r.name}" ${r.set_code} ${r.card_number}`);
    }
  }
  if (abstained.length) {
    console.log('\n── NO ANSWER ──');
    for (const r of abstained) console.log(`  ${r.rel.slice(-24).padEnd(26)} truth=${r.truth} name="${r.name}" verified=${r.verified}`);
  }
  if (errored.length) {
    console.log('\n── ERRORS ──');
    for (const r of errored) console.log(`  ${r.rel.slice(-24).padEnd(26)} ${r.error}`);
  }
  if (unlabelled.length) {
    console.log('\n── UNLABELLED (needs a human to confirm; would become new labels) ──');
    for (const r of unlabelled) console.log(`  ${r.rel.slice(-24).padEnd(26)} said=${String(r.said_all?.join('/') ?? r.said).padEnd(22)} "${r.name}" ${r.set_code} ${r.card_number}`);
  }

  const outFile = PROVIDER === 'gemini' ? OUT.replace('.json', `-${GEMINI_MODEL}.json`) : OUT;
  fs.writeFileSync(outFile, JSON.stringify({ provider: PROVIDER, model: PROVIDER === 'gemini' ? GEMINI_MODEL : 'claude-sonnet-4-6 (production identifyCore)', rows }, null, 2));
  console.log(`\n[eval-vision] wrote ${OUT}`);
  console.log('\nN is small. Report the interval, not the point estimate:');
  console.log(`  ${correct.length}/${scorable.length} is a sample, and "0 wrong" over ${scorable.length} bounds the`);
  console.log('  true error rate only loosely. Do not quote this as an accuracy figure.');
}

main().catch((e) => { console.error(e); process.exit(1); });
