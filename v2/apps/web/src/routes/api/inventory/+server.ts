// /api/inventory — list/create inventory items. Each item represents a
// bought card with its cost basis + state. Updates handled by /api/inventory/:id.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const NewItem = z.object({
  card_meta: z.record(z.string(), z.unknown()),
  cost_eur: z.number().min(0),
  condition_at_buy: z.string().optional(),
  market_value_at_buy: z.number().optional(),
  shop_id: z.string().uuid().optional().nullable(),
  source: z.enum(['scan', 'manual', 'import']).default('scan'),
});

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const state = url.searchParams.get('state');
  let q = sb
    .from('inventory_items')
    .select('*')
    .eq('owner_user_id', locals.user.id)
    .order('created_at', { ascending: false })
    .limit(500);
  if (state) q = q.eq('state', state);
  const { data, error: dbErr } = await q;
  if (dbErr) throw error(500, dbErr.message);
  return json({ items: data ?? [] });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'auth required');
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = NewItem.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));

  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('inventory_items')
    .insert({
      owner_user_id: locals.user.id,
      ...parsed.data,
    })
    .select()
    .maybeSingle();
  if (dbErr) throw error(500, dbErr.message);

  // Log the 'bought' event.
  if (data?.id) {
    await sb.from('inventory_events').insert({
      item_id: data.id,
      event_type: 'bought',
      data: { cost_eur: parsed.data.cost_eur, condition: parsed.data.condition_at_buy ?? null },
      actor_user_id: locals.user.id,
    });
  }

  return json(data);
};
