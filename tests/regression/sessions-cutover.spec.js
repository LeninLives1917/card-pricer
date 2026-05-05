// tests/regression/sessions-cutover.spec.js
// Owner: A3 | Slice: S16 (F17, Q1)
//
// Coverage for db/sessions/{dual-write,reader,cutover-flag}.js. The
// production routes (apps/server/routes/account.js) are thin pass-through
// so testing the modules directly with a stateful fake supabase is
// sufficient. The simple makeFakeSupabase from helpers/setup.js doesn't
// retain writes across calls — we need a stateful fake that mirrors the
// live `user_state` / `sessions` / `session_cards` tables.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dualWriteState, deriveSessionUuid, deriveCardUuid } from '../../db/sessions/dual-write.js';
import { readState } from '../../db/sessions/reader.js';
import { shouldReadFromRelational } from '../../db/sessions/cutover-flag.js';

// ---------- Stateful fake supabase ----------

/**
 * Keeps in-memory tables for user_state / sessions / session_cards and
 * mirrors the supabase-js chained surface that dual-write.js + reader.js
 * actually use:
 *   .from(t).upsert(row|rows, opts)                       — INSERT/UPDATE
 *   .from(t).upsert(...).select() returns inserted rows   — not used here
 *   .from(t).select(cols).eq(c, v).maybeSingle()          — point read
 *   .from(t).select(cols).eq(c, v).order(c, opts)         — list read
 */
