// apps/server/routes/admin.js
// Owner: A1 | Slice: S5
//
// Routes (V1 server.js:302-597):
//   GET  /api/admin/overview         — requireAuth + requireAdmin
//   GET  /api/admin/users            — requireAuth + requireAdmin
//   POST /api/admin/arbitrage        — requireAuth + requireAdmin
//   POST /api/admin/refresh-prices   — requireAuth + requireAdmin
//   GET  /api/admin/refresh-status   — requireAuth + requireAdmin
//
// arbitrageVariants / bestArbitrage / singleVariantArbitrage helpers stay
// local to this route — they're admin-only and don't need to live in
// pricing/. V2_AUDIT R7: each variant emits its own row (do not collapse).

import express from 'express';
import { supabase } from '../_clients.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  CARD_DB,
  CARD_PRICES,
  isCardDbLoading,
  getLastPriceRefreshAt,
  downloadCardDatabase,
} from '../_card-db-boot.js';
import { getUsdToEur } from '../../../pricing/fx.js';
import { register as metricsRegister } from '../../../infra/observability/metrics.js';

const router = express.Router();

const PLAN_MRR = {
  'solo':   { monthly: 9,  yearly: 81  / 12 },
  'vendor': { monthly: 29, yearly: 261 / 12 },
  'shop':   { monthly: 59, yearly: 531 / 12 }
};

// V1 server.js:409-454.
function arbitrageVariants(entry, usdToEurRate, direction = 'us_to_eu') {
  if (!entry?.tcg || !entry?.cm) return [];
  const cm = entry.cm;
  const tcg = entry.tcg;

  const pairs = [];
  const cmNormalEur = cm.lowPriceExPlus || cm.lowPrice || cm.trendPrice || 0;
  const cmAvg7 = cm.avg7 || 0;
  const cmAvg30 = cm.avg30 || 0;
  for (const k of ['normal', 'holofoil', '1stEditionNormal', '1stEditionHolofoil', 'unlimitedHolofoil']) {
    const v = tcg[k];
    const usd = v?.market;
    if (usd && cmNormalEur) pairs.push({ variant: k, usd, eur: cmNormalEur, tcgLow: v?.low || 0, cmAvg7, cmAvg30 });
  }
  const cmReverseEur = cm.reverseHoloLow || cm.reverseHoloTrend || 0;
  const cmReverseAvg7 = cm.reverseHoloAvg7 || 0;
  const cmReverseAvg30 = cm.reverseHoloAvg30 || 0;
  if (tcg.reverseHolofoil?.market && cmReverseEur) {
    pairs.push({
      variant: 'reverseHolofoil',
      usd: tcg.reverseHolofoil.market,
      eur: cmReverseEur,
      tcgLow: tcg.reverseHolofoil.low || 0,
      cmAvg7: cmReverseAvg7,
      cmAvg30: cmReverseAvg30
    });
  }

  const out = [];
  for (const v of pairs) {
    const usdInEur = v.usd * usdToEurRate;
    if (usdInEur <= 0) continue;
    const ratio = direction === 'eu_to_us' ? (usdInEur / v.eur) : (v.eur / usdInEur);
    const tcgLowMarketRatio = v.tcgLow > 0 && v.usd > 0 ? v.tcgLow / v.usd : 0;
    out.push({
      ...v,
      usdInEur,
      ratio,
      tcgLowMarketRatio: +tcgLowMarketRatio.toFixed(3)
    });
  }
  return out;
}

// V1 server.js:467-491 — single-variant variant of the same logic.
function singleVariantArbitrage(entry, variant, usdToEurRate, direction = 'us_to_eu') {
  if (!entry?.tcg || !entry?.cm) return null;
  const tcg = entry.tcg;
  const cm = entry.cm;
  let usd = 0, eur = 0, tcgLow = 0, cmAvg7 = 0, cmAvg30 = 0;
  if (variant === 'reverseHolofoil') {
    usd = tcg.reverseHolofoil?.market || 0;
    eur = cm.reverseHoloLow || cm.reverseHoloTrend || 0;
    tcgLow = tcg.reverseHolofoil?.low || 0;
    cmAvg7 = cm.reverseHoloAvg7 || 0;
    cmAvg30 = cm.reverseHoloAvg30 || 0;
  } else {
    usd = tcg[variant]?.market || 0;
    eur = cm.lowPriceExPlus || cm.lowPrice || cm.trendPrice || 0;
    tcgLow = tcg[variant]?.low || 0;
    cmAvg7 = cm.avg7 || 0;
    cmAvg30 = cm.avg30 || 0;
  }
  if (!usd || !eur) return null;
  const usdInEur = usd * usdToEurRate;
  if (usdInEur <= 0) return null;
  const ratio = direction === 'eu_to_us' ? (usdInEur / eur) : (eur / usdInEur);
  const tcgLowMarketRatio = tcgLow > 0 && usd > 0 ? +(tcgLow / usd).toFixed(3) : 0;
  return { variant, usd, eur, usdInEur, ratio, cmAvg7, cmAvg30, tcgLowMarketRatio };
}

