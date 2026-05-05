// apps/quote/modules/lead-gate.js
// Owner: A5 | Slice: S8
//
// Email-gate UI + /api/quote-lead submit + postMessage(cp:submitted/cp:close)
// to the parent widget. Mirrors V1 leadSubmit handler at public/quote.html
// lines 648-733 (V2_AUDIT §1c). The lead row persists server-side regardless
// of Brevo email success — that ordering is V2_AUDIT §5.13 / R6 invariant.

import { sumTotals } from './totals.js';
import { EMBED_MODE, SHOP_SLUG, postToParent } from './shop-config.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} args
 * @param {() => Array<any>} args.getResults    Returns current state.results.
 * @param {() => number} args.getCashPct
 * @param {() => number} args.getCreditPct
 * @param {(path:string, opts:object)=>Promise<{ok:boolean,status:number,body:any}>} args.request
 * @param {() => void} args.unlockResults       Called after successful submit.
 */
export function bindLeadGate({ getResults, getCashPct, getCreditPct, request, unlockResults }) {
  const submitBtn = document.getElementById('leadSubmit');
  if (!submitBtn) return;

  submitBtn.addEventListener('click', async () => {
    const emailEl = document.getElementById('leadEmail');
    const nameEl = document.getElementById('leadName');
    const newsEl = document.getElementById('leadNewsletter');
    const successEl = document.getElementById('leadSuccess');

    const email = (emailEl?.value || '').trim();
    const name = (nameEl?.value || '').trim();
    const newsletter = !!newsEl?.checked;

    if (!email || !EMAIL_RE.test(email)) {
      alert('Please enter a valid email to see your quote.');
      return;
    }

    const all = getResults() || [];
    const priced = all.filter((r) => r && !r.error && r.card);

    if (!priced.length) {
      const errCount = all.filter((r) => r?.error).length;
      if (errCount > 0) {
        alert(
          'None of the ' +
            errCount +
            ' card(s) could be priced. Please check the set codes and card numbers and try again.'
        );
      } else if (!all.length) {
        alert('Please enter your cards and click "Get my quote" first.');
      } else {
        alert('No priced cards to send. Please try again.');
      }
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Unlocking...';

    const totals = sumTotals(priced);
    const cards = priced.map((it) => ({
      name: it.card.name,
      set_name: it.card.set_name,
      set_code: it.card.set_code,
      card_number: it.card.card_number,
      condition_estimate: it.card.condition_estimate || 'NM',
      market_value: it.market,
      cash_offer: it.cash,
      credit_offer: it.credit,
      photo: null,
    }));

    try {
      const r = await request('/api/quote-lead', {
        method: 'POST',
        body: {
          email,
          name,
          newsletter,
          cards,
          totals,
          cashPct: getCashPct(),
          creditPct: getCreditPct(),
          shop_slug: SHOP_SLUG,
        },
      });
      if (!r.ok) throw new Error('Server rejected quote');
      const data = r.body || {};

      if (typeof unlockResults === 'function') unlockResults();
      if (successEl) {
        successEl.style.display = '';
        successEl.textContent = data.emailed
          ? newsletter
            ? 'Quote unlocked & emailed. Welcome to the list!'
            : 'Quote unlocked & emailed — check your inbox.'
          : "Quote unlocked. We'll be in touch shortly.";

        // S12 (F6): if persistence succeeded, surface the stable URL so
        // customers can bookmark / re-open the quote without the email.
        // When data.quote_url is null (supabase unavailable) we suppress
        // the bookmark panel and fall back to the email-only message.
        if (data.quote_url) {
          successEl.appendChild(buildBookmarkPanel(data.quote_url));
        }
      }

      // Notify the parent widget loader (audit §1c lines 711-727).
      // Origin check is the parent's responsibility; we send to '*' because
      // the parent's origin is the host shop's site, unknown in advance.
      if (EMBED_MODE) {
        postToParent({ type: 'cp:submitted', shop: SHOP_SLUG });
        if (successEl) successEl.appendChild(buildCloseLink());
      }
    } catch (e) {
      alert("Couldn't save your details — please try again, or contact us directly.");
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock my quote';
    }
  });
}

/**
 * S12 (F6): build the "Bookmark this URL" panel shown after a successful
 * submit. Two pieces: the URL displayed read-only (for muscle-memory
 * copy-paste) + a Copy button that calls navigator.clipboard. We do NOT
 * use innerHTML here — every value passes through textContent / value
 * assignments so quote_url can never inject markup.
 */
function buildBookmarkPanel(url) {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'margin-top:10px;padding:10px;border:1px solid #2c3344;border-radius:6px;background:#161a23;';

  const label = document.createElement('div');
  label.textContent = 'Bookmark this URL to revisit your quote:';
  label.style.cssText = 'font-size:12px;color:#9aa3b2;margin-bottom:6px;';
  wrap.appendChild(label);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center;';

  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = url;
  input.style.cssText =
    'flex:1;font-size:12px;padding:6px 8px;border:1px solid #2c3344;border-radius:4px;background:#0e1117;color:#e6e8ec;font-family:monospace;';
  input.addEventListener('focus', () => input.select());
  row.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.style.cssText =
    'font-size:12px;padding:6px 10px;border:1px solid #2c3344;border-radius:4px;background:#1f2330;color:#e6e8ec;cursor:pointer;';
  btn.addEventListener('click', async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        input.select();
        document.execCommand && document.execCommand('copy');
      }
      const prev = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch {
      // Clipboard blocked — at least the input is selected for manual copy.
      input.select();
    }
  });
  row.appendChild(btn);

  wrap.appendChild(row);
  return wrap;
}

/**
 * Build the "Close ✕" link that lets the user dismiss the iframe modal
 * without hunting for the widget's own close button.
 */
function buildCloseLink() {
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = ' Close ✕';
  a.style.cssText =
    'margin-left:8px;color:var(--rare);text-decoration:underline;cursor:pointer;font-size:12px';
  a.addEventListener('click', (ev) => {
    ev.preventDefault();
    postToParent({ type: 'cp:close' });
  });
  return a;
}

/**
 * Reset the gate UI. Called by the Clear button in main.js.
 */
export function resetLeadGate() {
  const successEl = document.getElementById('leadSuccess');
  if (successEl) {
    successEl.style.display = 'none';
    successEl.textContent = 'Sent! Check your inbox for a copy of your quote.';
  }
  const btn = document.getElementById('leadSubmit');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Unlock my quote';
  }
}
