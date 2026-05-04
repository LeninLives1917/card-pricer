# Database schema

Owner: A3 (Persistence). Slice: S1.

Source of truth: `supabase/migrations/`. This file is a **human-readable
companion** that maps every public table in the live Supabase project
(`vecbaewlxodqnevduoiy`) on `2026-05-04` to:

- the column list (name + type + constraints, brief)
- which V2 module(s) read/write it (paths from `docs/V2_ARCHITECTURE.md` §1)
- which V2 routes own its lifecycle
- the RLS policies attached
- the V2 plan: **ADOPT** (carryover, newly wired up), **UNCHANGED**
  (used by V1, behaviour preserved), or **EXTEND** (additive change in
  V2), citing the relevant feature ID from V2_ARCHITECTURE §5.

There are **15 tables** in the public schema. Order below mirrors the
migration files, then the carryover bundle.

| # | Table | V2 plan | Feature ID |
|---|---|---|---|
| 1  | `profiles`            | UNCHANGED                     | F14 |
| 2  | `scan_events`         | EXTEND (`data jsonb`)         | F24 (Q3) |
| 3  | `user_state`          | UNCHANGED → DEPRECATED post-V2| F17 (Q1) |
| 4  | `sessions`            | ADOPT                         | F17 (Q1) |
| 5  | `session_cards`       | ADOPT                         | F17 (Q1) |
| 6  | `shops`               | UNCHANGED                     | — |
| 7  | `quote_leads`         | UNCHANGED                     | — |
| 8  | `card_prices`         | ADOPT                         | F16 |
| 9  | `inventory_items`     | ADOPT                         | F18 (Q1) |
| 10 | `inventory_events`    | ADOPT                         | F18 (Q1) |
| 11 | `listings`            | ADOPT                         | F18 (Q1) |
| 12 | `live_sessions`       | ADOPT                         | F15 |
| 13 | `live_session_scans`  | ADOPT                         | F15 |
| 14 | `customer_accounts`   | ADOPT                         | F19 (Q1) |
| 15 | `quote_offers`        | ADOPT                         | F19 (Q1) |

`auth.users` is Supabase-managed and untouched per migrations README.

---

## 1. `profiles`

One row per `auth.users` entry. Plan + Stripe linkage + admin flag.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `user_id` | `uuid` | PK, FK → `auth.users(id)` ON DELETE CASCADE |
| `shop_name` | `text` | (legacy, unused by V1 server.js) |
| `plan` | `text` | default `'free'`, CHECK `in ('free','beta','solo','vendor','shop')` |
| `scan_count_month` | `integer` | default `0` (legacy, replaced by `scan_events` count) |
| `scan_count_reset_at` | `timestamptz` | default `date_trunc('month', now()) + interval '1 month'` (legacy) |
| `created_at` | `timestamptz` | default `now()` |
| `stripe_customer_id` | `text` | nullable |
| `stripe_subscription_id` | `text` | nullable |
| `plan_interval` | `text` | nullable (`'month'`/`'year'`) |
| `is_admin` | `boolean` | NOT NULL, default `false` |

**V2 modules**
- `db/supabase.js` (`getOrCreateProfile`)
- `apps/server/middleware/auth.js` (`requireAuth`, `requireAdmin`, `requirePlan`)
- `apps/server/middleware/quota.js` (reads `plan` for caps)
- `apps/server/routes/account.js` (`/api/me`, `/api/usage`)
- `apps/server/routes/billing.js` (`/api/stripe-webhook` writes plan)
- `apps/server/routes/admin.js` (admin overview reads aggregate plan)

**V2 routes that own lifecycle**
- INSERT: `getOrCreateProfile` on first sign-in
- UPDATE: `/api/stripe-webhook` (subscription state → plan/`stripe_*`)
- ADMIN-FLAG TOGGLE: out-of-band SQL (no API endpoint)

**RLS** — `enable row level security`
- `"own profile" for all using (auth.uid() = user_id)`

**V2 plan: UNCHANGED.** F14 (vendor auth) preserved. The legacy
`shop_name`, `scan_count_month`, `scan_count_reset_at` columns can be
dropped in a follow-up post-V2 migration but are NOT touched in V2.

