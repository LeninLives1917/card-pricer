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
// Each row in the customer PDF can show TWO images:
//
//   userImage — the operator's source scan (entry.image): proves which
//               specific physical card the customer handed over. Empty
//               for text/manual entries (no scan exists).
//   image     — the catalogue art: pokemontcg.io / scryfall reference,
//               same image Cardmarket displays. Priority:
//                 1. entry.reference_image   (set by /api/price)
//                 2. card.image_url          (legacy code paths)
//                 3. card.reference_image    (manualIdentifyCore path)
//
// Layout rule:
//   - both present (image scan)  → side-by-side: "Scanned" + "Identified"
//   - only catalogue (text/manual) → single thumb, original layout
//   - neither (rare edge case)     → blank slot
//
// This matches the dual-thumb behaviour shipped to the in-app result
// surfaces (session log, results pane, result-sheet modal) so the
// customer-facing PDF tells the same story.

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
  console.log('[PDF] exportSessionPdf called', {
    sessionName: session?.name,
    cards: session?.log?.length,
    pricing,
  });
  if (!session || !Array.isArray(session.log) || !session.log.length) {
    alert('Nothing to export — this session is empty.');
    return;
  }
  // Re-use the caller's overlay if they already showed one (covers the
  // top-up step in session.js); otherwise show our own.
  const ownOverlay = !document.getElementById('cp-pdf-overlay');
  const overlay = ownOverlay ? showPokeballOverlay() : { hide: () => {} };
  try {
    return await _exportInner(session, pricing, opts);
  } catch (err) {
    console.error('[PDF] export failed:', err);
    alert('Could not generate PDF: ' + (err?.message || 'unknown error'));
  } finally {
    overlay.hide();
    // Always clean up any overlay (own or borrowed) once export finishes.
    const stray = document.getElementById('cp-pdf-overlay');
    if (stray) stray.remove();
  }
}

// Public wrapper so callers can show the Pokéball spinner during work that
// happens BEFORE exportSessionPdf (e.g. fetching missing card images).
// Returns a handle with .hide() — though exportSessionPdf will tear down
// any overlay it finds when it completes, so callers normally don't need
// to hide it themselves.
export function showPdfOverlay() {
  return showPokeballOverlay();
}

// Spinning-Pokéball overlay shown while we compose the printable doc and
// wait for images. Pure inline-style + CSS keyframes so it works without
// any external assets — colours match the V2 token palette (accent =
// burnt-umber, paper-300 = cream).
function showPokeballOverlay() {
  // De-dupe: if a previous PDF run hasn't torn the overlay down yet,
  // re-use it instead of stacking another on top.
  let host = document.getElementById('cp-pdf-overlay');
  if (!host) {
    host = document.createElement('div');
    host.id = 'cp-pdf-overlay';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.innerHTML = `
      <style>
        #cp-pdf-overlay {
          position: fixed; inset: 0; z-index: 99999;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          background: rgba(20, 17, 15, 0.55);
          backdrop-filter: blur(2px);
          -webkit-backdrop-filter: blur(2px);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
          color: #f4ecdf;
          animation: cpPdfFade 220ms ease-out;
        }
        @keyframes cpPdfFade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        #cp-pdf-overlay .cp-poke {
          width: 88px; height: 88px;
          border-radius: 50%;
          background:
            radial-gradient(circle at 50% 50%, #f4ecdf 0 11px, #14110f 11px 14px, transparent 14px),
            linear-gradient(180deg, #d23636 0 50%, #f4ecdf 50% 100%);
          box-shadow:
            inset 0 -2px 0 rgba(0,0,0,0.18),
            inset 0 2px 0 rgba(255,255,255,0.18),
            0 6px 18px rgba(0,0,0,0.35);
          position: relative;
          animation: cpPokeSpin 1.1s linear infinite;
        }
        #cp-pdf-overlay .cp-poke::before {
          content: '';
          position: absolute;
          left: 0; right: 0; top: 50%;
          height: 6px; transform: translateY(-50%);
          background: #14110f;
        }
        @keyframes cpPokeSpin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        #cp-pdf-overlay .cp-msg {
          margin-top: 18px;
          font-family: 'Fraunces', Georgia, serif;
          font-size: 17px;
          letter-spacing: 0.2px;
        }
        #cp-pdf-overlay .cp-sub {
          margin-top: 4px;
          font-size: 12px;
          opacity: 0.75;
        }
      </style>
      <div class="cp-poke" aria-hidden="true"></div>
      <div class="cp-msg">Building your PDF…</div>
      <div class="cp-sub">Loading card images — your print dialog will open shortly.</div>
    `;
    document.body.appendChild(host);
  }
  return {
    hide() {
      try {
        host.remove();
      } catch {}
    },
  };
}

