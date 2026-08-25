// pricing/set-resolve.js
//
// Which set is this card actually from?
//
// MEASURED (docs/V3_BENCHMARK.md §16-§17). Across 51 real photographs, two
// independent vision models read the card NAME right 88-94% of the time and
// the COLLECTOR NUMBER right ~70% — but full identity resolved correctly only
// ~50%. Set attribution alone costs about 21 points, for both readers.
//
// The obvious fix — a correction table mapping each habitual misread to the
// right set — does not work, and the data says so plainly. The wrong codes
// scatter rather than repeat: Pitch Black came back as TWM, JTG, PAF, PRE and
// PAL from one model and SFA, SCR, SV8A, MEW, SV2, PAL and TWM from the other,
// with no wrong code appearing more than four times. The two models scatter to
// DIFFERENT wrong codes, so a table fitted to one is noise for the other. And
// a blanket rewrite would be actively harmful: TWM is a real set, so rewriting
// it would destroy correct reads of genuine Twilight Masquerade cards.
//
// What works instead: the model refutes itself. A card printed "073/084" is
// from an 84-card set. Twilight Masquerade has printedTotal 167. The claim
// "TWM 073/084" is internally inconsistent, and 69% of the wrong reads carried
// exactly that contradiction.
//
// So this module does not correct the set code. It DISTRUSTS it, and resolves
// on the three fields that agree with one another — name, collector number and
// printed total — using the set code only to break a tie it cannot otherwise
// break. That fixes both readers at once, which choosing between models does
// not.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the set list lives, in priority order.
 *
 * IT USED TO LIVE IN data/, AND THAT MADE IT INVISIBLE IN PRODUCTION.
 *
 * render.yaml mounts the 1 GB persistent disk at
 * /opt/render/project/src/data — exactly the directory this file was read
 * from. A mount replaces the directory, so the git-tracked
 * data/pokemon-sets.json was shadowed by a disk that never had a copy. The
 * file was in the repo, present in every checkout, and unreadable by the
 * running process.
 *
 * The cost was not small. printedTotal disambiguation is the entire mechanism
 * behind docs/V3_BENCHMARK.md §18 — identity 49.0% -> 68.6%, precision 61% ->
 * 97.2% — and without this file resolveIdentity degrades to name+number only.
 * Measured against production on 24 Aug 2026: "cha 4/102" returned SIX
 * candidates where it resolves to Base Set Charizard locally, and "exe 1/191"
 * and "exe 1/131" returned identical results, which is only possible if the
 * denominator is being ignored entirely.
 *
 * So the reference file now lives beside the code that reads it, in a
 * directory nothing mounts over. data/ is kept as a fallback so an existing
 * disk copy still works, and so this change cannot break a deploy that has
 * one.
 */
const SETS_CANDIDATES = [
  join(REPO_ROOT, 'pricing', 'reference', 'pokemon-sets.json'),
  join(REPO_ROOT, 'data', 'pokemon-sets.json'),
];

let _sets = null;
let _warned = false;
let _emptyWarned = false;
let _loadedFrom = null;

/** [{id, name, ptcgoCode, printedTotal, total}] — refresh via scripts/fetch-sets.js */
export function loadSets() {
  if (_sets) return _sets;
  for (const path of SETS_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (Array.isArray(parsed) && parsed.length) {
        _sets = parsed;
        _loadedFrom = path;
        return _sets;
      }
    } catch { /* try the next candidate */ }
  }
  // Degrade to name+number resolution rather than throwing — but say so, once.
  // A missing reference file that silently weakens matching is the exact
  // shape of defect this project keeps re-learning, and this one did it for
  // months behind a single console.warn nobody read. It is surfaced in
  // /api/health now; see setResolutionState().
  if (!_warned) {
    console.warn('[SET-RESOLVE] pokemon-sets.json NOT FOUND in any of: '
      + SETS_CANDIDATES.join(', ')
      + ' — printed-total disambiguation is OFF and set resolution falls back '
      + 'to name+number only. This silently costs ~20 points of identity '
      + 'accuracy (V3_BENCHMARK §18).');
    _warned = true;
  }
  _sets = [];
  return _sets;
}

/**
 * For /api/health. A one-shot console.warn is how this hid for months: the
 * degraded path worked, returned plausible answers, and counted nothing.
 */
