// apps/server/middleware/auth.js
// Owner: A1 | Slice: S5
//
// requireAuth, requireAdmin, requirePlan — verbatim from V1 server.js
// (lines 80-98 / 195-207 / 5223-5238). Behaviour preserved 1:1; the only
// change is moving them out of the giant module.
//
// Scanner-mode bypass (?pair=ROOMID, V2_AUDIT §5.14) is a CLIENT-SIDE
// concern — the route handler for /api/room/:id/scan is itself
// unauthenticated, so no middleware change is needed here.

import { supabase } from '../_clients.js';

export async function requireAuth(req, res, next) {
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

export async function requireAdmin(req, res, next) {
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

export function requirePlan(allowedPlans) {
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
