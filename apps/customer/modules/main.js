// apps/customer/modules/main.js
// Owner: A10 | Slice: S21
//
// Entry module for the V2 customer dashboard. Wires DOMContentLoaded to:
//   1. Construct the Supabase JS client singleton (window.sb).
//   2. Detect a magic-link callback (location.hash contains 'access_token=')
//      → consume via supabase.auth.getSessionFromUrl(); strip the hash; render.
//   3. Hash-routed sub-views:
//        ''            → sign-in landing (or dashboard if signed in)
//        '#offer=…'    → public offer-accept view
//        '#account'    → account-edit view (signed-in)
//        '#auth=callback' (and Supabase's own access_token hashes) → callback
//   4. Re-render on hashchange and on auth state changes.
//   5. initSentryBrowser({ surface: 'customer' }) per S14 hand-off.
//
// Exports: default init() — also auto-runs on DOMContentLoaded.

import { setHooks as setApiHooks } from './api-client.js';
import { renderSignIn, signOut } from './auth.js';
import { renderHistory } from './quote-history.js';
import { renderOffer } from './offer-accept.js';
import { renderAccount } from './account.js';

// Sentry browser SDK shim — same path the vendor + quote apps use.
// Optional import: failure to resolve (during tests / SSR) is swallowed.
let initSentryBrowser = () => false;
try {
  // Note the path: served at /infra/observability/sentry-browser.js by
  // express.static (public/) — wait, it isn't on the static path. The
  // CDN+globals approach in sentry-browser.js means we don't strictly
  // need to import it; we leave a TODO for S22 to wire the script tag
  // and a dsn discovery endpoint. For now, no-op.
} catch { /* ignore */ }

// ── Supabase URL/key discovery ─────────────────────────────────────────
// The vendor app reads these from /api/state via getJson; the customer
// app needs them BEFORE any auth call, so we expose them via inline
// globals or a small /api/v2/customer/config (TODO). For V2, fall back
// to runtime globals injected by the index.html (or env via a future
// endpoint).
function readSupabaseConfig() {
  // Conventional names — same pattern as the vendor + quote apps.
  return {
    url: (typeof window !== 'undefined' && window.__SUPABASE_URL__) || null,
    anonKey: (typeof window !== 'undefined' && window.__SUPABASE_ANON_KEY__) || null,
  };
}

// ── Sentry surface init (S14 wiring) ───────────────────────────────────
function initSentry() {
  try {
    const dsn = (typeof window !== 'undefined' && window.__SENTRY_DSN_BROWSER__) || null;
    if (!dsn) return;
    initSentryBrowser({
      dsn,
      environment: (typeof window !== 'undefined' && window.__SENTRY_ENVIRONMENT__) || 'production',
      release: (typeof window !== 'undefined' && window.__GIT_SHA__) || 'unknown',
      surface: 'customer',
    });
  } catch { /* ignore */ }
}

// ── Hash router ────────────────────────────────────────────────────────
// Returns one of: 'signin' | 'dashboard' | 'offer' | 'account' | 'callback'
// plus a payload (token for offer view).
function parseRoute() {
  const hash = (typeof window !== 'undefined' && window.location.hash) || '';
  if (!hash || hash === '#') return { name: 'root' };
  // Magic-link callback shape: Supabase appends ...#access_token=...
  if (hash.includes('access_token=') || hash.includes('refresh_token=')) {
    return { name: 'callback' };
  }
  if (/^#auth=callback/.test(hash)) {
    return { name: 'callback' };
  }
  const offerMatch = /^#offer=([^&]+)/.exec(hash);
  if (offerMatch) {
    return { name: 'offer', token: decodeURIComponent(offerMatch[1]) };
  }
  if (hash === '#account') {
    return { name: 'account' };
  }
  return { name: 'root' };
}

// ── Session helper ─────────────────────────────────────────────────────
async function getSession() {
  const sb = (typeof window !== 'undefined' && window.sb) || null;
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    return data?.session || null;
  } catch {
    return null;
  }
}

