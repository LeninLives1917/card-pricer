// POST /api/identify-manual — set-code + number lookup against pokemontcg.io,
// scryfall (Magic), or a generic shell when neither covers the game.
// Skeleton port of v1's /api/identify-manual. The TCGdex/JustTCG/TCGGO
// fallback chain ports in week 3 alongside the full identify pipeline.
//
// Auth note: v1 left this unauthenticated (the public quote tool needs it).
// We keep that posture but rate-limit per IP to 30 lookups/min.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const Body = z.object({
  game: z.enum(['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'starwars', 'digimon', 'fleshandblood', 'dragonball']),
  set_code: z.string().optional().nullable(),
  card_number: z.string().min(1),
  name: z.string().optional().nullable(),
});

const rate = new Map<string, number[]>();
function rateLimit(ip: string, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const arr = (rate.get(ip) ?? []).filter((t) => t > now - windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  rate.set(ip, arr);
  return true;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  if (!rateLimit(getClientAddress())) throw error(429, 'rate limited');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
  const { game, set_code, card_number, name } = parsed.data;

  const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);

  if (game === 'pokemon') return json(await identifyPokemon(set_code ?? null, cleanNum, name ?? null));
  if (game === 'magic') return json(await identifyMagic(set_code ?? null, cleanNum, name ?? null));
  return json(genericShell(game, set_code ?? null, cleanNum, name ?? null));
};

interface IdentifiedCard {
  game: string;
  name: string;
  set_name: string | null;
  set_code: string | null;
  card_number: string;
  rarity?: string;
  hp?: string;
  reference_image?: string | null;
  cardmarket_url?: string | null;
  tcgplayer_url?: string | null;
  verified: boolean;
  db_source: string;
}

async function identifyPokemon(
  setCode: string | null,
  cleanNum: string,
  name: string | null,
): Promise<{ cards: IdentifiedCard[] }> {
  // pokemontcg.io direct lookup if set+number both present.
  const queries: string[] = [];
  if (setCode) {
    queries.push(`set.id:${setCode.toLowerCase()} number:${cleanNum}`);
    queries.push(`set.ptcgoCode:${setCode.toUpperCase()} number:${cleanNum}`);
  }
  if (name) queries.push(`name:"${name}" number:${cleanNum}`);
  queries.push(`number:${cleanNum}`);

  for (const q of queries) {
    try {
      const res = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=10`,
        { headers: process.env.POKEMON_TCG_API_KEY ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY } : {} },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { data?: Array<{ name: string; number: string; rarity?: string; hp?: string; set?: { id?: string; name?: string; ptcgoCode?: string }; images?: { large?: string; small?: string }; cardmarket?: { url?: string }; tcgplayer?: { url?: string } }> };
      const results = data.data ?? [];
      if (!results.length) continue;
      let best = results[0];
      if (name) {
        const exact = results.find((d) => d.name?.toLowerCase() === name.toLowerCase());
        if (exact) best = exact;
      }
      if (!best) continue;
      return {
        cards: [
          {
            game: 'pokemon',
            name: best.name,
            set_name: best.set?.name ?? null,
            set_code: (best.set?.ptcgoCode ?? best.set?.id ?? '').toUpperCase() || null,
            card_number: best.number,
            rarity: best.rarity,
            hp: best.hp,
            reference_image: best.images?.large ?? best.images?.small ?? null,
            cardmarket_url: best.cardmarket?.url ?? null,
            tcgplayer_url: best.tcgplayer?.url ?? null,
            verified: true,
            db_source: 'pokemontcg.io (manual)',
          },
        ],
      };
    } catch {
      /* try next query */
    }
  }
  // Last resort — generic shell so /api/price still gets a chance.
  return { cards: [genericShell('pokemon', setCode, cleanNum, name)] };
}

async function identifyMagic(
  setCode: string | null,
  cleanNum: string,
  name: string | null,
): Promise<{ cards: IdentifiedCard[] }> {
  if (setCode) {
    try {
      const url = `https://api.scryfall.com/cards/${setCode.toLowerCase()}/${cleanNum}`;
      const res = await fetch(url);
      if (res.ok) {
        const d = (await res.json()) as {
          name: string;
          set_name: string;
          set: string;
          collector_number: string;
          rarity: string;
          image_uris?: { normal?: string };
          card_faces?: Array<{ image_uris?: { normal?: string } }>;
          purchase_uris?: { cardmarket?: string; tcgplayer?: string };
        };
        return {
          cards: [
            {
              game: 'magic',
              name: d.name,
              set_name: d.set_name,
              set_code: d.set?.toUpperCase() ?? null,
              card_number: d.collector_number,
              rarity: d.rarity,
              reference_image:
                d.image_uris?.normal ?? d.card_faces?.[0]?.image_uris?.normal ?? null,
              cardmarket_url: d.purchase_uris?.cardmarket ?? null,
              tcgplayer_url: d.purchase_uris?.tcgplayer ?? null,
              verified: true,
              db_source: 'scryfall.com (manual)',
            },
          ],
        };
      }
    } catch {
      /* fall through */
    }
  }
  if (name) {
    try {
      const r = await fetch(
        `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}${setCode ? `&set=${setCode.toLowerCase()}` : ''}`,
      );
      if (r.ok) {
        const d = (await r.json()) as {
          name: string;
          set_name: string;
          set: string;
          collector_number: string;
          rarity: string;
          image_uris?: { normal?: string };
          card_faces?: Array<{ image_uris?: { normal?: string } }>;
          purchase_uris?: { cardmarket?: string; tcgplayer?: string };
        };
        return {
          cards: [
            {
              game: 'magic',
              name: d.name,
              set_name: d.set_name,
              set_code: d.set?.toUpperCase() ?? null,
              card_number: d.collector_number,
              rarity: d.rarity,
              reference_image:
                d.image_uris?.normal ?? d.card_faces?.[0]?.image_uris?.normal ?? null,
              cardmarket_url: d.purchase_uris?.cardmarket ?? null,
              tcgplayer_url: d.purchase_uris?.tcgplayer ?? null,
              verified: true,
              db_source: 'scryfall.com (manual, name fallback)',
            },
          ],
        };
      }
    } catch {
      /* noop */
    }
  }
  return { cards: [genericShell('magic', setCode, cleanNum, name)] };
}

function genericShell(
  game: string,
  setCode: string | null,
  cleanNum: string,
  name: string | null,
): IdentifiedCard {
  return {
    game,
    name: name ?? `${setCode ?? ''} #${cleanNum}`.trim(),
    set_name: setCode ?? null,
    set_code: setCode ? setCode.toUpperCase() : null,
    card_number: cleanNum,
    verified: false,
    db_source: `manual entry (no DB lookup for ${game})`,
  };
}
