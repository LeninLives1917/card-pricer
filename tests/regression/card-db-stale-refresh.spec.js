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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { maybeRefreshStaleCatalogue } from '../../apps/server/_card-db-boot.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CARD_DB_FILE = join(REPO_ROOT, 'data', 'card-db.json');
const REFRESH_STAMP = join(REPO_ROOT, 'data', '.card-db-refresh');

const DAY = 86_400_000;
const HOUR = 3_600_000;

// These tests read the real data/ directory's mtimes but must not disturb them.
async function withStamp(mtimeMs, fn) {
  const had = fs.existsSync(REFRESH_STAMP);
  const prev = had ? fs.statSync(REFRESH_STAMP) : null;
  try {
    if (mtimeMs === null) { if (had) fs.unlinkSync(REFRESH_STAMP); }
    else {
      fs.writeFileSync(REFRESH_STAMP, 'test');
      fs.utimesSync(REFRESH_STAMP, mtimeMs / 1000, mtimeMs / 1000);
    }
    const out = fn();
    // The crawl is kicked off on a microtask so boot is never blocked by it —
    // let that turn run before the caller inspects what happened.
    await new Promise(res => setImmediate(res));
    return out;
  } finally {
    if (had) {
      fs.writeFileSync(REFRESH_STAMP, 'restored');
      fs.utimesSync(REFRESH_STAMP, prev.atimeMs / 1000, prev.mtimeMs / 1000);
    } else {
      try { fs.unlinkSync(REFRESH_STAMP); } catch { /* fine */ }
    }
  }
}

// The catalogue file's real mtime is the input; `now` is shifted instead of
// touching it, so these tests never rewrite a 20k-card artifact.
const builtAt = () => fs.statSync(CARD_DB_FILE).mtimeMs;
const nowAtAge = days => builtAt() + days * DAY;

const spy = () => {
  const calls = [];
  const fn = async (...a) => { calls.push(a); };
  return [fn, calls];
};

test('a fresh catalogue is left alone', { skip: !fs.existsSync(CARD_DB_FILE) }, async () => {
  const [start, calls] = spy();
  const r = await withStamp(null, () =>
    maybeRefreshStaleCatalogue({ now: nowAtAge(5), start }));
  assert.equal(r.refreshing, false);
  assert.match(r.reason, /fresh/);
  assert.equal(calls.length, 0);
});

test('THE FROZEN-CATALOGUE CASE: a stale catalogue refreshes', { skip: !fs.existsSync(CARD_DB_FILE) }, async () => {
  const [start, calls] = spy();
  const r = await withStamp(null, () =>
    maybeRefreshStaleCatalogue({ now: nowAtAge(40), start }));
  assert.equal(r.refreshing, true, 'a 40-day-old catalogue must refresh, not be served forever');
  assert.equal(calls.length, 1);
});

test('THE RESTART-LOOP CASE: a recent attempt blocks a retry', { skip: !fs.existsSync(CARD_DB_FILE) }, async () => {
  const now = nowAtAge(40);
  const [start, calls] = spy();
  const r = await withStamp(now - 2 * HOUR, () =>
    maybeRefreshStaleCatalogue({ now, start }));
  assert.equal(r.refreshing, false,
    'Render cold-starts constantly — without this floor every boot would kick ' +
    'a five-minute crawl at pokemontcg.io');
  assert.equal(r.reason, 'retry floor');
  assert.equal(calls.length, 0);
});

test('past the retry floor it tries again', { skip: !fs.existsSync(CARD_DB_FILE) }, async () => {
  const now = nowAtAge(40);
  const [start, calls] = spy();
  const r = await withStamp(now - 30 * HOUR, () => maybeRefreshStaleCatalogue({ now, start }));
  assert.equal(r.refreshing, true);
  assert.equal(calls.length, 1);
});

test('the attempt is stamped BEFORE the crawl runs', { skip: !fs.existsSync(CARD_DB_FILE) }, async () => {
  // A crawl that dies mid-way must not license an immediate retry on the
  // restart it probably caused.
  let stampedWhenCalled = null;
  const start = async () => { stampedWhenCalled = fs.existsSync(REFRESH_STAMP); };
  await withStamp(null, () => {
    maybeRefreshStaleCatalogue({ now: nowAtAge(40), start });
  });
  assert.equal(stampedWhenCalled, true);
});

test('a failing crawl does not reject unhandled', { skip: !fs.existsSync(CARD_DB_FILE) }, async () => {
  const start = async () => { throw new Error('pokemontcg.io 500'); };
  const r = await withStamp(null, () => maybeRefreshStaleCatalogue({ now: nowAtAge(40), start }));
  // A degraded catalogue is not a dead process; /api/health reports the age.
  assert.equal(r.refreshing, true);
});

test('CARD_DB_AUTO_REFRESH=0 disables it', () => {
  const prev = process.env.CARD_DB_AUTO_REFRESH;
  process.env.CARD_DB_AUTO_REFRESH = '0';
  try {
    const [start, calls] = spy();
    const r = maybeRefreshStaleCatalogue({ now: Date.now(), start });
    assert.equal(r.refreshing, false);
    assert.match(r.reason, /disabled/);
    assert.equal(calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.CARD_DB_AUTO_REFRESH;
    else process.env.CARD_DB_AUTO_REFRESH = prev;
  }
});
