# PR 2 patch — pHash wiring

**Status:** DRAFT v2 — operator-approved decisions applied; ready for implementation once crawler completes.

**Files changed:** `pricing/identify-core.js` (lines 250-304), `apps/server/server.js` (lines 19-21).

---

## 1. `pricing/identify-core.js` patch

Exact line range confirmed by reading: `identifyCore` spans lines 250-304.
Import block spans lines 20-33. `pricing/` already imports from `apps/server/_card-db-boot.js`
(see `pricing/adapters/pokemontcg.js:24`), so the `lookupLocalDb` import below is consistent
with existing practice; no new cross-boundary convention is introduced.

### Import additions (after line 28, inside the existing import block)

```diff
 import {
   IDENT_MODEL,
   DOUBLE_CHECK_MODEL,
   DOUBLE_CHECK_SCORE_GATE,
+  PHASH_HAMMING_MAX,
+  PHASH_WRITE_MIN,
 } from './confidence.js';
 import { fixPokemonSuffix, extractPokemonSuffix } from './adapters/pokemontcg.js';
+import { computePhash, lookupByPhash, addToIndex } from './phash.js';
+import { resolveSetCode } from './set-aliases.js';
+// One-time exception: lookupLocalDb lives in apps/server/ but pricing/ already
+// imports from that boundary (adapters/pokemontcg.js:24). Consistent with prior art.
+import { lookupLocalDb } from '../apps/server/_card-db-boot.js';
```

**`resolveSetCode` signature** (`pricing/set-aliases.js:161`):
`resolveSetCode(raw) → { setId: string|null, ptcgoCode: string|null, aliased: boolean }`.
Returns `setId: null` when `raw` is null/undefined/empty. Decision: Option B chosen —
`resolveSetCode` at write boundary.

**`lookupLocalDb` signature** (`apps/server/_card-db-boot.js:189`):
`lookupLocalDb(setId, cardNumber) → { game, name, set_name, set_code, card_number, rarity, hp, reference_image, cardmarket_url, tcgplayer_url, verified, db_source, _manual } | null`.
Returns `null` on miss or untrusted-set guard rejection.

**Sonnet field names** confirmed at `identify-core.js:69-70` (system prompt inline):
Sonnet emits `set_code` (e.g. `"OBF"`) and `card_number` (e.g. `"006/197"`). It does NOT
emit `set_id`. `resolveSetCode` converts `set_code → setId` at the write boundary.

### `identifyCore` body — pHash lookup block (insert after line 271, before the Sonnet call)

```diff
   let cacheKey = null;
   if (!hint) {
     cacheKey = crypto.createHash('sha1').update(optimized).digest('hex');
     const hit = cacheGet(cacheKey);
     if (hit) return { cached: true, result: hit, cacheKey };
   }

+  // pHash lookup — runs after SHA-1 (cheapest) and before Sonnet (expensive).
+  // Skipped when hint is set (hint bypasses all caches).
+  let phash = null;
+  if (!hint) {
+    phash = await computePhash(optimized);
+    const phashHit = lookupByPhash(phash, PHASH_HAMMING_MAX);
+    if (phashHit) {
+      const fullCard = lookupLocalDb(phashHit.card.set_id, phashHit.card.number);
+      // Only return enriched on hit IF CARD_DB has image data. On a fresh
+      // Render persistent disk, CARD_DB entries are sheets-baseline (source:
+      // 'sheet') with reference_image=null. Returning a card without an
+      // image breaks client rendering — fall through to Sonnet so the user
+      // gets a fully-populated card via the existing identify path.
+      if (fullCard && fullCard.reference_image) {
+        console.log(`[PHASH] HIT distance=${phashHit.distance} set_id=${phashHit.card.set_id} number=${phashHit.card.number}`);
+        return {
+          cached: true,
+          source: 'phash',
+          result: { cards: [{ ...fullCard, source: 'phash' }] },
+          distance: phashHit.distance,
+          cacheKey,
+        };
+      }
+      // fullCard is null OR fullCard.reference_image is null. Fall through
+      // to Sonnet. The pHash index is correct (the visual fingerprint
+      // matches a known card identity) but we can't enrich without the
+      // CARD_DB image data. The Sonnet path will populate everything,
+      // and the image-cascade write-through (resolveImageFallback in
+      // pricing/price.js) will then fill in CARD_DB.image so future
+      // pHash hits on this card return enriched cleanly.
+      console.warn(`[PHASH] HIT set_id=${phashHit.card.set_id} number=${phashHit.card.number} but lookupLocalDb has no image — falling through to Sonnet`);
+    }
+  }
+
   let userMessage = 'Identify this trading card. FIRST read the card number...';
```

