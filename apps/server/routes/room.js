// apps/server/routes/room.js
// Owner: A1 | Slice: S5
//
// Routes (V1 server.js:5128-5172):
//   POST /api/room/:id/scan     — public; phone pushes a scanned card to the room
//   GET  /api/room/:id/stream   — public SSE; laptop subscribes for live phone scans
//   GET  /api/room/:id/history  — public; last 50 history entries
//
// V2_AUDIT §5.14: scanner-mode (?pair=ROOMID) bypasses auth entirely; the
// room ID is secret-by-obscurity (~10⁹ space), not authenticated. S11
// adopts the live_sessions Postgres table; for S5 the in-memory `rooms`
// Map is preserved verbatim.

import express from 'express';

const router = express.Router();

// In-memory rooms: { roomId: { listeners: Set<res>, history: Array<msgString> } }
const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { listeners: new Set(), history: [] });
  return rooms.get(id);
}

router.post('/api/room/:id/scan', (req, res) => {
  const room = getRoom(req.params.id);
  const payload = req.body || {};
  const msg = JSON.stringify({ type: 'scan', entry: payload, ts: Date.now() });
  room.history.push(msg);
  if (room.history.length > 500) room.history.shift();
  for (const client of room.listeners) {
    try { client.write(`data: ${msg}\n\n`); } catch (e) {}
  }
  res.json({ ok: true, listeners: room.listeners.size });
});

router.get('/api/room/:id/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const room = getRoom(req.params.id);
  room.listeners.add(res);
  res.write(`data: ${JSON.stringify({ type: 'hello', roomId: req.params.id, ts: Date.now() })}\n\n`);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    room.listeners.delete(res);
  });
});

router.get('/api/room/:id/history', (req, res) => {
  const room = getRoom(req.params.id);
  res.json({ history: room.history.slice(-50).map(s => JSON.parse(s)) });
});

export default router;
