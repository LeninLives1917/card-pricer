// apps/server/routes/health.js
// Owner: A1 (S5) + A8 (S14) | Slice: S14 extends with /api/version + /api/widget/loaded.
//
// GET  /api/health           — V1, public health endpoint. Preserved verbatim.
// GET  /api/version          — V2, NEW. Returns { git_sha, built_at, node_version, uptime_s, env }.
// POST /api/widget/loaded    — V2, NEW. Telemetry beacon from widget.js. 200 ack + counter.
//   Body: { shop, version, theme, position }
//   shop is validated as a slug ([a-z0-9-]{3,40}). Other fields are coerced
//   to short strings to bound metric label cardinality.

import express from 'express';
import { widget_loaded_total } from '../../../infra/observability/metrics.js';
import { supabase } from '../_clients.js';
import { getCardDbState, getCatalogueBuiltAt } from '../_card-db-boot.js';
import { getFastPathCounts } from '../../../infra/observability/fast-path-counters.js';

const router = express.Router();

// Supabase liveness, cached. A real query rather than an env-var check: the
// project was once found PAUSED while this endpoint reported has_supabase:true,
// because both variables were set and the database was simply gone. Presence of
// a credential says nothing about whether the thing it opens still exists.
const LIVENESS_TTL_MS = 60_000;
let _dbLiveness = { at: 0, ok: null, detail: 'not checked' };

async function supabaseLiveness() {
  if (!supabase) return { ok: false, detail: 'client not configured' };
  if (Date.now() - _dbLiveness.at < LIVENESS_TTL_MS) return _dbLiveness;
  try {
    const { error } = await supabase.from('card_prices').select('set_id').limit(1);
    _dbLiveness = error
      ? { at: Date.now(), ok: false, detail: error.message }
      : { at: Date.now(), ok: true, detail: 'query ok' };
  } catch (err) {
    _dbLiveness = { at: Date.now(), ok: false, detail: err.message };
  }
  return _dbLiveness;
}

const daysSince = ms => (ms ? (Date.now() - ms) / 86_400_000 : null);

// A catalogue older than a release cycle is very likely missing whatever the
// shop is actually selling — sets ship roughly every six weeks.
const CATALOGUE_STALE_DAYS = 21;

/**
 * Build the health payload. Exported and dependency-injected (same convention
 * as handleQuoteLead) so the degraded paths can be tested without
 * --experimental-test-module-mocks — a health check nobody can exercise is how
 * this endpoint came to report a paused database as healthy in the first place.
 *
 * @param {object} [deps]
 * @param {() => Promise<{ok: boolean, detail: string}>} [deps.db] liveness probe
 * @param {() => object} [deps.cardDb] card-db state accessor
 * @param {object} [deps.env]
 */
export async function buildHealthPayload(deps = {}) {
  const env = deps.env ?? process.env;
  const probeDb = deps.db ?? supabaseLiveness;
  const readCardDb = deps.cardDb ?? safeCardDbState;
  const readFastPath = deps.fastPath ?? getFastPathCounts;

  // Flat boolean keys consumed by the V2 admin tab (apps/vendor/modules/tabs/admin.js).
  // V1 nested `apis.*` shape is preserved alongside for backward compat with any
  // older surface still reading it.
  const has_anthropic_key = !!env.ANTHROPIC_API_KEY;
  const has_stripe   = !!env.STRIPE_SECRET_KEY;
  const has_ebay     = !!(env.EBAY_APP_ID && env.EBAY_CERT_ID);
  const has_justtcg  = !!env.JUSTTCG_API_KEY;
  const has_rapidapi = !!env.RAPIDAPI_KEY;

  const db = await probeDb();

  // has_supabase now means "reachable", not "two env vars are set". The weaker
  // meaning is what let a paused project read as healthy for weeks.
  const has_supabase = db.ok === true;

  // Never let catalogue introspection be the thing that breaks the health
  // check. A 500 here tells the operator nothing about what actually failed.
  let cardDb;
  try {
    cardDb = readCardDb() || {};
  } catch {
    cardDb = { ready: false, count: 0, built_at: null, download: null };
  }
  const catalogueAge = daysSince(cardDb.built_at);

  // A crawl that failed halfway still calls saveCardDbToFile(), so the file's
  // mtime looks fresh while the catalogue is short. Age alone cannot see that;
  // the download's own completeness flag can.
  const incomplete = cardDb.download && cardDb.download.complete === false;

  const checks = {
    supabase: {
      ok: has_supabase,
      detail: db.detail,
      configured: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    },
    catalogue: {
      // An UNKNOWN age is not a passing age. Reporting "can't tell" as healthy
      // is the exact shape that hid an 87-day-old catalogue behind the word
      // "fresh". This self-clears as soon as a crawl completes and stamps.
      ok: cardDb.ready && cardDb.count > 0 && !incomplete &&
          catalogueAge !== null && catalogueAge <= CATALOGUE_STALE_DAYS,
      ready: cardDb.ready,
      cards: cardDb.count,
      age_days: catalogueAge === null ? null : Number(catalogueAge.toFixed(1)),
      // A crawl that partly failed still produces a file. The download stats
      // record whether it actually completed, which "the file exists" cannot.
      last_download: cardDb.download || null,
      detail: !cardDb.ready
        ? 'catalogue not loaded'
        : cardDb.count === 0
        ? 'catalogue empty'
        : incomplete
        ? `last crawl INCOMPLETE — ${cardDb.download.cards}/${cardDb.download.expected} ` +
          `cards, ${cardDb.download.pagesFailed} page(s) failed`
        : catalogueAge === null
        ? 'age UNKNOWN — no completed crawl on record; a refresh should be running'
        : catalogueAge > CATALOGUE_STALE_DAYS
          ? `stale — ${catalogueAge.toFixed(0)}d old, a set has likely released since`
          : 'fresh',
    },
    fast_path: fastPathCheck(readFastPath()),
  };

  // Degraded, not down: the scanner still answers via the vision fallback, so
  // this must not return a non-2xx and take the service out of the load
  // balancer. It reports the problem; it does not perform surgery.
  const failing = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);

  return {
    status: failing.length ? 'degraded' : 'ok',
    degraded: failing,
    ts: Date.now(),
    uptime: process.uptime(),
    checks,
    apis: {
      anthropic: has_anthropic_key,
      cardmarket: true,
      ebay: has_ebay,
      scryfall: true,
      pokemontcg: true,
    },
    has_anthropic_key,
    has_supabase,
    has_stripe,
    has_ebay,
    has_justtcg,
    has_rapidapi,
  };
}