### Write-through gate (insert after `fixPokemonSuffix` map, before the final return at line 303)

```diff
   if (parsed.cards?.length > 0) {
     parsed.cards = parsed.cards.map(card => fixPokemonSuffix(card));
   }
+
+  // pHash write-through: persist hash → identity when Sonnet is confident.
+  // resolveSetCode converts Sonnet's uppercase set_code to CARD_DB's lowercase
+  // set_id. Skips write if set is unknown (setId null) to avoid poisoning the
+  // index. Side-effect only; errors must not propagate to the caller.
+  if (phash !== null && parsed.cards?.length === 1) {
+    const card = parsed.cards[0];
+    const conf = typeof card.confidence === 'number' ? card.confidence : 0;
+    if (conf >= PHASH_WRITE_MIN && card.set_code && card.card_number) {
+      const { setId } = resolveSetCode(card.set_code);
+      if (setId) {
+        addToIndex(phash, { set_id: setId, number: card.card_number }).catch(err =>
+          console.warn('[PHASH] addToIndex failed (non-fatal):', err.message)
+        );
+      }
+    }
+  }
+
   return { cached: false, parsed, cacheKey, imageBase64: imageData, imageMediaType: optimizedFormat === 'png' ? 'image/png' : 'image/jpeg' };
 }
```

---

## 2. `apps/server/server.js` patch

Boot sequence at lines 19-21. Pattern: fire-and-forget calls adjacent to `initCardDb()`.

```diff
 import { initCardDb, startCardDbDirtySaveInterval } from './_card-db-boot.js';
 import { startFxRefreshInterval } from '../../pricing/fx.js';
+import { loadIndex as loadPhashIndex } from '../../pricing/phash.js';

 initCardDb();
 startCardDbDirtySaveInterval();
 startFxRefreshInterval();
+loadPhashIndex()
+  .then(() => console.log('[phash] Index loaded from card-phashes.json'))
+  .catch(err => console.warn('[phash] loadIndex failed (non-fatal):', err.message));
```

Decision: fixed message only — no size accessor, no API change to `loadIndex()`.

This is safe per the PR 1 defensive-load guarantee: `loadIndex` catches `ENOENT` (empty
index) and renames corrupt files without throwing (`phash.js:215-237`). The `.catch` here
fires only on unexpected I/O errors.

---

## 3. Behavioural sanity checklist

- **Hint bypass still skips both caches.** The pHash block is inside `if (!hint)`,
  matching the SHA-1 block's guard. A hint call falls straight through to Sonnet. Confirm
  after applying: both SHA-1 and pHash blocks must be inside `if (!hint)`.

- **SHA-1 cache check still runs first.** `cacheGet(cacheKey)` is called before
  `computePhash`. SHA-1 is O(1) and cheaper than pHash (which calls `sharp`). Order:
  resize → SHA-1 → pHash → Sonnet. Confirm by reading the diff top-to-bottom.

