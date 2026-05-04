# Supabase migrations

Source-of-truth schema for the live Supabase project (`vecbaewlxodqnevduoiy`). Every migration here is **idempotent** — re-running on a populated database is a safe no-op.

## File order (apply in this order on a fresh project)

| # | File | What it creates | Status |
|---|---|---|---|
| 1 | `20260421_phase_b_core.sql` | `profiles`, `scan_events`, `user_state`, `sessions`, `session_cards` | **Used by V1** (except `sessions` / `session_cards` — see below) |
| 2 | `20260426_shops.sql` | `shops`, `quote_leads` + RLS | Used by V1 (multi-tenant embed) |
| 3 | `20260427_shops_newsletter.sql` | `shops` newsletter columns | Used by V1 |
| 4 | `20260502221125_v2_carryover.sql` | `card_prices`, `inventory_*`, `listings`, `live_session*`, `customer_accounts`, `quote_offers` | **Carryover** — present in DB, NOT used by V1 server.js. See note below. |
| 5 | `20260504120000_scan_events_data.sql` | `scan_events.data jsonb` + `scan_events_ocr_first_idx` partial index | **V2 / S1** — additive column for OCR-first telemetry payload (F24, V2_ARCHITECTURE §3.7) |
| 6 | `20260504120100_sessions_indexes.sql` | secondary indexes on `sessions(user_id, created_at)`, `session_cards(session_id, created_at)`, `session_cards(user_id)` | **V2 / S1** — performance prerequisite for the F17 dual-write reader/writer |

Each forward-migration above timestamped `…_rollback.sql` is the operator's undo path. Per `CARD_PRICER_V2_PROMPT.md` §2.4 — never edit data in place without a backup.

## Carryover tables (V2 decision)

The `_v2_carryover` file captures schema that exists in the live Supabase project as residue from a rolled-back V2 attempt (commit `a7d4f21` reverted the code; the Postgres schema was not reverted). V1 `server.js` doesn't read or write any of these tables. They contain zero rows in production.

V2 sub-agent A3 (Persistence) decides:
- **(a) adopt and extend** the carryover tables (e.g., move the in-memory `rooms` map into `live_sessions` to survive Render sleep), or
- **(b) refactor into a fresh schema**, then `drop table` the carryover in a follow-up migration once nothing reads from it, or
- **(c) leave them sleeping** and revisit later.

**Decision (locked in `docs/V2_ARCHITECTURE.md` §4):** option **(a) adopt and extend** for every carryover table. Mapping:
- `card_prices` → F16 (A2 + A3, S10): backs `data/card-prices.json`.
- `sessions` / `session_cards` → F17 (A3, S16/S24): replaces the `user_state` JSONB blob via dual-write then read-flip.
- `inventory_items` / `inventory_events` / `listings` → F18 (A9, S18/S19).
- `live_sessions` / `live_session_scans` → F15 (A1 + A3, S11).
- `customer_accounts` / `quote_offers` → F19 (A10 + A1, S20/S21).

Per-table column-level details, RLS policy summaries, and owner-module mapping live in `db/schema.md`.

## Conventions for new migrations

- **Filename:** `<UTC timestamp>_<short_name>.sql`. Pick a timestamp later than the current latest. Format: `YYYYMMDDHHMMSS_…` (no separator) for Supabase-CLI compat, or `YYYYMMDD_…` for human-readable. Both are tolerated.
- **Idempotent.** `create table if not exists`, `create index if not exists`. For policies, `drop policy if exists "<name>" on <table>;` *first*, then `create policy …`. PG doesn't have `create policy if not exists` — without the drop the second run errors.
- **One concern per file.** Adding a column? New file. Adding an index? New file. Don't reopen a closed migration.
- **No data migrations in this folder.** DDL only. Backfills go in `scripts/` and are run once, manually.
- **Test the rollback.** Every new migration should have a sibling `…_rollback.sql` that returns the schema to its pre-migration state. Per `CARD_PRICER_V2_PROMPT.md` §2.4 — never edit data in place without a backup.
- **Don't modify `auth.*`.** Supabase owns that schema; touching it is unsupported.

## Applying migrations

**Production (Supabase Cloud, today):**
1. Open the SQL Editor for project `vecbaewlxodqnevduoiy`.
2. Paste the file contents.
3. Run. Idempotent files are safe to re-run.

**Local / fresh project (Supabase CLI, future-proof path):**
```bash
supabase init                 # one-time
supabase link --project-ref <ref>
supabase db push              # applies every file in this directory in name-sorted order
```

The CLI tracks which files have been applied via the `supabase_migrations.schema_migrations` table. The five `v2_*` versions already in that table on production (`20260502221125`, `20260502221154`, `20260502221210`, `20260502221227`, `20260502221305`) were created by the rolled-back V2 attempt — the consolidated `20260502221125_v2_carryover.sql` here matches those tables' actual DDL exactly, so `db push` against a fresh DB produces an identical schema.

## Verifying a fresh project matches production

```sql
select tablename from pg_tables where schemaname = 'public' order by tablename;
```

Expected: `card_prices, customer_accounts, inventory_events, inventory_items, listings, live_session_scans, live_sessions, profiles, quote_leads, quote_offers, scan_events, session_cards, sessions, shops, user_state` (15 tables).

```sql
select count(*) from pg_policies where schemaname = 'public';
```

Expected: 22 policies (every public table has at least one; some have separate read/mutate splits).
