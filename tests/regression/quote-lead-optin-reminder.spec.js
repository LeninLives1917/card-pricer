// Regression: quote opt-ins must reach the shop's Brevo lists, and a reminder
// goes out only when the customer asked for one.
//
// INCIDENT (7 Oct 2026). Board & Brewed's shops row had brevo_list_id NULL, so
// a "Keep me posted" tick on /sell-cards fell through to an env var and, with
// none set, reached no list while the response still looked fine. The shop
// also wanted the opt-in on two lists (Pokémon marketing + an attribution
// list) tagged SIGNUP_SOURCE, which one integer column could not hold.
// Separately: follow-up emails to people who only asked for a quote need
// their consent, so the reminder is opt-in (body.reminder === true) only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleQuoteLead,
  brevoListIdsFor,
  brevoAttributesFor,
  reminderSendAt,
  REMINDER_MAX_AHEAD_MS,
} from '../../apps/server/routes/quote-lead.js';

const req = { ip: '203.0.113.1', protocol: 'https', get: () => 'example.test' };
const card = { name: 'Charizard', set_code: 'BS', card_number: '4', market_value: 300, cash_offer: 165, credit_offer: 210 };

function fakeSupabase(shop) {
  return {
    from(table) {
      if (table === 'shops') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: shop }) };
        return q;
      }
      return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'lead-1' }, error: null }) }) }) };
    },
  };
}

test('list ids: array wins, then single id, then env; junk dropped', () => {
  assert.deepEqual(brevoListIdsFor({ brevo_list_ids: [32, 51, 32, 'x', -1] }, '20'), [32, 51]);
  assert.deepEqual(brevoListIdsFor({ brevo_list_ids: [], brevo_list_id: 7 }, '20'), [7]);
  assert.deepEqual(brevoListIdsFor({}, '20'), [20]);
  assert.deepEqual(brevoListIdsFor(null, ''), []);
});

test('attributes: "$now" becomes a timestamp, non-objects ignored', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  assert.deepEqual(
    brevoAttributesFor({ brevo_attributes: { SIGNUP_SOURCE: 'sell-cards', CONSENT_TS: '$now' } }, now),
    { SIGNUP_SOURCE: 'sell-cards', CONSENT_TS: '2026-10-07T12:00:00.000Z' },
  );
  assert.deepEqual(brevoAttributesFor({ brevo_attributes: ['x'] }), {});
});

test('reminder lands at 09:00 UTC, inside Brevo\'s 72-hour window, for every hour of the day', () => {
  for (let h = 0; h < 24; h += 1) {
    const now = new Date(Date.UTC(2026, 9, 7, h, 30));
    const at = reminderSendAt(now);
    const ahead = at.getTime() - now.getTime();
    assert.ok(ahead > 24 * 3600e3, `hour ${h}: at least a day ahead`);
    assert.ok(ahead <= REMINDER_MAX_AHEAD_MS, `hour ${h}: within Brevo's limit`);
    assert.equal(at.getUTCHours(), 9);
  }
});

async function run(body, shop) {
  const sends = [];
  const errors = [];
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => { fetched.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; };
  try {
    const res = await handleQuoteLead(
      { email: 'a@b.ie', cards: [card], totals: { market: 300, cash: 165, credit: 210 }, shop_slug: 'brewed', ...body },
      req,
      {
        supabaseClient: fakeSupabase(shop),
        brevoApiKey: 'test',
        sendEmail: async (to, subject, html, att, opts) => { sends.push({ to, subject, opts }); },
        captureException: (e) => errors.push(e),
      },
    );
    return { res, sends, fetched, errors };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const shop = { slug: 'brewed', name: 'Board & Brewed', email: 'shop@x.ie', brevo_list_ids: [32, 51], brevo_attributes: { SIGNUP_SOURCE: 'sell-cards' } };

test('no reminder tick: two emails, nothing scheduled', async () => {
  const { res, sends } = await run({}, shop);
  assert.equal(res.status, 200);
  assert.equal(sends.length, 2);
  assert.ok(sends.every((s) => !s.opts?.scheduledAt));
  assert.equal('reminder_scheduled' in res.body, false);
});

test('reminder tick: one extra email to the customer, scheduled', async () => {
  const { res, sends } = await run({ reminder: true }, shop);
  assert.equal(sends.length, 3);
  const rem = sends.find((s) => s.opts?.scheduledAt);
  assert.equal(rem.to, 'a@b.ie');
  assert.equal(res.body.reminder_scheduled, true);
});

test('reminder must be literally true (a string does not count as consent)', async () => {
  const { sends } = await run({ reminder: 'yes' }, shop);
  assert.equal(sends.length, 2);
});

test('opt-in goes to every configured list with the shop attributes', async () => {
  const { fetched, res } = await run({ newsletter: true, name: 'Ann' }, shop);
  const sub = fetched.find((f) => String(f.url).endsWith('/v3/contacts'));
  assert.deepEqual(sub.body.listIds, [32, 51]);
  assert.equal(sub.body.attributes.SIGNUP_SOURCE, 'sell-cards');
  assert.equal(sub.body.attributes.FIRSTNAME, 'Ann');
  assert.equal(res.body.subscribed, true);
});

test('opt-in with no list anywhere is reported, not swallowed', async () => {
  const saved = process.env.BREVO_NEWSLETTER_LIST_ID;
  delete process.env.BREVO_NEWSLETTER_LIST_ID;
  try {
    const { res, errors } = await run({ newsletter: true }, { slug: 'brewed', name: 'B', email: 's@x.ie' });
    assert.equal(res.body.subscribed, false);
    assert.ok(errors.some((e) => /no brevo list/.test(e.message)));
  } finally {
    if (saved !== undefined) process.env.BREVO_NEWSLETTER_LIST_ID = saved;
  }
});
