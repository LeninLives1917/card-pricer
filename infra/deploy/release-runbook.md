# Card-Pricer V2 — Release Runbook

**Owner:** A8 + orchestrator | **Slice:** S25 | **Companion docs:**
[healthcheck.md](./healthcheck.md), [stripe-webhook-smoke.md](./stripe-webhook-smoke.md),
[sessions-readflip-runbook.md](./sessions-readflip-runbook.md) (S24, may not yet be in tree).

---

## What this is + when to use it

This is the operator-facing checklist for the V2 cutover. It turns a "scary
big-bang merge of 6 weeks of work" into a sequence of low-risk, gated steps
with explicit rollback escape hatches.

The V2 cutover is **in-place** per `docs/V2_ARCHITECTURE.md` Q6:

- **Same Render service** (`card-pricer`, the live one at
  `card-pricer-60qq.onrender.com`).
- **Same Supabase project** (eu-west-1 Ireland).
- **Same Stripe account, same live mode keys.**
- **Same `data/card-db.json` on the persistent disk.**
- **Same `widget.js` URL** — `https://card-pricer-60qq.onrender.com/widget.js`
  serves V2 contents after cutover. V1 contents are preserved as
  `apps/widget/widget-v1.js` for rollback (Q4).

There is no preview environment. Safety comes from the runbook, not from
infrastructure. Read the whole document before starting.

**When to use it:**

1. All A7 regression tests are green on `v2`.
2. `docs/V2_SMOKE_TEST.md` walkthrough has been completed by the operator.
3. The Phase-5 review has signed off.

If any of those are not yet true, stop and fix that first.

---

## Pre-cutover (T-24h)

Walk this checklist **24 hours before** the planned cutover. If any item
fails, push the cutover back and re-run.

- [ ] **Regression suite green on `v2` branch.**
      `npm test` should report all suites passing. Current expected count
      is **≥194** test cases across `tests/regression/*.spec.js`. If more
      have landed by phase 5, adjust upward — never downward.
- [ ] **Smoke test walkthrough complete on local dev.** Follow
      `docs/V2_SMOKE_TEST.md` end-to-end on a local checkout of `v2`.
      Don't just read it. Run it.
- [ ] **All env vars in `infra/render.yaml` are set on the prod service.**
      The full list is **32 vars** (count includes runtime + feature flags).
      OPTIONAL ones may legitimately be unset; REQUIRED ones must not be.
      The REQUIRED set:

      ```
      ANTHROPIC_API_KEY
      SUPABASE_URL
      SUPABASE_SERVICE_ROLE_KEY
      STRIPE_SECRET_KEY              (production only — staging may run without)
      STRIPE_WEBHOOK_SECRET          (production only)
      NODE_ENV=production
      PORT=3000
      NODE_VERSION=20.10.0
      ```

      Everything else (Brevo, eBay, JustTCG, RapidAPI, Sentry DSNs, Stripe
      price IDs, OCR/sessions feature flags, TCGPlayer Pro, METRICS_TOKEN,
      etc.) is OPTIONAL — the app boots and serves traffic in degraded mode
      if they are absent. Confirm presence in the Render dashboard
      (Service → Environment); don't trust that "I set them last week".
- [ ] **Stripe live-mode test event replay confirmed on STAGE first.**
      See [stripe-webhook-smoke.md](./stripe-webhook-smoke.md). Use
      `stripe events resend <event_id>`. Confirm the staging webhook
      verifies the signature and the staging `profiles` row updates
      correctly. **Do not skip the staging step**, even though the runbook
      hits prod later — the staging replay catches any raw-body capture
      regression before it touches paying customers.
- [ ] **Tag `pre-v2-cutover` on `main` HEAD.**

      There is already an existing `v1-final` tag on commit `a7d4f21`
      (set during the prior rollback). Do **not** reuse it for the V2
      cutover rollback target — keep that tag pointing at its historical
      commit. Create a new tag specifically for the V2 cutover:

      ```
      git fetch origin
      git checkout main
      git tag pre-v2-cutover                    # tags current main HEAD
      git push origin pre-v2-cutover
      ```

      This is the rollback target if Path B (full revert to pre-cutover
      `main`) is ever invoked. Per the v2-prep commit message, this
      replaces the historical-`v1-final` approach.
- [ ] **Disable Render auto-deploy for the `card-pricer` service.**
      Render → Service → Settings → Build & Deploy → Auto-Deploy: OFF.
      Critical: if this is left ON, merging `v2 → main` and pushing will
      auto-trigger a deploy before you're ready to watch logs. With it
      OFF, the merge push is a no-op until you click Manual Deploy.
