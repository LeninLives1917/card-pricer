// Widget V1 ↔ V2 parity — A6 / Slice S9
//
// Static structural lint. We assert invariants both files MUST share, plus
// V2-specific additions, without spinning up a DOM. A full runtime DOM diff
// (jsdom-based) is S23's deliverable — this spec is the cheap-but-effective
// guard that catches structural regressions in PR review (e.g. the V2 file
// dropping its origin check, or the V1 backup drifting from the live file).
//
// Reads the widget files as text via fs.readFileSync — both are vanilla
// non-module JS, so node:test has no business loading them. We only lint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const V1_PATH = resolve(REPO_ROOT, 'apps/widget/widget-v1.js');
const V2_PATH = resolve(REPO_ROOT, 'apps/widget/widget.js');
const LIVE_PATH = resolve(REPO_ROOT, 'public/widget.js');

const v1 = readFileSync(V1_PATH, 'utf8');
const v2 = readFileSync(V2_PATH, 'utf8');
const live = readFileSync(LIVE_PATH, 'utf8');

// ── Shared invariants (both files MUST satisfy) ─────────────────────────

test('both widget files are IIFEs', () => {
  // Tolerate leading comments + whitespace; the first non-comment statement
  // must be an IIFE.
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /\(\s*function\s*\(\s*\)\s*\{[\s\S]*\}\s*\)\s*\(\s*\)\s*;\s*$/, `${name} must end with an invoked function expression`);
  }
});

test('both widget files use strict mode', () => {
  assert.match(v1, /['"]use strict['"]/, 'V1 must declare "use strict"');
  assert.match(v2, /['"]use strict['"]/, 'V2 must declare "use strict"');
});

test('both widget files derive origin from their script src', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /new\s+URL\s*\(\s*script\.src\s*\)\.origin/, `${name} must derive origin from script.src`);
  }
});

test('both widget files use document.currentScript with a fallback scan', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /document\.currentScript/, `${name} must use document.currentScript`);
    assert.match(src, /getElementsByTagName\(['"]script['"]\)/, `${name} must have a fallback script-tag scan`);
  }
});

test('both widget files inject the all:revert defence', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    // Should appear at least 3 times: button + modal backdrop + close button.
    const matches = src.match(/all:\s*revert/g) || [];
    assert.ok(matches.length >= 3, `${name} must use all: revert on button, modal, and close (got ${matches.length})`);
  }
});

test('both widget files use the canonical max-int32 z-indexes', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /2147483647/, `${name} must use 2147483647 for the modal z-index`);
    assert.match(src, /2147483646/, `${name} must use 2147483646 for the floating-button z-index`);
  }
});

test('both widget files install an origin-checked postMessage receiver', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /addEventListener\(\s*['"]message['"]/, `${name} must listen for 'message' events`);
    assert.match(src, /e\.origin\s*!==\s*origin/, `${name} must reject messages from other origins`);
    assert.match(src, /cp:close/, `${name} must handle cp:close`);
    assert.match(src, /cp:submitted/, `${name} must handle cp:submitted`);
  }
});

test('both widget files honour V1 attribute defaults', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /['"]#b45309['"]/, `${name} must default data-color to #b45309`);
    assert.match(src, /Get a quote on your cards/, `${name} must default data-label to V1 string`);
    assert.match(src, /['"]inline['"]/, `${name} must reference 'inline' position`);
    assert.match(src, /['"]floating['"]/, `${name} must reference 'floating' position`);
  }
});

test('both widget files build the iframe URL with embed=1 and shop slug', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /\/quote/, `${name} must point the iframe at /quote`);
    assert.match(src, /embed=1/, `${name} iframe URL must include embed=1`);
    assert.match(src, /encodeURIComponent\(\s*shop\s*\)/, `${name} must URL-encode the shop slug`);
  }
});

