// infra/observability/metrics.js
// Owner: A8 | Slice: S14 (final)
//
// prom-client metrics for the Card-Pricer V2 service.
//
// Per docs/V2_ARCHITECTURE.md §2.5 — /api/metrics is exposed behind
// requireAdmin in routes/admin.js (S14). Default registry is used so
// Node's collectDefaultMetrics() rolls process / GC / event-loop stats
// alongside the application counters below.
//
// Metric naming convention: cardpricer_* prefix on default metrics; the
// app counters/histograms use the names below as-is so dashboards built
// against {result="success"} still compose with cardpricer_process_*
// gauges from collectDefaultMetrics.
//
// USAGE:
//     import {
//       register, identify_total, price_total, quote_lead_total,
//       identify_duration_ms, price_duration_ms, api_request_duration_ms,
//       card_db_size, card_prices_size, room_listeners_total,
//       widget_loaded_total,
//       metricsMiddleware,
//     } from '../../infra/observability/metrics.js';
//
//     // identify completion
//     identify_total.inc({ result: 'success' });
//     // around a /api/price call
//     const stop = price_duration_ms.startTimer();
//     // ... do work ...
//     stop();
//
//     // Express middleware:
//     app.use(metricsMiddleware);

import client from 'prom-client';

// Default labels travel with every series so a multi-instance scrape
// can be filtered by service / version / env.
client.register.setDefaultLabels({
  service: 'card-pricer',
  version: process.env.GIT_SHA || 'unknown',
  environment: process.env.NODE_ENV || 'development',
});

// Use the default registry so collectDefaultMetrics piggybacks onto the
// same /api/metrics output without a second registration pass.
const register = client.register;

// Process / GC / event-loop / Node-native metrics — cheap, runs once.
client.collectDefaultMetrics({
  register,
  prefix: 'cardpricer_',
});

// ---------- Counters ----------

const identify_total = new client.Counter({
  name: 'identify_total',
  help: 'Total /api/identify* attempts, by result',
  labelNames: ['result'], // success | error | cached
  registers: [register],
});

const price_total = new client.Counter({
  name: 'price_total',
  help: 'Total /api/price* attempts, by result',
  labelNames: ['result'], // success | error | cached
  registers: [register],
});

const quote_lead_total = new client.Counter({
  name: 'quote_lead_total',
  help: 'Total /api/quote-lead submissions',
  labelNames: ['result'], // success | error
  registers: [register],
});

const widget_loaded_total = new client.Counter({
  name: 'widget_loaded_total',
  help: 'Total widget /api/widget/loaded telemetry beacons',
  labelNames: ['shop', 'version', 'theme'],
  registers: [register],
});

// ---------- Histograms ----------

const IDENTIFY_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const PRICE_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const REQUEST_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];

const identify_duration_ms = new client.Histogram({
  name: 'identify_duration_ms',
  help: 'Latency of /api/identify* in milliseconds',
  labelNames: ['result'],
  buckets: IDENTIFY_BUCKETS,
  registers: [register],
});

const price_duration_ms = new client.Histogram({
  name: 'price_duration_ms',
  help: 'Latency of /api/price* in milliseconds',
  labelNames: ['result'],
  buckets: PRICE_BUCKETS,
  registers: [register],
});

const api_request_duration_ms = new client.Histogram({
  name: 'api_request_duration_ms',
  help: 'Latency of all /api/* HTTP requests in milliseconds',
  labelNames: ['method', 'route', 'status'],
  buckets: REQUEST_BUCKETS,
  registers: [register],
});

// ---------- Gauges ----------

const card_db_size = new client.Gauge({
  name: 'card_db_size',
  help: 'Number of card entries currently in the in-memory CARD_DB',
  registers: [register],
});

const card_prices_size = new client.Gauge({
  name: 'card_prices_size',
  help: 'Number of card-price entries currently in the in-memory CARD_PRICES',
  registers: [register],
});

const room_listeners_total = new client.Gauge({
  name: 'room_listeners_total',
  help: 'Active SSE listeners on /api/room/:id/stream',
  registers: [register],
});

// ---------- Express middleware ----------

/**
 * Records api_request_duration_ms per route for every /api/* request.
 * Mount AFTER routes (or before — both work because we use res.on('finish')
 * to capture status/duration). Recommended: mount BEFORE the route handlers
 * so the timer starts as early as possible.
 */
function metricsMiddleware(req, res, next) {
  // Only meter the API surface. Static + SPA fallback emit nothing.
  if (!req.originalUrl || !req.originalUrl.startsWith('/api/')) {
    return next();
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      // req.route?.path is reliable inside the matched router; for a
      // 404 we fall back to a coarse bucket so high-cardinality scans
      // don't blow up the metric series.
      const route =
        (req.route && req.route.path) ||
        (req.baseUrl ? req.baseUrl + (req.route?.path || '') : null) ||
        coarsePath(req.originalUrl);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      api_request_duration_ms.observe(
        { method: req.method, route, status: String(res.statusCode) },
        ms
      );
    } catch {
      // Never let metric collection take down a request.
    }
  });
  next();
}

// Reduce path cardinality for unmatched routes (404s on /api/foo/bar/123)
// so we don't explode label cardinality. This isn't perfect — actual
// route registration above is preferred — but it's a safety floor.
function coarsePath(url) {
  // strip query string + replace UUID/hex/numeric segments with :id
  const path = String(url).split('?')[0];
  return path.replace(/\/[0-9a-f]{8,}/gi, '/:id').replace(/\/\d+/g, '/:id');
}

export {
  register,
  // counters
  identify_total,
  price_total,
  quote_lead_total,
  widget_loaded_total,
  // histograms
  identify_duration_ms,
  price_duration_ms,
  api_request_duration_ms,
  // gauges
  card_db_size,
  card_prices_size,
  room_listeners_total,
  // middleware
  metricsMiddleware,
};

export default register;
