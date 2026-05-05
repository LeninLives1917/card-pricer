// apps/vendor/modules/tabs/admin.js
//
// Admin tab — visible only after /api/me returns is_admin: true (audit §1a).
// Renders MRR/ARR/active-paid/scans-this-month/signups-30d stat grid + plan
// breakdown + recent users table + API health + the US↔EU arbitrage finder
// (filters: direction, min-source-price, ratio threshold 1.10-2.00, variant
// auto/normal/holofoil/reverseHolofoil, sort, liquidity any/active/strong,
// limit, CSV download, refresh-prices). Verbatim port from V1 §1b.

import { getJson, postJson } from '../api-client.js';

let _arbLastResults = [];
let _arbLastDirection = 'us_to_eu';
let _arbPoll = null;

let _analyticsWindow = '30d';

export function init() {
  // First-time render only when the tab is shown — saves a request roundtrip
  // until the operator actually opens it.
  window.addEventListener('cp:tab-shown', (ev) => {
    if (ev.detail?.tab === 'admin') firstRender();
  });
  wireArbitrage();
  wireAnalytics();
}

let _firstRendered = false;
async function firstRender() {
  if (_firstRendered) return;
  _firstRendered = true;
  await Promise.all([loadOverview(), loadUsers(), loadHealth(), loadAnalytics()]);
}

async function loadOverview() {
  const r = await getJson('/api/admin/overview');
  if (!r.ok) return;
  const o = r.body || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('adminMrr', '€' + (o.mrr || 0).toFixed(2));
  set('adminArr', 'ARR: €' + (o.arr || 0).toFixed(2));
  set('adminActivePaid', String(o.active_paid || 0));
  set('adminUserCount', (o.user_count || 0) + ' total users');
  set('adminScans', String(o.scans_this_month || 0));
  set('adminSignups', String(o.signups_last_30 || 0));
  const breakdown = document.getElementById('adminPlanBreakdown');
  if (breakdown && o.plan_counts) {
    const total = Object.values(o.plan_counts).reduce((a, b) => a + b, 0) || 1;
    breakdown.innerHTML = Object.entries(o.plan_counts).map(([plan, n]) => {
      const pct = Math.round((n / total) * 100);
      return `<div style="display:flex;align-items:center;gap:var(--p-2);">
        <span class="setting-label" style="width:80px;">${escapeHtml(plan)}</span>
        <div style="flex:1; height:6px; background:var(--ink-300); border-radius:3px; overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:var(--accent);"></div>
        </div>
        <span class="figure" style="width:60px; text-align:right; color:var(--paper-300);">${n} · ${pct}%</span>
      </div>`;
    }).join('');
  }
}

