import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
// Render puts us behind its edge proxy; without this, every request appears
// to come from the proxy IP and per-IP rate limits would collapse into one bucket.
app.set('trust proxy', 1);
app.use(cors());
// Preserve raw request body for the Stripe webhook path so we can verify
// signatures. Other routes still get the parsed JSON via req.body.
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/stripe-webhook')) {
      req.rawBody = buf;
    }
  }
}));

// ============================================================
// RATE LIMITS — protect paid upstreams (Anthropic, Brevo) from abuse
// ============================================================
// Scanning endpoints: generous enough for a real card-show session (you can
// easily scan 1/sec for minutes), but capped so a script-kiddie can't drain
// the Anthropic budget in an afternoon.
const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many identify requests — slow down.' }
});
// Quote-lead triggers Brevo emails. Much lower cap because a single abuser
// spamming this drains email-send quota and could mark the domain as spammy.
const quoteLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests — please try again later.' }
});

// ============================================================
// SUPABASE — auth + user data (Phase B)
// ============================================================
// Service-role client: used to verify user JWTs passed by the client and
// to insert server-owned rows (scan_events). Bypasses RLS, so it MUST
// stay server-only. Never exposed to the browser.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseServiceKey)
  ? createSupabaseClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;
if (!supabase) {
  console.warn('[AUTH] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — auth is disabled. Protected routes will reject all requests.');
}

// requireAuth middleware: reads the client-sent JWT from Authorization
// header, verifies via Supabase, attaches req.user. Used on every paid-
// upstream endpoint so free/anonymous abuse isn't possible.
async function requireAuth(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'auth service unavailable' });
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'auth required' });
  }
  const token = authHeader.slice(7);
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
    req.user = data.user;
    next();
  } catch (e) {
    console.error('[AUTH] getUser failed:', e.message);
    res.status(401).json({ error: 'auth check failed' });
  }
}

// Fire-and-forget scan logging. Phase C uses this to enforce monthly
// quotas for free-plan users. Failure to log must NEVER block a scan.
function logScanEvent(userId, endpoint) {
  if (!supabase || !userId) return;
  supabase.from('scan_events').insert({ user_id: userId, endpoint }).then(
    () => {},
    (e) => console.warn('[AUTH] scan_events insert failed:', e?.message || e)
  );
}

// ============================================================
// PLAN QUOTA (Phase C)
// ============================================================
// Monthly scan caps by plan. `null` = unlimited. Change these numbers
// here and the /api/usage endpoint + enforceQuota middleware pick them
// up automatically. Beta plan exists so the closed-beta testers aren't
// capped while we iterate.
const PLAN_LIMITS = {
  'beta':   null,  // closed-beta testers — unmetered
  'free':   40,    // public free tier (onboarding)
  'solo':   100,   // €9/mo or €81/yr — small booth / solo dealer
  'vendor': 500,   // €29/mo or €261/yr — regular show vendor
  'shop':   null   // €59/mo or €531/yr — unlimited, physical shops
};

// Query the user's scan count for the current calendar month (UTC).
// Returns { plan, used, limit } — limit null = unlimited.
async function getUsage(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  const plan = profile?.plan || 'free';
  const limit = PLAN_LIMITS[plan] ?? null;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Only count identify-ish endpoints — /api/price doesn't log events,
  // so count(*) on scan_events is roughly "one per scanned card".
  const { count } = await supabase
    .from('scan_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('ts', monthStart.toISOString());
  return { plan, used: count || 0, limit, resetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() };
}

// Gate middleware: chain after requireAuth on the identify endpoints.
// Rejects with 429 if the user is at/over their plan limit. Fails OPEN
// on DB errors so a Supabase blip can't take down the scanner at a show.
async function enforceQuota(req, res, next) {
  if (!supabase || !req.user) return next();
  try {
    const usage = await getUsage(req.user.id);
    if (usage.limit != null && usage.used >= usage.limit) {
      return res.status(429).json({
        error: 'scan_quota_exceeded',
        plan: usage.plan,
        used: usage.used,
        limit: usage.limit,
        resetAt: usage.resetAt,
        message: `You've used all ${usage.limit} scans on your ${usage.plan} plan this month. Upgrade to continue.`
      });
    }
    req.scanUsage = usage;
    // Surface usage on every protected response — the client reads these
    // to render the usage banner without making a second round-trip.
    res.setHeader('X-Scan-Plan', usage.plan);
    res.setHeader('X-Scan-Used', String(usage.used));
    if (usage.limit != null) res.setHeader('X-Scan-Limit', String(usage.limit));
    next();
  } catch (e) {
    console.warn('[QUOTA] check failed — allowing through:', e.message);
    next();
  }
}

// Usage endpoint for the client's settings/banner display.
// GET /api/usage → { plan, used, limit, resetAt }
// eslint-disable-next-line no-undef — declaration order is fine because app has already been created
app.get('/api/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getUsage(req.user.id);
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ADMIN ENDPOINTS (Phase E)
// ============================================================
// requireAdmin chains after requireAuth and checks profiles.is_admin.
// Kept dead-simple for now — single flag, no roles. Flip a user's
// is_admin column to true in Supabase to grant access.
async function requireAdmin(req, res, next) {
  if (!supabase || !req.user) return res.status(401).json({ error: 'auth required' });
  try {
    const { data: profile, error } = await supabase
      .from('profiles').select('is_admin').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!profile?.is_admin) return res.status(403).json({ error: 'admin only' });
    next();
  } catch (e) {
    console.error('[ADMIN] requireAdmin failed:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// Monthly-equivalent euros for each plan + interval. Yearly normalised
// to /12 so the MRR total is the "monthly run-rate" view finance cares
// about. Matches the live Stripe prices — update these if pricing changes.
const PLAN_MRR = {
  'solo':   { monthly: 9,  yearly: 81  / 12 },
  'vendor': { monthly: 29, yearly: 261 / 12 },
  'shop':   { monthly: 59, yearly: 531 / 12 }
};

// POST /api/welcome-email — fire-and-forget Brevo welcome message after
// a new signup. Safe to call more than once (idempotent-ish: Brevo will
// just send again; we don't log sent state for MVP). Silently no-ops
// when BREVO_API_KEY is missing so local/preview deploys still work.
app.post('/api/welcome-email', requireAuth, async (req, res) => {
  if (!process.env.BREVO_API_KEY) {
    return res.json({ ok: false, note: 'Brevo not configured — skipping welcome email.' });
  }
  const email = req.user.email;
  if (!email) return res.status(400).json({ error: 'user has no email on record' });

  const SHOP_NAME = process.env.SHOP_NAME || 'Card Pricer';
  const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || process.env.SHOP_EMAIL || 'no-reply@cardpricer.app';
  const APP_URL = `${req.protocol}://${req.get('host')}/`;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif; max-width:560px; margin:0 auto; padding:24px; color:#1a1a1a;">
      <h2 style="font-size:24px; margin:0 0 8px; color:#6c5ce7;">Welcome to Card Pricer 👋</h2>
      <p style="font-size:15px; line-height:1.5; color:#444; margin:0 0 20px;">
        Glad you're here. You're on the <b>beta</b> plan — unmetered while we iterate. Here's how to get scanning in under a minute:
      </p>
      <ol style="font-size:14px; line-height:1.7; color:#333; padding-left:20px;">
        <li><b>Open the app on your laptop</b> and sign in.</li>
        <li><b>Go to Settings → Pair Phone (QR)</b> → tap <b>Host (show QR)</b>.</li>
        <li><b>Scan the QR with your phone's camera</b>. Your phone becomes a dedicated scanner — every photo lands instantly on the laptop, priced and ready.</li>
      </ol>
      <p style="margin:24px 0;">
        <a href="${APP_URL}" style="display:inline-block; padding:12px 20px; background:#6c5ce7; color:white; text-decoration:none; border-radius:8px; font-weight:700;">Open the app</a>
      </p>
      <p style="font-size:13px; color:#666; line-height:1.5;">
        Questions or bugs? Just reply to this email — it comes straight to us.
      </p>
      <p style="font-size:12px; color:#888; margin-top:32px; border-top:1px solid #eee; padding-top:12px;">
        ${SHOP_NAME}
      </p>
    </div>
  `;

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: SHOP_NAME, email: SENDER_EMAIL },
        to: [{ email }],
        subject: 'Welcome to Card Pricer',
        htmlContent: html
      })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error('Brevo ' + r.status + ': ' + t.slice(0, 200));
    }
    res.json({ ok: true });
  } catch (e) {
    console.warn('[WELCOME] send failed:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/me — client uses this to know the current user's email, plan,
// and is_admin flag (to decide whether to show the Admin tab).
app.get('/api/me', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'auth unavailable' });
  try {
    const { data: profile } = await supabase
      .from('profiles').select('plan, plan_interval, is_admin').eq('user_id', req.user.id).maybeSingle();
    res.json({
      user_id: req.user.id,
      email: req.user.email,
      plan: profile?.plan || 'free',
      plan_interval: profile?.plan_interval || null,
      is_admin: !!profile?.is_admin
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/overview — aggregate stats for the admin dashboard.
app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Plan breakdown + MRR
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('plan, plan_interval, stripe_subscription_id, created_at');
    if (pErr) throw pErr;

    const planCounts = { free: 0, beta: 0, solo: 0, vendor: 0, shop: 0 };
    let mrr = 0;
    let activePaid = 0;
    for (const p of profiles || []) {
      const plan = p.plan || 'free';
      if (planCounts[plan] != null) planCounts[plan]++;
      const mrrTable = PLAN_MRR[plan];
      if (mrrTable && p.stripe_subscription_id) {
        const interval = p.plan_interval || 'monthly';
        mrr += mrrTable[interval] || mrrTable.monthly;
        activePaid++;
      }
    }

    // Scans this calendar month
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const { count: scansThisMonth } = await supabase
      .from('scan_events')
      .select('*', { count: 'exact', head: true })
      .gte('ts', monthStart.toISOString());

    // Signups last 30 days (rough funnel proxy)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const signupsLast30 = (profiles || []).filter(p => p.created_at >= thirtyDaysAgo).length;

    res.json({
      user_count: profiles?.length || 0,
      active_paid: activePaid,
      plan_counts: planCounts,
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      scans_this_month: scansThisMonth || 0,
      signups_last_30: signupsLast30
    });
  } catch (e) {
    console.error('[ADMIN] overview failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/users — recent users with their plan + monthly usage.
// Used by the admin table. Capped at 200 rows for MVP.
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('user_id, plan, plan_interval, stripe_customer_id, stripe_subscription_id, created_at, is_admin')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    // Monthly usage per user.
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const { data: events } = await supabase
      .from('scan_events').select('user_id').gte('ts', monthStart);
    const usage = {};
    for (const e of events || []) { usage[e.user_id] = (usage[e.user_id] || 0) + 1; }

    // Emails come from auth.users — use the service role to look them up.
    // admin.listUsers is paginated; we just pull one large page for MVP.
    let emailByUserId = {};
    try {
      const { data: { users } = { users: [] } } = await supabase.auth.admin.listUsers({ perPage: 200 });
      for (const u of users || []) emailByUserId[u.id] = u.email || '';
    } catch (e) { console.warn('[ADMIN] email lookup failed:', e.message); }

    res.json((profiles || []).map(p => ({
      user_id: p.user_id,
      email: emailByUserId[p.user_id] || '',
      plan: p.plan,
      plan_interval: p.plan_interval,
      scans_this_month: usage[p.user_id] || 0,
      has_subscription: !!p.stripe_subscription_id,
      is_admin: !!p.is_admin,
      created_at: p.created_at
    })));
  } catch (e) {
    console.error('[ADMIN] users failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ADMIN — US/EU ARBITRAGE FINDER
// ============================================================
// Surfaces English Pokemon cards priced significantly cheaper on
// TCGplayer (USD) than Cardmarket (EUR). Reads the in-memory
// CARD_PRICES map populated alongside CARD_DB from pokemontcg.io
// (which embeds both tcgplayer.prices + cardmarket.prices in one
// API call). No shipping factor — raw price comparison only.

// Pick the best (highest-spread) variant pair for one card.
// Returns null when there's no overlapping priced variant.
function bestArbitrage(entry, usdToEurRate) {
  if (!entry?.tcg || !entry?.cm) return null;
  const cm = entry.cm;
  const tcg = entry.tcg;

  const variants = [];
  // Non-foil/holofoil variants compare against cardmarket lowPriceExPlus / lowPrice / trendPrice.
  const cmNormalEur = cm.lowPriceExPlus || cm.lowPrice || cm.trendPrice || 0;
  for (const k of ['normal', 'holofoil', '1stEditionNormal', '1stEditionHolofoil', 'unlimitedHolofoil']) {
    const usd = tcg[k]?.market;
    if (usd && cmNormalEur) variants.push({ variant: k, usd, eur: cmNormalEur });
  }
  // Reverse holofoil — uses reverseHoloLow / reverseHoloTrend
  const cmReverseEur = cm.reverseHoloLow || cm.reverseHoloTrend || 0;
  if (tcg.reverseHolofoil?.market && cmReverseEur) {
    variants.push({ variant: 'reverseHolofoil', usd: tcg.reverseHolofoil.market, eur: cmReverseEur });
  }

  let best = null;
  for (const v of variants) {
    const usdInEur = v.usd * usdToEurRate;
    if (usdInEur <= 0) continue;
    const ratio = v.eur / usdInEur;
    if (!best || ratio > best.ratio) best = { ...v, usdInEur, ratio };
  }
  return best;
}

// Compute arbitrage for a fixed variant — used when the user picks
// "Normal" / "Holofoil" / "Reverse Holo" instead of "auto".
function singleVariantArbitrage(entry, variant, usdToEurRate) {
  if (!entry?.tcg || !entry?.cm) return null;
  const tcg = entry.tcg;
  const cm = entry.cm;
  let usd = 0, eur = 0;
  if (variant === 'reverseHolofoil') {
    usd = tcg.reverseHolofoil?.market || 0;
    eur = cm.reverseHoloLow || cm.reverseHoloTrend || 0;
  } else {
    // 'normal' or 'holofoil' both compare against the non-reverse cm price
    usd = tcg[variant]?.market || 0;
    eur = cm.lowPriceExPlus || cm.lowPrice || cm.trendPrice || 0;
  }
  if (!usd || !eur) return null;
  const usdInEur = usd * usdToEurRate;
  if (usdInEur <= 0) return null;
  return { variant, usd, eur, usdInEur, ratio: eur / usdInEur };
}

// POST /api/admin/arbitrage — scan CARD_PRICES with the given filters.
app.post('/api/admin/arbitrage', requireAuth, requireAdmin, (req, res) => {
  const {
    minUsd = 5,
    threshold = 1.30,
    sets = null,
    variant = 'auto',
    limit = 100,
    sortBy = 'ratio'
  } = req.body || {};

  const setFilter = sets && Array.isArray(sets) && sets.length
    ? new Set(sets.map(s => String(s).toLowerCase()))
    : null;

  const out = [];
  for (const [key, e] of CARD_PRICES) {
    if (setFilter && !setFilter.has(String(e.setId || '').toLowerCase())) continue;
    const arb = (variant === 'auto')
      ? bestArbitrage(e, USD_TO_EUR)
      : singleVariantArbitrage(e, variant, USD_TO_EUR);
    if (!arb) continue;
    if (arb.usd < minUsd) continue;
    if (arb.ratio < threshold) continue;
    out.push({
      key,
      name: e.name,
      setName: e.setName,
      setCode: e.setCode,
      setId: e.setId,
      number: e.number,
      rarity: e.rarity,
      image: e.image,
      variant: arb.variant,
      usd: +arb.usd.toFixed(2),
      usdInEur: +arb.usdInEur.toFixed(2),
      eur: +arb.eur.toFixed(2),
      ratio: +arb.ratio.toFixed(3),
      spreadEur: +(arb.eur - arb.usdInEur).toFixed(2),
      tcgplayerUrl: e.tcgplayerUrl,
      cardmarketUrl: e.cardmarketUrl,
      fetchedAt: e.fetchedAt
    });
  }
  out.sort((a, b) => sortBy === 'spreadEur' ? b.spreadEur - a.spreadEur : b.ratio - a.ratio);
  res.json({
    rate: USD_TO_EUR,
    cardsPriced: CARD_PRICES.size,
    matched: out.length,
    lastRefreshAt: _lastPriceRefreshAt || null,
    results: out.slice(0, Math.min(parseInt(limit, 10) || 100, 500))
  });
});

// POST /api/admin/refresh-prices — kick off a fresh pull. Returns
// immediately; client polls /api/admin/refresh-status for completion.
app.post('/api/admin/refresh-prices', requireAuth, requireAdmin, async (req, res) => {
  if (cardDbLoading) {
    return res.json({ ok: false, alreadyLoading: true, cardsPriced: CARD_PRICES.size });
  }
  res.json({ ok: true, started: true, before: CARD_PRICES.size });
  // Fire-and-forget — pages take ~5 min to refresh on a free Render dyno.
  downloadCardDatabase({ force: true })
    .then(() => console.log(`[ARBITRAGE] refresh complete: ${CARD_PRICES.size} priced cards`))
    .catch(e => console.error('[ARBITRAGE] refresh failed:', e.message));
});

// GET /api/admin/refresh-status — UI polls this while a refresh is in flight.
app.get('/api/admin/refresh-status', requireAuth, requireAdmin, (req, res) => {
  res.json({
    cardsPriced: CARD_PRICES.size,
    cardsTotal: CARD_DB.size,
    loading: cardDbLoading,
    lastRefreshAt: _lastPriceRefreshAt || null,
    rate: USD_TO_EUR
  });
});

// ============================================================
// STRIPE — checkout, customer portal, webhook (Phase D)
// ============================================================
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;
if (!stripe) {
  console.warn('[STRIPE] STRIPE_SECRET_KEY missing — billing endpoints disabled.');
}

// Price ID → { plan, interval } and vice versa. Config lives entirely in
// env vars so pricing can be swapped without a code deploy.
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_SOLO_MONTHLY]:   { plan: 'solo',   interval: 'monthly' },
  [process.env.STRIPE_PRICE_SOLO_YEARLY]:    { plan: 'solo',   interval: 'yearly'  },
  [process.env.STRIPE_PRICE_VENDOR_MONTHLY]: { plan: 'vendor', interval: 'monthly' },
  [process.env.STRIPE_PRICE_VENDOR_YEARLY]:  { plan: 'vendor', interval: 'yearly'  },
  [process.env.STRIPE_PRICE_SHOP_MONTHLY]:   { plan: 'shop',   interval: 'monthly' },
  [process.env.STRIPE_PRICE_SHOP_YEARLY]:    { plan: 'shop',   interval: 'yearly'  },
};
function priceForPlan(plan, interval) {
  const key = `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
  return process.env[key] || null;
}

// Ensure the user has a Stripe customer; create on first checkout.
async function getOrCreateStripeCustomer(user) {
  const { data: profile } = await supabase
    .from('profiles').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id }
  });
  await supabase
    .from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('user_id', user.id);
  return customer.id;
}

// POST /api/checkout — returns { url } for a Stripe Checkout session.
app.post('/api/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'billing unavailable' });
  try {
    const { tier, interval } = req.body || {};
    if (!['solo', 'vendor', 'shop'].includes(tier)) {
      return res.status(400).json({ error: 'invalid tier' });
    }
    if (!['monthly', 'yearly'].includes(interval)) {
      return res.status(400).json({ error: 'invalid interval' });
    }
    const price = priceForPlan(tier, interval);
    if (!price) return res.status(500).json({ error: 'price id not configured' });

    const customerId = await getOrCreateStripeCustomer(req.user);
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
      allow_promotion_codes: true,
      // Metadata on the session (and the eventual subscription) so the
      // webhook can map Stripe events back to our Supabase user without
      // needing a reverse lookup on stripe_customer_id.
      metadata: { supabase_user_id: req.user.id, plan: tier, interval },
      subscription_data: {
        metadata: { supabase_user_id: req.user.id, plan: tier, interval }
      }
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[CHECKOUT] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/portal — returns { url } for Stripe Customer Portal session.
// Used for self-serve cancellation, payment method updates, invoice history.
app.post('/api/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'billing unavailable' });
  try {
    const { data: profile } = await supabase
      .from('profiles').select('stripe_customer_id').eq('user_id', req.user.id).maybeSingle();
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'no stripe customer — subscribe first' });
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${origin}/`
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[PORTAL] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stripe-webhook — Stripe → us. Signature-verified, so no requireAuth.
// Uses raw body (captured by the express.json verify callback at top of file).
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('webhook unavailable');
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[WEBHOOK] signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.metadata?.supabase_user_id;
        if (userId && s.subscription) {
          // Pull the subscription to know the price → plan mapping.
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          const priceId = sub.items.data[0]?.price?.id;
          const mapped = PRICE_TO_PLAN[priceId] || { plan: s.metadata?.plan, interval: s.metadata?.interval };
          await supabase.from('profiles').update({
            plan: mapped.plan,
            plan_interval: mapped.interval,
            stripe_customer_id: s.customer,
            stripe_subscription_id: s.subscription
          }).eq('user_id', userId);
          console.log(`[WEBHOOK] checkout.completed → ${userId} upgraded to ${mapped.plan} (${mapped.interval})`);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;
        const priceId = sub.items.data[0]?.price?.id;
        const mapped = PRICE_TO_PLAN[priceId] || null;
        // Any non-active status = revert to free (past_due, unpaid, canceled, incomplete_expired).
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        const nextPlan = isActive && mapped ? mapped.plan : 'free';
        const nextInterval = isActive && mapped ? mapped.interval : null;
        await supabase.from('profiles').update({
          plan: nextPlan,
          plan_interval: nextInterval,
          stripe_subscription_id: sub.id
        }).eq('user_id', userId);
        console.log(`[WEBHOOK] sub.${event.type.endsWith('created') ? 'created' : 'updated'} status=${sub.status} → ${userId} plan=${nextPlan}`);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.supabase_user_id;
        if (!userId) break;
        await supabase.from('profiles').update({
          plan: 'free',
          plan_interval: null,
          stripe_subscription_id: null
        }).eq('user_id', userId);
        console.log(`[WEBHOOK] sub.deleted → ${userId} downgraded to free`);
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        console.warn(`[WEBHOOK] invoice.payment_failed: customer=${inv.customer} amount=${inv.amount_due}`);
        // Subscription state change will also fire — no action needed here beyond logging.
        break;
      }
      case 'invoice.paid':
        // Renewal successful. No DB change needed; subscription.updated will
        // fire if anything about the plan changes.
        break;
      default:
        console.log(`[WEBHOOK] unhandled event type: ${event.type}`);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[WEBHOOK] handler error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// USER STATE SYNC (Phase B-sync)
// ============================================================
// Stores the user's session log + want list + selected-session id as a
// single JSONB blob keyed on user_id. Simple last-writer-wins: localStorage
// is the fast UI cache, Supabase is the durable backing store. Shop users
// are typically one-device so concurrency isn't a real concern yet.
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_state')
      .select('state, updated_at')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ state: data?.state || null, updated_at: data?.updated_at || null });
  } catch (e) {
    console.error('[STATE] get failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/state', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const state = req.body?.state;
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'body must include a state object' });
    }
    const { error } = await supabase
      .from('user_state')
      .upsert({ user_id: req.user.id, state, updated_at: new Date().toISOString() });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('[STATE] put failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// USD → EUR — refreshed daily from Frankfurter (ECB data, no auth needed).
// ============================================================
// Used to convert TCGPlayer USD prices into EUR for buy-offer calculations.
// Initial value is last-known reasonable; refresh updates it on boot + daily.
let USD_TO_EUR = 0.92;
async function refreshFxRate() {
  try {
    const resp = await axios.get('https://api.frankfurter.app/latest', {
      params: { from: 'USD', to: 'EUR' },
      timeout: 10000
    });
    const rate = resp.data?.rates?.EUR;
    if (typeof rate === 'number' && rate > 0.5 && rate < 2.0) {
      USD_TO_EUR = rate;
      console.log(`[FX] USD→EUR refreshed: ${rate.toFixed(4)} (frankfurter.app, ${resp.data.date})`);
    } else {
      console.warn(`[FX] Unexpected rate shape — keeping ${USD_TO_EUR}`, rate);
    }
  } catch (e) {
    console.warn(`[FX] Refresh failed — keeping ${USD_TO_EUR}: ${e.message}`);
  }
}
refreshFxRate();
setInterval(refreshFxRate, 24 * 60 * 60 * 1000);
// Force no-cache on service-worker.js and index.html to bust PWA staleness
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(__dirname, 'public', 'service-worker.js'));
});
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});
// Widget loader gets a 5-minute cache. Customer sites embed this on every
// page-load so we want a long TTL, but short enough that fixes propagate
// reasonably fast. Served before the static middleware to override its
// no-cache defaults.
app.get('/widget.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(join(__dirname, 'public', 'widget.js'));
});
app.use(express.static(join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// Multer for file uploads (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ============================================================
// ANTHROPIC CLIENT — Card Identification via Claude Vision
// ============================================================
// Keep-alive agents so we reuse TCP/TLS connections to Anthropic (and axios
// upstreams). Without this, every /api/identify eats a fresh TLS handshake
// (~150-300ms on cellular). keepAlive=true reuses the socket for ~60s.
const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 25, keepAliveMsecs: 30_000 });
const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 25, keepAliveMsecs: 30_000 });
axios.defaults.httpsAgent = httpsKeepAlive;
axios.defaults.httpAgent = httpKeepAlive;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Pass our keep-alive https agent through the SDK's fetch so Anthropic
  // calls reuse sockets too.
  fetchOptions: { agent: httpsKeepAlive }
});

const CARD_ID_SYSTEM_PROMPT = `You are an expert trading card identifier with encyclopaedic knowledge of ALL trading card games. You can identify cards with extreme accuracy from:

- Pokemon TCG
- Magic: The Gathering
- Star Wars: Unlimited (FFG/Spark of Rebellion, Shadows of the Galaxy, Twilight of the Republic, etc.)
- One Piece TCG
- Yu-Gi-Oh!
- Dragon Ball Super Card Game
- Disney Lorcana
- Digimon Card Game
- Flesh and Blood
- Weiss Schwarz
- Cardfight!! Vanguard
- Final Fantasy TCG
- MetaZoo
- Union Arena
- Battle Spirits Saga
- ANY other TCG

When shown a card image, you MUST return ONLY valid JSON (no markdown, no explanation) in this exact format:

For a SINGLE card:
{
  "cards": [{
    "game": "pokemon|magic|starwars|onepiece|yugioh|dragonball|lorcana|digimon|fleshandblood|weiss|cardfight|other",
    "name": "Exact card name as printed on the card (include ex/GX/V/VMAX/VSTAR suffix if present)",
    "hp": "HP number as printed (e.g. 330, 250, 120) — CRITICAL for Pokemon",
    "attacks": ["Attack Name 1", "Attack Name 2"],
    "set_name": "Full set name",
    "set_code": "Set code/abbreviation",
    "card_number": "Card number exactly as printed (e.g. 025/252, SOR 051, OP06-001)",
    "rarity": "Common/Uncommon/Rare/Super Rare/Legendary/Hyperspace/etc",
    "variant": "normal|holofoil|reverse_holo|full_art|alt_art|textured|gold|hyperspace|showcase|special",
    "language": "english|japanese|german|french|italian|spanish|other",
    "condition_estimate": "NM|LP|MP|HP|DMG",
    "condition_notes": "Brief notes on visible wear, whitening, scratches, etc.",
    "regulation_mark": "For Pokemon cards only: the single letter D/E/F/G/H/J printed in a small circle next to the card number. Return exactly that letter, or null if not present/readable.",
    "graded": null,
    "confidence": 0.95
  }]
}

If the card is in a professional GRADING SLAB (a hard plastic case with a colored label showing a grade), populate the "graded" field INSTEAD of leaving it null:
  "graded": { "company": "PSA|BGS|CGC|SGC", "grade": 10 }
Visual cues for slabs:
- PSA: red label at top, large white number, black holographic logo. Grades 1-10.
- BGS (Beckett): black label (standard) or silver/gold (premium), sub-grades visible, "BGS" logo.
- CGC: blue/teal label, "CGC Trading Cards" text.
- SGC: tuxedo (black+white) label.
When graded is set, still estimate condition_estimate as if ungraded (will be overridden) and keep everything else accurate.

For a BINDER PAGE with multiple cards:
{
  "cards": [
    { ...card1... },
    { ...card2... },
    ...
  ],
  "layout": "3x3|4x3|3x2|etc",
  "notes": "Any notes about partially visible or unidentifiable cards"
}

=== GAME-SPECIFIC IDENTIFICATION GUIDES ===

STAR WARS: UNLIMITED (game="starwars"):
- Set codes: SOR (Spark of Rebellion), SHD (Shadows of the Galaxy), TWI (Twilight of the Republic), JTL (Jump to Lightspeed)
- Card number format: "SOR 051" or "051/252" — check the BOTTOM of the card
- Rarity indicators: Common (no marking), Uncommon (U), Rare (R), Super Rare (SR), Legendary (L), Special (S)
- CRITICAL: Variants have VERY different prices:
  - Normal: standard card art
  - Hyperspace: alternate border style — typically 2-5x normal price
  - Showcase: special full art — can be 10-50x normal price
  - READ the card border and art style carefully to distinguish normal vs hyperspace vs showcase
- Characters include: Marchion Ro, Luke Skywalker, Darth Vader, Sabine Wren, Boba Fett, Grand Inquisitor, etc.
- Look for the FFG / Fantasy Flight Games logo
- The card type (Unit, Event, Upgrade, Base, Leader) is printed on the card

POKEMON TCG (game="pokemon"):
- REGULATION MARK: Modern Pokémon cards (2019+) show a single letter in a small circle next to the card number at the bottom. It tells us which era/rotation the card is from: D or E = Sword & Shield era, F = SWSH→SV transition, G = Scarlet & Violet mid, H = SV late, J = Mega Evolution era. Report this letter verbatim in the "regulation_mark" field, or null if you can't see it.

- CRITICAL: Read the EXACT suffix on the card name — "ex", "GX", "V", "VMAX", "VSTAR", "EX" (caps), "LV.X" are ALL DIFFERENT card types. Do NOT confuse them.
  - Lowercase "ex" = Scarlet & Violet era (2023+). VISUAL CUES: name on card shows lowercase "ex" in stylized font, card has "Pokemon ex rule" text at bottom, modern card frame, usually has regulation mark G or H. HP ranges from 120-340+.
  - Uppercase "GX" = Sun & Moon era (2017-2020). VISUAL CUES: name shows uppercase "GX" in bold, card has "Pokemon-GX rule" text, has a special GX attack (used once per game), Sun & Moon era card frame with yellow/grey border. HP usually 170-270.
  - Uppercase "EX" (older) = XY era (2014-2016), has "Pokemon-EX rule"
  - "V" / "VMAX" / "VSTAR" = Sword & Shield era (2020-2023)
  - No suffix = regular Pokemon card
  - IMPORTANT: "Meowth ex" (lowercase, SV era, 170HP) is NOT "Meowth-GX" (uppercase with hyphen, SM era). Read the actual text printed on the card name area carefully!
- READ the HP number printed on the card — this is essential for distinguishing versions (e.g. Charizard ex 330HP vs Charizard GX 250HP)
- READ all attack names printed on the card — different versions have completely different attacks
- Set codes: SV (Scarlet & Violet base), PAL (Paldea Evolved), OBF (Obsidian Flames), MEW (151), PAR (Paradox Rift), PAF (Paldean Fates), TEF (Temporal Forces), TWM (Twilight Masquerade), SFA (Shrouded Fable), SSP (Stellar Crown), SCR (Surging Sparks), PRE (Prismatic Evolutions), JTG (Journey Together), SM (Sun & Moon sets), SV (Sword & Shield sets)
- Include HP in your identification to disambiguate: e.g. "Charizard ex" with 330 HP is NOT "Charizard GX" with 250 HP

*** CARD NUMBER IS THE #1 MOST IMPORTANT FIELD — READ IT FROM THE CARD BOTTOM ***
- BEFORE anything else, look at the BOTTOM of the card for the printed card number
- The card number is typically at the BOTTOM LEFT of the card, printed in small text
- PROMO CARDS have special numbering WITHOUT a slash:
  - Sun & Moon promos: "SM211", "SM195", "SM228" — these are NOT from any main set
  - Sword & Shield promos: "SWSH262", "SWSH066" — also standalone promos
  - Scarlet & Violet promos: "SVP 076" — note the SVP prefix
  - Black Star promos have numbers like "XY121", "BW78"
  - If you see a number like "SM211" with no "/" it is a PROMO, NOT from Hidden Fates, Shiny Vault, or any expansion set
- SET CARDS have a slash format: "006/197", "SV49/SV94"
  - Shiny Vault cards use "SV" prefix: "SV49/SV94" (Hidden Fates), "SV122/SV122" (Shining Fates)
  - Regular art: typically low number (e.g. 006/197)
  - Full art: higher number (e.g. 185/197)
  - Special art rare / Illustration rare: even higher (e.g. 199/197, goes OVER the set total)
  - Hyper rare / Gold: highest numbers (e.g. 210/197)
- CRITICAL: "SM211" (Detective Pikachu promo Charizard-GX) is a COMPLETELY DIFFERENT card from "SV49/SV94" (Hidden Fates Shiny Vault Charizard-GX). Same Pokemon, same suffix, DIFFERENT cards with DIFFERENT values.
- A "Charizard ex 006/197" (regular art) is a COMPLETELY different card than "Charizard ex 199/197" (special art rare) — they can differ by hundreds in price
- READ the card number at the bottom of the card CAREFULLY. The number before "/" and the total after "/" are both important.
- If you see NO slash in the number (e.g. "SM211"), set set_name to the promo series (e.g. "SM Black Star Promos") and set_code to "SMP" (or "SWSHP", "SVP" for those eras)
- If the card number is LARGER than the set total (e.g. 199/197), it is a secret rare / special art
- Distinguish: holo, reverse holo, full art, illustration rare, special art rare (SAR), hyper rare, gold, ultra rare, amazing rare
- NEVER guess the card number — if you cannot read it clearly, return "" rather than guessing a number from a different card

MAGIC: THE GATHERING (game="magic"):
- Check set symbol (bottom right) and collector number (bottom left)
- Format: "123/456" — be precise. Numbers ABOVE the set total are borderless/extended art/showcase variants
- CRITICAL: Same card can appear as regular, borderless, extended art, showcase, retro frame, foil etched — each has a DIFFERENT collector number and very different prices
- Look for the mana symbols to confirm MTG
- Serialized cards (e.g. "001/500") are extremely valuable — note this in variant field

ONE PIECE TCG (game="onepiece"):
- Set codes: OP01, OP02, OP03, OP04, OP05, OP06, OP07, OP08, OP09, ST01-ST18
- Card number format: "OP06-001" — the set code is part of the number
- Types: Leader, Character, Event, Stage, DON!!

YU-GI-OH! (game="yugioh"):
- Card number format: "ABCD-EN001" — the set prefix + language + number
- Check the edition (1st Edition, Unlimited, Limited Edition)
- Rarity: Common, Rare, Super Rare, Ultra Rare, Secret Rare, Ghost Rare, Starlight Rare

DISNEY LORCANA (game="lorcana"):
- Set codes: TFC (The First Chapter), RotF (Rise of the Floodborn), ItI (Into the Inklands), URR (Ursula's Return), SSK (Shimmering Skies), AP (Azurite Sea)
- Card number format: "123/204"
- Check ink colour (Amber, Amethyst, Emerald, Ruby, Sapphire, Steel)

=== CRITICAL ACCURACY RULES ===
- FIRST: read the PRINTED SET TOTAL (the number AFTER the "/") from the bottom of the card before you identify the Pokemon. The set total is a near-unique fingerprint: /182 = Destined Rivals, /198 = Paldea Evolved or Scarlet & Violet, /197 = Obsidian Flames, /088 = Perfect Order, /165 = Pokémon 151. Read this FIRST — everything else depends on it. If you can't read the total, say so and set confidence below 0.5.
- READ the EXACT card name as printed — DO NOT guess or use a similar card name
- READ the EXACT suffix: "ex" (lowercase) ≠ "GX" ≠ "EX" (uppercase) ≠ "V" ≠ "VMAX" ≠ "VSTAR". Getting this wrong gives completely wrong prices.
- READ the HP number — this distinguishes card versions (e.g. 330HP vs 250HP Charizard)
- READ the attack names — different versions have different attacks. Include them in the "attacks" array.
- READ the EXACT card number printed on the card — this is the #1 most important field for pricing
  - INCLUDE the full number with set total, e.g. "44/95" not just "44" — the total after "/" identifies which set it belongs to
  - PRESERVE leading zeros EXACTLY as printed. "027" is NOT "27" or "2" — report it as "027". "003/165" must be "003/165", not "3/165". Leading zeros are never decorative; dropping them breaks set lookup.
  - If the printed number is ABOVE the set total (e.g. "229/182"), the card is a Secret Rare / "Additionals" variant — still report the exact number.
  - For EX-era Pokemon cards (2003-2007), the set total is critical because many common Pokemon appear across multiple sets with the same number
  - Example: Psyduck #44 exists in multiple EX-era sets — only the "/95" or "/116" etc. tells us WHICH set
- READ the set symbol carefully — it appears at the bottom right of Pokemon cards and uniquely identifies the set
- If image is blurry, partially obscured, or you're not certain, set confidence below 0.5
- For condition: look for edge whitening, surface scratches, centering issues, corner wear
- NEVER fabricate a card number — if you can't read it clearly, use "" and note why
- If you can identify the game but not the specific card, still set the game field correctly
- Pay close attention to foil/holo patterns visible in the image`;

// ============================================================
// CARD IDENTIFICATION ENDPOINT
// ============================================================
// Simple LRU cache for recent identifications (keyed by image hash).
// Re-scanning the same card (camera double-fires, operator re-scans)
// returns instantly instead of re-hitting Claude.
const IDENT_CACHE_MAX = 100;
const identCache = new Map();
function cacheGet(key) {
  if (!identCache.has(key)) return null;
  const val = identCache.get(key);
  // Re-insert to mark as recently used
  identCache.delete(key);
  identCache.set(key, val);
  return val;
}
function cacheSet(key, val) {
  if (identCache.has(key)) identCache.delete(key);
  identCache.set(key, val);
  if (identCache.size > IDENT_CACHE_MAX) {
    const first = identCache.keys().next().value;
    identCache.delete(first);
  }
}

// Pull a raw image buffer out of the request, accepting either multer's
// file upload or a base64 data URL in the JSON body. Throws with a
// 400-appropriate message if neither is present / parseable.
function extractImageBuffer(req) {
  if (req.file) return req.file.buffer;
  if (req.body.image) {
    const m = req.body.image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) return Buffer.from(m[2], 'base64');
    const err = new Error('Invalid image data');
    err.status = 400;
    throw err;
  }
  const err = new Error('No image provided');
  err.status = 400;
  throw err;
}

// Resize the image, check the identification cache, call Claude if needed,
// and apply the suffix fixer. Returns either a cache hit or unverified
// parsed cards + the cache key the caller should save to.
//
// Returns:
//   { cached: true, result }                 — full cached response
//   { cached: false, parsed, cacheKey|null } — caller verifies + caches
async function identifyCore({ buffer, hint }) {
  // Single-card resize: 1800px @ q92. Binder/batch mode was removed with
  // the UI — every scan is now a single card (either from the scanner-
  // mode phone or bulk-uploaded from the laptop, one at a time).
  const targetSize = 1800;
  const jpegQuality = 92;

  // Modern phones already client-resize to ~1800-2000px; re-encoding here
  // is wasted CPU on the critical path. Pass through if the source is
  // already JPEG/PNG within bounds — Anthropic accepts both.
  const meta = await sharp(buffer).metadata().catch(() => ({}));
  const srcMax = Math.max(meta.width || 0, meta.height || 0);
  const passthroughOk = (meta.format === 'jpeg' || meta.format === 'png')
    && srcMax > 0 && srcMax <= targetSize;
  const optimized = passthroughOk
    ? buffer
    : await sharp(buffer)
        .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: jpegQuality })
        .toBuffer();
  const optimizedFormat = passthroughOk ? meta.format : 'jpeg';
  const imageData = optimized.toString('base64');

  // Cache only no-hint scans: a hint changes the expected output.
  let cacheKey = null;
  if (!hint) {
    cacheKey = crypto.createHash('sha1').update(optimized).digest('hex');
    const hit = cacheGet(cacheKey);
    if (hit) return { cached: true, result: hit, cacheKey };
  }

  let userMessage = 'Identify this trading card. FIRST read the card number at the bottom of the card — this is the most critical field. If it has no slash (like SM211, SWSH066) it is a PROMO card. Be extremely precise with the set code and card number.';
  if (hint) userMessage += `\n\nUser hint: ${hint}`;

  // Sonnet 4.6 — measurably better small-text OCR than 4.0, exactly the
  // pain point (glare/sleeves/small card numbers). Prompt caching
  // (ephemeral) reuses the ~1500-token system prompt across calls,
  // trimming 30-50% off TTFT.
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: CARD_ID_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: optimizedFormat === 'png' ? 'image/png' : 'image/jpeg', data: imageData } },
        { type: 'text', text: userMessage }
      ]
    }]
  });

  const text = response.content[0].text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('Could not parse card identification response');
  }

  if (parsed.cards?.length > 0) {
    parsed.cards = parsed.cards.map(card => fixPokemonSuffix(card));
  }
  // imageBase64 is returned so the caller can feed it into the two-pass
  // double-check (compare scan vs DB reference image).
  return { cached: false, parsed, cacheKey, imageBase64: imageData, imageMediaType: optimizedFormat === 'png' ? 'image/png' : 'image/jpeg' };
}

// Verify each card against the real game databases in parallel.
async function verifyIdentified(cards) {
  if (!cards?.length) return cards || [];
  return Promise.all(cards.map(card => verifyCard(card)));
}

// ============================================================
// TWO-PASS VERIFICATION — compare user scan vs reference image
// ============================================================
// After verifyPokemon picks a candidate from pokemontcg.io (which has a
// reference image URL), we can ask Sonnet 4.6 to look at BOTH the user's
// scan and that reference image and confirm they're the same printing.
// This catches the cases where verifyPokemon's scoring thinks it found a
// match but the card is actually an alt-art, reverse holo, or wrong era
// that happens to share name+number with the matched candidate.
//
// Gated by confidence_score — if verifyPokemon scored the match >= 200
// we skip the double-check (high-confidence matches don't need it).
async function maybeDoubleCheck(userImageBase64, userImageMediaType, card) {
  if (!userImageBase64) return card;
  if (card.game !== 'pokemon') return card;
  if (!card.verified || !card.reference_image) return card;
  if (card.verify_rejected) return card; // already flagged — no point double-checking
  if (card.confidence_score && card.confidence_score >= 200) return card;

  try {
    // Reuse the in-flight ref-image fetch started by verifyPokemon when
    // available. Falls back to a fresh axios.get for cards verified via
    // other paths (Magic, etc.) or when the prefetch was skipped.
    let refResp;
    if (card._refImagePromise) {
      refResp = await card._refImagePromise;
      if (refResp && refResp._failed) {
        console.warn(`[DOUBLE-CHECK] prefetch failed for "${card.name}": ${refResp._failed}`);
        return card;
      }
    } else {
      refResp = await axios.get(card.reference_image, {
        responseType: 'arraybuffer',
        timeout: 8000
      });
    }
    const refBase64 = Buffer.from(refResp.data).toString('base64');
    const mediaType = /\.png($|\?)/i.test(card.reference_image) ? 'image/png'
                    : /\.jpe?g($|\?)/i.test(card.reference_image) ? 'image/jpeg'
                    : /\.webp($|\?)/i.test(card.reference_image) ? 'image/webp'
                    : 'image/png';

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: [{ type: 'text', text:
        'You compare two trading-card images and decide if they show the SAME printing. ' +
        'Respond with ONLY JSON: {"match": true|false, "reason": "short phrase"}. ' +
        'A match means same card name, same set, and same art/foil/border variant. ' +
        'Different printings of the same Pokemon (base vs reverse holo vs secret rare vs ' +
        'alt art vs wrong era) are NOT matches — look at art, border, foil pattern, ' +
        'set symbol, card number. If unsure, return match:true (we only reject confident mismatches).'
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Image 1 is the user's scan. Image 2 is the candidate (${card.name} from ${card.set_name || '?'} #${card.card_number || '?'}). Same card printing?` },
          { type: 'image', source: { type: 'base64', media_type: userImageMediaType || 'image/jpeg', data: userImageBase64 } },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: refBase64 } }
        ]
      }]
    });

    const text = resp.content?.[0]?.text || '';
    let result = null;
    try { result = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { result = JSON.parse(m[0]); } catch {} }
    }
    if (!result || typeof result.match !== 'boolean') {
      console.warn(`[DOUBLE-CHECK] unparseable response for "${card.name}":`, text.slice(0, 120));
      return card;
    }
    if (result.match === false) {
      console.log(`[DOUBLE-CHECK] REJECTED "${card.name}" — ${result.reason || '(no reason)'}`);
      return { ...card, verified: false, verify_rejected: 'double_check_mismatch', double_check_reason: result.reason || null };
    }
    console.log(`[DOUBLE-CHECK] CONFIRMED "${card.name}"`);
    return card;
  } catch (e) {
    console.warn(`[DOUBLE-CHECK] failed for "${card.name}": ${e.message}`);
    return card; // graceful: don't reject on double-check failure
  }
}

