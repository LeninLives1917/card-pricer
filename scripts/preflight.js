#!/usr/bin/env node
// scripts/preflight.js
//
// Run this the night before a trade show.
//
// Every failure found during the V3 investigation was silent — the system kept
// answering, just with degraded or wrong data, and nobody knew until someone
// measured. Each check below corresponds to one of those incidents:
//
//   catalogue completeness  — a set silently dropped by one HTTP 500
//   catalogue freshness     — new releases invisible because discovery read the
//                             artifact it was building; a shop's stock skews to
//                             the newest set, so this is the expensive one
//   index populated         — the pHash fast path never worked and nobody knew
//   price snapshot age      — a stale price shown as current is a wrong price
//   Supabase liveness       — the project was found PAUSED while /api/health
//                             reported has_supabase: true (it checked env vars)
//   rectification enabled   — CARD_RECTIFY off means the trim heuristic, which
//                             measured 1.0% top-1 on realistic scenes
//
// Exits non-zero if anything is FAIL, so it can gate a deploy or a cron job.
// WARN items are judgement calls and do not fail the run.
//
// Usage:
//   node scripts/preflight.js
//   node scripts/preflight.js --offline    # skip checks needing network

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DATA = join(REPO_ROOT, 'data');

const OFFLINE = process.argv.includes('--offline');

// A card set releases roughly every six weeks; a catalogue older than this is
// very likely missing whatever the shop is actually selling.
const CATALOGUE_MAX_AGE_DAYS = 21;
const PRICE_MAX_AGE_DAYS = 7;
const MIN_COVERAGE = 0.995;

const results = [];
const ok = (name, detail) => results.push({ level: 'OK', name, detail });
const warn = (name, detail, fix) => results.push({ level: 'WARN', name, detail, fix });
const fail = (name, detail, fix) => results.push({ level: 'FAIL', name, detail, fix });

const ageDays = ms => (Date.now() - ms) / 86_400_000;
const fmtAge = ms => `${ageDays(ms).toFixed(1)}d old`;

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

// -----------------------------------------------------------------------------

function checkCatalogue() {
  const file = join(DATA, 'card-db.json');
  if (!fs.existsSync(file)) {
    return fail('catalogue', 'data/card-db.json missing',
      'run: node scripts/build-phash-db.js');
  }
  const stat = fs.statSync(file);
  const db = readJson(file);
  if (!db) {
    return fail('catalogue', 'data/card-db.json does not parse',
      'the file is corrupt — re-crawl');
  }
  const n = Object.keys(db).length;
  const age = ageDays(stat.mtimeMs);

  if (age > CATALOGUE_MAX_AGE_DAYS) {
    fail('catalogue freshness', `${n} cards, ${fmtAge(stat.mtimeMs)}`,
      `older than ${CATALOGUE_MAX_AGE_DAYS}d — a set has almost certainly released since. ` +
      'run: node scripts/build-phash-db.js');
  } else {
    ok('catalogue freshness', `${n} cards, ${fmtAge(stat.mtimeMs)}`);
  }
  return n;
}

function checkManifest() {
  const file = join(DATA, 'card-index-manifest.json');
  const m = readJson(file);
  if (!m) {
    return warn('coverage', 'no card-index-manifest.json',
      'coverage is UNKNOWN — run the crawler once to record it');
  }

  // A manifest older than the data it describes is stale, and stale numbers
  // reported as current are exactly the failure mode this script exists to
  // prevent. The crawler only writes the manifest when it reaches
  // reconciliation, so an interrupted run leaves the previous one in place
  // describing a catalogue that has since grown.
  const cardDb = join(DATA, 'card-db.json');
  const built = Date.parse(m.built_at);
  if (fs.existsSync(cardDb) && Number.isFinite(built)) {
    const dataMtime = fs.statSync(cardDb).mtimeMs;
    if (dataMtime > built + 60_000) {
      return warn('coverage', `manifest is STALE — written ${fmtAge(built)}, ` +
        `card-db modified ${fmtAge(dataMtime)} (reports ${(m.coverage * 100).toFixed(2)}%)`,
        'a crawl was interrupted before it could reconcile. Re-run ' +
        'node scripts/build-phash-db.js to completion for a current figure ' +
        '(see the separate "upstream sets" check for live set coverage)');
    }
  }

  const pct = (m.coverage * 100).toFixed(2);
  const missing = m.missing_sets?.length || 0;
  const short = m.short_sets?.length || 0;

  if (!m.ok || m.coverage < MIN_COVERAGE || missing > 0) {
    fail('coverage', `${pct}% (${m.card_count}/${m.upstream_total}), ` +
      `${missing} missing set(s)${missing ? `: ${m.missing_sets.slice(0, 5).join(', ')}` : ''}` +
      `${short ? `, ${short} short` : ''}`,
      'run: node scripts/build-phash-db.js  (it will fetch only what is missing)');
  } else if (short > 0) {
    warn('coverage', `${pct}%, ${short} set(s) slightly short`,
      'usually promos/secret rares the API lists but does not serve; re-run to confirm');
  } else {
    ok('coverage', `${pct}% (${m.card_count}/${m.upstream_total})`);
  }

  if (Number.isFinite(built) && ageDays(built) > CATALOGUE_MAX_AGE_DAYS) {
    warn('index build age', `last built ${fmtAge(built)}`,
      'a set has likely released since — re-crawl');
  }
}

function checkPhashIndex() {
  const file = join(DATA, 'card-phashes.json');
  const idx = readJson(file);
  if (!idx) {
    return warn('phash index', 'absent or unparseable',
      'only matters if the local fast path is meant to be live');
  }
  const n = Object.keys(idx.phash || {}).length;
  if (n <= 1) {
    warn('phash index', `${n} entr${n === 1 ? 'y' : 'ies'} — effectively empty`,
      'the local fast path cannot hit. This is the state it was silently in for ' +
      'months: run scripts/build-phash-db.js, or leave it if V3 embeddings supersede it');
  } else {
    ok('phash index', `${n} hashes`);
  }
}

