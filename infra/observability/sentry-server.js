// infra/observability/sentry-server.js
// Owner: A8 | Slice: S14 (final)
//
// Sentry Node SDK init wrapper per Q5 in docs/V2_ARCHITECTURE.md.
//
// IMPORTANT — Sentry Node v10 API change:
// In Sentry v8+ the legacy Sentry.Handlers.{requestHandler,tracingHandler,errorHandler}
// are gone. v10 uses OpenTelemetry under the hood — request + tracing
// instrumentation is automatic when initSentry() is called BEFORE express()
// is constructed. Express integration is registered automatically.
//
// We expose `requestHandler`, `tracingHandler`, `errorHandler` Express
// middleware factories so apps/server/index.js stays declarative. Under
// the hood:
//   - requestHandler / tracingHandler are NO-OP pass-throughs (kept for
//     wiring symmetry; v10 hooks via OTel).
//   - errorHandler delegates to Sentry.expressErrorHandler() — which
//     captures unhandled errors and forwards to Sentry, then `next(err)`s
//     to the existing application errorHandler sink.
//
// beforeSend MUST scrub:
//   1. event.request.headers.authorization
//   2. event.request.headers.cookie
//   3. any breadcrumb data field that looks like a base64 image
//      (data: URL prefix `data:image/`)
//   4. event.user.email — replaced with a deterministic SHA-256 hash so
//      the event is still groupable per-user without leaking PII
//   5. any breadcrumb that mentions `/api/identify` request body (the
//      body almost always contains a base64 card image)
//
// USAGE (apps/server/index.js):
//     import { initSentry, requestHandler, tracingHandler, errorHandler as sentryError }
//       from '../infra/observability/sentry-server.js';
//     initSentry({
//       dsn: process.env.SENTRY_DSN_SERVER,
//       environment: process.env.SENTRY_ENVIRONMENT || 'production',
//       release: process.env.GIT_SHA || 'unknown',
//     });
//     // BEFORE express() is built, ideally at the top of the entrypoint.
//     // …later, after express() is built…
//     app.use(requestHandler());
//     app.use(tracingHandler());
//     // …after all routes…
//     app.use(sentryError());

import * as Sentry from '@sentry/node';
import { createHash } from 'node:crypto';

let initialised = false;

// Hash an email so we keep per-user grouping in Sentry without storing
// the actual address. Salted with a build-time constant so dumps are
// not trivially rainbow-tableable; rotates with each deploy via GIT_SHA.
function hashEmail(email) {
  if (!email || typeof email !== 'string') return undefined;
  const salt = process.env.GIT_SHA || 'cardpricer-v2';
  return 'sha256:' + createHash('sha256').update(salt + ':' + email.toLowerCase()).digest('hex').slice(0, 16);
}

function scrubHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const cleaned = { ...headers };
  for (const key of Object.keys(cleaned)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie') {
      cleaned[key] = '[REDACTED]';
    }
  }
  return cleaned;
}

function scrubBreadcrumbData(data) {
  if (!data || typeof data !== 'object') return data;
  const cleaned = { ...data };
  for (const [k, v] of Object.entries(cleaned)) {
    if (typeof v === 'string' && v.startsWith('data:image/')) {
      cleaned[k] = `[REDACTED data:image/* ${v.length} bytes]`;
    }
  }
  return cleaned;
}

function isIdentifyBreadcrumb(breadcrumb) {
  if (!breadcrumb) return false;
  const url = breadcrumb?.data?.url || '';
  const message = breadcrumb?.message || '';
  return url.includes('/api/identify') || message.includes('/api/identify');
}

/**
 * Initialise Sentry Node SDK for the Card-Pricer V2 server.
 *
 * @param {object} opts
 * @param {string} [opts.dsn]          — Sentry DSN; if absent, init no-ops.
 * @param {string} [opts.environment]  — e.g. 'production', 'staging'.
 * @param {string} [opts.release]      — git SHA. Surfaces in /api/version too.
 * @returns {boolean} true if init ran, false if no-op'd.
 */
export function initSentry({ dsn, environment, release } = {}) {
  if (!dsn) {
    // Cleanly no-op so dev/test doesn't ship phantom events.
    initialised = false;
    return false;
  }

  Sentry.init({
    dsn,
    environment: environment || process.env.SENTRY_ENVIRONMENT || 'production',
    release: release || process.env.GIT_SHA || 'unknown',
    // 10% trace sample to stay under the free-tier quota.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
    profilesSampleRate: 0.0,
    // v10 enables OTel integrations automatically; we keep the default set.

    beforeSend(event /*, hint */) {
      // (1) + (2): scrub auth + cookie headers
      if (event.request?.headers) {
        event.request.headers = scrubHeaders(event.request.headers);
      }

      // (5): drop request body for any /api/identify event entirely
      if (event.request?.url && event.request.url.includes('/api/identify')) {
        if (event.request.data) {
          event.request.data = '[REDACTED identify request body]';
        }
      }

      // (4): hash event.user.email if present.
      if (event.user?.email) {
        event.user.email_hash = hashEmail(event.user.email);
        delete event.user.email;
      }

      // (3) + (5): walk breadcrumbs and scrub.
      if (Array.isArray(event.breadcrumbs)) {
        event.breadcrumbs = event.breadcrumbs.map((bc) => {
          if (!bc) return bc;
          const next = { ...bc };
          if (next.data) {
            next.data = scrubBreadcrumbData(next.data);
          }
          if (isIdentifyBreadcrumb(next)) {
            if (next.data) {
              next.data = {
                ...next.data,
                body: '[REDACTED identify body]',
                request_body_size: next.data.request_body_size,
              };
            }
            if (next.message && next.message.length > 200) {
              next.message = next.message.slice(0, 100) + '...[REDACTED]';
            }
          }
          return next;
        });
      }

      return event;
    },

    beforeBreadcrumb(breadcrumb /*, hint */) {
      if (!breadcrumb) return breadcrumb;
      if (breadcrumb.data) {
        breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
      }
      if (isIdentifyBreadcrumb(breadcrumb) && breadcrumb.data) {
        breadcrumb.data = { ...breadcrumb.data, body: '[REDACTED identify body]' };
      }
      return breadcrumb;
    },
  });

  initialised = true;
  return true;
}

/**
 * Express request handler. v10 has no explicit request handler — OTel
 * instrumentation hooks the Express integration automatically. We return
 * a pass-through middleware so the wiring in apps/server/index.js stays
 * symmetrical with the documented architecture.
 */
export function requestHandler() {
  return function sentryRequestHandler(_req, _res, next) {
    next();
  };
}

/**
 * Express tracing handler. Same rationale as requestHandler — v10 traces
 * via OTel automatically once initSentry() runs.
 */
export function tracingHandler() {
  return function sentryTracingHandler(_req, _res, next) {
    next();
  };
}

/**
 * Express error handler. Delegates to Sentry.expressErrorHandler() (v10)
 * if Sentry is initialised; otherwise a pass-through.
 *
 * IMPORTANT: this middleware reports the error to Sentry then forwards
 * with next(err) so the application's terminal errorHandler (the one
 * that returns the JSON 500 response) still runs.
 */
export function errorHandler() {
  if (!initialised) {
    return function sentryErrorHandlerNoOp(err, _req, _res, next) {
      next(err);
    };
  }
  return Sentry.expressErrorHandler();
}

export function isInitialised() {
  return initialised;
}

// Re-export Sentry so callers don't need a second import.
export { Sentry };