async function doubleCheckAll(userImageBase64, userImageMediaType, cards) {
  if (!cards?.length) return cards || [];
  return Promise.all(cards.map(c => maybeDoubleCheck(userImageBase64, userImageMediaType, c)));
}

// Strip internal fields (underscore-prefixed) from cards before sending to
// the client. _refImagePromise contains an in-flight axios promise used for
// the parallel ref-image prefetch optimisation — JSON.stringify would either
// throw on the circular Buffer ref or send garbage.
function stripInternals(cards) {
  if (!cards?.length) return cards || [];
  return cards.map(c => {
    if (!c || typeof c !== 'object') return c;
    const out = {};
    for (const k of Object.keys(c)) {
      if (k.startsWith('_')) continue;
      out[k] = c[k];
    }
    return out;
  });
}

app.post('/api/identify', identifyLimiter, requireAuth, enforceQuota, upload.single('image'), async (req, res) => {
  logScanEvent(req.user.id, '/api/identify');
  try {
    const buffer = extractImageBuffer(req);
    const hint = req.body.hint || '';

    const out = await identifyCore({ buffer, hint });
    if (out.cached) {
      console.log(`[IDENT-CACHE] HIT ${out.cacheKey.slice(0, 8)}`);
      return res.json(out.result);
    }

    if (out.parsed.cards?.length > 0) {
      console.log(`[VERIFY] Verifying ${out.parsed.cards.length} card(s) against databases...`);
      out.parsed.cards = await verifyIdentified(out.parsed.cards);
      // Two-pass double-check for moderate-confidence Pokemon matches.
      out.parsed.cards = await doubleCheckAll(out.imageBase64, out.imageMediaType, out.parsed.cards);
    }

    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    out.parsed.cards = stripInternals(out.parsed.cards);
    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);
    res.json(out.parsed);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Identification error:', err.message);
    res.status(500).json({ error: 'Failed to identify card', details: err.message });
  }
});

// ============================================================
// STREAMING IDENTIFY: /api/identify-stream
// ============================================================
// NDJSON-over-HTTP. Emits events as they become available:
//   {type:'ident', cards}    — raw Claude output (unverified) — client can
//                              start pricing off this immediately.
//   {type:'verified', cards} — same cards after DB verification (may rename
//                              set_code / card_number). Client patches UI.
//   {type:'error', error}
//   {type:'done'}
// This shaves 500-1000ms off perceived latency because pricing kicks off
// before the (slow) pokemontcg.io / scryfall verification round-trip.
app.post('/api/identify-stream', identifyLimiter, requireAuth, enforceQuota, upload.single('image'), async (req, res) => {
  logScanEvent(req.user.id, '/api/identify-stream');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    let buffer;
    try { buffer = extractImageBuffer(req); }
    catch (e) { send({ type: 'error', error: e.message }); return res.end(); }

    const hint = req.body.hint || '';

    const out = await identifyCore({ buffer, hint });
    if (out.cached) {
      console.log(`[IDENT-STREAM-CACHE] HIT ${out.cacheKey.slice(0, 8)}`);
      // Already verified in cache — emit both events so client logic works.
      send({ type: 'ident', cards: out.result.cards || [] });
      send({ type: 'verified', cards: out.result.cards || [] });
      send({ type: 'done' });
      return res.end();
    }

    // Emit ident NOW so the client can start pricing in parallel with verify.
    send({ type: 'ident', cards: out.parsed.cards || [] });

    // Verify against real databases — this is the slow step (500-1500ms).
    if (out.parsed.cards?.length > 0) {
      try {
        out.parsed.cards = await verifyIdentified(out.parsed.cards);
        // Two-pass double-check for moderate-confidence Pokemon matches.
        out.parsed.cards = await doubleCheckAll(out.imageBase64, out.imageMediaType, out.parsed.cards);
      } catch (e) {
        console.error('[IDENT-STREAM] verify error:', e.message);
      }
    }
    out.parsed.cards = stripInternals(out.parsed.cards);
    send({ type: 'verified', cards: out.parsed.cards || [] });

    // Skip caching when verify rejected a card — a better image on re-scan
    // might yield a better answer, so don't lock in the bad result.
    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);
    else if (anyRejected) console.log('[IDENT-STREAM-CACHE] SKIP — one or more cards had verify_rejected flag');
    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('Identify-stream error:', err.message);
    send({ type: 'error', error: err.message });
    res.end();
  }
});

// ============================================================
// POKEMON SET CODE ALIAS TABLE
// ============================================================
// Maps common abbreviations (ptcgoCode, printed codes, collector slang)
// to the pokemontcg.io set.id so manual lookups hit the right set.
// Keys are UPPERCASE. Values are the API's set.id (lowercase).
const PKM_SET_ALIASES = {
  // ---- Scarlet & Violet era ----
  'SVI':  'sv1',        // Scarlet & Violet
  'PAL':  'sv2',        // Paldea Evolved
  'OBF':  'sv3',        // Obsidian Flames
  'MEW':  'sv3pt5',     // Pokémon 151
  '151':  'sv3pt5',     // Pokémon 151 (alternate)
  'PAR':  'sv4',        // Paradox Rift
  'PAF':  'sv4pt5',     // Paldean Fates
  'TEF':  'sv5',        // Temporal Forces
  'TWM':  'sv6',        // Twilight Masquerade
  'SFA':  'sv6pt5',     // Shrouded Fable
  'SCR':  'sv7',        // Stellar Crown
  'SSP':  'sv8',        // Surging Sparks
  'PRE':  'sv8pt5',     // Prismatic Evolutions
  'SVE':  'sv8pt5',     // Prismatic Evolutions (alternate)
  'JTG':  'sv9',        // Journey Together
  'JT':   'sv9',        // Journey Together (short)
  'DRI':  'sv10',       // Destined Rivals
  // Black Bolt & White Flare (SV10.5 split expansion)
  'BBT':  'bbt',        // Black Bolt
  'BLK':  'bbt',        // Black Bolt (pokemontcg.io ptcgoCode)
  'ZSV10PT5': 'bbt',    // Black Bolt (pokemontcg.io set.id)
  'WHT':  'wht',        // White Flare
  'RSV10PT5': 'wht',    // White Flare (pokemontcg.io set.id)
  // Mega Evolution sub-sets (ME01/ME02/ME03)
  'MEG':  'me1',        // Mega Evolution (ME01)
  'ME1':  'me1',        // Mega Evolution (ME01 alternate)
  'PFL':  'me2',        // Phantasmal Flames (ME02)
  'ME2':  'me2',        // Phantasmal Flames (ME02 alternate)
  'ASH':  'me2pt5',     // Ascended Heroes (ME02.5)
  'POR':  'me3',        // Perfect Order (ME03)
  'ME3':  'me3',        // Perfect Order (ME03 alternate)
  // SV promo
  'SVP':  'svp',        // SV Black Star Promos
  // Mega Evolution promos
  'MEP':  'mep',        // MEP Black Star Promos (Mega Evolution Promos)

  // ---- Sword & Shield era ----
  'SSH':  'swsh1',      // Sword & Shield
  'RCL':  'swsh2',      // Rebel Clash
  'DAA':  'swsh3',      // Darkness Ablaze
  'VIV':  'swsh4',      // Vivid Voltage
  'BST':  'swsh5',      // Battle Styles
  'CRE':  'swsh6',      // Chilling Reign
  'EVS':  'swsh7',      // Evolving Skies
  'FST':  'swsh8',      // Fusion Strike
  'BRS':  'swsh9',      // Brilliant Stars
  'ASR':  'swsh10',     // Astral Radiance
  'LOR':  'swsh11',     // Lost Origin
  'SIT':  'swsh12',     // Silver Tempest
  'CRZ':  'swsh12pt5',  // Crown Zenith
  'CZGG': 'swsh12pt5gg', // Crown Zenith Galarian Gallery (GG01-GG70)
  'CPA':  'swsh35',     // Champion's Path
  'SHF':  'swsh45',     // Shining Fates
  'SWP':  'swshp',      // Sword & Shield promos (SWSH001-SWSH300)
  'SWSH': 'swshp',      // Sword & Shield promos (alternate)

  // ---- Sun & Moon era ----
  'SUM':  'sm1',        // Sun & Moon
  'GRI':  'sm2',        // Guardians Rising
  'BUS':  'sm3',        // Burning Shadows
  'SLG':  'sm35',       // Shining Legends
  'CIN':  'sm4',        // Crimson Invasion
  'UPR':  'sm5',        // Ultra Prism
  'FLI':  'sm6',        // Forbidden Light
  'CES':  'sm7',        // Celestial Storm
  'LOT':  'sm8',        // Lost Thunder
  'TEU':  'sm9',        // Team Up
  'UNB':  'sm10',       // Unbroken Bonds
  'UNM':  'sm11',       // Unified Minds
  'CEC':  'sm12',       // Cosmic Eclipse
  'HIF':  'sm35',       // Hidden Fates (shares with Shining Legends)
  'DET':  'det1',       // Detective Pikachu

  // ---- XY era ----
  'XY':   'xy1',        // XY
  'FLF':  'xy2',        // Flashfire
  'FFI':  'xy3',        // Furious Fists
  'PHF':  'xy4',        // Phantom Forces
  'PRC':  'xy5',        // Primal Clash
  'ROS':  'xy6',        // Roaring Skies
  'AOR':  'xy7',        // Ancient Origins
  'BKT':  'xy8',        // BREAKthrough
  'BKP':  'xy9',        // BREAKpoint
  'FCO':  'xy10',       // Fates Collide
  'STS':  'xy11',       // Steam Siege
  'EVO':  'xy12',       // Evolutions
  'GEN':  'g1',         // Generations
};

