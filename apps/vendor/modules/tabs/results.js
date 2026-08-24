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
    // MULTI — the line is several cards run together. Ask, then DO it.
    //
    // Telling the operator to "put each on its own line" makes them retype
    // something the system has already worked out. The pieces are resolved
    // and named; the only thing missing is their confirmation that the line
    // really was two cards, so that is the only thing asked for.
    if (entry.pieces?.length) {
      const names = entry.pieces
        .map((p) => (p.card ? `<strong>${escapeHtml(p.card.name)}</strong>` : escapeHtml(p.text)))
        .join(' &nbsp;+&nbsp; ');
      const allResolved = entry.pieces.every((p) => p.status === 'resolved');
      return `
        <div class="session-log-row" style="border-left:3px solid #d99a2b; display:block; cursor:default;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
            <div class="name">${escapeHtml(entry._parsed_line || '')}</div>
            <span class="data-badge" style="font-size:10px; color:#d99a2b; white-space:nowrap;">
              ${entry.pieces.length} cards?
            </span>
          </div>
          <div class="meta" style="margin-top:6px;">${names}</div>
          <div style="display:flex; gap:6px; margin-top:8px;">
            <button class="btn primary" data-split="${idx}" style="font-size:12px; padding:6px 12px;"
              ${allResolved ? '' : 'disabled'}>
              Yes — split and price ${entry.pieces.length}
            </button>
            <button class="btn ghost" data-split-no="${idx}" style="font-size:12px; padding:6px 12px;">
              No, one card
            </button>
          </div>
        </div>
      `;
    }

    // AMBIGUOUS — the line resolved to more than one real card, so the answer
    // is a question. Measured: 102 of the catalogue's name+number groups stay
    // ambiguous under a three-letter prefix, and 63 of those are DIFFERENT
    // POKEMON (bla|2|132 is Blastoise or Blaine's Charizard, and the price gap
    // is large). Picking one for the operator would be the first-hit-wins
    // defect wearing a nicer coat.
    //
    // Amber, not red: nothing failed. The row is one tap from done.
    if (entry.candidates?.length) {
      const chips = entry.candidates.map((c, ci) => `
        <button class="btn ghost" data-pick="${idx}:${ci}"
          style="text-align:left; padding:6px 10px; font-size:12px; line-height:1.35; flex:0 1 auto;">
          <strong>${escapeHtml(c.name || '?')}</strong><br>
          <span style="opacity:0.7;">${escapeHtml(c.set_name || '')} · #${escapeHtml(c.card_number || '')}</span>
        </button>`).join('');
      return `
        <div class="session-log-row" style="border-left:3px solid #d99a2b; display:block; cursor:default;">
          <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
            <div class="name">${escapeHtml(entry._parsed_line || card.name || 'Which one?')}</div>
            <span class="data-badge" style="font-size:10px; color:#d99a2b; white-space:nowrap;">
              ${entry.candidates.length} matches — tap one
            </span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;">${chips}</div>
        </div>
      `;
    }

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
  root.querySelectorAll('[data-split]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = parseInt(btn.dataset.split, 10);
      btn.textContent = 'Pricing…';
      btn.disabled = true;
      window.dispatchEvent(new CustomEvent('cp:split-confirmed', { detail: { resultIndex: i } }));
    });
  });

  root.querySelectorAll('[data-split-no]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = parseInt(btn.dataset.splitNo, 10);
      const entry = state.currentResults?.[i];
      if (!entry) return;
      // Declining the split is information too: the line was one card the
      // system could not read, not two run together. Turn it into an ordinary
      // unresolved row rather than leaving the question sitting there.
      state.currentResults[i] = {
        card: { name: entry._parsed_line || '', set_code: '', card_number: '' },
        error: 'Could not identify — try name + number, e.g. cha 4/102',
        _parsed_line: entry._parsed_line,
      };
      window.dispatchEvent(new CustomEvent('cp:results-changed'));
    });
  });

  root.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const [i, ci] = btn.dataset.pick.split(':').map((n) => parseInt(n, 10));
      const entry = state.currentResults?.[i];
      const chosen = entry?.candidates?.[ci];
      if (!chosen) return;
      btn.textContent = 'Pricing…';
      btn.disabled = true;
      // The operator has answered the question. Report which candidate they
      // picked, not just that they picked one: if they overwhelmingly choose
      // the first, the resolver is being too cautious and the data says so —
      // the same recalibration signal as the amber confirm lane.
      window.dispatchEvent(new CustomEvent('cp:candidate-chosen', {
        detail: { resultIndex: i, candidate: chosen, rank: ci, of: entry.candidates.length },
      }));
    });
  });

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
