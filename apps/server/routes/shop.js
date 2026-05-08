// apps/server/routes/shop.js
// Owner: A1 | Slice: S5
//
// Routes (V1 server.js:5188-5267, 5547-5713):
//   GET   /api/shop-config/:slug   — public, sanitised, 5-min in-memory + 60s Cache-Control
//   GET   /api/shop                — requireAuth
//   POST  /api/shop                — requireAuth + requirePlan(SHOP_PLANS)
//   PATCH /api/shop                — requireAuth + requirePlan(SHOP_PLANS)
//
// V2_AUDIT §5.20: shop slug rename invalidates BOTH the old AND new slug
// entries in shopConfigCache.
//
// shopConfigCache is exported so quote-lead.js can reuse the cache primitive
// when shops mutate their settings out-of-band (preserved from V1).

import express from 'express';
import { supabase } from '../_clients.js';
import { requireAuth, requirePlan } from '../middleware/auth.js';

const router = express.Router();

export const SHOP_SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const shopConfigCache = new Map();
const SHOP_CONFIG_TTL_MS = 5 * 60 * 1000;

export function invalidateShopConfig(slug) {
  if (slug) shopConfigCache.delete(String(slug).toLowerCase());
}

// V1 server.js:5555 — embed widget is gated to ['shop','beta'].
const SHOP_PLANS = ['shop', 'beta'];

const NEWSLETTER_PROVIDERS = ['brevo', 'mailchimp', 'convertkit', 'off'];

function validateShopPayload(body, { partial }) {
  const errs = [];
  const out = {};
  const {
    slug, name, email, logo_url, accent_color, cash_pct, credit_pct,
    brevo_list_id, active,
    newsletter_provider, newsletter_show,
    mailchimp_api_key, mailchimp_list_id,
    convertkit_api_key, convertkit_form_id
  } = body || {};

  if (slug !== undefined) {
    const s = String(slug).toLowerCase();
    if (!SHOP_SLUG_RE.test(s) || s.length < 3 || s.length > 40) errs.push('invalid slug (3-40 chars, a-z 0-9 -, no leading/trailing dash)');
    else out.slug = s;
  } else if (!partial) errs.push('slug required');

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) errs.push('name required');
    else out.name = name.trim().slice(0, 80);
  } else if (!partial) errs.push('name required');

  if (email !== undefined) {
    if (!EMAIL_RE.test(email)) errs.push('invalid email');
    else out.email = email.trim().toLowerCase();
  } else if (!partial) errs.push('email required');

  if (logo_url !== undefined) {
    if (logo_url === null || logo_url === '') out.logo_url = null;
    else if (typeof logo_url !== 'string' || !/^https?:\/\//i.test(logo_url)) errs.push('logo_url must be a http(s) URL');
    else out.logo_url = logo_url.slice(0, 500);
  }

  if (accent_color !== undefined) {
    if (!HEX_COLOR_RE.test(accent_color)) errs.push('accent_color must be #RRGGBB hex');
    else out.accent_color = accent_color;
  }

  if (cash_pct !== undefined) {
    const n = parseInt(cash_pct, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) errs.push('cash_pct must be 1-100');
    else out.cash_pct = n;
  }

  if (credit_pct !== undefined) {
    const n = parseInt(credit_pct, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) errs.push('credit_pct must be 1-100');
    else out.credit_pct = n;
  }

  if (brevo_list_id !== undefined) {
    if (brevo_list_id === null || brevo_list_id === '') out.brevo_list_id = null;
    else {
      const n = parseInt(brevo_list_id, 10);
      if (!Number.isFinite(n) || n < 1) errs.push('brevo_list_id must be a positive integer');
      else out.brevo_list_id = n;
    }
  }

  if (active !== undefined) out.active = !!active;

  if (newsletter_provider !== undefined) {
    if (!NEWSLETTER_PROVIDERS.includes(newsletter_provider)) {
      errs.push('newsletter_provider must be one of: ' + NEWSLETTER_PROVIDERS.join(', '));
    } else {
      out.newsletter_provider = newsletter_provider;
    }
  }

  if (newsletter_show !== undefined) out.newsletter_show = !!newsletter_show;

  for (const [k, v] of [
    ['mailchimp_api_key', mailchimp_api_key],
    ['mailchimp_list_id', mailchimp_list_id],
    ['convertkit_api_key', convertkit_api_key],
    ['convertkit_form_id', convertkit_form_id]
  ]) {
    if (v === undefined) continue;
    if (v === null || v === '') { out[k] = null; continue; }
    if (typeof v !== 'string') { errs.push(`${k} must be a string`); continue; }
    out[k] = v.trim().slice(0, 200);
  }

  return { errs, out };
}

