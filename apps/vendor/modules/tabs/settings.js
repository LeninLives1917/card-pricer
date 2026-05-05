// apps/vendor/modules/tabs/settings.js
//
// Settings tab — Account, Preferences, Pair Phone QR, Want List, Embed
// Settings (shop plan only), Session controls.
//
// The OCR-first toggle is dead code in V1 (audit §5.2 — tryOcrIdentify hard
// returns null at line 4204). Per S7 brief: keep the toggle visible but
// marked "(beta)", write to its own localStorage key, do NOT call
// /api/read-set-code from S7. S15 will rewire the actual call with the
// validation gate.
//
// Embed Settings — wires to /api/shop GET / POST / PATCH. Visible only when
// /api/me reports plan in SHOP_PLANS (audit §1a). We surface based on plan
// returned by api.me() at boot.

import { api, getJson, postJson, patchJson } from '../api-client.js';
import { state, getSetting, setSetting, getWantList, saveWantList } from '../state.js';
import { startHosting, stopPairing } from '../pair.js';

let _shopPlan = false;
let _shop = null;

export function init() {
  wireAccount();
  wirePreferences();
  wirePairPhone();
  wireWantList();
  wireEmbedSettings();
  refreshUsage();
  detectShopPlan();
}

// ============================================================
// Account / usage
// ============================================================

function wireAccount() {
  const btn = document.getElementById('signOutBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      const { signOut } = await import('../auth.js');
      signOut();
    });
  }
}

export async function refreshUsage() {
  const r = await api.usage();
  if (!r.ok) return;
  renderUsage(r.body);
}

export function renderUsage(u) {
  if (!u) return;
  const planLabel = document.getElementById('usagePlanLabel');
  const countLabel = document.getElementById('usageCountLabel');
  const bar = document.getElementById('usageBar');
  const fill = document.getElementById('usageBarFill');
  if (planLabel) planLabel.textContent = 'Plan: ' + (u.plan || '—');
  if (countLabel) {
    countLabel.textContent = u.limit
      ? `${u.used || 0} / ${u.limit} this month`
      : `${u.used || 0} this month (unlimited)`;
  }
  if (bar && fill && u.limit) {
    bar.style.display = 'block';
    const pct = Math.min(100, Math.round(((u.used || 0) / u.limit) * 100));
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct >= 80 && pct < 100);
    fill.classList.toggle('over', pct >= 100);
  } else if (bar) {
    bar.style.display = 'none';
  }
}

// ============================================================
// Preferences
// ============================================================

function wirePreferences() {
  // Currency / sell markup / junk threshold / OCR-first beta toggle.
  const map = [
    ['currencySelect', 'currency', 'EUR'],
    ['sellMarkup', 'sellMarkup', '110'],
    ['junkThreshold', 'junkThreshold', '0'],
    ['rapidFireToggle', 'rapidFire', 'false'],
    ['hapticToggle', 'haptic', 'true'],
    ['highContrastToggle', 'highContrast', 'false'],
    ['amoledToggle', 'amoled', 'false'],
    ['ocrFirstToggle', 'ocrFirst', 'false'],
  ];
  for (const [id, key, def] of map) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = getSetting(key, def);
    if (el.type === 'checkbox') el.checked = v === 'true' || v === '1';
    else el.value = v;
    el.addEventListener('change', () => {
      const next = el.type === 'checkbox' ? String(el.checked) : el.value;
      setSetting(key, next);
      if (key === 'amoled') document.body.classList.toggle('amoled', el.checked);
    });
  }
  if (getSetting('amoled', 'false') === 'true') document.body.classList.add('amoled');
}

// ============================================================
// Pair Phone (QR)
// ============================================================

function wirePairPhone() {
  const host = document.getElementById('pairHostBtn');
  const stop = document.getElementById('pairStopBtn');
  if (host) host.addEventListener('click', startHosting);
  if (stop) stop.addEventListener('click', stopPairing);
}

