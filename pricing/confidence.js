// pricing/confidence.js
//
// Owner: A2 (Pricing engine) — Slice S2
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §3.5 (tunables) and §3.6 (Anthropic model)
//   - docs/V2_AUDIT.md §5.6 (race threshold rationale)
//   - docs/V2_AUDIT.md §5.22 (model hoisting)
//   - pricing/adapter.interface.md (adapter contract that consumes these)
//
// This module hoists every magic number in the verify + identify pipeline
// into a single, named, regression-tested constant. The numbers are
// load-bearing; lowering MIN_ACCEPT_SCORE or RACE_THRESHOLD has historically
// re-introduced wrong-correction bugs (V2_AUDIT §5.6). DO NOT change a value
// here without a corresponding fixture test in tests/regression/.
//
// ESM module — every export is a named const. No default export.

// =============================================================================
// VERIFY — race-and-score loop tunables
// =============================================================================

/**
 * verifyPokemon race-exit threshold.
 *
 * The Pokemon verify path fires N parallel queries against pokemontcg.io
 * (server.js:3677). Each per-query promise scores its results AS THEY ARRIVE
 * via scoreCandidate(). The first query whose best score reaches this
 * threshold triggers a {@link RACE_GRACE_MS}-ms grace window and then the
 * outer `await` resolves — short-circuiting the slowest-of-N tail latency.
 *
 * Drops verify worst-case from ~10 s (longest-of-N) to ~300–600 ms typical.
 *
 * Why 220:
 *   - scoreCandidate maxes around 50 (name) + 40 (HP) + 80 (number) + 50
 *     (set total) + 25 (set code) + 25 (set name) + 35 (suffix) + 15 × N
 *     (attacks) ≈ 320+ for a perfect match.
 *   - 220 means at least 4–5 of those 8 signals agreed. Below that we may
 *     race-exit on a half-match and miss a better candidate from a slower
 *     query.
 *   - Above ~250 we'd never race-exit — most real-world hits land ~200.
 *
 * DO NOT CHANGE WITHOUT A REGRESSION TEST. Tied to RG-08 in V2_ARCHITECTURE
 * §7.1 ("Bulbasaur Expedition #94 fixture, ME1 corrections").
 */
export const RACE_THRESHOLD = 220;

/**
 * Post-trigger grace window (milliseconds) before verify exits.
 *
 * Once a query crosses {@link RACE_THRESHOLD}, we wait this long for any
 * near-finished query to also score before resolving. Eliminates most
 * order-dependent regressions where a marginally-better candidate would
 * have arrived 50 ms later from another query.
 *
 * Why 150 ms:
 *   - pokemontcg.io tail latency for queries that have started but not
 *     finished is typically 50–200 ms by the time another query has
 *     scored ≥220. 150 ms catches most of them without adding meaningful
 *     latency to the success path.
 *
 * DO NOT CHANGE WITHOUT A REGRESSION TEST. Tied to RG-08.
 */
export const RACE_GRACE_MS = 150;

/**
 * Floor below which verifyPokemon rejects a match.
 *
 * After all queries settle, we pick the global-best candidate. If its score
 * is below this, we REJECT — i.e., return null and let the caller surface
 * the AI's verbatim identification (no DB cross-reference applied).
 *
 * Why 120 (RAISED FROM 40 in V1):
 *   - A score of 40–100 is typically "name matched but everything else is
 *     wrong" — leads to confidently-wrong "corrections" e.g. modern Bulbasaur
 *     swapped for 2002 Expedition #94 because only the name matched.
 *   - 120 requires at least 2–3 signals to agree (name + HP + number, or
 *     name + suffix + set total).
 *
 * DO NOT CHANGE WITHOUT A REGRESSION TEST. Tied to RG-09 ("MIN_ACCEPT_SCORE
 * rejects 100-score") and RG-29 ("Pokemon me1-3 must NOT return whatever
 * pokemontcg.io has").
 */
export const MIN_ACCEPT_SCORE = 120;

/**
 * HP-difference reject threshold (HP units, integer).
 *
 * Post-verify sanity check: if the AI reported HP differs from the DB HP by
 * more than this, the AI probably identified the wrong card entirely
 * (e.g. AI says "Meowth-GX SM262" with HP 200, but real SM262 has HP 170).
 * The verify result is annotated `verify_rejected: 'hp_mismatch'` and the
 * AI's identification stands.
 *
 * Also used in the local-DB short-circuit path (server.js:3558) — if both
 * sides have HP and they disagree by >20, fall through to pokemontcg.io
 * even when the set+number exact-matched.
 *
 * Why 20:
 *   - Sonnet 4.6 occasionally misreads HP from blurry / glare-affected
 *     images by 10–15 (e.g. reads 130 when card says 120). 20 is forgiving
 *     enough for OCR error but tight enough to catch wrong-card matches
 *     (different HP tiers are usually 30+ apart).
 *
 * Tied to RG-10 ("HP-mismatch reject").
 */
