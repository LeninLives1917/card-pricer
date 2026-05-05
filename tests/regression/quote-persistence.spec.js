// tests/regression/quote-persistence.spec.js
// Owner: A1 + A5 | Slice: S12 (F6 — Quote persistence / stable URL).
//
// Pins the S12 contract:
//   1. GET /api/v2/quote/:id returns a sanitised JSON shape (no PII).
//   2. Invalid uuid → 400; unknown id → 404; no supabase → 503.
//   3. GET /q/:id 302-redirects to /quote#recover=<id> for valid ids,
//      404s for malformed ids.
//   4. POST /api/quote-lead returns quote_url + quote_id when supabase
//      is present, or quote_url:null + persistence:'unavailable' when
//      it isn't.
//
// We use the same router-stack-introspection pattern as
// quote-public-paths.spec.js: pull the handler off Express's layer
// stack, then call it with stubbed req/res. The recover handlers were
// factored into named factories specifically so tests can swap in a
// fake supabase without touching the singleton in _clients.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import quoteRecoverRouter, {
  isUuid,
  UUID_RE,
  makeRecoverJsonHandler,
  recoverHtmlHandler,
} from '../../apps/server/routes/quote-recover.js';
import quoteLeadRouter from '../../apps/server/routes/quote-lead.js';
import { makeFakeSupabase } from '../helpers/setup.js';

// ── Helpers ────────────────────────────────────────────────────────────

function findRoute(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    const m = layer.route.methods?.[method.toLowerCase()];
    if (!m) continue;
    return { handlers: layer.route.stack.map((s) => s.handle) };
  }
  return null;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirectedTo: null,
    redirectStatus: null,
    typeSet: null,
    sentText: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(b) { this.body = b; return this; },
    type(t) { this.typeSet = t; return this; },
    send(t) { this.sentText = t; return this; },
    redirect(...args) {
      // res.redirect(302, url) or res.redirect(url)
      if (args.length === 2) {
        this.redirectStatus = args[0];
        this.redirectedTo = args[1];
      } else {
        this.redirectStatus = 302;
        this.redirectedTo = args[0];
      }
      this.statusCode = this.redirectStatus;
      return this;
    },
    get(k) { return this.headers[k.toLowerCase()]; },
  };
  return res;
}

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

// ── isUuid ─────────────────────────────────────────────────────────────

test('S12: isUuid accepts valid v4-shape uuid and rejects junk', () => {
  assert.equal(isUuid(VALID_UUID), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid('11111111-2222-4333-8444-55555555555'), false); // short
  assert.match(VALID_UUID, UUID_RE);
});

// ── GET /api/v2/quote/:id — sanitised shape, no PII ────────────────────

test('S12: GET /api/v2/quote/:id returns sanitised quote, no PII', async () => {
  const sb = makeFakeSupabase({
    quote_leads: {
      data: {
        id: VALID_UUID,
        shop_id: null,
        shop_slug: 'demoshop',
        card_count: 2,
        total_market: 12.34,
        total_cash: 6.78,
        total_credit: 9.10,
        cards_json: [
          { name: 'Pikachu', set_code: 'BSE', mv: 5, cash: 2, credit: 3 },
          { name: 'Charizard', set_code: 'BSE', mv: 7.34, cash: 4.78, credit: 6.10 },
        ],
        created_at: '2026-05-04T12:00:00Z',
        // PII fields the row contains but the handler must drop:
        email: 'leak@example.com',
        name: 'Leak Test',
        ip_hash: 'abc123',
        newsletter: true,
      },
      error: null,
    },
  });
  const handler = makeRecoverJsonHandler(sb.client);
  const req = { params: { id: VALID_UUID } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body, 'body should exist');
  assert.equal(res.body.id, VALID_UUID);
  assert.equal(res.body.shop_slug, 'demoshop');
  assert.equal(res.body.card_count, 2);
  assert.deepEqual(res.body.totals, { market: 12.34, cash: 6.78, credit: 9.1 });
  assert.equal(Array.isArray(res.body.cards), true);
  assert.equal(res.body.cards.length, 2);

  // Hard PII negative assertions — these MUST NOT leak.
  assert.equal('email' in res.body, false, 'email must not appear in response');
  assert.equal('name' in res.body, false, 'name must not appear in response');
  assert.equal('ip_hash' in res.body, false, 'ip_hash must not appear in response');
  assert.equal('newsletter' in res.body, false, 'newsletter flag must not appear');
});

