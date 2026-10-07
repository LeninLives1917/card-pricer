// apps/quote/modules/main.js
// Owner: A5 | Slice: S8
//
// Entry module for the V2 customer quote app. Wires the start button, lead
// submit, and clear button to the per-concern modules. Boot order matches
// V1 public/quote.html lines 421-422: loadShopConfig() first, applyEmbedMode
// second.
//
// One HTTP helper lives here. /quote is anonymous — no JWT — so this is a
// thin wrapper around fetch() that returns a uniform {ok,status,body} so
// every module gets the same error surface. Auth-gated endpoints
// (/api/identify-manual, /api/price) WILL return 401 for anonymous callers;
// that's a real V1 quirk, see "open question" in the slice handoff notes.

import { parseLines, droppedByCap, MAX_CARDS } from './parse-lines.js';
import { runLookup } from './lookup.js';
import { runBatchQuote, resolveAsk, batchLinesOf, MAX_BATCH_LINES } from './batch.js';
import { sumTotals, formatEur } from './totals.js';
import {
  loadShopConfig,
  applyEmbedMode,
  startEmbedResize,
  getCashPct,
  getCreditPct,
} from './shop-config.js';
import { bindLeadGate, resetLeadGate } from './lead-gate.js';

// ── HTML escape — exported for shop-config.js (it has to inject branded
//    text into the footer + checkbox label). The customer rule is "no raw
//    user content reaches innerHTML" — every interpolation point passes
//    through this.
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Tiny HTTP helper ────────────────────────────────────────────────────
// /quote is anonymous; no Authorization header. We still parse JSON
// responses safely (some endpoints emit empty bodies on 5xx).
async function request(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    headers: opts.body
      ? { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      : opts.headers || {},
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  let resp;
  try {
    resp = await fetch(path, init);
  } catch (e) {
    return { ok: false, status: 0, body: { error: e?.message || 'network error' } };
  }
  let body = null;
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
  } else {
    try {
      body = await resp.text();
    } catch {
      body = null;
    }
  }
  return { ok: resp.ok, status: resp.status, body };
}

// ── App state ───────────────────────────────────────────────────────────
const state = {
  results: [], // LookupOk | LookupErr (see lookup.js), or batch.js entries
  meta: null,  // whole-list quote: { pricesAsOf, pricesUsable, summary }
  running: false,
  submitted: false,
};

// ── DOM helpers ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// Game-icon glyphs match V1 line 595-599.
const GAME_ICONS = {
  pokemon: '⚡',
  magic: '✨',
  yugioh: '\u{1F31F}',
  lorcana: '\u{1FA84}',
  onepiece: '⚓',
  starwars: '⭐',
  digimon: '\u{1F432}',
  fleshandblood: '⚔',
  dragonball: '\u{1F525}',
};

// Why a line was left for the shop to price, in the customer's words.
const BY_HAND_REASONS = {
  no_cardmarket_product: "not in today's Cardmarket price list",
  no_price_in_guide: "not in today's Cardmarket price list",
  first_edition: '1st Edition, priced in store',
  shadowless: 'Shadowless, priced in store',
  prices_stale: "today's prices didn't load",
  prices_unavailable: "today's prices didn't load",
  customer_unsure: "you weren't sure which card",
  unconfirmed: 'not confirmed yet',
  graded: 'graded card, priced in store',
  high_value: 'high-value card, priced in store',
  price_unstable: "Cardmarket's price looked unreliable today",
};

