// tests/regression/identify-internals.spec.js
// Owner: A7 | Slice: S26 (final regression backfill)
//
// Pins the V2_AUDIT §5.10 invariant for the pricing engine's internal-key
// hygiene:
//
//   RG-21: stripInternals removes _refImagePromise + every other underscore-
//          prefixed key before client send. _refImagePromise is an in-flight
//          axios Promise<axios.Response<ArrayBuffer>>; if it leaks into
//          JSON.stringify the response either hangs, errors, or carries a
//          live Buffer reference the client will never resolve.
//
// We import the function directly from pricing/identify-core.js — it's the
// single source of truth — and exercise it against fixtures that mirror
// what verifyPokemon / verifyMagic / verifyGeneric actually produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripInternals } from '../../pricing/identify-core.js';

test('RG-21: stripInternals removes _refImagePromise + all underscore-prefixed keys', () => {
  // Verifier output mirrors apps/server/routes/identify.js's verified path.
  // _refImagePromise is the live axios Promise that maybeDoubleCheck reuses
  // (avoids a second image fetch). It MUST NOT survive into the response.
  const refImagePromise = Promise.resolve({ data: Buffer.from('REF-IMG') });
  const card = {
    name: 'Mega Venusaur ex',
    set_code: 'me1',
    card_number: '155',
    hp: '330',
    confidence_score: 240,
    image: 'https://images.pokemontcg.io/me1/155.png',
    _refImagePromise: refImagePromise,
    _verifyTraceId: 'abc123',
    _scoreBreakdown: { name: 100, hp: 50, set: 50, num: 40 },
  };

  const [out] = stripInternals([card]);

  // Public keys preserved verbatim.
  assert.equal(out.name, 'Mega Venusaur ex');
  assert.equal(out.set_code, 'me1');
  assert.equal(out.card_number, '155');
  assert.equal(out.hp, '330');
  assert.equal(out.confidence_score, 240);
  assert.equal(out.image, 'https://images.pokemontcg.io/me1/155.png');

  // Every underscore-prefixed key stripped.
  assert.equal(Object.keys(out).every(k => !k.startsWith('_')), true,
    'stripInternals must remove every underscore-prefixed key');
  assert.equal('_refImagePromise' in out, false, '_refImagePromise must be stripped');
  assert.equal('_verifyTraceId' in out, false, '_verifyTraceId must be stripped');
  assert.equal('_scoreBreakdown' in out, false, '_scoreBreakdown must be stripped');
});

test('RG-21b: stripInternals output is JSON.stringify-safe even when input had a live Promise', () => {
  // The V1 bug class: a Promise leaked into the response would either
  // break JSON.stringify (Promises serialize to {}) or, worse, get
  // resolved on the wire and freeze the response. We simulate the
  // dangerous input shape and assert the output is fully serialisable.
  const cards = [
    {
      name: 'Bulbasaur',
      _refImagePromise: new Promise(() => { /* never resolves */ }),
      _internalState: { live: true },
    },
    {
      name: 'Charmander',
      // No internals — should pass through unchanged shape-wise.
    },
  ];

  const stripped = stripInternals(cards);

  // No throw, finite-time stringify.
  const json = JSON.stringify(stripped);
  assert.ok(typeof json === 'string' && json.length > 0);

  // Roundtrip and confirm shape.
  const round = JSON.parse(json);
  assert.equal(round.length, 2);
  assert.equal(round[0].name, 'Bulbasaur');
  assert.equal('_refImagePromise' in round[0], false);
  assert.equal(round[1].name, 'Charmander');
});

test('RG-21c: stripInternals tolerates empty/null/non-array inputs without throwing', () => {
  // The function is wired into the streaming and non-streaming identify
  // paths. Defensive shape checks here keep the pipeline from crashing
  // the response stream when verify returns nothing.
  assert.deepEqual(stripInternals([]), []);
  assert.deepEqual(stripInternals(null), []);
  assert.deepEqual(stripInternals(undefined), []);

  // Non-object entries pass through unchanged (defensive — verify
  // shouldn't produce these but the production code still handles them).
  const out = stripInternals([null, 'not-a-card', 42, { name: 'Pikachu', _x: 1 }]);
  assert.equal(out.length, 4);
  assert.equal(out[0], null);
  assert.equal(out[1], 'not-a-card');
  assert.equal(out[2], 42);
  assert.equal(out[3].name, 'Pikachu');
  assert.equal('_x' in out[3], false);
});
