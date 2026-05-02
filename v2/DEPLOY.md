# Card Pricer v2 — deploy notes

## Render staging

1. Render dashboard → New → Blueprint → point at `LeninLives1917/card-pricer`.
2. Pick `infra/render.yaml` from this repo (root: `v2`).
3. Set the env vars marked `sync: false` (Supabase URL/keys, Anthropic, Brevo, Stripe, IP_HASH_SALT, DATABASE_URL).
4. Build: `pnpm install --frozen-lockfile && pnpm build`. Start: `node apps/web/build/index.js`. Health: `/api/health`.
5. Initial domain: `card-pricer-v2.onrender.com` (placeholder). Custom: `cardpricer.app` per `V2_PLAN.md` §11.

## Custom domain (cardpricer.app)

After purchasing the domain (Cloudflare Registrar / Namecheap):
1. In Render → service → Settings → Custom Domains → add `app.cardpricer.app` (or apex).
2. Copy the CNAME value Render gives you.
3. At the registrar's DNS, add the CNAME record. Apex domains need ALIAS/ANAME or Cloudflare proxy.
4. SSL provisions automatically. Wait ~5 min after DNS propagates.

## Database migrations

Migrations live in `packages/db/migrations/` as plain SQL.

```bash
# Inspect what's pending
ls v2/packages/db/migrations/

# Apply manually via Supabase SQL editor (paste each .sql in order).
# 0001_card_prices.sql      — week 4: card_prices table for arbitrage
# 0002_inventory.sql        — week 5: inventory_items, inventory_events, listings
# 0003_sessions.sql         — week 6: sessions + session_scans (multi-operator)
# 0004_customer_accounts.sql — week 7: customer_accounts, quote_offers
```

For automated runs once the team grows, swap to `pnpm --filter @card-pricer/db migrate`.

## First-run seed: card_prices

The `card_prices` table starts empty after migration. The arbitrage scan reads from it, so seed before using:

1. Sign in as an admin user (profiles.is_admin = true).
2. Open `/admin/arbitrage`.
3. Click **Refresh prices**. The button kicks off `/api/admin/refresh-prices` — a fire-and-forget job that pulls all sets from pokemontcg.io and upserts into `card_prices`.
4. With a `POKEMON_TCG_API_KEY` set, the throttle is 5x batches; without one, ~25 req/min.
5. Refresh status polls `/api/admin/refresh-status`; the page surfaces it automatically.

## Cutover from v1

1. Push v2 to staging Render service. Confirm `/api/health` returns 200.
2. Apply migrations 0001–0004 to the Supabase production database (additive, won't break v1).
3. Run a one-time `card-prices.json → card_prices` migration script (week 4 deliverable).
4. Smoke test on `card-pricer-v2.onrender.com`: identify a card, submit a quote, run an arbitrage scan.
5. Point `cardpricer.app` (or chosen domain) DNS at the v2 service.
6. Add a 301 from `card-pricer-60qq.onrender.com` to the new domain (or set the v1 service to redirect).
7. v1 stays at `legacy.<domain>` for 30 days as fallback.
8. After 30 days clean: remove the v1 Render service, leave `git tag v1-final` as the permanent backup.

## Rollback

If v2 breaks in production:
- Point DNS back at `card-pricer-60qq.onrender.com` (v1).
- v1 was tagged at `v1-final` (commit `80448c0`). Render's auto-deploy still serves it from `main`.
- v2 staying at the staging URL during rollback is fine — no users are pointed at it.
