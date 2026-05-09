#!/usr/bin/env node
// scripts/build-phash-db.js
//
// Offline crawler — builds data/card-phashes.json by fetching card images
// directly from pokemontcg.io (NOT from entry.image in card-db.json).
//
// Usage:
//   node scripts/build-phash-db.js
//   node scripts/build-phash-db.js --dry-run   # first set only (alphabetical)
//
// Resumable: cards already present in card-phashes.json are skipped.
// Writes incrementally every 500 successful hashes.
// Errors logged to data/phash-crawler-skipped.log — run continues.
//
// API key (optional): set POKEMONTCG_API_KEY env var for higher rate limits.
// Expected runtime: ~40 min for ~20k cards at concurrency 5 (unauthenticated).

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';

import { computePhash, loadIndex, addToIndex, flushNow } from '../pricing/phash.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');
const PHASH_FILE = join(REPO_ROOT, 'data', 'card-phashes.json');
const SKIP_LOG = join(REPO_ROOT, 'data', 'phash-crawler-skipped.log');

const SET_CONCURRENCY = 4;    // parallel set-fetch requests against pokemontcg.io
const IMG_CONCURRENCY = 5;    // parallel image downloads
const SAVE_EVERY = 500;
const FETCH_TIMEOUT_MS = 10_000;
const POKEMONTCG_BASE = 'https://api.pokemontcg.io/v2';
const PAGE_SIZE = 250;

const isDryRun = process.argv.includes('--dry-run');
const API_KEY = process.env.POKEMONTCG_API_KEY || null;

// =============================================================================
// Minimal async pool — hand-rolled, no p-limit dep
// =============================================================================

async function asyncPool(concurrency, items, taskFn) {
  const inFlight = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => taskFn(item)).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);
}

// =============================================================================
// Logging helpers
// =============================================================================

function logSkip(key, reason) {
  const line = `${new Date().toISOString()} SKIP ${key} — ${reason}\n`;
  fs.appendFileSync(SKIP_LOG, line, 'utf8');
}

// =============================================================================
// pokemontcg.io helpers
// =============================================================================

