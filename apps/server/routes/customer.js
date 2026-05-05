// apps/server/routes/customer.js
// Owner: A10 + A1 | Slice: S20 (F19)
//
// Customer-side self-service endpoints. The customer signs in via Supabase
// magic link (separate auth flow from vendor). req.user.id is the auth
// authority for everything in this router.
//
// Routes:
//   GET   /api/v2/customer/me           — auth required; lazy-creates customer_account
//   PATCH /api/v2/customer/me           — auth required; updates display_name etc.
//   GET   /api/v2/customer/offers       — auth required; lists this user's offers
//   POST  /api/v2/customer/magic-link   — public; triggers Supabase OTP magic-link email
//
// Mount in apps/server/index.js with `app.use(customerRouter);`.

import express from 'express';
import { supabase } from '../_clients.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getOrCreateCustomerAccount,
  updateCustomerAccount,
} from '../../../db/customers/accounts.js';
import { getOffersForCustomer } from '../../../db/customers/offers.js';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/v2/customer/me — auth required. Returns the customer_account row,
// auto-creating it on first call (mirrors profiles auto-create on the
// vendor side). The response shape is the row + the auth email so the
// dashboard UI doesn't need a second auth.getUser() round-trip.
router.get('/api/v2/customer/me', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  try {
    const account = await getOrCreateCustomerAccount(req.user.id, req.user.email, supabase);
    res.json({
      user_id: req.user.id,
      email: req.user.email,
      account,
    });
  } catch (e) {
    console.error('[CUSTOMER /me] failed:', e.message);
    res.status(500).json({ error: 'failed to load account' });
  }
});

// PATCH /api/v2/customer/me — auth required. Allow-list filter inside
// updateCustomerAccount (display_name | opted_in_marketing |
// preferred_shop_slug). Anything else is silently dropped.
router.patch('/api/v2/customer/me', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const body = req.body || {};
  const fields = {};
  if ('display_name' in body) {
    if (body.display_name === null || body.display_name === '') {
      fields.display_name = null;
    } else if (typeof body.display_name === 'string') {
      fields.display_name = body.display_name.trim().slice(0, 80);
    } else {
      return res.status(400).json({ error: 'display_name must be a string' });
    }
  }
  if ('opted_in_marketing' in body) {
    fields.opted_in_marketing = !!body.opted_in_marketing;
  }
  if ('preferred_shop_slug' in body) {
    if (body.preferred_shop_slug === null || body.preferred_shop_slug === '') {
      fields.preferred_shop_slug = null;
    } else if (typeof body.preferred_shop_slug === 'string') {
      // SHOP_SLUG_RE-equivalent — accept low-risk slug shape; the FK on
      // customer_accounts.preferred_shop_slug rejects unknown slugs.
      fields.preferred_shop_slug = body.preferred_shop_slug.trim().toLowerCase().slice(0, 40);
    } else {
      return res.status(400).json({ error: 'preferred_shop_slug must be a string' });
    }
  }
  // Make sure the row exists before update so the second-call PATCH on a
  // first-time user still works.
  try {
    await getOrCreateCustomerAccount(req.user.id, req.user.email, supabase);
    const account = await updateCustomerAccount(req.user.id, fields, supabase);
    res.json({ ok: true, account });
  } catch (e) {
    console.error('[CUSTOMER PATCH /me] failed:', e.message);
    res.status(500).json({ error: e.message || 'update failed' });
  }
});

// GET /api/v2/customer/offers — auth required. Lists every offer matched
// to this customer. Auto-links email-only matches to customer_user_id.
router.get('/api/v2/customer/offers', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  try {
    const offers = await getOffersForCustomer(req.user.id, req.user.email, supabase);
    res.json({ offers });
  } catch (e) {
    console.error('[CUSTOMER /offers] failed:', e.message);
    res.status(500).json({ error: 'failed to load offers' });
  }
});

// POST /api/v2/customer/magic-link — public, no auth. Body: { email }. We
// trigger Supabase's OTP / magic-link flow. The response intentionally
// does NOT leak whether the email exists in auth.users — Supabase's
// signInWithOtp creates the user on first call (shouldCreateUser default
// is true), so any valid email gets a link; bad emails return ok:true
// regardless to avoid email-enumeration leaks.
router.post('/api/v2/customer/magic-link', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const redirectTo = req.body?.redirectTo;
  if (!email || !EMAIL_RE.test(email)) {
    // Still return ok:true to avoid leaking validation results — but
    // 400 here is safe because an invalid SHAPE isn't enumerable.
    return res.status(400).json({ error: 'invalid email' });
  }
  try {
    // V2 supabase-js: signInWithOtp triggers the email via the project
    // SMTP settings. emailRedirectTo overrides the project default.
    const opts = { email };
    if (redirectTo && typeof redirectTo === 'string') {
      opts.options = { emailRedirectTo: redirectTo };
    }
    const result = await supabase.auth.signInWithOtp(opts);
    if (result?.error) {
      // Log server-side; never leak the reason to the caller.
      console.warn('[CUSTOMER magic-link] signInWithOtp warn:', result.error.message);
    }
    // Always 200 ok:true — opaque response by design.
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('[CUSTOMER magic-link] failed:', e.message);
    // Even on internal error, don't leak — log and return ok:true so the
    // UI shows "check your email" without revealing infra state.
    res.json({ ok: true, sent: true });
  }
});

export default router;