// Human-readable set names — used for TCGGO/JustTCG search fallback
// when pokemontcg.io doesn't have a set indexed.
const PKM_SET_NAMES = {
  'sv1':  'Scarlet & Violet',
  'sv2':  'Paldea Evolved',
  'sv3':  'Obsidian Flames',
  'sv3pt5': 'Pokemon 151',
  'sv4':  'Paradox Rift',
  'sv4pt5': 'Paldean Fates',
  'sv5':  'Temporal Forces',
  'sv6':  'Twilight Masquerade',
  'sv6pt5': 'Shrouded Fable',
  'sv7':  'Stellar Crown',
  'sv8':  'Surging Sparks',
  'sv8pt5': 'Prismatic Evolutions',
  'sv9':  'Journey Together',
  'sv10': 'Destined Rivals',
  'bbt':  'Black Bolt',
  'wht':  'White Flare',
  'me1':  'Mega Evolution',
  'me2':  'Phantasmal Flames',
  'me2pt5': 'Ascended Heroes',
  'me3':  'Perfect Order',
  'svp':  'SV Black Star Promos',
  'mep':  'Mega Evolution Promos',
  'swshp': 'Sword & Shield Promos',
  'swsh12pt5': 'Crown Zenith',
  'swsh12pt5gg': 'Crown Zenith Galarian Gallery',
};

// TCGdex set ID mapping — TCGdex uses different IDs than pokemontcg.io
// for some sets. We map our internal set.id → TCGdex set ID.
const TCGDEX_SET_MAP = {
  'sv1':  'sv01', 'sv2':  'sv02', 'sv3':  'sv03', 'sv3pt5': 'sv03.5',
  'sv4':  'sv04', 'sv4pt5': 'sv04.5', 'sv5':  'sv05', 'sv6':  'sv06',
  'sv6pt5': 'sv06.5', 'sv7':  'sv07', 'sv8':  'sv08', 'sv8pt5': 'sv08.5',
  'sv9':  'sv09', 'sv10': 'sv10',
  'svp':  'svp',  'mep':  'svp',  // TCGdex may lump promos together
  'me1':  'sv04.5', 'me2':  'sv05.5', 'me3': 'sv06.5', // speculative — will 404 gracefully
  'wht':  'sv10.5', 'bbt':  'sv10.5', // split expansion
};

// Sets where pokemontcg.io data is unreliable or missing.
// For these, skip pokemontcg.io entirely and go straight to TCGGO/JustTCG.
const POKEMONTCG_UNRELIABLE = new Set([
  'mep',    // Mega Evolution Promos — pokemontcg.io has completely wrong card names
  'me1',    // Mega Evolution — pokemontcg.io has completely wrong card names
  'me2pt5', // Ascended Heroes — very new
  'wht',    // White Flare — not indexed or incorrect
  'bbt',    // Black Bolt — not indexed or incorrect
]);
// Note: me2 (Phantasmal Flames) and me3 (Perfect Order) are CORRECT on pokemontcg.io.
// sv10 (Destined Rivals) removed — may be indexed correctly now.

// ── Regulation-mark era map ──
// Modern Pokémon cards carry a single-letter regulation mark (D–J) next to
// the card number. Each letter brackets a rotation window and era — when
// Claude reads it, we can cheaply reject candidate matches whose set is
// from the wrong era regardless of how well other signals scored.
const REG_MARK_ERAS = {
  'D': { minYear: 2019, maxYear: 2021, prefix: 'swsh' },
  'E': { minYear: 2021, maxYear: 2023, prefix: 'swsh' },
  'F': { minYear: 2022, maxYear: 2024, prefix: 'swsh' },
  'G': { minYear: 2023, maxYear: 2025, prefix: 'sv' },
  'H': { minYear: 2024, maxYear: 2026, prefix: 'sv' },
  'J': { minYear: 2025, maxYear: 2027, prefix: '' },  // ME era
};

// Returns true if the pokemontcg.io card `d` plausibly belongs to the era
// indicated by `regMark`. Used to reject cross-era matches where Claude
// picked the Pokemon + number correctly but the set is from the wrong
// rotation (e.g. a Pikachu match from 2018 when the card has a G reg mark).
function regMarkMatchesEra(regMark, d) {
  if (!regMark) return true;
  const era = REG_MARK_ERAS[regMark];
  if (!era) return true;
  const setId = (d.set?.id || '').toLowerCase();
  const releaseYear = d.set?.releaseDate ? parseInt(d.set.releaseDate.substring(0, 4)) : 0;
  const prefixMatch = era.prefix ? setId.startsWith(era.prefix) : true;
  const yearMatch = releaseYear && releaseYear >= era.minYear && releaseYear <= era.maxYear;
  return prefixMatch || yearMatch;
}

// ── HARDCODED CORRECTIONS — verified against Pokellector.com ──
// pokemontcg.io maps me1/mep to the wrong sets entirely. These are the correct
// card lists from Pokellector, hardcoded so they're always right.
const POKELLECTOR_CORRECTIONS = {
  'me1': {
    setName: 'Mega Evolution', setCode: 'ME1',
    cards: {
      1:'Bulbasaur',2:'Ivysaur',3:'Mega Venusaur ex',4:'Exeggcute',5:'Exeggutor',
      6:'Tangela',7:'Tangrowth',8:'Chikorita',9:'Bayleef',10:'Meganium',
      11:'Shuckle',12:'Celebi',13:'Seedot',14:'Nuzleaf',15:'Shiftry',
      16:'Nincada',17:'Ninjask',18:'Dhelmise',19:'Vulpix',20:'Ninetales',
      21:'Numel',22:'Mega Camerupt ex',23:'Litleo',24:'Pyroar',25:'Volcanion',
      26:'Scorbunny',27:'Raboot',28:'Cinderace',29:'Sizzlipede',30:'Centiskorch',
      31:'Chi-Yu',32:'Mantine',33:'Corphish',34:'Kyogre',35:'Snover',
      36:'Mega Abomasnow ex',37:'Clauncher',38:'Clawitzer',39:'Sobble',40:'Drizzile',
      41:'Inteleon',42:'Snom',43:'Frosmoth',44:'Eiscue',45:'Magnemite',
      46:'Magneton',47:'Magnezone',48:'Raikou',49:'Electrike',50:'Mega Manectric ex',
      51:'Pachirisu',52:'Helioptile',53:'Heliolisk',54:'Abra',55:'Kadabra',
      56:'Alakazam',57:'Jynx',58:'Ralts',59:'Kirlia',60:'Mega Gardevoir ex',
      61:'Shedinja',62:'Spoink',63:'Grumpig',64:'Xerneas',65:'Greavard',
      66:'Houndstone',67:'Gimmighoul',68:'Sandshrew',69:'Sandslash',70:'Onix',
      71:'Tyrogue',72:'Makuhita',73:'Hariyama',74:'Lunatone',75:'Solrock',
      76:'Riolu',77:'Mega Lucario ex',78:'Croagunk',79:'Toxicroak',80:'Marshadow',
      81:'Stonjourner',82:'Nacli',83:'Naclstack',84:'Garganacl',85:'Crawdaunt',
      86:'Mega Absol ex',87:'Spiritomb',88:'Yveltal',89:'Nickit',90:'Thievul',
      91:'Shroodle',92:'Grafaiai',93:'Steelix',94:'Mega Mawile ex',95:'Dialga',
      96:'Tinkatink',97:'Tinkatuff',98:'Tinkaton',99:'Gholdengo',100:'Mega Latias ex',
      101:'Latios',102:'Spearow',103:'Fearow',104:'Mega Kangaskhan ex',105:'Delibird',
      106:'Miltank',107:'Buneary',108:'Lopunny',109:'Yungoos',110:'Gumshoos',
      111:'Stufful',112:'Bewear',113:"Acerola's Mischief",114:'Boss\'s Orders [Ghetsis]',
      115:'Energy Switch',116:'Fighting Gong',117:'Forest of Vitality',118:'Iron Defender',
      119:"Lillie's Determination",120:"Lt. Surge's Bargain",121:'Mega Signal',
      122:'Mystery Garden',123:'Pokémon Center Lady',124:'Premium Power Pro',
      125:'Rare Candy',126:'Repel',127:'Risky Ruins',128:'Strange Timepiece',
      129:'Surfing Beach',130:'Switch',131:'Ultra Ball',132:"Wally's Compassion",
      133:'Bulbasaur',134:'Ivysaur',135:'Exeggutor',136:'Shuckle',137:'Ninjask',
      138:'Vulpix',139:'Litleo',140:'Snover',141:'Clawitzer',142:'Inteleon',
      143:'Helioptile',144:'Shedinja',145:'Houndstone',146:'Marshadow',147:'Garganacl',
      148:'Spiritomb',149:'Shroodle',150:'Steelix',151:'Spearow',152:'Delibird',
      153:'Gumshoos',154:'Stufful',155:'Mega Venusaur ex',156:'Mega Camerupt ex',
      157:'Mega Abomasnow ex',158:'Mega Manectric ex',159:'Mega Gardevoir ex',
      160:'Mega Lucario ex',161:'Mega Absol ex',162:'Mega Mawile ex',
      163:'Mega Latias ex',164:'Mega Kangaskhan ex',165:"Acerola's Mischief",
      166:'Air Balloon',167:'Buddy-Buddy Poffin',168:'Fighting Gong',
      169:"Lillie's Determination",170:"Lt. Surge's Bargain",171:'Mega Signal',
      172:'Mystery Garden',173:'Night Stretcher',174:'Premium Power Pro',
      175:'Rare Candy',176:"Wally's Compassion",177:'Mega Venusaur ex',
      178:'Mega Gardevoir ex',179:'Mega Lucario ex',180:'Mega Absol ex',
      181:'Mega Latias ex',182:'Mega Kangaskhan ex',183:"Acerola's Mischief",
      184:"Lillie's Determination",185:"Lt. Surge's Bargain",186:"Wally's Compassion",
      187:'Mega Gardevoir ex',188:'Mega Lucario ex',
    }
  },
  'mep': {
    setName: 'Mega Evolution Promos', setCode: 'MEP',
    cards: {
      1:'Meganium',2:'Inteleon',3:'Alakazam',4:'Lunatone',5:'Drifloon',
      6:'Drifblim',7:'Psyduck',8:'Golduck',9:'Alakazam',10:'Riolu',
      11:'Mega Latias ex',12:'Mega Lucario ex',13:'Mega Venusaur ex',14:'Ceruledge',
      15:'Zacian',16:'Flygon',17:'Toxtricity',18:'Cottonee',19:'Whimsicott',
      20:'Sneasel',21:'Weavile',22:'Charcadet',23:'Mega Charizard ex',24:'Oricorio ex',
      25:'Mega Kangaskhan ex',26:'Meloetta',27:'Haunter',28:'Celebratory Fanfare',
      31:"N's Zekrom",32:'Mega Gardevoir ex',33:'Mega Lucario ex',
      36:'Mega Feraligatr ex',64:'Serperior',65:'Barbaracle',66:'Tyrantrum',
      67:'Doublade',69:'Chikorita',70:'Tyrunt',71:'Mega Zygarde ex',
      74:'Delphox',75:'Ampharos',76:'Crobat',77:'Goodra',78:'Toxel',79:'Charmeleon',
    }
  },
};

// ============================================================
// LOCAL CARD DATABASE — Google Sheet + JSON file + in-memory Map
// ============================================================
// On startup:
//   1. Try loading from Google Sheet CSV (if CARD_DB_SHEET_URL is set)
//   2. If no sheet or sheet fails, try data/card-db.json
//   3. If neither, download from pokemontcg.io in background
//   4. After any successful load, save to data/card-db.json as backup
//
// Google Sheet columns: set_id, number, name, set_name, set_code, rarity, hp
// Publish the sheet: File → Share → Publish to web → CSV
// Set env var: CARD_DB_SHEET_URL=https://docs.google.com/spreadsheets/d/.../export?format=csv
//
// The sheet is the editable source of truth — fix card names there.
// Key format: "{setId}-{number}" e.g. "sv8-247", "me2-101"

const CARD_DB_FILE = join(__dirname, 'data', 'card-db.json');
const CARD_DB = new Map();
let cardDbReady = false;
let cardDbCount = 0;
let cardDbLoading = false;
let cardDbDirty = false;   // true if we have new entries not yet saved

// CARD_PRICES is a parallel snapshot of cardmarket.prices (EUR) +
// tcgplayer.prices (USD) per card, populated by the same pokemontcg.io
// pages that fill CARD_DB. Used only by the admin arbitrage tool — kept
// separate from CARD_DB so the lean lookupLocalDb path stays small.
// Sibling JSON file lets us survive restarts without re-downloading.
const CARD_PRICES_FILE = join(__dirname, 'data', 'card-prices.json');
const CARD_PRICES = new Map();
let _lastPriceRefreshAt = 0;

// Apply hardcoded Pokellector corrections — overwrites any bad data for me1/mep
function applyPokellectorCorrections() {
  let count = 0;
  for (const [setId, setData] of Object.entries(POKELLECTOR_CORRECTIONS)) {
    for (const [num, name] of Object.entries(setData.cards)) {
      addCardToDb(setId, String(num), {
        name,
        setName: setData.setName,
        setCode: setData.setCode,
        rarity: '',
        hp: '',
        source: 'pokellector',  // highest trust — verified manually
      });
      count++;
    }
  }
  console.log(`[CARD-DB] Applied ${count} Pokellector corrections (me1: ${Object.keys(POKELLECTOR_CORRECTIONS.me1.cards).length}, mep: ${Object.keys(POKELLECTOR_CORRECTIONS.mep.cards).length})`);
  cardDbDirty = true;
}

function addCardToDb(setId, number, data) {
  const key = `${setId}-${number}`;
  const existing = CARD_DB.get(key);
  // Pokellector data is highest trust — never overwrite it
  if (existing && existing.source === 'pokellector' && data.source !== 'pokellector') {
    return;
  }
  // Don't overwrite trusted sources with sheet data
  if (existing && data.source === 'sheet' &&
      (existing.source === 'fallback' || existing.source === 'tcggo' || existing.source === 'manual')) {
    return;
  }
  CARD_DB.set(key, data);
}

function lookupLocalDb(setId, cardNumber) {
  const cleanNum = String(cardNumber).replace(/^0+/, '') || String(cardNumber);
  const key = `${setId}-${cleanNum}`;
  const entry = CARD_DB.get(key);
  if (entry) {
    // For UNRELIABLE sets, only trust pokellector/tcggo/fallback/manual entries
    if (POKEMONTCG_UNRELIABLE.has(setId)) {
      const trusted = entry.source === 'pokellector' || entry.source === 'tcggo' || entry.source === 'fallback' || entry.source === 'manual';
      if (!trusted) {
        console.log(`[LOCAL-DB] SKIP untrusted entry: ${key} → ${entry.name} (source: ${entry.source || 'none'})`);
        return null;
      }
    }
    console.log(`[LOCAL-DB] HIT: ${key} → ${entry.name} (source: ${entry.source || 'unknown'})`);
    return {
      game: 'pokemon',
      name: entry.name,
      set_name: entry.setName,
      set_code: (entry.setCode || setId).toUpperCase(),
      card_number: cleanNum,
      rarity: entry.rarity || '',
      hp: entry.hp || '',
      reference_image: entry.image || null,
      cardmarket_url: entry.cardmarketUrl || null,
      tcgplayer_url: entry.tcgplayerUrl || null,
      verified: true,
      db_source: 'local-db',
      _manual: true
    };
  }
  return null;
}

// ── SAVE to JSON file ──
function saveCardDbToFile() {
  try {
    const dataDir = join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Convert Map to plain object for JSON
    const obj = {};
    for (const [key, val] of CARD_DB) {
      obj[key] = val;
    }
    fs.writeFileSync(CARD_DB_FILE, JSON.stringify(obj));
    const sizeMB = (fs.statSync(CARD_DB_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[CARD-DB] Saved ${CARD_DB.size} cards to ${CARD_DB_FILE} (${sizeMB} MB)`);
    cardDbDirty = false;
  } catch (e) {
    console.error(`[CARD-DB] Failed to save: ${e.message}`);
  }
}

// ── LOAD from JSON file ──
function loadCardDbFromFile() {
  try {
    if (!fs.existsSync(CARD_DB_FILE)) return false;
    const raw = fs.readFileSync(CARD_DB_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;

    for (const key of keys) {
      CARD_DB.set(key, obj[key]);
    }
    cardDbCount = CARD_DB.size;
    cardDbReady = true;
    const sizeMB = (fs.statSync(CARD_DB_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[CARD-DB] Loaded ${cardDbCount} cards from file (${sizeMB} MB)`);
    return true;
  } catch (e) {
    console.error(`[CARD-DB] Failed to load file: ${e.message}`);
    return false;
  }
}

// ── PRICE SNAPSHOT persistence (admin arbitrage tool) ──
function savePriceDbToFile() {
  try {
    const dataDir = join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const obj = { _lastRefreshAt: _lastPriceRefreshAt, cards: {} };
    for (const [key, val] of CARD_PRICES) obj.cards[key] = val;
    fs.writeFileSync(CARD_PRICES_FILE, JSON.stringify(obj));
    const sizeMB = (fs.statSync(CARD_PRICES_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[PRICE-DB] Saved ${CARD_PRICES.size} priced cards to ${CARD_PRICES_FILE} (${sizeMB} MB)`);
  } catch (e) {
    console.error(`[PRICE-DB] Failed to save: ${e.message}`);
  }
}

function loadPriceDbFromFile() {
  try {
    if (!fs.existsSync(CARD_PRICES_FILE)) return false;
    const raw = fs.readFileSync(CARD_PRICES_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const cards = obj?.cards || obj || {};
    const keys = Object.keys(cards);
    if (keys.length === 0) return false;
    for (const key of keys) CARD_PRICES.set(key, cards[key]);
    _lastPriceRefreshAt = obj?._lastRefreshAt || 0;
    const sizeMB = (fs.statSync(CARD_PRICES_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[PRICE-DB] Loaded ${CARD_PRICES.size} priced cards from file (${sizeMB} MB)`);
    return true;
  } catch (e) {
    console.error(`[PRICE-DB] Failed to load file: ${e.message}`);
    return false;
  }
}

// ── DOWNLOAD from pokemontcg.io ──
// force:true lets the admin "Refresh prices" button kick off a fresh
// pull even after CARD_DB is already loaded. Without it, this short-
// circuits when cardDbLoading or (implicitly via callers) when the DB
// is already populated.
async function downloadCardDatabase({ force = false } = {}) {
  if (cardDbLoading) return;
  cardDbLoading = true;
  const PAGE_SIZE = 250;

  try {
    console.log(force ? '[CARD-DB] Force refresh — pulling all pages from pokemontcg.io...' : '[CARD-DB] No local file — downloading from pokemontcg.io...');
    const firstResp = await axios.get('https://api.pokemontcg.io/v2/cards', {
      params: { pageSize: PAGE_SIZE, page: 1, select: 'id,name,number,rarity,set,hp,supertype,subtypes,cardmarket,tcgplayer,images' },
      timeout: 30000
    });
    const totalCount = firstResp.data?.totalCount || 0;
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    console.log(`[CARD-DB] Total: ${totalCount} cards across ${totalPages} pages`);

    processPageData(firstResp.data?.data || []);
    console.log(`[CARD-DB] Page 1/${totalPages} (${CARD_DB.size} cards, ${CARD_PRICES.size} priced)`);

    const BATCH = 3;
    for (let start = 2; start <= totalPages; start += BATCH) {
      const pages = [];
      for (let p = start; p < start + BATCH && p <= totalPages; p++) {
        pages.push(
          axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { pageSize: PAGE_SIZE, page: p, select: 'id,name,number,rarity,set,hp,supertype,subtypes,cardmarket,tcgplayer,images' },
            timeout: 30000
          }).then(r => {
            processPageData(r.data?.data || []);
            return p;
          }).catch(e => {
            console.log(`[CARD-DB] Page ${p} failed: ${e.message}`);
            return null;
          })
        );
      }
      const done = await Promise.all(pages);
      const maxPage = Math.max(...done.filter(Boolean));
      if (maxPage % 10 === 0 || maxPage === totalPages) {
        console.log(`[CARD-DB] Progress: page ${maxPage}/${totalPages} (${CARD_DB.size} cards, ${CARD_PRICES.size} priced)`);
      }
    }

    cardDbCount = CARD_DB.size;
    cardDbReady = true;
    _lastPriceRefreshAt = Date.now();
    console.log(`[CARD-DB] Download complete! ${cardDbCount} cards (${CARD_PRICES.size} priced).`);

    // Save both files so next restart is instant
    saveCardDbToFile();
    savePriceDbToFile();
  } catch (e) {
    console.error(`[CARD-DB] Download failed: ${e.message}`);
    if (CARD_DB.size > 0) {
      cardDbCount = CARD_DB.size;
      cardDbReady = true;
      console.log(`[CARD-DB] Partial: ${cardDbCount} cards available`);
      saveCardDbToFile();
      if (CARD_PRICES.size > 0) {
        _lastPriceRefreshAt = Date.now();
        savePriceDbToFile();
      }
    }
  }
  cardDbLoading = false;
}

function processPageData(cards) {
  for (const c of cards) {
    const setId = c.set?.id || '';
    const num = c.number || '';
    if (!setId || !num) continue;
    if (POKEMONTCG_UNRELIABLE.has(setId)) continue;

    addCardToDb(setId, num, {
      name: c.name,
      setName: c.set?.name || '',
      setCode: (c.set?.ptcgoCode || setId).toUpperCase(),
      rarity: c.rarity || '',
      hp: c.hp || '',
      supertype: c.supertype || '',
      subtypes: c.subtypes || [],
      image: c.images?.large || c.images?.small || '',
      cardmarketUrl: c.cardmarket?.url || null,
      tcgplayerUrl: c.tcgplayer?.url || null,
      source: 'pokemontcg',
    });

    // Capture price snapshot for the admin arbitrage tool. Skip cards
    // with neither side priced — those can never be arbitrage candidates.
    if (c.tcgplayer?.prices || c.cardmarket?.prices) {
      const cleanNum = String(num).replace(/^0+/, '') || String(num);
      CARD_PRICES.set(`${setId.toLowerCase()}-${cleanNum}`, {
        name: c.name,
        setId,
        setName: c.set?.name || '',
        setCode: (c.set?.ptcgoCode || setId).toUpperCase(),
        number: c.number,
        rarity: c.rarity || '',
        image: c.images?.small || c.images?.large || '',
        cardmarketUrl: c.cardmarket?.url || null,
        tcgplayerUrl: c.tcgplayer?.url || null,
        tcg: c.tcgplayer?.prices || null,
        cm: c.cardmarket?.prices || null,
        fetchedAt: Date.now()
      });
    }
  }
}

// Cache cards from successful fallback lookups so repeat scans are instant
function cacheCardResult(setId, cardNumber, cardData) {
  if (!setId || !cardNumber) return;
  const cleanNum = String(cardNumber).replace(/^0+/, '') || String(cardNumber);
  addCardToDb(setId, cleanNum, {
    name: cardData.name,
    setName: cardData.set_name || '',
    setCode: cardData.set_code || setId.toUpperCase(),
    rarity: cardData.rarity || '',
    hp: cardData.hp || '',
    image: cardData.reference_image || '',
    cardmarketUrl: cardData.cardmarket_url || null,
    tcgplayerUrl: cardData.tcgplayer_url || null,
    source: 'fallback',
  });
  cardDbDirty = true;
  console.log(`[LOCAL-DB] Cached: ${setId}-${cleanNum} → ${cardData.name}`);
}

// Periodically save dirty cache (every 5 min if new entries were added)
setInterval(() => {
  if (cardDbDirty && CARD_DB.size > 0) {
    saveCardDbToFile();
  }
}, 5 * 60 * 1000);

// Status endpoint
app.get('/api/card-db-status', (req, res) => {
  res.json({
    ready: cardDbReady,
    loading: cardDbLoading,
    count: CARD_DB.size,
    fileExists: fs.existsSync(CARD_DB_FILE),
  });
});