function pricedRowHtml(it, icon) {
  const cmLink = it.cardmarket_url || it.card?.cardmarket_url;
  const safeName = escapeHtml(it.card?.name || 'Unknown');
  const nameHtml = cmLink
    ? '<a href="' + escapeHtml(cmLink) + '" target="_blank" rel="noopener" class="card-name-link">' + safeName + '</a>'
    : safeName;
  const qty = it.qty > 1 ? '<span class="qty-badge">' + it.qty + '&times;</span> ' : '';
  const bits = [escapeHtml(it.card?.set_name || it.card?.set_code || '')];
  if (it.card?.card_number) bits.push('#' + escapeHtml(it.card.card_number));
  const cond = it.card?.condition_estimate;
  if (cond && cond !== 'NM') bits.push(escapeHtml(cond));
  if (it.finish === 'reverse_holo' && !it.finish_fallback) bits.push('reverse holo');
  const notes = [];
  if (it.finish_fallback) notes.push('no reverse holo price, priced as the standard card');
  if (it.capped) notes.push('a one-off price spike was ignored');
  if (it.dip) notes.push("today's trend looked off, so recent sales were used");

  return (
    '<div class="card-row">' +
    '<div class="card-icon">' + icon + '</div>' +
    '<div class="card-meta">' +
    '<div class="card-name">' + qty + nameHtml + '</div>' +
    '<div class="card-set">' + bits.filter(Boolean).join(' &middot; ') + '</div>' +
    (notes.length ? '<div class="card-note">' + escapeHtml(notes.join('; ')) + '</div>' : '') +
    '</div>' +
    '<div class="card-prices">' +
    '<div class="row"><span class="label">MV</span><span>' + formatEur(it.market) + '</span></div>' +
    '<div class="row"><span class="label">Cash</span><span class="cash">' + formatEur(it.cash) + '</span></div>' +
    '<div class="row"><span class="label">Credit</span><span class="credit">' + formatEur(it.credit) + '</span></div>' +
    '</div>' +
    '</div>'
  );
}

function byHandRowHtml(it) {
  const title = it.card?.name || it.line || 'Card';
  const bits = [];
  if (it.card?.set_name) bits.push(escapeHtml(it.card.set_name));
  if (it.card?.card_number) bits.push('#' + escapeHtml(it.card.card_number));
  bits.push(escapeHtml(BY_HAND_REASONS[it.reason] || 'priced in store'));
  return (
    '<div class="card-row by-hand">' +
    '<div class="card-icon">&#9997;</div>' +
    '<div class="card-meta">' +
    '<div class="card-name">' + (it.qty > 1 ? '<span class="qty-badge">' + it.qty + '&times;</span> ' : '') + escapeHtml(title) + '</div>' +
    '<div class="card-set">' + bits.join(' &middot; ') + '</div>' +
    '</div>' +
    '<div class="card-prices"><div class="row"><span class="label">We\'ll price this by hand</span></div></div>' +
    '</div>'
  );
}

