// db/sessions/cutover-flag.js
// Owner: A3 | Slice: S16 (F17, Q1)
//
// Env-controlled READ_FROM_RELATIONAL flag — gates the F17 sessions cutover.
//
// During the V2 dual-write window (S16 → S24), `dualWriteState` ALWAYS writes
// to BOTH `user_state` (JSONB blob) AND `sessions` + `session_cards`
// (relational rows). The reader, however, prefers ONE side at a time:
//
//   READ_FROM_RELATIONAL=false (default through phase 4):
//     reader.js reads `user_state.state` directly. V1 behaviour preserved.
//     The relational tables are populated as a tripwire / parity-check
//     surface only.
//
//   READ_FROM_RELATIONAL=true (flipped at end of phase 4 by S24):
//     reader.js reads sessions + session_cards, reconstructs the V1 blob
//     shape, and falls back to user_state.state on empty/error so a bad
//     flip doesn't blank a user's history.
//
// The flip is operated as a Render env-var change — NO code change in S24.
// See docs/V2_ARCHITECTURE.md §4.1 step 4 ("dual-write inside V2") and
// docs/V2_ARCHITECTURE.md §5 row F17.
//
// V2.1 follow-ups (out of scope here, called out in db/schema.md §3):
//   - Drop `user_state.state` after one release of dual-write stability
//   - Decide where `currentSessionId` / `wantlist` / `v` live post-cutover
//     (a `user_settings` table is the leading candidate)

/**
 * Returns `true` when the relational tables should be the read source of
 * truth. Default `false` — the JSONB blob remains authoritative through
 * phase 4 of the V2 build.
 *
 * Cheap; safe to call per-request. Reads `process.env` each time so a
 * Render env-var update is picked up at the next request boundary without
 * a redeploy (Render restarts the process on env changes anyway, so this
 * is belt-and-braces).
 *
 * @returns {boolean}
 */
export function shouldReadFromRelational() {
  return process.env.READ_FROM_RELATIONAL === 'true';
}
