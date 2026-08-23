// pricing/name-index.js
//
// Resolve what somebody TYPED to the card names the catalogue actually holds.
//
// Pure, dependency-free, no fs and no DOM, so the same module runs in Node and
// in the browser. The repo has no bundler and no build step; keep it that way.
//
// WHY A PREFIX INDEX
//
// At a show the operator is holding the card and typing against the clock.
// Full names are long, easy to misspell, and several of the most valuable ones
// are the worst offenders — Garganacle, Wugtrio, Sudowoodo, Mismagius. So the
// question is how much of the name is actually load-bearing.
//
// MEASURED over all 20,546 catalogue cards, uniquely-identified share:
//
//   "4/102"           number + printed total, no name at all      46.0%
//   "ch 4/102"        first 2 letters                             98.3%
//   "cha 4/102"       first 3 letters                             99.0%
//   "char 4/102"      first 4 letters                             99.2%
//   "charizard 4/102" the whole name                              99.6%
//
// Three letters costs 0.6 points against typing the lot, and letters four
// through six buy 0.2 combined. The printed denominator is doing the work; the
// name prefix is only there to break the 54% of cases the denominator cannot.
//
// WHAT THE RESIDUAL LOOKS LIKE, because a 99% that fails badly is not a 99%.
//
// 102 groups (206 cards) are ambiguous under "first 3 + num/total". 63 of them
// are DIFFERENT POKEMON sharing a prefix, and they are exactly the ones you
// would not want guessed:
//
//   bla|2|132   Blastoise (Secret Wonders)  vs  Blaine's Charizard (Gym Challenge)
//   rai|3|17    Raichu (POP 9)              vs  Raikou (POP 2)
//   man|8|100   Manectric (Crystal Guardians) vs Manaphy (Majestic Dawn)
//
// Blaine's Charizard is worth many times a Secret Wonders Blastoise. So a
// prefix hit that lands on more than one name MUST return the candidates and
// let a human choose. HP alone splits 46 of those 63, which makes it a useful
// tiebreaker but not a licence to auto-accept.
//
// Owner-prefix names are why the collisions cluster where they do: "bla" is
// Blaine's, not the Pokemon. The prefix carries no species information at all
// on those cards, which is a known limitation rather than something to paper
// over with a heuristic.

/** Below this, a prefix matches so much of the catalogue it is not evidence. */
export const MIN_PREFIX = 3;

/**
 * Fold a name the same way pricing/set-resolve.js does (:69), so a name that
 * resolves here also resolves there. Strips everything but a-z0-9, which is
 * what makes "Umbreon GX" match the catalogue's "Umbreon-GX" and
 * "Farfetch'd" match "Farfetchd".
 */
export const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param {Iterable<string>} names  every distinct card name in the catalogue
 * @returns {{sorted: string[], byNorm: Map<string, string[]>, size: number}}
 */
export function buildNameIndex(names) {
  const byNorm = new Map();
  for (const raw of names) {
    const n = normName(raw);
    if (!n) continue;
    const bucket = byNorm.get(n);
    // One normalised form can front several printed spellings
    // ("Umbreon-GX" / "Umbreon GX"). Keep them all; the caller decides.
    if (bucket) { if (!bucket.includes(raw)) bucket.push(raw); }
    else byNorm.set(n, [raw]);
  }
  // A sorted array plus binary search beats a Map of every prefix: 4,456 names
  // would otherwise mean tens of thousands of prefix keys, and the whole point
  // of this module is that it can be shipped to a phone.
  const sorted = [...byNorm.keys()].sort();
  return { sorted, byNorm, size: sorted.length };
}

