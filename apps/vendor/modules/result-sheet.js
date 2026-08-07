// apps/vendor/modules/result-sheet.js
//
// The result sheet — slides up over the scan view with the card name,
// set/number, market value, cash/credit, condition cycle, candidates
// chooser (when verifyPokemon returns moderate confidence), and the
// "I bought / Passed / Details" actions.
//
// The signature moment (DESIGN_BRIEF.md): card name is rendered .display
// (Fraunces 600 italic, 28px). The CSS in components.css runs the amber
// hairline reveal animation under it via ::after — every time the sheet
// re-renders the keyframe runs from scratch (we toggle a class to retrigger).

import { postJson } from './api-client.js';
import { state, currentLog, saveAllSessions, getSetting } from './state.js';
import { openCorrectModal } from './correct.js';

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

let _currentEntry = null;   // ref into currentResults[0] OR session log entry
let _ask = 0;               // negotiate input — €

export function openResultSheet(entry) {
  _currentEntry = entry || null;
  _ask = 0;
  const sheet = document.getElementById('resultSheet');
  if (!sheet) return;
  sheet.classList.add('open');
  renderResultSheet();
}

export function closeResultSheet() {
  const sheet = document.getElementById('resultSheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  _currentEntry = null;
}

// Re-render. We toggle a "rerender" class for one frame to retrigger the
// hairline keyframe — without this, only the first open animates.
export function renderResultSheet() {
  const body = document.getElementById('sheetBody');
  if (!body) return;
  const entry = _currentEntry;
  if (!entry) { body.innerHTML = ''; return; }

  const card = entry.card || {};
  const cm = entry.cardmarket || {};
  const bp = entry.buy_price || {};
  const mv = entry.market_value || bp.market_value || cm.price || cm.trend || 0;
  const buy = entry.custom_buy ?? bp.suggested ?? 0;
  const markup = parseFloat(getSetting('sellMarkup', '110')) || 110;
  const sell = entry.custom_sell ?? Math.round(mv * (markup / 100) * 100) / 100;

  const isPending = !!entry._pending;
  // Dual-image header: user's scan (if any) + catalogue reference. For
  // text/manual entries (no entry.image), only the catalogue ref is shown.
  const userImg = entry.image || '';
  const refImg = entry.reference_image || card.image_url || card.reference_image || '';
  const thumbBlock = renderSheetThumbs(userImg, refImg);
  const cmUrl = buildCardmarketUrl(card, cm);

  // Graded badge — DESIGN_BRIEF status-badge rare register.
  const gradedBadge = card.graded
    ? `<span class="status-badge rare">${escapeHtml(card.graded.company)} ${escapeHtml(String(card.graded.grade))}</span>`
    : '';

  // Condition cycle button (Pokemon/etc. — graded skips condition).
  const condition = card.condition_estimate || 'NM';
  const conditionBtn = card.graded
    ? ''
    : `<button class="data-badge" data-action="cycle-condition" title="Cycle condition">${escapeHtml(condition)}</button>`;

  // Candidates picker — surfaces alt matches verifyPokemon returned.
  const candidates = Array.isArray(card.candidates) ? card.candidates : [];
  const candidatesBlock = candidates.length
    ? `<div class="setting-group" style="margin-top:var(--p-3);">
         <h3>Did we pick wrong?</h3>
         <div class="candidates">
           ${candidates.map((c, i) => `
             <button class="candidate" data-action="pick-candidate" data-idx="${i}">
               ${c.image ? `<img src="${escapeAttr(c.image)}" alt="">` : ''}
               <div class="candidate-name">${escapeHtml(c.name || 'Unknown')}</div>
               <div class="candidate-meta">${escapeHtml((c.set_code || '').toUpperCase())} ${escapeHtml(c.card_number || '')}</div>
             </button>`).join('')}
         </div>
       </div>`
    : '';

  body.innerHTML = `
    <div class="sheet-card-head" style="display:flex; gap:var(--p-3); align-items:flex-start;">
      ${thumbBlock}
      <div style="flex:1; min-width:0;">
        <div>
          <span class="sheet-card-name" data-action="correct-card" title="Tap to correct">${escapeHtml(card.name || 'Unknown')}</span>
          ${gradedBadge ? '&nbsp;' + gradedBadge : ''}
        </div>
        <div class="sheet-card-meta">
          ${escapeHtml(card.set_name || '')}${card.set_code ? ' · ' + escapeHtml((card.set_code || '').toUpperCase()) : ''}${card.card_number ? ' · #' + escapeHtml(card.card_number) : ''}${card.rarity ? ' · ' + escapeHtml(card.rarity) : ''}
        </div>
        <div style="margin-top:var(--p-2); display:flex; gap:var(--p-1); align-items:center;">
          ${conditionBtn}
          ${cmUrl ? `<a class="data-badge" href="${escapeAttr(cmUrl)}" target="_blank" rel="noopener noreferrer">Cardmarket →</a>` : ''}
        </div>
      </div>
    </div>

    <div class="sheet-prices">
      <div class="sheet-price buy">
        <div class="sheet-price-label">Buy at</div>
        <div class="sheet-price-val figure">€${isPending ? '…' : Number(buy).toFixed(2)}</div>
      </div>
      <div class="sheet-price">
        <div class="sheet-price-label">Market</div>
        <div class="sheet-price-val figure">€${isPending ? '…' : Number(mv).toFixed(2)}</div>
        <!-- WHICH SOURCE SAID SO. The server has computed price_source on every
             price all along and no surface displayed it, so a price that is
             wrong by 37x (Charizard ex SVP 56: EUR 561.50 shown against ~EUR 15
             on the Cardmarket page the sheet itself links to) could not be
             attributed to a source without reading server logs. Same shape as
             the fast-path counters and the accept gate: the diagnostic existed
             and nothing read it. -->
        <div class="sheet-price-src" style="font-size:10px; opacity:.6; margin-top:2px; line-height:1.3;">${
          isPending ? '' : escapeHtml(priceSourceLabel(entry))
        }</div>
      </div>
      <div class="sheet-price sell">
        <div class="sheet-price-label">Sell at</div>
        <div class="sheet-price-val figure">€${isPending ? '…' : Number(sell).toFixed(2)}</div>
      </div>
    </div>

    <div class="surface" style="display:flex; gap:var(--p-2); align-items:center; margin-top:var(--p-2);">
      <span class="label" style="margin:0;">Seller asks</span>
      <input type="number" inputmode="decimal" step="0.5" min="0" class="figure-input"
             data-action="ask-input" placeholder="€…" value="${_ask || ''}" style="flex:1; min-width:0;" />
      <span class="figure" style="font-size:13px; color:${_ask && (sell - _ask) >= 0 ? 'var(--up)' : 'var(--down)'};">
        ${_ask ? (sell - _ask >= 0 ? '+' : '') + '€' + (sell - _ask).toFixed(2) : '—'}
      </span>
    </div>

    ${candidatesBlock}

    <div class="sheet-actions">
      <button class="sheet-action bought" data-action="bought">Bought</button>
      <button class="sheet-action passed" data-action="passed">Passed</button>
      <button class="sheet-action" data-action="details">Details</button>
      <button class="sheet-action" data-action="dismiss">Done</button>
    </div>
  `;

  // Restore the hairline keyframe — pulling the element out of the DOM
  // and reinserting forces the animation to replay on each render.
  const nameEl = body.querySelector('.sheet-card-name');
  if (nameEl) {
    nameEl.style.animation = 'none';
    // eslint-disable-next-line no-unused-expressions
    nameEl.offsetHeight; // reflow
    nameEl.style.animation = '';
  }
}

// ============================================================
// Event delegation — wired once on init
// ============================================================

export function wireResultSheet() {
  const sheet = document.getElementById('resultSheet');
  if (!sheet) return;

  sheet.addEventListener('click', async (ev) => {
    const target = ev.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case 'bought':  return doBought();
      case 'passed':  return doPassed();
      case 'details': return doDetails();
      case 'dismiss': return closeResultSheet();
      case 'cycle-condition': return cycleCondition();
      case 'correct-card': return openCorrectModal(_currentEntry);
      case 'pick-candidate': {
        const idx = parseInt(target.dataset.idx, 10);
        return pickCandidate(idx);
      }
    }
  });

  sheet.addEventListener('input', (ev) => {
    const target = ev.target.closest('[data-action="ask-input"]');
    if (!target) return;
    _ask = parseFloat(target.value) || 0;
    renderResultSheet();
    const next = document.querySelector('[data-action="ask-input"]');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });
}

