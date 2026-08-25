// tests/regression/refusal-is-terminal.spec.js
//
// PINS a stronger check being overruled by a weaker one, caught by a live
// spot-check on 25 Aug 2026 — AFTER the underlying resolver bug was fixed and
// deployed.
//
// pricing/text-entry/resolve-line.js had just been taught that a catalogue key
// may not discard the typed name, so "mew 151-6" correctly returned not_found:
// the name Mew is real, and there is no Mew at 151-6. Locally, correct.
//
// In production it still returned Charizard ex.
//
// apps/server/routes/identify.js falls through to a remote ladder whenever
// typed resolution does not resolve, adopting the best reading's fields:
//
//     name = name ?? best.name;
//     set_code = set_code ?? best.set_code;      // "151"
//     card_number = card_number ?? best.card_number;   // "6"
//
// The ladder checks less than the resolver does, so it answered anyway. The
// resolver's refusal — the whole point of the fix — was discarded one function
// later. Exactly the shape that made "wel 189a/214" return Glass Trumpet.
//
// FALLING THROUGH IS RIGHT when the resolver merely ran out of information:
// the remote APIs genuinely know about cards this catalogue does not, and that
// path is worth keeping. It is wrong when the resolver REFUSED because the
// evidence contradicted itself. Those are different outcomes and the code was
// treating them as one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDENTIFY = join(ROOT, 'apps', 'server', 'routes', 'identify.js');

const codeOnly = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('a contradiction-based refusal is terminal', () => {
  test('the refusal set exists and is checked before the fall-through', async () => {
    const code = codeOnly(await readFile(IDENTIFY, 'utf8'));
    const refusedAt = code.indexOf('REFUSED');
    const adoptAt = code.indexOf('const best = r.interpretation;');
    assert.ok(refusedAt > -1, 'contradicted reasons must be recognised');
    assert.ok(adoptAt > -1, 'the fall-through must still exist for genuine gaps');
    assert.ok(refusedAt < adoptAt,
      'the refusal must be checked BEFORE the reading is handed to the ladder, '
      + 'or the ladder answers first and the check is decorative');
  });

  test('the contradicted reasons are the ones that mean "refused"', async () => {
    const code = codeOnly(await readFile(IDENTIFY, 'utf8'));
    // Each of these means the evidence disagreed with itself, not that we ran
    // out of catalogue.
    for (const reason of [
      'name_known_but_not_at_that_number',   // "mew 151-6"
      'no_prefix_match_at_that_number',
      'set_code_contradicts_printed_total',  // "gri 75/127"
      'printed_total_excludes_all',
    ]) {
      assert.ok(code.includes(reason), `${reason} should be treated as a refusal`);
    }
  });

  test('a refusal returns cards:[] rather than an error', async () => {
    // Existing callers test `!cards.length` and render a row they cannot
    // price. Returning an error status instead would surface an HTTP message.
    const code = codeOnly(await readFile(IDENTIFY, 'utf8'));
    const block = code.slice(code.indexOf('REFUSED.has(r.reason)'), code.indexOf('REFUSED.has(r.reason)') + 400);
    assert.match(block, /cards:\s*\[\]/, 'an un-updated caller must degrade to an error row, never a wrong price');
    assert.match(block, /resolution:/, 'the envelope must still say why');
  });

  test('the refusal is counted', async () => {
    const code = codeOnly(await readFile(IDENTIFY, 'utf8'));
    const block = code.slice(code.indexOf('REFUSED.has(r.reason)'), code.indexOf('REFUSED.has(r.reason)') + 400);
    assert.match(block, /countTextEntry/,
      'a path that silently stops answering is indistinguishable from one nobody used');
  });

  test('genuine gaps still fall through to the remote ladder', async () => {
    const code = codeOnly(await readFile(IDENTIFY, 'utf8'));
    // The catalogue is 17+ days old and the remote APIs know newer cards. A
    // blanket "never fall through" would trade one defect for another.
    assert.match(code, /name = name \?\? best\.name/,
      'the fall-through must survive for reasons outside the refusal set');
  });
});
