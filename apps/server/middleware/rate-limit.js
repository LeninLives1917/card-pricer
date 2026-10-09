// apps/server/middleware/rate-limit.js
// Owner: A1 | Slice: S5
//
// identifyLimiter (60/min) + quoteLeadLimiter (10/hour) — verbatim configs
// from V1 server.js:43-58.
//
// trust proxy = 1 is set on the Express app itself in apps/server/index.js
// (V2_AUDIT §5.11) — required for express-rate-limit to bucket per real
// client IP behind Render's edge proxy.
//
// ONE LIMITER PER JOB (7 Oct 2026).
//
// quoteLeadLimiter used to be mounted on the email step AND on the two public
// lookup routes the quote page calls once per card. One instance is one
// counter, so a customer spent 2 requests per card out of a 10-per-hour
// budget, and the email step, which runs last, was the one refused once they
// had 5 cards. The prices stay blurred until that step succeeds, so the quote
// was lost. Reproduced with these exact versions (express 4.22.1,
// express-rate-limit 8.3.2): 4 cards submit, 5 cards are refused.
//
// Now each job has its own counter, and every refusal is counted
// (infra/observability/quote-batch-counters.js) so it shows in /api/health.

import rateLimit from 'express-rate-limit';
import { countRateLimited } from '../../../infra/observability/quote-batch-counters.js';

export const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many identify requests — slow down.' }
});

/** Send the configured message, after counting the refusal. */
function countedHandler(name) {
  return (req, res, next, options) => {
    countRateLimited(name);
    res.status(options.statusCode).send(options.message);
  };
}

/** The email step: one per finished quote. Unchanged at 10/hour. */
export const quoteLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests — please try again later.' },
  handler: countedHandler('quote_lead'),
});

/**
 * The per-card public routes (/api/v2/quote/identify-manual, /api/v2/quote/price),
 * still used by the quote page for games other than Pokémon. Two calls per card,
 * 20 cards per list, so 120/hour covers a few lists with retries.
 */
export const quoteLookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many card lookups — please try again in a little while.' },
  handler: countedHandler('quote_lookup'),
});

/**
 * The whole-list quote: ONE request per list, matched and priced locally with
 * no outside calls, so this counts quotes rather than cards.
 */
export const quoteBatchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quotes from this connection — please try again in a little while.' },
  handler: countedHandler('quote_batch'),
});

/**
 * Show mode (trade-show QR page): one submission per customer list. A show
 * hall's WiFi puts many customers behind one address, so this is generous;
 * it only stops a script filling the staff board.
 */
export const showSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lists from this connection. Please ask at the counter.' },
  handler: countedHandler('show_submit'),
});
