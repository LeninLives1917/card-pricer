// tests/regression/graded-sold.spec.js
//
// eBay SOLD graded prices beside the raw price.
//
// This is the first genuine SOLD data the project has ever had. eBay's own
// Browse API has no sold filter — it returns what people are ASKING, sorted
// cheapest first, which is what produced the EUR 2.28 "sold median" for a card
// worth EUR 168-210 recorded in CLAUDE.md. Real sold data there needs the
// Marketplace Insights API, a restricted application we do not have.
//
// The subscribed TCGGO listing carries it, but ONLY on the single-card endpoint
// /pokemon/cards/{id} — the search endpoint returns prices.cardmarket alone, so
// it is a second request and is gated on card value by the caller.
//
//     ebay.graded.psa["10"] = { median_price: 8867.63, sample_size: 1 }
//
// THE SAMPLE SIZE IS HALF THE NUMBER. A PSA 10 median of one sale is an
// anecdote, and it is exactly where a single optimistic auction does the most
// damage: someone reads "PSA 10 EUR 8,158" and sends a card away for grading on
// the strength of it. Every test below that touches a price also asserts the
// count survives.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { axios } from '../../apps/server/_clients.js';
import { fetchTcggoGradedSold } from '../../pricing/adapters/tcggo-rapidapi.js';
import { getUsdToEur } from '../../pricing/fx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A real payload, captured 24 Aug 2026 from /pokemon/cards/49966.
const DARK_TYRANITAR = {
  data: {
    data: {
      id: 49966,
      name: 'Dark Tyranitar',
      prices: {
        cardmarket: { lowest_near_mint: 275, available_items: 97 },
        ebay: {
          currency: 'USD',
          graded: {
            ace: { 9: { median_price: 99.5, sample_size: 1 } },
            bgs: { 9: { median_price: 1583.11, sample_size: 1 } },
            cgc: { 10: { median_price: 1054.53, sample_size: 1 } },
            psa: {
              7: { median_price: 238.2, sample_size: 5 },
              8: { median_price: 439.75, sample_size: 5 },
              9: { median_price: 1141.16, sample_size: 5 },
              10: { median_price: 8867.63, sample_size: 1 },
            },
          },
        },
      },
    },
  },
};

let realGet;
let realKey;

beforeEach(() => {
  realGet = axios.get;
  realKey = process.env.RAPIDAPI_KEY;
  process.env.RAPIDAPI_KEY = 'test-key';
});
afterEach(() => {
  axios.get = realGet;
  if (realKey === undefined) delete process.env.RAPIDAPI_KEY;
  else process.env.RAPIDAPI_KEY = realKey;
});

/** Round the way the adapter does, so the assertion is about the conversion. */
const eurOf = (usd) => Math.round(usd * getUsdToEur() * 100) / 100;

describe('fetchTcggoGradedSold', () => {
  test('returns PSA 10 converted to EUR, with the sample size', async () => {
    axios.get = async () => DARK_TYRANITAR;
    const g = await fetchTcggoGradedSold(49966);
    assert.equal(g.psa10.usd, 8867.63);
    assert.equal(g.psa10.eur, eurOf(8867.63),
      'converted at the live rate, not a frozen constant');
    assert.equal(g.psa10.sample_size, 1,
      'a median of one sale must never be presentable as a price without its n');
  });

  test('carries the other grades too', async () => {
    axios.get = async () => DARK_TYRANITAR;
    const g = await fetchTcggoGradedSold(49966);
    assert.equal(g.psa9.sample_size, 5);
    assert.equal(g.bgs10, null, 'no BGS 10 in this payload — absent, not zero');
    assert.equal(g.cgc10.sample_size, 1);
  });

  test('reads the FX rate through the getter, so a refresh is picked up', async () => {
    // pricing/fx.js deliberately exposes no setter: consumers must call
    // getUsdToEur() rather than caching, or a rate refresh never reaches them.
    // Asserting the RELATIONSHIP rather than a magic number proves the
    // conversion happens without inventing a production seam for a test.
    axios.get = async () => DARK_TYRANITAR;
    const g = await fetchTcggoGradedSold(49966);
    assert.equal(g.psa10.eur, eurOf(g.psa10.usd));
    assert.equal(g.psa9.eur, eurOf(g.psa9.usd));
    assert.ok(g.currency_note.includes(String(getUsdToEur())),
      'the note must state the rate actually used');
  });

  test('a card with no graded sales returns null, not an empty shell', async () => {
    // An empty object would render as a graded block with nothing in it.
    axios.get = async () => ({ data: { data: { prices: { ebay: { graded: {} } } } } });
    assert.equal(await fetchTcggoGradedSold(49966), null);
  });

  test('no ebay block at all is null', async () => {
    axios.get = async () => ({ data: { data: { prices: { cardmarket: {} } } } });
    assert.equal(await fetchTcggoGradedSold(49966), null);
  });

  test('never throws — this is an enrichment, not a price', async () => {
    axios.get = async () => { throw new Error('upstream on fire'); };
    assert.equal(await fetchTcggoGradedSold(49966), null);

    axios.get = async () => ({ data: null });
    assert.equal(await fetchTcggoGradedSold(49966), null);
  });

  test('no id and no key are both no-ops — never a wasted request', async () => {
    let called = false;
    axios.get = async () => { called = true; return DARK_TYRANITAR; };
    assert.equal(await fetchTcggoGradedSold(null), null);
    assert.equal(await fetchTcggoGradedSold(49966, ''), null);
    assert.equal(called, false);
  });
});

describe('the price route gates the extra request on value', () => {
  test('a floor exists and is tunable', async () => {
    const src = await readFile(join(ROOT, 'apps', 'server', 'routes', 'price.js'), 'utf8');
    assert.match(src, /GRADED_MIN_EUR/,
      'the second request must be gated — a PSA 10 comp on a EUR 0.02 common ' +
      'is noise that also costs a request');
    assert.match(src, /process\.env\.GRADED_MIN_EUR/, 'tunable without a deploy');
  });

  test('graded cards do not get a graded comp', async () => {
    // The card IS the grade; comparing it to itself is meaningless, and
    // pricing/conditions.js already skips the condition multiplier for graded.
    const src = await readFile(join(ROOT, 'apps', 'server', 'routes', 'price.js'), 'utf8');
    assert.match(src, /!card\.graded/);
  });
});

describe('the sheet always shows the sample size', () => {
  test('a price is never rendered without its count', async () => {
    const src = await readFile(join(ROOT, 'apps', 'vendor', 'modules', 'result-sheet.js'), 'utf8');
    const block = src.slice(src.indexOf('const gradeRow'), src.indexOf('const gradedRows'));
    assert.match(block, /sample_size/,
      'the count must be rendered beside the price, not dropped');
    assert.match(block, /1 sale/,
      'n=1 must read as "1 sale" — the singular is what makes it obviously thin');
  });

  test('a thin sample is visually flagged', async () => {
    const src = await readFile(join(ROOT, 'apps', 'vendor', 'modules', 'result-sheet.js'), 'utf8');
    const block = src.slice(src.indexOf('const gradeRow'), src.indexOf('const gradedRows'));
    assert.match(block, /thin/, 'fewer than three sales should look different');
  });
});
