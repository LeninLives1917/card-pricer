// POST /api/quote-lead — captures a customer quote, sends emails via Brevo,
// optionally subscribes to the configured newsletter, persists to quote_leads.
// Shop-aware via optional shop_slug; falls back to env defaults for the
// single-tenant Board & Brewed flow that v1 served.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import {
  brevoSendEmail,
  customerQuoteHtml,
  hashIp,
  shopLeadHtml,
  subscribeBrevo,
  subscribeConvertKit,
  subscribeMailchimp,
} from '@card-pricer/shared';
import { env, getSingleTenantDefaults } from '$lib/server/env.js';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const QuoteLeadSchema = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional().nullable(),
  newsletter: z.boolean().optional().default(false),
  cards: z
    .array(
      z.object({
        name: z.string().optional(),
        set_code: z.string().optional().nullable(),
        card_number: z.string().optional().nullable(),
        condition_estimate: z.string().optional().nullable(),
        market_value: z.number().optional().default(0),
        cash_offer: z.number().optional().default(0),
        credit_offer: z.number().optional().default(0),
        photo: z.string().optional().nullable(),
      }),
    )
    .min(1)
    .max(20),
  totals: z
    .object({
      market: z.number().default(0),
      cash: z.number().default(0),
      credit: z.number().default(0),
    })
    .optional(),
  cashPct: z.number().min(1).max(100).optional().default(55),
  creditPct: z.number().min(1).max(100).optional().default(70),
  shop_slug: z.string().optional().nullable(),
});

