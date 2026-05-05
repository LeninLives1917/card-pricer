// pricing/adapters/cardmarket-sealed.js
//
// Owner: A2 (Pricing engine) — Slice S17.1 (Cardmarket sealed adapter)
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5 (sealed product pricing)
//   - pricing/adapter.interface.md (single-card contract — analogous shape)
//   - pricing/sealed/product-types.js (SealedProduct / SealedQuote)
//   - pricing/confidence.js (SEALED_BASE_CONFIDENCE etc.)
//   - pricing/adapters/cardmarket-html.js (the HTML-scrape primitive we reuse)
//
// SCOPE: SEALED ONLY. Cardmarket's sealed-product surface lives at URLs
// like /en/Pokemon/Products/Booster-Boxes/Scarlet-Violet-Twilight-Masquerade.
// We don't have a paid API subscription, so the adapter:
//   1. Builds canonical Cardmarket product URLs from a SKU + category +
//      set + name input.
//   2. Best-effort HTML-scrapes the product page using the same primitive
//      (cardmarket-html.js) that singles use. Cloudflare blocks ~most of
//      the time — when it does, we return null market_value with
//      blocked_by:'cloudflare' so the route surfaces the URL only and the
//      operator/customer can check live.
//   3. Accepts an operator-supplied `manual_market_eur` override so a
//      vendor can paste a price they see on the live Cardmarket page.
//      That bypasses the scrape entirely and yields confidence 0.95
//      (operator-vouched).
//
// NO PAID API REQUIRED. isAvailable() is always true. The adapter degrades
// gracefully when both scrape + manual override are absent.
//
// V2.0.1 swap: this file replaces tcgplayer-pro.js as the sole sealed
// adapter. TCGPlayer Pro adapter is removed in the same commit; sealed
// pipeline (pricing/sealed/{verify,price}.js) dispatches to this adapter.

import {
  SEALED_BASE_CONFIDENCE,
  SEALED_RECENT_BONUS,
  SEALED_STALE_PENALTY,
  SEALED_RECENT_THRESHOLD_HOURS,
  SEALED_STALE_THRESHOLD_DAYS,
} from '../confidence.js';
import { SEALED_CATEGORIES, normalizeSealedSku } from '../sealed/product-types.js';
import { fetchCardmarketPrice } from './cardmarket-html.js';

const NAME = 'cardmarket-sealed';

// Cardmarket URL conventions per game. The {category} segment is
// human-readable: 'Booster-Boxes', 'Boosters', 'Elite-Trainer-Boxes',
// 'Bundles', 'Collection-Boxes'.
const GAME_SLUGS = {
  pokemon: 'Pokemon',
  magic: 'Magic',
  lorcana: 'Lorcana',
  onepiece: 'OnePiece',
  starwars: 'StarWarsUnlimited',
  yugioh: 'YuGiOh',
};

// SealedProduct.category → Cardmarket URL segment.
const CATEGORY_TO_CM_SEGMENT = {
  'booster': 'Boosters',
  'booster-box': 'Booster-Boxes',
  'etb': 'Elite-Trainer-Boxes',
  'bundle': 'Bundles',
  'collection-box': 'Collection-Boxes',
  'special-collection': 'Collection-Boxes', // Cardmarket lumps these
};

/**
 * Build a Cardmarket product-or-search URL from a SealedProduct shape.
 *
 * Input shape (any of these works):
 *   { game, category, set_code, set_name, name, cardmarket_url? }
 *
 * If cardmarket_url is provided, we trust it as-is (operator-supplied or
 * carried from a prior verify call). Otherwise we build a /Products/Search
 * URL using game + category segment + name; the user follows it to find
 * the exact product. Building a perfect direct product URL would require
 * Cardmarket's slug-from-name conventions which are NOT publicly
 * documented and break on every set rename — search is more robust.
 */
