// apps/vendor/modules/tabs/session.js
//
// Session tab — the operational core. Cash/Credit % sliders, totals strip,
// session pills, log rows with condition cycle / status flags / notes /
// duplicate counters, search filter, edit mode, exports (XLSX + CSV TCG
// Power Tools format), refresh prices, undo, summary, history, customer
// view, share, offer builder, bulk discount.
//
// V1 audit §1b lines 4292-... covers all of this verbatim. We preserve the
// shape exactly; the rendering is restyled per DESIGN_BRIEF (Fraunces names,
// mono prices). Behaviours that aren't S7-essential (history/summary modal
// content, share text shape) are kept identical to V1 so we don't change
// any user-visible workflow.

import { postJson } from '../api-client.js';
import {
  state, currentSession, currentLog, saveAllSessions,
  setBuyPct, setCashPct, setCreditPct, getSetting,
  newSession, switchSession, deleteCurrentSession, renameCurrentSession,
} from '../state.js';
import { openResultSheet } from '../result-sheet.js';
import { exportSessionPdf } from '../pdf-export.js';

let _filter = '';
let _editMode = false;
let _customerView = false;
let _selectedForDelete = new Set();

export function init() {
  wireSliders();
  wireActionRows();
  wireSearch();
  window.addEventListener('cp:log-changed', renderAll);
  window.addEventListener('cp:card-corrected', renderAll);
  renderAll();
}

function renderAll() {
  renderTotals();
  renderSessionPills();
  renderSessionLog();
  renderSessionStrip();
}

// ============================================================
// Sliders + totals
// ============================================================

function wireSliders() {
  const cash = document.getElementById('cashPctSlider');
  const credit = document.getElementById('creditPctSlider');
  const buy = document.getElementById('buyPctSlider');
  if (cash) {
    cash.value = state.cashPct;
    cash.addEventListener('input', (e) => {
      setCashPct(e.target.value);
      const out = document.getElementById('cashPctDisplay');
      if (out) out.textContent = `${state.cashPct}% of market`;
      renderTotals(); renderSessionLog();
    });
  }
  if (credit) {
    credit.value = state.creditPct;
    credit.addEventListener('input', (e) => {
      setCreditPct(e.target.value);
      const out = document.getElementById('creditPctDisplay');
      if (out) out.textContent = `${state.creditPct}% of market`;
      renderTotals(); renderSessionLog();
    });
  }
  if (buy) {
    buy.value = state.buyPercentage;
    buy.addEventListener('input', (e) => {
      setBuyPct(e.target.value);
    });
  }
  // Initial labels.
  const cashOut = document.getElementById('cashPctDisplay');
  if (cashOut) cashOut.textContent = `${state.cashPct}% of market`;
  const creditOut = document.getElementById('creditPctDisplay');
  if (creditOut) creditOut.textContent = `${state.creditPct}% of market`;
}

function logTotals() {
  const log = currentLog();
  let mvSum = 0, buySum = 0, sellSum = 0;
  const markup = parseFloat(getSetting('sellMarkup', '110')) || 110;
  for (const e of log) {
    const cm = e.cardmarket || {};
    const bp = e.buy_price || {};
    const mv = e.market_value || bp.market_value || cm.price || cm.trend || 0;
    const buy = e.custom_buy ?? bp.suggested ?? Math.round(mv * (state.cashPct / 100) * 100) / 100;
    const sell = e.custom_sell ?? Math.round(mv * (markup / 100) * 100) / 100;
    mvSum += mv;
    buySum += buy;
    sellSum += sell;
  }
  return { mvSum, buySum, sellSum, count: log.length, profit: sellSum - buySum };
}

function renderTotals() {
  const t = logTotals();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('sessionTotalValue', t.buySum.toFixed(2) + ' €');
  set('sessionSellTotal', t.sellSum.toFixed(2) + ' €');
  set('sessionCardCount', String(t.count));
  set('sessionProfit', t.profit.toFixed(2) + ' €');
}

