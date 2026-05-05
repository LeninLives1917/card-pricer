// db/sessions/dual-write.js
// Owner: A3 | Slice: S16 (F17, Q1)
//
// V2 dual-writer for the user-state blob.
//
// Contract (V2_ARCHITECTURE §4 row "user_state" + §4.1):
//   - PUT /api/state hits this module via apps/server/routes/account.js.
//   - We UPSERT the entire JSONB blob into `user_state` (V1 path; preserved
//     verbatim — JSONB stays the source of truth through phase 4).
//   - We RECONCILE `sessions` + `session_cards` from the same blob so the
//     relational read path (S24, READ_FROM_RELATIONAL=true) can serve the
//     identical shape back to the client.
//
// Idempotency (V2_AUDIT §5.16 — debounced 1.5s client PUT can replay the
// same blob multiple times):
//   - sessions.id is a uuid PK; we derive it deterministically from the
//     client-supplied string id (`sess_<base36>`) via SHA1 → uuid v5-ish
//     namespacing. Same input → same uuid → ON CONFLICT DO UPDATE.
//   - session_cards.id is derived from (session_uuid + entry.id) — also
//     deterministic. If entry.id is missing (it shouldn't be — V1's
//     vendor/modules/log.js always assigns one), we fall back to
//     (session_uuid + array index). Replays of the same blob hit the
//     same rows.
//
// Orphan-row strategy:
//   - V2 dual-write does NOT delete sessions or session_cards that no
//     longer exist in the blob. The JSONB blob is still the source of
//     truth; if a client deletes a session locally and PUTs an updated
//     blob, the relational tables will retain the orphaned rows. This
//     is intentional for V2 — a deletion bug or split-brain that wipes
//     the blob would otherwise cascade into permanent relational loss.
//   - V2.1 ships a separate cleanup pass: a backfill script reconciles
//     orphans against the JSONB once dual-write parity is confirmed
//     (tracked in V2_ARCHITECTURE §4.1 / db/schema.md §3 deprecation).
//
// Service-role client (apps/server/_clients.js → `supabase`) is required:
//   - Bypasses RLS so a single user_id parameter is enough.
//   - If unavailable (env not configured, V1 fallback path), this module
//     no-ops gracefully — same shape as `addScan` in db/live-sessions/store.js.

import { createHash } from 'node:crypto';
import { supabase as defaultClient } from '../../apps/server/_clients.js';

const TABLE_USER_STATE = 'user_state';
const TABLE_SESSIONS = 'sessions';
const TABLE_SESSION_CARDS = 'session_cards';

// Stable namespace so the derived UUIDs don't collide with anything else
// the DB might generate. Arbitrary but fixed; do NOT change post-launch.
const NS_SESSION = 'cardpricer:session:';
const NS_CARD = 'cardpricer:card:';

/**
 * Convert any string to a deterministic UUID-v4-shaped string. We don't
 * use the `uuid` npm package (no new deps allowed in this slice) and the
 * exact UUID variant doesn't matter to Postgres — the column accepts any
 * 8-4-4-4-12 hex layout. SHA-1 → 32 hex chars → reformat as 8-4-4-4-12.
 *
 * Note: this is NOT a strict RFC 4122 v5 UUID (no version/variant nibble
 * patching). The intent is "stable hash that fits the uuid type". Postgres
 * does not enforce v4 layout.
 */
