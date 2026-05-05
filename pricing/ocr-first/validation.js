// pricing/ocr-first/validation.js
//
// Owner: A2 (Pricing engine) — Slice S15
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §3.7 (validation gate is the whole point)
//   - docs/V2_AUDIT.md §5.2 (historical OCR-first failure mode the gate prevents)
//   - memory/ocr_first_path.md (re-enabling needs name/HP cross-check; this
//     gate satisfies that constraint via image-compare)
//   - pricing/identify-core.js → maybeDoubleCheck (mirror prompt + Sonnet shape)
//   - pricing/confidence.js → OCR_FIRST_VALIDATE_MODEL
//   - pricing/adapters/pokemontcg.js → prefetchRefImage (reused download path)
//
// The validation gate is the safeguard that stops the OCR-first pipeline
// from re-introducing the silent wrong-card returns documented in
// V2_AUDIT §5.2. A successful read-set-code + identify-manual lookup can
// still be the WRONG card (alt-art, wrong era, sleeved blur, etc.) — the
// printed set-code/number alone are not enough. We hand both images to
// Sonnet 4.6 and only trust the result when Sonnet says "same printing".
//
// Failure modes — every one returns {match:false, reason:<token>}:
//   - candidateCard is null/undefined         → 'no_candidate'
//   - candidateCard.reference_image missing   → 'no_reference_image'
//   - reference image download failed         → 'no_reference_image'
//   - Sonnet API error                        → 'sonnet_error'
//   - Sonnet response unparseable             → 'sonnet_error'
//   - Sonnet says match:false                 → 'validation_reject'
//
// Caller (pipeline.js) maps these tokens straight into the
// fell_through_reason telemetry field — keep them stable.

import { axios, anthropic } from '../../apps/server/_clients.js';
import { OCR_FIRST_VALIDATE_MODEL } from '../confidence.js';

/**
 * Mirror of pricing/identify-core.js's media-type sniff. Reference images
 * come from pokemontcg.io (PNG), Scryfall (JPG), TCGdex (JPG/PNG) — sniff
 * by extension; default to PNG which is the most common reference format.
 */
function sniffMediaType(url) {
  if (!url) return 'image/png';
  if (/\.png($|\?)/i.test(url)) return 'image/png';
  if (/\.jpe?g($|\?)/i.test(url)) return 'image/jpeg';
  if (/\.webp($|\?)/i.test(url)) return 'image/webp';
  return 'image/png';
}

/**
 * Compare the user's scan to a candidate card's canonical reference image.
 * Returns {match: bool, reason: string}. Never throws.
 *
 * @param {object} args
 * @param {string} args.userImageBase64       Raw base64 (no data: prefix)
 *                                             of the user's scan.
 * @param {string} args.userImageMediaType   'image/jpeg'|'image/png'|...
 * @param {object} args.candidateCard        The card returned by
 *                                             /api/identify-manual. Must
 *                                             include `reference_image`.
 * @returns {Promise<{match: boolean, reason: string}>}
 */
export async function validateMatch({ userImageBase64, userImageMediaType, candidateCard }) {
  if (!userImageBase64) {
    return { match: false, reason: 'no_user_image' };
  }
  if (!candidateCard || typeof candidateCard !== 'object') {
    return { match: false, reason: 'no_candidate' };
  }
  if (!candidateCard.reference_image) {
    return { match: false, reason: 'no_reference_image' };
  }

  // Reuse the prefetch contract from identify-core: an axios GET with
  // arraybuffer + 8s timeout. Never throws — we catch and surface a
  // 'no_reference_image' fall-through token if the download fails.
  let refResp;
  try {
    refResp = await axios.get(candidateCard.reference_image, {
      responseType: 'arraybuffer',
      timeout: 8000,
    });
  } catch (e) {
    console.warn(`[OCR-FIRST-VALIDATE] reference image fetch failed for "${candidateCard.name}": ${e?.message || e}`);
    return { match: false, reason: 'no_reference_image' };
  }
  const refBase64 = Buffer.from(refResp.data).toString('base64');
  const refMediaType = sniffMediaType(candidateCard.reference_image);

  // Mirror the maybeDoubleCheck prompt verbatim. Tuned for "different
  // printings of the same Pokemon are NOT matches" — exactly what the
  // OCR-first gate needs to catch alt-art / wrong-era / sleeved-blur cases.
  let resp;
  try {
    resp = await anthropic.messages.create({
      model: OCR_FIRST_VALIDATE_MODEL,
      max_tokens: 150,
      system: [{
        type: 'text',
        text:
          'You compare two trading-card images and decide if they show the SAME printing. ' +
          'Respond with ONLY JSON: {"match": true|false, "reason": "short phrase"}. ' +
          'A match means same card name, same set, and same art/foil/border variant. ' +
          'Different printings of the same Pokemon (base vs reverse holo vs secret rare vs ' +
          'alt art vs wrong era) are NOT matches — look at art, border, foil pattern, ' +
          'set symbol, card number. Different language printings of the SAME art ARE a ' +
          'match (a German Glurak printing of Charizard from set X equals the English ' +
          'Charizard from set X). If unsure, return match:true (we only reject confident ' +
          'mismatches).',
      }],
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Image 1 is the user's scan. Image 2 is the candidate (${candidateCard.name || '?'} from ${candidateCard.set_name || '?'} #${candidateCard.card_number || '?'}). Same card printing?`,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: userImageMediaType || 'image/jpeg', data: userImageBase64 },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: refMediaType, data: refBase64 },
          },
        ],
      }],
    });
  } catch (e) {
    console.warn(`[OCR-FIRST-VALIDATE] Sonnet call failed for "${candidateCard.name}": ${e?.message || e}`);
    return { match: false, reason: 'sonnet_error' };
  }

  const text = resp?.content?.[0]?.text || '';
  let parsed = null;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }

  if (!parsed || typeof parsed.match !== 'boolean') {
    console.warn(`[OCR-FIRST-VALIDATE] unparseable Sonnet response for "${candidateCard.name}": ${String(text).slice(0, 120)}`);
    return { match: false, reason: 'sonnet_error' };
  }

  if (parsed.match === true) {
    console.log(`[OCR-FIRST-VALIDATE] CONFIRMED "${candidateCard.name}" — ${parsed.reason || '(no reason)'}`);
    return { match: true, reason: parsed.reason || 'confirmed' };
  }

  console.log(`[OCR-FIRST-VALIDATE] REJECTED "${candidateCard.name}" — ${parsed.reason || '(no reason)'}`);
  return { match: false, reason: 'validation_reject' };
}

export default validateMatch;
