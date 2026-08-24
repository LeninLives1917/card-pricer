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
/**
 * MEASURED, 24 Aug 2026. These were operator estimates inherited from V1 —
 * this comment block used to say so and invite anyone to change them. Two
 * independent measurements now say the played grades were far too generous,
 * which means the shop was overpaying on every card that was not Near Mint.
 *
 * SOURCE 1 — a real condition ladder, TCGplayer market via JustTCG.
 * 397 unique (card x printing) ladders, ratios taken against the Near Mint of
 * the SAME printing so the finish is not confounded with the condition:
 *
 *     tier    n     p25   median    p75      old value
 *     LP    375    0.58     0.68   0.80      0.70   (about right)
 *     MP    382    0.36     0.48   0.60      0.70   far too generous
 *     HP    361    0.23     0.33   0.44      0.50   far too generous
 *     DMG   378    0.19     0.27   0.38      0.30   about right
 *
 * The discount barely moves with card value — LP/NM runs 0.77 under $1 and
 * flattens to ~0.65 above $5 — so a flat multiplier is defensible and no
 * value-tiered rule is needed.
 *
 * SOURCE 2 — the euro market, independent of TCGplayer. Cardmarket publishes
 * lowPrice (cheapest listing in ANY condition) and lowPriceExPlus (cheapest in
 * Excellent or better). Their ratio is a direct read on what condition costs in
 * EUR. Counting only the 9,237 cards where a sub-EX listing actually exists —
 * where lowPrice = lowPriceExPlus the card simply has no played copy listed and
 * the pair says nothing:
 *
 *     EX+ price      n     p25   median    p75
 *     under EUR 1  4285    0.20     0.40   0.50
 *     EUR 1-5      2253    0.25     0.45   0.67
 *     EUR 5-20     1516    0.29     0.48   0.69
 *     EUR 20-100    952    0.24     0.38   0.57
 *     over EUR 100  231    0.23     0.35   0.53
 *
 * A played copy sits at roughly 0.35-0.48 of an EX+ one, and gets STEEPER on
 * expensive cards. That corroborates the lower half of the TCGplayer ladder
 * from a different market, a different marketplace and a different method.
 *
 * THE SCALE MAPPING IS A JUDGEMENT, and the weakest link here. Cardmarket has
 * seven grades, TCGplayer five, and they are not aligned — Cardmarket's are
 * finer at the top. The correspondence used:
 *
 *     CM NM  <- TP NM                    1.00   definitional
 *     CM EX  <- between TP NM and TP LP  0.84
 *     CM GD  <- TP LP                    0.68   measured directly
 *     CM LP  <- between TP LP and TP MP  0.58
 *     CM PL  <- between TP MP and TP HP  0.40
 *     CM PO  <- TP HP / TP DMG           0.30
 *
 * Source 2 is the check on that mapping: LP 0.58 and PL 0.40 bracket the EUR
 * median of 0.38-0.48, which is where a "cheapest played listing" should fall.
 *
 * WHAT CHANGED, on a EUR 100 card at a 60% buy rate:
 *
 *     EX  0.92 -> 0.84    offer EUR 55.20 -> 50.40
 *     GD  0.85 -> 0.68    offer EUR 51.00 -> 40.80
 *     LP  0.70 -> 0.58    offer EUR 42.00 -> 34.80
 *     PL  0.50 -> 0.40    offer EUR 30.00 -> 24.00
 *     PO  0.30 -> 0.30    unchanged
 *
 * Both measurements are of ASKING prices, not completed sales, because no
 * source available to us publishes sold data — Cardmarket's own API is closed
 * to new applications. Re-measure when that changes.
 */
export const CONDITION_MULTIPLIERS = Object.freeze({
  MT:  1.00,   // Mint. We do not pay more than NM for it.
  NM:  1.00,
  EX:  0.84,
  GD:  0.68,
  LP:  0.58,
  PL:  0.40,
  PO:  0.30,

  // Legacy grades. These have always been ALIASES for a Cardmarket grade —
  // cardmarket-html.js maps MP/HP/DMG to codes 5/6/7, the same codes as
  // LP/PL/PO — so they track their alias rather than holding old values. Not
  // offered in the UI.
  MP:  0.58,   // alias of LP
  HP:  0.40,   // alias of PL
  DMG: 0.30,   // alias of PO
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
