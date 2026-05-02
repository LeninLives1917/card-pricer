// Drizzle schema — port of the existing Supabase tables. Additive only:
// v1 still reads/writes these tables during cutover, so we cannot rename
// or drop columns until v1 is decommissioned. Schema is the source of
// truth for migrations going forward.
//
// Tables ported in week 1:
//   profiles, shops, quote_leads, scan_events, card_prices.
// New v2 tables land in their respective weeks:
//   inventory_items, inventory_events, listings (week 5)
//   sessions, session_scans (week 6)
//   customer_accounts, quote_offers (week 7)

import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/* ---- profiles ----
   Mirrors v1's profiles table. Plan + admin flag + Stripe link. */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey(),
  plan: text('plan').notNull().default('free'),
  isAdmin: boolean('is_admin').notNull().default(false),
  planInterval: text('plan_interval'),
  hasSubscription: boolean('has_subscription').notNull().default(false),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ---- shops ----
   Multi-tenant embed widget. Existing migration:
   supabase/migrations/20260426_shops.sql + 20260427_shops_newsletter.sql */
export const shops = pgTable(
  'shops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id').notNull(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    logoUrl: text('logo_url'),
    accentColor: text('accent_color').default('#d97706'),
    cashPct: smallint('cash_pct').default(55),
    creditPct: smallint('credit_pct').default(70),
    brevoListId: integer('brevo_list_id'),
    active: boolean('active').notNull().default(true),
    newsletterProvider: text('newsletter_provider').notNull().default('brevo'),
    newsletterShow: boolean('newsletter_show').notNull().default(true),
    mailchimpApiKey: text('mailchimp_api_key'),
    mailchimpListId: text('mailchimp_list_id'),
    convertkitApiKey: text('convertkit_api_key'),
    convertkitFormId: text('convertkit_form_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ ownerUnique: unique().on(t.ownerUserId) }),
);

/* ---- quote_leads ----
   Lead-capture rows from the customer quote tool. Shop-aware via shop_id. */
export const quoteLeads = pgTable('quote_leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id'),
  shopSlug: text('shop_slug'),
  email: text('email').notNull(),
  name: text('name'),
  newsletter: boolean('newsletter').default(false),
  cardCount: integer('card_count'),
  totalMarket: numeric('total_market', { precision: 10, scale: 2 }),
  totalCash: numeric('total_cash', { precision: 10, scale: 2 }),
  totalCredit: numeric('total_credit', { precision: 10, scale: 2 }),
  cardsJson: jsonb('cards_json'),
  ipHash: text('ip_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/* ---- scan_events ----
   Quota tracking — one row per identify call. */
export const scanEvents = pgTable('scan_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  endpoint: text('endpoint').notNull(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow(),
});

/* ---- card_prices ----
   v1 stored these as a JSON file (data/card-prices.json) loaded into a Map.
   v2 puts them in Postgres so the arbitrage scan can WHERE-filter in SQL.
   Loaded by the bulk-refresh job (week 4). PRIMARY KEY (set_id, number, variant).
*/
export const cardPrices = pgTable(
  'card_prices',
  {
    setId: text('set_id').notNull(),
    number: text('number').notNull(),
    name: text('name').notNull(),
    setName: text('set_name'),
    setCode: text('set_code'),
    rarity: text('rarity'),
    image: text('image'),
    cardmarketUrl: text('cardmarket_url'),
    tcgplayerUrl: text('tcgplayer_url'),
    /** TCGplayer prices blob (JSON of variant → {low,mid,high,market}). */
    tcg: jsonb('tcg'),
    /** Cardmarket prices blob (JSON of pricing fields). */
    cm: jsonb('cm'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ pk: unique().on(t.setId, t.number) }),
);
