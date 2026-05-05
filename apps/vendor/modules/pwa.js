// apps/vendor/modules/pwa.js
//
// Service-worker registration + PWA install nudge. Nudge appears on visit
// >= 2 unless dismissed (audit §3 client-side keys: cp_visits,
// cp_install_dismissed). The actual SW file is /service-worker.js (served
// by Express with no-cache headers — audit §1a route at line 851).

import { KEYS } from './state.js';

let _deferredPrompt = null;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Server still serves /service-worker.js from public/service-worker.js
  // until S22 cutover. apps/vendor/service-worker.js is staged but not the
  // file the orchestrator wires from URL → file system. We register at the
  // canonical URL either way.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js', { updateViaCache: 'none' })
      .then((reg) => {
        try { reg.update(); } catch {}
        console.log('[APP] SW registered, scope:', reg.scope);
      })
      .catch((err) => console.warn('[APP] SW register failed:', err));
  });
}

// Listen for `beforeinstallprompt` so we can trigger doInstall() later.
export function wireInstallNudge() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredPrompt = e;
    maybeShowNudge();
  });

  // Bump visit count (cp_visits).
  try {
    const v = parseInt(localStorage.getItem(KEYS.visits) || '0', 10) + 1;
    localStorage.setItem(KEYS.visits, String(v));
  } catch {}

  const installBtn = document.getElementById('installNudgeBtn');
  const closeBtn = document.getElementById('installNudgeClose');
  if (installBtn) installBtn.addEventListener('click', doInstall);
  if (closeBtn) closeBtn.addEventListener('click', dismissInstall);

  // Defer the visibility check a tick so the nudge doesn't flash before
  // Supabase + auth gate decide whether to show the auth overlay.
  setTimeout(maybeShowNudge, 800);
}

function maybeShowNudge() {
  const visits = parseInt(localStorage.getItem(KEYS.visits) || '0', 10);
  const dismissed = localStorage.getItem(KEYS.installDismiss) === '1';
  const nudge = document.getElementById('installNudge');
  if (!nudge) return;
  // Only show if installable, second+ visit, not dismissed, not already
  // running as a PWA, and not in scanner-mode.
  const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const isScanner = new URLSearchParams(location.search).has('pair');
  if (visits >= 2 && !dismissed && _deferredPrompt && !isStandalone && !isScanner) {
    nudge.classList.remove('hidden');
  } else {
    nudge.classList.add('hidden');
  }
}

async function doInstall() {
  if (!_deferredPrompt) return;
  try {
    _deferredPrompt.prompt();
    await _deferredPrompt.userChoice;
  } catch {}
  _deferredPrompt = null;
  dismissInstall();
}

function dismissInstall() {
  try { localStorage.setItem(KEYS.installDismiss, '1'); } catch {}
  const nudge = document.getElementById('installNudge');
  if (nudge) nudge.classList.add('hidden');
}
