// infra/observability/price-snapshot-counters.js
//
// Counts for the append-only price history write (card_price_snapshots).
// Dependency-free for the same reason as fast-path-counters.js: this module is
// reachable from offline scripts and must not start a metrics collector.
//
// WHY THIS EXISTS
//
// The snapshot write is fire-and-forget and failsafe — a Supabase outage must
// never take down a price refresh. That is exactly the shape that hid every
// other defect in this project: the write quietly stops happening, the app
// keeps serving prices, and the gap is only discovered months later when
// somebody asks for history that was never recorded.
//
// A silent history-writer is worse than a loud one that fails, because the
// damage is unrecoverable: upstream only serves current prices, so a week not
// captured is a week gone forever.
//
// The invariant to watch is the ratio, not any single count. `attempted`
// climbing while `written` stays at zero means history collection is dead
// again. /api/health surfaces that.

const counts = {
  /** refresh cycles that reached the snapshot write at all. */
  attempted: 0,
  /** the write returned clean — this day's history actually landed. */
  written: 0,
  /** write ran but Postgres rejected some or all chunks. */
  failed: 0,
  /** no supabase client configured (local dev). Not a failure, but not history either. */
  no_client: 0,
  /** nothing to write — caller passed an empty row set. */
  empty: 0,
};

/** Rows successfully written, cumulative. Depth, not just success/fail. */
let rowsWritten = 0;
/** ISO timestamp of the last clean write, or null if it has never happened. */
let lastWriteAt = null;

export function countSnapshot(outcome, rows = 0) {
  if (outcome in counts) counts[outcome] += 1;
  if (outcome === 'written') {
    rowsWritten += rows;
    lastWriteAt = new Date().toISOString();
  }
}

export function getSnapshotCounts() {
  const { attempted, written } = counts;
  return {
    ...counts,
    rows_written: rowsWritten,
    last_write_at: lastWriteAt,
    // null rather than 0 when nothing has been attempted. "Never asked" and
    // "asked and always failed" are different states, and conflating them is
    // precisely how a dead write path reads as healthy.
    write_rate: attempted > 0 ? written / attempted : null,
  };
}

/** Test seam. */
export function resetSnapshotCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
  rowsWritten = 0;
  lastWriteAt = null;
}
