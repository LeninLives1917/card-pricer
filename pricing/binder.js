// pricing/binder.js
//
// Binder-page card detection. A user uploads a single photograph of a
// 9-pocket (or 4/12) binder page; this module asks Sonnet 4.6 to return
// a tight bounding box per visible card. The /api/identify-binder route
// then crops each bbox via sharp and runs the result through the normal
// identifyCore pipeline in parallel — see apps/server/routes/identify.js.
//
// Why ask the model for normalised [0..1] coords instead of pixels:
// pixels would force us to either send the image dimensions in the
// prompt (wastes tokens) or hope the model guesses them right (it
// doesn't). Normalised coords mean we only need the image's actual
// dimensions on OUR side via sharp.metadata() — Claude never has to
// know the resolution.
//
// Ceiling note: with 12 cards on a page, the burst at /api/identify-binder
// is ~1 detect + 12 identifyCore + ~12 verify Sonnet calls in flight.
// That's near the soft 12-15-concurrent ceiling on the paid Anthropic
// tier. If we ever scan multiple pages back-to-back, chunk the per-crop
// loop in identify.js to ~8 to leave headroom.
//
// Pure function: takes a buffer + media type, returns a parsed bbox
// list. No HTTP, no file I/O, no side effects beyond the Anthropic call.
// Test-friendly via dependency injection of the anthropic client.

import { anthropic as defaultAnthropic } from '../apps/server/_clients.js';
import { BINDER_DETECT_MODEL } from './confidence.js';

const DETECT_PROMPT = `You are looking at a photograph of a trading-card binder page. The page contains between 4 and 12 cards arranged in a grid (typical layouts: 2x2, 2x3, 3x3, 3x4, 4x3).

For EACH visible card on the page, return a tight bounding box in normalised coordinates. (0,0) is the top-left corner of the photo, (1,1) is the bottom-right. x and y are the box's left/top edges; w and h are width/height. All four values are decimals between 0 and 1.

Output ONLY valid JSON in exactly this shape — no markdown, no explanation:
{ "cards": [ { "x": 0.05, "y": 0.08, "w": 0.30, "h": 0.42, "hint": "Pikachu" } ] }

Rules:
- The box must contain ONLY the card art + frame. Exclude the binder pocket border, thumbprints, glare highlights outside the card.
- "hint" is the card name IF you can read it confidently; OMIT the field entirely if unsure. Never guess.
- Skip empty pockets — only return boxes for actually-present cards.
- Order top-to-bottom, then left-to-right within each row.
- If you see fewer than 4 cards, still return what you see — the page may be partially filled.
- If the image is not a binder page (single card, random object, blank page), return { "cards": [] }.`;

/**
 * Detect cards on a binder-page photo. Returns up to 12 normalised bboxes.
 *
 * @param {object} args
 * @param {Buffer} args.buffer        Raw image bytes (JPEG/PNG/WebP).
 * @param {string} args.mediaType     'image/jpeg' | 'image/png' | 'image/webp'.
 * @param {object} [args.deps]        Optional DI for testing.
 * @param {object} [args.deps.anthropic] Anthropic client; defaults to the shared one.
 * @returns {Promise<{cards: Array<{x:number,y:number,w:number,h:number,hint?:string}>}>}
 */
export async function detectBinderCards({ buffer, mediaType, deps } = {}) {
  if (!buffer) return { cards: [] };
  const anthropic = deps?.anthropic || defaultAnthropic;
  const imageBase64 = buffer.toString('base64');

  let raw;
  try {
    const resp = await anthropic.messages.create({
      model: BINDER_DETECT_MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: DETECT_PROMPT },
        ],
      }],
    });
    raw = (resp.content?.[0]?.text || '').trim();
  } catch (err) {
    console.error('[BINDER-DETECT] Anthropic call failed:', err.message);
    return { cards: [], error: err.message };
  }

  return parseBinderResponse(raw);
}

/**
 * Pure parser — pulled out for unit tests. Strips markdown fences,
 * parses JSON, validates each bbox, and clamps coordinates.
 *
 * @param {string} raw  Sonnet's text response
 * @returns {{cards: Array, raw_text?: string}}
 */
export function parseBinderResponse(raw) {
  if (typeof raw !== 'string') return { cards: [] };
  // Strip markdown code fences if Sonnet adds them despite the prompt.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[BINDER-DETECT] JSON parse failed:', err.message, 'raw start:', cleaned.slice(0, 120));
    return { cards: [] };
  }

  const inputCards = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const cards = [];
  for (const c of inputCards) {
    const v = validateBbox(c);
    if (v) cards.push(v);
  }
  // Sort top-to-bottom, then left-to-right — Sonnet usually does this
  // already, but enforce it so the result-sheet ordering is stable.
  cards.sort((a, b) => {
    // Group rows by y within ~5% — same row, sort by x.
    if (Math.abs(a.y - b.y) < 0.05) return a.x - b.x;
    return a.y - b.y;
  });
  return { cards };
}

function validateBbox(c) {
  if (!c || typeof c !== 'object') return null;
  const x = numOrNull(c.x);
  const y = numOrNull(c.y);
  const w = numOrNull(c.w);
  const h = numOrNull(c.h);
  if (x == null || y == null || w == null || h == null) return null;
  if (w <= 0 || h <= 0) return null;
  // Reject too-tiny boxes (likely artifacts / false positives).
  if (w < 0.04 || h < 0.04) return null;
  // Reject boxes that fall entirely off-image.
  if (x >= 1 || y >= 1 || x + w <= 0 || y + h <= 0) return null;
  // Clamp into [0,1] so a slight overshoot ("0.001" past 1) doesn't kill
  // the box; pure invalid coords are caught above.
  const cx = clamp01(x);
  const cy = clamp01(y);
  const cw = clamp01(Math.min(w, 1 - cx));
  const ch = clamp01(Math.min(h, 1 - cy));
  if (cw < 0.04 || ch < 0.04) return null;
  const out = { x: cx, y: cy, w: cw, h: ch };
  if (typeof c.hint === 'string') {
    const hint = c.hint.trim().slice(0, 120);
    if (hint) out.hint = hint;
  }
  return out;
}

function numOrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export default { detectBinderCards, parseBinderResponse };
