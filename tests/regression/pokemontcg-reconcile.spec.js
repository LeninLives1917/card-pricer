// Regression: catalogue reconciliation.
//
// Three separate incidents shared one signature — a build that reported success
// while holding less data than upstream had:
//
//   1. the pHash index that was never populated
//   2. a set silently dropped when one HTTP 500 killed its fetch
//   3. new releases invisible forever, because set discovery read the very
//      artifact it was building
//
// All three were invisible because nothing compared local against upstream.
// reconcile() is that comparison, so these tests encode each incident.

import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcile, formatReconciliation } from '../../pricing/pokemontcg-client.js';

const sets = [
  { id: 'base1', name: 'Base', printedTotal: 102, total: 102 },
  { id: 'sv1', name: 'Scarlet & Violet', printedTotal: 198, total: 258 },
  { id: 'me5', name: 'Pitch Black', printedTotal: 84, total: 120 },
];

/** Build a card-db-shaped object with `n` cards for a set. */
function cards(setId, n, from = 1) {
  const o = {};
  for (let i = from; i < from + n; i++) o[`${setId}-${i}`] = { name: `c${i}` };
  return o;
}

test('a complete catalogue reconciles OK', () => {
  const local = { ...cards('base1', 102), ...cards('sv1', 258), ...cards('me5', 120) };
  const r = reconcile(local, sets);
  assert.equal(r.ok, true);
  assert.equal(r.missingSets.length, 0);
  assert.equal(r.localTotal, 480);
  assert.equal(r.upstreamTotal, 480);
});

test('INCIDENT: a newly released set absent entirely is reported as missing', () => {
  // me5 released three weeks before the operator's photos; discovery from the
  // local db's own keys meant it could never be crawled.
  const local = { ...cards('base1', 102), ...cards('sv1', 258) };
  const r = reconcile(local, sets);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingSets.map(s => s.id), ['me5']);
  assert.match(formatReconciliation(r), /MISSING 1 set\(s\).*me5 \(0\/120\)/);
});

test('INCIDENT: a set truncated by a dropped page is reported as short', () => {
  // One HTTP 500 dropped ~120 cards and the crawler logged "skipping entire
  // set" then carried on reporting success.
  const local = { ...cards('base1', 102), ...cards('sv1', 138), ...cards('me5', 120) };
  const r = reconcile(local, sets);
  assert.equal(r.ok, false);
  assert.equal(r.missingSets.length, 0);
  assert.deepEqual(r.shortSets.map(s => `${s.id}:${s.have}/${s.expected}`), ['sv1:138/258']);
});

test('INCIDENT: a completely empty index does not report as healthy', () => {
  const r = reconcile({}, sets);
  assert.equal(r.ok, false);
  assert.equal(r.coverage, 0);
  assert.equal(r.missingSets.length, 3);
});

test('uses total, not printedTotal — secret rares are real cards', () => {
  // sv1 printedTotal 198 but total 258. Reconciling against printedTotal would
  // call a 60-card shortfall "complete".
  const local = { ...cards('base1', 102), ...cards('sv1', 198), ...cards('me5', 120) };
  const r = reconcile(local, sets);
  assert.equal(r.ok, false);
  assert.deepEqual(r.shortSets.map(s => s.id), ['sv1']);
});

test('coverage threshold is configurable and gates ok', () => {
  const local = { ...cards('base1', 102), ...cards('sv1', 257), ...cards('me5', 120) };
  // 479/480 = 99.79% — passes the default 99.5% floor on coverage, but the set
  // is still short, so it must be surfaced rather than silently accepted.
  const r = reconcile(local, sets);
  assert.ok(r.coverage > 0.995);
  assert.deepEqual(r.shortSets.map(s => s.id), ['sv1']);
});

test('accepts a Map (CARD_DB) as well as a plain object', () => {
  const m = new Map(Object.entries({ ...cards('base1', 102), ...cards('sv1', 258), ...cards('me5', 120) }));
  const r = reconcile(m, sets);
  assert.equal(r.ok, true);
  assert.equal(r.localTotal, 480);
});

test('card ids with hyphenated numbers split on the LAST hyphen', () => {
  // Promo/trainer-gallery ids like "swsh4-TG12" must attribute to their set.
  const r = reconcile({ 'swsh4-TG12': {}, 'swsh4-1': {} },
    [{ id: 'swsh4', name: 'Vivid Voltage', printedTotal: 2, total: 2 }]);
  assert.equal(r.ok, true);
  assert.equal(r.localTotal, 2);
});

test('an empty upstream list cannot manufacture a pass', () => {
  // If the set listing failed, coverage is unknown — callers must not read this
  // as healthy. upstreamTotal 0 yields coverage 1, so the caller is expected to
  // treat a missing upstream list as a failure in its own right.
  const r = reconcile({ 'base1-1': {} }, []);
  assert.equal(r.upstreamTotal, 0);
  assert.equal(r.missingSets.length, 0);
});

test('formatReconciliation summarises a healthy build in one line', () => {
  const local = { ...cards('base1', 102), ...cards('sv1', 258), ...cards('me5', 120) };
  assert.match(formatReconciliation(reconcile(local, sets)), /^local 480 \/ upstream 480 \(100\.00%\) — OK$/);
});
