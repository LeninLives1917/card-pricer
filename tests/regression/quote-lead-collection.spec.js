// Regression: a lead must carry the WHOLE list, including cards that could not
// be priced.
//
// INCIDENT (7 Oct 2026). handleQuoteLead kept cards.slice(0, 20): fine while
// the quote page itself stopped at 20, silently wrong once the whole-list
// quote (routes/quote-batch.js) takes up to 1,000 lines. The shop would get a
// lead for the first 20 cards of a collection and a total that undercounts it.
// And lines the quote could not price (not in today's price guide, 1st
// Edition, a question left open) were simply dropped, though those are the
// cards the shop most needs to look at.

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleQuoteLead, MAX_LEAD_CARDS } from '../../apps/server/routes/quote-lead.js';

function fakeSupabase() {
  const inserts = [];
  return {
    inserts,
    from(table) {
      return {
        insert(row) {
          inserts.push({ table, row });
          return { select: () => ({ single: async () => ({ data: { id: 'lead-1' }, error: null }) }) };
        },
      };
    },
  };
}

const req = { ip: '203.0.113.1', protocol: 'https', get: () => 'example.test' };

const card = (i, qty = 1) => ({
  name: `Card ${i}`, set_code: 'OBF', card_number: String(i),
  market_value: 2 * qty, cash_offer: 1.1 * qty, credit_offer: 1.4 * qty, qty,
});

test('30 priced cards are all kept (the old cap was 20)', async () => {
  const sb = fakeSupabase();
  const res = await handleQuoteLead(
    { email: 'a@b.ie', cards: Array.from({ length: 30 }, (_, i) => card(i)), totals: { market: 60 } },
    req,
    { supabaseClient: sb, brevoApiKey: null },
  );
  assert.equal(res.status, 200);
  const row = sb.inserts[0].row;
  assert.equal(row.card_count, 30);
  assert.equal(row.cards_json.length, 30);
  assert.ok(MAX_LEAD_CARDS >= 1000);
});

test('quantities count as cards, and by-hand lines are kept and flagged', async () => {
  const sb = fakeSupabase();
  await handleQuoteLead(
    {
      email: 'a@b.ie',
      cards: [card(1, 3)],
      unpriced: [{ line: 'Pikachu 58/102 1st', name: 'Pikachu', card_number: '58', reason: 'first_edition' }],
      totals: { market: 6 },
    },
    req,
    { supabaseClient: sb, brevoApiKey: null },
  );
  const row = sb.inserts[0].row;
  assert.equal(row.card_count, 4, '3 of one card plus one to price by hand');
  const byHand = row.cards_json.find((c) => c.by_hand);
  assert.ok(byHand, 'the by-hand line is persisted');
  assert.equal(byHand.mv, null, 'not priced at zero');
  assert.equal(byHand.reason, 'first_edition');
  assert.equal(row.cards_json[0].qty, 3);
});

test('a list where nothing could be priced is still a lead', async () => {
  const sb = fakeSupabase();
  const res = await handleQuoteLead(
    { email: 'a@b.ie', cards: [], unpriced: [{ line: 'Pikachu 25/128', reason: 'no_cardmarket_product' }] },
    req,
    { supabaseClient: sb, brevoApiKey: null },
  );
  assert.equal(res.status, 200);
  assert.equal(sb.inserts.length, 1);
});

test('no cards and no by-hand lines is still a 400', async () => {
  const res = await handleQuoteLead({ email: 'a@b.ie', cards: [] }, req, { supabaseClient: fakeSupabase(), brevoApiKey: null });
  assert.equal(res.status, 400);
});
