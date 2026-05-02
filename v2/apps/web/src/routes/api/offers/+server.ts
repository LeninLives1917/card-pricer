// POST /api/offers — vendor creates a quote_offer + emails the customer.
// GET  /api/offers — vendor lists their recent offers.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { brevoSendEmail, offerEmailHtml } from '@card-pricer/shared';
import { env } from '$lib/server/env.js';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

const NewOffer = z.object({
  customer_email: z.string().email(),
  customer_name: z.string().optional().nullable(),
  line_items: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().nonnegative(),
      }),
    )
    .min(1),
  shop_id: z.string().uuid().optional().nullable(),
  /** Days until the offer expires. Default 7. */
  expires_in_days: z.number().int().min(1).max(60).optional(),
});

function genToken(): string {
  // 32 hex chars from crypto.getRandomValues — collision-safe for accept_token.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'auth required');
  const sb = getSupabase();
  const { data: shops } = await sb
    .from('shops')
    .select('id')
    .eq('owner_user_id', locals.user.id)
    .limit(1);
  const shopId = shops?.[0]?.id ?? null;
  let q = sb
    .from('quote_offers')
    .select('id, customer_email, total_eur, status, created_at, accept_token, line_items')
    .order('created_at', { ascending: false })
    .limit(50);
  if (shopId) q = q.eq('shop_id', shopId);
  const { data, error: dbErr } = await q;
  if (dbErr) throw error(500, dbErr.message);
  return json({ offers: data ?? [] });
};

export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (!locals.user) throw error(401, 'auth required');
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw error(400, 'invalid JSON');
  }
  const parsed = NewOffer.safeParse(raw);
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join('; '));

  const total = parsed.data.line_items.reduce((s, li) => s + li.price, 0);
  const accept_token = genToken();
  const expires_at = parsed.data.expires_in_days
    ? new Date(Date.now() + parsed.data.expires_in_days * 86400_000).toISOString()
    : new Date(Date.now() + 7 * 86400_000).toISOString();

  const sb = getSupabase();
  const { data: shops } = await sb
    .from('shops')
    .select('id, name')
    .eq('owner_user_id', locals.user.id)
    .limit(1);
  const shop = shops?.[0] ?? null;
  const shopId = parsed.data.shop_id ?? shop?.id ?? null;
  const shopName = shop?.name ?? env.SHOP_NAME ?? 'Card Pricer';

  const { data: inserted, error: dbErr } = await sb
    .from('quote_offers')
    .insert({
      shop_id: shopId,
      customer_email: parsed.data.customer_email,
      accept_token,
      line_items: parsed.data.line_items,
      total_eur: total,
      currency: 'EUR',
      status: 'open',
      expires_at,
    })
    .select()
    .maybeSingle();
  if (dbErr || !inserted) throw error(500, dbErr?.message ?? 'insert failed');

  const acceptUrl = `${url.origin}/account/offer/${accept_token}`;

  // Best-effort email — don't fail the offer if email service hiccups.
  let emailSent = false;
  let emailErr: string | null = null;
  try {
    const senderEmail = env.BREVO_SENDER_EMAIL ?? env.SHOP_EMAIL;
    if (env.BREVO_API_KEY && senderEmail) {
      await brevoSendEmail(
        {
          apiKey: env.BREVO_API_KEY,
          senderEmail,
          senderName: shopName,
        },
        {
          to: parsed.data.customer_email,
          subject: `Offer from ${shopName}`,
          htmlContent: offerEmailHtml({
            shopName,
            customerName: parsed.data.customer_name ?? null,
            lineItems: parsed.data.line_items,
            totalEur: total,
            acceptUrl,
            expiresAt: expires_at.slice(0, 10),
          }),
        },
      );
      emailSent = true;
    }
  } catch (e) {
    emailErr = e instanceof Error ? e.message : String(e);
  }

  return json({
    ok: true,
    offer: inserted,
    accept_url: acceptUrl,
    email_sent: emailSent,
    email_error: emailErr,
  });
};
