# V3 Phase 0 — Retrieval Benchmark

**Status: GATE RE-RUN ON A CORRECTED CATALOGUE — 76.6% top-1, 96.1% on matchable cards.**
**Date: 6 August 2026 · Branch: `v3` · Catalogue: 20,427 Pokémon cards**
**§13 supersedes §12. The 45.3% in §12 was measuring a catalogue bug, not a matcher.**

Every number below comes from a measurement run on this machine against the full
catalogue. Nothing is estimated or carried over from V2 documentation.

§12 is the gate result, measured on 64 real photographs of the operator's own
stock. Everything before it is synthetic and was, as predicted, optimistic:
57.3% synthetic against 45.3% real.

---

## 1. Summary

The brief's approach (a) — multi-hash (pHash/dHash/wHash) on the auto-cropped
art — was measured end to end. **It does not reach the ~90% top-1 bar, and it is
not close.**

| pipeline (all measured, this phase) | top-1 | top-10 |
|---|---:|---:|
| production today — `cropToCard` + hash ensemble | **1.0%** | 3.5% |
| + OpenCV quad detection & perspective warp | **40.5%** | 53.5% |
| + DINOv2-small `cls` embeddings instead of hashes | **52.7%** | 69.3% |
| + bottom-right re-rank, gated on cosine ties | **57.3%** | 69.3% |
| target | ~90% | — |

Three findings, all actionable:

1. **On a realistic scene the production pipeline scores 1.0%.** `cropToCard`
   is a `.trim()` heuristic with nothing uniform to trim once a card sits on a
   table rather than filling the frame. This is a live production defect.
2. **Perspective rectification is the single largest lever** — 1.0% to 40.5%.
   It was built and verified during this phase (`scripts/v3-bench/rectify.js`,
   OpenCV-WASM, runs in Node and the browser).
3. **Approach (b) beats approach (a) decisively but does not close the gap.**
   DINOv2 `cls` embeddings add 14.7 points over the hash ensemble. Best
   configuration reaches 57.3% against a ~90% bar.

Loss decomposition (§6.4) shows the pipeline itself is sound — identity queries
return 98% — and that geometry and lighting each cost ~20-25 points and compound.
To reach 90%, each would have to cost under 5.

**Synthetic evaluation has now given what it can.** It has firmly established the
ordering, and that ordering will not reverse on real photographs. What it cannot
establish is whether 57.3% is pessimistic or optimistic, because that depends
entirely on whether the simulated distortions resemble a real venue. Further
tuning against them would be overfitting to invented data.

Recommendation in §8.

---

## 2. Catalogue acquisition

`scripts/v3-bench/fetch-refs.js`, operator machine, concurrency 16.

| | |
|---|---|
| Cards cached | 19,890 of 19,938 (99.8%) |
| Source bytes | 2.88 GB (`images.pokemontcg.io` `small` rendition) |
| Cached bytes | 489 MB (245×342 WebP q90) |
| Wall clock | 8.4 min + 8.6 min gap-fill |
| Sustained rate | 167 cards/s, 26.5 MB/s |
| Per card | 161.7 KB source → 27.5 KB cached |

**The brief's "roughly a 20× bandwidth saving" from `small` is wrong: it is ~5×.**
Measured across five eras, `small` is 151–176 KB and `large` is 558–878 KB. Still
worth doing — 2.9 GB rather than ~14 GB — but a fifth of the assumed saving.

**The brief's "60–75 min" crawl estimate is also wrong: it is ~8 min.** That
figure came from concurrency 2 on a box also serving traffic.

### 2.1 The crawler had a silent data-loss bug

`pokemontcg.io` was returning intermittent HTTP 500/502 on valid requests —
measured at roughly 40% failure on `?pageSize=250`, with the identical request
succeeding on retry. `scripts/build-phash-db.js` has **no retry anywhere**: one
500 and it logs `skipping entire set` and drops ~120 cards silently.

Across two runs, 210 requests needed 484 extra attempts. Without retry those are
whole-set losses. **This alone is sufficient to explain an index that never
filled**, independent of the OOM story in the brief.

Fixed in `fetch-refs.js` (6 attempts, exponential backoff, retry only on
5xx/429/network). `build-phash-db.js` still lacks it — see §9.

---

## 3. Intrinsic separability (no photographs required)

