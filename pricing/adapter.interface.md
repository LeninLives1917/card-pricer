# Pricing adapter interface

**Owner:** A2 (Pricing engine) — Slice S2
**Status:** Canonical contract for V2. Every file under `pricing/adapters/` MUST
implement this interface. Cross-references: `docs/V2_ARCHITECTURE.md` §3,
`docs/V2_AUDIT.md` §2 (pricing pipeline), §5.6 (race threshold), §5.22 (model
hoisting).

This document is the bible. If anything below disagrees with `V2_ARCHITECTURE.md`,
this doc wins for adapter authors and the architecture doc gets a follow-up edit.

---

## 1. Type definitions

The interface is consumed from JavaScript ESM modules (`*.js`) but is documented
in TypeScript-style notation for clarity. Adapters export a default object that
satisfies `PricingAdapter`. JSDoc `@type` annotations on the export are
encouraged but not enforced — `pricing/verify.js` and `pricing/price.js`
duck-type at the call site.

### 1.1 `Game`

```typescript
type Game =
  | 'pokemon'           // Pokemon TCG (all eras: WOTC, EX, DP, BW, XY, SM, SwSh, SV)
  | 'magic'             // Magic: The Gathering
  | 'yugioh'            // Yu-Gi-Oh!
  | 'starwars'          // Star Wars: Unlimited (SWU)
  | 'lorcana'           // Disney Lorcana
  | 'onepiece'          // One Piece TCG
  | 'digimon'           // Digimon TCG
  | 'fleshandblood'     // Flesh and Blood TCG
  | 'dragonball';       // Dragon Ball Super CG / DB Fusion World
```

### 1.2 `PartialCard`

The shape Anthropic Sonnet 4.6 returns from `/api/identify`, BEFORE verify.
Every field is best-effort; the adapter's job is to canonicalise this against
its data source. Consumed by `verify()`.

```typescript
interface PartialCard {
  /** Game family. Required; adapters filter on this in supports.games. */
  game: Game;

  /** AI's best read of the printed card name, e.g. "Charizard ex". May include
   *  Pokemon suffix (ex/GX/V/VMAX/VSTAR). After fixPokemonSuffix() the suffix
   *  may have been HP-corrected — see V1 server.js:3067. Required. */
  name: string;

  /** Card number as printed, e.g. "133/182" (slash-form), "SM211" (promo,
   *  no slash), "SWSH262" (promo). Adapters MUST handle both forms.
   *  Leading zeros are PRESERVED here (they were preserved by Sonnet 4.6 per
   *  the prompt at server.js:2727); strip them at lookup time, not OCR time
   *  (V2_AUDIT §5.17). Nullable — generic verifiers fall back to name-only. */
  card_number: string | null;

  /** Set name as printed, e.g. "Mega Evolution", "Surging Sparks". Used for
   *  fuzzy set matching in scoreCandidate when set_code is wrong. Nullable. */
  set_name: string | null;

  /** Set code as printed, e.g. "MEG", "SSP". Often wrong from AI (MEP↔MEG).
   *  Adapters cross-check against printed total — see V2_AUDIT §5.6.
   *  Nullable. */
  set_code: string | null;

  /** Hit points. Pokemon only. Critical signal for verify (HP-mismatch reject
   *  threshold = HP_MISMATCH_TOLERANCE in confidence.js). Stringified integer
   *  in the AI response; adapters parseInt before comparing. Nullable. */
  hp: string | null;

  /** Attacks/abilities Sonnet 4.6 read off the card. Used for attack-name
   *  primacy queries (V1 server.js:3601 — name+attack narrows to one or two
   *  cards regardless of which set Claude misguessed). Each entry is either a
   *  string (attack name) or an object with .name. Nullable. */
  attacks?: Array<string | { name: string }>;

  /** Pokemon regulation mark (D/E/F/G/H). Used to reject era-mismatched
   *  candidates in scoreCandidate. Nullable. */
  regulation_mark?: string | null;

  /** Promo flag — adapters detect this from card_number shape. Re-derived
   *  inside verifyPokemon as `isPromo`. Optional. */
  is_promo?: boolean;

  /** Grading info. If set, /api/price routes through graded comp lookup
   *  instead of ungraded multipliers (V1 server.js:4925). The grade IS the
   *  condition — condition_estimate is ignored for graded cards. */
  graded?: {
    company: 'PSA' | 'BGS' | 'CGC' | 'SGC';
    grade: number;     // 1.0–10.0 for PSA/CGC/SGC; BGS supports half-grades
  } | null;

  /** Operator-selected condition for ungraded cards. Default 'NM'.
   *  Maps to condition_multiplier via pricing/conditions.js. */
  condition_estimate?: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
}
```

