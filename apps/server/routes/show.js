// apps/server/routes/show.js
//
// SHOW MODE: the trade-show version of the customer quote (9 Oct 2026).
//
// A customer scans the QR on the stand, types their name and their cards on
// their own phone, and gets a ticket number and "head to the counter". They
// never see a price. The list is matched and priced HERE, server side, with
// the same whole-list quote the website uses (handleQuoteBatch, called
// directly: no HTTP hop and no per-IP rate limit). Staff see the priced list on
// /show/:slug/staff, set the condition of each card in hand, settle any
// "which one is it?" questions, and make the offer in person.
//
//   GET   /show/:slug                         customer page (apps/show/index.html)
//   GET   /show/:slug/staff                   staff board   (apps/show/staff.html)
//   GET   /show/:slug/poster                  printable QR poster
//   POST  /api/show/:slug/submit              customer list -> ticket (no prices)
//   GET   /api/show/ticket/:token             the customer's ticket again (no prices)
//   GET   /api/show/:slug/staff/list          staff: submissions with totals
//   GET   /api/show/:slug/staff/item/:id      staff: one submission, every line priced
//   PATCH /api/show/:slug/staff/item/:id      staff: picks, conditions, done/reopen
//   POST  /api/show/:slug/staff/item/:id/reprice
//
// Staff are the shop's owner (shops.owner_user_id) or an admin, signed in with
// the same account as the scanner app. Submissions live in show_submissions
// (RLS on, no policies: service role only).
//
// Every submission saved WITHOUT prices is counted (infra/observability/
// show-counters.js -> /api/health show), because the customer is sent to the
// counter either way and nothing on their side would reveal it.
//
// DI throughout: handleShowSubmit(body, req, deps) etc. No mock.module().

import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { supabase } from '../_clients.js';
import { requireAuth } from '../middleware/auth.js';
import { showSubmitLimiter } from '../middleware/rate-limit.js';
import { SHOP_SLUG_RE, EMAIL_RE } from './shop.js';
import { handleQuoteBatch } from './quote-batch.js';
import {
  showLinesOf, staffEntries, staffTotals, customerView, ratesOf,
  cleanPicks, cleanConditions, SHOW_MAX_NAME,
} from '../../../pricing/show/offer.js';
import {
  countSubmitted, countRepriced, countSaveFailed, countStaffUpdate,
} from '../../../infra/observability/show-counters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOW_APP_DIR = join(__dirname, '..', '..', 'show');
const UUID_RE = /^[0-9a-f-]{36}$/i;
const TOKEN_RE = /^[0-9a-f]{32}$/;

function hashIp(ip) {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.IP_HASH_SALT || 'card-pricer-default-salt';
  return crypto.createHash('sha256').update(`${ip}|${day}|${salt}`).digest('hex').slice(0, 32);
}

const slugOf = (s) => {
  const slug = String(s || '').toLowerCase();
  return SHOP_SLUG_RE.test(slug) && slug.length <= 40 ? slug : null;
};

async function shopBySlug(db, slug) {
  const { data, error } = await db
    .from('shops')
    .select('id, slug, name, owner_user_id, cash_pct, credit_pct, active')
    .eq('slug', slug).eq('active', true).maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Price a list with the website's whole-list quote. Never throws: a failure
 * comes back as { rows: null, error } and is stored and counted.
 */
async function priceLines(lines, quote) {
  try {
    const r = await quote({ lines, game: 'pokemon' });
    if (r.status === 200 && Array.isArray(r.body?.rows)) {
      return { rows: r.body.rows, pricesAsOf: r.body.prices_as_of ?? null, error: null };
    }
    return { rows: null, pricesAsOf: null, error: r.body?.error || `quote returned ${r.status}` };
  } catch (e) {
    return { rows: null, pricesAsOf: null, error: e?.message || 'quote failed' };
  }
}

/** POST /api/show/:slug/submit — the customer's list. Returns NO prices. */
export async function handleShowSubmit(slugParam, body, req, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const quote = deps.quote ?? handleQuoteBatch;
  const makeToken = deps.makeToken ?? (() => crypto.randomBytes(16).toString('hex'));
  if (!db) return { status: 503, body: { error: 'Not available right now. Please ask at the counter.' } };

  const slug = slugOf(slugParam);
  if (!slug) return { status: 404, body: { error: 'shop not found' } };

  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, SHOW_MAX_NAME);
  if (!name) return { status: 400, body: { error: 'Please add your first name so we can find you at the counter.' } };
  const lines = showLinesOf(body?.lines);
  if (!lines.length) return { status: 400, body: { error: 'Add at least one card, e.g. Charizard 4/102.' } };
  const email = String(body?.email ?? '').trim().slice(0, 254);
  if (email && !EMAIL_RE.test(email)) return { status: 400, body: { error: 'That email address doesn’t look right.' } };

  let shop;
  try { shop = await shopBySlug(db, slug); } catch { return { status: 500, body: { error: 'Something went wrong. Please ask at the counter.' } }; }
  if (!shop) return { status: 404, body: { error: 'shop not found' } };

  const priced = await priceLines(lines, quote);
  const token = makeToken();
  const { data, error } = await db.from('show_submissions').insert({
    token,
    shop_id: shop.id,
    shop_slug: slug,
    name,
    email: email || null,
    newsletter: !!(email && body?.newsletter),
    lines,
    rows: priced.rows,
    prices_as_of: priced.pricesAsOf,
    priced_at: priced.rows ? new Date().toISOString() : null,
    price_error: priced.error,
    ip_hash: hashIp(req?.ip),
  }).select('ticket, token, name, created_at').single();
  if (error || !data) {
    countSaveFailed();
    return { status: 500, body: { error: 'We couldn’t save your list. Please try again, or ask at the counter.' } };
  }
  countSubmitted({ priced: !!priced.rows, reason: priced.error ? 'quote_failed' : null });

  return {
    status: 200,
    body: {
      ticket: data.ticket,
      token: data.token,
      name: data.name,
      shop_name: shop.name,
      created_at: data.created_at,
      lines: priced.rows ? customerView(priced.rows) : lines.map((line) => ({ line, qty: 1, status: 'check', card: null })),
    },
  };
}

