// apps/server/routes/quote-offer.js
// Owner: A10 + A1 | Slice: S20 (F19)
//
// Tokenised offer create / accept / decline. The shop creates an offer
// (auth required, ownership-checked); the customer accepts or declines
// via the public token URL — no Supabase login required, the token IS
// the auth.
//
// Routes:
//   POST  /api/v2/quote-offer                  — auth required (shop owner) → create
//   GET   /api/v2/quote-offer                  — auth required (shop) → list shop's offers
//   GET   /api/v2/quote-offer/:token           — public, sanitised (no email)
//   POST  /api/v2/quote-offer/:token/accept    — public; flips status='accepted'
//   POST  /api/v2/quote-offer/:token/decline   — public; flips status='declined'
//
// Mount in apps/server/index.js with `app.use(quoteOfferRouter);`.
//
// Brevo notify pattern is preserved from routes/quote-lead.js — fire-and-
// forget on accept; an outage cannot block the status flip.

import express from 'express';
import { supabase } from '../_clients.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createOffer,
  getOfferByToken,
  getOffersForShop,
  acceptOffer,
  declineOffer,
} from '../../../db/customers/offers.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Resolve the shop the auth'd user owns. Customer accounts share auth.users
// with vendors, so a request might be auth'd but not own a shop. Returns
// null for the latter case so the route can 403.
async function resolveOwnerShop(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('shops')
    .select('id, slug, name, email, logo_url')
    .eq('owner_user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[QUOTE-OFFER] shop lookup failed:', error.message);
    return null;
  }
  return data ?? null;
}

// Sanitised public projection — never includes customer_email or any PII.
function publicOfferShape(offer, shop) {
  if (!offer) return null;
  return {
    id: offer.id,
    status: offer.status,
    line_items: offer.line_items,
    total_eur: offer.total_eur,
    currency: offer.currency,
    expires_at: offer.expires_at,
    accepted_at: offer.accepted_at,
    declined_at: offer.declined_at,
    created_at: offer.created_at,
    shop: shop
      ? { name: shop.name, slug: shop.slug, logo_url: shop.logo_url || null }
      : null,
  };
}

// POST /api/v2/quote-offer — auth required (shop owner). Body: {
//   lead_id?, customer_email, line_items, total_eur, currency?, expires_at?
// }. We derive shop_id from req.user.id so a vendor cannot create offers
// against another shop's tenant.
router.post('/api/v2/quote-offer', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const shop = await resolveOwnerShop(req.user.id);
  if (!shop) return res.status(403).json({ error: 'no shop owned by this user' });

  const { lead_id, customer_email, line_items, total_eur, currency, expires_at } = req.body || {};
  if (!customer_email || !EMAIL_RE.test(customer_email)) {
    return res.status(400).json({ error: 'invalid customer_email' });
  }
  if (!Array.isArray(line_items) || !line_items.length) {
    return res.status(400).json({ error: 'line_items must be a non-empty array' });
  }
  const totalNum = typeof total_eur === 'number' ? total_eur : parseFloat(total_eur);
  if (!Number.isFinite(totalNum) || totalNum < 0) {
    return res.status(400).json({ error: 'total_eur must be a non-negative number' });
  }

  try {
    const offer = await createOffer(
      {
        shop_id: shop.id,
        lead_id: lead_id || null,
        customer_email: String(customer_email).toLowerCase(),
        line_items: line_items.slice(0, 100),
        total_eur: totalNum,
        currency: currency || 'EUR',
        expires_at: expires_at || undefined,
      },
      supabase,
    );
    // Build the customer-facing accept URL so the caller can include it
    // in their own emails or copy-link UI.
    const proto = req.protocol || 'https';
    const host = req.get('host');
    const accept_url = host ? `${proto}://${host}/o/${offer.accept_token}` : null;
    res.json({ ok: true, offer, accept_url });
  } catch (e) {
    console.error('[QUOTE-OFFER POST] failed:', e.message);
    res.status(500).json({ error: e.message || 'offer creation failed' });
  }
});

// GET /api/v2/quote-offer — auth required (shop). Lists offers for the
// requester's shop, newest first.
router.get('/api/v2/quote-offer', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const shop = await resolveOwnerShop(req.user.id);
  if (!shop) return res.status(403).json({ error: 'no shop owned by this user' });
  try {
    const offers = await getOffersForShop(shop.id, supabase);
    res.json({ offers });
  } catch (e) {
    console.error('[QUOTE-OFFER GET list] failed:', e.message);
    res.status(500).json({ error: 'failed to load offers' });
  }
});

