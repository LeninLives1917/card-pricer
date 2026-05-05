// db/customers/accounts.js
// Owner: A10 | Slice: S20 (F19)
//
// CRUD layer for public.customer_accounts (V2_AUDIT row F19,
// supabase/migrations/20260502221125_v2_carryover.sql:200-219).
//
// Why service-role?
//   The routes that call into here have already authenticated the user via
//   Supabase JWT (apps/server/middleware/auth.js → req.user). We bypass RLS
//   on the server and gate every read/write with an explicit
//   .eq('user_id', user_id) — req.user.id is the authority check.
//
// Lazy creation:
//   customer_accounts is auto-created on first GET /api/v2/customer/me, the
//   same way profiles work for vendors. The migration default for
//   opted_in_marketing is false; the row only stores customer-side prefs
//   (display_name, opted_in_marketing, preferred_shop_slug).
//
// All exported functions accept an injected supabase client so tests can
// pass a mock. Production callers omit the arg and pick up the default
// service-role client from apps/server/_clients.js.

import { supabase as defaultClient } from '../../apps/server/_clients.js';

const TABLE = 'customer_accounts';

/**
 * Fetch a customer_account row, or null if none exists yet.
 *
 * @param {string} user_id — auth.users.id
 * @param {object} [client] — supabase client; defaults to service-role
 * @returns {Promise<object|null>}
 */
export async function getCustomerAccount(user_id, client = defaultClient) {
  if (!client) return null;
  if (!user_id) return null;
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) {
    console.warn('[customers/accounts] getCustomerAccount error:', error.message || error);
    return null;
  }
  return data ?? null;
}

/**
 * Idempotently fetch-or-create the customer's account row. Used as the
 * lazy-create gate behind GET /api/v2/customer/me. Mirrors the vendor
 * profiles auto-create pattern.
 *
 * @param {string} user_id — auth.users.id
 * @param {string} [email] — caller may pass req.user.email; not stored
 *   on customer_accounts directly (the email lives on auth.users) but
 *   accepted for symmetry with profiles auto-create + future use.
 * @param {object} [client]
 * @returns {Promise<object|null>} the row (newly inserted or pre-existing)
 */
export async function getOrCreateCustomerAccount(user_id, email, client = defaultClient) {
  if (!client) return null;
  if (!user_id) throw new Error('getOrCreateCustomerAccount: user_id required');

  // Fast path: row already exists.
  const existing = await getCustomerAccount(user_id, client);
  if (existing) return existing;

  // Insert. Schema defaults handle opted_in_marketing=false, timestamps.
  const { data, error } = await client
    .from(TABLE)
    .insert({ user_id })
    .select('*')
    .maybeSingle();

  if (error) {
    // Race: another concurrent request inserted the row first. Re-read.
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
      return getCustomerAccount(user_id, client);
    }
    console.warn('[customers/accounts] getOrCreateCustomerAccount insert error:', error.message || error);
    return null;
  }
  return data ?? null;
}

const ALLOWED_UPDATE_FIELDS = new Set(['display_name', 'opted_in_marketing', 'preferred_shop_slug']);

/**
 * Update mutable fields on a customer's account. Server filters input to
 * the allow-list so a caller can't poke at user_id or timestamps.
 *
 * @param {string} user_id
 * @param {object} fields — display_name | opted_in_marketing | preferred_shop_slug
 * @param {object} [client]
 * @returns {Promise<object|null>} the updated row, or null if no row
 */
export async function updateCustomerAccount(user_id, fields, client = defaultClient) {
  if (!client) return null;
  if (!user_id) throw new Error('updateCustomerAccount: user_id required');

  const patch = {};
  for (const k of Object.keys(fields || {})) {
    if (ALLOWED_UPDATE_FIELDS.has(k)) patch[k] = fields[k];
  }
  if (!Object.keys(patch).length) {
    // Nothing to apply — return the existing row so the route can still
    // respond with 200 + current state.
    return getCustomerAccount(user_id, client);
  }
  // Touch updated_at on every successful update; the migration also has a
  // trigger on shops, but customer_accounts has no such trigger so we set
  // it explicitly to keep the value meaningful.
  patch.updated_at = new Date().toISOString();

  const { data, error } = await client
    .from(TABLE)
    .update(patch)
    .eq('user_id', user_id)
    .select('*')
    .maybeSingle();

  if (error) {
    console.warn('[customers/accounts] updateCustomerAccount error:', error.message || error);
    throw new Error(error.message || 'update failed');
  }
  return data ?? null;
}

/**
 * Delete a customer's account row. auth.users cascade handles the row
 * automatically when the user is deleted; this is for explicit
 * "delete my data" requests from a logged-in customer.
 *
 * @param {string} user_id
 * @param {object} [client]
 * @returns {Promise<boolean>} true on success
 */
export async function deleteCustomerAccount(user_id, client = defaultClient) {
  if (!client) return false;
  if (!user_id) throw new Error('deleteCustomerAccount: user_id required');
  const { error } = await client.from(TABLE).delete().eq('user_id', user_id);
  if (error) {
    console.warn('[customers/accounts] deleteCustomerAccount error:', error.message || error);
    return false;
  }
  return true;
}
