// RG-16: shopConfigCache invalidation on slug rename. PATCH /api/shop must invalidate BOTH old and new slugs when the slug changes.
//
// Owner: A1 | Slice: S5 (V2_SMOKE_TEST §6 RG-16)
//
// Contract: when a shop's slug is renamed the handler must call invalidateShopConfig
// for BOTH the old slug AND the new slug so neither a stale old-slug entry nor a
// stale new-slug entry can linger in the in-memory cache. Both calls are explicit
// in handleUpdateShop via the injectable `deps.invalidateShopConfig`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleUpdateShop } from '../../apps/server/routes/shop.js';

const OWNER_ID = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';

const EXISTING_SHOP_ROW = {
  id: 'shop-uuid-2',
  owner_user_id: OWNER_ID,
  slug: 'oldslug',
  name: 'My Shop',
  email: 'owner@example.com',
};

/**
 * Chainable fake Supabase that returns different results for sequential calls.
 * First awaited call returns `responses[0]`, second returns `responses[1]`, etc.
 * Supports: .from().select().eq().maybeSingle()  (lookup)
 *           .from().update().eq().select().maybeSingle()  (write)
 */
function makeSequentialFakeSupabase(responses) {
  let callIndex = 0;
  function makeChain() {
    const chain = {
      select() { return this; },
      insert() { return this; },
      update() { return this; },
      eq() { return this; },
      maybeSingle() { return this; },
      then(resolve) {
        const result = responses[callIndex] ?? { data: null, error: null };
        callIndex += 1;
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  }
  return {
    from(_table) { return makeChain(); },
  };
}

// ---------------------------------------------------------------------------
// RG-16 a: slug rename → BOTH old and new slugs are invalidated
// ---------------------------------------------------------------------------

test('RG-16: slug rename → invalidateShopConfig called for BOTH old and new slug', async () => {
  const updatedRow = { ...EXISTING_SHOP_ROW, slug: 'newslug' };

  const sb = makeSequentialFakeSupabase([
    { data: { slug: 'oldslug' }, error: null },  // SELECT existing slug
    { data: updatedRow, error: null },             // UPDATE → returns new row
  ]);

  const invalidated = [];
  const spyInvalidate = (slug) => invalidated.push(slug);

  const { status, body } = await handleUpdateShop(
    { slug: 'newslug', name: 'My Shop', email: 'owner@example.com' },
    OWNER_ID,
    { supabaseClient: sb, invalidateShopConfig: spyInvalidate },
  );

  assert.equal(status, 200, 'rename must return 200');
  assert.equal(body.slug, 'newslug', 'response must include the new slug');
  assert.ok(
    invalidated.includes('oldslug'),
    `old slug 'oldslug' must be invalidated; got: [${invalidated.join(', ')}]`,
  );
  assert.ok(
    invalidated.includes('newslug'),
    `new slug 'newslug' must be invalidated; got: [${invalidated.join(', ')}]`,
  );
  assert.equal(invalidated.length, 2, 'exactly two invalidations must fire on slug rename');
});

// ---------------------------------------------------------------------------
// RG-16 b: no slug change → existing slug invalidated (unconditional on update)
// ---------------------------------------------------------------------------

test('RG-16: no slug change → existing slug still invalidated (cache eviction on any update)', async () => {
  // Route always invalidates both existing.slug and data.slug. When the slug
  // is unchanged they are the same value, so the spy sees it once for existing
  // and once for data — two calls to the same slug.
  const sb = makeSequentialFakeSupabase([
    { data: { slug: 'sameslug' }, error: null },
    { data: { ...EXISTING_SHOP_ROW, slug: 'sameslug', name: 'New Name' }, error: null },
  ]);

  const invalidated = [];
  const spyInvalidate = (slug) => invalidated.push(slug);

  const { status } = await handleUpdateShop(
    { name: 'New Name' },
    OWNER_ID,
    { supabaseClient: sb, invalidateShopConfig: spyInvalidate },
  );

  assert.equal(status, 200, 'no-slug-change update must return 200');
  assert.ok(
    invalidated.includes('sameslug'),
    `slug 'sameslug' must be invalidated on any update; got: [${invalidated.join(', ')}]`,
  );
});

// ---------------------------------------------------------------------------
// RG-16 c: successful no-op patch (name-only) → 200 baseline
// ---------------------------------------------------------------------------

test('RG-16: name-only patch → 200 with updated shop data', async () => {
  const sb = makeSequentialFakeSupabase([
    { data: { slug: 'myshop' }, error: null },
    { data: { ...EXISTING_SHOP_ROW, slug: 'myshop', name: 'Updated Name' }, error: null },
  ]);

  const { status, body } = await handleUpdateShop(
    { name: 'Updated Name' },
    OWNER_ID,
    { supabaseClient: sb, invalidateShopConfig: () => {} },
  );

  assert.equal(status, 200, 'name-only patch must return 200');
  assert.equal(body.name, 'Updated Name', 'response must include the updated name');
});
