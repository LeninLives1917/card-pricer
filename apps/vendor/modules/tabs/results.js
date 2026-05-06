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
    // Dual-thumb: scanned image (if any) + catalogue ref. Falls back to
    // a single ref thumb for text-only / manual-entry results.
    const userImg = entry.image || '';
    const refImg = entry.reference_image || card.image_url || card.reference_image || '';
    const thumbHtml = renderRowThumbs(userImg, refImg);
    if (entry.error) {
      return `
        <div class="session-log-row" data-result-idx="${idx}" style="cursor:pointer; border-left:3px solid #c14a3a;">
          <div class="thumb" style="background:rgba(193,74,58,0.15);"></div>
          <div>
            <div class="name">${escapeHtml(card.name || entry._parsed_line || 'Unknown')}</div>
            <div class="meta">${escapeHtml((card.set_code || '').toUpperCase())} ${escapeHtml(card.card_number || '')}</div>
          </div>
          <div class="price" style="color:#c14a3a; font-size:12px; text-align:right;">Not found<br><span class="data-badge" style="font-size:10px;">${escapeHtml(entry.error)}</span></div>
        </div>
      `;
    }
    return `
      <div class="session-log-row" data-result-idx="${idx}" style="cursor:pointer;">
        ${thumbHtml}
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
      // Error rows aren't openable in the result sheet (no priced data); a
      // future "open the correct-card modal pre-filled with the parsed line"
      // would be a nicer affordance, but for now we just no-op.
      if (entry && !entry.error) openResultSheet(entry);
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

// Same dual-thumb renderer as session.js — kept inline rather than
// extracted because the two surfaces have distinct enough markup that
// sharing a helper across modules wasn't worth a new file.
function renderRowThumbs(userImg, refImg) {
  if (userImg && refImg) {
    return `
      <div class="thumb-pair" style="display:flex; gap:3px; flex-shrink:0;">
        <div class="thumb" style="width:30px; background-image:url('${escapeAttr(userImg)}'); background-size:cover; background-position:center;" title="Scanned"></div>
        <div class="thumb" style="width:30px; background-image:url('${escapeAttr(refImg)}'); background-size:cover; background-position:center;" title="Identified"></div>
      </div>`;
  }
  const single = userImg || refImg || '';
  return `<div class="thumb" style="${single ? `background-image:url('${escapeAttr(single)}')` : ''}"></div>`;
}
