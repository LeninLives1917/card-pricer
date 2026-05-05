// Widget V1 ↔ V2 runtime DOM-diff parity — A6 + A7 / Slice S23
//
// Sibling spec to widget-parity.spec.js. The parity spec is a fast static-text
// lint; this spec spins up a real DOM via jsdom and asserts that the rendered
// nodes match between V1 and V2 on the V1-attribute path. It also exercises
// the V2-NEW additive features (themes, shapes, modal sizes, named callback,
// locale, telemetry beacon) and the postMessage origin gate.
//
// Why jsdom: the widget is hand-written vanilla JS that runs in a browser.
// Loading it via jsdom + window.eval gives us a real Window/Document so we
// can read getComputedStyle (post-inline-style) the same way a browser would.
// Pure text grep (S9) catches structural drift but cannot verify "given V1
// attributes, V2 produces an identical-looking button" — which is the heart
// of the V1-attribute parity contract (RG-41).
//
// Setup notes:
//   * runScripts: 'outside-only' permits window.eval but not <script> tags
//     fetching network resources — exactly what we want (we hand-execute the
//     widget source from disk).
//   * pretendToBeVisual: true + the 50ms readyState bump are needed because
//     V1 + V2 mount their button on DOMContentLoaded; jsdom transitions out of
//     'loading' on the next tick. Driving everything off a single setTimeout
//     keeps the harness simple.
//   * The widget reads document.currentScript on top-level execution. Under
//     window.eval that returns null, so the widget falls back to scanning all
//     <script> tags for one whose src includes '/widget.js'. We pre-inject
//     that exact <script> tag so the fallback finds it.
//   * navigator.sendBeacon is replaced with a spy. The widget passes a Blob
//     containing the JSON payload; jsdom 25's Blob lacks .text() so we read
//     the raw bytes via the internal Symbol(impl)._buffer (stable across
//     jsdom 22-25). If that ever breaks, fall back to wrapping window.Blob.
//
// Test command: npm test -- tests/regression/widget-runtime.spec.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const WIDGET_DIR = resolve(REPO_ROOT, 'apps/widget');

const V1_SRC = readFileSync(resolve(WIDGET_DIR, 'widget-v1.js'), 'utf8');
const V2_SRC = readFileSync(resolve(WIDGET_DIR, 'widget.js'), 'utf8');

const HOST_ORIGIN = 'https://card-pricer.test';

// ── Setup helper ────────────────────────────────────────────────────────────
//
// Loads the requested widget file inside a fresh jsdom Window with the given
// attributes on the script tag. Returns { window, document, beaconCalls }
// where beaconCalls is an array of { url, payload } captured from the
// navigator.sendBeacon spy.
async function loadWidget(file, attrs = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: HOST_ORIGIN + '/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // Wait one tick for jsdom to leave readyState='loading' so the V1/V2
  // DOMContentLoaded mount path fires synchronously after eval.
  await new Promise((r) => setTimeout(r, 0));

  const beaconCalls = [];
  window.navigator.sendBeacon = function (url, body) {
    let payload = null;
    try {
      // jsdom Blob exposes its raw bytes through Symbol(impl)._buffer.
      const implSym = Object.getOwnPropertySymbols(body || {}).find(
        (s) => s.toString() === 'Symbol(impl)',
      );
      if (implSym && body[implSym] && body[implSym]._buffer) {
        payload = body[implSym]._buffer.toString('utf8');
      } else if (typeof body === 'string') {
        payload = body;
      }
    } catch (_) { /* swallow */ }
    beaconCalls.push({ url, body, payload });
    return true;
  };

  // Pre-inject the script tag with the right src + attrs so the widget's
  // fallback "find a script tag with src includes /widget.js" can locate it.
  const sc = window.document.createElement('script');
  sc.src = HOST_ORIGIN + '/widget.js';
  for (const [k, v] of Object.entries(attrs)) sc.setAttribute(k, v);
  window.document.body.appendChild(sc);

  const src = file === 'widget-v1.js' ? V1_SRC : V2_SRC;
  window.eval(src);

  return { dom, window, document: window.document, beaconCalls };
}

// Computed-style properties we hold V1 and V2 to. RGB serialisation is what
// jsdom returns; if a future jsdom upgrade swaps to hex these keys still
// match each other byte-for-byte across the two windows.
const PARITY_PROPS = [
  'background-color',
  'color',
  'padding',
  'border-radius',
  'font-size',
  'font-weight',
  'letter-spacing',
  'display',
  'box-shadow',
];

// ── V1 baseline ─────────────────────────────────────────────────────────────

