-- ============================================================
-- scan_events.data jsonb — OCR-first telemetry payload (F24, Q3)
-- ============================================================
-- Per docs/V2_ARCHITECTURE.md §3.7, every OCR-first attempt writes
-- a scan_events row with endpoint='ocr-first' plus a structured
-- payload in `data` capturing:
--   { ocr_set_code, validated, fell_through_reason, fp_signal? }
-- Used by:
--   - pricing/ocr-first/telemetry.js              (writer)
--   - admin background job                         (reader, FP threshold check)
--   - pricing/ocr-first/validation.js              (FP rate aggregation)
--
-- Additive only. No existing rows reference `data`; default is NULL,
-- so V1 inserts (which omit `data`) keep working unchanged.
--
-- The companion endpoint index lets the FP-threshold job filter the
-- hot endpoint='ocr-first' partition without scanning the full table.
--
-- Idempotent. Safe to re-run on the live DB.

alter table public.scan_events
  add column if not exists data jsonb;

-- Partial index keeps the index tiny — OCR-first will be a small
-- fraction of total scan_events. Time-ordered for the 24h FP window.
create index if not exists scan_events_ocr_first_idx
  on public.scan_events (ts desc)
  where endpoint = 'ocr-first';
