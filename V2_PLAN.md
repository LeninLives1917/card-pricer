# Card-Pricer v2.0 — Plan

A near-greenfield rebuild. Same product surface (vendor scanner + customer quote + embed widget + arbitrage finder + admin dashboard) plus three new pillars in v2.0 (inventory tracking, multi-operator real-time, customer accounts). Native iOS/Android phone scanner is **deferred** — revisited later. Same brand identity (the Fraunces + IBM Plex editorial-terminal palette landed in v1.66–v1.70, captured in `DESIGN_BRIEF.md`). Different bones: TypeScript end-to-end, **SvelteKit** on web, Drizzle + Postgres for typed data access, real test suite, real CI.

This document is opinionated. If something looks wrong, push back — most decisions have a 30-second-defendable reason but several are revisable.

---

## 1. Goals + non-goals

**Goals**
1. Make the vendor app feel like a tool an operator can trust at speed (32-card-per-minute pace).
2. Make the customer surfaces feel like a magazine — calm, branded per shop, fast.
3. Type the entire client/server contract so a tweak to one side surfaces a compile error on the other.
4. Add inventory: bought-cards become tracked items with P&L until sold.
5. Add customer accounts on `/quote` so quotes survive sessions and offers can be accepted.
6. Add multi-operator: two staff scan into the same session, see each other's scans live.

**Deferred (not v2.0)**
- Native iOS/Android phone scanner app. The paired-phone-as-camera flow continues to use the existing web getUserMedia + Supabase Realtime path. Revisit when the rest is stable and demand is real.

**Non-goals (this round)**
- Self-hosted vision model. Stay on Anthropic Sonnet 4.6.
- Marketplace/buyer feature on the public side beyond accepting offers.
- Localization beyond English. EUR + USD currencies stay.
- Replacing Supabase. It's pulling its weight; auth + Postgres + Realtime + storage in one bill is good economics.
- Replacing Stripe / Brevo / pokemontcg.io / Cardmarket — all working.
- Pixel-perfect parity with v1 on day one. v1 stays online during the transition.

---

## 2. Architecture

### 2.1 Repo layout (pnpm monorepo + Turborepo)

```
card-pricer/
├── apps/
│   ├── web/                  # SvelteKit — vendor app + admin + /quote.
│   ├── mobile/               # Expo (React Native) — phone scanner.
│   └── widget/               # Standalone Vite IIFE build → /widget.js.
├── packages/
│   ├── shared/               # Pure TS: types, Zod schemas, identify pipeline,
│   │                         #          arbitrage logic, pricing math, set tables.
│   ├── db/                   # Drizzle schema + migrations + typed query helpers.
│   ├── api-client/           # Typed fetch wrappers used by web + mobile.
│   └── design/               # CSS tokens (DESIGN_BRIEF.md), shared Svelte components.
├── infra/
│   ├── render.yaml           # Web deploy config.
│   └── eas.json              # Mobile build config (Expo Application Services).
├── DESIGN_BRIEF.md           # Already written. Single source of truth for visual rules.
├── V2_PLAN.md                # This file.
└── package.json              # pnpm workspace root.
```

### 2.2 Stack

