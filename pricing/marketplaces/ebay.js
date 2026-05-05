// pricing/marketplaces/ebay.js
// Owner: A9 | Slice: S18 (F18)
//
// eBay outbound listing adapter — V2 SKELETON.
//
// Real Trading API + Browse API integration lands in V2.1+. For V2 every
// write operation returns { ok: false, reason: 'not_yet_implemented' } so
// the route layer records an intent-only `listings` row in our DB.
//
// Required env vars (V2.1+):
//   EBAY_APP_ID            — same App ID already used by V1 sold-listings adapter
//   EBAY_CERT_ID           — same Cert ID already used by V1 sold-listings adapter
//
// V1 already authenticates with eBay for *reading* sold-listings comps via
// pricing/ebay-sold-listings.js. The same App ID + Cert ID grant *writing*
// access to the Trading API once we add the OAuth user-token flow (V2.1).
//
// See pricing/marketplaces/adapter.interface.md for the full contract.

export const name = 'ebay';

const REQUIRED_ENV = ['EBAY_APP_ID', 'EBAY_CERT_ID'];

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
