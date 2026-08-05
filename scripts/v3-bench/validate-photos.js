#!/usr/bin/env node
// scripts/v3-bench/validate-photos.js
//
// V3 Phase 0 — validates the operator's benchmark photo labels BEFORE we spend
// a measurement run on them.
//
// Every photo is named for the card it shows: "<set-id>-<number>.jpg", with an
// optional "_suffix" for alternate takes of the same card (_sleeved, _angle,
// _glare, _blur). See docs/V3_BENCHMARK_PHOTOS.md.
//
// A mislabelled photo is worse than a missing one: it counts as a miss against
// a system that was actually right, and it does so silently. This script exists
// so that a typo costs thirty seconds instead of poisoning the evidence gate.
//
// Usage:
//   node scripts/v3-bench/validate-photos.js
//   node scripts/v3-bench/validate-photos.js --dir /path/to/photos
//
// Env:
//   V3_CACHE_DIR   cache root (default ~/.card-pricer-v3); photos live in <root>/photos

import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename, extname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');

const CACHE_DIR = process.env.V3_CACHE_DIR || join(homedir(), '.card-pricer-v3');
const dirFlag = process.argv.indexOf('--dir');
const PHOTO_DIR = dirFlag !== -1 ? process.argv[dirFlag + 1] : join(CACHE_DIR, 'photos');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (IMAGE_EXT.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/**
 * "base1-4_sleeved.jpg" → { cardId: "base1-4", variant: "sleeved" }
 * The card ID is everything before the FIRST underscore; set IDs never contain
 * one, and card numbers use hyphens (e.g. "sv1-199", "swsh4-TG12") but not
 * underscores.
 */
function parseName(file) {
  const stem = basename(file, extname(file));
  const us = stem.indexOf('_');
  return {
    cardId: us === -1 ? stem : stem.slice(0, us),
    variant: us === -1 ? null : stem.slice(us + 1),
  };
}

function main() {
  if (!fs.existsSync(PHOTO_DIR)) {
    console.error(`[validate-photos] photo directory not found: ${PHOTO_DIR}`);
    console.error(`[validate-photos] create it and drop your photos in, then re-run.`);
    console.error(`[validate-photos] naming: <set-id>-<number>.jpg  e.g. base1-4.jpg`);
    process.exit(1);
  }
  if (!fs.existsSync(CARD_DB_FILE)) {
    console.error(`[validate-photos] FATAL: ${CARD_DB_FILE} not found`);
    process.exit(1);
  }

  const cardDb = JSON.parse(fs.readFileSync(CARD_DB_FILE, 'utf8'));
  const files = walk(PHOTO_DIR);

  if (!files.length) {
    console.error(`[validate-photos] no images found under ${PHOTO_DIR}`);
    process.exit(1);
  }

  // Case-insensitive lookup: set IDs are lowercase in card-db but Windows and
  // phone camera apps are cheerfully inconsistent about case.
  const byLower = new Map(Object.keys(cardDb).map(k => [k.toLowerCase(), k]));

  const unknown = [];
  const takesPerCard = new Map();   // canonical cardId -> [{file, variant}]
  const sets = new Map();

  for (const file of files) {
    const { cardId, variant } = parseName(file);
    const canonical = byLower.get(cardId.toLowerCase());
    if (!canonical) { unknown.push({ file, cardId }); continue; }

    if (!takesPerCard.has(canonical)) takesPerCard.set(canonical, []);
    takesPerCard.get(canonical).push({ file, variant });

    const setId = canonical.slice(0, canonical.lastIndexOf('-'));
    sets.set(setId, (sets.get(setId) || 0) + 1);
  }

  const labelled = files.length - unknown.length;
  const rel = f => f.replace(PHOTO_DIR, '').replace(/^[\\/]/, '');

  console.log('');
  console.log('[validate-photos] =============== summary ===============');
  console.log(`[validate-photos] photo dir     : ${PHOTO_DIR}`);
  console.log(`[validate-photos] images found  : ${files.length}`);
  console.log(`[validate-photos] labels resolved: ${labelled}`);
  console.log(`[validate-photos] unique cards  : ${takesPerCard.size}`);
  console.log(`[validate-photos] distinct sets : ${sets.size}`);

  // ---- unresolved labels: the thing this script exists to catch -----------
  if (unknown.length) {
    console.log('');
    console.log(`[validate-photos] ${unknown.length} FILE(S) DO NOT MATCH ANY CARD — fix these:`);
    for (const { file, cardId } of unknown.slice(0, 40)) {
      // Offer the nearest same-set candidates; a wrong number is the common typo.
      const setId = cardId.slice(0, cardId.lastIndexOf('-'));
      const near = Object.keys(cardDb)
        .filter(k => k.toLowerCase().startsWith(setId.toLowerCase() + '-'))
        .slice(0, 4);
      console.log(`  ${rel(file)}  → "${cardId}" not in card-db`);
      if (near.length) console.log(`      set "${setId}" does exist; e.g. ${near.join(', ')}`);
      else             console.log(`      set "${setId}" is not a known set id either`);
    }
    if (unknown.length > 40) console.log(`  … and ${unknown.length - 40} more`);
  }

  // ---- composition --------------------------------------------------------
  const variantCounts = new Map();
  let plainTakes = 0;
  for (const takes of takesPerCard.values()) {
    for (const { variant } of takes) {
      if (!variant) plainTakes++;
      else variantCounts.set(variant, (variantCounts.get(variant) || 0) + 1);
    }
  }

  console.log('');
  console.log('[validate-photos] composition:');
  console.log(`  plain takes (no suffix) : ${plainTakes}`);
  for (const [v, n] of [...variantCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  _${v.padEnd(22)}: ${n}`);
  }

  const multi = [...takesPerCard.entries()].filter(([, t]) => t.length > 1);
  console.log('');
  console.log(`[validate-photos] cards with >1 take: ${multi.length}`);

  // ---- near-twin coverage -------------------------------------------------
  // Same card NUMBER across different sets is precisely the confusion that
  // produced a Celebrations #4 image for a Base Set #4 card. If the photo set
  // contains no such pairs, the benchmark cannot measure the failure we most
  // care about.
  const byNumber = new Map();
  for (const cardId of takesPerCard.keys()) {
    const n = cardId.slice(cardId.lastIndexOf('-') + 1);
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(cardId);
  }
  const twins = [...byNumber.values()].filter(ids => ids.length > 1);
  console.log(`[validate-photos] cross-set number collisions in set: ${twins.length}`);
  if (twins.length) {
    for (const ids of twins.slice(0, 8)) console.log(`  #${ids[0].split('-').pop()}: ${ids.join('  vs  ')}`);
  } else {
    console.log('  none — consider adding a few same-number-different-set pairs');
    console.log('  (e.g. base1-4 and cel25-4), that confusion is a known live failure');
  }

  // ---- verdict ------------------------------------------------------------
  console.log('');
  const problems = [];
  if (unknown.length) problems.push(`${unknown.length} unresolved label(s)`);
  if (labelled < 200) problems.push(`only ${labelled} labelled photos (target ~250)`);
  if (sets.size < 10) problems.push(`only ${sets.size} distinct set(s) — spread across eras`);

  if (!problems.length) {
    console.log('[validate-photos] READY — labels all resolve and composition looks sane.');
  } else {
    console.log('[validate-photos] NOT READY:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
  console.log('');
}

main();
