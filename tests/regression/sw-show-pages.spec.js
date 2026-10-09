// Regression: the scanner app's service worker served the show-mode pages
// stale (9 Oct 2026).
//
// apps/vendor/service-worker.js is registered at '/', so its scope covers
// /show/:slug too. Anything that was not the shell or a module fell through to
// stale-while-revalidate, so a vendor who had ever opened the scanner app got
// the CACHED show desk on the first load after a deploy. Liam (Ireland Card
// Show) reported "the app still looks the same" after the show-mode restyle
// had gone live. Show pages are served no-store and must never be intercepted.
//
// The worker is run for real in a vm with fake caches and fetch, so this
// checks behaviour, not the source text.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(join(ROOT, 'apps/vendor/service-worker.js'), 'utf8');

function loadWorker({ cached = {} } = {}) {
  const listeners = {};
  const store = new Map(Object.entries(cached));
  const fetched = [];
  const cache = {
    match: async (req) => store.get(typeof req === 'string' ? req : new URL(req.url).pathname) || undefined,
    put: async (req, resp) => { store.set(new URL(req.url).pathname, resp); },
    addAll: async () => {},
  };
  const self = {
    location: { origin: 'https://card-pricer.test' },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  const ctx = {
    self, URL, console,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: cache.match },
    fetch: async (req) => { fetched.push(new URL(req.url).pathname); return { ok: true, body: 'NETWORK', clone() { return this; } }; },
  };
  vm.runInNewContext(SRC, ctx);
  return { listeners, fetched };
}

async function dispatch(w, path) {
  let responded = null;
  const event = {
    request: { method: 'GET', url: `https://card-pricer.test${path}`, mode: 'navigate' },
    respondWith: (p) => { responded = p; },
  };
  w.listeners.fetch(event);
  return responded ? await responded : null;
}

test('show-mode pages are never answered from the cache', async () => {
  const stale = { body: 'OLD SHOW DESK', ok: true, clone() { return this; } };
  for (const path of ['/show/irelandcardshow', '/show/irelandcardshow/staff', '/show/brewed/poster']) {
    const w = loadWorker({ cached: { [path]: stale } });
    const r = await dispatch(w, path);
    assert.equal(r, null, `${path} must pass straight through to the network (not intercepted)`);
  }
});

test('the scanner app is still served by the worker (shell network-first)', async () => {
  const w = loadWorker();
  const r = await dispatch(w, '/');
  assert.equal(r?.body, 'NETWORK');
  assert.deepEqual(w.fetched, ['/']);
});
