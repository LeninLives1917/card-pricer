#!/usr/bin/env node
// =================================================================
// build-card-db.js — Download all Pokemon TCG cards from pokemontcg.io
// and save a compact local DB as data/card-db.json.
//
// Usage:  node scripts/build-card-db.js
//
// This creates data/card-db.json which the server loads on startup.
// Cards are keyed by "{setId}-{number}" for instant O(1) lookup.
// =================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;
const CONCURRENT = 4; // parallel requests to stay polite
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(DATA_DIR, 'card-db.json');

function fetchPage(page) {
  const url = `${API_BASE}?pageSize=${PAGE_SIZE}&page=${page}&select=id,name,number,rarity,set,hp,supertype,subtypes`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          reject(new Error(`Page ${page}: JSON parse error`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchWithRetry(page, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchPage(page);
    } catch (e) {
      console.log(`  Page ${page} failed (attempt ${i + 1}/${retries}): ${e.message}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`Page ${page} failed after ${retries} retries`);
}

async function main() {
  console.log('Fetching page 1 to get total count...');
  const first = await fetchWithRetry(1);
  const totalCount = first.totalCount || 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`Total cards: ${totalCount}, pages: ${totalPages}`);

  const db = {};
  let processed = 0;

  function addCards(cards) {
    for (const c of cards) {
      const setId = c.set?.id || '';
      const num = c.number || '';
      const key = `${setId}-${num}`;
      db[key] = {
        n: c.name,                          // name
        s: setId,                           // set id
        sn: c.set?.name || '',              // set name
        sc: (c.set?.ptcgoCode || '').toUpperCase(), // set code (printed)
        num: num,                           // card number
        r: c.rarity || '',                  // rarity
        hp: c.hp || '',                     // HP
        st: c.supertype || '',              // supertype (Pokemon, Trainer, Energy)
        sub: (c.subtypes || []).join(','),   // subtypes (ex, V, VMAX, etc)
        img: c.set?.images?.logo ? '' : '',  // don't store images to save space
      };
      processed++;
    }
  }

  // Process page 1
  addCards(first.data || []);
  console.log(`  Page 1/${totalPages} — ${processed} cards so far`);

  // Fetch remaining pages in batches of CONCURRENT
  for (let batch = 2; batch <= totalPages; batch += CONCURRENT) {
    const pages = [];
    for (let p = batch; p < batch + CONCURRENT && p <= totalPages; p++) {
      pages.push(p);
    }
    const results = await Promise.all(pages.map(p => fetchWithRetry(p)));
    for (const result of results) {
      addCards(result.data || []);
    }
    console.log(`  Pages ${pages[0]}-${pages[pages.length - 1]}/${totalPages} — ${processed} cards so far`);
  }

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write compact JSON
  fs.writeFileSync(OUT_FILE, JSON.stringify(db));
  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`\nDone! ${processed} cards saved to ${OUT_FILE} (${sizeMB} MB)`);

  // Also write a pretty-printed version for debugging
  const prettyFile = path.join(DATA_DIR, 'card-db-pretty.json');
  fs.writeFileSync(prettyFile, JSON.stringify(db, null, 2));
  console.log(`Pretty version: ${prettyFile}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
