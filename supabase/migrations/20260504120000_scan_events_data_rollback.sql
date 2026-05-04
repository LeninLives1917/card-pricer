-- Rollback for 20260504120000_scan_events_data.sql
-- Drops the partial index and the `data` column.
--
-- WARNING: dropping the column destroys any OCR-first telemetry rows
-- that were written between forward-migration and rollback. Per
-- CARD_PRICER_V2_PROMPT.md §2.4, dump scan_events first if the
-- telemetry is needed for post-mortem.

drop index if exists public.scan_events_ocr_first_idx;

alter table public.scan_events
  drop column if exists data;
