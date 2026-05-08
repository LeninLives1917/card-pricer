// tests/regression/image-fallback.spec.js
//
// Regression spec for pricing/price.js#resolveImageFallback — the
// server-side image-fallback cascade introduced in V2.
//
// Cascade contract:
//   1. resolveSetCode(card.set_code) → if setId is null, return null.
//   2. If card.card_number is missing, return null.
//   3. lookupLocalDb(setId, cardNumber) → if record.reference_image is truthy, return it.
//   4. Game-specific CDN lookup:
//        pokemon  → fetchPokemonImageByCdnLookup(setId, cardNumber)
//        magic    → verifyMagic(card).image
//        lorcana  → verifyLorcana(card).image
//        yugioh   → verifyYuGiOh(card).image
//        swu      → verifySWU(card).image
//        default  → null
//   5. CDN hit → cacheCardResult(setId, cardNumber, {...}) fire-and-forget.
//   6. CDN error → console.warn, return null (no rethrow).
//
// Mocking strategy: DI via the `deps` second argument of resolveImageFallback.
// No mock.module(), no experimental flags — runs under plain `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageFallback } from '../../pricing/price.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function spy(returnValue) {
  const fn = (...args) => {
    fn.calls.push(args);
    return typeof returnValue === 'function' ? returnValue(...args) : returnValue;
  };
  fn.calls = [];
  return fn;
}

function throwOnCall(name) {
  return () => { throw new Error(`Unexpected ${name} call`); };
}

// Build a default deps object. CDN adapters throw on unexpected calls so tests
// must explicitly opt in to the ones they exercise.
function buildDeps(overrides = {}) {
  return {
    lookupLocalDb: throwOnCall('lookupLocalDb'),
    cacheCardResult: () => null,
    fetchPokemonImageByCdnLookup: throwOnCall('fetchPokemonImageByCdnLookup'),
    verifyMagic: throwOnCall('verifyMagic'),
    verifyLorcana: throwOnCall('verifyLorcana'),
    verifyYuGiOh: throwOnCall('verifyYuGiOh'),
    verifySWU: throwOnCall('verifySWU'),
    resolveSetCode: (code) => ({ setId: String(code).toLowerCase() }),
    ...overrides,
  };
}

// A card with a set_code that resolveSetCode will map to a non-null setId.
const POKEMON_CARD = { game: 'pokemon', set_code: 'SV1', card_number: '1' };

// ── Test 1: CARD_DB hit short-circuits ───────────────────────────────────────

test('CARD_DB hit short-circuits the cascade — CDN adapters are never invoked', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => ({
      game: 'pokemon',
      name: 'Test',
      set_name: 'Test Set',
      set_code: 'SV1',
      card_number: '1',
      reference_image: 'https://images.pokemontcg.io/sv1/1_hires.png',
      verified: true,
      db_source: 'local-db',
    }),
    // CDN adapters remain as throwOnCall via buildDeps defaults
  });

  const result = await resolveImageFallback(POKEMON_CARD, deps);

  assert.equal(result, 'https://images.pokemontcg.io/sv1/1_hires.png',
    'must return the local DB image URL when CARD_DB hits');
});

// ── Test 2: CARD_DB miss + pokemon → fetchPokemonImageByCdnLookup ─────────────

test('CARD_DB miss + game=pokemon → calls fetchPokemonImageByCdnLookup, returns CDN URL', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    fetchPokemonImageByCdnLookup: async () => 'https://example.com/poke.png',
  });

  const result = await resolveImageFallback(POKEMON_CARD, deps);

  assert.equal(result, 'https://example.com/poke.png',
    'must return the CDN URL returned by fetchPokemonImageByCdnLookup');
});

// ── Test 3: CARD_DB miss + magic → verifyMagic ───────────────────────────────

test('CARD_DB miss + game=magic → calls verifyMagic, returns .image', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    verifyMagic: async () => ({ image: 'https://scryfall.com/x.png' }),
  });

  const result = await resolveImageFallback(
    { game: 'magic', set_code: 'dsk', card_number: '100' },
    deps,
  );

  assert.equal(result, 'https://scryfall.com/x.png');
});

// ── Test 4: CARD_DB miss + lorcana → verifyLorcana ───────────────────────────

