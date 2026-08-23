// Pins the /api/identify-manual response envelope while the typed path grows
// a resolution block underneath it.
//
// WHY THIS EXISTS
//
// Three callers read this route and ALL of them do `cards[0]`:
//   apps/vendor/modules/tabs/scan.js:208
//   apps/vendor/modules/tabs/scan.js:377   (the manual-entry modal)
//   apps/quote/modules/lookup.js:80        (customer-facing)
//
// The new local resolver can answer "which one?" instead of "here it is", and
// that answer has to travel without breaking any of them. The shape chosen is
// HTTP 200, `cards: []`, candidates in `resolution` — because every one of
// those callers already tests `!cards.length` and renders an error row. They
// degrade to "couldn't price it", never to a wrong price, with no change in
// either file.
//
// A 404 would NOT have been safe: apps/quote/modules/lookup.js:72 checks
// `!resp.ok` first and would surface an HTTP message instead of the question.
// /api/lookup-by-number's 404-on-ambiguity is the precedent not to repeat.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = join(REPO, 'data', 'card-db.json');

let call;
before(async () => {
  assert.ok(fs.existsSync(DB_PATH),
    'data/card-db.json is required — it is untracked and lives on the Render disk. '
    + 'Build it with `node scripts/build-phash-db.js`. Not skipped: the envelope '
    + 'this pins only takes its interesting shapes against the real catalogue.');

  const { CARD_DB } = await import('../../apps/server/_card-db-boot.js');
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  for (const [k, v] of Object.entries(db)) CARD_DB.set(k, v);

  const mod = await import('../../apps/server/routes/identify.js');
  const layer = mod.default.stack.find((l) => l.route?.path === '/api/identify-manual');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  call = (body) => new Promise((resolve) => {
    const req = { body, user: { id: 't' }, ip: '127.0.0.1', get: () => 'localhost', protocol: 'http' };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); },
    };
    Promise.resolve(handler(req, res, () => {})).catch((e) => resolve({ status: 500, body: { error: e.message } }));
  });
});

describe('back-compat: cards[0] keeps its meaning', () => {
  test('a resolved card comes back in cards[0] with the legacy key set', async () => {
    const r = await call({ game: 'pokemon', text: 'cha 4/102' });
    assert.equal(r.status, 200);
    const c = r.body.cards[0];
    for (const k of ['game', 'name', 'set_name', 'set_code', 'card_number', 'verified', 'db_source']) {
      assert.ok(k in c, `legacy key ${k} is missing from the card`);
    }
    assert.equal(c.name, 'Charizard');
    assert.equal(c.game, 'pokemon');
  });

  test('AMBIGUOUS: 200 with an empty cards array, candidates beside it', async () => {
    const r = await call({ game: 'pokemon', text: 'bla 2/132' });
    assert.equal(r.status, 200, 'must NOT be a 404 — quote/lookup.js:72 checks !resp.ok first');
    assert.deepEqual(r.body.cards, []);
    assert.equal(r.body.resolution.status, 'ambiguous');
    assert.ok(r.body.resolution.candidates.length > 1);
  });

  test("every existing caller's own predicate still behaves", async () => {
    const r = await call({ game: 'pokemon', text: 'bla 2/132' });
    // scan.js:203 and quote/lookup.js:78, verbatim.
    assert.equal(!r.body?.cards?.length, true, 'scan.js falls into its no-match branch');
    assert.equal(r.body.cards.length === 0, true, 'quote/lookup.js falls into its no-match branch');
    // Neither can accidentally read a card, which is the whole point.
    assert.equal(r.body.cards[0], undefined);
  });

  test('resolution is ABSENT when the legacy path answered, so nothing changes shape', async () => {
    // No `text`, no local resolution — the old structured ladder. The response
    // must look exactly as it always has.
    const r = await call({ game: 'pokemon', set_code: 'ZZZZ', card_number: '999999' });
    if (r.body.cards) assert.equal(r.body.resolution, undefined);
  });
});

describe('the raw-line path', () => {
  test('the show format resolves', async () => {
    const r = await call({ game: 'pokemon', text: 'cha 4/102' });
    assert.equal(r.body.cards[0].name, 'Charizard');
    assert.equal(r.body.resolution.shape, 'name_only');
    assert.equal(r.body.resolution.name_match, 'prefix');
  });

  test('the "ex" trap resolves to the incident card', async () => {
    const r = await call({ game: 'pokemon', text: 'Charizard ex 056/197' });
    assert.equal(r.body.cards[0].name, 'Charizard ex');
    assert.match(r.body.cards[0].set_name, /Black Star Promos/);
  });

  test('a real set code still beats a name prefix', async () => {
    const r = await call({ game: 'pokemon', text: 'MEG 172/132' });
    assert.equal(r.body.cards[0].name, 'Mystery Garden');
  });

  test('quantity, condition and finish reach the caller', async () => {
    const r = await call({ game: 'pokemon', text: '3x Charizard ex 056/197 nm reverse' });
    const i = r.body.resolution.interpretation;
    assert.equal(i.qty, 3);
    assert.equal(i.condition, 'NM');
    assert.equal(i.finish, 'reverse_holo');
  });

  test('a Japanese line is refused with 422, not answered in English', async () => {
    const r = await call({ game: 'pokemon', text: 'Charizard sv1a jp 067/071' });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /not supported/i);
  });

  test('the legacy set-code shape still works through the same route', async () => {
    const r = await call({ game: 'pokemon', text: 'PFL 94' });
    assert.equal(r.body.cards[0].name, 'Wondrous Patch');
  });
});
