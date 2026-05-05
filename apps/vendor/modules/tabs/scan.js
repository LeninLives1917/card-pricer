// apps/vendor/modules/tabs/scan.js
//
// Scan tab — modes:
//   - bulk: many photos at once (camera-roll), default for laptops
//   - text: paste set codes one per line (for fast manual entry)
//
// Camera-based "Single" mode was removed in V1. The live camera flow now
// only runs in scanner-mode (the phone joined via ?pair=ROOMID — see
// modules/pair.js). Scanner-mode hides the chrome and the bulk/text
// panels via body.scanner-mode in tokens.css.
//
// On the laptop side, bulk uploads call modules/bulk.js (concurrency 4,
// /api/identify-stream → /api/price → session log). Text-entry calls
// /api/identify-manual per row, then /api/price (skips the AI step).

import { postJson } from '../api-client.js';
import { state, currentSession, saveAllSessions, getSetting } from '../state.js';
import {
  initBulk, handleBulkFiles, removeBulkItem, clearBulkQueue,
  retryBulkFailed, startBulkProcess, bulkStatus,
} from '../bulk.js';
import { joinAsScanner, uploadRawScanToRoom } from '../pair.js';
import { openResultSheet } from '../result-sheet.js';

let _mode = 'bulk';

export function init() {
  // Detect scanner mode and adjust UI early.
  const isScanner = new URLSearchParams(location.search).has('pair');
  if (isScanner) {
    const room = new URLSearchParams(location.search).get('pair');
    joinAsScanner(room);
    showScannerMode();
    return;
  }

  // Bulk module wires its workers and re-render hook.
  initBulk({
    onUpdate: () => renderBulk(),
    onItemDone: (result, item) => {
      // Add to current session log directly — bulk skips the result sheet.
      const sess = currentSession();
      if (!sess) return;
      sess.log.unshift({
        ...result,
        image: item.thumbUrl || item.dataUrl || '',
        ts: Date.now(),
      });
      saveAllSessions();
      window.dispatchEvent(new CustomEvent('cp:log-changed'));
    },
  });

  wireModeToggle();
  wireBulk();
  wireTextEntry();
  wireManualEntry();
  renderBulk();
}

function wireModeToggle() {
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
}

function setMode(mode) {
  _mode = mode === 'text' ? 'text' : 'bulk';
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === _mode);
  });
  document.getElementById('bulkPanel')?.classList.toggle('hidden', _mode !== 'bulk');
  document.getElementById('textEntryPanel')?.classList.toggle('hidden', _mode !== 'text');
}

// ============================================================
// Bulk
// ============================================================

function wireBulk() {
  const drop = document.getElementById('bulkDrop');
  const input = document.getElementById('bulkInput');
  const startBtn = document.getElementById('bulkStartBtn');
  const retryBtn = document.getElementById('bulkRetryBtn');
  const clearBtn = document.getElementById('bulkClearBtn');

  if (drop && input) drop.addEventListener('click', () => input.click());
  if (input) input.addEventListener('change', (ev) => {
    handleBulkFiles(ev.target.files);
    ev.target.value = '';
  });
  if (startBtn) startBtn.addEventListener('click', startBulkProcess);
  if (retryBtn) retryBtn.addEventListener('click', retryBulkFailed);
  if (clearBtn) clearBtn.addEventListener('click', clearBulkQueue);

  // Drag-and-drop polish.
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.style.borderColor = '';
      handleBulkFiles(e.dataTransfer?.files);
    });
  }
}

