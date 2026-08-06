// Regression: /api/health must report liveness, not configuration.
//
// The Supabase project was found PAUSED while this endpoint cheerfully reported
// has_supabase: true — because it checked that SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY were non-empty strings. Both were. The database was
// simply gone. A credential's presence says nothing about whether the thing it
// opens still exists, and that gap is the defect class this project kept
// hitting: a component fails, something plausible is returned, nobody counts.
//
// Mocking strategy: DI via buildHealthPayload({ db, cardDb, env }). No
// mock.module(), no --experimental-test-module-mocks. Plain node --test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHealthPayload } from '../../apps/server/routes/health.js';

const HEALTHY_ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  ANTHROPIC_API_KEY: 'k',
};

const live = () => async () => ({ ok: true, detail: 'query ok' });
const dead = msg => async () => ({ ok: false, detail: msg });
const catalogue = (over = {}) => () =>
  ({ ready: true, count: 20427, built_at: Date.now(), download: null, ...over });

const health = (opts = {}) => buildHealthPayload({
  db: live(), cardDb: catalogue(), env: HEALTHY_ENV,
  fastPath: () => ({ attempted: 0, hit: 0, miss: 0, unusable: 0, skipped: 0,
    hit_rate: null, unusable_rate: null }),
  ...opts,
});

test('a healthy stack reports ok', async () => {
  const body = await health();
  assert.equal(body.status, 'ok');
  assert.equal(body.has_supabase, true);
  assert.deepEqual(body.degraded, []);
});

test('THE PAUSED-PROJECT CASE: credentials set but the database is gone', async () => {
  const body = await health({ db: dead('Project is paused') });

  assert.equal(body.has_supabase, false,
    'has_supabase must mean reachable, not "two env vars are non-empty"');
  assert.equal(body.status, 'degraded');
  assert.ok(body.degraded.includes('supabase'));
  assert.match(body.checks.supabase.detail, /paused/i,
    'surface the upstream reason so the fix is obvious');
  assert.equal(body.checks.supabase.configured, true,
    'configured stays true — it is a different question from live, and ' +
    'reporting them separately is the whole point');
});

test('an unloaded, empty or stale catalogue is degraded, not silently ok', async () => {
  for (const [label, over] of [
    ['not loaded', { ready: false }],
    ['empty', { count: 0 }],
    // Sets ship roughly every six weeks; a catalogue older than a release cycle
    // is very likely missing whatever the shop is actually selling. This is the
    // exact condition that put 23 absent cards into the benchmark.
    ['stale', { built_at: Date.now() - 40 * 86_400_000 }],
  ]) {
    const body = await health({ cardDb: catalogue(over) });
    assert.equal(body.checks.catalogue.ok, false, `${label} should not be ok`);
    assert.equal(body.status, 'degraded', `${label} should degrade the verdict`);
  }
});

test('a fresh catalogue just inside the window is still ok', async () => {
  const body = await health({ cardDb: catalogue({ built_at: Date.now() - 20 * 86_400_000 }) });
  assert.equal(body.checks.catalogue.ok, true);
  assert.equal(body.checks.catalogue.age_days, 20);
});

test('an unknown catalogue age does not read as infinitely stale', async () => {
  // No file on disk → age null. Treating null as huge would degrade every
  // instance that keeps its catalogue in memory.
  const body = await health({ cardDb: catalogue({ built_at: null }) });
  assert.equal(body.checks.catalogue.age_days, null);
  assert.equal(body.checks.catalogue.ok, true);
});

test('THE PARTIAL-CRAWL CASE: a fresh mtime does not mean a whole catalogue', async () => {
  // downloadCardDatabase() calls saveCardDbToFile() on its failure path too, so
  // a crawl that died halfway leaves a file with a brand-new mtime and a short
  // catalogue. Age cannot see that; the download's own flag can.
  const stats = { cards: 14_000, expected: 20_427, pagesFailed: 9, complete: false };
  const body = await health({ cardDb: catalogue({ download: stats }) });

  assert.deepEqual(body.checks.catalogue.last_download, stats);
  assert.equal(body.checks.catalogue.ok, false,
    'a freshly-written but incomplete catalogue must not read as healthy');
  assert.match(body.checks.catalogue.detail, /INCOMPLETE.*14000\/20427/);
  assert.ok(body.degraded.includes('catalogue'));
});

