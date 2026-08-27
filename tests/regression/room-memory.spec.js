// tests/regression/room-memory.spec.js
//
// INCIDENT, 27 Aug 2026 — Render OOM-killed the instance and restarted it.
//
// apps/server/routes/room.js kept 500 messages per room and every message
// carries the FULL base64 image. It was bounded by COUNT, and a count bound on
// variable-size items is not a bound: it constrains a number that has nothing
// to do with the resource being spent.
//
//     ~470 KB per scan (1600px preview grab)  x500 = 235 MB per room
//     ~5 MB per scan   (full-sensor still)    x500 = 2.5 GB per room
//
// 235 MB on top of ~136 MB of resident catalogue is most of a 512 MB Starter,
// so one operator working a box was enough. The full-sensor still shipped
// hours before the alert made it ten times worse, and would have exceeded a
// 2 GB Standard on a single room — which is why upgrading the instance was
// not the fix.
//
// Two more faults in the same six lines: only the last 50 were ever served, so
// 450 of the 500 were unreachable by any code path; and rooms were never
// evicted, because rooms.clear() is a test-only hook.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { pushBounded, sweepRooms, roomMemoryStats, _getRoom, _resetForTests }
  from '../../apps/server/routes/room.js';

const room = () => ({ listeners: new Set(), history: [], bytes: 0, seenAt: Date.now() });
/** A message of roughly n bytes, the shape a base64 image arrives in. */
const msg = (n) => JSON.stringify({ type: 'scan', entry: { image: 'x'.repeat(n) } });

beforeEach(() => _resetForTests());

describe('the replay buffer is bounded by BYTES, not by a count', () => {
  test('500 large scans do not grow without limit', () => {
    // The exact shape of the incident: the old code accepted all of these.
    const r = room();
    for (let i = 0; i < 500; i++) pushBounded(r, msg(500 * 1024));
    assert.ok(r.bytes <= 12 * 1024 * 1024, `retained ${(r.bytes / 1048576).toFixed(0)} MB`);
  });

  test('a bigger image does not mean a bigger buffer', () => {
    // This is the property a count bound cannot have, and the reason a
    // ten-times-larger payload turned a working service into an OOM.
    const small = room(); for (let i = 0; i < 200; i++) pushBounded(small, msg(100 * 1024));
    const large = room(); for (let i = 0; i < 200; i++) pushBounded(large, msg(5 * 1024 * 1024));
    assert.ok(large.bytes <= 12 * 1024 * 1024);
    assert.ok(small.bytes <= 12 * 1024 * 1024);
  });

  test('it never retains more than it can serve', () => {
    // 450 of the old 500 were unreachable by any code path. That was not a
    // tradeoff, it was 90% of the memory spent on nothing.
    const r = room();
    for (let i = 0; i < 300; i++) pushBounded(r, msg(1024));
    assert.ok(r.history.length <= 50, `retained ${r.history.length}, serves 50`);
  });

  test('the newest entries are the ones kept', () => {
    const r = room();
    for (let i = 0; i < 80; i++) pushBounded(r, JSON.stringify({ i }));
    const kept = r.history.map((s) => JSON.parse(s).i);
    assert.equal(kept[kept.length - 1], 79);
    assert.ok(kept[0] > 0, 'the oldest must have been dropped');
  });

  test('a single message larger than the whole budget is dropped, not admitted', () => {
    // Admitting it would evict every other entry to make room for one item
    // nothing asked for.
    const r = room();
    for (let i = 0; i < 10; i++) pushBounded(r, msg(64 * 1024));
    const before = r.history.length;
    assert.equal(pushBounded(r, msg(20 * 1024 * 1024)), 'dropped_oversize');
    assert.equal(r.history.length, before, 'the existing history must survive');
    assert.equal(roomMemoryStats().dropped_oversize, 1, 'and the drop must be counted');
  });

  test('bytes are accounted on the way out as well as in', () => {
    // A counter that only increments turns the budget into a slow leak.
    const r = room();
    for (let i = 0; i < 400; i++) pushBounded(r, msg(64 * 1024));
    const summed = r.history.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);
    assert.equal(r.bytes, summed, 'tracked bytes must equal retained bytes');
  });
});

describe('rooms are evicted', () => {
  const seed = (id, n = 20, size = 64 * 1024) => {
    const r = _getRoom(id);
    for (let i = 0; i < n; i++) pushBounded(r, msg(size));
    return r;
  };

  test('an idle room with nobody listening is dropped', () => {
    // Every pair code ever used kept its buffer for the life of the process,
    // because rooms.clear() is a test-only hook.
    seed('ABCD');
    assert.equal(roomMemoryStats().rooms, 1);
    sweepRooms({ now: Date.now() + 31 * 60 * 1000 });
    assert.equal(roomMemoryStats().rooms, 0);
    assert.equal(roomMemoryStats().evicted_idle, 1);
    assert.equal(roomMemoryStats().bytes, 0, 'the global tally must come back down too');
  });

  test('a room someone is watching survives being idle', () => {
    // A laptop can sit on the stream between customers without the room it is
    // watching being swept out from under it.
    const r = seed('WXYZ');
    r.listeners.add({ write() {} });
    sweepRooms({ now: Date.now() + 31 * 60 * 1000 });
    assert.equal(roomMemoryStats().rooms, 1);
  });

  test('a fresh room is not swept', () => {
    seed('FRSH');
    sweepRooms({ now: Date.now() });
    assert.equal(roomMemoryStats().rooms, 1);
  });

  test('under global pressure the oldest rooms go, oldest first', () => {
    // The per-room cap alone bounds nothing: enough rooms at the cap still
    // exhausts the process.
    for (let i = 0; i < 12; i++) {
      const r = _getRoom('R' + i);
      r.seenAt = 1000 + i;
      for (let j = 0; j < 40; j++) pushBounded(r, msg(300 * 1024));
    }
    const before = roomMemoryStats();
    assert.ok(before.bytes > 64 * 1024 * 1024, `only ${(before.bytes / 1048576).toFixed(0)} MB — raise the fixture`);
    sweepRooms({ now: 2000, idleMs: 60_000 });
    const after = roomMemoryStats();
    assert.ok(after.bytes <= 64 * 1024 * 1024, `still ${(after.bytes / 1048576).toFixed(0)} MB`);
    assert.ok(after.evicted_pressure > 0);
    assert.equal(rooms0Present(), false, 'the oldest room should be the first to go');
  });

  function rooms0Present() {
    // _getRoom would recreate it, so probe the tally instead: if R0 survived,
    // a newer room was evicted in its place.
    const before = roomMemoryStats().rooms;
    _getRoom('R0');
    const recreated = roomMemoryStats().rooms > before;
    return !recreated;
  }

  test('the sweep reports what it holds', () => {
    const s = roomMemoryStats();
    for (const k of ['evicted_idle', 'evicted_pressure', 'dropped_oversize', 'trimmed', 'rooms', 'bytes']) {
      assert.ok(k in s, `${k} must be visible — an unbounded buffer nobody measures is how this happened`);
    }
  });
});
