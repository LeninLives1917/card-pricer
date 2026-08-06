// Regression: eBay must never influence a quoted price.
//
// pricing/adapters/ebay-sold.js queries eBay's Browse API, which has no sold
// filter. It asks for ACTIVE listings sorted by price ASCENDING with limit 15,
// then reports the median of those — roughly the 7th-cheapest asking price on
// the marketplace — labelled "sold median". Measured live: €2.28 for a card
// with a true market of €168–210, because the bare-name query in its cascade
// matched Pokémon TCG Online code cards and digital listings.
//
// On a buy-list a wrong price costs real money and an absent one costs nothing,
// so eBay is excluded from both price selection and hotness scoring. These
// tests exist because that exclusion is a DELETION — without them nothing stops
// the block being reinstated by someone who reads the adapter's name and
// reasonably assumes it returns sales.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { scoreHotness } from '../../pricing/price.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const card = { name: 'Charizard', set_code: 'BS', card_number: '4' };

/** Minimal pricing object with no signals at all. */
function basePricing(extra = {}) {
  return { cardmarket: null, tcgplayer: null, justtcg: null, ebay: null, ...extra };
}

// --- hotness ----------------------------------------------------------------

test('eBay listing count does not change the hotness score', () => {
  // sample_size counts ACTIVE listings from a query hard-capped at limit 15,
  // so the old 12/6/3 thresholds were really asking "did the query fill a
  // page?" — worth ±30 points, the largest single term in the score.
  const none = scoreHotness(basePricing({ ebay: { sample_size: 0 } }), card, 10);
  const some = scoreHotness(basePricing({ ebay: { sample_size: 6 } }), card, 10);
  const many = scoreHotness(basePricing({ ebay: { sample_size: 15 } }), card, 10);

  assert.equal(none.score, some.score);
  assert.equal(some.score, many.score);
});

test('eBay listing count contributes no hotness reasons', () => {
  const h = scoreHotness(basePricing({ ebay: { sample_size: 15 } }), card, 10);
  const ebayReasons = h.reasons.filter(r => /ebay/i.test(r));
  assert.deepEqual(ebayReasons, [],
    `expected no eBay-derived reasons, got: ${JSON.stringify(ebayReasons)}`);
});

test('volume is still reported, but labelled as active listings', () => {
  const h = scoreHotness(basePricing({ ebay: { sample_size: 9 } }), card, 10);
  assert.equal(h.volume, 9);
  assert.equal(h.volume_basis, 'ebay_active_listings_capped');
});

test('a missing eBay block does not throw or penalise', () => {
  const withNull = scoreHotness(basePricing(), card, 10);
  const withZero = scoreHotness(basePricing({ ebay: { sample_size: 0 } }), card, 10);
  assert.equal(withNull.score, withZero.score);
  assert.equal(withNull.volume, 0);
});

// --- price selection --------------------------------------------------------
//
// priceCard() fans out over the network, so the selection cascade is guarded
// structurally instead. This is testing a deletion: the assertion is that no
// code path assigns an eBay figure to bestPrice, in either implementation of
// the cascade (the V2 engine and the older route both carry a copy).

const CASCADE_FILES = [
  'pricing/price.js',
  'apps/server/routes/price.js',
];

for (const rel of CASCADE_FILES) {
  test(`${rel} never assigns an eBay figure to bestPrice`, () => {
    const src = fs.readFileSync(join(REPO_ROOT, rel), 'utf8');
    // Strip comments so the explanatory notes about the removal don't match.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /bestPrice\s*=.*\bebay\b/i.test(line));

    assert.deepEqual(offenders, [],
      `eBay reached bestPrice again in ${rel}: ${JSON.stringify(offenders)}`);
  });
}

test('the eBay adapter is still importable and still marked as a price source it is not', async () => {
  // The adapter is intentionally left in place — it populates `pricing.ebay`
  // for display and links. This test just pins that it still loads, so the
  // exclusion above stays a routing decision rather than becoming a dead import.
  const mod = await import('../../pricing/adapters/ebay-sold.js');
  assert.equal(typeof mod.priceEbaySold, 'function');
  assert.equal(typeof mod.__resetTokenCache, 'function');
});

// ---------------------------------------------------------------------------
// Drift between the two copies of the pricing cascade.
//
// The eBay fix landed in pricing/price.js. apps/server/routes/price.js carries
// a DUPLICATE of that cascade and kept scoring hotness on eBay sample_size for
// weeks afterwards, pushing reason strings that read "12 recent eBay sales" —
// a claim about sales made from a capped list of active asks.
//
// Until the duplication is removed, this pins the invariant at the source
// level. Same style as no-raw-api-fetch.spec.js.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CASCADES = [
  'pricing/price.js',
  'apps/server/routes/price.js',
];

test('neither cascade scores hotness on eBay listing counts', () => {
  for (const rel of CASCADES) {
    const src = fs.readFileSync(join(ROOT, rel), 'utf8');
    // Strip comments — both files explain at length why this is wrong, and
    // that prose necessarily contains the words.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

    assert.ok(!/hotness\.score\s*[+-]=[^\n]*\n?[^\n]*ebay/i.test(code),
      `${rel}: hotness.score must not move on eBay data`);

    for (const m of code.match(/hotness\.reasons\.push\([^)]*\)/gi) || []) {
      assert.ok(!/ebay/i.test(m),
        `${rel}: reason string mentions eBay — ${m.slice(0, 80)}`);
    }
  }
});

test('neither cascade calls an eBay figure a "sale"', () => {
  for (const rel of CASCADES) {
    const src = fs.readFileSync(join(ROOT, rel), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // Template literals and plain strings alike.
    assert.ok(!/(recent )?eBay sales/i.test(code),
      `${rel}: says "eBay sales" in live code — the adapter returns active ` +
      'asks, capped at 15, sorted cheapest-first');
  }
});

test('volume is labelled with what it actually measures', () => {
  for (const rel of CASCADES) {
    const src = fs.readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /volume_basis\s*=\s*'ebay_active_listings_capped'/,
      `${rel}: hotness.volume is still reported, so it must carry the label ` +
      'that says it is capped active listings and not sales volume');
  }
});
