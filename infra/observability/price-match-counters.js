// infra/observability/price-match-counters.js
//
// Counts for the TCGGO product-match gate (pricing/adapters/tcggo-rapidapi.js).
// Dependency-free for the same reason as fast-path-counters.js: reachable from
// offline scripts, must not start a metrics collector.
//
// WHY THIS EXISTS
//
// The adapter searches an upstream catalogue by name-plus-number and picks a
// product to price. Until 14 Aug 2026 it seeded its choice to the FIRST search
// result and returned it regardless of score, so a name-only match — right
// Pokémon, wrong set, wrong number — was priced as the identified card.
//
// Measured symptom: a Charizard ex SVP 56 with a Cardmarket value of about €15
// was quoted at €561.50, because a different Charizard ex headed the five-result
// search page. The Cardmarket link displayed beside it was correct, since the
// link is built from our own identity rather than from the matched product, so
// the two disagreed and nothing was positioned to notice.
//
// The gate now requires the card number to agree before a price is returned.
// That necessarily costs coverage, and the whole point of these counters is to
// make the cost visible instead of guessing at it:
//
//   match_rate near 1.0    the gate is idle — it is not doing anything
//   match_rate collapsing  either upstream search got worse or our card numbers
//                          are being misread. Both are real defects, and both
//                          previously showed up as confident wrong prices
//                          rather than as missing ones.
//
// Watch the RATIO. A bare count of rejections is unreadable without the
// denominator, and "never asked" must stay distinguishable from "asked and
// always rejected" — conflating those is how a dead path reads as healthy.

const counts = {
  /** a product matched on card number and was priced. */
  matched: 0,
  /** we had a number, no candidate agreed with it. No price returned. */
  rejected_no_number_match: 0,
  /** the identification carried no card number, so nothing could be confirmed. */
  rejected_no_number_read: 0,
  /** upstream returned zero candidates. Not a match failure — an absent card. */
  no_candidates: 0,
};

/** Cumulative candidates rejected, so a near-miss is distinguishable from a rout. */
let candidatesRejected = 0;
/** The most recent rejection, for eyeballing in /api/health without log-diving. */
let lastRejection = null;

export function countPriceMatch(outcome, detail = null) {
  if (outcome in counts) counts[outcome] += 1;
  if (outcome === 'rejected_no_number_match' && detail) {
    candidatesRejected += detail.candidates ?? 0;
    lastRejection = {
      requested: detail.requested ?? null,
      candidates: detail.candidates ?? 0,
      at: new Date().toISOString(),
    };
  }
}

export function getPriceMatchCounts() {
  const { matched, rejected_no_number_match, rejected_no_number_read } = counts;
  const asked = matched + rejected_no_number_match + rejected_no_number_read;
  return {
    ...counts,
    candidates_rejected: candidatesRejected,
    last_rejection: lastRejection,
    // null, not 0, when the adapter has never been asked. See the header.
    match_rate: asked > 0 ? matched / asked : null,
  };
}

/** Test seam. */
export function resetPriceMatchCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
  candidatesRejected = 0;
  lastRejection = null;
}
