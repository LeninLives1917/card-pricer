// Regression: the email a customer gets after sending their list from the
// website (15 Oct 2026). Dave: "we need to have an auto email after they
// submit, that says thanks a mil for submitting, are you free to drop in at
// some point to give us a closer look at the cards". The old email opened
// with the numbers and only asked them in at the very bottom.
//
// Pinned: the customer email thanks them and asks them to drop in, up top;
// Board & Brewed's version says where and when; another shop's version does
// not carry B&B's address; the indicative / Near Mint wording stays.
//
// DI via handleQuoteLead(body, req, deps). No mock.module().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleQuoteLead } from '../../apps/server/routes/quote-lead.js';

const REQ = { ip: '127.0.0.1', protocol: 'https', get: (h) => (h === 'host' ? 'card-pricer.test' : null) };
const BODY = {
  email: 'customer@example.com', name: 'Aoife', newsletter: false,
  cards: [{ name: 'Charizard', set_code: 'BS', card_number: '4', market_value: 10, cash_offer: 5.5, credit_offer: 7 }],
  totals: { market: 10, cash: 5.5, credit: 7 }, cashPct: 55, creditPct: 70,
};

function fakeDb(shop = null) {
  return {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: shop }),
        insert() { return { select() { return this; }, single: async () => ({ data: { id: 'lead-1' }, error: null }) }; },
      };
    },
  };
}

async function customerEmail(body, shop) {
  const sent = [];
  const sendEmail = async (to, subject, html) => { sent.push({ to, subject, html }); return {}; };
  const r = await handleQuoteLead(body, REQ, { supabaseClient: fakeDb(shop), sendEmail, brevoApiKey: 'test', captureException: () => {} });
  assert.equal(r.status, 200);
  return sent.find((m) => m.to === body.email);
}

test('the customer is thanked and asked to drop in, before the numbers', async () => {
  const m = await customerEmail(BODY, null);
  assert.match(m.subject, /thanks a mil/i);
  assert.match(m.subject, /drop in/i);
  const text = m.html.replace(/<[^>]+>/g, ' ');
  assert.match(text, /Thanks a mil, Aoife/);
  assert.match(text, /Are you free to drop in at some point so we can have a closer look at the cards\?/);
  assert.ok(text.indexOf('drop in') < text.indexOf('Cash offer'), 'the invitation comes before the table');
  assert.match(text, /indicative offer/);
  assert.match(text, /Near Mint/);
});

test('Board & Brewed says where and when; another shop does not get our address', async () => {
  const bb = await customerEmail(BODY, null);
  assert.match(bb.html, /75 York Road, Dún Laoghaire/);
  assert.match(bb.html, /Sun 10am to 8pm/);
  assert.match(bb.html, /google\.com\/maps\/dir/);

  const other = await customerEmail({ ...BODY, shop_slug: 'irelandcardshow' },
    { id: 's2', slug: 'irelandcardshow', name: 'Ireland card show', email: 'liam@example.com', active: true });
  assert.match(other.html, /drop in/);
  assert.doesNotMatch(other.html, /York Road/);
});