function deterministicUuid(namespace, input) {
  const hex = createHash('sha1').update(namespace + String(input)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** @returns {string} stable UUID for a client-supplied session id */
export function deriveSessionUuid(clientSessionId) {
  return deterministicUuid(NS_SESSION, clientSessionId);
}

/** @returns {string} stable UUID for (session, entry) pair */
export function deriveCardUuid(sessionUuid, entryKey) {
  return deterministicUuid(NS_CARD, `${sessionUuid}|${entryKey}`);
}

/**
 * Best-effort ISO-8601 normaliser for created_at fields out of the blob.
 * Client uses `created_at` (snake_case) per apps/vendor/modules/state.js,
 * but historical writes might use `createdAt`. Falls back to now() when
 * neither parses.
 */
function pickCreatedAt(obj, key1 = 'created_at', key2 = 'createdAt') {
  const raw = obj?.[key1] ?? obj?.[key2];
  if (!raw) return new Date().toISOString();
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return new Date().toISOString();
  return t.toISOString();
}

/**
 * Dual-write the user_state JSONB AND reconcile sessions/session_cards
 * for one user.
 *
 * @param {string} userId — auth.users.id of the authenticated request
 * @param {object} state — the full blob: { sessions, currentSessionId, wantlist, v }
 * @param {object} [client] — supabase client; defaults to service-role
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   jsonb_written: boolean,
 *   sessions_upserted: number,
 *   cards_upserted: number,
 *   relational_errors: number,
 * }>}
 */
export async function dualWriteState(userId, state, client = defaultClient) {
  const result = {
    ok: false,
    jsonb_written: false,
    sessions_upserted: 0,
    cards_upserted: 0,
    relational_errors: 0,
  };

  if (!client) {
    return { ...result, reason: 'no_supabase' };
  }
  if (!userId) {
    return { ...result, reason: 'no_user' };
  }
  if (!state || typeof state !== 'object') {
    return { ...result, reason: 'bad_state' };
  }

  // ── 1. JSONB upsert (V1 path; source of truth through phase 4) ──
  const updatedAt = new Date().toISOString();
  try {
    const { error } = await client
      .from(TABLE_USER_STATE)
      .upsert({ user_id: userId, state, updated_at: updatedAt });
    if (error) throw error;
    result.jsonb_written = true;
  } catch (e) {
    // JSONB write failure is fatal — that's the source of truth. Bubble.
    return { ...result, reason: `jsonb_upsert_failed: ${e?.message || e}` };
  }

  // ── 2. Relational reconciliation (best-effort — never fail the request) ──
  // Per-row try/catch: a single bad row doesn't poison the whole upsert pass.
  // Failures are logged + counted, not thrown — JSONB has the truth.
  const sessions = state.sessions || {};
  const sessionEntries = Object.entries(sessions);

  for (const [clientSessionId, sess] of sessionEntries) {
    if (!sess || typeof sess !== 'object') continue;
    const sessionUuid = deriveSessionUuid(clientSessionId);
    const sessionCreatedAt = pickCreatedAt(sess);
    const sessionName = (typeof sess.name === 'string' && sess.name.trim()) ? sess.name : 'Untitled';

    try {
      const { error } = await client
        .from(TABLE_SESSIONS)
        .upsert(
          {
            id: sessionUuid,
            user_id: userId,
            name: sessionName,
            created_at: sessionCreatedAt,
          },
          { onConflict: 'id' },
        );
      if (error) throw error;
      result.sessions_upserted += 1;
    } catch (e) {
      result.relational_errors += 1;
      console.warn('[sessions/dual-write] session upsert failed:', clientSessionId, e?.message || e);
      // If the session header failed we still try cards — supabase upserts
      // are independent and the FK constraint will reject orphan cards
      // cleanly.
    }

    const log = Array.isArray(sess.log) ? sess.log : [];
    for (let i = 0; i < log.length; i += 1) {
      const entry = log[i];
      if (!entry || typeof entry !== 'object') continue;

      // Deterministic key — entry.id when present (V1 always sets one in
      // log.js), array index fallback for defence in depth.
      const entryKey = entry.id != null ? `id:${entry.id}` : `idx:${i}`;
      const cardUuid = deriveCardUuid(sessionUuid, entryKey);
      const cardCreatedAt = pickCreatedAt(entry, 'created_at', 'createdAt');

      try {
        const { error } = await client
          .from(TABLE_SESSION_CARDS)
          .upsert(
            {
              id: cardUuid,
              session_id: sessionUuid,
              user_id: userId,
              card_data: entry,
              created_at: cardCreatedAt,
            },
            { onConflict: 'id' },
          );
        if (error) throw error;
        result.cards_upserted += 1;
      } catch (e) {
        result.relational_errors += 1;
        console.warn('[sessions/dual-write] card upsert failed:', clientSessionId, entryKey, e?.message || e);
      }
    }
  }

  result.ok = true;
  return result;
}
