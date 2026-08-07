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
  /** PHASH_FAST_PATH=off — the lookup was not run at all. */
  disabled: 0,

  // ── Shadow scoring ────────────────────────────────────────────────
  //
  // In shadow mode the fast path still runs and still records a hit, but
  // does not answer; the vision model does. Comparing the two turns every
  // production scan into a labelled data point at no risk to the operator.
  //
  // This exists because the fast path was measured wrong 4 times out of 4
  // on 2026-08-07 while answering authoritatively. `agree` is what must
  // climb before it is allowed to answer again, over a stated N — and NOT
  // by re-tuning PHASH_HAMMING_MAX against those same 4 observations.

  /** shadow said the same card the vision model did. */
  shadow_agree: 0,
  /** shadow said a DIFFERENT card — a false positive it would have served. */
  shadow_disagree: 0,
  /** shadow fired but the vision model returned nothing to compare against. */
  shadow_unscored: 0,
};

export function countFastPath(outcome) {
  if (outcome in counts) counts[outcome] += 1;
}

export function getFastPathCounts() {
  const { attempted, hit, unusable, shadow_agree, shadow_disagree } = counts;
  const scored = shadow_agree + shadow_disagree;
  return {
    ...counts,
    // null rather than 0 when nothing has been attempted: "0% hit rate" and
    // "never asked" are different states, and conflating them is how a dead
    // fast path hides.
    hit_rate: attempted > 0 ? hit / attempted : null,
    unusable_rate: attempted > 0 ? unusable / attempted : null,
    // The number that decides whether the fast path may answer again. null
    // until something has actually been scored — an unmeasured path must
    // never read as a safe one.
    shadow_agree_rate: scored > 0 ? shadow_agree / scored : null,
    shadow_scored: scored,
  };
}

/**
 * Score one shadow prediction against what the vision model concluded.
 * Returns the outcome recorded, for logging.
 */
export function scoreShadow(shadowCard, visionCards, sameCard) {
  const vision = Array.isArray(visionCards) ? visionCards[0] : null;
  if (!shadowCard || !vision) {
    counts.shadow_unscored += 1;
    return 'unscored';
  }
  const agreed = sameCard(shadowCard, vision);
  counts[agreed ? 'shadow_agree' : 'shadow_disagree'] += 1;
  return agreed ? 'agree' : 'disagree';
}

/** Test seam. */
export function resetFastPathCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
}
