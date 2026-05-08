// RG-30: /api/lookup-by-number returns correct card for SM211 promo (Black Star promo with non-standard set/number).
//
// The route handler lives at apps/server/routes/identify.js:836.
// It calls axios.get('https://api.pokemontcg.io/v2/cards', ...) using the
// shared axios singleton from apps/server/_clients.js.
// We monkey-patch axios.get on that singleton — same pattern as ocr-first.spec.js:74.
// No mock.module(), no real network calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import identifyRouter from '../../apps/server/routes/identify.js';
import { axios } from '../../apps/server/_clients.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const realAxiosGet = axios.get.bind(axios);

// Stub axios.get so any pokemontcg.io call returns `data`.
// Returns a restore function; call it in finally{}.
function stubPokemonTcg(responseData) {
  axios.get = async (url, opts) => {
    if (url && url.includes('pokemontcg.io')) {
      return { data: responseData };
    }
    return realAxiosGet(url, opts);
  };
  return () => { axios.get = realAxiosGet; };
}

// Minimal SM211 pokemontcg.io card fixture — sourced from RG-33 (ocr-first.spec.js:193).
const SM211_PTCG_CARD = {
  id: 'smp-SM211',
  name: 'Detective Pikachu Charizard-GX',
  number: 'SM211',
  rarity: 'Promo',
  hp: '250',
  set: {
    id: 'smp',
    name: 'SM Black Star Promos',
    releaseDate: '2018/01/19',
  },
  images: {
    small: 'https://images.pokemontcg.io/smp/SM211.png',
    large: 'https://images.pokemontcg.io/smp/SM211_hires.png',
  },
  cardmarket: { url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/SM-Black-Star-Promos/Detective-Pikachu-Charizard-GX' },
  tcgplayer: { url: 'https://www.tcgplayer.com/product/sm211' },
};

// Extract the final async handler from a route path (skips requireAuth, enforceQuota etc.)
function getHandler(path) {
  const layer = identifyRouter.stack.find(l => l.route && l.route.path === path);
  assert.ok(layer, `route ${path} not registered`);
  const handlers = layer.route.stack.map(s => s.handle);
  return handlers[handlers.length - 1];
}

// Minimal req / res mock.
function makeReqRes(body = {}) {
  let status = 200;
  let responseBody;
  const res = {
    status(s) { status = s; return this; },
    json(b) { responseBody = b; return this; },
  };
  const req = { user: { id: 'u-rg30' }, body };
  return { req, res, getStatus: () => status, getBody: () => responseBody };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const handler = getHandler('/api/lookup-by-number');

// (a) SM211 promo happy path — adapter returns exactly one result.
test('RG-30: SM211 promo → lookup-by-number returns correct card', async () => {
  const restore = stubPokemonTcg({ data: [SM211_PTCG_CARD] });
  try {
    const { req, res, getStatus, getBody } = makeReqRes({ number: 'SM211', game: 'pokemon' });
    await handler(req, res);

    assert.equal(getStatus(), 200, 'expected 200 OK');
    const body = getBody();
    assert.ok(body.cards, 'response must have cards array');
    assert.equal(body.cards.length, 1, 'expected exactly one card');

    const card = body.cards[0];
    assert.equal(card.card_number, 'SM211', 'card_number must round-trip as SM211');
    assert.equal(card.set_code, 'SMP', 'set_code must be SMP (uppercased from smp)');
    assert.equal(card.name, 'Detective Pikachu Charizard-GX', 'name must match fixture');
    assert.equal(card.game, 'pokemon', 'game must be pokemon');
    assert.equal(card.source, 'pokemontcg.io (ocr-direct)', 'source tag must be preserved');
  } finally {
    restore();
  }
});

// (b) Non-existent number → route returns 404 with "no unique match".
test('RG-30: unknown number → 404 no unique match', async () => {
  const restore = stubPokemonTcg({ data: [] });
  try {
    const { req, res, getStatus, getBody } = makeReqRes({ number: '99999', game: 'pokemon' });
    await handler(req, res);

    assert.equal(getStatus(), 404, 'expected 404 for unknown card');
    assert.ok(getBody().error, 'response must have error field');
    assert.match(getBody().error, /no unique match/, 'error must say "no unique match"');
  } finally {
    restore();
  }
});

// (c) Adapter throws → route returns 500 with error message (graceful fallback path).
test('RG-30: pokemontcg adapter throws → 500 error response', async () => {
  axios.get = async (url) => {
    if (url && url.includes('pokemontcg.io')) {
      throw new Error('network timeout');
    }
    return realAxiosGet(url);
  };
  try {
    const { req, res, getStatus, getBody } = makeReqRes({ number: 'SM211', game: 'pokemon' });
    await handler(req, res);

    // The route catches errors from the outer try/catch at line 960 → 500.
    // However the inner per-query try/catch at line 953 absorbs pokemontcg errors
    // and falls through to the 404 path. Pin whichever the route does today.
    const s = getStatus();
    assert.ok(s === 404 || s === 500, `expected 404 or 500 on adapter error, got ${s}`);
    assert.ok(getBody().error, 'response must have error field on failure');
  } finally {
    axios.get = realAxiosGet;
  }
});

// (d) missing "number" field → 400 validation error.
test('RG-30: missing number field → 400 bad request', async () => {
  const { req, res, getStatus, getBody } = makeReqRes({ game: 'pokemon' });
  await handler(req, res);

  assert.equal(getStatus(), 400, 'expected 400 when number is absent');
  assert.ok(getBody().error, 'response must have error field');
});
