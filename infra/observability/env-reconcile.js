// infra/observability/env-reconcile.js
//
// Does the running process actually have the environment render.yaml says it
// has?
//
// WHY THIS EXISTS
//
// render.yaml:180-181 declares PHASH_FAST_PATH: "off". The live process
// reports `shadow` — the code default for when the variable is UNSET
// (pricing/fast-path-mode.js:63). Verified on a brand-new instance, so it is
// not a stale-process artifact: that value is simply not in the Render
// environment. Meanwhile CARD_RECTIFY, declared four lines earlier in the same
// file, arrives correctly.
//
// So the blueprint is not the source of truth for what is deployed, and there
// was no way to know that without going and looking. Which makes every
// "we ship it behind a flag, default off" promise unverifiable — including
// LOCAL_MATCH_ENABLED, the kill switch CLAUDE.md's branch discipline is built
// around, which does not exist in the code at all.
//
// This module closes that by having the process reconcile itself. render.yaml
// is committed, so it ships inside the deploy: the app can read what it was
// PROMISED and compare it against what it GOT.
//
// TWO CLASSES, CHECKED DIFFERENTLY
//
//   value: "off"    blueprint-managed. The process must see that exact string.
//                   A mismatch is drift and is the PHASH_FAST_PATH case.
//   sync: false     dashboard-managed secret. The blueprint deliberately does
//                   not carry the value, so only presence can be checked.
//                   Absence means "declared as needed, never set".
//
// NO SECRET VALUE IS EVER RETURNED. Blueprint-managed values are already
// public in the repo, so declared-vs-actual is safe to show for those.
// Everything under `sync: false` reports presence only.

/**
 * Vars that are legitimately absent from the RUNTIME environment, with the
 * reason. Same mechanism as KNOWN_ALIAS_EXCEPTIONS in
 * tests/regression/set-alias-reconcile.spec.js: an unexplained absence is a
 * defect by default, and silencing one costs you a written reason that has to
 * be true.
 */
/**
 * Vars where the PLATFORM legitimately supplies a different value than the
 * blueprint declares. Reported as explained rather than as drift, with the
 * reason — an unexplained mismatch stays a defect.
 */
export const KNOWN_VALUE_OVERRIDES = {
  PORT: 'Render assigns the port and injects it; the blueprint value is '
    + 'advisory and is ignored at runtime by design.',
};

export const KNOWN_RUNTIME_ABSENT = {
  NODE_VERSION: 'build-time only — Render uses it to select the Node image, '
    + 'it is not injected into the running process.',
  BUILT_AT: 'set at build time if at all; /api/version reports null for it '
    + 'today and that is accurate rather than broken.',
  GIT_SHA: 'Render supplies RENDER_GIT_COMMIT instead; apps/server/routes/'
    + 'health.js reads whichever is present.',
};

/**
 * Minimal parser for the envVars block of a Render blueprint.
 *
 * Deliberately line-based rather than a YAML dependency: this file has no
 * deps for the same reason as the other observability modules, and the shape
 * it parses is fixed and simple. It handles exactly what render.yaml uses —
 * `- key:` followed by `value:` or `sync:` — and IGNORES anything else, which
 * is stated here so nobody assumes it is a general YAML parser.
 *
 * @param {string} text  contents of render.yaml
 * @returns {Array<{key: string, value: string|null, sync: boolean|null}>}
 */
export function parseBlueprintEnv(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let cur = null;

  const push = () => { if (cur) out.push(cur); cur = null; };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const keyMatch = line.match(/^\s*-\s+key:\s*(\S+)\s*$/);
    if (keyMatch) {
      push();
      cur = { key: keyMatch[1], value: null, sync: null };
      continue;
    }
    if (!cur) continue;

    const valMatch = line.match(/^\s*value:\s*(.*)$/);
    if (valMatch) {
      let v = valMatch[1].trim();
      // Strip one layer of surrounding quotes, which is how the file writes
      // "1" and "off". A bare value is taken as-is.
      const q = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
      cur.value = q ? q[1] : v;
      continue;
    }
    const syncMatch = line.match(/^\s*sync:\s*(true|false)\s*$/);
    if (syncMatch) {
      cur.sync = syncMatch[1] === 'true';
      continue;
    }
    // A blank line or a new top-level key ends the entry. Comments do not —
    // render.yaml interleaves them heavily between key and value.
    if (/^\s*$/.test(line)) push();
  }
  push();
  return out;
}

/**
 * @param {{blueprint?: string, env?: object}} [opts]
 *   blueprint — contents of render.yaml. Omit and the result says so rather
 *   than quietly reporting "no drift", which would be the same invisible
 *   fallback this module exists to catch.
 * @returns {{ok, readable, declared, drift, missing, explained, detail}}
 */
export function reconcileEnv({ blueprint = null, env = process.env } = {}) {
  if (blueprint == null) {
    return {
      ok: true,
      readable: false,
      declared: 0,
      drift: [],
      missing: [],
      explained: [],
      detail: 'render.yaml not readable from this process — environment drift '
        + 'is UNCHECKED, not verified clean',
    };
  }

  const declared = parseBlueprintEnv(blueprint);
  const drift = [];
  const missing = [];
  const explained = [];

  for (const d of declared) {
    const actual = env[d.key];
    const present = actual != null && String(actual) !== '';

    if (!present && d.key in KNOWN_RUNTIME_ABSENT) {
      explained.push({ key: d.key, why: KNOWN_RUNTIME_ABSENT[d.key] });
      continue;
    }

    if (d.value != null) {
      // Blueprint-managed: the declared value is public, so showing both
      // sides is safe and is the only way the message is actionable.
      if (!present) {
        drift.push({ key: d.key, declared: d.value, actual: null,
          why: 'declared in render.yaml but the process does not see it' });
      } else if (String(actual) !== d.value) {
        if (d.key in KNOWN_VALUE_OVERRIDES) {
          explained.push({ key: d.key, why: KNOWN_VALUE_OVERRIDES[d.key] });
        } else {
          drift.push({ key: d.key, declared: d.value, actual: String(actual),
            why: 'process value differs from the blueprint' });
        }
      }
      continue;
    }

    if (d.sync === false && !present) {
      // Presence only — never the value, and never a hint of it.
      missing.push(d.key);
    }
  }

  const parts = [];
  if (drift.length) {
    parts.push(`${drift.length} blueprint value(s) NOT in the process: `
      + drift.map((x) => `${x.key} (declared ${JSON.stringify(x.declared)}, `
        + `actual ${x.actual == null ? 'unset' : JSON.stringify(x.actual)})`).join(', '));
  }
  if (missing.length) {
    parts.push(`${missing.length} dashboard secret(s) declared but unset: ${missing.join(', ')}`);
  }
  if (!parts.length) {
    parts.push(`all ${declared.length} declared var(s) accounted for`
      + (explained.length ? ` (${explained.length} legitimately build-time only)` : ''));
  }

  return {
    ok: drift.length === 0,
    readable: true,
    declared: declared.length,
    drift,
    missing,
    explained: explained.map((e) => e.key),
    detail: parts.join('; '),
  };
}
