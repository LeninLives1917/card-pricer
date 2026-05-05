// pricing/conditions.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - docs/V2_AUDIT.md §2 (graded skips condition multiplier)
//   - V1 server.js:4737-4740 (multiplier table) and :4925 (graded path)
//
// Single source of truth for the NM/LP/MP/HP/DMG → multiplier mapping. Pulled
// out of the inline table in V1 /api/price so V2 sealed pricing + sub-listing
// P&L (F18) can share the same numbers without copy-paste drift.
//
// ESM module — every export is a named const.

/**
 * Ungraded card condition multipliers. Applied to market value BEFORE the
 * vendor buy-percentage. NM is canonical (multiplier 1.0); the other
 * grades are operator-defined approximations of how condition compresses
 * market value for a vendor reselling at NM-equivalent.
 *
 * Keep these stable — every test in tests/regression/pricing-fanout.spec.js
 * that touches buy_price math reads them.
 */
export const CONDITION_MULTIPLIERS = Object.freeze({
  NM:  1.00,
  LP:  0.85,
  MP:  0.70,
  HP:  0.50,
  DMG: 0.30,
});

/**
 * Apply the condition multiplier to a market value. Graded cards skip the
 * multiplier entirely (the grade IS the condition — V1 server.js:4925) and
 * the engine selects from graded comp prices instead.
 *
 * @param {number} price        Pre-condition market value (any currency).
 * @param {string} [condition]  One of NM/LP/MP/HP/DMG. Defaults NM.
 * @param {boolean} [graded]    If truthy, multiplier is forced to 1.0.
 * @returns {{ price: number, multiplier: number, condition: string }}
 */
export function applyCondition(price, condition = 'NM', graded = false) {
  const cond = String(condition || 'NM').toUpperCase();
  const multiplier = graded ? 1.0 : (CONDITION_MULTIPLIERS[cond] ?? 1.0);
  return {
    price: Math.round(Number(price || 0) * multiplier * 100) / 100,
    multiplier,
    condition: cond,
  };
}
