// Regression: binder bbox parser — pricing/binder.js#parseBinderResponse
//
// The actual Anthropic round-trip needs a network and is flaky to mock
// well; the pure parser handles every shape of malformed / out-of-range
// input we expect from the wire, and that's what we lock down here.
//
// Lifecycle parity with the route handler in apps/server/routes/identify.js:
//   1. Sonnet returns text (sometimes wrapped in ```json fences).
//   2. parseBinderResponse strips fences, parses JSON, validates each
//      bbox.
//   3. Each surviving bbox feeds sharp.extract via simple multiplication
//      against image width/height.
// If parseBinderResponse hands the route bad data, the crop step will
// either silently drop the box (width<32) or — worse — extract garbage,
// so the validation rules below are load-bearing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBinderResponse } from '../../pricing/binder.js';

// ── Happy path ────────────────────────────────────────────────────────────

test('parses a clean JSON response with multiple cards', () => {
  const raw = JSON.stringify({
    cards: [
      { x: 0.05, y: 0.08, w: 0.30, h: 0.42, hint: 'Pikachu' },
      { x: 0.40, y: 0.08, w: 0.30, h: 0.42 },
      { x: 0.05, y: 0.55, w: 0.30, h: 0.42, hint: 'Wugtrio' },
    ],
  });
  const out = parseBinderResponse(raw);
  assert.equal(out.cards.length, 3);
  assert.equal(out.cards[0].hint, 'Pikachu');
  assert.equal(out.cards[1].hint, undefined);
  assert.equal(out.cards[2].hint, 'Wugtrio');
});

test('strips ```json``` markdown fences (Sonnet sometimes wraps despite the prompt)', () => {
  const raw = '```json\n' + JSON.stringify({ cards: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.3 }] }) + '\n```';
  const out = parseBinderResponse(raw);
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].x, 0.1);
});

test('strips bare ``` fences too', () => {
  const raw = '```\n' + JSON.stringify({ cards: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] }) + '\n```';
  const out = parseBinderResponse(raw);
  assert.equal(out.cards.length, 1);
});

// ── Sort order: top-to-bottom, then left-to-right ─────────────────────────

test('sorts cards top-to-bottom, then left-to-right within each row', () => {
  // Three rows of three; intentionally shuffled in the input to prove the
  // sort. Y values are ~0.1 / ~0.4 / ~0.7 so the row-grouping tolerance
  // (5%) keeps each row together.
  const raw = JSON.stringify({
    cards: [
      { x: 0.6, y: 0.4, w: 0.2, h: 0.25 }, // row 2 col 3
      { x: 0.1, y: 0.7, w: 0.2, h: 0.25 }, // row 3 col 1
      { x: 0.4, y: 0.1, w: 0.2, h: 0.25 }, // row 1 col 2
      { x: 0.7, y: 0.7, w: 0.2, h: 0.25 }, // row 3 col 3
      { x: 0.1, y: 0.1, w: 0.2, h: 0.25 }, // row 1 col 1
      { x: 0.7, y: 0.1, w: 0.2, h: 0.25 }, // row 1 col 3
      { x: 0.4, y: 0.4, w: 0.2, h: 0.25 }, // row 2 col 2
      { x: 0.1, y: 0.4, w: 0.2, h: 0.25 }, // row 2 col 1
      { x: 0.4, y: 0.7, w: 0.2, h: 0.25 }, // row 3 col 2
    ],
  });
  const out = parseBinderResponse(raw);
  assert.equal(out.cards.length, 9);
  // Expected order: y rises monotonically across rows, x rises within each row.
  assert.deepEqual(
    out.cards.map((c) => [Math.round(c.y * 10) / 10, Math.round(c.x * 10) / 10]),
    [
      [0.1, 0.1], [0.1, 0.4], [0.1, 0.7],
      [0.4, 0.1], [0.4, 0.4], [0.4, 0.6],
      [0.7, 0.1], [0.7, 0.4], [0.7, 0.7],
    ],
  );
});

// ── Validation: bad shapes are dropped, not allowed to corrupt the route ─

test('rejects missing fields', () => {
  const raw = JSON.stringify({
    cards: [
      { x: 0.1, y: 0.1, w: 0.2 },          // no h
      { x: 0.1, y: 0.1, h: 0.2 },          // no w
      { y: 0.1, w: 0.2, h: 0.2 },          // no x
      { x: 0.1, w: 0.2, h: 0.2 },          // no y
      {},                                   // empty
      { x: 'a', y: 0.1, w: 0.2, h: 0.2 }, // non-numeric
      { x: NaN, y: 0.1, w: 0.2, h: 0.2 }, // NaN
    ],
  });
  const out = parseBinderResponse(raw);
  assert.equal(out.cards.length, 0);
});

