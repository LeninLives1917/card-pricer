// Regression: there was no way to reset a forgotten password (9 Oct 2026).
//
// Liam (Ireland Card Show) forgot his password the evening he signed up, and
// neither the scanner app's log-in box nor the show desk offered a reset.
// Pinned here:
//   - GET /reset-password serves the reset page, no-store (it handles a
//     one-time token);
//   - the scanner app and the show desk both link to it;
//   - a reset link that lands on the site ROOT (Supabase's fallback when
//     /reset-password is not on its redirect list) is handed to the reset page
//     BEFORE the Supabase client consumes the token. Without that the person
//     is silently logged in and never gets to set a password: the link
//     "works" and the password is still forgotten.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { earlyStatic } from '../../apps/server/routes/static.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(join(ROOT, p), 'utf8');

test('GET /reset-password serves the reset page, not cached', async () => {
  const app = express();
  app.use(earlyStatic);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/reset-password?email=a%40b.ie`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /resetPasswordForEmail\(email, \{ redirectTo: location\.origin \+ '\/reset-password' \}\)/);
    assert.match(html, /updateUser\(\{ password: a \}\)/);
    assert.match(html, /PASSWORD_RECOVERY/);
  } finally { server.close(); }
});

test('the scanner app and the show desk both link to it', () => {
  assert.match(read('apps/vendor/index.html'), /<a href="\/reset-password" id="authForgot"/);
  assert.match(read('apps/show/staff.html'), /id="forgotLink" href="\/reset-password"/);
});

test('a reset link landing on the site root is handed to the reset page before the client reads it', () => {
  const html = read('apps/vendor/index.html');
  const handoffAt = html.indexOf('type=recovery');
  const clientAt = html.indexOf('supabase-js@2');
  assert.ok(handoffAt > 0 && handoffAt < clientAt, 'the handoff must run before supabase-js loads');

  const script = html.slice(html.lastIndexOf('<script>', handoffAt) + 8, html.indexOf('</script>', handoffAt));
  const run = (hash, search = '') => {
    const calls = [];
    vm.runInNewContext(script, { location: { hash, search, replace: (u) => calls.push(u) } });
    return calls;
  };
  assert.deepEqual(run('#access_token=x&expires_in=3600&type=recovery'), ['/reset-password#access_token=x&expires_in=3600&type=recovery']);
  assert.deepEqual(run('#type=recovery&access_token=x'), ['/reset-password#type=recovery&access_token=x']);
  assert.deepEqual(run('#access_token=x&type=signup'), [], 'a sign-up confirmation still logs straight in');
  assert.deepEqual(run(''), []);
});
