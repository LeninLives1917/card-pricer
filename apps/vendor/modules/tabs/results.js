// apps/vendor/modules/tabs/results.js
//
// Renders state.currentResults — the cards from the most recent scan
// (single, bulk, or text-entry). Each row is tappable to open the result
// sheet; bulk-mode skips this view entirely (cards land directly in the
// session log per V1 audit §1b).

import { state } from '../state.js';
import { openResultSheet } from '../result-sheet.js';

export function init() {
  // Re-render on demand. Modules dispatch `cp:results-changed` after
  // state.currentResults updates.
  window.addEventListener('cp:results-changed', render);
  render();
}

export function render() {
  const root = document.getElementById('resultsContainer');
  if (!root) return;
  const list = state.currentResults || [];
  if (!list.length) {
    root.innerHTML = `
      <div class="empty-state">
        <h4>No results yet</h4>
        <p>Drop into the Scan tab to upload card photos or type set codes. Priced cards land here.</p>
      </div>`;
    return;
  }
  root.innerHTML = list.map((entry, idx) => {
    const card = entry.card || {};
    const cm = entry.cardmarket || {};
    const bp = entry.buy_price || {};
    const mv = entry.market_value || bp.market_value || cm.price || cm.trend || 0;
    const buy = entry.custom_buy ?? bp.suggested ?? 0;
    const thumb = entry.image || card.image_url || '';
    return `
      <div class="session-log-row" data-result-idx="${idx}" style="cursor:pointer;">
        <div class="thumb" style="${thumb ? `background-image:url('${escapeAttr(thumb)}')` : ''}"></div>
        <div>
          <div class="name">${escapeHtml(card.name || 'Unknown')}</div>
          <div class="meta">${escapeHtml((card.set_code || '').toUpperCase())} ${escapeHtml(card.card_number || '')}${card.rarity ? ' · ' + escapeHtml(card.rarity) : ''}</div>
        </div>
        <div class="price">€${Number(mv).toFixed(2)}<br><span class="data-badge" style="font-size:10px;">buy €${Number(buy).toFixed(2)}</span></div>
      </div>
    `;
  }).join('');
  root.querySelectorAll('[data-result-idx]').forEach((row) => {
    row.addEventListener('click', () => {
      const i = parseInt(row.dataset.resultIdx, 10);
      const entry = state.currentResults?.[i];
      if (entry) openResultSheet(entry);
    });
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
