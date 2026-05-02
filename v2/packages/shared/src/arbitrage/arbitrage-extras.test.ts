// Extra arbitrage tests covering the variant pairing rules + direction flip.
// Complements arbitrage.test.ts.

import { describe, expect, it } from 'vitest';
import { arbitrageVariants } from './index.js';
import type { CardPriceEntry } from './types.js';

const RATE = 0.92;

describe('arbitrageVariants — variant pairing isolation', () => {
  it('does NOT cross reverseHolofoil with non-reverse cm prices', () => {
    const entry: CardPriceEntry = {
      name: 'Test',
      setId: 'sv1',
      setName: 'Test Set',
      setCode: 'TST',
      number: '1',
      rarity: 'Common',
      tcg: { reverseHolofoil: { market: 10, low: 9 } },
      cm: {
        // Only non-reverse fields populated. Reverse prices missing.
        lowPriceExPlus: 100,
        lowPrice: 95,
        trendPrice: 98,
      },
    };
    // Should yield 0 pairs — reverseHolofoil's cm side is missing.
    const variants = arbitrageVariants(entry, RATE, 'us_to_eu');
    expect(variants).toHaveLength(0);
  });

  it('non-reverse variants share the same EU price (lowPriceExPlus)', () => {
    const entry: CardPriceEntry = {
      name: 'Test',
      setId: 'sv1',
      setName: 'Test Set',
      setCode: 'TST',
      number: '1',
      rarity: 'Common',
      tcg: {
        normal: { market: 5 },
        '1stEditionNormal': { market: 8 },
      },
      cm: { lowPriceExPlus: 12 },
    };
    const variants = arbitrageVariants(entry, RATE, 'us_to_eu');
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v.eur === 12)).toBe(true);
  });
});

describe('arbitrageVariants — direction reciprocity', () => {
  const entry: CardPriceEntry = {
    name: 'Test',
    setId: 'sv1',
    setName: 'Test Set',
    setCode: 'TST',
    number: '1',
    rarity: 'Common',
    tcg: { holofoil: { market: 100 } },
    cm: { lowPriceExPlus: 110 },
  };

  it('flipping direction inverts the ratio', () => {
    const usEu = arbitrageVariants(entry, RATE, 'us_to_eu')[0];
    const euUs = arbitrageVariants(entry, RATE, 'eu_to_us')[0];
    expect(usEu).toBeDefined();
    expect(euUs).toBeDefined();
    if (!usEu || !euUs) return;
    // ratio_us_to_eu * ratio_eu_to_us = 1 (within float tolerance)
    expect(usEu.ratio * euUs.ratio).toBeCloseTo(1, 5);
  });
});