- [ ] **Reduce `/widget.js` `Cache-Control` to 60s on the live (V1) prod.**
      Edit `apps/server/routes/static.js` (the V2 file is what
      post-cutover will serve, but right now V1 root `server.js` is live —
      so the equivalent block in V1 is what matters; same change shape
      either way). Drop `max-age=300` → `max-age=60`. Deploy that single
      file as a separate commit to V1 first, **before** the V2 cutover.
      Wait at least 5 minutes after the deploy completes for old
      browser/CDN caches to expire. Without this, embed sites would keep
      serving cached V1 widget contents for up to 5 min after cutover —
      mixing V1 widget with V2 server is unsupported.
- [ ] **Sentry alerts armed.** `SENTRY_DSN_SERVER` and `SENTRY_DSN_BROWSER`
      both set on the prod env. Confirm by triggering a synthetic error
      on staging (`throw new Error('cutover-test')` from any route) and
      verifying it lands in the Sentry project. Resolve the synthetic
      event after.
- [ ] **On-call operator available for 2 hours post-cutover.** Block your
      calendar. Do not start a cutover with a 30-min meeting in 90 min.

---

## Cutover (T-0)

Each step has a **gate** — a checkpoint that determines whether to proceed
or roll back. Do not advance past a gate that's red.

### 1. Pre-deploy dry run on prod (still V1)

The point: prove V1 is healthy before replacing it. Cutting over a broken
V1 means rollback returns you to broken — bad outcome.

- Sign in to vendor app at `https://card-pricer-60qq.onrender.com/`. Scan
  one fixture card. See result. Log it.
- Open `https://card-pricer-60qq.onrender.com/quote?shop=brewed`. Paste 3
  lines from a known-good fixture. Submit the email gate.
- Open the live Board & Brewed embed (or whichever vendor's site you
  test against). Click the widget button. Complete the iframe flow.
- `curl https://card-pricer-60qq.onrender.com/api/health` → `status:"ok"`,
  V1 `apis` object shape.
- `curl https://card-pricer-60qq.onrender.com/api/version` → V1 git_sha
  (or `unknown` if V1 didn't have `/api/version` — that's also fine,
  just note it).

**Gate:** if any of those fail, **stop**. Fix V1. Do not cut over.

### 2. Merge `v2 → main`

From your local checkout:

```
git fetch origin
git checkout main
git pull --ff-only origin main         # confirm clean
git merge --no-ff v2 -m "v2: cutover"
```

Conflicts are not expected — `main` has been untouched since `1309ccd`,
and `v2` is built on top of it. If conflicts appear, abort
(`git merge --abort`) and investigate before retrying.

**Do not push yet.** Verify the merge commit's SHA with `git log -1`.
Note that SHA — you'll need it for rollback (Path A).

### 3. Confirm rollback tag is in place

```
git tag --verify pre-v2-cutover 2>/dev/null || git tag -l pre-v2-cutover
git rev-parse pre-v2-cutover           # should print the pre-merge main SHA
```

The pre-merge `main` SHA — i.e. the parent of the merge commit you just
made — is the rollback target for Path B. The tag should already exist
from the T-24h checklist.

### 4. Push the merge

```
git push origin main
```

Render auto-deploy is disabled (per T-24h checklist), so this push does
not trigger a deploy. It just gets the merge commit onto the remote so
the Render build can pull it on demand.

### 5. Manual deploy via Render dashboard

Render → Service `card-pricer` → Manual Deploy → "Deploy latest commit".
Watch the build log live.

Expected build phases (~3-5 min total):

- `npm install` (~45 s; new deps land on first V2 deploy: `pino`,
  `prom-client`, `@sentry/node`, `pino-pretty`).
- `node --check server.js` (instant — just a syntax check).
- `node server.js` start (instant; `/api/health` answers within seconds,
  card-DB hot-warm continues in the background).

**Gate:** if the build fails:

1. Click **Rollback** in the Render dashboard (this reverts the running
   service to the previous successful deploy — V1).
2. Investigate the build failure locally. Don't keep retrying through
   the Render UI; you'll burn build minutes and not learn anything.

### 6. Within 60 s of deploy completing — version + health

```
curl -sS https://card-pricer-60qq.onrender.com/api/version | jq .
curl -sS https://card-pricer-60qq.onrender.com/api/health  | jq .
```

Expect:

- `/api/version` returns the **new** `git_sha` (the merge commit's SHA
  from step 2). If it returns the V1 git_sha, the deploy didn't actually
  swap — go back to Render and confirm the deploy completed.
