# sessions-readflip-runbook.md — Flipping `READ_FROM_RELATIONAL` in production

**Owner:** A8 + A3 | **Slice:** S24 (F17, Q1) | **Last revised:** 2026-05-04

This runbook covers the ONE post-V2-cutover operation that meaningfully
changes the read path of `/api/state`: flipping the
`READ_FROM_RELATIONAL` env var on the Render service from `false`
(default through V2 ship) to `true` (relational read primary). The flip
is **invisible to the client** — both paths return the V1 blob shape —
but it is a real production read-path change. Treat it like a release.

Companion docs:

- `docs/V2_ARCHITECTURE.md` §4.1 (migration path) and §5 row F17.
- `db/schema.md` §3 `user_state` deprecation notes.
- `tests/regression/sessions-readflip.spec.js` — the parity suite that
  proves the two paths return identical content.
- `db/sessions/{cutover-flag,dual-write,reader}.js` — S16 deliverable
  this runbook flips against. **Don't modify** during the flip.

---

## 1. Why this is its own runbook

V2 ships with `READ_FROM_RELATIONAL=false` per the §9 release runbook.
The dual-writer (`db/sessions/dual-write.js`) is live the moment V2
ships — it writes BOTH the JSONB blob (`user_state.state`) AND the
relational rows (`sessions` + `session_cards`) on every PUT. Reads
stay on the JSONB blob until this runbook is executed.

That gap — V2 ship to readflip — is by design. It gives us a parity
window where:

1. The dual-writer accumulates relational rows for every active user.
2. We can compare relational vs JSONB content for any user via the
   parity spec without affecting the live read path.
3. If the dual-writer has any silent bug, we catch it before the
   relational path becomes authoritative.

`docs/V2_AUDIT.md` R2 (sessions persistence regression) flags this as
the highest-likelihood data-loss risk in V2. The mitigation IS this
two-step (dual-write window, then read-flip) plus the parity suite.

---

## 2. Prerequisites — all must be true before flipping

Tick every box. Don't shortcut.

- [ ] `dualWriteState` has been live in production for **at least one
      full release window** (recommended: 2–3 weeks). Confirm via
      `git log --oneline | grep "S16"` on `main` and the deploy date
      on Render → service → Events.
- [ ] `tests/regression/sessions-readflip.spec.js` passes on the
      build that's currently deployed. Run locally:
      `npm test 2>&1 | grep -E "sessions-readflip|^ℹ"`. All 23 tests
      green; no skipped tests; no `process.env.READ_FROM_RELATIONAL`
      leaks (each spec restores its prior value).
- [ ] **Backup of `user_state` taken.** Supabase has automated daily
      backups — verify in Supabase → Database → Backups that the
      most recent backup is **<24h old** AND covers `user_state`. If
      uncertain, take a manual point-in-time snapshot before flipping.
- [ ] **Synthetic test JWT in your password manager** for a vendor
      account that has at least 1 named session with at least 5
      logged cards. Store as `READFLIP_SMOKE_JWT` in 1Password
      alongside the operator email. Used to verify `/api/state`
      content shape unchanged after flip.
- [ ] **On-call operator available for 2 hours post-flip.** Sentry
      pager-mode armed. Render logs tab open in a browser pinned tab.
- [ ] Render service has **only one running instance** during the flip
      window (no rolling deploys mid-flip). Render Starter plan is
      single-instance by default — confirm the service config hasn't
      changed.

---

## 3. The flip — step-by-step

Total wall time: ~5 minutes plus the 2-hour monitoring window.

### 3.1 Render dashboard

1. Open https://dashboard.render.com → **card-pricer** (production
   service `card-pricer-60qq`).
2. Click **Environment** in the left nav.
3. Click **Edit** at the top of the env-var list.
4. **Add** (or **edit** if already present from a prior dry-run) the
   variable:
   - **Key**: `READ_FROM_RELATIONAL`
   - **Value**: `true` (lowercase, exact string — `cutover-flag.js`
     does a case-sensitive `=== 'true'` check)
5. Click **Save Changes**.
6. Render auto-deploys with the new env. Wall time ~2 minutes.

### 3.2 Confirm the deploy is live