---

## 2. `scan_events`

Append-only. Counted by month-bucketed `count(*)` in `enforceQuota` for
the per-user quota gate. Will also carry OCR-first telemetry in V2.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE |
| `endpoint` | `text` | NOT NULL (`'/api/identify'`, `'/api/identify-stream'`, `'/api/identify-manual'`, `'ocr-first'`, …) |
| `ts` | `timestamptz` | default `now()` |
| `data` | `jsonb` | nullable — **V2 NEW** (migration `20260504120000_scan_events_data.sql`) |

**Indexes**
- `scan_events_user_ts_idx (user_id, ts desc)` — quota window scans
- `scan_events_ocr_first_idx (ts desc) where endpoint = 'ocr-first'` — **V2 NEW** partial index for the FP-rate background job

**V2 modules**
- `apps/server/middleware/quota.js` (read: monthly count)
- `apps/server/routes/identify.js` (write: every successful identify)
- `pricing/ocr-first/telemetry.js` (write: `endpoint='ocr-first'` + `data: {ocr_set_code, validated, fell_through_reason, fp_signal?}`)
- `apps/server/routes/admin.js` (read: aggregate counts for overview + FP threshold check via `OCR_FIRST_FP_THRESHOLD`)

**V2 routes that own lifecycle**
- INSERT: every `/api/identify*` handler + `pricing/ocr-first/pipeline.js` on every attempt (validated or fell-through, per RG-39 quota honesty rule)
- No UPDATE/DELETE path. Cleanup is an ops task.

**RLS**
- `"own events" for all using (auth.uid() = user_id)`

**V2 plan: EXTEND — F24 (Q3).** Additive `data jsonb` column for
OCR-first telemetry, partial index for the 24h FP-rate aggregator.
Migration: `20260504120000_scan_events_data.sql` (rollback sibling).
V1 inserts that omit `data` keep working — column is nullable.

---

## 3. `user_state`

Single JSONB blob per user containing
`{ sessions, currentSessionId, wantlist, v }`. Last-writer-wins; client
debounces PUTs to 1.5 s. 10 MB cap enforced via `express.json({ limit: '10mb' })`.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `user_id` | `uuid` | PK, FK → `auth.users(id)` ON DELETE CASCADE |
| `state` | `jsonb` | NOT NULL, default `'{}'::jsonb` |
| `updated_at` | `timestamptz` | default `now()` |

**V2 modules**
- `db/sessions/dual-write.js` — writes BOTH `user_state` JSONB AND `sessions`/`session_cards` rows during the F17 dual-write window
- `db/sessions/reader.js` — reads JSONB blob when `READ_FROM_RELATIONAL=false` (default through phase 4); falls back to JSONB if relational read empty
- `apps/server/routes/account.js` — `GET /api/state`, `PUT /api/state`

**V2 routes that own lifecycle**
- READ: `GET /api/state` (V1-shape preserved verbatim)
- WRITE: `PUT /api/state` (V1-shape preserved; dual-writer fans out)

**RLS**
- `"own state" for all using (auth.uid() = user_id)`

**V2 plan: UNCHANGED in V2 — DEPRECATING (F17, Q1).** During V2 the
JSONB blob is the still-authoritative read path until the
`READ_FROM_RELATIONAL` flag is flipped to `true` near end of phase 4
(slice S24). The blob keeps being **written** for one further release
as a tripwire (see V2_ARCHITECTURE §4.1 step 4). The `state` column is
**dropped in a separate post-V2 migration**, not in V2.

---

## 4. `sessions`

Per-user named-session header. Created in the carryover migration but
unused by V1 — V2 wires it up via the F17 dual-write.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE |
| `name` | `text` | NOT NULL |
| `created_at` | `timestamptz` | default `now()` |

**Indexes**
- `sessions_user_created_idx (user_id, created_at desc)` — **V2 NEW** (migration `20260504120100_sessions_indexes.sql`) for dashboard list reads.

**V2 modules**
- `db/sessions/dual-write.js`
- `db/sessions/reader.js`
- `db/sessions/cutover-flag.js`
- `apps/server/routes/account.js` (`GET /api/v2/sessions`)