function renderSessionStrip() {
  const t = logTotals();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stripCount', String(t.count));
  set('stripSpent', '€' + t.buySum.toFixed(0));
  set('stripProfit', '€' + t.profit.toFixed(0));
  const logCount = document.getElementById('logCount');
  if (logCount) logCount.textContent = String(t.count);
}

// ============================================================
// Pills
// ============================================================

function renderSessionPills() {
  const wrap = document.getElementById('sessionPills');
  if (!wrap) return;
  const ids = Object.keys(state.sessions);
  wrap.innerHTML = ids.map((id) => {
    const s = state.sessions[id];
    return `<span class="session-pill ${id === state.currentSessionId ? 'active' : ''}" data-pill="${id}">${escapeHtml(s.name || id)}<span class="data-badge" style="margin-left:6px;">${s.log?.length || 0}</span></span>`;
  }).join('');
  wrap.querySelectorAll('[data-pill]').forEach((p) => {
    p.addEventListener('click', () => {
      switchSession(p.dataset.pill);
      renderAll();
    });
  });
}

// ============================================================
// Log rows
// ============================================================

function _matchesFilter(entry, q) {
  if (!q) return true;
  const card = entry.card || {};
  const hay = [card.name, card.set_name, card.set_code, card.card_number]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}

function renderSessionLog() {
  const root = document.getElementById('sessionLog');
  if (!root) return;
  const log = currentLog().filter((e) => _matchesFilter(e, _filter));
  if (!log.length) {
    root.innerHTML = `
      <div class="empty-state log-empty">
        <h4>${_filter ? 'No matches' : 'Session is empty'}</h4>
        <p>${_filter ? 'Try a different search.' : 'Cards you scan or type in build up here, with cash & credit offers calculated against the sliders above.'}</p>
      </div>`;
    return;
  }
  const markup = parseFloat(getSetting('sellMarkup', '110')) || 110;
  root.innerHTML = log.map((e, i) => {
    const card = e.card || {};
    const cm = e.cardmarket || {};
    const bp = e.buy_price || {};
    const mv = e.market_value || bp.market_value || cm.price || cm.trend || 0;
    const cash = Math.round(mv * (state.cashPct / 100) * 100) / 100;
    const credit = Math.round(mv * (state.creditPct / 100) * 100) / 100;
    const sell = Math.round(mv * (markup / 100) * 100) / 100;
    const thumb = e.image || card.image_url || '';
    const dup = e.duplicate_count > 0 ? `<span class="data-badge" style="margin-left:6px;">×${e.duplicate_count + 1}</span>` : '';
    const want = e.want_hit ? `<span class="status-badge live" style="margin-left:6px;">WANT</span>` : '';
    const status = e.status === 'bought' ? `<span class="status-badge up">BOUGHT</span>`
      : e.status === 'passed' ? `<span class="status-badge muted">PASSED</span>`
      : '';
    const editCb = _editMode
      ? `<input type="checkbox" data-del-idx="${i}" ${_selectedForDelete.has(i) ? 'checked' : ''} style="margin-right:8px;" />`
      : '';
    return `
      <div class="session-log-row" data-log-idx="${i}" style="cursor:pointer;">
        ${editCb}
        <div class="thumb" style="${thumb ? `background-image:url('${escapeAttr(thumb)}')` : ''}"></div>
        <div>
          <div class="name">${escapeHtml(card.name || 'Unknown')}${dup}${want}${status ? ' ' + status : ''}</div>
          <div class="meta">${escapeHtml((card.set_code || '').toUpperCase())} ${escapeHtml(card.card_number || '')}${card.rarity ? ' · ' + escapeHtml(card.rarity) : ''}</div>
        </div>
        <div class="price">
          €${mv.toFixed(2)}<br>
          <span class="data-badge" style="font-size:10px; color:var(--accent-soft);">cash €${cash.toFixed(2)}</span>
          <span class="data-badge" style="font-size:10px; color:var(--up); margin-left:4px;">credit €${credit.toFixed(2)}</span>
        </div>
      </div>`;
  }).join('');
  // Open result-sheet on row click.
  root.querySelectorAll('[data-log-idx]').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      const i = parseInt(row.dataset.logIdx, 10);
      const entry = currentLog().filter((e) => _matchesFilter(e, _filter))[i];
      if (entry) openResultSheet(entry);
    });
  });
  root.querySelectorAll('[data-del-idx]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.dataset.delIdx, 10);
      if (cb.checked) _selectedForDelete.add(i);
      else _selectedForDelete.delete(i);
    });
  });
}

