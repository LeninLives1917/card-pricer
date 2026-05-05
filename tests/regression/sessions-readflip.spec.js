// tests/regression/sessions-readflip.spec.js
// Owner: A3 + A7 | Slice: S24 (F17, Q1)
//
// PARITY suite for the F17 sessions cutover read-flip.
//
// S16 (commit c248886) shipped:
//   - dualWriteState: writes user_state JSONB AND sessions/session_cards
//   - readState: returns the V1 blob shape, source-of-truth gated by the
//     READ_FROM_RELATIONAL env var
//   - shouldReadFromRelational: env-driven flag, read per-call
//
// S24's job is NOT to change any of that code — the cutover is operated
// as a Render env-var flip, no redeploy of code logic. S24's job is to
// PROVE that for every shape of input the V1 client can write, the
// READ_FROM_RELATIONAL=false and =true paths return THE SAME content,
// modulo timestamps the server normalises.
//
// Companion docs:
//   infra/deploy/sessions-readflip-runbook.md (operator runbook)
//   docs/V2_ARCHITECTURE.md §4.1 + §5 row F17
//   db/schema.md §3 (user_state deprecation)
//
// Test isolation note (re cutover-flag.js):
//   shouldReadFromRelational reads process.env on EVERY call. A test that
//   sets the env must restore it in a finally{} block — otherwise a later
//   test in the same file (or any other spec) reads a stale value. Each
//   test in this file sets+restores in its own scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dualWriteState,
  deriveSessionUuid,
  deriveCardUuid,
} from '../../db/sessions/dual-write.js';
import { readState } from '../../db/sessions/reader.js';
import { shouldReadFromRelational } from '../../db/sessions/cutover-flag.js';

// ---------------------------------------------------------------------------
// Stateful fake supabase (lifted from sessions-cutover.spec.js so this file
// stands alone — A7 doesn't want spec → spec coupling). Same surface as
// supabase-js for the slice the production code touches:
//   from(t).upsert(row, opts)
//   from(t).select(cols).eq(c, v).maybeSingle()
//   from(t).select(cols).eq(c, v).order(c, opts)
//
// Two extras vs. the S16 helper:
//   - injectError(table, op): force the next .from(t).<op>(…) chain to
//     resolve { data: null, error: <Error> } once. Lets us test the
//     reader's fall-through-to-JSONB safety net.
//   - .delete().eq() actually deletes (S16's helper short-circuited it
//     because dualWriteState never deletes — S24 still doesn't, kept the
//     stub for completeness).
// ---------------------------------------------------------------------------

