// Regression: scan-tab "Text" panel parser — apps/vendor/modules/text-parse.js
//
// Dave hit a real-world failure mode: pasting 12 lines of card data formatted
// as "<name…> <set 3-4 letters> <lang 2 letters> <num>/<total> [extras]" left
// the results pane empty. Old parser only handled "<SET> <NUM>" at line start
// and dropped name-first inputs to a bare-name fallback that 400'd the manual
// identify endpoint. This spec locks in the patterns we now support.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTextEntryLine, parseTextEntryLines } from '../../apps/vendor/modules/text-parse.js';

// ── Pattern 1: name + set + lang + num/total ─────────────────────────────
// The format Dave was pasting. All 12 examples must round-trip cleanly.

test('P1: parses Dave\'s 12-line block byte-for-byte', () => {
  const cases = [
    { line: 'Mystery Garden meg en 172/132',                                 expect: { name: 'Mystery Garden',         set_code: 'MEG', lang: 'en', card_number: '172', total: '132' } },
    { line: 'Wugtrio paf en 224/091',                                        expect: { name: 'Wugtrio',                set_code: 'PAF', lang: 'en', card_number: '224', total: '091' } },
    { line: 'Dewgong pfl en 097/094',                                        expect: { name: 'Dewgong',                set_code: 'PFL', lang: 'en', card_number: '097', total: '094' } },
    { line: 'Garganacle ex scr en 089/142',                                  expect: { name: 'Garganacle ex',          set_code: 'SCR', lang: 'en', card_number: '089', total: '142' } },
    { line: 'Rotom ex pfl en 029/094',                                       expect: { name: 'Rotom ex',               set_code: 'PFL', lang: 'en', card_number: '029', total: '094' } },
    { line: 'Durant ex ssp en 004/191',                                      expect: { name: 'Durant ex',              set_code: 'SSP', lang: 'en', card_number: '004', total: '191' } },
    { line: 'Team Rockets Crobat ex dri en 122/182 League Promo Stamp',       expect: { name: 'Team Rockets Crobat ex', set_code: 'DRI', lang: 'en', card_number: '122', total: '182', extras: 'League Promo Stamp' } },
    { line: 'Mismagius ex pfl en 036/094',                                   expect: { name: 'Mismagius ex',           set_code: 'PFL', lang: 'en', card_number: '036', total: '094' } },
    { line: 'Megaton Blower ssp en 182/191',                                 expect: { name: 'Megaton Blower',         set_code: 'SSP', lang: 'en', card_number: '182', total: '191' } },
    { line: 'Slaking ex ssp en 147/191',                                     expect: { name: 'Slaking ex',             set_code: 'SSP', lang: 'en', card_number: '147', total: '191' } },
    { line: 'Tapu Koko ex jtg en 051/159',                                   expect: { name: 'Tapu Koko ex',           set_code: 'JTG', lang: 'en', card_number: '051', total: '159' } },
    { line: 'Mega Sharpedo ex pfl en 061/094',                               expect: { name: 'Mega Sharpedo ex',       set_code: 'PFL', lang: 'en', card_number: '061', total: '094' } },
  ];
  for (const { line, expect: exp } of cases) {
    const got = parseTextEntryLine(line);
    assert.equal(got?.pattern, 1, `${line} — should match P1, got pattern ${got?.pattern}`);
    for (const key of Object.keys(exp)) {
      assert.equal(got[key], exp[key], `${line} — ${key} mismatch (got ${JSON.stringify(got[key])})`);
    }
  }
});

// The "ex" trap: names ending in " ex" must not be eaten as a 2-char set
// code, because "ex" is followed by the actual set code (not by a lang).
test('P1: " ex" suffix in name does not get mis-parsed as set_code', () => {
  const got = parseTextEntryLine('Mega Sharpedo ex pfl en 061/094');
  assert.equal(got.name, 'Mega Sharpedo ex');
  assert.equal(got.set_code, 'PFL');
});

// ── Pattern 2: name + set + num/total (no lang) ──────────────────────────

test('P2: parses name-first without language token', () => {
  const got = parseTextEntryLine('Pikachu MEG 172/132');
  assert.equal(got.pattern, 2);
  assert.equal(got.name, 'Pikachu');
  assert.equal(got.set_code, 'MEG');
  assert.equal(got.card_number, '172');
  assert.equal(got.total, '132');
});

// ── Pattern 3: legacy V1 set-first ────────────────────────────────────────

test('P3: parses legacy set-first format', () => {
  const got = parseTextEntryLine('MEG 172/132');
  assert.equal(got.pattern, 3);
  assert.equal(got.set_code, 'MEG');
  assert.equal(got.card_number, '172/132');
});

test('P3: parses set-first with optional name suffix', () => {
  const got = parseTextEntryLine('MEG 172 Pikachu');
  assert.equal(got.pattern, 3);
  assert.equal(got.set_code, 'MEG');
  assert.equal(got.card_number, '172');
  assert.equal(got.name, 'Pikachu');
});

