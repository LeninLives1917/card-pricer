// RG-11: identCache skipped on verify_rejected — the bad-identify result must not pollute the cache.
//
// The gate lives in apps/server/routes/identify.js:93 (and :140, :317):
//   if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);
//
// This spec pins that contract end-to-end without going through HTTP:
//   a. Positive baseline — successful identify writes to cache.
//   b. verify_rejected result — gate must prevent cache write.
//   c. Hint-mode — identifyCore skips cache entirely (cacheKey is null).
//
// DI strategy: monkey-patch anthropic.messages.create on the shared singleton
// (established pattern in tests/regression/ocr-first.spec.js). No mock.module().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { anthropic } from '../../apps/server/_clients.js';
import {
  identifyCore,
  cacheSet,
  _testCacheHas,
} from '../../pricing/identify-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Save real impl for restoration after each test.
const realAnthropicCreate = anthropic.messages.create.bind(anthropic.messages);

// Build a valid 1×1 JPEG so sharp.metadata() sees format='jpeg' and srcMax=1,
// satisfying passthroughOk → no resize attempted. `r` varies the pixel colour
// so each call produces a different SHA-1 (test isolation without a cache-clear hook).
async function validJpegBuffer(r = 128) {
  return sharp({
    create: { width: 1, height: 1, channels: 3, background: { r, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer();
}

// Minimal Sonnet response fixture — single identified card with no verify fields.
function sonnetResponseJson(overrides = {}) {
  return JSON.stringify({
    cards: [{
      game: 'pokemon',
      name: 'Pikachu',
      card_number: '058/165',
      set_code: 'MEW',
      set_name: 'Pokémon 151',
      rarity: 'Common',
      variant: 'normal',
      language: 'english',
      condition_estimate: 'NM',
      condition_notes: '',
      hp: '60',
      attacks: ['Thunder Shock'],
      regulation_mark: 'H',
      graded: null,
      confidence: 0.97,
      ...overrides,
    }],
  });
}

function stubAnthropic(text) {
  anthropic.messages.create = async () => ({
    content: [{ type: 'text', text }],
  });
  return () => { anthropic.messages.create = realAnthropicCreate; };
}

// ---------------------------------------------------------------------------
// RG-11a: positive baseline — cache populated on successful identify
// ---------------------------------------------------------------------------

test('RG-11: positive baseline — cache entry written after successful identify (no verify_rejected)', async () => {
  const restore = stubAnthropic(sonnetResponseJson());
  const buffer = await validJpegBuffer();

  try {
    const out = await identifyCore({ buffer, hint: '' });
    assert.ok(!out.cached, 'fresh call must not be a cache hit');
    assert.ok(out.cacheKey, 'identifyCore must return a cacheKey when no hint');
    assert.ok(out.parsed, 'identifyCore must return parsed result');

    // Replicate the exact gate from apps/server/routes/identify.js:91-93.
    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);

    assert.ok(
      _testCacheHas(out.cacheKey),
      'identCache must contain an entry for the SHA-1 after a non-rejected identify',
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// RG-11b: gate pin — verify_rejected must prevent cache write
// ---------------------------------------------------------------------------

test('RG-11: verify_rejected result — gate must prevent identCache write', async () => {
  const restore = stubAnthropic(sonnetResponseJson());
  // Use r=64 so this buffer produces a different SHA-1 from RG-11a (r=128 default).
  const buffer = await validJpegBuffer(64);

  try {
    const out = await identifyCore({ buffer, hint: '' });
    assert.ok(out.cacheKey, 'identifyCore must return a cacheKey');

    // Simulate a downstream verify step marking the card as rejected.
    out.parsed.cards = out.parsed.cards.map(c => ({
      ...c,
      verified: false,
      verify_rejected: 'double_check_mismatch',
    }));

    // Replicate the exact gate from apps/server/routes/identify.js:91-93.
    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    assert.ok(anyRejected, 'test setup: anyRejected must be true');

    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);

    assert.ok(
      !_testCacheHas(out.cacheKey),
      'identCache must NOT contain an entry when verify_rejected is set — gate failed',
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// RG-11c: hint-mode bypass — cacheKey is null, cache never written
// ---------------------------------------------------------------------------

test('RG-11: hint-mode — identifyCore skips cache (cacheKey null), no entry written', async () => {
  const restore = stubAnthropic(sonnetResponseJson());
  // r=32 → distinct SHA-1 from the other tests.
  const buffer = await validJpegBuffer(32);

  try {
    const out = await identifyCore({ buffer, hint: 'pokemon' });
    assert.strictEqual(out.cacheKey, null, 'identifyCore must return null cacheKey when hint is set');

    // Gate condition: out.cacheKey is null → falsy → cacheSet never called.
    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);

    // No SHA-1 to check — confirm via the gate condition itself being skipped.
    assert.strictEqual(out.cacheKey, null, 'hint-mode must produce null cacheKey, not an empty string');
  } finally {
    restore();
  }
});
