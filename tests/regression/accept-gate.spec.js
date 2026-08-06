// Regression: the local-match accept gate.
//
// On a buy-list a wrong price costs real money and an abstention costs a
// second, so the gate is tuned for zero wrong answers rather than maximum
// accuracy. Two conditions, both measured on 64 real photographs:
//
//   score >= 0.876                     11/64 accepted, 0 wrong
//   score >= 0.850 AND margin >= 0.05  25/64 accepted, 0 wrong
//
// The margin condition exists because one wrong answer survived to score 0.876
// — a REPRINT (Ethan's Slugma, Destined Rivals vs Ascended Heroes) carrying a
// runner-up gap of 0.026, where correct matches above 0.80 had a median gap of
// 0.129. Score alone cannot catch that; a near-tie can.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decide, DECISION, ACCEPT_SCORE_MIN, ACCEPT_MARGIN_MIN, REVIEW_SCORE_MIN,
} from '../../pricing/accept-gate.js';

const c = (id, score) => ({ id, score });

test('a confident, unambiguous match is accepted', () => {
  const r = decide([c('me5-73', 0.900), c('me5-72', 0.700)]);
  assert.equal(r.decision, DECISION.ACCEPT);
  assert.equal(r.card.id, 'me5-73');
});

test('THE REPRINT CASE: high score but a near-tie is not auto-accepted', () => {
  // The exact shape of the one wrong answer that survived score-only gating.
  const r = decide([c('me2pt5-23', 0.876), c('sv10-35', 0.850)]);
  assert.equal(r.decision, DECISION.REVIEW,
    'a 0.026 margin must not auto-accept, however high the score');
  assert.match(r.reason, /near-tie/);
  assert.match(r.reason, /reprint/);
  assert.match(r.reason, /sv10-35/, 'name the card it was confused with');
});

test('a good margin does not rescue a low score', () => {
  const r = decide([c('x', 0.740), c('y', 0.200)]);
  assert.equal(r.decision, DECISION.REVIEW);
  assert.match(r.reason, /score/);
});

test('below the review floor, fall back rather than showing a guess', () => {
  const r = decide([c('x', 0.500), c('y', 0.100)]);
  assert.equal(r.decision, DECISION.REJECT);
});

test('a lone candidate has infinite margin, not zero', () => {
  // With nothing to be confused with, the index is certain. Treating a missing
  // runner-up as margin 0 would reject exactly the unambiguous case.
  const r = decide([c('only', 0.910)]);
  assert.equal(r.decision, DECISION.ACCEPT);
  assert.equal(r.margin, Infinity);
  assert.match(r.reason, /∞/);
});

test('exact threshold values are inclusive', () => {
  const r = decide([c('a', ACCEPT_SCORE_MIN), c('b', ACCEPT_SCORE_MIN - ACCEPT_MARGIN_MIN)]);
  assert.equal(r.decision, DECISION.ACCEPT);
});

test('just under either threshold falls to review', () => {
  const a = decide([c('a', ACCEPT_SCORE_MIN - 0.001), c('b', 0.1)]);
  assert.equal(a.decision, DECISION.REVIEW);
  const b = decide([c('a', 0.95), c('b', 0.95 - (ACCEPT_MARGIN_MIN - 0.001))]);
  assert.equal(b.decision, DECISION.REVIEW);
});

test('thresholds are overridable for re-calibration', () => {
  // They are fitted to one 115-second session; re-fitting must not need a code
  // change.
  const cands = [c('a', 0.80), c('b', 0.70)];
  assert.equal(decide(cands).decision, DECISION.REVIEW);
  assert.equal(decide(cands, { scoreMin: 0.75, marginMin: 0.05 }).decision, DECISION.ACCEPT);
});

test('empty, malformed and scoreless input rejects without throwing', () => {
  for (const bad of [[], null, undefined, [{ id: 'x' }], [{ id: 'x', score: NaN }]]) {
    const r = decide(bad);
    assert.equal(r.decision, DECISION.REJECT);
  }
});

test('the review floor sits below the accept threshold', () => {
  // Otherwise the amber lane is empty and everything is binary — which is the
  // framing that left coverage on the table.
  assert.ok(REVIEW_SCORE_MIN < ACCEPT_SCORE_MIN);
});
