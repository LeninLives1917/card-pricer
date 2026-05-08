# Design: Perceptual-hash card lookup

## Context

Card Pricer V2 (Node/Express) currently identifies every uploaded card crop via Anthropic Sonnet (`identifyCore` at `pricing/identify-core.js:250-304`). Each call costs latency (~1–3s) and API spend. Many uploads — especially binder grids — re-identify cards we've seen before. A SHA-1 buffer cache exists but only catches byte-identical re-uploads, which is rare in practice.

A perceptual hash (pHash) layer sits between the SHA-1 cache and the Sonnet call: compute a 64-bit visual fingerprint of the resized buffer, look it up against an index of known cards, return the cached identity on a hit. On miss we fall through to Sonnet as today, then write the new hash → identity pair into the index. The index is seeded by an offline crawler that walks `CARD_DB` (~25k Pokémon entries) and hashes each card's `reference_image`.

## Constraints

- **Stack:** Node 20, Express, Sharp 0.33 (already in deps), axios. No new heavy deps.
- **Storage:** Render persistent disk at `/opt/render/project/data` (= `<repo>/data/`). Currently holds `card-db.json`, `card-prices.json`. JSON-on-disk is the established pattern.
- **Intercept point fixed:** must slot into `identifyCore({buffer, hint})`. Hint bypass must continue to skip caching (matches existing SHA-1 behaviour).
- **Scope:** Pokémon only. OCR-first path is out of scope (it bypasses `identifyCore` and is gated off by default).
- **Tests:** synthetic buffers + pure-function imports only. No on-disk fixtures, no Anthropic round-trip.
- **Won't change:** `identifyCore` signature, Sonnet call shape, SW cache (server-only change).

## Algorithm

DCT-based pHash:

1. Resize input to 32×32 greyscale (Sharp `.resize(32,32).greyscale().raw()`).
2. Run 2D DCT-II over the 32×32 matrix.
3. Take the top-left 8×8 low-frequency block (drop DC term at [0,0] when computing the median to reduce brightness bias).
4. Threshold each of the 64 coefficients against the median → 1 bit per coefficient.
5. Pack into a 64-bit `BigInt`.

Matching: Hamming distance between two 64-bit hashes (XOR + popcount). Identical visuals → 0; minor recompression / 1–2 px shift → typically 1–6; different cards → 20+.

## Match threshold

Start at `PHASH_HAMMING_MAX = 8` (8/64 = 12.5% bit difference). Empirically a safe ceiling for "same card, different scan" while staying well below "different card" territory. Expose as a tunable in `pricing/confidence.js` next to existing confidence knobs so it co-locates with the rest of the matching policy.

`PHASH_WRITE_MIN = 0.85` — minimum Sonnet confidence required before we write a new hash → identity entry. Architect to confirm the existing high-confidence band constant name during implementation; if one already exists in `pricing/confidence.js`, reuse it instead of adding a second knob.

## Storage shape

Three options considered:

### Option A: In-memory Map, JSON-backed at `data/card-phashes.json`

