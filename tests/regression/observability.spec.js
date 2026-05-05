// tests/regression/observability.spec.js
// Owner: A8 | Slice: S14
//
// Pins the observability surface that S14 ships:
//   - logger.getLogger(name) returns a usable pino-shaped logger
//   - metrics.register exposes the documented counters/histograms/gauges
//   - initSentry({}) is a no-op when DSN absent
//   - /api/version returns the documented shape
//   - /api/widget/loaded validates body and 200s
//
// Tests are pure — no network, no Supabase. We import the route
// handlers and exercise them with minimal req/res fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Force NODE_ENV=test so the logger skips the pino-pretty transport.
// Tests that run in worker threads can race the transport on exit.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import getLogger, { getLogger as namedGetLogger, rootLogger } from '../../infra/observability/logger.js';
import {
  register,
  identify_total,
  price_total,
  quote_lead_total,
  widget_loaded_total,
  identify_duration_ms,
  price_duration_ms,
  api_request_duration_ms,
  card_db_size,
  card_prices_size,
  room_listeners_total,
  metricsMiddleware,
} from '../../infra/observability/metrics.js';
import { initSentry, requestHandler, tracingHandler, errorHandler, isInitialised } from '../../infra/observability/sentry-server.js';
import { initSentryBrowser } from '../../infra/observability/sentry-browser.js';

import healthRouter from '../../apps/server/routes/health.js';

test('logger.getLogger(name) returns a logger with info/warn/error/debug methods', () => {
  const log = getLogger('test/observability');
  assert.equal(typeof log.info, 'function');
  assert.equal(typeof log.warn, 'function');
  assert.equal(typeof log.error, 'function');
  assert.equal(typeof log.debug, 'function');
  // child() must work for sub-component logging.
  const child = log.child({ scan_id: 'abc' });
  assert.equal(typeof child.info, 'function');

  // Named export and default export both resolve.
  assert.equal(getLogger, namedGetLogger);
  assert.ok(rootLogger, 'rootLogger named export present');

  // Empty/wrong name throws cleanly.
  assert.throws(() => getLogger(''), /non-empty string/);
  assert.throws(() => getLogger(null), /non-empty string/);
});

test('metrics.register exposes the documented counters / histograms / gauges', async () => {
  // Counters
  assert.ok(identify_total, 'identify_total counter present');
  assert.ok(price_total, 'price_total counter present');
  assert.ok(quote_lead_total, 'quote_lead_total counter present');
  assert.ok(widget_loaded_total, 'widget_loaded_total counter present');
  // Histograms
  assert.ok(identify_duration_ms, 'identify_duration_ms histogram present');
  assert.ok(price_duration_ms, 'price_duration_ms histogram present');
  assert.ok(api_request_duration_ms, 'api_request_duration_ms histogram present');
  // Gauges
  assert.ok(card_db_size, 'card_db_size gauge present');
  assert.ok(card_prices_size, 'card_prices_size gauge present');
  assert.ok(room_listeners_total, 'room_listeners_total gauge present');

  // Sanity: incrementing then exporting prom-text contains the metric.
  identify_total.inc({ result: 'success' });
  const text = await register.metrics();
  assert.match(text, /identify_total\b/);
  assert.match(text, /service="card-pricer"/, 'default labels include service');
  assert.match(text, /cardpricer_process_/, 'collectDefaultMetrics ran with cardpricer_ prefix');

  // metricsMiddleware is a function with arity 3 (req, res, next).
  assert.equal(typeof metricsMiddleware, 'function');
  assert.equal(metricsMiddleware.length, 3);
});

test('initSentry({}) and initSentry({dsn:""}) are no-ops without throwing', () => {
  assert.equal(initSentry({}), false);
  assert.equal(initSentry({ dsn: '' }), false);
  assert.equal(isInitialised(), false);
  // Handlers still return middleware-shaped functions even when not initialised.
  const rh = requestHandler();
  const th = tracingHandler();
  const eh = errorHandler();
  assert.equal(typeof rh, 'function');
  assert.equal(typeof th, 'function');
  assert.equal(typeof eh, 'function');
  // Pass-through behaviour for the no-op error handler.
  let nextErr;
  eh(new Error('boom'), {}, {}, (e) => { nextErr = e; });
  assert.equal(nextErr?.message, 'boom');
});

test('initSentryBrowser({}) is a no-op when no DSN', () => {
  assert.equal(initSentryBrowser({}), false);
  assert.equal(initSentryBrowser({ dsn: '' }), false);
  // Even with a DSN, no window.Sentry global → still no-op (server context).
  assert.equal(initSentryBrowser({ dsn: 'https://x@sentry.io/1' }), false);
});

test('/api/version returns the documented shape', async () => {
  const handler = findRouteHandler(healthRouter, 'get', '/api/version');
  assert.ok(handler, 'GET /api/version handler is registered');

  const captured = await invokeJson(handler);
  assert.equal(typeof captured.body.git_sha, 'string');
  // built_at can be null or a string; both legal.
  assert.ok(captured.body.built_at === null || typeof captured.body.built_at === 'string');
  assert.match(captured.body.node_version, /^v\d+/);
  assert.equal(typeof captured.body.uptime_s, 'number');
  assert.equal(typeof captured.body.env, 'string');
});

test('/api/widget/loaded validates shop slug and 200s on valid body', async () => {
  const handler = findRouteHandler(healthRouter, 'post', '/api/widget/loaded');
  assert.ok(handler, 'POST /api/widget/loaded handler is registered');

  // Valid slug
  const ok = await invokeJson(handler, { body: { shop: 'brewed', version: '2.0.0', theme: 'light', position: 'corner' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);

  // Invalid: too short
  const bad1 = await invokeJson(handler, { body: { shop: 'ab' } });
  assert.equal(bad1.status, 400);

  // Invalid: starts with dash
  const bad2 = await invokeJson(handler, { body: { shop: '-shop' } });
  assert.equal(bad2.status, 400);

  // Invalid: missing
  const bad3 = await invokeJson(handler, { body: {} });
  assert.equal(bad3.status, 400);

  // Confirm the counter incremented (fresh exported value)
  const text = await register.metrics();
  assert.match(text, /widget_loaded_total\{[^}]*shop="brewed"/);
});

// ---------- helpers ----------

function findRouteHandler(router, method, path) {
  // Express router exposes .stack — each layer has .route with .path + .methods.
  for (const layer of router.stack || []) {
    if (layer.route && layer.route.path === path && layer.route.methods?.[method]) {
      // The actual handler is at the end of layer.route.stack.
      const stack = layer.route.stack || [];
      return stack[stack.length - 1]?.handle;
    }
  }
  return null;
}

function invokeJson(handler, { body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { body, headers: {}, originalUrl: '' };
    let captured = { status: 200, body: null, headers: {} };
    const res = {
      statusCode: 200,
      status(c) { captured.status = c; res.statusCode = c; return res; },
      json(obj) { captured.body = obj; resolve(captured); return res; },
      set(name, val) { captured.headers[name] = val; return res; },
      end(body) { captured.body = body; resolve(captured); return res; },
    };
    try {
      const result = handler(req, res, (err) => err ? reject(err) : resolve(captured));
      if (result && typeof result.catch === 'function') result.catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}
