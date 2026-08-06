#!/usr/bin/env node
// scripts/build-phash-db.js
//
// Offline crawler — builds data/card-phashes.json by fetching card images
// directly from pokemontcg.io (NOT from entry.image in card-db.json).
// Also enriches data/card-db.json with full card metadata from the same API
// response, so pHash hits resolve to fully-enriched entries on Render.
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
// Expected runtime: ~60-75 min for ~20k cards at concurrency 2 (unauthenticated).
//
// Source-priority for card-db enrichment:
//   Overwritten : source === 'sheet' || source === 'pokemontcg' || no entry yet
//   Preserved   : source === 'pokellector' | 'manual' | 'tcggo' | 'fallback'
//                 (these are higher-trust manual corrections — never overwrite)
//
// Race with server dirty-save: the production server flushes its in-memory
// CARD_DB to card-db.json every 5 min. This crawler checkpoints every 500
// hashes (~80 s at observed rate), so crawler writes dominate. The atomic
// write-to-tmp + rename pattern below guarantees no partial reads by the
// server's _card-db-boot.js even if a boot coincides with a checkpoint.

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';
import sharp from 'sharp';

import { computePhash, computeDhash, computeWhash, cropToCard, loadIndex, addToIndex, flushNow } from '../pricing/phash.js';
import {
  getWithRetry, fetchAllSets, reconcile, formatReconciliation,
} from '../pricing/pokemontcg-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');
const PHASH_FILE = join(REPO_ROOT, 'data', 'card-phashes.json');
const SKIP_LOG = join(REPO_ROOT, 'data', 'phash-crawler-skipped.log');
const MARKER_PATH = join(REPO_ROOT, 'data', '.crawl-active');
// Sidecar manifest: what this build actually produced, versus what upstream
// said existed. Read by the pre-show preflight check and /api/health, so
// "is the index complete and fresh?" is answerable without re-crawling.
const MANIFEST_FILE = join(REPO_ROOT, 'data', 'card-index-manifest.json');

// Concurrency is env-configurable so the same script can run in two very
// different places:
//   Render (512 MB container, also serving traffic) — IMG_CONCURRENCY=2.
//     Concurrency 5 held 25 Sharp variant buffers (~25 MB) in flight and pushed
//     the container past its memory limit; 2 was the safe ceiling there.
//   Operator laptop (V3 default) — IMG_CONCURRENCY=16. No traffic to protect,
//     no 512 MB cap, and the small-image switch below cuts per-card bytes ~20×,
//     so the memory argument for throttling no longer applies.
const SET_CONCURRENCY = Number(process.env.SET_CONCURRENCY) || 4;
const IMG_CONCURRENCY = Number(process.env.IMG_CONCURRENCY) || 16;

// Reference-image size. pokemontcg.io serves two renditions per card:
//   large ("<id>_hires.png") — ~700 KB, 745×1040
//   small ("<id>.png")       — ~35 KB,  245×342
// Everything downstream downscales to 32×32 (pHash/wHash) or 9×8 (dHash), so
// the hi-res pixels are discarded immediately. small is ~20× less bandwidth for
// no measurable descriptor change. Set PHASH_IMAGE_SIZE=large to A/B this.
const IMAGE_SIZE = process.env.PHASH_IMAGE_SIZE === 'large' ? 'large' : 'small';
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

