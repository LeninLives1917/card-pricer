// pricing/text-entry/resolve-line.js
//
// Turn one typed line into either a card, or an honest question.
//
// This is the piece that makes the show format work:
//
//   cha 4/102        ->  base1-4  Charizard (Base)
//   bla 2/132        ->  ASK: Blastoise (Secret Wonders) or Blaine's Charizard?
//   xyz 1/1          ->  not found
//
// WHAT IT DOES NOT DO
//
// It does not re-implement identity resolution. pricing/set-resolve.js already
// does that, and it is the only part of this system with a measured accuracy
// number attached (identity 49.0% -> 68.6%, precision 61% -> 97.2% across 51
// photographs, docs/V3_BENCHMARK.md §18). Re-deriving that logic here would
// throw the measurement away. So this module only decides WHICH NAMES to ask
// about, and hands each one to resolveIdentity.
//
// THE ORDER IS THE DESIGN
//
// Exact name first, prefix only if exact found nothing. Somebody who types
// "Charizard" means Charizard, not Charizard ex — so widening on an exact hit
// would manufacture ambiguity that the operator did not have. Widening when
// exact fails is what lets "cha" and "Charizard" travel one code path.
//
// AMBIGUITY IS AN ANSWER, NOT A FAILURE
//
// 63 of the 102 ambiguous "first 3 + num/total" groups are different Pokemon
// (bla|2|132 is Blastoise or Blaine's Charizard, and the price gap is large).
// Returning one of them would be the first-hit-wins defect this project has
// spent its history removing. Candidates go back; a human picks.

import { resolveIdentity, printedTotalOf, loadSets } from '../set-resolve.js';
import { resolveTypedName, normName } from '../name-index.js';
import { resolveSetCode } from '../set-aliases.js';

/**
 * Index of (normalised name, collector number) -> set ids.
 *
 * Exists purely to prune. A three-letter prefix can front 30+ names, and
 * resolveIdentity walks the whole catalogue per call, so asking it about every
 * candidate would be tens of scans for one line. This answers "does this name
 * even have a card at that number?" in O(1) and typically leaves one name for
 * resolveIdentity to rule on properly.
 *
 * @param {Map|object} cardDb key `${set_id}-${number}` -> { name, ... }
 */
export function buildNameNumberIndex(cardDb) {
  const entries = cardDb instanceof Map ? cardDb : new Map(Object.entries(cardDb || {}));
  const m = new Map();
  for (const [key, v] of entries) {
    const dash = key.lastIndexOf('-');
    if (dash < 1) continue;
    const num = key.slice(dash + 1).replace(/^0+(?=.)/, '').toLowerCase();
    const k = normName(v?.name) + '|' + num;
    // Store the REAL catalogue key, not a set id to rebuild an id from.
    //
    // set-resolve.js composes its answer as `${setId}-${normalisedNumber}`,
    // and that normalisation lowercases. For a purely numeric collector
    // number that round-trips fine. For an alphanumeric one it does not:
    // the catalogue key is `xyp-XY03` and the rebuilt id is `xyp-xy03`, so
    // the lookup that follows misses and the card comes back with a null
    // name — resolved, and unusable. Keeping the real key sidesteps the
    // reconstruction entirely.
    const bucket = m.get(k);
    if (bucket) bucket.push(key);
    else m.set(k, [key]);
  }
  return m;
}

/**
 * Map an id composed by set-resolve.js back to the key the catalogue really
 * uses. Identical for numeric numbers; differs in case for alphanumeric ones.
 */
function realKeyFor(id, nameNumberIndex, normalisedName, num) {
  const bucket = nameNumberIndex.get(normalisedName + '|' + num);
  if (!bucket) return id;
  const wantSet = id.slice(0, id.lastIndexOf('-')).toLowerCase();
  return bucket.find((k) => k.slice(0, k.lastIndexOf('-')).toLowerCase() === wantSet) ?? id;
}

/** printedTotal for a set id, from the same reference file set-resolve.js uses. */
let _totals = null;
function printedTotalFor(setId) {
  if (!_totals) _totals = new Map(loadSets().map((x) => [x.id, x.printedTotal]));
  return _totals.get(setId) ?? null;
}

