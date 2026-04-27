-- ============================================================
-- shops + quote_leads — multi-tenant embed widget
-- ============================================================
-- Apply via Supabase SQL editor (no migrations runner in repo).
-- Idempotent where possible so re-runs during setup don't blow up.

-- ── shops ──────────────────────────────────────────────────
-- One row per card shop. v1: one shop per user (unique on
-- owner_user_id). slug is the public identifier in the widget
-- script tag (data-shop="<slug>"). email is where leads route.
create table if not exists public.shops (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  slug          text not null unique
                  check (char_length(slug) between 3 and 40
                         and slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  name          text not null,
  email         text not null,
  logo_url      text,
  accent_color  text default '#b45309'
                  check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  cash_pct      smallint default 55 check (cash_pct between 1 and 100),
  credit_pct    smallint default 70 check (credit_pct between 1 and 100),
  brevo_list_id integer,
  active        boolean not null default true,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (owner_user_id)
);

create index if not exists shops_active_slug_idx
  on public.shops (slug) where active = true;

alter table public.shops enable row level security;

drop policy if exists "owner reads own shop"   on public.shops;
drop policy if exists "owner updates own shop" on public.shops;
drop policy if exists "owner creates own shop" on public.shops;

create policy "owner reads own shop" on public.shops
  for select using (owner_user_id = auth.uid());
create policy "owner updates own shop" on public.shops
  for update using (owner_user_id = auth.uid())
              with check (owner_user_id = auth.uid());
create policy "owner creates own shop" on public.shops
  for insert with check (owner_user_id = auth.uid());

-- Public read goes through service-role /api/shop-config/:slug
-- (sanitised — no email or brevo_list_id). NO public select policy.

create or replace function public.touch_shops_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists shops_touch on public.shops;
create trigger shops_touch
  before update on public.shops
  for each row execute function public.touch_shops_updated_at();

-- ── quote_leads ───────────────────────────────────────────
-- One row per submitted quote. shop_id is nullable to support
-- single-tenant fallback (existing /quote without shop_slug).
-- shop_slug denormalised so leads survive shop deletion.
create table if not exists public.quote_leads (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid references public.shops(id) on delete set null,
  shop_slug    text,
  email        text not null,
  name         text,
  newsletter   boolean default false,
  card_count   integer,
  total_market numeric(10,2),
  total_cash   numeric(10,2),
  total_credit numeric(10,2),
  cards_json   jsonb,
  ip_hash      text,
  created_at   timestamptz default now()
);

create index if not exists quote_leads_shop_id_created_idx
  on public.quote_leads (shop_id, created_at desc);

alter table public.quote_leads enable row level security;

drop policy if exists "owner reads own leads" on public.quote_leads;
create policy "owner reads own leads" on public.quote_leads
  for select using (
    exists (
      select 1 from public.shops s
      where s.id = quote_leads.shop_id
        and s.owner_user_id = auth.uid()
    )
  );
-- No insert/update/delete policies — service-role writes only.
