// apps/customer/modules/auth.js
// Owner: A10 | Slice: S21
//
// Magic-link sign-in landing view + sign-out helper. Calls
// POST /api/v2/customer/magic-link via the public path (no auth header
// — see api-client.js PUBLIC_PATHS). On success, shows "check your inbox"
// state. The Supabase email lands the user back at /customer with the
// access_token in the hash; main.js consumes it via getSessionFromUrl.
//
// Exports: renderSignIn(viewEl), signOut(), escapeHtml.

import { api } from './api-client.js';

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Build the redirectTo URL the magic-link should land on. Strip any
// existing hash so Supabase appends its own ?/# fragments cleanly.
function getRedirectTo() {
  try {
    const origin = window.location.origin;
    return origin + '/customer';
  } catch {
    return '/customer';
  }
}

// Render the sign-in landing into the given container element.
// Uses addEventListener (no inline handlers per index.html's no-onclick rule).
export function renderSignIn(viewEl) {
  if (!viewEl) return;
  viewEl.innerHTML = `
    <div class="signin-hero">
      <h1>Your <span class="accent">card quotes</span>, in one place</h1>
      <p class="sub">Sign in to view past offers and accept them in a click. We'll email you a sign-in link — no password to remember.</p>
    </div>

    <div class="panel signin-form" id="signinPanel">
      <div class="form-row">
        <label for="signinEmail">Email</label>
        <input type="email" id="signinEmail" placeholder="you@example.com" autocomplete="email" required />
      </div>
      <div class="btn-row">
        <button class="btn primary" id="signinBtn" type="button">Email me a sign-in link</button>
      </div>
      <p class="note">We don't store passwords. The link is good for 60 minutes and can only be used once.</p>
      <div id="signinBanner"></div>
    </div>
  `;

  const input = viewEl.querySelector('#signinEmail');
  const btn = viewEl.querySelector('#signinBtn');
  const banner = viewEl.querySelector('#signinBanner');

  if (!input || !btn || !banner) return;

  const submit = async () => {
    const email = String(input.value || '').trim().toLowerCase();
    banner.innerHTML = '';
    if (!email || !EMAIL_RE.test(email)) {
      banner.innerHTML = `<div class="banner error">Enter a valid email address.</div>`;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const result = await api.magicLink(email, getRedirectTo());
      if (!result.ok) {
        // Server is opaque-by-design — but a true 500 can still surface here.
        banner.innerHTML = `<div class="banner error">Couldn't send the link. Try again in a moment.</div>`;
        btn.disabled = false;
        btn.textContent = 'Email me a sign-in link';
        return;
      }
      // Replace the form with a quiet success message.
      const panel = viewEl.querySelector('#signinPanel');
      if (panel) {
        panel.innerHTML = `
          <div class="signin-success">
            <span class="display">Check your inbox</span>
            <p>We just emailed a sign-in link to <strong>${escapeHtml(email)}</strong>.</p>
            <p class="note">Didn't arrive in a minute? Check spam, or try another address.</p>
          </div>
        `;
      }
    } catch {
      banner.innerHTML = `<div class="banner error">Network error. Try again in a moment.</div>`;
      btn.disabled = false;
      btn.textContent = 'Email me a sign-in link';
    }
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  // Autofocus for keyboard users; do nothing on touch (mobile keyboards
  // popping unbidden is a UX foul).
  try {
    if (!('ontouchstart' in window)) input.focus();
  } catch { /* ignore */ }
}

// Sign-out helper — main.js calls this from the nav button. We don't
// re-render here; main.js is responsible for routing to '#' afterward
// so the URL state matches the session state.
export async function signOut() {
  const sb = (typeof window !== 'undefined' && window.sb) || null;
  if (!sb) return { ok: true };
  try {
    await sb.auth.signOut();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'signOut failed' };
  }
}

export default { renderSignIn, signOut, escapeHtml };
