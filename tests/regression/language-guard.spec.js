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

describe('the browser copy and the server copy agree', () => {
  test('the two SUPPORTED_LANGS sets are identical', async () => {
    // apps/vendor/modules/text-parse.js duplicates this list rather than
    // importing it. That is deliberate: vendor modules are served from
    // /modules/, so `../../../pricing/languages.js` resolves to a path
    // express.static does not serve, falls through to the SPA handler, and
    // comes back as index.html with HTTP 200 and Content-Type text/html. The
    // browser parses `<!DOCTYPE html>` as JavaScript, the module graph dies,
    // and the whole dashboard stops responding to clicks — silently, because
    // a 200 with the wrong content type is not a 404 anyone notices.
    //
    // So the single source of truth is enforced HERE instead of by an import.
    // If this fails, the two lists have drifted and the browser is applying a
    // different policy from the server.
    const server = await import('../../pricing/languages.js');
    const browser = await import('../../apps/vendor/modules/text-parse.js');
    assert.deepEqual(
      [...browser.SUPPORTED_LANGS].sort(),
      [...server.SUPPORTED_LANGS].sort(),
      'the browser and server language lists have drifted',
    );
  });

  test('both agree on the languages that are different cards', async () => {
    const server = await import('../../pricing/languages.js');
    const browser = await import('../../apps/vendor/modules/text-parse.js');
    for (const l of ['jp', 'ja', 'ko', 'zh', 'en', 'de', 'xx', '', null]) {
      assert.equal(
        browser.isUnsupportedLang(l), server.isUnsupportedLang(l),
        `browser and server disagree on ${JSON.stringify(l)}`,
      );
    }
  });

  test('NO vendor module reaches outside its served root', async () => {
    // The general form of the bug. Anything importing ../../../ from
    // apps/vendor/modules or apps/quote/modules resolves, in a browser, to a
    // path the static mounts do not cover.
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const urlMod = await import('node:url');
    const repo = pathMod.join(pathMod.dirname(urlMod.fileURLToPath(import.meta.url)), '..', '..');

    const offenders = [];
    const walk = (dir) => {
      for (const e of fsMod.readdirSync(dir, { withFileTypes: true })) {
        const p = pathMod.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = fsMod.readFileSync(p, 'utf8');
        // Ignore the explanatory comment in text-parse.js by requiring the
        // specifier to sit in a real import/export statement.
        const rx = /^\s*(?:import|export)[^\n]*from\s+['"]\.\.\/\.\.\/\.\.\//gm;
        if (rx.test(src)) offenders.push(pathMod.relative(repo, p));
      }
    };
    for (const root of ['apps/vendor/modules', 'apps/quote/modules']) {
      const full = pathMod.join(repo, root);
      if (fsMod.existsSync(full)) walk(full);
    }
    assert.deepEqual(offenders, [],
      'these browser modules import a path the server does not serve; in a browser '
      + 'they receive index.html with HTTP 200 and the whole app stops working');
  });
});