- **pHash hits return full card data.** On pHash hit, `lookupLocalDb` is called
  immediately. The returned object includes `name`, `set_name`, `reference_image`,
  `cardmarket_url`, `tcgplayer_url`, `verified`, and all other fields the client expects.
  If `lookupLocalDb` returns null (CARD_DB gap), the hit is discarded and Sonnet runs.
  No half-empty card is ever returned.

- **`addToIndex` errors don't break the request path.** The write-through call is
  `.catch`-wrapped with `console.warn`. A failed disk write logs a warning and does not
  propagate. The Sonnet result is still returned to the caller.

- **`source: 'phash'` tag reaches the client.** `stripInternals` in
  `pricing/identify-core.js:397-408` strips keys starting with `_`. The `source` key does
  not start with `_` and is not in the strip list. A pHash hit returns before `stripInternals`
  is called on `out.parsed.cards` in the route; `out.result.cards[0].source` is already
  clean. Confirm `source` is not filtered by any other middleware.

- **`loadIndex` failure on boot does not crash the server.** `phash.js:loadIndex` catches
  `ENOENT` and corrupt JSON. The `.catch` wrapper in `server.js` converts any remaining
  I/O error to a `console.warn`. Server continues listening regardless.

- **pHash hit skips `verifyIdentified` and `doubleCheckAll`.** A pHash hit returns
  `{ cached: true, ... }` from `identifyCore`, and the route handler (`identify.js:80-83`)
  short-circuits to `res.json(out.result)`. This is the intended speedup. The returned
  object now contains the full `lookupLocalDb` record (with `reference_image`,
  `cardmarket_url`, `verified: true`, etc.) so client rendering is unaffected vs a
  Sonnet-then-verify response.

- **SHA-1 (`IDENT_CACHE`) write still happens after Sonnet.** The SHA-1 write-through
  happens in the route handler (`identify.js:93`: `cacheSet(out.cacheKey, out.parsed)`).
  The pHash write-through is inside `identifyCore` and fires before the return. These are
  independent; a Sonnet result writes to both. Byte-identical re-uploads remain free.

- **Unknown `set_code` skips the write-through.** If `resolveSetCode(card.set_code)`
  returns `setId: null` (set not in `PKM_SET_ALIASES` and Sonnet returned an
  unrecognised code), `addToIndex` is not called. The index is never written with a null
  key.

---

## 4. Risks

### Risk A — pHash hit skips verification (confirmed design intent; documented for operator)

Today every `identifyCore` miss goes through `verifyIdentified` + `doubleCheckAll` before
the result is returned. A pHash hit bypasses both. The premise: the pHash entry was written
only after a prior Sonnet call returned confidence ≥ `PHASH_WRITE_MIN`, which is high
enough to trust without re-verification on a subsequent similar scan.

The gap: if Sonnet mis-identified a card above the write gate, the wrong identity enters
the pHash index. A subsequent scan of a visually similar card within Hamming distance 8
returns that wrong identity without any verification step. Mitigations:
- User hint (`hint` field) bypasses all caches and forces a fresh Sonnet call.
- `PHASH_HAMMING_MAX = 8` limits false-positive surface area.

Eviction on `/api/report-bad-id` is a documented follow-up for V2.1, tracked separately.
PR 2 scope is wiring only.

### Risk B — write-through loss on mid-batch process kill

Binder scans call `identifyCore` per crop. A 9-card binder page fires 9 parallel
`identifyCore` calls, each potentially calling `addToIndex`. The debounced flush
(`FLUSH_IDLE_MS = 5000`, `FLUSH_COUNT_THRESHOLD = 100`) batches these in memory.

If Render kills the process between the `addToIndex` calls and the flush, in-memory entries
are lost. The JSON file on disk is not corrupted — it holds the last successfully flushed
state. On next boot, `loadIndex` reads the last clean file. Lost entries are re-added on
the next Sonnet identify of those cards.

Acceptable data-loss behaviour: non-corrupting, self-healing, bounded to the flush window.
No operator action required; documented for awareness.
