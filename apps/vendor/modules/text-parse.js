// apps/vendor/modules/text-parse.js
//
// Robust freeform line parser for the Scan-tab "Text" panel. Users paste
// rows of cards in any of the formats they actually have on hand; this
// module pulls out { name, set_code, card_number, total, lang } so the
// existing /api/identify-manual lookup gets clean structured input.
//
// Pure (no DOM, no fetch) so it's importable from node:test for parity
// regression — see tests/regression/text-entry-parse.spec.js.
//
// Patterns tried, in order from richest to simplest:
//
//   P1  <name…> <set 2-5> <lang 2> <num>/<total> [extras]
//        e.g. "Mystery Garden meg en 172/132"
//             "Garganacle ex scr en 089/142"
//             "Team Rockets Crobat ex dri en 122/182 League Promo Stamp"
//
//   P2  <name…> <set 2-5> <num>/<total> [extras]    (no lang token)
//        e.g. "Pikachu meg 172/132"
//
//   P3  <set 2-5> <num>[/total] [name…]             (set-first; legacy V1)
//        e.g. "MEG 172 Pikachu"  /  "MEG 172/132"
//
//   P4  <num>/<total> [name…]
//        e.g. "172/132 Pikachu"
//
//   P5  bare name (last-resort fallback)
//
// Why the lang-token anchor matters: it lets P1 backtrack past name tokens
// that look like set codes. "Garganacle ex scr en 089/142" — without the
// lang anchor the regex would happily match name="Garganacle", set="ex",
// because "ex" is 2 chars. Requiring the next token after set_code to be
// a known 2-letter language forces backtracking until the boundary lands
// on the actual set code.

const LANG_TOKENS = ['en','de','fr','es','it','pt','jp','ja','ko','zh','ru','nl'];
const LANG_GROUP = LANG_TOKENS.join('|');

// Set-code: 2-5 chars, must start with a letter (so "ex" qualifies but
// "172" doesn't). Allow digits in the tail to support sets like "GG31"
// edge cases, though the primary case is alpha (MEG, PAF, SCR, ...).
const SET_TOKEN = '[A-Za-z][A-Za-z0-9]{1,4}';

const RX_P1 = new RegExp(
  '^(.+?)\\s+(' + SET_TOKEN + ')\\s+(' + LANG_GROUP + ')\\s+(\\d{1,4})\\s*/\\s*(\\d{1,4})\\s*(.*)$',
  'i',
);

const RX_P2 = new RegExp(
  '^(.+?)\\s+(' + SET_TOKEN + ')\\s+(\\d{1,4})\\s*/\\s*(\\d{1,4})\\s*(.*)$',
);

const RX_P3 = new RegExp(
  '^(' + SET_TOKEN + ')\\s+(\\d{1,4}(?:\\s*/\\s*\\d{1,4})?)\\s*(.*)$',
);

const RX_P4 = /^(\d{1,4})\s*\/\s*(\d{1,4})\s*(.*)$/;

/**
 * Parse a multi-line block. Returns one entry per non-empty line.
 *
 * @param {string} raw  the raw textarea contents
 * @returns {Array<ParsedLine>}
 */
export function parseTextEntryLines(raw) {
  return String(raw == null ? '' : raw)
    .split(/\r?\n/)
    .map(parseTextEntryLine)
    .filter(Boolean);
}

/**
 * Parse a single line. Returns null for empty input, otherwise the
 * richest structured envelope we could extract.
 *
 * @typedef {Object} ParsedLine
 * @property {string} raw          original trimmed line, kept for error display
 * @property {string} [name]       card name (when extractable)
 * @property {string} [set_code]   uppercase set abbreviation (e.g. "MEG")
 * @property {string} [card_number] number-only or "num/total" depending on shape
 * @property {string} [total]      printed-total when present
 * @property {string} [lang]       lower-case 2-letter ISO-ish language token
 * @property {string} [extras]     trailing text after the matched anchors
 *                                  (e.g. "League Promo Stamp")
 * @property {1|2|3|4|5} pattern   which pattern matched (for debugging / tests)
 *
 * @param {string} line
 * @returns {ParsedLine|null}
 */
export function parseTextEntryLine(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed) return null;

  let m = trimmed.match(RX_P1);
  if (m) {
    return {
      raw: trimmed,
      name: m[1].trim(),
      set_code: m[2].toUpperCase(),
      lang: m[3].toLowerCase(),
      card_number: m[4],
      total: m[5],
      extras: m[6].trim() || undefined,
      pattern: 1,
    };
  }

  m = trimmed.match(RX_P2);
  if (m) {
    return {
      raw: trimmed,
      name: m[1].trim(),
      set_code: m[2].toUpperCase(),
      card_number: m[3],
      total: m[4],
      extras: m[5].trim() || undefined,
      pattern: 2,
    };
  }

  m = trimmed.match(RX_P3);
  // Guard: if the leading token is purely digits (e.g. "172/132 Pikachu"),
  // P3 must NOT win — we want P4. RX_P3's SET_TOKEN already requires a
  // leading letter so this is enforced by the pattern, but keep an explicit
  // fall-through for clarity.
  if (m && /[A-Za-z]/.test(m[1])) {
    return {
      raw: trimmed,
      set_code: m[1].toUpperCase(),
      card_number: m[2].replace(/\s+/g, ''),
      name: m[3].trim() || undefined,
      pattern: 3,
    };
  }

  m = trimmed.match(RX_P4);
  if (m) {
    return {
      raw: trimmed,
      card_number: m[1] + '/' + m[2],
      total: m[2],
      name: m[3].trim() || undefined,
      pattern: 4,
    };
  }

  return { raw: trimmed, name: trimmed, pattern: 5 };
}

export default { parseTextEntryLines, parseTextEntryLine };