### 1.3 `VerifiedCard`

Output of `verify()` — DB-canonical fields plus a reference image. This is what
the client renders and what `price()` operates on. Every field a real DB row
has. No internal-prefix (`_*`) keys leak to the client (stripInternals removes
them; V2_AUDIT §5.10).

```typescript
interface VerifiedCard {
  /** Canonical card name from the DB, e.g. "Charizard ex". MAY differ from
   *  PartialCard.name if the AI hallucinated a suffix; the verified name wins. */
  name: string;

  /** DB-canonical set name, e.g. "Surging Sparks". */
  set_name: string;

  /** DB-canonical set code, UPPERCASED, e.g. "SSP". For "Additionals"
   *  secret rares this gains an "x" prefix (e.g. "xDRI") via
   *  applyAdditionalsLabel — V1 server.js:3520. */
  set_code: string;

  /** DB-canonical card number, no leading zeros (e.g. "94" not "094").
   *  For Pokemon TCG API entries this comes from `data.number`. */
  card_number: string;

  /** Rarity string from the DB, e.g. "Rare Holo". Free-form, source-dependent.
   *  Nullable when source has no rarity field. */
  rarity: string | null;

  /** Hit points (Pokemon only). DB value, NOT the AI's read. Nullable. */
  hp: string | null;

  /** Reference image URL — high-res preferred. Used by maybeDoubleCheck for
   *  the image-compare gate (V2_AUDIT §5.3) and by the result sheet UI. */
  image: string | null;

  /** Direct Cardmarket product URL — the actual cardmarket.com product page,
   *  NOT a search URL. May be null when the source can't produce one
   *  (e.g. pokemontcg.io's `cardmarket.url` is sometimes a redirect; we
   *  filter those out — V1 server.js:4822). */
  cardmarket_url: string | null;

  /** Direct TCGPlayer product URL. Same constraint as cardmarket_url. */
  tcgplayer_url: string | null;

  /** Source provenance — used by the card-DB priority logic
   *  (V2_AUDIT §5.4 — Pokellector overrides ALWAYS win, then manual,
   *  then tcggo/sheet/fallback, then pokemontcg.io). DO NOT collapse this
   *  into a boolean during persistence migrations or Pokellector corrections
   *  silently disappear. */
  source:
    | 'pokellector'     // Hardcoded ME1/MEP corrections (V1 server.js:1662)
    | 'manual'          // /api/correct-card overwrites
    | 'tcggo'           // RapidAPI/TCGGO unreliable-set imports
    | 'sheet'           // Google Sheet (CARD_DB_SHEET_URL)
    | 'pokemontcg.io'   // pokemontcg.io API
    | 'fallback'        // tcgdex.net or generic shell
    | string;           // adapter-specific labels e.g. "local-db (sheet)"

  /** scoreCandidate result for the picked candidate. Used by
   *  maybeDoubleCheck gate (skip image compare when ≥ DOUBLE_CHECK_SCORE_GATE).
   *  Optional — not all adapters score (e.g. Magic uses Scryfall direct hits). */
  confidence_score?: number;

  /** Top-3 runners-up for the chooser UI when the winner isn't confident
   *  (V1 server.js:3725). Each candidate has the same shape as VerifiedCard
   *  minus internals. Filtered to score ≥ 40 in V1. Optional. */
  candidates?: VerifiedCard[];

  /** Set true by applyAdditionalsLabel when card_number > set total
   *  (Cardmarket sells these as "X<code> ###" / ": Additionals"). */
  _additionals?: boolean;

  /** In-flight Promise<axios.Response<ArrayBuffer>> that prefetches the
   *  reference image so maybeDoubleCheck doesn't pay a second download.
   *  ALWAYS stripped before client send by stripInternals (V2_AUDIT §5.10).
   *  Type kept loose to avoid leaking axios into the contract. */
  _refImagePromise?: Promise<unknown> | null;

  /** Verify-rejected reason. Set when an HP mismatch or double-check
   *  failure means we couldn't trust the match. Caller treats this as
   *  "AI identification stands; do NOT cache; allow rescan to recover".
   *  identCache is skipped when this is present (V2_AUDIT §5 invariant). */
  verify_rejected?: 'hp_mismatch' | 'double_check_mismatch' | string;
}
```