function renderBulk() {
  const grid = document.getElementById('bulkGrid');
  const controls = document.getElementById('bulkControls');
  if (!grid) return;
  if (!state.bulkQueue.length) {
    grid.innerHTML = '';
    if (controls) controls.style.display = 'none';
    return;
  }
  grid.innerHTML = state.bulkQueue.map((item) => {
    const label = item.status === 'queued' ? 'Queued'
      : item.status === 'processing' ? '…'
      : item.status === 'done' ? (item.name_short || '✓')
      : 'Err';
    const bg = item.thumbUrl || item.dataUrl || '';
    return `
      <div class="bulk-tile ${item.status}" style="${bg ? `background-image:url('${escapeAttr(bg)}')` : ''}">
        ${item.status === 'queued' ? `<button class="bulk-remove" data-remove="${item.id}" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);color:white;border:0;border-radius:9999px;width:20px;height:20px;cursor:pointer;font-size:14px;line-height:1;">×</button>` : ''}
        <div class="bulk-status">${escapeHtml(label)}</div>
      </div>`;
  }).join('');
  grid.querySelectorAll('[data-remove]').forEach((b) => {
    b.addEventListener('click', () => removeBulkItem(parseInt(b.dataset.remove, 10)));
  });
  if (controls) controls.style.display = '';
  const status = bulkStatus();
  const bar = document.getElementById('bulkProgressBar');
  const label = document.getElementById('bulkProgressLabel');
  if (bar) bar.style.width = (status.total ? Math.round((status.done + status.errored) / status.total * 100) : 0) + '%';
  if (label) label.textContent = `${status.done + status.errored} / ${status.total}`;
  const start = document.getElementById('bulkStartBtn');
  if (start) {
    start.disabled = status.running || status.total === 0 || (status.done + status.errored) === status.total;
    start.textContent = status.running ? `Processing… (${status.done}/${status.total})`
      : status.total > 0 ? `Process ${status.total} card${status.total !== 1 ? 's' : ''}`
      : '';
  }
  const retry = document.getElementById('bulkRetryBtn');
  if (retry) {
    retry.style.display = (!status.running && status.errored > 0) ? '' : 'none';
    retry.textContent = `Retry ${status.errored} failed`;
  }
}

// ============================================================
// Text entry — one row per line, calls /api/identify-manual
// ============================================================

function wireTextEntry() {
  const startBtn = document.getElementById('textEntryStartBtn');
  const clearBtn = document.getElementById('textEntryClearBtn');
  if (startBtn) startBtn.addEventListener('click', startTextEntry);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    const ta = document.getElementById('textEntryArea');
    if (ta) ta.value = '';
  });
}

function parseTextEntryLines(raw) {
  return (raw || '').split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // Try "SET NUM" or "SET NUM Name" or just "NUM"
    const m = trimmed.match(/^([A-Z0-9]{2,5})\s+([A-Z0-9/]+)\s*(.*)$/i);
    if (m) {
      return { set_code: m[1].toUpperCase(), card_number: m[2], name: m[3] || undefined };
    }
    const m2 = trimmed.match(/^([0-9/]+)\s*(.*)$/);
    if (m2) return { card_number: m2[1], name: m2[2] || undefined };
    return { name: trimmed };
  }).filter(Boolean);
}

async function startTextEntry() {
  const ta = document.getElementById('textEntryArea');
  if (!ta) return;
  const game = document.getElementById('textEntryGame')?.value || 'pokemon';
  const lines = parseTextEntryLines(ta.value);
  if (!lines.length) return;
  const progress = document.getElementById('textEntryProgress');
  const bar = document.getElementById('textEntryProgressBar');
  const label = document.getElementById('textEntryProgressLabel');
  if (progress) progress.classList.remove('hidden');

  state.currentResults = [];
  for (let i = 0; i < lines.length; i++) {
    if (label) label.textContent = `${i + 1} / ${lines.length}`;
    if (bar) bar.style.width = ((i + 1) / lines.length * 100) + '%';
    const row = lines[i];
    const r = await postJson('/api/identify-manual', { game, ...row });
    if (!r.ok || !r.body?.cards?.length) continue;
    const card = r.body.cards[0];
    const priced = await postJson('/api/price', {
      card,
      buyPercentage: state.buyPercentage,
    });
    const result = priced.ok ? priced.body : { card, cardmarket: null, ebay: null, buy_price: null };
    state.currentResults.push(result);
    // Add to session log too.
    const sess = currentSession();
    if (sess) {
      sess.log.unshift({ ...result, ts: Date.now() });
    }
  }
  saveAllSessions();
  window.dispatchEvent(new CustomEvent('cp:results-changed'));
  window.dispatchEvent(new CustomEvent('cp:log-changed'));
  window.dispatchEvent(new CustomEvent('cp:nav', { detail: { tab: 'results' } }));
  if (progress) progress.classList.add('hidden');
}

// ============================================================
// Manual entry modal — single card, fast text path
// ============================================================

function wireManualEntry() {
  const open = document.getElementById('manualEntryOpenBtn');
  const close = document.getElementById('manualEntryCloseBtn');
  const submit = document.getElementById('manualEntrySubmit');
  const overlay = document.getElementById('manualEntryOverlay');
  if (open) open.addEventListener('click', openManualEntry);
  if (close) close.addEventListener('click', closeManualEntry);
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeManualEntry();
  });
  if (submit) submit.addEventListener('click', submitManualEntry);
}

function openManualEntry() {
  const overlay = document.getElementById('manualEntryOverlay');
  if (overlay) overlay.classList.remove('hidden');
}
function closeManualEntry() {
  const overlay = document.getElementById('manualEntryOverlay');
  if (overlay) overlay.classList.add('hidden');
}
async function submitManualEntry() {
  const game = document.getElementById('manualGame')?.value || 'pokemon';
  const set_code = document.getElementById('manualSet')?.value.trim();
  const card_number = document.getElementById('manualNumber')?.value.trim();
  const name = document.getElementById('manualName')?.value.trim();
  if (!card_number && !name) return;
  const r = await postJson('/api/identify-manual', { game, set_code, card_number, name });
  if (!r.ok || !r.body?.cards?.length) {
    const err = document.getElementById('manualEntryError');
    if (err) err.textContent = r.error || 'No card found.';
    return;
  }
  const card = r.body.cards[0];
  const priced = await postJson('/api/price', { card, buyPercentage: state.buyPercentage });
  const result = priced.ok ? priced.body : { card, cardmarket: null, buy_price: null };
  state.currentResults = [result, ...(state.currentResults || [])];
  // Open the result sheet directly.
  openResultSheet(result);
  closeManualEntry();
  window.dispatchEvent(new CustomEvent('cp:results-changed'));
}

// ============================================================
// Scanner-mode UI — phone runs the camera flow only
// ============================================================

function showScannerMode() {
  const root = document.getElementById('tab-scan');
  if (!root) return;
  root.innerHTML = `
    <div class="surface" style="margin:var(--p-3) 0;">
      <div class="display" style="font-size:18px; margin-bottom:var(--p-2);">Phone connected</div>
      <p style="font-size:12px; color:var(--paper-300); line-height:1.5;">
        Snap cards. They'll appear instantly on the paired laptop's session.
      </p>
      <div style="margin-top:var(--p-3); display:flex; gap:var(--p-2);">
        <input type="file" id="scannerFileInput" accept="image/*" capture="environment" style="display:none;" />
        <button class="btn primary" id="scannerCaptureBtn" style="flex:1; justify-content:center;">Take photo</button>
      </div>
      <div id="scannerStatus" style="font-size:11px; color:var(--paper-300); margin-top:var(--p-2); min-height:14px;"></div>
    </div>`;
  const input = document.getElementById('scannerFileInput');
  const btn = document.getElementById('scannerCaptureBtn');
  const status = document.getElementById('scannerStatus');
  if (btn && input) btn.addEventListener('click', () => input.click());
  if (input) input.addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (!f) return;
    if (status) status.textContent = 'Sending…';
    const reader = new FileReader();
    reader.onload = async () => {
      const r = await uploadRawScanToRoom(reader.result);
      if (status) status.textContent = r.ok ? 'Sent. Take another.' : 'Send failed.';
    };
    reader.readAsDataURL(f);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
