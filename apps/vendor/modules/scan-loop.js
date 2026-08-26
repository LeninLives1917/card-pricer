// apps/vendor/modules/scan-loop.js
//
// When should a live viewfinder fire by itself?
//
// The operator holds the phone over the table, slides cards under it one at a
// time, and never touches the screen. That is the mode this decides.
//
// PURE. No DOM, no camera, no clock of its own — `now` is passed in — so
// `node --test` can drive a whole scanning session in a millisecond. The
// browser half is 30 lines of wiring in tabs/scan.js.
//
// ── THE PROBLEM THAT IS NOT "IS THIS FRAME GOOD" ───────────────────────────
//
// A frame gate answers "is this worth sending". It does NOT answer "have I
// already sent this", and a loop that only asks the first question points at
// one Charizard sitting on a table and uploads it forty times. There is no
// dedupe anywhere on this path today — pair.js posts whatever it is handed —
// so the loop has to bring its own.
//
// The obvious guard is wrong. Suppressing by card identity ("don't scan
// sv3-4 twice") silently eats the case the shop actually hits: someone brings
// four copies of the same card to be priced. Three of them would vanish, the
// counter would read four sent, and nothing anywhere would disagree. That is
// the exact defect class this project keeps writing down.
//
// So the rule is physical, not logical: FIRE ONCE, THEN WAIT FOR THE CARD TO
// LEAVE. Identity never enters into it — which is just as well, because in
// scanner mode the phone never learns what the card was (see below).
//
// Two ways back to armed, because one is not enough:
//
//   1. the reticle goes empty for CLEAR_FRAMES — the card was lifted;
//   2. the scene changes materially — the card was SLID OUT AND REPLACED in
//      one motion, which never produces an empty frame.
//
// Without (2) an operator who works by pushing the next card in with the
// previous one scans exactly one card and then stalls, and a stall reads as
// silence rather than as an error.

/** Consecutive empty reticle frames that mean the card was taken away. */
export const CLEAR_FRAMES = 3;

/**
 * Mean absolute luma difference that counts as "different card".
 *
 * UNMEASURED — there is no benchmark footage of one card replacing another.
 * Too low and a shadow re-arms the loop into a double scan; too high and the
 * slide-in operator stalls. It is exposed as an option and counted, and it is
 * one of the reasons auto-fire ships defaulted off.
 */
export const SCENE_CHANGE = 0.10;

/** Floor between two fires. Stops a flicker at the clear threshold double-firing. */
export const MIN_GAP_MS = 700;

/**
 * Frames of held focus before firing.
 *
 * Deliberately above the reticle's own STABLE_FRAMES: going green is cheap to
 * get wrong when a human then presses a button, and expensive to get wrong
 * when the shutter fires itself.
 */
export const LOCK_FRAMES = 4;

export const REASONS = Object.freeze([
  'fired',
  'not_ready',      // gate is not green
  'settling',       // green, but not for long enough yet
  'settling_scene', // the card was swapped and the view has not gone quiet yet
  'held',           // already fired; the card has not left
  'cooldown',       // fired too recently
]);

/**
 * @param {object} [opts]
 * @returns {(input: {state: string, sceneDelta?: number, now: number}) => {fire: boolean, reason: string}}
 */
export function createAutoFire(opts = {}) {
  const lockFrames = opts.lockFrames ?? LOCK_FRAMES;
  const clearFrames = opts.clearFrames ?? CLEAR_FRAMES;
  const sceneChange = opts.sceneChange ?? SCENE_CHANGE;
  const minGapMs = opts.minGapMs ?? MIN_GAP_MS;

  let greenRun = 0;
  let emptyRun = 0;
  let armed = true;
  let lastFire = -Infinity;
  // A scene-change re-arm is only half a permission. See `settling_scene`.
  let needsSettle = false;

  const counts = {
    frames: 0, fired: 0, held: 0, cooldown: 0,
    rearm_empty: 0, rearm_scene: 0, settling_scene: 0,
  };

  const push = ({ state, sceneDelta = 0, now }) => {
    counts.frames++;

    // Re-arm before anything else, so the frame that removes the card can
    // also be the frame that starts the next lock.
    if (!armed) {
      if (state === 'red') {
        emptyRun++;
        if (emptyRun >= clearFrames) { armed = true; emptyRun = 0; counts.rearm_empty++; }
      } else {
        emptyRun = 0;
        if (sceneDelta >= sceneChange) { armed = true; needsSettle = true; counts.rearm_scene++; }
      }
    } else if (state === 'red') {
      emptyRun = 0;
    }

    // A scene-change re-arm is only half a permission. The delta is measured
    // between consecutive frames, so a HIGH delta means the scene is still
    // moving — a hand crossing the reticle holds it high for a second or more.
    // Firing on that samples the middle of the movement and, worse, re-arms
    // again on the very next frame, so one swap becomes two or three scans.
    // The swap is only complete once the view goes quiet again.
    if (needsSettle && sceneDelta < sceneChange / 2) needsSettle = false;

    if (state !== 'green') { greenRun = 0; return verdict(false, 'not_ready'); }
    greenRun++;

    if (!armed) { counts.held++; return verdict(false, 'held'); }
    if (needsSettle) { counts.settling_scene++; return verdict(false, 'settling_scene'); }
    if (greenRun < lockFrames) return verdict(false, 'settling');
    if (now - lastFire < minGapMs) { counts.cooldown++; return verdict(false, 'cooldown'); }

    armed = false;
    greenRun = 0;
    lastFire = now;
    counts.fired++;
    return verdict(true, 'fired');
  };

  const verdict = (fire, reason) => ({ fire, reason, armed, greenRun });

  push.counts = () => ({ ...counts });
  push.reset = () => {
    greenRun = 0; emptyRun = 0; armed = true; needsSettle = false; lastFire = -Infinity;
    for (const k of Object.keys(counts)) counts[k] = 0;
  };
  return push;
}