| Layer | Choice | Why this over alternatives |
|---|---|---|
| Web framework | **SvelteKit** | One framework end-to-end. Vendor app + admin + arbitrage are interactive-heavy (the 80% of the surface area). The 10–20 KB extra hydration cost on the static `/quote` page is invisible on broadband and saves the cross-island state coordination cost that plain Astro+islands incurs. View transitions, form actions, server-side load functions, single mental model. |
| Mobile | **Expo (React Native, managed workflow)** | Cuts native-app time from 3 months to ~3 weeks. Camera + push notifications + auth + native build pipeline all included. App Store / Play Store submission via EAS. We accept the React-on-mobile context-switch (Svelte on web / React on mobile) because this is the smallest team-size investment that ships native. |
| Server | **SvelteKit endpoints (`+server.ts`) (Node adapter on Render)** | Keeps the backend in the same repo + same TS types as the client. We don't need a separate Express service — SvelteKit endpoints (`+server.ts`) handle JSON, streaming (NDJSON), file uploads. |
| DB | **Postgres (Supabase)** | Already in use. Move price snapshots into Postgres rather than JSON files. |
| ORM | **Drizzle** | Lighter than Prisma, no codegen step, SQL-honest. Migrations as plain SQL files in repo. Plays with Supabase Postgres natively. |
| Realtime | **Supabase Realtime** | Already paid for. Replaces the bespoke `/api/room/:id/stream` SSE. Used for multi-operator and for paired-phone live preview. |
| Cache | **Render KV (Upstash Redis)** for short TTLs; **Postgres** for persistent. | We don't need Redis for much beyond price-cache TTL and rate-limiter. |
| Validation | **Zod** | At every boundary (HTTP body, env vars, DB rows after fetch). Generates types automatically. |
| Auth | **Supabase Auth** | Carry over. Add magic-link + Apple/Google providers for the public surfaces. |
| Payments | **Stripe** | Carry over. Subscriptions table moves into Drizzle schema. |
| Email | **Brevo** | Carry over. Email templates extracted to `packages/shared` so server can render them with full type safety. |
| Vision | **Anthropic Sonnet 4.6** | Carry over. Full identify pipeline + double-check + race-with-grace logic ports as a TS module. |
| Tests | **Vitest** (unit) + **Playwright** (e2e) | Vitest runs in CI in 5s flat for the pure-TS modules; Playwright covers the critical flows. |
| Lint | **ESLint + Biome** for formatting | Biome formats faster than Prettier. ESLint catches the things Biome doesn't. |
| Deploy | **Render** for web, **EAS** for mobile | Render keeps the existing infra knowledge. Could swap to Fly.io later if we hit cold-start pain. |

### 2.3 Data model (Drizzle, evolved from current schema)

New tables (proposed):

```
users           — Supabase Auth (existing)
profiles        — existing (plan, is_admin, stripe_customer_id)
shops           — existing (multi-tenant embeds)
quote_leads     — existing (lead capture)
scan_events     — existing (quota tracking)

card_prices     — moves CARD_PRICES Map → Postgres table
                  (set_id, number, variant) PRIMARY KEY
                  + tcg/cm price columns + fetched_at
                  Replaces card-prices.json. Indexed for the arbitrage scan.

inventory_items — NEW. Cards bought into stock.
                  id, owner_user_id (FK profiles), shop_id (FK shops, nullable),
                  card_meta (jsonb — name/set/number/variant), source (scan/manual),
                  cost_eur, condition_at_buy, market_value_at_buy, created_at,
                  state ('in_stock' | 'listed' | 'sold' | 'consigned' | 'returned')

inventory_events — NEW. State transitions + notes + photos.
                  id, item_id, event_type, data (jsonb), created_at, actor_user_id

listings        — NEW. Where an inventory item is listed.
                  id, item_id, marketplace ('cardmarket' | 'tcgplayer' | 'ebay' | 'in-store'),
                  external_url, listed_at, ask_eur, sold_at, sold_eur, fees_eur

customer_accounts — NEW. Public-side login.
                  user_id (FK auth.users), display_name, opted_in_marketing,
                  preferred_shop_slug (FK shops.slug, nullable)

quote_offers    — NEW. A quote that's been formally offered to a customer.
                  id, lead_id (FK quote_leads), shop_id, line_items (jsonb),
                  total_eur, status ('open'|'accepted'|'declined'|'expired'),
                  expires_at, accepted_at

sessions        — NEW. Multi-operator scan sessions.
                  id, owner_shop_id, name, created_at, closed_at

session_scans   — NEW. Scans attributed to a session + operator.
                  id, session_id, scanned_by_user_id, card_meta,
                  pricing_snapshot (jsonb), idempotency_key (UNIQUE per session)

session_presence — Supabase Realtime presence channel — no table needed.
```

RLS: every multi-tenant table enforces `auth.uid() == owner_user_id` or membership-via-shops. Public-side reads of `/api/shop-config/:slug` continue via service-role.

### 2.4 Identify pipeline (ported from v1)

Moves verbatim from server.js into `packages/shared/identify/`:

```
packages/shared/identify/
├── core.ts              # identifyCore — Anthropic call + cache
├── verify-pokemon.ts    # arbitrageVariants/scoreCandidate refactored
├── verify-magic.ts
├── verify-other.ts      # SWU/YGO/etc.
├── double-check.ts      # 2-image Sonnet compare
├── prefetch-ref.ts      # _refImagePromise pattern
├── set-tables.ts        # PKM_SET_ALIASES, SET_TOTALS, POKEMONTCG_UNRELIABLE
└── index.ts             # public API
```

