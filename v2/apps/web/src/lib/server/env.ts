// Typed env loader. Zod parses lazily on first access — at build time the
// SvelteKit prerender step imports server modules without env set, which would
// otherwise crash. The endpoints that actually need env values resolve them
// at request time.

import { z } from 'zod';

const envSchema = z.object({
  // Supabase (server)
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),

  // Pricing data partners
  POKEMON_TCG_API_KEY: z.string().optional(),
  JUSTTCG_API_KEY: z.string().optional(),
  RAPIDAPI_KEY: z.string().optional(),
  EBAY_APP_ID: z.string().optional(),
  EBAY_CERT_ID: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Brevo
  BREVO_API_KEY: z.string().optional(),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_NEWSLETTER_LIST_ID: z.string().optional(),

  // Single-tenant fallback (matches v1)
  SHOP_EMAIL: z.string().email().default('dave@boardandbrewed.ie'),
  SHOP_NAME: z.string().default('Board & Brewed'),

  // IP hashing
  IP_HASH_SALT: z.string().min(8).default('card-pricer-default-salt'),

  // Database connection (for Drizzle direct-Postgres queries)
  DATABASE_URL: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

let _cached: Env | null = null;

/**
 * Lazy-validated environment. First call parses + caches.
 * Throws if required vars are missing — callers should only invoke
 * inside request handlers, not at module top level.
 */
function getEnv(): Env {
  if (_cached) return _cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[ENV] Invalid environment:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed; see fields above');
  }
  _cached = parsed.data;
  return _cached;
}

/**
 * Proxy-backed env object — looks like a regular const but every property
 * access lazy-validates. Module top-level imports stay safe at build time.
 */
export const env: Env = new Proxy({} as Env, {
  get: (_target, prop: string) => {
    const e = getEnv();
    return (e as unknown as Record<string, unknown>)[prop];
  },
});

/** Resolved single-tenant defaults — used when no shop_slug is supplied. */
export function getSingleTenantDefaults() {
  const e = getEnv();
  return {
    shopEmail: e.SHOP_EMAIL,
    shopName: e.SHOP_NAME,
    senderEmail: e.BREVO_SENDER_EMAIL ?? e.SHOP_EMAIL,
  } as const;
}
