// Typed fetch wrappers — the contract between the SvelteKit web app
// and the SvelteKit `+server.ts` endpoints. Web app and (eventually)
// mobile both consume from here; types stay in sync because both sides
// ship from the same source.
//
// Skeleton — populated as endpoints land in weeks 2-7.

export const apiBase = (origin: string) => origin.replace(/\/$/, '');

export interface ApiHealth {
  status: 'ok';
  version: string;
  ts: number;
  uptime: number;
}

/**
 * Fetch the v2 health endpoint. Used by the deploy-watch tooling to
 * detect when a fresh build has gone live (uptime < 60s = new dyno).
 */
export async function getHealth(origin: string): Promise<ApiHealth> {
  const r = await fetch(`${apiBase(origin)}/api/health`);
  if (!r.ok) throw new Error(`health check failed: HTTP ${r.status}`);
  return (await r.json()) as ApiHealth;
}