### 1.4 `PriceQuote`

Output of `price()` — one quote, one source. The aggregator collects an array
of these and selects by confidence DESC then static priority.

```typescript
interface PriceQuote {
  /** Adapter name. MUST equal `adapter.name`. Used as the dictionary key in
   *  the v2.sources array (V2_ARCHITECTURE §2.2). */
  source: string;

  /** Best-effort EUR market value. If the upstream is USD-priced, the
   *  adapter applies USD_TO_EUR (from pricing/fx.js) BEFORE returning.
   *  null = "I had no price for this card", NOT "I errored". */
  market_value_eur: number | null;

  /** Currency the upstream actually quoted in. EUR for Cardmarket / TCGGO,
   *  USD for TCGPlayer / JustTCG / Scryfall USD. */
  raw_currency: 'EUR' | 'USD';

  /** Upstream raw value, untouched. raw_value × fx_rate ≈ market_value_eur
   *  for USD sources. Nullable when the upstream returned no price. */
  raw_value: number | null;

  /** 0..1 confidence score. See §5 Confidence rubric below. NOT an accuracy
   *  guarantee — it's a "trust this for the buy-price calc" signal. */
  confidence: number;

  /** ISO8601 fetch timestamp. The aggregator uses this to detect stale-cache
   *  reads (cardmarket-html confidence drops to ~0 when fetched_at >24h old). */
  fetched_at: string;

  /** Optional surface-only fields — passed through to the v2.sources array
   *  on /api/v2/price for the "why this price" UI. */
  trend?: number | null;             // 7d trend (cardmarket trend value)
  avg7?: number | null;              // 7-day average
  avg30?: number | null;             // 30-day average
  graded?: Array<{                   // graded comps (TCGGO has these for Pokemon)
    company: 'PSA' | 'BGS' | 'CGC' | 'SGC';
    grade: number;
    price_eur: number;
  }>;
  sample_size?: number;              // eBay-sold: how many sales the median is from
  product_url?: string | null;       // direct product link if known

  /** When the source could not respond, why. Surfaced in the v2.sources
   *  array as `blocked_by`. Most common: 'cloudflare' for cardmarket-html. */
  blocked_by?: 'cloudflare' | 'rate_limit' | 'auth' | 'timeout' | null;
}
```

### 1.5 `AdapterCtx`

Context bag passed to every adapter call. Lets the engine inject env-derived
config (FX rates, API keys, cache handles) without each adapter re-reading
`process.env`.

```typescript
interface AdapterCtx {
  /** Current USD→EUR rate from pricing/fx.js. Bounded 0.5..2.0
   *  (V2_AUDIT §5.25). Adapters multiply USD prices by this for
   *  market_value_eur. */
  usd_to_eur: number;

  /** Per-adapter LRU cache handle. get(key) / set(key, value, ttlMs).
   *  TTLs per source are recommended in §3 Cache TTLs below. */
  cache: {
    get(key: string): unknown | undefined;
    set(key: string, value: unknown, ttlMs: number): void;
  };

  /** Structured logger. logger.info / .warn / .error — JSON in prod
   *  (per A8 observability). Adapters log cache hit/miss + outbound
   *  call latencies. */
  logger: {
    info(msg: string, meta?: object): void;
    warn(msg: string, meta?: object): void;
    error(msg: string, meta?: object): void;
  };

  /** Optional buy-percentage override, 0..1. Default 0.6 (60%).
   *  Adapters do NOT apply this themselves — the engine multiplies after
   *  picking the winning quote. Present here for adapters that need to
   *  pass-through to graded-comp logic. */
  buy_percentage?: number;

  /** Abort signal — the engine cancels in-flight calls when the request
   *  is closed or another adapter has already produced a >0.95-confidence
   *  result. Adapters MUST honour this (axios cancelToken). */
  signal?: AbortSignal;
}
```

