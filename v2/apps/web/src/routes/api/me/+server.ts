// GET /api/me — returns the authenticated user's email + plan + admin flag.
// Used by the client to decide which tabs to show.

import { json, error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data } = await sb
    .from('profiles')
    .select('plan,is_admin,plan_interval,has_subscription')
    .eq('user_id', locals.user.id)
    .maybeSingle();
  return json({
    id: locals.user.id,
    email: locals.user.email,
    plan: (data?.plan as string | undefined) ?? 'free',
    is_admin: !!data?.is_admin,
    plan_interval: data?.plan_interval ?? null,
    has_subscription: !!data?.has_subscription,
  });
};
