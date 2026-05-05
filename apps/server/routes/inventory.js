// apps/server/routes/inventory.js
// Owner: A9 | Slice: S18 (F18)
//
// V2 inventory subsystem — see docs/V2_ARCHITECTURE.md §5 F18.
//
// Endpoints (all require auth + plan in {shop, beta}):
//
//   GET    /api/v2/inventory                                  — list user's items
//   POST   /api/v2/inventory                                  — create new item (logs 'bought')
//   GET    /api/v2/inventory/:id                              — item + listings + P&L
//   PATCH  /api/v2/inventory/:id                              — update notes / metadata
//   DELETE /api/v2/inventory/:id                              — soft delete via state='returned'
//   POST   /api/v2/inventory/:id/list                         — create listing + dispatch adapter
//   PATCH  /api/v2/inventory/:id/listings/:listingId          — update ask price
//   POST   /api/v2/inventory/:id/listings/:listingId/sold     — mark sold + auto-flip item
//   GET    /api/v2/inventory/:id/events                       — audit log
//
// Mount: apps/server/index.js  →  app.use(inventoryRouter);
//
// Plan-gating: V1 used SHOP_PLANS = ['shop','beta'] for the embed widget.
// We reuse the same set for inventory since it's a paid-plan feature.
//
// RLS: routes pass the authenticated req.user.id as owner_user_id to every
// db/inventory/* call so service-role access stays gated.

import express from 'express';

import { requireAuth, requirePlan } from '../middleware/auth.js';
import {
  createItem, getItem, listItems, updateItemState, updateItem, computeItemPnl,
  VALID_SOURCES,
} from '../../../db/inventory/items.js';
import {
  createListing, listListingsForItem, markSold, updateAsk,
  VALID_MARKETPLACES,
} from '../../../db/inventory/listings.js';
import { getEventsForItem } from '../../../db/inventory/events.js';

import cardmarketAdapter from '../../../pricing/marketplaces/cardmarket.js';
import tcgplayerAdapter from '../../../pricing/marketplaces/tcgplayer.js';
import ebayAdapter      from '../../../pricing/marketplaces/ebay.js';
import inStoreAdapter   from '../../../pricing/marketplaces/in-store.js';

const router = express.Router();

const INVENTORY_PLANS = ['shop', 'beta'];

// ============================================================
// Adapter dispatch
// ============================================================
const ADAPTERS = {
  cardmarket: cardmarketAdapter,
  tcgplayer:  tcgplayerAdapter,
  ebay:       ebayAdapter,
  in_store:   inStoreAdapter,
};

function getAdapter(marketplace) {
  return ADAPTERS[marketplace] || null;
}

// ============================================================
// Validation helpers
// ============================================================
function err400(res, message) { return res.status(400).json({ error: message }); }
function err404(res, message = 'not found') { return res.status(404).json({ error: message }); }

function parseLimit(q) {
  const n = parseInt(q, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(500, n);
}
function parseOffset(q) {
  const n = parseInt(q, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// ============================================================
// GET /api/v2/inventory
// ============================================================
router.get(
  '/api/v2/inventory',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    try {
      const items = await listItems(req.user.id, {
        state: req.query.state || undefined,
        limit: parseLimit(req.query.limit),
        offset: parseOffset(req.query.offset),
      });
      res.json({ items });
    } catch (e) {
      console.error('[inventory] GET / failed:', e.message || e);
      res.status(500).json({ error: e.message || 'list failed' });
    }
  },
);

// ============================================================
// POST /api/v2/inventory
// ============================================================
router.post(
  '/api/v2/inventory',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    const body = req.body || {};
    if (!body.card_meta || typeof body.card_meta !== 'object') {
      return err400(res, 'card_meta is required (object)');
    }
    if (body.cost_eur == null || !Number.isFinite(Number(body.cost_eur))) {
      return err400(res, 'cost_eur is required (number)');
    }
    if (body.source && !VALID_SOURCES.includes(body.source)) {
      return err400(res, `source must be one of ${VALID_SOURCES.join(', ')}`);
    }

    try {
      const item = await createItem({
        owner_user_id: req.user.id,
        shop_id: body.shop_id || null,
        card_meta: body.card_meta,
        source: body.source || 'scan',
        cost_eur: Number(body.cost_eur),
        condition_at_buy: body.condition_at_buy ?? null,
        market_value_at_buy: body.market_value_at_buy != null ? Number(body.market_value_at_buy) : null,
        notes: body.notes ?? null,
      });
      res.status(201).json({ item });
    } catch (e) {
      console.error('[inventory] POST / failed:', e.message || e);
      res.status(500).json({ error: e.message || 'create failed' });
    }
  },
);

// ============================================================
// GET /api/v2/inventory/:id  (item + listings + P&L)
// ============================================================
router.get(
  '/api/v2/inventory/:id',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    try {
      const item = await getItem(req.params.id, req.user.id);
      if (!item) return err404(res, 'item not found');
      const listings = await listListingsForItem(item.id, req.user.id);
      const pnl = computeItemPnl(item, listings);
      res.json({ item, listings, pnl });
    } catch (e) {
      console.error('[inventory] GET /:id failed:', e.message || e);
      res.status(500).json({ error: e.message || 'fetch failed' });
    }
  },
);

