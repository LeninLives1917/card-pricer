// tests/regression/sealed.spec.js
//
// Owner: A2 — Slice S17 (sealed product pricing).
// Cross-references:
//   - pricing/sealed/{product-types,verify,price}.js
//   - pricing/adapters/tcgplayer-pro.js
//   - apps/server/routes/price-sealed.js
//
// Mock-mode tests — no network calls. We toggle TCGPLAYER_PRO_MOCK at
// runtime to exercise the live-vs-mock branches in the adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEALED_BASE_CONFIDENCE,
  SEALED_RECENT_BONUS,
  SEALED_STALE_PENALTY,
  SEALED_RECENT_THRESHOLD_HOURS,
  SEALED_STALE_THRESHOLD_DAYS,
} from '../../pricing/confidence.js';
import {
  SEALED_CATEGORIES,
  normalizeSealedSku,
  isSealedProduct,
} from '../../pricing/sealed/product-types.js';
import {
  verifySealed,
  isSealedVerifyAvailable,
} from '../../pricing/sealed/verify.js';
import {
  priceSealed,
  verifyAndPrice,
  SEALED_STATIC_PRIORITY,
} from '../../pricing/sealed/price.js';
import tcgplayerPro, { sealedConfidence } from '../../pricing/adapters/tcgplayer-pro.js';
import priceSealedRouter from '../../apps/server/routes/price-sealed.js';

// Mode helpers — flip the env var around the test, restore after.
function withMock(fn) {
  const prevMock = process.env.TCGPLAYER_PRO_MOCK;
  const prevKey  = process.env.TCGPLAYER_PRO_API_KEY;
  process.env.TCGPLAYER_PRO_MOCK = 'true';
  delete process.env.TCGPLAYER_PRO_API_KEY;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevMock === undefined) delete process.env.TCGPLAYER_PRO_MOCK; else process.env.TCGPLAYER_PRO_MOCK = prevMock;
      if (prevKey === undefined) delete process.env.TCGPLAYER_PRO_API_KEY; else process.env.TCGPLAYER_PRO_API_KEY = prevKey;
    });
}

function withNoConfig(fn) {
  const prevMock = process.env.TCGPLAYER_PRO_MOCK;
  const prevKey  = process.env.TCGPLAYER_PRO_API_KEY;
  delete process.env.TCGPLAYER_PRO_MOCK;
  delete process.env.TCGPLAYER_PRO_API_KEY;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevMock === undefined) delete process.env.TCGPLAYER_PRO_MOCK; else process.env.TCGPLAYER_PRO_MOCK = prevMock;
      if (prevKey === undefined) delete process.env.TCGPLAYER_PRO_API_KEY; else process.env.TCGPLAYER_PRO_API_KEY = prevKey;
    });
}

// Walk an Express router stack to find the layer for a given path/method.
function findRoute(router, method, path) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    const m = layer.route.methods?.[method.toLowerCase()];
    if (!m) continue;
    return { handlers: layer.route.stack.map(s => s.handle) };
  }
  return null;
}

// ── product-types ──────────────────────────────────────────────────────

test('SEALED_CATEGORIES + tunables match V2_ARCHITECTURE F5', () => {
  assert.deepEqual(
    [...SEALED_CATEGORIES],
    ['booster', 'etb', 'booster-box', 'bundle', 'collection-box', 'special-collection']
  );
  assert.equal(SEALED_BASE_CONFIDENCE, 0.85);
  assert.equal(SEALED_RECENT_BONUS, 0.05);
  assert.equal(SEALED_STALE_PENALTY, -0.10);
  assert.equal(SEALED_RECENT_THRESHOLD_HOURS, 24);
  assert.equal(SEALED_STALE_THRESHOLD_DAYS, 7);
});

test('normalizeSealedSku is idempotent + lowercases + slug-ifies', () => {
  // Idempotence — f(f(x)) === f(x)
  const inputs = [
    'Pokemon SV8 Booster Box',
    'pokemon-sv8-booster-box',
    '  pokemon  SV8   Booster Box  ',
    'Pokémon SV8 Booster Box!',
    '247632',
  ];
  for (const raw of inputs) {
    const once  = normalizeSealedSku(raw);
    const twice = normalizeSealedSku(once);
    assert.equal(twice, once, `idempotence failed for ${JSON.stringify(raw)}`);
    assert.equal(once, once.toLowerCase(), 'must be lowercase');
  }
  // Specific shape
  assert.equal(normalizeSealedSku('Pokemon SV8 Booster Box'), 'pokemon-sv8-booster-box');
  assert.equal(normalizeSealedSku('  POKEMON___SV8 '), 'pokemon-sv8');
  assert.equal(normalizeSealedSku(''), '');
  assert.equal(normalizeSealedSku(null), '');
  assert.equal(normalizeSealedSku('247632'), '247632');
});

test('isSealedProduct rejects non-shapes; accepts canonical', () => {
  assert.equal(isSealedProduct(null), false);
  assert.equal(isSealedProduct({}), false);
  assert.equal(isSealedProduct({ sku: 'x', name: 'X', category: 'invalid' }), false);
  assert.equal(isSealedProduct({ sku: 'x', name: 'X', category: 'booster' }), true);
});

// ── verify ─────────────────────────────────────────────────────────────

test('verifySealed returns the product when adapter has it (mock mode)', () => withMock(async () => {
  assert.equal(isSealedVerifyAvailable(), true);
  const p = await verifySealed({ sku: 'pokemon-sv8-booster-box' });
  assert.ok(p, 'expected a SealedProduct');
  assert.equal(p.sku, 'pokemon-sv8-booster-box');
  assert.equal(p.category, 'booster-box');
  assert.equal(p.set_code, 'SV8');
  assert.equal(typeof p.image_url, 'string');
}));

