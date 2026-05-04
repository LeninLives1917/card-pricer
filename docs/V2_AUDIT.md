# Card-Pricer V1 Audit — for V2 Master Architect

**Branch:** `main` @ `a7d4f21` (post-rollback to "v60 / v1-final"). All notes below reflect what is live in `main` today, not the abandoned `v2/` scaffold.

**Working dir oddity to know up front:** `v2/` exists in the working tree but is **not tracked** by git (`git ls-files v2 | wc -l` → 0). It contains empty `src/`/`routes/` directories plus stale `node_modules/`, `.svelte-kit/`, `.turbo/` caches from a previous V2 attempt the rollback wiped. Two recent commits (`4153813 v2: wire bulk upload to /api/identify`, `53c7f63 v2: move admin gate to client-side`) reference that abandoned attempt. **Per CARD_PRICER_V2_PROMPT §2 we will work on a `v2` git branch and treat the `v2/` folder as cruft to ignore (or remove) — flag this with the operator before phase 3.**

---

## 1. Surface map

### 1a. `server.js` (5720 lines, single file, ESM)

Listed in route-declaration order. Auth column: `A` = `requireAuth`, `Q` = `enforceQuota`, `D` = `requireAdmin`, `P` = `requirePlan(SHOP_PLANS)`, `RL` = rate-limited (`identifyLimiter` 60/min, `quoteLeadLimiter` 10/hr), `—` = public.

| Method | Path | Auth | Purpose | Line |
|---|---|---|---|---|
| GET  | `/api/usage` | A | Plan + monthly scan count for client banner | 180 |
| POST | `/api/welcome-email` | A | Brevo welcome email after signup; no-op without `BREVO_API_KEY` | 222 |
| GET  | `/api/me` | A | `{user_id, email, plan, plan_interval, is_admin}` | 284 |
| GET  | `/api/admin/overview` | A+D | MRR/ARR, plan breakdown, scans this month, signups 30d | 302 |
| GET  | `/api/admin/users` | A+D | Recent 200 users with usage | 352 |
| POST | `/api/admin/arbitrage` | A+D | Scan in-memory `CARD_PRICES` map for US↔EU price gaps | 494 |
| POST | `/api/admin/refresh-prices` | A+D | Async re-pull pokemontcg.io (~5 min) | 577 |
| GET  | `/api/admin/refresh-status` | A+D | Polling status during refresh | 589 |
| POST | `/api/checkout` | A | Create Stripe Checkout session for plan upgrade | 641 |
| POST | `/api/portal` | A | Stripe billing portal URL | 680 |
| POST | `/api/stripe-webhook` | — (sig-verified) | Subscription state → profile.plan; uses raw body | 702 |
| GET  | `/api/state` | A | Read user-state JSON blob (sessions + wantlist) | 793 |
| PUT  | `/api/state` | A | Last-writer-wins upsert of state blob (10MB cap) | 808 |
| GET  | `/service-worker.js` | — | No-cache headers + serve file | 851 |
| GET  | `/`, `/index.html` | — | No-cache + serve vendor app | 857 |
| GET  | `/widget.js` | — | 5-min `Cache-Control` + serve embed loader | 865 |
| —    | `express.static('public')` | — | Static fallback for assets | 870 |
| POST | `/api/identify` | A+Q+RL | Single-shot Claude Vision identify + verify + double-check | 1284 |
| POST | `/api/identify-stream` | A+Q+RL | NDJSON stream — emits `ident` then `verified` then `done`; client prices off `ident` immediately | 1326 |
| GET  | `/api/card-db-status` | — | `{ready, loading, count, fileExists}` | 1989 |
| GET  | `/api/card-db-export` | — | CSV dump of in-memory `CARD_DB` | 2087 |
| POST | `/api/card-db-rebuild` | — | Wipe + re-pull pokemontcg.io | 2101 |
| POST | `/api/card-db-import-unreliable` | — | Import unreliable sets via TCGGO/RapidAPI | 2208 |
| POST | `/api/identify-manual` | A+Q | Skip Claude — operator-typed set+number lookup; Pokemon goes through local-DB → pokemontcg.io direct ID → search queries → race(TCGdex, JustTCG) → TCGGO; Magic via Scryfall; others build a shell card | 2442 |
| POST | `/api/read-set-code` | A+Q+RL | Sonnet 4.6 OCR — returns just the set code/number; **client tryOcrIdentify is hard-disabled (early return) but the endpoint is still reachable** | 2676 |
| POST | `/api/report-bad-id` | — | Append JSONL to `logs/bad-ids.log` (15MB body cap) | 2833 |
| POST | `/api/correct-card` | — | Overwrite local DB entry with `source: 'manual'` (highest trust) and persist to file | 2865 |
| POST | `/api/lookup-by-number` | A+Q | Direct number-only lookup (Tesseract OCR pipeline target) | 2911 |
| POST | `/api/price` | A | Fan-out pricing: Cardmarket-live (HTML scrape, mostly CF-blocked), pokemontcg.io / Scryfall, JustTCG, RapidAPI/TCGGO, eBay sold IE; merges with TCGGO winning unless cardmarket-live succeeds; emits hotness 0–100 | 4708 |
| GET  | `/api/search` | — | Scryfall autocomplete + pokemontcg.io search | 5043 |
| GET  | `/api/health` | — | Status + uptime + which API keys are present (used by client banner + UptimeRobot keep-alive) | 5100 |
| POST | `/api/room/:id/scan` | — (room-id is the secret) | Phone → laptop scan push (in-memory) | 5126 |
| GET  | `/api/room/:id/stream` | — | SSE; laptop subscribes for live phone scans | 5139 |
| GET  | `/api/room/:id/history` | — | Last 50 historical room messages | 5161 |
| GET  | `/quote` | — | Serve `public/quote.html` | 5171 |
| GET  | `/api/shop-config/:slug` | — (cached 5min) | Public, sanitised shop branding for `/quote` + widget | 5234 |
| POST | `/api/quote-lead` | RL | Customer email gate; sends email via Brevo, persists to `quote_leads`, optional newsletter subscribe (Brevo / Mailchimp / ConvertKit / off) | 5266 |
| GET  | `/api/shop` | A | Caller's shop row | 5639 |
| POST | `/api/shop` | A+P | Create shop (409 on dup slug or dup owner) | 5651 |
| PATCH| `/api/shop` | A+P | Partial update (also invalidates the shop-config cache for old + new slugs) | 5678 |
| GET  | `*` | — | SPA fallback to `index.html` | 5707 |

