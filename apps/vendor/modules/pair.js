// apps/vendor/modules/pair.js
//
// Phone-pair flows. Two roles:
//   - HOST (laptop) — opens an SSE channel to /api/room/:id/stream and
//     renders a QR pointing at  https://<origin>/?pair=ROOMID  for the
//     phone to scan. Receives raw images from the phone, runs them
//     through identify-stream + price locally, appends to the session log.
//   - SCANNER (phone) — joined via URL param ?pair=ROOMID. Auth bypassed
//     entirely (audit §5.14). Tap-to-capture from the camera, then POST
//     the raw image to /api/room/:id/scan.
//
// QR rendering — primary api.qrserver.com, Google Charts fallback (audit §1b).

import { request, postJson } from './api-client.js';
import { state } from './state.js';
import { unwrapScanFrame, FRAME_ACTIONS } from './pair-frame.js';

let _eventSource = null;
let _roomId = null;
let _onScanReceived = null;   // callback(card-or-image-result) — host side

export function setOnScanReceived(fn) {
  _onScanReceived = typeof fn === 'function' ? fn : null;
}

export function randomRoomId() {
  // 6 base-36 chars — ~10^9 space, secret-by-obscurity (audit §4).
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function pairUrl(roomId) {
  const u = new URL(window.location.href);
  u.searchParams.set('pair', roomId);
  u.search = u.searchParams.toString();
  // Strip everything except origin + pathname + ?pair
  return u.origin + u.pathname + '?pair=' + encodeURIComponent(roomId);
}

// ============================================================
// HOST (laptop)
// ============================================================

export function startHosting() {
  if (state.pairRole === 'host' && _roomId) {
    renderQRForRoom(_roomId);
    return _roomId;
  }
  state.pairRole = 'host';
  _roomId = randomRoomId();
  state.pairRoomId = _roomId;

  // Open SSE — the api-client doesn't wrap EventSource because it can't
  // (no headers) and that's fine: /api/room/:id/stream is unauthenticated.
  try {
    _eventSource = new EventSource('/api/room/' + encodeURIComponent(_roomId) + '/stream');
    _eventSource.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        receiveRemoteScan(payload);
      } catch (e) {
        console.warn('[PAIR] bad SSE payload:', e);
      }
    };
    _eventSource.onerror = () => {
      // Auto-reconnect handled by EventSource; just surface a status.
      const status = document.getElementById('pairStatus');
      if (status) status.textContent = 'Reconnecting…';
    };
  } catch (e) {
    console.warn('[PAIR] SSE failed:', e);
  }

  renderQRForRoom(_roomId);

  const status = document.getElementById('pairStatus');
  if (status) status.textContent = 'Hosting room ' + _roomId + '. Scan with phone.';

  return _roomId;
}

export function stopPairing() {
  if (_eventSource) { try { _eventSource.close(); } catch {} }
  _eventSource = null;
  _roomId = null;
  state.pairRole = null;
  state.pairRoomId = null;
  const wrap = document.getElementById('pairQRWrap');
  if (wrap) wrap.style.display = 'none';
  const status = document.getElementById('pairStatus');
  if (status) status.textContent = '';
  const url = document.getElementById('pairUrl');
  if (url) url.textContent = '';
}

function renderQRForRoom(roomId) {
  const wrap = document.getElementById('pairQRWrap');
  const urlOut = document.getElementById('pairUrl');
  if (!wrap) return;
  const url = pairUrl(roomId);
  wrap.style.display = 'block';
  if (urlOut) urlOut.textContent = url;

  const canvas = document.getElementById('pairQR');
  const fallbackImg = document.getElementById('pairQRImg');

  // Try the qrcode lib loaded from CDN (script tag in index.html).
  if (window.QRCode && canvas && typeof window.QRCode.toCanvas === 'function') {
    try {
      window.QRCode.toCanvas(canvas, url, { width: 240, margin: 1 }, (err) => {
        if (err) useApiQrServer(url);
        else if (fallbackImg) fallbackImg.style.display = 'none';
      });
      return;
    } catch (e) {
      console.warn('[PAIR] QRCode.toCanvas failed:', e);
    }
  }
  useApiQrServer(url);
}

function useApiQrServer(url) {
  const img = document.getElementById('pairQRImg');
  const canvas = document.getElementById('pairQR');
  if (!img) return;
  // Primary: api.qrserver.com; fallback: chart.googleapis.com.
  const primary = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(url);
  const fallback = 'https://chart.googleapis.com/chart?cht=qr&chs=240x240&chl=' + encodeURIComponent(url);
  img.onerror = () => { img.onerror = null; img.src = fallback; };
  img.src = primary;
  img.style.display = 'block';
  if (canvas) canvas.style.display = 'none';
}

// Delivery counters. CLAUDE.md: every fallback path increments a counter
// something reads. A phone scan that never reaches the laptop must be
// countable, not merely absent.
const _counts = {
  messages: 0,        // SSE frames parsed
  non_scan: 0,        // hello / control frames — expected, not a failure
  delivered: 0,       // handed to the host handler
  deduped: 0,         // already seen (bridge replay or double-broadcast)
  dropped_no_image: 0, // envelope present but carried no image — a DEFECT
};
export function getPairCounts() { return { ..._counts }; }

const _seenScanIds = new Set();

// Host receives a scan event from the SSE stream. The envelope contract and
// the reason it bit us live in pair-frame.js, where node --test can reach it.
async function receiveRemoteScan(msg) {
  if (!msg) return;
  _counts.messages++;

  const { action, entry, reason } = unwrapScanFrame(msg, _seenScanIds);

  if (action === FRAME_ACTIONS.IGNORE) { _counts.non_scan++; return; }
  if (action === FRAME_ACTIONS.DEDUPE) { _counts.deduped++; return; }
  if (action === FRAME_ACTIONS.DROP) {
    _counts.dropped_no_image++;
    console.warn('[PAIR] scan frame dropped (' + reason + '):', Object.keys(msg || {}));
    showPairToast('Scan arrived but carried no image');
    return;
  }

  if (_onScanReceived) {
    try {
      await _onScanReceived(entry);
      _counts.delivered++;
    } catch (e) {
      console.warn('[PAIR] receive handler threw:', e);
      showPairToast('Scan received but failed to process');
      return;
    }
  }
  showPairToast('Scan received from phone');
}

// ============================================================
// SCANNER (phone) — bypasses auth, only POSTs to /api/room/:id/scan
// ============================================================

export function joinAsScanner(roomId) {
  if (!roomId) return;
  state.pairRole = 'scanner';
  state.pairRoomId = roomId;
  document.body.classList.add('scanner-mode');
}

// Phone uploads raw image data to the host's room. The api-client does not
// add Authorization (scanner-mode bypass) — confirmed by isScannerMode().
export async function uploadRawScanToRoom(imageData) {
  if (!state.pairRoomId) return { ok: false, error: 'no_room' };
  const path = '/api/room/' + encodeURIComponent(state.pairRoomId) + '/scan';
  return postJson(path, { image: imageData, ts: Date.now() });
}

// ============================================================
// Toast
// ============================================================

let _toastTimer = null;
function showPairToast(text) {
  let el = document.getElementById('pairToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pairToast';
    el.className = 'pair-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2200);
}
