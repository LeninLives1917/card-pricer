-- 20260810120000_card_price_snapshots.sql
--
-- card_price_snapshots — append-only price history.
--
-- WHY THIS EXISTS
--
-- `card_prices` is keyed (set_id, number) and every refresh UPSERTs over it.
-- The app has been pulling Cardmarket prices for ~19k cards since May 2026 and
-- discarding the previous value each time. When we went looking for price
-- history in August 2026 the only surviving points were a stale
-- data/card-prices.json on someone's disk (2026-05-04) and two accidental
-- Wayback Machine captures of Cardmarket's own price guide. Everything the app
-- itself had collected was gone.
--
-- Same shape as every other incident in this repo: the expensive work ran, the
-- result was silently overwritten, and nothing counted what we were losing.
--
-- This table is the cheap half of the fix. One row per card per capture day.
-- `card_prices` keeps its exact current meaning ("latest known price") and is
-- untouched — nothing reading it changes behaviour.

create table if not exists public.card_price_snapshots (
  set_id        text not null,
  number        text not null,
  captured_on   date not null default (now() at time zone 'utc')::date,
  tcg           jsonb,
  cm            jsonb,
  captured_at   timestamptz not null default now(),
  -- One row per card per day. A second refresh on the same day overwrites that
  -- day's row rather than doubling it, so a restart loop cannot inflate the
  -- series. Daily granularity is deliberate: the underlying source
  -- (pokemontcg.io / Cardmarket) updates about once a day, so anything finer
  -- would store noise and re-fetch artifacts as if they were price movement.
  primary key (set_id, number, captured_on)
);

-- Week-over-week and month-over-month queries scan by date first.
create index if not exists card_price_snapshots_captured_on_idx
  on public.card_price_snapshots (captured_on desc);
-- Per-card series lookup ("show me this card over time").
create index if not exists card_price_snapshots_card_idx
  on public.card_price_snapshots (set_id, number, captured_on desc);

alter table public.card_price_snapshots enable row level security;
-- Matches card_prices exactly: RLS on, zero policies. Service-role writes
-- bypass RLS; anonymous reads are blocked. Reads go through the server.
