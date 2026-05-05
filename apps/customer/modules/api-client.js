// apps/customer/modules/api-client.js
// Owner: A10 | Slice: S21
//
// THE ONLY HTTP client for /api/* in the V2 customer app. Mirrors
// apps/vendor/modules/api-client.js (R1 mitigation, arch §5 F21) but
// tuned for the customer surface:
//
//   1. Inject Authorization: Bearer <jwt> from window.sb's Supabase
//      session on every /api/* call EXCEPT for clearly-public paths
//      (PUBLIC_PATHS) — magic-link, public offer GET/accept/decline.
//   2. On 401, fire onAuth401 hook (main.js redirects to '#') instead
//      of an auth modal — friendlier than the vendor terminal.
//   3. On 410 (offer expired) and 404 (offer/account not found), fire
//      onOfferGone — the offer-accept view renders a fallback.
//   4. No quota modal — customer paths aren't quota-gated.
//   5. Tracks last-401 timestamp to avoid redirect loops when multiple
//      requests fire in parallel (mirrors vendor's defensive pattern).
//
// Exports: request, getJson, postJson, patchJson, setHooks, PUBLIC_PATHS.

// Public-by-design paths: NO Authorization header attached even if a
// session exists. These endpoints are explicitly token-or-public on the
// server (apps/server/routes/quote-offer.js, customer.js magic-link).
//
// Match shape:
//   POST /api/v2/customer/magic-link
//   GET  /api/v2/quote-offer/<token>
//   POST /api/v2/quote-offer/<token>/accept
//   POST /api/v2/quote-offer/<token>/decline
export const PUBLIC_PATHS =
  /^\/api\/v2\/(customer\/magic-link|quote-offer\/[^/]+(\/(accept|decline))?)$/;

const BASE = '/api';

const hooks = {
  onAuth401: null,        // main.js -> redirect to '#'
  onOfferGone: null,      // offer-accept.js -> friendly expired/not-found view
  onError: null,          // optional global error sink
};

let last401At = 0;

export function setHooks(next) {
  Object.assign(hooks, next || {});
}

function isPublicPath(path) {
  return PUBLIC_PATHS.test(path);
}

async function getAuthHeader(path) {
  if (isPublicPath(path)) return null;
  const sb = (typeof window !== 'undefined' && window.sb) || null;
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    return token ? ('Bearer ' + token) : null;
  } catch {
    return null;
  }
}

function joinPath(path) {
  if (!path) return BASE;
  if (path.startsWith('http')) return path;
  if (path.startsWith('/api/')) return path;
  if (path.startsWith('/')) return path;
  return BASE + '/' + path;
}

function maybeFireAuth(resp, path) {
  if (resp.status !== 401) return;
  if (isPublicPath(path)) return; // Public paths shouldn't auth-fail us
  const now = Date.now();
  if (now - last401At < 1500) return; // de-dupe parallel 401s
  last401At = now;
  if (typeof hooks.onAuth401 === 'function') {
    try { hooks.onAuth401(); } catch { /* swallow */ }
  }
}

function maybeFireOfferGone(resp, path) {
  if (resp.status !== 404 && resp.status !== 410) return;
  // Only relevant for the offer endpoints — main.js can opt in per-call too.
  if (!/^\/api\/v2\/quote-offer\//.test(path)) return;
  if (typeof hooks.onOfferGone === 'function') {
    try { hooks.onOfferGone({ status: resp.status, path }); } catch { /* swallow */ }
  }
}

// Core request — every convenience wrapper funnels through this.
//
// options: { method, headers, body, signal, raw, skipAuth }
//   - body: string | object (auto-JSON) | FormData | Blob
//   - raw: if true, returns Response object instead of parsed body
//   - skipAuth: forcibly drop the JWT even when path is non-public
export async function request(path, options = {}) {
  const url = joinPath(path);
  const init = {
    method: options.method || 'GET',
    headers: new Headers(options.headers || {}),
    signal: options.signal,
  };

  if (!options.skipAuth) {
    const auth = await getAuthHeader(path);
    if (auth) init.headers.set('Authorization', auth);
  }

  if (options.body != null) {
    if (options.body instanceof FormData || options.body instanceof Blob) {
      init.body = options.body;
    } else if (typeof options.body === 'string') {
      init.body = options.body;
      if (!init.headers.has('Content-Type')) {
        init.headers.set('Content-Type', 'application/json');
      }
    } else {
      init.body = JSON.stringify(options.body);
      if (!init.headers.has('Content-Type')) {
        init.headers.set('Content-Type', 'application/json');
      }
    }
  }

  let resp;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    const out = { ok: false, status: 0, body: null, error: err?.message || 'network', headers: null };
    if (typeof hooks.onError === 'function') { try { hooks.onError(out); } catch {} }
    return out;
  }

  maybeFireAuth(resp, path);
  maybeFireOfferGone(resp, path);

  if (options.raw) {
    return { ok: resp.ok, status: resp.status, body: null, headers: resp.headers, response: resp };
  }

  let body = null;
  const ct = resp.headers.get('Content-Type') || '';
  try {
    if (ct.includes('application/json')) {
      body = await resp.json();
    } else if (ct.startsWith('text/')) {
      body = await resp.text();
    } else if (resp.status !== 204) {
      const txt = await resp.text();
      try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    }
  } catch { /* leave body=null */ }

  if (!resp.ok) {
    const out = {
      ok: false,
      status: resp.status,
      body,
      error: (body && (body.error || body.message)) || ('http_' + resp.status),
      headers: resp.headers,
    };
    if (typeof hooks.onError === 'function') { try { hooks.onError(out); } catch {} }
    return out;
  }
  return { ok: true, status: resp.status, body, headers: resp.headers };
}

export function getJson(path, options = {}) {
  return request(path, { ...options, method: 'GET' });
}

export function postJson(path, body, options = {}) {
  return request(path, { ...options, method: 'POST', body });
}

export function patchJson(path, body, options = {}) {
  return request(path, { ...options, method: 'PATCH', body });
}

// Sugar for the customer-side endpoints we hit a lot.
export const api = {
  me:        () => getJson('/api/v2/customer/me'),
  saveMe:    (fields) => patchJson('/api/v2/customer/me', fields),
  offers:    () => getJson('/api/v2/customer/offers'),
  magicLink: (email, redirectTo) =>
    postJson('/api/v2/customer/magic-link', { email, redirectTo }),
  offer:     (token) => getJson('/api/v2/quote-offer/' + encodeURIComponent(token)),
  accept:    (token) =>
    postJson('/api/v2/quote-offer/' + encodeURIComponent(token) + '/accept', {}),
  decline:   (token) =>
    postJson('/api/v2/quote-offer/' + encodeURIComponent(token) + '/decline', {}),
};