Before accuracy can be measured, a cheaper question: how far is each card from
its *nearest other card*? A photo must match its true card more tightly than
this margin, so it caps the confidence threshold we could ever ship.

`scripts/v3-bench/build-descriptors.js`, all 19,890 cards, 1,500-card stride
sample for nearest-neighbour.

| family | distinct | colliding | rate | nnMin | p01 | p05 | p25 | median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| full-phash | 19,634 | 493 | 2.48% | 0 | 0 | 2 | 8 | 10 |
| full-dhash | 19,754 | 263 | 1.32% | 0 | 0 | 3 | 8 | 10 |
| full-whash | 19,487 | 751 | 3.78% | 0 | 0 | 2 | 4 | 7 |
| art-phash | 19,604 | 548 | 2.76% | 0 | 0 | 2 | 14 | 14 |
| art-dhash | 19,713 | 337 | 1.69% | 0 | 0 | 2 | 13 | 14 |
| art-whash | 19,540 | 644 | 3.24% | 0 | 0 | 2 | 6 | 10 |

Readings:

- **Art-box cropping nearly doubles separation for distinct cards** (p25 rises
  from 8 to 14 bits). It is the better retrieval descriptor.
- **wHash is the weakest family** on every measure and should be dropped.
- **~2% of cards have an exact twin** — Hamming distance 0 from a different card.
  No threshold can separate those. See §4.

---

## 4. Reprints: cards that are genuinely the same picture

127 twin groups covering 263 cards (1.32% of catalogue), 144 cross-set pairs.

```
base2-23 "Nidoqueen"       ==  base6-32  "Nidoqueen"
base4-81 "Metapod"         ==  base6-54  "Metapod"
bw7-49   "Keldeo-EX"       ==  bw11-45   "Keldeo-EX"
bw8-18   "Victini-EX"      ==  bw11-24   "Victini-EX"
base4-128 "Lightning Energy" == gym1-130 "Lightning Energy"
```

These are not hash failures. They are reprints sharing artwork; the only
differences are the set symbol, copyright line, and card number — a few dozen
pixels on a 245×342 render.

**Commercial severity is lower than the raw rate suggests.** The great majority
are bulk: basic Energy, `Switch`, `Poké Ball`, `Rare Candy`, Fossils, Base-era
commons. In the fast lane the question is "bulk, or worth a look?" and the wrong
set's Rare Candy does not change that answer. But it is not *only* bulk —
`Keldeo-EX` and `Victini-EX` reprinted into Legendary Treasures are real money.

### 4.1 Where reprints differ, measured

`scripts/v3-bench/twin-regions.js` — mean per-cell difference over 144 pairs:

```
 68|:--=============++====--|   attack / weakness band
 88|-=------=====-=======--:|
 91|-==------====--======+*-|   copyright / illustrator
 94|-*@****+===--=====****@-|   card number + set total   <- peak
```

Signal concentrates in the **bottom 6–9% strip**. Candidate crop regions scored
by mean absolute difference (higher = better separation):

| region | meanMAD | medMAD | %pairs still <2 |
|---|---:|---:|---:|
| full-card | 2.01 | 0.99 | 75.0 |
| art-box | 2.29 | 1.08 | 68.1 |
| lower-third | 4.55 | 2.78 | 43.8 |
| bottom-strip | 5.06 | 2.45 | 36.1 |
| **bottom-right** | **8.94** | **5.89** | **14.6** |
| symbol-classic | 4.76 | 2.90 | 42.4 |

**`bottom-right` separates 4.4× better than whole-card.** A hand-placed
set-symbol box scored *worse*, which says symbol position varies too much across
eras to hard-code.

Caveat: this is measured on clean aligned renders where `bottom-right` is only
~103×34 px. It establishes that the information exists, not that a phone can
read it.

---

## 5. Ablation: what actually costs accuracy

### 5.0 Methodology correction — earlier numbers superseded

An initial pass reported 53.7% / 32.3% top-1. **Those figures are withdrawn.**
The synthetic generator was feeding a bare card filling the whole frame, with no
background. That is not what a capture looks like, and it flattered every
strategy that simply resizes the frame — there was nothing around the card to
confuse them.

