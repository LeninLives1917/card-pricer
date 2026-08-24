// tests/regression/cardmarket-url-store.spec.js
//
// PINS: the Cardmarket product URL a card resolves to was thrown away on every
// restart, so each deploy re-paid a redirect service measured to fail
// transiently on roughly a third of cards. Measured on the four cards that
// survived a 3-attempt run over 100 random cards:
//
//   sv1-62        502 -> 302            recovered on attempt 2
//   sv1-188       500 502 502 -> 302    recovered on attempt 4
//   zsv10pt5-134  502 -> 302            recovered on attempt 2
//   me4-53        404 404 404 404 404   genuinely has no page
//
// Three of four were transient. The fix is persistence plus a larger retry
// budget, NOT a search API — a search cannot help with the one card that has
// genuinely never been mapped.
//
// The subtle half of this, and the reason for most of the tests below: a hit
// and a miss must NOT be stored the same way. A permanent "no page" would make
// today's absence a fact forever and nothing would notice when it stopped being
// true — the project's standing defect shape. A miss expires; a hit does not.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadUrlStore, lookup, remember, flushUrlStore, urlStoreState,
  _resetUrlStore, _internals,
} from '../../pricing/adapters/cardmarket-url-store.js';

let dir;
let storePath;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cp-cmurl-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  storePath = join(dir, `store-${Math.random().toString(36).slice(2)}.json`);
  _resetUrlStore(storePath);
});

const URL_A = 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Stellar-Crown/Gulpin-V2-SCR154';

describe('cardmarket url store — never asked vs asked and absent', () => {
  test('a card never asked about reports hit:false, not a null url', async () => {
    await loadUrlStore();
    const r = lookup('pokemon|scr|154|gulpin');
    assert.equal(r.hit, false);
    assert.equal(r.url, undefined,
      'hit:false must not carry a url — a caller reading `.url` alone would ' +
      'read "never asked" as "known to have no page"');
  });

  test('a card asked about and absent reports hit:true with url null', async () => {
    await loadUrlStore();
    remember('pokemon|me4|53|stunky', null);
    const r = lookup('pokemon|me4|53|stunky');
    assert.equal(r.hit, true);
    assert.equal(r.url, null);
  });
});

describe('cardmarket url store — persistence across a restart', () => {
  test('a resolved url survives a full reload', async () => {
    await loadUrlStore();
    remember('pokemon|scr|154|gulpin', URL_A);
    assert.equal(await flushUrlStore(), true);

    // Simulate the restart: drop all in-memory state, load from the same file.
    _resetUrlStore(storePath);
    assert.equal(urlStoreState().loaded_entries, null,
      'loaded_entries must be null before a load — "never loaded" is not "loaded empty"');
    await loadUrlStore();
    assert.equal(urlStoreState().loaded_entries, 1);

    const r = lookup('pokemon|scr|154|gulpin');
    assert.equal(r.hit, true);
    assert.equal(r.url, URL_A);
    assert.equal(urlStoreState().hits_from_disk, 1);
  });

  test('the written document is valid JSON with the entries under a version', async () => {
    await loadUrlStore();
    remember('k', URL_A);
    await flushUrlStore();
    const doc = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(doc.version, 1);
    assert.equal(doc.entries.k.url, URL_A);
    assert.equal(typeof doc.entries.k.at, 'number');
  });
});

describe('cardmarket url store — a miss expires, a hit does not', () => {
  test('a miss older than the TTL is re-asked', async () => {
    // Write the file by hand so the timestamp can be aged without a fake clock.
    const old = Date.now() - _internals.MISS_TTL_MS - 60_000;
    await writeFile(storePath, JSON.stringify({
      version: 1,
      entries: {
        'pokemon|me4|53|stunky': { url: null, at: old },
        'pokemon|scr|154|gulpin': { url: URL_A, at: old },
      },
    }), 'utf8');
    _resetUrlStore(storePath);
    await loadUrlStore();

    assert.equal(lookup('pokemon|me4|53|stunky').hit, false,
      'a stale miss must be re-asked — me4 (Chaos Rising) is new enough that ' +
      'the mapping may simply not be published yet, and a permanent "no page" ' +
      'would never notice when that changed');
    assert.equal(urlStoreState().miss_expired, 1);

    const hit = lookup('pokemon|scr|154|gulpin');
    assert.equal(hit.hit, true, 'an aged HIT must still be served');
    assert.equal(hit.url, URL_A, 'a Cardmarket product URL is permanent');
  });

  test('a miss inside the TTL is served from disk', async () => {
    await writeFile(storePath, JSON.stringify({
      version: 1,
      entries: { k: { url: null, at: Date.now() - 1000 } },
    }), 'utf8');
    _resetUrlStore(storePath);
    await loadUrlStore();
    assert.equal(lookup('k').hit, true);
    assert.equal(urlStoreState().misses_from_disk, 1);
  });
});

