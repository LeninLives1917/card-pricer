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

import { parseLines } from './parse-lines.js';
import { runLookup } from './lookup.js';
import { sumTotals, formatEur } from './totals.js';
import {
  loadShopConfig,
  applyEmbedMode,
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
  results: [], // LookupOk | LookupErr (see lookup.js)
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

function renderResults() {
  const totals = sumTotals(state.results);
  const game = $('gameSelect')?.value || 'pokemon';
  const icon = GAME_ICONS[game] || '\u{1F0CF}';

  const rowsHtml = state.results
    .map((it) => {
      if (it.error) {
        return (
          '<div class="card-error-row">Could not find: ' +
          escapeHtml(it.line) +
          ' (' +
          escapeHtml(it.error) +
          ')</div>'
        );
      }
      const cmLink = it.cardmarket_url || it.card?.cardmarket_url;
      const safeName = escapeHtml(it.card?.name || 'Unknown');
      const nameHtml = cmLink
        ? '<a href="' +
          escapeHtml(cmLink) +
          '" target="_blank" rel="noopener" class="card-name-link">' +
          safeName +
          '</a>'
        : safeName;
      const setLine =
        escapeHtml(it.card?.set_name || it.card?.set_code || '') +
        (it.card?.card_number ? ' &middot; #' + escapeHtml(it.card.card_number) : '');

      return (
        '<div class="card-row">' +
        '<div class="card-icon">' +
        icon +
        '</div>' +
        '<div class="card-meta">' +
        '<div class="card-name">' +
        nameHtml +
        '</div>' +
        '<div class="card-set">' +
        setLine +
        '</div>' +
        '</div>' +
        '<div class="card-prices">' +
        '<div class="row"><span class="label">MV</span><span>' +
        formatEur(it.market) +
        '</span></div>' +
        '<div class="row"><span class="label">Cash</span><span class="cash">' +
        formatEur(it.cash) +
        '</span></div>' +
        '<div class="row"><span class="label">Credit</span><span class="credit">' +
        formatEur(it.credit) +
        '</span></div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  $('cardList').innerHTML = rowsHtml || '<p class="note">No cards could be priced.</p>';
  $('totalMarket').textContent = formatEur(totals.market);
  $('totalCash').textContent = formatEur(totals.cash);
  $('totalCredit').textContent = formatEur(totals.credit);
}

async function startProcessing() {
  if (state.running) return;
  const lines = parseLines($('cardInput').value);
  if (!lines.length) {
    alert('Enter at least one card — e.g. MEG 133');
    return;
  }
  const game = $('gameSelect').value;

  state.running = true;
  state.results = [];
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
    state.submitted = false;
    $('resultsPanel').classList.remove('visible');
    $('resultsWrap').classList.add('locked');
    $('gate').style.display = '';
    $('progressWrap').style.display = 'none';
    resetLeadGate();
  });
}

function unlockResults() {
  state.submitted = true;
  $('resultsWrap').classList.remove('locked');
  $('gate').style.display = 'none';
}

// ── Boot ────────────────────────────────────────────────────────────────
function boot() {
  // Branding first (matches V1 ordering — applyShopBranding fires before
  // applyEmbedMode so the embed-padding tweak doesn't get clobbered).
  loadShopConfig(request);
  applyEmbedMode();

  $('startBtn')?.addEventListener('click', startProcessing);
  bindClear();
  bindLeadGate({
    getResults: () => state.results,
    getCashPct,
    getCreditPct,
    request,
    unlockResults,
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
