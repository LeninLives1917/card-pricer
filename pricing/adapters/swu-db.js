// pricing/adapters/swu-db.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - V1 server.js:verifySWU
//
// Star Wars: Unlimited verify. Verify-only — no price method (Cardmarket /
// JustTCG cover SWU pricing). Tries name-search first, then per-set lookups
// (SOR/SHD/TWI/JTL) as a fallback.

import { axios } from '../../apps/server/_clients.js';

const NAME = 'swu-db';

/**
 * V1 server.js:verifySWU. Returns the verify-shape (name/set_name/...).
 */
export async function verifySWU(card) {
  try {
    const searchUrl = `https://api.swu-db.com/cards/search?q=${encodeURIComponent(card.name)}`;
    console.log(`[VERIFY-SWU] Searching: ${searchUrl}`);

    const resp = await axios.get(searchUrl, { timeout: 8000 });
    const results = resp.data?.data || resp.data;

    if (Array.isArray(results) && results.length > 0) {
      let best = null;
      let bestScore = -1;

      for (const c of results) {
        let score = 0;
        const cName = (c.name || c.Name || '').toLowerCase();
        const cNum = (c.number || c.Number || c.CardNumber || '').toString();
        const cSet = (c.set?.code || c.SetCode || c.set_code || '').toUpperCase();

        if (cName === card.name.toLowerCase()) score += 30;
        else if (cName.includes(card.name.toLowerCase())) score += 15;

        if (card.card_number) {
          const aiNum = card.card_number.replace(/\/.*/, '').replace(/^0+/, '').replace(/^[A-Z]+ ?/, '');
          const dbNum = cNum.replace(/^0+/, '');
          if (aiNum === dbNum) score += 50;
          if (card.card_number.includes(cSet) || card.card_number.toUpperCase().startsWith(cSet)) score += 10;
        }

        if (card.set_code && cSet === card.set_code.toUpperCase()) score += 20;

        if (card.variant && c.variant) {
          if (c.variant.toLowerCase().includes(card.variant.toLowerCase())) score += 15;
        }

        console.log(`[VERIFY-SWU]   "${cName}" ${cSet} #${cNum} => score ${score}`);
        if (score > bestScore) { bestScore = score; best = c; }
      }

      if (!best) best = results[0];

      const setName = best.set?.name || best.Set || best.set_name || best.expansion || '';
      const setCode = best.set?.code || best.SetCode || best.set_code || '';
      const cardNum = best.number || best.Number || best.CardNumber || best.card_number || '';

      return {
        name: best.name || best.Name || card.name,
        set_name: setName,
        set_code: setCode.toUpperCase(),
        card_number: cardNum.toString(),
        rarity: best.rarity || best.Rarity || '',
        image: best.image || best.FrontArt || best.artFront || null,
        source: 'swu-db.com',
      };
    }

    const sets = ['SOR', 'SHD', 'TWI', 'JTL'];
    for (const setCode of sets) {
      try {
        const setResp = await axios.get(`https://api.swu-db.com/cards/${setCode.toLowerCase()}`, { timeout: 5000 });
        const setCards = setResp.data?.data || setResp.data || [];
        if (Array.isArray(setCards)) {
          const match = setCards.find(c =>
            (c.name || c.Name || '').toLowerCase().includes(card.name.toLowerCase())
          );
          if (match) {
            return {
              name: match.name || match.Name,
              set_name: match.set?.name || setCode,
              set_code: setCode,
              card_number: (match.number || match.Number || '').toString(),
              rarity: match.rarity || match.Rarity || '',
              image: match.image || match.FrontArt || null,
              source: 'swu-db.com',
            };
          }
        }
      } catch { /* try next set */ }
    }
  } catch (err) {
    console.error(`[VERIFY-SWU] Error: ${err.message}`);
  }
  return null;
}

/**
 * Default-export adapter — verify-only, no price method.
 */
export default {
  name: NAME,
  supports: {
    games: ['starwars'],
    needs: ['name'],
  },
  isAvailable() {
    return true;
  },
  async verify(card /*, ctx */) {
    const v = await verifySWU(card);
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
