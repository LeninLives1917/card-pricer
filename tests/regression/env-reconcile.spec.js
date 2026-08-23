// Pins the blueprint-vs-process reconciliation.
//
// WHY THIS EXISTS
//
// render.yaml:180-181 declares PHASH_FAST_PATH: "off". The live process
// reports `shadow` — the code default for when the variable is UNSET
// (pricing/fast-path-mode.js:63). Verified on a brand-new instance, so it is
// not a stale-process artifact: the value is simply not in the Render
// environment. CARD_RECTIFY, declared four lines earlier in the same file,
// arrives correctly.
//
// So render.yaml is not the source of truth for what is deployed, and there
// was no way to know that without going and looking. That makes every "ships
// behind a flag, default off" commitment unverifiable — including
// LOCAL_MATCH_ENABLED, which CLAUDE.md's branch discipline is built around and
// which does not exist in the code at all.
//
// The fix is not to remember to check. It is to have the process check itself:
// render.yaml is committed, so it ships inside the deploy, and the app can
// compare what it was promised against what it got.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseBlueprintEnv,
  reconcileEnv,
  KNOWN_RUNTIME_ABSENT,
  KNOWN_VALUE_OVERRIDES,
} from '../../infra/observability/env-reconcile.js';
import { buildHealthPayload } from '../../apps/server/routes/health.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLUEPRINT = fs.readFileSync(join(REPO, 'render.yaml'), 'utf8');

const healthDeps = {
  db: async () => ({ ok: true, detail: 'stub' }),
  cardDb: () => ({ ready: true, count: 20546, lastDownload: Date.now() }),
};

describe('blueprint parsing', () => {
  test('parses every env var the real render.yaml declares', () => {
    const declared = parseBlueprintEnv(BLUEPRINT);
    // `grep -c '^      - key:' render.yaml` is 38. If the blueprint grows, this
    // number moves with it — the point is that the parser sees ALL of them,
    // because one it silently skips is one it can never report drift on.
    const grepped = BLUEPRINT.split(/\r?\n/).filter((l) => /^\s*-\s+key:/.test(l)).length;
    assert.equal(declared.length, grepped, 'parser must not skip a declared var');
    assert.ok(declared.length >= 30, 'sanity: the blueprint should declare a lot');
  });

  test('every var is classified as blueprint-managed or dashboard-managed', () => {
    const unclassified = parseBlueprintEnv(BLUEPRINT)
      .filter((d) => d.value == null && d.sync == null)
      .map((d) => d.key);
    // A var that is neither would be checked by nothing at all.
    assert.deepEqual(unclassified, []);
  });

  test('quotes are stripped so "off" compares against off', () => {
    const d = parseBlueprintEnv([
      'envVars:',
      '      - key: PHASH_FAST_PATH',
      '        value: "off"',
    ].join('\n'));
    assert.equal(d[0].value, 'off', 'a quoted blueprint value must not compare as \'"off"\'');
  });

  test('interleaved comments do not break the key/value pairing', () => {
    // render.yaml comments heavily BETWEEN a key and its value, which a naive
    // line parser gets wrong by pairing the key with the next thing it sees.
    const d = parseBlueprintEnv([
      '      - key: CARD_RECTIFY',
      '        # Off falls back to cropToCard, measured 1.0% top-1.',
      '        value: "1"',
    ].join('\n'));
    assert.equal(d[0].key, 'CARD_RECTIFY');
    assert.equal(d[0].value, '1');
  });
});

