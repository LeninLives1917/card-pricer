// apps/server/routes/account.js
// Owner: A1 | Slice: S5
//
// Routes (V1 server.js:180-187, 222-280, 284-299, 793-823):
//   GET  /api/usage          — requireAuth
//   POST /api/welcome-email  — requireAuth
//   GET  /api/me             — requireAuth
//   GET  /api/state          — requireAuth
//   PUT  /api/state          — requireAuth (10MB body cap)
//
// /api/v2/sessions arrives in S16 (sessions cutover, A3) — not in S5 scope.

import express from 'express';
import { supabase } from '../_clients.js';
import { requireAuth } from '../middleware/auth.js';
import { getUsage } from '../middleware/quota.js';

const router = express.Router();

router.get('/api/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getUsage(req.user.id);
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/welcome-email', requireAuth, async (req, res) => {
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

router.get('/api/me', requireAuth, async (req, res) => {
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

router.get('/api/state', requireAuth, async (req, res) => {
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

router.put('/api/state', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
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

export default router;
