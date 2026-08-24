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
/**
 * Put the line into a shape the word-splitter can read, WITHOUT deciding
 * anything about it.
 *
 * People type "4/102", "4 / 102" and "cha4/102" and mean the same card. The
 * tokeniser splits on whitespace, so those arrive as one token, three tokens
 * and one glued token respectively — three different parses of one intent.
 * That is a keyboard problem, not an ambiguity, and it is the only kind of
 * rewriting done here: nothing below changes which readings are possible, it
 * only stops the splitter mangling them.
 */
export function normaliseSpacing(s) {
  return String(s ?? '')
    .trim()
    // "4 / 102" and "4/ 102" -> "4/102". Spaces around a slash are never
    // meaningful; a collector number is one thing.
    .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
    // "cha4/102" and "MEG172/132" -> "cha 4/102". A letter run flush against
    // a numerator is two tokens typed without the space.
    .replace(/([A-Za-z])(\d{1,4}\/\d{1,4})/g, '$1 $2')
    .replace(/\s+/g, ' ');
}

/**
 * A whole card jammed into one token, with no separators at all.
 *
 *   gya028203    -> gya  028/203
 *   lux47122     -> lux  47/122
 *   chasm195     -> cha  SM195
 *   galswsh283   -> gal  SWSH283
 *   hisgg01gg70  -> his  GG01/GG70
 *
 * This is a real operator format — pasted from a scanner or a spreadsheet
 * where the delimiters were lost. Every one of these produced NOTHING before
 * this existed, because the word-splitter had nothing to split on.
 *
 * It is the same problem as "cha 4/102" versus "MEG 172/132" with the spaces
 * removed, so it gets the same answer: enumerate the plausible splits, attach
 * priors, and let the catalogue decide. Guessing a single split would be the
 * cascade's mistake in a new costume — "lux47122" is 47/122 or 471/22 and the
 * token does not say which.
 *
 * @returns {Array<{name, card_number, total, set_code, prior, shape}>}
 */
/**
 * Promo badges that appear glued to their number. Used to repair a typo in
 * the badge, which the catalogue cannot forgive: "mewswssh223" is Mew
 * SWSH223 with an extra S, and SWSSH223 matches nothing at all.
 *
 * Only these, and only at distance 1 — a badge is 2-4 characters, so a looser
 * budget would turn SM into SVP and quietly change the set.
 */
const PROMO_BADGES = ['swsh', 'sm', 'xy', 'svp', 'bw', 'dp', 'hgss', 'gg', 'tg', 'rc', 'mep', 'me'];

function repairBadge(letters) {
  const l = letters.toLowerCase();
  if (PROMO_BADGES.includes(l)) return null; // already fine
  for (const b of PROMO_BADGES) {
    if (Math.abs(b.length - l.length) > 1) continue;
    if (editDistance1(l, b)) return b.toUpperCase();
  }
  return null;
}

/** True when a and b are exactly one edit apart. Cheap, bounded, no matrix. */
function editDistance1(a, b) {
  if (a === b) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [s, t] = a.length < b.length ? [a, b] : [b, a];
  let i = 0; let j = 0; let skipped = 0;
  while (i < s.length && j < t.length) {
    if (s[i] === t[j]) { i += 1; j += 1; continue; }
    if (++skipped > 1) return false;
    j += 1;
  }
  return true;
}

/**
 * Two or more cards run together in one token, with nothing between them:
 * "chi179167guz143147" is chi 179/167 and guz 143/147.
 *
 * Detected rather than parsed: a token that is letters-then-digits REPEATED is
 * not one card, and returning a confident single card for it would be worse
 * than saying so. Each piece is handed back for normal resolution.
 *
 * @returns {string[]} the pieces, or [] when it is a single card
 */
export function splitRunTogetherCards(token) {
  const t = String(token ?? '').trim();
  const groups = t.match(/[A-Za-z]{2,}\d{2,}/g);
  if (!groups || groups.length < 2) return [];
  // Only when the groups account for the WHOLE token — a partial match means
  // something else is going on and guessing would be worse than declining.
  return groups.join('') === t ? groups : [];
}

export function expandCompactToken(token) {
  const t = String(token ?? '').trim();
  // Must start with letters and contain a digit. A bare number or a bare word
  // is somebody else's problem.
  if (!/^[A-Za-z]{2,}[A-Za-z0-9]*\d/.test(t)) return [];

  const out = [];
  const lead = t.match(/^([A-Za-z]+)(.*)$/);
  if (!lead) return [];

  // The leading letters split between the NAME prefix and a set/promo code:
  // "chasm195" is cha + sm195, "galswsh283" is gal + swsh283. Try every split
  // that leaves at least MIN_NAME letters for the name.
  const MIN_NAME = 3;
  const letters = lead[1];
  const rest = lead[2];

  for (let cut = MIN_NAME; cut <= letters.length; cut += 1) {
    const name = letters.slice(0, cut);
    const codeLetters = letters.slice(cut);
    const tail = codeLetters + rest;
    if (!/\d/.test(tail)) continue;

    for (const part of splitNumberTail(tail)) {
      out.push({
        ...part,
        name,
        // Prefer the reading that gives the name the fewest letters it needs
        // and keeps the rest intact: a longer name prefix is a stronger claim,
        // but a name that swallows a set code is how "Charizard ex" lost its
        // suffix in the old parser.
        prior: part.prior - (cut - MIN_NAME) * 0.02,
        shape: 'compact_' + part.shape,
      });
    }
  }

  out.sort((a, b) => b.prior - a.prior);
  // Bounded, but NOT tightly. The cap was 12 and it silently ate the right
  // answer: "mewswssh223" is Mewtwo V SWSH223 with a mistyped badge, and the
  // repaired reading is deliberately LOW prior — it is a correction, so it
  // must never outrank a literal reading — which put it at position 13 and
  // out of the list. A low-confidence reading that is the only one able to
  // work is exactly the one a prior-ordered cap discards.
  //
  // 24 readings is roughly 2ms of catalogue lookups downstream, which buys
  // nothing worth having by being 12.
  return out.slice(0, 24);
}

