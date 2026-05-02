# Card-Pricer — Design Brief

## Direction (one sentence)

An auction house's back office: Monocle-warm editorial display for card names and brand moments; Bloomberg-precise tabular figures for prices and movement. Density that respects an operator scanning at one card every eight seconds; typography that respects a collector deciding what to part with.

## Typography pairing

| Use | Family | Weights |
|---|---|---|
| Display — card names, page titles, hero moments | **Fraunces** | 500, 600, 600-italic |
| UI — everything else | **IBM Plex Sans** | 400, 500, 600 |
| Figures — prices, ratios, percentages, set codes, IDs | **IBM Plex Mono** | 400, 500 |

Body default is Plex Sans 400. `.display` opts into Fraunces 600 italic. `.figure` opts into Plex Mono with `font-variant-numeric: tabular-nums`. Card names always render through `.display`.

## Colour tokens

```css
:root {
  /* surfaces — warm dark */
  --ink-100: #0c0a09;
  --ink-200: #1c1917;
  --ink-300: #292524;
  --ink-400: #44403c;
  --ink-500: #57534e;
  --hairline: rgba(120,113,108,0.18);

  /* type */
  --paper-100: #fafaf9;
  --paper-200: #d6d3d1;
  --paper-300: #a8a29e;
  --paper-400: #78716c;

  /* brand */
  --accent: #d97706;
  --accent-soft: #fbbf24;
  --accent-mute: rgba(217,119,6,0.12);

  /* semantic — finance convention */
  --up: #16a34a;
  --down: #dc2626;
  --up-soft: rgba(22,163,74,0.14);
  --down-soft: rgba(220,38,38,0.14);

  /* premium signal */
  --rare: #eab308;
  --rare-soft: rgba(234,179,8,0.14);

  /* radius — three values, picked deliberately */
  --r-1: 6px;   /* badges, small buttons */
  --r-2: 8px;   /* cards, primary buttons */
  --r-3: 12px;  /* modals, sheet */

  /* motion */
  --ease: cubic-bezier(.2,0,0,1);
  --t-fast: 120ms;
  --t-mid: 180ms;
}
```

Both pages consume the same tokens. AMOLED variant retained as a deeper ink set.

## Motion budget

- Default transition: 120ms `--ease`.
- Result-sheet enter: 180ms slide-up + fade.
- Skeleton shimmer: 1.4s, hairline-toned.
- One signature moment (below).
- Banned: infinite chrome pulses, spring overshoot, transform-scale over 0.96, opacity loops.
- Functional pulses kept: `.pulse-dot`, `.spinner`, `.capture-btn.loading::before`.

## Signature moment

Card name in the result-sheet renders in Fraunces 600 italic 28px with a 1px amber hairline animated in beneath it left-to-right over 180ms. The single editorial flourish in the entire vendor app. Reduced-motion shows the hairline statically.

## Banned defaults (slop list)

- Inter / Roboto / system-ui as primary
- Purple, cyan, teal accents
- Linear gradients on buttons
- `rounded-2xl` style — only `--r-1/2/3` allowed
- Emoji as iconography
- Glassmorphism / backdrop-filter outside scrim modals
- Spring or bouncy easing curves
- Spinners on list-load (skeletons only)
- Bare percentages without an anchor
- `#ffffff` on `#000000`

## Component rules

**Tables.** 1px hairline between rows, no zebra. Header Plex Sans 500 11px uppercase 0.06em letter-spacing. Body cells Plex Sans 13px. Numeric columns Plex Mono with tabular-nums and right-align. Sticky header on scroll. 32px row height. Mobile: collapse to card-list under 640px.

**Buttons.** Solid `--accent` (primary), `--ink-300` (secondary), `--ink-200` ghost. No gradients. `--r-2` radius. 13px Plex Sans 600. `:hover` lifts one ink step. `:focus-visible` shows 2px `--accent` outline + 1px offset. Active state: same surface, 0.96 scale max.

**Cards.** `--ink-200` surface, 1px `--hairline` border, `--r-2` radius. No shadow at rest.

**Inputs.** `--ink-300` surface, 1px `--hairline`, 13px Plex Sans. Focus border becomes `--accent`. Numeric inputs use Plex Mono.

**Charts (when added).** Hairline grid, single accent line, no gradient fills, mono tooltip, semantic colour for movement.

**Skeletons.** v66 primitive, retuned to hairline tones. Always honours `prefers-reduced-motion`.

**Empty states.** Editorial copy in Fraunces 500 18px + Plex Sans 12px subtitle + Plex Sans 13px CTA. Icon optional, hairline-stroke only.

**Badges.** Two registers:
- *Data-badge* — Plex Mono 11px, `--ink-300`, `--r-1` radius. For variants/conditions/percentages.
- *Status-badge* — Plex Sans 11px uppercase 0.06em, semantic-coloured fill (`--up-soft`, `--down-soft`, `--rare-soft`). For LIVE / GRADED / RARE / SOLD.

**Tabs.** 13px Plex Sans 500. Active: 2px `--accent` underline + `--paper-100` text. Inactive: `--paper-300`.

**Density.** Padding tokens: 4 / 8 / 12 / 16 / 24. Drops 32 entirely. Default card padding 12. Default row height in tables 32. Capture-btn 64×64 (down from 72).

## What lives where

- **Vendor app (`/`)** — terminal mode. Heavy density, tabular figures, hairline tables.
- **Quote page (`/quote`)** — editorial mode. Larger type, more whitespace, Fraunces display gets more room. Same tokens, different rhythm.
- **Embed widget (`/widget.js` modal)** — quote page rules apply (it's an iframe of `/quote`).
