// apps/quote/modules/lookup.js
// Owner: A5 | Slice: S8 — updated S8.5 (anonymous-customer 401 fix).
//
// Sequential identify-manual + price loop for the customer quote. Mirrors
// V1 startProcessing() in public/quote.html lines 501-591 (V2_AUDIT §1c).
//
// S8.5 NOTE: this module USED to call /api/identify-manual + /api/price,
// both of which carry requireAuth. Anonymous customers hitting /quote
// always got 401 from both, and the page silently rendered "None of the
// N card(s) could be priced". The fix is the new public V2 paths
// /api/v2/quote/identify-manual and /api/v2/quote/price (added in
// apps/server/routes/identify.js + price.js — same handler bodies, no
// auth, gated by quoteLeadLimiter 10/hr per IP). See S8.5 report for
// the full carve-out rationale.
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
      const idResp = await request('/api/v2/quote/identify-manual', {
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

      // S8.5: was /api/price (requireAuth, returned 401 for anonymous
      // customers); now uses the public /api/v2/quote/price carve-out
      // gated by quoteLeadLimiter. Same response shape.
      const priceResp = await request('/api/v2/quote/price', {
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
