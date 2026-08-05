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