function checkPrices() {
  const file = join(DATA, 'card-prices.json');
  if (!fs.existsSync(file)) {
    return warn('price snapshot', 'data/card-prices.json missing',
      'offline pricing will be unavailable at the venue');
  }
  const stat = fs.statSync(file);
  const age = ageDays(stat.mtimeMs);
  if (age > PRICE_MAX_AGE_DAYS) {
    warn('price snapshot', fmtAge(stat.mtimeMs),
      `older than ${PRICE_MAX_AGE_DAYS}d — refresh before the show, and make sure the UI ` +
      'shows the as-of date so a stale price is never displayed as current');
  } else {
    ok('price snapshot', fmtAge(stat.mtimeMs));
  }
}

function checkRectify() {
  if (process.env.CARD_RECTIFY === '1') {
    ok('card rectification', 'CARD_RECTIFY=1');
  } else {
    warn('card rectification', 'CARD_RECTIFY not set',
      'cropToCard falls back to the .trim() heuristic, which measured 1.0% top-1 ' +
      'on realistic scenes vs 40.5% rectified. Set CARD_RECTIFY=1');
  }
}

function checkCrawlMarker() {
  const marker = join(DATA, '.crawl-active');
  if (!fs.existsSync(marker)) return ok('crawl marker', 'clear');
  const stat = fs.statSync(marker);
  fail('crawl marker', `data/.crawl-active present (${fmtAge(stat.mtimeMs)})`,
    "the server's dirty-save stays PAUSED until it is cleared by a restart — " +
    'restart the service, or delete the marker if no crawl is running');
}

function checkKeys() {
  const required = [
    ['ANTHROPIC_API_KEY', 'the Sonnet fallback path cannot run without it'],
    ['SUPABASE_URL', 'sessions, quotas and quotes are DB-backed'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'sessions, quotas and quotes are DB-backed'],
  ];
  const missing = required.filter(([k]) => !process.env[k]);
  if (missing.length) {
    fail('credentials', `missing: ${missing.map(([k]) => k).join(', ')}`,
      missing.map(([k, why]) => `${k} — ${why}`).join('; '));
  } else {
    ok('credentials', 'core keys present');
  }
}

async function checkSupabase() {
  if (OFFLINE) return warn('supabase liveness', 'skipped (--offline)');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return; // already reported by checkKeys
  }
  try {
    const { supabase } = await import('../apps/server/_clients.js');
    if (!supabase) return fail('supabase liveness', 'client not constructed');
    // A real query, not an env-var check. The project was found PAUSED while
    // /api/health cheerfully reported has_supabase: true.
    const { error } = await supabase.from('card_prices').select('set_id').limit(1);
    if (error) {
      fail('supabase liveness', error.message,
        'if this says the project is paused, resume it in the Supabase dashboard');
    } else {
      ok('supabase liveness', 'query succeeded');
    }
  } catch (err) {
    fail('supabase liveness', err.message, 'check SUPABASE_URL and the service role key');
  }
}

async function checkUpstreamFreshness() {
  if (OFFLINE) return warn('upstream sets', 'skipped (--offline)');
  try {
    const { fetchAllSets } = await import('../pricing/pokemontcg-client.js');
    const db = readJson(join(DATA, 'card-db.json'));
    if (!db) return;
    const local = new Set(Object.keys(db).map(k => k.slice(0, k.lastIndexOf('-'))));
    const sets = await fetchAllSets();
    const missing = sets.filter(s => !local.has(s.id));
    if (missing.length) {
      const newest = [...missing].sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
      fail('upstream sets', `${missing.length} set(s) exist upstream but not locally: ` +
        newest.slice(0, 5).map(s => `${s.id} (${s.name}, ${s.releaseDate || '?'})`).join(', '),
        'run: node scripts/build-phash-db.js — these are the cards most likely to be scanned');
    } else {
      ok('upstream sets', `all ${sets.length} known sets present locally`);
    }
  } catch (err) {
    warn('upstream sets', `could not check (${err.message})`,
      'pokemontcg.io may be down; coverage is unverified');
  }
}

// -----------------------------------------------------------------------------

async function main() {
  console.log('Card-Pricer preflight' + (OFFLINE ? ' (offline)' : ''));
  console.log('='.repeat(64));

  checkCatalogue();
  checkManifest();
  checkPhashIndex();
  checkPrices();
  checkCrawlMarker();
  checkRectify();
  checkKeys();
  await checkSupabase();
  await checkUpstreamFreshness();

  const pad = Math.max(...results.map(r => r.name.length));
  for (const r of results) {
    const badge = r.level === 'OK' ? ' ok ' : r.level === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`[${badge}] ${r.name.padEnd(pad)}  ${r.detail}`);
    if (r.fix) console.log(`${' '.repeat(pad + 9)}↳ ${r.fix}`);
  }

  const fails = results.filter(r => r.level === 'FAIL').length;
  const warns = results.filter(r => r.level === 'WARN').length;
  console.log('='.repeat(64));
  console.log(`${results.length - fails - warns} ok, ${warns} warning(s), ${fails} failure(s)`);

  if (fails) {
    console.log('\nNOT READY — fix the failures above before the show.');
    process.exitCode = 1;
  } else if (warns) {
    console.log('\nUsable, but read the warnings.');
  } else {
    console.log('\nReady.');
  }
}

main().catch(err => { console.error('[preflight] FATAL:', err); process.exit(1); });
