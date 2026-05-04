-- ============================================================
-- sessions / session_cards — indexes for F17 dual-write reader
-- ============================================================
-- The carryover schema (20260421_phase_b_core.sql) created sessions
-- and session_cards with primary keys but no secondary indexes. Once
-- F17 dual-write goes live (db/sessions/dual-write.js) and especially
-- once `READ_FROM_RELATIONAL=true` flips, every page-load issues:
--
--   select * from sessions      where user_id = $1 order by created_at;
--   select * from session_cards where session_id = any($1)
--                                  order by created_at;
--
-- Without these indexes both queries seq-scan. Production has zero
-- rows today (V1 doesn't write here), so creating them now is free —
-- but the migration must land before S16 (sessions cutover) writes
-- begin so the index is populated as rows arrive.
--
-- Read by:
--   - db/sessions/reader.js     (relational read path)
--   - db/sessions/dual-write.js (parity check vs JSONB blob)
--
-- Idempotent. Safe to re-run.

-- For listing a user's sessions in created order on dashboard load.
create index if not exists sessions_user_created_idx
  on public.sessions (user_id, created_at desc);

-- For loading all cards in a session in scan order. Composite on
-- (session_id, created_at) so the reader can paginate large sessions.
create index if not exists session_cards_session_created_idx
  on public.session_cards (session_id, created_at);

-- For the dual-write parity check that fans out across a user's
-- entire history without joining through sessions first.
create index if not exists session_cards_user_idx
  on public.session_cards (user_id);