/**
 * Fetch all cards for a given setId from pokemontcg.io, paginating as needed.
 * Returns an array of { id, imageUrl, enriched } objects (imageUrl may be null).
 * enriched is the fully-built card-db entry ready for merging.
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
      // Retrying fetch: pokemontcg.io returns intermittent 500/502 on valid
      // requests (~40% measured). Without this, one 500 dropped the whole set.
      resp = await getWithRetry(url, { timeout: FETCH_TIMEOUT_MS });
    } catch (err) {
      const status = err.response ? err.response.status : null;
      const reason = status ? `HTTP ${status}` : err.message;
      logSkip(`set:${setId}`, `page ${page} failed after ${err._attempts} attempts — ${reason}`);
      return null;
    }

    const body = resp.data;
    if (totalCount === null) totalCount = body.totalCount ?? 0;

    for (const card of body.data ?? []) {
      // Hashing source only — deliberately NOT card-db's `image` field, which
      // stays hi-res because it is what the operator sees on screen.
      const imageUrl = IMAGE_SIZE === 'large'
        ? (card.images?.large || card.images?.small || null)
        : (card.images?.small || card.images?.large || null);
      const enriched = buildEnrichedEntry(card);
      cards.push({ id: card.id, imageUrl, enriched });
    }

    page++;
  } while ((page - 1) * PAGE_SIZE < totalCount);

  return cards;
}

/**
 * Build a card-db entry from a pokemontcg.io API card object.
 * Uses CDN redirect URLs for cardmarketUrl and tcgplayerUrl (derived from
 * card.id) — these are identical to card.cardmarket.url / card.tcgplayer.url
 * but don't require those optional fields to be present in the response.
 */
function buildEnrichedEntry(card) {
  const entry = {
    name: card.name,
    setName: card.set?.name || '',
    setCode: card.set?.ptcgoCode || (card.set?.id || '').toUpperCase(),
    rarity: card.rarity || '',
    hp: card.hp || '',
    supertype: card.supertype || '',
    subtypes: card.subtypes || [],
    image: card.images?.large || card.images?.small || '',
    cardmarketUrl: `https://prices.pokemontcg.io/cardmarket/${card.id}`,
    tcgplayerUrl: `https://prices.pokemontcg.io/tcgplayer/${card.id}`,
    source: 'pokemontcg',
  };
  return entry;
}

// Sources that must NOT be overwritten — they represent higher-trust manual
// corrections (e.g. pokellector entries fix known pokemontcg.io data errors).
const PRESERVED_SOURCES = new Set(['pokellector', 'manual', 'tcggo', 'fallback']);

/**
 * Atomically write cardDbObj to CARD_DB_FILE using a tmp-file + rename so
 * the server's _card-db-boot.js never reads a partial write.
 */
function flushCardDb(cardDbObj) {
  const json = JSON.stringify(cardDbObj);
  const tmpPath = CARD_DB_FILE + '.tmp';
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, CARD_DB_FILE);
}

// =============================================================================
// Main
// =============================================================================