const cleanNum = (n) => String(n ?? '').trim().replace(/\/.*$/, '').replace(/^0+(?=.)/, '').toLowerCase();

/**
 * @param {object} line   {name, card_number, total, set_code}
 * @param {object} deps   {cardDb, nameIndex, nameNumberIndex}
 * @returns {{
 *   status: 'resolved'|'ambiguous'|'not_found'|'need_more',
 *   card_id: string|null, confidence: string, reason: string,
 *   candidates: Array<{id, set_id, name, set_name, card_number}>,
 *   matched_name: string|null, name_match: string
 * }}
 */
export function resolveLine(line, { cardDb, nameIndex, nameNumberIndex }) {
  const num = cleanNum(line?.card_number);
  // The denominator does most of the work, so carry it into resolveIdentity in
  // the shape it expects ("4/102"), whether the parser split it out or not.
  const withTotal = line?.total ? `${num}/${line.total}`
    : (String(line?.card_number ?? '').includes('/') ? String(line.card_number) : num);

  const none = (status, reason, candidates = []) => ({
    status, card_id: null, confidence: 'low', reason, candidates,
    matched_name: null, name_match: 'none',
  });

  if (!num) return none('need_more', 'no_card_number');

  const hydrateEarly = (id) => {
    const v = (cardDb instanceof Map ? cardDb.get(id) : cardDb?.[id]) || {};
    return { id, set_id: id.slice(0, id.lastIndexOf('-')), name: v.name ?? null,
      set_name: v.setName ?? null, card_number: id.slice(id.lastIndexOf('-') + 1) };
  };

  // SET CODE + NUMBER, no name. The legacy shape the UI still asks for
  // ("MEG 172", "PFL 94") and the catalogue's own key form. Measured 100%
  // unique — the key IS set id plus number — so when it hits, it hits
  // exactly, and there is nothing for the name machinery to add.
  if (!normName(line?.name) && line?.set_code) {
    const setId = resolveSetCode(String(line.set_code)).setId;
    // CASE. cleanNum lowercases, but catalogue keys preserve the collector
    // number's case — swsh12tg-TG19, ex10-V, swsh45sv-SV064. Looking up
    // "swsh12tg-tg19" missed every one of the 1,646 cards whose number is not
    // pure digits, which is the whole Trainer Gallery / Shiny Vault / Galarian
    // Gallery / Unown population. Try the lowercased form first, since that is
    // what most keys use, then the number exactly as typed.
    const has1 = (k) => (cardDb instanceof Map
      ? cardDb.has(k)
      : Object.prototype.hasOwnProperty.call(cardDb || {}, k));
    const rawNum = String(line?.card_number ?? '').trim().replace(/\/.*$/, '').replace(/^0+(?=.)/, '');
    let id = `${setId}-${num}`;
    let has = has1(id);
    if (!has && rawNum && rawNum !== num) {
      const alt = `${setId}-${rawNum}`;
      if (has1(alt)) { id = alt; has = true; }
      else {
        const up = `${setId}-${rawNum.toUpperCase()}`;
        if (has1(up)) { id = up; has = true; }
      }
    }
    if (has) {
      // THE DENOMINATOR REFUTES THE SET CODE, exactly as it refutes a model's
      // set-code guess in set-resolve.js §18.
      //
      // This path is a bare key lookup and used to skip that check entirely,
      // which made it the most dangerous rung in the whole resolver: it
      // carries the highest evidence rank (set id + number is unique BY
      // CONSTRUCTION) so it outranks every name reading, and it was the one
      // rung not checking anything.
      //
      // Measured: "gri 75/127" returned Mudbray from Guardians Rising. GRI is
      // a real alias for sm2, sm2-75 is a real card — and Guardians Rising
      // has 145 cards, not 127. The line said 127, which is Platinum, where
      // 75 is Grimer. The correct reading was right there and was outranked.
      // "por 104/147" did the same thing: POR aliases to Perfect Order (88
      // cards) and returned Mega Zygarde ex instead of Porygon2.
      //
      // A three-letter prefix and a three-letter set code look identical. The
      // typed total is what tells them apart.
      const printed = printedTotalOf(line?.total ? `${num}/${line.total}` : line?.card_number);
      const actual = printedTotalFor(setId);
      if (printed != null && actual != null && printed !== actual) {
        return none('set_code_contradicts_printed_total');
      }
      return {
        status: 'resolved', card_id: id, confidence: 'high', reason: 'set_code_and_number',
        contradiction: false, candidates: [hydrateEarly(id)], matched_name: null,
        name_match: 'none',
        // Did the typed denominator actually AGREE with this set's size, or
        // was there simply no denominator to disagree with? The two are very
        // different amounts of evidence and the ranking depends on knowing
        // which happened — see rankOf in resolveTypedLine.
        corroborated_by_total: printed != null && actual != null && printed === actual,
      };
    }
    return none('not_found', 'set_code_and_number_not_in_catalogue');
  }

  const nameHit = resolveTypedName(nameIndex, line?.name);
  if (nameHit.how === 'too_short') {
    return none('need_more', 'name_prefix_too_short');
  }
  if (!nameHit.names.length) {
    // No name at all is a legitimate shape — "4/102" on its own. It resolves
    // only when the denominator alone is decisive, which it is for 46% of the
    // catalogue, so it is worth trying rather than rejecting.
    if (!normName(line?.name)) {
      return none('need_more', 'no_name_and_number_alone_is_not_enough');
    }
    return none('not_found', 'name_not_in_catalogue');
  }

  // Prune to names that actually have a card at this number.
  let plausible = nameHit.names.filter((n) => nameNumberIndex.has(n + '|' + num));
  let nameMatch = nameHit.how;

  // AN EXACT HIT THAT GOES NOWHERE MUST STILL WIDEN.
  //
  // "exact does not widen" is about PREFERENCE, not exclusivity: somebody
  // typing "Charizard" means Charizard rather than Charizard ex, so offering
  // both would invent an ambiguity they did not have. But if the exact name
  // has no card at the typed number, preferring it means preferring nothing.
  //
  // Measured: "eri 103/132" came back not_found. There is a card literally
  // named "Eri", so "eri" matched EXACTLY, had no card at 103, and stopped —
  // while "Erika's Kindness" sat at Gym Challenge 103 with a printed total of
  // 132, which is exactly what was typed. A three-letter prefix that happens
  // to also be a whole card name should not be worse off than one that isn't.
  if (!plausible.length && nameHit.how === 'exact') {
    const widened = resolveTypedName(nameIndex, line?.name, { forcePrefix: true });
    const retry = widened.names.filter((n) => nameNumberIndex.has(n + '|' + num));
    if (retry.length) { plausible = retry; nameMatch = widened.how; }
  }

  // AN EXACT HIT THAT GOES SOMEWHERE MUST STILL LOOK AROUND.
  //
  // The preference above is right when the operator typed a whole name:
  // "Charizard 4/102" means Charizard, and offering Charizard ex too would
  // invent an ambiguity they did not have. It is wrong when the typed token is
  // a three-letter PREFIX that merely happens to also be a card name, because
  // then the preference is an accident of the catalogue rather than a reading
  // of the input.
  //
  // Measured, whole catalogue:
  //   "hop 133/159"   -> Hop [Crown Zenith], because "Hop" is a name, so
  //                      Hop's Rookidee [Journey Together] was never looked at
  //                      — and BOTH sets have 159 cards with a 133.
  //   "Venusaur ex 1" -> Venusaur [Pokemon Rumble], because "Venusaur" is a
  //                      name, so Venusaur ex was never looked at.
  //
  // So widen anyway, but only ADD names that have a card at this same number.
  // A widened name with no card at the number is not a rival and must not
  // become a question. Where only the exact match survives, the preference is
  // unchanged and nothing is asked.
  if (plausible.length && nameHit.how === 'exact') {
    const widened = resolveTypedName(nameIndex, line?.name, { forcePrefix: true });
    const rivals = widened.names.filter((n) => !plausible.includes(n)
      && nameNumberIndex.has(n + '|' + num));
    if (rivals.length) plausible = plausible.concat(rivals);
  }

  if (!plausible.length) {
    return none('not_found', nameHit.how === 'exact'
      ? 'name_known_but_not_at_that_number'
      : 'no_prefix_match_at_that_number');
  }

  // Ask the measured resolver about each survivor.
  const hydrate = (id) => {
    const v = (cardDb instanceof Map ? cardDb.get(id) : cardDb?.[id]) || {};
    return { id, set_id: id.slice(0, id.lastIndexOf('-')), name: v.name ?? null,
      set_name: v.setName ?? null, card_number: id.slice(id.lastIndexOf('-') + 1) };
  };

  const resolved = [];
  const abstained = [];
  for (const n of plausible) {
    const printed = (nameIndex.byNorm.get(n) || [n])[0];
    // strictPrintedTotal: a HUMAN typed this denominator, so a set whose size
    // disagrees with it is not the set they are holding. The photo path keeps
    // the lenient default, where a model misreads totals often enough that
    // discarding an otherwise-unique match would cost more than it saves.
    const r = resolveIdentity(
      { name: printed, card_number: withTotal, set_code: line?.set_code },
      cardDb,
      { strictPrintedTotal: true },
    );
    if (r.id) resolved.push({ r: { ...r, id: realKeyFor(r.id, nameNumberIndex, n, num) }, n });
    else abstained.push(...(r.candidates || []).map((setId) => realKeyFor(setId + '-' + num, nameNumberIndex, n, num)));
  }

  if (resolved.length === 1) {
    const { r, n } = resolved[0];
    return {
      status: 'resolved',
      card_id: r.id,
      confidence: r.confidence,
      reason: r.reason,
      contradiction: r.contradiction,
      candidates: [hydrate(r.id)],
      matched_name: n,
      name_match: nameMatch,
    };
  }

  if (resolved.length > 1) {
    // Different Pokemon sharing a prefix, a number and a set size. This is the
    // bla|2|132 case and it is exactly what must not be guessed.
    return {
      status: 'ambiguous',
      card_id: null,
      confidence: 'low',
      reason: 'prefix_matches_several_cards',
      candidates: resolved.map(({ r }) => hydrate(r.id)),
      matched_name: null,
      name_match: nameMatch,
    };
  }

  // Nothing resolved, but the resolver offered candidates it could not choose
  // between — usually the printed total disagreeing with every set. Surface
  // them rather than reporting a bare miss; the operator can see the shape.
  const uniq = [...new Set(abstained)];
  return {
    status: uniq.length ? 'ambiguous' : 'not_found',
    card_id: null,
    confidence: 'low',
    reason: uniq.length ? 'resolver_could_not_choose' : 'no_identity',
    candidates: uniq.map(hydrate),
    matched_name: null,
    name_match: nameMatch,
  };
}

