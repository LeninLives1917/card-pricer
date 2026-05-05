# Card-Pricer V2 — Architecture Proposal

Companion to `docs/V2_AUDIT.md`. Read the audit first — this document depends on every risk and hidden-behaviour callout there. Section numbers (§5.x) below reference the audit's risk register / hidden-behaviour list.

**Status:** Phase 2 deliverable, scope-locked. Awaiting explicit phase-3 approval.

**Operating principles** (from `CARD_PRICER_V2_PROMPT.md` §2):
1. No feature regressions. Every behaviour the audit lists keeps working.
2. No endpoint breakage. V1 paths and shapes survive.
3. Embed widget v1 attribute set keeps working verbatim — even though the widget file itself is upgraded in place (Q4).
4. No silent data loss. Every persistence change has migration + rollback.
5. All work on a `v2` git branch; `main` untouched until ship.

**Operator-locked decisions** (from the six phase-2 questions):

| # | Decision | Architectural impact |
|---|---|---|
| Q1 | All four big features IN: F5 sealed, F17 sessions cutover, F18 inventory, F19 customer accounts + quote_offers | Timeline 4–6 weeks; +2 sub-agents (A9 Inventory, A10 Customer accounts); test count ~2× |
| Q2 | Render Starter ($7/mo) | Persistent disk + always-on. `data/card-db.json` survives. Phone-pair `live_sessions` adoption is for resilience, not just sleep-survival |
| Q3 | OCR-first scan re-enabled with image-compare validation gate | New `pricing/ocr-first/` slice. Server-side `OCR_FIRST_ENABLED` env kill switch. Telemetry on every attempt |
| Q4 | Widget v2 ships in place at `/widget.js` | V1 `widget.js` content backed up to `widget-v1.js` for rollback; V2 must produce DOM indistinguishable from V1 when only V1 attributes are present |
| Q5 | Sentry on free tier, server + browser, with `beforeSend` scrubbing | A8 owns; replaces "wired but disabled" with "wired and live" |
| Q6 | In-place deploy, no preview env | Phase-5 release runbook owns the safeguards (tag `v1-final`, manual deploy, 60s widget cache, Stripe webhook smoke, 2-hour watch) |

---

## 1. Target module layout

V1 is a 5,720-line `server.js` + a 7,200-line `index.html` + two smaller files. V2 splits along seams that match the sub-agent ownership in `CARD_PRICER_V2_PROMPT.md` §3 — each file lives in exactly one agent's owned set, so two agents never need the same file at the same time.

