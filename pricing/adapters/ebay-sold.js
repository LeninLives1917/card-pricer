// pricing/adapters/ebay-sold.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md §5 (confidence min(0.9, 0.3 + 0.04 * sample_size))
//   - V1 server.js: getEbayToken + priceEbaySold
//
// eBay Browse API. Marketplace = EBAY_IE (Ireland, EUR). Confidence scales
// with sample size: more recent sales = higher trust, capped at 0.9.

import { axios } from '../../apps/server/_clients.js';

const NAME = 'ebay-sold';

// eBay client-credentials tokens are valid for ~2 hours. V1 fetched a fresh one
// on every card, which on a bulk-scanning session is one extra round trip per
// card plus needless rate-limit exposure. Cached module-level with a safety
// margin; a failed fetch is not cached, so the next call retries.
let _tokenCache = { token: null, expiresAt: 0 };
const TOKEN_TTL_MS = 105 * 60 * 1000;   // 1h45m — under the ~2h eBay lifetime

/**
 * Fetch (or reuse) a client-credentials OAuth token for the eBay Browse API.
 * Returns null when credentials are absent or the exchange fails.
 */
async function getEbayToken() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) return null;

  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  try {
    const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
    const resp = await axios.post('https://api.ebay.com/identity/v1/oauth2/token', new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }), {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });
    const token = resp.data.access_token;
    if (token) {
      // Respect the server's own expiry when it gives one, minus a margin.
      const serverTtl = Number(resp.data.expires_in) * 1000;
      const ttl = Number.isFinite(serverTtl) && serverTtl > 0
        ? Math.max(0, serverTtl - 5 * 60 * 1000)
        : TOKEN_TTL_MS;
      _tokenCache = { token, expiresAt: Date.now() + ttl };
    }
    return token;
  } catch (err) {
    console.error('eBay token error:', err.message);
    return null;   // deliberately not cached — retry on the next call
  }
}

/** Test hook: drop the cached token so a spec can exercise the fetch path. */
export function __resetTokenCache() {
  _tokenCache = { token: null, expiresAt: 0 };
}

/**
 * Search eBay sold listings (the live equivalent — Browse API has no "sold"
 * filter, V1 used buyingOptions=FIXED_PRICE|AUCTION sorted by price as a
 * proxy for active comps). Returns the V1 shape used by /api/price route.
 *
 * V1 server.js:priceEbaySold.
 */
export async function priceEbaySold(card) {
  const token = await getEbayToken();
  if (!token) {
    console.log('[eBay] No token available');
    return null;
  }

  const queries = [];

  let specific = card.name;
  if (card.set_code) specific += ` ${card.set_code}`;
  if (card.card_number) specific += ` ${card.card_number.replace(/\/.*/, '')}`;
  queries.push(specific);

  const gameNames = {
    pokemon: 'pokemon tcg', magic: 'mtg', starwars: 'star wars unlimited',
    onepiece: 'one piece tcg', yugioh: 'yugioh', lorcana: 'lorcana',
    dragonball: 'dragon ball super', digimon: 'digimon tcg', fleshandblood: 'flesh and blood',
  };
  if (card.card_number) {
    queries.push(`${card.name} ${card.card_number} ${gameNames[card.game] || ''}`);
  }

  queries.push(`${card.name} ${gameNames[card.game] || 'tcg'} card`);

  const responses = await Promise.all(queries.map(q =>
    axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: {
        q,
        category_ids: '183454',
        filter: 'buyingOptions:{FIXED_PRICE|AUCTION}',
        sort: 'price',
        limit: 15,
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IE',
      },
      timeout: 10000,
    })
      .then(resp => ({ q, items: resp.data?.itemSummaries || [] }))
      .catch(err => {
        console.error(`[eBay] API error for "${q}": ${err.response?.data?.errors?.[0]?.message || err.message}`);
        return { q, items: [] };
      })
  ));

  for (const { q, items } of responses) {
    if (!items.length) { console.log(`[eBay] "${q}" → no results`); continue; }
    console.log(`[eBay] "${q}" → ${items.length} listings`);

    const prices = items
      .filter(i => i.price?.value)
      .map(i => ({
        price: parseFloat(i.price.value),
        currency: i.price.currency,
        title: i.title,
        url: i.itemWebUrl,
      }))
      .filter(i => i.price > 0 && i.price < 10000)
      .sort((a, b) => a.price - b.price);

    if (!prices.length) continue;
    const median = prices[Math.floor(prices.length / 2)];
    return {
      median_price: median.price,
      low: prices[0].price,
      high: prices[prices.length - 1].price,
      sample_size: prices.length,
      currency: median.currency || 'EUR',
      recent_sales: prices.slice(0, 5).map(i => ({
        title: i.title,
        price: i.price,
        currency: i.currency,
        url: i.url,
      })),
    };
  }

  console.log('[eBay] No results found across all search strategies');
  return null;
}

/**
 * Default-export adapter — V2 fan-out. Confidence min(0.9, 0.3 + 0.04 * n)
 * — scales with sample size, capped 0.9 even with huge samples.
 */
export default {
  name: NAME,
  supports: {
    games: ['pokemon', 'magic', 'yugioh', 'starwars', 'onepiece', 'lorcana', 'dragonball', 'digimon', 'fleshandblood'],
    needs: ['name'],
  },
  isAvailable() {
    return !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID);
  },
  async price(card /*, ctx */) {
    const raw = await priceEbaySold(card);
    if (!raw || raw.median_price == null) return null;
    const sample = raw.sample_size || 0;
    const confidence = Math.min(0.9, 0.3 + 0.04 * sample);
    return {
      source: NAME,
      market_value_eur: raw.currency === 'EUR' ? raw.median_price : null,
      raw_currency: raw.currency === 'EUR' ? 'EUR' : 'USD',
      raw_value: raw.median_price,
      confidence,
      fetched_at: new Date().toISOString(),
      sample_size: sample,
    };
  },
};
