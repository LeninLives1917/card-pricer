// Regression: show mode, the trade-show QR quote (apps/server/routes/show.js).
//
// WHY THIS EXISTS (9 Oct 2026): Dave asked for a show version of the customer
// quote: customers scan a QR on the stand, type their cards on their own
// phone, and are told to go to the counter for the offer. "The values only
// show up on the back end." So the one thing that must never break is that
// NOTHING the customer's phone receives carries a price, an offer or a hint of
// value. These tests price real rows (handleQuoteBatch on a fixture feed, the
// same engine the website uses) and check every customer-facing body for
// money, by key and by value. customerView() is an allow-list; the last test
// checks that a field added to the rows later still cannot leak.
//
// Also pinned: a list saved without prices is counted (the customer is sent to
// the counter either way, so nothing on their side would show it), staff are
// the shop owner or an admin and nobody else, and condition / which-card
// answers set at the counter reprice the line.
//
// DI throughout (handleShowSubmit(slug, body, req, deps) etc.); no mock.module().

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleQuoteBatch } from '../../apps/server/routes/quote-batch.js';
import {
  handleShowSubmit, handleShowTicket, handleStaffList, handleStaffItem,
  handleStaffUpdate, handleStaffReprice,
} from '../../apps/server/routes/show.js';
import { customerView, staffEntries, staffTotals, showLinesOf } from '../../pricing/show/offer.js';
import { getShowCounts, resetShowCounts } from '../../infra/observability/show-counters.js';
import { showCheck } from '../../apps/server/routes/health.js';
import { buildPriceIndex } from '../../pricing/quote-prices/feed-index.js';
import { loadSets } from '../../pricing/set-resolve.js';

const NOW = Date.parse('2026-10-09T10:00:00Z');
const OWNER = { id: 'owner-1' };
const ADMIN = { id: 'admin-1' };
const STRANGER = { id: 'someone-else' };
const SHOP = { id: 'shop-1', slug: 'brewed', name: 'Board And Brewed', owner_user_id: OWNER.id, cash_pct: 55, credit_pct: 70, active: true };

const cardDb = () => new Map([
  ['base1-4', { name: 'Charizard', setName: 'Base' }],
  ['cel25c-4', { name: 'Charizard', setName: 'Celebrations: Classic Collection' }],
  ['base1-6', { name: 'Gyarados', setName: 'Base' }],
  ['swsh7-215', { name: 'Umbreon VMAX', setName: 'Evolving Skies' }],
]);
const row = (set, local, name, id, trend, o = {}) => [
  set, local, name, id, trend, trend, trend, trend, trend / 4,
  null, null, null, null, null, !!o.firstEd, false,
];
const FEED = {
  snapshot_date: '2026-10-09',
  cache_built_at: '2026-10-09T09:20:00Z',
  sets: [
    ['base1', 'Base Set', 'BS', 102, 102, '1999-01-09'],
    ['cel25cc', 'Celebrations Classic Collection', 'CEL:CC', 25, 25, '2021-10-08'],
    ['swsh7', 'Evolving Skies', 'EVS', 203, 237, '2021-08-27'],
  ],
  cards: [
    row('base1', '4', 'Charizard', 273699, 569.73),
    row('cel25cc', 'CC002', 'Charizard', 1002, 213.52),
    row('base1', '6', 'Gyarados', 1007, 150),
    row('swsh7', '215', 'Umbreon VMAX', 574273, 2026.85),
  ],
};
const PRICES = ['569.73', '213.52', '150', '2026.85', '2,026', '1418', '1418.8', '1114', '82.5', '105'];

function quoteFn() {
  const db = cardDb();
  const index = buildPriceIndex(FEED, db, loadSets(), []);
  return (body) => handleQuoteBatch(body, { cardDb: db, priceIndex: index, now: NOW });
}

/** A small in-memory stand-in for the supabase-js query builder. */
function fakeDb({ shops = [SHOP], profiles = [{ user_id: ADMIN.id, is_admin: true }] } = {}) {
  const tables = { shops, profiles, show_submissions: [] };
  let ticket = 100;
  function q(name) {
    let rows = tables[name];
    let filters = [];
    let op = 'select', payload = null, countHead = false, order = null, limit = null;
    const apply = () => rows.filter((r) => filters.every(([k, v]) => r[k] === v));
    const api = {
      select(_cols, opts) { if (opts?.head) countHead = true; return api; },
      insert(obj) {
        op = 'insert';
        payload = { id: `00000000-0000-0000-0000-${String(++ticket).padStart(12, '0')}`, ticket, picks: {}, conditions: {}, status: 'waiting', outcome: null, done_at: null, created_at: new Date(NOW).toISOString(), ...obj };
        return api;
      },
      update(obj) { op = 'update'; payload = obj; return api; },
      eq(k, v) { filters.push([k, v]); return api; },
      order(k, o) { order = [k, o?.ascending !== false]; return api; },
      limit(n) { limit = n; return api; },
      async maybeSingle() { return { data: apply()[0] || null, error: null }; },
      async single() {
        if (op === 'insert') { tables[name].push(payload); return { data: payload, error: null }; }
        if (op === 'update') {
          const hit = apply()[0];
          if (!hit) return { data: null, error: { message: 'no row' } };
          Object.assign(hit, payload);
          return { data: hit, error: null };
        }
        return { data: apply()[0] || null, error: null };
      },
      then(resolve) {
        let out = apply();
        if (countHead) return resolve({ count: out.length, error: null });
        if (order) out = [...out].sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : 1) * (order[1] ? 1 : -1));
        if (limit) out = out.slice(0, limit);
        return resolve({ data: out, error: null });
      },
    };
    return api;
  }
  return { from: q, tables };
}

