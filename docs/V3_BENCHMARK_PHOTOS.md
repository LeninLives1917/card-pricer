# V3 Phase 0 — Benchmark Photo Set

**Status:** awaiting operator capture
**Owner:** Dave (capture) → Master Architect (measurement)
**Blocks:** the Phase 0 evidence gate. No V3 implementation starts until this exists and the numbers are in `docs/V3_BENCHMARK.md`.

---

## Why this is the gate

V3 bets that a card can be identified by matching it against a catalogue we already hold, instead of asking Sonnet. That bet is only worth making if it works on *your* photographs — hall lighting, sleeves, holo glare, hand-held angles. It will look excellent on clean CDN renders and that result would mean nothing.

So the ground truth has to be independent of the system being tested. That is the entire reason for the naming convention below: the label comes from you looking at the card, not from any model.

---

## Naming convention

One file per photograph, named for the card it shows:

```
<set-id>-<number>.jpg
```

`set-id` and `number` are exactly the values in `data/card-db.json` — the same IDs pokemontcg.io uses.

```
photos/
  base1-4.jpg            Charizard, Base Set, #4
  base1-4_sleeved.jpg    same card, in a sleeve
  base1-4_angle.jpg      same card, shot at an angle
  base1-4_glare.jpg      same card, holo glare
  sv1-199.jpg            Scarlet & Violet #199
  cel25-4.jpg            Celebrations #4  (the card that got confused with base1-4)
```

Anything after an underscore is ignored. Shoot the same card several ways and give each a different suffix — that is *encouraged*, and it is how we measure robustness rather than just accuracy.

