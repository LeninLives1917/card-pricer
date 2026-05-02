// POST /api/identify-stream — same as /api/identify but emits NDJSON events
// as it works:
//   {type:'ident', cards}     — raw Claude output (client can start pricing)
//   {type:'verified', cards}  — same cards after pokemontcg.io verify
//   {type:'error', error}
//   {type:'done'}
// Saves 500-1000ms perceived latency: client renders ident immediately
// while verify continues in the background.

import { error } from '@sveltejs/kit';
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

  void (async () => {
    try {
      const sb = getSupabase();
      await sb.from('scan_events').insert({ user_id: locals.user!.id, endpoint: '/api/identify-stream' });
    } catch {
      /* non-blocking */
    }
  })();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };

      try {
        const out = await identifyCore(buffer, hint);
        const initial = (out.parsed.cards ?? []) as IdCard[];
        send({ type: 'ident', cards: initial });

        const verified = await Promise.all(
          initial.map(async (c) => {
            try {
              const v = await verifyPokemon(c);
              if (v) {
                const { _refImagePromise, ...rest } = v;
                void _refImagePromise;
                return { ...c, ...rest, verified: true };
              }
            } catch (e) {
              console.warn('[STREAM-VERIFY]', e instanceof Error ? e.message : String(e));
            }
            return { ...c, verified: false };
          }),
        );
        send({ type: 'verified', cards: verified });
        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
};
