// pricing/marketplaces/cardmarket.js
// Owner: A9 | Slice: S18 (F18)
//
// Cardmarket outbound listing adapter — V2 SKELETON.
//
// Real OAuth 1.0a + REST integration lands in V2.1+. For V2 every write
// operation returns { ok: false, reason: 'not_yet_implemented' } so the
// route layer can record an intent-only `listings` row in our DB and surface
// a soft-fail in the UI without erroring out the request.
//
// Required env vars (V2.1+):
//   CARDMARKET_OAUTH_KEY
//   CARDMARKET_OAUTH_SECRET
//   CARDMARKET_TOKEN
//   CARDMARKET_TOKEN_SECRET
//
// Cardmarket uses per-vendor OAuth tokens. In V2.1 the four env vars above
// are *fallback* credentials used only by `isAvailable()`; production lookups
// will pull per-user tokens from `profiles.cardmarket_oauth_*` (encrypted).
//
// See pricing/marketplaces/adapter.interface.md for the full contract.

export const name = 'cardmarket';

const REQUIRED_ENV = [
  'CARDMARKET_OAUTH_KEY',
  'CARDMARKET_OAUTH_SECRET',
  'CARDMARKET_TOKEN',
  'CARDMARKET_TOKEN_SECRET',
];

export function isAvailable() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      return { ok: false, reason: `missing_credentials:${key}` };
    }
  }
  // Even when env is set, V2 has no transport implementation, so the adapter
  // is "configured but not implemented". Surface that distinction so the
  // route layer can show "Cardmarket integration coming in V2.1" copy.
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
