# Card-Pricer V2 — Migration Guide

**Audience:** the operator (and anyone setting up a fresh environment after V2 ships).

**Companion docs:**
- `docs/V2_RELEASE_NOTES.md` — what changed and why.
- `infra/deploy/release-runbook.md` — the cutover procedure (T-24h → T+2h).
- `infra/deploy/sessions-readflip-runbook.md` — separate post-V2 operation.
- `infra/deploy/stripe-webhook-smoke.md` — post-deploy verification.

---

## TL;DR

V2 is a structural reorg + scope expansion of V1. Almost nothing the end user sees has changed; almost everything the operator touches has changed shape.

The migration is in three buckets:

1. **Code** — handled by `git pull` after the cutover merge. `npm install` once. No manual edits.
2. **Configuration** — 5 new env vars + 1 plan upgrade + 1 Supabase setting. Listed below.
3. **Data** — additive only. No destructive migrations. Existing rows untouched.

---

## 1. Code migration

### Branch state

V2 lives on the `v2` git branch. `main` is unchanged since commit `1309ccd` (the V1 security fixes + phase-1/2 docs + missing migrations were committed there in pre-V2 prep; everything after that is on `v2`).

### Cutover merge

Per the release runbook §T-0 step 2:

```bash
git checkout main
git pull origin main
git merge --no-ff v2
# resolve conflicts (none expected — main is untouched since 1309ccd)
git tag pre-v2-cutover <pre-merge-main-SHA>
git push origin pre-v2-cutover
git push origin main
```

Then trigger a manual deploy in the Render dashboard.

### NPM dependencies

After the merge, the build step (`npm install` in `render.yaml`) installs:

- **New runtime deps** (3): `pino`, `prom-client`, `@sentry/node`. Total ~18 MB.
- **New dev deps** (2): `pino-pretty`, `jsdom`. Not shipped to prod.

No version conflicts expected on Node 20.10.0 (the pinned version per `infra/render.yaml`).

### File system state on the running server

Render Starter's persistent disk is mounted at `/opt/render/project/data`. V2 writes:

- `data/card-db.json` — written by `apps/server/_card-db-boot.js` (transient location; S10 follow-up moves into `db/card-db/persist.js`).
- `data/card-prices.json` — backup-only after V2 (Postgres `card_prices` is primary). Drop in a post-V2 cleanup.
- `logs/bad-ids.log` — append-only JSONL from `/api/report-bad-id`.

If you're migrating a Render service that previously had no persistent disk: `data/*` was ephemeral on V1 too. Booting V2 with an empty disk will trigger a one-time pokemontcg.io re-pull (~5 min) populating `CARD_DB`. The Postgres `card_prices` table will already be empty in production; V2 boot tries Postgres first (returns 0 rows), falls through to file (also empty), falls through to API download. Subsequent boots see a populated Postgres `card_prices` and skip the download.

---

## 2. Configuration migration

### Render plan + disk

Required: **Starter plan** ($7/mo) with a 1 GB persistent disk mounted at `/opt/render/project/data`. The disk config is in `infra/render.yaml`:

```yaml
disk:
  name: card-pricer-data
  mountPath: /opt/render/project/data
  sizeGB: 1
```

If you're already on Free tier: upgrade in the Render dashboard before merging `v2 → main`. If you forget, V2 still runs but `data/*` is ephemeral and the boot will re-pull pokemontcg.io after every deploy.

### Region

V2's `render.yaml` declares `region: frankfurt`. Supabase project `vecbaewlxodqnevduoiy` is in `eu-west-1` (Ireland); Frankfurt is the closest Render region for low-latency Postgres calls. If your existing service is in Oregon or another US region, the cutover is a region change — Render handles this with a short downtime; document the move in your incident channel.

### Environment variables

V2 declares **32 env vars** in `infra/render.yaml`. V1 declared 7. The full list with comments lives in `infra/env.example` — copy each one into the Render dashboard before the cutover.

