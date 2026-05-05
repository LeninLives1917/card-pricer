// apps/server/routes/quote-recover.js
// Owner: A1 + A5 | Slice: S12 (Quote persistence — F6).
//
// Read-side companion to /api/quote-lead. Slice S5 already persists every
// successful quote into public.quote_leads (uuid PK). S12 exposes that row
// back via two public, anonymous endpoints so a customer can revisit their
// quote from a stable URL — and the shop owner can share it.
//
//   GET /api/v2/quote/:id  → sanitised JSON (no PII).
//   GET /q/:id             → 302 → /quote#recover=<id> (the existing
//                             apps/quote shell renders the saved quote;
//                             we don't duplicate templates here).
//
// Both routes are anonymous reads — no requireAuth, no quoteLeadLimiter
// (the limiter exists to throttle write floods; reads are cheap and
// idempotent). The id IS the capability, so we validate uuid shape
// strictly to stop /api/v2/quote/'..' style probes.
//
// ORCHESTRATOR FOLLOW-UP (S12 wiring):
//   apps/server/index.js must `import quoteRecoverRouter from
//   './routes/quote-recover.js';` and mount it via
//   `app.use(quoteRecoverRouter);` BEFORE `app.use(staticRoutes.spaFallback)`.
//   The /q/:id route is a non-/api path, so the SPA wildcard would
//   otherwise eat it. Mount line — drop next to the other routers
//   (after quoteLeadRouter is fine):
//
//     import quoteRecoverRouter from './routes/quote-recover.js';
//     app.use(quoteRecoverRouter);   // GET /api/v2/quote/:id, GET /q/:id

import express from 'express';
import { supabase as defaultSupabase } from '../_clients.js';

const router = express.Router();

// RFC 4122 uuid (any version). The DB column is `uuid` so the format is
// fixed. We validate before hitting Postgres so malformed ids 400/404
// without a round trip.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Handler for GET /api/v2/quote/:id, factored out so tests can call it
// directly with an injected fake supabase (keeps the spec independent of
// _clients.js's env-dependent singleton).
export function makeRecoverJsonHandler(sb) {
  return async function recoverJson(req, res) {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(400).json({ error: 'invalid quote id' });
    }
    if (!sb) {
      // Without service-role credentials we can't read quote_leads at all.
      // 503 (not 500) — this is a configuration condition, not a bug.
      return res.status(503).json({ error: 'quote persistence unavailable' });
    }
    try {
      const { data, error } = await sb
        .from('quote_leads')
        .select('id, shop_id, shop_slug, card_count, total_market, total_cash, total_credit, cards_json, created_at')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        console.warn('[QUOTE-RECOVER] supabase error:', error.message);
        return res.status(500).json({ error: 'lookup failed' });
      }
      if (!data) {
        return res.status(404).json({ error: 'quote not found' });
      }

      // Optional shop name — best-effort second lookup. Tolerate missing.
      let shop_name = null;
      if (data.shop_id) {
        try {
          const { data: shop } = await sb
            .from('shops')
            .select('name')
            .eq('id', data.shop_id)
            .maybeSingle();
          if (shop?.name) shop_name = shop.name;
        } catch {
          // Non-fatal — just omit shop_name.
        }
      }

      return res.json({
        id: data.id,
        shop_slug: data.shop_slug || null,
        shop_name,
        created_at: data.created_at,
        card_count: data.card_count,
        totals: {
          market: Number(data.total_market) || 0,
          cash: Number(data.total_cash) || 0,
          credit: Number(data.total_credit) || 0,
        },
        cards: Array.isArray(data.cards_json) ? data.cards_json : [],
      });
    } catch (e) {
      console.error('[QUOTE-RECOVER] failed:', e);
      return res.status(500).json({ error: 'lookup failed' });
    }
  };
}

// Handler for GET /q/:id. No supabase dependency — pure validation +
// redirect, but exported for test parity with the JSON handler.
export function recoverHtmlHandler(req, res) {
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(404).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>Quote not found</title>' +
      '<body style="font-family:system-ui;padding:32px;color:#222;">' +
      '<h1>Quote not found</h1>' +
      '<p>That link doesn\'t look right. Try the link from your email, or ' +
      '<a href="/quote">start a new quote</a>.</p>' +
      '</body>'
    );
    return;
  }
  // 302 (not 301) so the link can be invalidated later if we ever add
  // expiry without browsers caching the redirect forever.
  res.redirect(302, `/quote#recover=${encodeURIComponent(id)}`);
}

// Production wiring uses the singleton supabase client. Tests instead
// build their own router with a seeded fake — see tests/helpers/setup.js.
router.get('/api/v2/quote/:id', makeRecoverJsonHandler(defaultSupabase));
router.get('/q/:id', recoverHtmlHandler);

export default router;