function apiHeaders() {
  const h = { 'Accept': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return h;
}

/**
 * Fetch all cards for a given setId from pokemontcg.io, paginating as needed.
 * Returns an array of { id, imageUrl } objects (imageUrl may be null).
 * On non-retryable HTTP error, logs and returns null (caller skips the set).
 */
async function fetchSetCards(setId) {
  const cards = [];
  let page = 1;
  let totalCount = null;

  do {
    const url = `${POKEMONTCG_BASE}/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=${PAGE_SIZE}&page=${page}`;
    let resp;
    try {
      resp = await axios.get(url, {
        headers: apiHeaders(),
        timeout: FETCH_TIMEOUT_MS,
        maxRedirects: 5,
      });
    } catch (err) {
      const status = err.response ? err.response.status : null;
      const reason = status ? `HTTP ${status}` : err.message;
      logSkip(`set:${setId}`, `page ${page} fetch failed — ${reason}`);
      return null;
    }

    const body = resp.data;
    if (totalCount === null) totalCount = body.totalCount ?? 0;

    for (const card of body.data ?? []) {
      const imageUrl = card.images?.large || card.images?.small || null;
      cards.push({ id: card.id, imageUrl });
    }

    page++;
  } while ((page - 1) * PAGE_SIZE < totalCount);

  return cards;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const startMs = Date.now();
  console.log(`[phash-crawler] starting${isDryRun ? ' (DRY RUN — first set only)' : ''}${API_KEY ? ' [authenticated]' : ' [unauthenticated]'}`);

  // Load card-db for the set-ID list (we no longer read entry.image from it).
  if (!fs.existsSync(CARD_DB_FILE)) {
    console.error(`[phash-crawler] FATAL: ${CARD_DB_FILE} not found`);
    process.exit(1);
  }
  const cardDbObj = JSON.parse(fs.readFileSync(CARD_DB_FILE, 'utf8'));

  // Discover unique set IDs from card-db keys.
  // Key shape is always "<setId>-<number>" with exactly one hyphen group
  // (verified: no number field contains a hyphen). Split on LAST hyphen.
  const allSetIds = [...new Set(
    Object.keys(cardDbObj).map(k => k.slice(0, k.lastIndexOf('-')))
  )].sort();

  let setIds = allSetIds;
  if (isDryRun) {
    setIds = allSetIds.slice(0, 1);
    console.log(`[phash-crawler] dry-run: processing set "${setIds[0]}" only`);
  } else {
    console.log(`[phash-crawler] ${setIds.length} unique sets discovered`);
  }

  // Load existing phash index (for skip/resume logic).
  await loadIndex();

  let existingCardIds = new Set();
  if (fs.existsSync(PHASH_FILE)) {
    const existing = JSON.parse(fs.readFileSync(PHASH_FILE, 'utf8'));
    for (const card of Object.values(existing)) {
      existingCardIds.add(`${card.set_id}-${card.number}`);
    }
    console.log(`[phash-crawler] loaded ${existingCardIds.size} already-hashed cards from ${PHASH_FILE}`);
  }

  // Phase 1: fetch card lists from pokemontcg.io (SET_CONCURRENCY in-flight).
  // Build a combined work list of { id, imageUrl } across all sets.
  let workItems = [];
  const setHashCounts = {};   // setId -> count of hashed cards, for final summary
  const fetchedSets = new Set();

  console.log('[phash-crawler] fetching card lists from pokemontcg.io …');

  await asyncPool(SET_CONCURRENCY, setIds, async (setId) => {
    const cards = await fetchSetCards(setId);
    if (cards === null) {
      logSkip(`set:${setId}`, 'skipping entire set due to fetch error');
      return;
    }
    fetchedSets.add(setId);
    setHashCounts[setId] = 0;

    for (const { id, imageUrl } of cards) {
      if (!imageUrl) {
        logSkip(id, 'no image URL in API response');
        continue;
      }
      if (existingCardIds.has(id)) continue;   // already hashed — resume skip
      workItems.push({ id, imageUrl });
    }
  });

  console.log(`[phash-crawler] ${workItems.length} cards to hash across ${fetchedSets.size} sets`);

  // Phase 2: download + hash images (IMG_CONCURRENCY in-flight).
  let hashed = 0;
  let skipped = 0;
  let sinceLastSave = 0;

  async function processCard({ id, imageUrl }) {
    // Split on LAST hyphen: "sv1-123" → setId="sv1", number="123"
    const lastDash = id.lastIndexOf('-');
    const setId = id.slice(0, lastDash);
    const number = id.slice(lastDash + 1);

    let imgBuffer;
    try {
      const resp = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxRedirects: 5,
      });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`HTTP ${resp.status}`);
      }
      imgBuffer = Buffer.from(resp.data);
    } catch (err) {
      const reason = err.response ? `HTTP ${err.response.status}` : err.message;
      logSkip(id, reason);
      skipped++;
      return;
    }

    let hash;
    try {
      hash = await computePhash(imgBuffer);
    } catch (err) {
      logSkip(id, `computePhash failed: ${err.message}`);
      skipped++;
      return;
    }

    await addToIndex(hash, { set_id: setId, number });

    hashed++;
    sinceLastSave++;
    if (setHashCounts[setId] !== undefined) setHashCounts[setId]++;

    if (sinceLastSave >= SAVE_EVERY) {
      await flushNow();
      sinceLastSave = 0;
      console.log(`[phash-crawler] checkpoint: ${hashed} hashed, ${skipped} skipped`);
    }
  }

  await asyncPool(IMG_CONCURRENCY, workItems, processCard);

  // Final flush
  await flushNow();

  const elapsedMin = ((Date.now() - startMs) / 60_000).toFixed(1);
  const total = hashed + skipped;

  // Per-set summary (only sets that had new hashes)
  const perSetSummary = Object.entries(setHashCounts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}:${n}`)
    .join(', ');

  console.log(
    `[phash-crawler] done — hashed: ${hashed}, skipped: ${skipped}, total: ${total}, ` +
    `sets: ${fetchedSets.size}, elapsed: ${elapsedMin} min` +
    (perSetSummary ? `\n[phash-crawler] per-set hashes: ${perSetSummary}` : '')
  );
}

main().catch(err => {
  console.error('[phash-crawler] FATAL:', err);
  process.exit(1);
});
