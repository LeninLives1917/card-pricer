# Review: pHash Card Lookup PR 1 (module + crawler + tests)

Spec: docs/design/phash-lookup.md  |  Auditor: reviewer, 2026-05-08

---

## Verdict

NEEDS CHANGES

Two blockers: (1) non-atomic disk write in flushToDisk can corrupt card-phashes.json on an interrupted write; (2) loadIndex does not guard against corrupt JSON and will throw an uncaught SyntaxError, crashing the server on boot. One major: PHASH_WRITE_MIN is aliased to SEALED_BASE_CONFIDENCE, silently coupling two unrelated semantic domains. All other areas pass.

---

## A. Test-case substitutions

**A1 phash.spec.js:193 -- JPEG q99 to q80 recompression**
Covers the design-doc scenario: minor recompression yields distance <= 8. Base image is a 2D gradient plus sinusoidal ripple, not a degenerate solid colour. A broken DCT normalisation or wrong AC-term extraction would push distance above 8. Acceptable substitute.

**A2 phash.spec.js:208 -- PNG vs JPEG-90 re-encode**
Mirrors real-world browser-upload path. Same non-degenerate base image. Would fail on wrong DCT extraction window. Acceptable substitute.

**A3 phash.spec.js:254 -- Horizontal gradient vs radial gradient**
Replaces solid green vs solid blue. Comment at phash.spec.js:258-263 correctly identifies the degenerate case: solid images concentrate all DCT energy at the DC term, which is excluded from the median; AC coefficients are near-zero for both, making the threshold a floating-point coin-flip. The substitute has dominant DCT energy in structurally different coefficient positions. Would fail on wrong 8x8 block extraction or wrong column-pass. Acceptable substitute.

**A4 DC-term in output hash -- phash.js:119-132**
Median computed over block.slice(1), 63 AC terms; DC at index 0 excluded from median calculation. Threshold loop runs over all 64 entries including block[0]. DC IS included in the 64-bit output hash. Design-correct: the spec says drop DC when computing the median, not from the output. Output is 64 bits as specified. No deviation.

---

## B. PHASH_WRITE_MIN = SEALED_BASE_CONFIDENCE -- coupling hazard

confidence.js:342:  export const PHASH_WRITE_MIN = SEALED_BASE_CONFIDENCE

This is a value alias, not an independent constant. JavaScript assigns the numeric value 0.85 to PHASH_WRITE_MIN at module-evaluation time. Any future edit to SEALED_BASE_CONFIDENCE silently changes the pHash write-through gate with no compiler warning and no test that names the coupling.

SEALED_BASE_CONFIDENCE (confidence.js:307-308) is the sealed-product pricing confidence baseline, tuned relative to cardmarket-html and pokemontcg.io adapters. PHASH_WRITE_MIN is the minimum Sonnet confidence for writing a hash-to-identity entry. Different domains, different tuning trajectories.

Recommendation: split into a dedicated constant.
  export const PHASH_WRITE_MIN = 0.85; // write-through gate -- see docs/design/phash-lookup.md

Severity: MAJOR (no bug today; invisible maintenance hazard; future sealed-pricing tuning silently degrades pHash index quality).

---

## C. CARD_DB field name -- entry.image vs entry.reference_image

Crawler reads entry.image at build-phash-db.js:100 and :121.

Verification:
1. data/card-db.json on-disk (direct inspection of first 3 entries): field is image. Field reference_image does not appear in the raw JSON.
2. _card-db-boot.js:210: lookupLocalDb maps entry.image to reference_image only in its return object. The crawler reads raw JSON directly, not via lookupLocalDb.
3. Design doc loose phrasing reference_image URL in the crawler section refers to the concept, not the field name.

Finding: CORRECT. No bug. The silent-zero-hashes scenario does not apply.

---

## D. Standard correctness audit

**D1 DCT-II formula (phash.js:47-58)**
scale = Math.PI * k / (2*N); cos(scale * (2*n+1)) expands to cos(pi*k*(2n+1)/(2N)). Standard DCT-II kernel. No normalisation factor applied; pHash is invariant to uniform coefficient scale because the median-threshold step cancels it. CORRECT.

**D2 BigInt hex round-trip (phash.js:183-184, phash.js:218)**
Serialise: hash.toString(16).padStart(16,0). Parse: BigInt(0x+hexStr). Lossless for any 64-bit BigInt. Design-doc-specified serialisation. CORRECT.

**D3 Non-atomic disk writes: BLOCKER**
phash.js:188-193: flushToDisk uses fs.promises.writeFile, which overwrites the file in-place without atomicity.

Failure mode (a): process killed mid-write produces a truncated file. On next boot loadIndex reads truncated JSON, JSON.parse throws (see D4), crashing the server on every restart permanently.

Failure mode (b): two concurrent callers of flushToDisk can race. Concrete path: addToIndex (line 239) awaits flushToDisk() when the count threshold is hit. The idle timer set at line 249 fires simultaneously and calls flushToDisk().catch(console.error). flushNow cancels the timer but there is a window between addToIndex setting the timer (line 248) and flushNow calling clearTimeout.

