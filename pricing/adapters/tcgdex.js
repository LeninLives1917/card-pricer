// pricing/adapters/tcgdex.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - V1 server.js:lookupTCGdex
//   - pricing/set-aliases.js (TCGDEX_SET_MAP)
//
// tcgdex.net Pokemon fallback. Used by /api/identify-manual when both the
// local DB and pokemontcg.io miss. Verify-only — no price method.
// Read-only static-ish data; engine cache TTL recommended at 24h.

import { axios } from '../../apps/server/_clients.js';
import { TCGDEX_SET_MAP } from '../set-aliases.js';

const NAME = 'tcgdex';

/**
 * V1 server.js:lookupTCGdex. Returns the verify-shape used by
 * /api/identify-manual.
 *
 * @param {string} setId       pokemontcg.io set-id (lowercase).
 * @param {string} cardNumber  Raw printed number.
 */
export async function lookupTCGdex(setId, cardNumber) {
  const tcgdexSetId = TCGDEX_SET_MAP[setId] || setId;
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const cardId = `${tcgdexSetId}-${cleanNum}`;
  console.log(`[TCGdex] Looking up: ${cardId}`);
  try {
    const resp = await axios.get(`https://api.tcgdex.net/v2/en/cards/${cardId}`, { timeout: 8000 });
    const d = resp.data;
    if (!d || !d.name) return null;
    console.log(`[TCGdex] Found: ${d.name} (${d.set?.name || '?'})`);
    return {
      game: 'pokemon',
      name: d.name,
      set_name: d.set?.name || null,
      set_code: (d.set?.id || setId).toUpperCase(),
      card_number: d.localId || cleanNum,
      rarity: d.rarity || null,
      hp: d.hp ? String(d.hp) : null,
      reference_image: d.image ? `${d.image}/high.webp` : null,
      verified: true,
      db_source: 'tcgdex.net (fallback)',
      _manual: true,
    };
  } catch (e) {
    console.log(`[TCGdex] ${cardId} failed: ${e.response?.status || e.message}`);
    return null;
  }
}

/**
 * Default-export adapter — verify-only.
 */
export default {
  name: NAME,
  supports: {
    games: ['pokemon'],
    needs: ['set_code', 'card_number'],
  },
  isAvailable() {
    return true; // tcgdex.net is free + unauthenticated
  },
  async verify(card /*, ctx */) {
    if (!card?.set_code || !card?.card_number) return null;
    const v = await lookupTCGdex(card.set_code.toLowerCase(), card.card_number);
    if (!v) return null;
    return {
      name: v.name,
      set_name: v.set_name || '',
      set_code: v.set_code,
      card_number: v.card_number,
      rarity: v.rarity ?? null,
      hp: v.hp ?? null,
      image: v.reference_image || null,
      cardmarket_url: null,
      tcgplayer_url: null,
      source: 'tcgdex.net',
    };
  },
};