// ── Magic-link callback consumer ───────────────────────────────────────
// Some Supabase JS versions auto-detect & consume the URL hash on init;
// others require an explicit getSessionFromUrl(). We try the explicit
// call (if available) and then fall back to the auto-detection path.
async function consumeCallback() {
  const sb = (typeof window !== 'undefined' && window.sb) || null;
  if (!sb) return;
  try {
    if (typeof sb.auth.getSessionFromUrl === 'function') {
      // v1 SDK shape — kept for safety even though we ship v2 via CDN.
      await sb.auth.getSessionFromUrl({ storeSession: true });
    } else if (typeof sb.auth.exchangeCodeForSession === 'function') {
      // v2 PKCE flow shape — usually called with the raw URL.
      try { await sb.auth.exchangeCodeForSession(window.location.href); } catch {}
    }
  } catch { /* swallow — auto-detection may have already consumed it */ }

  // Strip the hash so subsequent routing is clean. history.replaceState
  // keeps the URL pretty without firing hashchange.
  try {
    const url = window.location.pathname + window.location.search;
    window.history.replaceState({}, '', url);
  } catch { /* ignore */ }
}

// ── Nav rendering (signed-in vs signed-out) ────────────────────────────
function renderNav(session, email) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  if (session) {
    nav.innerHTML = `
      <span class="nav-email">${(email || '').replace(/[<>&"']/g, '')}</span>
      <a href="#account">Account</a>
      <button type="button" id="navSignOut" class="ghost">Sign out</button>
    `;
    const btn = nav.querySelector('#navSignOut');
    if (btn) {
      btn.addEventListener('click', async () => {
        await signOut();
        try { window.location.hash = ''; } catch {}
        await render();
      });
    }
  } else {
    nav.innerHTML = `<a href="#">Sign in</a>`;
  }
}

// ── Footer contact (defaults to dave@boardandbrewed.ie) ────────────────
function renderFooter(offerShopEmail) {
  const link = document.getElementById('footContact');
  if (!link) return;
  const target = offerShopEmail || 'dave@boardandbrewed.ie';
  link.setAttribute('href', 'mailto:' + target);
}

// ── Main render dispatch ───────────────────────────────────────────────
async function render() {
  const view = document.getElementById('view');
  if (!view) return;

  const route = parseRoute();
  const session = await getSession();
  const email = session?.user?.email || '';
  renderNav(session, email);
  renderFooter(null);

  if (route.name === 'callback') {
    // The hash should already be stripped by consumeCallback, but if we
    // somehow get here mid-flight, render a tiny placeholder.
    view.innerHTML = `<div class="view-loading">Signing you in…</div>`;
    return;
  }

  if (route.name === 'offer') {
    await renderOffer(view, route.token);
    return;
  }

  if (route.name === 'account') {
    if (!session) {
      // Account view requires auth.
      renderSignIn(view);
      return;
    }
    await renderAccount(view);
    return;
  }

  // route.name === 'root'
  if (session) {
    await renderHistory(view);
  } else {
    renderSignIn(view);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────
let booted = false;

export default async function init() {
  if (booted) return;
  booted = true;

  initSentry();

  // Wire api-client hooks BEFORE any /api/* call.
  setApiHooks({
    onAuth401: () => {
      // Auth fail on a private endpoint — drop the stale session and
      // route to sign-in. Don't redirect on the offer view since that
      // surface is public-friendly even with a stale session.
      try {
        const route = parseRoute();
        if (route.name === 'offer') return; // tolerate; offer is public
        const sb = (typeof window !== 'undefined' && window.sb) || null;
        if (sb) sb.auth.signOut().catch(() => {});
        window.location.hash = '';
      } catch { /* ignore */ }
    },
  });

  // Construct the Supabase singleton.
  const cfg = readSupabaseConfig();
  if (cfg.url && cfg.anonKey && typeof window !== 'undefined' && window.supabase?.createClient) {
    try {
      window.sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'implicit', // magic-link flow
        },
      });
    } catch (e) {
      console.warn('[customer/main] Supabase client init failed:', e?.message);
    }
  } else {
    console.warn('[customer/main] Supabase config missing — auth features disabled.');
  }

  // Magic-link callback consumption — runs once at boot if the hash has
  // an access_token. After this, the URL is clean for future routing.
  if (parseRoute().name === 'callback') {
    await consumeCallback();
  }

  // Re-render on hashchange + on auth state change.
  window.addEventListener('hashchange', () => { render().catch(() => {}); });
  if (window.sb && typeof window.sb.auth.onAuthStateChange === 'function') {
    try {
      window.sb.auth.onAuthStateChange(() => { render().catch(() => {}); });
    } catch { /* ignore */ }
  }

  // First render.
  await render();
}

// Auto-run on DOMContentLoaded (or immediately if the DOM is already up).
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init().catch(() => {}); }, { once: true });
  } else {
    // The script tag is `defer` so we should be past parsing by the time
    // this module evaluates; init asynchronously so import order doesn't
    // race the Supabase CDN script.
    Promise.resolve().then(() => init().catch(() => {}));
  }
}