// ── LOAD from Google Sheet CSV ──
async function loadCardDbFromSheet() {
  const sheetUrl = process.env.CARD_DB_SHEET_URL;
  if (!sheetUrl) return false;

  try {
    console.log('[CARD-DB] Fetching Google Sheet CSV...');
    const resp = await axios.get(sheetUrl, { timeout: 30000, responseType: 'text' });
    const csv = resp.data;
    if (!csv || csv.length < 50) {
      console.log('[CARD-DB] Sheet is empty or too small');
      return false;
    }

    // Parse CSV — columns: set_id, number, name, set_name, set_code, rarity, hp
    const lines = csv.split('\n');
    const header = lines[0].toLowerCase();
    if (!header.includes('set_id') && !header.includes('name')) {
      console.log('[CARD-DB] Sheet missing expected headers');
      return false;
    }

    let loaded = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Simple CSV parse (handles quoted fields with commas)
      const cols = parseCSVLine(line);
      if (cols.length < 3) continue;

      const setId = (cols[0] || '').trim();
      const num = (cols[1] || '').trim();
      const name = (cols[2] || '').trim();
      if (!setId || !num || !name) continue;

      // Check for "verified" column (col 7) — if present and truthy,
      // trust this entry even for UNRELIABLE sets (Dave manually fixed it)
      const verified = (cols[7] || '').trim().toLowerCase();
      const isVerified = verified === 'yes' || verified === 'true' || verified === '1';

      addCardToDb(setId, num, {
        name: name,
        setName: (cols[3] || '').trim(),
        setCode: (cols[4] || setId).trim().toUpperCase(),
        rarity: (cols[5] || '').trim(),
        hp: (cols[6] || '').trim(),
        source: isVerified ? 'manual' : 'sheet',
      });
      loaded++;
    }

    if (loaded > 0) {
      cardDbCount = CARD_DB.size;
      cardDbReady = true;
      console.log(`[CARD-DB] Loaded ${loaded} cards from Google Sheet`);
      // Save to JSON file as backup
      saveCardDbToFile();
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[CARD-DB] Google Sheet fetch failed: ${e.message}`);
    return false;
  }
}

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Export current DB as CSV — use this to populate the Google Sheet
app.get('/api/card-db-export', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="card-db.csv"');

  let csv = 'set_id,number,name,set_name,set_code,rarity,hp\n';
  for (const [key, val] of CARD_DB) {
    const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    const [setId, num] = key.split('-');
    csv += `${esc(setId)},${esc(num)},${esc(val.name)},${esc(val.setName)},${esc(val.setCode)},${esc(val.rarity)},${esc(val.hp)}\n`;
  }
  res.send(csv);
});

// Manual rebuild endpoint — re-download from pokemontcg.io
app.post('/api/card-db-rebuild', (req, res) => {
  if (cardDbLoading) return res.json({ status: 'already loading', count: CARD_DB.size });
  CARD_DB.clear();
  cardDbReady = false;
  downloadCardDatabase();
  res.json({ status: 'rebuild started' });
});

// ── BULK IMPORT: fetch all cards for UNRELIABLE sets from TCGGO ──
// Runs once after main DB loads. Replaces bad pokemontcg.io data with correct
// TCGGO data so scanning is instant local lookups with zero per-scan API calls.
let unreliableImportDone = false;
async function importUnreliableSetsFromTCGGO() {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.log('[TCGGO-IMPORT] No RAPIDAPI_KEY — skipping unreliable set import');
    return;
  }
  if (unreliableImportDone) return;

  const setsToImport = [...POKEMONTCG_UNRELIABLE]
    .filter(s => PKM_SET_NAMES[s]); // only sets we have names for

  console.log(`[TCGGO-IMPORT] Importing ${setsToImport.length} unreliable sets: ${setsToImport.join(', ')}`);
  let totalImported = 0;

  for (const setId of setsToImport) {
    const setName = PKM_SET_NAMES[setId];
    let page = 1;
    let setCount = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
          params: { search: setName, per_page: 50, page },
          headers: {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
            'Accept': 'application/json'
          },
          timeout: 15000
        });

        const data = resp.data?.data;
        if (!data || data.length === 0) {
          hasMore = false;
          break;
        }

        for (const card of data) {
          // Only keep cards whose episode/set name matches what we searched for
          const epName = (card.episode?.name || '').toLowerCase();
          const epCode = (card.episode?.code || '').toUpperCase();
          if (!epName.includes(setName.toLowerCase()) && epCode !== setId.toUpperCase()) continue;

          const num = String(card.card_number || '').replace(/^0+/, '');
          if (!num) continue;

          addCardToDb(setId, num, {
            name: card.name,
            setName: card.episode?.name || setName,
            setCode: (card.episode?.code || setId).toUpperCase(),
            rarity: card.rarity || '',
            hp: '',
            image: card.image || '',
            source: 'tcggo',  // trusted — won't be skipped for UNRELIABLE sets
          });
          setCount++;
        }

        // If fewer results than per_page, we've hit the last page
        if (data.length < 50) {
          hasMore = false;
        } else {
          page++;
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        if (e.response?.status === 429) {
          console.log(`[TCGGO-IMPORT] Rate limited on ${setName} page ${page} — pausing 5s`);
          await new Promise(r => setTimeout(r, 5000));
          continue; // retry same page
        }
        console.log(`[TCGGO-IMPORT] Error on ${setName} page ${page}: ${e.response?.status || e.message}`);
        hasMore = false;
      }
    }

    console.log(`[TCGGO-IMPORT] ${setName} (${setId}): ${setCount} cards imported`);
    totalImported += setCount;

    // Small delay between sets
    await new Promise(r => setTimeout(r, 500));
  }

  if (totalImported > 0) {
    cardDbDirty = true;
    cardDbCount = CARD_DB.size;
    console.log(`[TCGGO-IMPORT] Done — imported ${totalImported} cards across ${setsToImport.length} sets (DB total: ${CARD_DB.size})`);
    saveCardDbToFile();
  }
  unreliableImportDone = true;
}

// Manual trigger endpoint
app.post('/api/card-db-import-unreliable', (req, res) => {
  unreliableImportDone = false; // allow re-run
  importUnreliableSetsFromTCGGO();
  res.json({ status: 'import started', sets: [...POKEMONTCG_UNRELIABLE].filter(s => PKM_SET_NAMES[s]) });
});

// ── STARTUP: Google Sheet → JSON file → API download → apply corrections ──
async function initCardDb() {
  // 1. Google Sheet (editable source of truth)
  const fromSheet = await loadCardDbFromSheet();
  if (!fromSheet) {
    // 2. Local JSON file (fast backup)
    const fromFile = loadCardDbFromFile();
    if (!fromFile) {
      // 3. Download from pokemontcg.io (slow but self-healing) —
      //    this also populates CARD_PRICES + writes both files.
      await downloadCardDatabase();
    }
  }

  // 4. ALWAYS apply Pokellector corrections — overwrites any wrong me1/mep data
  //    regardless of where it came from. These are hardcoded and verified.
  applyPokellectorCorrections();
  saveCardDbToFile();

  // 5. Lazy-load price snapshot (admin arbitrage tool only). Missing
  //    file is fine — admin clicks "Refresh prices" to populate.
  if (CARD_PRICES.size === 0) loadPriceDbFromFile();
}
initCardDb();

// Resolve a user-typed set code to an API set.id
function resolveSetCode(raw) {
  if (!raw) return { setId: null, ptcgoCode: null, aliased: false };
  const upper = String(raw).toUpperCase().trim();
  const lower = String(raw).toLowerCase().trim();
  const mapped = PKM_SET_ALIASES[upper];
  if (mapped) {
    console.log(`[SET-ALIAS] "${upper}" -> set.id "${mapped}"`);
    return { setId: mapped, ptcgoCode: upper, aliased: true };
  }
  // No alias found — try as-is (might already be a valid set.id or ptcgoCode)
  return { setId: lower, ptcgoCode: upper, aliased: false };
}

// ============================================================
// FALLBACK: TCGdex card lookup (free, open-source Pokemon TCG database)
// ============================================================
async function lookupTCGdex(setId, cardNumber) {
  // Map our internal set.id to TCGdex's set ID format
  const tcgdexSetId = TCGDEX_SET_MAP[setId] || setId;
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const cardId = `${tcgdexSetId}-${cleanNum}`;
  console.log(`[TCGdex] Looking up: ${cardId}`);
  try {
    const resp = await axios.get(`https://api.tcgdex.net/v2/en/cards/${cardId}`, { timeout: 8000 });
    const d = resp.data;
    if (!d || !d.name) return null;
    console.log(`[TCGdex] Found: ${d.name} (${d.set?.name || '?'})`);
    return {
      game: 'pokemon',
      name: d.name,
      set_name: d.set?.name || null,
      set_code: (d.set?.id || setId).toUpperCase(),
      card_number: d.localId || cleanNum,
      rarity: d.rarity || null,
      hp: d.hp ? String(d.hp) : null,
      reference_image: d.image ? `${d.image}/high.webp` : null,
      verified: true,
      db_source: 'tcgdex.net (fallback)',
      _manual: true
    };
  } catch (e) {
    console.log(`[TCGdex] ${cardId} failed: ${e.response?.status || e.message}`);
    return null;
  }
}

// FALLBACK: TCGGO search by set name + card number
// Used when both pokemontcg.io and TCGdex don't have a set.
// Tries multiple search strategies for best results.
async function lookupViaTCGGO(setId, cardNumber, rawSetCode) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const paddedNum = cleanNum.padStart(3, '0');

  // Try multiple search terms — promo sets need different strategies
  const searchTerms = [];
  // 1. Raw set code + padded number (e.g. "MEP 026") — how it appears on the card
  if (rawSetCode) searchTerms.push(`${rawSetCode} ${paddedNum}`);
  // 2. Set name + number (e.g. "Mega Evolution Promos 26")
  if (setName) searchTerms.push(`${setName} ${cleanNum}`);
  // 3. Set name + padded number
  if (setName) searchTerms.push(`${setName} ${paddedNum}`);
  // 4. Raw code without number, broader search
  if (rawSetCode) searchTerms.push(`${rawSetCode} promo ${cleanNum}`);

  if (!searchTerms.length) {
    console.log(`[TCGGO-FALLBACK] No search terms for "${setId}" — skipping`);
    return null;
  }

  for (const searchTerm of searchTerms) {
    console.log(`[TCGGO-FALLBACK] Searching: "${searchTerm}"`);
    try {
      const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
        params: { search: searchTerm, per_page: 10 },
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      const data = resp.data?.data;
      if (!data || data.length === 0) continue;

      // Score results — card number match is REQUIRED, set match is bonus
      let best = null;
      let bestScore = 0;
      for (const item of data) {
        const itemNum = String(item.card_number || '');
        // Card number MUST match — skip items that don't
        if (itemNum !== cleanNum && itemNum !== paddedNum && itemNum !== cardNumber) continue;

        let score = 60; // base score for number match
        const epName = (item.episode?.name || '').toLowerCase();
        const epCode = (item.episode?.code || '').toUpperCase();
        // Set name/code match
        if (setName && epName.includes(setName.toLowerCase())) score += 40;
        if (rawSetCode && epCode === rawSetCode.toUpperCase()) score += 50;
        // Prefer promo matches for promo sets
        if (setId.endsWith('p') || setId === 'mep') {
          if (epName.includes('promo')) score += 20;
        }
        if (score > bestScore) { bestScore = score; best = item; }
      }

      if (best) {
        console.log(`[TCGGO-FALLBACK] Found: ${best.name} (${best.episode?.name || '?'} #${best.card_number}) [score ${bestScore}]`);
        return {
          game: 'pokemon',
          name: best.name,
          set_name: best.episode?.name || setName || rawSetCode,
          set_code: (best.episode?.code || rawSetCode || setId).toUpperCase(),
          card_number: String(best.card_number || cleanNum),
          rarity: best.rarity || null,
          reference_image: best.image || null,
          verified: true,
          db_source: 'tcggo.com (fallback)',
          _manual: true
        };
      }
    } catch (e) {
      if (e.response?.status === 429) {
        console.log('[TCGGO-FALLBACK] Rate limited — stopping');
        return null;
      }
      console.log(`[TCGGO-FALLBACK] Error: ${e.response?.status || e.message}`);
    }
  }

  console.log(`[TCGGO-FALLBACK] No match after all search strategies for ${rawSetCode || setId} #${cleanNum}`);
  return null;
}

// FALLBACK: JustTCG search by set name + card number
async function lookupViaJustTCG(setId, cardNumber) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  if (!setName) return null;

  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const searchQuery = `${setName} ${cleanNum}`;
  console.log(`[JustTCG-FALLBACK] Searching: "${searchQuery}"`);

  try {
    const resp = await axios.get('https://api.justtcg.com/v1/cards', {
      params: { q: searchQuery, game: 'pokemon', limit: 5 },
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 10000
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      console.log('[JustTCG-FALLBACK] No results');
      return null;
    }

    // Find best match by card number
    let best = data[0];
    let bestScore = 0;
    for (const item of data) {
      let score = 0;
      const itemNum = (item.number || '').replace(/\/.*/, '');
      if (itemNum === cleanNum) score += 60;
      if (item.set_name?.toLowerCase().includes(setName.toLowerCase())) score += 40;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    console.log(`[JustTCG-FALLBACK] Found: ${best.name} (${best.set_name || '?'} #${best.number})`);
    return {
      game: 'pokemon',
      name: best.name,
      set_name: best.set_name || setName,
      set_code: setId.toUpperCase(),
      card_number: best.number || cleanNum,
      rarity: best.rarity || null,
      reference_image: best.image_url || null,
      verified: true,
      db_source: 'justtcg.com (fallback)',
      _manual: true
    };
  } catch (e) {
    console.log(`[JustTCG-FALLBACK] Error: ${e.response?.status || e.message}`);
    return null;
  }
}

// ============================================================
// MANUAL IDENTIFY: /api/identify-manual
// ============================================================
// Skip Claude entirely — operator types in set code + card number (+ optional name)
// and we resolve it against the relevant card database directly.
// Use when scans are failing (sleeves, glare, damaged cards) and speed matters.
//
// Request body: { game: 'pokemon'|'magic'|..., set_code, card_number, name? }
// Response: { cards: [<one card shaped like /api/identify output>] }
app.post('/api/identify-manual', requireAuth, enforceQuota, async (req, res) => {
  logScanEvent(req.user.id, '/api/identify-manual');
  try {
    const { game, set_code, card_number, name } = req.body || {};
    if (!game) return res.status(400).json({ error: 'game is required' });
    if (!card_number) return res.status(400).json({ error: 'card_number is required' });

    const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);
    let card = null;

    if (game === 'pokemon') {
      // Resolve aliases first (e.g. PAL -> sv2, OBF -> sv3, MEW -> sv3pt5)
      const resolved = set_code ? resolveSetCode(set_code) : { setId: null, ptcgoCode: null };

      // ── LOCAL DB CHECK (instant, no API call) ──
      if (resolved.setId) {
        card = lookupLocalDb(resolved.setId, cleanNum);
        if (card) {
          console.log(`[MANUAL-PKM] Local DB hit: ${card.name} (${resolved.setId}-${cleanNum})`);
          return res.json({ cards: [card] });
        }
      }

      // Try set-code-scoped search first, then fall back to number-only.
      const queries = [];
      if (resolved.setId) {
        queries.push(`set.id:${resolved.setId} number:${cleanNum}`);
      }
      // Only try ptcgoCode search if we did NOT resolve via our alias table.
      // Reason: ptcgoCodes can be reused/reassigned (e.g. PRE = Journey Together
      // in the API, but our alias correctly maps PRE -> sv8pt5 Prismatic Evolutions).
      // Using ptcgoCode after a known alias would return the WRONG set.
      if (resolved.ptcgoCode && !resolved.aliased) {
        queries.push(`set.ptcgoCode:${resolved.ptcgoCode} number:${cleanNum}`);
      }
      // Also try the raw input in case it's already a valid set.id we don't have aliased
      if (set_code && !resolved.aliased && resolved.setId !== String(set_code).toLowerCase()) {
        queries.push(`set.id:${String(set_code).toLowerCase()} number:${cleanNum}`);
      }
      if (name) queries.push(`name:"${name}" number:${cleanNum}`);
      // Only fall back to bare number search if a name was given (to avoid
      // random matches like Primal Groudon #151 when user meant MEW 151).
      if (name) queries.push(`number:${cleanNum} name:"${name}"`);

      // Skip pokemontcg.io entirely for sets with known bad data.
      // Go straight to TCGGO/JustTCG fallback chain instead.
      const skipPokemonTCG = resolved.setId && POKEMONTCG_UNRELIABLE.has(resolved.setId);
      if (skipPokemonTCG) {
        console.log(`[MANUAL-PKM] Skipping pokemontcg.io for unreliable set "${resolved.setId}" — going to fallbacks`);
      }

      // Also try direct card ID lookup: pokemontcg.io stores cards as {setId}-{number}
      // e.g. sv3pt5-151. This is the fastest and most reliable approach.
      if (resolved.setId && !skipPokemonTCG) {
        const directId = `${resolved.setId}-${cleanNum}`;
        console.log(`[MANUAL-PKM] Direct lookup: ${directId}`);
        try {
          const resp = await axios.get(`https://api.pokemontcg.io/v2/cards/${directId}`, { timeout: 10000 });
          const best = resp.data?.data;
          if (best) {
            card = {
              game: 'pokemon',
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              reference_image: best.images?.large || best.images?.small,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              verified: true,
              db_source: 'pokemontcg.io (manual)',
              _manual: true
            };
            console.log(`[MANUAL-PKM] Direct hit: ${best.name} (${directId})`);
          }
        } catch (e) {
          console.log(`[MANUAL-PKM] Direct lookup ${directId} failed: ${e.message}`);
        }
      }

      // If direct lookup didn't work, fall back to search queries.
      if (!card && !skipPokemonTCG) {
        for (const q of queries) {
          console.log(`[MANUAL-PKM] Trying: ${q}`);
          try {
            const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q, pageSize: 10 }, timeout: 10000
            });
            const results = resp.data?.data;
            if (!results?.length) continue;
            // If we have a name, prefer an exact-name match.
            let best = results[0];
            if (name) {
              const exact = results.find(d => d.name?.toLowerCase() === String(name).toLowerCase());
              if (exact) best = exact;
            }
            card = {
              game: 'pokemon',
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              reference_image: best.images?.large || best.images?.small,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              verified: true,
              db_source: 'pokemontcg.io (manual)',
              _manual: true
            };
            break;
          } catch (e) {
            console.error(`[MANUAL-PKM] Query failed: ${e.message}`);
          }
        }
      }

      // ── FALLBACK CHAIN when pokemontcg.io doesn't have the set ──
      if (!card && resolved.setId) {
        console.log(`[MANUAL-PKM] pokemontcg.io miss — trying fallback APIs for ${resolved.setId} #${cleanNum}`);

        // Race the two FREE fallbacks — TCGdex + JustTCG — and take the
        // first one to return a hit. Both are safe to fire speculatively
        // (no per-call quota cost). Race uses never-resolves for null so
        // Promise.race only fires on a real result; allSettled tail
        // resolves when all finish (so we exit cleanly on full miss).
        const racers = [
          lookupTCGdex(resolved.setId, cleanNum),
          lookupViaJustTCG(resolved.setId, cleanNum)
        ];
        card = await Promise.race([
          ...racers.map(p => p.then(r => r || new Promise(() => {}))),
          Promise.allSettled(racers).then(rs => rs.find(s => s.status === 'fulfilled' && s.value)?.value || null)
        ]);

        // TCGGO costs RapidAPI quota — only call it if both free APIs missed.
        if (!card) {
          card = await lookupViaTCGGO(resolved.setId, cleanNum, set_code);
        }

        if (card) {
          console.log(`[MANUAL-PKM] Fallback success: ${card.name} via ${card.db_source}`);
        } else {
          console.log(`[MANUAL-PKM] All fallbacks exhausted for ${set_code} #${cleanNum}`);
        }
      }
    } else if (game === 'magic') {
      // Scryfall supports direct set+collector number lookup.
      const sc = set_code ? String(set_code).toLowerCase() : null;
      if (sc) {
        try {
          const url = `https://api.scryfall.com/cards/${sc}/${cleanNum}`;
          console.log(`[MANUAL-MTG] GET ${url}`);
          const resp = await axios.get(url, { timeout: 10000 });
          const d = resp.data;
          card = {
            game: 'magic',
            name: d.name,
            set_name: d.set_name,
            set_code: d.set?.toUpperCase(),
            card_number: d.collector_number,
            rarity: d.rarity,
            reference_image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
            cardmarket_url: d.purchase_uris?.cardmarket || null,
            tcgplayer_url: d.purchase_uris?.tcgplayer || null,
            verified: true,
            db_source: 'scryfall.com (manual)',
            _manual: true
          };
        } catch (e) {
          console.error(`[MANUAL-MTG] Direct lookup failed: ${e.message}`);
        }
      }
      // Name-based fallback
      if (!card && name) {
        try {
          const resp = await axios.get('https://api.scryfall.com/cards/named', {
            params: { exact: name, set: sc || undefined }, timeout: 10000
          });
          const d = resp.data;
          card = {
            game: 'magic',
            name: d.name, set_name: d.set_name, set_code: d.set?.toUpperCase(),
            card_number: d.collector_number, rarity: d.rarity,
            reference_image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
            cardmarket_url: d.purchase_uris?.cardmarket || null,
            tcgplayer_url: d.purchase_uris?.tcgplayer || null,
            verified: true, db_source: 'scryfall.com (manual)', _manual: true
          };
        } catch (e) { console.error(`[MANUAL-MTG] Named fallback failed: ${e.message}`); }
      }
    } else {
      // Generic / fallback: just build a shell card from the inputs so pricing can still try.
      card = {
        game,
        name: name || `${set_code || ''} #${card_number}`.trim(),
        set_name: set_code || null,
        set_code: set_code ? String(set_code).toUpperCase() : null,
        card_number: cleanNum,
        verified: false,
        _manual: true,
        db_source: 'manual entry (no DB lookup for ' + game + ')'
      };
    }

    if (!card) {
      return res.status(404).json({ error: 'No card found for that set/number combination. Double-check the set code and number.' });
    }

    // Cache successful lookups in local DB for instant future hits
    if (card.game === 'pokemon' && set_code) {
      const resolved2 = resolveSetCode(set_code);
      if (resolved2.setId) {
        cacheCardResult(resolved2.setId, cleanNum, card);
      }
    }

    res.json({ cards: [card] });
  } catch (err) {
    console.error('[MANUAL] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// READ SET CODE: /api/read-set-code
// ============================================================
// Lightweight Claude Vision call — reads ONLY the set code + card number
// from the bottom of a card image.  Much cheaper than full identify because
// the prompt is tiny, the response is a few tokens, and we use Haiku.
// Returns: { text: "MEP 066" } or { text: "DRI 204/182" } or { error }
app.post('/api/read-set-code', identifyLimiter, requireAuth, enforceQuota, async (req, res) => {
  logScanEvent(req.user.id, '/api/read-set-code');
  try {
    const dataUrl = req.body?.image;
    if (!dataUrl) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const match = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image data URL' });
    }

    // Pass image through with minimal processing — JPEG 0.98 from client.
    // Only downscale if over 4MB (Claude's limit), otherwise send as-is.
    const rawBuffer = Buffer.from(match[2], 'base64');
    let imageBase64, mediaType;
    if (rawBuffer.length > 4 * 1024 * 1024) {
      const resized = await sharp(rawBuffer)
        .resize({ width: 3200, withoutEnlargement: true })
        .jpeg({ quality: 98 })
        .toBuffer();
      imageBase64 = resized.toString('base64');
      mediaType = 'image/jpeg';
      console.log(`[READ-SET-CODE] Resized (too large): ${(rawBuffer.length/1024).toFixed(0)}KB → ${(resized.length/1024).toFixed(0)}KB`);
    } else {
      imageBase64 = match[2];
      mediaType = match[1];
      console.log(`[READ-SET-CODE] Passthrough: ${(rawBuffer.length/1024).toFixed(0)}KB (${mediaType})`);
    }

    console.log('[READ-SET-CODE] Sending to Claude Sonnet 4.6...');
    const t0 = Date.now();

    // Upgraded from Haiku 4.5 to Sonnet 4.6 — the OCR-first path returns
    // cards with zero name/HP validation downstream, so a single-char misread
    // is a silent wrong-card failure. Sonnet 4.6 is materially better on
    // small printed text (leading zeros, letter-shape confusions like M/W,
    // G/C, E/F). The ~10x cost bump is pennies per scan.
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 }
          },
          {
            type: 'text',
            text: `Read the set code and card number printed on this Pokemon card. Look near the bottom of the card for small text.

CRITICAL — PRESERVE LEADING ZEROS. If the printed number is "027", report "027". NOT "27" and NOT "2". Dropping zeros sends this card to the wrong entry in our database and returns a completely different card. "003/165" is NOT "3/165". This is the #1 failure mode — treat every digit you see as load-bearing, including leading zeros.

FORMATS to look for (check all):

1. MODERN (most common): [reg mark] [SET CODE] [LANG] [NUMBER]
   The set code is 2-4 uppercase letters, often in a small box. Examples:
   MEP EN 066 → return "MEP 066"
   DRI EN 204/182 → return "DRI 204/182"
   SVP EN 153 → return "SVP 153"
   WHT EN 131/086 → return "WHT 131/086"

2. SWSH PROMOS: SWSH followed by 3 digits, e.g. SWSH020, SWSH066
   Return as-is: "SWSH020"

3. GALARIAN GALLERY: GG + number / GG + number, e.g. GG31/GG70
   Return as-is: "GG31/GG70"

4. OLDER CARDS: Just a regulation mark (D, E, F) + number, no set code box.
   Return: "NONE"

VALID SET CODES (read the letters VERY carefully — M vs W, E vs F, G vs C matter):
SVI, PAL, OBF, MEW, PAR, PAF, TEF, TWM, SFA, SCR, SSP, PRE, JTG, DRI,
MEG, PFL, POR, SVP, MEP, WHT, BBT, ASH, DIA,
SSH, RCL, DAA, CPA, VIV, BST, CRE, EVS, FST, BRS, ASR, LOR, SIT, CRZ, SWP

SET TOTAL HINTS (use the number after "/" to verify you read the set code correctly):
MEG = /132, PFL = /094, POR = /088, MEP has no total, WHT = /086, BBT = /086,
DRI = /182, SSP = /191, SVI = /198, MEW = /165, SVP has no total, DIA = /182
If the total doesn't match the set code, re-read the set code letters more carefully.

Return ONLY the set code and number. If you cannot read any set code, respond: NONE`
          }
        ]
      }]
    });

    let raw = (response.content?.[0]?.text || '').trim();
    const elapsed = Date.now() - t0;
    console.log(`[READ-SET-CODE] ${elapsed}ms → raw "${raw}"`);

    // Post-process: strip markdown bold, extract code from verbose response
    raw = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '');
    // If Haiku gave a verbose response, try to extract a code from it
    if (raw.length > 30) {
      // Look for patterns like "DRI 244/182" or "SWSH020" or "GG31/GG70" in the text
      const codeMatch = raw.match(/\b([A-Z]{2,5})\s+(?:EN\s+)?(\d{1,4}(?:\s*\/\s*\d{1,4})?)\b/)
        || raw.match(/\bSWSH\d{3,4}\b/)
        || raw.match(/\bGG\d{1,3}\s*\/\s*GG\d{1,3}\b/);
      if (codeMatch) {
        raw = codeMatch[0].replace(/\s*EN\s+/, ' ');
        console.log(`[READ-SET-CODE] Extracted from verbose: "${raw}"`);
      } else {
        raw = 'NONE';
      }
    }
    // Fix common Haiku merge: "PFLEN" → "PFL", "DRIEN" → "DRI"
    raw = raw.replace(/^([A-Z]{2,4})(EN)\s/, '$1 ');

    // ── SET TOTAL VALIDATION ──
    // If Haiku read "MEP 151/132" but MEP has no /132, the set code is wrong.
    // Use the total to correct misreads like MEP→MEG, WHT→POR, etc.
    const SET_TOTALS = {
      'MEG':'132','PFL':'094','POR':'088','WHT':'086','BBT':'086',
      'DRI':'182','SSP':'191','SVI':'198','MEW':'165','DIA':'182',
      'PAL':'198','OBF':'197','PAR':'182','PAF':'091','TEF':'162',
      'TWM':'167','SFA':'064','SCR':'156','PRE':'175','JTG':'182',
      'SSH':'202','RCL':'192','DAA':'189','VIV':'185','BST':'163',
      'CRE':'198','EVS':'203','FST':'264','BRS':'172','ASR':'189',
      'LOR':'196','SIT':'195','CRZ':'230',
    };
    const totalMatch = raw.match(/^([A-Z]{2,4})\s+(\d+)\s*\/\s*(\d+)$/);
    if (totalMatch) {
      const [, readCode, cardNum, total] = totalMatch;
      const expectedTotal = SET_TOTALS[readCode];
      if (expectedTotal && expectedTotal !== total) {
        // Total doesn't match — find which set DOES have this total
        const correctCode = Object.entries(SET_TOTALS).find(([, t]) => t === total)?.[0];
        if (correctCode) {
          const corrected = `${correctCode} ${cardNum}/${total}`;
          console.log(`[READ-SET-CODE] CORRECTED: "${raw}" → "${corrected}" (total /${total} matches ${correctCode}, not ${readCode})`);
          raw = corrected;
        }
      }
    }

    console.log(`[READ-SET-CODE] ${elapsed}ms → final "${raw}"`);

    if (!raw || raw === 'NONE') {
      return res.status(404).json({ error: 'Could not read set code from image' });
    }

    res.json({ text: raw });
  } catch (err) {
    console.error('[READ-SET-CODE] Error:', err.message, err.status || '', err.error?.message || '');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BAD-ID FEEDBACK: /api/report-bad-id
// ============================================================
// Append a JSONL line to logs/bad-ids.log with the card + reason the user
// flagged. Useful to spot systematic ID failures (e.g. "always mis-IDs
// reverse-holo Pikachus from Evolving Skies") without needing a DB.
app.post('/api/report-bad-id', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const { card, reason, image, timestamp, ua } = req.body || {};
    const logDir = join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const entry = {
      t: new Date().toISOString(),
      reason: (reason || '').slice(0, 500),
      card: card ? {
        name: card.name, game: card.game, set_name: card.set_name,
        set_code: card.set_code, card_number: card.card_number,
        rarity: card.rarity, variant: card.variant
      } : null,
      had_image: !!image,
      ua: (ua || '').slice(0, 200),
      orig_timestamp: timestamp
    };
    fs.appendFileSync(join(logDir, 'bad-ids.log'), JSON.stringify(entry) + '\n');
    console.log(`[BAD-ID] ${entry.card?.name || '?'} — ${entry.reason || '(no reason)'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[BAD-ID] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CORRECT CARD: /api/correct-card
// ============================================================
// User taps a wrong card name and types the correct one.
// Overwrites the entry in the local DB with source 'manual' (highest trust).
// Persists through restarts via the JSON file.
app.post('/api/correct-card', express.json(), (req, res) => {
  try {
    const { set_code, card_number, correct_name } = req.body || {};
    if (!set_code || !card_number || !correct_name) {
      return res.status(400).json({ error: 'set_code, card_number, and correct_name required' });
    }

    const resolved = resolveSetCode(set_code);
    const setId = resolved.setId || set_code.toLowerCase();
    const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);

    // Get existing entry to preserve metadata, or create fresh
    const key = `${setId}-${cleanNum}`;
    const existing = CARD_DB.get(key) || {};

    // Overwrite with manual correction — force source to 'manual'
    CARD_DB.set(key, {
      ...existing,
      name: correct_name.trim(),
      setName: existing.setName || PKM_SET_NAMES[setId] || set_code,
      setCode: (existing.setCode || set_code).toUpperCase(),
      source: 'manual',  // highest trust, never overwritten
    });

    cardDbDirty = true;
    cardDbCount = CARD_DB.size;
    saveCardDbToFile();

    console.log(`[CORRECT] ${key}: "${existing.name || '?'}" → "${correct_name.trim()}" (manual override)`);
    res.json({ ok: true, key, oldName: existing.name || null, newName: correct_name.trim() });
  } catch (err) {
    console.error('[CORRECT] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// OCR-FIRST LOOKUP: /api/lookup-by-number
// ============================================================
// The client runs Tesseract.js locally, parses the card number, and hits
// this endpoint. If we can pinpoint exactly one card from the number alone,
// we skip Claude entirely (~300ms vs ~2.5s). If not, the client falls back
// to /api/identify.
//
// Body: { number: "123/456", setCode?: "swsh9", game?: "pokemon"|"magic" }
// Returns: { cards: [verifiedCard] } on match, or 404 on no-match/ambiguous.
app.post('/api/lookup-by-number', requireAuth, enforceQuota, express.json(), async (req, res) => {
  logScanEvent(req.user.id, '/api/lookup-by-number');
  try {
    const { number, set_code: setCode, game, reg_mark } = req.body || {};
    if (!number || typeof number !== 'string') {
      return res.status(400).json({ error: 'number required' });
    }

    const raw = number.trim();

    // Try Scryfall first if we have an explicit setCode (Magic).
    if (setCode && (game === 'magic' || !game)) {
      const numOnly = raw.split('/')[0].replace(/^0+/, '') || raw;
      try {
        const resp = await axios.get(
          `https://api.scryfall.com/cards/${encodeURIComponent(setCode.toLowerCase())}/${encodeURIComponent(numOnly)}`,
          { timeout: 6000 }
        );
        const d = resp.data;
        if (d && d.name) {
          const card = {
            game: 'magic',
            name: d.name,
            set_name: d.set_name,
            set_code: (d.set || '').toUpperCase(),
            card_number: d.collector_number,
            rarity: d.rarity,
            image_url: d.image_uris?.normal || d.image_uris?.large,
            cardmarket_url: d.purchase_uris?.cardmarket || null,
            tcgplayer_url: d.purchase_uris?.tcgplayer || null,
            source: 'scryfall.com (ocr-direct)'
          };
          console.log(`[OCR-LOOKUP] Scryfall HIT: ${card.name} ${card.set_code} #${card.card_number}`);
          return res.json({ cards: [card] });
        }
      } catch (e) {
        console.log(`[OCR-LOOKUP] Scryfall miss: ${e.message}`);
      }
    }

    // Pokemon TCG lookup — handles both "123/456" and promo formats like SM211.
    // We search by number, optionally narrowing by printedTotal from "xx/yy" form.
    const hasSlash = raw.includes('/');
    let numPart, totalPart;
    if (hasSlash) {
      const [a, b] = raw.split('/');
      numPart = (a || '').replace(/^0+/, '') || a;
      totalPart = (b || '').replace(/^0+/, '') || b;
    } else {
      numPart = raw;
    }

    if (game !== 'magic') {
      const queries = [];
      if (hasSlash && numPart && totalPart) {
        queries.push(`number:"${numPart}" set.printedTotal:${totalPart}`);
        queries.push(`number:"${numPart}" set.total:${totalPart}`);
      } else if (numPart) {
        queries.push(`number:"${numPart}"`);
      }

      for (const q of queries) {
        try {
          const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q, pageSize: 10 },
            timeout: 6000
          });
          const results = resp.data?.data || [];
          if (results.length === 1) {
            const d = results[0];
            const card = {
              game: 'pokemon',
              name: d.name,
              set_name: d.set?.name,
              set_code: (d.set?.id || '').toUpperCase(),
              card_number: d.number,
              rarity: d.rarity,
              hp: d.hp,
              image_url: d.images?.large || d.images?.small,
              cardmarket_url: d.cardmarket?.url || null,
              tcgplayer_url: d.tcgplayer?.url,
              source: 'pokemontcg.io (ocr-direct)'
            };
            console.log(`[OCR-LOOKUP] PokemonTCG HIT: ${card.name} ${card.set_code} #${card.card_number}`);
            return res.json({ cards: [card] });
          } else if (results.length > 1 && reg_mark) {
            // Multiple matches — use regulation mark to pick the right era
            const era = REG_MARK_ERAS[reg_mark];
            if (era) {
              console.log(`[OCR-LOOKUP] Ambiguous: ${results.length} matches for ${q}, using reg mark ${reg_mark} to filter (${era.prefix} era)`);
              const filtered = results.filter(d => {
                const setId = (d.set?.id || '').toLowerCase();
                const releaseYear = d.set?.releaseDate ? parseInt(d.set.releaseDate.substring(0, 4)) : 0;
                const eraMatch = era.prefix ? setId.startsWith(era.prefix) : true;
                const yearMatch = releaseYear >= era.minYear && releaseYear <= era.maxYear;
                return eraMatch || yearMatch;
              });
              if (filtered.length === 1) {
                const d = filtered[0];
                const card = {
                  game: 'pokemon',
                  name: d.name,
                  set_name: d.set?.name,
                  set_code: (d.set?.id || '').toUpperCase(),
                  card_number: d.number,
                  rarity: d.rarity,
                  hp: d.hp,
                  image_url: d.images?.large || d.images?.small,
                  cardmarket_url: d.cardmarket?.url || null,
                  tcgplayer_url: d.tcgplayer?.url,
                  source: `pokemontcg.io (ocr-direct, reg:${reg_mark})`
                };
                console.log(`[OCR-LOOKUP] Reg-mark filtered HIT: ${card.name} ${card.set_code} #${card.card_number}`);
                return res.json({ cards: [card] });
              } else {
                console.log(`[OCR-LOOKUP] Reg-mark filter left ${filtered.length} matches (from ${results.length})`);
              }
            }
          } else if (results.length > 1) {
            console.log(`[OCR-LOOKUP] Ambiguous: ${results.length} matches for ${q}`);
          }
        } catch (e) {
          console.log(`[OCR-LOOKUP] PokemonTCG error: ${e.message}`);
        }
      }
    }

    return res.status(404).json({ error: 'no unique match' });
  } catch (err) {
    console.error('[OCR-LOOKUP] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// PRE-VERIFY: Fix common AI suffix mistakes using HP ranges
// ============================================================
// The AI frequently confuses "ex" (lowercase, SV era, 300+ HP) with "GX" (SM era, 200-270 HP)
// HP ranges by Pokemon card type:
//   Regular:    30-200 HP
//   EX (XY):    160-230 HP
//   GX (SM):    170-270 HP
//   V (SWSH):   180-230 HP
//   VMAX:       300-340 HP
//   VSTAR:      250-280 HP
//   ex (SV):    250-340 HP  (lowercase!)
function fixPokemonSuffix(card) {
  if (card.game !== 'pokemon') return card;

  const hp = parseInt(card.hp);
  const name = card.name || '';
  const suffix = extractPokemonSuffix(name);

  if (!hp || !suffix) return card;

  let correctedSuffix = suffix;
  let reason = '';

  // GX cards NEVER have 340+ HP — if AI says GX with 340+ HP, it's very likely "ex"
  // NOTE: Raised threshold from 300 to 340 because the AI sometimes misreads HP from images
  // (e.g. reads 330 when card says 250). GX can go up to ~270HP, so 340+ is a safer cutoff.
  // We'd rather keep a correct GX than wrongly flip it to ex based on a misread HP.
  if (suffix === 'GX' && hp >= 340) {
    correctedSuffix = 'ex';
    reason = `HP ${hp} is too high for GX (max ~270). This is an "ex" card.`;
  }
  // "ex" cards in SV era are typically 250+ HP — if AI says "ex" with < 200 HP, might be wrong
  // But ex can have lower HP for basic Pokemon, so only flag very low
  if (suffix === 'ex' && hp <= 150) {
    // Low HP ex is unusual but possible for basic ex — just log it
    console.log(`[FIX-SUFFIX] Warning: "${name}" has low HP ${hp} for an ex card`);
  }
  // V cards are 180-230 HP, if AI says V with 300+ HP it's probably VMAX
  if (suffix === 'V' && hp >= 300) {
    correctedSuffix = 'VMAX';
    reason = `HP ${hp} is too high for V (max ~230). This is likely VMAX.`;
  }
  // VMAX should be 300+ HP
  if (suffix === 'VMAX' && hp < 280) {
    correctedSuffix = 'V';
    reason = `HP ${hp} is too low for VMAX (min ~300). This is likely V.`;
  }

  if (correctedSuffix !== suffix) {
    const baseName = name.replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X)\s*$/, '').trim();
    const newName = `${baseName} ${correctedSuffix}`;
    console.log(`[FIX-SUFFIX] CORRECTED: "${name}" -> "${newName}" (${reason})`);
    return { ...card, name: newName, original_ai_name: name };
  }

  return card;
}


