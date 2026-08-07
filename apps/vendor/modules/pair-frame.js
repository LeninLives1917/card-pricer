// apps/vendor/modules/pair-frame.js
//
// The wire contract between /api/room/:id/stream and the host laptop, as a
// pure function with no DOM and no imports — so `node --test` can pin it.
//
// INCIDENT (this file's reason to exist): scanner-mode phones reported
// "Sent." for every card while nothing whatsoever appeared on the paired
// laptop. Both server producers — the in-memory broadcast in
// apps/server/routes/room.js and sse-bridge.broadcastScan — wrap the
// phone's POST body in an envelope:
//
//     { type: 'scan', entry: <phone body>, ts, id?, replay? }
//
// ...but the host handler read `payload.image`, which lives at
// `payload.entry.image`. It found undefined and returned silently. The
// phone's POST really had succeeded, so the phone was telling the truth;
// the laptop dropped the frame on the floor and counted nothing. Textbook
// silent degradation per CLAUDE.md.

export const FRAME_ACTIONS = Object.freeze({
  DELIVER: 'deliver',
  IGNORE: 'ignore',
  DEDUPE: 'dedupe',
  DROP: 'drop',
});

/**
 * Decide what the host should do with one parsed SSE frame.
 *
 * @param {object} msg    parsed JSON from the SSE `data:` line
 * @param {Set}   [seen]  ids already processed; mutated when an id is present
 * @returns {{action: string, entry?: object, reason?: string}}
 */
export function unwrapScanFrame(msg, seen) {
  if (!msg || typeof msg !== 'object') {
    return { action: FRAME_ACTIONS.DROP, reason: 'not_an_object' };
  }

  // 'hello' is sent on every connect; control frames are not failures.
  if (msg.type && msg.type !== 'scan') {
    return { action: FRAME_ACTIONS.IGNORE, reason: msg.type };
  }

  // Two independent duplicate sources: room.js writes the in-memory copy AND
  // the Postgres bridge copy to the same response stream, and
  // sse-bridge.subscribe() replays up to 50 rows on every reconnect. Without
  // this, one flaky connection re-prices the entire backlog.
  if (msg.id != null && seen) {
    if (seen.has(msg.id)) return { action: FRAME_ACTIONS.DEDUPE, reason: 'already_seen' };
    seen.add(msg.id);
  }

  // Accept the envelope; tolerate a bare body so a future producer that
  // forwards unwrapped cannot silently regress deliveries to zero.
  const entry = msg.entry ?? msg;
  if (!entry || typeof entry !== 'object') {
    return { action: FRAME_ACTIONS.DROP, reason: 'no_entry' };
  }
  if (!entry.image) {
    return { action: FRAME_ACTIONS.DROP, reason: 'no_image' };
  }

  return { action: FRAME_ACTIONS.DELIVER, entry };
}
