// pricing/show/offer.js
//
// Show mode (trade-show QR quote): the arithmetic and the two views of one
// submission. Pure, so tests/regression/show-mode.spec.js pins it directly.
//
// A submission stores the batch quote's rows exactly as
// handleQuoteBatch returned them. Two things are layered on at the counter:
//
//   picks       { rowIndex: candidateIndex }  which card an "ask" line is (-1 = not sure)
//   conditions  { rowIndex: 'NM'|'EX'|... }   the condition staff found in hand
//
// The STAFF view prices every line with those applied. The CUSTOMER view is
// built from the same rows with every number removed: show mode exists so the
// offer is made in person, and a customer page that leaked a price would make
// the counter pointless. customerView() is an allow-list (it copies named
// fields), never a delete-list, so a field added to the rows later cannot leak.

import { entryOf, resolveAsk } from '../../apps/quote/modules/batch.js';
import { CONDITION_MULTIPLIERS, CONDITION_ORDER } from '../conditions.js';

export const SHOW_MAX_LINES = 300;
export const SHOW_MAX_NAME = 40;
export const DEFAULT_RATES = Object.freeze({ cashPct: 55, creditPct: 70 });

const round2 = (n) => Math.round(n * 100) / 100;

/** The shop's rates, or the defaults when missing or out of range. */
export function ratesOf(shop) {
  const pct = (v, d) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : d;
  };
  return {
    cashPct: pct(shop?.cash_pct, DEFAULT_RATES.cashPct),
    creditPct: pct(shop?.credit_pct, DEFAULT_RATES.creditPct),
  };
}

/** The lines worth pricing: trimmed, no blanks, no comments, capped. */
export function showLinesOf(raw) {
  const all = (Array.isArray(raw) ? raw : String(raw ?? '').split('\n'))
    .map((l) => String(l ?? '').trim().slice(0, 200))
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  return all.slice(0, SHOW_MAX_LINES);
}

/** A row with the condition staff set, if any, in place of the typed one. */
function withCondition(row, cond) {
  if (!cond || !(cond in CONDITION_MULTIPLIERS)) return row;
  return { ...row, condition: cond, condition_multiplier: CONDITION_MULTIPLIERS[cond] };
}

/**
 * Every line, priced for staff. Each entry carries its row index (picks and
 * conditions key on it) and a kind: priced | by_hand | ask | not_found.
 */
export function staffEntries(rows, { picks = {}, conditions = {}, rates = DEFAULT_RATES } = {}) {
  return (rows || []).map((raw, index) => {
    const row = withCondition(raw, conditions[index]);
    let e = entryOf(row, rates.cashPct, rates.creditPct);
    let picked = null;
    if (e.ask && picks[index] !== undefined) {
      picked = Number(picks[index]);
      e = resolveAsk(e, picked, rates.cashPct, rates.creditPct);
    }
    const kind = e.ask ? 'ask' : e.error ? 'not_found' : e.byHand ? 'by_hand' : 'priced';
    // The price object behind a priced line: the row's own, or the candidate
    // staff picked. Its detail (every Cardmarket number for the card) is
    // shown on the board when a line is opened.
    const src = kind !== 'priced' ? null
      : picked != null ? (row.candidates?.[picked]?.price ?? null) : (row.price ?? null);
    return {
      index,
      kind,
      line: row.line,
      qty: Math.max(1, Number(row.qty) || 1),
      condition: row.condition || 'NM',
      condition_set: !!conditions[index],
      finish: row.finish || null,
      picked,
      card: e.card || null,
      market: kind === 'priced' ? e.market : null,
      unit_market: kind === 'priced' ? e.unit_market : null,
      cash: kind === 'priced' ? e.cash : null,
      credit: kind === 'priced' ? e.credit : null,
      reason: kind === 'by_hand' ? e.reason : null,
      question: kind === 'ask' ? e.question : null,
      candidates: kind === 'ask'
        ? e.candidates.map((c) => ({
            card: c.card,
            label: c.label || null,
            market: c.price ? c.price.market : null,
            unpriced_reason: c.price ? null : c.unpriced_reason || null,
          }))
        : null,
      message: kind === 'not_found' ? e.error : null,
      detail: src ? {
        basis: src.basis || null,
        field: src.field || null,
        nm_en_fallback: src.nm_en_fallback ?? null,
        as_of: src.as_of || null,
        condition_multiplier: row.condition_multiplier ?? 1,
        guide: src.guide || null,
        cardmarket_url: e.cardmarket_url || null,
      } : null,
      notes: kind === 'priced'
        ? [e.finish_fallback && 'No reverse holo price, priced as the standard card',
           e.capped && 'A one-off price spike was ignored',
           e.dip && "Today's price looked off, recent sales used"].filter(Boolean)
        : [],
    };
  });
}

/** Totals over the priced lines, plus counts of what still needs a person. */
export function staffTotals(entries) {
  const t = { cards: 0, market: 0, cash: 0, credit: 0, by_hand: 0, questions: 0, not_found: 0 };
  for (const e of entries) {
    if (e.kind === 'priced') {
      t.cards += e.qty;
      t.market += e.market;
      t.cash += e.cash;
      t.credit += e.credit;
    } else if (e.kind === 'by_hand') t.by_hand += 1;
    else if (e.kind === 'ask') t.questions += 1;
    else t.not_found += 1;
  }
  return { ...t, market: round2(t.market), cash: round2(t.cash), credit: round2(t.credit) };
}

const CARD_FIELDS = ['name', 'set_name', 'card_number', 'image'];

function cardForCustomer(card) {
  if (!card) return null;
  const out = {};
  for (const k of CARD_FIELDS) if (card[k] != null) out[k] = card[k];
  return out;
}

/**
 * What the customer's phone gets: their lines, and for each whether we
 * recognised it and as which card. No prices, no offers, no reasons that
 * hint at value ("high_value"), only: matched | check (we'll look at it with
 * you) | unmatched.
 */
export function customerView(rows) {
  return (rows || []).map((r) => {
    if (r.status === 'priced' || r.status === 'unpriced') {
      return { line: r.line, qty: Math.max(1, Number(r.qty) || 1), status: 'matched', card: cardForCustomer(r.card) };
    }
    if (r.status === 'ask') return { line: r.line, qty: Math.max(1, Number(r.qty) || 1), status: 'check', card: null };
    return { line: r.line, qty: Math.max(1, Number(r.qty) || 1), status: 'unmatched', card: null };
  });
}

/** Clean staff input for picks/conditions against the stored rows. */
export function cleanPicks(input, rows) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    const i = Number(k);
    const row = rows?.[i];
    if (!Number.isInteger(i) || !row || row.status !== 'ask') continue;
    if (v === null) continue;
    const c = Number(v);
    if (Number.isInteger(c) && c >= -1 && c < (row.candidates?.length || 0)) out[i] = c;
  }
  return out;
}

export function cleanConditions(input, rows) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    const i = Number(k);
    if (!Number.isInteger(i) || !rows?.[i]) continue;
    const c = String(v || '').toUpperCase();
    if (CONDITION_ORDER.includes(c)) out[i] = c;
  }
  return out;
}

export { CONDITION_ORDER };