```
card-pricer/
├── server.js                       ← v1 entrypoint, kept for compat
├── apps/
│   └── server/                     ← A1 (Backend/API)
│       ├── index.js                ← express app wiring; routes mounted via routers
│       ├── middleware/
│       │   ├── auth.js             ← requireAuth, requireAdmin, requirePlan, scanner-mode bypass
│       │   ├── quota.js            ← enforceQuota + X-Scan-* response headers
│       │   ├── rate-limit.js       ← identifyLimiter, quoteLeadLimiter, trustProxy=1
│       │   └── error-handler.js    ← single error sink; no stack traces in prod
│       ├── routes/
│       │   ├── identify.js         ← /api/identify, /api/identify-stream, /api/read-set-code, /api/lookup-by-number, /api/identify-manual, /api/correct-card
│       │   ├── price.js            ← /api/price + /api/v2/price (delegates to pricing engine)
│       │   ├── price-sealed.js     ← /api/v2/price-sealed (NEW — F5)
│       │   ├── card-db.js          ← /api/card-db-{status,export,rebuild,import-unreliable}
│       │   ├── account.js          ← /api/me, /api/usage, /api/welcome-email, /api/state, /api/v2/sessions (F17)
│       │   ├── billing.js          ← /api/checkout, /api/portal, /api/stripe-webhook (raw-body)
│       │   ├── admin.js            ← /api/admin/{overview,users,arbitrage,refresh-prices,refresh-status}
│       │   ├── shop.js             ← /api/shop GET/POST/PATCH, /api/shop-config/:slug
│       │   ├── quote-lead.js       ← /api/quote-lead (multi-provider newsletter)
│       │   ├── quote-offer.js      ← /api/v2/quote-offer + /api/v2/quote-offer/:token/{accept,decline} (NEW — F19)
│       │   ├── customer.js         ← /api/v2/customer/me + customer-account CRUD (NEW — F19)
│       │   ├── inventory.js        ← /api/v2/inventory + items/events/listings (NEW — F18, A9)
│       │   ├── room.js             ← /api/room/:id/{scan,stream,history} (legacy in-memory + Postgres-backed live_sessions writeback)
│       │   ├── search.js           ← /api/search
│       │   ├── health.js           ← /api/health, /api/version (NEW), /api/widget/loaded (telemetry beacon)
│       │   └── static.js           ← /, /quote, /widget.js, service-worker headers
│       └── server.js               ← thin bootstrap that imports apps/server/index.js
│
├── pricing/                        ← A2 (Pricing engine) — pure functions + adapters
│   ├── adapter.interface.md        ← contract every source adapter implements
│   ├── adapters/
│   │   ├── pokemontcg.js           ← verifyPokemon + pricePokemonCard merged
│   │   ├── scryfall.js             ← Magic verify + price
│   │   ├── swu-db.js               ← Star Wars verify
│   │   ├── ygoprodeck.js           ← Yu-Gi-Oh!
│   │   ├── lorcana.js              ← best-effort
│   │   ├── tcgdex.js               ← Pokemon fallback
│   │   ├── justtcg.js              ← TCGPlayer USD via JustTCG
│   │   ├── tcggo-rapidapi.js       ← TCGGO Cardmarket EUR + graded comps
│   │   ├── ebay-sold.js            ← eBay Browse API, IE marketplace
│   │   ├── cardmarket-html.js      ← best-effort scrape, mostly CF-blocked
│   │   └── cardmarket-sealed.js    ← NEW — sealed product pricing (F5; V2.0.1 swap from TCGPlayer Pro to Cardmarket scrape + manual override)
│   ├── sealed/                     ← NEW — F5 sealed-product engine (A2)
│   │   ├── product-types.js        ← Booster, ETB, BoosterBox, Bundle, …
│   │   ├── verify.js               ← sealed verify (SKU-based, not card-number)
│   │   └── price.js                ← /api/v2/price-sealed fan-out
│   ├── ocr-first/                  ← NEW — Q3 OCR-first identify
│   │   ├── pipeline.js             ← orchestrates read-set-code → identify-manual → image-compare validate
│   │   ├── validation.js           ← Sonnet 4.6 user-scan vs canonical-image diff
│   │   └── telemetry.js            ← writes ocr_first_attempts events for false-positive tracking
│   ├── marketplaces/               ← NEW — F18 outbound listing adapters (A9)
│   │   ├── adapter.interface.md
│   │   ├── cardmarket.js           ← list, update, mark sold
│   │   ├── tcgplayer.js
│   │   ├── ebay.js
│   │   └── in-store.js             ← no-op marketplace = pure tracking
│   ├── verify.js                   ← orchestrates per-game verify, race threshold, double-check
│   ├── price.js                    ← /api/price fan-out + source priority + hotness
│   ├── identify-core.js            ← Anthropic call + identCache + suffix fixer + stripInternals
│   ├── confidence.js               ← scoreCandidate, RACE_THRESHOLD, MIN_ACCEPT_SCORE, OCR_FIRST_FP_THRESHOLD
│   ├── conditions.js               ← NM/LP/MP/HP/DMG multipliers, graded skip
│   ├── corrections.js              ← POKELLECTOR_CORRECTIONS, POKEMONTCG_UNRELIABLE
│   ├── set-aliases.js              ← PKM_SET_ALIASES, PKM_SET_NAMES, TCGDEX_SET_MAP, CM_SET_SLUGS (consolidated from server.js + quote.html)
│   └── fx.js                       ← USD_TO_EUR refresh
│
├── db/                             ← A3 (Persistence)
│   ├── schema.md                   ← human-readable schema doc
│   ├── supabase.js                 ← service-role client, getOrCreateProfile
│   ├── card-db/                    ← formerly data/card-db.json + corrections layer
│   │   ├── store.js                ← Map-backed read/write (production)
│   │   ├── persist.js              ← file ↔ Map (Render persistent disk per Q2)
│   │   └── sources.js              ← source priority enum
│   ├── price-snapshot/             ← V2: card_prices Postgres table primary, JSON file secondary
│   │   └── store.js                ← Postgres ↔ Map; warm-on-boot from table
│   ├── sessions/                   ← NEW — F17 sessions cutover (A3 owns)
│   │   ├── dual-write.js           ← writes to both user_state JSONB AND sessions/session_cards tables
│   │   ├── reader.js               ← prefers relational read; falls back to JSONB blob
│   │   └── cutover-flag.js         ← env-controlled READ_FROM_RELATIONAL
│   ├── inventory/                  ← NEW — F18 (A9 owns)
│   │   ├── items.js                ← inventory_items CRUD
│   │   ├── events.js               ← inventory_events append-only audit log
│   │   └── listings.js             ← listings CRUD
│   ├── customers/                  ← NEW — F19 (A10 owns)
│   │   ├── accounts.js             ← customer_accounts CRUD (separate auth flow from vendor)
│   │   └── offers.js               ← quote_offers + accept_token validation
│   ├── live-sessions/              ← NEW — F15 phone-pair Postgres-backed
│   │   ├── store.js                ← live_sessions + live_session_scans CRUD
│   │   └── sse-bridge.js           ← bridges Postgres notifications → in-memory SSE clients
│   └── migrations/                 ← thin wrapper around supabase/migrations
│
├── apps/
│   ├── vendor/                     ← A4 — split index.html into per-tab modules
│   │   ├── index.html              ← shell only, ≤500 lines
│   │   ├── styles/
│   │   │   ├── tokens.css          ← per DESIGN_BRIEF.md (already in place)
│   │   │   └── components.css
│   │   ├── modules/
│   │   │   ├── api-client.js       ← THE ONLY HTTP CLIENT (§5.1) — JWT, 401, 429, X-Scan-* headers
│   │   │   ├── auth.js
│   │   │   ├── state.js            ← state.sessions, queueStateSync, pull/push
│   │   │   ├── tabs/
│   │   │   │   ├── scan.js
│   │   │   │   ├── results.js
│   │   │   │   ├── session.js
│   │   │   │   ├── settings.js
│   │   │   │   └── admin.js
│   │   │   ├── bulk.js             ← bulkWorker, processBulkItem
│   │   │   ├── pair.js             ← QR host + scanner-mode (?pair=)
│   │   │   ├── result-sheet.js
│   │   │   ├── correct.js          ← search modal + /api/correct-card
│   │   │   └── pwa.js              ← service-worker register + install nudge
│   │   └── service-worker.js
│   │
│   ├── quote/                      ← A5 — split quote.html
│   │   ├── index.html              ← shell only
│   │   ├── styles/                 ← shared tokens with vendor app
│   │   ├── modules/
│   │   │   ├── shop-config.js      ← /api/shop-config/:slug + branding
│   │   │   ├── parse-lines.js      ← MAX_CARDS=20 line parser
│   │   │   ├── lookup.js           ← /api/identify-manual + /api/price loop
│   │   │   ├── cardmarket-url.js   ← shared with widget if possible
│   │   │   ├── totals.js
│   │   │   └── lead-gate.js        ← email gate + postMessage to widget
│   │
│   ├── customer/                   ← NEW — F19 customer-facing dashboard (A10)
│   │   ├── index.html              ← /customer (login + dashboard shell)
│   │   ├── modules/
│   │   │   ├── auth.js             ← magic-link sign-in via Supabase
│   │   │   ├── quote-history.js    ← list past quotes from quote_leads + quote_offers
│   │   │   ├── offer-accept.js     ← /accept/:token — single-click offer accept
│   │   │   └── account.js          ← edit display_name, opt_in_marketing, preferred_shop_slug
│   │   └── styles/                 ← shared tokens, lighter density than vendor
│   │
│   └── widget/                     ← A6 — Q4 in-place upgrade
│       ├── widget.js               ← V2 contents (the live serving file)
│       ├── widget-v1.js            ← V1 contents preserved verbatim, NEVER served from /; rollback target only
│       ├── test-harness.html       ← embed in fake host page for V1 + V2 attribute parity tests
│       └── compat.md               ← V1-attribute parity contract + what's new in V2
│
├── tests/                          ← A7
│   ├── regression/                 ← one test per behaviour in V2_AUDIT §1, must pass
│   │   ├── auth-flow.spec.js
│   │   ├── identify-pipeline.spec.js
│   │   ├── pricing-fanout.spec.js
│   │   ├── verify-pokemon.spec.js  ← Bulbasaur Expedition #94 fixture, ME1 corrections
│   │   ├── widget-v1-compat.spec.js
│   │   ├── stripe-webhook.spec.js  ← raw-body verify
│   │   └── …
│   ├── new/                        ← V2-only features
│   ├── fixtures/                   ← cached API responses, sample card images
│   └── helpers/                    ← supabase test client, fake stripe
│
├── infra/                          ← A8
│   ├── render.yaml                 ← Starter plan + persistent disk + full env var list (Q2)
│   ├── env.example                 ← every env var the code references
│   ├── observability/
│   │   ├── logger.js               ← pino, structured, JSON in prod
│   │   ├── metrics.js              ← /api/metrics endpoint, prom-client
│   │   ├── sentry-server.js        ← Sentry Node SDK + beforeSend scrubbing (Q5)
│   │   └── sentry-browser.js       ← imported by vendor + quote + customer apps
│   └── deploy/
│       ├── healthcheck.md
│       ├── release-runbook.md      ← Q6 in-place deploy steps + rollback
│       └── stripe-webhook-smoke.md ← post-deploy verification procedure
│
├── supabase/migrations/            ← already in place; see supabase/migrations/README.md
├── docs/
│   ├── V2_AUDIT.md                 ← phase 1
│   ├── V2_ARCHITECTURE.md          ← this file
│   ├── api-contract.md             ← phase 3 contract for sub-agents (NEW)
│   ├── V2_SMOKE_TEST.md            ← phase 4
│   ├── V2_RELEASE_NOTES.md         ← phase 5
│   └── V2_MIGRATION.md             ← phase 5
│
└── memory/                         ← Claude auto-memory, untracked
```

**The `server.js` at the repo root stays.** It re-exports from `apps/server/server.js` so `package.json`'s `start` and `node --check` keep working through the migration. Once V2 is shipped, `server.js` can be a one-liner.

---

## 2. API contract v2

**Header rule:** every existing endpoint keeps its V1 path, request shape, and response shape. New behaviour goes behind a `/api/v2/...` path or behind an opt-in field on the V1 path. V1 path becomes the back-compat shim that V2 reads/writes through.