The generator now composites the distorted card onto a **textured** background
(low-resolution noise, upscaled and blurred) at 1.10–1.45× card size. Texture
matters: a uniform background would let a `.trim()` heuristic succeed for the
wrong reason. Partial occlusion remains a deliberate separate bucket in the photo
set, not the default.

All numbers below are from the corrected generator, catalogue 19,890.

### 5.1 Normalisation strategy, head to head

`--synthetic 200`, full augmentation (geometry + photometry), top-1.

| normalisation | detection | top-1 | top-5 | top-10 | p50 latency |
|---|---:|---:|---:|---:|---:|
| `none` — bare resize | — | **0.0%** | 0.5% | 1.0% | 15.4 ms |
| `trim` — production `cropToCard` | — | **1.0%** | 2.5% | 3.5% | 33.8 ms |
| `rectify` — quad detect + warp | 85.5% | **40.5%** | 51.5% | 53.5% | 48.1 ms |

**On a realistic scene the production pipeline scores 1.0%. It does not work at
all.** Once the card sits on a background rather than filling the frame,
`cropToCard`'s trim heuristic has nothing uniform to trim, the art box lands on
background, and the hash is noise.

Rectification is the only strategy that functions. It is not a tuning
improvement over the existing approach; it is the difference between working and
not working.

### 5.2 Round-trip check — the index/query pipeline must match

Feeding **clean, unaugmented** references back in as queries should return 100%:

| normalisation | top-1 on clean input |
|---|---:|
| `rectify` | 90.0% |
| `trim` | 75.0% |

Neither reaches 100%, and that is a finding in itself: **the index is built by one
pipeline and queried through another.** The index takes the raw CDN render
straight to the art box; a query goes through normalisation first. Any framing
convention mismatch shifts every crop box and costs accuracy before a single real
distortion is applied.

On clean CDN renders `rectify` fires only 57.5% of the time — correctly, since
those images are already card-edge-to-edge with no background to find an edge
against — and the cases where it *does* fire are the ones that lose accuracy.

Closing this gap is the highest-value remaining work in §8.

### 5.3 A falsified hypothesis, recorded

Canny plausibly locks onto the inner edge of the card's coloured frame rather
than the outer physical edge, which would zoom the rectified face in and shift
every crop box. Tested by expanding the detected quad outward from its centroid:

| expansion | 0% | 2% | 4% | 6% |
|---|---:|---:|---:|---:|
| top-1 | **45.0%** | 36.7% | 31.7% | 29.2% |

Monotonically worse. The hypothesis is wrong and the detector is already locking
onto the true card edge. `QUAD_EXPAND` defaults to 0 and should stay there.

### 5.4 Historical: why `cropToCard` was never viable

### 5.1 `cropToCard` is the single largest defect

`pricing/phash.js:cropToCard` uses Sharp `.trim()` — which takes its background
colour from the top-left pixel and removes uniform border within a threshold —
followed by a fixed 5% inset.

On clean CDN renders it is a near-noop, which is exactly why it survived review.
On anything distorted, the trim decision changes unpredictably: sometimes it cuts
deep, sometimes not at all. The fixed inset then lands the art box **in a
different place on every capture**. It is not a weak crop, it is a randomiser,
and unstable framing produces an unstable hash.

**Three independent reasons the pHash fast path never worked**, any one
sufficient:

1. The index was never populated (§2.1).
2. The early return is gated on `reference_image` being present
   (`pricing/identify-core.js`).
3. Even with both fixed, `cropToCard` would have prevented the hashes matching.

Anyone "turning the fast path on" without fixing (3) will see it fail and
conclude retrieval does not work.

---

## 6. Two-stage retrieval

Stage 1: art-box hash ensemble (summed Hamming over pHash+dHash+wHash) → top-10.
Stage 2: `bottom-right` signature (16×16 uint8, L1 distance) re-ranks.

| | stage 1 top-1 | top-5 | top-10 | stage 2 top-1 | net |
|---|---:|---:|---:|---:|---:|
| crop on | 32.3% | 44.3% | 50.0% | 33.7% | +4 queries |
| crop off | 53.7% | 62.7% | 65.0% | 54.3% | +2 queries |

**Stage 2 must be gated on ambiguity.** Applied to every query it was strictly
harmful — it fixed 9 and broke 74, a net loss of 65. The bottom-right region is
small and framing-sensitive, so on a distorted query it is noisier than the
art-box ensemble. Restricted to candidates within 2 bits of the best stage-1
distance, it becomes mildly positive.

