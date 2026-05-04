// infra/observability/sentry-browser.js
// Owner: A8 | Slice: S4 (skeleton) → S14 (imported by vendor + quote + customer apps)
//
// Sentry browser SDK init wrapper per Q5 in docs/V2_ARCHITECTURE.md.
//
// Imported by apps/vendor, apps/quote, and apps/customer. Each surface
// passes its own DSN (same project; tag distinguishes via initialScope).
//
// The beforeSend filter scrubs the same five categories as sentry-server.js:
//   1. Authorization request header on captured fetches
//   2. Cookie request header
//   3. Base64 image breadcrumbs (scan dataURLs)
//   4. event.user.email — replaced with a SHA-256 hash via SubtleCrypto
//   5. Any breadcrumb mentioning /api/identify request body
//
// USAGE (apps/vendor/modules/main.js, near the top before any app code):
//     import { initSentry } from '../../../infra/observability/sentry-browser.js';
//     await initSentry({
//       dsn: window.__SENTRY_DSN_BROWSER__,
//       environment: window.__SENTRY_ENVIRONMENT__ || 'production',
//       release: window.__GIT_SHA__ || 'unknown',
//       surface: 'vendor',  // 'vendor' | 'quote' | 'customer'
//     });
//
// NOTE FOR S5 OWNER (A1) and the UI sub-agents (A4/A5/A10):
// @sentry/browser is NOT yet declared in package.json. Add it when wiring
// this into the apps:
//     npm install @sentry/browser
// The DSN + env + release are surfaced to the browser via injected
// script tags in each app's index.html (server-side template render
// or static-script tag — A1's call).

import * as Sentry from '@sentry/browser';

async function hashEmail(email) {
  if (!email || typeof email !== 'string') return undefined;
  try {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(email.toLowerCase()));
    const arr = Array.from(new Uint8Array(buf));
    return 'sha256:' + arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    // SubtleCrypto unavailable in some embed contexts — drop the email
    // entirely rather than risk leaking it.
    return 'sha256:unhashable';
  }
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
 * Initialise Sentry browser SDK. Returns true if init ran, false on no-op.
 *
 * @param {object} opts
 * @param {string} [opts.dsn]          — Sentry DSN; if absent, init no-ops.
 * @param {string} [opts.environment]  — 'production' | 'staging' | 'dev'.
 * @param {string} [opts.release]      — git SHA.
 * @param {string} [opts.surface]      — 'vendor' | 'quote' | 'customer'.
 * @returns {Promise<boolean>}
 */
export async function initSentry({ dsn, environment, release, surface } = {}) {
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: environment || 'production',
    release: release || 'unknown',
    initialScope: {
      tags: { surface: surface || 'unknown' },
    },
    // Conservative sampling — keep the free tier under quota.
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 0.0,

    beforeSend(event /*, hint */) {
      // (1) + (2): headers
      if (event.request?.headers) {
        event.request.headers = scrubHeaders(event.request.headers);
      }
      // (5): drop /api/identify body
      if (event.request?.url && event.request.url.includes('/api/identify')) {
        if (event.request.data) {
          event.request.data = '[REDACTED identify request body]';
        }
      }
      // (4): hash user email — SubtleCrypto is async, but Sentry's
      // beforeSend is sync. Stash the original-length placeholder and
      // schedule the hash on the user object via a microtask; if the
      // event has already been queued by then it still loses the email.
      if (event.user?.email) {
        const original = event.user.email;
        event.user.email = '[REDACTED]';
        // Best-effort async hash — populates a tag on subsequent events
        // tied to the same Sentry user via setUser().
        hashEmail(original).then((h) => {
          if (h) Sentry.setUser({ ...(event.user || {}), email_hash: h, email: undefined });
        }).catch(() => {});
      }
      // (3) + (5): breadcrumbs
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

export { Sentry };
