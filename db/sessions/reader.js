// db/sessions/reader.js
// Owner: A3 | Slice: S16 (F17, Q1)
//
// V2 reader for the user-state blob. Two paths, gated by the
// READ_FROM_RELATIONAL env var (see ./cutover-flag.js):
//
//   READ_FROM_RELATIONAL=false (default through phase 4):
//     Read `user_state.state` directly. V1 behaviour preserved 1:1.
//
//   READ_FROM_RELATIONAL=true (S24 flip):
//     Read sessions + session_cards (per-user, ordered) and reconstruct
//     the V1 blob shape. Loose fields (currentSessionId, wantlist, v)
//     have no relational home — they ride along in user_state.state.
//     If the relational tables are empty for this user (e.g. a user
//     whose blob was written before dual-write turned on), fall through
//     to the JSONB blob so a flip never blanks history.
//
// Response shape MUST stay byte-identical to V1 — the client (apps/vendor)
// expects { state: { sessions, currentSessionId, wantlist, v } | null,
// updated_at }. The cutover is invisible to the client.
//
// V2.1 follow-ups:
//   - Move currentSessionId / wantlist / v out of user_state into a
//     dedicated user_settings table (db/schema.md §3 deprecation note).
//   - Drop user_state.state once the JSONB tripwire is no longer needed.

import { supabase as defaultClient } from '../../apps/server/_clients.js';
import { shouldReadFromRelational } from './cutover-flag.js';

const TABLE_USER_STATE = 'user_state';
const TABLE_SESSIONS = 'sessions';
const TABLE_SESSION_CARDS = 'session_cards';

/**
 * Read the JSONB blob row directly. The V1 path.
 * @returns {Promise<{ state: object|null, updated_at: string|null }>}
 */
async function readJsonb(userId, client) {
  const { data, error } = await client
    .from(TABLE_USER_STATE)
    .select('state, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return {
    state: data?.state || null,
    updated_at: data?.updated_at || null,
  };
}

/**
 * Read sessions + session_cards rows for the user and stitch them back
 * into the V1 blob shape. The "loose" non-relational fields
 * (currentSessionId / wantlist / v) come from user_state.state — they
 * don't have a column in the relational schema (see schema.md §3).
 *
 * IMPORTANT: the keys of the returned `sessions` map are the
 * client-supplied session ids when we can recover them from card_data
 * or session.name+created_at, OR the relational sessions.id (uuid)
 * otherwise. The client doesn't care which it is — it indexes by the
 * id it finds and writes back the same id on next save (which the
 * dual-writer will SHA1 → uuid for the next round).
 *
 * For V2 dual-write we accept that the relational reconstruction will
 * use uuid-form session ids, which is a one-way drift from the
 * client's `sess_xxxxx` format. After S24 flip the client will receive
 * uuids in `state.sessions[*].id` — that's fine, the id is opaque to
 * the UI. dualWriteState will keep producing the same uuid for that
 * key on the next PUT (input id is now the uuid → SHA1 of uuid; the
 * row already exists at that id, so it's an idempotent UPDATE-noop).
 */
async function readRelational(userId, client) {
  // Fetch sessions for this user, newest first (per the dashboard index
  // sessions_user_created_idx).
  const { data: sessionsRows, error: sessErr } = await client
    .from(TABLE_SESSIONS)
    .select('id, name, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (sessErr) throw sessErr;

  // Fetch all this user's cards in one shot (ordered by created_at
  // ascending so the log[] preserves chronological order — the V1 client
  // appends to the end and renders in that order).
  const { data: cardRows, error: cardErr } = await client
    .from(TABLE_SESSION_CARDS)
    .select('session_id, card_data, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (cardErr) throw cardErr;

  if (!Array.isArray(sessionsRows) || sessionsRows.length === 0) {
    return null; // signal to caller: fall through to JSONB
  }

  // Group cards by session_id.
  const cardsBySession = new Map();
  for (const c of (cardRows || [])) {
    if (!c || !c.session_id) continue;
    let arr = cardsBySession.get(c.session_id);
    if (!arr) { arr = []; cardsBySession.set(c.session_id, arr); }
    arr.push(c.card_data);
  }

  const sessions = {};
  for (const row of sessionsRows) {
    sessions[row.id] = {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      log: cardsBySession.get(row.id) || [],
    };
  }

  return sessions;
}

/**
 * Read the user's state. Always returns the V1 response shape.
 *
 * @param {string} userId
 * @param {object} [client]
 * @returns {Promise<{ state: object|null, updated_at: string|null }>}
 */
export async function readState(userId, client = defaultClient) {
  if (!client) return { state: null, updated_at: null };
  if (!userId) return { state: null, updated_at: null };

  // Always read the JSONB row — even on the relational path we need its
  // loose fields (currentSessionId/wantlist/v) and updated_at timestamp.
  const jsonb = await readJsonb(userId, client);

  if (!shouldReadFromRelational()) {
    return jsonb;
  }

  // Relational read path (post-S24).
  let relationalSessions = null;
  try {
    relationalSessions = await readRelational(userId, client);
  } catch (e) {
    // Fail-safe: relational error → fall through to JSONB so a bad
    // index/RLS misconfig doesn't blank a user's history.
    console.warn('[sessions/reader] relational read failed, falling back to JSONB:', e?.message || e);
    return jsonb;
  }

  if (!relationalSessions) {
    // 0 rows — the user pre-dates dual-write or the relational table
    // hasn't caught up yet. JSONB stays authoritative.
    return jsonb;
  }

  // Stitch: relational sessions + JSONB loose fields.
  const looseState = jsonb.state && typeof jsonb.state === 'object' ? jsonb.state : {};
  const reconstructed = {
    sessions: relationalSessions,
    currentSessionId: looseState.currentSessionId ?? null,
    wantlist: Array.isArray(looseState.wantlist) ? looseState.wantlist : [],
    v: looseState.v ?? 1,
  };

  return {
    state: reconstructed,
    updated_at: jsonb.updated_at,
  };
}
