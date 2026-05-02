// /api/offers/[token] — public read of an offer by its accept-token.
// Used by the unauthenticated email-link flow: customer clicks the link
// in their email and lands on /account/offer/:token.
// Token is unguessable (64-char hex); RLS bypassed via service role.

import { json, error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('quote_offers')
    .select('id, shop_id, customer_email, line_items, total_eur, currency, status, expires_at, created_at, accepted_at, declined_at')
    .eq('accept_token', params.token)
    .maybeSingle();
  if (dbErr) throw error(500, dbErr.message);
  if (!data) throw error(404, 'offer not found');
  return json(data);
};

export const POST: RequestHandler = async ({ params, request }) => {
  // Body: { action: 'accept' | 'decline' }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const action = (raw as { action?: string })?.action;
  if (action !== 'accept' && action !== 'decline') throw error(400, 'invalid action');

  const sb = getSupabase();
  const { data: existing } = await sb
    .from('quote_offers')
    .select('status,expires_at')
    .eq('accept_token', params.token)
    .maybeSingle();
  if (!existing) throw error(404, 'offer not found');
  if (existing.status !== 'open') throw error(409, `offer is ${existing.status}`);
  if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
    await sb.from('quote_offers').update({ status: 'expired' }).eq('accept_token', params.token);
    throw error(409, 'offer expired');
  }

  const update =
    action === 'accept'
      ? { status: 'accepted', accepted_at: new Date().toISOString() }
      : { status: 'declined', declined_at: new Date().toISOString() };
  const { error: dbErr } = await sb
    .from('quote_offers')
    .update(update)
    .eq('accept_token', params.token);
  if (dbErr) throw error(500, dbErr.message);
  return json({ ok: true, status: update.status });
};