test('CARD_DB miss + game=lorcana → calls verifyLorcana, returns .image', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    verifyLorcana: async () => ({ image: 'https://cdn.lorcana.com/card.png' }),
  });

  const result = await resolveImageFallback(
    { game: 'lorcana', set_code: 'tfc', card_number: '5' },
    deps,
  );

  assert.equal(result, 'https://cdn.lorcana.com/card.png');
});

// ── Test 5: CARD_DB miss + yugioh → verifyYuGiOh ─────────────────────────────

test('CARD_DB miss + game=yugioh → calls verifyYuGiOh, returns .image', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    verifyYuGiOh: async () => ({ image: 'https://ygoprodeck.com/card.jpg' }),
  });

  const result = await resolveImageFallback(
    { game: 'yugioh', set_code: 'lob', card_number: '1' },
    deps,
  );

  assert.equal(result, 'https://ygoprodeck.com/card.jpg');
});

// ── Test 6: CARD_DB miss + swu → verifySWU ───────────────────────────────────

test('CARD_DB miss + game=swu → calls verifySWU, returns .image', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    verifySWU: async () => ({ image: 'https://swu-db.com/card.webp' }),
  });

  const result = await resolveImageFallback(
    { game: 'swu', set_code: 'sor', card_number: '42' },
    deps,
  );

  assert.equal(result, 'https://swu-db.com/card.webp');
});

// ── Test 7: Unknown game → null, no CDN adapter called ───────────────────────

test('unknown game returns null without calling any CDN adapter', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    // all CDN adapters remain as throwOnCall
  });

  const result = await resolveImageFallback(
    { game: 'klingon', set_code: 'SV1', card_number: '1' },
    deps,
  );

  assert.equal(result, null, 'unsupported game must return null cleanly');
});

// ── Test 8: Null setId → return null without any lookups ─────────────────────

test('missing set_code → null setId → returns null, lookupLocalDb not called', async () => {
  const deps = buildDeps({
    resolveSetCode: () => ({ setId: null }),
    // lookupLocalDb remains as throwOnCall — will throw if called
  });

  const result = await resolveImageFallback(
    { game: 'pokemon', set_code: null, card_number: '1' },
    deps,
  );

  assert.equal(result, null,
    'null setId must short-circuit before any lookup');
});

// ── Test 9: CDN error → null returned, no rethrow; console.warn emitted ──────

test('CDN error → resolveImageFallback returns null without rethrowing', async () => {
  const deps = buildDeps({
    lookupLocalDb: () => null,
    fetchPokemonImageByCdnLookup: async () => { throw new Error('network timeout'); },
  });

  const warnMessages = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnMessages.push(args.join(' '));

  let result;
  try {
    result = await resolveImageFallback(POKEMON_CARD, deps);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result, null, 'CDN error must return null, not rethrow');
  assert.ok(
    warnMessages.some(m => m.includes('image-fallback')),
    `expected a console.warn containing "image-fallback", got: ${JSON.stringify(warnMessages)}`,
  );
});

// ── Test 10: CDN success → cacheCardResult write-through ─────────────────────

test('CDN success triggers cacheCardResult write-through with setId + cardNumber', async () => {
  const cacheCardResult = spy(null);
  const deps = buildDeps({
    lookupLocalDb: () => null,
    fetchPokemonImageByCdnLookup: async () => 'https://example.com/poke.png',
    cacheCardResult,
  });

  await resolveImageFallback(POKEMON_CARD, deps);

  assert.equal(cacheCardResult.calls.length, 1,
    'cacheCardResult must be called exactly once on a CDN hit');

  const [calledSetId, calledCardNumber, calledData] = cacheCardResult.calls[0];
  // setId resolves from 'SV1' → 'sv1' via our buildDeps resolveSetCode default
  assert.equal(calledSetId, 'sv1', 'first arg must be the resolved setId');
  assert.equal(calledCardNumber, '1', 'second arg must be the card_number');
  assert.ok(
    typeof calledData === 'object' && calledData !== null,
    'third arg must be a card-data object',
  );
  assert.equal(calledData.reference_image, 'https://example.com/poke.png',
    'cached record must carry the CDN image URL as reference_image');
});

// ── Test 11: Missing card_number → null, lookupLocalDb not called ─────────────

test('missing card_number → returns null, lookupLocalDb not called', async () => {
  const deps = buildDeps({
    // lookupLocalDb remains as throwOnCall
  });

  const result = await resolveImageFallback(
    { game: 'pokemon', set_code: 'SV1' },
    deps,
  );

  assert.equal(result, null,
    'card_number is required; must short-circuit before lookupLocalDb');
});
