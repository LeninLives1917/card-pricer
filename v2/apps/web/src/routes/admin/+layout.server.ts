// Admin gate — verifies the signed-in user has profiles.is_admin = true.
// Anything under /admin/* runs through this load function first.

import { error } from '@sveltejs/kit';
import { getSupabase } from '$lib/server/supabase.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) throw error(401, 'sign in required');
  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('profiles')
    .select('is_admin')
    .eq('user_id', locals.user.id)
    .maybeSingle();
  if (dbErr || !data?.is_admin) throw error(403, 'admin only');
  return { user: locals.user };
};
