// Client-side helpers for sending the Supabase JWT with /api/* requests.
// Mirrors v1's fetch wrapper (auto-injects Authorization header).
//
// Browser-only. Don't import from server code.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;
let _config: { url: string; anonKey: string } | null = null;

/** Initialise once at app boot from PUBLIC_* env. */
export function configureSupabase(url: string, anonKey: string) {
  _config = { url, anonKey };
}

function getClient(): SupabaseClient | null {
  if (_client) return _client;
  if (!_config) return null;
  _client = createClient(_config.url, _config.anonKey);
  return _client;
}

/** Public accessor — pages call this to perform sign-in / sign-out / etc. */
export function getSupabaseClient(): SupabaseClient | null {
  return getClient();
}

/** Returns a header object containing the current Supabase JWT, or empty if not signed in. */
export async function supabaseAuthHeader(): Promise<Record<string, string>> {
  const sb = getClient();
  if (!sb) return {};
  try {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    /* no session */
  }
  return {};
}
