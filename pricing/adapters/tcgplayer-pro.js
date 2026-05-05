// pricing/adapters/tcgplayer-pro.js
//
// Owner: A2 (Pricing engine) — Slice S17 (sealed product pricing)
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5 (paid TCGPlayer Pro tier; ~€60/mo)
//   - pricing/adapter.interface.md (single-card contract — analogous shape)
//   - pricing/sealed/product-types.js (SealedProduct / SealedQuote)
//   - pricing/confidence.js (SEALED_BASE_CONFIDENCE etc.)
//
// SCOPE: SEALED ONLY. The single-card-pricing adapter for TCGPlayer (when /
// if we add one) lives in tcgplayer.js, not here. This adapter exposes
// `searchSealed`, `verifySealed`, and `priceSealed` — the sealed-flavoured
// subset of the PricingAdapter shape.
//
// The real TCGPlayer Pro API endpoints are gated behind a paid subscription
// and DevOps will add the live URL pattern when we sign up. Until then this
// adapter ships in two modes:
//   1. Live mode (TCGPLAYER_PRO_API_KEY set, TCGPLAYER_PRO_MOCK unset):
//      issues real axios.get() calls against TCGPLAYER_PRO_BASE_URL with
//      Authorization: Bearer <key>. The exact path shape is documented
//      below as JSDoc — DevOps confirms before flipping the env vars in
//      prod.
//   2. Mock mode (TCGPLAYER_PRO_MOCK=true): returns realistic-shape stub
//      data. Used by tests/regression/sealed.spec.js + Render preview
//      branches that don't have the paid key.
//
// V2 ships with conservative defaults (10 s timeout, no retries — fail fast
// and let the route return null). Callers honour ctx.signal to cancel
// in-flight requests.

import { axios } from '../../apps/server/_clients.js';
import {
  SEALED_BASE_CONFIDENCE,
  SEALED_RECENT_BONUS,
  SEALED_STALE_PENALTY,
  SEALED_RECENT_THRESHOLD_HOURS,
  SEALED_STALE_THRESHOLD_DAYS,
} from '../confidence.js';
import { SEALED_CATEGORIES, normalizeSealedSku } from '../sealed/product-types.js';

const NAME = 'tcgplayer-pro';
const DEFAULT_BASE_URL = 'https://api.tcgplayer.com/';
const DEFAULT_TIMEOUT_MS = 10_000;

