/**
 * Card Pricer embed widget loader. v2.0 port of public/widget.js.
 *
 * Customer shops drop this script tag into their site:
 *   <script src="https://<v2-domain>/widget.js"
 *           data-shop="brewed" data-color="#d97706"
 *           data-position="floating" defer></script>
 *
 * URL-stable with v1: existing snippets continue to work after cutover
 * because we serve at the same /widget.js path with the same data-attrs
 * (data-shop, data-color, data-label, data-position) and the same
 * postMessage protocol (cp:close, cp:submitted).
 *
 * No external dependencies — single self-contained IIFE.
 */
(() => {
  // Find OUR script tag.
  // document.currentScript can be HTMLOrSVGScriptElement; we only care about
  // the HTML one. The fallback scan is for the case where the loader is
  // injected dynamically (currentScript can be null then).
  const candidate = document.currentScript;
  const script: HTMLScriptElement | null =
    candidate instanceof HTMLScriptElement
      ? candidate
      : (() => {
          const scripts = document.getElementsByTagName('script');
          for (let i = scripts.length - 1; i >= 0; i--) {
            const s = scripts[i];
            if (s?.src && s.src.indexOf('/widget.js') !== -1) return s;
          }
          return null;
        })();
  if (!script) return;

  let origin = '';
  try {
    origin = new URL(script.src).origin;
  } catch {
    /* noop */
  }
  if (!origin) {
    console.warn('[card-pricer-widget] could not derive origin from script src');
    return;
  }

  const shop = script.getAttribute('data-shop');
  if (!shop) {
    console.warn('[card-pricer-widget] missing data-shop attribute');
    return;
  }

  const color = script.getAttribute('data-color') ?? '#d97706';
  const label = script.getAttribute('data-label') ?? 'Get a quote on your cards';
  const position = (script.getAttribute('data-position') ?? 'inline').toLowerCase();

  // Inject button. `all: revert` defends against host-CSS bleed.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp-widget-btn';
  btn.textContent = label;
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.style.cssText = [
    'all: revert',
    `background:${color}`,
    'color:#fff',
    'border:0',
    'padding:12px 20px',
    'border-radius:8px',
    "font:600 14px 'IBM Plex Sans',-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,.18)',
    'line-height:1.2',
    'letter-spacing:0.01em',
    'display:inline-block',
  ].join(';');

  const mount = () => {
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
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // Modal — created lazily on first click.
  let modal: HTMLDivElement | null = null;
  let iframe: HTMLIFrameElement | null = null;

  const closeModal = () => {
    if (modal) modal.style.display = 'none';
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', escHandler);
  };

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') closeModal();
  };

  const openModal = () => {
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
      'background:rgba(12,10,9,0.65)',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))',
    ].join(';');

    const inner = document.createElement('div');
    inner.style.cssText = [
      'position:relative',
      'width:min(820px,100%)',
      'height:min(900px,90vh)',
      'background:#0c0a09',
      'border-radius:12px',
      'overflow:hidden',
      'box-shadow:0 24px 60px rgba(0,0,0,.5)',
    ].join(';');

    iframe = document.createElement('iframe');
    iframe.src = `${origin}/quote?embed=1&shop=${encodeURIComponent(shop)}`;
    iframe.title = 'Get a card quote';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.cssText =
      'width:100%;height:100%;border:0;display:block;background:#0c0a09';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = [
      'all: revert',
      'position:absolute',
      'top:8px',
      'right:8px',
      'width:32px',
      'height:32px',
      'border-radius:50%',
      'border:0',
      'background:rgba(0,0,0,.55)',
      'color:#fff',
      'font-size:20px',
      'line-height:1',
      'cursor:pointer',
      'z-index:2',
      'display:grid',
      'place-items:center',
    ].join(';');
    closeBtn.addEventListener('click', closeModal);

    inner.appendChild(iframe);
    inner.appendChild(closeBtn);
    modal.appendChild(inner);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', escHandler);
    document.body.appendChild(modal);
    document.documentElement.style.overflow = 'hidden';
  };

  btn.addEventListener('click', openModal);

  // postMessage protocol from the embedded /quote iframe.
  // Strict origin check — only accept messages from our own origin.
  window.addEventListener('message', (e) => {
    if (e.origin !== origin) return;
    const d = e.data as { type?: string; shop?: string };
    if (!d || typeof d !== 'object') return;
    if (d.type === 'cp:close') closeModal();
    if (
      d.type === 'cp:submitted' &&
      typeof (window as unknown as { cardPricerWidgetOnSubmit?: (e: unknown) => void })
        .cardPricerWidgetOnSubmit === 'function'
    ) {
      try {
        (
          window as unknown as { cardPricerWidgetOnSubmit: (e: unknown) => void }
        ).cardPricerWidgetOnSubmit(d);
      } catch {
        /* noop */
      }
    }
  });
})();
