// apps/vendor/modules/pdf-export.js
//
// Customer-facing session PDF. Renders a clean printable HTML doc into a
// hidden iframe, waits for images to settle, then triggers window.print()
// so the operator can hit "Save as PDF" in the browser print dialog.
//
// Why a hidden iframe and not a popup? Popup blockers will eat
// window.open() calls that aren't a direct synchronous result of a click;
// by the time we've awaited image preloads, the heuristic counts it as
// programmatic. An iframe avoids the issue entirely. After printing, the
// iframe is removed.
//
// Why print-to-PDF and not a JS PDF lib (jsPDF / pdfkit)? Zero deps, the
// browser's PDF engine handles fonts/colour better than anything we'd
// embed, and the customer cosmetic decisions (image size, page breaks)
// fall out of CSS. The trade-off is a manual "Save as PDF" step in the
// print dialog — acceptable for an operator-driven action.
//
// Image source priority: card.image_url → card.reference_image → e.image
// (scan photo). The first two are the official card art (same image
// Cardmarket displays); e.image is the operator's phone snap and is the
// last-resort fallback for entries that never got a verified DB hit.

import { getSetting } from './state.js';

/**
 * Build and print a customer-facing PDF for the current session.
 *
 * @param {object}   session              the session object (state.sessions[id])
 * @param {object}   pricing              { cashPct, creditPct, sellMarkup }
 *                                        snapshot of the slider values at
 *                                        export time so the totals match
 *                                        what the operator currently sees.
 * @param {object}   [opts]
 * @param {string}   [opts.shopName]      override the localStorage shopName
 * @param {string}   [opts.shopEmail]     override the localStorage shopEmail
 * @param {boolean}  [opts.cashOnly]      hide the credit column
 * @param {boolean}  [opts.creditOnly]    hide the cash column
 */
export async function exportSessionPdf(session, pricing, opts = {}) {
  if (!session || !Array.isArray(session.log) || !session.log.length) {
    alert('Nothing to export — this session is empty.');
    return;
  }

  const shopName = opts.shopName ?? getSetting('shopName', 'Card Pricer');
  const shopEmail = opts.shopEmail ?? getSetting('shopEmail', '');
  const cashPct = Number(pricing?.cashPct) || 0;
  const creditPct = Number(pricing?.creditPct) || 0;

  const rows = session.log.map((e) => buildRow(e, cashPct, creditPct));
  const totals = rows.reduce(
    (acc, r) => {
      acc.market += r.marketRaw;
      acc.cash += r.cashRaw;
      acc.credit += r.creditRaw;
      return acc;
    },
    { market: 0, cash: 0, credit: 0 },
  );

  const html = renderPrintHtml({
    title: `${shopName} — ${session.name || 'Session'}`,
    shopName,
    shopEmail,
    sessionName: session.name || 'Buy quote',
    dateStr: new Date().toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    }),
    rows,
    totals,
    cashPct,
    creditPct,
    showCash: !opts.creditOnly,
    showCredit: !opts.cashOnly,
  });

  await openPrintFrame(html);
}

