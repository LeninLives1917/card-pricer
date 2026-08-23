// pricing/text-entry/index-cache.js
//
// Build the typed-entry indexes once, and rebuild them when the catalogue
// changes underneath.
//
// WHY A CACHE AT ALL
//
// buildNameIndex and buildNameNumberIndex are ~30 ms together over 20,546
// cards. Cheap once, absurd per request — a 50-line paste would pay it 50
// times. But a cache over a mutable catalogue is exactly how stale data hides:
// apps/server/_card-db-boot.js writes into CARD_DB at runtime (cacheCardResult,
// the background refresh), so an index built at boot and never revisited would
// quietly stop knowing about cards added since.
//
// So the cache is keyed on the catalogue's SIZE, and any change rebuilds. Size
// is not a perfect change detector — an in-place edit of an existing entry
// leaves it unchanged — but every path that adds a card grows it, and that is
// the case that matters: a card the operator just corrected must be findable
// on the next line they type.
//
// The alternative, invalidating explicitly from every writer, is the kind of
// coupling that gets forgotten by the next writer. This one cannot be
// forgotten, only outgrown, and it says so out loud.

import { buildNameIndex } from '../name-index.js';
import { buildNameNumberIndex } from './resolve-line.js';

let _cache = null;

/**
 * @param {Map|object} cardDb
 * @returns {{cardDb, nameIndex, nameNumberIndex, builtFor: number, builtAt: number}}
 */
export function getTypedEntryIndexes(cardDb) {
  const size = cardDb instanceof Map ? cardDb.size : Object.keys(cardDb || {}).length;
  if (_cache && _cache.builtFor === size && _cache.cardDb === cardDb) return _cache;

  const t0 = Date.now();
  const names = [];
  const values = cardDb instanceof Map ? cardDb.values() : Object.values(cardDb || {});
  for (const v of values) if (v?.name) names.push(v.name);

  _cache = {
    cardDb,
    nameIndex: buildNameIndex(names),
    nameNumberIndex: buildNameNumberIndex(cardDb),
    builtFor: size,
    builtAt: Date.now(),
  };
  console.log(`[TEXT-ENTRY] indexes built for ${size} cards in ${Date.now() - t0}ms `
    + `(${_cache.nameIndex.size} distinct names)`);
  return _cache;
}

/** Test seam, and the escape hatch if the size heuristic is ever not enough. */
export function resetTypedEntryIndexes() {
  _cache = null;
}

/** For /api/health — reports what the indexes were built from, not that they exist. */
export function typedEntryIndexState() {
  if (!_cache) return { built: false, cards: null, names: null, built_at: null };
  return {
    built: true,
    cards: _cache.builtFor,
    names: _cache.nameIndex.size,
    built_at: new Date(_cache.builtAt).toISOString(),
  };
}
