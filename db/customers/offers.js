// db/customers/offers.js
// Owner: A10 | Slice: S20 (F19)
//
// CRUD layer for public.quote_offers (V2_AUDIT row F19,
// supabase/migrations/20260502221125_v2_carryover.sql:221-254).
//
// Tokenised acceptance: a shop creates an offer, the customer hits
// /api/v2/quote-offer/:token/accept. The token IS the auth — no Supabase
// login required for the public accept/decline path. customer_user_id is
// auto-set on accept/decline IF the customer is logged in at the time
// (so the offer shows up in their dashboard) but isn't required.
//
// Why service-role?
//   The accept_token check is the authority — RLS would reject anonymous
//   reads even with the right token. The service-role client bypasses RLS
//   so token-based access works. We compensate by validating the token in
//   every public path (and only ever surfacing one offer per token).
//
// All exported functions accept an injected supabase client so tests can
// pass a mock. Production callers omit the arg and pick up the default
// service-role client from apps/server/_clients.js.

import crypto from 'crypto';
import { supabase as defaultClient } from '../../apps/server/_clients.js';

const TABLE = 'quote_offers';

// 7 days, in ms. Default offer expiry per V2_ARCHITECTURE F19. Kept
// exported so the route handler / tests can reference the same constant.
export const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// Crockford's Base32 alphabet — no I/L/O/U so the token is human-readable
// when copy-pasted from a phone screen. 32 chars at 5 bits each = 160 bits
// of entropy, comfortably collision-resistant for the offer namespace.
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a cryptographically random 32-character base32 token. URL-safe
 * (no special chars) and shorter / typeable compared to UUIDv4. The unique
 * constraint on quote_offers.accept_token is the dedup gate; in the rare
 * event of a clash the insert returns 23505 and the route should retry
 * (handled in createOffer below).
 *
 * @returns {string} a 32-char base32 string
 */
