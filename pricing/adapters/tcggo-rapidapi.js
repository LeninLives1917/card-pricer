// pricing/adapters/tcggo-rapidapi.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md §5 (confidence 0.85 base + 0.05 active liquidity)
//   - V1 server.js: fetchRapidAPICardmarketPrice + lookupViaTCGGO
//
// TCGGO is the highest-trust EUR source. Has graded comps for Pokemon
// (PSA10, PSA9, CGC10). Pokemon-only. See TCGGO_HOST below for which of the
// provider's two RapidAPI listings this talks to, and why it matters.

import { axios } from '../../apps/server/_clients.js';
import { PKM_SET_NAMES } from '../set-aliases.js';
import { countPriceMatch } from '../../infra/observability/price-match-counters.js';
import { normaliseCardNumber } from '../card-number.js';

const NAME = 'tcggo-rapidapi';

// Was 5. The match gate requires the card number to agree, so the only way a
// correct printing gets priced is if it appears on the search page at all — a
// 5-result page is the binding constraint on coverage, not the gate. Same call,
// same credit, four times the chance the right card is on it.
const SEARCH_PAGE_SIZE = 20;

// Upstream locks the page size at 20 and a common name runs to a dozen pages.
// Bounded because this runs per priced card, in front of a customer.
const MAX_SEARCH_PAGES = Number(process.env.TCGGO_MAX_PAGES || 6);

// ---------------------------------------------------------------------------
// UPSTREAM ENDPOINT
//
// Two RapidAPI listings from the same provider serve this data, with the same
// response shape and DIFFERENT quotas:
//
//   pokemon-tcg-api.p.rapidapi.com/cards/search        free tier, 100/day
//   cardmarket-api-tcg.p.rapidapi.com/{game}/cards     the subscribed plan
//
// The adapter pointed at the first one, so a plan upgrade on the second had no
// effect at all — the shop stayed on 100 requests a day, which is 50-100 cards
// and then a silent fall-back to nine-month-old prices.
//
// The subscribed listing also returns MORE per card: episode.code and
// episode.cards_printed_total (which make a real set gate possible, see
// chooseTcggoCandidate) and cardmarket_id.
//
// Overridable by env so the host can be moved without a deploy.
export const TCGGO_HOST = process.env.TCGGO_HOST || 'cardmarket-api-tcg.p.rapidapi.com';
const TCGGO_PATHS = { pokemon: '/pokemon/cards' };

