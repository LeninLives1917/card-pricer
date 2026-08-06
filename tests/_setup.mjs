// tests/_setup.mjs
//
// Loaded via `node --test --import ./tests/_setup.mjs`, so it runs in EVERY
// test process before any spec module is evaluated.
//
// Its job is to keep the suite away from production data artifacts.
//
// WHY
//
// `npm test` silently destroyed data/card-phashes.json. One spec exercised
// flush races against the real production path and unlinked it in its hooks;
// separately, any spec that calls addToIndex() arms a 5-second debounced write
// that lands on the default path if the process lives long enough. A
// 76,893-entry index built by a multi-hour crawl was reduced to a single
// placeholder entry, and the suite reported 639 tests passing while it happened.
//
// Fixing the two specs that did it would not have been enough. The next spec to
// touch the index would reintroduce it, and nothing would fail. So the
// redirection is global and applies to specs not yet written: a test process
// should not be able to reach the real artifact by default.
//
// An explicitly-set PHASH_FILE is honoured, so a spec that genuinely needs a
// specific path can still set one.

import os from 'os';
import { join } from 'path';

if (!process.env.PHASH_FILE) {
  process.env.PHASH_FILE = join(
    os.tmpdir(),
    `card-pricer-test-phash-${process.pid}.json`,
  );
}
