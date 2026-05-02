// Universal layout load — runs on server AND in browser. On the browser it
// configures the Supabase JS SDK with the PUBLIC_* keys and fans the current
// session's user into `data.user`. Server load already populates user from
// the Bearer header for authed API calls; this fills in the browser-only path.

import { browser } from '$app/environment';
import { env as publicEnv } from '$env/dynamic/public';
import { configureSupabase, getSupabaseClient } from '$lib/client/auth.js';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data }) => {
  if (!browser) return data;
  const url = publicEnv.PUBLIC_SUPABASE_URL;
  const anonKey = publicEnv.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return data;
  configureSupabase(url, anonKey);
  const sb = getSupabaseClient();
  if (!sb) return data;
  const { data: sessionData } = await sb.auth.getSession();
  const sessionUser = sessionData?.session?.user;
  if (sessionUser) {
    return { ...data, user: { id: sessionUser.id, email: sessionUser.email ?? null } };
  }
  return data;
};
