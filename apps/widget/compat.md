# Widget V1 → V2 compatibility contract

_Owner: A6. Slice: S9. Status: shipped (V2 file written; orchestrator owns the cutover commit that flips `/widget.js` to serve `apps/widget/widget.js`)._

This document records the exact V1 surface the V2 widget must preserve, plus the additive V2-NEW attributes. The non-negotiable is operator decision Q4 in `docs/V2_ARCHITECTURE.md`: V2 ships **in place at `/widget.js`**, V1 is preserved as `widget-v1.js` for rollback, and a script tag with **zero V2-only attributes** must produce DOM **indistinguishable from V1**.

If you change anything in this document, the parity test in `tests/regression/widget-parity.spec.js` will need a corresponding update.

---

## V1 attributes (must be supported with V1 semantics)

| Attribute | Default | Behaviour |
|---|---|---|
| `data-shop` | _(required)_ | Shop slug. If missing, the widget logs a warning and bails (V1 + V2 identical). |
| `data-color` | `#b45309` | Button background colour. Text colour is always `#fff` (V1 hardcodes white; V2 keeps it for parity — we cannot guess if a custom colour pairs with white or black text). |
| `data-label` | `Get a quote on your cards` | Button text. |
| `data-position` | `inline` | `inline` places the button before the script tag. `floating` anchors the button bottom-right with `position:fixed`, `right:20px`, `bottom:20px`, `z-index:2147483646`. |

## V2-NEW attributes (additive — defaults match V1 byte-for-byte)

| Attribute | Default (= V1) | Values | Behaviour |
|---|---|---|---|
| `data-theme` | `dark` | `dark` \| `light` \| `auto` | Modal chrome theme. `dark` = V1 (`bg #0c0a09`, `text #fff`). `light` flips to `bg #fafaf9, text #0c0a09`. `auto` resolves once at script eval via `prefers-color-scheme` (no live media-query listener, so an OS theme change mid-session is not picked up — refresh required). |
| `data-button-shape` | `square` | `square` \| `pill` \| `round` | Button corner radius. `square` = `10px` (V1). `pill` = `999px`. `round` = `50%` and the button becomes a 64×64 circle with smaller text. |
| `data-modal-size` | `default` | `default` \| `compact` \| `full` | Modal dimensions. `default` = `min(820px,100%) × min(900px,90vh)` (V1). `compact` = `min(560px,100%) × min(720px,85vh)`. `full` = `min(1200px,100%) × min(1100px,95vh)`. |
| `data-event-callback` | _(empty)_ | global function name | Alternative to `window.cardPricerWidgetOnSubmit`. Called with the `cp:submitted` payload **in addition to** the V1 callback if both are defined. |
| `data-locale` | `en` | `en` \| `de` \| `fr` | Forwarded to `/quote?locale=…` if non-default. Only `en` is shipped today; the attribute is parsed so older widget code does not break when locales land. |
| `data-lazy` | `false` | `true` \| `false` | When `true`, defers iframe injection until first click. V1 was already click-lazy, so this is a no-op vs V1 today, but exists for symmetry with sites that want the docs-stated behaviour and for future tightening. |

## DOM diff (V1 vs V2 with V1-only attributes)

Target: zero diff. Specifically:

- Button: `class="cp-widget-btn"`, identical `style.cssText` (modulo position-attached overrides for `floating`).
- Modal backdrop: `class="cp-widget-modal"`, identical `style.cssText`.
- Modal inner: identical `style.cssText` (V1's exact `min(820px,100%)` / `min(900px,90vh)` / `#0c0a09`).
- Iframe: identical `src`, `title`, `allow`, `style.cssText`.
- Close button: identical position, sizing, colours, `aria-label`, `×` glyph.
- `documentElement.style.overflow` toggled to `hidden` on open and `''` on close (V1 uses empty-string restore — V2 preserves).

The V2 file emits `?theme=` and `?locale=` query params on the iframe URL **only when non-default**, so the V1-parity URL is byte-identical to V1's: `?embed=1&shop=<slug>` with nothing else.

## postMessage protocol contract

The widget listens for `message` events on `window` and:

1. **Hard-rejects** any message whose `event.origin !== widget origin`. The widget origin is the origin of the `<script src=…>` URL.
2. Ignores any message whose `data` is not a non-null object.
3. On `{ type: 'cp:close' }` → closes the modal (display:none, restores overflow, removes the keydown listener).
4. On `{ type: 'cp:submitted', shop?, ...rest }`:
   - Calls `window.cardPricerWidgetOnSubmit(d)` if defined (V1 contract — preserved verbatim).
   - Calls `window[<data-event-callback>](d)` if `data-event-callback` was set (V2-NEW).
   - Each callback is `try`/`catch`-wrapped so a buggy host callback cannot break the other.

## Telemetry beacon (V2-NEW)

On init (immediately after the button mounts), the V2 widget fires **exactly one** request to:

```
POST <origin>/api/widget/loaded
Content-Type: application/json
{ "shop": "<slug>", "version": "v2", "theme": "<resolved>", "position": "<inline|floating>" }
```

Transport: `navigator.sendBeacon` preferred, `fetch({ keepalive: true })` fallback. Both are fire-and-forget; a 404 (V1 server, route not yet landed) is silently swallowed. The route lands in S14 (A8). RG-43 guards this contract.

V1 never sent this beacon. Hosts running V1 servers will see a single 404 on each page load that hosts V2 — operationally invisible.

## Rollback procedure

Per Q6 release runbook §9 in `docs/V2_ARCHITECTURE.md`:

1. `cp apps/widget/widget-v1.js public/widget.js`
2. Commit + deploy.
3. The `/widget.js` route in `apps/server/routes/static.js` continues to serve from `public/widget.js`; the route does not change.
4. Within 60s (matching the reduced widget cache TTL set in the pre-cutover step) all clients pull V1 again.

`apps/widget/widget-v1.js` carries a `ROLLBACK TARGET — DO NOT MODIFY` header. Any change there should fail review.

## What V2 adds (changelog at a glance)

- Theme tokens (light / dark / auto) — modal chrome only; button stays brand-coloured.
- Button shapes (square / pill / round).
- Modal sizes (default / compact / full).
- Optional `data-event-callback` alongside the V1 `window.cardPricerWidgetOnSubmit`.
- `data-locale` parsed and forwarded to the iframe (en only for now).
- `data-lazy` attribute (no-op today; documented for future use).
- Telemetry beacon on init (`POST /api/widget/loaded`).
- All inline-style + `all: revert` defences from V1 retained verbatim.
- No new globals beyond those the host page chooses to define.

## Open questions / hand-offs

- **S14 (A8)** — needs to add `POST /api/widget/loaded` to `apps/server/routes/health.js`. Until then, V2 hosts log a single 404 per page; expected and silent.
- **S23 (A6 + A7)** — full DOM-diff snapshot test using a headless DOM. The `tests/regression/widget-parity.spec.js` written here is a static structural check only; a runtime DOM diff requires a `jsdom`-style devDep we have not yet added.
- **S26 (smoke)** — first deploy of V2 should verify the cutover by loading the live `/widget.js` and confirming the IIFE comment header now starts with `Card Pricer embed widget loader — V2.`.
- **Cutover** — `/widget.js` route in `apps/server/routes/static.js` MUST switch from `public/widget.js` to `apps/widget/widget.js` in the cutover commit. Flag for orchestrator.
