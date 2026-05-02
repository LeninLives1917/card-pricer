// /api/sessions — list / create scan sessions. Multi-operator backbone.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const NewSession = z.object({
  name: z.string().optional(),
  shop_id: z.string().uuid().optional().nullable(),
});

function generatePairCode(): string {
  // 6-char alphanumeric, no ambiguous chars (no 0/O, 1/I).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('live_sessions')
    .select('*')
    .eq('owner_user_id', locals.user.id)
    .is('closed_at', null)
    .order('created_at', { ascending: false })
    .limit(20);
  if (dbErr) throw error(500, dbErr.message);
  return json({ sessions: data ?? [] });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'auth required');
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = NewSession.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));

  const sb = getSupabase();
  // Try a few times in case the random pair code collides.
  for (let i = 0; i < 5; i++) {
    const pairCode = generatePairCode();
    const { data, error: dbErr } = await sb
      .from('live_sessions')
      .insert({
        owner_user_id: locals.user.id,
        name: parsed.data.name ?? `Session ${new Date().toLocaleDateString()}`,
        shop_id: parsed.data.shop_id ?? null,
        pair_code: pairCode,
      })
      .select()
      .maybeSingle();
    if (!dbErr) return json(data);
    if (dbErr.code !== '23505') throw error(500, dbErr.message); // not a unique violation
  }
  throw error(500, 'could not allocate pair code after 5 attempts');
};
