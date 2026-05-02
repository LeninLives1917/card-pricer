# Card-Pricer — Editorial-Terminal Implementation Plan

Five phases. Each ends with a verification step. If a phase introduces a regression, work stops at the end of that phase.

## Phase A — Foundations

**Goal:** Get the new tokens and fonts into both pages with zero visual regression on layout.

**Files to touch**
- `public/index.html` — `<head>`, `:root`, `body.amoled`
- `public/quote.html` — `<head>`, `:root`

**Changes**
1. Add to `<head>` of both pages:
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Fraunces:ital,opsz,wght@1,9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
   ```
2. Replace `index.html:944-963` `:root` block with the new tokens (see DESIGN_BRIEF.md).
3. Add **compatibility aliases** in the same block so old class references keep working through Phase A:
   ```css
   --bg: var(--ink-100); --surface: var(--ink-200); --surface2: var(--ink-300);
   --border: var(--hairline); --text: var(--paper-100); --text-dim: var(--paper-300);
   --accent-light: var(--accent-soft);
   --green: var(--up); --red: var(--down); --orange: var(--accent);
   --yellow: var(--rare);
   --radius: var(--r-2); --radius-lg: var(--r-3);
   --grad-accent: var(--accent);
   ```
4. Replace `quote.html:16-31` `:root` block with the same tokens.
5. Add three utility classes globally:
   ```css
   .display { font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-style: italic; letter-spacing: -0.01em; }
   .figure  { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
   .label   { font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--paper-300); }
   ```
6. Set `body { font-family: 'IBM Plex Sans', system-ui, sans-serif; }` on both pages.

**Verification**
- Both pages render with no FOUT spike (preconnect + `display=swap`).
- Existing classes still resolve via aliases — every tab opens, no broken layout.
- `node --check server.js` passes; both HTML inline-script blocks parse.
- DevTools: `getComputedStyle(document.body).fontFamily` starts with `IBM Plex Sans`. `getComputedStyle(document.documentElement).getPropertyValue('--ink-100')` is `#0c0a09`.

## Phase B — Component primitives

**Goal:** Rebuild primitive CSS classes against new tokens. Phase A aliases become unused at end of phase.

**Order**
1. Buttons — `.btn`, `.btn.primary`, `.btn.secondary`, `.header-btn`, `.auth-submit`, `.plan-choose`, `.upload-btn`, `.flip-btn`, `.retake-btn`, `.onboarding-btn`. Drop gradients. `--r-2` radius. `:focus-visible` outline.
2. Tabs — `.tabs`, `.tab`, `.tab.active`. 13px Plex Sans 500. 2px `--accent` underline.
3. Cards — `.result-card`, `.plan-card`, `.auth-card`, `.onboarding-card`, `.bulk-tile`. `--ink-200` + hairline + `--r-2`.
4. Inputs — global, `.setting-number`, `.lead-form input`, `.field input`, `.search-input`. `:focus` accent border.
5. Badges — `.confidence-badge`, `.condition-badge`, `.want-badge`, `.session-count`, plan-tier badges. Two registers (data-badge / status-badge).
6. Tables — admin user table, arbitrage row template (`arbRowHtml`). Hairline rows, `.figure` numerics, sticky header.
7. Skeleton — recolour to hairline tones.
8. Empty states — Fraunces title + Plex Sans body + amber CTA.
9. Modals — `.auth-overlay`, `.manual-modal`, `.plan-overlay`, `.quotaModal`, `.result-sheet`, `.live-detect-banner`. `--r-3` on sheet.
10. Capture button — 72→64; remove inset highlight gradient; keep functional pulses.

**Verification**
- Every tab visited, no broken styling.
- `grep -E 'var\(--(bg|surface|text-dim|accent-light|green|red|radius|grad-accent)\)' public/index.html` returns empty.
- All buttons receive `--accent` focus outline on Tab navigation.
- Arbitrage row template uses `.figure` for numerics.

## Phase C — Pages

**Goal:** Editorial layer applied page-by-page, most-used first.

**Order**
1. Scan tab — onboarding card title `.display`, mode toggle refresh, bulk drop hairline, camera placeholder hairline icon.
2. Result-sheet — card name `.display` 28px italic + amber hairline reveal (signature moment), set/number `.figure`, market value Plex Mono 22px, condition-adjusted Plex Mono 14px, graded banner status-badge.
3. Session log — slider hairline tracks + amber thumb, log row `.display` name + `.figure` prices, totals `.figure` 18px.
4. Settings — usage bar semantic colour, embed panel form polish, snippet textarea Plex Mono, pair-phone QR hairline frame.
5. Admin — stats grid Plex Mono 26px, plan-tier semantic mapping, user table real `<table>` styling, **arbitrage finder full pass** (form density, ratio cell direction colour, mono numerics).
6. Quote page — H1 Fraunces 32px italic, how-to steps Plex Sans 13px + set codes `.figure`, results `.display` + `.figure`, gate title `.display`, footer Plex Sans 12px.