router.get('/api/shop-config/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!SHOP_SLUG_RE.test(slug) || slug.length > 40) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  const cached = shopConfigCache.get(slug);
  if (cached && cached.expires > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(cached.value);
  }
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  try {
    const { data } = await supabase
      .from('shops')
      .select('slug,name,logo_url,accent_color,cash_pct,credit_pct,active,newsletter_show')
      .eq('slug', slug).eq('active', true).maybeSingle();
    if (!data) return res.status(404).json({ error: 'shop not found' });
    shopConfigCache.set(slug, { value: data, expires: Date.now() + SHOP_CONFIG_TTL_MS });
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (e) {
    console.error('[SHOP-CONFIG]', e.message);
    res.status(500).json({ error: 'lookup failed' });
  }
});

router.get('/api/shop', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  try {
    const { data } = await supabase.from('shops').select('*').eq('owner_user_id', req.user.id).maybeSingle();
    res.json(data || null);
  } catch (e) {
    console.error('[GET /api/shop]', e.message);
    res.status(500).json({ error: 'lookup failed' });
  }
});

/**
 * Core handler for POST /api/shop. Exported for unit-testing with injected deps.
 *
 * @param {object} body              — req.body fields
 * @param {string} ownerUserId       — req.user.id (already auth-gated by caller)
 * @param {object} deps
 * @param {object|null} deps.supabaseClient — Supabase client (or null)
 * @returns {{ status: number, body: object }}
 */
export async function handleCreateShop(body, ownerUserId, deps = {}) {
  const { supabaseClient = supabase } = deps;
  if (!supabaseClient) return { status: 503, body: { error: 'unavailable' } };
  const { errs, out } = validateShopPayload(body, { partial: false });
  if (errs.length) return { status: 400, body: { error: errs.join('; ') } };
  try {
    const { data, error } = await supabaseClient.from('shops').insert({
      owner_user_id: ownerUserId,
      ...out
    }).select().maybeSingle();
    if (error) {
      if (error.code === '23505') {
        const detail = String(error.message || '').toLowerCase();
        if (detail.includes('owner_user_id')) return { status: 409, body: { error: 'you already have a shop — use PATCH /api/shop to update' } };
        return { status: 409, body: { error: 'slug already taken' } };
      }
      return { status: 500, body: { error: error.message } };
    }
    invalidateShopConfig(out.slug);
    return { status: 200, body: data };
  } catch (e) {
    console.error('[POST /api/shop]', e.message);
    return { status: 500, body: { error: 'create failed' } };
  }
}

router.post('/api/shop', requireAuth, requirePlan(SHOP_PLANS), async (req, res) => {
  const { status, body } = await handleCreateShop(req.body, req.user.id);
  res.status(status).json(body);
});

/**
 * Core handler for PATCH /api/shop. Exported for unit-testing with injected deps.
 *
 * @param {object} body              — req.body fields
 * @param {string} ownerUserId       — req.user.id (already auth-gated by caller)
 * @param {object} deps
 * @param {object|null} deps.supabaseClient       — Supabase client (or null)
 * @param {function}    deps.invalidateShopConfig — cache-bust fn (injectable for tests)
 * @returns {{ status: number, body: object }}
 */
export async function handleUpdateShop(body, ownerUserId, deps = {}) {
  const { supabaseClient = supabase, invalidateShopConfig: invalidate = invalidateShopConfig } = deps;
  if (!supabaseClient) return { status: 503, body: { error: 'unavailable' } };
  const { errs, out } = validateShopPayload(body, { partial: true });
  if (errs.length) return { status: 400, body: { error: errs.join('; ') } };
  if (!Object.keys(out).length) return { status: 400, body: { error: 'no fields to update' } };
  try {
    const { data: existing } = await supabaseClient.from('shops').select('slug').eq('owner_user_id', ownerUserId).maybeSingle();
    const { data, error } = await supabaseClient
      .from('shops')
      .update(out)
      .eq('owner_user_id', ownerUserId)
      .select()
      .maybeSingle();
    if (error) {
      if (error.code === '23505') return { status: 409, body: { error: 'slug already taken' } };
      return { status: 400, body: { error: error.message } };
    }
    if (!data) return { status: 404, body: { error: 'no shop to update — POST /api/shop first' } };
    if (existing?.slug) invalidate(existing.slug);
    if (data.slug) invalidate(data.slug);
    return { status: 200, body: data };
  } catch (e) {
    console.error('[PATCH /api/shop]', e.message);
    return { status: 500, body: { error: 'update failed' } };
  }
}

router.patch('/api/shop', requireAuth, requirePlan(SHOP_PLANS), async (req, res) => {
  const { status, body } = await handleUpdateShop(req.body, req.user.id);
  res.status(status).json(body);
});

export default router;