test('V1 widget injects a single button with V1 default styles', async () => {
  const { document, window, beaconCalls } = await loadWidget('widget-v1.js', {
    'data-shop': 'brewed',
  });
  const btn = document.querySelector('.cp-widget-btn');
  assert.ok(btn, 'V1 must inject .cp-widget-btn');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.textContent, 'Get a quote on your cards', 'V1 default label');
  assert.equal(btn.getAttribute('aria-haspopup'), 'dialog');
  // Inline-style assertions (the V1 fingerprint).
  const cs = window.getComputedStyle(btn);
  assert.equal(cs.getPropertyValue('background-color'), 'rgb(180, 83, 9)', 'V1 default brand colour');
  assert.equal(cs.getPropertyValue('color'), 'rgb(255, 255, 255)');
  assert.equal(cs.getPropertyValue('border-radius'), '10px', 'V1 square=10px');
  assert.equal(cs.getPropertyValue('display'), 'inline-block');
  // V1 must NOT fire the telemetry beacon — it doesn't know about it.
  assert.equal(beaconCalls.length, 0, 'V1 must never call sendBeacon');
});

test('V1 floating position pins the button to bottom-right with z-index 2147483646', async () => {
  const { document } = await loadWidget('widget-v1.js', {
    'data-shop': 'brewed',
    'data-position': 'floating',
  });
  const btn = document.querySelector('.cp-widget-btn');
  assert.equal(btn.style.position, 'fixed', 'floating mode uses position:fixed');
  assert.equal(btn.style.right, '20px');
  assert.equal(btn.style.bottom, '20px');
  assert.equal(btn.style.zIndex, '2147483646');
});

// ── V2 V1-attribute parity (the RG-41 contract) ────────────────────────────

test('V2 with V1-only attributes renders pixel-stable button vs V1', async () => {
  const v1 = await loadWidget('widget-v1.js', { 'data-shop': 'brewed' });
  const v2 = await loadWidget('widget.js', { 'data-shop': 'brewed' });
  const b1 = v1.document.querySelector('.cp-widget-btn');
  const b2 = v2.document.querySelector('.cp-widget-btn');
  assert.ok(b1 && b2, 'both widgets must inject the button');
  assert.equal(b1.textContent, b2.textContent, 'label parity');
  assert.equal(b1.className, b2.className, 'class parity');
  assert.equal(b1.getAttribute('aria-haspopup'), b2.getAttribute('aria-haspopup'));
  // V2 must NOT leak data-* attributes onto the rendered button — neither V1
  // nor V2 copies script attributes onto the DOM.
  for (const dataAttr of ['data-theme', 'data-shop', 'data-color', 'data-button-shape']) {
    assert.equal(b1.getAttribute(dataAttr), null, `V1 button must not carry ${dataAttr}`);
    assert.equal(b2.getAttribute(dataAttr), null, `V2 button must not carry ${dataAttr}`);
  }
  // Computed styles must match across the documented parity-critical props.
  const cs1 = v1.window.getComputedStyle(b1);
  const cs2 = v2.window.getComputedStyle(b2);
  for (const prop of PARITY_PROPS) {
    assert.equal(
      cs2.getPropertyValue(prop),
      cs1.getPropertyValue(prop),
      `V2 button ${prop} must equal V1 button ${prop}`,
    );
  }
});

test('V2 V1-parity iframe URL is byte-identical to V1', async () => {
  const v1 = await loadWidget('widget-v1.js', { 'data-shop': 'brewed' });
  const v2 = await loadWidget('widget.js', { 'data-shop': 'brewed' });
  v1.document.querySelector('.cp-widget-btn').click();
  v2.document.querySelector('.cp-widget-btn').click();
  const if1 = v1.document.querySelector('iframe');
  const if2 = v2.document.querySelector('iframe');
  assert.equal(if2.src, if1.src, 'V2 iframe src must equal V1 (no theme/locale params on default)');
  assert.match(if1.src, /\/quote\?embed=1&shop=brewed$/, 'V1 reference URL shape');
});

test('V2 V1-parity modal inner styles match V1', async () => {
  const v1 = await loadWidget('widget-v1.js', { 'data-shop': 'brewed' });
  const v2 = await loadWidget('widget.js', { 'data-shop': 'brewed' });
  v1.document.querySelector('.cp-widget-btn').click();
  v2.document.querySelector('.cp-widget-btn').click();
  const inner1 = v1.document.querySelector('.cp-widget-modal').children[0];
  const inner2 = v2.document.querySelector('.cp-widget-modal').children[0];
  // V1's exact min(820px,100%) / min(900px,90vh) / #0c0a09 must round-trip.
  assert.equal(inner2.style.cssText, inner1.style.cssText, 'modal inner cssText must match V1');
});

// ── V2 telemetry beacon ────────────────────────────────────────────────────

