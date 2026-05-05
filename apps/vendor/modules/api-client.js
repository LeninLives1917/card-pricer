// apps/vendor/modules/api-client.js
//
// THE ONLY HTTP CLIENT for /api/* in the V2 vendor app (audit R1 mitigation,
// arch §5 F21). Every UI module imports request() / getJson() / postJson()
// / putJson() / streamNdjson() / uploadMultipart() from here. No module is
// allowed to call fetch('/api/...') directly.
//
// Responsibilities (verbatim from V1 wrapped fetch in public/index.html
// 62-104, audit §5.1):
//   1. Inject `Authorization: Bearer <jwt>` from window.sb's Supabase
//      session on every /api/* call.
//   2. On 401, call showAuthOverlay() — unless we're in scanner-mode
//      (URL ?pair=...) which bypasses auth entirely (audit §5.14).
//   3. On 429 with body.error === 'scan_quota_exceeded', call
//      showQuotaExceededModal(body).
//   4. On any 2xx, read X-Scan-Plan / X-Scan-Used / X-Scan-Limit headers
//      and call renderUsage({plan, used, limit}).
//   5. Normalise the result to { ok, status, body, error?, headers }.

const BASE = '/api';

// Hooks the UI registers at boot. Kept module-local so a missing hook is
// silently ignored rather than throwing into the request path.
const hooks = {
  showAuthOverlay: null,
  showQuotaExceededModal: null,
  renderUsage: null,
};

export function setHooks(next) {
  Object.assign(hooks, next || {});
}

function isScannerMode() {
  try {
    return new URLSearchParams(window.location.search).has('pair');
  } catch { return false; }
}

async function getAuthHeader() {
  // Scanner mode bypasses auth entirely (audit §5.14): no JWT, no auth modal.
  if (isScannerMode()) return null;
  const sb = window.sb;
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    return token ? ('Bearer ' + token) : null;
  } catch {
    return null;
  }
}

function maybeFireUsage(resp) {
  try {
    const used = resp.headers.get('X-Scan-Used');
    const plan = resp.headers.get('X-Scan-Plan');
    if (used != null && plan && typeof hooks.renderUsage === 'function') {
      const limitHdr = resp.headers.get('X-Scan-Limit');
      hooks.renderUsage({
        plan,
        used: parseInt(used, 10),
        limit: limitHdr != null ? parseInt(limitHdr, 10) : null,
      });
    }
  } catch { /* non-fatal */ }
}

async function maybeFireQuota(resp) {
  if (resp.status !== 429) return;
  try {
    const body = await resp.clone().json();
    if (body?.error === 'scan_quota_exceeded' && typeof hooks.showQuotaExceededModal === 'function') {
      hooks.showQuotaExceededModal(body);
    }
  } catch { /* non-JSON 429 — ignore */ }
}

function maybeFireAuth(resp) {
  if (resp.status !== 401) return;
  if (isScannerMode()) return;
  if (typeof hooks.showAuthOverlay === 'function') hooks.showAuthOverlay();
}

function joinPath(path) {
  if (!path) return BASE;
  if (path.startsWith('http')) return path; // absolute — bypass
  if (path.startsWith('/api/')) return path;
  if (path.startsWith('/')) return path;
  return BASE + '/' + path;
}

