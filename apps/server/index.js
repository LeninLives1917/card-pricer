// apps/server/index.js
// Owner: A1 | Slice: S5 (extraction); S14 wires observability (pino, Sentry, metrics).
//
// Express app wiring. Mounts every V1 route via routers in the same order
// as V1 server.js so behaviour-preservation is path-by-path verifiable.
//
// CRITICAL ORDERING (V2_AUDIT §5.11, §5.12, §1a):
//   1. initSentry() — BEFORE express() is constructed so OTel auto-instrumentation
//      hooks the Express integration on import.
//   2. app.set('trust proxy', 1) — required for express-rate-limit per-IP
//      bucketing behind Render's edge proxy.
//   3. Sentry.requestHandler() + Sentry.tracingHandler() — first in the chain
//      so every request enters a Sentry hub/scope (no-ops on v10; kept for
//      wiring symmetry).
//   4. cors() before express.json — same as V1.
//   5. express.json({limit:'50mb', verify}) — the verify callback captures
//      req.rawBody for /api/stripe-webhook ONLY. Stripe signature
//      verification breaks if this is dropped.
//   6. metricsMiddleware — observes api_request_duration_ms per route.
//   7. /api/* routers (rate-limit → auth → quota → handler chains live
//      inside each router file).
//   8. Early static (/service-worker.js, /, /index.html, /widget.js, /quote)
//      mounted BEFORE express.static so widget.js's 5-min Cache-Control
//      override wins.
//   9. express.static('public', {etag:false, maxAge:0}).
//  10. SPA fallback ('*') — MUST be last so it doesn't eat /api/* routes.
//  11. Sentry.errorHandler() — captures unhandled errors before terminal sink.
//  12. errorHandler — final safety net (returns JSON 500).
//
// This file does NOT call app.listen — that's apps/server/server.js's job.

import 'dotenv/config';

// Sentry init MUST run BEFORE express is imported / constructed so the v10
// OTel auto-instrumentation hooks Express on require(). It's safe to call
// even when SENTRY_DSN_SERVER is unset (initSentry no-ops).
import {
  initSentry,
  requestHandler as sentryRequestHandler,
  tracingHandler as sentryTracingHandler,
  errorHandler as sentryErrorHandler,
} from '../../infra/observability/sentry-server.js';

initSentry({
  dsn: process.env.SENTRY_DSN_SERVER,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
  release: process.env.GIT_SHA || 'unknown',
});

import express from 'express';
import cors from 'cors';

// Initialise singleton clients (Anthropic, Supabase, Stripe, axios+keep-alive
// agents). Importing this for side effects is intentional.
import './_clients.js';

// Boot-time side effects (initCardDb, FX refresh, dirty-save interval) are
// fired explicitly from apps/server/server.js before app.listen.

// Telemetry. S14 wires the real pino logger — no defensive fallback.
import getLogger from '../../infra/observability/logger.js';
import { metricsMiddleware } from '../../infra/observability/metrics.js';

const log = getLogger('server');

import { errorHandler } from './middleware/error-handler.js';

import identifyRouter from './routes/identify.js';
import priceRouter from './routes/price.js';
import priceSealedRouter from './routes/price-sealed.js'; // S17
import cardDbRouter from './routes/card-db.js';
import accountRouter from './routes/account.js';
import billingRouter from './routes/billing.js';
import adminRouter from './routes/admin.js';
import shopRouter from './routes/shop.js';
import quoteLeadRouter from './routes/quote-lead.js';
import quoteRecoverRouter from './routes/quote-recover.js'; // S12
import quoteOfferRouter from './routes/quote-offer.js';     // S20
import customerRouter from './routes/customer.js';          // S20
import inventoryRouter from './routes/inventory.js';        // S18
import roomRouter from './routes/room.js';
import searchRouter from './routes/search.js';
import healthRouter from './routes/health.js';
import staticRoutes from './routes/static.js';

const app = express();

// Expose the logger to route handlers that want it via app.locals.log.
app.locals.log = log;

// ============================================================
// CORE MIDDLEWARE — order matters; see file header.
// ============================================================
app.set('trust proxy', 1);

// Sentry request + tracing handlers go FIRST so every request is inside
// a hub/scope. v10 makes these effectively no-ops (OTel auto-instruments)
// but the wiring is preserved for clarity + forward-compat.
app.use(sentryRequestHandler());
app.use(sentryTracingHandler());

app.use(cors());

app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/stripe-webhook')) {
      req.rawBody = buf;
    }
  }
}));

// Per-request metrics (api_request_duration_ms histogram). Mounted BEFORE
// the route handlers so res.on('finish') captures the full handler latency.
app.use(metricsMiddleware);

// ============================================================
// API ROUTES — mounted in V1 order so a behaviour diff is grep-able
// against the surface map in docs/V2_AUDIT.md §1a.
// ============================================================
app.use(accountRouter);     // /api/usage, /api/welcome-email, /api/me, /api/state
app.use(adminRouter);       // /api/admin/*, /api/metrics
app.use(billingRouter);     // /api/checkout, /api/portal, /api/stripe-webhook
app.use(staticRoutes.earlyStatic);  // /service-worker.js, /, /index.html, /widget.js, /quote (BEFORE express.static)
app.use(staticRoutes.staticAssets); // express.static('public', etag:false, maxAge:0)
app.use(identifyRouter);    // /api/identify*, /api/identify-stream, /api/identify-binder, /api/identify-manual, /api/read-set-code, /api/lookup-by-number, /api/report-bad-id, /api/correct-card, /api/v2/identify-ocr-first, /api/v2/quote/identify-manual
app.use(cardDbRouter);      // /api/card-db-*
app.use(priceRouter);       // /api/price, /api/v2/quote/price
app.use(priceSealedRouter); // /api/v2/price-sealed (S17)
app.use(searchRouter);      // /api/search
app.use(healthRouter);      // /api/health, /api/version, /api/widget/loaded
app.use(roomRouter);        // /api/room/:id/*
app.use(quoteLeadRouter);   // /api/quote-lead
app.use(quoteRecoverRouter);// /api/v2/quote/:id, /q/:id (S12) — MUST be before spaFallback
app.use(quoteOfferRouter);  // /api/v2/quote-offer + /:token/{accept,decline} (S20)
app.use(customerRouter);    // /api/v2/customer/me + /offers + /magic-link (S20)
app.use(inventoryRouter);   // /api/v2/inventory/* (S18)
app.use(shopRouter);        // /api/shop, /api/shop-config/:slug

// SPA fallback MUST be last (V2_AUDIT §1 — line 5707 in V1).
app.use(staticRoutes.spaFallback);

// Sentry error handler runs BEFORE the terminal application errorHandler.
// It captures the exception, then forwards via next(err) so the JSON 500
// response still goes out from middleware/error-handler.js.
app.use(sentryErrorHandler());

// Application's terminal error sink. Always last.
app.use(errorHandler);

log.info({ phase: 'boot' }, 'apps/server/index.js wired — routes mounted');

export default app;
