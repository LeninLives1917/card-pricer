// infra/observability/sentry-browser.js
// Owner: A8 | Slice: S14 (final)
//
// Sentry browser SDK init wrapper per Q5 in docs/V2_ARCHITECTURE.md.
//
// =====================================================================
//  IMPORTANT — CDN-LOAD APPROACH (no npm bundler)
// =====================================================================
// The vendor / quote / customer apps are vanilla ES modules served as
// static files. There is no bundler, so we cannot npm install
// @sentry/browser and `import` it — there's nothing to resolve the
// import specifier. Instead, each app's index.html embeds Sentry's
// official CDN bundle BEFORE this module is imported:
//
//     <!-- index.html, in <head>, BEFORE module scripts -->
//     <script
//       src="https://browser.sentry-cdn.com/8.55.0/bundle.tracing.min.js"
//       integrity="sha384-…"
//       crossorigin="anonymous"
//       defer></script>
//
// The CDN script attaches a global `window.Sentry` with the same surface
// as the npm package. This module reads `window.Sentry` at runtime —
// it is intentionally provider-free and has zero `import` statements
// for the SDK so it can be loaded without a bundler resolving anything.
//
// If `window.Sentry` is missing (CDN blocked, ad-blocker, ?dnt= set,
// offline cache, etc.) initSentryBrowser is a clean no-op.
//
// PUBLIC API:
//     import { initSentryBrowser } from '/infra/observability/sentry-browser.js';
//     initSentryBrowser({
//       dsn: window.__SENTRY_DSN_BROWSER__,
//       environment: window.__SENTRY_ENVIRONMENT__ || 'production',
//       release: window.__GIT_SHA__ || 'unknown',
//       surface: 'vendor',  // 'vendor' | 'quote' | 'customer'
//     });
//
// HAND-OFF FOR S22 (cutover):
//   Each app's index.html needs:
//     1. The <script src="https://browser.sentry-cdn.com/.../bundle.tracing.min.js"> tag.
//     2. A small inline <script> exposing dsn/env/release via window.__SENTRY_*__ globals
//        OR via a fetched /api/version-style envelope.
//     3. A call to initSentryBrowser() from the app's main module.
//   The Sentry script tag is intentionally NOT added in S14 — that's
//   the S22 mobile-restyle / cutover slice's owner.

async function hashEmail(email) {
  if (!email || typeof email !== 'string') return undefined;
  try {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(email.toLowerCase()));
    const arr = Array.from(new Uint8Array(buf));
    return 'sha256:' + arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    // SubtleCrypto unavailable — drop the email rather than risk leaking it.
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

function makeBeforeSend(SentryRef) {
  return function beforeSend(event /*, hint */) {
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
    // (4): hash user email — SubtleCrypto is async, beforeSend is sync.
    // Replace with a placeholder synchronously, then update setUser
    // asynchronously for subsequent events.
    if (event.user?.email) {
      const original = event.user.email;
      event.user.email = '[REDACTED]';
      hashEmail(original).then((h) => {
        if (h && SentryRef && typeof SentryRef.setUser === 'function') {
          SentryRef.setUser({ ...(event.user || {}), email_hash: h, email: undefined });
        }
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
            next.message = next.message.slice(0, 100) + '...[REDACTED]';
          }
        }
        return next;
      });
    }
    return event;
  };
}

function makeBeforeBreadcrumb() {
  return function beforeBreadcrumb(breadcrumb /*, hint */) {
    if (!breadcrumb) return breadcrumb;
    if (breadcrumb.data) {
      breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
    }
    if (isIdentifyBreadcrumb(breadcrumb) && breadcrumb.data) {
      breadcrumb.data = { ...breadcrumb.data, body: '[REDACTED identify body]' };
    }
    return breadcrumb;
  };
}

/**
 * Initialise Sentry browser SDK. Returns true if init ran, false on no-op.
 *
 * @param {object} opts
 * @param {string} [opts.dsn]          — Sentry DSN; if absent, init no-ops.
 * @param {string} [opts.environment]  — 'production' | 'staging' | 'dev'.
 * @param {string} [opts.release]      — git SHA.
 * @param {string} [opts.surface]      — 'vendor' | 'quote' | 'customer'.
 * @returns {boolean}
 */
export function initSentryBrowser({ dsn, environment, release, surface } = {}) {
  if (!dsn) return false;
  // The CDN bundle exposes window.Sentry. If absent (script blocked /
  // not yet loaded / running outside a browser), no-op cleanly.
  const SentryRef =
    (typeof globalThis !== 'undefined' && globalThis.Sentry) ||
    (typeof window !== 'undefined' && window.Sentry) ||
    null;
  if (!SentryRef || typeof SentryRef.init !== 'function') return false;

  SentryRef.init({
    dsn,
    environment: environment || 'production',
    release: release || 'unknown',
    initialScope: {
      tags: { surface: surface || 'unknown' },
    },
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.0,
    replaysOnErrorSampleRate: 0.0,
    beforeSend: makeBeforeSend(SentryRef),
    beforeBreadcrumb: makeBeforeBreadcrumb(),
  });

  return true;
}

// Backward-compat alias — some early scaffold files import `initSentry`.
export const initSentry = initSentryBrowser;

export default initSentryBrowser;
