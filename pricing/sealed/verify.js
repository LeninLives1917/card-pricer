// pricing/sealed/verify.js
//
// Owner: A2 (Pricing engine) — Slice S17 + V2.0.1 (Cardmarket swap)
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5
//   - pricing/sealed/product-types.js (SealedProduct shape + normalizeSealedSku)
//   - pricing/adapters/cardmarket-sealed.js (sole adapter for V2)
//
// Sealed verify is much simpler than single-card verify:
//   - SKU is the canonical identifier when known; otherwise the adapter
//     builds it from {game, category, set_code?, set_name?, name?}.
//   - There is no AI-identification step that needs HP/name/number cross-
//     referencing — verify here is "do we have enough fields to build a
//     canonical product URL, and what's the SealedProduct shape?".
//   - Single-adapter dispatch for V2 (Cardmarket sealed). Future-friendly
//     to add more adapters when they ship sealed APIs (e.g. eBay-sold,
//     Snapcaster).
//
// V2.0.1 swap: replaces tcgplayer-pro with cardmarket-sealed. The latter
// requires no API key — the route never returns 503 on a missing key.

import cardmarketSealed from '../adapters/cardmarket-sealed.js';
import { normalizeSealedSku, isSealedProduct } from './product-types.js';

/**
 * Set of adapters that participate in sealed verify. Order = priority — the
 * first adapter that says "yes I have this product" wins. Today only one
 * entry; the array shape future-proofs the dispatch loop.
 *
 * @type {ReadonlyArray<{ name: string, isAvailable: () => boolean, verifySealed: Function }>}
 */
const SEALED_VERIFY_ADAPTERS = Object.freeze([cardmarketSealed]);

/**
 * Verify a sealed product. Two input shapes accepted:
 *   1. A bare SKU string (when the operator knows it from a prior search).
 *   2. A rich object: { sku?, game, category, set_code?, set_name?, name?,
 *      cardmarket_url?, language? }. cardmarket-sealed needs at least
 *      game + category + (name OR set_name OR cardmarket_url) to build
 *      the canonical URL.
 *
 * Returns the canonical SealedProduct or null if no adapter recognises it.
 *
 * The contract mirrors the single-card adapter contract:
 *   - return null on "no match" (looked, didn't find)
 *   - throw only on unexpected upstream failures (network, malformed JSON);
 *     callers (pricing/sealed/price.js + the route) catch + log + return
 *     null to the client.
 *   - MUST NOT mutate input.
 *
 * @param {{sku?: string, game?: string, category?: string, set_code?: string, set_name?: string, name?: string, cardmarket_url?: string, language?: string} | string} input
 * @param {object} [ctx]
 *   AdapterCtx — { axios, fxRate, log, signal }. Threaded through to the
 *   adapter so adapter doesn't re-read process.env per call.
 * @returns {Promise<import('./product-types.js').SealedProduct | null>}
 */
export async function verifySealed(input, ctx = {}) {
  // Normalise both shapes into the rich object adapters expect.
  const richInput = typeof input === 'string'
    ? { sku: normalizeSealedSku(input) }
    : { ...(input || {}) };
  if (richInput.sku) richInput.sku = normalizeSealedSku(richInput.sku);

  for (const adapter of SEALED_VERIFY_ADAPTERS) {
    if (!adapter.isAvailable || !adapter.isAvailable()) continue;
    try {
      const product = await adapter.verifySealed(richInput, ctx);
      if (product && isSealedProduct(product)) return product;
    } catch (e) {
      // Adapter-level failure = fall through to the next adapter. Log via
      // the ctx logger if one was supplied.
      ctx.log?.warn?.(`[sealed-verify] ${adapter.name} threw: ${e?.message || e}`);
      continue;
    }
  }

  return null;
}

/**
 * Cheap sync helper — returns true if any adapter is configured to answer
 * sealed verifies right now. Cardmarket-sealed requires no API key so this
 * is always true once the adapter loads. Kept for symmetry with the single-
 * card priceCard fan-out and for forward-compat when paid sealed adapters
 * land.
 *
 * @returns {boolean}
 */
export function isSealedVerifyAvailable() {
  return SEALED_VERIFY_ADAPTERS.some(a => a.isAvailable && a.isAvailable());
}

// Re-exported for the route handler (which may want to surface the adapter
// list in error messages).
export { SEALED_VERIFY_ADAPTERS };