### 1b. `public/index.html` (7200 lines — vendor app, single file)

Top-of-`<head>` Supabase client + global `window.fetch` wrapper (line 62) — auto-attaches `Authorization: Bearer <jwt>` to every `/api/*`, auto-shows auth overlay on 401, auto-shows quota modal on 429, auto-renders usage from `X-Scan-*` response headers.

Tabs (declared 2918–2925): **Scan**, **Results**, **Session**, **Settings**, **Admin** (hidden until `/api/me` returns `is_admin: true`).

Scan-tab modes (mode-toggle 2965–2968): **Bulk** (camera-roll multi-upload, default), **Text** (paste set codes one-per-line). Camera-based "Single" mode was removed; the live camera UI is retained for **scanner mode** — the phone joined via `?pair=ROOMID` is the only thing that runs the camera flow live (uploads raw image to room → laptop processes locally via SSE).

Notable in-page features:
- **Session log** — multi-named-session store (state.sessions / currentSessionId), migrated from flat `cardpricer_log`. Per-row condition cycle, status flags, notes, reason tags, manual price overrides, duplicate counter, photo thumb.
- **Slider rows** — Cash % (10–90, default 50) + Credit % (20–100, default 70). `buyPercentage` is a third value (default 70) used by `/api/price` calls.
- **Want list** — local + synced; matched against new scans, badge surfaced.
- **Admin tab** — MRR/ARR stat grid, plan breakdown, recent users table, API health, **US↔EU Arbitrage Finder** (filters: direction, min source price, ratio threshold 1.10–2.00, variant auto/normal/holofoil/reverseHolofoil, sort, liquidity any/active/strong, limit, CSV download, refresh-prices).
- **Embed Settings** (`#embedSettingsGroup`, shop plan only) — slug/name/email/logo/accent/cash%/credit%/newsletter provider+show/per-provider creds/active/preview link/copy snippet.
- **Pair Phone (QR)** — settings group; `Host (show QR)` opens `EventSource('/api/room/<id>/stream')`, generates a `?pair=ROOMID` URL, renders QR via api.qrserver.com (Google Charts fallback).
- **Result sheet** — slides over scan view. Cardmarket link, condition cycle, candidate chooser (alt matches from verifyPokemon), correct-card-name action, "I bought this / Passed" actions, eBay sales link.
- **Search modal** — `/api/search` autocomplete to manually correct mis-IDs.
- **Live OCR banner** + `tryOcrIdentify` — present in code but **hard-disabled** (line 4204 `return null`); `/api/read-set-code` is unused from the client today.
- **Bulk pipeline** (`startBulkProcess`/`bulkWorker`/`processBulkItem` 4472–4575) — concurrency 4, persists queue to localStorage minus dataUrls. Calls `tryOcrIdentify` (returns null) → falls through to `fetchIdentifyStream` → `/api/price`.
- **Plan picker / quota modal / Stripe checkout / portal** — wired to the four endpoints under "STRIPE" above.
- **PWA install nudge** — appears on visit ≥2 unless dismissed.

