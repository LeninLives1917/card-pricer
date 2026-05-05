// db/live-sessions/sse-bridge.js
// Owner: A1 + A3 | Slice: S11 (F15)
//
// Bridges Postgres-backed live_session_scans into the in-memory SSE
// listener model V1 used. The bridge does NOT poll Postgres — broadcasts
// happen in-process from the route handler (single Node instance, same
// process receives the scan POST and dispatches to listeners). For a
// future multi-instance deploy, swap to Postgres NOTIFY/LISTEN — out of
// scope today (see V2_ARCHITECTURE §1, F15).
//
// Public surface:
//   - subscribe(sessionId, res, { history })  → registers an SSE client
//     and immediately replays `history` (an array of scan rows) to it
//     so a re-connecting laptop sees scans that arrived during disconnect.
//   - unsubscribe(sessionId, res)             → drops a client
//   - broadcastScan(sessionId, scanRow)       → fans out to listeners
//   - listenerCount(sessionId)                → diagnostic
//   - clearAll()                              → test helper
//
// 25-second keep-alive ping is V1 behaviour (server.js:5152). Each SSE
// route handler manages its own ping interval — the bridge just tracks
// listeners and dispatches.

const sessions = new Map(); // Map<sessionId, Set<res>>

function getSet(sessionId) {
  let set = sessions.get(sessionId);
  if (!set) {
    set = new Set();
    sessions.set(sessionId, set);
  }
  return set;
}

/**
 * Register an SSE response stream for a session. Optionally replays a
 * history array to the new subscriber (typically the recent scan rows
 * from Postgres, oldest-first).
 *
 * @param {string} sessionId
 * @param {object} res — express response with headers already flushed
 * @param {object} [opts]
 * @param {Array<object>} [opts.history=[]] — scan rows to replay
 */
export function subscribe(sessionId, res, { history = [] } = {}) {
  if (!sessionId || !res) return;
  const set = getSet(sessionId);
  set.add(res);

  // Replay history oldest-first so the client log reads naturally.
  if (Array.isArray(history) && history.length > 0) {
    const ordered = [...history].sort((a, b) => {
      const ta = new Date(a?.created_at || 0).getTime();
      const tb = new Date(b?.created_at || 0).getTime();
      return ta - tb;
    });
    for (const row of ordered) {
      try {
        const msg = JSON.stringify({ type: 'scan', entry: row?.card_meta ?? row, ts: row?.created_at, replay: true });
        res.write(`data: ${msg}\n\n`);
      } catch (e) {
        // res may be closed mid-replay; let unsubscribe handle it.
      }
    }
  }
}

/**
 * Drop an SSE listener.
 *
 * @param {string} sessionId
 * @param {object} res
 */
export function unsubscribe(sessionId, res) {
  if (!sessionId || !res) return;
  const set = sessions.get(sessionId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sessions.delete(sessionId);
}

/**
 * Fan a scan row out to every SSE client subscribed to a session.
 *
 * @param {string} sessionId
 * @param {object} scanRow — typically the live_session_scans row from addScan
 */
export function broadcastScan(sessionId, scanRow) {
  if (!sessionId || !scanRow) return;
  const set = sessions.get(sessionId);
  if (!set || set.size === 0) return;

  const msg = JSON.stringify({
    type: 'scan',
    entry: scanRow.card_meta ?? scanRow,
    ts: scanRow.created_at || new Date().toISOString(),
    id: scanRow.id,
  });
  const payload = `data: ${msg}\n\n`;

  for (const res of set) {
    try {
      res.write(payload);
    } catch (e) {
      // Drop dead connections silently — express will fire 'close' anyway.
    }
  }
}

/**
 * @param {string} sessionId
 * @returns {number}
 */
export function listenerCount(sessionId) {
  const set = sessions.get(sessionId);
  return set ? set.size : 0;
}

/** Test helper. Drop every tracked listener set. */
export function clearAll() {
  sessions.clear();
}