/**
 * Resolve a RAW typed line by trying every reading the tokeniser produced.
 *
 * This is where "the parser does not decide" becomes true in practice.
 * `cha 4/102` and `MEG 172/132` are the same shape, so the tokeniser emits
 * both readings of each and this walks them in prior order until the
 * catalogue accepts one. "cha" as a set code resolves to nothing; "cha" as a
 * name prefix resolves to Charizard. The line never had the answer — the
 * catalogue did.
 *
 * Ambiguity is preserved rather than resolved by ordering. If a reading comes
 * back ambiguous it is remembered, but the remaining readings are still tried:
 * a later one may resolve cleanly, and a clean resolution beats a question.
 * Only if nothing resolves does the ambiguity become the answer.
 *
 * @param {string} raw
 * @param {{cardDb, nameIndex, nameNumberIndex, tokenise?}} deps
 * @returns {object} a resolveLine result, plus {shape, interpretation, tried}
 */
export function resolveTypedLine(raw, deps, opts = {}) {

  const tokenise = deps.tokenise ?? _tokeniseLine;
  const { interpretations } = tokenise(raw);

  if (!interpretations.length) {
    // A line the tokeniser cannot read AT ALL is the strongest signal that it
    // is not one card. "chi179167guz143147" produces no reading, because no
    // single card has two names and two numbers in it.
    const split = trySplit(raw, deps, opts, 0);
    if (split) return split;
    return {
      status: 'need_more', card_id: null, confidence: 'low',
      reason: 'no_interpretation', candidates: [], matched_name: null,
      name_match: 'none', shape: null, interpretation: null, tried: 0,
    };
  }

  // EVIDENCE DECIDES, NOT ORDER.
  //
  // Taking the first reading that resolves is not good enough, and the case
  // that proved it is "MEG 172/132". "meg" is a legitimate three-letter
  // prefix of "Mega Audino ex", which has a card at 172 — so the name reading
  // resolved first and returned an Ascended Heroes card. MEG is also a real
  // set code for Mega Evolution, where 172 is Mystery Garden. Both readings
  // resolve; one is far better founded.
  //
  // So every reading is resolved and then ranked by how strong the evidence
  // that resolved it actually is. Set id plus number is unique BY
  // CONSTRUCTION (it is the catalogue key) and measured 100%; an exact name
  // with a printed total measured 99.6%; a three-letter prefix 99.0%; a typo
  // correction is weaker still. That ordering is a property of the data, not
  // a preference.
  // A CORRECTION, from a wrong answer the operator caught.
  //
  // "scr065" returned Alcremie — SCR is Stellar Crown and sv7-65 is a real
  // card. It is Scream Tail, svp-65, and "scr" is the start of the name.
  //
  // Both readings resolve, and the set-code one was winning because it was
  // ranked top for being "unique by construction, 100%". That figure justifies
  // "GIVEN SCR is a set code, set + number identifies one card". It says
  // nothing about whether SCR IS a set code rather than the first three
  // letters of a name — and that second claim was the one being decided.
  // Evidence for one was used to settle the other.
  //
  // So the set-code reading only outranks everything when the typed
  // denominator AGREED with that set's size. "MEG 172/132" has that: me1 has
  // 132 cards, so the code is corroborated and Mystery Garden wins. "scr065"
  // has no denominator at all, so the code is merely possible — it ranks
  // level with a name prefix, ties, and the line becomes a question.
  //
  // A catalogue key ("sv3pt5-4") keeps the top rank: it is not a guess about
  // what the letters mean, it is the key itself.
  const EVIDENCE = { none: 4, exact: 3, prefix: 2, fuzzy: 1 };
  const rankOf = (r) => {
    if (r.shape === 'catalogue_key') return 5;
    if (r.reason === 'set_code_and_number') return r.corroborated_by_total ? 5 : 2;
    return EVIDENCE[r.name_match] ?? 0;
  };

  const resolvedAll = [];
  let firstAmbiguous = null;
  let firstNotFound = null;
  let tried = 0;

  for (const interp of interpretations) {
    tried += 1;
    const r = resolveLine(interp, deps);
    if (r.status === 'resolved') {
      resolvedAll.push({ ...r, shape: interp.shape, interpretation: interp });
      continue;
    }
    if (r.status === 'ambiguous' && !firstAmbiguous) {
      firstAmbiguous = { ...r, shape: interp.shape, interpretation: interp };
    }
    if (!firstNotFound) firstNotFound = { ...r, shape: interp.shape, interpretation: interp };
  }

  if (resolvedAll.length) {
    resolvedAll.sort((a, b) => (rankOf(b) - rankOf(a))
      || ((b.interpretation?.prior ?? 0) - (a.interpretation?.prior ?? 0)));
    const best = resolvedAll[0];
    const rivals = resolvedAll.filter((r) => r.card_id !== best.card_id);

    // Two readings of the same line pointing at DIFFERENT cards on evidence of
    // the same strength is a genuine question, not something to break with a
    // tiebreak nobody can defend.
    // A SET CODE THAT IS ALSO A NAME PREFIX, where the denominator happens to
    // corroborate BOTH readings.
    //
    // "mew 19/165" — MEW aliases to the 151 set, whose printed total is 165.
    // Expedition Base Set is ALSO 165. So the denominator agrees with the
    // set-code reading, which lifts it to rank 5, and it returns
    // sv3pt5-19 Rattata — a card with no relationship to anything typed. The
    // rival reading returns ecard1-19 Mew, whose name is exactly what was
    // typed, and was outranked.
    //
    // The corroboration test added for "scr065" asks whether the denominator
    // agrees with the set. It cannot tell agreement from coincidence when two
    // sets share a printed total. What distinguishes the readings is that one
    // of them produced a card whose NAME matches the typed token and the other
    // did not — direct evidence about the card, versus evidence about a set.
    //
    // Measured across the whole catalogue: this is 4 of the 6 remaining wrong
    // answers in 20,493 lines. Turning them into questions costs 4 asks.
    const nameRival = rivals.find((r) => r.name_match === 'exact' || r.name_match === 'prefix');
    if (best.reason === 'set_code_and_number' && nameRival) {
      const seen = new Set();
      const candidates = [];
      for (const r of resolvedAll) {
        for (const c of r.candidates) if (!seen.has(c.id)) { seen.add(c.id); candidates.push(c); }
      }
      return {
        ...best, status: 'ambiguous', card_id: null, confidence: 'low',
        reason: 'set_code_or_name', candidates, tried,
        rival_shapes: resolvedAll.map((r) => r.shape),
      };
    }

    if (rivals.length && rankOf(rivals[0]) === rankOf(best)) {
      const seen = new Set();
      const candidates = [];
      for (const r of resolvedAll) {
        for (const c of r.candidates) if (!seen.has(c.id)) { seen.add(c.id); candidates.push(c); }
      }
      return {
        ...best, status: 'ambiguous', card_id: null, confidence: 'low',
        reason: 'readings_disagree', candidates, tried,
        rival_shapes: resolvedAll.map((r) => r.shape),
      };
    }
    return { ...best, tried, outranked: rivals.map((r) => r.shape + ':' + r.card_id) };
  }

  // TWO OR MORE CARDS IN ONE TOKEN, tried LAST and only after the line has
  // failed to resolve as a single card.
  //
  // "chi179167guz143147" is chi 179/167 and guz 143/147 with nothing between
  // them. But "hisgg01gg70" has the same shape — letters, digits, letters,
  // digits — and is ONE card: Hisuian Voltorb GG01 out of GG70, where the
  // second group is the printed total. Splitting on shape alone got that
  // wrong, which is the cascade's mistake again: deciding from the token when
  // only the catalogue knows.
  //
  // So the order does the deciding. If it resolves as one card, it is one
  // card. Only a line the catalogue cannot make sense of whole is offered as
  // a split, with the pieces already resolved so the operator sees what it
  // found rather than an error to diagnose.
  const split = trySplit(raw, deps, opts, tried);
  if (split) return split;

  // A question beats a bare miss: candidates tell the operator what the system
  // was looking at, a "not found" tells them nothing.
  const out = firstAmbiguous ?? firstNotFound;
  return { ...out, tried };
}

