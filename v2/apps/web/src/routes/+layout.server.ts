// Server-side layout load — exposes the authenticated user (if any)
// to every page so the layout can switch between auth gate and tabs.
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
  return {
    user: locals.user,
    pathname: url.pathname,
  };
};
