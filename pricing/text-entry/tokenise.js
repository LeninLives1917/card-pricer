// pricing/text-entry/tokenise.js
//
// Turn a typed line into candidate INTERPRETATIONS, and refuse to choose
// between them.
//
// WHY NOT ANOTHER REGEX
//
// The shipped parser (apps/vendor/modules/text-parse.js) is an ordered cascade:
// the first pattern that matches wins, and the ordering is fixed at authoring
// time. That works until two legitimate readings share a shape, and then it
// silently picks one:
//
//   "MEG 172/132"   MEG is a set code
//   "cha 4/102"     cha is the start of a card name
//
// Identical shapes. The cascade calls both a set code, so "cha 4/102" comes
// out as name=null, set_code="CHA" — and "cha 4/102 nm" comes out with
// name="nm". No amount of regex ordering fixes that, because the line does not
// contain the answer. The CATALOGUE contains the answer: "cha" as a set code
// resolves to nothing, "cha" as a name prefix resolves to Charizard.
//
// So this module's job is to enumerate the readings, attach a prior to each,
// and hand them all to the resolver. It never decides. That is the same
// principle as pricing/set-resolve.js distrusting the model's set code and
// resolving on the fields that corroborate one another.
//
// THE SAME REASONING KILLS THE "ex" TRAP
//
// "Charizard ex 056/197" parses today as name="Charizard", set_code="EX",
// because "ex" is 2-5 alpha characters. EX is also a REAL set code (165 cards,
// ecard1), so a validity check waves it through — the TWM problem from
// docs/V3_BENCHMARK.md §18 in a new place. Emitting both readings means the
// catalogue settles it: there is no Charizard #56 in ecard1, and there is a
// Charizard ex at 056.
//
// Pure: no fs, no DOM, no network. Runs unchanged in Node and the browser.

/** Two-letter language tokens the parser recognises. Policy lives in pricing/languages.js. */
const LANG = new Set(['en', 'de', 'fr', 'es', 'it', 'pt', 'jp', 'ja', 'ko', 'zh', 'ru', 'nl']);

/** Grades as printed on a buy-list. Mapped to pricing/conditions.js downstream. */
const CONDITION = new Map([
  ['nm', 'NM'], ['mint', 'NM'], ['m', 'NM'],
  ['lp', 'LP'], ['ex', null], // 'ex' is far more often a name suffix — see below
  ['mp', 'MP'], ['hp', 'HP'], ['dmg', 'DMG'], ['damaged', 'DMG'],
  ['played', 'MP'], ['poor', 'DMG'],
]);

/**
 * Finish/variant words. These change the PRICE materially — a reverse holo and
 * a normal are different products on Cardmarket — and the price adapters
 * already accept card.variant. The parser has simply never extracted them.
 */
const FINISH = new Map([
  ['reverse', 'reverse_holo'], ['rev', 'reverse_holo'], ['revholo', 'reverse_holo'],
  ['holo', 'holo'], ['foil', 'holo'], ['nonholo', 'normal'], ['normal', 'normal'],
  ['1sted', 'first_edition'], ['1st', 'first_edition'], ['firsted', 'first_edition'],
  ['unlimited', 'unlimited'], ['shadowless', 'shadowless'],
]);

/**
 * Name suffixes that are NOT set codes, however much they look like one.
 * Measured: ~700 of 4,456 distinct catalogue names (15.7%) end in one of
 * these, and they carry 16.3% of catalogue value against 8.6% of cards — the
 * chase cards, where a mis-parse costs the most.
 */
const NAME_SUFFIX = new Set([
  'ex', 'v', 'vmax', 'vstar', 'gx', 'break', 'prime', 'star', 'lvx', 'vunion',
]);

const SET_TOKEN_RX = /^[A-Za-z][A-Za-z0-9-]{1,5}$/;
const NUM_TOTAL_RX = /^(\d{1,4})\s*\/\s*(\d{1,4})$/;
const BARE_NUM_RX = /^#?(\d{1,4})$/;
/** Promo and subset numbers that run letters into digits: XY03, SWSH063, TG16, GG31, RC5, H12. */
const ALNUM_NUM_RX = /^([A-Za-z]{1,4})(\d{1,4})$/;
/** The catalogue's own key form, e.g. sv3pt5-4. */
const CATALOGUE_KEY_RX = /^([a-z0-9]+(?:pt\d)?[a-z0-9]*)-([A-Za-z0-9]+)$/i;
const QTY_RX = /^(\d{1,3})\s*x$/i;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @typedef {Object} Interpretation
 * @property {string|null} name
 * @property {string|null} card_number  collector number, no denominator
 * @property {string|null} total        printed denominator when stated
 * @property {string|null} set_code
 * @property {string|null} lang
 * @property {number} qty
 * @property {string|null} condition
 * @property {string|null} finish
 * @property {number} prior             higher is a more likely reading
 * @property {string} shape             which reading this is, for counters
 */

/**
 * @param {string} line
 * @returns {{raw: string, interpretations: Interpretation[], unclaimed: string[]}}
 */
