// pricing/adapters/cardmarket-html.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md (PricingAdapter contract)
//   - V1 server.js: fetchCardmarketPrice + buildCardmarketUrl
//   - docs/V2_AUDIT.md §2 (Cloudflare-block behaviour, blocked_by:'cloudflare')
//
// Best-effort direct HTML scrape of cardmarket.com product pages. Cloudflare
// blocks most requests now; on success this is the highest-trust EUR data
// (confidence 0.95). Returns confidence 0 + blocked_by:'cloudflare' so the
// /api/v2/price "why this price" UI can show the source as structurally
// unavailable rather than "no data for this card".

import { axios } from '../../apps/server/_clients.js';

const NAME = 'cardmarket-html';

// V1: CONDITION_TO_CM table — Cardmarket's minCondition query parameter.
const CONDITION_TO_CM = { NM: 2, LP: 4, MP: 5, HP: 6, DMG: 7 };

// V1: CM_GAME_SLUGS — the URL path segment per game family.
const CM_GAME_SLUGS = {
  magic: 'Magic',
  pokemon: 'Pokemon',
  yugioh: 'YuGiOh',
  onepiece: 'OnePiece',
  lorcana: 'Lorcana',
  dragonball: 'DragonBallSuper',
  starwars: 'StarWarsUnlimited',
  digimon: 'Digimon',
  fleshandblood: 'FleshAndBlood',
  weiss: 'WeissSchwarz',
  cardfight: 'VanguardZero',
};

/**
 * Game → Cardmarket URL slug. Exposed for /api/search (V1 server.js:5052)
 * which needs to construct a shallow product-search link for non-API games.
 */
export function getGameSlug(game) {
  return CM_GAME_SLUGS[game] || null;
}

/**
 * Build Cardmarket search URLs for a card (no scrape — cheap helper).
 * Returns {search_url, filtered_search_url, narrow_search_url, …} so the
 * UI can fall back to "Tap to check live Cardmarket prices" links when the
 * scrape fails. V1 server.js:3974-4002.
 */
export function buildCardmarketUrl(card) {
  const gameSlug = getGameSlug(card.game);
  const condCode = CONDITION_TO_CM[card.condition_estimate] || 2;

  const num = card.card_number ? card.card_number.replace(/\/.*/, '').replace(/^0+/, '') : '';

  let searchTerm = card.name || '';
  if (num) {
    searchTerm = `${card.name} ${num}`;
  }

  const searchUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(searchTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(searchTerm)}`;

  const fallbackTerm = card.name || '';
  const fallbackUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(fallbackTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(fallbackTerm)}`;

  return {
    product_url: null,
    product_url_filtered: null,
    search_url: searchUrl,
    filtered_search_url: `${searchUrl}&language=1&minCondition=${condCode}`,
    narrow_search_url: fallbackUrl,
    source: 'cardmarket_link',
  };
}

/**
 * Direct HTML scrape — V1 server.js:fetchCardmarketPrice. Returns the V1
 * shape (price/trend/low/avg30/offers_low) rather than a v2 PriceQuote, to
 * keep the legacy /api/price route 1:1 during S6. The default-export
 * adapter wraps this for the v2 fan-out.
 *
 * @param {string} productUrl  Direct cardmarket.com product page URL.
 * @param {string} condition   NM/LP/MP/HP/DMG — minCondition filter.
 */
export async function fetchCardmarketPrice(productUrl, condition) {
  if (!productUrl || !productUrl.includes('cardmarket.com')) return null;

  const condCode = CONDITION_TO_CM[condition] || 2;
  const filteredUrl = productUrl.includes('?')
    ? `${productUrl}&language=1&minCondition=${condCode}`
    : `${productUrl}?language=1&minCondition=${condCode}`;

  try {
    console.log(`[CM-FETCH] Trying direct fetch: ${filteredUrl}`);
    const resp = await axios.get(filteredUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const html = resp.data;
    const title = typeof html === 'string' ? html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || '' : '';

    if (title.includes('Just a moment') || title.includes('Attention') || html.length < 5000) {
      console.log(`[CM-FETCH] Cloudflare blocked (title: "${title}", size: ${html.length})`);
      return null;
    }

    console.log(`[CM-FETCH] Got page! Title: "${title}", size: ${html.length}`);

    const result = { url: productUrl, filtered_url: filteredUrl, source: 'cardmarket_live' };

    const trendMatch = html.match(/Price\s*Trend[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (trendMatch) result.trend = parseFloat(trendMatch[1].replace(',', '.'));

    const fromMatch = html.match(/(?:From|Ab|Available from)[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (fromMatch) result.low = parseFloat(fromMatch[1].replace(',', '.'));

    const avg30Match = html.match(/30[- ]day[s]?\s*average[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (avg30Match) result.avg30 = parseFloat(avg30Match[1].replace(',', '.'));

    const offerPrices = [];
    const priceRegex = /(\d+[.,]\d{2})\s*€/g;
    let match;

    const sellerSection = html.split(/Seller|seller/i)[1] || '';
    while ((match = priceRegex.exec(sellerSection)) !== null) {
      const price = parseFloat(match[1].replace(',', '.'));
      if (price > 0.01 && price < 50000) {
        offerPrices.push(price);
      }
    }

    const uniqueOffers = [...new Set(offerPrices)].sort((a, b) => a - b);

    if (uniqueOffers.length > 0) {
      result.offers_low = uniqueOffers[0];
      result.total_offers = uniqueOffers.length;
      result.note = `Lowest English ${condition}+ offer: ${uniqueOffers[0].toFixed(2)}€ (${uniqueOffers.length} sellers)`;
      console.log(`[CM-FETCH] Found ${uniqueOffers.length} offer prices, lowest: ${uniqueOffers[0]}€`);
    }

    result.price = result.offers_low || result.low || result.trend;
    if (!result.price) {
      console.log('[CM-FETCH] Could not extract any prices from page');
      return null;
    }

    console.log(`[CM-FETCH] SUCCESS — price: ${result.price}€, trend: ${result.trend || '?'}€, offers_low: ${result.offers_low || '?'}€`);
    return result;
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.log('[CM-FETCH] Blocked by Cloudflare (403). Falling back to API prices.');
    } else {
      console.log(`[CM-FETCH] Failed: ${err.message}. Falling back to API prices.`);
    }
    return null;
  }
}

/**
 * Default-export adapter conforming to pricing/adapter.interface.md.
 * Price-only — Cardmarket doesn't have a verify endpoint for us.
 */
export default {
  name: NAME,
  supports: {
    games: ['pokemon', 'magic', 'yugioh', 'onepiece', 'lorcana', 'dragonball', 'starwars', 'digimon', 'fleshandblood'],
    needs: ['verified_card'],
  },
  isAvailable() {
    return true;
  },
  async price(card /*, ctx */) {
    if (!card?.cardmarket_url) return null;
    const condition = card.condition_estimate || 'NM';
    const raw = await fetchCardmarketPrice(card.cardmarket_url, condition);
    if (!raw) {
      // V2 contract: structurally unavailable distinguished from "no data".
      return {
        source: NAME,
        market_value_eur: null,
        raw_currency: 'EUR',
        raw_value: null,
        confidence: 0,
        fetched_at: new Date().toISOString(),
        blocked_by: 'cloudflare',
      };
    }
    return {
      source: NAME,
      market_value_eur: raw.price,
      raw_currency: 'EUR',
      raw_value: raw.price,
      confidence: 0.95,
      fetched_at: new Date().toISOString(),
      trend: raw.trend ?? null,
      avg30: raw.avg30 ?? null,
      product_url: raw.url,
    };
  },
};