router.get('/api/health', async (req, res) => {
  // Always 200, even degraded. The vision fallback works without Supabase, so a
  // non-2xx here would evict a still-useful instance from rotation. The verdict
  // lives in the body.
  try {
    res.json(await buildHealthPayload());
  } catch (err) {
    res.json({ status: 'degraded', degraded: ['health'], ts: Date.now(),
      error: err.message });
  }
});

// Below this many attempts, a 0% hit rate is noise rather than evidence — a
// freshly restarted instance has not been asked enough times to prove anything.
const FAST_PATH_MIN_SAMPLE = 50;

/**
 * The fast path is the whole point of V3, and its failure mode is silence: it
 * simply falls through to the vision model and nobody can tell that from never
 * having been asked. So the check is a ratio, not a count — `attempted`
 * climbing while `hit` stays at zero is a dead fast path.
 */
function fastPathCheck(c) {
  if (!c || c.attempted < FAST_PATH_MIN_SAMPLE) {
    return {
      ok: true, ...c,
      detail: `only ${c?.attempted ?? 0} attempt(s) — too few to judge ` +
        `(need ${FAST_PATH_MIN_SAMPLE})`,
    };
  }
  if (c.hit === 0) {
    return { ok: false, ...c,
      detail: `DEAD — ${c.attempted} attempts, 0 hits. This is the state it sat ` +
        'in for months: check the index is populated and CARD_RECTIFY=1' };
  }
  // A high unusable rate is a different, cheaper problem: the index is right
  // and the answer is being discarded for want of a reference image.
  if (c.unusable_rate > 0.2) {
    return { ok: false, ...c,
      detail: `${(c.unusable_rate * 100).toFixed(0)}% of hits discarded for a ` +
        'missing reference_image — the index is correct, CARD_DB is not enriched' };
  }
  return { ok: true, ...c,
    detail: `${(c.hit_rate * 100).toFixed(1)}% hit rate over ${c.attempted} attempts` };
}

// The health endpoint must never be the thing that breaks. If card-db state is
// unavailable for any reason, report it as unknown rather than throwing.
function safeCardDbState() {
  try {
    const s = getCardDbState() || {};
    // Age comes from the stamp written by a COMPLETED crawl, never from
    // card-db.json's mtime. initCardDb() re-saves that file on every boot and
    // the dirty-save interval rewrites it every 5 minutes, so its mtime said
    // "0 days old" on an 87-day-old catalogue and this check reported "fresh"
    // for a catalogue that could not refresh. Same source of truth as
    // maybeRefreshStaleCatalogue(), so the two can never disagree.
    let built_at = null;
    try { built_at = getCatalogueBuiltAt(); } catch { /* age stays unknown */ }

    return {
      count: Number(s.count) || 0,
      ready: s.ready === true,
      built_at,
      download: s.download || null,
    };
  } catch {
    return { count: 0, ready: false, built_at: null, download: null };
  }
}

// ----- /api/version -----
router.get('/api/version', (req, res) => {
  res.json({
    git_sha: process.env.GIT_SHA || 'unknown',
    built_at: process.env.BUILT_AT || null,
    node_version: process.version,
    uptime_s: Math.round(process.uptime()),
    env: process.env.NODE_ENV || 'development',
  });
});

// ----- /api/widget/loaded -----
const SHOP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function shortLabel(v, max = 32) {
  if (typeof v !== 'string') return 'unknown';
  const trimmed = v.trim();
  if (!trimmed) return 'unknown';
  // Restrict to safe chars + bound length so metric label cardinality is
  // contained even if a malicious caller posts garbage.
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, max);
}

router.post('/api/widget/loaded', (req, res) => {
  const body = req.body || {};
  const shopRaw = typeof body.shop === 'string' ? body.shop.toLowerCase().trim() : '';
  if (!shopRaw || !SHOP_SLUG_RE.test(shopRaw)) {
    return res.status(400).json({ error: 'invalid shop slug' });
  }
  const version = shortLabel(body.version, 16);
  const theme = shortLabel(body.theme, 16);
  const position = shortLabel(body.position, 24);

  try {
    widget_loaded_total.inc({ shop: shopRaw, version, theme });
  } catch {
    // Never let metric collection take down a request.
  }

  // Lightweight log — Render captures, Sentry doesn't.
  console.log(`[widget] loaded shop=${shopRaw} version=${version} theme=${theme} position=${position}`);

  res.status(200).json({ ok: true });
});

export default router;