function removeMarker() {
  try { fs.unlinkSync(MARKER_PATH); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

process.on('SIGINT', () => { removeMarker(); process.exit(130); });
process.on('SIGTERM', () => { removeMarker(); process.exit(143); });

async function main() {
  fs.writeFileSync(MARKER_PATH, new Date().toISOString(), 'utf8');
  const startMs = Date.now();
  console.log(`[phash-crawler] starting${isDryRun ? ' (DRY RUN — first set only)' : ''}${API_KEY ? ' [authenticated]' : ' [unauthenticated]'}`);
  console.log(`[phash-crawler] image=${IMAGE_SIZE} setConcurrency=${SET_CONCURRENCY} imgConcurrency=${IMG_CONCURRENCY}`);

  // Load card-db: used for set-ID discovery AND as the enrichment target.
  if (!fs.existsSync(CARD_DB_FILE)) {
    console.error(`[phash-crawler] FATAL: ${CARD_DB_FILE} not found`);
    process.exit(1);
  }
  const cardDbObj = JSON.parse(fs.readFileSync(CARD_DB_FILE, 'utf8'));

  // Set discovery MUST come from upstream, not from card-db's own keys.
  //
  // Deriving set IDs from the artifact being built means a set absent from
  // card-db can never be crawled — new releases are invisible permanently, not
  // just until the next run. Measured cost: 23 of 35 failures in the V3
  // benchmark were cards from `me5` (Pitch Black), released three weeks before
  // the photos were taken. A card shop's stock skews hard toward the newest set,
  // so this bug lands precisely where it hurts most.
  const localSetIds = new Set(
    Object.keys(cardDbObj).map(k => k.slice(0, k.lastIndexOf('-')))
  );

  let upstreamSets = [];
  try {
    upstreamSets = await fetchAllSets();
    const fresh = upstreamSets.map(s => s.id).filter(id => !localSetIds.has(id));
    console.log(`[phash-crawler] ${upstreamSets.length} sets known upstream` +
      (fresh.length ? `; ${fresh.length} not in card-db: ${fresh.join(', ')}` : ''));
    for (const s of upstreamSets) localSetIds.add(s.id);
  } catch (err) {
    // Degrade to the old behaviour, but never silently — a quiet fallback here
    // is exactly the bug this block exists to prevent.
    console.warn(`[phash-crawler] WARNING: could not list upstream sets (${err.message}) — ` +
      'falling back to card-db set IDs only. NEW SETS WILL BE MISSED.');
  }

  const allSetIds = [...localSetIds].sort();

  let setIds = allSetIds;
  if (isDryRun) {
    setIds = allSetIds.slice(0, 1);
    console.log(`[phash-crawler] dry-run: processing set "${setIds[0]}" only`);
  } else {
    console.log(`[phash-crawler] ${setIds.length} unique sets discovered`);
  }

  // Load existing phash index (for skip/resume logic).
  await loadIndex();

  // Build the skip-set from the existing phash file.
  // v1 format (flat object, no version field): ALL cards must be reprocessed
  //   for the v2 upgrade (5 variants × 3 hash types = 15 entries per card).
  // v2 format ({ version:2, phash:{}, dhash:{}, whash:{} }): skip only cards
  //   that are fully v2 — present in all three hash maps.
  let existingCardIds = new Set();
  if (fs.existsSync(PHASH_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(PHASH_FILE, 'utf8'));
    if (parsed.version === 2) {
      function identitySetFor(hashMap) {
        const ids = new Set();
        for (const card of Object.values(hashMap)) {
          if (card?.set_id && card?.number) ids.add(`${card.set_id}-${card.number}`);
        }
        return ids;
      }
      const phashIds = identitySetFor(parsed.phash || {});
      const dhashIds = identitySetFor(parsed.dhash || {});
      const whashIds = identitySetFor(parsed.whash || {});
      // A card is fully v2 only when it appears in all three maps.
      existingCardIds = new Set([...phashIds].filter(id => dhashIds.has(id) && whashIds.has(id)));
      console.log(`[phash-crawler] v2 index detected — ${existingCardIds.size} cards already fully v2 (phash+dhash+whash), will skip`);
    } else {
      // v1 index: skip-set stays empty; every card gets reprocessed.
      console.log('[phash-crawler] v1 index detected — all cards will be reprocessed for v2 upgrade');
    }
  }

  // Phase 1: fetch card lists from pokemontcg.io (SET_CONCURRENCY in-flight).
  // Build a combined work list of { id, imageUrl, enriched } across all sets.
  // Enrichment happens here — every card returned by the API is merged into
  // cardDbObj regardless of whether its pHash is already known.
  let workItems = [];
  const setHashCounts = {};    // setId -> count of newly hashed cards
  const setEnrichCounts = {};  // setId -> count of enriched card-db entries
  const fetchedSets = new Set();
  let totalEnriched = 0;

  console.log('[phash-crawler] fetching card lists from pokemontcg.io …');

  await asyncPool(SET_CONCURRENCY, setIds, async (setId) => {
    const cards = await fetchSetCards(setId);
    if (cards === null) {
      logSkip(`set:${setId}`, 'skipping entire set due to fetch error');
      return;
    }
    fetchedSets.add(setId);
    setHashCounts[setId] = 0;
    setEnrichCounts[setId] = 0;

    for (const { id, imageUrl, enriched } of cards) {
      // Enrich card-db: preserve higher-trust manual sources, overwrite sheet/pokemontcg.
      const existing = cardDbObj[id];
      if (!existing || !PRESERVED_SOURCES.has(existing.source)) {
        cardDbObj[id] = enriched;
        setEnrichCounts[setId]++;
        totalEnriched++;
      }

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
      // Image downloads retry too — the CDN drops requests under sustained
      // load, and a dropped image is a card silently absent from the index.
      const resp = await getWithRetry(imageUrl, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
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

    // Step 1: cropToCard normalises the CDN image (near-noop for tight CDN
    // crops, but ensures the same pipeline as the phone-photo path).
    let baseBuffer;
    try {
      baseBuffer = await cropToCard(imgBuffer);
    } catch {
      baseBuffer = imgBuffer; // cropToCard already guards internally; belt-and-braces
    }

    // Step 2 + 3: Build each of the 5 visual variants ONE AT A TIME (sequential,
    // not parallel) so at most one Sharp buffer (~1 MB) is live at a time.
    // Previously Promise.all held all 5 simultaneously (~5 MB per card × concurrency).
    // Each variant is fully hashed and added to the index before the next is built;
    // the buffer reference is dropped so it can be GC'd immediately.
    async function makeVariant(fn) {
      try { return await fn(); } catch { return null; }
    }

    const variantFns = [
      // Original (already cropped/normalised)
      () => Promise.resolve(baseBuffer),
      // 5% inset crop (simulates tighter phone framing)
      async () => {
        const meta = await sharp(baseBuffer).metadata();
        const iw = Math.max(1, Math.round((meta.width  || 600) * 0.05));
        const ih = Math.max(1, Math.round((meta.height || 840) * 0.05));
        return sharp(baseBuffer)
          .extract({
            left: iw, top: ih,
            width:  Math.max(1, (meta.width  || 600) - iw * 2),
            height: Math.max(1, (meta.height || 840) - ih * 2),
          })
          .resize(600, 840, { fit: 'fill' })
          .toBuffer();
      },
      // 10% inset crop (simulates looser phone framing)
      async () => {
        const meta = await sharp(baseBuffer).metadata();
        const iw = Math.max(1, Math.round((meta.width  || 600) * 0.10));
        const ih = Math.max(1, Math.round((meta.height || 840) * 0.10));
        return sharp(baseBuffer)
          .extract({
            left: iw, top: ih,
            width:  Math.max(1, (meta.width  || 600) - iw * 2),
            height: Math.max(1, (meta.height || 840) - ih * 2),
          })
          .resize(600, 840, { fit: 'fill' })
          .toBuffer();
      },
      // +15% brightness (simulates flash / bright room)
      () => sharp(baseBuffer).modulate({ brightness: 1.15 }).toBuffer(),
      // -15% brightness (simulates dim room)
      () => sharp(baseBuffer).modulate({ brightness: 0.85 }).toBuffer(),
    ];

    // Process variants sequentially: build → hash → index → drop buffer → next.
    // Peak Sharp memory per card is ~1 MB instead of ~5 MB (one buffer at a time).
    const cardIdent = { set_id: setId, number };
    let addedCount = 0;

    for (const variantFn of variantFns) {
      const variantBuf = await makeVariant(variantFn);
      if (!variantBuf) continue;
      let phash, dhash, whash;
      try {
        [phash, dhash, whash] = await Promise.all([
          computePhash(variantBuf),
          computeDhash(variantBuf),
          computeWhash(variantBuf),
        ]);
      } catch (err) {
        logSkip(id, `hash computation failed for variant: ${err.message}`);
        continue;
      }
      await addToIndex({ phash, dhash, whash }, cardIdent);
      addedCount++;
    }

    if (addedCount === 0) {
      logSkip(id, 'all variants failed to hash');
      skipped++;
      return;
    }

    hashed++;
    sinceLastSave++;
    if (setHashCounts[setId] !== undefined) setHashCounts[setId]++;

    if (sinceLastSave >= SAVE_EVERY) {
      await flushNow();
      flushCardDb(cardDbObj);
      sinceLastSave = 0;
      console.log(`[phash-crawler] checkpoint: ${hashed} hashed, ${skipped} skipped, ${totalEnriched} card-db enriched`);
    }
  }

  await asyncPool(IMG_CONCURRENCY, workItems, processCard);

  // Final flush — pHash index and card-db enrichment.
  await flushNow();
  flushCardDb(cardDbObj);
  // Marker intentionally NOT removed on success. The marker means "dirty-save
  // paused, awaiting operator restart." Only a server boot clears it (proving
  // the restart happened). SIGINT/SIGTERM/error paths still call removeMarker().

  const elapsedMin = ((Date.now() - startMs) / 60_000).toFixed(1);
  const total = hashed + skipped;

  // Per-set summary (only sets that had new hashes or enrichment)
  const activeSets = new Set([
    ...Object.keys(setHashCounts).filter(s => setHashCounts[s] > 0),
    ...Object.keys(setEnrichCounts).filter(s => setEnrichCounts[s] > 0),
  ]);
  const perSetSummary = [...activeSets].sort()
    .map(s => `${s}: hashes=${setHashCounts[s] ?? 0} enriched=${setEnrichCounts[s] ?? 0}`)
    .join(', ');

  console.log(
    `[phash-crawler] done — hashed: ${hashed}, skipped: ${skipped}, ` +
    `card-db-enriched: ${totalEnriched}, sets: ${fetchedSets.size}, elapsed: ${elapsedMin} min` +
    (perSetSummary ? `\n[phash-crawler] per-set: ${perSetSummary}` : '')
  );
  // ---- reconciliation ------------------------------------------------------
  // A build that reports success while holding less data than upstream has is
  // the signature behind three separate incidents: the index that was never
  // populated, the silently dropped set, and new releases going missing. All
  // three were invisible because nothing compared local against upstream.
  let reconciliationOk = true;
  if (upstreamSets.length) {
    const r = reconcile(cardDbObj, upstreamSets);
    console.log(`[phash-crawler] reconciliation: ${formatReconciliation(r)}`);
    reconciliationOk = r.ok;

    const manifest = {
      built_at: new Date().toISOString(),
      tool: 'build-phash-db',
      card_count: r.localTotal,
      set_count: new Set(Object.keys(cardDbObj).map(k => k.slice(0, k.lastIndexOf('-')))).size,
      upstream_total: r.upstreamTotal,
      upstream_set_count: upstreamSets.length,
      coverage: Number(r.coverage.toFixed(4)),
      missing_sets: r.missingSets.map(s => s.id),
      short_sets: r.shortSets.map(s => `${s.id}:${s.have}/${s.expected}`),
      hashed_this_run: hashed,
      skipped_this_run: skipped,
      ok: r.ok,
    };
    const tmp = MANIFEST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(tmp, MANIFEST_FILE);
    console.log(`[phash-crawler] wrote ${MANIFEST_FILE}`);
  } else {
    console.warn('[phash-crawler] no upstream set list — reconciliation SKIPPED, coverage unknown');
    reconciliationOk = false;
  }

  console.log('[phash-crawler] marker data/.crawl-active LEFT IN PLACE — server\'s dirty-save will remain paused until you restart Render.');
  console.log('[phash-crawler] NEXT: Render dashboard → Manual Deploy → Deploy Latest Commit. The server\'s boot will load the enriched card-db.json and clear the marker.');

  // Exit non-zero on incomplete coverage so a scheduled run fails loudly rather
  // than leaving a half-built index that looks finished.
  if (!reconciliationOk) {
    console.error('[phash-crawler] FAILING: coverage below threshold or unverifiable. ' +
      'Re-run to pick up the missing sets.');
    process.exitCode = 1;
  }
}

main().catch(err => {
  removeMarker();
  console.error('[phash-crawler] FATAL:', err);
  process.exit(1);
});
