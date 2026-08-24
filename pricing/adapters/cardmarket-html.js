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

// Cardmarket's own minCondition codes: 1=MT 2=NM 3=EX 4=GD 5=LP 6=PL 7=PO.
//
// The old table was { NM:2, LP:4, MP:5, HP:6, DMG:7 } — the CODES were right
// for the multipliers attached to them, but the NAMES were a TCGPlayer-shaped
// scale, so "LP" filtered for Good and "MP" filtered for Light Played. The
// grades are now Cardmarket's, which is the vocabulary the operator asked for
// and the one the marketplace uses. See pricing/conditions.js.
//
// Legacy names are kept pointing at the same codes they always did, so a
// stored session or an older client filters exactly as before.
const CONDITION_TO_CM = {
  MT: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7,
  // legacy — unchanged codes, so old input behaves identically
  MP: 5, HP: 6, DMG: 7,
};

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

  // A product URL that has already been resolved for this card, if one has.
  // See resolveCardmarketProductUrl — the direct page cannot be BUILT, only
  // looked up, so this is empty until something has looked it up.
  const cached = _productUrlCache.get(cardCacheKey(card));
  const product = cached && cached !== NO_PRODUCT ? cached : null;

  return {
    product_url: product,
    product_url_filtered: product ? withFilters(product, condCode) : null,
    search_url: searchUrl,
    filtered_search_url: `${searchUrl}&language=1&minCondition=${condCode}`,
    narrow_search_url: fallbackUrl,
    // The best link available, already filtered to English + this condition.
    // Callers should use this and not think about which kind it is.
    best_url: product ? withFilters(product, condCode) : `${searchUrl}&language=1&minCondition=${condCode}`,
    best_url_kind: product ? 'product' : 'search',
    source: 'cardmarket_link',
  };
}

/** language=1 is Cardmarket's ENGLISH filter; minCondition is its grade floor. */
function withFilters(url, condCode) {
  // Drop pokemontcg.io's campaign parameters. They are their attribution, not
  // ours, and they make an already-long link unreadable in a UI.
  const clean = String(url)
    .replace(/[?&]utm_[^&]*/g, '')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');
  const sep = clean.includes('?') ? '&' : '?';
  return `${clean}${sep}language=1&minCondition=${condCode}`;
}

const cardCacheKey = (card) =>
  `${card?.game ?? 'pokemon'}|${String(card?.set_code ?? '').toLowerCase()}|${String(card?.card_number ?? '').toLowerCase()}|${String(card?.name ?? '').toLowerCase()}`;

/** Sentinel so a card KNOWN to have no product page is not re-resolved forever. */
const NO_PRODUCT = Symbol('no-product');
const _productUrlCache = new Map();

/**
 * Find the Cardmarket product page for a card.
 *
 * THE URL CANNOT BE BUILT. That was the first thing tried, and the real URLs
 * say why:
 *
 *   Stellar-Crown/Gulpin-V2-SCR154            -V2 is Cardmarket's own versioning
 *   Obsidian-Flames/Smoliv-OBF019             zero-padded to three
 *   Vivid-Voltage/Shiftry-VIV12               not padded
 *   Journey-Together/Hops-Wooloo-V2-JTG171    JTG171 where the card is 170
 *   EX-Legend-Maker/Muk-LM11                  set slug and code are Cardmarket's own
 *
 * The version suffix, the padding, the set abbreviations and even the
 * collector number are Cardmarket's internal data, not derivable from ours.
 * A generator would produce plausible URLs that 404, which is worse than a
 * search link because it looks right.
 *
 * What DOES work: pokemontcg.io publishes a redirect per card, and the
 * catalogue already stores it. Following it once yields the canonical URL,
 * and the English + condition filters append cleanly.
 *
 * MEASURED on 100 random catalogue cards: 75 resolve to a product page, 25
 * have no mapping at all. Those 25 get the filtered SEARCH url, which is
 * always buildable — so every card gets a working English/NM link, and
 * three-quarters go straight to the card.
 *
 * Cached per card, including the misses, so a bulk session pays each lookup
 * once. Never throws: a link is a convenience and must not fail a price.
 */
export async function resolveCardmarketProductUrl(card, { timeoutMs = 6000 } = {}) {
  const key = cardCacheKey(card);
  if (_productUrlCache.has(key)) {
    const hit = _productUrlCache.get(key);
    return hit === NO_PRODUCT ? null : hit;
  }

  const redirect = card?.cardmarket_url || card?.cardmarketUrl;
  if (!redirect || !/prices\.pokemontcg\.io/.test(redirect)) {
    // Already a direct Cardmarket link, or nothing to follow.
    const direct = redirect && /cardmarket\.com/.test(redirect) ? redirect : null;
    _productUrlCache.set(key, direct ?? NO_PRODUCT);
    return direct;
  }

  // RETRY, because this service is unreliable and the project has been bitten
  // by assuming otherwise. CLAUDE.md records it directly: "No retry anywhere,
  // against an API that 500s on roughly 40% of valid requests. One 500
  // silently dropped a whole set."
  //
  // Observed here while measuring: two runs over the same 100 cards resolved
  // 75 and then 64, purely from upstream 502s. A card that "has no Cardmarket
  // page" and a card whose lookup happened to fail are completely different
  // facts, and without a retry they are indistinguishable.
  //
  // A 302 or a 404 is an ANSWER and ends the loop. Only 5xx and network
  // errors are retried.
  let lastWasTransient = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(redirect, { redirect: 'manual', signal: ctl.signal });
      clearTimeout(t);

      if (r.status >= 500) { lastWasTransient = true; }
      else {
        const loc = r.headers.get('location');
        const ok = loc && /cardmarket\.com/.test(loc) ? loc : null;
        // A definite answer, cached either way — including the miss, so a
        // card with genuinely no page is not looked up again all session.
        _productUrlCache.set(key, ok ?? NO_PRODUCT);
        return ok;
      }
    } catch {
      lastWasTransient = true;
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }

  // Never cache a transient failure as "no product" — that would make one bad
  // minute permanent for the life of the process.
  void lastWasTransient;
  return null;
}

/** Test seam. */
export function resetCardmarketUrlCache() {
  _productUrlCache.clear();
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
