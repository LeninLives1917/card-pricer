// Vitest covers the arbitrage logic. Same fixtures we'd use to spot-check
// in v1, just typed and asserted instead of console-logged.

import { describe, expect, it } from 'vitest';
import { arbitrageVariants, bestArbitrage, singleVariantArbitrage } from './index.js';
import type { CardPriceEntry } from './types.js';

const RATE = 0.92; // typical USD→EUR

const charizardLike: CardPriceEntry = {
  name: 'Charizard',
  setId: 'sv8',
  setName: 'Surging Sparks',
  setCode: 'SSP',
  number: '199',
  rarity: 'Special Illustration Rare',
  tcg: {
    holofoil: { low: 90, mid: 105, high: 130, market: 100 },
    reverseHolofoil: { low: 80, mid: 95, high: 110, market: 90 },
  },
  cm: {
    lowPriceExPlus: 110,
    lowPrice: 100,
    trendPrice: 115,
    avg7: 108,
    avg30: 102,
    reverseHoloLow: 95,
    reverseHoloTrend: 100,
    reverseHoloAvg7: 96,
    reverseHoloAvg30: 90,
  },
};

describe('arbitrageVariants', () => {
  it('emits one row per priced variant pair (holofoil + reverseHolofoil)', () => {
    const variants = arbitrageVariants(charizardLike, RATE, 'us_to_eu');
    expect(variants).toHaveLength(2);
    const v = variants.find((x) => x.variant === 'holofoil');
    const r = variants.find((x) => x.variant === 'reverseHolofoil');
    expect(v).toBeDefined();
    expect(r).toBeDefined();
  });

  it('us_to_eu ratio rises when EU is more expensive than converted US', () => {
    const variants = arbitrageVariants(charizardLike, RATE, 'us_to_eu');
    const holo = variants.find((x) => x.variant === 'holofoil');
    expect(holo).toBeDefined();
    if (!holo) return;
    // EU lowPriceExPlus 110 / (100 USD * 0.92) = 110 / 92 ≈ 1.196
    expect(holo.ratio).toBeCloseTo(110 / 92, 3);
  });

  it('eu_to_us flips the comparison', () => {
    const variants = arbitrageVariants(charizardLike, RATE, 'eu_to_us');
    const holo = variants.find((x) => x.variant === 'holofoil');
    expect(holo).toBeDefined();
    if (!holo) return;
    // (100 USD * 0.92) / 110 EUR = 92 / 110 ≈ 0.836
    expect(holo.ratio).toBeCloseTo(92 / 110, 3);
  });

  it('returns [] when either side is missing', () => {
    expect(
      arbitrageVariants({ ...charizardLike, tcg: null }, RATE),
    ).toHaveLength(0);
    expect(
      arbitrageVariants({ ...charizardLike, cm: null }, RATE),
    ).toHaveLength(0);
  });

  it('uses the reverse-holo-specific cm prices for reverseHolofoil pair', () => {
    const variants = arbitrageVariants(charizardLike, RATE, 'us_to_eu');
    const r = variants.find((x) => x.variant === 'reverseHolofoil');
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.eur).toBe(95); // reverseHoloLow, NOT lowPriceExPlus
    expect(r.cmAvg7).toBe(96); // reverseHoloAvg7, NOT avg7
    expect(r.cmAvg30).toBe(90);
  });

  it('skips variants with missing market price', () => {
    const partial: CardPriceEntry = {
      ...charizardLike,
      tcg: {
        normal: { low: 1, market: 2 },
        // holofoil has no market
        holofoil: { low: 5 },
      },
    };
    const v = arbitrageVariants(partial, RATE, 'us_to_eu');
    expect(v).toHaveLength(1);
    expect(v[0]?.variant).toBe('normal');
  });
});

describe('bestArbitrage', () => {
  it('picks the highest-ratio variant', () => {
    const best = bestArbitrage(charizardLike, RATE, 'us_to_eu');
    expect(best).not.toBeNull();
    // holofoil ratio (~1.196) is higher than reverseHolofoil (~1.146)
    expect(best?.variant).toBe('holofoil');
  });

  it('returns null when no variant pairs', () => {
    expect(bestArbitrage({ ...charizardLike, tcg: null }, RATE)).toBeNull();
  });
});

describe('singleVariantArbitrage', () => {
  it('returns the requested variant when available', () => {
    const v = singleVariantArbitrage(charizardLike, 'holofoil', RATE, 'us_to_eu');
    expect(v).not.toBeNull();
    expect(v?.variant).toBe('holofoil');
    expect(v?.usd).toBe(100);
  });

  it('returns null when the requested variant has no market', () => {
    const v = singleVariantArbitrage(charizardLike, 'normal', RATE, 'us_to_eu');
    expect(v).toBeNull(); // no `tcg.normal` defined in fixture
  });

  it('uses reverseHolo cm fields for reverseHolofoil', () => {
    const v = singleVariantArbitrage(charizardLike, 'reverseHolofoil', RATE);
    expect(v?.eur).toBe(95);
    expect(v?.cmAvg30).toBe(90);
  });
});
