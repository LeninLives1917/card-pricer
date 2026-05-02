// Admin gate runs in the BROWSER. Server-side load can't see the user
// (Supabase session lives in localStorage, not cookies, in this minimum-auth
// setup), so the gate fetches /api/me with the Bearer header.
//
// Defence-in-depth: every /api/admin/* endpoint also checks is_admin via the
// Bearer JWT — this gate is just for hiding the UI from non-admins.

import { browser } from '$app/environment';
import { error } from '@sveltejs/kit';
import { supabaseAuthHeader } from '$lib/client/auth.js';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async () => {
  if (!browser) return { is_admin: false };
  const auth = await supabaseAuthHeader();
  if (!auth.Authorization) {
    throw error(401, 'sign in to access admin');
  }
  const r = await fetch('/api/me', { headers: auth });
  if (!r.ok) {
    throw error(r.status, 'auth check failed');
  }
  const me = (await r.json()) as { is_admin?: boolean; email?: string };
  if (!me.is_admin) {
    throw error(403, 'admin only');
  }
  return { is_admin: true, admin_email: me.email ?? null };
};
