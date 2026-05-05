// apps/server/routes/billing.js
// Owner: A1 | Slice: S5
//
// Routes (V1 server.js:641-784):
//   POST /api/checkout         — requireAuth
//   POST /api/portal           — requireAuth
//   POST /api/stripe-webhook   — signature-verified (no requireAuth)
//
// CRITICAL: /api/stripe-webhook depends on req.rawBody, which is captured
// by the express.json verify callback registered in apps/server/index.js
// (V2_AUDIT §5.12 / R6). Replacing that middleware naively breaks signature
// verification.

import express from 'express';
import { supabase, stripe } from '../_clients.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// V1 server.js:611-617 — price ID → { plan, interval }.
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

router.post('/api/checkout', requireAuth, async (req, res) => {
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

router.post('/api/portal', requireAuth, async (req, res) => {
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

router.post('/api/stripe-webhook', async (req, res) => {
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
        break;
      }
      case 'invoice.paid':
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

export default router;
