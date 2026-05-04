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
import { getUsdToEur } from '../_legacy-pricing.js';

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

export default router;