test('a completed crawl is not treated as incomplete', async () => {
  const body = await health({
    cardDb: catalogue({ download: { cards: 20_427, expected: 20_427, pagesFailed: 0, complete: true } }),
  });
  assert.equal(body.checks.catalogue.ok, true);
});

test('the hardcoded cardmarket banner is gone', async () => {
  const body = await health();
  assert.equal(typeof body.apis.cardmarket, 'boolean',
    'it was a decorative string that reported nothing and could never fail');
});

test('the admin tab keys survive', async () => {
  // apps/vendor/modules/tabs/admin.js reads these flat keys directly.
  const body = await health();
  for (const k of ['status', 'has_supabase', 'has_anthropic_key', 'has_stripe',
    'has_ebay', 'has_justtcg', 'has_rapidapi', 'uptime', 'ts', 'apis']) {
    assert.ok(k in body, `missing back-compat key: ${k}`);
  }
});

test('a throwing card-db accessor degrades rather than throwing', async () => {
  // A health check that 500s tells the operator nothing about what broke, which
  // is worse than the silent-success it replaced.
  const body = await health({ cardDb: () => { throw new Error('boom'); } });
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.catalogue.ok, false);
  assert.equal(body.has_supabase, true, 'one failed check must not poison the others');
});

// ---------------------------------------------------------------------------
// Fast-path counters (D3). Falling back is fine; falling back invisibly is the
// defect that hid a completely dead pHash path for months.

const fastPath = (over = {}) => () => {
  const c = { attempted: 0, hit: 0, miss: 0, unusable: 0, skipped: 0, ...over };
  return {
    ...c,
    hit_rate: c.attempted ? c.hit / c.attempted : null,
    unusable_rate: c.attempted ? c.unusable / c.attempted : null,
  };
};

test('THE DEAD-FAST-PATH CASE: attempts climbing while hits stay at zero', async () => {
  const body = await health({ fastPath: fastPath({ attempted: 400, hit: 0, miss: 400 }) });
  assert.equal(body.checks.fast_path.ok, false);
  assert.match(body.checks.fast_path.detail, /DEAD/);
  assert.ok(body.degraded.includes('fast_path'));
});

test('a small sample is not evidence of anything', async () => {
  // A freshly restarted instance has not been asked enough times to prove a
  // dead fast path, and crying wolf on every deploy trains the operator to
  // ignore the endpoint.
  const body = await health({ fastPath: fastPath({ attempted: 3, hit: 0, miss: 3 }) });
  assert.equal(body.checks.fast_path.ok, true);
  assert.equal(body.status, 'ok');
});

test('never asked is distinguished from asked and always failed', async () => {
  const body = await health({ fastPath: fastPath({ attempted: 0 }) });
  assert.equal(body.checks.fast_path.hit_rate, null,
    'a 0% hit rate and "never asked" are different states');
});

test('hits discarded for a missing reference_image are called out separately', async () => {
  // The index is correct and the answer is thrown away — a data gap, not a
  // matcher failure, and a much cheaper fix.
  const body = await health({
    fastPath: fastPath({ attempted: 200, hit: 40, unusable: 120, miss: 40 }),
  });
  assert.equal(body.checks.fast_path.ok, false);
  assert.match(body.checks.fast_path.detail, /reference_image/);
});

test('a working fast path reports its rate and stays ok', async () => {
  const body = await health({ fastPath: fastPath({ attempted: 200, hit: 190, miss: 10 }) });
  assert.equal(body.checks.fast_path.ok, true);
  assert.match(body.checks.fast_path.detail, /95\.0% hit rate/);
  assert.equal(body.status, 'ok');
});