function buildRow(entry, cashPct, creditPct) {
  const card = entry.card || {};
  const cm = entry.cardmarket || {};
  const bp = entry.buy_price || {};
  const market =
    entry.market_value || bp.market_value || cm.price || cm.trend || 0;
  const cashRaw = entry.custom_buy ?? round2(market * (cashPct / 100));
  const creditRaw = round2(market * (creditPct / 100));
  const qty = (entry.duplicate_count || 0) + 1;
  const image = card.image_url || card.reference_image || entry.image || '';
  return {
    name: card.name || 'Unknown card',
    setLabel: [card.set_code, card.card_number].filter(Boolean).join(' '),
    setName: card.set_name || '',
    rarity: card.rarity || '',
    qty,
    image,
    marketRaw: market * qty,
    cashRaw: cashRaw * qty,
    creditRaw: creditRaw * qty,
    market: euro(market),
    cash: euro(cashRaw),
    credit: euro(creditRaw),
  };
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function euro(n) {
  return '€' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderPrintHtml(ctx) {
  const {
    title, shopName, shopEmail, sessionName, dateStr,
    rows, totals, cashPct, creditPct, showCash, showCredit,
  } = ctx;

  const offerCols = [];
  if (showCash) offerCols.push({ label: `Cash offer (${cashPct}%)`, key: 'cash', total: totals.cash });
  if (showCredit) offerCols.push({ label: `Store credit (${creditPct}%)`, key: 'credit', total: totals.credit });

  const cardsHtml = rows.map((r) => `
    <article class="card">
      <div class="card-thumb">
        ${r.image ? `<img src="${escapeAttr(r.image)}" alt="" referrerpolicy="no-referrer" crossorigin="anonymous">` : ''}
      </div>
      <div class="card-body">
        <h3 class="card-name">${escapeHtml(r.name)}${r.qty > 1 ? ` <span class="qty">×${r.qty}</span>` : ''}</h3>
        <p class="card-set">${escapeHtml(r.setLabel)}${r.setName ? ' · ' + escapeHtml(r.setName) : ''}${r.rarity ? ' · ' + escapeHtml(r.rarity) : ''}</p>
        <dl class="card-prices">
          <div><dt>Market</dt><dd>${r.market}</dd></div>
          ${showCash   ? `<div class="cash"><dt>Cash offer</dt><dd>${r.cash}</dd></div>`     : ''}
          ${showCredit ? `<div class="credit"><dt>Store credit</dt><dd>${r.credit}</dd></div>` : ''}
        </dl>
      </div>
    </article>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  /* Print-friendly. Operator-driven export — colours kept restrained so
     a B&W home printer doesn't muddy the offer figures. */
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
    color: #14110f;
    background: #fff;
    font-size: 11pt;
    line-height: 1.4;
  }
  header.sheet-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    border-bottom: 1.5px solid #14110f;
    padding-bottom: 8px;
    margin-bottom: 14px;
  }
  .sheet-head .shop {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 22pt;
    font-weight: 600;
    line-height: 1;
  }
  .sheet-head .meta {
    text-align: right;
    font-size: 9pt;
    color: #555;
    line-height: 1.5;
  }
  .sheet-head .meta strong {
    display: block;
    color: #14110f;
    font-size: 11pt;
    font-weight: 600;
  }

  .intro {
    font-size: 10pt;
    color: #555;
    margin: 0 0 14px;
    max-width: 65ch;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 14px;
  }

  article.card {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 10px;
    padding: 8px;
    border: 1px solid #e3dfd9;
    border-radius: 6px;
    background: #fff;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .card-thumb {
    width: 64px;
    aspect-ratio: 5 / 7;
    background: #f3eee7;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card-thumb img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  .card-body { min-width: 0; }
  .card-name {
    font-family: 'Fraunces', Georgia, serif;
    font-size: 12pt;
    font-weight: 600;
    margin: 0 0 2px;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .card-name .qty {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 10pt;
    color: #855410;
  }
  .card-set {
    font-size: 8.5pt;
    color: #6b6258;
    margin: 0 0 6px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .card-prices {
    display: grid;
    grid-template-columns: repeat(${1 + offerCols.length}, minmax(0, 1fr));
    gap: 6px;
    margin: 0;
  }
  .card-prices > div {
    display: flex; flex-direction: column;
    border-top: 1px solid #ece7df;
    padding-top: 4px;
  }
  .card-prices dt {
    font-size: 7pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #877c6f;
    margin: 0;
  }
  .card-prices dd {
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11pt;
    font-weight: 600;
  }
  .card-prices .cash dd   { color: #855410; }
  .card-prices .credit dd { color: #2f6f3a; }

  footer.totals {
    margin-top: 18px;
    border-top: 2px solid #14110f;
    padding-top: 10px;
    display: grid;
    grid-template-columns: repeat(${1 + offerCols.length}, minmax(0, 1fr));
    gap: 14px;
    page-break-inside: avoid;
  }
  footer.totals > div { display: flex; flex-direction: column; }
  footer.totals .label {
    font-size: 8.5pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #877c6f;
  }
  footer.totals .figure {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 16pt;
    font-weight: 700;
    margin-top: 2px;
  }
  footer.totals .cash .figure   { color: #855410; }
  footer.totals .credit .figure { color: #2f6f3a; }

  .fineprint {
    margin-top: 14px;
    font-size: 8.5pt;
    color: #877c6f;
    line-height: 1.5;
  }
</style>
</head>
<body>
  <header class="sheet-head">
    <div class="shop">${escapeHtml(shopName)}</div>
    <div class="meta">
      <strong>${escapeHtml(sessionName)}</strong>
      ${escapeHtml(dateStr)}
      ${shopEmail ? `<br>${escapeHtml(shopEmail)}` : ''}
    </div>
  </header>

  <p class="intro">
    Buy quote for ${rows.length} card${rows.length === 1 ? '' : 's'}.
    Market values are sourced from Cardmarket trend prices on the day of quote.
    Offers reflect our current cash and store-credit percentages and are
    valid for 7 days subject to inspection of the physical cards.
  </p>

  <section class="grid">${cardsHtml}</section>

  <footer class="totals">
    <div>
      <span class="label">Market value (×qty)</span>
      <span class="figure">${euro(totals.market)}</span>
    </div>
    ${showCash ? `
      <div class="cash">
        <span class="label">Total cash offer (${cashPct}%)</span>
        <span class="figure">${euro(totals.cash)}</span>
      </div>` : ''}
    ${showCredit ? `
      <div class="credit">
        <span class="label">Total store credit (${creditPct}%)</span>
        <span class="figure">${euro(totals.credit)}</span>
      </div>` : ''}
  </footer>

  <p class="fineprint">
    Final offer is contingent on physical condition matching the grade
    estimated at quote time. Holographic, edition, and language variants
    can shift the value — bring the cards in and we'll confirm before any
    cash or credit is issued.
  </p>
</body>
</html>`;
}

function openPrintFrame(html) {
  return new Promise((resolve) => {
    // Off-screen iframe — same origin so contentWindow.print() is allowed.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.srcdoc = html;
    document.body.appendChild(iframe);

    let printed = false;
    const cleanup = () => {
      if (printed) return;
      printed = true;
      // Give the print dialog a beat to spawn before tearing down.
      setTimeout(() => {
        try { iframe.remove(); } catch {}
        resolve();
      }, 600);
    };

    iframe.addEventListener('load', () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) { cleanup(); return; }

      // Wait for every <img> inside the doc to either load or fail before
      // calling print(). Without this, large card images often show as
      // broken thumbs in the saved PDF on slower connections.
      const imgs = Array.from(doc.images || []);
      const ready = imgs.length === 0 ? Promise.resolve() : Promise.all(
        imgs.map((img) => img.complete ? Promise.resolve()
          : new Promise((r) => { img.onload = img.onerror = () => r(); })
        ),
      );

      ready.then(() => {
        try {
          win.focus();
          win.print();
        } catch (err) {
          console.warn('[PDF] print() threw:', err);
        }
        cleanup();
      });
    });
  });
}

// Pure-function escape hatches for regression tests
// (tests/regression/pdf-export.spec.js). Not part of the public API — the
// vendor app uses exportSessionPdf only.
export const _test_internals = { buildRow, renderPrintHtml, euro, round2 };

export default { exportSessionPdf };
