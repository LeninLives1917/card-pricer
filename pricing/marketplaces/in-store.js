// pricing/marketplaces/in-store.js
// Owner: A9 | Slice: S18 (F18)
//
// In-store marketplace adapter — the no-op marketplace.
//
// "in_store" is the V2 default for cards a vendor sells across the counter.
// There is no external listing service to push to — the `listings` row in
// our own DB is the source of truth. Every operation returns { ok: true }
// so the route layer treats it as a happy path, but no network call leaves
// the process.
//
// Required env vars: none.
// Required credentials: none.
// Always available; isAvailable() returns { ok: true }.
//
// See pricing/marketplaces/adapter.interface.md for the full contract.

export const name = 'in_store';

export function isAvailable() {
  return { ok: true };
}

/**
 * "Listing" an in-store card is purely metadata — the card is now visible
 * in our case + on the vendor app's "for sale" tab. No external URL exists.
 */
export async function listItem(_item, _ask_eur, _ctx = {}) {
  return { ok: true, external_url: null, listing_id: null };
}

/**
 * Price changes are written to our DB only. No external call.
 */
export async function updateListing(_external_listing_id, _fields, _ctx = {}) {
  return { ok: true };
}

/**
 * In-store sales are entered manually by the vendor (cash to till). The
 * route layer passes sold_eur + fees_eur directly to db/inventory/listings.markSold;
 * this method is just a sentinel so the dispatch table is uniform.
 *
 * Real-world fees for in-store sales are typically 0 (cash) but the schema
 * permits a non-zero value (e.g. payment-processor cut on a card terminal).
 */
export async function markSold(_external_listing_id, _ctx = {}) {
  return { ok: true };
}

/**
 * Delisting in-store = "back in the case, not for sale". DB-only.
 */
export async function delistItem(_external_listing_id, _ctx = {}) {
  return { ok: true };
}

export default {
  name,
  isAvailable,
  listItem,
  updateListing,
  markSold,
  delistItem,
};
