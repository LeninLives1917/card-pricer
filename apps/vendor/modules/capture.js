// apps/vendor/modules/capture.js
//
// Live-camera capture primitives. Extracted so scanner-mode (phone paired
// via ?pair=ROOMID) and the Phase 1.2 burst harness share one camera path.
//
// WHY THIS EXISTS — `<input type="file" capture="environment">` hands the
// shot to the OS camera app, which ALWAYS interposes a review screen
// ("Use Photo" / "Retake") and returns to a cold camera afterwards. That
// review step is not suppressible from the web page: it belongs to the
// native app, not to us. Measured cost is roughly 3-5 seconds and two extra
// taps per card, which at a show is the difference between pricing a box
// and giving up. A getUserMedia preview inside the page has no handoff, no
// confirm, and no restart — grab a frame off the live <video> and the
// viewfinder is already live for the next card.
//
// Lifted from the V1 shell (public/index.html getUserMedia ~3675, zoom/torch
// ~3700-3770). The MECHANICS are reused; V1's tuning constants are not —
// BLUR_THRESHOLD = 120 was never validated against match correctness, so
// blur scoring lands in 1.2 with a measurement behind it, not here.

let _stream = null;
let _canvas = null;

export function isSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// getUserMedia is gated on a secure context. Render serves HTTPS so this is
// only ever false on a bare-IP LAN test — worth naming explicitly, because
// the browser's own error for it is opaque.
export function isSecureEnough() {
  return window.isSecureContext === true;
}

/**
 * Attach the rear camera to a <video> element.
 * Resolves once frames are actually flowing — a video element with a stream
 * but zero dimensions produces black JPEGs, which is exactly the kind of
 * plausible-but-empty output this project keeps getting bitten by.
 *
 * @returns {Promise<{ok: true, track: MediaStreamTrack} | {ok: false, error: string, reason: string}>}
 */
export async function startCamera(videoEl, { facingMode = 'environment' } = {}) {
  if (!videoEl) return { ok: false, reason: 'no_element', error: 'no video element' };
  if (!isSupported()) {
    return { ok: false, reason: 'unsupported', error: 'this browser has no camera API' };
  }
  if (!isSecureEnough()) {
    return { ok: false, reason: 'insecure', error: 'camera needs HTTPS' };
  }

  stopCamera();

  // Ask for a high-resolution rear stream, but every constraint is `ideal`
  // so a phone that cannot satisfy them still returns a usable stream
  // rather than throwing OverconstrainedError.
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };

  try {
    _stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    const name = e?.name || '';
    const reason =
      name === 'NotAllowedError' ? 'denied'
      : name === 'NotFoundError' ? 'no_camera'
      : name === 'NotReadableError' ? 'in_use'
      : 'failed';
    return { ok: false, reason, error: e?.message || name || 'camera failed' };
  }

  videoEl.srcObject = _stream;
  videoEl.setAttribute('playsinline', '');   // iOS: without this the video goes fullscreen
  videoEl.setAttribute('autoplay', '');
  videoEl.muted = true;

  try { await videoEl.play(); } catch { /* some browsers resolve late; the wait below covers it */ }

  const ready = await waitForFrames(videoEl);
  if (!ready) {
    stopCamera();
    return { ok: false, reason: 'no_frames', error: 'camera opened but produced no frames' };
  }

  return { ok: true, track: _stream.getVideoTracks()[0] || null };
}

// Poll until the element reports real dimensions. ~3s ceiling: a camera that
// has not produced a frame by then is not going to.
function waitForFrames(videoEl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function stopCamera() {
  if (_stream) {
    for (const t of _stream.getTracks()) {
      try { t.stop(); } catch { /* already ended */ }
    }
  }
  _stream = null;
}

export function isRunning() {
  return !!_stream && _stream.getVideoTracks().some((t) => t.readyState === 'live');
}

/**
 * Grab the current frame as a JPEG data URL. Synchronous and cheap — the
 * draw is the only cost, and the viewfinder keeps running throughout, so
 * the operator can shoot the next card immediately.
 *
 * maxWidth caps the long edge: 1600px keeps set symbols and collector
 * numbers legible while holding the upload near 300-500 KB, which matters
 * on venue wifi.
 */
export function captureFrame(videoEl, { maxWidth = 1600, quality = 0.85 } = {}) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;

  const sw = videoEl.videoWidth;
  const sh = videoEl.videoHeight;
  const scale = Math.min(1, maxWidth / Math.max(sw, sh));
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  if (!_canvas) _canvas = document.createElement('canvas');
  if (_canvas.width !== dw || _canvas.height !== dh) {
    _canvas.width = dw;
    _canvas.height = dh;
  }

  const ctx = _canvas.getContext('2d', { alpha: false });
  ctx.drawImage(videoEl, 0, 0, dw, dh);
  return _canvas.toDataURL('image/jpeg', quality);
}

/** Torch, where the device exposes it. Returns false when unsupported. */
export async function setTorch(on) {
  const track = _stream?.getVideoTracks?.()[0];
  if (!track || typeof track.getCapabilities !== 'function') return false;
  try {
    const caps = track.getCapabilities();
    if (!caps || !caps.torch) return false;
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  } catch {
    return false;
  }
}

