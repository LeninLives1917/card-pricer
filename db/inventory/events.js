// db/inventory/events.js
// Owner: A9 | Slice: S18 (F18)
//
// Append-only audit log for every state change against an inventory_items
// row. Schema is defined in supabase/migrations/20260502221125_v2_carryover.sql:
//
//   inventory_events (
//     id            uuid pk default gen_random_uuid(),
//     item_id       uuid not null references inventory_items(id) on delete cascade,
//     event_type    text not null check (event_type in
//                     ('bought','listed','price_change','sold','returned','consigned','note')),
//     data          jsonb,
//     actor_user_id uuid references auth.users(id) on delete set null,
//     created_at    timestamptz default now()
//   )
//
// RLS: SELECT cascades through inventory_items.owner_user_id = auth.uid().
// Service-role client bypasses RLS, so getEventsForItem MUST verify
// ownership explicitly via a join to inventory_items.
//
// Append-only: only addEvent + getEventsForItem are exported. There is no
// updateEvent / deleteEvent, ever — events are an immutable audit log.
//
// Service-role client is dependency-injected so tests can pass a mock; the
// production caller imports the default client from apps/server/_clients.js.

import { supabase as defaultClient } from '../../apps/server/_clients.js';

const TABLE_EVENTS = 'inventory_events';
const TABLE_ITEMS = 'inventory_items';

// Mirror of the CHECK constraint in the migration. Validating in JS lets us
// surface a clear error instead of a generic Postgres 23514.
export const VALID_EVENT_TYPES = Object.freeze([
  'bought',
  'listed',
  'price_change',
  'sold',
  'returned',
  'consigned',
  'note',
]);

/**
 * Append a new event to the log. The only mutator on this table.
 *
 * @param {object} params
 * @param {string} params.item_id        REQUIRED, FK → inventory_items.id
 * @param {string} params.event_type     REQUIRED, must be in VALID_EVENT_TYPES
 * @param {object} [params.data]         JSONB payload (e.g. {cost_eur, ask_eur, sold_eur})
 * @param {string} [params.actor_user_id] Optional FK → auth.users.id
 * @param {object} [client]              supabase client (default = service-role)
 * @returns {Promise<object>} the inserted row
 */
export async function addEvent(
  { item_id, event_type, data, actor_user_id },
  client = defaultClient,
) {
  if (!client) throw new Error('inventory/events: supabase client unavailable');
  if (!item_id) throw new Error('addEvent: item_id is required');
  if (!event_type) throw new Error('addEvent: event_type is required');
  if (!VALID_EVENT_TYPES.includes(event_type)) {
    throw new Error(
      `addEvent: invalid event_type "${event_type}" (allowed: ${VALID_EVENT_TYPES.join(', ')})`,
    );
  }

  const row = { item_id, event_type };
  if (data !== undefined && data !== null) row.data = data;
  if (actor_user_id) row.actor_user_id = actor_user_id;

  const { data: inserted, error } = await client
    .from(TABLE_EVENTS)
    .insert(row)
    .select('*')
    .single();

  if (error) throw new Error(`addEvent failed: ${error.message || error}`);
  return inserted;
}

/**
 * Fetch the event history for an item, oldest-first (the natural reading
 * order for an audit log). Verifies ownership via a join lookup against
 * inventory_items because we use the service-role client (which bypasses RLS).
 *
 * @param {string} item_id
 * @param {string} owner_user_id  REQUIRED — ownership gate
 * @param {object} [client]
 * @returns {Promise<Array<object>>} events in created_at ASC order; [] on owner mismatch
 */
export async function getEventsForItem(item_id, owner_user_id, client = defaultClient) {
  if (!client) return [];
  if (!item_id || !owner_user_id) return [];

  // Ownership gate — fetch the item and confirm ownership before exposing
  // its event log. Returning [] on mismatch (rather than 403'ing) keeps the
  // route layer simple: getItem() does the same.
  const { data: item, error: ownErr } = await client
    .from(TABLE_ITEMS)
    .select('id,owner_user_id')
    .eq('id', item_id)
    .eq('owner_user_id', owner_user_id)
    .maybeSingle();

  if (ownErr) {
    console.warn('[inventory/events] ownership check failed:', ownErr.message || ownErr);
    return [];
  }
  if (!item) return [];

  const { data, error } = await client
    .from(TABLE_EVENTS)
    .select('*')
    .eq('item_id', item_id)
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[inventory/events] getEventsForItem failed:', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export default {
  VALID_EVENT_TYPES,
  addEvent,
  getEventsForItem,
};
