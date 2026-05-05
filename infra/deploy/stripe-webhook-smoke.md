# Card-Pricer V2 — Stripe Webhook Smoke Procedure

**Owner:** A8 | **Slice:** S25 | **Companion:**
[release-runbook.md](./release-runbook.md) (step 8 references this doc).

---

## What this tests

That `POST /api/stripe-webhook` correctly:

1. **Verifies Stripe signatures** using the raw request body (not the
   parsed JSON).
2. **Routes the event** to the right handler (subscription created /
   updated / deleted, invoice paid, etc.).
3. **Persists the result** to Supabase — the `profiles` row's `plan`,
   `plan_interval`, and `stripe_customer_id` columns end up consistent
   with what Stripe says.

The single most common failure mode is **raw-body capture**. The
`express.json` middleware in `apps/server/index.js` registers a `verify`
callback that stashes the raw bytes on `req.rawBody`. The webhook handler
uses those bytes — not the parsed `req.body` — when calling
`stripe.webhooks.constructEvent(...)`. If anything regresses that
capture (a refactor that swaps `express.json` for a wrapper that drops
the verify hook, a body-parser order change, anything), Stripe's HMAC
will not match.

---

## Why it matters

- Stripe retries failed webhooks **3 times over 3 days** before giving
  up. The window between a regression landing and the operator noticing
  is therefore at most 3 days — but during that window, **paying
  customers are charged but their plan is not updated** (or vice versa
  on cancellation: cancelled customers retain access).
- This is risk **R6** in the V2 audit. The smoke procedure here is the
  primary mitigation.
- Stripe's signature verification is the only trust boundary between
  Stripe's HTTP request and our database write. There is no second
  authentication layer; if signature verification is broken or
  bypassed, anyone who can POST to the endpoint can mutate `profiles`.

---

## The procedure (post-deploy, run on prod)

You need the Stripe CLI installed and authenticated against the
production account (`stripe login`). Run from your local machine.

```bash
# 1. Find a recent real event ID from production traffic.
stripe events list --limit 5

# Pick one whose type is informative — `customer.subscription.updated`
# or `invoice.paid` are good. Note the customer's id (cus_...) for the
# DB verification step below.

# 2. Replay it to the production webhook endpoint.
stripe events resend <event_id> \
   --webhook-endpoint https://card-pricer-60qq.onrender.com/api/stripe-webhook
```

Expected response: HTTP 200 with `{ received: true }` (or whatever
shape the V2 handler returns — check Render logs to confirm the
specific response).

### Verify in Supabase

In the Supabase SQL editor (or `psql` against the prod connection
string):

```sql
SELECT id, plan, plan_interval, stripe_customer_id, updated_at
FROM profiles
WHERE stripe_customer_id = '<cus_id from the replayed event>';
```

The row's `plan` / `plan_interval` should match what the event would
set. `updated_at` should be within the last few seconds.

If the row didn't change but the webhook returned 200, the handler
silently succeeded without doing the work — see "200 but no DB update"
in the failure modes below.

---

## Failure modes

### 400 — "no signatures found matching the expected signature"

The most common failure. **Raw-body capture is broken.**

Causes:
- Someone refactored `apps/server/index.js`'s `express.json({ verify })`
  call and didn't preserve the `verify` callback.
- The webhook handler is reading `req.body` (parsed) instead of
  `req.rawBody` (the captured Buffer).
- A new middleware was added before the webhook router that consumed
  the body stream.

Check: `grep -n "rawBody" apps/server/**/*.js` should show the verify
callback writing to `req.rawBody` and the webhook handler reading
from it. RG-14 (regression test) should also be failing in CI if this
broke; if CI was green and prod is 400, the env shape between CI
fixtures and prod differs (e.g. different `STRIPE_WEBHOOK_SECRET`).

**Action:** roll back per release-runbook.md. The fix is not safe to
hot-patch under cutover pressure.

### 404 / 503 from the webhook endpoint

The route isn't deployed correctly. Either the `routes/billing.js`
router didn't mount, or the deploy itself is broken.

Check `/api/health` — if that returns 200, the server is up; the
webhook is the routing problem. Check Render logs for the boot
sequence; route mounts log on startup with the V2 pino logger.

**Action:** roll back. Investigate locally.

### 200 but no DB update

Signature verified, handler ran, no error — but the `profiles` row
didn't change.

Causes:
- Handler logic regression — e.g. matching on a customer id that
  doesn't exist in `profiles`.
- The event type isn't one the handler responds to (some Stripe
  events are intentionally no-op'd; check the handler's switch).
- Supabase write silently failed — service-role key invalid or
  rotated, RLS misconfigured (shouldn't apply to service role, but
  worth checking).

Check Render logs for the request id corresponding to the replay;
the handler should log every event it handles.

**Action:** if it's a no-op event type, that's expected — pick a
different event id (one Stripe actually responds to in code) and
retry. If it's a real regression, roll back.

### Connection timeout / 502

Render service unreachable. Probably mid-deploy or restarting.

**Action:** wait 30 s and retry. If persistent after 2 min, the
deploy is wedged — go to the Render dashboard and roll back from
there.

---

## Local testing (optional, for confidence before prod)

Recommended before any change to Stripe-related code, even a small
refactor. Run before pushing to `v2`.

```bash
# Terminal 1: run the V2 server locally.
NODE_ENV=development npm start

# Terminal 2: forward live Stripe events to localhost.
stripe listen --forward-to localhost:3000/api/stripe-webhook

# The CLI prints a `whsec_...` signing secret; export it as
# STRIPE_WEBHOOK_SECRET in terminal 1 (and restart the server) so the
# local handler can verify the forwarded events.

# Terminal 3: trigger a test event.
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
stripe trigger customer.subscription.deleted
```

Watch terminal 1 logs. Each trigger should produce:

- `pino` request log for `POST /api/stripe-webhook`.
- A handler log line naming the event type.
- A Supabase write log line (the V2 logger logs DB writes at info
  level by default).

If any of those are missing, fix locally before letting the change
near the cutover runbook.

---

## When to run this in production

- **Mandatory:** step 8 of the cutover (per release-runbook.md).
- **Mandatory:** any deploy that touches `apps/server/index.js`,
  `apps/server/routes/billing.js`, or the `express.json` body parser
  configuration.
- **Recommended:** monthly, as a synthetic check that nothing has
  drifted. Pair with the operator's regular Sentry triage.
- **Recommended:** after rotating `STRIPE_WEBHOOK_SECRET`. The new
  secret has to be live on the Render env before the rotation is
  effective; this is the easy way to confirm.

---

## Cross-references

- [release-runbook.md](./release-runbook.md) §Cutover step 8 — the
  in-cutover invocation.
- [healthcheck.md](./healthcheck.md) — for `/api/health` 200 vs
  webhook 4xx triage.
- `docs/V2_AUDIT.md` §5.12 — original audit callout for raw-body
  capture as a hidden behaviour.
- `tests/regression/` — `stripe-webhook.spec.js` (RG-14, RG-44) is the
  CI-side equivalent of this manual procedure. Both should agree.