export function hasTorch() {
  const track = _stream?.getVideoTracks?.()[0];
  if (!track || typeof track.getCapabilities !== 'function') return false;
  try { return !!track.getCapabilities()?.torch; } catch { return false; }
}

// ---------------------------------------------------------------------------
// RETICLE GEOMETRY.
//
// The reticle is not decoration once the gate reads it: it defines the region
// the frame gate analyses, so where it sits on screen and where it sits in the
// sensor frame have to be the same rectangle. They are not the same rectangle
// by default.
//
// The preview is laid out `width:100%; max-height:60vh`, so the element almost
// never has the sensor's aspect ratio. Under `object-fit: cover` the browser
// scales the frame up and crops the overflow, which means a box drawn at 62%
// of the ELEMENT covers some other fraction of the SOURCE — and the gate would
// grade a different rectangle from the one the operator is filling. The
// operator would be lining the card up against a lie.
//
// So the preview is `contain` and the geometry below is derived from the
// source frame, not the element. Contain letterboxes onto a black wrapper,
// which costs nothing visually and means the operator sees exactly what the
// sensor sees — worth having on its own for a scanner.

/** Card aspect: 63mm x 88mm. */
export const CARD_ASPECT = 63 / 88;

/** Share of the source frame's short axis the reticle spans. */
export const RETICLE_FILL = 0.78;

/**
 * The reticle as a rectangle of the SOURCE frame, in fractions.
 *
 * The LARGEST card-shaped box that fits inside `fill` of both axes, which is
 * the whole point — every pixel the reticle does not cover is sensor
 * resolution not spent on the collector number, and the number is the field
 * behind roughly 30% of failures.
 *
 * Sizing against the short axis instead looks equivalent and is not: in
 * portrait it produces a box spanning 44% of the height where 61% fits, and
 * quietly throws away a third of the card's pixels.
 *
 * The aspect is true in PIXELS. A box given as an independent fraction of
 * each axis is card-shaped at exactly one sensor aspect ratio and skewed at
 * every other, which is not a thing anyone would notice by looking.
 */
export function reticleRect(vidW, vidH, { fill = RETICLE_FILL } = {}) {
  if (!vidW || !vidH) return { x: 0, y: 0, w: 1, h: 1 };
  const pxH = Math.min(vidH * fill, (vidW * fill) / CARD_ASPECT);
  const pxW = pxH * CARD_ASPECT;
  const w = pxW / vidW, h = pxH / vidH;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * Where `object-fit: contain` actually paints the frame inside the element.
 * Returns CSS pixels, so the reticle overlay can be laid onto the letterboxed
 * video rather than onto the element that contains it.
 */
export function containedBox(elW, elH, vidW, vidH) {
  if (!vidW || !vidH || !elW || !elH) return { left: 0, top: 0, width: elW || 0, height: elH || 0 };
  const scale = Math.min(elW / vidW, elH / vidH);
  const width = vidW * scale, height = vidH * scale;
  return { left: (elW - width) / 2, top: (elH - height) / 2, width, height };
}

/** Draw the reticle region of the live frame into a canvas, for analysis. */
export function drawReticle(videoEl, canvas, size = 256) {
  const vw = videoEl?.videoWidth, vh = videoEl?.videoHeight;
  if (!vw || !vh) return null;
  const r = reticleRect(vw, vh);
  const sx = Math.round(r.x * vw), sy = Math.round(r.y * vh);
  const sw = Math.max(8, Math.round(r.w * vw)), sh = Math.max(8, Math.round(r.h * vh));
  const dw = Math.max(8, Math.round(size * CARD_ASPECT)), dh = size;
  if (canvas.width !== dw) { canvas.width = dw; canvas.height = dh; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

// ---------------------------------------------------------------------------
// CAMERA CONTROL — asking the phone for the things it already offers.
//
// This app asks for a rear camera at 1920x1080 and nothing else. V1 had
// tap-to-focus and pinch zoom (public/index.html ~3712-3750); the V3 rewrite
// dropped both and never replaced them. So every frame is shot on whatever
// autofocus and autoexposure decide, on a subject that is flat, close, often
// glossy, and sitting on a textured table — which is close to the worst case
// for a continuous-AF heuristic tuned for faces and scenery.
//
// This matters for a question bigger than itself. "Would a native app be more
// reliable" is largely a question about camera control, and it cannot be
// answered while the web path is asking for none. Everything below is a
// standard MediaStreamTrack capability, already shipping in Chrome on Android.
//
// EVERY CONTROL IS OPTIONAL AND EVERY OUTCOME IS COUNTED. Support varies by
// device and by Android version, and a control that silently does nothing is
// worse than no control — it produces an operator who believes the camera is
// locked. `cameraReport()` says what was asked for and what actually took.

const control = {
  // null until asked, so "never attempted" stays distinguishable from
  // "attempted and refused" — a 0 rate and a null rate mean different things.
  focus: null, exposure: null, zoom: null, still: null,
};
export function cameraReport() { return { ...control }; }
export function resetCameraReport() { for (const k of Object.keys(control)) control[k] = null; }

/**
 * Which focus/exposure constraints are worth applying, given what the track
 * says it supports. Pure, so the decision is testable without a camera.
 *
 * `continuous` rather than `manual`: the operator slides cards under a fixed
 * phone, so the subject distance barely changes but does change, and a manual
 * lock set on card one is wrong by card ten. Continuous with a centre point of
 * interest keeps it re-focusing on the card rather than on the table edge or a
 * hand entering the frame.
 */
export function focusConstraints(caps) {
  if (!caps) return [];
  const out = [];
  const modes = caps.focusMode || [];
  if (modes.includes('continuous')) out.push({ focusMode: 'continuous' });
  else if (modes.includes('single-shot')) out.push({ focusMode: 'single-shot' });
  const exp = caps.exposureMode || [];
  if (exp.includes('continuous')) out.push({ exposureMode: 'continuous' });
  // The card is dead centre by construction — the reticle put it there — so
  // metering and focusing anywhere else is measuring the table.
  if (caps.pointsOfInterest) out.push({ pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
  return out;
}

function track() {
  const t = _stream?.getVideoTracks?.()[0];
  return t && typeof t.getCapabilities === 'function' ? t : null;
}

/** Apply the focus/exposure constraints this device actually supports. */
export async function applyCameraControls() {
  const t = track();
  if (!t) { control.focus = false; control.exposure = false; return false; }
  let caps;
  try { caps = t.getCapabilities(); } catch { control.focus = false; return false; }
  const advanced = focusConstraints(caps);
  control.focus = advanced.some((c) => 'focusMode' in c);
  control.exposure = advanced.some((c) => 'exposureMode' in c);
  if (!advanced.length) return false;
  try { await t.applyConstraints({ advanced }); return true; }
  catch { control.focus = false; control.exposure = false; return false; }
}

/**
 * Re-focus on a point, as a fraction of the frame. Tap-to-focus, which V1 had.
 * Falls back to nudging continuous AF, which on several devices is the only
 * way to make it re-converge on a subject it has already given up on.
 */
export async function focusAt(x, y) {
  const t = track();
  if (!t) return false;
  try {
    const caps = t.getCapabilities();
    if (!caps?.pointsOfInterest) return false;
    await t.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }] }] });
    return true;
  } catch { return false; }
}

