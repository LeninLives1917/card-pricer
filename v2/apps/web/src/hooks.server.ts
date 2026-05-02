// Auth gate. Reads the Supabase JWT from the Authorization header on /api/*
// requests and from a session cookie on browser pages (week 7 lays the
// cookie path; until then cookies stay empty for vendor + customer routes).
//
// Populates `event.locals.user` so downstream handlers can read the
// authenticated user without re-verifying. Routes decide for themselves
// whether to require user presence.

import type { Handle } from '@sveltejs/kit';
import { verifyJwt } from '$lib/server/supabase.js';

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;

  // Bearer token (vendor app + future mobile app).
  const authHeader = event.request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const user = await verifyJwt(token);
      if (user) event.locals.user = user;
    } catch (e) {
      console.warn('[AUTH] verifyJwt failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // Session cookie path lands in week 7 with the customer-account magic-link
  // flow. Vendor app currently only authenticates via the bearer header
  // injected by the Supabase JS SDK on the client.

  return resolve(event);
};
