// apps/quote/modules/shop-config.js
// Owner: A5 | Slice: S8
//
// Embed mode + multi-tenant shop branding for /quote. Behaviour pinned by
// V2_AUDIT §1c (public/quote.html lines 336-422).
//
// Surface contract (the .brand-name / .brand-logo / footer p / .checkbox-row
// / #inputPanel .note selectors are part of this module's API — index.html
// must emit those exact classes/ids for branding to apply).
//
// /api/shop-config/:slug returns (apps/server/routes/shop.js):
//   { slug, name, logo_url, accent_color, cash_pct, credit_pct, active, newsletter_show }
// V1's quote.html also referenced shop.email_public — that field is NOT
// returned by the public config endpoint, so the footer "Contact us" line
// always falls back to mailto: empty. We preserve the V1 behaviour rather
// than changing it (Operating Principle #1: no feature regressions).

import { DEFAULT_CASH_PCT, DEFAULT_CREDIT_PCT } from './totals.js';

// Local escape — kept inside this module so we don't introduce a circular
// dep with main.js (main imports shop-config; shop-config must not import
// main). main.js exports its own escapeHtml for renderResults().
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const SHOP_SLUG = params.get('shop') || null;
export const EMBED_MODE = params.get('embed') === '1';

let SHOP_CONFIG = null;

export function getShopConfig() {
  return SHOP_CONFIG;
}

export function getCashPct() {
  return SHOP_CONFIG?.cash_pct || DEFAULT_CASH_PCT;
}

export function getCreditPct() {
  return SHOP_CONFIG?.credit_pct || DEFAULT_CREDIT_PCT;
}

/**
 * Fetch /api/shop-config/:slug and apply branding. Silently falls back to
 * the default Board & Brewed look if the slug is missing, the fetch fails,
 * or the shop is inactive.
 * @param {(path:string, opts?:object)=>Promise<{ok:boolean, status:number, body:any}>} request
 */
export async function loadShopConfig(request) {
  if (!SHOP_SLUG) return null;
  try {
    const r = await request('/api/shop-config/' + encodeURIComponent(SHOP_SLUG));
    if (!r.ok) return null;
    SHOP_CONFIG = r.body;
    applyShopBranding();
    return SHOP_CONFIG;
  } catch (e) {
    console.warn('[QUOTE] shop-config fetch failed:', e?.message || e);
    return null;
  }
}

/**
 * Apply SHOP_CONFIG to the DOM. No-op if no config loaded.
 * Mirrors V1 applyShopBranding() lines 368-410 of public/quote.html.
 */
export function applyShopBranding() {
  if (!SHOP_CONFIG) return;
  const name = SHOP_CONFIG.name;

  if (name) {
    document.title = 'Get a Quote — ' + name;
    const bn = document.querySelector('.brand-name');
    if (bn) bn.textContent = name;
    const fl = document.querySelector('footer p');
    if (fl) {
      // V1 also references SHOP_CONFIG.email_public even though the public
      // shop-config endpoint doesn't return it. Preserved to avoid changing
      // V1 behaviour (mailto: with empty href when missing).
      fl.innerHTML =
        'Powered by ' +
        escapeHtml(name) +
        ' &middot; <a href="mailto:' +
        escapeHtml(SHOP_CONFIG.email_public || '') +
        '">Contact us</a>';
    }
  }

  if (SHOP_CONFIG.accent_color) {
    document.documentElement.style.setProperty('--accent', SHOP_CONFIG.accent_color);
    document.documentElement.style.setProperty('--accent-hover', SHOP_CONFIG.accent_color);
    const themeMeta = document.querySelector('meta[name=theme-color]');
    if (themeMeta) themeMeta.setAttribute('content', SHOP_CONFIG.accent_color);
  }

  if (SHOP_CONFIG.logo_url) {
    const bl = document.querySelector('.brand-logo img');
    if (bl) {
      bl.src = SHOP_CONFIG.logo_url;
      bl.alt = (SHOP_CONFIG.name || 'Shop') + ' logo';
    }
  }

  // Refresh the "Cash X%, store credit Y%" note line.
  const noteLine = document.querySelector('#inputPanel .note');
  if (noteLine) {
    noteLine.innerHTML =
      'Prices shown are indicative and assume Near Mint condition. Final offer depends on in-person condition check. Cash offer is ' +
      getCashPct() +
      '% of market value, store credit is ' +
      getCreditPct() +
      '%. We price off Cardmarket (EU) and Scryfall live data.';
  }

  // Newsletter checkbox: hidden when the shop opted out; otherwise relabel.
  const checkboxRow = document.querySelector('.checkbox-row');
  if (checkboxRow) {
    if (SHOP_CONFIG.newsletter_show === false) {
      checkboxRow.style.display = 'none';
      const cb = document.getElementById('leadNewsletter');
      if (cb) cb.checked = false;
    } else if (name) {
      const label = checkboxRow.querySelector('label');
      if (label) {
        label.innerHTML =
          'Keep me posted on new arrivals, tournaments &amp; card buying offers at ' +
          escapeHtml(name) +
          '.';
      }
    }
  }
}

/**
 * Hide brand header + tighten padding when loaded inside the embed widget.
 * Mirrors V1 applyEmbedMode() lines 412-419 of public/quote.html.
 */
export function applyEmbedMode() {
  if (!EMBED_MODE) return;
  const brand = document.querySelector('.brand');
  if (brand) brand.style.display = 'none';
  const wrap = document.querySelector('.wrap');
  if (wrap) wrap.style.padding = '12px 12px 32px';
}

/**
 * postMessage helper for the parent widget loader. Strict-origin verify is
 * the parent widget's job (its receiving side checks the iframe origin —
 * see apps/widget/widget.js); we send to '*' because the parent's origin
 * is the host shop's site, which we don't know in advance.
 *
 * No-op when the page isn't embedded (window.parent === window).
 *
 * @param {{type:string, [k:string]:any}} message
 */
export function postToParent(message) {
  if (!EMBED_MODE) return;
  if (typeof window === 'undefined' || window.parent === window) return;
  try {
    window.parent.postMessage(message, '*');
  } catch {
    /* parent unreachable; nothing to do */
  }
}
