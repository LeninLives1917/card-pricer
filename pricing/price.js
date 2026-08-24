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

import { fetchCardmarketPrice, buildCardmarketUrl, getGameSlug, resolveCardmarketProductUrl } from './adapters/cardmarket-html.js';
import { fetchJustTCGPrice } from './adapters/justtcg.js';
import { fetchRapidAPICardmarketPrice } from './adapters/tcggo-rapidapi.js';
import { priceEbaySold } from './adapters/ebay-sold.js';
import { priceMagicCard } from './adapters/scryfall.js';
import { verifyMagic } from './adapters/scryfall.js';
import { pricePokemonCard, fetchPokemonImageByCdnLookup } from './adapters/pokemontcg.js';
import { verifyLorcana } from './adapters/lorcana.js';
import { verifyYuGiOh } from './adapters/ygoprodeck.js';
import { verifySWU } from './adapters/swu-db.js';
import { CONDITION_MULTIPLIERS } from './conditions.js';
import { getUsdToEur } from './fx.js';
import { resolveSetCode } from './set-aliases.js';
import { lookupLocalDb, cacheCardResult } from '../apps/server/_card-db-boot.js';

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

// Exported for regression tests only — not part of the public API.
export { PRICE_CACHE_TTL_MS };
export function _testGetEntryTs(key) {
  return priceCache.get(key)?.ts ?? null;
}
export function _testSetEntryTs(key, ts) {
  const entry = priceCache.get(key);
  if (entry) priceCache.set(key, { ...entry, ts });
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
 * resolveImageFallback — server-side image cascade for /api/price responses
 * where the upstream price source returned no image URL.
 *
 * Cascade order:
 *   1. CARD_DB in-memory lookup (zero cost)
 *   2. Game-specific CDN lookup
 *   3. null — client handles gracefully
 *
 * On a CDN hit after a CARD_DB miss, writes through to CARD_DB so the next
 * identical request hits the in-memory path. Fire-and-forget; errors are swallowed.
 *
 * @param {object} card  Partial card object with game / set_code / card_number.
 * @returns {Promise<string|null>}
 */
export async function resolveImageFallback(card, deps = {}) {
  const {
    lookupLocalDb: _lookupLocalDb = lookupLocalDb,
    cacheCardResult: _cacheCardResult = cacheCardResult,
    fetchPokemonImageByCdnLookup: _fetchPokemonImageByCdnLookup = fetchPokemonImageByCdnLookup,
    verifyMagic: _verifyMagic = verifyMagic,
    verifyLorcana: _verifyLorcana = verifyLorcana,
    verifyYuGiOh: _verifyYuGiOh = verifyYuGiOh,
    verifySWU: _verifySWU = verifySWU,
    resolveSetCode: _resolveSetCode = resolveSetCode,
  } = deps;

  const resolved = _resolveSetCode(card.set_code);
  const setId = resolved?.setId;
  if (!setId || !card.card_number) return null;

  // 1. CARD_DB — in-memory, zero cost
  const local = _lookupLocalDb(setId, card.card_number);
  if (local?.reference_image) return local.reference_image;

  // 2. Game-specific CDN
  let image = null;
  try {
    if (card.game === 'pokemon') {
      image = await _fetchPokemonImageByCdnLookup(setId, card.card_number);
    } else if (card.game === 'magic') {
      image = (await _verifyMagic(card))?.image || null;
    } else if (card.game === 'lorcana') {
      image = (await _verifyLorcana(card))?.image || null;
    } else if (card.game === 'yugioh') {
      image = (await _verifyYuGiOh(card))?.image || null;
    } else if (card.game === 'swu') {
      image = (await _verifySWU(card))?.image || null;
    }
  } catch (err) {
    console.warn('[image-fallback] CDN lookup failed:', err.message);
    return null;
  }

  // 3. Write-through to CARD_DB on CDN hit (fire-and-forget)
  if (image) {
    try {
      _cacheCardResult(setId, card.card_number, {
        name: card.name || '',
        set_name: card.set_name || '',
        set_code: card.set_code || setId.toUpperCase(),
        rarity: card.rarity || '',
        hp: card.hp || '',
        reference_image: image,
        cardmarket_url: card.cardmarket_url || null,
        tcgplayer_url: card.tcgplayer_url || null,
      });
    } catch { /* swallow — write-through is best-effort */ }
  }

  return image;
}

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

  // Resolve the Cardmarket PRODUCT page before building the links.
  //
  // The URL cannot be constructed from our data. Cardmarket uses its own set
  // slugs, its own abbreviations, zero-padding that varies by set, and a
  // -V1/-V2 version suffix internal to them:
  //
  //   Obsidian-Flames/Smoliv-OBF019    padded to three
  //   Vivid-Voltage/Shiftry-VIV12      not padded
  //   EX-Legend-Maker/Muk-LM11         their slug, their code
  //
  // A generator would emit plausible URLs that 404, which is worse than a
  // search link because it looks right. So it is looked up once per card and
  // cached, with a retry — the redirect service 502s often enough that two
  // runs over the same 100 cards resolved 75 and then 64.
  //
  // Measured over 100 random catalogue cards WITH the retry: 88 reach the
  // product page, 12 have no Cardmarket mapping and fall back to a filtered
  // search. Every card ends up with a working English + condition link.
  //
  // Never allowed to fail a price: a link is a convenience.
  try {
    await resolveCardmarketProductUrl(card);
  } catch { /* the search fallback is always available */ }

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
      // Already filtered to ENGLISH (language=1) and this card's condition.
      //
      // The operator asked for the cheapest English Near Mint. Cardmarket
      // will not let us READ it — Cloudflare answers any server-side fetch
      // with a 403 "Just a moment" interstitial, verified with a browser
      // user-agent — and the TCGGO API has no English field at all, only
      // _DE/_FR/_ES/_IT. But nothing stops us handing over the exact page
      // with the filters already applied.
      url: cmLinks.best_url,
      url_kind: cmLinks.best_url_kind,
      product_url: cmLinks.product_url_filtered,
      filtered_url: cmLinks.filtered_search_url,
      search_url: cmLinks.search_url,
      source: 'cardmarket_link',
      note: cmLinks.best_url_kind === 'product'
        ? 'Cardmarket — English, this condition'
        : 'Cardmarket search — English, this condition',
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
  // eBay is deliberately NOT a price source.
  //
  // pricing/adapters/ebay-sold.js queries the Browse API, which has no sold
  // filter. It requests ACTIVE listings sorted by price ASCENDING with limit 15,
  // then reports the median of those — i.e. roughly the 7th-cheapest asking
  // price on the marketplace — and labels it "sold median". It is structurally
  // guaranteed to lowball. Measured: it returned €2.28 for a card with a true
  // market of €168–210, because the bare-name query in its cascade matched
  // Pokémon TCG Online code cards and digital listings.
  //
  // A wrong price on a buy-list costs real money; an absent one costs nothing,
  // since Cardmarket, JustTCG and TCGPlayer are real market data and are tried
  // above. `pricing.ebay` is still populated for display/links, but it must not
  // reach bestPrice. Restore only via eBay's Marketplace Insights API, which is
  // the actual sold-comps endpoint and requires an application.

  // --- cross-source divergence guard ---------------------------------------
  // The cascade above is first-match-wins, so one bad adapter sets the price
  // unopposed. Compare the sources against each other before quoting.
  const divergence = detectPriceDivergence(pricing);
  if (divergence.diverged) {
    pricing.price_warning = {
      type: 'source_divergence',
      ratio: Math.round(divergence.ratio * 10) / 10,
      median_eur: divergence.median,
      outliers: divergence.outliers,
      prices: divergence.prices.map(p => ({
        source: p.source, eur: Math.round(p.eur * 100) / 100,
      })),
    };

    // Only re-select when a majority identifies the outlier. With two sources
    // the quote is flagged and left alone — picking one would be a coin flip.
    if (divergence.adjudicable && !isGraded) {
      const chosen = divergence.prices.find(p => Math.abs(p.eur - bestPrice) < 0.01);
      if (chosen && divergence.outliers.includes(chosen.source)) {
        const replacement = divergence.prices
          .filter(p => !divergence.outliers.includes(p.source))
          .sort((a, b) => Math.abs(a.eur - divergence.median) - Math.abs(b.eur - divergence.median))[0];
        if (replacement) {
          console.warn(
            `[PRICE] ${chosen.source} (€${chosen.eur.toFixed(2)}) is ${divergence.ratio.toFixed(1)}x ` +
            `from the median of ${divergence.prices.length} sources — repricing from ${replacement.source}`,
          );
          bestPrice = Math.round(replacement.eur * 100) / 100;
          priceCurrency = 'EUR';
          priceSource = `${replacement.source} (${chosen.source} rejected as outlier)`;
          pricing.price_warning.repriced_from = chosen.source;
          pricing.price_warning.repriced_to = replacement.source;
        }
      }
    }
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

  if (!pricing.reference_image) {
    pricing.reference_image = await resolveImageFallback(card);
  }

  return pricing;
}

/**
 * scoreHotness — V1 server.js:/api/price tail (4990-5040). Computes a 0..100
 * hotness score from price-trend + eBay volume + bestPrice. Pure function so
 * tests can pin score ranges without faking a full price fan-out.
 */
/**
 * Every independently-sourced price in `pricing`, normalised to EUR.
 *
 * Used by detectPriceDivergence. eBay is included here ON PURPOSE even though
 * it is excluded from price selection — it is precisely the kind of source
 * whose disagreement is worth surfacing, and the €2.28-vs-€180 incident is what
 * motivated this check.
 *
 * @returns {Array<{ source: string, eur: number }>}
 */
export function comparableEurPrices(pricing = {}) {
  const out = [];
  const push = (source, eur) => {
    if (Number.isFinite(eur) && eur > 0) out.push({ source, eur });
  };

  push('cardmarket', pricing.cardmarket?.price);
  push('justtcg', pricing.justtcg?.price_eur);
  if (Number.isFinite(pricing.tcgplayer?.price)) {
    push('tcgplayer', pricing.tcgplayer.price * getUsdToEur());
  }
  if (pricing.ebay?.median_price != null) {
    const cur = pricing.ebay.currency || 'EUR';
    const raw = Number(pricing.ebay.median_price);
    push('ebay', cur === 'EUR' ? raw : raw * getUsdToEur());
  }
  return out;
}

/**
 * Flag quotes where independent sources disagree wildly.
 *
 * The cascade above is first-match-wins, so a single bad adapter can set the
 * price with nothing to contradict it. That is how eBay quoted €2.28 against a
 * €168–210 market for months: every number needed to notice was already in
 * `pricing`, and nothing compared them.
 *
 * Adjudication depends on how many sources exist, and the distinction matters:
 *
 *   >= 3 sources — take the median and mark anything a factor away from it as
 *                  an outlier. With a majority present, the outlier is
 *                  identifiable and the caller can safely refuse to price from
 *                  it.
 *   == 2 sources — flag the disagreement but name NO outlier. With two numbers
 *                  and no tie-breaker there is no way to tell which is wrong,
 *                  and guessing would just be the original bug with extra
 *                  steps. Surface it and let a human decide.
 *
 * @param {object} pricing
 * @param {{ factor?: number }} [opts] factor — ratio treated as divergence.
 * @returns {{ diverged: boolean, ratio: number|null, median: number|null,
 *             prices: Array<{source:string,eur:number}>, outliers: string[],
 *             adjudicable: boolean }}
 */
export function detectPriceDivergence(pricing = {}, { factor = 5 } = {}) {
  const prices = comparableEurPrices(pricing);
  const base = {
    diverged: false, ratio: null, median: null, prices, outliers: [], adjudicable: false,
  };
  if (prices.length < 2) return base;

  const vals = prices.map(p => p.eur).sort((a, b) => a - b);
  const ratio = vals[vals.length - 1] / vals[0];
  if (ratio < factor) return { ...base, ratio };

  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;

  // Two sources cannot adjudicate — see the note above.
  if (prices.length < 3) {
    return { ...base, diverged: true, ratio, median, adjudicable: false };
  }

  const outliers = prices
    .filter(p => p.eur / median >= factor || median / p.eur >= factor)
    .map(p => p.source);

  return { ...base, diverged: true, ratio, median, outliers, adjudicable: outliers.length > 0 };
}

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

  // eBay sample_size is NOT a sales-volume signal and no longer scores.
  //
  // It counts active listings returned by a Browse query that is hard-capped at
  // limit 15, so the 12/6/3 thresholds were really asking "did the query return
  // a full page?" — a card with 200 listings and one with 15 scored identically,
  // and a card with genuinely zero listings was indistinguishable from one whose
  // name simply didn't match the query. It was also worth ±30 points, the
  // largest single term in the score, on that basis.
  //
  // Volume is still reported for display, relabelled to say what it actually is.
  hotness.volume = pricing.ebay?.sample_size || 0;
  hotness.volume_basis = 'ebay_active_listings_capped';

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
