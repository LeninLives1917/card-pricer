// pricing/quote-prices/card-image.js
//
// A picture of a card for the quote's "which one is yours?" picker, by URL on
// the source's own CDN (store fingerprints, not artwork: nothing is copied).
//
// Catalogue keys are pokemontcg.io ids, so most cards are
// images.pokemontcg.io/<set>/<number>.png. Exceptions, checked by hand on
// 7 Oct 2026:
//
//   cel25c   the catalogue holds both "cel25c-4" and "cel25c-4_A"; only the
//            _A image exists. Number 15 is four different cards (Venusaur,
//            Here Comes Team Rocket!, Rocket's Zapdos, Claydol) behind two
//            images, so it gets none rather than possibly the wrong one.
//   me55     30th Celebration, added from the hub (TCGdex set "30th"):
//            assets.tcgdex.net/en/me/30th/<3-digit number>/low.webp
//   me55c    its Classic Collection: no image anywhere yet.
//
// A wrong guess costs a broken image, which the page hides, never a wrong
// price: the picture is decoration on a choice the customer makes.

const POKEMONTCG = 'https://images.pokemontcg.io';
const TCGDEX = 'https://assets.tcgdex.net/en';

/** Card numbers in cel25c shared by several different cards. */
const CEL25C_SHARED = new Set(['15']);

/**
 * @param {string} key  a catalogue key, "<set>-<number>"
 * @returns {string|null}
 */
export function cardImageUrl(key) {
  const k = String(key ?? '');
  const dash = k.lastIndexOf('-');
  if (dash < 1) return null;
  const set = k.slice(0, dash);
  const num = k.slice(dash + 1);
  if (!num || !/^[A-Za-z0-9_]+$/.test(num) || !/^[a-z0-9.]+$/i.test(set)) return null;

  if (set === 'me55c') return null;
  if (set === 'me55') {
    return /^\d+$/.test(num) ? `${TCGDEX}/me/30th/${num.padStart(3, '0')}/low.webp` : null;
  }
  if (set === 'cel25c') {
    const base = num.replace(/_.*$/, '');
    if (CEL25C_SHARED.has(base)) return null;
    return `${POKEMONTCG}/cel25c/${base}_A.png`;
  }
  return `${POKEMONTCG}/${set}/${num}.png`;
}
