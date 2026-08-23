# V3 evidence — the measurements behind the conclusions

Every "Falsified — do not retry" entry in `CLAUDE.md` and every numbered result
in `docs/V3_BENCHMARK.md` was produced by a run whose output is in this folder.
Until now those outputs existed in exactly one place: `~/.card-pricer-v3/` on a
single Windows laptop, outside the repo, outside OneDrive, and outside any
backup. Losing them would have meant re-running experiments already paid for —
and, worse, being unable to check a claim without re-running it.

These are numbers, not pictures. The 64 benchmark photographs and the 599 MB of
reference card art stay out of git deliberately: art is third-party copyright
(`CLAUDE.md` — store fingerprints, not artwork) and the photographs are large.
The photographs are irreplaceable and are backed up separately; the reference
art is a re-fetchable cache and is not backed up at all, by design.

## What is here

| file | what it is | cited by |
|---|---|---|
| `eval-vision-sonnet46.json` | Per-photo reads from Sonnet 4.6 over the 51 confirmed-label photographs | §16, §18, §20 |
| `eval-vision-gemini-3-flash-preview.json` | The same 51 photographs, same prompt, same verifier, Gemini 3 Flash | §17, §18, §20 |
| `eval-vision-haiku45.json` | The same 51, Haiku 4.5 — 0/51 collector numbers, at self-reported confidence 0.92 | §20 |
| `eval-vision.json` | Summary of the most recent `eval-vision.js` run | §16 |
| `evaluation.json` | Embedding retrieval scores across the strategy sweep | §5, §6, §13 |
| `separability.json` | Intrinsic separability of the catalogue, computed with no photographs | §3 |
| `phash-sweep.json` | The pHash threshold sweep. Three accept rules, all failing identically | §15 |
| `miss-audit.json` | Per-photo miss decomposition | §12.2, §6.4 |
| `miss-audit-undetected.json` | The 8 detection failures — cards clipped by the frame edge | §12.2, §19 |
| `twin-regions.json` | Where genuine reprints differ, measured region by region | §4.1 |
| `gate-rows.json` | Per-photo accept-gate rows behind the precision/coverage curve | §13.3, §14 |
| `variants.json` | The variant/augmentation expansion used by the centroid work | §14 |
| `photo-labels.json` | Human-confirmed labels for all 64 photographs. 13 are `__none__` | §13, §1.1 of the plan |
| `*.log` | Crawl and embedding-build logs, including what was skipped and why | §2.1 |

`*.log` is gitignored repo-wide, so these were added with `git add -f`. That is
deliberate: a build log that records **what a crawl skipped** is evidence, not
noise.

## The one caveat that travels with all of it

The sample is **64 photographs, 51 with a confirmed positive label**, from one
session, one photographer, one lighting setup, mostly two sets (Pitch Black and
Destined Rivals). It is not stratified. `photo-labels.json` carries no index
version, so a `__none__` label means "not in the candidate list I was shown at
the time" and does not survive an index rebuild.

Numbers from this set establish an *ordering* reliably. They do not bound an
error rate: 32/32 correct is no observed errors, which at n=32 bounds the true
rate only to roughly ≤11%. Quote them with the sample attached or not at all.
