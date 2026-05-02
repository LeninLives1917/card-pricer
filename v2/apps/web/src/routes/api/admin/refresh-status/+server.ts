// GET /api/admin/refresh-status — poll target while a refresh is in flight.

import { json, error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import { refreshState as state } from '$lib/server/refresh-state.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data: profile } = await sb
    .from('profiles')
    .select('is_admin')
    .eq('user_id', locals.user.id)
    .maybeSingle();
  if (!profile?.is_admin) throw error(403, 'admin only');

  const lastRefreshAt = state.completedAt ?? state.startedAt;
  return json({
    loading: state.loading,
    cardsTotal: state.cardsTotal,
    cardsPriced: state.cardsPriced,
    pagesFailed: state.pagesFailed.length,
    error: state.error,
    lastRefreshAt,
  });
};
