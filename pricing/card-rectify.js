// pricing/card-rectify.js
//
// Card-quad detection + perspective rectification.
//
// Replaces the Sharp .trim() heuristic in cropToCard for photographs. Measured
// on 19,890 catalogue cards against realistic scenes (docs/V3_BENCHMARK.md §5):
//
//   cropToCard (.trim + 5% inset)        1.0% top-1
//   quad detection + perspective warp   40.5% top-1
//
// .trim() takes its background colour from the top-left pixel and removes
// uniform border within a threshold. On a clean CDN render it is a harmless
// no-op, which is why it survived review. On a photograph of a card lying on a
// table there is nothing uniform to trim, and the fixed 5% inset then lands the
// art box in a different place on every capture. It is not a weak crop, it is a
// randomiser, and an unstable frame produces an unstable hash.
//
// SAFETY / ROLLOUT
//   - Off by default. Set CARD_RECTIFY=1 to enable.
//   - OpenCV is imported lazily and optionally. If the module is absent or the
//     WASM runtime fails to initialise, every function here degrades to null and
//     cropToCard falls back to its original behaviour. Production cannot break
//     because of a missing optional dependency.
//   - Nothing here throws. Detection failure is a null return, not an error.
//
// Runs on @techstark/opencv-js, the same WASM build that runs in a browser, so
// this module is shared with the client-side matcher rather than duplicated.

import sharp from 'sharp';

// Output dimensions match cropToCard's existing contract (600x840, the standard
// 63x88mm card ratio). Callers and tests depend on this.
export const CARD_W = 600;
export const CARD_H = 840;

// Detection runs on a downscaled copy; contour finding does not need full
// resolution and its cost is superlinear. The homography is computed in
// detection space and scaled back up, so output quality is unaffected.
const DETECT_MAX = 600;

// A trading card is 63x88mm -> short/long = 0.716. Test the SHORT-OVER-LONG
// ratio, which is orientation-independent.
//
// An earlier version tested w/h against 0.45..1.05, which only ever accepted a
// card standing upright in the frame. Cards lying on a table do not: measured
// against the operator's first real photo set, the detector was finding the card
// perfectly (area 0.33 of frame, short/long 0.71 — exactly the card ratio) and
// then discarding it for being sideways. 0 of 8 detected.
// The band allows for foreshortening when the card is tilted.
const RATIO_MIN = 0.55;
const RATIO_MAX = 0.92;

const MIN_AREA_FRAC = 0.10;
const MAX_AREA_FRAC = 0.98;

// Reject the image border itself. Canny fires on the frame edge and that
// contour is always the largest quad present, so a largest-quad-wins rule
// silently "detects" the whole frame and warps the background instead of the
// card. Symptom when this regressed during development: detection rate rose to
// 96% while accuracy FELL.
const BORDER_EPS = 0.02;

// Accept the values a person would reasonably type. Requiring the literal '1'
// was a trap: CARD_RECTIFY=true looks correct to anyone, sets nothing, and
// reports nothing — the same invisible-failure shape as the rest of this
// codebase's history. Anything unrecognised stays OFF, so the flag can never
// enable itself by accident.
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export function isEnabled(env = process.env) {
  return TRUTHY.has(String(env.CARD_RECTIFY ?? '').trim().toLowerCase());
}

// -----------------------------------------------------------------------------
// lazy, optional OpenCV
// -----------------------------------------------------------------------------

let _cvPromise = null;
let _cvFailed = false;

async function loadCv() {
  if (_cvFailed) return null;
  if (_cvPromise) return _cvPromise;

  _cvPromise = (async () => {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const mod = require('@techstark/opencv-js');
      const cv = mod?.default ?? mod;

      if (typeof cv.Mat === 'function') return cv;
      if (typeof cv.then === 'function') {
        const r = await cv;
        return r?.default ?? r;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('opencv init timeout')), 30_000);
        cv.onRuntimeInitialized = () => { clearTimeout(timer); resolve(); };
      });
      return cv;
    } catch {
      // Missing dependency, or a WASM runtime that will not start. Either way
      // this feature is simply unavailable; the caller falls back.
      _cvFailed = true;
      return null;
    }
  })();

  return _cvPromise;
}

// -----------------------------------------------------------------------------
// geometry helpers
// -----------------------------------------------------------------------------

