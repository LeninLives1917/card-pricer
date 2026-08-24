// pricing/snapshot-writer.js
//
// Owner: A2 (Pricing engine)
//
// Writes one row per card per day into card_price_snapshots.
//
// WHY THIS EXISTS
//
// The table was created and then never written to. Measured 24 Aug 2026:
//
//     card_prices            19,251 rows, ALL from 2026-08-06 — one snapshot,
//                            and its Cardmarket half is the frozen
//                            pokemontcg.io feed, median 209 days old
//     card_price_snapshots        0 rows, correct shape
//
// So there is no time series at all. That matters for three separate reasons:
//
//  1. VELOCITY. Cardmarket publishes no sales count, and its own API is closed
//     to new applications. available_items — the live listing count, which the
//     adapter used to discard — is the only supply signal available. One number
//     is a level; the DELTA is the signal. Listings falling while the price
//     holds means the card is moving.
//
//  2. TRUST IN THE ASKING PRICE. Measured on the same day: with 79 listings the
//     lowest ask sits at 1.39x the 30-day average; with 11,468 it sits at 0.67x.
//     Thin supply is where a single optimistic seller sets our buy price.
//
//  3. NOTICING THE NEXT OUTAGE OURSELVES. pokemontcg.io's euro feed froze and
//     nobody found out for months, because nothing recorded what the numbers
//     looked like yesterday. Our own history is the only thing that turns that
//     from an archaeology problem into an alarm.
//
// NO EXTRA API CALLS. This records what a lookup already fetched. A card the
// shop never prices never gets a row, which is the right trade: the cards you
// handle are the cards you need history for, and a full nightly crawl is a
// separate job with a separate budget (1,097 requests per pass).
//
// FIRE AND FORGET, ALWAYS. A snapshot is bookkeeping. It must never delay a
// price, never fail one, and never throw into the request path — an operator at
// a counter does not care that the history table is unreachable.

import { countPriceMatch } from '../infra/observability/price-match-counters.js';

const SOURCE = 'snapshot';

/**
 * One row per card per DAY, not per lookup. Pricing the same card six times in
 * a session must not write six rows — the series is daily, and a burst of
 * identical rows would make any delta computed off it meaningless.
 *
 * Process-local, so a restart may write one extra row for a card already
 * captured today. Harmless: the upsert below is keyed on (set_id, number,
 * captured_on) and simply overwrites.
 */
const writtenToday = new Set();

const counters = {
  attempted: 0,
  written: 0,
  skipped_same_day: 0,
  skipped_no_key: 0,
  skipped_no_data: 0,
  failed: 0,
};

/** UTC, deliberately: a shop in Ireland and a database in eu-west-1 must agree. */
export function captureDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the row, or null when there is nothing worth storing.
 *
 * Pure and exported so the shape is specced without a database.
 */
export function buildSnapshotRow(card, pricing, now = new Date()) {
  const setId = card?.set_id ?? card?.setId ?? card?.set_code ?? null;
  const number = card?.card_number ?? card?.number ?? null;
  if (!setId || !number) return null;

  const cm = pricing?.rapidapi_cm ?? pricing?.cardmarket ?? null;
  const tcg = pricing?.tcgplayer ?? null;

  // A row with no numbers on it is not a data point, it is a heartbeat. Storing
  // it would put gaps in the series that look like real zero-supply days.
  const hasCm = cm && (
    Number.isFinite(cm.lowest_nm) || Number.isFinite(cm.price)
    || Number.isFinite(cm.avg30) || Number.isFinite(cm.available_items)
  );
  const hasTcg = tcg && Number.isFinite(tcg.price);
  if (!hasCm && !hasTcg) return null;

  return {
    set_id: String(setId).toLowerCase(),
    number: String(number),
    captured_on: captureDay(now),
    cm: hasCm ? {
      lowest_nm: numOrNull(cm.lowest_nm ?? cm.price),
      lowest_nm_eu: numOrNull(cm.lowest_nm_eu),
      avg7: numOrNull(cm.avg7),
      avg30: numOrNull(cm.avg30),
      // THE POINT OF THE EXERCISE. Everything else here is a price level;
      // this is the one field whose day-over-day change carries information
      // Cardmarket does not otherwise publish.
      available_items: numOrNull(cm.available_items),
      cardmarket_id: cm.cardmarket_id ?? null,
      // What tied this price to this card. Without it a future reader cannot
      // tell a confirmed match from a sole-candidate guess, and would average
      // the two together.
      evidence: cm.set_evidence ?? cm.match_evidence ?? null,
      source: cm.source ?? null,
    } : null,
    tcg: hasTcg ? {
      price: numOrNull(tcg.price),
      source: tcg.source ?? null,
    } : null,
  };
}

const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/**
 * Record a priced card. Never throws, never awaits anything the caller needs.
 *
 * @param {object} card     the identified card
 * @param {object} pricing  the assembled pricing object
 * @param {object} deps     { supabase } — injected, because the project forbids
 *                          mock.module() and a writer that imports its own
 *                          client cannot be tested.
 */
export async function recordSnapshot(card, pricing, deps = {}) {
  counters.attempted += 1;
  try {
    const row = buildSnapshotRow(card, pricing, deps.now ? new Date(deps.now) : new Date());
    if (!row) {
      // Distinguish the two reasons. "No key" means identification did not give
      // us enough to file the row against; "no data" means nothing was priced.
      const setId = card?.set_id ?? card?.setId ?? card?.set_code ?? null;
      const number = card?.card_number ?? card?.number ?? null;
      if (!setId || !number) counters.skipped_no_key += 1;
      else counters.skipped_no_data += 1;
      return false;
    }

    const key = `${row.set_id}|${row.number}|${row.captured_on}`;
    if (writtenToday.has(key)) {
      counters.skipped_same_day += 1;
      return false;
    }

    const db = deps.supabase;
    if (!db) {
      counters.failed += 1;
      return false;
    }

    // Upsert on the daily key: pricing a card twice in a day refreshes the row
    // rather than duplicating it.
    const { error } = await db
      .from('card_price_snapshots')
      .upsert(row, { onConflict: 'set_id,number,captured_on' });

    if (error) {
      counters.failed += 1;
      // Counted AND logged: a writer that silently stops is indistinguishable
      // from a shop that priced nothing, which is the defect shape this project
      // keeps closing.
      console.warn(`[SNAPSHOT] write failed for ${key}: ${error.message}`);
      countPriceMatch(SOURCE, 'adapter_error', { error: 'supabase', message: error.message });
      return false;
    }

    writtenToday.add(key);
    counters.written += 1;
    return true;
  } catch (err) {
    counters.failed += 1;
    console.warn(`[SNAPSHOT] unexpected: ${err.message}`);
    return false;
  }
}

/**
 * For /api/health. Reports the RATIO — a bare "written: 40" says nothing
 * without knowing how many cards were priced.
 */
export function snapshotState() {
  const a = counters.attempted;
  return {
    ...counters,
    tracked_today: writtenToday.size,
    // null, not 0, when nothing has been priced this boot. "Never asked" and
    // "asked and always failed" are different facts.
    write_rate: a === 0 ? null : Math.round((counters.written / a) * 1000) / 1000,
  };
}

/** Test seam. */
export function _resetSnapshots() {
  writtenToday.clear();
  for (const k of Object.keys(counters)) counters[k] = 0;
}
