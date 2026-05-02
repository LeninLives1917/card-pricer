// Shared in-memory state for the bulk-refresh job. Lives outside +server.ts
// because SvelteKit forbids custom exports from those.
//
// Single instance assumption: this is fine on a single Render dyno (which
// is our deploy target). If we ever scale horizontally, move state into
// Postgres or Upstash Redis.

export interface RefreshState {
  loading: boolean;
  cardsTotal: number;
  cardsPriced: number;
  startedAt: number | null;
  completedAt: number | null;
  pagesFailed: number[];
  error: string | null;
}

export const refreshState: RefreshState = {
  loading: false,
  cardsTotal: 0,
  cardsPriced: 0,
  startedAt: null,
  completedAt: null,
  pagesFailed: [],
  error: null,
};
