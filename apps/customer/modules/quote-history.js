// apps/customer/modules/quote-history.js
// Owner: A10 | Slice: S21
//
// Customer dashboard view (signed-in). Fetches:
//   GET /api/v2/customer/me      — display_name + email (from S20)
//   GET /api/v2/customer/offers  — list of offers grouped by status
// Renders a tile for each open offer with shop name, total, expires-at
// countdown, and a "View offer" link to /customer#offer=<token>. Empty
// state points back at the main /quote page so the customer can request
// a fresh quote.
//
// Exports: renderHistory(viewEl).

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

function formatRelative(iso) {
  if (!iso) return '';
  let t;
  try { t = new Date(iso).getTime(); } catch { return ''; }
  if (!Number.isFinite(t)) return '';
  const now = Date.now();
  const diff = t - now;
  const abs = Math.abs(diff);
  const day = 86_400_000;
  const hour = 3_600_000;
  const min = 60_000;
  if (abs < hour) {
    const mins = Math.max(1, Math.round(abs / min));
    return diff >= 0 ? `expires in ${mins}m` : `${mins}m ago`;
  }
  if (abs < day) {
    const hours = Math.round(abs / hour);
    return diff >= 0 ? `expires in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(abs / day);
  return diff >= 0 ? `expires in ${days}d` : `${days}d ago`;
}

function offerCard(offer) {
  // S20 returns the full row (no public-shape sanitisation for the customer's
  // own offers). Defensive on every field.
  const token = offer.accept_token || offer.token || null;
  const status = String(offer.status || 'open');
  const total = offer.total_eur != null ? formatEur(offer.total_eur) : '€—';
  const shopName = offer.shop?.name || offer.shop_name || 'A card shop';
  const itemCount = Array.isArray(offer.line_items) ? offer.line_items.length : 0;

  let detail = '';
  if (status === 'open' && offer.expires_at) {
    detail = formatRelative(offer.expires_at);
  } else if (status === 'accepted' && offer.accepted_at) {
    detail = `accepted ${formatRelative(offer.accepted_at)}`;
  } else if (status === 'declined' && offer.declined_at) {
    detail = `declined ${formatRelative(offer.declined_at)}`;
  } else if (status === 'expired' && offer.expires_at) {
    detail = `expired ${formatRelative(offer.expires_at)}`;
  }

  const href = token
    ? '#offer=' + encodeURIComponent(token)
    : '#';

  // For non-open offers we still render a card but as a plain div (no link);
  // accepted/declined/expired aren't actionable.
  if (status !== 'open' || !token) {
    return `
      <div class="offer-card" aria-disabled="true">
        <div class="offer-meta">
          <div class="offer-shop">${escapeHtml(shopName)} · ${itemCount} item${itemCount === 1 ? '' : 's'}</div>
          <div class="offer-status-line"><span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span>${escapeHtml(detail)}</div>
        </div>
        <div class="offer-total">${escapeHtml(total)}</div>
      </div>
    `;
  }
  return `
    <a class="offer-card" href="${escapeHtml(href)}">
      <div class="offer-meta">
        <div class="offer-shop">${escapeHtml(shopName)} · ${itemCount} item${itemCount === 1 ? '' : 's'}</div>
        <div class="offer-status-line"><span class="pill open">open</span>${escapeHtml(detail)}</div>
      </div>
      <div class="offer-total">${escapeHtml(total)}</div>
    </a>
  `;
}

function groupByStatus(offers) {
  const groups = { open: [], accepted: [], declined: [], expired: [] };
  for (const o of offers || []) {
    const s = String(o?.status || 'open');
    if (groups[s]) groups[s].push(o);
    else groups.open.push(o); // unknown status — bias toward "actionable"
  }
  return groups;
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <p>You don't have any quotes yet.</p>
      <p>Ready to sell some cards? <a href="/">Start a new quote</a>.</p>
    </div>
  `;
}

function renderSection(title, items) {
  if (!items.length) return '';
  return `
    <section class="offer-section">
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <div class="offer-list">
        ${items.map(offerCard).join('')}
      </div>
    </section>
  `;
}

// Public render — returns nothing; mutates viewEl.
export async function renderHistory(viewEl) {
  if (!viewEl) return;
  viewEl.innerHTML = `<div class="view-loading">Loading your quotes…</div>`;

  const [meRes, offersRes] = await Promise.all([api.me(), api.offers()]);

  // 401 from either call → main.js's onAuth401 hook redirects to '#'.
  // We just exit here in that case so we don't trample the redirect.
  if (meRes.status === 401 || offersRes.status === 401) {
    viewEl.innerHTML = `<div class="view-loading">Redirecting…</div>`;
    return;
  }

  if (!meRes.ok) {
    viewEl.innerHTML = `<div class="banner error">Couldn't load your account. Please try again.</div>`;
    return;
  }

  const account = meRes.body?.account || {};
  const email = meRes.body?.email || '';
  const name = (account.display_name || '').trim() || email.split('@')[0] || 'there';

  if (!offersRes.ok) {
    viewEl.innerHTML = `
      <div class="dash-greeting">Welcome back, <strong>${escapeHtml(name)}</strong>.</div>
      <h1>Your quotes</h1>
      <div class="banner error">Couldn't load your offers. Please try again.</div>
    `;
    return;
  }

  const offers = Array.isArray(offersRes.body?.offers) ? offersRes.body.offers : [];
  const groups = groupByStatus(offers);
  const total = offers.length;

  viewEl.innerHTML = `
    <div class="dash-greeting">Welcome back, <strong>${escapeHtml(name)}</strong>.</div>
    <h1>Your <span class="accent">quotes</span></h1>
    ${total === 0 ? renderEmpty() : `
      ${renderSection('Open offers', groups.open)}
      ${renderSection('Accepted', groups.accepted)}
      ${renderSection('Declined', groups.declined)}
      ${renderSection('Expired', groups.expired)}
    `}
  `;
}

export default { renderHistory };
