// pricing/text-entry/customer-line.js
//
// CUSTOMER PHRASING, read before the typed resolver sees a quote line.
//
// The typed resolver was built for the shop's own shorthand ("cha 4/102") and
// deliberately keeps every word in play: "rev" may be the start of Revavroom,
// "light" is part of Light Dragonite, "M" opens every Mega-EX name. Customers
// on the website write differently. Measured on 7 Oct 2026 against the live
// catalogue, before this module, every one of these failed on the public quote:
//
//   rev Gengar 94/162            qualifier BEFORE the name      -> not found
//   1st Edition Machamp 8/102    "Edition" became part of the name -> not found
//   Machamp 8/102 first edition  "first" was never read           -> priced as Unlimited
//   2 x Charizard 4/102          quantity                         -> read as 1
//   Charizard 4/102 x2           quantity                         -> read as 1
//   Charizard Base Set 4/102     set name between name and number -> not found
//   Charizard Japanese 4/102     language as a word               -> not read
//   Charizard 4/102 PSA 9        a graded slab                    -> priced as a raw NM card
//
// WHAT THIS MODULE DOES NOT DO is decide which card a line is. It does three
// things, and the quote route (apps/server/routes/quote-batch.js) owns the
// order they run in:
//
//   1. cleanCustomerLine  reads the quantity, a spelled-out language and a
//                         grading mark, and tidies separators. Always applied:
//                         none of these can be part of a card's identity.
//   2. moveQualifiers     rewrites "rev Gengar 94/162" as "Gengar 94/162 rev".
//                         A REWRITE, tried only after the line as typed has
//                         failed, so a line the resolver already handles
//                         resolves exactly as before ("Light Dragonite 14/105"
//                         still is Light Dragonite).
//   3. stripSetName       the line with a set name taken out, for "Charizard
//                         Base Set 4/102" -> "Charizard 4/102". One rewrite.
//      contextVariants    failing that, the name with the words around it
//                         dropped, longest kept span first, bounded.
//                         Both need a denominator, and the route checks the
//                         dropped words against the card it found
//                         (contextAgrees) before trusting it.
//
// Pure: no fs, no network.

import { CONDITION, FINISH } from './tokenise.js';

