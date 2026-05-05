// apps/quote/modules/totals.js
// Owner: A5 | Slice: S8
//
// Pure helpers for the customer quote: condition multipliers + per-card
// price math + sum-of-quote totals. Pinned by V2_AUDIT §1c, lines 565-568
// (public/quote.html).
//
// V1 contract:
//   effectiveMV = mv × CONDITION_MULTS[condition_estimate]
//   cash        = round2(effectiveMV × cashPct  / 100)
//   credit      = round2(effectiveMV × creditPct/ 100)
//
// Defaults (no shop override) are 55% cash / 70% credit. V2_AUDIT §1c line
// 286 of public/quote.html anchors that messaging in the UI; the same
// numbers must round-trip through /api/quote-lead unchanged.

export const DEFAULT_CASH_PCT = 55;
export const DEFAULT_CREDIT_PCT = 70;

/**
 * NM/LP/MP/HP/DMG multipliers — same values as pricing/conditions.js will
 * land in S6. Duplicated here only for in-browser use; if the customer
 * page ever moves to using the server's buy_calc envelope from /api/v2/price,
 * this table goes away (V2_ARCHITECTURE §3.2).
 */
export const CONDITION_MULTS = Object.freeze({
  NM: 1.0,
  LP: 0.85,
  MP: 0.7,
  HP: 0.5,
  DMG: 0.3,
});

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Compute per-card cash/credit/effective-market-value from a raw market
 * value, the card's condition estimate, and the current shop pcts.
 * @param {number} marketValue
 * @param {string|undefined} conditionEstimate
 * @param {number} cashPct
 * @param {number} creditPct
 */
export function calcCardOffers(marketValue, conditionEstimate, cashPct, creditPct) {
  const mv = Number(marketValue) || 0;
  const condMult = CONDITION_MULTS[conditionEstimate] || 1;
  const effective = mv * condMult;
  return {
    market: mv,
    cash: round2(effective * (cashPct / 100)),
    credit: round2(effective * (creditPct / 100)),
  };
}

/**
 * Sum all priced rows (errors are skipped) into {market, cash, credit}.
 * @param {Array<{market?:number, cash?:number, credit?:number, error?:string}>} rows
 */
export function sumTotals(rows) {
  let market = 0,
    cash = 0,
    credit = 0;
  for (const r of rows || []) {
    if (!r || r.error) continue;
    market += Number(r.market) || 0;
    cash += Number(r.cash) || 0;
    credit += Number(r.credit) || 0;
  }
  return { market, cash, credit };
}

/** Format a number as a euro string with two decimals. */
export function formatEur(n) {
  return '€' + (Number(n) || 0).toFixed(2);
}
