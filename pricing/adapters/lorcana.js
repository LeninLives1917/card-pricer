// pricing/adapters/lorcana.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - V1 server.js:verifyGeneric (lorcana branch)
//
// Best-effort Disney Lorcana verify via lorcana-api.com. No price (Cardmarket
// + JustTCG cover the price side). One Piece + Digimon + FaB + Dragonball
// share verifyGeneric in V1 but only Lorcana actually has an upstream
// implementation; the rest return null. Kept here so each game has at least
// one adapter file.

import { axios } from '../../apps/server/_clients.js';

const NAME = 'lorcana';

/**
 * V1 server.js:verifyGeneric (lorcana branch). Other generic-game branches
 * (onepiece / digimon / fleshandblood / dragonball) all return null in V1
 * — they fall through to AI identification verbatim.
 */
export async function verifyLorcana(card) {
  try {
    const resp = await axios.get(
      `https://api.lorcana-api.com/cards/fetch?search=${encodeURIComponent(card.name)}`,
      { timeout: 8000 }
    );
    if (resp.data?.length > 0) {
      const d = resp.data[0];
      return {
        name: d.Name || d.name,
        set_name: d.Set_Name || d.set || '',
        set_code: d.Set_ID || '',
        card_number: d.Card_Num || d.number || '',
        rarity: d.Rarity || '',
        image: d.Image || null,
        source: 'lorcana-api.com',
      };
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Default-export adapter — verify-only, best-effort.
 */
export default {
  name: NAME,
  supports: {
    games: ['lorcana'],
    needs: ['name'],
  },
  isAvailable() {
    return true;
  },
  async verify(card /*, ctx */) {
    const v = await verifyLorcana(card);
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
