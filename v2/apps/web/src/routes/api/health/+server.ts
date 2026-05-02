import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Health check + basic uptime. Used by the deploy-watch tooling
 * (replaces v1's curl /api/health pattern). Stays unauthenticated.
 */
export const GET: RequestHandler = () => {
  return json({
    status: 'ok',
    version: '2.0.0-dev',
    ts: Date.now(),
    uptime: process.uptime(),
  });
};
