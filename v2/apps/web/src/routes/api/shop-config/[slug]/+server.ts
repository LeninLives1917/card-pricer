// GET /api/shop-config/:slug — public endpoint serving the display fields
// of a shop. NEVER returns email or brevo_list_id; those are kept server-side.
// Cached in memory for 5 min so the embed widget modal-open doesn't hit DB.

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getSupabase } from '$lib/server/supabase.js';
import { getCached, setCached, type ShopConfig } from '$lib/server/shop-config-cache.js';
import type { RequestHandler } from './$types';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const ShopConfigSchema = z.object({
  slug: z.string(),
  name: z.string(),
  logo_url: z.string().nullable(),
  accent_color: z.string().nullable(),
  cash_pct: z.number().nullable(),
  credit_pct: z.number().nullable(),
  active: z.boolean(),
  newsletter_show: z.boolean().nullable().default(true),
}) satisfies z.ZodType<ShopConfig>;

export const GET: RequestHandler = async ({ params, setHeaders }) => {
  const slug = String(params.slug ?? '').toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 40) {
    throw error(400, 'invalid slug');
  }

  const cached = getCached(slug);
  if (cached) {
    setHeaders({ 'Cache-Control': 'public, max-age=60' });
    return json(cached);
  }

  const sb = getSupabase();
  const { data, error: dbErr } = await sb
    .from('shops')
    .select('slug,name,logo_url,accent_color,cash_pct,credit_pct,active,newsletter_show')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle();

  if (dbErr) {
    console.error('[SHOP-CONFIG]', dbErr.message);
    throw error(500, 'lookup failed');
  }
  if (!data) throw error(404, 'shop not found');

  const parsed = ShopConfigSchema.safeParse(data);
  if (!parsed.success) {
    console.error('[SHOP-CONFIG] schema mismatch:', parsed.error.flatten().fieldErrors);
    throw error(500, 'shop row failed validation');
  }
  setCached(slug, parsed.data);
  setHeaders({ 'Cache-Control': 'public, max-age=60' });
  return json(parsed.data);
};
