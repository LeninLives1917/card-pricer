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
/**
 * CARDMARKET'S SCALE, because Cardmarket is what we price against.
 *
 * The app used NM/LP/MP/HP/DMG — a TCGPlayer-shaped five-grade scale — and
 * then filtered Cardmarket with `minCondition` codes that meant something
 * else. cardmarket-html.js mapped { NM:2, LP:4, MP:5, HP:6, DMG:7 }, and
 * Cardmarket's codes are 1=MT, 2=NM, 3=EX, 4=GD, 5=LP, 6=PL, 7=PO. So the
 * grade called "LP" was asking Cardmarket for GOOD, "MP" was asking for
 * LIGHT PLAYED, and "HP" for PLAYED. The label and the filter disagreed by a
 * grade on every row.
 *
 * THE MONEY DOES NOT MOVE. Each multiplier stays attached to the Cardmarket
 * grade it was already filtering for — the old "LP" number becomes GD, the
 * old "MP" number becomes LP, and so on. This is a rename to what the values
 * always meant, not a repricing.
 *
 *   old NM  1.00  ->  NM  (code 2)   unchanged
 *                     EX  (code 3)   NEW — nothing filtered for it before
 *   old LP  0.85  ->  GD  (code 4)   same number, correct name
 *   old MP  0.70  ->  LP  (code 5)   same number, correct name
 *   old HP  0.50  ->  PL  (code 6)   same number, correct name
 *   old DMG 0.30  ->  PO  (code 7)   same number, correct name
 *
 * EX is the one genuinely new grade and the one genuinely new number. 0.92
 * sits between NM and GD and is an operator judgement, not a measurement —
 * change it freely.
 *
 * NOTE THE COLLISION: "LP" now means Light Played (0.70) where it used to
 * mean the grade Cardmarket calls Good (0.85). Session rows store their
 * computed buy_price, so history is unaffected; only RE-pricing an old row
 * would differ.
 */
export const CONDITION_MULTIPLIERS = Object.freeze({
  MT:  1.00,   // Mint. We do not pay more than NM for it.
  NM:  1.00,
  EX:  0.92,
  GD:  0.85,
  LP:  0.70,
  PL:  0.50,
  PO:  0.30,

  // Legacy grades, kept so a stored session or an in-flight request written
  // against the old vocabulary still prices the way it did. Not offered in
  // the UI. MP/HP/DMG have no Cardmarket equivalent by those names.
  MP:  0.70,
  HP:  0.50,
  DMG: 0.30,
});

/**
 * The grades offered in the UI, best first. Cardmarket's own order.
 */
export const CONDITION_ORDER = Object.freeze(['NM', 'EX', 'GD', 'LP', 'PL', 'PO']);

/** Full names, for a picker that has room for them. */
export const CONDITION_LABELS = Object.freeze({
  MT: 'Mint',
  NM: 'Near Mint',
  EX: 'Excellent',
  GD: 'Good',
  LP: 'Light Played',
  PL: 'Played',
  PO: 'Poor',
  MP: 'Moderately Played (legacy)',
  HP: 'Heavily Played (legacy)',
  DMG: 'Damaged (legacy)',
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