router.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  try {
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

    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const { count: scansThisMonth } = await supabase
      .from('scan_events')
      .select('*', { count: 'exact', head: true })
      .gte('ts', monthStart.toISOString());

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

router.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('user_id, plan, plan_interval, stripe_customer_id, stripe_subscription_id, created_at, is_admin')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const { data: events } = await supabase
      .from('scan_events').select('user_id').gte('ts', monthStart);
    const usage = {};
    for (const e of events || []) { usage[e.user_id] = (usage[e.user_id] || 0) + 1; }

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

router.post('/api/admin/arbitrage', requireAuth, requireAdmin, (req, res) => {
  const {
    minSrcPrice = 5,
    threshold = 1.30,
    sets = null,
    variant = 'auto',
    limit = 100,
    sortBy = 'ratio',
    direction = 'us_to_eu',
    liquidity = 'any',
    tcgTightness = 0.6
  } = req.body || {};
  const minSrc = req.body?.minUsd != null ? req.body.minUsd : minSrcPrice;

  const dir = direction === 'eu_to_us' ? 'eu_to_us' : 'us_to_eu';
  const liqMode = ['any', 'active', 'strong'].includes(liquidity) ? liquidity : 'any';
  const tightness = Number.isFinite(+tcgTightness) ? Math.max(0, Math.min(1, +tcgTightness)) : 0.6;

  const setFilter = sets && Array.isArray(sets) && sets.length
    ? new Set(sets.map(s => String(s).toLowerCase()))
    : null;

  const usdToEur = getUsdToEur();
  const out = [];
  for (const [key, e] of CARD_PRICES) {
    if (setFilter && !setFilter.has(String(e.setId || '').toLowerCase())) continue;
    const arbs = (variant === 'auto')
      ? arbitrageVariants(e, usdToEur, dir)
      : (() => { const v = singleVariantArbitrage(e, variant, usdToEur, dir); return v ? [v] : []; })();
    for (const arb of arbs) {
      const srcPrice = dir === 'eu_to_us' ? arb.eur : arb.usd;
      if (srcPrice < minSrc) continue;
      if (arb.ratio < threshold) continue;
      if (liqMode === 'active' && !(arb.cmAvg7 > 0)) continue;
      if (liqMode === 'strong' && !(arb.cmAvg7 > 0 && arb.tcgLowMarketRatio >= tightness)) continue;
      const spread = dir === 'eu_to_us'
        ? +(arb.usd - (arb.eur / usdToEur)).toFixed(2)
        : +(arb.eur - arb.usdInEur).toFixed(2);
      out.push({
        key: `${key}-${arb.variant}`,
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
        spread,
        spreadCurrency: dir === 'eu_to_us' ? 'USD' : 'EUR',
        direction: dir,
        cmAvg7: +(arb.cmAvg7 || 0).toFixed(2),
        cmAvg30: +(arb.cmAvg30 || 0).toFixed(2),
        tcgLowMarketRatio: arb.tcgLowMarketRatio,
        tcgplayerUrl: e.tcgplayerUrl,
        cardmarketUrl: e.cardmarketUrl,
        fetchedAt: e.fetchedAt
      });
    }
  }
  out.sort((a, b) => sortBy === 'spread' || sortBy === 'spreadEur'
    ? b.spread - a.spread
    : b.ratio - a.ratio);
  res.json({
    rate: usdToEur,
    direction: dir,
    cardsPriced: CARD_PRICES.size,
    matched: out.length,
    lastRefreshAt: getLastPriceRefreshAt() || null,
    results: out.slice(0, Math.min(parseInt(limit, 10) || 100, 500))
  });
});

router.post('/api/admin/refresh-prices', requireAuth, requireAdmin, async (req, res) => {
  if (isCardDbLoading()) {
    return res.json({ ok: false, alreadyLoading: true, cardsPriced: CARD_PRICES.size });
  }
  res.json({ ok: true, started: true, before: CARD_PRICES.size });
  downloadCardDatabase({ force: true })
    .then(() => console.log(`[ARBITRAGE] refresh complete: ${CARD_PRICES.size} priced cards`))
    .catch(e => console.error('[ARBITRAGE] refresh failed:', e.message));
});

router.get('/api/admin/refresh-status', requireAuth, requireAdmin, (req, res) => {
  res.json({
    cardsPriced: CARD_PRICES.size,
    cardsTotal: CARD_DB.size,
    loading: isCardDbLoading(),
    lastRefreshAt: getLastPriceRefreshAt() || null,
    rate: getUsdToEur()
  });
});

// ----- /api/admin/analytics (V2 S13 / F8) -----
//
// Vendor analytics dashboard. Computes:
//   - quotes_per_day      — daily quote-lead counts (sparkline source)
//   - totals              — total quotes/leads, avg basket (market/cash/credit),
//                           avg cards/quote
//   - top_cards           — most-requested card singles, flattened from
//                           quote_leads.cards_json arrays in JS (top-10)
//   - conversion_pct      — % of quotes that produced an emailed lead. We
//                           write a quote_leads row only when the user submits
//                           the form, so this is ~100% in V2 today; the field
//                           is kept for future "soft quote" rows that don't
//                           include an email.
//
// Optional filters:
//   ?shop_slug=brewed     — scope to a single shop (string match on shop_slug)
//   ?shop_id=<uuid>       — scope to a single shop by id (preferred)
//   ?window=7d|30d|90d    — default 30d
//
// Row scan capped at MAX_ROWS to keep response fast even when a busy
// shop accumulates leads. Top-cards aggregation happens in JS because
// jsonb_array_elements aggregation in supabase-js is awkward; the cap
// keeps the JS pass O(n) bounded.
const ANALYTICS_MAX_ROWS = 5000;

export function parseAnalyticsWindow(raw) {
  // Accept '7d' / '30d' / '90d'. Default 30d. Returns { days, label }.
  const v = String(raw || '').trim().toLowerCase();
  if (v === '7d') return { days: 7, label: '7d' };
  if (v === '90d') return { days: 90, label: '90d' };
  return { days: 30, label: '30d' };
}

export function aggregateTopCards(leads, limit = 10) {
  // Flatten leads[*].cards_json arrays, group by (set_code, card_number, name),
  // sum the count, average the market value. Returns rows sorted by count desc,
  // then avg_market desc as a tiebreaker.
  const acc = new Map();
  for (const lead of leads || []) {
    const cards = Array.isArray(lead?.cards_json) ? lead.cards_json : [];
    for (const c of cards) {
      if (!c) continue;
      const setCode = String(c.set_code ?? c.setCode ?? '').toUpperCase();
      const cardNumber = String(c.card_number ?? c.number ?? '').trim();
      const name = String(c.name ?? '').trim();
      const market = Number(c.market ?? c.market_value ?? c.price ?? 0) || 0;
      // Group key: set+number when present (deduplicates spelling/casing of name);
      // fall back to name-only so cards without set still aggregate sanely.
      const key = (setCode || cardNumber)
        ? `${setCode}|${cardNumber}|${name.toLowerCase()}`
        : `name:${name.toLowerCase()}`;
      const cur = acc.get(key) || { name, set_code: setCode, card_number: cardNumber, count: 0, total_market: 0, market_n: 0 };
      cur.count += 1;
      if (market > 0) { cur.total_market += market; cur.market_n += 1; }
      // Prefer the most recently seen non-empty name so we don't end up with ''.
      if (!cur.name && name) cur.name = name;
      acc.set(key, cur);
    }
  }
  const rows = Array.from(acc.values()).map((r) => ({
    name: r.name || '—',
    set_code: r.set_code || '',
    card_number: r.card_number || '',
    count: r.count,
    avg_market: r.market_n > 0 ? +(r.total_market / r.market_n).toFixed(2) : 0
  }));
  rows.sort((a, b) => (b.count - a.count) || (b.avg_market - a.avg_market));
  return rows.slice(0, Math.max(1, limit | 0));
}

export function computeAnalyticsTotals(leads) {
  // Returns { quotes, leads, avg_basket_market, avg_basket_cash,
  // avg_basket_credit, avg_card_count, conversion_pct }.
  const n = leads.length;
  if (!n) {
    return {
      quotes: 0, leads: 0,
      avg_basket_market: 0, avg_basket_cash: 0, avg_basket_credit: 0,
      avg_card_count: 0, conversion_pct: 0
    };
  }
  let mSum = 0, cSum = 0, crSum = 0, ccSum = 0;
  let mN = 0, cN = 0, crN = 0, ccN = 0;
  let withEmail = 0;
  for (const l of leads) {
    if (Number.isFinite(+l.total_market)) { mSum += +l.total_market; mN++; }
    if (Number.isFinite(+l.total_cash))   { cSum += +l.total_cash;   cN++; }
    if (Number.isFinite(+l.total_credit)) { crSum += +l.total_credit; crN++; }
    if (Number.isFinite(+l.card_count))   { ccSum += +l.card_count;   ccN++; }
    if (l.email) withEmail++;
  }
  const avg = (sum, count) => count > 0 ? +(sum / count).toFixed(2) : 0;
  return {
    quotes: n,
    leads: withEmail,
    avg_basket_market: avg(mSum, mN),
    avg_basket_cash: avg(cSum, cN),
    avg_basket_credit: avg(crSum, crN),
    avg_card_count: avg(ccSum, ccN),
    conversion_pct: n > 0 ? Math.round((withEmail / n) * 100) : 0
  };
}

export function bucketQuotesPerDay(leads, days) {
  // Returns [{date:'YYYY-MM-DD', count:n}] for every day in the window,
  // including zero-count days so the sparkline renders a continuous axis.
  const buckets = new Map();
  const today = new Date();
  // Walk from oldest → newest, UTC dates.
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const l of leads || []) {
    const ts = l?.created_at;
    if (!ts) continue;
    const day = String(ts).slice(0, 10);
    if (buckets.has(day)) buckets.set(day, buckets.get(day) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

router.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const win = parseAnalyticsWindow(req.query.window);
    const since = new Date(Date.now() - win.days * 24 * 60 * 60 * 1000).toISOString();

    let q = supabase
      .from('quote_leads')
      .select('id, shop_id, shop_slug, email, card_count, total_market, total_cash, total_credit, cards_json, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(ANALYTICS_MAX_ROWS);

    if (req.query.shop_id)   q = q.eq('shop_id', req.query.shop_id);
    if (req.query.shop_slug) q = q.eq('shop_slug', req.query.shop_slug);

    const { data: leads, error } = await q;
    if (error) throw error;

    const rows = leads || [];
    const totals = computeAnalyticsTotals(rows);
    const top_cards = aggregateTopCards(rows, 10);
    const quotes_per_day = bucketQuotesPerDay(rows, win.days);

    res.json({
      window: win.label,
      since,
      shop_id: req.query.shop_id || null,
      shop_slug: req.query.shop_slug || null,
      quotes_per_day,
      totals,
      top_cards,
      conversion_pct: totals.conversion_pct,
      row_cap: ANALYTICS_MAX_ROWS,
      truncated: rows.length >= ANALYTICS_MAX_ROWS
    });
  } catch (e) {
    console.error('[ADMIN] analytics failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ----- /api/metrics -----
//
// Prometheus exposition format. Auth model:
//   - PRIMARY: requireAuth + requireAdmin (vendor admin can scrape via UI / cURL).
//   - BYPASS:  if METRICS_TOKEN env is set AND the request carries a matching
//              `Authorization: Bearer <token>` header, skip Supabase auth.
//              This is for an external Prometheus scraper that has no
//              user account. The token is opaque + rotated separately
//              from Supabase JWTs.
//
// Rationale for choosing the dual-mode over pure requireAdmin:
// the admin gate requires a Supabase round-trip on every scrape (every 15s
// in a typical Prometheus deployment) — that's wasteful and ties metrics
// availability to Supabase uptime. METRICS_TOKEN gives us a sealed
// scrape path. If METRICS_TOKEN is unset, only the requireAdmin path
// works, which is the safe default.
function metricsTokenOrAdmin(req, res, next) {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && auth.slice(7) === token) {
      return next();
    }
  }
  // Fall through to the standard admin gate (chained below).
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return requireAdmin(req, res, next);
  });
}

router.get('/api/metrics', metricsTokenOrAdmin, async (req, res) => {
  try {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    const body = await metricsRegister.metrics();
    res.end(body);
  } catch (e) {
    console.error('[METRICS] export failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
