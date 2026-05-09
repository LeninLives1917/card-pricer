#!/usr/bin/env node
// scripts/diag-cardb.js
//
// One-shot diagnostic: prints everything needed to debug the
// "crawler reports 102 enriched but file shows 0" mystery.
// Reads data/card-db.json and reports size, entry count, source
// distribution, and a sample base1 entry.
//
// Usage: node scripts/diag-cardb.js

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');

console.log('=== card-db.json diagnostic ===');
console.log('Path resolved to:', CARD_DB_FILE);

let stat;
try {
  stat = fs.statSync(CARD_DB_FILE);
} catch (err) {
  console.log('FATAL: cannot stat file:', err.message);
  process.exit(1);
}

console.log('Size (bytes):', stat.size);
console.log('Size (MB):', (stat.size / 1024 / 1024).toFixed(2));
console.log('Last modified:', stat.mtime.toISOString());
console.log();

const tmpStat = (() => { try { return fs.statSync(CARD_DB_FILE + '.tmp'); } catch { return null; } })();
console.log('.tmp file present?', tmpStat ? `YES (${tmpStat.size} bytes, mtime ${tmpStat.mtime.toISOString()})` : 'no');
console.log();

let raw;
try {
  raw = fs.readFileSync(CARD_DB_FILE, 'utf8');
} catch (err) {
  console.log('FATAL: cannot read file:', err.message);
  process.exit(1);
}

console.log('First 300 raw bytes:');
console.log(JSON.stringify(raw.slice(0, 300)));
console.log();

let obj;
try {
  obj = JSON.parse(raw);
} catch (err) {
  console.log('FATAL: cannot parse JSON:', err.message);
  process.exit(1);
}

const keys = Object.keys(obj);
console.log('Total entries:', keys.length);
console.log();

const sourceCounts = {};
for (const v of Object.values(obj)) {
  const src = v.source || '(none)';
  sourceCounts[src] = (sourceCounts[src] || 0) + 1;
}
console.log('Source distribution:');
for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${src}: ${count}`);
}
console.log();

const base1Keys = keys.filter(k => k.startsWith('base1-'));
console.log('base1-* keys:', base1Keys.length);
if (base1Keys.length > 0) {
  const sample = base1Keys[0];
  console.log(`Sample entry [${sample}]:`);
  console.log(JSON.stringify(obj[sample], null, 2));
} else {
  console.log('(no base1-* entries — crawler picked a set ID not present in CARD_DB?)');
}
console.log();

const fieldCounts = { image: 0, cardmarketUrl: 0, tcgplayerUrl: 0, supertype: 0 };
for (const v of Object.values(obj)) {
  if (v.image) fieldCounts.image++;
  if (v.cardmarketUrl) fieldCounts.cardmarketUrl++;
  if (v.tcgplayerUrl) fieldCounts.tcgplayerUrl++;
  if (v.supertype) fieldCounts.supertype++;
}
console.log('Enriched-field counts (entries that have each field):');
for (const [field, count] of Object.entries(fieldCounts)) {
  console.log(`  ${field}: ${count}`);
}
