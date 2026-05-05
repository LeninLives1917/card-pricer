// apps/server/middleware/rate-limit.js
// Owner: A1 | Slice: S5
//
// identifyLimiter (60/min) + quoteLeadLimiter (10/hour) — verbatim configs
// from V1 server.js:43-58.
//
// trust proxy = 1 is set on the Express app itself in apps/server/index.js
// (V2_AUDIT §5.11) — required for express-rate-limit to bucket per real
// client IP behind Render's edge proxy.

import rateLimit from 'express-rate-limit';

export const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many identify requests — slow down.' }
});

export const quoteLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests — please try again later.' }
});
