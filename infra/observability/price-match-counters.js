// infra/observability/price-match-counters.js
//
// Counts for the product-match gate in the price adapters. Dependency-free for
// the same reason as fast-path-counters.js: reachable from offline scripts,
// must not start a metrics collector.
//
// WHY THIS EXISTS
//
// Each adapter searches an upstream catalogue and picks a product to price.
// Until 14 Aug 2026 they seeded that choice to the FIRST search result and
// returned it regardless of score, so a name-only match — right Pokémon, wrong
// set, wrong number — was priced as the identified card.
//
// Measured symptom: a Charizard ex SVP 56 worth about €15 on Cardmarket was
// quoted at €561.50, because a different Charizard ex headed the five-result
// search page. The Cardmarket link displayed beside it was correct, since the
// link is built from our own identity rather than from the matched product, so
// the two disagreed by 37x and nothing was positioned to notice.
//
// COUNT PER SOURCE, NOT IN AGGREGATE.
//
// The cascade tries tcggo, then justtcg, then tcgplayer. A blended rate hides
// the case that matters: one adapter's gate tightening while the next one
// happily prices the rejects off its own first search hit. That is not coverage
// recovered, it is the same defect one rung down, and an aggregate number would
// have read as healthy throughout.
//
// Watch the RATIO. A bare count of rejections is unreadable without the
// denominator, and "never asked" must stay distinguishable from "asked and
// always rejected" — conflating those is how a dead path reads as healthy.
//
//   match_rate near 1.0    the gate is idle; it is not doing anything
//   match_rate collapsing  either upstream search degraded or our card numbers
//                          are being misread. Both are real defects, and both
//                          previously surfaced as confident wrong prices rather
//                          than as missing ones.

const OUTCOMES = [
  /** a product matched on card number and was priced. */
  'matched',
  /** we had a number, no candidate agreed with it. No price returned. */
  'rejected_no_number_match',
  /** the identification carried no card number, so nothing could be confirmed. */
  'rejected_no_number_read',
  /** upstream returned zero candidates. Not a match failure — an absent card. */
  'no_candidates',
];

const bySource = new Map();
let lastRejection = null;

function slot(source) {
  if (!bySource.has(source)) {
    const s = { candidates_rejected: 0 };
    for (const o of OUTCOMES) s[o] = 0;
    bySource.set(source, s);
  }
  return bySource.get(source);
}

/**
 * @param {string} source  adapter name, e.g. 'tcggo' | 'justtcg'
 * @param {string} outcome one of OUTCOMES
 * @param {{requested?: string, candidates?: number}} [detail]
 */
export function countPriceMatch(source, outcome, detail = null) {
  const s = slot(source);
  if (outcome in s) s[outcome] += 1;
  if (outcome === 'rejected_no_number_match' && detail) {
    s.candidates_rejected += detail.candidates ?? 0;
    lastRejection = {
      source,
      requested: detail.requested ?? null,
      candidates: detail.candidates ?? 0,
      at: new Date().toISOString(),
    };
  }
}

function rateOf(s) {
  const asked = s.matched + s.rejected_no_number_match + s.rejected_no_number_read;
  // null rather than 0 when never asked. See the header.
  return asked > 0 ? s.matched / asked : null;
}

export function getPriceMatchCounts() {
  const totals = { candidates_rejected: 0 };
  for (const o of OUTCOMES) totals[o] = 0;

  const by_source = {};
  for (const [name, s] of bySource) {
    by_source[name] = { ...s, match_rate: rateOf(s) };
    for (const k of Object.keys(totals)) totals[k] += s[k];
  }

  return {
    ...totals,
    by_source,
    last_rejection: lastRejection,
    match_rate: rateOf(totals),
  };
}

/** Test seam. */
export function resetPriceMatchCounts() {
  bySource.clear();
  lastRejection = null;
}