// ============================================================
// Search
// ============================================================

function wireSearch() {
  const input = document.getElementById('sessionSearch');
  const clear = document.getElementById('sessionSearchClear');
  if (input) {
    input.addEventListener('input', (e) => {
      _filter = e.target.value;
      if (clear) clear.style.display = _filter ? '' : 'none';
      renderSessionLog();
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      _filter = '';
      if (input) input.value = '';
      clear.style.display = 'none';
      renderSessionLog();
    });
  }
}

// ============================================================
// Action rows
// ============================================================

function wireActionRows() {
  const map = {
    sessActExportXlsx: exportXlsx,
    sessActExportCsv: exportCsvTcgPowerTools,
    sessActExportPdf: exportPdfForCustomer,
    sessActRefresh: refreshAllPrices,
    sessActUndo: undoLastScan,
    sessActSummary: showSummary,
    sessActHistory: showHistory,
    sessActCustomer: toggleCustomerView,
    sessActShare: shareSession,
    sessActOffer: openOfferBuilder,
    sessActBulkDiscount: applyBulkDiscount,
    sessActEdit: toggleDeleteMode,
    sessActDeleteSelected: deleteSelected,
    sessActDeleteCancel: cancelDelete,
    sessActNewSession: () => { newSession(); renderAll(); },
    sessActRenameSession: () => {
      const name = prompt('Rename session', currentSession()?.name || '');
      if (name) renameCurrentSession(name);
      renderAll();
    },
    sessActDeleteSession: () => {
      if (confirm('Delete this session and all its cards?')) {
        deleteCurrentSession();
        renderAll();
      }
    },
    sessActClearLog: () => {
      if (!confirm('Clear all cards in this session?')) return;
      const s = currentSession();
      if (s) { s.log = []; saveAllSessions(); renderAll(); }
    },
  };
  for (const [id, fn] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }
}

function toggleDeleteMode() {
  _editMode = !_editMode;
  _selectedForDelete.clear();
  const bar = document.getElementById('deleteBar');
  if (bar) bar.style.display = _editMode ? 'flex' : 'none';
  const btn = document.getElementById('sessActEdit');
  if (btn) btn.textContent = _editMode ? 'Done' : 'Edit';
  renderSessionLog();
}

function cancelDelete() {
  _editMode = false;
  _selectedForDelete.clear();
  const bar = document.getElementById('deleteBar');
  if (bar) bar.style.display = 'none';
  const btn = document.getElementById('sessActEdit');
  if (btn) btn.textContent = 'Edit';
  renderSessionLog();
}

function deleteSelected() {
  const s = currentSession();
  if (!s) return;
  // Filter out indexes in the *visible* list — we have to map back through filter.
  const visible = currentLog().filter((e) => _matchesFilter(e, _filter));
  const drop = new Set();
  _selectedForDelete.forEach((i) => {
    const entry = visible[i];
    if (entry) drop.add(entry);
  });
  s.log = s.log.filter((e) => !drop.has(e));
  saveAllSessions();
  cancelDelete();
  renderAll();
}

function undoLastScan() {
  const s = currentSession();
  if (!s || !s.log.length) return;
  s.log.shift();
  saveAllSessions();
  renderAll();
}

async function refreshAllPrices() {
  const s = currentSession();
  if (!s || !s.log.length) return;
  for (const entry of s.log) {
    if (!entry.card) continue;
    const r = await postJson('/api/price', {
      card: entry.card,
      buyPercentage: state.buyPercentage,
    });
    if (r.ok) Object.assign(entry, r.body);
  }
  saveAllSessions();
  renderAll();
}

