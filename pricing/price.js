// pricing/price.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md §2 (lifecycle), §4 (static priority)
//   - V1 server.js:/api/price (4717-5046)
//   - pricing/conditions.js (CONDITION_MULTIPLIERS, applyCondition)
//
// /api/price fan-out + selection + hotness logic. Two consumers:
//   1. apps/server/routes/price.js (V1 path) — calls priceCard() or
//      individual fetchers (legacy shape preserved on /api/price).
//   2. /api/v2/price (S10/S17) — uses the priceQuotes return for the
//      v2.sources array.
//
// Composite price-cache key: game|name|set|num|cond|variant|graded|buy% —
// V2_AUDIT § priceCache. 60-min TTL, LRU 500. Lives here so /api/price
// can reach it without importing _legacy-pricing.

import { fetchCardmarketPrice, buildCardmarketUrl, getGameSlug } from './adapters/cardmarket-html.js';
import { fetchJustTCGPrice } from './adapters/justtcg.js';
import { fetchRapidAPICardmarketPrice } from './adapters/tcggo-rapidapi.js';
import { priceEbaySold } from './adapters/ebay-sold.js';
import { priceMagicCard } from './adapters/scryfall.js';
import { pricePokemonCard } from './adapters/pokemontcg.js';
import { CONDITION_MULTIPLIERS } from './conditions.js';
import { getUsdToEur } from './fx.js';

// =============================================================================
// PRICE CACHE — V1 server.js:4682-4715
// =============================================================================
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_CACHE_MAX = 500;
const priceCache = new Map();

export function priceCacheKey(card, buyPercentage) {
  return [
    card.game || '',
    (card.name || '').toLowerCase(),
    (card.set_code || '').toUpperCase(),
    (card.card_number || '').toString(),
    card.condition_estimate || 'NM',
    card.variant || 'normal',
    card.graded ? `${card.graded.company}-${card.graded.grade}` : '',
    String(buyPercentage),
  ].join('|');
}

export function priceCacheGet(key) {
  const hit = priceCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PRICE_CACHE_TTL_MS) {
    priceCache.delete(key);
    return null;
  }
  // LRU touch
  priceCache.delete(key);
  priceCache.set(key, hit);
  return hit.data;
}

export function priceCacheSet(key, data) {
  if (priceCache.size >= PRICE_CACHE_MAX) {
    const first = priceCache.keys().next().value;
    priceCache.delete(first);
  }
  priceCache.set(key, { ts: Date.now(), data });
}

// Re-export per-source helpers so route handlers + the v2 envelope share
// one import path. Legacy /api/price route imports the V1-shape helpers
// directly; /api/v2/price assembles via priceCard().
export {
  fetchCardmarketPrice,
  buildCardmarketUrl,
  getGameSlug,
  fetchJustTCGPrice,
  fetchRapidAPICardmarketPrice,
  priceEbaySold,
  priceMagicCard,
  pricePokemonCard,
  getUsdToEur,
  CONDITION_MULTIPLIERS,
};

/**
 * priceCard — V2 fan-out + source selection. Wraps the legacy fetchers and
 * returns the V1 shape that /api/price expects, plus a v2.sources array
 * that /api/v2/price can lift verbatim.
 *
 * Pure orchestration — no caching here (the /api/price route handler caches
 * via priceCacheKey/Get/Set above).
 *
 * @param {object} verifiedCard  Verify-shape card (verified=true).
 * @param {object} [opts]
 * @param {number} [opts.buyPercentage=0.6]
 */
