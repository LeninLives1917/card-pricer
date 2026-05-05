// Vendor V2 module-load smoke — A4 / Slice S7
//
// Asserts that the V2 vendor app's modules load as ES modules in Node and
// expose the documented surface. This catches:
//   - typos in import paths between modules
//   - accidental top-level fetch / DOM access that would crash on import
//   - regressions in api-client's exported convenience wrappers
//
// We can't exercise the DOM-bound behaviours here (no browser); those
// belong in tests/regression/auth-flow.spec.js (RG-01..RG-05) once that
// suite ships. This spec is the bare floor: "the modules import cleanly."

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub the few globals that some modules reach for at import time. Using
// globalThis so the assignment survives whichever module-system Node picks.
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  addEventListener() {},
  getElementById() { return null; },
  querySelectorAll() { return []; },
  querySelector() { return null; },
};
globalThis.localStorage = globalThis.localStorage || {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};
globalThis.location = globalThis.location || { search: '', href: 'http://localhost/' };
globalThis.URLSearchParams = globalThis.URLSearchParams || URLSearchParams;

const apiClient = await import('../../apps/vendor/modules/api-client.js');
const stateMod  = await import('../../apps/vendor/modules/state.js');
const bulkMod   = await import('../../apps/vendor/modules/bulk.js');
const pairMod   = await import('../../apps/vendor/modules/pair.js');
const correctMod = await import('../../apps/vendor/modules/correct.js');

test('api-client exports the documented HTTP surface', () => {
  assert.equal(typeof apiClient.request, 'function', 'request() core');
  assert.equal(typeof apiClient.getJson, 'function', 'getJson()');
  assert.equal(typeof apiClient.postJson, 'function', 'postJson()');
  assert.equal(typeof apiClient.putJson, 'function', 'putJson()');
  assert.equal(typeof apiClient.patchJson, 'function', 'patchJson()');
  assert.equal(typeof apiClient.streamNdjson, 'function', 'streamNdjson() for /api/identify-stream');
  assert.equal(typeof apiClient.uploadMultipart, 'function', 'uploadMultipart()');
  assert.equal(typeof apiClient.setHooks, 'function', 'setHooks() registers showAuthOverlay/showQuotaExceededModal/renderUsage');
  assert.equal(typeof apiClient.api, 'object', 'api convenience namespace');
  assert.equal(typeof apiClient.api.me, 'function');
  assert.equal(typeof apiClient.api.usage, 'function');
  assert.equal(typeof apiClient.api.state, 'function');
});

test('state module exposes session + sync surface', () => {
  assert.equal(typeof stateMod.state, 'object');
  assert.equal(typeof stateMod.KEYS, 'object');
  // V1 audit §3 client-side keys must be preserved verbatim.
  assert.equal(stateMod.KEYS.sessions, 'cardpricer_sessions');
  assert.equal(stateMod.KEYS.legacyLog, 'cardpricer_log');
  assert.equal(stateMod.KEYS.bulkQueue, 'cardpricer_bulk_queue_v1');
  assert.equal(stateMod.KEYS.cashPct, 'cardpricer_cashpct');
  assert.equal(stateMod.KEYS.creditPct, 'cardpricer_creditpct');
  assert.equal(stateMod.KEYS.buyPct, 'cardpricer_buypct');
  assert.equal(stateMod.KEYS.wantList, 'cardpricer_wantlist');
  assert.equal(stateMod.KEYS.settingPrefix, 'cardpricer_setting_');
  assert.equal(stateMod.KEYS.visits, 'cp_visits');
  assert.equal(stateMod.KEYS.installDismiss, 'cp_install_dismissed');
  assert.equal(typeof stateMod.initializeSessions, 'function');
  assert.equal(typeof stateMod.queueStateSync, 'function');
  assert.equal(typeof stateMod.pushStateToServer, 'function');
  assert.equal(typeof stateMod.pullStateFromServer, 'function');
  assert.equal(typeof stateMod.saveAllSessions, 'function');
  assert.equal(typeof stateMod.getSetting, 'function');
  assert.equal(typeof stateMod.setSetting, 'function');
});

test('state.initializeSessions migrates the legacy cardpricer_log on first run', () => {
  // Reset localStorage stub for this test.
  globalThis.localStorage._v = new Map();
  globalThis.localStorage.setItem('cardpricer_log', JSON.stringify([
    { card: { name: 'Pikachu', set_code: 'BST', card_number: '1' }, ts: 1 },
  ]));
  stateMod.initializeSessions();
  const ids = Object.keys(stateMod.state.sessions);
  assert.equal(ids.length, 1, 'one session created from legacy log');
  const sess = stateMod.state.sessions[ids[0]];
  assert.equal(sess.log.length, 1);
  assert.equal(sess.log[0].card.name, 'Pikachu');
});

test('bulk module exports queue + image helpers', () => {
  assert.equal(typeof bulkMod.initBulk, 'function');
  assert.equal(typeof bulkMod.handleBulkFiles, 'function');
  assert.equal(typeof bulkMod.startBulkProcess, 'function');
  assert.equal(typeof bulkMod.retryBulkFailed, 'function');
  assert.equal(typeof bulkMod.removeBulkItem, 'function');
  assert.equal(typeof bulkMod.clearBulkQueue, 'function');
  assert.equal(typeof bulkMod.saveBulkQueue, 'function');
  assert.equal(typeof bulkMod.loadBulkQueue, 'function');
  assert.equal(typeof bulkMod.resizeDataUrl, 'function', 'resizeDataUrl helper exposed for reuse');
  assert.equal(typeof bulkMod.bulkStatus, 'function');
});

test('pair module exports host + scanner-mode surface', () => {
  assert.equal(typeof pairMod.startHosting, 'function');
  assert.equal(typeof pairMod.stopPairing, 'function');
  assert.equal(typeof pairMod.joinAsScanner, 'function');
  assert.equal(typeof pairMod.uploadRawScanToRoom, 'function');
  assert.equal(typeof pairMod.randomRoomId, 'function');
  assert.equal(typeof pairMod.setOnScanReceived, 'function');
  // randomRoomId returns 6-char base-36 (audit §4 — secret-by-obscurity).
  const id = pairMod.randomRoomId();
  assert.equal(typeof id, 'string');
  assert.match(id, /^[A-Z0-9]{6}$/);
});

test('correct module exports modal surface', () => {
  assert.equal(typeof correctMod.openCorrectModal, 'function');
  assert.equal(typeof correctMod.closeCorrectModal, 'function');
  assert.equal(typeof correctMod.wireCorrectModal, 'function');
});

test('api-client setHooks registers the three V1 fetch-wrapper behaviours', () => {
  // Just smoke-test that setHooks accepts the expected shape without throwing.
  apiClient.setHooks({
    showAuthOverlay: () => {},
    showQuotaExceededModal: () => {},
    renderUsage: () => {},
  });
  apiClient.setHooks(null);   // null-safe
  apiClient.setHooks();       // arity-safe
});
