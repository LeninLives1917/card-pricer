// GET /api/usage — current month scan count + plan limit.
// Plan limits come from a static map (mirrors v1's PLAN_LIMITS).

import { json, error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const PLAN_LIMITS: Record<string, number | null> = {
  beta: null,
  free: 40,
  solo: 100,
  vendor: 500,
  shop: null,
};

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data: profile } = await sb
    .from('profiles')
    .select('plan')
    .eq('user_id', locals.user.id)
    .maybeSingle();
  const plan = (profile?.plan as string | undefined) ?? 'free';
  const limit = PLAN_LIMITS[plan] ?? null;
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const { count } = await sb
    .from('scan_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', locals.user.id)
    .gte('ts', monthStart.toISOString());
  const resetAt = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
  return json({ plan, used: count ?? 0, limit, resetAt: resetAt.toISOString() });
};
