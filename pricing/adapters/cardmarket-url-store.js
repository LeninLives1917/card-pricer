// pricing/adapters/cardmarket-url-store.js
//
// Owner: A2 (Pricing engine)
//
// Disk-backed memory for resolved Cardmarket product URLs.
//
// WHY THIS EXISTS
//
// resolveCardmarketProductUrl follows a pokemontcg.io redirect to discover the
// canonical Cardmarket page for a card. The URL cannot be BUILT (see the long
// comment in cardmarket-html.js), so it must be looked up — and the lookup
// service is unreliable. Measured on the four cards that survived a 3-attempt
// run over 100 random cards:
//
//   sv1-62        502 -> 302            recovered on attempt 2
//   sv1-188       500 502 502 -> 302    recovered on attempt 4
//   zsv10pt5-134  502 -> 302            recovered on attempt 2
//   me4-53        404 404 404 404 404   genuinely has no page
//
// Three of four were TRANSIENT. In-process caching already stopped a bulk
// session paying twice; it did nothing across a restart, so every deploy threw
// the whole map away and the operator paid the flaky service again from zero.
//
// A resolved URL is a stable fact about a card. It belongs on disk.
//
// TWO KINDS OF ENTRY, DELIBERATELY NOT TREATED THE SAME
//
//   a hit   never expires. Cardmarket product URLs are permanent; the redirect
//           is the only unreliable part, and once followed it need not be
//           followed again.
//
//   a miss  expires after MISS_TTL_DAYS. me4-53 is Chaos Rising, a set new
//           enough that the mapping simply has not been published yet. A
//           permanent "no page" would make today's absence a fact forever, and
//           nothing would ever notice it had become wrong — the project's
//           standing defect shape. An expiring miss re-asks.
//
// A TRANSIENT FAILURE IS NEVER WRITTEN. It is not an answer.
//
// This file is generated state, not source, so it lives under data/ — which is
// where the Render persistent disk mounts, and therefore the only directory
// that survives a deploy. That mount shadowing git-tracked files is a trap this
// project has already been bitten by (see pricing/set-resolve.js); here the
// shadowing is the point.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PATH = join(REPO_ROOT, 'data', 'cardmarket-urls.json');

const MISS_TTL_DAYS = 14;
const MISS_TTL_MS = MISS_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Flush after this many new entries, so a long session checkpoints itself. */
const FLUSH_EVERY = 25;
/** …or this long after the last write, so a short session still persists. */
const FLUSH_DEBOUNCE_MS = 3000;

const counters = {
  loaded_entries: null,   // null = never loaded, distinct from 0 = loaded empty
  load_failed: 0,
  hits_from_disk: 0,
  misses_from_disk: 0,
  miss_expired: 0,
  writes: 0,
  write_failed: 0,
};

let _path = DEFAULT_PATH;
let _map = null;          // key -> {url: string|null, at: epoch ms}
let _loading = null;
let _dirty = 0;
let _timer = null;

/**
 * Load the store. Safe to call concurrently — the read happens once.
 * A missing or corrupt file is an EMPTY store, never an error: a link is a
 * convenience and must not be able to fail a price.
 */
export async function loadUrlStore() {
  if (_map) return _map;
  if (_loading) return _loading;
  _loading = (async () => {
    let parsed = {};
    try {
      const raw = await readFile(_path, 'utf8');
      const doc = JSON.parse(raw);
      // Tolerate both the versioned envelope and a bare map, so a file written
      // by an older build is not thrown away.
      parsed = doc && typeof doc === 'object' && doc.entries ? doc.entries : doc;
      if (!parsed || typeof parsed !== 'object') parsed = {};
    } catch (err) {
      // ENOENT on first run is expected and is not a failure. Anything else is
      // counted, because a store that silently stops loading would look exactly
      // like a store that is working and simply never hits.
      if (err?.code !== 'ENOENT') counters.load_failed += 1;
      parsed = {};
    }
    _map = new Map(Object.entries(parsed).filter(([, v]) => v && typeof v === 'object'));
    counters.loaded_entries = _map.size;
    _loading = null;
    return _map;
  })();
  return _loading;
}

/**
 * @returns {{hit: true, url: string|null} | {hit: false}}
 *
 * Deliberately NOT `string | null` — the caller must be able to tell "this card
 * is known to have no page" from "this card has never been asked about". That
 * distinction is the whole point of the store.
 */
export function lookup(key) {
  if (!_map) return { hit: false };
  const e = _map.get(key);
  if (!e) return { hit: false };
  if (e.url) {
    counters.hits_from_disk += 1;
    return { hit: true, url: e.url };
  }
  // A miss, which ages out.
  if (Date.now() - (e.at ?? 0) > MISS_TTL_MS) {
    counters.miss_expired += 1;
    _map.delete(key);
    return { hit: false };
  }
  counters.misses_from_disk += 1;
  return { hit: true, url: null };
}

/**
 * Record a DEFINITE answer. Never call this for a transient failure — a 5xx or
 * a timeout means the question was not answered, and writing it would make one
 * bad minute permanent.
 */
export function remember(key, url) {
  if (!_map) return;
  _map.set(key, { url: url ?? null, at: Date.now() });
  _dirty += 1;
  if (_dirty >= FLUSH_EVERY) { void flushUrlStore(); return; }
  if (!_timer) {
    _timer = setTimeout(() => { _timer = null; void flushUrlStore(); }, FLUSH_DEBOUNCE_MS);
    // Do not hold the process open for a cache flush.
    if (typeof _timer.unref === 'function') _timer.unref();
  }
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a
 * truncated JSON document that then fails to load forever.
 */
export async function flushUrlStore() {
  if (!_map || _dirty === 0) return false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const pending = _dirty;
  _dirty = 0;
  const doc = {
    version: 1,
    written_at: new Date().toISOString(),
    miss_ttl_days: MISS_TTL_DAYS,
    entries: Object.fromEntries(_map),
  };
  const tmp = `${_path}.tmp`;
  try {
    await mkdir(dirname(_path), { recursive: true });
    await writeFile(tmp, JSON.stringify(doc), 'utf8');
    await rename(tmp, _path);
    counters.writes += 1;
    return true;
  } catch {
    counters.write_failed += 1;
    // Put the work back so the next flush retries it rather than dropping it.
    _dirty += pending;
    return false;
  }
}

/** For /api/health. Ratios, not bare counts — see CLAUDE.md. */
export function urlStoreState() {
  const served = counters.hits_from_disk + counters.misses_from_disk;
  return {
    ...counters,
    entries: _map ? _map.size : null,
    served_from_disk: served,
    path: _path,
  };
}

/** Test seam. */
export function _resetUrlStore(path) {
  _map = null;
  _loading = null;
  _dirty = 0;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _path = path || DEFAULT_PATH;
  counters.loaded_entries = null;
  counters.load_failed = 0;
  counters.hits_from_disk = 0;
  counters.misses_from_disk = 0;
  counters.miss_expired = 0;
  counters.writes = 0;
  counters.write_failed = 0;
}

export const _internals = { MISS_TTL_MS, MISS_TTL_DAYS, FLUSH_EVERY };
