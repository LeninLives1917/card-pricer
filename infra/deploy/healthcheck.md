# Card-Pricer V2 — Health Check

**Owner:** A8 | **Slice:** S4 | **Companion:** [release-runbook.md](./release-runbook.md)

This document is the operator-readable spec for what "healthy" means in
production, what the existing endpoint returns, and how to wire third-party
uptime monitors against it.

---

## 1. The endpoint

**`GET /api/health`** — public, unauthenticated, no rate limit.

Lives at `apps/server/routes/health.js` in V2 (`server.js` line ~5100 in V1).
Render's `healthCheckPath` in [`infra/render.yaml`](../render.yaml) points at
this path; Render rolls back a deploy if `/api/health` returns a non-2xx
during boot.

### 1.1 Expected 200 response

```jsonc
{
  "status": "ok",
  "uptime": 12345.678,                 // seconds since process start
  "version": "1.0.0",                  // package.json version
  "git_sha": "ad87522",                // GIT_SHA env, or "unknown"
  "node": "v20.10.0",
  "card_db": {
    "ready": true,
    "loading": false,
    "count": 30421
  },
  "apis": {
    "anthropic": true,                 // ANTHROPIC_API_KEY present
    "supabase":  true,                 // SUPABASE_URL + SERVICE_ROLE_KEY present
    "stripe":    true,                 // STRIPE_SECRET_KEY present
    "ebay":      true,                 // EBAY_APP_ID + EBAY_CERT_ID present
    "rapidapi":  true,                 // RAPIDAPI_KEY present
    "justtcg":   true,                 // JUSTTCG_API_KEY present
    "brevo":     true                  // BREVO_API_KEY present
  }
}
```

A response with `status: "ok"` is **always 200**, even if some optional API
keys are absent — the app still boots and serves traffic in degraded mode
(e.g. eBay sold-comps disabled, Brevo emails skipped).

### 1.2 What "healthy" means

Render and external monitors should treat 200 as healthy if and only if:

- Process is up and Express is accepting connections.
- `card_db.ready` is `true` OR `card_db.loading` is `true`. (On first boot
  with an empty disk, `card_db.loading` is `true` for ~5 minutes while
  pokemontcg.io is re-pulled. Treat that as healthy — see §1.4 below.)
- The required API keys are present: `apis.anthropic` and `apis.supabase`
  must both be `true`. If either is `false`, the deploy is **misconfigured**
  even though the endpoint still returns 200 — flag in the deploy review.

### 1.3 Failure shapes

| Symptom | Likely cause | Action |
|---|---|---|
| Connection refused / socket hang up | Process crashed or hasn't bound `PORT` | Check Render logs for the bootstrap error |
| 503 from `/api/me`, `/api/identify` etc but `/api/health` 200 | Supabase env vars missing | Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| 200 but `card_db.count` < 1000 long after boot | `data/card-db.json` deleted, persistent disk not mounted, or pokemontcg.io pull failing | Verify `infra/render.yaml` disk block + check pokemontcg.io status |
| 200 but `apis.anthropic: false` | `ANTHROPIC_API_KEY` not synced to the Render env | Push the key in Render → Environment |
| Health 200 but identify returns 500s | Sonnet 4.6 model deprecated / over-quota | Check Anthropic console; possibly bump model in `pricing/identify-core.js` |

### 1.4 Boot timing

On a fresh deploy with an empty persistent disk:

1. `0–10s` — Express binds, `/api/health` returns 200 with `card_db.loading: true`.
2. `10s–5m` — pokemontcg.io is re-pulled in the background. `/api/health`
   continues to return 200; `card_db.count` climbs from 0 to ~30k.
3. `5m+` — `card_db.ready: true`, `card_db.loading: false`. Steady state.

**Don't alert on `count: 0` until at least 10 minutes after boot** to
avoid pages on every redeploy.

---

## 2. Render configuration

The relevant block in `infra/render.yaml`:

```yaml
healthCheckPath: /api/health
```

Render polls this path on the service's internal port every 5 seconds
during the deploy "live" phase. If three consecutive polls fail, Render
rolls the deploy back to the previous revision automatically.

**Implications:**

- A long boot (> ~5 min) with `/api/health` returning 200 is fine — Render
  only cares about the response code.
- A 500 from `/api/health` during boot rolls the deploy back. Don't be
  clever; the V1 endpoint never returns non-2xx.
- The persistent disk (`infra/render.yaml#disk`) is mounted before
  `startCommand` runs, so `data/card-db.json` is readable on the first
  health probe after a redeploy.

---

## 3. UptimeRobot (or equivalent external monitor)