External CDN deps loaded from the page:
- `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2` (sync)
- `https://cdn.sheetjs.com/.../xlsx.full.min.js` (XLSX export)
- `https://cdn.jsdelivr.net/npm/qrcode@1.5.3` + unpkg fallback
- `https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5` (lazy via `requestIdleCallback`)
- `https://api.qrserver.com` + Google Charts QR fallback
- `https://fonts.googleapis.com` (Fraunces, IBM Plex Sans, IBM Plex Mono)

### 1c. `public/quote.html` (740 lines — customer-facing, standalone)

Single page. Reads `?embed=1` (hides brand header) and `?shop=<slug>` (fetches `/api/shop-config/:slug`, recolours UI, swaps brand name/logo/cash%/credit%, hides newsletter checkbox if shop opted out). Workflow:

1. Pick game → paste lines like `MEG 133`, up to 20 — local `parseLines` splits to `{set_code, card_number, name?}`.
2. Sequential `fetch('/api/identify-manual')` per row → if hit, `fetch('/api/price')` → builds `{market, cash, credit}` per line.
3. Result panel renders a totals strip + per-card list; results stay locked behind a "blur + email gate" overlay.
4. Email-gate `fetch('/api/quote-lead', { ... cards, totals, cashPct, creditPct, shop_slug })` — server emails customer + shop, optionally subscribes to newsletter, persists to `quote_leads`.
5. In `embed=1`, posts `cp:submitted`/`cp:close` events to `window.parent` for the widget loader.

Hardcoded Cardmarket set-slug + ptcgoCode tables live in this file (`CM_SET_SLUGS`, `CM_PTCGO_CODES`, ~50 SV/SwSh/Mega entries) for direct product URL building (`buildCardmarketUrl`).

### 1d. `public/widget.js` (195 lines — embeddable IIFE)

Drop-in script: `<script src="…/widget.js" data-shop="<slug>" data-color="#…" data-position="floating|inline" data-label="…" defer>`. Injects a button (inline next to the script tag, or `position:fixed` bottom-right at `z-index:2147483646`); click opens a modal containing an `<iframe src="<origin>/quote?embed=1&shop=<slug>">`. `all: revert` + inline styles defend against host CSS bleed. Strict origin check on `message` events from the iframe; surfaces `cp:close`/`cp:submitted` events to host code via `window.cardPricerWidgetOnSubmit(d)` if defined. **No global pollution beyond the optional `cardPricerWidgetOnSubmit` callback — back-compat is non-negotiable per §2.3.**

### 1e. `public/service-worker.js` (80 lines)

`CACHE_VERSION = 'cardpricer-v60'`. **Network-first** for shell (`/`, `/index.html`, `/manifest.json`), **stale-while-revalidate** for other same-origin static assets, **never intercepts** `/api/*`, cross-origin, or non-GET. `skipWaiting` + `clients.claim` so a fresh SW takes over immediately. **Bumping the shell requires bumping `CACHE_VERSION` or stale HTML hangs around.**

### 1f. `public/manifest.json`

Single inline-SVG icon, `theme_color` and `background_color` `#1c1917`, `display: standalone`, `start_url: /`.

### 1g. `supabase/migrations/`

- `20260426_shops.sql` — `shops` (slug, name, email, branding, cash/credit pct, brevo_list_id, owner unique) + `quote_leads` (shop_id nullable, shop_slug denormalised so leads survive shop deletion, `cards_json` jsonb, ip_hash). RLS policies for owner read; service-role writes only.
- `20260427_shops_newsletter.sql` — adds `newsletter_provider` ('brevo'|'mailchimp'|'convertkit'|'off'), `newsletter_show`, plus mailchimp/convertkit credentials.

There is **no migration in the repo for `profiles`, `scan_events`, or `user_state`**, despite all three being read/written from the server. They were created via the Supabase SQL editor offline. **Sub-agent A3 (persistence) MUST recreate or pull those schemas before any V2 work — losing `profiles.is_admin` or `profiles.plan` is a sev-1.**

---

## 2. Data flow — pricing pipeline

