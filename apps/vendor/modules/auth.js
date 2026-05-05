// apps/vendor/modules/auth.js
//
// Sign-in / sign-up / sign-out flows. Wraps window.sb (Supabase client).
// Exposes the same overlay show/hide contract V1 used so the api-client's
// 401 hook (showAuthOverlay) keeps working unchanged.
//
// The DOM contract: index.html ships #authOverlay (hidden by default once
// boot has confirmed a session) with #authEmail / #authPassword /
// #authSubmitBtn / #authError / #authOk inside, plus tabs with data-mode
// = login | signup driving setAuthMode().

let _mode = 'login';

export function setAuthMode(mode) {
  _mode = mode;
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  const submit = document.getElementById('authSubmitBtn');
  if (submit) submit.textContent = mode === 'login' ? 'Log in' : 'Create account';
  const pwd = document.getElementById('authPassword');
  if (pwd) pwd.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  const err = document.getElementById('authError');
  if (err) err.textContent = '';
}

export function showAuthOverlay() {
  const o = document.getElementById('authOverlay');
  if (o) o.classList.remove('hidden');
}

export function hideAuthOverlay() {
  const o = document.getElementById('authOverlay');
  if (o) o.classList.add('hidden');
}

export async function submitAuth() {
  const sb = window.sb;
  if (!sb) return;
  const email = document.getElementById('authEmail')?.value.trim() || '';
  const password = document.getElementById('authPassword')?.value || '';
  const errEl = document.getElementById('authError');
  const okEl = document.getElementById('authOk');
  const btn = document.getElementById('authSubmitBtn');
  if (errEl) errEl.textContent = '';
  if (okEl) okEl.style.display = 'none';

  if (!email || !password) {
    if (errEl) errEl.textContent = 'Email and password required.';
    return;
  }
  if (password.length < 6) {
    if (errEl) errEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = _mode === 'login' ? 'Logging in…' : 'Creating account…';
  }

  try {
    const result = _mode === 'login'
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password });

    if (result.error) {
      if (errEl) errEl.textContent = result.error.message || 'Auth failed.';
      return;
    }
    // Sign-up may return no session if confirmation email is required.
    if (!result.data.session) {
      if (okEl) {
        okEl.style.display = 'block';
        okEl.textContent = 'Check your email for a confirmation link.';
      }
      return;
    }
    // Welcome email on signup only — fire-and-forget through the wrapped fetch.
    if (_mode === 'signup') {
      try {
        const { postJson } = await import('./api-client.js');
        postJson('/api/welcome-email', null).catch(() => {});
      } catch { /* ignore */ }
    }
    hideAuthOverlay();
    location.reload();
  } catch (e) {
    if (errEl) errEl.textContent = e?.message || 'Unexpected error.';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = _mode === 'login' ? 'Log in' : 'Create account';
    }
  }
}

export async function signOut() {
  const sb = window.sb;
  if (!sb) return;
  try { await sb.auth.signOut(); } catch {}
  location.reload();
}

// Boot-time auth gate. Returns {sessionUser, isAdmin}; in scanner-mode
// returns {sessionUser:null, isAdmin:false} without showing the overlay.
export async function initAuthGate({ onAdmin } = {}) {
  const sb = window.sb;
  if (!sb) {
    console.warn('[AUTH] Supabase client missing');
    return { sessionUser: null, isAdmin: false };
  }
  const isScanner = new URLSearchParams(location.search).has('pair');
  if (isScanner) return { sessionUser: null, isAdmin: false };

  try {
    const { data } = await sb.auth.getSession();
    if (!data?.session) {
      showAuthOverlay();
      return { sessionUser: null, isAdmin: false };
    }
    const user = data.session.user;
    const label = document.getElementById('authAccountLabel');
    if (label) label.textContent = user?.email || '(logged in)';
    // Reveal admin tab if /api/me says so. Failure here is non-fatal.
    let isAdmin = false;
    try {
      const { api } = await import('./api-client.js');
      const r = await api.me();
      if (r.ok && r.body?.is_admin) {
        isAdmin = true;
        const adminBtn = document.getElementById('adminTabBtn');
        if (adminBtn) adminBtn.classList.remove('hidden');
        if (typeof onAdmin === 'function') onAdmin();
      }
    } catch (_) { /* non-fatal */ }
    return { sessionUser: user, isAdmin };
  } catch (e) {
    console.error('[AUTH] session check failed:', e);
    showAuthOverlay();
    return { sessionUser: null, isAdmin: false };
  }
}

// Wire the overlay's onclick handlers without inline JS in index.html.
export function wireAuthOverlay() {
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.addEventListener('click', () => setAuthMode(t.dataset.mode));
  });
  const btn = document.getElementById('authSubmitBtn');
  if (btn) btn.addEventListener('click', submitAuth);
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', signOut);
  // Submit on Enter inside the password field.
  const pwd = document.getElementById('authPassword');
  if (pwd) pwd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuth();
  });
}
