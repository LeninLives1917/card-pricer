// V2 test helpers — A7 / Slice S3
// Importable skeletons for the test suite. Real fixtures land in later slices
// (S6 pricing extraction, S15 OCR-first, S16 sessions cutover, etc.).
//
// Usage from a spec:
//   import { makeFakeSupabase, makeFakeAnthropic, mockFetch } from '../helpers/setup.js';
//
// All three are intentionally minimal: they expose the *shape* the production
// code depends on, with canned-data hooks for tests to override per-case.
// They do NOT hit the network. Tests that need richer behaviour extend these.

import { mock } from 'node:test';

/**
 * Build a fake @supabase/supabase-js client.
 *
 * The real client is method-chained (`from(...).select(...).eq(...).single()`).
 * We mirror that surface with a builder that always resolves whatever canned
 * payload the test seeds via `seed(table, response)`. Unseeded tables resolve
 * to `{ data: null, error: null }` so missing seeds don't crash the test —
 * the assertion will fail on the empty payload instead, which is easier to
 * debug than a `TypeError: Cannot read properties of undefined`.
 *
 * @param {Record<string, { data?: unknown, error?: unknown }>} seeds
 *   Map of table name → canned response. Override per-test.
 * @returns {{
 *   client: object,
 *   seed: (table: string, response: { data?: unknown, error?: unknown }) => void,
 *   calls: { from: string[], rpc: string[] }
 * }}
 */
export function makeFakeSupabase(seeds = {}) {
  const seeded = { ...seeds };
  const calls = { from: [], rpc: [] };

  const builder = (table) => {
    const response = seeded[table] ?? { data: null, error: null };
    // Every chainable method returns the same builder object so `.then` at the
    // end of any chain resolves to the canned response. This is the same trick
    // the supabase-js client uses internally (PostgrestBuilder is thenable).
    const chain = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      upsert: () => chain,
      delete: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      gt: () => chain,
      lt: () => chain,
      gte: () => chain,
      lte: () => chain,
      like: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      single: () => chain,
      maybeSingle: () => chain,
      then: (resolve) => Promise.resolve(response).then(resolve),
    };
    return chain;
  };

  const client = {
    from: (table) => {
      calls.from.push(table);
      return builder(table);
    },
    rpc: (fn, args) => {
      calls.rpc.push(fn);
      const response = seeded[`rpc:${fn}`] ?? { data: null, error: null };
      return Promise.resolve(response);
    },
    auth: {
      getSession: () => Promise.resolve({
        data: { session: seeded['auth:session']?.data ?? null },
        error: null,
      }),
      getUser: () => Promise.resolve({
        data: { user: seeded['auth:user']?.data ?? null },
        error: null,
      }),
    },
  };

  return {
    client,
    seed(table, response) {
      seeded[table] = response;
    },
    calls,
  };
}

/**
 * Build a fake @anthropic-ai/sdk client.
 *
 * Production code calls `anthropic.messages.create(...)`. We match that signature
 * and resolve to whatever the test queues via `queueResponse(payload)`. Calls
 * are recorded so tests can assert on the prompts sent (model name, token cap,
 * system prompt content, image attachments).
 *
 * @returns {{
 *   client: object,
 *   queueResponse: (payload: unknown) => void,
 *   calls: Array<{ args: unknown[] }>
 * }}
 */
export function makeFakeAnthropic() {
  const queue = [];
  const calls = [];

  const client = {
    messages: {
      create: (...args) => {
        calls.push({ args });
        const next = queue.shift();
        if (!next) {
          // Empty queue ⇒ return a benign empty response. Tests that care
          // about Anthropic output should always queue something first; if
          // they forget, the empty content will fail the assertion clearly.
          return Promise.resolve({
            id: 'msg_test_empty',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          });
        }
        return Promise.resolve(next);
      },
    },
  };

  return {
    client,
    queueResponse(payload) {
      queue.push(payload);
    },
    calls,
  };
}

/**
 * Install a mock for global `fetch` that matches request URLs against a route
 * map and returns canned Response objects. Use for stubbing /api/* responses
 * when the unit under test makes outgoing fetch calls.
 *
 * Returns an object with a `restore()` method — call it in the test's
 * `afterEach`/`after` hook so leaked fetch mocks don't bleed into other tests.
 *
 * @example
 *   const f = mockFetch({
 *     'GET /api/me': { status: 200, body: { plan: 'pro' } },
 *     'POST /api/identify': () => ({ status: 200, body: { cards: [] } }),
 *   });
 *   // ... run code ...
 *   assert.equal(f.calls.length, 1);
 *   f.restore();
 *
 * @param {Record<string, object | ((req: Request) => object)>} routes
 * @returns {{ calls: Array<{ method: string, url: string, body: unknown }>, restore: () => void }}
 */
export function mockFetch(routes = {}) {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET').toUpperCase();
    const body = init.body ?? null;
    calls.push({ method, url, body });

    const key = `${method} ${new URL(url, 'http://localhost').pathname}`;
    const handler = routes[key] ?? routes[`* ${new URL(url, 'http://localhost').pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'unmocked', key }), {
        status: 599,
        headers: { 'content-type': 'application/json' },
      });
    }

    const result = typeof handler === 'function' ? handler({ url, method, body }) : handler;
    const status = result.status ?? 200;
    const headers = result.headers ?? { 'content-type': 'application/json' };
    const responseBody = typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body ?? null);
    return new Response(responseBody, { status, headers });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// Re-export node:test's mock for convenience so spec files only import from
// one place.
export { mock };