test('S12: GET /api/v2/quote/:id with invalid uuid → 400', async () => {
  const handler = makeRecoverJsonHandler(makeFakeSupabase().client);
  const req = { params: { id: 'not-a-uuid' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body?.error || '', /invalid/i);
});

test('S12: GET /api/v2/quote/:id with unknown uuid → 404', async () => {
  // Default fake returns { data: null, error: null } for un-seeded tables —
  // i.e. "not found".
  const handler = makeRecoverJsonHandler(makeFakeSupabase().client);
  const req = { params: { id: VALID_UUID } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body?.error || '', /not found/i);
});

test('S12: GET /api/v2/quote/:id without supabase → 503', async () => {
  const handler = makeRecoverJsonHandler(null);
  const req = { params: { id: VALID_UUID } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 503);
});

// ── GET /q/:id — redirect or 404 ────────────────────────────────────────

test('S12: GET /q/:id with valid uuid → 302 to /quote#recover=<id>', () => {
  const req = { params: { id: VALID_UUID } };
  const res = makeRes();
  recoverHtmlHandler(req, res);
  assert.equal(res.redirectStatus, 302);
  assert.equal(res.redirectedTo, '/quote#recover=' + encodeURIComponent(VALID_UUID));
});

test('S12: GET /q/:id with invalid uuid → 404 HTML', () => {
  const req = { params: { id: 'not-a-uuid' } };
  const res = makeRes();
  recoverHtmlHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.typeSet, 'html');
  assert.match(res.sentText || '', /Quote not found/i);
});

// ── Router stack: routes are wired ─────────────────────────────────────

test('S12: quoteRecoverRouter exposes GET /api/v2/quote/:id and GET /q/:id', () => {
  const recover = findRoute(quoteRecoverRouter, 'GET', '/api/v2/quote/:id');
  const html = findRoute(quoteRecoverRouter, 'GET', '/q/:id');
  assert.ok(recover, 'GET /api/v2/quote/:id not registered');
  assert.ok(html, 'GET /q/:id not registered');
});

// ── POST /api/quote-lead returns quote_url shape ───────────────────────
// Without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars the singleton in
// _clients.js is null, which is the no-supabase path we want. Tests run
// with that null singleton (the test runner doesn't set those vars), so
// we hit the persistLead → { id:null, persistence:'unavailable' } branch.
// We also cover the no-BREVO_API_KEY branch which is the simpler exit so
// no real network calls are made.

test('S12: POST /api/quote-lead (no supabase, no brevo) returns quote_url:null + persistence info', async () => {
  const route = findRoute(quoteLeadRouter, 'POST', '/api/quote-lead');
  assert.ok(route, 'POST /api/quote-lead not registered');
  // Last handler in the chain is the actual route handler — earlier ones
  // are middleware (the limiter). Skip them and call the handler directly.
  const handler = route.handlers[route.handlers.length - 1];

  // Force the no-BREVO_API_KEY branch so no fetch fires.
  const prevBrevoKey = process.env.BREVO_API_KEY;
  delete process.env.BREVO_API_KEY;

  try {
    const req = {
      ip: '127.0.0.1',
      protocol: 'https',
      get: (k) => (k.toLowerCase() === 'host' ? 'card-pricer-60qq.onrender.com' : undefined),
      body: {
        email: 'customer@example.com',
        cards: [{ name: 'Pikachu', set_code: 'BSE', card_number: '25', market_value: 5, cash_offer: 2, credit_offer: 3 }],
        totals: { market: 5, cash: 2, credit: 3 },
        cashPct: 55,
        creditPct: 70,
      },
    };
    const res = makeRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body, 'response body must exist');
    assert.equal(res.body.ok, true);
    // S12 contract: even when persistence is unavailable, the new fields
    // are present so the client can branch on quote_url == null.
    assert.equal('quote_url' in res.body, true, 'quote_url field must always be present');
    assert.equal('quote_id' in res.body, true, 'quote_id field must always be present');
    assert.equal(res.body.quote_url, null);
    assert.equal(res.body.quote_id, null);
    // persistence marker is set whenever the insert didn't succeed. Either
    // 'unavailable' (no supabase client) or 'failed' (client present but
    // insert errored — common in tests because dotenv may load a real
    // SUPABASE_URL pointing at a project the test env can't write to).
    // Both are valid signals to the client that the URL won't recover.
    assert.ok(
      res.body.persistence === 'unavailable' || res.body.persistence === 'failed',
      'persistence marker should be unavailable|failed; got ' + res.body.persistence
    );
  } finally {
    if (prevBrevoKey !== undefined) process.env.BREVO_API_KEY = prevBrevoKey;
  }
});
