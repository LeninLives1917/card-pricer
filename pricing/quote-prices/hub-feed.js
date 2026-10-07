// pricing/quote-prices/hub-feed.js
//
// Fetch the hub's daily Cardmarket price feed and keep a joined index of it in
// memory for the customer quote.
//
// THE FEED is `rpc/quote_price_feed` on the boardbrewed-hub Supabase project:
// one JSON document, rebuilt hourly there by pg_cron from the daily price-guide
// download (cm_price_snapshot). It is public market data, exposed read-only
// through a SECURITY DEFINER function, so the publishable key is enough:
//
//   HUB_SUPABASE_URL   https://<ref>.supabase.co
//   HUB_SUPABASE_KEY   the hub's publishable (anon) key
//
// FAILURE IS LOUD. A missing variable, a failed fetch, a malformed document and
// a stale snapshot each leave a distinct mark in quotePriceState(), which
// /api/health reports. A failed refresh keeps the previous index (yesterday's
// prices beat none), and the staleness gate in the batch route decides whether
// that index is still fit to quote from.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPriceIndex } from './feed-index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(HERE, '..', 'reference');

/** Older than this, the snapshot is not quoted from (three missed downloads in a row). */
export const PRICE_STALE_DAYS = 3;
/** The hub rebuilds hourly at :20; refreshing hourly keeps us within an hour of it. */
export const REFRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

const state = {
  index: null,
  configured: null,
  attempts: 0,
  successes: 0,
  failures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  buildMs: null,
};

let _sets = null;
let _reprints = null;
function referenceSets() {
  if (!_sets) _sets = JSON.parse(fs.readFileSync(join(REFERENCE, 'pokemon-sets.json'), 'utf8'));
  return _sets;
}
function reprintList() {
  if (!_reprints) {
    try {
      _reprints = JSON.parse(fs.readFileSync(join(REFERENCE, 'classic-collection-reprints.json'), 'utf8'));
    } catch {
      _reprints = [];
    }
  }
  return _reprints;
}