const LIST = ['Charizard 4/102', '3x Gyarados 6/102 lp', 'Umbreon VMAX 215/203', 'Charzard'];

async function submit(db, body = {}, deps = {}) {
  return handleShowSubmit('brewed', { name: 'Sam', lines: LIST, ...body }, { ip: '1.2.3.4' }, { supabaseClient: db, quote: quoteFn(), ...deps });
}

/** Every key path and every scalar in a JSON body. */
function walk(v, path = '', out = []) {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, out);
  else out.push([path, v]);
  return out;
}
function assertNoMoney(body, where) {
  for (const [path, v] of walk(body)) {
    assert.doesNotMatch(path, /price|market|cash|credit|value|offer|total|reason|candidates/i, `${where}: ${path} must not reach the customer`);
    const s = String(v);
    for (const p of PRICES) assert.ok(!s.includes(p) || /^\d{4}-\d{2}-\d{2}T/.test(s) || path.endsWith('.ticket') || path.endsWith('.token'), `${where}: ${path}=${s} looks like a price`);
    assert.doesNotMatch(s, /€|EUR/, `${where}: ${path}`);
  }
}

test('the customer gets a ticket and their lines, and not one price', async () => {
  const db = fakeDb();
  const r = await submit(db);
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Sam');
  assert.equal(typeof r.body.ticket, 'number');
  assert.match(r.body.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.body.lines.map((l) => l.status), ['check', 'matched', 'matched', 'unmatched'],
    'Charizard 4/102 is asked (reprint), Gyarados and Umbreon matched, the typo not');
  assert.equal(r.body.lines[1].card.name, 'Gyarados');
  assertNoMoney(r.body, 'submit');

  // ...and the prices are stored for staff.
  const saved = db.tables.show_submissions[0];
  assert.equal(saved.rows.find((x) => x.card?.id === 'base1-6').price.market, 150);
  assert.equal(saved.price_error, null);
});

test('the ticket page later gets the same, still with no prices', async () => {
  const db = fakeDb();
  const r = await submit(db);
  const t = await handleShowTicket(r.body.token, { supabaseClient: db });
  assert.equal(t.status, 200);
  assert.equal(t.body.ticket, r.body.ticket);
  assertNoMoney(t.body, 'ticket');
  assert.equal((await handleShowTicket('nope', { supabaseClient: db })).status, 404);
});

test('customerView is an allow-list: a field added to the rows later cannot leak', () => {
  const rows = [{ line: 'x', qty: 1, status: 'priced', card: { name: 'X', set_name: 'S', card_number: '1', id: 'a-1', secret: 999 }, price: { market: 999 }, new_field: { value: 999 } }];
  const v = customerView(rows);
  assert.deepEqual(v, [{ line: 'x', qty: 1, status: 'matched', card: { name: 'X', set_name: 'S', card_number: '1' } }]);
});

test('bad input is refused with words a customer understands', async () => {
  const db = fakeDb();
  assert.equal((await submit(db, { name: '  ' })).status, 400);
  assert.equal((await submit(db, { lines: ['', '# note'] })).status, 400);
  assert.equal((await submit(db, { email: 'not-an-email' })).status, 400);
  const other = await handleShowSubmit('nope', { name: 'Sam', lines: LIST }, {}, { supabaseClient: db, quote: quoteFn() });
  assert.equal(other.status, 404);
  assert.equal(db.tables.show_submissions.length, 0, 'nothing saved');
  assert.equal(showLinesOf(Array.from({ length: 500 }, (_, i) => `Card ${i}`)).length, 300);
});

test('a list that could not be priced is still saved, the customer still goes to the counter, and it is COUNTED', async () => {
  resetShowCounts();
  const db = fakeDb();
  const r = await submit(db, {}, { quote: async () => { throw new Error('catalogue loading'); } });
  assert.equal(r.status, 200, 'the customer is not turned away');
  assert.deepEqual(r.body.lines.map((l) => l.status), ['check', 'check', 'check', 'check']);
  const saved = db.tables.show_submissions[0];
  assert.equal(saved.rows, null);
  assert.equal(saved.price_error, 'catalogue loading');

  await submit(db);
  const c = getShowCounts();
  assert.equal(c.submitted, 2);
  assert.equal(c.unpriced_on_submit, 1);
  assert.equal(c.priced_ratio, 0.5);
  assert.match(showCheck(c).detail, /1 saved without prices/);

  resetShowCounts();
  assert.equal(getShowCounts().priced_ratio, null, 'null = nobody has submitted, not 0%');
});