// ============================================================
// PATCH /api/v2/inventory/:id  (notes / metadata; not state)
// ============================================================
router.patch(
  '/api/v2/inventory/:id',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    const body = req.body || {};
    // State changes don't go through this endpoint.
    if ('state' in body) {
      return err400(res, 'use POST /:id/list, /sold or DELETE /:id to change state');
    }
    try {
      const updated = await updateItem(req.params.id, req.user.id, body);
      if (!updated) return err404(res, 'item not found');
      res.json({ item: updated });
    } catch (e) {
      console.error('[inventory] PATCH /:id failed:', e.message || e);
      res.status(500).json({ error: e.message || 'update failed' });
    }
  },
);

// ============================================================
// DELETE /api/v2/inventory/:id  → soft delete via state='returned'
// ============================================================
router.delete(
  '/api/v2/inventory/:id',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    try {
      const updated = await updateItemState(req.params.id, req.user.id, 'returned', {
        deleted_via: 'DELETE /api/v2/inventory/:id',
      });
      if (!updated) return err404(res, 'item not found');
      res.json({ ok: true, item: updated });
    } catch (e) {
      console.error('[inventory] DELETE /:id failed:', e.message || e);
      res.status(500).json({ error: e.message || 'delete failed' });
    }
  },
);

// ============================================================
// POST /api/v2/inventory/:id/list  (create listing + adapter dispatch)
// ============================================================
router.post(
  '/api/v2/inventory/:id/list',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    const body = req.body || {};
    const marketplace = body.marketplace;
    if (!marketplace || !VALID_MARKETPLACES.includes(marketplace)) {
      return err400(res, `marketplace must be one of ${VALID_MARKETPLACES.join(', ')}`);
    }
    if (body.ask_eur != null && !Number.isFinite(Number(body.ask_eur))) {
      return err400(res, 'ask_eur must be a number');
    }

    try {
      // Resolve the item first so we can hand it to the adapter.
      const item = await getItem(req.params.id, req.user.id);
      if (!item) return err404(res, 'item not found');

      // Adapter dispatch — soft-fail. Even when the adapter returns
      // not_yet_implemented we still record the listing row so the vendor
      // sees their intent in the UI.
      const adapter = getAdapter(marketplace);
      const ctx = { owner_user_id: req.user.id, shop_id: item.shop_id, env: process.env };
      const adapterResult = adapter
        ? await adapter.listItem(item, body.ask_eur != null ? Number(body.ask_eur) : null, ctx)
        : { ok: false, reason: 'unknown_adapter' };

      const listing = await createListing({
        item_id: item.id,
        owner_user_id: req.user.id,
        marketplace,
        ask_eur: body.ask_eur != null ? Number(body.ask_eur) : null,
        external_url: adapterResult.external_url || body.external_url || null,
        adapterResult,
      });
      if (!listing) return err404(res, 'item not found');

      res.status(201).json({ listing, adapter: adapterResult });
    } catch (e) {
      console.error('[inventory] POST /:id/list failed:', e.message || e);
      res.status(500).json({ error: e.message || 'list failed' });
    }
  },
);

// ============================================================
// PATCH /api/v2/inventory/:id/listings/:listingId  (price change)
// ============================================================
router.patch(
  '/api/v2/inventory/:id/listings/:listingId',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    const body = req.body || {};
    if (body.ask_eur == null && !body.external_url) {
      return err400(res, 'ask_eur or external_url required');
    }
    try {
      const updated = await updateAsk(req.params.listingId, req.user.id, {
        ask_eur: body.ask_eur != null ? Number(body.ask_eur) : null,
        external_url: body.external_url || null,
      });
      if (!updated) return err404(res, 'listing not found');

      // Best-effort marketplace sync.
      const adapter = getAdapter(updated.marketplace);
      let adapterResult = { ok: true };
      if (adapter) {
        adapterResult = await adapter.updateListing(updated.external_url || updated.id, {
          ask_eur: updated.ask_eur,
        }, { owner_user_id: req.user.id, env: process.env });
      }
      res.json({ listing: updated, adapter: adapterResult });
    } catch (e) {
      console.error('[inventory] PATCH listing failed:', e.message || e);
      res.status(500).json({ error: e.message || 'update failed' });
    }
  },
);

// ============================================================
// POST /api/v2/inventory/:id/listings/:listingId/sold
// ============================================================
router.post(
  '/api/v2/inventory/:id/listings/:listingId/sold',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    const body = req.body || {};
    if (body.sold_eur == null || !Number.isFinite(Number(body.sold_eur))) {
      return err400(res, 'sold_eur is required (number)');
    }
    if (body.fees_eur != null && !Number.isFinite(Number(body.fees_eur))) {
      return err400(res, 'fees_eur must be a number');
    }
    try {
      const updated = await markSold(req.params.listingId, req.user.id, {
        sold_eur: Number(body.sold_eur),
        fees_eur: body.fees_eur != null ? Number(body.fees_eur) : 0,
      });
      if (!updated) return err404(res, 'listing not found');
      res.json({ listing: updated });
    } catch (e) {
      console.error('[inventory] POST sold failed:', e.message || e);
      res.status(500).json({ error: e.message || 'sold failed' });
    }
  },
);

// ============================================================
// GET /api/v2/inventory/:id/events
// ============================================================
router.get(
  '/api/v2/inventory/:id/events',
  requireAuth, requirePlan(INVENTORY_PLANS),
  async (req, res) => {
    try {
      const events = await getEventsForItem(req.params.id, req.user.id);
      res.json({ events });
    } catch (e) {
      console.error('[inventory] GET events failed:', e.message || e);
      res.status(500).json({ error: e.message || 'events failed' });
    }
  },
);

export default router;
