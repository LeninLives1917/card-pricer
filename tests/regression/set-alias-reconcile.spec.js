// Reconciles pricing/set-aliases.js against the two things it claims to map
// between: the set list (pricing/reference/pokemon-sets.json) and the catalogue
// (data/card-db.json).
//
// WHY THIS EXISTS
//
// PKM_SET_ALIASES had six wrong entries and nothing was positioned to notice,
// because resolveSetCode() cannot fail — on a miss it returns the raw code
// lowercased as a set id and carries on. A wrong mapping therefore looks
// exactly like a right one until a card comes back wrong.
//
//   SVE       -> sv8pt5   Prismatic Evolutions. Typing "SVE 001" returned
//                         Exeggcute. S&V Energies is `sve` and exists.
//   BBT/BLK/  -> bbt      No such set id. Black Bolt is `zsv10pt5`.
//   ZSV10PT5
//   WHT/      -> wht      No such set id. White Flare is `rsv10pt5`.
//   RSV10PT5
//   HIF       -> sm35     Shining Legends. HIF is Hidden Fates = `sm115`.
//
// 345 cards (Black Bolt + White Flare) were unreachable by typed set code, and
// because those aliases set `aliased: true`, the ptcgoCode fallback query at
// apps/server/routes/identify.js:478 was SKIPPED — so there was no second
// chance either.
//
// THE HIF CASE IS WHY EXISTENCE-CHECKING IS NOT ENOUGH. `sm35` is a real set
// with real cards, so "does the target exist?" answers yes. The assertion that
// catches it is test 3: an alias key must equal its target's OWN ptcgoCode
// unless it is listed below with a written reason. HIF cannot be silenced
// without writing a reason that is false.
//
// Verified red before the fix: 6 failures in test 1, 5 in test 2, 1 in test 3.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PKM_SET_ALIASES, resolveSetCode } from '../../pricing/set-aliases.js';
import { loadSets, setResolutionState } from '../../pricing/set-resolve.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETS = JSON.parse(fs.readFileSync(join(REPO, 'pricing', 'reference', 'pokemon-sets.json'), 'utf8'));
const BY_ID = new Map(SETS.map((s) => [s.id, s]));

/**
 * Alias keys that legitimately differ from their target's ptcgoCode. Every
 * entry needs a reason, and the reason has to be true — that is the whole
 * mechanism. An unexplained mismatch is a bug by default.
 */
const KNOWN_ALIAS_EXCEPTIONS = {
  '151':      'vernacular. The set is printed "151"; its ptcgoCode is MEW.',
  'JT':       'common shorthand for JTG (Journey Together).',
  'ME1':      'set-id form. Models return the id as often as the printed code.',
  'ME2':      'set-id form, as ME1.',
  'ME3':      'set-id form, as ME1.',
  'SVP':      'set-id form. The catalogue codes these PR-SV and SVP both.',
  'MEP':      'set-id form, as SVP. Target is absent from pokemon-sets.json — '
              + 'tracked separately; see the mep test below.',
  'BBT':      'vernacular for Black Bolt, whose printed code is BLK. Kept '
              + 'because it is what was typed before the code was published.',
  'ZSV10PT5': 'set-id form for Black Bolt, as ME1.',
  'RSV10PT5': 'set-id form for White Flare, as ME1.',
  'CZGG':     'compound of CRZ + GG. The gallery shares CRZ with its base set.',
  'SWP':      'vernacular for the SWSH promo set, whose ptcgoCode is PR-SW.',
  'SWSH':     'vernacular for the SWSH promo set, as SWP.',
  'ASH':      'legacy alias predating the ASC code for Ascended Heroes. Kept '
              + 'so previously-typed input still resolves; ASC is the correct '
              + 'code and is mapped alongside it.',
};

