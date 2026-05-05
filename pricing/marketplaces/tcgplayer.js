// pricing/marketplaces/tcgplayer.js
// Owner: A9 | Slice: S18 (F18)
//
// TCGPlayer outbound listing adapter — V2 SKELETON.
//
// Real REST integration lands in V2.1+. For V2 every write operation returns
// { ok: false, reason: 'not_yet_implemented' } so the route layer can record
// an intent-only `listings` row in our DB.
//
// Required env vars (V2.1+):
//   TCGPLAYER_PRO_KEY      — Pro Sellers tier API key
//
// The TCGPlayer listing API is gated behind Pro Seller status; the V1 sold-
// listings pricing adapter uses the public Pricing API, which is unrelated
// and unauthenticated.
//
// See pricing/marketplaces/adapter.interface.md for the full contract.

export const name = 'tcgplayer';

const REQUIRED_ENV = ['TCGPLAYER_PRO_KEY'];

export function isAvailable() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      return { ok: false, reason: `missing_credentials:${key}` };
    }
  }
  return { ok: false, reason: 'not_yet_implemented' };
}

export async function listItem(_item, _ask_eur, _ctx = {}) {
  return { ok: false, reason: 'not_yet_implemented' };
}

export async function updateListing(_external_listing_id, _fields, _ctx = {}) {
  return { ok: false, reason: 'not_yet_implemented' };
}

export async function markSold(_external_listing_id, _ctx = {}) {
  return { ok: false, reason: 'not_yet_implemented' };
}

export async function delistItem(_external_listing_id, _ctx = {}) {
  return { ok: false, reason: 'not_yet_implemented' };
}

export default {
  name,
  isAvailable,
  listItem,
  updateListing,
  markSold,
  delistItem,
};