/** Whole days between a snapshot date ("2026-10-06") and now. null if unknown. */
export function snapshotAgeDays(snapshotDate, now = Date.now()) {
  if (!snapshotDate) return null;
  const t = Date.parse(`${String(snapshotDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86_400_000);
}

/**
 * Fetch, validate and index the feed. Never throws: the outcome is recorded in
 * state and returned.
 *
 * @param {object} opts
 * @param {Map}      opts.cardDb     the catalogue (CARD_DB)
 * @param {object}   [opts.env]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function refreshQuotePrices({ cardDb, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = String(env.HUB_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.HUB_SUPABASE_KEY || '';
  state.configured = !!(url && key);
  if (!state.configured) {
    state.lastError = 'HUB_SUPABASE_URL / HUB_SUPABASE_KEY not set';
    return { ok: false, error: state.lastError };
  }

  state.attempts += 1;
  state.lastAttemptAt = new Date().toISOString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    // A legacy anon key is a JWT and also goes in Authorization; a publishable
    // key (sb_publishable_...) must NOT, or the gateway rejects it as a bad JWT.
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.split('.').length === 3) headers.Authorization = `Bearer ${key}`;
    const resp = await fetchImpl(`${url}/rest/v1/rpc/quote_price_feed`, {
      method: 'POST', headers, body: '{}', signal: ctl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
    const feed = await resp.json();
    if (!feed || !Array.isArray(feed.cards) || !feed.cards.length || !feed.snapshot_date) {
      throw new Error('malformed feed: no cards or no snapshot_date');
    }
    const t0 = Date.now();
    const index = buildPriceIndex(feed, cardDb ?? new Map(), referenceSets(), reprintList());
    state.buildMs = Date.now() - t0;
    state.index = index;
    state.successes += 1;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    console.log(`[QUOTE-PRICES] feed ${feed.snapshot_date}: ${index.feedCards} hub cards, `
      + `${index.stats.mapped}/${index.stats.catalogue_cards} catalogue cards mapped, `
      + `${index.stats.priced} priced (${index.stats.nm_en_priced} from NM English `
      + `${feed.nm_en_date ?? 'MISSING'}), built in ${state.buildMs}ms`);
    return { ok: true };
  } catch (e) {
    state.failures += 1;
    state.lastError = e?.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (e?.message || String(e));
    console.warn('[QUOTE-PRICES] refresh failed:', state.lastError);
    return { ok: false, error: state.lastError };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boot-time wiring: wait for the catalogue to load, then refresh hourly.
 * The timers are unref'd so they never hold the process open.
 *
 * @param {object} opts
 * @param {() => Map} opts.getCardDb
 */
export function startQuotePriceRefresh({ getCardDb, env = process.env } = {}) {
  let tries = 0;
  const first = async () => {
    const db = getCardDb();
    // The index is a join against the catalogue; built on an empty one it maps
    // nothing. Wait for the catalogue (up to ~10 minutes), then go anyway.
    if ((!db || db.size === 0) && tries < 60) {
      tries += 1;
      setTimeout(first, 10_000).unref?.();
      return;
    }
    await refreshQuotePrices({ cardDb: db, env });
    setInterval(() => { refreshQuotePrices({ cardDb: getCardDb(), env }); }, REFRESH_MS).unref?.();
  };
  setTimeout(first, 2_000).unref?.();
}

/** The current index, or null if the feed has never loaded. */
export function getQuotePriceIndex() {
  return state.index;
}

/** Test seam. */
export function _setQuotePriceIndex(index) {
  state.index = index;
}

/** For /api/health. */
export function quotePriceState(now = Date.now()) {
  const idx = state.index;
  const age = idx ? snapshotAgeDays(idx.snapshotDate, now) : null;
  const nmAge = idx ? snapshotAgeDays(idx.nmEnDate, now) : null;
  return {
    configured: state.configured,
    loaded: !!idx,
    snapshot_date: idx?.snapshotDate ?? null,
    age_days: age === null ? null : Number(age.toFixed(1)),
    stale_after_days: PRICE_STALE_DAYS,
    // The cheapest NM English copy (TCGGO's pull), which the quote prices from.
    nm_en_date: idx?.nmEnDate ?? null,
    nm_en_age_days: nmAge === null ? null : Number(nmAge.toFixed(1)),
    nm_en_priced: idx?.stats.nm_en_priced ?? null,
    nm_en_ratio: idx?.stats.nm_en_ratio ?? null,
    on_guide: idx?.stats.on_guide ?? null,
    prices_disagree: idx?.stats.prices_disagree ?? null,
    product_unconfirmed: idx?.stats.product_unconfirmed ?? null,
    cache_built_at: idx?.cacheBuiltAt ?? null,
    feed_cards: idx?.feedCards ?? null,
    catalogue_cards: idx?.stats.catalogue_cards ?? null,
    mapped: idx?.stats.mapped ?? null,
    mapped_ratio: idx?.stats.mapped_ratio ?? null,
    priced: idx?.stats.priced ?? null,
    priced_ratio: idx?.stats.priced_ratio ?? null,
    name_mismatch: idx?.stats.name_mismatch ?? null,
    unmapped_sets: idx?.stats.unmapped_sets ?? null,
    augmented: idx?.augmented ?? null,
    reprint_keys: idx?.reprints?.size ?? null,
    attempts: state.attempts,
    successes: state.successes,
    failures: state.failures,
    last_attempt_at: state.lastAttemptAt,
    last_success_at: state.lastSuccessAt,
    last_error: state.lastError,
    build_ms: state.buildMs,
  };
}

/** Test seam. */
export function _resetQuotePriceState() {
  state.index = null;
  state.configured = null;
  state.attempts = 0;
  state.successes = 0;
  state.failures = 0;
  state.lastAttemptAt = null;
  state.lastSuccessAt = null;
  state.lastError = null;
  state.buildMs = null;
}