All exported as pure functions taking dependencies (anthropic client, axios, USD→EUR rate) so they're trivially testable. Vitest fixtures replay 50 known scans against the pipeline; coverage gate at 80% on this package.

### 2.5 Arbitrage (ported)

Moves into `packages/shared/arbitrage/`:

```
arbitrageVariants(entry, rate, direction) → ArbitrageVariant[]
bestArbitrage(...) → ArbitrageVariant | null
singleVariantArbitrage(entry, variant, rate, direction) → ArbitrageVariant | null
```

Server endpoint `/api/admin/arbitrage` queries `card_prices` Postgres table, filters in DB (faster than Map iteration above 100k rows). Adds index on `(set_id) where active`.

---

## 3. Phasing — 8 weeks

Each phase ends with a deploy + a smoke test. v1 stays at `card-pricer-60qq.onrender.com` throughout. v2 ships at `v2.card-pricer.onrender.com` (or `app.cards.boardandbrewed.ie` if you want a custom domain set up). Cutover by DNS swap on week 8.

### Week 1 — Foundations

Goal: a working monorepo where every package builds, every test runs, every endpoint returns "ok".

- pnpm workspace + Turborepo setup. `pnpm i && pnpm build` produces all artifacts.
- TypeScript config (strict, NodeNext modules). One `tsconfig.base.json` extended by each package.
- ESLint + Biome baselines.
- GitHub Actions: typecheck + test + build on every push.
- `packages/shared` skeleton with placeholder types.
- `packages/db` with Drizzle config; first migration imports the existing v1 Supabase schema (additive).
- `apps/web` SvelteKit skeleton with `/`, `/quote`, `/api/health`. Widget builds separately under `apps/widget` and outputs `/widget.js` to the same origin via SvelteKit's static serve.
- Render staging service deployed; `https://v2.card-pricer.onrender.com/api/health` returns 200.
- DESIGN_BRIEF.md tokens loaded as CSS custom properties in `apps/web/src/styles/tokens.css`.
- One Vitest test: `arbitrageVariants` happy path.
- One Playwright test: `/api/health` returns 200.

**Done = green CI + staging URL up + design tokens visible on /quote skeleton.**

### Week 2 — Customer surfaces (`/quote` + widget + lead capture)

Public side first because it's the easiest, has the cleanest contracts, and lets us verify the embed widget keeps working (existing customers have hardcoded `<script>` tags pointing at `/widget.js`).

- Port `/api/quote-lead`, `/api/shop-config/:slug`, `/api/identify-manual`, `/api/price`, `/api/search` to SvelteKit endpoints (`+server.ts`).
- Port `quote.html` to SvelteKit route (`apps/web/src/routes/quote/+page.svelte`) with a `+page.server.ts` for shop-config loading + a `+page.svelte` form. Server-render initial HTML so SEO + first-paint stay good even with full SvelteKit hydration.
- Brevo integration as a `packages/shared/email/brevo.ts` adapter. Email templates as TS functions returning HTML — typed input.
- Multi-newsletter-provider router (`brevo` / `mailchimp` / `convertkit` / `off`) ported as an adapter pattern.
- `apps/widget` builds `widget.js` from a single TS source via Vite IIFE bundle. Output written to `apps/web/static/widget.js` so SvelteKit serves it at the same URL. Same data-attrs (`data-shop`, `data-color`, `data-position`, `data-label`) for backward compat.
- Drizzle migration for any new fields (probably none — `shops` and `quote_leads` carry over).

**Done = paste old shop's widget snippet into a test page → modal opens, scan, submit, email arrives, lead row in `quote_leads` table.**

### Week 3 — Vendor app: scan + log + settings

The biggest single lift. SvelteKit layout + 3 routed pages with shared stores.

- Auth gate as `+layout.server.ts` (Supabase JWT verification, populates `event.locals.user`).
- `+layout.svelte` wraps the tab nav + sticky header.
- `/scan` Svelte page:
  - Bulk upload mode (drag-drop + grid of tiles).
  - Text entry mode (textarea + lookup queue).
  - Camera mode lives only on mobile app (replaces the v1 paired-phone QR flow). Web `/scan` remains laptop-only.