describe('reconciliation', () => {
  test('THE INCIDENT: a declared value the process never received', () => {
    const r = reconcileEnv({
      blueprint: '      - key: PHASH_FAST_PATH\n        value: "off"\n',
      env: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.drift.length, 1);
    assert.equal(r.drift[0].key, 'PHASH_FAST_PATH');
    assert.equal(r.drift[0].declared, 'off');
    assert.equal(r.drift[0].actual, null);
    assert.match(r.detail, /PHASH_FAST_PATH/);
  });

  test('a declared value the process received is not drift', () => {
    const r = reconcileEnv({
      blueprint: '      - key: CARD_RECTIFY\n        value: "1"\n',
      env: { CARD_RECTIFY: '1' },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.drift, []);
  });

  test('a value that differs is drift, and both sides are shown', () => {
    const r = reconcileEnv({
      blueprint: '      - key: LOG_LEVEL\n        value: "info"\n',
      env: { LOG_LEVEL: 'debug' },
    });
    assert.equal(r.drift[0].declared, 'info');
    assert.equal(r.drift[0].actual, 'debug');
  });

  test('a dashboard secret reports PRESENCE ONLY — never a value', () => {
    const r = reconcileEnv({
      blueprint: '      - key: ANTHROPIC_API_KEY\n        sync: false\n',
      env: { ANTHROPIC_API_KEY: 'sk-super-secret-value' },
    });
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes('sk-super-secret'), 'a secret value must never reach the payload');
    assert.deepEqual(r.missing, []);
  });

  test('a dashboard secret that was never set is reported by NAME only', () => {
    const r = reconcileEnv({
      blueprint: '      - key: BREVO_API_KEY\n        sync: false\n',
      env: {},
    });
    assert.deepEqual(r.missing, ['BREVO_API_KEY']);
    // Missing secrets do not set ok:false — plenty are genuinely optional and
    // the app documents degraded behaviour for them. Drift is the hard signal.
    assert.equal(r.ok, true);
  });

  test('an empty string counts as absent, not as set', () => {
    const r = reconcileEnv({
      blueprint: '      - key: BREVO_API_KEY\n        sync: false\n',
      env: { BREVO_API_KEY: '' },
    });
    assert.deepEqual(r.missing, ['BREVO_API_KEY']);
  });

  test('build-time-only vars are explained, not reported as drift', () => {
    const r = reconcileEnv({
      blueprint: '      - key: NODE_VERSION\n        value: "20.10.0"\n',
      env: {},
    });
    assert.deepEqual(r.drift, []);
    assert.deepEqual(r.explained, ['NODE_VERSION']);
  });

  test('a platform override is explained, not reported as drift', () => {
    // Render assigns the port and injects it; the blueprint value is advisory.
    const r = reconcileEnv({
      blueprint: '      - key: PORT\n        value: "3000"\n',
      env: { PORT: '10000' },
    });
    assert.deepEqual(r.drift, []);
    assert.deepEqual(r.explained, ['PORT']);
  });

  test('every exception names a var the blueprint actually declares', () => {
    const declared = new Set(parseBlueprintEnv(BLUEPRINT).map((d) => d.key));
    const stale = [...Object.keys(KNOWN_RUNTIME_ABSENT), ...Object.keys(KNOWN_VALUE_OVERRIDES)]
      .filter((k) => !declared.has(k));
    // An exception for a var nobody declares is a silencer with nothing to
    // silence — and the next person reads it as documentation.
    assert.deepEqual(stale, []);
  });

  test('every exception carries a non-empty reason', () => {
    for (const [k, why] of Object.entries({ ...KNOWN_RUNTIME_ABSENT, ...KNOWN_VALUE_OVERRIDES })) {
      assert.ok(why && why.length > 20, `${k} needs a real reason, not a placeholder`);
    }
  });

  test('an unreadable blueprint reports UNCHECKED, never "clean"', () => {
    const r = reconcileEnv({ blueprint: null, env: {} });
    assert.equal(r.readable, false);
    assert.equal(r.declared, 0);
    assert.match(r.detail, /UNCHECKED/);
    // This is the whole discipline: a check that degrades into a reassuring
    // "no drift" is worse than no check, because it still prints a green line.
    assert.doesNotMatch(r.detail, /no drift|all .* accounted/);
  });
});

describe('env_drift in /api/health', () => {
  test('the block is present and reads the real blueprint', async () => {
    const p = await buildHealthPayload({ ...healthDeps, env: {} });
    assert.ok(p.checks.env_drift, 'env_drift must be surfaced');
    assert.equal(p.checks.env_drift.readable, true,
      'render.yaml ships inside the deploy and must be readable from the process');
    assert.ok(p.checks.env_drift.declared >= 30);
  });

  test('drift is ADVISORY — it never marks the service degraded', async () => {
    // An empty env means every blueprint value is missing, so this is the
    // worst case the check can report.
    const p = await buildHealthPayload({ ...healthDeps, env: {} });
    assert.equal(p.checks.env_drift.ok, false, 'the finding must still be truthful');
    assert.ok(!p.degraded.includes('env_drift'),
      'drift is operational hygiene, not an outage. Degrading on it would make '
      + 'the external monitor fire every ten minutes until someone edits a '
      + 'dashboard, and an alarm that is always on is an alarm nobody reads.');
  });

  test('a clean environment reports clean', async () => {
    const declared = parseBlueprintEnv(BLUEPRINT);
    const env = {};
    for (const d of declared) {
      if (d.value != null) env[d.key] = d.value;
      else if (d.sync === false) env[d.key] = 'set';
    }
    const p = await buildHealthPayload({ ...healthDeps, env });
    assert.equal(p.checks.env_drift.ok, true, p.checks.env_drift.detail);
    assert.deepEqual(p.checks.env_drift.drift, []);
    assert.deepEqual(p.checks.env_drift.missing, []);
  });

  test('deps.blueprint is injectable, so this is testable without the file', async () => {
    const p = await buildHealthPayload({
      ...healthDeps,
      env: {},
      blueprint: () => '      - key: MADE_UP_FLAG\n        value: "yes"\n',
    });
    assert.equal(p.checks.env_drift.declared, 1);
    assert.equal(p.checks.env_drift.drift[0].key, 'MADE_UP_FLAG');
  });
});
