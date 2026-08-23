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
import { countPriceMatch } from '../../infra/observability/price-match-counters.js';

const NAME = 'swu-db';

/** Counter key — /api/health reads this as a price_match source label. */
const SOURCE = 'swu-db';

// Scoring maxes around 115 (name 30 + number 50 + set-in-number 10 + set 20
// + variant 15). 30 is "the name matched exactly and nothing contradicted
// it", which is the weakest identity worth returning. Below that the
// adapter previously returned the first search hit as a verified card.
const MIN_SCORE = 30;

/**
 * Split on the separator, keep the digits.
 *
 * A printed badge is a separate element from the number — "SOR 051" is a set
 * badge, a gap, then 051 — so the separator is what identifies it. Requiring
 * one is deliberate: a run-together number like "GG31" or "XY03" is a whole
 * number, not a prefix plus digits, and stripping its letters would silently
 * turn it into a different card.
 */
function normaliseSwuNumber(n) {
  return String(n ?? '')
    .replace(/\/.*$/, '')            // drop the printed denominator
    .trim()
    .replace(/^[A-Za-z]+[\s-]+/, '') // drop a badge ONLY when a separator follows
    .replace(/^0+(?=\d)/, '')        // then, and only then, leading zeros
    .toLowerCase();
}

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
      // Hoisted out of the loop: whether a number was READ is a property of the
      // input, not of whichever candidate happened to come first.
      const numberWasRead = Boolean(card.card_number);

      for (const c of results) {
        let score = 0;
        let numberAgrees = false;
        const cName = (c.name || c.Name || '').toLowerCase();
        const cNum = (c.number || c.Number || c.CardNumber || '').toString();
        const cSet = (c.set?.code || c.SetCode || c.set_code || '').toUpperCase();

        if (cName === card.name.toLowerCase()) score += 30;
        else if (cName.includes(card.name.toLowerCase())) score += 15;

        if (card.card_number) {
          // Order matters, and it was wrong. The old line was:
          //   .replace(/\/.*/, '').replace(/^0+/, '').replace(/^[A-Z]+ ?/, '')
          // which strips leading zeros BEFORE the printed set badge, so on
          // "SOR 051" the zero-strip never fires (the string starts with S)
          // and aiNum stays "051" — while the candidate side becomes "51".
          // Every prefixed number with a leading zero therefore scored 0 on
          // the number and fell through to the first search hit.
          const aiNum = normaliseSwuNumber(card.card_number);
          const dbNum = normaliseSwuNumber(cNum);
          if (aiNum === dbNum) { score += 50; numberAgrees = true; }
          if (card.card_number.includes(cSet) || card.card_number.toUpperCase().startsWith(cSet)) score += 10;
        }

        if (card.set_code && cSet === card.set_code.toUpperCase()) score += 20;

        if (card.variant && c.variant) {
          if (c.variant.toLowerCase().includes(card.variant.toLowerCase())) score += 15;
        }

        console.log(`[VERIFY-SWU]   "${cName}" ${cSet} #${cNum} => score ${score}`);

        // When a card number was read, it is the discriminator and nothing
        // else substitutes for it. A candidate that disagrees is a different
        // card, whatever it scores on name.
        if (numberWasRead && !numberAgrees) continue;
        if (score > bestScore) { bestScore = score; best = c; }
      }

      // Was: `if (!best) best = results[0];`
      //
      // Dead in practice — bestScore started at -1, so `best` was assigned on
      // the first iteration even at score 0 — but the effect was identical to
      // the `let best = data[0]` seeding fixed in tcggo, justtcg and
      // pokemontcg: a zero-scoring first hit returned as a verified identity,
      // carrying its own set name, set code and card number. This adapter
      // returns no price of its own, so the damage is downstream: the wrong
      // identity drives the Cardmarket URL and the price cascade.
      if (!best || bestScore < MIN_SCORE) {
        countPriceMatch(SOURCE, numberWasRead ? 'rejected_no_number_match' : 'rejected_no_number_read',
          numberWasRead ? { requested: card.card_number, candidates: results.length } : undefined);
        console.log(`[VERIFY-SWU] REJECTED: best of ${results.length} candidate(s) scored ` +
          `${bestScore} against a floor of ${MIN_SCORE} for "${card.name}" — not verifying off the first hit`);
        return null;
      }
      countPriceMatch(SOURCE, 'matched');
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
