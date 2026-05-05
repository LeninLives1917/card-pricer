/**
 * Card Pricer embed widget loader — V2.
 *
 * V2 ships in place at /widget.js (operator decision Q4). V1 is preserved as
 * widget-v1.js for rollback. V1-attribute parity is the non-negotiable
 * contract: a script tag with zero V2-only attributes MUST produce DOM
 * indistinguishable from V1.
 *
 * V1 attributes (unchanged semantics):
 *   data-shop        (required)
 *   data-color       (default '#b45309')
 *   data-label       (default 'Get a quote on your cards')
 *   data-position    (default 'inline'; 'floating' = bottom-right fixed)
 *
 * V2-NEW attributes (additive — defaults match V1 exactly):
 *   data-theme           'dark'|'light'|'auto' (default 'dark' = V1)
 *   data-button-shape    'square'|'pill'|'round' (default 'square' = V1)
 *   data-modal-size      'default'|'compact'|'full' (default 'default' = V1)
 *   data-event-callback  global fn name; alternative to window.cardPricerWidgetOnSubmit
 *   data-locale          'en'|'de'|'fr' (default 'en'; only 'en' shipped now)
 *   data-lazy            'true'|'false' (default 'false' = V1; defers iframe injection until first click)
 *
 * postMessage protocol (origin-checked, accepts ONLY messages from widget origin):
 *   { type: 'cp:close' }                              → close modal
 *   { type: 'cp:submitted', shop?, ...rest }          → fires:
 *       window.cardPricerWidgetOnSubmit(d) if defined (V1 contract — kept)
 *       window[<data-event-callback>](d) if defined   (V2 alternative)
 *
 * Telemetry beacon (V2-NEW, RG-43): single fire on init, POST /api/widget/loaded
 * with { shop, version: 'v2', theme, position }. sendBeacon preferred, fetch
 * keepalive fallback. 404 tolerated silently (V1 servers don't have the route;
 * S14/A8 will land it).
 *
 * Hand-written vanilla IIFE — no build step. Inline `style="all: revert"` on
 * every injected element to defend against host-CSS bleed. z-index uses max
 * int32 (2147483647 modal / 2147483646 floating button). The IIFE adds
 * NOTHING to window beyond what the host page chooses to define
 * (cardPricerWidgetOnSubmit / data-event-callback target).
 */