- **Approach:** Load entire index at boot into `Map<bigint, {set_id, number}>`. Lookup = linear scan of keys, return min-distance entry where distance ≤ threshold.
- **Math:** 25k entries × XOR+popcount (~5 ns each) ≈ 0.1 ms per lookup. JSON file ≈ 25k × ~80 B = ~2 MB. Boot load ≈ 50 ms.
- **Pros:** Simplest. Mirrors existing `card-db.json` / `card-prices.json` pattern. Trivial to back up (it's a file). Resumable crawler is just file I/O.
- **Cons:** Linear scan won't scale past ~500k entries on a single thread.
- **Risk / reversibility:** Fully reversible. Schema is a flat JSON object; migrating to BK-tree or Postgres later is a one-script job.

### Option B: BK-tree in memory, JSON-backed for persistence

- **Approach:** Build a Burkhard-Keller tree keyed on Hamming distance. Sub-linear lookup (~log n on average for low thresholds).
- **Pros:** Scales to millions of entries.
- **Cons:** ~3× the code. Tree rebuild on load (or serialise the tree). Premature for 25k entries — Option A is already sub-millisecond.
- **Risk:** Reversible but more invasive to back out.

### Option C: Postgres `card_phashes` table

- **Approach:** Project already uses Postgres for `card_prices`. Store hashes there.
- **Pros:** Durable, queryable, no boot-load cost.
- **Cons:** **B-tree indexes don't help Hamming-distance lookups** — every query still does a sequential scan server-side. Postgres adds no lookup advantage over Option A; only durability. Render's mounted disk is already persistent, so durability is solved. Net: Postgres adds connection overhead and ops surface for zero lookup benefit at this scale.
- **Risk:** One-way door for the schema if we go down this path and later regret it.

### Recommendation: Option A

In-memory Map, JSON-backed at `data/card-phashes.json`. Simpler, fast enough at 25k, matches the established `card-db.json` pattern, and Render's persistent disk gives us the durability Postgres would have offered. Revisit (move to BK-tree) if the index grows past ~100k entries or if p99 lookup latency creeps over 5 ms. Revisit (move to Postgres) only if we need cross-instance sharing — currently we're single-instance on Render.

## Crawler — `scripts/build-phash-db.js`

- Walks `CARD_DB`, iterates entries with a `reference_image` URL.
- Fetches via axios (timeout 10s, follow redirects).
- Computes pHash via Sharp pipeline above.
- Skips entries already present in `card-phashes.json` (resumable).
- Concurrency: 5 in-flight fetches (e.g. `p-limit` or hand-rolled). Higher risks Cloudflare rate-limits on scryfall/pokemontcg CDNs.
- On 404 / non-2xx / Cloudflare block: log `set_id-number` + reason, skip, continue.
- Writes incrementally every 500 cards to survive interruption.
- **Expected runtime:** 25k cards / 5 concurrent × ~500 ms/card ≈ 40 min. Acceptable for an offline one-shot.

## Module shape — `pricing/phash.js`

```
computePhash(buffer: Buffer): Promise<bigint>
lookupByPhash(hash: bigint, threshold: number): { card, distance } | null
loadIndex(): Promise<void>      // called once at boot from apps/server/server.js
addToIndex(hash: bigint, card: { set_id, number }): Promise<void>
```

Internal state: `_index = new Map<bigint, { set_id, number }>`. Hash → identity is many-to-one: multiple visual variants (binder crop vs. full scan vs. CDN reference) of the same card all point at the same `{set_id, number}`. That's the desired shape.

JSON serialisation: `BigInt` doesn't `JSON.stringify` natively — store as hex string (`hash.toString(16).padStart(16,'0')`) and parse back with `BigInt('0x' + s)`.

`addToIndex` debounces disk writes (e.g. flush every 100 additions or on a 5 s timer) so per-request Sonnet hits don't synchronously block on `fs.writeFile` of a 2 MB file.

## Integration into `identifyCore` — pseudocode

```
async function identifyCore({ buffer, hint }) {
  const resized = await resizeIfNeeded(buffer);  // existing 1800px/q92 step

  if (hint) return sonnetIdentify(resized, hint);          // unchanged: hint bypasses all caches

  const sha1 = sha1OfBuffer(resized);
  if (IDENT_CACHE.has(sha1)) return { cached: true, source: 'sha1', ... };

  const phash = await computePhash(resized);
  const hit = lookupByPhash(phash, PHASH_HAMMING_MAX);
  if (hit) return { cached: true, source: 'phash', result: hit.card, distance: hit.distance, ... };

  const sonnetResult = await sonnetIdentify(resized);

  if (sonnetResult.confidence >= PHASH_WRITE_MIN) {
    await addToIndex(phash, { set_id: sonnetResult.set_id, number: sonnetResult.number });
  }
  IDENT_CACHE.set(sha1, sonnetResult);  // existing behaviour
  return sonnetResult;
}
```

The pHash layer sits between SHA-1 (exact-byte) and Sonnet (LLM). Hint-bypass and SHA-1 cache semantics are preserved.

## Write-through gate

Only write to the pHash index when Sonnet confidence ≥ `PHASH_WRITE_MIN` (proposed 0.85, or reuse existing constant in `pricing/confidence.js` if one exists). This prevents low-confidence Sonnet outputs — especially phantom-cell crops from binder CV that Sonnet hedges on — from poisoning the index.

## Risks & mitigations

- **False positive (visually similar cards collide).** Two Pokémon cards with very similar art (reprints, parallel sets) can land within 8 bits. Mitigations: (a) the existing hint mechanism lets users override, (b) `/api/report-bad-id` evicts the offending hash from the index, (c) tune `PHASH_HAMMING_MAX` down if FP rate is unacceptable in practice.
- **Crop vs. full-card framing variance.** A binder-cell crop and a full single-scan crop of the same card produce different pHashes. Not a bug — the hash → identity map is many-to-one, so write-through naturally accumulates both framings against the same card. Both will hit on subsequent scans.
- **Phantom-cell crops from binder CV** (e.g. an energy-card edge mistakenly cropped as a card). The write-through gate (Sonnet confidence ≥ 0.85) keeps these out of the index.
- **Disk growth.** 25k × ~80 B ≈ 2 MB. Trivial against the 1 GB Render disk.
- **Boot-time load.** ~50 ms to parse 2 MB JSON. Done once at server start; no request-path cost.

## Test plan

- `tests/regression/phash.spec.js` — synthetic buffers via Sharp. Assertions:
  - `computePhash(b)` deterministic (same buffer → same hash).
  - Identical buffers → distance 0.
  - 1-pixel shift → distance ≤ 4 (sanity: small visual change → small Hamming change).
  - Two distinct synthetic patterns → distance ≥ 20.
- `tests/regression/phash-lookup.spec.js` — pure function with in-memory mock `_index`:
  - Hit case: known hash → returns card.
  - Miss case: random hash → returns `null`.
  - Threshold edge: distance == threshold → hit; distance == threshold+1 → miss.
- No Anthropic round-trip. No network. No disk fixtures.

## Rollout

1. **PR 1** (owner: implementer): `pricing/phash.js` module + tests + `scripts/build-phash-db.js` crawler. Crawler not yet run. No wiring into `identifyCore`. (owner for tests: test-engineer, in parallel.)
2. **Run crawler** against Render disk (or locally then upload `card-phashes.json` to `/opt/render/project/data/`). Spot-check 5 known cards manually — compute pHash of a re-scan, confirm `lookupByPhash` returns the right identity.
3. **PR 2** (owner: implementer): wire `loadIndex()` into `apps/server/server.js` boot path; wire `computePhash` + `lookupByPhash` + `addToIndex` into `identifyCore`. Server-only change — no SW cache bump.
4. **Verify** (owner: reviewer + test-engineer): code review, regression suite, smoke test against staging.
5. **Memory write** once shipped: append `memory/decisions.md` entry, and add `pricing_phash` section to `memory/patterns.md` if conventions emerge (e.g. BigInt-as-hex serialisation).

## Success criteria

- pHash hit rate ≥ 30% on binder uploads after the index has been seeded and one week of write-through accumulation. (Measured via the `source: 'phash'` tag in identify responses / logs.)
- p50 latency on pHash hits < 5 ms vs. ~1500 ms for Sonnet calls — i.e. measurable end-user speedup on grid uploads.
- Zero regression in identification correctness on the existing test set (no new false positives that survive the write-through gate).
- No measurable boot-time regression (load < 200 ms).

## Open questions

- **Existing high-confidence threshold constant name.** `pricing/confidence.js` may already export the band we want for `PHASH_WRITE_MIN`. Implementer to check during PR 1 and reuse rather than introducing a parallel constant. If absent, add `PHASH_WRITE_MIN = 0.85`.
- **Crawler runtime location.** Run on dev box and upload, or run on Render shell? Dev box is faster to iterate; Render shell avoids a 2 MB upload step. User decision (low-stakes — either works).

## Out of scope (explicit)

- OCR-first identification path. It bypasses `identifyCore` and is gated off; integrating pHash there is a separate follow-up.
- Cross-game pHash (Lorcana, MTG). Pokémon only for V1.
- User-facing toggle to disable pHash. Add only if FP reports surface.
