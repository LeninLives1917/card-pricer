-- show_submissions: card lists customers send from the trade-show QR page
-- (/show/:slug). The customer never sees a price; staff see the priced list on
-- /show/:slug/staff and make the offer at the counter.
--
-- Server-only: RLS on with no policies, so only the service role (the Render
-- server) reads or writes. Idempotent.

create table if not exists public.show_submissions (
  id            uuid primary key default gen_random_uuid(),
  ticket        bigint generated always as identity,
  token         text not null unique,
  shop_id       uuid references public.shops(id) on delete cascade,
  shop_slug     text not null,
  name          text not null,
  email         text,
  newsletter    boolean not null default false,
  lines         jsonb not null,
  rows          jsonb,
  prices_as_of  text,
  priced_at     timestamptz,
  price_error   text,
  picks         jsonb not null default '{}'::jsonb,
  conditions    jsonb not null default '{}'::jsonb,
  status        text not null default 'waiting' check (status in ('waiting', 'done')),
  outcome       text check (outcome in ('bought', 'declined', 'other')),
  ip_hash       text,
  created_at    timestamptz not null default now(),
  done_at       timestamptz
);

create index if not exists show_submissions_shop_status_created_idx
  on public.show_submissions (shop_id, status, created_at desc);

alter table public.show_submissions enable row level security;
