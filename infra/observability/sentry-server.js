// infra/observability/sentry-server.js
// Owner: A8 | Slice: S4 (skeleton) → S14 (wired by A1 in server bootstrap)
//
// Sentry Node SDK init wrapper per Q5 in docs/V2_ARCHITECTURE.md.
//
// Per CARD_PRICER_V2_PROMPT.md and the audit's privacy posture, beforeSend
// MUST scrub:
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
//     import { initSentry } from '../infra/observability/sentry-server.js';
//     initSentry({
//       dsn: process.env.SENTRY_DSN_SERVER,
//       environment: process.env.SENTRY_ENVIRONMENT || 'production',
//       release: process.env.GIT_SHA || 'unknown',
//     });
//     // …later, after express() is built…
//     app.use(Sentry.Handlers.requestHandler());
//     app.use(Sentry.Handlers.tracingHandler());
//     // …after all routes…
//     app.use(Sentry.Handlers.errorHandler());
//
// NOTE FOR S5 OWNER (A1): @sentry/node is NOT yet declared in
// package.json. Add it when wiring this into the server bootstrap:
//     npm install @sentry/node
// Until then, importing this module will throw at module-load time.

import * as Sentry from '@sentry/node';
import { createHash } from 'node:crypto';

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
  // Header keys can arrive case-mixed depending on the framework.
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
    // Cleanly no-op so dev/test doesn't ship phantom events. Caller
    // logs this fact via getLogger if it wants visibility.
    return false;
  }

  Sentry.init({
    dsn,
    environment: environment || process.env.SENTRY_ENVIRONMENT || 'production',
    release: release || process.env.GIT_SHA || 'unknown',
    // Sample at 10% to stay under the free-tier quota; bump to 100% if
    // a regression hunt is in flight (set via SENTRY_TRACES_SAMPLE_RATE
    // override here in a follow-up if needed).
    tracesSampleRate: 0.1,
    // Profile only when sampled traces are sampled.
    profilesSampleRate: 0.0,

    beforeSend(event /*, hint */) {
      // (1) + (2): scrub auth + cookie headers
      if (event.request?.headers) {
        event.request.headers = scrubHeaders(event.request.headers);
      }

      // (5): drop request body for any /api/identify event entirely;
      // it is almost certainly a base64 card image.
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
            // For identify breadcrumbs, drop the body but keep the URL
            // + status so the breadcrumb stays diagnostic.
            if (next.data) {
              next.data = {
                ...next.data,
                body: '[REDACTED identify body]',
                request_body_size: next.data.request_body_size,
              };
            }
            if (next.message && next.message.length > 200) {
              next.message = next.message.slice(0, 100) + '…[REDACTED]';
            }
          }
          return next;
        });
      }

      return event;
    },

    beforeBreadcrumb(breadcrumb /*, hint */) {
      if (!breadcrumb) return breadcrumb;
      // Prophylactic strip on the breadcrumb data BEFORE it is buffered
      // into the event, so we don't even hold an in-process base64 blob.
      if (breadcrumb.data) {
        breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
      }
      if (isIdentifyBreadcrumb(breadcrumb) && breadcrumb.data) {
        breadcrumb.data = { ...breadcrumb.data, body: '[REDACTED identify body]' };
      }
      return breadcrumb;
    },
  });

  return true;
}

// Re-export Sentry so callers don't need a second import.
export { Sentry };