/** First index whose value is >= target. */
function lowerBound(arr, target) {
  let lo = 0; let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Every normalised catalogue name starting with `prefix`.
 *
 * @param {object} index    from buildNameIndex
 * @param {string} prefix   what the operator typed, normalised internally
 * @param {{limit?: number, minPrefix?: number}} [opts]
 * @returns {string[]} normalised names, in catalogue order
 */
export function namesWithPrefix(index, prefix, opts = {}) {
  const { limit = 50, minPrefix = MIN_PREFIX } = opts;
  const p = normName(prefix);
  if (!p || p.length < minPrefix) return [];
  const { sorted } = index;
  const start = lowerBound(sorted, p);
  const out = [];
  for (let i = start; i < sorted.length && sorted[i].startsWith(p); i += 1) {
    out.push(sorted[i]);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Resolve typed text to candidate catalogue names, widening only as far as it
 * has to.
 *
 * The order matters and is the whole design. An exact hit is not improved by
 * also offering everything that starts with it: somebody who types "Charizard"
 * means Charizard, not Charizard ex. Widening happens only when the exact
 * lookup found nothing, which is what makes "cha" and "Charizard" both behave
 * sensibly through one code path.
 *
 * @returns {{names: string[], how: 'exact'|'prefix'|'too_short'|'none', ambiguous: boolean}}
 */
export function resolveTypedName(index, typed, opts = {}) {
  const n = normName(typed);
  if (!n) return { names: [], how: 'none', ambiguous: false };

  if (index.byNorm.has(n)) {
    return { names: [n], how: 'exact', ambiguous: false };
  }

  const minPrefix = opts.minPrefix ?? MIN_PREFIX;
  if (n.length < minPrefix) {
    // Deliberately distinct from 'none'. "Too short to be evidence" and
    // "no such card" are different answers and the counters must not merge
    // them — one is the operator's input, the other is the catalogue's.
    return { names: [], how: 'too_short', ambiguous: false };
  }

  const names = namesWithPrefix(index, n, opts);
  if (names.length) return { names, how: 'prefix', ambiguous: names.length > 1 };

  // Last resort: a typo. Measured need — on the operator's own 12-line paste,
  // "Garganacle ex" is one insertion away from the catalogue's "Garganacl ex",
  // and that single line was the only one of twelve that failed to resolve.
  //
  // A correction is never applied on the strength of the name alone. The
  // caller still has to see the collector number and printed total agree, and
  // reports name_match: 'fuzzy' so the result can be flagged rather than
  // presented as if it had been typed correctly.
  if (opts.fuzzy !== false) {
    const near = namesWithinEdit(index, n);
    if (near.names.length) {
      return { names: near.names, how: 'fuzzy', ambiguous: near.names.length > 1,
        distance: near.distance };
    }
  }

  return { names: [], how: 'none', ambiguous: false };
}

/**
 * Levenshtein distance, abandoning as soon as it cannot come in at or under
 * `max`. The early exit is what makes it affordable to run against every name
 * in the catalogue instead of maintaining a second index.
 */
export function editDistanceWithin(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    // No cell in this row is within budget, and distance never decreases as
    // rows advance, so nothing below can be either.
    if (rowMin > max) return max + 1;
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

/**
 * How far a typo may be from a real name, by length.
 *
 * Short names are dense: at distance 1, Mew reaches Mow, Mew, Men and Muk is
 * two away from Mew. Allowing the same budget on a three-letter name as on
 * "Charizard" would turn a typo-fixer into a card-swapper, and swapping Mew
 * for Muk is a real price error. So the budget scales with length and short
 * names get none at all.
 */
export function editBudget(len) {
  if (len < 6) return 0;
  if (len < 10) return 1;
  return 2;
}

/**
 * Nearest catalogue names within the length-appropriate edit budget.
 *
 * Runs only when exact and prefix have both failed, so the full scan costs
 * nothing on the common path. Returns ALL names at the best distance found —
 * a tie is ambiguity and the caller must not be handed a winner.
 */
export function namesWithinEdit(index, typed) {
  const q = normName(typed);
  const budget = editBudget(q.length);
  if (!q || budget === 0) return { names: [], distance: null };

  let best = budget + 1;
  let names = [];
  for (const n of index.sorted) {
    const d = editDistanceWithin(q, n, best === budget + 1 ? budget : best);
    if (d > budget) continue;
    if (d < best) { best = d; names = [n]; }
    else if (d === best && !names.includes(n)) names.push(n);
  }
  return { names, distance: names.length ? best : null };
}

/** Printed spellings for a normalised name, for display. */
export function printedForms(index, normalised) {
  return index.byNorm.get(normalised) ?? [];
}