function renderMeta() {
  const el = $('quoteMeta');
  if (!el) return;
  const priced = state.results.filter((r) => r && !r.error && !r.byHand && !r.ask && r.card);
  const cards = priced.reduce((n, r) => n + (r.qty || 1), 0);
  const byHand = state.results.filter((r) => r?.byHand).length;
  const asks = state.results.filter((r) => r?.ask).length;
  const missing = state.results.filter((r) => r?.error).length;
  const parts = [];
  if (cards) parts.push(cards + ' card' + (cards === 1 ? '' : 's') + ' priced');
  if (byHand) parts.push(byHand + ' to price by hand');
  if (asks) parts.push(asks + ' to confirm above');
  if (missing) parts.push(missing + ' not found');
  const asOf = state.meta?.pricesAsOf;
  if (asOf) {
    let when = asOf;
    try {
      when = new Date(asOf + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    } catch { /* keep the ISO date */ }
    parts.push('Cardmarket prices from ' + when);
  }
  el.textContent = parts.join(' · ');
  el.style.display = parts.length ? '' : 'none';
}

function askOptionHtml(c, i, ci) {
  const card = c.card || {};
  const set = c.label || card.set_name || card.set_id || '';
  const num = card.card_number
    ? ' #' + escapeHtml(card.card_number) + (card.printed_total ? '/' + escapeHtml(card.printed_total) : '')
    : '';
  // No prices on the options: the customer is identifying the card in their
  // hand, and a price beside each choice only invites picking the dearer one.
  return (
    '<button type="button" class="ask-option" data-idx="' + i + '" data-choice="' + ci + '">' +
    '<span class="opt-name">' + escapeHtml(card.name || '?') + '</span>' +
    '<span class="opt-set">' + escapeHtml(set) + num + '</span>' +
    '</button>'
  );
}

function renderAsks() {
  let panel = $('askPanel');
  const asks = state.results.map((r, i) => ({ r, i })).filter((x) => x.r && x.r.ask);
  if (!panel) {
    const wrap = $('resultsWrap');
    if (!wrap || !wrap.parentNode) return;
    panel = document.createElement('div');
    panel.id = 'askPanel';
    panel.className = 'ask-panel';
    wrap.parentNode.insertBefore(panel, wrap);
    panel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.ask-option');
      if (!btn) return;
      const idx = Number(btn.getAttribute('data-idx'));
      const choice = Number(btn.getAttribute('data-choice'));
      const entry = state.results[idx];
      if (!entry || !entry.ask) return;
      state.results[idx] = resolveAsk(entry, choice, getCashPct(), getCreditPct());
      renderResults();
    });
  }
  if (!asks.length || state.submitted) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  panel.style.display = '';
  panel.innerHTML =
    '<div class="ask-head">' +
    (asks.length === 1 ? 'One card needs a quick check' : asks.length + ' cards need a quick check') +
    '</div>' +
    asks
      .map(({ r, i }) =>
        '<div class="ask-item">' +
        '<div class="ask-line">You typed <code>' + escapeHtml(r.line) + '</code></div>' +
        '<div class="ask-question">' + escapeHtml(r.question) + '</div>' +
        '<div class="ask-options">' +
        r.candidates.map((c, ci) => askOptionHtml(c, i, ci)).join('') +
        '<button type="button" class="ask-option ask-unsure" data-idx="' + i + '" data-choice="-1">' +
        '<span class="opt-name">Not sure</span><span class="opt-set">we\'ll check it in store</span></button>' +
        '</div>' +
        '</div>'
      )
      .join('');
}

function renderResults() {
  const totals = sumTotals(state.results);
  const game = $('gameSelect')?.value || 'pokemon';
  const icon = GAME_ICONS[game] || '\u{1F0CF}';

  const rowsHtml = state.results
    .map((it) => {
      if (!it || it.ask) return '';
      if (it.error) {
        return (
          '<div class="card-error-row">Could not find: ' +
          escapeHtml(it.line) +
          ' (' +
          escapeHtml(it.error) +
          ')</div>'
        );
      }
      if (it.byHand) return byHandRowHtml(it);
      return pricedRowHtml(it, icon);
    })
    .join('');

  $('cardList').innerHTML = rowsHtml || '<p class="note">No cards could be priced yet.</p>';
  $('totalMarket').textContent = formatEur(totals.market);
  $('totalCash').textContent = formatEur(totals.cash);
  $('totalCredit').textContent = formatEur(totals.credit);
  renderMeta();
  renderAsks();
}

