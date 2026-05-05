// pricing/sealed/verify.js
//
// Owner: A2 (Pricing engine) — Slice S17
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5
//   - pricing/sealed/product-types.js (SealedProduct shape + normalizeSealedSku)
//   - pricing/adapters/tcgplayer-pro.js (only adapter for V2)
//
// Sealed verify is much simpler than single-card verify:
//   - SKU is the canonical identifier; users either typed it or picked it
//     from a search dropdown.
//   - There is no AI-identification step that needs HP/name/number cross-
//     referencing — verify here is "does this SKU exist in the adapter's
//     catalog, and what's the canonical name/image we should show?".
//   - Single-adapter dispatch for V2 (TCGPlayer Pro). Future-friendly to
//     add Cardmarket if their API ever ships sealed support.

import tcgplayerPro from '../adapters/tcgplayer-pro.js';
import { normalizeSealedSku, isSealedProduct } from './product-types.js';

/**
 * Set of adapters that participate in sealed verify. Order = priority — the
 * first adapter that says "yes I have this SKU" wins. Today only one entry;
 * the array shape future-proofs the dispatch loop.
 *
 * @type {ReadonlyArray<{ name: string, isAvailable: () => boolean, verifySealed: Function }>}
 */
const SEALED_VERIFY_ADAPTERS = Object.freeze([tcgplayerPro]);

/**
 * Verify a sealed product by SKU. Returns the canonical SealedProduct (with
 * image_url + canonical name) or null if no adapter recognises it.
 *
 * The contract mirrors the single-card adapter contract:
 *   - return null on "no match" (looked, didn't find)
 *   - throw only on unexpected upstream failures (network, malformed JSON);
 *     callers (pricing/sealed/price.js + the route) catch + log + return
 *     null to the client.
 *   - MUST NOT mutate input.
 *
 * @param {{sku: string} | string} input
 *   Either the bare SKU string or an object with `.sku`.
 * @param {object} [ctx]
 *   AdapterCtx — { axios, fxRate, log, signal }. Threaded through to the
 *   adapter so adapter doesn't re-read process.env per call.
 * @returns {Promise<import('./product-types.js').SealedProduct | null>}
 */
export async function verifySealed(input, ctx = {}) {
  const sku = normalizeSealedSku(typeof input === 'string' ? input : (input?.sku || ''));
  if (!sku) return null;

  for (const adapter of SEALED_VERIFY_ADAPTERS) {
    if (!adapter.isAvailable || !adapter.isAvailable()) continue;
    try {
      const product = await adapter.verifySealed({ sku }, ctx);
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
 * sealed verifies right now. The route uses this to short-circuit with 503
 * before doing any work.
 *
 * @returns {boolean}
 */
export function isSealedVerifyAvailable() {
  return SEALED_VERIFY_ADAPTERS.some(a => a.isAvailable && a.isAvailable());
}

// Re-exported for the route handler (which needs the same adapter list to
// emit a useful 503 message).
export { SEALED_VERIFY_ADAPTERS };
