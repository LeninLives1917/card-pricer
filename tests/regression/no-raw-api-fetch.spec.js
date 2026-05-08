// tests/regression/no-raw-api-fetch.spec.js
// Owner: regression-backfill
//
// No V2 client module may call the global fetch() with a bare /api/ path.
// Those calls bypass the Supabase JWT bearer attachment provided by the
// api-client.js wrappers, causing 401s (observed on binder upload). This
// is a structural guard against raw-fetch regressions; it complements
// RG-01..RG-04 (api-client surface contract in vendor-modules.spec.js).
//
// Scanned surfaces (recursive .js only — no HTML, no node_modules):
//   apps/vendor/modules/
//   apps/quote/modules/
//   apps/customer/modules/
//   apps/widget/
//
// Excluded: api-client.js files — their internal fetch() calls are the point.
//
// Pattern caught: fetch('/api/...') / fetch("/api/...") / fetch(`/api/...`)
// Pattern NOT caught: apiClient.fetch('/api/...'), obj.fetch('/api/...').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

// Matches: fetch( optionalWhitespace quote /api/
// Does NOT match method calls — requires fetch to be preceded only by
// whitespace / start-of-expression, not a dot (handled by regex boundary).
const RAW_FETCH_RE = /(?<![.\w])fetch\s*\(\s*['"`]\s*\/api\//;

/** Recursively collect .js files under dir, returning absolute paths. */
function collectJs(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJs(full));
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'api-client.js') {
      results.push(full);
    }
  }
  return results;
}

const SCAN_DIRS = [
  join(REPO_ROOT, 'apps/vendor/modules'),
  join(REPO_ROOT, 'apps/quote/modules'),
  join(REPO_ROOT, 'apps/customer/modules'),
  join(REPO_ROOT, 'apps/widget'),
];

const files = SCAN_DIRS.flatMap(collectJs);

// One test per file keeps failure output precise.
for (const filePath of files) {
  const label = filePath.replace(REPO_ROOT + '\\', '').replace(REPO_ROOT + '/', '');
  test(`no raw fetch('/api/...') in ${label}`, () => {
    const src = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      src,
      RAW_FETCH_RE,
      `Raw fetch('/api/...') found in ${filePath}. ` +
      `All /api/* calls must go through apps/vendor/modules/api-client.js ` +
      `(or the customer/quote equivalent). ` +
      `Use request/getJson/postJson/uploadMultipart instead.`
    );
  });
}