async function startBatch() {
  const all = batchLinesOf($('cardInput').value);
  if (!all.length) {
    alert('Enter at least one card, e.g. Charizard 4/102');
    return;
  }
  if (all.length > MAX_BATCH_LINES) {
    const ok = confirm(
      'Up to ' + MAX_BATCH_LINES + ' cards can be quoted at once, so ' +
      (all.length - MAX_BATCH_LINES) + ' line(s) would be left out.\n\n' +
      'Continue with the first ' + MAX_BATCH_LINES + ', or cancel and split the list?'
    );
    if (!ok) return;
  }
  const lines = all.slice(0, MAX_BATCH_LINES);

  state.running = true;
  state.results = [];
  state.meta = null;
  state.submitted = false;
  $('resultsWrap').classList.add('locked');
  $('gate').style.display = '';
  resetLeadGate();

  const startBtn = $('startBtn');
  startBtn.disabled = true;
  startBtn.textContent = 'Pricing your cards...';
  $('progressWrap').style.display = 'block';
  $('progressBar').style.width = '100%';
  $('progressBar').classList.add('working');
  $('progressLabel').textContent =
    'Matching and pricing ' + lines.length + ' card' + (lines.length === 1 ? '' : 's') + '...';

  try {
    const { entries, meta } = await runBatchQuote({
      text: lines.join('\n'),
      cashPct: getCashPct(),
      creditPct: getCreditPct(),
      request,
    });
    state.results = entries;
    state.meta = meta;
  } catch (e) {
    state.results = [{ error: e?.message || 'Quote failed, please try again', line: 'your list' }];
  } finally {
    state.running = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Get my quote';
    $('progressBar').classList.remove('working');
    $('progressWrap').style.display = 'none';
  }

  if (state.results.length) {
    $('resultsPanel').classList.add('visible');
    renderResults();
  }
}

async function startProcessing() {
  if (state.running) return;
  const game = $('gameSelect').value;
  // Pokémon goes through the whole-list quote: one request, local matching,
  // the daily Cardmarket price guide. Other games keep the per-card lookup.
  if (game === 'pokemon') return startBatch();

  const lines = parseLines($('cardInput').value);
  if (!lines.length) {
    alert('Enter at least one card, e.g. MKM 123');
    return;
  }

  // The cap has always been here; the silence has not. Quoting 20 of somebody's
  // 40 cards and saying nothing gives them a wrong total with no way to notice.
  const dropped = droppedByCap();
  if (dropped > 0) {
    const ok = confirm(
      `Only the first ${MAX_CARDS} cards can be quoted at once for this game, so ` +
      `${dropped} more ${dropped === 1 ? 'line was' : 'lines were'} left out.\n\n` +
      'Continue with the first ' + MAX_CARDS + ', or cancel and split the list?',
    );
    if (!ok) return;
  }

  state.running = true;
  state.results = [];
  state.meta = null;
  state.submitted = false;
  $('resultsWrap').classList.add('locked');
  $('gate').style.display = '';
  resetLeadGate();

  const startBtn = $('startBtn');
  startBtn.disabled = true;
  startBtn.textContent = 'Looking up cards...';
  $('progressWrap').style.display = 'block';
  $('progressBar').style.width = '0%';
  $('progressLabel').textContent = '0 / ' + lines.length;

  try {
    state.results = await runLookup({
      lines,
      game,
      cashPct: getCashPct(),
      creditPct: getCreditPct(),
      request,
      onProgress: (done, total) => {
        const pct = total > 0 ? (done / total) * 100 : 0;
        $('progressBar').style.width = pct + '%';
        $('progressLabel').textContent = done + ' / ' + total;
      },
    });
  } finally {
    state.running = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Get my quote';
  }

  if (state.results.length) {
    $('resultsPanel').classList.add('visible');
    renderResults();
  }
}

function bindClear() {
  const btn = $('clearBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.running) return;
    $('cardInput').value = '';
    state.results = [];
    state.meta = null;
    state.submitted = false;
    renderAsks();
    $('resultsPanel').classList.remove('visible');
    $('resultsWrap').classList.add('locked');
    $('gate').style.display = '';
    $('progressWrap').style.display = 'none';
    resetLeadGate();
  });
}

function unlockResults() {
  // Questions still open at submit time were sent to the shop as lines to
  // check in store; show them the same way now the quote is unlocked.
  state.results = state.results.map((r) =>
    r && r.ask ? { byHand: true, card: null, line: r.line, qty: r.row?.qty || 1, reason: 'unconfirmed' } : r
  );
  state.submitted = true;
  $('resultsWrap').classList.remove('locked');
  $('gate').style.display = 'none';
  renderResults();
}

