// Pins the typed-entry counters and, more importantly, the DISCIPLINE they
// have to hold to be worth having.
//
// WHY THIS EXISTS
//
// The typed path has never been measured, and it carries the same
// first-hit-wins shape just removed from the price adapters:
//
//   apps/server/routes/identify.js:530
//     let best = results[0];
//     if (name) { const exact = results.find(...); if (exact) best = exact; }
//
// A line with no name, or whose name matches nothing exactly, gets search hit
// #1 returned as `verified: true`. Nobody knows how often. This module counts
// it BEFORE the behaviour changes, so the fix is judged against a real
// denominator rather than an argument.
//
// The three properties below are the ones that make a counter honest, and each
// has cost this project an incident when it was missing:
//
//   1. null when never asked. A dead path that reads 0% looks identical to a
//      path nobody has exercised. The pHash fast path hid behind that for
//      months.
//   2. per source, never blended. One route's failures must not hide inside
//      another's volume — the argument written out in
//      price-match-counters.js:22-26.
//   3. "never asked" kept OUT of the denominator. A line carrying no set code
//      is not a set-resolution failure, and counting it as one would make the
//      guess rate look better the more people omit the field.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  countTextEntry,
  getTextEntryCounts,
  resetTextEntryCounts,
  LOOKUP_OUTCOMES,
  SET_OUTCOMES,
} from '../../infra/observability/text-entry-counters.js';
import { buildHealthPayload } from '../../apps/server/routes/health.js';

const healthDeps = {
  db: async () => ({ ok: true, detail: 'stub' }),
  cardDb: () => ({ ready: true, count: 20546, lastDownload: null }),
  env: {},
};

describe('text-entry counters', () => {
  beforeEach(() => resetTextEntryCounts());
  afterEach(() => resetTextEntryCounts());

  test('never asked is null, not zero', () => {
    const c = getTextEntryCounts();
    assert.equal(c.first_hit_rate, null, 'no lookups must not read as 0% unconfirmed');
    assert.equal(c.confirmed_rate, null);
    assert.equal(c.set_guess_rate, null);
    assert.equal(c.lookups, 0);
  });

  test('asked and always unconfirmed is zero, not null — a different state', () => {
    countTextEntry('vendor_text', 'remote_first_hit');
    countTextEntry('vendor_text', 'remote_first_hit');
    const c = getTextEntryCounts();
    assert.equal(c.confirmed_rate, 0, 'asked twice, confirmed never — that is 0, not null');
    assert.equal(c.first_hit_rate, 1);
  });

  test('sources are counted separately and never blended', () => {
    countTextEntry('vendor_text', 'local_hit');
    countTextEntry('quote_text', 'remote_first_hit');
    const c = getTextEntryCounts();
    assert.deepEqual(Object.keys(c.by_source).sort(), ['quote_text', 'vendor_text']);
    assert.equal(c.by_source.vendor_text.first_hit_rate, 0);
    assert.equal(c.by_source.quote_text.first_hit_rate, 1);
    // The blended figure exists, but the per-source split is what makes it
    // readable: 50% overall hides one path that is entirely unconfirmed.
    assert.equal(c.first_hit_rate, 0.5);
  });

  test('a source nobody touched does not appear at all', () => {
    countTextEntry('vendor_text', 'local_hit');
    assert.equal(getTextEntryCounts().by_source.quote_text, undefined,
      'an untouched source must be absent, not present reading 0%');
  });

  test('a line with no set code is NOT counted as a set-resolution failure', () => {
    countTextEntry('vendor_text', 'set_absent');
    countTextEntry('vendor_text', 'set_absent');
    countTextEntry('vendor_text', 'set_guessed');
    countTextEntry('vendor_text', 'set_aliased');
    const c = getTextEntryCounts();
    // 1 guessed of 2 codes actually typed. If set_absent were in the
    // denominator this would read 25%, and the rate would improve every time
    // someone left the field blank.
    assert.equal(c.set_guess_rate, 0.5);
    assert.equal(c.set_absent, 2);
  });

  test('set outcomes stay out of the lookup denominator too', () => {
    countTextEntry('vendor_text', 'set_aliased');
    countTextEntry('vendor_text', 'local_hit');
    assert.equal(getTextEntryCounts().lookups, 1, 'resolving a set code is not a lookup');
  });

  test('one worked example of the defect is retained', () => {
    countTextEntry('vendor_text', 'remote_first_hit', {
      name: 'Charizard',
      set_code: 'ZZZ',
      card_number: '4',
      returned_name: 'Charizard VMAX',
      returned_set: 'swsh3',
      query: 'name:"Charizard" number:4',
    });
    const s = getTextEntryCounts().last_first_hit;
    // A rate says there is a problem. A sample says what it looks like.
    assert.equal(s.typed_name, 'Charizard');
    assert.equal(s.returned_name, 'Charizard VMAX');
    assert.equal(s.source, 'vendor_text');
    assert.ok(s.at);
  });

  test('a confirmed hit does not overwrite the last defect sample', () => {
    countTextEntry('vendor_text', 'remote_first_hit', { name: 'A', returned_name: 'B' });
    countTextEntry('vendor_text', 'remote_confirmed', { name: 'C', returned_name: 'C' });
    assert.equal(getTextEntryCounts().last_first_hit.typed_name, 'A');
  });

  test('an unknown outcome is ignored rather than creating a phantom key', () => {
    countTextEntry('vendor_text', 'not_a_real_outcome');
    const s = getTextEntryCounts().by_source.vendor_text;
    assert.equal(s.not_a_real_outcome, undefined);
    assert.equal(getTextEntryCounts().lookups, 0);
  });

  test('reset clears both the counts and the sample', () => {
    countTextEntry('vendor_text', 'remote_first_hit', { name: 'A' });
    resetTextEntryCounts();
    const c = getTextEntryCounts();
    assert.deepEqual(c.by_source, {});
    assert.equal(c.last_first_hit, null);
    assert.equal(c.first_hit_rate, null);
  });
});

