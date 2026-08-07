// tests/regression/pair-scan-envelope.spec.js
//
// INCIDENT: a phone paired via ?pair=ROOMID displayed "Sent." for every
// card while nothing at all appeared on the host laptop. The phone was
// right — POST /api/room/:id/scan returned {ok:true}. The loss was on the
// host: both server producers wrap the phone's body in
// { type:'scan', entry:<body>, ts }, and the host handler read
// `payload.image` rather than `payload.entry.image`, found undefined, and
// returned silently. Nothing counted the dropped frame.
//
// These tests pin BOTH ends of that contract:
//   - the client unwrap accepts the exact envelope the server emits;
//   - the server still emits `entry` (source-level, so a rename on the
//     server side fails here instead of at a card show).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { unwrapScanFrame, FRAME_ACTIONS } from '../../apps/vendor/modules/pair-frame.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

// Built exactly as apps/server/routes/room.js does:
//   const memMsg = JSON.stringify({ type: 'scan', entry: payload, ts });
// where payload is the phone's body from pair.js uploadRawScanToRoom:
//   { image: imageData, ts: Date.now() }
function serverEnvelope(body, extra = {}) {
  return JSON.parse(JSON.stringify({ type: 'scan', entry: body, ts: 1700000000000, ...extra }));
}

test('the exact server envelope delivers the phone image (the bug)', () => {
  const frame = serverEnvelope({ image: IMAGE, ts: 1700000000000 });
  const out = unwrapScanFrame(frame, new Set());

  assert.equal(out.action, FRAME_ACTIONS.DELIVER);
  assert.equal(out.entry.image, IMAGE,
    'host must read the image from .entry — reading it off the envelope root is the defect');
});

test('reading .image off the envelope root yields undefined — the original failure', () => {
  // Pins WHY the bug existed, so nobody "simplifies" the unwrap back.
  const frame = serverEnvelope({ image: IMAGE, ts: 1 });
  assert.equal(frame.image, undefined);
  assert.equal(frame.entry.image, IMAGE);
});

test("the 'hello' frame sent on every connect is ignored, not dropped", () => {
  const out = unwrapScanFrame({ type: 'hello', roomId: 'ABC123', ts: 1 }, new Set());
  assert.equal(out.action, FRAME_ACTIONS.IGNORE,
    'hello is normal protocol traffic; counting it as a drop would bury real drops');
});

test('a scan frame with no image is DROPPED with a reason, never delivered', () => {
  const out = unwrapScanFrame(serverEnvelope({ ts: 1 }), new Set());
  assert.equal(out.action, FRAME_ACTIONS.DROP);
  assert.equal(out.reason, 'no_image');
  assert.equal(out.entry, undefined);
});

test('a bare (unwrapped) body still delivers — tolerant of a future producer', () => {
  const out = unwrapScanFrame({ image: IMAGE }, new Set());
  assert.equal(out.action, FRAME_ACTIONS.DELIVER);
  assert.equal(out.entry.image, IMAGE);
});

test('an id seen twice is deduped — bridge replay must not re-price a backlog', () => {
  // sse-bridge.subscribe() replays up to 50 rows on EVERY reconnect, and
  // room.js broadcasts to the in-memory listener set and the bridge set,
  // which are the same response object. Both routes produce duplicates.
  const seen = new Set();
  const first = unwrapScanFrame(serverEnvelope({ image: IMAGE }, { id: 'row-1' }), seen);
  const second = unwrapScanFrame(serverEnvelope({ image: IMAGE }, { id: 'row-1' }), seen);

  assert.equal(first.action, FRAME_ACTIONS.DELIVER);
  assert.equal(second.action, FRAME_ACTIONS.DEDUPE);
});

test('frames without an id are not deduped against each other', () => {
  // The in-memory failsafe path carries no id. Two genuine scans of the
  // same card must both reach the laptop.
  const seen = new Set();
  const a = unwrapScanFrame(serverEnvelope({ image: IMAGE }), seen);
  const b = unwrapScanFrame(serverEnvelope({ image: IMAGE }), seen);
  assert.equal(a.action, FRAME_ACTIONS.DELIVER);
  assert.equal(b.action, FRAME_ACTIONS.DELIVER);
});

