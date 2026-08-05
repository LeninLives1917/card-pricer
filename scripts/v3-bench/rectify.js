// scripts/v3-bench/rectify.js
//
// V3 Phase 0 — card-quad detection + perspective rectification.
//
// Replaces pricing/phash.js:cropToCard, which is a Sharp .trim() heuristic that
// measurement showed to be a randomiser rather than a crop: it cost 21 points of
// top-1 at full catalogue scale because the trim decision shifts with lighting,
// so the art box lands somewhere different on every capture (docs/V3_BENCHMARK.md §5.1).
//
// This instead finds the card's four corners and warps them onto a canonical
// 245x342 face. Framing then does not depend on lighting at all, and rotation
// and perspective are removed rather than tolerated.
//
// Runs on @techstark/opencv-js, which is the same WASM build that runs in the
// browser — this is intended to be the code B2 ships, not a Node-only prototype.

import sharp from 'sharp';
import { ready } from './cv.js';

export const CARD_W = 245;
export const CARD_H = 342;

// Detection runs on a downscaled copy: contour finding does not need full
// resolution and the cost is superlinear. The homography is computed in
// detection space then scaled back up, so output quality is unaffected.
const DETECT_MAX = 600;

// A trading card is 63x88mm -> 0.716. Accept a generous band around it so a
// tilted card (which foreshortens) still qualifies, while rejecting the frame
// border and long thin artefacts.
const ASPECT_MIN = 0.45;
const ASPECT_MAX = 1.05;

// The quad must occupy a real share of the frame. Below this it is probably a
// sticker, a logo inside the art, or noise.
const MIN_AREA_FRAC = 0.10;
const MAX_AREA_FRAC = 0.98;

// Reject the image border itself. Canny fires on the frame edge, that contour is
// always the largest quad present, and it passes every other filter — so a
// largest-quad-wins rule silently "detects" the whole frame and warps the
// background instead of the card. Measured: detection appeared to succeed 96% of
// the time while accuracy FELL, which is the signature of exactly this bug.
// A quad hugging all four edges is the frame, never the card.
const BORDER_EPS = 0.02;

// Outward expansion of the detected quad, as a fraction of half-diagonal.
const EXPAND = Number(process.env.QUAD_EXPAND ?? 0);

/** Order 4 points as [top-left, top-right, bottom-right, bottom-left]. */
function orderCorners(pts) {
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bot[1], bot[0]];
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/**
 * Detect the card quad in an image buffer.
 * Returns { corners, areaFrac, scale } in DETECTION space, or null.
 */
async function detectQuad(cv, buf) {
  const meta = await sharp(buf).metadata();
  const scale = Math.min(1, DETECT_MAX / Math.max(meta.width, meta.height));
  const dw = Math.max(1, Math.round(meta.width * scale));
  const dh = Math.max(1, Math.round(meta.height * scale));

  const raw = await sharp(buf).resize(dw, dh, { fit: 'fill' })
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
    // Canny thresholds are deliberately low: a card against a dark table or a
    // playmat can be a soft edge, and approxPolyDP tolerates a noisy contour
    // better than a missing one.
    cv.Canny(blur, edges, 30, 90);
    // Close 1px gaps so a broken border still yields a closed contour.
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, k);
    k.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = dw * dh;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        const frac = area / frameArea;
        if (frac >= MIN_AREA_FRAC && frac <= MAX_AREA_FRAC && area > bestArea) {
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          const o = orderCorners(pts);

          // Discard the image border (see BORDER_EPS above).
          const ex = dw * BORDER_EPS, ey = dh * BORDER_EPS;
          const hugsFrame =
            o.every(p => p.x <= ex || p.x >= dw - ex) &&
            o.every(p => p.y <= ey || p.y >= dh - ey);
          if (hugsFrame) { approx.delete(); c.delete(); continue; }

          const wTop = dist(o[0], o[1]), wBot = dist(o[3], o[2]);
          const hLeft = dist(o[0], o[3]), hRight = dist(o[1], o[2]);
          const w = (wTop + wBot) / 2, h = (hLeft + hRight) / 2;
          const aspect = h > 0 ? w / h : 0;
          if (aspect >= ASPECT_MIN && aspect <= ASPECT_MAX) {
            bestArea = area;
            bestQuad = { corners: o, areaFrac: frac };
          }
        }
      }
      approx.delete();
      c.delete();
    }
  } finally {
    src.delete(); grey.delete(); blur.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
  }

  return bestQuad ? { ...bestQuad, scale, dw, dh } : null;
}

/**
 * Rectify a card photo to a canonical CARD_W x CARD_H face.
 *
 * Returns { buffer, detected }. When no quad is found, `detected` is false and
 * the buffer is a plain resize — callers should count that, because detection
 * rate and match accuracy are separate failure modes and conflating them hides
 * which one is actually broken.
 */
export async function rectify(buf) {
  const cv = await ready();
  let quad = null;
  try { quad = await detectQuad(cv, buf); } catch { quad = null; }

  if (!quad) {
    const fallback = await sharp(buf).resize(CARD_W, CARD_H, { fit: 'fill' }).toBuffer();
    return { buffer: fallback, detected: false };
  }

  // Work at full resolution: undo the detection downscale.
  const meta = await sharp(buf).metadata();
  const inv = 1 / quad.scale;

  // Canny tends to lock onto the INNER edge of the card's coloured frame rather
  // than the outer physical edge, which zooms the rectified face in slightly
  // relative to the CDN reference and shifts every downstream crop box.
  // EXPAND pushes the quad outward from its centroid to compensate.
  const cx = quad.corners.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.corners.reduce((s, p) => s + p.y, 0) / 4;
  const src = quad.corners.flatMap(p => [
    (cx + (p.x - cx) * (1 + EXPAND)) * inv,
    (cy + (p.y - cy) * (1 + EXPAND)) * inv,
  ]);

  const raw = await sharp(buf).ensureAlpha().raw().toBuffer();
  const srcMat = new cv.Mat(meta.height, meta.width, cv.CV_8UC4);
  srcMat.data.set(raw);

  const dstMat = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, src);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);

  let out;
  try {
    cv.warpPerspective(srcMat, dstMat, M, new cv.Size(CARD_W, CARD_H),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
    out = await sharp(Buffer.from(dstMat.data), {
      raw: { width: CARD_W, height: CARD_H, channels: 4 },
    }).png().toBuffer();
  } finally {
    srcMat.delete(); dstMat.delete(); srcTri.delete(); dstTri.delete(); M.delete();
  }

  return { buffer: out, detected: true };
}