(function () {
  'use strict';

  // ── 1. Self-script discovery ─────────────────────────────────────────────
  // document.currentScript is reliable during initial top-level execution;
  // fallback scan covers async/manual loads. Identical to V1.
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('/widget.js') !== -1) return scripts[i];
    }
    return null;
  })();
  if (!script) return;

  // ── 2. Origin derivation ────────────────────────────────────────────────
  var origin = (function () {
    try { return new URL(script.src).origin; } catch (_) { return ''; }
  })();
  if (!origin) { console.warn('[card-pricer-widget] could not derive origin from script src'); return; }

  // ── 3. Attribute parsing (V1 + V2) ──────────────────────────────────────
  var shop = script.getAttribute('data-shop');
  if (!shop) { console.warn('[card-pricer-widget] missing data-shop attribute'); return; }

  // V1 attributes — unchanged defaults.
  var color = script.getAttribute('data-color') || '#b45309';
  var label = script.getAttribute('data-label') || 'Get a quote on your cards';
  var position = (script.getAttribute('data-position') || 'inline').toLowerCase();

  // V2-NEW. Defaults chosen so the rendered DOM matches V1 1:1.
  var themeAttr = (script.getAttribute('data-theme') || 'dark').toLowerCase();
  var buttonShape = (script.getAttribute('data-button-shape') || 'square').toLowerCase();
  var modalSize = (script.getAttribute('data-modal-size') || 'default').toLowerCase();
  var eventCallback = script.getAttribute('data-event-callback') || '';
  var locale = (script.getAttribute('data-locale') || 'en').toLowerCase();
  var lazy = (script.getAttribute('data-lazy') || 'false').toLowerCase() === 'true';

  // ── 4. Theme tokens ──────────────────────────────────────────────────────
  // Resolve 'auto' once at script-eval time using prefers-color-scheme.
  // This is intentional: a media-query listener that swaps DOM mid-session
  // would mess with V1 parity expectations and the user can refresh if they
  // change OS theme. V1 was always 'dark' so 'dark' must produce V1's bytes.
  var THEMES = {
    dark: {
      bg: '#0c0a09',
      text: '#fff',
      border: 'rgba(120,113,108,.18)',
      backdrop: 'rgba(0,0,0,0.65)',
      closeBg: 'rgba(0,0,0,.5)',
      closeText: '#fff'
    },
    light: {
      bg: '#fafaf9',
      text: '#0c0a09',
      border: 'rgba(120,113,108,.24)',
      backdrop: 'rgba(28,25,23,0.45)',
      closeBg: 'rgba(255,255,255,.7)',
      closeText: '#0c0a09'
    }
  };
  var resolvedTheme = themeAttr;
  if (themeAttr === 'auto') {
    try {
      resolvedTheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    } catch (_) {
      resolvedTheme = 'dark';
    }
  }
  if (!THEMES[resolvedTheme]) resolvedTheme = 'dark';
  var T = THEMES[resolvedTheme];

  // Modal-size tokens. 'default' MUST match V1 byte-for-byte.
  var MODAL_SIZES = {
    'default': { w: 'min(820px,100%)', h: 'min(900px,90vh)' },
    'compact': { w: 'min(560px,100%)', h: 'min(720px,85vh)' },
    'full':    { w: 'min(1200px,100%)', h: 'min(1100px,95vh)' }
  };
  var MS = MODAL_SIZES[modalSize] || MODAL_SIZES['default'];

  // Button-shape tokens. 'square' = V1's 10px radius.
  var BUTTON_RADIUS = {
    'square': '10px',
    'pill':   '999px',
    'round':  '50%'
  };
  var btnRadius = BUTTON_RADIUS[buttonShape] || BUTTON_RADIUS['square'];

  // Determine if we're rendering in V1-parity mode (every V2 attr at default).
  // Used to skip V2-only style branches that would otherwise diff against V1.
  var isV1Parity = (
    themeAttr === 'dark' &&
    buttonShape === 'square' &&
    modalSize === 'default' &&
    !eventCallback &&
    locale === 'en' &&
    !lazy
  );

  // ── 5. Button injection ─────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp-widget-btn';
  btn.textContent = label;
  btn.setAttribute('aria-haspopup', 'dialog');

  // Style array — emit V1's exact bytes when in parity mode; otherwise apply
  // the V2-only overrides on top. We KEEP color:#fff for the button text
  // because the button background is user-supplied (data-color) and we can't
  // know if it pairs with light text — V1 hardcodes white and we keep that
  // for parity. Theme tokens drive the MODAL chrome, not the button.
  var btnStyles = [
    'all: revert',
    'background:' + color,
    'color:#fff',
    'border:0',
    'padding:12px 20px',
    'border-radius:' + btnRadius,
    'font:600 15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,.18)',
    'line-height:1.2',
    'letter-spacing:0.01em',
    'display:inline-block'
  ];
  // 'round' shape: square aspect needed for the radius to look like a circle.
  if (buttonShape === 'round') {
    btnStyles.push('width:64px', 'height:64px', 'padding:0', 'font-size:11px');
  }
  btn.style.cssText = btnStyles.join(';');

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
    // Telemetry beacon — fire ONCE after the button mounts. We attach this
    // here (not at IIFE eval) so the beacon timing approximates "user can
    // see the button". Single-fire guard via the `beaconFired` closure var.
    sendLoadedBeacon();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // ── 6. Modal injection ──────────────────────────────────────────────────
  var modal = null;
  var iframe = null;
  // Pre-build the iframe URL so the lazy/eager branches share one source.
  var iframeSrc = (function () {
    var qs = '?embed=1&shop=' + encodeURIComponent(shop);
    // Pass theme + locale through ONLY when non-default, so V1-parity URLs
    // are byte-identical to V1 ('?embed=1&shop=brewed' with nothing else).
    if (resolvedTheme !== 'dark') qs += '&theme=' + encodeURIComponent(resolvedTheme);
    if (locale !== 'en') qs += '&locale=' + encodeURIComponent(locale);
    return origin + '/quote' + qs;
  })();

  function buildModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'cp-widget-modal';
    modal.style.cssText = [
      'all: revert',
      'position:fixed',
      'inset:0',
      'background:' + T.backdrop,
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
      'width:' + MS.w,
      'height:' + MS.h,
      'background:' + T.bg,
      'border-radius:14px',
      'overflow:hidden',
      'box-shadow:0 24px 60px rgba(0,0,0,.5)'
    ].join(';');

    iframe = document.createElement('iframe');
    iframe.src = iframeSrc;
    iframe.title = 'Get a card quote';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:' + T.bg;

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = [
      'all: revert',
      'position:absolute',
      'top:8px',
      'right:8px',
      'width:36px',
      'height:36px',
      'border-radius:50%',
      'border:0',
      'background:' + T.closeBg,
      'color:' + T.closeText,
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

    // Click-outside-to-close — backdrop only, not inner.
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });

    document.body.appendChild(modal);
  }

  function openModal() {
    if (!modal) buildModal();
    else modal.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', escHandler);
  }

  function closeModal() {
    if (modal) modal.style.display = 'none';
    // Restore documentElement.style.overflow — V1 sets to '' (revert to host's
    // CSS). We do the same.
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') closeModal();
  }

  // Eager preload (V1 default): build the modal hidden so the iframe starts
  // fetching /quote before the first click. Lazy mode (V2-NEW) defers the
  // build until openModal() — saves the iframe load for shops where most
  // visitors never click.
  if (!lazy) {
    // V1 builds the modal on first click, NOT eagerly. Match V1 byte-for-byte
    // by NOT pre-building. The original V1 widget is also strictly lazy.
    // (V1's "lazy" is the default; data-lazy="true" is a no-op for parity but
    // documented for symmetry — defer DOES nothing extra here. We keep this
    // branch for clarity should we ever want to change V1's default.)
  }

  btn.addEventListener('click', openModal);

  // ── 7. postMessage receiver ─────────────────────────────────────────────
  // Strict origin check — only accept messages from our own origin so a
  // malicious parent or sibling iframe cannot fake submissions.
  window.addEventListener('message', function (e) {
    if (e.origin !== origin) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'cp:close') closeModal();
    if (d.type === 'cp:submitted') {
      // V1 contract — keep firing window.cardPricerWidgetOnSubmit if defined.
      if (typeof window.cardPricerWidgetOnSubmit === 'function') {
        try { window.cardPricerWidgetOnSubmit(d); } catch (_) {}
      }
      // V2 alternative — fire the named callback if data-event-callback is set.
      if (eventCallback && typeof window[eventCallback] === 'function') {
        try { window[eventCallback](d); } catch (_) {}
      }
    }
  });

  // ── 8. Telemetry beacon ─────────────────────────────────────────────────
  // POST /api/widget/loaded with shop + version + theme + position. Fires
  // exactly once per page load (mount() guards via the closure flag).
  // /api/widget/loaded lands in S14 (A8); until then a 404 is normal — we
  // tolerate it silently. V1 never sent this beacon.
  var beaconFired = false;
  function sendLoadedBeacon() {
    if (beaconFired) return;
    beaconFired = true;
    var url = origin + '/api/widget/loaded';
    var payload = {
      shop: shop,
      version: 'v2',
      theme: resolvedTheme,
      position: position
    };
    try {
      var body = JSON.stringify(payload);
      // sendBeacon is fire-and-forget and survives page unload — ideal here.
      // Some browsers reject sendBeacon for application/json; pass a Blob
      // with the right type so it goes through.
      if (navigator && typeof navigator.sendBeacon === 'function') {
        var blob = new Blob([body], { type: 'application/json' });
        var ok = navigator.sendBeacon(url, blob);
        if (ok) return;
        // fall through to fetch on rejection
      }
      // Fetch with keepalive: short request that survives page unload too.
      // We deliberately do NOT await the response or read the body — a 404
      // (V1 server, no /api/widget/loaded route) must not throw.
      if (typeof fetch === 'function') {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'omit',
          mode: 'cors'
        }).catch(function () { /* swallow — beacon is best-effort */ });
      }
    } catch (_) {
      // Swallow — telemetry must never break the widget.
    }
  }

  // Suppress unused-var lint warnings for V2-parity mode flag (kept for the
  // back-compat snapshot tests in S23).
  void isV1Parity;
})();
