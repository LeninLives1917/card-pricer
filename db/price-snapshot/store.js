// db/price-snapshot/store.js
// Owner: A2 + A3 | Slice: S10 (F16)
//
// CRUD layer for the `card_prices` Postgres table — the V2 primary store
// for the data that V1 kept in `data/card-prices.json`. See:
//   - V2_AUDIT.md §3        — file-backed state baseline
//   - V2_ARCHITECTURE.md §4 — F16 (`card_prices` ADOPT)
//   - V2_ARCHITECTURE.md §4.2 — "JSON file written as backup for one release,
//     dropped in a follow-up". This store is the path-of-record.
//   - supabase/migrations/20260502221125_v2_carryover.sql — table schema.
//   - db/schema.md §card_prices.
//
// RLS notes:
//   The carryover migration enables RLS on `card_prices` with ZERO policies.
//   Service-role writes succeed (RLS bypassed); anonymous reads are blocked.
//   Reads in the running server happen via the in-memory `CARD_PRICES` Map
//   warmed from `loadAllCardPrices` at boot, NOT directly from supabase, so
//   anon-read being blocked is intentional and harmless.
//
// Failsafe semantics:
//   Every function accepts an injected supabase client (defaults to the
//   service-role singleton). When the client is null/undefined (e.g. local
//   dev with no SUPABASE_URL), every function returns a benign no-op shape
//   (empty Map, null row, fake-success object) without throwing. The caller
//   in _card-db-boot.js is responsible for falling through to the file +
//   pokemontcg.io download path in that case.
//
// Key normalisation:
//   `loadAllCardPrices` returns a Map whose keys match V1's in-memory format
//   exactly: `${set_id_lower}-${number_no_zeros}`. This matters because
//   admin.js iterates CARD_PRICES and the arbitrage UI keys results by that
//   string. Don't change the key shape without updating admin.js.

import { supabase as defaultClient } from '../../apps/server/_clients.js';
import { countSnapshot } from '../../infra/observability/price-snapshot-counters.js';

const TABLE = 'card_prices';
const SNAPSHOT_TABLE = 'card_price_snapshots';
const CHUNK_SIZE = 1000;

/**
 * @typedef {object} CardPriceRow
 * @property {string} set_id          — pokemontcg.io set id, e.g. "sv8"
 * @property {string} number          — printed number, leading zeros preserved
 * @property {string} name
 * @property {string|null} [set_name]
 * @property {string|null} [set_code]
 * @property {string|null} [rarity]
 * @property {string|null} [image]
 * @property {string|null} [cardmarket_url]
 * @property {string|null} [tcgplayer_url]
 * @property {object|null} [tcg]      — pokemontcg.io tcgplayer.prices blob
 * @property {object|null} [cm]       — pokemontcg.io cardmarket.prices blob
 * @property {string} [fetched_at]    — ISO timestamp; defaults to now() server-side
 */

/**
 * Map a CardPriceRow to the in-memory CARD_PRICES Map value shape used by
 * admin.js. V1 server.js:1924 stored these fields under camelCase, the
 * Postgres columns are snake_case. This is the one place that translates.
 */
function rowToMapValue(row) {
  return {
    name: row.name,
    setId: row.set_id,
    setName: row.set_name || '',
    setCode: row.set_code || (row.set_id || '').toUpperCase(),
    number: row.number,
    rarity: row.rarity || '',
    image: row.image || '',
    cardmarketUrl: row.cardmarket_url || null,
    tcgplayerUrl: row.tcgplayer_url || null,
    tcg: row.tcg || null,
    cm: row.cm || null,
    fetchedAt: row.fetched_at ? new Date(row.fetched_at).getTime() : 0,
  };
}

/**
 * Build the CARD_PRICES Map key from a row. Must match V1 server.js:1932
 * exactly: `${set_id_lower}-${number_no_zeros}` where leading zeros are
 * stripped (but if all-zero, the original number is kept).
 */
function rowToKey(row) {
  const setId = String(row.set_id || '').toLowerCase();
  const num = String(row.number || '');
  const cleanNum = num.replace(/^0+/, '') || num;
  return `${setId}-${cleanNum}`;
}

/**
 * UPSERT a single card price. Returns the inserted/updated row, or null on
 * client-unavailable. Throws on hard DB errors.
 *
 * @param {CardPriceRow} row
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function saveCardPrice(row, client = defaultClient) {
  if (!client) return null;
  if (!row || !row.set_id || !row.number || !row.name) {
    throw new Error('saveCardPrice: set_id, number, and name are required');
  }

  const { data, error } = await client
    .from(TABLE)
    .upsert(row, { onConflict: 'set_id,number' })
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`saveCardPrice failed: ${error.message || error}`);
  return data ?? null;
}

/**
 * UPSERT many card price rows in one or more chunked calls. Each chunk uses
 * the same composite-key onConflict so a re-pull replaces stale prices.
 * Failsafe: returns { ok:true, inserted:0 } when client is unavailable so
 * callers can fire-and-forget without nullchecking.
 *
 * @param {CardPriceRow[]} rows
 * @param {object} [client]
 * @returns {Promise<{ ok: boolean, inserted: number, errors: Array<string> }>}
 */
