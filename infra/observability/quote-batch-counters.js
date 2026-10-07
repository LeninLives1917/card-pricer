// infra/observability/quote-batch-counters.js
//
// Counts for the whole-list customer quote (POST /api/v2/quote/batch) and for
// every rate-limit refusal on the public quote routes.
//
// Dependency-free, same as the other counter modules, so offline scripts can
// import it without starting a metrics collector.
//
// WHY THE RATE LIMITS ARE COUNTED
//
// Until 7 Oct 2026 the quote page shared one 10-per-hour limiter between the
// card lookups, the pricing calls and the email step. Two calls per card meant
// a customer with five cards had their email step refused, and the prices stay
// blurred until that step succeeds, so they never saw a quote. Nothing counted
// the refusals, so it could not show up anywhere. Now it can.
//
// Keep null distinct from zero: a ratio over no lines is null ("nobody has
// quoted since boot"), not 0%.

const LINE_OUTCOMES = ['priced', 'unpriced', 'asked', 'not_found', 'not_supported'];

const counts = {
  quotes: 0,
  lines: 0,
  rejected_too_many: 0,
  reprint_asks: 0,
  spike_capped: 0,
  trend_dips: 0,
  finish_fallback: 0,
  augmented_hits: 0,
  // Priced lines by which number they were priced from (7 Oct 2026): the
  // cheapest NM English copy, which is the point, or the guide's value, which
  // is the fallback and is counted by reason in onGuideBy.
  priced_nm_en: 0,
  priced_on_guide: 0,
};
for (const o of LINE_OUTCOMES) counts[o] = 0;

const onGuideBy = {};
const unpricedBy = {};
const rateLimited = {};
// Lines answered by a REWRITE rather than as typed (quote-batch.js
// resolveCustomer): qualifiers_moved, context_dropped, context_unconfirmed.
// These are fallbacks, so they are counted like any other.
const rescuedBy = {};
let rewriteBudgetExhausted = 0;
let lastQuoteAt = null;

/** One finished quote request. */
export function countQuote(rows) {
  counts.quotes += 1;
  lastQuoteAt = new Date().toISOString();
  for (const r of rows || []) {
    counts.lines += 1;
    const o = r.status === 'ask' ? 'asked' : r.status;
    if (o in counts) counts[o] += 1;
    if (r.status === 'unpriced' && r.unpriced_reason) {
      unpricedBy[r.unpriced_reason] = (unpricedBy[r.unpriced_reason] || 0) + 1;
    }
    if (r.reprint_question) counts.reprint_asks += 1;
    if (r.status === 'priced' && r.price) {
      if (r.price.basis === 'nm_en') counts.priced_nm_en += 1;
      else {
        counts.priced_on_guide += 1;
        const why = r.price.nm_en_fallback || 'unknown';
        onGuideBy[why] = (onGuideBy[why] || 0) + 1;
      }
    }
    if (r.price?.capped) counts.spike_capped += 1;
    if (r.price?.dip) counts.trend_dips += 1;
    if (r.price?.finish_fallback) counts.finish_fallback += 1;
    if (r.card?.augmented) counts.augmented_hits += 1;
    if (r.rescue) rescuedBy[r.rescue] = (rescuedBy[r.rescue] || 0) + 1;
  }
}

/** A request that ran out of rewrite budget; its remaining lines were answered as typed. */
export function countRewriteBudgetExhausted() {
  rewriteBudgetExhausted += 1;
}

/** A request refused for having too many lines. */
export function countRejectedTooMany() {
  counts.rejected_too_many += 1;
}

/** A 429 from one of the quote limiters. */
export function countRateLimited(limiter) {
  rateLimited[limiter] = (rateLimited[limiter] || 0) + 1;
}

const rateOf = (n, d) => (d > 0 ? n / d : null);

export function getQuoteBatchCounts() {
  return {
    ...counts,
    priced_ratio: rateOf(counts.priced, counts.lines),
    asked_ratio: rateOf(counts.asked, counts.lines),
    not_found_ratio: rateOf(counts.not_found, counts.lines),
    nm_en_ratio: rateOf(counts.priced_nm_en, counts.priced),
    on_guide_by_reason: { ...onGuideBy },
    unpriced_by_reason: { ...unpricedBy },
    rescued_by: { ...rescuedBy },
    rescued_ratio: rateOf(Object.values(rescuedBy).reduce((a, b) => a + b, 0), counts.lines),
    rewrite_budget_exhausted: rewriteBudgetExhausted,
    rate_limited: { ...rateLimited },
    last_quote_at: lastQuoteAt,
  };
}

/** Test seam. */
export function resetQuoteBatchCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
  for (const k of Object.keys(unpricedBy)) delete unpricedBy[k];
  for (const k of Object.keys(onGuideBy)) delete onGuideBy[k];
  for (const k of Object.keys(rateLimited)) delete rateLimited[k];
  for (const k of Object.keys(rescuedBy)) delete rescuedBy[k];
  rewriteBudgetExhausted = 0;
  lastQuoteAt = null;
}