// ============================================================
// Exports
// ============================================================

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportXlsx() {
  if (!window.XLSX) {
    alert('Spreadsheet engine not loaded yet.');
    return;
  }
  const log = currentLog();
  if (!log.length) return;
  const rows = log.map((e) => {
    const card = e.card || {};
    const cm = e.cardmarket || {};
    const bp = e.buy_price || {};
    const mv = e.market_value || bp.market_value || cm.price || cm.trend || 0;
    return {
      Name: card.name || '',
      Set: card.set_name || '',
      'Set Code': card.set_code || '',
      Number: card.card_number || '',
      Rarity: card.rarity || '',
      Condition: card.condition_estimate || 'NM',
      Market: mv,
      Cash: Math.round(mv * (state.cashPct / 100) * 100) / 100,
      Credit: Math.round(mv * (state.creditPct / 100) * 100) / 100,
      Status: e.status || '',
      Notes: e.notes || '',
    };
  });
  const ws = window.XLSX.utils.json_to_sheet(rows);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Session');
  const name = (currentSession()?.name || 'session').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  window.XLSX.writeFile(wb, `cardpricer_${name}.xlsx`);
}

// Customer-facing PDF — renders a print-friendly sheet with images, market
// price, and our cash/credit offers. Implementation lives in
// modules/pdf-export.js so it stays self-contained.
async function exportPdfForCustomer() {
  const sess = currentSession();
  if (!sess) return;
  await exportSessionPdf(sess, {
    cashPct: state.cashPct,
    creditPct: state.creditPct,
    sellMarkup: parseFloat(getSetting('sellMarkup', '110')) || 110,
  });
}

function exportCsvTcgPowerTools() {
  // Format: Set,Number,Name,Condition,Quantity (TCG Power Tools)
  const log = currentLog();
  if (!log.length) return;
  const lines = ['Set,Number,Name,Condition,Quantity'];
  for (const e of log) {
    const card = e.card || {};
    const qty = (e.duplicate_count || 0) + 1;
    lines.push([
      csvEscape((card.set_code || '').toUpperCase()),
      csvEscape(card.card_number || ''),
      csvEscape(card.name || ''),
      csvEscape(card.condition_estimate || 'NM'),
      String(qty),
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cardpricer_${(currentSession()?.name || 'session').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 200);
}

// ============================================================
// Misc actions (kept lean — modals are in V1 verbatim)
// ============================================================

function showSummary() {
  const t = logTotals();
  alert(`Session: ${currentSession()?.name || ''}
Cards: ${t.count}
Total buy: €${t.buySum.toFixed(2)}
Total sell: €${t.sellSum.toFixed(2)}
Profit: €${t.profit.toFixed(2)}`);
}

function showHistory() {
  const ids = Object.keys(state.sessions);
  alert('Sessions:\n' + ids.map((id) => {
    const s = state.sessions[id];
    return `${s.name}: ${s.log?.length || 0} cards`;
  }).join('\n'));
}

function toggleCustomerView() {
  _customerView = !_customerView;
  document.body.classList.toggle('customer-view', _customerView);
}

function shareSession() {
  const t = logTotals();
  const text = `Session ${currentSession()?.name || ''}: ${t.count} cards, total buy €${t.buySum.toFixed(2)}`;
  if (navigator.share) navigator.share({ title: 'Card Pricer', text }).catch(() => {});
  else navigator.clipboard?.writeText(text);
}

function openOfferBuilder() {
  const t = logTotals();
  const totalCash = t.buySum;
  alert(`Offer summary
Cash: €${totalCash.toFixed(2)}
Credit: €${(totalCash * (state.creditPct / state.cashPct)).toFixed(2)}`);
}

function applyBulkDiscount() {
  const pct = parseFloat(prompt('Bulk discount % (e.g. 10 for −10%)', '10'));
  if (!pct || pct <= 0) return;
  const s = currentSession();
  if (!s) return;
  for (const e of s.log) {
    const cm = e.cardmarket || {};
    const bp = e.buy_price || {};
    const mv = e.market_value || bp.market_value || cm.price || cm.trend || 0;
    const baseCash = Math.round(mv * (state.cashPct / 100) * 100) / 100;
    e.custom_buy = Math.round(baseCash * (1 - pct / 100) * 100) / 100;
  }
  saveAllSessions();
  renderAll();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