That is the honest verdict on the reprint fix: **real, but worth ~1 point, and
only once geometry is stable.**

### 6.1 Latency and index size

| | |
|---|---|
| p50 / p95 per query | 15.7 ms / 44.1 ms (single-thread Node, full linear scan) |
| Dominant cost | image decode + hashing, not the scan |
| Descriptor artifact (JSON) | 10.8 MB |
| Binary-packed, retrieval only | ~716 KB (3×8 B hashes + id) |
| Binary-packed, with stage 2 | ~5.8 MB (+256 B/card signature) |

Index size is **not** a constraint. Hashes were bit-packed into paired
`Uint32Array`s with a 16-bit popcount table; production's `BigInt` linear scan
(`pricing/phash.js:lookupByHashes`) would be far too slow in a browser at frame
rate, and B2 will need this shape.

---

### 6.3 Approach (b) — learned embeddings

`scripts/v3-bench/build-embeddings.js`. DINOv2-small via transformers.js, 384-d,
int8-quantised, 19,890 cards in 10.9 min. Chosen over CLIP because CLIP optimises
SEMANTIC similarity and would happily co-locate two different Charizard cards —
precisely the confusion we cannot afford.

Stage 1 comparison, 150 synthetic queries, all through rectification:

| stage 1 | detection | top-1 | top-5 | top-10 | p50 |
|---|---:|---:|---:|---:|---:|
| hash ensemble (pHash+dHash+wHash) | 90.0% | 38.0% | 48.7% | 52.7% | 51 ms |
| **DINOv2 `cls`** | 90.0% | **52.7%** | **66.7%** | **69.3%** | 81 ms |
| DINOv2 `mean` | 90.0% | 38.7% | 54.7% | 61.3% | 80 ms |

`cls` is the descriptor. `mean` pooling is no better than hashing.

Independent evidence for `cls`, on the reprint twins that hash to distance 0:

| pair | `cls` cosine | `mean` cosine |
|---|---:|---:|
| same card (control) | 1.0000 | 1.0000 |
| twin Keldeo-EX | 0.9899 | 0.9957 |
| twin Nidoqueen | 0.9668 | 0.9816 |
| twin Metapod | 0.9485 | 0.9766 |
| different (Charizard / Palkia) | 0.4727 | 0.7839 |

Unlike the hashes, DINOv2 does **not** collapse reprints to identical — there is
residual signal where a perceptual hash has none. `cls` also has roughly double
the dynamic range of `mean` on genuinely different cards.

### 6.4 Where the loss actually is

DINOv2 `cls`, 100 queries each:

| condition | top-1 | detection |
|---|---:|---:|
| identity — no distortion, no crop | **98.0%** | — |
| identity through rectification | 94.0% | 51.0% |
| lighting / blur / glare only | 80.0% | 36.0% |
| rotation / shear / framing only | 75.0% | 92.0% |
| both | 52.7% | 90.0% |

98% on identity confirms there is no systematic pipeline defect distorting the
rest. The two distortion families cost ~20-25 points each and compound roughly
multiplicatively.

Low detection under lighting-only is expected, not a fault: that condition
applies no geometry, so the card fills the frame with no background to find an
edge against, and rectification correctly falls back.

### 6.5 Stage 2, finally useful

The ambiguity gate was in Hamming bits, which silently disabled stage 2 entirely
on the embedding path — the reprint disambiguation never fired on the winning
approach. Re-gated in cosine units (0.02 window, sized from the 0.95-0.99 twin
separation measured above):

| | top-1 |
|---|---:|
| stage 1 only | 52.7% |
| + gated bottom-right re-rank | **57.3%** |

Fixed 12 queries, broke 5, net +7. This is the first configuration in which
stage 2 has been meaningfully positive, and it validates §4.1's region choice —
but only once geometry is stable and the gate is in the right units.

### 6.6 Two falsified hypotheses, recorded

Both were plausible, both are wrong, and both are recorded so nobody spends a
day rediscovering them.

**Quad expansion.** Canny might lock onto the inner edge of the card's coloured
frame rather than the outer physical edge. Expanding the detected quad outward:

