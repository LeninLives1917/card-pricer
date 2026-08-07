// pricing/fast-path-mode.js
//
// How much authority does the local pHash fast path have?
//
// CONTEXT (2026-08-07). The pHash index sat at a 3-entry canary for months,
// so the fast path effectively never fired and its accuracy was never
// observed. Rebuilding the index to 76,637 hashes turned it on for real. The
// first 11 production scans through the paired-phone flow recorded:
//
//     attempted 11 · hit 4 · miss 7
//
// and the operator reported 4 wrong cards, each a COMPLETELY different card
// rather than a near-miss printing.
//
// NOT ESTABLISHED: that those are the same 4. `hit` counts "the fast path
// answered", not "the answer was right", and nothing currently records which
// path produced which row — so the match of 4 to 4 is a coincidence worth
// investigating, not a demonstrated cause. The operator disputes the reading.
// It is settled by the `source` field already present on every card, which
// the UI now shows; one more scan session decides it with data.
//
// What IS established, independent of that question, is the mechanism that
// makes an unverified fast path unsafe at this index size:
//
//   - PHASH_HAMMING_MAX = 8 over 64 bits was chosen when the index was
//     effectively empty. Against 76k entries a distance-8 neighbourhood
//     collides readily, and collisions are unrelated cards, not near ones.
//   - lookupByHashes tries pHash, dHash AND wHash — three independent
//     chances to false-positive on every scan.
//   - a hit RETURNS IMMEDIATELY. Nothing verifies it, nothing scores it,
//     and pricing/accept-gate.js — which exists precisely to answer "may
//     this be auto-accepted?" — is imported by nothing in the request path.
//
// So the fast path is fast, confident, and unaccountable. The operator's
// standing instruction is that a wrong price is expensive and abstaining is
// always preferable to guessing.
//
// The fix is not to re-tune the threshold. Picking a new number against the
// same 11 observations would be fitting to noise, and this project has a
// written rule against claiming a rate without a measurement. Instead the
// fast path must EARN its authority:
//
//   'off'      — do not run the lookup at all.
//   'shadow'   — run it, record what it WOULD have said, then let the vision
//                model answer anyway. Agreement is counted. Costs a few ms
//                of hashing and nothing else. THIS IS THE DEFAULT.
//   'primary'  — trust a hit and skip the vision model. The behaviour that
//                produced the incident. Only appropriate once shadow-mode
//                agreement has been measured over a stated N.
//
// Shadow mode turns every real scan into a labelled data point at zero risk
// to the operator, which is the same argument made for LOCAL_MATCH_ENABLED
// in the V3 plan. The measurement it produces is what should choose the
// threshold — not a guess made today.

export const FAST_PATH_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  PRIMARY: 'primary',
});

/** Default when unset. Deliberately NOT 'primary'. */
export const DEFAULT_FAST_PATH_MODE = FAST_PATH_MODES.SHADOW;

/**
 * Resolve the mode from the environment.
 *
 * Unset -> shadow. Unrecognised -> shadow, with a warning: a typo must not
 * silently grant the fast path more authority than intended.
 */
export function getFastPathMode(env = process.env) {
  const raw = String(env.PHASH_FAST_PATH ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_FAST_PATH_MODE;
  if (raw === FAST_PATH_MODES.OFF) return FAST_PATH_MODES.OFF;
  if (raw === FAST_PATH_MODES.SHADOW) return FAST_PATH_MODES.SHADOW;
  if (raw === FAST_PATH_MODES.PRIMARY) return FAST_PATH_MODES.PRIMARY;
  console.warn(
    `[FAST-PATH] unrecognised PHASH_FAST_PATH="${raw}" — falling back to ` +
    `"${DEFAULT_FAST_PATH_MODE}". Valid: off | shadow | primary.`
  );
  return DEFAULT_FAST_PATH_MODE;
}

/**
 * Do two identifications refer to the same physical printing?
 *
 * Compared on (set_id, number) when both carry them — that pair is the
 * identity that determines price. Name is the fallback only, because two
 * printings sharing a name are a different card for our purposes and
 * agreeing on name alone would flatter the fast path.
 */
export function sameCard(a, b) {
  if (!a || !b) return false;
  const setA = norm(a.set_id), setB = norm(b.set_id);
  const numA = normNumber(a.number ?? a.card_number);
  const numB = normNumber(b.number ?? b.card_number);
  if (setA && setB && numA && numB) return setA === setB && numA === numB;
  const nameA = norm(a.name), nameB = norm(b.name);
  return !!nameA && nameA === nameB;
}

function norm(v) {
  return v == null ? '' : String(v).trim().toLowerCase();
}

// Collector numbers arrive as '4', '004', '4/102' and 'TG12'. Strip the
// denominator and leading zeroes so those compare equal.
function normNumber(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase().replace(/\/.*$/, '').replace(/^0+(?=.)/, '');
}
