-- 20260810120000_card_price_snapshots_rollback.sql
--
-- Reverses 20260810120000_card_price_snapshots.sql.
--
-- Note this destroys accumulated price history, which is the one thing in this
-- schema that cannot be re-derived — the upstream APIs only serve current
-- prices. Export before running if the series has any age on it.

drop index if exists public.card_price_snapshots_card_idx;
drop index if exists public.card_price_snapshots_captured_on_idx;
drop table if exists public.card_price_snapshots;
