-- Rollback for 20260504120100_sessions_indexes.sql
-- Drops the three secondary indexes added for F17 dual-write reader.
-- No data loss — indexes are pure read-side performance.

drop index if exists public.sessions_user_created_idx;
drop index if exists public.session_cards_session_created_idx;
drop index if exists public.session_cards_user_idx;
