// Regression: recovering the cards inside a page the crawl gave up on.
//
// Production reported "1 page(s) failed" of 82, which read as 250 cards lost
// and pinned /api/health to "degraded" for 24 hours.
//
// The first diagnosis was wrong and is worth recording. Probing the page by
// hand gave repeated instant 500s, and bisecting it seemed to isolate three
// individual card positions that always failed — a tidy story about broken
// upstream records. Re-running the bisection two ways killed that story
// (2026-08-06, live API):
//
//   back-to-back, no retry   212/250 recovered, 38 positions "unfetchable"
//   120ms apart, with retry  250/250 recovered in ONE request, 1.2s
//
// The set of "broken" cards moved when the pacing moved, so nothing was broken.
// pokemontcg.io 500s under concurrent load, and the crawl issues BATCH pages at
// once — a page fails for load reasons and burns its retries while the load is
// still there. The lesson: a failure that changes when you change how you
// measure it is a property of the measurement.
//
// Recovery therefore paces first and subdivides only as a fallback. These tests
// pin the subdivision arithmetic (250 -> 50 -> 10 -> 1) and the rule that only
// positions failing when requested SINGLY count as unrecoverable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverFailedPages } from '../../apps/server/_card-db-boot.js';

const PAGE_SIZE = 250;
const reqOpts = p => p;
const pageParams = (page, size = PAGE_SIZE) => ({ page, size });

/**
 * Fake API where a fixed set of 1-based card positions always fail: any request
 * whose span contains one fails. This models the WORST case (a genuinely
 * unfetchable record) so the subdivision logic is exercised — the live API's
 * actual behaviour is load-dependent and recovers on a paced retry.
 */
function fakeApi(badPositions, { log } = {}) {
  const poison = new Set(badPositions);
  return async (page, size) => {
    const first = (page - 1) * size + 1;
    const last = first + size - 1;
    log?.push({ page, size, first, last });
    for (let pos = first; pos <= last; pos++) {
      if (poison.has(pos)) throw new Error('HTTP 500');
    }
    const data = [];
    for (let pos = first; pos <= last; pos++) data.push({ id: `card-${pos}` });
    return { data: { data } };
  };
}

const run = (failed, poison, opts = {}) => {
  const seen = [];
  const log = [];
  return recoverFailedPages(failed, PAGE_SIZE, reqOpts, pageParams, {
    fetchPage: fakeApi(poison, { log }),
    onCards: cards => seen.push(...cards.map(c => c.id)),
    ...opts,
  }).then(unrecoverable => ({ unrecoverable, seen, log }));
};

test('a page containing 3 unfetchable records still yields the other 247', async () => {
  // Worst case: page 12 @250 spans positions 2751-3000, bad at 2816/2817/2843.
  const { unrecoverable, seen } = await run([12], [2816, 2817, 2843]);

  assert.deepEqual(unrecoverable.sort((a, b) => a - b), [2816, 2817, 2843],
    'only positions that fail when requested singly are unrecoverable');
  assert.equal(seen.length, 247, 'the other 247 cards must be rescued');
  assert.ok(seen.includes('card-2815') && seen.includes('card-2818'),
    'cards either side of a poisoned record are recovered');
  assert.ok(!seen.includes('card-2816'), 'an unfetchable record is never fabricated');
});

test('THE REAL CASE: a load-failed page is recovered whole, in one request', async () => {
  // What actually happens against the live API: the page failed under crawl
  // concurrency and a single paced retry returns all 250 cards.
  const { unrecoverable, seen, log } = await run([12], []);
  assert.deepEqual(unrecoverable, []);
  assert.equal(seen.length, 250);
  assert.equal(log.length, 1, 'no need to subdivide when the retry succeeds');
  assert.equal(log[0].size, 250);
});

test('subdivision narrows 250 -> 50 -> 10 -> 1, not straight to 1', async () => {
  // Going straight to single-card requests would cost 250 round trips per page.
  const { log } = await run([12], [2816]);
  const sizes = [...new Set(log.map(r => r.size))].sort((a, b) => b - a);
  assert.deepEqual(sizes, [250, 50, 10, 1]);
  assert.ok(log.length < 40,
    `one poisoned page should cost ~35 requests, not ${log.length}`);
});

test('only the slices containing a bad record get subdivided', async () => {
  const { log } = await run([12], [2816]);
  // 2816 sits in the second 50-slice (2801-2850) and the 10-slice 2811-2820.
  const tens = log.filter(r => r.size === 10);
  assert.ok(tens.every(r => r.first >= 2801 && r.last <= 2850),
    'clean 50-slices must not be re-requested at finer granularity');
  const ones = log.filter(r => r.size === 1);
  assert.ok(ones.every(r => r.first >= 2811 && r.last <= 2820),
    'only the failing 10-slice descends to single cards');
});

test('multiple failed pages are each recovered', async () => {
  const { unrecoverable, seen } = await run([12, 40], [2816, 9800]);
  assert.deepEqual(unrecoverable.sort((a, b) => a - b), [2816, 9800]);
  assert.equal(seen.length, 249 + 249);
});

test('a wholly unfetchable page reports every position, without throwing', async () => {
  const poison = [];
  for (let i = 2751; i <= 3000; i++) poison.push(i);
  const { unrecoverable, seen } = await run([12], poison);
  assert.equal(unrecoverable.length, 250);
  assert.equal(seen.length, 0);
});

test('no failed pages means no requests at all', async () => {
  const { log, unrecoverable } = await run([], [2816]);
  assert.deepEqual(unrecoverable, []);
  assert.equal(log.length, 0);
});