### 2.1 Identify pipeline

| V1 path | V2 path | Status | Notes |
|---|---|---|---|
| `POST /api/identify` | unchanged | kept | response shape: `{cards:[…]}`. |
| `POST /api/identify-stream` | unchanged | kept | NDJSON shape unchanged. |
| `POST /api/identify-manual` | unchanged | kept | shape unchanged. |
| `POST /api/read-set-code` | unchanged | **deprecated** | `Deprecation: true` response header; `tryOcrIdentify` is hard-disabled in V1, V2 either deletes both ends or rewires with the validation step described in `memory/ocr_first_path.md`. |
| `POST /api/lookup-by-number` | unchanged | kept | unchanged. |
| `POST /api/correct-card` | unchanged | gated | now requires auth (V1 fix); V2 surfaces caller's `user_id` in response (`{ok, key, oldName, newName, by}`). |
| — | `POST /api/v2/identify` | NEW | identical to v1 plus `{confidence_breakdown}` and `{candidates: […]}` in the success response. v1 response continues to omit confidence_breakdown to keep its shape stable. |

### 2.2 Pricing

V1 `POST /api/price` keeps its giant fan-out response. V2 adds a structured "why this price" breakdown:

```jsonc
// POST /api/v2/price — request shape unchanged
{
  // …all V1 fields preserved exactly…
  "v2": {                                  // NEW envelope, only present on /api/v2/price
    "selected_source": "rapidapi_cm",
    "sources": [
      { "name": "rapidapi_cm",   "price_eur": 4.12, "confidence": 0.85, "fetched_at": "2026-05-04T…" },
      { "name": "pokemontcg.io", "price_eur": 3.95, "confidence": 0.70, … },
      { "name": "justtcg",       "price_eur": 4.08, "confidence": 0.65, … },
      { "name": "ebay_sold",     "price_eur": 4.40, "confidence": 0.55, "sample_size": 7, … },
      { "name": "cardmarket_live","price_eur": null, "confidence": 0, "blocked_by": "cloudflare" }
    ],
    "selection_reason": "TCGGO is highest-trust EUR source with active 7-day liquidity",
    "fx_rate": { "usd_eur": 0.92, "as_of": "2026-05-03" },
    "buy_calc": {
      "market_value": 4.12,
      "condition": "NM",
      "condition_multiplier": 1.0,
      "buy_percentage": 0.60,
      "graded": null,
      "suggested": 2.47
    }
  }
}
```

This is the "transparent why this price" breakdown from `CARD_PRICER_V2_PROMPT.md` §5.5. Adding it to `/api/price` would change the V1 response shape; we put it on `/api/v2/price` instead.

### 2.3 Persistence

| V1 path | V2 path | Status |
|---|---|---|
| `GET /api/state` | unchanged | kept (LWW JSONB blob). |
| `PUT /api/state` | unchanged | kept. |
| — | `GET /api/v2/sessions` | NEW (optional adoption of carryover `sessions`/`session_cards` tables — see §4 below). |

### 2.4 Multi-tenant

| V1 path | V2 path | Status |
|---|---|---|
| `GET /api/shop` | unchanged | kept. |
| `POST/PATCH /api/shop` | unchanged | kept. |
| `GET /api/shop-config/:slug` | unchanged | kept; sanitised view. |
| `POST /api/quote-lead` | unchanged | kept. |
| — | `POST /api/v2/quote-offer/:token/{accept,decline}` | NEW — uses carryover `quote_offers.accept_token`. |

### 2.5 Health / observability

| V1 path | V2 path | Status |
|---|---|---|
| `GET /api/health` | unchanged | kept. |
| — | `GET /api/version` | NEW — `{ git_sha, built_at, node_version, uptime }`. |
| — | `GET /api/metrics` | NEW — Prometheus exposition; behind `requireAdmin` or a separate token. |

### 2.6 Admin

All V1 admin paths preserved verbatim. `POST /api/admin/arbitrage` keeps its body shape; the response gains a `v2` envelope only on `/api/v2/admin/arbitrage`.

### 2.7 Stripe

`POST /api/stripe-webhook` is untouched — its signature requires the raw-body capture from V1's `express.json` `verify` callback (audit §5.12). The new server bootstrap re-registers the same `verify` shape.

### 2.8 Rate limits

V1's `identifyLimiter` (60/min) and `quoteLeadLimiter` (10/hr) are global per-IP. V2 adds:
- per-user limits on top of per-IP (from `req.user.id`),
- response header `RateLimit-Policy` (RFC 9230) on every limited endpoint.

The V1 caps stay; V2 adds *additional* headroom, never tightens.

### 2.9 Status codes

| Code | When |
|---|---|
| `200` | OK |
| `400` | malformed body / missing fields |
| `401` | no JWT / expired JWT (auth modal trigger) |
| `403` | wrong plan / non-admin (plan upgrade modal trigger) |
| `404` | resource not found |
| `409` | unique-violation (`shops.slug`, `shops.owner_user_id`) |
| `429` | rate-limit OR `scan_quota_exceeded` (quota modal trigger) |
| `500` | server error (no stack to client) |
| `503` | upstream unavailable (Supabase / Stripe / Anthropic configured-out) |

---

## 3. Pricing engine contract

The pricing engine is the largest standalone slice. Splitting it is what makes A2 parallelisable with everything else.

### 3.1 Adapter interface

Every external data-source adapter (`pokemontcg`, `scryfall`, `justtcg`, `tcggo-rapidapi`, `ebay-sold`, `cardmarket-html`, `tcgdex`, `swu-db`, `ygoprodeck`, `lorcana`) implements:

```typescript
interface PricingAdapter {
  // Stable name; used in source priority + telemetry
  readonly name: string;

  // What this adapter can answer for. Filtered before fanning out.
  readonly supports: { games: Game[]; needs: ('verified_card'|'set_code'|'card_number'|'image')[] };

  // True if env vars / API keys / quotas allow a real call right now.
  // Cheap (no I/O); checked synchronously before fan-out.
  isAvailable(): boolean;

  // Verify a card identification (returns DB-canonical fields + reference image).
  // Some adapters are price-only and return null here.
  verify?(card: PartialCard, ctx: AdapterCtx): Promise<VerifiedCard | null>;

  // Quote prices for a verified card. Returns null on miss (no error throw on
  // upstream miss — only throw on unexpected failures).
  price?(card: VerifiedCard, ctx: AdapterCtx): Promise<PriceQuote | null>;
}

interface PriceQuote {
  source: string;                    // adapter.name
  market_value_eur: number | null;   // best-effort EUR (apply fx if upstream is USD)
  raw_currency: 'EUR' | 'USD';
  raw_value: number | null;
  confidence: number;                // 0..1; see §3.3
  fetched_at: string;                // ISO8601
  // optional, surface-only fields
  trend?: number | null;
  avg7?: number | null;
  avg30?: number | null;
  graded?: { company: string; grade: number; price_eur: number }[];
  sample_size?: number;
  product_url?: string | null;
  blocked_by?: 'cloudflare' | 'rate_limit' | 'auth' | null;
}
```

### 3.2 Aggregation strategy