/** Order 4 points as [top-left, top-right, bottom-right, bottom-left]. */
function orderCorners(pts) {
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bot[1], bot[0]];
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function detectQuad(cv, buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;

  const scale = Math.min(1, DETECT_MAX / Math.max(meta.width, meta.height));
  const dw = Math.max(1, Math.round(meta.width * scale));
  const dh = Math.max(1, Math.round(meta.height * scale));

  const raw = await sharp(buffer).resize(dw, dh, { fit: 'fill' })
    .ensureAlpha().raw().toBuffer();

  const src = new cv.Mat(dh, dw, cv.CV_8UC4);
  src.data.set(raw);
  const grey = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let bestQuad = null;
  let bestArea = 0;

  try {
    cv.cvtColor(src, grey, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(grey, blur, new cv.Size(5, 5), 0);
    // Low thresholds: a card on a dark playmat can be a soft edge, and
    // approxPolyDP copes with a noisy contour better than a missing one.
    cv.Canny(blur, edges, 30, 90);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, k);
    k.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = dw * dh;
    let fallbackQuad = null, fallbackArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        const frac = area / frameArea;
        if (frac >= MIN_AREA_FRAC && frac <= MAX_AREA_FRAC && area > bestArea) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          const o = orderCorners(pts);

          const ex = dw * BORDER_EPS, ey = dh * BORDER_EPS;
          const hugsFrame =
            o.every(p => p.x <= ex || p.x >= dw - ex) &&
            o.every(p => p.y <= ey || p.y >= dh - ey);

          if (!hugsFrame) {
            const w = (dist(o[0], o[1]) + dist(o[3], o[2])) / 2;
            const h = (dist(o[0], o[3]) + dist(o[1], o[2])) / 2;
            const ratio = Math.min(w, h) / Math.max(w, h);
            if (ratio >= RATIO_MIN && ratio <= RATIO_MAX) {
              bestArea = area;
              bestQuad = { corners: o, scale, landscape: w > h };
            }
          }
        }
      }

      // Fallback: a rotated bounding box round the raw contour. approxPolyDP
      // only yields a 4-gon when all four corners are clean and in frame; a card
      // clipped by the frame edge, or one whose border blends into the surface,
      // never produces one. minAreaRect still recovers a plausible card
      // rectangle from a partial outline, gated on the same short/long ratio so
      // a badly clipped card — which genuinely cannot be rectified — still fails.
      if (!bestQuad) {
        const area = Math.abs(cv.contourArea(c));
        const frac = area / frameArea;
        if (frac >= MIN_AREA_FRAC && frac <= MAX_AREA_FRAC && area > fallbackArea) {
          const rot = cv.minAreaRect(c);
          const { width: rw, height: rh } = rot.size;
          const ratio = Math.min(rw, rh) / Math.max(rw, rh);
          // The box must actually be filled by the contour, else a sprawling
          // edge-noise contour can pass on ratio alone.
          const fill = area / Math.max(1, rw * rh);
          if (ratio >= RATIO_MIN && ratio <= RATIO_MAX && fill >= 0.70) {
            const vtx = cv.RotatedRect.points(rot);
            const o = orderCorners(vtx.map(v => ({ x: v.x, y: v.y })));
            fallbackArea = area;
            fallbackQuad = { corners: o, scale, landscape: rw > rh };
          }
        }
      }

      approx.delete();
      c.delete();
    }
    if (!bestQuad && fallbackQuad) bestQuad = fallbackQuad;
  } finally {
    src.delete(); grey.delete(); blur.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
  }

  return bestQuad;
}

// -----------------------------------------------------------------------------
// public
// -----------------------------------------------------------------------------

/**
 * Rectify a card photograph to a canonical CARD_W x CARD_H face.
 *
 * @param {Buffer} buffer  Raw image bytes.
 * @returns {Promise<Buffer|null>}  Rectified buffer, or null when OpenCV is
 *   unavailable or no card quad was found. Never throws.
 */
export async function rectifyCard(buffer) {
  if (!buffer || !buffer.length) return null;

  const cv = await loadCv();
  if (!cv) return null;

  let quad = null;
  try { quad = await detectQuad(cv, buffer); } catch { return null; }
  if (!quad) return null;

  let srcMat = null, dstMat = null, srcTri = null, dstTri = null, M = null;
  try {
    const meta = await sharp(buffer).metadata();
    const inv = 1 / quad.scale;

    // Map the card's LONG edge to the output's long side. For a card lying
    // landscape the geometric top edge is the long one, so rotating the corner
    // list by one puts it on the destination's vertical edge; without this the
    // warp squashes an 88mm edge into a 600px width and the face is unusable.
    const corners = quad.landscape
      ? [quad.corners[1], quad.corners[2], quad.corners[3], quad.corners[0]]
      : quad.corners;
    const src = corners.flatMap(p => [p.x * inv, p.y * inv]);

    const raw = await sharp(buffer).ensureAlpha().raw().toBuffer();
    srcMat = new cv.Mat(meta.height, meta.width, cv.CV_8UC4);
    srcMat.data.set(raw);

    dstMat = new cv.Mat();
    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, src);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H]);
    M = cv.getPerspectiveTransform(srcTri, dstTri);

    cv.warpPerspective(srcMat, dstMat, M, new cv.Size(CARD_W, CARD_H),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));

    return await sharp(Buffer.from(dstMat.data), {
      raw: { width: CARD_W, height: CARD_H, channels: 4 },
    }).removeAlpha().png().toBuffer();
  } catch {
    return null;
  } finally {
    for (const m of [srcMat, dstMat, srcTri, dstTri, M]) {
      try { m?.delete(); } catch { /* already freed */ }
    }
  }
}

/**
 * Both plausible orientations of the rectified face.
 *
 * Quad detection recovers the card's AXIS but not which end is up — four corners
 * look the same either way. On real table photos the result came out upside down
 * as often as not, so a matcher should score both and keep whichever wins.
 *
 * This is additive: `rectifyCard` keeps its single-Buffer contract, because
 * cropToCard and its regression suite depend on it. Callers that do their own
 * matching (the V3 scanner) use this instead.
 *
 * @param {Buffer} buffer  Raw image bytes.
 * @returns {Promise<{ primary: Buffer, alt: Buffer } | null>}  null when OpenCV
 *   is unavailable or no card quad was found. Never throws.
 */
export async function rectifyCardOrientations(buffer) {
  const primary = await rectifyCard(buffer);
  if (!primary) return null;
  try {
    const alt = await sharp(primary).rotate(180).png().toBuffer();
    return { primary, alt };
  } catch {
    return { primary, alt: primary };
  }
}