Within 60 seconds of the deploy completing:

```bash
curl -s https://card-pricer-60qq.onrender.com/api/version | jq .
```

Expected: a fresh `git_sha` matching the latest commit on `main` and
an `uptime` < 120s. If `uptime` is much higher, the deploy didn't
restart the process — go back to Render → Events tab and confirm a
new deploy entry post-env-edit.

> **Note**: The `cutover-flag.js` reads `process.env` per-call, so a
> Render env-var change *would* be picked up at the next request
> boundary even without a redeploy — but Render restarts the process
> on every env-var change, so this is belt-and-braces.

### 3.3 Synthetic shape verification (within 5 min of flip)

Using the test JWT from §2 prereqs:

```bash
curl -s https://card-pricer-60qq.onrender.com/api/state \
  -H "Authorization: Bearer $READFLIP_SMOKE_JWT" \
  | jq 'keys, (.state.sessions | keys | length), .state.currentSessionId'
```

Expected:

- Top-level keys: `["state","updated_at"]`.
- `.state.sessions | keys | length`: matches the count from before
  the flip (sessions count cannot change across a read-path swap).
- `.state.currentSessionId`: still the pre-flip value (loose JSONB
  field, ride-along).

> **Known shape variance** (parity test §10 covers this): with the
> flip on, `state.sessions` is keyed by **deterministic UUIDs** rather
> than the V1 `sess_xxx` form. The client treats keys as opaque, so
> this is a non-issue for `apps/vendor` — but operators eyeballing
> the JSON should expect to see uuid-shaped session keys after the
> flip. The session content (name, log) is unchanged.

If the response shape regresses (extra keys, missing fields, sessions
disappear) — **roll back immediately** per §5. Do not investigate
live; restore the V1 path first, post-mortem after.

---

## 4. Monitoring — first 2 hours

### 4.1 Sentry

Filter: `release:cardpricer@<new-git-sha>`. Watch for:

- **New error groups** in `apps/server/routes/account.js` —
  particularly any thrown out of `readState`. The reader catches
  relational errors and falls through to JSONB, but a thrown error
  bubbles up and surfaces as `[STATE] get failed`.
- **Volume spike** in any existing `account.js` error group. Even if
  the group existed pre-flip, a > 2× volume change within 30 min of
  flipping is suspicious.
- New `[sessions/reader] relational read failed` log lines via
  Sentry breadcrumbs (these are `console.warn`s, not errors — they
  ride on the next surfaced exception or a manual breadcrumb scrape).

### 4.2 Render logs

Tail the live logs tab. Watch for:

- HTTP 500s on `GET /api/state` — V1 baseline is essentially zero.
  Any 500 within the first 30 min post-flip is a rollback signal.
- `[sessions/reader] relational read failed, falling back to JSONB`
  — these are non-fatal (the safety net engaged, JSONB returned),
  but a sustained rate (> 1 per minute) means the relational path
  is broken. The flip is delivering no value if the safety net is
  catching every request — roll back and investigate.

### 4.3 Synthetic — every 10 min for 2h

Re-run the §3.3 curl every 10 minutes. Flag any change in the keys
list, sessions count, or top-level shape.

### 4.4 User-state-table size sanity

In Supabase → SQL editor:

```sql
SELECT COUNT(*) AS total_users,
       COUNT(*) FILTER (WHERE state IS NOT NULL AND state != '{}'::jsonb) AS users_with_state
FROM user_state;
```

The flip changes the read path, NOT the write path — these counts
should be **identical** to a snapshot taken pre-flip. A spike (or
drop) would indicate writes are doing something unexpected — but
the dual-writer has been live for weeks at this point, so any
anomaly here is pre-existing.

---

## 5. Rollback — any time within 24h, ideally <2h

The rollback path is **trivially safe**. The JSONB blob has been
kept fully in sync by the dual-writer the whole time. Reverting the
read flag points reads back at the JSONB; nothing has been deleted
or migrated; no data shape has been re-encoded.

### 5.1 The flip-back

1. Render dashboard → service → Environment → Edit.
2. Set `READ_FROM_RELATIONAL` to `false` (or **delete the variable
   entirely** — `cutover-flag.js` defaults to `false` when unset).
