// pricing/ocr-first/regions.js
//
// Read a card's IDENTITY out of two small crops, with no vision model.
//
// STATUS: NOT WIRED INTO ANY ROUTE. Nothing imports this yet, deliberately.
// Measured end to end against all 64 real benchmark photographs it reaches
// 19/64 correct with 1 wrong, which is not good enough to put in front of an
// operator. The blocker is named at the bottom of this comment and it is not
// this file.
//
//
// WHY TWO CROPS AND NOT THE WHOLE CARD
//
// Identifying a card from a photograph is hard. Reading two short strings off a
// rectified card is not, and the typed-entry resolver already turns those two
// strings into a card at 98.8% correct with zero wrong answers across all
// 20,493 catalogue cards. So the image work only has to deliver what an
// operator would type.
//
// MEASURED across the catalogue — what each field is worth:
//
//     number alone                  6.8% unique
//     number + printed total       46.0%
//     2 name chars + number/total  98.3%
//     3 name chars + number/total  99.0%
//     full name + number/total     99.6%
//     set code + number           100.0%   but printed on only 40% of cards
//
// So the target is NAME + NUMBER/TOTAL, not the set code. The set code appears
// in the bottom strip only from Sword & Shield onward — 8,183 of 20,546 cards —
// and it is the fragile field: a single character slip turns "DRI" into "DR1",
// which the parser reads as set code "EN". Name + number/total works on every
// era and needs only two or three characters of the name to get to 98.3%.
//
// The set code is read when it is there, but ONLY as corroboration. It never
// becomes the key.
//
// WHAT ACTUALLY BLOCKS IT, measured 26 Aug 2026 on the 64-photo benchmark:
//
//     rectified          56/64      good — the failures inspected by hand
//                                   produced clean, correct 600x840 cards
//     number arbitrated  33/64      the bottleneck
//     name read          34/64
//     CORRECT            19/64
//
// The digits are the problem. Pokemon prints collector numbers in a stylised
// custom face and stock Tesseract eng cannot read it: a crisp, well-cropped
// "055/182" comes back as "088/187". Six preprocessing variants were tried
// (plain, x10 upscale, threshold, negate, negate+threshold, sharpen), each at
// two page-segmentation modes; all twelve misread the same digits identically.
// That is a font problem, not a tuning problem.
//
// The fix is a font-specific reader: a Tesseract model trained on the numerals,
// or plain template matching over the eleven fixed glyphs (0-9 and /). The
// character set is tiny, the font never changes, and the crop is already
// high-contrast — it is a bounded piece of work with an obvious success metric.
//
// Everything in this file is independent of which reader is used. The OCR
// function is injected for exactly that reason.
//
// GEOMETRY. Fractions of a rectified 600x840 card (pricing/card-rectify.js),
// so they hold at any capture resolution. Pokemon has printed the name across
// the top and the collector number at the bottom-left for its whole history;
// the bands are generous because the exact inset moved between eras.

import sharp from 'sharp';

/**
 * Name band: across the top. Starts in from the left edge to clear the
 * Stage/evolution badge and stops short of the HP and type symbols on the
 * right, so neither the stage number nor the HP can leak into the name. Height
 * is the name line only — the "Evolves from ..." line sits directly beneath it
 * and would otherwise be read as the name on every evolved Pokemon.
 */
export const NAME_BAND = Object.freeze({ x: 0.17, y: 0.042, w: 0.60, h: 0.048 });

/**
 * Collector-number band: bottom-left, tight to the number line. The
 * illustrator credit sits directly above it and is pure noise; the regulation
 * mark and set code share the line and are read from it when present.
 */
export const NUMBER_BAND = Object.freeze({ x: 0.05, y: 0.938, w: 0.36, h: 0.036 });

const px = (band, w, h) => ({
  left: Math.max(0, Math.round(band.x * w)),
  top: Math.max(0, Math.round(band.y * h)),
  width: Math.min(w, Math.round(band.w * w)),
  height: Math.min(h, Math.round(band.h * h)),
});

/**
 * Cut one band out of a rectified card and prepare it for OCR.
 *
 * Upscaled hard: Tesseract is trained around 300dpi and these bands are a few
 * dozen pixels tall on a 600x840 card. Greyscale + normalise + sharpen because
 * the number is white on a dark bar and the contrast is what carries it.
 *
 * @param {Buffer} rectified  a rectified card image
 * @param {object} band       one of NAME_BAND / NUMBER_BAND
 * @param {{scale?: number, threshold?: number}} [opts]
 */
