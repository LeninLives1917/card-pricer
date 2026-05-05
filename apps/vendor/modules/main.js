// apps/vendor/modules/main.js
//
// Entry point for the V2 vendor app. The shell HTML loads this as
// <script type="module"> at the bottom. Wires the api-client hooks, the
// auth gate, the state init/sync, the tab modules, and the result-sheet /
// correct-modal / pwa primitives.
//
// Tab switching is handled here so each tab module only has to know about
// its own DOM. cp:nav events from anywhere in the app trigger switchTab.

import { setHooks } from './api-client.js';
import {
  showAuthOverlay, hideAuthOverlay, setAuthMode, submitAuth,
  signOut, initAuthGate, wireAuthOverlay,
} from './auth.js';
import {
  state, initializeSessions, pullStateFromServer, queueStateSync,
} from './state.js';
import { wireResultSheet, openResultSheet } from './result-sheet.js';
import { wireCorrectModal } from './correct.js';
import { registerServiceWorker, wireInstallNudge } from './pwa.js';
import { setOnScanReceived } from './pair.js';
import { postJson } from './api-client.js';

import * as scanTab from './tabs/scan.js';
import * as resultsTab from './tabs/results.js';
import * as sessionTab from './tabs/session.js';
import * as settingsTab from './tabs/settings.js';
import * as adminTab from './tabs/admin.js';

const TABS = ['scan', 'results', 'log', 'settings', 'admin'];

function switchTab(name) {
  if (!TABS.includes(name)) return;
  TABS.forEach((t) => {
    const pane = document.getElementById('tab-' + t);
    if (pane) pane.classList.toggle('hidden', t !== name);
    document.querySelectorAll(`[data-tab="${t}"]`).forEach((tabEl) => {
      tabEl.classList.toggle('active', t === name);
    });
  });
  window.dispatchEvent(new CustomEvent('cp:tab-shown', { detail: { tab: name } }));
}

// Public wiring for HTML buttons that don't have data-action handlers yet
// (status check, log button etc.).
function wireHeader() {
  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  const goLog = document.getElementById('headerLogBtn');
  if (goLog) goLog.addEventListener('click', () => switchTab('log'));
  const status = document.getElementById('headerStatusBtn');
  if (status) status.addEventListener('click', () => switchTab('admin'));
}

// Quota modal — V1 had a dedicated overlay (#planOverlay) that auto-shows
// on 429. We keep the surface simple here: a one-button modal that points
// the user at the customer portal / plan picker.
function showQuotaExceededModal(payload) {
  const overlay = document.getElementById('quotaOverlay');
  if (!overlay) {
    // No DOM hook — fall back to alert so the user still sees the issue.
    alert('Monthly scan quota reached. Upgrade your plan to continue.');
    return;
  }
  overlay.classList.remove('hidden');
  const msg = document.getElementById('quotaMsg');
  if (msg && payload) {
    msg.textContent = payload.detail || `You've used ${payload.used} of ${payload.limit} scans this month.`;
  }
}

function renderUsage(u) {
  // Settings tab knows how to draw the usage banner.
  settingsTab.renderUsage(u);
}

// Host receives a phone scan — run identify-stream + price + add to log.
async function onRemoteScan(payload) {
  // payload.image is a data URL the phone uploaded.
  const img = payload?.image;
  if (!img) return;
  // Use the bulk module's machinery via a synthetic queue entry. Cleaner
  // than duplicating the identify-stream call here.
  const { handleBulkFiles } = await import('./bulk.js');
  // We have a data URL already — synthesise a Blob → File → FileList-like.
  const res = await fetch(img);
  const blob = await res.blob();
  const file = new File([blob], 'phone-scan.jpg', { type: blob.type || 'image/jpeg' });
  await handleBulkFiles([file]);
}

async function boot() {
  // 1. Register API-client hooks BEFORE any /api/* call fires.
  setHooks({
    showAuthOverlay,
    showQuotaExceededModal,
    renderUsage,
  });
  // V1 onboarding helpers expect these on window.
  if (typeof window !== 'undefined') {
    window.showAuthOverlay = showAuthOverlay;
    window.showQuotaExceededModal = showQuotaExceededModal;
    window.renderUsage = renderUsage;
    window.switchTab = switchTab;
  }

  // 2. Service worker + PWA install nudge.
  registerServiceWorker();
  wireInstallNudge();

  // 3. Initialise local session state. Restores buy/cash/credit pcts.
  initializeSessions();

  // 4. Auth modal + overlays.
  wireAuthOverlay();
  wireResultSheet();
  wireCorrectModal();
  setAuthMode('login');

  // 5. Tabs.
  wireHeader();
  scanTab.init();
  resultsTab.init();
  sessionTab.init();
  settingsTab.init();
  adminTab.init();

  // 6. Auth gate. Pulls /api/me and reveals admin tab if applicable.
  await initAuthGate();

  // 7. Pull persisted state from /api/state. Echo-suppression in state.js
  //    prevents the resulting saveAllSessions() from re-pushing.
  await pullStateFromServer({
    onApplied: () => window.dispatchEvent(new CustomEvent('cp:log-changed')),
  });

  // 8. Listen for in-app navigation events (from result-sheet "Details", etc.).
  window.addEventListener('cp:nav', (ev) => {
    if (ev.detail?.tab) switchTab(ev.detail.tab);
  });

  // 9. Wire the host-side phone-pair handler.
  setOnScanReceived(onRemoteScan);

  // 10. Default tab.
  switchTab('scan');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
