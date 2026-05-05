// tests/regression/mobile-styles.spec.js
// Author: A4 + A5 + A10 (S22 / F11). Pure text-grep over the three apps'
// components.css to pin the responsive contract laid down in
// docs/V2_ARCHITECTURE.md §5 F11 + DESIGN_BRIEF.md "Tables / Mobile".
//
// We don't render the DOM — these are static asserts that the breakpoints
// exist with the right numeric values and at least one rule overrides
// padding or font-size below each breakpoint (catches the case where a
// future refactor strips the @media block but leaves a comment behind).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..', '..');

const vendor   = readFileSync(resolve(repo, 'apps/vendor/styles/components.css'),   'utf8');
const quote    = readFileSync(resolve(repo, 'apps/quote/styles/components.css'),    'utf8');
const customer = readFileSync(resolve(repo, 'apps/customer/styles/components.css'), 'utf8');

// Helper: assert that a media query block contains an actual override
// (not just whitespace + comments). We check that the block introduces
// at least one `padding`, `font-size`, `grid-template-columns`, `gap` or
// `flex-direction` declaration below the breakpoint header.
function blockHasRealRules(css, header) {
  const idx = css.indexOf(header);
  if (idx < 0) return false;
  // Find the matching closing brace by counting depth from the @media's
  // opening brace.
  const open = css.indexOf('{', idx);
  if (open < 0) return false;
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  const body = css.slice(open + 1, i - 1);
  return /(?:padding|font-size|grid-template|gap|flex-direction|min-height|outline-width)\s*:/.test(body);
}

test('S22: vendor components.css declares 640px + 540px breakpoints with real rules', () => {
  assert.match(vendor, /@media\s*\(\s*max-width:\s*640px\s*\)/, 'vendor missing 640px breakpoint');
  assert.match(vendor, /@media\s*\(\s*max-width:\s*540px\s*\)/, 'vendor missing 540px breakpoint');
  assert.ok(
    blockHasRealRules(vendor, '@media (max-width: 640px)'),
    'vendor 640px block must override padding / font-size / layout',
  );
  assert.ok(
    blockHasRealRules(vendor, '@media (max-width: 540px)'),
    'vendor 540px block must override padding / font-size / layout',
  );
});

test('S22: vendor components.css honours touch-only path (hover:none + pointer:coarse)', () => {
  assert.match(vendor, /@media\s*\(\s*hover:\s*none\s*\)/, 'vendor missing hover:none rule');
  assert.match(vendor, /pointer:\s*coarse/, 'vendor missing pointer:coarse rule');
  // 44px touch target — at least one .btn / .tab / sheet-action min-height bump.
  assert.match(vendor, /min-height:\s*44px/, 'vendor missing 44px touch target');
});

test('S22: vendor components.css drops the result-sheet card name to 22px on phones', () => {
  // The signature-moment Fraunces 28px name → 22px below 540px.
  // We assert the literal rule is present anywhere after the 540px header.
  const idx540 = vendor.indexOf('@media (max-width: 540px)');
  const tail = vendor.slice(idx540);
  assert.match(tail, /\.sheet-card-name\s*\{[^}]*font-size:\s*22px/, 'sheet-card-name not retuned at 540px');
});

test('S22: quote components.css declares 640px + 540px breakpoints with real rules', () => {
  assert.match(quote, /@media\s*\(\s*max-width:\s*640px\s*\)/, 'quote missing 640px breakpoint');
  assert.match(quote, /@media\s*\(\s*max-width:\s*540px\s*\)/, 'quote missing 540px breakpoint');
  assert.ok(
    blockHasRealRules(quote, '@media (max-width: 640px)'),
    'quote 640px block must override padding / font-size / layout',
  );
  assert.ok(
    blockHasRealRules(quote, '@media (max-width: 540px)'),
    'quote 540px block must override padding / font-size / layout',
  );
  // The how-to panel must flip column at 640px — confirm the rule exists.
  assert.match(
    quote.slice(quote.indexOf('@media (max-width: 640px)')),
    /\.how-to[\s\S]*?flex-direction:\s*column/,
    'quote how-to should stack at 640px',
  );
});

test('S22: customer components.css declares 640px + 540px breakpoints with real rules', () => {
  assert.match(customer, /@media\s*\(\s*max-width:\s*640px\s*\)/, 'customer missing 640px breakpoint');
  assert.match(customer, /@media\s*\(\s*max-width:\s*540px\s*\)/, 'customer missing 540px breakpoint');
  assert.ok(
    blockHasRealRules(customer, '@media (max-width: 540px)'),
    'customer 540px block must override padding / font-size / layout',
  );
  // CTA row must collapse to a 1-up stack on phone.
  const idx540 = customer.indexOf('@media (max-width: 540px)');
  assert.match(
    customer.slice(idx540),
    /\.cta-row\s*\{[^}]*flex-direction:\s*column/,
    'customer cta-row should stack on phone',
  );
});

test('S22: every app honours the touch-only path so 44px targets ship everywhere', () => {
  for (const [label, css] of [['vendor', vendor], ['quote', quote], ['customer', customer]]) {
    assert.match(css, /@media\s*\(\s*hover:\s*none\s*\)/, `${label} missing hover:none guard`);
    assert.match(css, /min-height:\s*44px/, `${label} missing 44px touch target`);
  }
});