test('staff: the shop owner and admins only', async () => {
  const db = fakeDb();
  await submit(db);
  assert.equal((await handleStaffList('brewed', {}, STRANGER, { supabaseClient: db })).status, 403);
  assert.equal((await handleStaffList('brewed', {}, OWNER, { supabaseClient: db })).status, 200);
  assert.equal((await handleStaffList('brewed', {}, ADMIN, { supabaseClient: db })).status, 200);
  assert.equal((await handleStaffList('brewed', {}, null, { supabaseClient: db })).status, 404);
});

test('staff see the priced list, and condition and which-card answers reprice it', async () => {
  const db = fakeDb();
  await submit(db);
  const list = await handleStaffList('brewed', {}, OWNER, { supabaseClient: db });
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.waiting, 1);
  const id = list.body.items[0].id;

  let it = (await handleStaffItem('brewed', id, OWNER, { supabaseClient: db })).body;
  // Umbreon 2026.85 NM; Gyarados 150 x LP 0.58 x 3; Charizard asked; typo not found.
  assert.equal(it.totals.cards, 4);
  assert.equal(it.totals.questions, 1);
  assert.equal(it.totals.not_found, 1);
  const gyara = it.entries.find((e) => e.card?.id === 'base1-6');
  assert.equal(gyara.condition, 'LP');
  assert.equal(gyara.credit, Math.round(150 * 0.58 * 0.7 * 100) / 100 * 3);

  // The card in hand is Played, and the Charizard is the Celebrations reprint.
  const umbIdx = it.entries.find((e) => e.card?.id === 'swsh7-215').index;
  const askIdx = it.entries.find((e) => e.kind === 'ask').index;
  const cel = it.entries[askIdx].candidates.findIndex((c) => c.card.id === 'cel25c-4');
  it = (await handleStaffUpdate('brewed', id, { conditions: { [umbIdx]: 'PL' }, picks: { [askIdx]: cel } }, OWNER, { supabaseClient: db })).body;
  const umb = it.entries[umbIdx];
  assert.equal(umb.condition, 'PL');
  assert.equal(umb.credit, Math.round(2026.85 * 0.40 * 0.70 * 100) / 100);
  assert.equal(it.entries[askIdx].kind, 'priced');
  assert.equal(it.entries[askIdx].card.id, 'cel25c-4');
  assert.equal(it.totals.questions, 0);

  // Change of mind: the answer comes off again, and nonsense is ignored.
  it = (await handleStaffUpdate('brewed', id, { picks: { [askIdx]: null }, conditions: { 0: 'XX', 99: 'NM' } }, OWNER, { supabaseClient: db })).body;
  assert.equal(it.entries[askIdx].kind, 'ask');

  // Done, then back.
  it = (await handleStaffUpdate('brewed', id, { status: 'done', outcome: 'bought' }, OWNER, { supabaseClient: db })).body;
  assert.equal(it.status, 'done');
  assert.equal(it.outcome, 'bought');
  assert.equal((await handleStaffList('brewed', {}, OWNER, { supabaseClient: db })).body.items.length, 0);
  assert.equal((await handleStaffList('brewed', { status: 'done' }, OWNER, { supabaseClient: db })).body.items.length, 1);
  it = (await handleStaffUpdate('brewed', id, { status: 'waiting' }, OWNER, { supabaseClient: db })).body;
  assert.equal(it.status, 'waiting');
  assert.equal(it.outcome, null);
});

test('reprice fills in a list saved without prices', async () => {
  const db = fakeDb();
  await submit(db, {}, { quote: async () => ({ status: 503, body: { error: 'The card catalogue is still loading.' } }) });
  const id = db.tables.show_submissions[0].id;
  let it = (await handleStaffItem('brewed', id, OWNER, { supabaseClient: db })).body;
  assert.match(it.price_error, /still loading/);
  assert.equal(it.totals.cards, 0);
  it = (await handleStaffReprice('brewed', id, OWNER, { supabaseClient: db, quote: quoteFn() })).body;
  assert.equal(it.price_error, null);
  assert.equal(it.totals.cards, 4);
});

test('staffTotals adds up only what is priced', () => {
  const t = staffTotals([
    { kind: 'priced', qty: 2, market: 10, cash: 5.5, credit: 7 },
    { kind: 'by_hand' }, { kind: 'ask' }, { kind: 'not_found' },
  ]);
  assert.deepEqual(t, { cards: 2, market: 10, cash: 5.5, credit: 7, by_hand: 1, questions: 1, not_found: 1 });
  assert.deepEqual(staffEntries(null), []);
});
