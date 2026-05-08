// tests/regression/parse-drift.spec.js
// Owner: regression-backfill | Slice: V2.1 / S15 hand-off
//
// Detects drift between the two copies of extractCardNumber:
//   - Canonical (server): pricing/ocr-first/parse.js
//   - V1 inline (client): public/index.html lines ~4107-4188
//
// The V1 copy is NOT dead code — startLiveOCRLoop() at index.html:6742
// calls it for the live Tesseract scan feature. Source dedup would require
// a UMD shim + new static mount + V1 script injection; drift detection is
// the agreed-upon zero-infra alternative (V2.1 backlog).
//
// How the V1 function is materialised: fs.readFileSync → regex slice →
// new Function('return ' + src)(). The function is self-contained (no
// external deps in the body), so eval is safe and side-effect-free.
//
// If the two implementations return different results for ANY input in the
// battery, the test fails with a side-by-side diff so the operator can see
// which side drifted and decide how to reconcile it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractCardNumber as canonical } from '../../pricing/ocr-first/parse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');

// ── Materialise the V1 inline copy ────────────────────────────────────────────

const HTML_PATH = join(REPO_ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Locate the declaration. Fail loudly if it has been removed.
const DECL = 'function extractCardNumber(text) {';
const declIdx = html.indexOf(DECL);
assert.notEqual(
  declIdx, -1,
  `parse-drift: '${DECL}' not found in public/index.html — ` +
  'the V1 inline copy has been removed. ' +
  'Either the drift-detection test is now obsolete (delete it) ' +
  'or the removal was accidental (restore the function).',
);

// Walk forward from the declaration, counting braces, to find the matching
// closing `}`. We start counting after the opening `{` of the function body.
let depth = 0;
let endIdx = -1;
for (let i = declIdx; i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') {
    depth--;
    if (depth === 0) { endIdx = i; break; }
  }
}
assert.notEqual(endIdx, -1, 'parse-drift: could not find matching } for V1 extractCardNumber');

const fnSource = html.slice(declIdx, endIdx + 1);

// Wrap so `new Function` returns a callable reference.
// eslint-disable-next-line no-new-func
const v1 = new Function('return ' + fnSource)();
assert.equal(typeof v1, 'function', 'parse-drift: V1 source did not eval to a function');

// ── Test battery ──────────────────────────────────────────────────────────────
//
// Cases lifted from ocr-first.spec.js plus the full priority-chain set
// called out in the V2.1 backlog brief.

const CASES = [
  // --- Priority 1a: SET + LANG + SLASH ---
  'DRI EN 204/182',
  'MEW EN 173/165',

  // --- Priority 1b: SET + LANG (no slash) ---
  'MEP EN 066',
  'SVP EN 153',

  // --- Priority 2: SET + SLASH ---
  'MEP 027/198',
  'MEG 133/132',

  // --- Priority 2c: REG MARK + SLASH (regulation mark) ---
  '@ 091/197',   // @ is not a letter — should fall through to a later priority
  'F 160/159',
  'E 005/025',
  'G 123/189',

  // --- Priority 3: bare slash ---
  '204/182',
  '44/95',

  // --- Priority 4: SET + NUM ---
  'MEP 027',
  'TWM 200',
  'OBF 125',

  // --- Priority 5a: Crown Zenith Galarian Gallery ---
  'GG31/GG70',

  // --- Priority 5b: SWSH promo ---
  'SWSH066',
  'SWSH020',
  'SWSH-066',

  // --- Priority 5c: Other promos ---
  'SM211',
  'SVP 076',
  'XY99',
  'BW100',

  // --- Priority 6: One Piece ---
  'OP06-001',
  'ST01-002',
  'EB01-001',

  // --- Priority 7: Yu-Gi-Oh ---
  'ABCD-EN042',
  'DUNE-EN001',

  // --- OCR cleaning edge cases ---
  'MEP O27',      // capital O before two digits → 0 → MEP 027
  'MEP I27',      // capital I before digit → 1 → MEP 127
  'MEP l27',      // lowercase l before digit → 1 → MEP 127
  'MEP |27',      // pipe → 1 → MEP 127
  '|04/182',      // pipe-instead-of-1 in bare slash

  // --- Null / garbage ---
  '',
  'lorem ipsum no card here',
  'x',
  null,
];

for (const input of CASES) {
  const label = JSON.stringify(input);
  test(`parse-drift: extractCardNumber(${label}) — V1 === canonical`, () => {
    const cv1 = v1(input);
    const ccn = canonical(input);
    assert.deepEqual(
      cv1,
      ccn,
      `extractCardNumber(${label}) diverged:\n` +
      `  V1 (index.html):          ${JSON.stringify(cv1)}\n` +
      `  canonical (parse.js):     ${JSON.stringify(ccn)}`,
    );
  });
}
