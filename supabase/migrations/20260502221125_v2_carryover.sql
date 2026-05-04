-- ============================================================
-- V2-attempt carryover schema (NOT used by V1 server.js)
-- ============================================================
-- These tables exist in the live Supabase project as a leftover
-- from a previous V2 attempt that was rolled back in code on
-- 2026-05-04 (commit a7d4f21 "Rollback to v60"). The Postgres
-- schema was NOT rolled back, so a fresh checkout's server.js
-- never touches these tables but they are present in the DB.
--
-- This file captures the live state so a fresh project boot can
-- reproduce production exactly. Every statement is idempotent.
--
-- V2 sub-agents: these tables are an inheritance, not a feature.
-- A3 (Persistence) decides whether to:
--   (a) adopt and extend them,
--   (b) refactor into a new schema and drop these in a follow-up,
--   (c) leave them sleeping.
-- Whatever the decision, document it in docs/V2_ARCHITECTURE.md
-- before phase 3 begins.
--
-- Bundle of the five Supabase-tracked migrations:
--   v2_0001_card_prices       (20260502221125)
--   v2_0001b_card_prices_rls  (20260502221305)
--   v2_0002_inventory         (20260502221154)
--   v2_0003_live_sessions     (20260502221210)
--   v2_0004_customer_accounts (20260502221227)
-- Bundled into one file so the V1 repo treats this as a single
-- "v2 carryover" snapshot rather than scattering across history.

-- ── card_prices — Postgres mirror of data/card-prices.json ────
create table if not exists public.card_prices (
  set_id          text not null,
  number          text not null,
  name            text not null,
  set_name        text,
  set_code        text,
  rarity          text,
  image           text,
  cardmarket_url  text,
  tcgplayer_url   text,
  tcg             jsonb,
  cm              jsonb,
  fetched_at      timestamptz default now(),
  primary key (set_id, number)
);

create index if not exists card_prices_fetched_at_idx
  on public.card_prices (fetched_at desc);
create index if not exists card_prices_set_id_idx
  on public.card_prices (set_id);

alter table public.card_prices enable row level security;
-- Public-read price reference data — admin endpoint mediates writes.
-- No SELECT policy = no anonymous read. Service role can still write.
-- (Live DB has no policies for this table; reads go via server.)

-- ── inventory_items / inventory_events / listings ─────────────
-- Full inventory subsystem. Owner-scoped.
create table if not exists public.inventory_items (
  id                   uuid primary key default gen_random_uuid(),
  owner_user_id        uuid not null references auth.users(id) on delete cascade,
  shop_id              uuid references public.shops(id) on delete set null,
  card_meta            jsonb not null,
  source               text not null default 'scan'
                          check (source = any (array['scan','manual','import'])),
  cost_eur             numeric not null,
  condition_at_buy     text,
  market_value_at_buy  numeric,
  state                text not null default 'in_stock'
                          check (state = any (array['in_stock','listed','sold','consigned','returned'])),
  notes                text,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create index if not exists inventory_items_owner_state_idx
  on public.inventory_items (owner_user_id, state);

alter table public.inventory_items enable row level security;

drop policy if exists "owner reads own inventory"   on public.inventory_items;
drop policy if exists "owner mutates own inventory" on public.inventory_items;
create policy "owner reads own inventory" on public.inventory_items
  for select using (owner_user_id = auth.uid());
create policy "owner mutates own inventory" on public.inventory_items
  for all using (owner_user_id = auth.uid())
              with check (owner_user_id = auth.uid());

create table if not exists public.inventory_events (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.inventory_items(id) on delete cascade,
  event_type    text not null
                  check (event_type = any (array['bought','listed','price_change','sold','returned','consigned','note'])),
  data          jsonb,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at    timestamptz default now()
);

create index if not exists inventory_events_item_idx
  on public.inventory_events (item_id, created_at desc);

alter table public.inventory_events enable row level security;

drop policy if exists "owner reads own events" on public.inventory_events;
create policy "owner reads own events" on public.inventory_events
  for select using (
    exists (select 1 from public.inventory_items i
            where i.id = inventory_events.item_id
              and i.owner_user_id = auth.uid())
  );

create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.inventory_items(id) on delete cascade,
  marketplace  text not null
                  check (marketplace = any (array['cardmarket','tcgplayer','ebay','in_store'])),
  external_url text,
  ask_eur      numeric,
  listed_at    timestamptz default now(),
  sold_at      timestamptz,
  sold_eur     numeric,
  fees_eur     numeric
);

create index if not exists listings_item_idx
  on public.listings (item_id);

alter table public.listings enable row level security;

