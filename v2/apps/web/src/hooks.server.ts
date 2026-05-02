import type { Handle } from '@sveltejs/kit';

/**
 * Auth gate. Reads the Supabase JWT from the Authorization header (vendor app)
 * or from a session cookie (customer accounts, week 7), populates event.locals.user.
 *
 * Skeleton — full implementation lands in week 2.
 */
export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  return resolve(event);
};
