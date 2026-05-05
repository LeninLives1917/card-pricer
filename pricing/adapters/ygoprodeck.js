// pricing/adapters/ygoprodeck.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - V1 server.js:verifyYuGiOh
//
// Yu-Gi-Oh! verify via ygoprodeck.com. Verify-only. Tries exact name first,
// then fuzzy. Picks the first set in `card_sets` (most cards have many
// printings; cardmarket pricing handles cross-printing aggregation).

import { axios } from '../../apps/server/_clients.js';

const NAME = 'ygoprodeck';

/**
 * V1 server.js:verifyYuGiOh.
 */
export async function verifyYuGiOh(card) {
  try {
    const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
      params: { name: card.name },
      timeout: 8000,
    });

    if (resp.data?.data?.length > 0) {
      const d = resp.data.data[0];
      const firstSet = d.card_sets?.[0];
      return {
        name: d.name,
        set_name: firstSet?.set_name || '',
        set_code: firstSet?.set_code || '',
        card_number: firstSet?.set_code || card.card_number,
        rarity: firstSet?.set_rarity || d.race,
        image: d.card_images?.[0]?.image_url,
        source: 'ygoprodeck.com',
      };
    }
  } catch (err) {
    try {
      const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
        params: { fname: card.name },
        timeout: 8000,
      });
      if (resp.data?.data?.length > 0) {
        const d = resp.data.data[0];
        const firstSet = d.card_sets?.[0];
        return {
          name: d.name, set_name: firstSet?.set_name || '', set_code: firstSet?.set_code || '',
          card_number: firstSet?.set_code || '', rarity: firstSet?.set_rarity || '',
          image: d.card_images?.[0]?.image_url, source: 'ygoprodeck.com',
        };
      }
    } catch { return null; }
  }
  return null;
}

/**
 * Default-export adapter — verify-only.
 */
export default {
  name: NAME,
  supports: {
    games: ['yugioh'],
    needs: ['name'],
  },
  isAvailable() {
    return true;
  },
  async verify(card /*, ctx */) {
    const v = await verifyYuGiOh(card);
    if (!v) return null;
    return {
      name: v.name,
      set_name: v.set_name,
      set_code: v.set_code,
      card_number: v.card_number,
      rarity: v.rarity || null,
      hp: null,
      image: v.image || null,
      cardmarket_url: null,
      tcgplayer_url: null,
      source: v.source,
    };
  },
};