function makeStatefulSupabase(seed = {}) {
  const tables = {
    user_state: new Map(seed.user_state || []),
    sessions: new Map(seed.sessions || []),
    session_cards: new Map(seed.session_cards || []),
  };
  const errorQueue = []; // [{table, op, error}]

  function dequeueError(table, op) {
    const idx = errorQueue.findIndex((e) => e.table === table && e.op === op);
    if (idx === -1) return null;
    const [hit] = errorQueue.splice(idx, 1);
    return hit.error;
  }

  function build(table) {
    if (!tables[table]) throw new Error(`unexpected table: ${table}`);
    const op = {
      method: null, payload: null, eqs: [], orderArgs: null,
      limit: null, isMaybeSingle: false,
    };

    const chain = {
      select: () => chain,
      upsert: (rowOrRows) => {
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
          // Honour any injected error first.
          const opKind = op.method
            || (op.isMaybeSingle ? 'maybeSingle'
              : (op.orderArgs ? 'order' : 'select'));
          const forced = dequeueError(table, opKind);
          if (forced) {
            return Promise.resolve({ data: null, error: forced }).then(resolve, reject);
          }

          let result = { data: null, error: null };

          if (op.method === 'upsert' || op.method === 'insert') {
            const pkCol = table === 'user_state' ? 'user_id' : 'id';
            const inserted = [];
            for (const row of op.payload) {
              const pk = row[pkCol];
              tables[table].set(pk, { ...tables[table].get(pk), ...row });
              inserted.push(tables[table].get(pk));
            }
            result = op.isMaybeSingle
              ? { data: inserted[0] ?? null, error: null }
              : { data: inserted, error: null };
          } else if (op.method === 'delete') {
            // Useful for hand-crafted "relational rows missing" scenarios
            // (the production dual-writer doesn't delete).
            for (const r of [...tables[table].values()]) {
              if (op.eqs.every(([c, v]) => r[c] === v)) {
                tables[table].delete(r.id ?? r.user_id);
              }
            }
            result = { data: null, error: null };
          } else {
            // SELECT
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
            result = op.isMaybeSingle
              ? { data: rows[0] ?? null, error: null }
              : { data: rows, error: null };
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
    /** Force the next chained call against (table, op) to error once. */
    injectError(table, op, message = 'forced test error') {
      errorQueue.push({ table, op, error: new Error(message) });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers used by the parity tests.
// ---------------------------------------------------------------------------

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * Run readState with an explicit env-flag value, restoring the prior value
 * regardless of failure. Tests must NOT mutate process.env at module level
 * — the cutover-flag module re-reads on every call, so leaks ripple.
 */
async function readWithFlag(flagValue, sb, userId = USER_ID) {
  const prior = process.env.READ_FROM_RELATIONAL;
  if (flagValue === undefined) delete process.env.READ_FROM_RELATIONAL;
  else process.env.READ_FROM_RELATIONAL = flagValue;
  try {
    return await readState(userId, sb);
  } finally {
    if (prior === undefined) delete process.env.READ_FROM_RELATIONAL;
    else process.env.READ_FROM_RELATIONAL = prior;
  }
}

/**
 * Compare two reader outputs for "client-visible parity". The reader's
 * relational path uses the deterministic-uuid as the session-map key
 * instead of the client-side `sess_xxx` id (S16 commit body §"open
 * questions" / "ID drift"). The client treats the key as opaque, so
 * parity is measured by the SET of session names + the ordered
 * card-name lists per session, NOT by the literal map keys.
 */
function sessionShape(state) {
  if (!state || !state.sessions) return [];
  return Object.values(state.sessions).map((s) => ({
    name: s?.name ?? null,
    cardNames: Array.isArray(s?.log) ? s.log.map((c) => c?.name ?? null) : [],
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function looseShape(state) {
  if (!state) return null;
  return {
    currentSessionId: state.currentSessionId ?? null,
    wantlist: Array.isArray(state.wantlist) ? state.wantlist : [],
    v: state.v ?? null,
  };
}

// ===========================================================================
// 1. Empty / null cases — boundary safety
// ===========================================================================

test('parity: user with no rows at all → both flags return {state:null, updated_at:null}', async () => {
  const sb = makeStatefulSupabase();

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  assert.deepEqual(off, { state: null, updated_at: null });
  assert.deepEqual(on, { state: null, updated_at: null });
});

test('parity: user with empty-state JSONB row only → both flags return same shape', async () => {
  // Pre-dual-write era user. JSONB exists but the relational tables are
  // bare. Reader.readRelational returns null → falls through to JSONB on
  // the on-flag side. Off-flag side returns JSONB directly.
  const emptyState = { sessions: {}, currentSessionId: null, wantlist: [], v: 1 };
  const sb = makeStatefulSupabase({
    user_state: [[USER_ID, {
      user_id: USER_ID,
      state: emptyState,
      updated_at: '2026-05-04T08:00:00.000Z',
    }]],
  });

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  assert.deepEqual(off.state, emptyState);
  assert.deepEqual(on.state, emptyState);
  assert.equal(off.updated_at, on.updated_at);
});

test('parity: explicit empty-sessions JSONB → both flags identical', async () => {
  // After write of an empty blob (e.g. user cleared every session locally
  // and the debounced PUT fired). Dual-writer wrote no relational rows
  // because Object.entries({}) is empty. Reader fell-through to JSONB.
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, { sessions: {}, currentSessionId: null, wantlist: [], v: 1 }, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  assert.deepEqual(off.state.sessions, {});
  assert.deepEqual(on.state.sessions, {});
  assert.deepEqual(off.state.wantlist, []);
  assert.deepEqual(on.state.wantlist, []);
});

// ===========================================================================
// 2. Single-session round-trip — core happy path
// ===========================================================================

test('parity: single session, 5 cards → both flags surface same names + ordering', async () => {
  const blob = {
    sessions: {
      sess_solo: {
        id: 'sess_solo', name: 'Sunday show',
        created_at: '2026-05-04T12:00:00.000Z',
        log: [
          { id: 'l1', name: 'Pikachu',     created_at: '2026-05-04T12:01:00.000Z' },
          { id: 'l2', name: 'Charmander',  created_at: '2026-05-04T12:02:00.000Z' },
          { id: 'l3', name: 'Squirtle',    created_at: '2026-05-04T12:03:00.000Z' },
          { id: 'l4', name: 'Bulbasaur',   created_at: '2026-05-04T12:04:00.000Z' },
          { id: 'l5', name: 'Mew',         created_at: '2026-05-04T12:05:00.000Z' },
        ],
      },
    },
    currentSessionId: 'sess_solo',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  assert.deepEqual(sessionShape(off.state), sessionShape(on.state));
  // Cards came back in the same chronological order.
  const offSession = Object.values(off.state.sessions)[0];
  const onSession = Object.values(on.state.sessions)[0];
  assert.deepEqual(
    offSession.log.map((c) => c.name),
    onSession.log.map((c) => c.name),
    'card order preserved across read paths',
  );
});

test('parity: single session, 0 cards → empty log on both paths', async () => {
  const blob = {
    sessions: {
      sess_empty: {
        id: 'sess_empty', name: 'Empty session',
        created_at: '2026-05-04T13:00:00.000Z',
        log: [],
      },
    },
    currentSessionId: 'sess_empty',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  const offSess = Object.values(off.state.sessions)[0];
  const onSess = Object.values(on.state.sessions)[0];
  assert.equal(offSess.log.length, 0);
  assert.equal(onSess.log.length, 0);
  assert.equal(offSess.name, onSess.name);
});

// ===========================================================================
// 3. Multi-session round-trip
// ===========================================================================

test('parity: 3 sessions with 0/5/15 cards → both paths agree on names + counts', async () => {
  const mkLog = (n, prefix, base) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}_${i}`,
    name: `${prefix}_card_${i}`,
    created_at: new Date(base + i * 1000).toISOString(),
  }));

  const blob = {
    sessions: {
      sess_a: {
        id: 'sess_a', name: 'A — empty',
        created_at: '2026-05-04T10:00:00.000Z',
        log: [],
      },
      sess_b: {
        id: 'sess_b', name: 'B — small',
        created_at: '2026-05-04T11:00:00.000Z',
        log: mkLog(5, 'b', Date.parse('2026-05-04T11:01:00.000Z')),
      },
      sess_c: {
        id: 'sess_c', name: 'C — big',
        created_at: '2026-05-04T12:00:00.000Z',
        log: mkLog(15, 'c', Date.parse('2026-05-04T12:01:00.000Z')),
      },
    },
    currentSessionId: 'sess_b',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  // Three sessions on each side.
  assert.equal(Object.keys(off.state.sessions).length, 3);
  assert.equal(Object.keys(on.state.sessions).length, 3);

  // Names + card counts match (key-set may differ — the client treats
  // map keys as opaque per S16 reader.js docstring).
  assert.deepEqual(sessionShape(off.state), sessionShape(on.state));
});

// ===========================================================================
// 4. Loose fields preserved (currentSessionId / wantlist / v)
// ===========================================================================

test('parity: loose JSONB fields ride along on the relational path', async () => {
  // S16 reader.js explicitly stitches looseState (currentSessionId, wantlist, v)
  // from user_state.state when on the relational path. This is the test
  // that proves it works — these fields don't have a column in sessions.
  const blob = {
    sessions: {
      sess_x: {
        id: 'sess_x', name: 'Loose-fields test',
        created_at: '2026-05-04T14:00:00.000Z',
        log: [{ id: 'l1', name: 'Card', created_at: '2026-05-04T14:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_x',
    wantlist: [
      { name: 'Mewtwo', max: 100 },
      { name: 'Lugia', max: 250 },
    ],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  // currentSessionId on the on-flag side stays as the V1 value because
  // the reader pulls it from JSONB. The client uses it as an opaque
  // pointer; the relational session-map key (a uuid) is a *separate*
  // concern. NOTE: this is a known V2.1 cleanup item — currentSessionId
  // still references the V1 sess_xxx id while sessions[] is keyed by
  // uuid. Documented in db/schema.md §3 + S16 commit body.
  assert.equal(off.state.currentSessionId, 'sess_x');
  assert.equal(on.state.currentSessionId, 'sess_x');

  assert.deepEqual(off.state.wantlist, blob.wantlist);
  assert.deepEqual(on.state.wantlist, blob.wantlist);

  assert.equal(off.state.v, 1);
  assert.equal(on.state.v, 1);

  // Sanity: the loose-shape projector matches.
  assert.deepEqual(looseShape(off.state), looseShape(on.state));
});

// ===========================================================================
// 5. Idempotent replay — read-side parity confirmation
// ===========================================================================

test('parity: writing same blob twice does NOT change either read result', async () => {
  const blob = {
    sessions: {
      sess_replay: {
        id: 'sess_replay', name: 'Replay',
        created_at: '2026-05-04T15:00:00.000Z',
        log: [
          { id: 'r1', name: 'Card A', created_at: '2026-05-04T15:01:00.000Z' },
          { id: 'r2', name: 'Card B', created_at: '2026-05-04T15:02:00.000Z' },
        ],
      },
    },
    currentSessionId: 'sess_replay',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();

  await dualWriteState(USER_ID, blob, sb);
  const off1 = await readWithFlag(undefined, sb);
  const on1 = await readWithFlag('true', sb);

  // Replay (debounced PUT replay scenario, V2_AUDIT §5.16).
  await dualWriteState(USER_ID, blob, sb);
  const off2 = await readWithFlag(undefined, sb);
  const on2 = await readWithFlag('true', sb);

  assert.deepEqual(sessionShape(off1.state), sessionShape(off2.state));
  assert.deepEqual(sessionShape(on1.state), sessionShape(on2.state));
  assert.deepEqual(sessionShape(off2.state), sessionShape(on2.state));

  // Row counts unchanged.
  assert.equal(sb._tables.sessions.size, 1);
  assert.equal(sb._tables.session_cards.size, 2);
});

// ===========================================================================
// 6. ID drift — relational path uses uuid map keys, client-side id stays the same
// ===========================================================================

test('parity: session-map key drifts to uuid on relational path; client treats keys as opaque', async () => {
  // S16 commit body explicitly flagged this. The session's own .id field
  // inside the session object also drifts — the relational reader builds
  // sessions[uuid] = { id: uuid, name, ... } NOT { id: 'sess_abc' }.
  // This is by design — V2.1 may rationalise — and the client doesn't
  // care because it indexes by whatever key it gets.
  const blob = {
    sessions: {
      sess_legacy: {
        id: 'sess_legacy', name: 'Legacy id',
        created_at: '2026-05-04T16:00:00.000Z',
        log: [{ id: 'lg1', name: 'L1', created_at: '2026-05-04T16:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_legacy',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  // Off: original key + id.
  assert.ok(off.state.sessions.sess_legacy);
  assert.equal(off.state.sessions.sess_legacy.id, 'sess_legacy');

  // On: key is the uuid; original sess_legacy is NOT a key.
  const expectedUuid = deriveSessionUuid('sess_legacy');
  assert.ok(on.state.sessions[expectedUuid]);
  assert.equal(on.state.sessions[expectedUuid].id, expectedUuid);
  assert.equal(on.state.sessions.sess_legacy, undefined);

  // Client-visible content (names + cards) is identical regardless of
  // key form — that's the parity contract.
  assert.deepEqual(sessionShape(off.state), sessionShape(on.state));
});

// ===========================================================================
// 7. Order preservation — non-monotonic created_at still sorts cleanly
// ===========================================================================

test('parity: cards with slightly-skewed timestamps still come back in created_at order', async () => {
  // Real-world clocks aren't monotonic; the V1 client log timestamps come
  // from the local browser clock and can drift across phone-pair pushes.
  // Reader sorts session_cards by created_at ASC — confirm that holds
  // when timestamps are out-of-order in the input log.
  const blob = {
    sessions: {
      sess_skew: {
        id: 'sess_skew', name: 'Skewed clocks',
        created_at: '2026-05-04T17:00:00.000Z',
        log: [
          // Note: log array is in insertion order (V1 appends to end),
          // but the timestamps interleave. Reader must order by ts.
          { id: 's1', name: 'First', created_at: '2026-05-04T17:01:00.000Z' },
          { id: 's3', name: 'Third', created_at: '2026-05-04T17:03:00.000Z' },
          { id: 's2', name: 'Second', created_at: '2026-05-04T17:02:00.000Z' },
          { id: 's4', name: 'Fourth', created_at: '2026-05-04T17:04:00.000Z' },
        ],
      },
    },
    currentSessionId: 'sess_skew',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  // Off-path returns the literal blob — order is the V1 log[] order.
  const offNames = Object.values(off.state.sessions)[0].log.map((c) => c.name);
  assert.deepEqual(offNames, ['First', 'Third', 'Second', 'Fourth']);

  // On-path sorts by created_at ASC — chronological.
  const onNames = Object.values(on.state.sessions)[0].log.map((c) => c.name);
  assert.deepEqual(onNames, ['First', 'Second', 'Third', 'Fourth']);

  // PARITY NOTE: This is the one place the two paths legitimately
  // disagree on observable shape — and it's the relational path that
  // is *more correct* (chronological). The V1 client appends to the
  // end of state.sessions[id].log so insertion-order ≈ chronological
  // in normal use; the readflip is safe even though this test
  // demonstrates a divergence. Operator runbook (§Monitoring)
  // mentions this as an expected, non-regressive variance.
});

// ===========================================================================
// 8. Failsafe: relational has 0 sessions but JSONB has data → fall through
// ===========================================================================

test('failsafe: flag=true with empty relational tables falls back to JSONB', async () => {
  // Simulates a user whose dual-write hasn't run yet (legacy or pre-S16
  // user) but who has a populated JSONB blob. Reader must fall through.
  const legacyBlob = {
    sessions: {
      sess_only_in_jsonb: {
        id: 'sess_only_in_jsonb', name: 'Pre-cutover',
        created_at: '2026-04-01T09:00:00.000Z',
        log: [{ id: 'old1', name: 'Old card', created_at: '2026-04-01T09:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_only_in_jsonb',
    wantlist: [{ name: 'Charizard' }],
    v: 1,
  };
  const sb = makeStatefulSupabase({
    user_state: [[USER_ID, {
      user_id: USER_ID,
      state: legacyBlob,
      updated_at: '2026-04-01T09:00:00.000Z',
    }]],
    // sessions + session_cards intentionally empty
  });

  const on = await readWithFlag('true', sb);
  // Falls through to JSONB → blob unchanged, sess_only_in_jsonb intact.
  assert.deepEqual(on.state, legacyBlob);
  assert.equal(on.updated_at, '2026-04-01T09:00:00.000Z');
});

// ===========================================================================
// 9. Failsafe: relational query errors mid-cutover → fall through gracefully
// ===========================================================================

test('failsafe: flag=true + sessions-table query errors → falls back to JSONB, no throw', async () => {
  // Mid-cutover Postgres glitch: imagine an RLS misconfig or a transient
  // network blip. Reader must NOT 500 the request — it has the JSONB
  // already, just return it.
  const blob = {
    sessions: {
      sess_safety: {
        id: 'sess_safety', name: 'Safety net',
        created_at: '2026-05-04T18:00:00.000Z',
        log: [{ id: 'sn1', name: 'Card', created_at: '2026-05-04T18:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_safety',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  // Inject error against the next sessions-table SELECT (.order is the
  // terminal call inside readRelational).
  sb.injectError('sessions', 'order', 'pg connection reset');

  const on = await readWithFlag('true', sb);
  // Should match the off-flag result exactly — fell through to JSONB.
  assert.deepEqual(on.state, blob);
  assert.ok(on.updated_at);
});

test('failsafe: flag=true + session_cards query errors → falls back to JSONB, no throw', async () => {
  const blob = {
    sessions: {
      sess_cards_err: {
        id: 'sess_cards_err', name: 'Cards-query error',
        created_at: '2026-05-04T19:00:00.000Z',
        log: [{ id: 'ce1', name: 'Card', created_at: '2026-05-04T19:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_cards_err',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  // sessions-list succeeds, session_cards fails.
  sb.injectError('session_cards', 'order', 'pg cards table read failed');

  const on = await readWithFlag('true', sb);
  assert.deepEqual(on.state, blob);
});

// ===========================================================================
// 10. S16 quirks — deterministic uuid, every-write idempotent
// ===========================================================================

test('S16 quirk: deriveSessionUuid is pure — same input always yields same output', () => {
  const a = deriveSessionUuid('sess_abc');
  const b = deriveSessionUuid('sess_abc');
  const c = deriveSessionUuid('sess_other');
  assert.equal(a, b);
  assert.notEqual(a, c);
  // 8-4-4-4-12 hex layout
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('S16 quirk: deriveCardUuid is pure for a (session, entry) pair', () => {
  const sessUuid = deriveSessionUuid('sess_abc');
  const a = deriveCardUuid(sessUuid, 'id:log_1');
  const b = deriveCardUuid(sessUuid, 'id:log_1');
  const c = deriveCardUuid(sessUuid, 'id:log_2');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('S16 quirk: replay through readRelational sees same uuid keys (no row drift)', async () => {
  const blob = {
    sessions: {
      sess_idem: {
        id: 'sess_idem', name: 'Idempotency',
        created_at: '2026-05-04T20:00:00.000Z',
        log: [{ id: 'ix1', name: 'Card', created_at: '2026-05-04T20:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_idem',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();

  await dualWriteState(USER_ID, blob, sb);
  const onFirst = await readWithFlag('true', sb);
  const firstKey = Object.keys(onFirst.state.sessions)[0];

  await dualWriteState(USER_ID, blob, sb); // replay
  const onSecond = await readWithFlag('true', sb);
  const secondKey = Object.keys(onSecond.state.sessions)[0];

  assert.equal(firstKey, secondKey, 'session map key stable across replays');
  assert.equal(sb._tables.sessions.size, 1);
  assert.equal(sb._tables.session_cards.size, 1);
});

// ===========================================================================
// 11. Test isolation — flag flip mid-spec actually flips per-call
// ===========================================================================

test('isolation: flag toggles within a single test run pick up new value per readState call', async () => {
  // shouldReadFromRelational reads process.env per call. This test exists
  // to lock in that contract — if a future refactor caches the value at
  // module load time, this test will fail.
  const blob = {
    sessions: {
      sess_toggle: {
        id: 'sess_toggle', name: 'Toggle',
        created_at: '2026-05-04T21:00:00.000Z',
        log: [{ id: 't1', name: 'Card', created_at: '2026-05-04T21:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_toggle',
    wantlist: [],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const prior = process.env.READ_FROM_RELATIONAL;
  try {
    delete process.env.READ_FROM_RELATIONAL;
    assert.equal(shouldReadFromRelational(), false);
    const off = await readState(USER_ID, sb);
    // Off-path: original sess_toggle key.
    assert.ok(off.state.sessions.sess_toggle);

    process.env.READ_FROM_RELATIONAL = 'true';
    assert.equal(shouldReadFromRelational(), true);
    const on = await readState(USER_ID, sb);
    // On-path: uuid key.
    assert.equal(on.state.sessions.sess_toggle, undefined);
    assert.ok(on.state.sessions[deriveSessionUuid('sess_toggle')]);

    // And back off again.
    process.env.READ_FROM_RELATIONAL = 'false';
    assert.equal(shouldReadFromRelational(), false);
    const offAgain = await readState(USER_ID, sb);
    assert.ok(offAgain.state.sessions.sess_toggle);
  } finally {
    if (prior === undefined) delete process.env.READ_FROM_RELATIONAL;
    else process.env.READ_FROM_RELATIONAL = prior;
  }
});

// ===========================================================================
// 12. Updated-at timestamp parity
// ===========================================================================

test('parity: updated_at comes from user_state on both paths', async () => {
  // Reader.js stitches updated_at from the JSONB row even on the
  // relational path (sessions/session_cards have their own created_at
  // but no aggregate "blob updated" stamp). Confirm both paths return
  // the same value.
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, {
    sessions: {
      sess_ts: {
        id: 'sess_ts', name: 'Timestamp test',
        created_at: '2026-05-04T22:00:00.000Z',
        log: [],
      },
    },
    currentSessionId: 'sess_ts',
    wantlist: [],
    v: 1,
  }, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);
  assert.equal(typeof off.updated_at, 'string');
  assert.equal(off.updated_at, on.updated_at);
});

// ===========================================================================
// 13. Cross-user isolation parity
// ===========================================================================

test('parity: relational read path is user-scoped — never leaks another user\'s sessions', async () => {
  // Both readJsonb and readRelational filter by user_id. Confirm two
  // users in the same DB don't see each other's data on either path.
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const sb = makeStatefulSupabase();

  await dualWriteState(userA, {
    sessions: { sess_a: { id: 'sess_a', name: 'A only', created_at: '2026-05-04T23:00:00.000Z', log: [] } },
    currentSessionId: 'sess_a', wantlist: [], v: 1,
  }, sb);
  await dualWriteState(userB, {
    sessions: { sess_b: { id: 'sess_b', name: 'B only', created_at: '2026-05-04T23:00:00.000Z', log: [] } },
    currentSessionId: 'sess_b', wantlist: [], v: 1,
  }, sb);

  // User A — both paths see only "A only".
  const aOff = await readWithFlag(undefined, sb, userA);
  const aOn = await readWithFlag('true', sb, userA);
  assert.deepEqual(sessionShape(aOff.state).map((s) => s.name), ['A only']);
  assert.deepEqual(sessionShape(aOn.state).map((s) => s.name), ['A only']);

  // User B — both paths see only "B only".
  const bOff = await readWithFlag(undefined, sb, userB);
  const bOn = await readWithFlag('true', sb, userB);
  assert.deepEqual(sessionShape(bOff.state).map((s) => s.name), ['B only']);
  assert.deepEqual(sessionShape(bOn.state).map((s) => s.name), ['B only']);
});

// ===========================================================================
// 14. Modify-then-read parity (the F17-01 v2 feature test, scoped to read)
// ===========================================================================

test('parity: PUT → read off → modify → PUT → read on → expected after every step', async () => {
  // The end-to-end pattern from V2_ARCHITECTURE.md §7.2 F17-01.
  const sb = makeStatefulSupabase();

  // Step 1 — PUT initial blob.
  const v1 = {
    sessions: {
      sess_e2e: {
        id: 'sess_e2e', name: 'E2E',
        created_at: '2026-05-04T22:00:00.000Z',
        log: [{ id: 'e1', name: 'Card 1', created_at: '2026-05-04T22:01:00.000Z' }],
      },
    },
    currentSessionId: 'sess_e2e', wantlist: [], v: 1,
  };
  await dualWriteState(USER_ID, v1, sb);

  // Step 2 — read off (V1 path).
  const r1 = await readWithFlag(undefined, sb);
  assert.equal(Object.values(r1.state.sessions)[0].log.length, 1);

  // Step 3 — modify: append a card.
  const v2 = {
    ...v1,
    sessions: {
      sess_e2e: {
        ...v1.sessions.sess_e2e,
        log: [
          ...v1.sessions.sess_e2e.log,
          { id: 'e2', name: 'Card 2', created_at: '2026-05-04T22:02:00.000Z' },
        ],
      },
    },
  };
  await dualWriteState(USER_ID, v2, sb);

  // Step 4 — read on (relational path) — must reflect the new card.
  const r2 = await readWithFlag('true', sb);
  const session = Object.values(r2.state.sessions)[0];
  assert.equal(session.log.length, 2);
  assert.deepEqual(session.log.map((c) => c.name), ['Card 1', 'Card 2']);

  // Step 5 — flip back, read again, confirm V1 path also up-to-date.
  const r3 = await readWithFlag(undefined, sb);
  assert.equal(Object.values(r3.state.sessions)[0].log.length, 2);
});

// ===========================================================================
// 15. Wantlist edge cases — non-array wantlist defaults to []
// ===========================================================================

test('parity: corrupted wantlist (non-array) on JSONB blob is normalised on relational path', async () => {
  // S16 reader.js: `Array.isArray(looseState.wantlist) ? looseState.wantlist : []`.
  // The off-path returns the raw JSONB (which might have a corrupted
  // wantlist if a buggy client wrote one), the on-path defensively
  // reads and array-coerces. This is a known divergence — document it.
  // PARITY: not byte-identical, but the on-path is *safer* (the V1
  // client is array-typed; a corrupted blob is a real bug to
  // surface elsewhere).
  const sb = makeStatefulSupabase({
    user_state: [[USER_ID, {
      user_id: USER_ID,
      state: {
        sessions: {},
        currentSessionId: null,
        wantlist: 'not an array',
        v: 1,
      },
      updated_at: '2026-05-04T22:00:00.000Z',
    }]],
  });
  // Seed one session row so readRelational doesn't fall through to JSONB.
  sb._tables.sessions.set('seed-uuid', {
    id: 'seed-uuid', user_id: USER_ID, name: 'seed',
    created_at: '2026-05-04T22:00:00.000Z',
  });

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  assert.equal(off.state.wantlist, 'not an array', 'off-path returns raw JSONB');
  assert.deepEqual(on.state.wantlist, [], 'on-path defensively normalises');
});

// ===========================================================================
// 16. v field parity — defaults to 1 if missing
// ===========================================================================

test('parity: missing state.v defaults to 1 on relational path (off-path returns whatever JSONB has)', async () => {
  // Reader stitches `looseState.v ?? 1`. Off-path returns the raw blob.
  // If a legacy blob is missing v, on-path returns 1, off-path returns
  // undefined. Documented divergence — clients treat `v` as "if 1, V1
  // shape" and undefined is conservatively coerced to 1 on-path.
  const sb = makeStatefulSupabase({
    user_state: [[USER_ID, {
      user_id: USER_ID,
      state: {
        sessions: {},
        currentSessionId: null,
        wantlist: [],
        // no `v` field
      },
      updated_at: '2026-05-04T22:00:00.000Z',
    }]],
  });
  sb._tables.sessions.set('seed-uuid-2', {
    id: 'seed-uuid-2', user_id: USER_ID, name: 'seed',
    created_at: '2026-05-04T22:00:00.000Z',
  });

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  assert.equal(off.state.v, undefined, 'off-path: raw JSONB value');
  assert.equal(on.state.v, 1, 'on-path: defensive default');
});

// ===========================================================================
// 17. Parity contract — identical SHAPES (names + per-session counts) on the happy path
// ===========================================================================

test('parity contract: shape projection equality on the canonical multi-session blob', async () => {
  // The "production-shaped" parity assertion. Anything a V1 client
  // would render is identical between the two read paths for a normal
  // user blob. This is the single most important test in the file —
  // human reviewer should read this carefully.
  const blob = {
    sessions: {
      sess_friday: {
        id: 'sess_friday', name: 'Friday show',
        created_at: '2026-05-04T10:00:00.000Z',
        log: [
          { id: 'f1', name: 'Pikachu', set: 'Base', price: 5, created_at: '2026-05-04T10:01:00.000Z' },
          { id: 'f2', name: 'Charizard', set: 'Base', price: 250, created_at: '2026-05-04T10:02:00.000Z' },
        ],
      },
      sess_saturday: {
        id: 'sess_saturday', name: 'Saturday show',
        created_at: '2026-05-04T11:00:00.000Z',
        log: [
          { id: 's1', name: 'Blastoise', set: 'Base', price: 80, created_at: '2026-05-04T11:01:00.000Z' },
        ],
      },
    },
    currentSessionId: 'sess_friday',
    wantlist: [{ name: 'Mewtwo', max: 100 }],
    v: 1,
  };
  const sb = makeStatefulSupabase();
  await dualWriteState(USER_ID, blob, sb);

  const off = await readWithFlag(undefined, sb);
  const on = await readWithFlag('true', sb);

  // Identical session SHAPES (names + ordered card-name lists) — the
  // single assertion that gates "OK to flip".
  assert.deepEqual(sessionShape(off.state), sessionShape(on.state));

  // Identical loose-fields (currentSessionId / wantlist / v).
  assert.deepEqual(looseShape(off.state), looseShape(on.state));

  // Identical updated_at.
  assert.equal(off.updated_at, on.updated_at);

  // Per-card payloads (set/price/etc.) preserved in card_data jsonb.
  // Pull a card from each path and compare the non-id-keyed subset.
  const offFriday = Object.values(off.state.sessions).find((s) => s.name === 'Friday show');
  const onFriday = Object.values(on.state.sessions).find((s) => s.name === 'Friday show');
  const offPikachu = offFriday.log.find((c) => c.name === 'Pikachu');
  const onPikachu = onFriday.log.find((c) => c.name === 'Pikachu');
  assert.equal(offPikachu.set, onPikachu.set);
  assert.equal(offPikachu.price, onPikachu.price);
});
