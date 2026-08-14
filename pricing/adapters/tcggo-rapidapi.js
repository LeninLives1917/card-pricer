// pricing/adapters/tcggo-rapidapi.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md §5 (confidence 0.85 base + 0.05 active liquidity)
//   - V1 server.js: fetchRapidAPICardmarketPrice + lookupViaTCGGO
//
// TCGGO is the highest-trust EUR source. Has graded comps for Pokemon
// (PSA10, PSA9, CGC10). Pokemon-only — the upstream is named
// pokemon-tcg-api.p.rapidapi.com.

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

    const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
      params: { search: searchTerm, per_page: SEARCH_PAGE_SIZE },
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      countPriceMatch('tcggo', 'no_candidates');
      console.log('[TCGGO] No results');
      return null;
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
    const reqNum = normaliseCardNumber(card.card_number);
    if (!reqNum) {
      countPriceMatch('tcggo', 'rejected_no_number_read');
      console.log(`[TCGGO] REJECTED: no card number was read for "${card.name}" — cannot confirm which printing to price`);
      return null;
    }

    let best = null;
    let bestScore = 0;
    for (const item of data) {
      // The number must agree before anything else is considered. Name and set
      // only ever break ties among printings that already share the number.
      if (normaliseCardNumber(item.card_number) !== reqNum) continue;
      let score = 60;
      if (item.name?.toLowerCase().includes(card.name.toLowerCase())) score += 50;
      if (card.set_name && item.episode?.name?.toLowerCase().includes(card.set_name.toLowerCase())) score += 30;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    if (!best) {
      countPriceMatch('tcggo', 'rejected_no_number_match', { requested: reqNum, candidates: data.length });
      console.log(
        `[TCGGO] REJECTED: no candidate matched #${reqNum} for "${searchTerm}" — ` +
        `${data.length} offered: ${data.map((d) => `${d.name} #${d.card_number}`).join(', ')}`,
      );
      return null;
    }
    countPriceMatch('tcggo', 'matched');

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
      match_score: bestScore,
    };

    result.price = result.lowest_nm || result.avg7 || result.avg30;

    if (result.price) {
      console.log(`[TCGGO] Found: ${result.name} (${result.set} #${result.card_number}) = ${result.price}€ NM (30d avg: ${result.avg30 || '?'}€, DE: ${result.lowest_de || '?'}€)`);
    } else {
      console.log(`[TCGGO] Card found but no Cardmarket price: ${result.name}`);
    }

    return result;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[TCGGO] Rate limited — skipping');
    } else if (err.response?.status === 403) {
      console.log('[TCGGO] Not subscribed — subscribe at https://rapidapi.com/tcggopro/api/pokemon-tcg-api');
    } else if (err.response?.status === 401) {
      console.log('[TCGGO] Auth error — check RAPIDAPI_KEY');
    } else {
      console.log(`[TCGGO] Error: ${err.response?.status || ''} ${err.message}`);
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
      const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
        params: { search: searchTerm, per_page: 10 },
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
          'Accept': 'application/json',
        },
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
