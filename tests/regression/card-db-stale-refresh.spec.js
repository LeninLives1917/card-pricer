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
const withSettle = async fn => { const r = fn(); await settle(); return r; };

// builtAt is injected: the catalogue's age comes from a stamp written only by a
// COMPLETED crawl, never from card-db.json's mtime (which initCardDb re-saves
// every boot and the dirty-save rewrites every 5 minutes).
const refresh = (now, start, built = BUILT_AT) => maybeRefreshStaleCatalogue({
  now, start, builtAt: () => built, stampFile: STAMP,
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

test('THE INERT-REFRESH CASE: no crawl on record triggers a refresh', async () => {
  // This is the bug that shipped. Age was read from card-db.json's mtime, which
  // is rewritten on every boot and every 5-minute dirty-save, so an 87-day-old
  // production catalogue measured 0 days old and this function never fired
  // while /api/health reported "fresh". Unknown age must mean "refresh", not
  // "fine" — the retry floor keeps it to at most one crawl a day.
  stampAt(null);
  const [start, calls] = spy();
  const r = await withSettle(() => refresh(nowAtAge(40), start, null));
  assert.equal(r.refreshing, true, 'unknown age must not read as fresh');
  assert.match(r.reason, /no completed crawl/);
  assert.equal(calls.length, 1);
});

test('the retry floor also covers the unknown-age case', async () => {
  // Otherwise a persistently failing crawl re-triggers on every cold start,
  // and Render cold-starts constantly.
  const now = nowAtAge(40);
  stampAt(now - 2 * HOUR);
  const [start, calls] = spy();
  const r = await withSettle(() => refresh(now, start, null));
  assert.equal(r.refreshing, false);
  assert.equal(r.reason, 'retry floor');
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

// ---------------------------------------------------------------------------
// Crawl stats must survive a restart.
//
// They were in-memory only, so `complete: false` from a partial crawl was wiped
// by the next redeploy and /api/health returned to "ok" without anything being
// fixed. A degraded state that a restart clears is not a degraded state.

import { parseCrawlStamp } from '../../apps/server/_card-db-boot.js';

test('THE FORGOTTEN-FAILURE CASE: an incomplete crawl survives a restart', () => {
  const stamp = JSON.stringify({
    at: '2026-08-06T15:30:00.000Z',
    download: { cards: 20898, expected: 20479, pagesFailed: 1, complete: false },
  });
  const { at, download } = parseCrawlStamp(stamp);
  assert.equal(at, Date.parse('2026-08-06T15:30:00.000Z'));
  assert.equal(download.complete, false,
    'a redeploy must not be able to clear a degraded state that was never fixed');
});

test('a v1 bare-timestamp stamp still reads as a valid crawl time', () => {
  // Already-deployed instances have one of these on disk. Discarding it would
  // report the catalogue as never-crawled and kick a needless full re-crawl.
  const { at, download } = parseCrawlStamp('2026-08-06T15:30:00.000Z');
  assert.equal(at, Date.parse('2026-08-06T15:30:00.000Z'));
  assert.equal(download, null, 'v1 carried no stats — say so, do not invent any');
});

test('a corrupt or empty stamp reads as unknown, not as fresh', () => {
  for (const bad of ['', 'not-a-date', '{oops', '{}', null, undefined]) {
    const { at, download } = parseCrawlStamp(bad);
    assert.equal(at, null, `"${bad}" must not parse to a time`);
    assert.equal(download, null);
  }
});
