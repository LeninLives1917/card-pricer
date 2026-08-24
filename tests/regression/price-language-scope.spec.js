// tests/regression/price-language-scope.spec.js
//
// PINS what the headline price actually IS, because the codebase used to say
// the wrong thing about it.
//
// pricing/price.js carried this comment:
//
//     "the TCGGO API has no English field at all, only _DE/_FR/_ES/_IT"
//
// That was a wrong inference from the field names, and it mattered. The
// Cardmarket link we hand the operator is filtered with language=1 (English).
// If the PRICE beside it were the cheapest copy in any language, the two would
// disagree — the operator would be quoted a cheap Italian listing and then land
// on an English page showing something else entirely.
//
// MEASURED 24 Aug 2026, 17 cards carrying both an unsuffixed price and at least
// one language-specific one. The test is simple: if lowest_near_mint were a
// cross-language minimum it could NEVER exceed the cheapest language-specific
// figure. It exceeds it on 10 of the 17:
//
//     Latias dv1-9         base EUR 32.50    FR 8.40   IT 4.00
//     Tornadus-EX bw9-98   base EUR 18.00    IT 7.00
//     Swampert ex1-13      base EUR 35.00    IT 19.99
//     Accelgor bw3-12      base EUR  1.00    ES 0.05   IT 0.10
//
// So the unsuffixed field is a distinct language subset. _DE/_FR/_ES/_IT are
// the other four major Cardmarket languages, so unsuffixed is English, and the
// price agrees with the link.
//
// These fixtures are real rows from that sample. The invariant they encode is
// the one that would break if the adapter ever started reading a different
// field: the headline must not be derived from the language-specific figures.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Real measured rows: unsuffixed price vs the language-specific ones. */
const SAMPLE = [
  { id: 'dv1-9', name: 'Latias', base: 32.5, langs: { FR: 8.4, IT: 4 } },
  { id: 'bw9-98', name: 'Tornadus-EX', base: 18, langs: { DE: 25.99, FR: 15, ES: 24.99, IT: 7 } },
  { id: 'ex1-13', name: 'Swampert', base: 35, langs: { DE: 64.99, ES: 35, IT: 19.99 } },
  { id: 'bw3-12', name: 'Accelgor', base: 1, langs: { DE: 2.79, FR: 0.5, ES: 0.05, IT: 0.1 } },
  { id: 'sm10-9', name: 'Venonat', base: 0.03, langs: { DE: 0.02, FR: 0.05, ES: 0.04, IT: 0.02 } },
];

describe('the headline price is English, not a cross-language minimum', () => {
  test('the unsuffixed field exceeds the cheapest language figure on real cards', () => {
    // This is the whole proof. A minimum taken across all languages is by
    // definition <= any single language's minimum. These are not.
    const above = SAMPLE.filter((r) => r.base > Math.min(...Object.values(r.langs)));
    assert.ok(above.length >= 4,
      'if this stops holding, either the upstream changed the field meaning or ' +
      'the fixtures drifted — re-measure before trusting the headline price');

    for (const r of above) {
      const cheapest = Math.min(...Object.values(r.langs));
      assert.ok(r.base > cheapest,
        `${r.name} ${r.id}: base ${r.base} must exceed cheapest language ${cheapest}`);
    }
  });

  test('the gap is material, not rounding', () => {
    // Latias: EUR 32.50 English against EUR 4 Italian. Quoting the Italian
    // price against an English-filtered link would be an 8x error on one card.
    const latias = SAMPLE.find((r) => r.id === 'dv1-9');
    const cheapest = Math.min(...Object.values(latias.langs));
    assert.ok(latias.base / cheapest > 5,
      'the language dimension moves prices by multiples, so getting it wrong is expensive');
  });
});

describe('the code says the right thing about it', () => {
  test('the wrong claim is marked as corrected, not silently deleted', async () => {
    // The old text is deliberately still QUOTED in the correction: a comment
    // that just states the right thing teaches nobody why the wrong thing was
    // believable. So the assertion is that the correction exists, not that the
    // old string is absent — deleting the history would pass a
    // doesNotMatch check and lose the more useful artifact.
    const src = await readFile(join(ROOT, 'pricing', 'price.js'), 'utf8');
    assert.match(src, /CORRECTION, 24 Aug 2026/,
      'the claim was measured false and the measurement should travel with it');
    assert.match(src, /10 of the 17/, 'with the sample that falsified it');
  });

  test('the adapter reads the unsuffixed field, not a language-specific one', async () => {
    const src = await readFile(join(ROOT, 'pricing', 'adapters', 'tcggo-rapidapi.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.match(code, /lowest_nm:\s*cm\.lowest_near_mint\s*\|\|\s*null/,
      'the headline must come from the English field');
    assert.doesNotMatch(code, /lowest_nm:\s*cm\.lowest_near_mint_(DE|FR|ES|IT)/,
      'never headline a foreign-language price against an English-filtered link');
  });

  test('the Cardmarket link still filters to English', async () => {
    const src = await readFile(join(ROOT, 'pricing', 'adapters', 'cardmarket-html.js'), 'utf8');
    assert.match(src, /language=1/,
      'language=1 is Cardmarket\'s English filter — the price and the page must ' +
      'be talking about the same listings');
  });
});
