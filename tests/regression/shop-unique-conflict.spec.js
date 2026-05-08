// RG-17: shops.unique(owner_user_id) → 409. A second shop from the same owner
// triggers Postgres 23505; route maps to HTTP 409.
//
// Owner: A1 | Slice: S5 (V2_SMOKE_TEST §6 RG-17)
//
// Contract: POST /api/shop with a duplicate owner_user_id returns 409 with an
// informative error body. This test pins the 23505→409 mapping via DI so a
// regression that swallows or re-raises the error differently is caught
// before it ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleCreateShop } from '../../apps/server/routes/shop.js';

const OWNER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const VALID_BODY = {
  slug: 'test-shop',
  name: 'Test Shop',
  email: 'owner@example.com',
};

const SHOP_ROW = {
  id: 'shop-uuid-1',
  owner_user_id: OWNER_ID,
  slug: 'test-shop',
  name: 'Test Shop',
  email: 'owner@example.com',
  created_at: '2026-01-01T00:00:00Z',
};

/**
 * Minimal chainable fake Supabase whose .insert() resolves to a fixed result.
 * All chain methods return `this` so the full `.from().insert().select().maybeSingle()`
 * call chain resolves via the thenable.
 */
function makeFakeSupabase({ data, error }) {
  const chain = {
    select() { return this; },
    insert() { return this; },
    maybeSingle() { return this; },
    then(resolve) {
      return Promise.resolve({ data, error }).then(resolve);
    },
  };
  return {
    from(_table) { return chain; },
  };
}

// ---------------------------------------------------------------------------
// RG-17 a: duplicate owner_user_id → 409
// ---------------------------------------------------------------------------

test('RG-17: duplicate owner_user_id (23505) → 409 with informative error body', async () => {
  const sb = makeFakeSupabase({
    data: null,
    error: {
      code: '23505',
      message: 'duplicate key value violates unique constraint "shops_owner_user_id_unique"',
    },
  });

  const { status, body } = await handleCreateShop(VALID_BODY, OWNER_ID, { supabaseClient: sb });

  assert.equal(status, 409, 'status must be 409 for 23505 owner_user_id conflict');
  assert.ok(body.error, 'response body must include an error field');
  assert.match(
    body.error,
    /already have a shop/i,
    'error message must tell the vendor they already have a shop',
  );
});

// ---------------------------------------------------------------------------
// RG-17 b: successful insert → 200 with shop data
// ---------------------------------------------------------------------------

test('RG-17: successful insert → 200 with shop data round-tripped', async () => {
  const sb = makeFakeSupabase({ data: SHOP_ROW, error: null });

  const { status, body } = await handleCreateShop(VALID_BODY, OWNER_ID, { supabaseClient: sb });

  assert.equal(status, 200, 'successful insert must return 200');
  assert.equal(body.id, SHOP_ROW.id, 'response must include the created shop id');
  assert.equal(body.slug, SHOP_ROW.slug, 'response must include the shop slug');
  assert.equal(body.owner_user_id, OWNER_ID, 'response must include owner_user_id');
});

// ---------------------------------------------------------------------------
// RG-17 c: non-23505 Supabase error → 500
// ---------------------------------------------------------------------------

test('RG-17: non-23505 Supabase error → 500 (23505-special-case must not swallow all errors)', async () => {
  const sb = makeFakeSupabase({
    data: null,
    error: { code: '42P01', message: 'relation "shops" does not exist' },
  });

  const { status, body } = await handleCreateShop(VALID_BODY, OWNER_ID, { supabaseClient: sb });

  assert.equal(status, 500, 'non-23505 DB error must return 500');
  assert.ok(body.error, 'response body must include an error field');
});

// ---------------------------------------------------------------------------
// RG-17 d: validation failure → 400 (guard upstream of DB)
// ---------------------------------------------------------------------------

test('RG-17: missing required fields → 400 (validation guard fires before DB call)', async () => {
  // No DB call should happen — supabaseClient is never reached.
  const sb = makeFakeSupabase({ data: null, error: null });

  const { status, body } = await handleCreateShop(
    { slug: 'ok-slug' /* missing name + email */ },
    OWNER_ID,
    { supabaseClient: sb },
  );

  assert.equal(status, 400, 'missing required fields must return 400');
  assert.ok(body.error, 'response body must include an error field');
});