```
resolveSources(card):
    candidates = adapters.filter(a => a.supports.games.includes(card.game) && a.isAvailable())
    sort candidates by static priority [tcggo-rapidapi, cardmarket-html, justtcg, pokemontcg, scryfall, ebay-sold]

priceCard(verifiedCard):
    quotes = await Promise.all(candidates.map(a => a.price(verifiedCard).catch(() => null)))
    quotes = quotes.filter(q => q && q.market_value_eur != null)

    if verifiedCard.graded:
        gradedQuote = pickGraded(quotes, verifiedCard.graded)
        if gradedQuote: return packageGraded(gradedQuote)

    selected = quotes.sort(by confidence desc, then by static priority)[0]
    return {
      market_value: selected.market_value_eur,
      buy: applyConditionAndPercentage(selected.market_value_eur, verifiedCard.condition, verifiedCard.buy_pct),
      hotness: scoreHotness(quotes),
      v2: { selected_source: selected.source, sources: quotes, ... }
    }
```

V1 priority (later overrides earlier) is preserved as the static priority list above; the audit-flagged source-overrides (audit §2 Source priority) become explicit, not implicit-by-control-flow.

### 3.3 Confidence scoring

A single `0..1` confidence per quote, computed by the adapter:
- `tcggo-rapidapi`: 0.85 base, +0.05 if `avg7 > 0` (active liquidity), -0.20 if response was cached >24h.
- `cardmarket-html`: 0.95 if a non-CF page parsed cleanly, 0 if blocked.
- `justtcg`: 0.65 base, +0.10 if condition exact match, -0.15 if printing fallback.
- `pokemontcg`: 0.70 base — embedded `cardmarket.prices` is daily-snapshotted by upstream.
- `scryfall`: 0.70 base, identical reasoning.
- `ebay-sold`: `min(0.9, 0.3 + 0.04 * sample_size)`, capped at 0.9.

These numbers are documented; A2 may tune them as part of phase 3 implementation but A7 fixture tests pin the relative ordering ("TCGGO with active liquidity beats raw pokemontcg.io for the same card").

### 3.4 Cache layer

- **identCache** (image SHA1 → identify result): in-memory LRU, 100 entries, no TTL. Skipped when `verify_rejected` is set. (V1 §5.3 invariant.)
- **priceCache** (composite key → price response): in-memory LRU, 500 entries, **60-min TTL**. Composite key: `game|name|set_code|card_number|condition|variant|graded|buy_pct`. (V1 invariant.)
- **adapterCache** (NEW): per-adapter, per-`{game,set,number}` TTL cache. Default 10 min; `cardmarket-html` short to 60s on success because Cardmarket prices move; `pokemontcg` long to 6 h because their data is daily.
- **shopConfigCache**: in-memory, 5-min TTL, slug-keyed; invalidated on shop rename.
- All caches logged on hit/miss to a structured logger so cache-effectiveness is measurable.

### 3.5 Tunables

Hoisted to `pricing/confidence.js` as exported constants so a sub-agent can find and tune them in one place. The audit-flagged values (§5.6) are pinned with regression tests:

```js
export const RACE_THRESHOLD = 220;     // race-exit on first per-query best
export const RACE_GRACE_MS = 150;      // post-trigger grace window
export const MIN_ACCEPT_SCORE = 120;   // floor below which verify rejects the match
export const HP_MISMATCH_TOLERANCE = 20;
export const DOUBLE_CHECK_SCORE_GATE = 200;  // skip image double-check above this
```

### 3.6 Anthropic model

Hoisted to one constant:

```js
export const IDENT_MODEL = 'claude-sonnet-4-6';
export const READ_SET_CODE_MODEL = 'claude-sonnet-4-6';
export const DOUBLE_CHECK_MODEL = 'claude-sonnet-4-6';
export const OCR_FIRST_VALIDATE_MODEL = 'claude-sonnet-4-6';   // NEW (Q3)
```

Three places in V1 (audit §5.22) collapse to one config file. A bump is one PR.

### 3.7 OCR-first scan path (Q3)

Re-enabled in V2 with mandatory validation. Lives in `pricing/ocr-first/pipeline.js`.

```
client image → /api/read-set-code  (Sonnet 4.6 OCR, 10-token response)
                  │
                  ▼
              parsed: { set_code, card_number, optional_total }
                  │
                  ▼
       set-total cross-check (existing — corrects MEP→MEG when total mismatches)
                  │
                  ▼
         /api/identify-manual (resolves to canonical card)
                  │
                  ▼
     ┌────────────VALIDATION GATE────────────┐
     │ pricing/ocr-first/validation.js       │
     │ Sonnet 4.6 sees TWO images:           │
     │   1. user's scan                      │
     │   2. canonical card's reference image │
     │ Returns {match: bool, reason}         │
     └───────────────────────────────────────┘
                  │
            match? │
        ┌─────yes─┴─no─────┐
        ▼                  ▼
 return canonical    fall through to
   card object       /api/identify-stream
                     (existing path)
```

**Safeguards** (per Q3 answer):
- **`OCR_FIRST_ENABLED` env var**, defaults `false`. Toggle without redeploy if accuracy regresses.
- **Telemetry**: every attempt writes a `scan_events` row with `endpoint='ocr-first'` plus `data: {ocr_set_code, validated, fell_through_reason}`.
- **`OCR_FIRST_FP_THRESHOLD` constant** in `confidence.js` — defaults `0.02` (2% false-positive rate). Background job inspects the last 24 h of attempts; if FP rate exceeds threshold, log a warning + emit a Sentry alert. (Auto-disable on threshold breach is **deferred** — too easy to misfire on a small sample.)
- **Regression fixtures** (RG-31..RG-40 in §7): historical break cases — sleeved cards, holo glare, promo cards without slashes, EX-era cards with shared numbers across sets, foreign-language printings.
- **Server-side rate limit unchanged** (60/min via `identifyLimiter`).
- **Quota counts the same**: every OCR-first attempt logs a scan_event whether or not it falls through, so user quotas are honest.

The V1 `/api/read-set-code` endpoint stays at the same path with the same response shape. The `tryOcrIdentify` client function is rewritten to call the validation gate before trusting the result.

---

## 4. Persistence schema

Source of truth: `supabase/migrations/`. Tables, in V2 owner / role:

| Table | V1 status | V2 owner | V2 plan |
|---|---|---|---|
| `auth.users` | Supabase-managed | — | unchanged |
| `profiles` | used | unchanged | migrated in repo (`20260421_phase_b_core.sql`) |
| `scan_events` | used | unchanged | as above. Extended with `data jsonb` column for OCR-first telemetry (additive migration) |
| `user_state` | used | **deprecating (F17)** | V2 dual-writes to `user_state` + `sessions`/`session_cards`. Reads prefer relational once `READ_FROM_RELATIONAL=true`. JSONB column dropped in a V2.1 follow-up migration after one release of dual-write stability |
| `shops` | used | unchanged | already migrated |
| `quote_leads` | used | unchanged | already migrated |
| `sessions`, `session_cards` | unused | **A3 ADOPT (F17)** | Primary store for the multi-named-session log. Dual-writer with `user_state` for one release window, then cutover. Sub-agent A3's largest slice |
| `card_prices` | unused | **A2 ADOPT (F16)** | Move `data/card-prices.json` into Postgres. Warm in-memory `CARD_PRICES` Map from the table on boot. Render persistent disk lets us keep the file path alive for local dev only |
| `inventory_items`, `inventory_events`, `listings` | unused | **A9 ADOPT (F18)** | Full inventory subsystem. New `apps/server/routes/inventory.js`, new vendor tab, marketplace adapters in `pricing/marketplaces/`. Listing fees + sold prices populate the existing columns |
| `live_sessions`, `live_session_scans` | unused | **A1 ADOPT (F15)** | Replaces in-memory `rooms` Map. The Render Starter plan removes the "survive sleep" pressure; we adopt anyway for redeploy survival + multi-laptop pairing |
| `customer_accounts`, `quote_offers` | unused | **A10 ADOPT (F19)** | Customer-facing accounts via Supabase auth (separate flow from vendor). Tokenised offer accept/decline. New `apps/customer/` UI app |