drop policy if exists "owner reads own listings"   on public.listings;
drop policy if exists "owner mutates own listings" on public.listings;
create policy "owner reads own listings" on public.listings
  for select using (
    exists (select 1 from public.inventory_items i
            where i.id = listings.item_id and i.owner_user_id = auth.uid())
  );
create policy "owner mutates own listings" on public.listings
  for all using (
    exists (select 1 from public.inventory_items i
            where i.id = listings.item_id and i.owner_user_id = auth.uid())
  );

-- ── live_sessions / live_session_scans ────────────────────────
-- Supabase-backed alternative to the in-memory phone-pair rooms.
-- Survives Render free-tier sleep + redeploys, supports idempotency.
create table if not exists public.live_sessions (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  shop_id       uuid references public.shops(id) on delete set null,
  name          text,
  pair_code     text not null unique,
  created_at    timestamptz default now(),
  closed_at     timestamptz
);

create index if not exists live_sessions_owner_idx
  on public.live_sessions (owner_user_id, created_at desc);

alter table public.live_sessions enable row level security;

drop policy if exists "owner reads own live_sessions"   on public.live_sessions;
drop policy if exists "owner mutates own live_sessions" on public.live_sessions;
create policy "owner reads own live_sessions" on public.live_sessions
  for select using (owner_user_id = auth.uid());
create policy "owner mutates own live_sessions" on public.live_sessions
  for all using (owner_user_id = auth.uid())
              with check (owner_user_id = auth.uid());

create table if not exists public.live_session_scans (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null references public.live_sessions(id) on delete cascade,
  scanned_by_user_id  uuid references auth.users(id) on delete set null,
  card_meta           jsonb not null,
  pricing_snapshot    jsonb,
  idempotency_key     text not null,
  created_at          timestamptz default now(),
  unique (session_id, idempotency_key)
);

create index if not exists live_session_scans_session_idx
  on public.live_session_scans (session_id, created_at desc);

alter table public.live_session_scans enable row level security;

drop policy if exists "members read live_session_scans" on public.live_session_scans;
drop policy if exists "members add live_session_scans"  on public.live_session_scans;
create policy "members read live_session_scans" on public.live_session_scans
  for select using (
    exists (select 1 from public.live_sessions s
            where s.id = live_session_scans.session_id
              and s.owner_user_id = auth.uid())
  );
create policy "members add live_session_scans" on public.live_session_scans
  for insert with check (
    exists (select 1 from public.live_sessions s
            where s.id = live_session_scans.session_id
              and s.owner_user_id = auth.uid())
  );

-- ── customer_accounts / quote_offers ──────────────────────────
-- Customer-side accounts and tokenised quote acceptance.
create table if not exists public.customer_accounts (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  display_name         text,
  opted_in_marketing   boolean not null default false,
  preferred_shop_slug  text references public.shops(slug) on delete set null,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

alter table public.customer_accounts enable row level security;

drop policy if exists "self reads own account"   on public.customer_accounts;
drop policy if exists "self mutates own account" on public.customer_accounts;
create policy "self reads own account" on public.customer_accounts
  for select using (user_id = auth.uid());
create policy "self mutates own account" on public.customer_accounts
  for all using (user_id = auth.uid())
              with check (user_id = auth.uid());

create table if not exists public.quote_offers (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid references public.quote_leads(id) on delete set null,
  shop_id           uuid references public.shops(id) on delete set null,
  customer_email    text not null,
  customer_user_id  uuid references auth.users(id) on delete set null,
  accept_token      text not null unique,
  line_items        jsonb not null,
  total_eur         numeric not null,
  currency          text not null default 'EUR',
  status            text not null default 'open'
                       check (status = any (array['open','accepted','declined','expired'])),
  expires_at        timestamptz,
  created_at        timestamptz default now(),
  accepted_at       timestamptz,
  declined_at       timestamptz
);

create index if not exists quote_offers_email_idx on public.quote_offers (customer_email);
create index if not exists quote_offers_token_idx on public.quote_offers (accept_token);
create index if not exists quote_offers_user_idx  on public.quote_offers (customer_user_id, created_at desc);

alter table public.quote_offers enable row level security;

drop policy if exists "shop reads own offers"     on public.quote_offers;
drop policy if exists "customer reads own offers" on public.quote_offers;
create policy "shop reads own offers" on public.quote_offers
  for select using (
    exists (select 1 from public.shops s
            where s.id = quote_offers.shop_id
              and s.owner_user_id = auth.uid())
  );
create policy "customer reads own offers" on public.quote_offers
  for select using (customer_user_id = auth.uid());
-- Public accept/decline goes via service-role + accept_token check.