async function loadUsers() {
  const r = await getJson('/api/admin/users');
  if (!r.ok) return;
  const tbody = document.getElementById('adminUserTableBody');
  if (!tbody) return;
  const users = r.body?.users || [];
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--paper-300);">No users.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.email || '—')}</td>
      <td><span class="data-badge">${escapeHtml(u.plan || '—')}</span></td>
      <td class="num">${u.scans_this_month || 0}</td>
      <td class="num">${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
    </tr>`).join('');
}

async function loadHealth() {
  const r = await getJson('/api/health');
  const root = document.getElementById('apiStatus');
  if (!root) return;
  if (!r.ok) {
    root.innerHTML = '<div class="setting-row"><span class="setting-label" style="color:var(--down);">Health check failed</span></div>';
    return;
  }
  const h = r.body || {};
  const rows = [
    ['Status', h.status || '—'],
    ['Uptime', h.uptime_human || (h.uptime_s ? Math.round(h.uptime_s) + 's' : '—')],
    ['Anthropic', h.has_anthropic_key ? 'configured' : 'missing'],
    ['Supabase', h.has_supabase ? 'configured' : 'missing'],
    ['Stripe', h.has_stripe ? 'configured' : 'missing'],
    ['eBay', h.has_ebay ? 'configured' : 'missing'],
    ['JustTCG', h.has_justtcg ? 'configured' : 'missing'],
    ['RapidAPI', h.has_rapidapi ? 'configured' : 'missing'],
  ];
  root.innerHTML = rows.map(([k, v]) => `
    <div class="setting-row">
      <span class="setting-label">${escapeHtml(k)}</span>
      <span class="figure">${escapeHtml(String(v))}</span>
    </div>`).join('');
}

// ============================================================
// US↔EU Arbitrage Finder
// ============================================================

function wireArbitrage() {
  const ids = {
    arbDirection: applyDirectionUI,
    arbThreshold: () => {
      const out = document.getElementById('arbThresholdLabel');
      const val = document.getElementById('arbThreshold')?.value;
      if (out && val) out.textContent = parseFloat(val).toFixed(2);
    },
  };
  for (const [id, fn] of Object.entries(ids)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', fn);
  }
  const scan = document.getElementById('arbScanBtn');
  const csv = document.getElementById('arbCsvBtn');
  const refresh = document.getElementById('arbRefreshBtn');
  if (scan) scan.addEventListener('click', runArbitrageScan);
  if (csv) csv.addEventListener('click', downloadArbitrageCsv);
  if (refresh) refresh.addEventListener('click', refreshArbitragePrices);
}

function applyDirectionUI() {
  const dir = document.getElementById('arbDirection')?.value || 'us_to_eu';
  const unit = document.getElementById('arbMinPriceUnit');
  const minLbl = document.getElementById('arbMinPriceLabel');
  const thrLbl = document.getElementById('arbThresholdRowLabel');
  if (unit) unit.textContent = dir === 'eu_to_us' ? '€' : '$';
  if (minLbl) minLbl.textContent = dir === 'eu_to_us' ? 'Min EUR price' : 'Min USD price';
  if (thrLbl) thrLbl.textContent = dir === 'eu_to_us' ? 'Threshold (US ≥ EU ×)' : 'Threshold (EU ≥ US ×)';
}

function setArbStatus(msg, color) {
  const el = document.getElementById('arbStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = color || 'var(--paper-300)';
}

async function runArbitrageScan() {
  const btn = document.getElementById('arbScanBtn');
  const out = document.getElementById('arbResults');
  if (!btn || !out) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Scanning…';
  setArbStatus('Scanning…');
  out.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="surface" style="display:flex; gap:var(--p-3); margin-bottom:var(--p-2);">
      <div class="skeleton" style="width:48px; height:64px;"></div>
      <div style="flex:1;">
        <div class="skeleton skel-line" style="width:60%;"></div>
        <div class="skeleton skel-line" style="width:30%; margin-top:8px;"></div>
      </div>
    </div>`).join('');
  const direction = document.getElementById('arbDirection')?.value || 'us_to_eu';
  const body = {
    direction,
    minSrcPrice: parseFloat(document.getElementById('arbMinUsd')?.value) || 0,
    threshold: parseFloat(document.getElementById('arbThreshold')?.value) || 1.30,
    variant: document.getElementById('arbVariant')?.value || 'auto',
    sortBy: document.getElementById('arbSortBy')?.value || 'ratio',
    liquidity: document.getElementById('arbLiquidity')?.value || 'any',
    limit: parseInt(document.getElementById('arbLimit')?.value, 10) || 100,
  };
  const r = await postJson('/api/admin/arbitrage', body);
  btn.disabled = false;
  btn.textContent = orig;
  if (!r.ok) {
    setArbStatus(r.error || ('Scan failed (' + r.status + ')'), 'var(--down)');
    out.innerHTML = '';
    return;
  }
  const data = r.body || {};
  _arbLastResults = data.results || [];
  _arbLastDirection = data.direction || direction;
  const ageMin = data.lastRefreshAt ? Math.round((Date.now() - data.lastRefreshAt) / 60000) : null;
  const ageStr = ageMin == null ? 'no snapshot — click Refresh prices'
    : (ageMin < 1 ? 'just now' : ageMin < 60 ? ageMin + ' min ago' : Math.round(ageMin / 60) + ' h ago');
  const dirLabel = _arbLastDirection === 'eu_to_us' ? 'EU → US' : 'US → EU';
  setArbStatus(`${dirLabel} · ${(data.cardsPriced || 0).toLocaleString()} priced cards · ${data.matched || 0} matched · USD→EUR ${(data.rate || 0).toFixed(4)} · prices ${ageStr}.`);
  if (!_arbLastResults.length) {
    out.innerHTML = '<div class="empty-state"><p>No cards matched these filters.</p></div>';
    return;
  }
  out.innerHTML = _arbLastResults.map(arbRowHtml).join('');
}