// Imported lazily-by-default so this module stays usable with an injected
// tokeniser in tests (mock.module is banned; injection is the seam).
import { tokeniseLine as _tokeniseLine, splitRunTogetherCards as _splitRunTogetherCards } from './tokenise.js';

/**
 * Offer a line as several cards, when and only when it cannot be one.
 *
 * "chi179167guz143147" is chi 179/167 and guz 143/147 with nothing between
 * them. But "hisgg01gg70" has the SAME SHAPE — letters, digits, letters,
 * digits — and is one card: Hisuian Voltorb GG01 out of GG70, where the
 * second group is the printed total. Splitting on shape alone got that wrong,
 * which is the cascade's mistake again: deciding from the token when only the
 * catalogue knows.
 *
 * So this runs LAST, on lines that failed to resolve whole, and only returns
 * a split that actually explains something. Order does the deciding.
 */
function trySplit(raw, deps, opts, tried) {
  if (opts?.noSplit) return null;
  const pieces = _splitRunTogetherCards(String(raw ?? '').trim());
  if (pieces.length < 2) return null;

  const resolved = pieces.map((p) => ({ text: p, r: resolveTypedLine(p, deps, { noSplit: true }) }));
  if (!resolved.some((x) => x.r.status === 'resolved')) return null;

  return {
    status: 'multi', card_id: null, confidence: 'low',
    reason: `line_contains_${pieces.length}_cards`,
    candidates: [], matched_name: null, name_match: 'none',
    shape: 'run_together_multi', interpretation: null, tried,
    pieces: resolved.map(({ text, r }) => ({
      text, status: r.status, card_id: r.card_id, candidates: r.candidates,
    })),
  };
}
