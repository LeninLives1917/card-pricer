// tests/regression/card-prices-store.spec.js
// Owner: A2 + A3 | Slice: S10 (F16)
//
// Coverage for db/price-snapshot/store.js. Uses a stateful in-memory fake
// supabase that implements just enough of supabase-js's PostgrestBuilder
// for the round-trips we care about: upsert with onConflict, select+eq+
// maybeSingle, and select+order+range pagination.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeSupabase } from '../helpers/setup.js';
import {
  saveCardPrice,
  bulkSaveCardPrices,
  loadAllCardPrices,
  getCardPrice,
  deleteAllCardPrices,
  __internal,
} from '../../db/price-snapshot/store.js';

/**
 * Stateful fake for the card_prices table. Backs a Map keyed by `set_id|number`,
 * supports:
 *   - .upsert(row|[rows], { onConflict }).select().maybeSingle()    → single
 *   - .upsert([rows], { onConflict })                                → bulk (no select)
 *   - .select('*').eq('set_id', x).eq('number', y).maybeSingle()
 *   - .select('*').order('set_id').range(from, to)                   → pagination
 *   - .delete().neq('set_id', '__never__')                            → wipe all
 */
function makeStatefulPricesClient(seedRows = []) {
  const calls = { from: [], operations: [] };
  const store = new Map(); // key: `${set_id}|${number}`
  for (const r of seedRows) store.set(`${r.set_id}|${r.number}`, { ...r });

  const buildChain = () => {
    const op = {
      method: null,
      payload: null,
      onConflict: null,
      eqs: [],
      neqs: [],
      order: null,
      range: null,
      hasSelect: false,
    };
    calls.operations.push(op);

    const chain = {
      select: () => { op.hasSelect = true; return chain; },
      upsert: (rows, opts) => {
        op.method = 'upsert';
        op.payload = rows;
        op.onConflict = opts?.onConflict || null;
        return chain;
      },
      delete: () => { op.method = 'delete'; return chain; },
      eq: (col, val) => { op.eqs.push([col, val]); return chain; },
      neq: (col, val) => { op.neqs.push([col, val]); return chain; },
      in: () => chain, gt: () => chain, lt: () => chain,
      gte: () => chain, lte: () => chain, like: () => chain,
      order: (col, opts) => { op.order = { col, opts }; return chain; },
      limit: () => chain,
      range: (from, to) => { op.range = { from, to }; return chain; },
      single: () => chain,
      maybeSingle: () => chain,
      then: (resolve) => {
        let result = { data: null, error: null };

        if (op.method === 'upsert') {
          const incoming = Array.isArray(op.payload) ? op.payload : [op.payload];
          const written = [];
          for (const row of incoming) {
            const key = `${row.set_id}|${row.number}`;
            const merged = { ...store.get(key), ...row };
            store.set(key, merged);
            written.push(merged);
          }
          if (op.hasSelect) {
            // .select().maybeSingle() returns the single row; for bulk
            // returns the array. We only call .maybeSingle() for single.
            result = { data: written.length === 1 ? written[0] : written, error: null };
          } else {
            // bulk path returns null data + null error (per supabase-js)
            result = { data: null, error: null };
          }
        } else if (op.method === 'delete') {
          // delete().neq(col, val) — wipe rows not matching
          let removed = 0;
          for (const [k, v] of [...store.entries()]) {
            const matches = op.neqs.every(([c, val]) => v[c] !== val);
            if (matches) {
              store.delete(k);
              removed++;
            }
          }
          result = { data: { removed }, error: null };
        } else {
          // pure select path
          if (op.eqs.length === 2) {
            // single-row lookup by (set_id, number)
            const sid = op.eqs.find(([c]) => c === 'set_id')?.[1];
            const num = op.eqs.find(([c]) => c === 'number')?.[1];
            const found = store.get(`${sid}|${num}`);
            result = { data: found ?? null, error: null };
          } else if (op.range) {
            // pagination — sort by set_id ascending and slice
            const all = [...store.values()].sort((a, b) =>
              (a.set_id || '').localeCompare(b.set_id || '')
            );
            const slice = all.slice(op.range.from, op.range.to + 1);
            result = { data: slice, error: null };
          } else {
            result = { data: [...store.values()], error: null };
          }
        }
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  };

  const client = {
    from: (table) => {
      calls.from.push(table);
      if (table !== 'card_prices') {
        throw new Error(`unexpected table: ${table}`);
      }
      return buildChain();
    },
  };

  return { client, calls, store };
}

// ---------- saveCardPrice + getCardPrice round-trip ----------

test('saveCardPrice + getCardPrice round-trip', async () => {
  const { client, store } = makeStatefulPricesClient();

  const row = {
    set_id: 'sv8',
    number: '1',
    name: 'Exeggcute',
    set_name: 'Surging Sparks',
    set_code: 'SSP',
    rarity: 'Common',
    image: 'https://images.pokemontcg.io/sv8/1.png',
    cardmarket_url: 'https://www.cardmarket.com/sv8/1',
    tcgplayer_url: 'https://www.tcgplayer.com/sv8/1',
    tcg: { normal: { market: 0.12 } },
    cm: { trendPrice: 0.10 },
    fetched_at: '2026-05-04T12:00:00Z',
  };

  const saved = await saveCardPrice(row, client);
  assert.equal(saved.set_id, 'sv8');
  assert.equal(saved.number, '1');
  assert.equal(saved.name, 'Exeggcute');

  const fetched = await getCardPrice('sv8', '1', client);
  assert.equal(fetched.name, 'Exeggcute');
  assert.deepEqual(fetched.tcg, { normal: { market: 0.12 } });
  assert.equal(store.size, 1);
});

// ---------- bulkSaveCardPrices upserts + updates ----------

test('bulkSaveCardPrices inserts then updates the same composite key', async () => {
  const { client, store } = makeStatefulPricesClient();

  const insert = await bulkSaveCardPrices([
    { set_id: 'sv8', number: '1', name: 'Exeggcute', tcg: { normal: { market: 0.10 } } },
    { set_id: 'sv8', number: '2', name: 'Exeggutor', tcg: { normal: { market: 0.50 } } },
    { set_id: 'me1', number: '155', name: 'Mega Venusaur ex', tcg: null, cm: null },
  ], client);

  assert.equal(insert.ok, true);
  assert.equal(insert.inserted, 3);
  assert.equal(store.size, 3);

  // Update sv8/1 — same composite key, fresh price.
  const update = await bulkSaveCardPrices([
    { set_id: 'sv8', number: '1', name: 'Exeggcute', tcg: { normal: { market: 0.18 } } },
  ], client);

  assert.equal(update.ok, true);
  assert.equal(store.size, 3, 'no new rows on conflict');
  assert.deepEqual(store.get('sv8|1').tcg, { normal: { market: 0.18 } });
});

// ---------- loadAllCardPrices Map shape ----------

test('loadAllCardPrices returns Map keyed by `${set_id_lower}-${number_no_zeros}`', async () => {
  const { client } = makeStatefulPricesClient([
    {
      set_id: 'SV8', number: '001', name: 'Exeggcute',
      set_name: 'Surging Sparks', set_code: 'SSP',
      tcg: { normal: { market: 0.12 } }, cm: null,
      fetched_at: '2026-05-04T12:00:00Z',
    },
    {
      set_id: 'me1', number: '155', name: 'Mega Venusaur ex',
      set_name: 'Mega Evolution', set_code: 'ME1',
      tcg: null, cm: null,
      fetched_at: '2026-05-04T12:00:00Z',
    },
  ]);

  const map = await loadAllCardPrices(client);

  assert.ok(map instanceof Map);
  assert.equal(map.size, 2);
  // Lower-cased set_id, leading zeros stripped from number — V1 parity.
  assert.ok(map.has('sv8-1'), 'expected key sv8-1 (lowercased + stripped zeros)');
  assert.ok(map.has('me1-155'));

  const exegg = map.get('sv8-1');
  assert.equal(exegg.name, 'Exeggcute');
  assert.equal(exegg.setName, 'Surging Sparks');
  assert.equal(exegg.setCode, 'SSP');
  assert.deepEqual(exegg.tcg, { normal: { market: 0.12 } });
  assert.equal(typeof exegg.fetchedAt, 'number', 'fetchedAt converted to ms epoch');
});

// ---------- key normalisation ----------

test('rowToKey strips leading zeros and lower-cases set_id', () => {
  const { rowToKey } = __internal;
  assert.equal(rowToKey({ set_id: 'SV8', number: '001' }), 'sv8-1');
  assert.equal(rowToKey({ set_id: 'sv8', number: '155' }), 'sv8-155');
  // All-zero number must NOT collapse to empty — fall back to original.
  assert.equal(rowToKey({ set_id: 'foo', number: '000' }), 'foo-000');
  // Promo numbers like SWSH001 stay intact except for leading numeric zeros.
  assert.equal(rowToKey({ set_id: 'swshp', number: '042' }), 'swshp-42');
});

// ---------- failsafe: null client ----------

test('all functions are no-op-safe when supabase client is null', async () => {
  const map = await loadAllCardPrices(null);
  assert.ok(map instanceof Map);
  assert.equal(map.size, 0);

  const single = await getCardPrice('sv8', '1', null);
  assert.equal(single, null);

  const saveRes = await saveCardPrice(
    { set_id: 'sv8', number: '1', name: 'Exeggcute' },
    null,
  );
  assert.equal(saveRes, null);

  const bulkRes = await bulkSaveCardPrices(
    [{ set_id: 'sv8', number: '1', name: 'Exeggcute' }],
    null,
  );
  assert.deepEqual(bulkRes, { ok: true, inserted: 0, errors: [] });

  const delRes = await deleteAllCardPrices(null);
  assert.deepEqual(delRes, { ok: true });
});

// ---------- saveCardPrice input validation ----------

test('saveCardPrice rejects rows missing set_id, number, or name', async () => {
  const { client } = makeStatefulPricesClient();
  await assert.rejects(
    () => saveCardPrice({ number: '1', name: 'X' }, client),
    /set_id, number, and name are required/,
  );
  await assert.rejects(
    () => saveCardPrice({ set_id: 'sv8', name: 'X' }, client),
    /set_id, number, and name are required/,
  );
  await assert.rejects(
    () => saveCardPrice({ set_id: 'sv8', number: '1' }, client),
    /set_id, number, and name are required/,
  );
});

// ---------- bulkSaveCardPrices empty + non-array no-ops ----------

test('bulkSaveCardPrices is a no-op for empty / non-array input', async () => {
  const { client } = makeStatefulPricesClient();
  const empty = await bulkSaveCardPrices([], client);
  assert.deepEqual(empty, { ok: true, inserted: 0, errors: [] });
  const undef = await bulkSaveCardPrices(undefined, client);
  assert.deepEqual(undef, { ok: true, inserted: 0, errors: [] });
});

// ---------- deleteAllCardPrices wipes ----------

test('deleteAllCardPrices clears the table', async () => {
  const { client, store } = makeStatefulPricesClient([
    { set_id: 'sv8', number: '1', name: 'A' },
    { set_id: 'sv8', number: '2', name: 'B' },
  ]);
  assert.equal(store.size, 2);
  const res = await deleteAllCardPrices(client);
  assert.equal(res.ok, true);
  assert.equal(store.size, 0);
});

// ---------- makeFakeSupabase compat: noop chain still resolves ----------

test('handles makeFakeSupabase noop chain without throwing on bulk save', async () => {
  // The non-stateful fake always resolves { data: null, error: null }
  // — bulk save should treat that as success (no error means no rejection).
  const sb = makeFakeSupabase();
  const res = await bulkSaveCardPrices(
    [{ set_id: 'sv8', number: '1', name: 'Exeggcute' }],
    sb.client,
  );
  assert.equal(res.ok, true);
  assert.equal(res.inserted, 1);
});
