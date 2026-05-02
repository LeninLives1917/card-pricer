// POST /api/admin/arbitrage — scan card_prices in Postgres for US/EU
// price spreads. Returns rows sorted by ratio or absolute spread.
//
// Direction-aware: us_to_eu (buy US, sell EU) or eu_to_us (buy EU, sell US).
// Variant pairing locked: tcg.normal/holofoil/1stEd ↔ cm.lowPriceExPlus,
// tcg.reverseHolofoil ↔ cm.reverseHoloLow. Never crossed.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { arbitrageVariants, type CardPriceEntry } from '@card-pricer/shared';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const Body = z.object({
  minSrcPrice: z.number().min(0).default(5),
  threshold: z.number().min(1).default(1.3),
  variant: z.enum(['auto', 'normal', 'holofoil', 'reverseHolofoil']).default('auto'),
  liquidity: z.enum(['any', 'active', 'strong']).default('any'),
  tcgTightness: z.number().min(0).max(1).default(0.6),
  direction: z.enum(['us_to_eu', 'eu_to_us']).default('us_to_eu'),
  sortBy: z.enum(['ratio', 'spread']).default('ratio'),
  limit: z.number().min(1).max(500).default(100),
  sets: z.array(z.string()).optional().nullable(),
});

// Live USD→EUR rate. Cached in-memory for an hour. Production should pull
// fresh on cold-start; this is plenty for the admin tool.
let _rate = 0.92;
let _rateFetchedAt = 0;
async function getUsdToEur(): Promise<number> {
  if (_rate && Date.now() - _rateFetchedAt < 60 * 60 * 1000) return _rate;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR');
    if (r.ok) {
      const data = (await r.json()) as { rates?: { EUR?: number } };
      if (data.rates?.EUR) {
        _rate = data.rates.EUR;
        _rateFetchedAt = Date.now();
      }
    }
  } catch {
    /* keep cached */
  }
  return _rate;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'auth required');

  const sb = getSupabase();
  const { data: profile } = await sb
    .from('profiles')
    .select('is_admin')
    .eq('user_id', locals.user.id)
    .maybeSingle();
  if (!profile?.is_admin) throw error(403, 'admin only');

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
  const { minSrcPrice, threshold, variant, liquidity, tcgTightness, direction, sortBy, limit, sets } =
    parsed.data;

  const rate = await getUsdToEur();

  // Pull rows from Postgres. Set filter applied in SQL; row-level filtering
  // (variant + threshold) happens in JS so we can reuse arbitrageVariants.
  let q = sb.from('card_prices').select('*');
  if (sets && sets.length) q = q.in('set_id', sets.map((s) => s.toLowerCase()));
  const { data, error: dbErr } = await q.limit(80_000);
  if (dbErr) {
    console.error('[ARBITRAGE]', dbErr.message);
    throw error(500, 'lookup failed');
  }

  const rows = (data ?? []) as Array<{
    set_id: string;
    number: string;
    name: string;
    set_name: string | null;
    set_code: string | null;
    rarity: string | null;
    image: string | null;
    cardmarket_url: string | null;
    tcgplayer_url: string | null;
    tcg: unknown;
    cm: unknown;
    fetched_at: string | null;
  }>;

  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const entry: CardPriceEntry = {
      name: row.name,
      setId: row.set_id,
      setName: row.set_name ?? '',
      setCode: row.set_code ?? '',
      number: row.number,
      rarity: row.rarity ?? '',
      image: row.image,
      cardmarketUrl: row.cardmarket_url,
      tcgplayerUrl: row.tcgplayer_url,
      tcg: (row.tcg as CardPriceEntry['tcg']) ?? null,
      cm: (row.cm as CardPriceEntry['cm']) ?? null,
      fetchedAt: row.fetched_at ? Date.parse(row.fetched_at) : undefined,
    };

    const arbs =
      variant === 'auto'
        ? arbitrageVariants(entry, rate, direction)
        : arbitrageVariants(entry, rate, direction).filter((v) => v.variant === variant);

    for (const arb of arbs) {
      const srcPrice = direction === 'eu_to_us' ? arb.eur : arb.usd;
      if (srcPrice < minSrcPrice) continue;
      if (arb.ratio < threshold) continue;

      // Liquidity filter
      if (liquidity === 'active' && !(arb.cmAvg7 > 0)) continue;
      if (liquidity === 'strong') {
        const tcgRatio = arb.tcgLow > 0 && arb.usd > 0 ? arb.tcgLow / arb.usd : 0;
        if (!(arb.cmAvg7 > 0 && tcgRatio >= tcgTightness)) continue;
      }

      const spread =
        direction === 'eu_to_us'
          ? +(arb.usd - arb.eur / rate).toFixed(2)
          : +(arb.eur - arb.usdInEur).toFixed(2);

      const tcgLowMarketRatio = arb.tcgLow > 0 && arb.usd > 0
        ? +(arb.tcgLow / arb.usd).toFixed(3)
        : 0;

      out.push({
        key: `${entry.setId}-${entry.number}-${arb.variant}`,
        name: entry.name,
        setName: entry.setName,
        setCode: entry.setCode,
        setId: entry.setId,
        number: entry.number,
        rarity: entry.rarity,
        image: entry.image,
        variant: arb.variant,
        usd: +arb.usd.toFixed(2),
        usdInEur: +arb.usdInEur.toFixed(2),
        eur: +arb.eur.toFixed(2),
        ratio: +arb.ratio.toFixed(3),
        spread,
        spreadCurrency: direction === 'eu_to_us' ? 'USD' : 'EUR',
        direction,
        cmAvg7: arb.cmAvg7,
        cmAvg30: arb.cmAvg30,
        tcgLowMarketRatio,
        tcgplayerUrl: entry.tcgplayerUrl,
        cardmarketUrl: entry.cardmarketUrl,
        fetchedAt: entry.fetchedAt,
      });
    }
  }

  out.sort((a, b) => {
    if (sortBy === 'spread') return (b.spread as number) - (a.spread as number);
    return (b.ratio as number) - (a.ratio as number);
  });

  return json({
    rate,
    direction,
    cardsPriced: rows.length,
    matched: out.length,
    results: out.slice(0, limit),
  });
};
