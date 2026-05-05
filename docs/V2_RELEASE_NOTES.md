# Card-Pricer V2 — Release Notes

**Status:** Phase-5 deliverable. Code is on the `v2` branch, frozen at commit `d2e41c8`. **NOT yet merged into `main`. NOT yet deployed.** Per `CARD_PRICER_V2_PROMPT.md` §8 the orchestrator hands back here; the operator decides when to cut over.

**Test suite:** 270/270 passing in ~3.3s.
**Sub-agents that shipped slices:** 10 (A1 backend, A2 pricing, A3 persistence, A4 vendor UI, A5 quote UI, A6 widget, A7 testing, A8 DevOps, A9 inventory, A10 customer accounts).
**Slices committed:** 26 planned + 5 orchestrator follow-ups = **31 commits on `v2`**.
**Net diff vs `main`:** ~+25k lines added, ~+3k removed. Most of that is the 5,720-line `server.js` extraction into modular routers + 7,200-line `index.html` extraction into per-tab modules + V2's new feature surfaces (sealed pricing, inventory, customer accounts, observability stack, OCR-first re-enable, sessions cutover dual-write).

---

## What's new

### New customer-facing features

- **Quote persistence with stable URL.** Every successful `/api/quote-lead` submission now returns a permanent URL (`/q/<uuid>`). Customer can bookmark, share, revisit. Server returns a sanitised view at `GET /api/v2/quote/:id` (no email, no name, no IP hash). [S12]
- **Customer dashboard at `/customer`.** Sign in via Supabase magic link, see quote history grouped by status, accept or decline tokenised offers from shops, edit account preferences. [S20 + S21]
- **Tokenised offer accept/decline.** Shops can now create offers tied to a quote (`POST /api/v2/quote-offer`). Customer hits `/o/<token>` (no auth required — the token IS the auth) and accepts in one click. Tokens expire after 7 days by default. [S20]
- **OCR-first scan path** (gated behind `OCR_FIRST_ENABLED=false`). Reads set code + card number via Sonnet 4.6 OCR, looks up the canonical card via `/api/identify-manual`, then validates with an image-compare gate (Sonnet sees both user scan + canonical reference; rejects if they don't match). Falls through to full `/api/identify-stream` on any rejection. Telemetry on every attempt + 2% false-positive auto-warn threshold. [S15]
- **Anonymous customer flow now works.** V1 had a real bug: `/quote.html` called auth-gated endpoints anonymously and got 401s on every line lookup. V2 carves out public `/api/v2/quote/identify-manual` + `/api/v2/quote/price` paths gated by the existing `quoteLeadLimiter` (10/hr per IP). [S8.5]

### New vendor-facing features

- **Inventory subsystem.** `/api/v2/inventory/*` lets shop-plan vendors track buy → list → sold → P&L per item across Cardmarket / TCGPlayer / eBay / in-store. V2 ships full CRUD + state machine + audit-log events; Cardmarket / TCGPlayer / eBay outbound integrations are skeletons (not_yet_implemented) — in-store works end-to-end. [S18]
- **Sealed product pricing.** `/api/v2/price-sealed` — boosters, ETBs, booster boxes, bundles via Cardmarket sealed adapter (V2.0.1 swap; previously TCGPlayer Pro). Best-effort scrape with operator-supplied `manual_market_eur` override for Cloudflare-blocked attempts. **No API key or paid subscription required.** [S17 + V2.0.1]
- **Vendor analytics dashboard.** `/api/admin/analytics` returns quotes/day sparkline, conversion %, top cards quoted, average basket. Surfaced as a new section in the admin tab. [S13]
- **Widget V2.** Theming (`data-theme=light|dark|auto`), button shapes (`square|pill|round`), modal sizes (`default|compact|full`), opt-in `data-event-callback` named-function fallback, telemetry beacon to `/api/widget/loaded`, lazy-load opt-in. **V1-attribute parity is the non-negotiable contract** — a script tag with zero V2-only attributes produces a button + modal indistinguishable from V1 (verified by jsdom DOM-diff tests). [S9 + S23]

### New infrastructure

- **Render Starter plan + persistent disk** (Q2). 1 GB disk at `/opt/render/project/data` — `data/card-db.json` survives redeploys. Always-on (no cold starts).
- **Pino structured logger + Sentry server SDK + prom-client metrics.** New endpoints: `GET /api/version`, `GET /api/metrics`, `POST /api/widget/loaded`. Sentry `beforeSend` scrubs auth headers, base64 image data, customer emails (replaced with SHA-256 hash). [S14]
- **Postgres-backed phone-pair sessions.** `/api/room/*` dual-writes to in-memory rooms Map (V1 path) + `live_sessions` / `live_session_scans` Postgres tables. SSE re-subscribers see catch-up scans replayed from Postgres on connect. Survives Render redeploys. [S11]
- **Postgres-backed card prices.** `card_prices` table is now primary for the admin arbitrage tool. `data/card-prices.json` kept as one-release backup. Boot warms the in-memory `CARD_PRICES` Map from Postgres; falls back to file → pokemontcg.io re-pull if both empty. [S10]
- **Sessions dual-write.** `/api/state` PUT writes to BOTH the V1 `user_state.state` JSONB blob AND the relational `sessions` / `session_cards` tables. Reads still use JSONB until `READ_FROM_RELATIONAL=true` flips (post-V2 stability operation, runbook in `infra/deploy/sessions-readflip-runbook.md`). [S16 + S24]

### V1 security fixes (already on `main` since commit `1309ccd`)

- `POST /api/card-db-rebuild` and `POST /api/card-db-import-unreliable` now require auth + admin (was anonymous; an attacker could DoS the pricing pipeline by wiping `CARD_DB`).
- `POST /api/correct-card` now requires auth (was anonymous; attackers could globally rename any card). User_id is logged for audit.

### Refactors (no behaviour change)

- **`server.js` (5,720 lines) → `apps/server/`** with one router per concern (identify, price, card-db, account, billing, admin, shop, quote-lead, quote-recover, quote-offer, customer, inventory, room, search, health, static, price-sealed). [S5 + orch follow-ups]
- **`public/index.html` (7,200 lines) → `apps/vendor/`** as a shell (≤500 lines) + per-tab modules + a single `apiClient.js` module that owns ALL `/api/*` calls (kills audit risk R1 — wrapped-fetch behaviour collapsed into one place with explicit hooks). [S7]
- **`public/quote.html` (740 lines) → `apps/quote/`** with per-concern modules (parse-lines, lookup, totals, shop-config, lead-gate, cardmarket-url). [S8]
- **`apps/customer/`** — new app (`/customer` route) with magic-link sign-in, dashboard, account, offer-accept. [S21]
- **Pricing engine extracted to `pricing/`** — adapters per source (pokemontcg, scryfall, swu-db, ygoprodeck, lorcana, tcgdex, justtcg, tcggo-rapidapi, ebay-sold, cardmarket-html, cardmarket-sealed), pure verify + price + identify-core, named tunable constants in `pricing/confidence.js`, sealed pipeline in `pricing/sealed/`, OCR-first pipeline in `pricing/ocr-first/`. [S6 + S15 + S17 + V2.0.1]
- **Persistence layer extracted to `db/`** — schema doc, sessions dual-write/reader/cutover-flag, customer accounts/offers, inventory items/events/listings, live-sessions store + SSE bridge, card-prices Postgres store. [S1 + S10 + S11 + S16 + S18 + S20]
- **Mobile-first restyle** of all four surfaces with breakpoints at 640px, 540px, 390px floor; touch-target audit (44×44 minimum). [S22]

### Documentation

- `docs/V2_AUDIT.md` — full V1 surface map, hidden behaviours, risk register (Phase 1).
- `docs/V2_ARCHITECTURE.md` — module layout, contracts, concurrency plan, test plan, operator decisions Q1-Q6 (Phase 2).
- `docs/V2_SMOKE_TEST.md` — Phase 4 regression results + RG-NN coverage matrix + ship verdict.
- `docs/V2_MIGRATION.md` — companion to these release notes (Phase 5).
- `docs/api-contract.md` — V1 + V2 endpoint contracts.
- `db/schema.md` — per-table V2 mapping doc.
- `pricing/adapter.interface.md` — canonical `PricingAdapter` interface (10 adapters conform).
- `pricing/marketplaces/adapter.interface.md` — outbound listing adapter contract.
- `infra/deploy/release-runbook.md` — 30-min cutover checklist with gates and rollback paths.
- `infra/deploy/stripe-webhook-smoke.md` — post-deploy webhook verification procedure.
- `infra/deploy/sessions-readflip-runbook.md` — post-V2 read-flip operation (separate event from cutover).
- `infra/deploy/healthcheck.md` — endpoint shapes + UptimeRobot setup.
- `apps/widget/compat.md` — V1-attribute parity contract + V2-NEW additive attributes.
- `supabase/migrations/README.md` — migrations convention + verification queries.

---

## Breaking changes for end users

**None.** Every V1 endpoint keeps its path, request shape, and response shape. The widget v2 file produces V1-attribute-equivalent DOM. Vendor + quote pages render the same data with cleaner code underneath.

The one observable user-facing improvement: customers who hit `/quote` now actually get prices (V1 was silently broken for anonymous customers).

---

## Breaking changes for operators

The operator-facing surfaces *did* change. None are subtle; all are documented in `docs/V2_MIGRATION.md`. Highlights:

1. **Render plan upgraded from Free → Starter** ($7/mo). Required for persistent disk and always-on.
2. **27 → 32 environment variables** declared in `infra/render.yaml` (was 27 + 5 added in this round). 8 are REQUIRED; the rest are OPTIONAL with documented degraded-mode behaviour.
3. **NPM dependencies added:** `pino`, `prom-client`, `@sentry/node` (production); `pino-pretty`, `jsdom` (dev). Run `npm install` after `git pull`.
4. **Supabase Site URL allow-list** must include `https://card-pricer-60qq.onrender.com/customer` (and any custom domain) for magic-link sign-in to work.
5. **Sealed pricing — no subscription needed (V2.0.1).** `/api/v2/price-sealed` uses the Cardmarket sealed adapter, which builds canonical Cardmarket product URLs and best-effort scrapes them. Cloudflare blocks ~most of the time; when it does, the route returns the URL only with `blocked_by:'cloudflare'` and the operator supplies `manual_market_eur` from the live page. **No env vars required.** (V2.0.1 dropped the prior `TCGPLAYER_PRO_*` env vars.)
6. **Sentry browser SDK** loaded from CDN; the orchestrator hand-off to S22 noted that `apps/{vendor,quote,customer}/index.html` have a TODO `<script>` tag awaiting the operator-chosen Sentry version + SRI hash. Optional — Sentry no-ops cleanly without DSN env vars.
7. **`READ_FROM_RELATIONAL=false`** through V2 ship. Flip post-V2 per `infra/deploy/sessions-readflip-runbook.md` — separate operation from the cutover.
8. **`OCR_FIRST_ENABLED=false`** through V2 ship. Flip after telemetry confirms `OCR_FIRST_FP_THRESHOLD` (2%) is not exceeded across a meaningful sample.

---

## What's monitored in the first 48 hours after release

Per `infra/deploy/release-runbook.md` post-cutover monitoring (T+0 → T+2h is operator-watched, T+2h → T+48h is alert-driven):

**Sentry alerts (server + browser):**
- Any new error signature → triage immediately.
- Specific watch: `/api/identify-stream` errors (the highest-volume vendor path), `/api/quote-lead` 5xx (customer-flow blocker), Stripe webhook signature failures (R6).

**Render logs:**
- Any 5xx from `/api/v2/quote/identify-manual` (anonymous customers — S8.5 fix).
- Any 5xx from `/api/state` (sessions cutover — dual-write should fail-soft on relational errors per S16; assert no 500s leaking).
- Boot-time: `[CARD-DB] Loaded ... cards from Postgres` confirms S10 warm-up succeeded; `[FX] USD→EUR refreshed` confirms FX boot side-effect runs from `apps/server/server.js`.

**Synthetic checks (every 10 min for the first 2h, then UptimeRobot every 5 min indefinitely):**
- `GET /api/health` → expect `ok`.
- `GET /api/version` → expect new `git_sha`.
- Vendor: sign in + scan a fixture card (set up a test JWT in your password manager).
- Customer flow: open `/quote?shop=brewed` + run a 1-line lookup + submit gate (use a test inbox).
- Widget: open `https://boardandbrewed.ie` (or wherever the embed is live) + click button + verify the modal renders.

**Database:**
- `quote_leads` row count grows at expected rate (~baseline before cutover, no spike or drop).
- `scan_events` row count grows.
- No errors in `pg_stat_user_tables` for `sessions` / `session_cards` writes (dual-write window).
- Once `READ_FROM_RELATIONAL=true` flipped: monitor `/api/state` GET latency (relational read should be ~equal to JSONB read; >2× regression = roll back the flag).

**Specific risks to watch:**
- **R1 wrapped fetch** — if any client module ever does `fetch('/api/...')` directly, JWT injection breaks. Lint rule (TODO V2.1) but until then: smoke-test every tab.
- **R2 sessions cutover** — DUAL-WRITE WINDOW. `dualWriteState` writes both blob + relational; if relational fails the JSONB write still succeeds (fail-soft). Monitor for any rows in `sessions` / `session_cards` with mismatched user_id.
- **R5 widget v1 back-compat** — Board & Brewed's live embed is the canary. If the button renders differently, roll back via `git revert -m 1 <merge-SHA>`.
- **R6 Stripe webhook** — signature verification depends on `req.rawBody` capture. The post-deploy `stripe events resend` smoke (release-runbook §8) is the gate.
- **R8 Render free-tier sleep** — fixed by Q2 plan upgrade. If the Starter plan ever sleeps (it shouldn't), `live_sessions` Postgres backing means phone-pair recovers; in-memory state is just a hot cache now.

---

## Outstanding follow-ups (NOT blockers; tracked for V2.1)

Sourced from every slice's commit body. Grouped by urgency:

### Pre-cutover (must do before merging `v2 → main`)

- [ ] Set REQUIRED env vars on Render: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, all 6 `STRIPE_PRICE_*`, `BREVO_API_KEY`. Optional ones (`EBAY_*`, `JUSTTCG_API_KEY`, `RAPIDAPI_KEY`, `POKEMON_TCG_API_KEY`, etc.) — set if you have them; degraded modes documented in `infra/env.example`. (V2.0.1 dropped the prior `TCGPLAYER_PRO_*` set — no longer used.)
- [ ] Add prod URL to Supabase Site URL allow-list for magic-link callback.
- [ ] Pick a Sentry version + grab its SRI hash. Update the `<script integrity="...">` placeholders in `apps/vendor/index.html`, `apps/quote/index.html`, `apps/customer/index.html`. (Or skip Sentry browser entirely — the modules no-op without a DSN.)
- [ ] Run `infra/deploy/release-runbook.md §T-24h` checklist.

### Cutover-window (handled by the runbook)

- [ ] Tag `pre-v2-cutover` on `main` HEAD.
- [ ] Disable Render auto-deploy.
- [ ] Reduce `/widget.js` Cache-Control to 60s (single-file commit, deployed to V1 first).
- [ ] Merge `v2 → main`, push, manual deploy.
- [ ] Post-deploy: `/api/version` smoke, hot-path smoke, Stripe webhook resend smoke.
- [ ] Monitor 2h.

### Post-V2 (V2.1+ — not blockers)

- [ ] Drop `data/card-pricer-prices.json` after Postgres warm-up confirms twice (S10 follow-up).
- [ ] Drop `apps/server/_card-db-boot.js` (S10 absorbs into `db/card-db/persist.js`).
- [ ] Trigger sessions read-flip per `infra/deploy/sessions-readflip-runbook.md` after dual-write stable ≥2 weeks.
- [ ] Drop `user_state.state` column once read-flip stable (with rollback migration).
- [ ] Drop `apps/widget/widget-v1.js` after stable month (Q4 rollback artefact lifetime).
- [ ] DELETE route for `/api/v2/customer/me` (S21 hand-off — backend has the function, no route).
- [ ] Real Cardmarket / TCGPlayer / eBay marketplace integrations (S18 follow-ups).
- [ ] Image upload route for inventory listings (S18 follow-up).
- [ ] Per-shop P&L view for multi-shop vendors (S18 follow-up).
- [ ] CSV / Manabox bulk-import for historical inventory (S18 follow-up).
- [ ] Quote URL expiry — currently permanent; GDPR retention policy needed (S12 follow-up).
- [ ] Brevo-failure ordering — V2's `/api/quote-lead` skips `persistLead` if Brevo throws on the BREVO-configured branch (S26 found; fix by re-ordering to fire-persist-first).
- [ ] Fold `pricing/ocr-first/parse.js` into a shared module so the V1 client `extractCardNumber` duplicate at `public/index.html:4105` doesn't drift (S15 hand-off).
- [ ] `tests/regression/` deferred RG-NNs: RG-11, RG-12, RG-13, RG-16, RG-17, RG-20, RG-27, RG-30 (S26 has effort estimates).
- [ ] OCR-first kill-switch flip — once telemetry confirms FP rate <2% across a meaningful sample.
- [ ] `READ_FROM_RELATIONAL` flip — once dual-write stable.

---

## Hand-back to operator

Per `CARD_PRICER_V2_PROMPT.md` §8: "Stop. Do not merge `v2` into `main` and do not deploy."

The orchestrator's job ends here. Next steps are:
1. Read `docs/V2_MIGRATION.md` for the per-customer migration guide.
2. Read `infra/deploy/release-runbook.md` for the cutover steps.
3. Walk through the pre-cutover checklist above.
4. Schedule the cutover window.
5. Execute the runbook.

If anything in this report or the migration guide is unclear, or if any of the outstanding follow-ups need re-prioritisation before V2 ships, send a question and I'll dig into it.