export function buildSealedCardmarketUrl(product) {
  if (!product) return null;
  if (typeof product.cardmarket_url === 'string' && product.cardmarket_url.includes('cardmarket.com')) {
    return product.cardmarket_url;
  }

  const gameSlug = GAME_SLUGS[product.game] || null;
  if (!gameSlug) return null;

  const catSegment = CATEGORY_TO_CM_SEGMENT[product.category] || 'Boosters';
  const searchTerm = [
    product.set_name || product.set_code || '',
    product.name || '',
  ].filter(Boolean).join(' ').trim();

  if (!searchTerm) {
    // Fall back to the category landing page.
    return `https://www.cardmarket.com/en/${gameSlug}/Products/${catSegment}`;
  }

  return `https://www.cardmarket.com/en/${gameSlug}/Products/${catSegment}?searchString=` +
    encodeURIComponent(searchTerm);
}

/**
 * Confidence per V2_ARCHITECTURE §3.3 + Q3 sealed:
 *   - Operator-supplied manual override: 0.95 (highest — they're looking at
 *     the live page).
 *   - Successful HTML scrape: SEALED_BASE_CONFIDENCE (0.85) + recency bonus.
 *   - Cloudflare-blocked / no data: 0 (with blocked_by tag).
 */
function sealedConfidence({ source, lastUpdated }) {
  if (source === 'manual') return 0.95;

  let confidence = SEALED_BASE_CONFIDENCE;
  if (!lastUpdated) return confidence;

  try {
    const ts = new Date(lastUpdated).getTime();
    const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
    if (ageHours <= SEALED_RECENT_THRESHOLD_HOURS) {
      confidence += SEALED_RECENT_BONUS;
    } else if (ageHours / 24 >= SEALED_STALE_THRESHOLD_DAYS) {
      confidence += SEALED_STALE_PENALTY;
    }
    return Math.max(0, Math.min(1, confidence));
  } catch {
    return SEALED_BASE_CONFIDENCE;
  }
}

/**
 * Verify a sealed product. Cardmarket-sealed has no real catalog API; we
 * accept any input that has enough fields to build a product URL. The
 * "verification" is structural (do we have what we need to build a URL).
 *
 * @param {object} input  { sku?, game, category, set_code?, set_name?, name?, cardmarket_url? }
 * @param {object} ctx
 * @returns {Promise<import('../sealed/product-types.js').SealedProduct | null>}
 */
export async function verifySealed(input, _ctx = {}) {
  if (!input || typeof input !== 'object') return null;

  const game = input.game || null;
  const category = input.category || null;
  if (!game || !GAME_SLUGS[game]) return null;
  if (!category || !SEALED_CATEGORIES.includes(category)) return null;

  // Need at least one identifier — name OR set_name OR a cardmarket_url.
  const hasIdentifier =
    (typeof input.name === 'string' && input.name.trim().length > 0) ||
    (typeof input.set_name === 'string' && input.set_name.trim().length > 0) ||
    (typeof input.cardmarket_url === 'string' && input.cardmarket_url.includes('cardmarket.com'));
  if (!hasIdentifier) return null;

  const url = buildSealedCardmarketUrl(input);
  return {
    sku: normalizeSealedSku(input.sku || `${game}-${category}-${input.set_code || ''}-${input.name || ''}`),
    game,
    category,
    set_code: input.set_code || null,
    set_name: input.set_name || null,
    name: input.name || (input.set_name ? `${input.set_name} ${category}` : 'Sealed product'),
    image_url: null,                  // Cardmarket scrape may surface this later
    language: input.language || 'en',
    cardmarket_url: url,
  };
}

