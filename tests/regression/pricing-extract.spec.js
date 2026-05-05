// tests/regression/pricing-extract.spec.js
//
// Owner: A2 / S6 (handed to A7 in S26 for full fixture coverage).
//
// Smoke-tests the S6 pricing-engine extraction. Verifies:
//   - public surface of pricing/* loads as ESM
//   - default-export adapters conform to PricingAdapter (name, supports,
//     isAvailable, optional verify/price)
//   - SCORE_WEIGHTS + tunables are present and sane
//   - scoreCandidate is a pure function of (card, isPromo, d, weights)
//
// NOT a behaviour-pinning suite — those land in
// tests/regression/verify-pokemon.spec.js + pricing-fanout.spec.js (A7's
// follow-up work in S26).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RACE_THRESHOLD,
  RACE_GRACE_MS,
  MIN_ACCEPT_SCORE,
  HP_MISMATCH_TOLERANCE,
  DOUBLE_CHECK_SCORE_GATE,
  SCORE_WEIGHTS,
  IDENT_MODEL,
} from '../../pricing/confidence.js';
import { CONDITION_MULTIPLIERS, applyCondition } from '../../pricing/conditions.js';
import { POKELLECTOR_CORRECTIONS, POKEMONTCG_UNRELIABLE, REG_MARK_ERAS } from '../../pricing/corrections.js';
import { PKM_SET_ALIASES, PKM_SET_NAMES, TCGDEX_SET_MAP, CM_SET_SLUGS, resolveSetCode } from '../../pricing/set-aliases.js';
import { verifyCard, verifyIdentified } from '../../pricing/verify.js';
import { priceCard, priceCacheKey, scoreHotness } from '../../pricing/price.js';
import { stripInternals, fixPokemonSuffix, extractPokemonSuffix } from '../../pricing/identify-core.js';
import { scoreCandidate } from '../../pricing/adapters/pokemontcg.js';

import pokemontcg from '../../pricing/adapters/pokemontcg.js';
import scryfall   from '../../pricing/adapters/scryfall.js';
import justtcg    from '../../pricing/adapters/justtcg.js';
import tcggo      from '../../pricing/adapters/tcggo-rapidapi.js';
import ebay       from '../../pricing/adapters/ebay-sold.js';
import cm         from '../../pricing/adapters/cardmarket-html.js';
import tcgdex     from '../../pricing/adapters/tcgdex.js';
import swu        from '../../pricing/adapters/swu-db.js';
import ygo        from '../../pricing/adapters/ygoprodeck.js';
import lorcana    from '../../pricing/adapters/lorcana.js';

test('confidence tunables match V1', () => {
  assert.equal(RACE_THRESHOLD, 220);
  assert.equal(RACE_GRACE_MS, 150);
  assert.equal(MIN_ACCEPT_SCORE, 120);
  assert.equal(HP_MISMATCH_TOLERANCE, 20);
  assert.equal(DOUBLE_CHECK_SCORE_GATE, 200);
  assert.equal(IDENT_MODEL, 'claude-sonnet-4-6');
});

test('SCORE_WEIGHTS hoisted from inline scoreCandidate', () => {
  // The hoist is a behaviour-preserving refactor — assert the V1 values.
  assert.equal(SCORE_WEIGHTS.NAME_EXACT, 50);
  assert.equal(SCORE_WEIGHTS.NUMBER_EXACT, 80);
  assert.equal(SCORE_WEIGHTS.SET_TOTAL_EXACT, 50);
  assert.equal(SCORE_WEIGHTS.SUFFIX_MISMATCH, -50);
  assert.equal(SCORE_WEIGHTS.REG_MARK_ERA_FAIL, -100);
});

test('CONDITION_MULTIPLIERS + applyCondition skips graded', () => {
  assert.equal(CONDITION_MULTIPLIERS.NM, 1.0);
  assert.equal(CONDITION_MULTIPLIERS.HP, 0.5);

  // graded skips the multiplier entirely — V2_AUDIT §2.
  assert.equal(applyCondition(100, 'HP', false).price, 50);
  assert.equal(applyCondition(100, 'HP', true).price, 100);
  // Graded multiplier reads as 1.0 even when condition would penalise.
  assert.equal(applyCondition(100, 'HP', true).multiplier, 1.0);
});

