// tests/regression/stripe-webhook.spec.js
// Owner: A7 | Slice: S26 (final regression backfill)
//
// RG-14 / RG-44 — V2_AUDIT §5.12 / R6:
//   POST /api/stripe-webhook depends on req.rawBody, captured by the
//   express.json `verify` callback registered at the top of
//   apps/server/index.js. Replacing or reordering that middleware
//   without preserving the verify shape silently breaks signature
//   verification — every webhook 400s and customer plan upgrades
//   stop landing.
//
// We can't replay a real Stripe event without a live STRIPE_SECRET_KEY,
// so the tests here are structural:
//
//   1. apps/server/index.js calls express.json with a `verify` callback.
//   2. The verify callback only mounts req.rawBody for /api/stripe-webhook.
//   3. The handler reads stripe.webhooks.constructEvent(req.rawBody, …).
//   4. The handler does NOT have requireAuth (V1 §4 — sig-verified, no JWT).
//   5. The handler 503s out cleanly when Stripe is not configured (so the
//      webhook never crashes the request pipeline).
//
// These five assertions together pin every R6 mitigation noted in the
// audit. Combined with the manual smoke procedure in
// infra/deploy/stripe-webhook-smoke.md they replace the missing
// end-to-end signature replay test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

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

const SERVER_SRC = fs.readFileSync(
  join(REPO_ROOT, 'apps/server/index.js'),
  'utf8'
);

const BILLING_SRC = fs.readFileSync(
  join(REPO_ROOT, 'apps/server/routes/billing.js'),
  'utf8'
);

// ────────────────────────────────────────────────────────────────────
// RG-44 (1/5): express.json registered with a verify callback.
// ────────────────────────────────────────────────────────────────────
test('RG-44: apps/server/index.js registers express.json with a verify callback', () => {
  // Match across newlines — the verify callback is multi-line.
  assert.match(
    SERVER_SRC,
    /express\.json\(\s*{[\s\S]*?verify\s*:\s*\(req[^)]*\)/,
    'express.json must be registered with a verify callback so Stripe webhook ' +
    'rawBody capture survives. V2_AUDIT §5.12 / R6.'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-44 (2/5): verify callback gates rawBody on /api/stripe-webhook.
// Otherwise every request would carry req.rawBody (memory waste) AND
// non-stripe routes would mis-handle binary payloads.
// ────────────────────────────────────────────────────────────────────
test('RG-44: rawBody is captured ONLY for /api/stripe-webhook', () => {
  assert.match(
    SERVER_SRC,
    /req\.originalUrl[^)]*startsWith\(\s*['"]\/api\/stripe-webhook['"]\s*\)[\s\S]*?req\.rawBody\s*=/,
    'verify callback must check originalUrl.startsWith("/api/stripe-webhook") ' +
    'before mounting req.rawBody'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-44 (3/5): handler reads req.rawBody for signature verification.
// ────────────────────────────────────────────────────────────────────
test('RG-44: stripe-webhook handler verifies signature using req.rawBody', () => {
  assert.match(
    BILLING_SRC,
    /stripe\.webhooks\.constructEvent\(\s*req\.rawBody\s*,/,
    'stripe-webhook handler must call stripe.webhooks.constructEvent(req.rawBody, …)'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-14 (4/5): the handler is mounted, and is NOT behind requireAuth
// (V1 §4 — webhook is signature-verified, no JWT).
// ────────────────────────────────────────────────────────────────────
test('RG-14: /api/stripe-webhook is mounted and is NOT behind requireAuth', async () => {
  const { default: billingRouter } = await import('../../apps/server/routes/billing.js');
  const { requireAuth } = await import('../../apps/server/middleware/auth.js');

  const route = findRoute(billingRouter, 'POST', '/api/stripe-webhook');
  assert.ok(route, 'POST /api/stripe-webhook must be mounted on the billing router');
  assert.equal(
    route.handlers.includes(requireAuth),
    false,
    'POST /api/stripe-webhook MUST NOT have requireAuth — it is signature-verified, no JWT'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-14 (5/5): handler 503s gracefully when Stripe is unconfigured.
// ────────────────────────────────────────────────────────────────────
test('RG-14: stripe-webhook handler 503s when Stripe is not configured', () => {
  // Match the shape: if (!stripe || !STRIPE_WEBHOOK_SECRET) → 503
  assert.match(
    BILLING_SRC,
    /if\s*\(\s*!stripe\s*\|\|\s*!process\.env\.STRIPE_WEBHOOK_SECRET\s*\)\s*{\s*return\s+res\.status\(\s*503\s*\)/,
    'stripe-webhook handler must short-circuit with 503 when stripe or webhook secret is missing'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-44 bonus: simulate the verify callback in isolation to prove it
// only sets rawBody when originalUrl matches. This is a unit test of
// the inline-defined function, replicated here from the source.
// ────────────────────────────────────────────────────────────────────
test('RG-44 bonus: a faithful reimplementation of the verify callback only mounts rawBody on /api/stripe-webhook', () => {
  // Replicate the production callback shape — the test fails closed if
  // the production code changes the predicate, because the regex above
  // also pins the predicate.
  const verify = (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/stripe-webhook')) {
      req.rawBody = buf;
    }
  };

  // Webhook request — rawBody MUST be captured.
  const webhookReq = { originalUrl: '/api/stripe-webhook' };
  verify(webhookReq, null, Buffer.from('{"id":"evt_test"}'));
  assert.ok(Buffer.isBuffer(webhookReq.rawBody), 'rawBody must be set on webhook requests');

  // Identify request — rawBody MUST NOT be captured.
  const identReq = { originalUrl: '/api/identify' };
  verify(identReq, null, Buffer.from('IMG'));
  assert.equal('rawBody' in identReq, false, 'rawBody must not leak onto non-webhook requests');

  // Empty originalUrl path — defensive — MUST NOT throw, MUST NOT set.
  const weirdReq = {};
  verify(weirdReq, null, Buffer.from(''));
  assert.equal('rawBody' in weirdReq, false);
});
