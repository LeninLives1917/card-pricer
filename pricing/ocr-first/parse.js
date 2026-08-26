// pricing/ocr-first/parse.js
//
// Owner: A2 (Pricing engine) — Slice S15
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §3.7 (OCR-first pipeline)
//   - V1 attribution: extractCardNumber lifted verbatim from
//     public/index.html lines 4105-4188 (V1-final / 80448c0). The client
//     keeps its own copy for the camera-scanner Tesseract loop; this is the
//     server-side equivalent for the OCR-first pipeline.
//
// Pure, side-effect-free helpers. Parses the raw text returned by
// /api/read-set-code (or any OCR pass) into a structured shape:
//   { number, set_code?, reg_mark?, game } | null
//
// The parser is deliberately tolerant of common OCR confusions
// (pipe→1, l/I→1, O→0) — the same cleaning the client does.
//
// THE PRINTED TOTAL IS CARRIED, 26 Aug 2026. Every slash pattern here already
// CAPTURED the denominator and then dropped it, returning only the set code
// and the numerator.
//
// That denominator is the most valuable field on the strip. Measured across
// the catalogue: a number alone identifies 6.8% of cards uniquely, number +
// printed total identifies 46.0%, and it is what REFUTES a misread set code —
// the "gri 75/127" protection in pricing/text-entry/resolve-line.js, where GRI
// is a real alias for a 145-card set and the typed 127 proves the letters were
// not a set code at all.
//
// It matters more here than for typed entry, because OCR errors are SYSTEMATIC
// rather than random. "DRI" misread as "DR1" currently returns set_code "EN"
// with no complaint; a carried total lets the resolver refuse that instead of
// pricing it.

/**
 * Parse common card-number patterns out of raw OCR text.
 *
 * Returns one of:
 *   - { set_code, number, game: 'pokemon' }
 *   - { reg_mark, number, game: 'pokemon' }
 *   - { number, game: 'pokemon'|'onepiece'|'yugioh' }
 *   - null  (unparseable)
 *
 * The caller (pipeline.js) feeds these straight into manualIdentifyCore.
 *
 * @param {string} text  OCR output, e.g. "MEP 027" or "DRI EN 204/182"
 *                       or "SM211" or "OP06-001".
 * @returns {object|null}
 */
export function extractCardNumber(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[|]/g, '1')           // pipe → 1
    .replace(/[lI](?=\d)/g, '1')    // l or I before digit → 1
    .replace(/O(?=\d{2})/g, '0')    // O before two digits → 0
    .toUpperCase();

  // Priority 1a: "SET EN NNN/NNN" — Pokemon with language code e.g.
  // DRI EN 204/182, MEW EN 173/165.
  const setLangSlash = cleaned.match(/\b([A-Z]{2,5})\s+(?:EN|JP|FR|DE|ES|IT|PT|KO|ZH)\s+(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  if (setLangSlash) {
    return { set_code: setLangSlash[1], number: setLangSlash[2], total: setLangSlash[3], game: 'pokemon' };
  }

  // Priority 1b: "SET EN NNN" — Pokemon with language code, no slash.
  const setLangNum = cleaned.match(/\b([A-Z]{2,5})\s+(?:EN|JP|FR|DE|ES|IT|PT|KO|ZH)\s+(\d{1,4})\b/);
  if (setLangNum) {
    return { set_code: setLangNum[1], number: setLangNum[2], game: 'pokemon' };
  }

  // Priority 2: "SET NNN/NNN" — Pokemon with set code prefix e.g. MEG 133/132.
  const setSlash = cleaned.match(/\b([A-Z]{2,5})\s+(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  if (setSlash) {
    return { set_code: setSlash[1], number: setSlash[2], total: setSlash[3], game: 'pokemon' };
  }

  // Priority 2c: "REG NNN/NNN" — regulation mark + number, no set code.
  const regSlash = cleaned.match(/\b([D-J])\s+(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  if (regSlash) {
    return { reg_mark: regSlash[1], number: `${regSlash[2]}/${regSlash[3]}`, total: regSlash[3], game: 'pokemon' };
  }

  // Priority 3: "NNN/NNN" — Pokemon/Magic without set code.
  const slash = cleaned.match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);
  if (slash) {
    return { number: `${slash[1]}/${slash[2]}`, total: slash[2], game: 'pokemon' };
  }

  // Priority 4: "SET NNN" — set code + number without slash e.g. TWM 200.
  const setNum = cleaned.match(/\b([A-Z]{2,5})\s+(\d{1,4})\b/);
  if (setNum) {
    return { set_code: setNum[1], number: setNum[2], game: 'pokemon' };
  }

  // Priority 5a: Crown Zenith Galarian Gallery — GG31/GG70.
  const gg = cleaned.match(/\b(GG\d{1,3})\s*\/\s*(GG\d{1,3})\b/);
  if (gg) {
    return { set_code: 'CZGG', number: gg[1], total: gg[2].replace(/^GG/, ''), game: 'pokemon' };
  }

  // Priority 5b: SWSH promos — SWSH020, SWSH066, etc.
  const swshPromo = cleaned.match(/\b(SWSH)[\s-]?(\d{1,4})\b/);
  if (swshPromo) {
    return { set_code: 'SWP', number: `SWSH${swshPromo[2].padStart(3, '0')}`, game: 'pokemon' };
  }

  // Priority 5c: Other promos — SVP 076, SM211, XY99, BW100.
  const promo = cleaned.match(/\b(SVP|SV|SM|XY|BW|HGSS|DP)[\s-]?(\d{1,4})\b/);
  if (promo) {
    return { number: `${promo[1]}${promo[2]}`, game: 'pokemon' };
  }

  // Priority 6: One Piece — OP06-001, ST01-002.
  const op = cleaned.match(/\b(OP|ST|EB)\d{1,2}-\d{1,3}\b/);
  if (op) {
    return { number: op[0], game: 'onepiece' };
  }

  // Priority 7: Yu-Gi-Oh — ABCD-EN001.
  const ygo = cleaned.match(/\b[A-Z]{3,5}-[A-Z]{2}\d{3}\b/);
  if (ygo) {
    return { number: ygo[0], game: 'yugioh' };
  }

  return null;
}

export default extractCardNumber;