describe('cardmarket url store — must never break a price', () => {
  test('a missing file loads as an empty store and is not counted as a failure', async () => {
    _resetUrlStore(join(dir, 'does-not-exist.json'));
    await loadUrlStore();
    const s = urlStoreState();
    assert.equal(s.loaded_entries, 0);
    assert.equal(s.load_failed, 0, 'ENOENT on first run is expected, not a failure');
  });

  test('a corrupt file loads as empty AND is counted', async () => {
    const bad = join(dir, 'corrupt.json');
    await writeFile(bad, '{ this is not json', 'utf8');
    _resetUrlStore(bad);
    await loadUrlStore();
    const s = urlStoreState();
    assert.equal(s.loaded_entries, 0);
    assert.equal(s.load_failed, 1,
      'a store that silently stopped loading would look identical to one that ' +
      'works and never hits — that is the invisible-fallback defect');
  });

  test('an unwritable path does not throw and does not drop the pending work', async () => {
    // A directory where a file should be: rename fails, nothing throws.
    _resetUrlStore(join(dir, 'nested-missing', '..', '..'));
    await loadUrlStore();
    remember('k', URL_A);
    const ok = await flushUrlStore();
    assert.equal(ok, false);
    assert.equal(urlStoreState().write_failed, 1);
    assert.equal(lookup('k').url, URL_A, 'the in-memory answer survives a failed write');
  });

  test('concurrent loads read the file once', async () => {
    await writeFile(storePath, JSON.stringify({ version: 1, entries: { k: { url: URL_A, at: Date.now() } } }), 'utf8');
    _resetUrlStore(storePath);
    const [a, b, c] = await Promise.all([loadUrlStore(), loadUrlStore(), loadUrlStore()]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(urlStoreState().entries, 1);
  });
});

// ---------------------------------------------------------------------------
// The health surface. A store that silently stopped loading would be
// indistinguishable from one that works and never hits, which is the defect
// shape CLAUDE.md names. It must be visible from outside the box.

import { cardmarketUrlCheck } from '../../apps/server/routes/health.js';

describe('cardmarket url store — visible in /api/health', () => {
  test('never loaded reports entries:null, not 0', () => {
    const c = cardmarketUrlCheck({ entries: null, loaded_entries: null });
    assert.equal(c.entries, null,
      '"never asked" must stay distinguishable from "asked and empty"');
    assert.match(c.detail, /never loaded/);
    assert.equal(c.ok, true, 'not yet used is not a fault');
  });

  test('a failed load is NOT ok and says what it costs', () => {
    const c = cardmarketUrlCheck({ entries: 0, load_failed: 1 });
    assert.equal(c.ok, false);
    assert.match(c.detail, /FAILED to load/);
    assert.match(c.detail, /re-resolve/, 'the detail must state the consequence, not just the label');
  });

  test('a failed write is NOT ok — resolutions would not survive a restart', () => {
    const c = cardmarketUrlCheck({ entries: 12, write_failed: 1 });
    assert.equal(c.ok, false);
    assert.match(c.detail, /cannot be WRITTEN/);
  });

  test('a healthy store reports the count and what it served', () => {
    const c = cardmarketUrlCheck({
      entries: 100, loaded_entries: 100, served_from_disk: 100,
      hits_from_disk: 93, misses_from_disk: 7, writes: 0,
    });
    assert.equal(c.ok, true);
    assert.equal(c.hits_from_disk, 93);
    assert.equal(c.misses_from_disk, 7);
    assert.match(c.detail, /100 cards known, 100 served from disk/);
  });
});
