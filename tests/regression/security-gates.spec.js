// tests/regression/security-gates.spec.js
// Owner: A7 | Slice: S26 (final regression backfill)
//
// Backfills RG-NN entries from docs/V2_ARCHITECTURE.md §7.1 that earlier
// slices did not author explicitly. Everything here is static-grep /
// router-stack inspection — no Express boot, no Supabase, no Anthropic.
//
//   RG-22: app.set('trust proxy', 1) is set on the Express app
//   RG-23: /api/correct-card has requireAuth in its middleware chain
//   RG-24: /api/card-db-rebuild + /api/card-db-import-unreliable both
//          carry requireAuth + requireAdmin
//   RG-25: scanner-mode bypass intact in apps/vendor/modules/auth.js
//          (?pair=... short-circuits before Supabase session check)
//   RG-26: per-game verify exists for every game listed in
//          CARD_ID_SYSTEM_PROMPT (or there is an explicit generic fallback)
//   RG-18: apps/vendor/service-worker.js's CACHE_VERSION was bumped past
//          the V1 sentinel ('cardpricer-v60')
//
// These tests are intentionally cheap: they read source files and walk
// router stacks. If any of them ever fail, a sub-agent has silently
// undone a load-bearing security fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

// ── Helper: walk an Express router stack and return a route's middleware
// chain (the `.handle` of every layer in `route.stack`, in order).
function findRoute(router, method, path) {
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    if (layer.route.path !== path) continue;
    const m = layer.route.methods?.[method.toLowerCase()];
    if (!m) continue;
    return { handlers: layer.route.stack.map(s => s.handle) };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// RG-22: trust proxy = 1 on the Express app
// ────────────────────────────────────────────────────────────────────
test('RG-22: apps/server/index.js sets trust proxy = 1', () => {
  const src = fs.readFileSync(join(REPO_ROOT, 'apps/server/index.js'), 'utf8');
  // Match either single or double quotes, and a literal 1 (the only safe
  // value for Render's single edge proxy — see V2_AUDIT §5.11 / R-rate).
  assert.match(
    src,
    /app\.set\(\s*['"]trust proxy['"]\s*,\s*1\s*\)/,
    'expected app.set(\'trust proxy\', 1) — required for express-rate-limit per-IP buckets behind Render'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-23: /api/correct-card requires auth (V1 1309ccd security fix)
// ────────────────────────────────────────────────────────────────────
test('RG-23: /api/correct-card has requireAuth in its middleware chain', async () => {
  const { default: identifyRouter } = await import('../../apps/server/routes/identify.js');
  const { requireAuth } = await import('../../apps/server/middleware/auth.js');

  const route = findRoute(identifyRouter, 'POST', '/api/correct-card');
  assert.ok(route, 'POST /api/correct-card must be mounted');
  assert.ok(
    route.handlers.includes(requireAuth),
    'POST /api/correct-card MUST go through requireAuth — V2_AUDIT §5.24 fix preserved'
  );
});

// ────────────────────────────────────────────────────────────────────
// RG-24: /api/card-db-rebuild + /api/card-db-import-unreliable need
// requireAuth AND requireAdmin (the V1 1309ccd fix preserved).
// ────────────────────────────────────────────────────────────────────
test('RG-24: /api/card-db-rebuild requires auth + admin', async () => {
  const { default: cardDbRouter } = await import('../../apps/server/routes/card-db.js');
  const { requireAuth, requireAdmin } = await import('../../apps/server/middleware/auth.js');

  const rebuild = findRoute(cardDbRouter, 'POST', '/api/card-db-rebuild');
  assert.ok(rebuild, 'POST /api/card-db-rebuild must be mounted');
  assert.ok(rebuild.handlers.includes(requireAuth),  'requireAuth missing on /api/card-db-rebuild');
  assert.ok(rebuild.handlers.includes(requireAdmin), 'requireAdmin missing on /api/card-db-rebuild');
});

test('RG-24b: /api/card-db-import-unreliable requires auth + admin', async () => {
  const { default: cardDbRouter } = await import('../../apps/server/routes/card-db.js');
  const { requireAuth, requireAdmin } = await import('../../apps/server/middleware/auth.js');

  const imp = findRoute(cardDbRouter, 'POST', '/api/card-db-import-unreliable');
  assert.ok(imp, 'POST /api/card-db-import-unreliable must be mounted');
  assert.ok(imp.handlers.includes(requireAuth),  'requireAuth missing on /api/card-db-import-unreliable');
  assert.ok(imp.handlers.includes(requireAdmin), 'requireAdmin missing on /api/card-db-import-unreliable');
});

// ────────────────────────────────────────────────────────────────────
// RG-25: scanner-mode auth bypass intact after refactor.
//
// Static grep against apps/vendor/modules/auth.js — the bypass MUST happen
// before any supabase auth call so the camera-only phone view never tries
// to authenticate. We pin both the URLSearchParams probe and the
// short-circuit return.
// ────────────────────────────────────────────────────────────────────
test('RG-25: scanner-mode (?pair=...) skips auth in apps/vendor/modules/auth.js', () => {
  const src = fs.readFileSync(join(REPO_ROOT, 'apps/vendor/modules/auth.js'), 'utf8');

  // The probe must read the URL ?pair= param via URLSearchParams.has('pair').
  assert.match(
    src,
    /URLSearchParams\(\s*location\.search\s*\)\s*\.has\(\s*['"]pair['"]\s*\)/,
    'scanner-mode probe (URLSearchParams(...).has("pair")) must be present'
  );

  // The short-circuit return must come BEFORE getSession is called. We
  // approximate "before" by index-of: the bypass return must appear
  // earlier in the file than the first sb.auth.getSession() call.
  const probeIdx   = src.search(/URLSearchParams\(\s*location\.search/);
  const sessionIdx = src.search(/sb\.auth\.getSession\(\)/);
  assert.ok(probeIdx >= 0 && sessionIdx >= 0,
    'expected both the scanner-mode probe and a session check in auth.js');
  assert.ok(probeIdx < sessionIdx,
    'scanner-mode bypass must short-circuit BEFORE sb.auth.getSession() — V2_AUDIT §5.14');
});

// ────────────────────────────────────────────────────────────────────
// RG-26: per-game verify exists for every game V1 already verified.
//
// The system prompt's `game` enum is BROADER than what V1's verifyCard
// switch dispatches on (V1 server.js:3129-3145 covers 9 games; the prompt
// also lists weiss + cardfight, which V1 silently lets pass through with
// verified:false — pre-existing behaviour, not a V2 regression).
//
// This test pins V2 PARITY with V1 — every case-arm V1 had must still
// exist in apps/server's pricing/verify.js. The "weiss/cardfight have
// no verifier" gap is documented in V2_SMOKE_TEST.md §6 and tracked as
// a V2.1 follow-up rather than a ship blocker.
// ────────────────────────────────────────────────────────────────────
test('RG-26: pricing/verify.js dispatches every game V1 already verified', () => {
  const verifySrc = fs.readFileSync(join(REPO_ROOT, 'pricing/verify.js'), 'utf8');

  // V1 server.js:3129-3145 — the canonical list V2 must keep parity with.
  const v1Games = [
    'pokemon', 'magic', 'starwars', 'yugioh',
    'onepiece', 'lorcana', 'digimon', 'fleshandblood', 'dragonball',
  ];

  const missing = [];
  for (const g of v1Games) {
    const re = new RegExp(`case\\s+['"]${g}['"]\\s*:`);
    if (!re.test(verifySrc)) missing.push(g);
  }
  assert.deepEqual(
    missing,
    [],
    `pricing/verify.js is missing V1-parity case-arms for: ${missing.join(', ')}\n` +
    `Every game V1's verifyCard switch dispatched on must still dispatch in ` +
    `V2 — silent fall-through means the AI's identification goes out unverified.`
  );
});

test('RG-26b: weiss/cardfight have no verifier in V1 OR V2 — documented gap, not a regression', () => {
  // Sanity-pin the documented gap so a future contributor doesn't
  // "fix" the V1-parity test above by adding a verifyWeiss stub
  // without thinking through what verifyWeiss would actually do.
  const verifySrc = fs.readFileSync(join(REPO_ROOT, 'pricing/verify.js'), 'utf8');
  assert.doesNotMatch(verifySrc, /verifyWeiss\b/,
    'verifyWeiss not implemented — see V2_SMOKE_TEST.md §6 for the V2.1 follow-up');
  assert.doesNotMatch(verifySrc, /verifyCardfight\b/,
    'verifyCardfight not implemented — same gap as weiss');
});

// ────────────────────────────────────────────────────────────────────
// RG-18: service-worker cache version bumped.
//
// V1 (public/service-worker.js) shipped 'cardpricer-v60'. The V2 vendor
// app at apps/vendor/service-worker.js MUST advertise a different
// CACHE_VERSION or browsers keep serving stale V1 HTML.
// ────────────────────────────────────────────────────────────────────
test('RG-18: apps/vendor/service-worker.js bumps CACHE_VERSION past V1', () => {
  const src = fs.readFileSync(
    join(REPO_ROOT, 'apps/vendor/service-worker.js'),
    'utf8'
  );

  const m = src.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(m, 'apps/vendor/service-worker.js must declare CACHE_VERSION');
  const v2Version = m[1];

  // The V1 sentinel value — we MUST NOT still ship this in V2.
  assert.notEqual(
    v2Version,
    'cardpricer-v60',
    'V2 service-worker still advertises the V1 cache version — bump it ' +
    'or users keep seeing the V1 shell from cache (V2_AUDIT §5.8 / R7).'
  );
  // Sanity check: the version string follows the documented prefix.
  assert.match(
    v2Version,
    /^cardpricer-/,
    'CACHE_VERSION should retain the "cardpricer-" prefix for grep-ability'
  );
});
