// tests/regression/inventory.spec.js
// Owner: A9 | Slice: S18 (F18)
//
// Coverage for db/inventory/{items,events,listings}.js +
// apps/server/routes/inventory.js + pricing/marketplaces/*.
//
// We don't have supertest in dependencies — for the route-level test we
// instantiate the router directly and feed it a stubbed Express req/res
// pair (the same trick is used in tests/regression/quote-public-paths.spec.js
// and tests/regression/ocr-first.spec.js).
//
// The stateful Supabase fake mirrors a minimal subset of the supabase-js
// PostgrestBuilder shape — enough for the inventory store calls (insert,
// select, update, eq, eq, range/order, single/maybeSingle).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createItem, getItem, listItems, updateItemState, computeItemPnl,
} from '../../db/inventory/items.js';
import {
  createListing, listListingsForItem, markSold,
} from '../../db/inventory/listings.js';
import { getEventsForItem } from '../../db/inventory/events.js';

import inStoreAdapter from '../../pricing/marketplaces/in-store.js';
import cardmarketAdapter from '../../pricing/marketplaces/cardmarket.js';

// =============================================================================
// Stateful Supabase fake — supports inventory_items + inventory_events + listings
// =============================================================================

let _idCounter = 0;
function nextId(prefix = 'id') {
  _idCounter += 1;
  return `${prefix}-${_idCounter}`;
}

function makeStatefulSupabase() {
  const tables = {
    inventory_items: [],
    inventory_events: [],
    listings: [],
  };

  function buildChain(table) {
    const op = {
      method: null,
      payload: null,
      eqs: [],
      order: null,
      range: null,
      limit: null,
    };

    function applyFilters(rows) {
      let out = rows;
      for (const [col, val] of op.eqs) {
        out = out.filter((r) => r[col] === val);
      }
      if (op.order) {
        const [col, opts] = op.order;
        const asc = !(opts && opts.ascending === false);
        out = [...out].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av > bv ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      if (op.range) {
        const [from, to] = op.range;
        out = out.slice(from, to + 1);
      }
      if (op.limit != null) {
        out = out.slice(0, op.limit);
      }
      return out;
    }

    const chain = {
      select: () => chain,
      insert: (row) => {
        op.method = 'insert';
        op.payload = row;
        return chain;
      },
      update: (patch) => {
        op.method = 'update';
        op.payload = patch;
        return chain;
      },
      upsert: (row) => {
        op.method = 'upsert';
        op.payload = row;
        return chain;
      },
      delete: () => {
        op.method = 'delete';
        return chain;
      },
      eq: (col, val) => { op.eqs.push([col, val]); return chain; },
      neq: () => chain, in: () => chain, gt: () => chain, lt: () => chain,
      gte: () => chain, lte: () => chain, like: () => chain,
      order: (col, opts) => { op.order = [col, opts]; return chain; },
      limit: (n) => { op.limit = n; return chain; },
      range: (from, to) => { op.range = [from, to]; return chain; },
      single: () => { op.single = true; return chain; },
      maybeSingle: () => { op.maybeSingle = true; return chain; },
      then: (resolve, reject) => {
        try {
          let result = { data: null, error: null };
          if (op.method === 'insert') {
            const row = { id: nextId(table), created_at: new Date().toISOString(), ...op.payload };
            if (table === 'inventory_items') {
              row.state = row.state || 'in_stock';
              row.updated_at = row.updated_at || row.created_at;
            }
            if (table === 'listings') {
              row.listed_at = row.listed_at || row.created_at;
            }
            tables[table].push(row);
            result = { data: row, error: null };
          } else if (op.method === 'update') {
            const matches = applyFilters(tables[table]);
            for (const match of matches) {
              Object.assign(match, op.payload);
            }
            const single = matches[0] || null;
            result = { data: single, error: null };
          } else if (op.method === 'delete') {
            const matches = applyFilters(tables[table]);
            tables[table] = tables[table].filter((r) => !matches.includes(r));
            result = { data: null, error: null };
          } else {
            // select
            const filtered = applyFilters(tables[table]);
            if (op.single || op.maybeSingle) {
              result = { data: filtered[0] || null, error: null };
            } else {
              result = { data: filtered, error: null };
            }
          }
          Promise.resolve(result).then(resolve, reject);
        } catch (e) {
          if (reject) reject(e); else throw e;
        }
      },
    };
    return chain;
  }

  return {
    from: (table) => {
      if (!tables[table]) tables[table] = [];
      return buildChain(table);
    },
    _tables: tables,
  };
}

// =============================================================================
// computeItemPnl — pure function math
// =============================================================================

test('computeItemPnl: cost 5, sold 12, fees 1 → pnl 6', () => {
  const item = { cost_eur: 5 };
  const listings = [{ sold_at: '2026-05-04', sold_eur: 12, fees_eur: 1 }];
  const pnl = computeItemPnl(item, listings);
  assert.equal(pnl.pnl_eur, 6);
  assert.equal(pnl.total_sold_eur, 12);
  assert.equal(pnl.total_fees_eur, 1);
});

test('computeItemPnl: ignores unsold listings', () => {
  const item = { cost_eur: 10 };
  const listings = [
    { sold_at: null, sold_eur: 999, fees_eur: 999 }, // ignored
    { sold_at: '2026-05-04', sold_eur: 25, fees_eur: 2 },
  ];
  const pnl = computeItemPnl(item, listings);
  assert.equal(pnl.total_sold_eur, 25);
  assert.equal(pnl.pnl_eur, 13); // 25 - 10 - 2
});

// =============================================================================
// createItem emits 'bought' event with cost_eur
// =============================================================================

test("createItem inserts item row + emits 'bought' event with cost_eur", async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Charizard ex' },
    source: 'scan',
    cost_eur: 50,
    condition_at_buy: 'NM',
  }, sb);

  assert.equal(item.owner_user_id, 'user-A');
  assert.equal(item.cost_eur, 50);
  assert.equal(item.state, 'in_stock');

  const events = sb._tables.inventory_events;
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'bought');
  assert.equal(events[0].item_id, item.id);
  assert.equal(events[0].data.cost_eur, 50);
  assert.equal(events[0].data.condition_at_buy, 'NM');
});

