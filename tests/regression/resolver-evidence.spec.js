// tests/regression/resolver-evidence.spec.js
//
// PINS four ways the resolver ignored or invented evidence, all found by a
// five-agent stress sweep on 25 Aug 2026 and all fixed together because they
// share one shape: SOMETHING THAT IS NOT EVIDENCE WAS TREATED AS EVIDENCE, or
// something that was evidence got discarded.
//
// Whole-catalogue effect, every card typed as "<3-letter prefix> <n>/<total>":
//
//     before   20,212 correct   6 WRONG   223 ambiguous
//     after    20,221 correct   0 WRONG   220 ambiguous
//
// More correct, fewer questions, and no wrong answers left in 20,493 lines.
//
// ---------------------------------------------------------------------------
// 1. THE CATALOGUE KEY DISCARDED THE TYPED NAME
//
// The catalogue_key reading was built with `name: null` at prior 1.0 — the top
// rank. So "mew 151-6" threw away "mew", matched 151-6, and returned Charizard
// ex with high confidence. The operator supplied a name and it was deleted.
//
// 2. THE KEY LOOKUP LOWERCASED THE COLLECTOR NUMBER
//
// cleanNum lowercases, but catalogue keys preserve case: swsh12tg-TG19,
// ex10-V, swsh45sv-SV064. Looking up "swsh12tg-tg19" missed all 1,646 cards
// whose number is not pure digits — the entire Trainer Gallery / Shiny Vault /
// Galarian Gallery / Unown population.
//
// 3. AN ABSENT SET CODE MATCHED AN ABSENT HINT
//
// 25 of 174 sets have ptcgoCode null. `?? ''` turns that into the empty string,
// which is also what `hint` holds when no set code was typed — so "" === ""
// matched and a set with NO code won tie-breaks against sets that had one.
// Both tie-break sites had it. The sets are Southern Islands, all nine POP
// series, Pokemon Rumble, every McDonald's set and the trainer kits, which is
// why a sweep found "Espeon 16" -> POP 5 and "Venusaur ex 1" -> Pokemon Rumble.
//
// 4. AN EXACT NAME HIT NEVER LOOKED AROUND
//
// Preferring the exact name is right when a whole name was typed: "Charizard
// 4/102" means Charizard, and offering Charizard ex too would invent an
// ambiguity. It is wrong when the typed token is a three-letter PREFIX that
// merely happens to also be a card name — then the preference is an accident
// of the catalogue rather than a reading of the input. "hop 133/159" returned
// Hop [Crown Zenith] because "Hop" is a name, so Hop's Rookidee [Journey
// Together] was never considered — and both sets have 159 cards with a #133.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveTypedLine } from '../../pricing/text-entry/resolve-line.js';
import { getTypedEntryIndexes } from '../../pricing/text-entry/index-cache.js';
import { tokeniseLine } from '../../pricing/text-entry/tokenise.js';

let db;
let idx;
before(async () => {
  db = JSON.parse(await readFile('data/card-db.json', 'utf8'));
  idx = getTypedEntryIndexes(db);
});
const resolve = (line) =>
  resolveTypedLine(line, { cardDb: db, nameIndex: idx.nameIndex, nameNumberIndex: idx.nameNumberIndex });

describe('1. a catalogue key may not discard the typed name', () => {
  test('the reading carries the name instead of nulling it', () => {
    const key = tokeniseLine('mew 151-6').interpretations.find((i) => i.shape === 'catalogue_key');
    assert.ok(key, 'the catalogue-key reading must still exist');
    assert.equal(key.name, 'mew', 'the name is evidence and must reach the resolver');
  });

  test('a name that contradicts the key refuses', () => {
    // Returned sv3pt5-6 Charizard ex before — high confidence, name ignored.
    for (const line of ['mew 151-6', 'wis 151-145']) {
      assert.notEqual(resolve(line).status, 'resolved', line);
    }
  });

  test('a name that agrees with the key resolves', () => {
    assert.equal(resolve('cha base1-4').card_id, 'base1-4');
    assert.equal(resolve('zap 151-145').card_id, 'sv3pt5-145');
  });

  test('a bare key with no name still works', () => {
    assert.equal(resolve('sv3pt5-4').card_id, 'sv3pt5-4');
    assert.equal(resolve('base1-4').card_id, 'base1-4');
  });
});

