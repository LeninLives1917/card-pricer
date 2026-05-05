// apps/customer/modules/offer-accept.js
// Owner: A10 | Slice: S21
//
// Public/offer view rendered when location.hash === '#offer=<token>'.
// No auth required — the token IS the auth (S20 design). Logged-in
// customers get their accept linked to their account via the optional
// Bearer header api-client attaches.
//
// Flow:
//   1. GET /api/v2/quote-offer/:token → sanitised public projection.
//      404 → friendly "offer not found"
//      410 → friendly "offer expired"
//   2. Render line items (Plex Mono prices, tabular-nums) + status-
//      dependent CTAs (open/accepted/declined/expired).
//   3. On accept success:
//        - if logged in: thanks + auto-redirect to '#' after 5s
//        - if anonymous: thanks + magic-link form for lazy onboarding.
//
// Exports: renderOffer(viewEl, token).

import { api } from './api-client.js';
import { escapeHtml } from './auth.js';

const EUR = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
});
function formatEur(n) {
  if (n == null || !Number.isFinite(Number(n))) return '€—';
  try { return EUR.format(Number(n)); } catch { return '€' + Number(n).toFixed(2); }
}

function formatDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function lineItemRow(item) {
  // line_items shape isn't strictly typed in S20 — be defensive.
  const name = item?.name || item?.card?.name || 'Card';
  const set = item?.set_code || item?.card?.set_code || '';
  const num = item?.card_number || item?.card?.card_number || '';
  const cond = item?.condition || item?.card?.condition_estimate || '';
  const price = item?.cash != null ? item.cash
              : item?.price_eur != null ? item.price_eur
              : item?.market != null ? item.market
              : null;

  const meta = [set, num ? '#' + num : '', cond].filter(Boolean).join(' · ');

  return `
    <tr>
      <td>
        <div>${escapeHtml(name)}</div>
        ${meta ? `<div class="note" style="margin:0">${escapeHtml(meta)}</div>` : ''}
      </td>
      <td class="num">${escapeHtml(formatEur(price))}</td>
    </tr>
  `;
}

function renderHeader(offer) {
  const shopName = offer?.shop?.name || 'A card shop';
  const total = formatEur(offer?.total_eur);
  const expires = offer?.expires_at ? `Offer expires ${formatDateTime(offer.expires_at)}` : '';
  return `
    <div class="offer-header">
      <div class="shop-line">${escapeHtml(shopName)} has prepared an offer for you.</div>
      <div class="total">${escapeHtml(total)}</div>
      ${expires ? `<div class="expires">${escapeHtml(expires)}</div>` : ''}
    </div>
  `;
}

function renderLineTable(offer) {
  const items = Array.isArray(offer?.line_items) ? offer.line_items : [];
  if (!items.length) return '';
  return `
    <table class="line-table" aria-label="Offer line items">
      <thead>
        <tr><th>Card</th><th class="num">Offer</th></tr>
      </thead>
      <tbody>${items.map(lineItemRow).join('')}</tbody>
    </table>
  `;
}

function renderStatusCard(offer) {
  const status = String(offer?.status || 'open');
  if (status === 'accepted') {
    const when = formatDateTime(offer.accepted_at);
    return `
      <div class="status-card ok">
        <div class="status-icon">✓</div>
        <div class="status-msg">Offer accepted${when ? ` on ${escapeHtml(when)}` : ''}.</div>
        <div class="status-meta">The shop has been notified and will be in touch.</div>
      </div>
    `;
  }
  if (status === 'declined') {
    const when = formatDateTime(offer.declined_at);
    return `
      <div class="status-card">
        <div class="status-icon">—</div>
        <div class="status-msg">Offer declined${when ? ` on ${escapeHtml(when)}` : ''}.</div>
        <div class="status-meta">No further action needed.</div>
      </div>
    `;
  }
  if (status === 'expired') {
    const when = formatDateTime(offer.expires_at);
    return `
      <div class="status-card bad">
        <div class="status-icon">⏱</div>
        <div class="status-msg">This offer expired${when ? ` on ${escapeHtml(when)}` : ''}.</div>
        <div class="status-meta">Contact the shop to request a fresh quote.</div>
      </div>
    `;
  }
  return '';
}

function renderOpenCtas() {
  return `
    <div class="cta-row">
      <button class="btn primary" id="acceptBtn" type="button">Accept this offer</button>
      <button class="btn secondary" id="declineBtn" type="button">Decline</button>
    </div>
    <p class="note">Accepting tells the shop you're happy with the offer. They'll contact you to arrange handover. You can still walk away if the in-person condition check disagrees.</p>
    <div id="actionBanner"></div>
  `;
}

function renderNotFound() {
  return `
    <div class="status-card bad">
      <div class="status-icon">?</div>
      <div class="status-msg">Offer not found.</div>
      <div class="status-meta">The link may have been mistyped, or the shop may have removed the offer. Contact them directly to confirm.</div>
    </div>
  `;
}