test('verifySealed returns null when adapter says not-found', () => withMock(async () => {
  const p = await verifySealed({ sku: 'pokemon-zzz-nonexistent' });
  assert.equal(p, null);
}));

test('verifySealed normalises raw input before adapter dispatch', () => withMock(async () => {
  // Caller passes a free-text SKU; we should still match the catalog entry.
  const p = await verifySealed({ sku: 'Pokemon SV8 Booster Box' });
  assert.ok(p);
  assert.equal(p.sku, 'pokemon-sv8-booster-box');
}));

// ── price ──────────────────────────────────────────────────────────────

test('priceSealed math: market × buyPct = suggested', () => withMock(async () => {
  const verified = await verifySealed({ sku: 'pokemon-sv8-etb' });
  assert.ok(verified);
  // fxRate=1 → market_value_eur === raw market (49.99).
  const result = await priceSealed(verified, { fxRate: 1 }, { buyPercentage: 60 });
  assert.equal(result.market, 49.99);
  assert.ok(result.buy_price);
  // 49.99 × 0.60 = 29.994 → rounds to 29.99.
  assert.equal(result.buy_price.suggested, 29.99);
  assert.equal(result.buy_price.market_value, 49.99);
  assert.equal(result.buy_price.currency, 'EUR');
  // Default buyPercentage=60 if omitted.
  const dflt = await priceSealed(verified, { fxRate: 1 });
  assert.equal(dflt.buy_price.suggested, 29.99);
}));

test('priceSealed envelope shape: v2.sources includes tcgplayer-pro', () => withMock(async () => {
  const verified = await verifySealed({ sku: 'pokemon-sv8-booster-box' });
  const result = await priceSealed(verified, { fxRate: 1 });
  assert.equal(result.v2.selected_source, 'tcgplayer-pro');
  assert.ok(Array.isArray(result.v2.sources));
  assert.equal(result.v2.sources.length, 1);
  assert.equal(result.v2.sources[0].source, 'tcgplayer-pro');
  assert.equal(result.v2.sources[0].raw_currency, 'USD');
  assert.equal(typeof result.v2.fx_rate, 'number');
  assert.equal(typeof result.v2.last_updated, 'string');
  assert.deepEqual([...SEALED_STATIC_PRIORITY], ['tcgplayer-pro']);
}));

test('priceSealed applies fxRate to market/low/high', () => withMock(async () => {
  const verified = await verifySealed({ sku: 'pokemon-sv8-etb' });
  // fxRate=2 → 49.99 × 2 = 99.98.
  const result = await priceSealed(verified, { fxRate: 2 });
  assert.equal(result.market, 99.98);
  assert.equal(result.low,  88.00);
  assert.equal(result.high, 118.00);
}));

test('verifyAndPrice glues verify + price; null on miss', () => withMock(async () => {
  const ok = await verifyAndPrice('Pokemon SV8 ETB', { fxRate: 1 });
  assert.ok(ok);
  assert.equal(ok.product.sku, 'pokemon-sv8-etb');
  const miss = await verifyAndPrice('does-not-exist', { fxRate: 1 });
  assert.equal(miss, null);
}));

// ── adapter availability + confidence ──────────────────────────────────

test('tcgplayer-pro adapter shape + isAvailable gating', () => {
  assert.equal(tcgplayerPro.name, 'tcgplayer-pro');
  assert.ok(Array.isArray(tcgplayerPro.supports.games));
  assert.ok(tcgplayerPro.supports.games.includes('pokemon'));
  assert.deepEqual([...tcgplayerPro.supports.categories], [...SEALED_CATEGORIES]);
  assert.equal(typeof tcgplayerPro.verifySealed, 'function');
  assert.equal(typeof tcgplayerPro.priceSealed, 'function');
  // Single-card hooks intentionally absent — sealed-only adapter.
  assert.equal(tcgplayerPro.verify, undefined);
  assert.equal(tcgplayerPro.price, undefined);
});

test('sealedConfidence applies recent_bonus + stale_penalty', () => {
  // No timestamp → baseline.
  assert.equal(sealedConfidence(null), SEALED_BASE_CONFIDENCE);

  // Within 24h → +0.05
  const recent = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  assert.equal(sealedConfidence(recent), Number((SEALED_BASE_CONFIDENCE + SEALED_RECENT_BONUS).toFixed(4)));

  // Older than 7 days → -0.10
  const stale = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  assert.equal(sealedConfidence(stale), Number((SEALED_BASE_CONFIDENCE + SEALED_STALE_PENALTY).toFixed(4)));

  // Between recent threshold and stale threshold → just baseline.
  const middling = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  assert.equal(sealedConfidence(middling), SEALED_BASE_CONFIDENCE);
});

test('isSealedVerifyAvailable: false when no key + no mock', () => withNoConfig(async () => {
  assert.equal(isSealedVerifyAvailable(), false);
  // verifySealed returns null cleanly (doesn't throw).
  const p = await verifySealed({ sku: 'pokemon-sv8-booster-box' });
  assert.equal(p, null);
}));

// ── route wiring (introspection — same pattern as quote-public-paths.spec.js)

test('/api/v2/price-sealed is mounted with auth+quota chain', () => {
  const route = findRoute(priceSealedRouter, 'POST', '/api/v2/price-sealed');
  assert.ok(route, 'POST /api/v2/price-sealed must exist on the router');
  // Three handlers: requireAuth, enforceQuota, the body handler.
  assert.equal(route.handlers.length, 3);
  assert.equal(route.handlers[0].name, 'requireAuth');
  assert.equal(route.handlers[1].name, 'enforceQuota');
});
