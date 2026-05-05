// apps/vendor/modules/correct.js
//
// Search modal + /api/correct-card POST. Used to manually correct a
// mis-identified card after the result sheet shows the wrong name. The
// correction persists server-side as `source: 'manual'` (highest trust per
// audit §5.4 — the persistence layer must preserve the source field).

import { postJson, getJson } from './api-client.js';

let _activeEntry = null;
let _searchTimer = null;

export function openCorrectModal(entry) {
  _activeEntry = entry || null;
  if (!_activeEntry) return;
  const modal = document.getElementById('searchModal');
  const input = document.getElementById('searchInput');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (input) {
    input.value = _activeEntry.card?.name || '';
    setTimeout(() => input.focus(), 60);
    runSearch(input.value);
  }
}

export function closeCorrectModal(ev) {
  // Click on backdrop only (not modal body).
  if (ev && ev.target && !ev.target.classList.contains('modal-overlay')) return;
  const modal = document.getElementById('searchModal');
  if (modal) modal.classList.add('hidden');
  _activeEntry = null;
}

export function wireCorrectModal() {
  const modal = document.getElementById('searchModal');
  const input = document.getElementById('searchInput');
  const close = document.getElementById('searchClose');
  if (modal) modal.addEventListener('click', closeCorrectModal);
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => runSearch(input.value), 220);
    });
  }
  if (close) close.addEventListener('click', closeCorrectModal);
}

async function runSearch(q) {
  const out = document.getElementById('searchResults');
  if (!out) return;
  if (!q || q.trim().length < 2) {
    out.innerHTML = '<div class="empty-state"><p>Type at least 2 characters.</p></div>';
    return;
  }
  out.innerHTML = '<div class="empty-state"><p>Searching…</p></div>';
  const r = await getJson('/api/search?q=' + encodeURIComponent(q.trim()));
  const list = (r.ok && Array.isArray(r.body?.results)) ? r.body.results : [];
  if (!list.length) {
    out.innerHTML = '<div class="empty-state"><p>No matches.</p></div>';
    return;
  }
  out.innerHTML = list.slice(0, 24).map((c, i) => `
    <div class="session-log-row" data-pick="${i}" style="cursor:pointer;">
      <div class="thumb" style="${c.image ? `background-image:url('${escapeAttr(c.image)}')` : ''}"></div>
      <div>
        <div class="name">${escapeHtml(c.name || 'Unknown')}</div>
        <div class="meta">${escapeHtml((c.set_code || '').toUpperCase())} ${escapeHtml(c.card_number || '')}${c.set_name ? ' · ' + escapeHtml(c.set_name) : ''}</div>
      </div>
      <div class="price">→</div>
    </div>
  `).join('');
  out.querySelectorAll('[data-pick]').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.pick, 10);
      pickResult(list[idx]);
    });
  });
}

async function pickResult(card) {
  if (!_activeEntry || !card) return;
  const oldName = _activeEntry.card?.name || '';
  const newName = card.name || oldName;
  if (!newName || newName === oldName) {
    closeCorrectModal();
    return;
  }
  // Persist correction on the server. `source: 'manual'` priority is enforced
  // by the server (audit §5.4); we just send the trio.
  try {
    const r = await postJson('/api/correct-card', {
      set_code: card.set_code || _activeEntry.card?.set_code || '',
      card_number: card.card_number || _activeEntry.card?.card_number || '',
      correct_name: newName.trim(),
    });
    if (r.ok) {
      _activeEntry.card.name = newName.trim();
      // Notify everyone interested (result-sheet, session tab).
      window.dispatchEvent(new CustomEvent('cp:card-corrected', {
        detail: { entry: _activeEntry, oldName, newName },
      }));
    } else {
      console.warn('[CORRECT] failed:', r.error);
    }
  } catch (e) {
    console.warn('[CORRECT] error:', e);
  }
  closeCorrectModal();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
