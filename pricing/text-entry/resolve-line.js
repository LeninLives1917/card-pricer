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

import { resolveIdentity } from '../set-resolve.js';
import { resolveTypedName, normName } from '../name-index.js';

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
    const bucket = m.get(k);
    if (bucket) bucket.push(key.slice(0, dash));
    else m.set(k, [key.slice(0, dash)]);
  }
  return m;
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
  const plausible = nameHit.names.filter((n) => nameNumberIndex.has(n + '|' + num));
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
    const r = resolveIdentity({ name: printed, card_number: withTotal, set_code: line?.set_code }, cardDb);
    if (r.id) resolved.push({ r, n });
    else abstained.push(...(r.candidates || []).map((setId) => `${setId}-${num}`));
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
      name_match: nameHit.how,
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
      name_match: nameHit.how,
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
    name_match: nameHit.how,
  };
}