export async function cropBand(rectified, band, opts = {}) {
  const scale = opts.scale ?? 4;
  const img = sharp(rectified);
  const { width, height } = await img.metadata();
  if (!width || !height) return null;
  const rect = px(band, width, height);
  if (rect.width < 8 || rect.height < 8) return null;

  let pipe = sharp(rectified).extract(rect)
    .resize({ width: rect.width * scale, kernel: 'lanczos3' })
    .greyscale()
    .normalise();
  if (opts.threshold != null) pipe = pipe.threshold(opts.threshold);
  return pipe.png().toBuffer();
}

/**
 * A collector number, read out of OCR text.
 *
 * Deliberately narrower than pricing/ocr-first/parse.js, which parses a whole
 * OCR dump and has to guess which token is which. This band contains the
 * number and nothing else, so the pattern can be strict — and strict is what
 * keeps a smudge from becoming a card.
 */
export function readNumberBand(text) {
  if (!text) return null;
  const t = String(text).toUpperCase()
    .replace(/[|]/g, '1')
    .replace(/[lI](?=\d)/g, '1')
    .replace(/O(?=\d)/g, '0')
    .replace(/\s+/g, ' ');

  // NNN/NNN — the shape that carries a printed total, and the one worth having.
  const slash = t.match(/(\d{1,4}|[A-Z]{1,3}\d{1,3})\s*[/／]\s*([A-Z]{0,3}\d{1,4})/);
  if (slash) {
    return {
      number: slash[1],
      total: slash[2].replace(/^[A-Z]+/, ''),
      set_code: (t.match(/\b([A-Z]{2,5})\s*EN\b/) || [])[1] ?? null,
    };
  }

  // A promo-style number with no denominator: SWSH123, XY03, SM211.
  const alnum = t.match(/\b([A-Z]{2,4}\s?\d{1,3})\b/);
  if (alnum) return { number: alnum[1].replace(/\s/g, ''), total: null, set_code: null };

  return null;
}

/**
 * The card's name, read out of OCR text.
 *
 * Only the leading characters matter — two of them already identify 98.3% of
 * the catalogue once the number and total are known — so this cleans rather
 * than parses, and never tries to be clever about which words belong.
 */
export function readNameBand(text) {
  if (!text) return null;
  const first = String(text).split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!first) return null;
  // Keep letters, digits, apostrophes, hyphens and spaces. Pokemon names carry
  // all of those ("N's Zoroark ex", "Ho-Oh", "Farfetch'd") and nothing else.
  const cleaned = first.replace(/[^A-Za-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.replace(/[^A-Za-z0-9]/g, '').length < 2) return null;
  return cleaned;
}

/**
 * Build the line the typed-entry resolver already understands.
 *
 * The whole point of the exercise: the image path produces exactly what an
 * operator would type, and everything downstream is the code that was measured
 * at 98.8% correct and zero wrong.
 */
export function toTypedLine({ name, number, total } = {}) {
  if (!number) return null;
  const num = total ? `${number}/${total}` : String(number);
  return name ? `${name} ${num}` : num;
}

// ---------------------------------------------------------------------------
// A SWEEP, NOT A RECTANGLE.
//
// A single tightly-tuned band does read the number — x:0.155 w:0.16 returns
// "133/182" exactly on the benchmark card. Move it by 0.005 and it returns
// "122/7182", or nothing. That is tuned to one card, one era and one
// rectification, and the collector number has moved around the bottom edge
// repeatedly across twenty-five years of print runs.
//
// So do what the rest of this codebase does: produce CANDIDATES and let the
// catalogue arbitrate. Several overlapping bands are read, every "N/T" reading
// is collected, and the printed total is checked against the real set sizes.
// A reading whose denominator is not the size of any Pokemon set is not a
// collector number, whatever it looks like.
//
// That turns a fragile measurement into a vote, and it costs a few hundred
// milliseconds of OCR rather than a redesign per era.

/** Overlapping bands across the bottom-left, widest first. */
export const NUMBER_SWEEP = Object.freeze([
  { x: 0.155, y: 0.940, w: 0.160, h: 0.032 },
  { x: 0.140, y: 0.936, w: 0.200, h: 0.038 },
  { x: 0.050, y: 0.936, w: 0.330, h: 0.038 },
  { x: 0.170, y: 0.944, w: 0.150, h: 0.030 },
  { x: 0.100, y: 0.930, w: 0.300, h: 0.046 },
]);

/**
 * Read the collector number by sweeping several bands and scoring the results.
 *
 * @param {Buffer} rectified            rectified card
 * @param {(img: Buffer) => Promise<string>} ocr   runs OCR, returns raw text
 * @param {Set<number>|number[]} [knownTotals]     every real printed total
 * @returns {{number, total, votes, bands, arbitrated}|null}
 */
