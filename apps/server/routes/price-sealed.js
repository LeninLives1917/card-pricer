// apps/server/routes/price-sealed.js
//
// Owner: A1 (route wiring) + A2 (handler) — Slice S17
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §5 F5 (sealed product pricing)
//   - pricing/sealed/price.js (verifyAndPrice — the actual work)
//   - apps/server/middleware/auth.js (requireAuth)
//   - apps/server/middleware/quota.js (enforceQuota)
//
// POST /api/v2/price-sealed
//   Auth: requireAuth + enforceQuota (sealed pricing is a paid feature; it
//         counts against the same scan quota as singles).
//   Body: { sku: string, buyPercentage?: number }
//   Returns: priceSealed envelope (see pricing/sealed/price.js).
//   Errors:
//     400 — sku missing / not a string
//     404 — SKU not in catalog (verify miss)
//     503 — TCGPLAYER_PRO_API_KEY unset (and mock mode off)
//     500 — adapter threw
//
// MOUNT — orchestrator follow-up: in apps/server/index.js add
//   import priceSealedRouter from './routes/price-sealed.js';
//   app.use(priceSealedRouter);   // /api/v2/price-sealed
// Mount it AFTER priceRouter so the V1 /api/price + V2 /api/v2/price-sealed
// keep their adjacent positions in the audit-grep order.

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { enforceQuota } from '../middleware/quota.js';
import { verifyAndPrice, isSealedVerifyAvailable } from '../../../pricing/sealed/price.js';

const router = express.Router();

router.post('/api/v2/price-sealed', requireAuth, enforceQuota, async (req, res) => {
  try {
    const { sku, buyPercentage } = req.body || {};
    if (typeof sku !== 'string' || !sku.trim()) {
      return res.status(400).json({ error: 'sku required' });
    }

    if (!isSealedVerifyAvailable()) {
      return res.status(503).json({
        error: 'sealed_pricing_unavailable',
        message: 'No sealed-pricing adapter is configured. Set TCGPLAYER_PRO_API_KEY (or TCGPLAYER_PRO_MOCK=true for previews).',
      });
    }

    const ctx = { log: req.app?.locals?.log };
    const result = await verifyAndPrice(sku, ctx, { buyPercentage });

    if (!result) {
      return res.status(404).json({ error: 'sku_not_found', sku });
    }

    return res.json(result);
  } catch (e) {
    console.error('[price-sealed]', e?.message || e);
    return res.status(500).json({ error: 'sealed_pricing_failed', details: e?.message || String(e) });
  }
});

export default router;
