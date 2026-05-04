-- ============================================================
-- Phase B core schema — profiles + scan_events + user_state
-- ============================================================
-- These tables were created out-of-band via the Supabase SQL editor
-- before migrations were tracked in this repo. This file captures
-- the live-DB state on 2026-05-04 so the schema is reproducible
-- from a fresh project.
--
-- Idempotent: every statement uses IF NOT EXISTS / DROP IF EXISTS so
-- re-running on the live DB is a safe no-op.
--
-- Read by server.js: profiles (plan/admin/quota), scan_events
-- (monthly count for enforceQuota), user_state (PUT /api/state blob).
--
-- sessions + session_cards are also created here for completeness —
-- they exist in the live DB but are NOT read or written by the V1
-- server.js. They're part of an earlier abandoned attempt to move
-- the localStorage session log into Postgres. V2 may or may not
-- adopt them.

-- ── profiles ──────────────────────────────────────────────────
-- One row per auth.users entry. Plan + Stripe linkage + admin flag.
-- shop_name / scan_count_month / scan_count_reset_at are present in
-- the live DB but unused by current server.js — kept for
-- compatibility, can be deprecated by V2.
create table if not exists public.profiles (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  shop_name              text,
  plan                   text default 'free'
                            check (plan = any (array['free','beta','solo','vendor','shop'])),
  scan_count_month       integer default 0,
  scan_count_reset_at    timestamptz default (date_trunc('month', now()) + interval '1 month'),
  created_at             timestamptz default now(),
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan_interval          text,
  is_admin               boolean not null default false
);

alter table public.profiles enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = user_id);

-- ── scan_events ───────────────────────────────────────────────
-- Append-only. Counted by month-bucketed COUNT(*) in enforceQuota.
-- No update/delete path — rows accumulate forever. Cleanup is a
-- manual operations task, not enforced here.
create table if not exists public.scan_events (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  ts       timestamptz default now()
);

create index if not exists scan_events_user_ts_idx
  on public.scan_events (user_id, ts desc);

alter table public.scan_events enable row level security;

drop policy if exists "own events" on public.scan_events;
create policy "own events" on public.scan_events
  for all using (auth.uid() = user_id);

-- ── user_state ────────────────────────────────────────────────
-- Single JSONB blob per user containing { sessions, currentSessionId,
-- wantlist, v }. Last-writer-wins; the client debounces PUTs to 1.5s.
-- 10MB cap is enforced server-side via express.json({ limit: '10mb' }).
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.user_state enable row level security;

drop policy if exists "own state" on public.user_state;
create policy "own state" on public.user_state
  for all using (auth.uid() = user_id);

-- ── sessions / session_cards (legacy, unused by V1) ───────────
-- Two-table relational version of the per-user session log. Created
-- with intent to migrate from the JSONB blob above; never wired up.
-- Kept here so a fresh DB matches production exactly.
create table if not exists public.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz default now()
);

alter table public.sessions enable row level security;

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
  for all using (auth.uid() = user_id);

create table if not exists public.session_cards (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  card_data  jsonb not null,
  created_at timestamptz default now()
);

alter table public.session_cards enable row level security;

drop policy if exists "own cards" on public.session_cards;
create policy "own cards" on public.session_cards
  for all using (auth.uid() = user_id);