// ============================================================
// Actions
// ============================================================

function doBought() {
  if (!_currentEntry) return;
  _currentEntry.status = 'bought';
  if (_ask > 0) _currentEntry.custom_buy = _ask;
  saveAllSessions();
  closeResultSheet();
}

function doPassed() {
  if (!_currentEntry) return;
  _currentEntry.status = 'passed';
  saveAllSessions();
  closeResultSheet();
}

function doDetails() {
  closeResultSheet();
  // Hand off to the session tab — let the orchestrator wire the actual
  // tab switch via a custom event so we don't import circularly.
  window.dispatchEvent(new CustomEvent('cp:nav', { detail: { tab: 'log' } }));
}

async function cycleCondition() {
  if (!_currentEntry || !_currentEntry.card) return;
  const card = _currentEntry.card;
  const idx = CONDITIONS.indexOf(card.condition_estimate || 'NM');
  card.condition_estimate = CONDITIONS[(idx + 1) % CONDITIONS.length];
  await reprice();
}

async function pickCandidate(candidateIdx) {
  if (!_currentEntry || !_currentEntry.card) return;
  const pick = _currentEntry.card.candidates?.[candidateIdx];
  if (!pick) return;
  _currentEntry.card = {
    ..._currentEntry.card,
    name: pick.name,
    set_name: pick.set_name,
    set_code: pick.set_code,
    card_number: pick.card_number,
    rarity: pick.rarity || _currentEntry.card.rarity,
    hp: pick.hp || _currentEntry.card.hp,
    verified: true,
    verify_rejected: null,
    confidence_score: 999,
    candidates: null,
    _manual_pick: true,
  };
  if (pick.image) _currentEntry.reference_image = pick.image;
  _currentEntry._pending = true;
  _currentEntry.cardmarket = null;
  _currentEntry.buy_price = null;
  renderResultSheet();
  await reprice();
}