describe('set alias reconciliation', () => {
  // Targets that are legitimately in the catalogue but not yet in the set
  // list. Kept explicit and small; test 6 is what forces this to be revisited.
  const SETS_FILE_GAPS = new Set(['mep']);

  test('1. every alias target is a real set id in pokemon-sets.json', () => {
    const bad = Object.entries(PKM_SET_ALIASES)
      .filter(([, id]) => !BY_ID.has(id) && !SETS_FILE_GAPS.has(id))
      .map(([code, id]) => `${code} -> ${id}`);
    assert.deepEqual(bad, [], 'alias targets that do not name a real set');
  });

  test('2. every alias target has cards in the catalogue', () => {
    const dbPath = join(REPO, 'data', 'card-db.json');
    // Do NOT skip when the catalogue is absent. A skipped reconciliation check
    // is an invisible fallback wearing a test's clothes, which is the exact
    // defect class this file exists to catch.
    assert.ok(
      fs.existsSync(dbPath),
      'data/card-db.json is missing. It is untracked and lives on the Render '
      + 'disk; build it with `node scripts/build-phash-db.js` before running '
      + 'the suite. This check must not be skipped.',
    );
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const held = new Set();
    for (const key of Object.keys(db)) held.add(key.slice(0, key.lastIndexOf('-')));

    const bad = Object.entries(PKM_SET_ALIASES)
      .filter(([, id]) => !held.has(id))
      .map(([code, id]) => `${code} -> ${id}`);
    assert.deepEqual(bad, [], 'alias targets with zero cards in the catalogue');
  });

  test('3. an alias key matches its target ptcgoCode, or is explained', () => {
    const unexplained = [];
    for (const [code, id] of Object.entries(PKM_SET_ALIASES)) {
      if (code in KNOWN_ALIAS_EXCEPTIONS) continue;
      const s = BY_ID.get(id);
      if (!s || !s.ptcgoCode) continue; // covered by test 1
      if (code !== String(s.ptcgoCode).toUpperCase()) {
        unexplained.push(`${code} -> ${id}, whose ptcgoCode is ${s.ptcgoCode} (${s.name})`);
      }
    }
    assert.deepEqual(
      unexplained, [],
      'alias keys that silently disagree with the set they point at. Either '
      + 'the mapping is wrong, or add it to KNOWN_ALIAS_EXCEPTIONS with a '
      + 'reason that is actually true.',
    );
  });

  test('4. every exception names an alias that still exists', () => {
    const stale = Object.keys(KNOWN_ALIAS_EXCEPTIONS).filter((k) => !(k in PKM_SET_ALIASES));
    assert.deepEqual(stale, [], 'exceptions for aliases that were removed');
  });

  test('5. the sets the bugs made unreachable now resolve', () => {
    assert.equal(resolveSetCode('BLK').setId, 'zsv10pt5', 'Black Bolt');
    assert.equal(resolveSetCode('WHT').setId, 'rsv10pt5', 'White Flare');
    assert.equal(resolveSetCode('SVE').setId, 'sve', 'S&V Energies, not Prismatic Evolutions');
    assert.equal(resolveSetCode('HIF').setId, 'sm115', 'Hidden Fates, not Shining Legends');
    assert.equal(resolveSetCode('SLG').setId, 'sm35', 'Shining Legends keeps its own code');
    assert.equal(resolveSetCode('ASC').setId, 'me2pt5', 'Ascended Heroes');
  });

  test('6. mep is in the catalogue but missing from pokemon-sets.json', () => {
    // Not an alias bug — a gap in the reference file. resolveIdentity()
    // returns the right card with a blank set_code and set_name because
    // set-resolve.js:139-140 looks the display code up by set id and finds
    // nothing. Fix by refreshing pokemon-sets.json from upstream, not by
    // hand-editing either file.
    //
    // This test is deliberately an assertion about a KNOWN gap rather than a
    // failure: it turns red the moment the gap is closed, which is the prompt
    // to delete it.
    assert.equal(
      BY_ID.has('mep'), false,
      'mep is now in pokemon-sets.json — good. Delete this test and drop the '
      + 'MEP note from KNOWN_ALIAS_EXCEPTIONS.',
    );
  });

  test('7. most of the catalogue is reachable by a typed set code', () => {
    const dbPath = join(REPO, 'data', 'card-db.json');
    assert.ok(fs.existsSync(dbPath), 'data/card-db.json required — see test 2');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const held = new Set();
    for (const key of Object.keys(db)) held.add(key.slice(0, key.lastIndexOf('-')));

    // A set is reachable if some alias points at it, or if its own printed
    // code resolves to it, or if its id is typeable as-is.
    const targets = new Set(Object.values(PKM_SET_ALIASES));
    let reachable = 0;
    for (const id of held) {
      const s = BY_ID.get(id);
      const viaCode = s && s.ptcgoCode && resolveSetCode(s.ptcgoCode).setId === id;
      if (targets.has(id) || viaCode || resolveSetCode(id).setId === id) reachable += 1;
    }
    const ratio = reachable / held.size;
    // Reported, then floored. The point is that a regression is loud, not that
    // this number is a target.
    console.log(`[ALIAS] ${reachable}/${held.size} set ids reachable (${(ratio * 100).toFixed(1)}%)`);
    assert.ok(ratio >= 0.95, `only ${(ratio * 100).toFixed(1)}% of set ids are reachable`);
  });
});