/** GET /api/show/ticket/:token — the customer's own ticket. NO prices. */
export async function handleShowTicket(token, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  if (!db) return { status: 503, body: { error: 'unavailable' } };
  if (!TOKEN_RE.test(String(token || ''))) return { status: 404, body: { error: 'not found' } };
  const { data } = await db.from('show_submissions')
    .select('ticket, name, status, created_at, lines, rows, shop_slug')
    .eq('token', token).maybeSingle();
  if (!data) return { status: 404, body: { error: 'not found' } };
  return {
    status: 200,
    body: {
      ticket: data.ticket,
      name: data.name,
      status: data.status,
      created_at: data.created_at,
      lines: data.rows ? customerView(data.rows) : (data.lines || []).map((line) => ({ line, qty: 1, status: 'check', card: null })),
    },
  };
}

/** One submission as staff see it. */
export function staffItem(sub, shop) {
  const rates = ratesOf(shop);
  const entries = sub.rows ? staffEntries(sub.rows, { picks: sub.picks || {}, conditions: sub.conditions || {}, rates }) : [];
  return {
    id: sub.id,
    ticket: sub.ticket,
    name: sub.name,
    email: sub.email,
    newsletter: sub.newsletter,
    status: sub.status,
    outcome: sub.outcome,
    created_at: sub.created_at,
    done_at: sub.done_at,
    prices_as_of: sub.prices_as_of,
    price_error: sub.rows ? null : (sub.price_error || 'not priced'),
    line_count: (sub.lines || []).length,
    rates,
    totals: staffTotals(entries),
    entries,
  };
}

/** Staff may see a shop's submissions: its owner, or an admin. */
export async function staffShop(slugParam, user, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const slug = slugOf(slugParam);
  if (!slug || !user) return { error: { status: 404, body: { error: 'shop not found' } } };
  const shop = await shopBySlug(db, slug);
  if (!shop) return { error: { status: 404, body: { error: 'shop not found' } } };
  if (shop.owner_user_id !== user.id) {
    const { data: p } = await db.from('profiles').select('is_admin').eq('user_id', user.id).maybeSingle();
    if (!p?.is_admin) return { error: { status: 403, body: { error: 'This account is not staff for this shop.' } } };
  }
  return { shop };
}

const STAFF_COLS = 'id, ticket, name, email, newsletter, status, outcome, created_at, done_at, prices_as_of, price_error, lines, rows, picks, conditions';

export async function handleStaffList(slugParam, query, user, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const { shop, error } = await staffShop(slugParam, user, deps);
  if (error) return error;
  const status = query?.status === 'done' ? 'done' : 'waiting';
  const { data, error: qErr } = await db.from('show_submissions').select(STAFF_COLS)
    .eq('shop_id', shop.id).eq('status', status)
    .order('created_at', { ascending: status === 'waiting' ? true : false })
    .limit(200);
  if (qErr) return { status: 500, body: { error: 'list failed' } };
  const { count: waiting } = await db.from('show_submissions')
    .select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('status', 'waiting');
  const items = (data || []).map((s) => {
    const it = staffItem(s, shop);
    delete it.entries;
    return it;
  });
  return { status: 200, body: { shop: { slug: shop.slug, name: shop.name }, status, waiting: waiting ?? null, items } };
}

async function loadSub(db, shop, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { data } = await db.from('show_submissions').select(STAFF_COLS)
    .eq('id', id).eq('shop_id', shop.id).maybeSingle();
  return data || null;
}

export async function handleStaffItem(slugParam, id, user, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const { shop, error } = await staffShop(slugParam, user, deps);
  if (error) return error;
  const sub = await loadSub(db, shop, id);
  if (!sub) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: staffItem(sub, shop) };
}

