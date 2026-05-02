// Server-side load for /quote. Reads ?shop=<slug> + ?embed=1 from the URL,
// fetches shop branding from /api/shop-config (in-process, no extra round-trip
// — we hit the Supabase service-role client directly), and hands the result
// to the page component.

import { getSupabase } from '$lib/server/supabase.js';
import type { PageServerLoad } from './$types';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export interface ShopBranding {
  slug: string;
  name: string;
  logo_url: string | null;
  accent_color: string | null;
  cash_pct: number | null;
  credit_pct: number | null;
  newsletter_show: boolean | null;
}

export const load: PageServerLoad = async ({ url }) => {
  const slug = (url.searchParams.get('shop') ?? '').toLowerCase();
  const embed = url.searchParams.get('embed') === '1';

  let shop: ShopBranding | null = null;
  if (slug && SLUG_RE.test(slug) && slug.length <= 40) {
    const sb = getSupabase();
    const { data } = await sb
      .from('shops')
      .select('slug,name,logo_url,accent_color,cash_pct,credit_pct,newsletter_show')
      .eq('slug', slug)
      .eq('active', true)
      .maybeSingle();
    if (data) shop = data as ShopBranding;
  }

  return {
    embed,
    shopSlug: slug || null,
    shop,
  };
};
