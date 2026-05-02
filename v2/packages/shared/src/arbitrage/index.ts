// Arbitrage finder — port of v1's server.js arbitrageVariants/bestArbitrage/
// singleVariantArbitrage. Pure functions, pure TS, fully unit-testable.
// Same scoring as v1.70: see ../../../V2_PLAN.md §"What we keep from v1".

import type {
  ArbitrageDirection,
  ArbitrageVariant,
  CardPriceEntry,
  TcgPrices,
} from './types.js';

export type { ArbitrageDirection, ArbitrageVariant, CardPriceEntry } from './types.js';

const NON_REVERSE_VARIANTS = [
  'normal',
  'holofoil',
  '1stEditionNormal',
  '1stEditionHolofoil',
  'unlimitedHolofoil',
] as const satisfies ReadonlyArray<keyof TcgPrices>;

/**
 * Return EVERY viable variant pair for one card, with computed ratio.
 * "auto" mode in the UI emits one row per variant; this is the source.
 *
 *  normal/holofoil/1stEd  ↔  cardmarket.lowPriceExPlus|lowPrice|trendPrice
 *  reverseHolofoil        ↔  cardmarket.reverseHoloLow|reverseHoloTrend
 *
 * Never crosses the streams.
 */
export function arbitrageVariants(
  entry: CardPriceEntry,
  usdToEurRate: number,
  direction: ArbitrageDirection = 'us_to_eu',
): ArbitrageVariant[] {
  if (!entry.tcg || !entry.cm) return [];
  const cm = entry.cm;
  const tcg = entry.tcg;

  const cmNormalEur = cm.lowPriceExPlus ?? cm.lowPrice ?? cm.trendPrice ?? 0;
  const cmAvg7 = cm.avg7 ?? 0;
  const cmAvg30 = cm.avg30 ?? 0;
  const cmReverseEur = cm.reverseHoloLow ?? cm.reverseHoloTrend ?? 0;
  const cmReverseAvg7 = cm.reverseHoloAvg7 ?? 0;
  const cmReverseAvg30 = cm.reverseHoloAvg30 ?? 0;

  type Pair = {
    variant: keyof TcgPrices;
    usd: number;
    eur: number;
    tcgLow: number;
    cmAvg7: number;
    cmAvg30: number;
  };
  const pairs: Pair[] = [];

  for (const k of NON_REVERSE_VARIANTS) {
    const v = tcg[k];
    const usd = v?.market;
    if (usd && cmNormalEur) {
      pairs.push({
        variant: k,
        usd,
        eur: cmNormalEur,
        tcgLow: v?.low ?? 0,
        cmAvg7,
        cmAvg30,
      });
    }
  }
  if (tcg.reverseHolofoil?.market && cmReverseEur) {
    pairs.push({
      variant: 'reverseHolofoil',
      usd: tcg.reverseHolofoil.market,
      eur: cmReverseEur,
      tcgLow: tcg.reverseHolofoil.low ?? 0,
      cmAvg7: cmReverseAvg7,
      cmAvg30: cmReverseAvg30,
    });
  }

  const out: ArbitrageVariant[] = [];
  for (const p of pairs) {
    const usdInEur = p.usd * usdToEurRate;
    if (usdInEur <= 0) continue;
    const ratio =
      direction === 'eu_to_us' ? usdInEur / p.eur : p.eur / usdInEur;
    out.push({
      variant: p.variant,
      usd: p.usd,
      eur: p.eur,
      usdInEur,
      ratio,
      tcgLow: p.tcgLow,
      cmAvg7: p.cmAvg7,
      cmAvg30: p.cmAvg30,
    });
  }
  return out;
}

/** The single best variant pair for one card; null when no overlapping price. */
export function bestArbitrage(
  entry: CardPriceEntry,
  usdToEurRate: number,
  direction: ArbitrageDirection = 'us_to_eu',
): ArbitrageVariant | null {
  const all = arbitrageVariants(entry, usdToEurRate, direction);
  let best: ArbitrageVariant | null = null;
  for (const v of all) {
    if (!best || v.ratio > best.ratio) best = v;
  }
  return best;
}

/** Compute arbitrage for a fixed variant — used by the user-picks-variant path. */
export function singleVariantArbitrage(
  entry: CardPriceEntry,
  variant: keyof TcgPrices,
  usdToEurRate: number,
  direction: ArbitrageDirection = 'us_to_eu',
): ArbitrageVariant | null {
  if (!entry.tcg || !entry.cm) return null;
  const tcg = entry.tcg;
  const cm = entry.cm;

  let usd = 0;
  let eur = 0;
  let tcgLow = 0;
  let cmAvg7 = 0;
  let cmAvg30 = 0;

  if (variant === 'reverseHolofoil') {
    usd = tcg.reverseHolofoil?.market ?? 0;
    eur = cm.reverseHoloLow ?? cm.reverseHoloTrend ?? 0;
    tcgLow = tcg.reverseHolofoil?.low ?? 0;
    cmAvg7 = cm.reverseHoloAvg7 ?? 0;
    cmAvg30 = cm.reverseHoloAvg30 ?? 0;
  } else {
    usd = tcg[variant]?.market ?? 0;
    eur = cm.lowPriceExPlus ?? cm.lowPrice ?? cm.trendPrice ?? 0;
    tcgLow = tcg[variant]?.low ?? 0;
    cmAvg7 = cm.avg7 ?? 0;
    cmAvg30 = cm.avg30 ?? 0;
  }

  if (!usd || !eur) return null;
  const usdInEur = usd * usdToEurRate;
  if (usdInEur <= 0) return null;
  const ratio =
    direction === 'eu_to_us' ? usdInEur / eur : eur / usdInEur;

  return { variant, usd, eur, usdInEur, ratio, tcgLow, cmAvg7, cmAvg30 };
}
