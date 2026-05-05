// pricing/ocr-first/pipeline.js
//
// Owner: A2 (Pricing engine) — Slice S15
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §3.7 — pipeline diagram + safeguards
//   - docs/V2_AUDIT.md §5.2 — historical OCR-first failure mode the gate prevents
//   - memory/ocr_first_path.md — operator note: re-enable needs validation
//   - apps/server/routes/identify.js → readSetCodeFromImage, manualIdentifyCore
//   - pricing/ocr-first/parse.js → extractCardNumber
//   - pricing/ocr-first/validation.js → validateMatch
//   - pricing/ocr-first/telemetry.js → write + counter increments
//
// Steps:
//   1. read-set-code  (OCR pass on user image)
//   2. extractCardNumber → { set_code?, number, game }
//   3. manualIdentifyCore({ game, set_code, card_number, name }) — pure
//   4. validateMatch (Sonnet image-compare, gate)
//   5. telemetry write + metric increment
//
// Returns one of:
//   { validated: true,  card: <canonical card> }
//   { validated: false, fell_through_reason: <token>, ocr_set_code?: string }
//
// fell_through_reason tokens (stable; mirrored into scan_events.data):
//   'ocr_blank'                — read-set-code returned empty/NONE
//   'ocr_unparseable'          — extractCardNumber returned null
//   'identify_manual_miss'     — manualIdentifyCore returned no card
//   'no_reference_image'       — candidate has no reference_image (or fetch failed)
//   'validation_reject'        — Sonnet said match:false
//   'sonnet_error'             — Sonnet API/parse error
//
// The route layer is responsible for translating fell_through outcomes into
// the client-facing response. The client (next slice) treats `validated:false`
// as "go run /api/identify-stream the slow way".

import { extractCardNumber } from './parse.js';
import { validateMatch } from './validation.js';
import {
  writeOcrFirstAttempt,
  incrementOcrFirstCounter,
} from './telemetry.js';

/**
 * Orchestrate the OCR-first identify pipeline.
 *
 * @param {object} args
 * @param {Buffer} args.buffer        Raw image bytes from multer / data URL.
 * @param {string} args.mediaType     'image/jpeg' | 'image/png' | ...
 * @param {string} [args.hint]        Optional user-provided game hint
 *                                     (forwarded to manualIdentifyCore where
 *                                     applicable).
 * @param {object} args.deps          Wired-in collaborators so the pipeline
 *                                     stays unit-testable without booting
 *                                     Express. Required keys:
 *   - readSetCodeFromImage({buffer,mediaType}) → {text}|{error}
 *   - manualIdentifyCore({game,set_code,card_number,name}) → {cards}|{error}
 * @param {object} [args.ctx]         { userId } for telemetry attribution.
 *
 * @returns {Promise<{validated: true, card: object} |
 *                    {validated: false, fell_through_reason: string, ocr_set_code?: string}>}
 */
export async function runOcrFirst({ buffer, mediaType, hint, deps, ctx } = {}) {
  if (!deps?.readSetCodeFromImage || !deps?.manualIdentifyCore) {
    throw new Error('runOcrFirst: deps.readSetCodeFromImage and deps.manualIdentifyCore are required');
  }
  const userId = ctx?.userId || null;

  // The base64 of the user image is needed by validateMatch in step 4. We
  // compute it once here (not inside readSetCodeFromImage, which may resize)
  // and pass it down. validateMatch is happy with whatever media type the
  // caller provides — Sonnet handles JPEG/PNG/WEBP equivalently.
  const userImageBase64 = buffer.toString('base64');
  const userImageMediaType = mediaType || 'image/jpeg';

  // ---- Step 1: read-set-code OCR pass --------------------------------------
  let ocrText = null;
  try {
    const ocr = await deps.readSetCodeFromImage({ buffer, mediaType });
    if (ocr && typeof ocr.text === 'string' && ocr.text && ocr.text !== 'NONE') {
      ocrText = ocr.text;
    }
  } catch (e) {
    console.warn(`[OCR-FIRST-PIPELINE] read-set-code threw: ${e?.message || e}`);
  }

  if (!ocrText) {
    const reason = 'ocr_blank';
    writeOcrFirstAttempt(userId, {
      ocr_set_code: null,
      validated: false,
      fell_through_reason: reason,
    });
    incrementOcrFirstCounter(`fell_through_${reason}`);
    return { validated: false, fell_through_reason: reason };
  }

  // ---- Step 2: parse OCR text ----------------------------------------------
  const parsed = extractCardNumber(ocrText);
  if (!parsed || (!parsed.number && !parsed.set_code)) {
    const reason = 'ocr_unparseable';
    writeOcrFirstAttempt(userId, {
      ocr_set_code: ocrText,
      validated: false,
      fell_through_reason: reason,
    });
    incrementOcrFirstCounter(`fell_through_${reason}`);
    return { validated: false, fell_through_reason: reason, ocr_set_code: ocrText };
  }

  // ---- Step 3: manual identify --------------------------------------------
  let candidate = null;
  try {
    const result = await deps.manualIdentifyCore({
      game: parsed.game || hint || 'pokemon',
      set_code: parsed.set_code || null,
      card_number: parsed.number,
      name: undefined,  // OCR has no name; identify-manual matches on set+num
    });
    if (result && Array.isArray(result.cards) && result.cards.length > 0) {
      candidate = result.cards[0];
    }
  } catch (e) {
    console.warn(`[OCR-FIRST-PIPELINE] manualIdentifyCore threw: ${e?.message || e}`);
  }

  if (!candidate) {
    const reason = 'identify_manual_miss';
    writeOcrFirstAttempt(userId, {
      ocr_set_code: ocrText,
      validated: false,
      fell_through_reason: reason,
    });
    incrementOcrFirstCounter(`fell_through_${reason}`);
    return { validated: false, fell_through_reason: reason, ocr_set_code: ocrText };
  }

  // ---- Step 4: validation gate --------------------------------------------
  const verdict = await validateMatch({
    userImageBase64,
    userImageMediaType,
    candidateCard: candidate,
  });

  if (verdict.match === true) {
    writeOcrFirstAttempt(userId, {
      ocr_set_code: ocrText,
      validated: true,
      fell_through_reason: null,
    });
    incrementOcrFirstCounter('validated');
    return { validated: true, card: candidate };
  }

  // Map validation reason tokens straight into the telemetry field.
  // validateMatch returns one of: 'no_user_image' | 'no_candidate' |
  // 'no_reference_image' | 'validation_reject' | 'sonnet_error'.
  // 'no_user_image' / 'no_candidate' shouldn't reach this branch (we already
  // guarded for both above), but if they do we surface them honestly.
  const reason = verdict.reason || 'validation_reject';
  writeOcrFirstAttempt(userId, {
    ocr_set_code: ocrText,
    validated: false,
    fell_through_reason: reason,
    fp_signal: reason === 'validation_reject',  // counted by getFpRate24h
  });
  incrementOcrFirstCounter(`fell_through_${reason}`);
  return { validated: false, fell_through_reason: reason, ocr_set_code: ocrText };
}

export default runOcrFirst;