test('V2 fires sendBeacon exactly once with the documented payload', async () => {
  const { beaconCalls } = await loadWidget('widget.js', { 'data-shop': 'brewed' });
  assert.equal(beaconCalls.length, 1, 'V2 must fire sendBeacon exactly once');
  const call = beaconCalls[0];
  assert.equal(call.url, HOST_ORIGIN + '/api/widget/loaded', 'beacon URL is /api/widget/loaded on origin');
  assert.ok(call.payload, 'beacon body must decode to a UTF-8 string');
  const body = JSON.parse(call.payload);
  assert.deepEqual(
    body,
    { shop: 'brewed', version: 'v2', theme: 'dark', position: 'inline' },
    'beacon body matches the RG-43 schema',
  );
  // Body Blob type must be application/json (sendBeacon-on-Blob compat).
  assert.equal(call.body && call.body.type, 'application/json');
});

test('V2 beacon reflects resolved theme + position when overridden', async () => {
  const { beaconCalls } = await loadWidget('widget.js', {
    'data-shop': 'brewed',
    'data-theme': 'light',
    'data-position': 'floating',
  });
  assert.equal(beaconCalls.length, 1);
  const body = JSON.parse(beaconCalls[0].payload);
  assert.equal(body.theme, 'light');
  assert.equal(body.position, 'floating');
});

// ── V2 light theme ─────────────────────────────────────────────────────────

test('V2 light theme flips modal chrome (button stays brand-coloured)', async () => {
  const { document, window } = await loadWidget('widget.js', {
    'data-shop': 'brewed',
    'data-theme': 'light',
  });
  const btn = document.querySelector('.cp-widget-btn');
  // Button is brand-coloured (data-color), white text — same as V1.
  assert.equal(window.getComputedStyle(btn).getPropertyValue('color'), 'rgb(255, 255, 255)');
  btn.click();
  const inner = document.querySelector('.cp-widget-modal').children[0];
  // Light theme bg = #fafaf9 — jsdom normalises hex to rgb for getComputedStyle,
  // so we accept either form here.
  const innerBg = window.getComputedStyle(inner).getPropertyValue('background-color');
  assert.equal(innerBg, 'rgb(250, 250, 249)', 'inner must use light bg #fafaf9');
  // Backdrop also flips to the light palette (rgba(28,25,23,0.45)).
  const modal = document.querySelector('.cp-widget-modal');
  const backdrop = window.getComputedStyle(modal).getPropertyValue('background-color');
  assert.equal(backdrop, 'rgba(28, 25, 23, 0.45)', 'modal backdrop must use light token');
  // Iframe URL carries the theme override.
  const iframe = document.querySelector('iframe');
  assert.match(iframe.src, /[?&]theme=light\b/, 'iframe URL must include theme=light');
});

// ── V2 button shapes ───────────────────────────────────────────────────────

test('V2 button shapes set border-radius (square=10px, pill=999px, round=50%)', async () => {
  const square = await loadWidget('widget.js', { 'data-shop': 'brewed', 'data-button-shape': 'square' });
  const pill = await loadWidget('widget.js', { 'data-shop': 'brewed', 'data-button-shape': 'pill' });
  const round = await loadWidget('widget.js', { 'data-shop': 'brewed', 'data-button-shape': 'round' });
  assert.equal(
    square.window.getComputedStyle(square.document.querySelector('.cp-widget-btn')).getPropertyValue('border-radius'),
    '10px',
  );
  assert.equal(
    pill.window.getComputedStyle(pill.document.querySelector('.cp-widget-btn')).getPropertyValue('border-radius'),
    '999px',
  );
  // Round mode = 50% radius + 64×64 box.
  const roundBtn = round.document.querySelector('.cp-widget-btn');
  const cs = round.window.getComputedStyle(roundBtn);
  assert.equal(cs.getPropertyValue('border-radius'), '50%');
  assert.equal(cs.getPropertyValue('width'), '64px');
  assert.equal(cs.getPropertyValue('height'), '64px');
});

// ── V2 modal sizes ─────────────────────────────────────────────────────────

test('V2 modal-size tokens swap inner width+height (default/compact/full)', async () => {
  async function dimsFor(size) {
    const { document } = await loadWidget('widget.js', {
      'data-shop': 'brewed',
      ...(size ? { 'data-modal-size': size } : {}),
    });
    document.querySelector('.cp-widget-btn').click();
    const inner = document.querySelector('.cp-widget-modal').children[0];
    return { w: inner.style.width, h: inner.style.height };
  }
  const def = await dimsFor(null);
  const compact = await dimsFor('compact');
  const full = await dimsFor('full');
  assert.equal(def.w, 'min(820px,100%)', 'default width = V1 byte-for-byte');
  assert.equal(def.h, 'min(900px,90vh)', 'default height = V1 byte-for-byte');
  assert.equal(compact.w, 'min(560px,100%)');
  assert.equal(compact.h, 'min(720px,85vh)');
  assert.equal(full.w, 'min(1200px,100%)');
  assert.equal(full.h, 'min(1100px,95vh)');
});

