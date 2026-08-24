// tests/regression/price-route-condition-drift.spec.js
//
// PINS a live money bug found 24 Aug 2026.
//
// apps/server/routes/price.js is the handler behind BOTH /api/price (the
// vendor app) and /api/v2/quote/price (the customer quote page). It carried
// its own private copy of the condition multiplier table:
//
//     { 'NM': 1.0, 'LP': 0.85, 'MP': 0.70, 'HP': 0.50, 'DMG': 0.30 }
//
// That is the OLD TCGPlayer-shaped vocabulary. The picker shipped in
// result-sheet.js offers Cardmarket's: NM / EX / GD / LP / PL / PO. Four of
// those six were absent from the local table, fell through `|| 1.0`, and were
// priced as Near Mint.
//
// MEASURED against production before the fix — Blastoise BS 2, buy 60%:
//
//     NM  x1.00  buy €8.56
//     EX  x1.00  buy €8.56     should be x0.92
//     GD  x1.00  buy €8.56     should be x0.85
//     LP  x0.85  buy €7.28     should be x0.70
//     PL  x1.00  buy €8.56     should be x0.50
//     PO  x1.00  buy €8.56     should be x0.30
//
// A Poor card was quoted at the Near Mint price. The shop overpaid on every
// played card the picker was used on.
//
// The defect class is a SECOND COPY going stale — the same shape as the
// duplicated language list in apps/vendor/modules/text-parse.js, which has its
// own drift test for the same reason. pricing/conditions.js was updated to
// Cardmarket's scale and this copy was not, because nothing connected them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CONDITION_MULTIPLIERS, CONDITION_ORDER,
} from '../../pricing/conditions.js';
import { withCardmarketFilters } from '../../pricing/adapters/cardmarket-html.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTE = join(ROOT, 'apps', 'server', 'routes', 'price.js');

describe('price route — one condition table, not two', () => {
  test('the route imports the shared multipliers', async () => {
    const src = await readFile(ROUTE, 'utf8');
    assert.match(src, /import\s*\{[^}]*CONDITION_MULTIPLIERS[^}]*\}\s*from\s*['"][^'"]*pricing\/conditions\.js['"]/,
      'the route must take its multipliers from pricing/conditions.js');
  });

  test('the route declares NO condition multiplier table of its own', async () => {
    const src = await readFile(ROUTE, 'utf8');
    // Strip comments — the incident is DESCRIBED in a comment above the fix,
    // and a naive scan would match the description and pass forever.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /conditionMultipliers\s*=\s*\{/,
      'a private multiplier table is how this went stale the first time');
    assert.doesNotMatch(code, /['"]NM['"]\s*:\s*1\.0\s*,\s*['"]LP['"]\s*:/,
      'the old TCGPlayer-shaped literal must not reappear');
  });
});

describe('price route — every grade the picker offers is priced differently', () => {
  test('all six UI grades resolve to a multiplier', () => {
    for (const g of CONDITION_ORDER) {
      assert.equal(typeof CONDITION_MULTIPLIERS[g], 'number',
        `${g} is offered in the picker and MUST have a multiplier — a missing ` +
        `one falls through to 1.0 and silently prices a played card as Near Mint`);
    }
  });

  test('the multipliers are strictly decreasing down the scale', () => {
    const vals = CONDITION_ORDER.map((g) => CONDITION_MULTIPLIERS[g]);
    for (let i = 1; i < vals.length; i += 1) {
      assert.ok(vals[i] < vals[i - 1],
        `${CONDITION_ORDER[i]} (${vals[i]}) must be worth less than ` +
        `${CONDITION_ORDER[i - 1]} (${vals[i - 1]})`);
    }
  });

  test('the exact values that were wrong in production', () => {
    // Pinned individually, because "they differ" would pass on any descending
    // set of numbers. These are the values the shop pays against.
    assert.equal(CONDITION_MULTIPLIERS.NM, 1.00);
    assert.equal(CONDITION_MULTIPLIERS.EX, 0.92, 'was priced at 1.00 in production');
    assert.equal(CONDITION_MULTIPLIERS.GD, 0.85, 'was priced at 1.00 in production');
    assert.equal(CONDITION_MULTIPLIERS.LP, 0.70, 'was priced at 0.85 in production');
    assert.equal(CONDITION_MULTIPLIERS.PL, 0.50, 'was priced at 1.00 in production');
    assert.equal(CONDITION_MULTIPLIERS.PO, 0.30, 'was priced at 1.00 in production');
  });
});

describe('price route — the Cardmarket link is filtered', () => {
  test('the route sends best_url, not the bare search url', async () => {
    const src = await readFile(ROUTE, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.match(code, /url:\s*cmLinks\.best_url/,
      'the UI opens `url`, so it must carry the English + condition filters');
    assert.doesNotMatch(code, /\n\s*url:\s*cmLinks\.search_url/,
      'the bare search url is unfiltered — that was the shipped behaviour');
  });

  test('the route resolves the product page before building links', async () => {
    const src = await readFile(ROUTE, 'utf8');
    assert.match(src, /resolveCardmarketProductUrl/,
      'without this call the route can never return a direct product page; ' +
      'the resolver populates the cache that buildCardmarketUrl reads');
    const resolveAt = src.indexOf('await resolveCardmarketProductUrl');
    const buildAt = src.indexOf('const cmLinks = buildCardmarketUrl');
    assert.ok(resolveAt > -1 && buildAt > resolveAt,
      'order matters — buildCardmarketUrl reads what the resolver cached');
  });

  test('a product URL from the game API is filtered, not passed through raw', () => {
    const raw = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base/Blastoise-BS2?utm_source=x';
    const out = withCardmarketFilters(raw, 'GD');
    assert.match(out, /language=1/, 'English filter');
    assert.match(out, /minCondition=4/, 'GD is Cardmarket code 4');
    assert.doesNotMatch(out, /utm_source/, "pokemontcg.io's attribution is not ours to carry");
  });

  test('each grade maps to its Cardmarket condition code', () => {
    const expected = { MT: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };
    for (const [grade, code] of Object.entries(expected)) {
      assert.match(withCardmarketFilters('https://www.cardmarket.com/x', grade),
        new RegExp(`minCondition=${code}(&|$)`), `${grade} -> ${code}`);
    }
  });
});
