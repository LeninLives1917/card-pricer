// pricing/adapters/justtcg.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md §5 (confidence rubric: 0.65 base + 0.10 NM exact)
//   - V1 server.js: fetchJustTCGPrice + JUSTTCG_GAME_MAP + JUSTTCG_CONDITION_MAP
//
// JustTCG is the cheap TCGPlayer-USD-via-API source. Free tier capped at
// 100/day. Returns USD; converted to EUR via getUsdToEur().

import { axios } from '../../apps/server/_clients.js';
import { getUsdToEur } from '../fx.js';
import { PKM_SET_NAMES } from '../set-aliases.js';

const NAME = 'justtcg';

// V1 game-name → JustTCG slug.
const JUSTTCG_GAME_MAP = {
  pokemon: 'pokemon',
  magic: 'mtg',
  yugioh: 'yugioh',
  lorcana: 'lorcana',
  onepiece: 'onepiece',
  digimon: 'digimon',
  starwars: 'star-wars-unlimited',
  flesh_and_blood: 'flesh-and-blood',
};

// V1 condition shorthand → JustTCG full word.
const JUSTTCG_CONDITION_MAP = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};

/**
 * Legacy V1 entrypoint — kept exported for the /api/price route's import
 * shape. V1 server.js:fetchJustTCGPrice. Returns the JustTCG-flavoured
 * shape (price_usd / price_eur / printing / …) used by route/price.js.
 */
export async function fetchJustTCGPrice(card) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const game = JUSTTCG_GAME_MAP[card.game] || card.game;
  const conditionFull = JUSTTCG_CONDITION_MAP[card.condition_estimate] || 'Near Mint';
  const conditionShort = card.condition_estimate || 'NM';

  try {
    let searchQuery = card.name;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      searchQuery = `${card.name} ${num}`;
    }

    const params = { q: searchQuery, game: game, limit: 5 };

    console.log(`[JustTCG] Searching: game=${game}, q="${params.q}"`);

    const resp = await axios.get('https://api.justtcg.com/v1/cards', {
      params,
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 10000,
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      console.log('[JustTCG] No results, trying name only...');
      const resp2 = await axios.get('https://api.justtcg.com/v1/cards', {
        params: { q: card.name, game: game, limit: 5 },
        headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
        timeout: 10000,
      });
      const data2 = resp2.data?.data;
      if (!data2 || data2.length === 0) {
        console.log('[JustTCG] No results found');
        return null;
      }
      return parseJustTCGResult(data2, card, conditionFull, conditionShort);
    }

    return parseJustTCGResult(data, card, conditionFull, conditionShort);
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[JustTCG] Rate limited (100/day) — skipping');
    } else if (err.response?.status === 401) {
      console.log('[JustTCG] Invalid API key');
    } else {
      console.log(`[JustTCG] Error: ${err.message}`);
    }
    return null;
  }
}

function parseJustTCGResult(data, card, conditionFull, conditionShort) {
  let best = data[0];
  let bestScore = 0;
  for (const item of data) {
    let score = 0;
    if (item.name?.toLowerCase().includes(card.name.toLowerCase())) score += 50;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      const itemNum = (item.number || '').replace(/\/.*/, '');
      if (itemNum === num) score += 60;
    }
    if (card.set_name && item.set_name?.toLowerCase().includes(card.set_name.toLowerCase())) score += 30;
    if (score > bestScore) { bestScore = score; best = item; }
  }

  const variants = best.variants || [];
  let bestVariant = variants[0];

  const condMatch = variants.filter(v => v.condition === conditionFull);
  if (condMatch.length > 0) {
    bestVariant = condMatch.find(v => v.printing === 'Normal' || v.printing === 'Holofoil') || condMatch[0];
  }

  const price = bestVariant?.price || null;
  const result = {
    source: 'justtcg',
    name: best.name,
    set: best.set_name || best.set,
    set_slug: best.set,
    card_number: best.number,
    condition: conditionShort,
    condition_full: bestVariant?.condition || conditionFull,
    printing: bestVariant?.printing || null,
    price_usd: price,
    price_eur: price ? Math.round(price * getUsdToEur() * 100) / 100 : null,
    currency: 'USD',
    last_updated: bestVariant?.lastUpdated ? new Date(bestVariant.lastUpdated * 1000).toISOString() : null,
    price_change_7d: bestVariant?.priceChange7d || null,
    price_change_30d: bestVariant?.priceChange30d || null,
    avg_30d: bestVariant?.avgPrice30d || null,
    min_30d: bestVariant?.minPrice30d || null,
    max_30d: bestVariant?.maxPrice30d || null,
  };

  if (result.price_usd) {
    console.log(`[JustTCG] Found: ${result.name} (${result.set} #${result.card_number}) = $${result.price_usd} USD / ~${result.price_eur}€ [${result.condition_full}, ${result.printing}]`);
  } else {
    console.log(`[JustTCG] Found card but no price: ${result.name}`);
  }

  return result;
}

