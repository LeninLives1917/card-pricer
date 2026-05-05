// pricing/sealed/price.js
//
// Owner: A2 (Pricing engine) — Slice S17
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5
//   - pricing/sealed/verify.js (verifySealed)
//   - pricing/adapters/tcgplayer-pro.js (only adapter for V2)
//   - pricing/sealed/product-types.js (SealedProduct, SealedQuote)
//   - pricing/fx.js (getUsdToEur — adapters apply this themselves; we pass
//     the rate via ctx so they don't re-import)
//
// Fan-out + selection for /api/v2/price-sealed.
//
// Differences vs single-card priceCard():
//   - SKU-keyed input, not card-number/set/name.
//   - condition_multiplier is implicitly 1.0 (sealed has no condition axis).
//   - NO hotness scoring. Sealed product trends move weekly, not daily;
//     surfacing a "hot" badge against weekly data is misleading. If/when we
//     add weekly trend data we can revisit.
//   - Source priority is trivial (one source for V2).

import { getUsdToEur } from '../fx.js';
import tcgplayerPro from '../adapters/tcgplayer-pro.js';
import { verifySealed, isSealedVerifyAvailable, SEALED_VERIFY_ADAPTERS } from './verify.js';
import { normalizeSealedSku, isSealedProduct } from './product-types.js';

const DEFAULT_BUY_PERCENTAGE = 60;

/**
 * Set of adapters that participate in sealed pricing. Same priority order as
 * verify; today only TCGPlayer Pro.
 *
 * @type {ReadonlyArray<{ name: string, isAvailable: () => boolean, priceSealed: Function }>}
 */
const SEALED_PRICE_ADAPTERS = Object.freeze([tcgplayerPro]);

/**
 * Static priority list for sealed sources — used as a confidence-tie breaker.
 * Today there's only one entry, but the lookup-by-source-name pattern means
 * adding entries doesn't ripple through the selection code.
 *
 * @type {ReadonlyArray<string>}
 */
export const SEALED_STATIC_PRIORITY = Object.freeze(['tcgplayer-pro']);

/**
 * Price a verified sealed product across every available adapter.
 *
 * @param {import('./product-types.js').SealedProduct} verifiedProduct
 *   Output of verifySealed — adapter-canonicalised SKU + name + image.
 * @param {object} [ctx]
 *   AdapterCtx — { axios?, fxRate?, log?, signal? }. fxRate defaults to the
 *   live USD→EUR rate from pricing/fx.js when not supplied.
 * @param {object} [opts]
 * @param {number} [opts.buyPercentage=60]
 *   0..100. The engine applies this to the picked market value AFTER source
 *   selection (sealed has no condition multiplier — implicit 1.0).
 * @returns {Promise<{
 *   product: import('./product-types.js').SealedProduct,
 *   market: number|null,
 *   low: number|null,
 *   high: number|null,
 *   buy_price: { suggested: number|null, market_value: number|null, formula: string|null, currency: 'EUR' } | null,
 *   v2: { selected_source: string|null, sources: Array<import('./product-types.js').SealedQuote>, fx_rate: number, last_updated: string|null }
 * }>}
 */
export async function priceSealed(verifiedProduct, ctx = {}, opts = {}) {
  if (!isSealedProduct(verifiedProduct)) {
    throw new Error('priceSealed: input is not a SealedProduct');
  }

  const buyPercentage = clampBuyPercentage(opts.buyPercentage ?? DEFAULT_BUY_PERCENTAGE);
  const fxRate = typeof ctx.fxRate === 'number' && ctx.fxRate > 0 ? ctx.fxRate : getUsdToEur();
  const adapterCtx = { ...ctx, fxRate };

  // Fan out across every available sealed adapter. Promise.all (not
  // Promise.allSettled) so unexpected throws bubble — the route catches
  // and 5xx's. Adapter-level "no data" returns null cleanly.
  const settled = await Promise.allSettled(
    SEALED_PRICE_ADAPTERS
      .filter(a => a.isAvailable && a.isAvailable())
      .map(a => a.priceSealed(verifiedProduct, adapterCtx))
  );

  /** @type {import('./product-types.js').SealedQuote[]} */
  const quotes = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) quotes.push(r.value);
    else if (r.status === 'rejected') {
      ctx.log?.warn?.(`[sealed-price] adapter threw: ${r.reason?.message || r.reason}`);
    }
  }

  const selected = selectQuote(quotes);

  let buyPrice = null;
  if (selected && typeof selected.market_value_eur === 'number') {
    const suggested = round2(selected.market_value_eur * (buyPercentage / 100));
    buyPrice = {
      suggested,
      market_value: selected.market_value_eur,
      formula: `${selected.market_value_eur.toFixed(2)}€ × ${buyPercentage}% = ${suggested.toFixed(2)}€`,
      currency: 'EUR',
    };
  }

  return {
    product: verifiedProduct,
    market: selected?.market_value_eur ?? null,
    low:    selected?.low ?? null,
    high:   selected?.high ?? null,
    buy_price: buyPrice,
    v2: {
      selected_source: selected?.source ?? null,
      sources: quotes,
      fx_rate: fxRate,
      last_updated: selected?.last_updated ?? null,
    },
  };
}

/**
 * Select the best quote: confidence DESC, then static priority. Skip null
 * market_value_eur (treated as "no data from this source").
 *
 * @param {ReadonlyArray<import('./product-types.js').SealedQuote>} quotes
 * @returns {import('./product-types.js').SealedQuote | null}
 */
function selectQuote(quotes) {
  const usable = quotes.filter(q => q && q.market_value_eur != null);
  if (!usable.length) return null;
  usable.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return SEALED_STATIC_PRIORITY.indexOf(a.source) - SEALED_STATIC_PRIORITY.indexOf(b.source);
  });
  return usable[0];
}

function clampBuyPercentage(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_BUY_PERCENTAGE;
  if (n < 1)   return 1;
  if (n > 100) return 100;
  return n;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * One-shot helper combining verify + price. The route uses this so the SKU
 * is canonicalised before the (paid) price call.
 *
 * @param {string} rawSku
 * @param {object} [ctx]
 * @param {object} [opts]
 * @returns {Promise<null | Awaited<ReturnType<typeof priceSealed>>>}
 *   null when verify says the SKU doesn't exist.
 */
export async function verifyAndPrice(rawSku, ctx = {}, opts = {}) {
  const sku = normalizeSealedSku(rawSku);
  if (!sku) return null;
  const product = await verifySealed({ sku }, ctx);
  if (!product) return null;
  return priceSealed(product, ctx, opts);
}

// Re-exports for the route + tests.
export { isSealedVerifyAvailable, SEALED_VERIFY_ADAPTERS, SEALED_PRICE_ADAPTERS };
