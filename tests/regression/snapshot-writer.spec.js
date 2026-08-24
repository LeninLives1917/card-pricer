// tests/regression/snapshot-writer.spec.js
//
// PINS the state found 24 Aug 2026:
//
//     card_prices            19,251 rows, ALL from 2026-08-06 — one snapshot,
//                            whose Cardmarket half is the frozen pokemontcg.io
//                            feed, median 209 days old
//     card_price_snapshots        0 rows, correct shape, never written to
//
// So the project had no price history at all, which is why a euro feed could
// freeze for months without anyone noticing. The writer records what a lookup
// already fetched — no extra API calls — and the field that matters most is
// available_items, because Cardmarket publishes no sales count and its own API
// is closed to new applications. One reading is a level; the day-over-day
// DELTA is the only velocity signal available to us.
//
// A snapshot is bookkeeping. Every test below exists to keep it from ever
// delaying, failing, or breaking a price.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSnapshotRow, recordSnapshot, snapshotState, captureDay, _resetSnapshots,
} from '../../pricing/snapshot-writer.js';

const CARD = { set_id: 'base1', card_number: '4', name: 'Charizard' };

// Shaped like what the TCGGO adapter actually returns.
const PRICING = {
  rapidapi_cm: {
    price: 380, lowest_nm: 380, lowest_nm_eu: 375,
    avg7: 268.79, avg30: 272.97, available_items: 79,
    cardmarket_id: 274663, set_evidence: 'code', source: 'rapidapi_cm',
  },
  tcgplayer: { price: 489.11, source: 'justtcg' },
};

/** Minimal Supabase double — the project forbids mock.module(), so inject. */
function fakeDb({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        upsert(row, opts) {
          calls.push({ table, row, opts });
          return Promise.resolve({ error });
        },
      };
    },
  };
}

beforeEach(() => _resetSnapshots());

