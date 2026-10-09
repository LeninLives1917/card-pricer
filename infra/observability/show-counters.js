// infra/observability/show-counters.js
//
// Counts for show mode (trade-show QR quote, apps/server/routes/show.js),
// reported in /api/health -> show.
//
// The failure worth catching: a submission is saved but could not be priced
// (catalogue loading, prices stale, the quote throwing). The customer is told
// to head to the counter either way, so nothing on their side would show it;
// staff would find an unpriced list at the worst moment. So every save that
// came without prices is counted, and the ratio is reported.
//
// null is "nobody has submitted since boot", not 0%.

const counts = {
  submitted: 0,
  priced_on_submit: 0,
  unpriced_on_submit: 0,
  repriced: 0,
  save_failed: 0,
  staff_updates: 0,
};
const unpricedBy = {};
// customer = typed on the QR page; staff = typed on the staff board.
const bySource = {};
let lastSubmitAt = null;

export function countSubmitted({ priced, reason, source = 'customer' } = {}) {
  counts.submitted += 1;
  bySource[source] = (bySource[source] || 0) + 1;
  lastSubmitAt = new Date().toISOString();
  if (priced) counts.priced_on_submit += 1;
  else {
    counts.unpriced_on_submit += 1;
    const k = reason || 'unknown';
    unpricedBy[k] = (unpricedBy[k] || 0) + 1;
  }
}
export function countRepriced() { counts.repriced += 1; }
export function countSaveFailed() { counts.save_failed += 1; }
export function countStaffUpdate() { counts.staff_updates += 1; }

export function getShowCounts() {
  return {
    ...counts,
    unpriced_by_reason: { ...unpricedBy },
    by_source: { ...bySource },
    priced_ratio: counts.submitted ? Number((counts.priced_on_submit / counts.submitted).toFixed(3)) : null,
    last_submit_at: lastSubmitAt,
  };
}

export function resetShowCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
  for (const k of Object.keys(unpricedBy)) delete unpricedBy[k];
  for (const k of Object.keys(bySource)) delete bySource[k];
  lastSubmitAt = null;
}
