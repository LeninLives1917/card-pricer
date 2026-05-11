#!/usr/bin/env node
// scripts/backfill-me1-enrichment.js
//
// One-off backfill for me1 (Mega Evolution) entries in data/card-db.json.
//
// Why: the 2026-05-11 pHash crawler hashed all 178 me1 cards but enriched 0,
// because every me1 entry already had source='pokellector' — a preserved
// source. Pokellector entries carry name/setName/setCode/rarity/hp but lack
// image/cardmarketUrl/tcgplayerUrl/supertype/subtypes, so pHash hits on me1
// fail the `fullCard.reference_image` guard in identifyCore.
//
// What: additive merge from pokemontcg.io. We DO NOT touch source or any
// existing non-empty field on the pokellector entry. We only fill in fields
// that are missing/empty. Source stays 'pokellector' — pokellector's manual
// corrections remain authoritative.
//
// Usage: node scripts/backfill-me1-enrichment.js [--dry-run]
//
// Idempotent: re-running is safe — fields already filled get skipped.

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');

const SET_ID = 'me1';
const POKEMONTCG_BASE = 'https://api.pokemontcg.io/v2';
const PAGE_SIZE = 250;
const FETCH_TIMEOUT_MS = 15_000;
const API_KEY = process.env.POKEMONTCG_API_KEY || null;
const isDryRun = process.argv.includes('--dry-run');

function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

async function fetchSetCards(setId) {
  const cards = [];
  let page = 1;
  let totalCount = null;
  do {
    const url = `${POKEMONTCG_BASE}/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=${PAGE_SIZE}&page=${page}`;
    const headers = { 'Accept': 'application/json' };
    if (API_KEY) headers['X-Api-Key'] = API_KEY;
    const resp = await axios.get(url, { headers, timeout: FETCH_TIMEOUT_MS, maxRedirects: 5 });
    const body = resp.data;
    if (totalCount === null) totalCount = body.totalCount ?? 0;
    for (const card of body.data ?? []) cards.push(card);
    page++;
  } while ((page - 1) * PAGE_SIZE < totalCount);
  return cards;
}

function writeAtomic(path, json) {
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, path);
}

async function main() {
  if (!fs.existsSync(CARD_DB_FILE)) {
    console.error(`FATAL: ${CARD_DB_FILE} not found`);
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(CARD_DB_FILE, 'utf8'));

  const beforeKeys = Object.keys(db).filter(k => k.startsWith(`${SET_ID}-`));
  console.log(`[backfill] loaded card-db: ${Object.keys(db).length} entries, ${beforeKeys.length} ${SET_ID}-* entries`);

  console.log(`[backfill] fetching ${SET_ID} from pokemontcg.io${API_KEY ? ' [authenticated]' : ' [unauthenticated]'} …`);
  const cards = await fetchSetCards(SET_ID);
  console.log(`[backfill] received ${cards.length} cards from pokemontcg.io`);

  let matched = 0;
  let updated = 0;
  let addedNew = 0;
  const fieldFills = { image: 0, cardmarketUrl: 0, tcgplayerUrl: 0, supertype: 0, subtypes: 0, rarity: 0, hp: 0 };

  for (const card of cards) {
    const id = card.id;
    const enriched = {
      image: card.images?.large || card.images?.small || '',
      cardmarketUrl: `https://prices.pokemontcg.io/cardmarket/${card.id}`,
      tcgplayerUrl: `https://prices.pokemontcg.io/tcgplayer/${card.id}`,
      supertype: card.supertype || '',
      subtypes: card.subtypes || [],
      rarity: card.rarity || '',
      hp: card.hp || '',
    };

    const existing = db[id];
    if (!existing) {
      // No existing entry — add a fresh pokemontcg entry.
      db[id] = {
        name: card.name,
        setName: card.set?.name || '',
        setCode: card.set?.ptcgoCode || (card.set?.id || '').toUpperCase(),
        rarity: enriched.rarity,
        hp: enriched.hp,
        supertype: enriched.supertype,
        subtypes: enriched.subtypes,
        image: enriched.image,
        cardmarketUrl: enriched.cardmarketUrl,
        tcgplayerUrl: enriched.tcgplayerUrl,
        source: 'pokemontcg',
      };
      addedNew++;
      continue;
    }

    matched++;
    let touched = false;
    for (const [field, value] of Object.entries(enriched)) {
      if (isEmpty(existing[field]) && !isEmpty(value)) {
        existing[field] = value;
        fieldFills[field]++;
        touched = true;
      }
    }
    if (touched) updated++;
  }

  console.log(`[backfill] matched: ${matched}, updated: ${updated}, added-new: ${addedNew}`);
  console.log('[backfill] field fills:', fieldFills);

  if (isDryRun) {
    console.log('[backfill] DRY RUN — no write');
    return;
  }

  writeAtomic(CARD_DB_FILE, JSON.stringify(db));
  const stat = fs.statSync(CARD_DB_FILE);
  console.log(`[backfill] wrote ${CARD_DB_FILE} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  // Verify by re-reading and sampling.
  const after = JSON.parse(fs.readFileSync(CARD_DB_FILE, 'utf8'));
  const sample = after[`${SET_ID}-1`];
  if (sample) {
    console.log(`[backfill] sample ${SET_ID}-1 after merge:`);
    console.log(JSON.stringify(sample, null, 2));
  }
}

main().catch(err => {
  console.error('[backfill] FATAL:', err.message);
  if (err.response) console.error('[backfill] status:', err.response.status);
  process.exit(1);
});