test('both widget files toggle documentElement.style.overflow on open/close', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /documentElement\.style\.overflow\s*=\s*['"]hidden['"]/, `${name} must lock body scroll on open`);
    assert.match(src, /documentElement\.style\.overflow\s*=\s*['"]['"]/, `${name} must restore overflow on close`);
  }
});

test('both widget files preserve the V1 cardPricerWidgetOnSubmit contract', () => {
  for (const [name, src] of [['v1', v1], ['v2', v2]]) {
    assert.match(src, /cardPricerWidgetOnSubmit/, `${name} must call window.cardPricerWidgetOnSubmit on submit`);
  }
});

// ── V1-specific invariants ──────────────────────────────────────────────

test('widget-v1.js carries the rollback-target header', () => {
  assert.match(v1, /ROLLBACK TARGET — DO NOT MODIFY/, 'V1 backup must be marked as a rollback target');
});

test('widget-v1.js content matches public/widget.js byte-for-byte modulo top header', () => {
  // Strip our added top-comment line from the v1 backup; the remainder MUST
  // equal the live file. This is the "verbatim copy" contract.
  const v1WithoutHeader = v1.replace(/^\/\/ ROLLBACK TARGET[^\n]*\n/, '');
  assert.equal(
    v1WithoutHeader,
    live,
    'apps/widget/widget-v1.js content (after stripping the rollback header) must equal public/widget.js byte-for-byte',
  );
});

// ── V2-specific invariants ──────────────────────────────────────────────

test('widget.js (V2) parses the V2-NEW attribute set', () => {
  assert.match(v2, /data-theme/, 'V2 must read data-theme');
  assert.match(v2, /data-button-shape/, 'V2 must read data-button-shape');
  assert.match(v2, /data-modal-size/, 'V2 must read data-modal-size');
  assert.match(v2, /data-event-callback/, 'V2 must read data-event-callback');
  assert.match(v2, /data-locale/, 'V2 must read data-locale');
  assert.match(v2, /data-lazy/, 'V2 must read data-lazy');
});

test('widget.js (V2) defines theme tokens for dark + light', () => {
  assert.match(v2, /THEMES\s*=\s*\{/, 'V2 must export a THEMES map');
  // Dark theme MUST keep V1 bytes for parity.
  assert.match(v2, /['"]#0c0a09['"]/, 'V2 dark theme bg must equal V1 #0c0a09');
  // Light theme MUST exist.
  assert.match(v2, /['"]#fafaf9['"]/, 'V2 light theme bg must be #fafaf9');
});

test('widget.js (V2) emits the telemetry beacon on init', () => {
  assert.match(v2, /\/api\/widget\/loaded/, 'V2 must POST to /api/widget/loaded');
  assert.match(v2, /version:\s*['"]v2['"]/, 'V2 beacon must declare version: "v2"');
  assert.match(v2, /sendBeacon/, 'V2 must prefer navigator.sendBeacon');
  assert.match(v2, /keepalive/, 'V2 must use fetch keepalive as fallback');
});

test('widget.js (V2) is a single-fire beacon (guard variable present)', () => {
  assert.match(v2, /beaconFired/, 'V2 must guard the beacon with a closure flag');
});

test('widget.js (V2) URL-builds with theme/locale only when non-default (V1 parity)', () => {
  // V2 parity URL MUST be byte-identical to V1's "?embed=1&shop=<slug>".
  // We assert this structurally: theme appended only when resolvedTheme !== 'dark'.
  assert.match(v2, /resolvedTheme\s*!==\s*['"]dark['"]/, 'V2 must skip theme query param when dark (V1 parity)');
  assert.match(v2, /locale\s*!==\s*['"]en['"]/, 'V2 must skip locale query param when en (V1 parity)');
});

test('widget.js (V2) calls a data-event-callback target if present', () => {
  // The named-callback dispatch sits alongside the V1 callback.
  assert.match(v2, /window\[\s*eventCallback\s*\]/, 'V2 must dispatch to window[<eventCallback>] when set');
});

// ── Sanity: file sizes are within the documented budget ────────────────

test('widget-v1.js stays small (within V1 LOC budget)', () => {
  const lines = v1.split('\n').length;
  assert.ok(lines < 220, `V1 backup grew to ${lines} lines — expected <220 (V1 was 195)`);
});

test('widget.js (V2) stays within the documented budget (~350-450 LOC)', () => {
  const lines = v2.split('\n').length;
  assert.ok(lines >= 250, `V2 widget shrunk to ${lines} lines — expected ≥250`);
  assert.ok(lines <= 600, `V2 widget grew to ${lines} lines — expected ≤600 (budget 350-450 + comment overhead)`);
});