/**
 * Split the digits-and-letters tail into a collector number and, when there is
 * one, a printed total.
 */
function splitNumberTail(tail) {
  const out = [];

  // Two alphanumeric groups: "gg01gg70" -> GG01 / GG70.
  const twoAlnum = tail.match(/^([A-Za-z]{1,4}\d{1,4})([A-Za-z]{1,4}\d{1,4})$/);
  if (twoAlnum) {
    out.push({ card_number: twoAlnum[1].toUpperCase(), total: twoAlnum[2].toUpperCase().replace(/^[A-Za-z]+/, ''), set_code: null, prior: 0.9, shape: 'alnum_pair' });
  }

  // One alphanumeric group: "sm195", "swsh283", "svp030".
  const oneAlnum = tail.match(/^([A-Za-z]{1,5})(\d{1,4})$/);
  if (oneAlnum) {
    // The letters may be a promo badge that belongs TO the number
    // (SWSH283 is one token on the card) or a set code beside it (SVP 030).
    out.push({ card_number: (oneAlnum[1] + oneAlnum[2]).toUpperCase(), total: null, set_code: null, prior: 0.85, shape: 'promo_joined' });
    out.push({ card_number: oneAlnum[2], total: null, set_code: oneAlnum[1].toUpperCase(), prior: 0.8, shape: 'promo_badge' });

    // A mistyped badge matches nothing, and the catalogue cannot forgive it:
    // "swssh223" is one letter from SWSH223 and every lookup for the former
    // fails. Repaired at distance 1 only, and ranked below the literal
    // reading so a real badge is never overridden by a correction.
    const fixed = repairBadge(oneAlnum[1]);
    if (fixed) {
      out.push({ card_number: fixed + oneAlnum[2], total: null, set_code: null,
        prior: 0.55, shape: 'promo_badge_repaired' });
    }
  }

  // All digits: "028203" -> 028/203, and every other split that could be a
  // number-and-total pair. Both halves are capped at 4 digits because no
  // collector number or set size runs longer.
  if (/^\d+$/.test(tail)) {
    if (tail.length <= 4) {
      out.push({ card_number: tail, total: null, set_code: null, prior: 0.6, shape: 'number_only' });
    }
    for (let i = 1; i < tail.length; i += 1) {
      const num = tail.slice(0, i);
      const total = tail.slice(i);
      if (num.length > 4 || total.length > 4) continue;
      // A split where the halves are the same length is the common case
      // ("028203", "127193"); an uneven one is still possible ("47122") and
      // ranks just below it.
      const even = num.length === total.length;
      // A collector number ABOVE its printed total is a secret rare and
      // entirely normal, so this is a mild preference, never a filter.
      const plausible = Number(num.replace(/^0+/, '') || 0) <= Number(total.replace(/^0+/, '') || 0);
      out.push({
        card_number: num, total, set_code: null,
        prior: 0.75 + (even ? 0.1 : 0) + (plausible ? 0.05 : 0),
        shape: 'digits_split',
      });
    }
  }

  return out;
}

export function tokeniseLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return { raw: '', interpretations: [], unclaimed: [] };

  let words = normaliseSpacing(raw).split(/\s+/);

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

  // A single run-together token — "gya028203" — has no structure for the
  // word-splitter to find, so it is expanded into candidate splits before
  // anything else runs. Only attempted when the whole line is one token and
  // nothing else has claimed a number, so a normal line is untouched.
  if (number == null && !catalogueKey && pre.length === 1 && !post.length) {
    for (const part of expandCompactToken(pre[0])) {
      interpretations.push({ ...base, extras: null, ...part });
    }
  }

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

    // READING 4 — a promo badge SEPARATED from its number. "Froakie XY 03" is
    // the same card as "Froakie XY03": the badge and the digits are distinct
    // elements on the card, printed with a gap, so whether a person or a model
    // types a space between them is a coin toss. The catalogue stores the
    // joined form (`xyp-XY03`), so rejoin them and let the catalogue judge.
    //
    // Only when no denominator was given — "Charizard ex 056/197" has a total,
    // so "ex" there is a name suffix and not a badge.
    if (total == null && pre.length >= 1 && !catalogueKey) {
      const last = pre[pre.length - 1];
      if (/^[A-Za-z]{1,4}$/.test(last)) {
        interpretations.push({
          ...base, extras, name: nameOf(pre.slice(0, -1)),
          card_number: last.toUpperCase() + number, total: null, set_code: null,
          prior: NAME_SUFFIX.has(norm(last)) ? 0.15 : 0.75,
          shape: 'promo_split_rejoined',
        });
      }
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