- `/api/health` returns `status:"ok"`. The V2 `apis` shape may differ
  slightly from V1 (V2 has more keys); both are healthy as long as
  the response is 200 with `status:"ok"`. See `healthcheck.md` for the
  detailed shape.

**Gate:** if either fails, see Rollback below.

### 7. Hot-path smoke (5 min)

Re-walk the same three flows from step 1 — but now against V2:

- **Vendor app:** sign in (Supabase JWT survives), scan one fixture card
  via `/api/identify-stream`, see result, log it. The result should
  match what V1 returned. Identify-pipeline behaviour is contract-locked
  (RG-08 / RG-09 / RG-11).
- **`/quote?shop=brewed`:** paste 3 lines, submit email gate. The
  bookmark URL feature (S12 quote persistence) should now appear
  alongside the V1 confirmation. The lead row should still land in
  Supabase `quote_leads`.
- **Widget:** open the live Board & Brewed embed. Click button.
  Complete iframe flow. The DOM should be **byte-identical** to V1
  when only V1 attributes are present (Q4 / RG-41 contract — A6 owns
  this guarantee). Telemetry beacon `POST /api/widget/loaded` should
  fire — confirm via Render logs.

**Gate:** if any of these fail, see Rollback.

### 8. Stripe webhook smoke

Cross-reference [stripe-webhook-smoke.md](./stripe-webhook-smoke.md)
for the full procedure. The short version:

```
stripe events list --limit 1                                         # find a recent real event id
stripe events resend <event_id> \
   --webhook-endpoint https://card-pricer-60qq.onrender.com/api/stripe-webhook
```

Then verify in Supabase that the `profiles` row for the affected
customer was updated correctly.

**Gate:** if signature verification fails (HTTP 400 from the webhook
endpoint), the raw-body capture is broken. Roll back. The
`express.json` `verify` callback in `apps/server/index.js` is the
likely regression — see audit §5.12 / RG-14.

### 9. Post-deploy housekeeping

These are not gating; do them once steps 1-8 are clean.

- **Restore `/widget.js` `Cache-Control` to 300 s.** Single-file commit
  to `apps/server/routes/static.js` (max-age 60 → 300). Deploy when
  comfortable — typically 30-60 minutes after cutover, once you're
  satisfied no widget regression has surfaced. The 60s window only
  needs to be long enough for the cutover deploy to complete plus a
  small grace.
- **Re-enable Render auto-deploy** in the service settings.
- **Update DEPLOY.md** (or replace it with a V2-aware version — see
  Open Questions at the bottom of this file).
- **Notify shop owners** via Brevo email or Slack: "Card-Pricer V2 is
  live. New features: [link to V2_RELEASE_NOTES.md]. If you see anything
  off, reply here within 24h."

---

## Post-cutover monitoring (T+0 to T+2h)

The 2-hour window after cutover is when regressions most often surface.
Operator stays at the keyboard.

- **Sentry:** watch the issues feed continuously. Any **new error
  signature** that wasn't present on V1 — triage immediately. New error
  groups within 2h are the strongest signal of a V2-introduced bug.
- **Render logs:** keep them streaming. Watch for `error level=error` /
  `pino` events tagged with new route paths. The pino logger lands JSON
  lines on stdout — Render captures them.
- **Synthetic checks every 10 min**:
  - `GET /api/health` (200 + `status:"ok"`)
  - `GET /api/version` (still the post-cutover git_sha)
  - One vendor scan (any fixture)
  - One `/quote` paste-and-submit
- **After 2h with no new error groups:** declare green in Slack/email
  to the team. Rollback window closes — beyond 2h, prefer forward-fix.

---

## Rollback

Two paths. Path A is preferred for almost every scenario; Path B is the
escape hatch when Path A's revert itself fails.

### Path A — single-commit revert (preferred)

Use this for: cutover went bad, you have the merge SHA, no destructive
schema changes have run.

```
git checkout main
git pull --ff-only origin main
git revert -m 1 <merge-commit-SHA>     # the SHA from cutover step 2
git push origin main
```

Then in Render: Manual Deploy → Deploy latest commit. Wait ~3 min.
Confirm `/api/version` returns the V1 git_sha.

### Path B — full rollback to `pre-v2-cutover` tag (escape hatch)

Use this only if Path A's revert produced a broken state and you need
to force `main` back to the exact pre-cutover commit. **Destructive —
operator must confirm.**

```
# Confirm the tag points where you expect:
git rev-parse pre-v2-cutover
# Force main back to the tag:
git push origin +pre-v2-cutover:main
```

