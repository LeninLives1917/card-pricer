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
import { getFastPathMode, sameCard } from '../../pricing/fast-path-mode.js';
import {
  scoreShadow, getFastPathCounts, resetFastPathCounts,
} from '../../infra/observability/fast-path-counters.js';

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

test('THE INERT-REFRESH CASE: an unknown age must not report as fresh', async () => {
  // Age used to come from card-db.json's mtime — but initCardDb() re-saves
  // that file every boot and the dirty-save interval rewrites it every five
  // minutes, so an 87-day-old production catalogue reported age_days: 0 and
  // "fresh", and maybeRefreshStaleCatalogue() never once fired. Age now comes
  // from a stamp written only by a COMPLETED crawl, and when that stamp is
  // absent the honest answer is "I cannot tell", not "fine".
  const body = await health({ cardDb: catalogue({ built_at: null }) });
  assert.equal(body.checks.catalogue.age_days, null);
  assert.equal(body.checks.catalogue.ok, false,
    'unknown age must not pass — reporting "cannot tell" as healthy is the bug');
  assert.match(body.checks.catalogue.detail, /UNKNOWN/);
  assert.ok(body.degraded.includes('catalogue'));
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

// The hit-rate checks below describe PRIMARY mode, where a hit is served as
// the answer. The default is now 'shadow' (the fast path runs and is scored
// but does not answer) after it was measured wrong 4 times out of 4 in
// production on 2026-08-07, so these must say which mode they mean.
const PRIMARY_ENV = { ...HEALTHY_ENV, PHASH_FAST_PATH: 'primary' };

test('THE DEAD-FAST-PATH CASE: attempts climbing while hits stay at zero', async () => {
  const body = await health({ env: PRIMARY_ENV, fastPath: fastPath({ attempted: 400, hit: 0, miss: 400 }) });
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
    env: PRIMARY_ENV,
    fastPath: fastPath({ attempted: 200, hit: 40, unusable: 120, miss: 40 }),
  });
  assert.equal(body.checks.fast_path.ok, false);
  assert.match(body.checks.fast_path.detail, /reference_image/);
});

// ── Shadow mode ──────────────────────────────────────────────────────
//
// INCIDENT 2026-08-07. The fast path answered 4 of the first 11 production
// scans and was wrong on all 4 — confirmed per row by the source badge,
// against 7/7 correct from the vision model. Every failure was an unrelated
// card: a fingerprint collision, not a near miss. PHASH_HAMMING_MAX=8 was
// chosen when the index held 3 entries and now guards 76,637.

test('shadow mode is the default — an unconfigured deploy must not let the fast path answer', () => {
  assert.equal(getFastPathMode({}), 'shadow');
  assert.equal(getFastPathMode({ PHASH_FAST_PATH: '' }), 'shadow');
});

test('an unrecognised mode falls back to shadow, never to primary', () => {
  // A typo must not silently grant the fast path authority it has not earned.
  assert.equal(getFastPathMode({ PHASH_FAST_PATH: 'primry' }), 'shadow');
  assert.equal(getFastPathMode({ PHASH_FAST_PATH: 'on' }), 'shadow');
  assert.equal(getFastPathMode({ PHASH_FAST_PATH: 'true' }), 'shadow');
});

test('in shadow, a perfect hit rate with poor agreement is NOT healthy', async () => {
  // Precisely the measured state: the fast path fired on everything it was
  // asked about and was wrong about all of it. Judging it by hit rate is how
  // "it answered a lot" gets mistaken for "it answered well".
  const body = await health({
    fastPath: fastPath({
      attempted: 100, hit: 100, miss: 0,
      shadow_agree: 10, shadow_disagree: 90,
      shadow_scored: 100, shadow_agree_rate: 0.1,
    }),
  });
  assert.equal(body.checks.fast_path.ok, false);
  assert.match(body.checks.fast_path.detail, /10\.0% of 100/);
  assert.match(body.checks.fast_path.detail, /must NOT be promoted/);
});

