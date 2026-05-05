// pricing/sealed/product-types.js
//
// Owner: A2 (Pricing engine) — Slice S17 (sealed product pricing)
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5 (sealed product pricing tier)
//   - pricing/adapter.interface.md §1 (single-card type analogue)
//
// Sealed products are NOT cards. They have a SKU (operator-known or selected
// from a catalog search), a category (booster / etb / booster-box / bundle /
// collection-box / special-collection) and a set/name pair for display.
// There is no condition/printing/graded axis — sealed prices are flat
// (market_value × buyPercentage with implicit condition_multiplier 1.0).
//
// JSDoc-typed shapes only. Helpers are pure (no I/O).

/**
 * Sealed product categories. The single canonical list — adapters / UI use
 * this to gate their search filters. Order is the operator-facing display
 * priority for tabs in the picker UI (deferred — F5 client UI).
 *
 * @type {ReadonlyArray<'booster'|'etb'|'booster-box'|'bundle'|'collection-box'|'special-collection'>}
 */
export const SEALED_CATEGORIES = Object.freeze([
  'booster',
  'etb',
  'booster-box',
  'bundle',
  'collection-box',
  'special-collection',
]);

/**
 * Canonical sealed product. Distinct from VerifiedCard:
 *   - keyed on sku (not card_number)
 *   - no condition / printing / graded fields
 *   - language defaults to 'en' (sealed listings rarely diverge per locale)
 *
 * @typedef {object} SealedProduct
 * @property {string} sku
 *   Unique identifier. May be a TCGPlayer product id (numeric string) or a
 *   hand-rolled slug like 'pokemon-sv8-booster-box'. Always normalised via
 *   normalizeSealedSku before use as a key.
 * @property {'booster'|'etb'|'booster-box'|'bundle'|'collection-box'|'special-collection'} category
 * @property {string} set_code      Set abbreviation, e.g. "SV8".
 * @property {string} set_name      Set display name, e.g. "Surging Sparks".
 * @property {string} name          Display name, e.g. "Surging Sparks Booster Box".
 * @property {string|null} image_url
 * @property {string} [language]    Defaults to 'en' when omitted.
 * @property {string} [game]        'pokemon' | 'magic' | 'lorcana' | … —
 *                                  optional, filtering use only.
 */

/**
 * Result of priceSealed for a single source. Analogous to PriceQuote in the
 * single-card adapter contract, minus the condition / printing / graded
 * complications.
 *
 * @typedef {object} SealedQuote
 * @property {string} source              Adapter name ('cardmarket-sealed' for V2.0.1).
 * @property {number|null} market_value_eur
 * @property {'EUR'|'USD'} raw_currency
 * @property {number|null} raw_value
 * @property {number|null} [low]
 * @property {number|null} [high]
 * @property {number} confidence          0..1
 * @property {string} fetched_at          ISO8601
 * @property {string|null} [last_updated] ISO8601 — upstream's "data freshness"
 *                                        timestamp (NOT our fetch time).
 * @property {'rate_limit'|'auth'|'timeout'|null} [blocked_by]
 */

/**
 * Normalise a SKU for use as a cache / storage key. Lower-cases, trims, and
 * collapses internal whitespace to a single dash. Idempotent: f(f(x)) === f(x).
 *
 * Numeric SKUs (TCGPlayer product ids like "247632") pass through unchanged
 * after lowercase + trim. Hand-rolled slugs ("Pokemon SV8 Booster Box") get
 * normalised to "pokemon-sv8-booster-box".
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSealedSku(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  // Collapse runs of whitespace, underscore, or dash to a single dash.
  // Strip anything that's not a-z, 0-9, or dash.
  return trimmed
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * Cheap shape guard — true if x looks like a SealedProduct. Used by verify
 * adapters that need to round-trip an upstream response.
 *
 * @param {unknown} x
 * @returns {boolean}
 */
export function isSealedProduct(x) {
  if (!x || typeof x !== 'object') return false;
  const p = /** @type {Record<string, unknown>} */ (x);
  return (
    typeof p.sku === 'string' && p.sku.length > 0 &&
    typeof p.category === 'string' && SEALED_CATEGORIES.includes(/** @type {any} */ (p.category)) &&
    typeof p.name === 'string' && p.name.length > 0
  );
}
