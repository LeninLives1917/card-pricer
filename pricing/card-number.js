// pricing/card-number.js
//
// One definition of "are these two printed card numbers the same".
//
// It lives here because every price adapter needs it and each one had grown its
// own version — `itemNum === num` after a bare `.replace(/\/.*/, '')`, repeated
// in tcggo-rapidapi.js, justtcg.js and pokemontcg.js. That comparison answers
// false for "056" against "56", which is not a rare shape: our own reads carry
// the printed zero-padding and upstream catalogues generally do not. Every one
// of those false answers sent the adapter to its no-match fallback, which until
// 14 Aug 2026 meant "price the first search hit regardless".
//
// So a disagreement about leading zeros was silently a wrong price. Keep the
// rule in one place.

/**
 * Reduce a printed card number to a comparable token.
 *
 *   "073/084" -> "73"      denominator dropped; upstream stores the numerator
 *   "056"     -> "56"      leading zeros are presentation, not identity
 *   "SVP 056" -> "svp056"  promo prefixes ARE identity — kept
 *   "/84"     -> null      a denominator alone identifies nothing
 *
 * @param {string|number|null|undefined} n
 * @returns {string|null} null when there is nothing comparable. Callers must
 *   treat null as "cannot confirm" and abstain — never as a value that can
 *   match another null, or every numberless card matches every other one.
 */
export function normaliseCardNumber(n) {
  if (n == null) return null;
  const s = String(n).trim().replace(/\/.*$/, '').replace(/\s+/g, '').toLowerCase();
  if (!s) return null;
  return s.replace(/^0+(?=.)/, '');
}

/**
 * Do a requested card number and a candidate's number identify the same
 * printing? False whenever either side is unusable — an unknown number is not
 * a match, and pricing on one is a guess.
 */
export function sameCardNumber(a, b) {
  const x = normaliseCardNumber(a);
  const y = normaliseCardNumber(b);
  return x != null && y != null && x === y;
}
