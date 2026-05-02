// POST /api/identify — multipart/form-data with `image` field. Returns
// parsed + verified card payload. Auth-required.

import { json, error } from '@sveltejs/kit';
import { verifyPokemon, type IdCard } from '@card-pricer/shared';
import { identifyCore } from '$lib/server/identify-core.js';
import { getSupabase } from '$lib/server/supabase.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'auth required');

  const form = await request.formData().catch(() => null);
  if (!form) throw error(400, 'multipart/form-data expected');
  const file = form.get('image');
  if (!(file instanceof File)) throw error(400, 'missing image field');
  const hint = String(form.get('hint') ?? '');

  const buffer = Buffer.from(await file.arrayBuffer());
  const out = await identifyCore(buffer, hint);

  // Quota log — fire-and-forget. Mirrors v1's logScanEvent.
  void (async () => {
    try {
      const sb = getSupabase();
      await sb.from('scan_events').insert({ user_id: locals.user!.id, endpoint: '/api/identify' });
    } catch {
      /* non-blocking */
    }
  })();

  // Verify each card against pokemontcg.io (Pokemon only — Magic + others
  // port in week 4 alongside the full pricing pipeline).
  const cards = (out.parsed.cards ?? []) as IdCard[];
  const verified = await Promise.all(
    cards.map(async (c) => {
      try {
        const v = await verifyPokemon(c);
        if (v) {
          // Strip the in-flight ref-image promise before serialising.
          const { _refImagePromise, ...serializable } = v;
          void _refImagePromise;
          return { ...c, ...serializable, verified: true };
        }
      } catch (e) {
        console.warn('[VERIFY]', e instanceof Error ? e.message : String(e));
      }
      return { ...c, verified: false };
    }),
  );

  return json({ cards: verified });
};
