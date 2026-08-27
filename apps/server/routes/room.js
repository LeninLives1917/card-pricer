// apps/server/routes/room.js
// Owner: A1 (route) + A3 (Postgres adoption) | Slices: S5 (extraction), S11 (live_sessions adoption)
//
// Routes (V1 server.js:5128-5172):
//   POST /api/room/:id/scan     — public; phone pushes a scanned card to the room
//   GET  /api/room/:id/stream   — public SSE; laptop subscribes for live phone scans
//   GET  /api/room/:id/history  — public; last 50 history entries
//
// V2_AUDIT §5.14: scanner-mode (?pair=ROOMID) bypasses auth entirely; the
// room ID is secret-by-obscurity, not authenticated. The URL `:id` is the
// pair_code (V1's room id == V1's secret).
//
// S11: dual-write to Postgres live_sessions + live_session_scans. Service-role
// bypasses RLS; the pair_code lookup is the gate. If a pair_code does not
// match an open session row, scan POSTs are rejected 404 — without a row
// in live_sessions there is no host account to attach the scan to, and the
// V1 model said "anyone with the room ID can push" but V2 hardens that:
// the host must explicitly create the session by calling the existing host
// flow (the vendor app already does this through "Pair Phone (QR)").
//
// FAILSAFE (per S11 brief): if Supabase is unavailable, the in-memory rooms
// Map continues to work as before. Postgres is additive resilience, NOT a
// hard dependency. The legacy V1 path keeps working when DB is down.

import express from 'express';
import crypto from 'crypto';

import * as store from '../../../db/live-sessions/store.js';
import * as bridge from '../../../db/live-sessions/sse-bridge.js';
import { supabase } from '../_clients.js';

const router = express.Router();

// In-memory rooms (V1 fallback): { roomId: { listeners, history, bytes, seenAt } }
// Kept for Supabase-down failsafe and for tests that don't seed Postgres.
//
// ── INCIDENT, 27 Aug 2026: THIS OOM-KILLED THE INSTANCE ────────────────────
//
// The buffer held 500 messages per room and each message carries the FULL
// base64 image. It was bounded by COUNT, and a count bound on variable-size
// items is not a bound at all — it is a bound on a number that has nothing to
// do with the resource being consumed.
//
//     ~470 KB per scan (1600px preview grab)  x500 = 235 MB per room
//     ~5 MB per scan   (full-sensor still)    x500 = 2.5 GB per room
//
// 235 MB on top of ~136 MB of resident catalogue is most of a 512 MB Starter,
// so one operator working through a box was enough. The full-sensor still
// shipped hours before the alert made it ten times worse, and would exceed a
// 2 GB Standard on a single room — which is why upgrading the instance would
// not have fixed this.
//
// Two further faults in the same six lines:
//
//   - only the last 50 are ever served (slice(-50) below), so 450 of the 500
//     were unreachable by any code path. Ninety percent of the memory was not
//     a tradeoff, it was waste.
//   - rooms were never evicted. rooms.clear() is a test-only hook, so every
//     pair code ever used kept its buffer for the life of the process.
//
// Now bounded by BYTES, capped per room and globally, with idle rooms evicted
// and every eviction counted.

/** Never serve more than this, so never retain more than this. */
const HISTORY_MAX = 50;

/** Per-room byte budget for retained scan messages. */
const ROOM_BYTES_MAX = 12 * 1024 * 1024;

/** Global ceiling across all rooms — the per-room cap alone bounds nothing. */
const TOTAL_BYTES_MAX = 64 * 1024 * 1024;

/** A room with no listeners and no traffic for this long is gone. */
const ROOM_IDLE_MS = 30 * 60 * 1000;

const rooms = new Map();
let totalBytes = 0;

const roomStats = {
  evicted_idle: 0, evicted_pressure: 0, dropped_oversize: 0, trimmed: 0,
};
export function roomMemoryStats() {
  return { ...roomStats, rooms: rooms.size, bytes: totalBytes };
}

/** Exported for tests: eviction cannot be exercised without seeding rooms. */
export function _getRoom(id) { return getRoom(id); }

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { listeners: new Set(), history: [], bytes: 0, seenAt: Date.now() });
  const r = rooms.get(id);
  r.seenAt = Date.now();
  return r;
}