**Verification**
- Card name in result-sheet renders Fraunces italic on desktop and at 390×844.
- Arbitrage table has tabular numerals; columns align row-to-row.
- `/quote?shop=brewed` reads as a customer surface.

## Phase D — Signature moment + semantic price colour

**Files:** `public/index.html` (sheet renderer + arbitrage template + `<style>`).

**Changes**
1. Card-name hairline reveal — `::after` pseudo-element + `@keyframes hairlineReveal` (transform-origin:left, scaleX 0→1, 180ms).
2. `prefers-reduced-motion: reduce` shows the hairline statically.
3. Arbitrage ratio cell — `--up-soft` background pill + mono number in `--up`. Semantic green stays semantic green regardless of direction.
4. 30-day-trend microcopy — `↑ vs 30d` / `↓ vs 30d` Plex Sans 10px under EUR price when `cardmarket.prices.avg30` exists. (Surface `avg30` from `arbitrageVariants` in `server.js` if not already in payload.)
5. Price-pulse — 600ms colour fade from `--up`/`--down` back to `--paper-100` on live price changes via class toggle.

**Verification**
- Capturing a card → result-sheet opens with Fraunces italic name + animated hairline. Reduced-motion → hairline static.
- Arbitrage scan → ratio cells show `--up`-toned pills.
- Top results show ↑/↓ vs 30d microcopy where the data exists.

## Phase E — Polish

**Files:** `public/index.html`, `public/quote.html`, `public/widget.js`.

**Changes**
1. Drop Phase A compatibility aliases (`--bg`, `--text`, `--green`, `--red`, etc.).
2. Global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`. Audit all interactive controls.
3. Contrast pass — axe DevTools, all text WCAG AA.
4. `prefers-reduced-motion` verification — `cardEnter`, `slideUpIn`, `bannerSlide`, `flashPulse`, `hairlineReveal`, skeleton shimmer.
5. Mobile reflow — arbitrage table → card-list under 640px; settings → one column under 540px.
6. Favicon for `index.html` — inline SVG data-URI matching manifest icon.
7. AMOLED toggle — expose in Settings or remove dead `body.amoled` block.
8. Hardcoded hex sweep — `grep -nE '#[0-9a-fA-F]{6}|rgba\(' public/index.html` → token references.
9. Strip `quote.html`'s `--bg-deep`, `--cash`, `--credit`, `--cream` if redundant.
10. Confirm `manifest.json` `theme_color` and `background_color` already at `--ink-200` (`#1c1917`).

**Verification**
- axe: 0 critical issues, all pairs pass AA.
- Keyboard tab through every page — all focused elements visible.
- 390×844 viewport — every page usable, no horizontal scrollbars.
- `grep '#6c5ce7\|#a29bfe\|--bg\|--text-dim' public/` returns nothing.
- Lighthouse `/` and `/quote`: a11y 95+, best practices 95+.

---

## Critical files

- `public/index.html` — main vendor app
- `public/quote.html` — customer quote
- `public/widget.js` — embed loader
- `public/manifest.json` — already at v66 state
- `server.js` — minor touches (Phase D price-pulse hook, optional `avg30` surfacing)
- `DESIGN_BRIEF.md` — single source of truth for tokens and rules
- `IMPLEMENTATION_PLAN.md` — this file

## Functions / utilities to reuse

- `escapeHtmlArb` (`public/index.html`) — arbitrage row safety.
- v66 `.skeleton` / `.skeleton-row` primitive.
- v66 `prefers-reduced-motion` guard pattern.
- v66 inline-SVG icon approach.
- `arbitrageVariants` (`server.js`) — already exposes `cmAvg7`; surface `avg30` for Phase D.

## Phase order rationale

A → B → C → D → E. A is mechanical and instantly visible. B replaces visual primitives with no new content. C is the slow editorial walk where most of the perceived quality lives. D adds personality. E is the gate to "ship-ready". Each phase ends with a regression check; if a phase regresses, work stops.

## Success criterion

A pricing-tool screenshot that, shown to a fresh outsider, reads as **"a serious tool for someone who handles cards for a living"** rather than **"a generic AI app with an amber repaint"**. Vendor app feels like a terminal; quote page feels like a magazine; both unmistakably the same product. Tabular figures everywhere prices live; editorial italic on every card name; calm amber that's not yelling for attention.