export async function bulkSaveCardPrices(rows, client = defaultClient) {
  if (!client) return { ok: true, inserted: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: true, inserted: 0, errors: [] };
  }

  const errors = [];
  let inserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { error } = await client
      .from(TABLE)
      .upsert(chunk, { onConflict: 'set_id,number' });

    if (error) {
      errors.push(error.message || String(error));
      // Don't throw — caller chose bulk because they want partial-success
      // semantics on a long-running download. Log + continue.
      continue;
    }
    inserted += chunk.length;
  }

  return { ok: errors.length === 0, inserted, errors };
}

/**
 * APPEND one dated row per card into `card_price_snapshots`.
 *
 * This is the history writer. `bulkSaveCardPrices` above overwrites — it
 * answers "what does this card cost now". This one answers "what did it cost
 * in June", which the upstream APIs cannot tell you after the fact. A refresh
 * cycle that is not captured here is a data point gone permanently.
 *
 * Deliberately separate from bulkSaveCardPrices rather than folded into it:
 * the latest-price write is load-bearing for the arbitrage UI and must not
 * acquire a new failure mode. If the snapshot write dies, prices keep working.
 *
 * Failsafe by the same contract as bulkSaveCardPrices — never throws, returns
 * a benign shape on a null client — but every outcome increments a counter
 * that /api/health reads. A history writer that fails silently is worse than
 * one that fails loudly, because the loss is unrecoverable.
 *
 * Idempotent per day: onConflict on the composite key means a second refresh
 * on the same date replaces that day's row rather than erroring or doubling.
 *
 * @param {CardPriceRow[]} rows
 * @param {object} [client]
 * @returns {Promise<{ ok: boolean, written: number, errors: Array<string> }>}
 */
export async function snapshotCardPrices(rows, client = defaultClient) {
  if (!client) {
    countSnapshot('no_client');
    return { ok: true, written: 0, errors: [] };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    countSnapshot('empty');
    return { ok: true, written: 0, errors: [] };
  }

  countSnapshot('attempted');

  // Only the price payload is historised. Name/rarity/image live in
  // card_prices and do not change per-day; duplicating them across every
  // capture would multiply the table for no analytical gain.
  const snapshots = rows
    .filter((r) => r && r.set_id && r.number)
    .map((r) => ({
      set_id: r.set_id,
      number: r.number,
      tcg: r.tcg ?? null,
      cm: r.cm ?? null,
    }));

  if (snapshots.length === 0) {
    countSnapshot('empty');
    return { ok: true, written: 0, errors: [] };
  }

  const errors = [];
  let written = 0;

  for (let i = 0; i < snapshots.length; i += CHUNK_SIZE) {
    const chunk = snapshots.slice(i, i + CHUNK_SIZE);
    const { error } = await client
      .from(SNAPSHOT_TABLE)
      .upsert(chunk, { onConflict: 'set_id,number,captured_on' });

    if (error) {
      errors.push(error.message || String(error));
      continue;
    }
    written += chunk.length;
  }

  const ok = errors.length === 0;
  countSnapshot(ok ? 'written' : 'failed', written);
  return { ok, written, errors };
}

/**
 * Load every card_prices row into a Map keyed for V1 in-memory parity.
 * Used at boot to warm CARD_PRICES before the arbitrage admin endpoint
 * is allowed to serve traffic.
 *
 * Failsafe: returns an empty Map on null client OR DB error. Callers
 * (initCardDb) decide whether to fall through to the file / pokemontcg.io.
 *
 * @param {object} [client]
 * @returns {Promise<Map<string, object>>}
 */
export async function loadAllCardPrices(client = defaultClient) {
  const out = new Map();
  if (!client) return out;

  // Page through with .range() to dodge the supabase-js default 1000-row
  // cap on .select() without a range.
  const PAGE = 1000;
  let from = 0;

  // Hard ceiling so a runaway query can't loop forever — pokemontcg.io
  // has ~22k cards as of 2026; 200k is comfortably above.
  const HARD_MAX = 200_000;

  while (from < HARD_MAX) {
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .order('set_id', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      console.warn('[price-snapshot] loadAllCardPrices error:', error.message || error);
      return out; // best-effort — return what we have
    }
    if (!Array.isArray(data) || data.length === 0) break;

    for (const row of data) {
      out.set(rowToKey(row), rowToMapValue(row));
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  return out;
}

/**
 * Single-card lookup. Returns the raw row (snake_case columns).
 * Failsafe: null on client unavailable / not found / error.
 *
 * @param {string} set_id
 * @param {string|number} number
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function getCardPrice(set_id, number, client = defaultClient) {
  if (!client) return null;
  if (!set_id || number == null || number === '') return null;

  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('set_id', set_id)
    .eq('number', String(number))
    .maybeSingle();

  if (error) {
    console.warn('[price-snapshot] getCardPrice error:', error.message || error);
    return null;
  }
  return data ?? null;
}

/**
 * Wipe every row in card_prices. Admin escape hatch for the
 * `/api/admin/refresh-prices` flow when the operator wants a clean re-pull.
 * Uses delete().neq('set_id', '__never__') because supabase-js requires a
 * predicate on .delete() — `__never__` won't match any real set_id.
 *
 * Failsafe: noop with ok:true when client is unavailable.
 *
 * @param {object} [client]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function deleteAllCardPrices(client = defaultClient) {
  if (!client) return { ok: true };

  const { error } = await client
    .from(TABLE)
    .delete()
    .neq('set_id', '__never__');

  if (error) return { ok: false, error: error.message || String(error) };
  return { ok: true };
}

// Internal helpers exposed for the spec — keep the surface narrow.
export const __internal = { rowToKey, rowToMapValue };