| expansion | 0% | 2% | 4% | 6% |
|---|---:|---:|---:|---:|
| top-1 | **45.0%** | 36.7% | 31.7% | 29.2% |

Monotonically worse. The detector already locks onto the true edge.
`QUAD_EXPAND` defaults to 0 and should stay there.

**Contrast normalisation.** Lighting is the larger loss term, so histogram-
stretching both index and query before embedding should help. It does not:

| | top-1 (stage 1) |
|---|---:|
| raw | **52.7%** |
| contrast-normalised both sides | 45.3% |

Normalisation discards absolute tone information that DINOv2 is evidently using.
`embeddings-norm.json` is retained for reference but is not the shipping index.

---

## 7. What these numbers are not

The accuracy figures come from augmented reference images, not photographs. They
overstate real performance for three reasons:

1. **The query derives from the same image as the index entry.** Only the
   distortions I chose to simulate are being tested.
2. **Sharp has no homography**, so tilt is approximated with affine shear plus
   rotation. That understates true perspective foreshortening.
3. **The augmentation is mild** — ±6° rotation, ±0.10 shear, ±6% framing, ±20%
   brightness. Real hand-held capture at a show is worse.

Sleeve haze, holo rainbow shift, print wear, motion blur and partial occlusion
are not represented at all. **The gate result requires the operator's
photographs** (`docs/V3_BENCHMARK_PHOTOS.md`). `evaluate.js --photos` runs the
identical pipeline against them.

---

## 8. Recommendation

**Do not begin Phase 1 as specified.** Even with rectification built, approach
(a) reaches 40.5% top-1 against a ~90% bar. Building the browser matcher, scan
loop and offline pricing on top of that descriptor would be building on sand.

Three things, in order:

**1. Perspective rectification — BUILT, this phase.**
`scripts/v3-bench/rectify.js` detects the card quad (Canny → contours →
`approxPolyDP` → convex 4-gon, filtered on area, aspect and frame-hugging) and
warps it onto a canonical 245×342 via `getPerspectiveTransform`. Runs on
@techstark/opencv-js — the same WASM build that runs in the browser, so this is
B2's code rather than a Node-only prototype. Verified visually across six eras
(`~/.card-pricer-v3/diag/sheet.jpg`) as well as numerically.

Result: **1.0% → 40.5% top-1**, detection firing 85.5% of the time. It is not an
improvement on the existing approach; it is the difference between working and
not working. Porting it into `pricing/` to replace `cropToCard` is a production
bug fix and should not wait for the rest of V3.

**2. Approach (b) — MEASURED, this phase.** DINOv2-small `cls` beats the hash
ensemble by 14.7 points (§6.3) and is the descriptor to carry forward. The
dependency question is therefore settled: V3 ships **7.3 MB of embeddings plus an
ONNX runtime**, not a 716 KB hash index. ORB was not benchmarked — at ~16 KB/card
it is ~320 MB across the catalogue and cannot ship to a browser under any
configuration, so its ceiling is not actionable.

**3. The gap is still ~33 points, and synthetic data cannot close it.** The three
remaining levers, in the order I would try them:

- **Detection rate.** 90% under full distortion; every miss is an automatic wrong
  answer, so this is ~10 points of pure loss with no descriptor involvement.
- **Index-side augmentation.** Embed each reference under several distortions and
  index all of them. Standard practice for retrieval robustness, and it attacks
  the compounding in §6.4 directly. Costs build time and index size (K x 7.3 MB),
  and carries a real risk of tuning to invented distortions — **do this only
  against real photographs**, never against the synthetic set.
- **A larger backbone.** DINOv2-base over -small, at roughly 4x the inference
  cost and 2x the descriptor width. Worth measuring only once the above are done.

**Do not tune further against synthetic queries.** The ordering is established
and will not reverse. The magnitude is not, and cannot be, until photographs
exist.

### 8.1 The fixed-rig alternative — DECLINED for now

**Operator decision, 4 Aug 2026: hand-held, no rig.** Recorded here because it
constrains everything downstream — the descriptor must absorb geometry and
lighting variance rather than having it removed at the source. Revisit if
approach (b) also falls short.

Original reasoning retained: **geometry is the dominant loss term**, and a fixed rig removes it at the source. Phone on a stand,
marked card stage, constant LED. Cards are placed rather than flicked past — the
capture is always square, always the same distance, always the same light.