async function reprice() {
  if (!_currentEntry || !_currentEntry.card) return;
  _currentEntry._pending = true;
  renderResultSheet();
  const r = await postJson('/api/price', {
    card: _currentEntry.card,
    buyPercentage: state.buyPercentage,
  });
  if (r.ok) {
    Object.assign(_currentEntry, r.body);
    _currentEntry._pending = false;
  } else {
    _currentEntry._pending = false;
  }
  saveAllSessions();
  renderResultSheet();
}

// ============================================================
// Helpers
// ============================================================

function buildCardmarketUrl(card, cm) {
  let cmUrl = card.cardmarket_url || cm.url || cm.product_url || cm.filtered_url || '';
  if (cmUrl && !cmUrl.startsWith('http')) cmUrl = 'https://www.cardmarket.com' + cmUrl;
  if (!cmUrl && card.name) {
    const gameSlug =
      card.game === 'magic' ? 'Magic'
      : card.game === 'pokemon' ? 'Pokemon'
      : card.game === 'yugioh' ? 'YuGiOh'
      : card.game === 'lorcana' ? 'Lorcana'
      : card.game === 'onepiece' ? 'OnePiece'
      : card.game === 'starwars' ? 'StarWarsUnlimited' : '';
    const setCode = (card.set_code || '').toUpperCase();
    const num = card.card_number ? card.card_number.replace(/\/.*/, '').replace(/^0+/, '') : '';
    let q = card.name || '';
    if (card.game === 'pokemon' && setCode && num) q = `${card.name} (${setCode} ${num})`;
    else if (num) q = `${card.name} ${num}`;
    cmUrl = gameSlug
      ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(q)}`
      : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(q)}`;
  }
  return cmUrl;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Result-sheet header thumbs. When both images exist (image-driven scan),
// render two side-by-side card thumbs with small "Scanned" / "Identified"
// captions so the operator can verify the match at a glance. For text /
// manual entries that only have a catalogue ref, we keep the original
// single 72px thumb so the existing sheet rhythm doesn't shift.
function renderSheetThumbs(userImg, refImg) {
  const baseStyle = 'width:64px; aspect-ratio:5/7; border-radius:var(--r-2); background:var(--ink-300) center/cover;';
  if (userImg && refImg) {
    return `
      <div style="display:flex; gap:6px; flex-shrink:0;">
        <div style="display:flex; flex-direction:column; align-items:center; gap:3px;">
          <div class="sheet-card-thumb" style="${baseStyle} background-image:url('${escapeAttr(userImg)}');"></div>
          <span class="data-badge" style="font-size:9px;">Scanned</span>
        </div>
        <div style="display:flex; flex-direction:column; align-items:center; gap:3px;">
          <div class="sheet-card-thumb" style="${baseStyle} background-image:url('${escapeAttr(refImg)}');"></div>
          <span class="data-badge" style="font-size:9px;">Identified</span>
        </div>
      </div>`;
  }
  const single = userImg || refImg || '';
  return `<div class="sheet-card-thumb" style="width:72px; aspect-ratio:5/7; border-radius:var(--r-2); background:var(--ink-300) center/cover; ${single ? `background-image:url('${escapeAttr(single)}')` : ''}"></div>`;
}

/**
 * Which source produced the market figure, in a few words.
 *
 * A price with no visible provenance cannot be challenged. When the sheet says
 * EUR 561.50 and the Cardmarket link it renders says EUR 15, the only useful
 * next question is "according to whom?" — and until now the answer lived in a
 * server log nobody reads.
 */
export function priceSourceLabel(entry) {
  const bp = entry?.buy_price || {};
  // A graded comp on a raw card is the most expensive way to be wrong: a
  // PSA-10 figure against an ungraded card can be an order of magnitude out.
  // pricing/price.js takes the graded branch whenever card.graded carries a
  // company and grade, so a mis-set flag silently swaps the whole basis.
  if (bp.graded && bp.graded.company) {
    return `GRADED COMP — ${bp.graded.company} ${bp.graded.grade} · ${bp.price_source || 'source unknown'}`;
  }
  if (bp.price_source) return String(bp.price_source);
  if (entry?.price_source) return String(entry.price_source);
  const cm = entry?.cardmarket || {};
  if (cm.source) return `Cardmarket (${cm.source})`;
  if (cm.price != null) return 'Cardmarket';
  return 'source unknown';
}