function tcggoUrl(game = 'pokemon') {
  const path = TCGGO_PATHS[game];
  return path ? `https://${TCGGO_HOST}${path}` : null;
}
function tcggoHeaders(apiKey) {
  return { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': TCGGO_HOST, Accept: 'application/json' };
}

/** The denominator the operator or the catalogue gave us, if any. */
export function printedTotalOf(card) {
  const direct = card?.printed_total ?? card?.printedTotal ?? card?.total;
  if (direct != null && String(direct).trim() !== '') {
    const n = parseInt(String(direct), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const m = String(card?.card_number ?? '').match(/\/\s*(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * How strongly does this upstream candidate agree with the card we asked for,
 * on the SET dimension? Returns null when nothing corroborates.
 *
 * WHY THIS REPLACED A SCORE
 *
 * The old loop did:
 *
 *     let score = 60;
 *     if (item.name.includes(card.name))          score += 50;
 *     if (item.episode.name.includes(set_name))   score += 30;
 *     if (score > bestScore) { bestScore = score; best = item; }
 *
 * The set CONTRIBUTED to a score rather than excluding anything, and it was a
 * substring test on a display name. Measured 24 Aug 2026 against production,
 * Charizard / set_code BS / number 4:
 *
 *     without set_name   lowest_nm EUR 165   -> matched CELEBRATIONS #4
 *     with    set_name   lowest_nm EUR 380   -> matched Base Set #4
 *
 * One optional field decided a 2.3x price. Worse, "Base" is a substring of
 * "Base Set 2", so several candidates tie on 90 and `score > bestScore` keeps
 * whichever the upstream happened to return first. That is first-hit-wins on
 * the set dimension, the same defect this project has now closed in four other
 * adapters.
 *
 * Evidence, strongest first:
 *   'code'       episode.code equals our printed set code. Aligns for many sets
 *                (AR, DAA, RCL, FCO) but NOT all: our catalogue carries
 *                ptcgo-style codes and TCGGO carries Cardmarket's own
 *                abbreviations, so SV1/SVI, G2/GC, N4/NDE, PR/WP and SV2/PAL
 *                all disagree. Strong when it matches; absent, not wrong, when
 *                it does not.
 *   'total'      the set's printed card count equals the denominator we hold.
 *                The disambiguator docs/V3_BENCHMARK.md section 18 measured at
 *                99.6% catalogue uniqueness, finally reaching the price path.
 *   'name_exact' the display names are equal after normalising case, accents
 *                and punctuation. MEASURED to be the rescue for exactly the
 *                cards whose codes diverge: all six sets checked on 24 Aug 2026
 *                (Scarlet & Violet, Gym Challenge, Neo Destiny, POP Series 2,
 *                Wizards Black Star Promos, Paldea Evolved) matched their name
 *                exactly while their codes did not. Coverage went 87% -> 98%.
 *   'name'       a display-name SUBSTRING. Weak, a tie-breaker only, never
 *                sufficient alone — this is precisely what produced the bug,
 *                because "Base" is a substring of "Base Set 2".
 */
const normSetName = (v) => String(v ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export function setEvidence(item, card) {
  const epCode = String(item?.episode?.code ?? '').toUpperCase().trim();
  const ourCode = String(card?.set_code ?? '').toUpperCase().trim();
  if (epCode && ourCode && epCode === ourCode) return 'code';

  const ourTotal = printedTotalOf(card);
  const epTotal = Number(item?.episode?.cards_printed_total ?? item?.episode?.cards_total);
  if (ourTotal && Number.isFinite(epTotal) && epTotal > 0 && epTotal === ourTotal) return 'total';

  const epNorm = normSetName(item?.episode?.name);
  const ourNorm = normSetName(card?.set_name);
  if (epNorm && ourNorm && epNorm === ourNorm) return 'name_exact';
  if (epNorm && ourNorm && epNorm.includes(ourNorm)) return 'name';

  return null;
}

const EVIDENCE_RANK = Object.freeze({ code: 4, total: 3, name_exact: 2, name: 1 });

/**
 * The complete set-evidence vocabulary, exported so specs assert against the
 * real list instead of an inline copy. Adding 'name_exact' broke a test that
 * had hardcoded the old four values — the same drift that made one condition
 * re-measurement break three unrelated suites. One source of truth.
 */
export const SET_EVIDENCE_KINDS = Object.freeze([...Object.keys(EVIDENCE_RANK), null]);

/** Evidence strong enough to CONFIRM a set on its own. Substring is not. */
const STRONG = new Set(['code', 'total', 'name_exact']);

/**
 * Pick the upstream card to price, or refuse.
 *
 * Pure and exported so it can be specced against real captured payloads with
 * no network — the project forbids mock.module(), so the seam is the function.
 *
 * @returns {{item:object|null, reason:string, evidence:string|null, considered:number}}
 */
export function chooseTcggoCandidate(candidates, card) {
  const list = Array.isArray(candidates) ? candidates : [];
  const reqNum = normaliseCardNumber(card?.card_number);
  if (!reqNum) return { item: null, reason: 'no_number_read', evidence: null, considered: 0 };

  // The number is a hard gate and always has been. Everything below only
  // decides between printings that already agree on it.
  const sameNumber = list.filter(
    (c) => normaliseCardNumber(c?.card_number) === reqNum,
  );
  if (!sameNumber.length) {
    return { item: null, reason: 'no_number_match', evidence: null, considered: list.length };
  }

  // COLLAPSE DUPLICATES FIRST. The upstream catalogue lists the same Cardmarket
  // product more than once — Dark Tyranitar NDE 11 and Sabrina's Drowzee GC 95
  // each appear twice with identical cardmarket_id, identical price and
  // identical available_items, differing only in an internal id and a cosmetic
  // rarity string ("Rare Holo" vs "Holo Rare").
  //
  // Without this they look like two printings of the same number in the same
  // set, and the ambiguity rule below correctly-but-uselessly refuses to price
  // a card that has exactly one product behind it. Measured: this alone was
  // every remaining refusal in a 60-card sample.
  //
  // COLLAPSE ONLY WHEN THE PAYLOADS AGREE. Sharing an id is NOT sufficient, and
  // assuming it was introduced a worse bug than the one it fixed. Measured
  // 24 Aug 2026 — two upstream rows for Base Set Charizard #4, same
  // cardmarket_id 660224:
  //
  //     base/charizard-4-2   nm=null   avg30=10.46      avail=509
  //     base/charizard-24    nm=2695   avg30=2475.96    avail=39
  //
  // Collapsing on the id alone kept whichever came first and quoted EUR 10.46
  // for a card whose 30-day average is EUR 2,475. Before dedupe that case
  // refused; after, it answered confidently and wrongly, which is strictly
  // worse. Two rows that disagree about the price are not one product seen
  // twice — they are a data conflict we cannot adjudicate, so they stay as
  // separate candidates and the ambiguity rule below refuses.
  const priceSignature = (item) => {
    const cm = item?.prices?.cardmarket ?? {};
    return [cm.lowest_near_mint ?? 'x', cm['30d_average'] ?? 'x', cm.available_items ?? 'x'].join('|');
  };
  const deduped = [];
  const seenProduct = new Map();
  for (const item of sameNumber) {
    const pid = item?.cardmarket_id;
    if (pid != null) {
      const sig = priceSignature(item);
      const prior = seenProduct.get(pid);
      // Same id AND same numbers: genuinely the same product listed twice.
      if (prior === sig) continue;
      // Same id, different numbers: keep both and let the gate refuse.
      if (prior === undefined) seenProduct.set(pid, sig);
    }
    deduped.push(item);
  }

  const scored = deduped
    .map((item) => ({ item, ev: setEvidence(item, card) }))
    .sort((a, b) => (EVIDENCE_RANK[b.ev] ?? 0) - (EVIDENCE_RANK[a.ev] ?? 0));

  const best = scored[0];
  const strong = scored.filter((s) => STRONG.has(s.ev));

  if (strong.length === 1) {
    return { item: strong[0].item, reason: 'set_confirmed', evidence: strong[0].ev, considered: deduped.length };
  }
  if (strong.length > 1) {
    // Two sets claiming the same code or the same printed total AND the same
    // number. Prefer a code match over a total match; if they are the same
    // kind, we genuinely cannot tell and must not guess.
    if (strong[0].ev !== strong[1].ev) {
      return { item: strong[0].item, reason: 'set_confirmed', evidence: strong[0].ev, considered: deduped.length };
    }
    return { item: null, reason: 'set_ambiguous', evidence: null, considered: deduped.length };
  }

  // No strong evidence. One candidate is not a choice — there is nothing to get
  // wrong, so price it and record that the set was never confirmed.
  if (deduped.length === 1) {
    return { item: deduped[0], reason: 'sole_candidate', evidence: best.ev, considered: 1 };
  }

  // Several printings share the number and nothing corroborates the set. This
  // is exactly the Charizard case. Refusing costs a price; guessing costs the
  // difference between EUR 165 and EUR 380.
  return { item: null, reason: 'set_unconfirmed', evidence: null, considered: deduped.length };
}


/**
 * Legacy V1 entrypoint — kept exported for the /api/price route's import
 * shape. V1 server.js:fetchRapidAPICardmarketPrice. Returns the V1 shape
 * with all the fields /api/price expects (lowest_nm, avg7, graded_psa10,
 * etc.).
 */
export async function fetchRapidAPICardmarketPrice(card) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  if (card.game !== 'pokemon') {
    return null;
  }

  try {
    let searchTerm = card.name;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      searchTerm = `${card.name} ${num}`;
    }

    console.log(`[TCGGO] Searching: "${searchTerm}"`);

    // PAGINATE. The page size is locked at 20 upstream (per_page, limit and
    // page_size are all ignored — tested), and a common name runs to many
    // pages: "Pikachu 25" returns 222 results across 12. Reading only page one
    // meant the correct set was frequently not in the candidate list at all,
    // so the gate below could only choose among the wrong printings.
    //
    // Pages are fetched ONLY until the set is confirmed, so a card that matches
    // on page one still costs exactly one request. MAX_PAGES bounds the worst
    // case: this runs per priced card, and an unbounded crawl behind a customer
    // at the counter is its own outage.
    const url = tcggoUrl(card.game);
    if (!url) return null;

    const data = [];
    let choice = { item: null, reason: 'no_candidates', evidence: null, considered: 0 };
    let pagesRead = 0;

    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const resp = await axios.get(url, {
        params: { search: searchTerm, page },
        headers: tcggoHeaders(apiKey),
        timeout: 10000,
      });
      pagesRead = page;
      const batch = resp.data?.data;
      if (!batch || batch.length === 0) break;
      data.push(...batch);

      choice = chooseTcggoCandidate(data, card);
      // A confirmed set is the only reason to stop early. Anything else means
      // the right printing may still be on a later page.
      if (choice.reason === 'set_confirmed') break;

      const total = Number(resp.data?.paging?.total ?? 1);
      if (!Number.isFinite(total) || page >= total) break;
    }

    if (!data.length) {
      countPriceMatch('tcggo', 'no_candidates');
      console.log('[TCGGO] No results');
      return null;
    }
    if (pagesRead > 1) {
      console.log(`[TCGGO] Read ${pagesRead} pages (${data.length} candidates) for "${searchTerm}"`);
    }

    // --- THE MATCH GATE ------------------------------------------------------
    //
    // This block previously read:
    //
    //     let best = data[0];  let bestScore = 0;
    //     for (...) { if (score > bestScore) { bestScore = score; best = item; } }
    //
    // `best` was seeded to the top search hit and returned no matter what it
    // scored. A name-only match — 50 of a possible 140, wrong set, wrong
    // number — was priced as the identified card, and nothing downstream ever
    // compared the priced product's number against the one we asked for.
    //
    // Measured, 14 Aug 2026: a Charizard ex SVP 56 worth about €15 on
    // Cardmarket was quoted at €561.50, because a different Charizard ex headed
    // the five-result search page. The Cardmarket link beside it was correct —
    // it is built from our own identity, not from the matched product — so link
    // and price disagreed by 37x with nothing positioned to notice.
    //
    // The card number is the identifying field. If it does not agree we do not
    // know what we priced, and a price we cannot attribute is a guess. This
    // costs coverage on purpose: an absent price costs nothing, a wrong one on
    // a buy-list costs money. Same reasoning already applied to eBay in
    // pricing/price.js.
    // The number gate, the set gate and the refusals all live in
    // chooseTcggoCandidate — pure, and specced against real captured payloads.
    const reqNum = normaliseCardNumber(card.card_number);
    if (choice.reason === 'no_number_read') {
      countPriceMatch('tcggo', 'rejected_no_number_read');
      console.log(`[TCGGO] REJECTED: no card number was read for "${card.name}" — cannot confirm which printing to price`);
      return null;
    }
    if (choice.reason === 'no_number_match') {
      countPriceMatch('tcggo', 'rejected_no_number_match', { requested: reqNum, candidates: data.length });
      console.log(
        `[TCGGO] REJECTED: no candidate matched #${reqNum} for "${searchTerm}" — ` +
        `${data.length} offered: ${data.map((d) => `${d.name} #${d.card_number}`).join(', ')}`,
      );
      return null;
    }
    if (!choice.item) {
      // set_unconfirmed / set_ambiguous. Several printings share the number and
      // nothing corroborates which set. This is the Charizard case: guessing
      // here is the difference between EUR 165 and EUR 380.
      countPriceMatch('tcggo', 'rejected_set_unconfirmed', {
        requested: reqNum,
        set_code: card.set_code ?? null,
        printed_total: printedTotalOf(card),
        candidates: choice.considered,
      });
      console.log(
        `[TCGGO] REJECTED (${choice.reason}): ${choice.considered} printings share #${reqNum} ` +
        `and none confirms set "${card.set_code || card.set_name || '?'}"`,
      );
      return null;
    }

    const best = choice.item;
    countPriceMatch('tcggo', 'matched');
    if (choice.reason === 'sole_candidate') {
      // Priced, but the set was never confirmed — there was simply nothing to
      // choose between. Counted separately so "matched" never quietly includes
      // unverified matches.
      countPriceMatch('tcggo', 'matched_set_unverified');
    }

    const cm = best.prices?.cardmarket || {};
    const tcg = best.prices?.tcg_player || {};

    const result = {
      source: 'rapidapi_cm',
      name: best.name,
      name_numbered: best.name_numbered,
      set: best.episode?.name || null,
      set_code: best.episode?.code || null,
      card_number: String(best.card_number),
      rarity: best.rarity,
      image: best.image || null,
      tcggo_url: best.tcggo_url || null,
      lowest_nm: cm.lowest_near_mint || null,
      lowest_de: cm.lowest_near_mint_DE || null,
      lowest_fr: cm.lowest_near_mint_FR || null,
      lowest_es: cm.lowest_near_mint_ES || null,
      lowest_it: cm.lowest_near_mint_IT || null,
      avg30: cm['30d_average'] || null,
      avg7: cm['7d_average'] || null,
      // SUPPLY DEPTH. Present in every response and previously discarded.
      // Measured 24 Aug 2026: thin supply is where the lowest asking price runs
      // ABOVE what the card actually sells for — 79 listings gave ask/30d
      // 1.39x, 11,468 listings gave 0.67x. It is also the only velocity signal
      // available to us: snapshot it daily and listings falling while the price
      // holds means the card is moving. Cardmarket publishes no sales count and
      // its own API is closed to new applications.
      available_items: Number.isFinite(cm.available_items) ? cm.available_items : null,
      // EU-only sellers: no customs, no third-country postage. Relevant for an
      // Irish shop and free in the same payload.
      lowest_nm_eu: cm.lowest_near_mint_EU_only || null,
      // Cardmarket's own product id, and the set's printed size — both are on
      // the subscribed listing only, and both are evidence about WHICH product
      // was priced rather than another price.
      cardmarket_id: best.cardmarket_id ?? null,
      set_printed_total: best.episode?.cards_printed_total ?? best.episode?.cards_total ?? null,
      set_evidence: choice.evidence,
      match_reason: choice.reason,
      graded_psa10: cm.graded?.psa?.psa10 || null,
      graded_psa9: cm.graded?.psa?.psa9 || null,
      graded_cgc10: cm.graded?.cgc?.cgc10 || null,
      tcgplayer_market: tcg.market_price || null,
      tcgplayer_mid: tcg.mid_price || null,
      // Evidence for WHICH product this price describes. The displayed
      // Cardmarket link is built from our own identity, so without this there
      // is no way — in a log, in /api/health, or on the result sheet — to see
      // that the price and the link are talking about different cards.
      requested_number: reqNum,
      // How the set was confirmed, not a score. A score could not be read back
      // to mean anything; 'code' / 'total' / 'name' / null says exactly what
      // evidence tied this price to this card.
      match_evidence: choice.evidence,
    };

    result.price = result.lowest_nm || result.avg7 || result.avg30;

    if (result.price) {
      console.log(`[TCGGO] Found: ${result.name} (${result.set} #${result.card_number}) = ${result.price}€ NM (30d avg: ${result.avg30 || '?'}€, DE: ${result.lowest_de || '?'}€)`);
    } else {
      console.log(`[TCGGO] Card found but no Cardmarket price: ${result.name}`);
    }

    return result;
  } catch (err) {
    // A BUG IS NOT A MISSING PRICE.
    //
    // This block used to return null for absolutely everything, so a
    // ReferenceError in the matching code looked exactly like "upstream has no
    // data for this card" — a silent, permanent, catalogue-wide price outage
    // that no counter and no log line would distinguish from normal absence.
    //
    // That is not hypothetical: rewriting the gate on 24 Aug 2026 left two
    // orphaned variables behind, and both surfaced as a quiet null rather than
    // a crash. The existing spec caught them only because it asserted on the
    // returned value.
    //
    // Upstream failures are expected and stay soft. Our own errors are loud and
    // counted, because they are the ones nobody is looking for.
    const status = err.response?.status;
    if (status === 429) {
      console.log('[TCGGO] Rate limited — skipping');
    } else if (status === 403) {
      console.log('[TCGGO] Not subscribed — check the plan for ' + TCGGO_HOST);
    } else if (status === 401) {
      console.log('[TCGGO] Auth error — check RAPIDAPI_KEY');
    } else if (status || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.name === 'AbortError') {
      console.log(`[TCGGO] Upstream error: ${status || err.code || ''} ${err.message}`);
    } else {
      // No HTTP status and not a timeout: this came from our own code.
      countPriceMatch('tcggo', 'adapter_error', { error: err.name, message: err.message });
      console.error(`[TCGGO] ADAPTER BUG — ${err.name}: ${err.message}`, err.stack);
    }
    return null;
  }
}

/**
 * Verify-shape lookup used by /api/identify-manual when pokemontcg.io has
 * no result and a fallback chain kicks in. V1 server.js:lookupViaTCGGO.
 *
 * @param {string} setId      pokemontcg.io set-id (lowercase).
 * @param {string} cardNumber Raw card number.
 * @param {string} rawSetCode Original printed code (case preserved).
 */
export async function lookupViaTCGGO(setId, cardNumber, rawSetCode) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const paddedNum = cleanNum.padStart(3, '0');

  const searchTerms = [];
  if (rawSetCode) searchTerms.push(`${rawSetCode} ${paddedNum}`);
  if (setName) searchTerms.push(`${setName} ${cleanNum}`);
  if (setName) searchTerms.push(`${setName} ${paddedNum}`);
  if (rawSetCode) searchTerms.push(`${rawSetCode} promo ${cleanNum}`);

  if (!searchTerms.length) {
    console.log(`[TCGGO-FALLBACK] No search terms for "${setId}" — skipping`);
    return null;
  }

  for (const searchTerm of searchTerms) {
    console.log(`[TCGGO-FALLBACK] Searching: "${searchTerm}"`);
    try {
      // Same subscribed host as the price path. This was still pointing at the
      // free listing, so the identify fallback would have kept consuming the
      // 100/day quota and 403-ing once it ran out, independently of the plan.
      const resp = await axios.get(tcggoUrl('pokemon'), {
        params: { search: searchTerm },
        headers: tcggoHeaders(apiKey),
        timeout: 10000,
      });

      const data = resp.data?.data;
      if (!data || data.length === 0) continue;

      let best = null;
      let bestScore = 0;
      for (const item of data) {
        const itemNum = String(item.card_number || '');
        if (itemNum !== cleanNum && itemNum !== paddedNum && itemNum !== cardNumber) continue;

        let score = 60;
        const epName = (item.episode?.name || '').toLowerCase();
        const epCode = (item.episode?.code || '').toUpperCase();
        if (setName && epName.includes(setName.toLowerCase())) score += 40;
        if (rawSetCode && epCode === rawSetCode.toUpperCase()) score += 50;
        if (setId.endsWith('p') || setId === 'mep') {
          if (epName.includes('promo')) score += 20;
        }
        if (score > bestScore) { bestScore = score; best = item; }
      }

      if (best) {
        console.log(`[TCGGO-FALLBACK] Found: ${best.name} (${best.episode?.name || '?'} #${best.card_number}) [score ${bestScore}]`);
        return {
          game: 'pokemon',
          name: best.name,
          set_name: best.episode?.name || setName || rawSetCode,
          set_code: (best.episode?.code || rawSetCode || setId).toUpperCase(),
          card_number: String(best.card_number || cleanNum),
          rarity: best.rarity || null,
          reference_image: best.image || null,
          verified: true,
          db_source: 'tcggo.com (fallback)',
          _manual: true,
        };
      }
    } catch (e) {
      if (e.response?.status === 429) {
        console.log('[TCGGO-FALLBACK] Rate limited — stopping');
        return null;
      }
      console.log(`[TCGGO-FALLBACK] Error: ${e.response?.status || e.message}`);
    }
  }

  console.log(`[TCGGO-FALLBACK] No match after all search strategies for ${rawSetCode || setId} #${cleanNum}`);
  return null;
}

/**
 * Default-export adapter — V2 fan-out. Pokemon-only. Highest-trust EUR
 * source. Confidence 0.85 base, +0.05 if avg7 > 0 (active liquidity).
 * Cache-age penalty (−0.20 if >24h old) is engine-level, not adapter-level
 * — adapters don't have visibility into cache age, only ctx.cache.
 */
export default {
  name: NAME,
  supports: {
    games: ['pokemon'],
    needs: ['name'],
  },
  isAvailable() {
    return !!process.env.RAPIDAPI_KEY;
  },
  async price(card /*, ctx */) {
    const raw = await fetchRapidAPICardmarketPrice(card);
    if (!raw || raw.price == null) return null;
    let confidence = 0.85;
    if (raw.avg7 && raw.avg7 > 0) confidence += 0.05;

    const graded = [];
    if (raw.graded_psa10) graded.push({ company: 'PSA', grade: 10, price_eur: raw.graded_psa10 });
    if (raw.graded_psa9) graded.push({ company: 'PSA', grade: 9, price_eur: raw.graded_psa9 });
    if (raw.graded_cgc10) graded.push({ company: 'CGC', grade: 10, price_eur: raw.graded_cgc10 });

    return {
      source: NAME,
      market_value_eur: raw.price,
      raw_currency: 'EUR',
      raw_value: raw.price,
      confidence: Math.max(0, Math.min(1, confidence)),
      fetched_at: new Date().toISOString(),
      avg7: raw.avg7 ?? null,
      avg30: raw.avg30 ?? null,
      graded: graded.length ? graded : undefined,
      product_url: raw.tcggo_url ?? null,
    };
  },
};
