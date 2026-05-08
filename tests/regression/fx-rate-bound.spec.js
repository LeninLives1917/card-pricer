// tests/regression/fx-rate-bound.spec.js
// Owner: regression-backfill (V2.1)
//
// RG-27: USD→EUR fallback bound (0.5–2.0)
//
// pricing/fx.js#refreshFxRate rejects any rate outside the (0.5, 2.0) window
// and keeps the previously-known value instead. This pins the V2_AUDIT §5.25
// invariant: a rogue frankfurter.app response (or network glitch returning a
// wild number) must never corrupt the pricing pipeline's EUR conversion factor.
//
// Strategy: import getUsdToEur + refreshFxRate from pricing/fx.js, then stub
// axios.get on the shared axios instance imported from apps/server/_clients.js.
// ESM imports share the same object reference, so mutating axios.get on the
// instance is visible inside fx.js without mock.module (see memory/ DI
// pattern — mock.module is banned).
//
// Each test restores axios.get after asserting, even on failure, via
// try/finally. Tests run serially because they all touch the module-global
// _usdToEur state in fx.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getUsdToEur, refreshFxRate } from '../../pricing/fx.js';
import { axios } from '../../apps/server/_clients.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Run refreshFxRate() with axios.get stubbed to resolve with the given
 * frankfurter-shaped payload. Restores axios.get afterwards.
 */
async function withStubbedRate(responseData, fn) {
  const original = axios.get;
  axios.get = async () => ({ data: responseData });
  try {
    await refreshFxRate();
    return fn();
  } finally {
    axios.get = original;
  }
}

/**
 * Run refreshFxRate() with axios.get stubbed to reject (network error).
 */
async function withNetworkError(fn) {
  const original = axios.get;
  axios.get = async () => { throw new Error('ECONNREFUSED — test-induced'); };
  try {
    await refreshFxRate();
    return fn();
  } finally {
    axios.get = original;
  }
}

// ── RG-27 tests ──────────────────────────────────────────────────────────────

test('RG-27: valid rate within bounds is accepted and stored', async () => {
  const before = getUsdToEur();
  await withStubbedRate(
    { rates: { EUR: 0.91 }, date: '2026-05-08' },
    () => {
      assert.equal(getUsdToEur(), 0.91,
        'refreshFxRate must accept a valid in-bounds rate (0.91) and store it');
    }
  );
  // Restore for subsequent tests by re-setting to a known value.
  // We run a second stub with the original value if it changed.
  void before; // not used — each test owns its postcondition
});

test('RG-27: rate above upper bound (5.0) is rejected — previous value kept', async () => {
  // Prime with a known good value so the test is deterministic regardless of
  // run order.
  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});
  const primed = getUsdToEur();
  assert.equal(primed, 0.92, 'priming stub must have set 0.92');

  await withStubbedRate(
    { rates: { EUR: 5.0 }, date: '2026-05-08' },
    () => {
      assert.equal(getUsdToEur(), 0.92,
        'refreshFxRate must reject rate=5.0 (above 2.0 ceiling) and keep 0.92');
    }
  );
});

test('RG-27: rate below lower bound (0.1) is rejected — previous value kept', async () => {
  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});

  await withStubbedRate(
    { rates: { EUR: 0.1 }, date: '2026-05-08' },
    () => {
      assert.equal(getUsdToEur(), 0.92,
        'refreshFxRate must reject rate=0.1 (below 0.5 floor) and keep 0.92');
    }
  );
});

test('RG-27: exact boundary values (0.5 and 2.0) are rejected — bounds are exclusive', async () => {
  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});

  // Boundary 0.5 (not strictly greater-than 0.5, so the condition `rate > 0.5` fails).
  await withStubbedRate(
    { rates: { EUR: 0.5 }, date: '2026-05-08' },
    () => {
      assert.equal(getUsdToEur(), 0.92,
        'rate === 0.5 must be rejected (exclusive lower bound: rate > 0.5)');
    }
  );

  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});

  // Boundary 2.0 (not strictly less-than 2.0, so the condition `rate < 2.0` fails).
  await withStubbedRate(
    { rates: { EUR: 2.0 }, date: '2026-05-08' },
    () => {
      assert.equal(getUsdToEur(), 0.92,
        'rate === 2.0 must be rejected (exclusive upper bound: rate < 2.0)');
    }
  );
});

test('RG-27: network error keeps the last known rate', async () => {
  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});

  await withNetworkError(() => {
    assert.equal(getUsdToEur(), 0.92,
      'refreshFxRate must swallow network errors and keep the last known rate');
  });
});

test('RG-27: malformed response (missing rates key) keeps the last known rate', async () => {
  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});

  await withStubbedRate(
    { unexpected: 'shape' },
    () => {
      assert.equal(getUsdToEur(), 0.92,
        'refreshFxRate must reject a response missing rates.EUR and keep 0.92');
    }
  );
});

test('RG-27: non-numeric rate value is rejected — previous value kept', async () => {
  await withStubbedRate({ rates: { EUR: 0.92 }, date: '2026-05-08' }, () => {});

  await withStubbedRate(
    { rates: { EUR: 'not-a-number' }, date: '2026-05-08' },
    () => {
      assert.equal(getUsdToEur(), 0.92,
        'refreshFxRate must reject a non-numeric rate (typeof check) and keep 0.92');
    }
  );
});