test('rejects non-positive widths/heights', () => {
  const raw = JSON.stringify({
    cards: [
      { x: 0.1, y: 0.1, w: 0,    h: 0.2 },
      { x: 0.1, y: 0.1, w: 0.2,  h: 0    },
      { x: 0.1, y: 0.1, w: -0.1, h: 0.2  },
    ],
  });
  assert.equal(parseBinderResponse(raw).cards.length, 0);
});

test('rejects too-tiny boxes (likely false positives, < 4% of image)', () => {
  const raw = JSON.stringify({
    cards: [
      { x: 0.5, y: 0.5, w: 0.03, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5,  h: 0.03 },
    ],
  });
  assert.equal(parseBinderResponse(raw).cards.length, 0);
});

test('rejects boxes entirely outside the image', () => {
  const raw = JSON.stringify({
    cards: [
      { x: 1.2, y: 0.5, w: 0.3, h: 0.3 }, // x past 1.0
      { x: 0.5, y: 1.2, w: 0.3, h: 0.3 }, // y past 1.0
      { x: -0.5, y: 0.5, w: 0.3, h: 0.3 }, // ends at x=-0.2 (entirely off-left)
    ],
  });
  // Note: x=-0.5 + w=0.3 → right edge at -0.2, so the box is entirely off-image.
  // The first two are clearly past the right/bottom edges.
  assert.equal(parseBinderResponse(raw).cards.length, 0);
});

test('clamps boxes that overshoot slightly (e.g. 0.001 past 1.0)', () => {
  const raw = JSON.stringify({
    cards: [
      { x: 0.05, y: 0.08, w: 0.951, h: 0.42 }, // x+w = 1.001 — clamp to 1.0
    ],
  });
  const out = parseBinderResponse(raw);
  assert.equal(out.cards.length, 1);
  assert.ok(out.cards[0].x + out.cards[0].w <= 1.0001);
  assert.ok(out.cards[0].w >= 0.04, 'still wide enough after clamp');
});

// ── Hint sanitisation ────────────────────────────────────────────────────

test('hint is trimmed and capped at 120 chars', () => {
  const longHint = 'A'.repeat(500);
  const raw = JSON.stringify({
    cards: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.3, hint: '   Pikachu   ' }],
  });
  assert.equal(parseBinderResponse(raw).cards[0].hint, 'Pikachu');

  const raw2 = JSON.stringify({
    cards: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.3, hint: longHint }],
  });
  assert.equal(parseBinderResponse(raw2).cards[0].hint.length, 120);
});

test('non-string hint is dropped (never crashes)', () => {
  const raw = JSON.stringify({
    cards: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.3, hint: 42 }],
  });
  assert.equal(parseBinderResponse(raw).cards[0].hint, undefined);
});

test('empty hint is omitted, not preserved as ""', () => {
  const raw = JSON.stringify({
    cards: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.3, hint: '   ' }],
  });
  assert.equal(parseBinderResponse(raw).cards[0].hint, undefined);
});

// ── Wire failures ─────────────────────────────────────────────────────────

test('returns empty cards for invalid JSON instead of throwing', () => {
  assert.deepEqual(parseBinderResponse('not json at all'), { cards: [] });
  assert.deepEqual(parseBinderResponse(''), { cards: [] });
  assert.deepEqual(parseBinderResponse('{'), { cards: [] });
});

test('returns empty cards when "cards" is missing or wrong type', () => {
  assert.deepEqual(parseBinderResponse('{}'), { cards: [] });
  assert.deepEqual(parseBinderResponse(JSON.stringify({ cards: 'pikachu' })), { cards: [] });
  assert.deepEqual(parseBinderResponse(JSON.stringify({ cards: null })), { cards: [] });
});

test('returns empty cards for non-string input', () => {
  assert.deepEqual(parseBinderResponse(null), { cards: [] });
  assert.deepEqual(parseBinderResponse(undefined), { cards: [] });
  assert.deepEqual(parseBinderResponse(42), { cards: [] });
});

// ── Realistic 9-pocket layout ────────────────────────────────────────────

test('a realistic 3x3 binder-page response yields 9 ordered cards with valid coords', () => {
  // Coords chosen to mimic a typical 3x3 layout with ~5% pocket borders.
  const cards = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      cards.push({
        x: 0.05 + col * 0.32,
        y: 0.05 + row * 0.32,
        w: 0.28,
        h: 0.28,
        hint: `Card ${row}-${col}`,
      });
    }
  }
  const out = parseBinderResponse(JSON.stringify({ cards }));
  assert.equal(out.cards.length, 9);
  // Every survivor must be a valid extract-able crop.
  for (const c of out.cards) {
    assert.ok(c.x >= 0 && c.x <= 1);
    assert.ok(c.y >= 0 && c.y <= 1);
    assert.ok(c.w >= 0.04);
    assert.ok(c.h >= 0.04);
    assert.ok(c.x + c.w <= 1.0001);
    assert.ok(c.y + c.h <= 1.0001);
  }
});