describe('2. catalogue keys keep the collector number\'s case', () => {
  const cases = [
    ['swsh12tg-TG19', 'Trainer Gallery'],
    ['ex10-V', 'Unown, numbered by letter'],
    ['swsh45sv-SV064', 'Shiny Vault'],
  ];
  for (const [key, what] of cases) {
    test(`${key} (${what})`, () => {
      assert.equal(resolve(key).card_id, key,
        'lowercasing the number missed every non-digit-numbered card');
    });
  }
});

describe('3. an absent set code is not a hint', () => {
  test('a set with no ptcgoCode does not win a tie by having none', () => {
    // Detective Pikachu and Southern Islands both have 18 cards and a
    // Lickitung at 16. si1 has ptcgoCode null; that is not a reason to pick it.
    const r = resolve('lic 16/18');
    assert.notEqual(r.status, 'resolved', 'a genuine tie must be asked about');
  });

  test('the POP sets stop winning every vintage reprint tie', () => {
    for (const line of ['Espeon 16', 'Ampharos 1']) {
      const r = resolve(line);
      if (r.status === 'resolved') {
        assert.doesNotMatch(String(db[r.card_id]?.setName ?? ''), /^POP/,
          `${line} resolved to a POP card, which is the empty-hint bug`);
      }
    }
  });

  test('a REAL set code still breaks a tie', () => {
    // The fix must not disarm the hint, only stop an absent one counting.
    assert.equal(resolve('meg 172/132').card_id, 'me1-172');
  });
});

describe('4. an exact name hit still looks around', () => {
  test('a prefix that happens to be a name does not shut out longer names', () => {
    const r = resolve('hop 133/159');
    assert.equal(r.status, 'ambiguous', 'Hop and Hop\'s Rookidee both fit');
    const names = r.candidates.map((c) => c.name);
    assert.ok(names.some((n) => /Rookidee/.test(n)),
      'the longer name was never even considered before');
  });

  test('the preference is unchanged when only the exact name fits', () => {
    // Widening must only ADD names that have a card at the same number.
    // Otherwise every full name becomes a needless question.
    assert.equal(resolve('cha 4/102').card_id, 'base1-4');
    assert.equal(resolve('Charizard 4/102').card_id, 'base1-4');
  });

  test('an exact hit that goes nowhere still widens, as before', () => {
    // The original "Eri" case: a card named "Eri" exists, so "eri" matched
    // exactly, had no card at 103, and stopped — while Erika's Kindness sat at
    // Gym Challenge 103/132.
    assert.equal(resolve('eri 103/132').card_id, 'gym2-103');
  });
});

describe('the whole catalogue produces no wrong answers', () => {
  test('every card, typed as prefix + number/total', async () => {
    const sets = JSON.parse(await readFile('pricing/reference/pokemon-sets.json', 'utf8'));
    const arr = Array.isArray(sets) ? sets : (sets.data || Object.values(sets));
    const byId = {};
    for (const s of arr) byId[s.id] = s;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

    const wrong = [];
    let correct = 0;
    for (const [id, c] of Object.entries(db)) {
      const st = byId[id.slice(0, id.lastIndexOf('-'))];
      if (!st?.printedTotal) continue;
      const pre = norm(c.name).slice(0, 3);
      if (pre.length !== 3) continue;
      const num = id.slice(id.lastIndexOf('-') + 1);
      const r = resolve(`${pre} ${num}/${st.printedTotal}`);
      if (r.status !== 'resolved') continue;
      if (r.card_id === id) correct += 1;
      else if (wrong.length < 10) wrong.push(`${pre} ${num}/${st.printedTotal}: want ${id}, got ${r.card_id} (${r.reason})`);
      else wrong.push('…');
    }

    assert.equal(wrong.length, 0,
      `a confidently wrong card is the expensive failure mode:\n  ${wrong.join('\n  ')}`);
    assert.ok(correct > 20000, `correct answers should stay above 20,000, got ${correct}`);
  });
});
