// tests/regression/set-resolve.spec.js
//
// INCIDENT (docs/V3_BENCHMARK.md §16-§18). Across 51 real photographs the
// production pipeline resolved full card identity only 49% of the time while
// reading the card NAME right 88% of the time. Set attribution alone cost ~21
// points, and it cost the same for a second, independent vision model — so it
// was never a model problem.
//
// Two defects underneath it:
//   1. identity was taken from the model's set-code guess rather than from the
//      fields that corroborate each other (name, number, printed total);
//   2. pricing/verify.js did `set_code: verified.set_code || card.set_code`, so
//      a card the verifier had matched CORRECTLY could be returned, and shown
//      to the operator, carrying the model's wrong set.
//
// These pin the fix and — just as importantly — pin the reasoning, so nobody
// "simplifies" it back into a correction table. A table cannot work here: the
// wrong codes scatter (5-9 distinct values per set, none more than 4 times)
// and the two models scatter to different ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { resolveIdentity, printedTotalOf, normNumber } from '../../pricing/set-resolve.js';

// Minimal catalogue slice. Real values: Pitch Black is printedTotal 84,
// Twilight Masquerade 167 — which is what makes "TWM 073/084" self-refuting.
const DB = {
  'me5-73': { name: 'Antique Skull Fossil', setCode: 'PBL' },
  'me5-36': { name: 'Litwick', setCode: 'PBL' },
  'sv6-73': { name: 'Something Else', setCode: 'TWM' },
  'sv10-133': { name: "Marnie's Scrafty", setCode: 'DRI' },
  'sv10-35': { name: "Ethan's Slugma", setCode: 'DRI' },
};

test('the incident: "TWM 073/084" resolves to Pitch Black, not Twilight Masquerade', () => {
  // The model named the card correctly and read its collector number
  // correctly, then attributed it to a set whose printed size contradicts the
  // number it just read. The number wins.
  const r = resolveIdentity(
    { name: 'Antique Skull Fossil', card_number: '073/084', set_code: 'TWM' }, DB);
  assert.equal(r.id, 'me5-73');
  assert.equal(r.set_code, 'PBL', 'set_code must come from the catalogue, never from the model');
  assert.equal(r.confidence, 'high');
});

test('a self-refuting read is flagged as such', () => {
  // Twilight Masquerade has printedTotal 167; the read claims /084. That
  // contradiction carried 69% of the observed set-attribution failures.
  const r = resolveIdentity(
    { name: 'Antique Skull Fossil', card_number: '073/084', set_code: 'TWM' }, DB);
  assert.equal(r.read_contradicts_itself ?? r.contradiction, true);
});

test('the model set_code is a hint and is NEVER echoed back as the answer', () => {
  for (const code of ['TWM', 'JTG', 'PAF', 'PRE', 'PAL', 'GARBAGE', '']) {
    const r = resolveIdentity(
      { name: "Marnie's Scrafty", card_number: '133/163', set_code: code }, DB);
    assert.notEqual(r.set_code, code === 'DRI' ? null : code,
      `a wrong hint (${code}) must not survive into set_code`);
  }
});

test('the set ID form is accepted, because it is a representation mismatch not an error', () => {
  // "ME5" (set id) came back as often as "PBL" (display code) — 11-13 times
  // each across both models. That is not a misread and must not be scored or
  // treated as one.
  const r = resolveIdentity({ name: 'Litwick', card_number: '36', set_code: 'ME5' }, DB);
  assert.equal(r.id, 'me5-36');
});

test('a unique name+number still resolves, but a bad total downgrades confidence', () => {
  // Name and number identify exactly one card, which measurement showed is the
  // strongest signal available — abstaining here would throw away accuracy.
  // But the total disagreeing means part of the read is wrong, so the gate
  // must be able to see that rather than being handed a confident answer.
  const r = resolveIdentity(
    { name: 'Antique Skull Fossil', card_number: '073/999', set_code: 'PBL' }, DB);
  assert.equal(r.id, 'me5-73');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.contradiction, true);
  assert.equal(r.reason, 'unique_name_number_total_mismatch');
});

test('ABSTAINS when the collector number is missing', () => {
  // Several reads returned a name and no number at all. The prompt already
  // says never to fabricate one; nothing downstream was enforcing it.
  const r = resolveIdentity({ name: 'Litwick', card_number: '', set_code: 'PBL' }, DB);
  assert.equal(r.id, null);
  assert.equal(r.reason, 'no_name_or_number');
});

test('ABSTAINS on a card the catalogue does not contain', () => {
  // If the right answer is not in the catalogue, no model can return it —
  // abstaining is the only correct behaviour.
  const r = resolveIdentity({ name: 'Not A Real Card', card_number: '1/100' }, DB);
  assert.equal(r.id, null);
  assert.equal(r.reason, 'not_in_catalogue');
});

test('a hint cannot drag the answer outside what the printed total permits', () => {
  // The tie-break consults the set code ONLY among sets the printed total
  // already allows, so a confident wrong hint cannot override the arithmetic.
  const r = resolveIdentity(
    { name: 'Antique Skull Fossil', card_number: '73/84', set_code: 'TWM' }, DB);
  assert.equal(r.set_id, 'me5');
});

test('printedTotalOf and normNumber handle the shapes the models actually emit', () => {
  assert.equal(printedTotalOf('073/084'), 84);
  assert.equal(printedTotalOf('36'), null);
  assert.equal(printedTotalOf('SWSH066'), null);
  assert.equal(normNumber('073/084'), '73');
  assert.equal(normNumber('036'), '36');
  assert.equal(normNumber(''), '');
});

test('verify.js must not fall back to the model set_code — source-level guard', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../pricing/verify.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /set_code:\s*verified\.set_code\s*\|\|\s*card\.set_code/,
    'restoring this fallback re-opens the defect: a correctly matched card ' +
    'gets returned carrying the model\'s wrong set code');
  assert.match(src, /resolveIdentity/, 'verify must resolve identity, not trust the guess');
});

test('the RESOLVER wins over the verifier set_code — caught in pre-deploy testing', () => {
  // The first production wiring was `verified.set_code || resolved.set_code`,
  // which let the model's guess win: a read of "SSP 072/191" made the API
  // return an SSP card, and that wrong answer came back wearing an
  // authoritative source. The shipped path therefore did NOT reproduce the
  // 68.6% measured offline until this precedence was flipped.
  const src = readFileSync(new URL('../../pricing/verify.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /set_code:\s*verified\.set_code\s*\|\|\s*resolved\.set_code/,
    'the verifier set_code must not outrank the resolver — it only reflects ' +
    'the query the model asked for');
  assert.match(src, /set_code:\s*resolved\.set_code\s*\|\|/,
    'resolved.set_code must come first');
});
