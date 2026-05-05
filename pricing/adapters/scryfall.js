// pricing/adapters/scryfall.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md (verify + price for game='magic')
//   - V1 server.js: verifyMagic + priceMagicCard
//
// Scryfall is the canonical Magic source — verify and price both live here.
// Returns USD prices (data.prices.usd) and embedded EUR (data.prices.eur)
// for cards Scryfall has Cardmarket data for. The EUR is a daily-snapshot
// of Cardmarket; we use it directly as raw_currency='EUR' when present.

import { axios } from '../../apps/server/_clients.js';

const NAME = 'scryfall';

/**
 * Magic verify — V1 server.js:verifyMagic. Direct lookup by set+number with
 * fuzzy fallback. Returns the verify-shape (name/set_name/set_code/...).
 */
export async function verifyMagic(card) {
  try {
    let url;
    if (card.set_code && card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      url = `https://api.scryfall.com/cards/${card.set_code.toLowerCase()}/${num}`;
    } else {
      url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`;
    }

    const resp = await axios.get(url, { timeout: 8000 });
    const d = resp.data;

    return {
      name: d.name,
      set_name: d.set_name,
      set_code: d.set.toUpperCase(),
      card_number: d.collector_number,
      rarity: d.rarity,
      image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
      cardmarket_url: d.purchase_uris?.cardmarket || null,
      tcgplayer_url: d.purchase_uris?.tcgplayer || null,
      source: 'scryfall.com',
    };
  } catch {
    try {
      const resp = await axios.get(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`, { timeout: 8000 });
      const d = resp.data;
      return {
        name: d.name, set_name: d.set_name, set_code: d.set.toUpperCase(),
        card_number: d.collector_number, rarity: d.rarity,
        image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
        cardmarket_url: d.purchase_uris?.cardmarket || null,
        tcgplayer_url: d.purchase_uris?.tcgplayer || null,
        source: 'scryfall.com',
      };
    } catch { return null; }
  }
}

/**
 * Magic price — V1 server.js:priceMagicCard. Returns the V1 shape used by
 * /api/price route (cardmarket_price / tcgplayer / scryfall metadata).
 */
export async function priceMagicCard(card) {
  const prices = { cardmarket: null, ebay: null, source: 'scryfall' };

  try {
    let url;
    if (card.set_code && card.card_number) {
      const setCode = card.set_code.toLowerCase();
      const num = card.card_number.replace(/\/.*/, '');
      url = `https://api.scryfall.com/cards/${setCode}/${num}`;
    } else {
      url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`;
    }

    const resp = await axios.get(url, { timeout: 8000 });
    const data = resp.data;

    if (data.prices) {
      const isFoil = card.variant && card.variant !== 'normal';
      const tcgPrice = isFoil ? data.prices.usd_foil : data.prices.usd;

      if (tcgPrice) {
        prices.tcgplayer = {
          price: parseFloat(tcgPrice),
          currency: 'USD',
          url: data.purchase_uris?.tcgplayer || null,
        };
      }

      const eurPrice = isFoil ? data.prices.eur_foil : data.prices.eur;
      if (eurPrice) {
        prices.cardmarket_price = parseFloat(eurPrice);
        prices.cardmarket_source = 'scryfall.com';
        console.log(`[PRICE] Cardmarket EUR price from Scryfall: ${eurPrice}€ (${data.name})`);
      }
    }

    if (data.purchase_uris?.cardmarket) {
      prices.cardmarket_product_url = data.purchase_uris.cardmarket;
    }

    prices.scryfall = {
      name: data.name,
      set: data.set_name,
      set_code: data.set,
      collector_number: data.collector_number,
      image: data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal,
      uri: data.scryfall_uri,
    };
  } catch (err) {
    console.error('Scryfall error:', err.message);
  }

  return prices;
}

/**
 * Default-export adapter — V2 fan-out. Confidence 0.70 (daily snapshot of
 * Cardmarket, no liquidity signal of its own).
 */
export default {
  name: NAME,
  supports: {
    games: ['magic'],
    needs: ['name'],
  },
  isAvailable() {
    return true; // Scryfall is free + unauthenticated
  },
  async verify(card /*, ctx */) {
    const v = await verifyMagic(card);
    if (!v) return null;
    return {
      name: v.name,
      set_name: v.set_name,
      set_code: v.set_code,
      card_number: v.card_number,
      rarity: v.rarity,
      hp: null,
      image: v.image || null,
      cardmarket_url: v.cardmarket_url || null,
      tcgplayer_url: v.tcgplayer_url || null,
      source: v.source,
    };
  },
  async price(card /*, ctx */) {
    const raw = await priceMagicCard(card);
    if (!raw) return null;
    const eur = raw.cardmarket_price ?? null;
    if (eur == null) return null;
    return {
      source: NAME,
      market_value_eur: eur,
      raw_currency: 'EUR',
      raw_value: eur,
      confidence: 0.70,
      fetched_at: new Date().toISOString(),
    };
  },
};
