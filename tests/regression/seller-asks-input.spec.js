// tests/regression/seller-asks-input.spec.js
//
// PINS the "Seller asks" field refusing to accept a typed number, reported by
// the operator 25 Aug 2026.
//
// The input handler did this on EVERY keystroke:
//
//     _ask = parseFloat(target.value) || 0;
//     renderResultSheet();                       // rebuilds the whole sheet
//     const next = document.querySelector('[data-action="ask-input"]');
//     next.focus();
//     next.setSelectionRange(next.value.length, next.value.length);
//
// Three separate faults, which the operator experiences as one symptom:
//
//  1. THE DECIMAL POINT WAS DELETED AS IT WAS TYPED. The field's value is
//     rendered from `${_ask || ''}`. Typing "1." parses to the number 1, the
//     re-render writes "1" back, and the "." is gone. No price with cents could
//     ever be entered — on a buy-list, where every price has cents.
//
//  2. A LEADING ZERO CLEARED THE FIELD. 0 is falsy, so `${_ask || ''}` renders
//     the empty string. Typing "0" to start "0.50" wiped the box.
//
//  3. setSelectionRange THROWS on input[type=number]. Chrome rejects it
//     outright ("the input element's type ('number') does not support
//     selection"), so every keystroke also raised an uncaught error.
//
// The fix keeps the raw string as typed, leaves the field alone while it is
// being typed into, and updates only the derived figure beside it.
//
// These are source-level assertions: result-sheet.js is a browser module with
// no DOM in the test runner, and it cannot import from pricing/ (a vendor
// module importing ../../../ resolves to a path express.static does not serve,
// which returns index.html with HTTP 200 and killed the whole app once). Same
// approach as the other vendor-module specs.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHEET = join(ROOT, 'apps', 'vendor', 'modules', 'result-sheet.js');

/** Strip comments — the fix is DESCRIBED in a comment naming what it removed. */
const codeOnly = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

let src;
let handler;
before(async () => {
  src = await readFile(SHEET, 'utf8');
  const i = src.indexOf("sheet.addEventListener('input'");
  assert.ok(i > -1, 'the input handler must still exist');
  handler = codeOnly(src.slice(i, i + 2600));
});

describe('the seller-asks field is not rebuilt while being typed into', () => {
  test('the input handler does not re-render the sheet', () => {
    assert.doesNotMatch(handler, /renderResultSheet\(\)/,
      'a full re-render destroys the element being typed into and writes the ' +
      'parsed number back over the raw text');
  });

  test('setSelectionRange is gone — it throws on input[type=number]', () => {
    assert.doesNotMatch(handler, /setSelectionRange/,
      "Chrome rejects it: the input element's type ('number') does not support selection");
  });

  test('the raw string is kept, not just the parsed number', () => {
    // "1." and "0" are valid mid-typing states that both round-trip to
    // something else through Number.
    assert.match(handler, /_askRaw\s*=\s*target\.value/,
      'the field must be driven by what was typed, not by the parsed value');
  });
});

describe('the field renders from the raw string', () => {
  test('value comes from _askRaw, never from `_ask || \'\'`', () => {
    const inputTag = src.slice(src.indexOf('data-action="ask-input"') - 300,
      src.indexOf('data-action="ask-input"') + 300);
    assert.match(inputTag, /value="\$\{escapeAttr\(_askRaw\)\}"/,
      'rendering from the number is what ate the decimal point and the zero');
    assert.doesNotMatch(inputTag, /value="\$\{_ask \|\| ''\}"/);
  });

  test('the raw string is escaped into the attribute', () => {
    // It is echoed straight back into HTML on the next render.
    assert.match(src, /value="\$\{escapeAttr\(_askRaw\)\}"/);
  });

  test('both the number and the raw string reset together', () => {
    // A stale _askRaw would show the previous card's offer in the next card's
    // box, which reads as the app suggesting a price. Look at the RESET, which
    // is the second occurrence — the first is the declaration.
    const code = codeOnly(src);
    const first = code.indexOf('_ask = 0;');
    const reset = code.indexOf('_ask = 0;', first + 1);
    assert.ok(reset > -1, 'there must be a reset separate from the declaration');
    assert.match(code.slice(reset, reset + 140), /_askRaw\s*=\s*''/,
      'clearing one without the other leaks the previous offer into the next card');
  });
});

describe('only the derived figure updates on input', () => {
  test('the delta span is targeted directly', () => {
    assert.match(src, /id="askDelta"/, 'the derived figure needs an id to update in place');
    assert.match(handler, /getElementById\('askDelta'\)/);
  });

  test('the sell price is carried on the element, not recomputed', () => {
    // The handler has no access to the render scope, and recomputing risks
    // disagreeing with the figure already on screen.
    assert.match(src, /data-sell="\$\{sell\}"/);
    assert.match(handler, /target\.dataset\.sell/);
  });

  test('a negative or unparseable entry is floored at zero, not NaN', () => {
    // NaN would render "€NaN" and, worse, reach custom_buy.
    assert.match(handler, /Number\.isFinite\(_ask\)/);
    assert.match(handler, /_ask\s*<\s*0/);
  });
});
