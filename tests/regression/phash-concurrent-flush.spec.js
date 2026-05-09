// Regression: concurrent flushToDisk race — pricing/phash.js
//
// Reproduces the ENOENT crash that occurred when multiple callers raced on
// the same `.tmp` path:
//   - asyncPool's 5 in-flight addToIndex calls hit the dirty-count threshold
//     at the same time AND
//   - the crawler's explicit flushNow() ran at the 500-card checkpoint.
//
// Fix: a module-level promise mutex serialises flushes and a do/while loop
// coalesces any flush requests queued while a flush is in-flight.
//
// Tests are nested inside a single describe so node:test runs them serially
// and they don't race each other on the shared PHASH_FILE path.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  addToIndex,
  flushNow,
  __resetIndex,
} from '../../pricing/phash.js';

// Resolve the production PHASH_FILE path the same way phash.js does.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..', '..');
const PHASH_FILE = join(REPO_ROOT, 'data', 'card-phashes.json');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Make a deterministic BigInt hash from an index. */
function makeHash(i) {
  return BigInt(i + 1) * 0x9e3779b97f4a7c15n & 0xFFFFFFFFFFFFFFFFn;
}

/** Make a card object from an index. */
function makeCard(i) {
  return { set_id: `sv${i % 10}`, number: `${i}` };
}

/** Remove PHASH_FILE and its .tmp sibling; ignore ENOENT. */
function cleanFiles() {
  try { fs.unlinkSync(PHASH_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(PHASH_FILE + '.tmp'); } catch { /* ignore */ }
}

// ── suite ─────────────────────────────────────────────────────────────────────
// concurrency: 1 ensures subtests run sequentially so they don't race each
// other on the shared PHASH_FILE (which lives at the real production path).

describe('phash concurrent flush regression', { concurrency: 1 }, () => {

  before(() => {
    // Remove any stale artefacts from a previous run.
    cleanFiles();
  });

  after(() => {
    // Clean up so the data directory isn't polluted with test data.
    cleanFiles();
    __resetIndex();
  });

  it('concurrent addToIndex + flushNow calls do not throw ENOENT', async () => {
    cleanFiles();
    __resetIndex();

    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(addToIndex(makeHash(i), makeCard(i)));
    }
    for (let f = 0; f < 5; f++) {
      promises.push(flushNow());
    }

    await assert.doesNotReject(
      () => Promise.all(promises),
      'one or more concurrent flush/addToIndex calls rejected',
    );

    // Drain any pending idle timer.
    await flushNow();
    cleanFiles();
  });

  it('on-disk JSON is valid after concurrent flush storm', async () => {
    cleanFiles();
    __resetIndex();

    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(addToIndex(makeHash(i), makeCard(i)));
    }
    for (let f = 0; f < 5; f++) {
      promises.push(flushNow());
    }
    await Promise.all(promises);

    // Ensure the final state is on disk.
    await flushNow();

    const raw = fs.readFileSync(PHASH_FILE, 'utf8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'disk file is not valid JSON');
    assert.strictEqual(typeof parsed, 'object', 'parsed result should be an object');
    assert.notStrictEqual(parsed, null);
    // v2 format: must have a version field and a phash sub-object.
    assert.strictEqual(parsed.version, 2, 'expected v2 format on disk');
    assert.strictEqual(typeof parsed.phash, 'object', 'expected phash sub-object');

    cleanFiles();
  });

  it('no entries are dropped after concurrent flush storm', async () => {
    cleanFiles();
    __resetIndex();

    const ADD_COUNT = 20;
    const expected = new Map();
    const promises = [];

    for (let i = 0; i < ADD_COUNT; i++) {
      const hash = makeHash(i);
      const card = makeCard(i);
      expected.set(hash.toString(16).padStart(16, '0'), card);
      promises.push(addToIndex(hash, card));
    }
    for (let f = 0; f < 5; f++) {
      promises.push(flushNow());
    }
    await Promise.all(promises);

    // One final authoritative flush so the file reflects every entry.
    await flushNow();

    const raw    = fs.readFileSync(PHASH_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    // v2 format: entries live under parsed.phash (legacy bigint form → phash only).
    const phashEntries = parsed.version === 2 ? parsed.phash : parsed;

    for (const [hexKey, expectedCard] of expected) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(phashEntries, hexKey),
        `entry ${hexKey} missing from disk after concurrent flush`,
      );
      assert.deepStrictEqual(
        phashEntries[hexKey],
        expectedCard,
        `entry ${hexKey} has wrong value on disk`,
      );
    }

    cleanFiles();
  });

  it('repeated concurrent storms leave no residual mutex state', async () => {
    // Two back-to-back storms confirm _flushPromise / _flushQueued are reset
    // correctly between rounds.
    for (let round = 0; round < 2; round++) {
      cleanFiles();
      __resetIndex();

      const promises = [];
      for (let i = 0; i < 15; i++) {
        promises.push(addToIndex(makeHash(i + round * 100), makeCard(i)));
      }
      for (let f = 0; f < 4; f++) {
        promises.push(flushNow());
      }

      await assert.doesNotReject(
        () => Promise.all(promises),
        `round ${round}: concurrent calls rejected`,
      );

      await flushNow();

      const raw = fs.readFileSync(PHASH_FILE, 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw), `round ${round}: disk file is corrupt`);
    }

    cleanFiles();
  });
});
