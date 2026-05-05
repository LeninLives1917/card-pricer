// tests/regression/live-sessions.spec.js
// Owner: A1+A3 | Slice: S11 (F15)
//
// Coverage for db/live-sessions/{store,sse-bridge}.js. Uses the
// fakeSupabase helper from tests/helpers/setup.js; production never
// reaches the network from these tests. The fake mirrors enough of
// supabase-js's PostgrestBuilder surface that the store's chained calls
// resolve through to seeded data.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeSupabase } from '../helpers/setup.js';
import {
  createSession,
  getSessionByPairCode,
  closeSession,
  addScan,
  getRecentScans,
} from '../../db/live-sessions/store.js';
import {
  subscribe,
  unsubscribe,
  broadcastScan,
  listenerCount,
  clearAll,
} from '../../db/live-sessions/sse-bridge.js';

// ---------- Helpers ----------

/** Stateful fake supabase for live_session_scans dedup tests. The simple
 * makeFakeSupabase always resolves the same canned payload no matter which
 * chain method is called; for upsert+ignoreDuplicates we need the upsert
 * to return null on conflict but a follow-up select+eq+eq+maybeSingle to
 * return the existing row. Track call sequence and respond per-call. */
function makeStatefulScansClient({ existingByKey = new Map() } = {}) {
  const calls = { from: [], operations: [] };
  const inserted = []; // rows that were "successfully" inserted

  const buildScansChain = () => {
    const op = { method: null, payload: null, eqs: [], orderArgs: null, limit: null };
    calls.operations.push(op);

    const chain = {
      select: () => chain,
      // .upsert(row, opts) — record and decide later in .then()
      upsert: (row, opts) => {
        op.method = 'upsert';
        op.payload = { row, opts };
        return chain;
      },
      insert: (row) => { op.method = 'insert'; op.payload = row; return chain; },
      eq: (col, val) => { op.eqs.push([col, val]); return chain; },
      neq: () => chain, in: () => chain, gt: () => chain, lt: () => chain,
      gte: () => chain, lte: () => chain, like: () => chain,
      order: (...a) => { op.orderArgs = a; return chain; },
      limit: (n) => { op.limit = n; return chain; },
      range: () => chain,
      single: () => chain,
      maybeSingle: () => chain,
      then: (resolve) => {
        // Resolve based on op shape
        let result = { data: null, error: null };
        if (op.method === 'upsert') {
          const { row, opts } = op.payload;
          const key = `${row.session_id}|${row.idempotency_key}`;
          if (existingByKey.has(key)) {
            // Conflict + ignoreDuplicates => null data
            result = { data: null, error: null };
          } else {
            // Successful insert — fabricate a created_at + id
            const inserted_row = { id: `scan-${inserted.length + 1}`, created_at: new Date().toISOString(), ...row };
            existingByKey.set(key, inserted_row);
            inserted.push(inserted_row);
            result = { data: inserted_row, error: null };
          }
        } else {
          // .select().eq(session_id).eq(idempotency_key).maybeSingle() lookup path
          if (op.eqs.length >= 2) {
            const [, sid] = op.eqs.find(([c]) => c === 'session_id') || [];
            const [, idem] = op.eqs.find(([c]) => c === 'idempotency_key') || [];
            const found = existingByKey.get(`${sid}|${idem}`);
            result = { data: found ?? null, error: null };
          } else if (op.eqs.length === 1) {
            // .select().eq(session_id).order().limit() history fetch
            const [, sid] = op.eqs[0];
            const rows = inserted.filter((r) => r.session_id === sid);
            // Sort newest-first per the production query
            rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            const limit = op.limit ?? rows.length;
            result = { data: rows.slice(0, limit), error: null };
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
      if (table === 'live_session_scans') return buildScansChain();
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { client, calls, inserted };
}

// ---------- createSession ----------

test('createSession inserts and returns the row shape', async () => {
  const sb = makeFakeSupabase({
    live_sessions: { data: { id: 'sess-1', owner_user_id: 'user-1', pair_code: 'AB12CD' }, error: null },
  });

  const row = await createSession(
    { owner_user_id: 'user-1', pair_code: 'AB12CD' },
    sb.client,
  );

  assert.equal(row.id, 'sess-1');
  assert.equal(row.owner_user_id, 'user-1');
  assert.equal(row.pair_code, 'AB12CD');
  assert.deepEqual(sb.calls.from, ['live_sessions']);
});

test('createSession rejects when owner_user_id is missing (schema NOT NULL)', async () => {
  const sb = makeFakeSupabase();
  await assert.rejects(
    () => createSession({ pair_code: 'AB12CD' }, sb.client),
    /owner_user_id is required/,
  );
});

test('createSession rejects when pair_code is missing', async () => {
  const sb = makeFakeSupabase();
  await assert.rejects(
    () => createSession({ owner_user_id: 'user-1' }, sb.client),
    /pair_code is required/,
  );
});

// ---------- getSessionByPairCode ----------

test('getSessionByPairCode round-trips a known pair_code', async () => {
  const sb = makeFakeSupabase({
    live_sessions: { data: { id: 'sess-1', pair_code: 'AB12CD', closed_at: null }, error: null },
  });
  const row = await getSessionByPairCode('AB12CD', sb.client);
  assert.equal(row.id, 'sess-1');
  assert.equal(row.pair_code, 'AB12CD');
});

test('getSessionByPairCode returns null on unknown code (security gate)', async () => {
  const sb = makeFakeSupabase({
    live_sessions: { data: null, error: null },
  });
  const row = await getSessionByPairCode('NOPE99', sb.client);
  assert.equal(row, null);
});

// ---------- closeSession ----------

test('closeSession updates closed_at and returns row', async () => {
  const sb = makeFakeSupabase({
    live_sessions: { data: { id: 'sess-1', closed_at: '2026-05-04T12:00:00Z' }, error: null },
  });
  const row = await closeSession('sess-1', sb.client);
  assert.equal(row.id, 'sess-1');
  assert.ok(row.closed_at);
});

// ---------- addScan idempotency ----------

test('addScan inserts a new row and reports inserted=true', async () => {
  const { client, inserted } = makeStatefulScansClient();
  const result = await addScan(
    {
      session_id: 'sess-1',
      card_meta: { name: 'Charizard ex' },
      idempotency_key: 'sha1-abc',
    },
    client,
  );
  assert.equal(result.inserted, true);
  assert.equal(result.row.session_id, 'sess-1');
  assert.equal(result.row.idempotency_key, 'sha1-abc');
  assert.equal(inserted.length, 1);
});

test('addScan with idempotency_key collision returns existing row, no duplicate insert', async () => {
  const { client, inserted } = makeStatefulScansClient();

  const first = await addScan(
    { session_id: 'sess-1', card_meta: { name: 'A' }, idempotency_key: 'k1' },
    client,
  );
  assert.equal(first.inserted, true);

  const second = await addScan(
    { session_id: 'sess-1', card_meta: { name: 'A' }, idempotency_key: 'k1' },
    client,
  );
  assert.equal(second.inserted, false, 'second call must report dedup');
  assert.equal(second.row?.id, first.row.id, 'must return the original row');
  assert.equal(inserted.length, 1, 'only one row physically inserted');
});

// ---------- getRecentScans ----------

test('getRecentScans returns newest-first up to limit', async () => {
  const { client } = makeStatefulScansClient();
  await addScan({ session_id: 's1', card_meta: { n: 1 }, idempotency_key: 'a' }, client);
  await new Promise((r) => setTimeout(r, 5)); // ensure different created_at
  await addScan({ session_id: 's1', card_meta: { n: 2 }, idempotency_key: 'b' }, client);
  await new Promise((r) => setTimeout(r, 5));
  await addScan({ session_id: 's1', card_meta: { n: 3 }, idempotency_key: 'c' }, client);

  const rows = await getRecentScans('s1', { limit: 2 }, client);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].card_meta.n, 3, 'newest first');
  assert.equal(rows[1].card_meta.n, 2);
});

// ---------- sse-bridge ----------

test('bridge.broadcastScan fans to multiple subscribers', () => {
  clearAll();
  const writes1 = [];
  const writes2 = [];
  const res1 = { write: (s) => writes1.push(s) };
  const res2 = { write: (s) => writes2.push(s) };

  subscribe('sess-X', res1);
  subscribe('sess-X', res2);
  assert.equal(listenerCount('sess-X'), 2);

  broadcastScan('sess-X', {
    id: 'scan-1',
    card_meta: { name: 'Pikachu' },
    created_at: '2026-05-04T12:00:00Z',
  });

  assert.equal(writes1.length, 1);
  assert.equal(writes2.length, 1);
  assert.match(writes1[0], /^data: /);
  const parsed = JSON.parse(writes1[0].replace(/^data: /, '').trim());
  assert.equal(parsed.type, 'scan');
  assert.equal(parsed.entry.name, 'Pikachu');
  assert.equal(parsed.id, 'scan-1');
});

test('bridge.subscribe replays history oldest-first to new client', () => {
  clearAll();
  const writes = [];
  const res = { write: (s) => writes.push(s) };

  subscribe('sess-Y', res, {
    history: [
      { id: 's2', card_meta: { n: 2 }, created_at: '2026-05-04T12:00:02Z' },
      { id: 's1', card_meta: { n: 1 }, created_at: '2026-05-04T12:00:01Z' },
      { id: 's3', card_meta: { n: 3 }, created_at: '2026-05-04T12:00:03Z' },
    ],
  });

  assert.equal(writes.length, 3);
  const parsed = writes.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
  assert.deepEqual(parsed.map((p) => p.entry.n), [1, 2, 3], 'oldest first replay');
  assert.equal(parsed[0].replay, true, 'replay flag set');
});

test('bridge.unsubscribe drops the listener and cleans up empty sets', () => {
  clearAll();
  const res = { write: () => {} };
  subscribe('sess-Z', res);
  assert.equal(listenerCount('sess-Z'), 1);
  unsubscribe('sess-Z', res);
  assert.equal(listenerCount('sess-Z'), 0);
});

test('bridge.broadcastScan no-ops on session with no listeners', () => {
  clearAll();
  // Should NOT throw even with no Set in the map
  broadcastScan('sess-empty', { id: 'x', card_meta: {}, created_at: 'now' });
  assert.equal(listenerCount('sess-empty'), 0);
});
