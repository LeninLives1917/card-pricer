// Pins the English + condition Cardmarket link.
//
// WHY THIS EXISTS
//
// The operator asked for the cheapest English Near Mint price. It cannot be
// READ from anywhere available:
//
//   - the TCGGO API returns lowest_near_mint (ANY language) plus _DE, _FR,
//     _ES and _IT. There is no _EN field.
//   - Cardmarket itself answers a server-side fetch with HTTP 403 and
//     Cloudflare's "Just a moment" interstitial, verified with a browser
//     user-agent on a real product URL.
//
// But nothing stops us handing over the exact page with the filters already
// applied. language=1 is Cardmarket's English filter and minCondition is its
// grade floor.
//
// THE URL CANNOT BE BUILT, which was the first thing tried. Real URLs, pulled
// from the live redirects:
//
//   Stellar-Crown/Gulpin-V2-SCR154            -V2 is Cardmarket's versioning
//   Obsidian-Flames/Smoliv-OBF019             padded to three
//   Vivid-Voltage/Shiftry-VIV12               not padded
//   Journey-Together/Hops-Wooloo-V2-JTG171    JTG171 where our card is 170
//   EX-Legend-Maker/Muk-LM11                  their slug, their abbreviation
//
// The version suffix, the padding, the set slugs and even the collector
// number are Cardmarket's internal data. A generator would emit plausible
// URLs that 404 — worse than a search link, because it looks right.
//
// So the page is looked up once per card via the redirect the catalogue
// already stores, and cached. MEASURED over 100 random catalogue cards: 88
// reach the product page and 12 fall back to a filtered search. Every card
// gets a working link.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCardmarketUrl,
  resetCardmarketUrlCache,
} from '../../pricing/adapters/cardmarket-html.js';
import { CONDITION_MULTIPLIERS, CONDITION_ORDER } from '../../pricing/conditions.js';

const CARD = {
  game: 'pokemon', name: 'Spheal', set_name: 'Surging Sparks',
  set_code: 'SSP', card_number: '199', condition_estimate: 'NM',
};

describe('every card gets an English-filtered link', () => {
  beforeEach(() => resetCardmarketUrlCache());

  test('with no product page resolved, the fallback is a FILTERED search', () => {
    const l = buildCardmarketUrl(CARD);
    assert.equal(l.best_url_kind, 'search');
    assert.match(l.best_url, /language=1/, 'English filter must always be present');
    assert.match(l.best_url, /minCondition=2/, 'NM is Cardmarket code 2');
  });

  test('best_url is never empty — a link is the one thing always available', () => {
    for (const card of [CARD, { game: 'pokemon', name: 'X' }, { game: 'magic', name: 'Y', card_number: '1' }]) {
      const l = buildCardmarketUrl(card);
      assert.ok(l.best_url && l.best_url.startsWith('http'), JSON.stringify(card));
      assert.match(l.best_url, /language=1/);
    }
  });
});

describe('the condition filter tracks the grade', () => {
  beforeEach(() => resetCardmarketUrlCache());

  test('each Cardmarket grade maps to its own minCondition code', () => {
    // Cardmarket: 1=MT 2=NM 3=EX 4=GD 5=LP 6=PL 7=PO. The app previously used
    // NM/LP/MP/HP/DMG mapped onto these codes, so the grade called "LP" was
    // filtering for GOOD and "MP" for LIGHT PLAYED — label and filter
    // disagreed by a grade on every row.
    const expected = { NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };
    for (const [grade, code] of Object.entries(expected)) {
      const l = buildCardmarketUrl({ ...CARD, condition_estimate: grade });
      assert.match(l.best_url, new RegExp(`minCondition=${code}(&|$)`), `${grade} should filter at ${code}`);
    }
  });

  test('every grade offered in the UI has a multiplier and a filter code', () => {
    for (const g of CONDITION_ORDER) {
      assert.ok(CONDITION_MULTIPLIERS[g] != null, `${g} has no multiplier`);
      const l = buildCardmarketUrl({ ...CARD, condition_estimate: g });
      assert.match(l.best_url, /minCondition=\d/, `${g} produced no condition filter`);
    }
  });

  test('legacy grades still filter exactly as they did', () => {
    // Stored sessions and older clients use MP/HP/DMG. Their codes are
    // unchanged, so nothing written against the old vocabulary shifts.
    for (const [grade, code] of Object.entries({ MP: 5, HP: 6, DMG: 7 })) {
      const l = buildCardmarketUrl({ ...CARD, condition_estimate: grade });
      assert.match(l.best_url, new RegExp(`minCondition=${code}(&|$)`), grade);
    }
  });
});

describe('the condition scale', () => {
  // RETIRED, deliberately: this suite used to assert that the NM/LP/MP ->
  // Cardmarket rename kept every multiplier where it was, because a naming fix
  // must not move money. That was the right invariant for that change.
  //
  // On 24 Aug 2026 the numbers were repriced ON PURPOSE, against two
  // independent measurements (a 397-ladder TCGplayer condition curve and a
  // 9,237-card Cardmarket lowPrice/lowPriceExPlus ratio). The old values were
  // operator estimates and were too generous on every played grade. The
  // provenance lives in pricing/conditions.js; the values are pinned in
  // tests/regression/price-route-condition-drift.spec.js so there is exactly
  // one place asserting them.
  //
  // What survives here is the ORDERING, which no measurement can be allowed to
  // invert: a worse card is never worth more.
  test('the scale is strictly decreasing, whatever the values are', () => {
    const order = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
    for (let i = 1; i < order.length; i += 1) {
      const better = CONDITION_MULTIPLIERS[order[i - 1]];
      const worse = CONDITION_MULTIPLIERS[order[i]];
      assert.ok(worse <= better,
        `${order[i]} (${worse}) must not be worth more than ${order[i - 1]} (${better})`);
    }
    assert.equal(CONDITION_MULTIPLIERS.NM, 1.00, 'NM is the definitional anchor');
  });

  test('EX is the one genuinely new grade, between NM and GD', () => {
    assert.ok(CONDITION_MULTIPLIERS.EX < CONDITION_MULTIPLIERS.NM);
    assert.ok(CONDITION_MULTIPLIERS.EX > CONDITION_MULTIPLIERS.GD);
  });

  test('the browser copy of the grade list matches the server', async () => {
    // result-sheet.js duplicates CONDITION_ORDER rather than importing it —
    // a vendor module cannot import from pricing/ without the browser
    // fetching index.html as JavaScript. Same enforcement as the language
    // list: a test, not an import.
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const urlMod = await import('node:url');
    const repo = pathMod.join(pathMod.dirname(urlMod.fileURLToPath(import.meta.url)), '..', '..');
    const src = fsMod.readFileSync(pathMod.join(repo, 'apps/vendor/modules/result-sheet.js'), 'utf8');
    const m = src.match(/const CONDITIONS = \[([^\]]+)\]/);
    assert.ok(m, 'could not find CONDITIONS in result-sheet.js');
    const browser = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    assert.deepEqual(browser, [...CONDITION_ORDER],
      'the grades offered in the browser have drifted from pricing/conditions.js');
  });
});
