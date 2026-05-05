// ROLLBACK TARGET — DO NOT MODIFY. Restore by `cp apps/widget/widget-v1.js public/widget.js && deploy`. Per V2_ARCHITECTURE Q6 release runbook §9.
/**
 * Card Pricer embed widget loader.
 *
 * Customer shops drop this script tag into their site:
 *   <script src="https://card-pricer-60qq.onrender.com/widget.js"
 *           data-shop="brewed" data-color="#b45309"
 *           data-position="floating" defer></script>
 *
 * It injects a "Get a quote" button (inline next to the script tag, or
 * floating bottom-right). Clicking it opens a modal containing an iframe
 * pointing at /quote?embed=1&shop=<slug>. Branding is applied inside the
 * iframe by quote.html using /api/shop-config/:slug.
 *
 * No build step. Hand-written vanilla IIFE. Uses inline `style="all:revert"`
 * to defend against host-CSS bleed (Shadow DOM is overkill for two
 * elements). z-index uses max int32 — anything higher is exotic.
 */
(function () {
  'use strict';

  // 1. Find OUR script tag. document.currentScript only works during initial
  //    top-level execution; fall back to scanning <script> for one with our
  //    src in case someone loads us async/manually.
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('/widget.js') !== -1) return scripts[i];
    }
    return null;
  })();
  if (!script) return;

  var origin = (function () {
    try { return new URL(script.src).origin; } catch (_) { return ''; }
  })();
  if (!origin) { console.warn('[card-pricer-widget] could not derive origin from script src'); return; }

  var shop = script.getAttribute('data-shop');
  if (!shop) { console.warn('[card-pricer-widget] missing data-shop attribute'); return; }

  var color = script.getAttribute('data-color') || '#b45309';
  var label = script.getAttribute('data-label') || 'Get a quote on your cards';
  var position = (script.getAttribute('data-position') || 'inline').toLowerCase();

  // 2. Inject the button. Use inline styles + `all: revert` so host CSS
  //    can't restyle into oblivion. Floating mode anchors bottom-right
  //    via position:fixed; inline mode places before the script tag.
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp-widget-btn';
  btn.textContent = label;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.style.cssText = [
    'all: revert',
    'background:' + color,
    'color:#fff',
    'border:0',
    'padding:12px 20px',
    'border-radius:10px',
    'font:600 15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,.18)',
    'line-height:1.2',
    'letter-spacing:0.01em',
    'display:inline-block'
  ].join(';');

  function mount() {
    if (position === 'floating') {
      btn.style.position = 'fixed';
      btn.style.right = '20px';
      btn.style.bottom = '20px';
      btn.style.zIndex = '2147483646';
      document.body.appendChild(btn);
    } else if (script.parentNode) {
      script.parentNode.insertBefore(btn, script);
    } else if (document.body) {
      document.body.appendChild(btn);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // 3. Modal — created lazily on first click. Click-outside or X to close.
  //    Iframe loads /quote?embed=1&shop=<slug>.
  var modal = null;
  var iframe = null;

  function openModal() {
    if (modal) {
      modal.style.display = 'flex';
      document.documentElement.style.overflow = 'hidden';
      return;
    }
    modal = document.createElement('div');
    modal.className = 'cp-widget-modal';
    modal.style.cssText = [
      'all: revert',
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,0.65)',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))',
      'backdrop-filter:blur(2px)',
      '-webkit-backdrop-filter:blur(2px)'
    ].join(';');

    var inner = document.createElement('div');
    inner.style.cssText = [
      'position:relative',
      'width:min(820px,100%)',
      'height:min(900px,90vh)',
      'background:#0c0a09',
      'border-radius:14px',
      'overflow:hidden',
      'box-shadow:0 24px 60px rgba(0,0,0,.5)'
    ].join(';');

    iframe = document.createElement('iframe');
    iframe.src = origin + '/quote?embed=1&shop=' + encodeURIComponent(shop);
    iframe.title = 'Get a card quote';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0c0a09';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×'; // ×
    closeBtn.style.cssText = [
      'all: revert',
      'position:absolute',
      'top:8px',
      'right:8px',
      'width:36px',
      'height:36px',
      'border-radius:50%',
      'border:0',
      'background:rgba(0,0,0,.5)',
      'color:#fff',
      'font-size:22px',
      'line-height:1',
      'cursor:pointer',
      'z-index:2',
      'display:grid',
      'place-items:center'
    ].join(';');
    closeBtn.addEventListener('click', closeModal);

    inner.appendChild(iframe);
    inner.appendChild(closeBtn);
    modal.appendChild(inner);

    // Click-outside-to-close — but only on the backdrop, not on inner.
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });

    // Escape key closes too.
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(modal);
    document.documentElement.style.overflow = 'hidden';
  }

  function closeModal() {
    if (modal) modal.style.display = 'none';
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') closeModal();
  }

  btn.addEventListener('click', openModal);

  // 4. postMessage protocol from the embedded /quote iframe.
  //    Strict origin check — only accept messages from our own origin so
  //    a malicious parent or sibling can't fake a submission.
  window.addEventListener('message', function (e) {
    if (e.origin !== origin) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'cp:close') closeModal();
    if (d.type === 'cp:submitted' && typeof window.cardPricerWidgetOnSubmit === 'function') {
      try { window.cardPricerWidgetOnSubmit(d); } catch (_) {}
    }
  });
})();