export function tokeniseLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return { raw: '', interpretations: [], unclaimed: [] };

  let words = raw.split(/\s+/);

  let qty = 1;
  let lang = null;
  let condition = null;
  let finish = null;
  let number = null;
  let total = null;
  let catalogueKey = null;

  // Quantity, leading only. "3x Charizard" — a trailing 3x is not a quantity,
  // it is somebody's shorthand for something else and guessing is not our job.
  const q = words[0]?.match(QTY_RX);
  if (q) { qty = parseInt(q[1], 10); words = words.slice(1); }

  // POSITION MATTERS, and losing it is a real defect rather than a nicety.
  //
  // "Team Rockets Crobat ex dri en 122/182 League Promo Stamp" is a line the
  // operator actually pastes. Words before the collector number are the name;
  // words after it are trailing annotations. Flatten the two together and the
  // name becomes "Team Rockets Crobat ex dri League Promo Stamp", which
  // matches nothing. So the number's position splits the leftovers.
  const pre = [];
  const post = [];
  const keep = () => (number == null ? pre : post);

  for (const w of words) {
    const lw = norm(w);

    const ck = w.match(CATALOGUE_KEY_RX);
    if (ck && !catalogueKey && /\d/.test(ck[1])) { catalogueKey = { setId: norm(ck[1]), number: ck[2] }; continue; }

    const nt = w.match(NUM_TOTAL_RX);
    if (nt && number == null) { number = nt[1]; total = nt[2]; continue; }

    if (LANG.has(lw) && lang == null) { lang = lw; continue; }

    // 'ex' is excluded from CONDITION on purpose: as a grade it is vanishingly
    // rare in this shop's input, and as a name suffix it is on ~700 names.
    // Treating it as a grade would re-create the very trap this module exists
    // to remove, from the other direction.
    if (CONDITION.has(lw) && CONDITION.get(lw) && condition == null) { condition = CONDITION.get(lw); continue; }
    if (FINISH.has(lw) && finish == null) { finish = FINISH.get(lw); continue; }

    keep().push(w);
  }

  // No "num/total" anywhere, so look for a bare collector number. Scan from
  // the RIGHT: a number late in the line is a collector number, a number at
  // the front is far more likely part of a name ("151", "1st").
  if (number == null) {
    for (let i = pre.length - 1; i >= 0; i -= 1) {
      const bare = pre[i].match(BARE_NUM_RX);
      if (bare) {
        number = bare[1];
        // Everything after it becomes trailing context, exactly as it would
        // have been had the number carried a denominator. This is what makes
        // the legacy "MEG 172 Pikachu" shape survive.
        post.push(...pre.splice(i + 1));
        pre.splice(i, 1);
        break;
      }
    }
  }

  const interpretations = [];
  const base = { lang, qty, condition, finish };

  if (catalogueKey) {
    interpretations.push({
      ...base, name: null, card_number: catalogueKey.number, total,
      set_code: catalogueKey.setId, prior: 1.0, shape: 'catalogue_key',
    });
  }

  const nameOf = (arr) => (arr.length ? arr.join(' ') : null);

  if (number != null) {
    const extras = post.length ? post.join(' ') : null;

    // READING 1 — everything before the number is the name, no set code was
    // typed. This is the show format: "cha 4/102", "charizard 4/102".
    if (pre.length) {
      interpretations.push({
        ...base, extras, name: nameOf(pre), card_number: number, total, set_code: null,
        prior: 0.9, shape: 'name_only',
      });
    }

    // READING 2 — the LAST word before the number is a set code, the rest is
    // the name. "Mystery Garden meg 172/132". Heavily penalised when that word
    // is a known name suffix, which is what stops "Charizard ex" losing its
    // "ex" to a set code that genuinely exists.
    if (pre.length >= 2) {
      const last = pre[pre.length - 1];
      if (SET_TOKEN_RX.test(last)) {
        interpretations.push({
          ...base, extras, name: nameOf(pre.slice(0, -1)), card_number: number, total,
          set_code: last.toUpperCase(),
          prior: NAME_SUFFIX.has(norm(last)) ? 0.2 : 0.85,
          shape: 'name_then_set',
        });
      }
    }

    // READING 3 — set first, then the number, then optionally the name. The
    // legacy V1 shape and what the UI still tells the operator to type:
    // "MEG 172/132" and "MEG 172 Pikachu".
    if (pre.length === 1 && SET_TOKEN_RX.test(pre[0])) {
      interpretations.push({
        ...base, extras: null, name: nameOf(post), card_number: number, total,
        set_code: pre[0].toUpperCase(),
        prior: 0.8, shape: 'set_then_name',
      });
    }
  } else if (pre.length) {
    const keep = pre;
    // No slash-number anywhere. A promo badge runs a code into digits or sits
    // beside them: "SVP 056", "MEP 031", "XY03". Split on the separator and
    // keep the digits — the badge and the number are separate elements on the
    // card, which is why one has a gap and the other does not.
    const last = keep[keep.length - 1];
    const alnum = last.match(ALNUM_NUM_RX);
    if (alnum) {
      interpretations.push({
        ...base, name: nameOf(keep.slice(0, -1)), card_number: alnum[2], total: null,
        set_code: alnum[1].toUpperCase(), prior: 0.7, shape: 'promo_run_together',
      });
      // ...but a run-together token can also BE the number ("XY03" is printed
      // as one thing). Both readings go forward.
      interpretations.push({
        ...base, name: nameOf(keep.slice(0, -1)), card_number: last, total: null,
        set_code: null, prior: 0.5, shape: 'promo_whole_token',
      });
    }
  }

  interpretations.sort((a, b) => b.prior - a.prior);
  return { raw, interpretations, unclaimed: pre };
}

export { NAME_SUFFIX, FINISH, CONDITION };
