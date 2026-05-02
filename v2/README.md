# Card Pricer v2 — SvelteKit + Expo + Drizzle

Greenfield rebuild. See `../V2_PLAN.md` (one level up at the repo root) for the canonical 8-week plan, decision rationale, week-by-week phasing, and verification criteria.

## Why this lives in `v2/`

v1 keeps running at `card-pricer-60qq.onrender.com` while v2 builds in parallel. Render auto-deploys from the repo root, so the root `package.json` + `server.js` + `public/` continue to serve the live product. v2 is a separate pnpm workspace with its own Render service. Cutover happens by DNS swap at end of Week 8.

## Repo structure

```
v2/
├── apps/
│   ├── web/         SvelteKit — vendor app + admin + /quote
│   ├── mobile/      Expo (React Native) — phone scanner (week 7)
│   └── widget/      Vite IIFE bundle → /widget.js (URL-stable for embed customers)
├── packages/
│   ├── shared/      Pure TS: identify pipeline, arbitrage logic, Zod schemas
│   ├── db/          Drizzle schema + migrations
│   ├── api-client/  Typed fetch wrappers — used by both web + mobile
│   └── design/      CSS tokens + shared Svelte primitives
└── infra/           render.yaml + eas.json
```

## Setup

```bash
cd v2
pnpm install
pnpm dev          # all apps in parallel
pnpm typecheck    # all packages
pnpm test         # Vitest unit + Playwright e2e
pnpm build        # full production build
```

## Status

- [x] **Week 1** — Foundations: monorepo, CI, design tokens, first port (`arbitrageVariants`).
- [ ] Week 2 — `/quote` + widget + lead capture port.
- [ ] Week 3 — Vendor app (scan / log / settings).
- [ ] Week 4 — Admin + arbitrage + price-snapshot to Postgres.
- [ ] Week 5 — Inventory.
- [ ] Week 6 — Multi-operator real-time via Supabase Realtime.
- [ ] Week 7 — Mobile app (Expo).
- [ ] Week 8 — Cutover + iOS submission + Android closed-testing.
