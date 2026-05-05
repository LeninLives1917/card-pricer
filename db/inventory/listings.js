// db/inventory/listings.js
// Owner: A9 | Slice: S18 (F18)
//
// CRUD for the listings table + emission of the corresponding inventory_events
// rows. Schema (supabase/migrations/20260502221125_v2_carryover.sql):
//
//   listings (
//     id, item_id (NOT NULL FK inventory_items),
//     marketplace ('cardmarket'|'tcgplayer'|'ebay'|'in_store'),
//     external_url?, ask_eur?, listed_at default now(),
//     sold_at?, sold_eur?, fees_eur?
//   )
//
// RLS: read+write cascade through the parent inventory_items row's
// owner_user_id = auth.uid() check. Service-role bypasses RLS, so every
// read/write here verifies ownership manually via a join lookup.
//
// State coupling: when a listing is marked sold AND it's the only outstanding
// listing for the item (or all sibling listings are also sold), the parent
// item is auto-flipped to state='sold'. Otherwise the item stays 'listed' so
// the vendor still sees it as live on the other marketplaces.

import { supabase as defaultClient } from '../../apps/server/_clients.js';
import { addEvent } from './events.js';
import { updateItemState } from './items.js';

const TABLE_LISTINGS = 'listings';
const TABLE_ITEMS = 'inventory_items';

export const VALID_MARKETPLACES = Object.freeze([
  'cardmarket', 'tcgplayer', 'ebay', 'in_store',
]);

// Internal helper — verify the caller owns the parent item before touching a
// listing. Returns the item row on success, null on miss/mismatch.
async function ownItem(item_id, owner_user_id, client) {
  const { data, error } = await client
    .from(TABLE_ITEMS)
    .select('id,owner_user_id,state')
    .eq('id', item_id)
    .eq('owner_user_id', owner_user_id)
    .maybeSingle();
  if (error) {
    console.warn('[inventory/listings] ownership check failed:', error.message || error);
    return null;
  }
  return data ?? null;
}

// Internal helper — fetch a listing + verify ownership through the parent.
async function ownListing(id, owner_user_id, client) {
  const { data: listing, error } = await client
    .from(TABLE_LISTINGS)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('[inventory/listings] listing fetch failed:', error.message || error);
    return null;
  }
  if (!listing) return null;
  const item = await ownItem(listing.item_id, owner_user_id, client);
  if (!item) return null;
  return listing;
}

/**
 * Insert a listing row + emit a 'listed' event. The route layer is
 * responsible for first dispatching to the marketplace adapter; the adapter
 * outcome (ok / not_yet_implemented) is passed via `adapterResult` so the
 * audit row records what actually happened externally.
 *
 * @param {object} params
 * @param {string} params.item_id
 * @param {string} params.owner_user_id          ownership gate
 * @param {string} params.marketplace            one of VALID_MARKETPLACES
 * @param {string} [params.external_url]
 * @param {number} [params.ask_eur]
 * @param {object} [params.adapterResult]        { ok, reason? } from adapter
 * @param {object} [client]
 * @returns {Promise<object|null>} listing row, or null if ownership failed
 */
export async function createListing(params, client = defaultClient) {
  if (!client) throw new Error('inventory/listings: supabase client unavailable');

  const {
    item_id, owner_user_id, marketplace,
    external_url, ask_eur, adapterResult,
  } = params || {};

  if (!item_id) throw new Error('createListing: item_id is required');
  if (!owner_user_id) throw new Error('createListing: owner_user_id is required');
  if (!marketplace) throw new Error('createListing: marketplace is required');
  if (!VALID_MARKETPLACES.includes(marketplace)) {
    throw new Error(`createListing: invalid marketplace "${marketplace}"`);
  }

  // Ownership gate.
  const item = await ownItem(item_id, owner_user_id, client);
  if (!item) return null;

  const row = { item_id, marketplace };
  if (external_url) row.external_url = external_url;
  if (ask_eur != null) row.ask_eur = ask_eur;

  const { data, error } = await client
    .from(TABLE_LISTINGS)
    .insert(row)
    .select('*')
    .single();

  if (error) throw new Error(`createListing failed: ${error.message || error}`);

  // Bump parent item state to 'listed' if it isn't already 'sold'/'consigned'.
  if (item.state === 'in_stock') {
    try {
      await updateItemState(item_id, owner_user_id, 'listed', { marketplace }, client);
    } catch (e) {
      console.warn('[inventory/listings] item-state bump failed:', e.message || e);
    }
  }

  // Audit-log the listing.
  try {
    await addEvent({
      item_id,
      event_type: 'listed',
      data: {
        listing_id: data.id,
        marketplace,
        ask_eur: ask_eur ?? null,
        external_url: external_url ?? null,
        adapter_ok: adapterResult ? !!adapterResult.ok : null,
        adapter_reason: adapterResult?.reason ?? null,
      },
      actor_user_id: owner_user_id,
    }, client);
  } catch (e) {
    console.warn('[inventory/listings] listed-event emission failed:', e.message || e);
  }

  return data;
}