// Core request. All convenience wrappers below funnel through this.
//
// options: { method, headers, body, signal, raw }
//   - body: string | object (auto-JSON) | FormData | Blob
//   - raw: if true, returns the Response object instead of parsed body
export async function request(path, options = {}) {
  const url = joinPath(path);
  const init = {
    method: options.method || 'GET',
    headers: new Headers(options.headers || {}),
    signal: options.signal,
  };

  // Auth (skipped in scanner-mode).
  const auth = await getAuthHeader();
  if (auth) init.headers.set('Authorization', auth);

  // Body handling.
  if (options.body != null) {
    if (options.body instanceof FormData || options.body instanceof Blob) {
      init.body = options.body;
      // Don't set Content-Type — the browser provides multipart boundary.
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
    return { ok: false, status: 0, body: null, error: err?.message || 'network', headers: null };
  }

  // Side-effects: auth modal, quota modal, usage banner.
  maybeFireAuth(resp);
  await maybeFireQuota(resp);
  if (resp.ok) maybeFireUsage(resp);

  if (options.raw) {
    return { ok: resp.ok, status: resp.status, body: null, headers: resp.headers, response: resp };
  }

  // Parse body. JSON if content-type says so; otherwise text.
  let body = null;
  const ct = resp.headers.get('Content-Type') || '';
  try {
    if (ct.includes('application/json')) {
      body = await resp.json();
    } else if (ct.startsWith('text/')) {
      body = await resp.text();
    } else if (resp.status !== 204) {
      // Best-effort: try JSON, fall back to text.
      const txt = await resp.text();
      try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    }
  } catch { /* leave body=null */ }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      body,
      error: (body && (body.error || body.message)) || ('http_' + resp.status),
      headers: resp.headers,
    };
  }
  return { ok: true, status: resp.status, body, headers: resp.headers };
}

export function getJson(path, options = {}) {
  return request(path, { ...options, method: 'GET' });
}

export function postJson(path, body, options = {}) {
  return request(path, { ...options, method: 'POST', body });
}

export function putJson(path, body, options = {}) {
  return request(path, { ...options, method: 'PUT', body });
}

export function patchJson(path, body, options = {}) {
  return request(path, { ...options, method: 'PATCH', body });
}

export function uploadMultipart(path, formData, options = {}) {
  if (!(formData instanceof FormData)) {
    throw new Error('uploadMultipart requires a FormData');
  }
  return request(path, { ...options, method: 'POST', body: formData });
}

// Streaming NDJSON reader for /api/identify-stream (audit §1b — emits
// {type:'ident'}, {type:'verified'}, {type:'error'}, {type:'done'}). Falls
// back to the non-streaming /api/identify endpoint if the streaming response
// is malformed (mirrors V1 fetchIdentifyStream behaviour).
//
// Returns: { ok, body: { cards }, error? }
export async function streamNdjson(path, body, onEvent) {
  const url = joinPath(path);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const auth = await getAuthHeader();
  if (auth) headers.set('Authorization', auth);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err?.message || 'network' };
  }

  maybeFireAuth(resp);
  await maybeFireQuota(resp);
  if (resp.ok) maybeFireUsage(resp);

  if (!resp.ok || !resp.body) {
    // Caller (bulk worker etc.) is responsible for falling back to
    // /api/identify if needed — return a normalised error envelope.
    let parsed = null;
    try { parsed = await resp.json(); } catch {}
    return {
      ok: false,
      status: resp.status,
      body: parsed,
      error: (parsed && (parsed.error || parsed.details)) || ('http_' + resp.status),
    };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let identCards = null;
  let verifiedCards = null;
  let errMsg = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (typeof onEvent === 'function') {
        try { onEvent(ev); } catch { /* swallow handler error */ }
      }
      if (ev.type === 'ident') identCards = ev.cards;
      else if (ev.type === 'verified') verifiedCards = ev.cards;
      else if (ev.type === 'error') errMsg = ev.error;
    }
  }

  if (errMsg) return { ok: false, status: resp.status, body: null, error: errMsg };
  return {
    ok: true,
    status: resp.status,
    body: { cards: verifiedCards || identCards || [] },
  };
}

// Tiny sugar for the read-only public endpoints we hit a lot.
export const api = {
  me:        () => getJson('/api/me'),
  usage:     () => getJson('/api/usage'),
  health:    () => getJson('/api/health'),
  state:     () => getJson('/api/state'),
  saveState: (state) => putJson('/api/state', { state }),
  shop:      () => getJson('/api/shop'),
  search:    (q) => getJson('/api/search?q=' + encodeURIComponent(q)),
};