/**
 * Add a message to a room's history under a byte budget.
 *
 * Exported so the bound is testable directly. A single message larger than the
 * whole room budget is DROPPED rather than admitted-then-trimmed: admitting it
 * would evict every other entry to make room for one item nothing asked for.
 *
 * @returns {'stored'|'dropped_oversize'}
 */
export function pushBounded(room, msg, {
  maxItems = HISTORY_MAX, maxBytes = ROOM_BYTES_MAX,
} = {}) {
  const size = Buffer.byteLength(msg, 'utf8');
  if (size > maxBytes) {
    roomStats.dropped_oversize++;
    return 'dropped_oversize';
  }
  room.history.push(msg);
  room.bytes += size;
  totalBytes += size;
  while (room.history.length > maxItems || room.bytes > maxBytes) {
    const gone = room.history.shift();
    if (gone === undefined) break;
    const freed = Buffer.byteLength(gone, 'utf8');
    room.bytes -= freed;
    totalBytes -= freed;
    roomStats.trimmed++;
  }
  return 'stored';
}

/**
 * Drop idle rooms, then drop the oldest rooms if the process is still over
 * the global budget. Runs on write rather than on a timer: a timer keeps a
 * mostly-idle process awake, and pressure only ever arrives with a write.
 */
export function sweepRooms({ now = Date.now(), idleMs = ROOM_IDLE_MS, totalMax = TOTAL_BYTES_MAX } = {}) {
  for (const [id, r] of rooms) {
    if (r.listeners.size === 0 && now - r.seenAt > idleMs) {
      totalBytes -= r.bytes;
      rooms.delete(id);
      roomStats.evicted_idle++;
    }
  }
  if (totalBytes <= totalMax) return;
  // Oldest first. A room someone is actively watching is the last to go, and
  // it still goes — running out of memory helps nobody.
  const byAge = [...rooms.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
  for (const [id, r] of byAge) {
    if (totalBytes <= totalMax) break;
    totalBytes -= r.bytes;
    rooms.delete(id);
    roomStats.evicted_pressure++;
  }
}

// Cache pair_code → session row for the lifetime of this process so we
// don't round-trip Postgres on every scan POST. Invalidated implicitly
// when sessions are closed (we just don't see traffic for them).
const sessionCache = new Map(); // pair_code → live_sessions row

async function lookupSession(pairCode) {
  if (!pairCode) return null;
  if (sessionCache.has(pairCode)) return sessionCache.get(pairCode);
  if (!supabase) return null; // Failsafe: fall back to in-memory only
  try {
    const row = await store.getSessionByPairCode(pairCode);
    if (row && !row.closed_at) {
      sessionCache.set(pairCode, row);
    }
    return row && !row.closed_at ? row : null;
  } catch (e) {
    console.warn('[room] lookupSession failed:', e.message || e);
    return null;
  }
}

// Generate a server-side fallback idempotency key when the client doesn't
// supply one. V1 had no idempotency_key field; phones that haven't been
// upgraded won't send it. We hash the body + a 1-second time bucket so
// genuine retries within the same second collapse, but a deliberate
// re-scan a second later inserts a fresh row.
function fallbackIdempotencyKey(body) {
  const bucket = Math.floor(Date.now() / 1000);
  const json = JSON.stringify(body || {});
  return crypto.createHash('sha1').update(`${bucket}:${json}`).digest('hex');
}

// ============================================================
// POST /api/room/:id/scan
// ============================================================
router.post('/api/room/:id/scan', async (req, res) => {
  const pairCode = String(req.params.id || '');
  const payload = req.body || {};
  const ts = Date.now();

  // 1. In-memory ring buffer (V1 behaviour, always runs as failsafe).
  const room = getRoom(pairCode);
  const memMsg = JSON.stringify({ type: 'scan', entry: payload, ts });
  // Retain under a byte budget; broadcast regardless. A message too large to
  // retain is still delivered to whoever is listening right now — dropping it
  // from the replay buffer must not drop it from the live stream.
  pushBounded(room, memMsg);
  sweepRooms();
  for (const client of room.listeners) {
    try { client.write(`data: ${memMsg}\n\n`); } catch (_) {}
  }

  // 2. Validate pair_code against Postgres + dual-write. Failsafe: if the
  //    pair_code does not exist in live_sessions OR Supabase is down,
  //    keep V1 behaviour (in-memory only) — never break the legacy path.
  let pgInserted = false;
  let pgRow = null;
  let session = null;

  if (supabase) {
    session = await lookupSession(pairCode);
    if (!session) {
      // Pair code not found in DB. Behaviour: 404 ONLY if the request
      // signals it knows about V2 (presence of idempotency_key in body
      // is the cheap V2 marker). V1 phones pushing without the field
      // get the legacy in-memory fall-through to keep back-compat alive.
      if (payload.idempotency_key) {
        return res.status(404).json({
          ok: false,
          error: 'pair_code_not_found',
          listeners: room.listeners.size,
        });
      }
      // V1 fallthrough: in-memory only, no Postgres write.
      return res.json({ ok: true, listeners: room.listeners.size, persisted: false });
    }

    const idempotencyKey = String(payload.idempotency_key || fallbackIdempotencyKey(payload));
    try {
      const result = await store.addScan({
        session_id: session.id,
        scanned_by_user_id: payload.scanned_by_user_id || null,
        card_meta: payload.entry ?? payload.card_meta ?? payload,
        pricing_snapshot: payload.pricing_snapshot ?? null,
        idempotency_key: idempotencyKey,
      });
      pgRow = result.row;
      pgInserted = result.inserted;
    } catch (e) {
      console.warn('[room] addScan failed (failsafe to memory-only):', e.message || e);
    }

    // 3. Bridge broadcast — only on a NEW insert. Replays of an existing
    //    row would double-broadcast to listeners that already saw it.
    if (pgRow && pgInserted) {
      bridge.broadcastScan(session.id, pgRow);
    }
  }

  res.json({
    ok: true,
    listeners: room.listeners.size,
    persisted: !!pgRow,
    deduped: !!pgRow && !pgInserted,
    session_id: session?.id ?? null,
  });
});

// ============================================================
// GET /api/room/:id/stream
// ============================================================
router.get('/api/room/:id/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const pairCode = String(req.params.id || '');
  const room = getRoom(pairCode);
  room.listeners.add(res);

  res.write(`data: ${JSON.stringify({ type: 'hello', roomId: pairCode, ts: Date.now() })}\n\n`);

  // V2 win: replay recent Postgres history on connect so a reconnecting
  // laptop catches up on scans that arrived during disconnect.
  let session = null;
  if (supabase) {
    session = await lookupSession(pairCode);
    if (session) {
      try {
        const recent = await store.getRecentScans(session.id, { limit: 50 });
        bridge.subscribe(session.id, res, { history: recent });
      } catch (e) {
        console.warn('[room] stream history replay failed:', e.message || e);
        bridge.subscribe(session.id, res, { history: [] });
      }
    }
  }

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    room.listeners.delete(res);
    if (session) bridge.unsubscribe(session.id, res);
  });
});