### 1.6 `PricingAdapter`

The interface every file in `pricing/adapters/` exports as default.

```typescript
interface PricingAdapter {
  /** Stable name, lowercase-snake-case. Used in source priority + telemetry.
   *  MUST match the source name in the static priority list (§4 below). */
  readonly name: string;

  /** Capability declaration. The aggregator filters adapters by these BEFORE
   *  calling isAvailable(), so unsupported games don't even check env vars. */
  readonly supports: {
    /** Game families this adapter can answer for. */
    games: Game[];
    /** Inputs the adapter needs. The aggregator skips adapters whose inputs
     *  are not all present on the card. */
    needs: Array<'verified_card' | 'set_code' | 'card_number' | 'image' | 'name'>;
  };

  /** Synchronous, cheap (no I/O). True iff env vars / API keys / quotas allow
   *  a real call right now. Checked once per /api/price request, before
   *  fan-out, so the response isn't slowed by calls that would 401 anyway.
   *  MUST be idempotent — called repeatedly. See §2 Lifecycle below. */
  isAvailable(): boolean;

  /** Verify a card identification. Returns DB-canonical fields. Some adapters
   *  are price-only (e.g. ebay-sold, justtcg) and omit this method.
   *
   *  Contract:
   *    - Return null on "no match" (the adapter looked, didn't find).
   *    - Throw ONLY on unexpected failures (network 500s, malformed response,
   *      etc.). The aggregator catches throws and treats them as null with
   *      a warn-level log.
   *    - Set verify_rejected on the returned object when the match was
   *      found but failed a guard (HP mismatch, double-check fail).
   *    - MUST honour ctx.signal — abort axios when the signal fires.
   *    - MUST NOT mutate the input PartialCard. */
  verify?(card: PartialCard, ctx: AdapterCtx): Promise<VerifiedCard | null>;

  /** Quote prices for a verified card. Returns null on miss, throws only on
   *  unexpected failures (same contract as verify).
   *
   *  Contract:
   *    - Return null when there's no price for this card on this source
   *      (e.g. card not listed on Cardmarket yet).
   *    - Return a PriceQuote with confidence: 0 + blocked_by: 'cloudflare'
   *      when the source is structurally unavailable (Cardmarket scrape).
   *      Distinguishes "not blocked, just no price" from "couldn't even ask".
   *    - Convert to EUR on the way out. The engine will not re-multiply.
   *    - MUST honour ctx.signal. */
  price?(card: VerifiedCard, ctx: AdapterCtx): Promise<PriceQuote | null>;
}
```

---

## 2. Lifecycle

When an HTTP request lands on `/api/identify-stream` or `/api/price`, the
engine walks the adapters in this order:

```
                         ┌──────────────────────────────────┐
/api/identify-stream  ──►│ resolveSources(card.game)        │
                         │   adapters.filter(a =>            │
                         │     a.supports.games.includes(g)  │
                         │     && a.isAvailable())           │
                         │   sort by static priority list    │
                         └──────────────────────────────────┘
                                      │
                                      ▼
                          For each adapter with verify:
                              await a.verify(card, ctx)
                              .catch(e => null)
                          Pick first non-null result that
                          passes confidence floor.
                                      │
                                      ▼
                           emit {type:'verified'}
                                      │
                                      ▼
                          /api/price (or v2/price):
                              Promise.all(adapters.map(a =>
                                  a.price(verifiedCard, ctx)
                                  .catch(e => null)))
                              filter(q => q && q.market_value_eur != null)
                              if (verified.graded) → graded path
                              sort by confidence DESC, then static priority
                              return top quote + breakdown
```