// ============================================================
// CARD VERIFICATION — Cross-reference AI results with real databases
// ============================================================
// After the AI identifies a card, we look it up in the correct game
// database to verify/correct set name, set code, card number, and
// get a reference image. This fixes the "wrong set" problem.

async function verifyCard(card) {
  console.log(`[VERIFY] ${card.game}: "${card.name}" (AI says: ${card.set_name} #${card.card_number})`);

  try {
    let verified = null;

    switch (card.game) {
      case 'starwars':
        verified = await verifySWU(card);
        break;
      case 'magic':
        verified = await verifyMagic(card);
        break;
      case 'pokemon':
        verified = await verifyPokemon(card);
        break;
      case 'yugioh':
        verified = await verifyYuGiOh(card);
        break;
      case 'onepiece':
      case 'lorcana':
      case 'digimon':
      case 'fleshandblood':
      case 'dragonball':
        // For these games, try a generic name search
        verified = await verifyGeneric(card);
        break;
    }

    if (verified) {
      // POST-VERIFICATION SANITY CHECK: Compare AI's reported HP against database HP
      // If they don't match, the AI probably identified the wrong card entirely
      // (e.g. AI says "Meowth-GX SM262" but the actual card has HP 170, while SM262 has HP 200)
      if (card.game === 'pokemon' && card.hp && verified.hp) {
        const aiHp = parseInt(card.hp);
        const dbHp = parseInt(verified.hp);
        if (aiHp && dbHp && Math.abs(aiHp - dbHp) > 20) {
          console.log(`[VERIFY] HP MISMATCH! AI says HP ${aiHp}, DB card "${verified.name}" has HP ${dbHp}. Re-searching...`);
          // The AI read the HP from the image correctly but identified the wrong card.
          // Search using the AI's HP + base name to find the actual card.
          const baseName = (card.name || '').replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X|-GX|-EX)\s*$/, '').replace(/-$/, '').trim();
          let hpMismatchResolved = false;
          try {
            const hpSearch = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q: `name:"${baseName}" hp:${card.hp}`, pageSize: 15 },
              timeout: 10000
            });
            const hpResults = hpSearch.data?.data;
            if (hpResults?.length) {
              // Score by attack match + card number match
              let best = null, bestScore = 0;
              for (const d of hpResults) {
                let score = 0;
                if (d.hp === String(card.hp)) score += 50;
                // Attack match
                if (card.attacks?.length && d.attacks?.length) {
                  const aiAtks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
                  const dbAtks = d.attacks.map(a => (a.name || '').toLowerCase());
                  score += aiAtks.filter(a => dbAtks.some(da => da.includes(a) || a.includes(da))).length * 25;
                }
                // Ability match
                if (card.attacks?.length && d.abilities?.length) {
                  const aiAbil = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
                  const dbAbil = d.abilities.map(a => (a.name || '').toLowerCase());
                  score += aiAbil.filter(a => dbAbil.some(da => da.includes(a) || a.includes(da))).length * 25;
                }
                // Card number from AI (if it read one)
                if (card.card_number && d.number) {
                  const aiNum = card.card_number.replace(/\/.*/, '').replace(/^0+/, '');
                  const dbNum = d.number.replace(/^0+/, '');
                  if (aiNum === dbNum) score += 40;
                }
                console.log(`[VERIFY] HP re-search: "${d.name}" (${d.set?.name} #${d.number}, HP:${d.hp}) => score ${score}`);
                if (score > bestScore) { bestScore = score; best = d; }
              }
              if (best && bestScore >= 50) {
                console.log(`[VERIFY] HP re-search found BETTER match: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp} (score: ${bestScore})`);
                const hpRefUrl = best.images?.large || best.images?.small;
                verified = {
                  name: best.name,
                  set_name: best.set?.name,
                  set_code: best.set?.id?.toUpperCase(),
                  card_number: best.number,
                  rarity: best.rarity,
                  hp: best.hp,
                  image: hpRefUrl,
                  source: 'pokemontcg.io (HP re-search)',
                  _refImagePromise: prefetchRefImage(hpRefUrl)
                };
                hpMismatchResolved = true;
              }
            }
          } catch (hpErr) {
            console.error(`[VERIFY] HP re-search failed: ${hpErr.message}`);
          }

          // CRITICAL: if HP mismatch wasn't resolved (re-search timed out or found nothing better),
          // we MUST reject the original verified match — it's almost certainly the wrong card.
          // Return the AI's identification as-is; better to have a less-precise ID than a confidently wrong one.
          if (!hpMismatchResolved) {
            console.log(`[VERIFY] REJECTED — HP mismatch unresolved. Keeping AI identification as-is.`);
            return { ...card, verified: false, verify_rejected: 'hp_mismatch' };
          }
        }
      }

      console.log(`[VERIFY] CORRECTED -> "${verified.name}" from ${verified.set_name} (${verified.set_code}) #${verified.card_number}`);
      // Merge: keep AI's condition estimate but use DB's set info.
      // confidence_score propagates through so the double-check gate can
      // skip high-confidence matches. candidates surfaces runner-up cards
      // for the client-side chooser when the confidence is moderate.
      return {
        ...card,
        name: verified.name || card.name,
        set_name: verified.set_name || card.set_name,
        set_code: verified.set_code || card.set_code,
        card_number: verified.card_number || card.card_number,
        rarity: verified.rarity || card.rarity,
        reference_image: verified.image || null,
        cardmarket_url: verified.cardmarket_url || null,
        tcgplayer_url: verified.tcgplayer_url || null,
        verified: true,
        db_source: verified.source,
        confidence_score: verified.confidence_score || null,
        candidates: verified.candidates || null,
        // Carry the in-flight ref-image fetch through to maybeDoubleCheck.
        // Stripped before client send by stripInternals.
        _refImagePromise: verified._refImagePromise || null
      };
    } else {
      console.log(`[VERIFY] Could not verify — using AI identification as-is`);
    }
  } catch (err) {
    console.error(`[VERIFY] Error: ${err.message}`);
  }

  return { ...card, verified: false };
}

// --- Star Wars: Unlimited via swu-db.com ---
async function verifySWU(card) {
  try {
    // Search by card name
    const searchUrl = `https://api.swu-db.com/cards/search?q=${encodeURIComponent(card.name)}`;
    console.log(`[VERIFY-SWU] Searching: ${searchUrl}`);

    const resp = await axios.get(searchUrl, { timeout: 8000 });
    const results = resp.data?.data || resp.data;

    if (Array.isArray(results) && results.length > 0) {
      // Score all results to find best match — card number is king for alt art distinction
      let best = null;
      let bestScore = -1;

      for (const c of results) {
        let score = 0;
        const cName = (c.name || c.Name || '').toLowerCase();
        const cNum = (c.number || c.Number || c.CardNumber || '').toString();
        const cSet = (c.set?.code || c.SetCode || c.set_code || '').toUpperCase();

        // Name match
        if (cName === card.name.toLowerCase()) score += 30;
        else if (cName.includes(card.name.toLowerCase())) score += 15;

        // Card number match — HIGHEST priority (distinguishes normal vs hyperspace vs showcase)
        if (card.card_number) {
          const aiNum = card.card_number.replace(/\/.*/, '').replace(/^0+/, '').replace(/^[A-Z]+ ?/, '');
          const dbNum = cNum.replace(/^0+/, '');
          if (aiNum === dbNum) score += 50;
          if (card.card_number.includes(cSet) || card.card_number.toUpperCase().startsWith(cSet)) score += 10;
        }

        // Set code match
        if (card.set_code && cSet === card.set_code.toUpperCase()) score += 20;

        // Variant match (normal vs hyperspace vs showcase)
        if (card.variant && c.variant) {
          if (c.variant.toLowerCase().includes(card.variant.toLowerCase())) score += 15;
        }

        console.log(`[VERIFY-SWU]   "${cName}" ${cSet} #${cNum} => score ${score}`);
        if (score > bestScore) { bestScore = score; best = c; }
      }

      if (!best) best = results[0];

      // Extract set info — SWU-DB has various possible field names
      const setName = best.set?.name || best.Set || best.set_name || best.expansion || '';
      const setCode = best.set?.code || best.SetCode || best.set_code || '';
      const cardNum = best.number || best.Number || best.CardNumber || best.card_number || '';

      return {
        name: best.name || best.Name || card.name,
        set_name: setName,
        set_code: setCode.toUpperCase(),
        card_number: cardNum.toString(),
        rarity: best.rarity || best.Rarity || '',
        image: best.image || best.FrontArt || best.artFront || null,
        source: 'swu-db.com'
      };
    }

    // Fallback: try the direct set search endpoints
    const sets = ['SOR', 'SHD', 'TWI', 'JTL'];
    for (const setCode of sets) {
      try {
        const setResp = await axios.get(`https://api.swu-db.com/cards/${setCode.toLowerCase()}`, { timeout: 5000 });
        const setCards = setResp.data?.data || setResp.data || [];
        if (Array.isArray(setCards)) {
          const match = setCards.find(c =>
            (c.name || c.Name || '').toLowerCase().includes(card.name.toLowerCase())
          );
          if (match) {
            return {
              name: match.name || match.Name,
              set_name: match.set?.name || setCode,
              set_code: setCode,
              card_number: (match.number || match.Number || '').toString(),
              rarity: match.rarity || match.Rarity || '',
              image: match.image || match.FrontArt || null,
              source: 'swu-db.com'
            };
          }
        }
      } catch { /* try next set */ }
    }
  } catch (err) {
    console.error(`[VERIFY-SWU] Error: ${err.message}`);
  }
  return null;
}

// --- Magic: The Gathering via Scryfall ---
async function verifyMagic(card) {
  try {
    // Try exact lookup first
    let url;
    if (card.set_code && card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      url = `https://api.scryfall.com/cards/${card.set_code.toLowerCase()}/${num}`;
    } else {
      url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`;
    }

    const resp = await axios.get(url, { timeout: 8000 });
    const d = resp.data;

    return {
      name: d.name,
      set_name: d.set_name,
      set_code: d.set.toUpperCase(),
      card_number: d.collector_number,
      rarity: d.rarity,
      image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
      cardmarket_url: d.purchase_uris?.cardmarket || null,
      tcgplayer_url: d.purchase_uris?.tcgplayer || null,
      source: 'scryfall.com'
    };
  } catch {
    // Fuzzy search fallback
    try {
      const resp = await axios.get(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`, { timeout: 8000 });
      const d = resp.data;
      return {
        name: d.name, set_name: d.set_name, set_code: d.set.toUpperCase(),
        card_number: d.collector_number, rarity: d.rarity,
        image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
        cardmarket_url: d.purchase_uris?.cardmarket || null,
        tcgplayer_url: d.purchase_uris?.tcgplayer || null,
        source: 'scryfall.com'
      };
    } catch { return null; }
  }
}

// Strict name comparison for the Sheet short-circuit. Rejects substring
// matches that would let "Pikachu" satisfy "Pikachu V", or "Charizard ex"
// Start downloading a card's reference image so doubleCheck can consume the
// already-buffered response instead of starting a fresh axios.get after
// verify finishes. Resolves with the axios response on success, or
// {_failed: msg} on error — never throws, so callers can attach without
// adding error handling.
function prefetchRefImage(url) {
  if (!url) return null;
  return axios.get(url, { responseType: 'arraybuffer', timeout: 8000 })
    .catch(e => ({ _failed: e?.message || 'prefetch failed' }));
}

// Pure scoring of one pokemontcg.io candidate against the AI's identification.
// Pulled out so per-query promises can score-as-they-arrive and we can
// race-exit on the first ≥ threshold hit instead of waiting all queries.
function scoreCandidate(card, isPromo, d) {
  let score = 0;

  // Name match (exact name is critical — "Charizard ex" ≠ "Charizard GX")
  if (d.name?.toLowerCase() === card.name?.toLowerCase()) score += 50;
  else if (d.name?.toLowerCase().includes(card.name?.toLowerCase())) score += 20;

  // HP match — very strong signal
  if (card.hp && d.hp === card.hp) score += 40;
  else if (card.hp && d.hp) {
    const diff = Math.abs(parseInt(d.hp) - parseInt(card.hp));
    if (diff <= 10) score += 20;
  }

  // Card number match — HIGHEST priority since it distinguishes alt arts and promos
  if (card.card_number) {
    const rawAiNum = card.card_number.replace(/\s/g, '');
    const aiNum = rawAiNum.replace(/\/.*/, '').replace(/^0+/, '');
    const dbNum = (d.number || '').replace(/^0+/, '');
    const aiNumNoSV = aiNum.replace(/^SV/, '');
    if (aiNum === dbNum || rawAiNum === d.number) {
      score += 80;  // Very high — exact card number is the definitive ID
    } else if (aiNumNoSV === dbNum) {
      score += 70;  // SV prefix stripped match
    } else if (isPromo && aiNum.length > 0 && dbNum.length > 0) {
      score -= 40;  // Promo number mismatch — strong negative
    } else if (aiNum.length > 0 && dbNum.length > 0) {
      score -= 10;  // Non-promo number mismatch
    }
  }

  // Abilities match (Pokemon TCG API has separate abilities array)
  if (card.attacks?.length && d.abilities?.length) {
    const aiAbilities = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
    const dbAbilities = d.abilities.map(a => (a.name || '').toLowerCase());
    const abilityMatches = aiAbilities.filter(a => dbAbilities.some(da => da.includes(a) || a.includes(da)));
    score += abilityMatches.length * 15;
  }

  // Set total match — if AI says "44/101", the set must have ~101 cards.
  if (card.card_number && card.card_number.includes('/')) {
    const aiSetTotal = parseInt(card.card_number.split('/')[1]?.replace(/^0+/, '') || '0');
    const dbSetTotal = parseInt(d.set?.printedTotal || d.set?.total || '0');
    if (aiSetTotal && dbSetTotal) {
      if (aiSetTotal === dbSetTotal) {
        score += 50;
      } else {
        const diff = Math.abs(aiSetTotal - dbSetTotal);
        if (diff <= 2) score += 20;
        else if (diff <= 10) score -= 30;
        else score -= 80;
      }
    }
  }

  // Set code match
  if (card.set_code && d.set?.id?.toUpperCase() === card.set_code.toUpperCase()) score += 25;
  // Set name match (fuzzy)
  if (card.set_name && d.set?.name) {
    const aiSet = card.set_name.toLowerCase().replace(/^ex\s+/i, '');
    const dbSet = d.set.name.toLowerCase().replace(/^ex\s+/i, '');
    if (aiSet === dbSet) score += 25;
    else if (dbSet.includes(aiSet) || aiSet.includes(dbSet)) score += 15;
  }

  // Attack names match
  if (card.attacks?.length && d.attacks?.length) {
    const aiAttacks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
    const dbAttacks = d.attacks.map(a => (a.name || '').toLowerCase());
    const matches = aiAttacks.filter(a => dbAttacks.some(da => da.includes(a) || a.includes(da)));
    score += matches.length * 15;
  }

  // Suffix type match (ex vs GX vs V etc.)
  const aiSuffix = extractPokemonSuffix(card.name);
  const dbSuffix = extractPokemonSuffix(d.name);
  if (aiSuffix && dbSuffix && aiSuffix === dbSuffix) score += 35;
  else if (aiSuffix && dbSuffix && aiSuffix !== dbSuffix) score -= 50;

  // Regulation-mark era check
  if (card.regulation_mark && !regMarkMatchesEra(card.regulation_mark, d)) {
    score -= 100;
  }

  return score;
}

