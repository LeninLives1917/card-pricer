// infra/observability/fast-path-counters.js
//
// Counts for the local identification fast path. Deliberately dependency-free:
// pricing/ is imported by offline scripts, and infra/observability/metrics.js
// calls collectDefaultMetrics() at import time, so pulling prom-client in here
// would start a metrics collector inside every crawler run.
//
// WHY THIS EXISTS
//
// The pHash fast path did not work in production for months, for three
// independent sufficient reasons, and nobody knew — because falling back is
// silent and indistinguishable from never being asked. Every incident in this
// project has that shape: a component fails, something plausible is returned,
// and nothing counts how often the good path actually ran.
//
// The rule this enforces: every fallback path increments a counter something
// reads. Falling back is fine. Falling back invisibly is the defect.
//
// The invariant worth watching is not any single number but a ratio:
// `attempted` climbing while `hit` stays at zero means the fast path is dead
// again. /api/health surfaces exactly that.

const counts = {
  /** identify calls that reached the hash lookup at all. */
  attempted: 0,
  /** lookup returned a card AND it was usable — the fast path actually paid. */
  hit: 0,
  /** no candidate within the Hamming threshold. Ordinary; not a defect. */
  miss: 0,
  /**
   * Lookup matched, but CARD_DB had no reference_image so the result could not
   * be returned and we fell through to the vision model. This is the expensive
   * one: the index is RIGHT and the work is thrown away. It was a console.warn
   * nobody read.
   */
  unusable: 0,
  /** hint set — caller explicitly bypassed all caches. Not a failure. */
  skipped: 0,
};

export function countFastPath(outcome) {
  if (outcome in counts) counts[outcome] += 1;
}

export function getFastPathCounts() {
  const { attempted, hit, unusable } = counts;
  return {
    ...counts,
    // null rather than 0 when nothing has been attempted: "0% hit rate" and
    // "never asked" are different states, and conflating them is how a dead
    // fast path hides.
    hit_rate: attempted > 0 ? hit / attempted : null,
    unusable_rate: attempted > 0 ? unusable / attempted : null,
  };
}

/** Test seam. */
export function resetFastPathCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
}
