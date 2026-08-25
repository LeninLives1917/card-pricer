// tests/regression/name-prefix-cap.spec.js
//
// PINS a silent truncation found by three independent stress-test agents,
// 25 Aug 2026.
//
// namesWithPrefix walked a SORTED array and stopped at 50 names:
//
//     const { limit = 50, minPrefix = MIN_PREFIX } = opts;
//     ...
//     out.push(sorted[i]);
//     if (out.length >= limit) break;
//
// A cap on a sorted scan does not sample — it drops the alphabetical tail. The
// caller then filtered the survivors by collector number and reported
// "no_prefix_match_at_that_number", which reads as "the catalogue does not have
// that card" when the truth was "we stopped looking at the fiftieth name".
//
// MEASURED — three-letter prefixes fronting more than 50 distinct names:
//
//     tea   144 names ->  94 dropped  (167 cards)  every Team Rocket's /
//                                                  Magma's / Aqua's card
//     dar    84 names ->  34 dropped  (104 cards)  Darkrai ex / V / VSTAR
//     bla    52 names ->   2 dropped  (  7 cards)  Blaziken V / VMAX
//     meg    51 names ->   1 dropped  (  5 cards)  Mega Zygarde ex
//
// 283 cards unreachable by ANY three-letter prefix, and the list is exactly the
// current chase cards — the whole Destined Rivals Team Rocket's run, in the set
// most likely to be carried to a show. After the fix, 728 of the 756 cards
// under those four prefixes resolve; the remaining 28 are genuine ambiguities
// (bla 1/132 really is Blaine's Moltres or Blastoise) and are asked about.
//
// The cap is kept, above the largest bucket, so a future catalogue still has a
// ceiling — but breaching it is now COUNTED and logged instead of silently
// changing the answer.

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildNameIndex, namesWithPrefix, nameIndexState, _resetNameIndexCounters, PREFIX_LIMIT,
} from '../../pricing/name-index.js';
import { resolveTypedLine } from '../../pricing/text-entry/resolve-line.js';
import { getTypedEntryIndexes } from '../../pricing/text-entry/index-cache.js';

let db;
let idx;
before(async () => {
  db = JSON.parse(await readFile('data/card-db.json', 'utf8'));
  idx = getTypedEntryIndexes(db);
});
beforeEach(() => _resetNameIndexCounters());

const resolve = (line) =>
  resolveTypedLine(line, { cardDb: db, nameIndex: idx.nameIndex, nameNumberIndex: idx.nameNumberIndex });

describe('the cards the cap made unreachable', () => {
  // Every one of these returned not_found before the fix.
  const cases = [
    ["Team Rocket's Mewtwo ex", 'tea 240/182', 'sv10-240'],
    ["Team Rocket's Ariana", 'tea 237/182', 'sv10-237'],
    ['Darkrai VSTAR', 'dar GG50/70', 'swsh12pt5gg-GG50'],
    ['Darkrai ex', 'dar 110/215', 'svp-110'],
    ['Blaziken VMAX', 'bla 21/198', 'swsh6-21'],
  ];
  for (const [name, line, expected] of cases) {
    test(`${name}: "${line}"`, () => {
      const r = resolve(line);
      assert.equal(r.status, 'resolved', `${line} -> ${r.reason}`);
      assert.equal(r.card_id, expected);
    });
  }
});

describe('the limit is above the largest catalogue bucket', () => {
  test('no prefix in the real catalogue can breach it', () => {
    // The largest is "tea" at 144. A limit under that silently truncates; the
    // point of the number is that nothing reaches it.
    const names = [...new Set(Object.values(db).map((c) => String(c.name)))];
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const buckets = new Map();
    for (const n of names) {
      const p = norm(n).slice(0, 3);
      if (p.length < 3) continue;
      buckets.set(p, (buckets.get(p) ?? 0) + 1);
    }
    const largest = Math.max(...buckets.values());
    assert.ok(largest < PREFIX_LIMIT,
      `largest bucket is ${largest} and the limit is ${PREFIX_LIMIT} — a limit at or ` +
      'below the largest bucket truncates the alphabetical tail silently');
  });

  test('resolving across the whole catalogue never truncates', () => {
    for (const line of ['tea 240/182', 'dar 110/215', 'bla 21/198', 'meg 172/132']) resolve(line);
    assert.equal(nameIndexState().prefix_truncations, 0,
      'a truncation means the answer was computed from part of the catalogue');
  });
});

describe('breaching the cap is reported, never silent', () => {
  test('a truncated bucket is counted and names the prefix', () => {
    const index = buildNameIndex(['aaa1', 'aaa2', 'aaa3', 'aaa4', 'bbb1']);
    const out = namesWithPrefix(index, 'aaa', { limit: 2 });
    assert.equal(out.length, 2);
    const s = nameIndexState();
    assert.equal(s.prefix_truncations, 1,
      'silent truncation is what turned 283 real cards into "not found"');
    assert.equal(s.last_truncated_prefix, 'aaa');
  });

  test('a bucket inside the cap is not reported', () => {
    const index = buildNameIndex(['aaa1', 'aaa2', 'bbb1']);
    namesWithPrefix(index, 'aaa', { limit: 50 });
    assert.equal(nameIndexState().prefix_truncations, 0);
  });

  test('the tail is what gets dropped, so truncation is not a sample', () => {
    // Naming why the cap was wrong rather than merely small: it is the
    // alphabetical tail every time, so whole name families vanish together.
    // Plain alphanumerics: buildNameIndex normalises, so punctuation in a
    // fixture would be stripped and the assertion would test the wrong thing.
    const index = buildNameIndex(['aaaalpha', 'aaabravo', 'aaazulu']);
    const out = namesWithPrefix(index, 'aaa', { limit: 2 });
    assert.deepEqual(out, ['aaaalpha', 'aaabravo']);
    assert.ok(!out.includes('aaazulu'), 'the last name alphabetically is the one lost');
  });
});