describe('the set list must not live where a disk mounts over it', () => {
  test('THE INCIDENT: pokemon-sets.json is NOT under data/', () => {
    // render.yaml mounts the 1 GB persistent disk at
    // /opt/render/project/src/data. A mount replaces the directory, so a
    // git-tracked file under data/ is shadowed by a disk that never had a
    // copy. The file was in every checkout and unreadable by the running
    // process.
    //
    // What it cost: printedTotal disambiguation is the entire mechanism
    // behind V3_BENCHMARK §18 — identity 49.0% -> 68.6%, precision 61% ->
    // 97.2%. Without the file, resolveIdentity silently degrades to
    // name+number. Measured against production on 24 Aug 2026: "cha 4/102"
    // returned SIX candidates where it resolves to Base Set Charizard
    // locally, and "exe 1/191" and "exe 1/131" returned identical results,
    // which is only possible if the denominator is ignored entirely.
    assert.equal(
      fs.existsSync(join(REPO, 'data', 'pokemon-sets.json')), false,
      'pokemon-sets.json is back under data/, where the Render disk mount hides it',
    );
    assert.ok(
      fs.existsSync(join(REPO, 'pricing', 'reference', 'pokemon-sets.json')),
      'the set list must live beside the code that reads it, not on a mount point',
    );
  });

  test('it is git-tracked, so a fresh deploy has it', () => {
    // Untracked would put us back where we started by a different route.
    const tracked = execSync('git ls-files pricing/reference/pokemon-sets.json',
      { cwd: REPO, encoding: 'utf8' }).trim();
    assert.equal(tracked, 'pricing/reference/pokemon-sets.json');
  });

  test('loadSets actually returns the sets, with printed totals', () => {
    // The property that matters is not "a file exists" but "the numbers the
    // resolver needs are in memory".
    const sets = loadSets();
    assert.ok(sets.length >= 170, `expected the full set list, got ${sets.length}`);
    const withTotal = sets.filter((s) => s.printedTotal != null).length;
    assert.equal(withTotal, sets.length, 'every set must carry a printedTotal');
  });

  test('and the health check reports it, rather than a one-shot console.warn', () => {
    // This hid for months behind a single warning at boot. A degraded path
    // that works and returns plausible answers is invisible by construction.
    const s = setResolutionState();
    assert.equal(s.ok, true);
    assert.ok(s.sets_loaded >= 170);
    assert.ok(s.loaded_from, 'the health payload must say WHERE it loaded from');
  });
});