// ============================================================
// Want list
// ============================================================

function wireWantList() {
  const add = document.getElementById('wantAddBtn');
  if (add) add.addEventListener('click', addWantItem);
  renderWantList();
}

function addWantItem() {
  const name = document.getElementById('wantName')?.value.trim();
  const set = document.getElementById('wantSet')?.value.trim();
  const max = parseFloat(document.getElementById('wantMax')?.value || '');
  if (!name) return;
  const list = getWantList();
  list.push({ name, set: set || undefined, max: isFinite(max) ? max : undefined });
  saveWantList(list);
  ['wantName', 'wantSet', 'wantMax'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  renderWantList();
}

function renderWantList() {
  const root = document.getElementById('wantListContainer');
  if (!root) return;
  const list = getWantList();
  if (!list.length) {
    root.innerHTML = '<p style="font-size:12px; color:var(--paper-300);">No items yet.</p>';
    return;
  }
  root.innerHTML = list.map((w, i) => `
    <div class="setting-row" style="border-top:1px solid var(--hairline);">
      <span class="setting-label">${escapeHtml(w.name)}${w.set ? ' · ' + escapeHtml(w.set) : ''}${w.max ? ' · max €' + w.max : ''}</span>
      <button class="btn ghost danger" data-want-remove="${i}">Remove</button>
    </div>
  `).join('');
  root.querySelectorAll('[data-want-remove]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = parseInt(b.dataset.wantRemove, 10);
      const list = getWantList();
      list.splice(i, 1);
      saveWantList(list);
      renderWantList();
    });
  });
}

// ============================================================
// Embed Settings (shop plan only)
// ============================================================

async function detectShopPlan() {
  const r = await api.me();
  if (!r.ok) return;
  const plan = r.body?.plan;
  _shopPlan = (plan === 'shop' || plan === 'beta');
  const group = document.getElementById('embedSettingsGroup');
  if (group) group.style.display = _shopPlan ? '' : 'none';
  if (_shopPlan) loadEmbedPanel();
}

async function loadEmbedPanel() {
  const r = await getJson('/api/shop');
  if (r.ok && r.body?.shop) {
    _shop = r.body.shop;
    showEmbedHasShop(_shop);
  } else {
    showEmbedNoShop();
  }
}

function showEmbedNoShop() {
  document.getElementById('embedNoShop')?.style.setProperty('display', 'block');
  document.getElementById('embedHasShop')?.style.setProperty('display', 'none');
}

