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

import { postJson, uploadMultipart } from '../api-client.js';
import { state, currentSession, saveAllSessions, getSetting } from '../state.js';
import { parseTextEntryLines } from '../text-parse.js';
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
  wireBinder();
  wireManualEntry();
  renderBulk();
}

function wireModeToggle() {
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
}

function setMode(mode) {
  _mode = mode === 'text' ? 'text'
        : mode === 'binder' ? 'binder'
        : 'bulk';
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === _mode);
  });
  document.getElementById('bulkPanel')?.classList.toggle('hidden', _mode !== 'bulk');
  document.getElementById('textEntryPanel')?.classList.toggle('hidden', _mode !== 'text');
  document.getElementById('binderPanel')?.classList.toggle('hidden', _mode !== 'binder');
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

    // Bare-name lines (parser pattern 5) can't hit /api/identify-manual —
    // it requires card_number. Surface as an error row rather than dropping
    // silently, so the user knows that line couldn't be priced.
    if (!row.card_number) {
      state.currentResults.push(makeErrorRow(row, 'Need set + number'));
      continue;
    }

    const payload = {
      game,
      set_code: row.set_code,
      card_number: row.card_number,
      name: row.name,
    };
    const r = await postJson('/api/identify-manual', payload);
    if (!r.ok || !r.body?.cards?.length) {
      const msg = r.body?.error || (r.status ? `HTTP ${r.status}` : 'no match');
      state.currentResults.push(makeErrorRow(row, msg));
      continue;
    }
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

// Build a result-shaped row that signals "this line could not be priced".
// results.js renders entry.error rows with a red tint instead of a price.
function makeErrorRow(parsed, errMsg) {
  return {
    card: {
      name: parsed.name || parsed.raw || 'Unknown',
      set_code: parsed.set_code || '',
      card_number: parsed.card_number || '',
    },
    error: errMsg || 'no match',
    _parsed_line: parsed.raw,
  };
}

// ============================================================
// Binder page — single photo with 4–12 cards in a grid.
// Server detects + crops, then runs the standard identify pipeline on
// each crop in parallel (see /api/identify-binder in
// apps/server/routes/identify.js). We loop the response, /api/price each
// card, and add to the session log — same shape as text-entry.
// ============================================================

function wireBinder() {
  const drop = document.getElementById('binderDrop');
  const input = document.getElementById('binderInput');
  if (drop && input) drop.addEventListener('click', () => input.click());
  if (input) input.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    await runBinder(file);
  });
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.style.borderColor = '';
      const file = e.dataTransfer?.files?.[0];
      if (file) await runBinder(file);
    });
  }
}

