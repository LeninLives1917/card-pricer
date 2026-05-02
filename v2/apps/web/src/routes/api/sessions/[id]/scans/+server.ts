// /api/sessions/:id/scans — append a scan to a session. Idempotency key
// prevents double-add when two operators scan the same card.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const NewScan = z.object({
  card_meta: z.record(z.string(), z.unknown()),
  pricing_snapshot: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().min(8),
});

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  // Membership check via session ownership.
  const { data: session } = await sb
    .from('live_sessions')
    .select('id')
    .eq('id', params.id)
    .eq('owner_user_id', locals.user.id)
    .maybeSingle();
  if (!session) throw error(404, 'session not found');
  const { data } = await sb
    .from('live_session_scans')
    .select('*')
    .eq('session_id', params.id)
    .order('created_at', { ascending: false })
    .limit(500);
  return json({ scans: data ?? [] });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) throw error(401, 'auth required');
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = NewScan.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));

  const sb = getSupabase();
  const { data: session } = await sb
    .from('live_sessions')
    .select('id')
    .eq('id', params.id)
    .eq('owner_user_id', locals.user.id)
    .maybeSingle();
  if (!session) throw error(404, 'session not found');

  const { data, error: dbErr } = await sb
    .from('live_session_scans')
    .insert({
      session_id: params.id,
      scanned_by_user_id: locals.user.id,
      card_meta: parsed.data.card_meta,
      pricing_snapshot: parsed.data.pricing_snapshot ?? null,
      idempotency_key: parsed.data.idempotency_key,
    })
    .select()
    .maybeSingle();
  if (dbErr) {
    // 23505 unique violation = idempotency dedupe — return the existing row.
    if (dbErr.code === '23505') {
      const { data: existing } = await sb
        .from('live_session_scans')
        .select('*')
        .eq('session_id', params.id)
        .eq('idempotency_key', parsed.data.idempotency_key)
        .maybeSingle();
      return json({ ok: true, deduped: true, scan: existing });
    }
    throw error(500, dbErr.message);
  }
  return json({ ok: true, scan: data });
};