// satisfy "Charizard GX". Only returns true when:
//   - normalized names are identical, OR
//   - base names (with Pokemon suffix stripped) match AND both sides report
//     the same suffix (e.g. both "ex", both null, both "VMAX")
function nameMatchesSheet(aiName, dbName) {
  const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const a = norm(aiName), d = norm(dbName);
  if (!a || !d) return false;
  if (a === d) return true;
  const SUFFIX_RE = /\s*(ex|gx|v|vmax|vstar|lv\.x)\s*$/i;
  const aBase = a.replace(SUFFIX_RE, '').trim();
  const dBase = d.replace(SUFFIX_RE, '').trim();
  if (aBase !== dBase) return false;
  return extractPokemonSuffix(aiName) === extractPokemonSuffix(dbName);
}

// If Claude reported a "NNN/TTT" card number where NNN > TTT, the card is a
// Secret Rare / "Additionals" subset on Cardmarket (e.g. DRI 229/182 is sold
// as xDRI 229 under "Destined Rivals: Additionals"). Annotate the verified
// result so downstream Cardmarket links + displayed labels reflect that.
function applyAdditionalsLabel(verified, aiCardNumber) {
  if (!verified || !aiCardNumber || typeof aiCardNumber !== 'string' || !aiCardNumber.includes('/')) return verified;
  const [numStr, totalStr] = aiCardNumber.split('/');
  const num = parseInt(String(numStr || '').replace(/^0+/, '') || '0');
  const total = parseInt(String(totalStr || '').replace(/^0+/, '') || '0');
  if (!num || !total || num <= total) return verified;
  const baseCode = (verified.set_code || '').toUpperCase();
  const baseName = verified.set_name || '';
  return {
    ...verified,
    set_code: baseCode.startsWith('X') ? baseCode : 'X' + baseCode,
    set_name: /additional/i.test(baseName) ? baseName : (baseName ? `${baseName}: Additionals` : baseName),
    _additionals: true
  };
}

// --- Pokemon via Pokemon TCG API ---
async function verifyPokemon(card) {
  try {
    // ── LOCAL DB SHORT-CIRCUIT ──
    // If Claude returned an exact set+number match that the Sheet / Pokellector
    // DB already has, skip the 4-query pokemontcg.io waterfall. Guards:
    //   - strict name match (exact-normalized or base+suffix both agree) — no
    //     loose substring matches that would let "Pikachu" short-circuit into
    //     the Sheet's "Pikachu V" entry
    //   - HP consistency when both sides report one — catches cases where
    //     Claude misread the set code so we looked up a real but wrong card
    //   - Secret-rare annotation applied after match so "xDRI 229" surfaces
    //     correctly when Claude reports a number above the set total
    if (card.set_code && card.card_number) {
      const resolved = resolveSetCode(card.set_code);
      if (resolved.setId) {
        const cleanNum = String(card.card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card.card_number);
        const local = lookupLocalDb(resolved.setId, cleanNum);
        if (local) {
          const nameOk = nameMatchesSheet(card.name, local.name);
          const aiHp = parseInt(card.hp);
          const dbHp = parseInt(local.hp);
          const hpOk = !aiHp || !dbHp || Math.abs(aiHp - dbHp) <= 20;
          if (nameOk && hpOk) {
            console.log(`[VERIFY-PKM] Local-DB HIT: ${resolved.setId}-${cleanNum} "${local.name}" — skipping pokemontcg.io`);
            const localRefUrl = local.reference_image || null;
            const hit = {
              name: local.name,
              set_name: local.set_name,
              set_code: local.set_code,
              card_number: local.card_number,
              rarity: local.rarity,
              hp: local.hp,
              image: localRefUrl,
              cardmarket_url: local.cardmarket_url || null,
              tcgplayer_url: local.tcgplayer_url || null,
              source: `local-db (${local.db_source || 'sheet'})`,
              _refImagePromise: prefetchRefImage(localRefUrl)
            };
            return applyAdditionalsLabel(hit, card.card_number);
          } else {
            console.log(`[VERIFY-PKM] Local-DB entry ${resolved.setId}-${cleanNum} "${local.name}" failed match gate (name=${nameOk}, hp=${hpOk}) — falling through`);
          }
        }
      }
    }

    // Detect if the AI identified this as a promo card (no slash in number, e.g. "SM211", "SWSH262")
    const isPromo = card.card_number && !card.card_number.includes('/') && /^[A-Z]{2,}P?\d+$/i.test(card.card_number.replace(/\s/g, ''));
    if (isPromo) {
      console.log(`[VERIFY-PKM] Detected PROMO card number: ${card.card_number}`);
    }

    // Build search queries — try high-specificity matches first, then fall
    // back. All queries run in parallel so order is just for scoring priority.
    const queries = [];

    // 0. For promo cards, search by the exact promo number first (most reliable)
    if (isPromo) {
      const promoNum = card.card_number.replace(/\s/g, '');
      queries.push(`number:${promoNum}`);
      // Also try with the name
      queries.push(`name:"${card.name}" number:${promoNum}`);
    }

    // 0.5 ATTACK-NAME PRIMACY. Attack names are nearly unique per card —
    // harder to hallucinate than card names and much harder to collide.
    // If Claude returned an attack, name+attack narrows to one or two cards
    // regardless of which set Claude mis-guessed. pokemontcg.io supports
    // `attacks.name:` as a Lucene filter.
    if (card.attacks?.length) {
      const atk = card.attacks
        .map(a => typeof a === 'string' ? a : (a?.name || ''))
        .find(s => s && s.length > 2); // skip short/empty attack names
      if (atk) {
        queries.push(`name:"${card.name}" attacks.name:"${atk.replace(/"/g, '')}"`);
      }
    }

    // 0.75 SET-TOTAL PRIMACY. The printed total (e.g. "133/182") is a
    // near-unique set fingerprint. Querying by that total first anchors us
    // to the right set even when Claude's set_code was slightly wrong.
    if (card.card_number?.includes('/')) {
      const total = card.card_number.split('/')[1]?.replace(/^0+/, '');
      const num = card.card_number.split('/')[0].replace(/^0+/, '');
      if (total && num) {
        queries.push(`name:"${card.name}" set.printedTotal:${total} number:${num}`);
      }
    }

    // 1. If we have a card number, try exact set+number match by set code
    if (card.card_number && card.set_code) {
      const num = card.card_number.replace(/\/.*/, '');
      queries.push(`name:"${card.name}" set.id:${card.set_code.toLowerCase()} number:${num}`);
    }

    // 1b. Try by SET NAME instead of set code — critical for EX-era sets where
    // the AI says "HL" but the API uses "ex5", or "MA" vs "ex4" etc.
    if (card.card_number && card.set_name) {
      const num = card.card_number.replace(/\/.*/, '');
      // Strip "EX " prefix if present since API set names sometimes omit it
      const setName = card.set_name.replace(/^EX\s+/i, '').trim();
      queries.push(`name:"${card.name}" set.name:"*${setName}*" number:${num}`);
      // Also try with the full name including EX prefix
      if (card.set_name.toLowerCase().startsWith('ex ')) {
        queries.push(`name:"${card.name}" set.name:"*${card.set_name}*" number:${num}`);
      }
    }

    // 2. Try exact name with card number (any set)
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      queries.push(`name:"${card.name}" number:${num}`);
    }

    // 3. HP-based search if we know it — very effective for disambiguation
    if (card.hp) {
      queries.push(`name:"${card.name}" hp:${card.hp}`);
    }

    // 4. Just name as fallback
    queries.push(`name:"${card.name}"`);

    // Collect the best match across ALL queries (don't stop at first hit).
    // allScored holds every candidate we've scored so we can surface the
    // runners-up to the user as a chooser when the winner isn't confident.
    let globalBest = null;
    let globalBestScore = -1;
    const seenCardIds = new Set();  // Avoid scoring the same card twice
    const allScored = [];

    // Fire all queries in parallel and SCORE EACH AS IT ARRIVES so we can
    // exit early on a high-confidence hit. Each per-query promise mutates
    // globalBest/allScored/seenCardIds as a side effect when it resolves.
    // Drops worst-case verify latency from longest-of-N (~10s) to time-of-
    // first-good-hit (~300-600ms typical) when a query crosses the
    // RACE_THRESHOLD. The 150ms grace window lets any near-finished query
    // also score before we return, eliminating most order-dependent regressions.
    const RACE_THRESHOLD = 220;
    const GRACE_MS = 150;

    const perQueryPromises = queries.map(q =>
      axios.get('https://api.pokemontcg.io/v2/cards', {
        params: { q, pageSize: 20 },
        timeout: 10000
      })
        .then(resp => {
          const results = resp.data?.data || [];
          if (results.length) console.log(`[VERIFY-PKM] "${q}" → ${results.length} results`);
          let queryBestScore = -1;
          for (const d of results) {
            if (seenCardIds.has(d.id)) continue;
            seenCardIds.add(d.id);
            const score = scoreCandidate(card, isPromo, d);
            console.log(`[VERIFY-PKM]   "${d.name}" (${d.set?.name} [${d.set?.printedTotal} cards] #${d.number}, HP:${d.hp}) => score ${score}`);
            allScored.push({ d, score });
            if (score > globalBestScore) {
              globalBestScore = score;
              globalBest = d;
            }
            if (score > queryBestScore) queryBestScore = score;
          }
          return { q, queryBestScore };
        })
        .catch(err => {
          console.error(`[VERIFY-PKM] Query failed "${q}": ${err.message}`);
          return { q, queryBestScore: -1 };
        })
    );

    // Outer race: first query to score >= RACE_THRESHOLD triggers a 150ms
    // grace window and then we return. If no query crosses the threshold,
    // we wait for everything via allSettled.
    await new Promise(resolveOuter => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolveOuter(); } };
      perQueryPromises.forEach(p => p.then(r => {
        if (done || !r) return;
        if (r.queryBestScore >= RACE_THRESHOLD) {
          console.log(`[VERIFY-PKM] race trigger: "${r.q}" → ${r.queryBestScore} >= ${RACE_THRESHOLD}, ${GRACE_MS}ms grace`);
          setTimeout(finish, GRACE_MS);
        }
      }));
      Promise.allSettled(perQueryPromises).then(finish);
    });

    // Top 3 alternatives (excluding the winner) for the chooser UI.
    // Only useful when we have multiple plausible candidates — below 40 is
    // typically "name kind-of matched and nothing else" so we filter those out.
    const candidates = allScored
      .filter(x => x.score >= 40 && x.d.id !== globalBest?.id)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ d, score }) => ({
        name: d.name,
        set_name: d.set?.name || '',
        set_code: d.set?.id?.toUpperCase() || '',
        card_number: d.number || '',
        rarity: d.rarity || '',
        hp: d.hp || '',
        image: d.images?.small || d.images?.large || null,
        cardmarket_url: d.cardmarket?.url || null,
        tcgplayer_url: d.tcgplayer?.url || null,
        score
      }));

    // Return the best match found across ALL queries.
    // Threshold raised from 40 → 120: a score of 40-100 is typically just
    // "name matched but everything else is wrong", which leads to confidently
    // wrong "corrections" (e.g. modern Bulbasaur being swapped for 2002 Expedition #94
    // because only the name matched). 120 requires at least 2-3 signals to agree.
    if (globalBest && globalBestScore >= 120) {
      console.log(`[VERIFY-PKM] Best match: "${globalBest.name}" from ${globalBest.set?.name} (score: ${globalBestScore})`);
      const refUrl = globalBest.images?.large || globalBest.images?.small;
      return applyAdditionalsLabel({
        name: globalBest.name,
        set_name: globalBest.set?.name,
        set_code: globalBest.set?.id?.toUpperCase(),
        card_number: globalBest.number,
        rarity: globalBest.rarity,
        hp: globalBest.hp,
        image: refUrl,
        // Direct Cardmarket product URL for this exact print — not a search.
        cardmarket_url: globalBest.cardmarket?.url || null,
        tcgplayer_url: globalBest.tcgplayer?.url || null,
        source: 'pokemontcg.io',
        confidence_score: globalBestScore,
        candidates,  // runners-up for the chooser UI when confidence is moderate
        // Start the ref-image download now so it overlaps with the rest of
        // verify finishing. Stripped before client send by stripInternals.
        _refImagePromise: globalBestScore < 200 ? prefetchRefImage(refUrl) : null
      }, card.card_number);
    } else if (globalBest) {
      console.log(`[VERIFY-PKM] Best match "${globalBest.name}" scored ${globalBestScore}, below threshold 120 — rejecting.`);
    }
    // FALLBACK: If nothing matched, try alternate suffixes
    // AI commonly confuses ex↔GX, V↔VMAX etc.
    const suffix = extractPokemonSuffix(card.name);
    if (suffix) {
      const baseName = card.name.replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X)\s*$/, '').trim();
      const altSuffixes = ['ex', 'GX', 'V', 'VMAX', 'VSTAR', 'EX'].filter(s => s !== suffix);
      console.log(`[VERIFY-PKM] Primary search failed. Trying alternate suffixes for "${baseName}"...`);

      for (const alt of altSuffixes) {
        const altName = `${baseName} ${alt}`;
        try {
          const hpQuery = card.hp ? ` hp:${card.hp}` : '';
          const q = `name:"${altName}"${hpQuery}`;
          console.log(`[VERIFY-PKM] Trying alt: ${q}`);
          const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q, pageSize: 5 },
            timeout: 10000
          });
          const results = resp.data?.data;
          if (results?.length > 0) {
            // Pick the one with matching HP if possible
            let best = results[0];
            if (card.hp) {
              const hpMatch = results.find(d => d.hp === card.hp || d.hp === String(card.hp));
              if (hpMatch) best = hpMatch;
            }
            console.log(`[VERIFY-PKM] ALT MATCH: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp}`);
            const altRefUrl = best.images?.large || best.images?.small;
            return applyAdditionalsLabel({
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              image: altRefUrl,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              source: 'pokemontcg.io',
              _refImagePromise: prefetchRefImage(altRefUrl)
            }, card.card_number);
          }
        } catch { /* try next suffix */ }
      }

      // Last resort: search just the base name (e.g. "Charizard") and find best HP match
      try {
        console.log(`[VERIFY-PKM] Last resort: searching base name "${baseName}" with HP ${card.hp}`);
        const hpQuery = card.hp ? ` hp:${card.hp}` : '';
        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: `name:"${baseName}"${hpQuery}`, pageSize: 20 },
          timeout: 10000
        });
        const results = resp.data?.data;
        if (results?.length > 0) {
          // Score by HP match and attack match
          let best = results[0];
          let bestScore = 0;
          for (const d of results) {
            let score = 0;
            if (card.hp && d.hp === String(card.hp)) score += 50;
            if (card.attacks?.length && d.attacks?.length) {
              const aiAtks = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
              const dbAtks = d.attacks.map(a => (a.name || '').toLowerCase());
              score += aiAtks.filter(a => dbAtks.includes(a)).length * 20;
            }
            if (score > bestScore) { bestScore = score; best = d; }
          }
          if (bestScore > 0) {
            console.log(`[VERIFY-PKM] BASE NAME MATCH: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp} (score: ${bestScore})`);
            const baseRefUrl = best.images?.large || best.images?.small;
            return applyAdditionalsLabel({
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              image: baseRefUrl,
              source: 'pokemontcg.io',
              _refImagePromise: prefetchRefImage(baseRefUrl)
            }, card.card_number);
          }
        }
      } catch { /* give up */ }
    }
  } catch (err) {
    console.error(`[VERIFY-PKM] Error: ${err.message}`);
  }
  return null;
}

// Helper: extract Pokemon card type suffix (ex, GX, V, VMAX, VSTAR, EX)
function extractPokemonSuffix(name) {
  if (!name) return null;
  const n = name.trim();
  if (n.endsWith(' ex') || n.endsWith('-ex')) return 'ex';
  if (n.endsWith(' GX') || n.endsWith('-GX')) return 'GX';
  if (n.endsWith(' VSTAR')) return 'VSTAR';
  if (n.endsWith(' VMAX')) return 'VMAX';
  if (n.endsWith(' V')) return 'V';
  if (n.endsWith(' EX') || n.endsWith('-EX')) return 'EX';
  if (n.endsWith(' LV.X')) return 'LV.X';
  return null;
}

// --- Yu-Gi-Oh via YGOPRODeck ---
async function verifyYuGiOh(card) {
  try {
    const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
      params: { name: card.name },
      timeout: 8000
    });

    if (resp.data?.data?.length > 0) {
      const d = resp.data.data[0];
      // YGO cards can have multiple sets
      const firstSet = d.card_sets?.[0];
      return {
        name: d.name,
        set_name: firstSet?.set_name || '',
        set_code: firstSet?.set_code || '',
        card_number: firstSet?.set_code || card.card_number,
        rarity: firstSet?.set_rarity || d.race,
        image: d.card_images?.[0]?.image_url,
        source: 'ygoprodeck.com'
      };
    }
  } catch (err) {
    // Try fuzzy search
    try {
      const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
        params: { fname: card.name },
        timeout: 8000
      });
      if (resp.data?.data?.length > 0) {
        const d = resp.data.data[0];
        const firstSet = d.card_sets?.[0];
        return {
          name: d.name, set_name: firstSet?.set_name || '', set_code: firstSet?.set_code || '',
          card_number: firstSet?.set_code || '', rarity: firstSet?.set_rarity || '',
          image: d.card_images?.[0]?.image_url, source: 'ygoprodeck.com'
        };
      }
    } catch { return null; }
  }
  return null;
}

// --- Generic fallback (for One Piece, Lorcana, Digimon, etc.) ---
// Uses a combination of available community APIs
async function verifyGeneric(card) {
  // Try a few known community APIs based on game
  const endpoints = [];

  if (card.game === 'onepiece') {
    // One Piece TCG doesn't have a great free API, but we can try
    // The card number format is usually the set identifier (e.g. OP06-001)
    // We'll trust the AI's identification more here
    return null;
  }

  if (card.game === 'lorcana') {
    // Try Lorcana API if available
    try {
      const resp = await axios.get(`https://api.lorcana-api.com/cards/fetch?search=${encodeURIComponent(card.name)}`, { timeout: 8000 });
      if (resp.data?.length > 0) {
        const d = resp.data[0];
        return {
          name: d.Name || d.name,
          set_name: d.Set_Name || d.set || '',
          set_code: d.Set_ID || '',
          card_number: d.Card_Num || d.number || '',
          rarity: d.Rarity || '',
          image: d.Image || null,
          source: 'lorcana-api.com'
        };
      }
    } catch { /* fall through */ }
  }

  return null;
}


// ============================================================
// CARDMARKET — HEADLESS BROWSER SCRAPING (bypasses 403 blocks)
// ============================================================
// Uses Puppeteer (real Chrome) so Cardmarket sees a normal browser visit.
// A single browser instance is shared and reused for speed.

const CONDITION_TO_CM = { 'NM': 2, 'LP': 4, 'MP': 5, 'HP': 6, 'DMG': 7 };

const CM_GAME_SLUGS = {
  'magic': 'Magic',
  'pokemon': 'Pokemon',
  'yugioh': 'YuGiOh',
  'onepiece': 'OnePiece',
  'lorcana': 'Lorcana',
  'dragonball': 'DragonBallSuper',
  'starwars': 'StarWarsUnlimited',
  'digimon': 'Digimon',
  'fleshandblood': 'FleshAndBlood',
  'weiss': 'WeissSchwarz',
  'cardfight': 'VanguardZero'
};

function getGameSlug(game) {
  return CM_GAME_SLUGS[game] || null;
}

// ============================================================
// CARDMARKET — Direct URL Builder (no scraping needed)
// ============================================================
// Builds a Cardmarket search URL the user can tap to check prices.
// Cloudflare blocks automated scraping, so we give the user a direct link instead.
function buildCardmarketUrl(card) {
  const gameSlug = getGameSlug(card.game);
  const condCode = CONDITION_TO_CM[card.condition_estimate] || 2;

  // We no longer guess direct product URLs — Cardmarket's slug rules have too
  // many edge cases (alt-arts, punctuation, variant suffixes) and a guessed
  // URL 404s more often than it works. API-provided URLs (from pokemontcg.io
  // / Scryfall) still override this in the caller when available.

  // Cardmarket's product names are "Name (SETCODE NUMBER)" — e.g.
  // "Haunter (MEP 027)". Their search tokenises on whitespace and matches
  // products containing ALL tokens. Including the set code in the search
  // string was too-restrictive: Cardmarket's tokeniser doesn't always
  // index the bracketed set code as a searchable token, so "Haunter MEP
  // 027" returned zero hits. Name + card number alone (e.g. "Haunter
  // 027") reliably finds the product across sets, and Cardmarket's
  // sidebar filter lets the user narrow by expansion if multiple sets
  // share the same number.
  const num = card.card_number ? card.card_number.replace(/\/.*/, '').replace(/^0+/, '') : '';

  let searchTerm = card.name || '';
  if (num) {
    searchTerm = `${card.name} ${num}`;
  }

  const searchUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(searchTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(searchTerm)}`;

  // Name-only fallback (last resort if even name+number misses)
  const fallbackTerm = card.name || '';
  const fallbackUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(fallbackTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(fallbackTerm)}`;

  return {
    product_url: null,
    product_url_filtered: null,
    search_url: searchUrl,
    filtered_search_url: `${searchUrl}&language=1&minCondition=${condCode}`,
    narrow_search_url: fallbackUrl,
    source: 'cardmarket_link'
  };
}

