// pricing/pokemontcg-client.js
//
// Shared pokemontcg.io access: retrying fetch, upstream set discovery, and
// coverage reconciliation. Three call sites needed all three and none had them:
//
//   scripts/build-phash-db.js       — no retry; derived set IDs from the local
//                                     card-db's own keys, so a newly released
//                                     set could never be crawled
//   apps/server/_card-db-boot.js    — no retry; logged failed pages then set
//                                     cardDbReady = true regardless
//   scripts/v3-bench/fetch-refs.js  — had all three; this module is that code,
//                                     lifted so it is written once
//
// Two measured failure modes motivate everything here:
//
//   1. pokemontcg.io intermittently returns HTTP 500/502 on perfectly valid
//      requests — roughly 40% on /v2/cards?pageSize=250 (measured 4 Aug 2026),
//      with the SAME request succeeding on retry. Without retry, one 500 drops
//      an entire set (~120 cards) silently.
//   2. Discovery that reads the artifact it is building can never grow. New
//      sets were invisible permanently, not until the next run. This caused 23
//      of 35 failures in the V3 benchmark, because a card shop's stock skews
//      hard toward the newest set.

// Plain axios rather than apps/server/_clients.js: this is a low-level fetch
// utility used by offline scripts, and _clients pulls in Stripe and Supabase
// initialisation as a side effect of import.
import axios from 'axios';

export const POKEMONTCG_BASE = 'https://api.pokemontcg.io/v2';
export const PAGE_SIZE = 250;

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const DEFAULT_TIMEOUT_MS = 20_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiHeaders() {
  const key = process.env.POKEMONTCG_API_KEY || process.env.POKEMON_TCG_API_KEY || '';
  return key
    ? { Accept: 'application/json', 'X-Api-Key': key }
    : { Accept: 'application/json' };
}

/**
 * GET with exponential backoff.
 *
 * Retries 5xx, 429 and network errors; never retries a 4xx, which is a real
 * answer and will not change. Throws with `_attempts` attached once exhausted.
 */
export async function getWithRetry(url, opts = {}) {
  let delay = BASE_DELAY_MS;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await axios.get(url, {
        headers: apiHeaders(),
        timeout: DEFAULT_TIMEOUT_MS,
        maxRedirects: 5,
        ...opts,
      });
    } catch (err) {
      const status = err.response?.status ?? null;
      const retryable = status === null || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw Object.assign(err, { _attempts: attempt });
      }
      await sleep(delay + Math.floor(Math.random() * 250));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
  /* unreachable */
}

/**
 * Every set upstream, as `{ id, name, printedTotal, total, releaseDate }`.
 *
 * ALWAYS call this rather than deriving set IDs from a local artifact. Throws
 * on failure — callers decide whether a partial crawl is acceptable, but they
 * must decide explicitly rather than silently inheriting the old behaviour.
 */
export async function fetchAllSets() {
  const sets = [];
  let page = 1;
  let total = null;
  do {
    const resp = await getWithRetry(
      `${POKEMONTCG_BASE}/sets?pageSize=${PAGE_SIZE}&page=${page}`,
    );
    if (total === null) total = resp.data?.totalCount ?? 0;
    for (const s of resp.data?.data ?? []) {
      if (!s?.id) continue;
      sets.push({
        id: s.id,
        name: s.name || '',
        printedTotal: s.printedTotal ?? null,
        total: s.total ?? null,
        releaseDate: s.releaseDate || '',
      });
    }
    page++;
  } while ((page - 1) * PAGE_SIZE < total);
  return sets;
}

/** Convenience: just the set IDs. */
export async function fetchAllSetIds() {
  return (await fetchAllSets()).map(s => s.id);
}

/**
 * Compare what a build actually produced against what upstream says exists.
 *
 * This is the check that would have caught three separate incidents — the index
 * that was never populated, the silently dropped set, and new releases going
 * missing. Every one of them was a build that reported success while holding
 * less data than upstream had.
 *
 * @param {Map|Set|object} localCards  keyed by card id, or a Set of ids
 * @param {Array} upstreamSets         from fetchAllSets()
 * @returns {{ localTotal, upstreamTotal, coverage, missingSets, shortSets, ok }}
 */
export function reconcile(localCards, upstreamSets, { minCoverage = 0.995 } = {}) {
  const ids = localCards instanceof Map ? [...localCards.keys()]
    : localCards instanceof Set ? [...localCards]
    : Object.keys(localCards || {});

  const perSet = new Map();
  for (const id of ids) {
    const i = String(id).lastIndexOf('-');
    if (i <= 0) continue;
    const setId = String(id).slice(0, i);
    perSet.set(setId, (perSet.get(setId) || 0) + 1);
  }

  const missingSets = [];
  const shortSets = [];
  let upstreamTotal = 0;

  for (const s of upstreamSets) {
    // `total` includes secret rares; `printedTotal` does not. Use the larger,
    // since a complete crawl holds every card the API will serve.
    const expected = Math.max(s.total ?? 0, s.printedTotal ?? 0);
    upstreamTotal += expected;
    const have = perSet.get(s.id) || 0;
    if (have === 0 && expected > 0) {
      missingSets.push({ id: s.id, name: s.name, expected });
    } else if (expected > 0 && have < expected) {
      shortSets.push({ id: s.id, name: s.name, have, expected });
    }
  }

  const localTotal = ids.length;
  const coverage = upstreamTotal > 0 ? localTotal / upstreamTotal : 1;

  return {
    localTotal,
    upstreamTotal,
    coverage,
    missingSets,
    shortSets,
    ok: coverage >= minCoverage && missingSets.length === 0,
  };
}

/** One-line human summary of a reconcile() result. */
export function formatReconciliation(r) {
  const pct = (r.coverage * 100).toFixed(2);
  const head = `local ${r.localTotal} / upstream ${r.upstreamTotal} (${pct}%)`;
  if (r.ok) return `${head} — OK`;
  const parts = [head];
  if (r.missingSets.length) {
    parts.push(`MISSING ${r.missingSets.length} set(s): ` +
      r.missingSets.slice(0, 8).map(s => `${s.id} (0/${s.expected})`).join(', ') +
      (r.missingSets.length > 8 ? ', …' : ''));
  }
  if (r.shortSets.length) {
    parts.push(`INCOMPLETE ${r.shortSets.length} set(s): ` +
      r.shortSets.slice(0, 8).map(s => `${s.id} (${s.have}/${s.expected})`).join(', ') +
      (r.shortSets.length > 8 ? ', …' : ''));
  }
  return parts.join(' — ');
}