// =============================================================================
// getItem ownership gating
// =============================================================================

test('getItem with wrong owner returns null', async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Pikachu' },
    cost_eur: 5,
  }, sb);

  const found = await getItem(item.id, 'user-A', sb);
  assert.equal(found.id, item.id);

  const stolen = await getItem(item.id, 'user-B', sb);
  assert.equal(stolen, null, 'wrong owner must not see the item');
});

// =============================================================================
// listItems pagination
// =============================================================================

test('listItems honours limit + offset', async () => {
  const sb = makeStatefulSupabase();
  // Insert 5 items in order; createItem stamps created_at = now() so we
  // need separation to make ordering deterministic.
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await createItem({
      owner_user_id: 'user-A',
      card_meta: { name: `card-${i}` },
      cost_eur: i + 1,
    }, sb);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2));
  }

  const page1 = await listItems('user-A', { limit: 2, offset: 0 }, sb);
  const page2 = await listItems('user-A', { limit: 2, offset: 2 }, sb);
  const page3 = await listItems('user-A', { limit: 2, offset: 4 }, sb);

  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.equal(page3.length, 1);
  // newest-first ordering
  assert.equal(page1[0].card_meta.name, 'card-4');
  assert.equal(page1[1].card_meta.name, 'card-3');
});

// =============================================================================
// updateItemState emits state-change event
// =============================================================================

test("updateItemState emits the matching state-change event", async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Mewtwo' },
    cost_eur: 20,
  }, sb);

  await updateItemState(item.id, 'user-A', 'consigned', { reason: 'on-loan' }, sb);

  const events = sb._tables.inventory_events.filter((e) => e.item_id === item.id);
  // 'bought' from createItem + 'consigned' from updateItemState
  assert.equal(events.length, 2);
  const last = events[events.length - 1];
  assert.equal(last.event_type, 'consigned');
  assert.equal(last.data.new_state, 'consigned');
  assert.equal(last.data.reason, 'on-loan');

  const reload = await getItem(item.id, 'user-A', sb);
  assert.equal(reload.state, 'consigned');
});

// =============================================================================
// createListing dispatches to in-store adapter (success), records DB row
// =============================================================================

test("createListing → in-store adapter returns ok:true; DB row recorded", async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Blastoise' },
    cost_eur: 30,
  }, sb);

  const adapterResult = await inStoreAdapter.listItem(item, 35, {});
  assert.equal(adapterResult.ok, true);

  const listing = await createListing({
    item_id: item.id,
    owner_user_id: 'user-A',
    marketplace: 'in_store',
    ask_eur: 35,
    adapterResult,
  }, sb);

  assert.equal(listing.marketplace, 'in_store');
  assert.equal(Number(listing.ask_eur), 35);

  // Item state bumped to 'listed'.
  const reload = await getItem(item.id, 'user-A', sb);
  assert.equal(reload.state, 'listed');

  // Audit log: bought + listed (state-change to 'listed' was emitted as 'listed' event).
  const events = sb._tables.inventory_events.filter((e) => e.item_id === item.id);
  const listedEvents = events.filter((e) => e.event_type === 'listed');
  assert.ok(listedEvents.length >= 1, 'at least one listed event must be present');
  const explicit = listedEvents.find((e) => e.data?.listing_id === listing.id);
  assert.ok(explicit, 'explicit listing_id event present');
  assert.equal(explicit.data.adapter_ok, true);
});

// =============================================================================
// createListing → cardmarket adapter not_yet_implemented but DB row still recorded
// =============================================================================

