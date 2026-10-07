// Regression: a customer with 5 cards could not get a quote.
//
// INCIDENT (found 6 Oct 2026, fixed 7 Oct 2026). quoteLeadLimiter (10/hour)
// was ONE instance mounted on the email step AND on the two public lookup
// routes the quote page calls once per card. One instance is one counter, so
// N cards cost 2N lookups + 1 email submit from the same 10. With 5 cards the
// email step was the 11th request and got a 429; the prices stay blurred until
// that step succeeds, so the customer never saw their quote, and nothing
// counted it. Reproduced with the locked versions (express 4.22.1,
// express-rate-limit 8.3.2): 4 cards submit, 5 are refused.
//
// This spec mounts the REAL routers and replays the page's exact sequence.
// Verified to FAIL against the shared-limiter code (the 11th request was 429).

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import identifyRouter from '../../apps/server/routes/identify.js';
import priceRouter from '../../apps/server/routes/price.js';
import quoteLeadRouter from '../../apps/server/routes/quote-lead.js';

async function withApp(fn) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(identifyRouter);
  app.use(priceRouter);
  app.use(quoteLeadRouter);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const post = (base, path, ip) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  // Empty bodies: every route rejects them with a fast 400 before doing any
  // work, which is all this needs. The limiter runs first either way.
  body: '{}',
}).then((r) => r.status);

test('a customer with 5 cards reaches the email step (was refused: shared limiter)', async () => {
  await withApp(async (base) => {
    const ip = '198.51.100.5';
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(await post(base, '/api/v2/quote/identify-manual', ip));
      statuses.push(await post(base, '/api/v2/quote/price', ip));
    }
    const email = await post(base, '/api/quote-lead', ip);
    assert.ok(!statuses.includes(429), `no lookup refused, got ${statuses.join(',')}`);
    assert.notEqual(email, 429, 'the email step must not be starved by per-card lookups');
  });
});

test('a 20-card list (the old page cap) gets through lookups and the email step', async () => {
  await withApp(async (base) => {
    const ip = '198.51.100.20';
    let refused = 0;
    for (let i = 0; i < 20; i += 1) {
      if (await post(base, '/api/v2/quote/identify-manual', ip) === 429) refused += 1;
      if (await post(base, '/api/v2/quote/price', ip) === 429) refused += 1;
    }
    assert.equal(refused, 0);
    assert.notEqual(await post(base, '/api/quote-lead', ip), 429);
  });
});

test('the email step still has its own limit (10/hour per IP)', async () => {
  await withApp(async (base) => {
    const ip = '198.51.100.99';
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push(await post(base, '/api/quote-lead', ip));
    assert.equal(statuses.filter((s) => s === 429).length, 1, 'the 11th lead in an hour is refused');
  });
});
