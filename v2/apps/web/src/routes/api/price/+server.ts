// POST /api/price — return market value + variant prices for a card.
// Skeleton: pulls cardmarket/tcgplayer prices from pokemontcg.io for Pokemon
// and from scryfall for Magic. Full live-Cardmarket-scrape + eBay + JustTCG
// fallback chain from v1 ports in week 4 when we move CARD_PRICES to Postgres.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const CardSchema = z
  .object({
    game: z.string().optional().default('pokemon'),
    name: z.string().optional(),
    set_code: z.string().optional().nullable(),
    set_name: z.string().optional().nullable(),
    card_number: z.string().optional().nullable(),
    condition_estimate: z.string().optional().default('NM'),
  })
  .passthrough();

const Body = z.object({
  card: CardSchema,
  buyPercentage: z.number().optional().default(55),
});

interface PriceOut {
  card: z.infer<typeof CardSchema>;
  market_value: number;
  cardmarket?: { price: number; trend?: number; low?: number; url?: string | null };
  tcgplayer?: { price: number; low?: number; currency: string; url?: string | null };
}

export const POST: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
  const { card } = parsed.data;

  if (card.game === 'magic') return json(await priceMagic(card));
  return json(await pricePokemon(card));
};

async function pricePokemon(card: z.infer<typeof CardSchema>): Promise<PriceOut> {
  const setId = card.set_code?.toLowerCase();
  const num = (card.card_number ?? '').replace(/\/.*/, '').replace(/^0+/, '');
  if (!setId || !num) {
    return { card, market_value: 0 };
  }
  try {
    const q = `set.id:${setId} number:${num}`;
    const res = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=5`,
      {
        headers: process.env.POKEMON_TCG_API_KEY
          ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY }
          : {},
      },
    );
    if (!res.ok) return { card, market_value: 0 };
    const data = (await res.json()) as { data?: Array<{ cardmarket?: { url?: string; prices?: Record<string, number> }; tcgplayer?: { url?: string; prices?: Record<string, { low?: number; market?: number }> } }> };
    const d = data.data?.[0];
    if (!d) return { card, market_value: 0 };

    const cm = d.cardmarket?.prices ?? {};
    const cmPrice =
      (cm.lowPriceExPlus as number) ?? (cm.lowPrice as number) ?? (cm.trendPrice as number) ?? 0;

    const tcg = d.tcgplayer?.prices ?? {};
    const tcgVariant = tcg.holofoil ?? tcg.normal ?? tcg.reverseHolofoil;
    const tcgMarket = tcgVariant?.market ?? 0;

    return {
      card,
      market_value: cmPrice,
      cardmarket: {
        price: cmPrice,
        trend: cm.trendPrice as number | undefined,
        low: (cm.lowPrice as number) ?? undefined,
        url: d.cardmarket?.url ?? null,
      },
      tcgplayer: {
        price: tcgMarket,
        low: tcgVariant?.low,
        currency: 'USD',
        url: d.tcgplayer?.url ?? null,
      },
    };
  } catch {
    return { card, market_value: 0 };
  }
}

async function priceMagic(card: z.infer<typeof CardSchema>): Promise<PriceOut> {
  const setCode = card.set_code?.toLowerCase();
  const num = (card.card_number ?? '').replace(/\/.*/, '');
  if (!setCode || !num) return { card, market_value: 0 };
  try {
    const r = await fetch(`https://api.scryfall.com/cards/${setCode}/${num}`);
    if (!r.ok) return { card, market_value: 0 };
    const d = (await r.json()) as {
      prices?: { eur?: string; usd?: string };
      purchase_uris?: { cardmarket?: string; tcgplayer?: string };
    };
    const eur = d.prices?.eur ? Number.parseFloat(d.prices.eur) : 0;
    const usd = d.prices?.usd ? Number.parseFloat(d.prices.usd) : 0;
    return {
      card,
      market_value: eur,
      cardmarket: { price: eur, url: d.purchase_uris?.cardmarket ?? null },
      tcgplayer: { price: usd, currency: 'USD', url: d.purchase_uris?.tcgplayer ?? null },
    };
  } catch {
    return { card, market_value: 0 };
  }
}