3. **Save Changes**. Render auto-deploys with the env reverted.
4. Within 60s of deploy: `curl /api/version` to confirm a new
   `git_sha` with low `uptime`.
5. Within 5 min: re-run the §3.3 synthetic. Sessions key form
   reverts to `sess_xxx`. Content unchanged.

### 5.2 Why it's safe

- Dual-writer continues to write to BOTH JSONB and relational on
  every PUT. The relational rows accumulated during the flip-on
  window are still there — they just aren't being read.
- No destructive migration. The `user_state.state` column is
  untouched (the V2.1 column drop is a SEPARATE operation, not
  this one).
- No client-side state to clear. The vendor app and widget treat
  the response shape as opaque; whatever shape they got pre-flip
  they'll get post-rollback.

### 5.3 Post-rollback

Schedule a post-mortem within 24h. The S16 + S24 design assumed the
parity suite caught all divergences — if you had to roll back, the
suite missed something. File a sub-task to add a regression test
for the failure mode before re-attempting.

---

## 6. Permanent commit (V2.1 follow-up)

After **at least 1 week** of stable operation on the relational read
path:

1. **Drop the `user_state.state` column** in a separate migration
   (with rollback script). Schema change, NOT an env flip.
   - Migration: `supabase/migrations/<timestamp>_drop_user_state_jsonb.sql`
   - Sibling: `…_rollback.sql` (re-creates the column as `'{}'::jsonb` —
     data not recoverable from a drop, but the column shape is)
2. **Remove the JSONB-fallback branch** from `db/sessions/reader.js`.
   The relational path is the only path; the safety net goes away.
3. **Decide the home of the loose fields**. `currentSessionId`,
   `wantlist`, `v` currently ride along in `user_state.state` — if
   we drop the JSONB column we need a new home (a `user_settings`
   table is the leading candidate; see `db/schema.md` §3).
4. **Delete `db/sessions/cutover-flag.js`** (or leave for the next
   cutover — the next slice that needs an env-flip read-path swap
   can reuse the helper).

These are V2.1 cleanup items, NOT part of S24. Track in the V2.1
backlog.

---

## 7. Risks (per V2_AUDIT R2)

- **Highest-likelihood persistence regression in V2.** Mitigation:
  this runbook + parity suite + dual-write window.
- **Data loss if `dualWriteState` had a silent partial-failure
  during the dual-write window.** The dual-writer logs every
  per-row error and returns `relational_errors` in its result — but
  the route handler discards that count (only checks `result.ok`).
  The parity tests catch this BEFORE the flip by comparing
  reconstructed-relational shape to JSONB shape.
- **ID drift on `currentSessionId`** (S16 commit body open
  question). The relational reader uses the SHA1-derived UUID as
  the session-map key, but `currentSessionId` (a loose JSONB
  field) still references the V1 `sess_xxx` form. The client
  treats both as opaque, so this is benign for V2 — but worth
  noting in the V2.1 cleanup backlog.
- **No preview environment.** Q6 in-place deploy means the flip
  hits prod directly. Mitigation: parity suite + 2h watch + 5-min
  rollback.

---

## 8. Operator checklist (printable)

```
Pre-flip
[ ] Dual-write live ≥ 2 weeks
[ ] Parity suite green on current deploy
[ ] user_state backup ≤ 24h old
[ ] Test JWT in password manager
[ ] On-call available 2h
[ ] Single Render instance

Flip
[ ] Render env: READ_FROM_RELATIONAL=true
[ ] Save → auto-deploy
[ ] /api/version: fresh git_sha + uptime<120s
[ ] /api/state synthetic: shape unchanged

Monitor (T+0 to T+2h)
[ ] Sentry: no new account.js error groups
[ ] Render logs: zero /api/state 500s
[ ] Synthetic /api/state every 10 min
[ ] user_state row count unchanged

Rollback (if needed, within 24h)
[ ] Render env: READ_FROM_RELATIONAL=false (or unset)
[ ] /api/version: confirm restart
[ ] /api/state synthetic: V1 shape returns
[ ] Schedule post-mortem
```