test('garbage frames drop rather than throw', () => {
  for (const bad of [null, undefined, 'string', 42]) {
    assert.equal(unwrapScanFrame(bad, new Set()).action, FRAME_ACTIONS.DROP);
  }
});

// ── Source-level: the server must keep emitting `entry` ──────────────

test('room.js still wraps the phone body in an `entry` field', () => {
  const src = fs.readFileSync(join(REPO_ROOT, 'apps/server/routes/room.js'), 'utf8');
  assert.match(src, /type:\s*'scan',\s*entry:/,
    'room.js changed its broadcast shape — update pair-frame.js to match');
});

test('sse-bridge.js still wraps rows in an `entry` field', () => {
  const src = fs.readFileSync(join(REPO_ROOT, 'db/live-sessions/sse-bridge.js'), 'utf8');
  const scanFrames = src.match(/type:\s*'scan'[^}]*/g) || [];
  assert.ok(scanFrames.length >= 2, 'expected both broadcastScan and the replay frame');
  for (const f of scanFrames) {
    assert.match(f, /entry:/, 'a scan frame stopped carrying `entry`');
  }
});

// ── Source-level: module JS must never be served stale ───────────────

test('service worker serves /modules/*.js network-first, not stale-while-revalidate', () => {
  // INCIDENT (twice). v2.1: the customer-PDF button did nothing because
  // clients held a cached pre-PDF session.js. v3.1: a paired phone held a
  // cached scan.js + pair.js, so a deployed fix did not run and the correct
  // fix looked broken. Bumping CACHE_VERSION does not cover the first load
  // after a deploy, because the bump only applies once the new worker has
  // activated. Logic must come from the network with cache as FALLBACK.
  const src = fs.readFileSync(join(REPO_ROOT, 'apps/vendor/service-worker.js'), 'utf8');

  assert.match(src, /isModule/,
    'the SW must special-case module JS');
  assert.match(src, /url\.pathname\.startsWith\('\/modules\/'\)/,
    'the module branch must match the /modules/ prefix');

  // The module branch must appear BEFORE the stale-while-revalidate block,
  // otherwise the generic handler swallows it first.
  const moduleIdx = src.indexOf('isModule');
  const swrIdx = src.indexOf('stale-while-revalidate', moduleIdx);
  const genericIdx = src.lastIndexOf('cache.match(request)');
  assert.ok(moduleIdx > 0 && moduleIdx < genericIdx,
    'the module branch must be evaluated before the generic asset handler');
  assert.ok(swrIdx === -1 || swrIdx > moduleIdx,
    'modules must not fall into the stale-while-revalidate path');
});

test('a newly activated worker tells open clients, so a deploy lands in one load', () => {
  const sw = fs.readFileSync(join(REPO_ROOT, 'apps/vendor/service-worker.js'), 'utf8');
  const pwa = fs.readFileSync(join(REPO_ROOT, 'apps/vendor/modules/pwa.js'), 'utf8');

  assert.match(sw, /sw-activated/, 'activate must notify clients');
  assert.match(pwa, /sw-activated/, 'the app must listen for it');
  assert.match(pwa, /sessionStorage/,
    'the reload must be guarded against looping — a looping scanner at a show ' +
    'is worse than a stale one');
});

// ── Source-level: scanner-mode must not regress to the OS camera ─────

test('scanner-mode uses a live viewfinder, not the OS camera app, as its primary path', () => {
  // `<input capture>` hands off to the native camera, which forces a
  // confirm screen and a cold restart per card — roughly 3-5s and two taps
  // that the operator cannot skip. It survives only as a fallback.
  const src = fs.readFileSync(join(REPO_ROOT, 'apps/vendor/modules/tabs/scan.js'), 'utf8');
  assert.match(src, /capture\.js/, 'scanner-mode should load the live-camera module');
  assert.match(src, /scannerFallback/,
    'the file-input path must remain reachable as a named fallback');
});