That is likely to be worth more than any descriptor work, and it is cheap. The
cost is to the operating model: §6 of the brief envisages flicking cards past a
camera at 1–2 s each, and a rig means placing each card on a stage instead. That
is a business call about throughput versus accuracy, and it is the operator's to
make. It should be made **before** committing to the descriptor, because a fixed
rig would make approach (a) viable and make the CNN unnecessary.

---

## 9. Follow-ups outside this phase

| item | where | note |
|---|---|---|
| No retry in the production crawler | `scripts/build-phash-db.js` | silently drops whole sets; port the `fetch-refs.js` backoff |
| Hash used as `Map` key | `pricing/phash.js:addToIndex` | colliding cards silently overwrite each other; ~2% of catalogue affected |
| `BigInt` linear scan | `pricing/phash.js:lookupByHashes` | too slow for browser frame rate; bit-pack |
| `cropToCard` | `pricing/phash.js` | **FIXED, behind a flag** — see §11 |
| Celebrations #4 mis-match | `pricing/identify-core.js` | **not** an image problem: `base1-4` vs `cel25-4` sit at d=27, trivially separable. Pure bare-number fallback bug. B6's fix resolves it fully. |
| Supabase paused | project `vecbaewlxodqnevduoiy` | `INACTIVE`; blocks all DB-backed testing |

---

## 10. Reproducing

Build the artifacts (all resumable — they checkpoint, because a long build that
only flushed on completion lost 12,000 cards to a kill):

```bash
node scripts/v3-bench/fetch-refs.js          # ~17 min, 2.9 GB
node scripts/v3-bench/build-descriptors.js   # ~10 min  -> descriptors.json (hashes + stage-2 sigs)
node scripts/v3-bench/build-embeddings.js    # ~11 min  -> embeddings.json  (DINOv2 cls + mean)
node scripts/v3-bench/build-variants.js      # ~30 min  -> variants.json    (framing variants; OPTIONAL, not yet measured)
node scripts/v3-bench/twin-regions.js        # reprint analysis
```

**The gate result**, once photographs exist in `~/.card-pricer-v3/photos`:

```bash
node scripts/v3-bench/validate-photos.js                       # check labels FIRST
node scripts/v3-bench/evaluate.js --photos --rectify --embeddings cls
```

Note `--rectify` is not the default; without it the gate run would go through
`cropToCard` and measure the broken path. Ablations:

```bash
node scripts/v3-bench/evaluate.js --synthetic 150 --rectify --embeddings cls
                                  [--no-crop|--no-aug|--geo-only|--photo-only]
                                  [--embeddings mean|--variants]
EMB_NORMALISE=1 ...   # uses embeddings-norm.json; measured WORSE, see §6.6
```

---

## 12. GATE RESULT — real photographs

64 photographs of the operator's stock, shot hand-held on a Galaxy S26 Ultra:
cards on a dark table, sleeved, arbitrary rotation, venue-ish lighting. Ground
truth by human verification in `review.js` — the operator confirmed or rejected
the proposed candidates, so a rank-3 pick counts as a top-1 miss and "not here"
counts as a miss at every k.

```
stage 1 top-1  : 45.3%
stage 1 top-5  : 45.3%
stage 1 top-10 : 45.3%
quad detected  : 54/64 (84.4%)
latency p50    : 256 ms
```

**Synthetic was optimistic by 12 points** (57.3% -> 45.3%), which is the expected
direction and the reason §7 refused to treat it as a gate.

### 12.1 There is no near-miss middle ground

top-1 == top-5 == top-10. Every card the operator recognised was already at
rank 1; nothing was ever "close". The system either identifies the card outright
or it is nowhere in the top ten. That is unusual and useful: it means widening
the candidate list buys nothing, and a re-ranking stage has nothing to work with.
Stage 2 accordingly changed no outcome at all (+0 queries).

### 12.2 Where the 35 misses come from

| | count |
|---|---:|
| quad detection failed — automatic miss | 10 |
| detection fine, retrieval failed | 25 |

All 29 correct matches had successful detection. Accuracy **among the 54 photos
where detection worked is 53.7%**, so detection is worth up to ~16 points and
retrieval is the larger gap.