```
client image (≤2000px @ 0.95)
    │
    ▼
POST /api/identify-stream  ──► identifyCore (sharp resize 1800px @ q92, sha1 cache)
    │                             │
    │                             ▼
    │                          Anthropic Sonnet 4.6 (CARD_ID_SYSTEM_PROMPT, ephemeral cache)
    │                             │
    │                             ▼
    │                          fixPokemonSuffix (HP-based ex/GX/V/VMAX correction)
    │                             │
    │  ◄─── emit {type:'ident'} ──┘
    │
    ▼
verifyIdentified (parallel per-card):
    ├─ verifyPokemon   → local-DB short-circuit → race-scored pokemontcg.io queries (RACE_THRESHOLD 220 + 150ms grace, accept if ≥120) → alt-suffix retry → base-name+HP retry → applyAdditionalsLabel for # > total
    ├─ verifyMagic     → Scryfall direct, Scryfall fuzzy fallback
    ├─ verifySWU       → swu-db.com search + per-set fallback
    ├─ verifyYuGiOh    → ygoprodeck exact + fname fallback
    └─ verifyGeneric   → Lorcana attempt; others return null (AI ID kept as-is)
    │
    ▼
maybeDoubleCheck (Pokemon only, score < 200): Sonnet 4.6 compares user scan vs reference image, may set verify_rejected:'double_check_mismatch'
    │
    ▼
HP-mismatch guard (verifyCard 3146): if AI HP ≠ DB HP by >20 and re-search can't resolve → reject with verify_rejected:'hp_mismatch' (returns AI's identification verbatim)
    │
    ▼
stripInternals — strips _refImagePromise (in-flight axios Buffer) and other _-prefixed keys before emitting
    │
    ▼
emit {type:'verified'} → {type:'done'}
```

**Pricing fan-out** (`POST /api/price` 4708): runs in parallel — `fetchCardmarketPrice` (HTML scrape via axios, mostly Cloudflare-blocked → null; if it works, regex-extracts trend/from/avg30/offers), `priceMagicCard`/`pricePokemonCard` (Scryfall / pokemontcg.io — pokemontcg.io conveniently embeds `cardmarket.prices` + `tcgplayer.prices`), `fetchJustTCGPrice` (TCGPlayer USD via JustTCG API), `fetchRapidAPICardmarketPrice` (TCGGO/RapidAPI — Cardmarket EUR + TCGPlayer USD + graded comps + DE/FR/ES/IT regional lows), `priceEbaySold` (eBay Browse API on `EBAY_IE` marketplace, parallel queries narrowed by name+set+number, sample-size capped at 15 per query).

**Source priority** (later overrides earlier): cardmarket-live (rare) → pokemontcg.io's embedded cardmarket → JustTCG → TCGGO/RapidAPI → graded comp (PSA/BGS/CGC) wins outright if `card.graded` set.

**Buy-price math:** `bestPrice × condition_multiplier × buyPercentage` where multipliers are NM 1.0 / LP 0.85 / MP 0.7 / HP 0.5 / DMG 0.3. Graded skips the condition multiplier (the grade IS the condition).

**USD→EUR rate** (line 830): seeded at `0.92`, refreshed daily from `frankfurter.app`. Bounded sanity check `0.5 < rate < 2.0` so a corrupt API response can't break pricing.

**Hotness score** (4982–5028): combines TCGGO 7d-vs-30d trend + JustTCG 30d change + eBay sold sample size + value bonus → 0–100 + label `hot|warm|steady|slow`, surfaced on the result sheet.

**Two in-memory caches** with no persistence across restarts:
- `identCache` (Map, LRU, 100 entries) — keyed on sha1 of the resized image; **skipped when `verify_rejected` is set** so a re-scan can recover.
- `priceCache` (Map, LRU, 500 entries, **60-min TTL**) — keyed on `game|name|set|num|cond|variant|graded|buy%`.

**External APIs the pipeline talks to** (in order of dependency):
- Anthropic (`claude-sonnet-4-6`) — identify + read-set-code + double-check.
- pokemontcg.io — verify + manual lookup + price + arbitrage source data. Throttled to 25 req/min unauthenticated; `POKEMON_TCG_API_KEY` lifts to 20k/day.
- Scryfall — Magic verify + pricing.
- swu-db.com — Star Wars verify.
- ygoprodeck.com — Yu-Gi-Oh! verify.
- lorcana-api.com — Lorcana verify (best-effort).
- tcgdex.net — Pokemon fallback.
- justtcg.com — TCGPlayer USD prices, all games. 100 req/day free.
- pokemon-tcg-api.p.rapidapi.com (TCGGO) — Cardmarket EUR + TCGPlayer USD + graded comps.
- eBay Browse API (Ireland marketplace).
- frankfurter.app — daily USD→EUR.
- Brevo (api.brevo.com) — transactional emails + Brevo contact upsert.
- Mailchimp + ConvertKit — per-shop newsletter providers.
- api.qrserver.com (+ chart.googleapis.com fallback) — QR code rendering for phone-pair.

---

## 3. Persistence reality