function makeStatefulSupabase(seed = {}) {
  const tables = {
    user_state: new Map(seed.user_state || []), // user_id -> { user_id, state, updated_at }
    sessions: new Map(seed.sessions || []),     // id -> row
    session_cards: new Map(seed.session_cards || []), // id -> row
  };

  function build(table) {
    if (!tables[table]) throw new Error(`unexpected table: ${table}`);
    const op = { method: null, payload: null, eqs: [], orderArgs: null, limit: null, isMaybeSingle: false };

    const chain = {
      select: () => chain,
      upsert: (rowOrRows, _opts) => {
        op.method = 'upsert';
        op.payload = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        return chain;
      },
      insert: (rowOrRows) => {
        op.method = 'insert';
        op.payload = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        return chain;
      },
      update: (patch) => { op.method = 'update'; op.payload = patch; return chain; },
      delete: () => { op.method = 'delete'; return chain; },
      eq: (col, val) => { op.eqs.push([col, val]); return chain; },
      neq: () => chain, in: () => chain, gt: () => chain, lt: () => chain,
      gte: () => chain, lte: () => chain, like: () => chain,
      order: (...a) => { op.orderArgs = a; return chain; },
      limit: (n) => { op.limit = n; return chain; },
      range: () => chain,
      single: () => chain,
      maybeSingle: () => { op.isMaybeSingle = true; return chain; },
      then: (resolve, reject) => {
        try {
          let result = { data: null, error: null };
          if (op.method === 'upsert' || op.method === 'insert') {
            const pkCol = table === 'user_state' ? 'user_id' : 'id';
            const inserted = [];
            for (const row of op.payload) {
              const pk = row[pkCol];
              tables[table].set(pk, { ...tables[table].get(pk), ...row });
              inserted.push(tables[table].get(pk));
            }
            // .select().single() / .maybeSingle() at end → return one row
            if (op.isMaybeSingle) result = { data: inserted[0] ?? null, error: null };
            else result = { data: inserted, error: null };
          } else {
            // SELECT path
            let rows = Array.from(tables[table].values());
            for (const [c, v] of op.eqs) rows = rows.filter((r) => r[c] === v);
            if (op.orderArgs) {
              const [col, opts] = op.orderArgs;
              const asc = opts ? opts.ascending !== false : true;
              rows.sort((a, b) => {
                const av = a[col]; const bv = b[col];
                if (av === bv) return 0;
                return (av < bv ? -1 : 1) * (asc ? 1 : -1);
              });
            }
            if (op.limit != null) rows = rows.slice(0, op.limit);
            if (op.isMaybeSingle) result = { data: rows[0] ?? null, error: null };
            else result = { data: rows, error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        } catch (e) {
          return Promise.resolve({ data: null, error: e }).then(resolve, reject);
        }
      },
    };
    return chain;
  }

  return {
    from: (table) => build(table),
    _tables: tables,
  };
}

// ---------- Fixtures ----------

const USER_ID = '11111111-2222-3333-4444-555555555555';

function makeBlob() {
  return {
    sessions: {
      sess_abc: {
        id: 'sess_abc',
        name: 'Friday show',
        created_at: '2026-05-04T10:00:00.000Z',
        log: [
          { id: 'log_1', name: 'Pikachu', set: 'Base Set', price: 5.0, created_at: '2026-05-04T10:01:00.000Z' },
          { id: 'log_2', name: 'Charizard', set: 'Base Set', price: 250.0, created_at: '2026-05-04T10:02:00.000Z' },
        ],
      },
      sess_def: {
        id: 'sess_def',
        name: 'Saturday show',
        created_at: '2026-05-04T11:00:00.000Z',
        log: [
          { id: 'log_3', name: 'Blastoise', set: 'Base Set', price: 80.0, created_at: '2026-05-04T11:01:00.000Z' },
        ],
      },
    },
    currentSessionId: 'sess_abc',
    wantlist: [{ name: 'Mewtwo', max: 100 }],
    v: 1,
  };
}

// ---------- cutover-flag ----------

test('shouldReadFromRelational returns false by default (env unset)', () => {
  delete process.env.READ_FROM_RELATIONAL;
  assert.equal(shouldReadFromRelational(), false);
});

test('shouldReadFromRelational returns true only on exact "true"', () => {
  process.env.READ_FROM_RELATIONAL = 'true';
  assert.equal(shouldReadFromRelational(), true);
  process.env.READ_FROM_RELATIONAL = 'TRUE';
  assert.equal(shouldReadFromRelational(), false, 'case-sensitive on purpose');
  process.env.READ_FROM_RELATIONAL = '1';
  assert.equal(shouldReadFromRelational(), false);
  delete process.env.READ_FROM_RELATIONAL;
});

// ---------- dualWriteState ----------

test('dualWriteState writes both user_state JSONB and sessions/session_cards', async () => {
  const sb = makeStatefulSupabase();
  const blob = makeBlob();

  const result = await dualWriteState(USER_ID, blob, sb);

  assert.equal(result.ok, true);
  assert.equal(result.jsonb_written, true);
  assert.equal(result.sessions_upserted, 2);
  assert.equal(result.cards_upserted, 3);
  assert.equal(result.relational_errors, 0);

  // user_state has the blob.
  assert.equal(sb._tables.user_state.size, 1);
  const us = sb._tables.user_state.get(USER_ID);
  assert.deepEqual(us.state, blob);
  assert.equal(us.user_id, USER_ID);

  // sessions has 2 rows, both for our user.
  assert.equal(sb._tables.sessions.size, 2);
  for (const s of sb._tables.sessions.values()) {
    assert.equal(s.user_id, USER_ID);
    assert.ok(['Friday show', 'Saturday show'].includes(s.name));
  }

  // session_cards has 3 rows.
  assert.equal(sb._tables.session_cards.size, 3);

  // The session uuid for sess_abc is deterministic.
  const sessAbcUuid = deriveSessionUuid('sess_abc');
  assert.ok(sb._tables.sessions.has(sessAbcUuid));
  assert.equal(sb._tables.sessions.get(sessAbcUuid).name, 'Friday show');

  // The card uuids are deterministic from the session uuid + entry.id.
  const card1Uuid = deriveCardUuid(sessAbcUuid, 'id:log_1');
  assert.ok(sb._tables.session_cards.has(card1Uuid));
  assert.equal(sb._tables.session_cards.get(card1Uuid).card_data.name, 'Pikachu');
});

test('dualWriteState is idempotent: same blob applied twice = same end state', async () => {
  const sb = makeStatefulSupabase();
  const blob = makeBlob();

  await dualWriteState(USER_ID, blob, sb);
  const sessionsAfterFirst = sb._tables.sessions.size;
  const cardsAfterFirst = sb._tables.session_cards.size;
  const card1Key = [...sb._tables.session_cards.keys()][0];

  // Second write — same blob.
  const result2 = await dualWriteState(USER_ID, blob, sb);
  assert.equal(result2.ok, true);

  // No new rows created.
  assert.equal(sb._tables.sessions.size, sessionsAfterFirst, 'no duplicate sessions');
  assert.equal(sb._tables.session_cards.size, cardsAfterFirst, 'no duplicate cards');
  // Same uuid keys persist.
  assert.ok(sb._tables.session_cards.has(card1Key));
});

test('dualWriteState handles missing entry.id by using array index fallback', async () => {
  const sb = makeStatefulSupabase();
  const blob = {
    sessions: {
      sess_x: {
        id: 'sess_x',
        name: 'No-ids',
        created_at: '2026-05-04T10:00:00.000Z',
        log: [
          { name: 'A' }, // no id
          { name: 'B' }, // no id
        ],
      },
    },
    currentSessionId: 'sess_x',
    wantlist: [],
    v: 1,
  };

  const result = await dualWriteState(USER_ID, blob, sb);
  assert.equal(result.cards_upserted, 2);

  // Re-apply same blob — still 2 rows.
  await dualWriteState(USER_ID, blob, sb);
  assert.equal(sb._tables.session_cards.size, 2, 'idx-fallback uuids are stable across replays');
});

test('dualWriteState returns {ok:false, reason:"no_supabase"} when client is null', async () => {
  const result = await dualWriteState(USER_ID, makeBlob(), null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_supabase');
  assert.equal(result.jsonb_written, false);
});

test('dualWriteState rejects non-object state without throwing', async () => {
  const sb = makeStatefulSupabase();
  const result = await dualWriteState(USER_ID, null, sb);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_state');
});

// ---------- readState (READ_FROM_RELATIONAL=false) ----------

test('readState (default flag off) returns the JSONB blob unchanged', async () => {
  delete process.env.READ_FROM_RELATIONAL;
  const sb = makeStatefulSupabase();
  const blob = makeBlob();
  await dualWriteState(USER_ID, blob, sb);

  const out = await readState(USER_ID, sb);
  assert.deepEqual(out.state, blob);
  assert.ok(out.updated_at, 'updated_at must be populated');
});

test('readState returns nulls for an unknown user', async () => {
  delete process.env.READ_FROM_RELATIONAL;
  const sb = makeStatefulSupabase();
  const out = await readState('00000000-0000-0000-0000-000000000000', sb);
  assert.equal(out.state, null);
  assert.equal(out.updated_at, null);
});

// ---------- readState (READ_FROM_RELATIONAL=true) ----------

test('readState (flag on) reconstructs blob shape from relational tables', async () => {
  process.env.READ_FROM_RELATIONAL = 'true';
  try {
    const sb = makeStatefulSupabase();
    const blob = makeBlob();
    await dualWriteState(USER_ID, blob, sb);

    const out = await readState(USER_ID, sb);
    assert.ok(out.state, 'state must be present');
    assert.equal(typeof out.state.sessions, 'object');
    // 2 sessions reconstructed.
    const reconSessionIds = Object.keys(out.state.sessions);
    assert.equal(reconSessionIds.length, 2);

    // Each session has the expected name + log.
    const friday = Object.values(out.state.sessions).find((s) => s.name === 'Friday show');
    assert.ok(friday, 'Friday session present');
    assert.equal(friday.log.length, 2);
    assert.ok(friday.log.find((c) => c.name === 'Pikachu'));
    assert.ok(friday.log.find((c) => c.name === 'Charizard'));

    // Loose fields ride along from JSONB.
    assert.equal(out.state.currentSessionId, 'sess_abc');
    assert.deepEqual(out.state.wantlist, [{ name: 'Mewtwo', max: 100 }]);
    assert.equal(out.state.v, 1);
  } finally {
    delete process.env.READ_FROM_RELATIONAL;
  }
});

test('readState (flag on) falls back to JSONB when relational has no rows', async () => {
  process.env.READ_FROM_RELATIONAL = 'true';
  try {
    // Seed user_state directly (simulates a pre-dual-write user).
    const blob = makeBlob();
    const sb = makeStatefulSupabase({
      user_state: [[USER_ID, {
        user_id: USER_ID,
        state: blob,
        updated_at: '2026-05-04T09:00:00.000Z',
      }]],
    });

    const out = await readState(USER_ID, sb);
    // Falls through to JSONB → blob unchanged.
    assert.deepEqual(out.state, blob);
    assert.equal(out.updated_at, '2026-05-04T09:00:00.000Z');
  } finally {
    delete process.env.READ_FROM_RELATIONAL;
  }
});

// ---------- Round-trip ----------

test('PUT then GET round-trips with flag off (V1 path unchanged)', async () => {
  delete process.env.READ_FROM_RELATIONAL;
  const sb = makeStatefulSupabase();
  const blob = makeBlob();

  const put = await dualWriteState(USER_ID, blob, sb);
  assert.equal(put.ok, true);

  const got = await readState(USER_ID, sb);
  assert.deepEqual(got.state, blob, 'response shape stays byte-identical');
  // Confirm the response shape contract.
  assert.deepEqual(Object.keys(got).sort(), ['state', 'updated_at']);
});

test('readState returns nulls when supabase client is null', async () => {
  const out = await readState(USER_ID, null);
  assert.equal(out.state, null);
  assert.equal(out.updated_at, null);
});