export async function priceCard(verifiedCard, opts = {}) {
  const card = verifiedCard;
  const buyPercentage = opts.buyPercentage ?? 0.6;
  const conditionMult = CONDITION_MULTIPLIERS[card.condition_estimate] ?? 1.0;

  const cmLinks = buildCardmarketUrl(card);

  const pricingPromises = [];

  if (cmLinks.product_url) {
    pricingPromises.push(
      fetchCardmarketPrice(cmLinks.product_url, card.condition_estimate || 'NM')
        .then(r => ({ type: 'cardmarket_live', data: r }))
    );
  }

  if (card.game === 'magic') {
    pricingPromises.push(priceMagicCard(card).then(r => ({ type: 'game_api', data: r })));
  } else if (card.game === 'pokemon') {
    pricingPromises.push(pricePokemonCard(card).then(r => ({ type: 'game_api', data: r })));
  }

  if (process.env.JUSTTCG_API_KEY) {
    pricingPromises.push(
      fetchJustTCGPrice(card).then(r => ({ type: 'justtcg', data: r }))
    );
  }

  if (process.env.RAPIDAPI_KEY) {
    pricingPromises.push(
      fetchRapidAPICardmarketPrice(card).then(r => ({ type: 'rapidapi_cm', data: r }))
    );
  }

  pricingPromises.push(
    priceEbaySold(card).then(r => ({ type: 'ebay', data: r }))
  );

  const results = await Promise.all(pricingPromises);

  let pricing = {
    card,
    cardmarket: {
      url: cmLinks.search_url,
      filtered_url: cmLinks.filtered_search_url,
      search_url: cmLinks.search_url,
      source: 'cardmarket_link',
      note: 'Tap to check live Cardmarket prices',
    },
    ebay: null,
    tcgplayer: null,
    reference_image: null,
    buy_price: null,
    condition_multiplier: conditionMult,
    buy_percentage: buyPercentage,
  };

  // Merge logic preserved verbatim from V1 /api/price.
  for (const result of results) {
    if (result.type === 'game_api' && result.data) {
      if (result.data.tcgplayer) {
        pricing.tcgplayer = result.data.tcgplayer;
      }
      if (result.data.scryfall?.image || result.data.pokemontcg?.image) {
        pricing.reference_image = result.data.scryfall?.image || result.data.pokemontcg?.image;
      }
      if (result.data.scryfall) pricing.verified_card = result.data.scryfall;
      if (result.data.pokemontcg) pricing.verified_card = result.data.pokemontcg;

      if (result.data.cardmarket_price) {
        pricing.cardmarket.price = result.data.cardmarket_price;
        pricing.cardmarket.trend = result.data.cardmarket_trend || null;
        pricing.cardmarket.source = result.data.cardmarket_source || 'api';
        pricing.cardmarket.note = `Lowest via API · ${result.data.cardmarket_trend ? 'Trend: ' + result.data.cardmarket_trend.toFixed(2) + '€' : ''}`;
      }

      if (result.data.cardmarket_product_url && result.data.cardmarket_product_url.includes('cardmarket.com')) {
        pricing.cardmarket.url = result.data.cardmarket_product_url;
        pricing.cardmarket.filtered_url = result.data.cardmarket_product_url;
        console.log(`[CM-URL] Using Cardmarket URL from API: ${result.data.cardmarket_product_url}`);
      }
    }

    if (result.type === 'ebay' && result.data) {
      pricing.ebay = result.data;
    }

    if (result.type === 'cardmarket_live' && result.data) {
      console.log(`[CM-LIVE] Got live Cardmarket data:`, JSON.stringify(result.data));
      pricing.cardmarket.price = result.data.low || result.data.trend || pricing.cardmarket.price;
      pricing.cardmarket.trend = result.data.trend || pricing.cardmarket.trend;
      pricing.cardmarket.low = result.data.low || null;
      pricing.cardmarket.avg30 = result.data.avg30 || null;
      pricing.cardmarket.source = 'cardmarket_live';
      pricing.cardmarket.verified = true;
      pricing.cardmarket.note = `Live price from Cardmarket${result.data.trend ? ' · Trend: ' + result.data.trend.toFixed(2) + '€' : ''}`;
      if (result.data.offers && result.data.offers.length > 0) {
        pricing.cardmarket.offers = result.data.offers.slice(0, 5);
      }
    }

    if (result.type === 'justtcg' && result.data) {
      const jt = result.data;
      if (jt.price_usd) {
        console.log(`[PRICE] JustTCG: $${jt.price_usd} USD / ~${jt.price_eur}€ [${jt.condition_full}, ${jt.printing}]`);
      }
      pricing.justtcg = {
        price_usd: jt.price_usd,
        price_eur: jt.price_eur,
        condition: jt.condition,
        condition_full: jt.condition_full,
        printing: jt.printing,
        name: jt.name,
        set: jt.set,
        card_number: jt.card_number,
        source: 'justtcg',
        currency: 'USD',
        avg_30d: jt.avg_30d,
        price_change_30d: jt.price_change_30d,
        last_updated: jt.last_updated,
      };
      if (!pricing.tcgplayer && jt.price_usd) {
        pricing.tcgplayer = {
          price: jt.price_usd,
          source: 'justtcg',
          condition: jt.condition_full,
          printing: jt.printing,
          verified: true,
        };
      }
    }

    if (result.type === 'rapidapi_cm' && result.data?.price) {
      const rd = result.data;
      console.log(`[PRICE] TCGGO: ${rd.price}€ NM (avg30: ${rd.avg30 || '?'}€, DE: ${rd.lowest_de || '?'}€)`);
      if (pricing.cardmarket.source !== 'cardmarket_live') {
        pricing.cardmarket.price = rd.price;
        pricing.cardmarket.avg30 = rd.avg30 || pricing.cardmarket.avg30;
        pricing.cardmarket.avg7 = rd.avg7 || null;
        pricing.cardmarket.source = 'rapidapi_cm';
        pricing.cardmarket.verified = true;
        pricing.cardmarket.note = `Live NM from TCGGO${rd.avg30 ? ' · 30d avg: ' + rd.avg30.toFixed(2) + '€' : ''}`;
      }
      pricing.rapidapi_cm = {
        price: rd.price,
        lowest_nm: rd.lowest_nm,
        avg7: rd.avg7,
        avg30: rd.avg30,
        lowest_de: rd.lowest_de,
        lowest_fr: rd.lowest_fr,
        lowest_es: rd.lowest_es,
        lowest_it: rd.lowest_it,
        graded_psa10: rd.graded_psa10,
        graded_psa9: rd.graded_psa9,
        tcgplayer_market: rd.tcgplayer_market,
        image: rd.image,
        source: 'rapidapi_cm',
      };
      if (!pricing.reference_image && rd.image) {
        pricing.reference_image = rd.image;
      }
    }
  }

  // Final selection — V1 /api/price priority order verbatim.
  let bestPrice = null;
  let priceSource = '';
  let priceCurrency = 'EUR';
  let isGraded = false;

  if (card.graded && card.graded.company && card.graded.grade) {
    isGraded = true;
    const company = String(card.graded.company).toUpperCase();
    const grade = Number(card.graded.grade);
    const r = pricing.rapidapi_cm || {};
    let gp = null, gLabel = '';
    if (company === 'PSA' && grade === 10 && r.graded_psa10) { gp = r.graded_psa10; gLabel = 'PSA 10'; }
    else if (company === 'PSA' && grade === 9 && r.graded_psa9) { gp = r.graded_psa9; gLabel = 'PSA 9'; }
    else if ((company === 'CGC' || company === 'BGS') && grade >= 9.5 && r.graded_cgc10) { gp = r.graded_cgc10; gLabel = `${company} ${grade}`; }
    else if (grade >= 9.5 && r.graded_psa10) { gp = r.graded_psa10; gLabel = `${company} ${grade} (using PSA 10 comp)`; }
    else if (grade >= 8.5 && r.graded_psa9) { gp = r.graded_psa9; gLabel = `${company} ${grade} (using PSA 9 comp)`; }

    if (gp) {
      bestPrice = gp;
      priceSource = `Graded ${gLabel} · TCGGO`;
    }
  }

  if (!bestPrice && pricing.cardmarket?.price) {
    bestPrice = pricing.cardmarket.price;
    const sourceLabels = {
      rapidapi_cm: 'RapidAPI CM (live)',
      cardmarket_live: 'Cardmarket (live)',
      api: 'Cardmarket (API)',
    };
    priceSource = sourceLabels[pricing.cardmarket.source] || 'Cardmarket';
  }
  if (!bestPrice && pricing.justtcg?.price_eur) {
    bestPrice = pricing.justtcg.price_eur;
    priceSource = `JustTCG $${pricing.justtcg.price_usd.toFixed(2)} → €${bestPrice.toFixed(2)} (${pricing.justtcg.condition_full})`;
  }
  if (!bestPrice && pricing.tcgplayer?.price) {
    bestPrice = Math.round(pricing.tcgplayer.price * getUsdToEur() * 100) / 100;
    const src = pricing.tcgplayer.source === 'justtcg' ? 'JustTCG' : 'TCGPlayer';
    priceSource = `${src} $${pricing.tcgplayer.price.toFixed(2)} → €${bestPrice.toFixed(2)}`;
  }
  if (!bestPrice && pricing.ebay?.median_price) {
    bestPrice = pricing.ebay.median_price;
    priceCurrency = pricing.ebay.currency || 'EUR';
    priceSource = `eBay sold median`;
  }

  if (bestPrice) {
    const effectiveMult = isGraded ? 1.0 : conditionMult;
    const adjustedPrice = bestPrice * effectiveMult;
    const condLabel = isGraded
      ? `${card.graded.company} ${card.graded.grade}`
      : (card.condition_estimate || 'NM');
    pricing.buy_price = {
      suggested: Math.round(adjustedPrice * buyPercentage * 100) / 100,
      market_value: bestPrice,
      condition_adjusted: Math.round(adjustedPrice * 100) / 100,
      currency: priceCurrency,
      formula: `${bestPrice.toFixed(2)}€ × ${effectiveMult} (${condLabel}) × ${(buyPercentage * 100).toFixed(0)}% = ${(Math.round(adjustedPrice * buyPercentage * 100) / 100).toFixed(2)}€`,
      price_source: priceSource,
      graded: isGraded ? card.graded : null,
    };
  }

  pricing.hotness = scoreHotness(pricing, card, bestPrice);
  console.log(`[HOTNESS] ${card.name}: ${pricing.hotness.score}/100 (${pricing.hotness.label}) — ${pricing.hotness.reasons.join('; ') || 'default'}`);

  return pricing;
}