> ### ⚠️ This section describes a monitor that has never been set up.
>
> **Incident, 15–23 August 2026.** The live instance ran for **8.4 days**
> with every Supabase request returning `401 Invalid API key`. Confirmed from
> Supabase's own edge logs: 48 `scan_events` writes and 6 `quote_leads`
> writes rejected in the final 15 minutes alone, and that is only the window
> log retention still covered. A redeploy on 23 August cleared it instantly
> with the same environment variables — the running process had gone bad and
> stayed bad. Nothing noticed, for over a week.
>
> `/api/health` had it right the whole time: `status: "degraded"`,
> `supabase: {ok: false}`. Nobody was reading it.
>
> **A status-code monitor would have shown green for all 8.4 days.** This
> endpoint returns **HTTP 200 even when degraded**, deliberately — see the
> comment at `apps/server/routes/health.js:186`: the vision fallback works
> without Supabase, so a degraded state must not make Render evict the
> instance. That design is right, and it means **the monitor MUST match on
> the response body**, never on the status code alone. The keyword row in
> §3.1 below is the load-bearing line in this document.
>
> What was lost: a `quote_leads` insert failure is caught, logged with
> `console.warn`, and the request continues (`routes/quote-lead.js:182-189`).
> The customer still receives their Brevo email — but there is no lead row,
> and `buildQuoteUrl(null)` returns null, so they get no recovery link and the
> shop keeps no record. It degrades gracefully into losing the commercial
> record, which is the worst shape a failure can take here.

Card-Pricer ran on Render free tier in V1, which sleeps after 15 minutes
of inactivity; UptimeRobot was used to ping `/api/health` every 5 minutes
to keep the dyno warm. **V2 is on Render Starter (Q2) — always-on — so the
keep-alive function is no longer required.** External monitoring is still
worthwhile for:

- Independent verification that Render's own health check isn't lying.
- Alerting via SMS / email when Render is itself broken.
- Catching exactly the failure above: a process that is up, serving, and
  returning 200 while every database write fails.
- SLO reporting from a third-party perspective.

### 3.1 Recommended UptimeRobot setup

| Field | Value |
|---|---|
| Monitor type | **Keyword** — not HTTP(s). An HTTP(s) monitor checks the status code, which is always 200 here. |
| URL | `https://card-pricer-60qq.onrender.com/api/health` |
| Keyword | `"status":"ok"` — exactly this, including the quotes and no space after the colon |
| Alert when | **keyword NOT found** |
| Interval | 5 minutes |
| Alert contacts | operator email + SMS |
| Alert when down for | 2 consecutive checks (10 minutes) |

Setting it to a plain HTTP(s) monitor is the one configuration mistake that
reproduces the August incident exactly: green for 8.4 days while every write
failed. If the service being used has no keyword option, use one that does.

A second monitor worth adding, since it costs nothing on the same free tier:

| Field | Value |
|---|---|
| Monitor type | Keyword |
| URL | `https://card-pricer-60qq.onrender.com/api/version` |
| Keyword | the current deployed `git_sha` |
| Alert when | keyword NOT found |

That answers "is the build I think is live actually live?" without asking
anyone to remember to check. It also catches a rollback nobody announced.

### 3.2 Alternatives

- **Better Uptime / BetterStack** — same shape, nicer UI, supports
  `/api/version` git SHA scraping for "is the right build live?" alerts.
- **Sentry Cron Monitor** — fires when the cron (e.g. card-DB refresh
  job) fails to check in. Useful, but separate from HTTP health.
- **Render-native alerts** — Render emits build/deploy/crash alerts for
  free; configure recipients in the service Settings tab.

---

## 4. Sister endpoint: `/api/version`

Per docs/V2_ARCHITECTURE.md §2.5, V2 adds a new public endpoint:

```jsonc
GET /api/version
{
  "git_sha":  "ad87522",            // GIT_SHA env, set by Render build hook
  "built_at": "2026-05-04T12:34:56Z",
  "node_version": "v20.10.0",
  "uptime": 12345.678
}
```

The release runbook ([release-runbook.md](./release-runbook.md) §Cutover
step 4) hits `/api/version` after every deploy to confirm the new build
is live. Pair an UptimeRobot keyword check on this endpoint with the
expected git SHA to catch "deploy succeeded but old image still serving"
edge cases.

---

## 5. What changed from V1

- `infra/render.yaml` adds `healthCheckPath: /api/health` (V1 had no
  healthCheckPath declared — Render fell back to a TCP-level check).
- `/api/health` response gains `git_sha`, `node`, and `card_db.count`
  fields. The V1 `status`, `uptime`, `version`, and `apis` fields are
  preserved verbatim (V2_ARCHITECTURE §2 contract: no shape regressions).
- Persistent disk (Q2) means `card_db.count` should never drop to zero
  after the first successful boot. If it does, the disk is misconfigured
  or got wiped manually.