// ============================================================
// Lightweight Cardmarket price fetch — direct URL, no search needed
// ============================================================
// Since we build the exact product URL, we can try a simple HTTP request.
// Cloudflare may or may not block this — if it does, we fall back to API prices.
async function fetchCardmarketPrice(productUrl, condition) {
  if (!productUrl || !productUrl.includes('cardmarket.com')) return null;

  const condCode = CONDITION_TO_CM[condition] || 2;
  // Fetch the filtered offers page (English + condition)
  const filteredUrl = productUrl.includes('?')
    ? `${productUrl}&language=1&minCondition=${condCode}`
    : `${productUrl}?language=1&minCondition=${condCode}`;

  try {
    console.log(`[CM-FETCH] Trying direct fetch: ${filteredUrl}`);
    const resp = await axios.get(filteredUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      },
      timeout: 10000,
      maxRedirects: 5
    });

    const html = resp.data;
    const title = typeof html === 'string' ? html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || '' : '';

    // Check if Cloudflare blocked us
    if (title.includes('Just a moment') || title.includes('Attention') || html.length < 5000) {
      console.log(`[CM-FETCH] Cloudflare blocked (title: "${title}", size: ${html.length})`);
      return null;
    }

    console.log(`[CM-FETCH] Got page! Title: "${title}", size: ${html.length}`);

    // Extract prices using regex (no cheerio needed)
    const result = { url: productUrl, filtered_url: filteredUrl, source: 'cardmarket_live' };

    // 1. Extract trend price: <dt>Price Trend</dt><dd>... 3,62 € ...</dd>
    const trendMatch = html.match(/Price\s*Trend[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (trendMatch) result.trend = parseFloat(trendMatch[1].replace(',', '.'));

    // 2. Extract "From" / lowest price
    const fromMatch = html.match(/(?:From|Ab|Available from)[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (fromMatch) result.low = parseFloat(fromMatch[1].replace(',', '.'));

    // 3. Extract 30-day average
    const avg30Match = html.match(/30[- ]day[s]?\s*average[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (avg30Match) result.avg30 = parseFloat(avg30Match[1].replace(',', '.'));

    // 4. Find offer prices on the filtered page (look for € prices in offer rows)
    const offerPrices = [];
    const priceRegex = /(\d+[.,]\d{2})\s*€/g;
    let match;

    // Look specifically in the offers/seller section (after "Seller" heading)
    const sellerSection = html.split(/Seller|seller/i)[1] || '';
    while ((match = priceRegex.exec(sellerSection)) !== null) {
      const price = parseFloat(match[1].replace(',', '.'));
      if (price > 0.01 && price < 50000) {
        offerPrices.push(price);
      }
    }

    // Deduplicate and sort
    const uniqueOffers = [...new Set(offerPrices)].sort((a, b) => a - b);

    if (uniqueOffers.length > 0) {
      result.offers_low = uniqueOffers[0];
      result.total_offers = uniqueOffers.length;
      result.note = `Lowest English ${condition}+ offer: ${uniqueOffers[0].toFixed(2)}€ (${uniqueOffers.length} sellers)`;
      console.log(`[CM-FETCH] Found ${uniqueOffers.length} offer prices, lowest: ${uniqueOffers[0]}€`);
    }

    // Set the best price
    result.price = result.offers_low || result.low || result.trend;
    if (!result.price) {
      console.log('[CM-FETCH] Could not extract any prices from page');
      return null;
    }

    console.log(`[CM-FETCH] SUCCESS — price: ${result.price}€, trend: ${result.trend || '?'}€, offers_low: ${result.offers_low || '?'}€`);
    return result;

  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.log('[CM-FETCH] Blocked by Cloudflare (403). Falling back to API prices.');
    } else {
      console.log(`[CM-FETCH] Failed: ${err.message}. Falling back to API prices.`);
    }
    return null;
  }
}

// ============================================================
// JustTCG API — TCGPlayer USD prices for ALL TCGs
// Returns condition-specific market prices from TCGPlayer
// Free tier: 100 requests/day
// ============================================================
const JUSTTCG_GAME_MAP = {
  'pokemon': 'pokemon',
  'magic': 'mtg',
  'yugioh': 'yugioh',
  'lorcana': 'lorcana',
  'onepiece': 'onepiece',
  'digimon': 'digimon',
  'starwars': 'star-wars-unlimited',
  'flesh_and_blood': 'flesh-and-blood'
};

const JUSTTCG_CONDITION_MAP = {
  'NM': 'Near Mint', 'LP': 'Lightly Played', 'MP': 'Moderately Played',
  'HP': 'Heavily Played', 'DMG': 'Damaged'
};

async function fetchJustTCGPrice(card) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const game = JUSTTCG_GAME_MAP[card.game] || card.game;
  const conditionFull = JUSTTCG_CONDITION_MAP[card.condition_estimate] || 'Near Mint';
  const conditionShort = card.condition_estimate || 'NM';

  try {
    // JustTCG works best with name + card_number in the q parameter
    // Set param uses slug format (e.g. "sv03-obsidian-flames-pokemon") which is hard to predict
    // So we include the card number in the text search for precision
    let searchQuery = card.name;
    if (card.card_number) {
      // Strip any slash format (223/197 → 223) for cleaner search
      const num = card.card_number.replace(/\/.*/, '');
      searchQuery = `${card.name} ${num}`;
    }

    const params = { q: searchQuery, game: game, limit: 5 };

    console.log(`[JustTCG] Searching: game=${game}, q="${params.q}"`);

    const resp = await axios.get('https://api.justtcg.com/v1/cards', {
      params,
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 10000
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      // Fallback: try just the name without number
      console.log('[JustTCG] No results, trying name only...');
      const resp2 = await axios.get('https://api.justtcg.com/v1/cards', {
        params: { q: card.name, game: game, limit: 5 },
        headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
        timeout: 10000
      });
      const data2 = resp2.data?.data;
      if (!data2 || data2.length === 0) {
        console.log('[JustTCG] No results found');
        return null;
      }
      return parseJustTCGResult(data2, card, conditionFull, conditionShort);
    }

    return parseJustTCGResult(data, card, conditionFull, conditionShort);
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[JustTCG] Rate limited (100/day) — skipping');
    } else if (err.response?.status === 401) {
      console.log('[JustTCG] Invalid API key');
    } else {
      console.log(`[JustTCG] Error: ${err.message}`);
    }
    return null;
  }
}

function parseJustTCGResult(data, card, conditionFull, conditionShort) {
  // Find best match — score by name + number + set
  let best = data[0];
  let bestScore = 0;
  for (const item of data) {
    let score = 0;
    if (item.name?.toLowerCase().includes(card.name.toLowerCase())) score += 50;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      const itemNum = (item.number || '').replace(/\/.*/, '');
      if (itemNum === num) score += 60;
    }
    if (card.set_name && item.set_name?.toLowerCase().includes(card.set_name.toLowerCase())) score += 30;
    if (score > bestScore) { bestScore = score; best = item; }
  }

  // Find the right variant — match condition, prefer Normal/Holofoil printing
  const variants = best.variants || [];
  let bestVariant = variants[0];

  // First try: exact condition match
  const condMatch = variants.filter(v => v.condition === conditionFull);
  if (condMatch.length > 0) {
    // Prefer Normal or Holofoil printing
    bestVariant = condMatch.find(v => v.printing === 'Normal' || v.printing === 'Holofoil') || condMatch[0];
  }

  const price = bestVariant?.price || null;
  const result = {
    source: 'justtcg',
    name: best.name,
    set: best.set_name || best.set,
    set_slug: best.set,
    card_number: best.number,
    condition: conditionShort,
    condition_full: bestVariant?.condition || conditionFull,
    printing: bestVariant?.printing || null,
    // JustTCG returns TCGPlayer USD prices
    price_usd: price,
    price_eur: price ? Math.round(price * USD_TO_EUR * 100) / 100 : null,
    currency: 'USD',
    last_updated: bestVariant?.lastUpdated ? new Date(bestVariant.lastUpdated * 1000).toISOString() : null,
    // Price analytics
    price_change_7d: bestVariant?.priceChange7d || null,
    price_change_30d: bestVariant?.priceChange30d || null,
    avg_30d: bestVariant?.avgPrice30d || null,
    min_30d: bestVariant?.minPrice30d || null,
    max_30d: bestVariant?.maxPrice30d || null,
  };

  if (result.price_usd) {
    console.log(`[JustTCG] Found: ${result.name} (${result.set} #${result.card_number}) = $${result.price_usd} USD / ~${result.price_eur}€ [${result.condition_full}, ${result.printing}]`);
  } else {
    console.log(`[JustTCG] Found card but no price: ${result.name} (${result.set})`);
  }

  return result;
}


// ============================================================
// TCGGO Pokemon TCG API via RapidAPI — real-time Cardmarket EUR + TCGPlayer USD
// Host: pokemon-tcg-api.p.rapidapi.com (requires separate subscription)
// Subscribe at: https://rapidapi.com/tcggopro/api/pokemon-tcg-api
// Response format (from docs):
//   { id, name, name_numbered, card_number, rarity,
//     prices: {
//       cardmarket: { currency:"EUR", lowest_near_mint, lowest_near_mint_DE/FR/ES/IT,
//                     30d_average, 7d_average, graded: { psa: {psa10, psa9}, cgc: {cgc10} } },
//       tcg_player: { currency:"USD", market_price, mid_price }
//     },
//     episode: { name, code }, artist: { name }, image }
// ============================================================
async function fetchRapidAPICardmarketPrice(card) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  // Only Pokemon is supported on this API
  if (card.game !== 'pokemon') {
    return null;
  }

  try {
    let searchTerm = card.name;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      searchTerm = `${card.name} ${num}`;
    }

    console.log(`[TCGGO] Searching: "${searchTerm}"`);

    // Endpoint: /cards/search with "search" param (found via probing)
    // "search" param with name+number returns exact match as first result
    // "name" param only matches exact card name (no number in query)
    const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
      params: { search: searchTerm, per_page: 5 },
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      console.log('[TCGGO] No results');
      return null;
    }

    // Find best match by name + card number
    let best = data[0];
    let bestScore = 0;
    for (const item of data) {
      let score = 0;
      if (item.name?.toLowerCase().includes(card.name.toLowerCase())) score += 50;
      if (card.card_number) {
        const num = card.card_number.replace(/\/.*/, '');
        const itemNum = String(item.card_number);
        if (itemNum === num || itemNum === card.card_number) score += 60;
      }
      if (card.set_name && item.episode?.name?.toLowerCase().includes(card.set_name.toLowerCase())) score += 30;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    // Extract from the documented response structure
    const cm = best.prices?.cardmarket || {};
    const tcg = best.prices?.tcg_player || {};

    const result = {
      source: 'rapidapi_cm',
      name: best.name,
      name_numbered: best.name_numbered,
      set: best.episode?.name || null,
      set_code: best.episode?.code || null,
      card_number: String(best.card_number),
      rarity: best.rarity,
      image: best.image || null,
      tcggo_url: best.tcggo_url || null,
      // Cardmarket EUR prices
      lowest_nm: cm.lowest_near_mint || null,
      lowest_de: cm.lowest_near_mint_DE || null,
      lowest_fr: cm.lowest_near_mint_FR || null,
      lowest_es: cm.lowest_near_mint_ES || null,
      lowest_it: cm.lowest_near_mint_IT || null,
      avg30: cm['30d_average'] || null,
      avg7: cm['7d_average'] || null,
      // Graded prices
      graded_psa10: cm.graded?.psa?.psa10 || null,
      graded_psa9: cm.graded?.psa?.psa9 || null,
      graded_cgc10: cm.graded?.cgc?.cgc10 || null,
      // TCGPlayer USD prices
      tcgplayer_market: tcg.market_price || null,
      tcgplayer_mid: tcg.mid_price || null,
    };

    // Best Cardmarket price = lowest NM across all regions
    result.price = result.lowest_nm || result.avg7 || result.avg30;

    if (result.price) {
      console.log(`[TCGGO] Found: ${result.name} (${result.set} #${result.card_number}) = ${result.price}€ NM (30d avg: ${result.avg30 || '?'}€, DE: ${result.lowest_de || '?'}€)`);
    } else {
      console.log(`[TCGGO] Card found but no Cardmarket price: ${result.name}`);
    }

    return result;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[TCGGO] Rate limited — skipping');
    } else if (err.response?.status === 403) {
      console.log('[TCGGO] Not subscribed — subscribe at https://rapidapi.com/tcggopro/api/pokemon-tcg-api');
    } else if (err.response?.status === 401) {
      console.log('[TCGGO] Auth error — check RAPIDAPI_KEY');
    } else {
      console.log(`[TCGGO] Error: ${err.response?.status || ''} ${err.message}`);
    }
    return null;
  }
}


// Graceful shutdown
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());




// ============================================================
// PRICING — Free APIs (Scryfall for Magic, Pokemon TCG API)
// ============================================================

async function priceMagicCard(card) {
  const prices = { cardmarket: null, ebay: null, source: 'scryfall' };

  try {
    let url;
    if (card.set_code && card.card_number) {
      const setCode = card.set_code.toLowerCase();
      const num = card.card_number.replace(/\/.*/, '');
      url = `https://api.scryfall.com/cards/${setCode}/${num}`;
    } else {
      url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`;
    }

    const resp = await axios.get(url, { timeout: 8000 });
    const data = resp.data;

    if (data.prices) {
      const isFoil = card.variant && card.variant !== 'normal';
      const tcgPrice = isFoil ? data.prices.usd_foil : data.prices.usd;

      if (tcgPrice) {
        prices.tcgplayer = {
          price: parseFloat(tcgPrice),
          currency: 'USD',
          url: data.purchase_uris?.tcgplayer || null
        };
      }

      // Scryfall also has EUR (Cardmarket) prices!
      const eurPrice = isFoil ? data.prices.eur_foil : data.prices.eur;
      if (eurPrice) {
        prices.cardmarket_price = parseFloat(eurPrice);
        prices.cardmarket_source = 'scryfall.com';
        console.log(`[PRICE] Cardmarket EUR price from Scryfall: ${eurPrice}€ (${data.name})`);
      }
    }

    // Capture Cardmarket direct URL from Scryfall (for MTG cards)
    if (data.purchase_uris?.cardmarket) {
      prices.cardmarket_product_url = data.purchase_uris.cardmarket;
    }

    prices.scryfall = {
      name: data.name,
      set: data.set_name,
      set_code: data.set,
      collector_number: data.collector_number,
      image: data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal,
      uri: data.scryfall_uri
    };

  } catch (err) {
    console.error('Scryfall error:', err.message);
  }

  return prices;
}

async function pricePokemonCard(card) {
  const prices = { cardmarket: null, ebay: null, source: 'pokemontcg' };

  try {
    let query;
    if (card.set_code && card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      query = `number:${num}`;
      if (card.set_code) {
        query += ` set.id:${card.set_code.toLowerCase()}`;
      }
    } else {
      query = `name:"${card.name}"`;
    }

    const resp = await axios.get(`https://api.pokemontcg.io/v2/cards`, {
      params: { q: query, pageSize: 5 },
      timeout: 10000
    });

    if (resp.data.data && resp.data.data.length > 0) {
      let bestMatch = resp.data.data[0];
      if (card.card_number) {
        const targetNum = card.card_number.replace(/\/.*/, '');
        const exact = resp.data.data.find(c => c.number === targetNum);
        if (exact) bestMatch = exact;
      }

      const d = bestMatch;

      if (d.tcgplayer?.prices) {
        const tcgPrices = d.tcgplayer.prices;
        const variant = card.variant === 'reverse_holo' ? tcgPrices.reverseHolofoil : (tcgPrices.holofoil || tcgPrices.normal);
        if (variant) {
          prices.tcgplayer = {
            price: variant.market || variant.mid,
            low: variant.low,
            currency: 'USD',
            url: d.tcgplayer.url || null
          };
        }
      }

      // Extract Cardmarket prices from the Pokemon TCG API (it includes them!)
      // Priority: lowPrice (actual lowest listing) > lowPriceExPlus > trendPrice
      if (d.cardmarket?.prices) {
        const cmPrices = d.cardmarket.prices;
        const isFoil = card.variant && !['normal', 'reverse_holo'].includes(card.variant);

        // Use LOWEST price, not trend — user wants to know what they'd actually pay
        const cmPrice = isFoil
          ? (cmPrices.reverseHoloLow || cmPrices.reverseHoloTrend || cmPrices.lowPrice || cmPrices.trendPrice)
          : (cmPrices.lowPriceExPlus || cmPrices.lowPrice || cmPrices.trendPrice);

        // Also grab trend for reference
        const cmTrend = cmPrices.trendPrice;

        if (cmPrice) {
          prices.cardmarket_price = cmPrice;
          prices.cardmarket_trend = cmTrend;
          prices.cardmarket_source = 'pokemontcg.io';
          console.log(`[PRICE] Cardmarket from API: lowest=${cmPrice}€, trend=${cmTrend}€ (${d.name} ${d.set?.name} #${d.number})`);
        }

        // Also pass the Cardmarket URL from the API
        if (d.cardmarket?.url) {
          prices.cardmarket_product_url = d.cardmarket.url;
        }
      }

      prices.pokemontcg = {
        name: d.name,
        set: d.set?.name,
        set_code: d.set?.id,
        number: d.number,
        image: d.images?.large || d.images?.small,
        rarity: d.rarity
      };
    }
  } catch (err) {
    console.error('Pokemon TCG API error:', err.message);
  }

  return prices;
}


// ============================================================
// PRICING — eBay Sold Listings
// ============================================================

async function getEbayToken() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) return null;

  try {
    const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
    const resp = await axios.post('https://api.ebay.com/identity/v1/oauth2/token', new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    }), {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });
    return resp.data.access_token;
  } catch (err) {
    console.error('eBay token error:', err.message);
    return null;
  }
}

async function priceEbaySold(card) {
  const token = await getEbayToken();
  if (!token) {
    console.log('[eBay] No token available');
    return null;
  }

  // Build search queries — try specific first, then broader
  const queries = [];

  // Most specific: name + set + number
  let specific = card.name;
  if (card.set_code) specific += ` ${card.set_code}`;
  if (card.card_number) specific += ` ${card.card_number.replace(/\/.*/, '')}`;
  queries.push(specific);

  // Medium: name + game
  const gameNames = {
    'pokemon': 'pokemon tcg', 'magic': 'mtg', 'starwars': 'star wars unlimited',
    'onepiece': 'one piece tcg', 'yugioh': 'yugioh', 'lorcana': 'lorcana',
    'dragonball': 'dragon ball super', 'digimon': 'digimon tcg', 'fleshandblood': 'flesh and blood'
  };
  if (card.card_number) {
    queries.push(`${card.name} ${card.card_number} ${gameNames[card.game] || ''}`);
  }

  // Broadest: just the name + game
  queries.push(`${card.name} ${gameNames[card.game] || 'tcg'} card`);

  // Fire all queries in parallel but still prefer the most specific one
  // (queries[0]) — we iterate results in specificity order and return the
  // first query that produced usable prices. Worst-case latency drops from
  // ~30s (3 × 10s timeouts) to ~10s.
  const responses = await Promise.all(queries.map(q =>
    axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: {
        q,
        category_ids: '183454', // Collectible Card Games
        filter: 'buyingOptions:{FIXED_PRICE|AUCTION}',
        sort: 'price',
        limit: 15
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IE' // Ireland for EUR
      },
      timeout: 10000
    })
      .then(resp => ({ q, items: resp.data?.itemSummaries || [] }))
      .catch(err => {
        console.error(`[eBay] API error for "${q}": ${err.response?.data?.errors?.[0]?.message || err.message}`);
        return { q, items: [] };
      })
  ));

  for (const { q, items } of responses) {
    if (!items.length) { console.log(`[eBay] "${q}" → no results`); continue; }
    console.log(`[eBay] "${q}" → ${items.length} listings`);

    const prices = items
      .filter(i => i.price?.value)
      .map(i => ({
        price: parseFloat(i.price.value),
        currency: i.price.currency,
        title: i.title,
        url: i.itemWebUrl
      }))
      .filter(i => i.price > 0 && i.price < 10000) // strip obvious junk
      .sort((a, b) => a.price - b.price);

    if (!prices.length) continue;
    const median = prices[Math.floor(prices.length / 2)];
    return {
      median_price: median.price,
      low: prices[0].price,
      high: prices[prices.length - 1].price,
      sample_size: prices.length,
      currency: median.currency || 'EUR',
      recent_sales: prices.slice(0, 5).map(i => ({
        title: i.title,
        price: i.price,
        currency: i.currency,
        url: i.url
      }))
    };
  }

  console.log('[eBay] No results found across all search strategies');
  return null;
}


// ============================================================
// COMBINED PRICING ENDPOINT
// ============================================================
// In-memory pricing cache — keyed on the card's identifying fields plus
// condition + graded state + buy percentage. A card re-scanned during the
// same session (common when Dave re-checks a pile) returns in <5ms instead
// of hitting 5 upstream APIs again. 60-min TTL keeps prices reasonably
// fresh while eliminating the obvious duplicate work.
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_CACHE_MAX = 500;
const priceCache = new Map();
function priceCacheKey(card, buyPercentage) {
  return [
    card.game || '',
    (card.name || '').toLowerCase(),
    (card.set_code || '').toUpperCase(),
    (card.card_number || '').toString(),
    card.condition_estimate || 'NM',
    card.variant || 'normal',
    card.graded ? `${card.graded.company}-${card.graded.grade}` : '',
    String(buyPercentage)
  ].join('|');
}
function priceCacheGet(key) {
  const hit = priceCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PRICE_CACHE_TTL_MS) {
    priceCache.delete(key);
    return null;
  }
  // LRU: re-insert so most-recently-used stays alive
  priceCache.delete(key);
  priceCache.set(key, hit);
  return hit.data;
}
function priceCacheSet(key, data) {
  if (priceCache.size >= PRICE_CACHE_MAX) {
    const first = priceCache.keys().next().value;
    priceCache.delete(first);
  }
  priceCache.set(key, { ts: Date.now(), data });
}

app.post('/api/price', requireAuth, async (req, res) => {
  try {
    const { card } = req.body;
    if (!card || !card.name) {
      return res.status(400).json({ error: 'Card data required' });
    }

    const conditionMultipliers = {
      'NM': 1.0, 'LP': 0.85, 'MP': 0.70, 'HP': 0.50, 'DMG': 0.30
    };
    const conditionMult = conditionMultipliers[card.condition_estimate] || 1.0;
    const buyPercentage = (req.body.buyPercentage || process.env.DEFAULT_BUY_PERCENTAGE || 60) / 100;

    // Cache check — a re-scan of the same card/condition/percentage returns instantly.
    const cacheKey = priceCacheKey(card, buyPercentage);
    const cached = priceCacheGet(cacheKey);
    if (cached) {
      console.log(`[PRICE-CACHE] HIT ${cacheKey}`);
      return res.json({ ...cached, cached: true });
    }

    // Build Cardmarket direct link (user can tap to check live prices)
    const cmLinks = buildCardmarketUrl(card);

    // Run ALL pricing lookups in parallel for speed
    const pricingPromises = [];

    // 0. Try live Cardmarket fetch if we have a direct product URL
    if (cmLinks.product_url) {
      pricingPromises.push(
        fetchCardmarketPrice(cmLinks.product_url, card.condition_estimate || 'NM')
          .then(r => ({ type: 'cardmarket_live', data: r }))
      );
    }

    // 1. Game-specific free APIs (TCGPlayer prices + reference images)
    if (card.game === 'magic') {
      pricingPromises.push(priceMagicCard(card).then(r => ({ type: 'game_api', data: r })));
    } else if (card.game === 'pokemon') {
      pricingPromises.push(pricePokemonCard(card).then(r => ({ type: 'game_api', data: r })));
    }

    // 2. JustTCG API — condition-specific live Cardmarket prices (all games)
    if (process.env.JUSTTCG_API_KEY) {
      pricingPromises.push(
        fetchJustTCGPrice(card).then(r => ({ type: 'justtcg', data: r }))
      );
    }

    // 3. TCGGO API via RapidAPI — real-time Cardmarket EUR prices + TCGPlayer USD
    // Requires subscription to "Pokemon TCG API" at:
    //   https://rapidapi.com/tcggopro/api/pokemon-tcg-api
    // (NOT "cardmarket-api-tcg" which is a different product with empty data)
    if (process.env.RAPIDAPI_KEY) {
      pricingPromises.push(
        fetchRapidAPICardmarketPrice(card).then(r => ({ type: 'rapidapi_cm', data: r }))
      );
    }

    // 4. eBay sold listings
    pricingPromises.push(
      priceEbaySold(card).then(r => ({ type: 'ebay', data: r }))
    );

    const results = await Promise.all(pricingPromises);

    // Assemble final pricing
    let pricing = {
      card: card,
      cardmarket: {
        url: cmLinks.search_url,
        filtered_url: cmLinks.filtered_search_url,
        search_url: cmLinks.search_url,
        source: 'cardmarket_link',
        note: 'Tap to check live Cardmarket prices'
      },
      ebay: null,
      tcgplayer: null,
      reference_image: null,
      buy_price: null,
      condition_multiplier: conditionMult,
      buy_percentage: buyPercentage
    };

    for (const result of results) {
      if (result.type === 'game_api' && result.data) {
        if (result.data.tcgplayer) {
          pricing.tcgplayer = result.data.tcgplayer;
        }
        if (result.data.scryfall?.image || result.data.pokemontcg?.image) {
          pricing.reference_image = result.data.scryfall?.image || result.data.pokemontcg?.image;
        }
        if (result.data.scryfall) pricing.verified_card = result.data.scryfall;
        if (result.data.pokemontcg) pricing.verified_card = result.data.pokemontcg;

        // Extract Cardmarket price from API (lowest available, NOT trend)
        if (result.data.cardmarket_price) {
          pricing.cardmarket.price = result.data.cardmarket_price;
          pricing.cardmarket.trend = result.data.cardmarket_trend || null;
          pricing.cardmarket.source = result.data.cardmarket_source || 'api';
          pricing.cardmarket.note = `Lowest via API · ${result.data.cardmarket_trend ? 'Trend: ' + result.data.cardmarket_trend.toFixed(2) + '€' : ''}`;
        }

        // Use direct Cardmarket product URL ONLY if it's an actual cardmarket.com URL
        // (Pokemon TCG API returns redirect URLs like prices.pokemontcg.io — skip those)
        if (result.data.cardmarket_product_url && result.data.cardmarket_product_url.includes('cardmarket.com')) {
          pricing.cardmarket.url = result.data.cardmarket_product_url;
          pricing.cardmarket.filtered_url = result.data.cardmarket_product_url;
          console.log(`[CM-URL] Using Cardmarket URL from API: ${result.data.cardmarket_product_url}`);
        }
      }

      if (result.type === 'ebay' && result.data) {
        pricing.ebay = result.data;
      }

      // Live Cardmarket price from direct page fetch — overrides API price
      if (result.type === 'cardmarket_live' && result.data) {
        console.log(`[CM-LIVE] Got live Cardmarket data:`, JSON.stringify(result.data));
        pricing.cardmarket.price = result.data.low || result.data.trend || pricing.cardmarket.price;
        pricing.cardmarket.trend = result.data.trend || pricing.cardmarket.trend;
        pricing.cardmarket.low = result.data.low || null;
        pricing.cardmarket.avg30 = result.data.avg30 || null;
        pricing.cardmarket.source = 'cardmarket_live';
        pricing.cardmarket.verified = true;
        pricing.cardmarket.note = `Live price from Cardmarket${result.data.trend ? ' · Trend: ' + result.data.trend.toFixed(2) + '€' : ''}`;
        if (result.data.offers && result.data.offers.length > 0) {
          pricing.cardmarket.offers = result.data.offers.slice(0, 5);
        }
      }

      // JustTCG — condition-specific TCGPlayer USD prices
      if (result.type === 'justtcg' && result.data) {
        const jt = result.data;
        if (jt.price_usd) {
          console.log(`[PRICE] JustTCG: $${jt.price_usd} USD / ~${jt.price_eur}€ [${jt.condition_full}, ${jt.printing}]`);
        }
        // Store as separate data source for cross-check display
        pricing.justtcg = {
          price_usd: jt.price_usd,
          price_eur: jt.price_eur,
          condition: jt.condition,
          condition_full: jt.condition_full,
          printing: jt.printing,
          name: jt.name,
          set: jt.set,
          card_number: jt.card_number,
          source: 'justtcg',
          currency: 'USD',
          avg_30d: jt.avg_30d,
          price_change_30d: jt.price_change_30d,
          last_updated: jt.last_updated
        };
        // If we have no TCGPlayer data yet, use JustTCG's price
        if (!pricing.tcgplayer && jt.price_usd) {
          pricing.tcgplayer = {
            price: jt.price_usd,
            source: 'justtcg',
            condition: jt.condition_full,
            printing: jt.printing,
            verified: true
          };
        }
      }

      // TCGGO / RapidAPI — real-time Cardmarket EUR + TCGPlayer USD
      if (result.type === 'rapidapi_cm' && result.data?.price) {
        const rd = result.data;
        console.log(`[PRICE] TCGGO: ${rd.price}€ NM (avg30: ${rd.avg30 || '?'}€, DE: ${rd.lowest_de || '?'}€)`);
        // This is the best EUR source — overrides everything except direct Cardmarket scrape
        if (pricing.cardmarket.source !== 'cardmarket_live') {
          pricing.cardmarket.price = rd.price;
          pricing.cardmarket.avg30 = rd.avg30 || pricing.cardmarket.avg30;
          pricing.cardmarket.avg7 = rd.avg7 || null;
          pricing.cardmarket.source = 'rapidapi_cm';
          pricing.cardmarket.verified = true;
          pricing.cardmarket.note = `Live NM from TCGGO${rd.avg30 ? ' · 30d avg: ' + rd.avg30.toFixed(2) + '€' : ''}`;
        }
        // Always store full data for cross-check display
        pricing.rapidapi_cm = {
          price: rd.price,
          lowest_nm: rd.lowest_nm,
          avg7: rd.avg7,
          avg30: rd.avg30,
          lowest_de: rd.lowest_de,
          lowest_fr: rd.lowest_fr,
          lowest_es: rd.lowest_es,
          lowest_it: rd.lowest_it,
          graded_psa10: rd.graded_psa10,
          graded_psa9: rd.graded_psa9,
          tcgplayer_market: rd.tcgplayer_market,
          image: rd.image,
          source: 'rapidapi_cm'
        };
        // Use TCGGO image if we don't have one
        if (!pricing.reference_image && rd.image) {
          pricing.reference_image = rd.image;
        }
      }
    }

    // GRADED card pricing — overrides everything else.
    // If the card is slabbed (PSA/BGS/CGC/SGC), use graded comp from TCGGO.
    let bestPrice = null;
    let priceSource = '';
    let priceCurrency = 'EUR';
    let isGraded = false;

    if (card.graded && card.graded.company && card.graded.grade) {
      isGraded = true;
      const company = String(card.graded.company).toUpperCase();
      const grade = Number(card.graded.grade);
      const r = pricing.rapidapi_cm || {};
      // Pick matching graded comp; fall back to nearest available.
      let gp = null, gLabel = '';
      if (company === 'PSA' && grade === 10 && r.graded_psa10) { gp = r.graded_psa10; gLabel = 'PSA 10'; }
      else if (company === 'PSA' && grade === 9 && r.graded_psa9) { gp = r.graded_psa9; gLabel = 'PSA 9'; }
      else if ((company === 'CGC' || company === 'BGS') && grade >= 9.5 && r.graded_cgc10) { gp = r.graded_cgc10; gLabel = `${company} ${grade}`; }
      // Closest-match fallbacks
      else if (grade >= 9.5 && r.graded_psa10) { gp = r.graded_psa10; gLabel = `${company} ${grade} (using PSA 10 comp)`; }
      else if (grade >= 8.5 && r.graded_psa9) { gp = r.graded_psa9; gLabel = `${company} ${grade} (using PSA 9 comp)`; }

      if (gp) {
        bestPrice = gp;
        priceSource = `Graded ${gLabel} · TCGGO`;
      }
    }

    if (!bestPrice && pricing.cardmarket?.price) {
      bestPrice = pricing.cardmarket.price;
      const sourceLabels = {
        'rapidapi_cm': 'RapidAPI CM (live)',
        'cardmarket_live': 'Cardmarket (live)',
        'api': 'Cardmarket (API)'
      };
      priceSource = sourceLabels[pricing.cardmarket.source] || 'Cardmarket';
    }
    if (!bestPrice && pricing.justtcg?.price_eur) {
      bestPrice = pricing.justtcg.price_eur;
      priceSource = `JustTCG $${pricing.justtcg.price_usd.toFixed(2)} → €${bestPrice.toFixed(2)} (${pricing.justtcg.condition_full})`;
    }
    if (!bestPrice && pricing.tcgplayer?.price) {
      bestPrice = Math.round(pricing.tcgplayer.price * USD_TO_EUR * 100) / 100;
      const src = pricing.tcgplayer.source === 'justtcg' ? 'JustTCG' : 'TCGPlayer';
      priceSource = `${src} $${pricing.tcgplayer.price.toFixed(2)} → €${bestPrice.toFixed(2)}`;
    }
    if (!bestPrice && pricing.ebay?.median_price) {
      bestPrice = pricing.ebay.median_price;
      priceCurrency = pricing.ebay.currency || 'EUR';
      priceSource = `eBay sold median`;
    }

    if (bestPrice) {
      // Graded cards: skip the condition multiplier — the grade IS the condition.
      const effectiveMult = isGraded ? 1.0 : conditionMult;
      const adjustedPrice = bestPrice * effectiveMult;
      const condLabel = isGraded
        ? `${card.graded.company} ${card.graded.grade}`
        : (card.condition_estimate || 'NM');
      pricing.buy_price = {
        suggested: Math.round(adjustedPrice * buyPercentage * 100) / 100,
        market_value: bestPrice,
        condition_adjusted: Math.round(adjustedPrice * 100) / 100,
        currency: priceCurrency,
        formula: `${bestPrice.toFixed(2)}€ × ${effectiveMult} (${condLabel}) × ${(buyPercentage * 100).toFixed(0)}% = ${(Math.round(adjustedPrice * buyPercentage * 100) / 100).toFixed(2)}€`,
        price_source: priceSource,
        graded: isGraded ? card.graded : null
      };
    }

    // ── HOTNESS SCORE ──
    // Combines price trend (7d vs 30d) + eBay sales volume into a
    // 0–100 score with a label: "hot" / "warm" / "steady" / "slow".
    // Helps Dave prioritise which cards to buy for quick resale.
    const hotness = { score: 50, label: 'steady', trend: null, volume: null, reasons: [] };

    // 1. PRICE TREND — compare 7-day avg to 30-day avg (from TCGGO)
    const rcm = pricing.rapidapi_cm || {};
    if (rcm.avg7 && rcm.avg30 && rcm.avg30 > 0) {
      const trendPct = ((rcm.avg7 - rcm.avg30) / rcm.avg30) * 100;
      hotness.trend = Math.round(trendPct * 10) / 10; // e.g. +12.3%
      // Trend scoring: +15% or more = very hot, +5% = warm, -5% = cooling
      if (trendPct >= 15)       { hotness.score += 30; hotness.reasons.push(`Price up ${hotness.trend}% (7d vs 30d)`); }
      else if (trendPct >= 5)   { hotness.score += 15; hotness.reasons.push(`Price up ${hotness.trend}%`); }
      else if (trendPct >= 0)   { hotness.score += 5;  hotness.reasons.push(`Price stable (+${hotness.trend}%)`); }
      else if (trendPct >= -5)  { hotness.score -= 5;  hotness.reasons.push(`Price dipping ${hotness.trend}%`); }
      else                      { hotness.score -= 15; hotness.reasons.push(`Price falling ${hotness.trend}%`); }
    }
    // Fallback: JustTCG 30d price change
    else if (pricing.justtcg?.price_change_30d) {
      const chg = pricing.justtcg.price_change_30d;
      hotness.trend = Math.round(chg * 10) / 10;
      if (chg >= 10)      { hotness.score += 20; hotness.reasons.push(`Price up ${hotness.trend}% (30d)`); }
      else if (chg >= 0)  { hotness.score += 5; }
      else                { hotness.score -= 10; hotness.reasons.push(`Price down ${hotness.trend}% (30d)`); }
    }

    // 2. SALES VOLUME — eBay sold listing count
    const ebayCount = pricing.ebay?.sample_size || 0;
    hotness.volume = ebayCount;
    if (ebayCount >= 12)      { hotness.score += 20; hotness.reasons.push(`${ebayCount} recent eBay sales`); }
    else if (ebayCount >= 6)  { hotness.score += 10; hotness.reasons.push(`${ebayCount} eBay sales`); }
    else if (ebayCount >= 3)  { hotness.score += 5; }
    else if (ebayCount === 0) { hotness.score -= 10; hotness.reasons.push('No recent eBay sales'); }

    // 3. VALUE BONUS — high-value cards (€5+) with good trend are better inventory
    if (bestPrice && bestPrice >= 10 && hotness.trend && hotness.trend > 0) {
      hotness.score += 10;
      hotness.reasons.push(`High-value card (${bestPrice.toFixed(2)}€)`);
    } else if (bestPrice && bestPrice < 1) {
      hotness.score -= 10; // bulk-bin cards are slow movers
    }

    // Clamp and label
    hotness.score = Math.max(0, Math.min(100, hotness.score));
    if (hotness.score >= 75)      hotness.label = 'hot';
    else if (hotness.score >= 60) hotness.label = 'warm';
    else if (hotness.score >= 40) hotness.label = 'steady';
    else                          hotness.label = 'slow';

    pricing.hotness = hotness;
    console.log(`[HOTNESS] ${card.name}: ${hotness.score}/100 (${hotness.label}) — ${hotness.reasons.join('; ') || 'default'}`);

    priceCacheSet(cacheKey, pricing);
    res.json(pricing);
  } catch (err) {
    console.error('Pricing error:', err.message);
    res.status(500).json({ error: 'Pricing lookup failed', details: err.message });
  }
});