/**
 * scoreHotness — V1 server.js:/api/price tail (4990-5040). Computes a 0..100
 * hotness score from price-trend + eBay volume + bestPrice. Pure function so
 * tests can pin score ranges without faking a full price fan-out.
 */
export function scoreHotness(pricing, card, bestPrice) {
  const hotness = { score: 50, label: 'steady', trend: null, volume: null, reasons: [] };

  const rcm = pricing.rapidapi_cm || {};
  if (rcm.avg7 && rcm.avg30 && rcm.avg30 > 0) {
    const trendPct = ((rcm.avg7 - rcm.avg30) / rcm.avg30) * 100;
    hotness.trend = Math.round(trendPct * 10) / 10;
    if (trendPct >= 15)       { hotness.score += 30; hotness.reasons.push(`Price up ${hotness.trend}% (7d vs 30d)`); }
    else if (trendPct >= 5)   { hotness.score += 15; hotness.reasons.push(`Price up ${hotness.trend}%`); }
    else if (trendPct >= 0)   { hotness.score += 5;  hotness.reasons.push(`Price stable (+${hotness.trend}%)`); }
    else if (trendPct >= -5)  { hotness.score -= 5;  hotness.reasons.push(`Price dipping ${hotness.trend}%`); }
    else                      { hotness.score -= 15; hotness.reasons.push(`Price falling ${hotness.trend}%`); }
  }
  else if (pricing.justtcg?.price_change_30d) {
    const chg = pricing.justtcg.price_change_30d;
    hotness.trend = Math.round(chg * 10) / 10;
    if (chg >= 10)      { hotness.score += 20; hotness.reasons.push(`Price up ${hotness.trend}% (30d)`); }
    else if (chg >= 0)  { hotness.score += 5; }
    else                { hotness.score -= 10; hotness.reasons.push(`Price down ${hotness.trend}% (30d)`); }
  }

  const ebayCount = pricing.ebay?.sample_size || 0;
  hotness.volume = ebayCount;
  if (ebayCount >= 12)      { hotness.score += 20; hotness.reasons.push(`${ebayCount} recent eBay sales`); }
  else if (ebayCount >= 6)  { hotness.score += 10; hotness.reasons.push(`${ebayCount} eBay sales`); }
  else if (ebayCount >= 3)  { hotness.score += 5; }
  else if (ebayCount === 0) { hotness.score -= 10; hotness.reasons.push('No recent eBay sales'); }

  if (bestPrice && bestPrice >= 10 && hotness.trend && hotness.trend > 0) {
    hotness.score += 10;
    hotness.reasons.push(`High-value card (${bestPrice.toFixed(2)}€)`);
  } else if (bestPrice && bestPrice < 1) {
    hotness.score -= 10;
  }

  hotness.score = Math.max(0, Math.min(100, hotness.score));
  if (hotness.score >= 75)      hotness.label = 'hot';
  else if (hotness.score >= 60) hotness.label = 'warm';
  else if (hotness.score >= 40) hotness.label = 'steady';
  else                          hotness.label = 'slow';

  return hotness;
}