- `/log` Svelte page:
  - Session list (chronological).
  - Cash + Credit sliders (with `% of market` anchor — already nailed in v1).
  - Per-row card name in Fraunces italic, prices in Plex Mono.
- `/settings` Svelte page:
  - Account + plan picker.
  - Embed config (the multi-tenant shop form ported from v1).
  - Pair-phone via the new mobile app — replaces QR rooms with a 6-digit code.
- All identify endpoints (`/api/identify`, `/api/identify-stream`, `/api/identify-manual`, `/api/price`) ported to SvelteKit endpoints (`+server.ts`) with Zod request validation + typed responses.
- The signature moment (Fraunces card name + amber hairline reveal) carried over as a Svelte transition.

**Done = log in → scan → see priced result → save to session log → reload, session restored. Same path that v1 supports.**

### Week 4 — Admin + arbitrage + price-snapshot to Postgres

- `/admin/+layout.server.ts` gates by `is_admin`.
- `/admin/arbitrage` Svelte page with virtualised data grid for 1000+ result sets (currently capped at 500 server-side, can lift).
- Move `CARD_PRICES` from in-memory Map + JSON file to a `card_prices` Postgres table. Migrate existing data once via a script. Bulk refresh writes via `INSERT ... ON CONFLICT UPDATE`. Arbitrage scan reads via a single query with WHERE filters in SQL.
- Background job for `refresh-prices`: dedicated endpoint kicks it off but uses Render Cron Jobs (or a tiny worker) so it survives dyno restarts.
- Trend microcopy already plumbed in v1.70 (`cmAvg30`); keep.
- Liquidity proxies kept (`cmAvg7`, `tcgLowMarketRatio`).

**Done = arbitrage scan returns in <500ms (was multi-second in v1 due to Map iteration). Refresh-prices is robust to crashes.**

### Week 5 — Inventory (customer accounts deferred to v2.1)

- Drizzle migrations: `inventory_items`, `inventory_events`, `listings`.
- `/inventory` page in vendor app:
  - Grid of in-stock cards with cost, market value, days-on-shelf, P&L if sold.
  - State machine: scanned → bought → in_stock → listed → sold (or consigned / returned).
  - Per-item event timeline (paid €X on date Y, listed on Cardmarket at €Z, sold on date W).
  - Bulk-list helper: select N items, generate Cardmarket-friendly TSV.
- "Mark as bought" in `/log` creates an inventory item directly.

**Done = bought-card flows into inventory; state machine + P&L work.**

### Week 6 — Multi-operator real-time

- Supabase Realtime channels per session: `session:{id}` broadcasts inserts to `session_scans`.
- Operator presence: who's currently scanning into the session.
- Idempotency keys on scans so a concurrent dupe doesn't double-add.
- UI: small avatar stack of active operators in the session header. Each scan attributed visually ("Joe scanned Charizard").
- Conflict resolution UX: if two scans of the same card land within 2 seconds, show a "merge?" prompt rather than auto-dedup.
- Phone-as-camera continues to work via the existing web getUserMedia path; pair via 6-digit session code instead of QR room.

**Done = two laptops + one paired-phone-camera all scanning into the same session in real time, all three see every scan with attribution within 200ms.**

### Week 7 — Customer accounts

