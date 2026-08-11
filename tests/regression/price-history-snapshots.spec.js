// tests/regression/price-history-snapshots.spec.js
//
// INCIDENT THIS PINS (2026-08-10)
//
// `card_prices` is keyed (set_id, number) and every refresh UPSERTs over it.
// The app pulled Cardmarket prices for ~19k cards from May 2026 onward and
// overwrote the previous value each time. When price history was needed in
// August 2026, nothing the app had collected survived: the only usable points
// were a stale data/card-prices.json (2026-05-04) that had never been
// committed, and two accidental Wayback Machine captures of Cardmarket's own
// price guide. Months of daily collection produced zero history.
//
// Two things must stay true, and each has its own test below:
//   1. snapshotCardPrices APPENDS dated rows and never overwrites across days.
//   2. Its failures are COUNTED, not swallowed. It is fire-and-forget, so a
//      silent death is indistinguishable from working — and unlike a cache
//      miss the loss is permanent, because upstream only serves today's price.
//
// Note on the fake: makeFakeSupabase is a canned-response builder, not a
// stateful table. These tests assert on the ARGUMENTS handed to the client and
// on the counter side effects, which is what actually regressed. Round-trip
// persistence is covered by card-prices-store.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotCardPrices } from '../../db/price-snapshot/store.js';
import {
  getSnapshotCounts,
  resetSnapshotCounts,
} from '../../infra/observability/price-snapshot-counters.js';

/**
 * Recording fake: captures the table name, the upsert payload and the options
 * so we can assert the conflict target. Resolves whatever `error` is given.
 */
function makeRecordingClient(error = null) {
  const seen = [];
  const client = {
    from(table) {
      const chain = {
        upsert(rows, opts) {
          seen.push({ table, rows, opts });
          return Promise.resolve({ error });
        },
      };
      return chain;
    },
  };
  return { client, seen };
}

const ROWS = [
  { set_id: 'sv8', number: '105', name: 'Umbreon ex', cm: { trendPrice: 420 }, tcg: { market: 500 } },
  { set_id: 'base1', number: '4', name: 'Charizard', cm: { trendPrice: 4184 }, tcg: null },
];

test('snapshot upserts on the DATED composite key, so two days coexist', async () => {
  resetSnapshotCounts();
  const { client, seen } = makeRecordingClient();

  await snapshotCardPrices(ROWS, client);

  assert.equal(seen.length, 1, 'one chunk for two rows');
  assert.equal(seen[0].table, 'card_price_snapshots',
    'must write the history table, never card_prices');
  // The whole point. Conflicting on (set_id, number) alone would recreate the
  // original bug in a new table: yesterday's row replaced by today's.
  assert.equal(seen[0].opts.onConflict, 'set_id,number,captured_on',
    'captured_on MUST be in the conflict target or history overwrites itself');
});

test('snapshot historises prices only — not name/rarity/image', async () => {
  resetSnapshotCounts();
  const { client, seen } = makeRecordingClient();

  await snapshotCardPrices(ROWS, client);

  const [first] = seen[0].rows;
  assert.deepEqual(Object.keys(first).sort(), ['cm', 'number', 'set_id', 'tcg'],
    'snapshot rows carry the price payload and the key, nothing else');
  assert.equal(first.name, undefined,
    'name lives in card_prices; duplicating it per-day multiplies the table for no gain');
});

test('a clean write is counted, with row depth and a timestamp', async () => {
  resetSnapshotCounts();
  const { client } = makeRecordingClient();

  const res = await snapshotCardPrices(ROWS, client);

  assert.equal(res.ok, true);
  assert.equal(res.written, 2);
  const c = getSnapshotCounts();
  assert.equal(c.attempted, 1);
  assert.equal(c.written, 1);
  assert.equal(c.rows_written, 2, 'depth matters — "1 cycle" hides a 2-row cycle');
  assert.equal(c.write_rate, 1);
  assert.ok(c.last_write_at, 'a successful append must stamp when it happened');
});

test('a FAILED write is counted and never throws into the caller', async () => {
  resetSnapshotCounts();
  const { client } = makeRecordingClient({ message: 'permission denied' });

  // Must not reject: the caller is fire-and-forget alongside the load-bearing
  // latest-price write, which this must never be able to break.
  const res = await snapshotCardPrices(ROWS, client);

  assert.equal(res.ok, false);
  assert.equal(res.written, 0);
  assert.match(res.errors[0], /permission denied/);

  const c = getSnapshotCounts();
  assert.equal(c.attempted, 1);
  assert.equal(c.failed, 1);
  assert.equal(c.written, 0);
  // The dead state the health check keys on: asked, never succeeded.
  assert.equal(c.write_rate, 0);
});

test('write_rate is null before anything is attempted, not 0', async () => {
  resetSnapshotCounts();

  const c = getSnapshotCounts();
  assert.equal(c.attempted, 0);
  // "Never asked" and "asked and always failed" are different states. Reporting
  // both as 0 is how a dead path reads as merely idle — the exact conflation
  // that let the pHash fast path sit broken for months.
  assert.equal(c.write_rate, null);
  assert.equal(c.last_write_at, null);
});

test('a null client is counted as no_client, not as a successful write', async () => {
  resetSnapshotCounts();

  const res = await snapshotCardPrices(ROWS, null);

  assert.equal(res.ok, true, 'benign shape — local dev without supabase must not crash');
  assert.equal(res.written, 0);
  const c = getSnapshotCounts();
  assert.equal(c.no_client, 1);
  assert.equal(c.attempted, 0, 'never reached the DB, so it was not an attempt');
  assert.equal(c.written, 0, 'and emphatically not a write');
});

test('an empty row set is counted as empty, not attempted', async () => {
  resetSnapshotCounts();
  const { client, seen } = makeRecordingClient();

  const res = await snapshotCardPrices([], client);

  assert.equal(res.written, 0);
  assert.equal(seen.length, 0, 'no pointless round-trip');
  assert.equal(getSnapshotCounts().empty, 1);
});

test('rows missing set_id or number are dropped rather than sent as nulls', async () => {
  resetSnapshotCounts();
  const { client, seen } = makeRecordingClient();

  await snapshotCardPrices(
    [{ set_id: 'sv8', number: '105', cm: {} }, { set_id: null, number: '9', cm: {} }, { number: '3' }],
    client,
  );

  assert.equal(seen[0].rows.length, 1,
    'a null primary-key component would fail the whole chunk and lose the valid rows with it');
});
