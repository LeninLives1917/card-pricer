// apps/quote/modules/lookup.js
// Owner: A5 | Slice: S8
//
// Sequential identify-manual + price loop for the customer quote. Mirrors
// V1 startProcessing() in public/quote.html lines 501-591 (V2_AUDIT §1c).
//
// Sequential by design (NOT parallel) — preserves rate-limit safety + lets
// the progress bar tick after every completed lookup.
//
// On per-line error: push {error, line} into results and continue. The UI
// renders error rows inline; the email gate later rejects if no priced
// rows exist.

import { buildCardmarketUrl } from './cardmarket-url.js';
import { calcCardOffers } from './totals.js';

/**
 * @typedef {Object} LookupOk
 * @property {object} card
 * @property {number} market
 * @property {number} cash
 * @property {number} credit
 * @property {string|null} cardmarket_url
 *
 * @typedef {Object} LookupErr
 * @property {string} error
 * @property {string} line
 *
 * @typedef {LookupOk | LookupErr} LookupResult
 */

/**
 * Run identify-manual + price for each parsed line, sequentially.
 *
 * @param {object} args
 * @param {Array<{set_code:string, card_number:string, name:string, raw:string}>} args.lines
 * @param {string} args.game
 * @param {number} args.cashPct
 * @param {number} args.creditPct
 * @param {(path:string, opts:object)=>Promise<{ok:boolean, status:number, body:any}>} args.request
 * @param {(done:number, total:number)=>void} [args.onProgress]
 * @returns {Promise<LookupResult[]>}
 */
export async function runLookup({ lines, game, cashPct, creditPct, request, onProgress }) {
  const results = [];
  const total = lines.length;
  let done = 0;

  if (typeof onProgress === 'function') onProgress(done, total);

  for (const entry of lines) {
    try {
      const idResp = await request('/api/identify-manual', {
        method: 'POST',
        body: {
          game,
          set_code: entry.set_code,
          card_number: entry.card_number,
          name: entry.name || undefined,
        },
      });

      if (!idResp.ok) {
        const msg = idResp.body?.error || `Not found (HTTP ${idResp.status})`;
        throw new Error(msg);
      }

      const cards = idResp.body?.cards || [];
      if (!cards.length) throw new Error('Card not found');

      const card = cards[0];

      // /api/price requires auth too (audit §1a). The customer is anonymous;
      // we still attempt the call so the UX matches V1 verbatim. If the
      // request errors out we fall through to the catch block and push an
      // error row, which is the same observable behaviour V1 produced when
      // /api/price returned 401.
      const priceResp = await request('/api/price', {
        method: 'POST',
        body: { card, buyPercentage: cashPct },
      });
      const priced = priceResp.ok ? priceResp.body : null;

      const mv =
        priced?.market_value ||
        priced?.buy_price?.market_value ||
        priced?.cardmarket?.price ||
        priced?.cardmarket?.trend ||
        0;

      const finalCard = priced?.card || card;
      const offers = calcCardOffers(mv, finalCard.condition_estimate, cashPct, creditPct);
      const cardmarket_url = buildCardmarketUrl(finalCard);

      results.push({
        card: finalCard,
        market: offers.market,
        cash: offers.cash,
        credit: offers.credit,
        cardmarket_url,
      });
    } catch (e) {
      // V1 logs to console.warn; preserved so existing debugging surface
      // (browser devtools) still shows the same line.
      console.warn('[QUOTE] Error for', entry.raw, ':', e?.message || e);
      results.push({ error: e?.message || 'Lookup failed', line: entry.raw });
    }

    done++;
    if (typeof onProgress === 'function') onProgress(done, total);
  }

  return results;
}