function arbRowHtml(r) {
  const variantLabel = ({
    normal: 'NORMAL', holofoil: 'HOLO', reverseHolofoil: 'REV HOLO',
    '1stEditionNormal': '1ST ED', '1stEditionHolofoil': '1ST ED HOLO',
    unlimitedHolofoil: 'UNL HOLO',
  })[r.variant] || r.variant;
  const buySide = _arbLastDirection === 'eu_to_us' ? 'eu' : 'us';
  const usCls = buySide === 'us' ? 'arb-buy' : 'arb-sell';
  const euCls = buySide === 'eu' ? 'arb-buy' : 'arb-sell';
  const spreadCcy = r.spreadCurrency === 'USD' ? '$' : '€';
  let trendHtml = '';
  if (r.cmAvg30 && r.eur && Math.abs(r.eur - r.cmAvg30) > 0.01) {
    const up = r.eur > r.cmAvg30;
    const pct = Math.round(Math.abs((r.eur - r.cmAvg30) / r.cmAvg30) * 100);
    trendHtml = `<span class="status-badge ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${pct}% vs 30d</span>`;
  }
  return `
    <div class="surface" style="display:grid; grid-template-columns:48px 1fr auto auto; gap:var(--p-3); margin-bottom:var(--p-2); align-items:center;">
      ${r.image ? `<img src="${escapeAttr(r.image)}" loading="lazy" style="width:48px; aspect-ratio:5/7; object-fit:cover; border-radius:var(--r-1);">` : '<div style="width:48px;"></div>'}
      <div style="min-width:0;">
        <div class="display" style="font-size:14px;">${escapeHtml(r.name)}</div>
        <div class="figure" style="font-size:11px; color:var(--paper-300);">${escapeHtml((r.setCode || '').toUpperCase())} · #${escapeHtml(r.number || '')} · ${escapeHtml(variantLabel)}</div>
      </div>
      <div style="text-align:right;">
        <div class="figure ${usCls}" style="${usCls === 'arb-sell' ? 'color:var(--up);' : 'color:var(--paper-300);'}">$${(r.usd || 0).toFixed(2)}</div>
        <div class="figure ${euCls}" style="${euCls === 'arb-sell' ? 'color:var(--up);' : 'color:var(--paper-300);'}">€${(r.eur || 0).toFixed(2)}</div>
        ${trendHtml ? '<div style="margin-top:2px;">' + trendHtml + '</div>' : ''}
      </div>
      <div style="text-align:right;">
        <div class="status-badge up" style="display:inline-block;">×${(r.ratio || 0).toFixed(2)}</div>
        <div class="figure" style="font-size:11px; color:var(--paper-300); margin-top:2px;">+${spreadCcy}${(r.spread || 0).toFixed(2)}</div>
      </div>
    </div>`;
}

