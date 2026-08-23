// infra/observability/text-entry-counters.js
//
// Counts for the TYPED card-entry path — someone pasting lines into the Scan
// tab or the customer quote box, rather than photographing a card.
//
// Dependency-free, for the same reason as fast-path-counters.js and
// price-match-counters.js: reachable from offline scripts, must not start a
// metrics collector.
//
// WHY THIS EXISTS
//
// The typed path has never been measured. Every accuracy number this project
// has published measures the photo path. Meanwhile the typed path has its own
// copy of the defect the price adapters were just cleaned of:
//
//   apps/server/routes/identify.js:530
//     let best = results[0];
//     if (name) { const exact = results.find(...); if (exact) best = exact; }
//
// A line with no name, or a name that does not match any result exactly, gets
// search hit #1 returned as a confirmed identity. Nobody knows how often that
// happens, which is the entire problem — so this module counts it BEFORE the
// behaviour changes, and the fix is judged against a real denominator instead
// of an argument.
//
// Separately, resolveSetCode() cannot fail: on a miss it returns the raw code
// lowercased as a set id and carries on (set-aliases.js:170). That guess is
// load-bearing — `aliased: false` is what enables the ptcgoCode query rung at
// identify.js:478 — so it should not be removed on a hunch. It should be
// counted, and then removed or kept on the evidence.
//
// COUNT PER SOURCE, NOT IN AGGREGATE.
//
// Two routes reach the same core: /api/identify-manual (the operator's app,
// authenticated) and /api/v2/quote/identify-manual (the public customer quote
// box, rate-limited). They receive completely different input — the operator
// pastes set+number, customers paste whatever they have — so a blended rate
// describes neither. The same argument as price-match-counters.js:22-26.
//
// Watch the RATIO, and keep null distinct from zero:
//
//   first_hit_rate near 0    the ladder is finding real matches
//   first_hit_rate climbing  we are shipping unconfirmed identities
//   first_hit_rate null      nobody has typed a card since boot

/** Outcomes for a single typed lookup. Mutually exclusive; exactly one fires. */
const LOOKUP_OUTCOMES = [
  /** Exact catalogue key hit. No network, no ambiguity possible. */
  'local_hit',
  /** Upstream direct-id lookup `${setId}-${number}` returned a card. */
  'remote_direct',
  /** A query-ladder result whose name matched what was typed, exactly. */
  'remote_confirmed',
  /**
   * THE DEFECT. A query-ladder result taken as hit #1 without an exact-name
   * confirmation — either no name was typed, or none of the results matched
   * it. This is a plausible-looking identity nobody checked.
   */
  'remote_first_hit',
  /** Nothing anywhere. An honest miss. */
  'not_found',
  /** Set is in POKEMONTCG_UNRELIABLE, so upstream was deliberately skipped. */
  'skipped_unreliable',
  /** A non-English language was stated and the catalogue cannot answer for it. */
  'rejected_unsupported_lang',
];

/** Outcomes for resolving the typed set code, if one was typed at all. */
const SET_OUTCOMES = [
  /** The code was in PKM_SET_ALIASES. */
  'set_aliased',
  /**
   * The code was NOT in the table, so resolveSetCode guessed: raw.toLowerCase()
   * as a set id. It cannot report failure, so this is the only way to see it.
   */
  'set_guessed',
  /**
   * No set code was typed. Deliberately NOT part of the set-resolution
   * denominator — "never asked" is not "failed to resolve", and conflating
   * them is how a dead path reads as healthy.
   */
  'set_absent',
];

const bySource = new Map();
let lastFirstHit = null;

function slot(source) {
  if (!bySource.has(source)) {
    const s = {};
    for (const o of LOOKUP_OUTCOMES) s[o] = 0;
    for (const o of SET_OUTCOMES) s[o] = 0;
    bySource.set(source, s);
  }
  return bySource.get(source);
}

/**
 * @param {string} source  'vendor_text' | 'quote_text'
 * @param {string} outcome one of LOOKUP_OUTCOMES or SET_OUTCOMES
 * @param {{set_code?: string, card_number?: string, name?: string, query?: string}} [detail]
 */
export function countTextEntry(source, outcome, detail = null) {
  const s = slot(source);
  if (outcome in s) s[outcome] += 1;
  if (outcome === 'remote_first_hit' && detail) {
    // Keep one worked example. A rate tells you there is a problem; a sample
    // tells you what it looks like.
    lastFirstHit = {
      source,
      typed_name: detail.name ?? null,
      typed_set: detail.set_code ?? null,
      typed_number: detail.card_number ?? null,
      returned_name: detail.returned_name ?? null,
      returned_set: detail.returned_set ?? null,
      query: detail.query ?? null,
      at: new Date().toISOString(),
    };
  }
}

/** null when the denominator is 0 — "never asked" must not read as 0%. */
function rateOf(n, d) {
  return d > 0 ? n / d : null;
}

function derive(s) {
  const looked = LOOKUP_OUTCOMES.reduce((n, o) => n + s[o], 0);
  const confirmed = s.local_hit + s.remote_direct + s.remote_confirmed;
  // Set resolution is only meaningful when a set code was actually typed.
  const setAsked = s.set_aliased + s.set_guessed;
  return {
    ...s,
    lookups: looked,
    /** Share of lookups that returned an identity nobody confirmed. */
    first_hit_rate: rateOf(s.remote_first_hit, looked),
    /** Share that resolved to something we can stand behind. */
    confirmed_rate: rateOf(confirmed, looked),
    /** Share of TYPED set codes that fell through to resolveSetCode's guess. */
    set_guess_rate: rateOf(s.set_guessed, setAsked),
  };
}

export function getTextEntryCounts() {
  const by_source = {};
  const totals = {};
  for (const o of [...LOOKUP_OUTCOMES, ...SET_OUTCOMES]) totals[o] = 0;

  for (const [name, s] of bySource) {
    by_source[name] = derive(s);
    for (const k of Object.keys(totals)) totals[k] += s[k];
  }

  return {
    ...derive(totals),
    by_source,
    last_first_hit: lastFirstHit,
  };
}

/** Test seam. */
export function resetTextEntryCounts() {
  bySource.clear();
  lastFirstHit = null;
}

export { LOOKUP_OUTCOMES, SET_OUTCOMES };
