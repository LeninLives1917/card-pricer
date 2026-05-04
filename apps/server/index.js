// apps/server/index.js
// Owner: A1 | Slice: S5
//
// Express app wiring. Mounts every V1 route via routers in the same order
// as V1 server.js so behaviour-preservation is path-by-path verifiable.
//
// CRITICAL ORDERING (V2_AUDIT §5.11, §5.12, §1a):
//   1. app.set('trust proxy', 1) — required for express-rate-limit per-IP
//      bucketing behind Render's edge proxy.
//   2. cors() before express.json — same as V1.
//   3. express.json({limit:'50mb', verify}) — the verify callback captures
//      req.rawBody for /api/stripe-webhook ONLY. Stripe signature
//      verification breaks if this is dropped.
//   4. /api/* routers (rate-limit → auth → quota → handler chains live
//      inside each router file).
//   5. Early static (/service-worker.js, /, /index.html, /widget.js, /quote)
//      mounted BEFORE express.static so widget.js's 5-min Cache-Control
//      override wins.
//   6. express.static('public', {etag:false, maxAge:0}).
//   7. SPA fallback ('*') — MUST be last so it doesn't eat /api/* routes.
//   8. errorHandler — final safety net.
//
// This file does NOT call app.listen — that's apps/server/server.js's job.
// It's also not yet wired into package.json; root server.js stays the
// entrypoint until phase-5 cutover. S5 is a behaviour-preserving extraction.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// Initialise singleton clients (Anthropic, Supabase, Stripe, axios+keep-alive
// agents). Importing this for side effects is intentional.
import './_clients.js';

// Side-effect import: starts the FX refresh loop, kicks off card-DB boot
// and the periodic dirty-save interval. Same lifecycle as V1.
import './_legacy-pricing.js';
// _card-db-boot.js is imported transitively via _legacy-pricing — its
// initCardDb() call fires at module load.

// Telemetry. S5 imports the logger to anchor the wiring point; real
// logging is wired by S14 (A8). pino isn't yet in package.json so the
// import is wrapped — see infra/observability/logger.js for the contract.
let log;
try {
  const { default: getLogger } = await import('../../infra/observability/logger.js');
  log = getLogger('server');
} catch (e) {
  // pino not installed yet (declared deferred in logger.js header). Fall
  // back to a console shim so S5 can boot before S14 lands the dependency.
  log = {
    info:  (...a) => console.log('[server]', ...a),
    warn:  (...a) => console.warn('[server]', ...a),
    error: (...a) => console.error('[server]', ...a),
    debug: () => {},
    child: () => log,
  };
  console.warn('[server] pino not installed — falling back to console logger (S14 wires this up)');
}

import { errorHandler } from './middleware/error-handler.js';

import identifyRouter from './routes/identify.js';
import priceRouter from './routes/price.js';
import cardDbRouter from './routes/card-db.js';
import accountRouter from './routes/account.js';
import billingRouter from './routes/billing.js';
import adminRouter from './routes/admin.js';
import shopRouter from './routes/shop.js';
import quoteLeadRouter from './routes/quote-lead.js';
import roomRouter from './routes/room.js';
import searchRouter from './routes/search.js';
import healthRouter from './routes/health.js';
import staticRoutes from './routes/static.js';

const app = express();

// ============================================================
// CORE MIDDLEWARE — order matters; see file header.
// ============================================================
app.set('trust proxy', 1);
app.use(cors());

app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/stripe-webhook')) {
      req.rawBody = buf;
    }
  }
}));

// ============================================================
// API ROUTES — mounted in V1 order so a behaviour diff is grep-able
// against the surface map in docs/V2_AUDIT.md §1a.
// ============================================================
app.use(accountRouter);     // /api/usage, /api/welcome-email, /api/me, /api/state
app.use(adminRouter);       // /api/admin/*
app.use(billingRouter);     // /api/checkout, /api/portal, /api/stripe-webhook
app.use(staticRoutes.earlyStatic);  // /service-worker.js, /, /index.html, /widget.js, /quote (BEFORE express.static)
app.use(staticRoutes.staticAssets); // express.static('public', etag:false, maxAge:0)
app.use(identifyRouter);    // /api/identify*, /api/identify-stream, /api/identify-manual, /api/read-set-code, /api/lookup-by-number, /api/report-bad-id, /api/correct-card
app.use(cardDbRouter);      // /api/card-db-*
app.use(priceRouter);       // /api/price
app.use(searchRouter);      // /api/search
app.use(healthRouter);      // /api/health
app.use(roomRouter);        // /api/room/:id/*
app.use(quoteLeadRouter);   // /api/quote-lead
app.use(shopRouter);        // /api/shop, /api/shop-config/:slug

// SPA fallback MUST be last (V2_AUDIT §1 — line 5707 in V1).
app.use(staticRoutes.spaFallback);

// Error handler is the very last middleware in the chain.
app.use(errorHandler);

log.info({ phase: 'boot' }, 'apps/server/index.js wired — routes mounted');

export default app;
