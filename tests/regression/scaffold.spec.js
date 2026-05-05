// Scaffold smoke test — A7 / Slice S3
//
// Purpose: prove the test runner can load the project's ESM modules and that
// the test helpers import cleanly. NOT a tautology: it pins the relative
// ordering of pricing tunables once S2 lands them, and the helper-import
// assertion catches typos in setup.js that would otherwise only surface the
// first time a real spec tries to use them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeSupabase, makeFakeAnthropic, mockFetch } from '../helpers/setup.js';

// S2 (A2) lands the named exports below in pricing/confidence.js. Until that
// commit merges, the file is an empty placeholder — we import dynamically so
// this spec stays loadable even before S2 ships, and gate the constants
// assertion behind a presence check.
//
// TODO(S2): once pricing/confidence.js exports MIN_ACCEPT_SCORE etc., remove
// the conditional skip below and assert the values pinned in
// docs/V2_ARCHITECTURE.md §3.5:
//   - RACE_THRESHOLD === 220
//   - MIN_ACCEPT_SCORE === 120
//   - HP_MISMATCH_TOLERANCE === 20
//   - DOUBLE_CHECK_SCORE_GATE === 200
const confidenceMod = await import('../../pricing/confidence.js');

test('test helpers expose the documented surface', () => {
  // makeFakeSupabase returns a builder + seed + calls
  const sb = makeFakeSupabase({ profiles: { data: { id: 'u1', plan: 'pro' }, error: null } });
  assert.equal(typeof sb.client.from, 'function');
  assert.equal(typeof sb.seed, 'function');
  assert.deepEqual(sb.calls, { from: [], rpc: [] });

  // makeFakeAnthropic returns a client with messages.create + queue + calls
  const ai = makeFakeAnthropic();
  assert.equal(typeof ai.client.messages.create, 'function');
  assert.equal(typeof ai.queueResponse, 'function');
  assert.deepEqual(ai.calls, []);

  // mockFetch returns a calls array and a restore function
  const f = mockFetch({});
  assert.ok(Array.isArray(f.calls));
  assert.equal(typeof f.restore, 'function');
  f.restore();
});

test('fake supabase resolves seeded data through the chain', async () => {
  const sb = makeFakeSupabase();
  sb.seed('profiles', { data: { id: 'u1', plan: 'pro' }, error: null });

  const result = await sb.client.from('profiles').select('*').eq('id', 'u1').single();

  assert.deepEqual(result, { data: { id: 'u1', plan: 'pro' }, error: null });
  assert.deepEqual(sb.calls.from, ['profiles']);
});

test('fake anthropic returns queued responses in order', async () => {
  const ai = makeFakeAnthropic();
  ai.queueResponse({ content: [{ type: 'text', text: 'first' }] });
  ai.queueResponse({ content: [{ type: 'text', text: 'second' }] });

  const r1 = await ai.client.messages.create({ model: 'claude-sonnet-4-6', messages: [] });
  const r2 = await ai.client.messages.create({ model: 'claude-sonnet-4-6', messages: [] });

  assert.equal(r1.content[0].text, 'first');
  assert.equal(r2.content[0].text, 'second');
  assert.equal(ai.calls.length, 2);
});

test('mockFetch routes by METHOD + path and records calls', async () => {
  const f = mockFetch({
    'GET /api/me': { status: 200, body: { plan: 'pro' } },
  });

  const res = await fetch('http://localhost/api/me');
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(json, { plan: 'pro' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'GET');

  f.restore();
});

test('pricing/confidence.js loads as ESM (S2 contract — see TODO)', { skip: !hasConfidenceConstants() }, () => {
  // Once S2 lands the constants, this becomes the load-bearing assertion.
  // V1 had MIN_ACCEPT_SCORE === 120; the V2 audit pins it at the same value
  // so any drift is a regression worth catching before review.
  assert.equal(confidenceMod.MIN_ACCEPT_SCORE, 120, 'MIN_ACCEPT_SCORE must match V1 (120)');
  assert.equal(confidenceMod.RACE_THRESHOLD, 220, 'RACE_THRESHOLD must match V1 (220)');
  assert.equal(confidenceMod.HP_MISMATCH_TOLERANCE, 20, 'HP_MISMATCH_TOLERANCE must match V1 (20)');
  assert.equal(confidenceMod.DOUBLE_CHECK_SCORE_GATE, 200, 'DOUBLE_CHECK_SCORE_GATE must match V1 (200)');
});

// Pre-S2 the file is an empty placeholder with no exports; this spec must
// still pass the *load* phase. We verify the module record exists (importing
// it didn't throw) — that alone proves the ESM toolchain is wired.
test('pricing/confidence.js is at least loadable as an ES module', () => {
  assert.ok(confidenceMod, 'pricing/confidence.js must be importable as ESM');
  assert.equal(typeof confidenceMod, 'object');
});

function hasConfidenceConstants() {
  return typeof confidenceMod.MIN_ACCEPT_SCORE === 'number';
}