### 4.1 Migration path

Per audit non-negotiable §2.4 ("never edit data in place without a backup"):

1. **Phase 3 commit 1**: write any new schema as additive migrations under `supabase/migrations/`, with sibling `*_rollback.sql`. Apply via Supabase SQL editor against the prod DB (Q6 in-place deploy means no preview DB; we apply to prod cautiously, after each migration is reviewed).
2. **Phase 3 commit per slice**: server reads from BOTH old and new locations; writes to BOTH.
3. **Phase 4**: regression suite passes against the dual-write build.
4. **Phase 5 cutover**: server reads from new only; old location continues to be written for one further release as a tripwire ("if anything still depends on it, we'll see writes").
5. **Post-V2**: drop the old location in a follow-up migration.

For `user_state` → `sessions`+`session_cards` (F17): the dual-write window happens **inside V2** rather than across V2 → V2.1. A3 ships the dual-writer in S1, the relational reader is gated behind `READ_FROM_RELATIONAL=false` until the regression suite confirms parity, then flipped to `true` near the end of phase 4. The JSONB column drop is a separate migration in the first release after V2 ships.

**S24 parity rubric** (added by slice S24): the read-flip is invisible to the client iff the relational path returns the same content the JSONB path returned. The S24 deliverables — `tests/regression/sessions-readflip.spec.js` (23 parity tests) plus `infra/deploy/sessions-readflip-runbook.md` (operator-facing flip+rollback steps) — make that contract testable. Documented divergences (uuid-keyed session map, defensive `wantlist`/`v` normalisation on the relational path) are listed in the runbook §3.3 + §7 so operators expect them. The parity suite must pass on the deployed build *before* the runbook is executed.

### 4.2 File-backed state (server-local)

Render Starter (Q2) means we have persistent disk, so files survive redeploys:

| File | V1 status | V2 plan |
|---|---|---|
| `data/card-db.json` | primary read path for verify | **keep on persistent disk**. Boot still falls through to pokemontcg.io re-pull on missing file. `card_prices` Postgres table holds prices but not the broader `CARD_DB` (yet) |
| `data/card-prices.json` | admin arbitrage source | **deprecated**. `card_prices` Postgres table is primary. JSON file written as backup for one release, dropped in a follow-up |
| `logs/bad-ids.log` | append-only JSONL | unchanged; rotation script in `scripts/` |

---

## 5. Feature roster

Operator-locked at end of phase 2. All ✓ / ✗ are final.

| # | Feature | Status | Owner | Effort | Risk |
|---|---|---|---|---|---|
| F1 | Multi-source aggregation with confidence + "why this price" UI | ✓ V2 | A2 + A4 | M | medium |
| F2 | Condition-aware pricing with vendor spreads | ✓ already in V1 | A4 | S | low |
| F3 | Bulk paste / CSV upload → full quote | ✓ V2 | A4 + A5 | M | medium — interacts with rate limits |
| F4 | Set / edition disambiguation chooser | ✓ already in V1 (`candidates`) — surface better in V2 | A4 | S | low |
| **F5** | **Sealed product pricing** (boosters, ETBs, bundles) | **✓ V2 (Q1)** | A2 | L | medium — new data model; V2.0.1 ships Cardmarket scrape + manual override (no paid tier required) |
| F6 | Quote persistence — stable URL, recoverable | ✓ V2 | A1 + A5 | M | medium |
| F7 | PDF export of quotes (vendor-branded) | ✓ V2 | A5 | M | low |
| F8 | Vendor analytics dashboard | ✓ V2 | A1 + A4 | M | medium |
| F9 | Trade credit vs cash split | ✓ already in V1 — keep | A4 | XS | none |
| F10 | Rate-limit + per-IP abuse — extend per-user | ✓ V2 | A1 | S | low |
| F11 | Mobile-first restyle of all surfaces | ✓ V2 | A4 + A5 + A10 | M | medium |
| F12 | Widget v2 — themes, postMessage, lazy-load, in-place upgrade (Q4) | ✓ V2 | A6 | M | **high** — back-compat is non-negotiable |
| F13 | Observability — pino + Sentry (Q5) + `/version` + `/metrics` | ✓ V2 | A8 | M | low |
| F14 | Vendor auth — single password + session | ✓ already in V1 (Supabase) | A1 | XS | none |
| F15 | Phone-pair survives redeploy (Postgres `live_sessions`) | ✓ V2 | A1 + A3 | M | medium — touches scanner-mode |
| F16 | Adopt `card_prices` table for arbitrage data | ✓ V2 | A2 + A3 | S | low |
| **F17** | **Adopt `sessions`/`session_cards` table — replace JSONB blob** | **✓ V2 (Q1)** | A3 | L | high — dual-write + cutover. S24 parity tests + readflip runbook landed in commit \<pending\>; flip is operated post-V2-ship via Render env, not part of V2 cutover itself. |
| **F18** | **Inventory subsystem** | **✓ V2 (Q1)** | A9 (NEW) + A1 + A4 | XL | very high — touches every surface |
| **F19** | **Customer-side accounts + tokenised offer accept/decline** | **✓ V2 (Q1)** | A10 (NEW) + A1 + A5 | L | high — new auth flow |
| F20 | Pricing engine model bumped to one constant | ✓ V2 | A2 | XS | none — pure refactor |
| F21 | Single `apiClient` module (kills R1) | ✓ V2 must-have | A4 | S | low |
| F22 | Migrations + rollbacks for every schema change | ✓ V2 must-have | A3 | S | none |
| F23 | Hoist Cardmarket set-slug tables into one source-of-truth | ✓ V2 | A2 | S | low |
| **F24** | **OCR-first scan re-enabled with image-compare validation gate (Q3)** | **✓ V2 (Q3)** | A2 + A7 | M | medium — accuracy-critical, telemetry-gated |
| **F25** | **Render Starter upgrade + persistent disk (Q2)** | **✓ V2 (Q2)** | A8 | XS | none — config change |
| **F26** | **In-place deploy with phase-5 release runbook (Q6)** | **✓ V2 (Q6)** | orchestrator + A8 | S | medium — cutover safety relies on runbook |

Legend: XS = <½ day, S = ½–1 day, M = 1–3 days, L = 3–7 days, XL = >1 week.

**Estimated total effort:** ~22–28 person-days of focused work, parallelisable across 10 sub-agents per the §6 plan. Calendar: 4–6 weeks.

**Sub-agent roster** updated from `CARD_PRICER_V2_PROMPT.md` §3:

