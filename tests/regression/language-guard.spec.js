// Pins the Japanese/Korean/Chinese abstain.
//
// WHY THIS EXISTS
//
// data/card-db.json is 174 sets from pokemontcg.io. Not one of them is
// Japanese, Korean or Chinese. Those are different cards — different sets,
// different numbering, different set sizes — so matching one against this
// catalogue is a category error, not a near miss.
//
// It does not fail loudly. manualIdentifyCore's last-resort query is
// `name:"N" number:X`, which is SET-AGNOSTIC, and identify.js then takes the
// first hit as `verified: true`.
//
// MEASURED collision surface: across the 40 most-reprinted Pokemon at
// collector numbers 1-100 — the range Japanese sets occupy — 909 of 4,000
// (name, number) combinations also exist in the English catalogue, 22.7%. So
// roughly one in four Japanese cards would come back as a confident English
// card, priced in English. Cardmarket prices the two separately and by wide
// margins.
//
// European languages are deliberately NOT blocked: same cards, same set codes,
// same collector numbers. Only the printed text differs. (Their prices differ
// too and no adapter accounts for that — a separate, still-open gap.)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isUnsupportedLang,
  SUPPORTED_LANGS,
  DIFFERENT_CARD_LANGS,
} from '../../pricing/languages.js';
import { parseTextEntryLine } from '../../apps/vendor/modules/text-parse.js';

describe('language support policy', () => {
  test('the languages that are DIFFERENT CARDS are rejected', () => {
    for (const l of ['jp', 'ja', 'ko', 'zh']) {
      assert.equal(isUnsupportedLang(l), true, `${l} must not resolve against an English catalogue`);
    }
  });

  test('European printings are accepted — they are the same cards', () => {
    for (const l of ['en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'nl']) {
      assert.equal(isUnsupportedLang(l), false, `${l} shares set codes and numbering with English`);
    }
  });

  test('an absent language is NOT a claim, and must not be rejected', () => {
    // Most lines say nothing about language. Treating silence as unsupported
    // would reject almost every line the operator types.
    for (const v of [null, undefined, '']) {
      assert.equal(isUnsupportedLang(v), false);
    }
  });

  test('case and whitespace do not defeat the guard', () => {
    for (const v of ['JP', ' ja ', 'ZH', 'Ko']) {
      assert.equal(isUnsupportedLang(v), true, `${JSON.stringify(v)} must still be caught`);
    }
  });

  test('an unknown token is treated as unsupported, not waved through', () => {
    // Fail closed. A language we have never heard of is not one we can price.
    assert.equal(isUnsupportedLang('xx'), true);
  });

  test('the two sets do not overlap', () => {
    const both = [...DIFFERENT_CARD_LANGS].filter((l) => SUPPORTED_LANGS.has(l));
    assert.deepEqual(both, [], 'a language cannot be both supported and a different card');
  });
});

describe('the parser feeds the guard', () => {
  test('a Japanese line is parsed with its language token intact', () => {
    // The token has been extracted since the first version of this parser and
    // then dropped on the floor by scan.js. The guard is only reachable
    // because the line now carries it through.
    const got = parseTextEntryLine('Charizard sv1a jp 067/071');
    assert.equal(got.lang, 'jp');
    assert.equal(isUnsupportedLang(got.lang), true);
  });

  test('an English line passes the guard', () => {
    const got = parseTextEntryLine('Mystery Garden meg en 172/132');
    assert.equal(got.lang, 'en');
    assert.equal(isUnsupportedLang(got.lang), false);
  });

  test('a line with no language token passes the guard', () => {
    const got = parseTextEntryLine('Pikachu MEG 172/132');
    assert.equal(got.lang, undefined);
    assert.equal(isUnsupportedLang(got.lang), false);
  });
});
