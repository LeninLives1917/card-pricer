// tests/regression/tcggo-endpoint.spec.js
//
// PINS a paid-plan upgrade that did nothing, 24 Aug 2026.
//
// The provider publishes the SAME data under two RapidAPI listings:
//
//     pokemon-tcg-api.p.rapidapi.com/cards/search        free, 100/day
//     cardmarket-api-tcg.p.rapidapi.com/{game}/cards     the subscribed plan
//
// Every call site pointed at the first. Upgrading the second changed nothing at
// all, and the shop stayed on 100 requests a day — which, at one request per
// priced card, is 50-100 cards before every price silently falls back to
// pokemontcg.io's Cardmarket feed, median 209 days old.
//
// Three call sites had drifted apart: the price path, the identify fallback in
// the same file, and the catalogue top-up crawler in apps/server/_card-db-boot.js.
// Two of them would have kept draining the free quota — and because the quota is
// per key, not per listing, exhausting it there would take live pricing down too.
//
// So: one constant, and a test that every caller uses it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TCGGO_HOST } from '../../pricing/adapters/tcggo-rapidapi.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILES = [
  join(ROOT, 'pricing', 'adapters', 'tcggo-rapidapi.js'),
  join(ROOT, 'apps', 'server', '_card-db-boot.js'),
];

/** Strip comments so the incident description does not count as a call site. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

describe('TCGGO endpoint', () => {
  test('the default host is the subscribed listing, not the free one', () => {
    assert.equal(TCGGO_HOST, 'cardmarket-api-tcg.p.rapidapi.com');
  });

  test('no live call site hardcodes the free listing', async () => {
    for (const f of FILES) {
      const code = codeOnly(await readFile(f, 'utf8'));
      assert.doesNotMatch(code, /pokemon-tcg-api\.p\.rapidapi\.com/,
        `${f} still calls the free 100/day listing — a plan upgrade would not reach it`);
    }
  });

  test('every RapidAPI host header comes from the constant', async () => {
    for (const f of FILES) {
      const code = codeOnly(await readFile(f, 'utf8'));
      const headers = code.match(/'X-RapidAPI-Host':\s*([^,\n]+)/g) || [];
      assert.ok(headers.length > 0, `${f} should still call TCGGO`);
      for (const h of headers) {
        assert.match(h, /TCGGO_HOST/,
          `a literal host string drifted from the constant: ${h.trim()}`);
      }
    }
  });

  test('per_page is not sent — upstream ignores it', async () => {
    // Tested against the live API: per_page, limit and page_size are all
    // ignored and the page is always 20. Leaving one in the params is a claim
    // the API does not keep, and it hid how many requests a full pass costs
    // (21,933 cards / 20 = 1,097, not 439 at the per_page:50 that was there).
    const code = codeOnly(await readFile(FILES[1], 'utf8'));
    assert.doesNotMatch(code, /per_page:\s*\d+/,
      'the crawler still claims a page size the upstream does not honour');
  });
});