/**
 * Lookup-style helper — used by /api/identify-manual when a Pokemon set+num
 * has no pokemontcg.io / TCGdex match. V1 server.js:lookupViaJustTCG.
 * Verify-shape return (game/name/set_name/...). Lives in the JustTCG
 * adapter because it's a JustTCG search.
 *
 * @param {string} setId    pokemontcg.io set-id (lowercase) — used for
 *                          PKM_SET_NAMES lookup before the search.
 * @param {string} cardNumber  Raw card number (with or without slash).
 */
export async function lookupViaJustTCG(setId, cardNumber) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  if (!setName) return null;

  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const searchQuery = `${setName} ${cleanNum}`;
  console.log(`[JustTCG-FALLBACK] Searching: "${searchQuery}"`);

  try {
    const resp = await axios.get('https://api.justtcg.com/v1/cards', {
      params: { q: searchQuery, game: 'pokemon', limit: 5 },
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 10000,
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      console.log('[JustTCG-FALLBACK] No results');
      return null;
    }

    let best = data[0];
    let bestScore = 0;
    for (const item of data) {
      let score = 0;
      const itemNum = (item.number || '').replace(/\/.*/, '');
      if (itemNum === cleanNum) score += 60;
      if (item.set_name?.toLowerCase().includes(setName.toLowerCase())) score += 40;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    console.log(`[JustTCG-FALLBACK] Found: ${best.name} (${best.set_name || '?'} #${best.number})`);
    return {
      game: 'pokemon',
      name: best.name,
      set_name: best.set_name || setName,
      set_code: setId.toUpperCase(),
      card_number: best.number || cleanNum,
      rarity: best.rarity || null,
      reference_image: best.image_url || null,
      verified: true,
      db_source: 'justtcg.com (fallback)',
      _manual: true,
    };
  } catch (e) {
    console.log(`[JustTCG-FALLBACK] Error: ${e.response?.status || e.message}`);
    return null;
  }
}

/**
 * Default-export adapter — V2 fan-out shape. Confidence per
 * pricing/adapter.interface.md §5: 0.65 base, +0.10 if condition exact, -0.15
 * if printing fallback.
 */
export default {
  name: NAME,
  supports: {
    games: ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'digimon', 'starwars', 'flesh_and_blood', 'fleshandblood'],
    needs: ['name'],
  },
  isAvailable() {
    return !!process.env.JUSTTCG_API_KEY;
  },
  async price(card /*, ctx */) {
    const raw = await fetchJustTCGPrice(card);
    if (!raw || raw.price_usd == null) return null;
    let confidence = 0.65;
    const expectedCondition = JUSTTCG_CONDITION_MAP[card.condition_estimate || 'NM'];
    if (raw.condition_full && expectedCondition === raw.condition_full) {
      confidence += 0.10;
    }
    if (raw.printing && raw.printing !== 'Normal' && raw.printing !== 'Holofoil') {
      confidence -= 0.15;
    }
    return {
      source: NAME,
      market_value_eur: raw.price_eur,
      raw_currency: 'USD',
      raw_value: raw.price_usd,
      confidence: Math.max(0, Math.min(1, confidence)),
      fetched_at: new Date().toISOString(),
      avg30: raw.avg_30d ?? null,
    };
  },
};
