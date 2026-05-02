// Server load for the offer-acceptance page. Token-based — no auth required.

import { error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('quote_offers')
    .select('id, customer_email, line_items, total_eur, currency, status, expires_at, created_at')
    .eq('accept_token', params.token)
    .maybeSingle();
  if (dbErr) throw error(500, dbErr.message);
  if (!data) throw error(404, 'offer not found');
  return { offer: data, token: params.token };
};