/**
 * Fetch a single listing the caller owns (via the parent item).
 *
 * @returns {Promise<object|null>}
 */
export async function getListing(id, owner_user_id, client = defaultClient) {
  if (!client) return null;
  if (!id || !owner_user_id) return null;
  return ownListing(id, owner_user_id, client);
}

/**
 * List all listings for an item the caller owns.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listListingsForItem(item_id, owner_user_id, client = defaultClient) {
  if (!client) return [];
  if (!item_id || !owner_user_id) return [];

  const item = await ownItem(item_id, owner_user_id, client);
  if (!item) return [];

  const { data, error } = await client
    .from(TABLE_LISTINGS)
    .select('*')
    .eq('item_id', item_id)
    .order('listed_at', { ascending: false });

  if (error) {
    console.warn('[inventory/listings] listListingsForItem failed:', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Mark a listing as sold + emit a 'sold' event. If this leaves zero
 * outstanding (unsold) listings on the parent item, the item is auto-flipped
 * to state='sold'.
 *
 * @param {string} id
 * @param {string} owner_user_id
 * @param {object} fields
 * @param {number} fields.sold_eur     REQUIRED
 * @param {number} [fields.fees_eur=0]
 * @param {object} [client]
 * @returns {Promise<object|null>} the updated listing
 */
export async function markSold(id, owner_user_id, fields, client = defaultClient) {
  if (!client) throw new Error('inventory/listings: supabase client unavailable');
  if (!id) throw new Error('markSold: id is required');
  if (!owner_user_id) throw new Error('markSold: owner_user_id is required');
  if (!fields || fields.sold_eur == null) {
    throw new Error('markSold: sold_eur is required');
  }

  const existing = await ownListing(id, owner_user_id, client);
  if (!existing) return null;

  const patch = {
    sold_at: new Date().toISOString(),
    sold_eur: fields.sold_eur,
    fees_eur: fields.fees_eur ?? 0,
  };

  const { data, error } = await client
    .from(TABLE_LISTINGS)
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`markSold failed: ${error.message || error}`);
  if (!data) return null;

  // Audit log on the parent item.
  try {
    await addEvent({
      item_id: existing.item_id,
      event_type: 'sold',
      data: {
        listing_id: id,
        marketplace: existing.marketplace,
        sold_eur: patch.sold_eur,
        fees_eur: patch.fees_eur,
        ask_eur: existing.ask_eur ?? null,
      },
      actor_user_id: owner_user_id,
    }, client);
  } catch (e) {
    console.warn('[inventory/listings] sold-event emission failed:', e.message || e);
  }

  // Sibling check — flip the item to 'sold' if no listings remain unsold.
  // This permits cross-listing: vendor lists on Cardmarket AND in-store; the
  // first sale doesn't yet flip the item, but when the second listing is
  // either delisted (TODO V2.1) or also sold, the item flips to 'sold'.
  const siblings = await listListingsForItem(existing.item_id, owner_user_id, client);
  const allSold = siblings.length > 0 && siblings.every((l) => l.sold_at);
  if (allSold) {
    try {
      await updateItemState(existing.item_id, owner_user_id, 'sold', {
        last_listing_id: id,
      }, client);
    } catch (e) {
      console.warn('[inventory/listings] item-flip-to-sold failed:', e.message || e);
    }
  }

  return data;
}

/**
 * Patch a listing's ask price + emit a 'price_change' event.
 *
 * @param {string} id
 * @param {string} owner_user_id
 * @param {object} fields { ask_eur, external_url? }
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function updateAsk(id, owner_user_id, fields, client = defaultClient) {
  if (!client) throw new Error('inventory/listings: supabase client unavailable');
  if (!id) throw new Error('updateAsk: id is required');
  if (!owner_user_id) throw new Error('updateAsk: owner_user_id is required');
  if (!fields || (fields.ask_eur == null && !fields.external_url)) {
    throw new Error('updateAsk: at least one of ask_eur or external_url required');
  }

  const existing = await ownListing(id, owner_user_id, client);
  if (!existing) return null;

  const patch = {};
  if (fields.ask_eur != null) patch.ask_eur = fields.ask_eur;
  if (fields.external_url) patch.external_url = fields.external_url;

  const { data, error } = await client
    .from(TABLE_LISTINGS)
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`updateAsk failed: ${error.message || error}`);
  if (!data) return null;

  if (fields.ask_eur != null && fields.ask_eur !== existing.ask_eur) {
    try {
      await addEvent({
        item_id: existing.item_id,
        event_type: 'price_change',
        data: {
          listing_id: id,
          marketplace: existing.marketplace,
          old_ask_eur: existing.ask_eur ?? null,
          new_ask_eur: fields.ask_eur,
        },
        actor_user_id: owner_user_id,
      }, client);
    } catch (e) {
      console.warn('[inventory/listings] price_change emission failed:', e.message || e);
    }
  }

  return data;
}

export default {
  VALID_MARKETPLACES,
  createListing,
  getListing,
  listListingsForItem,
  markSold,
  updateAsk,
};