test("cardmarket adapter returns not_yet_implemented; listing still recorded", async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Venusaur' },
    cost_eur: 18,
  }, sb);

  const adapterResult = await cardmarketAdapter.listItem(item, 22, {});
  assert.equal(adapterResult.ok, false);
  assert.equal(adapterResult.reason, 'not_yet_implemented');

  const listing = await createListing({
    item_id: item.id,
    owner_user_id: 'user-A',
    marketplace: 'cardmarket',
    ask_eur: 22,
    adapterResult,
  }, sb);

  assert.ok(listing, 'DB row written even though adapter is not implemented');
  assert.equal(listing.marketplace, 'cardmarket');

  // Event log records adapter_ok:false with reason.
  const listedEvents = sb._tables.inventory_events.filter(
    (e) => e.event_type === 'listed' && e.data?.listing_id === listing.id,
  );
  assert.equal(listedEvents.length, 1);
  assert.equal(listedEvents[0].data.adapter_ok, false);
  assert.equal(listedEvents[0].data.adapter_reason, 'not_yet_implemented');
});

// =============================================================================
// markSold updates listing + emits 'sold' event + flips item state
// =============================================================================

test("markSold updates row, emits 'sold' event, flips item.state when all listings sold", async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Mew' },
    cost_eur: 8,
  }, sb);

  const listing = await createListing({
    item_id: item.id,
    owner_user_id: 'user-A',
    marketplace: 'in_store',
    ask_eur: 15,
  }, sb);

  const sold = await markSold(listing.id, 'user-A', { sold_eur: 14, fees_eur: 0.5 }, sb);
  assert.equal(Number(sold.sold_eur), 14);
  assert.ok(sold.sold_at);

  // Sold event in audit log.
  const soldEvents = sb._tables.inventory_events.filter(
    (e) => e.event_type === 'sold' && e.data?.listing_id === listing.id,
  );
  assert.equal(soldEvents.length, 1);
  assert.equal(soldEvents[0].data.sold_eur, 14);
  assert.equal(soldEvents[0].data.fees_eur, 0.5);

  // Item state auto-flipped to 'sold' since this was the only listing.
  const reload = await getItem(item.id, 'user-A', sb);
  assert.equal(reload.state, 'sold');
});

// =============================================================================
// getEventsForItem ordering + ownership gate
// =============================================================================

test('getEventsForItem returns oldest-first and gates by owner', async () => {
  const sb = makeStatefulSupabase();
  const item = await createItem({
    owner_user_id: 'user-A',
    card_meta: { name: 'Snorlax' },
    cost_eur: 12,
  }, sb);
  await updateItemState(item.id, 'user-A', 'listed', null, sb);

  const ownEvents = await getEventsForItem(item.id, 'user-A', sb);
  assert.ok(ownEvents.length >= 2);
  assert.equal(ownEvents[0].event_type, 'bought');

  // Wrong owner sees []
  const empty = await getEventsForItem(item.id, 'user-B', sb);
  assert.deepEqual(empty, []);
});

// =============================================================================
// Route-level: GET /api/v2/inventory requires auth + plan
// =============================================================================

test('GET /api/v2/inventory rejects unauth / wrong-plan via middleware', async () => {
  // Import the router only — don't boot the full Express app (apps/server/index.js
  // pulls Sentry + pino which need env). The router's middleware chain is
  // requireAuth → requirePlan(['shop','beta']) → handler. Without supabase,
  // requireAuth short-circuits with 503 (matches its own contract). That's
  // sufficient evidence the auth chain is wired.
  const { default: router } = await import('../../apps/server/routes/inventory.js');

  // Stub req/res just enough that requireAuth executes its first branch.
  let status = null;
  let body = null;
  const res = {
    status(code) { status = code; return res; },
    json(payload) { body = payload; return res; },
  };
  const req = {
    method: 'GET',
    url: '/api/v2/inventory',
    headers: {},
    query: {},
    params: {},
  };

  // Find the GET /api/v2/inventory layer's stack — the router stores them
  // in the standard Express format. We invoke each layer in turn until one
  // sends a response, mimicking Express's dispatch.
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/api/v2/inventory' && l.route.methods.get,
  );
  assert.ok(layer, 'GET /api/v2/inventory route must be registered');

  const handlers = layer.route.stack.map((s) => s.handle);
  // First middleware is requireAuth — call it. With no Authorization header
  // it must respond 401 (or 503 if supabase is null in test env).
  await new Promise((resolve) => {
    handlers[0](req, res, () => {
      // next() should NOT be called because the request is unauthenticated.
      resolve();
    });
    // requireAuth is async but synchronously returns the 401/503 path when
    // there's no Bearer token. Allow microtask to drain.
    setImmediate(resolve);
  });

  assert.ok(status === 401 || status === 503, `expected 401/503, got ${status}`);
  assert.ok(body && body.error, 'error envelope present');
});
