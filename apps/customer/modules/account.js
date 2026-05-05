// apps/customer/modules/account.js
// Owner: A10 | Slice: S21
//
// Account-edit view (signed-in). GET /api/v2/customer/me, render form
// with display_name, opted_in_marketing checkbox, preferred_shop_slug
// select. PATCH /api/v2/customer/me on save.
//
// HAND-OFF: db/customers/accounts.js exports deleteCustomerAccount but
// apps/server/routes/customer.js does NOT yet route to it. The
// delete-account button is intentionally hidden in V2 — flagged below
// as TODO(S21+) for the orchestrator to wire later.
//
// preferred_shop_slug select source: V2 hardcodes a tiny set; a follow-
// up will populate from /api/shop-config or a /api/shops listing.
//
// Exports: renderAccount(viewEl).

import { api } from './api-client.js';
import { escapeHtml } from './auth.js';

// V2 shop slug list — TODO(S22): fetch dynamically from a /api/shops
// listing endpoint (not currently exposed). For now, the list is small
// and stable enough that hardcoding is acceptable.
const SHOP_SLUGS = [
  { slug: '', name: '— No preference —' },
  { slug: 'brewed', name: 'Board & Brewed' },
];

export async function renderAccount(viewEl) {
  if (!viewEl) return;
  viewEl.innerHTML = `<div class="view-loading">Loading account…</div>`;

  const r = await api.me();
  if (r.status === 401) {
    // main.js's onAuth401 hook handles the redirect; we just bail.
    viewEl.innerHTML = `<div class="view-loading">Redirecting…</div>`;
    return;
  }
  if (!r.ok) {
    viewEl.innerHTML = `<div class="banner error">Couldn't load your account.</div>`;
    return;
  }

  const account = r.body?.account || {};
  const email = r.body?.email || '';
  const displayName = account.display_name || '';
  const optedIn = !!account.opted_in_marketing;
  const preferred = account.preferred_shop_slug || '';

  viewEl.innerHTML = `
    <h1>Your <span class="accent">account</span></h1>
    <p class="sub">Update how the shop addresses you and your communication preferences.</p>

    <div class="panel">
      <div class="form-row">
        <label>Email</label>
        <input type="email" value="${escapeHtml(email)}" disabled />
        <p class="note">Email is your sign-in identifier and can't be changed here.</p>
      </div>

      <div class="form-row">
        <label for="acctDisplayName">Display name</label>
        <input type="text" id="acctDisplayName" maxlength="80" placeholder="What should the shop call you?" value="${escapeHtml(displayName)}" />
      </div>

      <div class="form-row">
        <label for="acctShopSlug">Preferred shop</label>
        <select id="acctShopSlug">
          ${SHOP_SLUGS.map(s => `
            <option value="${escapeHtml(s.slug)}" ${s.slug === preferred ? 'selected' : ''}>${escapeHtml(s.name)}</option>
          `).join('')}
        </select>
      </div>

      <div class="form-row">
        <div class="check-inline">
          <input type="checkbox" id="acctOptIn" ${optedIn ? 'checked' : ''} />
          <label for="acctOptIn">Email me when shops post new card-buying offers, sales, or events.</label>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn primary" id="acctSaveBtn" type="button">Save changes</button>
        <a class="btn secondary" href="#">Back to dashboard</a>
      </div>
      <div id="acctBanner"></div>

      <!--
        TODO(S21+): wire delete-account button once apps/server/routes/customer.js
        adds a DELETE /api/v2/customer/me route that calls
        db/customers/accounts.js#deleteCustomerAccount. Hidden in V2.
      -->
    </div>
  `;

  const saveBtn = viewEl.querySelector('#acctSaveBtn');
  const banner = viewEl.querySelector('#acctBanner');
  if (!saveBtn || !banner) return;

  saveBtn.addEventListener('click', async () => {
    const nameEl = viewEl.querySelector('#acctDisplayName');
    const slugEl = viewEl.querySelector('#acctShopSlug');
    const optEl  = viewEl.querySelector('#acctOptIn');

    const fields = {
      display_name: (nameEl?.value || '').trim() || null,
      preferred_shop_slug: (slugEl?.value || '').trim() || null,
      opted_in_marketing: !!optEl?.checked,
    };

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    banner.innerHTML = '';

    const result = await api.saveMe(fields);
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';

    if (!result.ok) {
      banner.innerHTML = `<div class="banner error">${escapeHtml(result.error || 'Save failed.')}</div>`;
      return;
    }
    banner.innerHTML = `<div class="banner ok">Saved.</div>`;
  });
}

export default { renderAccount };