| Agent | Owns | Read-only |
|---|---|---|
| A1 — Backend/API | `apps/server/`, `routes/`, `middleware/` | everything in `apps/vendor/`, `apps/quote/`, `apps/widget/`, `apps/customer/` |
| A2 — Pricing engine | `pricing/`, including `sealed/`, `ocr-first/`, `marketplaces/` adapter contract | `apps/server/routes/` (read for integration) |
| A3 — Persistence | `db/`, `supabase/migrations/`, schema docs | route handlers (read) |
| A4 — Vendor UI | `apps/vendor/` (the editorial-terminal index.html split) | widget, quote, customer |
| A5 — Customer quote UI | `apps/quote/` (the editorial customer-facing /quote) | vendor, widget, customer |
| A6 — Embed widget | `apps/widget/widget.js` (V2 + V1 backup) + test harness | everything else |
| A7 — Testing/QA | `tests/`, fixtures, regression suite, CI | all (read) |
| A8 — DevOps | `infra/` (render.yaml, env, observability, deploy runbooks), Sentry config | code (read) |
| **A9 — Inventory (NEW)** | `apps/server/routes/inventory.js`, `db/inventory/`, `pricing/marketplaces/`, `apps/vendor/modules/tabs/inventory.js` | everything else |
| **A10 — Customer accounts (NEW)** | `apps/customer/`, `apps/server/routes/customer.js`, `apps/server/routes/quote-offer.js`, `db/customers/` | vendor, widget |

---

## 6. Concurrency plan

Aligned to `CARD_PRICER_V2_PROMPT.md` §3 + the expanded scope. Each row starts when its `Depends-on` rows are accepted. "Day" numbers are calendar-relative to phase 3 start.

| Slice | Owner | Depends-on | Earliest start | Owned files |
|---|---|---|---|---|
| **S0 — Branch + scaffold** | orchestrator | phase 2 approved | day 0 | new directories + empty index files; first commit on `v2` branch |
| **S1 — Persistence schema + contract** | A3 | S0 | day 0 | `db/schema.md`, `supabase/migrations/*` (additive only) |
| **S2 — Pricing engine contract** | A2 | S0 | day 0 | `pricing/adapter.interface.md`, `pricing/confidence.js` constants |
| **S3 — Test scaffold** | A7 | S0 | day 0 | `tests/` directory + one passing smoke test |
| **S4 — DevOps scaffold** | A8 | S0 | day 0 | `infra/`, `render.yaml` Starter upgrade (Q2), `env.example` parity, Sentry skeleton |
| **S5 — Backend modular extraction** | A1 | S1 ✓ | day 1 | `apps/server/**` — extracts V1 routes, no behaviour change |
| **S6 — Pricing engine extraction** | A2 | S2 ✓, S5 contract | day 2 | `pricing/**` — moves V1 functions, preserves constants + priorities + model constant |
| **S7 — apiClient + scaffold vendor app split** | A4 | S5 ✓ | day 2 | `apps/vendor/modules/api-client.js` + thin tab modules |
| **S8 — Quote app split** | A5 | S5 ✓ | day 2 | `apps/quote/modules/*` |
| **S9 — Widget v2 (in-place upgrade per Q4)** | A6 | S5 ✓ | day 2 | `apps/widget/widget.js` (V2) + `widget-v1.js` (backup) + test harness |
| **S10 — `card_prices` adoption (F16)** | A2 + A3 | S1 ✓ S6 ✓ | day 4 | additive — admin arbitrage reads from Postgres, file kept as backup |
| **S11 — `live_sessions` adoption (F15)** | A1 + A3 | S5 ✓ S1 ✓ | day 4 | additive — `/api/room/*` writes to BOTH in-memory + Postgres |
| **S12 — Quote persistence (F6)** | A1 + A5 | S5 ✓ S8 ✓ | day 5 | new `/api/v2/quote/:id` |
| **S13 — Analytics (F8)** | A1 + A4 | S5 ✓ S7 ✓ | day 5 | new admin tab + new endpoint |
| **S14 — Observability (F13)** | A8 | S5 ✓ | day 5 | pino middleware + `/api/version` + `/api/metrics` + Sentry SDKs (Q5) |
| **S15 — OCR-first re-enable (F24, Q3)** | A2 + A7 | S6 ✓ | day 5 | `pricing/ocr-first/*`, `OCR_FIRST_ENABLED` env, RG-31..RG-40 fixtures |
| **S16 — Sessions cutover dual-write (F17, Q1)** | A3 | S5 ✓ S11 ✓ | day 6 | `db/sessions/dual-write.js`, `READ_FROM_RELATIONAL` flag |
| **S17 — Sealed pricing (F5, Q1)** | A2 | S6 ✓ | day 6 | `pricing/sealed/*`, `pricing/adapters/cardmarket-sealed.js` (V2.0.1; was tcgplayer-pro.js), `/api/v2/price-sealed` route |
| **S18 — Inventory backend (F18, Q1)** | A9 | S5 ✓ S1 ✓ | day 7 | `apps/server/routes/inventory.js`, `db/inventory/*`, `pricing/marketplaces/*` |
| **S19 — Inventory vendor UI (F18, Q1)** | A9 + A4 | S18 contract | day 9 | new vendor tab `apps/vendor/modules/tabs/inventory.js` |
| **S20 — Customer accounts backend (F19, Q1)** | A10 + A1 | S5 ✓ S1 ✓ | day 7 | `apps/server/routes/customer.js`, `routes/quote-offer.js`, `db/customers/*` |
| **S21 — Customer dashboard UI (F19, Q1)** | A10 + A5 | S20 contract S8 ✓ | day 9 | `apps/customer/*` (new app), magic-link flow |
| **S22 — Mobile restyle (F11)** | A4 + A5 + A10 | S7 ✓ S8 ✓ S21 ✓ | day 14 | `styles/` + per-app tweaks |
| **S23 — Widget v2 polish + back-compat tests (Q4)** | A6 + A7 | S9 ✓ | day 14 | `apps/widget/test-harness.html`, snapshot diff vs V1 |
| **S24 — Sessions cutover read-flip (F17)** | A3 + A7 | S16 ✓ all parity tests passing | day 18 | flip `READ_FROM_RELATIONAL` to `true` |
| **S25 — Release runbook + Stripe smoke procedure (Q6)** | A8 + orchestrator | S5 ✓ S14 ✓ | day 16 | `infra/deploy/release-runbook.md`, `stripe-webhook-smoke.md` |
| **S26 — Regression suite full pass + smoke** | A7 + orchestrator | every previous slice | day 22 | tests/ green, `docs/V2_SMOKE_TEST.md` |

**Forbidden parallelism** (per `CARD_PRICER_V2_PROMPT.md` §3 "never run two agents that own the same file at the same time"):
- A2 and A1 cannot both edit `apps/server/routes/identify.js` or `routes/price.js` concurrently. Split enforced by directory: A1 owns `apps/server/`, A2 owns `pricing/`. Where they meet (route delegates to engine), A1 writes the route handler and imports from `pricing/`.
- A4 and A5 share `styles/tokens.css` only; read-only for both during S7/S8, A4 writes during S22.
- A9 (inventory) and A1 share `apps/server/routes/`. A9 owns *only* `routes/inventory.js`; A1 owns the rest. Cross-cutting changes go via A1.
- A10 (customers) and A5 share `apps/quote/`. A10 owns *only* `apps/customer/`; A5 keeps `apps/quote/`. The customer-account dashboard is a sibling, not a fork.

**Critical-path slices** that block everything downstream: S1 (schema), S5 (backend extraction), S2/S6 (pricing extraction). If any of these slip, the calendar slips with them.

---

## 7. Test plan

### 7.1 Regression tests (A7) — must pass before any V2 ships

One test per row in `V2_AUDIT.md` §1 (surface map) and §5 (hidden behaviours). Selected high-value examples:

