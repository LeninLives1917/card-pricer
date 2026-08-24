// tests/regression/price-route-field-passthrough.spec.js
//
// PINS a silent field drop found 24 Aug 2026 while verifying in production.
//
// The TCGGO adapter was taught to capture available_items, cardmarket_id,
// set_printed_total, lowest_nm_eu and match_evidence. All five arrived at
// apps/server/routes/price.js and none of them left it, because the route
// rebuilt the object from an explicit field list written before those fields
// existed:
//
//     pricing.rapidapi_cm = { price, lowest_nm, avg7, avg30, lowest_de, ... };
//
// Two consequences, one of them quiet and expensive. The UI could not show the
// fields — visible, annoying, fixable. And pricing/snapshot-writer.js reads
// THIS object, so the newly-started price history would have filled up with
// rows containing no available_items at all: the single column the whole
// exercise exists to collect, absent, in a table that looked like it was
// working. Days of accumulation would have been worthless before anyone
// queried it.
//
// The general defect: adding a field to an adapter required remembering to add
// it in a second, unrelated place, and forgetting was silent. This test makes
// forgetting loud.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildSnapshotRow } from '../../pricing/snapshot-writer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTE = join(ROOT, 'apps', 'server', 'routes', 'price.js');

/** Everything the adapter promises, as the snapshot writer and UI expect it. */
const ADAPTER_RESULT = {
  source: 'rapidapi_cm',
  name: 'Charizard',
  set: 'Base Set',
  set_code: 'BS',
  card_number: '4',
  price: 380,
  lowest_nm: 380,
  lowest_nm_eu: 375,
  avg7: 268.79,
  avg30: 272.97,
  available_items: 79,
  cardmarket_id: 274663,
  set_printed_total: 102,
  match_evidence: 'code',
  set_evidence: 'code',
  requested_number: '4',
};

describe('price route carries adapter fields through', () => {
  test('the route does not rebuild rapidapi_cm from a hardcoded field list', async () => {
    const src = await readFile(ROUTE, 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const m = code.match(/pricing\.rapidapi_cm\s*=\s*\{[\s\S]*?\};/);
    assert.ok(m, 'the assignment should still exist');
    assert.match(m[0], /\.\.\.rd/,
      'rapidapi_cm must spread the adapter result — an explicit list drops every ' +
      'field added later, silently, including the one the price history needs');
  });

  test('the fields the snapshot writer needs survive the route shape', () => {
    // Simulate what the route now produces and feed it to the real writer.
    const pricing = { rapidapi_cm: { ...ADAPTER_RESULT, source: 'rapidapi_cm' } };
    const row = buildSnapshotRow({ set_id: 'base1', card_number: '4' }, pricing);
    assert.ok(row, 'a priced card must produce a row');
    assert.equal(row.cm.available_items, 79,
      'THE column the history exists for — a row without it is a heartbeat, not data');
    assert.equal(row.cm.cardmarket_id, 274663);
    assert.equal(row.cm.lowest_nm_eu, 375);
    assert.equal(row.cm.evidence, 'code');
  });

  test('the old hardcoded shape would have produced an empty history row', () => {
    // The exact failure, reconstructed: everything looks fine, the row is
    // written, and the one column that matters is null.
    const dropped = {
      price: 380, lowest_nm: 380, avg7: 268.79, avg30: 272.97,
      lowest_de: 370, source: 'rapidapi_cm',
    };
    const row = buildSnapshotRow({ set_id: 'base1', card_number: '4' }, { rapidapi_cm: dropped });
    assert.ok(row, 'it still writes — that is what made this quiet');
    assert.equal(row.cm.available_items, null,
      'and the supply signal is gone, in a table that looks healthy');
  });
});
