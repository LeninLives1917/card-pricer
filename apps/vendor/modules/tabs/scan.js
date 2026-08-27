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
import { parseTextEntryLines, isUnsupportedLang } from '../text-parse.js';
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

    // The old cascade drops a lot of perfectly good lines to pattern 5 with no
    // card_number — "charizard 4/102" and "cha 4/102" among them — and this
    // guard then turned them into error rows before they were ever sent. The
    // server now tokenises the raw line itself, so the only lines worth
    // refusing here are the ones with no digits at all: without a collector
    // number there is nothing to resolve against, and the catalogue is just
    // 6.9% unique on a name alone.
    if (!/\d/.test(row.raw || '')) {
      state.currentResults.push(makeErrorRow(row, 'Need a card number'));
      continue;
    }

    // The catalogue is English-only (174 sets from pokemontcg.io, zero
    // Japanese/Korean/Chinese). A JP card shares neither set, numbering nor
    // set size with its English counterpart — but for a commonly-reprinted
    // Pokemon there is a measured 22.7% chance its (name, number) ALSO exists
    // in English, and the lookup's last-resort query is set-agnostic. So
    // roughly one in four would come back as a confident English card at
    // English prices. Say so instead.
    if (isUnsupportedLang(row.lang)) {
      state.currentResults.push(makeErrorRow(row,
        `${String(row.lang).toUpperCase()} cards aren't supported — the catalogue is English-only`));
      continue;
    }

    const payload = {
      game,
      set_code: row.set_code,
      card_number: row.card_number,
      name: row.name,
      // What the operator actually typed. The tokeniser runs SERVER-SIDE,
      // next to the catalogue, because that is the only place the ambiguity
      // can be settled: "cha 4/102" and "MEG 172/132" are the same shape and
      // only the catalogue knows which token is a set code. The parsed fields
      // above are still sent, and are used if the raw line resolves nothing.
      text: row.raw,
      // Parsed since the first version of this panel and never sent. The
      // denominator is the single strongest disambiguator available: name +
      // number resolves 88.5% of the catalogue uniquely, name + number +
      // printed total resolves 99.6%.
      total: row.total,
      lang: row.lang,
    };
    const r = await postJson('/api/identify-manual', payload);

    // AMBIGUOUS — more than one real card fits the line. HTTP 200 with an
    // empty `cards` and the candidates beside it, so this branch is reached
    // before the generic no-match one below and the row becomes a question
    // rather than an error. Any caller that has NOT been updated still lands
    // in the no-match branch and shows an error row: a question degrades to
    // "couldn't price it", never to a wrong price.
    // MULTI — the line is more than one card run together. Show the split so
    // the operator can fix the paste, rather than an error they have to work
    // out for themselves.
    if (r.ok && r.body?.resolution?.status === 'multi') {
      // Carry the resolved pieces onto the row so results.js can offer the
      // split as a BUTTON. Telling the operator to retype a line the system
      // has already worked out is not an answer, it is homework.
      state.currentResults.push({
        card: { name: row.raw, set_code: '', card_number: '' },
        pieces: r.body.resolution.pieces.map((p) => ({
          text: p.text,
          status: p.status,
          card_id: p.card_id,
          card: p.candidates?.[0] || null,
        })),
        _parsed_line: row.raw,
        _payload: payload,
      });
      continue;
    }

    if (r.ok && r.body?.resolution?.status === 'ambiguous' && r.body.resolution.candidates?.length) {
      state.currentResults.push({
        card: { name: row.name || row.raw, set_code: row.set_code || '', card_number: row.card_number || '' },
        candidates: r.body.resolution.candidates,
        _parsed_line: row.raw,
        _payload: payload,
      });
      continue;
    }

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
const SCANNER_BUILD = 'v3.7-camera-controls';

// Upload tally. Shown to the operator, because "sent" with nothing arriving
// on the laptop is precisely the failure this mode shipped with.
const _scannerCounts = { captured: 0, sent: 0, failed: 0, inflight: 0, unwatched: 0 };

