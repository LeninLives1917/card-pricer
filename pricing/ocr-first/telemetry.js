// pricing/ocr-first/telemetry.js
//
// Owner: A2 (Pricing engine) — Slice S15
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §3.7 (telemetry on every attempt)
//   - supabase/migrations/20260504120000_scan_events_data.sql
//     (scan_events.data jsonb + endpoint='ocr-first' partial index)
//   - apps/server/middleware/quota.js → logScanEvent (extended in S15
//     to accept an optional `data` payload)
//   - infra/observability/metrics.js (prom-client default registry)
//   - infra/observability/sentry-server.js (Sentry capture for FP breach)
//   - pricing/confidence.js → OCR_FIRST_FP_THRESHOLD
//
// Three responsibilities:
//   1. writeOcrFirstAttempt — fire-and-forget telemetry row write.
//   2. getFpRate24h         — read-side aggregation for the threshold check.
//   3. incrementOcrFirstCounter — prom-client cardpricer_ocr_first_total.
//
// The FP-threshold breach observation is advisory — we emit a Sentry
// warning + console.warn but do NOT auto-disable the path. Per §3.7 Q3
// answer: "auto-disable on threshold breach is deferred — too easy to
// misfire on a small sample". The operator flips OCR_FIRST_ENABLED=false
// manually if the warning fires.

import client from 'prom-client';

import { supabase } from '../../apps/server/_clients.js';
import { logScanEvent } from '../../apps/server/middleware/quota.js';
import { register } from '../../infra/observability/metrics.js';
import { Sentry, isInitialised as sentryIsInitialised } from '../../infra/observability/sentry-server.js';
import { OCR_FIRST_FP_THRESHOLD } from '../confidence.js';

// =============================================================================
// prom-client counter — registered exactly once.
// =============================================================================
//
// `cardpricer_ocr_first_total{outcome=...}`
//   outcome values:
//     - 'validated'                       → match:true happy path
//     - 'fell_through_<reason>'           → mirrors fell_through_reason token
//
// We register against the default registry (same as metrics.js) so the
// /api/metrics endpoint exposes this without a second register pass.
//
// Idempotent registration: if metrics.js is reloaded in tests (which it
// isn't normally — node:test runs each spec in its own process by default),
// a second `new Counter` would throw. We catch and reuse via getSingleMetric.

function ensureCounter() {
  const existing = register.getSingleMetric('cardpricer_ocr_first_total');
  if (existing) return existing;
  return new client.Counter({
    name: 'cardpricer_ocr_first_total',
    help: 'Total /api/v2/identify-ocr-first attempts, by outcome',
    labelNames: ['outcome'], // 'validated' | 'fell_through_<reason>'
    registers: [register],
  });
}

const ocrFirstCounter = ensureCounter();

/**
 * Increment cardpricer_ocr_first_total{outcome}. Never throws.
 *
 * @param {string} outcome  'validated' | `fell_through_${reason}`.
 */
export function incrementOcrFirstCounter(outcome) {
  try {
    ocrFirstCounter.inc({ outcome: String(outcome || 'unknown') });
  } catch (e) {
    // metric collection must never take down a request
    console.warn('[OCR-FIRST-TELEMETRY] counter inc failed:', e?.message || e);
  }
}

// =============================================================================
// writeOcrFirstAttempt — scan_events row with endpoint='ocr-first' + data jsonb.
// =============================================================================
//
// Wraps logScanEvent so failure is fire-and-forget. The extended quota.js
// signature `logScanEvent(userId, endpoint, data?)` accepts an optional
// jsonb payload; we always pass one for ocr-first attempts.
//
// userId may be null when (in a future slice) the OCR-first path is
// reachable from the public quote side. logScanEvent already short-circuits
// on `!userId` — no separate guard needed here. NOTE: scan_events.user_id
// is NOT NULL today; if the public /quote variant ever lands we'll need to
// either relax the column or skip the insert (current quote-public-paths
// path takes the latter approach; we mirror that here).

/**
 * Write one ocr-first telemetry row. Fire-and-forget.
 *
 * @param {string|null} userId   The auth'd user id, or null for anon paths.
 * @param {object}      payload  { ocr_set_code, validated, fell_through_reason,
 *                                 fp_signal? }
 */
export function writeOcrFirstAttempt(userId, payload) {
  try {
    logScanEvent(userId, 'ocr-first', payload);
  } catch (e) {
    // logScanEvent itself is fire-and-forget; if a synchronous throw
    // somehow gets through, swallow it here.
    console.warn('[OCR-FIRST-TELEMETRY] write failed:', e?.message || e);
  }
}

// =============================================================================
// getFpRate24h — read-side aggregation for the FP threshold observation.
// =============================================================================
//
// "FP rate" = (rows where data->>'validated' = 'false' AND fell_through_reason
//              indicates a Sonnet rejection)
//             / (total ocr-first rows in the last 24h).
//
// We DO NOT count rows where fell_through_reason is 'no_reference_image' or
// 'sonnet_error' — those are infrastructure misses, not validation
// rejections. They're worth surfacing separately but they don't speak to
// validation accuracy.
//
// Returns a number in [0, 1]. Returns 0 on Supabase error or empty window.

const FP_REJECT_REASONS = new Set([
  'validation_reject',  // Sonnet said match:false
]);

/**
 * Compute the validation false-positive rate over the last 24h.
 *
 * @returns {Promise<number>}  rate in [0, 1]; 0 on empty window or error.
 */
export async function getFpRate24h() {
  if (!supabase) return 0;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from('scan_events')
      .select('data')
      .eq('endpoint', 'ocr-first')
      .gte('ts', since);
    if (error) {
      console.warn('[OCR-FIRST-TELEMETRY] getFpRate24h query failed:', error.message);
      return 0;
    }
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return 0;

    let rejects = 0;
    for (const row of rows) {
      const d = row?.data || {};
      const validated = d.validated === true;
      if (validated) continue;
      const reason = d.fell_through_reason;
      if (FP_REJECT_REASONS.has(reason)) rejects += 1;
    }
    return rejects / rows.length;
  } catch (e) {
    console.warn('[OCR-FIRST-TELEMETRY] getFpRate24h threw:', e?.message || e);
    return 0;
  }
}

/**
 * Check the 24h FP rate against OCR_FIRST_FP_THRESHOLD. If breached:
 *   - console.warn('[OCR-FIRST-TELEMETRY] FP rate ...')
 *   - Sentry.captureMessage(level: 'warning')
 * Auto-disable is DEFERRED — operator-only.
 *
 * Returns the observed rate so the caller can chain assertions (used in
 * RG-40).
 *
 * @returns {Promise<number>}  the observed FP rate in [0, 1].
 */
export async function maybeWarnOnFpBreach() {
  const rate = await getFpRate24h();
  if (rate > OCR_FIRST_FP_THRESHOLD) {
    const msg = `[OCR-FIRST-TELEMETRY] FP rate ${(rate * 100).toFixed(2)}% exceeds threshold ${(OCR_FIRST_FP_THRESHOLD * 100).toFixed(2)}% (24h)`;
    console.warn(msg);
    try {
      if (sentryIsInitialised()) {
        Sentry.captureMessage(msg, { level: 'warning' });
      }
    } catch (e) {
      console.warn('[OCR-FIRST-TELEMETRY] Sentry capture failed:', e?.message || e);
    }
  }
  return rate;
}

export default {
  writeOcrFirstAttempt,
  getFpRate24h,
  incrementOcrFirstCounter,
  maybeWarnOnFpBreach,
};