test('POKELLECTOR + UNRELIABLE + REG_MARK tables intact', () => {
  // RG-28 anchor: ME1 #155 must be Mega Venusaur ex.
  assert.equal(POKELLECTOR_CORRECTIONS.me1.cards[155], 'Mega Venusaur ex');
  assert.ok(POKEMONTCG_UNRELIABLE.has('me1'));
  assert.ok(POKEMONTCG_UNRELIABLE.has('mep'));
  assert.equal(REG_MARK_ERAS.G.prefix, 'sv');
});

test('set-aliases resolveSetCode + tables present', () => {
  assert.equal(PKM_SET_ALIASES.SSP, 'sv8');
  assert.equal(PKM_SET_ALIASES.MEG, 'me1');
  assert.equal(PKM_SET_NAMES.sv8, 'Surging Sparks');
  assert.equal(TCGDEX_SET_MAP.sv1, 'sv01');
  assert.equal(CM_SET_SLUGS.sv8, 'Surging-Sparks');

  const r = resolveSetCode('SSP');
  assert.equal(r.setId, 'sv8');
  assert.equal(r.aliased, true);
});

test('verifyCard + verifyIdentified + priceCard are async fns', () => {
  assert.equal(typeof verifyCard, 'function');
  assert.equal(verifyCard.constructor.name, 'AsyncFunction');
  assert.equal(typeof verifyIdentified, 'function');
  assert.equal(verifyIdentified.constructor.name, 'AsyncFunction');
  assert.equal(typeof priceCard, 'function');
  assert.equal(priceCard.constructor.name, 'AsyncFunction');
});

test('priceCacheKey + scoreHotness are pure helpers', () => {
  const key = priceCacheKey({ game: 'pokemon', name: 'Charizard ex', set_code: 'SSP', card_number: '199', condition_estimate: 'NM', variant: 'normal' }, 0.6);
  assert.equal(key, 'pokemon|charizard ex|SSP|199|NM|normal||0.6');

  const h = scoreHotness({}, { name: 'X' }, 5);
  assert.ok(typeof h.score === 'number' && h.score >= 0 && h.score <= 100);
  assert.ok(['hot', 'warm', 'steady', 'slow'].includes(h.label));
});

test('stripInternals removes _-prefixed fields', () => {
  const out = stripInternals([{ name: 'X', _refImagePromise: Promise.resolve(), keep: 1 }]);
  assert.equal(out[0]._refImagePromise, undefined);
  assert.equal(out[0].name, 'X');
  assert.equal(out[0].keep, 1);
});

test('extractPokemonSuffix + fixPokemonSuffix wired up', () => {
  assert.equal(extractPokemonSuffix('Charizard ex'), 'ex');
  assert.equal(extractPokemonSuffix('Charizard GX'), 'GX');
  assert.equal(extractPokemonSuffix('Boss Energy'), null);

  // GX with HP 340 → ex (HP rules out GX).
  const fixed = fixPokemonSuffix({ game: 'pokemon', name: 'Charizard GX', hp: '340' });
  assert.equal(fixed.name, 'Charizard ex');
});

test('scoreCandidate is pure: weights override changes output', () => {
  const card = { name: 'Bulbasaur', card_number: '94', regulation_mark: null };
  const dbRow = { name: 'Bulbasaur', number: '94', set: { id: 'me1', name: 'Mega Evolution' } };
  const a = scoreCandidate(card, false, dbRow);
  const b = scoreCandidate(card, false, dbRow, { ...SCORE_WEIGHTS, NAME_EXACT: 0, NUMBER_EXACT: 0 });
  assert.ok(a > b, 'default weights should score higher than zeroed weights');
});

test('adapter default exports conform to PricingAdapter', () => {
  for (const a of [pokemontcg, scryfall, justtcg, tcggo, ebay, cm, tcgdex, swu, ygo, lorcana]) {
    assert.equal(typeof a.name, 'string', `${a?.name || 'adapter'} missing name`);
    assert.ok(a.supports && Array.isArray(a.supports.games), `${a.name} missing supports.games`);
    assert.ok(Array.isArray(a.supports.needs), `${a.name} missing supports.needs`);
    assert.equal(typeof a.isAvailable, 'function', `${a.name} missing isAvailable`);
    if (a.verify) assert.equal(typeof a.verify, 'function');
    if (a.price) assert.equal(typeof a.price, 'function');
  }
});

test('static priority list — adapter names are the documented set', () => {
  const names = [pokemontcg.name, scryfall.name, justtcg.name, tcggo.name, ebay.name, cm.name].sort();
  assert.deepEqual(
    names,
    ['cardmarket-html', 'ebay-sold', 'justtcg', 'pokemontcg.io', 'scryfall', 'tcggo-rapidapi'].sort()
  );
});
