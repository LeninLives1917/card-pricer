// scripts/v3-bench/cv.js
//
// V3 Phase 0 — OpenCV-WASM loader.
//
// @techstark/opencv-js ships a single CommonJS bundle (dist/opencv.js) that is
// an Emscripten module. It resolves to an object whose methods are NOT ready
// until the WASM runtime has initialised, so importing it is not enough — every
// caller must await ready() before touching cv.Mat.
//
// The same package runs in the browser, which is the point: the rectification
// written against this module is the code B2 ships, not a Node-only prototype.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let _cv = null;
let _pending = null;

/**
 * Resolve the OpenCV module once the WASM runtime is live.
 * Safe to call concurrently — initialisation is shared.
 */
export function ready() {
  if (_cv) return Promise.resolve(_cv);
  if (_pending) return _pending;

  _pending = (async () => {
    const mod = require('@techstark/opencv-js');
    const cv = mod?.default ?? mod;

    // Already initialised (some builds finish synchronously).
    if (typeof cv.Mat === 'function') { _cv = cv; return cv; }

    // Emscripten exposes a thenable in newer builds…
    if (typeof cv.then === 'function') {
      const resolved = await cv;
      _cv = resolved?.default ?? resolved;
      return _cv;
    }

    // …otherwise wait on the runtime callback, with a bounded timeout so a
    // failed WASM load surfaces as an error rather than hanging the benchmark.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('OpenCV WASM did not initialise within 60s')), 60_000);
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        clearTimeout(timer);
        if (typeof prev === 'function') { try { prev(); } catch { /* ignore */ } }
        resolve();
      };
    });

    _cv = cv;
    return cv;
  })();

  return _pending;
}
