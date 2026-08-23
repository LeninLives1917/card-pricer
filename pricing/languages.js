// pricing/languages.js
//
// Which printed languages can this system actually answer for?
//
// Pure, dependency-free and DOM-free so it runs unchanged in Node and in the
// browser. It lives in pricing/ rather than apps/vendor/ because both the
// server routes and the client need the same answer, and a server route
// importing from the browser bundle is the wrong dependency direction even
// when the module happens to be pure.
//
// THE CATALOGUE IS ENGLISH-ONLY
//
// data/card-db.json is 174 sets sourced from pokemontcg.io. There is not one
// Japanese, Korean or Chinese set in it.
//
// European languages are the SAME cards: same sets, same set codes, same
// collector numbers, same set sizes. Only the printed text differs, so they
// resolve correctly against an English catalogue and are supported here.
// Their PRICES differ — Cardmarket lists them separately — and no adapter
// takes a language into account, which is a real and separate gap.
//
// Japanese, Korean and Chinese are different cards. Different sets, different
// numbering, different set sizes. Matching one against the English catalogue
// is not a near miss, it is a category error.
//
// MEASURED, so the risk is stated rather than asserted: across the 40
// most-reprinted Pokemon at collector numbers 1-100 — the range Japanese sets
// occupy — 22.7% of (name, number) pairs ALSO exist in the English catalogue
// (909 of 4,000 combinations). The typed lookup's last-resort query is
// `name:"N" number:X`, which is set-agnostic, and identify.js then takes the
// first hit. So roughly one in four Japanese cards would come back as a
// confident English card, priced in English.
//
// Abstaining is the cheap half of the fix. Real support needs a Japanese
// catalogue — TCGdex serves /v2/ja/ and pricing/adapters/tcgdex.js:30 is
// already talking to it, hardcoded to /v2/en/ — plus the language threaded
// through to the price adapters and the Cardmarket URL builder, and
// printed-total disambiguation scoped per language rather than globally.

/** Languages the English catalogue can legitimately answer for. */
export const SUPPORTED_LANGS = Object.freeze(
  new Set(['en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'nl']),
);

/** Languages that are different cards entirely. Named so the reason is greppable. */
export const DIFFERENT_CARD_LANGS = Object.freeze(
  new Set(['jp', 'ja', 'ko', 'zh']),
);

/**
 * @param {string|null|undefined} lang two-letter token, or null when the line
 *   did not state one. Absent is NOT unsupported: most lines say nothing, and
 *   treating silence as a claim would reject almost everything.
 * @returns {boolean}
 */
export function isUnsupportedLang(lang) {
  if (!lang) return false;
  return !SUPPORTED_LANGS.has(String(lang).trim().toLowerCase());
}
