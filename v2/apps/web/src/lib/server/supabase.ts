// Server-side Supabase client using the service-role key. Bypasses RLS,
// must never be exposed to the browser. Used by API endpoints that need
// to read/write across tenants (e.g. /api/shop-config, /api/quote-lead).
//
// We cast to `SupabaseClient` (untyped). Supabase's strict generics expect
// generated DB types; until we run `supabase gen types typescript` and check
// that into the repo, the untyped client is the pragmatic choice. Drizzle
// is the typed source of truth for queries it powers.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

/**
 * Verify a Supabase JWT and return the user record. Used by middleware on
 * authenticated routes (/api/identify*, /api/price, /api/shop CRUD).
 */
export async function verifyJwt(token: string) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
