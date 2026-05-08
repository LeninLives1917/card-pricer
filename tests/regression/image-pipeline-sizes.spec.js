// tests/regression/image-pipeline-sizes.spec.js
//
// RG-20: Image pipeline sizes preserved across client + server.
//
// Client bulk-upload: 2400px @ q0.95   (apps/vendor/modules/bulk.js:143)
// Server single-card: 1800px @ q92     (pricing/identify-core.js:251-252)
//
// Historical: a resizeDataUrl positional-args bug butchered single-card
// scans to ~700px before being caught. See memory/image_pipeline.md.
//
// NOTE — two constants listed in docs/V2_SMOKE_TEST.md §6 RG-20 are NOT
// present in V2 and are therefore not pinned here:
//   "Client single-card: 2000px" — scan.js has no resize code; the
//     scanner-mode phone path (pair.js uploadRawScanToRoom) posts the raw
//     readAsDataURL result with no resize. No 2000px constant exists in V2.
//   "Server batch: 2200px" — server.js:1102 comment explicitly says
//     "Binder/batch mode was removed"; identify-core.js uses a single
//     1800px path for all server-side resizes. No 2200px constant in V2.
// These gaps are NOT regressions; they reflect V2's simpler pipeline.
// If a future slice adds client single-card resize or server batch resize,
// add the corresponding tests here and remove this note.
//
// Files pinned:
//   apps/vendor/modules/bulk.js  — client resize helper + bulk ingest
//   pricing/identify-core.js     — server identifyCore

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

// ── Client file: apps/vendor/modules/bulk.js ────────────────────────────────
//
// Line 143 (at time of authoring):
//   uploadUrl = await resizeDataUrl(rawUrl, { maxDimension: 2400, quality: 0.95 });
//
// The regex matches the named-argument call-site. Tolerant of whitespace and
// argument-order variance within the options object, but specific enough that
// a drift to any other maxDimension or quality value fails the test.

const BULK_SRC = fs.readFileSync(
  join(REPO_ROOT, 'apps/vendor/modules/bulk.js'),
  'utf8'
);

// ── Server file: pricing/identify-core.js ───────────────────────────────────
//
// Lines 251-252 (at time of authoring):
//   const targetSize = 1800;
//   const jpegQuality = 92;
//
// Both are local const declarations inside identifyCore. The regex matches
// the assignment. Tolerant of const/let and whitespace; specific to the value.

const SERVER_SRC = fs.readFileSync(
  join(REPO_ROOT, 'pricing/identify-core.js'),
  'utf8'
);

// ── Tests ────────────────────────────────────────────────────────────────────

test('RG-20: client bulk-upload resize caps maxDimension at 2400px', () => {
  assert.match(
    BULK_SRC,
    /maxDimension\s*:\s*2400\b/,
    'apps/vendor/modules/bulk.js must pass maxDimension: 2400 to resizeDataUrl ' +
    'for bulk uploads — drift here silently degrades image quality sent to the server.'
  );
});

test('RG-20: client bulk-upload resize uses quality 0.95', () => {
  // Matches `quality: 0.95` within the same resizeDataUrl call block.
  // The guard in resizeDataUrl itself (line ~53) also tests `quality >= 0.95`
  // which also matches this pattern — both are intentional pins.
  assert.match(
    BULK_SRC,
    /quality\s*:\s*0\.95\b/,
    'apps/vendor/modules/bulk.js must pass quality: 0.95 to resizeDataUrl ' +
    'for bulk uploads — lowering this degrades the JPEG sent to Anthropic.'
  );
});

test('RG-20: server identifyCore single-card resize target is 1800px', () => {
  assert.match(
    SERVER_SRC,
    /(?:const|let)\s+targetSize\s*=\s*1800\b/,
    'pricing/identify-core.js must declare targetSize = 1800 in identifyCore — ' +
    'drift here changes what Anthropic Vision receives (historical 700px bug guard).'
  );
});

test('RG-20: server identifyCore JPEG quality is 92', () => {
  assert.match(
    SERVER_SRC,
    /(?:const|let)\s+jpegQuality\s*=\s*92\b/,
    'pricing/identify-core.js must declare jpegQuality = 92 in identifyCore — ' +
    'drift here changes the JPEG compression level on server-side resizes.'
  );
});