**V2 routes that own lifecycle**
- INSERT: `PUT /api/state` (dual-writer creates session header on first appearance of a `state.sessions[*].id` it hasn't seen)
- UPDATE: rename via `PUT /api/state` rebroadcast
- READ: `GET /api/v2/sessions` (NEW), and the relational reader behind `PUT /api/state`'s response shape after S24

**RLS**
- `"own sessions" for all using (auth.uid() = user_id)`

**V2 plan: ADOPT — F17 (Q1).** Primary store for the multi-named
session log after S24 read-flip. No schema change beyond the new index.

---

## 5. `session_cards`

Per-card scan rows under a parent `sessions` header.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `session_id` | `uuid` | NOT NULL, FK → `sessions(id)` ON DELETE CASCADE |
| `user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE — denormalised for RLS without a join |
| `card_data` | `jsonb` | NOT NULL — full result-row shape (name, set, condition, prices, status, notes, photo, …) |
| `created_at` | `timestamptz` | default `now()` |

**Indexes**
- `session_cards_session_created_idx (session_id, created_at)` — **V2 NEW** for paginated card load
- `session_cards_user_idx (user_id)` — **V2 NEW** for dual-write parity check across whole user history

**V2 modules**
- `db/sessions/dual-write.js`
- `db/sessions/reader.js`

**V2 routes that own lifecycle**
- INSERT: `PUT /api/state` (per new card in any session)
- UPDATE: `PUT /api/state` (LWW upsert — re-stage `card_data` for any row that changed since last sync)
- READ: relational read path inside `GET /api/state` after S24

**RLS**
- `"own cards" for all using (auth.uid() = user_id)`

**V2 plan: ADOPT — F17 (Q1).** No schema change beyond the two new indexes.

---

## 6. `shops`

One row per card shop. v1: one shop per user (DB-enforced unique on
`owner_user_id`). `slug` is the public identifier in the widget script
tag and `/quote?shop=…` URL.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `owner_user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE, **UNIQUE** |
| `slug` | `text` | NOT NULL, **UNIQUE**, CHECK `char_length 3..40 and ^[a-z0-9][a-z0-9-]*[a-z0-9]$` |
| `name` | `text` | NOT NULL |
| `email` | `text` | NOT NULL |
| `logo_url` | `text` | nullable |
| `accent_color` | `text` | default `'#b45309'`, CHECK `^#[0-9a-fA-F]{6}$` |
| `cash_pct` | `smallint` | default `55`, CHECK `between 1 and 100` |
| `credit_pct` | `smallint` | default `70`, CHECK `between 1 and 100` |
| `brevo_list_id` | `integer` | nullable |
| `active` | `boolean` | NOT NULL, default `true` |
| `newsletter_provider` | `text` | NOT NULL, default `'brevo'`, CHECK `in ('brevo','mailchimp','convertkit','off')` |
| `newsletter_show` | `boolean` | NOT NULL, default `true` |
| `mailchimp_api_key` | `text` | nullable |
| `mailchimp_list_id` | `text` | nullable |
| `convertkit_api_key` | `text` | nullable |
| `convertkit_form_id` | `text` | nullable |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` (trigger `shops_touch`) |

**Indexes**
- `shops_active_slug_idx (slug) where active = true` — fast public lookup

**Triggers**
- `shops_touch BEFORE UPDATE` → `touch_shops_updated_at()` keeps `updated_at` honest.

**V2 modules**
- `apps/server/routes/shop.js` (CRUD)
- Read by: `apps/server/routes/quote-offer.js` (F19), `apps/server/routes/inventory.js` (F18), `apps/server/routes/customer.js` (preferred shop)
- `apps/quote/modules/shop-config.js` (sanitised view via `/api/shop-config/:slug`)

**V2 routes that own lifecycle**
- INSERT: `POST /api/shop` (409 on dup slug or dup owner via `23505` unique-violation)
- UPDATE: `PATCH /api/shop` (also invalidates `shopConfigCache` for old + new slug)
- READ: `GET /api/shop`, `GET /api/shop-config/:slug`

**RLS**
- `"owner reads own shop" for select using (owner_user_id = auth.uid())`
- `"owner updates own shop" for update using/with check (owner_user_id = auth.uid())`
- `"owner creates own shop" for insert with check (owner_user_id = auth.uid())`
- No public SELECT — public reads route through service-role + sanitiser.

**V2 plan: UNCHANGED.** Preserved verbatim, including the unique-on-`owner_user_id`
constraint that V1 relies on for `409`. Carries audit §5.21 invariant.

---

## 7. `quote_leads`

One row per submitted customer quote. Append-only. `shop_id` nullable
to support single-tenant fallback. `shop_slug` denormalised so leads
survive shop deletion.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `shop_id` | `uuid` | FK → `shops(id)` ON DELETE SET NULL |
| `shop_slug` | `text` | nullable, denormalised |
| `email` | `text` | NOT NULL |
| `name` | `text` | nullable |
| `newsletter` | `boolean` | default `false` |
| `card_count` | `integer` | nullable |
| `total_market` | `numeric(10,2)` | nullable |
| `total_cash` | `numeric(10,2)` | nullable |
| `total_credit` | `numeric(10,2)` | nullable |
| `cards_json` | `jsonb` | nullable — full lines + photos (audit §6 honourable mention: large rows) |
| `ip_hash` | `text` | nullable, daily-salted SHA-256 |
| `created_at` | `timestamptz` | default `now()` |

**Indexes**
- `quote_leads_shop_id_created_idx (shop_id, created_at desc)`

**V2 modules**
- `apps/server/routes/quote-lead.js` (write)
- `apps/server/routes/admin.js` (read for analytics F8)
- `apps/server/routes/quote-offer.js` (F19 — `lead_id` FK reference)
- `apps/customer/modules/quote-history.js` (read joined via `quote_offers.lead_id`)

**V2 routes that own lifecycle**
- INSERT: `POST /api/quote-lead` — **persists FIRST, then attempts Brevo**, per audit §5.13. V2 must keep this ordering.
- No UPDATE/DELETE.

**RLS**
- `"owner reads own leads" for select using (exists … shops with owner = auth.uid())`
- No insert/update/delete policy — service-role writes only.

**V2 plan: UNCHANGED.**

---

## 8. `card_prices`

Postgres mirror of `data/card-prices.json`. Source for the admin
arbitrage tool and (V2) the warm-on-boot in-memory `CARD_PRICES` Map.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `set_id` | `text` | NOT NULL, **PK** part 1 |
| `number` | `text` | NOT NULL, **PK** part 2 |
| `name` | `text` | NOT NULL |
| `set_name` | `text` | nullable |
| `set_code` | `text` | nullable |
| `rarity` | `text` | nullable |
| `image` | `text` | nullable |
| `cardmarket_url` | `text` | nullable |
| `tcgplayer_url` | `text` | nullable |
| `tcg` | `jsonb` | nullable — TCGPlayer USD prices snapshot |
| `cm` | `jsonb` | nullable — Cardmarket EUR prices snapshot |
| `fetched_at` | `timestamptz` | default `now()` |

**Indexes**
- `card_prices_fetched_at_idx (fetched_at desc)`
- `card_prices_set_id_idx (set_id)`

**V2 modules**
- `db/price-snapshot/store.js` (Postgres ↔ in-memory `CARD_PRICES` Map; warm on boot)
- `apps/server/routes/admin.js` — `POST /api/admin/arbitrage`, `POST /api/admin/refresh-prices`, `GET /api/admin/refresh-status`

**V2 routes that own lifecycle**
- INSERT/UPDATE: `POST /api/admin/refresh-prices` (background job upserts batches)
- READ: `POST /api/admin/arbitrage`, boot-time hydration

**RLS**
- RLS enabled but **no policies attached** — service-role mediates all access.

**V2 plan: ADOPT — F16.** Postgres becomes primary; JSON file written
as backup for one release post-V2 then dropped. No schema change in V2.

---

## 9. `inventory_items`

Owner-scoped inventory item. One row per physical card the shop owns.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `owner_user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE |
| `shop_id` | `uuid` | FK → `shops(id)` ON DELETE SET NULL |
| `card_meta` | `jsonb` | NOT NULL — game/name/set/number/variant/rarity/image |
| `source` | `text` | NOT NULL, default `'scan'`, CHECK `in ('scan','manual','import')` |
| `cost_eur` | `numeric` | NOT NULL |
| `condition_at_buy` | `text` | nullable |
| `market_value_at_buy` | `numeric` | nullable |
| `state` | `text` | NOT NULL, default `'in_stock'`, CHECK `in ('in_stock','listed','sold','consigned','returned')` |
| `notes` | `text` | nullable |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

**Indexes**
- `inventory_items_owner_state_idx (owner_user_id, state)` — already covers the primary "show me my in-stock items" dashboard query

**V2 modules**
- `db/inventory/items.js` (A9 owns)
- `apps/server/routes/inventory.js` (A9 owns)
- `apps/vendor/modules/tabs/inventory.js` (A9 + A4)

**V2 routes that own lifecycle**
- INSERT: `POST /api/v2/inventory` (manual or from scan)
- UPDATE: `PATCH /api/v2/inventory/:id` (state, notes, etc.)
- READ: `GET /api/v2/inventory`

**RLS**
- `"owner reads own inventory" for select using (owner_user_id = auth.uid())`
- `"owner mutates own inventory" for all using/with check (owner_user_id = auth.uid())`

**V2 plan: ADOPT — F18 (Q1).** No schema change verified against
V2_ARCHITECTURE §5 F18 — current columns cover bought/listed/sold P&L
math (cost, market_value_at_buy, state) and audit trail goes via
`inventory_events` + `listings`. No new column needed in V2.

---

## 10. `inventory_events`

Append-only audit log for an `inventory_items` row.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `item_id` | `uuid` | NOT NULL, FK → `inventory_items(id)` ON DELETE CASCADE |
| `event_type` | `text` | NOT NULL, CHECK `in ('bought','listed','price_change','sold','returned','consigned','note')` |
| `data` | `jsonb` | nullable — event-specific payload (price delta, marketplace, fee detail, …) |
| `actor_user_id` | `uuid` | FK → `auth.users(id)` ON DELETE SET NULL |
| `created_at` | `timestamptz` | default `now()` |

**Indexes**
- `inventory_events_item_idx (item_id, created_at desc)`

**V2 modules**
- `db/inventory/events.js` (A9 owns)

**V2 routes that own lifecycle**
- INSERT: every state-changing inventory route (`POST /api/v2/inventory`, `POST /api/v2/inventory/:id/list`, `POST /api/v2/inventory/:id/sold`, …)
- READ: `GET /api/v2/inventory/:id/events`

**RLS**
- `"owner reads own events" for select using (exists … inventory_items i where i.id = item_id and i.owner_user_id = auth.uid())`
- No mutate policy — service-role writes only.

**V2 plan: ADOPT — F18 (Q1).** Schema sufficient.

---

## 11. `listings`

A marketplace listing for an inventory item. An item can have multiple
listings over time (relisted, cross-listed).

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `item_id` | `uuid` | NOT NULL, FK → `inventory_items(id)` ON DELETE CASCADE |
| `marketplace` | `text` | NOT NULL, CHECK `in ('cardmarket','tcgplayer','ebay','in_store')` |
| `external_url` | `text` | nullable |
| `ask_eur` | `numeric` | nullable |
| `listed_at` | `timestamptz` | default `now()` |
| `sold_at` | `timestamptz` | nullable |
| `sold_eur` | `numeric` | nullable |
| `fees_eur` | `numeric` | nullable |

**Indexes**
- `listings_item_idx (item_id)`

**V2 modules**
- `db/inventory/listings.js` (A9 owns)
- `pricing/marketplaces/{cardmarket,tcgplayer,ebay,in-store}.js` (A9 owns) — outbound list/update/mark-sold

**V2 routes that own lifecycle**
- INSERT: `POST /api/v2/inventory/:id/list`
- UPDATE: `PATCH /api/v2/listings/:id` (mark sold, update ask)
- READ: `GET /api/v2/inventory/:id/listings`

**RLS**
- `"owner reads own listings" for select using (exists … inventory_items i where i.id = item_id and i.owner_user_id = auth.uid())`
- `"owner mutates own listings" for all using (exists … same as above)`

**V2 plan: ADOPT — F18 (Q1).** Schema sufficient (tracks ask/sold/fees,
covers RG-48 P&L math).

---

## 12. `live_sessions`

Postgres-backed alternative to the in-memory `rooms` Map. Survives
Render restart and redeploys.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `owner_user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` ON DELETE CASCADE |
| `shop_id` | `uuid` | FK → `shops(id)` ON DELETE SET NULL |
| `name` | `text` | nullable |
| `pair_code` | `text` | NOT NULL, **UNIQUE** — base-36 6-char like V1 |
| `created_at` | `timestamptz` | default `now()` |
| `closed_at` | `timestamptz` | nullable |

**Indexes**
- `live_sessions_owner_idx (owner_user_id, created_at desc)`

**V2 modules**
- `db/live-sessions/store.js` (A1 + A3 own — A3 owns the table layer; A1 owns the route)
- `db/live-sessions/sse-bridge.js` — bridges Postgres-LISTEN/NOTIFY into the in-memory SSE clients

**V2 routes that own lifecycle**
- INSERT: `POST /api/room/:id` (creates a row keyed on `pair_code` if new)
- READ: `GET /api/room/:id/{stream,history}`

**RLS**
- `"owner reads own live_sessions" for select using (owner_user_id = auth.uid())`
- `"owner mutates own live_sessions" for all using/with check (owner_user_id = auth.uid())`

**V2 plan: ADOPT — F15.** Render Starter (Q2) removes the "survive
sleep" pressure but adoption is kept for redeploy resilience and
multi-laptop pairing per V2_ARCHITECTURE §5 F15. No schema change.

---

## 13. `live_session_scans`

Phone-pushed scans inside a live pairing session. Idempotent on
`(session_id, idempotency_key)` so retries don't double-count.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `session_id` | `uuid` | NOT NULL, FK → `live_sessions(id)` ON DELETE CASCADE |
| `scanned_by_user_id` | `uuid` | FK → `auth.users(id)` ON DELETE SET NULL — null when scanner-mode is unauthenticated |
| `card_meta` | `jsonb` | NOT NULL — identify result |
| `pricing_snapshot` | `jsonb` | nullable — `/api/price` response |
| `idempotency_key` | `text` | NOT NULL — usually image SHA1 |
| `created_at` | `timestamptz` | default `now()` |
| **UNIQUE** `(session_id, idempotency_key)` | | natural dedup boundary |

**Indexes**
- `live_session_scans_session_idx (session_id, created_at desc)`

**V2 modules**
- `db/live-sessions/store.js`
- `db/live-sessions/sse-bridge.js`

**V2 routes that own lifecycle**
- INSERT: `POST /api/room/:id/scan` (append; `ON CONFLICT DO NOTHING` on idempotency)
- READ: `GET /api/room/:id/{stream,history}`

**RLS**
- `"members read live_session_scans" for select using (exists … live_sessions s where s.id = session_id and s.owner_user_id = auth.uid())`
- `"members add live_session_scans" for insert with check (exists … same as above)`

**V2 plan: ADOPT — F15.** No schema change. The scanner-mode bypass
(audit §5.14) means writes go through service-role with explicit
session-membership check (`pair_code`-validated), since RLS would
reject an unauthenticated phone push.

---

## 14. `customer_accounts`

Customer-side accounts (separate flow from vendor — Supabase magic-link).

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `user_id` | `uuid` | PK, FK → `auth.users(id)` ON DELETE CASCADE |
| `display_name` | `text` | nullable |
| `opted_in_marketing` | `boolean` | NOT NULL, default `false` |
| `preferred_shop_slug` | `text` | FK → `shops(slug)` ON DELETE SET NULL |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

**V2 modules**
- `db/customers/accounts.js` (A10 owns)
- `apps/server/routes/customer.js` (A10 owns) — `/api/v2/customer/me` + CRUD
- `apps/customer/modules/auth.js` (magic-link sign-in)
- `apps/customer/modules/account.js` (edit display name, opt-in)

**V2 routes that own lifecycle**
- INSERT: first hit of `/api/v2/customer/me` after magic-link sign-in (auto-create profile)
- UPDATE: `PATCH /api/v2/customer/me`

**RLS**
- `"self reads own account" for select using (user_id = auth.uid())`
- `"self mutates own account" for all using/with check (user_id = auth.uid())`

**V2 plan: ADOPT — F19 (Q1).** No schema change.

---

## 15. `quote_offers`

Tokenised quote acceptance. Customer accepts/declines via single-click
URL containing `accept_token`.

**Columns**

| Name | Type | Constraint / default |
|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `lead_id` | `uuid` | FK → `quote_leads(id)` ON DELETE SET NULL |
| `shop_id` | `uuid` | FK → `shops(id)` ON DELETE SET NULL |
| `customer_email` | `text` | NOT NULL |
| `customer_user_id` | `uuid` | FK → `auth.users(id)` ON DELETE SET NULL — populated post-sign-in |
| `accept_token` | `text` | NOT NULL, **UNIQUE** |
| `line_items` | `jsonb` | NOT NULL |
| `total_eur` | `numeric` | NOT NULL |
| `currency` | `text` | NOT NULL, default `'EUR'` |
| `status` | `text` | NOT NULL, default `'open'`, CHECK `in ('open','accepted','declined','expired')` |
| `expires_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | default `now()` |
| `accepted_at` | `timestamptz` | nullable |
| `declined_at` | `timestamptz` | nullable |

**Indexes**
- `quote_offers_email_idx (customer_email)`
- `quote_offers_token_idx (accept_token)`
- `quote_offers_user_idx (customer_user_id, created_at desc)`

**V2 modules**
- `db/customers/offers.js` (A10 owns)
- `apps/server/routes/quote-offer.js` (A10 owns) — `POST /api/v2/quote-offer`, `…/:token/accept`, `…/:token/decline`
- `apps/customer/modules/offer-accept.js`

**V2 routes that own lifecycle**
- INSERT: `POST /api/v2/quote-offer` (shop creates from a lead)
- UPDATE: `POST /api/v2/quote-offer/:token/accept` → status=`'accepted'`, `accepted_at=now()`
- UPDATE: `POST /api/v2/quote-offer/:token/decline` → status=`'declined'`, `declined_at=now()`
- READ: customer dashboard via `customer_user_id`; shop owner via `shop_id`

**RLS**
- `"shop reads own offers" for select using (exists … shops s where s.id = shop_id and s.owner_user_id = auth.uid())`
- `"customer reads own offers" for select using (customer_user_id = auth.uid())`
- Public accept/decline goes via service-role + `accept_token` constant-time check (no public RLS policy).

**V2 plan: ADOPT — F19 (Q1).** No schema change. Test fixtures cover
unknown token (404), expired (410 Gone via `expires_at`), and valid
flip per RG-49.

---

## V2 migrations added in S1

Filenames timestamped after the carryover (`20260502221125`):

| File | Purpose | Rollback |
|---|---|---|
| `supabase/migrations/20260504120000_scan_events_data.sql` | `scan_events.data jsonb` + partial index for `endpoint='ocr-first'` | `…_rollback.sql` (drops index then column) |
| `supabase/migrations/20260504120100_sessions_indexes.sql` | three secondary indexes for F17 dual-write reader/writer | `…_rollback.sql` |

Both are additive and idempotent (`add column if not exists`,
`create index if not exists`). Verified against the existing live
schema in `20260421_phase_b_core.sql` and `20260502221125_v2_carryover.sql`
— no name collision, no constraint conflict.

---

## Migration application order

Per `supabase/migrations/README.md`:

1. `20260421_phase_b_core.sql` — profiles/scan_events/user_state/sessions/session_cards
2. `20260426_shops.sql` — shops + quote_leads
3. `20260427_shops_newsletter.sql` — shops newsletter columns
4. `20260502221125_v2_carryover.sql` — V2-attempt carryover bundle
5. `20260504120000_scan_events_data.sql` — **NEW S1**
6. `20260504120100_sessions_indexes.sql` — **NEW S1**

All idempotent — re-runnable on the live DB without side effects.