// ── Pattern 4: number-first ──────────────────────────────────────────────

test('P4: parses number-only line with name suffix', () => {
  const got = parseTextEntryLine('172/132 Pikachu');
  assert.equal(got.pattern, 4);
  assert.equal(got.card_number, '172/132');
  assert.equal(got.name, 'Pikachu');
});

// ── Pattern 5: bare name (last resort) ───────────────────────────────────

test('P5: bare name falls through', () => {
  const got = parseTextEntryLine('Pikachu');
  assert.equal(got.pattern, 5);
  assert.equal(got.name, 'Pikachu');
  assert.equal(got.set_code, undefined);
  assert.equal(got.card_number, undefined);
});

// ── Whitespace / empty handling ──────────────────────────────────────────

test('parseTextEntryLine returns null for empty / whitespace-only input', () => {
  assert.equal(parseTextEntryLine(''), null);
  assert.equal(parseTextEntryLine('   '), null);
  assert.equal(parseTextEntryLine('\t\n'), null);
});

test('parseTextEntryLine survives null / undefined', () => {
  assert.equal(parseTextEntryLine(null), null);
  assert.equal(parseTextEntryLine(undefined), null);
});

// ── Multi-line behaviour ─────────────────────────────────────────────────

test('parseTextEntryLines handles \\r\\n and skips blanks', () => {
  const block = [
    'Pikachu MEG en 172/132',
    '',
    '  ',
    'Wugtrio paf en 224/091',
  ].join('\r\n');
  const out = parseTextEntryLines(block);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Pikachu');
  assert.equal(out[1].name, 'Wugtrio');
});

test('parseTextEntryLines on the full 12-line block produces 12 priced-able rows', () => {
  const block = [
    'Mystery Garden meg en 172/132',
    'Wugtrio paf en 224/091',
    'Dewgong pfl en 097/094',
    'Garganacle ex scr en 089/142',
    'Rotom ex pfl en 029/094',
    'Durant ex ssp en 004/191',
    'Team Rockets Crobat ex dri en 122/182 League Promo Stamp',
    'Mismagius ex pfl en 036/094',
    'Megaton Blower ssp en 182/191',
    'Slaking ex ssp en 147/191',
    'Tapu Koko ex jtg en 051/159',
    'Mega Sharpedo ex pfl en 061/094',
  ].join('\n');
  const out = parseTextEntryLines(block);
  assert.equal(out.length, 12);
  // Every row must have what /api/identify-manual needs: set_code + card_number.
  for (const row of out) {
    assert.ok(row.set_code, `${row.raw}: missing set_code after parse`);
    assert.ok(row.card_number, `${row.raw}: missing card_number after parse`);
    assert.ok(row.name, `${row.raw}: missing name after parse`);
    assert.equal(row.pattern, 1, `${row.raw}: expected P1 match`);
  }
});

// ── Robustness / edge cases ──────────────────────────────────────────────

test('extra whitespace around the slash is tolerated', () => {
  const got = parseTextEntryLine('Pikachu meg en 172 / 132');
  assert.equal(got.pattern, 1);
  assert.equal(got.card_number, '172');
  assert.equal(got.total, '132');
});

test('mixed-case set token is normalised to uppercase', () => {
  assert.equal(parseTextEntryLine('Pikachu MeG en 172/132').set_code, 'MEG');
  assert.equal(parseTextEntryLine('Pikachu Meg 172/132').set_code, 'MEG');
});

test('lang token is normalised to lowercase', () => {
  assert.equal(parseTextEntryLine('Pikachu meg EN 172/132').lang, 'en');
});

test('non-English language tokens are accepted', () => {
  for (const lang of ['de', 'fr', 'es', 'it', 'pt', 'jp', 'ja', 'ko', 'zh', 'ru', 'nl']) {
    const got = parseTextEntryLine(`Pikachu meg ${lang} 172/132`);
    assert.equal(got?.pattern, 1, `lang ${lang}: expected P1 match`);
    assert.equal(got.lang, lang);
  }
});

test('extras are captured separately from name', () => {
  const got = parseTextEntryLine('Team Rockets Crobat ex dri en 122/182 League Promo Stamp');
  assert.equal(got.name, 'Team Rockets Crobat ex');
  assert.equal(got.extras, 'League Promo Stamp');
});

// Names that share spelling with valid lang tokens shouldn't fool the parser
// — "Pikachu en xxx" is invalid because nothing matches set+lang; we should
// fall through to a less-rich pattern.
test('a line with a stray lang token but no number/total falls through to P5', () => {
  const got = parseTextEntryLine('Pikachu en');
  // P1/P2/P3/P4 all need a number/total; P5 catches it as a bare name.
  // (We accept the noisy name — best we can do without a number anchor.)
  assert.ok(got);
  assert.notEqual(got.pattern, 1);
});
