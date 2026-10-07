// apps/quote/modules/batch.js
//
// Whole-list quote for Pokémon: ONE request for every line the customer typed
// (POST /api/v2/quote/batch). Matching and pricing happen on the server against
// the local catalogue and the daily Cardmarket price guide, so there is no
// per-card request, no per-card rate limit, and a whole collection fits.
//
// This module only turns the server's rows into the page's result entries:
//
//   priced     -> { card, qty, market, cash, credit, ... }   (offers x qty)
//   unpriced   -> { byHand: true, card, reason, line }       ("we'll price it by hand")
//   ask        -> { ask: true, question, candidates, ... }   (customer picks)
//   not_found / not_supported -> { error, line }
//
// Offers use the server's condition multiplier (pricing/conditions.js), not the
// page's old five-grade table, so a typed "lp" prices the same here as at the
// till.

import { calcOffersWithMult } from './totals.js';
import { buildCardmarketUrl } from './cardmarket-url.js';

/** Same bound as the server (apps/server/routes/quote-batch.js). */
export const MAX_BATCH_LINES = 1000;

const round2 = (n) => Math.round(n * 100) / 100;

/** The lines worth sending: trimmed, no blanks, no comments. */
export function batchLinesOf(raw) {
  return String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
}

function linkFor(card) {
  if (!card) return null;
  return buildCardmarketUrl({
    game: 'pokemon',
    set_code: card.set_id,
    set_name: card.set_name,
    name: card.name,
    card_number: card.card_number,
  });
}

/** A priced entry for the page, offers multiplied out by quantity. */
export function pricedEntry(card, price, row, cashPct, creditPct) {
  const qty = Math.max(1, Number(row.qty) || 1);
  const unit = calcOffersWithMult(price.market, row.condition_multiplier ?? 1, cashPct, creditPct);
  return {
    card: { ...card, game: 'pokemon', condition_estimate: row.condition || 'NM' },
    line: row.line,
    qty,
    market: round2(unit.market * qty),
    cash: round2(unit.cash * qty),
    credit: round2(unit.credit * qty),
    unit_market: unit.market,
    as_of: price.as_of || null,
    finish: row.finish || null,
    finish_fallback: !!price.finish_fallback,
    capped: !!price.capped,
    dip: !!price.dip,
    cardmarket_url: linkFor(card),
  };
}

export function byHandEntry(card, reason, row) {
  return {
    byHand: true,
    card: card ? { ...card, game: 'pokemon', condition_estimate: row.condition || 'NM' } : null,
    line: row.line,
    qty: Math.max(1, Number(row.qty) || 1),
    reason: reason || 'no_price',
  };
}

/** One server row -> one page entry. */
export function entryOf(row, cashPct, creditPct) {
  if (row.status === 'priced' && row.price) return pricedEntry(row.card, row.price, row, cashPct, creditPct);
  if (row.status === 'unpriced') return byHandEntry(row.card, row.unpriced_reason, row);
  if (row.status === 'ask' && Array.isArray(row.candidates) && row.candidates.length) {
    return {
      ask: true,
      line: row.line,
      question: row.question,
      reprint: !!row.reprint_question,
      candidates: row.candidates,
      row,
    };
  }
  return { error: row.message || 'Not found', line: row.line };
}

/**
 * Settle a question. idx is the candidate the customer tapped; -1 means
 * "not sure", which becomes a by-hand line rather than a guess.
 */
export function resolveAsk(entry, idx, cashPct, creditPct) {
  const c = idx >= 0 ? entry.candidates[idx] : null;
  if (!c) return byHandEntry(null, 'customer_unsure', entry.row);
  if (!c.price) return byHandEntry(c.card, c.unpriced_reason, entry.row);
  return pricedEntry(c.card, c.price, entry.row, cashPct, creditPct);
}

/**
 * Run the whole-list quote.
 * @returns {Promise<{entries: object[], meta: object}>}
 */
export async function runBatchQuote({ text, cashPct, creditPct, request }) {
  const lines = batchLinesOf(text).slice(0, MAX_BATCH_LINES);
  const resp = await request('/api/v2/quote/batch', {
    method: 'POST',
    body: { lines, game: 'pokemon' },
  });
  if (!resp.ok) {
    const msg = (resp.body && resp.body.error) || `Quote failed (HTTP ${resp.status})`;
    throw new Error(msg);
  }
  const body = resp.body || {};
  return {
    entries: (body.rows || []).map((r) => entryOf(r, cashPct, creditPct)),
    meta: {
      pricesAsOf: body.prices_as_of || null,
      pricesUsable: body.prices_usable !== false,
      summary: body.summary || null,
    },
  };
}