**`isAvailable()`** runs once per request, synchronously, before any I/O.
Cheap — read env vars, check a quota counter — no awaits, no fetches.

**`verify()`** runs sequentially through priority order in V1 (Pokemon path:
local DB → pokemontcg.io race), parallel where adapters are independent
(Magic verify is one Scryfall call). V2 keeps the V1 ordering inside the
Pokemon adapter (race threshold + grace) and parallel across game adapters.

**`price()`** ALWAYS runs in parallel — `Promise.all` over every available
adapter for the card's game. Engine collates results; per-adapter throws
become null (warn-logged).

**Miss vs error** — this distinction is load-bearing:

| Situation | Return value |
|---|---|
| Adapter looked, source had no price for this card | `null` |
| Source returned 0 results / empty array | `null` |
| Source said "card not found" (404 from upstream) | `null` |
| Source rate-limited us (429) | `PriceQuote{ confidence: 0, blocked_by: 'rate_limit' }` |
| Cloudflare blocked the scrape | `PriceQuote{ confidence: 0, blocked_by: 'cloudflare' }` |
| Network timeout | throw (engine catches, warns, treats as null) |
| Malformed upstream response (JSON parse fail) | throw |
| Adapter's own bug | throw |

The reason for the `blocked_by` distinction: the v2 "why this price" UI shows
"Cardmarket Live · blocked by Cloudflare" so the operator knows that source is
structurally unavailable, not just "no data for this card today".

---

## 3. Cache TTL recommendations

Per `V2_ARCHITECTURE.md` §3.4. Adapters use `ctx.cache` with these TTLs.
A2 may tune these in S6 implementation; downstream tests pin only the
relative ordering, not the exact ms.

| Source | TTL | Reason |
|---|---|---|
| `cardmarket-html` | **60 s** on success | Cardmarket prices move fast; short TTL keeps the cache from going stale during a session. On block (Cloudflare 403), cache the `blocked_by` for 5 min so we don't hammer them. |
| `tcggo-rapidapi` | **10 min** | RapidAPI quota is metered; data refreshes hourly upstream. |
| `justtcg` | **10 min** | Free tier is 100 req/day — must cache aggressively. |
| `pokemontcg.io` | **6 h** | Their cardmarket.prices field is daily-snapshotted by upstream. |
| `scryfall` | **6 h** | Same — Scryfall prices update daily. |
| `ebay-sold` | **30 min** | Sold listings don't change minute-to-minute. |
| `tcgdex` | **24 h** | Read-only static-ish data. |
| `swu-db`, `ygoprodeck`, `lorcana` | **24 h** | Verify-only adapters; ID data rarely changes. |
| `cardmarket-sealed` (sealed, S17 + V2.0.1) | **1 h** | Sealed prices move slower than singles. Cloudflare-blocked attempts cache the `blocked_by:'cloudflare'` envelope for 5 min. |

Engine-level caches (orthogonal to adapter caches):

| Cache | TTL | Notes |
|---|---|---|
| `identCache` | none (LRU 100) | image SHA1 → identify result. **SKIPPED when verify_rejected is set** (V2_AUDIT §5 invariant). |
| `priceCache` | 60 min (LRU 500) | full /api/price response. Composite key: `game|name|set|num|cond|variant|graded|buy%`. |
| `shopConfigCache` | 5 min | invalidated on shop slug rename. |

---

## 4. Static priority order

When two adapters return quotes with EQUAL confidence, the engine breaks the
tie using this static priority (lower index wins):

```javascript
export const STATIC_PRIORITY = [
  'tcggo-rapidapi',      // 0 — best EUR source with active liquidity
  'cardmarket-html',     // 1 — direct scrape (rare; mostly Cloudflare-blocked)
  'justtcg',             // 2 — TCGPlayer USD via API
  'pokemontcg.io',       // 3 — embedded cardmarket daily snapshot
  'scryfall',            // 4 — Magic-only price data
  'ebay-sold'            // 5 — sold-listing comps (sample-size dependent)
];
```

**Final selection rule:**