function showEmbedHasShop(shop) {
  const noShop = document.getElementById('embedNoShop');
  const hasShop = document.getElementById('embedHasShop');
  if (noShop) noShop.style.display = 'none';
  if (hasShop) hasShop.style.display = 'block';
  for (const [id, key] of [
    ['shopSlug', 'slug'], ['shopName', 'name'], ['shopEmail', 'email'],
    ['shopLogo', 'logo_url'], ['shopColor', 'accent_color'],
    ['shopCashPct', 'cash_pct'], ['shopCreditPct', 'credit_pct'],
    ['shopBrevoList', 'brevo_list_id'],
    ['shopMailchimpKey', 'mailchimp_api_key'],
    ['shopMailchimpList', 'mailchimp_list_id'],
    ['shopConvertkitKey', 'convertkit_api_key'],
    ['shopConvertkitForm', 'convertkit_form_id'],
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = shop[key] ?? '';
  }
  const provider = document.getElementById('shopNewsletterProvider');
  if (provider) provider.value = shop.newsletter_provider || 'brevo';
  const show = document.getElementById('shopNewsletterShow');
  if (show) show.checked = !!shop.newsletter_show;
  const active = document.getElementById('shopActive');
  if (active) active.checked = shop.active !== false;
  applyNewsletterProviderUI();
  renderEmbedSnippet(shop);
}

function applyNewsletterProviderUI() {
  const provider = document.getElementById('shopNewsletterProvider')?.value || 'brevo';
  for (const p of ['brevo', 'mailchimp', 'convertkit']) {
    document.querySelectorAll('.np-' + p).forEach((el) => {
      el.style.display = (provider === p) ? '' : 'none';
    });
  }
}

function renderEmbedSnippet(shop) {
  const ta = document.getElementById('embedSnippet');
  if (!ta) return;
  const origin = window.location.origin;
  ta.value = `<script src="${origin}/widget.js" data-shop="${shop.slug}" data-color="${shop.accent_color || '#d97706'}" data-position="floating" data-label="Sell to us" defer></script>`;
  const link = document.getElementById('embedPreviewLink');
  if (link) link.href = `${origin}/quote?shop=${encodeURIComponent(shop.slug)}`;
}

function wireEmbedSettings() {
  const create = document.getElementById('createShopBtn');
  if (create) create.addEventListener('click', createShop);
  const save = document.getElementById('saveShopBtn');
  if (save) save.addEventListener('click', saveShop);
  const copy = document.getElementById('copyEmbedBtn');
  if (copy) copy.addEventListener('click', copyEmbedSnippet);
  const provider = document.getElementById('shopNewsletterProvider');
  if (provider) provider.addEventListener('change', applyNewsletterProviderUI);
}

async function createShop() {
  const slug = document.getElementById('newShopSlug')?.value.trim();
  const name = document.getElementById('newShopName')?.value.trim();
  const email = document.getElementById('newShopEmail')?.value.trim();
  const err = document.getElementById('createShopError');
  if (err) err.textContent = '';
  if (!slug || !name || !email) {
    if (err) err.textContent = 'Slug, name, and email all required.';
    return;
  }
  const r = await postJson('/api/shop', { slug, name, email });
  if (!r.ok) {
    if (err) err.textContent = r.error || 'Failed to create shop.';
    return;
  }
  _shop = r.body?.shop || r.body;
  showEmbedHasShop(_shop);
}

async function saveShop() {
  const status = document.getElementById('saveShopStatus');
  if (status) status.textContent = 'Saving…';
  const body = {
    slug: document.getElementById('shopSlug')?.value.trim(),
    name: document.getElementById('shopName')?.value.trim(),
    email: document.getElementById('shopEmail')?.value.trim(),
    logo_url: document.getElementById('shopLogo')?.value.trim(),
    accent_color: document.getElementById('shopColor')?.value,
    cash_pct: parseInt(document.getElementById('shopCashPct')?.value, 10),
    credit_pct: parseInt(document.getElementById('shopCreditPct')?.value, 10),
    newsletter_provider: document.getElementById('shopNewsletterProvider')?.value,
    newsletter_show: document.getElementById('shopNewsletterShow')?.checked,
    brevo_list_id: parseInt(document.getElementById('shopBrevoList')?.value, 10) || null,
    mailchimp_api_key: document.getElementById('shopMailchimpKey')?.value,
    mailchimp_list_id: document.getElementById('shopMailchimpList')?.value,
    convertkit_api_key: document.getElementById('shopConvertkitKey')?.value,
    convertkit_form_id: document.getElementById('shopConvertkitForm')?.value,
    active: document.getElementById('shopActive')?.checked,
  };
  const r = await patchJson('/api/shop', body);
  if (!r.ok) {
    if (status) { status.textContent = r.error || 'Save failed.'; status.style.color = 'var(--down)'; }
    return;
  }
  _shop = r.body?.shop || r.body;
  if (status) { status.textContent = 'Saved.'; status.style.color = 'var(--up)'; }
  renderEmbedSnippet(_shop);
}

async function copyEmbedSnippet() {
  const ta = document.getElementById('embedSnippet');
  if (!ta) return;
  try {
    await navigator.clipboard.writeText(ta.value);
    const btn = document.getElementById('copyEmbedBtn');
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  } catch {
    ta.select();
    document.execCommand('copy');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