// GET /api/v2/quote-offer/:token — PUBLIC. Sanitised projection only.
// 404 if token unknown. Returns the canonical status (with auto-expired
// flip) so the customer UI doesn't need to compute it.
router.get('/api/v2/quote-offer/:token', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const offer = await getOfferByToken(token, supabase);
    if (!offer) return res.status(404).json({ error: 'offer not found' });
    // Look up shop name/logo for the public projection. Tolerates a missing
    // shop row (shop_id is set null on shop deletion per the migration).
    let shop = null;
    if (offer.shop_id) {
      const { data } = await supabase
        .from('shops')
        .select('name, slug, logo_url')
        .eq('id', offer.shop_id)
        .maybeSingle();
      shop = data ?? null;
    }
    res.json(publicOfferShape(offer, shop));
  } catch (e) {
    console.error('[QUOTE-OFFER GET token] failed:', e.message);
    res.status(500).json({ error: 'failed to load offer' });
  }
});

// Brevo notify on accept — fire-and-forget. Mirrors routes/quote-lead.js
// pattern: a notify failure must not roll back the status flip.
async function notifyShopOnAccept(offer) {
  if (!process.env.BREVO_API_KEY) return;
  if (!offer?.shop_id) return;
  try {
    const { data: shop } = await supabase
      .from('shops').select('name, email').eq('id', offer.shop_id).maybeSingle();
    if (!shop?.email) return;
    const SHOP_NAME = shop.name || 'Card Shop';
    const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || shop.email;
    const html = `
      <div style="font-family:sans-serif;">
        <h3>Offer accepted</h3>
        <p><b>Customer:</b> ${escapeHtml(offer.customer_email)}</p>
        <p><b>Total:</b> €${Number(offer.total_eur || 0).toFixed(2)} ${escapeHtml(offer.currency || 'EUR')}</p>
        <p><b>Items:</b> ${Array.isArray(offer.line_items) ? offer.line_items.length : 0}</p>
        <p style="color:#888; font-size:12px;">Accepted at ${escapeHtml(offer.accepted_at || '')}</p>
      </div>`;
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: SHOP_NAME, email: SENDER_EMAIL },
        to: [{ email: shop.email }],
        subject: `Offer accepted — ${offer.customer_email}`,
        htmlContent: html,
      }),
    });
  } catch (e) {
    console.warn('[QUOTE-OFFER] brevo notify failed:', e.message);
  }
}

// Optional: identify a logged-in customer at accept/decline time. We
// don't require auth — token is the gate — but if a Bearer token is
// present we associate the offer with that user_id.
async function maybeUserId(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const { data } = await supabase.auth.getUser(authHeader.slice(7));
    return data?.user?.id || null;
  } catch { return null; }
}

// POST /api/v2/quote-offer/:token/accept — public.
router.post('/api/v2/quote-offer/:token/accept', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    // Pre-flight: classify the failure mode (expired vs already-accepted
    // vs not-found) so the response is meaningful. acceptOffer() returns
    // null for any non-'open' state.
    const existing = await getOfferByToken(token, supabase);
    if (!existing) return res.status(404).json({ error: 'offer not found' });
    if (existing.status === 'expired') return res.status(410).json({ error: 'offer expired' });
    if (existing.status === 'accepted') return res.status(409).json({ error: 'offer already accepted' });
    if (existing.status === 'declined') return res.status(409).json({ error: 'offer already declined' });

    const customer_user_id = await maybeUserId(req);
    const updated = await acceptOffer(token, { customer_user_id }, supabase);
    if (!updated) return res.status(409).json({ error: 'offer no longer acceptable' });

    // Fire-and-forget notify.
    notifyShopOnAccept(updated).catch(() => {});
    res.json({ ok: true, offer: publicOfferShape(updated, null) });
  } catch (e) {
    console.error('[QUOTE-OFFER accept] failed:', e.message);
    res.status(500).json({ error: 'accept failed' });
  }
});

// POST /api/v2/quote-offer/:token/decline — public.
router.post('/api/v2/quote-offer/:token/decline', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const existing = await getOfferByToken(token, supabase);
    if (!existing) return res.status(404).json({ error: 'offer not found' });
    if (existing.status === 'expired') return res.status(410).json({ error: 'offer expired' });
    if (existing.status === 'accepted') return res.status(409).json({ error: 'offer already accepted' });
    if (existing.status === 'declined') return res.status(409).json({ error: 'offer already declined' });

    const customer_user_id = await maybeUserId(req);
    const updated = await declineOffer(token, { customer_user_id }, supabase);
    if (!updated) return res.status(409).json({ error: 'offer no longer declinable' });
    res.json({ ok: true, offer: publicOfferShape(updated, null) });
  } catch (e) {
    console.error('[QUOTE-OFFER decline] failed:', e.message);
    res.status(500).json({ error: 'decline failed' });
  }
});

export default router;