function renderExpiredFromError() {
  return `
    <div class="status-card bad">
      <div class="status-icon">⏱</div>
      <div class="status-msg">This offer has expired.</div>
      <div class="status-meta">Contact the shop to request a fresh quote.</div>
    </div>
  `;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Renders the post-accept form: if signed-in we say "thanks, redirecting".
// If anonymous we offer a magic-link form so the customer can track future
// offers — lazy onboarding (per slice brief).
async function renderAcceptedSuccess(viewEl, banner) {
  // Best-effort: ask /me — if signed in, status will be 200 (and any 401
  // is silently swallowed because /me is non-public; main.js' onAuth401
  // hook would fire, which is a tolerable cost: we swap to anonymous UI.).
  let signedIn = false;
  try {
    const me = await api.me();
    signedIn = !!(me.ok && me.body?.user_id);
  } catch { /* ignore */ }

  if (signedIn) {
    viewEl.innerHTML = `
      <div class="status-card ok">
        <div class="status-icon">✓</div>
        <div class="status-msg">Offer accepted.</div>
        <div class="status-meta">We've notified the shop. They'll be in touch.</div>
      </div>
      <p class="note" style="text-align:center;">Returning to your dashboard…</p>
    `;
    setTimeout(() => {
      try { window.location.hash = ''; } catch {}
    }, 5000);
    return;
  }

  // Anonymous path: offer the magic-link form.
  viewEl.innerHTML = `
    <div class="status-card ok">
      <div class="status-icon">✓</div>
      <div class="status-msg">Offer accepted.</div>
      <div class="status-meta">We've notified the shop. They'll be in touch.</div>
    </div>
    <hr class="hairline" />
    <div class="panel signin-form">
      <h2 style="margin-top:0">Want to track this offer?</h2>
      <p class="sub">Sign up with the email the shop has on file and you'll see this offer plus any future ones in one place.</p>
      <div class="form-row">
        <label for="lazyEmail">Email</label>
        <input type="email" id="lazyEmail" placeholder="you@example.com" autocomplete="email" />
      </div>
      <div class="btn-row">
        <button class="btn primary" id="lazySendBtn" type="button">Email me a sign-in link</button>
      </div>
      <div id="lazyBanner"></div>
    </div>
  `;
  const input = viewEl.querySelector('#lazyEmail');
  const btn = viewEl.querySelector('#lazySendBtn');
  const lazyBanner = viewEl.querySelector('#lazyBanner');
  if (!input || !btn || !lazyBanner) return;
  btn.addEventListener('click', async () => {
    const email = String(input.value || '').trim().toLowerCase();
    lazyBanner.innerHTML = '';
    if (!email || !EMAIL_RE.test(email)) {
      lazyBanner.innerHTML = `<div class="banner error">Enter a valid email address.</div>`;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    let redirectTo = '/customer';
    try { redirectTo = window.location.origin + '/customer'; } catch {}
    const r = await api.magicLink(email, redirectTo);
    if (!r.ok) {
      lazyBanner.innerHTML = `<div class="banner error">Couldn't send the link. Try again in a moment.</div>`;
      btn.disabled = false;
      btn.textContent = 'Email me a sign-in link';
      return;
    }
    lazyBanner.innerHTML = `<div class="banner ok">Check your inbox — we just emailed a sign-in link to <strong>${escapeHtml(email)}</strong>.</div>`;
    btn.disabled = true;
    btn.textContent = 'Sent';
  });
}

async function attachActionHandlers(viewEl, token) {
  const acceptBtn = viewEl.querySelector('#acceptBtn');
  const declineBtn = viewEl.querySelector('#declineBtn');
  const banner = viewEl.querySelector('#actionBanner');

  if (acceptBtn) {
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      if (declineBtn) declineBtn.disabled = true;
      acceptBtn.textContent = 'Accepting…';
      const r = await api.accept(token);
      if (!r.ok) {
        if (banner) {
          if (r.status === 410) {
            banner.innerHTML = `<div class="banner error">This offer has expired.</div>`;
          } else if (r.status === 409) {
            banner.innerHTML = `<div class="banner error">This offer is no longer open.</div>`;
          } else if (r.status === 404) {
            banner.innerHTML = `<div class="banner error">Offer not found.</div>`;
          } else {
            banner.innerHTML = `<div class="banner error">Couldn't accept. Try again in a moment.</div>`;
          }
        }
        acceptBtn.disabled = false;
        if (declineBtn) declineBtn.disabled = false;
        acceptBtn.textContent = 'Accept this offer';
        return;
      }
      await renderAcceptedSuccess(viewEl, banner);
    });
  }

  if (declineBtn) {
    declineBtn.addEventListener('click', async () => {
      acceptBtn && (acceptBtn.disabled = true);
      declineBtn.disabled = true;
      declineBtn.textContent = 'Declining…';
      const r = await api.decline(token);
      if (!r.ok) {
        if (banner) {
          banner.innerHTML = `<div class="banner error">Couldn't decline. Try again in a moment.</div>`;
        }
        if (acceptBtn) acceptBtn.disabled = false;
        declineBtn.disabled = false;
        declineBtn.textContent = 'Decline';
        return;
      }
      viewEl.innerHTML = `
        <div class="status-card">
          <div class="status-icon">—</div>
          <div class="status-msg">Offer declined.</div>
          <div class="status-meta">No further action needed.</div>
        </div>
      `;
    });
  }
}

export async function renderOffer(viewEl, token) {
  if (!viewEl) return;
  if (!token) {
    viewEl.innerHTML = renderNotFound();
    return;
  }
  viewEl.innerHTML = `<div class="view-loading">Loading offer…</div>`;

  const r = await api.offer(token);
  if (r.status === 404) {
    viewEl.innerHTML = renderNotFound();
    return;
  }
  if (r.status === 410) {
    viewEl.innerHTML = renderExpiredFromError();
    return;
  }
  if (!r.ok || !r.body) {
    viewEl.innerHTML = `<div class="banner error">Couldn't load the offer. Try again in a moment.</div>`;
    return;
  }

  const offer = r.body;
  const status = String(offer.status || 'open');

  const statusCard = renderStatusCard(offer);
  const ctas = (status === 'open') ? renderOpenCtas() : '';

  viewEl.innerHTML = `
    ${renderHeader(offer)}
    ${renderLineTable(offer)}
    ${statusCard}
    ${ctas}
  `;

  if (status === 'open') {
    await attachActionHandlers(viewEl, token);
  }
}

export default { renderOffer };