// ── Recover saved quote (S12 / F6) ───────────────────────────────────────
// If the URL hash contains `#recover=<uuid>`, fetch the persisted quote
// from /api/v2/quote/:id and render it without going through the lookup
// or email gate. This lets a customer revisit a quote from a stable URL
// after closing the tab. /q/:id 302s here so the redirect lands with the
// hash intact.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseRecoverHash() {
  const m = /#recover=([^&]+)/.exec(location.hash || '');
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return UUID_RE.test(id) ? id : null;
}

async function tryRecoverFromHash() {
  const id = parseRecoverHash();
  if (!id) return false;
  const r = await request('/api/v2/quote/' + encodeURIComponent(id), { method: 'GET' });
  if (!r.ok || !r.body || typeof r.body !== 'object') {
    showRecoverError('That saved quote could not be loaded. Try entering your cards again.');
    return false;
  }
  const q = r.body;
  // Map the sanitised server shape back into the renderer's row shape.
  const cards = Array.isArray(q.cards) ? q.cards : [];
  state.results = cards.map((c) => (c && c.by_hand ? {
    byHand: true,
    line: c.line || c.name || '',
    qty: Number(c.qty) || 1,
    reason: c.reason || null,
    card: c.name ? { name: c.name, set_code: c.set_code, set_name: c.set_code, card_number: c.card_number } : null,
  } : {
    line: c.name || '',
    qty: Number(c.qty) || 1,
    error: null,
    card: {
      name: c.name,
      set_code: c.set_code,
      set_name: c.set_name || c.set_code,
      card_number: c.card_number,
      condition_estimate: c.condition || 'NM',
    },
    market: Number(c.mv) || 0,
    cash: Number(c.cash) || 0,
    credit: Number(c.credit) || 0,
  }));
  // Skip the email gate — it's already been submitted.
  state.submitted = true;
  $('resultsPanel')?.classList.add('visible');
  $('resultsWrap')?.classList.remove('locked');
  const gate = $('gate');
  if (gate) gate.style.display = 'none';
  renderResults();
  showRecoverBanner(q);
  return true;
}

function showRecoverBanner(q) {
  let banner = document.getElementById('cpRecoverBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'cpRecoverBanner';
    banner.style.cssText =
      'margin:0 0 12px;padding:10px 12px;border:1px solid #2c3344;border-radius:6px;background:#161a23;color:#9aa3b2;font-size:13px;';
    const panel = $('resultsPanel');
    if (panel) panel.insertBefore(banner, panel.firstChild);
  }
  let when = '';
  try {
    when = q.created_at ? new Date(q.created_at).toLocaleString() : '';
  } catch { /* ignore */ }
  banner.textContent = when
    ? 'Showing saved quote from ' + when + '.'
    : 'Showing saved quote.';
}

function showRecoverError(msg) {
  // Non-scary inline note. Leave the form usable so the customer can
  // re-enter cards manually.
  const input = $('cardInput');
  if (input && input.parentNode) {
    let note = document.getElementById('cpRecoverError');
    if (!note) {
      note = document.createElement('div');
      note.id = 'cpRecoverError';
      note.style.cssText =
        'margin:0 0 8px;padding:8px 10px;border:1px solid #5a3b3b;border-radius:6px;background:#1d1416;color:#f1c0c0;font-size:13px;';
      input.parentNode.insertBefore(note, input);
    }
    note.textContent = msg;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────
function boot() {
  // Branding first (matches V1 ordering — applyShopBranding fires before
  // applyEmbedMode so the embed-padding tweak doesn't get clobbered).
  loadShopConfig(request);
  applyEmbedMode();
  startEmbedResize();

  $('startBtn')?.addEventListener('click', startProcessing);
  bindClear();
  bindLeadGate({
    getResults: () => state.results,
    getMeta: () => state.meta,
    getCashPct,
    getCreditPct,
    request,
    unlockResults,
  });

  // Fire-and-forget recover attempt. Failure leaves the form normal.
  if (parseRecoverHash()) {
    tryRecoverFromHash().catch(() => {
      showRecoverError('Could not load saved quote. Please enter your cards again.');
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
