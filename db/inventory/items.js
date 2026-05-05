// db/inventory/items.js
// Owner: A9 | Slice: S18 (F18)
//
// CRUD for inventory_items + emission of corresponding inventory_events rows.
// Schema (supabase/migrations/20260502221125_v2_carryover.sql):
//
//   inventory_items (
//     id, owner_user_id (NOT NULL, FK auth.users), shop_id?,
//     card_meta jsonb (NOT NULL), source ('scan'|'manual'|'import'),
//     cost_eur (NOT NULL), condition_at_buy?, market_value_at_buy?,
//     state ('in_stock'|'listed'|'sold'|'consigned'|'returned'),
//     notes?, created_at, updated_at
//   )
//
// RLS: owner_user_id = auth.uid(). We use the service-role client so RLS is
// bypassed; every query MUST filter on owner_user_id explicitly. This is the
// same pattern as live_sessions.
//
// Append-only event log: every mutation here also writes an inventory_events
// row via db/inventory/events.js so inventory_items.state stays consistent
// with the audit trail. The route layer NEVER updates state without going
// through these helpers.

import { supabase as defaultClient } from '../../apps/server/_clients.js';
import { addEvent } from './events.js';

const TABLE_ITEMS = 'inventory_items';

export const VALID_SOURCES = Object.freeze(['scan', 'manual', 'import']);
export const VALID_STATES = Object.freeze([
  'in_stock', 'listed', 'sold', 'consigned', 'returned',
]);

// Map a state transition to the event_type that should be logged.
// 'in_stock' has no inbound state-change event (it's the post-'bought' default);
// the route layer emits 'bought' on createItem instead.
const STATE_TO_EVENT = Object.freeze({
  listed: 'listed',
  sold: 'sold',
  consigned: 'consigned',
  returned: 'returned',
  in_stock: 'note', // re-stocking after consign/return — log as a generic note
});

/**
 * Insert a new inventory item + emit a 'bought' event.
 *
 * @param {object} params
 * @param {string} params.owner_user_id        REQUIRED
 * @param {string} [params.shop_id]
 * @param {object} params.card_meta            REQUIRED (jsonb)
 * @param {string} [params.source='scan']
 * @param {number} params.cost_eur             REQUIRED
 * @param {string} [params.condition_at_buy]
 * @param {number} [params.market_value_at_buy]
 * @param {string} [params.notes]
 * @param {object} [client]
 * @returns {Promise<object>} the inserted item row
 */
export async function createItem(params, client = defaultClient) {
  if (!client) throw new Error('inventory/items: supabase client unavailable');

  const {
    owner_user_id,
    shop_id,
    card_meta,
    source = 'scan',
    cost_eur,
    condition_at_buy,
    market_value_at_buy,
    notes,
  } = params || {};

  if (!owner_user_id) throw new Error('createItem: owner_user_id is required');
  if (!card_meta) throw new Error('createItem: card_meta is required');
  if (cost_eur === undefined || cost_eur === null) {
    throw new Error('createItem: cost_eur is required');
  }
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`createItem: invalid source "${source}" (allowed: ${VALID_SOURCES.join(', ')})`);
  }

  const row = { owner_user_id, card_meta, source, cost_eur };
  if (shop_id) row.shop_id = shop_id;
  if (condition_at_buy != null) row.condition_at_buy = condition_at_buy;
  if (market_value_at_buy != null) row.market_value_at_buy = market_value_at_buy;
  if (notes != null) row.notes = notes;

  const { data, error } = await client
    .from(TABLE_ITEMS)
    .insert(row)
    .select('*')
    .single();

  if (error) throw new Error(`createItem failed: ${error.message || error}`);

  // Audit trail: record the buy.
  try {
    await addEvent({
      item_id: data.id,
      event_type: 'bought',
      data: {
        cost_eur,
        condition_at_buy: condition_at_buy ?? null,
        market_value_at_buy: market_value_at_buy ?? null,
        source,
      },
      actor_user_id: owner_user_id,
    }, client);
  } catch (e) {
    console.warn('[inventory/items] bought-event emission failed:', e.message || e);
  }

  return data;
}

/**
 * Fetch a single item the caller owns. Service-role bypasses RLS so the
 * owner_user_id filter is enforced manually here.
 *
 * @returns {Promise<object|null>}
 */
export async function getItem(id, owner_user_id, client = defaultClient) {
  if (!client) return null;
  if (!id || !owner_user_id) return null;

  const { data, error } = await client
    .from(TABLE_ITEMS)
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', owner_user_id)
    .maybeSingle();

  if (error) {
    console.warn('[inventory/items] getItem failed:', error.message || error);
    return null;
  }
  return data ?? null;
}

/**
 * List items for an owner with optional state filter + pagination.
 *
 * @param {string} owner_user_id
 * @param {object} [opts]
 * @param {string} [opts.state]    one of VALID_STATES; omit to get every state
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {object} [client]
 * @returns {Promise<Array<object>>}
 */