function showScannerMode() {
  const root = document.getElementById('tab-scan');
  if (!root) return;

  root.innerHTML = `
    <div class="surface" style="margin:var(--p-3) 0;">
      <div class="display" style="font-size:18px; margin-bottom:var(--p-2);">Phone connected</div>
      <div id="scannerCamWrap" style="position:relative; border-radius:10px; overflow:hidden; background:#000; display:none;">
        <!-- object-fit is contain, not cover. The reticle defines the region
             the frame gate analyses, so the box on screen and the box in the
             sensor frame must be the same rectangle. Under cover the browser
             crops the overflow, the two diverge, and the operator lines the
             card up against a rectangle nothing is grading. -->
        <video id="scannerVideo" playsinline autoplay muted
               style="width:100%; display:block; max-height:60vh; object-fit:contain;"></video>
        <div id="scannerFlash" style="position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; transition:opacity 120ms;"></div>
        <!-- Framing reticle. Card aspect is 63x88mm; filling this box puts the
             most pixels on the collector number, the field behind ~30% of
             failures. POSITIONED FROM JS (capture.reticleRect + containedBox),
             not from CSS percentages — a percentage of the element is not a
             percentage of the sensor frame, and the gate reads the sensor. -->
        <div id="scannerReticle" style="position:absolute; border:3px solid rgba(255,255,255,.5);
             border-radius:10px; pointer-events:none; transition:border-color 120ms, box-shadow 120ms;"></div>
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
        <button class="btn" id="scannerAuto" style="padding:18px 14px;"
                aria-pressed="false" title="Fire the shutter automatically when a card is framed and sharp">Auto</button>
        <button class="btn" id="scannerTorch" style="display:none; padding:18px 14px;" aria-label="Toggle torch">Light</button>
      </div>
      <div id="scannerStatus" style="font-size:11px; color:var(--paper-300); margin-top:var(--p-2); min-height:14px;"></div>
      <div id="scannerBuild" style="font-size:10px; color:var(--paper-300); opacity:0.65; margin-top:var(--p-1);">
        build ${SCANNER_BUILD} · mode <span id="scannerModeLabel">starting…</span>
      </div>
      <div id="scannerGateDebug" style="font-size:10px; color:var(--paper-300); opacity:0.55; margin-top:2px; font-variant-numeric:tabular-nums;"></div>
    </div>`;

  const video    = document.getElementById('scannerVideo');
  const camWrap  = document.getElementById('scannerCamWrap');
  // (the flash element is looked up inside signal(), where it is used)
  const shutter  = document.getElementById('scannerShutter');
  const torchBtn = document.getElementById('scannerTorch');
  const status   = document.getElementById('scannerStatus');
  const fallback = document.getElementById('scannerFallback');
  const fbMsg    = document.getElementById('scannerFallbackMsg');
  const autoBtn  = document.getElementById('scannerAuto');

  let _gateCounts = null;
  let _autoOn = false;

  const renderStatus = (extra) => {
    if (!status) return;
    const c = _scannerCounts;
    const bits = [`${c.sent} sent`];
    // Every rejection is counted. A gate that silently discards most frames
    // is indistinguishable from a camera that is not working.
    if (_gateCounts && _gateCounts.analysed) {
      const g = _gateCounts;
      const rejected = g.blurry + g.empty;
      if (rejected) bits.push(`${rejected} frames rejected`);
    }
    if (c.inflight) bits.push(`${c.inflight} sending`);
    if (c.failed) bits.push(`${c.failed} FAILED`);
    // NOT the same thing as failed, and much easier to miss. See send().
    if (c.unwatched) bits.push(`${c.unwatched} WITH NOBODY WATCHING`);
    status.textContent = (extra ? extra + ' — ' : '') + bits.join(' · ');
  };

  // Fire-and-forget: the upload must never gate the next capture. This is
  // the whole point of the mode — shoot the stack at the operator's pace,
  // let the network catch up behind them.
  //
  // WHAT `ok` MEANS HERE, AND WHAT IT DOES NOT.
  //
  // In scanner mode the phone POSTs to /api/room/:id/scan and the LAPTOP does
  // the identifying. The phone is never told what the card was — there is no
  // return channel for that — so `ok: true` means "the room accepted the
  // bytes" and nothing more. It is true when the laptop's tab has been closed
  // for an hour.
  //
  // The room says so in the same response: `listeners` is the number of
  // subscribers on the SSE stream. This code used to ignore it and count the
  // upload as sent, which means the operator could shoot a whole box into a
  // ring buffer with the counter reading "47 sent" and be told nothing. That
  // is the failure the confirmation flash is supposed to prevent, and the
  // flash was firing on the shutter tap, before the request had even left.
  //
  // So: confirm on the RESPONSE, and only when somebody was listening.
  const send = (dataUrl, { auto = false } = {}) => {
    _scannerCounts.captured++;
    _scannerCounts.inflight++;
    renderStatus();
    uploadRawScanToRoom(dataUrl)
      .then((r) => {
        if (!r || !r.ok) {
          _scannerCounts.failed++;
          signal('bad');
          console.warn('[SCANNER] upload rejected:', r);
          return;
        }
        _scannerCounts.sent++;
        // `listeners` is absent on older servers. Absent is not zero — an
        // unknown must not be reported as a confirmed nobody, so it takes
        // the benefit of the doubt and is counted separately.
        if (r.listeners === 0) {
          _scannerCounts.unwatched++;
          signal('bad');
          renderStatus('NOBODY IS RECEIVING — check the laptop');
          return;
        }
        signal('good');
      })
      .catch((e) => {
        _scannerCounts.failed++;
        signal('bad');
        console.warn('[SCANNER] upload threw:', e);
      })
      .finally(() => {
        _scannerCounts.inflight--;
        renderStatus();
      });
  };

  // The "move on to the next card" cue. Deliberately fired from the response
  // rather than from the shutter: a flash the instant the operator taps
  // confirms only that the phone took a picture, which is the one part
  // nobody doubts.
  //
  // Two distinguishable cues, because one cue that fires either way is
  // decoration. Long buzz and a red wash means stop and look.
  const signal = (kind) => {
    const flashEl = document.getElementById('scannerFlash');
    if (flashEl) {
      flashEl.style.background = kind === 'good' ? '#fff' : '#ff5c5c';
      flashEl.style.opacity = kind === 'good' ? '0.75' : '0.55';
      setTimeout(() => { flashEl.style.opacity = '0'; }, kind === 'good' ? 120 : 320);
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(kind === 'good' ? 15 : [40, 60, 40]); } catch { /* unsupported */ }
    }
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

    // Ask for continuous focus and exposure metered on the centre of the
    // frame, where the reticle has put the card. V1 did this and the V3
    // rewrite dropped it, so until now every frame was shot on whatever
    // autofocus decided about a flat glossy object on a textured table.
    // Optional everywhere, counted everywhere — see cameraReport().
    await capture.applyCameraControls();

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
    const loop = await import('../scan-loop.js');
    const reticle = document.getElementById('scannerReticle');
    const hintEl = document.getElementById('scannerHint');
    const gcanvas = document.createElement('canvas');
    let lastVerdict = null;
    let prevRoi = null;
    const stabilise = gate.createStabiliser();
    const autoFire = loop.createAutoFire();

    const COLOURS = { green: '#3ddc84', amber: '#ffb020', red: '#ff5c5c' };

    // Lay the reticle over where `contain` actually paints the frame, which is
    // not the element — it is letterboxed inside it.
    function placeReticle() {
      if (!reticle || !video.videoWidth) return;
      const box = capture.containedBox(video.clientWidth, video.clientHeight,
        video.videoWidth, video.videoHeight);
      const r = capture.reticleRect(video.videoWidth, video.videoHeight);
      reticle.style.left = `${box.left + r.x * box.width}px`;
      reticle.style.top = `${box.top + r.y * box.height}px`;
      reticle.style.width = `${r.w * box.width}px`;
      reticle.style.height = `${r.h * box.height}px`;
    }
    window.addEventListener('resize', placeReticle);
    window.addEventListener('orientationchange', placeReticle);

    function analyse() {
      if (!video.videoWidth || document.hidden) return;
      placeReticle();

      // Grade the box the operator is filling, not a card hunted for in the
      // whole frame. locateCard's bounding box spans the table and the hand
      // on any real frame, which is why the original gate never went green
      // and had to be demoted to advisory.
      const roiImg = capture.drawReticle(video, gcanvas);
      if (!roiImg) return;
      const delta = gate.sceneDelta(prevRoi, roiImg);
      prevRoi = roiImg;

      const v = stabilise(gate.gateReticle(roiImg));
      _gateCounts = gate.getReticleCounts();
      lastVerdict = v;

      const colour = v.locked ? COLOURS.green : (v.state === 'red' ? COLOURS.red : COLOURS.amber);
      if (reticle) {
        reticle.style.borderColor = colour;
        reticle.style.boxShadow = v.locked ? `0 0 0 3px ${colour}55` : 'none';
      }
      // One word, never a number. Nobody reads a variance score over a table.
      if (hintEl) hintEl.textContent = v.locked ? 'Ready' : v.hint;
      const dbg = document.getElementById('scannerGateDebug');
      if (dbg) {
        const a = autoFire.counts();
        // Which controls the phone actually honoured. A control that silently
        // does nothing is worse than no control: it produces an operator who
        // believes the camera is locked. '?' is never-asked, not refused.
        const cam = capture.cameraReport();
        const flag = (v2) => (v2 === null ? '?' : v2 ? 'y' : 'n');
        dbg.textContent = `sharp ${Math.round(v.sharpness)} · detail ${v.detail.toFixed(2)}`
          + ` · ${v.state}${_autoOn ? ` · auto ${a.fired}/${a.frames}` : ''}`
          + ` · af${flag(cam.focus)} ae${flag(cam.exposure)} still${flag(cam.still)}`;
      }

      if (!_autoOn) return;
      // Auto-fire decides on its own state machine, not on the reticle lock:
      // going green is cheap to get wrong when a human then presses a button
      // and expensive to get wrong when the shutter fires itself.
      const d = autoFire({ state: v.state, sceneDelta: delta, now: Date.now() });
      if (d.fire) grab({ auto: true });
    }

    const gateTimer = setInterval(analyse, 120);
    window.addEventListener('pagehide', () => clearInterval(gateTimer));

    const grab = (opts = {}) => {
      // The gate is ADVISORY for a manual tap and DECIDING for auto-fire.
      //
      // It shipped blocking, never went green on real frames, and was demoted
      // — the cause was locateCard, now routed around rather than repaired
      // (see frame-gate.js). The new thresholds are still unvalidated against
      // live video, so the same rule stands: a tap always fires. Auto-fire is
      // opt-in, and it is the only thing the gate is allowed to gate.
      // Full-sensor still where the device offers one; the preview grab is
      // capped at 1600px, which is LOWER than the benchmark photographs the
      // pipeline was measured on. Falls back automatically and records which
      // path ran, so a device that quietly refuses is visible rather than
      // just slightly worse.
      capture.captureStill(video).then((dataUrl) => {
        if (!dataUrl) { renderStatus('no frame — hold still'); return; }
        send(dataUrl, opts);
      });
    };

    // The Auto toggle. DEFAULT OFF, deliberately: the last gate that decided
    // anything on unvalidated thresholds stopped the operator working, and
    // this one's DETAIL_MIN has no measurement behind it at all — there are no
    // photographs of an empty table in the benchmark set, so the negative
    // class is unmeasured. It earns its default when fired/identified says so.
    if (autoBtn) {
      autoBtn.addEventListener('click', () => {
        _autoOn = !_autoOn;
        autoFire.reset();
        autoBtn.classList.toggle('primary', _autoOn);
        autoBtn.setAttribute('aria-pressed', String(_autoOn));
        if (shutter) shutter.textContent = _autoOn ? 'Capture (auto on)' : 'Capture';
        renderStatus(_autoOn ? 'auto — hold a card in the box' : 'auto off');
      });
    }

    if (shutter) shutter.addEventListener('click', grab);
    // Tapping the preview shoots — faster than reaching for the button. In
    // hands-free mode there is nothing to shoot manually, so the same tap
    // becomes tap-to-focus, which is the control most likely to rescue a card
    // autofocus has given up on.
    if (camWrap) camWrap.addEventListener('click', (e) => {
      if (!_autoOn) return grab();
      const r = camWrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      capture.focusAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
        .then((ok) => renderStatus(ok ? 'refocusing…' : 'this camera has no tap-to-focus'));
    });
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

// ============================================================
// Ambiguity picker — the operator answers the question
// ============================================================
//
// results.js renders an amber row with one chip per candidate and fires
// cp:candidate-chosen when one is tapped. Re-running the lookup with the
// chosen SET pinned turns the ambiguous line into an exact set-code + number
// lookup, which is unique by construction — so the answer cannot be
// ambiguous a second time.

window.addEventListener('cp:candidate-chosen', async (ev) => {
  const { resultIndex, candidate, rank, of } = ev.detail || {};
  const entry = state.currentResults?.[resultIndex];
  if (!entry || !candidate) return;

  console.log(`[TEXT] operator picked candidate ${rank + 1} of ${of}: `
    + `${candidate.name} (${candidate.set_name})`);

  const payload = {
    ...(entry._payload || {}),
    // set_id + number is the catalogue key. Pinning it removes every degree
    // of freedom the ambiguity came from.
    set_code: candidate.set_id,
    card_number: candidate.card_number,
    name: candidate.name,
  };

  const r = await postJson('/api/identify-manual', payload);
  const card = r.ok ? r.body?.cards?.[0] : null;
  if (!card) {
    state.currentResults[resultIndex] = makeErrorRow(
      { raw: entry._parsed_line, name: candidate.name },
      r.body?.error || 'lookup failed after picking',
    );
    window.dispatchEvent(new CustomEvent('cp:results-changed'));
    return;
  }

  const priced = await postJson('/api/price', { card, buyPercentage: state.buyPercentage });
  const result = priced.ok ? priced.body : { card, cardmarket: null, ebay: null, buy_price: null };
  state.currentResults[resultIndex] = result;

  const sess = currentSession();
  if (sess) {
    sess.log.unshift({ ...result, ts: Date.now() });
    saveAllSessions();
    window.dispatchEvent(new CustomEvent('cp:log-changed'));
  }
  window.dispatchEvent(new CustomEvent('cp:results-changed'));
});

// ============================================================
// Split confirmation — the operator says "yes, that was two cards"
// ============================================================
//
// results.js renders the multi row with the pieces named and fires
// cp:split-confirmed when the operator agrees. Each piece is looked up by its
// own text — the same path any typed line takes — then priced, and the single
// question row is replaced by the resulting cards in place.

window.addEventListener('cp:split-confirmed', async (ev) => {
  const { resultIndex } = ev.detail || {};
  const entry = state.currentResults?.[resultIndex];
  if (!entry?.pieces?.length) return;

  console.log(`[TEXT] operator confirmed a ${entry.pieces.length}-card split: `
    + entry.pieces.map((p) => p.text).join(' + '));

  const priced = [];
  for (const piece of entry.pieces) {
    const r = await postJson('/api/identify-manual', {
      ...(entry._payload || {}),
      // Only the piece's own text. The parsed fields on the original payload
      // describe the whole run-together line and would fight it.
      text: piece.text,
      set_code: undefined,
      card_number: undefined,
      name: undefined,
      total: undefined,
    });
    const card = r.ok ? r.body?.cards?.[0] : null;
    if (!card) {
      priced.push(makeErrorRow({ raw: piece.text, name: piece.text },
        r.body?.error || 'could not price this half'));
      continue;
    }
    const p = await postJson('/api/price', { card, buyPercentage: state.buyPercentage });
    priced.push(p.ok ? p.body : { card, cardmarket: null, ebay: null, buy_price: null });
  }

  // Replace the one question row with the cards it turned into.
  state.currentResults.splice(resultIndex, 1, ...priced);

  const sess = currentSession();
  if (sess) {
    for (const row of priced) if (!row.error) sess.log.unshift({ ...row, ts: Date.now() });
    saveAllSessions();
    window.dispatchEvent(new CustomEvent('cp:log-changed'));
  }
  window.dispatchEvent(new CustomEvent('cp:results-changed'));
});