Note an unquantified confound: at least one photographed card (`Antique Armor
Fossil`, 072/084) is **absent from the catalogue** — the index holds its siblings
`Antique Jaw Fossil` and `Antique Dome Fossil` but not it. Some share of the 25
retrieval failures may be catalogue holes rather than matcher failures, which
would mean 45.3% understates retrieval quality. Distinguishing the two needs the
true identity of each miss, which the review flow does not capture by design.

### 12.3 The system knows when it is right

Cosine of the best match, split by outcome:

| outcome | n | detection | min | median | max |
|---|---:|---|---:|---:|---:|
| correct | 29 | 29/29 | 0.698 | **0.850** | 0.909 |
| miss | 35 | 25/35 | 0.229 | **0.660** | 0.768 |

The distributions barely overlap. Auto-accepting above a cosine threshold and
falling back to Sonnet below it:

| threshold | accepted | correct | precision | wrong auto-accepts |
|---:|---:|---:|---:|---:|
| 0.70 | 36/64 | 28 | 77.8% | 8 |
| 0.72 | 31/64 | 26 | 83.9% | 5 |
| 0.74 | 27/64 | 25 | 92.6% | 2 |
| **0.78** | **20/64** | **20** | **100.0%** | **0** |
| 0.85 | 15/64 | 15 | 100.0% | 0 |

**At cosine >= 0.78: 31% of cards identified locally with zero errors.**

This is the most important result in the document. The brief's target is >=95% of
cards never touching the API; 31% is a long way short. But it is not a dead end,
because the failure mode is *abstention*, not *wrong answers* — and a wrong
answer is the only kind that costs money on a buy-list. The two-lane
architecture works today at 31% coverage; the open question is how far coverage
can be pushed, not whether the shape is right.

### 12.4 Verdict

**Gate not cleared.** Do not start Phase 1 as specified.

Ranked by measured value:

1. **Catalogue coverage audit.** Cheapest and currently unquantified. If a
   material share of the 25 retrieval failures are missing cards, no descriptor
   work fixes them and the true retrieval rate is higher than reported.
2. **Detection: 84.4% -> as close to 100% as possible.** 10 automatic misses,
   worth up to ~16 points, and independent of the descriptor.
3. **Retrieval on detected cards: 53.7%.** The largest gap. Index-side
   augmentation is the standard remedy and can now be fitted against real
   photographs rather than invented distortions.
4. **Ship the confidence threshold regardless.** 0.78 gives free, error-free
   identification on a third of cards with the existing Sonnet path untouched
   beneath it.

---

## 13. GATE RESULT — corrected catalogue, re-reviewed labels

§12's 45.3% was measured against a catalogue missing three released sets,
including `me5` (Pitch Black), which dominated the photo set. Set discovery read
the artifact it was building, so new releases were structurally uncrawlable
(fixed; see the commit history). With the catalogue corrected to 20,427 cards
and the operator's "not here" labels re-reviewed — 22 of 35 flipped to a
confirmed card — the same 64 photographs give:

```
stage 1 top-1  : 75.0%
stage 1 top-5  : 79.7%
stage 2 top-1  : 76.6%      (bottom-right re-rank, +1 query)
quad detected  : 56/64 (87.5%)
latency p50    : 273 ms
```

**On the 51 photographs where the operator confirmed a card: 49 correct — 96.1%.**
The other 13 are still marked "not here": cards absent even from the corrected
catalogue (e.g. `Brock's Sudowoodo`) or illegible. They score as misses, which
is why the all-photos figure is 76.6% and the matchable figure is 96.1%. Quote
whichever answers the question being asked, but never the first without the
second.

### 13.1 Every remaining error is one reprint pair

Both misses on confirmed cards are the same card:

```
truth  sv10-35     Ethan's Slugma  [Destined Rivals]
got    me2pt5-23   Ethan's Slugma  [Ascended Heroes]   (true card at rank 2)
```

This is §4's reprint failure mode exactly — two prints sharing artwork — and it
only appeared because `me2pt5` was one of the sets just added. Adding a set
creates the confusion it should create. Note the true card is at **rank 2**, so
it is a near-miss, not an absence.

### 13.2 Near-misses have reappeared — an earlier conclusion was wrong

