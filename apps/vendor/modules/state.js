// apps/vendor/modules/state.js
//
// Single owner of the vendor app's mutable state, including the
// multi-named-session structure (audit §5.15) and the localStorage <->
// /api/state sync (debounced 1.5s PUT, last-writer-wins, audit §5.16 / §3).
//
// Keys preserved verbatim from V1 (audit §3 client-side keys):
//   cardpricer_sessions        — multi-named-session store
//   cardpricer_log             — legacy single-log array (migrated once)
//   cardpricer_buypct          — buy% slider (0-100, default 70)
//   cardpricer_cashpct         — cash% slider (10-90, default 50)
//   cardpricer_creditpct       — credit% slider (20-100, default 70)
//   cardpricer_wantlist        — JSON array of {name, set?, max?}
//   cardpricer_pricecache      — client-side mirror of recent /api/price
//   cardpricer_setting_<key>   — per-setting toggles (currency, sellMarkup, ...)
//   cardpricer_bulk_queue_v1   — bulk-mode queue minus full dataUrls
//   cp_visits, cp_install_dismissed — PWA install nudge
//
// F17 dual-write to relational sessions/session_cards is NOT this slice's
// job — that's S16 (A3). This module writes only via PUT /api/state for now.

import { putJson, getJson } from './api-client.js';

export const KEYS = Object.freeze({
  sessions:        'cardpricer_sessions',
  legacyLog:       'cardpricer_log',
  buyPct:          'cardpricer_buypct',
  cashPct:         'cardpricer_cashpct',
  creditPct:       'cardpricer_creditpct',
  wantList:        'cardpricer_wantlist',
  priceCache:      'cardpricer_pricecache',
  settingPrefix:   'cardpricer_setting_',
  bulkQueue:       'cardpricer_bulk_queue_v1',
  visits:          'cp_visits',
  installDismiss:  'cp_install_dismissed',
});

// Public state singleton. Modules read/write this directly. window.state
// alias is kept for V1 onboarding helpers that still poke at it.
export const state = {
  sessions: {},               // { [id]: { id, name, log: [], created_at } }
  currentSessionId: null,
  bulkQueue: [],
  _bulkSeq: 0,
  currentResults: [],
  buyPercentage: 70,
  cashPct: 50,
  creditPct: 70,
  pairRole: null,             // 'host' | 'scanner' | null
  pairRoomId: null,
};

// Echo-suppress flag — set during a pull so saveAllSessions() doesn't
// queue another push back to the server in a loop.
state._syncSuppressed = false;

if (typeof window !== 'undefined') {
  window.state = state;
}

// ============================================================
// Session shape helpers
// ============================================================