Fix: write to .tmp then atomic rename.
  const tmp = PHASH_FILE + ".tmp";
  await fs.promises.writeFile(tmp, json, "utf8");
  await fs.promises.rename(tmp, PHASH_FILE);
fs.promises.rename is atomic on POSIX (Render runs Linux). Eliminates failure mode (a). For (b): note as known limitation or add a serialised write queue.

Severity: BLOCKER.

**D4 loadIndex corrupt JSON: BLOCKER**
phash.js:215: JSON.parse(raw) throws SyntaxError on corrupt input. Exception propagates uncaught out of loadIndex(). If PR 2 does not wrap loadIndex() in try/catch in server.js boot path, a single interrupted write (D3) permanently crashes the server on every subsequent startup.

Fix: wrap JSON.parse in try/catch. On SyntaxError: log a warning and return, treating state as empty index.

Severity: BLOCKER. D3 creates the corrupt file; D4 turns it into a crash loop. Fix both in the same patch.

**D5 dry-run flag (build-phash-db.js:103-105)**
allEntries.slice(0, DRY_RUN_LIMIT) runs before asyncPool. Pool receives at most 50 entries. Does not process all 25k cards. CORRECT.

**D6 Async pool momentary over-concurrency (build-phash-db.js:45-55)**
Promise.race resolves when the first promise settles; the .finally callback (which removes from inFlight) is microtask-queued after the race result is processed. Window where inFlight.size == concurrency+1. At concurrency=5 this means 6 in-flight momentarily. Unlikely to trigger CDN rate limits in practice. Severity: MINOR.

**D7 Skip-log append mode (build-phash-db.js:63)**
fs.appendFileSync -- append not overwrite. CORRECT for resumable crawl.

**D8 Resume skip logic (build-phash-db.js:88-101)**
Skip-set keyed by card identity set_id-number, matching the card-db map key format used at line 101. CORRECT.

---

## E. Project conventions

Module system: package.json declares type module. All existing pricing/*.js use ESM. phash.js and build-phash-db.js use ESM. CONSISTENT.
Comment style: file headers explain rationale and cross-references. Inline comments explain why (DC term exclusion, brightness bias). No what-narration. Clean.
Test style: node:test flat test() calls. Matches project test runner in package.json. Internally consistent.

---

## F. Out-of-scope creep

Searched apps/server/server.js and pricing/identify-core.js for phash, loadIndex, addToIndex, computePhash. NO MATCHES. PR 1 scope clean -- no wiring into identifyCore or server.js.

---

## Specific change requests

1. pricing/phash.js:188-193 -- Replace fs.promises.writeFile with write-to-tmp then fs.promises.rename (atomic on POSIX). Prevents file corruption on interrupted writes.

2. pricing/phash.js:215 -- Wrap JSON.parse(raw) in try/catch. On SyntaxError: log warning and return (empty index). Prevents crash loop after interrupted write.

3. pricing/confidence.js:342 -- Change to export const PHASH_WRITE_MIN = 0.85; with a comment citing docs/design/phash-lookup.md. Decouples pHash write-through gate from sealed-product pricing floor.

---

## Open questions for JARVIS

1. Concurrent addToIndex calls (D3b): Does PR 2 invoke addToIndex from concurrent request handlers simultaneously? If yes, a write serialiser is required on top of the atomic rename. If no (sequential per-request, single-threaded event loop), atomic rename alone suffices.

2. PHASH_WRITE_MIN decoupling (B): If operator prefers keeping shared 0.85 by deliberate policy, at minimum add an explicit cross-reference comment in confidence.js so future editors see the coupling, and a regression test asserting PHASH_WRITE_MIN by name.

---

## Security pass

AuthN/AuthZ: Not applicable -- PR 1 adds no endpoints.
Input validation: computePhash accepts any Buffer Sharp can decode. Sharp throws on malformed images; exception propagates to caller. Acceptable.
Parameterised queries: Not applicable.
Secrets in diff: None found.
New deps: None added. axios and sharp already in dependencies. No lockfile changes.

---

## Tests

Coverage: Good. 26 tests across two spec files cover the full API surface including threshold edge cases (exact boundary hit/miss, threshold=0, varying threshold), min-distance preference, and insertion-order independence.

Notable gaps (not required by design doc test plan, but would have caught the blockers):
- No test for loadIndex on a corrupt file (would catch D4).
- No test for addToIndex + flushNow concurrency (would catch D3b).
- No round-trip test: addToIndex then flushNow then loadIndex then lookupByPhash (would catch hex serialisation regressions).

---

NEEDS CHANGES. Most important next action: patch pricing/phash.js with (1) atomic write via tmp-file rename at flushToDisk lines 188-193 and (2) JSON.parse guard at loadIndex line 215. D3 produces the corrupt file; D4 turns it into a crash loop.
