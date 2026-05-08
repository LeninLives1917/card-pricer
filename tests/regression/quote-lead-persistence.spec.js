// tests/regression/quote-lead-persistence.spec.js
// Owner: A7 | Slice: S26 (final regression backfill)
//
// RG-15 — V2_AUDIT §5.13 / R6 companion:
//   /api/quote-lead persists to quote_leads regardless of Brevo send
//   success. A Brevo outage cannot kill lead capture — the row lands
//   first, the Brevo calls happen second.
//
// The test is structural rather than a full HTTP round-trip: we read
// apps/server/routes/quote-lead.js and pin the contract that the
// quote_leads insert is reachable from the no-BREVO_API_KEY branch
// (early-return path) and that the post-S12 await ordering still
// awaits persistLead() before responding on the success path.
//
// HISTORY: V1 used a fire-and-forget persistLead() before sendOne().
// S12 (commit 1073552) reordered to "send emails, THEN persist+respond"
// so the response could include the quote_url. The audit invariant
// stays intact for the BREVO_API_KEY-absent path (early return persists
// + responds without ever attempting Brevo) and for the
// 'newsletter:off / no list' subscribe path (no email failure to
// short-circuit the persist). This test pins both.
//
// The test does NOT bring up Express; it parses the source file. A
// future operator who adds a try/catch around the email-send block to
// recover Brevo failure-then-persist will see this test continue to
// pass while gaining the additional safety net.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

const SRC = fs.readFileSync(
  join(REPO_ROOT, 'apps/server/routes/quote-lead.js'),
  'utf8'
);

test('RG-15: quote-lead.js declares the persistLead helper that hits quote_leads', () => {
  // The helper is the single source of truth for landing a row. Any
  // refactor that drops it must explicitly replace it with another
  // supabase.from('quote_leads').insert(...) call.
  assert.match(
    SRC,
    /const\s+persistLead\s*=\s*async/,
    'quote-lead.js must declare a persistLead async helper (see V2_AUDIT §5.13)'
  );
  assert.match(
    SRC,
    /supabase(?:Client)?\.from\(\s*['"]quote_leads['"]\s*\)\.insert\(/,
    'quote-lead.js must insert into quote_leads — that is the audit invariant'
  );
});

test('RG-15: no-BREVO_API_KEY early-return path persists the lead before responding', () => {
  // The early-return branch (operator forgot to set BREVO_API_KEY — or the
  // injected brevoApiKey dep is falsy) is the cleanest "Brevo not reachable"
  // smoke test the audit cares about. We pin the structure: inside the
  // `if (!brevoApiKey)` branch, persistLead is awaited BEFORE the return fires.
  //
  // NOTE: the handler was refactored (DI extraction) so the guard is now
  // `if (!brevoApiKey)` (the injected dep) rather than the literal
  // `if (!process.env.BREVO_API_KEY)`. The semantic invariant is identical.

  const branch = SRC.match(
    /if\s*\(\s*!brevoApiKey\s*\)\s*{([\s\S]*?)\n\s{2}}/
  );
  assert.ok(branch, 'expected the !brevoApiKey early-return branch in quote-lead.js');

  const body = branch[1];
  const persistIdx = body.indexOf('persistLead');
  const responseIdx = body.indexOf('return {');
  assert.ok(persistIdx >= 0,
    'no-BREVO branch must call persistLead — otherwise leads are dropped when Brevo is not configured');
  assert.ok(responseIdx >= 0,
    'no-BREVO branch must still return a response object');
  assert.ok(persistIdx < responseIdx,
    'persistLead must be awaited BEFORE return — V2_AUDIT §5.13 / R6');
});

test('RG-15: quote_leads insert carries the audit-required denormalised fields', () => {
  // V1 server.js:5380-5403 set shop_id + shop_slug + cards_json + ip_hash.
  // The audit calls these out explicitly because shop deletion can null
  // shop_id and we don't want to lose the lead-shop link forever.
  // (V2_AUDIT §1g: "shop_slug denormalised so leads survive shop deletion".)
  assert.match(SRC, /shop_id\s*:/,    'insert must carry shop_id');
  assert.match(SRC, /shop_slug\s*:/,  'insert must carry shop_slug (denormalised — see V2_AUDIT §1g)');
  assert.match(SRC, /cards_json\s*:/, 'insert must carry cards_json');
  assert.match(SRC, /ip_hash\s*:/,    'insert must carry ip_hash (daily-salted)');
});

test('RG-15: persistLead is robust to supabase failure (catches the insert error)', () => {
  // The audit invariant means a supabase blip MUST NOT take down the
  // 200 OK path either — in V2 the helper returns {id:null, persistence:'failed'}
  // instead of throwing, so the email send still fires and the customer
  // still hears back.
  assert.match(
    SRC,
    /catch\s*\(\s*e\s*\)\s*{[^}]*persistence[^}]*['"]failed['"][^}]*}/s,
    'persistLead must catch supabase errors and degrade gracefully — V2_AUDIT §5.13'
  );
});

test('RG-15: happy path persists the lead BEFORE attempting Brevo send (V2.0.1 fix)', () => {
  // S12 (commit 1073552) originally reordered to "send emails first, then
  // persist + respond" so the response could include the quote_url. S26
  // caught that this violated V2_AUDIT §5.13 — a Brevo throw skipped
  // persistLead entirely. V2.0.1 (this commit) restores the V1 fire-
  // persist-first contract:
  //
  //   const lead = await persistLead()
  //   const quote_url = buildQuoteUrl(lead.id)
  //   try {
  //     await Promise.all([sendOne, sendOne, subscribeIfOptedIn])
  //     emailed = true
  //   } catch (brevoErr) { /* lead is already persisted */ }
  //   res.json({ ok:true, emailed, quote_id, quote_url, ... })
  //
  // Now a Brevo outage cannot kill lead capture on ANY path (the no-
  // BREVO branch was already correct; the BREVO-configured branch is
  // newly correct).

  // Pin: persistLead is awaited BEFORE Promise.all on the happy path.
  const happyOrdering = SRC.match(
    /const\s+lead\s*=\s*await\s+persistLead\(\)[\s\S]*?await\s+Promise\.all\(\s*\[\s*\n[\s\S]*?subscribeIfOptedIn/
  );
  assert.ok(
    happyOrdering,
    'happy path must call persistLead BEFORE Promise.all([sendOne, sendOne, subscribe]) ' +
    'so a Brevo throw cannot skip the quote_leads insert (V2_AUDIT §5.13 / R6).'
  );

  // Pin: the Promise.all is wrapped in a try/catch so a Brevo failure
  // doesn't 500 — the response degrades gracefully with emailed:false.
  assert.match(
    SRC,
    /try\s*{[\s\S]*?Promise\.all\(\s*\[\s*\n[\s\S]*?subscribeIfOptedIn[\s\S]*?\][\s\S]*?}\s*catch\s*\(\s*\w+\s*\)\s*{[\s\S]*?lead persisted/,
    'Brevo Promise.all must be inside a try/catch that logs "lead persisted" — ' +
    'graceful degradation per V2.0.1 fix.'
  );
});