const fold =(s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const bare = (w) => fold(w).replace(/[^a-z0-9]/g, '');

const MAX_QTY = 99;

/** A collector number with its printed total, as the tokeniser reads it. */
const NUM_TOTAL_TOKEN = /^#?[A-Za-z]{0,4}\d{1,4}[a-z]?\/[A-Za-z]{0,4}\d{1,4}$/;

/** Quantity written as one token: x2, 2x, (2), (x2), (2x). */
const QTY_TOKEN = /^\(?\s*(?:[x×]\s*(\d{1,3})|(\d{1,3})\s*[x×])\s*\)?$|^\((\d{1,3})\)$/i;

/** Spelled-out languages. The two-letter codes are what the tokeniser reads. */
const LANG_WORDS = new Map([
  ['english', 'en'], ['eng', 'en'],
  ['japanese', 'ja'], ['japan', 'ja'], ['jpn', 'ja'], ['jap', 'ja'],
  ['korean', 'ko'],
  ['chinese', 'zh'],
  ['german', 'de'], ['deutsch', 'de'],
  ['french', 'fr'], ['francais', 'fr'],
  ['spanish', 'es'], ['espanol', 'es'],
  ['italian', 'it'], ['italiano', 'it'],
  ['portuguese', 'pt'],
  ['dutch', 'nl'],
  ['russian', 'ru'],
]);

/** Grading companies and words. A graded card is priced by hand, never as a raw NM copy. */
const GRADING_WORDS = new Set(['psa', 'bgs', 'cgc', 'sgc', 'beckett', 'graded', 'slab', 'slabbed']);
/** Words that belong to a grade label after the company: "PSA Gem Mint 10", "BGS 9.5". */
const GRADE_LABEL = /^(?:gem|mint|pristine|black|label|\d{1,2}(?:\.\d)?)$/i;

/**
 * Multi-word qualifiers, rewritten to the single tokens the tokeniser knows
 * (pricing/text-entry/tokenise.js FINISH and CONDITION). Without this "first
 * edition" is two unknown words and the card prices as Unlimited.
 */
const PHRASES = [
  [/\b(?:1st|first)[\s-]*(?:edition|ed\.?|edt)(?=\s|$)/gi, '1st'],
  [/\b1\s*ed(?:ition)?\b/gi, '1st'],
  [/\brev(?:erse)?[\s-]*holo(?:foil)?\b/gi, 'rev'],
  [/\breverse[\s-]*foil\b/gi, 'rev'],
  [/(?:^|\s)r\/h(?=\s|$)/gi, ' rev'],
  [/\bnon[\s-]*holo\b/gi, 'nonholo'],
  [/\bnear[\s-]*mint\b/gi, 'nm'],
  [/\blight(?:ly)?[\s-]*played\b/gi, 'lp'],
  [/\bmoderately[\s-]*played\b/gi, 'mp'],
  [/\bheavily[\s-]*played\b/gi, 'hp'],
  [/\bholo[\s-]*rare\b/gi, 'holo'],
];

/**
 * Words that change the price but never the card. moveQualifiers takes them
 * out from in front of the name. "m" and "ex" are deliberately absent: "M" is
 * how every Mega-EX name starts and "ex" is a suffix on ~700 names.
 */
const QUALIFIERS = new Set([
  'rev', 'reverse', 'revholo', 'rh', 'holo', 'foil', 'holofoil', 'nonholo',
  '1st', '1sted', 'firsted', 'shadowless', 'unlimited',
  'nm', 'mint', 'nearmint', 'excellent', 'gd', 'good', 'lp', 'light',
  'lightplayed', 'pl', 'played', 'po', 'poor', 'mp', 'hp', 'dmg', 'damaged',
]);

/**
 * Words a customer puts around a name that say nothing against the card the
 * number identifies: "Charizard Base Set 4/102", "Umbreon VMAX Alt Art 215/203".
 * Rarity, era and filler. Used only to judge DROPPED words, never to strip a
 * line, so a card whose name contains one ("Rare Candy", "Fresh Water Set")
 * is unaffected: it resolves as typed before any of this runs.
 */
const FILLER = new Set([
  'set', 'pokemon', 'tcg', 'card', 'cards', 'the', 'of', 'and', 'from', 'en',
  'english', 'eng', 'version', 'expansion', 'series', 'edition', 'collection',
  // rarity
  'holo', 'rare', 'holofoil', 'foil', 'rev', 'reverse', 'common', 'uncommon',
  'full', 'art', 'alt', 'alternate', 'secret', 'illustration', 'special',
  'ultra', 'double', 'hyper', 'gold', 'rainbow', 'shiny', 'star', 'promo',
  'ir', 'sir', 'ur', 'hr', 'sr', 'ar', 'fa', 'aa',
  // era
  'scarlet', 'violet', 'sv', 'sword', 'shield', 'swsh', 'sun', 'moon', 'sm',
  'xy', 'black', 'white', 'bw', 'diamond', 'pearl', 'dp', 'heartgold',
  'soulsilver', 'hgss', 'platinum', 'wotc', 'vintage', 'mega', 'evolution',
  'evolutions', 'era',
  // condition and print
  'nm', 'mint', 'lp', 'pl', 'mp', 'hp', 'unlimited', '1st', 'shadowless',
  'condition', 'played',
]);

/** The words of a reprint label; the route's reprintHint reads them from the line. */
const REPRINT_WORDS = new Set([
  'celebrations', 'celebration', 'classic', 'collection', '25th', '30th',
  'anniversary', 'cel', 'cel25', 'reprint',
]);

/**
 * Read what a customer's line says that is not the card: quantity, language,
 * grading. Tidy separators. Never drops a word that could be part of a name.
 *
 * @param {string} raw
 * @returns {{text: string, qty: number|null, lang: string|null, graded: boolean}}
 *   qty is null when the line did not state one in a customer form (the
 *   tokeniser may still read a leading "3x" itself).
 */
export function cleanCustomerLine(raw) {
  let s = String(raw ?? '').normalize('NFKC').trim();

  // A trailing integer after a TAB, comma or semicolon is a quantity column
  // pasted from a spreadsheet: "Charizard\t4/102\t2". Read before the
  // separators are flattened, because afterwards it is just a number.
  let qty = null;
  const col = s.match(/[\t,;]\s*(\d{1,2})\s*$/);
  if (col && /\d\s*\/\s*\d/.test(s.slice(0, col.index))) {
    qty = Number(col[1]);
    s = s.slice(0, col.index);
  }

  s = s
    .replace(/[‘’`´]/g, "'")
    .replace(/[\t,;|]+/g, ' ')
    // "4 / 102" is one collector number. Joined BEFORE stray slashes go, or
    // the separator rule below would eat the slash out of the number.
    .replace(/(\d)\s*\/\s*([A-Za-z]{0,4}\d)/g, '$1/$2')
    // A dash or slash standing alone is a separator ("Charizard - Base Set -
    // 4/102"); inside a word it is part of the name (Ho-Oh, Porygon-Z).
    .replace(/(^|\s)[-–—/:]+(?=\s|$)/g, ' ')
    .replace(/#(?=\d)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A numbered or bulleted list: "1. Charizard 4/102", "- Pikachu 58/102".
  // The index is the list's, not a quantity.
  s = s.replace(/^(?:\d{1,3}[.)]|[-*•·])\s+(?=\S)/, '');

  // Leading quantity forms. The tokeniser already reads "3x Charizard"; these
  // are the ones it does not: "2 x Charizard", "x2 Charizard", "2 Charizard".
  let m;
  if ((m = s.match(/^(\d{1,3})\s*[x×]\s+(?=\S)/i))) {
    qty = qty ?? Number(m[1]); s = s.slice(m[0].length);
  } else if ((m = s.match(/^[x×]\s*(\d{1,3})\s+(?=\S)/i))) {
    qty = qty ?? Number(m[1]); s = s.slice(m[0].length);
  } else if ((m = s.match(/^(\d{1,2})\s+(?=[A-Za-z])/)) && /\d/.test(s.slice(m[0].length))) {
    // A bare leading count, only when a collector number follows it, so a
    // line's own number is never taken for a quantity.
    qty = qty ?? Number(m[1]); s = s.slice(m[0].length);
  }

  for (const [rx, to] of PHRASES) s = s.replace(rx, to);

  let lang = null;
  let graded = false;
  const out = [];
  const words = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const lw = bare(w);

    const q = w.match(QTY_TOKEN);
    if (q && qty == null) { qty = Number(q[1] ?? q[2] ?? q[3]); continue; }
    if (q) continue;

    // "qty 2", "qty: 2"
    if (/^qty:?$/i.test(w) && /^\d{1,3}$/.test(words[i + 1] ?? '')) {
      qty = qty ?? Number(words[i + 1]); i += 1; continue;
    }
    // "... x 2" at the end
    if (/^[x×]$/i.test(w) && i === words.length - 2 && /^\d{1,3}$/.test(words[i + 1])) {
      qty = qty ?? Number(words[i + 1]); i += 1; continue;
    }

    if (GRADING_WORDS.has(lw) || /^(?:psa|bgs|cgc|sgc)\d{1,2}(?:\.\d)?$/i.test(w)) {
      graded = true;
      while (i + 1 < words.length && GRADE_LABEL.test(words[i + 1])) i += 1;
      continue;
    }

    if (LANG_WORDS.has(lw) && LANG_WORDS.get(lw) && w.length > 2) {
      lang = lang ?? LANG_WORDS.get(lw);
      out.push(LANG_WORDS.get(lw));
      continue;
    }

    if (/^r\.?h\.?$/i.test(w)) { out.push('rev'); continue; }
    out.push(w);
  }

  if (qty != null) qty = Math.min(MAX_QTY, Math.max(1, qty));
  return { text: out.join(' '), qty, lang, graded };
}

/** Index of the first "number/total" token, or -1. */
function numTotalAt(words) {
  return words.findIndex((w) => NUM_TOTAL_TOKEN.test(w));
}

/**
 * Qualifiers that also START real card names: Light Dragonite (and 21 more
 * "Light" cards), Good Rod, Good Manners, Reverse Valley, Po Town. "rev Light
 * Piloswine 26/105" has to keep its "Light" when the "rev" moves.
 */
const NAME_START_QUALIFIERS = new Set(['light', 'good', 'reverse', 'po']);

/**
 * Rewrites of a line with its qualifiers moved behind the number:
 * "rev Gengar 94/162" -> "Gengar 94/162 rev", "4/102 Charizard" ->
 * "Charizard 4/102". Best first; empty when there is nothing to rewrite.
 *
 * Only ever TRIED after the line as typed failed (see quote-batch.js), which
 * is what keeps Light Dragonite, Good Rod and Reverse Valley safe.
 *
 * @returns {string[]}
 */
export function moveQualifiers(text) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  let at = numTotalAt(words);

  // Number first: "4/102 Charizard" / "004/102 Charizard ex".
  if (at === 0 && words.length > 1) {
    const reordered = `${words.slice(1).join(' ')} ${words[0]}`;
    const more = moveQualifiers(reordered);
    return more.length ? [...more, reordered] : [reordered];
  }

  // With no denominator, the collector number is the last bare number.
  if (at < 0) {
    for (let i = words.length - 1; i >= 0; i -= 1) {
      if (/^\d{1,4}[a-z]?$/i.test(words[i])) { at = i; break; }
    }
  }
  if (at <= 0) return [];

  const pre = words.slice(0, at);
  const tail = words.slice(at);
  const rewrite = (isMoved) => {
    const name = []; const quals = [];
    for (const w of pre) (isMoved(w) ? quals : name).push(w);
    return quals.length && name.length ? [...name, ...tail, ...quals].join(' ') : null;
  };
  const out = [
    rewrite((w) => QUALIFIERS.has(bare(w))),
    rewrite((w) => QUALIFIERS.has(bare(w)) && !NAME_START_QUALIFIERS.has(bare(w))),
  ].filter(Boolean);
  return [...new Set(out)];
}

/**
 * Index the set names for stripSetName: each as its list of bare tokens,
 * longest first. Built once by the caller from the catalogue's own set names.
 *
 * @param {Iterable<string>} names
 * @returns {string[][]}
 */
export function buildSetNameTokens(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const toks = fold(n).split(/[^a-z0-9]+/).filter(Boolean);
    const key = toks.join(' ');
    if (!toks.length || seen.has(key)) continue;
    seen.add(key);
    out.push(toks);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Words that sit next to a set name and go with it: "Base SET", "SERIES". */
const SET_NEIGHBOURS = new Set(['set', 'series', 'expansion', 'pokemon', 'tcg']);

/**
 * The line with a SET NAME taken out of the words before the number:
 * "Charizard Base Set 4/102" -> "Charizard 4/102", "Team Magma vs Team Aqua
 * Team Aqua's Carvanha 47/95" -> "Team Aqua's Carvanha 47/95".
 *
 * One rewrite where contextVariants would try a dozen, which is what makes a
 * whole collection exported as "Name Set Number" affordable. The longest set
 * name wins; a set name that is also a card's name ("Deoxys", "Arceus") is
 * tried at its first and its last position, since only the catalogue knows
 * which one is the set.
 *
 * @param {string} text
 * @param {string[][]} setTokens from buildSetNameTokens
 * @returns {Array<{text: string, dropped: string[]}>}
 */
export function stripSetName(text, setTokens) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const at = numTotalAt(words);
  if (at < 2 || !setTokens?.length) return [];
  const pre = words.slice(0, at);
  const tail = words.slice(at);
  // Bare tokens of the words before the number, remembering which word each came from.
  const toks = [];
  pre.forEach((w, i) => { for (const t of fold(w).split(/[^a-z0-9]+/).filter(Boolean)) toks.push({ t, i }); });

  for (const set of setTokens) {
    if (set.length > toks.length - 1) continue; // something has to be left for the name
    const hits = [];
    for (let s = 0; s + set.length <= toks.length; s += 1) {
      let ok = true;
      for (let k = 0; k < set.length && ok; k += 1) ok = toks[s + k].t === set[k];
      if (ok) hits.push(s);
    }
    if (!hits.length) continue;
    const out = [];
    for (const s of [...new Set([hits[0], hits[hits.length - 1]])]) {
      let from = toks[s].i;
      let to = toks[s + set.length - 1].i;
      // A matched token must own its whole word: "Rocket's" is not "Rocket".
      if (fold(pre.slice(from, to + 1).join(' ')).replace(/[^a-z0-9]+/g, ' ').trim() !== set.join(' ')) continue;
      while (to + 1 < pre.length && SET_NEIGHBOURS.has(bare(pre[to + 1]))) to += 1;
      while (from - 1 >= 0 && SET_NEIGHBOURS.has(bare(pre[from - 1]))) from -= 1;
      const kept = [...pre.slice(0, from), ...pre.slice(to + 1)];
      if (!kept.some((w) => /[A-Za-z]{2,}/.test(w))) continue;
      out.push({ text: [...kept, ...tail].join(' '), dropped: pre.slice(from, to + 1) });
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * The line with the words around the name dropped: "Charizard Base Set 4/102"
 * -> "Charizard Base 4/102", "Charizard 4/102", ... Longest kept span first,
 * because the more of what was typed a reading explains, the better founded
 * it is.
 *
 * Only for a line with a printed total. Name plus number plus total is the
 * strongest evidence the resolver has (measured 99.6% unique across the
 * catalogue), and it is what makes dropping words safe at all.
 *
 * @returns {Array<{text: string, dropped: string[]}>}
 */
export function contextVariants(text, { max = 8 } = {}) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const at = numTotalAt(words);
  if (at < 2) return [];
  const pre = words.slice(0, at);
  const tail = words.slice(at).join(' ');
  const out = [];
  for (let len = pre.length - 1; len >= 1 && out.length < max; len -= 1) {
    for (let i = 0; i + len <= pre.length && out.length < max; i += 1) {
      const span = pre.slice(i, i + len);
      if (!span.some((w) => /[A-Za-z]{2,}/.test(w))) continue;
      out.push({ text: `${span.join(' ')} ${tail}`, dropped: [...pre.slice(0, i), ...pre.slice(i + len)] });
    }
  }
  return out;
}

/**
 * Do the dropped words agree with the card that was found? True when every
 * one is filler, a reprint word, or part of the card's own set name, id or
 * code. "Charizard Base Set 4/102" -> Base: agrees. "Charizard Japanese
 * 4/102" never gets here (language), "Pikachu Red Cheeks 58/102" -> Base: does
 * not, so the route asks instead of asserting.
 *
 * @param {string[]} dropped
 * @param {{set_name?: string, set_id?: string, set_code?: string}} card
 */
export function contextAgrees(dropped, card) {
  const setWords = setWordsOf(card);
  return tokensOf(dropped).every((t) => FILLER.has(t) || REPRINT_WORDS.has(t) || setWords.has(t));
}

/**
 * Stronger than contextAgrees: the dropped words agree AND at least one of
 * them names this card's set. Used to pick one card out of a question —
 * "Water Energy Gym Heroes 132/132" is Gym Heroes, not Gym Challenge, though
 * both are 132-card sets with a Water Energy at 132.
 */
export function setEvidence(dropped, card) {
  const setWords = setWordsOf(card);
  const toks = tokensOf(dropped);
  return toks.some((t) => setWords.has(t) && !FILLER.has(t))
    && toks.every((t) => FILLER.has(t) || REPRINT_WORDS.has(t) || setWords.has(t));
}

function setWordsOf(card) {
  return new Set([
    ...fold(card?.set_name).split(/[^a-z0-9]+/),
    bare(card?.set_id),
    bare(card?.set_code),
  ].filter(Boolean));
}

/** "HS—Unleashed", "McDonald's" -> hs, unleashed, mcdonald, s. */
function tokensOf(words) {
  return (words || []).flatMap((w) => fold(w).split(/[^a-z0-9]+/)).filter(Boolean);
}

/**
 * The grade and finish a line states OUTSIDE the card's own name, or null
 * when the name holds none of those words (the tokeniser's reading stands).
 *
 * The tokeniser reads a grade word wherever it sits, by design: a word that
 * is also part of a name stays in the name, but its grade is still read. At
 * the till the operator sees the grade and fixes it; on a public quote it
 * silently re-prices the card. Measured on the first build, 7 Oct 2026:
 * "Light Dragonite 14/105" quoted at LP (x0.58), and the same for all 22
 * "Light" cards; "Good Rod" at GD; "Reverse Valley" as a reverse holo.
 *
 * So the name words (the name as typed, and the card's own name once it is
 * known) are set aside and the grade and finish are read from what is left.
 * A later mention wins, as in the tokeniser, since the grade usually follows
 * the number.
 *
 * @param {string} text   the line as it was resolved
 * @param {...string} names
 * @returns {{condition: string|null, finish: string|null}|null}
 */
export function gradeAndFinishOutsideName(text, ...names) {
  const nameWords = new Set(names.flatMap((n) => fold(n).split(/[^a-z0-9]+/)).filter(Boolean));
  const clash = [...nameWords].some((w) => (CONDITION.has(w) && CONDITION.get(w)) || FINISH.has(w));
  if (!clash) return null;
  let condition = null;
  let finish = null;
  for (const w of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const lw = w.trim().toLowerCase();
    if (nameWords.has(bare(w))) continue;
    if (CONDITION.has(lw) && CONDITION.get(lw)) condition = CONDITION.get(lw);
    if (FINISH.has(lw)) finish = FINISH.get(lw);
  }
  return { condition, finish };
}

export { QUALIFIERS, FILLER, REPRINT_WORDS, LANG_WORDS, GRADING_WORDS };
