# Card-Pricer — project rules

Node/Express + Supabase, deployed on Render. Serves a real shop.

## Commands

```bash
npm test                      # node --test, 760 specs. Must stay green.
node scripts/preflight.js     # run the night before a trade show
node scripts/build-phash-db.js  # catalogue crawl (fetches only what is missing)
```

## Branch discipline

`main` is deployed and serving. V3 (the local-first scanner) lives on `v3` and
**does not merge without explicit operator approval**. The new scan path ships
behind `LOCAL_MATCH_ENABLED` (default false) with the existing Sonnet path
intact as fallback.

Out of scope for V3 work: billing, customer accounts, quote pages, the embed
widget, inventory, admin. If a change appears to require touching them, stop and
raise it. Widget back-compat is absolute — any site already loading `widget.js`
keeps working unchanged.

## The rule: no invisible fallbacks

Every defect this project has hit had one shape — **silent degradation**: a
component fails, returns something plausible instead of failing, and nothing
counts how often the good path actually ran.

- The pHash fast path never worked in production for three independent
  sufficient reasons, for months, undetected.
- Both crawlers derived their set list from the artifact they were building, so
  a newly released set was structurally uncrawlable — permanently. This caused
  23 of 35 benchmark failures.
- No retry anywhere, against an API that 500s on roughly 40% of valid requests.
  One 500 silently dropped a whole set.
- The eBay adapter reported the median of the 15 *cheapest active listings* as
  "sold median" — €2.28 for a card worth €168–210.
- `/api/health` reported `has_supabase: true` while the project was PAUSED,
  because it checked that two env vars were non-empty.
- `initCardDb()` only downloaded when neither sheet nor file existed, so once
  `data/card-db.json` was on the Render disk the catalogue never refreshed.

**So: every fallback path increments a counter something reads.** Falling back
is fine. Falling back invisibly is the defect. See
`infra/observability/fast-path-counters.js` for the pattern and `/api/health`
for how it surfaces. A count on its own is not enough — report the *ratio*, and
distinguish "never asked" (null) from "asked and always failed" (0).

Corollaries:

- **Never claim a rate without a measurement.** Every match-rate or latency
  number goes with the sample it came from. "Zero errors" over 25 observations
  is *no observed errors*, not a bounded error rate.
- **Verify a regression test actually fails against the bug.** A landscape-card
  test once passed against the broken detector because a fallback rescued it.
- **Reconcile against upstream, not against yourself.** Compare local card count
  to the API's own `totalCount` per set and exit non-zero on a shortfall.

## Testing conventions

- `node --test`, plain. **No `mock.module()`** — it needs
  `--experimental-test-module-mocks`, which the test script does not pass.
  Inject dependencies instead: `handleQuoteLead(body, req, deps)`,
  `buildHealthPayload({ db, cardDb, env, fastPath })`.
- Regression specs open with a comment naming the incident they pin. A test
  whose reason for existing is not written down gets deleted in the next
  cleanup.

## Data and copyright

Card art is third-party copyright. **Store fingerprints, not artwork** —
download reference images, compute descriptors, discard the images. The shipped
index contains numbers, not pictures. Display thumbnails are served from the
original CDN by URL.

Respect source rate limits: Scryfall asks 50–100 ms between image requests;
pokemontcg.io and TCGdex ask you to cache rather than re-fetch.

## Reuse, don't rewrite

`pricing/` modules, `data/card-db.json`, `pricing/set-aliases.js`,
`pricing/corrections.js`, `pricing/conditions.js` and the Cardmarket URL builder
are hard-won. Extend them.

## Falsified — do not retry

Recorded in `docs/V3_BENCHMARK.md`:

- **Quad expansion** — monotonically worse (45.0 → 36.7 → 31.7 → 29.2%).
- **Contrast-normalised embeddings** — 52.7 → 45.3%.
- **Synthetic benchmark images** — measured ~12 points optimistic; the generator
  fed a bare card filling the frame with no background, flattering every
  strategy. Measure on real photographs.
- **pHash as a photo-to-reference matcher** — measured dead (§15). On 64 real
  photographs the correct card sits at median Hamming distance **26** of 64,
  while some unrelated card is always within 4-12. In 51/51 photos the right
  answer is FARTHER than a wrong one; 0/51 fall inside the threshold of 8.
  Every match it ever served was a collision. Do not retry re-tuning
  `PHASH_HAMMING_MAX`, adding a runner-up margin, hash-type consensus, or
  hashing a better crop — all four were swept and all fail identically.

- **"No near-miss middle ground"** (top-1 == top-5 == top-10) was an artifact of
  catalogue holes — a card absent from the index cannot rank 2. Do not reason
  from it.