/**
 * Quote a sealed-product price.
 *
 * Inputs honoured (in priority order):
 *   1. opts.manual_market_eur — operator-supplied. Highest confidence.
 *      Skips the scrape entirely; useful when Cardmarket blocks us or when
 *      the operator just wants to record a known price.
 *   2. Live Cardmarket HTML scrape via fetchCardmarketPrice (the same
 *      primitive used for singles). Returns null market_value_eur with
 *      blocked_by:'cloudflare' on 403.
 *
 * Cardmarket prices are EUR-native, so raw_currency='EUR' and no FX is
 * applied. ctx.fxRate is ignored.
 *
 * @param {import('../sealed/product-types.js').SealedProduct} product
 * @param {object} ctx     { signal?: AbortSignal, manual_market_eur?: number }
 * @returns {Promise<import('../sealed/product-types.js').SealedQuote | null>}
 */
export async function priceSealed(product, ctx = {}) {
  if (!product || !product.cardmarket_url) {
    // Re-verify if a bare product was passed.
    const v = await verifySealed(product, ctx);
    if (!v || !v.cardmarket_url) return null;
    product = v;
  }

  // Manual override path — operator vouches for the price they see live.
  if (typeof ctx.manual_market_eur === 'number' && ctx.manual_market_eur >= 0) {
    return {
      source: NAME,
      market_value_eur: Math.round(ctx.manual_market_eur * 100) / 100,
      raw_currency: 'EUR',
      raw_value: ctx.manual_market_eur,
      low: null,
      high: null,
      confidence: sealedConfidence({ source: 'manual' }),
      fetched_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      product_url: product.cardmarket_url,
      blocked_by: null,
      method: 'manual',
    };
  }

  // Best-effort HTML scrape. Cloudflare blocks ~most of the time; when it
  // does, we still return a quote object so the route can surface the URL.
  // condition='NM' is the standard sealed default (Cardmarket's filter
  // ignores condition for sealed but the scrape function expects it).
  const scraped = await fetchCardmarketPrice(product.cardmarket_url, 'NM');

  if (!scraped) {
    return {
      source: NAME,
      market_value_eur: null,
      raw_currency: 'EUR',
      raw_value: null,
      low: null,
      high: null,
      confidence: 0,
      fetched_at: new Date().toISOString(),
      last_updated: null,
      product_url: product.cardmarket_url,
      blocked_by: 'cloudflare',
      method: 'scrape_blocked',
    };
  }

  // The shared scrape helper returns { price, low, trend, avg30, ... }.
  const market = scraped.price ?? scraped.low ?? scraped.trend ?? null;
  return {
    source: NAME,
    market_value_eur: market != null ? Math.round(market * 100) / 100 : null,
    raw_currency: 'EUR',
    raw_value: market,
    low: scraped.low ?? null,
    high: scraped.trend != null && scraped.low != null ? Math.max(scraped.trend, scraped.low) : null,
    confidence: sealedConfidence({ lastUpdated: new Date().toISOString() }),
    fetched_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    product_url: product.cardmarket_url,
    blocked_by: null,
    method: 'scrape',
  };
}

/**
 * Search Cardmarket sealed products. We don't have an API, so this
 * returns a single "search-link" pseudo-product the operator can follow
 * to refine. Not used by the standard flow — the fan-out goes through
 * verifySealed + priceSealed.
 */
export async function searchSealed(query, opts = {}) {
  const game = opts.game || 'pokemon';
  const category = opts.category || 'booster-box';
  const url = buildSealedCardmarketUrl({ game, category, name: query });
  return [{
    sku: `search:${game}:${category}:${normalizeSealedSku(query)}`,
    game,
    category,
    set_code: null,
    set_name: null,
    name: query,
    image_url: null,
    language: 'en',
    cardmarket_url: url,
  }];
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
    games: Object.keys(GAME_SLUGS),
    categories: SEALED_CATEGORIES,
    needs: ['game', 'category'],
  },
  isAvailable() {
    // No API key required. Always available — worst case the scrape is
    // Cloudflare-blocked and we return null market with blocked_by tag.
    return true;
  },
  verifySealed,
  priceSealed,
  searchSealed,
  buildSealedCardmarketUrl,
};
