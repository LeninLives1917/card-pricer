#!/usr/bin/env node
// scripts/v3-bench/fetch-refs.js
//
// V3 Phase 0 — reference-image acquisition.
//
// Downloads the pokemontcg.io `small` rendition for every card in
// data/card-db.json exactly ONCE and caches a normalised copy on local disk,
// plus a manifest. Every later descriptor experiment (multi-hash, art-box
// hash, CNN embedding, ORB) reads the cache instead of re-crawling, so we pay
// the ~20k-request network cost a single time.
//
// The cache is a BENCHMARK ARTEFACT, not a shipped one. It holds card artwork,
// which is third-party copyright — it lives outside the repo, is never
// committed, and is deleted once Phase 0 closes. The shipped index contains
// descriptors only (see docs/V3_ARCHITECTURE.md §"Store fingerprints, not art").
//
// Usage:
//   node scripts/v3-bench/fetch-refs.js                 # full catalogue
//   node scripts/v3-bench/fetch-refs.js --sets 3        # first 3 sets only
//   node scripts/v3-bench/fetch-refs.js --limit 200     # first 200 cards only
//
// Env:
//   V3_CACHE_DIR         cache root (default ~/.card-pricer-v3)
//   IMG_CONCURRENCY      parallel image downloads (default 16)
//   SET_CONCURRENCY      parallel set-list fetches (default 4)
//   POKEMONTCG_API_KEY   optional; raises pokemontcg.io rate limits
//
// Resumable: cards already in the cache are skipped on re-run.

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');

const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const IMG_DIR = join(CACHE_DIR, 'refs');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');
const SKIP_LOG = join(CACHE_DIR, 'fetch-skipped.log');

const IMG_CONCURRENCY = Number(process.env.IMG_CONCURRENCY) || 16;
const SET_CONCURRENCY = Number(process.env.SET_CONCURRENCY) || 4;
const FETCH_TIMEOUT_MS = 20_000;
const POKEMONTCG_BASE = 'https://api.pokemontcg.io/v2';
const PAGE_SIZE = 250;
const API_KEY = process.env.POKEMONTCG_API_KEY || null;

// Normalised cache rendition. 245×342 matches the source `small` rendition, so
// we neither upscale nor throw away detail the CDN gave us. WebP q90 is ~3×
// smaller than the source PNG and decodes fast for the descriptor passes.
const CACHE_W = 245;
const CACHE_H = 342;

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : Number(process.argv[i + 1]);
}
const SET_LIMIT = argVal('--sets');
const CARD_LIMIT = argVal('--limit');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function asyncPool(concurrency, items, taskFn) {
  const inFlight = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => taskFn(item)).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= concurrency) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
}