- Drizzle migrations: `customer_accounts`, `quote_offers`.
- Supabase Auth on the public side (separate from vendor JWTs) — magic-link by email.
- `/account` page:
  - Saved-quotes list (joined from `quote_leads` by email).
  - Email + marketing preferences.
  - Linked shops (which shops they've requested quotes from).
- Quote acceptance flow: shop offers via email → customer clicks → `/account/offer/:id` with accept/decline buttons → response webhooks back to shop email + records in `quote_offers`.
- Email preferences synced to Brevo lists when the shop is on Brevo.
- Public-side Supabase Realtime subscription on `quote_offers` so an open `/account` page sees new offers land live.

**Done = customer logs in via magic link → sees past quotes → accepts/declines a new offer in browser → shop receives the response.**

### Week 8 — Cutover, polish, documentation

- Domain swap: production cutover to the new custom domain (see §11). `card-pricer-60qq.onrender.com` 301-redirects to it. v1 stays at `legacy.<domain>` for 30 days as fallback.
- Migrate user data: Supabase tables are shared so most data is already there. Run the one-time `card_prices` migration. Verify no data loss.
- Performance pass: Lighthouse 95+ on `/`, `/quote`. Axe DevTools 0 critical issues. Mobile reflow audit at 390×844.
- Test coverage pass: unit coverage ≥ 80% on `packages/shared`; Playwright E2E covers the five critical flows (vendor scan, quote submit, embed widget, arbitrage scan, customer-account magic-link).
- Documentation: README, DEPLOY.md updated, ops runbook, developer setup script, architecture decision records for the major choices.
- Decommission unused v1 code paths (no rush).

**Done = v2.0 is live. v1 still works as a fallback. Customers and shop owners use v2 by default.**

---

## 4. What we keep from v1

This is mostly already in `packages/shared/` after week 1 of porting. Each is a one-file port with no behaviour change:

- `verifyPokemon` and the entire score-with-grace-150ms race logic (server.js:3160+).
- `prefetchRefImage` + `maybeDoubleCheck`.
- `arbitrageVariants` + `singleVariantArbitrage` + `bestArbitrage`.
- `PKM_SET_ALIASES` + `SET_TOTALS` + `POKEMONTCG_UNRELIABLE`.
- `applyAdditionalsLabel` (the secret-rare numbering quirk handling).
- USD→EUR rate via Frankfurter API.
- Brevo / Stripe / Anthropic / Cardmarket / pokemontcg.io integrations as adapters.
- Multi-newsletter-provider router (Brevo / Mailchimp / ConvertKit / off).
- The recent design token set (DESIGN_BRIEF.md).
- The v1.66 emoji-purge rules + signature-moment animation.
- Shop schema + RLS policies (Supabase migrations carry over).
- Quote-lead capture flow.

## 5. What we drop

- Monolithic 6,900-line `index.html` and 5,700-line `server.js`.
- All inline `<script>` blocks for app code.
- All inline `style="..."` attributes in JS template literals.
- The legacy `var(--bg)` / `var(--text)` alias chain.
- The Pokellector corrections layer baked into JSON (becomes a database seed table).
- `data/card-db.json` and `data/card-prices.json` (Postgres replaces both).
- The `/api/room/:id/*` SSE pattern (Supabase Realtime replaces it).
- Service worker as written. Replace with Workbox for offline caching of the SvelteKit shell.
- The PWA install nudge (we'll have a real native app instead).

## 6. Risks + unknowns

| Risk | Mitigation |
|---|---|
| Mobile app review queue could push launch into week 9-10. | Start submission early in week 7 with a placeholder build. |
| Anthropic API costs with multi-operator scaling. | Quota caps stay; optionally route low-confidence scans through a cheaper Haiku path first. |
| Supabase Realtime free tier limits (200 concurrent connections). | We're nowhere near that today. Upgrade to Pro at €25/mo if needed. |
| Drizzle + Supabase Realtime schema drift. | Migrations in repo; CI runs `drizzle-kit check` on every PR. |
| 4-8 weeks is genuinely ambitious for all four new pillars. | Phasing puts the must-have items (port + admin + arbitrage) in weeks 1-4. If we're behind on week 5, customer accounts can ship as a stretch in week 9. Inventory is the hardest to descope. |
| Existing widget customers' snippets must keep working. | `/widget.js` URL stays identical; bundle output preserves the same data-attrs and postMessage protocol. |
| Native app feels like a separate product. | Same brand assets, same design tokens (NativeWind tokens mirror DESIGN_BRIEF.md), shared `packages/api-client` — single login, single account. |

## 7. Cutover strategy

1. **Weeks 1-7**: v1 stays live, v2 builds in parallel at `v2.card-pricer.onrender.com`.
2. **End of week 7**: internal beta on v2. You + 1-2 trusted shop owners test.
3. **Week 8**: production cutover via DNS / domain switch. v1 keeps running at `legacy.*` URL for 30 days. Existing widget snippets continue to point at `/widget.js` and resolve to v2.
4. **Week 9-10**: monitor error rates, Lighthouse, Brevo/Stripe webhook continuity. Fix tail issues.
5. **Day 30 post-cutover**: remove `legacy.*` and the old Render service.

---

## 8. Resolved decisions (post-questionnaire)

- ✅ **Native mobile app deferred** out of v2.0. Web scanner (getUserMedia) carries on. Revisit when v2.0 is stable and there's demand. Expo / Apple Dev / Play Console provisioning is no longer a week-1 prerequisite.
- ✅ **Customer accounts restored to v2.0** (the bandwidth freed by deferring mobile makes this fit). Magic-link login + saved-quotes + accept-an-offer flow ships in week 7.
- ✅ **SvelteKit over Astro.** Single framework end-to-end. The vendor app and admin are heavily interactive (~80% of the surface); paying ~15 KB extra on `/quote` to gain unified stores, simpler auth, and one mental model is the right trade.
- ✅ **Drizzle over Prisma.** SQL-honest, no engine binary, plays naturally with Supabase's RLS-and-Postgres model. Light enough to not hurt cold starts on Render.
- ✅ **Custom domain on cutover.** See §11 for the candidate list — pick before week 6 so DNS propagation is finished by cutover.

### Things I'd still push back on if asked

- **Render vs Fly.io vs Vercel.** Render is fine for our load. Fly.io has lower cold-start and edge regions; would consider for v2.5 if EU latency becomes a complaint. Vercel charges for the API surface in ways Render doesn't.
- **Single Postgres for v1 + v2.** Both apps share the existing Supabase project. Cleaner than dual-DB during cutover. But it means a v2 migration that breaks a column also breaks v1 — additive-only migrations until v1 is decommissioned.

## 9. What you'd need to do before week 1 starts

- **Pick the production domain** (see §11). Buy on Cloudflare Registrar / Namecheap (~€10–15/yr). Point CNAME to Render after week 7.
- **Closed-beta cohort** — name 3-5 people who'll actually scan a few hundred cards in week 6-7 and report rough edges.

(Mobile app provisioning — Apple Dev, Play Console, Expo subscription — is no longer required. Revisit when mobile is back on the table.)

---

## 10. Estimated cost delta vs v1

| Item | v1 monthly | v2 monthly | Notes |
|---|---|---|---|
| Render (web) | ~€25 | ~€25 | Same. May go Pro on cutover for autoscale. |
| Supabase | €0 | ~€25 | Pro tier needed for Realtime + bigger DB. |
| Anthropic | varies | varies | Same. Costs scale with users. |
| Stripe | 1.4% + €0.25/txn | unchanged | |
| Brevo | free / €25 | unchanged | |
| EAS (Expo) | €0 | €0 | Mobile deferred. |
| Apple Dev | — | — | Mobile deferred. |
| Google Play | — | — | Mobile deferred. |
| **Total fixed** | **~€25** | **~€60** | Render + Supabase Pro the only delta. Mobile costs return when we revisit native. |

---

## 11. Domain — pick one before week 6

The widget URL ends up in customers' websites as `<script src="https://<domain>/widget.js">`. If other shops embed it, the domain shouldn't say "Board & Brewed" — it should be neutral.

**Single-tenant** (this is just for Board & Brewed forever):
- `app.cards.boardandbrewed.ie` — fine, no purchase needed.

**Multi-tenant** (other shops paste your widget on their sites):
- `cardpricer.io` — €30/yr typical (.io is pricier).
- `cardpricer.app` — €15/yr.
- `pricecards.app` / `cardspring.io` — check availability.
- `tcg.tools` — short, memorable.
- `decklist.io` — short, retains the Pokemon/MTG vibe.

I'd lean **multi-tenant neutral domain** since you've already wired up the embed widget for other shops. Tell me which one you want and I'll plumb it.

## 12. Approval

If you sign off, week 1 starts with:
1. Creating the v2 branch (or sibling repo) with the monorepo skeleton.
2. Setting up the Render staging service.
3. You provision: Apple Dev account, Play Console (if Android-second is acceptable), Expo Application Services, the chosen custom domain.
4. First Vitest test green by end of week 1.

What I need from you to start:
- Confirmation on the domain (§11).
- Whether you have a pre-existing Google Play Console account (changes the Android timeline).
- The 3-5 names for the closed-beta cohort.