function isMock() {
  // Truthy values: '1', 'true', 'yes' (case-insensitive). Anything else =>
  // live mode (which will 401 if the key is bogus — that's intentional).
  const v = (process.env.TCGPLAYER_PRO_MOCK || '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes';
}

function getBaseUrl() {
  return process.env.TCGPLAYER_PRO_BASE_URL || DEFAULT_BASE_URL;
}

function getApiKey() {
  return process.env.TCGPLAYER_PRO_API_KEY || '';
}

/**
 * Confidence score for a sealed quote. Base 0.85; +0.05 if the upstream
 * lastUpdated is within SEALED_RECENT_THRESHOLD_HOURS; -0.10 if older than
 * SEALED_STALE_THRESHOLD_DAYS.
 *
 * @param {string|null|undefined} lastUpdatedIso
 * @returns {number}
 */
export function sealedConfidence(lastUpdatedIso) {
  let score = SEALED_BASE_CONFIDENCE;
  if (!lastUpdatedIso) return score;
  const t = Date.parse(lastUpdatedIso);
  if (Number.isNaN(t)) return score;
  const ageHours = (Date.now() - t) / (3600 * 1000);
  if (ageHours <= SEALED_RECENT_THRESHOLD_HOURS) score += SEALED_RECENT_BONUS;
  else if (ageHours > SEALED_STALE_THRESHOLD_DAYS * 24) score += SEALED_STALE_PENALTY;
  // Clamp to [0, 1] in case future tunable changes push past either edge.
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

// ---------------------------------------------------------------------------
// MOCK FIXTURES — small, realistic-shape stub catalog. Tests assert against
// these exact values; do not edit without syncing tests/regression/sealed.spec.js.
// ---------------------------------------------------------------------------

const MOCK_CATALOG = Object.freeze({
  'pokemon-sv8-booster-box': {
    sku: 'pokemon-sv8-booster-box',
    category: 'booster-box',
    set_code: 'SV8',
    set_name: 'Surging Sparks',
    name: 'Pokemon TCG: Surging Sparks Booster Box (36 packs)',
    image_url: 'https://cdn.example.com/sv8-booster-box.jpg',
    language: 'en',
    game: 'pokemon',
  },
  'pokemon-sv8-etb': {
    sku: 'pokemon-sv8-etb',
    category: 'etb',
    set_code: 'SV8',
    set_name: 'Surging Sparks',
    name: 'Pokemon TCG: Surging Sparks Elite Trainer Box',
    image_url: 'https://cdn.example.com/sv8-etb.jpg',
    language: 'en',
    game: 'pokemon',
  },
});

const MOCK_PRICES = Object.freeze({
  'pokemon-sv8-booster-box': { market: 178.5, low: 162.0, high: 199.99 },
  'pokemon-sv8-etb':         { market: 49.99, low: 44.0,  high: 59.0 },
});

// ---------------------------------------------------------------------------
// HTTP helpers — the live path. Documented endpoint shape below.
// ---------------------------------------------------------------------------

/**
 * GET <base>/catalog/products?sku=<sku>  →  { product: SealedProduct } | 404
 *
 * Real endpoint shape TBD by the TCGPlayer Pro plan we sign up for; this is
 * the documented best-guess based on their public partner-API patterns.
 * Override with TCGPLAYER_PRO_BASE_URL when the real path differs.
 *
 * @param {string} sku
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<import('../sealed/product-types.js').SealedProduct | null>}
 */
async function liveLookupBySku(sku, opts = {}) {
  const url = new URL('catalog/products', getBaseUrl()).toString();
  try {
    const resp = await axios.get(url, {
      params: { sku },
      headers: { Authorization: `Bearer ${getApiKey()}` },
      timeout: DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
    });
    const p = resp.data?.product;
    if (!p) return null;
    return p;
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/**
 * GET <base>/pricing/products/<sku>  →  { market, low, high, lastUpdated }
 *
 * @param {string} sku
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{ market: number|null, low: number|null, high: number|null, lastUpdated: string|null } | null>}
 */
async function liveFetchPrice(sku, opts = {}) {
  const url = new URL(`pricing/products/${encodeURIComponent(sku)}`, getBaseUrl()).toString();
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      timeout: DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
    });
    const d = resp.data || {};
    return {
      market: typeof d.market === 'number' ? d.market : null,
      low:    typeof d.low === 'number'    ? d.low    : null,
      high:   typeof d.high === 'number'   ? d.high   : null,
      lastUpdated: d.lastUpdated || null,
    };
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// PUBLIC SURFACE — adapter contract.
// ---------------------------------------------------------------------------

/**
 * Search the catalog by free-text query, optionally filtered by category.
 * Returns up to 10 hits. Used by the (deferred) sealed picker UI; not on the
 * pricing critical path.
 *
 * @param {string} query
 * @param {{category?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<import('../sealed/product-types.js').SealedProduct[]>}
 */
export async function searchSealed(query, opts = {}) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];

  if (isMock()) {
    return Object.values(MOCK_CATALOG).filter(p => {
      if (opts.category && p.category !== opts.category) return false;
      return p.name.toLowerCase().includes(q) || p.sku.includes(q);
    });
  }

  if (!getApiKey()) return [];

  const url = new URL('catalog/search', getBaseUrl()).toString();
  const resp = await axios.get(url, {
    params: { q: query, category: opts.category, limit: 10 },
    headers: { Authorization: `Bearer ${getApiKey()}` },
    timeout: DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
  });
  return Array.isArray(resp.data?.products) ? resp.data.products : [];
}

/**
 * Verify a SKU exists in the TCGPlayer Pro catalog. Returns the canonical
 * SealedProduct (with image / display name) or null on miss.
 *
 * @param {{sku: string}} input
 * @param {{signal?: AbortSignal}} [ctx]
 * @returns {Promise<import('../sealed/product-types.js').SealedProduct | null>}
 */
export async function verifySealed(input, ctx = {}) {
  const sku = normalizeSealedSku(input?.sku || '');
  if (!sku) return null;

  if (isMock()) {
    return MOCK_CATALOG[sku] || null;
  }

  if (!getApiKey()) return null;
  return liveLookupBySku(sku, { signal: ctx.signal });
}

/**
 * Quote a sealed-product price. Returns a SealedQuote (raw_currency='USD' —
 * TCGPlayer is USD-priced; pricing/sealed/price.js applies USD→EUR via FX
 * rate from ctx.fxRate).
 *
 * @param {import('../sealed/product-types.js').SealedProduct} product
 * @param {{signal?: AbortSignal, fxRate?: number}} [ctx]
 * @returns {Promise<import('../sealed/product-types.js').SealedQuote | null>}
 */
export async function priceSealed(product, ctx = {}) {
  const sku = normalizeSealedSku(product?.sku || '');
  if (!sku) return null;

  let rawPrice = null;
  if (isMock()) {
    const p = MOCK_PRICES[sku];
    if (!p) return null;
    rawPrice = { ...p, lastUpdated: new Date().toISOString() };
  } else {
    if (!getApiKey()) return null;
    rawPrice = await liveFetchPrice(sku, { signal: ctx.signal });
    if (!rawPrice) return null;
  }

  const fx = typeof ctx.fxRate === 'number' && ctx.fxRate > 0 ? ctx.fxRate : 1;
  const eur = rawPrice.market != null ? Math.round(rawPrice.market * fx * 100) / 100 : null;
  const lowEur  = rawPrice.low  != null ? Math.round(rawPrice.low  * fx * 100) / 100 : null;
  const highEur = rawPrice.high != null ? Math.round(rawPrice.high * fx * 100) / 100 : null;

  return {
    source: NAME,
    market_value_eur: eur,
    raw_currency: 'USD',
    raw_value: rawPrice.market,
    low: lowEur,
    high: highEur,
    confidence: sealedConfidence(rawPrice.lastUpdated),
    fetched_at: new Date().toISOString(),
    last_updated: rawPrice.lastUpdated,
    blocked_by: null,
  };
}

/**
 * Default-export adapter. Sealed-flavoured subset of the PricingAdapter
 * shape: methods are `verifySealed` / `priceSealed` (not verify/price), so
 * the standard fan-out doesn't accidentally pick this adapter up for
 * single-card requests.
 */
export default {
  name: NAME,
  supports: {
    games: ['pokemon', 'magic', 'lorcana', 'onepiece', 'starwars', 'yugioh'],
    categories: SEALED_CATEGORIES,
    needs: ['sku'],
  },
  isAvailable() {
    return !!getApiKey() || isMock();
  },
  verifySealed,
  priceSealed,
  searchSealed,
};