/** PATCH: picks / conditions merge (null removes one); status done | waiting. */
export async function handleStaffUpdate(slugParam, id, body, user, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const { shop, error } = await staffShop(slugParam, user, deps);
  if (error) return error;
  const sub = await loadSub(db, shop, id);
  if (!sub) return { status: 404, body: { error: 'not found' } };

  const patch = {};
  if (body?.picks && typeof body.picks === 'object') {
    const next = { ...(sub.picks || {}) };
    for (const [k, v] of Object.entries(body.picks)) if (v === null) delete next[k];
    Object.assign(next, cleanPicks(body.picks, sub.rows));
    patch.picks = next;
  }
  if (body?.conditions && typeof body.conditions === 'object') {
    const next = { ...(sub.conditions || {}) };
    for (const [k, v] of Object.entries(body.conditions)) if (v === null) delete next[k];
    Object.assign(next, cleanConditions(body.conditions, sub.rows));
    patch.conditions = next;
  }
  if (body?.status === 'done') {
    patch.status = 'done';
    patch.done_at = new Date().toISOString();
    patch.outcome = ['bought', 'declined', 'other'].includes(body.outcome) ? body.outcome : 'other';
  } else if (body?.status === 'waiting') {
    patch.status = 'waiting';
    patch.done_at = null;
    patch.outcome = null;
  }
  if (!Object.keys(patch).length) return { status: 400, body: { error: 'nothing to change' } };

  const { data, error: uErr } = await db.from('show_submissions').update(patch)
    .eq('id', sub.id).eq('shop_id', shop.id).select(STAFF_COLS).single();
  if (uErr || !data) return { status: 500, body: { error: 'update failed' } };
  countStaffUpdate();
  return { status: 200, body: staffItem(data, shop) };
}

/** Re-run the quote on the stored lines (prices refreshed, or a failed price). */
export async function handleStaffReprice(slugParam, id, user, deps = {}) {
  const db = deps.supabaseClient ?? supabase;
  const quote = deps.quote ?? handleQuoteBatch;
  const { shop, error } = await staffShop(slugParam, user, deps);
  if (error) return error;
  const sub = await loadSub(db, shop, id);
  if (!sub) return { status: 404, body: { error: 'not found' } };
  const priced = await priceLines(sub.lines || [], quote);
  if (!priced.rows) return { status: 500, body: { error: `Couldn’t price it: ${priced.error}` } };
  // Picks and conditions key on the row index: keep them only if the rows
  // line up the same way as before.
  const same = Array.isArray(sub.rows) && sub.rows.length === priced.rows.length
    && sub.rows.every((r, i) => r.line === priced.rows[i].line);
  const { data, error: uErr } = await db.from('show_submissions').update({
    rows: priced.rows,
    prices_as_of: priced.pricesAsOf,
    priced_at: new Date().toISOString(),
    price_error: null,
    ...(same ? {} : { picks: {}, conditions: {} }),
  }).eq('id', sub.id).eq('shop_id', shop.id).select(STAFF_COLS).single();
  if (uErr || !data) return { status: 500, body: { error: 'update failed' } };
  countRepriced();
  return { status: 200, body: staffItem(data, shop) };
}

// ── Express wiring ───────────────────────────────────────────────────────────

const router = express.Router();
const send = (res, r) => res.status(r.status).json(r.body);
const wrap = (fn) => async (req, res) => {
  try { send(res, await fn(req)); } catch (e) {
    console.error('[SHOW]', e?.message || e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

router.get('/show/:slug', (req, res) => {
  if (!slugOf(req.params.slug)) return res.status(404).send('Not found');
  noStore(res);
  res.sendFile(join(SHOW_APP_DIR, 'index.html'));
});
router.get('/show/:slug/staff', (req, res) => {
  if (!slugOf(req.params.slug)) return res.status(404).send('Not found');
  noStore(res);
  res.sendFile(join(SHOW_APP_DIR, 'staff.html'));
});
router.get('/show/:slug/poster', (req, res) => {
  if (!slugOf(req.params.slug)) return res.status(404).send('Not found');
  noStore(res);
  res.sendFile(join(SHOW_APP_DIR, 'poster.html'));
});

router.post('/api/show/:slug/submit', showSubmitLimiter,
  wrap((req) => handleShowSubmit(req.params.slug, req.body, req)));
router.get('/api/show/ticket/:token', wrap((req) => handleShowTicket(req.params.token)));

router.get('/api/show/:slug/staff/list', requireAuth,
  wrap((req) => handleStaffList(req.params.slug, req.query, req.user)));
router.get('/api/show/:slug/staff/item/:id', requireAuth,
  wrap((req) => handleStaffItem(req.params.slug, req.params.id, req.user)));
router.patch('/api/show/:slug/staff/item/:id', requireAuth,
  wrap((req) => handleStaffUpdate(req.params.slug, req.params.id, req.body, req.user)));
router.post('/api/show/:slug/staff/item/:id/reprice', requireAuth,
  wrap((req) => handleStaffReprice(req.params.slug, req.params.id, req.user)));

export default router;