**Put them here:** `C:\Users\daith\.card-pricer-v3\photos\`
(deliberately outside OneDrive and outside the repo — these are large and must never be committed)

**Check your labels before you finish:**

```
node scripts/v3-bench/validate-photos.js
```

It resolves every filename against the card database and tells you which ones don't exist, which are duplicated, and how the composition breaks down. Run it early on your first twenty so you catch a habit-level mistake before it costs you 200 files.

---

## What to shoot — target ~250 photographs

Every photograph is **hand-held, under the lighting you'd actually have at a show**. No copy stand, no lightbox, no careful framing. If it looks like a product shot, it's the wrong photograph.

| Bucket | Target | Why it's in the set |
|---|---:|---|
| Bulk commons | ~120 | ~90% of real throughput. Shoot these fast and sloppy, at the cadence you'd actually flick cards. This bucket sets the fast-lane number. |
| Sleeved + holo/reverse-holo | ~80 | The known hard cases. Glare and sleeve haze are what break descriptor matching. Do not filter the bad ones out — they are the point. |
| High-value / chase cards | ~30 | Where a mis-ID costs real money. Small sample, but it dominates the false-positive analysis: a wrong match here is worth more than fifty right ones. |
| Deliberately awkward | ~20 | Partial occlusion (fingers over the art), steep angle, motion blur, two cards in frame, a card still in a binder pocket. These define where we must refuse to answer rather than guess. |

### Composition notes

- **Spread across eras.** Base Set through current. Old cards have different borders, print texture and wear; modern alt-arts have full-bleed art that behaves differently under the crop step.
- **Include near-twins on purpose.** Same Pokémon across different sets, and the same card in holo vs reverse-holo vs first-edition. This is exactly where the current system failed — it served a Celebrations #4 image for a Base Set #4 — and it is the discrimination we most need to measure.
- **Don't retake a bad photo.** If it came out blurry, keep it and suffix it `_blur`. A benchmark of only your good photographs measures your patience, not the system.

---

## What happens to these files

They stay on your machine. They are the measurement input for `docs/V3_BENCHMARK.md` and the seed of the regression suite B7 will own. They are never committed and never uploaded.

If the numbers come back below ~90% top-1, the recommendation will be the fixed-rig alternative — phone on a stand, marked card stage, constant LED — rather than pushing on. Controlled geometry removes most of the variance, and finding that out here is worth as much as a passing benchmark.

---

# Amendment — 15 Aug 2026

The spec above was written for a descriptor-matching pipeline. pHash is dead
(`V3_BENCHMARK.md` §15) and the reader is now a vision model, so the thing that
decides right-or-wrong has changed: it is **whether the collector number is
legible**, not whether the artwork is recognisable. That is a finer distinction
and it changes what the set has to contain.

Roughly 51 photographs of the original ~250 exist and are labelled. Everything
below is what is still needed, in shooting order — most valuable first, so
stopping early still leaves the important part done.

**Shoot with the phone's normal camera app at full resolution, not through the
scanner.** `apps/vendor/modules/capture.js` caps at 1600px wide. Keeping the
originals means any downscale can be simulated offline — including the open
question of whether a collector number survives at 1/9 of a binder page —
without asking for another session. Collect gate-free, simulate gates later.

## 1. The blur ladder — 60 photographs, 15 cards

The highest-value block. `SHARPNESS_MIN = 250` in `frame-gate.js` was fitted
in-sample and has never been validated against live video, and blur is the
largest measured error term we have: 69% of failures fell in the blurriest
third, and the sharpest third scored 88% against 68.6% overall.

Four shots of each of 15 cards:

| Suffix | What |
|---|---|
| `_s1` | sharp as you can hold it |
| `_s2` | slightly soft — the shot you take when rushing |
| `_s3` | clearly soft, number still readable by eye |
| `_s4` | too soft to read the number |

A threshold needs points either side of it. The current set is a cloud with no
ladder, which is why the number is a guess.

## 2. Cards absent from the catalogue — 30 photographs

The adversary with **n = 0** today: a sharp, well-framed photo of a card we do
not hold, next to a near-identical one we do. Every miss ever measured was a
ranking failure, so the abstention machinery has never faced the case it exists
for.

`node scripts/v3-bench/catalogue-gaps.js` checks the catalogue against **live**
upstream. As of 15 Aug 2026 it reports **zero gaps** — 174 sets, every card
held. So there is no shopping list to draw from pokemontcg.io, and absent cards
must come from outside its coverage:

- **Japanese printings** — the easiest source by far; upstream is English-only
- Korean / simplified & traditional Chinese
- Other games we do not catalogue to the same depth
- Jumbo / oversized cards, error cards, proxies

Name these `absent-01.jpg` … `absent-30.jpg`, with one line per card in
`absent.txt` (name + set as printed).

## 3. Binder pages — 30 photographs

Not in the original spec. Two implementations exist — `pricing/binder.js`
(model returns bounding boxes) and `pricing/binder-cv.js` (classical projection
profile) — and neither has ever been scored against a real binder photograph.

| Count | Shot |
|---:|---|
| 15 | full 9-pocket page, straight on |
| 5 | page tilted 20–40° |
| 5 | page with glare across the plastic |
| 3 | page with 2–4 **empty pockets** |
| 2 | 4-pocket page |

The empty-pocket pages matter most. One of the two routes asks the model what
it sees, and a model told to read a page will supply nine cards whether or not
nine are there — Haiku 4.5 already fabricated collector numbers at a
self-reported confidence of 0.92. That is the test.

**Fill the pages with cards already in the main set**, then the labels exist
already and each page needs only a companion `binder-01.txt` listing the nine
filenames in reading order.

## 4. Finish the original buckets — ~180 photographs

As specified above, minus what is already shot. Two additions:

- **A second lighting setup for roughly a third of them.** Everything measured
  so far is one table under one light, so nothing known about the system
  survives a change of venue.
- **Near-twins on purpose** — same Pokémon across sets, holo vs reverse vs
  first edition. Already called for above; restated because it is where the
  system has actually failed, and where `set-resolve.js` earns or loses its
  97.2% precision.

## Why the sample size

At ~51 photographs the 95% interval on a 70% accuracy estimate is about
±13 points, which cannot distinguish a real 5-point regression from noise.
At ~270 it is roughly ±5. That is the difference between 68.6% meaning
something and it being a number nobody can defend.
