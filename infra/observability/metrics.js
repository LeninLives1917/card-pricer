// infra/observability/metrics.js
// Owner: A8 | Slice: S4 (skeleton) → S14 (mounted by A1 at /api/metrics)
//
// prom-client metrics for the Card-Pricer V2 service.
//
// Per docs/V2_ARCHITECTURE.md §2.5 — /api/metrics is a NEW endpoint exposed
// behind requireAdmin (or a separate token in S14). Default registry is used
// so Node's collectDefaultMetrics() rolls up process / GC / event-loop stats
// alongside the application counters below.
//
// USAGE (route handler in apps/server/routes/health.js):
//     import { register, identifyTotal, priceLatencyMs, cardDbSize } from
//       '../../infra/observability/metrics.js';
//
//     router.get('/api/metrics', requireAdmin, async (req, res) => {
//       res.set('Content-Type', register.contentType);
//       res.end(await register.metrics());
//     });
//
//     // anywhere identify completes:
//     identifyTotal.inc({ result: 'verified', game: card.game });
//
//     // around a /api/price call:
//     const stop = priceLatencyMs.startTimer({ source: 'tcggo' });
//     // ... do work ...
//     stop();
//
//     // when CARD_DB Map is mutated:
//     cardDbSize.set(CARD_DB.size);
//
// NOTE FOR S5 OWNER (A1): prom-client is NOT yet declared in
// package.json. Add it when wiring this into the server bootstrap:
//     npm install prom-client
// Until then, importing this module will throw at module-load time.

import client from 'prom-client';

// Use the default registry so collectDefaultMetrics piggybacks onto the
// same /api/metrics output without a second registration pass.
const register = client.register;

// Process / GC / event-loop / Node-native metrics. Cheap, runs once.
client.collectDefaultMetrics({
  register,
  prefix: 'cardpricer_',
});

/**
 * Total identify attempts, broken down by outcome and game.
 * Labels:
 *   - result:   'verified' | 'rejected' | 'timeout' | 'error' | 'cache_hit'
 *   - game:     'pokemon' | 'magic' | 'yugioh' | 'lorcana' | 'starwars' | 'unknown'
 *   - endpoint: 'identify' | 'identify-stream' | 'identify-manual' | 'ocr-first'
 */
const identifyTotal = new client.Counter({
  name: 'identify_total',
  help: 'Total /api/identify* attempts, by result and game',
  labelNames: ['result', 'game', 'endpoint'],
  registers: [register],
});

/**
 * Latency of /api/price fan-out per source.
 * Buckets chosen to span the realistic price-call envelope: a JustTCG hot
 * cache hit (~100ms) up to an eBay sold-comps fan-out under load (~10s).
 */
const priceLatencyMs = new client.Histogram({
  name: 'price_latency_ms',
  help: 'Latency of pricing-engine source calls in milliseconds',
  labelNames: ['source', 'game', 'cache'],
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

/**
 * Current size of the in-memory CARD_DB Map. Updated by db/card-db/store.js
 * on every add/replace; used to alert on a sudden drop (corruption, Pokellector
 * corrections being stomped, etc.).
 */
const cardDbSize = new client.Gauge({
  name: 'card_db_size',
  help: 'Number of card entries currently in the in-memory CARD_DB',
  registers: [register],
});

export { register, identifyTotal, priceLatencyMs, cardDbSize };