```
  selected = quotes
    .filter(q => q.market_value_eur != null)
    .sort((a, b) => {
       if (b.confidence !== a.confidence) return b.confidence - a.confidence;
       return STATIC_PRIORITY.indexOf(a.source) - STATIC_PRIORITY.indexOf(b.source);
    })[0];
```

**Graded override:** if `verifiedCard.graded` is set, the graded-comp branch
of `tcggo-rapidapi` (PSA10/PSA9/CGC10 fields on its PriceQuote) takes over
unconditionally — the grade IS the condition, no condition multiplier
applied (V1 server.js:4925).

---

## 5. Confidence rubric

Each adapter computes its own `0..1` confidence. The engine does NOT recompute
or re-weight. The numbers here are documented; A2 may tune in S6 but A7
fixture tests (`pricing-fanout.spec.js`) pin the ORDERING, e.g. "TCGGO with
active liquidity beats raw pokemontcg.io for the same card".

| Source | Base | Boosts | Penalties |
|---|---|---|---|
| `tcggo-rapidapi` | 0.85 | +0.05 if `avg7 > 0` (active 7d liquidity) | −0.20 if cache hit older than 24 h |
| `cardmarket-html` | 0.95 | — (only succeeds when not blocked) | 0 if Cloudflare-blocked / parse-fail |
| `justtcg` | 0.65 | +0.10 if condition exact match (NM=NM, not NM=fallback) | −0.15 if printing fallback used (Holofoil sub for Reverse) |
| `pokemontcg.io` | 0.70 | — | — (embedded data is daily-snapshotted) |
| `scryfall` | 0.70 | — | — |
| `ebay-sold` | `min(0.9, 0.3 + 0.04 * sample_size)` | — | capped at 0.9 even with huge samples |

Worked example — Charizard ex (SSP 199):
- `tcggo-rapidapi`: 0.85 + 0.05 (avg7 active) = **0.90**
- `pokemontcg.io`:  0.70
- `justtcg`:        0.65 + 0.10 (NM exact) = 0.75
- `ebay-sold`:      0.3 + 0.04 × 7 = 0.58
- `cardmarket-html`: 0 (blocked)

→ Engine selects `tcggo-rapidapi` (highest confidence). Tie-break would
favour it over cardmarket-html anyway via static priority.

---

## 6. Implementation checklist for new adapters

When adding a new adapter under `pricing/adapters/<name>.js`:

1. Pick a stable lowercase-snake-case `name`. Add it to STATIC_PRIORITY in
   the right position (don't reorder existing entries — that breaks
   regression tests).
2. Declare `supports.games` and `supports.needs` accurately. Inaccurate
   `needs` causes the aggregator to call you with insufficient input.
3. Implement `isAvailable()` as a pure synchronous env check. No `await`.
4. Implement `verify` and/or `price`. Honour the miss vs error contract.
5. Convert prices to EUR using `ctx.usd_to_eur` BEFORE returning.
6. Cache via `ctx.cache` with the TTL from §3.
7. Honour `ctx.signal` — propagate to axios `cancelToken` / fetch `signal`.
8. Return `_*`-prefixed fields ONLY when the engine needs them (e.g.
   `_refImagePromise`); they're stripped before client send.
9. Add a fixture test under `tests/regression/pricing-fanout.spec.js`
   that pins your confidence vs another adapter for a known card.

---

## 7. References

- `docs/V2_ARCHITECTURE.md` §3 — full architecture context.
- `docs/V2_AUDIT.md` §2 — V1 pricing data flow.
- `docs/V2_AUDIT.md` §5.6 — race threshold + MIN_ACCEPT_SCORE rationale.
- `docs/V2_AUDIT.md` §5.10 — stripInternals invariant.
- `docs/V2_AUDIT.md` §5.22 — Anthropic model hoisting.
- `pricing/confidence.js` — exported tunables (RACE_THRESHOLD,
  MIN_ACCEPT_SCORE, OCR_FIRST_FP_THRESHOLD, model constants).
- V1 `server.js:3413` — scoreCandidate (Pokemon scoring weights).
- V1 `server.js:3537` — verifyPokemon (race + grace + threshold).
- V1 `server.js:4717` — `/api/price` fan-out (source priority lives here today).
