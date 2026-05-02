// Types for the arbitrage finder. The shape comes from pokemontcg.io's
// embedded `cardmarket.prices` (EUR) and `tcgplayer.prices` (USD) payloads.
// We capture only the fields we use; the upstream returns more.

export type ArbitrageDirection = 'us_to_eu' | 'eu_to_us';

/** TCGplayer per-variant price block. */
export interface TcgVariantPrices {
  /** Lowest listing — useful for tcgLow/market liquidity proxy. */
  low?: number;
  mid?: number;
  high?: number;
  /** TCGplayer's own market estimate (used as our anchor). */
  market?: number;
  directLow?: number;
}

/** TCGplayer prices for one card. Each key is a variant. */
export interface TcgPrices {
  normal?: TcgVariantPrices;
  holofoil?: TcgVariantPrices;
  reverseHolofoil?: TcgVariantPrices;
  '1stEditionNormal'?: TcgVariantPrices;
  '1stEditionHolofoil'?: TcgVariantPrices;
  unlimitedHolofoil?: TcgVariantPrices;
}

/** Cardmarket prices for one card. EUR. */
export interface CmPrices {
  averageSellPrice?: number;
  lowPrice?: number;
  trendPrice?: number;
  germanProLow?: number;
  suggestedPrice?: number;
  reverseHoloSell?: number;
  reverseHoloLow?: number;
  reverseHoloTrend?: number;
  lowPriceExPlus?: number;
  avg1?: number;
  avg7?: number;
  avg30?: number;
  reverseHoloAvg1?: number;
  reverseHoloAvg7?: number;
  reverseHoloAvg30?: number;
}

/** A single priced-card entry — one row in the in-memory CARD_PRICES table. */
export interface CardPriceEntry {
  name: string;
  setId: string;
  setName: string;
  setCode: string;
  number: string;
  rarity: string;
  image?: string | null;
  cardmarketUrl?: string | null;
  tcgplayerUrl?: string | null;
  tcg: TcgPrices | null;
  cm: CmPrices | null;
  fetchedAt?: number;
}

/**
 * One viable variant pairing for a card.
 * tcg.normal/holofoil/1stEd  ↔  cm.lowPriceExPlus|lowPrice|trendPrice
 * tcg.reverseHolofoil        ↔  cm.reverseHoloLow|reverseHoloTrend
 *
 * Direction-aware:
 *   us_to_eu — ratio = eur / converted-usd  (buy US, sell EU)
 *   eu_to_us — ratio = converted-usd / eur  (buy EU, sell US)
 *
 * cmAvg7/cmAvg30 are matched to the same variant axis so liquidity proxies
 * line up with the price pair.
 */
export interface ArbitrageVariant {
  variant: keyof TcgPrices;
  /** USD market price from TCGplayer for this variant. */
  usd: number;
  /** EUR price from Cardmarket for this variant. */
  eur: number;
  /** USD converted to EUR via the day's USD→EUR rate. */
  usdInEur: number;
  /** Higher = better. Direction-aware. */
  ratio: number;
  /** Liquidity proxy: TCGplayer low/market for this variant. */
  tcgLow: number;
  /** EU 7-day rolling average for this variant axis. */
  cmAvg7: number;
  /** EU 30-day rolling average for this variant axis. */
  cmAvg30: number;
}