// ============================================================
// GET /api/room/:id/history
// ============================================================
router.get('/api/room/:id/history', async (req, res) => {
  const pairCode = String(req.params.id || '');

  // Prefer Postgres-backed history when available (V2 resilience win).
  if (supabase) {
    const session = await lookupSession(pairCode);
    if (session) {
      try {
        const recent = await store.getRecentScans(session.id, { limit: 50 });
        // Return newest-first to match a typical "last 50" reading order.
        const history = recent.map((row) => ({
          type: 'scan',
          entry: row.card_meta ?? row,
          ts: row.created_at,
          id: row.id,
        }));
        return res.json({ history, source: 'postgres' });
      } catch (e) {
        console.warn('[room] history Postgres read failed:', e.message || e);
        // fall through to in-memory fallback
      }
    }
  }

  // Fallback: V1 in-memory ring buffer.
  const room = getRoom(pairCode);
  res.json({
    history: room.history.slice(-HISTORY_MAX).map((s) => JSON.parse(s)),
    source: 'memory',
  });
});

// Test hook: clear in-memory state. Not exposed as a route.
export function _resetForTests() {
  rooms.clear();
  totalBytes = 0;
  for (const k of Object.keys(roomStats)) roomStats[k] = 0;
  sessionCache.clear();
  bridge.clearAll();
}

export default router;