**Server-side**:
- **JSON files in `data/`** (created on first write, NOT in repo, NOT in `.gitignore` either):
  - `data/card-db.json` — `Map<{setId}-{cleanNum}, {name,setName,setCode,rarity,hp,supertype,subtypes,image,cardmarketUrl,tcgplayerUrl,source}>`. Loaded on boot via `initCardDb()`: Google Sheet CSV (if `CARD_DB_SHEET_URL`) → local file → pokemontcg.io download (~5 min on free dyno). Auto-saved every 5 min if `cardDbDirty`. **On Render free-tier without persistent disk this resets on every redeploy/sleep — boot does a full re-pull each time.**
  - `data/card-prices.json` — sibling snapshot of `cardmarket.prices` + `tcgplayer.prices` per card; only used by the admin arbitrage tool.
- **Append-only logs in `logs/`** (created on first write):
  - `logs/bad-ids.log` — JSONL, written by `/api/report-bad-id`.
- **In-memory state with no persistence** (lost on every restart):
  - `identCache`, `priceCache`, `shopConfigCache`, `rooms` (SSE + history per pair-room), `USD_TO_EUR`, `cardDbLoading`, `unreliableImportDone`.
- **Hardcoded `POKELLECTOR_CORRECTIONS`** for `me1`/`mep` (~ME1 188 cards + MEP 47 cards, pages 1564–1628) — applied AFTER any other DB load so they always win.
- **Supabase tables** (only `shops` + `quote_leads` migrations are in repo; the rest were created out-of-band via the SQL editor):
  - `auth.users` (Supabase-managed) — email + password.
  - `profiles` — `(user_id, plan, plan_interval, stripe_customer_id, stripe_subscription_id, is_admin, created_at)`.
  - `scan_events` — `(user_id, endpoint, ts)`. Counted with `count: 'exact', head: true` filtered by month for quota.
  - `user_state` — `(user_id, state JSONB, updated_at)` — single blob containing `{sessions, currentSessionId, wantlist, v}`. Last-writer-wins; debounced PUT every 1.5s from the client.
  - `shops` — multi-tenant embed config.
  - `quote_leads` — append-only; `cards_json` is a jsonb array, `ip_hash` is daily-salted SHA-256.

