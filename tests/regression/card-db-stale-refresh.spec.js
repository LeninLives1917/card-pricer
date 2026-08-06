// Regression: the serving catalogue must not silently freeze forever.
//
// initCardDb() called downloadCardDatabase() only when NEITHER the Google Sheet
// nor data/card-db.json existed. Render mounts a persistent disk at data/, so
// the moment that file landed there the serving catalogue stopped refreshing —
// permanently, not until the next restart. Sets ship roughly every six weeks
// and a shop's counter skews hard to the newest one, which is how 23 of 35
// benchmark failures came to be cards that simply were not in the index.
//
// The fix has to survive Render's restart behaviour: free-tier sleep and
// redeploys mean cold starts are frequent, so "refresh if stale" without a
// retry floor would fire a fresh five-minute crawl on every single boot.
//
// Paths are injected, so this never reads or writes the real data/ directory.
// An earlier version of this spec did, and that is exactly the habit that let
// the suite destroy data/card-phashes.json — see
// tests-do-not-touch-production-data.spec.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import { join } from 'path';

import { maybeRefreshStaleCatalogue } from '../../apps/server/_card-db-boot.js';

const TMP = fs.mkdtempSync(join(os.tmpdir(), 'card-pricer-refresh-'));
const CATALOGUE = join(TMP, 'card-db.json');
const STAMP = join(TMP, '.card-db-refresh');

const DAY = 86_400_000;
const HOUR = 3_600_000;

const BUILT_AT = Date.UTC(2026, 6, 1);   // fixed; no Date.now() in fixtures
fs.writeFileSync(CATALOGUE, '{}');
fs.utimesSync(CATALOGUE, BUILT_AT / 1000, BUILT_AT / 1000);

const nowAtAge = days => BUILT_AT + days * DAY;

/** Set (or clear) the last-attempt stamp. */
function stampAt(mtimeMs) {
  if (mtimeMs === null) { try { fs.unlinkSync(STAMP); } catch { /* fine */ } return; }
  fs.writeFileSync(STAMP, 'test');
  fs.utimesSync(STAMP, mtimeMs / 1000, mtimeMs / 1000);
}

const spy = () => {
  const calls = [];
  return [async (...a) => { calls.push(a); }, calls];
};

/** The crawl is kicked off on a microtask so boot is never blocked by it. */
const settle = () => new Promise(res => setImmediate(res));

const refresh = (now, start) => maybeRefreshStaleCatalogue({
  now, start, catalogueFile: CATALOGUE, stampFile: STAMP,
});

test('a fresh catalogue is left alone', async () => {
  stampAt(null);
  const [start, calls] = spy();
  const r = refresh(nowAtAge(5), start);
  await settle();
  assert.equal(r.refreshing, false);
  assert.match(r.reason, /fresh/);
  assert.equal(calls.length, 0);
});

test('THE FROZEN-CATALOGUE CASE: a stale catalogue refreshes', async () => {
  stampAt(null);
  const [start, calls] = spy();
  const r = refresh(nowAtAge(40), start);
  await settle();
  assert.equal(r.refreshing, true,
    'a 40-day-old catalogue must refresh, not be served forever');
  assert.equal(calls.length, 1);
});

test('THE RESTART-LOOP CASE: a recent attempt blocks a retry', async () => {
  const now = nowAtAge(40);
  stampAt(now - 2 * HOUR);
  const [start, calls] = spy();
  const r = refresh(now, start);
  await settle();
  assert.equal(r.refreshing, false,
    'Render cold-starts constantly — without this floor every boot would kick ' +
    'a five-minute crawl at pokemontcg.io');
  assert.equal(r.reason, 'retry floor');
  assert.equal(calls.length, 0);
});

test('past the retry floor it tries again', async () => {
  const now = nowAtAge(40);
  stampAt(now - 30 * HOUR);
  const [start, calls] = spy();
  const r = refresh(now, start);
  await settle();
  assert.equal(r.refreshing, true);
  assert.equal(calls.length, 1);
});

test('the attempt is stamped BEFORE the crawl runs', async () => {
  // A crawl that dies mid-way must not license an immediate retry on the
  // restart it probably caused.
  stampAt(null);
  let stampedWhenCalled = null;
  await refresh(nowAtAge(40), async () => {
    stampedWhenCalled = fs.existsSync(STAMP);
  });
  await settle();
  assert.equal(stampedWhenCalled, true);
});

test('a failing crawl does not reject unhandled', async () => {
  stampAt(null);
  const r = refresh(nowAtAge(40), async () => { throw new Error('pokemontcg.io 500'); });
  await settle();
  // A degraded catalogue is not a dead process; /api/health reports the age.
  assert.equal(r.refreshing, true);
});

test('a missing catalogue file is not treated as infinitely stale', async () => {
  stampAt(null);
  const [start, calls] = spy();
  const r = maybeRefreshStaleCatalogue({
    now: nowAtAge(40), start,
    catalogueFile: join(TMP, 'does-not-exist.json'), stampFile: STAMP,
  });
  await settle();
  assert.equal(r.refreshing, false, 'nothing to age — initCardDb handles this case');
  assert.equal(calls.length, 0);
});

test('CARD_DB_AUTO_REFRESH=0 disables it', async () => {
  const prev = process.env.CARD_DB_AUTO_REFRESH;
  process.env.CARD_DB_AUTO_REFRESH = '0';
  try {
    stampAt(null);
    const [start, calls] = spy();
    const r = refresh(nowAtAge(40), start);
    await settle();
    assert.equal(r.refreshing, false);
    assert.match(r.reason, /disabled/);
    assert.equal(calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.CARD_DB_AUTO_REFRESH;
    else process.env.CARD_DB_AUTO_REFRESH = prev;
  }
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ } });
