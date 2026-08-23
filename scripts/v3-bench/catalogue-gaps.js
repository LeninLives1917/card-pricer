#!/usr/bin/env node
// scripts/v3-bench/catalogue-gaps.js
//
// Which cards can the scanner NOT possibly identify, because they are not in
// data/card-db.json at all?
//
// WHY THIS EXISTS
//
// The benchmark has never contained a card that is genuinely absent from the
// catalogue. Every photo we have measured is of something we hold, so every
// "miss" was a ranking failure — and the abstention machinery has been scored
// against a case it never actually faced. A sharp, well-framed photo of an
// absent card sitting next to a near-identical catalogued one is the adversary
// that matters on a buy-list, and n = 0.
//
// This prints a shopping list for the photo session: sets we hold nothing from,
// and sets we hold only part of. Both are real gaps, and the second kind is
// nastier — a set that looks present is not one anybody thinks to check.
//
// It compares against LIVE upstream (api.pokemontcg.io/v2/sets), not against
// pricing/reference/pokemon-sets.json. That distinction is the whole value of the script:
// pokemon-sets.json was generated alongside the catalogue, so checking one
// against the other reports zero gaps by construction — which is exactly how
// both crawlers came to be structurally unable to see a newly released set.
// Discovery read its own output. Run first against the local list, this printed
// a confident "0 missing" that meant nothing at all.
//
// Upstream 500s often (CLAUDE.md: roughly 40% of valid requests), so the fetch
// retries. A network failure exits NON-ZERO rather than falling back to the
// local list: a check that silently degrades into the circular version is worse
// than no check, because it still prints a reassuring number.
//
// Usage:
//   node scripts/v3-bench/catalogue-gaps.js
//   node scripts/v3-bench/catalogue-gaps.js --min-missing 5
//   node scripts/v3-bench/catalogue-gaps.js --offline   # local list, LOUDLY caveated

import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const argNum = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MIN_MISSING = argNum('--min-missing', 1);

const OFFLINE = argv.includes('--offline');

async function fetchUpstreamSets() {
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch('https://api.pokemontcg.io/v2/sets');
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.data) && j.data.length) return j.data;
        last = 'empty data array';
      } else {
        last = `HTTP ${r.status}`;
      }
    } catch (e) {
      last = e.message;
    }
    await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
  }
  throw new Error(`upstream unreachable after 6 attempts (${last})`);
}

const db = JSON.parse(fs.readFileSync(join(REPO, 'data', 'card-db.json'), 'utf8'));

let sets;
if (OFFLINE) {
  console.error('WARNING: --offline compares the catalogue against pricing/reference/pokemon-sets.json,');
  console.error('which was generated FROM the same crawl. It cannot see a set that neither');
  console.error('knows about, which is the failure mode this script exists to catch.');
  console.error('');
  sets = JSON.parse(fs.readFileSync(join(REPO, 'pricing', 'reference', 'pokemon-sets.json'), 'utf8'));
} else {
  try {
    sets = await fetchUpstreamSets();
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    console.error('Not falling back to the local set list — it would print a reassuring');
    console.error('zero. Re-run, or use --offline and read the caveat.');
    process.exit(1);
  }
}

// setId -> count held. Keys are "<set-id>-<number>", and set ids themselves
// contain hyphens ("sv3pt5"), so split on the LAST hyphen.
const held = new Map();
for (const key of Object.keys(db)) {
  const i = key.lastIndexOf('-');
  if (i < 1) continue;
  const setId = key.slice(0, i);
  held.set(setId, (held.get(setId) ?? 0) + 1);
}

const rows = [];
for (const s of sets) {
  const have = held.get(s.id) ?? 0;
  // `total` includes secret rares above the printed denominator; it is the
  // honest expectation. printedTotal alone would under-count and make a short
  // set look complete.
  const expect = s.total ?? s.printedTotal ?? 0;
  if (!expect) continue;
  const missing = expect - have;
  if (missing >= MIN_MISSING) {
    rows.push({ id: s.id, name: s.name, code: s.ptcgoCode ?? '', have, expect, missing });
  }
}
rows.sort((a, b) => b.missing - a.missing);

const empty = rows.filter((r) => r.have === 0);
const partial = rows.filter((r) => r.have > 0);
const totalMissing = rows.reduce((n, r) => n + r.missing, 0);

// Sets the catalogue holds that the set list does not know about. Not a gap in
// coverage, but a disagreement between two sources of truth, and an unexplained
// disagreement is worth seeing rather than silently dropping.
const known = new Set(sets.map((s) => s.id));
const unknownSets = [...held.keys()].filter((id) => !known.has(id));

const pad = (s, n) => String(s).padEnd(n);
console.log(`catalogue: ${Object.keys(db).length} cards across ${held.size} sets`);
console.log(`set list : ${sets.length} sets\n`);

if (empty.length) {
  console.log(`=== HOLD NOTHING FROM THESE ${empty.length} SET(S) — every card is unidentifiable ===`);
  for (const r of empty) {
    console.log(`  ${pad(r.id, 12)} ${pad(r.code, 6)} ${pad(r.name, 38)} 0/${r.expect}`);
  }
  console.log('');
}

if (partial.length) {
  console.log(`=== PARTIAL — these LOOK present, which is why nobody checks them ===`);
  for (const r of partial.slice(0, 40)) {
    console.log(`  ${pad(r.id, 12)} ${pad(r.code, 6)} ${pad(r.name, 38)} ${r.have}/${r.expect}  (${r.missing} missing)`);
  }
  if (partial.length > 40) console.log(`  ... and ${partial.length - 40} more`);
  console.log('');
}

if (!rows.length) {
  console.log('No gaps: every card in every upstream set is in the catalogue.');
  console.log('');
  console.log('For the photo session this means there is no absent-card shopping list to');
  console.log('draw from pokemontcg.io. Genuinely absent cards have to come from outside');
  console.log('its coverage — Japanese/Korean/Chinese printings, other games, jumbo and');
  console.log('oversized cards, error cards and proxies.');
  console.log('');
}

if (unknownSets.length) {
  console.log(`=== IN THE CATALOGUE BUT NOT IN THE SET LIST (${unknownSets.length}) ===`);
  console.log(`  ${unknownSets.join(', ')}\n`);
}

console.log(`TOTAL unidentifiable cards: ${totalMissing}`);
if (rows.length) {
  console.log('\nFor the photo session: shoot cards from the "hold nothing" sets first — those');
  console.log('are guaranteed absent. The partial sets need a per-card check, so they are a');
  console.log('worse source of known-absent examples even though they are the bigger risk.');
}
