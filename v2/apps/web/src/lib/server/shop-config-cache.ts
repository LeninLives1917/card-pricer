// Tiny in-memory cache for /api/shop-config/:slug responses. 5-min TTL.
// Lives outside +server.ts files because SvelteKit forbids custom exports
// from those — the cache helper is consumed by /api/shop write endpoints
// (week 3) to invalidate after a slug change.

export interface ShopConfig {
  slug: string;
  name: string;
  logo_url: string | null;
  accent_color: string | null;
  cash_pct: number | null;
  credit_pct: number | null;
  active: boolean;
  newsletter_show: boolean | null;
}

type CacheEntry = { value: ShopConfig; expires: number };

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

export function getCached(slug: string): ShopConfig | null {
  const entry = cache.get(slug);
  if (entry && entry.expires > Date.now()) return entry.value;
  return null;
}

export function setCached(slug: string, value: ShopConfig) {
  cache.set(slug, { value, expires: Date.now() + TTL_MS });
}

export function invalidate(slug: string) {
  cache.delete(slug);
}
