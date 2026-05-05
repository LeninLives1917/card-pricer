// apps/quote/modules/parse-lines.js
// Owner: A5 | Slice: S8
//
// Customer-facing line parser for the /quote textarea. Behaviour pinned by
// V2_AUDIT §1c (lines 481-496 of public/quote.html).
//
// Accepted formats (one card per line):
//   1. Bare number             "44"                → set_code:"",   card_number:"44"
//   2. Set + number            "MEG 133"           → set_code:"MEG",card_number:"133"
//   3. Set + number-with-total "TWM 200/167"       → set_code:"TWM",card_number:"200" (total dropped)
//   4. Set + number + name     "MEG 133 Bulbasaur" → set_code:"MEG",card_number:"133", name:"Bulbasaur"
//   5. Comments / blanks       "# foo" "// bar" "" → skipped
//
// Card numbers split on '/' to discard the set total. Lines beyond
// MAX_CARDS=20 are dropped silently — the V1 cap. The .raw field is
// preserved per-line so error messages can echo the user's input.

export const MAX_CARDS = 20;

/**
 * @typedef {Object} ParsedLine
 * @property {string} set_code     Set code (any case the user typed) or "" if bare-number form.
 * @property {string} card_number  Number with leading-zero treatment left to server.
 * @property {string} name         Optional name suffix; "" if absent.
 * @property {string} raw          Original trimmed line, for error echo.
 */

/**
 * Parse a textarea blob into up to MAX_CARDS line entries.
 * @param {string} raw
 * @returns {ParsedLine[]}
 */
export function parseLines(raw) {
  return String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    .slice(0, MAX_CARDS)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length === 1) {
        return {
          set_code: '',
          card_number: parts[0].split('/')[0],
          name: '',
          raw: line,
        };
      }
      const set_code = parts[0];
      const card_number = parts[1].split('/')[0];
      const name = parts.slice(2).join(' ');
      return { set_code, card_number, name, raw: line };
    });
}