export function generateAcceptToken() {
  const bytes = crypto.randomBytes(20); // 20 bytes = 160 bits = 32 base32 chars
  let out = '';
  let bitBuffer = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += BASE32_ALPHABET[(bitBuffer >> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) {
    out += BASE32_ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
  }
  return out.slice(0, 32);
}

/**
 * Insert a new offer row. Auto-generates accept_token, sets status='open',
 * and computes expires_at from DEFAULT_EXPIRY_MS unless caller overrides.
 *
 * @param {object} params
 * @param {string} params.shop_id        — REQUIRED (FK shops.id)
 * @param {string} [params.lead_id]      — optional FK quote_leads.id
 * @param {string} params.customer_email — REQUIRED
 * @param {Array}  params.line_items     — REQUIRED jsonb payload
 * @param {number} params.total_eur      — REQUIRED
 * @param {string} [params.currency='EUR']
 * @param {string|Date} [params.expires_at]
 * @param {object} [client]
 * @returns {Promise<object>} the inserted row
 */
export async function createOffer(
  { shop_id, lead_id, customer_email, line_items, total_eur, currency = 'EUR', expires_at },
  client = defaultClient,
) {
  if (!client) throw new Error('customers/offers: supabase client unavailable');
  if (!shop_id) throw new Error('createOffer: shop_id required');
  if (!customer_email) throw new Error('createOffer: customer_email required');
  if (!Array.isArray(line_items)) throw new Error('createOffer: line_items must be an array');
  if (typeof total_eur !== 'number' && total_eur !== 0) {
    throw new Error('createOffer: total_eur must be a number');
  }

  const expiresAtIso = expires_at
    ? (expires_at instanceof Date ? expires_at.toISOString() : String(expires_at))
    : new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString();

  // Single retry on token collision — astronomical odds, but the unique
  // constraint deserves a defensive path.
  for (let attempt = 0; attempt < 2; attempt++) {
    const accept_token = generateAcceptToken();
    const row = {
      shop_id,
      lead_id: lead_id || null,
      customer_email,
      accept_token,
      line_items,
      total_eur,
      currency,
      status: 'open',
      expires_at: expiresAtIso,
    };
    const { data, error } = await client
      .from(TABLE)
      .insert(row)
      .select('*')
      .maybeSingle();
    if (!error && data) return data;
    if (error && error.code === '23505' && /accept_token/i.test(error.message || '')) {
      continue; // retry once
    }
    throw new Error(`createOffer failed: ${error?.message || error || 'unknown'}`);
  }
  throw new Error('createOffer failed: token collision after 2 attempts');
}

/**
 * Lookup by accept_token. Auto-flips a stale 'open' row to 'expired' when
 * expires_at is in the past so callers see a consistent status without
 * needing a cron job.
 *
 * @param {string} token
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function getOfferByToken(token, client = defaultClient) {
  if (!client) return null;
  if (!token) return null;
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('accept_token', token)
    .maybeSingle();
  if (error) {
    console.warn('[customers/offers] getOfferByToken error:', error.message || error);
    return null;
  }
  if (!data) return null;
  // Lazy expiry flip.
  if (data.status === 'open' && data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    const { data: flipped } = await client
      .from(TABLE)
      .update({ status: 'expired' })
      .eq('id', data.id)
      .select('*')
      .maybeSingle();
    return flipped ?? { ...data, status: 'expired' };
  }
  return data;
}

/**
 * All offers for a customer (matched on auth user id OR email). Auto-links
 * by setting customer_user_id on email-only matches so future RLS-scoped
 * reads (from the customer dashboard) see them.
 *
 * @param {string} user_id
 * @param {string} email
 * @param {object} [client]
 * @returns {Promise<Array<object>>}
 */
export async function getOffersForCustomer(user_id, email, client = defaultClient) {
  if (!client) return [];
  if (!user_id && !email) return [];
  // Fetch matching by user_id OR email; service-role bypasses RLS.
  // We do two queries + merge rather than `.or()` for simpler fake-test
  // behaviour, but the production path is one round-trip per branch.
  const byUser = user_id
    ? await client.from(TABLE).select('*').eq('customer_user_id', user_id)
    : { data: [], error: null };
  const byEmail = email
    ? await client.from(TABLE).select('*').eq('customer_email', email)
    : { data: [], error: null };
  if (byUser.error) console.warn('[customers/offers] getOffersForCustomer byUser:', byUser.error.message);
  if (byEmail.error) console.warn('[customers/offers] getOffersForCustomer byEmail:', byEmail.error.message);

  const merged = new Map();
  for (const row of (byUser.data || [])) merged.set(row.id, row);
  for (const row of (byEmail.data || [])) if (!merged.has(row.id)) merged.set(row.id, row);

  // Auto-link: any email-matched row missing customer_user_id gets
  // customer_user_id stamped so the customer's dashboard works on the
  // next request without an explicit migration.
  if (user_id) {
    const toLink = [...merged.values()]
      .filter(r => r.customer_user_id == null)
      .map(r => r.id);
    if (toLink.length) {
      try {
        for (const id of toLink) {
          await client.from(TABLE).update({ customer_user_id: user_id }).eq('id', id);
        }
      } catch (e) {
        // Non-fatal — the offer list still returns even if the auto-link fails.
        console.warn('[customers/offers] auto-link failed:', e.message || e);
      }
    }
  }

  return [...merged.values()].sort((a, b) => {
    const at = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bt - at; // newest first
  });
}

/**
 * All offers for a shop, newest first. Used by the shop's offers list UI.
 *
 * @param {string} shop_id
 * @param {object} [client]
 * @returns {Promise<Array<object>>}
 */
export async function getOffersForShop(shop_id, client = defaultClient) {
  if (!client) return [];
  if (!shop_id) return [];
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('shop_id', shop_id)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[customers/offers] getOffersForShop error:', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Mark an offer accepted. Refuses non-'open' rows (already accepted /
 * declined / expired). Returns null on the refuse path so the route can
 * tell "not found" (also null) vs "not acceptable" by re-reading status.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string} [opts.customer_user_id] — set when a logged-in customer accepts
 * @param {object} [client]
 * @returns {Promise<object|null>} the updated row, or null if not acceptable
 */
export async function acceptOffer(token, { customer_user_id } = {}, client = defaultClient) {
  if (!client) return null;
  if (!token) return null;
  const offer = await getOfferByToken(token, client);
  if (!offer) return null;
  if (offer.status !== 'open') return null; // expired / accepted / declined — caller surfaces 410/409
  const patch = {
    status: 'accepted',
    accepted_at: new Date().toISOString(),
  };
  if (customer_user_id) patch.customer_user_id = customer_user_id;
  const { data, error } = await client
    .from(TABLE)
    .update(patch)
    .eq('id', offer.id)
    .eq('status', 'open') // race guard — refuse if status flipped between read and write
    .select('*')
    .maybeSingle();
  if (error) {
    console.warn('[customers/offers] acceptOffer error:', error.message || error);
    return null;
  }
  return data ?? null;
}

/**
 * Mark an offer declined. Same refuse-non-open semantics as acceptOffer.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string} [opts.customer_user_id]
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function declineOffer(token, { customer_user_id } = {}, client = defaultClient) {
  if (!client) return null;
  if (!token) return null;
  const offer = await getOfferByToken(token, client);
  if (!offer) return null;
  if (offer.status !== 'open') return null;
  const patch = {
    status: 'declined',
    declined_at: new Date().toISOString(),
  };
  if (customer_user_id) patch.customer_user_id = customer_user_id;
  const { data, error } = await client
    .from(TABLE)
    .update(patch)
    .eq('id', offer.id)
    .eq('status', 'open')
    .select('*')
    .maybeSingle();
  if (error) {
    console.warn('[customers/offers] declineOffer error:', error.message || error);
    return null;
  }
  return data ?? null;
}
