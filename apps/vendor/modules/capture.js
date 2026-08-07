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
