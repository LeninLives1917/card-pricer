// pricing/fx.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - V1 server.js:826-849 — refreshFxRate, USD_TO_EUR, 24h interval
//   - docs/V2_AUDIT.md §5.25 — bound-checked refresh (0.5..2.0)
//
// VERBATIM extraction. Internal _usdToEur is private to this module; consumers
// always read via getUsdToEur() so they see the latest value (the legacy
// pattern of exporting a `let` got migrated when ESM module-graphs broke
// runtime mutability — getter-as-export is the audit-blessed pattern).

import { axios } from '../apps/server/_clients.js';

// Bounded fallback. The refresh path floors any wild rate (5.0, etc.) at
// 0.5..2.0 — V2_AUDIT §5.25 / RG-27.
let _usdToEur = 0.92;

/**
 * Current USD → EUR rate. Use this getter instead of importing the variable
 * directly: ESM lexical bindings are read-only, but the value is mutated
 * inside refreshFxRate(). Call sites that read once and cache (none should)
 * would observe a stale rate.
 */
export function getUsdToEur() {
  return _usdToEur;
}

/**
 * One-shot refresh against frankfurter.app (free, no key, ECB-derived).
 * Logs success / no-op behaviour. Failures keep the last known value
 * (0.92 fallback at boot). Bound-checked: rates outside 0.5..2.0 are
 * rejected (RG-27).
 */
export async function refreshFxRate() {
  try {
    const resp = await axios.get('https://api.frankfurter.app/latest', {
      params: { from: 'USD', to: 'EUR' },
      timeout: 10000
    });
    const rate = resp.data?.rates?.EUR;
    if (typeof rate === 'number' && rate > 0.5 && rate < 2.0) {
      _usdToEur = rate;
      console.log(`[FX] USD→EUR refreshed: ${rate.toFixed(4)} (frankfurter.app, ${resp.data.date})`);
    } else {
      console.warn(`[FX] Unexpected rate shape — keeping ${_usdToEur}`, rate);
    }
  } catch (e) {
    console.warn(`[FX] Refresh failed — keeping ${_usdToEur}: ${e.message}`);
  }
}

// Boot-time refresh + 24h interval. Same behaviour as V1 server.js:849.
// Side-effect-on-import preserves V1: route handlers don't need to remember
// to call refreshFxRate() before reading the rate.
/**
 * Boot-time refresh + 24h interval. apps/server/server.js calls this
 * explicitly before app.listen. NOT called on import — the open
 * setInterval handle would keep the Node event loop alive in tests
 * that import any pricing/* module, blocking the runner from exiting.
 */
export function startFxRefreshInterval() {
  refreshFxRate();
  return setInterval(refreshFxRate, 24 * 60 * 60 * 1000);
}