§12.1 reported top-1 == top-5 == top-10 and concluded there was "no near-miss
middle ground", so widening the candidate list bought nothing. **That was an
artifact of the catalogue holes**: a card not in the index cannot appear at
rank 2. With the catalogue corrected, top-5 (79.7%) now exceeds top-1 (75.0%),
and stage 2 converts one of those near-misses. Any reasoning that treated
re-ranking as pointless should be revisited.

### 13.3 The margin gate more than doubles zero-error coverage

Auto-accepting on absolute score alone:

| threshold | accepted | precision | wrong |
|---:|---:|---:|---:|
| 0.741 | 45/64 | 95.6% | 2 |
| 0.798 | 37/64 | 97.3% | 1 |
| 0.855 | 24/64 | 95.8% | 1 |
| **0.876** | **11/64 (17.2%)** | **100%** | **0** |

One wrong answer survives to 0.876 — the Slugma reprint, which scores 0.876
with a runner-up gap of just 0.026. Adding a margin condition removes it:

| gate | accepted | correct | wrong |
|---|---:|---:|---:|
| score ≥ 0.850 | 27/64 | 26 | 1 |
| score ≥ 0.850 **and margin ≥ 0.05** | **25/64 (39%)** | **25** | **0** |

Correct matches above 0.80 carry a median margin of 0.129; the reprint error
carries 0.026. **Ship the two-condition gate**: 39% of cards auto-identified
with no wrong answers, against 17.2% on score alone. This is the single
cheapest coverage gain available and it needs no model change.

### 13.4 Verdict

The ~90% bar is met on matchable cards (96.1%) and not met on the full photo
set (76.6%), and the gap between those two numbers is catalogue coverage, not
matcher quality. Ranked by measured value:

1. **Catalogue completeness is the dominant term.** It moved the headline from
   45.3% to 76.6% with no change to the descriptor. The freshness automation in
   §D of the reliability plan is therefore accuracy work, not hygiene.
2. **Ship the score+margin gate** (§13.3) — 39% zero-error coverage today.
3. **Reprint disambiguation is now the top *matcher* problem**, and it is the
   only one left on confirmed cards. Stage 2 exists for it and is converting
   only one query; the bottom-right region measured 4.4× better separation on
   reprints, so it is under-exploited rather than wrong.
4. Detection at 87.5% remains ~8 automatic misses.

### 13.5 What this still cannot tell you

The sample is 64 photographs from one 115-second session, one table, one
lighting condition, roughly 40 distinct cards, dominated by one set. "Zero
errors at the two-condition gate" is 25/25 — no observed errors, not a bounded
error rate. The stratified session in the plan (§B5) remains the prerequisite
for trusting any threshold in production.

---

## 11. Production port — `CARD_RECTIFY`

The rectifier is ported into production as `pricing/card-rectify.js`, and
`cropToCard` now prefers it. This is a bug fix, not a V3 feature: it improves
any image-matching path regardless of whether V3 ships.

**It is off by default.** Enable with:

```
CARD_RECTIFY=1
```

Safety properties, each asserted in `tests/regression/card-rectify.spec.js`:

- With the flag unset, `cropToCard` behaves exactly as before — the basis for
  calling this safe, so it is tested rather than assumed.
- OpenCV is imported **lazily and optionally**. A missing module or a WASM
  runtime that will not start degrades to `null`, and `cropToCard` falls back to
  its original `.trim()` path. A missing optional dependency cannot break
  production.
- Nothing throws. No card found, corrupt buffer, empty buffer, non-image bytes —
  all return a fallback, because a scanner must not crash on a bad frame.
- The 600×840 output contract holds on every path, flag on or off.

Verified: 574 tests pass with the flag off (566 pre-existing + 8 new), and the
33 existing `cropToCard`/pHash regression tests also pass with the flag **on**.

`@techstark/opencv-js` moved from `devDependencies` to `dependencies` — it is
imported by production code, and left in dev it would silently no-op on Render.
Because the import is lazy there is no memory or startup cost while the flag is
off.

Note the pHash fast path is currently inert anyway (the index is unpopulated,
§2.1), so enabling this changes nothing observable until an index exists. That
makes it a low-risk flag to turn on early and watch.

---

Cache lives at `~/.card-pricer-v3` — deliberately outside the repo and outside
OneDrive. It holds third-party card artwork and is a benchmark artefact only:
never committed, deleted when Phase 0 closes. The shipped index contains
descriptors, not pictures.
