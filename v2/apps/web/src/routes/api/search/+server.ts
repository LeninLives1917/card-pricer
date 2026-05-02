// GET /api/search — basic name search across pokemontcg.io / scryfall.
// Skeleton port of v1's /api/search. Used by the manual-correct flow in
// week 3 (vendor app). Public, rate-limited.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const rate = new Map<string, number[]>();
function rateLimit(ip: string, max = 60, windowMs = 60_000) {
  const now = Date.now();
  const arr = (rate.get(ip) ?? []).filter((t) => t > now - windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  rate.set(ip, arr);
  return true;
}

export const GET: RequestHandler = async ({ url, getClientAddress }) => {
  if (!rateLimit(getClientAddress())) return json({ results: [] }, { status: 429 });
  const q = (url.searchParams.get('q') ?? '').trim();
  const game = (url.searchParams.get('game') ?? 'pokemon').toLowerCase();
  if (!q) return json({ results: [] });

  if (game === 'magic') {
    try {
      const r = await fetch(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=relevance`,
      );
      if (!r.ok) return json({ results: [] });
      const d = (await r.json()) as { data?: Array<{ name: string; set: string; collector_number: string; image_uris?: { small?: string } }> };
      return json({
        results: (d.data ?? []).slice(0, 20).map((c) => ({
          name: c.name,
          game: 'magic',
          set_code: c.set?.toUpperCase(),
          card_number: c.collector_number,
          image: c.image_uris?.small ?? null,
        })),
      });
    } catch {
      return json({ results: [] });
    }
  }

  // Default: pokemon search via pokemontcg.io.
  try {
    const r = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=name:%22${encodeURIComponent(q)}%22&pageSize=20`,
      {
        headers: process.env.POKEMON_TCG_API_KEY
          ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY }
          : {},
      },
    );
    if (!r.ok) return json({ results: [] });
    const d = (await r.json()) as { data?: Array<{ name: string; number: string; set?: { name?: string; ptcgoCode?: string }; images?: { small?: string } }> };
    return json({
      results: (d.data ?? []).map((c) => ({
        name: c.name,
        game: 'pokemon',
        set_code: c.set?.ptcgoCode ?? null,
        set_name: c.set?.name ?? null,
        card_number: c.number,
        image: c.images?.small ?? null,
      })),
    });
  } catch {
    return json({ results: [] });
  }
};