export const HP_MISMATCH_TOLERANCE = 20;

/**
 * Score above which we skip the image-double-check Anthropic call.
 *
 * maybeDoubleCheck (server.js:1188) compares the user scan vs the reference
 * image using Sonnet 4.6. Skipped when confidence_score >= this threshold —
 * saves a token-expensive Anthropic call on high-confidence matches.
 *
 * Why 200:
 *   - 200 is below RACE_THRESHOLD (220) by design — race-winning candidates
 *     are nearly always trustworthy without image compare.
 *   - Score of 120–200 is "we're matching, but signals disagree somewhere"
 *     — the image compare catches alt-art / wrong-printing cases there.
 *
 * Removing or raising this re-introduces the alt-art / wrong-printing bug
 * class (V2_AUDIT §5.3). DO NOT CHANGE WITHOUT A REGRESSION TEST.
 */
export const DOUBLE_CHECK_SCORE_GATE = 200;

// =============================================================================
// OCR-FIRST — Q3 re-enable safeguards (slice S15 will consume these)
// =============================================================================

/**
 * False-positive ceiling for the OCR-first scan path.
 *
 * Background job inspects the last 24 h of `scan_events` rows where
 * `endpoint='ocr-first'` and computes the rate of attempts where the
 * validation gate REJECTED the OCR candidate (i.e. the user's scan
 * didn't match the canonical reference image). If that rate exceeds this
 * value, emit a Sentry warning + log line. Auto-disable on threshold
 * breach is DEFERRED — too easy to misfire on small samples.
 *
 * Why 0.02 (2%):
 *   - The OCR-first path bypasses the slower Sonnet 4.6 identify call.
 *     Speed gain only justified if accuracy stays within 2% of identify.
 *   - V2_ARCHITECTURE §3.7 — operator-locked Q3 answer.
 *
 * Tied to RG-40 ("OCR_FIRST_FP_THRESHOLD breach → Sentry warning emitted").
 */
export const OCR_FIRST_FP_THRESHOLD = 0.02;

// =============================================================================
// ANTHROPIC MODEL — single source of truth (V2_AUDIT §5.22)
// =============================================================================
//
// V1 hardcoded `claude-sonnet-4-6` at three call sites (server.js:1140, 1219,
// 2716). V2 collapses to one config block here. A model bump is one PR, not
// three. F20 in the feature roster.

/**
 * Model used for the primary card identification call.
 *
 * Used by /api/identify and /api/identify-stream. Sonnet 4.6 is the current
 * sweet spot for cost vs accuracy on TCG card recognition; the prompt at
 * server.js:CARD_ID_SYSTEM_PROMPT is tuned for it and a model bump may
 * require prompt re-tuning.
 *
 * DO NOT BUMP WITHOUT a regression run on the fixture set
 * (tests/regression/identify-pipeline.spec.js).
 */
export const IDENT_MODEL = 'claude-sonnet-4-6';

/**
 * Model used by /api/read-set-code (the OCR-first short prompt that returns
 * just the set code + card number).
 *
 * Why same as IDENT_MODEL: consistent cost ceiling and consistent OCR
 * reading behaviour across the two paths. Slice S15 (OCR-first) may
 * downgrade this to a cheaper model after fixture tests confirm equivalent
 * accuracy on the short-form prompt.
 */
export const READ_SET_CODE_MODEL = 'claude-sonnet-4-6';

/**
 * Model used by maybeDoubleCheck — the image-compare gate that runs when
 * verify confidence is below {@link DOUBLE_CHECK_SCORE_GATE}.
 *
 * Why same as IDENT_MODEL: vision quality matters here too; this is the
 * call that catches alt-art / wrong-printing cases.
 */
export const DOUBLE_CHECK_MODEL = 'claude-sonnet-4-6';

/**
 * Model used by the OCR-first validation gate (slice S15) — Sonnet 4.6
 * compares the user's scan vs the canonical reference image and returns
 * `{match: bool, reason: string}`.
 *
 * NEW in V2 (Q3 OCR-first re-enable). DO NOT downgrade without fixture
 * tests RG-31..RG-40 passing.
 */
export const OCR_FIRST_VALIDATE_MODEL = 'claude-sonnet-4-6';