describe('buildSnapshotRow', () => {
  test('captures available_items — the whole reason this exists', () => {
    const row = buildSnapshotRow(CARD, PRICING);
    assert.equal(row.cm.available_items, 79,
      'the only supply signal Cardmarket exposes; its delta is the velocity');
  });

  test('carries the full price level alongside it', () => {
    const row = buildSnapshotRow(CARD, PRICING);
    assert.equal(row.cm.lowest_nm, 380);
    assert.equal(row.cm.lowest_nm_eu, 375);
    assert.equal(row.cm.avg7, 268.79);
    assert.equal(row.cm.avg30, 272.97);
    assert.equal(row.tcg.price, 489.11);
  });

  test('records HOW the price was matched', () => {
    // Without this a future reader cannot tell a set-confirmed price from a
    // sole-candidate guess, and would average the two together.
    assert.equal(buildSnapshotRow(CARD, PRICING).cm.evidence, 'code');
  });

  test('the key is set_id + number + captured_on, lowercased', () => {
    const row = buildSnapshotRow({ set_id: 'BASE1', card_number: '4' }, PRICING);
    assert.equal(row.set_id, 'base1');
    assert.equal(row.number, '4');
    assert.match(row.captured_on, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('a row with no numbers on it is not written', () => {
    // A heartbeat row would put gaps in the series that look like genuine
    // zero-supply days.
    assert.equal(buildSnapshotRow(CARD, {}), null);
    assert.equal(buildSnapshotRow(CARD, { rapidapi_cm: {} }), null);
    assert.equal(buildSnapshotRow(CARD, { rapidapi_cm: { lowest_nm: null } }), null);
  });

  test('available_items ALONE is worth a row, even with no price', () => {
    // Supply is the signal. A day where the listing count moved and the price
    // did not is exactly the observation we are collecting.
    const row = buildSnapshotRow(CARD, { rapidapi_cm: { available_items: 12 } });
    assert.ok(row);
    assert.equal(row.cm.available_items, 12);
    assert.equal(row.cm.lowest_nm, null);
  });

  test('no set or no number means no row — there is nothing to file it under', () => {
    assert.equal(buildSnapshotRow({ card_number: '4' }, PRICING), null);
    assert.equal(buildSnapshotRow({ set_id: 'base1' }, PRICING), null);
  });

  test('captureDay is UTC', () => {
    assert.equal(captureDay(new Date('2026-08-24T23:30:00Z')), '2026-08-24');
    assert.equal(captureDay(new Date('2026-08-25T00:30:00Z')), '2026-08-25');
  });
});

describe('recordSnapshot — one row per card per DAY', () => {
  test('writes once and upserts on the daily key', async () => {
    const db = fakeDb();
    assert.equal(await recordSnapshot(CARD, PRICING, { supabase: db }), true);
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].table, 'card_price_snapshots');
    assert.equal(db.calls[0].opts.onConflict, 'set_id,number,captured_on',
      'must match the table primary key or the upsert duplicates rows');
  });

  test('pricing the same card again the same day does NOT write again', async () => {
    // Six lookups in a session must not become six rows: a burst of identical
    // rows makes any delta computed off the series meaningless.
    const db = fakeDb();
    await recordSnapshot(CARD, PRICING, { supabase: db });
    await recordSnapshot(CARD, PRICING, { supabase: db });
    await recordSnapshot(CARD, PRICING, { supabase: db });
    assert.equal(db.calls.length, 1);
    assert.equal(snapshotState().skipped_same_day, 2);
  });

  test('a different day writes a new row', async () => {
    const db = fakeDb();
    await recordSnapshot(CARD, PRICING, { supabase: db, now: '2026-08-24T10:00:00Z' });
    await recordSnapshot(CARD, PRICING, { supabase: db, now: '2026-08-25T10:00:00Z' });
    assert.equal(db.calls.length, 2);
    assert.equal(db.calls[0].row.captured_on, '2026-08-24');
    assert.equal(db.calls[1].row.captured_on, '2026-08-25');
  });
});

describe('recordSnapshot — must never break a price', () => {
  test('a database error is counted, not thrown', async () => {
    const db = fakeDb({ error: { message: 'connection refused' } });
    assert.equal(await recordSnapshot(CARD, PRICING, { supabase: db }), false);
    assert.equal(snapshotState().failed, 1);
  });

  test('no database at all is survivable', async () => {
    assert.equal(await recordSnapshot(CARD, PRICING, {}), false);
    assert.equal(snapshotState().failed, 1);
  });

  test('a malformed pricing object does not throw', async () => {
    const db = fakeDb();
    await assert.doesNotReject(() => recordSnapshot(null, null, { supabase: db }));
    await assert.doesNotReject(() => recordSnapshot(CARD, { rapidapi_cm: 'nonsense' }, { supabase: db }));
  });

  test('a throwing client is caught', async () => {
    const boom = { from() { throw new Error('client exploded'); } };
    assert.equal(await recordSnapshot(CARD, PRICING, { supabase: boom }), false);
    assert.equal(snapshotState().failed, 1);
  });
});

describe('snapshotState — the ratio, not a bare count', () => {
  test('never asked is null, not zero', () => {
    assert.equal(snapshotState().write_rate, null,
      '"nothing priced yet" and "priced and never written" are different facts');
  });

  test('reports the write rate once something has been attempted', async () => {
    const db = fakeDb();
    await recordSnapshot(CARD, PRICING, { supabase: db });
    await recordSnapshot({ set_id: 'x' }, PRICING, { supabase: db }); // no number
    const s = snapshotState();
    assert.equal(s.attempted, 2);
    assert.equal(s.written, 1);
    assert.equal(s.skipped_no_key, 1);
    assert.equal(s.write_rate, 0.5);
  });

  test('distinguishes a missing key from missing data', async () => {
    const db = fakeDb();
    await recordSnapshot({ set_id: 'a' }, PRICING, { supabase: db });
    await recordSnapshot(CARD, {}, { supabase: db });
    const s = snapshotState();
    assert.equal(s.skipped_no_key, 1, 'identification gave us nothing to file under');
    assert.equal(s.skipped_no_data, 1, 'identified fine, but nothing was priced');
  });
});