export async function listItems(
  owner_user_id,
  { state, limit = 50, offset = 0 } = {},
  client = defaultClient,
) {
  if (!client) return [];
  if (!owner_user_id) return [];
  if (state !== undefined && !VALID_STATES.includes(state)) {
    throw new Error(`listItems: invalid state filter "${state}"`);
  }
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);

  let query = client
    .from(TABLE_ITEMS)
    .select('*')
    .eq('owner_user_id', owner_user_id);

  if (state) query = query.eq('state', state);

  query = query
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  const { data, error } = await query;
  if (error) {
    console.warn('[inventory/items] listItems failed:', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Transition an item to a new state and append the matching event row.
 *
 * The route layer NEVER updates inventory_items.state directly — every state
 * change passes through here so the audit log stays consistent.
 *
 * @param {string} id
 * @param {string} owner_user_id
 * @param {string} new_state           one of VALID_STATES
 * @param {object} [eventData]         extra payload for the event (e.g. {sold_eur})
 * @param {object} [client]
 * @returns {Promise<object|null>} the updated item row
 */
export async function updateItemState(
  id, owner_user_id, new_state, eventData = null, client = defaultClient,
) {
  if (!client) throw new Error('inventory/items: supabase client unavailable');
  if (!id) throw new Error('updateItemState: id is required');
  if (!owner_user_id) throw new Error('updateItemState: owner_user_id is required');
  if (!VALID_STATES.includes(new_state)) {
    throw new Error(`updateItemState: invalid state "${new_state}"`);
  }

  // Ownership-gated update — explicit filter on owner_user_id since service-role bypasses RLS.
  const { data, error } = await client
    .from(TABLE_ITEMS)
    .update({ state: new_state, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner_user_id', owner_user_id)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`updateItemState failed: ${error.message || error}`);
  if (!data) return null;

  // Emit the matching event. STATE_TO_EVENT maps every state to a valid
  // event_type; default to 'note' for safety.
  const eventType = STATE_TO_EVENT[new_state] || 'note';
  try {
    await addEvent({
      item_id: id,
      event_type: eventType,
      data: { new_state, ...(eventData || {}) },
      actor_user_id: owner_user_id,
    }, client);
  } catch (e) {
    console.warn('[inventory/items] state-event emission failed:', e.message || e);
  }

  return data;
}

/**
 * Patch a small set of mutable fields on an item. State changes go through
 * updateItemState — this helper is for notes / cost corrections / metadata.
 *
 * Emits 'note' for note changes; 'price_change' when market_value_at_buy
 * changes (vendor re-evaluating their initial buy price).
 *
 * @param {string} id
 * @param {string} owner_user_id
 * @param {object} fields
 *   { notes?, condition_at_buy?, market_value_at_buy?, card_meta?, cost_eur? }
 * @param {object} [client]
 * @returns {Promise<object|null>}
 */
export async function updateItem(id, owner_user_id, fields, client = defaultClient) {
  if (!client) throw new Error('inventory/items: supabase client unavailable');
  if (!id) throw new Error('updateItem: id is required');
  if (!owner_user_id) throw new Error('updateItem: owner_user_id is required');

  const allowed = ['notes', 'condition_at_buy', 'market_value_at_buy', 'card_meta', 'cost_eur'];
  const patch = {};
  for (const key of allowed) {
    if (fields && Object.prototype.hasOwnProperty.call(fields, key)) {
      patch[key] = fields[key];
    }
  }
  if (Object.keys(patch).length === 0) return getItem(id, owner_user_id, client);
  patch.updated_at = new Date().toISOString();

  const { data, error } = await client
    .from(TABLE_ITEMS)
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', owner_user_id)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`updateItem failed: ${error.message || error}`);
  if (!data) return null;

  // Decide which (if any) event type to emit. price_change beats note when
  // both apply.
  let eventType = null;
  const eventData = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'market_value_at_buy')
      || Object.prototype.hasOwnProperty.call(patch, 'cost_eur')) {
    eventType = 'price_change';
    if ('market_value_at_buy' in patch) eventData.market_value_at_buy = patch.market_value_at_buy;
    if ('cost_eur' in patch) eventData.cost_eur = patch.cost_eur;
  } else if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    eventType = 'note';
    eventData.notes = patch.notes;
  }

  if (eventType) {
    try {
      await addEvent({
        item_id: id,
        event_type: eventType,
        data: eventData,
        actor_user_id: owner_user_id,
      }, client);
    } catch (e) {
      console.warn('[inventory/items] update-event emission failed:', e.message || e);
    }
  }

  return data;
}

/**
 * Compute the per-item P&L from a set of listing rows.
 *
 *   pnl_eur = total_sold_eur - cost_eur - total_fees_eur
 *
 * Only listings with sold_at set count toward total_sold_eur / total_fees_eur.
 * Items can have multiple listings (e.g. cross-listed on Cardmarket + eBay
 * with one of them ultimately selling) — totals sum across all sold rows.
 *
 * @param {object} item        the inventory_items row (must have cost_eur)
 * @param {Array<object>} listings  the joined listings rows for this item
 * @returns {{ pnl_eur: number, total_sold_eur: number, total_fees_eur: number }}
 */
export function computeItemPnl(item, listings) {
  if (!item) return { pnl_eur: 0, total_sold_eur: 0, total_fees_eur: 0 };

  const cost = Number(item.cost_eur ?? 0);
  let totalSold = 0;
  let totalFees = 0;

  if (Array.isArray(listings)) {
    for (const l of listings) {
      if (!l) continue;
      if (!l.sold_at) continue; // only realised sales contribute
      if (l.sold_eur != null) totalSold += Number(l.sold_eur);
      if (l.fees_eur != null) totalFees += Number(l.fees_eur);
    }
  }

  const pnl = totalSold - cost - totalFees;
  // Round to cents to avoid float-noise like 6.000000000000001.
  const round = (n) => Math.round(n * 100) / 100;
  return {
    pnl_eur: round(pnl),
    total_sold_eur: round(totalSold),
    total_fees_eur: round(totalFees),
  };
}

export default {
  VALID_SOURCES,
  VALID_STATES,
  createItem,
  getItem,
  listItems,
  updateItemState,
  updateItem,
  computeItemPnl,
};
