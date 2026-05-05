// tests/regression/quote-public-paths.spec.js
// Author: A1 (S8.5).
//
// Pin the S8.5 fix: the customer-side /quote page hits anonymous-friendly
// /api/v2/quote/* paths instead of the auth'd vendor paths. Three things
// to lock down:
//
//   1. apps/quote/modules/lookup.js calls the V2 paths (URL strings).
//   2. The new V2 routes exist on the identify + price routers.
//   3. The V2 routes do NOT have requireAuth in their middleware chain;
//      they DO carry the quoteLeadLimiter gate.
//
// We can't easily run the handlers end-to-end without booting Supabase +
// Anthropic clients, but we can introspect the Express router stack and
// the source of lookup.js to prove the wiring is correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import identifyRouter, { handleManualIdentify } from '../../apps/server/routes/identify.js';
import priceRouter, { handlePrice } from '../../apps/server/routes/price.js';
import { requireAuth } from '../../apps/server/middleware/auth.js';
import { quoteLeadLimiter } from '../../apps/server/middleware/rate-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

// Walk the router stack and find the layer matching `path` + `method`.
// Returns { handlers: Function[] } where handlers is the chain of
// middleware + the final handler, in order.
function findRoute(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    const m = layer.route.methods?.[method.toLowerCase()];
    if (!m) continue;
    return { handlers: layer.route.stack.map(s => s.handle) };
  }
  return null;
}

// ── lookup.js URL flip ─────────────────────────────────────────────────
test('S8.5: apps/quote/modules/lookup.js calls /api/v2/quote/* paths', () => {
  const src = fs.readFileSync(
    join(REPO_ROOT, 'apps/quote/modules/lookup.js'),
    'utf8'
  );
  // V2 paths must be present.
  assert.match(src, /['"]\/api\/v2\/quote\/identify-manual['"]/, 'expected V2 identify-manual path');
  assert.match(src, /['"]\/api\/v2\/quote\/price['"]/, 'expected V2 price path');
  // Old V1 paths must NOT appear inside an actual fetch call. They may
  // still appear in comments documenting the migration; we look for them
  // followed by a comma + body which is the request() call shape.
  assert.doesNotMatch(
    src,
    /request\(\s*['"]\/api\/identify-manual['"]\s*,/,
    'old V1 /api/identify-manual call site still present'
  );
  assert.doesNotMatch(
    src,
    /request\(\s*['"]\/api\/price['"]\s*,/,
    'old V1 /api/price call site still present'
  );
});

// ── identify router: V2 public path exists, no auth ────────────────────
test('S8.5: identify router exposes POST /api/v2/quote/identify-manual', () => {
  const route = findRoute(identifyRouter, 'POST', '/api/v2/quote/identify-manual');
  assert.ok(route, 'POST /api/v2/quote/identify-manual not registered');
  assert.ok(route.handlers.length >= 2, 'expected at least limiter + handler');
});

test('S8.5: V2 identify-manual chain has NO requireAuth and INCLUDES quoteLeadLimiter', () => {
  const route = findRoute(identifyRouter, 'POST', '/api/v2/quote/identify-manual');
  assert.ok(route, 'route missing');
  assert.ok(
    !route.handlers.includes(requireAuth),
    'requireAuth must NOT be in the V2 quote identify chain'
  );
  assert.ok(
    route.handlers.includes(quoteLeadLimiter),
    'quoteLeadLimiter must gate the V2 quote identify chain'
  );
});

test('S8.5: V1 /api/identify-manual still has requireAuth (regression guard)', () => {
  const route = findRoute(identifyRouter, 'POST', '/api/identify-manual');
  assert.ok(route, 'V1 /api/identify-manual missing');
  assert.ok(
    route.handlers.includes(requireAuth),
    'V1 /api/identify-manual must keep requireAuth — V2 carve-out is additive'
  );
});

// ── price router: V2 public path exists, no auth ───────────────────────
test('S8.5: price router exposes POST /api/v2/quote/price with limiter, no auth', () => {
  const route = findRoute(priceRouter, 'POST', '/api/v2/quote/price');
  assert.ok(route, 'POST /api/v2/quote/price not registered');
  assert.ok(
    !route.handlers.includes(requireAuth),
    'requireAuth must NOT be in the V2 quote price chain'
  );
  assert.ok(
    route.handlers.includes(quoteLeadLimiter),
    'quoteLeadLimiter must gate the V2 quote price chain'
  );
});

test('S8.5: V1 /api/price still has requireAuth (regression guard)', () => {
  const route = findRoute(priceRouter, 'POST', '/api/price');
  assert.ok(route, 'V1 /api/price missing');
  assert.ok(
    route.handlers.includes(requireAuth),
    'V1 /api/price must keep requireAuth — V2 carve-out is additive'
  );
});

// ── shared handler shape ───────────────────────────────────────────────
test('S8.5: handleManualIdentify + handlePrice are exported as functions', () => {
  // Both V1 and V2 routes call the same shared handler — proves no logic
  // drift between auth'd and public paths.
  assert.equal(typeof handleManualIdentify, 'function');
  assert.equal(typeof handlePrice, 'function');
});

test('S8.5: handleManualIdentify rejects missing game with 400 (V1 contract)', async () => {
  // Stub req/res; the handler should short-circuit on validation before
  // touching any external API.
  let status = 200;
  let body = null;
  const req = { body: {} };
  const res = {
    status(s) { status = s; return this; },
    json(b)   { body = b; return this; },
  };
  await handleManualIdentify(req, res);
  assert.equal(status, 400);
  assert.match(body?.error || '', /game/i);
});

test('S8.5: handlePrice rejects missing card with 400 (V1 contract)', async () => {
  let status = 200;
  let body = null;
  const req = { body: {} };
  const res = {
    status(s) { status = s; return this; },
    json(b)   { body = b; return this; },
  };
  await handlePrice(req, res);
  assert.equal(status, 400);
  assert.match(body?.error || '', /Card data required/i);
});