**REQUIRED (8 — service won't function without these):**

| Var | Used for | V1 had it? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Card identification, OCR, double-check | ✓ |
| `SUPABASE_URL` | Auth + persistence | (in dashboard, not yaml) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role DB access | (in dashboard, not yaml) |
| `STRIPE_SECRET_KEY` | Checkout, portal, webhook | (in dashboard, not yaml) |
| `STRIPE_WEBHOOK_SECRET` | Signature verification | (in dashboard, not yaml) |
| `STRIPE_PRICE_*_*` (6 vars) | Plan ↔ price ID mapping | (in dashboard, not yaml) |
| `BREVO_API_KEY` | Customer + shop email + newsletter | (in dashboard, not yaml) |
| `NODE_VERSION` | Render build | ✓ |

**OPTIONAL (everything else with a documented degraded mode):**

| Var | Default behaviour when unset |
|---|---|
| `EBAY_APP_ID` / `EBAY_CERT_ID` | `priceEbaySold` returns null; pricing falls back to other adapters |
| `JUSTTCG_API_KEY` | JustTCG adapter `isAvailable()` returns false |
| `RAPIDAPI_KEY` | TCGGO adapter unavailable; TCGGO unreliable-set import skips |
| `POKEMON_TCG_API_KEY` | pokemontcg.io rate-limited to 30/min unauth (V2 throttles to 25/min) |
| `BREVO_SENDER_EMAIL` | Falls back to `SHOP_EMAIL` then a hardcoded address |
| `BREVO_NEWSLETTER_LIST_ID` | Newsletter opt-ins saved to `quote_leads.newsletter` but not subscribed |
| `IP_HASH_SALT` | Falls back to `'card-pricer-default-salt'` (no security impact for the use case) |
| `CARD_DB_SHEET_URL` | No Google Sheet load; falls through to file → API |
| `SHOP_NAME` / `SHOP_EMAIL` | Falls back to `'Card Pricer'` and `'dave@boardandbrewed.ie'` |
| `OCR_FIRST_ENABLED` | DEFAULT 'false' — OCR-first endpoint returns 503 immediately |
| `READ_FROM_RELATIONAL` | DEFAULT 'false' — `/api/state` reads JSONB blob (V1 path) |
| `SENTRY_DSN_SERVER` | Sentry server SDK no-ops; no error tracking |
| `SENTRY_DSN_BROWSER` | Sentry browser SDK no-ops |
| `SENTRY_ENVIRONMENT` | DEFAULT 'production' |
| `GIT_SHA` | `/api/version` returns `'unknown'` |
| `BUILT_AT` | `/api/version` returns `null` for `built_at` |
| `METRICS_TOKEN` | `/api/metrics` requires admin JWT only (no Prom scraper bearer bypass) |
| `LOG_LEVEL` | DEFAULT 'info' |
| (sealed pricing — V2.0.1) | No env vars required. Cardmarket sealed adapter is always available; uses Cardmarket scrape + operator manual override |
| `NODE_ENV` | DEFAULT 'production' (controls pino's pretty/JSON mode) |
| `PORT` | DEFAULT 3000 (Render sets this) |
| `DEFAULT_BUY_PERCENTAGE` | DEFAULT 60 |

### Supabase Site URL allow-list

For the customer magic-link sign-in to work (S20), add these to the Supabase project's "Site URL" + "Redirect URLs":

- `https://card-pricer-60qq.onrender.com/customer`
- `https://card-pricer-60qq.onrender.com/customer#auth=callback`
- (any custom domain, same paths)

Without this, magic links land on a "URL not allowed" error.

### Sentry browser SDK CDN

Optional — Sentry browser modules no-op cleanly without a DSN, so this can be deferred. If you want browser error tracking:

1. Pick a Sentry browser SDK version (e.g. `8.55.0`).
2. Get the SRI hash for `https://browser.sentry-cdn.com/<version>/bundle.tracing.min.js` (Sentry publishes these).
3. Edit `apps/vendor/index.html`, `apps/quote/index.html`, `apps/customer/index.html` and replace the TODO `<script integrity="sha384-TODO">` line with the real script tag.
4. Add an inline `<script>` exposing `window.__SENTRY_DSN_BROWSER__`, `window.__SENTRY_ENVIRONMENT__`, `window.__GIT_SHA__` — or have the apps fetch from `/api/version` on init.
5. Each app's `main.js` already calls `initSentryBrowser({...})`; it'll start working once the global is there.

This is genuinely optional. Server-side Sentry alone catches most issues; browser-side adds session-replay-style context for client crashes.

---

## 3. Data migration

### Schema state

Production Supabase has 15 public tables. V2 doesn't add any. It DOES add:

- `scan_events.data jsonb` column (additive, nullable, no default) — for OCR-first telemetry.
- 3 indexes on `sessions` / `session_cards` for the read-flip dual-writer.

Both migrations are idempotent (`add column if not exists`, `create index if not exists`). They've been APPLIED to production already (commits `c741a25` shipped them to `main`'s migrations folder; the SQL was applied via the Supabase SQL Editor as part of phase 1's "missing migrations" capture).

### Tables V2 starts using that V1 ignored (carryover)

The following tables existed in production via the rolled-back V2 attempt (per `supabase/migrations/20260502221125_v2_carryover.sql`) but V1 never read or wrote them. V2 starts using them:

- `card_prices` — admin arbitrage data; V2 dual-writes to file + table.
- `live_sessions` + `live_session_scans` — phone-pair Postgres backing; V2 dual-writes to in-memory + tables.
- `sessions` + `session_cards` — vendor session log dual-write target. NOT YET READ from in V2 — read flip is post-V2 per the readflip runbook.
- `inventory_items` + `inventory_events` + `listings` — inventory subsystem; only written when a vendor uses `/api/v2/inventory/*` (shop plan only).
- `customer_accounts` + `quote_offers` — customer flow; only written when a customer signs in / a shop creates an offer.

All seven were empty in production at the time of V2's release. V2's first run starts populating them.

### No destructive migrations

V2 ships zero `DROP TABLE`, `DROP COLUMN`, or `UPDATE ... WHERE` operations. Every change is additive. **A V1 rollback (Path A in the release runbook) needs zero data work.**

### Post-V2 destructive migrations (separately runnable, with rollbacks)

These ship in V2.1+, NOT in this V2 cutover:

1. **Drop `user_state.state` column** — after the read-flip is stable (≥1 week post-flip). Migration file + rollback to be authored when the time comes.
2. **Drop `data/card-prices.json`** — after Postgres warm-up confirms twice. Just a `rm` operation; no migration.
3. **Drop `apps/widget/widget-v1.js`** — after stable month. Just delete the file + remove the byte-for-byte parity test. Not strictly destructive (no data loss) but counts as an artefact retirement.
4. **Drop `apps/server/_card-db-boot.js`** — after S10's full absorb into `db/card-db/persist.js`.

---

## 4. Post-cutover state checks

After the cutover, verify in this order:

### Service health

```
curl https://card-pricer-60qq.onrender.com/api/health
# expect: {"status":"ok",...}

curl https://card-pricer-60qq.onrender.com/api/version
# expect: {"git_sha":"<merge-commit-sha>","built_at":...,"node_version":"v20.10.0",...}
```

### Vendor app

```
# Open https://card-pricer-60qq.onrender.com/
# Sign in with your operator account
# Scan a fixture card (or upload via Bulk tab)
# Verify the result appears with the V2 result-sheet styling (Fraunces 600 italic name + amber hairline)
# Switch to Session tab; confirm the row is logged
# Switch to Admin tab; confirm Analytics section renders
```

### Quote app (customer-facing)

```
# Open https://card-pricer-60qq.onrender.com/quote?shop=brewed
# Paste 3-5 card lines (e.g. PAL 25, MEW 2, OBF 158)
# Run lookup; confirm prices appear (V2 calls /api/v2/quote/* — no auth, no 401)
# Submit email gate with a test inbox
# Confirm the bookmark URL panel appears (S12)
# Open the bookmark URL in a new tab; confirm the saved quote loads without re-entering
```

### Customer app (NEW in V2)

```
# Open https://card-pricer-60qq.onrender.com/customer
# Click "Email me a sign-in link" with a test inbox
# Receive the magic link, click it
# Confirm you land on the dashboard (empty state if you have no offers)
# Click Account, edit display name, save; confirm PATCH /api/v2/customer/me succeeds
```

### Widget

```
# Open Board & Brewed (https://boardandbrewed.ie or your live host)
# Confirm the embed button still appears (V1-attribute parity)
# Click it; confirm the modal opens with the iframe to /quote?embed=1&shop=brewed
# Submit a test quote through the iframe; confirm postMessage cp:submitted reaches the host page
```

### Stripe webhook

Per `infra/deploy/stripe-webhook-smoke.md`:

```
stripe events list --limit 1
stripe events resend <event_id>
# Verify in Supabase: SELECT plan, plan_interval FROM profiles WHERE stripe_customer_id = '<customer>'
```

If signature verification fails → `req.rawBody` capture broken → roll back via Path A.

### Postgres state

```sql
-- Cards seeded from boot
SELECT count(*) FROM card_prices;  -- expect ~25k after first 5-min boot

-- live_sessions empty until first phone pair
SELECT count(*) FROM live_sessions;

-- sessions/session_cards empty until first /api/state PUT after cutover
SELECT count(*) FROM sessions;
SELECT count(*) FROM session_cards;

-- profiles unchanged
SELECT count(*), count(distinct plan) FROM profiles;

-- scan_events still accumulating
SELECT max(ts), count(*) FROM scan_events;
```

---

## 5. If something goes wrong

### During T-0 to T+2h

Use the runbook's rollback paths. **Path A (single-commit revert)** is preferred:

```
git revert -m 1 <merge-commit-sha>
git push origin main
# Trigger manual deploy in Render
```

Path B (force-push to `pre-v2-cutover` tag) is the destructive escape hatch.

Either path: data is safe. V2's writes to `card_prices`, `live_sessions`, `sessions`, `session_cards`, `customer_accounts`, `quote_offers`, `inventory_*`, `listings` are additive; V1 doesn't read them after rollback.

### After T+2h

If a regression surfaces later (after the operator-watched window), file an incident, decide whether it's blocking, and either:
- Patch on `main` (small fix, low risk), OR
- Revert to V1 via Path A.

The release runbook §post-cutover-monitoring describes the alert thresholds.

### If the read-flip causes problems (post-V2 separate event)

Per `infra/deploy/sessions-readflip-runbook.md`: set `READ_FROM_RELATIONAL=false` on Render. Render auto-deploys the env change. Reads revert to JSONB blob (untouched throughout the dual-write window). No data loss.

---

## 6. Summary of operator effort

**Pre-cutover** (~1-2h work spread over a week):
- Set 8+ env vars on Render.
- Add Supabase Site URL allow-list entries.
- (Optional) Pick Sentry version + edit 3 HTML files for SRI hashes.
- Tag `pre-v2-cutover`; disable Render auto-deploy; reduce widget Cache-Control to 60s.
- Walk the T-24h checklist.

**Cutover** (~30 min):
- Merge `v2 → main`; push.
- Manual deploy.
- Walk the T-0 nine-step checklist with gates.
- Verify the 5 post-cutover state checks.
- Restore Cache-Control to 300s; re-enable auto-deploy.

**Post-cutover** (~2h watch + ongoing):
- Sentry + Render logs continuously for 2h.
- Synthetic checks every 10 min for 2h, then UptimeRobot every 5 min indefinitely.
- After 1 stable week: schedule the read-flip per the readflip runbook.
- After 1 stable week: decide on retiring `data/card-prices.json` + `apps/widget/widget-v1.js`.

**Total operator hours-on-keyboard for the cutover itself:** ~3 hours.

---

## Hand-back

Per `CARD_PRICER_V2_PROMPT.md` §8: the orchestrator stops here.

The work is on the `v2` branch. Tests are green. Docs are written. Runbooks are written. Decision is yours.

If you want me to do more (e.g., fix the Brevo-ordering follow-up before V2 ships, implement DELETE /api/v2/customer/me, or anything else from the V2.1 list), just ask.
