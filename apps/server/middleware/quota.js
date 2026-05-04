// apps/server/middleware/quota.js
// Owner: A1 | Slice: S5
//
// PLAN_LIMITS, getUsage, enforceQuota, logScanEvent — verbatim from V1
// server.js (lines 117-176 + 102-108). The X-Scan-Plan / X-Scan-Used /
// X-Scan-Limit response headers (V2_AUDIT §5.1) are written by enforceQuota
// — the wrapped window.fetch in public/index.html reads these to render the
// usage banner without a second round-trip.
//
// V2_AUDIT R6 / §4: enforceQuota fails OPEN on Supabase errors so a
// Supabase blip can't take down the scanner at a card show.

import { supabase } from '../_clients.js';

// Monthly scan caps by plan. `null` = unlimited.
export const PLAN_LIMITS = {
  'beta':   null,
  'free':   40,
  'solo':   100,
  'vendor': 500,
  'shop':   null,
};

// Fire-and-forget scan logging. Phase C uses this to enforce monthly
// quotas for free-plan users. Failure to log must NEVER block a scan.
export function logScanEvent(userId, endpoint) {
  if (!supabase || !userId) return;
  supabase.from('scan_events').insert({ user_id: userId, endpoint }).then(
    () => {},
    (e) => console.warn('[AUTH] scan_events insert failed:', e?.message || e)
  );
}

// Query the user's scan count for the current calendar month (UTC).
// Returns { plan, used, limit, resetAt }.
export async function getUsage(userId) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  const plan = profile?.plan || 'free';
  const limit = PLAN_LIMITS[plan] ?? null;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { count } = await supabase
    .from('scan_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('ts', monthStart.toISOString());
  return {
    plan,
    used: count || 0,
    limit,
    resetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  };
}

export async function enforceQuota(req, res, next) {
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
    res.setHeader('X-Scan-Plan', usage.plan);
    res.setHeader('X-Scan-Used', String(usage.used));
    if (usage.limit != null) res.setHeader('X-Scan-Limit', String(usage.limit));
    next();
  } catch (e) {
    console.warn('[QUOTA] check failed — allowing through:', e.message);
    next();
  }
}
