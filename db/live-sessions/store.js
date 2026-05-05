// db/live-sessions/store.js
// Owner: A1 + A3 | Slice: S11 (F15)
//
// CRUD layer for live_sessions + live_session_scans (V2_AUDIT §5.14,
// V2_ARCHITECTURE §4 row F15, db/schema.md §12 + §13).
//
// Why service-role?
//   The phone-scanner side is anonymous (?pair=ROOMID, audit §5.14). The
//   RLS policies on these tables both require auth.uid() = owner_user_id,
//   so an anon write would be rejected. We bypass RLS via the service-role
//   client and gate writes with an explicit pair_code lookup — the host
//   account owning a row with that pair_code IS the authority check.
//
// Schema notes (read in supabase/migrations/20260502221125_v2_carryover.sql
// before changing anything):
//   - live_sessions.owner_user_id is NOT NULL with FK to auth.users(id).
//     => Host MUST have an authenticated account. The vendor app already
//     signs in for the laptop side, so this is a no-op constraint for the
//     happy path. There is NO "anonymous host" mode.
//   - live_sessions.pair_code is text NOT NULL UNIQUE.
//   - live_session_scans has UNIQUE(session_id, idempotency_key) — natural
//     dedup for retried phone POSTs.
//
// All exported functions accept an injected supabase client so tests can
// pass a mock. Production callers omit the arg and pick up the default
// service-role client from apps/server/_clients.js.

import { supabase as defaultClient } from '../../apps/server/_clients.js';

const TABLE_SESSIONS = 'live_sessions';
const TABLE_SCANS = 'live_session_scans';

/**
 * Create a new live pairing session.
 *
 * @param {object} params
 * @param {string} params.owner_user_id  — REQUIRED per schema (NOT NULL FK).
 * @param {string} [params.shop_id]
 * @param {string} [params.name]
 * @param {string} params.pair_code      — REQUIRED (UNIQUE).
 * @param {object} [client] — supabase client; defaults to service-role.
 * @returns {Promise<object>} the inserted row { id, owner_user_id, pair_code, ... }
 */
export async function createSession(
  { owner_user_id, shop_id, name, pair_code },
  client = defaultClient,
) {
  if (!client) throw new Error('live-sessions/store: supabase client unavailable');
  if (!owner_user_id) throw new Error('createSession: owner_user_id is required (schema NOT NULL)');
  if (!pair_code) throw new Error('createSession: pair_code is required');

  const row = { owner_user_id, pair_code };
  if (shop_id) row.shop_id = shop_id;
  if (name) row.name = name;

  const { data, error } = await client
    .from(TABLE_SESSIONS)
    .insert(row)
    .select('*')
    .single();

  if (error) throw new Error(`createSession failed: ${error.message || error}`);
  return data;
}

/**
 * Look up a session by its pair_code. Returns the session row or null.
 * Used as the authority gate for anonymous /api/room/:id/scan writes.
 *
 * @param {string} pair_code
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function getSessionByPairCode(pair_code, client = defaultClient) {
  if (!client) return null;
  if (!pair_code) return null;

  const { data, error } = await client
    .from(TABLE_SESSIONS)
    .select('*')
    .eq('pair_code', pair_code)
    .maybeSingle();

  if (error) {
    // Surface fail-soft: callers can fall back to in-memory rooms Map.
    console.warn('[live-sessions] getSessionByPairCode error:', error.message || error);
    return null;
  }
  return data ?? null;
}

/**
 * Mark a session closed. Soft-close — row is retained for history.
 *
 * @param {string} id
 * @param {object} [client]
 * @returns {Promise<object|null>} the updated row
 */
export async function closeSession(id, client = defaultClient) {
  if (!client) throw new Error('live-sessions/store: supabase client unavailable');
  if (!id) throw new Error('closeSession: id is required');

  const { data, error } = await client
    .from(TABLE_SESSIONS)
    .update({ closed_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`closeSession failed: ${error.message || error}`);
  return data ?? null;
}

/**
 * Insert a scan into a live_sessions row, idempotent on (session_id, idempotency_key).
 *
 * On conflict the existing row is returned without insert — phone retries
 * after a network blip are dedup'd at the DB. This relies on the UNIQUE
 * constraint declared in the carryover migration.
 *
 * @param {object} params
 * @param {string} params.session_id
 * @param {string} [params.scanned_by_user_id] — null for unauth phone scanners (allowed by schema)
 * @param {object} params.card_meta
 * @param {object} [params.pricing_snapshot]
 * @param {string} params.idempotency_key
 * @param {object} [client]
 * @returns {Promise<{ row: object, inserted: boolean }>}
 */
export async function addScan(
  { session_id, scanned_by_user_id, card_meta, pricing_snapshot, idempotency_key },
  client = defaultClient,
) {
  if (!client) throw new Error('live-sessions/store: supabase client unavailable');
  if (!session_id) throw new Error('addScan: session_id is required');
  if (!card_meta) throw new Error('addScan: card_meta is required');
  if (!idempotency_key) throw new Error('addScan: idempotency_key is required');

  const row = {
    session_id,
    card_meta,
    idempotency_key,
  };
  if (scanned_by_user_id) row.scanned_by_user_id = scanned_by_user_id;
  if (pricing_snapshot != null) row.pricing_snapshot = pricing_snapshot;

  // ON CONFLICT (session_id, idempotency_key) DO NOTHING — supabase-js way is
  // an upsert with ignoreDuplicates: true. The unique constraint matches.
  const { data: insertData, error: insertError } = await client
    .from(TABLE_SCANS)
    .upsert(row, { onConflict: 'session_id,idempotency_key', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();

  if (insertError) throw new Error(`addScan failed: ${insertError.message || insertError}`);

  if (insertData) {
    return { row: insertData, inserted: true };
  }

  // upsert with ignoreDuplicates returns no row on conflict — fetch the
  // already-existing row so callers always see one.
  const { data: existing, error: fetchError } = await client
    .from(TABLE_SCANS)
    .select('*')
    .eq('session_id', session_id)
    .eq('idempotency_key', idempotency_key)
    .maybeSingle();

  if (fetchError) throw new Error(`addScan re-fetch failed: ${fetchError.message || fetchError}`);
  return { row: existing ?? null, inserted: false };
}

/**
 * Get the most recent scans for a session, newest first.
 *
 * @param {string} session_id
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {object} [client]
 * @returns {Promise<Array<object>>}
 */
export async function getRecentScans(session_id, { limit = 50 } = {}, client = defaultClient) {
  if (!client) return [];
  if (!session_id) return [];

  const { data, error } = await client
    .from(TABLE_SCANS)
    .select('*')
    .eq('session_id', session_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[live-sessions] getRecentScans error:', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}
