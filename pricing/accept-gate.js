// pricing/accept-gate.js
//
// When may a local match be auto-accepted without a human looking at it?
//
// The V3 gate run (docs/V3_BENCHMARK.md §13) measured 96.1% top-1 on cards that
// exist in the catalogue — but raw accuracy is the wrong question for a
// buy-list. A wrong price costs real money; an abstention costs a second. So
// the operating question is: how many cards can be accepted with NO wrong
// answers, and what happens to the rest?
//
// Two conditions, because one is not enough:
//
//   score   cosine similarity to the best match. Necessary but not sufficient —
//           one wrong answer survived all the way to 0.876, higher than many
//           correct ones.
//   margin  gap to the runner-up. That wrong answer was a REPRINT (Ethan's
//           Slugma, Destined Rivals vs Ascended Heroes — two prints sharing
//           artwork), and it carried a margin of 0.026 where correct matches
//           above 0.80 carried a median of 0.129. A near-tie between two cards
//           is precisely the signal that the image cannot distinguish them.
//
// Measured on 64 real photographs:
//
//   score >= 0.876                    11/64 (17.2%) accepted, 0 wrong
//   score >= 0.850 AND margin >= 0.05 25/64 (39.0%) accepted, 0 wrong
//
// The second condition more than doubles zero-error coverage. That is the
// cheapest accuracy win available and it needs no model change.
//
// CALIBRATION CAVEAT — these thresholds come from one 115-second photo session
// of roughly 40 distinct cards. "Zero errors" is 25/25: no OBSERVED errors, not
// a bounded error rate. Re-fit against a larger, stratified set before treating
// them as safe in production.

/** Auto-accept: high confidence AND a clear gap to the runner-up. */
export const ACCEPT_SCORE_MIN = 0.850;
export const ACCEPT_MARGIN_MIN = 0.05;

/**
 * Review lane floor. Between this and ACCEPT_SCORE_MIN the top candidate is
 * usually right but not provably so — worth showing the operator with a
 * reference thumbnail to confirm by eye. That costs a second and no API call,
 * which is far cheaper than either a wrong answer or a Sonnet round trip.
 */
export const REVIEW_SCORE_MIN = 0.700;

export const DECISION = {
  ACCEPT: 'accept',   // green — use it
  REVIEW: 'review',   // amber — show the operator, one tap to confirm
  REJECT: 'reject',   // red   — fall back to the vision model
};

/**
 * Decide what to do with a ranked candidate list.
 *
 * @param {Array<{ id: string, score: number }>} candidates
 *   Best-first, score higher-is-better (cosine).
 * @param {object} [opts] threshold overrides, for re-calibration.
 * @returns {{ decision: string, card: object|null, score: number|null,
 *             margin: number|null, reason: string }}
 */
export function decide(candidates, opts = {}) {
  const scoreMin = opts.scoreMin ?? ACCEPT_SCORE_MIN;
  const marginMin = opts.marginMin ?? ACCEPT_MARGIN_MIN;
  const reviewMin = opts.reviewMin ?? REVIEW_SCORE_MIN;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { decision: DECISION.REJECT, card: null, score: null, margin: null,
      reason: 'no candidates' };
  }

  const top = candidates[0];
  const score = Number(top?.score);
  if (!Number.isFinite(score)) {
    return { decision: DECISION.REJECT, card: null, score: null, margin: null,
      reason: 'candidate has no usable score' };
  }

  // A single candidate has no runner-up to be confused with, so margin is
  // unbounded rather than zero. Treating it as zero would reject the one case
  // where the index is certain.
  const runnerUp = candidates[1];
  const margin = runnerUp && Number.isFinite(Number(runnerUp.score))
    ? score - Number(runnerUp.score)
    : Infinity;

  if (score < reviewMin) {
    return { decision: DECISION.REJECT, card: top, score, margin,
      reason: `score ${score.toFixed(3)} below review floor ${reviewMin}` };
  }

  if (score >= scoreMin && margin >= marginMin) {
    return { decision: DECISION.ACCEPT, card: top, score, margin,
      reason: `score ${score.toFixed(3)} and margin ${fmt(margin)} both clear` };
  }

  const why = score < scoreMin
    ? `score ${score.toFixed(3)} below ${scoreMin}`
    // A near-tie is the reprint signature — name it, because the operator can
    // resolve it instantly by looking at the set symbol.
    : `margin ${fmt(margin)} below ${marginMin} — near-tie with ` +
      `${runnerUp?.id ?? 'another card'}, likely a reprint`;

  return { decision: DECISION.REVIEW, card: top, score, margin, reason: why };
}

function fmt(m) { return Number.isFinite(m) ? m.toFixed(3) : '∞'; }