export function setResolutionState() {
  const sets = loadSets();
  return {
    ok: sets.length > 0,
    sets_loaded: sets.length,
    loaded_from: _loadedFrom ? _loadedFrom.slice(_loadedFrom.lastIndexOf('pricing') >= 0
      ? _loadedFrom.lastIndexOf('pricing') : _loadedFrom.lastIndexOf('data')) : null,
    with_printed_total: sets.filter((s) => s?.printedTotal != null).length,
  };
}

/** Test seam. */
export function resetSetsCache() {
  _sets = null; _warned = false; _emptyWarned = false; _loadedFrom = null;
}

export const normNumber = (n) => String(n ?? '')
  .trim().replace(/\/.*$/, '').replace(/^0+(?=.)/, '').toLowerCase();

/** The denominator in "073/084" — the set's printed size, when the model reports it. */
export function printedTotalOf(cardNumber) {
  const m = String(cardNumber ?? '').match(/\/\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a read to a catalogue identity.
 *
 * @param {object} read           what the model returned
 * @param {string} read.name
 * @param {string} read.card_number   may carry a denominator ("073/084")
 * @param {string} [read.set_code]    treated as a HINT, never as truth
 * @param {Map|object} cardDb     key `${set_id}-${number}` -> { name, setCode, ... }
 * @returns {{ id: string|null, confidence: 'high'|'medium'|'low',
 *             reason: string, candidates: string[], contradiction: boolean }}
 */
export function resolveIdentity(read, cardDb, opts = {}) {
  const name = normName(read?.name);
  const number = normNumber(read?.card_number);
  const printed = printedTotalOf(read?.card_number);
  const hint = String(read?.set_code ?? '').trim().toUpperCase();

  if (!name || !number) {
    return { id: null, set_id: null, set_code: null, set_name: null,
      confidence: 'low', reason: 'no_name_or_number', candidates: [], contradiction: false };
  }

  const entries = cardDb instanceof Map ? cardDb : new Map(Object.entries(cardDb || {}));

  // An empty catalogue makes EVERY card look absent, so resolution silently
  // disables itself and the caller falls back to the model's set-code guess —
  // the exact defect this module exists to fix, wearing a different hat. It
  // cost a pre-deploy debugging round; say it out loud instead.
  if (entries.size === 0) {
    if (!_emptyWarned) {
      console.warn('[SET-RESOLVE] catalogue is EMPTY — set resolution is disabled ' +
        'and callers fall back to the model set_code. Was initCardDb() called?');
      _emptyWarned = true;
    }
    return { id: null, set_id: null, set_code: null, set_name: null,
      confidence: 'low', reason: 'catalogue_empty', candidates: [], contradiction: false };
  }

  // Every catalogue entry with this name at this collector number.
  const matches = [];
  for (const [key, v] of entries) {
    const dash = key.indexOf('-');
    if (dash < 0) continue;
    if (normNumber(key.slice(dash + 1)) !== number) continue;
    if (normName(v?.name) !== name) continue;
    matches.push(key.slice(0, dash));
  }

  if (!matches.length) {
    return { id: null, set_id: null, set_code: null, set_name: null,
      confidence: 'low', reason: 'not_in_catalogue', candidates: [], contradiction: false };
  }

  const sets = loadSets();
  const byId = new Map(sets.map((s) => [s.id, s]));

  // Does the hinted set contradict the printed total? This is the signal that
  // carried 69% of the failures: "TWM 073/084" against TWM's printedTotal 167.
  let contradiction = false;
  if (printed && hint) {
    const hinted = sets.filter((s) => String(s.ptcgoCode ?? '').toUpperCase() === hint);
    if (hinted.length && !hinted.some((s) => s.printedTotal === printed)) contradiction = true;
  }

  const mk = (setId, confidence, reason, candidates) => ({
    id: `${setId}-${number}`,
    set_id: setId,
    // The catalogue's own display code — never the model's guess.
    set_code: byId.get(setId)?.ptcgoCode ?? null,
    set_name: byId.get(setId)?.name ?? null,
    confidence, reason, candidates, contradiction,
  });
  const none = (reason, candidates, contra = contradiction) => ({
    id: null, set_id: null, set_code: null, set_name: null,
    confidence: 'low', reason, candidates, contradiction: contra,
  });

  if (matches.length === 1) {
    // Name and number identify exactly one card. Measured, this is the
    // strongest signal available and resolving on it is right. But if the
    // printed total disagrees with that set's size, something in the read is
    // wrong even though the answer is probably still correct — say so, and
    // drop the confidence so the accept gate can treat it as review-worthy.
    const total = byId.get(matches[0])?.printedTotal;
    const totalDisagrees = printed != null && total != null && total !== printed;

    // STRICT MODE — for input a HUMAN typed rather than a model read.
    //
    // The default above is right for photographs: a vision model misreads a
    // denominator often enough that discarding an otherwise-unique match on
    // that basis would cost more than it saves. A person typing "61/64" is
    // different evidence. They copied both numbers off the card, and a set
    // whose size is 146 is not the set they are holding.
    //
    // Measured cost of NOT having this: on a 20-card sample, "rhy 61/64",
    // "mag 39/62", "gal 174/185" and "cha 33/191" each came back as a
    // question with two candidates, where exactly one matched the typed
    // total and the other contradicted it. Four unnecessary questions in
    // twenty, all of which the denominator already answered.
    //
    // Note the asymmetry this removes: matches.length > 1 has ALWAYS
    // abstained on a total that excludes every candidate (:180 below). Only
    // the unique-match branch answered anyway. That inconsistency is the bug.
    if (totalDisagrees && opts.strictPrintedTotal) {
      return none('printed_total_excludes_all', matches, true);
    }

    const out = mk(matches[0], totalDisagrees ? 'medium' : 'high',
      totalDisagrees ? 'unique_name_number_total_mismatch' : 'unique_name_number', matches);
    if (totalDisagrees) out.contradiction = true;
    return out;
  }

  // Several printings share this name and number — the printed total decides.
  if (printed) {
    const byTotal = matches.filter((m) => byId.get(m)?.printedTotal === printed);
    if (byTotal.length === 1) {
      return mk(byTotal[0], 'high', 'printed_total', matches);
    }
    if (byTotal.length > 1) {
      // Still tied. The set code may break it — but only among sets the printed
      // total already permits, so a wrong hint cannot drag us outside them.
      // AN ABSENT HINT IS NOT EVIDENCE, and it used to behave like one.
      //
      // 25 of 174 sets have ptcgoCode null, which `?? ''` turns into the empty
      // string — the same value `hint` holds when no set code was typed. So
      // "" === "" matched, and a set with NO code won a tie-break against a set
      // that had one.
      //
      // Measured: "lic 16/18" returned Lickitung from Southern Islands
      // (ptcgoCode null) over Lickitung from Detective Pikachu. Both sets have
      // 18 cards and a Lickitung at 16, so the line is genuinely ambiguous and
      // the only thing that separated them was an empty string matching itself.
      const byHint = hint
        ? byTotal.filter((m) => String(byId.get(m)?.ptcgoCode ?? '').toUpperCase() === hint
          || m.toUpperCase() === hint)
        : [];
      if (byHint.length === 1) {
        return mk(byHint[0], 'medium', 'printed_total_then_hint', byTotal);
      }
      return none('ambiguous_after_printed_total', byTotal);
    }
    // The printed total excludes every candidate: the number or the total was
    // misread. Abstain rather than pick one — a wrong price is expensive.
    return none('printed_total_excludes_all', matches, true);
  }

  // No printed total. Fall back to the hint, accepting the set id form too —
  // models return "ME5" (the set id) as often as "PBL" (the display code), and
  // that is a representation mismatch rather than an error.
  // Same empty-hint trap as the printed-total branch above, and this one had a
  // visible signature: a stress sweep found "Espeon 16", "Ampharos 1",
  // "Deoxys 2", "Wobbuffet 16" and others all landing on a POP Series card
  // whenever several vintage sets held the same name and number. The POP sets
  // carry no ptcgoCode, so `?? ''` matched an absent hint and they won every
  // tie — not because they were likelier, but because they had no code.
  const byHint = hint
    ? matches.filter((m) => String(byId.get(m)?.ptcgoCode ?? '').toUpperCase() === hint
      || m.toUpperCase() === hint)
    : [];
  if (byHint.length === 1) {
    return mk(byHint[0], 'medium', 'set_code_hint', matches);
  }

  return none('ambiguous_no_printed_total', matches);
}