export async function readNumberBySweep(rectified, ocr, knownTotals) {
  const totals = knownTotals instanceof Set ? knownTotals : new Set(knownTotals ?? []);
  const seen = new Map();

  for (const band of NUMBER_SWEEP) {
    const img = await cropBand(rectified, band, { scale: 6 });
    if (!img) continue;
    let text;
    try { text = await ocr(img); } catch { continue; }
    const hit = readNumberBand(text);
    if (!hit?.number) continue;
    const key = `${hit.number}/${hit.total ?? ''}`;
    const prev = seen.get(key) ?? { ...hit, votes: 0, bands: 0 };
    prev.votes += 1;
    prev.bands += 1;
    seen.set(key, prev);
  }
  if (!seen.size) return null;

  const scored = [...seen.values()].map((r) => {
    const t = Number(r.total);
    // A denominator that is not the size of any real set is not a printed
    // total. This is the single strongest filter available and it costs
    // nothing — "7182" dies here, "182" survives.
    const plausible = Number.isFinite(t) && totals.has(t);
    return { ...r, plausible };
  });

  scored.sort((a, b) => (Number(b.plausible) - Number(a.plausible)) || (b.votes - a.votes));
  const best = scored[0];
  return { ...best, arbitrated: best.plausible };
}

// ---------------------------------------------------------------------------
// LET THE NUMBER NARROW IT, THEN LET THE NAME CHOOSE.
//
// Matching an OCR'd name against the whole 4,160-name catalogue asks too much
// of the OCR: "Mami" (Marnie's Scrafty, read off a real photo) matches nothing,
// so a correctly-read number is thrown away with it.
//
// But the number has already done most of the work. A collector number and a
// printed total narrow the catalogue to a handful of cards — on the benchmark
// photos, exactly two, because Paradox Rift and Destined Rivals both print 182
// cards. Choosing between "Doublade" and "Marnie's Scrafty" given "Mami" is
// easy; finding "Marnie's Scrafty" from "Mami" cold is not.
//
// So the name is never used to SEARCH. It is used to CHOOSE, against the small
// set the number already selected, and it must win by a margin or the line
// becomes a question — the same rule the typed resolver uses.

/** Cheap normalisation for comparing an OCR'd string to a catalogue name. */
const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Levenshtein, capped — we only care about small distances. */
function editDistance(a, b, cap = 6) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Every catalogue card at this (number, printed total).
 *
 * @param {object} deps  { cardDb, printedTotalFor }
 */
export function candidatesAtNumber(number, total, deps) {
  const { cardDb, printedTotalFor } = deps;
  const want = String(Number(String(number).replace(/^0+(?=\d)/, '')));
  const wantTotal = Number(total);
  const out = [];
  for (const id of Object.keys(cardDb)) {
    const cut = id.lastIndexOf('-');
    const num = id.slice(cut + 1);
    if (String(Number(num)) !== want && num !== String(number)) continue;
    if (Number.isFinite(wantTotal)) {
      if (printedTotalFor(id.slice(0, cut)) !== wantTotal) continue;
    }
    out.push(id);
  }
  return out;
}

/**
 * Choose among candidates using an OCR'd name.
 *
 * The comparison is against the FIRST n characters of each candidate, where n
 * is the length of what OCR actually produced — OCR truncates and garbles the
 * tail far more than the head, and the head is where the information is.
 *
 * @returns {{id, distance, runnerUp, margin, confident}|null}
 */
export function chooseByName(candidates, ocrName, cardDb, opts = {}) {
  const minMargin = opts.minMargin ?? 2;
  const key = nameKey(ocrName);
  if (!candidates?.length) return null;
  if (candidates.length === 1) {
    return { id: candidates[0], distance: null, runnerUp: null, margin: Infinity, confident: true };
  }
  if (key.length < 2) return null;

  const scored = candidates.map((id) => {
    const full = nameKey(cardDb[id]?.name);
    const head = full.slice(0, key.length);
    return { id, distance: Math.min(editDistance(key, head), editDistance(key, full)) };
  }).sort((a, b) => a.distance - b.distance);

  const best = scored[0];
  const second = scored[1];
  const margin = second ? second.distance - best.distance : Infinity;
  // A name that matches nothing is not evidence. Half the typed characters
  // wrong means OCR did not read this card's name.
  const tooFar = best.distance > Math.max(2, Math.floor(key.length / 2));
  return {
    id: best.id,
    distance: best.distance,
    runnerUp: second?.id ?? null,
    margin,
    confident: !tooFar && margin >= minMargin,
  };
}
