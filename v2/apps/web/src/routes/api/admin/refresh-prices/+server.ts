// POST /api/admin/refresh-prices — kick off the bulk pokemontcg.io download
// and upsert card_prices in Postgres. Returns immediately; the work runs
// in the background. Status visible via GET /api/admin/refresh-status.
//
// Throttle: 25 req/min unauthenticated, no throttle with POKEMON_TCG_API_KEY.

import { json, error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import { env } from '$lib/server/env.js';
import { refreshState as state } from '$lib/server/refresh-state.js';
import { POKEMONTCG_UNRELIABLE } from '@card-pricer/shared';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data: profile } = await sb
    .from('profiles')
    .select('is_admin')
    .eq('user_id', locals.user.id)
    .maybeSingle();
  if (!profile?.is_admin) throw error(403, 'admin only');

  if (state.loading) return json({ ok: false, alreadyLoading: true });

  state.loading = true;
  state.cardsPriced = 0;
  state.cardsTotal = 0;
  state.startedAt = Date.now();
  state.completedAt = null;
  state.pagesFailed = [];
  state.error = null;

  void runRefresh().catch((e: unknown) => {
    state.error = e instanceof Error ? e.message : String(e);
    state.loading = false;
    console.error('[REFRESH-PRICES]', state.error);
  });

  return json({ ok: true, started: true });
};

async function runRefresh() {
  const apiKey = env.POKEMON_TCG_API_KEY;
  const PAGE_SIZE = 250;
  const BATCH = apiKey ? 5 : 3;
  const WAVE_DELAY_MS = apiKey ? 0 : 7500;
  const SELECT = 'id,name,number,rarity,set,hp,supertype,subtypes,cardmarket,tcgplayer,images';

  const headers: Record<string, string> = apiKey ? { 'X-Api-Key': apiKey } : {};

  const firstResp = await fetch(
    `https://api.pokemontcg.io/v2/cards?pageSize=${PAGE_SIZE}&page=1&select=${SELECT}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!firstResp.ok) throw new Error(`first page HTTP ${firstResp.status}`);
  const firstData = (await firstResp.json()) as { totalCount?: number; data?: PokeCard[] };
  state.cardsTotal = firstData.totalCount ?? 0;
  const totalPages = Math.ceil(state.cardsTotal / PAGE_SIZE);
  await processPage(firstData.data ?? []);

  for (let start = 2; start <= totalPages; start += BATCH) {
    const pages: Promise<void>[] = [];
    for (let p = start; p < start + BATCH && p <= totalPages; p++) {
      pages.push(
        fetch(
          `https://api.pokemontcg.io/v2/cards?pageSize=${PAGE_SIZE}&page=${p}&select=${SELECT}`,
          { headers, signal: AbortSignal.timeout(30_000) },
        )
          .then(async (r) => {
            if (!r.ok) {
              state.pagesFailed.push(p);
              return;
            }
            const d = (await r.json()) as { data?: PokeCard[] };
            await processPage(d.data ?? []);
          })
          .catch(() => {
            state.pagesFailed.push(p);
          }),
      );
    }
    await Promise.all(pages);
    if (WAVE_DELAY_MS > 0 && start + BATCH <= totalPages) {
      await new Promise((res) => setTimeout(res, WAVE_DELAY_MS));
    }
  }

  state.completedAt = Date.now();
  state.loading = false;
}

interface PokeCard {
  id: string;
  name: string;
  number: string;
  rarity?: string;
  hp?: string;
  supertype?: string;
  subtypes?: string[];
  set?: { id?: string; name?: string; ptcgoCode?: string };
  images?: { small?: string; large?: string };
  cardmarket?: { url?: string; prices?: Record<string, number> };
  tcgplayer?: { url?: string; prices?: Record<string, Record<string, number>> };
}

async function processPage(cards: PokeCard[]) {
  if (!cards.length) return;
  const sb = getSupabase();
  const rows: Array<Record<string, unknown>> = [];
  for (const c of cards) {
    const setId = c.set?.id ?? '';
    const num = c.number ?? '';
    if (!setId || !num) continue;
    if (POKEMONTCG_UNRELIABLE.has(setId)) continue;
    if (!c.tcgplayer?.prices && !c.cardmarket?.prices) continue;
    const cleanNum = num.replace(/^0+/, '') || num;
    rows.push({
      set_id: setId,
      number: cleanNum,
      name: c.name,
      set_name: c.set?.name ?? null,
      set_code: (c.set?.ptcgoCode ?? setId).toUpperCase(),
      rarity: c.rarity ?? null,
      image: c.images?.small ?? c.images?.large ?? null,
      cardmarket_url: c.cardmarket?.url ?? null,
      tcgplayer_url: c.tcgplayer?.url ?? null,
      tcg: c.tcgplayer?.prices ?? null,
      cm: c.cardmarket?.prices ?? null,
      fetched_at: new Date().toISOString(),
    });
  }
  if (!rows.length) return;
  const { error: upErr } = await sb
    .from('card_prices')
    .upsert(rows, { onConflict: 'set_id,number' });
  if (upErr) {
    console.warn('[REFRESH] upsert failed:', upErr.message);
    return;
  }
  state.cardsPriced += rows.length;
}