**Client-side localStorage keys** (single source of truth: see `getSetting` 5640 + scattered direct calls):
- `cardpricer_sessions` — multi-named-session store; mirrors `user_state.state.sessions` after sync.
- `cardpricer_log` — legacy single-log array; auto-migrated on first load by `initializeSessions()` then never written again.
- `cardpricer_buypct`, `cardpricer_cashpct`, `cardpricer_creditpct` — slider values.
- `cardpricer_wantlist` — JSON array of `{name, set?, max?}`.
- `cardpricer_pricecache` — client-side mirror of recent `/api/price` results (kept tiny).
- `cardpricer_setting_<key>` — per-setting toggles (`currency`, `sellMarkup`, `junkThreshold`, `rapidFire`, `haptic`, `highContrast`, `ocrFirst`, `amoled`, `blurReject`, …).
- `cardpricer_bulk_queue_v1` — bulk-mode queue minus full dataUrls (so it can't blow the 5MB quota).
- `cp_visits`, `cp_install_dismissed` — PWA install-nudge state.

---

## 4. Auth state

- **Vendor app, customer quote, admin** are all the same Express app. Auth is **Supabase JWT in the `Authorization: Bearer …` header**, attached client-side by the wrapped `window.fetch` (index.html 62–104). The wrapper also auto-shows the auth modal on 401, the quota modal on 429, and live-updates the usage banner from the `X-Scan-*` headers `enforceQuota` writes.
- Supabase URL + anon key are **hardcoded at index.html:50–53**. The anon key is safe to ship publicly (RLS protects data) but **rotating the Supabase project means editing `index.html`**.
- **Server verifies tokens** via the service-role client (`supabase.auth.getUser(token)` line 88). The service-role key bypasses RLS and **must never reach the browser**.
- **Plan-based auth**: `enforceQuota` (150) caps free users at 40 scans/month, solo 100, vendor 500, shop unlimited, beta unlimited. Fails-open on Supabase errors so a Supabase blip can't take down the scanner at a show.
- **Admin check**: `requireAdmin` reads `profiles.is_admin` (boolean). No roles, no granularity.
- **Plan gate for embed**: `requirePlan(SHOP_PLANS = ['shop','beta'])` on POST/PATCH `/api/shop`.
- **Scanner mode** (`?pair=ROOMID` URL param) **bypasses auth entirely**: `_initAuthGate` returns early (305), the page hides chrome and uses only `/api/room/:id/scan`. Anyone with the room ID can push scans. The room ID is 6 base-36 chars (~10⁹ space) — secret-by-obscurity, not authenticated.
- **Stripe webhook** is signature-verified via `STRIPE_WEBHOOK_SECRET`, no JWT. Raw body is captured by an `express.json` `verify` callback at line 30 — replacing that middleware naively breaks signature verification.
- **Public endpoints** (no auth): `/api/health`, `/api/card-db-status`, `/api/card-db-export`, `/api/card-db-rebuild`, `/api/card-db-import-unreliable`, `/api/report-bad-id`, `/api/correct-card`, `/api/search`, `/api/room/*`, `/api/shop-config/:slug`, `/api/quote-lead` (rate-limited), `/quote`. **Several of these are write endpoints — `/api/correct-card` lets anyone edit `data/card-db.json`. Flag in V2.**

**Secrets / env vars referenced anywhere in `server.js`**:

| Key | Used for | Required? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Identify, read-set-code, double-check | yes |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Auth verify + plan/state/admin DB | yes (else `/api/*` returns 503) |
| `SUPABASE_ANON_KEY` | (only in index.html) | yes |
| `EBAY_APP_ID` / `EBAY_CERT_ID` | eBay sold listings | optional |
| `JUSTTCG_API_KEY` | TCGPlayer USD prices, fallback identify | optional |
| `RAPIDAPI_KEY` | TCGGO Cardmarket EUR + graded comps + unreliable-set imports | optional |
| `POKEMON_TCG_API_KEY` | Lifts pokemontcg.io rate limit 30/min → 20k/day | optional |
| `STRIPE_SECRET_KEY` | Checkout + portal | optional (else 503) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verify | optional |
| `STRIPE_PRICE_{SOLO,VENDOR,SHOP}_{MONTHLY,YEARLY}` | 6 price IDs → plan mapping | optional, must match Stripe live prices |
| `BREVO_API_KEY` | Customer + shop emails, Brevo newsletter subscribe | optional |
| `BREVO_SENDER_EMAIL` | "From" address | optional |
| `BREVO_NEWSLETTER_LIST_ID` | Single-tenant Brevo list | optional |
| `IP_HASH_SALT` | Daily-rotating salt for `quote_leads.ip_hash` | optional, has default |
| `CARD_DB_SHEET_URL` | Editable Google Sheet source for card DB | optional |
| `DEFAULT_BUY_PERCENTAGE` | Default buy% if client doesn't send one | optional, default 60 |
| `SHOP_NAME` / `SHOP_EMAIL` | Single-tenant fallback for emails | optional |
| `PORT` | Listen port | optional, default 3000 |

`render.yaml` declares only **6** of these (`NODE_VERSION`, `ANTHROPIC_API_KEY`, `EBAY_APP_ID`, `EBAY_CERT_ID`, `JUSTTCG_API_KEY`, `RAPIDAPI_KEY`, `DEFAULT_BUY_PERCENTAGE`). **The other 13+ env vars are Render-dashboard-only and absent from `.env.example` too.** This is a discoverability cliff — V2 must add them all to `.env.example` and `render.yaml`.

---

## 5. Hidden / load-bearing behaviours

Things a sub-agent will plausibly destroy by accident if they don't read this list. Numbered for Risk-Register cross-reference.

1. **Wrapped `window.fetch` (index.html 62–104)** is the single source of: JWT injection, auth-overlay-on-401, quota-modal-on-429, usage-banner-from-X-Scan-headers. **Any new HTTP client (axios, fetch in a different module, a fresh SvelteKit fetcher) bypasses ALL of this.** Either preserve the wrapper or recreate every behaviour at the new layer.

2. **OCR-first path is hard-disabled but not deleted** (index.html 4204 `return null` inside `tryOcrIdentify`). The Settings toggle (`ocrFirstToggle`) and `/api/read-set-code` endpoint still exist. Per `memory/ocr_first_path.md`: re-enabling without a name/HP cross-check re-introduces silent wrong-card returns. V2 either deletes the toggle/endpoint or adds a validation step before trusting it.

3. **`maybeDoubleCheck` gate (1188)** uses Sonnet 4.6 to compare user scan vs reference image. Skipped if `card.confidence_score >= 200` (saves tokens). Pokemon-only. **Removing this re-introduces the alt-art / wrong-printing bug class.**

4. **`POKELLECTOR_CORRECTIONS` always wins** (1662–1680). `applyPokellectorCorrections()` runs at the end of `initCardDb()` and `addCardToDb` will not overwrite a `source: 'pokellector'` entry except by another pokellector entry. Persisting a "v2 schema" without preserving the `source` field collapses this priority ordering.

5. **`POKEMONTCG_UNRELIABLE` set (1521)** = `{mep, me1, me2pt5, wht, bbt}`. `processPageData` (1924) **skips inserting these from pokemontcg.io entirely**, and `lookupLocalDb` (1703) refuses to return entries for these sets unless `source ∈ {pokellector, tcggo, fallback, manual}`. Drop the list and the 188-card ME1 + 47-card MEP corrections silently lose to incoming bad pokemontcg.io rows.

6. **`verifyPokemon` race + threshold tuning** (3665, 3738): `RACE_THRESHOLD = 220` + `GRACE_MS = 150` means we exit verify on the first ≥220 hit + 150ms grace, instead of waiting all parallel queries. `globalBestScore >= 120` is the minimum to accept a verify match (raised from 40 to fix wrong corrections). Both numbers are load-bearing — lowering 120 re-introduces the "modern Bulbasaur swapped for 2002 Expedition #94 because only the name matched" bug.

7. **`arbitrageVariants` emits one row per variant** (409). The admin arbitrage tool relies on each `(holofoil, reverseHolofoil, normal, 1stEditionNormal, …)` printing surfacing as its own row with its own ratio. Collapsing to "best variant" hides reverse-holo deals.

8. **Service-worker cache version `cardpricer-v60`** (`public/service-worker.js` line 12). New shells require a bumped version or the install handler keeps the old one and users see stale HTML.

9. **Image pipeline sizes are tuned** (per `memory/image_pipeline.md`): client 2000/2400px @ q0.95, server 1800/2200px @ q92. `resizeDataUrl` (3931) had a past bug that silently downscaled to ~700px. Re-checking these constants whenever the pipeline is touched is mandatory.

10. **`stripInternals` removes underscore-prefixed keys** (1271). `_refImagePromise` is an in-flight axios `Promise<axios.Response<ArrayBuffer>>` carried through verify so `maybeDoubleCheck` can avoid a second fetch. Skipping the strip leaks a Buffer reference into `JSON.stringify`.

11. **`app.set('trust proxy', 1)`** (line 24) is required for `express-rate-limit` to bucket per real client IP behind Render's edge proxy. Drop it and per-IP limits collapse into one bucket.

12. **Stripe webhook needs raw body** — captured in `express.json`'s `verify` callback (line 30), kept on `req.rawBody` only for `/api/stripe-webhook`. Replacing `express.json` without this hook breaks signature verification.

13. **`/api/quote-lead` persists to `quote_leads` regardless of email send success** (5380–5403). A Brevo outage can't kill lead capture — the row lands first, the Brevo calls happen second. V2 must keep this ordering.

14. **Scanner mode bypasses auth** via `?pair=ROOMID` (index.html 305 + `body.classList.add('scanner-mode')`). Any new auth gate on `/` must respect this URL param.

15. **`state.sessions` is a multi-named-session map**, not a flat log. Migration from the old `cardpricer_log` flat array runs once in `initializeSessions()` and is then dormant. Persistence layer (A3) cannot assume "session log is one array".

16. **`user_state` is a single JSONB blob, last-writer-wins.** No conflict resolution. Two tabs open for the same user race each other. Acceptable today because shop users are typically one-device. V2 should consider this carefully if multi-device is on the roadmap.

17. **CARD_DB key normalisation strips leading zeros** (`String(num).replace(/^0+/, '')`, 1698 + 1965). But for OCR/scan purposes, **leading zeros are critical** — Sonnet 4.6's set-code prompt explicitly teaches preservation (2727–2729). The two requirements coexist because the strip happens at lookup, not at OCR.

18. **Additionals labelling** (3511 `applyAdditionalsLabel`) prepends `x` to set codes (`xDRI 229`) and appends `: Additionals` to set names when the printed number is above the set total — Cardmarket sells secret rares as a separate sub-product on a separate URL.

19. **Rate limits**: `identifyLimiter` (60/min global) + `quoteLeadLimiter` (10/hour global). Both per-IP via `express-rate-limit` + `trust proxy`. **Global, not per-user.** A single shop with multiple operators on the same wifi can hit the global cap.

20. **The shop-config in-memory cache + Cache-Control** (`/api/shop-config/:slug`) — 5-min TTL in memory PLUS `Cache-Control: public, max-age=60`. Shop slug rename invalidates BOTH the old AND new slug entries (5697–5698) — a sub-agent reimplementing this layer must invalidate both keys on update.

21. **Supabase `shops.unique(owner_user_id)`** — DB-enforced one-shop-per-user. POST returns `409` and `'you already have a shop — use PATCH /api/shop to update'` on the unique-violation `23505`.

22. **Hard-coded Anthropic model** (`claude-sonnet-4-6`) at three call sites (1140, 1219, 2716). Bumping the model means three edits, not one — sub-agent A2 should pull this into a constant.

23. **Cardmarket scraping is mostly Cloudflare-blocked.** `fetchCardmarketPrice` (4028) returns null on 403 — production prices come from RapidAPI/TCGGO and pokemontcg.io's embedded cardmarket data. The `cardmarket_live` source path is best-effort.

24. **`/api/correct-card` is unauthenticated** (2865). It overwrites any local-DB entry with `source: 'manual'` and persists. Anyone can rename any card. **This is a sev-2 bug today; document, then fix in V2 by gating with `requireAuth`.**

25. **Frankfurter FX timeout failure keeps the last good rate** (831–846). USD→EUR is bounded `0.5–2.0` so a corrupted response can't break pricing.

---

## 6. Risk register

Top 10 things that can break in V2 and the V2-side mitigation. Numbers reference the §5 hidden-behaviour list.

| # | Risk | Likelihood | Severity | V2 mitigation |
|---|---|---|---|---|
| R1 | Sub-agent rebuilds an HTTP client that bypasses §5.1's wrapped `fetch` — silent JWT/quota/auth-modal regression | High | High (whole app stops auth-gating) | A1 publishes an `apiClient` contract that wraps Supabase JWT injection + 401/429 hooks. Every UI sub-agent (A4/A5/A6) imports it; lint forbids raw `fetch('/api/…')`. Regression test: fire a 401 from the API and assert the modal shows. |
| R2 | A3 migrates `user_state` to per-row tables and accidentally drops the multi-named-session structure (§5.15) | Medium | High (loss of customer session history) | A3's contract makes "JSONB blob → relational schema" a Phase-3 OPTION, not default; migration script must dump the JSONB to disk before truncating. A3 can't ship without an explicit rollback. |
| R3 | Card DB persistence loses the `source` priority field (§5.4) | Medium | High (Pokellector corrections silently disappear) | A2's pricing-engine contract defines a single `Card` type with a `source: 'pokellector'\|'manual'\|'tcggo'\|'sheet'\|'pokemontcg'\|'fallback'` discriminator; any persistence layer that drops it fails A7's regression test for ME1 #155 ("Mega Venusaur ex"). |
| R4 | A4 vendor-UI rewrite breaks scanner-mode `?pair=` bypass (§5.14) | Medium | High (phone-pairing dies at a card show — direct revenue impact) | A4 inherits a "scanner-mode" smoke test in A7; any DOM that hides chrome or routes through auth must check `URLSearchParams.has('pair')` first. |
| R5 | Embed widget v2 breaks back-compat for shops already loading v1 `widget.js` (§2.3 non-negotiable) | Medium | Critical (live customer integrations) | A6 inherits the v1 widget surface as a contract. New widget = new path (`widget-v2.js`); v1 file untouched. Add a load-time deprecation warning in v1 only. |
| R6 | Stripe webhook stops working because raw-body capture is lost in middleware reshuffle (§5.12) | Medium | Critical (failed payments processed as upgrades, or successful payments not registered) | A1's Express scaffold pre-registers `express.json` with the same `verify` shape; A7 publishes a webhook signature regression test (mock event, send through, assert plan flips). |
| R7 | Service-worker cache version not bumped on shell change (§5.8) → users stuck on old HTML | High | Medium (support tickets, looks broken) | A4's owned files include `service-worker.js`'s version constant. CI step `grep CACHE_VERSION public/service-worker.js | diff main` blocks merge if the version didn't change while index.html did. |
| R8 | Render free-tier sleep wipes `data/card-db.json` + in-memory rooms (§3 + §5) | Already happening | Medium (boot is slow + phone-pair sessions die) | A8 owns the call: keep free tier and document; migrate to Render persistent disk; or move card DB to Supabase Storage / R2 / S3. Default proposal: persistent disk. |
| R9 | Sub-agents introduce a new `claude-sonnet-X-Y` model name at one call site but not the other two (§5.22) | High (model bumps every quarter) | Medium (silent quality regression on the missed call site) | A2 hoists the model into a single `IDENT_MODEL` constant in one config module. |
| R10 | `verifyPokemon` race threshold/grace timings get "cleaned up" (§5.6) | Medium | High (verify either wrong-corrects or times out at 10s) | A2's pricing-engine contract preserves `RACE_THRESHOLD`/`GRACE_MS`/`MIN_ACCEPT_SCORE` as named constants with comments. A7 ships fixture-based tests for the "Bulbasaur Expedition #94" miscorrection regression. |

Honourable mentions that don't make the top 10 but should be tracked:

- The hardcoded Cardmarket set-slug tables in **two places** (`server.js` could synthesise these from `pokemontcg.io` set data; `quote.html` has its own copy). V2 should consolidate.
- `/api/correct-card` is unauthenticated (§5.24).
- `/api/card-db-rebuild` and `/api/card-db-import-unreliable` are unauthenticated.
- v1 logs lead-card photos as base64-in-JSONB (`quote_leads.cards_json`). Big rows. Probably wants object storage.
- 13+ env vars are not in `.env.example` or `render.yaml` (§4 last paragraph).
- `state.sessions` JSON state can grow unbounded; the 10MB `express.json` cap on `/api/state` is the only backstop.

---

**Phase 1 complete — review needed.**

Awaiting explicit approval before starting Phase 2 (`docs/V2_ARCHITECTURE.md`).