// ============================================================
// MANUAL SEARCH
// ============================================================
app.get('/api/search', async (req, res) => {
  try {
    const { q, game } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const results = [];

    if (game === 'magic' || !game) {
      try {
        const resp = await axios.get(`https://api.scryfall.com/cards/autocomplete`, {
          params: { q }, timeout: 5000
        });
        if (resp.data?.data) {
          results.push(...resp.data.data.map(name => ({ name, game: 'magic' })));
        }
      } catch (e) { /* skip */ }
    }

    if (game === 'pokemon' || !game) {
      try {
        const resp = await axios.get(`https://api.pokemontcg.io/v2/cards`, {
          params: { q: `name:"${q}*"`, pageSize: 10 }, timeout: 8000
        });
        if (resp.data?.data) {
          results.push(...resp.data.data.map(c => ({
            name: c.name,
            set: c.set?.name,
            set_code: c.set?.id,
            number: c.number,
            game: 'pokemon',
            image: c.images?.small
          })));
        }
      } catch (e) { /* skip */ }
    }

    // For other TCGs, provide Cardmarket search link
    if (game && !['magic', 'pokemon'].includes(game)) {
      const gameSlug = getGameSlug(game);
      const searchUrl = gameSlug
        ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(q)}`
        : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(q)}`;
      results.push({ name: q, game, cardmarket_url: searchUrl, type: 'cardmarket_link' });
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});


// ============================================================
// HEALTH CHECK
// ============================================================
// Health endpoint — used by the client to show API status, and by UptimeRobot
// (or any uptime pinger) to keep the Render free-tier dyno warm.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: Date.now(),
    uptime: process.uptime(),
    apis: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      cardmarket: '✅ Direct links + API prices (no scraping)',
      ebay: !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID),
      scryfall: true,
      pokemontcg: true
    }
  });
});

// =========================================================
// ROOM-BASED SYNC (phone → laptop live scan push via SSE)
// =========================================================
// rooms: { roomId: { listeners: Set<res>, history: Array<{event}> } }
const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { listeners: new Set(), history: [] });
  return rooms.get(id);
}

// Phone (or any client) pushes a scanned card to the room
app.post('/api/room/:id/scan', (req, res) => {
  const room = getRoom(req.params.id);
  const payload = req.body || {};
  const msg = JSON.stringify({ type: 'scan', entry: payload, ts: Date.now() });
  room.history.push(msg);
  if (room.history.length > 500) room.history.shift();
  for (const client of room.listeners) {
    try { client.write(`data: ${msg}\n\n`); } catch (e) {}
  }
  res.json({ ok: true, listeners: room.listeners.size });
});

// Laptop (host) subscribes via SSE to receive scans live
app.get('/api/room/:id/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const room = getRoom(req.params.id);
  room.listeners.add(res);
  res.write(`data: ${JSON.stringify({ type: 'hello', roomId: req.params.id, ts: Date.now() })}\n\n`);
  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    room.listeners.delete(res);
  });
});

// Optional: laptop pulls recent history (in case SSE dropped)
app.get('/api/room/:id/history', (req, res) => {
  const room = getRoom(req.params.id);
  res.json({ history: room.history.slice(-50).map(s => JSON.parse(s)) });
});

// ============================================================
// PUBLIC CUSTOMER QUOTE TOOL — /quote
// ============================================================
// Standalone customer-facing page for bulk indicative pricing.
// Shares the /api/identify-stream + /api/price backend.
app.get('/quote', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'quote.html'));
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// MULTI-TENANT EMBED — shops + shop-config
// ============================================================
// shops table is the source of truth for which card shop a quote
// belongs to. shop_slug travels in URLs (data-shop="..."), looked
// up to a row that holds branding (logo, color, name) plus lead-
// routing fields (email, brevo_list_id) which are NEVER served
// publicly. The widget loads /api/shop-config/:slug, which strips
// to display-only fields. Lead emails route via shop.email when
// shop_slug is provided to /api/quote-lead, with the existing env-
// based defaults preserved as fallback so the single-tenant flow
// keeps working unchanged.
const SHOP_SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const shopConfigCache = new Map();   // slug -> { value, expires }
const SHOP_CONFIG_TTL_MS = 5 * 60 * 1000;

function invalidateShopConfig(slug) {
  if (slug) shopConfigCache.delete(String(slug).toLowerCase());
}

// Hash an IP with a daily-rotating salt so the leads table can
// detect "same IP submitted 50 leads" without storing the raw IP.
function hashIp(ip) {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const salt = process.env.IP_HASH_SALT || 'card-pricer-default-salt';
  return crypto.createHash('sha256').update(`${ip}|${day}|${salt}`).digest('hex').slice(0, 32);
}

// requirePlan middleware: chains after requireAuth and rejects
// users not on one of the allowed plans. Embed widget is gated
// to ['shop','beta'] — top tier (€59/mo) — by user's choice.
function requirePlan(allowedPlans) {
  return async (req, res, next) => {
    if (!supabase || !req.user) return res.status(401).json({ error: 'auth required' });
    try {
      const { data } = await supabase.from('profiles').select('plan').eq('user_id', req.user.id).maybeSingle();
      const plan = data?.plan || 'free';
      if (!allowedPlans.includes(plan)) {
        return res.status(403).json({ error: 'feature requires upgrade', plan, requires: allowedPlans });
      }
      next();
    } catch (e) {
      console.error('[REQUIRE-PLAN]', e.message);
      res.status(500).json({ error: 'plan check failed' });
    }
  };
}

// GET /api/shop-config/:slug — public, display-only fields.
// Cached in-memory for SHOP_CONFIG_TTL_MS so an embed widget
// modal-open doesn't hit the DB on every load.
app.get('/api/shop-config/:slug', async (req, res) => {
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
      .select('slug,name,logo_url,accent_color,cash_pct,credit_pct,active')
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

// Lead capture — customer submits their email + card list, we email them a
// quote and ping the shop. Uses Brevo transactional API (no new deps).
// Shop-aware: when shop_slug is provided we look up the shops table and
// route the email + newsletter signup to that shop's settings. Falls back
// to env-based defaults when no shop_slug — single-tenant Board & Brewed
// flow continues to work unchanged.
app.post('/api/quote-lead', quoteLeadLimiter, async (req, res) => {
  try {
    const { email, name, newsletter, cards, totals, cashPct, creditPct, shop_slug } = req.body || {};
    if (!email || !cards || !Array.isArray(cards) || !cards.length) {
      return res.status(400).json({ error: 'email and cards required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'invalid email' });
    }
    // Cap at 20 as a server-side guard (client also caps).
    const trimmed = cards.slice(0, 20);

    // Look up the shop if a slug was supplied. We pull the FULL row here
    // (not the public sanitised view) because we need email + brevo_list_id.
    let shop = null;
    if (shop_slug && supabase) {
      const slugLc = String(shop_slug).toLowerCase();
      if (SHOP_SLUG_RE.test(slugLc)) {
        try {
          const { data } = await supabase.from('shops').select('*').eq('slug', slugLc).eq('active', true).maybeSingle();
          if (data) shop = data;
        } catch (e) {
          console.warn('[QUOTE-LEAD] shop lookup failed:', e.message);
        }
      }
    }

    const SHOP_EMAIL = shop?.email || process.env.SHOP_EMAIL || 'dave@boardandbrewed.ie';
    const SHOP_NAME = shop?.name || process.env.SHOP_NAME || 'Board & Brewed';
    const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || SHOP_EMAIL;
    const newsletterListId = shop?.brevo_list_id || parseInt(process.env.BREVO_NEWSLETTER_LIST_ID || '0', 10);

    // Build card rows. Customer email gets rows without photos; shop email
    // gets a separate rows variant that references attached photo filenames.
    const rowsPlain = trimmed.map(c => {
      const cash = (c.cash_offer ?? 0).toFixed(2);
      const credit = (c.credit_offer ?? 0).toFixed(2);
      const mv = (c.market_value ?? 0).toFixed(2);
      return `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(c.name || 'Unknown')}${c.set_code ? ' <span style="color:#888;">(' + escapeHtml(c.set_code) + ')</span>' : ''}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${mv}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#f59e0b;">€${cash}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#22c55e;">€${credit}</td>
      </tr>`;
    }).join('');
    const rows = rowsPlain;

    // Extract photo dataUrls → Brevo attachments (base64, strip header).
    // Skip any that are missing or malformed. Cap at ~9MB total just in case.
    const attachments = [];
    let totalBytes = 0;
    trimmed.forEach((c, i) => {
      if (!c.photo || typeof c.photo !== 'string' || !c.photo.startsWith('data:image/')) return;
      const commaIdx = c.photo.indexOf(',');
      if (commaIdx < 0) return;
      const b64 = c.photo.slice(commaIdx + 1);
      const estBytes = Math.floor(b64.length * 0.75);
      if (totalBytes + estBytes > 9 * 1024 * 1024) return; // respect Brevo limit
      totalBytes += estBytes;
      // Try to keep the card name in the filename for quick triage
      const safeName = (c.name || 'card').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 30);
      attachments.push({
        name: `${String(i + 1).padStart(2, '0')}-${safeName}.jpg`,
        content: b64
      });
    });

    const customerHtml = `
      <div style="font-family:-apple-system,system-ui,sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#222;">
        <h2 style="color:#1a1a1a; margin-bottom:4px;">Your ${SHOP_NAME} Quote</h2>
        <p style="color:#666; margin-top:0;">Hi${name ? ' ' + escapeHtml(name) : ''}, here's an indicative price for the cards you sent over. Final offer depends on condition verified in-store.</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <thead><tr style="background:#f5f5f5;">
            <th style="padding:8px; text-align:left;">Card</th>
            <th style="padding:8px; text-align:right;">Market</th>
            <th style="padding:8px; text-align:right;">Cash offer</th>
            <th style="padding:8px; text-align:right;">Credit offer</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="font-weight:700; background:#fafafa;">
            <td style="padding:8px;">Totals (${trimmed.length} card${trimmed.length !== 1 ? 's' : ''})</td>
            <td style="padding:8px; text-align:right;">€${(totals?.market || 0).toFixed(2)}</td>
            <td style="padding:8px; text-align:right; color:#f59e0b;">€${(totals?.cash || 0).toFixed(2)}</td>
            <td style="padding:8px; text-align:right; color:#22c55e;">€${(totals?.credit || 0).toFixed(2)}</td>
          </tr></tfoot>
        </table>
        <p style="font-size:13px; color:#666;">Cash offer: ${cashPct || 55}% of market value. Store credit: ${creditPct || 70}% of market value. Condition-adjusted.</p>
        <p style="margin-top:24px;">Bring your cards to the shop or reply to this email to arrange drop-off. We'll give you a firm offer once we grade condition.</p>
        <p style="color:#888; font-size:12px; margin-top:32px;">${SHOP_NAME}</p>
      </div>`;

    const shopHtml = `
      <div style="font-family:sans-serif;">
        <h3>New quote request</h3>
        <p><b>Email:</b> ${escapeHtml(email)}${name ? ' &middot; <b>Name:</b> ' + escapeHtml(name) : ''}${newsletter ? ' &middot; <b>Newsletter:</b> YES' : ''}</p>
        <p><b>Totals:</b> Market €${(totals?.market || 0).toFixed(2)} &middot; Cash €${(totals?.cash || 0).toFixed(2)} &middot; Credit €${(totals?.credit || 0).toFixed(2)}</p>
        <p style="color:#666; font-size:13px;">${attachments.length} card photo${attachments.length !== 1 ? 's' : ''} attached.</p>
        <table style="width:100%; border-collapse:collapse;">
          <thead><tr><th align="left">#</th><th align="left">Card</th><th align="right">MV</th><th align="right">Cash</th><th align="right">Credit</th></tr></thead>
          <tbody>${trimmed.map((c, i) => {
            const cash = (c.cash_offer ?? 0).toFixed(2);
            const credit = (c.credit_offer ?? 0).toFixed(2);
            const mv = (c.market_value ?? 0).toFixed(2);
            return `<tr>
              <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">${String(i+1).padStart(2,'0')}</td>
              <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(c.name || 'Unknown')}${c.set_code ? ' <span style="color:#888;">(' + escapeHtml(c.set_code) + ')</span>' : ''}${c.card_number ? ' <span style="color:#888;">#' + escapeHtml(c.card_number) + '</span>' : ''}${c.condition_estimate ? ' <span style="color:#888;">· ' + escapeHtml(c.condition_estimate) + '</span>' : ''}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${mv}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#b45309;">€${cash}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#ca8a04;">€${credit}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

    // Persist the lead to quote_leads regardless of Brevo state — gives shops
    // a leads-history table even when email delivery is misconfigured.
    // Fire-and-forget so a DB blip can't take down the lead capture path.
    const persistLead = (extra) => {
      if (!supabase) return;
      supabase.from('quote_leads').insert({
        shop_id: shop?.id || null,
        shop_slug: shop?.slug || null,
        email,
        name: name || null,
        newsletter: !!newsletter,
        card_count: trimmed.length,
        total_market: totals?.market || 0,
        total_cash: totals?.cash || 0,
        total_credit: totals?.credit || 0,
        cards_json: trimmed.map(c => ({
          name: c.name, set_code: c.set_code, card_number: c.card_number,
          mv: c.market_value, cash: c.cash_offer, credit: c.credit_offer,
          condition: c.condition_estimate || null
        })),
        ip_hash: hashIp(req.ip),
        ...extra
      }).then(() => {}, e => console.warn('[QUOTE-LEAD] insert failed:', e.message));
    };

    // Best-effort send via Brevo. If no API key, just log + return ok so the
    // tool still works during setup — you'll still see the lead server-side.
    if (!process.env.BREVO_API_KEY) {
      console.log('[QUOTE-LEAD] (no BREVO_API_KEY set) would email to', email, 'and', SHOP_EMAIL);
      console.log('[QUOTE-LEAD] payload:', { email, name, newsletter, cardCount: trimmed.length, totals });
      persistLead();
      return res.json({ ok: true, emailed: false, note: 'Logged server-side. Set BREVO_API_KEY to enable email.' });
    }

    const sendOne = (toEmail, subject, htmlContent, attachmentsList) => {
      const payload = {
        sender: { name: SHOP_NAME, email: SENDER_EMAIL },
        to: [{ email: toEmail }],
        subject,
        htmlContent
      };
      if (attachmentsList && attachmentsList.length) payload.attachment = attachmentsList;
      return fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      }).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error('Brevo ' + r.status + ': ' + t); }));
    };

    // If the customer opted in, add them to the active newsletter list.
    // For multi-tenant: shop.brevo_list_id wins; otherwise falls back to
    // BREVO_NEWSLETTER_LIST_ID env var (single-tenant default).
    const subscribeIfOptedIn = async () => {
      if (!newsletter) return { subscribed: false };
      const listId = newsletterListId;
      if (!listId) {
        console.log('[QUOTE-LEAD] newsletter opt-in but no list ID configured');
        return { subscribed: false, reason: 'no list configured' };
      }
      try {
        // createContact will add OR update. updateEnabled: true lets us upsert without a 400 if they already exist.
        const res = await fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            email,
            attributes: name ? { FIRSTNAME: name } : {},
            listIds: [listId],
            updateEnabled: true
          })
        });
        if (!res.ok) {
          const text = await res.text();
          console.warn('[QUOTE-LEAD] newsletter subscribe failed:', res.status, text);
          return { subscribed: false, reason: text };
        }
        return { subscribed: true };
      } catch (e) {
        console.warn('[QUOTE-LEAD] newsletter subscribe error:', e.message);
        return { subscribed: false, reason: e.message };
      }
    };

    const [,, subRes] = await Promise.all([
      sendOne(email, `Your ${SHOP_NAME} card quote`, customerHtml),
      sendOne(SHOP_EMAIL, `New quote request — ${email}${newsletter ? ' (newsletter opt-in)' : ''}`, shopHtml, attachments),
      subscribeIfOptedIn()
    ]);

    persistLead();
    res.json({ ok: true, emailed: true, subscribed: subRes.subscribed });
  } catch (e) {
    console.error('[QUOTE-LEAD] failed:', e);
    res.status(500).json({ error: e.message || 'Failed to send quote' });
  }
});

// ============================================================
// SHOP CRUD — for shop-plan customers to manage their embed
// ============================================================
// One row per user (enforced by DB unique constraint on owner_user_id).
// Plan-gated to ['shop','beta'] — embed widget is a top-tier feature.
// All write paths invalidate the public shopConfigCache so changes
// propagate within ~60s of the Cache-Control max-age, instead of the
// 5-minute in-memory TTL.
const SHOP_PLANS = ['shop', 'beta'];

function validateShopPayload(body, { partial }) {
  const errs = [];
  const out = {};
  const { slug, name, email, logo_url, accent_color, cash_pct, credit_pct, brevo_list_id, active } = body || {};

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

  return { errs, out };
}

// GET /api/shop — current user's shop, or null.
app.get('/api/shop', requireAuth, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  try {
    const { data } = await supabase.from('shops').select('*').eq('owner_user_id', req.user.id).maybeSingle();
    res.json(data || null);
  } catch (e) {
    console.error('[GET /api/shop]', e.message);
    res.status(500).json({ error: 'lookup failed' });
  }
});

// POST /api/shop — create the user's shop. 409 on slug conflict.
app.post('/api/shop', requireAuth, requirePlan(SHOP_PLANS), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const { errs, out } = validateShopPayload(req.body, { partial: false });
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  try {
    const { data, error } = await supabase.from('shops').insert({
      owner_user_id: req.user.id,
      ...out
    }).select().maybeSingle();
    if (error) {
      if (error.code === '23505') {
        // unique violation: either slug taken (slug index) or owner already has a shop (owner_user_id unique).
        const detail = String(error.message || '').toLowerCase();
        if (detail.includes('owner_user_id')) return res.status(409).json({ error: 'you already have a shop — use PATCH /api/shop to update' });
        return res.status(409).json({ error: 'slug already taken' });
      }
      return res.status(400).json({ error: error.message });
    }
    invalidateShopConfig(out.slug);
    res.json(data);
  } catch (e) {
    console.error('[POST /api/shop]', e.message);
    res.status(500).json({ error: 'create failed' });
  }
});

// PATCH /api/shop — update the user's shop. 409 on slug conflict.
app.patch('/api/shop', requireAuth, requirePlan(SHOP_PLANS), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'unavailable' });
  const { errs, out } = validateShopPayload(req.body, { partial: true });
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  if (!Object.keys(out).length) return res.status(400).json({ error: 'no fields to update' });
  try {
    // Capture the old slug so we can invalidate it after a slug rename.
    const { data: existing } = await supabase.from('shops').select('slug').eq('owner_user_id', req.user.id).maybeSingle();
    const { data, error } = await supabase
      .from('shops')
      .update(out)
      .eq('owner_user_id', req.user.id)
      .select()
      .maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'slug already taken' });
      return res.status(400).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'no shop to update — POST /api/shop first' });
    if (existing?.slug) invalidateShopConfig(existing.slug);
    if (data.slug) invalidateShopConfig(data.slug);
    res.json(data);
  } catch (e) {
    console.error('[PATCH /api/shop]', e.message);
    res.status(500).json({ error: 'update failed' });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Card Pricer running at http://localhost:${PORT}`);
  console.log(`\n  API Status:`);
  console.log(`    Claude Vision:    ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING — add ANTHROPIC_API_KEY to .env'}`);
  console.log(`    Cardmarket:       Direct links + API prices (Pokemon/MTG get EUR prices from API)`);
  console.log(`    Scryfall (MTG):   Free (includes EUR/Cardmarket prices)`);
  console.log(`    Pokemon TCG API:  Free (includes Cardmarket prices)`);
  console.log(`    eBay API:         ${process.env.EBAY_APP_ID ? 'configured' : 'not configured'}\n`);
  console.log('  Ready! No browser warmup needed — instant startup.\n');
});