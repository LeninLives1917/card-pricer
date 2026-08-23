// Pins the customer quote page's line cap and its route payload.
//
// WHY THIS EXISTS
//
// apps/quote/modules/parse-lines.js:38 has always done `.slice(0, MAX_CARDS)`
// with no signal of any kind. A customer who pastes 40 cards is quoted for 20,
// shown a total, and told nothing — a wrong total with no way to notice it.
// The cap is fine on a public rate-limited endpoint; the silence is the defect,
// and it is the same shape as every other one in this repo: it did something
// plausible and counted nothing.
//
// Separately, the parser splits on whitespace and calls parts[0] a set code,
// so "Charizard 4/102" reaches the server as set_code "Charizard",
// card_number "4". The raw line now travels alongside, and the server
// tokenises it against the catalogue.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseLines, droppedByCap, MAX_CARDS } from '../../apps/quote/modules/parse-lines.js';

const many = (n) => Array.from({ length: n }, (_, i) => `MEG ${i + 1}`).join('\n');

describe('the line cap is enforced, and no longer silent', () => {
  test('THE DEFECT: lines past the cap were dropped without a word', () => {
    const lines = parseLines(many(35));
    assert.equal(lines.length, MAX_CARDS, 'the cap itself stays');
    assert.equal(droppedByCap(), 15, 'and the count of what it refused is now reported');
  });

  test('nothing dropped means nothing reported', () => {
    parseLines(many(5));
    assert.equal(droppedByCap(), 0);
  });

  test('the count resets between parses rather than accumulating', () => {
    parseLines(many(35));
    assert.equal(droppedByCap(), 15);
    parseLines(many(3));
    assert.equal(droppedByCap(), 0, 'a stale count would warn about a paste that was fine');
  });

  test('comments and blanks are not counted against the cap', () => {
    // They were already filtered before the slice; this pins that the DROPPED
    // count measures real cards, not formatting.
    const input = ['# my list', '', ...Array.from({ length: 22 }, (_, i) => `MEG ${i + 1}`)].join('\n');
    parseLines(input);
    assert.equal(droppedByCap(), 2);
  });
});

describe('every parsed line keeps the raw text', () => {
  test('raw survives so the server can tokenise what was actually typed', () => {
    // The naive parse of this line is set_code "Charizard", card_number "4".
    // The raw string is what lets the server get it right.
    const [line] = parseLines('Charizard 4/102');
    assert.equal(line.raw, 'Charizard 4/102');
    assert.equal(line.set_code, 'Charizard', 'the naive parse is unchanged and still sent as a fallback');
  });

  test('a bare number still parses, and still carries its raw line', () => {
    const [line] = parseLines('133');
    assert.equal(line.set_code, '');
    assert.equal(line.card_number, '133');
    assert.equal(line.raw, '133');
  });
});