function logSkip(key, reason) {
  fs.appendFileSync(SKIP_LOG, `${new Date().toISOString()} SKIP ${key} — ${reason}\n`, 'utf8');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// pokemontcg.io is presently returning intermittent 500/502 on perfectly valid
// requests — measured 4 Aug 2026 at roughly a 40% failure rate on
// /v2/cards?pageSize=250, with the SAME request succeeding on retry. The
// existing crawler (scripts/build-phash-db.js) has no retry at all: one 500 and
// it logs `skipping entire set` and drops ~120 cards on the floor silently.
// That is a sufficient explanation on its own for an index that never filled.
// Retry on 5xx / 429 / network error; never on 4xx (those are real).
const MAX_ATTEMPTS = 6;
const retryStats = { retried: 0, attempts: 0 };

async function getWithRetry(url, opts) {
  let delay = 500;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      const status = err.response?.status ?? null;
      const retryable = status === null || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw Object.assign(err, { _attempts: attempt });
      }
      if (attempt === 1) retryStats.retried++;
      retryStats.attempts++;
      await sleep(delay + Math.floor(Math.random() * 250));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

// Cards are sharded one directory per set: 172 dirs of ~120 files each rather
// than a single 20k-entry directory, which Windows enumerates very slowly.
function cachePathFor(setId, number) {
  const safeNumber = String(number).replace(/[^A-Za-z0-9_-]/g, '_');
  return join(IMG_DIR, setId, `${safeNumber}.webp`);
}

function splitCardId(id) {
  const i = id.lastIndexOf('-');
  return { setId: id.slice(0, i), number: id.slice(i + 1) };
}

async function fetchSetCards(setId) {
  const out = [];
  let page = 1;
  let totalCount = null;
  do {
    const url = `${POKEMONTCG_BASE}/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=${PAGE_SIZE}&page=${page}`;
    let resp;
    try {
      resp = await getWithRetry(url, {
        headers: API_KEY ? { Accept: 'application/json', 'X-Api-Key': API_KEY }
                         : { Accept: 'application/json' },
        timeout: FETCH_TIMEOUT_MS,
        maxRedirects: 5,
      });
    } catch (err) {
      logSkip(`set:${setId}`, `page ${page} after ${err._attempts} attempts — ${err.response ? `HTTP ${err.response.status}` : err.message}`);
      return null;
    }
    if (totalCount === null) totalCount = resp.data.totalCount ?? 0;
    for (const card of resp.data.data ?? []) {
      out.push({
        id: card.id,
        name: card.name,
        setName: card.set?.name || '',
        rarity: card.rarity || '',
        supertype: card.supertype || '',
        // small first: everything downstream resizes to ≤245px anyway.
        imageUrl: card.images?.small || card.images?.large || null,
        displayUrl: card.images?.large || card.images?.small || null,
      });
    }
    page++;
  } while ((page - 1) * PAGE_SIZE < totalCount);
  return out;
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  fs.mkdirSync(IMG_DIR, { recursive: true });

  if (!fs.existsSync(CARD_DB_FILE)) {
    console.error(`[fetch-refs] FATAL: ${CARD_DB_FILE} not found`);
    process.exit(1);
  }
  const cardDb = JSON.parse(fs.readFileSync(CARD_DB_FILE, 'utf8'));
  let setIds = [...new Set(Object.keys(cardDb).map(k => k.slice(0, k.lastIndexOf('-'))))].sort();
  if (SET_LIMIT) setIds = setIds.slice(0, SET_LIMIT);

  console.log(`[fetch-refs] cache=${CACHE_DIR}`);
  console.log(`[fetch-refs] ${setIds.length} sets | imgConcurrency=${IMG_CONCURRENCY} | ${API_KEY ? 'authenticated' : 'unauthenticated'}`);

  // ---- Phase 1: card lists -------------------------------------------------
  const work = [];
  await asyncPool(SET_CONCURRENCY, setIds, async setId => {
    const cards = await fetchSetCards(setId);
    if (!cards) return;
    for (const c of cards) {
      if (!c.imageUrl) { logSkip(c.id, 'no image URL'); continue; }
      work.push(c);
    }
  });
  work.sort((a, b) => a.id.localeCompare(b.id));
  const listMs = Date.now() - startMs;
  console.log(`[fetch-refs] ${work.length} cards listed in ${(listMs / 1000).toFixed(1)}s`);

  const todo = CARD_LIMIT ? work.slice(0, CARD_LIMIT) : work;

  // ---- Phase 2: download + normalise --------------------------------------
  const manifest = fs.existsSync(MANIFEST_FILE)
    ? JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
    : { version: 1, cacheW: CACHE_W, cacheH: CACHE_H, cards: {} };

  let fetched = 0, cached = 0, failed = 0, srcBytes = 0, outBytes = 0;
  const dlStart = Date.now();

  await asyncPool(IMG_CONCURRENCY, todo, async card => {
    const { setId, number } = splitCardId(card.id);
    const outPath = cachePathFor(setId, number);

    if (manifest.cards[card.id] && fs.existsSync(outPath)) { cached++; return; }

    let buf;
    try {
      const resp = await getWithRetry(card.imageUrl, {
        responseType: 'arraybuffer', timeout: FETCH_TIMEOUT_MS, maxRedirects: 5,
      });
      buf = Buffer.from(resp.data);
    } catch (err) {
      logSkip(card.id, `after ${err._attempts} attempts — ${err.response ? `HTTP ${err.response.status}` : err.message}`);
      failed++; return;
    }

    let webp;
    try {
      webp = await sharp(buf).resize(CACHE_W, CACHE_H, { fit: 'fill' }).webp({ quality: 90 }).toBuffer();
    } catch (err) {
      logSkip(card.id, `decode failed — ${err.message}`);
      failed++; return;
    }

    fs.mkdirSync(dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, webp);

    srcBytes += buf.length;
    outBytes += webp.length;
    manifest.cards[card.id] = {
      set_id: setId, number, name: card.name, setName: card.setName,
      rarity: card.rarity, supertype: card.supertype,
      imageUrl: card.imageUrl, displayUrl: card.displayUrl,
    };

    fetched++;
    if (fetched % 500 === 0) {
      const rate = fetched / ((Date.now() - dlStart) / 1000);
      fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest), 'utf8');
      console.log(`[fetch-refs] ${fetched} fetched (${rate.toFixed(1)}/s) | ${cached} cached | ${failed} failed`);
    }
  });

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest), 'utf8');

  const dlSec = (Date.now() - dlStart) / 1000;
  const totalSec = (Date.now() - startMs) / 1000;
  const mb = n => (n / 1024 / 1024).toFixed(1);

  console.log('');
  console.log('[fetch-refs] ---------------- summary ----------------');
  console.log(`[fetch-refs] fetched      : ${fetched}`);
  console.log(`[fetch-refs] already cached: ${cached}`);
  console.log(`[fetch-refs] failed       : ${failed}`);
  console.log(`[fetch-refs] retried      : ${retryStats.retried} requests needed ${retryStats.attempts} extra attempts`);
  console.log(`[fetch-refs] manifest size: ${Object.keys(manifest.cards).length} cards`);
  console.log(`[fetch-refs] downloaded   : ${mb(srcBytes)} MB source → ${mb(outBytes)} MB cached`);
  if (fetched) {
    console.log(`[fetch-refs] rate         : ${(fetched / dlSec).toFixed(1)} cards/s  (${mb(srcBytes / dlSec)} MB/s)`);
    console.log(`[fetch-refs] per-card     : ${(srcBytes / fetched / 1024).toFixed(1)} KB source, ${(outBytes / fetched / 1024).toFixed(1)} KB cached`);
    const remaining = work.length - Object.keys(manifest.cards).length;
    if (remaining > 0) {
      console.log(`[fetch-refs] projection   : ${remaining} remaining ≈ ${(remaining / (fetched / dlSec) / 60).toFixed(1)} min, ${mb(remaining * (srcBytes / fetched))} MB`);
    }
  }
  console.log(`[fetch-refs] elapsed      : ${totalSec.toFixed(1)}s`);
}

main().catch(err => { console.error('[fetch-refs] FATAL:', err); process.exit(1); });