function newSessionId() {
  return 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function freshSession(name = 'Default') {
  const id = newSessionId();
  return {
    id,
    name,
    log: [],
    created_at: new Date().toISOString(),
  };
}

// One-time migration from the legacy flat cardpricer_log array (audit §1b).
// V1 ran this in initializeSessions() then never wrote to the legacy key again.
function migrateLegacyLog() {
  try {
    const raw = localStorage.getItem(KEYS.legacyLog);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return null;
    const sess = freshSession('Default');
    sess.log = arr;
    return sess;
  } catch {
    return null;
  }
}

export function initializeSessions() {
  let sessions = null;
  try {
    const raw = localStorage.getItem(KEYS.sessions);
    if (raw) sessions = JSON.parse(raw);
  } catch {}

  if (!sessions || typeof sessions !== 'object' || !Object.keys(sessions).length) {
    // Try migration from cardpricer_log first.
    const migrated = migrateLegacyLog();
    if (migrated) {
      sessions = { [migrated.id]: migrated };
      state.currentSessionId = migrated.id;
    } else {
      const seed = freshSession('Default');
      sessions = { [seed.id]: seed };
      state.currentSessionId = seed.id;
    }
  }

  state.sessions = sessions;
  if (!state.currentSessionId || !sessions[state.currentSessionId]) {
    state.currentSessionId = Object.keys(sessions)[0];
  }

  // Restore slider values.
  state.buyPercentage = parseInt(localStorage.getItem(KEYS.buyPct) || '70', 10);
  state.cashPct       = parseInt(localStorage.getItem(KEYS.cashPct) || '50', 10);
  state.creditPct     = parseInt(localStorage.getItem(KEYS.creditPct) || '70', 10);
}

export function currentSession() {
  return state.sessions[state.currentSessionId] || null;
}

export function currentLog() {
  return currentSession()?.log || [];
}

export function saveAllSessions() {
  try {
    localStorage.setItem(KEYS.sessions, JSON.stringify(state.sessions));
  } catch (e) {
    console.warn('[STATE] sessions persist failed:', e?.message || e);
  }
  queueStateSync();
}

export function newSession(name) {
  const sess = freshSession(name || ('Session ' + (Object.keys(state.sessions).length + 1)));
  state.sessions[sess.id] = sess;
  state.currentSessionId = sess.id;
  saveAllSessions();
  return sess;
}

export function switchSession(id) {
  if (state.sessions[id]) state.currentSessionId = id;
  saveAllSessions();
}

export function deleteCurrentSession() {
  const id = state.currentSessionId;
  if (!id) return;
  delete state.sessions[id];
  const remaining = Object.keys(state.sessions);
  if (!remaining.length) {
    const seed = freshSession('Default');
    state.sessions[seed.id] = seed;
    state.currentSessionId = seed.id;
  } else {
    state.currentSessionId = remaining[0];
  }
  saveAllSessions();
}

export function renameCurrentSession(newName) {
  const s = currentSession();
  if (!s || !newName) return;
  s.name = newName.trim() || s.name;
  saveAllSessions();
}

// ============================================================
// Settings (cardpricer_setting_<key>)
// ============================================================

export function getSetting(key, defaultVal) {
  const v = localStorage.getItem(KEYS.settingPrefix + key);
  return v == null ? defaultVal : v;
}

export function setSetting(key, val) {
  localStorage.setItem(KEYS.settingPrefix + key, val);
}

export function getWantList() {
  try { return JSON.parse(localStorage.getItem(KEYS.wantList) || '[]'); }
  catch { return []; }
}

export function saveWantList(list) {
  localStorage.setItem(KEYS.wantList, JSON.stringify(list || []));
  queueStateSync();
}

// ============================================================
// Server sync (debounced PUT /api/state, audit §5.15)
// ============================================================

let _syncTimer = null;
let _syncInFlight = false;
let _syncPending = false;

export function queueStateSync() {
  if (state._syncSuppressed) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(pushStateToServer, 1500);
}

export async function pushStateToServer() {
  if (!window.sb) return;
  if (_syncInFlight) { _syncPending = true; return; }
  _syncInFlight = true;
  try {
    const { data } = await window.sb.auth.getSession();
    if (!data?.session) return;
    const payload = {
      sessions: state.sessions || {},
      currentSessionId: state.currentSessionId || null,
      wantlist: getWantList(),
      v: 1,
    };
    await putJson('/api/state', { state: payload });
  } catch (e) {
    console.warn('[STATE] push failed:', e?.message || e);
  } finally {
    _syncInFlight = false;
    if (_syncPending) { _syncPending = false; queueStateSync(); }
  }
}

export async function pullStateFromServer({ onApplied } = {}) {
  if (!window.sb) return;
  try {
    const { data } = await window.sb.auth.getSession();
    if (!data?.session) return;
    const r = await getJson('/api/state');
    if (!r.ok) return;
    if (!r.body?.state) {
      // Server empty — seed it with whatever local has, if anything.
      if (state.sessions && Object.keys(state.sessions).length) {
        pushStateToServer();
      }
      return;
    }
    const s = r.body.state;
    state._syncSuppressed = true;
    try {
      if (s.sessions && typeof s.sessions === 'object') state.sessions = s.sessions;
      if (s.currentSessionId) state.currentSessionId = s.currentSessionId;
      if (Array.isArray(s.wantlist)) {
        localStorage.setItem(KEYS.wantList, JSON.stringify(s.wantlist));
      }
      saveAllSessions(); // flush echo-suppressed
      if (typeof onApplied === 'function') onApplied();
    } finally {
      state._syncSuppressed = false;
    }
    console.log('[STATE] state restored from server');
  } catch (e) {
    console.warn('[STATE] pull failed:', e?.message || e);
  }
}

// Slider setters — central so renderers can subscribe to a single mutator.
export function setBuyPct(v) {
  state.buyPercentage = parseInt(v, 10) || 70;
  localStorage.setItem(KEYS.buyPct, String(state.buyPercentage));
}
export function setCashPct(v) {
  state.cashPct = parseInt(v, 10) || 50;
  localStorage.setItem(KEYS.cashPct, String(state.cashPct));
}
export function setCreditPct(v) {
  state.creditPct = parseInt(v, 10) || 70;
  localStorage.setItem(KEYS.creditPct, String(state.creditPct));
}