test('in shadow, too small a sample says so rather than passing quietly', async () => {
  const body = await health({
    fastPath: fastPath({ attempted: 5, hit: 5, shadow_agree: 5, shadow_scored: 5, shadow_agree_rate: 1 }),
  });
  assert.equal(body.checks.fast_path.ok, true);
  assert.match(body.checks.fast_path.detail, /need 50/);
  assert.match(body.checks.fast_path.detail, /not answering/);
});

test('health reports which mode the fast path is in', async () => {
  const shadowBody = await health({ fastPath: fastPath({ attempted: 1 }) });
  assert.equal(shadowBody.checks.fast_path.mode, 'shadow');
  const offBody = await health({ env: { ...HEALTHY_ENV, PHASH_FAST_PATH: 'off' }, fastPath: fastPath({}) });
  assert.equal(offBody.checks.fast_path.mode, 'off');
  assert.match(offBody.checks.fast_path.detail, /OFF/);
});

test('sameCard compares printing identity, not just name', () => {
  // Two printings sharing a name are different cards for pricing purposes;
  // agreeing on name alone would flatter the fast path into promotion.
  assert.equal(sameCard({ set_id: 'base4', number: '18' }, { set_id: 'base4', number: '018' }), true);
  assert.equal(sameCard({ set_id: 'base4', number: '18' }, { set_id: 'neo1', number: '18' }), false);
  assert.equal(
    sameCard({ set_id: 'base4', number: '4/102' }, { set_id: 'base4', number: '4' }), true,
    'collector numbers carry a denominator that is not part of the identity');
  assert.equal(sameCard({ name: 'Venusaur' }, { name: 'venusaur' }), true, 'name is the fallback only');
});

test('scoreShadow counts disagreement — the state that was invisible', () => {
  resetFastPathCounts();
  scoreShadow({ set_id: 'base4', number: '18' }, [{ set_id: 'sv9', number: '38' }], sameCard);
  scoreShadow({ set_id: 'me1', number: '136' }, [{ set_id: 'me1', number: '136' }], sameCard);
  scoreShadow({ set_id: 'me1', number: '1' }, [], sameCard);   // vision found nothing
  const c = getFastPathCounts();
  assert.equal(c.shadow_disagree, 1);
  assert.equal(c.shadow_agree, 1);
  assert.equal(c.shadow_unscored, 1);
  assert.equal(c.shadow_agree_rate, 0.5, 'unscored must not count in the denominator');
  resetFastPathCounts();
});

test('a working fast path reports its rate and stays ok', async () => {
  const body = await health({ env: PRIMARY_ENV, fastPath: fastPath({ attempted: 200, hit: 190, miss: 10 }) });
  assert.equal(body.checks.fast_path.ok, true);
  assert.match(body.checks.fast_path.detail, /95\.0% hit rate/);
  assert.equal(body.status, 'ok');
});

// ---------------------------------------------------------------------------
// CARD_RECTIFY visibility. Whether rectification is on was previously
// unverifiable from outside the process — the only way to know was to trust
// that someone had set the variable in a dashboard.

test('rectification state is reported', async () => {
  const on = await health({ env: { ...HEALTHY_ENV, CARD_RECTIFY: '1' } });
  assert.equal(on.checks.rectify.enabled, true);
  assert.match(on.checks.rectify.detail, /active/);

  const off = await health({ env: HEALTHY_ENV });
  assert.equal(off.checks.rectify.enabled, false);
  assert.match(off.checks.rectify.detail, /1\.0% top-1/,
    'say what being off actually costs, not just that it is off');
});

test('rectification being off does not mark the service degraded', async () => {
  // It is a tuning flag at its default, not a fault. A health check that goes
  // red for configuration choices trains the operator to ignore it — the same
  // reason a transient failed page no longer flips the catalogue check.
  const body = await health({ env: HEALTHY_ENV });
  assert.equal(body.checks.rectify.ok, true);
  assert.equal(body.status, 'ok');
});