// Naive in-memory rate limit (10/hour per IP). Carries v1's quoteLeadLimiter
// behaviour. Production should swap for Upstash Redis but in-memory is fine
// while we're single-instance on Render.
const rateBucket = new Map<string, number[]>();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 10;
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const arr = (rateBucket.get(ip) ?? []).filter((ts) => ts > now - RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) return false;
  arr.push(now);
  rateBucket.set(ip, arr);
  return true;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const ip = getClientAddress();
  if (!rateLimit(ip)) {
    throw error(429, 'Too many quote requests — please try again later.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'invalid JSON body');
  }
  const parsed = QuoteLeadSchema.safeParse(body);
  if (!parsed.success) {
    throw error(400, parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { email, name, newsletter, cards, totals, cashPct, creditPct, shop_slug } = parsed.data;

  // Look up shop if slug supplied — pulls full row (with email + brevo_list_id).
  // No cache here: we need fresh data, and quote-lead is rare relative to /api/shop-config.
  let shop: ShopRow | null = null;
  if (shop_slug && SLUG_RE.test(shop_slug.toLowerCase())) {
    const sb = getSupabase();
    const { data } = await sb
      .from('shops')
      .select('*')
      .eq('slug', shop_slug.toLowerCase())
      .eq('active', true)
      .maybeSingle();
    if (data) shop = data as ShopRow;
  }

  const defaults = getSingleTenantDefaults();
  const SHOP_EMAIL = shop?.email ?? defaults.shopEmail;
  const SHOP_NAME = shop?.name ?? defaults.shopName;
  const SENDER_EMAIL = env.BREVO_SENDER_EMAIL ?? SHOP_EMAIL;

  // Coerce + size-cap (server-side defence; client already caps at 20).
  const trimmed = cards.slice(0, 20);
  const cardRows = trimmed.map((c) => ({
    name: c.name ?? 'Unknown',
    setCode: c.set_code ?? null,
    cardNumber: c.card_number ?? null,
    conditionEstimate: c.condition_estimate ?? null,
    marketValue: c.market_value ?? 0,
    cashOffer: c.cash_offer ?? 0,
    creditOffer: c.credit_offer ?? 0,
  }));

  // Photo dataURLs → Brevo attachments (base64), capped at ~9MB total.
  const attachments: Array<{ name: string; content: string }> = [];
  let totalBytes = 0;
  trimmed.forEach((c, i) => {
    if (!c.photo || typeof c.photo !== 'string' || !c.photo.startsWith('data:image/')) return;
    const commaIdx = c.photo.indexOf(',');
    if (commaIdx < 0) return;
    const b64 = c.photo.slice(commaIdx + 1);
    const estBytes = Math.floor(b64.length * 0.75);
    if (totalBytes + estBytes > 9 * 1024 * 1024) return;
    totalBytes += estBytes;
    const safeName = (c.name ?? 'card').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 30);
    attachments.push({
      name: `${String(i + 1).padStart(2, '0')}-${safeName}.jpg`,
      content: b64,
    });
  });

  const customerHtml = customerQuoteHtml({
    shopName: SHOP_NAME,
    customerName: name ?? null,
    cards: cardRows,
    totals: totals ?? { market: 0, cash: 0, credit: 0 },
    cashPct,
    creditPct,
  });
  const shopHtml = shopLeadHtml({
    shopName: SHOP_NAME,
    customerName: name ?? null,
    cards: cardRows,
    totals: totals ?? { market: 0, cash: 0, credit: 0 },
    cashPct,
    creditPct,
    leadEmail: email,
    leadName: name,
    newsletter,
    attachmentCount: attachments.length,
  });

  // Persist the lead unconditionally — gives us a leads-history table even
  // when Brevo is misconfigured. Fire-and-forget; do not block response.
  const persistLead = async () => {
    const sb = getSupabase();
    try {
      await sb.from('quote_leads').insert({
        shop_id: shop?.id ?? null,
        shop_slug: shop?.slug ?? null,
        email,
        name: name ?? null,
        newsletter,
        card_count: trimmed.length,
        total_market: totals?.market ?? 0,
        total_cash: totals?.cash ?? 0,
        total_credit: totals?.credit ?? 0,
        cards_json: trimmed.map((c) => ({
          name: c.name,
          set_code: c.set_code,
          card_number: c.card_number,
          mv: c.market_value,
          cash: c.cash_offer,
          credit: c.credit_offer,
          condition: c.condition_estimate ?? null,
        })),
        ip_hash: hashIp(ip, env.IP_HASH_SALT),
      });
    } catch (e) {
      console.warn('[QUOTE-LEAD] insert failed:', e instanceof Error ? e.message : String(e));
    }
  };

  // No Brevo key → log + persist + return ok. Lets the tool work in dev
  // without a Brevo account. Same shape as v1.
  if (!env.BREVO_API_KEY) {
    console.log('[QUOTE-LEAD] (no BREVO_API_KEY set) would email to', email, 'and', SHOP_EMAIL);
    void persistLead();
    return json({ ok: true, emailed: false, note: 'Logged server-side. Set BREVO_API_KEY to enable email.' });
  }

  const brevoConfig = {
    apiKey: env.BREVO_API_KEY,
    senderEmail: SENDER_EMAIL,
    senderName: SHOP_NAME,
  };

  const provider = (shop?.newsletter_provider ?? 'brevo') as
    | 'brevo'
    | 'mailchimp'
    | 'convertkit'
    | 'off';
  const subscribePromise = (async () => {
    if (!newsletter) return { subscribed: false };
    if (provider === 'off') {
      return { subscribed: false, reason: 'provider off — opt-in saved to quote_leads' };
    }
    if (provider === 'mailchimp') {
      return subscribeMailchimp(
        { email, name },
        shop?.mailchimp_api_key ?? '',
        shop?.mailchimp_list_id ?? '',
      );
    }
    if (provider === 'convertkit') {
      return subscribeConvertKit(
        { email, name },
        shop?.convertkit_api_key ?? '',
        shop?.convertkit_form_id ?? '',
      );
    }
    const listId =
      shop?.brevo_list_id ?? Number.parseInt(env.BREVO_NEWSLETTER_LIST_ID ?? '0', 10);
    return subscribeBrevo({ email, name }, env.BREVO_API_KEY ?? '', listId);
  })();

  let emailed = false;
  let subscribed = false;
  try {
    const [, , subRes] = await Promise.all([
      brevoSendEmail(brevoConfig, {
        to: email,
        subject: `Your ${SHOP_NAME} card quote`,
        htmlContent: customerHtml,
      }),
      brevoSendEmail(brevoConfig, {
        to: SHOP_EMAIL,
        subject: `New quote request — ${email}${newsletter ? ' (newsletter opt-in)' : ''}`,
        htmlContent: shopHtml,
        attachments,
      }),
      subscribePromise,
    ]);
    emailed = true;
    subscribed = !!subRes.subscribed;
  } catch (e) {
    console.error('[QUOTE-LEAD] send failed:', e instanceof Error ? e.message : String(e));
  }

  void persistLead();
  return json({ ok: true, emailed, subscribed });
};

interface ShopRow {
  id: string;
  slug: string;
  name: string;
  email: string;
  newsletter_provider: string;
  brevo_list_id: number | null;
  mailchimp_api_key: string | null;
  mailchimp_list_id: string | null;
  convertkit_api_key: string | null;
  convertkit_form_id: string | null;
}
