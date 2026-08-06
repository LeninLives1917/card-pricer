// Regression: the test suite must not write to production data artifacts.
//
// `npm test` silently destroyed data/card-phashes.json. Two independent routes:
//
//   1. phash-concurrent-flush.spec.js exercised flush races against the REAL
//      production path and called fs.unlinkSync() on it in before/after hooks.
//   2. Any spec calling addToIndex() arms a 5-second debounced write which
//      lands on the default path if the process outlives the timer.
//
// A 76,893-entry index built by a multi-hour crawl became a single placeholder
// entry, and the suite reported 639 tests passing while it happened. Nothing
// failed, because destroying data is not something the assertions looked at.
// That is this project's signature defect in its purest form: silent,
// destructive, and indistinguishable from success.
//
// Fixing the two offending specs would not have been enough — the next spec to
// touch the index reintroduces it. So tests/_setup.mjs redirects globally via
// --import, and this pins that it is actually in force. If someone drops the
// --import flag from the test script, this fails rather than the next crawl
// quietly evaporating.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRODUCTION_PHASH = resolve(join(ROOT, 'data', 'card-phashes.json'));

test('the phash index path is redirected away from data/', () => {
  assert.ok(process.env.PHASH_FILE,
    'PHASH_FILE is unset — tests/_setup.mjs did not run. Check that the test ' +
    'script still passes --import ./tests/_setup.mjs');
  assert.notEqual(resolve(process.env.PHASH_FILE), PRODUCTION_PHASH,
    'tests are pointed at the production pHash index');
});

test('the test script still loads the setup module', () => {
  // The redirection lives in a flag, and a flag is easy to lose in a refactor.
  const pkg = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const script of ['test', 'test:watch']) {
    assert.match(pkg.scripts[script], /--import \.\/tests\/_setup\.mjs/,
      `package.json scripts.${script} must load tests/_setup.mjs`);
  }
});

test('no spec hardcodes the production data directory', () => {
  // Catches the shape of the original bug — a spec resolving REPO_ROOT/data/…
  // for itself and then writing to or unlinking it.
  const dir = join(ROOT, 'tests', 'regression');
  const SELF = 'tests-do-not-touch-production-data.spec.js';   // must name the path to check it
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.spec.js') && n !== SELF)) {
    const src = fs.readFileSync(join(dir, f), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // join(REPO_ROOT, 'data', …) / join(ROOT, 'data', …) in live code.
    if (/join\(\s*\w*ROOT\w*\s*,\s*'data'/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    'these specs resolve the production data directory directly — point them ' +
    'at os.tmpdir() instead');
});
