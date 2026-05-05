// tests/regression/customer-ui.spec.js
// Author: A10 (S21). Module-load smoke tests for the V2 customer
// dashboard app + the static.js extensions for /customer + /o/:token.
//
// Goal: pin the public contracts of every customer/modules/*.js file
// without booting a DOM. These are the modules the orchestrator ships
// to the browser; if any one fails to import in Node it fails to load
// in the browser too. Pure module-load assertions — no jsdom.
//
// Mirrors tests/regression/vendor-modules.spec.js + quote-modules.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub the few browser globals modules might reach for at import time.
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  readyState: 'complete',
};
globalThis.location = globalThis.location || { hash: '', search: '', href: 'http://localhost/customer' };

// ── Module imports ────────────────────────────────────────────────────
const apiClient    = await import('../../apps/customer/modules/api-client.js');
const authMod      = await import('../../apps/customer/modules/auth.js');
const historyMod   = await import('../../apps/customer/modules/quote-history.js');
const offerMod     = await import('../../apps/customer/modules/offer-accept.js');
const accountMod   = await import('../../apps/customer/modules/account.js');
const mainMod      = await import('../../apps/customer/modules/main.js');
const staticMod    = await import('../../apps/server/routes/static.js');

// ── api-client surface ────────────────────────────────────────────────
test('S21 api-client exports the documented HTTP surface', () => {
  assert.equal(typeof apiClient.request, 'function', 'request() core');
  assert.equal(typeof apiClient.getJson, 'function', 'getJson()');
  assert.equal(typeof apiClient.postJson, 'function', 'postJson()');
  assert.equal(typeof apiClient.patchJson, 'function', 'patchJson()');
  assert.equal(typeof apiClient.setHooks, 'function', 'setHooks()');
  assert.ok(apiClient.PUBLIC_PATHS instanceof RegExp, 'PUBLIC_PATHS is a RegExp');
  assert.equal(typeof apiClient.api, 'object', 'api convenience namespace');
  assert.equal(typeof apiClient.api.me, 'function');
  assert.equal(typeof apiClient.api.offers, 'function');
  assert.equal(typeof apiClient.api.magicLink, 'function');
  assert.equal(typeof apiClient.api.offer, 'function');
  assert.equal(typeof apiClient.api.accept, 'function');
  assert.equal(typeof apiClient.api.decline, 'function');
});

test('S21 PUBLIC_PATHS matches the no-auth endpoints and rejects authd ones', () => {
  const re = apiClient.PUBLIC_PATHS;
  // Matches public paths
  assert.ok(re.test('/api/v2/customer/magic-link'));
  assert.ok(re.test('/api/v2/quote-offer/abc123'));
  assert.ok(re.test('/api/v2/quote-offer/abc123/accept'));
  assert.ok(re.test('/api/v2/quote-offer/abc123/decline'));
  // Does NOT match auth-required paths
  assert.ok(!re.test('/api/v2/customer/me'));
  assert.ok(!re.test('/api/v2/customer/offers'));
  assert.ok(!re.test('/api/v2/quote-offer'));
});

// ── auth.js surface ───────────────────────────────────────────────────
test('S21 auth.js exposes renderSignIn + signOut + escapeHtml', () => {
  assert.equal(typeof authMod.renderSignIn, 'function');
  assert.equal(typeof authMod.signOut, 'function');
  assert.equal(typeof authMod.escapeHtml, 'function');
  // escapeHtml smoke
  assert.equal(authMod.escapeHtml('<a>&"\''), '&lt;a&gt;&amp;&quot;&#39;');
  assert.equal(authMod.escapeHtml(null), '');
});

// ── quote-history.js surface ──────────────────────────────────────────
test('S21 quote-history.js exposes renderHistory', () => {
  assert.equal(typeof historyMod.renderHistory, 'function');
  assert.equal(typeof historyMod.default, 'object');
  assert.equal(typeof historyMod.default.renderHistory, 'function');
});

// ── offer-accept.js surface ───────────────────────────────────────────
test('S21 offer-accept.js exposes renderOffer', () => {
  assert.equal(typeof offerMod.renderOffer, 'function');
  assert.equal(typeof offerMod.default, 'object');
  assert.equal(typeof offerMod.default.renderOffer, 'function');
});

// ── account.js surface ────────────────────────────────────────────────
test('S21 account.js exposes renderAccount', () => {
  assert.equal(typeof accountMod.renderAccount, 'function');
  assert.equal(typeof accountMod.default, 'object');
  assert.equal(typeof accountMod.default.renderAccount, 'function');
});

// ── main.js default init ──────────────────────────────────────────────
test('S21 main.js exports a default init function', () => {
  assert.equal(typeof mainMod.default, 'function');
});

// ── static.js extensions: /customer + /o/:token ───────────────────────
function findRoute(router, method, path) {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    const m = layer.route.methods?.[method.toLowerCase()];
    if (!m) continue;
    return { handlers: layer.route.stack.map(s => s.handle) };
  }
  return null;
}

test('S21 static.js earlyStatic registers GET /customer', () => {
  const r = staticMod.earlyStatic;
  assert.ok(r, 'earlyStatic exported');
  assert.ok(findRoute(r, 'GET', '/customer'), 'GET /customer registered');
});

test('S21 static.js earlyStatic registers GET /o/:token (302 → hash route)', () => {
  const r = staticMod.earlyStatic;
  const route = findRoute(r, 'GET', '/o/:token');
  assert.ok(route, 'GET /o/:token registered');
  // Verify the handler 302's to the customer hash route. Stub req/res.
  const handler = route.handlers[route.handlers.length - 1];
  let redirected = null;
  let status = null;
  const req = { params: { token: 'abc-XYZ_123' } };
  const res = {
    redirect(s, url) { status = s; redirected = url; return this; },
    status() { return this; },
    send() { return this; },
  };
  handler(req, res);
  assert.equal(status, 302);
  assert.ok(redirected.startsWith('/customer#offer='), 'redirected to /customer#offer=');
  assert.ok(redirected.includes(encodeURIComponent('abc-XYZ_123')));
});