/**
 * Grab a still at the SENSOR's resolution rather than the preview's.
 *
 * captureFrame() draws the <video>, so it is capped by the preview stream —
 * 1080p, about 2 MP. ImageCapture.takePhoto() returns the full still, often
 * 12 MP. The reticle covers roughly three quarters of the frame, so that is
 * the difference between ~840px of card width and ~2300px.
 *
 * WORTH KNOWING WHAT THIS CAN AND CANNOT BUY. The 64 benchmark photographs are
 * already full-resolution originals (4000x2252) and still yield a readable
 * collector number on only 30 of them — and rectifying them to 1800x2520
 * changed that number by exactly zero. So resolution is not what is holding
 * the benchmark back, and this cannot beat it. What it does is stop the LIVE
 * path being worse than the benchmark, which at a 1600px cap it currently is.
 *
 * WHICH IS ALSO WHY IT IS CAPPED. The first version of this returned whatever
 * takePhoto() produced — up to 12 MP, around 5 MB once base64'd. That is ten
 * times the old payload, for detail the measurement says is not used, and it
 * OOM-killed the production instance within hours by way of the room replay
 * buffer (see apps/server/routes/room.js). STILL_MAX_EDGE puts the card at
 * roughly the benchmark's own ~1800px and stops there. Sending more than the
 * pipeline has ever been measured to use is cost with no evidence behind it.
 *
 * Falls back to the canvas grab, and records which path ran.
 */
export const STILL_MAX_EDGE = 2400;

export async function captureStill(videoEl, opts = {}) {
  const t = track();
  if (t && typeof window !== 'undefined' && typeof window.ImageCapture === 'function') {
    try {
      const blob = await new window.ImageCapture(t).takePhoto();
      const url = await downscaleBlob(blob, opts.maxEdge ?? STILL_MAX_EDGE, opts.quality ?? 0.85);
      if (url) { control.still = true; return url; }
    } catch { /* fall through — several devices advertise it and then throw */ }
  }
  control.still = false;
  return captureFrame(videoEl, opts);
}

/**
 * Decode a still and re-encode it at no more than `maxEdge` on the long side.
 *
 * Returns null rather than the original on failure. Handing back an
 * unbounded image because the resize failed is exactly the invisible fallback
 * that caused the incident — the caller would get a working photo and no
 * indication the cap had been skipped.
 */
async function downscaleBlob(blob, maxEdge, quality) {
  if (!blob) return null;
  let bmp = null;
  try {
    bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d', { alpha: false }).drawImage(bmp, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  } finally {
    if (bmp && typeof bmp.close === 'function') { try { bmp.close(); } catch { /* ignore */ } }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}