Then in Render: Manual Deploy → Deploy latest commit. Confirm
`/api/version` returns the V1 git_sha.

### After either rollback path

- **Supabase migrations:** the V2 schema changes are **all additive**
  (new tables: `inventory_items`, `inventory_events`, `listings`,
  `customer_accounts`, `quote_offers`, `live_sessions`,
  `live_session_scans`, `card_prices`, `sessions`, `session_cards`;
  additive columns on existing tables). The V1 server doesn't read
  any of these. **No DB rollback is required.** The new tables sit
  idle.
- **Data in V2-only tables** (e.g. `quote_offers` rows created during
  the brief V2 window) stays in the database. If business reasons
  demand cleanup (typically: none — these are just inert rows), do
  it out-of-band, not as part of the rollback procedure.
- **Persistent disk files** (`data/card-db.json`,
  `data/card-prices.json`) are unchanged by V2 — V2 reads/writes the
  same paths as V1, just additionally writes prices to the
  `card_prices` Postgres table. Rollback ignores the table; V1
  reads `data/card-prices.json` as it always did.
- **Post-mortem within 24h.** Standard format: timeline, root cause,
  contributing factors, action items. File under `docs/postmortems/`.

---

## Permanent commit checklist (T+1 week)

After one stable week on V2, lock in the migration. These are the
"V2 is permanent now" cleanups:

- [ ] **Drop `apps/server/_card-db-boot.js`** if it's still in the tree
      (S10 / post-V2 absorbs its responsibilities into
      `db/card-db/persist.js`).
- [ ] **Drop `data/card-prices.json` from prod** — Postgres `card_prices`
      is primary (S10). The JSON file was kept as a tripwire for one
      release window; if it's still being written, that's a regression
      to investigate before deleting.
- [ ] **Trigger sessions read-flip** per
      [sessions-readflip-runbook.md](./sessions-readflip-runbook.md)
      (S24). Flip `READ_FROM_RELATIONAL` from `false` to `true`. Watch
      for 24-48 h. Once stable, schedule the
      `user_state.state` JSONB column drop migration.
- [ ] **Drop `user_state.state` column** in a follow-up migration once
      readflip has been stable for at least one week. This closes out
      F17 (sessions cutover).
- [ ] **Update CLAUDE.md, DEPLOY.md, SETUP.md** to reflect V2.
      DEPLOY.md in particular: V1 prose is now historical; either
      replace it with a thin pointer to this runbook, or rewrite it
      against V2 conventions. See Open Questions.
- [ ] **Drop `apps/widget/widget-v1.js`** after a full month of V2
      widget stability. Until then, keep it as a one-step rollback
      artefact (per Q4).

---

## Cross-references

- [healthcheck.md](./healthcheck.md) — what `/api/health` and
  `/api/version` should return; UptimeRobot setup; Render health probe
  behaviour.
- [stripe-webhook-smoke.md](./stripe-webhook-smoke.md) — the procedure
  step 8 references; expanded failure modes; local-test instructions.
- [sessions-readflip-runbook.md](./sessions-readflip-runbook.md) (S24)
  — separate, lower-stakes cutover for `READ_FROM_RELATIONAL`. Do
  **not** combine the V2 cutover with the readflip; one significant
  flag-flip per deploy window.
- `docs/V2_ARCHITECTURE.md` §6 (slice S25), §8 (Q1-Q6 decisions), §9
  (the skeleton this document expanded from).
- `docs/V2_SMOKE_TEST.md` — the dry-run walkthrough referenced in the
  T-24h checklist.

---

## Open questions for the operator (resolve before T-0)

1. **DEPLOY.md replace or augment?** The current DEPLOY.md is V1-shaped.
   Two options:
   - **Replace** with a thin pointer to this runbook + healthcheck.md.
     Cleaner; loses some V1-specific institutional knowledge.
   - **Augment**: keep V1 prose, add a "V2 cutover" section pointing
     here. Safer; risks DEPLOY.md becoming the canonical doc again
     and drifting out of sync.

   Recommendation: **replace**, in the post-cutover housekeeping step.
   Defer the rewrite to a follow-up commit if time-pressed at T-0.

2. **Should we Path-A revert proactively if any single hot-path smoke
   step (step 7) fails?** The runbook says yes — but a flaky third-party
   (e.g. eBay sold-comps timing out) could trigger a false rollback.
   Mitigation: when in doubt, rerun the step. If it fails twice in a
   row, treat as red. Document this judgement call in the post-mortem
   if invoked.