describe('text-entry counters in /api/health', () => {
  beforeEach(() => resetTextEntryCounts());
  afterEach(() => resetTextEntryCounts());

  test('the block is present and says so plainly when nobody has typed', async () => {
    const p = await buildHealthPayload(healthDeps);
    assert.ok(p.checks.text_entry, 'text_entry must be surfaced');
    assert.equal(p.checks.text_entry.first_hit_rate, null);
    assert.match(p.checks.text_entry.detail, /nobody has typed a card since boot/);
  });

  test('never ok:false — this measures a defect, it does not report an outage', async () => {
    for (let i = 0; i < 20; i += 1) countTextEntry('vendor_text', 'remote_first_hit');
    const p = await buildHealthPayload(healthDeps);
    // 100% unconfirmed is exactly the thing we are trying to see. Marking the
    // service degraded for it would train someone to ignore the degraded flag,
    // and the flag is what caught an 8.4-day Supabase outage.
    //
    // Asserted against `degraded` specifically rather than `status`: the stub
    // catalogue has no completed crawl on record, so this fixture is degraded
    // for an unrelated reason. Asserting status === 'ok' here passed only by
    // accident of the fixture and would have gone red on any unrelated change.
    assert.equal(p.checks.text_entry.ok, true);
    assert.ok(!p.degraded.includes('text_entry'),
      'a high unconfirmed rate is a measurement, not an outage');
  });

  test('the detail line reports the per-source split, not just a blend', async () => {
    countTextEntry('vendor_text', 'local_hit');
    countTextEntry('quote_text', 'remote_first_hit');
    const { detail } = (await buildHealthPayload(healthDeps)).checks.text_entry;
    assert.match(detail, /vendor_text/);
    assert.match(detail, /quote_text/);
  });

  test('deps.textEntry is injectable, so the block is testable without globals', async () => {
    const p = await buildHealthPayload({
      ...healthDeps,
      textEntry: () => ({ lookups: 7, confirmed_rate: 1, first_hit_rate: 0,
        remote_first_hit: 0, set_guess_rate: null, set_absent: 7, by_source: {} }),
    });
    assert.match(p.checks.text_entry.detail, /7 typed lookup/);
  });
});

describe('the outcome vocabulary is closed', () => {
  test('every declared outcome is actually countable', () => {
    resetTextEntryCounts();
    for (const o of [...LOOKUP_OUTCOMES, ...SET_OUTCOMES]) countTextEntry('vendor_text', o);
    const s = getTextEntryCounts().by_source.vendor_text;
    for (const o of [...LOOKUP_OUTCOMES, ...SET_OUTCOMES]) {
      assert.equal(s[o], 1, `${o} is declared but did not increment`);
    }
    resetTextEntryCounts();
  });

  test('lookup and set vocabularies do not overlap', () => {
    const overlap = LOOKUP_OUTCOMES.filter((o) => SET_OUTCOMES.includes(o));
    assert.deepEqual(overlap, [], 'an outcome in both would be double-counted');
  });
});
