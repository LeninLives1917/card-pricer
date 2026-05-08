#!/usr/bin/env node
// scripts/build-phash-db.js
//
// Offline crawler — builds data/card-phashes.json by fetching each card's
// reference image from card-db.json and computing its pHash.
//
// Usage:
//   node scripts/build-phash-db.js
//   node scripts/build-phash-db.js --dry-run   # first 50 cards only
//
// Resumable: cards already present in card-phashes.json are skipped.
// Writes incrementally every 500 successful hashes.
// Errors logged to data/phash-crawler-skipped.log — run continues.
//
// Expected runtime: ~40 min for ~20k cards at concurrency 5.
// Render-shell smoke test: use --dry-run (50 cards, ~30 s).

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

const CONCURRENCY = 5;
const SAVE_EVERY = 500;
const FETCH_TIMEOUT_MS = 10_000;
const DRY_RUN_LIMIT = 50;

const isDryRun = process.argv.includes('--dry-run');

// =============================================================================
// Minimal async pool — hand-rolled, no p-limit dep
// =============================================================================

// Runs `taskFn` over each item in `items` with at most `concurrency` tasks
// in-flight. taskFn must return a Promise.
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
// Main
// =============================================================================

async function main() {
  const startMs = Date.now();
  console.log(`[phash-crawler] starting${isDryRun ? ' (DRY RUN — first 50 cards)' : ''}`);

  // Load existing card-db
  if (!fs.existsSync(CARD_DB_FILE)) {
    console.error(`[phash-crawler] FATAL: ${CARD_DB_FILE} not found`);
    process.exit(1);
  }
  const cardDbRaw = fs.readFileSync(CARD_DB_FILE, 'utf8');
  const cardDbObj = JSON.parse(cardDbRaw);

  // Load existing phash index (for skip/resume logic).
  // loadIndex() reads PHASH_FILE into the module's internal _index Map.
  await loadIndex();

  // Build the already-done set from the file directly (hex keys).
  let existingHexKeys = new Set();
  if (fs.existsSync(PHASH_FILE)) {
    const existing = JSON.parse(fs.readFileSync(PHASH_FILE, 'utf8'));
    // We key the skip-set by card identity (set_id-number) not hash, so
    // we can skip even when the same card appears under a different framing.
    for (const card of Object.values(existing)) {
      existingHexKeys.add(`${card.set_id}-${card.number}`);
    }
    console.log(`[phash-crawler] loaded ${existingHexKeys.size} already-hashed cards from ${PHASH_FILE}`);
  }

  // Collect work items: entries with an image URL, not yet in the index.
  let allEntries = Object.entries(cardDbObj)
    .filter(([, entry]) => !!entry.image)
    .filter(([key]) => !existingHexKeys.has(key));

  if (isDryRun) {
    allEntries = allEntries.slice(0, DRY_RUN_LIMIT);
    console.log(`[phash-crawler] dry-run: processing ${allEntries.length} cards`);
  } else {
    console.log(`[phash-crawler] ${allEntries.length} cards to hash`);
  }

  let hashed = 0;
  let skipped = 0;
  let sinceLastSave = 0;

  // In-memory accumulator for the new hashes (separate from the module's _index
  // which already contains the pre-existing ones).  We write via flushNow() so
  // the module's _index state is authoritative on disk.
  async function processEntry([key, entry]) {
    const [setId, ...numParts] = key.split('-');
    const number = numParts.join('-');
    const url = entry.image;

    let imgBuffer;
    try {
      const resp = await axios.get(url, {
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
      logSkip(key, reason);
      skipped++;
      return;
    }

    let hash;
    try {
      hash = await computePhash(imgBuffer);
    } catch (err) {
      logSkip(key, `computePhash failed: ${err.message}`);
      skipped++;
      return;
    }

    // addToIndex manages the debounce timer; flushNow() overrides it at
    // our own cadence (every SAVE_EVERY cards) so the crawler controls
    // when the 2 MB disk write happens rather than the 5 s idle timer.
    await addToIndex(hash, { set_id: setId, number });

    hashed++;
    sinceLastSave++;

    if (sinceLastSave >= SAVE_EVERY) {
      await flushNow();
      sinceLastSave = 0;
      console.log(`[phash-crawler] checkpoint: ${hashed} hashed, ${skipped} skipped`);
    }
  }

  await asyncPool(CONCURRENCY, allEntries, processEntry);

  // Final flush
  await flushNow();

  const elapsedMin = ((Date.now() - startMs) / 60_000).toFixed(1);
  const total = hashed + skipped;
  console.log(`[phash-crawler] done — hashed: ${hashed}, skipped: ${skipped}, total: ${total}, elapsed: ${elapsedMin} min`);
}

main().catch(err => {
  console.error('[phash-crawler] FATAL:', err);
  process.exit(1);
});