| ID | Behaviour | Test |
|---|---|---|
| RG-01 | wrapped `window.fetch` injects JWT | mock `sb.auth.getSession`; assert `Authorization: Bearer …` on outgoing `/api/me` |
| RG-02 | 401 surfaces auth modal | server returns 401; assert `showAuthOverlay` called |
| RG-03 | 429 surfaces quota modal | server returns `{error:'scan_quota_exceeded'}`; assert quota modal |
| RG-04 | `X-Scan-*` updates banner | response with headers; assert `renderUsage` called |
| RG-05 | scanner-mode bypass | URL `?pair=ABC123`; assert auth gate skipped, camera activated |
| RG-06 | Pokellector overrides win | seed CARD_DB with `me1-3` from pokemontcg.io; apply corrections; assert "Mega Venusaur ex" not the bad name |
| RG-07 | POKEMONTCG_UNRELIABLE skip | feed a `mep` row from pokemontcg.io to processPageData; assert it's skipped |
| RG-08 | verify race threshold | mock pokemontcg.io with one ≥220-score query and one ≥120 follow-up; assert exit before the slow one finishes; total time < 1 s |
| RG-09 | MIN_ACCEPT_SCORE rejects 100-score | force best-only-name match; assert `verified:false` (no "wrong correction") |
| RG-10 | HP-mismatch reject | verify a card whose AI HP differs from DB HP by >20; assert `verify_rejected:'hp_mismatch'` |
| RG-11 | identCache skipped on verify_rejected | scan twice; assert second scan does NOT return cached `verify_rejected` |
| RG-12 | priceCache TTL | freeze clock, call /api/price, advance clock 59m → cache hit; advance to 61m → cache miss |
| RG-13 | arbitrage one-row-per-variant | seed `CARD_PRICES` with both holofoil + reverseHolofoil for one card; assert two rows in response |
| RG-14 | Stripe webhook signature | replay a real test-mode event; assert `req.rawBody` is intact and signature verifies |
| RG-15 | quote-lead persists on Brevo failure | mock Brevo as 500; assert `quote_leads` row inserted |
| RG-16 | shopConfigCache invalidated on slug rename | PATCH with new slug; assert old + new keys both invalidated |
| RG-17 | `shops.unique(owner_user_id)` | POST /api/shop twice for same user; assert 409 |
| RG-18 | service-worker cache version bumped on shell change | static analysis: if `index.html` changes, `service-worker.js`'s `CACHE_VERSION` must change |
| RG-19 | widget v1 still works | load `widget.js` v1 in test-harness; assert button + iframe + close still work end-to-end |
| RG-20 | image pipeline sizes preserved | inspect resize calls; assert client 2000/2400 q0.95, server 1800/2200 q92 |
| RG-21 | stripInternals removes `_refImagePromise` | seed verify result with `_refImagePromise`; assert response JSON has no `_*` keys |
| RG-22 | trust proxy = 1 set on app | static check `app.set('trust proxy', 1)` exists |
| RG-23 | `/api/correct-card` requires auth | unauthenticated request → 401 (regression for V1 fix) |
| RG-24 | `/api/card-db-rebuild` requires admin | non-admin request → 403 (regression for V1 fix) |
| RG-25 | scanner-mode auth bypass intact after refactor | URL `?pair=…`; assert `_initAuthGate` returns early |
| RG-26 | per-game verify exists for every game in CARD_ID_SYSTEM_PROMPT | static: every game listed in the system prompt has a verifier or generic fallback |
| RG-27 | USD→EUR fallback bound | feed a wild rate (e.g. 5.0); assert `USD_TO_EUR` unchanged |
| RG-28 | Pokemon `me1-155` returns "Mega Venusaur ex" via Pokellector | known-good fixture |
| RG-29 | Pokemon `me1-3` does NOT return whatever pokemontcg.io has | known-bad fixture, must not appear |
| RG-30 | `/api/lookup-by-number` handles SM211 promo | known-good fixture |
| RG-31 | OCR-first: sleeved card → validation rejects → fall through to identify | fixture: blurred sleeve glare |
| RG-32 | OCR-first: holo glare on bottom strip → set-total mismatch corrects | fixture: MEP glare reads as MEG |
| RG-33 | OCR-first: SM211 promo (no slash) → identify-manual hits, validation passes | fixture |
| RG-34 | OCR-first: same number across EX-era sets → validation picks correct | fixture: Psyduck #44 across multiple sets |
| RG-35 | OCR-first: foreign-language printing → validation accepts (image is the same printing, language differs) | fixture: German Glurak |
| RG-36 | OCR-first: false-positive rate logged | seed 100 attempts; assert telemetry rows exist with `validated` boolean |
| RG-37 | OCR-first: `OCR_FIRST_ENABLED=false` → endpoint returns 503 immediately, no Anthropic call | env override test |
| RG-38 | OCR-first: validation rejects → fall-through emits standard `/api/identify-stream` events | NDJSON shape preserved |
| RG-39 | OCR-first: scan_event always written (whether validated or fell through) | quota honesty |
| RG-40 | OCR-first: `OCR_FIRST_FP_THRESHOLD` breach → Sentry warning emitted | mock 5/100 fails, expect alert |
| RG-41 | Widget V1 + V2 attribute parity (Q4) | render V1 widget vs V2 widget with V1-only attributes; assert DOM diff = 0 |
| RG-42 | Widget V2 with `data-theme="light"` produces light theme DOM | snapshot |
| RG-43 | Widget V2 telemetry beacon fires on init | mock `/api/widget/loaded`, assert called with version |
| RG-44 | Stripe webhook signature still verifies after middleware refactor | end-to-end with rawBody capture intact |
| RG-45 | Sentry `beforeSend` strips card images, emails, auth headers | seed events with each, assert scrubbed |
| RG-46 | Sessions cutover dual-write parity | every PUT /api/state writes both JSONB blob + relational rows; values match |
| RG-47 | Sessions cutover read-flip safe | flip `READ_FROM_RELATIONAL=true`, assert reads return same content as JSONB blob |
| RG-48 | F18 inventory: buy → list → sold P&L math | seed an item, list, mark sold; assert P&L correct after fees |
| RG-49 | F19 customer accept-token validation | unknown token → 404; expired → 410; valid → 200 + status flips to accepted |
| RG-50 | F19 customer accounts can only see own offers | RLS test: user A cannot SELECT user B's quote_offers row |

### 7.2 V2 feature tests (A7)

