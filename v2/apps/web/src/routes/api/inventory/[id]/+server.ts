// /api/inventory/[id] — read/update/delete a single inventory item.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const UpdateItem = z.object({
  state: z.enum(['in_stock', 'listed', 'sold', 'consigned', 'returned']).optional(),
  cost_eur: z.number().optional(),
  condition_at_buy: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  card_meta: z.record(z.string(), z.unknown()).optional(),
});

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('inventory_items')
    .select('*')
    .eq('id', params.id)
    .eq('owner_user_id', locals.user.id)
    .maybeSingle();
  if (dbErr) throw error(500, dbErr.message);
  if (!data) throw error(404, 'not found');
  const { data: events } = await sb
    .from('inventory_events')
    .select('*')
    .eq('item_id', params.id)
    .order('created_at', { ascending: false });
  return json({ item: data, events: events ?? [] });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) throw error(401, 'auth required');
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = UpdateItem.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));

  const sb = getSupabase();
  const { data: prev } = await sb
    .from('inventory_items')
    .select('state')
    .eq('id', params.id)
    .eq('owner_user_id', locals.user.id)
    .maybeSingle();
  if (!prev) throw error(404, 'not found');

  const { data, error: dbErr } = await sb
    .from('inventory_items')
    .update(parsed.data)
    .eq('id', params.id)
    .eq('owner_user_id', locals.user.id)
    .select()
    .maybeSingle();
  if (dbErr) throw error(500, dbErr.message);

  // Log state-change events.
  if (parsed.data.state && parsed.data.state !== prev.state) {
    await sb.from('inventory_events').insert({
      item_id: params.id,
      event_type:
        parsed.data.state === 'sold'
          ? 'sold'
          : parsed.data.state === 'listed'
            ? 'listed'
            : parsed.data.state === 'returned'
              ? 'returned'
              : parsed.data.state === 'consigned'
                ? 'consigned'
                : 'note',
      data: { from: prev.state, to: parsed.data.state },
      actor_user_id: locals.user.id,
    });
  }

  return json(data);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { error: dbErr } = await sb
    .from('inventory_items')
    .delete()
    .eq('id', params.id)
    .eq('owner_user_id', locals.user.id);
  if (dbErr) throw error(500, dbErr.message);
  return json({ ok: true });
};