function downloadArbitrageCsv() {
  if (!_arbLastResults.length) {
    setArbStatus('Nothing to download — run a scan first.', 'var(--accent)');
    return;
  }
  const csvEsc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = ['Name', 'Set name', 'Set code', 'Number', 'Rarity', 'Variant',
    'USD', 'EUR', 'USD in EUR', 'Ratio', 'Spread', 'Spread currency', 'Direction',
    'EU avg7 (EUR)', 'EU avg30 (EUR)', 'US low/market', 'TCGplayer URL', 'Cardmarket URL'];
  const lines = [header.map(csvEsc).join(',')];
  for (const r of _arbLastResults) {
    lines.push([
      r.name, r.setName, r.setCode, r.number, r.rarity, r.variant,
      r.usd, r.eur, r.usdInEur, r.ratio, r.spread, r.spreadCurrency || 'EUR',
      r.direction || _arbLastDirection,
      r.cmAvg7 ?? 0, r.cmAvg30 ?? 0, r.tcgLowMarketRatio ?? 0,
      r.tcgplayerUrl, r.cardmarketUrl,
    ].map(csvEsc).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `arbitrage-${_arbLastDirection}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setArbStatus(`Downloaded ${_arbLastResults.length} rows.`, 'var(--up)');
}

async function refreshArbitragePrices() {
  const btn = document.getElementById('arbRefreshBtn');
  if (!btn) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Refreshing…';
  const r = await postJson('/api/admin/refresh-prices', null);
  btn.disabled = false;
  btn.textContent = orig;
  if (!r.ok) {
    setArbStatus(r.error || 'Refresh failed', 'var(--down)');
    return;
  }
  if (r.body?.alreadyLoading) {
    setArbStatus('A refresh is already running — polling…', 'var(--accent)');
  } else {
    setArbStatus('Refresh started — pulling all sets from pokemontcg.io. Takes ~5 minutes.', 'var(--accent)');
  }
  if (_arbPoll) clearInterval(_arbPoll);
  _arbPoll = setInterval(async () => {
    const sr = await getJson('/api/admin/refresh-status');
    if (!sr.ok) return;
    const s = sr.body || {};
    if (s.loading) {
      setArbStatus(`Refreshing… ${(s.cardsPriced || 0).toLocaleString()} priced so far (${(s.cardsTotal || 0).toLocaleString()} cards).`, 'var(--accent)');
    } else {
      clearInterval(_arbPoll); _arbPoll = null;
      const ageMin = s.lastRefreshAt ? Math.round((Date.now() - s.lastRefreshAt) / 60000) : null;
      setArbStatus(`Refresh complete: ${(s.cardsPriced || 0).toLocaleString()} priced · USD→EUR ${(s.rate || 0).toFixed(4)}${ageMin == null ? '' : ' · ' + (ageMin < 1 ? 'just now' : ageMin + ' min ago')}.`, 'var(--up)');
    }
  }, 5000);
}

// ============================================================
// Analytics (V2 S13 / F8)
// ============================================================
//
// Renders quotes/day sparkline + stat tiles + top-cards table.
// All numbers use .figure (Plex Mono + tabular-nums). Sparkline is
// inline SVG — DESIGN_BRIEF bans chart libraries.

function wireAnalytics() {
  document.querySelectorAll('[data-analytics-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const win = btn.getAttribute('data-analytics-window') || '30d';
      if (win === _analyticsWindow) return;
      _analyticsWindow = win;
      updateAnalyticsWindowButtons();
      loadAnalytics();
    });
  });
  updateAnalyticsWindowButtons();
}

function updateAnalyticsWindowButtons() {
  document.querySelectorAll('[data-analytics-window]').forEach((btn) => {
    const win = btn.getAttribute('data-analytics-window');
    btn.classList.toggle('primary', win === _analyticsWindow);
    btn.classList.toggle('ghost', win !== _analyticsWindow);
  });
}

async function loadAnalytics() {
  const root = document.getElementById('adminAnalytics');
  if (!root) return;
  const status = document.getElementById('adminAnalyticsStatus');
  if (status) status.textContent = 'Loading…';
  const r = await getJson(`/api/admin/analytics?window=${encodeURIComponent(_analyticsWindow)}`);
  if (!r.ok) {
    if (status) {
      status.textContent = r.error || ('Analytics failed (' + r.status + ')');
      status.style.color = 'var(--down)';
    }
    return;
  }
  const data = r.body || {};
  if (status) {
    status.textContent = `${data.window || _analyticsWindow} · ${(data.totals?.quotes || 0).toLocaleString()} quotes${data.truncated ? ' (capped at ' + (data.row_cap || 5000) + ')' : ''}`;
    status.style.color = 'var(--paper-300)';
  }
  renderAnalyticsSparkline(data.quotes_per_day || []);
  renderAnalyticsTotals(data.totals || {}, data.conversion_pct ?? 0);
  renderAnalyticsTopCards(data.top_cards || []);
}

function renderAnalyticsSparkline(points) {
  const wrap = document.getElementById('adminAnalyticsSparkline');
  if (!wrap) return;
  if (!points.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:var(--p-3); font-size:12px;">No quotes in this window.</div>';
    return;
  }
  const W = 600, H = 80, padX = 4, padY = 6;
  const max = Math.max(1, ...points.map((p) => p.count));
  const xStep = (W - padX * 2) / Math.max(1, points.length - 1);
  const yScale = (v) => H - padY - ((v / max) * (H - padY * 2));
  const xAt = (i) => padX + i * xStep;
  const linePoints = points.map((p, i) => `${xAt(i).toFixed(1)},${yScale(p.count).toFixed(1)}`).join(' ');
  // 4 horizontal hairline gridlines (0, 1/3 max, 2/3 max, max).
  const gridY = [0, max / 3, (2 * max) / 3, max].map((v) => yScale(v));
  const gridLines = gridY.map((y) =>
    `<line class="sparkline-grid" x1="${padX}" x2="${W - padX}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />`
  ).join('');
  // Inline tooltip dots — one circle per point with a <title> for hover.
  const dots = points.map((p, i) =>
    `<circle cx="${xAt(i).toFixed(1)}" cy="${yScale(p.count).toFixed(1)}" r="2" fill="var(--accent)"><title>${escapeHtml(p.date)} · ${p.count}</title></circle>`
  ).join('');
  const first = points[0]?.date || '';
  const last  = points[points.length - 1]?.date || '';
  wrap.innerHTML = `
    <svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Quotes per day">
      ${gridLines}
      <polyline class="sparkline-line" points="${linePoints}" />
      ${dots}
    </svg>
    <div class="sparkline-axis figure">
      <span>${escapeHtml(first)}</span>
      <span>peak ${max}</span>
      <span>${escapeHtml(last)}</span>
    </div>`;
}

function renderAnalyticsTotals(t, conversionPct) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('analyticsQuotes', String(t.quotes || 0));
  set('analyticsLeads', String(t.leads || 0));
  set('analyticsAvgMarket', '€' + (t.avg_basket_market || 0).toFixed(2));
  set('analyticsAvgCash',   '€' + (t.avg_basket_cash   || 0).toFixed(2));
  set('analyticsAvgCredit', '€' + (t.avg_basket_credit || 0).toFixed(2));
  set('analyticsAvgCardCount', (t.avg_card_count || 0).toFixed(1));
  set('analyticsConversion', (conversionPct || 0) + '%');
}

function renderAnalyticsTopCards(cards) {
  const tbody = document.getElementById('adminAnalyticsTopCardsBody');
  if (!tbody) return;
  if (!cards.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--paper-300);">No cards quoted yet.</td></tr>';
    return;
  }
  tbody.innerHTML = cards.map((c, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td>${escapeHtml(c.name || '—')}</td>
      <td><span class="data-badge">${escapeHtml((c.set_code || '').toUpperCase())}${c.card_number ? ' · #' + escapeHtml(c.card_number) : ''}</span></td>
      <td class="num">${c.count || 0}</td>
      <td class="num">€${(c.avg_market || 0).toFixed(2)}</td>
    </tr>`).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