// =============================================================================
// scoreCandidate weights — hoisted in slice S6.
// =============================================================================
//
// V1 server.js:3413 had scoreCandidate as a 90-line function with weights
// inlined. S6 extracts scoreCandidate into pricing/adapters/pokemontcg.js as
// a pure function of (card, isPromo, d, weights) and centralises the weights
// here so a single regression (RG-08, RG-09, RG-29) catches drift.
//
// Mutating any value here REQUIRES updating those fixture tests in lockstep.
// The defaults below match V1 verbatim — no behaviour change in S6.

/**
 * scoreCandidate weights for the Pokemon adapter race-and-score loop.
 * See pricing/adapters/pokemontcg.js → scoreCandidate for the consumer.
 *
 * Sign convention: positive weights are evidence FOR the candidate;
 * negative weights are evidence AGAINST. The threshold pair
 * RACE_THRESHOLD / MIN_ACCEPT_SCORE both interpret the cumulative sum.
 */
export const SCORE_WEIGHTS = Object.freeze({
  // Name match
  NAME_EXACT: 50,
  NAME_SUBSTRING: 20,

  // HP match
  HP_EXACT: 40,
  HP_NEAR: 20,                // |aiHp - dbHp| <= 10

  // Card number — strongest signal
  NUMBER_EXACT: 80,
  NUMBER_SV_STRIPPED: 70,     // Hidden Fates SV-prefix stripped match
  NUMBER_PROMO_MISMATCH: -40, // promo-shape numbers mismatch
  NUMBER_MISMATCH: -10,       // any other number mismatch

  // Abilities
  ABILITY_PER_MATCH: 15,

  // Set total (printed denominator)
  SET_TOTAL_EXACT: 50,
  SET_TOTAL_NEAR: 20,         // diff <= 2
  SET_TOTAL_DIFF_MEDIUM: -30, // diff <= 10
  SET_TOTAL_DIFF_LARGE: -80,  // diff > 10

  // Set hint matches
  SET_CODE_MATCH: 25,
  SET_NAME_EXACT: 25,
  SET_NAME_FUZZY: 15,

  // Attack name overlap (separate from abilities; attacks weighted equally)
  ATTACK_NAME_PER_MATCH: 15,

  // Suffix (ex / GX / V / VMAX / VSTAR / EX / LV.X)
  SUFFIX_MATCH: 35,
  SUFFIX_MISMATCH: -50,

  // Regulation mark vs era — hard reject signal
  REG_MARK_ERA_FAIL: -100,
});

// =============================================================================
// SEALED — slice S17 (TCGPlayer Pro adapter for sealed products: F5).
// =============================================================================
//
// Sealed products are SKU-keyed and have no condition/printing/graded axis,
// so their confidence rubric is much simpler than the single-card sources.
//
// Baseline 0.85; +0.05 if the upstream "lastUpdated" stamp is fresher than
// SEALED_RECENT_THRESHOLD_HOURS; −0.10 if it's older than
// SEALED_STALE_THRESHOLD_DAYS. The resulting score is clamped to [0, 1] by
// the adapter (pricing/adapters/cardmarket-sealed.js → sealedConfidence()).
//
// Pure refactor — pricing/adapters/cardmarket-sealed.js consumes these
// constants (V2.0.1 swap from tcgplayer-pro to cardmarket-sealed).
// No behaviour change vs inlining the magic numbers there; centralising here
// keeps the "all confidence-affecting tunables live in one file" invariant
// from the slice S2 contract intact.

/** Sealed quote baseline confidence. Tuned to land just under
 *  cardmarket-html (0.95) but above pokemontcg.io (0.70) — TCGPlayer's
 *  paid-tier pricing data is more authoritative than the daily-snapshot
 *  embedded fields, but lives downstream of cardmarket's live scrape on
 *  the rare days that one succeeds. */
export const SEALED_BASE_CONFIDENCE = 0.85;

/** Boost applied when upstream data was refreshed within
 *  SEALED_RECENT_THRESHOLD_HOURS. */
export const SEALED_RECENT_BONUS = 0.05;

/** Penalty applied when upstream data is older than
 *  SEALED_STALE_THRESHOLD_DAYS. */
export const SEALED_STALE_PENALTY = -0.10;

/** Threshold (hours) below which a sealed quote earns SEALED_RECENT_BONUS. */
export const SEALED_RECENT_THRESHOLD_HOURS = 24;

/** Threshold (days) above which a sealed quote takes SEALED_STALE_PENALTY. */
export const SEALED_STALE_THRESHOLD_DAYS = 7;