// ── V2 event callback (back-compat + V2-NEW) ────────────────────────────────

test('V2 fires both window.cardPricerWidgetOnSubmit and data-event-callback target', async () => {
  const { window } = await loadWidget('widget.js', {
    'data-shop': 'brewed',
    'data-event-callback': 'onMyCallback',
  });
  const v1Calls = [];
  const v2Calls = [];
  window.cardPricerWidgetOnSubmit = (d) => v1Calls.push(d);
  window.onMyCallback = (d) => v2Calls.push(d);
  const ev = new window.MessageEvent('message', {
    data: { type: 'cp:submitted', shop: 'brewed', total: 42 },
    origin: HOST_ORIGIN,
  });
  window.dispatchEvent(ev);
  assert.equal(v1Calls.length, 1, 'V1 contract still fires');
  assert.equal(v2Calls.length, 1, 'V2 named callback fires');
  assert.equal(v1Calls[0].total, 42);
  assert.equal(v2Calls[0].total, 42);
});

test('V2 cp:close postMessage closes an open modal', async () => {
  const { window, document } = await loadWidget('widget.js', { 'data-shop': 'brewed' });
  document.querySelector('.cp-widget-btn').click();
  const modal = document.querySelector('.cp-widget-modal');
  assert.notEqual(modal.style.display, 'none', 'modal is open after click');
  const ev = new window.MessageEvent('message', {
    data: { type: 'cp:close' },
    origin: HOST_ORIGIN,
  });
  window.dispatchEvent(ev);
  assert.equal(modal.style.display, 'none', 'cp:close hid the modal');
});

// ── Origin gate ────────────────────────────────────────────────────────────

test('V1 + V2 ignore postMessage from a foreign origin', async () => {
  for (const file of ['widget-v1.js', 'widget.js']) {
    const { window } = await loadWidget(file, { 'data-shop': 'brewed' });
    const calls = [];
    window.cardPricerWidgetOnSubmit = (d) => calls.push(d);
    const ev = new window.MessageEvent('message', {
      data: { type: 'cp:submitted', shop: 'brewed' },
      origin: 'https://evil.test',
    });
    window.dispatchEvent(ev);
    assert.equal(calls.length, 0, `${file} must reject foreign-origin messages`);
  }
});

// ── Lazy load ──────────────────────────────────────────────────────────────
//
// Note: per compat.md, V1 was already click-lazy (modal + iframe built on
// first click). V2 inherits that — data-lazy='true' is documented as a no-op
// today but reserved for future tightening. The runtime invariant we verify
// is: NEITHER mode pre-injects the iframe into the document; both inject it
// on the first click. This way, when V2 gains true-eager mode in the future,
// this test will fail loudly and force a docs/code update together.

test('V2 does not inject the iframe before first click (both lazy and eager modes)', async () => {
  for (const lazy of ['false', 'true']) {
    const { document } = await loadWidget('widget.js', {
      'data-shop': 'brewed',
      'data-lazy': lazy,
    });
    assert.equal(
      document.querySelector('iframe'),
      null,
      `V2 must not pre-inject iframe (lazy=${lazy})`,
    );
    document.querySelector('.cp-widget-btn').click();
    assert.ok(
      document.querySelector('iframe'),
      `V2 iframe must exist after first click (lazy=${lazy})`,
    );
  }
});

// ── data-locale forwarding ─────────────────────────────────────────────────

test('V2 forwards data-locale to the iframe URL only when non-default', async () => {
  const en = await loadWidget('widget.js', { 'data-shop': 'brewed' });
  const de = await loadWidget('widget.js', { 'data-shop': 'brewed', 'data-locale': 'de' });
  en.document.querySelector('.cp-widget-btn').click();
  de.document.querySelector('.cp-widget-btn').click();
  assert.doesNotMatch(
    en.document.querySelector('iframe').src,
    /[?&]locale=/,
    'en is the default — must not appear in the URL (V1 parity)',
  );
  assert.match(de.document.querySelector('iframe').src, /[?&]locale=de\b/);
});

// ── Missing data-shop bail-out ─────────────────────────────────────────────

test('V1 + V2 bail with no DOM injection when data-shop is missing', async () => {
  for (const file of ['widget-v1.js', 'widget.js']) {
    const { document, beaconCalls } = await loadWidget(file, {});
    assert.equal(
      document.querySelector('.cp-widget-btn'),
      null,
      `${file} must not inject the button without data-shop`,
    );
    assert.equal(beaconCalls.length, 0, `${file} must not beacon without data-shop`);
  }
});