async function _exportInner(session, pricing, opts) {

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
  const image = entry.reference_image || card.image_url || card.reference_image || '';
  // Source scan (operator's photo); only present for image-driven scans.
  const userImage = entry.image || '';
  // Cardmarket link priority:
  //   1. cm.url               — direct product page (rapidapi_cm path)
  //   2. cm.filtered_url      — filtered search (lang=en + condition)
  //   3. cm.search_url        — name+number search
  //   4. card.cardmarket_url  — manual-identify capture
  //   5. derived search URL   — always-on fallback built from card name + set
  //                              + game, so every row gets a clickable link
  //                              even if /api/price never set the cardmarket
  //                              fields (legacy / unpriced entries).
  // Only http(s) URLs survive — never render javascript: or data: schemes
  // from a malformed entry.
  const rawLink =
    (cm.url) ||
    (cm.filtered_url) ||
    (cm.search_url) ||
    (card.cardmarket_url) ||
    deriveCardmarketSearchUrl(card);
  const cardmarketUrl = /^https?:\/\//i.test(rawLink) ? rawLink : '';
  return {
    name: card.name || 'Unknown card',
    setLabel: [card.set_code, card.card_number].filter(Boolean).join(' '),
    setName: card.set_name || '',
    rarity: card.rarity || '',
    qty,
    image,
    userImage,
    cardmarketUrl,
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

// Build a Cardmarket search URL from card data. Mirrors
// pricing/adapters/cardmarket-html.js#buildCardmarketUrl on the server so
// the PDF can always produce a link even for entries that never went
// through /api/price (legacy data, manual-identify-only rows, etc.).
function deriveCardmarketSearchUrl(card) {
  const name = (card?.name || '').trim();
  if (!name) return '';
  // Tighten the search by appending the numeric part of card_number when
  // we have one — gets the customer to the right printing instead of a
  // page of every Pikachu ever printed.
  const num = String(card?.card_number || '').replace(/\/.*/, '').replace(/^0+/, '');
  const term = num ? `${name} ${num}` : name;
  const slug = (card?.game === 'pokemon') ? 'Pokemon'
             : (card?.game === 'magic')   ? 'Magic'
             : '';
  const base = slug
    ? `https://www.cardmarket.com/en/${slug}/Products/Search`
    : `https://www.cardmarket.com/en/Search`;
  return `${base}?searchString=${encodeURIComponent(term)}`;
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

  const cardsHtml = rows.map((r) => {
    // crossorigin is OFF on every <img>: the attribute forces a CORS
    // preflight that pokemontcg.io / scryfall don't honour for hotlinks,
    // leaving the image broken in the PDF. We never read pixels via
    // canvas so we don't need it. referrer-policy stays so we don't
    // leak Render's host as the referrer to the catalogue source.
    const refImg = r.image
      ? `<img src="${escapeAttr(r.image)}" alt="" referrerpolicy="no-referrer">`
      : '';
    const userImg = r.userImage
      ? `<img src="${escapeAttr(r.userImage)}" alt="" referrerpolicy="no-referrer">`
      : '';
    // When we have BOTH the operator's scan and the catalogue art, render
    // a side-by-side "Scanned / Identified" pair so the customer can
    // verify the match. When we only have the catalogue (text/manual
    // entries), fall back to the original single-thumb layout.
    const thumbsBlock = (r.userImage && r.image)
      ? `<div class="card-thumbs dual">
           <div class="card-thumb-cell">
             <div class="card-thumb">${userImg}</div>
             <span class="card-thumb-cap">Scanned</span>
           </div>
           <div class="card-thumb-cell">
             <div class="card-thumb">${refImg}</div>
             <span class="card-thumb-cap">Identified</span>
           </div>
         </div>`
      : `<div class="card-thumb">${refImg || userImg}</div>`;
    // Wrap the name in a Cardmarket hyperlink when we have one. PDF
    // viewers preserve <a href> as a clickable link — the customer can
    // tap through to verify the listing themselves.
    const linkOpen  = r.cardmarketUrl ? `<a href="${escapeAttr(r.cardmarketUrl)}" target="_blank" rel="noopener" class="card-link">` : '';
    const linkClose = r.cardmarketUrl ? `</a>` : '';
    const linkFoot = r.cardmarketUrl
      ? `<a class="card-cm-foot" href="${escapeAttr(r.cardmarketUrl)}" target="_blank" rel="noopener">View on Cardmarket →</a>`
      : '';
    return `
    <article class="card${(r.userImage && r.image) ? ' has-dual-thumb' : ''}">
      ${thumbsBlock}
      <div class="card-body">
        <h3 class="card-name">${linkOpen}${escapeHtml(r.name)}${linkClose}${r.qty > 1 ? ` <span class="qty">×${r.qty}</span>` : ''}</h3>
        <p class="card-set">${escapeHtml(r.setLabel)}${r.setName ? ' · ' + escapeHtml(r.setName) : ''}${r.rarity ? ' · ' + escapeHtml(r.rarity) : ''}</p>
        <dl class="card-prices">
          <div><dt>Market</dt><dd>${r.market}</dd></div>
          ${showCash   ? `<div class="cash"><dt>Cash offer</dt><dd>${r.cash}</dd></div>`     : ''}
          ${showCredit ? `<div class="credit"><dt>Store credit</dt><dd>${r.credit}</dd></div>` : ''}
        </dl>
        ${linkFoot}
      </div>
    </article>
  `;
  }).join('');

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
  /* When the row carries both a scan AND a catalogue image, widen the
     thumb column so two ~46px thumbs fit side by side without squeezing
     the body text. ~100px total (46 + 6 gap + 46 + 2 padding slack). */
  article.card.has-dual-thumb {
    grid-template-columns: 100px 1fr;
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
  /* Dual-thumb wrapper: two thumb-cells side-by-side, each with a tiny
     "Scanned" / "Identified" caption underneath so the customer can tell
     which is which at a glance. */
  .card-thumbs.dual {
    display: flex;
    gap: 6px;
  }
  .card-thumb-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .card-thumbs.dual .card-thumb {
    width: 46px;
  }
  .card-thumb-cap {
    font-size: 6.5pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #877c6f;
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

  /* Card name doubles as a Cardmarket link — keep the visual identical
     to plain text (no underline, no colour change) so the printed page
     stays clean; the hyperlink is preserved by PDF viewers regardless. */
  .card-name a {
    color: inherit;
    text-decoration: none;
  }
  /* Small "View on Cardmarket →" line under the prices. Visually
     present so the customer knows the row is verifiable, plus a real
     hyperlink for digital-PDF readers. */
  .card-cm-foot {
    display: block;
    margin-top: 6px;
    font-size: 8.5pt;
    font-weight: 500;
    color: #1f5fa6;
    text-decoration: none;
    letter-spacing: 0.2px;
  }

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
    Market values are the lowest Near-Mint English listing on Cardmarket
    at the time of quote. Offers reflect our current cash and store-credit
    percentages and are valid for 7 days subject to inspection of the
    physical cards.
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

    const runPrint = () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) {
        console.warn('[PDF] iframe has no document/window after load');
        cleanup();
        return;
      }

      // Wait for every <img> in the doc to settle (or 4s, whichever is
      // first). Without the cap, a slow card-image fetch silently
      // suppresses the print dialog forever.
      const imgs = Array.from(doc.images || []);
      const imgReady = imgs.length === 0 ? Promise.resolve() : Promise.all(
        imgs.map((img) => img.complete ? Promise.resolve()
          : new Promise((r) => { img.onload = img.onerror = () => r(); })
        ),
      );
      const cap = new Promise((r) => setTimeout(r, 4000));
      Promise.race([imgReady, cap]).then(() => {
        console.log('[PDF] images ready, opening print dialog');
        try {
          win.focus();
          win.print();
        } catch (err) {
          console.warn('[PDF] print() threw:', err);
        }
        cleanup();
      });
    };

    // Hard-timeout safety net: if the 'load' event never fires (it can
    // fire synchronously inside appendChild for srcdoc and miss any
    // listener added later, or be eaten if the iframe is reparented), this
    // forces the print after 1.5s. runPrint is idempotent via `printed`.
    const fallback = setTimeout(() => {
      if (!printed) {
        console.warn('[PDF] load event never fired — forcing print()');
        runPrint();
      }
    }, 1500);

    // CRITICAL: attach the load listener BEFORE writing srcdoc and
    // appending the iframe. With srcdoc, browsers can fire 'load'
    // synchronously inside appendChild — too late to register a listener
    // afterwards. v412c367 had this in the wrong order, which is why the
    // dialog never opened.
    iframe.addEventListener('load', () => {
      clearTimeout(fallback);
      runPrint();
    });

    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

// Pure-function escape hatches for regression tests
// (tests/regression/pdf-export.spec.js). Not part of the public API — the
// vendor app uses exportSessionPdf only.
export const _test_internals = { buildRow, renderPrintHtml, euro, round2, deriveCardmarketSearchUrl };

export default { exportSessionPdf };