async function runBinder(file) {
  const progress = document.getElementById('binderProgress');
  const bar = document.getElementById('binderProgressBar');
  const label = document.getElementById('binderProgressLabel');
  const status = document.getElementById('binderStatus');
  const setLabel = (s) => { if (label) label.textContent = s; };
  const setStatus = (s) => { if (status) status.textContent = s; };
  const setBar = (pct) => { if (bar) bar.style.width = pct + '%'; };

  if (progress) progress.classList.remove('hidden');
  setLabel('Detecting cards…');
  setBar(15);
  setStatus('');

  const fd = new FormData();
  fd.append('image', file);
  // Route through uploadMultipart (api-client.js) so the Supabase JWT
  // Authorization header is attached. A raw fetch() returns "auth required"
  // because requireAuth on the server reads the Bearer token from there.
  const r = await uploadMultipart('/api/identify-binder', fd);
  setBar(70);

  if (!r.ok) {
    setStatus(r.error || `Server error (${r.status})`);
    setBar(0);
    return;
  }

  const body = r.body || {};
  const cards = Array.isArray(body.cards) ? body.cards : [];
  const detected = body?.binder?.count ?? cards.length;
  setLabel(`Pricing ${cards.length} card${cards.length === 1 ? '' : 's'}…`);
  setStatus(`Detected ${detected} card${detected === 1 ? '' : 's'} on the page.`);
  setBar(80);

  if (!cards.length) {
    setStatus('No cards detected on this page.');
    setBar(0);
    return;
  }

  // Price each card in parallel — same pattern as text-entry, just batched.
  // Carry the binder crop into entry.image so the result rows / sheet show
  // "what we scanned" next to "what we identified" (same convention as
  // single + bulk scans, where the client attaches the source photo).
  state.currentResults = [];
  const sess = currentSession();
  await Promise.all(cards.map(async (card) => {
    const cropImg = card._binder_image || '';
    const priced = await postJson('/api/price', {
      card,
      buyPercentage: state.buyPercentage,
    });
    const result = priced.ok ? priced.body : { card, cardmarket: null, ebay: null, buy_price: null };
    state.currentResults.push(result);
    if (sess) sess.log.unshift({ ...result, image: cropImg, ts: Date.now() });
  }));

  saveAllSessions();
  setBar(100);
  setStatus(`Identified ${cards.length} of ${detected} card${detected === 1 ? '' : 's'}.`);
  window.dispatchEvent(new CustomEvent('cp:results-changed'));
  window.dispatchEvent(new CustomEvent('cp:log-changed'));
  window.dispatchEvent(new CustomEvent('cp:nav', { detail: { tab: 'results' } }));
  // Hide the progress bar after a beat so the user sees the final state.
  setTimeout(() => { if (progress) progress.classList.add('hidden'); }, 1200);
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

// Bump whenever scanner-mode behaviour changes. Rendered on screen so the
// question "is the phone actually running the new code?" is answered by
// looking, not by inference. A cached module served an OLD scanner UI on a
// NEW deploy and cost an entire debugging round — the same lesson as the
// key_present field on /api/health.
const SCANNER_BUILD = 'v3.3-gated-viewfinder';

// Upload tally. Shown to the operator, because "sent" with nothing arriving
// on the laptop is precisely the failure this mode shipped with.
const _scannerCounts = { captured: 0, sent: 0, failed: 0, inflight: 0 };

function showScannerMode() {
  const root = document.getElementById('tab-scan');
  if (!root) return;

  root.innerHTML = `
    <div class="surface" style="margin:var(--p-3) 0;">
      <div class="display" style="font-size:18px; margin-bottom:var(--p-2);">Phone connected</div>
      <div id="scannerCamWrap" style="position:relative; border-radius:10px; overflow:hidden; background:#000; display:none;">
        <video id="scannerVideo" playsinline autoplay muted
               style="width:100%; display:block; max-height:60vh; object-fit:cover;"></video>
        <div id="scannerFlash" style="position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; transition:opacity 120ms;"></div>
        <!-- Framing reticle. Card aspect is 63x88mm (1:1.4); filling this box
             puts the most pixels on the collector number, which is the field
             costing ~30% of failures. -->
        <div id="scannerReticle" style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
             width:62%; aspect-ratio:63/88; border:3px solid rgba(255,255,255,.5); border-radius:10px;
             pointer-events:none; transition:border-color 120ms, box-shadow 120ms;"></div>
        <div id="scannerHint" style="position:absolute; left:0; right:0; bottom:10px; text-align:center;
             font-size:15px; font-weight:600; color:#fff; text-shadow:0 1px 4px rgba(0,0,0,.8); pointer-events:none;"></div>
      </div>
      <div id="scannerFallback" style="display:none; margin-top:var(--p-2);">
        <p id="scannerFallbackMsg" style="font-size:12px; color:var(--paper-300); line-height:1.5;"></p>
        <input type="file" id="scannerFileInput" accept="image/*" capture="environment" style="display:none;" />
        <button class="btn" id="scannerFileBtn" style="width:100%; justify-content:center; margin-top:var(--p-2);">Use phone camera app</button>
      </div>
      <div style="margin-top:var(--p-3); display:flex; gap:var(--p-2); align-items:center;">
        <button class="btn primary" id="scannerShutter"
                style="flex:1; justify-content:center; padding:18px 0; font-size:16px;">Capture</button>
        <button class="btn" id="scannerTorch" style="display:none; padding:18px 14px;" aria-label="Toggle torch">Light</button>
      </div>
      <div id="scannerStatus" style="font-size:11px; color:var(--paper-300); margin-top:var(--p-2); min-height:14px;"></div>
      <div id="scannerBuild" style="font-size:10px; color:var(--paper-300); opacity:0.65; margin-top:var(--p-1);">
        build ${SCANNER_BUILD} · mode <span id="scannerModeLabel">starting…</span>
      </div>
    </div>`;

  const video    = document.getElementById('scannerVideo');
  const camWrap  = document.getElementById('scannerCamWrap');
  const flash    = document.getElementById('scannerFlash');
  const shutter  = document.getElementById('scannerShutter');
  const torchBtn = document.getElementById('scannerTorch');
  const status   = document.getElementById('scannerStatus');
  const fallback = document.getElementById('scannerFallback');
  const fbMsg    = document.getElementById('scannerFallbackMsg');

  let _forceNext = false;
  let _gateCounts = null;

  const renderStatus = (extra) => {
    if (!status) return;
    const c = _scannerCounts;
    const bits = [`${c.sent} sent`];
    // Every rejection is counted. A gate that silently discards most frames
    // is indistinguishable from a camera that is not working.
    if (_gateCounts && _gateCounts.analysed) {
      const g = _gateCounts;
      const rejected = g.blurry + g.clipped + g.too_small;
      if (rejected) bits.push(`${rejected} frames rejected`);
    }
    if (c.inflight) bits.push(`${c.inflight} sending`);
    if (c.failed) bits.push(`${c.failed} FAILED`);
    status.textContent = (extra ? extra + ' — ' : '') + bits.join(' · ');
  };

  // Fire-and-forget: the upload must never gate the next capture. This is
  // the whole point of the mode — shoot the stack at the operator's pace,
  // let the network catch up behind them.
  const send = (dataUrl) => {
    _scannerCounts.captured++;
    _scannerCounts.inflight++;
    renderStatus();
    uploadRawScanToRoom(dataUrl)
      .then((r) => {
        if (r && r.ok) _scannerCounts.sent++;
        else {
          _scannerCounts.failed++;
          console.warn('[SCANNER] upload rejected:', r);
        }
      })
      .catch((e) => {
        _scannerCounts.failed++;
        console.warn('[SCANNER] upload threw:', e);
      })
      .finally(() => {
        _scannerCounts.inflight--;
        renderStatus();
      });
  };

  const setMode = (label) => {
    const el = document.getElementById('scannerModeLabel');
    if (el) el.textContent = label;
  };

  const showFallback = (message) => {
    if (camWrap) camWrap.style.display = 'none';
    if (fallback) fallback.style.display = 'block';
    if (fbMsg) fbMsg.textContent = message;
    setMode('CAMERA-APP FALLBACK (asks you to confirm each shot)');
    if (shutter) shutter.style.display = 'none';
    const input = document.getElementById('scannerFileInput');
    const fileBtn = document.getElementById('scannerFileBtn');
    if (fileBtn && input) fileBtn.addEventListener('click', () => input.click());
    if (input) input.addEventListener('change', (ev) => {
      const f = ev.target.files?.[0];
      ev.target.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => send(reader.result);
      reader.readAsDataURL(f);
    });
  };

  (async () => {
    const capture = await import('../capture.js');
    const res = await capture.startCamera(video);

    if (!res.ok) {
      // Never fail silently to a dead button — say which of the handful of
      // real causes it was, so the operator can act on it at a table.
      const why = {
        denied:    'Camera permission was refused. Allow it in the browser address bar, then reload.',
        no_camera: 'No camera found on this device.',
        in_use:    'The camera is being used by another app. Close it and reload.',
        insecure:  'The camera needs an HTTPS connection.',
        unsupported: 'This browser cannot open a live camera.',
        no_frames: 'The camera opened but sent no picture.',
      }[res.reason] || ('Camera failed: ' + res.error);
      showFallback(why + ' Falling back to the phone camera app (slower — it asks you to confirm each shot).');
      renderStatus('camera unavailable');
      return;
    }

    if (camWrap) camWrap.style.display = 'block';
    setMode('LIVE CAMERA (no confirm step)');
    renderStatus('ready');

    if (torchBtn && capture.hasTorch()) {
      let on = false;
      torchBtn.style.display = 'inline-flex';
      torchBtn.addEventListener('click', async () => {
        on = !on;
        const applied = await capture.setTorch(on);
        if (!applied) on = false;
        torchBtn.classList.toggle('primary', on);
      });
    }

    // ── Frame gate ───────────────────────────────────────────────────
    // MEASURED (docs/V3_BENCHMARK.md §19): sharpness is the single largest
    // predictor of a correct identification — 69% of all failures sat in the
    // blurriest third of the photo set, and the sharpest third scored 88%
    // against 68.6% overall. A soft frame is not a hard card, it is a frame
    // that should never have been sent.
    const gate = await import('../frame-gate.js');
    const reticle = document.getElementById('scannerReticle');
    const hintEl = document.getElementById('scannerHint');
    const gcanvas = document.createElement('canvas');
    let lastVerdict = null;
    const stabilise = gate.createStabiliser();

    const COLOURS = { green: '#3ddc84', amber: '#ffb020', red: '#ff5c5c' };

    function analyse() {
      if (!video.videoWidth || document.hidden) return;
      const S = gate.ANALYSIS_SIZE;
      const scale = Math.min(1, S / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(8, Math.round(video.videoWidth * scale));
      const h = Math.max(8, Math.round(video.videoHeight * scale));
      if (gcanvas.width !== w) { gcanvas.width = w; gcanvas.height = h; }
      const ctx = gcanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const v = stabilise(gate.gateFrame(ctx.getImageData(0, 0, w, h)));
      _gateCounts = gate.getGateCounts();
      lastVerdict = v;
      const colour = v.locked ? COLOURS.green : (v.state === 'red' ? COLOURS.red : COLOURS.amber);
      if (reticle) {
        reticle.style.borderColor = colour;
        reticle.style.boxShadow = v.locked ? `0 0 0 3px ${colour}55` : 'none';
      }
      // One word, never a number. Nobody reads a variance score over a table.
      if (hintEl) hintEl.textContent = v.locked ? 'Ready' : v.hint;
    }
    const gateTimer = setInterval(analyse, 120);
    window.addEventListener('pagehide', () => clearInterval(gateTimer));

    const grab = () => {
      // Refuse a frame the gate has not cleared. Force-capture stays available
      // by tapping again immediately — a forced shot is TAGGED, not blocked.
      if (lastVerdict && !lastVerdict.locked && !_forceNext) {
        _forceNext = true;
        setTimeout(() => { _forceNext = false; }, 1500);
        if (hintEl) hintEl.textContent = lastVerdict.hint + ' — tap again to force';
        if (navigator.vibrate) { try { navigator.vibrate([30, 60, 30]); } catch { /* unsupported */ } }
        return;
      }
      _forceNext = false;
      const dataUrl = capture.captureFrame(video);
      if (!dataUrl) { renderStatus('no frame — hold still'); return; }
      // Visual confirmation only; the viewfinder never stops, so the next
      // card can be shot immediately.
      if (flash) {
        flash.style.opacity = '0.75';
        setTimeout(() => { flash.style.opacity = '0'; }, 120);
      }
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch { /* unsupported */ } }
      send(dataUrl);
    };

    if (shutter) shutter.addEventListener('click', grab);
    // Tapping the preview shoots too — faster than reaching for the button.
    if (camWrap) camWrap.addEventListener('click', grab);
    // Volume-key shutters surface as keydown on some Android browsers.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); grab(); }
    });

    // Release the camera when backgrounded — a three-hour session on
    // battery is the real constraint — and reopen on return.
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        capture.stopCamera();
        renderStatus('paused');
      } else if (!capture.isRunning()) {
        const again = await capture.startCamera(video);
        renderStatus(again.ok ? 'ready' : 'camera did not reopen — reload');
      }
    });
    window.addEventListener('pagehide', () => capture.stopCamera());
  })();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
