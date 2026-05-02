// Design tokens — TypeScript-accessible mirror of tokens.css.
// Used by Svelte components that need a token's value at runtime
// (e.g. inline SVG fills) without parsing CSS variables.
//
// Source of truth: ../../../DESIGN_BRIEF.md.

export const ink = {
  100: '#0c0a09',
  200: '#1c1917',
  300: '#292524',
  400: '#44403c',
  500: '#57534e',
} as const;

export const paper = {
  100: '#fafaf9',
  200: '#d6d3d1',
  300: '#a8a29e',
  400: '#78716c',
} as const;

export const accent = {
  base: '#d97706',
  soft: '#fbbf24',
  mute: 'rgba(217,119,6,0.12)',
} as const;

export const semantic = {
  up: '#16a34a',
  upSoft: 'rgba(22,163,74,0.14)',
  down: '#dc2626',
  downSoft: 'rgba(220,38,38,0.14)',
  rare: '#eab308',
  rareSoft: 'rgba(234,179,8,0.14)',
} as const;

export const radius = { 1: '6px', 2: '8px', 3: '12px' } as const;

export const motion = {
  ease: 'cubic-bezier(.2,0,0,1)',
  fast: '120ms',
  mid: '180ms',
} as const;

/** Hairline border colour — used as 1px borders everywhere. */
export const hairline = 'rgba(120,113,108,0.18)';