| ID | Feature | Test |
|---|---|---|
| F1-01 | `/api/v2/price` returns `v2.sources` array | every adapter in `candidates` shows up with confidence |
| F1-02 | source priority: TCGGO active > pokemontcg | both return prices; TCGGO selected |
| F5-01 | `/api/v2/price-sealed` returns sealed product price | ETB rich-shape input → Cardmarket sealed adapter (V2.0.1) → market price (scrape OR manual_market_eur override) |
| F5-02 | sealed product not found → graceful 404 | invalid SKU |
| F6-01 | quote persistence | POST /api/v2/quote → `{id, url}`; GET /api/v2/quote/:id returns identical content |
| F8-01 | analytics endpoint | seed `quote_leads` + `scan_events`; assert daily counts match |
| F12-01 | widget V2 loads with `data-theme="light"` | DOM injected with light theme |
| F12-02 | widget V2 with V1-only attributes (Q4) | DOM identical to V1 (snapshot) |
| F13-01 | `/api/version` returns `{git_sha, built_at, node_version, uptime}` | all four fields non-empty |
| F13-02 | Sentry catches a thrown server error | force a route to throw, assert event lands in Sentry mock |
| F13-03 | Sentry catches a browser console error | force `throw` in browser, assert event captured |
| F15-01 | live_sessions survives "redeploy" | seed a session, simulate process restart by clearing in-memory map; assert SSE stream resumes from Postgres |
| F16-01 | `card_prices` table read | clear `data/card-prices.json`; arbitrage scan still returns rows |
| F17-01 | sessions cutover end-to-end (F17) | flip flag, save → read → modify → save → read; relational state matches expected after every step |
| F18-01 | inventory: full workflow | bought → listed cardmarket → price_change → sold; events table has 4 rows in order |
| F18-02 | inventory: P&L summed across listings | item with multiple sub-listings sums correctly |
| F19-01 | customer magic-link sign-in | mock magic link, assert customer_account row created |
| F19-02 | customer offer accept | POST /api/v2/quote-offer/:token/accept → status='accepted', vendor receives notification email |
| F19-03 | customer offer expired | accept a token where `expires_at` is in the past → 410 Gone |
| F24-01 | OCR-first happy path | sealed-fixture image with clean set code → returns canonical card in <1.5s |
| F24-02 | OCR-first false-positive caught by validation | seed image where set-code OCR is correct but card is alt-art → validation rejects, falls through |
| F25-01 | Render Starter health check on always-on | continuous health pings show no >5s latency spikes |
| F26-01 | release runbook executable | dry-run on local: tag v1-final, simulate deploy, simulate rollback |

### 7.3 Smoke tests (orchestrator, phase 4)

Walk all three surfaces yourself. Per `CARD_PRICER_V2_PROMPT.md` §7.3 produce `docs/V2_SMOKE_TEST.md`. Minimum coverage:
- Vendor app: sign in, run a scan, see a result, log it, change condition, change cash %, refresh prices, export XLSX, sign out.
- Quote app: open `/quote?shop=brewed`, paste 5 lines, get quote, submit email gate, verify email arrives.
- Widget: load `test-harness.html`, click button, complete the iframe flow, see `cp:submitted` postMessage in console.

---

## Concurrency dependency graph (textual)

```
S0 ──┬──► S1 (A3 schema)        ──► S5 (A1 backend)        ──┬──► S7 (A4 vendor)   ──► S15
     │                                                       ├──► S8 (A5 quote)    ──► S15
     ├──► S2 (A2 contract)       ──► S6 (A2 pricing)         ├──► S10 (A2+A3 card_prices)
     ├──► S3 (A7 tests)          ──► (S5..S16 each spawn additional test specs)
     ├──► S4 (A8 infra)          ──► S14 (observability)
     │
     │                                                        ├──► S9 (A6 widget)   ──► S16
     │                                                        ├──► S11 (A1+A3 live_sessions)
     │                                                        ├──► S12 (A1+A5 quote persistence)
     │                                                        └──► S13 (A1+A4 analytics)
     │
     └──────────────────────────────────────────── all merge into ──► S17 (A7 full pass)
```

---

## 8. Operator-locked decisions (recap)

| # | Question | Answer | Effect |
|---|---|---|---|
| Q1 | Sealed (F5) / inventory (F18) / customers (F19) / sessions cutover (F17) — defer or include? | **All four IN** | Timeline 4–6 wks, +A9 +A10 sub-agents, ~22 added test cases |
| Q2 | Render free vs Starter ($7/mo) | **Starter** | Persistent disk + always-on; `data/card-db.json` survives; no cold-start risk |
| Q3 | `/api/read-set-code` delete or re-enable | **Re-enable with validation gate** | New `pricing/ocr-first/`; `OCR_FIRST_ENABLED` env; telemetry-gated |
| Q4 | Widget V2 separate file vs in-place | **In place at `/widget.js`** | V1 contents preserved as `widget-v1.js` for rollback; V1-attribute-parity test mandatory |
| Q5 | Observability vendor | **Sentry free tier**, server + browser, with `beforeSend` scrubbing | A8 wires both SDKs; event grouping + alerting included |
| Q6 | Deploy preview env vs in-place | **In place** | Phase-5 release runbook owns the safeguards |

## 9. Release runbook outline (Q6 — full version in `infra/deploy/release-runbook.md`)

**V2 ships with `READ_FROM_RELATIONAL=false`.** The F17 sessions read-flip is a SEPARATE, distinct operation that runs AFTER V2 has been stable for at least one release window (recommended 2–3 weeks). It is owned by `infra/deploy/sessions-readflip-runbook.md` and is NOT part of the steps below. Conflating the two would put the read-path swap on the same change-window as the V2 ship, which is exactly what the dual-write design is meant to avoid.

Pre-cutover (T-24h):
1. All A7 regression tests green on v2 branch.
2. `docs/V2_SMOKE_TEST.md` walkthrough complete on local dev.
3. Stripe live-mode test event (`stripe events resend <recent_event_id>`) replayable.
4. Tag `v1-final` on `main`. `git push origin v1-final`.
5. **Disable Render auto-deploy** for the service.
6. **Reduce `/widget.js` `Cache-Control` to 60 s** in `routes/static.js`. Deploy this single change to V1 first; wait for old caches to expire.
7. Sentry alerts armed. Operator on standby.

Cutover (T-0):
1. Merge `v2 → main`. Do NOT push yet — verify tag is in place.
2. Pre-deploy dry run on prod: walk vendor app, confirm V1 still healthy, env vars expected, Supabase OK, Stripe live-mode customer count expected.
3. Push `main`. Click "Manual Deploy" in Render. Watch logs.
4. Within ~60 s of deploy completing: hit `/api/version`, expect new git_sha. `/api/health` expect ok.
5. Walk vendor app: sign in, scan a fixture card, see result, log it.
6. Walk customer flow: open `/quote?shop=brewed`, paste 3 lines, get quote, complete email gate.
7. Walk widget: load Board & Brewed embed, click button, complete iframe flow.
8. Replay Stripe webhook: `stripe events resend <event_id>` → confirm `profiles` row updates correctly.

Post-cutover (T+0 to T+2h):
- Operator monitors Sentry + Render logs continuously.
- Any new error signature triggers immediate triage.
- After 2h with no new error groups, restore `/widget.js` `Cache-Control` to 300 s.
- Re-enable Render auto-deploy.

Rollback (any time within first 2h):
1. `git revert -m 1 <merge-commit-sha>` on `main`.
2. `git push origin main`.
3. Click "Manual Deploy" in Render.
4. Confirm `/api/version` returns the V1 git_sha.
5. If db migrations were applied with destructive changes, run `*_rollback.sql` siblings via Supabase SQL editor (V2 ships with no destructive migrations, so this should be a no-op).
6. Post-mortem within 24h.

## 10. Phase 3 entry conditions

When this document is approved:
1. Create branch `v2` off `main` HEAD.
2. Scaffold the directory layout from §1 in one commit (empty index files only).
3. Write `docs/api-contract.md`, `pricing/adapter.interface.md`, `pricing/marketplaces/adapter.interface.md`, `db/schema.md` — these are the contracts sub-agents must obey.
4. Spawn S0–S4 sub-agents in parallel with self-contained briefs.

---

**Phase 2 complete — review needed.**

This document is **scope-locked**. Awaiting explicit phase-3 approval to:
- Apply the V1 security fixes (already in working tree) + the two new migration files + this architecture as a single commit on `main`.
- Create the `v2` branch off that commit.
- Begin S0 scaffold.
