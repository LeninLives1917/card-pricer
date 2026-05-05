// apps/vendor/modules/bulk.js
//
// Bulk-mode pipeline: many photos → identify-stream → /api/price → session log.
// Concurrency 4. Queue persists to localStorage WITHOUT full data URLs (audit
// §1b — keeps under the 5MB localStorage cap).
//
// Image pipeline sizes (audit §5.9, memory image_pipeline.md):
//   - upload version: 2400px @ q0.95 (binder pages need small text legible)
//   - thumbnail:      600px @ q0.85
// resizeDataUrl helper lives here so other modules can reuse it; the
// historical bug (silent shrink to ~700px) is the canonical thing to avoid.

import { postJson, streamNdjson } from './api-client.js';
import { state, KEYS, saveAllSessions } from './state.js';

const BULK_CONCURRENCY = 4;
let _activeWorkers = 0;
let _onUpdate = null;     // callback(state) → tab can re-render
let _onItemDone = null;   // callback(result, item) → session log adds entry

export function initBulk({ onUpdate, onItemDone } = {}) {
  _onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
  _onItemDone = typeof onItemDone === 'function' ? onItemDone : null;
  loadBulkQueue();
}

// ============================================================
// Image helpers
// ============================================================

// Resize a data URL to fit within maxDimension on its longest side.
// Returns the original URL unchanged if no resize is needed or if anything
// goes wrong (defensive: never silently shrink below the requested size —
// the V1 bug we're guarding against).
export function resizeDataUrl(dataUrl, opts = {}) {
  const {
    maxDimension = null,
    quality = 0.95,
    maxBytes = 5 * 1024 * 1024,
  } = opts;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return resolve(dataUrl);
        let scale = 1;
        if (maxDimension && Math.max(w, h) > maxDimension) {
          scale = maxDimension / Math.max(w, h);
        }
        const tw = Math.round(w * scale);
        const th = Math.round(h * scale);
        if (tw === w && th === h && quality >= 0.95) return resolve(dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        canvas.getContext('2d').drawImage(img, 0, 0, tw, th);
        const out = canvas.toDataURL('image/jpeg', quality);
        if (out.length > maxBytes && quality > 0.6) {
          // Try one more pass at lower quality before giving up.
          canvas.getContext('2d').drawImage(img, 0, 0, tw, th);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } else {
          resolve(out);
        }
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ============================================================
// Queue persistence
// ============================================================

export function saveBulkQueue() {
  try {
    // Strip the upload-size dataUrl before persisting; thumbs only.
    const slim = state.bulkQueue.map((item) => ({
      ...item,
      dataUrl: item.thumbUrl || '',
      thumbUrl: item.thumbUrl || '',
    }));
    const payload = JSON.stringify(slim);
    if (payload.length > 4 * 1024 * 1024) {
      localStorage.removeItem(KEYS.bulkQueue);
      return;
    }
    localStorage.setItem(KEYS.bulkQueue, payload);
  } catch (e) {
    console.warn('[BULK] persist failed:', e?.message || e);
    try { localStorage.removeItem(KEYS.bulkQueue); } catch {}
  }
}

export function loadBulkQueue() {
  try {
    const raw = localStorage.getItem(KEYS.bulkQueue);
    if (!raw) return;
    const restored = JSON.parse(raw);
    if (!Array.isArray(restored) || !restored.length) return;
    state.bulkQueue = restored.map((item) => ({
      ...item,
      status: item.status === 'processing' ? 'queued' : item.status,
    }));
    state._bulkSeq = state.bulkQueue.reduce((m, i) => Math.max(m, i.id || 0), 0);
    notifyUpdate();
  } catch (e) {
    console.warn('[BULK] restore failed:', e?.message || e);
  }
}

function notifyUpdate() {
  if (_onUpdate) {
    try { _onUpdate(state); } catch (e) { console.warn(e); }
  }
}

// ============================================================
// File ingest
// ============================================================

export async function handleBulkFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  for (const f of list) {
    let rawUrl;
    try { rawUrl = await readFileAsDataUrl(f); } catch { continue; }
    let uploadUrl, thumbUrl;
    try {
      uploadUrl = await resizeDataUrl(rawUrl, { maxDimension: 2400, quality: 0.95 });
    } catch { uploadUrl = rawUrl; }
    try {
      thumbUrl = await resizeDataUrl(uploadUrl, { maxDimension: 600, quality: 0.85 });
    } catch { thumbUrl = uploadUrl; }
    state.bulkQueue.push({
      id: ++state._bulkSeq,
      name: f.name || ('card-' + state._bulkSeq),
      dataUrl: uploadUrl,
      thumbUrl,
      status: 'queued',
    });
    notifyUpdate();
    startBulkProcess();
  }
  saveBulkQueue();
}

export function removeBulkItem(id) {
  state.bulkQueue = state.bulkQueue.filter((i) => i.id !== id);
  notifyUpdate();
  saveBulkQueue();
}

export function clearBulkQueue() {
  if (_activeWorkers > 0) return;
  state.bulkQueue = [];
  notifyUpdate();
  saveBulkQueue();
}

export function retryBulkFailed() {
  if (_activeWorkers > 0) return;
  let retried = 0;
  for (const item of state.bulkQueue) {
    if (item.status === 'error') {
      item.status = 'queued';
      item.name_short = undefined;
      retried++;
    }
  }
  if (!retried) return;
  notifyUpdate();
  saveBulkQueue();
  startBulkProcess();
}

// ============================================================
// Worker pool
// ============================================================

// Idempotent — call from anywhere. Spawns up to (BULK_CONCURRENCY -
// _activeWorkers) workers; each worker picks live items from the queue.
export function startBulkProcess() {
  const pendingCount = state.bulkQueue.filter((i) => i.status === 'queued').length;
  if (!pendingCount) return;
  const slots = Math.min(BULK_CONCURRENCY - _activeWorkers, pendingCount);
  for (let i = 0; i < slots; i++) bulkWorker();
}

async function bulkWorker() {
  _activeWorkers++;
  notifyUpdate();
  try {
    while (true) {
      const item = state.bulkQueue.find((i) => i.status === 'queued');
      if (!item) break;
      item.status = 'processing';
      notifyUpdate();
      try {
        await processBulkItem(item);
        item.status = 'done';
      } catch (e) {
        console.error('[BULK] failed:', item.name, e);
        item.status = 'error';
        item.name_short = 'Err';
        item.error_message = e?.message || String(e);
      }
      // Free the upload-size image after processing — only thumbnail kept.
      if (item.status !== 'queued') {
        item.dataUrl = item.thumbUrl || '';
      }
      notifyUpdate();
      saveBulkQueue();
    }
  } finally {
    _activeWorkers--;
    notifyUpdate();
  }
}

async function processBulkItem(item) {
  const uploadImage = item.dataUrl;
  if (!uploadImage) throw new Error('No image data');

  // S15 (A2) will rewire OCR-first via the validation gate. For S7 we go
  // straight to identify-stream — the OCR-first path is dead code in V1.
  const idResult = await streamNdjson('/api/identify-stream', {
    image: uploadImage,
    batch: false,
    hint: '',
  });
  if (!idResult.ok) {
    // Fallback to /api/identify (non-stream) — mirrors V1 behaviour.
    const fb = await postJson('/api/identify', { image: uploadImage, hint: '' });
    if (!fb.ok) throw new Error(fb.error || 'identify failed');
    idResult.body = fb.body;
    idResult.ok = true;
  }
  const cards = idResult.body?.cards || [];
  if (!cards.length) throw new Error('No card detected');
  const card = cards[0];
  item.name_short = card.name ? card.name.slice(0, 14) : '';

  // Price it.
  const priced = await postJson('/api/price', {
    card,
    buyPercentage: state.buyPercentage,
  });
  const result = priced.ok
    ? priced.body
    : { card, cardmarket: null, ebay: null, buy_price: null };

  // Hand the result to the session-log adder.
  if (_onItemDone) {
    try { _onItemDone(result, item); }
    catch (e) { console.warn('[BULK] onItemDone threw:', e); }
  } else {
    // Default behaviour if the tab didn't register a sink: append to the
    // current session's log directly so the data isn't lost.
    const sess = state.sessions[state.currentSessionId];
    if (sess) {
      sess.log.unshift({
        ...result,
        image: item.thumbUrl || item.dataUrl || '',
        ts: Date.now(),
      });
      saveAllSessions();
    }
  }
}

export function bulkStatus() {
  return {
    total: state.bulkQueue.length,
    done: state.bulkQueue.filter((i) => i.status === 'done').length,
    errored: state.bulkQueue.filter((i) => i.status === 'error').length,
    running: _activeWorkers > 0,
    activeWorkers: _activeWorkers,
  };
}
